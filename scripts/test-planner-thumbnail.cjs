'use strict';
// Exercise the real thumbnail, inspector, and pointer handlers without a GPU.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'planner/editor.js'), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert(a >= 0 && b > a, 'Production section exists: ' + start);
  return source.slice(a, b);
}
const modules = Promise.all([
  import('../planner/model.js'), import('../planner/catalog.js'), import('../planner/furniture.js'),
  import('data:text/javascript;base64,' + fs.readFileSync(path.join(root, 'vendor/three.module.min.js')).toString('base64')),
]);
async function fixture(failure = null) {
  const [model, {CATALOG}, furniture, THREE] = await modules;
  const project = model.blankProject(), floor = project.floors[0];
  const design = furniture.getCatalogModel('sofa_3');
  floor.rooms.push({id: 'room', name: 'Room', polygon: [[0,0],[8,0],[8,6],[0,6]], material: 'floor'});
  floor.items.push({id: 'sofa', name: 'Test sofa', type: design.type, model_id: design.id, style_id: design.default_style,
    room: 'room', position_m: {x: 1, y: design.elevation_m, z: 1}, dimensions_m: design.dimensions_m,
    rotation_deg: 0, entity_id: '', notes: ''});
  const state = {failure, reads: 0, writes: 0, canvases: [], saves: 0, paints: 0};
  const fail = operation => {
    if (state.failure === operation) throw new DOMException('Synthetic unavailable 2D backing store', 'InvalidStateError');
    if (state.failure === operation + '-unexpected') throw new Error('Synthetic programming error');
  };
  function node(tag = 'div', className = '', textContent = '') {
    const element = {tag, className, textContent, hidden: false, children: [], dataset: {}, style: {setProperty() {}}, attributes: {}, events: {},
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      get childNodes() { return this.children; },
      querySelector(selector) { return this.children.find(child => selector === '.' + child.className)
        || this.children.map(child => child.querySelector?.(selector)).find(Boolean) || null; },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, handler) { this.events[name] = handler; }, focus() {},
    };
    if (tag === 'canvas') {
      const context = {clearRect() {}, beginPath() {}, ellipse() {}, fill() {},
        getImageData(_x, _y, width, height) { state.reads++; fail('read'); return {data: new Uint8ClampedArray(width * height * 4)}; },
        putImageData(pixels) { state.writes++; fail('write'); state.lastPixels = Uint8ClampedArray.from(pixels.data); },
      };
      element.getContext = () => state.failure === 'context' ? null : context;
      state.canvases.push(element);
    }
    return element;
  }
  const plan = node('canvas'), captures = new Set(), controls = new Map();
  plan.setPointerCapture = id => captures.add(id);
  plan.hasPointerCapture = id => captures.has(id);
  plan.releasePointerCapture = id => { if (captures.delete(id)) plan.events.lostpointercapture?.({pointerId: id}); };
  const get = id => { if (!controls.has(id)) controls.set(id, node()); return controls.get(id); };
  get('inspector-body').append(node('p', 'old-floor-fields'));
  const objectButton = node(); objectButton.dataset = {objectKind: 'items', objectId: 'sofa'};
  get('object-list').append(objectButton);
  function field(parent, label, value) { const input = node('input'); input.value = value; input.label = label; parent.append(input); return input; }
  const p = vm.createContext({THREE, CATALOG, ...furniture, project, activeFloorId: floor.id,
    ...model, node, field, row: parent => { const row = node(); parent.append(row); return row; },
    section: (parent, title) => parent.append(node('h3', '', title)), button: label => node('button', '', label),
    $: get, t: value => value, customItem: () => null, haCatalog: null, haContext: null, haSourcePolicy: null,
    inspectorScope: '', connectedRoomMove: null, selection: null, view: 'plan', tool: 'select', drag: null, previewEdit: null,
    planCanvas: plan, spaceHeld: false, map: {x: 0, y: 0}, orbit: {pointers: new Map()},
    previewDirty: false, history: [], future: [], LABELS: {},
    itemAsset: appearance => furniture.buildFurnitureAsset(appearance), thumbnailCache: new Map(), THUMBNAIL_CACHE_LIMIT: 48,
    floor: () => p.project.floors[0], selected: () => p.selection && p.project.floors[0].items.find(item => item.id === p.selection.id),
    snap: value => value, localPoint: event => [event.clientX / 100, event.clientY / 100], toWorld: value => value,
    roomHandleAt: () => -1, hitTest: () => ({kind: 'items', id: 'sofa'}),
    reconcileInspector: (parent, next) => parent.replaceChildren(...next.childNodes),
    renderUI() {}, renderPlan() { p.cancelCanvasRender(); state.paints++; }, renderPreview() {},
    updateFloorNavigator() {}, deleteSelection() {}, status() {}, save() { state.saves++; }, serializeProject: JSON.stringify,
    historyPush: value => p.history.push(value), document: {hidden: false}, window: {devicePixelRatio: 1}, zoomPlan() {},
  });
  const frames = new Map(); let serial = 0;
  p.requestAnimationFrame = callback => { frames.set(++serial, callback); return serial; };
  p.cancelAnimationFrame = id => frames.delete(id);
  vm.runInContext(section('let canvasFrame =', 'let startupMessage =')
    + section('const protectedRoom =', 'const snap =')
    + section('function itemDragStart(', 'function applyRoomDrag(')
    + section('function drawItemThumbnail(', 'function itemPlanShapes(')
    + section('function undo(', 'function renderUI(')
    + section('function setSelection(', 'function field(')
    + section('function renderInspector(', 'function deleteSelection(')
    + section("planCanvas.addEventListener('pointerdown'", '// On-demand 3D rendering.'), p);
  const pointer = (x, y) => ({clientX: x * 100, clientY: y * 100, pointerId: 1, button: 0, preventDefault() {}});
  return {p, state, get, plan, captures, pointer, design,
    flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); }};
}

for (const failure of ['read', 'write', 'context']) test(`Unavailable thumbnail ${failure} preserves exact drag and undo`, async () => {
  const f = await fixture(failure), original = JSON.stringify(f.p.project);
  assert.doesNotThrow(() => f.plan.events.pointerdown(f.pointer(1, 1)));
  assert.equal(f.p.selection.id, 'sofa');
  assert.equal(f.get('inspector-title').textContent, 'Item details');
  assert.equal(f.get('inspector-body').querySelector('.old-floor-fields'), null, 'The real inspector commits its new fields');
  assert.equal(f.state.canvases.at(-1).hidden, true, 'An unavailable optional preview is hidden');
  f.plan.events.pointermove(f.pointer(1.5, 1)); f.plan.events.pointerup(f.pointer(1.5, 1)); f.flush();
  assert.equal(f.p.project.floors[0].items[0].position_m.x, 1.5);
  assert.equal(f.p.history.length, 1); assert.equal(f.state.saves, 1); assert.equal(f.captures.size, 0);
  assert.equal(f.state.paints, 1, 'The committed edit still reaches the plan renderer');
  f.p.undo(); assert.equal(JSON.stringify(f.p.project), original); assert.equal(f.p.future.length, 1);
  f.p.undo(true); assert.equal(f.p.project.floors[0].items[0].position_m.x, 1.5);
});

test('A later ordinary thumbnail draw recovers and cached writes are protected', async () => {
  const f = await fixture('read'), canvas = f.state.canvases[0]; canvas.width = 280; canvas.height = 170;
  f.p.drawItemThumbnail(canvas, f.design); assert.equal(canvas.hidden, true);
  f.state.failure = null; f.p.drawItemThumbnail(canvas, f.design); assert.equal(canvas.hidden, false);
  const reads = f.state.reads; f.state.failure = 'write';
  assert.doesNotThrow(() => f.p.drawItemThumbnail(canvas, f.design));
  assert.equal(f.state.reads, reads, 'This failure uses the cached pixel path'); assert.equal(canvas.hidden, true);
});

test('Unexpected thumbnail errors remain visible', async () => {
  const f = await fixture('read-unexpected');
  assert.throws(() => f.plan.events.pointerdown(f.pointer(1, 1)), /Synthetic programming error/);
});

test('A normal catalog thumbnail paints visible geometry and reuses identical cached pixels', async () => {
  const f = await fixture();
  f.plan.events.pointerdown(f.pointer(1, 1));
  const pixels = f.state.lastPixels, colors = new Set(); let opaquePixels = 0;
  assert.equal(pixels.length, 280 * 170 * 4);
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3]) {
    opaquePixels++; colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
  }
  assert(opaquePixels > 1000, 'The real catalog mesh paints a substantial visible silhouette');
  assert(colors.size > 2, 'Furniture materials and face shading remain visible');
  assert.equal(f.state.canvases.at(-1).hidden, false);
  const reads = f.state.reads;
  f.p.drawItemThumbnail(f.state.canvases.at(-1), f.design, f.p.selected());
  assert.equal(f.state.reads, reads); assert.deepEqual(f.state.lastPixels, pixels);
});
