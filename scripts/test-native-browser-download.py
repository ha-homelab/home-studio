#!/usr/bin/env python3
"""Verify native browser transfer recovery without network or installation."""
import hashlib
import io
from pathlib import Path
import ssl
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

import native_browser


class ResetStream(io.BytesIO):
    def read(self, size=-1):
        if self.tell():
            raise ConnectionResetError('synthetic interrupted response')
        return super().read(3)


class NativeBrowserDownloadTests(unittest.TestCase):
    payload = b'verified browser archive'

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.destination = Path(self.directory.name) / 'browser.tar'
        self.entry = {'url': 'https://example.invalid/browser.tar',
                      'sha512': hashlib.sha512(self.payload).hexdigest()}

    def invoke(self, responses):
        return patch.object(native_browser, 'open_download', side_effect=responses)

    def test_partial_reset_restarts_at_zero_and_verifies_the_complete_archive(self):
        with self.invoke([ResetStream(b'old partial data'), io.BytesIO(self.payload)]) as request, \
                patch.object(native_browser.time, 'sleep') as sleep:
            native_browser.download(self.entry, self.destination)
        self.assertEqual(self.destination.read_bytes(), self.payload)
        self.assertEqual(request.call_count, 2)
        sleep.assert_called_once_with(1)

    def test_wrapped_connection_reset_can_retry(self):
        reset = urllib.error.URLError(ConnectionResetError('synthetic reset'))
        with self.invoke([reset, io.BytesIO(self.payload)]) as request, patch.object(native_browser.time, 'sleep'):
            native_browser.download(self.entry, self.destination)
        self.assertEqual(request.call_count, 2)

    def test_three_resets_fail_and_remove_the_partial_file(self):
        with self.invoke([ResetStream(b'partial') for _ in range(3)]) as request, \
                patch.object(native_browser.time, 'sleep') as sleep:
            with self.assertRaises(ConnectionResetError):
                native_browser.download(self.entry, self.destination)
        self.assertEqual(request.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2])
        self.assertFalse(self.destination.exists())

    def test_checksum_failure_does_not_retry(self):
        with self.invoke([io.BytesIO(b'wrong archive')]) as request:
            with self.assertRaisesRegex(RuntimeError, 'SHA-512'):
                native_browser.download(self.entry, self.destination)
        self.assertEqual(request.call_count, 1)
        self.assertFalse(self.destination.exists())

    def test_checksum_failure_after_a_reset_still_does_not_retry(self):
        with self.invoke([ConnectionResetError(), io.BytesIO(b'wrong archive')]) as request, \
                patch.object(native_browser.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'SHA-512'):
                native_browser.download(self.entry, self.destination)
        self.assertEqual(request.call_count, 2)

    def test_tls_http_timeout_and_unknown_errors_never_retry(self):
        for error in [ssl.SSLCertVerificationError('certificate mismatch'),
                      urllib.error.URLError(ssl.SSLCertVerificationError('certificate mismatch')),
                      urllib.error.HTTPError(self.entry['url'], 403, 'Forbidden', {}, None),
                      TimeoutError('synthetic timeout'), OSError('unexpected local failure')]:
            with self.subTest(error=type(error).__name__), self.invoke([error]) as request:
                with self.assertRaises(type(error)):
                    native_browser.download(self.entry, self.destination)
                self.assertEqual(request.call_count, 1)
                self.assertFalse(self.destination.exists())

    def test_deadline_is_shared_by_all_attempts(self):
        with self.invoke([ConnectionResetError()]) as request, \
                patch.object(native_browser.time, 'monotonic', side_effect=[0, 1, 240, 241]), \
                patch.object(native_browser.time, 'sleep'):
            with self.assertRaisesRegex(TimeoutError, 'four minutes'):
                native_browser.download(self.entry, self.destination)
        self.assertEqual(request.call_count, 1)

    def test_late_eof_cannot_accept_an_archive_after_the_completion_deadline(self):
        with self.invoke([io.BytesIO(self.payload)]) as request, \
                patch.object(native_browser.time, 'monotonic', side_effect=[0, 1, 2, 241]):
            with self.assertRaisesRegex(TimeoutError, 'four minutes'):
                native_browser.download(self.entry, self.destination)
        self.assertEqual(request.call_count, 1)
        self.assertFalse(self.destination.exists())


if __name__ == '__main__':
    unittest.main()
