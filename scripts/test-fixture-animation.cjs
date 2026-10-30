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
  // The renderer's actual asset branch is evaluated to guard batching and transforms.
  const branchStart = source.indexOf('o=new THREE.Group();const batches=inventoryMaterialBatches(');
  const branch = source.slice(branchStart, source.indexOf('if(tvEntities[it.id]', branchStart));
  assert(branchStart >= 0 && branch.includes('deviceRotors'));
  const materialSource = fs.readFileSync(path.join(root, 'material-textures.js'), 'utf8').replaceAll('export ', '');
  const pbrSource = fs.readFileSync(path.join(root, 'pbr-materials.js'), 'utf8').replaceAll('export ', '');
  const lightingSource = fs.readFileSync(path.join(root, 'room-lighting.js'), 'utf8');
  const factory = source.split('\n').find(line => line.startsWith('function createSceneMaterial('));
  const dispose = object => object.traverse(child => { child.geometry?.dispose(); child.material?.dispose(); });
  function render(asset, size, diffuseLighting = false, inventoryTextures = {get: () => null}) {
    const context = vm.createContext({THREE, size, asset, it: {id: 'fixture'}, model: {materials: asset.materials},
      renderProfile: {diffuseLighting}, inventoryTextures});
    vm.runInContext(materialSource + '\n' + pbrSource + '\n' + lightingSource + '\n' + factory, context);
    const object = vm.runInContext('var o;\n' + branch + '\no.scale.set(size.width,size.height,size.depth);o;', context);
    object.updateMatrixWorld(true);
    return {object, context};
  }
  const rotorVectors = (rotor, kind) => rotor.children.flatMap(mesh => {
    const attribute = mesh.geometry.attributes[kind];
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    return Array.from({length: attribute.count}, (_, index) => {
      const vector = new THREE.Vector3().fromBufferAttribute(attribute, index);
      return kind === 'normal' ? vector.applyNormalMatrix(normalMatrix) : vector.applyMatrix4(mesh.matrixWorld);
    });
  });
  assert.deepEqual(models.map(model => model.id), ['ceiling_fan', 'standing_fan', 'desk_fan', 'wall_air_conditioner', 'panel_heater']);
  for (const { model, asset } of fixtures) {
    assert.deepEqual(asset.device_animation, model.device_animation, 'Browser assets preserve fixture semantics');
    assert(asset.meshes.reduce((total, mesh) => total + mesh.indices.length / 3, 0) < 500, 'Each fixture keeps a compact triangle budget');
    for (const multiplier of [[1, 1, 1], [1.3, .8, 1.6]]) {
      const size = Object.fromEntries(['width', 'height', 'depth'].map((key, axis) => [key, model.dimensions_m[key] * multiplier[axis]]));
      const {object} = render(asset, size);
      assert.equal(object.userData.deviceAnimation, asset.device_animation);
      let drawCalls = 0;
      object.traverse(child => { if (child.isMesh) drawCalls++; });
      assert(drawCalls <= 5, 'At most five material batches per fixture, including its rotor');
      const [rotor] = object.userData.deviceRotors;
      if (model.device_animation.kind !== 'fan') {
        assert.equal(rotor, undefined);
        dispose(object);
        continue;
      }
      assert(rotor && object.userData.deviceRotors.length === 1, 'All fan blades share one rotor');
      assert.equal(rotor.userData.axis, model.device_animation.rotor.axis);
      const axis = new THREE.Vector3(...['x', 'y', 'z'].map(name => name === rotor.userData.axis ? 1 : 0));
      const pivot = new THREE.Vector3().fromArray(model.device_animation.rotor.pivot).multiply(new THREE.Vector3(size.width, size.height, size.depth));
      const before = rotorVectors(rotor, 'position'), beforeNormals = rotorVectors(rotor, 'normal');
      const angle = .73;
      rotor.rotation[rotor.userData.axis] = angle;
      object.updateMatrixWorld(true);
      const after = rotorVectors(rotor, 'position'), afterNormals = rotorVectors(rotor, 'normal');
      for (let i = 0; i < before.length; i++) {
        const expected = before[i].clone().sub(pivot).applyAxisAngle(axis, angle).add(pivot);
        assert(expected.distanceTo(after[i]) < 1e-6, 'Fan rotation stays rigid under nonuniform item resizing');
        assert(beforeNormals[i].clone().applyAxisAngle(axis, angle).distanceTo(afterNormals[i]) < 1e-6,
          'Rotor normals rotate with the rigid geometry');
      }
      dispose(object);
    }
  }
  // Equal material IDs must keep their PBR finish/channel partitions as well as
  // rotor ownership. Cached textures remain owned by the texture manager.
  const part = {material: 'shared', surface_finish: 'metal', vertices: [[0,0,0],[1,0,0],[0,1,1]],
    normals: Array.from({length: 3}, () => [0,-Math.SQRT1_2,Math.SQRT1_2]), indices: [0,1,2],
    uv: [[0,0],[1,0],[0,1]], normal_scale: .6, ao_strength: .4};
  const asset = {materials: {shared: [.2,.3,.4,1], glass: [.6,.7,.8,.3]},
    device_animation: {kind: 'fan', rotor: {axis: 'z', pivot: [.1,.2,.3]}},
    meshes: [part, {...part,fan_rotor: true}, {...part,fan_rotor: true},
      {...part,fan_rotor: true,surface_finish: 'plastic'}, {...part,fan_rotor: true,normal_scale: .25},
      {...part,fan_rotor: true,material: 'glass',surface_finish: 'glass'}]};
  const snapshot = JSON.stringify(asset), size = {width: 2,height: .7,depth: 1.4};
  const color = new THREE.Texture(), normal = new THREE.Texture(), orm = new THREE.Texture();
  const channels = {albedo_texture: color,normal_texture: normal,roughness_texture: orm,metalness_texture: orm,ao_texture: orm};
  let textureDisposals = 0;
  for (const texture of [color,normal,orm]) texture.addEventListener('dispose', () => textureDisposals++);
  const textures = {get: (mesh, dimensions) => ({channels,texture: color,albedoTint: true,
    normalScale: mesh.normal_scale,aoStrength: mesh.ao_strength,
    uv: mesh.uv.flatMap(pair => [pair[0] * dimensions.width,pair[1] * dimensions.height])})};
  for (const diffuse of [false,true]) {
    const {object,context} = render(asset, size, diffuse, textures), rotor = object.userData.deviceRotors[0];
    const fixed = object.children.filter(child => child.isMesh), meshes = [...fixed,...rotor.children];
    assert.equal(fixed.length, 1, 'The housing stays outside the rotor');
    assert.equal(rotor.children.length, 4, 'Finish and map settings still split rotor batches');
    assert.equal(rotor.children[0].geometry.attributes.position.count, 6, 'Compatible blade parts share a batch');
    const originals = meshes.map(mesh => mesh.material);
    for (const mesh of meshes) {
      const material = mesh.material;
      assert.equal(material.type, diffuse ? 'MeshLambertMaterial' : 'MeshStandardMaterial');
      assert.equal(material.map, color, 'Fixed and moving geometry share the cached albedo');
      assert.deepEqual(Array.from(mesh.geometry.attributes.uv.array.slice(0,6)), [0,0,2,0,0,Math.fround(.7)]);
      if (!diffuse) {
        assert.equal(material.normalMap, normal);
        assert.equal(material.roughnessMap, orm);assert.equal(material.metalnessMap, orm);assert.equal(material.aoMap, orm);
        assert.equal(material.aoMapIntensity, .4);
      }
    }
    if (!diffuse) {
      assert.deepEqual(rotor.children.map(mesh => mesh.material.roughness), [.3,.48,.3,.12]);
      assert.deepEqual(rotor.children.map(mesh => mesh.material.normalScale.x), [.6,.6,.25,.6]);
    }
    const glass = rotor.children[3];
    assert.equal(glass.material.transparent, true);assert.equal(glass.material.opacity, .3);
    assert.equal(glass.material.depthWrite, false);assert.equal(glass.castShadow, false);
    assert.equal(glass.receiveShadow, true);
    const expectedNormal = new THREE.Vector3(...part.normals[0]).divide(new THREE.Vector3(size.width,size.height,size.depth)).normalize();
    assert(rotorVectors(rotor, 'normal')[0].distanceTo(expectedNormal) < 1e-6, 'Resting normals retain the scaled surface direction');
    const lighting = context.createRoomLighting(THREE, [{id:'room',polygon:[[0,0],[4,0],[4,4],[0,4]]}], 1, [], {});
    for (const active of [true,false,true,false]) {
      lighting.attach(object, active);
      meshes.forEach((mesh,index) => {assert.equal(mesh.material, originals[index]);assert.equal(mesh.material.map, color);});
    }
    lighting.dispose();dispose(object);
    assert.equal(textureDisposals, 0, 'Fixture and lighting disposal never dispose manager-owned maps');
  }
  assert.equal(JSON.stringify(asset), snapshot, 'Renderer transforms never mutate reusable asset geometry or UVs');
  for (const texture of [color,normal,orm]) texture.dispose();
  assert.equal(textureDisposals, 3);
  console.log('Fixture animation: catalog geometry, rigid positions/normals, PBR batching, UVs, glass and shared texture ownership passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
