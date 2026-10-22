'use strict';
// Exercise real Home rendering with synthetic rooms and no HA/device commands.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

(async () => {
  const THREE = await import('data:text/javascript;base64,' + fs.readFileSync(path.join(root, 'vendor/three.module.min.js')).toString('base64'));
  const materialContext = vm.createContext({THREE, renderProfile: {diffuseLighting: false}});
  const materialFactory = fs.readFileSync(path.join(root, 'viewer.js'), 'utf8').split('\n').find(line=>line.startsWith('function createSceneMaterial('));
  vm.runInContext(materialFactory, materialContext);
  const appearance = {color: 0x2288bb, emissive: 0x123456, roughness: .8, metalness: .35,
    transparent: true, opacity: .16, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true};
  for (const diffuse of [false, true, false]) {
    materialContext.renderProfile.diffuseLighting = diffuse;
    const material = materialContext.createSceneMaterial(appearance);
    assert.equal(Boolean(material.isMeshLambertMaterial), diffuse);
    assert.equal(Boolean(material.isMeshStandardMaterial), !diffuse);
    assert.equal(material.color.getHex(), appearance.color);
    assert.equal(material.emissive.getHex(), appearance.emissive);
    for (const field of ['transparent','opacity','depthWrite','side','forceSinglePass']) assert.equal(material[field], appearance[field]);
    if (!diffuse) { assert.equal(material.roughness,.8); assert.equal(material.metalness,.35); }
    material.dispose();
  }
  const clipSource=fs.readFileSync(path.join(root,'viewer.js'),'utf8').split('\n').find(line=>line.startsWith('function applyStaticMeshClipping('));
  const cutaway=new THREE.Plane(new THREE.Vector3(0,-1,0),1.15);
  const clipContext=vm.createContext({THREE,renderProfile:{diffuseLighting:true},clipping:cutaway});
  vm.runInContext(clipSource,clipContext);
  const floor={kind:'floors',vertices:[[-4,-2,6],[8,-2,-3],[8,-1,6]]};
  const newFloorMaterial=()=>new THREE.MeshLambertMaterial({side:THREE.DoubleSide});
  const clippedFloor=newFloorMaterial(),originalVertices=JSON.stringify(floor.vertices);
  clipContext.applyStaticMeshClipping(floor,clippedFloor);
  assert.equal(clippedFloor.clippingPlanes.length,1);
  assert.notEqual(clippedFloor.clippingPlanes[0],cutaway);
  assert.equal(clippedFloor.clipShadows,false);
  assert.equal(JSON.stringify(floor.vertices),originalVertices,'Clipping setup cannot change static geometry');
  for(const kind of ['walls','frames','doors','windows'])for(const diffuse of [false,true]){
    clipContext.renderProfile.diffuseLighting=diffuse;
    const material=newFloorMaterial();clipContext.applyStaticMeshClipping({kind,vertices:floor.vertices},material);
    assert.equal(material.clippingPlanes[0],cutaway,'Existing cutaway semantics remain shared');
    assert.equal(material.clipShadows,false);material.dispose();
  }
  for(const [diffuse,source,appearance]of [[false,floor,{}],[true,{...floor,kind:'stairs'},{}],
    [true,floor,{transparent:true}],[true,floor,{side:THREE.FrontSide}],
    [true,{...floor,vertices:[]},{}],[true,{...floor,vertices:[[0,NaN,0]]},{}],
    [true,{...floor,vertices:[[0,Infinity,0]]},{}],[true,{...floor,vertices:[[0,1e39,0]]},{}]]){
    clipContext.renderProfile.diffuseLighting=diffuse;
    const material=new THREE.MeshLambertMaterial({side:THREE.DoubleSide,...appearance});
    clipContext.applyStaticMeshClipping(source,material);assert.equal(material.clippingPlanes,null,'Unsupported or unchanged materials retain original clipping');material.dispose();
  }
  clipContext.renderProfile.diffuseLighting=true;
  let clipChecks=0;
  for(const scale of [.001,1,1000,1e8])for(const offset of [-20,0,35]){
    const vertices=floor.vertices.map(v=>v.map(x=>(x+offset)*scale));
    const material=newFloorMaterial();
    clipContext.applyStaticMeshClipping({kind:'floors',vertices},material);
    const plane=material.clippingPlanes[0];
    for(const target of [new THREE.Vector3(),new THREE.Vector3(offset*scale,offset*scale,offset*scale)])for(let angle=0;angle<6;angle++){
      const camera=new THREE.PerspectiveCamera();camera.position.set(Math.cos(angle)*100*scale,80*scale,Math.sin(angle)*100*scale).add(target);camera.lookAt(target);camera.updateMatrixWorld();
      const viewPlane=plane.clone().applyMatrix4(camera.matrixWorldInverse);
      const normal=viewPlane.normal.toArray().map(Math.fround),constant=Math.fround(viewPlane.constant);
      for(let a=0;a<=5;a++)for(let b=0;b<=5-a;b++){
        const point=new THREE.Vector3().fromArray(vertices[0]).multiplyScalar(a/5).addScaledVector(new THREE.Vector3().fromArray(vertices[1]),b/5).addScaledVector(new THREE.Vector3().fromArray(vertices[2]),1-(a+b)/5);
        const view=point.applyMatrix4(camera.matrixWorldInverse).toArray().map(Math.fround);
        const fragmentDot=Math.fround(normal.reduce((sum,n,i)=>Math.fround(sum+Math.fround(-view[i]*n)),0));
        assert(fragmentDot<=constant,'Float32 clipping math must preserve every sampled floor fragment');clipChecks++;
      }
    }
    assert.equal(material.side,THREE.DoubleSide);assert.equal(material.transparent,false);assert.equal(material.depthWrite,true);material.dispose();
  }
  assert.equal(clipChecks,3024);
  const constant=clippedFloor.clippingPlanes[0].constant;cutaway.constant=20;
  assert.equal(clippedFloor.clippingPlanes[0].constant,constant,'User cutaway changes cannot clip an originally unclipped floor');clippedFloor.dispose();
  const lighting = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, 'room-lighting.js'), 'utf8'), lighting);
  for (const count of [0, 1, 4, 5, 16, 17, 64, 100, 1000]) {
    for (const maxTexture of [256, 1024, 4096, 16384]) {
      const size = lighting.pointShadowMapSize(count, maxTexture);
      assert.equal(Math.log2(size) % 1, 0, 'Power-of-two face size');
      assert(size <= 512 && size * 4 <= maxTexture, 'Atlas fits the hardware texture limit');
      assert(Math.max(1, count) * size * size * 8 <= 8 * 1024 * 1024, 'All point atlases share an 8M pixel budget');
    }
  }
  assert.equal(lighting.pointShadowMapSize(4), 512);
  assert.equal(lighting.pointShadowMapSize(16), 256);
  assert.equal(lighting.pointShadowMapSize(64), 128);
  const softwareLights = Array.from({length:18}, () => new THREE.PointLight());
  lighting.configurePointShadows(softwareLights, {maxTextures:16, maxTextureSize:4096}, {pointShadows:2, pointShadowSize:128});
  assert.equal(softwareLights.filter(light => light.castShadow).length, 2);
  assert(softwareLights.every(light => light.shadow.mapSize.x === 128));
  const material = new THREE.MeshStandardMaterial();
  lighting.createRoomLighting(THREE, [{id: 'A', polygon: [[0, 0], [4, 0], [4, 4], [0, 4]]}], 1, [])
    .attach({traverse: visit => visit({material, userData: {}})}, true);
  const shader = {uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader};
  material.onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /if \(directLight.visible\) \{\s+directLight.color \*= homeRoomTransmissions\[/);
  assert.match(THREE.ShaderChunk.lights_pars_begin, /light.visible = \( light.color != vec3\( 0.0 \) \)/,
    'The pinned shader establishes visibility after range attenuation');
  const lightChunk = THREE.ShaderChunk.lights_fragment_begin;
  const pointStart = lightChunk.indexOf('#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )');
  const pointEnd = lightChunk.indexOf('#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )', pointStart);
  assert(pointStart >= 0 && pointEnd > pointStart, 'Pinned point-light block boundaries exist');
  const originalPoints = lightChunk.slice(pointStart, pointEnd);
  const originalCall = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
  assert.equal(originalPoints.split(originalCall).length, 2, 'Exactly one point BRDF call is changed');
  const guardedStart = shader.fragmentShader.indexOf('#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )');
  const guardedEnd = shader.fragmentShader.indexOf('#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )', guardedStart);
  assert(guardedStart >= 0 && guardedEnd > guardedStart, 'Composed shader retains the same point-light block');
  const guardedPoints = shader.fragmentShader.slice(guardedStart, guardedEnd);
  const attenuation = guardedPoints.indexOf('directLight.color *= homeRoomTransmissions[');
  const visibility = guardedPoints.indexOf('directLight.visible = (directLight.color != vec3(0.0))');
  const shadow = guardedPoints.indexOf('getPointShadow(');
  const brdf = guardedPoints.indexOf('if (directLight.visible) ' + originalCall);
  assert(attenuation >= 0 && visibility > attenuation && shadow > visibility && brdf > shadow,
    'Room visibility is updated before shadow sampling and the point BRDF is conditional');
  assert(guardedPoints.indexOf('if (homeRoomTransmissions[homePointRooms[ i ]] != 0.0)') < guardedPoints.indexOf('getPointLightInfo('),
    'Exact-zero room transmission skips point-light distance and attenuation work too');
  assert.match(guardedPoints, /directLight.visible && receiveShadow/, 'Three shadow lookup honors the updated visibility');
  assert(shader.fragmentShader.includes(lightChunk.slice(0, pointStart)), 'Lighting initialization is unchanged');
  assert(shader.fragmentShader.includes(lightChunk.slice(pointEnd)), 'Spot, directional, area and indirect lighting remain byte-identical');
  assert.doesNotMatch(guardedPoints, /homeRoomTransmission\(/, 'Point-light slots only index the cache');
  assert(shader.fragmentShader.indexOf('homeRoomTransmissions[1] = homeLitRooms[0] != 0 && homeRoomNearby1() ? homeRoomTransmission(homeRoomDistance1()) : 0.0;') < guardedStart,
    'Literal room transmission is initialized once before the point-light loop');

  // Compare room uniform order to the exact comparator shipped with Three.
  const vendor = fs.readFileSync(path.join(root, 'vendor/three.module.min.js'), 'utf8');
  // Use the pinned renderer's real unroller, so shadow sampler indices and the
  // retained runtime loop are checked after the same transform used by WebGL.
  const unrollStart = vendor.lastIndexOf('const ', vendor.indexOf('/#pragma unroll_loop_start'));
  const unrollEnd = vendor.indexOf('return r}', unrollStart) + 'return r}'.length;
  const unrollSource = vendor.slice(unrollStart, unrollEnd);
  const unrollName = unrollSource.match(/function (\w+)\(t\)\{return t\.replace/)?.[1];
  assert(unrollStart >= 0 && unrollName, 'The pinned renderer exposes its expected loop unroller');
  const unroll = vm.runInNewContext(unrollSource + ';' + unrollName);
  const runtimePoints = guardedPoints.slice(guardedPoints.indexOf('#pragma unroll_loop_end'));
  assert.doesNotMatch(runtimePoints, /getPointShadow|pointShadowMap|pointLightShadow|vPointShadowCoord/,
    'The runtime loop contains no dynamically indexed shadow samplers or shadow uniforms');
  for (const count of [0, 1, 18, 72, 256]) for (const budget of [0, 2, 8]) {
    const shadowCount = Math.min(count, budget);
    const expanded = unroll(guardedPoints.replaceAll('NUM_POINT_LIGHT_SHADOWS', String(shadowCount))
      .replaceAll('NUM_POINT_LIGHTS', String(count)));
    assert.doesNotMatch(expanded, /#pragma unroll_loop/, 'The shadow loop is consumed by Three');
    assert.match(expanded, new RegExp(`int homeFirstLight = max\\(homeRunStart, ${shadowCount}\\)`),
      'The runtime range starts after the exact statically sampled shadow prefix');
    assert.match(expanded, new RegExp(`int homeRunEnd = min\\(homeLightRunEnds\\[homeRun\\], ${count}\\)`),
      'Runtime ranges cannot extend beyond the actual Three point-light count');
    assert.match(expanded, /for \( int i = homeFirstLight; i < homeRunEnd; i \+\+ \)/,
      'One shared runtime body visits each slot in a contributing room run');
    const samplers = [...expanded.matchAll(/getPointShadow\( pointShadowMap\[ (\d+) \]/g)].map(match => Number(match[1]));
    assert.deepEqual(samplers, Array.from({length: shadowCount}, (_, i) => i),
      'Every shadow sampler keeps exactly one literal index, in original order');
    const staticLights = [...expanded.matchAll(/pointLight = pointLights\[ (\d+) \]/g)].map(match => Number(match[1]));
    assert.deepEqual(staticLights, samplers, 'Only the shadowed prefix expands into literal light slots');
    assert.equal((expanded.match(/getPointLightInfo\(/g) || []).length, shadowCount + 1,
      'Shader light work expands with shadow budget, not the total fixture count');
    assert.equal((expanded.match(/if \(directLight.visible\) RE_Direct\(/g) || []).length, shadowCount + 1,
      'Every static or runtime light body retains the full nonzero direct-light calculation');
  }
  assert.equal((runtimePoints.match(/homeRoomTransmissions\[/g) || []).length, 1,
    'The runtime loop looks up transmission once per run, not once per fixture');
  assert(runtimePoints.indexOf('if (homeRunTransmission != 0.0)') < runtimePoints.indexOf('for ( int i = homeFirstLight'),
    'A zero-transmission room skips its entire light range');
  assert.match(runtimePoints, /directLight.color \*= homeRunTransmission;/,
    'Every admitted light keeps the exact nonzero doorway transmission');
  const comparatorSource = vendor.match(/function \w+\(t,e\)\{return\(e\.castShadow\?2:0\)-\(t\.castShadow\?2:0\)\+\(e\.map\?1:0\)-\(t\.map\?1:0\)\}/)?.[0];
  assert(comparatorSource, 'Pinned Three comparator must still sort shadow casters first');
  const compareLights = vm.runInNewContext('(' + comparatorSource + ')');
  const lights = Array.from({length: 72}, (_, i) => new THREE.PointLight(0xffffff, i + 1));
  for (const [maxTextures, expected] of [[0, 0], [3, 0], [4, 0], [5, 1], [8, 4], [12, 8], [16, 8], [32, 8], [undefined, 4]]) {
    lighting.configurePointShadows(lights, {maxTextures, maxTextureSize: 1024});
    assert.equal(lights.filter(light => light.castShadow).length, expected, 'Reserve four fragment samplers and cap point shadows at eight');
    lights.forEach((light, i) => {
      assert.equal(light.intensity, i + 1, 'Unshadowed lights retain their illumination');
      assert.equal(light.visible, true, 'Every fixture remains visible');
      assert.equal(light.shadow.map, null, 'Configuration does not allocate render targets');
      assert(light.shadow.mapSize.x * 4 <= 1024, 'Configured atlas fits hardware limits');
    });
  }
  const fewLights = lights.slice(0, 3);
  lighting.configurePointShadows(fewLights, {maxTextures: 8, maxTextureSize: 4096});
  assert(fewLights.every(light => light.castShadow), 'Small scenes retain every point shadow');
  lighting.configurePointShadows(lights, {maxTextures: 16, maxTextureSize: 4096});
  const rooms = Array.from({length: 24}, (_, i) => ({id: 'room-' + i, exterior: i === 3,
    polygon: [[i * 2, 0], [i * 2 + 1, 0], [i * 2, 1]]}));
  const daylightWindows = [5, 20].map(i => ({room: rooms[i].id, a: rooms[i].polygon[0], b: rooms[i].polygon[1]}));
  const orderedLighting = lighting.createRoomLighting(THREE, rooms, lights.length, daylightWindows);
  const orderedMaterial = new THREE.MeshStandardMaterial();
  orderedLighting.attach({traverse: visit => visit({material: orderedMaterial, userData: {}})}, true);
  const orderedShader = {uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader};
  orderedMaterial.onBeforeCompile(orderedShader);
  // Interleave shadowed and unshadowed lights to detect accidental traversal-only order.
  const points = lights.map((light, i) => ({light, item: {room: rooms[i % rooms.length].id}}));
  points.sort((a, b) => (a.light.intensity % 8) - (b.light.intensity % 8));
  points.splice(4, 0, {item: {room: 'no-light'}});
  const checkOrder = (currentPoints = points) => {
    orderedLighting.update(currentPoints);
    const ordered = currentPoints.filter(point => point.light?.visible).sort((a, b) => compareLights(a.light, b.light));
    const expected = ordered.map(point => rooms.findIndex(room => room.id === point.item.room) + 1);
    assert.deepEqual(Array.from(orderedShader.uniforms.homePointRooms.value),
      expected.concat(Array(lights.length - expected.length).fill(0)),
      'Every visible light retains the correct room after Three sorts shadow casters');
    const expectedEnds = [];
    for (let i = 1; i <= expected.length; i++) if (i === expected.length || expected[i] !== expected[i - 1]) expectedEnds.push(i);
    const runCount = orderedShader.uniforms.homeLightRunCount.value;
    const ends = Array.from(orderedShader.uniforms.homeLightRunEnds.value);
    assert.equal(runCount, expectedEnds.length);
    assert.deepEqual(ends, expectedEnds.concat(Array(lights.length - runCount).fill(0)),
      'Contiguous runs cover the actual sorted visible slots once, with no stale suffix');
    // Actual shadows, globally disabled shadows, and an all-shadow prefix use
    // the same runs. Preserve summation order even for interleaved rooms.
    for (const prefix of [0, ordered.filter(point => point.light.castShadow).length, ordered.length]) {
      for (const contributes of [() => true, room => room === 0, room => room % 2 === 0]) {
        const visited = Array.from({length: prefix}, (_, i) => i).filter(i => contributes(expected[i]));
        let start = 0;
        for (const end of ends.slice(0, runCount)) {
          const first = Math.max(start, prefix);
          if (first < end && contributes(expected[first])) for (let i = first; i < end; i++) visited.push(i);
          start = end;
        }
        assert.deepEqual(visited, expected.flatMap((room, i) => contributes(room) ? [i] : []),
          'Shadow prefix plus runtime runs retain every contributing slot in its original order');
      }
    }
  };
  checkOrder();
  lights[1].visible = false; lights[15].visible = false; checkOrder();
  lights[1].visible = true; lights[15].visible = true; checkOrder();
  lighting.configurePointShadows(lights, {maxTextures: 5}); checkOrder();
  assert.deepEqual(Array.from(orderedShader.uniforms.homeLitRooms.value), Array(24).fill(1));
  lights.forEach(light => { light.intensity = 0; });
  checkOrder();
  assert.deepEqual(Array.from(orderedShader.uniforms.homeLitRooms.value), Array(24).fill(0),
    'Zero-intensity rooms skip polygon work while keeping their point-light slots');
  assert.equal(Array.from(orderedShader.uniforms.homePointRooms.value).filter(Boolean).length, 72);
  lights[3].intensity = 1; lights[8].intensity = .5; lights[8].visible = false;
  checkOrder();
  assert.deepEqual(Array.from(orderedShader.uniforms.homeLitRooms.value), Array.from({length: 24}, (_, i) => Number(i === 3)),
    'Only rooms with visible contributing lights enable transmission calculations');
  const savedRooms = [points[0].item.room, points[1].item.room];
  points[0].item.room = 'unassigned'; delete points[1].item.room; checkOrder();
  [points[0].item.room, points[1].item.room] = savedRooms;
  const runStorage = orderedShader.uniforms.homeLightRunEnds.value;
  orderedLighting.update([]);
  assert.equal(orderedShader.uniforms.homeLightRunCount.value, 0);
  assert(runStorage.every(end => end === 0), 'Removing every light clears all run data');
  checkOrder();
  assert.equal(orderedShader.uniforms.homeLightRunEnds.value, runStorage, 'State updates reuse the fixed run storage');
  lights.forEach(light => {light.visible = true;});
  lighting.configurePointShadows(lights, {maxTextures: 6});
  const groupedPoints = lights.map((light, i) => ({light, item: {room: rooms[Math.floor(i / 3)].id}}));
  // Two shadowed lights split the first three-light room run. Exercise the
  // complete coverage/order assertion across that boundary as well.
  checkOrder(groupedPoints);
  assert.equal(orderedShader.uniforms.homeLightRunCount.value, 24,
    'The 72-light fixture needs only 24 transmission lookups in its runtime light loop');
  assert.deepEqual(Array.from(runStorage.slice(0, 24)), Array.from({length: 24}, (_, i) => (i + 1) * 3));
  lights.forEach(light => {light.castShadow = true;}); checkOrder();
  lights.forEach(light => {light.castShadow = false;}); checkOrder();
  const unassignedMaterial = new THREE.MeshStandardMaterial();
  const unassignedLighting = lighting.createRoomLighting(THREE, [], 3, []);
  unassignedLighting.attach({traverse: visit => visit({material: unassignedMaterial, userData: {}})}, true);
  const unassignedShader = {uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader};
  unassignedMaterial.onBeforeCompile(unassignedShader);
  unassignedLighting.update(lights.slice(0, 3).map(light => ({light, item: {}})));
  assert.deepEqual(Array.from(unassignedShader.uniforms.homePointRooms.value), [0, 0, 0]);
  assert.equal(unassignedShader.uniforms.homeLightRunCount.value, 1);
  assert.deepEqual(Array.from(unassignedShader.uniforms.homeLightRunEnds.value), [3, 0, 0]);
  assert.match(unassignedShader.fragmentShader, /homeRoomTransmissions\[0\] = 1\.0;/,
    'A scene with no rooms retains every unassigned light at full transmission');
  const cacheAssignments = orderedShader.fragmentShader.match(/homeRoomTransmissions\[\d+\] = homeLitRooms/g) || [];
  assert.equal(cacheAssignments.length, rooms.length, 'Cache size and work grow with rooms, not the light count');
  const distanceFunctions = [...orderedShader.fragmentShader.matchAll(/float homeRoomDistance(\d+)\(\) \{([\s\S]*?)\n  \}/g)];
  assert.equal(distanceFunctions.length, rooms.length, 'Each room has one branch-free distance function');
  assert.doesNotMatch(orderedShader.fragmentShader, /homeRoomDistance\(|zone ==/,
    'No call can inline a branch chain containing every other room polygon');
  for (const [index, match] of distanceFunctions.entries()) {
    assert.equal(Number(match[1]), index + 1);
    const edges = [...match[2].matchAll(/homeRoomEdge\(p, vec2\(([^)]+)\), vec2\(([^)]+)\), distanceToRoom, inside\);/g)]
      .map(edge => [edge[1].split(',').map(Number), edge[2].split(',').map(Number)]);
    const polygon = rooms[index].polygon;
    assert.deepEqual(edges, polygon.map((point, i) => [point, polygon[(i + 1) % polygon.length]]),
      'Each specialized function keeps its exact room edges, winding and closing edge');
    assert.match(match[2], /vec2 p = homeWorldPosition\.xz;/);
    assert.match(match[2], /float distanceToRoom = 100000000\.0;\s+bool inside = false;/);
    assert.match(match[2], /float distance = sqrt\(distanceToRoom\);\s+return inside \? -distance : distance;/);
    assert(orderedShader.fragmentShader.includes(`homeRoomTransmissions[${index + 1}] = homeLitRooms[${index}] != 0 && homeRoomNearby${index + 1}() ? homeRoomTransmission(homeRoomDistance${index + 1}()) : 0.0;`),
      'Every room transmission uses only its corresponding polygon');
  }
  const exteriorRooms = [...orderedShader.fragmentShader.matchAll(/exterior = max\(exterior, 1\.0-smoothstep\(0\.0,0\.04,homeRoomDistance(\d+)\(\)\)\);/g)]
    .map(match => Number(match[1]));
  assert.deepEqual(exteriorRooms, [4], 'Exterior lighting retains the correct specialized room');
  const windowRooms = [...orderedShader.fragmentShader.matchAll(/if \(homeRoomDistance(\d+)\(\) <= 0\.015\)/g)]
    .map(match => Number(match[1]));
  assert.deepEqual(windowRooms, [6, 21], 'Window spill retains each opening\'s own room');

  // Validate the broad phase against exact polygon distance, including concave
  // rooms, reversed winding, negative coordinates and the 0.55 m cutoff.
  const polygons = [
    [[0, 0], [4, 0], [4, 3], [0, 3]],
    [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]],
    [[-3.25, -1.75], [-.25, -3.75], [1.75, -.75], [-1.25, 1.25]],
  ];
  const probeRooms = polygons.flatMap((polygon, i) => [polygon, [...polygon].reverse()]
    .map((points, winding) => ({id: `probe-${i}-${winding}`, polygon: points})));
  const probeMaterial = new THREE.MeshStandardMaterial();
  lighting.createRoomLighting(THREE, probeRooms, 1, [])
    .attach({traverse: visit => visit({material: probeMaterial, userData: {}})}, true);
  const probeShader = {uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader};
  probeMaterial.onBeforeCompile(probeShader);
  const boundFunctions = [...probeShader.fragmentShader.matchAll(/bool homeRoomNearby(\d+)\(\) \{[\s\S]*?greaterThanEqual\(p, vec2\(([^)]+)\) - vec2\(([^)]+)\)\)[\s\S]*?lessThanEqual\(p, vec2\(([^)]+)\) \+ vec2\(([^)]+)\)\)/g)];
  assert.equal(boundFunctions.length, probeRooms.length, 'Every room gets its own constant bounds');
  assert.match(probeShader.fragmentShader, /vec2 delta = p - a - edge \* clamp/);
  assert.match(probeShader.fragmentShader, /d = min\(d, dot\(delta, delta\)\);/,
    'Each edge accumulates squared distance without a square root');
  const referenceDistance = (polygon, p, squared) => {
    let distance = squared ? 100000000 : 10000, inside = false;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      const edge = [b[0] - a[0], b[1] - a[1]];
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * edge[0] + (p[1] - a[1]) * edge[1]) / (edge[0] ** 2 + edge[1] ** 2)));
      const delta = [p[0] - a[0] - edge[0] * t, p[1] - a[1] - edge[1] * t];
      distance = Math.min(distance, squared ? delta[0] ** 2 + delta[1] ** 2 : Math.hypot(...delta));
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    if (squared) distance = Math.sqrt(distance);
    return inside ? -distance : distance;
  };
  const transmission = distance => {
    if (distance <= 0) return 1;
    const t = Math.max(0, Math.min(1, (distance - .1) / (.55 - .1)));
    return Math.exp(-8 * distance) * (1 - t * t * (3 - 2 * t));
  };
  let skippedPolygons = 0, checkedPoints = 0;
  for (const [index, match] of boundFunctions.entries()) {
    const polygon = probeRooms[index].polygon, min = match[2].split(',').map(Number), max = match[4].split(',').map(Number);
    const lowerPadding = Number(match[3]), upperPadding = Number(match[5]);
    assert.equal(Number(match[1]), index + 1);
    assert.deepEqual(min, [Math.min(...polygon.map(p => p[0])), Math.min(...polygon.map(p => p[1]))]);
    assert.deepEqual(max, [Math.max(...polygon.map(p => p[0])), Math.max(...polygon.map(p => p[1]))]);
    assert(lowerPadding > .55 && upperPadding > .55, 'Bounds conservatively include the entire nonzero spill');
    const positions = [];
    for (let x = min[0] - 2; x <= max[0] + 2; x += .19) for (let z = min[1] - 2; z <= max[1] + 2; z += .23) positions.push([x, z]);
    for (const vertex of polygon) for (const d of [0, .0149, .0151, .0399, .0401, .1, .54999, .55, .55001, .56, .56001]) {
      for (const axis of [0, 1]) for (const sign of [-1, 1]) {const p = [...vertex]; p[axis] += sign * d; positions.push(p);}
    }
    for (const p of positions) {
      checkedPoints++;
      const distance = referenceDistance(polygon, p, false), optimized = referenceDistance(polygon, p, true);
      assert(Math.abs(distance - optimized) < 1e-10, 'One final square root retains signed polygon distance');
      const nearby = p.every((value, axis) => value >= min[axis] - lowerPadding && value <= max[axis] + upperPadding);
      if (!nearby) {skippedPolygons++; assert.equal(transmission(distance), 0, 'A culled fragment has exactly zero room transmission');}
      assert(Math.abs(transmission(distance) - (nearby ? transmission(optimized) : 0)) < 1e-12,
        'Broad-phase culling preserves all room light, including concave notches and doorway spill');
    }
  }
  assert(checkedPoints > 5000 && skippedPolygons > checkedPoints / 4, 'The bounds avoid measurable polygon work on the probe grid');

  let allocations = 0;
  class TrackedVector extends THREE.Vector3 { constructor(...args) { super(...args); allocations++; } }
  const rect = {width: 1200, height: 700};
  const label = {room: 'A', position: new THREE.Vector3(2, .06, 2), el: {style: {}}};
  const context = vm.createContext({
    THREE: {...THREE, Vector3: TrackedVector}, active: true, renderProfile: {pointShadows:8, pointShadowSize:512}, renderer: {}, camera: undefined, cameraFit: undefined,
    projectedPosition: new THREE.Vector3(), projectedForward: new THREE.Vector3(),
    selected: '', planRadius: 10, planBounds: true, zoom: 1, panX: 0, panY: 0, homeRotation: 0, homeTilt: 0,
    model: {ceiling_height_m: 3, rooms: [
      {id: 'A', polygon: [[0, 0], [4, 0], [4, 4], [0, 4]]},
      {id: 'B', polygon: [[4, 0], [10, 0], [10, 6], [4, 6]]},
    ]},
    xm: x => x, zm: z => z, $: id => id === 'homeStage' ? {getBoundingClientRect: () => rect} : {},
    roomLighting: null, lowerFloorContext: null, assumedZones: null, presenceView: null, vacuumView: null, signalZone: '', showLowerFloor: true,
    labels: [label], points: [], roomCode: id => id, roomName: id => id,
    refreshSignalStatus() {}, drawScene() {}, positionMediaPreviews() {}, renderCount: 0,
  });
  const home = fs.readFileSync(path.join(root, 'home-view.js'), 'utf8');
  const stateStart = home.indexOf('      if (point.overlay) {');
  const stateEnd = home.indexOf('      if (visible &&', stateStart);
  assert(stateStart >= 0 && stateEnd > stateStart, 'Exercise the actual fixture state update');
  const stateUpdate = home.slice(stateStart, stateEnd);
  const fixture = {light: new THREE.PointLight(0xffffff, 0), overlay: {
    visible: false, material: {uniforms: {lightColor: {value: new THREE.Color()}, brightness: {value: 0}}},
  }};
  const group = new THREE.Group(); group.add(fixture.light);
  const stateContext = vm.createContext({THREE, point: fixture, state: 'off', appearance: {rgb: [255, 120, 40], brightness: 1}});
  for (const [state, brightness] of [['on', .7], ['off', 1], ['on', .3], ['disconnected', 1],
    ['missing', 1], ['unavailable', 1], ['preview', 1], ['on', 0], ['on', 1]]) {
    stateContext.state = state; stateContext.appearance.brightness = brightness;
    vm.runInContext(stateUpdate, stateContext);
    assert.equal(fixture.light.visible, true, 'HA state changes preserve the point-light shader slot');
    assert.equal(fixture.light.intensity, state === 'on' ? 12 * brightness : 0,
      'Off, disconnected and missing fixtures emit no light, including stale on-state appearance');
    assert.equal(fixture.overlay.visible, state === 'on', 'Overlay and illuminated API keep their on/off semantics');
    let count = 0; group.traverseVisible(object => { if (object.isPointLight) count++; });
    assert.equal(count, 1, 'Three traverses the same point-light count across all HA states');
  }
  group.visible = false;
  let editorLights = 0; group.traverseVisible(object => { if (object.isPointLight) editorLights++; });
  assert.equal(editorLights, 0, 'Hiding the Home overlay group still removes its lights in editor mode');
  vm.runInContext(home.slice(home.indexOf('  function render() {'), home.indexOf('  function clearTrail(')), context);
  const fitInsideView = () => {
    const rooms = context.model.rooms.filter(room => !context.selected || room.id === context.selected);
    for (const room of rooms) for (const [x, z] of room.polygon) for (const y of [0, 3]) {
      const p = new THREE.Vector3(x, y, z).project(context.camera);
      assert(Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1, 'Room corners fit in the Home camera');
    }
  };
  context.render();
  fitInsideView();
  const initialAllocations = allocations, firstFit = context.cameraFit;
  const initialLeft = context.camera.left, initialTop = context.camera.top;
  const initialWidth = context.camera.right - context.camera.left;
  const initialLabel = {...label.el.style};
  for (let i = 0; i < 30; i++) context.render();
  assert.equal(allocations, initialAllocations, 'Repeated state/media frames allocate no room or label vectors');
  assert.equal(context.cameraFit, firstFit, 'Repeated frames retain the room fit');
  assert.deepEqual(label.el.style, initialLabel, 'Marker projection is unchanged');
  context.panX = 2; context.panY = -1; context.render();
  assert.equal(context.camera.left, initialLeft + 2);
  assert.equal(context.camera.top, initialTop - 1);
  context.zoom = 2; context.render();
  assert.equal(context.camera.right - context.camera.left, initialWidth / 2);
  assert.equal(allocations, initialAllocations, 'Pan and zoom reuse room geometry');
  context.panX = context.panY = 0; context.zoom = 1;
  const originalRoomGeometry = JSON.stringify(context.model.rooms), originalOrientation = context.camera.quaternion.toArray();
  const cachedVertices = context.cameraFit.vertices;
  for (const rotation of [Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 2]) for (const tilt of [-.45, 0, .6]) {
    context.homeRotation = rotation; context.homeTilt = tilt; context.render();
    assert.notDeepEqual(context.camera.quaternion.toArray(), originalOrientation, 'Home rotation changes the actual rendered camera orientation');
    fitInsideView();
    assert.equal(context.cameraFit, firstFit, 'Rotation reuses the room fit cache');
    assert.equal(context.cameraFit.vertices, cachedVertices, 'Rotation retains the original room vertices');
    assert.equal(allocations, initialAllocations, 'Rotation does not allocate room or marker vectors');
    assert(Number.isFinite(parseFloat(label.el.style.left)) && Number.isFinite(parseFloat(label.el.style.top)), 'Labels remain projectable at the tilt limits');
  }
  assert.notDeepEqual(label.el.style, initialLabel, 'Labels follow the rotated camera');
  assert.equal(JSON.stringify(context.model.rooms), originalRoomGeometry, 'Camera rotation never changes the floor plan');
  const rotatedProjection = context.camera.projectionMatrix.toArray(), rotatedOrientation = context.camera.quaternion.toArray();
  for (let i = 0; i < 30; i++) context.render();
  assert.deepEqual(context.camera.projectionMatrix.toArray(), rotatedProjection, 'State/media frames preserve the rotated fit');
  assert.deepEqual(context.camera.quaternion.toArray(), rotatedOrientation);
  assert.equal(allocations, initialAllocations, 'Stationary rotated frames reuse all room and marker vectors');
  context.homeRotation = context.homeTilt = 0; context.render();
  assert.deepEqual(context.camera.quaternion.toArray(), originalOrientation, 'Resetting camera angles restores the initial orientation');
  context.panX = context.panY = 0; context.zoom = 1; context.selected = 'A'; context.render();
  assert.notEqual(context.cameraFit, firstFit, 'Changing the room refreshes the fit');
  fitInsideView();
  assert(context.camera.right - context.camera.left < initialWidth, 'Room focus zooms to the selected room');
  const selectedFit = context.cameraFit;
  rect.width = 390; rect.height = 844; context.render();
  assert.notEqual(context.cameraFit, selectedFit, 'Portrait orientation refreshes the fit');
  fitInsideView();
  const portraitFit = context.cameraFit;
  rect.width = 430; context.render();
  assert.equal(context.cameraFit, portraitFit, 'Resizing within an orientation reuses geometry');
  fitInsideView();
  console.log('PASS: Point-shadow samplers and atlas memory are bounded; every light retains its room; unlit rooms skip transmission work; Home rotation fits all corners and reuses geometry and marker vectors across idle, pan, zoom, focus and resize.');
})().catch(error => { console.error(error); process.exitCode = 1; });
