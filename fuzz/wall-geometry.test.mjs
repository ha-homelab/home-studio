import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { validateProject } from '../planner/model.js';
import { ValidationError } from '../planner/validation.js';
import { assertFloorBounds, near } from './bounds-oracle.mjs';
import { fuzz } from './wall-geometry.mjs';

test('geometry seeds and coordinate extrema replay deterministically', () => {
  const corpus = new URL('./corpus/wall-geometry/', import.meta.url);
  for (const name of readdirSync(corpus)) fuzz(readFileSync(new URL(name, corpus)));
  for (let value = 0; value <= 255; value++) fuzz(Buffer.alloc(14, value));
});

test('positive furniture seed is accepted and each negative seed is rejected', () => {
  const corpus = new URL('./corpus/project-validation/', import.meta.url);
  const load = name => JSON.parse(readFileSync(new URL(name, corpus), 'utf8'));
  const valid = load('furniture-valid.json');
  assert.equal(validateProject(valid, { complete: true }), valid);
  for (const name of readdirSync(corpus).filter(name => name.startsWith('furniture-invalid-'))) {
    assert.throws(() => validateProject(load(name)), ValidationError, name);
  }
});

test('rotated asymmetric item has exact isolated bounds', () => {
  const item = { position_m: { x: 5, z: -3 }, dimensions_m: { width: 4, depth: 2 }, rotation_deg: 90 };
  const floor = { rooms: [], walls: [], items: [item] };
  const quarterTurn = assertFloorBounds(floor);
  for (const [key, expected] of Object.entries({ minX: 4, maxX: 6, minZ: -5, maxZ: -1 })) near(quarterTurn[key], expected);
  item.rotation_deg = 45;
  const bounds = assertFloorBounds(floor), radius = 3 / Math.sqrt(2);
  near(bounds.minX, 5 - radius); near(bounds.maxX, 5 + radius);
  near(bounds.minZ, -3 - radius); near(bounds.maxZ, -3 + radius);
});
