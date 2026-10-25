'use strict';
// Run the production host callbacks in a small VM boundary; no renderer or HA
// connection is needed. CAMERA_TOUR_ROOT can point at an integration worktree.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(process.env.CAMERA_TOUR_ROOT || path.join(__dirname, '..'));
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function section(source, start, end) {
  const from = source.indexOf(start), to = end ? source.indexOf(end, from + start.length) : source.length;
  assert(from >= 0 && to > from, `Production source section missing: ${start}`);
  return source.slice(from, to);
}
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`); }
function element() {
  return { style: { display: 'block' }, dataset: {}, attributes: {}, hidden: false,
    setAttribute(key, value) { this.attributes[key] = value; }, addEventListener() {}, append() {}, focus() {} };
}
async function homeHost() {
  const nodes = new Map(), counts = { renders: 0, requests: 0, navigationWrites: 0 };
  const context = vm.createContext({
    model: { id: 'main', rooms: [{ id: 'living' }, { id: 'study' }] },
    selected: 'living', signalZone: '', zoom: 1, panX: 0, panY: 0, homeRotation: 0, homeTilt: 0.2,
    mapDraft: null, mapLayer: null, mapLoaded: false, mapFraming: null,
    renderer: { domElement: element() }, failed3D: false, renderLost: false, renderSuspended: false,
    tourSessions: new Map(), vt: text => text,
    $: id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    document: { hidden: false, addEventListener() {}, createElement: element, body: { append() {} } },
    window: { addEventListener() {}, renderModel() { counts.renders++; }, homeMapNavigationChanged() { counts.navigationWrites++; } },
    requestRender() { counts.requests++; }, setEditorStatus() {}, previewTV() {},
    hideMediaControls() {}, cancelNativePress() {}, clearActivityLocation() {}, refreshControls() {},
  });
  const home = read('home-view.js');
  vm.runInContext(section(home, '  function mapAvailable()', '  function exportNavigationState()') +
    section(home, '  function captureTourPose()', '  function refreshMapStatus()') +
    section(home, '  function updateZoom(', '  function zoomAt(') +
    '\nfunction notifyMapNavigation(){window.homeMapNavigationChanged();}\n' +
    'globalThis.homeView={active:true,captureTourPose,applyTourPose};', context);
  let callbacks;
  context.captureSession = options => { callbacks = options; return { show() {}, close() {}, interrupt() {}, dispose() {} }; };
  vm.runInContext(read('camera-tour-viewer.js'), context);
  // Supply the lazy module at its documented session boundary. The callbacks
  // below are the real options produced by openViewerTour(), not test copies.
  await vm.runInContext('tourModulePromise=Promise.resolve({createCameraTourSession:captureSession});openViewerTour();', context);
  assert(callbacks, 'Home viewer did not install its camera session');
  return { context, callbacks, counts };
}
function plannerHost() {
  const project = { id: 'fixture', floors: [
    { id: 'ground', items: [{ id: 'item_1', name: 'Ground chair' }] },
    { id: 'upper', items: [{ id: 'item_1', name: 'Upper chair' }] },
  ] };
  const freeze = value => { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); };
  freeze(project);
  const counts = { ui: 0, bothPanes: 0, preview: 0 };
  let callbacks;
  const context = vm.createContext({
    project, activeFloorId: 'ground', selection: { kind: 'items', id: 'item_1' }, previewDirty: false,
    previewEdit: null, candidatePreview: null, siteEditor: null, renderer: { domElement: element() },
    orbit: { yaw: 0, pitch: 0.5, radius: 8, target: { x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } } },
    $: element, t: text => text, canNavigatePreview: () => true, renderPreview() {}, status() {},
    installPlannerTour(options) { callbacks = options; return {}; },
    renderUI() { counts.ui++; assert.equal(context.selection, null, 'Clear the old floor selection before rebuilding its inspector'); },
    requestCanvasRender() { counts.bothPanes++; }, requestPreviewRender() { counts.preview++; },
  });
  const editor = read('planner/editor.js');
  vm.runInContext(section(editor, 'function previewRadius(', 'function previewHint(') +
    section(editor, '// Navigation metadata is never written'), context);
  assert(callbacks, 'Planner did not install its camera session');
  return { context, callbacks, counts, project };
}
const homePose = changes => ({ type: 'home', floorId: 'viewer:main', room: 'living', rotation: 0, tilt: 0.2, zoom: 1, pan: [0, 0], ...changes });
const plannerPose = changes => ({ type: 'perspective', floorId: 'planner:upper', yaw: 0.4, pitch: 0.6, radius: 12, target: [4, 3, 2], ...changes });

test('Home host preserves the shortest 5 to -5 radian arc and renders once per applied pose', async () => {
  const { interpolatePose } = await import('data:text/javascript;base64,' + Buffer.from(read('camera-tour.js')).toString('base64'));
  const { callbacks, counts } = await homeHost();
  const start = homePose({ rotation: 5 }), end = homePose({ rotation: -5 });
  for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
    const pose = interpolatePose(start, end, progress), before = counts.renders;
    callbacks.apply(pose);
    const applied = callbacks.capture();
    near(Math.sin(applied.rotation), Math.sin(pose.rotation));
    near(Math.cos(applied.rotation), Math.cos(pose.rotation));
    assert.equal(counts.renders - before, 1, 'Each Home camera step must draw exactly once');
    assert.equal(counts.requests, 0, 'The synchronous navigation draw must not queue a duplicate draw');
    if (progress === 0.75) near(applied.rotation, 0.6415926535897931);
  }
  assert.equal(counts.navigationWrites, 0, 'Tours must not persist navigation through the HA bridge');
});

test('Home host rejects unavailable modes and wrong scope before changing camera or drawing', async () => {
  const { callbacks, context, counts } = await homeHost(), before = plain(callbacks.capture());
  for (const value of [homePose({ floorId: 'viewer:other' }), homePose({ room: 'missing' }), plannerPose()]) {
    assert.throws(() => callbacks.apply(value), /another plan/);
  }
  context.homeView.active = false;
  assert.throws(() => callbacks.apply(homePose()), /Open this view/);
  assert.throws(() => callbacks.capture(), /Open this view/);
  context.homeView.active = true; context.document.hidden = true;
  assert.throws(() => callbacks.apply(homePose()), /Open this view/);
  context.document.hidden = false;
  assert.deepEqual(plain(callbacks.capture()), before); assert.equal(counts.renders, 0); assert.equal(counts.requests, 0);
  context.zoom = 0.1; assert.throws(() => callbacks.capture(), /house view/);
});

test('planner floor cuts clear duplicate-ID selections and schedule both panes without editing the project', () => {
  const { callbacks, context, counts, project } = plannerHost(), before = JSON.stringify(project);
  callbacks.apply(plannerPose());
  assert.equal(context.activeFloorId, 'upper'); assert.equal(context.selection, null); assert.equal(context.previewDirty, true);
  assert.equal(counts.ui, 1); assert.equal(counts.bothPanes, 1); assert.equal(counts.preview, 1);
  assert.deepEqual(plain(callbacks.capture()), plannerPose());
  assert.equal(context.project, project); assert.equal(JSON.stringify(project), before);
  callbacks.apply(plannerPose({ target: [5, 3, 2] }));
  assert.equal(counts.ui, 1, 'Same-floor motion must not rebuild the inspector');
  assert.equal(counts.bothPanes, 1, 'Same-floor motion does not repaint the 2D plan');
  assert.equal(counts.preview, 2);
});

test('planner rejects wrong mode, missing floors and excessive coordinates atomically', () => {
  const { callbacks, context, counts, project } = plannerHost(), before = JSON.stringify(project);
  for (const value of [homePose({ floorId: 'planner:upper' }), plannerPose({ floorId: 'planner:missing' }), plannerPose({ target: [10001, 0, 0] })]) {
    assert.throws(() => callbacks.apply(value), /another plan/);
  }
  assert.equal(context.activeFloorId, 'ground'); assert.deepEqual(plain(context.selection), { kind: 'items', id: 'item_1' });
  assert.deepEqual(counts, { ui: 0, bothPanes: 0, preview: 0 }); assert.equal(JSON.stringify(project), before);
  context.canNavigatePreview = () => false;
  assert.equal(callbacks.available(), false); assert.throws(() => callbacks.capture(), /3D preview/);
});
