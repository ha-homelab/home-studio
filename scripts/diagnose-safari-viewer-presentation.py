#!/usr/bin/env python3
"""Observe one actual viewer-6 frame in hosted Safari; never acceptance evidence."""
import argparse
import ast
import contextlib
from datetime import datetime, timezone
import hashlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
import queue
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

SCRIPTS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('canvas_diagnostic', SCRIPTS / 'diagnose-safari-canvas.py')
canvas_diagnostic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(canvas_diagnostic)
safari = canvas_diagnostic.safari
native = safari.native
ROOT = SCRIPTS.parent
BUDGET_SECONDS = 180
CLEANUP_RESERVE_SECONDS = 10


def shared_initializer():
    """Reuse the exact native acceptance bridge, with no second cycle or gestures."""
    source = inspect.getsource(native.viewer)
    matches = [node.value for node in ast.walk(ast.parse(source))
               if isinstance(node, ast.Constant) and isinstance(node.value, str)
               and node.value.startswith('const [items,states,diagnostics,frameDiagnostics]=arguments;')]
    if len(matches) != 1:
        raise ValueError('Expected exactly one shared native viewer initializer')
    script = matches[0]
    for anchor in ("fetch('/viewer')", "iframe.id='viewer'", "iframe.sandbox='allow-scripts allow-downloads allow-forms'",
                   "iframe.srcdoc=html;document.body.append(iframe)", "type:'home-floorplan:init'", "type:'states'"):
        if script.count(anchor) != 1:
            raise ValueError('Shared native viewer initializer contract changed: ' + anchor)
    return script


SETUP_AND_RENDER = r"""
const canvas=document.querySelector('#homeStage canvas');
if(!canvas)throw Error('Actual Home viewer canvas is missing');
const gl=canvas.getContext('webgl2');
if(!gl)throw Error('Actual Home viewer WebGL2 context is missing');
const nativeGL=WebGL2RenderingContext.prototype,native2D=CanvasRenderingContext2D.prototype;
const errorValue=error=>({name:String(error?.name||'').slice(0,128),message:String(error?.message||error).slice(0,2048)});
let baseline=null;
function facts(){
  const rect=canvas.getBoundingClientRect(),style=getComputedStyle(canvas),scene=window.__browserScene();
  return {time:performance.now(),sameCanvas:document.querySelector('#homeStage canvas')===canvas,
    connected:canvas.isConnected,width:canvas.width,height:canvas.height,
    drawingBuffer:[gl.drawingBufferWidth,gl.drawingBufferHeight],contextLost:gl.isContextLost(),
    attributes:gl.getContextAttributes(),renderCount:window.floorplan.renderCount,
    rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
    display:style.display,visibility:style.visibility,opacity:style.opacity,
    documentVisibility:document.visibilityState,focused:document.hasFocus(),
    viewport:[innerWidth,innerHeight],devicePixelRatio,scene};
}
function summarize(data,width,height,flip){
  if(data.length!==width*height*4)throw Error('Incomplete native pixel buffer');
  let hash=2166136261,visible=0,nonzeroRGB=0;const colors=new Set();
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=((flip?height-y-1:y)*width+x)*4;
    if(data[i+3]){visible++;if(colors.size<257)colors.add((data[i]<<16)|(data[i+1]<<8)|data[i+2]);}
    if(data[i]||data[i+1]||data[i+2])nonzeroRGB++;
    for(let c=0;c<4;c++)hash=Math.imul(hash^data[i+c],16777619);
  }
  return {status:'pixels-read',bytes:data.length,pixelCount:width*height,visiblePixels:visible,nonzeroRGBPixels:nonzeroRGB,
    distinctVisibleRGBColorsAtLeast:colors.size,topDownFNV1a32:(hash>>>0).toString(16).padStart(8,'0'),
    rgbaSamples:[0,1,2,3].map(q=>{const y=Math.min(height-1,Math.floor(height*(q<2?.25:.75))),
      x=Math.min(width-1,Math.floor(width*(q%2?.75:.25))),i=((flip?height-y-1:y)*width+x)*4;return Array.from(data.slice(i,i+4));})};
}
function readGL(width,height){
  const framebuffer=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),packBuffer=gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
  const packs=[gl.PACK_ALIGNMENT,gl.PACK_ROW_LENGTH,gl.PACK_SKIP_PIXELS,gl.PACK_SKIP_ROWS],values=packs.map(p=>gl.getParameter(p));
  let defaultReadBuffer;
  try{
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER,null);defaultReadBuffer=gl.getParameter(gl.READ_BUFFER);gl.readBuffer(gl.BACK);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER,null);packs.forEach((p,i)=>gl.pixelStorei(p,i===0?1:0));
    const data=new Uint8Array(width*height*4);
    nativeGL.readPixels.call(gl,0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,data);
    const result=summarize(data,width,height,true);result.glError=nativeGL.getError.call(gl);return result;
  }finally{
    if(defaultReadBuffer!==undefined)gl.readBuffer(defaultReadBuffer);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER,framebuffer);packs.forEach((p,i)=>gl.pixelStorei(p,values[i]));
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER,packBuffer);
  }
}
function readCPU(width,height){
  const scratch=document.createElement('canvas');scratch.width=width;scratch.height=height;
  try{
    const ctx=scratch.getContext('2d',{alpha:true,willReadFrequently:true});
    if(!ctx)throw Error('Transparent CPU readback context unavailable');
    native2D.drawImage.call(ctx,canvas,0,0);
    const result=summarize(native2D.getImageData.call(ctx,0,0,width,height).data,width,height,false);
    result.attributes=ctx.getContextAttributes?.()||null;return result;
  }finally{scratch.width=0;scratch.height=0;}
}
function read(){
  const before=facts(),result={before};const {width,height}=before;
  if(!before.sameCanvas||!before.connected||before.contextLost||!Number.isInteger(width)||!Number.isInteger(height)||
     width<1||height<1||width*height>2000000||before.drawingBuffer[0]!==width||before.drawingBuffer[1]!==height)
    return {...result,status:'outside-readback-bound-or-unavailable'};
  for(const [name,method] of [['nativeGL',readGL],['cpuCopy',readCPU]]){
    try{result[name]=method(width,height);}catch(error){result[name]={status:'readback-failed',...errorValue(error)};}
  }
  result.after=facts();result.status='observed';
  const stable=state=>state.sameCanvas&&state.connected&&!state.contextLost&&state.width===width&&state.height===height&&
    state.drawingBuffer[0]===width&&state.drawingBuffer[1]===height&&state.renderCount===before.renderCount;
  result.stableDuringRead=stable(result.after);
  result.unchangedSinceExplicitRender=baseline===null||
    (before.renderCount===baseline.renderCount&&width===baseline.width&&height===baseline.height&&before.sameCanvas);
  return result;
}
window.__viewerPresentation={read,cleanup(){delete window.__viewerPresentation;}};
const beforeRender=facts();
window.renderModel(); // Exactly one diagnostic request, not an acceptance or recovery action.
baseline=facts();
return {explicitRenderCalls:1,beforeRender,afterRender:baseline,sameCall:read()};
"""
READ = 'return window.__viewerPresentation.read();'
SETTLE = canvas_diagnostic.PRESENTATION_SETTLE.replace('window.__safariPresentation', 'window.__viewerPresentation')
CLEANUP = 'if(window.__viewerPresentation)window.__viewerPresentation.cleanup();return true;'
TEARDOWN = "window.viewerPort?.close();document.querySelector('#viewer')?.remove();return true;"


def remaining(deadline):
    value = deadline - time.monotonic()
    if value <= 0:
        raise TimeoutError('Viewer presentation diagnostic exhausted its aggregate deadline')
    return value


def stop_owned(process, deadline):
    # A compiler may outlive its fixture leader; inspect the owned session group.
    def group_alive():
        try:
            os.killpg(process.pid, 0)
            return True
        except ProcessLookupError:
            return False
    def send(value):
        try:
            os.killpg(process.pid, value)
        except ProcessLookupError:
            pass
    end = min(deadline, time.monotonic()+2)
    grace = min(end, time.monotonic()+1)
    if group_alive() and time.monotonic() < grace:
        send(signal.SIGTERM)
        while group_alive() and time.monotonic() < grace:
            process.poll();time.sleep(min(.02, max(0, grace-time.monotonic())))
    if group_alive():send(signal.SIGKILL)
    while group_alive() and time.monotonic() < end:
        process.poll();time.sleep(min(.02, max(0, end-time.monotonic())))
    leader = process.poll()
    if group_alive() or leader is None:
        raise TimeoutError('Owned diagnostic process group did not stop before cleanup deadline')


def start_fixture(log, deadline, owned, readers):
    # Same canonical fixture, environment and source instrumentation as native acceptance.
    env = {**os.environ, 'HOME_STUDIO_FIXTURE_ONLY': '1', 'PYTHON': sys.executable, 'PYTHONUTF8': '1',
           'BROWSER_STABILITY_ROOMS': '6', 'BROWSER_STABILITY_LIGHTS_PER_ROOM': '3'}
    process = subprocess.Popen(['node', str(SCRIPTS / 'test-browser-stability.cjs')], cwd=ROOT, env=env,
                               stdout=subprocess.PIPE, stderr=log, text=True, encoding='utf-8', start_new_session=True)
    owned.append(process)
    lines = queue.Queue(maxsize=4)
    def collect():
        try:
            for _ in range(64):
                line = process.stdout.readline(65537)
                if not line:
                    return
                if len(line) > 65536:
                    lines.put_nowait(ValueError('Oversized fixture startup line'));return
                log.write(line);log.flush()
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(value, dict) and value.get('fixtureServer'):
                    lines.put_nowait(value);return
            lines.put_nowait(ValueError('Too many fixture startup lines'))
        except Exception as error:
            try:
                lines.put_nowait(error)
            except queue.Full:
                pass
    thread = threading.Thread(target=collect, daemon=True);readers.append(thread);thread.start()
    while True:
        remaining(deadline)
        native.require(process.poll() is None, 'Canonical viewer fixture exited before startup')
        try:
            info = lines.get(timeout=min(.1, remaining(deadline)))
        except queue.Empty:
            continue
        if isinstance(info, Exception):
            raise info
        # The fixture receipt is local but still must not redirect this reader elsewhere.
        from urllib.parse import urlsplit
        address = urlsplit(info['origin'])
        native.require(address.scheme == 'http' and address.hostname == '127.0.0.1' and address.port
                       and address.path == '' and not address.query and not address.fragment,
                       'Fixture origin must be the owned loopback HTTP server')
        with urllib.request.urlopen(info['origin'] + '/fixture.json', timeout=min(10, remaining(deadline))) as response:
            data = response.read(2000001)
        native.require(len(data) <= 2000000, 'Oversized canonical fixture')
        return info, json.loads(data)


def observe(client, info, project, output, record, save, deadline, native_display_capture=False):
    remaining(deadline)
    init = shared_initializer()
    record['initializerSHA256'] = hashlib.sha256(init.encode()).hexdigest()
    floor = project['floors'][0];items = floor['items']
    native.require(len(project['floors']) == 1 and len(floor['rooms']) == 6 and len(items) == 18,
                   'Expected canonical viewer-6 with eighteen lights')
    states = {item['entity_id']: {'state': 'on', 'name': item['name'],
              'light': {'brightness': 180, 'color_mode': 'color_temp', 'color_temp_kelvin': 3000}} for item in items}
    states['sun.sun'] = {'state': 'above_horizon', 'elevation': 30}
    record['phase'] = 'viewer-load';save()
    client.call('WebDriver:Navigate', {'url': info['origin']})
    client.execute(init, items, states, native.NATIVE_VIEWER_PROGRAM_DIAGNOSTICS + native.NATIVE_GL_DIAGNOSTICS,
                   native.NATIVE_VIEWER_FRAME_DIAGNOSTICS)
    client.wait('window.fixtureLoaded', timeout=remaining(deadline))
    client.call('WebDriver:SwitchToFrame', {'id': 0})
    record['inViewerFrame'] = True
    client.wait("window.floorplan?.renderCount>0 && window.floorplan.homeMode===true && window.floorplan.canEdit===true && "
                "document.querySelector('#homeConnection')?.dataset.connected==='true' && window.__nativeRenderedLights===18 && "
                "(()=>{const s=window.__browserScene().renderState;return s.request===0&&s.delay===0&&s.fallback===0;})()",
                timeout=remaining(deadline))
    record['userAgent'] = client.execute('return navigator.userAgent;')
    record['phase'] = 'original-screenshot';save()
    try:
        client.screenshot(output / 'viewer-before-diagnostic.png')
        record['originalScreenshot'] = 'viewer-before-diagnostic.png'
    except Exception as error:
        record['originalScreenshotError'] = canvas_diagnostic.error_record(error)
    remaining(deadline)
    record['phase'] = 'one-explicit-render';save()
    record['renderAndSameCall'] = client.execute(SETUP_AND_RENDER);save()
    remaining(deadline)
    record['nextCommand'] = client.execute(READ);save()
    remaining(deadline)
    record['afterTwoFrames'] = client.call('WebDriver:ExecuteAsyncScript', {'script': SETTLE, 'args': []})['value'];save()
    record['phase'] = 'capture-after-frames';save()
    if native_display_capture:
        try:
            record['nativeDisplayCapture'] = canvas_diagnostic.native_display_observation(output, deadline)
        except Exception as error:
            record['nativeDisplayCapture'] = {'status': 'inconclusive', 'error': canvas_diagnostic.error_record(error)}
        save()
    remaining(deadline)
    try:
        client.screenshot(output / 'viewer-after-frames.png')
        record['afterFramesScreenshot'] = 'viewer-after-frames.png'
    except Exception as error:
        record['afterFramesScreenshotError'] = canvas_diagnostic.error_record(error)
    remaining(deadline)
    record['afterScreenshot'] = client.execute(READ);save()


def run(output, driver_path='/usr/bin/safaridriver', native_display_capture=False):
    started = time.monotonic();deadline = started + BUDGET_SECONDS;work_deadline = deadline - CLEANUP_RESERVE_SECONDS
    output.mkdir(parents=True, exist_ok=True)
    record = {'schema': 1, 'purpose': 'diagnostic-only', 'acceptanceEvidence': False, 'suite': 'viewer-6-presentation',
              'status': 'running', 'phase': 'setup', 'budgetMs': BUDGET_SECONDS*1000,
              'cleanupReserveMs': CLEANUP_RESERVE_SECONDS*1000, 'startedUTC': datetime.now(timezone.utc).isoformat(),
              'sourceRevision': os.environ.get('GITHUB_SHA'), 'nativeDisplayCaptureRequested': native_display_capture,
              'diagnosticScriptSHA256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'host': {key: os.environ.get(key) for key in ('ImageOS', 'ImageVersion', 'RUNNER_OS', 'RUNNER_ARCH')},
              'cleanupErrors': [], 'captureScope': 'One explicit diagnostic render; no repaint requested between pixel reads; optional OS capture precedes final WebDriver screenshot'}
    def save():
        (output / 'report.json').write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
    save();owned = [];readers = [];client = None
    def expired():
        record['deadlineExceeded'] = True
        for process in owned:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    watchdog = threading.Timer(max(0, deadline-time.monotonic()), expired);watchdog.daemon = True;watchdog.start()
    with contextlib.ExitStack() as resources:
        try:
            native.require(sys.platform == 'darwin' and os.environ.get('GITHUB_ACTIONS') == 'true'
                           and os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted', 'Requires disposable hosted macOS')
            record['host']['osVersion'] = canvas_diagnostic.command_observation(['sw_vers'], work_deadline)
            record['driverVersion'] = canvas_diagnostic.command_observation([driver_path, '--version'], work_deadline)
            info, project = start_fixture(resources.enter_context((output / 'fixture.log').open('w')), work_deadline, owned, readers)
            record['fixture'] = info;save()
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0));port = probe.getsockname()[1]
            driver = subprocess.Popen([driver_path, '--port', str(port)],
                                      stdout=resources.enter_context((output / 'driver.log').open('w')),
                                      stderr=subprocess.STDOUT, start_new_session=True);owned.append(driver)
            client = safari.SafariWebDriver(f'http://127.0.0.1:{port}')
            client._browser_deadline = client._preparation_deadline = work_deadline
            while True:
                remaining(work_deadline)
                native.require(driver.poll() is None, 'SafariDriver exited during startup')
                try:
                    client.request('GET', '/status');break
                except urllib.error.URLError as error:
                    if not isinstance(error.reason, ConnectionRefusedError):
                        raise
                    time.sleep(min(.1, remaining(work_deadline)))
            record['sessionStartup'] = {};record['session'] = client.start(record['sessionStartup']);save()
            client.call('WebDriver:SetTimeouts', {'script': 5000, 'pageLoad': 15000, 'implicit': 0})
            record['windowRect'] = client.call('WebDriver:SetWindowRect', {'width': 1440, 'height': 1000})
            record['windowFocus'] = client.select_current_window()
            observe(client, info, project, output, record, save, work_deadline, native_display_capture)
            record['status'] = 'observed'
        except Exception as error:
            record.update(status='incomplete', error=canvas_diagnostic.error_record(error))
        finally:
            record['phase'] = 'cleanup'
            try:
                save()
            except Exception as error:
                record['cleanupErrors'].append(canvas_diagnostic.error_record(error))
            if client is not None and client.session_id:
                client._browser_deadline = client._preparation_deadline = deadline - 5
                for action in (lambda: client.execute(CLEANUP) if record.get('inViewerFrame') else None,
                               lambda: client.call('WebDriver:SwitchToFrame', {'id': None}),
                               lambda: client.execute(TEARDOWN), client.close):
                    try:
                        remaining(deadline - 5);action()
                    except Exception as error:
                        record['cleanupErrors'].append(canvas_diagnostic.error_record(error))
            for process in reversed(owned):
                try:
                    stop_owned(process, deadline)
                except Exception as error:
                    record['cleanupErrors'].append(canvas_diagnostic.error_record(error))
            for thread in readers:
                thread.join(timeout=max(0, min(.2, deadline-time.monotonic())))
                if thread.is_alive():record['cleanupErrors'].append({'name': 'FixtureReaderStillAlive'})
            watchdog.cancel();watchdog.join(timeout=.1)
            if record['cleanupErrors'] or record.get('deadlineExceeded') or time.monotonic() > deadline:
                record['status'] = 'incomplete'
            record['phase'] = 'completed';record['durationMs'] = round((time.monotonic()-started)*1000);save()
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--driver', default='/usr/bin/safaridriver')
    parser.add_argument('--native-display-capture', action='store_true')
    args = parser.parse_args()
    result = run(args.output.resolve(), args.driver, args.native_display_capture)
    print('Viewer presentation diagnostic: ' + result['status'] + '; never acceptance evidence', flush=True)
    return int(result['status'] != 'observed')


if __name__ == '__main__':
    sys.exit(main())
