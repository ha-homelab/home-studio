#!/usr/bin/env python3
"""Offline HTTP-boundary tests for bounded, non-authorizing PUT observations."""
import base64
import contextlib
from email.message import Message
import hashlib
import io
import json
from pathlib import Path
import traceback
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error

import closed_build as build


MARKER = "FICTIONAL_PRIVATE_TRANSPORT_CANARY_79d03"
URL = "https://storage.invalid/p/" + MARKER + "/o/"
SUFFIX = "request-1/candidate.enc"
DATA = b"opaque encrypted bytes\x00\xff"
SHA = hashlib.sha256(DATA).hexdigest()
MD5 = base64.b64encode(hashlib.md5(DATA, usedforsecurity=False).digest()).decode("ascii")
NOW = 2_000_000_000


def headers(pairs=()):
    result = Message()
    for name, value in pairs:
        result[name] = value
    return result


def valid_headers():
    return headers((("Version-Id", "Version_A-1"), ("ETag", '"Opaque-CaseSensitive"'),
                    ("opc-content-md5", MD5)))


class Response:
    def __init__(self, *, status=200, body=b"", metadata=None, read_error=None,
                 close_error=None, on_read=None, on_close=None):
        self.status = status
        self.headers = valid_headers() if metadata is None else metadata
        self.body = body
        self.read_error = read_error
        self.close_error = close_error
        self.on_read = on_read
        self.on_close = on_close
        self.read_limits = []
        self.closed = False

    def __enter__(self):
        return self

    def read(self, limit):
        self.read_limits.append(limit)
        if self.on_read:
            self.on_read()
        if self.read_error:
            raise self.read_error
        return self.body[:limit]

    def __exit__(self, *args):
        self.closed = True
        if self.on_close:
            self.on_close()
        if self.close_error:
            raise self.close_error
        return False


class Opener:
    def __init__(self, response=None, error=None):
        self.response = response if response is not None else Response()
        self.error = error
        self.calls = []

    def open(self, request, *, timeout):
        self.calls.append((request, timeout))
        if self.error:
            raise self.error
        return self.response


class TransportResultTests(unittest.TestCase):
    def setUp(self):
        # An accidental departure from the fake opener must never reach a socket.
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch("socket.create_connection", side_effect=AssertionError("Network forbidden")))
        self.out = self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.err = self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.addCleanup(self.assert_silent)

    def assert_silent(self):
        self.assertEqual(self.out.getvalue(), "")
        self.assertEqual(self.err.getvalue(), "")

    def put(self, **overrides):
        options = dict(data=DATA, attempt_id="attempt-1", expected_sha256=SHA,
                       expected_bytes=len(DATA), suffix=SUFFIX)
        options.update(overrides)
        return build.transport_put_result(options.pop("url", URL), **options)

    def rejected(self, operation):
        try:
            operation()
        except build.Rejected as error:
            self.assertIs(type(error), build.Rejected)
            self.assertEqual(error.args, ())
            self.assertIsNone(error.__cause__)
            self.assertIsNone(error.__context__)
            self.assertNotIn(MARKER, "".join(traceback.format_exception(error)))
        else:
            self.fail("Expected a fixed rejection, not a transport receipt")

    def test_exact_request_and_minimal_result_for_each_success_status(self):
        for status in (200, 201, 204):
            with self.subTest(status=status):
                response = Response(status=status, body=b"ignored response payload")
                opener = Opener(response)
                with patch.object(build.urllib.request, "build_opener", return_value=opener) as factory:
                    result = self.put()
                self.assertEqual(result, {
                    "schema": 1, "kind": "closed-put-result", "attempt_id": "attempt-1",
                    "request_target_sha256": hashlib.sha256((URL + SUFFIX).encode()).hexdigest(),
                    "status": status, "bytes": len(DATA), "ciphertext_sha256": SHA,
                    "version_id": "Version_A-1", "etag": '"Opaque-CaseSensitive"', "md5": MD5,
                    "authorizes_upload": False,
                })
                self.assertNotIn(MARKER, json.dumps(result))
                self.assertNotIn("ignored response payload", json.dumps(result))
                self.assertEqual(len(opener.calls), 1)
                request, timeout = opener.calls[0]
                self.assertEqual(request.get_method(), "PUT")
                self.assertEqual(request.full_url, URL + SUFFIX)
                self.assertIs(request.data, DATA)
                self.assertEqual(request.get_header("If-none-match"), "*")
                self.assertEqual(request.get_header("Content-type"), "application/octet-stream")
                self.assertEqual(timeout, 60)
                self.assertEqual(response.read_limits, [8193])
                self.assertTrue(response.closed)
                factory.assert_called_once()
                installed = factory.call_args.args
                self.assertTrue(any(isinstance(item, build.NoRedirect) for item in installed))
                self.assertTrue(any(isinstance(item, build.urllib.request.ProxyHandler)
                                    and item.proxies == {} for item in installed))

    def test_resolved_target_and_exact_data_change_the_receipt(self):
        receipts = []
        for target, payload, attempt in ((URL + SUFFIX, DATA, "attempt-1"),
                                          (URL + "request-1/other.enc", b"other ciphertext", "attempt-2")):
            opener = Opener(Response(metadata=headers()))
            with patch.object(build.urllib.request, "build_opener", return_value=opener):
                receipts.append(self.put(url=target, suffix=None, data=payload, attempt_id=attempt,
                                         expected_sha256=hashlib.sha256(payload).hexdigest(),
                                         expected_bytes=len(payload)))
            self.assertEqual(receipts[-1]["request_target_sha256"], hashlib.sha256(target.encode()).hexdigest())
            self.assertEqual(receipts[-1]["ciphertext_sha256"], hashlib.sha256(opener.calls[0][0].data).hexdigest())
            self.assertEqual(receipts[-1]["bytes"], len(payload))
            self.assertEqual(receipts[-1]["attempt_id"], attempt)
        self.assertNotEqual(receipts[0]["request_target_sha256"], receipts[1]["request_target_sha256"])
        self.assertNotEqual(receipts[0]["ciphertext_sha256"], receipts[1]["ciphertext_sha256"])

    def test_absent_metadata_and_aliases_do_not_fabricate_confirmation(self):
        metadata = headers((("opc-version-id", "misleading-version"), ("content-md5", MD5),
                            ("opc-multipart-md5", MD5), ("opc-request-id", MARKER),
                            ("Set-Cookie", MARKER), ("Location", URL)))
        with patch.object(build.urllib.request, "build_opener", return_value=Opener(Response(metadata=metadata))):
            result = self.put()
        self.assertIsNone(result["version_id"])
        self.assertIsNone(result["etag"])
        self.assertIsNone(result["md5"])
        self.assertFalse(result["authorizes_upload"])
        self.assertNotIn(MARKER, json.dumps(result))
        self.assertEqual(len(result), 11)

    def test_expected_bytes_and_sha_are_preflight_requirements(self):
        cases = ({"expected_bytes": len(DATA) + 1}, {"expected_bytes": True},
                 {"expected_bytes": float(len(DATA))}, {"expected_bytes": 0},
                 {"expected_sha256": "0" * 64}, {"expected_sha256": SHA.upper()},
                 {"expected_sha256": None}, {"expected_sha256": "a" * 63})
        for case in cases:
            with self.subTest(case=case), patch.object(build.urllib.request, "build_opener") as factory:
                self.rejected(lambda: self.put(**case))
                factory.return_value.open.assert_not_called()

    def test_only_nonempty_immutable_bounded_bytes_are_sent(self):
        for data in (None, b"", bytearray(DATA), memoryview(DATA), "ciphertext"):
            with self.subTest(type=type(data).__name__), patch.object(build.urllib.request, "build_opener") as factory:
                self.rejected(lambda: self.put(data=data))
                factory.return_value.open.assert_not_called()
        with patch.object(build, "MAX_ENVELOPE", len(DATA) - 1), \
             patch.object(build.urllib.request, "build_opener") as factory:
            self.rejected(lambda: self.put(maximum=1))
            factory.return_value.open.assert_not_called()

    def test_attempt_identifier_is_validated_before_open(self):
        for attempt in (None, True, "", "x" * 81, "with space", "../other", "line\nbreak"):
            with self.subTest(attempt=attempt), patch.object(build.urllib.request, "build_opener") as factory:
                self.rejected(lambda: self.put(attempt_id=attempt))
                factory.return_value.open.assert_not_called()

    def test_request_bounds_and_deadline_types_are_preflight(self):
        cases = [{"maximum": value} for value in (0, -1, True, 1.5, 8193, build.MAX_ENVELOPE + 1)]
        cases += [{"timeout": value} for value in (0, -1, True, 61, float("nan"), float("inf"), "60")]
        cases += [{"not_after": value} for value in (True, 0, NOW, float(NOW + 30), "future")]
        for case in cases:
            with self.subTest(case=case), patch.object(build.time, "time", return_value=NOW), \
                 patch.object(build.urllib.request, "build_opener") as factory:
                self.rejected(lambda: self.put(**case))
                factory.return_value.open.assert_not_called()

    def test_invalid_capabilities_and_suffixes_never_open(self):
        cases = [{"url": value} for value in (
            "http://storage.invalid/o/", "https://user:password@storage.invalid/o/",
            "https://storage.invalid:444/o/", "https://storage.invalid/o/#fragment",
            "https://storage.invalid:invalid/o/", "https://[invalid/o/", "https:///o/",
            " " + URL, URL + "\n", URL + "\t", URL + "\u00e9")]
        cases += [{"suffix": value} for value in ("../candidate", "request/candidate/extra", "request/ca?ndidate")]
        cases += [{"url": URL + "?query=1"}, {"url": URL.rstrip("/")}]
        for case in cases:
            with self.subTest(case=case), patch.object(build.urllib.request, "build_opener") as factory:
                self.rejected(lambda: self.put(**case))
                factory.return_value.open.assert_not_called()

    def test_resolved_target_bound_is_checked_before_open(self):
        boundary_suffix = "request/" + "x" * (8192 - len(URL) - len("request/"))
        self.assertLess(len(boundary_suffix), 8192)
        self.assertLess(len(URL), 8192)
        for suffix in ("request/" + "x" * 8192, boundary_suffix + "x", 123, b"request/object"):
            with self.subTest(type=type(suffix).__name__, length=len(suffix) if hasattr(suffix, "__len__") else None), \
                 patch.object(build.urllib.request, "build_opener") as factory:
                self.rejected(lambda: self.put(suffix=suffix))
                factory.return_value.open.assert_not_called()
        opener = Opener()
        with patch.object(build.urllib.request, "build_opener", return_value=opener):
            result = self.put(suffix=boundary_suffix)
        self.assertEqual(len(opener.calls), 1)
        self.assertEqual(len(opener.calls[0][0].full_url), 8192)
        self.assertEqual(result["request_target_sha256"], hashlib.sha256((URL + boundary_suffix).encode()).hexdigest())

    def test_duplicate_selected_headers_reject_even_identical_values(self):
        for name, value in (("version-id", "version"), ("etag", '"opaque"'), ("opc-content-md5", MD5)):
            for repeated in (value, "conflicting"):
                with self.subTest(name=name, repeated=repeated):
                    opener = Opener(Response(metadata=headers(((name, value), (name.upper(), repeated)))))
                    with patch.object(build.urllib.request, "build_opener", return_value=opener):
                        self.rejected(self.put)
                    self.assertEqual(len(opener.calls), 1)
                    self.assertTrue(opener.response.closed)

    def test_opaque_metadata_has_bounded_printable_ascii(self):
        for name in ("version-id", "etag"):
            for value in ("", " leading", "trailing ", " ", "x" * 1025, "line\nbreak", "line\rbreak",
                          "tab\tvalue", "nul\x00", "del\x7f", "nonascii\u00e9"):
                with self.subTest(name=name, value=value):
                    opener = Opener(Response(metadata=headers(((name, value),))))
                    with patch.object(build.urllib.request, "build_opener", return_value=opener):
                        self.rejected(self.put)
                    self.assertEqual(len(opener.calls), 1)
        with patch.object(build.urllib.request, "build_opener", return_value=Opener(Response(
                metadata=headers((("version-id", "v" * 1024), ("etag", "E" * 1024)))))):
            result = self.put()
        self.assertEqual(result["version_id"], "v" * 1024)
        self.assertEqual(result["etag"], "E" * 1024)

    def test_md5_is_canonical_base64_of_exact_sent_bytes(self):
        alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
        noncanonical = MD5[:-3] + alphabet[alphabet.index(MD5[-3]) + 1] + "=="
        self.assertEqual(base64.b64decode(noncanonical, validate=True),
                         hashlib.md5(DATA, usedforsecurity=False).digest())
        invalid = ("", MD5.rstrip("="), MD5 + "\n", noncanonical, "_" * 22 + "==",
                   base64.b64encode(b"short").decode(), base64.b64encode(b"x" * 16).decode())
        for value in invalid:
            with self.subTest(value=value):
                opener = Opener(Response(metadata=headers((("opc-content-md5", value),))))
                with patch.object(build.urllib.request, "build_opener", return_value=opener):
                    self.rejected(self.put)
                self.assertEqual(len(opener.calls), 1)

    def test_all_headers_are_bounded_even_when_unknown(self):
        for metadata in (headers(("X-Unknown-" + str(index), "x") for index in range(101)),
                         headers((("X-Unknown", "x" * 16385),))):
            opener = Opener(Response(metadata=metadata))
            with patch.object(build.urllib.request, "build_opener", return_value=opener):
                self.rejected(self.put)
            self.assertEqual(len(opener.calls), 1)
        metadata = headers(("X-Unknown-" + str(index), "x") for index in range(100))
        with patch.object(build.urllib.request, "build_opener", return_value=Opener(Response(metadata=metadata))):
            self.assertIsNone(self.put()["version_id"])

    def test_response_size_is_bounded_separately_from_ciphertext_size(self):
        for body, success in ((b"a" * 4, True), (b"a" * 5, False)):
            opener = Opener(Response(body=body))
            with patch.object(build.urllib.request, "build_opener", return_value=opener):
                if success:
                    self.assertEqual(self.put(maximum=4)["bytes"], len(DATA))
                else:
                    self.rejected(lambda: self.put(maximum=4))
            self.assertEqual(opener.response.read_limits, [5])
            self.assertTrue(opener.response.closed)
            self.assertEqual(len(opener.calls), 1)

    def test_unaccepted_statuses_never_produce_receipt_or_retry(self):
        for status in (202, 206, 301, 307, 400, 403, 404, 409, 412, 429, 500, 503):
            with self.subTest(status=status):
                opener = Opener(Response(status=status))
                with patch.object(build.urllib.request, "build_opener", return_value=opener):
                    self.rejected(self.put)
                self.assertEqual(len(opener.calls), 1)
                self.assertTrue(opener.response.closed)

    def test_network_and_http_errors_are_closed_sanitized_and_not_retried(self):
        for error in (TimeoutError(MARKER), OSError(MARKER), urllib.error.URLError(MARKER),
                      urllib.error.HTTPError(URL, 412, MARKER, headers(), io.BytesIO(MARKER.encode()))):
            with self.subTest(kind=type(error).__name__):
                opener = Opener(error=error)
                with patch.object(build.urllib.request, "build_opener", return_value=opener):
                    self.rejected(self.put)
                self.assertEqual(len(opener.calls), 1)
                if isinstance(error, urllib.error.HTTPError):
                    self.assertTrue(error.closed)

    def test_body_or_close_failure_cannot_escape_as_success(self):
        for failure in ("read_error", "close_error"):
            with self.subTest(failure=failure):
                opener = Opener(Response(**{failure: OSError(MARKER)}))
                with patch.object(build.urllib.request, "build_opener", return_value=opener):
                    self.rejected(self.put)
                self.assertTrue(opener.response.closed)
                self.assertEqual(len(opener.calls), 1)

    def test_active_caller_exception_is_not_attached_to_sanitized_rejection(self):
        for preflight in (True, False):
            with self.subTest(preflight=preflight):
                opener = Opener(error=OSError(MARKER))
                with patch.object(build.urllib.request, "build_opener", return_value=opener):
                    try:
                        raise ValueError(MARKER)
                    except ValueError:
                        if preflight:
                            self.rejected(lambda: self.put(expected_sha256="0" * 64))
                        else:
                            self.rejected(self.put)
                self.assertEqual(len(opener.calls), 0 if preflight else 1)

    def test_deadline_limits_timeout_and_is_checked_after_read_and_close(self):
        clock = [NOW]
        with patch.object(build.time, "time", side_effect=lambda: clock[0]):
            opener = Opener()
            with patch.object(build.urllib.request, "build_opener", return_value=opener):
                self.put(not_after=NOW + 4)
            self.assertEqual(opener.calls[0][1], 4)
            for phase in ("on_read", "on_close"):
                with self.subTest(phase=phase):
                    clock[0] = NOW
                    opener = Opener(Response(**{phase: lambda: clock.__setitem__(0, NOW + 4)}))
                    with patch.object(build.urllib.request, "build_opener", return_value=opener):
                        self.rejected(lambda: self.put(not_after=NOW + 4))
                    self.assertTrue(opener.response.closed)
                    self.assertEqual(len(opener.calls), 1)

    def test_redirect_handler_rejection_has_no_followup_request(self):
        class RedirectOpener(Opener):
            def open(self, request, *, timeout):
                self.calls.append((request, timeout))
                return build.NoRedirect().redirect_request(request, None, 307, MARKER,
                                                           headers(), "https://other.invalid/" + MARKER)
        opener = RedirectOpener()
        with patch.object(build.urllib.request, "build_opener", return_value=opener):
            self.rejected(self.put)
        self.assertEqual(len(opener.calls), 1)

    def test_real_redirect_dispatch_closes_unread_response_even_if_close_fails(self):
        class RedirectBody(io.BytesIO):
            def __init__(self, fail_close):
                super().__init__(MARKER.encode())
                self.fail_close = fail_close
                self.read_calls = 0
                self.close_calls = 0

            def read(self, *args):
                self.read_calls += 1
                return super().read(*args)

            def close(self):
                self.close_calls += 1
                super().close()
                if self.fail_close:
                    raise OSError(MARKER)

        for fail_close in (False, True):
            with self.subTest(fail_close=fail_close):
                body = RedirectBody(fail_close)
                followups = []

                def unexpected_followup(*args, **kwargs):
                    followups.append((args, kwargs))
                    raise AssertionError("Redirect must not be followed")

                handler = build.NoRedirect()
                handler.add_parent(SimpleNamespace(open=unexpected_followup))

                class RedirectOpener(Opener):
                    def open(self, request, *, timeout):
                        self.calls.append((request, timeout))
                        return handler.http_error_302(request, body, 307, MARKER,
                            headers((("Location", "https://other.invalid/" + MARKER),)))

                opener = RedirectOpener()
                with patch.object(build.urllib.request, "build_opener", return_value=opener):
                    self.rejected(self.put)
                self.assertEqual(len(opener.calls), 1)
                self.assertEqual(followups, [])
                self.assertEqual(body.read_calls, 0)
                self.assertEqual(body.close_calls, 1)
                self.assertTrue(body.closed)

    def test_legacy_transport_still_returns_bytes_and_preserves_http_error(self):
        for data, method in ((None, "GET"), (DATA, "PUT")):
            with self.subTest(method=method):
                response = Response(body=b"legacy-body", metadata=headers((("ETag", ""), ("ETag", "invalid"))))
                opener = Opener(response)
                with patch.object(build.urllib.request, "build_opener", return_value=opener):
                    result = build.transport(URL, data=data, suffix=SUFFIX)
                self.assertEqual(result, b"legacy-body")
                self.assertIs(type(result), bytes)
                self.assertEqual(opener.calls[0][0].get_method(), method)
                self.assertTrue(response.closed)
        error = urllib.error.HTTPError(URL, 404, MARKER, headers(), io.BytesIO())
        try:
            with patch.object(build.urllib.request, "build_opener", return_value=Opener(error=error)):
                with self.assertRaises(urllib.error.HTTPError) as raised:
                    build.transport(URL)
            self.assertIs(raised.exception, error)
        finally:
            error.close()

    def test_normal_release_holds_do_not_call_either_transport_api(self):
        with patch.object(build, "transport") as legacy, \
             patch.object(build, "transport_put_result") as observed, \
             patch.object(build.urllib.request, "build_opener") as factory:
            with self.assertRaises(build.UploadAdmissionUnavailable):
                build.execute(SimpleNamespace(action="build"), Path("/unused"))
            with self.assertRaises(build.UploadAdmissionUnavailable):
                build.upload_candidate(DATA, SUFFIX, SHA, "request-1", {}, action="build")
        legacy.assert_not_called()
        observed.assert_not_called()
        factory.assert_not_called()


if __name__ == "__main__":
    unittest.main()
