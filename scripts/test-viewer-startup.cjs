// Execute the real startup/render/resize functions with a controlled frame queue.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../viewer.js'), 'utf8');

function exercise(embedded, {hidden = false, initialRoom = null, failRender = false, homeAvailable = true} = {}) {
  const errors = [], calls = [], sizes = [], frames = [];
  const loadError = {style: {}};
  const box = {width: hidden ? 0 : 800, height: hidden ? 0 : 600};
  const c = vm.createContext({
    embedded, window: {}, homeView: null, environmentLayer: null, renderCount: 0, scene: {},
    viewerI18n: {locale: 'en'}, items: [], root: null, objectGroup: null,
    document: {hidden: false}, renderSuspended: false, renderLost: false, devicePixelRatio: 1, renderProfile: {pixels: 2000000},
    requestRender() {}, renderRequest: 0, renderDelay: 0, interactionPointer: null, coalesceMotion: false, cancelAnimationFrame() {}, clearTimeout() {},
    model: {initial_room: initialRoom}, camera: {updateProjectionMatrix() {}},
    console: {error(error) { errors.push(error.message); }},
    requestAnimationFrame(callback) { frames.push(callback); },
    updateWallOutlines() {}, updateEditorCamera() {},
    wallSheenMotion: {beforeRender() {}, afterRender() {}},
    $(id) { return id === 'loadError' ? loadError : {getBoundingClientRect: () => box}; },
    renderer: {
      setDrawingBufferSize(width, height) { sizes.push([width, height]); },
      render() { calls.push({mode: 'editor', published: c.completed === true}); },
    },
    focusRoom(id) { c.focused = id; c.window.renderModel(); },
    rebuildInventoryView() { c.window.renderModel(); },
  });
  const lines = source.split('\n');
  const declaration = lines.find(line => line.startsWith('let initialViewReady='));
  const render = lines.find(line => line.startsWith('function render(){'));
  const cancelRender = lines.find(line => line.startsWith('function cancelRender('));
  const drawScene = lines.find(line => line.startsWith('function drawScene('));
  const pixelRatio = lines.find(line => line.startsWith('function renderPixelRatio('));
  const resize = lines.find(line => line.startsWith("let viewSize='';")).split(';const observer=')[0] + ';';
  const report = lines.find(line => line.startsWith('function report3DError('));
  vm.runInContext([declaration, report, drawScene, pixelRatio, cancelRender, render, resize].join('\n'), c);
  c.window.resizeModel(); // The existing resize before Home is initialized.
  if (homeAvailable) c.homeView = {
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
  const bootstrap = lines.find(line => line.startsWith('rebuildInventoryView();if(embedded)'));
  assert(bootstrap, 'The actual viewer bootstrap and diagnostic API must be present');
  vm.runInContext(bootstrap + 'this.completed=true;', c);
  const flushFrames = () => { while (frames.length) frames.shift()(); };
  return {c, calls, sizes, box, frames, flushFrames, errors, loadError};
}

const home = exercise(true);
assert.equal(home.c.completed, true);
assert.equal(home.c.window.floorplan.homeMode, true);
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
assert.equal(failed.c.completed, true, 'A first-draw error must not abort publication');
failed.c.window.resizeModel();
failed.c.window.renderModel();
assert.deepEqual(failed.errors, ['first draw failed'], 'Recovery edits and resize must not retry the failed renderer');
for (const initialRoom of [null, 'L']) {
  const standalone = exercise(false, {initialRoom});
  assert.deepEqual(standalone.calls.map(call => call.mode), initialRoom ? ['editor', 'editor', 'editor'] : ['editor', 'editor']);
  assert.deepEqual(standalone.sizes, [[800, 600]]);
  assert.equal(standalone.c.focused, initialRoom || undefined);
}
for (const embedded of [false, true]) {
  const missingHome = exercise(embedded, {homeAvailable: false});
  assert.equal(missingHome.c.completed, true, 'Missing Home view does not abort bootstrap');
  const diagnostics = missingHome.c.window.floorplan;
  assert.equal(diagnostics.homeMode, false);
  assert.deepEqual(Array.from(diagnostics.illuminated), []);
  assert.equal(diagnostics.locale, 'en');
  assert.equal(diagnostics.items, missingHome.c.items);
  for (const key of ['meshCount', 'objectCount', 'translucentObjectMeshCount', 'objectMeshCount']) assert.equal(diagnostics[key], 0);
  missingHome.flushFrames();
  assert(missingHome.calls.length > 0 && missingHome.calls.every(call => call.mode === 'editor'), 'The editor still renders without Home view');
  assert.equal(diagnostics.renderCount, missingHome.c.renderCount);
  assert.deepEqual(missingHome.errors, []);
}
console.log('PASS: deferred initial Home, early state/mode changes, frame ordering, hidden panels, resize, standalone, absent Home diagnostics and first-draw fallback.');

// A matching host handshake must not discard the geometry and shadow maps just
// built at boot. Execute the actual handler, validator and reconciler together.
function exerciseHostInventory(transform = value => value) {
  const bootItems = [{id: 'lamp', name: 'Lamp', type: 'lamp', room: 'A', entity_id: 'light.lamp',
    position_m: {x: 1, y: 2, z: 3}, dimensions_m: {width: .3, depth: .3, height: .2}, rotation_deg: 0}];
  const calls = {builds: 0, refreshes: 0, preferences: [], sent: [], status: [], removed: 0, artwork: [], commands: [], dismissals: 0};
  let handler;
  const aside = {inert: true}, parent = {}, port = {postMessage: message => calls.sent.push(message)};
  const c = vm.createContext({
    items: bootItems, bridge: null, parent, model: {rooms: [{id: 'A'}], inventory: bootItems}, presets: {lamp: {}},
    appearanceRefreshNotice: '', inventoryAppearance() { return {}; },
    window: {addEventListener(type, callback) { assert.equal(type, 'message'); handler = callback; },
      applyMediaArtwork(value) { calls.artwork.push(value); },
      removeEventListener(type, callback) { assert.equal(callback, handler); calls.removed++; }},
    document: {body:{classList:{toggle(){}}},querySelector: () => aside}, $:()=>({}),
    homeView: {applyViewPreferences(value) { calls.preferences.push(value); }, handleCommandResult(value) { calls.commands.push(value); }, dismissOverlays() { calls.dismissals++; }},
    setEditorStatus(value) { calls.status.push(value); },
    refreshEntityPresentation() { calls.refreshes++; },
    rebuildInventoryView() { calls.builds++; c.refreshEntityPresentation(); },
    haStates: {}, haConnected: false, entityCatalog: null, refreshEntityOptions() {},
  });
  const reconcileStart = source.indexOf('function reconcileStoredAppearance(');
  const validateEnd = source.indexOf('\n', source.indexOf('function validateInventoryItems('));
  vm.runInContext(source.slice(reconcileStart, validateEnd), c);
  vm.runInContext(source.split('\n').find(line => line.startsWith('function inventorySnapshot(')), c);
  const initStart = source.indexOf("window.addEventListener('message',function init(event)");
  const initEnd = source.indexOf('\n});', initStart);
  assert(initStart >= 0 && initEnd > initStart, 'Actual host initialization handler exists');
  vm.runInContext(source.slice(initStart, initEnd + 4), c);
  const incoming = transform(JSON.parse(JSON.stringify(bootItems)));
  handler({source: parent, data: {type: 'home-floorplan:init', can_edit:true, items: incoming, preferences: {sidebarCollapsed: true}}, ports: [port]});
  return {c, calls, bootItems, aside, port};
}
const sameInventory = exerciseHostInventory();
assert.equal(sameInventory.calls.builds, 0, 'Identical validated inventory reuses boot geometry and shadow maps');
assert.equal(sameInventory.c.items, sameInventory.bootItems, 'Identical data preserves the assigned array');
assert.equal(sameInventory.calls.refreshes, 0, 'An unchanged handshake does not redraw the already-presented disconnected state');
assert.equal(sameInventory.aside.inert, false);
assert.equal(sameInventory.c.bridge, sameInventory.port);
assert.equal(sameInventory.calls.preferences[0].sidebarCollapsed, true);
assert.equal(sameInventory.calls.sent[0].type, 'model_config');
assert.equal(sameInventory.calls.removed, 1);
sameInventory.port.onmessage({data: {type: 'states', connected: true, states: {}}});
assert.equal(sameInventory.calls.refreshes, 1, 'The first live host message refreshes presentation after skipping the unchanged handshake');
assert.equal(sameInventory.c.haConnected, true);
const artwork = {media: {entity_id: 'media_player.example', identity: 'artwork-1', image: 'data:image/jpeg;base64,YQ=='}};
sameInventory.port.onmessage({data: {type: 'media_artwork', artwork}});
sameInventory.port.onmessage({data: {type: 'media_artwork', artwork: {}}});
assert.equal(sameInventory.calls.artwork[0], artwork, 'Artwork snapshots use the established host port');
assert.deepEqual(sameInventory.calls.artwork[1], {}, 'An empty host snapshot clears artwork');
assert.equal(sameInventory.calls.refreshes, 1, 'Artwork delivery does not masquerade as entity state');
const command = {type: 'command_result', request_id: 'confirmed', ok: true};
sameInventory.port.onmessage({data: command});
assert.equal(sameInventory.calls.commands[0], command, 'An available Home view receives command replies');
const sentBeforeDismiss=sameInventory.calls.sent.length;
sameInventory.port.onmessage({data: {type: 'dismiss_overlays'}});
assert.equal(sameInventory.calls.dismissals, 1, 'Parent dismissal reaches the current Home view');
assert.equal(sameInventory.calls.sent.length, sentBeforeDismiss, 'Closing overlays sends no device command');
assert.equal(sameInventory.calls.refreshes, 1, 'Closing overlays does not rebuild live state');
sameInventory.c.homeView = null;
assert.doesNotThrow(() => sameInventory.port.onmessage({data: command}), 'A missing Home view must not crash the host bridge on command replies');
assert.doesNotThrow(() => sameInventory.port.onmessage({data: {type: 'dismiss_overlays'}}), 'A missing Home view safely ignores dismissal');
const reorderedInventory = exerciseHostInventory(items => items.map(item => Object.fromEntries(Object.entries(item).reverse().map(([key,value])=>[key,value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse()):value]))));
assert.equal(reorderedInventory.calls.builds, 0, 'JSON property order does not discard matching boot resources');
const changedInventory = exerciseHostInventory(items => { items[0].position_m.x = 7; return items; });
assert.equal(changedInventory.calls.builds, 1, 'Changed saved positions rebuild exactly once');
assert.notEqual(changedInventory.c.items, changedInventory.bootItems);
assert.equal(changedInventory.c.items[0].position_m.x, 7);
assert.equal(changedInventory.calls.refreshes, 1);
const invalidInventory = exerciseHostInventory(items => { items[0].position_m.x = 'invalid'; return items; });
assert.equal(invalidInventory.calls.builds, 0);
assert.equal(invalidInventory.calls.refreshes, 0);
assert.equal(invalidInventory.c.items, invalidInventory.bootItems, 'Invalid host data cannot replace boot data');
assert.equal(invalidInventory.c.bridge, null);
assert.equal(invalidInventory.aside.inert, true);
assert.equal(invalidInventory.calls.preferences.length, 0);
assert.equal(invalidInventory.calls.removed, 0, 'A rejected handshake can be retried');
assert.match(invalidInventory.calls.status[0], /Cannot load saved inventory: Coordinates must be finite numbers/);
console.log('PASS: matching host inventory retains boot resources; changed inventory, validation, preferences and live state delivery remain intact.');
