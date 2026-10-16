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
  const callbackMaterial=new THREE.MeshLambertMaterial(), callbackShader=shader();
  callbackMaterial.onBeforeCompile=context.applyWallSheen;
  callbackMaterial.onBeforeCompile(callbackShader,{isWebGLRenderer:true});
  assert.equal(callbackShader.uniforms.homeWallSheenEnabled,undefined,'Three passes a renderer as the second callback argument, never a sheen switch');
  assert.equal(callbackShader.vertexShader,initial.vertexShader);
  assert.equal(callbackShader.fragmentShader,initial.fragmentShader);
  callbackMaterial.dispose();

  assert.match(initial.vertexShader, /uniform float wallSheenPhase;/);
  assert.match(initial.vertexShader, /isOrthographic \?/);
  assert.match(initial.vertexShader, /normalize\(-mvPosition.xyz\)/);
  assert.match(initial.vertexShader, /0\.4\*clamp\(grazing\*grazing,0\.0,1\.0\)/);
  assert.match(THREE.ShaderChunk.defaultnormal_vertex, /transformedNormal/);
  assert.match(THREE.ShaderChunk.project_vertex, /mvPosition/);
  // Angle and palette work stays in vertices; fragments only blend the tint.
  assert.doesNotMatch(initial.fragmentShader, /sin\(|grazing|float tint/);
  assert.doesNotMatch(source.slice(0, source.indexOf('function createRoomLighting')), /requestAnimationFrame|setInterval|setTimeout|Date/);
  // Room-light transport may use textures; the sheen functions themselves may not.
  assert.doesNotMatch([context.createWallSheenMotion,context.applyWallSheen,context.applySharedWallSheen].map(fn=>fn.toString()).join('\n'), /sampler/);
  // The packed path may share one program, but every material owns its switch.
  // Use real material defaults and geometry; no browser or fixture state is mocked.
  const rooms = [{id:'A',polygon:[[0,0],[4,0],[4,4],[0,4]]}];
  const makeLighting = options => context.createRoomLighting(THREE, rooms, 2, [], options);
  const makeMesh = (category, options = {}) => {
    const material = new THREE.MeshLambertMaterial({side:THREE.DoubleSide,
      transparent:category === 'walls',opacity:category === 'walls' ? .16 : 1,
      depthWrite:category !== 'walls',forceSinglePass:category === 'walls',
      clippingPlanes:[new THREE.Plane(new THREE.Vector3(0,-1,0),20)],clipShadows:false,...options});
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1,1,1),material);
    mesh.userData.category = category; mesh.castShadow = mesh.receiveShadow = true;
    return mesh;
  };
  const compile = mesh => { const result=shader(THREE.ShaderLib.lambert);mesh.material.onBeforeCompile(result);return result; };
  const group = new THREE.Group(), wall = makeMesh('walls'), floor = makeMesh('floors'), frame = makeMesh('frames');
  group.add(wall,floor,frame);
  const original = [wall,floor,frame].map(mesh => ({side:mesh.material.side,transparent:mesh.material.transparent,
    opacity:mesh.material.opacity,depthWrite:mesh.material.depthWrite,depthTest:mesh.material.depthTest,
    forceSinglePass:mesh.material.forceSinglePass,clipShadows:mesh.material.clipShadows,
    clippingPlanes:mesh.material.clippingPlanes,geometry:mesh.geometry,castShadow:mesh.castShadow,receiveShadow:mesh.receiveShadow}));
  const literalSources = new Map();
  for (const enabled of [false,true]) {
    makeLighting({packed:false}).attach(group,enabled,{staticGeometry:true});
    literalSources.set(enabled,[wall,floor,frame].map(mesh => ({vertex:compile(mesh).vertexShader,
      fragment:compile(mesh).fragmentShader,key:mesh.material.customProgramCacheKey()})));
  }
  const packed = makeLighting({packed:true,maxFragmentUniforms:1024});
  assert.equal(packed.geometryMode,'packed');
  const switches=new Map();
  for (const enabled of [false,true,false]) {
    packed.attach(group,enabled,{staticGeometry:true});
    const compiled = [wall,floor,frame].map(compile);
    for (let i=0;i<compiled.length;i++) {
      assert.equal(compiled[i].vertexShader,compiled[0].vertexShader);
      assert.equal(compiled[i].fragmentShader,compiled[0].fragmentShader);
      assert.equal([wall,floor,frame][i].material.customProgramCacheKey(),wall.material.customProgramCacheKey());
      assert.equal(compiled[i].uniforms.homeWallSheenEnabled.value,i===0);
      if(switches.has(i))assert.equal(compiled[i].uniforms.homeWallSheenEnabled,switches.get(i));
      else switches.set(i,compiled[i].uniforms.homeWallSheenEnabled);
      assert.equal(compiled[i].uniforms.wallSheenPhase,compiled[0].uniforms.wallSheenPhase);
      const mesh=[wall,floor,frame][i];
      for (const [key,value] of Object.entries(original[i])) assert.equal(key in mesh.material ? mesh.material[key] : mesh[key],value,key);
    }
    assert.notEqual(compiled[0].uniforms.homeWallSheenEnabled,compiled[1].uniforms.homeWallSheenEnabled);
    assert.notEqual(compiled[1].uniforms.homeWallSheenEnabled,compiled[2].uniforms.homeWallSheenEnabled);
    assert.equal(wall.material.blending,THREE.NormalBlending);
    assert.equal(floor.material.blending,THREE.NoBlending);
    assert.equal(frame.material.blending,THREE.NoBlending);
    assert.match(compiled[0].fragmentShader,/if \(homeWallSheenEnabled\) diffuseColor.rgb = mix\(diffuseColor.rgb,wallSheen,0.48\);/);
    assert.match(compiled[0].fragmentShader,/if \(homeWallSheenEnabled\) totalEmissiveRadiance \+= wallSheen\*0.16;/);
  }
  // Distinct lighting instances arise when inventory capacity changes. Literal
  // fallback must restore the owned state, code and keys on the same materials.
  for (const options of [{packed:false},{packed:true,maxFragmentUniforms:1}]) {
    for (const enabled of [false,true]) {
      packed.attach(group,enabled,{staticGeometry:true});
      const fallback=makeLighting(options);assert.equal(fallback.geometryMode,'literal');
      fallback.attach(group,enabled,{staticGeometry:true});
      [wall,floor,frame].forEach((mesh,i) => {
        const result=compile(mesh),expected=literalSources.get(enabled)[i];
        assert.equal(mesh.material.blending,THREE.NormalBlending);
        assert.equal(result.vertexShader,expected.vertex);assert.equal(result.fragmentShader,expected.fragment);
        assert.equal(mesh.material.customProgramCacheKey(),expected.key);
        assert.equal(result.uniforms.homeWallSheenEnabled,undefined);
      });
    }
  }
  packed.attach(group,true,{staticGeometry:true});
  floor.material.blending=THREE.AdditiveBlending;
  makeLighting({packed:false}).attach(group,true,{staticGeometry:true});
  assert.equal(floor.material.blending,THREE.AdditiveBlending,'An external, non-owned blend change is never overwritten');
  floor.material.blending=THREE.NormalBlending;
  const unsupported = [{transparent:true},{opacity:.9},{side:THREE.FrontSide},{blending:THREE.AdditiveBlending},
    {map:new THREE.Texture()},{alphaMap:new THREE.Texture()},{vertexColors:true},{alphaTest:.1},
    {alphaHash:true},{alphaToCoverage:true},{premultipliedAlpha:true},{clippingPlanes:[]},{clipShadows:true}];
  for (const options of unsupported) {
    const mesh=makeMesh('floors',options),root=new THREE.Group();root.add(mesh);
    const blending=mesh.material.blending;packed.attach(root,true,{staticGeometry:true});
    assert.equal(mesh.material.blending,blending);assert.equal(compile(mesh).uniforms.homeWallSheenEnabled,undefined);
    mesh.geometry.dispose();mesh.material.dispose();
  }
  const vertexAlpha=makeMesh('floors'), vertexAlphaRoot=new THREE.Group();vertexAlphaRoot.add(vertexAlpha);
  vertexAlpha.geometry.setAttribute('color',new THREE.Float32BufferAttribute(new Float32Array(vertexAlpha.geometry.attributes.position.count*4).fill(1),4));
  packed.attach(vertexAlphaRoot,true,{staticGeometry:true});
  assert.equal(compile(vertexAlpha).uniforms.homeWallSheenEnabled,undefined,'Color attributes conservatively retain their original program');
  vertexAlpha.geometry.dispose();vertexAlpha.material.dispose();
  for (const category of ['doors','windows','vehicles','unknown']) {
    const mesh=makeMesh(category),root=new THREE.Group();root.add(mesh);
    packed.attach(root,true,{staticGeometry:true});assert.equal(compile(mesh).uniforms.homeWallSheenEnabled,undefined);
    mesh.geometry.dispose();mesh.material.dispose();
  }
  // Previously cached programs retain uniform references. A later, unambiguous
  // role must update that reference even when Three reuses the old program.
  const retyped=makeMesh('floors'),retypedGroup=new THREE.Group();retypedGroup.add(retyped);
  packed.attach(retypedGroup,true,{staticGeometry:true});const cachedSwitch=compile(retyped).uniforms.homeWallSheenEnabled;
  retyped.userData.category='walls';retyped.material.transparent=true;retyped.material.opacity=.16;
  makeLighting({packed:true,maxFragmentUniforms:1024}).attach(retypedGroup,true,{staticGeometry:true});
  assert.equal(cachedSwitch.value,true);assert.equal(compile(retyped).uniforms.homeWallSheenEnabled,cachedSwitch);
  retyped.userData.category='floors';retyped.material.transparent=false;retyped.material.opacity=1;
  packed.attach(retypedGroup,true,{staticGeometry:true});assert.equal(cachedSwitch.value,false);
  retyped.geometry.dispose();retyped.material.dispose();
  // A mixed-role material cannot own one switch. Dynamic attachment revokes a
  // prior static opt-in and remains conservative on subsequent attachments.
  const shared=makeMesh('floors'),other=makeMesh('walls'),sharedGroup=new THREE.Group();
  other.material.dispose();other.material=shared.material;sharedGroup.add(shared,other);
  packed.attach(sharedGroup,true,{staticGeometry:true});assert.equal(compile(shared).uniforms.homeWallSheenEnabled,undefined);
  packed.attach(group,true,{staticGeometry:true});packed.attach(group,true);
  assert.equal(floor.material.blending,THREE.NormalBlending);assert.equal(compile(floor).uniforms.homeWallSheenEnabled,undefined);
  packed.attach(group,true,{staticGeometry:true});assert.equal(compile(floor).uniforms.homeWallSheenEnabled,undefined);
  for (const mesh of [wall,floor,frame,shared,other]) mesh.geometry.dispose();
  for (const material of new Set([wall,floor,frame,shared,other].map(mesh=>mesh.material))) material.dispose();
  console.log('PASS: Shared wall tint composes with Home/editor lighting, clipping and shader caching.');
})().catch(error => {console.error(error); process.exitCode = 1;});
