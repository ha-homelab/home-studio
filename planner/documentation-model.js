// Optional authoring notes. These describe evidence; they never certify geometry.
export const DOCUMENTATION_LIMITS = Object.freeze({ brief: 4000, measurements: 1024, finishes: 1536, ceilingFixtures: 1024, note: 1000, code: 80, specification: 1000, bytes: 256 * 1024 });
const TYPES = ['room', 'wall', 'opening', 'item'];
const COLLECTIONS = { room: 'rooms', wall: 'walls', opening: 'openings', item: 'items' };
const STATUSES = ['measured', 'estimated', 'imported', 'unknown'];
const ITEM_TYPES = ['furniture', 'lamp', 'chandelier', 'tv', 'appliance', 'switch', 'outlet', 'sensor'];
const ID = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FLOOR_ID = /^[a-z][a-z0-9_]{0,47}$/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString']);
const copy = value => JSON.parse(JSON.stringify(value));
const fail = message => { throw new Error(`Documentation: ${message}`); };
function fields(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) fail('invalid fields.');
}
function text(value, maximum, multiline = false) {
  if (typeof value !== 'string' || [...value].length > maximum || [...value].some(char => { const code = char.codePointAt(0); return code < 32 && !(multiline && ['\n', '\t'].includes(char)) || code >= 0xd800 && code <= 0xdfff; })) fail('invalid text.');
}
function identifier(value, floor = false) {
  if (typeof value !== 'string' || !(floor ? FLOOR_ID : ID).test(value) || RESERVED.has(value)) fail('invalid identifier.');
}
function number(value, low, high) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) fail('invalid number.');
}
function choice(value, values) { if (!values.includes(value)) fail('invalid choice.'); }
function array(value, maximum) { if (!Array.isArray(value) || value.length > maximum) fail('too many entries or invalid list.'); }
function point(value) { if (!Array.isArray(value) || value.length !== 2) fail('invalid point.'); value.forEach(n => number(n, -100, 100)); }
function wallShape(value) {
  fields(value, ['start', 'end', 'thickness_m']); point(value.start); point(value.end); number(value.thickness_m, 0.04, 2);
}
function geometry(value, type) {
  if (value === null) return;
  const common = ['target_type', 'elevation_m', 'height_m'];
  const extra = { room: ['polygon'], wall: ['start', 'end', 'thickness_m'], opening: ['wall_id', 'wall', 'type', 'offset_m', 'width_m', 'sill_m', 'head_m'], item: ['type', 'model_id', 'room', 'position_m', 'dimensions_m', 'rotation_deg'] };
  fields(value, [...common, ...extra[type]]);
  if (value.target_type !== type) fail('geometry belongs to another target type.');
  number(value.elevation_m, -100, 100); number(value.height_m, 0.5, 20);
  if (type === 'room') {
    array(value.polygon, 64); if (value.polygon.length < 3) fail('invalid polygon.'); value.polygon.forEach(point);
  } else if (type === 'wall') {
    wallShape({ start: value.start, end: value.end, thickness_m: value.thickness_m });
  } else if (type === 'opening') {
    identifier(value.wall_id); wallShape(value.wall); choice(value.type, ['door', 'window', 'passage']);
    number(value.offset_m, 0, 300); number(value.width_m, 0.05, 300); number(value.sill_m, 0, 20); number(value.head_m, 0.05, 20);
  } else {
    choice(value.type, ITEM_TYPES); if (value.model_id !== null) identifier(value.model_id); identifier(value.room);
    fields(value.position_m, ['x', 'y', 'z']); number(value.position_m.x, -100, 100); number(value.position_m.y, 0, 20); number(value.position_m.z, -100, 100);
    fields(value.dimensions_m, ['width', 'depth', 'height']); Object.values(value.dimensions_m).forEach(n => number(n, 0.001, 100)); number(value.rotation_deg, -36000, 36000);
  }
}
function resolve(project, ref) {
  const floor = project.floors.find(value => value.id === ref.floor_id);
  const target = floor?.[COLLECTIONS[ref.target_type]]?.find(value => value.id === ref.target_id);
  return target ? { floor, target } : null;
}
function same(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
}
// Count JSON structure/text exactly and reserve 32 bytes per finite number. This
// conservative encoded-size budget is stable across Python/JavaScript formatting.
function encodedBudget(value) {
  if (typeof value === 'number') return 32;
  if (Array.isArray(value)) return 2 + Math.max(0, value.length - 1) + value.reduce((sum, entry) => sum + encodedBudget(entry), 0);
  if (value && typeof value === 'object') return 2 + Math.max(0, Object.keys(value).length - 1) + Object.entries(value).reduce((sum, [key, entry]) => sum + encodedBudget(key) + 1 + encodedBudget(entry), 0);
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function createDocumentation() {
  return { schema_version: 1, brief: '', measurements: [], finishes: [], ceiling_fixture_ids: [] };
}

/** Call after ordinary project geometry has been validated. Never modifies data. */
export function validateDocumentation(documentation, project) {
  fields(documentation, ['schema_version', 'brief', 'measurements', 'finishes', 'ceiling_fixture_ids']);
  if (documentation.schema_version !== 1) fail('unsupported schema version.');
  text(documentation.brief, DOCUMENTATION_LIMITS.brief, true);
  array(documentation.measurements, DOCUMENTATION_LIMITS.measurements); array(documentation.finishes, DOCUMENTATION_LIMITS.finishes); array(documentation.ceiling_fixture_ids, DOCUMENTATION_LIMITS.ceilingFixtures);
  const measurements = new Set(), finishes = new Set(), fixtures = new Set();
  for (const row of documentation.measurements) {
    fields(row, ['floor_id', 'target_type', 'target_id', 'status', 'note', 'geometry']); identifier(row.floor_id, true); choice(row.target_type, TYPES); identifier(row.target_id);
    if (!resolve(project, row)) fail('measurement target does not exist.');
    const key = `${row.floor_id}/${row.target_type}/${row.target_id}`; if (measurements.has(key)) fail('duplicate measurement.'); measurements.add(key);
    choice(row.status, STATUSES); text(row.note, DOCUMENTATION_LIMITS.note, true); geometry(row.geometry, row.target_type);
  }
  for (const row of documentation.finishes) {
    fields(row, ['floor_id', 'room_id', 'surface', 'code', 'specification', 'waste_percent']); identifier(row.floor_id, true); identifier(row.room_id); choice(row.surface, ['floor', 'walls', 'ceiling']);
    if (!resolve(project, { floor_id: row.floor_id, target_type: 'room', target_id: row.room_id })) fail('finish room does not exist.');
    const key = `${row.floor_id}/${row.room_id}/${row.surface}`; if (finishes.has(key)) fail('duplicate finish.'); finishes.add(key);
    text(row.code, DOCUMENTATION_LIMITS.code); text(row.specification, DOCUMENTATION_LIMITS.specification, true); number(row.waste_percent, 0, 100);
  }
  for (const row of documentation.ceiling_fixture_ids) {
    fields(row, ['floor_id', 'item_id']); identifier(row.floor_id, true); identifier(row.item_id);
    if (!resolve(project, { floor_id: row.floor_id, target_type: 'item', target_id: row.item_id })) fail('ceiling item does not exist.');
    const key = `${row.floor_id}/${row.item_id}`; if (fixtures.has(key)) fail('duplicate ceiling item.'); fixtures.add(key);
  }
  if (encodedBudget(documentation) > DOCUMENTATION_LIMITS.bytes) fail('encoded metadata budget exceeds 256 KiB.');
  return documentation;
}

/** Capture only geometric values, never entity IDs, notes, or provider context. */
export function measurementGeometry(project, ref) {
  choice(ref.target_type, TYPES);
  const found = resolve(project, ref); if (!found) fail('measurement target does not exist.');
  const { floor, target } = found;
  const result = { target_type: ref.target_type, elevation_m: floor.elevation_m, height_m: floor.height_m };
  if (ref.target_type === 'room') result.polygon = copy(target.polygon);
  else if (ref.target_type === 'wall') Object.assign(result, { start: [...target.start], end: [...target.end], thickness_m: target.thickness_m });
  else if (ref.target_type === 'opening') {
    const wall = floor.walls.find(value => value.id === target.wall_id); if (!wall) fail('opening wall does not exist.');
    Object.assign(result, { wall_id: target.wall_id, wall: { start: [...wall.start], end: [...wall.end], thickness_m: wall.thickness_m }, type: target.type, offset_m: target.offset_m, width_m: target.width_m, sill_m: target.sill_m, head_m: target.head_m });
  } else Object.assign(result, { type: target.type, model_id: target.model_id ?? null, room: target.room, position_m: { ...target.position_m }, dimensions_m: { ...target.dimensions_m }, rotation_deg: target.rotation_deg });
  return result;
}

export function measurementState(project, row) {
  if (!row || row.status === 'unknown' || row.geometry === null) return 'unknown';
  if (!resolve(project, row)) return 'stale';
  return same(row.geometry, measurementGeometry(project, row)) ? row.status : 'stale';
}

/** For the editor's deletion transaction, not an import-repair shortcut. */
export function pruneDocumentation(project) {
  if (!Object.hasOwn(project, 'documentation')) return undefined;
  const result = copy(project.documentation);
  result.measurements = result.measurements.filter(row => resolve(project, row));
  result.finishes = result.finishes.filter(row => resolve(project, { floor_id: row.floor_id, target_type: 'room', target_id: row.room_id }));
  result.ceiling_fixture_ids = result.ceiling_fixture_ids.filter(row => resolve(project, { floor_id: row.floor_id, target_type: 'item', target_id: row.item_id }));
  return result;
}
