#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CATALOG, buildFurnitureAsset, createFurnitureItemFields, getCatalogModel, validateFurnitureAppearance } from '../planner/furniture.js';
import { blankProject, clone, demoProject, floorBounds, validateProject } from '../planner/model.js';

function itemFor(model, index = 0) {
  return { id: 'catalog_' + model.id, name: model.label, type: model.type,
    model_id: model.id, style_id: CATALOG.styles[index % CATALOG.styles.length].id,
    ...(index % 3 === 0 ? { color: '#e7513d' } : {}), room: 'living',
    position_m: { x: 3, y: 0, z: 2 }, dimensions_m: { ...model.dimensions_m },
    rotation_deg: 37, entity_id: '', notes: '' };
}
const fixtures = CATALOG.models.map((model, index) => {
  const item = itemFor(model, index);
  return { item, asset: buildFurnitureAsset(item) };
});
if (process.argv.includes('--fixtures')) {
  process.stdout.write(JSON.stringify(fixtures));
} else {
  assert.equal(getCatalogModel('missing'), null);
  assert.equal(CATALOG.models.length, 40);
  assert.equal(new Set(CATALOG.models.map(model => model.id)).size, CATALOG.models.length);
  const legacy = JSON.parse(readFileSync(new URL('../planner/example-home.json', import.meta.url)));
  validateProject(legacy, { complete: true });
  assert.equal(buildFurnitureAsset(legacy.floors[0].items[0]), null);
  validateProject(demoProject(), { complete: true });
  for (const [index, { item, asset }] of fixtures.entries()) {
    const model = CATALOG.models[index], before = JSON.stringify(item);
    assert.equal(asset.meshes.length, model.parts.length);
    assert.ok(asset.meshes.length > 1 && asset.meshes.length <= 32);
    assert.ok(model.parts.some(part => part.material === 'body'), `${model.id}: custom color needs a body surface`);
    assert.equal(createFurnitureItemFields(model.id).model_id, model.id);
    const bounds = [[], [], []];
    for (const [partIndex, mesh] of asset.meshes.entries()) {
      const center = model.parts[partIndex].center;
      assert.equal(mesh.vertices.length, mesh.normals.length);
      assert.equal(mesh.vertices.length, mesh.indices.length);
      assert.ok(mesh.vertices.length <= 144);
      assert.equal(mesh.kind, 'inventory');
      assert.ok(Object.hasOwn(asset.materials, mesh.material));
      for (let i = 0; i < mesh.vertices.length; i++) {
        const point = mesh.vertices[i], normal = mesh.normals[i];
        assert.equal(mesh.indices[i], i);
        assert.ok(point.every(Number.isFinite));
        assert.ok(Math.abs(Math.hypot(...normal) - 1) < 1e-10);
        assert.ok(point.reduce((sum, value, axis) => sum + (value - center[axis]) * normal[axis], 0) > 0, `${model.id}: outward normals`);
        for (let axis = 0; axis < 3; axis++) bounds[axis].push(point[axis]);
      }
    }
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(Math.abs(Math.min(...bounds[axis]) - (axis === 1 ? 0 : -.5)) < 1e-8, `${model.id}: minimum bounds`);
      assert.ok(Math.abs(Math.max(...bounds[axis]) - (axis === 1 ? 1 : .5)) < 1e-8, `${model.id}: maximum bounds`);
    }
    const p = clone(legacy); p.floors[0].items = [{ ...item, room: p.floors[0].rooms[0].id }];
    validateProject(p, { complete: true });
    assert.equal(JSON.stringify(item), before, 'geometry does not mutate inventory');
    const custom = buildFurnitureAsset({ ...item, color: '#A1B2C3' });
    assert.ok(Object.hasOwn(custom.materials, 'furniture_a1b2c3'));
    const noStyle = { ...item }; delete noStyle.style_id;
    assert.ok(buildFurnitureAsset(noStyle));
  }
  for (const patch of [{ model_id: 'unknown' }, { model_id: null }, { model_id: {} },
    { style_id: 'unknown' }, { style_id: null }, { style_id: [] },
    { color: '#fff' }, { color: '#12345678' }, { color: 'red' }, { color: 1 }, { color: null }, { type: 'sensor' }]) {
    const p = clone(legacy); p.floors[0].items = [{ ...fixtures[0].item, ...patch, room: p.floors[0].rooms[0].id }];
    assert.throws(() => validateProject(p), Error);
  }
  assert.throws(() => validateFurnitureAppearance({ type: 'furniture', style_id: 'contemporary' }), Error);
  assert.throws(() => validateFurnitureAppearance({ type: 'furniture', color: '#aabbcc' }), Error);
  const bounds = floorBounds({ rooms: [], walls: [], items: [{ ...fixtures[0].item,
    dimensions_m: { width: 2, height: 1, depth: 1 }, position_m: { x: 0, y: 0, z: 0 }, rotation_deg: 90 }] });
  assert.ok(Math.abs(bounds.minX + .5) < 1e-10 && Math.abs(bounds.maxX - .5) < 1e-10);
  assert.ok(Math.abs(bounds.minZ + 1) < 1e-10 && Math.abs(bounds.maxZ - 1) < 1e-10);
  validateProject(blankProject());
  console.log('Furniture JS: 40 models, dimensions, outward normals, color overrides and project compatibility passed.');
}
