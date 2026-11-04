import assert from 'node:assert/strict';
import { fitHostDialog, PROTOCOL } from '../planner/ha-bridge.js';

const channel = 'a'.repeat(32), origin = 'https://home.example';
function events() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    emit(type, event) { for (const listener of listeners.get(type) || []) listener(event); },
    count() { return [...listeners.values()].reduce((sum, value) => sum + value.size, 0); },
  };
}

const child = events(), sent = [];
child.parent = { postMessage: (...args) => sent.push(args) };
child.location = { href: `${origin}/planner/?embed=home-assistant#ha-studio=${channel}` };
const dialog = { open: true, style: {} }, dispose = fitHostDialog(dialog, child);
assert.equal(sent[0][0].open, true);
assert.equal(sent[0][1], origin);
const viewport = { protocol: PROTOCOL, channel, type: 'dialog-viewport', top: 24, height: 400 };
const receive = (data, extra = {}) => child.emit('message', { source: child.parent, origin, data, ...extra });
for (const extra of [{ source: {} }, { origin: 'https://elsewhere.example' }]) receive(viewport, extra);
for (const change of [{ channel: 'b'.repeat(32) }, { protocol: 'other' }, { top: -1 }, { top: '1' },
  { height: Infinity }, { height: 10001 }, { height: 20 }, { top: 9990 }]) receive({ ...viewport, ...change });
assert.deepEqual(dialog.style, {}, 'Untrusted or invalid messages cannot position the dialog.');
receive(viewport);
assert.deepEqual(dialog.style, { top: '36px', bottom: 'auto', marginBlock: '0', maxHeight: '376px' });
dialog.open = false; receive({ ...viewport, height: 600 });
assert.equal(dialog.style.maxHeight, '376px');
dispose(); dispose();
assert.equal(child.count(), 0); assert.equal(sent.length, 2); assert.equal(sent[1][0].open, false);
const standalone = { location: { href: `${origin}/planner/` } }; standalone.parent = standalone;
fitHostDialog(dialog, standalone)();

// Load the actual host class without creating an editor, browser or HA session.
const browser = events(), visual = Object.assign(events(), { offsetTop: 0, height: 600 });
browser.visualViewport = visual; browser.innerHeight = 600;
const frames = new Map(), timers = new Map(), navigation = [];
let sequence = 0, Host, frameTop = 300;
function makeFrame() {
  return { contentWindow: {}, isConnected: true, setAttribute() {},
    remove() { this.isConnected = false; },
    scrollIntoView: options => { navigation.push(options); frameTop = 40; },
    getBoundingClientRect: () => ({ top: frameTop, bottom: frameTop + 780 }),
  };
}
const globals = {
  HTMLElement: class {}, window: browser, URL,
  document: { createElement: tag => { assert.equal(tag, 'iframe'); return makeFrame(); } },
  customElements: { get: () => null, define: (_name, value) => { Host = value; } },
  requestAnimationFrame: callback => { frames.set(++sequence, callback); return sequence; },
  cancelAnimationFrame: id => frames.delete(id),
  setTimeout: callback => { timers.set(++sequence, callback); return sequence; },
  clearTimeout: id => timers.delete(id),
};
const original = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
Object.assign(globalThis, globals);
try {
await import('../custom_components/home_floorplan/static/studio.js');
const host = Object.assign(Object.create(Host.prototype), events()), messages = [];
Object.assign(host, { _ready: true, _frame: makeFrame(), _channel: channel, _generation: 0,
  _editorUrl: new URL(`${origin}/home-floorplan-studio/planner/`),
  // Unrelated transports and UI are inert; lifecycle/viewport/timer methods are real.
  _cancelViewerRuntime() {}, _resetMapTransport() {}, _disposeAi() {}, _status() {}, _buttons() {},
  $: () => ({}), shadowRoot: { append() {} },
  getBoundingClientRect: () => ({ top: 40, bottom: 700 }),
  _send: (type, payload) => messages.push({ type, ...payload }),
});
const send = (data, extra = {}) => host._onMessage({ source: host._frame?.contentWindow, origin: 'null',
  data: { protocol: PROTOCOL, channel: host._channel, type: 'dialog-state', ...data }, ...extra });
const tick = () => { const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback()); };
const listenerCount = () => browser.count() + visual.count() + host.count();
send({ open: true }, { source: {} }); send({ open: true }, { origin }); send({ open: true, channel: 'wrong' });
assert.equal(navigation.length, 0);
send({ open: true }); send({ open: true });
assert.equal(navigation.length, 1); assert.equal(frames.size, 1);
tick(); assert.deepEqual(messages, [{ type: 'dialog-viewport', top: 0, height: 560 }]);
browser.emit('scroll'); visual.emit('resize'); browser.emit('resize');
assert.equal(frames.size, 1, 'Viewport reads are coalesced, never an animation loop.');
tick(); assert.equal(messages.length, 1, 'Unchanged rectangles do not produce more messages.');
visual.offsetTop = 80; visual.height = 300; visual.emit('resize'); tick();
assert.deepEqual(messages[1], { type: 'dialog-viewport', top: 40, height: 300 });
// A panel scroll inside a shadow root is not a window scroll event.
frameTop = 10; host.emit('scroll');
assert.equal(frames.size, 1, 'Direct panel scrolling must schedule a viewport update.');
tick(); assert.deepEqual(messages[2], { type: 'dialog-viewport', top: 70, height: 300 });
assert.equal(frames.size, 0, 'Publishing does not start an idle animation loop.');
browser.emit('resize'); send({ open: false });
assert.equal(frames.size, 0); assert.equal(listenerCount(), 0);
assert.equal(host._dialogViewportCleanup, null);
host.emit('scroll'); assert.equal(frames.size, 0, 'Closing removes the direct panel listener.');
send({ open: true }); host._stopDialogViewport(); host._stopDialogViewport();
assert.equal(frames.size, 0); assert.equal(listenerCount(), 0);

// Replacing an editor must discard the old frame's listeners and pending frame.
send({ open: true }); assert.equal(frames.size, 1);
const oldFrame = host._frame, oldChannel = host._channel;
host._openEditor(null);
assert.equal(oldFrame.isConnected, false); assert.notEqual(host._frame, oldFrame);
assert.equal(host._dialogViewportCleanup, null);
assert.equal(frames.size, 0); assert.equal(listenerCount(), 0);
assert.equal(timers.size, 2, 'Only the normal editor startup/navigation timers remain.');
host._ready = true;
send({ open: true, channel: oldChannel }, { source: oldFrame.contentWindow });
assert.equal(frames.size, 0, 'The old editor cannot restart tracking.');
send({ open: true }); assert.equal(frames.size, 1);
let before = messages.length; tick(); assert.equal(messages.length, before + 1);
assert.deepEqual(messages.at(-1), { type: 'dialog-viewport', top: 40, height: 300 });
assert.equal(frames.size, 0);

// A startup failure also removes an active tracker and allows a later retry.
host.emit('scroll'); assert.equal(frames.size, 1);
const failedFrame = host._frame;
host._failStartup('Synthetic startup failure');
assert.equal(failedFrame.isConnected, false); assert.equal(host._frame, null);
assert.equal(host._dialogViewportCleanup, null);
assert.equal(frames.size, 0); assert.equal(timers.size, 0); assert.equal(listenerCount(), 0);
host._openEditor(null); host._ready = true;
send({ open: true }); assert.equal(frames.size, 1);
before = messages.length; tick(); assert.equal(messages.length, before + 1);
assert.equal(frames.size, 0);
send({ open: false }); host._clearStartup(); host._clearEditorNavigation();
assert.equal(listenerCount(), 0); assert.equal(frames.size, 0); assert.equal(timers.size, 0);
console.log('Dialog viewport: trusted geometry, direct panel scroll, replacement/retry, coalescing, cleanup and standalone fallback PASS');
} finally {
  for (const [key, descriptor] of Object.entries(original)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
}
