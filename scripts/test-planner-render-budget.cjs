'use strict';
// Execute the planner's real handlers with deterministic frames and no GPU.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'planner/editor.js'), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert(a >= 0 && b > a, 'Production section exists: ' + start);
  return source.slice(a, b);
}
function surface() {
  return {events: {}, style: {}, hidden: true, checked: false,
    addEventListener(name, fn, options = {}) { this.events[name] = fn; options.signal?.addEventListener('abort', () => { delete this.events[name]; }, {once: true}); },
    focus() {}, setPointerCapture() {}, hasPointerCapture() { return false; }};
}
function frames(context) {
  let serial = 0;
  const pending = new Map();
  context.requestAnimationFrame = fn => { pending.set(++serial, fn); return serial; };
  context.cancelAnimationFrame = id => pending.delete(id);
  return {pending, flush() { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(fn => fn()); }};
}
const event = (x = 0, y = 0) => ({clientX: x, clientY: y, button: 0, pointerId: 1, preventDefault() {}});
const scheduler = section('let canvasFrame =', 'let startupMessage =');

(async () => {
  let pathBuilds = 0;
  class Outline {
    constructor() { this.commands = []; pathBuilds++; }
    moveTo(x, z) { this.commands.push(['move', x, z]); }
    lineTo(x, z) { this.commands.push(['line', x, z]); }
    closePath() { this.commands.push(['close']); }
  }
  const paths = vm.createContext({planPathCache: new WeakMap(), Path2D: Outline});
  vm.runInContext(section('function planShapePath(', 'function renderPlan('), paths);
  const shape = {points: [[-.5, -.5], [.5, -.5], [.25, .5]]};
  const outline = paths.planShapePath(shape, 80, 30);
  assert.deepEqual(outline.commands, [['move', -40, -15], ['line', 40, -15], ['line', 20, 15], ['close']]);
  for (let i = 0; i < 100; i++) assert.equal(paths.planShapePath(shape, 80, 30), outline);
  assert.equal(pathBuilds, 1, 'Repeated renders reuse the scaled path without resubmitting its vertices');
  const resized = paths.planShapePath(shape, 20, 60);
  assert.notEqual(resized, outline);
  assert.deepEqual(resized.commands, [['move', -10, -30], ['line', 10, -30], ['line', 5, 30], ['close']]);
  assert.equal(paths.planShapePath(shape, 20, 60), resized);
  assert.notEqual(paths.planShapePath(shape, 80, 30), outline, 'Only the latest size is retained, not an unbounded zoom history');
  assert.notEqual(paths.planShapePath({points: shape.points}, 80, 30), outline, 'A new appearance owns a separate outline');
  const THREE = await import('data:text/javascript;base64,' + fs.readFileSync(path.join(root, 'vendor/three.module.min.js')).toString('base64'));
  const model = await import('../planner/model.js');
  const project = model.blankProject(), f = project.floors[0];
  f.rooms.push({id: 'room', name: 'Room', polygon: [[0, 0], [8, 0], [8, 6], [0, 6]], material: 'floor'});
  f.walls.push({id: 'wall', start: [0, 0], end: [8, 0], thickness_m: .15});
  f.openings.push({id: 'door', wall_id: 'wall', type: 'door', offset_m: 1, width_m: .9, sill_m: 0, head_m: 2});
  f.items.push({id: 'item', name: 'Item', type: 'furniture', room: 'room', position_m: {x: 2, y: 0, z: 2}, dimensions_m: {width: 1, depth: 1, height: 1}, rotation_deg: 0, entity_id: '', notes: ''});
  model.validateProject(project);
  const elements = new Map(), makeSurface = id => {
    const canvas = surface();
    canvas.cloneNode = () => makeSurface(id); canvas.replaceWith = next => elements.set(id, next);
    return canvas;
  }, get = id => { if (!elements.has(id)) elements.set(id, makeSurface(id)); return elements.get(id); };
  const documentEvents = {}, windowEvents = {}, buffers = [];
  let constructions = 0, draws = 0, shadows = 0, disposals = 0, losses = 0, disconnects = 0, planDraws = 0;
  let rendererName = 'ANGLE SwiftShader';
  let rect = {width: 3840, height: 2160};
  class Renderer {
    constructor() { constructions++; this.shadowMap = {}; }
    getContext() { return {getExtension: () => ({UNMASKED_RENDERER_WEBGL: 1}), getParameter: () => rendererName}; }
    setClearColor() {}
    setSize() { throw Error('Drawing must not reset the canvas on every frame'); }
    setPixelRatio() { throw Error('Resize dimensions and pixel ratio atomically'); }
    setDrawingBufferSize(w, h, ratio) { buffers.push([w, h, ratio]); }
    render(scene, camera) {
      draws++; scene.updateMatrixWorld(); camera.updateMatrixWorld();
      scene.traverse(object => { if (object.castShadow && object.shadow && (object.shadow.autoUpdate || object.shadow.needsUpdate)) { shadows++; object.shadow.needsUpdate = false; } });
    }
    dispose() { disposals++; }
    forceContextLoss() { losses++; }
  }
  const c = vm.createContext({AbortController, THREE: {...THREE, WebGLRenderer: Renderer}, project, floor: () => project.floors[0],
    view: 'plan', previewDirty: true, size: {...rect}, map: {x: 0, y: 0}, devicePixelRatio: 3,
    $: get, planCanvas: get('plan-canvas'), ctx: {setTransform() {}},
    floorBounds: model.floorBounds, distance: model.distance, wallPieces: model.wallPieces,
    COLORS: {floor: '#eeeeee', furniture: '#aaaaaa'}, itemAsset: () => null,
    updateZoom() {}, fitPlan() {}, translatedText() {},
    renderPlan() { if (!c.document.hidden && !vm.runInContext('canvasSuspended', c)) { c.cancelCanvasRender(); planDraws++; } },
    document: {hidden: false, addEventListener(name, fn) { documentEvents[name] = fn; }, querySelector() { return {getBoundingClientRect: () => rect}; }},
    window: {addEventListener(name, fn) { windowEvents[name] = fn; }},
    ResizeObserver: class { observe() {} disconnect() { disconnects++; } },
  });
  const planBitmap = {width: 300, height: 150}, bitmapAreas = [];
  for (const dimension of ['width', 'height']) Object.defineProperty(get('plan-canvas'), dimension, {
    get: () => planBitmap[dimension],
    set(value) { planBitmap[dimension] = value; bitmapAreas.push(planBitmap.width * planBitmap.height); },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'planner/render-capacity.js'), 'utf8').replace('export function ', 'function '), c);
  const clock = frames(c);
  vm.runInContext(scheduler + section('// On-demand 3D rendering.', '// Project actions and keyboard navigation.') + section('let firstResize =', 'window.planner ='), c);
  c.renderPreview(); assert.equal(constructions, 0, 'Plan-only use creates no WebGL context');
  for (const label of ['SwiftShader', 'llvmpipe', 'softpipe', 'lavapipe', 'Microsoft Basic Render Driver', 'Apple Software Renderer']) {
    const profile = c.previewRenderProfile({getExtension: () => ({UNMASKED_RENDERER_WEBGL: 1}), getParameter: () => label});
    assert.equal(profile.pixels, 250000);
    assert.equal(profile.instanceCatalog, label === 'Apple Software Renderer', 'Only positively identified Apple software rendering batches catalog parts');
    assert.equal(profile.diffuseLighting, label === 'Apple Software Renderer');
  }
  for (const gl of [null, {getExtension: () => null}, {getExtension() { throw Error('blocked'); }},
    ...['Apple M1', 'Apple M1, or similar', 'Apple M2', 'Apple Software Renderer, or similar'].map(label =>
      ({getExtension: () => ({UNMASKED_RENDERER_WEBGL: 1}), getParameter: () => label}))]) {
    assert.equal(c.previewRenderProfile(gl).pixels, 2000000);
    assert.equal(c.previewRenderProfile(gl).shadowSize, 2048);
    assert.equal(c.previewRenderProfile(gl).instanceCatalog, false);
    assert.equal(c.previewRenderProfile(gl).diffuseLighting, false);
  }
  for (const [w, h] of [[800, 600], [3840, 2160], [7680, 4320]]) for (const budget of [250000, 2000000, 4000000]) {
    const r = c.canvasPixelRatio(w, h, budget); assert(w * h * r * r <= budget + .001); assert(r <= 2);
  }
  c.view = 'preview'; c.renderPreview();
  assert.equal(constructions, 1); assert.equal(draws, 1); assert.equal(shadows, 1);
  assert.equal(vm.runInContext('previewInstancing', c), false, 'SwiftShader retains ordinary catalog meshes');
  assert.equal(vm.runInContext('previewSun.shadow.mapSize.x', c), 512);
  assert.equal(vm.runInContext('previewSun.shadow.autoUpdate', c), false);
  const canvas = get('preview-canvas');
  canvas.events.pointerdown(event());
  for (let i = 1; i <= 100; i++) canvas.events.pointermove(event(i, i / 4));
  canvas.events.pointerup(event(100, 25));
  assert.equal(draws, 1, 'Orbit event bursts do not synchronously draw');
  assert.equal(clock.pending.size, 1); clock.flush();
  assert.equal(draws, 2); assert.equal(shadows, 1, 'Camera-only changes reuse sun shadows');
  assert.equal(buffers.length, 1, 'Orbit does not resize the drawing buffer');
  assert.equal(vm.runInContext('orbit.yaw', c), -Math.PI / 3 - .7);
  for (let i = 0; i < 100; i++) canvas.events.wheel({...event(), deltaY: 1});
  assert.equal(draws, 2); assert.equal(clock.pending.size, 1); clock.flush();
  assert.equal(draws, 3); assert.equal(clock.pending.size, 0, 'No idle loop');
  let geometryDisposals = 0;
  vm.runInContext('worldGroup', c).traverse(object => object.geometry?.addEventListener('dispose', () => geometryDisposals++));
  c.previewDirty = true; c.renderPreview();
  assert(geometryDisposals > 0); assert.equal(shadows, 2, 'Rebuilt geometry invalidates the cached shadow');
  assert.equal(constructions, 1, 'Rebuilds reuse the renderer');
  c.resizeCanvases(rect); clock.flush();
  assert(get('plan-canvas').width * get('plan-canvas').height <= 4000000);
  c.resizeCanvases({width: 600, height: 3000}); c.resizeCanvases({width: 3000, height: 600}); clock.flush();
  assert(bitmapAreas.every(area => area <= 4000000), 'Intermediate 2D bitmaps obey the budget during orientation changes');
  for (const [w, h, r] of buffers) assert(w * h * r * r <= 250000.001);
  const beforeHidden = draws;
  c.requestCanvasRender(); c.document.hidden = true; documentEvents.visibilitychange();
  rect = {width: 800, height: 600}; c.resizeCanvases(rect); c.renderPreview();
  assert.equal(draws, beforeHidden); assert.equal(clock.pending.size, 0);
  c.document.hidden = false; documentEvents.visibilitychange(); clock.flush();
  assert.equal(draws, beforeHidden + 1); assert.equal(buffers.at(-1)[0], 800);
  c.requestCanvasRender(); let prevented = false;
  canvas.events.webglcontextlost({preventDefault() { prevented = true; }});
  assert(prevented); assert.equal(clock.pending.size, 0);
  const beforeLost = draws; rect = {width: 600, height: 800}; c.resizeCanvases(rect); clock.flush();
  assert.equal(draws, beforeLost);
  c.view = 'plan'; c.requestCanvasRender(); clock.flush(); assert(planDraws > 0, '2D editing remains usable while WebGL is lost');
  c.view = 'preview'; canvas.events.webglcontextrestored(); clock.flush();
  assert.equal(draws, beforeLost + 1); assert.equal(buffers.at(-1)[0], 600); assert.equal(buffers.at(-1)[1], 800);
  assert.equal(get('preview-error').hidden, true); assert.equal(shadows, 3);
  assert.notEqual(get('preview-canvas'), canvas, 'Recovery replaces the native context canvas');
  assert.equal(Object.keys(canvas.events).length, 0, 'Retired canvas listeners are removed');
  windowEvents.pagehide({persisted: true}); assert.equal(disposals, 1); c.requestCanvasRender(); assert.equal(clock.pending.size, 0);
  windowEvents.pageshow(); clock.flush(); assert.equal(constructions, 2);
  windowEvents.pagehide({persisted: false}); assert.equal(disposals, 2); assert.equal(losses, 2); assert.equal(disconnects, 1);
  assert.equal(vm.runInContext('worldGroup.children.length', c), 0);

  // The fallback is a distinct material/filter choice, not an instancing alias.
  rendererName = 'Apple Software Renderer';
  vm.runInContext('renderer=null', c);
  c.initPreview();
  assert.equal(vm.runInContext('renderer.shadowMap.type', c), THREE.BasicShadowMap);
  assert.equal(vm.runInContext('previewDiffuseLighting', c), true);
  const translucent = {color: 0x2277bb, emissive: 0x010203, opacity: .3, transparent: true,
    depthWrite: false, side: THREE.DoubleSide, roughness: .8, metalness: .2};
  for (const diffuse of [true, false, true]) {
    vm.runInContext(`previewDiffuseLighting=${diffuse};previewInstancing=${!diffuse}`, c);
    const material = c.createPreviewMaterial(translucent);
    assert.equal(Boolean(material.isMeshLambertMaterial), diffuse);
    assert.equal(Boolean(material.isMeshStandardMaterial), !diffuse);
    assert.equal(material.color.getHex(), translucent.color);
    assert.equal(material.emissive.getHex(), translucent.emissive);
    for (const field of ['opacity','transparent','depthWrite','side']) assert.equal(material[field],translucent[field]);
    material.dispose();
  }
  c.disposePreviewRenderer();

  // Repeated catalog furniture shares immutable vertex data, while appearance
  // variants, materials and per-item transforms keep their existing behavior.
  const furniture = await import('../planner/furniture.js');
  const catalogProject = model.clone(project), catalogFloor = catalogProject.floors[0];
  const sofa = furniture.getCatalogModel('sofa_3'), rug = furniture.getCatalogModel('rug');
  catalogFloor.items = [sofa, sofa, sofa, rug, rug].map((design, i) => ({
    id: `catalog_${i}`, name: design.label, type: design.type, room: 'room',
    position_m: {x: i + 1, y: design.elevation_m, z: 2}, dimensions_m: {...design.dimensions_m},
    rotation_deg: i * 30, entity_id: '', notes: '', model_id: design.id, style_id: design.default_style,
    ...(i === 2 ? {color: '#c45328'} : {}), ...(i === 4 ? {pattern_id: 'checks'} : {}),
  }));
  catalogFloor.items[1].dimensions_m.width *= 1.5;
  const sharedWorld = new THREE.Group();
  const shared = vm.createContext({THREE, worldGroup: sharedWorld, previewSun: new THREE.DirectionalLight(),
    previewMetadata: {}, previewDirty: true, previewInstancing: false, previewDiffuseLighting: false, previewFloors: () => catalogProject.floors,
    assetCache: new Map(), APPEARANCE_CACHE_LIMIT: 100, buildFurnitureAsset: furniture.buildFurnitureAsset,
    distance: model.distance, wallPieces: model.wallPieces, floorBounds: model.floorBounds,
    COLORS: {floor: '#eeeeee', furniture: '#aaaaaa'},
  });
  vm.runInContext(section('function itemAsset(', 'function materialColor(') + section('function createPreviewMaterial(', 'function previewRenderProfile(') + section('function disposePreviewGeometry()', 'function drawPreview()'), shared);
  shared.rebuildPreview();
  const groups = sharedWorld.children.filter(object => object.isGroup);
  assert.equal(groups.length, catalogFloor.items.length);
  assert.equal(groups[0].children[0].geometry, groups[1].children[0].geometry, 'Repeated parts reuse one geometry even with different item dimensions');
  assert.notEqual(groups[0].children[0].material, groups[1].children[0].material, 'Materials retain their original identity and render sorting');
  assert.notEqual(groups[0].children[0].geometry, groups[2].children[0].geometry, 'Different cached appearances do not accidentally share mutable asset data');
  for (const [i, group] of groups.entries()) {
    const item = catalogFloor.items[i], asset = shared.itemAsset(item);
    assert.deepEqual(group.position.toArray(), [item.position_m.x, catalogFloor.elevation_m + item.position_m.y, item.position_m.z]);
    assert.deepEqual(group.scale.toArray(), [item.dimensions_m.width, item.dimensions_m.height, item.dimensions_m.depth]);
    assert.equal(group.rotation.y, item.rotation_deg * Math.PI / 180);
    assert.equal(group.children.length, asset.meshes.length, 'Every part remains a separate ordered mesh');
    for (const [j, mesh] of group.children.entries()) {
      const part = asset.meshes[j];
      assert.deepEqual(mesh.geometry.attributes.position.array, new Float32Array(part.vertices.flat()));
      assert.deepEqual(mesh.geometry.attributes.normal.array, new Float32Array(part.normals.flat()));
      assert.deepEqual(Array.from(mesh.geometry.index.array), part.indices);
      assert.deepEqual(mesh.material.color.toArray(), asset.materials[part.material].slice(0, 3));
      assert.equal(mesh.material.roughness, .78); assert(mesh.castShadow && mesh.receiveShadow);
    }
  }
  const oldGeometry = new Map(), oldMaterials = new Map();
  sharedWorld.traverse(object => {
    if (object.geometry && !oldGeometry.has(object.geometry)) { oldGeometry.set(object.geometry, 0); object.geometry.addEventListener('dispose', () => oldGeometry.set(object.geometry, oldGeometry.get(object.geometry) + 1)); }
    if (object.material && !oldMaterials.has(object.material)) { oldMaterials.set(object.material, 0); object.material.addEventListener('dispose', () => oldMaterials.set(object.material, oldMaterials.get(object.material) + 1)); }
  });
  shared.rebuildPreview();
  assert([...oldGeometry.values()].every(count => count === 1), 'Each shared geometry is disposed exactly once');
  assert([...oldMaterials.values()].every(count => count === 1), 'Every material is disposed exactly once');
  sharedWorld.traverse(object => { if (object.geometry) assert(!oldGeometry.has(object.geometry), 'A rebuild never reuses a disposed GPU resource'); });
  shared.disposePreviewGeometry(); assert.equal(sharedWorld.children.length, 0);

  // Software batching retains expanded geometry, colors and world transforms.
  // Intersecting items and transparent architecture keep their original order.
  const expandMeshes = world => {
    world.updateMatrixWorld(true); const records = [];
    world.traverse(mesh => {
      if (!mesh.isMesh) return;
      const shape = JSON.stringify([Array.from(mesh.geometry.attributes.position.array),
        Array.from(mesh.geometry.attributes.normal?.array || []), Array.from(mesh.geometry.index?.array || []),
        mesh.material.color.toArray(), mesh.material.roughness, mesh.material.transparent,
        mesh.material.opacity, mesh.castShadow, mesh.receiveShadow]);
      const count = mesh.isInstancedMesh ? mesh.count : 1;
      for (let i = 0; i < count; i++) {
        const matrix = new THREE.Matrix4();
        if (mesh.isInstancedMesh) { mesh.getMatrixAt(i, matrix); matrix.premultiply(mesh.matrixWorld); }
        else matrix.copy(mesh.matrixWorld);
        records.push({shape, matrix: matrix.toArray()});
      }
    });
    return records.sort((a, b) => (a.shape + JSON.stringify(a.matrix.map(x => Math.round(x * 1e4))))
      .localeCompare(b.shape + JSON.stringify(b.matrix.map(x => Math.round(x * 1e4)))));
  };
  catalogFloor.elevation_m = 3;
  catalogFloor.items.forEach((item, i) => { item.position_m.x = i * 5 + 2; item.position_m.z = 4; });
  shared.rebuildPreview(); const ordinaryRecords = expandMeshes(sharedWorld), ordinaryCount = shared.previewMetadata.meshes;
  shared.previewInstancing = true; shared.rebuildPreview();
  const instanceRecords = expandMeshes(sharedWorld), instanceMeshes = sharedWorld.children.filter(mesh => mesh.isInstancedMesh);
  assert(instanceMeshes.length > 0); assert(shared.previewMetadata.meshes < ordinaryCount);
  assert.equal(instanceRecords.length, ordinaryRecords.length, 'Batching retains every logical surface');
  assert.equal(shared.previewMetadata.itemMeshes, catalogFloor.items.reduce((n, item) => n + shared.itemAsset(item).meshes.length, 0));
  for (let i = 0; i < ordinaryRecords.length; i++) {
    assert.equal(instanceRecords[i].shape, ordinaryRecords[i].shape);
    instanceRecords[i].matrix.forEach((value, axis) => assert(Math.abs(value - ordinaryRecords[i].matrix[axis]) < 1e-6));
  }
  const disposedInstances = new Map();
  for (const mesh of instanceMeshes) {
    disposedInstances.set(mesh, 0); mesh.addEventListener('dispose', () => disposedInstances.set(mesh, disposedInstances.get(mesh) + 1));
    assert(mesh.boundingBox && mesh.boundingSphere, 'Bounds exist before the first render');
    for (let i = 0; i < mesh.count; i++) {
      const matrix = new THREE.Matrix4(); mesh.getMatrixAt(i, matrix);
      for (let j = 0; j < mesh.geometry.attributes.position.count; j++) {
        const point = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, j).applyMatrix4(matrix);
        assert(mesh.boundingBox.clone().expandByScalar(1e-6).containsPoint(point));
        assert(point.distanceTo(mesh.boundingSphere.center) <= mesh.boundingSphere.radius + 1e-6);
      }
    }
  }
  shared.rebuildPreview();
  assert([...disposedInstances.values()].every(count => count === 1), 'Every instance buffer receives its disposal event during rebuild');
  const newInstances = sharedWorld.children.filter(mesh => mesh.isInstancedMesh);
  assert(newInstances.every(mesh => !disposedInstances.has(mesh)), 'Instance objects never persist across rebuilds');
  shared.disposePreviewGeometry();

  // Coincident red/blue/red furniture must not change its visible winner.
  catalogFloor.items = [0, 1, 2, 3, 4].map((index) => ({...model.clone(catalogFloor.items[0]),
    id: `overlap_${index}`, color: index === 1 ? '#2266cc' : '#c45328',
    position_m: {x: index < 3 ? 2 : index * 5, y: 0, z: 4}}));
  shared.previewInstancing = false; shared.rebuildPreview();
  const orderedGroups = sharedWorld.children.filter(object => object.isGroup), overlapBefore = orderedGroups.slice(0, 3);
  const originalMaterials = overlapBefore.map(group => group.children.map(mesh => mesh.material));
  shared.instancePreviewCatalog(orderedGroups);
  assert(overlapBefore.every(group => group.parent === sharedWorld));
  overlapBefore.forEach((group, index) => assert.deepEqual(group.children.map(mesh => mesh.material), originalMaterials[index]));
  assert.deepEqual(sharedWorld.children.filter(object => overlapBefore.includes(object)), overlapBefore, 'Coincident appearances keep their exact draw order and materials');
  assert(sharedWorld.children.some(mesh => mesh.isInstancedMesh), 'Unrelated disjoint items still batch');
  shared.disposePreviewGeometry();

  shared.rebuildPreview();
  const architectureGroups = sharedWorld.children.filter(object => object.isGroup);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), new THREE.MeshStandardMaterial({transparent: true, opacity: .22}));
  glass.position.set(15, 3.5, 4); sharedWorld.add(glass);
  shared.instancePreviewCatalog(architectureGroups);
  assert.equal(glass.parent, sharedWorld); assert.equal(glass.material.opacity, .22);
  assert.equal(architectureGroups[3].parent, sharedWorld, 'Furniture intersecting a window keeps its ordinary rendering path');
  shared.disposePreviewGeometry();

  // A dense imported scene falls back before mutating even disjoint candidates.
  const denseGroups = [], denseGeometry = new THREE.BoxGeometry(), denseMaterial = new THREE.MeshStandardMaterial();
  for (let i = 0; i < 502; i++) {
    const group = new THREE.Group(); group.add(new THREE.Mesh(denseGeometry, denseMaterial));
    if (i < 2) group.position.x = 1000 + i * 3;
    denseGroups.push(group); sharedWorld.add(group);
  }
  shared.instancePreviewCatalog(denseGroups);
  assert.deepEqual(sharedWorld.children, denseGroups, 'The comparison budget falls back without partial batching');
  assert(denseGroups.every(group => group.children.length === 1));
  shared.disposePreviewGeometry();

  // Real pointer handlers: exact endpoint math, one clone per gesture, and undo/cancel.
  for (const kind of ['rooms', 'walls', 'items', 'openings']) {
    const original = model.clone(project), snapshot = JSON.stringify(original), plan = surface();
    let clones = 0, saves = 0, uiDraws = 0, inspectorDraws = 0, planDraws = 0, inspectorObject, paintedProject, paintedSelection;
    const history = [], buttons = ['rooms', 'walls', 'items', 'openings'].map(objectKind => ({
      dataset: {objectKind, objectId: original.floors[0][objectKind][0].id},
      attributes: {}, setAttribute(name, value) { this.attributes[name] = value; },
    }));
    const controls = {'object-list': {children: buttons}, undo: {disabled: true}, redo: {disabled: true}, 'pointer-position': {textContent: ''}};
    const p = vm.createContext({project: original, activeFloorId: f.id, selection: null, tool: 'select', view: 'plan', drag: null,
      planCanvas: plan, spaceHeld: false, previewDirty: false, map: {x: 0, y: 0},
      clone(value) { clones++; return model.clone(value); }, round: model.round, distance: model.distance,
      snap: value => value, localPoint: e => [e.clientX, e.clientY], toWorld: point => point,
      hitTest: () => ({kind, id: original.floors[0][kind][0].id}),
      floor: () => p.project.floors[0], selected: () => p.selection && p.project.floors[0][p.selection.kind].find(o => o.id === p.selection.id),
      $: id => controls[id], renderUI() { uiDraws++; p.renderInspector(); },
      renderInspector() { inspectorDraws++; inspectorObject = model.clone(p.selected()); },
      renderPlan() { p.cancelCanvasRender(); planDraws++; paintedProject = model.clone(p.project); paintedSelection = model.clone(p.selection); },
      renderPreview() {}, status() {}, save() { saves++; }, t: x => x,
      validateProject: model.validateProject, serializeProject: JSON.stringify, historyPush: value => history.push(value),
      document: {hidden: false}, zoomPlan() {}, history, future: [],
    });
    const gestureClock = frames(p); vm.runInContext(scheduler + section('function setSelection(', 'function field(') + section("planCanvas.addEventListener('pointerdown'", '// On-demand 3D rendering.'), p);
    plan.events.pointerdown(event(1, 1));
    assert.equal(uiDraws, 0, 'Selecting an existing object retains the floor and object list nodes');
    assert.equal(inspectorDraws, 1, 'A changed selection updates its inspector once');
    assert.deepEqual(buttons.map(b => b.attributes['aria-pressed']), buttons.map(b => String(b.dataset.objectKind === kind)), 'The retained list marks only the selected object');
    for (let i = 1; i <= 100; i++) plan.events.pointermove(event(1 + i / 100, 1));
    assert.equal(clones, 1, kind + ' clones the project only once per gesture');
    assert.equal(JSON.stringify(original), snapshot, 'Original snapshot is immutable during drag');
    const moved = p.project.floors[0][kind][0], base = original.floors[0][kind][0];
    if (kind === 'rooms') assert.equal(moved.polygon[0][0], base.polygon[0][0] + 1);
    if (kind === 'walls') assert.equal(moved.start[0], base.start[0] + 1);
    if (kind === 'items') assert.equal(moved.position_m.x, base.position_m.x + 1);
    if (kind === 'openings') assert.equal(moved.offset_m, base.offset_m + 1);
    assert.equal(gestureClock.pending.size, 1);
    plan.events.pointerup(event(2, 1)); assert.equal(saves, 1, kind + ' movement commits once'); assert.equal(history[0], original);
    assert.equal(uiDraws, 0, 'A move does not rebuild unchanged floor or object lists');
    assert.equal(inspectorDraws, 2); assert.deepEqual(inspectorObject, model.clone(p.selected()), 'The committed coordinates reach the inspector immediately');
    assert.equal(controls.undo.disabled, false); assert.equal(controls.redo.disabled, true);
    assert.equal(planDraws, 0, 'Pointerup preserves the queued final movement paint instead of drawing synchronously');
    assert.equal(gestureClock.pending.size, 1); gestureClock.flush();
    assert.deepEqual(paintedProject, model.clone(p.project), 'A movement paint queued across pointerup uses the committed project');
    assert.deepEqual(paintedSelection, model.clone(p.selection), 'The final paint keeps the selected outline');
    const drawsBeforeClick = planDraws, inspectorBeforeClick = inspectorDraws;
    plan.events.pointerdown(event(1, 1)); plan.events.pointerup(event(1, 1)); gestureClock.flush();
    assert.equal(planDraws, drawsBeforeClick, 'Clicking the current selection needs no new paint');
    assert.equal(inspectorDraws, inspectorBeforeClick, 'Clicking the current selection retains the inspector');
    p.setSelection(null); gestureClock.flush();
    assert(buttons.every(b => b.attributes['aria-pressed'] === 'false'), 'Clearing selection clears the retained list markers');
    assert.equal(inspectorObject, null); assert.equal(paintedSelection, null, 'Clearing selection removes its painted outline');
    p.setSelection({kind, id: original.floors[0][kind][0].id}); gestureClock.flush();
    const committed = p.project; plan.events.pointerdown(event(1, 1)); plan.events.pointermove(event(2, 1));
    plan.events.pointercancel(event(2, 1)); assert.equal(p.project, committed); assert.equal(saves, 1, 'Cancel does not save or add undo history');
    assert.equal(history.length, 1);
    assert.equal(gestureClock.pending.size, 0, 'Cancellation replaces a pending moved paint with the restored project');
    assert.deepEqual(paintedProject, model.clone(committed)); assert.deepEqual(inspectorObject, model.clone(p.selected()));
    plan.events.pointerdown(event(1, 1)); plan.events.pointermove(event(2, 1)); gestureClock.flush();
    assert.notDeepEqual(paintedProject, model.clone(committed), 'The cancel fixture has already displayed its moved geometry');
    plan.events.pointercancel(event(2, 1));
    assert.deepEqual(paintedProject, model.clone(committed), 'Cancellation also repaints after an intermediate movement was displayed');
    assert.deepEqual(paintedSelection, model.clone(p.selection)); assert.equal(saves, 1); assert.equal(history.length, 1);
    vm.runInContext(section('function undo(', 'function renderUI('), p);
    p.undo(); assert.equal(p.project, original, 'Undo restores the exact original snapshot');
    p.undo(true); assert.equal(p.project, committed, 'Redo restores the committed movement');
    if (kind !== 'openings') {
      const savedBeforeInvalid = saves;
      plan.events.pointerdown(event(1, 1)); plan.events.pointermove(event(301, 1)); plan.events.pointerup(event(301, 1));
      assert.equal(p.project, committed, 'Invalid movement rolls back without mutating the committed project');
      assert.equal(saves, savedBeforeInvalid);
      assert.deepEqual(paintedProject, model.clone(committed), 'Invalid movement paints the restored geometry');
      assert.deepEqual(inspectorObject, model.clone(p.selected()), 'Invalid movement retains the original inspector coordinates');
    }
    // Real snap spacing and separated animation frames: most pointer events in
    // a half-metre gesture stay in the same cell and must not repaint the floor.
    let snappedDraws = 0;
    p.snap = value => Math.round(value * 4) / 4;
    p.renderPlan = () => { p.cancelCanvasRender(); snappedDraws++; };
    p.renderPreview = () => { throw Error('A hidden preview must not rebuild during a 2D drag'); };
    p.previewDirty = false;
    const beforeSnapped = p.project, savesBeforeSnapped = saves, historyBeforeSnapped = history.length;
    plan.events.pointerdown(event(1, 1));
    gestureClock.flush();
    const drawsBeforeMoves = snappedDraws;
    for (let step = 1; step <= 12; step++) {
      plan.events.pointermove(event(1 + step / 24, 1));
      gestureClock.flush();
    }
    assert.equal(snappedDraws - drawsBeforeMoves, 2, kind + ' repaints only the two changed snap positions');
    plan.events.pointerup(event(1.5, 1));
    gestureClock.flush();
    assert.equal(snappedDraws - drawsBeforeMoves, 2, 'Pointerup does not redraw an already displayed endpoint');
    assert.equal(saves, savesBeforeSnapped + 1);
    assert.equal(history.length, historyBeforeSnapped + 1);
    assert.equal(history.at(-1), beforeSnapped, 'Snapped drag retains its exact undo snapshot');
    assert.equal(p.previewDirty, true, 'Committed 2D movement invalidates the next visible preview');
    const snapped = p.project.floors[0][kind][0], previous = beforeSnapped.floors[0][kind][0];
    if (kind === 'rooms') assert.equal(snapped.polygon[0][0], previous.polygon[0][0] + .5);
    if (kind === 'walls') assert.equal(snapped.start[0], previous.start[0] + .5);
    if (kind === 'items') assert.equal(snapped.position_m.x, previous.position_m.x + .5);
    if (kind === 'openings') assert.equal(snapped.offset_m, previous.offset_m + .5);
    p.snap = value => value;
    if (kind === 'items') {
      p.nextId = model.nextId; p.setTool = value => { p.tool = value; }; p.renderInspector = () => {};
      vm.runInContext(section('function transact(', 'function replaceProject('), p);
      for (const tool of ['wall', 'room']) {
        p.tool = tool; const collection = tool === 'wall' ? 'walls' : 'rooms';
        const count = p.project.floors[0][collection].length;
        plan.events.pointerdown(event(10, 10));
        plan.events.pointermove(event(11, 11)); plan.events.pointermove(event(12, 12));
        plan.events.pointerup(event(12, 12));
        const shape = p.project.floors[0][collection].at(-1);
        assert.equal(p.project.floors[0][collection].length, count + 1);
        assert.deepEqual(Array.from(tool === 'wall' ? shape.end : shape.polygon[2]), [12, 12],
          'Drawing commits the last pointer position even before its queued paint');
        p.tool = tool; const beforeCancel = p.project;
        plan.events.pointerdown(event(20, 20)); plan.events.pointermove(event(22, 22)); plan.events.pointercancel(event(22, 22));
        assert.equal(p.project, beforeCancel, 'Cancelling a new shape does not commit geometry');
      }
    }
  }
  console.log('PASS: Planner drag snapshots, exact movement/cancel, coalesced rendering, bounded buffers, cached shadows, context recovery and GPU teardown.');
})().catch(error => { console.error(error); process.exitCode = 1; });
