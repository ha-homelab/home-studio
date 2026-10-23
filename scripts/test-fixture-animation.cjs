'use strict';
// Synthetic fixture geometry only: no browser, live entities, timers or HA commands.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

(async () => {
  const { CATALOG, buildFurnitureAsset } = await import('../planner/furniture.js');
  const models = CATALOG.models.filter(model => model.device_animation);
  const fixtures = models.map(model => ({
    model, asset: buildFurnitureAsset({ model_id: model.id, type: model.type, style_id: model.default_style }),
  }));
  if (process.argv.includes('--fixtures')) {
    process.stdout.write(JSON.stringify(fixtures));
    return;
  }
  const THREE = await import('data:text/javascript;base64,' + fs.readFileSync(path.join(root, 'vendor/three.module.min.js')).toString('base64'));
  const source = fs.readFileSync(path.join(root, 'viewer.js'), 'utf8');
  const start = source.indexOf('o=new THREE.Group();const batches={};');
  // The renderer's actual asset branch is evaluated to guard batching and transforms.
  const branchStart = start < 0 ? source.indexOf('o=new THREE.Group();const batches={},animation=') : start;
  const branch = source.slice(branchStart, source.indexOf('if(tvEntities[it.id]', branchStart));
  assert(branchStart >= 0 && branch.includes('deviceRotors'));
  assert.deepEqual(models.map(model => model.id), ['ceiling_fan', 'standing_fan', 'desk_fan', 'wall_air_conditioner', 'panel_heater']);
  for (const { model, asset } of fixtures) {
    assert.deepEqual(asset.device_animation, model.device_animation, 'Browser assets preserve fixture semantics');
    assert(asset.meshes.reduce((total, mesh) => total + mesh.indices.length / 3, 0) < 500, 'Each fixture keeps a compact triangle budget');
    for (const multiplier of [[1, 1, 1], [1.3, .8, 1.6]]) {
      const size = Object.fromEntries(['width', 'height', 'depth'].map((key, axis) => [key, model.dimensions_m[key] * multiplier[axis]]));
      const context = vm.createContext({ THREE, size, asset, it: { id: model.id }, model: { materials: asset.materials }, createSceneMaterial: options => new THREE.MeshStandardMaterial(options) });
      const object = vm.runInContext('var o;\n' + branch + '\no.scale.set(size.width,size.height,size.depth);o;', context);
      object.updateMatrixWorld(true);
      assert.equal(object.userData.deviceAnimation, asset.device_animation);
      let drawCalls = 0;
      object.traverse(child => { if (child.isMesh) drawCalls++; });
      assert(drawCalls <= 5, 'At most five material batches per fixture, including its rotor');
      const [rotor] = object.userData.deviceRotors;
      if (model.device_animation.kind !== 'fan') {
        assert.equal(rotor, undefined);
        continue;
      }
      assert(rotor && object.userData.deviceRotors.length === 1, 'All fan blades share one rotor');
      assert.equal(rotor.userData.axis, model.device_animation.rotor.axis);
      const axis = new THREE.Vector3(...['x', 'y', 'z'].map(name => name === rotor.userData.axis ? 1 : 0));
      const pivot = new THREE.Vector3().fromArray(model.device_animation.rotor.pivot).multiply(new THREE.Vector3(size.width, size.height, size.depth));
      const before = rotor.children.flatMap(mesh => {
        const positions = mesh.geometry.attributes.position;
        return Array.from({ length: positions.count }, (_, index) => new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld));
      });
      const angle = .73;
      rotor.rotation[rotor.userData.axis] = angle;
      object.updateMatrixWorld(true);
      const after = rotor.children.flatMap(mesh => {
        const positions = mesh.geometry.attributes.position;
        return Array.from({ length: positions.count }, (_, index) => new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld));
      });
      for (let i = 0; i < before.length; i++) {
        const expected = before[i].clone().sub(pivot).applyAxisAngle(axis, angle).add(pivot);
        assert(expected.distanceTo(after[i]) < 1e-6, 'Fan rotation stays rigid under nonuniform item resizing');
      }
      object.traverse(child => { child.geometry?.dispose(); child.material?.dispose(); });
    }
  }
  console.log('Fixture animation geometry: five catalog models, metadata, batching and rigid fan rotation passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
