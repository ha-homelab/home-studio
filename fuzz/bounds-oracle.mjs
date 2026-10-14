import assert from 'node:assert/strict';
import { floorBounds } from '../planner/model.js';

export function near(actual, expected, tolerance = 1e-7) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
}

// Independent support-radius formula; production transforms all four corners.
export function assertFloorBounds(floor) {
  const x = [], z = [];
  for (const [px, pz] of [...floor.rooms.flatMap(room => room.polygon), ...floor.walls.flatMap(wall => [wall.start, wall.end])]) {
    x.push(px); z.push(pz);
  }
  for (const item of floor.items) {
    const radians = item.rotation_deg * Math.PI / 180;
    const c = Math.abs(Math.cos(radians)), s = Math.abs(Math.sin(radians));
    const rx = (item.dimensions_m.width * c + item.dimensions_m.depth * s) / 2;
    const rz = (item.dimensions_m.width * s + item.dimensions_m.depth * c) / 2;
    x.push(item.position_m.x - rx, item.position_m.x + rx);
    z.push(item.position_m.z - rz, item.position_m.z + rz);
  }
  const expected = x.length
    ? { minX: Math.min(...x), maxX: Math.max(...x), minZ: Math.min(...z), maxZ: Math.max(...z) }
    : { minX: -1, maxX: 11, minZ: -1, maxZ: 8 };
  const actual = floorBounds(floor);
  for (const key of Object.keys(expected)) near(actual[key], expected[key]);
  return actual;
}
