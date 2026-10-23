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
assert.equal((home.match(/drawScene\(camera\)/g) || []).length, 3, 'Full, signal and bounded rotor frames use the shared draw helper');
const calls = [];
const context = vm.createContext({
  scene: {},
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

// Execute the real rotor callback: it shares wall timing without scheduling a
// second frame, and yields while camera movement already owns the next draw.
let rotor;
const failures = [], forbidden = () => assert.fail('A rotor draw must not schedule another frame');
Object.assign(context, {
  active: true, camera: {}, points: [], homeGesture: null, renderRequest: 0, renderDelay: 0,
  failed3D: false, coalesceMotion: false, renderCount: 0,
  roomLighting: {geometryMode: 'packed', update: () => calls.push('lighting')},
  $: () => ({}), createDeviceEffects: (_three, _container, options) => { rotor = options; return {}; },
  report3DError: error => failures.push(error.message),
  requestAnimationFrame: forbidden, setTimeout: forbidden, setInterval: forbidden,
});
const rotorStart = home.indexOf('  const deviceEffects=createDeviceEffects(');
const rotorEnd = home.indexOf('\n  function cancelHomeGesture', rotorStart);
assert.ok(rotorStart >= 0 && rotorEnd > rotorStart, 'The real bounded rotor callback exists');
vm.runInContext(home.slice(rotorStart, rotorEnd), context);
assert.equal(rotor.canDraw(), true);
assert.equal(rotor.allowRotor(), true);
context.coalesceMotion = true;
assert.equal(rotor.allowRotor(), false, 'Low-capacity renderers cannot start 3D rotor work');
context.coalesceMotion = false;
context.renderer.render = () => calls.push('draw');
calls.length = 0;
rotor.draw();
assert.deepEqual(calls, ['lighting', 'before', 'draw', 'after'], 'Rotor rendering updates lighting and finishes wall timing once');
assert.equal(context.renderCount, 1);
for (const [key, value] of [['homeGesture', {moved: true}], ['renderRequest', 1], ['renderDelay', 1]]) {
  const previous = context[key]; context[key] = value; calls.length = 0;
  rotor.draw();
  assert.deepEqual(calls, [], key + ' prevents duplicate rotor draw work');
  assert.equal(context.renderCount, 1);
  context[key] = previous;
}
calls.length = 0;
context.renderer.render = () => { calls.push('draw'); throw Error('Rotor GPU unavailable'); };
rotor.draw();
assert.deepEqual(calls, ['lighting', 'before', 'draw', 'after'], 'A failed rotor frame still closes wall timing');
assert.deepEqual(failures, ['Rotor GPU unavailable'], 'A rotor failure reaches the shared fatal-error handler');
assert.equal(context.renderCount, 1, 'Failed rotor frames are not counted as rendered');
console.log('PASS: Wall drift adds zero scheduled frames, bounds active time, and freezes for device, preference and slow-render fallbacks.');
