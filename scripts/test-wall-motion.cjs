// The optional wall drift must never create work for an otherwise idle viewer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'room-lighting.js'), 'utf8');
const rate = Math.PI * 2 / 90000;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

function harness(options = {}) {
  let time = 0;
  const reduced = {matches: !!options.reduced}, coarse = {matches: !!options.coarse};
  const forbidden = () => { throw Error('Wall motion scheduled work'); };
  const context = vm.createContext({
    navigator: {hardwareConcurrency: 8, deviceMemory: 8, userAgent: 'Desktop', ...options.navigator},
    document: {hidden: !!options.hidden},
    performance: {now: () => time},
    matchMedia: options.noMedia ? undefined : query => query.includes('reduced-motion') ? reduced : coarse,
    requestAnimationFrame: forbidden, setTimeout: forbidden, setInterval: forbidden,
  });
  vm.runInContext(source + '\nthis.motion = createWallSheenMotion();', context);
  const shader = {uniforms: {}, vertexShader: '', fragmentShader: ''};
  context.applyWallSheen(shader);
  const uniform = shader.uniforms.wallSheenPhase;
  const frame = (at, cost = 2) => {
    time = at;
    context.motion.beforeRender();
    time += cost;
    context.motion.afterRender();
  };
  return {context, uniform, frame, reduced, coarse, setTime: at => { time = at; }};
}

const active = harness();
active.frame(0);
active.frame(16);
near(active.uniform.value, 16 * rate);
active.setTime(3600000);
near(active.uniform.value, 16 * rate); // An idle hour does not schedule or update anything.
active.frame(3600000);
near(active.uniform.value, 16 * rate); // No catch-up jump on the first new frame.
active.frame(3600016);
near(active.uniform.value, 32 * rate);
active.frame(3600116);
near(active.uniform.value, 64 * rate); // A nearby slow frame contributes at most 32 ms.
active.frame(3600217);
active.frame(3600217);
active.frame(100);
near(active.uniform.value, 64 * rate); // Long gaps, duplicate and backward clocks add nothing.

for (const options of [
  {reduced: true}, {coarse: true}, {hidden: true}, {noMedia: true},
  {navigator: {hardwareConcurrency: undefined}}, {navigator: {hardwareConcurrency: 4}},
  {navigator: {deviceMemory: 4}}, {navigator: {userAgentData: {mobile: true}}},
  {navigator: {userAgent: 'Mozilla Android'}}, {navigator: {userAgent: 'iPhone'}},
  {navigator: {connection: {saveData: true}}},
]) {
  const test = harness(options);
  for (let i = 0; i < 10; i++) test.frame(i * 16);
  assert.equal(test.uniform.value, 0, `Static fallback: ${JSON.stringify(options)}`);
}
const safari = harness({navigator: {deviceMemory: undefined}});
safari.frame(0); safari.frame(16);
near(safari.uniform.value, 16 * rate); // Optional memory API is absent in desktop Safari.

for (const guard of ['reduced', 'coarse', 'hidden', 'saveData']) {
  const test = harness();
  const change = value => {
    if (guard === 'hidden') test.context.document.hidden = value;
    else if (guard === 'saveData') test.context.navigator.connection = {saveData: value};
    else test[guard].matches = value;
  };
  test.frame(0); test.frame(16);
  const frozen = test.uniform.value;
  change(true);
  test.frame(32); test.frame(48);
  assert.equal(test.uniform.value, frozen, `${guard} freezes the current tint`);
  change(false);
  test.frame(64);
  assert.equal(test.uniform.value, frozen, `${guard} resume does not catch up`);
  test.frame(80);
  near(test.uniform.value, frozen + 16 * rate);
}

const slow = harness();
slow.frame(0, 33); slow.frame(50, 33); slow.frame(100, 33);
const frozen = slow.uniform.value;
for (let i = 1; i < 20; i++) slow.frame(100 + i * 16);
assert.equal(slow.uniform.value, frozen, 'Three expensive submissions stop motion for the session');
const occasional = harness();
occasional.frame(0, 33); occasional.frame(50, 33); occasional.frame(100, 2);
occasional.frame(150, 33); occasional.frame(200, 2);
const before = occasional.uniform.value;
occasional.frame(216);
near(occasional.uniform.value, before + 16 * rate);

const cycle = harness();
for (let i = 0; i <= 6000; i++) cycle.frame(i * 15);
assert.ok(cycle.uniform.value < 1e-8 || Math.PI * 2 - cycle.uniform.value < 1e-8, 'Phase wraps after 90 seconds of active frames');

// The shared draw helper covers the editor, direct Home renders, signal fades
// and the bounded device rotor updates.
const viewer = fs.readFileSync(path.join(root, 'viewer.js'), 'utf8');
const home = fs.readFileSync(path.join(root, 'home-view.js'), 'utf8');
const draw = viewer.split('\n').find(line => line.startsWith('function drawScene('));
assert.ok(draw, 'The viewer defines one shared draw helper');
assert.equal((viewer.match(/renderer\.render\(scene,camera\)/g) || []).length, 1);
assert.equal((home.match(/renderer\.render\(/g) || []).length, 0);
const calls = [];
const context = vm.createContext({
  scene: {},
  reflectionEnvironment: null, contactShading: null, hemisphere: null,
  renderProfile: {diffuseLighting: false}, coalesceMotion: false,
  interactionRenderer: null, interactionPointer: {moved: true}, THREE: {}, performance: {now: () => 0},
  createInteractionRenderer: () => ({draw: () => {calls.push('copy draw'); throw Error('GPU copy unavailable');}}),
  renderSuspended: false, renderLost: false, document: {hidden: false},
  wallSheenMotion: {beforeRender: () => calls.push('before'), afterRender: () => calls.push('after')},
  renderer: {render: () => { calls.push('draw'); throw Error('GPU context unavailable'); }},
});
vm.runInContext(draw, context);
assert.throws(() => context.drawScene({}), /GPU context unavailable/);
assert.deepEqual(calls, ['before', 'draw', 'after'], 'Timing finishes even when drawing fails');
calls.length = 0;
context.renderProfile.diffuseLighting = true;
context.coalesceMotion = true;
assert.throws(() => context.drawScene({}), /GPU copy unavailable/);
assert.deepEqual(calls, ['before', 'copy draw', 'after'], 'Timing also finishes when the bounded motion draw fails');
// Optional physical-lighting passes share the same cleanup guarantee.
context.coalesceMotion = false;
context.interactionPointer = null;
context.hemisphere = {intensity: .75};
context.$ = () => ({dataset: {}});
context.reflectionEnvironment = {update: intensity => {assert.equal(intensity, .75);calls.push('reflection');}};
context.renderer.render = () => calls.push('draw');
const physicalCamera = {};
context.contactShading = {apply: (scene, camera) => {
  assert.equal(scene, context.scene);assert.equal(camera, physicalCamera);
  calls.push('contact');throw Error('Contact pass unavailable');
}};
calls.length = 0;
assert.throws(() => context.drawScene(physicalCamera), /Contact pass unavailable/);
assert.deepEqual(calls, ['before', 'reflection', 'draw', 'contact', 'after'], 'Contact-pass failure still finishes timing');
context.reflectionEnvironment.update = () => {calls.push('reflection');throw Error('Reflection pass unavailable');};
calls.length = 0;
assert.throws(() => context.drawScene(physicalCamera), /Reflection pass unavailable/);
assert.deepEqual(calls, ['before', 'reflection', 'after'], 'Reflection failure also finishes timing');
async function testHomeDrawPaths() {
  const THREE = await import('data:text/javascript;base64,' + fs.readFileSync(path.join(root, 'vendor/three.module.min.js')).toString('base64'));
  const mapObject = {visible:true}, house = {visible:true}, hiddenHouse = {visible:false}, light = {visible:true,isLight:true};
  const children = [mapObject,house,hiddenHouse,light], visibility = () => children.map(object => object.visible);
  const stage = {dataset:{},getBoundingClientRect:() => ({width:1200,height:700})};
  const trace = [], masks = [];
  const c = vm.createContext({
    THREE, active:true, camera:undefined, cameraFit:undefined, houseFitBounds: undefined, root: new THREE.Group(), projectedPosition:new THREE.Vector3(),
    markerViewport:'',markerMotion:{reset(){},target(){}},deviceEffects:{project(){},sync(){}},
    selected:'', planRadius:10, planBounds:true, zoom:1, panX:0, panY:0, homeRotation:0, homeTilt:0,
    model:{ceiling_height_m:3,rooms:[{id:'A',polygon:[[0,0],[4,0],[4,4],[0,4]]}]},
    xm:x => x, zm:z => z, $:id => id==='homeStage' ? stage : {firstElementChild:{style:{}}},
    mapLayer:{object:mapObject,config:{enabled:true,north_deg:0},render() {}}, mapDraft:null, mapFraming:null, mapCoarseState:false,
    environmentLayer:null, roomLighting:null, lowerFloorContext:null, assumedZones:null, presenceView:null, vacuumView:null,
    reflectionEnvironment:null, contactShading:null, hemisphere:null,
    roomLabels:true, signalZone:'', showLowerFloor:true, labels:[], points:[], refreshSignalStatus() {}, positionMediaPreviews() {},
    scene:{children}, renderCount:0, renderSuspended:false, renderLost:false, document:{hidden:false},
    coalesceMotion:false, interactionPointer:null,
    wallSheenMotion:{beforeRender:() => trace.push('before'),afterRender:() => trace.push('after')},
    renderer:{domElement:{dataset:{}},render:() => {trace.push('draw');masks.push(visibility());}},
  });
  c.mapCoarse = () => c.zoom < .22;
  let rotor;
  Object.assign(c,{homeGesture:null,renderRequest:0,renderDelay:0,failed3D:false,
    invalidateShadows(){},createDeviceEffects(_three,_container,options){rotor=options;return {};},
    report3DError(error){throw error;}});
  const rotorStart=home.indexOf('  const deviceEffects=createDeviceEffects(');
  const rotorEnd=home.indexOf('\n  function cancelHomeGesture',rotorStart);
  assert(rotorStart>=0&&rotorEnd>rotorStart);
  vm.runInContext(home.slice(rotorStart,rotorEnd).replace('const deviceEffects=',''),c);
  const signalStart = home.indexOf('  function drawSignalFrame('), renderStart = home.indexOf('  function render() {');
  const renderEnd = home.indexOf('  function clearTrail(', renderStart);
  assert(signalStart>=0 && renderStart>signalStart && renderEnd>renderStart, 'Exercise the actual Home draw functions');
  vm.runInContext(draw + '\n' + home.slice(signalStart,renderEnd), c);
  const expectDraw = (action,mask) => {
    trace.length=0;const before=c.renderCount;action();
    assert.deepEqual(trace,['before','draw','after'],'Every Home draw runs through wall-sheen timing');
    assert.deepEqual(masks.at(-1),mask);assert.equal(c.renderCount,before+1);
  };
  expectDraw(() => c.render(),[true,true,false,true]);
  expectDraw(() => c.drawSignalFrame(true),[true,true,false,true]);
  trace.length=0;c.drawSignalFrame(false);assert.deepEqual(trace,[],'A status-only signal update does not draw');
  expectDraw(() => rotor.draw(),[true,true,false,true]);
  for(const [key,value] of [['homeGesture',{moved:true}],['renderRequest',1],['renderDelay',1]]){
    const previous=c[key];c[key]=value;trace.length=0;rotor.draw();
    assert.deepEqual(trace,[],key+' owns the scene instead of rotor drawing');c[key]=previous;
  }
  c.renderer.domElement.dataset.cameraTourPlaying='true';trace.length=0;rotor.draw();
  assert.deepEqual(trace,[],'Camera tours own the shared scene draw');
  delete c.renderer.domElement.dataset.cameraTourPlaying;
  assert.equal(rotor.canDraw(),true);assert.equal(rotor.allowRotor(),true);
  c.coalesceMotion=true;assert.equal(rotor.allowRotor(),false);c.coalesceMotion=false;
  c.zoom=.1;assert.equal(rotor.canDraw(),false,'Coarse maps suppress house rotor work');
  expectDraw(() => c.render(),[true,false,false,true]);
  assert.deepEqual(visibility(),[true,true,false,true],'Coarse-map drawing restores every original visibility');
  trace.length=0;c.drawSignalFrame(true);assert.deepEqual(trace,[],'Coarse maps suppress house-only signal redraws');
  c.renderer.render = () => {trace.push('draw');throw Error('Map draw failed');};
  const before=c.renderCount;
  assert.throws(() => c.render(),/Map draw failed/);
  assert.deepEqual(trace,['before','draw','after'],'A failed coarse-map draw still completes sheen timing');
  assert.equal(c.renderCount,before);assert.deepEqual(visibility(),[true,true,false,true],'A failed map draw also restores visibility');
}
testHomeDrawPaths().then(() => console.log('PASS: Wall drift adds zero scheduled frames, bounds active time, freezes for device/preference/slow-render fallbacks, and wraps Home, signal and coarse-map draws.'))
  .catch(error => {console.error(error);process.exitCode=1;});
