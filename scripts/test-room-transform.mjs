import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { newFloor, outlineRoom, validateProject } from '../planner/model.js';
import { moveRoom, resizeRoom, roomMoveGroup } from '../planner/room-transform.js';

const clone = value => structuredClone(value);
const room = (id, x, z, width = 4, depth = 4) => ({ id, name: id, material: 'floor', polygon: [[x, z], [x + width, z], [x + width, z + depth], [x, z + depth]] });
const item = (id, owner, x, z) => ({ id, name: id, type: 'furniture', room: owner, position_m: { x, y: .2, z }, dimensions_m: { width: .6, depth: .4, height: .5 }, rotation_deg: 25, entity_id: '', notes: '' });
const opening = (id, wall, offset = 1, width = 1) => ({ id, wall_id: wall, type: 'door', offset_m: offset, width_m: width, sill_m: 0, head_m: 2 });
function fixture(neighbor = false) {
  const floor = newFloor();
  floor.rooms.push(room('study', 0, 0));
  if (neighbor) floor.rooms.push(room('kitchen', 4, 0));
  for (const value of floor.rooms) { outlineRoom(floor, value); floor.items.push(item(`item_${value.id}`, value.id, value.polygon[0][0] + 2, 2)); }
  floor.openings.push(opening('entry', floor.walls[0].id));
  if (neighbor) floor.openings.push(opening('shared_door', floor.walls[1].id));
  return floor;
}
function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
function fails(floor, run, pattern) {
  const before = clone(floor);
  assert.throws(() => run(frozen(floor)), pattern);
  assert.deepEqual(floor, before, 'Rejected edits preserve every original object');
}
const valid = floor => validateProject({ schema_version: 1, title: 'Geometry test', floors: [floor] });

const solo = frozen(fixture());
let result = moveRoom(solo, 'study', 1.25, -.5);
assert.deepEqual(result.rooms[0].polygon, [[1.25, -.5], [5.25, -.5], [5.25, 3.5], [1.25, 3.5]]);
assert.deepEqual(result.walls[0].start, [1.25, -.5]);
assert.deepEqual(result.walls[0].end, [5.25, -.5]);
assert.deepEqual(result.openings, solo.openings);
assert.deepEqual(result.items[0].position_m, { x: 3.25, y: .2, z: 1.5 });
assert.deepEqual(result.items[0].dimensions_m, solo.items[0].dimensions_m);
assert.deepEqual(moveRoom(result, 'study', -1.25, .5), solo, 'A rigid move is reversible');

const joined = frozen(fixture(true));
assert.deepEqual(roomMoveGroup(joined, 'study').rooms, ['study', 'kitchen']);
fails(joined, floor => moveRoom(floor, 'study', 1, 0), /Move connected rooms together/);
result = moveRoom(joined, 'study', 1, -1, { connected: true });
assert.deepEqual(result.rooms[1].polygon, [[5, -1], [9, -1], [9, 3], [5, 3]]);
assert.deepEqual(result.items.map(value => value.position_m), [{ x: 3, y: .2, z: 1 }, { x: 7, y: .2, z: 1 }]);
assert.deepEqual(result.openings, joined.openings);
assert.equal(result.walls.length, 7, 'The shared wall remains one segment');

const attached = fixture();
attached.walls.push({ id: 'extension', start: [4, 4], end: [6, 4], thickness_m: .15 });
attached.walls.push({ id: 'tail', start: [6, 4], end: [6, 6], thickness_m: .15 });
fails(attached, floor => moveRoom(floor, 'study', 1, 0), /shares geometry/);
result = moveRoom(attached, 'study', 1, 0, { connected: true });
assert.deepEqual(result.walls.at(-1).end, [7, 6], 'Connected move includes a chain of external wall attachments');

result = resizeRoom(solo, 'study', 6, 4);
assert.deepEqual(result.rooms[0].polygon, [[0, 0], [6, 0], [6, 4], [0, 4]]);
assert.deepEqual(result.walls[1].start, [6, 0]);
assert.deepEqual(result.items[0].position_m, { x: 3, y: .2, z: 2 });
assert.equal(result.openings[0].offset_m, 1.75);
assert.equal(result.openings[0].width_m, 1);
assert.equal(result.items[0].rotation_deg, 25);

result = resizeRoom(joined, 'study', 5, 5);
assert.deepEqual(result.rooms[0].polygon, [[0, 0], [5, 0], [5, 5], [0, 5]]);
assert.deepEqual(result.rooms[1].polygon, [[5, 0], [8, 0], [8, 5], [5, 5]]);
assert.deepEqual(result.walls[1].start, [5, 0]);
assert.deepEqual(result.walls[1].end, [5, 5]);
assert.deepEqual(result.items.map(value => value.position_m), [{ x: 2.5, y: .2, z: 2.5 }, { x: 6.5, y: .2, z: 2.5 }]);
assert.equal(result.openings[1].width_m, 1);
assert.equal(result.openings[1].offset_m, 1.375);
valid(result);
fails(joined, floor => resizeRoom(floor, 'study', 8, 4), /collapse or invert/);
fails(joined, floor => resizeRoom(floor, 'study', -1, 4), /at least/);

const continuous = fixture(true);
continuous.walls = [{ id: 'long_north', start: [0, 0], end: [8, 0], thickness_m: .15 },
  { id: 'divider', start: [4, 0], end: [4, 4], thickness_m: .15 },
  { id: 'long_south', start: [0, 4], end: [8, 4], thickness_m: .15 }];
continuous.openings = [opening('window', 'long_north')];
result = resizeRoom(continuous, 'study', 5, 4);
assert.deepEqual(result.walls[0], continuous.walls[0], 'A shared junction can slide along a continuous straight exterior wall');
assert.deepEqual(result.walls[1].start, [5, 0]);
assert.deepEqual(result.openings, continuous.openings);

// All four corner anchors and both wall directions preserve shared vertices.
for (const anchor of [[0, 0], [4, 0], [4, 4], [0, 4]]) {
  result = resizeRoom(joined, 'study', 4.5, 4.5, anchor);
  valid(result);
  const shared = result.walls[1];
  assert(result.rooms[0].polygon.some(p => JSON.stringify(p) === JSON.stringify(shared.start)));
  assert(result.rooms[1].polygon.some(p => JSON.stringify(p) === JSON.stringify(shared.end)));
}
const grid = fixture(true);
grid.rooms.push(room('southwest', 0, 4), room('southeast', 4, 4));
outlineRoom(grid, grid.rooms[2]); outlineRoom(grid, grid.rooms[3]);
result = resizeRoom(grid, 'study', 5, 5);
assert.deepEqual(result.rooms[3].polygon, [[5, 5], [8, 5], [8, 8], [5, 8]], 'Shared coordinates propagate through a four-room junction');
valid(result);

const partial = fixture();
partial.rooms.push(room('partial', 4, 1, 4, 2));
fails(partial, floor => resizeRoom(floor, 'study', 5, 4), /attached boundary/);
const diagonal = fixture();
diagonal.rooms.push(room('diagonal', 4, 4));
fails(diagonal, floor => resizeRoom(floor, 'study', 5, 4), /attached boundary/);

// Internal partitions and T-junctions transform with the room. Extensions can
// stretch when their endpoint junction remains representable by straight walls.
const partitions = fixture();
partitions.walls.push({ id: 'partition', start: [2, 0], end: [2, 3], thickness_m: .15 });
result = resizeRoom(partitions, 'study', 6, 4);
assert.deepEqual(result.walls.at(-1).start, [3, 0]);
assert.deepEqual(result.walls.at(-1).end, [3, 3]);
result = resizeRoom(attached, 'study', 5, 4);
assert.deepEqual(result.walls.at(-2).start, [5, 4]);
assert.deepEqual(result.walls.at(-2).end, [6, 4]);

const collision = fixture();
collision.rooms.push(room('distant', 6, 0));
fails(collision, floor => moveRoom(floor, 'study', 3, 0), /overlap/);
fails(collision, floor => resizeRoom(floor, 'study', 7, 4), /overlap/);
const competingOpenings = fixture();
competingOpenings.openings = [opening('one', 'wall_1', 0, 1.8), opening('two', 'wall_1', 2.2, 1.8)];
fails(competingOpenings, floor => resizeRoom(floor, 'study', 3, 4), /cannot overlap/);
fails(solo, floor => resizeRoom(floor, 'study', .5, 4), /too short/);

const precise = fixture();
precise.rooms.push(room('distant', 20.12345, 20.45678));
precise.items.push(item('precise_item', 'distant', 21.12345, 21.45678));
outlineRoom(precise, precise.rooms[1]);
const untouchedWalls = clone(precise.walls.slice(4));
result = resizeRoom(precise, 'study', 5, 4);
assert.deepEqual(result.rooms[1], precise.rooms[1], 'Unrelated imported precision is unchanged');
assert.deepEqual(result.items[1], precise.items[1]);
assert.deepEqual(result.walls.slice(4), untouchedWalls);

// Dense floors expose repeated component scans, especially when the selected
// room is last in registry order. Assert geometry rather than a machine-speed
// threshold; report median CPU times so performance regressions are reviewable.
function denseFloor(columns, rows) {
  const floor = newFloor();
  for (let z = 0; z < rows; z++) for (let x = 0; x < columns; x++) {
    const value = room(`dense_${x}_${z}`, x * 3, z * 3, 3, 3);
    floor.rooms.push(value); outlineRoom(floor, value);
    floor.items.push(item(`device_${x}_${z}`, value.id, x * 3 + 1, z * 3 + 1));
  }
  floor.openings = floor.walls.filter((_, i) => i % 4 === 0).map(wall => opening(`door_${wall.id}`, wall.id, 1, .8));
  valid(floor); return floor;
}
const timings = [];
for (const [columns, rows] of [[6, 5], [8, 8]]) {
  const dense = frozen(denseFloor(columns, rows)), last = `dense_${columns - 1}_${rows - 1}`;
  for (const reordered of [dense, frozen({ ...clone(dense), rooms: clone(dense.rooms).reverse(), walls: clone(dense.walls).reverse() })]) {
    assert.equal(roomMoveGroup(reordered, last).rooms.length, columns * rows);
    const resized = resizeRoom(reordered, last, 3.2, 3.1);
    for (const original of reordered.rooms) {
      const actual = resized.rooms.find(value => value.id === original.id);
      assert.deepEqual(actual.polygon, original.polygon.map(([x, z]) => [x === columns * 3 ? x + .2 : x, z === rows * 3 ? z + .1 : z]),
        'Shared outer coordinates propagate independent of room ordering; other coordinates stay exact');
    }
    assert.deepEqual(resized.openings.map(value => value.width_m), reordered.openings.map(value => value.width_m));
    const unchangedWalls = new Set(reordered.walls.filter(wall => wall.start[0] < (columns - 1) * 3 && wall.end[0] < (columns - 1) * 3
      && wall.start[1] < (rows - 1) * 3 && wall.end[1] < (rows - 1) * 3).map(wall => wall.id));
    assert.deepEqual(resized.openings.filter(value => unchangedWalls.has(value.wall_id)), reordered.openings.filter(value => unchangedWalls.has(value.wall_id)));
    valid(resized);
    const shifted = moveRoom(reordered, last, .25, -.25, { connected: true });
    assert.deepEqual(shifted.openings, reordered.openings);
    for (let index = 0; index < shifted.rooms.length; index++) assert.deepEqual(shifted.rooms[index].polygon,
      reordered.rooms[index].polygon.map(([x, z]) => [x + .25, z - .25]));
  }
  const benchmarkFloor = clone(dense);
  for (const [operation, run] of [['group', () => roomMoveGroup(benchmarkFloor, last)], ['move', () => moveRoom(benchmarkFloor, last, .25, .25, { connected: true })],
    ['resize', () => resizeRoom(benchmarkFloor, last, 3.2, 3.1)]]) {
    const elapsed = [];
    for (let sample = 0; sample < 7; sample++) { const start = performance.now(); run(); if (sample > 1) elapsed.push(performance.now() - start); }
    timings.push({ rooms: dense.rooms.length, operation, medianMs: Number(elapsed.sort((a, b) => a - b)[2].toFixed(2)) });
  }
}

const mutable = fixture(true);
assert.equal(roomMoveGroup(mutable, 'study').rooms.length, 2);
mutable.walls = []; mutable.openings = [];
mutable.rooms[1].polygon = mutable.rooms[1].polygon.map(([x, z]) => [x + 20, z]);
assert.deepEqual(roomMoveGroup(mutable, 'study').rooms, ['study'], 'In-place geometry changes never reuse stale contact data');
const almostTouching = newFloor();
almostTouching.rooms = [room('first', 0, 0), room('second', 4 + .0000005, 0)];
assert.equal(roomMoveGroup(almostTouching, 'first').rooms.length, 2, 'Broad-phase bounds preserve the existing contact tolerance');

function curtainFloor(reverse = false) {
  const floor = newFloor(); floor.rooms.push(room('study', 0, 0, 5, 4)); outlineRoom(floor, floor.rooms[0]);
  if (reverse) [floor.walls[0].start, floor.walls[0].end] = [floor.walls[0].end, floor.walls[0].start];
  floor.openings.push({ ...opening('window', floor.walls[0].id, 0, 2), type: 'window', sill_m: .7, head_m: 2.3 });
  floor.items.push({ id: 'curtain', name: 'Bound curtain', type: 'furniture', model_id: 'curtain_pair_closed', style_id: 'scandinavian',
    room: 'study', position_m: { x: reverse ? 4 : 1, y: .03, z: .2 }, dimensions_m: { width: 2.2, depth: .18, height: 2.4 },
    rotation_deg: reverse ? 180 : 0, entity_id: 'cover.fixture', notes: '', curtain: { opening_id: 'window', mode: 'pair' } });
  valid(floor); return floor;
}
for (const reverse of [false, true]) {
  const original = frozen(curtainFloor(reverse));
  const narrowed = resizeRoom(original, 'study', 2, 4);
  assert.equal(narrowed.openings[0].width_m, 2); assert.equal(narrowed.openings[0].offset_m, 0);
  assert.deepEqual(narrowed.items[0].position_m, { x: 1, y: .03, z: .2 }, 'Curtain follows the clamped fixed-width window center');
  const expanded = resizeRoom(original, 'study', 10, 40);
  assert.deepEqual(expanded.items[0].position_m, { x: reverse ? 8 : 2, y: .03, z: .2 }, 'Wall clearance is a measured offset, not room-scaled depth');
  assert.deepEqual(expanded.items[0].dimensions_m, original.items[0].dimensions_m);
  assert.equal(expanded.items[0].rotation_deg, original.items[0].rotation_deg);
}

function frame(floor) {
  const opening = floor.openings[0], wall = floor.walls.find(value => value.id === opening.wall_id);
  const delta = [wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]], length = Math.hypot(...delta), u = delta.map(value => value / length);
  const center = wall.start.map((value, axis) => value + u[axis] * (opening.offset_m + opening.width_m / 2));
  return { u, center, angle: Math.atan2(delta[1], delta[0]) * 180 / Math.PI };
}
const slanted = curtainFloor();
slanted.rooms[0].polygon = [[0, 0], [4, 2], [4, 6], [0, 4]]; slanted.walls = [];
outlineRoom(slanted, slanted.rooms[0]); slanted.openings[0].wall_id = slanted.walls[0].id;
const beforeFrame = frame(slanted), along = .3, clearance = -.2;
slanted.items[0].position_m.x = beforeFrame.center[0] + along * beforeFrame.u[0] - clearance * beforeFrame.u[1];
slanted.items[0].position_m.z = beforeFrame.center[1] + along * beforeFrame.u[1] + clearance * beforeFrame.u[0];
slanted.items[0].rotation_deg = 180 - beforeFrame.angle;
const slantedResult = resizeRoom(frozen(slanted), 'study', 8, 6), afterFrame = frame(slantedResult), slantedItem = slantedResult.items[0];
const delta = [slantedItem.position_m.x - afterFrame.center[0], slantedItem.position_m.z - afterFrame.center[1]];
assert(Math.abs(delta[0] * afterFrame.u[0] + delta[1] * afterFrame.u[1] - along) < .001, 'Diagonal resize preserves the tangent offset');
assert(Math.abs(-delta[0] * afterFrame.u[1] + delta[1] * afterFrame.u[0] - clearance) < .001, 'Diagonal resize preserves signed wall clearance');
assert(Math.abs(slantedItem.rotation_deg - (180 - afterFrame.angle)) < .001, 'The authored reversed facing follows the wall turn');
assert.equal(slantedItem.position_m.y, slanted.items[0].position_m.y);
assert.deepEqual(slantedItem.dimensions_m, slanted.items[0].dimensions_m);

const mismatchedRoom = curtainFloor();
mismatchedRoom.rooms.push(room('distant', 20, 20)); outlineRoom(mismatchedRoom, mismatchedRoom.rooms[1]);
mismatchedRoom.openings.push({ ...mismatchedRoom.openings[0], id: 'remote_window', wall_id: mismatchedRoom.walls[4].id });
mismatchedRoom.items[0].room = 'distant';
mismatchedRoom.items.push({ ...clone(mismatchedRoom.items[0]), id: 'remote_curtain', room: 'study',
  curtain: { opening_id: 'remote_window', mode: 'left' }, position_m: { x: 21.12345, y: .03, z: 20.23456 }, rotation_deg: 13.12345 });
const remoteBefore = clone(mismatchedRoom.items[1]);
result = resizeRoom(frozen(mismatchedRoom), 'study', 10, 4);
assert.equal(result.items[0].position_m.x, 2, 'The bound window takes precedence over a stationary assigned room');
assert.deepEqual(result.items[1], remoteBefore, 'A stationary bound window prevents unrelated room scaling and precision loss');
result = moveRoom(mismatchedRoom, 'study', 1, 1);
assert.deepEqual(result.items[0].position_m, { x: 2, y: .03, z: 1.2 }, 'Rigid moves also follow the bound window across room assignments');
assert.deepEqual(result.items[1], remoteBefore);
console.log('Dense room transform CPU medians:', JSON.stringify(timings));
console.log('Room transforms passed: owned and connected moves, rectangular shared boundaries, four-room junctions, attachments, fixed opening widths, item placement, collision/inversion rejection, and immutable rollback.');
