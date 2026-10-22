'use strict';
// Exercise the actual camera handlers with deterministic pointer capture and
// animation frames. Navigation must never write the accepted project/history.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../planner/editor.js'), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert(a >= 0 && b > a, 'Production section exists: ' + start);
  return source.slice(a, b);
}
class Vector {
  constructor(x, y, z) { this.set(x, y, z); }
  set(x, y, z) { Object.assign(this, {x, y, z}); return this; }
  clone() { return new Vector(this.x, this.y, this.z); }
}
function surface() {
  return {events: {}, style: {}, dataset: {}, attributes: {}, captures: new Set(),
    addEventListener(name, fn) { this.events[name] = fn; },
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() {}, setPointerCapture(id) { this.captures.add(id); },
    hasPointerCapture(id) { return this.captures.has(id); },
    releasePointerCapture(id) { this.captures.delete(id); this.events.lostpointercapture?.({pointerId: id}); },
  };
}
function event(overrides = {}) {
  return {pointerId: 1, pointerType: 'mouse', button: 0, clientX: 100, clientY: 100,
    defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...overrides};
}
const elements = new Map(), get = id => {
  if (!elements.has(id)) elements.set(id, surface());
  return elements.get(id);
};
const frames = new Map(), documentEvents = {}, windowEvents = {};
let serial = 0, draws = 0, planDraws = 0;
const project = Object.freeze({title: 'Accepted plan', floors: Object.freeze([])});
const context = vm.createContext({AbortController, THREE: {Vector3: Vector}, $: get,
  view: 'preview', previewLost: false, previewUnavailable: false, previewMetadata: {},
  previewEdit: null, camera: null, candidatePreview: null, selected() { return null; },
  project, history: Object.freeze([]), future: Object.freeze([]), selection: Object.freeze({kind: 'items', id: 'chair'}),
  size: {width: 800, height: 600}, spaceHeld: false, renderer: {}, devicePixelRatio: 1,
  planCanvas: surface(), map: {x: 0, y: 0}, ctx: {setTransform() {}}, fitPlan() {},
  fitPreview() { context.getOrbit().target.set(4, 1.5, 3); context.getOrbit().radius = context.getOrbit().baseRadius = 17; },
  t: text => text, renderPreview() { draws++; }, renderPlan() { planDraws++; },
  document: {hidden: false, addEventListener(name, fn) { documentEvents[name] = fn; }},
  window: {addEventListener(name, fn) { windowEvents[name] = fn; }},
  requestAnimationFrame(fn) { frames.set(++serial, fn); return serial; }, cancelAnimationFrame(id) { frames.delete(id); },
  drag: null, finishPointer() { throw Error('Camera navigation must not commit an editor drag'); },
});
vm.runInContext(section('let canvasFrame =', 'let startupMessage =') +
  section('const orbit =', 'function createPreviewMaterial(') +
  section('function zoomPreview(', '// Project actions and keyboard navigation.') +
  section('let firstResize =', 'const canvasObserver =') +
  section("window.addEventListener('blur'", "window.addEventListener('beforeunload'") +
  section("document.addEventListener('visibilitychange'", "window.addEventListener('pagehide'") +
  '\nfunction getOrbit() { return orbit; }', context);
const canvas = get('preview-canvas'), orbit = context.getOrbit();
const snapshot = () => JSON.stringify({yaw: orbit.yaw, pitch: orbit.pitch, radius: orbit.radius, target: orbit.target});
const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); };
const stable = () => { flush(); assert.equal(frames.size, 0, 'Idle navigation schedules no additional frame'); };
const reset = () => { context.resetPreview(); stable(); };
const move = overrides => canvas.events.pointermove(event(overrides));
const down = overrides => canvas.events.pointerdown(event(overrides));
const up = overrides => canvas.events.pointerup(event(overrides));

down(); const original = snapshot();
for (let i = 1; i <= 100; i++) move({clientX: 100 + i, clientY: 100 + i / 4});
assert.equal(frames.size, 1, 'A burst of pointer updates coalesces into one draw');
assert.equal(draws, 0); assert.equal(orbit.yaw, -Math.PI / 3 - .7);
assert.notEqual(snapshot(), original); up(); stable();
assert.equal(canvas.captures.size, 0); assert.equal(canvas.dataset.navigating, 'false');
const afterOrbit = draws; move({clientX: 500}); stable(); assert.equal(draws, afterOrbit, 'Released pointers cannot keep moving the camera');
down(); const beforeHover = snapshot(); move({clientX: 500, buttons: 0});
assert.equal(snapshot(), beforeHover, 'Mouse hover after a missed release cannot orbit');
assert.equal(canvas.captures.size, 0); assert.equal(orbit.pointers.size, 0);

for (const options of [{button: 1}, {button: 2}, {shiftKey: true}, {space: true}, {mode: true}]) {
  reset(); const yaw = orbit.yaw, pitch = orbit.pitch, target = JSON.stringify(orbit.target);
  context.spaceHeld = !!options.space;
  if (options.mode) get('preview-pan').events.click();
  down(options); move({...options, clientX: 160, clientY: 125}); up(options); stable();
  assert.equal(orbit.yaw, yaw); assert.equal(orbit.pitch, pitch);
  assert.notEqual(JSON.stringify(orbit.target), target, 'Pan uses the camera target, never model coordinates');
  context.spaceHeld = false; get('preview-orbit').events.click();
}

reset(); down({button: 2}); move({clientX: 150, clientY: 125}); stable();
const beforeResize = JSON.stringify(orbit.target);
context.resizeCanvases({width: 500, height: 900}); stable();
assert.equal(JSON.stringify(orbit.target), beforeResize, 'A resize preserves the current pan');
assert.equal(orbit.pointers.size, 1, 'Resize can continue an active gesture');
move({clientX: 150, clientY: 125}); assert.equal(JSON.stringify(orbit.target), beforeResize, 'An unchanged pointer after resize does not jump');
const resizedOrigin = orbit.target.clone(), scale = 2 * orbit.radius * Math.tan(20 * Math.PI / 180) / 900;
move({clientX: 160, clientY: 125});
assert(Math.abs(orbit.target.x - (resizedOrigin.x - Math.sin(orbit.yaw) * 10 * scale)) < 1e-10);
assert(Math.abs(orbit.target.z - (resizedOrigin.z + Math.cos(orbit.yaw) * 10 * scale)) < 1e-10);
up(); context.resizeCanvases({width: 800, height: 600}); stable();

reset(); const touch = {pointerType: 'touch'};
down({...touch, pointerId: 10, clientX: 100});
down({...touch, pointerId: 11, clientX: 200});
down({...touch, pointerId: 12, clientX: 300});
assert.equal(orbit.pointers.size, 2, 'Only two active touches are retained');
assert.deepEqual([...canvas.captures], [10, 11]);
const touchYaw = orbit.yaw, touchPitch = orbit.pitch;
move({...touch, pointerId: 10, clientX: 90}); move({...touch, pointerId: 11, clientX: 210});
assert.equal(orbit.radius, 17 * 100 / 120, 'Increasing pinch distance zooms in');
assert.equal(orbit.yaw, touchYaw); assert.equal(orbit.pitch, touchPitch);
assert.equal(JSON.stringify(orbit.target), JSON.stringify(new Vector(4, 1.5, 3)), 'Symmetric pinch keeps its midpoint');
move({...touch, pointerId: 10, clientX: 110}); move({...touch, pointerId: 11, clientX: 230});
assert.notEqual(JSON.stringify(orbit.target), JSON.stringify(new Vector(4, 1.5, 3)), 'Two fingers also pan');
up({...touch, pointerId: 11});
const beforeRemaining = snapshot(); move({...touch, pointerId: 10, clientX: 110});
assert.equal(snapshot(), beforeRemaining, 'Lifting one finger rebases without a camera jump');
move({...touch, pointerId: 10, clientX: 120}); assert.equal(orbit.yaw, touchYaw - .07);
canvas.events.pointercancel(event({...touch, pointerId: 10})); stable();
assert.equal(canvas.captures.size, 0); assert.equal(orbit.pointers.size, 0);

for (const cancel of [() => canvas.events.pointercancel(event()), () => canvas.releasePointerCapture(1), () => windowEvents.blur(), () => {
  context.document.hidden = true; documentEvents.visibilitychange(); context.document.hidden = false;
}]) {
  down(); move({clientX: 140}); cancel(); const stopped = snapshot(); move({clientX: 200});
  assert.equal(snapshot(), stopped); assert.equal(orbit.pointers.size, 0); assert.equal(canvas.captures.size, 0); stable();
}

const key = (value, options = {}) => { const e = event({key: value, ...options}); canvas.events.keydown(e); return e; };
reset(); assert(key('p').defaultPrevented); assert.equal(orbit.mode, 'pan');
assert.equal(get('preview-pan').attributes['aria-pressed'], 'true'); assert.equal(canvas.dataset.navigationMode, 'pan');
const panTarget = JSON.stringify(orbit.target), panYaw = orbit.yaw;
key('ArrowRight'); stable(); assert.notEqual(JSON.stringify(orbit.target), panTarget); assert.equal(orbit.yaw, panYaw);
key('o'); key('ArrowLeft'); stable(); assert.equal(orbit.yaw, panYaw - .12);
key('t'); stable(); assert.equal(orbit.yaw, -Math.PI / 2); assert.equal(orbit.pitch, Math.PI / 2 - .001);
assert(Number.isFinite(orbit.target.x));
get('preview-rotate-right').events.click(); stable(); assert.equal(orbit.yaw, -Math.PI / 4);
get('preview-rotate-left').events.click(); stable(); assert.equal(orbit.yaw, -Math.PI / 2);
key('Home'); stable(); assert.equal(orbit.yaw, -Math.PI / 3); assert.equal(orbit.pitch, .8); assert.equal(orbit.radius, 17);
for (let i = 0; i < 800; i++) get('preview-rotate-right').events.click();
assert(Math.abs(orbit.yaw + Math.PI / 3) < 1e-10, 'Full camera turns preserve heading without accumulating unbounded yaw');
assert(Math.abs(orbit.yaw) <= Math.PI); stable(); key('Home'); stable();
const fitted = snapshot();
for (const options of [{ctrlKey: true}, {metaKey: true}, {altKey: true}]) assert.equal(key('+', options).defaultPrevented, false);
assert.equal(snapshot(), fitted, 'Browser keyboard combinations are not consumed');
key('+'); assert(orbit.radius < 17); key('-'); stable(); assert(Math.abs(orbit.radius - 17) < 1e-10);
assert(key('Escape').stopped, 'Camera cancellation cannot bubble into model-selection shortcuts');

reset(); const browserWheel = event({deltaY: 120, ctrlKey: true}); canvas.events.wheel(browserWheel);
assert.equal(browserWheel.defaultPrevented, false); assert.equal(orbit.radius, 17);
canvas.events.wheel(event({deltaY: 1, deltaMode: 1})); assert.equal(orbit.radius, 17 / Math.exp(-16 * .0015));
for (let i = 0; i < 100; i++) canvas.events.wheel(event({deltaY: -1000}));
assert.equal(orbit.radius, 1); stable(); const clampedDraws = draws;
canvas.events.wheel(event({deltaY: -1000})); stable(); assert.equal(draws, clampedDraws, 'Zoom limit does not redraw unchanged frames');
for (let i = 0; i < 100; i++) canvas.events.wheel(event({deltaY: 1000}));
assert.equal(orbit.radius, 600); stable();

for (const state of ['previewLost', 'previewUnavailable']) {
  context[state] = true; context.updatePreviewNavigation(); const before = snapshot(), wheel = event({deltaY: 1});
  down(); move({clientX: 400}); canvas.events.wheel(wheel); key('t'); get('preview-rotate-left').events.click();
  assert.equal(snapshot(), before); assert.equal(wheel.defaultPrevented, false);
  assert.equal(orbit.pointers.size, 0); assert.equal(get('preview-navigation').hidden, true); assert.equal(get('preview-top').disabled, true);
  context[state] = false; context.updatePreviewNavigation();
}
assert.equal(get('preview-navigation').hidden, false); assert.equal(get('preview-top').disabled, false);
assert.equal(context.project, project); assert.equal(context.history.length, 0); assert.equal(context.future.length, 0);
assert.equal(context.selection.id, 'chair'); assert.equal(planDraws, 0);
stable();
console.log('PASS: Camera orbit/pan, bounded multitouch, keyboard, capture cancellation, browser shortcuts and idle rendering preserve the accepted project.');
