#!/usr/bin/env python3
"""Verify Safari's real HTTP transport and shared fixture response semantics."""
import importlib.util
import json
import io
import http.client
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


if __name__ == '__main__':
    unittest.main()
