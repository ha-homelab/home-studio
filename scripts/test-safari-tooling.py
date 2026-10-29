#!/usr/bin/env python3
"""Verify Safari's real HTTP transport and shared fixture response semantics."""
import importlib.util
import json
import io
import http.client
import subprocess
from unittest.mock import Mock, patch
import contextlib
import tempfile
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
        self.response_extra = {}
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
                self.wfile.write(json.dumps({'value': owner.value, **owner.response_extra}).encode())
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

    def test_actual_http_startup_error_keeps_structured_recovery_identity(self):
        self.value = {'error': 'session not created', 'message': safari.RWI_STARTUP_MESSAGE, 'stacktrace': ''}
        with self.assertRaises(safari.WebDriverError) as caught:
            self.client.start()
        self.assertEqual(caught.exception.response,
                         {'method': 'POST', 'route': '/session', 'status': 500, 'value': self.value})
        self.assertTrue(caught.exception.is_known_cold_start())
        self.assertIsNone(self.client.session_id)
        self.assertEqual(len(self.requests), 1)
        self.response_extra = {'sessionId': 'ambiguous'}
        with self.assertRaises(safari.WebDriverError) as caught:
            self.client.start()
        self.assertFalse(caught.exception.is_known_cold_start())
        self.assertEqual(caught.exception.response['sessionId'], 'ambiguous')

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


class ColdSafariTransportTests(unittest.TestCase):
    def test_real_http_response_content_length_eof_and_remaining_body_timeout(self):
        for deadline_attr, initial_timeout in (('_cold_load_deadline', 60), ('_preparation_deadline', 30)):
            now = [0.0]
            class Socket:
                def __init__(self, payload): self.payload = payload; self.values = []
                def makefile(self, _mode):
                    class Reader(io.BytesIO): pass
                    reader = Reader(self.payload); reader.raw = type('Raw', (), {'_sock':self})()
                    return reader
                def settimeout(self, value): self.values.append(value)
            body = b'{"value":true}'
            sock = Socket(b'HTTP/1.1 200 OK\r\nContent-Length: '+str(len(body)).encode()+b'\r\n\r\n'+body)
            response = http.client.HTTPResponse(sock); response.begin()
            client = safari.SafariWebDriver('http://fixture'); setattr(client, deadline_attr, 60)
            def opened(_request, timeout):
                self.assertEqual(timeout, initial_timeout); now[0] = 40; return response
            with patch.object(safari.time, 'monotonic', side_effect=lambda:now[0]), patch.object(safari.urllib.request, 'urlopen', side_effect=opened):
                self.assertTrue(client.request('GET', '/status'))
            self.assertTrue(response.isclosed())
            self.assertEqual(sock.values, [20])

    def test_http_error_body_preserves_webdriver_error_with_bounded_transport(self):
        class Socket:
            def __init__(self, payload): self.payload = payload; self.values = []
            def makefile(self, _mode):
                class Reader(io.BytesIO): pass
                reader = Reader(self.payload); reader.raw = type('Raw', (), {'_sock':self})()
                return reader
            def settimeout(self, value): self.values.append(value)
        body = b'{"value":{"error":"no such frame","message":"missing frame"}}'
        sock = Socket(b'HTTP/1.1 404 Not Found\r\nContent-Length: '+str(len(body)).encode()+b'\r\n\r\n'+body)
        response = http.client.HTTPResponse(sock); response.begin()
        error = safari.urllib.error.HTTPError('http://fixture', 404, 'Not Found', response.headers, response)
        client = safari.SafariWebDriver('http://fixture'); client._cold_load_deadline = 60
        with patch.object(safari.time, 'monotonic', return_value=40), patch.object(safari.urllib.request, 'urlopen', side_effect=error):
            with self.assertRaisesRegex(RuntimeError, 'no such frame'):
                client.request('GET', '/frame')
        self.assertEqual(sock.values, [20])

    def test_late_headers_reject_before_body_and_ordinary_timeout_remains_30(self):
        client = safari.SafariWebDriver('http://fixture'); client._cold_load_deadline = 60
        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read1(self, *_): raise AssertionError('Do not read after deadline')
        now = [0]
        def opened(_request, timeout): now[0] = 60; return Response()
        with patch.object(safari.time, 'monotonic', side_effect=lambda:now[0]), patch.object(safari.urllib.request, 'urlopen', side_effect=opened):
            with self.assertRaises(TimeoutError): client.request('GET', '/status')
        client._cold_load_deadline = None
        self.assertEqual(client.command_timeout(), 30)


class SessionStartupTests(unittest.TestCase):
    def test_selects_only_owned_window_and_keeps_actual_focus_evidence(self):
        client = safari.SafariWebDriver('http://fixture')
        client.session_id = 'owned'
        focus = {'documentFocused': False, 'visibilityState': 'visible'}
        with patch.object(client, 'request', side_effect=['owned-window', None, focus]) as request:
            self.assertEqual(client.select_current_window(), {'handle': 'owned-window', **focus})
        self.assertEqual([(call.args[0], call.args[1]) for call in request.call_args_list],
                         [('GET', '/session/owned/window'), ('POST', '/session/owned/window'),
                          ('POST', '/session/owned/execute/sync')])
        self.assertEqual(request.call_args_list[1].args[2], {'handle': 'owned-window'})
        with patch.object(client, 'request', return_value=None) as request:
            with self.assertRaisesRegex(AssertionError, 'automation window'):
                client.select_current_window()
        self.assertEqual(request.call_count, 1)

    def test_session_completion_boundary_outer_cap_and_single_attempt(self):
        for outer, elapsed, succeeds in ((180, 59.999, True), (180, 59.9999999, True),
                                          (180, 60, False),
                                          (180, 61, False), (45, 44.999, True),
                                          (45, 45, False), (0, 0, False)):
            with self.subTest(outer=outer, elapsed=elapsed):
                now = [0.0]
                client = safari.SafariWebDriver('http://fixture')
                client._browser_deadline = outer
                timing, calls = {}, []
                def request(method, route, data):
                    calls.append((method, route, client.command_timeout()))
                    now[0] = elapsed
                    return {'sessionId': 'known', 'capabilities': {'browserName': 'Safari'}}
                with patch.object(safari.time, 'monotonic', side_effect=lambda: now[0]), \
                     patch.object(client, 'request', side_effect=request):
                    if succeeds:
                        client.start(timing)
                    else:
                        with self.assertRaises(TimeoutError):
                            client.start(timing)
                    self.assertEqual(client.command_timeout(), 30)
                self.assertEqual(calls, [('POST', '/session', min(60, outer))] if outer else [])
                self.assertEqual(timing['budgetMs'], 60000)
                self.assertEqual(timing['effectiveBudgetMs'], min(60, outer) * 1000)
                self.assertEqual(timing['durationMs'], elapsed * 1000)
                self.assertEqual(timing['completed'], succeeds)
                self.assertEqual(timing['timedOut'], not succeeds)
                self.assertEqual(client._browser_deadline, outer)
                self.assertIsNone(client._session_start_deadline)
                # A late parsed ID remains available to the existing cleanup.
                self.assertEqual(client.session_id, 'known' if calls else None)

    def test_transport_and_identity_failures_restore_ordinary_timeout(self):
        for failure in (ValueError('invalid JSON'), RuntimeError('WebDriver rejected session'),
                        TimeoutError('socket timeout'), None):
            with self.subTest(failure=failure):
                client = safari.SafariWebDriver('http://fixture')
                timing = {}
                response = {'sessionId': 'wrong-browser', 'capabilities': {'browserName': 'MiniBrowser'}}
                with patch.object(client, 'request', side_effect=failure, return_value=response) as request:
                    with self.assertRaises(type(failure) if failure else AssertionError):
                        client.start(timing)
                self.assertEqual(request.call_count, 1)
                self.assertEqual(client.command_timeout(), 30)
                self.assertFalse(timing['completed'])
                self.assertFalse(timing['timedOut'])
                self.assertEqual(client.session_id, None if failure else 'wrong-browser')

    def test_actual_http_body_uses_remaining_session_budget(self):
        for body_end in (59.999, 60.0):
            with self.subTest(body_end=body_end):
                now = [0.0]
                class Socket:
                    def __init__(self, payload): self.payload = payload; self.values = []
                    def makefile(self, _mode):
                        class Reader(io.BytesIO):
                            def read1(self, size):
                                now[0] = body_end
                                return super().read1(size)
                        reader = Reader(self.payload)
                        reader.raw = type('Raw', (), {'_sock': self})()
                        return reader
                    def settimeout(self, value): self.values.append(value)
                body = json.dumps({'value': {'sessionId': 'http-session',
                                            'capabilities': {'browserName': 'Safari'}}}).encode()
                sock = Socket(b'HTTP/1.1 200 OK\r\nContent-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body)
                response = http.client.HTTPResponse(sock); response.begin()
                client = safari.SafariWebDriver('http://fixture'); client._browser_deadline = 180
                timing = {}
                def opened(request, timeout):
                    self.assertEqual((request.method, request.full_url), ('POST', 'http://fixture/session'))
                    self.assertEqual(timeout, 60)
                    now[0] = 40
                    return response
                with patch.object(safari.time, 'monotonic', side_effect=lambda: now[0]), \
                     patch.object(safari.urllib.request, 'urlopen', side_effect=opened) as opening:
                    if body_end < 60:
                        self.assertEqual(client.start(timing)['sessionId'], 'http-session')
                    else:
                        with self.assertRaises(TimeoutError): client.start(timing)
                    self.assertEqual(client.command_timeout(), 30)
                self.assertEqual(opening.call_count, 1)
                self.assertEqual(sock.values, [20])
                self.assertTrue(response.isclosed())
                self.assertEqual(timing['completed'], body_end < 60)
                self.assertEqual(timing['timedOut'], body_end >= 60)

    def test_run_case_keeps_late_start_failed_and_never_enters_application(self):
        for name in ('viewer-6', 'planner-256'):
            for elapsed in (35, 60):
                with self.subTest(name=name, elapsed=elapsed), tempfile.TemporaryDirectory() as temp:
                    now = [0.0]
                    client = safari.SafariWebDriver('http://fixture')
                    calls = []
                    def request(method, route, data=None):
                        calls.append((method, route, client.command_timeout(), data))
                        if route == '/session':
                            now[0] = elapsed
                            return {'sessionId': 'owned', 'capabilities': {'browserName': 'Safari'}}
                        if route == '/session/owned/window' and method == 'GET':
                            return 'owned-window'
                        if route.endswith('/execute/sync'):
                            return {'documentFocused': True, 'visibilityState': 'visible'}
                        return None
                    driver = Mock(); driver.poll.return_value = None
                    with contextlib.ExitStack() as stack:
                        stack.enter_context(patch.object(safari.sys, 'platform', 'darwin'))
                        stack.enter_context(patch.object(safari.time, 'monotonic', side_effect=lambda: now[0]))
                        stack.enter_context(patch.object(safari.subprocess, 'check_output', return_value='Safari test'))
                        stack.enter_context(patch.object(safari.subprocess, 'Popen', return_value=driver))
                        stack.enter_context(patch.object(safari, 'fixture_server', return_value=(Mock(), {'origin':'http://fixture', 'sourceHash':'fixed'}, {})))
                        stack.enter_context(patch.object(safari, 'SafariWebDriver', return_value=client))
                        stack.enter_context(patch.object(client, 'request', side_effect=request))
                        stack.enter_context(patch.object(safari.native, 'stop'))
                        timer = stack.enter_context(patch.object(safari.threading, 'Timer'))
                        viewer = stack.enter_context(patch.object(safari.native, 'viewer'))
                        planner = stack.enter_context(patch.object(safari.native, 'planner'))
                        record = safari.run_case(Path(temp), name, '/test/safaridriver')
                    self.assertEqual(sum(route == '/session' for _, route, _, _ in calls), 1)
                    timer.assert_called_once()
                    self.assertEqual(timer.call_args.args[0], 180)
                    self.assertEqual(client._browser_deadline, 180)
                    self.assertEqual(client.command_timeout(), 30)
                    self.assertEqual(record['sessionStartup']['durationMs'], elapsed * 1000)
                    self.assertEqual(record['sessionStartup']['completed'], elapsed < 60)
                    self.assertEqual(record['sessionStartup']['timedOut'], elapsed >= 60)
                    self.assertEqual(record['status'], 'passed' if elapsed < 60 else 'failed')
                    self.assertEqual(record['phase'], 'completed' if elapsed < 60 else 'session-startup')
                    self.assertEqual(viewer.call_count + planner.call_count, int(elapsed < 60))
                    if elapsed < 60:
                        timeout_call = next(c for c in calls if c[1].endswith('/timeouts'))
                        self.assertEqual(timeout_call[2:], (30, {'script':30000, 'pageLoad':30000, 'implicit':0}))
                        self.assertEqual(record['windowFocus'], {'handle': 'owned-window', 'documentFocused': True, 'visibilityState': 'visible'})
                        self.assertEqual(sum(method == 'POST' and route == '/session/owned/window' for method, route, *_ in calls), 1)
                    else:
                        self.assertEqual(record['samples'], [])
                    self.assertIn(('DELETE', '/session/owned', 30, None), calls)
                    self.assertEqual(json.loads((Path(temp) / 'report.json').read_text())['status'], record['status'])

    def test_unfocused_blank_page_reaches_application_and_keeps_application_failures(self):
        for name in ('viewer-6', 'planner-256'):
            for application_failure in (False, True):
                with self.subTest(name=name, application_failure=application_failure), tempfile.TemporaryDirectory() as temp:
                    client = safari.SafariWebDriver('http://fixture')
                    calls = []
                    def request(method, route, data=None):
                        calls.append((method, route))
                        if route == '/session':
                            return {'sessionId': 'owned', 'capabilities': {'browserName': 'Safari'}}
                        if route == '/session/owned/window' and method == 'GET':
                            return 'owned-window'
                        if route.endswith('/execute/sync'):
                            return {'documentFocused': False, 'visibilityState': 'visible'}
                        return None
                    def application(selected_client, origin, _project, _record, _save):
                        self.assertIs(selected_client, client)
                        client.call('WebDriver:Navigate', {'url': origin + '/application'})
                        if application_failure:
                            raise AssertionError('application pointer assertion failed')
                    driver = Mock(); driver.poll.return_value = None
                    with contextlib.ExitStack() as stack:
                        stack.enter_context(patch.object(safari.sys, 'platform', 'darwin'))
                        stack.enter_context(patch.object(safari.subprocess, 'check_output', return_value='Safari test'))
                        stack.enter_context(patch.object(safari.subprocess, 'Popen', return_value=driver))
                        stack.enter_context(patch.object(safari, 'fixture_server', return_value=(Mock(), {'origin':'http://fixture', 'sourceHash':'fixed'}, {})))
                        stack.enter_context(patch.object(safari, 'SafariWebDriver', return_value=client))
                        stack.enter_context(patch.object(client, 'request', side_effect=request))
                        stack.enter_context(patch.object(client, 'screenshot'))
                        stack.enter_context(patch.object(safari.native, 'stop'))
                        stack.enter_context(patch.object(safari.threading, 'Timer'))
                        viewer = stack.enter_context(patch.object(safari.native, 'viewer', side_effect=application))
                        planner = stack.enter_context(patch.object(safari.native, 'planner', side_effect=application))
                        record = safari.run_case(Path(temp), name, '/test/safaridriver')
                    self.assertEqual(viewer.call_count, int(name.startswith('viewer')))
                    self.assertEqual(planner.call_count, int(name == 'planner-256'))
                    self.assertEqual(calls.count(('POST', '/session')), 1)
                    self.assertEqual(calls.count(('POST', '/session/owned/url')), 1)
                    self.assertFalse(record['windowFocus']['documentFocused'])
                    self.assertNotIn('focusCompleted', record['windowFocus'])
                    self.assertEqual(record['status'], 'failed' if application_failure else 'passed')
                    self.assertEqual(record['phase'], 'application' if application_failure else 'completed')
                    if application_failure:
                        self.assertEqual(record['error'], 'application pointer assertion failed')
                    self.assertEqual(json.loads((Path(temp) / 'report.json').read_text()), record)

    def test_session_http_error_uses_bounded_body_and_restores_scope(self):
        class Socket:
            def __init__(self, payload): self.payload = payload; self.values = []
            def makefile(self, _mode):
                class Reader(io.BytesIO): pass
                reader = Reader(self.payload); reader.raw = type('Raw', (), {'_sock': self})()
                return reader
            def settimeout(self, value): self.values.append(value)
        body = b'{"value":{"error":"session not created","message":"setup rejected"}}'
        sock = Socket(b'HTTP/1.1 500 Error\r\nContent-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body)
        response = http.client.HTTPResponse(sock); response.begin()
        error = safari.urllib.error.HTTPError('http://fixture/session', 500, 'Error', response.headers, response)
        client = safari.SafariWebDriver('http://fixture')
        now, timing = [0], {}
        def opened(_request, timeout):
            self.assertEqual(timeout, 60)
            now[0] = 40
            raise error
        with patch.object(safari.time, 'monotonic', side_effect=lambda: now[0]), \
             patch.object(safari.urllib.request, 'urlopen', side_effect=opened) as opening:
            with self.assertRaisesRegex(RuntimeError, 'session not created'):
                client.start(timing)
            self.assertEqual(client.command_timeout(), 30)
        self.assertEqual(opening.call_count, 1)
        self.assertEqual(sock.values, [20])
        self.assertFalse(timing['completed'])
        self.assertFalse(timing['timedOut'])


class HostedPreparationTests(unittest.TestCase):
    hosted = {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted'}

    @staticmethod
    def cold_start_error(**overrides):
        value = {'error': 'session not created', 'message': safari.RWI_STARTUP_MESSAGE, 'stacktrace': ''}
        value.update(overrides)
        return safari.WebDriverError('POST', '/session', 500, value)

    def run_preparation(self, outcomes, *, elapsed=None, url='about:blank', close_error=None,
                        stop_error=None, blank_elapsed=0, close_elapsed=0):
        now, clients, drivers, calls = [0.0], [], [], []
        real_client = safari.SafariWebDriver
        def make_driver(*args, **kwargs):
            self.assertEqual(args[0][0], '/test/safaridriver')
            self.assertEqual(args[0][1], '--port')
            driver = Mock(); driver.poll.return_value = None
            if stop_error:
                driver.wait.side_effect = stop_error
            drivers.append(driver)
            return driver
        def make_client(origin):
            client = real_client(origin)
            index = len(clients)
            clients.append(client)
            def request(method, route, data=None):
                calls.append((index, method, route, client.command_timeout()))
                if route == '/session' and method == 'POST':
                    if elapsed:
                        now[0] += elapsed[index]
                    outcome = outcomes[index]
                    if isinstance(outcome, Exception):
                        raise outcome
                    return {'sessionId': f'probe-{index}', 'capabilities': {'browserName': 'Safari'}}
                if route.endswith('/execute/sync'):
                    self.assertEqual(data['script'], 'return location.href;')
                    now[0] += blank_elapsed
                    return url
                if method == 'DELETE':
                    now[0] += close_elapsed
                    if close_error:
                        raise close_error
                return None
            client.request = Mock(side_effect=request)
            return client
        with tempfile.TemporaryDirectory() as temp, \
             patch.object(safari.sys, 'platform', 'darwin'), \
             patch.dict(safari.os.environ, self.hosted, clear=True), \
             patch.object(safari.time, 'monotonic', side_effect=lambda: now[0]), \
             patch.object(safari.subprocess, 'Popen', side_effect=make_driver), \
             patch.object(safari.subprocess, 'run') as native_command, \
             patch.object(safari, 'SafariWebDriver', side_effect=make_client):
            result = safari.prepare_hosted_safari(Path(temp), '/test/safaridriver')
            self.assertEqual(json.loads((Path(temp) / 'preparation.json').read_text()), result)
            self.assertEqual(len(list(Path(temp).glob('preparation-driver-*.log'))), len(drivers))
            native_command.assert_not_called()
        return result, clients, drivers, calls

    def test_guard_rejects_local_self_hosted_and_other_platforms_before_launch(self):
        for platform, environment in (('darwin', {}), ('darwin', {'GITHUB_ACTIONS': 'true'}),
                                      ('darwin', {**self.hosted, 'RUNNER_ENVIRONMENT': 'self-hosted'}),
                                      ('linux', self.hosted)):
            with self.subTest(platform=platform, environment=environment), tempfile.TemporaryDirectory() as temp:
                with patch.object(safari.sys, 'platform', platform), \
                     patch.dict(safari.os.environ, environment, clear=True), \
                     patch.object(safari.subprocess, 'Popen') as command:
                    result = safari.prepare_hosted_safari(Path(temp))
                command.assert_not_called()
                self.assertEqual(result['status'], 'failed')
                self.assertEqual(result['phase'], 'hosted-runner-check')
                self.assertEqual(result['attempts'], [])

    def test_successful_probe_is_blank_closed_and_never_repeated(self):
        result, clients, drivers, calls = self.run_preparation([True], elapsed=[2])
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(len(clients), 1)
        self.assertTrue(result['attempts'][0]['sessionClosed'])
        self.assertEqual(result['attempts'][0]['url'], 'about:blank')
        self.assertEqual([(method, route) for _, method, route, _ in calls],
                         [('GET', '/status'), ('POST', '/session'),
                          ('POST', '/session/probe-0/execute/sync'), ('DELETE', '/session/probe-0')])
        drivers[0].terminate.assert_called_once()
        drivers[0].wait.assert_called_once()
        drivers[0].kill.assert_not_called()

    def test_only_known_cold_start_can_recover_once_within_shared_budget(self):
        error = self.cold_start_error()
        result, clients, drivers, calls = self.run_preparation([error, True], elapsed=[30, 1])
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['durationMs'], 31000)
        self.assertEqual(len(clients), 2)
        first, second = result['attempts']
        self.assertEqual(first['status'], 'failed')
        self.assertEqual(first['webdriverError'], error.response)
        self.assertTrue(first['knownColdStartRecovery'])
        self.assertFalse(first['sessionClosed'])
        self.assertTrue(second['sessionClosed'])
        self.assertEqual([timeout for _, method, route, timeout in calls if (method, route) == ('POST', '/session')], [60, 30])
        for driver in drivers:
            driver.terminate.assert_called_once()
            driver.wait.assert_called_once()

    def test_unknown_outcomes_never_retry(self):
        valid = self.cold_start_error().response['value']
        errors = [TimeoutError('HTTP timeout'), ValueError('invalid JSON'),
                  RuntimeError(safari.RWI_STARTUP_MESSAGE), safari.urllib.error.URLError('transport failed'),
                  self.cold_start_error(message=safari.RWI_STARTUP_MESSAGE + ' changed'),
                  self.cold_start_error(error='unknown error'), self.cold_start_error(sessionId='maybe-owned'),
                  safari.WebDriverError('POST', '/session', 200, valid),
                  safari.WebDriverError('POST', '/session', 502, valid),
                  safari.WebDriverError('GET', '/session', 500, valid),
                  safari.WebDriverError('POST', '/session/owned/url', 500, valid)]
        for error in errors:
            with self.subTest(error=error):
                result, clients, drivers, calls = self.run_preparation([error])
                self.assertEqual(result['status'], 'failed')
                self.assertEqual(len(clients), 1)
                self.assertFalse(result['attempts'][0]['knownColdStartRecovery'])
                self.assertEqual(len([1 for _, method, route, _ in calls if (method, route) == ('POST', '/session')]), 1)

    def test_second_known_failure_stops_and_retains_both_attempts(self):
        result, clients, drivers, calls = self.run_preparation([self.cold_start_error(), self.cold_start_error()], elapsed=[30, 20])
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(len(clients), 2)
        self.assertTrue(result['attempts'][0]['knownColdStartRecovery'])
        self.assertFalse(result['attempts'][1]['knownColdStartRecovery'])
        self.assertEqual(result['attempts'][1]['status'], 'failed')

    def test_nonblank_probe_and_cleanup_failures_stop_preparation(self):
        for options in ({'url': 'http://unexpected/'}, {'close_error': RuntimeError('close failed')},
                        {'stop_error': RuntimeError('stop failed')}):
            with self.subTest(options=options):
                result, clients, drivers, calls = self.run_preparation([True], **options)
                self.assertEqual(result['status'], 'failed')
                self.assertEqual(len(clients), 1)
                self.assertIn((0, 'DELETE', '/session/probe-0'), [(i, method, route) for i, method, route, _ in calls])
                drivers[0].terminate.assert_called_once()

    def test_expired_shared_budget_never_retries_or_passes_late_success(self):
        for outcome in (self.cold_start_error(), True):
            with self.subTest(outcome=outcome):
                result, clients, drivers, calls = self.run_preparation([outcome], elapsed=[60])
                self.assertEqual(result['status'], 'failed')
                self.assertEqual(len(clients), 1)
                self.assertEqual(result['durationMs'], 60000)
                self.assertTrue(result['timedOut'])
                drivers[0].kill.assert_called_once()

    def test_blank_observation_and_cleanup_cannot_complete_after_shared_deadline(self):
        for options in ({'blank_elapsed': 60}, {'close_elapsed': 60}):
            with self.subTest(options=options):
                result, clients, drivers, calls = self.run_preparation([True], **options)
                self.assertEqual(result['status'], 'failed')
                self.assertTrue(result['timedOut'])
                self.assertEqual(len(clients), 1)
                self.assertFalse(result['attempts'][0]['sessionClosed'])

    def test_cli_defaults_preserve_local_safari_and_failed_preparation_cannot_run_cases(self):
        for preparation in (None, 'failed', 'passed'):
            with self.subTest(preparation=preparation), tempfile.TemporaryDirectory() as temp:
                argv = ['test-safari-acceptance.py', '--output', temp]
                if preparation is not None:
                    argv.append('--prepare-hosted-safari')
                def run_case(_output, name, _driver, **options):
                    self.assertEqual(options, {})
                    return {'suite': name, 'status': 'failed' if name == 'viewer-6' else 'passed', 'durationMs': 1}
                with patch.object(safari.sys, 'argv', argv), \
                     patch.object(safari, 'prepare_hosted_safari', return_value={'status': preparation}) as prepare, \
                     patch.object(safari, 'run_case', side_effect=run_case) as cases:
                    self.assertEqual(safari.main(), 1)
                self.assertEqual(prepare.call_count, int(preparation is not None))
                self.assertEqual(cases.call_count, 0 if preparation == 'failed' else 3)
                if cases.call_count:
                    self.assertEqual([call.args[1] for call in cases.call_args_list], ['viewer-6', 'viewer-24', 'planner-256'])
                summary = json.loads((Path(temp) / 'summary.json').read_text())
                self.assertEqual(summary['status'], 'failed')
                if preparation == 'failed':
                    self.assertEqual(summary['cases'], [])
                else:
                    self.assertEqual(summary['cases'][0]['status'], 'failed')


class PlannerDiagnosticTests(unittest.TestCase):
    def test_real_fixture_instrumentation_preserves_failures_and_completed_paints(self):
        javascript = r"""
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(process.argv[1],'utf8');
const functions=source.slice(source.indexOf('function instrument() {'),source.indexOf('\nconst server=http.createServer'));
const events={},errors=[],canvasContext=new Map();let time=0;
class Canvas {
  constructor(id){this.id=id;this.isConnected=true;this._width=400;this._height=300;}
  get width(){return this._width;} set width(v){this._width=v;}
  get height(){return this._height;} set height(v){this._height=v;}
  getContext(){return canvasContext.get(this);}
}
const plan=new Canvas('plan-canvas'),thumbnail=new Canvas('');let lost=false,readError=null,clearError=null;
const pixels={data:new Uint8Array([1,2,3,4])};
function context(canvas){return {canvas,isContextLost:()=>lost,
  clearRect(){if(clearError)throw clearError;return 42;},
  getImageData(...args){assert.equal(this.canvas,canvas);assert.deepEqual(args,[0,0,2,2]);if(readError)throw readError;return pixels;}};}
canvasContext.set(plan,context(plan));canvasContext.set(thumbnail,context(thumbnail));
const env={assert,HTMLCanvasElement:Canvas,document:{getElementById:()=>plan},performance:{now:()=>++time},
  console:{error:(...args)=>errors.push(args)},addEventListener:(type,fn)=>events[type]=fn};env.window=env;
vm.createContext(env);vm.runInContext(functions+'\ninstrument();',env);
const ctx=plan.getContext('2d'),thumb=thumbnail.getContext('2d');env.ctx=ctx;env.skip=false;env.fail=false;
const body='function renderPlan() { if(skip)return 7;ctx.clearRect(0,0,400,300);if(fail)throw failure;return 42; }';
vm.runInContext(env.instrumentPlanRenderer(body),env);
assert.equal(env.renderPlan(),42);assert.equal(env.__plannerStats.planPaints,1);
assert.equal(env.__plannerPlanState().lastPaint.resizeSequence,0);
env.skip=true;assert.equal(env.renderPlan(),7);assert.equal(env.__plannerStats.planPaints,1);env.skip=false;
const failure=new Error('original render failure');env.failure=failure;env.fail=true;
assert.throws(()=>env.renderPlan(),e=>e===failure);assert.equal(env.__plannerStats.planPaints,1);
assert.equal(env.__plannerStats.planDraws,2,'A clear attempt does not certify a complete render');env.fail=false;
clearError=failure;assert.throws(()=>env.renderPlan(),e=>e===failure);assert.equal(env.__plannerStats.planPaints,1);clearError=null;
plan.width=0;env.renderPlan();assert.equal(env.__plannerStats.planPaints,1,'Zero bitmap cannot certify a paint');
plan.width=400;assert.notEqual(env.__plannerPlanState().lastPaint.resizeSequence,env.__plannerPlanState().resizeSequence);
lost=true;env.renderPlan();assert.equal(env.__plannerStats.planPaints,1);lost=false;
env.renderPlan();assert.equal(env.__plannerStats.planPaints,2);
assert.equal(env.__plannerPlanState().lastPaint.resizeSequence,env.__plannerPlanState().resizeSequence);
assert.equal(thumb.getImageData(0,0,2,2),pixels,'Pixel data and original receiver are unchanged');
readError=Object.assign(new Error('pixels unavailable'),{name:'InvalidStateError'});
const uncaughtBefore=env.__plannerStats.errorCount;
assert.throws(()=>thumb.getImageData(0,0,2,2),e=>e===readError);
assert.equal(env.__plannerStats.errorCount,uncaughtBefore,'A handled optional failure is not an uncaught error');
const pixelFailure=env.__plannerStats.canvasReadErrors.at(-1);
assert.equal(pixelFailure.kind,'2d-getImageData');assert.equal(pixelFailure.canvas.width,400);
assert.equal(pixelFailure.name,'InvalidStateError');assert.match(pixelFailure.stack,/pixels unavailable/);
events.error({error:readError,message:'uncaught pixel failure',filename:'http://fixture/editor.js',lineno:338,colno:12});
const uncaught=env.__plannerStats.errorDetails.at(-1);assert.equal(uncaught.line,338);assert.equal(uncaught.column,12);
assert.equal(uncaught.file,'http://fixture/editor.js');assert.ok(uncaught.time>pixelFailure.time);
const countedUncaught=env.__plannerStats.errorCount;
for(let i=0;i<100;i++)assert.throws(()=>thumb.getImageData(0,0,2,2),e=>e===readError);
assert.equal(env.__plannerStats.canvasReadErrors.length,32);assert.equal(env.__plannerStats.canvasReadErrorCount,101);
assert.equal(env.__plannerStats.errorCount,countedUncaught);
for(let i=0;i<100;i++)env.__plannerRecordError({message:'x'.repeat(5000),stack:'y'.repeat(9000),name:'z'.repeat(300)});
assert.equal(env.__plannerStats.errors.length,32);assert.equal(env.__plannerStats.errorDetails.length,32);
assert.ok(env.__plannerStats.errorCount>100);assert.ok(env.__plannerStats.errorDetails.every(e=>e.message.length<=2048&&e.stack.length<=4096&&e.name.length<=128));
assert.throws(()=>env.instrumentPlanRenderer('function wrong() {}'));
assert.throws(()=>env.instrumentPlanRenderer(body+body));
const position={x:1,y:0,z:1},hits=[];plan.getBoundingClientRect=()=>({x:10.2,y:20.2,width:400,height:300});
env.innerWidth=1000;env.innerHeight=800;env.document.hasFocus=()=>true;env.document.visibilityState='visible';
env.document.elementFromPoint=(x,y)=>{hits.push([x,y]);return plan;};
env.planner={getProject:()=>({floors:[{items:[{id:'first',position_m:position}]}]}),getSelection:()=>null,worldToScreen:([x,y])=>[x*10,y*10]};
const diagnostics=JSON.parse(fs.readFileSync(0,'utf8'));
const snapshot=vm.runInContext('(function(){'+diagnostics.snapshot+'})()',env);
assert.deepEqual(hits,[[20,30],[25,30]],'Hit tests use the rounded coordinates sent to WebDriver');
assert.equal(snapshot.position.x,1);position.x=5;assert.equal(snapshot.position.x,1,'Before-drag evidence is a copy');
assert.equal(snapshot.canvas.width,400);assert.equal(snapshot.endpointHits[0].canvas,true);
assert.equal(snapshot.errorDetails.length,32);assert.equal(snapshot.documentFocused,true);
const readPixels=()=>vm.runInContext('(function(){'+diagnostics.pixels+'})()',env);let reads=0;
plan.width=2;plan.height=2;ctx.getImageData=()=>{reads++;return {data:new Uint8Array([1,2,3,255,1,2,3,255,4,5,6,255,4,5,6,255])};};
const detail=readPixels();assert.equal(detail.distinctVisibleRGBColorsAtLeast,2);assert.equal(detail.complete,true);assert.equal(reads,1);
assert.equal(detail.resizeSequence,env.__plannerPlanState().resizeSequence);assert.equal(detail.readbackBytes,16);
ctx.getImageData=()=>({data:new Uint8Array([1,2,3,255,1,2,3,255,1,2,3,255,1,2,3,255])});
assert.equal(readPixels().distinctVisibleRGBColorsAtLeast,1,'Uniform opaque pixels are blank');
ctx.getImageData=()=>({data:new Uint8Array([1,2,3,0,4,5,6,0,7,8,9,0,10,11,12,0])});
assert.equal(readPixels().distinctVisibleRGBColorsAtLeast,0,'Invisible RGB differences do not prove content');
ctx.getImageData=()=>({data:new Uint8Array([1,2,3,1,1,2,3,80,1,2,3,160,1,2,3,255])});
assert.equal(readPixels().distinctVisibleRGBColorsAtLeast,1,'Alpha changes alone do not prove RGB diversity');
ctx.getImageData=()=>({data:new Uint8Array(15)});
assert.equal(readPixels().status,'readback-failed','Incomplete readback is rejected');
ctx.getImageData=()=>{throw readError;};assert.equal(readPixels().name,'InvalidStateError');
plan.width=4000001;assert.equal(readPixels().status,'outside-readback-bound');
"""
        result = subprocess.run(['node', '-e', javascript, str(Path(__file__).with_name('test-planner-stability.cjs'))],
                                input=json.dumps({'snapshot': safari.native.PLANNER_INPUT_SNAPSHOT,
                                                  'pixels': safari.native.PLANNER_2D_PIXELS}),
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def snapshot(self, x=1):
        return {'canvas': {'attached': True, 'width': 400, 'height': 300, 'contextAvailable': True,
                           'contextLost': False, 'paintCount': 1, 'resizeSequence': 2,
                           'lastPaint': {'width': 400, 'height': 300, 'resizeSequence': 2}},
                'rect': {'x': 0, 'y': 0, 'width': 400, 'height': 300},
                'points': [[10, 10], [20, 10]], 'endpointHits': [{'canvas': True, 'visible': True}] * 2,
                'position': {'x': x, 'y': 0, 'z': 1}, 'errorCount': 0, 'errors': [], 'errorDetails': []}

    def pixels(self):
        return {'status': 'pixels-read', 'width': 400, 'height': 300, 'resizeSequence': 2,
                'readbackBytes': 400 * 300 * 4, 'distinctVisibleRGBColorsAtLeast': 2}

    def run_planner_prefix(self, before, after, *, loaded=None, on_snapshot=None, on_pixels=None,
                           initial_pixels=None, screenshot_error=None, on_screenshot=None,
                           drag_error=None, wait_error=None, capture_error=None, drag_ms=332):
        class ReachedPreview(Exception):
            pass
        snapshots = [loaded if loaded is not None else before, before, after]
        client = Mock()
        client.drag.side_effect = drag_error
        client.drag.return_value = drag_ms
        def screenshot(_path):
            if screenshot_error:
                raise screenshot_error
            if on_screenshot:
                on_screenshot()
        client.screenshot.side_effect = screenshot
        def execute(script, *_args):
            if script == safari.native.PLANNER_INPUT_SNAPSHOT:
                if capture_error:
                    raise capture_error
                if on_snapshot:
                    on_snapshot(4 - len(snapshots))
                return snapshots.pop(0)
            if script == safari.native.PLANNER_2D_PIXELS:
                if on_pixels:
                    on_pixels()
                return initial_pixels if initial_pixels is not None else self.pixels()
            if 'floors.reduce' in script:
                return 256
            if 'position_m.x;' in script:
                return after['position']['x']
            if "#preview-tab" in script:
                raise ReachedPreview()
            return True
        def wait(_expression, **kwargs):
            if kwargs:
                self.assertGreater(kwargs['timeout'], 0)
                self.assertLessEqual(kwargs['timeout'], 30)
                if wait_error:
                    raise wait_error
        client.execute.side_effect = execute
        client.wait.side_effect = wait
        record = {'samples': [], 'output': '/synthetic/planner-output'}
        saved = []
        try:
            safari.native.planner(client, 'http://fixture', {}, record,
                                  lambda: saved.append(json.loads(json.dumps(record))))
        except Exception as error:
            return error, client, record, saved, ReachedPreview
        self.fail('The prefix should stop before exercising the separate preview suite')

    def test_preexisting_application_error_stops_before_real_input_with_evidence(self):
        before = self.snapshot()
        before.update(errorCount=1, errors=['draw failed'], errorDetails=[{'kind': 'plan-render', 'stack': 'original'}])
        error, client, record, saved, _ = self.run_planner_prefix(before, self.snapshot(1.5))
        self.assertIn('application error before input', str(error));client.drag.assert_not_called()
        self.assertEqual(saved[-1]['samples'][0]['beforeDrag']['errorDetails'], before['errorDetails'])

    def test_zero_lost_and_stale_bitmaps_cannot_pass_paint_readiness(self):
        for change in ({'width': 0}, {'contextLost': True}, {'paintCount': 0}, {'resizeSequence': 3}):
            before = self.snapshot();before['canvas'].update(change)
            with self.subTest(change=change):
                error, client, *_ = self.run_planner_prefix(before, self.snapshot(1.5))
                self.assertIn('completed paint', str(error));client.drag.assert_not_called()

    def test_post_drag_application_error_and_position_are_saved_before_failure(self):
        after = self.snapshot()
        after.update(errorCount=1, errors=['InvalidStateError'], errorDetails=[{'kind': '2d-getImageData', 'line': 338}])
        error, client, record, saved, _ = self.run_planner_prefix(self.snapshot(), after)
        self.assertIn('application error during input', str(error));client.drag.assert_called_once_with([10, 10], [20, 10])
        self.assertEqual(saved[-1]['samples'][0]['afterDrag'], after)

    def test_exact_position_and_original_time_limit_are_not_relaxed(self):
        for x in (1, 1.49, 1.500001):
            error, _, _, saved, _ = self.run_planner_prefix(self.snapshot(), self.snapshot(x))
            self.assertEqual(str(error), 'Real pointer input moves the intended furniture')
            self.assertEqual(saved[-1]['samples'][0]['afterDrag']['position']['x'], x)
        error, _, _, _, reached = self.run_planner_prefix(self.snapshot(), self.snapshot(1.5))
        self.assertIsInstance(error, reached)
        error, _, _, _, _ = self.run_planner_prefix(self.snapshot(), self.snapshot(1.5), drag_ms=10000)
        self.assertEqual(str(error), 'Planner furniture drag exceeded 10 seconds')

    def test_obstructed_endpoint_stops_without_forced_input(self):
        before = self.snapshot();before['endpointHits'] = [{'canvas': False, 'visible': True}]
        error, client, _, saved, _ = self.run_planner_prefix(before, self.snapshot(1.5))
        self.assertIn('visible plan canvas', str(error));client.drag.assert_not_called()
        self.assertEqual(saved[-1]['samples'][0]['beforeDrag']['endpointHits'], before['endpointHits'])

    def test_nonblank_main_bitmap_and_initial_screenshot_are_required(self):
        for changed in ({'distinctVisibleRGBColorsAtLeast': 0}, {'distinctVisibleRGBColorsAtLeast': 1},
                        {'readbackBytes': 0}, {'status': 'readback-failed', 'name': 'InvalidStateError'},
                        {'status': 'outside-readback-bound'}):
            pixels = self.pixels(); pixels.update(changed)
            with self.subTest(changed=changed):
                error, client, _, saved, _ = self.run_planner_prefix(
                    self.snapshot(), self.snapshot(1.5), initial_pixels=pixels)
                self.assertIn('Planner 2D', str(error))
                client.drag.assert_not_called()
                self.assertEqual(saved[-1]['samples'][0]['initial2D'], pixels)
        error, client, _, saved, reached = self.run_planner_prefix(self.snapshot(), self.snapshot(1.5))
        self.assertIsInstance(error, reached)
        sample = saved[-1]['samples'][0]
        self.assertEqual(sample['initial2D']['distinctVisibleRGBColorsAtLeast'], 2)
        self.assertEqual(sample['initial2DScreenshot'], 'planner-initial-2d.png')
        client.screenshot.assert_called_once_with(Path('/synthetic/planner-output/planner-initial-2d.png'))
        original = RuntimeError('screenshot failed')
        error, client, _, saved, _ = self.run_planner_prefix(
            self.snapshot(), self.snapshot(1.5), screenshot_error=original)
        self.assertIs(error, original)
        client.drag.assert_not_called()
        self.assertNotIn('initial2DScreenshot', saved[-1]['samples'][0])
        self.assertFalse(saved[-1]['samples'][0]['loadCompleted'])

    def test_nonblank_readback_must_match_final_bitmap_dimensions_and_generation(self):
        for changed in ('width', 'height', 'resizeSequence'):
            before = self.snapshot()
            before['canvas'][changed] += 1
            before['canvas']['lastPaint'][changed] += 1
            with self.subTest(changed=changed):
                error, client, _, saved, _ = self.run_planner_prefix(before, self.snapshot(1.5))
                self.assertEqual(str(error), 'Planner 2D bitmap changed after its nonblank readback')
                client.drag.assert_not_called()
                self.assertEqual(saved[-1]['samples'][0]['initial2D'], self.pixels())

    def test_nonblank_readback_and_screenshot_share_the_original_load_deadline(self):
        for operation in ('on_pixels', 'on_screenshot'):
            now = [0.0]
            def late(): now[0] = 30
            with self.subTest(operation=operation), patch.object(safari.time, 'monotonic', side_effect=lambda: now[0]):
                error, client, _, saved, _ = self.run_planner_prefix(
                    self.snapshot(), self.snapshot(1.5), **{operation: late})
            self.assertIsInstance(error, TimeoutError)
            client.drag.assert_not_called()
            self.assertEqual(saved[-1]['samples'][0]['loadMs'], 30000)
            self.assertFalse(saved[-1]['samples'][0]['loadCompleted'])

    def test_final_geometry_is_checked_after_setup_and_immediately_before_drag(self):
        error, client, _, _, reached = self.run_planner_prefix(self.snapshot(), self.snapshot(1.5))
        self.assertIsInstance(error, reached)
        calls = client.method_calls
        drag_index = next(i for i, call in enumerate(calls) if call[0] == 'drag')
        self.assertEqual([(call[0], call.args) for call in calls[drag_index-2:drag_index]],
                         [('execute', (safari.native.PLANNER_INPUT_SNAPSHOT,))] * 2)
        for changed in ('rect', 'points', 'resizeSequence'):
            before = self.snapshot()
            if changed == 'rect':
                before['rect']['x'] = 20
            elif changed == 'points':
                before['points'][1][0] = 30
            else:
                before['canvas']['resizeSequence'] = 3
                before['canvas']['lastPaint']['resizeSequence'] = 3
            with self.subTest(changed=changed):
                error, client, _, saved, _ = self.run_planner_prefix(before, self.snapshot(1.5), loaded=self.snapshot())
                self.assertIn('geometry changed immediately before input', str(error))
                client.drag.assert_not_called()
                self.assertEqual(saved[-1]['samples'][0]['beforeDrag'], before)

    def test_late_final_snapshot_is_not_certified_by_an_earlier_load_time(self):
        for finished in (29.999, 30, 31):
            now = [0.0]
            def on_snapshot(index):
                if index == 2:
                    now[0] = finished
            with self.subTest(finished=finished), patch.object(safari.time, 'monotonic', side_effect=lambda: now[0]):
                error, client, record, saved, reached = self.run_planner_prefix(
                    self.snapshot(), self.snapshot(1.5), on_snapshot=on_snapshot)
            sample = record['samples'][0]
            self.assertAlmostEqual(sample['loadMs'], finished * 1000, places=3)
            self.assertEqual(sample['loadCompleted'], finished < 30)
            self.assertEqual(sample['loadTimedOut'], finished >= 30)
            self.assertIsNone(client._cold_load_deadline)
            if finished < 30:
                self.assertIsInstance(error, reached)
                client.drag.assert_called_once()
            else:
                self.assertIsInstance(error, TimeoutError)
                client.drag.assert_not_called()
                self.assertEqual(saved[-1]['samples'][0]['loadMs'], sample['loadMs'])

    def test_planner_scope_bounds_http_headers_and_body_and_restores_prior_deadline(self):
        for header_finished in (29, 30):
            now, sample = [0.0], {}
            class Socket:
                def __init__(self): self.values = []
                def makefile(self, _mode):
                    class Reader(io.BytesIO): pass
                    body = b'{"value":true}'
                    reader = Reader(b'HTTP/1.1 200 OK\r\nContent-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body)
                    reader.raw = type('Raw', (), {'_sock': self})()
                    return reader
                def settimeout(self, value): self.values.append(value)
            sock = Socket()
            response = http.client.HTTPResponse(sock); response.begin()
            client = safari.SafariWebDriver('http://fixture'); client.session_id = 'owned'
            client._cold_load_deadline = 100
            def opened(_request, timeout):
                self.assertEqual(timeout, 2)
                now[0] = header_finished
                return response
            with self.subTest(header_finished=header_finished), \
                 patch.object(safari.time, 'monotonic', side_effect=lambda: now[0]), \
                 patch.object(safari.urllib.request, 'urlopen', side_effect=opened) as opening:
                try:
                    with safari.native.planner_load_scope(client, sample):
                        now[0] = 28
                        self.assertTrue(client.execute(safari.native.PLANNER_INPUT_SNAPSHOT))
                except TimeoutError:
                    self.assertEqual(header_finished, 30)
                else:
                    self.assertEqual(header_finished, 29)
                opening.assert_called_once()
            self.assertEqual(sock.values, [1] if header_finished == 29 else [])
            self.assertTrue(response.isclosed())
            self.assertEqual(client._cold_load_deadline, 100)
            self.assertEqual(sample['loadCompleted'], header_finished < 30)

    def test_planner_scope_respects_outer_deadlines_and_preserves_original_failure(self):
        for cold, browser, expected in ((9, 8, 8), (8, 9, 8), (None, None, 30)):
            client = Mock(); client._cold_load_deadline = cold; client._browser_deadline = browser
            original = RuntimeError('original scoped failure')
            sample = {}
            with self.subTest(cold=cold, browser=browser), patch.object(safari.time, 'monotonic', return_value=0):
                with self.assertRaises(RuntimeError) as caught:
                    with safari.native.planner_load_scope(client, sample) as remaining:
                        self.assertEqual(remaining(), expected)
                        raise original
            self.assertIs(caught.exception, original)
            self.assertEqual(client._cold_load_deadline, cold)
            self.assertFalse(sample['loadCompleted'])
            self.assertFalse(sample['loadTimedOut'])

    def test_readiness_and_action_exceptions_retain_evidence_without_masking(self):
        original = RuntimeError('original driver failure')
        for keyword, field in [('wait_error', 'beforeDrag'), ('drag_error', 'afterDrag')]:
            error, _, _, saved, _ = self.run_planner_prefix(self.snapshot(), self.snapshot(), **{keyword: original})
            self.assertIs(error, original);self.assertIn(field, saved[-1]['samples'][0])
            self.assertEqual(saved[-1]['samples'][0]['failure2D']['distinctVisibleRGBColorsAtLeast'], 2)
        error, _, _, saved, _ = self.run_planner_prefix(self.snapshot(), self.snapshot(),
            wait_error=original, capture_error=RuntimeError('snapshot unavailable'))
        self.assertIs(error, original)
        self.assertEqual(saved[-1]['samples'][0]['beforeDragCaptureError'], 'snapshot unavailable')


if __name__ == '__main__':
    unittest.main()
