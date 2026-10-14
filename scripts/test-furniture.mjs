#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CATALOG, buildFurnitureAsset, createFurnitureItemFields, getCatalogModel, primitive, validateFurnitureAppearance } from '../planner/furniture.js';
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
const primitiveFixtures = ['box', 'cylinder', 'sphere', 'ring'].flatMap(shape =>
  [undefined, [90, 0, 0], [0, 90, 0], [0, 0, 90], [23, -41, 67]].map(rotation_deg => {
    const part = { shape, center: [.07, .4, -.1], size: [.4, .5, .3],
      ...(rotation_deg ? { rotation_deg } : {}), ...(shape === 'ring' ? { inner_ratio: .61 } : {}) };
    return { part, mesh: primitive(part) };
  }));

function unrotate(point, rotation = [0, 0, 0]) {
  let [x, y, z] = point;
  for (const axis of [2, 1, 0]) {
    const angle = -rotation[axis]*Math.PI/180, c = Math.cos(angle), s = Math.sin(angle);
    if (axis === 0) [y, z] = [c*y-s*z, s*y+c*z];
    if (axis === 1) [x, z] = [c*x+s*z, -s*x+c*z];
    if (axis === 2) [x, y] = [c*x-s*y, s*x+c*y];
  }
  return [x, y, z];
}

function verifyPrimitive(part, mesh) {
  const vertexCounts = { box: 36, cylinder: 144, sphere: 144, ring: 288 };
  assert.equal(mesh.vertices.length, vertexCounts[part.shape]);
  assert.equal(mesh.vertices.length, mesh.normals.length);
  assert.equal(mesh.vertices.length, mesh.indices.length);
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    const [a, b, c] = mesh.vertices.slice(i, i+3);
    const u = b.map((v, axis) => v-a[axis]), v = c.map((n, axis) => n-a[axis]);
    const cross = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
    assert.ok(Math.hypot(...cross) > 1e-14, `${part.shape}: nondegenerate triangles`);
    for (let corner = 0; corner < 3; corner++) {
      const index = i+corner, point = mesh.vertices[index], normal = mesh.normals[index];
      assert.equal(mesh.indices[index], index);
      assert.ok(point.every(Number.isFinite));
      assert.ok(normal.every(Number.isFinite));
      assert.ok(Math.abs(Math.hypot(...normal)-1) < 1e-10);
      assert.ok(cross.every((value, axis) => Math.abs(value/Math.hypot(...cross)-normal[axis]) < 1e-10));
      const local = unrotate(point.map((value, axis) => value-part.center[axis]), part.rotation_deg);
      const direction = unrotate(normal, part.rotation_deg);
      let outward = local.reduce((sum, value, axis) => sum+value*direction[axis], 0);
      if (part.shape === 'ring') {
        if (Math.abs(direction[1]) > .5) outward = local[1]*direction[1];
        else {
          const radius = Math.hypot(2*local[0]/part.size[0], 2*local[2]/part.size[2]);
          outward = (local[0]*direction[0]+local[2]*direction[2])*(radius < (1+(part.inner_ratio ?? .72))/2 ? -1 : 1);
        }
      }
      assert.ok(outward > 0, `${part.shape}: outward surface normals, including ring interior`);
    }
  }
}

if (process.argv.includes('--primitive-fixtures')) {
  process.stdout.write(JSON.stringify(primitiveFixtures));
} else if (process.argv.includes('--fixtures')) {
  process.stdout.write(JSON.stringify(fixtures));
} else {
  assert.equal(getCatalogModel('missing'), null);
  const legacyIds = ['sofa_2', 'sofa_3', 'corner_sofa', 'armchair', 'dining_chair', 'bench', 'stool',
    'dining_table', 'round_dining_table', 'coffee_table', 'round_coffee_table', 'side_table', 'desk',
    'single_bed', 'double_bed', 'bunk_bed', 'wardrobe', 'dresser', 'bookcase', 'tv_console', 'nightstand',
    'television', 'kitchen_cabinet', 'kitchen_island', 'refrigerator', 'oven', 'kitchen_sink', 'washing_machine',
    'bathtub', 'toilet', 'bathroom_vanity', 'rug', 'round_rug', 'plant', 'wall_art', 'mirror',
    'floor_lamp', 'table_lamp', 'pendant', 'ceiling_light'];
  for (const id of legacyIds) assert.ok(getCatalogModel(id), `legacy model ${id} remains available`);
  const expandedIds = ['tesla_model_3', 'tesla_model_y', 'tesla_model_s', 'tesla_cybertruck', 'cargo_van',
    'classic_compact_car', 'cafe_racer_motorcycle', 'adventure_motorcycle', 'retro_moped', 'electric_kick_scooter',
    'city_bicycle', 'road_bicycle', 'mountain_bicycle', 'cargo_bicycle', 'child_bicycle', 'skis_and_poles',
    'snowboard', 'skateboard', 'surfboard', 'kayak', 'golf_bag', 'satellite_dish', 'flat_satellite_terminal',
    'solar_panel', 'kettle_grill', 'gas_grill', 'push_lawnmower', 'wheeled_waste_bin', 'wheeled_recycling_bin',
    'garden_bench', 'patio_lounge_chair', 'patio_umbrella', 'teddy_bear', 'plush_bunny', 'server_rack',
    'wall_network_cabinet', 'rack_server', 'nas_storage', 'ups_battery', 'wifi_router', 'wifi_access_point',
    'desktop_pc', 'laptop', 'computer_monitor', 'office_printer', 'printer_3d', 'rocking_horse', 'toy_chest',
    'dollhouse', 'toy_car', 'building_blocks', 'acoustic_guitar', 'upright_piano', 'digital_keyboard',
    'art_easel', 'sewing_machine', 'hobby_workbench', 'telescope', 'coffee_machine', 'microwave', 'dishwasher',
    'stick_vacuum', 'ironing_board', 'air_purifier'];
  for (const id of expandedIds) assert.ok(getCatalogModel(id), `expanded catalog includes ${id}`);
  assert.equal(new Set(CATALOG.models.map(model => model.id)).size, CATALOG.models.length);
  for (const { part, mesh } of primitiveFixtures) {
    verifyPrimitive(part, mesh);
    const original = primitive({ ...part, rotation_deg: [0, 0, 0] });
    for (let index = 0; index < mesh.vertices.length; index++) {
      const unrotated = unrotate(mesh.vertices[index].map((value, axis) => value-part.center[axis]), part.rotation_deg);
      assert.ok(unrotated.every((value, axis) => Math.abs(value+part.center[axis]-original.vertices[index][axis]) < 1e-12));
    }
    if (!part.rotation_deg) {
      for (let axis = 0; axis < 3; axis++) {
        const values = mesh.vertices.map(point => point[axis]);
        assert.ok(Math.abs(Math.min(...values)-(part.center[axis]-part.size[axis]/2)) < 1e-12);
        assert.ok(Math.abs(Math.max(...values)-(part.center[axis]+part.size[axis]/2)) < 1e-12);
      }
    }
  }
  const base = { shape: 'box', center: [0, .5, 0], size: [1, 1, 1] };
  for (const patch of [{ shape: 'unknown' }, { center: null }, { center: [0, 0] }, { center: [0, Infinity, 0] },
    { center: [0, NaN, 0] }, { center: [0, true, 0] }, { size: [0, 1, 1] }, { size: [-1, 1, 1] },
    { size: [1, 1, '1'] }, { rotation_deg: [0, 0] }, { rotation_deg: null }, { rotation_deg: [0, NaN, 0] },
    { inner_ratio: .5 }, ...[0, 1, -.1, 1.1, null, true, NaN, Infinity, '.5'].map(inner_ratio => ({ shape: 'ring', inner_ratio }))]) {
    assert.throws(() => primitive({ ...base, ...patch }), Error, JSON.stringify(patch));
  }
  assert.throws(() => primitive(null), Error);
  const defaultRing = { ...base, shape: 'ring' };
  assert.deepEqual(primitive(defaultRing), primitive({ ...defaultRing, inner_ratio: .72 }));
  const legacy = JSON.parse(readFileSync(new URL('../planner/example-home.json', import.meta.url)));
  validateProject(legacy, { complete: true });
  assert.equal(buildFurnitureAsset(legacy.floors[0].items[0]), null);
  validateProject(demoProject(), { complete: true });
  for (const [index, { item, asset }] of fixtures.entries()) {
    const model = CATALOG.models[index], before = JSON.stringify(item);
    assert.equal(asset.meshes.length, model.parts.length);
    assert.ok(asset.meshes.length >= 1 && asset.meshes.length <= 32);
    assert.ok(model.parts.some(part => part.material === 'body'), `${model.id}: custom color needs a body surface`);
    assert.equal(createFurnitureItemFields(model.id).model_id, model.id);
    const bounds = [[], [], []];
    for (const [partIndex, mesh] of asset.meshes.entries()) {
      verifyPrimitive(model.parts[partIndex], mesh);
      assert.equal(mesh.kind, 'inventory');
      assert.ok(Object.hasOwn(asset.materials, mesh.material));
      for (let i = 0; i < mesh.vertices.length; i++) {
        const point = mesh.vertices[i];
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
  console.log(`Furniture JS: ${CATALOG.models.length} models, compact primitives, rotations, bounds, outward normals, colors and compatibility passed.`);
}
