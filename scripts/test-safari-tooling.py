#!/usr/bin/env python3
"""Verify Safari's real HTTP transport and shared fixture response semantics."""
import importlib.util
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

spec = importlib.util.spec_from_file_location('safari', Path(__file__).with_name('test-safari-acceptance.py'))
safari = importlib.util.module_from_spec(spec)
spec.loader.exec_module(safari)


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.value = {'sessionId': 'test-session', 'capabilities': {'browserName': 'Safari', 'browserVersion': '27.0'}}
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                self.reply()

            def do_POST(self):
                self.reply()

            def do_DELETE(self):
                self.reply()

            def reply(self):
                data = self.rfile.read(int(self.headers.get('Content-Length', '0')))
                owner.requests.append((self.command, self.path, json.loads(data) if data else None))
                self.send_response(500 if isinstance(owner.value, dict) and owner.value.get('error') else 200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'value': owner.value}).encode())
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.client = safari.SafariWebDriver(f'http://127.0.0.1:{self.server.server_port}')

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_session_identity_and_clean_delete(self):
        self.assertEqual(self.client.start()['capabilities']['browserName'], 'Safari')
        self.client.close()
        self.assertIsNone(self.client.session_id)
        self.assertEqual(self.requests[-1], ('DELETE', '/session/test-session', None))

    def test_a_different_browser_is_not_safari_evidence(self):
        self.value['capabilities']['browserName'] = 'MiniBrowser'
        with self.assertRaisesRegex(AssertionError, 'Real Safari'):
            self.client.start()

    def test_page_object_named_value_is_not_unwrapped_twice(self):
        self.client.start()
        self.value = {'value': 'preserve this object', 'nested': [1, 2]}
        self.assertEqual(self.client.execute('return arguments[0];', self.value), self.value)
        method, path, body = self.requests[-1]
        self.assertEqual((method, path), ('POST', '/session/test-session/execute/sync'))
        self.assertEqual(set(body), {'script', 'args'})

    def test_driver_errors_are_failures(self):
        self.client.start()
        self.value = {'error': 'javascript error', 'message': 'failed to draw'}
        with self.assertRaisesRegex(RuntimeError, 'failed to draw'):
            self.client.execute('throw Error("failed to draw");')

    def test_real_actions_use_the_standard_endpoint(self):
        self.client.start()
        self.value = None
        self.client.drag([1, 2], [11, 12])
        self.assertEqual(self.requests[-2][1], '/session/test-session/actions')
        actions = self.requests[-2][2]['actions'][0]
        self.assertEqual(actions['parameters']['pointerType'], 'mouse')
        self.assertEqual(actions['actions'][1]['type'], 'pointerDown')
        self.assertEqual(actions['actions'][-1]['type'], 'pointerUp')
        self.assertEqual(self.requests[-1][1], '/session/test-session/execute/async')
        self.assertEqual(set(self.requests[-1][2]), {'script', 'args'})
        self.assertEqual(self.requests[-1][2]['script'].count('requestAnimationFrame'), 2)

    def test_frame_switch_and_unsupported_commands(self):
        self.client.start()
        self.value = None
        self.client.call('WebDriver:SwitchToFrame', {'id': 0})
        self.assertEqual(self.requests[-1], ('POST', '/session/test-session/frame', {'id': 0}))
        with self.assertRaisesRegex(ValueError, 'Unsupported'):
            self.client.call('Marionette:Quit')


if __name__ == '__main__':
    unittest.main()
