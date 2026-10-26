// Detached, additive AI proposals. No provider output is a project or executable recipe.
import { CATALOG, PATTERNS, getCatalogModel, getCatalogStyle, supportsFurniturePattern, validateFurnitureAppearance } from '../planner/furniture.js';
import { LIMITS, clone, distance, nextId, outlineRoom, pointInPolygon, validateProject } from '../planner/model.js';
import { createSite, nextSiteId, SITE_KINDS, SITE_LIMITS, validateSite } from '../planner/site-model.js';
import { parseDraftJSON } from './json.js';

export { parseDraftJSON } from './json.js';
const EPS = 1e-8;
const MODES = ['furnish_room', 'new_room', 'site'];
const trustedContexts = new WeakMap();
const ITEM_FIELDS = ['candidate_key', 'name', 'model_id', 'style_id', 'position_m', 'dimensions_m', 'rotation_deg', 'evidence'];
const APPEARANCE_FIELDS = ['color', 'pattern_id', 'pattern_color'];
const OPENING_FIELDS = ['candidate_key', 'edge_index', 'offset_m', 'width_m', 'sill_m', 'head_m', 'type'];
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']);
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const equal = (a, b) => distance(a, b) < EPS;

function fields(value, required, label, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error(`${label} contains unknown fields.`);
  if (required.some(key => !Object.hasOwn(value, key))) throw new Error(`${label} has missing required fields.`);
}
function number(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be a finite number from ${min} to ${max}.`);
  return value;
}
function text(value, max, label, empty = false) {
  if (typeof value !== 'string' || [...value].length > max || (!empty && !value.trim()) || [...value].some(char => char.codePointAt(0) < 32 || char.codePointAt(0) >= 0xd800 && char.codePointAt(0) <= 0xdfff)) throw new Error(`${label} must be valid ${empty ? '' : 'nonempty '}text of at most ${max} characters.`);
  return value;
}
function key(value) {
  if (typeof value !== 'string' || !KEY.test(value) || RESERVED.has(value)) throw new Error('Candidate keys must be safe identifiers.');
  return value;
}
function array(value, max, label) {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be an array of at most ${max} entries.`);
  return value;
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function serializeProject(project) {
  const serialized = JSON.stringify(project);
  if (new TextEncoder().encode(serialized).length > LIMITS.bytes) throw new Error('Project would exceed the 2 MB limit (2,000,000 UTF-8 bytes).');
  return serialized;
}
function itemDescriptor(item) {
  return { name: item.name, ...(item.model_id ? { model_id: item.model_id } : {}), ...(item.style_id ? { style_id: item.style_id } : {}),
    position_m: { ...item.position_m }, dimensions_m: { ...item.dimensions_m }, rotation_deg: item.rotation_deg,
    ...Object.fromEntries(APPEARANCE_FIELDS.filter(field => Object.hasOwn(item, field)).map(field => [field, item[field]])) };
}
function edgeWall(floor, start, end) {
  return floor.walls.find(wall => equal(wall.start, start) && equal(wall.end, end) || equal(wall.end, start) && equal(wall.start, end));
}
function rectangle(measurements, origin) {
  return [[origin.x, origin.z], [origin.x + measurements.width, origin.z], [origin.x + measurements.width, origin.z + measurements.depth], [origin.x, origin.z + measurements.depth]];
}

/** Capture a sanitized provider context and privately bind it to this exact project. */
export function createDraftContext(project, { floorId, roomId, mode = 'furnish_room', measurements, origin, siteNotes, siteScope = 'all' } = {}) {
  validateProject(project);
  const baseline = serializeProject(project);
  if (!MODES.includes(mode)) throw new Error('Unknown AI draft mode.');
  const requestId = `request_${globalThis.crypto?.randomUUID?.().replaceAll('-', '') || Date.now().toString(36) + Math.random().toString(36).slice(2)}`;
  if (mode === 'site') {
    if (!['all', 'neighborhood'].includes(siteScope)) throw new Error('Unknown site planning scope.');
    fields(siteNotes, ['own_home', 'include', 'reference'], 'Site description');
    for (const [field, label] of [['own_home', 'Identify your own home in the photos'], ['include', 'Requested surroundings'], ['reference', 'Known dimension and orientation']]) {
      text(typeof siteNotes[field] === 'string' ? siteNotes[field].replace(/[\r\n\t]/g, ' ') : siteNotes[field], 1000, label, field !== 'own_home');
    }
    const context = freeze({ draft_version: 1, request_id: requestId, mode,
      site: clone(project.site || createSite()), site_notes: clone(siteNotes),
      floor_footprints: project.floors.map(floor => ({ elevation_m: floor.elevation_m, polygons: floor.rooms.map(room => clone(room.polygon)) })) });
    trustedContexts.set(context, { baseline, mode, siteScope });
    return context;
  }
  const floor = project.floors.find(value => value.id === floorId);
  if (!floor) throw new Error('Select a target floor before creating an AI draft.');
  let room = floor.rooms.find(value => value.id === roomId), measured = null, frame = null;
  if (mode === 'furnish_room' && !room) throw new Error('Select an existing room before creating a furnishing draft.');
  if (mode === 'new_room') {
    fields(measurements, ['width', 'depth', 'height'], 'Measured room dimensions');
    fields(origin, ['x', 'z'], 'Measured room origin');
    measured = { width: number(measurements.width, 0.1, 100, 'Measured width'), depth: number(measurements.depth, 0.1, 100, 'Measured depth'), height: number(measurements.height, 0.5, 20, 'Measured ceiling height') };
    frame = { x: number(origin.x, -100, 100, 'Origin x'), z: number(origin.z, -100, 100, 'Origin z') };
    if (frame.x + measured.width > 100 || frame.z + measured.depth > 100) throw new Error('Measured room extends past the project coordinate bounds.');
    if (['rooms', 'walls', 'openings', 'items'].some(collection => floor[collection].length) && Math.abs(floor.height_m - measured.height) > EPS) throw new Error('Measured ceiling height must match the existing floor. Create a separate floor for a different ceiling height.');
    room = { name: 'Measured new room', polygon: rectangle(measured, frame), material: 'floor' };
    // Reject overlapping or partially shared geometry before any network request.
    const check = clone(project), target = check.floors.find(value => value.id === floorId);
    target.height_m = measured.height;
    const added = { id: nextId(target, 'room'), ...clone(room) };
    target.rooms.push(added); outlineRoom(target, added); validateProject(check); serializeProject(check);
  }
  const walls = [], openings = [];
  room.polygon.forEach((start, edge_index) => {
    const end = room.polygon[(edge_index + 1) % room.polygon.length], wall = edgeWall(floor, start, end);
    if (!wall) return;
    walls.push({ edge_index, start: [...start], end: [...end], thickness_m: wall.thickness_m });
    floor.openings.filter(opening => opening.wall_id === wall.id).forEach(opening => {
      openings.push({ edge_index, type: opening.type, offset_m: equal(wall.start, start) ? opening.offset_m : distance(start, end) - opening.offset_m - opening.width_m,
        width_m: opening.width_m, sill_m: opening.sill_m, head_m: opening.head_m });
    });
  });
  const context = freeze({ draft_version: 1, request_id: requestId, mode, floor_id: floor.id, room_id: mode === 'furnish_room' ? room.id : null,
    ceiling_height_m: measured?.height ?? floor.height_m, room: { name: room.name, polygon: clone(room.polygon), material: room.material },
    measurements: measured, origin: frame, walls, openings,
    existing_items: mode === 'furnish_room' ? floor.items.filter(item => item.room === room.id).map(itemDescriptor) : [],
    catalog: { version: CATALOG.version, models: CATALOG.models.map(model => ({ model_id: model.id, name: model.label, type: model.type, dimensions_m: { ...model.dimensions_m }, elevation_m: model.elevation_m, default_style: model.default_style, supports_pattern: supportsFurniturePattern(model) })),
      styles: CATALOG.styles.map(style => ({ style_id: style.id, name: style.label })), patterns: PATTERNS.map(pattern => pattern.id) } });
  trustedContexts.set(context, { baseline, floorId, roomId: mode === 'furnish_room' ? room.id : null, mode, measurements: measured, origin: frame });
  return context;
}

const objectSchema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const stringSchema = maxLength => ({ type: 'string', maxLength });
const numberSchema = (minimum, maximum) => ({ type: 'number', minimum, maximum });
/** All provider object properties are required; nullable appearance means catalog default. */
export function draftSchema(mode = 'furnish_room', context) {
  if (!MODES.includes(mode)) throw new Error('Unknown AI draft mode.');
  const candidateKey = { type: 'string', pattern: KEY.source, maxLength: 64 };
  if (mode === 'site') return objectSchema({
    draft_version: { type: 'integer', enum: [1] }, request_id: stringSchema(100), kind: { type: 'string', enum: [mode] },
    features: { type: 'array', maxItems: SITE_LIMITS.features, items: objectSchema({ candidate_key: candidateKey, name: stringSchema(100),
      kind: { type: 'string', enum: trustedContexts.get(context)?.siteScope === 'neighborhood' ? ['building', 'street', 'landscape'] : SITE_KINDS }, polygon: { type: 'array', minItems: 3, maxItems: SITE_LIMITS.points,
        items: { type: 'array', minItems: 2, maxItems: 2, items: numberSchema(-SITE_LIMITS.coordinate, SITE_LIMITS.coordinate) } },
      height_m: numberSchema(0, SITE_LIMITS.height), color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, evidence: stringSchema(300) }) },
    assumptions: { type: 'array', maxItems: 16, items: stringSchema(300) }, needs_measurements: { type: 'array', maxItems: 16, items: stringSchema(300) },
  });
  const color = { type: ['string', 'null'], pattern: '^#[0-9a-fA-F]{6}$' };
  const properties = {
    draft_version: { type: 'integer', enum: [1] }, request_id: stringSchema(100), kind: { type: 'string', enum: [mode] },
    items: { type: 'array', maxItems: 64, items: objectSchema({ candidate_key: candidateKey, name: stringSchema(100),
      model_id: { type: 'string', enum: CATALOG.models.map(model => model.id) }, style_id: { type: 'string', enum: CATALOG.styles.map(style => style.id) },
      position_m: objectSchema({ x: numberSchema(-100, 100), y: numberSchema(0, 20), z: numberSchema(-100, 100) }),
      dimensions_m: objectSchema({ width: numberSchema(0.001, 100), depth: numberSchema(0.001, 100), height: numberSchema(0.001, 100) }),
      rotation_deg: numberSchema(-36000, 36000), evidence: stringSchema(300), color,
      pattern_id: { type: ['string', 'null'], enum: [...PATTERNS.map(pattern => pattern.id), null] }, pattern_color: color }) },
    assumptions: { type: 'array', maxItems: 16, items: stringSchema(300) }, needs_measurements: { type: 'array', maxItems: 16, items: stringSchema(300) },
  };
  if (mode === 'new_room') {
    properties.room_name = stringSchema(100);
    properties.openings = { type: 'array', maxItems: 32, items: objectSchema({ candidate_key: candidateKey, edge_index: { type: 'integer', minimum: 0, maximum: 3 },
      offset_m: numberSchema(0, 100), width_m: numberSchema(0.05, 100), sill_m: numberSchema(0, 20), head_m: numberSchema(0.05, 20), type: { type: 'string', enum: ['door', 'window', 'passage'] } }) };
  }
  return objectSchema(properties);
}

export function itemFootprint(item) {
  const { width, depth } = item.dimensions_m, { x, z } = item.position_m;
  const angle = item.rotation_deg * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  return [[-width / 2, -depth / 2], [width / 2, -depth / 2], [width / 2, depth / 2], [-width / 2, depth / 2]].map(([u, v]) => [x + c * u + s * v, z - s * u + c * v]);
}
function onSegment(point, start, end) {
  return Math.abs(cross(start, end, point)) < EPS && point[0] >= Math.min(start[0], end[0]) - EPS && point[0] <= Math.max(start[0], end[0]) + EPS && point[1] >= Math.min(start[1], end[1]) - EPS && point[1] <= Math.max(start[1], end[1]) + EPS;
}
function segmentInside(start, end, polygon) {
  const dx = end[0] - start[0], dz = end[1] - start[1], length2 = dx * dx + dz * dz, cuts = [0, 1];
  polygon.forEach((a, index) => {
    const b = polygon[(index + 1) % polygon.length], ux = b[0] - a[0], uz = b[1] - a[1], denominator = dx * uz - dz * ux;
    if (Math.abs(denominator) > EPS) {
      const vx = a[0] - start[0], vz = a[1] - start[1];
      const t = (vx * uz - vz * ux) / denominator, u = (vx * dz - vz * dx) / denominator;
      if (t > 0 && t < 1 && u >= -EPS && u <= 1 + EPS) cuts.push(t);
    } else {
      for (const point of [a, b]) if (onSegment(point, start, end)) cuts.push(Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) / length2)));
    }
  });
  cuts.sort((a, b) => a - b);
  return cuts.slice(1).every((cut, index) => { const t = (cuts[index] + cut) / 2; return pointInPolygon([start[0] + dx * t, start[1] + dz * t], polygon); });
}
export function footprintInsideRoom(item, polygon) {
  const points = itemFootprint(item);
  return points.every(point => pointInPolygon(point, polygon)) && points.every((point, index) => segmentInside(point, points[(index + 1) % points.length], polygon));
}
function rectanglesOverlap(a, b) {
  for (const polygon of [a, b]) for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i], q = polygon[(i + 1) % polygon.length], axis = [p[1] - q[1], q[0] - p[0]];
    const ap = a.map(point => point[0] * axis[0] + point[1] * axis[1]), bp = b.map(point => point[0] * axis[0] + point[1] * axis[1]);
    if (Math.min(Math.max(...ap), Math.max(...bp)) - Math.max(Math.min(...ap), Math.min(...bp)) <= EPS) return false;
  }
  return true;
}
function overlapHeight(a, b) { return Math.min(a.position_m.y + a.dimensions_m.height, b.position_m.y + b.dimensions_m.height) > Math.max(a.position_m.y, b.position_m.y) + EPS; }
function openingClearance(opening, wall) {
  const length = distance(wall.start, wall.end), ux = (wall.end[0] - wall.start[0]) / length, uz = (wall.end[1] - wall.start[1]) / length;
  const clearance = opening.type === 'window' ? wall.thickness_m / 2 + 0.05 : Math.max(0.6, wall.thickness_m / 2);
  const point = (offset, side) => [wall.start[0] + ux * offset - uz * clearance * side, wall.start[1] + uz * offset + ux * clearance * side];
  const start = opening.offset_m, end = start + opening.width_m;
  return [point(start, 1), point(end, 1), point(end, -1), point(start, -1)];
}

/** Validate data, build fresh IDs, and return a complete detached project for review. */
export function prepareDraft(project, context, rawDraft, { selectedCandidateKeys } = {}) {
  const trusted = trustedContexts.get(context);
  if (!trusted) throw new Error('Draft context must come from this editor request.');
  validateProject(project);
  if (serializeProject(project) !== trusted.baseline) throw new Error('The project changed after this draft request. Generate a new draft.');
  const draft = parseDraftJSON(rawDraft), creating = trusted.mode === 'new_room';
  if (trusted.mode === 'site') return prepareSiteDraft(project, context, draft, selectedCandidateKeys);
  fields(draft, ['draft_version', 'request_id', 'kind', 'items', 'assumptions', 'needs_measurements', ...(creating ? ['room_name', 'openings'] : [])], 'AI draft');
  if (draft.draft_version !== 1) throw new Error('Unsupported AI draft version.');
  if (draft.request_id !== context.request_id || draft.kind !== trusted.mode) throw new Error('AI draft does not match this request and target.');
  array(draft.items, 64, 'Draft items');
  const assumptions = array(draft.assumptions, 16, 'Assumptions').map(value => text(value, 300, 'Assumption'));
  const needsMeasurements = array(draft.needs_measurements, 16, 'Measurements still needed').map(value => text(value, 300, 'Measurement question'));
  const merged = clone(project), floor = merged.floors.find(value => value.id === trusted.floorId), warnings = [], candidates = [], keys = new Set();
  const warn = message => { if (warnings.length < 100) warnings.push(message); };
  let room = floor.rooms.find(value => value.id === trusted.roomId);
  if (creating) {
    text(draft.room_name, 100, 'Room name'); array(draft.openings, 32, 'Draft openings');
    room = { id: nextId(floor, 'room'), name: draft.room_name, polygon: rectangle(trusted.measurements, trusted.origin), material: 'floor' };
    floor.height_m = trusted.measurements.height; floor.rooms.push(room); outlineRoom(floor, room);
  }
  const registerKey = value => { key(value); if (keys.has(value)) throw new Error('Candidate keys must be unique across items and openings.'); keys.add(value); };
  const mappedItems = draft.items.map(source => {
    fields(source, ITEM_FIELDS, 'Draft item', APPEARANCE_FIELDS); registerKey(source.candidate_key);
    text(source.name, 100, 'Item name'); text(source.evidence, 300, 'Item evidence', true);
    const model = getCatalogModel(source.model_id);
    if (!model) throw new Error('Unknown furniture model in AI draft.');
    if (!getCatalogStyle(source.style_id)) throw new Error('Unknown furniture style in AI draft.');
    fields(source.position_m, ['x', 'y', 'z'], 'Item position'); fields(source.dimensions_m, ['width', 'depth', 'height'], 'Item dimensions');
    number(source.position_m.x, -100, 100, 'Item x'); number(source.position_m.z, -100, 100, 'Item z'); number(source.position_m.y, 0, floor.height_m, 'Item elevation');
    for (const field of ['width', 'depth', 'height']) number(source.dimensions_m[field], 0.001, 100, `Item ${field}`);
    number(source.rotation_deg, -36000, 36000, 'Item rotation');
    const rotation = ((source.rotation_deg % 360) + 360) % 360;
    if (rotation !== source.rotation_deg) warn(`${source.name}: rotation normalized from ${source.rotation_deg}° to ${rotation}°.`);
    const appearance = Object.fromEntries(APPEARANCE_FIELDS.filter(field => source[field] !== undefined && source[field] !== null).map(field => [field, source[field]]));
    const item = { name: source.name, type: model.type, model_id: model.id, style_id: source.style_id, room: room.id,
      position_m: { ...source.position_m }, dimensions_m: { ...source.dimensions_m }, rotation_deg: rotation, entity_id: '', notes: '', ...appearance };
    validateFurnitureAppearance(item);
    if (item.position_m.y + item.dimensions_m.height > floor.height_m + EPS) throw new Error(`${item.name}: top of item is above the ceiling.`);
    if (!footprintInsideRoom(item, room.polygon)) throw new Error(`${item.name}: the complete rotated footprint must be inside the selected room.`);
    candidates.push({ candidate_key: source.candidate_key, kind: 'item', name: source.name, evidence: source.evidence, item: { ...source, rotation_deg: rotation } });
    return { key: source.candidate_key, item };
  });
  const mappedOpenings = (creating ? draft.openings : []).map(source => {
    fields(source, OPENING_FIELDS, 'Draft opening'); registerKey(source.candidate_key);
    if (!Number.isInteger(source.edge_index) || source.edge_index < 0 || source.edge_index >= room.polygon.length) throw new Error('Opening edge_index must identify a measured room edge.');
    const start = room.polygon[source.edge_index], end = room.polygon[(source.edge_index + 1) % room.polygon.length], length = distance(start, end), wall = edgeWall(floor, start, end);
    if (!['door', 'window', 'passage'].includes(source.type)) throw new Error('Unknown opening type in AI draft.');
    number(source.offset_m, 0, length, 'Opening offset'); number(source.width_m, 0.05, length, 'Opening width'); number(source.sill_m, 0, floor.height_m, 'Opening sill'); number(source.head_m, 0.05, floor.height_m, 'Opening head');
    if (source.offset_m + source.width_m > length + EPS) throw new Error('Opening extends past its measured room edge.');
    if (source.head_m - source.sill_m < 0.05) throw new Error('Opening head must be at least 0.05 m above its sill.');
    if (source.type !== 'window' && source.sill_m !== 0) throw new Error('Doors and passages must have a sill height of 0 m.');
    const opening = { wall_id: wall.id, type: source.type, offset_m: equal(wall.start, start) ? source.offset_m : Math.max(0, length - source.offset_m - source.width_m), width_m: source.width_m, sill_m: source.sill_m, head_m: source.head_m };
    candidates.push({ candidate_key: source.candidate_key, kind: 'opening', name: `${source.type} on edge ${source.edge_index + 1}`, evidence: '', opening: { ...source } });
    return { key: source.candidate_key, opening };
  });
  let selected = keys;
  if (selectedCandidateKeys !== undefined) {
    if (!Array.isArray(selectedCandidateKeys) && !(selectedCandidateKeys instanceof Set)) throw new Error('Selected candidate keys must be an array or Set.');
    const values = [...selectedCandidateKeys]; selected = new Set(values);
    if (selected.size !== values.length || values.some(value => !keys.has(value))) throw new Error('Selected candidate keys must be unique known candidates.');
  }
  const additions = [], addedOpenings = [];
  for (const { key: candidateKey, opening } of mappedOpenings) if (selected.has(candidateKey)) {
    if (project.floors.find(value => value.id === floor.id).walls.some(wall => wall.id === opening.wall_id)) warn('A proposed opening uses an existing shared wall; review its effect on the adjacent room.');
    const added = { id: nextId(floor, 'opening'), ...opening }; floor.openings.push(added); addedOpenings.push(added);
  }
  for (const { key: candidateKey, item } of mappedItems) if (selected.has(candidateKey)) {
    const added = { id: nextId(floor, 'item'), ...item }; floor.items.push(added); additions.push(added);
  }
  validateProject(merged); serializeProject(merged);
  for (const item of additions) {
    const footprint = itemFootprint(item);
    for (const other of floor.items) {
      if (other.id === item.id || additions.indexOf(other) > additions.indexOf(item)) continue;
      if (overlapHeight(item, other) && rectanglesOverlap(footprint, itemFootprint(other))) warn(`${item.name} overlaps ${other.name}; review this placement (layered furniture and rugs can be intentional).`);
    }
    for (const opening of floor.openings) {
      if (item.position_m.y >= opening.head_m - EPS || item.position_m.y + item.dimensions_m.height <= opening.sill_m + EPS) continue;
      const wall = floor.walls.find(value => value.id === opening.wall_id);
      if (rectanglesOverlap(footprint, openingClearance(opening, wall))) warn(`${item.name} may obstruct a ${opening.type}; check clearance and access.`);
    }
  }
  // An opening in a reused wall can also be obstructed from the existing room.
  for (const opening of addedOpenings) {
    const clearance = openingClearance(opening, floor.walls.find(value => value.id === opening.wall_id));
    for (const item of floor.items) {
      if (additions.includes(item) || item.position_m.y >= opening.head_m - EPS || item.position_m.y + item.dimensions_m.height <= opening.sill_m + EPS) continue;
      if (rectanglesOverlap(itemFootprint(item), clearance)) warn(`${item.name} may obstruct the proposed ${opening.type}; check clearance on both sides of the wall.`);
    }
  }
  const itemCount = additions.length, openingCount = mappedOpenings.filter(value => selected.has(value.key)).length;
  const summary = `${creating ? `Add measured room “${room.name}”, ${trusted.measurements.width} × ${trusted.measurements.depth} × ${trusted.measurements.height} m; ` : ''}${itemCount} item${itemCount === 1 ? '' : 's'}${creating ? ` and ${openingCount} opening${openingCount === 1 ? '' : 's'}` : ''} selected.`;
  return { project: merged, summary, assumptions, needsMeasurements, candidates, warnings };
}

function prepareSiteDraft(project, context, draft, selectedCandidateKeys) {
  fields(draft, ['draft_version', 'request_id', 'kind', 'features', 'assumptions', 'needs_measurements'], 'AI site draft');
  if (draft.draft_version !== 1) throw new Error('Unsupported AI draft version.');
  if (draft.request_id !== context.request_id || draft.kind !== 'site') throw new Error('AI draft does not match this request and target.');
  const assumptions = array(draft.assumptions, 16, 'Assumptions').map(value => text(value, 300, 'Assumption'));
  const needsMeasurements = array(draft.needs_measurements, 16, 'Measurements still needed').map(value => text(value, 300, 'Measurement question'));
  const keys = new Set(), candidates = [], proposed = createSite();
  for (const source of array(draft.features, SITE_LIMITS.features, 'Site features')) {
    fields(source, ['candidate_key', 'name', 'kind', 'polygon', 'height_m', 'color', 'evidence'], 'Draft site feature');
    if (trustedContexts.get(context)?.siteScope === 'neighborhood' && !['building', 'street', 'landscape'].includes(source.kind)) throw new Error('Neighborhood drafts may add only neighboring buildings, streets and landscape. Your home and roof stay fixed.');
    key(source.candidate_key);
    if (keys.has(source.candidate_key)) throw new Error('Candidate keys must be unique across site features.');
    keys.add(source.candidate_key);
    text(source.name, 100, 'Site feature name'); text(source.evidence, 300, 'Site feature evidence', true);
    proposed.features.push({ id: source.candidate_key, name: source.name, kind: source.kind, polygon: clone(source.polygon), height_m: source.height_m, color: source.color,
      ...(source.kind === 'building' ? { render_style: 'outline' } : {}) });
    candidates.push({ candidate_key: source.candidate_key, kind: 'site', name: source.name, evidence: source.evidence, feature: clone(source) });
  }
  // Validate every candidate, including unchecked ones; selection cannot hide bad data.
  validateSite(proposed);
  let selected = keys;
  if (selectedCandidateKeys !== undefined) {
    if (!Array.isArray(selectedCandidateKeys) && !(selectedCandidateKeys instanceof Set)) throw new Error('Selected candidate keys must be an array or Set.');
    const values = [...selectedCandidateKeys]; selected = new Set(values);
    if (selected.size !== values.length || values.some(value => !keys.has(value))) throw new Error('Selected candidate keys must be unique known candidates.');
  }
  const merged = clone(project), site = clone(project.site || createSite());
  for (const feature of proposed.features) if (selected.has(feature.id)) site.features.push({ ...feature, id: nextSiteId(site, feature.kind) });
  if (selected.size) merged.site = site;
  validateSite(site); validateProject(merged); serializeProject(merged);
  return { project: merged, candidates, assumptions, needsMeasurements,
    summary: `${selected.size} site feature${selected.size === 1 ? '' : 's'} selected. Existing site features and interior geometry remain unchanged.`,
    warnings: ['Photo-derived footprints, roof shapes, heights, and relative positions are approximate. Review scale, orientation, ownership, and alignment before applying; this is not a survey.'] };
}
