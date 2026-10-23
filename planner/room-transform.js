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
  // Most pairs in a dense floor are far apart. Reject those before projecting
  // four endpoints and allocating the intersection intermediates.
  if (Math.max(a.start[0], a.end[0]) < Math.min(b.start[0], b.end[0]) - EPS
    || Math.max(b.start[0], b.end[0]) < Math.min(a.start[0], a.end[0]) - EPS
    || Math.max(a.start[1], a.end[1]) < Math.min(b.start[1], b.end[1]) - EPS
    || Math.max(b.start[1], b.end[1]) < Math.min(a.start[1], a.end[1]) - EPS) return [];
  const points = [a.start, a.end].filter(p => on(p, b)).concat([b.start, b.end].filter(p => on(p, a)));
  if (points.length) return points;
  const u = a.end.map((v, i) => v - a.start[i]), v = b.end.map((n, i) => n - b.start[i]);
  const denominator = cross(u, v);
  if (Math.abs(denominator) < EPS) return [];
  const delta = b.start.map((n, i) => n - a.start[i]);
  const t = cross(delta, v) / denominator, s = cross(delta, u) / denominator;
  return t >= 0 && t <= 1 && s >= 0 && s <= 1 ? [interpolate(a, t)] : [];
}
const boundsOverlap = (a, b) => a.minX <= b.maxX + EPS && b.minX <= a.maxX + EPS && a.minZ <= b.maxZ + EPS && b.minZ <= a.maxZ + EPS;
const roomsTouch = (a, b) => boundsOverlap(a.bounds, b.bounds) && a.edges.some(x => b.edges.some(y => contacts(x, y).length));
const wallTouchesRoom = (wall, room) => boundsOverlap(wall.bounds, room.bounds)
  && (pointInPolygon(wall.value.start, room.value.polygon) || pointInPolygon(wall.value.end, room.value.polygon)
    || room.edges.some(edge => contacts(wall.value, edge).length));

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
  const roomShapes = floor.rooms.map(value => ({ value, bounds: roomBounds(value), edges: edges(value) }));
  const wallShapes = floor.walls.map(value => ({ value, bounds: {
    minX: Math.min(value.start[0], value.end[0]), maxX: Math.max(value.start[0], value.end[0]),
    minZ: Math.min(value.start[1], value.end[1]), maxZ: Math.max(value.start[1], value.end[1]),
  } }));
  // Local to this call: callers may mutate a floor between edits. A queue visits
  // each discovered object once, independent of the registry/room order.
  const pending = [roomShapes.find(room => room.value.id === id)];
  for (let index = 0; index < pending.length; index++) {
    const current = pending[index];
    for (const room of roomShapes) if (!rooms.has(room.value.id)
      && (current.edges ? roomsTouch(current, room) : wallTouchesRoom(current, room))) {
      rooms.add(room.value.id); pending.push(room);
    }
    for (const wall of wallShapes) if (!walls.has(wall.value.id)
      && (current.edges ? wallTouchesRoom(wall, current) : boundsOverlap(wall.bounds, current.bounds) && contacts(wall.value, current.value).length)) {
      walls.add(wall.value.id); pending.push(wall);
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

function rectangular(room, b = roomBounds(room)) {
  if (room.polygon.length !== 4) return false;
  return room.polygon.every(p => (near(p[0], b.minX) || near(p[0], b.maxX)) && (near(p[1], b.minZ) || near(p[1], b.maxZ)))
    && edges(room).every(e => near(e.start[0], e.end[0]) || near(e.start[1], e.end[1]));
}
function sharedSide(a, b) {
  if (!a.rectangular || !b.rectangular) return null;
  const x = a.bounds, y = b.bounds;
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
  const shapes = floor.rooms.map(value => {
    const bounds = roomBounds(value);
    return { value, bounds, edges: edges(value), rectangular: rectangular(value, bounds) };
  });
  const links = new Map();
  const link = (a, b) => { if (!links.has(a)) links.set(a, new Set()); links.get(a).add(b); };
  // Build each shared-side constraint once. Traversing from the selected room's
  // four bounds below naturally ignores disconnected components. Corner-only
  // contacts remain protected by the full contact checks after propagation.
  for (let i = 0; i < shapes.length; i++) for (let j = i + 1; j < shapes.length; j++) {
    const a = shapes[i], b = shapes[j], sides = sharedSide(a, b);
    if (!sides) continue;
    for (const [x, y] of sides) { link(`${a.value.id}:${x}`, `${b.value.id}:${y}`); link(`${b.value.id}:${y}`, `${a.value.id}:${x}`); }
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
  for (const shape of shapes) {
    const room = shape.value, before = shape.bounds, after = { ...before };
    for (const bound of ['minX', 'maxX', 'minZ', 'maxZ']) if (assigned.has(`${room.id}:${bound}`)) after[bound] = assigned.get(`${room.id}:${bound}`);
    if (after.maxX - after.minX < .05 - EPS || after.maxZ - after.minZ < .05 - EPS) throw new Error('The resize would collapse or invert a neighboring room. Reduce the change.');
    transforms.set(room.id, affine(before, after));
  }
  // Preserve every existing room contact, including partial sides and corners.
  // An unsupported junction fails before any caller-owned object is modified.
  for (let i = 0; i < shapes.length; i++) for (let j = i + 1; j < shapes.length; j++) {
    const a = shapes[i], b = shapes[j];
    if (!boundsOverlap(a.bounds, b.bounds)) continue;
    for (const x of a.edges) for (const y of b.edges) for (const p of contacts(x, y)) {
      if (distance(transforms.get(a.value.id)(p), transforms.get(b.value.id)(p)) > .002) throw attachmentError();
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
    for (const shape of shapes) for (const edge of shape.edges) for (const p of contacts(wall, edge)) {
      if (projectOnWall(transforms.get(shape.value.id)(p), moved).distance > .002) throw attachmentError();
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
