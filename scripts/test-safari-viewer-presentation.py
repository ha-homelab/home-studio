#!/usr/bin/env python3
"""Exercise the viewer presentation diagnostic without launching Safari."""
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('viewer_presentation', Path(__file__).with_name('diagnose-safari-viewer-presentation.py'))
diagnostic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostic)


def project():
    return {'floors': [{'rooms': [{} for _ in range(6)],
                        'items': [{'entity_id': f'light.fixture_{i}', 'name': f'Fixture {i}'} for i in range(18)]}]}


class ViewerPresentationTests(unittest.TestCase):
    def test_fixture_uses_canonical_source_one_case_and_rejects_oversized_startup(self):
        for oversized in (False, True):
            with self.subTest(oversized=oversized):
                info = {'fixtureServer': True, 'origin': 'http://127.0.0.1:1234', 'sourceHash': 'exact'}
                process = Mock();process.poll.return_value = None
                process.stdout = io.StringIO('x'*65537 if oversized else json.dumps(info)+'\n')
                owned, readers = [], []
                with patch.object(diagnostic.subprocess, 'Popen', return_value=process) as start, \
                        patch.object(diagnostic.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(project()).encode())) as fetch:
                    if oversized:
                        with self.assertRaisesRegex(ValueError, 'Oversized'):
                            diagnostic.start_fixture(io.StringIO(), time.monotonic()+5, owned, readers)
                        fetch.assert_not_called()
                    else:
                        result, data = diagnostic.start_fixture(io.StringIO(), time.monotonic()+5, owned, readers)
                        self.assertEqual(result, info);self.assertEqual(data, project())
                self.assertEqual(owned, [process])
                self.assertEqual(start.call_args.args, (['node', str(diagnostic.SCRIPTS/'test-browser-stability.cjs')],))
                options = start.call_args.kwargs
                self.assertTrue(options['start_new_session'])
                self.assertEqual(options['env']['HOME_STUDIO_FIXTURE_ONLY'], '1')
                self.assertEqual(options['env']['BROWSER_STABILITY_ROOMS'], '6')
                self.assertEqual(options['env']['BROWSER_STABILITY_LIGHTS_PER_ROOM'], '3')
                for reader in readers:reader.join(timeout=1);self.assertFalse(reader.is_alive())

    def test_expired_observation_does_not_touch_browser(self):
        client = Mock()
        with self.assertRaises(TimeoutError):
            diagnostic.observe(client, {}, {}, Path('/unused'), {}, lambda: None, time.monotonic()-1)
        self.assertEqual(client.mock_calls, [])

    def test_shared_initializer_is_exact_and_fails_closed_on_contract_changes(self):
        actual = diagnostic.shared_initializer()
        self.assertIn("iframe.sandbox='allow-scripts allow-downloads allow-forms'", actual)
        self.assertIn("type:'map_result'", actual)
        for source in ('def viewer():\n    pass',
                       'def viewer():\n    x = ' + repr(actual) + '\n    y = ' + repr(actual),
                       'def viewer():\n    x = ' + repr(actual.replace("iframe.id='viewer'", "iframe.id='changed'"))):
            with patch.object(diagnostic.inspect, 'getsource', return_value=source):
                with self.assertRaises(ValueError):diagnostic.shared_initializer()

    def test_single_case_order_keeps_capture_failure_separate_and_never_repaints(self):
        for capture_fails in (False, True):
            with self.subTest(capture_fails=capture_fails):
                events, record, client = [], {}, Mock()
                client.call.side_effect = lambda name, data: events.append(name) or {'value': {}}
                client.execute.side_effect = lambda script, *args: events.append(script) or {}
                def capture(path):
                    events.append(path.name)
                    if capture_fails:raise RuntimeError('Screenshot unavailable')
                client.screenshot.side_effect = capture
                with tempfile.TemporaryDirectory() as temp, patch.object(diagnostic.canvas_diagnostic, 'native_display_observation',
                        side_effect=lambda *args: events.append('OS-capture') or {'status': 'inconclusive'}):
                    diagnostic.observe(client, {'origin': 'http://127.0.0.1:1234'}, project(), Path(temp),
                                       record, lambda: None, time.monotonic()+60, True)
                start = events.index('viewer-before-diagnostic.png')
                self.assertEqual(events[start:], ['viewer-before-diagnostic.png', diagnostic.SETUP_AND_RENDER,
                    diagnostic.READ, 'WebDriver:ExecuteAsyncScript', 'OS-capture', 'viewer-after-frames.png', diagnostic.READ])
                self.assertEqual(events.count(diagnostic.SETUP_AND_RENDER), 1)
                self.assertIn('afterScreenshot', record)
                self.assertEqual('originalScreenshotError' in record, capture_fails)
                self.assertEqual('afterFramesScreenshotError' in record, capture_fails)
                init_call = next(call for call in client.execute.call_args_list if call.args[0] == diagnostic.shared_initializer())
                self.assertEqual(len(init_call.args[1]), 18)
                self.assertEqual(init_call.args[2]['sun.sun'], {'state': 'above_horizon', 'elevation': 30})

    def test_run_uses_one_session_shared_deadline_and_cleanup_on_original_error(self):
        for fails in (False, True):
            with self.subTest(fails=fails):
                client, driver, fixture = Mock(), Mock(), Mock()
                client.session_id = 'owned';driver.poll.return_value = None
                client.start.return_value = {'capabilities': {'browserName': 'safari', 'browserVersion': '27.2'}}
                client.select_current_window.return_value = {'handle': 'owned'}
                client.call.return_value = {'value': {}}
                def execute(script, *args):
                    if fails and script == diagnostic.SETUP_AND_RENDER:raise RuntimeError('Original read failure')
                    return {}
                client.execute.side_effect = execute
                work_deadlines = []
                def start(log, deadline, owned, readers):
                    work_deadlines.append(deadline);owned.append(fixture)
                    return {'origin': 'http://127.0.0.1:1234', 'sourceFiles': {'viewer.js': 'actual-source'}}, project()
                with tempfile.TemporaryDirectory() as temp, patch.object(diagnostic.sys, 'platform', 'darwin'), \
                        patch.dict(os.environ, {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'ImageVersion': 'exact-image'}), \
                        patch.object(diagnostic, 'start_fixture', side_effect=start), \
                        patch.object(diagnostic.canvas_diagnostic, 'command_observation', return_value={}), \
                        patch.object(diagnostic.subprocess, 'Popen', return_value=driver), \
                        patch.object(diagnostic.safari, 'SafariWebDriver', return_value=client), \
                        patch.object(diagnostic, 'stop_owned') as stop:
                    result = diagnostic.run(Path(temp))
                self.assertEqual(result['status'], 'incomplete' if fails else 'observed')
                self.assertEqual(result['budgetMs'], 180000);self.assertEqual(result['cleanupReserveMs'], 10000)
                self.assertFalse(result['acceptanceEvidence'])
                self.assertEqual(result['host']['ImageVersion'], 'exact-image')
                self.assertEqual(result['fixture']['sourceFiles'], {'viewer.js': 'actual-source'})
                self.assertEqual(client._browser_deadline, client._preparation_deadline)
                self.assertAlmostEqual(client._browser_deadline-work_deadlines[0], 5)
                client.start.assert_called_once();client.close.assert_called_once()
                client.execute.assert_any_call(diagnostic.CLEANUP);client.execute.assert_any_call(diagnostic.TEARDOWN)
                self.assertEqual([call.args[0] for call in stop.call_args_list], [driver, fixture])
                self.assertAlmostEqual(stop.call_args.args[1]-work_deadlines[0], 10)
                if fails:self.assertEqual(result['error']['message'], 'Original read failure')

    def test_nonhosted_run_starts_no_fixture_or_browser(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(diagnostic.sys, 'platform', 'linux'), \
                patch.object(diagnostic, 'start_fixture') as fixture, patch.object(diagnostic.subprocess, 'Popen') as popen:
            result = diagnostic.run(Path(temp))
        self.assertEqual(result['status'], 'incomplete');fixture.assert_not_called();popen.assert_not_called()

    def test_owned_process_group_is_stopped_even_after_its_leader_exits(self):
        for expired in (False, True):
            with self.subTest(expired=expired):
                process = Mock();process.pid = 9876;process.poll.return_value = 0
                clock, alive = [100.0], [True]
                def kill(pid, value):
                    self.assertEqual(pid, 9876)
                    if not alive[0]:raise ProcessLookupError()
                    if value == signal.SIGKILL:alive[0] = False
                with patch.object(diagnostic.os, 'killpg', side_effect=kill) as calls, \
                        patch.object(diagnostic.time, 'monotonic', side_effect=lambda: clock[0]), \
                        patch.object(diagnostic.time, 'sleep', side_effect=lambda duration: clock.__setitem__(0, clock[0]+duration)):
                    diagnostic.stop_owned(process, 99 if expired else 105)
                signals = [call.args[1] for call in calls.call_args_list if call.args[1]]
                self.assertEqual(signals, [signal.SIGKILL] if expired else [signal.SIGTERM, signal.SIGKILL])
                self.assertFalse(alive[0]);self.assertLessEqual(clock[0], 102)

    def test_expired_cleanup_reports_group_that_survives_kill(self):
        process = Mock();process.pid = 9876;process.poll.return_value = 0
        with patch.object(diagnostic.os, 'killpg') as kill, patch.object(diagnostic.time, 'sleep') as sleep:
            with self.assertRaisesRegex(TimeoutError, 'process group did not stop'):
                diagnostic.stop_owned(process, time.monotonic()-1)
        kill.assert_any_call(9876, signal.SIGKILL);sleep.assert_not_called()

    def test_fixture_startup_failure_cleans_owned_group_without_starting_safari(self):
        fixture = Mock()
        def failed(log, deadline, owned, readers):
            owned.append(fixture)
            raise RuntimeError('Known fixture startup failure')
        with tempfile.TemporaryDirectory() as temp, patch.object(diagnostic.sys, 'platform', 'darwin'), \
                patch.dict(os.environ, {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted'}), \
                patch.object(diagnostic, 'start_fixture', side_effect=failed), \
                patch.object(diagnostic.canvas_diagnostic, 'command_observation', return_value={}), \
                patch.object(diagnostic.subprocess, 'Popen') as popen, patch.object(diagnostic, 'stop_owned') as stop:
            result = diagnostic.run(Path(temp))
        self.assertEqual(result['status'], 'incomplete')
        self.assertEqual(result['error']['message'], 'Known fixture startup failure')
        self.assertEqual(stop.call_args.args[0], fixture);stop.assert_called_once();popen.assert_not_called()

    def test_workflow_is_opt_in_and_preserves_existing_modes_and_defaults(self):
        source = (diagnostic.ROOT / '.github/workflows/safari-macos15-observation.yml').read_text()
        self.assertEqual(len(re.findall(r'^      (\w+):$', source, re.M)), 9)
        self.assertIn('          - xcode-27\n        default: macos-15', source)
        self.assertRegex(source, r'viewer_presentation:\n        description:[^\n]+\n        type: boolean\n        default: false')
        self.assertIn('inputs.i18n_channels != true && inputs.viewer_presentation != true', source)
        self.assertIn('viewer-presentation:\n    if: ${{ inputs.viewer_presentation == true }}', source)
        self.assertIn('run: python3 scripts/test-safari-acceptance.py --prepare-hosted-safari --output acceptance-artifacts/safari', source)
        self.assertIn('if: ${{ inputs.canvas_diagnostic == true || inputs.canvas_task_boundary == true }}', source)
        self.assertIn("- cron: '37 4 * * 2'", source)
        self.assertNotIn('continue-on-error', source)

    def test_native_pixels_restore_gl_state_detect_retention_and_release_cpu_buffers(self):
        source = r"""
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const scripts=JSON.parse(fs.readFileSync(0,'utf8'));
for(const mode of ['good','storage-loss','copy-loss','gl-error','copy-error','new-render','resized','outside-bound','no-frames']){
  const scratch=[],frames=[],timers=new Map();let renders=0,reads=0,copies=0,renderCount=5;
  let pixels=Uint8Array.from({length:64},(_,i)=>i%4===3?255:Math.floor(i/4)+i%4);
  const originalFramebuffer={},originalPackBuffer={};
  const canvas={width:4,height:4,isConnected:true,getBoundingClientRect:()=>({x:1,y:2,width:4,height:4}),getContext:()=>gl};
  const packs=new Map([[5,8],[6,33],[7,5],[8,6]]),readBuffers=new Map([[originalFramebuffer,20],[null,21]]);
  let framebuffer=originalFramebuffer,packBuffer=originalPackBuffer;
  class GL{
    readPixels(x,y,w,h,format,type,data){
      reads++;assert.deepEqual([x,y,w,h,format,type],[0,0,4,4,11,12]);
      assert.equal(framebuffer,null);assert.equal(packBuffer,null);assert.equal(readBuffers.get(null),10);
      assert.deepEqual([...packs.values()],[1,0,0,0]);
      if(mode==='gl-error')throw Error('native GL read failed');
      for(let row=0;row<4;row++)data.set(pixels.slice((3-row)*16,(4-row)*16),row*16);
    }
    getError(){return 0;}
  }
  const gl=new GL();Object.assign(gl,{READ_FRAMEBUFFER_BINDING:1,PIXEL_PACK_BUFFER_BINDING:2,READ_FRAMEBUFFER:3,
    PIXEL_PACK_BUFFER:4,PACK_ALIGNMENT:5,PACK_ROW_LENGTH:6,PACK_SKIP_PIXELS:7,PACK_SKIP_ROWS:8,READ_BUFFER:9,BACK:10,RGBA:11,UNSIGNED_BYTE:12,
    get drawingBufferWidth(){return canvas.width;},get drawingBufferHeight(){return canvas.height;},
    isContextLost:()=>false,getContextAttributes:()=>({alpha:false,antialias:true,preserveDrawingBuffer:true}),
    getParameter:p=>p===1?framebuffer:p===2?packBuffer:p===9?readBuffers.get(framebuffer):packs.get(p),
    bindFramebuffer(target,value){assert.equal(target,3);framebuffer=value;},
    bindBuffer(target,value){assert.equal(target,4);packBuffer=value;},
    readBuffer(value){readBuffers.set(framebuffer,value);},pixelStorei:(p,v)=>packs.set(p,v)});
  Object.defineProperties(gl,{drawingBufferWidth:{get:()=>canvas.width},drawingBufferHeight:{get:()=>canvas.height}});
  class CPU{
    drawImage(source,x,y){copies++;assert.equal(source,canvas);assert.equal(x,0);assert.equal(y,0);
      if(mode==='copy-error')throw Error('native copy failed');this.data=mode==='copy-loss'&&copies>1?new Uint8Array(64):pixels.slice();}
    getImageData(x,y,w,h){assert.deepEqual([x,y,w,h],[0,0,4,4]);return {data:this.data};}
    getContextAttributes(){return {alpha:true,willReadFrequently:true};}
  }
  const environment={window:{floorplan:{get renderCount(){return renderCount;}},
      __browserScene:()=>({renderState:{request:0,delay:0,fallback:0}}),renderModel(){renders++;renderCount++;}},
    document:{querySelector:()=>canvas,visibilityState:'visible',hasFocus:()=>true,
      createElement(tag){assert.equal(tag,'canvas');const c={width:0,height:0,getContext(kind,options){
        assert.equal(kind,'2d');assert.deepEqual({...options},{alpha:true,willReadFrequently:true});return new CPU();}};scratch.push(c);return c;}},
    getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),innerWidth:800,innerHeight:600,devicePixelRatio:1,
    performance:{now:()=>10},Uint8Array,WebGL2RenderingContext:GL,CanvasRenderingContext2D:CPU,
    setTimeout(fn,ms){assert.equal(ms,1500);timers.set(1,fn);return 1;},clearTimeout:id=>timers.delete(id),
    requestAnimationFrame(fn){frames.push(fn);return frames.length;},cancelAnimationFrame(){}};
  const context=vm.createContext(environment),run=s=>vm.runInContext('(function(){'+s+'})()',context);
  if(mode==='outside-bound'){canvas.width=2000001;canvas.height=1;}
  const first=JSON.parse(JSON.stringify(run(scripts.setup)));
  assert.equal(renders,1);assert.equal(first.explicitRenderCalls,1);
  if(mode==='storage-loss')pixels.fill(0);
  if(mode==='new-render')renderCount++;
  if(mode==='resized')canvas.width=0;
  const next=run(scripts.read);let settled;environment.done=value=>{settled=value;};
  vm.runInContext('(function(){'+scripts.settle+'})(done)',context);
  if(mode==='no-frames')timers.get(1)();else while(frames.length)frames.shift()();
  const last=run(scripts.read);
  assert.equal(renders,1);assert.equal(settled.settle.timedOut,mode==='no-frames');assert.equal(timers.size,0);
  assert.equal(framebuffer,originalFramebuffer);assert.equal(packBuffer,originalPackBuffer);
  assert.deepEqual([...packs.values()],[8,33,5,6]);assert.equal(readBuffers.get(null),21);assert.equal(readBuffers.get(originalFramebuffer),20);
  assert.ok(scratch.every(c=>c.width===0&&c.height===0));
  if(mode==='outside-bound'){assert.equal(reads,0);assert.equal(copies,0);}
  else{
    const a=first.sameCall,b=last;
    if(mode==='gl-error'){assert.equal(a.nativeGL.status,'readback-failed');assert.equal(a.cpuCopy.visiblePixels,16);}
    else if(mode==='copy-error'){assert.equal(a.cpuCopy.status,'readback-failed');assert.equal(a.nativeGL.visiblePixels,16);}
    else{assert.equal(a.nativeGL.visiblePixels,16);assert.equal(a.cpuCopy.visiblePixels,16);
      assert.equal(a.nativeGL.topDownFNV1a32,a.cpuCopy.topDownFNV1a32);}
    if(mode==='storage-loss'){assert.equal(b.nativeGL.visiblePixels,0);assert.equal(b.cpuCopy.visiblePixels,0);}
    if(mode==='copy-loss'){assert.equal(b.nativeGL.visiblePixels,16);assert.equal(b.cpuCopy.visiblePixels,0);}
    if(mode==='new-render')assert.equal(b.unchangedSinceExplicitRender,false);
    if(mode==='resized'){assert.equal(b.status,'outside-readback-bound-or-unavailable');assert.equal(reads,1);}
  }
  run(scripts.cleanup);assert.equal(environment.window.__viewerPresentation,undefined);
}
"""
        result = subprocess.run(['node', '-e', source], input=json.dumps({'setup': diagnostic.SETUP_AND_RENDER,
            'read': diagnostic.READ, 'settle': diagnostic.SETTLE, 'cleanup': diagnostic.CLEANUP}), text=True,
            capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
