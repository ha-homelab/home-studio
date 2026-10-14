import assert from 'node:assert/strict';
import { validateProject, wallPieces, floorBounds, LIMITS } from '../planner/model.js';
import { ValidationError } from '../planner/validation.js';
import { assertFloorBounds } from './bounds-oracle.mjs';

export function assertExpectedValidationError(error) {
  // Only the validator's two deliberate rejection classes are allowed.
  assert.ok(error?.constructor === Error || error?.constructor === ValidationError);
  assert.ok(error.message.length > 0);
}

function accepted(value, complete = false) {
  try { validateProject(value, { complete }); return true; }
  catch (error) {
    // Localized validation guidance is deliberate; runtime errors remain bugs.
    assertExpectedValidationError(error);
    return false;
  }
}

export function fuzz(data) {
  if (data.length > 65536) return;
  let project;
  try { project = JSON.parse(data.toString('utf8')); }
  catch (error) { if (error instanceof SyntaxError) return; throw error; }
  const before = JSON.stringify(project);
  const valid = accepted(project);
  assert.equal(JSON.stringify(project), before, 'validation must not mutate input');
  if (!valid) return;
  assert.ok(project.floors.length > 0 && project.floors.length <= LIMITS.floors);
  assert.ok(accepted(JSON.parse(before)), 'accepted JSON round trip');
  assert.equal(accepted(project, true), project.floors.every(floor => floor.rooms.length > 0));
  for (const floor of project.floors) {
    assertFloorBounds(floor);
    const bounds = floorBounds(floor);
    assert.ok(Object.values(bounds).every(Number.isFinite));
    assert.ok(bounds.minX <= bounds.maxX && bounds.minZ <= bounds.maxZ);
    const ids = ['rooms', 'walls', 'openings', 'items'].flatMap(key => floor[key].map(item => item.id));
    assert.equal(new Set(ids).size, ids.length, 'accepted identifiers must be unique');
    for (const wall of floor.walls) {
      const pieces = wallPieces(wall, floor.openings, floor.height_m);
      for (const piece of pieces) {
        assert.ok(Object.values(piece).every(Number.isFinite));
        assert.ok(piece.width > 0 && piece.height > 0 && piece.offset >= -1e-8 && piece.bottom >= 0);
        assert.ok(piece.bottom + piece.height <= floor.height_m + 1e-8);
      }
    }
  }
  // A valid document cannot smuggle undeclared input or prototype identifiers.
  const extra = JSON.parse(before); extra.unrecognized_field = true;
  assert.equal(accepted(extra), false);
  const reserved = JSON.parse(before); reserved.floors[0].id = '__proto__';
  assert.equal(accepted(reserved), false);
}
