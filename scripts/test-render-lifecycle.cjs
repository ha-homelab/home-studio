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
const prefixes = ['let renderRequest=', 'function cancelRender(', 'function requestRender(',
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
listeners.webglcontextrestored(); assert.equal(invalidations,1); assert.equal(frames.size,1);
assert.equal(buffers.length,3,'Restoration applies a resize skipped while context was lost');
assert.equal(context.camera.aspect,.75);flush();assert.equal(draws,4);
context.requestRender(); events.pagehide({persisted:true});
assert.equal(frames.size,0); assert.equal(disposals,0,'Back-forward cache retains usable resources');
events.pageshow(); flush(); assert.equal(draws,5);
context.requestRender(); events.pagehide({persisted:false});
assert.equal(frames.size,0); assert.equal(disposals,1); assert.equal(losses,1); assert.equal(disconnects,1);
context.requestRender(); context.drawScene({}); assert.equal(draws,5);
console.log('PASS: input coalescing, bounded buffers, idle/hidden/lost suspension, restoration and GPU teardown');
