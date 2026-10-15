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
    addEventListener(name, fn) { this.events[name] = fn; },
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
  const THREE = await import('data:text/javascript;base64,' + fs.readFileSync(path.join(root, 'vendor/three.module.min.js')).toString('base64'));
  const model = await import('../planner/model.js');
  const project = model.blankProject(), f = project.floors[0];
  f.rooms.push({id: 'room', name: 'Room', polygon: [[0, 0], [8, 0], [8, 6], [0, 6]], material: 'floor'});
  f.walls.push({id: 'wall', start: [0, 0], end: [8, 0], thickness_m: .15});
  f.openings.push({id: 'door', wall_id: 'wall', type: 'door', offset_m: 1, width_m: .9, sill_m: 0, head_m: 2});
  f.items.push({id: 'item', name: 'Item', type: 'furniture', room: 'room', position_m: {x: 2, y: 0, z: 2}, dimensions_m: {width: 1, depth: 1, height: 1}, rotation_deg: 0, entity_id: '', notes: ''});
  model.validateProject(project);
  const elements = new Map(), get = id => { if (!elements.has(id)) elements.set(id, surface()); return elements.get(id); };
  const documentEvents = {}, windowEvents = {}, buffers = [];
  let constructions = 0, draws = 0, shadows = 0, disposals = 0, losses = 0, disconnects = 0, planDraws = 0;
  let rect = {width: 3840, height: 2160};
  class Renderer {
    constructor() { constructions++; this.shadowMap = {}; }
    getContext() { return {getExtension: () => ({UNMASKED_RENDERER_WEBGL: 1}), getParameter: () => 'ANGLE SwiftShader'}; }
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
  const c = vm.createContext({THREE: {...THREE, WebGLRenderer: Renderer}, project, floor: () => project.floors[0],
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
  const clock = frames(c);
  vm.runInContext(scheduler + section('// On-demand 3D rendering.', '// Project actions and keyboard navigation.') + section('let firstResize =', 'window.planner ='), c);
  c.renderPreview(); assert.equal(constructions, 0, 'Plan-only use creates no WebGL context');
  for (const label of ['SwiftShader', 'llvmpipe', 'softpipe', 'lavapipe', 'Microsoft Basic Render Driver', 'Apple Software Renderer']) {
    assert.equal(c.previewRenderProfile({getExtension: () => ({UNMASKED_RENDERER_WEBGL: 1}), getParameter: () => label}).pixels, 250000);
  }
  for (const gl of [null, {getExtension: () => null}, {getExtension() { throw Error('blocked'); }},
    ...['Apple M1', 'Apple M1, or similar', 'Apple M2', 'Apple Software Renderer, or similar'].map(label =>
      ({getExtension: () => ({UNMASKED_RENDERER_WEBGL: 1}), getParameter: () => label}))]) {
    assert.equal(c.previewRenderProfile(gl).pixels, 2000000);
    assert.equal(c.previewRenderProfile(gl).shadowSize, 2048);
  }
  for (const [w, h] of [[800, 600], [3840, 2160], [7680, 4320]]) for (const budget of [250000, 2000000, 4000000]) {
    const r = c.canvasPixelRatio(w, h, budget); assert(w * h * r * r <= budget + .001); assert(r <= 2);
  }
  c.view = 'preview'; c.renderPreview();
  assert.equal(constructions, 1); assert.equal(draws, 1); assert.equal(shadows, 1);
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
  windowEvents.pagehide({persisted: true}); assert.equal(disposals, 0); c.requestCanvasRender(); assert.equal(clock.pending.size, 0);
  windowEvents.pageshow(); clock.flush(); assert.equal(constructions, 1);
  windowEvents.pagehide({persisted: false}); assert.equal(disposals, 1); assert.equal(losses, 1); assert.equal(disconnects, 1);
  assert.equal(vm.runInContext('worldGroup.children.length', c), 0);

  // Real pointer handlers: exact endpoint math, one clone per gesture, and undo/cancel.
  for (const kind of ['rooms', 'walls', 'items', 'openings']) {
    const original = model.clone(project), snapshot = JSON.stringify(original), plan = surface();
    let clones = 0, saves = 0; const history = [];
    const p = vm.createContext({project: original, activeFloorId: f.id, selection: null, tool: 'select', view: 'plan', drag: null,
      planCanvas: plan, spaceHeld: false, previewDirty: false, map: {x: 0, y: 0},
      clone(value) { clones++; return model.clone(value); }, round: model.round, distance: model.distance,
      snap: value => value, localPoint: e => [e.clientX, e.clientY], toWorld: point => point,
      hitTest: () => ({kind, id: original.floors[0][kind][0].id}),
      floor: () => p.project.floors[0], selected: () => p.project.floors[0][p.selection.kind].find(o => o.id === p.selection.id),
      $: () => ({textContent: ''}), renderUI() {}, renderPlan() { p.cancelCanvasRender(); },
      renderPreview() {}, status() {}, save() { saves++; }, t: x => x,
      validateProject: model.validateProject, serializeProject: JSON.stringify, historyPush: value => history.push(value),
      document: {hidden: false}, zoomPlan() {}, history, future: [],
    });
    const gestureClock = frames(p); vm.runInContext(scheduler + section("planCanvas.addEventListener('pointerdown'", '// On-demand 3D rendering.'), p);
    plan.events.pointerdown(event(1, 1));
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
    const committed = p.project; plan.events.pointerdown(event(1, 1)); plan.events.pointermove(event(2, 1));
    plan.events.pointercancel(event(2, 1)); assert.equal(p.project, committed); assert.equal(saves, 1, 'Cancel does not save or add undo history');
    assert.equal(history.length, 1);
    vm.runInContext(section('function undo(', 'function renderUI('), p);
    p.undo(); assert.equal(p.project, original, 'Undo restores the exact original snapshot');
    p.undo(true); assert.equal(p.project, committed, 'Redo restores the committed movement');
    if (kind !== 'openings') {
      const savedBeforeInvalid = saves;
      plan.events.pointerdown(event(1, 1)); plan.events.pointermove(event(301, 1)); plan.events.pointerup(event(301, 1));
      assert.equal(p.project, committed, 'Invalid movement rolls back without mutating the committed project');
      assert.equal(saves, savedBeforeInvalid);
    }
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
