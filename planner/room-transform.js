// Pure, transactional room edits. Ownership is inferred from the existing
// geometry; no extra schema fields or persistent topology cache are required.
import { clone, distance, pointInPolygon, projectOnWall, round, validateProject } from './model.js';

const EPS = 1e-6;
const near = (a, b) => Math.abs(a - b) < EPS;
const edgeAt = (polygon, index) => ({ start: polygon[index], end: polygon[(index + 1) % polygon.length] });
const edges = room => room.polygon.map((_, index) => edgeAt(room.polygon, index));
const on = (point, wall) => projectOnWall(point, wall).distance < EPS;
const interpolate = (wall, t) => wall.start.map((value, axis) => value + (wall.end[axis] - value) * t);
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];

function contacts(a, b) {
  const points = [a.start, a.end].filter(p => on(p, b)).concat([b.start, b.end].filter(p => on(p, a)));
  if (points.length) return points;
  const u = a.end.map((v, i) => v - a.start[i]), v = b.end.map((n, i) => n - b.start[i]);
  const denominator = cross(u, v);
  if (Math.abs(denominator) < EPS) return [];
  const delta = b.start.map((n, i) => n - a.start[i]);
  const t = cross(delta, v) / denominator, s = cross(delta, u) / denominator;
  return t >= 0 && t <= 1 && s >= 0 && s <= 1 ? [interpolate(a, t)] : [];
}
const roomsTouch = (a, b) => edges(a).some(x => edges(b).some(y => contacts(x, y).length));
const wallTouchesRoom = (wall, room) => pointInPolygon(wall.start, room.polygon) || pointInPolygon(wall.end, room.polygon)
  || edges(room).some(edge => contacts(wall, edge).length);

export function roomBounds(room) {
  const xs = room.polygon.map(p => p[0]), zs = room.polygon.map(p => p[1]);
  const minX = Math.min(...xs), minZ = Math.min(...zs), maxX = Math.max(...xs), maxZ = Math.max(...zs);
  return { minX, minZ, maxX, maxZ, width: round(maxX - minX), depth: round(maxZ - minZ) };
}

function checked(floor) {
  validateProject({ schema_version: 1, title: 'Room edit', floors: [floor] });
  return floor;
}
function getRoom(floor, id) {
  const room = floor.rooms.find(value => value.id === id);
  if (!room) throw new Error('The room no longer exists. Select a room again.');
  return room;
}

export function roomMoveGroup(floor, id) {
  const selected = getRoom(floor, id), rooms = new Set([id]), walls = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const room of floor.rooms) if (!rooms.has(room.id) && (floor.rooms.some(other => rooms.has(other.id) && roomsTouch(room, other))
      || floor.walls.some(wall => walls.has(wall.id) && wallTouchesRoom(wall, room)))) {
      rooms.add(room.id); changed = true;
    }
    for (const wall of floor.walls) if (!walls.has(wall.id) && (floor.rooms.some(room => rooms.has(room.id) && wallTouchesRoom(wall, room))
      || floor.walls.some(other => walls.has(other.id) && contacts(wall, other).length))) {
      walls.add(wall.id); changed = true;
    }
  }
  // External attachments are not owned by this room even if no other room is
  // drawn yet. Ask for the same explicit group move as for shared rooms.
  const attached = floor.walls.some(wall => walls.has(wall.id) && (!pointInPolygon(wall.start, selected.polygon)
    || !pointInPolygon(wall.end, selected.polygon) || !pointInPolygon(interpolate(wall, .5), selected.polygon)));
  return { rooms: [...rooms], walls: [...walls], requiresConnected: rooms.size > 1 || attached };
}

export function moveRoom(floor, id, dx, dz, { connected = false } = {}) {
  if (![dx, dz].every(Number.isFinite)) throw new Error('Room movement must use finite coordinates.');
  const group = roomMoveGroup(floor, id);
  if ((dx || dz) && group.requiresConnected && !connected) throw new Error('This room shares geometry. Enable “Move connected rooms together” in Room details, then drag again.');
  if (!dx && !dz) return clone(floor);
  const target = clone(floor), transform = point => [round(point[0] + dx), round(point[1] + dz)];
  for (const room of target.rooms) if (group.rooms.includes(room.id)) room.polygon = room.polygon.map(transform);
  for (const wall of target.walls) if (group.walls.includes(wall.id)) { wall.start = transform(wall.start); wall.end = transform(wall.end); }
  for (const item of target.items) if (group.rooms.includes(item.room)) {
    [item.position_m.x, item.position_m.z] = transform([item.position_m.x, item.position_m.z]);
  }
  // Openings use offsets on their walls, so rigid movement preserves them exactly.
  return checked(target);
}

function rectangular(room) {
  if (room.polygon.length !== 4) return false;
  const b = roomBounds(room);
  return room.polygon.every(p => (near(p[0], b.minX) || near(p[0], b.maxX)) && (near(p[1], b.minZ) || near(p[1], b.maxZ)))
    && edges(room).every(e => near(e.start[0], e.end[0]) || near(e.start[1], e.end[1]));
}
function sharedSide(a, b) {
  if (!rectangular(a) || !rectangular(b)) return null;
  const x = roomBounds(a), y = roomBounds(b);
  for (const [lo, hi, lower, upper] of [['minX', 'maxX', 'minZ', 'maxZ'], ['minZ', 'maxZ', 'minX', 'maxX']]) {
    if (near(x[lower], y[lower]) && near(x[upper], y[upper])) {
      if (near(x[hi], y[lo])) return [[hi, lo], [lower, lower], [upper, upper]];
      if (near(x[lo], y[hi])) return [[lo, hi], [lower, lower], [upper, upper]];
    }
  }
  return null;
}
const affine = (old, next) => {
  if (['minX', 'maxX', 'minZ', 'maxZ'].every(key => old[key] === next[key])) return point => [...point];
  return ([x, z]) => [round(next.minX + (x - old.minX) * (next.maxX - next.minX) / (old.maxX - old.minX)),
    round(next.minZ + (z - old.minZ) * (next.maxZ - next.minZ) / (old.maxZ - old.minZ))];
};
const attachmentError = () => new Error('This resize cannot preserve an attached boundary. Resize rooms that share complete rectangular sides, or edit the polygon and wall junctions separately.');

export function resizeRoom(floor, id, width, depth, anchor = null) {
  const selected = getRoom(floor, id), old = roomBounds(selected);
  if (![width, depth].every(Number.isFinite) || width < .05 || depth < .05) throw new Error('Room width and depth must be at least 0.05 m.');
  if (near(width, old.width) && near(depth, old.depth)) return clone(floor);
  const fixed = anchor || [old.minX, old.minZ];
  if (!Array.isArray(fixed) || fixed.length !== 2 || !fixed.every(Number.isFinite)) throw new Error('The resize anchor must be a finite point.');
  const next = {
    minX: round(fixed[0] + (old.minX - fixed[0]) * width / old.width), maxX: round(fixed[0] + (old.maxX - fixed[0]) * width / old.width),
    minZ: round(fixed[1] + (old.minZ - fixed[1]) * depth / old.depth), maxZ: round(fixed[1] + (old.maxZ - fixed[1]) * depth / old.depth),
  };
  // Shared rectangular sides constrain the normal coordinate and both shared
  // corners. Propagation keeps neighboring rooms rectangular and outer bounds
  // fixed unless those bounds are themselves joined to a moving corner.
  const component = new Set([id]), links = new Map();
  const link = (a, b) => { if (!links.has(a)) links.set(a, new Set()); links.get(a).add(b); };
  let added = true;
  while (added) {
    added = false;
    for (const a of floor.rooms) if (component.has(a.id)) for (const b of floor.rooms) {
      if (a.id === b.id || !roomsTouch(a, b)) continue;
      const sides = sharedSide(a, b);
      // Corner-only contacts need no side constraint; the contact check below
      // will still reject any resize that would separate their common vertex.
      if (!sides) continue;
      if (!component.has(b.id)) { component.add(b.id); added = true; }
      for (const [x, y] of sides) { link(`${a.id}:${x}`, `${b.id}:${y}`); link(`${b.id}:${y}`, `${a.id}:${x}`); }
    }
  }
  const assigned = new Map();
  for (const bound of ['minX', 'maxX', 'minZ', 'maxZ']) {
    const queue = [`${id}:${bound}`], value = next[bound];
    while (queue.length) {
      const key = queue.pop();
      if (assigned.has(key)) { if (!near(assigned.get(key), value)) throw attachmentError(); continue; }
      assigned.set(key, value); queue.push(...(links.get(key) || []));
    }
  }
  const transforms = new Map();
  for (const room of floor.rooms) {
    const before = roomBounds(room), after = { ...before };
    for (const bound of ['minX', 'maxX', 'minZ', 'maxZ']) if (assigned.has(`${room.id}:${bound}`)) after[bound] = assigned.get(`${room.id}:${bound}`);
    if (after.maxX - after.minX < .05 - EPS || after.maxZ - after.minZ < .05 - EPS) throw new Error('The resize would collapse or invert a neighboring room. Reduce the change.');
    transforms.set(room.id, affine(before, after));
  }
  // Preserve every existing room contact, including partial sides and corners.
  // An unsupported junction fails before any caller-owned object is modified.
  for (let i = 0; i < floor.rooms.length; i++) for (let j = i + 1; j < floor.rooms.length; j++) {
    const a = floor.rooms[i], b = floor.rooms[j];
    for (const x of edges(a)) for (const y of edges(b)) for (const p of contacts(x, y)) {
      if (distance(transforms.get(a.id)(p), transforms.get(b.id)(p)) > .002) throw attachmentError();
    }
  }
  const target = clone(floor);
  for (const room of target.rooms) room.polygon = room.polygon.map(transforms.get(room.id));
  const transformPoint = point => {
    const owners = floor.rooms.filter(room => pointInPolygon(point, room.polygon));
    const results = owners.map(room => transforms.get(room.id)(point));
    if (results.some(p => distance(p, results[0]) > .002)) throw attachmentError();
    return results[0] || [...point];
  };
  for (const wall of target.walls) { wall.start = transformPoint(wall.start); wall.end = transformPoint(wall.end); }
  // A wall spanning different transforms may require a bend or a split. Keep
  // each room contact on its wall and every endpoint junction connected. A
  // junction may slide along a straight continuous wall without splitting it.
  for (let i = 0; i < floor.walls.length; i++) {
    const wall = floor.walls[i], moved = target.walls[i];
    for (const room of floor.rooms) for (const edge of edges(room)) for (const p of contacts(wall, edge)) {
      if (projectOnWall(transforms.get(room.id)(p), moved).distance > .002) throw attachmentError();
    }
    for (let j = i + 1; j < floor.walls.length; j++) for (const p of contacts(wall, floor.walls[j])) {
      const other = floor.walls[j], nextOther = target.walls[j];
      const endpoints = [[wall.start, moved.start], [wall.end, moved.end], [other.start, nextOther.start], [other.end, nextOther.end]];
      for (const [before, after] of endpoints) if (distance(before, p) < EPS
        && (projectOnWall(after, moved).distance > .002 || projectOnWall(after, nextOther).distance > .002)) throw attachmentError();
    }
    const before = distance(wall.start, wall.end), after = distance(moved.start, moved.end);
    if (near(before, after)) continue;
    for (const opening of target.openings.filter(o => o.wall_id === wall.id)) {
      if (opening.width_m > after) throw new Error('The resized wall is too short for its door or window. Increase the room dimension or edit the opening first.');
      // Keep the proportional center and measured width. Validation below
      // rejects competing openings instead of reducing their widths to fit.
      opening.offset_m = round(Math.max(0, Math.min(after - opening.width_m, (opening.offset_m + opening.width_m / 2) * after / before - opening.width_m / 2)));
    }
  }
  for (const item of target.items) {
    [item.position_m.x, item.position_m.z] = transforms.get(item.room)([item.position_m.x, item.position_m.z]);
  }
  return checked(target);
}
