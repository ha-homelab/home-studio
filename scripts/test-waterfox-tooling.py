#!/usr/bin/env python3
"""Offline tests for pinned downloads and stock Gecko transport validation."""
import contextlib
import hashlib
import importlib.util
import io
import json
import plistlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


setup = load('setup-waterfox')
acceptance = load('test-waterfox-acceptance')


class Socket:
    def __init__(self, *messages):
        self.chunks = []
        self.sent = []
        for message in messages:
            data = json.dumps(message).encode('utf-8')
            frame = str(len(data)).encode() + b':' + data
            self.chunks.extend(bytes([byte]) for byte in frame)

    def settimeout(self, _value):
        pass

    def recv(self, _size):
        return self.chunks.pop(0) if self.chunks else b''

    def sendall(self, data):
        self.sent.append(data)


class ToolingTests(unittest.TestCase):
    def test_fragmented_protocol_and_unicode(self):
        sock = Socket({'marionetteProtocol': 3}, [1, 1, None, {'value': 'Room \u00e9'}])
        client = acceptance.Marionette(sock)
        self.assertEqual(client.execute('return "Room \u00e9";'), 'Room \u00e9')
        self.assertIn(b'WebDriver:ExecuteScript', sock.sent[0])

    def test_disconnect_fails_instead_of_spinning(self):
        with self.assertRaises(ConnectionError):
            acceptance.Marionette(Socket())

    def test_unexpected_response_rejected(self):
        client = acceptance.Marionette(Socket({'marionetteProtocol': 3}, [1, 9, None, {}]))
        with self.assertRaisesRegex(AssertionError, 'response ID'):
            client.call('WebDriver:NewSession')

    def test_remote_error_is_failure(self):
        client = acceptance.Marionette(Socket({'marionetteProtocol': 3}, [1, 1, {'error': 'timeout'}, None]))
        with self.assertRaisesRegex(RuntimeError, 'timeout'):
            client.call('WebDriver:NewSession')

    def test_checksum_is_enforced(self):
        content = b'official package fixture'
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'Waterfox package.exe'
            entry = {'url': 'https://example.invalid/fixture', 'sha512': hashlib.sha512(content).hexdigest()}
            with patch.object(setup.urllib.request, 'urlopen', return_value=io.BytesIO(content)):
                setup.download(entry, target)
            self.assertEqual(target.read_bytes(), content)
            with patch.object(setup.urllib.request, 'urlopen', return_value=io.BytesIO(b'tampered')):
                with self.assertRaisesRegex(RuntimeError, 'SHA-512'):
                    setup.download(entry, target)
            self.assertFalse(target.exists())

    def test_existing_installation_is_never_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            (target / 'sentinel').write_text('keep', encoding='utf-8')
            with self.assertRaisesRegex(RuntimeError, 'must be empty'):
                setup.install('6.7.6', target)
            self.assertEqual((target / 'sentinel').read_text(encoding='utf-8'), 'keep')

    def test_mac_bundle_is_copied_without_modification(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'installation'
            expected = {}
            calls = []
            def command(args, **_kwargs):
                calls.append(args)
                if args[:2] == ['hdiutil', 'attach']:
                    mount = Path(args[args.index('-mountpoint') + 1])
                    bundle = mount / 'Waterfox.app'
                    resources = bundle / 'Contents/Resources'
                    resources.mkdir(parents=True)
                    (bundle / 'Contents/MacOS').mkdir()
                    (bundle / 'Contents/MacOS/waterfox').write_bytes(b'official signed binary')
                    (resources / 'application.ini').write_text('[App]\nName=Waterfox\nVersion=153.5.0\n', encoding='utf-8')
                    (resources / 'platform.ini').write_text('[Build]\nMilestone=153.5.0\n', encoding='utf-8')
                    (bundle / 'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleShortVersionString': '6.7.6', 'CFBundleVersion': '6.7.6'}))
                    for path in bundle.rglob('*'):
                        if path.is_file():
                            expected[str(path.relative_to(bundle))] = path.read_bytes()
            with patch.object(setup, 'platform_key', return_value='macos'), patch.object(setup, 'download'), patch.object(setup.subprocess, 'run', side_effect=command), contextlib.redirect_stdout(io.StringIO()):
                setup.install('6.7.6', output)
            actual = {str(path.relative_to(output / 'Waterfox.app')): path.read_bytes() for path in (output / 'Waterfox.app').rglob('*') if path.is_file()}
            self.assertEqual(actual, expected, 'No file may be added or changed in the signed bundle')
            self.assertTrue(any(args[:4] == ['codesign', '--verify', '--deep', '--strict'] for args in calls))

    def test_failure_receipt_survives_cleanup_error(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            with patch.object(acceptance.subprocess, 'Popen', side_effect=RuntimeError('fixture launch failed')), patch.object(acceptance, 'stop', side_effect=RuntimeError('cleanup failed')), contextlib.redirect_stdout(io.StringIO()):
                result = acceptance.run_case({}, output, 'viewer-6', True)
            saved = json.loads((output / 'report.json').read_text(encoding='utf-8'))
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(saved['error'], 'fixture launch failed')
            self.assertIn('cleanup failed', saved['cleanupErrors'])

    def test_graphics_failure_cannot_be_skipped(self):
        stats = {'contexts': 1, 'gpu': {'version': 'WebGL 2.0'}, 'linkedPrograms': 1, 'shaderErrors': [], 'errors': []}
        acceptance.assert_graphics(stats)
        for changed in ({'contexts': 0}, {'linkedPrograms': 0}, {'gpu': {'version': 'WebGL 1.0'}}, {'shaderErrors': ['failed']}, {'errors': ['uncaught']}):
            with self.subTest(changed=changed), self.assertRaises(AssertionError):
                acceptance.assert_graphics({**stats, **changed})


if __name__ == '__main__':
    unittest.main()
