// Check shader composition against the pinned Three.js shader, without a browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
(async () => {
  const THREE = await import('data:text/javascript;base64,' + fs.readFileSync(path.join(root, 'vendor/three.module.min.js')).toString('base64'));
  const context = vm.createContext({});
  const source = fs.readFileSync(path.join(root, 'room-lighting.js'), 'utf8');
  vm.runInContext(source, context);
  const shader = (library = THREE.ShaderLib.standard) => ({uniforms: {}, vertexShader: library.vertexShader, fragmentShader: library.fragmentShader});
  for (const [Material, library] of [[THREE.MeshStandardMaterial, THREE.ShaderLib.standard], [THREE.MeshLambertMaterial, THREE.ShaderLib.lambert]]) {
  const mesh = category => ({material: new Material(), userData: {category}});
  const walls = [mesh('walls'), mesh('walls')], floor = mesh('floors');
  const group = {traverse: visit => [...walls, floor].forEach(visit)};
  const lighting = context.createRoomLighting(THREE, [], 1, []);
  const keys = new Set();
  for (const enabled of [false, true, false]) {
    lighting.attach(group, enabled);
    const wallShader = shader(library), floorShader = shader(library);
    walls[0].material.onBeforeCompile(wallShader);
    floor.material.onBeforeCompile(floorShader);
    assert.match(wallShader.vertexShader, /wallSheen = mix/);
    assert.match(wallShader.fragmentShader, /totalEmissiveRadiance \+= wallSheen/);
    assert.doesNotMatch(floorShader.vertexShader + floorShader.fragmentShader, /wallSheen/);
    assert.equal((wallShader.vertexShader.match(/varying vec3 wallSheen;/g) || []).length, 1);
    assert.match(wallShader.fragmentShader, /#include <clipping_planes_fragment>/);
    assert.equal(wallShader.vertexShader.includes('homeWorldPosition ='), enabled);
    assert.equal(wallShader.fragmentShader.includes('homeRoomTransmissions[homePointRooms'), enabled);
    assert.notEqual(walls[0].material.customProgramCacheKey(), floor.material.customProgramCacheKey());
    assert.equal(walls[0].material.customProgramCacheKey(), walls[1].material.customProgramCacheKey());
    keys.add(walls[0].material.customProgramCacheKey());
    keys.add(floor.material.customProgramCacheKey());
  }
  assert.equal(keys.size, 4, 'Only wall/non-wall and Home/editor variants');
  }
  const initial = shader();
  context.applyWallSheen(initial);
  assert.equal(initial.uniforms.wallSheenPhase.value, 0);
  const another = shader();
  context.applyWallSheen(another);
  assert.equal(initial.uniforms.wallSheenPhase, another.uniforms.wallSheenPhase, 'Walls share one phase uniform');
  assert.match(initial.vertexShader, /uniform float wallSheenPhase;/);
  assert.match(initial.vertexShader, /isOrthographic \?/);
  assert.match(initial.vertexShader, /normalize\(-mvPosition.xyz\)/);
  assert.match(initial.vertexShader, /0\.4\*clamp\(grazing\*grazing,0\.0,1\.0\)/);
  assert.match(THREE.ShaderChunk.defaultnormal_vertex, /transformedNormal/);
  assert.match(THREE.ShaderChunk.project_vertex, /mvPosition/);
  // Angle and palette work stays in vertices; fragments only blend the tint.
  assert.doesNotMatch(initial.fragmentShader, /sin\(|grazing|float tint/);
  assert.doesNotMatch(source.slice(0, source.indexOf('function createRoomLighting')), /requestAnimationFrame|setInterval|setTimeout|Date|sampler/);
  console.log('PASS: Shared wall tint composes with Home/editor lighting, clipping and shader caching.');
})().catch(error => {console.error(error); process.exitCode = 1;});
