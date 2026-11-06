#!/usr/bin/env python3
"""Check the diagnostic matrix and lifecycle without launching Safari."""
import importlib.util
import hashlib
import json
import os
import re
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('diagnostic', Path(__file__).with_name('diagnose-safari-canvas.py'))
diagnostic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostic)


class DiagnosticTests(unittest.TestCase):
    def test_native_display_capture_validates_owned_png_and_records_exact_bytes(self):
        png = b'\x89PNG\r\n\x1a\n' + b'bounded-test-payload'
        deadline = time.monotonic() + 60
        captured = []
        def command(argv, actual_deadline):
            self.assertEqual(argv[:-1], ['/usr/sbin/screencapture', '-x', '-m', '-t', 'png'])
            self.assertEqual(actual_deadline, deadline)
            path = Path(argv[-1]); captured.append(path)
            self.assertFalse(path.exists())
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
            path.write_bytes(png)
            return {'returncode': 0, 'output': '', 'truncated': False}
        with tempfile.TemporaryDirectory() as temp, patch.object(diagnostic.sys, 'platform', 'darwin'), \
                patch.dict(os.environ, {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted'}), \
                patch.object(diagnostic, 'command_observation', side_effect=command) as observe:
            result = diagnostic.native_display_observation(Path(temp), deadline)
            self.assertEqual(result['status'], 'captured-uninterpreted')
            self.assertEqual((Path(temp) / result['file']).read_bytes(), png)
            self.assertEqual(result['bytes'], len(png))
            self.assertEqual(result['sha256'], hashlib.sha256(png).hexdigest())
            self.assertEqual(result['fileIdentity']['inode'], captured[0].stat().st_ino)
            self.assertLessEqual(result['startedUTC'], result['endedUTC'])
            self.assertGreaterEqual(result['durationMs'], 0)
        observe.assert_called_once()

    def test_native_display_capture_rejects_invalid_outputs_and_does_not_follow_links(self):
        for kind in ('missing', 'empty', 'bad-signature', 'oversized', 'symlink', 'fifo', 'denied', 'timeout'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temp:
                output = Path(temp)
                unrelated = output / 'unrelated.txt'; unrelated.write_text('unchanged')
                captured = []
                def command(argv, _deadline):
                    path = Path(argv[-1]); captured.append(path)
                    if kind == 'empty':
                        path.touch()
                    elif kind == 'bad-signature':
                        path.write_bytes(b'not a png file')
                    elif kind == 'oversized':
                        with path.open('wb') as file:
                            file.write(b'\x89PNG\r\n\x1a\n'); file.truncate(diagnostic.DISPLAY_CAPTURE_MAX_BYTES + 1)
                    elif kind == 'symlink':
                        path.symlink_to(unrelated)
                    elif kind == 'fifo':
                        os.mkfifo(path)
                    elif kind == 'denied':
                        return {'returncode': 1, 'output': 'permission denied', 'truncated': False}
                    elif kind == 'timeout':
                        return {'name': 'TimeoutExpired', 'message': 'capture timeout'}
                    return {'returncode': 0, 'output': '', 'truncated': False}
                with patch.object(diagnostic.sys, 'platform', 'darwin'), \
                        patch.dict(os.environ, {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted'}), \
                        patch.object(diagnostic, 'command_observation', side_effect=command) as observe:
                    result = diagnostic.native_display_observation(output, time.monotonic() + 60)
                self.assertEqual(result['status'], 'inconclusive')
                self.assertNotIn('file', result)
                self.assertFalse(os.path.lexists(captured[0]))
                self.assertEqual(unrelated.read_text(), 'unchanged')
                observe.assert_called_once()

    def test_native_display_capture_rejects_replaced_output_identity(self):
        original_open = os.open
        def command(argv, _deadline):
            Path(argv[-1]).write_bytes(b'\x89PNG\r\n\x1a\nfirst')
            return {'returncode': 0, 'output': '', 'truncated': False}
        def changed_open(path, flags, *args, **kwargs):
            replacement = path.with_name('replacement.png')
            replacement.write_bytes(b'\x89PNG\r\n\x1a\nother')
            replacement.replace(path)
            return original_open(path, flags, *args, **kwargs)
        with tempfile.TemporaryDirectory() as temp, patch.object(diagnostic.sys, 'platform', 'darwin'), \
                patch.dict(os.environ, {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted'}), \
                patch.object(diagnostic, 'command_observation', side_effect=command), \
                patch.object(diagnostic.os, 'open', side_effect=changed_open):
            result = diagnostic.native_display_observation(Path(temp), time.monotonic() + 60)
        self.assertEqual(result['status'], 'inconclusive')
        self.assertIn('identity changed', result['error']['message'])

    def test_native_display_capture_never_runs_outside_hosted_macos_or_with_short_budget(self):
        for platform_name, hosted, seconds in (('linux', 'github-hosted', 60),
                                               ('darwin', 'self-hosted', 60),
                                               ('darwin', 'github-hosted', 5)):
            with self.subTest(platform_name=platform_name, hosted=hosted, seconds=seconds), \
                    tempfile.TemporaryDirectory() as temp, patch.object(diagnostic.sys, 'platform', platform_name), \
                    patch.dict(os.environ, {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': hosted}), \
                    patch.object(diagnostic, 'command_observation') as command:
                result = diagnostic.native_display_observation(Path(temp), time.monotonic() + seconds)
                self.assertEqual(list(Path(temp).iterdir()), [])
            command.assert_not_called()
            self.assertEqual(result['status'], 'inconclusive')

    def test_optional_display_capture_precedes_webdriver_and_preserves_original_failure(self):
        for webdriver_fails in (False, True):
            with self.subTest(webdriver_fails=webdriver_fails):
                events, record, client = [], {}, Mock()
                deadline = time.monotonic() + 60
                client.call.side_effect = lambda name, data: events.append(name) or {'value': {}}
                client.execute.side_effect = lambda script: events.append(script) or {}
                def screenshot(path):
                    events.append(path.name)
                    if webdriver_fails:
                        raise RuntimeError('original WebDriver screenshot error')
                def display(output, actual_deadline):
                    self.assertEqual(actual_deadline, deadline)
                    events.append('native-display')
                    raise TimeoutError('optional capture timeout')
                client.screenshot.side_effect = screenshot
                with tempfile.TemporaryDirectory() as temp, \
                        patch.object(diagnostic, 'native_display_observation', side_effect=display) as capture, \
                        patch.object(diagnostic, 'gpu_fault_observation', return_value={}):
                    diagnostic.observe_task_boundary(client, 'http://127.0.0.1/task-boundary', Path(temp),
                                                     record, lambda: None, deadline, native_display_capture=True)
                self.assertEqual(events[:3], ['WebDriver:Navigate', 'native-display', 'task-boundary-parser-dom.png'])
                self.assertEqual(events[-1], diagnostic.TASK_BOUNDARY_CLEANUP)
                capture.assert_called_once()
                page = record['taskBoundaryComparison']
                self.assertEqual(page['status'], 'incomplete' if webdriver_fails else 'observed')
                self.assertEqual(page['nativeDisplayCapture']['status'], 'inconclusive')
                self.assertIn('intervention', page['initialCaptureScope'])
                if webdriver_fails:
                    self.assertEqual(page['error']['message'], 'original WebDriver screenshot error')
                else:
                    self.assertNotIn('error', page)

    def test_native_display_cli_requires_task_boundary_before_starting_browser(self):
        with patch.object(diagnostic.sys, 'argv', ['diagnostic', '--output', '/unused', '--native-display-capture']), \
                patch.object(diagnostic, 'run') as run, patch.object(diagnostic.sys, 'stderr'):
            with self.assertRaises(SystemExit) as raised:
                diagnostic.main()
        self.assertEqual(raised.exception.code, 2)
        run.assert_not_called()

    def test_parser_control_is_served_without_script_or_external_resource(self):
        server = diagnostic.ThreadingHTTPServer(('127.0.0.1', 0), diagnostic.BlankPage)
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01})
        thread.start()
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{server.server_port}/task-boundary', timeout=2) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers['Cache-Control'], 'no-store')
                body = response.read()
            self.assertEqual(body, diagnostic.TASK_BOUNDARY_HTML)
            self.assertNotRegex(body.lower(), rb'<script|<canvas|\bsrc=|\bhref=|url\(')
            self.assertEqual(body.count(b'>DOM '), 4)
            for color in (b'255,0,0', b'0,255,0', b'0,0,255', b'255,255,255'):
                self.assertIn(b'background:rgb(' + color + b')', body)
            with urllib.request.urlopen(f'http://127.0.0.1:{server.server_port}/', timeout=2) as response:
                self.assertIn(b'<body></body>', response.read())
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=1)
        self.assertFalse(thread.is_alive())

    def test_task_boundary_capture_and_copy_order_retains_original_results(self):
        client, record, events = Mock(), {}, []
        deadline = time.monotonic() + 10
        client.call.side_effect = lambda name, data: events.append(name) or {'value': {'frames': 2}}
        def execute(script):
            events.append(script)
            return {'status': 'readback-failed'}  # Diagnostics must not certify bad pixels.
        client.execute.side_effect = execute
        client.screenshot.side_effect = lambda path: events.append(path.name)
        def logs(actual_deadline):
            self.assertEqual(actual_deadline, deadline)
            events.append('gpu-log')
            return {'status': 'unavailable'}
        with tempfile.TemporaryDirectory() as temp, patch.object(diagnostic, 'gpu_fault_observation', side_effect=logs):
            diagnostic.observe_task_boundary(client, 'http://127.0.0.1/task-boundary', Path(temp),
                                             record, lambda: None, deadline)
        self.assertEqual(events, ['WebDriver:Navigate', 'task-boundary-parser-dom.png',
                                 diagnostic.TASK_BOUNDARY_SETUP, diagnostic.TASK_BOUNDARY_READ,
                                 'WebDriver:ExecuteAsyncScript', 'task-boundary-after-frames.png',
                                 diagnostic.TASK_BOUNDARY_READ, 'gpu-log', diagnostic.TASK_BOUNDARY_CLEANUP])
        page = record['taskBoundaryComparison']
        self.assertEqual(page['status'], 'observed')
        self.assertEqual(page['setupAndSameCall']['status'], 'readback-failed')
        self.assertLessEqual(page['controlStartedUTC'], page['controlEndedUTC'])
        self.assertEqual(page['gpuFaults']['status'], 'unavailable')

    def test_task_boundary_failures_preserve_evidence_and_always_clean_up(self):
        for fail_at in ('first-screenshot', 'second-screenshot', 'next-command'):
            with self.subTest(fail_at=fail_at):
                client, record = Mock(), {}
                captures = 0
                def screenshot(_path):
                    nonlocal captures
                    captures += 1
                    if captures == (1 if fail_at == 'first-screenshot' else 2) and fail_at.endswith('screenshot'):
                        raise RuntimeError('original capture failure')
                def execute(script):
                    if fail_at == 'next-command' and script == diagnostic.TASK_BOUNDARY_READ:
                        raise RuntimeError('original copy failure')
                    return {'sameCall': {'matchedPixels': 4096}}
                client.screenshot.side_effect = screenshot
                client.execute.side_effect = execute
                client.call.return_value = {'value': {'frames': 2}}
                with tempfile.TemporaryDirectory() as temp, patch.object(diagnostic, 'gpu_fault_observation',
                        side_effect=TimeoutError('log timeout with private path')):
                    diagnostic.observe_task_boundary(client, 'http://127.0.0.1/task-boundary', Path(temp),
                                                     record, lambda: None, time.monotonic() + 10)
                page = record['taskBoundaryComparison']
                self.assertEqual(page['status'], 'incomplete')
                self.assertIn('original', page['error']['message'])
                self.assertEqual(page['gpuFaults'], {'status': 'unavailable', 'errorType': 'TimeoutError'})
                client.execute.assert_called_with(diagnostic.TASK_BOUNDARY_CLEANUP)
                self.assertEqual('setupAndSameCall' in page, fail_at != 'first-screenshot')
                self.assertNotIn('afterScreenshot', page)

    def test_task_boundary_expired_budget_issues_no_browser_command(self):
        client, record = Mock(), {}
        with tempfile.TemporaryDirectory() as temp, patch.object(diagnostic, 'gpu_fault_observation', return_value={}):
            diagnostic.observe_task_boundary(client, 'http://127.0.0.1/task-boundary', Path(temp),
                                             record, lambda: None, time.monotonic() - 1)
        self.assertEqual(client.mock_calls, [])
        self.assertEqual(record['taskBoundaryComparison']['error']['name'], 'TimeoutError')

    def test_gpu_log_summary_is_bounded_narrow_and_never_retains_arbitrary_text(self):
        deadline = time.monotonic() + 60
        secret = 'https://private.invalid/path?token=private-value'
        output = '\n'.join([json.dumps({'eventMessage': 'GPUProcessProxy::didClose ' + secret}),
                            json.dumps({'eventMessage': 'AppleParavirtGPU IOGPUScheduler ' + secret}),
                            json.dumps({'eventMessage': 'unrelated ' + secret}), '{truncated'])
        with patch.object(diagnostic, 'command_observation', return_value={
                'returncode': 0, 'output': output, 'truncated': True}) as observe:
            summary = diagnostic.gpu_fault_observation(deadline)
        observe.assert_called_once_with(['/usr/bin/log', 'show', '--style', 'ndjson', '--last', '3m',
                                         '--predicate', diagnostic.GPU_FAULT_PREDICATE], deadline)
        self.assertEqual(summary['matchingEntries'], 2)
        self.assertEqual(summary['signatureCounts']['GPUProcessProxy::didClose'], 1)
        self.assertEqual(summary['signatureCounts']['IOGPUScheduler'], 1)
        self.assertEqual(summary['unparsedLines'], 1)
        self.assertTrue(summary['truncated'])
        self.assertNotIn('private', json.dumps(summary))
        for value in ({'name': 'TimeoutExpired', 'message': secret},
                      {'returncode': 1, 'output': secret, 'truncated': False}):
            with patch.object(diagnostic, 'command_observation', return_value=value):
                summary = diagnostic.gpu_fault_observation(deadline)
            self.assertEqual(summary['status'], 'unavailable')
            self.assertNotIn('private', json.dumps(summary))
        with patch.object(diagnostic, 'command_observation') as observe:
            summary = diagnostic.gpu_fault_observation(time.monotonic() + 5)
        observe.assert_not_called()
        self.assertEqual(summary['errorType'], 'InsufficientRemainingBudget')

    def test_task_boundary_workflow_stays_opt_in_and_cold_mode_skips_preflight(self):
        source = (Path(__file__).resolve().parents[1] / '.github/workflows/safari-macos15-observation.yml').read_text()
        inputs = re.findall(r'^      (\w+):$', source, re.MULTILINE)
        self.assertLess(len(inputs), 10)
        self.assertEqual(inputs.count('canvas_task_boundary'), 1)
        self.assertEqual(inputs.count('native_display_capture'), 1)
        self.assertRegex(source, r'canvas_task_boundary:\n        description:[^\n]+\n        type: boolean\n        default: false')
        self.assertIn('if: ${{ inputs.canvas_diagnostic != true && inputs.canvas_task_boundary != true }}', source)
        self.assertIn('if: ${{ inputs.canvas_diagnostic == true || inputs.canvas_task_boundary == true }}', source)
        self.assertIn('if: ${{ inputs.canvas_diagnostic == true && inputs.canvas_task_boundary != true }}', source)
        self.assertIn('if [[ "$COLD_CANVAS" != "true" ]]; then\n            preparation_args+=(--prepare-hosted-safari)', source)
        self.assertIn('if [[ "$CANVAS_TASK_BOUNDARY" == "true" ]]; then\n            mode_args=(--task-boundary-comparison)', source)
        self.assertIn('if: ${{ inputs.native_display_capture == true && inputs.canvas_task_boundary != true }}', source)
        self.assertIn('if [[ "$NATIVE_DISPLAY_CAPTURE" == "true" ]]; then\n              mode_args+=(--native-display-capture)', source)
        self.assertIn('"${preparation_args[@]}" "${mode_args[@]}" --output', source)
        self.assertNotIn('continue-on-error', source)

    def test_task_boundary_mode_uses_one_owned_session_and_shared_deadline(self):
        client, driver = Mock(), Mock()
        client.session_id = 'owned'; driver.poll.return_value = None
        client.start.return_value = {'sessionId': 'owned'}
        client.select_current_window.return_value = {'focused': True}
        client.call.return_value = {'value': {}}
        client.execute.return_value = {'status': 'readback-failed'}
        with tempfile.TemporaryDirectory() as temp, patch.object(diagnostic.sys, 'platform', 'darwin'), \
                patch.object(diagnostic, 'command_observation', return_value={}), \
                patch.object(diagnostic.subprocess, 'Popen', return_value=driver), \
                patch.object(diagnostic.safari, 'SafariWebDriver', return_value=client), \
                patch.object(diagnostic, 'observe_page') as original, \
                patch.object(diagnostic, 'observe_presentation') as presentation, \
                patch.object(diagnostic, 'observe_window_geometry') as geometry, \
                patch.object(diagnostic, 'observe_extended_page') as extended, \
                patch.object(diagnostic.safari, 'prepare_hosted_safari') as prepare:
            result = diagnostic.run(Path(temp), '/mock/driver', task_boundary_comparison=True)
        for unused in (original, extended, presentation, geometry, prepare):
            unused.assert_not_called()
        self.assertEqual(result['status'], 'observed')
        self.assertFalse(result['acceptanceEvidence'])
        self.assertTrue(result['taskBoundaryComparisonRequested'])
        self.assertEqual(result['budgetMs'], 180000)
        self.assertEqual(client._browser_deadline, client._preparation_deadline)
        self.assertEqual(client.execute.call_args.args, (diagnostic.WEBGL,))
        self.assertEqual(client.screenshot.call_count, 2)
        client.start.assert_called_once(); client.close.assert_called_once()

    def test_task_boundary_native_copy_detects_loss_without_repainting(self):
        script = r"""
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const scripts=JSON.parse(fs.readFileSync(0,'utf8'));
for(const mode of ['good','lost-between-commands','copy-error','no-context','no-frames']){
  const canvases=[],frames=[],timers=new Map();let fills=0,copies=0;
  class Element{
    constructor(){this.children=[];this.style={};this.isConnected=true;}
    appendChild(node){this.children.push(node);node.isConnected=true;}
    getBoundingClientRect(){return {x:16,y:16,width:this.width||180,height:this.height||48};}
  }
  class Context{
    constructor(canvas,options){this.canvas=canvas;this.options=options;this.data=new Uint8ClampedArray(16384);}
    getContextAttributes(){return this.options;} isContextLost(){return false;}
    fillRect(x,y,w,h){fills++;const rgb=this.fillStyle.match(/\d+/g).map(Number);
      for(let row=y;row<y+h;row++)for(let col=x;col<x+w;col++)this.data.set([...rgb,255],(row*64+col)*4);}
    clearRect(){this.data.fill(0);}
    drawImage(source,x,y){assert.equal(x,0);assert.equal(y,0);copies++;
      assert.deepEqual({...source.context.options},{alpha:false});
      assert.deepEqual({...this.options},{alpha:true,willReadFrequently:true});
      if(mode==='copy-error')throw Object.assign(Error('native copy failed'),{name:'InvalidStateError'});
      this.data.set(source.context.data);}
    getImageData(x,y,w,h){assert.deepEqual([x,y,w,h],[0,0,64,64]);return {data:this.data};}
  }
  class Canvas extends Element{
    constructor(){super();this.isConnected=false;this.width=300;this.height=150;canvases.push(this);}
    getContext(kind,options){assert.equal(kind,'2d');return mode==='no-context'?null:(this.context=new Context(this,options));}
    remove(){this.isConnected=false;this.removed=true;}
  }
  const nodes=Object.fromEntries(['parser-canvas-slot','parser-heading','parser-swatches'].map(id=>[id,new Element()]));
  nodes['parser-swatches'].children=Array.from({length:4},()=>new Element());
  const environment={window:{},location:{href:'http://127.0.0.1/task-boundary'},innerWidth:1440,innerHeight:1000,
    devicePixelRatio:2,performance:{now:()=>1},getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),
    document:{getElementById:id=>nodes[id],readyState:'complete',hasFocus:()=>true,visibilityState:'visible',
      createElement(name){assert.equal(name,'canvas');return new Canvas();}},CanvasRenderingContext2D:Context,
    setTimeout(fn,ms){assert.equal(ms,1500);timers.set(1,fn);return 1;},clearTimeout(id){timers.delete(id);},
    requestAnimationFrame(fn){frames.push(fn);return frames.length;},cancelAnimationFrame(){}};
  const context=vm.createContext(environment),run=source=>vm.runInContext('(function(){'+source+'})()',context);
  if(mode==='no-context'){assert.throws(()=>run(scripts.setup),/source context unavailable/);}
  else{
    const first=JSON.parse(JSON.stringify(run(scripts.setup)));
    assert.equal(canvases.length,2);assert.equal(fills,4);assert.equal(copies,1);
    assert.equal(nodes['parser-canvas-slot'].children.length,1);
    assert.deepEqual(first.requestedAttributes,{alpha:false});
    assert.deepEqual(first.requestedReadbackAttributes,{alpha:true,willReadFrequently:true});
    if(mode==='lost-between-commands')canvases[0].context.data.fill(0);
    const next=run(scripts.read);let settled;
    environment.done=value=>{settled=value;};
    vm.runInContext('(function(){'+scripts.settle+'})(done)',context);
    if(mode==='no-frames')timers.get(1)();else while(frames.length)frames.shift()();
    assert.equal(settled.settle.frames,mode==='no-frames'?0:2);
    assert.equal(settled.settle.timedOut,mode==='no-frames');assert.equal(timers.size,0);
    const last=run(scripts.read);
    assert.equal(fills,4);assert.equal(copies,4); // No repaint or source reset across boundaries.
    for(const read of [first.sameCall,next,settled.readback,last]){
      if(mode==='copy-error'){assert.equal(read.status,'readback-failed');assert.equal(read.name,'InvalidStateError');}
      else{assert.equal(read.readbackBytes,16384);assert.equal(read.pixelCount,4096);
        const lost=mode==='lost-between-commands'&&read!==first.sameCall;
        assert.equal(read.matchedPixels,lost?0:4096);assert.equal(read.visiblePixels,lost?0:4096);}
    }
  }
  run(scripts.cleanup);assert.ok(canvases.every(c=>c.removed&&c.width===0&&c.height===0));
  assert.equal(environment.window.__safariTaskBoundary,undefined);
}
"""
        result = subprocess.run(['node', '-e', script], input=json.dumps({
            'setup': diagnostic.TASK_BOUNDARY_SETUP, 'read': diagnostic.TASK_BOUNDARY_READ,
            'settle': diagnostic.TASK_BOUNDARY_SETTLE, 'cleanup': diagnostic.TASK_BOUNDARY_CLEANUP}),
            text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_native_matrix_preserves_first_failure_and_cleans_every_canvas(self):
        script = r"""
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const scripts=JSON.parse(fs.readFileSync(0,'utf8'));
for(const mode of ['good','first-failure','no-frames','no-context']){
  const canvases=[],frames=[],timers=new Map();let released=0;
  function Canvas(){this.isConnected=false;this.removed=false;canvases.push(this);}
  Canvas.prototype.remove=function(){this.isConnected=false;this.removed=true;};
  Canvas.prototype.getContext=function(kind,options){
    if(mode==='no-context')return null;
    if(kind==='2d'){
      const context={data:new Uint8ClampedArray(16384),reads:0,getContextAttributes(){return options||{alpha:true};},
        isContextLost(){return false;},fillRect(x,y,w,h){
          const rgb=this.fillStyle.match(/\d+/g).map(Number);
          for(let row=y;row<y+h;row++)for(let col=x;col<x+w;col++)this.data.set([...rgb,255],(row*64+col)*4);
        }};
      this.context=context;return context;
    }
    assert.equal(kind,'webgl2');
    return {VENDOR:1,RENDERER:2,VERSION:3,COLOR_BUFFER_BIT:4,RGBA:5,UNSIGNED_BYTE:6,
      getContextAttributes(){return {alpha:true};},getParameter(key){return 'native-'+key;},
      getExtension(name){return name==='WEBGL_lose_context'?{loseContext(){released++;}}:null;},
      viewport(){},clearColor(){},clear(){},getError(){return 0;},isContextLost(){return false;}};
  };
  const environment={window:{},Uint8Array,location:{href:'about:blank',origin:'null'},
    document:{readyState:'complete',visibilityState:'visible',hasFocus(){return true;},
      createElement(name){assert.equal(name,'canvas');return new Canvas();},
      body:{appendChild(canvas){canvas.isConnected=true;}}},
    devicePixelRatio:2,innerWidth:1440,innerHeight:1000,screen:{width:1920,height:1080,colorDepth:24},
    navigator:{userAgent:'test-native',hardwareConcurrency:4},performance:{now(){return 10;}},
    setTimeout(fn){timers.set(1,fn);return 1;},clearTimeout(id){timers.delete(id);},
    requestAnimationFrame(fn){frames.push(fn);return frames.length;},cancelAnimationFrame(){},
    CanvasRenderingContext2D:{prototype:{getImageData(x,y,w,h){
      assert.deepEqual([x,y,w,h],[0,0,64,64]);this.reads++;
      if(mode==='first-failure'&&this.reads===1)throw Object.assign(new Error('native backing failure'),{name:'InvalidStateError'});
      return {data:this.data};}}},
    WebGL2RenderingContext:{prototype:{readPixels(x,y,w,h,format,type,data){
      assert.deepEqual([x,y,w,h,format,type],[0,0,64,64,5,6]);
      for(let i=0;i<data.length;i+=4)data.set([255,0,255,255],i);
    }}}
  };
  const context=vm.createContext(environment);
  const initial=JSON.parse(JSON.stringify(vm.runInContext('(function(){'+scripts.setup+'})()',context)));
  assert.equal(initial.cases.length,6);
  assert.deepEqual(initial.cases.map(c=>[c.name,c.attached]),[
    ['alpha-false',true],['default',true],['read-frequently',true],
    ['alpha-false',false],['default',false],['read-frequently',false]]);
  assert.deepEqual(initial.cases[2].requestedAttributes,{alpha:false,willReadFrequently:true});
  let settled;environment.done=value=>{settled=JSON.parse(JSON.stringify(value));};
  vm.runInContext('(function(){'+scripts.settle+'})(done)',context);
  if(mode==='no-frames')timers.get(1)();else while(frames.length)frames.shift()();
  assert.equal(settled.settle.frames,mode==='no-frames'?0:2);
  assert.equal(settled.settle.timedOut,mode==='no-frames');
  assert.equal(timers.size,0);
  assert.equal(canvases.length,6); // No WebGL warmup before the 2D observations.
  for(let i=0;i<6;i++){
    const first=initial.cases[i],last=settled.cases[i];
    if(mode==='no-context'){assert.match(first.setupError.message,/context unavailable/);continue;}
    if(mode==='first-failure'){
      assert.equal(first.immediate.name,'InvalidStateError');
      assert.equal(last.immediate.name,'InvalidStateError');
      assert.match(first.immediate.stack,/native backing failure/);
    }else{assert.equal(first.immediate.matchedPixels,4096);assert.equal(first.immediate.readbackBytes,16384);}
    assert.equal(last.afterSettle.matchedPixels,4096);assert.equal(last.afterSettle.readbackBytes,16384);
    assert.equal(canvases[i].context.reads,2);
  }
  const webgl=vm.runInContext('(function(){'+scripts.webgl+'})()',context);
  assert.equal(canvases.length,7);
  assert.ok(canvases.every(c=>c.removed&&c.width===0&&c.height===0));
  if(mode==='no-context')assert.match(webgl.message,/context unavailable/);
  else{assert.equal(webgl.matchedPixels,4096);assert.equal(webgl.readbackBytes,16384);assert.equal(released,1);}
}
"""
        result = subprocess.run(['node', '-e', script], input=json.dumps({'setup': diagnostic.SETUP, 'settle': diagnostic.SETTLE, 'webgl': diagnostic.WEBGL}),
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_async_transport_failure_retains_immediate_evidence_and_cleans(self):
        client = Mock()
        immediate = {'cases': [{'immediate': {'status': 'readback-failed', 'name': 'InvalidStateError'}}]}
        client.execute.return_value = immediate
        client.call.side_effect = [None, TimeoutError('frame transport deadline')]
        record, snapshots = {'pages': []}, []
        diagnostic.observe_page(client, 'about:blank', record, lambda: snapshots.append(json.loads(json.dumps(record))), time.monotonic() + 10)
        page = record['pages'][0]
        self.assertEqual(page['status'], 'incomplete')
        self.assertEqual(page['immediate'], immediate)
        self.assertEqual(page['error']['name'], 'TimeoutError')
        self.assertEqual(snapshots[1]['pages'][0]['immediate'], immediate)
        client.execute.assert_any_call(diagnostic.CLEANUP)

    def test_expired_budget_does_not_navigate_or_execute(self):
        client, record = Mock(), {'pages': []}
        diagnostic.observe_page(client, 'about:blank', record, lambda: None, time.monotonic() - 1)
        client.call.assert_not_called()
        client.execute.assert_not_called()
        self.assertEqual(record['pages'][0]['status'], 'incomplete')

    def test_run_uses_owned_session_shared_deadline_and_never_certifies_pixels(self):
        client, driver = Mock(), Mock()
        driver.poll.return_value = None
        client.session_id = 'owned'
        client.start.return_value = {'sessionId': 'owned'}
        client.select_current_window.return_value = {'handle': 'owned-window'}
        client.execute.return_value = {'cases': [{'immediate': {'status': 'readback-failed'}}]}
        client.call.return_value = {'value': {'cases': [{'immediate': {'status': 'readback-failed'}}]}}
        with tempfile.TemporaryDirectory() as temp, patch.object(diagnostic.sys, 'platform', 'darwin'), \
                patch.object(diagnostic, 'command_observation', return_value={}), \
                patch.object(diagnostic.subprocess, 'Popen', return_value=driver), \
                patch.object(diagnostic.safari, 'prepare_hosted_safari') as preparation, \
                patch.object(diagnostic.safari, 'SafariWebDriver', return_value=client):
            result = diagnostic.run(Path(temp), '/mock/driver')
        preparation.assert_not_called()
        self.assertEqual(result['preparation'], {'requested': False, 'status': 'not-requested'})
        self.assertEqual(result['status'], 'observed')
        self.assertFalse(result['acceptanceEvidence'])
        self.assertEqual(len(result['pages']), 2)
        self.assertEqual(client._browser_deadline, client._preparation_deadline)
        client.close.assert_called_once()
        driver.kill.assert_called_once()
        self.assertEqual(sum(call.args[0] == diagnostic.CLEANUP for call in client.execute.call_args_list), 2)
        operations = [call.args[0] for call in client.execute.call_args_list]
        self.assertEqual(operations[:8],
                         [diagnostic.SETUP, diagnostic.CLEANUP, diagnostic.SETUP,
                          diagnostic.CLEANUP,
                          diagnostic.EXTENDED_SETUP, diagnostic.EXTENDED_CLEANUP,
                          diagnostic.EXTENDED_SETUP, diagnostic.EXTENDED_CLEANUP])
        self.assertEqual(operations[8], diagnostic.PRESENTATION_SETUP)
        self.assertEqual(operations[-2:], [diagnostic.PRESENTATION_CLEANUP, diagnostic.WEBGL])
        self.assertEqual(len(result['presentation']['cases']), 8)
        self.assertEqual(client.screenshot.call_count, 17)
        self.assertEqual(len(result['extendedPages']), 2)

    def test_presentation_only_skips_prior_probes_and_preserves_capture_order(self):
        client, driver = Mock(), Mock()
        driver.poll.return_value = None
        client.session_id = 'owned'
        client.start.return_value = {'sessionId': 'owned'}
        client.select_current_window.return_value = {'handle': 'owned-window'}
        client.execute.return_value = {}
        client.call.return_value = {'value': {}}
        with tempfile.TemporaryDirectory() as temp, patch.object(diagnostic.sys, 'platform', 'darwin'), \
                patch.object(diagnostic, 'command_observation', return_value={}), \
                patch.object(diagnostic.subprocess, 'Popen', return_value=driver), \
                patch.object(diagnostic.safari, 'prepare_hosted_safari', return_value={'status': 'passed'}) as preparation, \
                patch.object(diagnostic.safari, 'SafariWebDriver', return_value=client), \
                patch.object(diagnostic, 'observe_page') as original, \
                patch.object(diagnostic, 'observe_extended_page') as extended:
            result = diagnostic.run(Path(temp), '/mock/driver', prepare=True, presentation_only=True)
        preparation.assert_called_once()
        self.assertEqual(result['preparation'], {'requested': True, 'status': 'passed'})
        original.assert_not_called(); extended.assert_not_called()
        self.assertEqual(result['status'], 'observed')
        self.assertFalse(result['acceptanceEvidence'])
        calls = [(call[0], call.args) for call in client.mock_calls]
        first_context = next(i for i, (name, args) in enumerate(calls) if name == 'execute' and args[0] == diagnostic.PRESENTATION_START)
        self.assertTrue(any(name == 'screenshot' for name, _ in calls[:first_context]))
        for i, (name, args) in enumerate(calls):
            if name == 'execute' and args[0] == diagnostic.PRESENTATION_PAINT:
                self.assertEqual(calls[i + 1][0], 'screenshot')
                self.assertEqual(calls[i + 2], ('execute', (diagnostic.PRESENTATION_READ,)))
        executes = [call.args[0] for call in client.execute.call_args_list]
        self.assertEqual(executes[-1], diagnostic.WEBGL)
        self.assertEqual(executes.count(diagnostic.PRESENTATION_CLEAR), 8)

    def test_presentation_capture_failure_keeps_paint_and_cleans_case(self):
        client = Mock()
        client.execute.return_value = {'paint': 'retained'}
        client.call.return_value = {'value': {}}
        screenshots = 0
        def capture(_path):
            nonlocal screenshots
            screenshots += 1
            if screenshots == 2:
                raise RuntimeError('Native screenshot failed')
        client.screenshot.side_effect = capture
        record = {}
        with tempfile.TemporaryDirectory() as temp:
            diagnostic.observe_presentation(client, 'http://127.0.0.1/', Path(temp), record, lambda: None, time.monotonic() + 10)
        self.assertEqual(record['presentation']['status'], 'incomplete')
        first = record['presentation']['cases'][0]
        self.assertEqual(first['status'], 'incomplete')
        self.assertEqual(first['palettes'][0]['paint'], {'paint': 'retained'})
        self.assertEqual(len(record['presentation']['cases']), 8)
        client.execute.assert_any_call(diagnostic.PRESENTATION_CLEANUP)

    def test_gui_probe_runs_after_original_dom_capture_before_canvas_with_same_deadline(self):
        client, events, record = Mock(), [], {}
        deadline = time.monotonic() + 10
        client.execute.side_effect = lambda script, *_args: events.append(script) or {}
        client.screenshot.side_effect = lambda path: events.append(path.name)
        client.call.return_value = {'value': {}}
        metadata = {'returncode': 0, 'output': '{"session":{"screenLocked":null}}', 'truncated': False}
        def probe(command, actual_deadline):
            self.assertEqual(command, ['/mock/gui-health'])
            self.assertEqual(actual_deadline, deadline)
            events.append('gui-probe')
            return metadata
        with tempfile.TemporaryDirectory() as temp, patch.object(diagnostic, 'command_observation', side_effect=probe) as observe:
            diagnostic.observe_presentation(client, 'http://127.0.0.1/', Path(temp), record, lambda: None,
                                            deadline, compact=True, gui_health_executable=Path('/mock/gui-health'))
        observe.assert_called_once()
        self.assertEqual(events[:4], [diagnostic.PRESENTATION_SETUP, 'presentation-dom-before-canvas.png',
                                     'gui-probe', diagnostic.PRESENTATION_START])
        self.assertEqual(record['presentation']['guiHealth'], metadata)
        self.assertEqual(record['presentation']['status'], 'observed')
        client.execute.assert_any_call(diagnostic.PRESENTATION_CLEANUP)

    def test_gui_probe_failure_cannot_replace_original_capture_failure(self):
        for probe_failure in (False, True):
            with self.subTest(probe_failure=probe_failure):
                client, record = Mock(), {}
                client.execute.return_value = {'dom': 'retained'}
                client.screenshot.side_effect = RuntimeError('original DOM capture failed')
                failure = {'returncode': 9, 'output': '', 'truncated': False}
                with tempfile.TemporaryDirectory() as temp, patch.object(diagnostic, 'command_observation',
                        side_effect=TimeoutError('metadata timeout') if probe_failure else None,
                        return_value=failure) as observe:
                    diagnostic.observe_presentation(client, 'http://127.0.0.1/', Path(temp), record, lambda: None,
                                                    time.monotonic() + 10, gui_health_executable=Path('/mock/gui-health'))
                observe.assert_called_once()
                page = record['presentation']
                self.assertEqual(page['status'], 'incomplete')
                self.assertEqual(page['error']['message'], 'original DOM capture failed')
                self.assertEqual(page['initialDOM'], {'dom': 'retained'})
                self.assertEqual(page['cases'], [])
                self.assertNotIn('initialDOMScreenshot', page)
                if probe_failure:
                    self.assertEqual(page['guiHealth']['name'], 'TimeoutError')
                else:
                    self.assertEqual(page['guiHealth'], failure)
                client.execute.assert_any_call(diagnostic.PRESENTATION_CLEANUP)

    def test_geometry_mode_uses_three_bounded_stages_in_one_session(self):
        client, driver = Mock(), Mock()
        driver.poll.return_value = None
        client.session_id = 'owned'
        client.start.return_value = {'sessionId': 'owned'}
        client.select_current_window.return_value = {'handle': 'owned-window'}
        client.execute.return_value = {'status': 'readback-failed'}
        def call(name, data=None):
            if name == 'WebDriver:SetWindowRect':
                return {'x': 0, 'y': 31, **data}
            return {'value': {}}
        client.call.side_effect = call
        with tempfile.TemporaryDirectory() as temp, patch.object(diagnostic.sys, 'platform', 'darwin'), \
                patch.object(diagnostic, 'command_observation', return_value={}) as host_observation, \
                patch.object(diagnostic.subprocess, 'Popen', return_value=driver), \
                patch.object(diagnostic.safari, 'SafariWebDriver', return_value=client), \
                patch.object(diagnostic, 'observe_page') as original, \
                patch.object(diagnostic, 'observe_extended_page') as extended:
            result = diagnostic.run(Path(temp), '/mock/driver', window_geometry_comparison=True,
                                    gui_health_executable=Path('/mock/gui-health'))
        original.assert_not_called(); extended.assert_not_called()
        client.start.assert_called_once(); client.close.assert_called_once()
        self.assertEqual(result['status'], 'observed')
        self.assertFalse(result['acceptanceEvidence'])
        self.assertEqual(result['budgetMs'], 180000)
        self.assertTrue(result['windowGeometryComparison'])
        self.assertTrue(result['guiHealthRequested'])
        gui_calls = [call for call in host_observation.call_args_list if call.args[0] == ['/mock/gui-health']]
        self.assertEqual(len(gui_calls), 1)
        self.assertEqual(gui_calls[0].args[1], client._browser_deadline)
        self.assertNotIn('presentation', result)
        comparison = result['geometryComparison']
        self.assertTrue(comparison['restoreRequestCompleted'])
        self.assertNotIn('restoration', comparison)
        stages = comparison['stages']
        self.assertEqual(stages[0]['presentation']['guiHealth'], {})
        self.assertTrue(all('guiHealth' not in stage['presentation'] for stage in stages[1:]))
        self.assertEqual([stage['name'] for stage in stages], ['baseline', 'inside-screen', 'restored'])
        self.assertEqual([(stage['actualWindowRect']['width'], stage['actualWindowRect']['height'])
                          for stage in stages], [(1440, 1000), (960, 640), (1440, 1000)])
        for stage in stages:
            self.assertEqual(stage['actualWindowRect']['y'], 31)
            self.assertEqual(len(stage['presentation']['cases']), 2)
            self.assertEqual([case['name'] for case in stage['presentation']['cases']],
                             ['64x64-fresh-default', '64x64-fresh-cpu'])
            self.assertTrue(all([entry['palette'] for entry in case['palettes']] == ['primary']
                                for case in stage['presentation']['cases']))
        files = [call.args[0].name for call in client.screenshot.call_args_list]
        self.assertEqual(len(files), 9)
        self.assertEqual(len(set(files)), 9)
        operations = [(call[0], call.args) for call in client.mock_calls]
        for index, (name, args) in enumerate(operations):
            if name == 'execute' and args[0] == diagnostic.PRESENTATION_SETUP:
                self.assertEqual(operations[index + 1][0], 'screenshot')
            if name == 'execute' and args[0] == diagnostic.PRESENTATION_PAINT:
                self.assertEqual(args[1:], (0,))
                self.assertEqual(operations[index + 1][0], 'screenshot')
                self.assertEqual(operations[index + 2], ('execute', (diagnostic.PRESENTATION_READ,)))
        starts = [call.args[1:] for call in client.execute.call_args_list
                  if call.args[0] == diagnostic.PRESENTATION_START]
        self.assertEqual(starts, [(64, 64, 'fresh', False), (64, 64, 'fresh', True)] * 3)
        executes = [call.args[0] for call in client.execute.call_args_list]
        self.assertEqual(executes.count(diagnostic.PRESENTATION_CLEAR), 6)
        self.assertEqual(executes.count(diagnostic.PRESENTATION_CLEANUP), 3)
        self.assertEqual(executes[-1], diagnostic.WEBGL)
        self.assertEqual(len([call for call in client.call.call_args_list
                              if call.args[0] == 'WebDriver:SetWindowRect']), 4)

    def test_geometry_capture_failure_retains_evidence_and_restores(self):
        client = Mock()
        client.execute.return_value = {'paint': 'retained'}
        client.call.return_value = {'value': {}}
        captures = 0
        def screenshot(_path):
            nonlocal captures
            captures += 1
            if captures == 5:
                raise RuntimeError('Middle-stage screenshot failed')
        client.screenshot.side_effect = screenshot
        record = {}
        with tempfile.TemporaryDirectory() as temp:
            diagnostic.observe_window_geometry(client, 'http://127.0.0.1/', Path(temp), record,
                                               lambda: None, time.monotonic() + 10)
        comparison = record['geometryComparison']
        self.assertEqual(comparison['status'], 'incomplete')
        self.assertTrue(comparison['restoreRequestCompleted'])
        self.assertEqual([stage['status'] for stage in comparison['stages']],
                         ['observed', 'incomplete', 'observed'])
        failed = comparison['stages'][1]['presentation']['cases'][0]
        self.assertEqual(failed['palettes'][0]['paint'], {'paint': 'retained'})
        self.assertEqual(failed['error']['message'], 'Middle-stage screenshot failed')
        executes = [call.args[0] for call in client.execute.call_args_list]
        self.assertEqual(executes.count(diagnostic.PRESENTATION_CLEAR), 6)
        self.assertEqual(executes.count(diagnostic.PRESENTATION_CLEANUP), 3)

    def test_geometry_failed_final_resize_has_one_bounded_restoration_attempt(self):
        for restore_fails in (False, True):
            with self.subTest(restore_fails=restore_fails):
                client, record = Mock(), {}
                client.execute.return_value = {}
                sizes = []
                def call(name, data=None):
                    if name == 'WebDriver:SetWindowRect':
                        sizes.append(data)
                        if len(sizes) == 3 or (restore_fails and len(sizes) == 4):
                            raise RuntimeError('Resize unavailable')
                        return {'x': 0, 'y': 31, **data}
                    return {'value': {}}
                client.call.side_effect = call
                with tempfile.TemporaryDirectory() as temp:
                    diagnostic.observe_window_geometry(client, 'http://127.0.0.1/', Path(temp), record,
                                                       lambda: None, time.monotonic() + 10)
                comparison = record['geometryComparison']
                self.assertEqual(comparison['status'], 'incomplete')
                self.assertEqual(len(sizes), 4)
                self.assertEqual(sizes[-1], {'width': 1440, 'height': 1000})
                self.assertEqual(comparison['restoreRequestCompleted'], not restore_fails)
                self.assertEqual('error' in comparison['restoration'], restore_fails)
                self.assertEqual(comparison['stages'][-1]['error']['message'], 'Resize unavailable')

    def test_expired_geometry_budget_performs_no_browser_operations(self):
        client, record = Mock(), {}
        with tempfile.TemporaryDirectory() as temp:
            diagnostic.observe_window_geometry(client, 'http://127.0.0.1/', Path(temp), record,
                                               lambda: None, time.monotonic() - 1)
        self.assertEqual(client.mock_calls, [])
        comparison = record['geometryComparison']
        self.assertEqual(comparison['status'], 'incomplete')
        self.assertFalse(comparison['restoreRequestCompleted'])
        self.assertEqual(comparison['restoration']['error']['name'], 'TimeoutError')

    def test_presentation_native_pixels_resize_and_cleanup(self):
        script = r"""
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const scripts=JSON.parse(fs.readFileSync(0,'utf8'));
for(const mode of ['good','stale-copy','no-context']){
  const canvases=[],nodes=[],frames=[],timers=new Map();let stale;
  class Element{
    constructor(tag){this.tag=tag;this.style={};this.children=[];this.isConnected=false;nodes.push(this);}
    appendChild(node){this.children.push(node);node.isConnected=true;}
    remove(){this.isConnected=false;this.removed=true;}
    contains(){return this.isConnected;}
    getBoundingClientRect(){return {x:8,y:8,width:this.width||180,height:this.height||48};}
  }
  class Context{
    constructor(canvas,options){this.canvas=canvas;this.options=options;this.reset();}
    reset(){this.data=new Uint8ClampedArray(this.canvas.width*this.canvas.height*4);}
    getContextAttributes(){return {alpha:true,...this.options};}
    setTransform(...values){assert.deepEqual(values,[1,0,0,1,0,0]);this.identity=true;}
    fillRect(x,y,w,h){const rgb=this.fillStyle.match(/\d+/g).map(Number);
      for(let row=y;row<y+h;row++)for(let col=x;col<x+w;col++)this.data.set([...rgb,255],(row*this.canvas.width+col)*4);}
    clearRect(){this.data.fill(0);}
    drawImage(source){
      let data=source.context.data;
      if(mode==='stale-copy'){if(!stale||stale.length!==data.length)stale=data.slice();data=stale;}
      this.data.set(data);
    }
    getImageData(){assert.equal(this.options.alpha,true,'Only transparent scratch is read');return {data:this.data};}
  }
  class Canvas extends Element{
    constructor(){super('canvas');this.w=300;this.h=150;canvases.push(this);}
    get width(){return this.w;}set width(value){this.w=value;this.context?.reset();}
    get height(){return this.h;}set height(value){this.h=value;this.context?.reset();}
    getContext(kind,options){assert.equal(kind,'2d');if(mode==='no-context')return null;
      return this.context||=new Context(this,options);}
  }
  const body=new Element('body');body.isConnected=true;
  const environment={window:{},document:{body,createElement:tag=>tag==='canvas'?new Canvas():new Element(tag),
    hasFocus:()=>true,visibilityState:'visible',readyState:'complete',elementFromPoint:()=>body},
    getComputedStyle:node=>({display:'block',visibility:'visible',opacity:'1',color:node.style.color||'black',backgroundColor:node.style.backgroundColor||'white'}),
    CanvasRenderingContext2D:Context,innerWidth:1440,innerHeight:948,outerWidth:1440,outerHeight:1000,
    screenX:0,screenY:0,devicePixelRatio:1,screen:{width:1440,height:1000,availWidth:1440,availHeight:1000},
    performance:{now:()=>Date.now()},setTimeout:fn=>{timers.set(1,fn);return 1;},clearTimeout:id=>timers.delete(id),
    requestAnimationFrame:fn=>{frames.push(fn);return frames.length;},cancelAnimationFrame(){}};
  const context=vm.createContext(environment),run=(source,...args)=>{
    environment.args=args;return vm.runInContext('(function(){'+source+'})(...args)',context);};
  const initial=run(scripts.setup);
  assert.equal(canvases.length,0,'DOM-only control must precede every canvas context');
  assert.equal(initial.swatches.length,4);assert.equal(initial.swatches[0].background,'rgb(255,0,0)');
  for(const [w,h] of [[64,64],[934,772]])for(const resize of ['fresh','planner'])for(const cpu of [false,true]){
    stale=null;
    if(mode==='no-context'){assert.throws(()=>run(scripts.start,w,h,resize,cpu),/context unavailable/);run(scripts.clear);continue;}
    const setup=run(scripts.start,w,h,resize,cpu);
    assert.equal(setup.contextAttributes.alpha,false);assert.equal(!!setup.contextAttributes.willReadFrequently,cpu);
    assert.deepEqual(JSON.parse(JSON.stringify(setup.readbackAttributes)),{alpha:true,willReadFrequently:true});
    if(resize==='planner')assert.deepEqual(JSON.parse(JSON.stringify(setup.resizeSteps)),[[300,150],[0,150],[0,h],[w,h]]);
    const source=canvases.at(-2);assert.equal(source.context.identity,true);
    for(const palette of [0,1]){
      run(scripts.paint,palette);
      const immediate=run(scripts.read);
      assert.equal(immediate.pixelCount,w*h);assert.equal(immediate.readbackBytes,w*h*4);
      assert.equal(immediate.matchedPixels,mode==='stale-copy'&&palette===1?0:w*h);
      assert.equal(immediate.visiblePixels,w*h);
      let settled;environment.done=value=>{settled=value;};
      vm.runInContext('(function(){'+scripts.settle+'})(done)',context);
      while(frames.length)frames.shift()();
      assert.equal(settled.settle.frames,2);assert.equal(settled.settle.timedOut,false);
      assert.equal(settled.readback.matchedPixels,immediate.matchedPixels);assert.equal(timers.size,0);
    }
    run(scripts.clear);
    assert.ok(canvases.every(canvas=>canvas.removed&&canvas.width===0&&canvas.height===0));
  }
  run(scripts.cleanup);
  assert.equal(environment.window.__safariPresentation,undefined);
  assert.ok(canvases.every(canvas=>canvas.removed&&canvas.width===0&&canvas.height===0));
  assert.ok(nodes.find(node=>node.id==='native-presentation-control').removed);
}
"""
        result = subprocess.run(['node', '-e', script], input=json.dumps({
            'setup': diagnostic.PRESENTATION_SETUP, 'start': diagnostic.PRESENTATION_START,
            'paint': diagnostic.PRESENTATION_PAINT, 'read': diagnostic.PRESENTATION_READ,
            'settle': diagnostic.PRESENTATION_SETTLE, 'clear': diagnostic.PRESENTATION_CLEAR,
            'cleanup': diagnostic.PRESENTATION_CLEANUP}), text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_extended_native_copy_freshness_encoding_and_cleanup(self):
        script = r"""
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const scripts=JSON.parse(fs.readFileSync(0,'utf8'));
(async()=>{
for(const mode of ['good','stale-copy','copy-error','jpeg-corruption','late-decode',
  'encoding-error','wrong-mime','oversized-uri','invalid-decode-size']){
  const canvases=[],bitmaps=[];let stale;
  class Context{
    constructor(canvas,options){this.canvas=canvas;this.options=options||{};this.data=new Uint8ClampedArray(16384);}
    getContextAttributes(){return {alpha:true,...this.options};}
    fillRect(x,y,w,h){const rgb=this.fillStyle.match(/\d+/g).map(Number);
      for(let row=y;row<y+h;row++)for(let col=x;col<x+w;col++)this.data.set([...rgb,255],(row*64+col)*4);}
    clearRect(){this.data.fill(0);}
    getImageData(x,y,w,h){assert.deepEqual([x,y],[0,0]);assert.ok(w===h&&(w===64||w===1));return {data:w===1?this.data.slice(0,4):this.data};}
    drawImage(source,x,y){
      assert.deepEqual([x,y],[0,0]);
      let data=source.context?.data||source.data;
      if(source.isConnected){
        if(mode==='copy-error')throw Object.assign(new Error('native copy failed'),{name:'InvalidStateError'});
        if(mode==='stale-copy'){stale||=data.slice();data=stale;}
      }
      this.data.set(data);
    }
  }
  function encode(canvas,mime){return new Blob([JSON.stringify({width:64,height:64,data:Array.from(canvas.context.data)})],{type:mime});}
  class Canvas{
    constructor(){this.width=64;this.height=64;this.isConnected=false;canvases.push(this);}
    getContext(kind,options){assert.equal(kind,'2d');return this.context||=new Context(this,options);}
    remove(){this.removed=true;this.isConnected=false;}
    toDataURL(mime,quality){
      assert.ok(mime==='image/png'||mime==='image/jpeg');if(mime==='image/jpeg')assert.equal(quality,.8);
      if(!this.context.options.willReadFrequently){
        if(mode==='encoding-error')return 'data:,';
        if(mode==='wrong-mime')return 'data:text/plain;base64,AAAA';
        if(mode==='oversized-uri')return 'data:'+mime+';base64,'+'A'.repeat(1048576);
      }
      return 'data:'+mime+';base64,'+Buffer.from(JSON.stringify({width:64,height:64,data:Array.from(this.context.data)})).toString('base64');
    }
  }
  class Offscreen extends Canvas{convertToBlob(options){
    assert.deepEqual({...options},{type:'image/jpeg',quality:.85});
    if(mode==='encoding-error'&&!this.context.options.willReadFrequently)
      return Promise.reject(Object.assign(new Error('Native image encoding failed'),{name:'EncodingError'}));
    return Promise.resolve(encode(this,options.type));
  }}
  const environment={window:{},location:{href:'http://127.0.0.1/'},Blob,Uint8Array,performance:{now:()=>Date.now()},
    document:{createElement(name){assert.equal(name,'canvas');return new Canvas();},body:{appendChild(canvas){canvas.isConnected=true;}}},
    CanvasRenderingContext2D:Context,HTMLCanvasElement:Canvas,OffscreenCanvas:Offscreen,
    atob:value=>Buffer.from(value,'base64').toString('binary'),
    setTimeout:(fn,ms)=>setTimeout(fn,mode==='late-decode'?0:ms),clearTimeout,
    async createImageBitmap(blob){
      const parsed=JSON.parse(await blob.text());
      const bitmap={...parsed,data:new Uint8ClampedArray(parsed.data),closed:0,close(){this.closed++;}};
      bitmaps.push(bitmap);
      if(mode==='invalid-decode-size')bitmap.width=32;
      if(mode==='jpeg-corruption'&&blob.type==='image/jpeg')bitmap.data.fill(0);
      if(mode==='late-decode')await new Promise(resolve=>setTimeout(resolve,10));
      return bitmap;
    }
  };
  const context=vm.createContext(environment);
  const first=JSON.parse(JSON.stringify(vm.runInContext('(function(){'+scripts.setup+'})()',context)));
  assert.deepEqual(first.alphaTrueReadFrequently.attributes,{alpha:true,willReadFrequently:true});
  assert.equal(first.alphaTrueReadFrequently.matchedPixels,4096);
  assert.deepEqual(first.alphaTrueReadFrequently.transparentPixel,[0,0,0,0]);
  assert.equal(first.alphaTrueReadFrequently.preservesTransparency,true);
  assert.equal(first.copies.length,2);
  assert.deepEqual(first.copies.map(v=>v.pattern),['primary','changed']);
  if(mode==='copy-error')assert.ok(first.copies.every(v=>v.status==='failed'&&v.name==='InvalidStateError'));
  else{
    assert.equal(first.copies[0].matchedPixels,4096);
    assert.equal(first.copies[1].matchedPixels,mode==='stale-copy'?0:4096);
    assert.ok(first.copies.every(v=>v.readbackBytes===16384));
  }
  const completed=await new Promise(resolve=>{environment.done=resolve;
    vm.runInContext('(function(){'+scripts.encodings+'})(done)',context);});
  assert.equal(completed.encodings.length,6);
  assert.deepEqual(Array.from(completed.encodings,v=>v.name),[
    'canvas-png','canvas-jpeg','offscreen-jpeg','canvas-png-cpu','canvas-jpeg-cpu','offscreen-jpeg-cpu']);
  assert.ok(!JSON.stringify(completed).includes('data:image/'),'Encoded image content is never reported');
  for(const result of completed.encodings){
    if(mode==='late-decode'){assert.equal(result.status,'failed');assert.match(result.message,/2500 ms/);continue;}
    if(mode==='invalid-decode-size'){
      assert.equal(result.status,'failed');assert.equal(result.dimensionsMatch,false);assert.match(result.message,/dimensions/);continue;
    }
    const cpu=result.name.endsWith('-cpu'),offscreen=result.name.startsWith('offscreen-');
    assert.equal(result.willReadFrequentlyRequested,cpu);
    if(mode==='encoding-error'&&!cpu){
      assert.equal(result.status,'failed');
      if(offscreen){assert.equal(result.errorName,'EncodingError');assert.match(result.message,/encoding failed/);}
      else{assert.equal(result.dataURL.length,6);assert.equal(result.dataURL.mimePrefixMatches,false);assert.equal(result.dataURL.emptyImageSentinel,true);}
      continue;
    }
    if(!cpu&&!offscreen&&['wrong-mime','oversized-uri'].includes(mode)){
      assert.equal(result.status,'failed');assert.equal(result.dataURL.emptyImageSentinel,false);
      assert.equal(result.dataURL.mimePrefixMatches,mode==='oversized-uri');
      assert.equal(result.dataURL.length>1048576,mode==='oversized-uri');continue;
    }
    assert.equal(result.status,'pixels-read');assert.equal(result.dimensionsMatch,true);
    assert.equal(result.readbackBytes,16384);assert.ok(result.encodedBytes>0);
    if(!offscreen){assert.equal(result.dataURL.mimePrefixMatches,true);assert.equal(result.dataURL.emptyImageSentinel,false);}
    if(result.mime==='image/png')assert.equal(result.matchedPixels,4096);
    else assert.equal(result.centersWithinTolerance,mode!=='jpeg-corruption');
  }
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(bitmaps.every(b=>b.closed===1),'Every decoded bitmap, including late results, is closed once');
  assert.ok(canvases.every(c=>c.width===0&&c.height===0),'Every canvas backing store is released');
}
})().catch(error=>{console.error(error);process.exitCode=1;});
"""
        result = subprocess.run(['node', '-e', script], input=json.dumps({'setup': diagnostic.EXTENDED_SETUP, 'encodings': diagnostic.ENCODINGS}),
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
