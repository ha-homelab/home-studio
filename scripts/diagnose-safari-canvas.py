#!/usr/bin/env python3
"""Collect native Safari canvas observations; this is never acceptance evidence.

No application code, browser preferences, or ordinary Safari windows are changed.
The optional hosted preparation and WebDriver transport are shared with acceptance.
"""
import argparse
import importlib.util
import json
import os
import platform
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

spec = importlib.util.spec_from_file_location('safari_acceptance', Path(__file__).with_name('test-safari-acceptance.py'))
safari = importlib.util.module_from_spec(spec)
spec.loader.exec_module(safari)
BUDGET_SECONDS = 180

SETUP = r"""
const report={page:{url:location.href,origin:location.origin,readyState:document.readyState,
  focused:document.hasFocus(),visibility:document.visibilityState,devicePixelRatio,
  viewport:[innerWidth,innerHeight],screen:[screen.width,screen.height,screen.colorDepth],
  userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency},cases:[]};
const entries=[],colors=[[255,0,0,255],[0,255,0,255],[0,0,255,255],[255,255,255,255]];
function errorValue(error){return {name:String(error?.name||'').slice(0,128),
  message:String(error?.message||error).slice(0,2048),stack:String(error?.stack||'').slice(0,4096)};}
function read(entry){
  const {canvas,context}=entry;
  const state={connected:canvas.isConnected,width:canvas.width,height:canvas.height};
  try{state.contextLost=typeof context.isContextLost==='function'?context.isContextLost():null;}
  catch(error){state.contextStateError=errorValue(error);}
  try{
    const data=CanvasRenderingContext2D.prototype.getImageData.call(context,0,0,64,64).data;
    let matchedPixels=0;
    for(let y=0;y<64;y++)for(let x=0;x<64;x++){
      const expected=colors[(y>=32?2:0)+(x>=32?1:0)],offset=(y*64+x)*4;
      if(expected.every((value,c)=>data[offset+c]===value))matchedPixels++;
    }
    return {status:'pixels-read',readbackBytes:data.length,matchedPixels,...state};
  }catch(error){return {status:'readback-failed',...errorValue(error),...state};}
}
function cleanup(){for(const entry of entries){entry.canvas.remove();entry.canvas.width=0;entry.canvas.height=0;}}
window.__safariCanvasDiagnostic={report,entries,read,cleanup};
for(const attached of [true,false])for(const [name,options] of [
  ['alpha-false',{alpha:false}],['default',undefined],['read-frequently',{alpha:false,willReadFrequently:true}]]){
  const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;
  const result={kind:'2d',name,attached,requestedAttributes:options||{}};
  const entry={canvas,result};entries.push(entry);report.cases.push(result);
  try{
    if(attached)(document.body||document.documentElement).appendChild(canvas);
    const context=entry.context=options===undefined?canvas.getContext('2d'):canvas.getContext('2d',options);
    if(!context)throw Error('Native 2D context unavailable');
    result.contextAttributes=typeof context.getContextAttributes==='function'?context.getContextAttributes():null;
    for(let q=0;q<4;q++){
      context.fillStyle='rgb('+colors[q].slice(0,3).join(',')+')';
      context.fillRect((q%2)*32,Math.floor(q/2)*32,32,32);
    }
    result.immediate=read(entry);
  }catch(error){result.setupError=errorValue(error);}
}
return report;
"""

# Run after both pages' 2D observations so WebGL cannot warm either backend.
WEBGL = r"""
function errorValue(error){return {name:String(error?.name||'').slice(0,128),
  message:String(error?.message||error).slice(0,2048),stack:String(error?.stack||'').slice(0,4096)};}
const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;
const result={kind:'webgl2',url:location.href,width:64,height:64};let gl;
try{
  (document.body||document.documentElement).appendChild(canvas);
  gl=canvas.getContext('webgl2');if(!gl)throw Error('Native WebGL2 context unavailable');
  result.contextAttributes=gl.getContextAttributes();
  result.vendor=String(gl.getParameter(gl.VENDOR)).slice(0,512);
  result.renderer=String(gl.getParameter(gl.RENDERER)).slice(0,512);
  result.version=String(gl.getParameter(gl.VERSION)).slice(0,512);
  const debug=gl.getExtension('WEBGL_debug_renderer_info');
  if(debug){result.unmaskedVendor=String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)).slice(0,512);
    result.unmaskedRenderer=String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)).slice(0,512);}
  gl.viewport(0,0,64,64);gl.clearColor(1,0,1,1);gl.clear(gl.COLOR_BUFFER_BIT);
  const data=new Uint8Array(64*64*4);
  WebGL2RenderingContext.prototype.readPixels.call(gl,0,0,64,64,gl.RGBA,gl.UNSIGNED_BYTE,data);
  let matchedPixels=0;for(let i=0;i<data.length;i+=4)
    if(data[i]===255&&data[i+1]===0&&data[i+2]===255&&data[i+3]===255)matchedPixels++;
  Object.assign(result,{status:'pixels-read',readbackBytes:data.length,matchedPixels,
    glError:gl.getError(),contextLost:gl.isContextLost()});
}catch(error){Object.assign(result,{status:'readback-failed',...errorValue(error)});}
finally{
  try{if(gl){const lose=gl.getExtension('WEBGL_lose_context');if(lose){lose.loseContext();result.contextReleased=true;}}}
  catch(error){result.cleanupError=errorValue(error);}
  canvas.remove();canvas.width=0;canvas.height=0;
}
return result;
"""

SETTLE = r"""
const done=arguments[arguments.length-1],state=window.__safariCanvasDiagnostic;
let frames=0,finished=false,raf=null;
const started=performance.now();
function finish(timedOut){
  if(finished)return;finished=true;clearTimeout(timer);if(raf!==null)cancelAnimationFrame(raf);
  state.report.settle={frames,timedOut,durationMs:performance.now()-started};
  try{for(const entry of state.entries)if(entry.context)entry.result.afterSettle=state.read(entry);}
  finally{state.cleanup();}
  done(state.report);
}
const timer=setTimeout(()=>finish(true),1500);
raf=requestAnimationFrame(()=>{frames++;raf=requestAnimationFrame(()=>{frames++;finish(false);});});
"""

CLEANUP = "if(window.__safariCanvasDiagnostic){window.__safariCanvasDiagnostic.cleanup();delete window.__safariCanvasDiagnostic;}return true;"


class BlankPage(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        body = b'<!doctype html><html><head><meta charset="utf-8"><title>Native canvas diagnostic</title></head><body></body></html>'
        self.send_response(200 if self.path == '/' else 404)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def remaining(deadline):
    value = deadline - time.monotonic()
    if value <= 0:
        raise TimeoutError('Native Safari diagnostic exhausted its 180-second budget')
    return value


def error_record(error):
    return {'name': type(error).__name__, 'message': str(error)[:4096]}


def command_observation(command, deadline):
    """Keep small, bounded, read-only host observations separate from pixel results."""
    try:
        with tempfile.TemporaryFile() as output:
            result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT,
                                    timeout=min(8, remaining(deadline)), check=False)
            output.seek(0)
            data = output.read(65537)
        return {'returncode': result.returncode, 'output': data[:65536].decode('utf-8', errors='replace'),
                'truncated': len(data) > 65536}
    except Exception as error:
        return error_record(error)


def observe_page(client, url, record, save, deadline):
    page = {'url': url, 'status': 'running'}
    record['pages'].append(page)
    save()
    try:
        remaining(deadline)
        client.call('WebDriver:Navigate', {'url': url})
        page['immediate'] = client.execute(SETUP)
        save()  # Retain first failures even if the frame wait or transport fails.
        remaining(deadline)
        response = client.call('WebDriver:ExecuteAsyncScript', {'script': SETTLE, 'args': []})
        page['settled'] = response['value']
        page['status'] = 'observed'
    except Exception as error:
        page.update(status='incomplete', error=error_record(error))
    finally:
        try:
            remaining(deadline)
            client.execute(CLEANUP)
        except Exception as error:
            page['cleanupError'] = error_record(error)
        save()


def run(output, driver_path, prepare=False):
    output.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    deadline = started + BUDGET_SECONDS
    record = {'schema': 1, 'purpose': 'diagnostic-only', 'acceptanceEvidence': False,
              'status': 'running', 'budgetMs': BUDGET_SECONDS * 1000,
              'sourceRevision': os.environ.get('GITHUB_SHA'), 'pages': [], 'cleanupErrors': [],
              'host': {'platform': sys.platform, 'release': platform.release(),
                       'machine': platform.machine(), 'cpuCount': os.cpu_count(),
                       'imageOS': os.environ.get('ImageOS'), 'imageVersion': os.environ.get('ImageVersion')}}

    def save():
        (output / 'report.json').write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')

    save()
    driver = client = server = server_thread = watchdog = None
    try:
        safari.native.require(sys.platform == 'darwin', 'Native Safari diagnostic requires macOS')
        if prepare:
            record['preparation'] = safari.prepare_hosted_safari(output, driver_path)
            safari.native.require(record['preparation']['status'] == 'passed', 'Hosted Safari preparation failed')
        record['host']['osVersion'] = command_observation(['sw_vers'], deadline)
        record['host']['displays'] = command_observation(['system_profiler', '-json', 'SPDisplaysDataType', '-detailLevel', 'mini'], deadline)
        record['driverVersion'] = command_observation([driver_path, '--version'], deadline)
        server = ThreadingHTTPServer(('127.0.0.1', 0), BlankPage)
        server_thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .1}, daemon=True)
        server_thread.start()
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        with (output / 'driver.log').open('w', encoding='utf-8') as log:
            driver = subprocess.Popen([driver_path, '--port', str(port)], stdout=log, stderr=subprocess.STDOUT)
            client = safari.SafariWebDriver(f'http://127.0.0.1:{port}')
            client._browser_deadline = client._preparation_deadline = deadline
            def expired():
                record['deadlineExceeded'] = True
                if driver.poll() is None:
                    driver.kill()
            watchdog = threading.Timer(remaining(deadline), expired)
            watchdog.daemon = True
            watchdog.start()
            while True:
                remaining(deadline)
                safari.native.require(driver.poll() is None, 'SafariDriver exited before session startup')
                try:
                    client.request('GET', '/status')
                    break
                except urllib.error.URLError:
                    time.sleep(min(.1, remaining(deadline)))
            record['sessionStartup'] = {}
            record['session'] = client.start(record['sessionStartup'])
            client.call('WebDriver:SetTimeouts', {'script': 5000, 'pageLoad': 15000, 'implicit': 0})
            client.call('WebDriver:SetWindowRect', {'width': 1440, 'height': 1000})
            record['windowFocus'] = client.select_current_window()
            for url in ('about:blank', f'http://127.0.0.1:{server.server_port}/'):
                observe_page(client, url, record, save, deadline)
            remaining(deadline)
            record['webgl2'] = client.execute(WEBGL)
            save()
            remaining(deadline)
            record['status'] = 'observed' if all(page['status'] == 'observed' and 'cleanupError' not in page for page in record['pages']) else 'incomplete'
    except Exception as error:
        record.update(status='incomplete', error=error_record(error))
    finally:
        if client and client.session_id:
            try:
                remaining(deadline)
                client.close()
                record['sessionClosed'] = True
            except Exception as error:
                record['cleanupErrors'].append(error_record(error))
        if watchdog:
            watchdog.cancel()
            watchdog.join(timeout=1)
        if driver:
            try:
                if driver.poll() is None:
                    driver.kill()
                driver.wait(timeout=2)
            except Exception as error:
                record['cleanupErrors'].append(error_record(error))
        if server:
            server.shutdown()
            server.server_close()
            server_thread.join(timeout=1)
        if record['cleanupErrors'] or record.get('deadlineExceeded'):
            record['status'] = 'incomplete'
        record['durationMs'] = round((time.monotonic() - started) * 1000)
        save()
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--driver', default='/usr/bin/safaridriver')
    parser.add_argument('--prepare-hosted-safari', action='store_true')
    args = parser.parse_args()
    result = run(args.output.resolve(), args.driver, args.prepare_hosted_safari)
    print(f'Native Safari diagnostic: {result["status"]}; never acceptance evidence', flush=True)
    return int(result['status'] != 'observed')


if __name__ == '__main__':
    sys.exit(main())
