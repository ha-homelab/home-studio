import assert from 'node:assert/strict';
import test from 'node:test';
import { createCameraTour, validateTour, interpolatePose } from '../camera-tour.js';
import { createCameraTourPanel } from '../camera-tour-panel.js';

const clone = value => structuredClone(value);
const perspective = (changes = {}) => ({ type: 'perspective', floorId: 'ground', yaw: 0, pitch: 0.4, radius: 8, target: [0, 0, 0], ...changes });
const home = (changes = {}) => ({ type: 'home', floorId: 'ground', rotation: 0, tilt: 0.2, zoom: 1, pan: [0, 0], room: '', ...changes });
const document = (poses = [perspective(), perspective({ target: [10, 0, 0] })], seconds = 2) => ({ schema: 1,
  waypoints: poses.map((pose, i) => ({ id: `view_${i + 1}`, name: `View ${i + 1}`, duration: seconds, pose })) });
function harness(initial = perspective({ target: [99, 2, 3] })) {
  let clock = 0, nextId = 0, current = clone(initial), captures = 0, failApply = false;
  const frames = new Map(), applied = [], states = [];
  const tour = createCameraTour({
    capture: () => { captures++; return clone(current); },
    apply: value => { if (failApply) throw new Error('Renderer unavailable'); current = clone(value); applied.push(value); },
    now: () => clock,
    requestFrame: callback => { const id = nextId++; frames.set(id, callback); return id; },
    cancelFrame: id => frames.delete(id), onChange: state => states.push(state)
  });
  return { tour, frames, applied, states, initial,
    tick(ms) { clock += ms; const batch = [...frames.values()]; frames.clear(); for (const callback of batch) callback(clock); },
    setClock(value) { clock = value; },
    setCamera(value) { current = clone(value); },
    fail(value) { failApply = value; },
    get camera() { return clone(current); }, get captures() { return captures; }
  };
}
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`); }

test('schema 1 round-trip copies camera fields without retaining mutable references', () => {
  const source = document([perspective(), home({ room: 'study' })]);
  const validated = validateTour(JSON.stringify(source)); assert.deepEqual(validated, source);
  validated.waypoints[0].pose.target[0] = 40; assert.equal(source.waypoints[0].pose.target[0], 0);
  const h = harness(); h.tour.import(source);
  const exported = h.tour.export(); exported.waypoints[0].pose.target[0] = 70;
  const state = h.tour.getState(); state.waypoints[0].name = 'Changed outside engine';
  assert.equal(h.tour.export().waypoints[0].pose.target[0], 0);
  assert.equal(h.tour.getState().waypoints[0].name, 'View 1'); assert.equal(h.frames.size, 0);
});

test('schema, count, duration, text, numeric and private-field rejection is explicit', () => {
  const invalid = [null, [], {}, '{', ' '.repeat(100_001), { ...document(), schema: 2 },
    { ...document(), access_token: 'private' }, document(Array(33).fill(perspective()), 0.25), document([perspective()], 121),
    document([perspective()], 0), document([perspective()], 0.1), document([perspective()], NaN), document([perspective(), perspective()], 61),
    document([perspective({ radius: -1 })]), document([perspective({ target: [1, 2] })]), document([perspective({ target: [1, Infinity, 3] })]),
    document([perspective({ yaw: NaN })]), document([perspective({ target: Array(3) })]), document([home({ zoom: 0 })]),
    document([home({ room: 'x'.repeat(81) })]), document([home({ pan: [0, 1e10] })]),
    document([perspective({ entity_id: 'camera.private' })])];
  for (const value of invalid) assert.throws(() => validateTour(value));
  for (const change of [{ name: '' }, { name: 'x'.repeat(81) }, { name: 'line\nbreak' }, { entity_id: 'light.private' }, { id: 'invalid.id' }]) {
    const value = document(); Object.assign(value.waypoints[0], change); assert.throws(() => validateTour(value));
  }
  const duplicate = document(); duplicate.waypoints[1].id = duplicate.waypoints[0].id; assert.throws(() => validateTour(duplicate), /unique/);
  const missing = document(); delete missing.waypoints[0].pose.floorId; assert.throws(() => validateTour(missing));
  assert.throws(() => validateTour(JSON.parse('{"schema":1,"waypoints":[],"__proto__":{"private":true}}')));
  assert.equal(validateTour(document([home()], 120)).waypoints[0].duration, 120);
  assert.equal(validateTour(document(Array(32).fill(home()), 0.25)).waypoints.length, 32);
});

test('same-space interpolation uses radians and shortest rotation, without mutating endpoints', () => {
  const from = perspective({ yaw: 170 * Math.PI / 180 }), to = perspective({ yaw: -170 * Math.PI / 180, radius: 12, target: [10, 4, 2] });
  const middle = interpolatePose(from, to, 0.5);
  near(middle.yaw, Math.PI); assert.deepEqual(middle.target, [5, 2, 1]); assert.equal(middle.radius, 10);
  near(interpolatePose(home({ rotation: from.yaw }), home({ rotation: to.yaw, pan: [8, -2] }), 0.5).rotation, Math.PI);
  assert.equal(from.yaw, 170 * Math.PI / 180);
  assert.deepEqual(interpolatePose(from, to, 1), to); assert.deepEqual(interpolatePose(from, to, -1), from);
  assert.throws(() => interpolatePose(from, to, Infinity));
});

test('different floors, rooms and camera modes hold then cut without mixed coordinates', () => {
  const pairs = [[perspective(), perspective({ floorId: 'upper' })], [perspective(), home()],
    [home({ room: 'living' }), home({ room: 'kitchen', pan: [900, 200] })], [home(), home({ floorId: 'upper' })]];
  for (const [from, to] of pairs) {
    assert.deepEqual(interpolatePose(from, to, 0.999), from);
    assert.deepEqual(interpolatePose(from, to, 1), to);
  }
});

test('play starts immediately, eases travel, holds the final view and completes without idle frames', () => {
  const h = harness(); h.tour.import(document()); assert.equal(h.frames.size, 0); h.tour.play();
  assert.equal(h.captures, 1); assert.equal(h.frames.size, 1); assert.deepEqual(h.camera.target, [0, 0, 0]);
  h.tour.play(); assert.equal(h.frames.size, 1); assert.equal(h.captures, 1);
  h.tick(500); near(h.camera.target[0], 1.5625); // Smoothstep at one quarter of a two-second transition.
  h.tick(500); near(h.camera.target[0], 5);
  h.tick(1000); assert.deepEqual(h.camera.target, [10, 0, 0]); assert.equal(h.tour.getState().index, 1);
  h.tick(1000); assert.equal(h.tour.getState().status, 'playing');
  h.tick(1000); assert.equal(h.tour.getState().status, 'completed'); assert.equal(h.frames.size, 0);
  const count = h.applied.length; h.tick(9999); assert.equal(h.applied.length, count);
  h.tour.stop(); assert.deepEqual(h.camera, h.initial); assert.equal(h.tour.getState().elapsed, 0);
});

test('pause accounts for exact elapsed time and resumes without including time paused', () => {
  const h = harness(); h.tour.import(document()); h.tour.play(); h.setClock(750); h.tour.pause();
  assert.equal(h.frames.size, 0); assert.equal(h.tour.getState().elapsed, 0.75);
  const paused = h.camera; h.tick(20_000); assert.deepEqual(h.camera, paused);
  h.tour.play(); assert.equal(h.captures, 1); h.tick(250); near(h.camera.target[0], 5); assert.equal(h.tour.getState().elapsed, 1);
  h.tour.stop(); assert.deepEqual(h.camera, h.initial); assert.equal(h.frames.size, 0);
});

test('seek previews a chosen view; stop restores the camera before preview', () => {
  const h = harness(); h.tour.import(document()); h.tour.seek(1);
  assert.equal(h.tour.getState().status, 'paused'); assert.equal(h.tour.getState().elapsed, 2);
  assert.deepEqual(h.camera.target, [10, 0, 0]); assert.equal(h.frames.size, 0);
  h.tour.play(); h.tick(2000); assert.equal(h.tour.getState().status, 'completed'); assert.equal(h.captures, 1);
  h.tour.stop(); assert.deepEqual(h.camera, h.initial);
  for (const index of [-1, 2, 0.5, NaN]) assert.throws(() => h.tour.seek(index));
});

test('cancellation invalidates already-delivered callbacks and optional stop avoids restoring', () => {
  const h = harness(); h.tour.import(document()); h.tour.play(); const stale = [...h.frames.values()][0];
  h.tick(1000); const middle = h.camera; h.tour.stop({ restore: false });
  stale(8000); assert.deepEqual(h.camera, middle); assert.equal(h.frames.size, 0);
  h.setCamera(home()); h.tour.play(); h.tour.stop(); assert.deepEqual(h.camera, home());
});

test('route edits reorder/remove/rename, while invalid edits and imports leave playback intact', () => {
  const h = harness(); const a = h.tour.add('First'); h.setCamera(home()); const b = h.tour.add('Second');
  h.tour.move(b.id, -1); assert.deepEqual(h.tour.getState().waypoints.map(v => v.id), [b.id, a.id]);
  h.tour.update(a.id, { name: 'Renamed', duration: 4.5 }); assert.equal(h.tour.getState().totalDuration, 7.5);
  h.tour.play(); const before = h.tour.export();
  assert.throws(() => h.tour.update(a.id, { duration: 999 })); assert.throws(() => h.tour.import({ schema: 2, waypoints: [] }));
  assert.throws(() => h.tour.update(a.id, { pose: home() })); assert.throws(() => h.tour.remove('missing'));
  assert.deepEqual(h.tour.export(), before); assert.equal(h.tour.getState().status, 'playing'); assert.equal(h.frames.size, 1);
  h.tour.remove(b.id); assert.equal(h.tour.getState().status, 'idle'); assert.equal(h.frames.size, 0);
  assert.equal(h.tour.getState().waypoints[0].name, 'Renamed');
});

test('renderer failures pause and cancel frames; stop and disposal remain deterministic', () => {
  const h = harness(); h.tour.import(document()); h.tour.play(); h.fail(true); h.tick(100);
  assert.equal(h.tour.getState().status, 'paused'); assert.match(h.tour.getState().error, /Renderer unavailable/); assert.equal(h.frames.size, 0);
  h.fail(false); h.tour.stop(); assert.deepEqual(h.camera, h.initial);
  h.tour.play(); h.fail(true); assert.throws(() => h.tour.dispose()); assert.equal(h.frames.size, 0);
  assert.throws(() => h.tour.play(), /disposed/); h.tour.dispose();
});

test('observers receive snapshots, can unsubscribe, and cannot break completion or disposal', () => {
  const h = harness(); let calls = 0;
  const unsubscribe = h.tour.subscribe(value => { calls++; value.waypoints.length = 0; });
  h.tour.subscribe(() => { throw new Error('Broken observer'); });
  h.tour.import(document([home()], 0.25)); h.tour.play(); assert.equal(h.tour.getState().waypoints.length, 1);
  const before = calls; unsubscribe(); h.tick(250); assert.equal(calls, before); assert.equal(h.tour.getState().status, 'completed');
  h.tour.dispose(); assert.equal(h.frames.size, 0);
  assert.throws(() => h.tour.add(), /disposed/); assert.throws(() => h.tour.subscribe(() => {}), /disposed/);
});

// A small DOM boundary is sufficient for the ownership regression: closing is
// delegated to the session before it attempts a potentially failing restore.
function panelContainer() {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.events = {}; this.classList = { add() {}, toggle() {} }; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(type, listener) { this.events[type] = listener; }
    remove() {}
    find(predicate) { return predicate(this) ? this : this.children.map(child => child.find(predicate)).find(Boolean); }
  }
  const container = new Element('section');
  container.ownerDocument = { createElement: tag => new Element(tag) };
  return container;
}

test('panel delegates Close to its owner without attempting restoration first', async () => {
  const container = panelContainer(); let closed = 0, stopped = 0;
  const tour = { getState: () => ({ status: 'idle', waypoints: [], elapsed: 0, totalDuration: 0 }), subscribe: () => () => {},
    stop() { stopped++; throw new Error('Restoration unavailable'); } };
  const panel = createCameraTourPanel({ container, tour, onClose: async () => { closed++; } });
  const close = container.find(node => node.attributes['aria-label'] === 'Close camera tour');
  await close.events.click();
  assert.equal(closed, 1); assert.equal(stopped, 0);
  assert.equal(container.find(node => node.attributes.role === 'status').textContent, 'Ready');
  panel.dispose();
});

test('a standalone panel still stops the tour on Close and reports restoration failures', async () => {
  const container = panelContainer(); let stopped = 0;
  const tour = { getState: () => ({ status: 'idle', waypoints: [], elapsed: 0, totalDuration: 0 }), subscribe: () => () => {},
    stop() { stopped++; throw new Error('Restoration unavailable'); } };
  const panel = createCameraTourPanel({ container, tour });
  await container.find(node => node.attributes['aria-label'] === 'Close camera tour').events.click();
  assert.equal(stopped, 1);
  assert.equal(container.find(node => node.attributes.role === 'status').textContent, 'Restoration unavailable');
  panel.dispose();
});
