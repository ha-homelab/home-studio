"""Offline real-TLS checks for the parent-supervised single-request transport."""
import base64
import contextlib
import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import unittest
from unittest.mock import patch

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

import closed_release_transport as transport

MARKER = "FICTIONAL_RELEASE_TRANSPORT_PRIVATE_MARKER"
URL = "https://storage.invalid/p/" + MARKER + "/o/"
SUFFIX = "request-1/candidate.json"
DATA = b"opaque encrypted bytes\x00\xff"
SHA = hashlib.sha256(DATA).hexdigest()
MD5 = base64.b64encode(hashlib.md5(DATA, usedforsecurity=False).digest()).decode("ascii")


class Server:
    def __init__(self, certificate, key, *, status=200, body=b"", headers=(), slow=None):
        self.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.context.load_cert_chain(certificate, key)
        self.sni = []
        self.context.set_servername_callback(lambda _socket, host, _context: self.sni.append(host))
        self.socket = socket.socket()
        self.socket.bind(("127.0.0.1", 0))
        self.port = self.socket.getsockname()[1]
        self.socket.listen()
        self.socket.settimeout(0.1)
        self.status, self.body, self.headers, self.slow = status, body, headers, slow
        self.requests, self.errors, self.connections = [], [], 0
        self.stop = threading.Event()
        self.active = None
        self.thread = threading.Thread(target=self.serve, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def send(self, stream, data, slow=False):
        if not slow:
            stream.sendall(data)
            return
        for char in data:
            if self.stop.wait(0.04):
                return
            stream.sendall(bytes([char]))

    def serve(self):
        while not self.stop.is_set():
            try:
                raw, _ = self.socket.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            self.connections += 1
            try:
                with self.context.wrap_socket(raw, server_side=True) as stream:
                    self.active = stream
                    stream.settimeout(2)
                    wire = bytearray()
                    while b"\r\n\r\n" not in wire:
                        piece = stream.recv(1)
                        if not piece:
                            raise EOFError()
                        wire.extend(piece)
                        if len(wire) > 16384:
                            raise ValueError()
                    lines = bytes(wire).split(b"\r\n")
                    values = {}
                    for line in lines[1:]:
                        if line:
                            name, value = line.split(b":", 1)
                            values[name.lower()] = value.strip()
                    length = int(values.get(b"content-length", b"0"))
                    data = bytearray()
                    while len(data) < length:
                        piece = stream.recv(length - len(data))
                        if not piece:
                            raise EOFError()
                        data.extend(piece)
                    self.requests.append((lines[0], values, bytes(data)))
                    response = (f"HTTP/1.1 {self.status} Synthetic\r\nContent-Length: {len(self.body)}\r\n"
                                "Connection: close\r\n").encode()
                    response += b"".join(name.encode() + b": " + value.encode() + b"\r\n"
                                          for name, value in self.headers)
                    response += b"\r\n"
                    self.send(stream, response, self.slow == "headers")
                    self.send(stream, self.body, self.slow == "body")
            except (OSError, EOFError):
                pass  # Expected when the owned child is killed or rejects TLS.
            except Exception as error:
                self.errors.append(type(error).__name__)
            finally:
                self.active = None

    def __exit__(self, *_):
        self.stop.set()
        self.socket.close()
        if self.active is not None:
            try:
                self.active.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self.thread.join(3)
        if self.thread.is_alive() or self.errors:
            raise AssertionError("Local TLS server did not stop cleanly")


class TransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cert_temp = tempfile.TemporaryDirectory()
        root = Path(cls.cert_temp.name)
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.key = root / "key.pem"
        cls.key.write_bytes(key.private_bytes(serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        cls.key.chmod(0o600)
        cls.certificates = []
        for host in ("storage.invalid", "wrong.invalid"):
            name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)])
            now = datetime.datetime.now(datetime.timezone.utc)
            cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
                .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(days=1))
                .not_valid_after(now + datetime.timedelta(days=1))
                .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
                .add_extension(x509.SubjectAlternativeName([x509.DNSName(host)]), critical=False)
                .sign(key, hashes.SHA256()))
            path = root / (host + ".pem")
            path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
            cls.certificates.append(path)

    @classmethod
    def tearDownClass(cls):
        cls.cert_temp.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.metrics = Path(self.temp.name) / "metrics.json"
        self.out, self.err = io.StringIO(), io.StringIO()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(contextlib.redirect_stdout(self.out))
        self.stack.enter_context(contextlib.redirect_stderr(self.err))
        self.stack.enter_context(patch("socket.create_connection", side_effect=AssertionError("Parent network forbidden")))
        self.addCleanup(lambda: self.assertEqual((self.out.getvalue(), self.err.getvalue()), ("", "")))

    def kwargs(self, **updates):
        return {"suffix": SUFFIX, "maximum": 8192, "timeout": 3,
                "not_after": int(time.time()) + 20, **updates}

    def put(self, **updates):
        values = {"data": DATA, "attempt_id": "attempt-1", "expected_sha256": SHA,
                  "expected_bytes": len(DATA), **self.kwargs(), **updates}
        return transport.put(URL, **values)

    def rejected(self, call, kind=transport.ReleaseTransportError):
        try:
            call()
        except kind as error:
            self.assertIs(type(error), kind)
            self.assertIsNone(error.__cause__)
            self.assertIsNone(error.__context__)
            self.assertNotIn(MARKER, "".join(traceback.format_exception(error)))
            return error
        self.fail("Expected fixed rejection")

    @contextlib.contextmanager
    def child(self, server, mode="normal"):
        processes = []
        actual = subprocess.Popen

        def command(data_fd, result_fd):
            return [sys.executable, "-I", str(Path(__file__).parent / "fixtures/release_transport_tls_child.py"),
                    str(Path(transport.__file__).resolve()), str(data_fd), str(result_fd), str(server.port),
                    str(self.certificates[0]), str(self.metrics), mode]

        def launch(command, **kwargs):
            self.assertNotIn(MARKER, " ".join(command))
            self.assertEqual(kwargs["env"], {"LANG": "C", "LC_ALL": "C"})
            self.assertIs(kwargs["start_new_session"], True)
            self.assertIs(kwargs["stdout"], subprocess.DEVNULL)
            self.assertIs(kwargs["stderr"], subprocess.DEVNULL)
            for fd in kwargs["pass_fds"]:
                self.assertEqual(transport._file(fd).st_nlink, 0)
            process = actual(command, **kwargs)
            processes.append(process)
            return process

        with patch.object(transport, "_child_command", side_effect=command), \
                patch.object(transport.subprocess, "Popen", side_effect=launch):
            yield processes
        self.assertEqual(len(processes), 1)
        self.assertIsNotNone(processes[0].poll())
        with self.assertRaises(ChildProcessError):
            os.waitpid(processes[0].pid, os.WNOHANG)

    def test_real_put_exact_request_and_metadata_no_secret_output(self):
        headers = [("Version-Id", "version-1"), ("ETag", '"opaque"'), ("opc-content-md5", MD5)]
        with Server(self.certificates[0], self.key, status=201, headers=headers) as server:
            with self.child(server, "noise"):
                result = self.put()
        self.assertEqual(result, {"schema": 1, "kind": "closed-put-result", "attempt_id": "attempt-1",
            "request_target_sha256": hashlib.sha256((URL + SUFFIX).encode()).hexdigest(), "status": 201,
            "bytes": len(DATA), "ciphertext_sha256": SHA, "version_id": "version-1", "etag": '"opaque"',
            "md5": MD5, "authorizes_upload": False})
        self.assertEqual(len(server.requests), 1)
        line, headers, data = server.requests[0]
        self.assertEqual(line, ("PUT /p/" + MARKER + "/o/" + SUFFIX + " HTTP/1.1").encode())
        self.assertEqual(headers[b"host"], b"storage.invalid")
        self.assertEqual(headers[b"if-none-match"], b"*")
        self.assertEqual(data, DATA)
        self.assertEqual(server.sni, ["storage.invalid"])
        self.assertGreaterEqual(json.loads(self.metrics.read_text())["closes"], 1)

    def test_real_get_boundaries_and_absent_put_version(self):
        for size in (0, 8192, 8193):
            with self.subTest(size=size), Server(self.certificates[0], self.key, body=b"x" * size) as server:
                with self.child(server):
                    if size > 8192:
                        self.rejected(lambda: transport.get(URL, **self.kwargs()))
                    else:
                        self.assertEqual(transport.get(URL, **self.kwargs()), b"x" * size)
                self.assertEqual(len(server.requests), 1)
        with Server(self.certificates[0], self.key, status=204) as server, self.child(server):
            self.assertIsNone(self.put()["version_id"])

    def test_http_errors_close_without_body_or_retry_and_only_get404_is_distinct(self):
        for method, status in (("GET", 404), ("GET", 403), ("GET", 302), ("PUT", 404), ("PUT", 500)):
            with self.subTest(method=method, status=status), \
                    Server(self.certificates[0], self.key, status=status, body=MARKER.encode(),
                           headers=[("Location", "https://other.invalid/" + MARKER)]) as server:
                with self.child(server):
                    call = self.put if method == "PUT" else lambda: transport.get(URL, **self.kwargs())
                    kind = transport.ReleaseTransportNotFound if (method, status) == ("GET", 404) else transport.ReleaseTransportError
                    self.rejected(call, kind)
                metrics = json.loads(self.metrics.read_text())
                self.assertEqual(metrics["reads"], 0)
                self.assertGreaterEqual(metrics["closes"], 1)
                self.assertEqual(server.connections, 1)

    def test_true_deadline_kills_reaps_trickling_headers_body_dns_and_close(self):
        for method, phase in (("GET", "headers"), ("GET", "body"), ("GET", "dns"),
                              ("GET", "close"), ("PUT", "body")):
            with self.subTest(method=method, phase=phase), \
                    Server(self.certificates[0], self.key, body=b"x" * 128, slow=phase) as server:
                with self.child(server, phase) as processes:
                    start = time.monotonic()
                    call = (lambda: self.put(timeout=1.0)) if method == "PUT" else \
                           lambda: transport.get(URL, **self.kwargs(timeout=1.0))
                    self.rejected(call)
                    elapsed = time.monotonic() - start
                    self.assertLess(elapsed, 2.5)
                    self.assertGreater(elapsed, 0.8)
                    self.assertEqual(processes[0].returncode, -9)
                metrics = json.loads(self.metrics.read_text())
                self.assertEqual(metrics["connections"], 1)
                if phase == "dns":
                    self.assertEqual(metrics["phase"], "dns")
                    self.assertEqual(len(server.requests), 0)
                else:
                    self.assertEqual(len(server.requests), 1)
                if phase == "close":
                    self.assertEqual(metrics["phase"], "close")

    def test_not_after_is_stricter_than_timeout(self):
        with Server(self.certificates[0], self.key, body=b"x" * 256, slow="body") as server, self.child(server) as processes:
            start = time.monotonic()
            self.rejected(lambda: transport.get(URL, **self.kwargs(timeout=10, not_after=int(time.time()) + 2)))
            self.assertLess(time.monotonic() - start, 2.5)
            self.assertEqual(processes[0].returncode, -9)

    def test_timeout_terminates_descendants_in_owned_group(self):
        with Server(self.certificates[0], self.key) as server, self.child(server, "descendant") as processes:
            self.rejected(lambda: transport.get(URL, **self.kwargs(timeout=1)))
            self.assertEqual(processes[0].returncode, -9)
        metrics = json.loads(self.metrics.read_text())
        self.assertEqual(metrics["phase"], "descendant")
        # A grandchild may briefly remain a zombie owned by init. It must not
        # remain runnable; only the direct child is ours to reap with waitpid.
        checked = subprocess.run(["ps", "-o", "stat=", "-p", str(metrics["descendant_pid"])],
                                 capture_output=True, text=True, timeout=2)
        self.assertTrue(not checked.stdout.strip() or checked.stdout.strip().startswith("Z"))

    def test_tls_identity_duplicate_metadata_checksum_and_close_errors_reject(self):
        cases = [(self.certificates[1], (), "normal"),
                 (self.certificates[0], (("Version-Id", "a"), ("version-id", "b")), "normal"),
                 (self.certificates[0], (("opc-content-md5", "invalid"),), "normal"),
                 (self.certificates[0], (), "close-error")]
        for certificate, headers, mode in cases:
            with self.subTest(headers=headers, mode=mode), Server(certificate, self.key, headers=headers) as server:
                with self.child(server, mode):
                    self.rejected(self.put)
                self.assertLessEqual(len(server.requests), 1)

    def test_preflight_rejects_bad_inputs_without_child(self):
        changes = ({"expected_bytes": True}, {"expected_sha256": "0" * 64}, {"attempt_id": "bad/attempt"},
                   {"timeout": float("nan")}, {"timeout": True}, {"timeout": 61}, {"not_after": True},
                   {"not_after": int(time.time())}, {"maximum": 8193}, {"maximum": True},
                   {"suffix": "request/.."}, {"suffix": "request/" + "x" * 8192}, {"data": bytearray(DATA)})
        with patch.object(transport, "_child_command") as command:
            for change in changes:
                with self.subTest(change=tuple(change)):
                    self.rejected(lambda: self.put(**change))
            for url in ("http://storage.invalid/", "https://user:secret@storage.invalid/", "https://storage.invalid:8443/",
                        "https://storage.invalid/?query=secret", URL + "\n", URL + "#fragment"):
                self.rejected(lambda: transport.get(url, **self.kwargs()))
            command.assert_not_called()

    def test_active_caller_exception_is_cleared(self):
        try:
            raise RuntimeError(MARKER)
        except RuntimeError:
            self.rejected(lambda: self.put(expected_bytes=False))

    def test_deadline_starts_before_validation_and_payload_preparation(self):
        real = transport._metadata
        ticks = [0.0]

        def slow_validation(value):
            ticks[0] += 2
            return real(value)

        with patch.object(transport.time, "monotonic", side_effect=lambda: ticks[0]), \
                patch.object(transport, "_metadata", side_effect=slow_validation), \
                patch.object(transport, "_child_command") as command:
            self.rejected(lambda: self.put(timeout=1))
            command.assert_not_called()

        for name in ("_sha", "_write"):
            ticks[0] = 0
            original = getattr(transport, name)

            def slow(*args):
                result = original(*args)
                ticks[0] += 2
                return result

            with self.subTest(stage=name), patch.object(transport.time, "monotonic", side_effect=lambda: ticks[0]), \
                    patch.object(transport, name, side_effect=slow), patch.object(transport, "_child_command") as command:
                self.rejected(lambda: self.put(timeout=1))
                command.assert_not_called()

    def test_parent_rejects_partial_extra_misbound_and_oversize_child_result(self):
        def fake(reply):
            def child(payload, data_fd, result_fd, remaining):
                metadata = json.loads(payload)
                wire = reply(metadata)
                os.write(result_fd, wire)
            return child

        def valid(metadata):
            return {"schema": 1, "kind": "closed-release-transport-result", "request_sha256": transport._sha(transport._canonical(metadata)),
                    "outcome": "get", "value": base64.b64encode(DATA).decode()}

        cases = [lambda m: b"{", lambda m: b"x" * (transport.MAX_RESULT_BYTES + 1),
                 lambda m: transport._canonical(valid(m) | {"extra": True}),
                 lambda m: transport._canonical(valid(m) | {"request_sha256": "0" * 64}),
                 lambda m: transport._canonical(valid(m) | {"value": "!invalid!"}),
                 lambda m: b'{"schema":1,"schema":1}', lambda m: b'{"schema":NaN}']
        for reply in cases:
            with self.subTest(reply=cases.index(reply)), patch.object(transport, "_run_child", side_effect=fake(reply)):
                self.rejected(lambda: transport.get(URL, **self.kwargs()))
        with patch.object(transport, "_run_child", side_effect=fake(lambda m: transport._canonical(valid(m)))):
            self.assertEqual(transport.get(URL, **self.kwargs()), DATA)

    def test_parent_checks_every_put_binding_and_selected_value_bounds(self):
        changes = ({"attempt_id": "other"}, {"request_target_sha256": "0" * 64}, {"ciphertext_sha256": "0" * 64},
                   {"bytes": True}, {"bytes": len(DATA) + 1}, {"status": True}, {"status": 202},
                   {"authorizes_upload": True}, {"extra": 1}, {"version_id": "x" * 1025},
                   {"etag": " whitespace"}, {"md5": "invalid"}, {"schema": True})

        def child_with(change):
            def child(payload, data_fd, result_fd, remaining):
                value = {"schema": 1, "kind": "closed-put-result", "attempt_id": "attempt-1",
                    "request_target_sha256": transport._sha((URL + SUFFIX).encode()), "status": 200,
                    "bytes": len(DATA), "ciphertext_sha256": SHA, "version_id": None, "etag": None,
                    "md5": None, "authorizes_upload": False, **change}
                os.write(result_fd, transport._canonical({"schema": 1, "kind": "closed-release-transport-result",
                    "request_sha256": transport._sha(payload), "outcome": "put", "value": value}))
            return child

        for change in changes:
            with self.subTest(field=tuple(change)), patch.object(transport, "_run_child", side_effect=child_with(change)):
                self.rejected(self.put)
        with patch.object(transport, "_run_child", side_effect=child_with({})):
            self.assertIs(self.put()["authorizes_upload"], False)

    def test_late_404_is_expiry_not_polling_signal_and_wall_rollback_does_not_extend_budget(self):
        ticks = [0.0]
        original = transport._result

        def child(payload, data_fd, result_fd, remaining):
            os.write(result_fd, transport._canonical({"schema": 1, "kind": "closed-release-transport-result",
                "request_sha256": transport._sha(payload), "outcome": "not-found", "value": None}))

        def slow(*args):
            result = original(*args)
            ticks[0] = 2
            return result

        with patch.object(transport.time, "monotonic", side_effect=lambda: ticks[0]), \
                patch.object(transport, "_result", side_effect=slow), patch.object(transport, "_run_child", side_effect=child):
            self.rejected(lambda: transport.get(URL, **self.kwargs(timeout=1)))
        wall, ticks = [100.0], [0.0]
        with patch.object(transport.time, "time", side_effect=lambda: wall[0]), \
                patch.object(transport.time, "monotonic", side_effect=lambda: ticks[0]):
            remaining = transport._remaining(1, 110)
            wall[0], ticks[0] = 50, 2
            with self.assertRaises(transport.ReleaseTransportError):
                remaining()

    def test_startup_time_is_charged_and_only_owned_child_is_killed(self):
        ticks = [0.0]

        class Process:
            returncode = None
            pid = 123456789
            waits = []

            def communicate(self, input=None, timeout=None):
                self.waits.append(timeout)

            def poll(self):
                return self.returncode

        process = Process()

        def launch(*args, **kwargs):
            ticks[0] = 2
            return process

        with patch.object(transport.time, "monotonic", side_effect=lambda: ticks[0]), \
                patch.object(transport.subprocess, "Popen", side_effect=launch), \
                patch.object(transport.os, "killpg") as kill:
            self.rejected(lambda: self.put(timeout=1))
        kill.assert_called_once_with(process.pid, signal.SIGKILL)
        self.assertEqual(process.waits, [transport.REAP_SECONDS])


if __name__ == "__main__":
    unittest.main()
