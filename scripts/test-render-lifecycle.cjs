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
  initialViewReady: true, editorFloorMaterials: null, homeView: null, renderCount: 0, camera: {updateProjectionMatrix() {}}, scene: {},
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
  releaseStaticGlassPasses() {}, disposeStaticGlassPasses() {}, releaseViewerGeometryGPU() {}, releaseViewerTextureGPU() {}, releaseWallOutlineMaterials() {},
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
const motionCapacityLine=lines.find(value=>value.startsWith('coalesceMotion='));
assert(motionCapacityLine,'Motion eligibility uses the shared render-capacity decision');
for (const renderer of ['ANGLE (Google, SwiftShader Device)', 'llvmpipe (LLVM 19)', 'softpipe', 'Microsoft Basic Render Driver', 'lavapipe', 'Apple Software Renderer']) {
  let queries=0;
  const gl={getExtension:()=>({UNMASKED_RENDERER_WEBGL:1}),getParameter(){queries++;return renderer;}};
  const profile=context.selectRenderProfile(gl);
  context.renderer.getContext=()=>gl;
  vm.runInContext(motionCapacityLine,context);
  assert.equal(vm.runInContext('coalesceMotion',context),true);
  assert.equal(queries,1,'Scheduling reuses cached capacity without another renderer query');
  assert.equal(profile.pixels,renderer==='Apple Software Renderer'?125000:250000);
  assert.equal(profile.diffuseLighting,renderer==='Apple Software Renderer');
}
for (const gl of [{getExtension:()=>null}, {getExtension(){throw Error('denied');}},
  ...['Apple M1', 'Apple M1, or similar', 'Apple M2', 'Apple Software Renderer, or similar'].map(renderer =>
    ({getExtension:()=>({UNMASKED_RENDERER_WEBGL:1}),getParameter:()=>renderer}))]) {
  const profile = context.selectRenderProfile(gl);
  context.renderer.getContext=()=>gl;
  vm.runInContext(motionCapacityLine,context);
  assert.equal(vm.runInContext('coalesceMotion',context),false,'Unknown or hardware renderers retain normal scheduling');
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
context.renderProfile=context.selectRenderProfile({getExtension:()=>({UNMASKED_RENDERER_WEBGL:1}),getParameter:()=>"Apple Software Renderer"});
for(const [w,h] of [[1280,800],[3840,2160],[800,1280]]) {
  assert.ok(w*h*context.renderPixelRatio(w,h)**2<=125000.001,'Apple diffuse viewer buffers stay within 125,000 pixels');
}
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
function motionScheduler(diffuse = true, reduced = diffuse) {
  const raf = new Map(), timers = new Map(), handlers = {}, painted = [], errors = [], paths = [];
  let time = 0, id = 0, width = 800, rejectDraw = false, drawDuration = 0, clockReads = 0, afterDraw = null;
  const c = vm.createContext({
    editorFloorMaterials:null, initialViewReady:true, renderCount:0, renderProfile:{diffuseLighting:diffuse,pixels:reduced?(diffuse?125000:250000):2000000},
    devicePixelRatio:1, THREE:{}, scene:{}, camera:{position:0,updateProjectionMatrix(){}},
    document:{hidden:false,addEventListener:(type,fn)=>handlers[type]=fn},
    window:{addEventListener:(type,fn)=>handlers[type]=fn},
    performance:{now(){clockReads++;return time;}},
    requestAnimationFrame(fn){raf.set(++id,fn);return id;},
    cancelAnimationFrame(key){raf.delete(key);},
    setTimeout(fn,delay){timers.set(++id,{fn,due:time+delay});return id;},
    clearTimeout(key){timers.delete(key);},
    $(){return {getBoundingClientRect:()=>({width,height:600})};},
    observer:{disconnect(){}},wallSheenMotion:{beforeRender(){},afterRender(){}},
    releaseStaticGlassPasses(){},disposeStaticGlassPasses(){},releaseViewerGeometryGPU(){},releaseViewerTextureGPU(){},releaseWallOutlineMaterials(){},
    updateWallOutlines(){},updateEditorCamera(){},invalidateShadows(){},
    report3DError(error){errors.push(error.message);},
    getRenderCapacity(){return {reduced,diffuseLighting:diffuse};},
    createInteractionRenderer(){assert(diffuse,'PBR must never allocate the reduced-resolution copy renderer');return {draw(scene,camera,moving){
      if(rejectDraw){rejectDraw=false;throw Error('injected draw failure');}
      paths.push('copy');
      painted.push({time,position:camera.position,moving});
      time+=drawDuration;const callback=afterDraw;afterDraw=null;callback?.();
    },dispose(){}};},
    renderer:{domElement:{addEventListener:(type,fn)=>handlers[type]=fn},
      getContext(){return {};},
      render(scene,camera){
        if(rejectDraw){rejectDraw=false;throw Error('injected draw failure');}
        paths.push('direct');painted.push({time,position:camera.position,moving:false});time+=drawDuration;
      },
      setViewport(){throw Error('Motion scheduling must not resize the viewport');},
      setDrawingBufferSize(){},dispose(){},forceContextLoss(){}},
  });
  for(const prefix of prefixes.filter(p=>p!=='function selectRenderProfile('))
    vm.runInContext(lines.find(line=>line.startsWith(prefix)),c);
  c.homeView={active:true,render(){if(width){c.drawScene(c.camera);c.renderCount++;}}};
  vm.runInContext(resizeLine.split(';const observer=')[0]+';',c);
  vm.runInContext(lines.find(line=>line.startsWith('coalesceMotion=')),c);
  const input=source.slice(source.indexOf('if(coalesceMotion){\nrenderer.domElement.addEventListener'),source.indexOf('let drag=null;'));
  vm.runInContext(input,c);
  return {c,raf,timers,handlers,painted,errors,paths,
    read:expression=>vm.runInContext(expression,c),
    start(){handlers.pointerdown?.({button:0,pointerId:1,clientX:0,clientY:0});},
    move(position){c.camera.position=position;handlers.pointermove?.({pointerId:1,clientX:position,clientY:0});c.requestRender(true);},
    flush(){const queue=[...raf.values()];raf.clear();queue.forEach(fn=>fn());},
    advance(ms){const end=time+ms;while(true){const next=[...timers].filter(([,v])=>v.due<=end).sort((a,b)=>a[1].due-b[1].due)[0];if(!next)break;time=next[1].due;timers.delete(next[0]);next[1].fn();}time=end;},
    hideStage(){width=0;},showStage(){width=800;},failNextDraw(){rejectDraw=true;},
    duration(ms){drawDuration=ms;},clockReads:()=>clockReads,now:()=>time,afterNextDraw(callback){afterDraw=callback;},
  };
}
// Both software profiles share scheduling. Only the existing diffuse profile
// may use the copy renderer; reduced=true/diffuse=false keeps direct PBR draws.
for(const diffuse of [true,false]) {
const scheduled=motionScheduler(diffuse,true);
scheduled.start();scheduled.move(20);
assert.equal(scheduled.raf.size,1,'The first moved-pointer frame retains ordinary RAF latency');
assert.equal(scheduled.timers.size,0);
scheduled.flush();assert.equal(scheduled.read('interactionPointer.painted'),true);
assert.deepEqual(scheduled.painted,[{time:0,position:20,moving:diffuse}]);
scheduled.advance(10);scheduled.move(30);
const [timer]=scheduled.timers.values();assert.equal(timer.due,74);
scheduled.advance(20);scheduled.move(40);scheduled.move(50);
assert.equal(scheduled.timers.size,1);assert.equal([...scheduled.timers.values()][0],timer,
  'Later input shares the original deadline rather than debouncing it');
scheduled.advance(43);assert.equal(scheduled.raf.size,0);
scheduled.advance(1);assert.equal(scheduled.raf.size,1);scheduled.flush();
assert.deepEqual(scheduled.painted.at(-1),{time:74,position:50,moving:diffuse},
  'A held drag paints the latest camera before pointerup');
assert(scheduled.read('interactionPointer'),'The held-pointer frame does not end the gesture');
assert.equal(scheduled.timers.size,0);assert.equal(scheduled.raf.size,0,'No self-sustaining motion loop');
scheduled.move(60);assert.equal(scheduled.timers.size,1);
scheduled.handlers.pointerup({pointerId:1});
assert.equal(scheduled.timers.size,0);assert.equal(scheduled.raf.size,1);
scheduled.flush();assert.deepEqual(scheduled.painted.at(-1),{time:74,position:60,moving:false},
  'Release cancels the deadline and paints the latest camera at full quality');
scheduled.advance(1000);assert.equal(scheduled.raf.size,0);assert.equal(scheduled.timers.size,0);
assert(scheduled.paths.every(path=>path===(diffuse?'copy':'direct')));
assert.equal(scheduled.c.renderProfile.pixels,diffuse?125000:250000,'Motion preserves the selected resting pixel budget');
if(!diffuse)assert.equal(scheduled.read('interactionRenderer'),null,'Software PBR never creates a copy target');

for(const release of ['pointerup','pointercancel','lostpointercapture']) {
  const q=motionScheduler(diffuse,true);q.start();q.move(20);q.flush();q.move(30);
  q.handlers[release]({pointerId:2});assert.equal(q.timers.size,1,'Unrelated pointers cannot cancel a pending frame');
  q.handlers[release]({pointerId:1});assert.equal(q.timers.size,0);q.flush();
  assert.equal(q.painted.at(-1).moving,false);q.advance(100);assert.equal(q.raf.size,0);
}
for(const change of ['live','explicit','resize']) {
  const q=motionScheduler(diffuse,true);q.start();q.move(20);q.flush();q.move(30);
  if(change==='live')q.c.requestRender();
  else if(change==='explicit')q.c.render();
  else q.c.window.resizeModel();
  assert.equal(q.timers.size,0,change+' does not wait for the motion deadline');q.flush();
  assert.equal(q.painted.at(-1).position,30);q.advance(100);assert.equal(q.raf.size,0);
}
for(const transition of ['visibility','context','bfcache','dispose']) {
  const q=motionScheduler(diffuse,true);q.start();q.move(20);q.flush();q.move(30);
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
const failed=motionScheduler(diffuse,true);failed.start();failed.failNextDraw();failed.move(20);failed.flush();
assert.equal(failed.errors.length,1);assert.notEqual(failed.read('interactionPointer.painted'),true,
  'An unsuccessful draw cannot mark the first motion frame complete');
failed.move(30);assert.equal(failed.raf.size,1);assert.equal(failed.timers.size,0);failed.flush();
assert.equal(failed.read('interactionPointer.painted'),true);
const zero=motionScheduler(diffuse,true);zero.start();zero.hideStage();zero.move(20);zero.flush();
assert.equal(zero.painted.length,0);assert.notEqual(zero.read('interactionPointer.painted'),true);
zero.showStage();zero.move(30);assert.equal(zero.timers.size,0);zero.flush();assert.equal(zero.painted.length,1);

// An arbitrarily dense stream cannot debounce the fixed deadline forever.
// Continue moving without release through three deadlines and verify that
// each pending frame uses the newest position, with no autonomous draw loop.
const held=motionScheduler(diffuse,true);held.start();held.move(20);held.flush();
for(let ms=0;ms<192;ms++) {
  for(let burst=0;burst<20;burst++)held.move(21+ms*20+burst);
  held.advance(1);held.flush();
}
assert.deepEqual(held.painted.map(frame=>frame.time),[0,64,128,192]);
assert.equal(held.painted.at(-1).position,21+191*20+19);
assert(held.read('interactionPointer'),'Continuous input must not end the held gesture');
held.advance(1000);held.flush();assert.equal(held.painted.length,4);
}
const normal=motionScheduler(false,false);normal.start();normal.move(20);normal.flush();normal.move(30);
assert.equal(normal.raf.size,1);assert.equal(normal.timers.size,0,'Hardware rendering never receives the software delay');
normal.flush();assert.equal(normal.painted.length,2);
assert.equal(normal.read('interactionPointer'),null,'Hardware keeps its original pointer path');
assert.deepEqual(normal.paths,['direct','direct']);
assert.equal(normal.c.renderProfile.pixels,2000000);
assert(source.includes('drag.y=e.clientY;requestRender(true)'), 'Editor pointer movement opts into motion scheduling');
const homeSource=fs.readFileSync(path.join(__dirname,'../home-view.js'),'utf8');
assert(homeSource.includes('panY+=(e.clientY-start.lastY)*(camera.top-camera.bottom)/rect.height;window.requestModelRender?.(true)'),
  'Home pointer movement opts into the same scheduler after updating the camera');
console.log('PASS: first motion RAF, fixed held-drag deadlines, latest camera, full-quality release and lifecycle cancellation');

// Time only successful Apple diffuse motion draws. The clock advances inside
// the real draw helper, while timers and RAF remain independently controlled.
for(const [duration,expected] of [[0,64],[1,64],[63,64],[64,64],[125.5,125.5],[250,250],[1600,250]]) {
  const q=motionScheduler();q.duration(duration);q.start();q.move(20);
  assert.equal(q.timers.size,0,'First motion remains immediate even on a slow renderer');q.flush();
  assert.equal(q.read('interactionPointer.frameDelay'),expected);
  assert.equal(q.clockReads(),2,'Motion timing reads only the monotonic clock');
  q.move(30);const timer=[...q.timers.values()][0];
  assert.equal(timer.due,duration+expected,'Draw duration selects the next fixed deadline');
  q.advance(expected/2);q.move(40);q.move(50);
  assert.equal([...q.timers.values()][0],timer,'Later input cannot postpone an adaptive deadline');
  q.advance(expected/2);q.flush();
  assert.equal(q.painted.at(-1).position,50,'The scheduled draw uses the latest camera');
  assert.equal(q.painted.at(-1).time,duration+expected);
}
for(const release of ['pointerup','pointercancel','lostpointercapture']) {
  const q=motionScheduler();q.duration(1600);q.start();q.move(20);q.flush();q.move(30);
  const completed=q.now();q.handlers[release]({pointerId:1});assert.equal(q.timers.size,0);
  q.duration(0);q.flush();assert.deepEqual(q.painted.at(-1),{time:completed,position:30,moving:false});
  assert.equal(q.clockReads(),2,'The full release draw does not become a motion timing sample');
  q.advance(1000);q.flush();assert.equal(q.painted.length,2);
}
const fullFrame=motionScheduler();fullFrame.c.render();fullFrame.start();fullFrame.c.render();
assert.equal(fullFrame.clockReads(),0,'Full frames and unmoved pointers do not sample the clock');
const dense=motionScheduler();dense.duration(1600);dense.start();dense.move(20);dense.flush();
for(let cycle=0;cycle<3;cycle++) {
  const before=dense.now();dense.move(30+cycle*1000);
  for(let ms=0;ms<250;ms++){dense.move(31+cycle*1000+ms);dense.advance(1);}
  assert.equal(dense.raf.size,1);dense.flush();assert.equal(dense.painted.at(-1).time,before+250);
  assert.equal(dense.painted.at(-1).position,280+cycle*1000);
}
assert.equal(dense.painted.length,4,'Continuous input cannot postpone any adaptive deadline');
dense.advance(1000);dense.flush();assert.equal(dense.painted.length,4,'No autonomous render loop');
const adapting=motionScheduler();adapting.duration(1800);adapting.start();adapting.move(20);adapting.flush();
adapting.duration(100);adapting.move(30);adapting.advance(250);adapting.flush();
assert.equal(adapting.read('interactionPointer.frameDelay'),100,'A later fast successful draw replaces the cold cost');
adapting.move(40);assert.equal([...adapting.timers.values()][0].due,adapting.now()+100);
adapting.handlers.pointerup({pointerId:1});adapting.flush();
assert.equal(adapting.painted.at(-1).moving,false,'Adaptive pacing never defers the full release draw');
adapting.start();adapting.move(20);assert.equal(adapting.timers.size,0,'New gestures do not inherit cold duration');
adapting.duration(0);adapting.flush();assert.equal(adapting.read('interactionPointer.frameDelay'),64);
for(const diffuse of [false,true]) for(const change of ['live','explicit','resize']) {
  const q=motionScheduler(diffuse,true);q.duration(1600);q.start();q.move(20);q.flush();q.move(30);
  if(change==='live')q.c.requestRender();else if(change==='explicit')q.c.render();else q.c.window.resizeModel();
  assert.equal(q.timers.size,0,'Non-motion '+change+' bypasses even the maximum adaptive wait');q.flush();
  assert.equal(q.painted.at(-1).position,30);
}
for(const transition of ['visibility','context','bfcache','dispose']) {
  const q=motionScheduler();q.duration(1600);q.start();q.move(20);q.flush();q.move(30);
  if(transition==='visibility'){q.c.document.hidden=true;q.handlers.visibilitychange();}
  else if(transition==='context')q.handlers.webglcontextlost({preventDefault(){}});
  else q.handlers.pagehide({persisted:transition==='bfcache'});
  assert.equal(q.timers.size,0);assert.equal(q.read('interactionPointer'),null);
  if(transition==='visibility'){q.c.document.hidden=false;q.handlers.visibilitychange();}
  else if(transition==='context')q.handlers.webglcontextrestored();
  else if(transition==='bfcache')q.handlers.pageshow({persisted:true});
  q.flush();q.advance(1000);assert.equal(q.timers.size,0);
  if(transition!=='dispose') {
    q.duration(0);q.start();q.move(20);assert.equal(q.timers.size,0);q.flush();
    assert.equal(q.read('interactionPointer.frameDelay'),64,'Resumed gestures cannot inherit stale duration');
  }
}
const noSuccess=motionScheduler();noSuccess.duration(1600);noSuccess.start();noSuccess.failNextDraw();noSuccess.move(20);noSuccess.flush();
assert.equal(noSuccess.read('interactionPointer.frameDelay'),undefined,'A failed draw records no duration');
noSuccess.duration(100);noSuccess.move(30);noSuccess.flush();
assert.equal(noSuccess.read('interactionPointer.frameDelay'),100);
noSuccess.failNextDraw();noSuccess.move(40);noSuccess.advance(100);noSuccess.flush();
assert.equal(noSuccess.read('interactionPointer.frameDelay'),100,'A later failure preserves the last successful measurement');
const stale=motionScheduler();stale.duration(1600);stale.start();stale.move(20);
stale.afterNextDraw(()=>{stale.handlers.pointerup({pointerId:1});stale.start();});stale.flush();
assert.equal(stale.read('interactionPointer.frameDelay'),undefined,'A replaced pointer cannot receive the old draw duration');
assert.notEqual(stale.read('interactionPointer.painted'),true);
for(const [diffuse,reduced] of [[false,true],[false,false]]) {
  const q=motionScheduler(diffuse,reduced);q.duration(1600);q.start();q.move(20);q.flush();q.move(30);
  assert.equal(q.clockReads(),0,'Other renderer profiles do not sample motion duration');
  if(reduced)assert.equal([...q.timers.values()][0].due,q.now()+64,'Other software keeps its fixed64ms behavior');
  else {assert.equal(q.timers.size,0);assert.equal(q.raf.size,1);}
}
for(const elapsed of [NaN,Infinity,-10]) {
  const q=motionScheduler();let calls=0;q.c.performance.now=()=>calls++?elapsed:0;
  q.start();q.move(20);q.flush();assert.equal(q.read('interactionPointer.frameDelay'),64,'Invalid/backward clocks cannot create unbounded delays');
}
console.log('PASS: per-gesture Apple diffuse adaptive64–250ms pacing, successful-draw timing, fixed deadlines and unchanged bypasses');


// Execute the actual mode switch, resize cache, cutaway handler and scheduler.
// Editor can draw directly before its queued resize runs, leaving the cache at
// the old Home dimensions when Home is selected again.
const modeStart=homeSource.indexOf('  function attachRoomLighting() {');
const modeEnd=homeSource.indexOf('\n  function rebuildControls()',modeStart);
assert(modeStart>=0&&modeEnd>modeStart,'Production Home mode switch is present');
const modeSource=homeSource.slice(modeStart,modeEnd);
function modeScheduler(legacy=false,diffuse=false) {
  const q=motionScheduler(diffuse,diffuse), c=q.c, elements=new Map(), modes=[];
  let width=800;
  const element=id=>{
    if(!elements.has(id))elements.set(id,{checked:true,hidden:false,prepend(){},
      getBoundingClientRect:()=>({width,height:600})});
    return elements.get(id);
  };
  Object.assign(c,{active:true,previewTV(){},lowerFloorContext:null,showLowerFloor:false,selected:null,
    THREE:{Color:class {constructor(value){this.value=value;}}},hemisphere:{},sun:{},ground:{},grid:{},
    clipping:{constant:2.1},editorFloorMaterials:null,roomLighting:null,root:{children:[]},objectGroup:{},overlayGroup:null,points:[],
    clearTrail(){},showMode(){},refreshControls(){},updateFixtureShadows(){},updateHeightCaption(){},$:element});
  c.document.body={classList:{toggle(){}}};
  c.window.floorplan={get renderCount(){return c.renderCount;}};
  c.homeView={get active(){return c.active;},render(){c.drawScene(c.camera);c.renderCount++;}};
  const draw=c.drawScene;
  c.drawScene=camera=>{modes.push(c.active?'home':'editor');draw(camera);};
  const oldTail='refreshControls(); requestAnimationFrame(() => window.resizeModel?.());';
  const tailStart=modeSource.indexOf('    refreshControls();');
  assert(tailStart>=0);
  vm.runInContext(legacy?modeSource.slice(0,tailStart)+'    '+oldTail+'\n  }':modeSource,c);
  const cutaway=lines.find(line=>line.startsWith("$('cutaway').onchange="));
  assert(cutaway);
  vm.runInContext(cutaway.slice(0,cutaway.indexOf(';for(const k'))+';',c);
  c.window.resizeModel();
  assert.equal(modes.at(-1),'home','Initial resize populates the Home size cache');
  return Object.assign(q,{modes,element,setWidth(value){width=value;},
    // A cancelled callback must not execute later in the same browser frame.
    flush(){for(const [id,fn] of [...q.raf])if(q.raf.delete(id))fn();},
    cutaway(value){element('cutaway').checked=value;element('cutaway').onchange();}});
}
function rapidModeReturn(q) {
  q.c.setActive(false);
  q.cutaway(true);q.cutaway(false);
  assert.equal(q.modes.at(-1),'editor');
  const before=q.c.renderCount;
  q.c.setActive(true);
  q.flush();q.flush();
  return q.c.renderCount-before;
}
const oldMode=modeScheduler(true);
assert.equal(rapidModeReturn(oldMode),0,'Negative control reproduces the old Home no-redraw race');
assert.equal(oldMode.modes.at(-1),'editor');
const fastMode=modeScheduler();
assert.equal(rapidModeReturn(fastMode),1,'Rapid Editor cutaway/full then Home paints Home exactly once');
assert.equal(fastMode.modes.at(-1),'home');assert.equal(fastMode.raf.size,0);
// A mode-key resize, a real size change and an earlier ResizeObserver repaint
// all satisfy the request without creating a duplicate frame.
for(const change of ['mode','size','observer','explicit','stable','repeated']) {
  const q=modeScheduler(), before=q.c.renderCount;
  q.c.setActive(change==='mode'?false:true);
  if(change==='size'||change==='observer')q.setWidth(720);
  if(change==='observer')q.c.window.resizeModel();
  if(change==='explicit')q.c.window.renderModel();
  if(change==='repeated'){q.c.setActive(true);q.c.setActive(true);}
  q.flush();q.flush();q.flush();
  assert.equal(q.c.renderCount,before+1,change+' paints once across resize and RAF coalescing');
  assert.equal(q.raf.size,0,change+' leaves no idle animation loop');
}
for(const transition of ['visibility','context','bfcache','dispose']) {
  const q=modeScheduler(), before=q.c.renderCount;
  q.c.setActive(false);q.c.setActive(true);
  if(transition==='visibility'){q.c.document.hidden=true;q.handlers.visibilitychange();}
  else if(transition==='context')q.handlers.webglcontextlost({preventDefault(){}});
  else q.handlers.pagehide({persisted:transition==='bfcache'});
  q.flush();q.flush();
  assert.equal(q.c.renderCount,before,transition+' suppresses mode callbacks while inactive');
  assert.equal(q.raf.size,0);
  if(transition==='visibility'){q.c.document.hidden=false;q.handlers.visibilitychange();}
  else if(transition==='context')q.handlers.webglcontextrestored();
  else if(transition==='bfcache')q.handlers.pageshow({persisted:true});
  q.flush();q.flush();
  assert.equal(q.c.renderCount,before+(transition==='dispose'?0:1),transition+' preserves lifecycle recovery');
}
const restoredMode=modeScheduler();
restoredMode.handlers.webglcontextlost({preventDefault(){}});restoredMode.handlers.webglcontextrestored();
restoredMode.flush();
assert.equal(rapidModeReturn(restoredMode),1,'The same rapid transition repaints after real loss/restore handlers');
console.log('PASS: actual Home mode/resize race, old-code negative control, coalesced repaint and lifecycle guards');

// Both raw Apple and measured masked-Apple select this existing diffuse flag;
// other reduced and hardware profiles retain the ordinary Editor backdrop.
for(const profile of [{name:'raw Apple',diffuse:true},{name:'masked Apple',diffuse:true},
  {name:'other software',diffuse:false},{name:'hardware',diffuse:false}]) {
  const q=modeScheduler(false,profile.diffuse), floor={visible:true,userData:{category:'floors'}};
  q.c.root.children.push(floor);
  const ground=q.c.ground,grid=q.c.grid;
  for(let cycle=0;cycle<3;cycle++)for(const active of [false,true,false,true]) {
    q.c.setActive(active);q.flush();q.flush();
    assert.equal(ground.visible,!active&&!profile.diffuse,profile.name+' backdrop mode');
    assert.equal(grid.visible,!active,profile.name+' grid remains available in Editor');
    assert.equal(floor.visible,true,'Real floor visibility is not changed by backdrop policy');
    assert.equal(q.c.ground,ground);assert.equal(q.c.grid,grid);
  }
  q.handlers.webglcontextlost({preventDefault(){}});q.handlers.webglcontextrestored();
  q.c.setActive(false);q.flush();q.flush();
  assert.equal(ground.visible,!profile.diffuse,'The policy survives context restoration');
  assert.equal(grid.visible,true);assert.equal(floor.visible,true);
}
console.log('PASS: actual repeated Home/Editor backdrop policy, grid/floor preservation and restored mode');
