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
