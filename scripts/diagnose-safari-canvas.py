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

# These probes follow both original 2D pages and precede any WebGL warmup.
EXTENDED_SETUP = r"""
const palettes=[[[255,0,0,255],[0,255,0,255],[0,0,255,255],[255,255,255,255]],
  [[0,255,255,255],[255,0,255,255],[255,255,0,255],[0,0,0,255]]];
const report={url:location.href,copies:[],encodings:[]},canvases=[];
function errorValue(error){return {name:String(error?.name||'').slice(0,128),
  message:String(error?.message||error).slice(0,2048),stack:String(error?.stack||'').slice(0,4096)};}
function canvasFor(options){
  const canvas=document.createElement('canvas');canvases.push(canvas);canvas.width=canvas.height=64;
  const context=options?canvas.getContext('2d',options):canvas.getContext('2d');
  if(!context)throw Error('Native 2D context unavailable');
  return {canvas,context,attributes:typeof context.getContextAttributes==='function'?context.getContextAttributes():null};
}
function paint(context,palette){
  for(let q=0;q<4;q++){
    context.fillStyle='rgb('+palette[q].slice(0,3).join(',')+')';
    context.fillRect((q%2)*32,Math.floor(q/2)*32,32,32);
  }
}
function pixels(context,palette,jpeg=false){
  const data=CanvasRenderingContext2D.prototype.getImageData.call(context,0,0,64,64).data;
  if(data.length!==16384)throw Error('Incomplete native pixel readback');
  let matchedPixels=0;
  for(let y=0;y<64;y++)for(let x=0;x<64;x++){
    const color=palette[(y>=32?2:0)+(x>=32?1:0)],offset=(y*64+x)*4;
    if(color.every((v,c)=>data[offset+c]===v))matchedPixels++;
  }
  const result={status:'pixels-read',readbackBytes:data.length,matchedPixels};
  if(jpeg){
    let maxCenterError=0;const centerPixels=[];
    for(let q=0;q<4;q++){
      const offset=((Math.floor(q/2)*32+16)*64+(q%2)*32+16)*4;
      const value=Array.from(data.slice(offset,offset+4));centerPixels.push(value);
      for(let c=0;c<4;c++)maxCenterError=Math.max(maxCenterError,Math.abs(value[c]-palette[q][c]));
    }
    Object.assign(result,{centerPixels,maxCenterError,centerTolerance:8,centersWithinTolerance:maxCenterError<=8});
  }
  return result;
}
function cleanup(){for(const canvas of canvases){canvas.remove?.();canvas.width=canvas.height=0;}}
const state=window.__safariCanvasExtended={report,canvases,palettes,paint,pixels,errorValue,cleanup,canvasFor};
try{
  const scratch=state.scratch=canvasFor({alpha:true,willReadFrequently:true});
  paint(scratch.context,palettes[0]);
  report.alphaTrueReadFrequently={attributes:scratch.attributes,...pixels(scratch.context,palettes[0])};
  scratch.context.clearRect(0,0,64,64);
  const transparent=CanvasRenderingContext2D.prototype.getImageData.call(scratch.context,0,0,1,1).data;
  report.alphaTrueReadFrequently.transparentPixel=Array.from(transparent);
  report.alphaTrueReadFrequently.preservesTransparency=transparent.length===4&&transparent.every(value=>value===0);
}catch(error){report.alphaTrueReadFrequently={status:'failed',...errorValue(error)};}
try{
  const source=canvasFor({alpha:false});
  (document.body||document.documentElement).appendChild(source.canvas);
  report.sourceAttributes=source.attributes;
  for(let pattern=0;pattern<2;pattern++){
    const result={pattern:pattern===0?'primary':'changed',width:64,height:64};report.copies.push(result);
    try{
      paint(source.context,palettes[pattern]);
      state.scratch.context.clearRect(0,0,64,64);
      CanvasRenderingContext2D.prototype.drawImage.call(state.scratch.context,source.canvas,0,0);
      Object.assign(result,pixels(state.scratch.context,palettes[pattern]));
    }catch(error){Object.assign(result,{status:'failed',...errorValue(error)});}
  }
}catch(error){report.copySetupError=errorValue(error);}
return report;
"""

ENCODINGS = r"""
const done=arguments[arguments.length-1],state=window.__safariCanvasExtended;
const {report,palettes,paint,pixels,errorValue,canvasFor}=state;
const deadline=performance.now()+2500;
function bounded(promise,onLate){
  return new Promise((resolve,reject)=>{
    let settled=false;
    const timer=setTimeout(()=>{settled=true;reject(Error('Encoding diagnostic exceeded 2500 ms'));},Math.max(0,deadline-performance.now()));
    Promise.resolve(promise).then(value=>{
      if(settled){onLate?.(value);return;}settled=true;clearTimeout(timer);resolve(value);
    },error=>{if(settled)return;settled=true;clearTimeout(timer);reject(error);});
  });
}
(async()=>{
  for(const [name,mime,quality,readFrequently] of [
    ['canvas-png','image/png',undefined],['canvas-jpeg','image/jpeg',.8],['offscreen-jpeg','image/jpeg',.85],
    ['canvas-png-cpu','image/png',undefined,true],['canvas-jpeg-cpu','image/jpeg',.8,true],['offscreen-jpeg-cpu','image/jpeg',.85,true]]){
    const result={name,mime,quality:quality??null,willReadFrequentlyRequested:Boolean(readFrequently)};report.encodings.push(result);let bitmap;
    try{
      if(performance.now()>=deadline)throw Error('Encoding diagnostic exceeded 2500 ms');
      let blob;
      if(name.startsWith('offscreen-')){
        const canvas=new OffscreenCanvas(64,64);state.canvases.push(canvas);
        const options=readFrequently?{alpha:false,willReadFrequently:true}:{alpha:false};
        const context=canvas.getContext('2d',options);if(!context)throw Error('Native offscreen context unavailable');
        result.contextAttributes=typeof context.getContextAttributes==='function'?context.getContextAttributes():null;
        paint(context,palettes[0]);
        blob=await bounded(OffscreenCanvas.prototype.convertToBlob.call(canvas,{type:mime,quality}));
      }else{
        const source=canvasFor(readFrequently?{willReadFrequently:true}:undefined);paint(source.context,palettes[0]);result.contextAttributes=source.attributes;
        const uri=HTMLCanvasElement.prototype.toDataURL.call(source.canvas,mime,quality),prefix='data:'+mime+';base64,';
        result.dataURL={type:typeof uri,length:typeof uri==='string'?uri.length:null,
          mimePrefixMatches:typeof uri==='string'&&uri.startsWith(prefix),emptyImageSentinel:uri==='data:,'};
        if(typeof uri!=='string'||!uri.startsWith(prefix)||uri.length>1048576)throw Error('Unexpected or oversized encoded canvas');
        const bytes=Uint8Array.from(atob(uri.slice(prefix.length)),c=>c.charCodeAt(0));
        blob=new Blob([bytes],{type:mime});
      }
      if(!(blob.size>0&&blob.size<=1048576)||blob.type!==mime)throw Error('Invalid encoded image type or size');
      result.encodedBytes=blob.size;
      bitmap=await bounded(createImageBitmap(blob),late=>late.close());
      result.width=bitmap.width;result.height=bitmap.height;
      result.dimensionsMatch=bitmap.width===64&&bitmap.height===64;
      if(!result.dimensionsMatch)throw Error('Decoded dimensions differ from source');
      state.scratch.context.clearRect(0,0,64,64);
      CanvasRenderingContext2D.prototype.drawImage.call(state.scratch.context,bitmap,0,0);
      Object.assign(result,pixels(state.scratch.context,palettes[0],mime==='image/jpeg'));
    }catch(error){Object.assign(result,{status:'failed',...errorValue(error),name,errorName:String(error?.name||'').slice(0,128)});}
    finally{bitmap?.close();}
  }
})().catch(error=>{report.encodingError=errorValue(error);}).finally(()=>{state.cleanup();done(report);});
"""

EXTENDED_CLEANUP = "if(window.__safariCanvasExtended){window.__safariCanvasExtended.cleanup();delete window.__safariCanvasExtended;}return true;"


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


def observe_extended_page(client, url, record, save, deadline):
    page = {'url': url, 'status': 'running'}
    record['extendedPages'].append(page)
    save()
    try:
        remaining(deadline)
        client.call('WebDriver:Navigate', {'url': url})
        page['copies'] = client.execute(EXTENDED_SETUP)
        save()
        remaining(deadline)
        response = client.call('WebDriver:ExecuteAsyncScript', {'script': ENCODINGS, 'args': []})
        page['completed'] = response['value']
        page['status'] = 'observed'
    except Exception as error:
        page.update(status='incomplete', error=error_record(error))
    finally:
        try:
            remaining(deadline)
            client.execute(EXTENDED_CLEANUP)
        except Exception as error:
            page['cleanupError'] = error_record(error)
        save()


def run(output, driver_path, prepare=False):
    output.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    deadline = started + BUDGET_SECONDS
    record = {'schema': 1, 'purpose': 'diagnostic-only', 'acceptanceEvidence': False,
              'status': 'running', 'budgetMs': BUDGET_SECONDS * 1000,
              'sourceRevision': os.environ.get('GITHUB_SHA'), 'pages': [], 'extendedPages': [], 'cleanupErrors': [],
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
            urls = ('about:blank', f'http://127.0.0.1:{server.server_port}/')
            for url in urls:
                observe_page(client, url, record, save, deadline)
            for url in urls:
                observe_extended_page(client, url, record, save, deadline)
            remaining(deadline)
            record['webgl2'] = client.execute(WEBGL)
            save()
            remaining(deadline)
            record['status'] = 'observed' if all(page['status'] == 'observed' and 'cleanupError' not in page for page in record['pages'] + record['extendedPages']) else 'incomplete'
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
