import './language-links.js';
import { addMeasuredRoom, installOnboarding } from './onboarding.js';
import { createDraftStorage, DRAFT_KEY, PREVIOUS_KEY, DAMAGED_KEY } from './draft-storage.js';
import { reconcileInspector } from './inspector-dom.js';
import { createFloorNavigator } from './floor-navigator.js';
import { getRenderCapacity } from './render-capacity.js';
import { formatValidationError } from './validation.js';
import { t, LOCALES, initI18n, setLocale, getLocale, onLocaleChange, translateStatic } from './i18n.js';

import * as THREE from '../vendor/three.module.min.js';
import { LIMITS, ITEM_TYPES, clone, round, distance, signedArea, pointInPolygon, projectOnWall, nextId, newFloor, blankProject, outlineRoom, validateProject, wallPieces, floorBounds } from './model.js';
import { CATALOG } from './catalog.js';
import { getCatalogModel, getCatalogStyle, buildFurnitureAsset, PATTERNS, supportsFurniturePattern } from './furniture.js';

const initialLocale = await initI18n();
const $ = id => document.getElementById(id);
const draftStorage = createDraftStorage({ validate: validateProject, maxBytes: LIMITS.bytes });
let recoverySnapshot = null, recoveryBusy = false, saveSequence = 0, pendingSaves = 0;
let committingField = null, inspectorScope = '';
const BUILD_COMMAND = 'python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package';
const LABELS = { furniture: 'Furniture', lamp: 'Lamp', chandelier: 'Ceiling light', tv: 'TV / display', appliance: 'Appliance', switch: 'Switch', outlet: 'Outlet', sensor: 'Sensor' };
const COLORS = { floor: '#e7dac2', tile: '#e0e8df', deck: '#d8dfbe', furniture: '#96aca6', lamp: '#d9ae68', chandelier: '#d9ae68', tv: '#677d89', appliance: '#a1abb0', switch: '#b4c39d', outlet: '#b4c39d', sensor: '#c4b09a' };
const HINTS = { select: 'Drag a shape to move, or empty space to pan.', room: 'Drag a rectangle to create a room. Add walls separately.', wall: 'Drag from one wall endpoint to the other.', door: 'Click a wall to cut a door opening.', window: 'Click a wall to cut a window opening.', item: 'Click to place your item. Refine its position in the inspector.' };
const planCanvas = $('plan-canvas'), ctx = planCanvas.getContext('2d', { alpha: false });
let project = blankProject(), activeFloorId, selection = null, tool = 'select', view = 'plan', history = [], future = [], drag = null;
let map = { scale: 55, x: 80, y: 80 }, size = { width: 800, height: 600 }, spaceHeld = false, saveFailed = false, previewDirty = true;
let canvasFrame = 0, canvasSuspended = false;
// Optional integrations render a detached candidate; project/history/storage always
// retain the accepted document. The ordinary editor imports no AI code.
let candidatePreview = null, editorRevision = 0;
const editorListeners = new Set();
function editorChanged() {
  candidatePreview = null; editorRevision++; previewDirty = true;
  for (const listener of editorListeners) listener(editorRevision);
}
const displayedProject = () => candidatePreview || project;
const displayedFloor = () => displayedProject().floors.find(f => f.id === activeFloorId) || displayedProject().floors[0];
function cancelCanvasRender() { if (canvasFrame) cancelAnimationFrame(canvasFrame); canvasFrame = 0; }
function requestCanvasRender() {
  if (canvasFrame || canvasSuspended || document.hidden) return;
  canvasFrame = requestAnimationFrame(() => { canvasFrame = 0; if (view === 'preview') renderPreview(); else renderPlan(); });
}
function canvasPixelRatio(width, height, pixels) {
  return Math.min(Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1, 2, Math.sqrt(pixels / Math.max(1, width * height)));
}
let startupMessage = '';
let lastStatus = null;
let buildValidationText = null;
let placementModelId = CATALOG.models[0].id;
const assetCache = new Map(), planShapeCache = new Map(), thumbnailCache = new Map();
const planPathCache = new WeakMap();
const LIBRARY_PAGE_SIZE = 24, THUMBNAIL_CACHE_LIMIT = 32;
let libraryShown = 0;
// Keep a fully populated floor plus catalog thumbnails without clearing every
// entry during a redraw; evict only the oldest appearance when the bound is hit.
const APPEARANCE_CACHE_LIMIT = LIMITS.items + THUMBNAIL_CACHE_LIMIT;
const restoredDraft = draftStorage.read();
if (restoredDraft.current) { project = restoredDraft.current; startupMessage = () => t('Restored your local draft.'); }
else if (restoredDraft.error) {
  startupMessage = () => t('Could not restore local draft: {error} A blank project is open.', { error: formatValidationError(restoredDraft.error, t) });
  saveFailed = true;
}
activeFloorId = project.floors[0].id;
const floor = () => project.floors.find(f => f.id === activeFloorId) || project.floors[0];
const floorNavigator = createFloorNavigator({ container: $('floor-navigator'), onSelect: selectFloor, t });
function selectFloor(id) {
  if (!project.floors.some(f => f.id === id)) return;
  finishPointer(null, true); releasePreviewPointer();
  activeFloorId = id; selection = null; previewDirty = true;
  editorChanged(); fitPlan(); fitPreview(); renderUI(); renderPlan();
}
function updateFloorNavigator() {
  floorNavigator.update(project, activeFloorId);
  const hidden = $('floor-navigator').hidden;
  $('floor-navigator-toggle').setAttribute('aria-expanded', String(!hidden));
  const key = hidden ? 'Show floor previews' : 'Hide floor previews';
  $('floor-navigator-toggle').title = t(key);
  $('floor-navigator-toggle').dataset.i18nAttrs = JSON.stringify({ title: key });
}
$('floor-navigator-toggle').addEventListener('click', () => {
  $('floor-navigator').hidden = !$('floor-navigator').hidden;
  updateFloorNavigator();
});
const selected = () => selection ? floor()[selection.kind]?.find(o => o.id === selection.id) : null;
const snap = value => $('snap').checked ? Math.round(value * 4) / 4 : round(value);
function node(tag, className, text) { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; }
function button(text, handler, className = 'quiet') { const b = node('button', className, text); b.type = 'button'; b.onclick = handler; b.dataset.inspectorKey = `button:${text}`; return b; }
function status(message, error = false) {
  lastStatus = { message, error };
  const text = typeof message === 'function' ? message() : message;
  $('status').textContent = text; $('status').parentElement.classList.toggle('error', error); $('status').title = text;
}
function translatedText(id, key) { const element = $(id); element.dataset.i18n = key; element.textContent = t(key); }
function itemAsset(item) {
  if (!item.model_id) return null;
  const key = `${item.model_id}|${item.style_id || ''}|${item.color || ''}|${item.pattern_id || ''}|${item.pattern_color || ''}`;
  if (!assetCache.has(key)) {
    if (assetCache.size >= APPEARANCE_CACHE_LIMIT) assetCache.delete(assetCache.keys().next().value);
    assetCache.set(key, buildFurnitureAsset(item));
  }
  return assetCache.get(key);
}
function materialColor(material, shade = 1) { return new THREE.Color(...material.slice(0, 3)).multiplyScalar(shade).getStyle(); }
function placementName() { return placementModelId ? t(`model.${placementModelId}`) : t(LABELS[$('place-type').value]); }
function toolHint() { return tool === 'item' ? t('Click inside a room to place: {item}. V returns to Select / move.', { item: placementName() }) : t(HINTS[tool]); }
function updatePlacement() {
  $('placement-summary').textContent = t('Ready to place: {item}', { item: placementName() });
  $('browse-items').title = t('Open item library. Ready to place: {item}', { item: placementName() });
  if (view === 'plan') $('tool-hint').textContent = toolHint();
}
function modelDimensions(model, ceiling, elevation = model.elevation_m) {
  const dimensions = { ...model.dimensions_m, height: round(Math.min(model.dimensions_m.height, ceiling)) };
  return { dimensions, elevation: round(Math.max(0, Math.min(elevation, ceiling - dimensions.height))) };
}
function openLibrary() { renderLibrary(); $('library-dialog').showModal(); (window.matchMedia('(min-width: 521px)').matches ? $('library-search') : $('library-title')).focus(); }
function renderLibrary(append = false) {
  const query = $('library-search').value.trim().toLocaleLowerCase(), category = $('library-category').value;
  const words = query.split(/\s+/).filter(Boolean);
  const models = CATALOG.models.filter(model => {
    const categoryName = t(`category.${model.category}`);
    const text = `${t(`model.${model.id}`)} ${model.label} ${categoryName} ${model.id.replaceAll('_', ' ')} ${model.tags?.join(' ') || ''}`.toLocaleLowerCase();
    return (!category || model.category === category) && words.every(word => text.includes(word));
  });
  if (!append) { $('library-items').replaceChildren(); libraryShown = 0; }
  const nextPage = models.slice(libraryShown, libraryShown + LIBRARY_PAGE_SIZE);
  let firstNewCard;
  for (const model of nextPage) {
    const card = button('', () => {
      placementModelId = model.id; $('place-type').value = ''; updatePlacement();
      $('library-dialog').close(); setTool('item'); renderInspector(); planCanvas.focus();
      status(() => t('{item} selected. Click inside a room, or select a room and choose Place item at room center.', { item: t(`model.${model.id}`) }));
    }, 'library-card');
    card.dataset.modelId = model.id;
    firstNewCard ||= card;
    card.setAttribute('aria-label', t('Choose {item}', { item: t(`model.${model.id}`) }));
    card.setAttribute('aria-pressed', String(placementModelId === model.id));
    const canvas = node('canvas', 'item-thumbnail'); canvas.width = 280; canvas.height = 170; canvas.setAttribute('aria-hidden', 'true');
    const d = model.dimensions_m;
    card.append(canvas, node('strong', '', t(`model.${model.id}`)), node('span', 'item-size', `${d.width} × ${d.depth} × ${d.height} m`), node('span', 'item-card-action', placementModelId === model.id ? t('Ready to place') : t('Choose item')));
    $('library-items').append(card); drawItemThumbnail(canvas, model);
  }
  libraryShown += nextPage.length;
  $('library-count').textContent = category ? t('Showing {shown} of {total} designs in {category}', { shown: libraryShown, total: models.length, category: t(`category.${category}`) }) : t('Showing {shown} of {total} designs', { shown: libraryShown, total: models.length });
  $('library-more').hidden = libraryShown >= models.length;
  $('library-more').textContent = t('Show {count} more', { count: Math.min(LIBRARY_PAGE_SIZE, models.length - libraryShown) });
  $('library-empty').hidden = models.length > 0;
  if (append) firstNewCard?.focus();
}
function drawItemThumbnail(canvas, model, appearance = { model_id: model.id, style_id: model.default_style, type: model.type }) {
  const context = canvas.getContext('2d');
  const key = JSON.stringify([appearance.model_id, appearance.style_id, appearance.color, appearance.pattern_id, appearance.pattern_color]);
  if (thumbnailCache.has(key)) { context.putImageData(thumbnailCache.get(key), 0, 0); return; }
  const asset = itemAsset(appearance);
  if (!asset) return;
  const d = model.dimensions_m, triangles = [];
  for (const mesh of asset.meshes) {
    const vertices = mesh.vertices.map(([x, y, z]) => [x * d.width, y * d.height, z * d.depth]);
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const ids = mesh.indices.slice(i, i + 3), points = ids.map(index => vertices[index]);
      const normal = mesh.normals[ids[0]];
      if (normal[0] / d.width + normal[1] * (.68 / .88) / d.height + normal[2] / d.depth <= 0) continue;
      const shade = .72 + Math.max(0, normal[1]) * .25 + Math.max(0, normal[0]) * .08;
      const color = new THREE.Color(...asset.materials[mesh.material].slice(0, 3)).multiplyScalar(shade).convertLinearToSRGB();
      triangles.push({ points: points.map(([x, y, z]) => [(x - z) * .75, (x + z) * .34 - y * .88, (x + z) * .88 + y * .68]), color: [color.r, color.g, color.b].map(value => Math.round(Math.min(1, value) * 255)) });
    }
  }
  const points = triangles.flatMap(triangle => triangle.points), minX = Math.min(...points.map(p => p[0])), maxX = Math.max(...points.map(p => p[0])), minY = Math.min(...points.map(p => p[1])), maxY = Math.max(...points.map(p => p[1]));
  const scale = Math.min((canvas.width - 50) / Math.max(.01, maxX - minX), (canvas.height - 35) / Math.max(.01, maxY - minY));
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#e6eade'; context.beginPath(); context.ellipse(canvas.width / 2, canvas.height - 16, Math.min(85, (maxX - minX) * scale / 2), 7, 0, 0, Math.PI * 2); context.fill();
  // A small depth buffer keeps overlapping legs, arms, and cushions correct,
  // including in browsers without WebGL. No image downloads are needed.
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height), depths = new Float32Array(canvas.width * canvas.height).fill(-Infinity);
  for (const triangle of triangles) {
    const [a, b, c] = triangle.points.map(([x, y, depth]) => [canvas.width / 2 + (x - (minX + maxX) / 2) * scale, canvas.height / 2 - 3 + (y - (minY + maxY) / 2) * scale, depth]);
    const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(denominator) < 1e-8) continue;
    const left = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), right = Math.min(canvas.width - 1, Math.ceil(Math.max(a[0], b[0], c[0]))), top = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), bottom = Math.min(canvas.height - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
      const u = ((b[1] - c[1]) * (x + .5 - c[0]) + (c[0] - b[0]) * (y + .5 - c[1])) / denominator;
      const v = ((c[1] - a[1]) * (x + .5 - c[0]) + (a[0] - c[0]) * (y + .5 - c[1])) / denominator, w = 1 - u - v;
      if (u < -1e-8 || v < -1e-8 || w < -1e-8) continue;
      const depth = u * a[2] + v * b[2] + w * c[2], index = y * canvas.width + x;
      if (depth < depths[index]) continue;
      depths[index] = depth; const offset = index * 4;
      pixels.data[offset] = triangle.color[0]; pixels.data[offset + 1] = triangle.color[1]; pixels.data[offset + 2] = triangle.color[2]; pixels.data[offset + 3] = 255;
    }
  }
  if (thumbnailCache.size >= THUMBNAIL_CACHE_LIMIT) thumbnailCache.delete(thumbnailCache.keys().next().value);
  thumbnailCache.set(key, pixels); context.putImageData(pixels, 0, 0);
}
function itemPlanShapes(item) {
  const key = `${item.model_id}|${item.style_id || ''}|${item.color || ''}|${item.pattern_id || ''}|${item.pattern_color || ''}`;
  if (planShapeCache.has(key)) return planShapeCache.get(key);
  const asset = itemAsset(item);
  if (!asset) return null;
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const patterned = item.pattern_id && item.pattern_id !== 'none';
  const shapes = asset.meshes.flatMap(mesh => {
    if (patterned) {
      const triangles = [];
      for (let i = 0; i < mesh.indices.length; i += 3) {
        const indices = mesh.indices.slice(i, i + 3);
        if (mesh.normals[indices[0]][1] <= .01) continue;
        const vertices = indices.map(index => mesh.vertices[index]);
        triangles.push({ triangle: true, points: vertices.map(([x, _y, z]) => [x, z]), height: vertices.reduce((sum, p) => sum + p[1], 0) / 3, color: materialColor(asset.materials[mesh.material]) });
      }
      return triangles;
    }
    const points = [...new Map(mesh.vertices.map(([x, _y, z]) => [`${x},${z}`, [x, z]])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const lower = [], upper = [];
    for (const point of points) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop(); lower.push(point); }
    for (const point of [...points].reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop(); upper.push(point); }
    return { points: lower.slice(0, -1).concat(upper.slice(0, -1)), height: Math.max(...mesh.vertices.map(p => p[1])), color: materialColor(asset.materials[mesh.material]) };
  }).sort((a, b) => a.height - b.height);
  if (planShapeCache.size >= APPEARANCE_CACHE_LIMIT) planShapeCache.delete(planShapeCache.keys().next().value);
  planShapeCache.set(key, shapes); return shapes;
}
// Use identical compact UTF-8 bytes for storage, downloads, and the import limit.
// Check before committing an edit; storage quota failures must still allow export.
function serializeProject(value) {
  const serialized = JSON.stringify(value);
  if (new Blob([serialized]).size > LIMITS.bytes) throw new Error(t('Project would exceed the 2 MB limit (2,000,000 UTF-8 bytes). Shorten notes or remove items before adding more.'));
  return serialized;
}
function showDraftProblem(result) {
  saveFailed = true;
  translatedText('save-status', result.status === 'unavailable' ? 'Autosave unavailable · export a backup' : 'Autosave paused · review drafts');
  $('save-status').classList.add('problem');
  if (result.error) status(() => t('Autosave failed: {error}. Export JSON to keep your work.', { error: t(formatValidationError(result.error, t)) }), true);
  else status(() => t(result.status === 'unavailable' ? 'Autosave unavailable · export a backup' : result.status === 'unreadable' ? 'The saved draft could not be opened. Its original data is kept for recovery.' : 'Another tab changed the saved draft. Export your version or choose which draft to keep.'), true);
}
async function save(options) {
  const sequence = ++saveSequence;
  pendingSaves++;
  if (!saveFailed) translatedText('save-status', 'Local draft · export to keep a copy');
  let result;
  try { const { raw = serializeProject(project), ...writeOptions } = options || {}; result = await draftStorage.save(raw, writeOptions); }
  catch (error) { result = { status: 'unavailable', error }; }
  finally { pendingSaves--; }
  if (sequence !== saveSequence || result.status === 'cancelled') return result;
  if (result.status === 'saved') {
    saveFailed = false; translatedText('save-status', 'Saved in this browser'); $('save-status').classList.remove('problem');
  } else showDraftProblem(result);
  if ($('recovery-dialog').open) renderRecovery();
  return result;
}
function historyPush(previous) { history.push(previous); if (history.length > 60) history.shift(); future = []; }
function transact(change, message = () => t('Project updated.'), { fit = false } = {}) {
  const draft = clone(project), priorSelection = selection && { ...selection };
  try {
    change(draft, draft.floors.find(f => f.id === activeFloorId) || draft.floors[0]); validateProject(draft); serializeProject(draft);
    if (committingField) { committingField.inspectorDraft = false; committingField.removeAttribute('aria-invalid'); }
    historyPush(project); project = draft; previewDirty = true;
    if (!project.floors.some(f => f.id === activeFloorId)) activeFloorId = project.floors[0].id;
    if (!selected()) selection = null;
    editorChanged(); renderUI(); if (fit) { fitPlan(); fitPreview(); } renderPlan(); status(message); save();
    return true;
  } catch (error) { if (committingField) { committingField.inspectorDraft = true; committingField.setAttribute('aria-invalid', 'true'); } selection = priorSelection; $('project-title').value = project.title; status(() => t('Change not applied: {error}', { error: formatValidationError(error, t) }), true); renderInspector(); return false; }
}
async function replaceProject(next, message) {
  validateProject(next); const raw = serializeProject(next), previous = serializeProject(project);
  const result = await save({ raw, previous: hasContent() ? previous : undefined, isCurrent: () => serializeProject(project) === previous });
  if (result.status !== 'saved') {
    if (result.status === 'unavailable' && confirm(t('Autosave is unavailable. Continue in this tab without saving? Export JSON before leaving.'))) {
      installRecoveredProject(next); showDraftProblem(result); return true;
    }
    if (result.status !== 'cancelled') { renderRecovery(); if (!$('recovery-dialog').open) $('recovery-dialog').showModal(); }
    return false;
  }
  installRecoveredProject(next);
  status(message);
  return true;
}
function installRecoveredProject(next) {
  historyPush(project); project = clone(next); activeFloorId = project.floors[0].id;
  selection = null; drag = null; previewDirty = true; inspectorScope = '';
  editorChanged(); setView('plan'); setTool('select'); renderUI(); fitPlan(); fitPreview(); renderPlan();
}
function undo(redo = false) {
  const source = redo ? future : history, destination = redo ? history : future; if (!source.length) return;
  destination.push(project); project = source.pop(); if (!project.floors.some(f => f.id === activeFloorId)) activeFloorId = project.floors[0].id;
  selection = null; drag = null; previewDirty = true; editorChanged(); renderUI(); renderPlan(); status(() => redo ? t('Change restored.') : t('Change undone.')); save();
}
function renderUI() {
  $('project-title').value = project.title; $('floor-caption').textContent = floor().name;
  $('undo').disabled = history.length === 0; $('redo').disabled = future.length === 0;
  const floorList = node('div');
  project.floors.forEach(f => {
    const b = button('', () => selectFloor(f.id), 'floor-button');
    b.dataset.inspectorKey = `floor:${f.id}`;
    b.setAttribute('aria-current', String(f.id === activeFloorId)); b.append(node('span', '', f.name), node('small', '', `${round(f.elevation_m)} m`)); floorList.append(b);
  });
  reconcileInspector($('floor-list'), floorList);
  updateFloorNavigator();
  const objectList = node('div');
  let count = 0;
  for (const [kind, icon] of [['rooms', '▱'], ['walls', '╱'], ['openings', '⊟'], ['items', '▣']]) for (const object of floor()[kind]) {
    count++;
    const b = button('', () => { setTool('select'); setSelection({ kind, id: object.id }); }, 'object-button');
    b.dataset.objectKind = kind; b.dataset.objectId = object.id; b.dataset.inspectorKey = `object:${kind}:${object.id}`;
    b.setAttribute('aria-pressed', String(selection?.kind === kind && selection?.id === object.id));
    b.append(node('span', 'object-icon', icon), node('span', '', object.name || (kind === 'openings' ? `${t(object.type)} · ${object.id}` : object.id.replaceAll('_', ' '))));
    b.title = t('{kind}: {name}', { kind: t(kind === 'openings' ? 'opening' : kind.slice(0, -1)), name: object.name || object.id }); objectList.append(b);
  }
  $('object-count').textContent = String(count);
  if (!count) objectList.append(node('p', 'object-empty', t('Your rooms, walls, and items will appear here.')));
  reconcileInspector($('object-list'), objectList);
  $('empty-state').hidden = count > 0 || tool !== 'select' || view !== 'plan';
  renderInspector(); if (view === 'preview') renderPreview();
}
function setSelection(next) {
  if (selection?.kind === next?.kind && selection?.id === next?.id) return;
  selection = next; editorChanged();
  // Selection changes do not alter floor names, object labels, or their order.
  for (const b of $('object-list').children) if (b.dataset.objectId) {
    b.setAttribute('aria-pressed', String(b.dataset.objectKind === selection?.kind && b.dataset.objectId === selection?.id));
  }
  renderInspector(); requestCanvasRender();
}
function field(parent, label, value, onChange, { type = 'text', min, max, step = '0.05', help, options, rows, readOnly = false, dir } = {}) {
  const wrap = node('label', 'field'), title = node('span', '', label);
  const input = node(options ? 'select' : rows ? 'textarea' : 'input');
  if (options) for (const entry of options) { const opt = node('option', '', typeof entry === 'string' ? entry : entry.label); opt.value = typeof entry === 'string' ? entry : entry.value; input.append(opt); }
  else if (!rows) { input.type = type; if (type === 'number') { input.step = step; if (min !== undefined) input.min = String(min); if (max !== undefined) input.max = String(max); } }
  if (rows) input.rows = rows; input.value = String(value ?? ''); input.readOnly = readOnly;
  if (dir) input.dir = dir;
  input.setAttribute('aria-label', label); input.dataset.inspectorKey = `input:${label}`; wrap.dataset.inspectorKey = `field:${label}`;
  input.oninput = event => { event.currentTarget.inspectorDraft = true; };
  input.onchange = event => {
    if (!onChange) return;
    committingField = event.currentTarget;
    try { onChange(type === 'number' ? (committingField.value.trim() ? Number(committingField.value) : NaN) : committingField.value); }
    finally { committingField = null; }
  };
  wrap.append(title, input); if (help) wrap.append(node('small', '', help)); parent.append(wrap); return input;
}
function row(parent, triple = false) { const r = node('div', `field-row${triple ? ' triple' : ''}`); parent.append(r); return r; }
function section(parent, text) { parent.append(node('h3', 'inspector-section-title', text)); }
function editObject(change, message) { transact((_p, f) => { const o = f[selection.kind].find(item => item.id === selection.id); change(o, f); }, message); }
function inspectorValue(input) {
  return [...$('inspector-body').querySelectorAll('input')].find(control => control.dataset.inspectorKey === input.dataset.inspectorKey)?.value ?? input.value;
}
function renderInspector() {
  const parent = $('inspector-body'), next = node('div');
  const scope = `${project.id || ''}:${activeFloorId}:${selection?.kind || ''}:${selection?.id || ''}`;
  buildInspector(next);
  if (scope === inspectorScope) reconcileInspector(parent, next);
  else { parent.replaceChildren(...next.childNodes); inspectorScope = scope; }
}
function buildInspector(parent) {
  const object = selected(), f = floor();
  if (!object) {
    $('inspector-title').textContent = t('Floor settings'); $('inspector-subtitle').textContent = t('A good plan starts with the basics.');
    field(parent, t('Floor name'), f.name, v => transact((_p, d) => { d.name = v; }, () => t('Floor renamed.')));
    const dimensions = row(parent); field(dimensions, t('Elevation (m)'), f.elevation_m, v => transact((_p, d) => { d.elevation_m = v; }), { type: 'number', min: -100, max: 100 });
    field(dimensions, t('Ceiling height (m)'), f.height_m, v => transact((_p, d) => { d.height_m = v; }), { type: 'number', min: .5, max: 20 });
    parent.append(node('p', 'field-note', t('Elevation is measured from the building origin. Items use height above their own floor.')));
    section(parent, t('Add room by dimensions'));
    const bounds = floorBounds(f), proposedX = f.rooms.length ? Math.ceil(bounds.maxX + 1) : 0;
    const origin = row(parent), dims = row(parent);
    const x = field(origin, t('Start x (m)'), proposedX, null, { type: 'number', min: -100, max: 100 }), z = field(origin, t('Start z (m)'), 0, null, { type: 'number', min: -100, max: 100 });
    const width = field(dims, t('Width (m)'), 4, null, { type: 'number', min: .25, max: 100 }), depth = field(dims, t('Depth (m)'), 4, null, { type: 'number', min: .25, max: 100 });
    parent.append(button(t('Add room'), () => {
      const sx = Number(inspectorValue(x)), sz = Number(inspectorValue(z)), w = Number(inspectorValue(width)), d = Number(inspectorValue(depth));
      if (w < .05 || d < .05) return status(() => t('Room width and depth must be at least 0.05 m.'), true);
      transact((_p, target) => { const id = nextId(target, 'room'); target.rooms.push({ id, name: `Room ${target.rooms.length + 1}`, polygon: [[sx, sz], [round(sx + w), sz], [round(sx + w), round(sz + d)], [sx, round(sz + d)]], material: 'floor' }); selection = { kind: 'rooms', id }; }, () => t('Room added. Choose Build wall outline to create its walls.'), { fit: true });
    }, 'primary'));
    parent.append(node('p', 'callout', t('Rooms are floor areas. Draw walls yourself, or select a room and build its wall outline. Moving a room will not move its walls.')));
    parent.append(button(t('Clear this floor'), () => { if (confirm(t('Clear every room, wall, opening, and item on {floor}? You can undo this.', { floor: f.name }))) transact((_p, target) => { for (const key of ['rooms', 'walls', 'openings', 'items']) target[key] = []; selection = null; }, () => t('Floor cleared.')); }, 'danger'));
    if (project.floors.length > 1) parent.append(button(t('Delete this floor'), () => { if (confirm(t('Delete {floor} and everything on it? You can undo this.', { floor: f.name }))) transact(p => { p.floors = p.floors.filter(item => item.id !== activeFloorId); selection = null; }, () => t('Floor deleted.'), { fit: true }); }, 'danger'));
    parent.append(node('p', 'property-id', t('Floor ID: {id}', { id: f.id }))); return;
  }
  const kind = selection.kind;
  $('inspector-title').textContent = ({ rooms: t('Room details'), walls: t('Wall details'), openings: t('Opening details'), items: t('Item details') })[kind];
  $('inspector-subtitle').textContent = ({ rooms: t('Shape the space. Then add its walls.'), walls: t('A physical segment with real thickness.'), openings: t('A true cutout in the selected wall.'), items: t('Give every object a place and a purpose.') })[kind];
  if (kind === 'rooms') {
    const metric = node('div', 'metric-strip'); metric.append(node('strong', '', Math.abs(signedArea(object.polygon)).toFixed(2)), node('span', '', t('m² floor area'))); parent.append(metric);
    field(parent, t('Room name'), object.name, v => editObject(o => { o.name = v; }));
    field(parent, t('Floor material'), object.material, v => editObject(o => { o.material = v; }), { options: [{ value: 'floor', label: t('Warm timber') }, { value: 'tile', label: t('Tile / stone') }, { value: 'deck', label: t('Outdoor deck') }] });
    parent.append(button(t('Build wall outline'), () => { let n = 0; const ok = transact((_p, d) => { n = outlineRoom(d, d.rooms.find(r => r.id === object.id)); }, () => t('Wall outline added. Exact shared walls are reused.')); if (ok) status(() => n ? t('{count} wall segments added. Exact shared walls were reused.', { count: n }) : t('This room already has a complete wall outline.')); }, 'primary'));
    parent.append(node('p', 'field-note', t('Outlines use 0.15 m walls. Existing walls stay independent of this room.')));
    parent.append(button(t('Place item at room center'), () => {
      const center = object.polygon.reduce((sum, p) => [sum[0] + p[0] / object.polygon.length, sum[1] + p[1] / object.polygon.length], [0, 0]);
      addItem(center, object.id);
    }));
    parent.append(node('p', 'field-note', t('Places {item}. Choose another design in the Item library, then select this room again.', { item: placementName() })));
    section(parent, t('Polygon points'));
    field(parent, t('x, z coordinates (m)'), object.polygon.map(p => p.join(', ')).join('\n'), value => editObject(o => {
      const points = value.trim().split('\n').filter(s => s.trim()).map(line => line.trim().split(/[\s,]+/).map(Number));
      if (points.some(p => p.length !== 2 || p.some(v => !Number.isFinite(v)))) throw new Error(t('Use one x, z coordinate pair per line.')); o.polygon = points;
    }), { rows: Math.min(7, object.polygon.length), dir: 'ltr', help: t('One corner per line, around the perimeter. Do not repeat the first point. Concave shapes are supported; crossing edges are not.') });
  } else if (kind === 'walls') {
    const length = distance(object.start, object.end); const metric = node('div', 'metric-strip'); metric.append(node('strong', '', length.toFixed(2)), node('span', '', t('m segment length'))); parent.append(metric);
    for (const endpoint of ['start', 'end']) { section(parent, t(`${endpoint} point`)); const r = row(parent); ['x', 'z'].forEach((axis, index) => field(r, t(`${endpoint} ${axis} (m)`), object[endpoint][index], v => editObject(o => { o[endpoint][index] = v; }), { type: 'number', min: -100, max: 100 })); }
    field(parent, t('Thickness (m)'), object.thickness_m, v => editObject(o => { o.thickness_m = v; }), { type: 'number', min: .04, max: 2, step: '.01' });
    const r = row(parent); r.append(button(t('Add door'), () => addOpening(object, length / 2, 'door')), button(t('Add window'), () => addOpening(object, length / 2, 'window')));
    section(parent, t('Create a junction'));
    const split = field(parent, t('Split distance from start (m)'), round(length / 2), null, { type: 'number', min: .05, max: round(length - .05), help: t('Split this segment so another wall can meet at an endpoint. A split cannot pass through an opening.') });
    parent.append(button(t('Split wall'), () => editObject((o, d) => {
      const at = Number(inspectorValue(split)); if (at < .05 || at > length - .05) throw new Error(t('Split point must be at least 0.05 m from each end.'));
      if (d.openings.some(c => c.wall_id === o.id && c.offset_m < at && c.offset_m + c.width_m > at)) throw new Error(t('Move the split point outside the opening.'));
      const mid = [round(o.start[0] + (o.end[0] - o.start[0]) * at / length), round(o.start[1] + (o.end[1] - o.start[1]) * at / length)];
      const second = { id: nextId(d, 'wall'), start: mid, end: [...o.end], thickness_m: o.thickness_m }; o.end = mid; d.walls.push(second);
      d.openings.filter(c => c.wall_id === o.id && c.offset_m >= at).forEach(c => { c.wall_id = second.id; c.offset_m = round(c.offset_m - at); });
    }, () => t('Wall split into two segments.'))));
  } else if (kind === 'openings') {
    const wall = f.walls.find(w => w.id === object.wall_id);
    field(parent, t('Opening type'), object.type, v => editObject(o => { o.type = v; if (v !== 'window') o.sill_m = 0; }), { options: ['door', 'window', 'passage'].map(value => ({ value, label: t(value) })) });
    field(parent, t('Width (m)'), object.width_m, v => editObject(o => { o.width_m = v; }), { type: 'number', min: .05, max: distance(wall.start, wall.end) });
    field(parent, t('Offset from wall start (m)'), object.offset_m, v => editObject(o => { o.offset_m = v; }), { type: 'number', min: 0, help: t('Wall starts at x {x}, z {z}. Offset locates the first edge of this opening.', { x: wall.start[0], z: wall.start[1] }) });
    const r = row(parent); field(r, t('Sill height (m)'), object.sill_m, v => editObject(o => { o.sill_m = v; }), { type: 'number', min: 0, max: f.height_m }); field(r, t('Head height (m)'), object.head_m, v => editObject(o => { o.head_m = v; }), { type: 'number', min: .05, max: f.height_m });
    parent.append(node('p', 'callout', t('These dimensions remove wall geometry in both the preview and the exported build. The window tint is only a preview aid.')));
    parent.append(button(t('Select parent wall'), () => { setSelection({ kind: 'walls', id: wall.id }); renderUI(); renderPlan(); }));
  } else if (kind === 'items') {
    field(parent, t('Item name'), object.name, v => editObject(o => { o.name = v; }));
    const model = object.model_id ? getCatalogModel(object.model_id) : null;
    field(parent, t('Design'), object.model_id || '', value => editObject(o => {
      if (!value) { for (const key of ['model_id', 'style_id', 'color', 'pattern_id', 'pattern_color']) delete o[key]; return; }
      const next = getCatalogModel(value), previous = o.model_id ? getCatalogModel(o.model_id) : null;
      if (o.name === previous?.label || o.name === LABELS[o.type]) o.name = next.label;
      o.model_id = next.id; o.type = next.type; o.style_id ||= next.default_style;
      if (!supportsFurniturePattern(next)) { delete o.pattern_id; delete o.pattern_color; }
    }, () => t('Item design changed. Size and position kept.')), { options: [{ value: '', label: t('Basic shape / device') }, ...CATALOG.models.map(entry => ({ value: entry.id, label: t(`model.${entry.id}`) }))], help: t('Changes the shape while keeping your size and placement.') });
    if (model) {
      const style = getCatalogStyle(object.style_id || model.default_style);
      field(parent, t('Color palette'), style.id, value => editObject(o => { o.style_id = value; delete o.color; delete o.pattern_color; }, () => t('Color palette applied.')), { options: CATALOG.styles.map(entry => ({ value: entry.id, label: t(`palette.${entry.id}`) })), help: t('Coordinated colors for the whole item. Changing palette resets custom colors and keeps your pattern.') });
      const strip = node('div', 'palette-preview'); strip.setAttribute('aria-label', t('{palette} palette', { palette: t(`palette.${style.id}`) }));
      for (const role of ['body', 'accent', 'wood', 'metal']) { const swatch = node('span'); swatch.style.backgroundColor = style.materials[role]; swatch.title = t('{role}: {color}', { role: t(role), color: style.materials[role] }); strip.append(swatch); }
      parent.append(strip);
      field(parent, t('Custom body color'), object.color || style.materials.body, value => editObject(o => { o.color = value; }, () => t('Item color changed.')), { type: 'color', help: t('Recolors the main surface; legs and accents keep the selected palette.') });
      const palette = node('div', 'color-palette'); palette.setAttribute('role', 'group'); palette.setAttribute('aria-label', t('Body color suggestions'));
      for (const [label, color] of [['Ivory', '#e6dfd1'], ['Sand', '#c9aa7d'], ['Terracotta', '#be785d'], ['Sage', '#899e82'], ['Forest', '#416c59'], ['Ocean', '#507b95'], ['Slate', '#757985'], ['Charcoal', '#363e43']]) {
        const swatch = button('', () => editObject(o => { o.color = color; }, () => t('{color} color applied.', { color: t(label) })), 'color-swatch');
        swatch.style.setProperty('--swatch', color); swatch.title = t(label); swatch.setAttribute('aria-label', t(label)); swatch.setAttribute('aria-pressed', String(object.color?.toLowerCase() === color)); palette.append(swatch);
      }
      parent.append(palette);
      const resetColor = button(t('Use palette color'), () => editObject(o => { delete o.color; }, () => t('Palette color restored.')), 'quiet small'); resetColor.disabled = !object.color; parent.append(resetColor);
      if (supportsFurniturePattern(model)) {
        field(parent, t('Surface pattern'), object.pattern_id || 'none', value => editObject(o => {
          if (value === 'none') { delete o.pattern_id; delete o.pattern_color; } else o.pattern_id = value;
        }, () => t('Surface pattern updated.')), { options: PATTERNS.map(entry => ({ value: entry.id, label: t(`pattern.${entry.id}`) })), help: t('Applies to this design’s fabric or decorative panels. Choose None for its original appearance.') });
        if (object.pattern_id && object.pattern_id !== 'none') {
          field(parent, t('Pattern color'), object.pattern_color || style.materials.accent, value => editObject(o => { o.pattern_color = value; }, () => t('Pattern color changed.')), { type: 'color', help: t('Choose a contrasting color so the pattern is easy to see.') });
          const resetPattern = button(t('Use palette pattern color'), () => editObject(o => { delete o.pattern_color; }, () => t('Pattern color restored.')), 'quiet small'); resetPattern.disabled = !object.pattern_color; parent.append(resetPattern);
        }
      }
      const preview = node('canvas', 'appearance-preview'); preview.width = 280; preview.height = 170;
      preview.setAttribute('aria-label', t('{name}: current color palette and pattern', { name: object.name }));
      parent.append(preview); drawItemThumbnail(preview, model, object);
    } else {
      field(parent, t('Item type'), object.type, value => editObject(o => { o.type = value; }), { options: ITEM_TYPES.map(value => ({ value, label: t(LABELS[value]) })) });
    }
    field(parent, t('Room'), object.room, v => editObject(o => { o.room = v; }), { options: f.rooms.map(r => ({ value: r.id, label: r.name })) });
    section(parent, t('Position')); const pos = row(parent, true);
    for (const axis of ['x', 'y', 'z']) field(pos, t(`${axis} (m)`), object.position_m[axis], v => editObject(o => { o.position_m[axis] = v; }), { type: 'number', min: axis === 'y' ? 0 : -100, max: axis === 'y' ? f.height_m : 100 });
    parent.append(node('p', 'field-note', t('x/z locate the center. y is the bottom height above this floor.')));
    section(parent, t('Size & rotation')); const dims = row(parent, true);
    for (const [axis, title] of [['width', 'Width'], ['depth', 'Depth'], ['height', 'Height']]) field(dims, t(`${title} (m)`), object.dimensions_m[axis], v => editObject(o => { o.dimensions_m[axis] = v; }), { type: 'number', min: .001, max: 100 });
    if (model) parent.append(button(t('Use design’s original size'), () => editObject(o => {
      const defaults = modelDimensions(model, f.height_m, o.position_m.y); o.dimensions_m = defaults.dimensions; o.position_m.y = defaults.elevation;
    }, () => t('Original design size restored to fit this floor.'))));
    field(parent, t('Rotation (degrees)'), object.rotation_deg, v => editObject(o => { o.rotation_deg = v; }), { type: 'number', min: -360, max: 360, step: '15' });
    section(parent, t('Home Assistant'));
    field(parent, t('Entity ID (optional)'), object.entity_id, v => editObject(o => { o.entity_id = v.trim(); }), { dir: 'ltr', help: t('Example: light.living_room. Any Home Assistant entity can be linked. In the installed plan, lights, switches and fans have quick toggles; sensors show readings; media players show artwork and controls; Details opens native controls for other entities. This offline planner only stores the mapping and never controls devices.') });
    field(parent, t('Notes'), object.notes, v => editObject(o => { o.notes = v; }), { rows: 3 });
  }
  parent.append(button(t(`Delete ${kind === 'openings' ? 'opening' : kind.slice(0, -1)}`), deleteSelection, 'danger'));
  parent.append(node('p', 'property-id', object.wall_id ? t('ID: {id} · Wall: {wall}', { id: object.id, wall: object.wall_id }) : t('ID: {id}', { id: object.id })));
}
function deleteSelection() {
  if (!selection || !selected()) return;
  const { kind, id } = selection;
  transact((_p, f) => {
    f[kind] = f[kind].filter(o => o.id !== id);
    if (kind === 'walls') f.openings = f.openings.filter(o => o.wall_id !== id);
    if (kind === 'rooms') f.items = f.items.filter(o => o.room !== id);
    selection = null;
  }, () => kind === 'walls' ? t('Wall and its openings deleted. Undo is available.') : kind === 'rooms' ? t('Room and its assigned items deleted. Walls remain. Undo is available.') : t('Object deleted. Undo is available.'));
}
function setTool(next) {
  tool = next; document.querySelectorAll('[data-tool]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
  if (view === 'plan') $('tool-hint').textContent = toolHint();
  planCanvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
  if (tool !== 'select' && view !== 'plan') setView('plan');
  $('empty-state').hidden = displayedFloor().rooms.length + displayedFloor().walls.length + displayedFloor().items.length > 0 || tool !== 'select' || view !== 'plan';
}
function setView(next) {
  releasePreviewPointer();
  view = next;
  $('plan-tab').setAttribute('aria-selected', String(next === 'plan')); $('preview-tab').setAttribute('aria-selected', String(next === 'preview'));
  $('plan-tab').tabIndex = next === 'plan' ? 0 : -1; $('preview-tab').tabIndex = next === 'preview' ? 0 : -1;
  $('plan-view').hidden = next !== 'plan'; $('preview-view').hidden = next !== 'preview'; $('snap-label').hidden = next !== 'plan';
  $('tool-hint').textContent = next === 'preview' ? previewHint() : toolHint();
  updatePreviewNavigation();
  $('empty-state').hidden = displayedFloor().rooms.length + displayedFloor().walls.length + displayedFloor().items.length > 0 || tool !== 'select' || next !== 'plan';
  if (next === 'preview') renderPreview(); else renderPlan(); updateZoom();
}
function addOpening(wall, offset, type) {
  const len = distance(wall.start, wall.end), width = round(Math.min(type === 'window' ? 1.2 : .9, Math.max(.05, len - .1)));
  const start = round(Math.max(0, Math.min(len - width, snap(offset - width / 2))));
  const height = floor().height_m;
  transact((_p, f) => {
    const id = nextId(f, type), head = round(Math.min(type === 'window' ? 2.2 : 2.1, height));
    f.openings.push({ id, wall_id: wall.id, type, offset_m: start, width_m: width, sill_m: type === 'window' ? round(Math.min(.9, head / 2)) : 0, head_m: head }); selection = { kind: 'openings', id };
  }, () => t(type === 'window' ? 'Window opening added. Adjust its dimensions in the inspector.' : 'Door opening added. Adjust its dimensions in the inspector.'));
}
function addItem(point, roomId) {
  if (!floor().rooms.length) return status(() => t('Add a room before placing items. Each item belongs to a room.'), true);
  const model = placementModelId ? getCatalogModel(placementModelId) : null, type = model ? model.type : $('place-type').value;
  const defaults = { furniture: [1.5, .75, .75, 0], lamp: [.3, .3, 1.4, 0], chandelier: [.55, .55, .35, Math.max(0, floor().height_m - .55)], tv: [1.3, .1, .8, .85], appliance: [.6, .65, .9, 0], switch: [.1, .05, .1, 1.2], outlet: [.1, .05, .1, .3], sensor: [.12, .08, .12, 1.8] };
  const [w, d, h, y] = defaults[type]; const safeHeight = Math.min(h, floor().height_m), safeY = Math.min(y, floor().height_m - safeHeight);
  const catalogDefaults = model ? modelDimensions(model, floor().height_m) : null;
  transact((_p, f) => {
    const id = nextId(f, type), room = f.rooms.find(r => r.id === roomId) || f.rooms.find(r => pointInPolygon(point, r.polygon)) || f.rooms[0];
    f.items.push({ id, name: model?.label || LABELS[type], type, room: room.id, position_m: { x: snap(point[0]), y: catalogDefaults?.elevation ?? round(safeY), z: snap(point[1]) }, dimensions_m: catalogDefaults?.dimensions || { width: w, depth: d, height: round(safeHeight) }, rotation_deg: 0, entity_id: '', notes: '', ...(model ? { model_id: model.id, style_id: model.default_style } : {}) }); selection = { kind: 'items', id };
  }, () => t('{item} placed. Change its finish, color, or size in Item details.', { item: model ? t(`model.${model.id}`) : t(LABELS[type]) }));
}

// Canvas plan: x right, z down. Coordinates remain meters at every zoom level.
const toScreen = p => [map.x + p[0] * map.scale, map.y + p[1] * map.scale];
const toWorld = p => [(p[0] - map.x) / map.scale, (p[1] - map.y) / map.scale];
function localPoint(event, canvas = planCanvas) { const r = canvas.getBoundingClientRect(); return [event.clientX - r.left, event.clientY - r.top]; }
function fitPlan() {
  const b = floorBounds(displayedFloor()), pad = 90;
  map.scale = Math.max(8, Math.min(95, (size.width - pad * 2) / Math.max(2, b.maxX - b.minX), (size.height - pad * 2) / Math.max(2, b.maxZ - b.minZ)));
  map.x = (size.width - (b.minX + b.maxX) * map.scale) / 2; map.y = (size.height - (b.minZ + b.maxZ) * map.scale) / 2; updateZoom();
}
function zoomPlan(factor, anchor = [size.width / 2, size.height / 2]) {
  const world = toWorld(anchor); map.scale = Math.max(4, Math.min(280, map.scale * factor)); map.x = anchor[0] - world[0] * map.scale; map.y = anchor[1] - world[1] * map.scale; requestCanvasRender(); updateZoom();
}
function updateZoom() { $('zoom-value').textContent = view === 'plan' ? `${Math.round(map.scale / 55 * 100)}%` : `${Math.round(orbit.baseRadius / orbit.radius * 100)}%`; }
function path(points, close = false) { ctx.beginPath(); points.forEach((p, i) => { const [x, y] = toScreen(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); if (close) ctx.closePath(); }
function planShapePath(shape, width, depth) {
  let cached = planPathCache.get(shape);
  if (!cached || cached.width !== width || cached.depth !== depth) {
    const outline = new Path2D();
    shape.points.forEach(([x, z], i) => { if (i) outline.lineTo(x * width, z * depth); else outline.moveTo(x * width, z * depth); });
    outline.closePath();
    // Keep one scaled outline per cached surface. Translation and rotation
    // remain in the context, preserving fixed-width strokes and layer order.
    cached = { width, depth, outline }; planPathCache.set(shape, cached);
  }
  return cached.outline;
}
function renderPlan() {
  if (view !== 'plan' || canvasSuspended || document.hidden) return;
  cancelCanvasRender();
  ctx.clearRect(0, 0, size.width, size.height); ctx.fillStyle = '#f2f4ed'; ctx.fillRect(0, 0, size.width, size.height);
  const top = toWorld([0, 0]), bottom = toWorld([size.width, size.height]), gridStep = map.scale > 22 ? 1 : 5;
  ctx.lineWidth = 1;
  for (let x = Math.floor(top[0] / gridStep) * gridStep; x <= bottom[0]; x += gridStep) { const px = Math.round(toScreen([x, 0])[0]) + .5; ctx.strokeStyle = x === 0 ? '#c5d0bd' : '#e2e7dc'; ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, size.height); ctx.stroke(); }
  for (let z = Math.floor(top[1] / gridStep) * gridStep; z <= bottom[1]; z += gridStep) { const py = Math.round(toScreen([0, z])[1]) + .5; ctx.strokeStyle = z === 0 ? '#c5d0bd' : '#e2e7dc'; ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(size.width, py); ctx.stroke(); }
  if (map.scale >= 44) { ctx.fillStyle = '#dde4d6'; for (let x = Math.floor(top[0]); x <= bottom[0]; x += .25) for (let z = Math.floor(top[1]); z <= bottom[1]; z += .25) { const [px, py] = toScreen([x, z]); ctx.fillRect(px, py, 1, 1); } }
  const f = displayedFloor();
  for (const r of f.rooms) {
    const active = selection?.kind === 'rooms' && selection.id === r.id;
    path(r.polygon, true); ctx.fillStyle = COLORS[r.material]; ctx.globalAlpha = active ? .85 : .65; ctx.fill(); ctx.globalAlpha = 1; ctx.strokeStyle = active ? '#4a8073' : '#b4bba3'; ctx.lineWidth = active ? 2 : 1; ctx.setLineDash(active ? [5, 3] : []); ctx.stroke(); ctx.setLineDash([]);
    const centroid = r.polygon.reduce((a, p) => [a[0] + p[0] / r.polygon.length, a[1] + p[1] / r.polygon.length], [0, 0]), [cx, cy] = toScreen(centroid);
    if (map.scale > 15) { ctx.textAlign = 'center'; ctx.fillStyle = '#697c63'; ctx.font = '600 11px -apple-system, sans-serif'; ctx.fillText(r.name.length > 25 ? r.name.slice(0, 24) + '…' : r.name, cx, cy - 3); ctx.font = '9px -apple-system, sans-serif'; ctx.fillStyle = '#8d9a7c'; ctx.fillText(`${Math.abs(signedArea(r.polygon)).toFixed(1)} m²`, cx, cy + 12); }
    if (active) for (const p of r.polygon) { const [x, y] = toScreen(p); ctx.fillStyle = '#fff'; ctx.strokeStyle = '#4a8073'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  }
  for (const w of f.walls) {
    const active = selection?.kind === 'walls' && selection.id === w.id;
    path([w.start, w.end]); ctx.strokeStyle = active ? '#3a7b6a' : '#778776'; ctx.lineWidth = Math.max(3, w.thickness_m * map.scale); ctx.lineCap = 'butt'; ctx.stroke();
    if (active) { for (const [i, p] of [w.start, w.end].entries()) { const [x, y] = toScreen(p); ctx.fillStyle = '#fff'; ctx.strokeStyle = '#3a7b6a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#3a7b6a'; ctx.font = '9px sans-serif'; ctx.textAlign = 'left'; ctx.fillText(t(i ? 'end' : 'start'), x + 7, y - 7); } }
  }
  for (const o of f.openings) {
    const w = f.walls.find(wall => wall.id === o.wall_id); if (!w) continue;
    const len = distance(w.start, w.end), ux = (w.end[0] - w.start[0]) / len, uz = (w.end[1] - w.start[1]) / len;
    const start = [w.start[0] + ux * o.offset_m, w.start[1] + uz * o.offset_m], end = [start[0] + ux * o.width_m, start[1] + uz * o.width_m];
    const active = selection?.kind === 'openings' && selection.id === o.id;
    path([start, end]); ctx.lineWidth = Math.max(6, w.thickness_m * map.scale + 2); ctx.strokeStyle = '#f2f4ed'; ctx.stroke();
    ctx.strokeStyle = active ? '#df935b' : o.type === 'window' ? '#75a8ae' : '#839980'; ctx.lineWidth = active ? 3 : 1.5;
    if (o.type === 'window') { path([start, end]); ctx.stroke(); const shift = .035; path([[start[0] - uz * shift, start[1] + ux * shift], [end[0] - uz * shift, end[1] + ux * shift]]); ctx.stroke(); }
    else if (o.type === 'door') {
      const [x, y] = toScreen(start), angle = Math.atan2(uz, ux), radius = o.width_m * map.scale;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - Math.sin(angle) * radius, y + Math.cos(angle) * radius); ctx.stroke(); ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(x, y, radius, angle, angle + Math.PI / 2); ctx.stroke(); ctx.setLineDash([]);
    } else { ctx.setLineDash([3, 3]); path([start, end]); ctx.stroke(); ctx.setLineDash([]); }
    if (active) { path([start, end]); ctx.lineWidth = 7; ctx.strokeStyle = '#df935b55'; ctx.stroke(); }
  }
  // Draw individual top surfaces by elevation, so a newly placed rug remains
  // below furniture and a raised lamp stays above a table regardless of order.
  const itemLayers = f.items.flatMap(item => {
    const shapes = item.model_id ? itemPlanShapes(item) : null;
    return (shapes || [null]).map(shape => ({ item, shape, height: item.position_m.y + (shape?.height ?? 1) * item.dimensions_m.height }));
  }).sort((a, b) => a.height - b.height);
  for (const { item, shape } of itemLayers) {
    const [x, y] = toScreen([item.position_m.x, item.position_m.z]);
    ctx.save(); ctx.translate(x, y); ctx.rotate(-item.rotation_deg * Math.PI / 180); const w = Math.max(7, item.dimensions_m.width * map.scale), d = Math.max(7, item.dimensions_m.depth * map.scale);
    ctx.fillStyle = COLORS[item.type]; ctx.strokeStyle = '#637f78'; ctx.lineWidth = 1; ctx.shadowColor = '#293c3315'; ctx.shadowBlur = 5;
    if (shape) {
      ctx.shadowBlur = 0; ctx.lineWidth = .65; ctx.strokeStyle = '#33453f55';
      const outline = planShapePath(shape, w, d); ctx.fillStyle = shape.color; ctx.fill(outline); if (!shape.triangle) ctx.stroke(outline);
    } else if (['chandelier', 'lamp', 'sensor'].includes(item.type)) { ctx.beginPath(); ctx.ellipse(0, 0, w / 2, d / 2, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    else { ctx.fillRect(-w / 2, -d / 2, w, d); ctx.strokeRect(-w / 2, -d / 2, w, d); if (item.type === 'furniture' && w > 28 && d > 20) { ctx.strokeStyle = '#ffffff66'; ctx.strokeRect(-w / 2 + 4, -d / 2 + 4, w - 8, d - 8); } }
    ctx.restore();
  }
  const activeItem = selection?.kind === 'items' ? selected() : null;
  if (activeItem) {
    const [x, y] = toScreen([activeItem.position_m.x, activeItem.position_m.z]);
    const w = Math.max(7, activeItem.dimensions_m.width * map.scale), d = Math.max(7, activeItem.dimensions_m.depth * map.scale);
    ctx.save(); ctx.translate(x, y); ctx.rotate(-activeItem.rotation_deg * Math.PI / 180); ctx.strokeStyle = '#bd783c'; ctx.lineWidth = 2;
    if (activeItem.model_id) { ctx.setLineDash([4, 3]); ctx.strokeRect(-w / 2 - 3, -d / 2 - 3, w + 6, d + 6); }
    else if (['chandelier', 'lamp', 'sensor'].includes(activeItem.type)) { ctx.beginPath(); ctx.ellipse(0, 0, w / 2, d / 2, 0, 0, Math.PI * 2); ctx.stroke(); }
    else ctx.strokeRect(-w / 2, -d / 2, w, d);
    ctx.restore(); ctx.fillStyle = '#5e776a'; ctx.textAlign = 'center'; ctx.font = '10px sans-serif'; ctx.fillText(activeItem.name, x, y + Math.max(activeItem.dimensions_m.width, activeItem.dimensions_m.depth) * map.scale / 2 + 15);
  }
  if (drag?.kind === 'draw') {
    const a = drag.startWorld, b = drag.endWorld; ctx.strokeStyle = '#3c8c79'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    if (tool === 'room') { path([a, [b[0], a[1]], b, [a[0], b[1]]], true); ctx.fillStyle = '#639e8122'; ctx.fill(); ctx.stroke(); }
    else { path([a, b]); ctx.stroke(); } ctx.setLineDash([]);
    const p = toScreen(b); ctx.fillStyle = '#2c7663'; ctx.textAlign = 'left'; ctx.font = '11px sans-serif'; ctx.fillText(tool === 'room' ? `${Math.abs(b[0] - a[0]).toFixed(2)} × ${Math.abs(b[1] - a[1]).toFixed(2)} m` : `${distance(a, b).toFixed(2)} m`, p[0] + 12, p[1] - 12);
  }
  if (candidatePreview) {
    const accepted = floor();
    ctx.save(); ctx.strokeStyle = '#8051ad'; ctx.lineWidth = 3; ctx.setLineDash([5, 4]);
    for (const room of f.rooms) if (!accepted.rooms.some(r => r.id === room.id)) { path(room.polygon, true); ctx.stroke(); }
    for (const item of f.items) if (!accepted.items.some(i => i.id === item.id)) {
      const [x, y] = toScreen([item.position_m.x, item.position_m.z]);
      ctx.save(); ctx.translate(x, y); ctx.rotate(-item.rotation_deg * Math.PI / 180);
      ctx.strokeRect(-item.dimensions_m.width * map.scale / 2, -item.dimensions_m.depth * map.scale / 2, item.dimensions_m.width * map.scale, item.dimensions_m.depth * map.scale); ctx.restore();
    }
    ctx.restore();
  }
  // A fixed metric scale makes the current zoom unambiguous.
  const scaleMeters = map.scale < 20 ? 5 : map.scale > 150 ? .5 : 1, sx = 20, sy = size.height - 76;
  ctx.strokeStyle = '#9bab8f'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(sx, sy - 3); ctx.lineTo(sx, sy + 3); ctx.moveTo(sx, sy); ctx.lineTo(sx + scaleMeters * map.scale, sy); ctx.moveTo(sx + scaleMeters * map.scale, sy - 3); ctx.lineTo(sx + scaleMeters * map.scale, sy + 3); ctx.stroke(); ctx.fillStyle = '#8a9b7e'; ctx.font = '9px sans-serif'; ctx.textAlign = 'left'; ctx.fillText(t('{scale} m · grid {grid} m', { scale: scaleMeters, grid: gridStep }), sx, sy - 9);
}
function wallAt(point) { return floor().walls.map(w => ({ wall: w, hit: projectOnWall(point, w) })).filter(o => o.hit.distance < Math.max(.1, 10 / map.scale)).sort((a, b) => a.hit.distance - b.hit.distance)[0]; }
function hitTest(point) {
  const topFirst = [...floor().items].reverse().sort((a, b) => (b.position_m.y + b.dimensions_m.height) - (a.position_m.y + a.dimensions_m.height));
  for (const item of topFirst) {
    const theta = item.rotation_deg * Math.PI / 180, dx = point[0] - item.position_m.x, dz = point[1] - item.position_m.z, x = dx * Math.cos(theta) - dz * Math.sin(theta), z = dx * Math.sin(theta) + dz * Math.cos(theta);
    if (Math.abs(x) <= Math.max(item.dimensions_m.width / 2, 6 / map.scale) && Math.abs(z) <= Math.max(item.dimensions_m.depth / 2, 6 / map.scale)) return { kind: 'items', id: item.id };
  }
  const near = wallAt(point);
  if (near) { const opening = floor().openings.find(o => o.wall_id === near.wall.id && near.hit.offset >= o.offset_m - .05 && near.hit.offset <= o.offset_m + o.width_m + .05); return opening ? { kind: 'openings', id: opening.id } : { kind: 'walls', id: near.wall.id }; }
  for (const room of [...floor().rooms].reverse()) if (pointInPolygon(point, room.polygon)) return { kind: 'rooms', id: room.id };
  return null;
}
planCanvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 && event.button !== 1) return;
  event.preventDefault(); planCanvas.focus(); const screen = localPoint(event), world = toWorld(screen); planCanvas.setPointerCapture(event.pointerId);
  if (spaceHeld || event.shiftKey || event.button === 1) { drag = { kind: 'pan', screen, map: { ...map } }; planCanvas.style.cursor = 'grabbing'; return; }
  if (tool === 'room' || tool === 'wall') { const p = world.map(snap); drag = { kind: 'draw', startWorld: p, endWorld: p, screen }; return; }
  if (tool === 'door' || tool === 'window') { const near = wallAt(world); if (near) addOpening(near.wall, near.hit.offset, tool); else status(() => t('Click directly on an existing wall to add an opening.'), true); return; }
  if (tool === 'item') { addItem(world); return; }
  setSelection(hitTest(world));
  if (selection) {
    // Keep one immutable undo snapshot; only the selected object changes while dragging.
    drag = { kind: 'move', startWorld: world, original: project, selection: { ...selection }, moved: false, offset: [0, 0] };
    project = clone(project);
  }
  else drag = { kind: 'pan', screen, map: { ...map } };
});
planCanvas.addEventListener('pointermove', event => {
  const screen = localPoint(event), world = toWorld(screen); $('pointer-position').textContent = `x ${world[0].toFixed(2)} · z ${world[1].toFixed(2)} m`;
  if (!drag) { if (tool === 'select') planCanvas.style.cursor = hitTest(world) ? 'grab' : 'default'; return; }
  if (drag.kind === 'pan') { map.x = drag.map.x + screen[0] - drag.screen[0]; map.y = drag.map.y + screen[1] - drag.screen[1]; }
  if (drag.kind === 'draw') drag.endWorld = world.map(snap);
  if (drag.kind === 'move') {
    const dx = snap(world[0] - drag.startWorld[0]), dz = snap(world[1] - drag.startWorld[1]);
    // Pointer events within one snap cell do not change the plan. Avoid repainting
    // every catalog surface until the object's visible position actually changes.
    if (dx === drag.offset[0] && dz === drag.offset[1]) return;
    drag.offset = [dx, dz];
    if (!drag.moved && (dx || dz)) editorChanged();
    if (dx || dz) drag.moved = true; const object = selected();
    const original = drag.original.floors.find(f => f.id === activeFloorId)[selection.kind].find(o => o.id === selection.id);
    if (selection.kind === 'rooms') object.polygon = original.polygon.map(p => [round(p[0] + dx), round(p[1] + dz)]);
    if (selection.kind === 'walls') { object.start = [round(original.start[0] + dx), round(original.start[1] + dz)]; object.end = [round(original.end[0] + dx), round(original.end[1] + dz)]; }
    if (selection.kind === 'items') { object.position_m.x = round(original.position_m.x + dx); object.position_m.z = round(original.position_m.z + dz); }
    if (selection.kind === 'openings') { const wall = floor().walls.find(w => w.id === object.wall_id), len = distance(wall.start, wall.end); const along = (dx * (wall.end[0] - wall.start[0]) + dz * (wall.end[1] - wall.start[1])) / len; object.offset_m = round(Math.max(0, Math.min(len - object.width_m, original.offset_m + along))); }
  }
  requestCanvasRender();
});
function finishPointer(event, cancel = false) {
  if (!drag) return; const current = drag; drag = null; planCanvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
  if (event && planCanvas.hasPointerCapture(event.pointerId)) planCanvas.releasePointerCapture(event.pointerId);
  if (current.kind === 'draw' && !cancel) {
    const [a, b] = [current.startWorld, current.endWorld];
    if (distance(a, b) < .05) { status(() => t('Drag across the plan to draw a shape.')); renderPlan(); return; }
    if (tool === 'room') {
      if (Math.abs(a[0] - b[0]) < .05 || Math.abs(a[1] - b[1]) < .05) { status(() => t('A room needs both width and depth.'), true); renderPlan(); return; }
      transact((_p, f) => { const id = nextId(f, 'room'); f.rooms.push({ id, name: `Room ${f.rooms.length + 1}`, polygon: [a, [b[0], a[1]], b, [a[0], b[1]]], material: 'floor' }); selection = { kind: 'rooms', id }; }, () => t('Room drawn. Build its wall outline in the inspector.'));
    } else transact((_p, f) => { const id = nextId(f, 'wall'); f.walls.push({ id, start: a, end: b, thickness_m: .15 }); selection = { kind: 'walls', id }; }, () => t('Wall drawn. Add a door or window by clicking the wall.'));
    setTool('select');
  }
  if (current.kind === 'move') {
    if (cancel || !current.moved) project = current.original;
    else {
      try { validateProject(project); serializeProject(project); historyPush(current.original); previewDirty = true; status(() => t('Object moved.')); save(); }
      catch (error) { project = current.original; status(() => t('Move cancelled: {error}', { error: formatValidationError(error, t) }), true); }
    }
    if (project !== current.original) {
      $('undo').disabled = history.length === 0; $('redo').disabled = future.length === 0;
      renderInspector();
    }
    // The movement frame already contains the final geometry, or is still
    // queued. Only a rollback needs another paint to restore the original.
    if (project === current.original && current.moved) renderPlan();
    updateFloorNavigator();
    return;
  }
  renderPlan();
}
planCanvas.addEventListener('pointerup', e => finishPointer(e)); planCanvas.addEventListener('pointercancel', e => finishPointer(e, true));
planCanvas.addEventListener('wheel', e => { e.preventDefault(); zoomPlan(Math.exp(-e.deltaY * .0015), localPoint(e)); }, { passive: false });

// On-demand 3D rendering. Opening cuts and solid wall pieces use the same metric project.
let renderer = null, scene = null, camera = null, worldGroup = null, previewSun = null, previewUnavailable = false, previewMetadata = {};
let previewLost = false, previewSize = '', previewPixels = 2000000, previewInitialized = false, previewRendererDisposed = false, previewInstancing = false, previewDiffuseLighting = false;
const orbit = { yaw: -Math.PI / 3, pitch: .8, radius: 17, baseRadius: 17, target: new THREE.Vector3(4, 0, 3), mode: 'orbit', pointers: new Map(), gesture: null };
function createPreviewMaterial(options) {
  if (!previewDiffuseLighting) return new THREE.MeshStandardMaterial(options);
  const { roughness, metalness, ...shared } = options;
  return new THREE.MeshLambertMaterial(shared);
}
function previewRenderProfile(gl) {
  const capacity = getRenderCapacity(gl);
  const profile = capacity.reduced
    ? { pixels: 250000, shadowSize: 512, instanceCatalog: capacity.diffuseLighting, diffuseLighting: capacity.diffuseLighting }
    : { pixels: 2000000, shadowSize: 2048, instanceCatalog: false, diffuseLighting: false };
  if (capacity.rasterProbe) profile.rasterProbe = capacity.rasterProbe;
  return profile;
}
function initPreview() {
  if (renderer || previewUnavailable) return;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: previewCanvas, antialias: true, alpha: false }); previewRendererDisposed = false; renderer.setClearColor(0xf2f4ed); renderer.outputColorSpace = THREE.SRGBColorSpace;
    const profile = previewRenderProfile(renderer.getContext()); previewPixels = profile.pixels; previewInstancing = profile.instanceCatalog; previewDiffuseLighting = profile.diffuseLighting;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = .9; renderer.shadowMap.enabled = true; renderer.shadowMap.type = previewDiffuseLighting ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;
    scene = new THREE.Scene(); camera = new THREE.PerspectiveCamera(40, 1, .02, 1500); scene.add(new THREE.HemisphereLight(0xffffff, 0xc7cfbc, 1.7));
    previewSun = new THREE.DirectionalLight(0xfff6e6, 2.5); previewSun.castShadow = true; previewSun.shadow.mapSize.set(profile.shadowSize, profile.shadowSize); previewSun.shadow.normalBias = .025; previewSun.shadow.bias = -.0002; scene.add(previewSun); scene.add(previewSun.target);
    // Orbiting moves only the camera. Reuse shadows until scene geometry changes.
    previewSun.shadow.autoUpdate = false; previewSun.shadow.needsUpdate = true;
    const fill = new THREE.DirectionalLight(0xdce9f2, .5); fill.position.set(12, 10, -10); scene.add(fill);
    worldGroup = new THREE.Group(); scene.add(worldGroup);
    if (!previewInitialized) { fitPreview(); previewInitialized = true; }
  } catch (error) { disposePreviewRenderer(); renderer?.forceContextLoss(); previewUnavailable = true; releasePreviewPointer(); updatePreviewNavigation(); $('preview-error').hidden = false; translatedText('preview-error', '3D preview is unavailable in this browser. The 2D editor and JSON export still work. Try a browser with WebGL enabled.'); previewMetadata = { error: String(error.message) }; }
}
function previewFloors() { return $('all-floors').checked ? displayedProject().floors : [displayedFloor()]; }
function fitPreview() {
  const floors = previewFloors(), bounds = floors.map(floorBounds), minX = Math.min(...bounds.map(b => b.minX)), maxX = Math.max(...bounds.map(b => b.maxX)), minZ = Math.min(...bounds.map(b => b.minZ)), maxZ = Math.max(...bounds.map(b => b.maxZ));
  const low = Math.min(...floors.map(f => f.elevation_m)), high = Math.max(...floors.map(f => f.elevation_m + f.height_m));
  const verticalFov = 40 * Math.PI / 180, horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * size.width / size.height);
  const sphereRadius = Math.hypot(maxX - minX, maxZ - minZ, high - low) / 2;
  orbit.target.set((minX + maxX) / 2, (low + high) / 2, (minZ + maxZ) / 2);
  orbit.radius = Math.max(6, sphereRadius / Math.sin(Math.min(verticalFov, horizontalFov) / 2) * 1.12); orbit.baseRadius = orbit.radius;
  rebasePreviewGesture();
  if (view === 'preview' && renderer) requestCanvasRender();
}
function disposePreviewGeometry() {
  if (!worldGroup) return;
  const geometries = new Set(), materials = new Set();
  const dispose = (resource, seen) => { if (resource && !seen.has(resource)) { seen.add(resource); resource.dispose(); } };
  while (worldGroup.children.length) {
    const child = worldGroup.children[0]; worldGroup.remove(child);
    child.traverse(obj => { if (obj.isInstancedMesh) obj.dispose(); dispose(obj.geometry, geometries); if (Array.isArray(obj.material)) obj.material.forEach(material => dispose(material, materials)); else dispose(obj.material, materials); });
  }
}
function disposePreviewRenderer() {
  if (!renderer || previewRendererDisposed) return;
  disposePreviewGeometry();
  if (previewSun) { previewSun.shadow.dispose(); previewSun.shadow.map = null; previewSun.shadow.mapPass = null; }
  renderer.dispose(); previewRendererDisposed = true;
}
function instancePreviewCatalog(groups) {
  // Only batch disjoint opaque furniture. Overlaps retain their original draw
  // order, including coincident surfaces with different appearance variants.
  worldGroup.updateMatrixWorld(true);
  const catalog = new Set(groups), blocked = new Set();
  const bounds = worldGroup.children.map(object => ({ object, box: new THREE.Box3().setFromObject(object) }))
    .sort((a, b) => a.box.min.x - b.box.min.x);
  let comparisons = 0;
  for (let i = 0; i < bounds.length; i++) {
    const a = bounds[i];
    for (let j = i + 1; j < bounds.length && bounds[j].box.min.x < a.box.max.x; j++) {
      // Dense imported projects must not turn a draw optimization into a stall.
      if (++comparisons > 100000) return;
      const b = bounds[j];
      if (Math.min(a.box.max.x, b.box.max.x) - Math.max(a.box.min.x, b.box.min.x) > 1e-7 &&
          Math.min(a.box.max.y, b.box.max.y) - Math.max(a.box.min.y, b.box.min.y) > 1e-7 &&
          Math.min(a.box.max.z, b.box.max.z) - Math.max(a.box.min.z, b.box.min.z) > 1e-7) {
        if (catalog.has(a.object)) blocked.add(a.object);
        if (catalog.has(b.object)) blocked.add(b.object);
      }
    }
  }
  const batches = new Map();
  for (const group of groups) if (!blocked.has(group)) {
    for (const mesh of group.children) {
      if (!batches.has(mesh.geometry)) batches.set(mesh.geometry, []);
      batches.get(mesh.geometry).push(mesh);
    }
  }
  for (const meshes of batches.values()) if (meshes.length > 1) {
    const first = meshes[0], batch = new THREE.InstancedMesh(first.geometry, first.material, meshes.length);
    batch.name = first.name; batch.castShadow = first.castShadow; batch.receiveShadow = first.receiveShadow;
    meshes.forEach((mesh, index) => {
      batch.setMatrixAt(index, mesh.matrixWorld); mesh.removeFromParent();
      if (mesh !== first) mesh.material.dispose();
    });
    batch.instanceMatrix.needsUpdate = true; batch.computeBoundingBox(); batch.computeBoundingSphere();
    worldGroup.add(batch);
  }
  for (const group of groups) if (!group.children.length) worldGroup.remove(group);
}
function rebuildPreview() {
  disposePreviewGeometry();
  // Cached asset parts are immutable. Share their geometry only within this
  // rebuild; every mesh keeps its own material, transform and rendering order.
  const catalogGeometries = new Map(), catalogGroups = [];
  let wallMeshCount = 0, openingCount = 0, roomCount = 0, itemCount = 0, catalogItemCount = 0, itemMeshCount = 0;
  const box = (width, height, depth, position, color, rotation = 0, opacity = 1) => {
    const geometry = new THREE.BoxGeometry(width, height, depth), material = createPreviewMaterial({ color, roughness: .78, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
    const mesh = new THREE.Mesh(geometry, material); mesh.position.set(...position); mesh.rotation.y = rotation; mesh.castShadow = opacity >= 1; mesh.receiveShadow = true; worldGroup.add(mesh); return mesh;
  };
  for (const f of previewFloors()) {
    for (const r of f.rooms) {
      const shape = new THREE.Shape(); r.polygon.forEach((p, i) => { if (i) shape.lineTo(p[0], -p[1]); else shape.moveTo(p[0], -p[1]); }); shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: .08, bevelEnabled: false }); geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, createPreviewMaterial({ color: COLORS[r.material], roughness: .9 })); mesh.position.y = f.elevation_m - .08; mesh.receiveShadow = true; mesh.castShadow = true; worldGroup.add(mesh); roomCount++;
    }
    for (const wall of f.walls) {
      const len = distance(wall.start, wall.end), dx = (wall.end[0] - wall.start[0]) / len, dz = (wall.end[1] - wall.start[1]) / len, angle = -Math.atan2(dz, dx);
      for (const piece of wallPieces(wall, f.openings, f.height_m)) {
        const center = piece.offset + piece.width / 2;
        box(piece.width, piece.height, wall.thickness_m, [wall.start[0] + dx * center, f.elevation_m + piece.bottom + piece.height / 2, wall.start[1] + dz * center], '#f5f2e8', angle); wallMeshCount++;
      }
      for (const o of f.openings.filter(o => o.wall_id === wall.id)) {
        openingCount++;
        if (o.type === 'window') {
          const mid = o.offset_m + o.width_m / 2;
          box(o.width_m, o.head_m - o.sill_m, .018, [wall.start[0] + dx * mid, f.elevation_m + (o.sill_m + o.head_m) / 2, wall.start[1] + dz * mid], '#9fc9ce', angle, .22);
        }
      }
    }
    for (const item of f.items) {
      const p = item.position_m, d = item.dimensions_m, rotation = item.rotation_deg * Math.PI / 180;
      const asset = itemAsset(item); itemCount++;
      if (asset) {
        const group = new THREE.Group(); group.position.set(p.x, f.elevation_m + p.y, p.z); group.rotation.y = rotation; group.scale.set(d.width, d.height, d.depth);
        for (const part of asset.meshes) {
          let geometry = catalogGeometries.get(part);
          if (!geometry) {
            geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(part.vertices.flat(), 3)); geometry.setAttribute('normal', new THREE.Float32BufferAttribute(part.normals.flat(), 3)); geometry.setIndex(part.indices);
            catalogGeometries.set(part, geometry);
          }
          const material = createPreviewMaterial({ color: new THREE.Color(...asset.materials[part.material].slice(0, 3)), roughness: .78 });
          const mesh = new THREE.Mesh(geometry, material); mesh.name = part.name; mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); itemMeshCount++;
        }
        worldGroup.add(group); catalogGroups.push(group); catalogItemCount++; continue;
      }
      box(d.width, d.height, d.depth, [p.x, f.elevation_m + p.y + d.height / 2, p.z], COLORS[item.type], rotation); itemMeshCount++;
      if (item.type === 'tv') {
        const forward = new THREE.Vector3(0, 0, d.depth / 2 + .001).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotation);
        box(d.width * .92, d.height * .88, .008, [p.x + forward.x, f.elevation_m + p.y + d.height / 2, p.z + forward.z], '#344c54', rotation);
        itemMeshCount++;
      }
    }
  }
  const floors = previewFloors(), bounds = floors.map(floorBounds), minX = Math.min(...bounds.map(b => b.minX)), maxX = Math.max(...bounds.map(b => b.maxX)), minZ = Math.min(...bounds.map(b => b.minZ)), maxZ = Math.max(...bounds.map(b => b.maxZ));
  const low = Math.min(...floors.map(f => f.elevation_m)), high = Math.max(...floors.map(f => f.elevation_m + f.height_m)), span = Math.max(12, maxX - minX, maxZ - minZ, high - low), cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  previewSun.position.set(cx - span * .6, high + span * 1.3, cz + span * .5); previewSun.target.position.set(cx, low, cz);
  Object.assign(previewSun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: .1, far: span * 5 + 100 }); previewSun.shadow.camera.updateProjectionMatrix();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(span * 8, span * 8), new THREE.ShadowMaterial({ color: '#54654c', opacity: .14 })); ground.rotation.x = -Math.PI / 2; ground.position.set(cx, low - .081, cz); ground.receiveShadow = true; worldGroup.add(ground);
  if (previewInstancing) instancePreviewCatalog(catalogGroups);
  let meshCount = 0; worldGroup.traverse(object => { if (object.isMesh) meshCount++; });
  previewMetadata = { floors: previewFloors().map(f => f.id), rooms: roomCount, wallSolidPieces: wallMeshCount, openings: openingCount, items: itemCount, catalogItems: catalogItemCount, itemMeshes: itemMeshCount, meshes: meshCount, renderCount: previewMetadata.renderCount || 0 };
  previewSun.shadow.needsUpdate = true;
  previewDirty = false;
}
function drawPreview() {
  if (!renderer || previewLost || previewUnavailable || view !== 'preview' || canvasSuspended || document.hidden) return;
  cancelCanvasRender();
  const width = size.width, height = size.height, ratio = canvasPixelRatio(width, height, previewPixels), nextSize = [width, height, ratio].join();
  // Setting canvas dimensions, even to the same values, resets its drawing buffer.
  if (nextSize !== previewSize) { renderer.setDrawingBufferSize(width, height, ratio); previewSize = nextSize; camera.aspect = width / height; camera.updateProjectionMatrix(); }
  const horiz = Math.cos(orbit.pitch) * orbit.radius; camera.position.set(orbit.target.x + Math.cos(orbit.yaw) * horiz, orbit.target.y + Math.sin(orbit.pitch) * orbit.radius, orbit.target.z + Math.sin(orbit.yaw) * horiz); camera.lookAt(orbit.target); renderer.render(scene, camera); previewMetadata.renderCount = (previewMetadata.renderCount || 0) + 1;
  const corners = previewFloors().flatMap(f => {
    const b = floorBounds(f), out = [];
    for (const x of [b.minX, b.maxX]) for (const z of [b.minZ, b.maxZ]) for (const y of [f.elevation_m, f.elevation_m + f.height_m]) out.push(new THREE.Vector3(x, y, z).project(camera));
    return out;
  });
  previewMetadata.projectedBounds = { minX: Math.min(...corners.map(p => p.x)), maxX: Math.max(...corners.map(p => p.x)), minY: Math.min(...corners.map(p => p.y)), maxY: Math.max(...corners.map(p => p.y)) };
  previewMetadata.viewport = { width, height };
  previewMetadata.camera = { yaw: orbit.yaw, pitch: orbit.pitch, radius: orbit.radius, target: { x: orbit.target.x, y: orbit.target.y, z: orbit.target.z }, mode: orbit.mode };
  updateZoom();
}
function renderPreview() { if (view !== 'preview' || canvasSuspended || document.hidden || previewLost) return; initPreview(); if (!renderer || previewUnavailable) return; if (previewDirty) rebuildPreview(); drawPreview(); }
function zoomPreview(factor) {
  if (!canNavigatePreview() || !Number.isFinite(factor) || factor <= 0) return;
  const radius = previewRadius(orbit.radius / factor);
  if (radius === orbit.radius) return;
  orbit.radius = radius; rebasePreviewGesture(); requestCanvasRender();
}
let previewCanvas = $('preview-canvas'), previewEvents;
function canNavigatePreview() { return view === 'preview' && !previewLost && !previewUnavailable && !canvasSuspended && !document.hidden; }
function previewRadius(value) { return Math.max(1, Math.min(600, value)); }
function previewPitch(value) { return Math.max(.1, Math.min(Math.PI / 2 - .001, value)); }
function previewYaw(value) {
  if (value >= -Math.PI && value <= Math.PI) return value;
  const turn = Math.PI * 2;
  return ((value + Math.PI) % turn + turn) % turn - Math.PI;
}
function previewHint() {
  return t(orbit.mode === 'pan' ? 'Drag to pan · scroll to zoom · arrow keys to move' : 'Drag to orbit · right-drag or Shift-drag to pan · scroll to zoom');
}
function updatePreviewNavigation() {
  const unavailable = previewLost || previewUnavailable;
  const navigation = $('preview-navigation');
  if (navigation) navigation.hidden = view !== 'preview' || unavailable;
  for (const mode of ['orbit', 'pan']) {
    const control = $(`preview-${mode}`);
    if (control) control.setAttribute('aria-pressed', String(orbit.mode === mode));
  }
  for (const name of ['orbit', 'pan', 'top', 'rotate-left', 'rotate-right']) {
    const control = $(`preview-${name}`);
    if (control) control.disabled = unavailable;
  }
  previewCanvas.dataset.navigationMode = orbit.mode;
  previewCanvas.dataset.navigating = String(orbit.pointers.size > 0);
  previewCanvas.style.cursor = orbit.pointers.size ? 'grabbing' : 'grab';
}
function setPreviewMode(mode) {
  if (!canNavigatePreview()) return;
  releasePreviewPointer(); orbit.mode = mode; updatePreviewNavigation();
  if (previewMetadata.camera) previewMetadata.camera.mode = mode;
  $('tool-hint').textContent = previewHint();
}
function resetPreview() {
  if (!canNavigatePreview()) return;
  releasePreviewPointer(); orbit.yaw = -Math.PI / 3; orbit.pitch = .8; fitPreview(); requestCanvasRender();
}
function topPreview() {
  if (!canNavigatePreview()) return;
  releasePreviewPointer(); orbit.yaw = -Math.PI / 2; orbit.pitch = previewPitch(Math.PI / 2); requestCanvasRender();
}
function rotatePreview(angle) {
  if (!canNavigatePreview()) return;
  releasePreviewPointer(); orbit.yaw = previewYaw(orbit.yaw + angle); requestCanvasRender();
}
function previewPointerCenter() {
  const points = [...orbit.pointers.values()], first = points[0], second = points[1];
  return second ? { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2, distance: Math.hypot(first.x - second.x, first.y - second.y) }
    : { x: first.x, y: first.y, distance: 0 };
}
function rebasePreviewGesture() {
  if (!orbit.pointers.size) { orbit.gesture = null; return; }
  orbit.gesture = { ...previewPointerCenter(), yaw: orbit.yaw, pitch: orbit.pitch, radius: orbit.radius, target: orbit.target.clone(),
    mode: orbit.pointers.size > 1 ? 'pan' : orbit.pointers.values().next().value.mode };
}
function panPreview(dx, dy, origin = orbit) {
  // Screen-plane movement keeps dragging predictable at any zoom or heading,
  // including the top view. No world geometry or editing coordinates change.
  const scale = 2 * origin.radius * Math.tan(20 * Math.PI / 180) / Math.max(1, size.height);
  const sin = Math.sin(origin.yaw), cos = Math.cos(origin.yaw), tilt = Math.sin(origin.pitch);
  orbit.target.set(origin.target.x + (-sin * dx - cos * tilt * dy) * scale,
    origin.target.y + Math.cos(origin.pitch) * dy * scale,
    origin.target.z + (cos * dx - sin * tilt * dy) * scale);
}
function releasePreviewPointer(event) {
  const ids = event ? [event.pointerId] : [...orbit.pointers.keys()];
  for (const id of ids) {
    // Delete first: releasing capture can synchronously emit lostpointercapture.
    if (!orbit.pointers.delete(id)) continue;
    if (previewCanvas.hasPointerCapture(id)) previewCanvas.releasePointerCapture(id);
  }
  rebasePreviewGesture(); updatePreviewNavigation();
}
function bindPreviewCanvas() {
  previewEvents = new AbortController();
  const canvas = previewCanvas, options = { signal: previewEvents.signal };
  updatePreviewNavigation();
  canvas.addEventListener('pointerdown', e => {
    if (!canNavigatePreview() || ![0, 1, 2].includes(e.button) || orbit.pointers.has(e.pointerId)) return;
    const touch = e.pointerType === 'touch';
    // At most two touches participate; mixed devices never replace an active drag.
    if (orbit.pointers.size && (!touch || orbit.pointers.size >= 2 || !orbit.pointers.values().next().value.touch)) return;
    e.preventDefault(); canvas.focus({ preventScroll: true });
    const mode = e.button === 1 || e.button === 2 || e.shiftKey || spaceHeld ? 'pan' : orbit.mode;
    orbit.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, mode, touch });
    canvas.setPointerCapture(e.pointerId);
    rebasePreviewGesture(); updatePreviewNavigation();
  }, options);
  canvas.addEventListener('pointermove', e => {
    const pointer = orbit.pointers.get(e.pointerId);
    if (!pointer || !canNavigatePreview()) return;
    if (!pointer.touch && e.buttons === 0) { releasePreviewPointer(e); return; }
    if (pointer.x === e.clientX && pointer.y === e.clientY) return;
    e.preventDefault(); pointer.x = e.clientX; pointer.y = e.clientY;
    const center = previewPointerCenter(), start = orbit.gesture, dx = center.x - start.x, dy = center.y - start.y;
    if (start.mode === 'pan') panPreview(dx, dy, start);
    else { orbit.yaw = previewYaw(start.yaw - dx * .007); orbit.pitch = previewPitch(start.pitch + dy * .007); }
    if (orbit.pointers.size === 2 && start.distance > 0 && center.distance > 0) orbit.radius = previewRadius(start.radius * start.distance / center.distance);
    requestCanvasRender();
  }, options);
  canvas.addEventListener('pointerup', releasePreviewPointer, options);
  canvas.addEventListener('lostpointercapture', releasePreviewPointer, options);
  canvas.addEventListener('pointercancel', e => { if (orbit.pointers.has(e.pointerId)) releasePreviewPointer(); }, options);
  canvas.addEventListener('contextmenu', e => { if (canNavigatePreview()) e.preventDefault(); }, options);
  canvas.addEventListener('wheel', e => {
    if (!canNavigatePreview() || e.ctrlKey || e.metaKey || !e.deltaY) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? Math.max(1, size.height) : 1;
    zoomPreview(Math.exp(Math.max(-1, Math.min(1, -e.deltaY * unit * .0015))));
  }, { ...options, passive: false });
  canvas.addEventListener('keydown', e => {
    if (!canNavigatePreview() || e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (!['arrowleft', 'arrowright', 'arrowup', 'arrowdown', '+', '=', '-', 'home', 't', 'o', 'p', 'escape'].includes(key)) return;
    e.preventDefault(); e.stopPropagation(); releasePreviewPointer();
    if (key === 'home') { resetPreview(); return; }
    if (key === 't') { topPreview(); return; }
    if (key === 'o' || key === 'p') { setPreviewMode(key === 'o' ? 'orbit' : 'pan'); return; }
    if (key === 'escape') return;
    if (key === '+' || key === '=') { zoomPreview(1.15); return; }
    if (key === '-') { zoomPreview(1 / 1.15); return; }
    if (e.shiftKey || orbit.mode === 'pan') panPreview(key === 'arrowleft' ? 30 : key === 'arrowright' ? -30 : 0, key === 'arrowup' ? 30 : key === 'arrowdown' ? -30 : 0);
    else {
      if (key === 'arrowleft') orbit.yaw = previewYaw(orbit.yaw - .12); if (key === 'arrowright') orbit.yaw = previewYaw(orbit.yaw + .12);
      if (key === 'arrowup') orbit.pitch = previewPitch(orbit.pitch + .1); if (key === 'arrowdown') orbit.pitch = previewPitch(orbit.pitch - .1);
    }
    requestCanvasRender();
  }, options);
  canvas.addEventListener('webglcontextlost', e => {
    e.preventDefault(); previewLost = true; cancelCanvasRender(); releasePreviewPointer();
    // Release old scene callbacks and Three's context listeners while GL is
    // lost. Nothing from this renderer may run against a restored context.
    disposePreviewRenderer(); previewDirty = true;
    // This canvas will be retired after restoration. Keep its restored native
    // drawing buffer minimal instead of allocating the full preview twice.
    canvas.width = 0; canvas.height = 0;
    $('preview-error').hidden = false; translatedText('preview-error', 'The graphics context was lost. Reload to restore 3D. Your local draft and JSON export remain available.');
  }, options);
  canvas.addEventListener('webglcontextrestored', () => {
    if (!previewLost) return;
    const retired = renderer, focused = document.activeElement === canvas;
    previewEvents.abort();
    // A new canvas guarantees a new native context, not just new Three caches.
    // The old renderer has already been disposed while its context was lost.
    const replacement = canvas.cloneNode(false);
    replacement.width = 0; replacement.height = 0;
    canvas.replaceWith(replacement); previewCanvas = replacement; bindPreviewCanvas();
    renderer = scene = camera = worldGroup = previewSun = null;
    previewLost = false; previewSize = ''; previewDirty = true;
    updatePreviewNavigation();
    // Retire the detached context before the next frame creates its replacement.
    // Its loss is intentional cleanup; no app handlers remain on that canvas.
    retired?.forceContextLoss();
    $('preview-error').hidden = true;
    resizeCanvases(document.querySelector('.canvas-shell').getBoundingClientRect());
    if (focused) previewCanvas.focus({ preventScroll: true });
    requestCanvasRender();
  }, options);
}
bindPreviewCanvas();
for (const mode of ['orbit', 'pan']) $(`preview-${mode}`)?.addEventListener('click', () => setPreviewMode(mode));
$('preview-top')?.addEventListener('click', topPreview);
$('preview-rotate-left')?.addEventListener('click', () => rotatePreview(-Math.PI / 4));
$('preview-rotate-right')?.addEventListener('click', () => rotatePreview(Math.PI / 4));

// Project actions and keyboard navigation.
function exportProject() {
  try { validateProject(project); const blob = new Blob([serializeProject(project)], { type: 'application/json' }), url = URL.createObjectURL(blob), a = node('a'); a.href = url; a.download = 'project.json'; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); status(() => t('project.json exported. Keep it as your portable, editable backup.')); }
  catch (error) { status(() => t('Could not export project: {error}', { error: formatValidationError(error, t) }), true); }
}
function hasContent() { return project.floors.length > 1 || project.floors.some(f => ['rooms', 'walls', 'openings', 'items'].some(k => f[k].length)); }
$('new-project').addEventListener('click', () => { if (!hasContent() || confirm(t('Start a new blank project? Export JSON first if you need a separate copy of the current plan. You can undo this.'))) replaceProject(blankProject(), () => t('New blank project created.')); });
$('open-project').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  try {
    if (file.size > LIMITS.bytes) throw new Error(t('Project file is too large. Maximum size is 2 MB.'));
    const parsed = JSON.parse(await file.text()); validateProject(parsed);
    if (hasContent() && !confirm(t('Open this project and replace the current plan? Export the current plan first if needed. You can undo this.'))) return;
    await replaceProject(parsed, () => t('Project opened and validated.'));
  } catch (error) { status(() => t('Import rejected: {error} Your current plan is unchanged.', { error: formatValidationError(error, t) }), true); }
});
$('export-project').addEventListener('click', exportProject); $('build-export').addEventListener('click', exportProject);
function renderRecovery() {
  try {
    recoverySnapshot = draftStorage.inspect();
    const changed = draftStorage.changed();
    $('recovery-message').textContent = t(recoverySnapshot.error ? 'The saved draft could not be opened. Its original data is kept for recovery.' : changed === 'conflict' ? 'Another tab changed the saved draft. Export your version or choose which draft to keep.' : changed === 'unavailable' ? 'Autosave unavailable · export a backup' : 'Drafts stay in this browser. Export to keep a copy.');
    $('recovery-current').textContent = recoverySnapshot.current?.title || '—';
    $('recovery-previous').textContent = recoverySnapshot.previous?.title || t('No previous project is available.');
    $('recovery-load').disabled = !recoverySnapshot.current;
    $('recovery-restore').disabled = !recoverySnapshot.previous;
    $('recovery-original').disabled = recoverySnapshot.damaged === null;
    $('recovery-replace').disabled = false;
  } catch (error) {
    recoverySnapshot = null; showDraftProblem({ status: 'unavailable', error });
    $('recovery-message').textContent = t('Autosave unavailable · export a backup');
    for (const id of ['recovery-load', 'recovery-restore', 'recovery-original', 'recovery-replace']) $(id).disabled = true;
  }
  if (recoveryBusy) for (const control of $('recovery-dialog').querySelectorAll('button')) control.disabled = true;
  else { $('recovery-export').disabled = false; $('recovery-dialog').querySelector('[data-close]').disabled = false; }
}
$('draft-recovery').addEventListener('click', () => { renderRecovery(); $('recovery-dialog').showModal(); });
$('recovery-export').addEventListener('click', exportProject);
$('recovery-original').addEventListener('click', () => {
  if (recoverySnapshot?.damaged === null || !recoverySnapshot) return;
  const url = URL.createObjectURL(new Blob([recoverySnapshot.damaged], { type: 'application/octet-stream' }));
  const link = node('a'); link.href = url; link.download = 'original-draft.json'; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
async function recoverDraft(action) {
  const snapshot = recoverySnapshot;
  if (!snapshot || recoveryBusy) return;
  recoveryBusy = true;
  for (const control of $('recovery-dialog').querySelectorAll('button')) control.disabled = true;
  pendingSaves++;
  let result;
  try {
    if (action === 'load') result = await draftStorage.load(snapshot, serializeProject(project));
    else if (action === 'restore') result = await draftStorage.save(snapshot.previousRaw, { replace: snapshot });
    else result = await draftStorage.save(serializeProject(project), { replace: snapshot });
    if (result.status === 'saved') {
      if (action !== 'replace') installRecoveredProject(action === 'load' ? result.current : snapshot.previous);
      saveFailed = false; translatedText('save-status', 'Saved in this browser'); $('save-status').classList.remove('problem');
      status(() => t('Restored your local draft.')); $('recovery-dialog').close();
    } else showDraftProblem(result);
  } catch (error) { showDraftProblem({ status: 'unavailable', error }); }
  finally { pendingSaves--; recoveryBusy = false; renderRecovery(); }
}
$('recovery-dialog').addEventListener('cancel', event => { if (recoveryBusy) event.preventDefault(); });
$('recovery-load').addEventListener('click', () => recoverDraft('load'));
$('recovery-restore').addEventListener('click', () => recoverDraft('restore'));
$('recovery-replace').addEventListener('click', () => recoverDraft('replace'));
window.addEventListener('storage', event => {
  if (event.key !== null && ![DRAFT_KEY, PREVIOUS_KEY, DAMAGED_KEY].includes(event.key)) return;
  const problem = draftStorage.changed();
  if (problem) showDraftProblem({ status: problem });
  if ($('recovery-dialog').open) renderRecovery();
});

$('project-title').addEventListener('change', e => transact(p => { p.title = e.target.value; }, () => t('Project renamed.')));
$('add-floor').addEventListener('click', () => {
  if (project.floors.length >= LIMITS.floors) return status(() => t('A project supports up to {count} floors.', { count: LIMITS.floors }), true);
  let index = 2; while (project.floors.some(f => f.id === `floor_${index}`)) index++;
  const previousId = activeFloorId, id = `floor_${index}`, next = newFloor(id, `Floor ${index}`, round(floor().elevation_m + floor().height_m + .25));
  const ok = transact(p => { p.floors.push(next); }, () => t('New floor added. Set its name and elevation in the inspector.'));
  if (ok) { activeFloorId = id; selection = null; previewDirty = true; editorChanged(); renderUI(); fitPlan(); fitPreview(); renderPlan(); } else activeFloorId = previousId;
});
document.querySelectorAll('[data-tool]').forEach(b => { const label = b.querySelector('span:nth-child(2)').textContent; b.setAttribute('aria-label', label); b.title = label; b.addEventListener('click', () => { setTool(b.dataset.tool); }); });
$('place-type').addEventListener('change', () => { placementModelId = null; updatePlacement(); setTool('item'); renderInspector(); });
$('browse-items').addEventListener('click', openLibrary);
function renderCategories() {
  const selectedCategory = $('library-category').value;
  $('library-category').replaceChildren();
  const all = node('option', '', t('All categories')); all.value = ''; $('library-category').append(all);
  for (const category of CATALOG.categories) { const option = node('option', '', t(`category.${category.id}`)); option.value = category.id; $('library-category').append(option); }
  $('library-category').value = selectedCategory;
}
renderCategories();
$('library-search').addEventListener('input', () => renderLibrary());
$('library-category').addEventListener('change', () => renderLibrary());
$('library-more').addEventListener('click', () => renderLibrary(true));
$('library-clear').addEventListener('click', () => { $('library-search').value = ''; $('library-category').value = ''; renderLibrary(); $('library-search').focus(); });
$('undo').addEventListener('click', () => undo()); $('redo').addEventListener('click', () => undo(true));
$('plan-tab').addEventListener('click', () => setView('plan')); $('preview-tab').addEventListener('click', () => setView('preview'));
for (const tab of [$('plan-tab'), $('preview-tab')]) tab.addEventListener('keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setView(view === 'plan' ? 'preview' : 'plan'); (view === 'plan' ? $('plan-tab') : $('preview-tab')).focus(); } });
$('all-floors').addEventListener('change', () => { previewDirty = true; fitPreview(); renderPreview(); });
$('fit-view').addEventListener('click', () => { if (view === 'preview') resetPreview(); else { fitPlan(); renderPlan(); } });
$('zoom-in').addEventListener('click', () => view === 'plan' ? zoomPlan(1.2) : zoomPreview(1.2)); $('zoom-out').addEventListener('click', () => view === 'plan' ? zoomPlan(1 / 1.2) : zoomPreview(1 / 1.2));
$('help-button').addEventListener('click', () => $('help-dialog').showModal());
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => $(b.dataset.close).close()));
$('build-project').addEventListener('click', () => {
  const label = $('build-validation');
  try { validateProject(project, { complete: true }); label.className = 'callout'; buildValidationText = () => t('Your project passes the editor checks and is ready to export. The compiler performs its own final validation.'); label.textContent = buildValidationText(); }
  catch (error) { label.className = 'callout error'; buildValidationText = () => t('Before building: {error} You can still export this draft.', { error: formatValidationError(error, t) }); label.textContent = buildValidationText(); }
  $('build-dialog').showModal();
});
$('copy-command').addEventListener('click', async () => { try { await navigator.clipboard.writeText(BUILD_COMMAND); translatedText('copy-command', 'Copied'); } catch { translatedText('copy-command', 'Select and copy the command above'); } });
window.addEventListener('keydown', e => {
  if (e.defaultPrevented) return;
  if (e.target.closest('input, textarea, select') || document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') { finishPointer(null, true); setSelection(null); setTool('select'); renderUI(); renderPlan(); return; }
  if (e.code === 'Space' && (e.target === planCanvas || e.target === previewCanvas || e.target === document.body)) { e.preventDefault(); spaceHeld = true; if (view === 'plan') planCanvas.style.cursor = 'grab'; }
  if (e.ctrlKey || e.metaKey) {
    if (e.key.toLowerCase() === 'z') { e.preventDefault(); undo(e.shiftKey); }
    if (e.key.toLowerCase() === 'y') { e.preventDefault(); undo(true); }
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') { if (selection) { e.preventDefault(); deleteSelection(); } return; }
  const shortcuts = { v: 'select', r: 'room', w: 'wall', d: 'door', n: 'window', i: 'item' }; if (shortcuts[e.key.toLowerCase()]) setTool(shortcuts[e.key.toLowerCase()]);
  if (view === 'plan' && e.target === planCanvas) {
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomPlan(1.15); } if (e.key === '-') { e.preventDefault(); zoomPlan(1 / 1.15); }
    if (e.key.startsWith('Arrow')) { e.preventDefault(); map.x += e.key === 'ArrowLeft' ? 30 : e.key === 'ArrowRight' ? -30 : 0; map.y += e.key === 'ArrowUp' ? 30 : e.key === 'ArrowDown' ? -30 : 0; renderPlan(); }
  }
});
window.addEventListener('keyup', e => { if (e.code === 'Space') { spaceHeld = false; planCanvas.style.cursor = tool === 'select' ? 'default' : 'crosshair'; } });
window.addEventListener('blur', () => { spaceHeld = false; releasePreviewPointer(); if (drag) finishPointer(null, true); });
window.addEventListener('beforeunload', e => { if ((saveFailed || pendingSaves) && hasContent()) { e.preventDefault(); e.returnValue = ''; } });
let firstResize = true, planSize = '';
function resizeCanvases(rect) {
  if (rect.width < 1 || rect.height < 1) return;
  const old = { ...size }; size = { width: rect.width, height: rect.height };
  const dpr = canvasPixelRatio(size.width, size.height, 4000000), nextSize = [size.width, size.height, dpr].join();
  if (!canvasSuspended && !document.hidden && nextSize !== planSize) {
    // Release the old bitmap before changing orientation: mixing old height
    // and new width can otherwise exceed the budget during the resize itself.
    planCanvas.width = 0; planCanvas.height = Math.floor(size.height * dpr); planCanvas.width = Math.floor(size.width * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); planSize = nextSize;
  }
  if (firstResize) { firstResize = false; fitPlan(); } else { map.x += (size.width - old.width) / 2; map.y += (size.height - old.height) / 2; }
  if (view === 'preview') {
    const ratio = orbit.baseRadius / orbit.radius, target = orbit.target.clone();
    fitPreview(); orbit.radius = orbit.baseRadius / ratio;
    // Layout changes retain the user's framing. Continue a captured gesture
    // from this viewport rather than applying its former size and camera pose.
    orbit.target.set(target.x, target.y, target.z); rebasePreviewGesture();
  }
  requestCanvasRender();
}
const canvasObserver = new ResizeObserver(entries => resizeCanvases(entries[0].contentRect));
canvasObserver.observe(document.querySelector('.canvas-shell'));
document.addEventListener('visibilitychange', () => { if (document.hidden) { spaceHeld = false; releasePreviewPointer(); cancelCanvasRender(); } else { resizeCanvases(document.querySelector('.canvas-shell').getBoundingClientRect()); requestCanvasRender(); } });
window.addEventListener('pagehide', event => {
  canvasSuspended = true; releasePreviewPointer(); cancelCanvasRender();
  if (!event.persisted) { canvasObserver.disconnect(); previewEvents.abort(); releasePreviewPointer(); floorNavigator.destroy(); disposePreviewRenderer(); renderer?.forceContextLoss(); }
});
window.addEventListener('pageshow', () => { canvasSuspended = false; resizeCanvases(document.querySelector('.canvas-shell').getBoundingClientRect()); requestCanvasRender(); });
window.planner = Object.freeze({ getProject: () => clone(project), getPreviewMetadata: () => ({ ...previewMetadata }), getView: () => view, getSelection: () => selection && { ...selection }, worldToScreen: point => toScreen(point), validate: () => validateProject(clone(project), { complete: true }) });
updatePlacement(); renderUI(); fitPlan(); renderPlan();
if (startupMessage) status(startupMessage, saveFailed);
if (saveFailed) { translatedText('save-status', 'Draft restore unavailable · export a backup'); $('save-status').classList.add('problem'); } else translatedText('save-status', startupMessage ? 'Restored from this browser' : 'Local draft · export to keep a copy');

function renderLocale() {
  // Switching a presentation preference must not discard an unfinished form.
  const drafts = [...$('inspector-body').querySelectorAll('input,select,textarea')].map(input => ({ value: input.value, checked: input.checked, draft: input.inspectorDraft, invalid: input.getAttribute('aria-invalid') }));
  translateStatic();
  $('language-select').value = getLocale();
  document.querySelectorAll('[data-tool]').forEach(element => {
    const label = element.querySelector('span:nth-child(2)').textContent;
    element.setAttribute('aria-label', label); element.title = label;
  });
  renderCategories(); updatePlacement(); renderUI(); renderPlan();
  [...$('inspector-body').querySelectorAll('input,select,textarea')].forEach((input, index) => {
    if (drafts[index]) {
      input.value = drafts[index].value; input.inspectorDraft = drafts[index].draft;
      if (drafts[index].invalid) input.setAttribute('aria-invalid', drafts[index].invalid);
      if (input.type === 'checkbox') input.checked = drafts[index].checked;
    }
  });
  if (view === 'preview') $('tool-hint').textContent = previewHint();
  if ($('library-dialog').open) renderLibrary();
  if (buildValidationText) $('build-validation').textContent = buildValidationText();
  if ($('recovery-dialog').open) renderRecovery();
  if (lastStatus) status(lastStatus.message, lastStatus.error);
}
for (const locale of LOCALES) {
  const option = node('option', '', locale.name); option.value = locale.code; option.lang = locale.code;
  $('language-select').append(option);
}
onLocaleChange(({ loaded }) => {
  renderLocale();
  if (!loaded) status(() => t('Language could not be loaded. English is shown instead.'), true);
});
$('language-select').addEventListener('change', async event => {
  const result = await setLocale(event.target.value);
  if (result.applied) {
    // A manual choice replaces the language in a deep link for the next reload.
    try {
      const url = new URL(location.href); url.searchParams.set('lang', result.locale);
      window.history.replaceState(window.history.state, '', url);
    } catch { /* Restricted hosts may deny history without blocking language changes. */ }
  }
});
renderLocale();
installOnboarding({
  t, getFloor: floor, hasContent, replaceProject, validateProject, status, onLocaleChange,
  createRoom(options) {
    const ok = transact((_p, target) => { selection = { kind: 'rooms', id: addMeasuredRoom(target, options) }; },
      () => options.walls ? t('Room ready. Add a door or an item, then preview and export.') : t('Room added. Choose Build wall outline to create its walls.'), { fit: true });
    if (ok) { setView('plan'); setTool('select'); }
    return { ok, error: !ok && lastStatus ? (typeof lastStatus.message === 'function' ? lastStatus.message() : lastStatus.message) : '' };
  },
  preview() { setView('preview'); $('preview-tab').focus(); },
  draw() { setTool('room'); planCanvas.focus(); },
  focusPlan() { planCanvas.focus(); },
});
if (!initialLocale.loaded) status(() => t('Language could not be loaded. English is shown instead.'), true);


// A narrow, opt-in bridge. Snapshots are copies; preview never replaces accepted
// state. The revision includes selection and in-progress moves, preventing late
// results from changing a different room or overwriting an intervening edit.
export const editorBridge = Object.freeze({
  snapshot: () => clone(project),
  revision: () => editorRevision,
  selectionContext: () => ({ floorId: activeFloorId, roomId: selection?.kind === 'rooms' ? selection.id : selection?.kind === 'items' ? selected()?.room : null }),
  subscribe(listener) { editorListeners.add(listener); return () => editorListeners.delete(listener); },
  previewProject(candidate) {
    validateProject(candidate); serializeProject(candidate); candidatePreview = clone(candidate); previewDirty = true;
    $('empty-state').hidden = true; fitPlan(); fitPreview(); requestCanvasRender();
  },
  cancelPreview() {
    if (!candidatePreview) return;
    candidatePreview = null; previewDirty = true; setView(view); requestCanvasRender();
  },
  applyProject(candidate, baseRevision) {
    if (baseRevision !== editorRevision || drag) throw new Error('The plan or selection changed. Generate a fresh draft.');
    validateProject(candidate); serializeProject(candidate);
    candidatePreview = null;
    const next = clone(candidate);
    return transact(draft => { for (const key of Object.keys(draft)) delete draft[key]; Object.assign(draft, next); }, 'AI draft applied. Undo restores your previous plan.', { fit: true });
  },
});
