// Execute the real startup/render/resize functions with a controlled frame queue.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../viewer.js'), 'utf8');

function exercise(embedded, {hidden = false, initialRoom = null, failRender = false} = {}) {
  const errors = [], calls = [], sizes = [], frames = [];
  const loadError = {style: {}};
  const box = {width: hidden ? 0 : 800, height: hidden ? 0 : 600};
  const c = vm.createContext({
    embedded, window: {}, homeView: null, renderCount: 0, scene: {},
    model: {initial_room: initialRoom}, camera: {updateProjectionMatrix() {}},
    console: {error(error) { errors.push(error.message); }},
    requestAnimationFrame(callback) { frames.push(callback); },
    updateWallOutlines() {}, updateEditorCamera() {},
    $(id) { return id === 'loadError' ? loadError : {getBoundingClientRect: () => box}; },
    renderer: {
      setSize(width, height) { sizes.push([width, height]); },
      render() { calls.push({mode: 'editor', published: c.completed === true}); },
    },
    focusRoom(id) { c.focused = id; c.window.renderModel(); },
    rebuildInventoryView() { c.window.renderModel(); },
  });
  const lines = source.split('\n');
  const declaration = lines.find(line => line.startsWith('let initialViewReady='));
  const render = lines.find(line => line.startsWith('function render(){'));
  const resize = lines.find(line => line.startsWith("let viewSize='';")).split(';const observer=')[0] + ';';
  const report = lines.find(line => line.startsWith('function report3DError('));
  vm.runInContext([declaration, report, render, resize].join('\n'), c);
  c.window.resizeModel(); // The existing resize before Home is initialized.
  c.homeView = {
    active: false,
    setActive(value) {
      this.active = value;
      // Home already schedules a resize; it must still wait for the startup gate.
      frames.push(() => c.window.resizeModel());
    },
    render() {
      if (failRender) throw Error('first draw failed');
      calls.push({mode: 'home', published: c.completed === true, state: c.latestState});
      c.renderCount++;
    },
  };
  const bootstrap = lines.find(line => line.startsWith('rebuildInventoryView();if(embedded)')).split('window.floorplan=')[0];
  vm.runInContext(bootstrap + 'this.completed=true;', c);
  const flushFrames = () => { while (frames.length) frames.shift()(); };
  return {c, calls, sizes, box, frames, flushFrames, errors, loadError};
}

const home = exercise(true);
assert.equal(home.c.completed, true);
assert.deepEqual(home.calls, [], 'Embedded bootstrap publishes before drawing');
assert.deepEqual(home.sizes, [], 'Skipped startup sizes must not poison the resize cache');
// An init/state message can arrive before a rendering opportunity. Preserve it,
// but do not draw at the default canvas size before the queued initial resize.
home.c.latestState = 'new HA state';
home.c.rebuildInventoryView();
home.c.window.resizeModel();
assert.deepEqual(home.calls, []);
home.frames.shift()();
assert.deepEqual(home.calls, [], 'The resize queued by setActive waits for the gate');
home.flushFrames();
assert.deepEqual(home.calls, [{mode: 'home', published: true, state: 'new HA state'}]);
assert.deepEqual(home.sizes, [[800, 600]]);
home.c.window.resizeModel();
assert.equal(home.calls.length, 1, 'An unchanged resize must not duplicate the draw');
home.c.homeView.setActive(false);
home.flushFrames();
assert.equal(home.calls.at(-1).mode, 'editor');
home.c.homeView.setActive(true);
home.flushFrames();
assert.equal(home.calls.at(-1).mode, 'home');
home.box.width = 1000;
home.c.window.resizeModel();
assert.equal(home.calls.length, 4, 'Later resize still draws');
home.c.window.renderModel();
assert.equal(home.calls.length, 5, 'Later explicit/context-restored render still draws');

const switched = exercise(true);
switched.c.homeView.setActive(false);
switched.flushFrames();
assert.deepEqual(switched.calls, [{mode: 'editor', published: true}], 'The first draw honors a mode switch before its frame');
const hidden = exercise(true, {hidden: true});
hidden.flushFrames();
assert.deepEqual(hidden.calls, []);
hidden.box.width = 800;
hidden.box.height = 600;
hidden.c.window.resizeModel();
assert.equal(hidden.calls[0].mode, 'home', 'A hidden panel draws once it becomes visible');
const failed = exercise(true, {failRender: true});
failed.flushFrames();
assert.deepEqual(failed.errors, ['first draw failed']);
assert.equal(failed.loadError.style.display, 'block');
assert.match(failed.loadError.textContent, /first draw failed/);
assert.equal(failed.c.completed, true, 'A first-draw error must not abort publication');
for (const initialRoom of [null, 'L']) {
  const standalone = exercise(false, {initialRoom});
  assert.deepEqual(standalone.calls.map(call => call.mode), initialRoom ? ['editor', 'editor', 'editor'] : ['editor', 'editor']);
  assert.deepEqual(standalone.sizes, [[800, 600]]);
  assert.equal(standalone.c.focused, initialRoom || undefined);
}
console.log('PASS: deferred initial Home, early state/mode changes, frame ordering, hidden panels, resize, standalone and first-draw fallback.');
