// Execute the production Home/editor listeners, including their shared canvas.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const viewer = fs.readFileSync(path.join(root, 'viewer.js'), 'utf8');
const home = fs.readFileSync(path.join(root, 'home-view.js'), 'utf8');
function between(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, `Production section exists: ${start}`);
  return source.slice(a, b);
}
function line(source, prefix) {
  const found = source.split('\n').find(value => value.trimStart().startsWith(prefix));
  assert(found, `Production line exists: ${prefix}`);
  return found;
}
class Target {
  listeners = new Map();
  captures = new Set();
  dataset = {};
  attributes = {};
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(callback); this.listeners.set(type, callbacks);
  }
  emit(type, event = {}) { for (const callback of this.listeners.get(type) || []) callback(event); }
  setPointerCapture(id) { this.captures.add(id); }
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() { this.focused = true; }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) {
    if (this.captures.delete(id)) this.emit('lostpointercapture', {pointerId: id});
  }
  getBoundingClientRect() { return {left: 0, top: 0, width: 800, height: 600}; }
}
function fixture(homeMode, navigationMode = 'rotate') {
  const canvas = new Target(), document = new Target(), window = new Target();
  const actions = [], renders = [];
  const nodes = new Map();
  const getNode = id => {
    if (!nodes.has(id)) nodes.set(id, {style: {}, attributes: {}, classList: {toggle() {}}, prepend() {}, checked: true,
      setAttribute(name, value) { this.attributes[name] = value; }});
    return nodes.get(id);
  };
  const node = getNode('body');
  document.hidden = false; document.body = node;
  window.floorplan = {renderCount: 1};
  window.requestModelRender = motion => renders.push(motion);
  window.renderModel = () => renders.push(false);
  const c = vm.createContext({
    active: homeMode, canEdit: true, camera: {left: -10, right: 10, top: 10, bottom: -10},
    renderer: {domElement: canvas}, document, window, requestAnimationFrame() {},
    renderLost: false, renderSuspended: false, interactionPointer: null, coalesceMotion: true,
    panX: 0, panY: 0, zoom: 1, radius: 10, planRadius: 10, target: {x: 0, z: 0}, azimuth: .5, polar: .5,
    requestRender: motion => renders.push(motion),
    THREE: {Color: class {}, Vector2: class {}, Raycaster: class {
      setFromCamera() {}
      intersectObjects() { return [{object: {userData: {id: 'lamp'}}}]; }
    }},
    bindings: [{id: 'lamp', room: 'A'}], selected: 'A', objectGroup: {children: []},
    activateDevice: item => actions.push(item.id),
    $: getNode, vt: text => text, scene: {}, hemisphere: {}, sun: {}, ground: {}, grid: {}, clipping: {},
    root: {children: []}, points: [], renderProfile: {}, lowerFloorContext: null, overlayGroup: null, environmentLayer: null,
    editorFloorMaterials: null, homeArchitectureMaterials: null, setWallOutlineAppearance() {}, attachRoomLighting() {}, updateFixtureShadows() {}, refreshControls() {},
    nativePressPointers:new Set(), hideMediaControls() {}, cancelNativePress() {}, discardMediaControls() {}, previewTV() {},
  });
  c.homeView = {get active() { return c.active; }};
  const code = [
    line(viewer, 'let cancelEditorGesture='),
    between(viewer, 'if(coalesceMotion){\nrenderer.domElement.addEventListener', 'let drag=null;'),
    between(viewer, 'let drag=null;', "$('resetView').onclick="),
    line(viewer, 'function showMode('),
    line(home, 'let homeGesture='), line(home, 'function cancelHomeGesture('),
    line(home, 'let navigationMode='),
    between(home, '  function resetZoom()', '  function applyViewPreferences('),
    between(home, '  function setActive(value) {', '  let nativePressTimer='),
    line(home, "window.addEventListener('pagehide',()=>{cancelHomeGesture();"),
    line(home, "document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelHomeGesture();"),
    between(home, '  if(renderer) {\n    renderer.domElement.tabIndex', '  const signalText='),
  ].join('\n');
  vm.runInContext(code, c);
  const pointer = (type, id = 1, x = 100, y = 100, extra = {}) => canvas.emit(type, {
    pointerId: id, pointerType: 'touch', isPrimary: id === 1, button: 0,
    buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, ...extra,
  });
  const rotation = () => Array.from(vm.runInContext('[homeRotation,homeTilt]', c));
  const position = () => [c.panX, c.panY, c.target.x, c.target.z, c.azimuth, c.polar, ...rotation()];
  const key = (key, extra = {}) => {
    const event = {key, prevented: false, preventDefault() { this.prevented = true; }, ...extra};
    canvas.emit('keydown', event); return event;
  };
  if (navigationMode === 'move') getNode('homeMove').onclick();
  return {c, canvas, document, window, actions, renders, pointer, position, rotation, key, getNode};
}

for (const [homeMode, navigationMode] of [[true, 'rotate'], [true, 'move'], [false, 'rotate']]) {
  const f = fixture(homeMode, navigationMode), before = f.position();
  f.pointer('pointerdown');
  f.pointer('pointerdown', 2, 300, 300);
  f.pointer('pointermove', 2, 400, 400);
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) f.pointer(type, 2, 400, 400);
  assert.deepEqual(f.position(), before, 'Another finger cannot move either camera');
  assert.deepEqual([...f.canvas.captures], [1], 'Only the owning pointer is captured');
  f.pointer('pointermove', 1, 140, 120);
  assert.notDeepEqual(f.position(), before, 'Unrelated releases do not cancel the owner');
  f.pointer('pointerup', 1, 140, 120);
  const ended = f.position();
  f.pointer('pointermove', 1, 180, 140);
  assert.deepEqual(f.position(), ended, 'Movement after release cannot resume the gesture');
  assert.deepEqual(f.actions, [], 'A drag never activates a device');

  for (const cancellation of ['pointercancel', 'lostpointercapture', 'visibility', 'pagehide', 'context', 'mode', 'buttons']) {
    const g = fixture(homeMode, navigationMode), initial = g.position();
    g.pointer('pointerdown');
    if (cancellation === 'visibility') {
      g.document.hidden = true; g.document.emit('visibilitychange'); g.document.hidden = false;
    } else if (cancellation === 'pagehide') g.window.emit('pagehide', {persisted: true});
    else if (cancellation === 'context') g.canvas.emit('webglcontextlost');
    else if (cancellation === 'mode') {g.c.setActive(!homeMode);g.c.setActive(homeMode);}
    else if (cancellation === 'buttons') g.pointer('pointermove', 1, 100, 100, {buttons: 0});
    else g.pointer(cancellation);
    g.pointer('pointermove', 1, 150, 150);
    g.pointer('pointerup');
    assert.deepEqual(g.position(), initial, `${cancellation}: cancelled camera gesture stays cancelled`);
    assert.deepEqual(g.actions, [], `${cancellation}: cancelled gesture cannot tap a device`);
    assert.equal(g.canvas.captures.size, 0, `${cancellation}: capture is released`);
    g.pointer('pointerdown');g.pointer('pointermove', 1, 140, 120);g.pointer('pointerup', 1, 140, 120);
    assert.notDeepEqual(g.position(), initial, `${cancellation}: a fresh gesture works`);
  }
  const secondary = fixture(homeMode);
  secondary.pointer('pointerdown', 2);secondary.pointer('pointermove', 2, 150, 150);secondary.pointer('pointerup', 2);
  assert.deepEqual(secondary.position(), fixture(homeMode).position(), 'An already-held secondary contact cannot become a fresh gesture');
  assert.deepEqual(secondary.actions, []);
}

for (const mode of ['rotate', 'move']) for (const order of [[1, 2], [2, 1]]) {
  const f = fixture(true, mode);
  f.pointer('pointerdown');f.pointer('pointerdown', 2, 300, 300);
  for (const id of order) f.pointer('pointerup', id, id === 1 ? 100 : 300, id === 1 ? 100 : 300);
  assert.deepEqual(f.actions, [], 'A two-finger tap cannot activate either device');
  f.pointer('pointerdown');f.pointer('pointerup');
  assert.deepEqual(f.actions, ['lamp'], 'A fresh single-finger tap still activates a device');
}
const dragThenTouch = fixture(true);
dragThenTouch.pointer('pointerdown');dragThenTouch.pointer('pointermove', 1, 150, 100);
dragThenTouch.pointer('pointerdown', 2, 300, 300);dragThenTouch.pointer('pointerup', 2, 300, 300);
assert.deepEqual(dragThenTouch.actions, [], 'A second-finger tap during an owner drag cannot activate a device');

const mouse = fixture(false);
mouse.pointer('pointerdown', 1, 100, 100, {pointerType: 'mouse'});
mouse.pointer('pointermove', 1, 120, 110, {pointerType: 'mouse'});
assert.equal(mouse.c.azimuth, .38);assert.equal(mouse.c.polar, .56);
mouse.pointer('pointerup', 1, 120, 110, {pointerType: 'mouse'});
for (const shiftKey of [false, true]) {
  const pan = fixture(false), button = shiftKey ? 0 : 2;
  pan.pointer('pointerdown', 1, 100, 100, {pointerType: 'mouse', button});
  pan.pointer('pointermove', 1, 120, 110, {pointerType: 'mouse', buttons: button === 2 ? 2 : 1, shiftKey});
  assert.equal(pan.c.azimuth, .5);assert.equal(pan.c.polar, .5);
  assert.equal(pan.c.target.x, -20 * .018 * Math.cos(.5) - 10 * .018 * Math.sin(.5));
  assert.equal(pan.c.target.z, 20 * .018 * Math.sin(.5) - 10 * .018 * Math.cos(.5));
}
mouse.canvas.emit('wheel', {deltaY: 100, preventDefault() {}});
assert.equal(mouse.c.radius, 10 * Math.exp(.1), 'Editor wheel zoom is preserved');
mouse.pointer('pointerdown');mouse.c.showMode(true);mouse.c.showMode(false);
const beforePlan = mouse.position();mouse.pointer('pointermove', 1, 150, 150);
assert.deepEqual(mouse.position(), beforePlan, 'Plan mode cancels an editor gesture');

for (const pointerType of ['mouse', 'touch']) {
  const orbit = fixture(true);
  orbit.pointer('pointerdown', 1, 100, 100, {pointerType});
  orbit.pointer('pointermove', 1, 140, 125, {pointerType});
  assert.notDeepEqual(orbit.rotation(), [0, 0], 'The default Home drag changes heading and tilt');
  assert.equal(orbit.c.panX, 0); assert.equal(orbit.c.panY, 0, 'Default rotation does not only shift the projection');
  assert(orbit.canvas.focused, 'Pointer navigation gives the keyboard a focusable canvas');
  assert(orbit.renders.length && orbit.renders.every(Boolean), 'Home navigation uses motion scheduling');
  orbit.pointer('pointermove', 1, 100, 100, {pointerType});
  orbit.pointer('pointerup', 1, 100, 100, {pointerType});
  assert.deepEqual(orbit.actions, [], 'Returning a completed drag to its origin cannot activate a device');
}
for (const options of [{button: 2, buttons: 2}, {shiftKey: true}, {mode: 'move'}]) {
  const pan = fixture(true, options.mode);
  pan.pointer('pointerdown', 1, 100, 100, options);
  pan.pointer('pointermove', 1, 140, 125, options);
  assert.deepEqual(pan.rotation(), [0, 0], 'Right/Shift drag and Move mode preserve Home orientation');
  assert.notDeepEqual([pan.c.panX, pan.c.panY], [0, 0], 'Home pan moves its projection');
  pan.pointer('pointerup', 1, 140, 125, options);
  assert.deepEqual(pan.actions, [], 'Panning does not activate a device');
}
for (const options of [{button: 2, buttons: 2}, {shiftKey: true}]) {
  const click = fixture(true);
  click.pointer('pointerdown', 1, 100, 100, options);click.pointer('pointerup', 1, 100, 100, options);
  assert.deepEqual(click.actions, [], 'A modified navigation click cannot activate a device');
}
const modeSwitch = fixture(true);
modeSwitch.pointer('pointerdown');modeSwitch.getNode('homeMove').onclick();modeSwitch.pointer('pointerup');
assert.deepEqual(modeSwitch.actions, [], 'Changing the navigation mode cancels an unfinished device tap');
assert.equal(modeSwitch.canvas.captures.size, 0);
assert.equal(modeSwitch.getNode('homeMove').attributes['aria-pressed'], 'true');
assert.equal(modeSwitch.getNode('homeRotate').attributes['aria-pressed'], 'false');
const keyboard = fixture(true);
assert(keyboard.key('ArrowRight').prevented);assert(keyboard.key('ArrowDown').prevented);
assert.notDeepEqual(keyboard.rotation(), [0, 0], 'Home arrow keys change camera heading and tilt');
const rotated = keyboard.rotation();
keyboard.key('ArrowLeft', {shiftKey: true});
assert.deepEqual(keyboard.rotation(), rotated);assert.notEqual(keyboard.c.panX, 0, 'Shift-arrow pans');
for (const modifier of ['altKey', 'ctrlKey', 'metaKey']) {
  const before = keyboard.position();
  assert.equal(keyboard.key('ArrowRight', {[modifier]: true}).prevented, false);
  assert.deepEqual(keyboard.position(), before, 'Browser shortcuts preserve the camera');
}
for (const key of ['ArrowUp', 'ArrowDown']) {
  for (let i = 0; i < 100; i++) keyboard.key(key);
  const limit = keyboard.rotation()[1];
  keyboard.key(key);assert.equal(keyboard.rotation()[1], limit, 'Home tilt is bounded in both directions');
  assert(Number.isFinite(limit));
}
keyboard.c.zoom = 2;
assert(keyboard.key('Home').prevented);
assert.deepEqual(keyboard.rotation(), [0, 0]);assert.equal(keyboard.c.zoom, 1);
assert.equal(keyboard.c.panX, 0);assert.equal(keyboard.c.panY, 0);
assert.deepEqual(keyboard.actions, [], 'Keyboard camera navigation and reset do not activate devices');
console.log('PASS: Home rotation/pan, keyboard/reset, shared pointer ownership, multi-touch tap suppression, cancellation, capture cleanup and editor navigation.');
