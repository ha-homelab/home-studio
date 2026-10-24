#!/usr/bin/env python3
"""Run real, pinned Firefox or Waterfox acceptance through its native Marionette protocol.

The stock browser does not implement Playwright's patched Firefox transport.
Each fictional scene gets a new profile; no user browser/profile is touched.
"""
import argparse
import base64
import contextlib
import json
import math
import re
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

from native_browser import PRODUCTS, validate_installation, validate_metadata

ROOT = Path(__file__).resolve().parents[1]

# Exact pinned RawShaderMaterial submission, independently expanded in the CPU
# observer test. Unknown prefixes receive no first-motion exception.
COPY_VERTEX = 'precision highp float;attribute vec3 position;void main(){gl_Position=vec4(position,1.0);}'
COPY_FRAGMENT = 'precision highp float;uniform sampler2D source;uniform vec2 outputSize;void main(){vec2 sampleUV=(floor(gl_FragCoord.xy)+vec2(0.5))/outputSize;gl_FragColor=texture2D(source,sampleUV);}'
COPY_PREFIX = '#define SHADER_TYPE RawShaderMaterial\n#define SHADER_NAME \n'
COPY_SOURCES = {'vertex': COPY_PREFIX + COPY_VERTEX, 'fragment': COPY_PREFIX + COPY_FRAGMENT,
                'rawVertex': COPY_VERTEX, 'rawFragment': COPY_FRAGMENT}
NATIVE_VIEWER_PROGRAM_DIAGNOSTICS = ('(' + (ROOT / 'scripts/native-viewer-program-diagnostics.js').read_text(encoding='utf-8') + ')(' + json.dumps(COPY_SOURCES) + ');')


# Installed before WebGL creation. Read the real GL error flag only at snapshots,
# context loss and teardown; never issue synchronous GPU queries for each draw.
NATIVE_GL_DIAGNOSTICS = r"""
(() => {
  const contexts = [], seen = new WeakSet(), extensions = new WeakSet();
  const evidence = {contexts: 0, samples: [], errors: [], lossRequests: []};
  const remember = (code, label) => { if (code !== 0) evidence.errors.push({code, label}); };
  const sample = window.__sampleNativeGraphics = label => {
    const states = contexts.map(({id, canvas, gl, read}) => {
      const lost = gl.isContextLost();
      if (!lost) {
        for (let n = 0; n < 32; n++) {
          const code = read();
          if (code === gl.NO_ERROR) break;
          remember(code, label);
          if (n === 31) throw Error('WebGL error queue did not drain');
        }
      }
      return {id, attached:canvas.isConnected === true, lost};
    });
    evidence.samples.push({label, states});
    return JSON.parse(JSON.stringify(evidence));
  };
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (...args) {
    const gl = original.apply(this, args);
    if (!gl || !String(args[0]).startsWith('webgl') || seen.has(gl)) return gl;
    seen.add(gl); evidence.contexts++; const read = gl.getError.bind(gl);
    const tracked = {id:evidence.contexts, canvas:this, gl, read};
    contexts.push(tracked);
    window.__nativeTrackViewerContext?.(gl, this);
    gl.getError = () => { const code = read(); if (!gl.isContextLost()) remember(code, 'application-getError'); return code; };
    const getExtension = gl.getExtension.bind(gl);
    gl.getExtension = name => {
      const extension = getExtension(name);
      if (String(name).toLowerCase() === 'webgl_lose_context' && extension && !extensions.has(extension)) {
        extensions.add(extension); const lose = extension.loseContext.bind(extension);
        // forceContextLoss at teardown clears GL errors. Preserve them first.
        extension.loseContext = () => {
          sample('before-context-loss');
          evidence.lossRequests.push({contextId:tracked.id, attached:tracked.canvas.isConnected === true});
          return lose();
        };
      }
      return extension;
    };
    return gl;
  };
  const arm = () => window.addEventListener('pagehide', () => {
    const value = sample('pagehide');
    const stats = window.__plannerStats || window.__browserStability;
    value.application = stats ? {errors:stats.errors, shaderErrors:stats.shaderErrors, contexts:stats.contexts,
      contextLosses:stats.contextLosses, retiredContextLosses:stats.retiredContextLosses,
      contextLossRequests:stats.contextLossRequests, contextEvents:stats.contextEvents, restoredBuffers:stats.restoredBuffers,
      contextStates:window.__plannerContextStates?.()} : null;
    if (parent !== window) parent.postMessage({type:'native-gl-teardown', token:window.__nativeGraphicsToken, evidence:value}, '*');
    else sessionStorage.setItem('home-studio.native-gl-teardown', JSON.stringify(value));
  });
  // The cleanup listener must run after the application's own pagehide handler.
  if (document.readyState === 'complete') arm(); else window.addEventListener('load', arm, {once:true});
})();
"""


NATIVE_VIEWER_FRAME_DIAGNOSTICS = r"""
if (renderer) {
  window.__nativeViewerPrograms.attachRenderer(renderer);
  const nativeRender = renderer.render.bind(renderer);
  renderer.render = (scene, camera) => {
    const result = nativeRender(scene, camera);
    if (scene?.name !== 'interaction-copy') window.__nativeRenderedLights = window.__browserScene().activePointLights;
    return result;
  };
}
"""


def assert_native_graphics(evidence, teardown=False, replacement=False):
    require(isinstance(evidence, dict) and evidence.get('contexts') == (2 if replacement else 1), 'Native GL diagnostics must observe the expected real contexts')
    require(bool(evidence.get('samples')), 'Native GL diagnostics must sample the actual error queue')
    require(isinstance(evidence.get('errors'), list), 'Native GL diagnostics must contain an error list')
    require(not evidence['errors'], 'Actual WebGL errors: ' + str(evidence['errors']))
    if replacement:
        states = evidence['samples'][-1].get('states')
        require(isinstance(states, list) and len(states) == 2, 'Native GL diagnostics must retain both context states')
        require(states[0] == {'id':1, 'attached':False, 'lost':True}, 'The retired native context must remain detached and lost')
        require(states[1].get('id') == 2 and states[1].get('attached') is True, 'Exactly one replacement native context must remain attached')
        require(isinstance(states[1].get('lost'), bool) and (teardown or states[1]['lost'] is False), 'The replacement native context must remain live before teardown')
        requests = [{'contextId':1, 'attached':True}, {'contextId':1, 'attached':False}]
        if teardown:
            requests.append({'contextId':2, 'attached':True})
        require(evidence.get('lossRequests') == requests, 'Native context loss requests must match deliberate loss, retirement and final teardown')
    if teardown:
        require(evidence['samples'][-1].get('label') == 'pagehide', 'Actual navigation/teardown must finish before checking GL errors')
        application = evidence.get('application')
        require(isinstance(application, dict), 'Teardown must retain application error evidence')
        require(isinstance(application.get('errors'), list), 'Teardown must retain browser errors')
        require(isinstance(application.get('shaderErrors'), list), 'Teardown must retain shader errors')
        require(not application['errors'], 'Browser errors during teardown: ' + str(application['errors']))
        require(not application['shaderErrors'], 'Shader errors during teardown: ' + str(application['shaderErrors']))
        if replacement:
            assert_replacement_lifecycle(application, teardown=True)
        # Planner teardown must match its final explicit loss request even when
        # the asynchronous loss event has not arrived before pagehide completes.


def update_viewer_state(client, states, active):
    before = client.execute('return window.floorplan.renderCount;')
    client.call('WebDriver:SwitchToFrame', {'id': None})
    client.execute("window.viewerPort.postMessage({type:'states',connected:true,states:arguments[0]});return true;", states)
    client.call('WebDriver:SwitchToFrame', {'id': 0})
    client.wait(f'window.__nativeRenderedLights==={active} && window.floorplan.renderCount>{before}')


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
        require(details.get('cause') == 'shutdown', 'Browser did not acknowledge normal application shutdown')
        require(details.get('forced') is False, 'Browser had to force application shutdown')
        returncode = process.wait(timeout=15)
        require(returncode == 0, f'Browser exited abnormally during shutdown: {returncode}')
    finally:
        record['shutdownMs'] = round((time.monotonic() - started) * 1000)


VIEWER_LOAD_BUDGET_MS = 60000


class ViewerLoadDeadline:
    """One monotonic deadline for creation through the first connected lit frame."""
    def __init__(self, client, sample):
        self.client, self.sample = client, sample
        self.completed_at = None
        self.started = time.monotonic()
        self.deadline = self.started + VIEWER_LOAD_BUDGET_MS / 1000
        outer = client.__dict__.get('_browser_deadline')
        if outer is not None:
            self.deadline = min(self.deadline, outer)
        sample.update(loadBudgetMs=VIEWER_LOAD_BUDGET_MS, loadMs=None, loadCompleted=False)

    def remaining(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            self.sample['loadTimedOut'] = True
            raise TimeoutError('Viewer cold load exceeded its 60-second or remaining browser deadline')
        return remaining

    def run(self, operation):
        self.remaining()
        result = operation()
        self.remaining()  # A blocked call returning true after expiry is still late.
        return result

    def wait(self, expression):
        return self.run(lambda: self.client.wait(expression, timeout=self.remaining()))

    def complete(self):
        completed = time.monotonic()
        self.remaining()
        self.completed_at = completed
        self.sample['loadCompleted'] = True


@contextlib.contextmanager
def viewer_load_scope(client, sample):
    load = ViewerLoadDeadline(client, sample)
    previous = client.__dict__.get('_cold_load_deadline')
    client._cold_load_deadline = load.deadline
    try:
        load.run(lambda: client.call('WebDriver:SetTimeouts', {'script': max(1, math.floor(load.remaining() * 1000))}))
        yield load
    finally:
        if load.completed_at is None and time.monotonic() >= load.deadline:
            sample['loadTimedOut'] = True
        sample['loadMs'] = math.floor(((load.completed_at if load.completed_at is not None else time.monotonic()) - load.started) * 1000000) / 1000
        client._cold_load_deadline = previous
        failed = sys.exc_info()[0] is not None
        try:
            client.call('WebDriver:SetTimeouts', {'script': 30000})
        except Exception:
            if not failed:
                raise  # Restore errors cannot hide the original cold-load failure.


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

    def command_timeout(self):
        deadline = self.__dict__.get('_cold_load_deadline')
        if deadline is None:
            return 30
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Viewer cold load exhausted its remaining deadline')
        return remaining

    def read(self):
        if self.__dict__.get('_cold_load_deadline') is not None:
            self.connection.settimeout(self.command_timeout())
        chunk = self.connection.recv(65536)
        if not chunk:
            raise ConnectionError('Browser closed the Marionette connection')
        self.buffer += chunk

    def call(self, name, data=None):
        self.sequence += 1
        body = json.dumps([0, self.sequence, name, data or {}]).encode('utf-8')
        scoped = self.__dict__.get('_cold_load_deadline') is not None
        previous = self.connection.gettimeout() if scoped else None
        try:
            if scoped:
                self.connection.settimeout(self.command_timeout())
            self.connection.sendall(str(len(body)).encode() + b':' + body)
            response = self.receive()
        finally:
            if scoped:
                self.connection.settimeout(previous)
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

    def drag(self, start, end, *, diagnostics=None, snapshot=None):
        actions = [{'type': 'pointerMove', 'duration': 0, 'x': round(start[0]), 'y': round(start[1]), 'origin': 'viewport'}, {'type': 'pointerDown', 'button': 0}]
        for step in range(1, 13):
            actions.append({'type': 'pointerMove', 'duration': 16, 'x': round(start[0] + (end[0] - start[0]) * step / 12), 'y': round(start[1] + (end[1] - start[1]) * step / 12), 'origin': 'viewport'})
        actions.append({'type': 'pointerUp', 'button': 0})
        started = time.monotonic()
        self.call('WebDriver:PerformActions', {'actions': [{'type': 'pointer', 'id': 'mouse', 'parameters': {'pointerType': 'mouse'}, 'actions': actions}]})
        actions_finished = time.monotonic()
        # A driver can acknowledge pointer actions before the requested scene
        # draw. Match the Playwright path: include two animation frames in the
        # interaction budget instead of reporting only input-delivery latency.
        self.call('WebDriver:ExecuteAsyncScript', {
            'script': 'const done=arguments[arguments.length-1];requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)));',
            'args': [], 'newSandbox': False, 'sandbox': None})
        settled = time.monotonic()
        elapsed = round((settled - started) * 1000)
        if diagnostics is not None:
            diagnostics.update(performActionsMs=round((actions_finished - started) * 1000),
                               settleFramesMs=round((settled - actions_finished) * 1000), totalMs=elapsed, limitMs=15000)
            # Preserve the failed gesture before the assertion skips the caller's
            # ordinary afterDrag snapshot. Diagnostic work is outside its budget.
            if elapsed >= 15000 and snapshot is not None:
                try:
                    diagnostics['afterDrag'] = snapshot()
                except Exception as error:
                    diagnostics['snapshotError'] = str(error)
        require(elapsed < 15000, f'Real pointer drag exceeded 15 seconds: {elapsed} ms')
        return elapsed

    def canvas_drag(self, selector, *, diagnostics=None, snapshot=None):
        points = self.execute('''const canvas=document.querySelector(arguments[0]),r=canvas.getBoundingClientRect();
          for(const y of [.18,.35,.6,.8])for(const x of [.12,.25,.5,.7]) {
            if(document.elementFromPoint(r.x+r.width*x,r.y+r.height*y)===canvas)
              return [[r.x+r.width*x,r.y+r.height*y],[r.x+r.width*(x+.15),r.y+r.height*(y+.1)]];
          } throw Error('No exposed canvas pixel for real pointer drag');''', selector)
        return self.drag(*points, diagnostics=diagnostics, snapshot=snapshot)

    def screenshot(self, destination):
        result = self.call('WebDriver:TakeScreenshot', {'id': None, 'highlights': [], 'full': False})
        data = result.get('value', result) if isinstance(result, dict) else result
        destination.write_bytes(base64.b64decode(data))


def assert_replacement_lifecycle(stats, teardown=False):
    require(stats.get('contexts') == 2, 'Planner recovery must create exactly one replacement context')
    require(stats.get('retiredContextLosses') == 1, 'Planner recovery must retire exactly the original context')
    restored = stats.get('restoredBuffers')
    require(isinstance(restored, list) and len(restored) == 1, 'The original context must restore exactly once before retirement')
    require(restored[0].get('contextId') == 1 and restored[0].get('lost') is False, 'The restored buffer must belong to the original live context')
    require(restored[0].get('canvas') == [0, 0], 'The retired canvas must release its backing size before restoration')
    buffer = restored[0].get('drawingBuffer')
    require(isinstance(buffer, list) and len(buffer) == 2 and all(type(n) is int and 0 <= n <= 1 for n in buffer),
            'The retired native drawing buffer must be at most one pixel per dimension')
    requests = stats.get('contextLossRequests')
    require(isinstance(requests, list) and len(requests) == (3 if teardown else 2), 'Planner recovery must retain every explicit context loss request')
    for index, request in enumerate(requests):
        expected = {'id':index + 1, 'contextId':2 if index == 2 else 1,
                    'attached':index != 1, 'retirement':index == 1}
        require(all(request.get(key) == value for key, value in expected.items()), 'Planner context loss requests must identify the active and retired canvases')
        require(isinstance(request.get('matched'), bool), 'Every context loss request must record whether its event arrived')
        require(index == 2 or request['matched'], 'Deliberate loss and retirement requests must match actual loss events')
    losses = [event for event in stats.get('contextEvents', []) if event.get('type') == 'webglcontextlost']
    matched = [request for request in requests if request['matched']]
    require(len(losses) == len(matched) == stats.get('contextLosses'), 'Every raw context loss must match one explicit request')
    for event, request in zip(losses, matched):
        require(event.get('contextId') == request['contextId'] and event.get('lossRequest') == request['id']
                and event.get('retired') is request['retirement'], 'Unexpected context loss cannot count as intentional retirement')
    states = stats.get('contextStates')
    require(isinstance(states, list) and len(states) == 2, 'Planner recovery must retain both native context identities')
    require(states[0] == {'id':1, 'attached':False, 'lost':True, 'restores':1}, 'The original context must remain retired after its single restoration')
    require(states[1].get('id') == 2 and states[1].get('attached') is True and states[1].get('restores') == 0,
            'Only the replacement context may remain attached')
    require(isinstance(states[1].get('lost'), bool) and (teardown or states[1]['lost'] is False), 'The replacement context cannot be lost before teardown')


def assert_graphics(stats, replacement=False):
    require(stats['contexts'] == (2 if replacement else 1), 'The expected number of real WebGL contexts must be created')
    require(stats['gpu']['version'].startswith('WebGL 2'), 'A real WebGL2 context is required')
    require(stats['linkedPrograms'] > 0, 'Actual WebGL programs must link')
    require(not stats['shaderErrors'], 'Shader link errors: ' + str(stats['shaderErrors']))
    require(not stats['errors'], 'Browser errors: ' + str(stats['errors']))
    assert_native_graphics(stats.get('nativeGraphics'), replacement=replacement)
    if replacement:
        assert_replacement_lifecycle(stats)


def assert_recovered_graphics(stats, replacement=False):
    assert_graphics(stats, replacement=replacement)
    if not replacement:
        require(stats.get('contextLosses') == 1, 'Recovery must have exactly the one deliberate context loss')


def assert_restored_viewer_mode(before_count, value, mode, expected_lights):
    require(mode in ('editor-cutaway', 'editor-full', 'home'), 'Known restored viewer mode required')
    assert_recovered_graphics(value)
    require(value['nativeGraphics']['samples'][-1].get('states') == [{'id':1, 'attached':True, 'lost':False}],
            'Mode changes keep the original restored context attached and live')
    require(value['renderCount'] > before_count, 'Every restored mode must complete a new frame')
    require(value['homeMode'] is (mode == 'home'), 'The requested restored mode is active')
    if mode != 'home':
        require(value['cutaway'] is (mode == 'editor-cutaway'), 'The requested wall height is active')
    require(value['scene']['pointLights'] == expected_lights, 'Restored modes retain every light slot')
    if mode == 'home':
        require(value['scene']['activePointLights'] == expected_lights, 'Restored Home retains every on-state light')
        require(value['renderedLights'] == expected_lights, 'Restored Home draws the current light state')
    assert_full_viewer_frame(value['scene'])


def post_restore_viewer_modes(client, sample, snapshot, save, expected_lights):
    sample['postRestoreViews'] = []
    origin = time.monotonic()
    for mode in ('editor-cutaway', 'editor-full', 'home'):
        before = snapshot()['renderCount']
        started = time.monotonic()
        transition = {'mode': mode, 'startedMs': round((started-origin)*1000, 3), 'durationMs': None}
        sample['postRestoreViews'].append(transition)
        save()
        try:
            client.execute("""const mode=arguments[0];
              if(mode==='home')document.querySelector('#openHome').click();
              else{if(window.floorplan.homeMode)document.querySelector('#editLayout').click();
                const cutaway=document.querySelector('#cutaway');cutaway.checked=mode==='editor-cutaway';
                cutaway.dispatchEvent(new Event('change'));}return true;""", mode)
            client.wait(f"window.floorplan.renderCount>{before} && window.floorplan.homeMode==={'true' if mode == 'home' else 'false'}")
            value = snapshot()
            value.update(client.execute("return {homeMode:window.floorplan.homeMode,cutaway:document.querySelector('#cutaway').checked};"))
            transition['snapshot'] = value
            save()
            assert_restored_viewer_mode(before, value, mode, expected_lights)
        finally:
            transition['durationMs'] = round((time.monotonic()-started)*1000, 3)
            save()


def assert_recovered_interaction(before_count, after_count, before_camera, after_camera, stats, replacement=False):
    require(after_count > before_count, 'Recovered pointer input must produce a new frame')
    require(after_camera != before_camera, 'Recovered pointer input must change the camera')
    assert_recovered_graphics(stats, replacement=replacement)


def assert_full_viewer_frame(scene):
    passes = scene.get('renderPasses', {})
    require(passes.get('last') == 'scene', 'Pointer release must finish with a full scene draw')
    require(passes.get('sceneViewport') == [0, 0, *scene['drawingBuffer']],
            'Pointer release must restore the original drawing-buffer resolution')


def assert_viewer_interaction(before, after):
    scene = after['scene']
    assert_full_viewer_frame(scene)
    passes = scene['renderPasses']
    renderer = after['gpu'].get('unmaskedRenderer') or after['gpu']['renderer']
    probe = scene.get('rasterProbe') or {}
    diffuse = bool(re.fullmatch('Apple Software Renderer', renderer, re.I)) or (renderer == 'Apple M1, or similar' and probe.get('status') == 'measured' and probe.get('bestMs', 0) >= 15)
    reduced = diffuse or bool(re.search(r'swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render|lavapipe', renderer, re.I))
    if reduced:
        require(passes['copy'] > before['scene']['renderPasses']['copy'], 'The real software-viewer gesture must execute a copy pass')
        require(passes['motionDrawCalls'] == passes['motionSceneDrawCalls'] + 1, 'The copy draw must remain in actual renderer draw-call counts')
        motion = passes.get('motionSceneViewport')
        require(isinstance(motion, list) and len(motion) == 4 and motion[:2] == [0, 0] and motion[2] > 0 and motion[3] > 0 and motion[2] * motion[3] <= (31250 if diffuse else 62500), 'Motion scene pixels must respect the bounded copy budget')
        require(passes.get('copyViewport') == [0, 0, *passes['motionBuffer']], 'The copy pass must cover its unchanged full drawing buffer')
        require(motion[2] <= passes['motionBuffer'][0] and motion[3] <= passes['motionBuffer'][1], 'The scene copy cannot read outside its framebuffer')
    else:
        require(passes['copy'] == 0, 'Other graphics profiles must retain direct rendering')


def viewer_program_links(stats):
    ledger = stats.get('programLedger')
    require(isinstance(ledger, dict) and ledger.get('errors') == [], 'Complete native program ledger required')
    contexts = ledger.get('contexts')
    require(isinstance(contexts, list) and len(contexts) == 1, 'Exactly one viewer program context required')
    context = contexts[0]
    require(context.get('id') == 1 and isinstance(context.get('epoch'), int), 'Viewer program context identity required')
    links = context.get('links')
    require(isinstance(links, list) and 0 < len(links) <= 128 and len(links) == stats['linkedPrograms'],
            'Every native link call must remain in the bounded ledger')
    require(all(link.get('ordinal') == index + 1 for index, link in enumerate(links)), 'Program link order must be complete')
    return context, links


def assert_first_motion_programs(before, after):
    old_context, old = viewer_program_links(before)
    new_context, new = viewer_program_links(after)
    require(old_context['epoch'] == new_context['epoch'], 'First motion must remain in the same context epoch')
    # Draw counters may advance; link identities and submitted source do not.
    identity = lambda link: {key: value for key, value in link.items() if key not in ('copyDraws', 'outsideCopyDraw')}
    require([identity(link) for link in new[:len(old)]] == [identity(link) for link in old], 'Prior program link identities must be retained')
    added = new[len(old):]
    require(len(new) >= len(old) and len(added) <= 1, 'First motion may initialize at most one exact copy program')
    if not added:
        return
    copy = added[0]
    passes_before, passes_after = before['scene']['renderPasses'], after['scene']['renderPasses']
    renderer = after['gpu'].get('unmaskedRenderer') or after['gpu']['renderer']
    probe = after['scene'].get('rasterProbe') or {}
    diffuse = bool(re.fullmatch('Apple Software Renderer', renderer, re.I)) or (renderer == 'Apple M1, or similar' and probe.get('status') == 'measured' and probe.get('bestMs', 0) >= 15)
    reduced = diffuse or bool(re.search(r'swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render|lavapipe', renderer, re.I))
    require(reduced and passes_after['copy'] > passes_before['copy'] and not any(link.get('copyDraws', 0) > 0 for link in old if link.get('epoch') == new_context['epoch']), 'Only the first real software copy gesture may initialize its program')
    require(copy.get('epoch') == new_context['epoch'] and copy.get('program') not in {link['program'] for link in old}, 'Deferred copy must be one new current-context program, not a relink')
    require(copy.get('exactCopy') is True and copy.get('sources') == COPY_SOURCES, 'Only the exact pinned copy shader pair may initialize during first motion')
    require(copy.get('copyDraws', 0) > 0 and copy.get('outsideCopyDraw') is False, 'Deferred copy program must actually draw only in the copy pass')


def assert_state_programs(before, after):
    old_context, old = viewer_program_links(before)
    new_context, new = viewer_program_links(after)
    require(old_context['epoch'] == new_context['epoch'] and before['linkedPrograms'] == after['linkedPrograms'],
            'Each light state change must not link or relink any shader program')
    identity = lambda link: {key: value for key, value in link.items() if key not in ('copyDraws', 'outsideCopyDraw')}
    require([identity(link) for link in old] == [identity(link) for link in new], 'State changes must retain every exact program link identity')


def viewer(client, origin, project, record, save):
    record['loadBudgetMs'] = VIEWER_LOAD_BUDGET_MS
    client.call('WebDriver:Navigate', {'url': origin})
    client.execute('''window.addEventListener('message', event => {
      if (event.data?.type === 'native-gl-teardown' && event.data.token === window.nativeGraphicsToken) window.nativeTeardown = event.data.evidence;
    });return true;''')
    items = project['floors'][0]['items']
    states = {item['entity_id']: {'state': 'on', 'name': item['name'], 'light': {'brightness': 180, 'color_mode': 'color_temp', 'color_temp_kelvin': 3000}} for item in items}
    states['sun.sun'] = {'state': 'above_horizon', 'elevation': 30}
    for cycle in range(2):
        sample = {'cycle': cycle, 'loadBudgetMs': VIEWER_LOAD_BUDGET_MS}
        record['samples'].append(sample)
        try:
            with viewer_load_scope(client, sample) as load:
                load.run(lambda: client.execute('''const [items,states,diagnostics,frameDiagnostics]=arguments; window.fixtureLoaded=false;window.nativeTeardown=null;window.nativeGraphicsToken=crypto.randomUUID();
          fetch('/viewer').then(r=>r.text()).then(html=>{html=html.replace('<head>',()=>'<head><script>window.__nativeGraphicsToken='+JSON.stringify(window.nativeGraphicsToken)+';'+diagnostics+'</script>');
            html=html.replace('</script></body>', ()=>frameDiagnostics+'</script></body>');
            const iframe=document.createElement('iframe');
            iframe.id='viewer';iframe.sandbox='allow-scripts allow-downloads allow-forms';
            iframe.style.cssText='width:100%;height:740px;border:0';
            iframe.onload=()=>{window.nativeViewer=iframe.contentWindow;const channel=new MessageChannel();window.viewerPort=channel.port1;window.viewerMapRequests=[];window.viewerCommands=[];
              channel.port1.onmessage=e=>{
                if(e.data.type==='model_config')channel.port1.postMessage({type:'states',connected:true,states});
                if(e.data.type==='map_request'){
                  window.viewerMapRequests.push(e.data);
                  if(e.data.action!=='get')window.viewerCommands.push(e.data);
                  channel.port1.postMessage({type:'map_result',request_id:e.data.request_id,
                    ...(e.data.action==='get'?{success:true,result:{revision:0,configured:false,config:null,reference:{latitude:0,longitude:0}}}:
                      {success:false,error:'Unsupported map request in the native fixture.'})});
                }else if(!['model_config','view_preferences','map_view'].includes(e.data.type))window.viewerCommands.push(e.data);
              };
              iframe.contentWindow.postMessage({type:'home-floorplan:init',items,preferences:{},can_edit:true},'*',[channel.port2]);window.fixtureLoaded=true;};
            iframe.srcdoc=html;document.body.append(iframe);}); return true;''', items, states, NATIVE_VIEWER_PROGRAM_DIAGNOSTICS + NATIVE_GL_DIAGNOSTICS, NATIVE_VIEWER_FRAME_DIAGNOSTICS))
                load.wait('window.fixtureLoaded')
                load.run(lambda: client.call('WebDriver:SwitchToFrame', {'id': 0}))
                load.wait(f"window.floorplan?.renderCount>0 && window.floorplan.canEdit===true && document.querySelector('#homeConnection')?.dataset.connected==='true' && document.querySelector('#homeMapAlign')?.hidden===false && window.__nativeRenderedLights==={len(items)}")
                load.complete()
        finally:
            save()
        snapshot = lambda: client.execute('return {...window.__browserStability,programLedger:window.__nativeViewerPrograms.snapshot(),nativeGraphics:window.__sampleNativeGraphics("viewer-snapshot"),renderedLights:window.__nativeRenderedLights,renderCount:window.floorplan.renderCount,scene:window.__browserScene()};')
        sample['initial'] = initial = snapshot()
        save()
        assert_graphics(initial)
        require(initial['scene']['pointLights'] == len(items), 'Every fixture light retains a shader slot')
        require(initial['scene']['activePointLights'] == len(items), 'Every on-state fixture light contributes illumination')
        sample['dragMs'] = client.canvas_drag('#homeStage canvas', diagnostics=sample.setdefault('dragDiagnostics', {}), snapshot=snapshot)
        client.wait(f'window.floorplan.renderCount>{initial["renderCount"]}')
        sample['afterDrag'] = after_drag = snapshot()
        require(after_drag['scene']['camera'] != initial['scene']['camera'], 'Real pointer drag changes the viewer camera')
        before_world = initial['scene']['camera']['world']
        after_world = after_drag['scene']['camera']['world']
        require(any(abs(before_world[index] - after_world[index]) > 1e-7 for index in (0, 1, 2, 4, 5, 6, 8, 9, 10)),
                'Real Home pointer drag rotates the rendered camera, rather than only panning its projection')
        assert_viewer_interaction(initial, after_drag)
        assert_first_motion_programs(initial, after_drag)
        # Send real bridge state updates, including all-off and partial illumination.
        sample['states'] = [{'active': len(items), 'linkedPrograms': after_drag['linkedPrograms']}]
        before_state = after_drag
        for active in (0, max(1, len(items) // 2), len(items)):
            next_states = json.loads(json.dumps(states))
            for index, item in enumerate(items):
                next_states[item['entity_id']]['state'] = 'on' if index < active else 'off'
            update_viewer_state(client, next_states, active)
            value = snapshot()
            require(value['scene']['pointLights'] == len(items), 'State updates retain every light slot')
            sample['states'].append({'active': active, 'linkedPrograms': value['linkedPrograms'], 'renderCount': value['renderCount'], 'renderedLights': value['renderedLights'], 'programLedger': value['programLedger']})
            assert_graphics(value)
            assert_state_programs(before_state, value)
            before_state = value
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
            assert_recovered_graphics(sample['recovery'])
            sample['recoveryDragMs'] = client.canvas_drag('#homeStage canvas', diagnostics=sample.setdefault('recoveryDragDiagnostics', {}), snapshot=snapshot)
            client.wait(f'window.floorplan.renderCount>{sample["recovery"]["renderCount"]}')
            sample['afterRecoveryDrag'] = after = snapshot()
            assert_viewer_interaction(sample['recovery'], after)
            assert_first_motion_programs(sample['recovery'], after)
            assert_recovered_interaction(sample['recovery']['renderCount'], after['renderCount'], sample['recovery']['scene']['camera'], after['scene']['camera'], after)
            post_restore_viewer_modes(client, sample, snapshot, save, len(items))
        sample['final'] = snapshot()
        assert_graphics(sample['final'])
        require(sample['final']['contextLosses'] == cycle, 'No unexpected WebGL context loss')
        save()
        client.call('WebDriver:SwitchToFrame', {'id': None})
        sample['viewerCommands'] = client.execute('return window.viewerCommands;')
        save()
        require(sample['viewerCommands'] == [], 'Viewer navigation never issues a device, write, or unsupported command')
        client.screenshot(Path(record['output']) / f'viewer-cycle-{cycle + 1}.png')
        client.execute("window.viewerPort.close();document.querySelector('#viewer').remove();return true;")
        require(client.execute('return document.querySelectorAll("iframe").length===0 && 6*7===42;'), 'Dashboard remains responsive after closing viewer')
        client.wait('window.nativeTeardown !== null')
        sample['teardownGraphics'] = client.execute('return window.nativeTeardown;')
        save()
        assert_native_graphics(sample['teardownGraphics'], teardown=True)


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
    client.execute(NATIVE_GL_DIAGNOSTICS)
    client.execute("sessionStorage.removeItem('home-studio.native-gl-teardown');return true;")
    require(client.execute('return window.planner.getProject().floors.reduce((n,f)=>n+f.items.length,0);') == 256, 'All 256 furniture items load')
    points = client.execute("const c=document.querySelector('#plan-canvas').getBoundingClientRect();return [[1,1],[1.5,1]].map(p=>window.planner.worldToScreen(p).map((v,i)=>v+(i?c.y:c.x)));")
    sample['itemDragMs'] = client.drag(*points)
    require(sample['itemDragMs'] < 10000, 'Planner furniture drag exceeded 10 seconds')
    require(client.execute('return window.planner.getProject().floors[0].items[0].position_m.x;') == 1.5, 'Real pointer input moves the intended furniture')
    started = time.monotonic()
    client.execute("document.querySelector('#preview-tab').click();document.querySelector('#all-floors').click();return true;")
    client.wait('window.planner.getPreviewMetadata().items===256 && window.planner.getPreviewMetadata().renderCount>0')
    sample['previewLoadMs'] = round((time.monotonic() - started) * 1000)
    snapshot = lambda: client.execute('return {stats:{...window.__plannerStats,contextStates:window.__plannerContextStates(),nativeGraphics:window.__sampleNativeGraphics("planner-snapshot")},preview:window.planner.getPreviewMetadata(),scene:window.__plannerScene()};')
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
    client.wait(f'window.planner.getPreviewMetadata().renderCount>{before} && window.__plannerStats.contextLossRequests.some(request=>request.retirement && request.matched)')
    sample['recovery'] = snapshot()
    assert_recovered_graphics(sample['recovery']['stats'], replacement=True)
    require(client.execute('return document.querySelectorAll("#preview-canvas").length;') == 1, 'Planner recovery keeps exactly one preview canvas')
    require(client.execute('return window.planner.getProject();') == saved, 'Graphics recovery preserves edited furniture')
    sample['recoveryOrbitMs'] = client.canvas_drag('#preview-canvas')
    require(sample['recoveryOrbitMs'] < 10000, 'Recovered planner orbit exceeded 10 seconds')
    client.wait(f'window.planner.getPreviewMetadata().renderCount>{sample["recovery"]["preview"]["renderCount"]}')
    sample['afterRecoveryOrbit'] = after = snapshot()
    assert_recovered_interaction(sample['recovery']['preview']['renderCount'], after['preview']['renderCount'], sample['recovery']['scene']['orbit'], after['scene']['orbit'], after['stats'], replacement=True)
    save()
    client.screenshot(Path(record['output']) / 'planner-recovered.png')
    client.call('WebDriver:Navigate', {'url': url})
    client.wait('window.planner')
    require(client.execute('return window.planner.getProject();') == saved, 'Reopening the planner restores its edited draft')
    sample['teardownGraphics'] = client.execute("return JSON.parse(sessionStorage.getItem('home-studio.native-gl-teardown'));")
    save()
    assert_native_graphics(sample['teardownGraphics'], teardown=True, replacement=True)


def browser_preferences(port):
    backend = os.environ.get('FIREFOX_WEBGL_BACKEND', 'default')
    require(backend in ('default', 'angle'), 'FIREFOX_WEBGL_BACKEND must be default or angle')
    compositor = os.environ.get('FIREFOX_COMPOSITOR_BACKEND', 'default')
    require(compositor in ('default', 'software'), 'FIREFOX_COMPOSITOR_BACKEND must be default or software')
    gpu_process = os.environ.get('FIREFOX_GPU_PROCESS', 'default')
    require(gpu_process in ('default', 'disabled'), 'FIREFOX_GPU_PROCESS must be default or disabled')
    visibility = os.environ.get('FIREFOX_RENDERER_VISIBILITY', 'unmasked')
    require(visibility in ('unmasked', 'masked'), 'FIREFOX_RENDERER_VISIBILITY must be unmasked or masked')
    prefs = {'marionette.port': port, 'browser.shell.checkDefaultBrowser': False, 'browser.aboutwelcome.enabled': False, 'browser.startup.homepage': 'about:blank', 'browser.startup.homepage_override.mstone': 'ignore', 'browser.startup.firstrunSkipsHomepage': True, 'browser.migrate.automigrate.enabled': False, 'app.update.auto': False, 'app.update.enabled': False, 'webgl.force-enabled': True, 'webgl.forbid-software': False, 'webgl.sanitize-unmasked-renderer': False}
    prefs['webgl.sanitize-unmasked-renderer'] = visibility == 'masked'
    if backend == 'angle':
        prefs['webgl.disable-angle'] = False
    if compositor == 'software':
        # Legacy Gecko on macOS VMs can stall while its GPU compositor fails
        # over to SW-WR. Request that compositor directly in this test profile.
        # This does not select the WebGL renderer or relax graphics assertions.
        # https://github.com/mozilla-firefox/firefox/blob/esr153/modules/libpref/init/StaticPrefList.yaml
        prefs['gfx.webrender.software'] = True
    if gpu_process == 'disabled':
        # Software WebRender still uses the GPU process on macOS. Isolate that
        # process in this temporary profile without changing the WebGL backend.
        # ESR153 defaults layers.gpu-process.force-enabled to false.
        prefs['layers.gpu-process.enabled'] = False
        # Headed macOS/Windows otherwise disable WebGL before force-enabled
        # is checked (gfxPlatform::InitWebGLConfig, FIREFOX_153_5_0esr_RELEASE).
        prefs['webgl.allow-in-parent'] = True
    return prefs


def expected_point_shadow_face(count, max_texture_size, ceiling):
    """Largest power of two satisfying face, 4x2 atlas and total-pixel limits."""
    require(type(count) is int and count >= 0, 'A nonnegative point shadow count is required')
    require(type(max_texture_size) is int and max_texture_size >= 4, 'The actual texture size limit is required')
    require(type(ceiling) is int and ceiling >= 1, 'A positive profile shadow ceiling is required')
    aggregate = math.isqrt((8 * 1024 * 1024) // (max(1, count) * 8))
    bound = max(1, min(ceiling, max_texture_size // 4, aggregate))
    return 1 << (bound.bit_length() - 1)


def assert_masked_capacity(record):
    """Derive expectations from raw identity and probe evidence, never selected profile flags."""
    if record['preferences'].get('webgl.sanitize-unmasked-renderer') is not True:
        return
    require(re.search(r'\bGecko/\d', record['userAgent']), 'Masked capacity acceptance requires actual Gecko')
    duration = lambda value: type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1e9
    require(record['samples'], 'Masked acceptance requires completed scene samples')
    for sample in record['samples']:
        require('initial' in sample, 'Masked acceptance requires the initial scene')
        for key in ('initial', 'recovery', 'afterRecoveryOrbit', 'afterRecoveryDrag', 'final'):
            if key not in sample:
                continue
            snapshot = sample[key]
            gpu = snapshot.get('stats', snapshot)['gpu']
            require((gpu.get('unmaskedRenderer') or gpu.get('renderer')) == 'Apple M1, or similar', 'The masked lane must exercise the exact opaque Apple label')
            scene = snapshot['scene']
            probe = scene.get('rasterProbe')
            require(isinstance(probe, dict) and set(probe) == {'status','samplesMs','pixels','bestMs','totalMs'}, 'Masked acceptance requires complete independent raster evidence')
            require(probe['status'] == 'measured', 'The masked capacity probe must complete')
            times, pixels = probe['samplesMs'], probe['pixels']
            require(isinstance(times, list) and len(times) == 3 and all(duration(n) for n in times), 'Three finite raster durations are required')
            require(duration(probe['totalMs']) and probe['totalMs'] + 1e-6 >= sum(times), 'Total probe time must include every measured draw')
            require(duration(probe['bestMs']) and probe['bestMs'] == min(times), 'Probe minimum must match the measured durations')
            require(isinstance(pixels, list) and len(pixels) == 5, 'Every warm and measured draw must have readback evidence')
            require(all(isinstance(pixel, list) and len(pixel) == 4 and pixel[3] == 255 and
                        all(type(value) is int and 0 < value < 255 for value in pixel[:3]) for pixel in pixels), 'Probe readbacks must be nonzero, nonsaturated RGB')
            require(any(pixel != pixels[0] for pixel in pixels[1:]), 'Seeded probe draws must change the readback')
            reduced = min(times) >= 15
            buffer = scene.get('buffer', scene.get('drawingBuffer'))
            require(isinstance(buffer, list) and len(buffer) == 2 and all(type(n) is int and n > 0 for n in buffer), 'Actual drawing buffer dimensions are required')
            require(math.prod(buffer) <= (250000 if reduced else 2000000), 'Actual drawing buffer must obey the measured capacity budget')
            materials = scene.get('materialTypes')
            require(isinstance(materials, list) and all(isinstance(name, str) for name in materials), 'Actual scene material types are required')
            required, forbidden = ('MeshLambertMaterial', 'MeshStandardMaterial') if reduced else ('MeshStandardMaterial', 'MeshLambertMaterial')
            require(required in materials and forbidden not in materials and 'MeshPhysicalMaterial' not in materials, 'Actual materials must match measured capacity')
            require(scene.get('shadowType') == (0 if reduced else 2), 'Actual shadow filtering must match measured capacity')
            shadow_size = 512 if reduced else 2048
            if record['suite'] == 'planner-256':
                require(scene.get('shadowMap') == [shadow_size, shadow_size], 'Actual planner shadow must match measured capacity')
            else:
                maps = scene['shadowMaps']
                sun = [entry for entry in maps if entry[0] == 'DirectionalLight']
                points = [entry for entry in maps if entry[0] == 'PointLight']
                require(sun and all(entry[1:] == [shadow_size, shadow_size] for entry in sun), 'Actual sun shadows must match measured capacity')
                count = max(0, min(scene['pointLights'], 2 if reduced else 8, gpu['textureUnits'] - 4))
                require(len(points) == count, 'Actual point shadow count must match measured capacity and samplers')
                face = expected_point_shadow_face(count, gpu.get('maxTextureSize'), 128 if reduced else 512)
                require(all(entry[1:] == [face, face] for entry in points), 'Actual point shadows must match measured capacity')


def assert_requested_backend(record):
    if record['os']['platform'] == 'darwin' and record['preferences'].get('webgl.disable-angle') is False:
        for sample in record['samples']:
            initial = sample['initial']
            gpu = initial.get('stats', initial)['gpu']
            renderer = gpu.get('unmaskedRenderer') or gpu.get('renderer', '')
            require('angle metal renderer' in renderer.lower(), 'The requested Metal ANGLE backend must be confirmed by the actual renderer')


def assert_browser_identity(installation, capabilities):
    """Use native session capabilities, never a spoofable user agent label."""
    validate_metadata(installation)
    product = installation['product']
    app = installation['metadata']['application.ini']['App']
    require(capabilities['browserName'].lower() == product.lower(), f'The loaded browser must identify itself as {product}')
    require(capabilities['browserVersion'] == app['Version'], 'Loaded browser version must match the verified package')
    require(capabilities['moz:buildID'] == app['BuildID'], 'Loaded browser build must match the verified package')


def run_case(installation, output, name, headless, *, diagnostic_only=False):
    output.mkdir(parents=True, exist_ok=True)
    record = {'schema': 1, 'suite': name, 'status': 'running', 'installation': installation,
              'sourceRevision': os.environ.get('GITHUB_SHA'),
              'os': {'platform': sys.platform, 'release': platform.release(), 'machine': platform.machine()},
              'pythonVersion': platform.python_version(), 'headless': headless,
              'output': str(output), 'samples': []}
    if name.startswith('viewer-'):
        record['loadBudgetMs'] = VIEWER_LOAD_BUDGET_MS
    if diagnostic_only:
        record.update(diagnosticOnly=True, acceptanceStatus='not-run')
    def save():
        (output / 'report.json').write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
    save()
    server = browser = client = watchdog = None
    resources = contextlib.ExitStack()
    started = time.monotonic()
    startup_file = output / 'startup.jsonl'
    try:
        startup = os.environ.get('NATIVE_STARTUP_DIAGNOSTICS', '0')
        require(startup in ('0', '1'), 'NATIVE_STARTUP_DIAGNOSTICS must be 0 or 1')
        record['startupDiagnostics'] = startup == '1'
        directory = resources.enter_context(tempfile.TemporaryDirectory(prefix='home-studio-native-browser-'))
        browser_log = resources.enter_context((output / 'browser.log').open('w', encoding='utf-8'))
        fixture_log = resources.enter_context((output / 'fixture.log').open('w', encoding='utf-8'))
        scratch = Path(directory)
        profile = scratch / 'profile'
        profile.mkdir()
        env = {**os.environ, 'HOME_STUDIO_FIXTURE_ONLY': '1', 'PYTHON': sys.executable, 'PYTHONUTF8': '1', 'MOZ_CRASHREPORTER_DISABLE': '1', 'TMPDIR': str(scratch), 'TEMP': str(scratch), 'TMP': str(scratch)}
        env.pop('HOME_STUDIO_STARTUP_DIAGNOSTICS_FILE', None)
        if startup == '1':
            startup_file.write_text('', encoding='utf-8')
            env['HOME_STUDIO_STARTUP_DIAGNOSTICS_FILE'] = str(startup_file.resolve())
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
        if 'sourceFiles' in info:
            record['sourceFiles'] = info['sourceFiles']
            record['sourceHashScope'] = info['sourceHashScope']
        with urllib.request.urlopen(info['origin'] + '/fixture.json', timeout=10) as response:
            project = json.load(response)
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        prefs = browser_preferences(port)
        record['preferences'] = prefs
        record['rendererVisibility'] = 'masked' if prefs['webgl.sanitize-unmasked-renderer'] else 'unmasked'
        (profile / 'user.js').write_text('\n'.join(f'user_pref({json.dumps(key)},{json.dumps(value)});' for key, value in prefs.items()), encoding='utf-8')
        command = [installation['binary'], '--no-remote', '--profile', str(profile), '--marionette', 'about:blank']
        if headless:
            command.insert(1, '--headless')
        browser = subprocess.Popen(command, stdout=browser_log, stderr=subprocess.STDOUT, env=env)
        def deadline_exceeded():
            record['deadlineExceeded'] = True
            stop(browser)
        browser_deadline = time.monotonic() + 180
        watchdog = threading.Timer(180, deadline_exceeded)
        watchdog.daemon = True
        watchdog.start()
        deadline = time.monotonic() + 45
        connection = None
        while time.monotonic() < deadline:
            require(browser.poll() is None, f'Browser exited before connecting: {browser.returncode}')
            try:
                connection = socket.create_connection(('127.0.0.1', port), timeout=.2)
                break
            except OSError:
                time.sleep(.1)
        require(connection is not None, 'Browser Marionette startup timed out')
        client = Marionette(connection)
        client._browser_deadline = browser_deadline
        record['protocol'] = client.hello
        record['session'] = session = client.call('WebDriver:NewSession', {'capabilities': {}})
        capabilities = session.get('capabilities', session)
        assert_browser_identity(installation, capabilities)
        client.call('WebDriver:SetTimeouts', {'script': 30000, 'pageLoad': 30000, 'implicit': 0})
        client.call('WebDriver:SetWindowRect', {'width': 1440, 'height': 1000})
        record['userAgent'] = client.execute('return navigator.userAgent;')
        save()
        (planner if name == 'planner-256' else viewer)(client, info['origin'], project, record, save)
        if not diagnostic_only:
            assert_masked_capacity(record)
            assert_requested_backend(record)
        shutdown_browser(client, browser, record)
        client = None
        record['status'] = 'diagnostic-completed' if diagnostic_only else 'passed'
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
        if record.get('startupDiagnostics') and startup_file.exists():
            try:
                record['startupCheckpoints'] = [json.loads(line) for line in startup_file.read_text(encoding='utf-8').splitlines()]
            except (OSError, ValueError) as error:
                record['startupDiagnosticsError'] = str(error)
                record['status'] = 'failed'
        record['durationMs'] = round((time.monotonic() - started) * 1000)
        save()

    print(f'{name}: {record["status"]}', flush=True)
    return record


def main(default_product='waterfox'):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--product', choices=PRODUCTS, default=default_product, required=default_product is None)
    parser.add_argument('--expected-version', required=default_product is None)
    parser.add_argument('--installation', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--headless', action='store_true')
    args = parser.parse_args()
    installation = json.loads(args.installation.read_text(encoding='utf-8'))
    validate_installation(installation, args.product, args.expected_version)
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
