#!/usr/bin/env python3
"""Run real, pinned Waterfox acceptance through its native Marionette protocol.

The stock browser does not implement Playwright's patched Firefox transport.
Each fictional scene gets a new profile; no user browser/profile is touched.
"""
import argparse
import base64
import contextlib
import json
import os
import platform
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def stop(process):
    if process is not None and process.poll() is None:
        if sys.platform == 'win32':
            # A failed browser must not leave content processes holding its profile.
            subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True, timeout=20, check=False)
            process.wait(timeout=10)
            return
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)


def shutdown_browser(client, process, record):
    """Quit the app and release profile databases before directory removal."""
    started = time.monotonic()
    try:
        # Stock Waterfox's own marionette_driver uses this command for in-app
        # shutdown. DeleteSession alone only disconnects automation.
        # https://github.com/BrowserWorks/Waterfox/blob/6.7.6/testing/marionette/client/marionette_driver/marionette.py
        details = client.call('Marionette:Quit')
        record['shutdown'] = details
        client.connection.close()
        require(details.get('cause') == 'shutdown', 'Waterfox did not acknowledge normal application shutdown')
        require(details.get('forced') is False, 'Waterfox had to force application shutdown')
        returncode = process.wait(timeout=15)
        require(returncode == 0, f'Waterfox exited abnormally during shutdown: {returncode}')
    finally:
        record['shutdownMs'] = round((time.monotonic() - started) * 1000)


class Marionette:
    """The version-3 length-prefixed transport used by stock Gecko browsers."""
    def __init__(self, connection):
        self.connection = connection
        self.buffer = b''
        self.sequence = 0
        connection.settimeout(30)
        self.hello = self.receive()
        require(self.hello.get('marionetteProtocol') == 3, 'Expected Marionette protocol 3')

    def receive(self):
        while b':' not in self.buffer:
            self.read()
            require(len(self.buffer) < 64 * 1024 * 1024, 'Oversized Marionette frame')
        length, self.buffer = self.buffer.split(b':', 1)
        length = int(length)
        require(0 <= length <= 64 * 1024 * 1024, 'Invalid Marionette frame length')
        while len(self.buffer) < length:
            self.read()
        body, self.buffer = self.buffer[:length], self.buffer[length:]
        return json.loads(body)

    def read(self):
        chunk = self.connection.recv(65536)
        if not chunk:
            raise ConnectionError('Waterfox closed the Marionette connection')
        self.buffer += chunk

    def call(self, name, data=None):
        self.sequence += 1
        body = json.dumps([0, self.sequence, name, data or {}]).encode('utf-8')
        self.connection.sendall(str(len(body)).encode() + b':' + body)
        response = self.receive()
        require(response[:2] == [1, self.sequence], 'Unexpected Marionette response ID')
        if response[2]:
            raise RuntimeError(json.dumps(response[2]))
        return response[3]

    def execute(self, script, *args):
        value = self.call('WebDriver:ExecuteScript', {'script': script, 'args': list(args), 'newSandbox': False, 'sandbox': None})
        return value.get('value', value) if isinstance(value, dict) else value

    def wait(self, expression, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.execute('return Boolean(' + expression + ');'):
                return
            time.sleep(.05)
        raise TimeoutError('Browser did not satisfy: ' + expression)

    def drag(self, start, end):
        actions = [{'type': 'pointerMove', 'duration': 0, 'x': round(start[0]), 'y': round(start[1]), 'origin': 'viewport'}, {'type': 'pointerDown', 'button': 0}]
        for step in range(1, 13):
            actions.append({'type': 'pointerMove', 'duration': 16, 'x': round(start[0] + (end[0] - start[0]) * step / 12), 'y': round(start[1] + (end[1] - start[1]) * step / 12), 'origin': 'viewport'})
        actions.append({'type': 'pointerUp', 'button': 0})
        started = time.monotonic()
        self.call('WebDriver:PerformActions', {'actions': [{'type': 'pointer', 'id': 'mouse', 'parameters': {'pointerType': 'mouse'}, 'actions': actions}]})
        elapsed = round((time.monotonic() - started) * 1000)
        require(elapsed < 15000, f'Real pointer drag exceeded 15 seconds: {elapsed} ms')
        return elapsed

    def canvas_drag(self, selector):
        points = self.execute('''const canvas=document.querySelector(arguments[0]),r=canvas.getBoundingClientRect();
          for(const y of [.18,.35,.6,.8])for(const x of [.12,.25,.5,.7]) {
            if(document.elementFromPoint(r.x+r.width*x,r.y+r.height*y)===canvas)
              return [[r.x+r.width*x,r.y+r.height*y],[r.x+r.width*(x+.15),r.y+r.height*(y+.1)]];
          } throw Error('No exposed canvas pixel for real pointer drag');''', selector)
        return self.drag(*points)

    def screenshot(self, destination):
        result = self.call('WebDriver:TakeScreenshot', {'id': None, 'highlights': [], 'full': False})
        data = result.get('value', result) if isinstance(result, dict) else result
        destination.write_bytes(base64.b64decode(data))


def assert_graphics(stats):
    require(stats['contexts'] == 1, 'Exactly one real WebGL context must be created')
    require(stats['gpu']['version'].startswith('WebGL 2'), 'A real WebGL2 context is required')
    require(stats['linkedPrograms'] > 0, 'Actual WebGL programs must link')
    require(not stats['shaderErrors'], 'Shader link errors: ' + str(stats['shaderErrors']))
    require(not stats['errors'], 'Browser errors: ' + str(stats['errors']))


def assert_recovered_interaction(before_count, after_count, before_camera, after_camera, stats):
    require(after_count > before_count, 'Recovered pointer input must produce a new frame')
    require(after_camera != before_camera, 'Recovered pointer input must change the camera')
    assert_graphics(stats)


def viewer(client, origin, project, record, save):
    client.call('WebDriver:Navigate', {'url': origin})
    items = project['floors'][0]['items']
    states = {item['entity_id']: {'state': 'on', 'name': item['name'], 'light': {'brightness': 180, 'color_mode': 'color_temp', 'color_temp_kelvin': 3000}} for item in items}
    states['sun.sun'] = {'state': 'above_horizon', 'elevation': 30}
    for cycle in range(2):
        started = time.monotonic()
        client.execute('''const [items,states]=arguments; window.fixtureLoaded=false;
          fetch('/viewer').then(r=>r.text()).then(html=>{const iframe=document.createElement('iframe');
            iframe.id='viewer';iframe.sandbox='allow-scripts allow-downloads allow-forms';
            iframe.style.cssText='width:100%;height:740px;border:0';
            iframe.onload=()=>{const channel=new MessageChannel();window.viewerPort=channel.port1;
              channel.port1.onmessage=e=>{if(e.data.type==='model_config')channel.port1.postMessage({type:'states',connected:true,states});};
              iframe.contentWindow.postMessage({type:'home-floorplan:init',items,preferences:{}},'*',[channel.port2]);window.fixtureLoaded=true;};
            iframe.srcdoc=html;document.body.append(iframe);}); return true;''', items, states)
        client.wait('window.fixtureLoaded')
        client.call('WebDriver:SwitchToFrame', {'id': 0})
        client.wait("window.floorplan?.renderCount>0 && document.querySelector('#homeConnection')?.dataset.connected==='true'")
        sample = {'cycle': cycle, 'loadMs': round((time.monotonic() - started) * 1000)}
        record['samples'].append(sample)
        snapshot = lambda: client.execute('return {...window.__browserStability,renderCount:window.floorplan.renderCount,scene:window.__browserScene()};')
        sample['initial'] = initial = snapshot()
        save()
        require(sample['loadMs'] < 30000, 'Viewer connected draw exceeded 30 seconds')
        assert_graphics(initial)
        require(initial['scene']['pointLights'] == len(items), 'Every fixture light retains a shader slot')
        require(initial['scene']['activePointLights'] == len(items), 'Every on-state fixture light contributes illumination')
        sample['dragMs'] = client.canvas_drag('#homeStage canvas')
        client.wait(f'window.floorplan.renderCount>{initial["renderCount"]}')
        require(snapshot()['scene']['camera'] != initial['scene']['camera'], 'Real pointer drag changes the viewer camera')
        # Send real bridge state updates, including all-off and partial illumination.
        sample['states'] = [{'active': len(items), 'linkedPrograms': initial['linkedPrograms']}]
        for active in (0, max(1, len(items) // 2), len(items)):
            next_states = json.loads(json.dumps(states))
            for index, item in enumerate(items):
                next_states[item['entity_id']]['state'] = 'on' if index < active else 'off'
            client.call('WebDriver:SwitchToFrame', {'id': None})
            client.execute("window.viewerPort.postMessage({type:'states',connected:true,states:arguments[0]});return true;", next_states)
            client.call('WebDriver:SwitchToFrame', {'id': 0})
            client.wait(f'window.__browserScene().activePointLights==={active}')
            value = snapshot()
            require(value['scene']['pointLights'] == len(items), 'State updates retain every light slot')
            sample['states'].append({'active': active, 'linkedPrograms': value['linkedPrograms']})
        require(len({value['linkedPrograms'] for value in sample['states']}) == 1, 'State changes must not compile new shader variants')
        if cycle == 1:
            before = snapshot()['renderCount']
            client.execute("const e=document.querySelector('#homeStage canvas').getContext('webgl2').getExtension('WEBGL_lose_context');if(!e)throw Error('WEBGL_lose_context required');window.restoreTestContext=()=>e.restoreContext();e.loseContext();return true;")
            client.wait('window.__browserStability.contextLosses===1')
            client.execute('for(let i=0;i<40;i++){window.requestModelRender();window.renderModel();}return true;')
            time.sleep(.1)
            require(snapshot()['renderCount'] == before, 'Lost contexts suppress explicit and pending draws')
            client.execute('window.restoreTestContext();return true;')
            client.wait(f'window.floorplan.renderCount>{before}')
            sample['recovery'] = snapshot()
            assert_graphics(sample['recovery'])
            sample['recoveryDragMs'] = client.canvas_drag('#homeStage canvas')
            client.wait(f'window.floorplan.renderCount>{sample["recovery"]["renderCount"]}')
            sample['afterRecoveryDrag'] = after = snapshot()
            assert_recovered_interaction(sample['recovery']['renderCount'], after['renderCount'], sample['recovery']['scene']['camera'], after['scene']['camera'], after)
        sample['final'] = snapshot()
        assert_graphics(sample['final'])
        require(sample['final']['contextLosses'] == cycle, 'No unexpected WebGL context loss')
        save()
        client.call('WebDriver:SwitchToFrame', {'id': None})
        client.screenshot(Path(record['output']) / f'viewer-cycle-{cycle + 1}.png')
        client.execute("window.viewerPort.close();document.querySelector('#viewer').remove();return true;")
        require(client.execute('return document.querySelectorAll("iframe").length===0 && 6*7===42;'), 'Dashboard remains responsive after closing viewer')


def planner(client, origin, project, record, save):
    url = origin + '/planner/?lang=en'
    client.call('WebDriver:Navigate', {'url': url})
    client.wait('window.planner')
    client.execute("localStorage.setItem('home-studio.project.v1',JSON.stringify(arguments[0]));return true;", project)
    started = time.monotonic()
    client.call('WebDriver:Navigate', {'url': url})
    client.wait('window.planner')
    sample = {'loadMs': round((time.monotonic() - started) * 1000)}
    record['samples'].append(sample)
    require(sample['loadMs'] < 30000, 'Planner load exceeded 30 seconds')
    require(client.execute('return window.planner.getProject().floors.reduce((n,f)=>n+f.items.length,0);') == 256, 'All 256 furniture items load')
    points = client.execute("const c=document.querySelector('#plan-canvas').getBoundingClientRect();return [[1,1],[1.5,1]].map(p=>window.planner.worldToScreen(p).map((v,i)=>v+(i?c.y:c.x)));")
    sample['itemDragMs'] = client.drag(*points)
    require(sample['itemDragMs'] < 10000, 'Planner furniture drag exceeded 10 seconds')
    require(client.execute('return window.planner.getProject().floors[0].items[0].position_m.x;') == 1.5, 'Real pointer input moves the intended furniture')
    started = time.monotonic()
    client.execute("document.querySelector('#preview-tab').click();document.querySelector('#all-floors').click();return true;")
    client.wait('window.planner.getPreviewMetadata().items===256 && window.planner.getPreviewMetadata().renderCount>0')
    sample['previewLoadMs'] = round((time.monotonic() - started) * 1000)
    snapshot = lambda: client.execute('return {stats:window.__plannerStats,preview:window.planner.getPreviewMetadata(),scene:window.__plannerScene()};')
    sample['initial'] = initial = snapshot()
    save()
    require(sample['previewLoadMs'] < 30000, 'Planner preview exceeded 30 seconds')
    assert_graphics(initial['stats'])
    require(initial['preview']['catalogItems'] == 256, 'The preview includes all catalog furniture')
    sample['orbitMs'] = client.canvas_drag('#preview-canvas')
    require(sample['orbitMs'] < 10000, 'Planner orbit exceeded 10 seconds')
    require(snapshot()['scene']['orbit'] != initial['scene']['orbit'], 'Real pointer input changes the preview orbit')
    saved = client.execute('return window.planner.getProject();')
    before = snapshot()['preview']['renderCount']
    client.execute("const e=document.querySelector('#preview-canvas').getContext('webgl2').getExtension('WEBGL_lose_context');if(!e)throw Error('WEBGL_lose_context required');window.restoreTestContext=()=>e.restoreContext();e.loseContext();return true;")
    client.wait('window.__plannerStats.contextLosses===1')
    time.sleep(.1)
    require(snapshot()['preview']['renderCount'] == before, 'A lost context suppresses preview draws')
    client.execute('window.restoreTestContext();return true;')
    client.wait(f'window.planner.getPreviewMetadata().renderCount>{before}')
    sample['recovery'] = snapshot()
    assert_graphics(sample['recovery']['stats'])
    require(client.execute('return window.planner.getProject();') == saved, 'Graphics recovery preserves edited furniture')
    sample['recoveryOrbitMs'] = client.canvas_drag('#preview-canvas')
    require(sample['recoveryOrbitMs'] < 10000, 'Recovered planner orbit exceeded 10 seconds')
    client.wait(f'window.planner.getPreviewMetadata().renderCount>{sample["recovery"]["preview"]["renderCount"]}')
    sample['afterRecoveryOrbit'] = after = snapshot()
    assert_recovered_interaction(sample['recovery']['preview']['renderCount'], after['preview']['renderCount'], sample['recovery']['scene']['orbit'], after['scene']['orbit'], after['stats'])
    save()
    client.screenshot(Path(record['output']) / 'planner-recovered.png')
    client.call('WebDriver:Navigate', {'url': url})
    client.wait('window.planner')
    require(client.execute('return window.planner.getProject();') == saved, 'Reopening the planner restores its edited draft')


def run_case(installation, output, name, headless):
    output.mkdir(parents=True, exist_ok=True)
    record = {'schema': 1, 'suite': name, 'status': 'running', 'installation': installation,
              'sourceRevision': os.environ.get('GITHUB_SHA'),
              'os': {'platform': sys.platform, 'release': platform.release(), 'machine': platform.machine()},
              'pythonVersion': platform.python_version(), 'headless': headless,
              'output': str(output), 'samples': []}
    def save():
        (output / 'report.json').write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
    save()
    server = browser = client = watchdog = None
    resources = contextlib.ExitStack()
    started = time.monotonic()
    try:
        directory = resources.enter_context(tempfile.TemporaryDirectory(prefix='home-studio-waterfox-'))
        browser_log = resources.enter_context((output / 'browser.log').open('w', encoding='utf-8'))
        fixture_log = resources.enter_context((output / 'fixture.log').open('w', encoding='utf-8'))
        scratch = Path(directory)
        profile = scratch / 'profile'
        profile.mkdir()
        env = {**os.environ, 'HOME_STUDIO_FIXTURE_ONLY': '1', 'PYTHON': sys.executable, 'PYTHONUTF8': '1', 'MOZ_CRASHREPORTER_DISABLE': '1', 'TMPDIR': str(scratch), 'TEMP': str(scratch), 'TMP': str(scratch)}
        script = 'test-planner-stability.cjs' if name == 'planner-256' else 'test-browser-stability.cjs'
        if name.startswith('viewer-'):
            env['BROWSER_STABILITY_ROOMS'] = name.split('-')[1]
            env['BROWSER_STABILITY_LIGHTS_PER_ROOM'] = '3'
        server = subprocess.Popen(['node', str(ROOT / 'scripts' / script)], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=fixture_log, text=True, encoding='utf-8')
        lines = queue.Queue()
        def read_server():
            for line in server.stdout:
                fixture_log.write(line)
                fixture_log.flush()
                lines.put(line)
        threading.Thread(target=read_server, daemon=True).start()
        deadline = time.monotonic() + 150
        info = None
        while time.monotonic() < deadline:
            if server.poll() is not None:
                raise RuntimeError(f'Fixture server exited {server.returncode}')
            try:
                line = lines.get(timeout=.2)
                candidate = json.loads(line)
                if candidate.get('fixtureServer'):
                    info = candidate
                    break
            except (queue.Empty, json.JSONDecodeError):
                pass
        require(info is not None, 'Fixture server startup timed out')
        record['sourceHash'] = info['sourceHash']
        with urllib.request.urlopen(info['origin'] + '/fixture.json', timeout=10) as response:
            project = json.load(response)
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        prefs = {'marionette.port': port, 'browser.shell.checkDefaultBrowser': False, 'browser.aboutwelcome.enabled': False, 'browser.startup.homepage': 'about:blank', 'browser.startup.homepage_override.mstone': 'ignore', 'browser.startup.firstrunSkipsHomepage': True, 'browser.migrate.automigrate.enabled': False, 'app.update.auto': False, 'app.update.enabled': False, 'webgl.force-enabled': True, 'webgl.forbid-software': False}
        record['preferences'] = prefs
        (profile / 'user.js').write_text('\n'.join(f'user_pref({json.dumps(key)},{json.dumps(value)});' for key, value in prefs.items()), encoding='utf-8')
        command = [installation['binary'], '--no-remote', '--profile', str(profile), '--marionette', 'about:blank']
        if headless:
            command.insert(1, '--headless')
        browser = subprocess.Popen(command, stdout=browser_log, stderr=subprocess.STDOUT, env=env)
        def deadline_exceeded():
            record['deadlineExceeded'] = True
            stop(browser)
        watchdog = threading.Timer(180, deadline_exceeded)
        watchdog.daemon = True
        watchdog.start()
        deadline = time.monotonic() + 45
        connection = None
        while time.monotonic() < deadline:
            require(browser.poll() is None, f'Waterfox exited before connecting: {browser.returncode}')
            try:
                connection = socket.create_connection(('127.0.0.1', port), timeout=.2)
                break
            except OSError:
                time.sleep(.1)
        require(connection is not None, 'Waterfox Marionette startup timed out')
        client = Marionette(connection)
        record['protocol'] = client.hello
        record['session'] = session = client.call('WebDriver:NewSession', {'capabilities': {}})
        capabilities = session.get('capabilities', session)
        require(capabilities['browserName'].lower() == 'waterfox', 'The loaded browser must identify itself as Waterfox')
        app = installation['metadata']['application.ini']['App']
        require(capabilities['browserVersion'] == app['Version'], 'Loaded Gecko version must match the verified package')
        require(capabilities['moz:buildID'] == app['BuildID'], 'Loaded browser build must match the verified package')
        client.call('WebDriver:SetTimeouts', {'script': 30000, 'pageLoad': 30000, 'implicit': 0})
        client.call('WebDriver:SetWindowRect', {'width': 1440, 'height': 1000})
        record['userAgent'] = client.execute('return navigator.userAgent;')
        save()
        (planner if name == 'planner-256' else viewer)(client, info['origin'], project, record, save)
        shutdown_browser(client, browser, record)
        client = None
        record['status'] = 'passed'
        stop(server)
    except Exception as error:
        record['status'] = 'failed'
        record['error'] = str(error)
        record['traceback'] = traceback.format_exc()
        if client:
            try:
                record['failureState'] = client.execute('return {url:location.href,viewer:window.__browserStability||null,planner:window.__plannerStats||null};')
                client.screenshot(output / 'failure.png')
            except Exception as capture_error:
                record['screenshotError'] = str(capture_error)
    finally:
        cleanup_errors = []
        if watchdog:
            watchdog.cancel()
            watchdog.join(timeout=35)
        if client:
            try:
                client.connection.close()
            except Exception as error:
                cleanup_errors.append(str(error))
        for action in (lambda: stop(browser), lambda: stop(server), resources.close):
            try:
                action()
            except Exception as error:
                cleanup_errors.append(str(error))
        if cleanup_errors:
            record['cleanupErrors'] = cleanup_errors
            record['status'] = 'failed'
        if record.get('deadlineExceeded'):
            record['status'] = 'failed'
            record.setdefault('error', 'The 180-second browser deadline expired')
        record['durationMs'] = round((time.monotonic() - started) * 1000)
        save()

    print(f'{name}: {record["status"]}', flush=True)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--installation', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--headless', action='store_true')
    args = parser.parse_args()
    installation = json.loads(args.installation.read_text(encoding='utf-8'))
    manifest = json.loads((ROOT / 'scripts/waterfox-versions.json').read_text(encoding='utf-8'))
    require(installation['source'] == manifest['versions'][installation['release']][installation['platform']], 'Installation receipt must match a pinned release')
    if sys.platform == 'darwin':
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(Path(installation['binary']).parents[2])], check=True, timeout=60)
    results = [run_case(installation, args.output.resolve() / name, name, args.headless) for name in ('viewer-6', 'viewer-24', 'planner-256')]
    summary = {'installation': installation, 'sourceRevision': os.environ.get('GITHUB_SHA'),
               'status': 'passed' if all(result['status'] == 'passed' for result in results) else 'failed',
               'cases': [{'suite': result['suite'], 'status': result['status'], 'durationMs': result['durationMs']} for result in results]}
    (args.output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
    return 0 if summary['status'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())
