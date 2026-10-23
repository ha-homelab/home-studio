import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { blankProject, outlineRoom, validateProject } from '../planner/model.js';
import { buildFurnitureAsset } from '../planner/furniture.js';

const fixture = blankProject(); fixture.id = 'curtain_fixture'; fixture.title = 'Fictional curtain study';
const floor = fixture.floors[0];
floor.rooms.push({ id: 'study', name: 'Study', material: 'floor', polygon: [[0, 0], [5, 0], [5, 4], [0, 4]] });
outlineRoom(floor, floor.rooms[0]);
floor.openings.push({ id: 'window', wall_id: 'wall_1', type: 'window', offset_m: 1.5, width_m: 2, sill_m: .7, head_m: 2.3 });
floor.items.push({ id: 'curtain', name: 'Window curtain', type: 'furniture', model_id: 'curtain_pair_closed', style_id: 'scandinavian',
  room: 'study', position_m: { x: 2.5, y: .03, z: .2 }, dimensions_m: { width: 2.2, depth: .18, height: 2.4 }, rotation_deg: 0,
  entity_id: 'cover.fixture', notes: '', curtain: { opening_id: 'window', mode: 'pair' } });
if (process.argv.includes('--fixture')) {
  process.stdout.write(JSON.stringify(fixture));
} else {
  validateProject(fixture);
  const invalid = patch => { const copy = structuredClone(fixture); patch(copy.floors[0]); assert.throws(() => validateProject(copy)); };
  for (const value of [null, {}, { opening_id: 'window', mode: 'bad' }, { opening_id: 'missing', mode: 'pair' },
    { opening_id: 'window', mode: 'pair', url: 'https://invalid.test' }, { opening_id: '../window', mode: 'left' }]) invalid(f => { f.items[0].curtain = value; });
  invalid(f => { f.items[0].entity_id = 'light.fixture'; });
  invalid(f => { f.openings[0].type = 'door'; f.openings[0].sill_m = 0; });
  invalid(f => { f.items[0].model_id = 'armchair'; });
  const unlinked = structuredClone(fixture); unlinked.floors[0].items[0].entity_id = ''; validateProject(unlinked);
  const legacy = structuredClone(fixture); delete legacy.floors[0].items[0].curtain; validateProject(legacy);

  const THREE = await import('data:text/javascript;base64,' + fs.readFileSync(new URL('../vendor/three.module.min.js', import.meta.url)).toString('base64'));
  const context = vm.createContext({ THREE, xm: value => value, zm: value => value });
  vm.runInContext(fs.readFileSync(new URL('../curtain-state.js', import.meta.url), 'utf8'), context);
  const { deriveCurtainStatus, updateCurtainFabric } = context;
  assert.equal(deriveCurtainStatus({ state: 'open', cover: { current_position: 50 } }, {}).position, 50);
  assert.equal(deriveCurtainStatus({ state: 'unavailable', cover: { current_position: 80, last_known: { position: 25 } } }, {}).position, 25);
  assert.equal(deriveCurtainStatus({ state: 'unavailable', cover: { last_known: { position: 200 } } }, {}).position, null);
  const opening = [{ id: 'window', rect: [1.5, 0, 3.5, 0], start_m: [1.5, 0], end_m: [3.5, 0] }];
  for (const model_id of ['curtain_pair_open', 'curtain_pair_closed']) for (const mode of ['pair', 'left', 'right']) {
    const item = { ...floor.items[0], model_id, pattern_id: 'checks', pattern_color: '#ee3300' }, asset = buildFurnitureAsset(item);
    const object = new THREE.Group();
    for (const part of asset.meshes) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(part.vertices.flat(), 3));
      geometry.setIndex(part.indices);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
      mesh.userData.curtainFabric = part.curtain_fabric === true; mesh.userData.curtainPanel = part.curtain_panel;
      object.add(mesh);
    }
    const fixed = object.children.filter(mesh => !mesh.userData.curtainFabric).map(mesh => [...mesh.geometry.attributes.position.array]);
    assert(fixed.length > 0, 'Rails and rings stay fixed');
    assert(asset.meshes.filter(mesh => mesh.name.startsWith('pattern')).every(mesh => mesh.curtain_fabric), 'Patterns follow fabric');
    const coordinates = () => object.children.filter(mesh => mesh.userData.curtainFabric).flatMap(mesh => [...mesh.geometry.attributes.position.array].filter((_, index) => index % 3 === 0));
    const states = [];
    for (const position of [0, 50, 100, 0]) {
      assert(updateCurtainFabric(object, item, { openings: ['window'], mode }, position, opening, item));
      states.push(coordinates());
      assert.deepEqual(object.children.filter(mesh => !mesh.userData.curtainFabric).map(mesh => [...mesh.geometry.attributes.position.array]), fixed);
    }
    assert.deepEqual(states[0], states[3], 'Repeated updates use original vertices without cumulative drift');
    assert.notDeepEqual(states[0], states[2]);
    for (let i = 0; i < states[0].length; i++) assert(Math.abs(states[1][i] - (states[0][i] + states[2][i]) / 2) < 1e-6, 'Half open is midway between open and closed');
    if (mode === 'left') assert(Math.max(...states[2]) < 0);
    if (mode === 'right') assert(Math.min(...states[2]) > 0);
    if (mode === 'pair') assert(states[2].every(x => Math.abs(x) > .3), 'Both panels gather at opposite sides');
    const beforeUnknown = coordinates();
    assert.equal(updateCurtainFabric(object, item, { openings: ['window'], mode }, null, opening, item), null);
    assert.deepEqual(coordinates(), beforeUnknown, 'Unknown state does not invent a position');
    const rotated = { ...item, position_m: { x: 10, y: .03, z: 10 }, rotation_deg: 90 };
    const verticalWindow = [{ id: 'window', rect: [10, 9, 10, 11], start_m: [10, 9], end_m: [10, 11] }];
    updateCurtainFabric(object, rotated, { openings: ['window'], mode }, 0, verticalWindow, rotated);
    assert.deepEqual(coordinates(), states[0], 'A rotated wall uses metric window endpoints and the authored curtain orientation');
  }
  console.log('Curtain authoring passed: explicit binding validation, decorative compatibility, fabric/pattern tags, single and paired open/half/closed geometry, fixed rails, remembered state, and no drift.');
}
