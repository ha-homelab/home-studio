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
async function homeHost({ embedded = false, canEdit = true, mode = 'home' } = {}) {
  const THREE = await import('data:text/javascript;base64,' + Buffer.from(read('vendor/three.module.min.js')).toString('base64'));
  const architecture = new THREE.Group(), building = new THREE.Mesh(new THREE.BoxGeometry(24, 8, 40));
  building.position.set(5, 3, 7); architecture.add(building);
  const nodes = new Map(), counts = { renders: 0, requests: 0, navigationWrites: 0, exportGrants: [] };
  const context = vm.createContext({
    embedded, canEdit, THREE, root: architecture, camera: new THREE.PerspectiveCamera(42, 1, .1, 1000),
    planCenter: [5, 7], planBounds: null, planRadius: 60,
    target: new THREE.Vector3(3, 1, 2), radius: 4, azimuth: 0.2, polar: 0.8,
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
  context.homeView.active = mode === 'home';
  let callbacks;
  context.captureSession = options => { callbacks = options; return { show() {}, hide() {}, close() {}, interrupt() {}, dispose() {},
    setExportAllowed(value) { counts.exportGrants.push(value); } }; };
  vm.runInContext(read('camera-tour-viewer.js'), context);
  // Supply the lazy module at its documented session boundary. The callbacks
  // below are the real options produced by openViewerTour(), not test copies.
  await vm.runInContext('tourModulePromise=Promise.resolve({createCameraTourSession:captureSession});openViewerTour();', context);
  assert(callbacks, 'Home viewer did not install its camera session');
  return { context, callbacks, counts };
}
function plannerHost() {
  const item = { rotation_deg: 0, position_m: { x: 2, z: 2 }, dimensions_m: { width: 1, depth: 1 } };
  const project = { id: 'fixture', floors: [
    { id: 'ground', elevation_m: 0, height_m: 3, walls: [], rooms: [{ polygon: [[0, 0], [20, 0], [20, 12], [0, 12]] }], items: [{ ...item, id: 'item_1', name: 'Ground chair' }] },
    { id: 'upper', elevation_m: 3, height_m: 3, walls: [], rooms: [{ polygon: [[4, 2], [16, 2], [16, 10], [4, 10]] }], items: [{ ...item, id: 'item_1', name: 'Upper chair' }] },
  ] };
  const freeze = value => { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); };
  freeze(project);
  const counts = { ui: 0, bothPanes: 0, preview: 0 };
  let callbacks;
  const context = vm.createContext({
    project, activeFloorId: 'ground', selection: { kind: 'items', id: 'item_1' }, previewDirty: false,
    size: { width: 1200, height: 800 }, allFloors: false,
    previewFloors: () => context.allFloors ? project.floors : project.floors.filter(floor => floor.id === context.activeFloorId),
    previewEdit: null, candidatePreview: null, siteEditor: null, renderer: { domElement: element() },
    orbit: { yaw: 0, pitch: 0.5, radius: 8, target: { x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } } },
    $: element, t: text => text, canNavigatePreview: () => true, renderPreview() {}, status() {},
    installPlannerTour(options) { callbacks = options; return {}; },
    renderUI() { counts.ui++; assert.equal(context.selection, null, 'Clear the old floor selection before rebuilding its inspector'); },
    requestCanvasRender() { counts.bothPanes++; }, requestPreviewRender() { counts.preview++; },
  });
  const editor = read('planner/editor.js');
  vm.runInContext(section(read('planner/model.js'), 'export function floorBounds(').replace('export ', '') +
    section(editor, 'function previewFit()', 'function fitPreview()') +
    section(editor, 'function previewRadius(', 'function previewHint(') +
    section(editor, '// Navigation metadata is never written'), context);
  assert(callbacks, 'Planner did not install its camera session');
  return { context, callbacks, counts, project };
}
const homePose = changes => ({ type: 'home', floorId: 'viewer:main', room: 'living', rotation: 0, tilt: 0.2, zoom: 1, pan: [0, 0], ...changes });
const plannerPose = changes => ({ type: 'perspective', floorId: 'planner:upper', yaw: 0.4, pitch: 0.6, radius: 12, target: [4, 3, 2], ...changes });

test('native export permission follows the trusted init grant; standalone remains enabled', async () => {
  const family = await homeHost({ embedded: true, canEdit: false });
  assert.equal(family.callbacks.canExport, false);
  assert.equal(family.counts.exportGrants.at(-1), false);
  family.context.event = { data: { can_edit: true } };
  const grant = section(read('viewer.js'), 'canEdit=event.data.can_edit===true;', 'document.body.classList.toggle');
  vm.runInContext(grant, family.context);
  assert.equal(family.counts.exportGrants.at(-1), true, 'trusted init refreshes an already-open panel');
  family.context.event.data.can_edit = false;
  vm.runInContext(grant, family.context);
  assert.equal(family.counts.exportGrants.at(-1), false);
  const owner = await homeHost({ embedded: true, canEdit: true });
  assert.equal(owner.callbacks.canExport, true);
  const standalone = await homeHost({ embedded: false, canEdit: false });
  assert.equal(standalone.callbacks.canExport, true);
});

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

test('Editor orbit fits the static house through all angles without changing a focused camera', async () => {
  const { callbacks, context, counts } = await homeHost({ mode: 'editor' });
  const original = plain(callbacks.capture()), THREE = context.THREE;
  const bounds = new THREE.Box3().setFromObject(context.root), corners = [];
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) corners.push(new THREE.Vector3(x, y, z));
  for (const aspect of [0.35, 1, 2.1]) {
    context.camera.aspect = aspect;
    const beforeRequests = counts.requests;
    const pose = callbacks.captureOrbit();
    assert.deepEqual(plain(pose.target), [5, 3, 7]); assert(pose.radius > original.radius);
    near(pose.yaw, original.yaw); near(pose.pitch, original.pitch);
    assert.deepEqual(plain(callbacks.capture()), original, 'preparing an orbit must not move the camera');
    assert.equal(counts.requests, beforeRequests, 'preparing an orbit must not request a render');
    callbacks.apply(pose);
    assert(context.camera.far >= pose.radius * 4, 'a portrait fit must not place the house past the far clip plane');
    const camera = new THREE.PerspectiveCamera(42, aspect, .1, context.camera.far), center = new THREE.Vector3(...pose.target);
    for (let degree = 0; degree <= 360; degree += 5) {
      const yaw = degree * Math.PI / 180, horizontal = Math.cos(pose.pitch) * pose.radius;
      camera.position.set(center.x + Math.cos(yaw) * horizontal, center.y + Math.sin(pose.pitch) * pose.radius, center.z + Math.sin(yaw) * horizontal);
      camera.lookAt(center); camera.updateMatrixWorld();
      for (const corner of corners) {
        const point = corner.clone().project(camera);
        assert(Math.abs(point.x) < 1 && Math.abs(point.y) < 1 && Math.abs(point.z) < 1, `House clips at aspect ${aspect}, angle ${degree}`);
      }
    }
    callbacks.apply(original);
  }
  assert.equal(counts.renders, 0); assert.equal(counts.requests, 6); assert.equal(counts.navigationWrites, 0);
  context.homeView.active = true; assert.throws(() => callbacks.captureOrbit(), /Open this view/);
});

test('Planner orbit uses the complete visible floor fit without changing close-up navigation or project data', () => {
  const { callbacks, context, counts, project } = plannerHost();
  const original = plain(callbacks.capture()), before = JSON.stringify(project);
  const landscape = callbacks.captureOrbit();
  assert.deepEqual(plain(landscape.target), [10, 1.5, 6]); assert(landscape.radius > original.radius);
  near(landscape.yaw, original.yaw); near(landscape.pitch, original.pitch);
  context.size.width = 280; const portrait = callbacks.captureOrbit(); assert(portrait.radius > landscape.radius);
  context.allFloors = true; assert.deepEqual(plain(callbacks.captureOrbit().target), [10, 3, 6]);
  assert.deepEqual(plain(callbacks.capture()), original);
  assert.equal(JSON.stringify(project), before); assert.deepEqual(counts, { ui: 0, bothPanes: 0, preview: 0 });
  context.canNavigatePreview = () => false; assert.throws(() => callbacks.captureOrbit(), /3D preview/);
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

test('whole-house framing includes static porches through every orbit angle without fitting backdrops or moving objects', async () => {
  const THREE = await import('data:text/javascript;base64,' + Buffer.from(read('vendor/three.module.min.js')).toString('base64'));
  const architecture = new THREE.Group();
  const porch = new THREE.Mesh(new THREE.BoxGeometry(10, 3, 40));
  porch.position.set(5, 1, 5); architecture.add(porch);
  const bounds = new THREE.Box3().setFromObject(architecture), corners = [];
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    corners.push(new THREE.Vector3(x, y, z));
  }
  let boundReads = 0;
  const update = architecture.updateWorldMatrix;
  architecture.updateWorldMatrix = function (...args) { boundReads++; return update.apply(this, args); };
  const scene = new THREE.Scene(), moving = new THREE.Group();
  scene.add(architecture, new THREE.Mesh(new THREE.BoxGeometry(100000, 1, 100000)), moving);
  moving.add(new THREE.Mesh(new THREE.BoxGeometry(20000, 20000, 20000)));
  const rect = { width: 1290, height: 1310 };
  const context = vm.createContext({
    THREE, active: true, renderer: {}, root: architecture, scene, objectGroup: moving,
    markerViewport: '', markerMotion: {reset() {}},
    model: { ceiling_height_m: 3, rooms: [{ id: 'living', polygon: [[-2, -8], [2, -8], [2, 8], [-2, 8]] }] },
    selected: '', zoom: 0.8, panX: 0, panY: 0, homeRotation: 0, homeTilt: 0,
    camera: null, cameraFit: null, houseFitBounds: null, planBounds: null, planRadius: 8,
    mapLayer: null, mapDraft: null, mapFraming: null,
    projectedPosition: new THREE.Vector3(), xm: value => value, zm: value => value,
    $: () => ({ getBoundingClientRect: () => rect }),
  });
  // Exercise the production projection path with real Three.js matrices but no
  // renderer, browser, private model, HA connection, or mirrored fit algorithm.
  vm.runInContext(section(read('home-view.js'), '  function render() {', '    if(cameraOnly)return;') + '\n}', context);
  for (const aspect of [0.35, 1290 / 1310, 2.1]) {
    rect.width = rect.height * aspect;
    for (const tilt of [-0.45, 0.2, 0.6]) for (let degree = 0; degree <= 360; degree += 5) {
      context.homeRotation = degree * Math.PI / 180; context.homeTilt = tilt;
      vm.runInContext('render(true)', context);
      for (const point of corners) {
        const projected = point.clone().project(context.camera);
        assert(Math.abs(projected.x) < 0.71 && Math.abs(projected.y) < 0.71,
          `Static porch clips at aspect ${aspect}, tilt ${tilt}, angle ${degree}`);
      }
      assert(context.camera.top - context.camera.bottom < 200, 'Backdrop or dynamic geometry inflated the fit');
    }
  }
  assert.equal(boundReads, 1, 'Static bounds must be cached across rotations and aspect changes');
  const wholeSpan = context.camera.top - context.camera.bottom;
  context.selected = 'living'; vm.runInContext('render(true)', context);
  assert(context.camera.top - context.camera.bottom < wholeSpan, 'Selected room must retain its own closer fit');
  context.selected = ''; context.mapLayer = { config: { enabled: true } };
  context.mapFraming = { span: 200, zoom: 0.8 }; vm.runInContext('render(true)', context);
  near(context.camera.top - context.camera.bottom, 200);
  assert.equal(boundReads, 1);
});
