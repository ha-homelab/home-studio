// Pure, metric project operations shared by the editor and its checks.
import { validateFurnitureAppearance, supportsCurtain, getCatalogModel } from './furniture.js';
import { ValidationError } from './validation.js';
import { validateSite } from './site-model.js';
export const LIMITS = Object.freeze({ floors: 8, rooms: 64, walls: 256, openings: 256, items: 256, points: 64, bytes: 2_000_000 });
const EPS = 1e-8;
const ID = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FLOOR_ID = /^[a-z][a-z0-9_]{0,47}$/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString']);
export const ITEM_TYPES = ['furniture', 'lamp', 'chandelier', 'tv', 'appliance', 'switch', 'outlet', 'sensor'];
export const clone = value => JSON.parse(JSON.stringify(value));
export const round = value => Math.round(value * 1000) / 1000;
export const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const equal = (a, b) => distance(a, b) < EPS;
const onSegment = (p, a, b) => Math.abs(cross(a, b, p)) < EPS && p[0] >= Math.min(a[0], b[0]) - EPS && p[0] <= Math.max(a[0], b[0]) + EPS && p[1] >= Math.min(a[1], b[1]) - EPS && p[1] <= Math.max(a[1], b[1]) + EPS;
export function signedArea(poly) {
  return poly.reduce((sum, p, i) => { const q = poly[(i + 1) % poly.length]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
}
export function pointInPolygon(p, poly, includeBoundary = true) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (onSegment(p, a, b)) return includeBoundary;
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function properCross(a, b, c, d) {
  const abc = cross(a, b, c), abd = cross(a, b, d), cda = cross(c, d, a), cdb = cross(c, d, b);
  return ((abc > EPS && abd < -EPS) || (abc < -EPS && abd > EPS)) && ((cda > EPS && cdb < -EPS) || (cda < -EPS && cdb > EPS));
}
function intersects(a, b, c, d) { return properCross(a, b, c, d) || onSegment(a, c, d) || onSegment(b, c, d) || onSegment(c, a, b) || onSegment(d, a, b); }
function collinearOverlap(a, b, c, d) {
  if (Math.abs(cross(a, b, c)) > EPS || Math.abs(cross(a, b, d)) > EPS) return false;
  const axis = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 0 : 1;
  return Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis])) - Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis])) > EPS;
}
function polygonsOverlap(a, b) {
  if (a.some(p => pointInPolygon(p, b, false)) || b.some(p => pointInPolygon(p, a, false))) return true;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    const p = a[i], q = a[(i + 1) % a.length], r = b[j], s = b[(j + 1) % b.length];
    if (properCross(p, q, r, s)) return true;
    if (collinearOverlap(p, q, r, s) && signedArea(a) * signedArea(b) * ((q[0] - p[0]) * (s[0] - r[0]) + (q[1] - p[1]) * (s[1] - r[1])) > 0) return true;
  }
  return false;
}
export function projectOnWall(point, wall) {
  const len = distance(wall.start, wall.end);
  const t = ((point[0] - wall.start[0]) * (wall.end[0] - wall.start[0]) + (point[1] - wall.start[1]) * (wall.end[1] - wall.start[1])) / (len * len);
  const clamped = Math.max(0, Math.min(1, t));
  const nearest = [wall.start[0] + clamped * (wall.end[0] - wall.start[0]), wall.start[1] + clamped * (wall.end[1] - wall.start[1])];
  return { point: nearest, distance: distance(point, nearest), offset: clamped * len, length: len };
}
export function nextId(floor, prefix) {
  const ids = new Set(['rooms', 'walls', 'openings', 'items'].flatMap(key => floor[key].map(item => item.id)));
  let i = 1; while (ids.has(`${prefix}_${i}`)) i++;
  return `${prefix}_${i}`;
}
export function newFloor(id = 'ground', name = 'Ground floor', elevation = 0) {
  return { id, name, elevation_m: elevation, height_m: 2.7, rooms: [], walls: [], openings: [], items: [] };
}
function projectId() { return `home_${globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 16) || Math.random().toString(16).slice(2)}`; }
export function blankProject() { return { schema_version: 1, id: projectId(), title: 'Untitled home', floors: [newFloor()] }; }
export function outlineRoom(floor, room) {
  let count = 0;
  for (let i = 0; i < room.polygon.length; i++) {
    const start = room.polygon[i], end = room.polygon[(i + 1) % room.polygon.length];
    if (floor.walls.some(w => equal(w.start, start) && equal(w.end, end) || equal(w.end, start) && equal(w.start, end))) continue;
    if (floor.walls.some(w => collinearOverlap(start, end, w.start, w.end))) throw new ValidationError('This outline partly overlaps an existing wall. Edit or split that wall first. Exact shared walls are reused.');
    floor.walls.push({ id: nextId(floor, 'wall'), start: [...start], end: [...end], thickness_m: 0.15 }); count++;
  }
  return count;
}
export function demoProject() {
  const p = blankProject(); p.title = 'Courtyard study · fictional demo';
  const f = p.floors[0];
  f.rooms = [
    { id: 'living', name: 'Living & dining', polygon: [[0, 0], [6, 0], [6, 5], [0, 5]], material: 'floor' },
    { id: 'studio', name: 'Studio', polygon: [[6, 0], [9.5, 0], [9.5, 5], [6, 5]], material: 'floor' },
    { id: 'terrace', name: 'Terrace', polygon: [[0, 5], [6, 5], [6, 7.5], [0, 7.5]], material: 'deck' },
  ];
  outlineRoom(f, f.rooms[0]); outlineRoom(f, f.rooms[1]);
  f.openings = [
    { id: 'entry', wall_id: 'wall_4', type: 'door', offset_m: 0.65, width_m: 1, sill_m: 0, head_m: 2.2 },
    { id: 'studio_door', wall_id: 'wall_2', type: 'door', offset_m: 2.1, width_m: 0.9, sill_m: 0, head_m: 2.1 },
    { id: 'view', wall_id: 'wall_1', type: 'window', offset_m: 1.1, width_m: 3.4, sill_m: 0.75, head_m: 2.2 },
    { id: 'studio_view', wall_id: 'wall_5', type: 'window', offset_m: 0.7, width_m: 2, sill_m: 0.8, head_m: 2.2 },
    { id: 'terrace_door', wall_id: 'wall_3', type: 'passage', offset_m: 1, width_m: 3.4, sill_m: 0, head_m: 2.3 },
  ];
  f.items = [
    { id: 'sofa', name: 'Sofa', type: 'furniture', model_id: 'sofa_3', style_id: 'contemporary', room: 'living', position_m: { x: 1.5, y: 0, z: 2.2 }, dimensions_m: { width: 2.2, depth: 0.85, height: 0.75 }, rotation_deg: 90, entity_id: '', notes: '' },
    { id: 'table', name: 'Dining table', type: 'furniture', model_id: 'dining_table', style_id: 'warm_wood', room: 'living', position_m: { x: 4.2, y: 0, z: 3.4 }, dimensions_m: { width: 1.6, depth: 0.9, height: 0.75 }, rotation_deg: 0, entity_id: '', notes: '' },
    { id: 'light', name: 'Pendant', type: 'chandelier', model_id: 'pendant', style_id: 'scandinavian', room: 'living', position_m: { x: 4.2, y: 2.15, z: 3.4 }, dimensions_m: { width: 0.45, depth: 0.45, height: 0.4 }, rotation_deg: 0, entity_id: 'light.demo_dining', notes: 'Example entity only. Replace with your own Home Assistant entity.' },
    { id: 'desk', name: 'Desk', type: 'furniture', model_id: 'desk', style_id: 'warm_wood', room: 'studio', position_m: { x: 8.5, y: 0, z: 1.5 }, dimensions_m: { width: 1.4, depth: 0.7, height: 0.75 }, rotation_deg: 90, entity_id: '', notes: '' },
    { id: 'desk_lamp', name: 'Desk lamp', type: 'lamp', model_id: 'table_lamp', style_id: 'monochrome', room: 'studio', position_m: { x: 8.5, y: 0.75, z: 1.3 }, dimensions_m: { width: 0.25, depth: 0.25, height: 0.4 }, rotation_deg: 0, entity_id: 'light.demo_studio', notes: '' },
  ];
  return p;
}
export function validateProject(project, { complete = false } = {}) {
  function fail(message, key, params, labels) { throw key ? new ValidationError(message, key, params, labels) : new Error(message); }
  function object(v, label) { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(`${label} must be an object.`); }
  function fields(v, allowed, label, optional = []) { object(v, label); const extra = Object.keys(v).filter(k => !allowed.includes(k) && !optional.includes(k)), missing = allowed.filter(k => !Object.hasOwn(v, k)); if (extra.length) fail(`${label}: unknown fields ${extra.join(', ')}.`); if (missing.length) fail(`${label}: missing fields ${missing.join(', ')}.`); }
  function number(v, min, max, label, fieldKey) { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(`${label} must be a number from ${min} to ${max}.`, '{field} must be a number from {min} to {max}.', { field: label, min, max }, fieldKey ? { field: fieldKey } : {}); }
  function string(v, max, label, empty = false, multiline = false, fieldKey = label) {
    if (typeof v !== 'string' || [...v].length > max || (!empty && !v.trim())) fail(`${label} must be ${empty ? 'text' : 'nonempty text'} of at most ${max} characters.`, empty ? '{field} must be text of at most {max} characters.' : '{field} must be nonempty text of at most {max} characters.', { max }, { field: fieldKey });
    if ([...v].some(char => { const code = char.codePointAt(0); return code < 32 && !(multiline && (char === '\n' || char === '\t')) || code >= 0xd800 && code <= 0xdfff; })) fail(`${label}: control characters and invalid Unicode are not allowed.`, '{field}: control characters and invalid Unicode are not allowed.', {}, { field: fieldKey });
  }
  function id(v, regex, label) { if (typeof v !== 'string' || !regex.test(v) || RESERVED.has(v)) fail(`${label} has an invalid identifier.`); }
  function point(v, label) { if (!Array.isArray(v) || v.length !== 2) fail(`${label} must be [x, z].`, '{name} must be [x, z].', { name: label }); number(v[0], -100, 100, label + ' x'); number(v[1], -100, 100, label + ' z'); }
  fields(project, ['schema_version', 'title', 'floors'], 'Project', ['id', 'site']);
  if (Object.hasOwn(project, 'site')) validateSite(project.site);
  if (project.schema_version !== 1) fail('Unsupported project schema. Expected schema_version: 1.');
  if (project.id !== undefined) id(project.id, FLOOR_ID, 'Project');
  string(project.title, 120, 'Project title');
  if (!Array.isArray(project.floors) || project.floors.length < 1 || project.floors.length > LIMITS.floors) fail(`Project must have 1–${LIMITS.floors} floors.`, 'Project must have 1–{max} floors.', { max: LIMITS.floors });
  const floorIds = new Set(); let entryCount = 0;
  for (const f of project.floors) {
    fields(f, ['id', 'name', 'elevation_m', 'height_m', 'rooms', 'walls', 'openings', 'items'], 'Floor', ['ha_floor_id']);
    if (f.ha_floor_id !== undefined) string(f.ha_floor_id, 128, 'Home Assistant floor ID'); id(f.id, FLOOR_ID, 'Floor');
    if (floorIds.has(f.id)) fail(`Duplicate floor identifier: ${f.id}.`); floorIds.add(f.id);
    string(f.name, 120, 'Floor name'); number(f.elevation_m, -100, 100, 'Floor elevation', 'Elevation (m)'); number(f.height_m, 0.5, 20, 'Ceiling height', 'Ceiling height (m)');
    const ids = new Set();
    for (const key of ['rooms', 'walls', 'openings', 'items']) {
      if (!Array.isArray(f[key]) || f[key].length > LIMITS[key]) fail(`${f.name}: maximum ${LIMITS[key]} ${key}.`, `{floor}: maximum {max} ${key}.`, { floor: f.name, max: LIMITS[key] });
      entryCount += f[key].length;
      for (const value of f[key]) { object(value, key); id(value.id, ID, key); if (ids.has(value.id)) fail(`${f.name}: duplicate identifier ${value.id}.`); ids.add(value.id); }
    }
    if (entryCount > 2048) fail('A project can contain at most 2,048 rooms, walls, openings, and items in total.', 'A project can contain at most 2,048 rooms, walls, openings, and items in total.');
    if (complete && !f.rooms.length) fail(`${f.name} needs at least one room before compiling.`, '{floor} needs at least one room before compiling.', { floor: f.name });
    for (const r of f.rooms) {
      fields(r, ['id', 'name', 'polygon', 'material'], 'Room', ['ha_area_id']);
      if (r.ha_area_id !== undefined) string(r.ha_area_id, 128, 'Home Assistant area ID');
      string(r.name, 120, 'Room name');
      if (!['floor', 'tile', 'deck'].includes(r.material)) fail(`${r.name}: choose floor, tile, or deck material.`, '{room}: choose a valid floor material.', { room: r.name });
      if (!Array.isArray(r.polygon) || r.polygon.length < 3 || r.polygon.length > LIMITS.points) fail(`${r.name}: use 3–${LIMITS.points} polygon points.`, '{room}: use 3–{max} polygon points.', { room: r.name, max: LIMITS.points });
      r.polygon.forEach(p => point(p, r.name));
      if (Math.abs(signedArea(r.polygon)) < 0.01) fail(`${r.name}: room area must be at least 0.01 m².`, '{room}: room area must be at least 0.01 m².', { room: r.name });
      for (let i = 0; i < r.polygon.length; i++) {
        const a = r.polygon[i], b = r.polygon[(i + 1) % r.polygon.length];
        const c = r.polygon[(i + 2) % r.polygon.length];
        if (distance(a, b) < 0.01) fail(`${r.name}: remove duplicate or extremely close polygon points.`, '{room}: remove duplicate or extremely close polygon points.', { room: r.name });
        if (Math.abs(cross(a, b, c)) <= EPS && (a[0] - b[0]) * (c[0] - b[0]) + (a[1] - b[1]) * (c[1] - b[1]) > EPS) fail(`${r.name}: adjacent polygon edges cannot overlap or reverse direction.`, '{room}: adjacent polygon edges cannot overlap or reverse direction.', { room: r.name });
        for (let j = i + 1; j < r.polygon.length; j++) {
          if (j === i + 1 || (i === 0 && j === r.polygon.length - 1)) continue;
          if (intersects(a, b, r.polygon[j], r.polygon[(j + 1) % r.polygon.length])) fail(`${r.name}: polygon edges cannot cross or touch each other.`, '{room}: polygon edges cannot cross or touch each other.', { room: r.name });
        }
      }
    }
    if (f.rooms.reduce((sum, r) => sum + r.polygon.length, 0) > 2048) fail(`${f.name}: maximum 2,048 polygon points per floor.`, '{floor}: maximum 2,048 polygon points per floor.', { floor: f.name });
    for (let i = 0; i < f.rooms.length; i++) for (let j = i + 1; j < f.rooms.length; j++) if (polygonsOverlap(f.rooms[i].polygon, f.rooms[j].polygon)) fail(`${f.rooms[i].name} and ${f.rooms[j].name} overlap. Rooms may share an edge, but their interiors must be separate.`, '{first} and {second} overlap. Rooms may share an edge, but their interiors must be separate.', { first: f.rooms[i].name, second: f.rooms[j].name });
    for (const w of f.walls) { fields(w, ['id', 'start', 'end', 'thickness_m'], 'Wall'); point(w.start, w.id); point(w.end, w.id); number(w.thickness_m, 0.04, 2, 'Wall thickness', 'Thickness (m)'); if (distance(w.start, w.end) < 0.05) fail('Walls must be at least 0.05 m long.', 'Walls must be at least 0.05 m long.'); }
    for (let i = 0; i < f.walls.length; i++) for (let j = i + 1; j < f.walls.length; j++) {
      const a = f.walls[i], b = f.walls[j];
      if (collinearOverlap(a.start, a.end, b.start, b.end)) fail(`Walls ${a.id} and ${b.id} overlap. Reuse exact shared walls, or split partial overlaps.`, 'Walls {first} and {second} overlap. Reuse exact shared walls, or split partial overlaps.', { first: a.id, second: b.id });
      if (properCross(a.start, a.end, b.start, b.end)) fail(`Walls ${a.id} and ${b.id} cross. Split a wall at the junction first.`, 'Walls {first} and {second} cross. Split a wall at the junction first.', { first: a.id, second: b.id });
    }
    for (const o of f.openings) {
      fields(o, ['id', 'wall_id', 'type', 'offset_m', 'width_m', 'sill_m', 'head_m'], 'Opening'); id(o.wall_id, ID, 'Opening wall');
      const w = f.walls.find(w => w.id === o.wall_id); if (!w) fail(`${o.id}: referenced wall does not exist.`, '{opening}: referenced wall does not exist.', { opening: o.id });
      if (!['door', 'window', 'passage'].includes(o.type)) fail('Unknown opening type.', 'Unknown opening type.');
      const len = distance(w.start, w.end);
      number(o.offset_m, 0, len, 'Opening offset', 'Offset from wall start (m)'); number(o.width_m, 0.05, len, 'Opening width', 'Width (m)');
      number(o.sill_m, 0, f.height_m, 'Opening sill', 'Sill height (m)'); number(o.head_m, 0.05, f.height_m, 'Opening head', 'Head height (m)');
      if (o.head_m - o.sill_m < 0.05) fail('Opening head must be at least 0.05 m above its sill.', 'Opening head must be at least 0.05 m above its sill.');
      if (o.type !== 'window' && o.sill_m !== 0) fail('Doors and passages must have a sill height of 0 m.', 'Doors and passages must have a sill height of 0 m.');
      if (o.offset_m + o.width_m > len + EPS) fail('Opening extends past the wall. Reduce its width or offset.', 'Opening extends past the wall. Reduce its width or offset.');
    }
    for (let i = 0; i < f.openings.length; i++) for (let j = i + 1; j < f.openings.length; j++) {
      const a = f.openings[i], b = f.openings[j];
      if (a.wall_id === b.wall_id && Math.min(a.offset_m + a.width_m, b.offset_m + b.width_m) > Math.max(a.offset_m, b.offset_m) + EPS) fail('Openings on the same wall cannot overlap.', 'Openings on the same wall cannot overlap.');
    }
    for (const item of f.items) {
      fields(item, ['id', 'name', 'type', 'room', 'position_m', 'dimensions_m', 'rotation_deg', 'entity_id', 'notes'], 'Item', ['model_id', 'style_id', 'color', 'pattern_id', 'pattern_color', 'curtain']); id(item.room, ID, 'Item room');
      string(item.name, 100, 'Item name'); if (!ITEM_TYPES.includes(item.type)) fail('Unknown item type.', 'Unknown item type.');
      validateFurnitureAppearance(item);
      if (!f.rooms.some(r => r.id === item.room)) fail(`${item.name}: choose a room on this floor.`, '{item}: choose a room on this floor.', { item: item.name });
      fields(item.position_m, ['x', 'y', 'z'], 'Item position'); fields(item.dimensions_m, ['width', 'depth', 'height'], 'Item dimensions');
      number(item.position_m.x, -100, 100, 'Item x', 'x (m)'); number(item.position_m.z, -100, 100, 'Item z', 'z (m)'); number(item.position_m.y, 0, f.height_m, 'Item elevation', 'y (m)');
      for (const key of ['width', 'depth', 'height']) number(item.dimensions_m[key], 0.001, 100, `Item ${key}`, { width: 'Width (m)', depth: 'Depth (m)', height: 'Height (m)' }[key]);
      if (item.position_m.y + item.dimensions_m.height > f.height_m + EPS) fail(`${item.name}: top of item is above the ceiling. Lower the item or reduce its height.`, '{item}: top of item is above the ceiling. Lower the item or reduce its height.', { item: item.name });
      number(item.rotation_deg, -36000, 36000, 'Item rotation', 'Rotation (degrees)'); string(item.entity_id, 150, 'Entity ID', true, false, 'Entity ID (optional)'); string(item.notes, 2000, 'Item notes', true, true, 'Notes');
      if (item.entity_id && !/^[a-z_]+\.[a-z0-9_]+$/.test(item.entity_id)) fail('Entity ID must look like light.living_room (lowercase domain.object_id).', 'Entity ID must look like light.living_room (lowercase domain.object_id).');
      if (Object.hasOwn(item, 'curtain')) {
        fields(item.curtain, ['opening_id', 'mode'], 'Curtain binding');
        if (!supportsCurtain(getCatalogModel(item.model_id))) fail('A curtain binding requires a curtain design.');
        if (!['left', 'right', 'pair'].includes(item.curtain.mode)) fail('Curtain opening mode must be left, right, or pair.');
        id(item.curtain.opening_id, ID, 'Curtain window');
        if (!f.openings.some(opening => opening.id === item.curtain.opening_id && opening.type === 'window')) fail('Choose an existing window on this floor for the curtain.');
        if (item.entity_id && !item.entity_id.startsWith('cover.')) fail('A bound curtain must use a cover entity, or leave the entity empty.');
      }
    }
  }
  return project;
}
export function wallPieces(wall, openings, height) {
  const len = distance(wall.start, wall.end), cuts = openings.filter(o => o.wall_id === wall.id).sort((a, b) => a.offset_m - b.offset_m);
  const pieces = []; let cursor = 0;
  const add = (offset, width, bottom, top) => { if (width > EPS && top - bottom > EPS) pieces.push({ offset, width, bottom, height: top - bottom }); };
  for (const cut of cuts) { add(cursor, cut.offset_m - cursor, 0, height); add(cut.offset_m, cut.width_m, 0, cut.sill_m); add(cut.offset_m, cut.width_m, cut.head_m, height); cursor = cut.offset_m + cut.width_m; }
  add(cursor, len - cursor, 0, height);
  return pieces;
}
export function floorBounds(floor) {
  const points = [...floor.rooms.flatMap(r => r.polygon), ...floor.walls.flatMap(w => [w.start, w.end]), ...floor.items.flatMap(item => {
    const angle = item.rotation_deg * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle);
    return [-1, 1].flatMap(sx => [-1, 1].map(sz => {
      const x = sx * item.dimensions_m.width / 2, z = sz * item.dimensions_m.depth / 2;
      return [item.position_m.x + cosine * x + sine * z, item.position_m.z - sine * x + cosine * z];
    }));
  })];
  if (!points.length) return { minX: -1, maxX: 11, minZ: -1, maxZ: 8 };
  return { minX: Math.min(...points.map(p => p[0])), maxX: Math.max(...points.map(p => p[0])), minZ: Math.min(...points.map(p => p[1])), maxZ: Math.max(...points.map(p => p[1])) };
}
