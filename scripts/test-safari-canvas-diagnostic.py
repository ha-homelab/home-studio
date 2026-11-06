#!/usr/bin/env python3
"""Check the diagnostic matrix and lifecycle without launching Safari."""
import importlib.util
import json
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('diagnostic', Path(__file__).with_name('diagnose-safari-canvas.py'))
diagnostic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostic)


class DiagnosticTests(unittest.TestCase):
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
                patch.object(diagnostic.safari, 'SafariWebDriver', return_value=client):
            result = diagnostic.run(Path(temp), '/mock/driver')
        self.assertEqual(result['status'], 'observed')
        self.assertFalse(result['acceptanceEvidence'])
        self.assertEqual(len(result['pages']), 2)
        self.assertEqual(client._browser_deadline, client._preparation_deadline)
        client.close.assert_called_once()
        driver.kill.assert_called_once()
        self.assertEqual(sum(call.args[0] == diagnostic.CLEANUP for call in client.execute.call_args_list), 2)
        self.assertEqual([call.args[0] for call in client.execute.call_args_list],
                         [diagnostic.SETUP, diagnostic.CLEANUP, diagnostic.SETUP,
                          diagnostic.CLEANUP, diagnostic.WEBGL])


if __name__ == '__main__':
    unittest.main()
