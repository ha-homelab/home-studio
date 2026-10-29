const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readTapTarget,sampleFailedTap,tapWithDiagnostics} = require('./browser-tap-diagnostics.cjs');

test('target evidence records geometry and hit testing without element content', () => {
  const target = {isConnected:true,hidden:false,matches:()=>false,contains:()=>false,
    getBoundingClientRect:()=>({x:1,y:2,width:30,height:20}),textContent:'not retained'};
  const env = {target,performance:{now:()=>10},scrollX:0,scrollY:5,innerWidth:820,innerHeight:1180,
    document:{elementFromPoint:(x,y)=>{assert.equal(x,16);assert.equal(y,12);return target;},
      visibilityState:'visible',hasFocus:()=>true},
    getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1',pointerEvents:'auto'})};
  env.window = env;env.parent=env;
  const value=JSON.parse(JSON.stringify(vm.runInNewContext(`(${readTapTarget})(target)`,env)));
  assert.deepEqual(value.bounds,[1,2,30,20]);assert.equal(value.receivesInput,true);
  assert.deepEqual(value.lifecycle.scroll,[0,5]);assert.equal(value.parent.focused,true);
  assert(!JSON.stringify(value).includes('not retained'));
});

test('post-failure probe has a finite timer and releases its RAF and interval', async () => {
  let now=0,frame,interval,finish,activeFrame=false,activeInterval=false;
  const env={performance:{now:()=>now},
    requestAnimationFrame:fn=>{frame=fn;activeFrame=true;return 1;},
    cancelAnimationFrame:id=>{assert.equal(id,1);activeFrame=false;},
    setInterval:(fn,ms)=>{assert.equal(ms,50);interval=fn;activeInterval=true;return 2;},
    clearInterval:id=>{assert.equal(id,2);activeInterval=false;},
    setTimeout:(fn,ms)=>{assert.equal(ms,500);finish=fn;}};
  const result=vm.runInNewContext(`(${sampleFailedTap})()`,env);
  for(let i=0;i<100;i++){now+=5;frame(now);interval();}
  finish();const value=await result;
  assert.equal(value.scope,'after-input-failure');assert.equal(value.durationMs,500);
  assert.equal(value.raf.length,40);assert.equal(value.timers.length,20);
  assert(!activeFrame && !activeInterval);
});

function fixture({tapError,probeError,disposeError,stallDispose=false,stallBefore=false}={}) {
  const calls=[],record={},target={
    async evaluate(fn){calls.push(fn.name);if(fn===sampleFailedTap){if(probeError)throw probeError;return {scope:'after-input-failure'};}if(stallBefore)return new Promise(()=>{});return {bounds:[0,0,20,20]};},
    async dispose(){calls.push('dispose');if(stallDispose)return new Promise(()=>{});if(disposeError)throw disposeError;}};
  const locator={async elementHandle(){calls.push('handle');return target;}};
  const input={async tap(value){assert.equal(value,locator);calls.push('tap');if(tapError)throw tapError;}};
  const bounded=async(fn,ms,label)=>{
    assert.equal(ms,label==='Post-failure tap evidence'?1500:500);
    let timer;
    try{return await Promise.race([fn(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timed out')),10);})]);}
    finally{clearTimeout(timer);}
  };
  return {calls,record,run:()=>tapWithDiagnostics(locator,input,record,bounded)};
}

test('successful input is sent once and never starts the diagnostic RAF probe',async()=>{
  const f=fixture();await f.run();assert.equal(f.record.status,'passed');
  assert.deepEqual(f.calls,['handle','readTapTarget','tap','dispose']);
});

test('failed native input stays failed even when diagnostic sampling succeeds',async()=>{
  const error=new Error('real actionability timeout'),f=fixture({tapError:error});
  await assert.rejects(f.run(),e=>e===error);
  assert.deepEqual(f.calls,['handle','readTapTarget','tap','sampleFailedTap','readTapTarget','dispose']);
  assert.equal(f.record.status,'failed');assert(f.record.afterFailure.target);
});

test('a diagnostic or cleanup error does not replace the original input failure',async()=>{
  const error=new Error('real actionability timeout');
  const f=fixture({tapError:error,probeError:new Error('probe stalled'),disposeError:new Error('closed')});
  await assert.rejects(f.run(),e=>e===error);
  assert.match(f.record.diagnosticError,/probe stalled/);assert.match(f.record.cleanupError,/closed/);
  assert.equal(f.calls.filter(x=>x==='tap').length,1);
});

test('cleanup failure on otherwise successful input still fails acceptance',async()=>{
  const f=fixture({disposeError:new Error('dispose failed')});await assert.rejects(f.run(),/dispose failed/);
});

test('a stalled handle disposal cannot hide the original native failure',async()=>{
  const error=new Error('native timeout'),f=fixture({tapError:error,stallDispose:true});
  await assert.rejects(f.run(),e=>e===error);assert.match(f.record.cleanupError,/timed out/);
});

test('a stalled pre-read is bounded and cannot prevent the one native tap',async()=>{
  const f=fixture({stallBefore:true});await f.run();
  assert.equal(f.record.status,'passed');assert.match(f.record.beforeError,/timed out/);
  assert.equal(f.calls.filter(x=>x==='tap').length,1);
});
