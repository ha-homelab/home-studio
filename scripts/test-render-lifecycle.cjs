// Exercise the real scheduler and lifecycle handlers with deterministic frames.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const lines = fs.readFileSync(path.join(__dirname, '../viewer.js'), 'utf8').split('\n');
const frames = new Map(), listeners = {}, events = {};
let serial = 0, draws = 0, invalidations = 0, disposals = 0, losses = 0, disconnects = 0;
let box = {width:3840, height:2160};
const buffers = [];
const context = vm.createContext({
  initialViewReady: true, homeView: null, renderCount: 0, camera: {updateProjectionMatrix() {}}, scene: {},
  $() {return {getBoundingClientRect: () => box};},
  document: {hidden: false, addEventListener(type, fn) { events[type] = fn; }},
  window: {addEventListener(type, fn) { events[type] = fn; }},
  requestAnimationFrame(fn) { frames.set(++serial, fn); return serial; },
  cancelAnimationFrame(id) { frames.delete(id); },
  devicePixelRatio: 3,
  renderProfile: {pixels: 2000000},
  wallSheenMotion: {beforeRender() {}, afterRender() {}},
  updateWallOutlines() {}, updateEditorCamera() {}, resize() {},
  invalidateShadows() { invalidations++; }, report3DError(e) { throw e; },
  observer: {disconnect() { disconnects++; }},
  releaseStaticGlassPasses() {}, disposeStaticGlassPasses() {},
  renderer: {
    setDrawingBufferSize(width, height, ratio) { buffers.push([width,height,ratio]); },
    setPixelRatio() {throw Error('Separate pixel-ratio resizing can allocate an oversized intermediate buffer');},
    render() { draws++; }, dispose() { disposals++; }, forceContextLoss() { losses++; },
    domElement: {addEventListener(type, fn) { listeners[type] = fn; }},
  },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../planner/render-capacity.js'), 'utf8').replace('export function ', 'function '), context);
const prefixes = ['let renderRequest=', 'let interactionRenderer=', 'function cancelRender(', 'function requestRender(',
  'function selectRenderProfile(', 'function renderPixelRatio(', 'function drawScene(', 'function render(){',
  "renderer.domElement.addEventListener('webglcontextlost'", "renderer.domElement.addEventListener('webglcontextrestored'",
  "document.addEventListener('visibilitychange'", "window.addEventListener('pagehide'", "window.addEventListener('pageshow'"];
for (const prefix of prefixes) {
  const line = lines.find(value => value.startsWith(prefix));
  assert.ok(line, 'Missing production lifecycle handler: '+prefix);
  vm.runInContext(line, context);
}
const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); };
for(let i=0;i<200;i++) context.requestRender();
assert.equal(draws,0); assert.equal(frames.size,1); flush(); assert.equal(draws,1);
assert.equal(frames.size,0,'The scheduler must not create an idle animation loop');
// Host state bursts update controls immediately and draw only the latest state
// on the next frame. The explicit render API remains available to callers.
const source = lines.join('\n');
const refreshStart = source.indexOf('function refreshEntityPresentation(){');
const refreshEnd = source.indexOf('\nfunction updateHeightCaption()',refreshStart);
assert(refreshStart>=0 && refreshEnd>refreshStart);
let controlUpdates=0;
context.tvEntities={}; context.embedded=false;
context.homeView={refreshControls(){controlUpdates++;}};
vm.runInContext(source.slice(refreshStart,refreshEnd),context);
for(let i=0;i<200;i++)context.refreshEntityPresentation();
assert.equal(controlUpdates,200,'Live controls reflect every received state immediately');
assert.equal(draws,1,'Receiving states does not synchronously redraw the entire scene');
assert.equal(frames.size,1,'State bursts share the existing bounded render scheduler');
flush(); assert.equal(draws,2);
assert.equal(frames.size,0,'A state update does not start an idle render loop');
context.homeView=null;
context.requestRender();
context.window.renderModel();
assert.equal(draws,3,'An explicit draw reflects the current state immediately');
assert.equal(frames.size,0,'An explicit draw satisfies the previously queued frame');
flush();assert.equal(draws,3,'The queued state is not drawn a second time');
let homeVisible=false;
context.homeView={active:true,render(){if(homeVisible){draws++;context.renderCount++;}}};
context.requestRender();context.window.renderModel();
assert.equal(draws,3,'A zero-sized Home stage cannot draw');
assert.equal(frames.size,1,'A no-op explicit draw preserves the pending state frame');
homeVisible=true;flush();assert.equal(draws,4,'The restored Home stage draws the queued state');
context.requestRender();context.window.renderModel();
assert.equal(draws,5);assert.equal(frames.size,0,'A successful explicit Home draw satisfies its pending frame');
context.homeView=null;
draws=1;
for (const renderer of ['ANGLE (Google, SwiftShader Device)', 'llvmpipe (LLVM 19)', 'softpipe', 'Microsoft Basic Render Driver', 'lavapipe', 'Apple Software Renderer']) {
  const profile=context.selectRenderProfile({getExtension:()=>({UNMASKED_RENDERER_WEBGL:1}),getParameter:()=>renderer});
  assert.equal(profile.pixels,250000);
  assert.equal(profile.diffuseLighting,renderer==='Apple Software Renderer');
}
for (const gl of [{getExtension:()=>null}, {getExtension(){throw Error('denied');}},
  ...['Apple M1', 'Apple M1, or similar', 'Apple M2', 'Apple Software Renderer, or similar'].map(renderer =>
    ({getExtension:()=>({UNMASKED_RENDERER_WEBGL:1}),getParameter:()=>renderer}))]) {
  const profile = context.selectRenderProfile(gl);
  assert.equal(profile.pixels,2000000);
  assert.equal(profile.pointShadows,8);
  assert.equal(profile.pointShadowSize,512);
  assert.equal(profile.sunShadowSize,2048);
  assert.equal(profile.diffuseLighting,false);
}
context.renderProfile=context.selectRenderProfile({getExtension:()=>({UNMASKED_RENDERER_WEBGL:1}),getParameter:()=>"SwiftShader"});
assert.ok(1280*800*context.renderPixelRatio(1280,800)**2<=250000.001);
assert.equal(context.renderProfile.pointShadows,2);
assert.equal(context.renderProfile.pointShadowSize,128);
assert.equal(context.renderProfile.sunShadowSize,512);
context.renderProfile=context.selectRenderProfile(null);
assert.equal(context.renderProfile.pointShadows,8);
assert.equal(context.renderProfile.pointShadowSize,512);
assert.equal(context.renderProfile.sunShadowSize,2048);
for(const [w,h] of [[800,600],[3840,2160],[7680,4320]]) {
  const ratio=context.renderPixelRatio(w,h);
  assert.ok(w*h*ratio*ratio<=2000000.001,'Drawing buffers stay within two million pixels');
  assert.ok(ratio<=2);
}
// Exercise the actual resize path, including a large-to-small DPR transition.
const resizeLine = lines.find(value => value.startsWith("let viewSize='';"));
vm.runInContext(resizeLine.split(';const observer=')[0]+';', context);
context.window.resizeModel();
box={width:800,height:600};context.window.resizeModel();
assert.equal(buffers.length,2);
for (const [w,h,r] of buffers) assert.ok(w*h*r*r<=2000000.001);
draws=1;
context.requestRender(); context.document.hidden=true; events.visibilitychange();
assert.equal(frames.size,0); context.requestRender(); context.drawScene({}); assert.equal(draws,1);
context.document.hidden=false; events.visibilitychange(); flush(); assert.equal(draws,2);
let prevented=false;
context.requestRender(); listeners.webglcontextlost({preventDefault(){prevented=true;}});
assert.ok(prevented); assert.equal(frames.size,0); context.requestRender(); context.render(); assert.equal(draws,2);
box={width:600,height:800};context.window.resizeModel();assert.equal(buffers.length,2);
listeners.webglcontextrestored(); assert.equal(invalidations,1); assert.equal(frames.size,0,'A restoration resize already painted the current state');
assert.equal(buffers.length,3,'Restoration applies a resize skipped while context was lost');
assert.equal(context.camera.aspect,.75);flush();assert.equal(draws,3,'Restoration must not redraw the resized frame');
context.requestRender(); events.pagehide({persisted:true});
assert.equal(frames.size,0); assert.equal(disposals,0,'Back-forward cache retains usable resources');
events.pageshow({persisted:true}); flush(); assert.equal(draws,4,'An unchanged-size BFCache return still paints once');
// Initial pageshow must neither duplicate a completed offline frame nor
// cancel the live state that arrived after it was painted.
let before=draws;
events.pageshow({persisted:false});assert.equal(frames.size,0);assert.equal(draws,before);
context.requestRender();const pending=[...frames.keys()];events.pageshow({persisted:false});
assert.deepEqual([...frames.keys()],pending,'Initial pageshow preserves the queued live-state render');
flush();assert.equal(draws,before+1);

// Both resume paths can resize synchronously. That completed draw satisfies
// the resume request; flushing animation callbacks must not paint it again.
for(const kind of ['visibility','bfcache']) {
  before=draws;
  if(kind==='visibility'){context.document.hidden=true;events.visibilitychange();}
  else events.pagehide({persisted:true});
  box={width:box.width+20,height:box.height+10};
  if(kind==='visibility'){context.document.hidden=false;events.visibilitychange();}
  else events.pageshow({persisted:true});
  assert.equal(draws,before+1,kind+' resize paints immediately');
  assert.equal(frames.size,0,kind+' resize does not queue a duplicate');
  flush();assert.equal(draws,before+1);
}

// With no size change, restoration still needs a frame. While hidden, that
// frame waits for visibility instead of drawing into a lost/hidden surface.
before=draws;
listeners.webglcontextlost({preventDefault(){}});listeners.webglcontextrestored();
assert.equal(draws,before);assert.equal(frames.size,1);flush();assert.equal(draws,before+1);
before=draws;context.document.hidden=true;events.visibilitychange();
listeners.webglcontextlost({preventDefault(){}});listeners.webglcontextrestored();
assert.equal(draws,before);assert.equal(frames.size,0);
context.document.hidden=false;events.visibilitychange();flush();assert.equal(draws,before+1);

// A zero-sized Home stage must retain its pending state. It renders when the
// real resize handler sees usable dimensions, with no self-sustaining loop.
context.homeView={active:true,render(){if(box.width&&box.height){draws++;context.renderCount++;}}};
box={width:0,height:0};before=draws;
context.requestRender();events.pageshow({persisted:false});assert.equal(frames.size,1);
flush();assert.equal(draws,before);assert.equal(frames.size,0);
box={width:480,height:320};context.window.resizeModel();assert.equal(draws,before+1);

// pageshow can precede the embedded boot gate, or be the first opportunity to
// paint a visible offline page. Neither order may lose the initial frame.
context.renderCount=0;context.initialViewReady=false;vm.runInContext("viewSize=''",context);
before=draws;events.pageshow({persisted:false});flush();assert.equal(draws,before);
context.initialViewReady=true;context.window.resizeModel();assert.equal(draws,before+1);
events.pageshow({persisted:false});assert.equal(frames.size,0);
context.renderCount=0;vm.runInContext("viewSize=''",context);
before=draws;events.pageshow({persisted:false});assert.equal(draws,before+1);assert.equal(frames.size,0);
context.renderCount=0;vm.runInContext("viewSize=''",context);
context.document.hidden=true;before=draws;events.pageshow({persisted:false});
assert.equal(draws,before);assert.equal(frames.size,0,'Hidden initial pageshow never renders');
context.document.hidden=false;events.visibilitychange();
assert.equal(draws,before+1);assert.equal(frames.size,0,'Visibility paints the initial resize only once');
// A context can restore while its page is still in the back-forward cache.
// Drawing remains suspended until pageshow, then an unchanged size renders once.
before=draws;events.pagehide({persisted:true});
listeners.webglcontextlost({preventDefault(){}});listeners.webglcontextrestored();
assert.equal(draws,before);assert.equal(frames.size,0);
events.pageshow({persisted:true});assert.equal(frames.size,1);flush();assert.equal(draws,before+1);
context.homeView=null;
const beforeTeardown=draws;
context.requestRender(); events.pagehide({persisted:false});
assert.equal(frames.size,0); assert.equal(disposals,1); assert.equal(losses,1); assert.equal(disconnects,1);
context.requestRender(); context.drawScene({}); assert.equal(draws,beforeTeardown);
console.log('PASS: input coalescing, bounded buffers, idle/hidden/lost suspension, restoration and GPU teardown');

// Run the production scheduler, pointer bookkeeping and lifecycle callbacks
// against a clock whose timer and animation-frame queues are independent.
function motionScheduler(diffuse = true) {
  const raf = new Map(), timers = new Map(), handlers = {}, painted = [], errors = [];
  let time = 0, id = 0, width = 800, rejectDraw = false;
  const c = vm.createContext({
    initialViewReady:true, renderCount:0, renderProfile:{diffuseLighting:diffuse,pixels:250000},
    devicePixelRatio:1, THREE:{}, scene:{}, camera:{position:0,updateProjectionMatrix(){}},
    document:{hidden:false,addEventListener:(type,fn)=>handlers[type]=fn},
    window:{addEventListener:(type,fn)=>handlers[type]=fn},
    requestAnimationFrame(fn){raf.set(++id,fn);return id;},
    cancelAnimationFrame(key){raf.delete(key);},
    setTimeout(fn,delay){timers.set(++id,{fn,due:time+delay});return id;},
    clearTimeout(key){timers.delete(key);},
    $(){return {getBoundingClientRect:()=>({width,height:600})};},
    observer:{disconnect(){}},wallSheenMotion:{beforeRender(){},afterRender(){}},
    releaseStaticGlassPasses(){},disposeStaticGlassPasses(){},
    updateWallOutlines(){},updateEditorCamera(){},invalidateShadows(){},
    report3DError(error){errors.push(error.message);},
    createInteractionRenderer(){return {draw(scene,camera,moving){
      if(rejectDraw){rejectDraw=false;throw Error('injected draw failure');}
      painted.push({time,position:camera.position,moving});
    },dispose(){}};},
    renderer:{domElement:{addEventListener:(type,fn)=>handlers[type]=fn},
      render(scene,camera){painted.push({time,position:camera.position,moving:false});},
      setDrawingBufferSize(){},dispose(){},forceContextLoss(){}},
  });
  for(const prefix of prefixes.filter(p=>p!=='function selectRenderProfile('))
    vm.runInContext(lines.find(line=>line.startsWith(prefix)),c);
  c.homeView={active:true,render(){if(width){c.drawScene(c.camera);c.renderCount++;}}};
  vm.runInContext(resizeLine.split(';const observer=')[0]+';',c);
  const input=source.slice(source.indexOf('if(renderProfile.diffuseLighting){\nrenderer.domElement.addEventListener'),source.indexOf('let drag=null;'));
  vm.runInContext(input,c);
  return {c,raf,timers,handlers,painted,errors,
    read:expression=>vm.runInContext(expression,c),
    start(){handlers.pointerdown?.({button:0,pointerId:1,clientX:0,clientY:0});},
    move(position){c.camera.position=position;handlers.pointermove?.({pointerId:1,clientX:position,clientY:0});c.requestRender(true);},
    flush(){const queue=[...raf.values()];raf.clear();queue.forEach(fn=>fn());},
    advance(ms){const end=time+ms;while(true){const next=[...timers].filter(([,v])=>v.due<=end).sort((a,b)=>a[1].due-b[1].due)[0];if(!next)break;time=next[1].due;timers.delete(next[0]);next[1].fn();}time=end;},
    hideStage(){width=0;},showStage(){width=800;},failNextDraw(){rejectDraw=true;},
  };
}
const scheduled=motionScheduler();
scheduled.start();scheduled.move(20);
assert.equal(scheduled.raf.size,1,'The first moved-pointer frame retains ordinary RAF latency');
assert.equal(scheduled.timers.size,0);
scheduled.flush();assert.equal(scheduled.read('interactionPointer.painted'),true);
assert.deepEqual(scheduled.painted,[{time:0,position:20,moving:true}]);
scheduled.advance(10);scheduled.move(30);
const [timer]=scheduled.timers.values();assert.equal(timer.due,74);
scheduled.advance(20);scheduled.move(40);scheduled.move(50);
assert.equal(scheduled.timers.size,1);assert.equal([...scheduled.timers.values()][0],timer,
  'Later input shares the original deadline rather than debouncing it');
scheduled.advance(43);assert.equal(scheduled.raf.size,0);
scheduled.advance(1);assert.equal(scheduled.raf.size,1);scheduled.flush();
assert.deepEqual(scheduled.painted.at(-1),{time:74,position:50,moving:true},
  'A held drag paints the latest camera before pointerup');
assert(scheduled.read('interactionPointer'),'The held-pointer frame does not end the gesture');
assert.equal(scheduled.timers.size,0);assert.equal(scheduled.raf.size,0,'No self-sustaining motion loop');
scheduled.move(60);assert.equal(scheduled.timers.size,1);
scheduled.handlers.pointerup({pointerId:1});
assert.equal(scheduled.timers.size,0);assert.equal(scheduled.raf.size,1);
scheduled.flush();assert.deepEqual(scheduled.painted.at(-1),{time:74,position:60,moving:false},
  'Release cancels the deadline and paints the latest camera at full quality');
scheduled.advance(1000);assert.equal(scheduled.raf.size,0);assert.equal(scheduled.timers.size,0);

for(const release of ['pointerup','pointercancel','lostpointercapture']) {
  const q=motionScheduler();q.start();q.move(20);q.flush();q.move(30);
  q.handlers[release]({pointerId:2});assert.equal(q.timers.size,1,'Unrelated pointers cannot cancel a pending frame');
  q.handlers[release]({pointerId:1});assert.equal(q.timers.size,0);q.flush();
  assert.equal(q.painted.at(-1).moving,false);q.advance(100);assert.equal(q.raf.size,0);
}
for(const change of ['live','explicit','resize']) {
  const q=motionScheduler();q.start();q.move(20);q.flush();q.move(30);
  if(change==='live')q.c.requestRender();
  else if(change==='explicit')q.c.render();
  else q.c.window.resizeModel();
  assert.equal(q.timers.size,0,change+' does not wait for the motion deadline');q.flush();
  assert.equal(q.painted.at(-1).position,30);q.advance(100);assert.equal(q.raf.size,0);
}
for(const transition of ['visibility','context','bfcache','dispose']) {
  const q=motionScheduler();q.start();q.move(20);q.flush();q.move(30);
  if(transition==='visibility'){q.c.document.hidden=true;q.handlers.visibilitychange();}
  else if(transition==='context')q.handlers.webglcontextlost({preventDefault(){}});
  else q.handlers.pagehide({persisted:transition==='bfcache'});
  assert.equal(q.timers.size,0);assert.equal(q.raf.size,0);assert.equal(q.read('interactionPointer'),null);
  q.advance(1000);q.flush();assert.equal(q.painted.length,1,'Suspension leaves no delayed GPU work');
  if(transition==='visibility'){q.c.document.hidden=false;q.handlers.visibilitychange();}
  else if(transition==='context')q.handlers.webglcontextrestored();
  else if(transition==='bfcache')q.handlers.pageshow({persisted:true});
  q.flush();if(transition!=='dispose')assert.equal(q.painted.at(-1).moving,false);
}
const failed=motionScheduler();failed.start();failed.failNextDraw();failed.move(20);failed.flush();
assert.equal(failed.errors.length,1);assert.notEqual(failed.read('interactionPointer.painted'),true,
  'An unsuccessful draw cannot mark the first motion frame complete');
failed.move(30);assert.equal(failed.raf.size,1);assert.equal(failed.timers.size,0);failed.flush();
assert.equal(failed.read('interactionPointer.painted'),true);
const zero=motionScheduler();zero.start();zero.hideStage();zero.move(20);zero.flush();
assert.equal(zero.painted.length,0);assert.notEqual(zero.read('interactionPointer.painted'),true);
zero.showStage();zero.move(30);assert.equal(zero.timers.size,0);zero.flush();assert.equal(zero.painted.length,1);
const normal=motionScheduler(false);normal.move(20);normal.flush();normal.move(30);
assert.equal(normal.raf.size,1);assert.equal(normal.timers.size,0,'Normal rendering never receives the diffuse delay');
normal.flush();assert.equal(normal.painted.length,2);
assert(source.includes('drag.y=e.clientY;requestRender(true)'), 'Editor pointer movement opts into motion scheduling');
const homeSource=fs.readFileSync(path.join(__dirname,'../home-view.js'),'utf8');
assert(homeSource.includes('panY+=(e.clientY-start.lastY)*(camera.top-camera.bottom)/rect.height;window.requestModelRender?.(true)'),
  'Home pointer movement opts into the same scheduler after updating the camera');
console.log('PASS: first motion RAF, fixed held-drag deadlines, latest camera, full-quality release and lifecycle cancellation');
