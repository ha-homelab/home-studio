// Deterministic DOM-only frames: no browser, GPU, Home Assistant or device calls.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../marker-motion.js'),'utf8');
class Target{
  constructor(){this.listeners=new Map();}
  addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn);}
  removeEventListener(name,fn){this.listeners.get(name)?.delete(fn);}
  dispatch(name){for(const fn of this.listeners.get(name)||[])fn();}
}
function fixture(reducedMotion=false){
  let now=0,serial=0;const frames=new Map(),document=new Target(),window=new Target(),media=new Target();
  document.hidden=false;media.matches=reducedMotion;window.matchMedia=query=>{assert.equal(query,'(prefers-reduced-motion: reduce)');return media;};
  // Any scene/layout interaction would fail because neither API is provided.
  const context=vm.createContext({document,window,performance:{now:()=>now},
    requestAnimationFrame(fn){frames.set(++serial,fn);return serial;},cancelAnimationFrame:id=>frames.delete(id)});
  vm.runInContext(source,context);const motion=context.createMarkerMotion();
  function element(){return {style:{},hidden:false,isConnected:true};}
  function position(element){const match=element.style.transform.match(/^translate3d\(([-\d.e+]+)px,([-\d.e+]+)px,0\) translate\(-50%,-50%\)$/);assert(match,'the button retains centering after its screen-space translation');return [+match[1],+match[2]];}
  function at(time,flush=true,frameTime=time){assert(time>=now);now=time;if(flush){const pending=[...frames.values()];frames.clear();for(const fn of pending)fn(frameTime);}}
  return {motion,frames,document,window,media,element,position,at};
}
test('initial and unchanged targets are exact and never start an idle animation loop',()=>{
  const f=fixture(),el=f.element();f.motion.target(el,100,50);
  assert.deepEqual(f.position(el),[100,50]);assert.equal(el.style.left,'0px');assert.equal(el.style.top,'0px');assert.equal(f.frames.size,0);
  for(let i=0;i<200;i++)f.motion.target(el,100,50);
  assert.equal(f.frames.size,0);f.motion.dispose();
});
test('elapsed-time damping is equivalent at 30, 60 and 144 Hz and stops at the deadline',()=>{
  const positions=[];
  for(const rate of [30,60,144]){
    const f=fixture(),el=f.element();f.motion.target(el,0,0);f.motion.target(el,18,12);
    assert.deepEqual(f.position(el),[0,0]);assert.equal(f.frames.size,1);
    for(let i=1;i*1000/rate<200;i++)f.at(i*1000/rate);
    f.at(200);positions.push(f.position(el));
    const expected=1-Math.exp(-200/80);
    assert(Math.abs(positions.at(-1)[0]-18*expected)<1e-10);
    assert(Math.abs(positions.at(-1)[1]-12*expected)<1e-10);
    f.at(320);assert.deepEqual(f.position(el),[18,12]);assert.equal(f.frames.size,0);
    f.at(1000);assert.equal(f.frames.size,0);f.motion.dispose();
  }
  for(const position of positions)for(let i=0;i<2;i++)assert(Math.abs(position[i]-positions[0][i])<1e-10);
});
test('unchanged camera/state targets cannot extend the settle deadline',()=>{
  const f=fixture(),el=f.element();f.motion.target(el,0,0);f.motion.target(el,20,0);
  for(const time of [50,100,150,200,250,300]){f.at(time);for(let i=0;i<100;i++)f.motion.target(el,20,0);assert.equal(f.frames.size,1);}
  f.at(320);assert.deepEqual(f.position(el),[20,0]);assert.equal(f.frames.size,0);f.motion.dispose();
});
test('a slow preceding scene callback cannot rewind motion with an older RAF timestamp',()=>{
  const f=fixture(),el=f.element();f.motion.target(el,0,0);f.motion.target(el,20,0);
  f.at(100,true,16);assert(Math.abs(f.position(el)[0]-20*(1-Math.exp(-100/80)))<1e-10);
  f.at(320,true,200);assert.deepEqual(f.position(el),[20,0]);assert.equal(f.frames.size,0);f.motion.dispose();
});
test('retargeting integrates the old target and follows the latest position with bounded lag',()=>{
  const f=fixture(),el=f.element();f.motion.target(el,0,0);f.motion.target(el,20,0);
  f.at(80,false);f.motion.target(el,20,10);
  const expected=20*(1-Math.exp(-1));assert(Math.abs(f.position(el)[0]-expected)<1e-10);
  f.at(160);assert(f.position(el)[0]>expected);assert(f.position(el)[1]>0&&f.position(el)[1]<10);
  f.motion.target(el,400,300);const [x,y]=f.position(el);assert(Math.abs(Math.hypot(400-x,300-y)-24)<1e-10);
  assert.equal(f.frames.size,1,'all retargets share one DOM frame');
  f.at(480);assert.deepEqual(f.position(el),[400,300]);assert.equal(f.frames.size,0);f.motion.dispose();
});
test('subpixel moves settle directly, multiple buttons share one callback, and invalid targets are ignored',()=>{
  const f=fixture(),a=f.element(),b=f.element();f.motion.target(a,1,2);f.motion.target(b,3,4);
  f.motion.target(a,1.1,2.1);assert.deepEqual(f.position(a),[1.1,2.1]);assert.equal(f.frames.size,0);
  f.motion.target(a,10,12);f.motion.target(b,13,14);assert.equal(f.frames.size,1);
  for(const [x,y] of [[NaN,0],[0,Infinity],[-Infinity,0]])f.motion.target(a,x,y);
  f.at(320);assert.deepEqual(f.position(a),[10,12]);assert.deepEqual(f.position(b),[13,14]);assert.equal(f.frames.size,0);f.motion.dispose();
});
test('reset snaps pending positions and seeds the next room, floor or resized view immediately',()=>{
  const f=fixture(),el=f.element();f.motion.target(el,0,0);f.motion.target(el,20,20);f.at(30);
  f.motion.reset();assert.equal(f.frames.size,0);assert.deepEqual(f.position(el),[20,20]);
  f.motion.target(el,400,250);assert.deepEqual(f.position(el),[400,250]);assert.equal(f.frames.size,0);f.motion.dispose();
});
test('hidden and detached buttons do not keep frames alive or return with stale motion',()=>{
  const f=fixture(),el=f.element();el.hidden=true;f.motion.target(el,0,0);f.motion.target(el,20,20);
  assert.deepEqual(f.position(el),[20,20]);assert.equal(f.frames.size,0);
  el.hidden=false;f.motion.target(el,100,100);assert.deepEqual(f.position(el),[100,100]);
  f.motion.target(el,110,110);el.hidden=true;f.at(20);assert.equal(f.frames.size,0);assert.deepEqual(f.position(el),[110,110]);
  el.hidden=false;f.motion.target(el,200,200);f.motion.target(el,220,220);el.isConnected=false;f.at(40);assert.equal(f.frames.size,0);
  f.motion.target(el,300,300);assert.equal(f.frames.size,0);
  el.isConnected=true;f.motion.target(el,400,400);assert.deepEqual(f.position(el),[400,400]);assert.equal(f.frames.size,0);f.motion.dispose();
});
test('document and page suspension cancel pending frames and resume without background catch-up',()=>{
  for(const reason of ['visibility','page']){
    const f=fixture(),el=f.element();f.motion.target(el,0,0);f.motion.target(el,20,10);
    if(reason==='visibility'){f.document.hidden=true;f.document.dispatch('visibilitychange');}else f.window.dispatch('pagehide');
    assert.equal(f.frames.size,0);assert.deepEqual(f.position(el),[20,10]);
    f.motion.target(el,40,20);assert.deepEqual(f.position(el),[40,20]);assert.equal(f.frames.size,0);
    if(reason==='visibility'){f.document.hidden=false;f.document.dispatch('visibilitychange');}else f.window.dispatch('pageshow');
    f.at(1000);f.motion.target(el,100,200);assert.deepEqual(f.position(el),[100,200]);assert.equal(f.frames.size,0);f.motion.dispose();
  }
});
test('reduced motion snaps immediately, including a preference change during animation',()=>{
  const f=fixture(true),el=f.element();f.motion.target(el,0,0);f.motion.target(el,20,20);
  assert.deepEqual(f.position(el),[20,20]);assert.equal(f.frames.size,0);
  f.media.matches=false;f.media.dispatch('change');f.motion.target(el,20,20);f.motion.target(el,40,40);assert.equal(f.frames.size,1);
  f.at(40);f.media.matches=true;f.media.dispatch('change');assert.deepEqual(f.position(el),[40,40]);assert.equal(f.frames.size,0);
  f.motion.target(el,80,80);assert.deepEqual(f.position(el),[80,80]);assert.equal(f.frames.size,0);f.motion.dispose();
});
test('disposal cancels animation, removes every listener, and makes later targets inert',()=>{
  const f=fixture(),el=f.element();f.motion.target(el,0,0);f.motion.target(el,20,20);f.motion.dispose();f.motion.dispose();
  assert.equal(f.frames.size,0);const before=el.style.transform;
  for(const target of [f.document,f.window,f.media])for(const handlers of target.listeners.values())assert.equal(handlers.size,0);
  f.motion.target(el,100,100);f.at(1000);assert.equal(el.style.transform,before);assert.equal(f.frames.size,0);
});
