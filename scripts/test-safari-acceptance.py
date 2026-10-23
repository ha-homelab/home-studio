#!/usr/bin/env python3
"""Exercise real macOS Safari through Apple's supported W3C WebDriver.

Enable automation on a disposable CI runner with ``sudo safaridriver --enable``.
This runner never changes that setting or installs a browser. Local runs only
use Apple's isolated automation sessions. The explicit hosted-runner preparation
option checks a blank WebDriver session without opening ordinary Safari windows.
"""
import argparse
import contextlib
import importlib.util
import json
import os
import platform
import queue
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location('native_acceptance', SCRIPTS / 'test-waterfox-acceptance.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
SESSION_START_BUDGET_MS = 60000
PREPARATION_BUDGET_MS = 60000
RWI_STARTUP_MESSAGE = (
    'Could not create a session: The session timed out while connecting to a Safari instance. '
    'The following asynchronous operation timed out: Finding or launching a compatible local '
    'Safari and waiting for its RWIApplication to appear and become ready.')


class WebDriverError(RuntimeError):
    """Preserve the actual protocol response; recovery must not match traceback text."""
    def __init__(self, method, route, status, value, session_id=None):
        super().__init__(f'WebDriver {method} {route}: {value}')
        self.response = {'method': method, 'route': route, 'status': status, 'value': value}
        if session_id is not None:
            self.response['sessionId'] = session_id

    def is_known_cold_start(self):
        value = self.response['value']
        return (self.response['method'] == 'POST' and self.response['route'] == '/session'
                and self.response['status'] == 500 and isinstance(value, dict)
                and value.get('error') == 'session not created'
                and value.get('message') == RWI_STARTUP_MESSAGE
                and 'sessionId' not in value and 'sessionId' not in self.response)


def prepare_hosted_safari(output, driver_path='/usr/bin/safaridriver'):
    """Check a blank automation session, recovering only the known cold-launch error."""
    output.mkdir(parents=True, exist_ok=True)
    record = {'schema': 1, 'product': 'Safari', 'status': 'running',
              'sourceRevision': os.environ.get('GITHUB_SHA'),
              'phase': 'hosted-runner-check', 'budgetMs': PREPARATION_BUDGET_MS,
              'durationMs': None, 'timedOut': False, 'attempts': []}
    started = time.monotonic()
    deadline = started + PREPARATION_BUDGET_MS / 1000

    def save():
        (output / 'preparation.json').write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')

    def remaining():
        value = deadline - time.monotonic()
        if value <= 0:
            raise TimeoutError('Safari preparation exceeded its 60-second deadline')
        return value

    def stop_driver(driver):
        if driver is not None and driver.poll() is None:
            driver.terminate()
            try:
                driver.wait(timeout=min(5, remaining()))
            except (TimeoutError, subprocess.TimeoutExpired):
                driver.kill()
                driver.wait(timeout=remaining())

    save()
    try:
        native.require(sys.platform == 'darwin' and os.environ.get('GITHUB_ACTIONS') == 'true'
                       and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted',
                       'Safari preparation requires a disposable GitHub-hosted macOS runner')
        for number in (1, 2):
            remaining()
            attempt = {'attempt': number, 'status': 'running', 'phase': 'driver-startup',
                       'sessionClosed': False, 'cleanupErrors': []}
            record['attempts'].append(attempt)
            record['phase'] = 'blank-session-probe'
            save()
            attempt_started = time.monotonic()
            driver = client = failure = None
            retry = False
            with (output / f'preparation-driver-{number}.log').open('w', encoding='utf-8') as log:
                try:
                    with socket.socket() as probe:
                        probe.bind(('127.0.0.1', 0))
                        port = probe.getsockname()[1]
                    driver = subprocess.Popen([driver_path, '--port', str(port)], stdout=log, stderr=subprocess.STDOUT)
                    client = SafariWebDriver(f'http://127.0.0.1:{port}')
                    client._preparation_deadline = client._browser_deadline = deadline
                    while True:
                        remaining()
                        native.require(driver.poll() is None, 'SafariDriver exited before the blank probe')
                        try:
                            client.request('GET', '/status')
                            break
                        except urllib.error.URLError as error:
                            if not isinstance(error.reason, ConnectionRefusedError):
                                raise
                            time.sleep(min(.1, remaining()))
                    attempt['phase'] = 'session-startup'
                    attempt['sessionStartup'] = {}
                    save()
                    attempt['session'] = client.start(attempt['sessionStartup'])
                    native.require(isinstance(client.session_id, str) and bool(client.session_id),
                                   'Safari blank probe did not return a session ID')
                    attempt['phase'] = 'blank-document'
                    save()
                    attempt['url'] = client.execute('return location.href;')
                    remaining()
                    native.require(attempt['url'] == 'about:blank', 'Safari probe must remain on its initial blank document')
                    attempt['status'] = 'passed'
                except Exception as error:
                    failure = error
                    attempt.update(status='failed', error=str(error), traceback=traceback.format_exc())
                    if isinstance(error, WebDriverError):
                        attempt['webdriverError'] = error.response
                        retry = number == 1 and client.session_id is None and error.is_known_cold_start()
                    attempt['knownColdStartRecovery'] = retry
                finally:
                    if client is not None and client.session_id is not None:
                        try:
                            client.close()
                            remaining()
                            attempt['sessionClosed'] = True
                        except Exception as error:
                            attempt['cleanupErrors'].append(str(error))
                            failure = failure or error
                    try:
                        stop_driver(driver)
                        remaining()
                    except Exception as error:
                        attempt['cleanupErrors'].append(str(error))
                        failure = failure or error
                    if attempt['cleanupErrors']:
                        attempt['status'] = 'failed'
                        retry = False
                    attempt['knownColdStartRecovery'] = retry
                    attempt['durationMs'] = (time.monotonic() - attempt_started) * 1000
                    save()
            if failure is None:
                record.update(status='passed', phase='completed')
                break
            if not retry:
                raise failure
    except Exception as error:
        record.update(status='failed', error=str(error), traceback=traceback.format_exc(),
                      timedOut=isinstance(error, (TimeoutError, subprocess.TimeoutExpired))
                      or time.monotonic() >= deadline)
    finally:
        record['durationMs'] = (time.monotonic() - started) * 1000
        save()
    print(f'Safari hosted preparation: {record["status"]}', flush=True)
    return record


class SafariWebDriver(native.Marionette):
    """Adapt the shared fixture operations to standard HTTP WebDriver routes."""
    def __init__(self, origin):
        self.origin = origin
        self.session_id = None

    def command_timeout(self):
        deadline = self.__dict__.get('_session_start_deadline')
        if deadline is None:
            preparation_deadline = self.__dict__.get('_preparation_deadline')
            if preparation_deadline is not None:
                remaining = preparation_deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('Safari preparation exceeded its 60-second deadline')
                return min(remaining, super().command_timeout())
            return super().command_timeout()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Initial Safari session exceeded its 60-second or remaining browser deadline')
        return remaining

    def request(self, method, route, data=None):
        body = None if data is None else json.dumps(data).encode('utf-8')
        request = urllib.request.Request(self.origin + route, data=body, method=method,
                                         headers={'Content-Type': 'application/json; charset=utf-8'})
        try:
            response = urllib.request.urlopen(request, timeout=self.command_timeout())
        except urllib.error.HTTPError as error:
            response = error
        with response:
            if (self.__dict__.get('_cold_load_deadline') is None
                    and self.__dict__.get('_session_start_deadline') is None
                    and self.__dict__.get('_preparation_deadline') is None):
                raw = response.read(64 * 1024 * 1024 + 1)
            else:
                # Headers and body share the active setup or cold-load deadline.
                # Update each bounded read's socket timeout without renewing it.
                body_response = response.fp if isinstance(response, urllib.error.HTTPError) else response
                chunks, size = [], 0
                while size <= 64 * 1024 * 1024:
                    remaining = self.command_timeout()
                    if body_response.isclosed():
                        break
                    transport = getattr(getattr(body_response.fp, 'raw', None), '_sock', None)
                    native.require(transport is not None, 'Scoped Safari response requires a bounded socket')
                    transport.settimeout(remaining)
                    chunk = body_response.read1(min(65536, 64 * 1024 * 1024 + 1 - size))
                    if not chunk:
                        break
                    chunks.append(chunk); size += len(chunk)
                raw = b''.join(chunks)
            result = json.loads(raw)
            value = result.get('value')
            if response.status >= 400 or isinstance(value, dict) and value.get('error'):
                raise WebDriverError(method, route, response.status, value, result.get('sessionId'))
        return value

    def start(self, timing=None):
        timing = timing if timing is not None else {}
        started = time.monotonic()
        deadline = started + SESSION_START_BUDGET_MS / 1000
        outer = self.__dict__.get('_browser_deadline')
        if outer is not None:
            deadline = min(deadline, outer)
        timing.update(budgetMs=SESSION_START_BUDGET_MS,
                      effectiveBudgetMs=max(0, (deadline - started) * 1000),
                      durationMs=None, completed=False, timedOut=False)
        previous = self.__dict__.get('_session_start_deadline')
        self._session_start_deadline = deadline
        completed_at = None
        try:
            self.command_timeout()
            result = self.request('POST', '/session', {'capabilities': {'alwaysMatch': {'browserName': 'safari'}}})
            # Retain a returned ID for normal cleanup even if completion is late.
            self.session_id = result['sessionId']
            native.require(result['capabilities']['browserName'].lower() == 'safari', 'Real Safari is required')
            finished = time.monotonic()
            if finished >= deadline:
                raise TimeoutError('Initial Safari session exceeded its 60-second or remaining browser deadline')
            completed_at = finished
            timing['completed'] = True
            return result
        finally:
            finished = completed_at if completed_at is not None else time.monotonic()
            timing['durationMs'] = (finished - started) * 1000
            timing['timedOut'] = completed_at is None and finished >= deadline
            self._session_start_deadline = previous

    def close(self):
        if self.session_id:
            self.request('DELETE', '/session/' + self.session_id)
            self.session_id = None

    def select_current_window(self):
        # Select only the automation session's current window. A normal Safari
        # preparation window is outside this session and must not receive input.
        handle = self.call('WebDriver:GetWindowHandle')
        native.require(isinstance(handle, str) and bool(handle), 'Safari did not return its automation window')
        self.call('WebDriver:SwitchToWindow', {'handle': handle})
        return {'handle': handle, **self.execute('return {documentFocused:document.hasFocus(),visibilityState:document.visibilityState};')}

    def call(self, name, data=None):
        native.require(self.session_id is not None, 'A Safari session is required')
        routes = {
            'WebDriver:Navigate': ('POST', '/url'),
            'WebDriver:SwitchToFrame': ('POST', '/frame'),
            'WebDriver:PerformActions': ('POST', '/actions'),
            'WebDriver:TakeScreenshot': ('GET', '/screenshot'),
            'WebDriver:ExecuteScript': ('POST', '/execute/sync'),
            'WebDriver:ExecuteAsyncScript': ('POST', '/execute/async'),
            'WebDriver:SetTimeouts': ('POST', '/timeouts'),
            'WebDriver:SetWindowRect': ('POST', '/window/rect'),
            'WebDriver:GetWindowHandle': ('GET', '/window'),
            'WebDriver:SwitchToWindow': ('POST', '/window'),
        }
        if name not in routes:
            raise ValueError(f'Unsupported shared WebDriver operation: {name}')
        method, route = routes[name]
        if name in ('WebDriver:ExecuteScript', 'WebDriver:ExecuteAsyncScript'):
            data = {key: data[key] for key in ('script', 'args')}
        value = self.request(method, '/session/' + self.session_id + route, data if method != 'GET' else None)
        # Preserve the shared client's response shape without unwrapping a
        # page-returned object that happens to have a property named "value".
        return {'value': value} if name in ('WebDriver:ExecuteScript', 'WebDriver:ExecuteAsyncScript', 'WebDriver:TakeScreenshot') else value


def fixture_server(name, log):
    env = {**os.environ, 'HOME_STUDIO_FIXTURE_ONLY': '1', 'PYTHON': sys.executable, 'PYTHONUTF8': '1'}
    script = 'test-planner-stability.cjs' if name == 'planner-256' else 'test-browser-stability.cjs'
    if name.startswith('viewer-'):
        env['BROWSER_STABILITY_ROOMS'] = name.split('-')[1]
        env['BROWSER_STABILITY_LIGHTS_PER_ROOM'] = '3'
    server = subprocess.Popen(['node', str(SCRIPTS / script)], cwd=ROOT, env=env,
                              stdout=subprocess.PIPE, stderr=log, text=True, encoding='utf-8')
    lines = queue.Queue()
    def read_lines():
        for line in server.stdout:
            log.write(line)
            log.flush()
            lines.put(line)
    threading.Thread(target=read_lines, daemon=True).start()
    deadline = time.monotonic() + 150
    try:
        while time.monotonic() < deadline:
            native.require(server.poll() is None, f'Fixture exited before startup: {server.returncode}')
            try:
                info = json.loads(lines.get(timeout=.2))
                if info.get('fixtureServer'):
                    with urllib.request.urlopen(info['origin'] + '/fixture.json', timeout=10) as response:
                        return server, info, json.load(response)
            except (queue.Empty, json.JSONDecodeError):
                pass
        raise TimeoutError('Fixture startup exceeded 150 seconds')
    except BaseException:
        native.stop(server)
        raise


def run_case(output, name, driver_path):
    output.mkdir(parents=True, exist_ok=True)
    record = {'schema': 1, 'suite': name, 'status': 'running', 'product': 'Safari',
              'output': str(output.resolve()),
              'sourceRevision': os.environ.get('GITHUB_SHA'), 'samples': [],
              'os': {'platform': sys.platform, 'release': platform.release(), 'machine': platform.machine()},
              'headless': False, 'emulatedMobile': False, 'cleanupErrors': []}
    if name.startswith('viewer-'):
        record['loadBudgetMs'] = native.VIEWER_LOAD_BUDGET_MS
    def save():
        (output / 'report.json').write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
    save()
    server = driver = client = watchdog = None
    started = time.monotonic()
    with contextlib.ExitStack() as resources:
        try:
            native.require(sys.platform == 'darwin', 'Safari acceptance requires a native macOS host')
            record['driverVersion'] = subprocess.check_output([driver_path, '--version'], text=True, timeout=10).strip()
            server, info, project = fixture_server(name, resources.enter_context((output / 'fixture.log').open('w', encoding='utf-8')))
            record['sourceHash'] = info['sourceHash']
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0))
                port = probe.getsockname()[1]
            log = resources.enter_context((output / 'driver.log').open('w', encoding='utf-8'))
            driver = subprocess.Popen([driver_path, '--port', str(port)], stdout=log, stderr=subprocess.STDOUT)
            client = SafariWebDriver(f'http://127.0.0.1:{port}')
            deadline = time.monotonic() + 30
            while True:
                native.require(driver.poll() is None, 'SafariDriver exited before accepting a session')
                try:
                    client.request('GET', '/status')
                    break
                except urllib.error.URLError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError('SafariDriver startup exceeded 30 seconds')
                    time.sleep(.1)
            def expired():
                record['deadlineExceeded'] = True
                native.stop(driver)
            client._browser_deadline = time.monotonic() + 180
            watchdog = threading.Timer(180, expired)
            watchdog.daemon = True
            watchdog.start()
            record['phase'] = 'session-startup'
            record['sessionStartup'] = {'budgetMs': SESSION_START_BUDGET_MS}
            save()
            record['session'] = client.start(record['sessionStartup'])
            record['phase'] = 'session-configuration'
            save()
            client.call('WebDriver:SetTimeouts', {'script': 30000, 'pageLoad': 30000, 'implicit': 0})
            client.call('WebDriver:SetWindowRect', {'width': 1440, 'height': 1000})
            record['windowFocus'] = client.select_current_window()
            save()
            record['userAgent'] = client.execute('return navigator.userAgent;')
            record['phase'] = 'application'
            save()
            (native.planner if name == 'planner-256' else native.viewer)(client, info['origin'], project, record, save)
            client.close()
            record['sessionClosed'] = True
            record['phase'] = 'completed'
            record['status'] = 'passed'
        except Exception as error:
            record.update(status='failed', error=str(error), traceback=traceback.format_exc())
            if client and client.session_id:
                try:
                    record['failureState'] = client.execute('return {path:location.pathname,documentFocused:document.hasFocus(),visibilityState:document.visibilityState,viewer:window.__browserStability||null,planner:window.__plannerStats||null};')
                    client.screenshot(output / 'failure.png')
                except Exception as capture_error:
                    record['captureError'] = str(capture_error)
        finally:
            if watchdog:
                watchdog.cancel()
                watchdog.join(timeout=15)
            for action in (lambda: client.close() if client else None, lambda: native.stop(driver), lambda: native.stop(server)):
                try:
                    action()
                except Exception as error:
                    record['cleanupErrors'].append(str(error))
            if record['cleanupErrors'] or record.get('deadlineExceeded'):
                record['status'] = 'failed'
            record['durationMs'] = round((time.monotonic() - started) * 1000)
            save()
    print(f'Safari {name}: {record["status"]}', flush=True)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--driver', default='/usr/bin/safaridriver')
    parser.add_argument('--prepare-hosted-safari', action='store_true',
                        help='Check a blank WebDriver session on a disposable GitHub-hosted macOS runner')
    args = parser.parse_args()
    preparation = prepare_hosted_safari(args.output.resolve(), args.driver) if args.prepare_hosted_safari else None
    results = []
    if preparation is None or preparation['status'] == 'passed':
        results = [run_case(args.output.resolve() / name, name, args.driver) for name in ('viewer-6', 'viewer-24', 'planner-256')]
    summary = {'product': 'Safari', 'sourceRevision': os.environ.get('GITHUB_SHA'),
               'status': 'passed' if len(results) == 3 and all(r['status'] == 'passed' for r in results) else 'failed',
               'cases': [{'suite': r['suite'], 'status': r['status'], 'durationMs': r['durationMs']} for r in results]}
    if preparation is not None:
        summary['preparation'] = preparation
    (args.output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
    return int(summary['status'] != 'passed')


if __name__ == '__main__':
    sys.exit(main())
