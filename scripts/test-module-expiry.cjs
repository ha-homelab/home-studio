'use strict';
// Synthetic clocks and entities exercise the shipped host and dialog code offline.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const source = read('home-view.js');
const start = source.indexOf('  // Advance the receipt clock');
const end = source.indexOf('  function dismissOnBackdrop', start);
assert.ok(start >= 0 && end > start);
const handlers = source.slice(start, end);
const origin = 1800000000000;
function fixture() {
  let wall = origin, monotonic = 0, next = 0, Panel;
  const timers = new Map(), elements = new Map();
  const target = () => ({ listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } });
  const element = id => {
    if (!elements.has(id)) elements.set(id, { ...target(), open: true, textContent: '' });
    return elements.get(id);
  };
  const item = { id: 'sample', name: 'Synthetic receiver', entity_id: 'binary_sensor.sample', room: 'room' };
  const spec = { entity_id: item.entity_id, room: item.room, modules_sensor: 'sensor.sample_modules' };
  const context = vm.createContext({
    HTMLElement: class {}, customElements: { get() { return Panel; }, define(_name, value) { Panel = value; } },
    Date: { now: () => wall }, performance: { now: () => monotonic },
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { fn, at: monotonic + delay }); return id; },
    clearTimeout: id => timers.delete(id), document: target(), window: target(),
    $: element, moduleItem: item, items: [item], receiverSpec: () => spec,
    receiverState: () => 'presence', activityText: { presence: 'Independent room evidence' },
    haConnected: true, haStates: {},
  });
  vm.runInContext(read('custom_components/home_floorplan/static/panel.js'), context);
  vm.runInContext(handlers, context);
  const panel = Object.create(Panel.prototype);
  Object.assign(panel, { savedItems: [], curtains: {}, moduleEntities: new Set([spec.modules_sensor]),
    refreshTVFrame() {}, refreshCameraFrames() {}, port: { postMessage(value) {
      context.haStates = value.states; context.haConnected = value.connected; context.updateModuleDialog();
    } } });
  function receive(attributes = {}, state = 'experimental', connected = true) {
    panel._hass = { connected, states: { [spec.modules_sensor]: { state, attributes: {
      module_summary: '1 fresh output', module_details: 'Synthetic diagnostic',
      module_snapshot_at_ms: origin, module_expires_at_ms: origin + 1000, module_fresh_count: 1,
      credential: 'must stay in host', ...attributes,
    } } } };
    panel.publishEntityStates();
    assert.equal(context.haStates[spec.modules_sensor].credential, undefined);
    assert.equal(element('moduleActivity').textContent, 'Independent room evidence');
  }
  function advance(ms) {
    wall += ms; monotonic += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= monotonic) { timers.delete(id); timer.fn(); }
  }
  return { receive, advance, context, timers, element, panel, rollback() { wall -= 10000; },
    visible: () => element('moduleDetails').textContent === 'Synthetic diagnostic' };
}
let f = fixture();
f.receive(); assert.ok(f.visible()); assert.equal(f.timers.size, 1);
f.advance(999); assert.ok(f.visible()); f.advance(1); assert.ok(!f.visible()); assert.equal(f.timers.size, 0);
f.receive(); assert.ok(!f.visible(), 'replay cannot renew expired data');
f = fixture(); f.receive(); f.advance(400); f.rollback();
f.receive({ module_expires_at_ms: origin + 1500 });
f.advance(600); assert.ok(!f.visible(), 'wall rollback and changed receipt cannot extend original lease');
f = fixture(); f.receive(); f.advance(100);
f.receive({ module_fresh_count: 0, module_expires_at_ms: origin + 1500 });
f.receive({ module_fresh_count: 1, module_expires_at_ms: origin + 1500 });
assert.ok(!f.visible(), 'an earlier event count cannot restore withdrawn output');
f = fixture(); f.receive(); f.element('moduleDialog').open = false;
f.element('moduleDialog').listeners.close(); assert.equal(f.timers.size, 0);
f.advance(1000); f.element('moduleDialog').open = true; f.context.updateModuleDialog(); assert.ok(!f.visible());
f = fixture(); f.receive(); f.context.window.listeners.pagehide(); assert.equal(f.timers.size, 0);
f.advance(1001); f.context.window.listeners.pageshow(); assert.ok(!f.visible());
for (const attributes of [
  { module_expires_at_ms: null }, { module_expires_at_ms: String(origin + 1000) },
  { module_expires_at_ms: origin + 2001 }, { module_expires_at_ms: NaN },
  { module_snapshot_at_ms: origin + 251 }, { module_fresh_count: -1 },
  { module_fresh_count: 65 }, { module_fresh_count: 0.5 }, { restored: true },
]) { f = fixture(); f.receive(attributes); assert.ok(!f.visible()); assert.equal(f.timers.size, 0); }
for (const state of ['unknown', 'unavailable', 'stale']) {
  f = fixture(); f.receive({}, state); assert.ok(!f.visible());
}
f = fixture(); f.receive({}, 'experimental', false); assert.ok(!f.visible());
f = fixture(); f.panel.moduleEntities.clear(); f.receive(); assert.ok(!f.visible(), 'unconfigured sensors are never projected');
console.log('PASS: host allowlist, original deadlines, replay/rollback, withdrawal, lifecycle and invalid metadata');
