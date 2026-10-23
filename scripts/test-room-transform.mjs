import assert from 'node:assert/strict';
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
console.log('Room transforms passed: owned and connected moves, rectangular shared boundaries, four-room junctions, attachments, fixed opening widths, item placement, collision/inversion rejection, and immutable rollback.');
