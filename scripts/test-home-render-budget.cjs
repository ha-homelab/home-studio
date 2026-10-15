'use strict';
// Exercise real Home rendering with synthetic rooms and no HA/device commands.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

(async () => {
  const THREE = await import('data:text/javascript;base64,' + fs.readFileSync(path.join(root, 'vendor/three.module.min.js')).toString('base64'));
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
  assert(shader.fragmentShader.indexOf('homeRoomTransmissions[1] = homeLitRooms[0] != 0 ? homeRoomTransmission(1) : 0.0;') < guardedStart,
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
    assert.match(expanded, new RegExp(`for \\( int i = ${shadowCount}; i < ${count}; i \\+\\+ \\)`),
      'The runtime loop covers every unshadowed slot through the original total light count');
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
  const rooms = Array.from({length: 24}, (_, i) => ({id: 'room-' + i, polygon: [[0, 0], [1, 0], [0, 1]]}));
  const orderedLighting = lighting.createRoomLighting(THREE, rooms, lights.length, []);
  const orderedMaterial = new THREE.MeshStandardMaterial();
  orderedLighting.attach({traverse: visit => visit({material: orderedMaterial, userData: {}})}, true);
  const orderedShader = {uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader};
  orderedMaterial.onBeforeCompile(orderedShader);
  // Interleave shadowed and unshadowed lights to detect accidental traversal-only order.
  const points = lights.map((light, i) => ({light, item: {room: rooms[i % rooms.length].id}}));
  points.sort((a, b) => (a.light.intensity % 8) - (b.light.intensity % 8));
  points.splice(4, 0, {item: {room: 'no-light'}});
  const checkOrder = () => {
    orderedLighting.update(points);
    const expected = points.filter(point => point.light?.visible).sort((a, b) => compareLights(a.light, b.light))
      .map(point => rooms.findIndex(room => room.id === point.item.room) + 1);
    expected.push(...Array(lights.length - expected.length).fill(0));
    assert.deepEqual(Array.from(orderedShader.uniforms.homePointRooms.value), expected,
      'Every visible light retains the correct room after Three sorts shadow casters');
  };
  checkOrder();
  lights[1].visible = false; lights[15].visible = false; checkOrder();
  lights[1].visible = true; lights[15].visible = true; checkOrder();
  lighting.configurePointShadows(lights, {maxTextures: 5}); checkOrder();
  assert.deepEqual(Array.from(orderedShader.uniforms.homeLitRooms.value), Array(24).fill(1));
  lights.forEach(light => { light.intensity = 0; });
  orderedLighting.update(points);
  assert.deepEqual(Array.from(orderedShader.uniforms.homeLitRooms.value), Array(24).fill(0),
    'Zero-intensity rooms skip polygon work while keeping their point-light slots');
  assert.equal(Array.from(orderedShader.uniforms.homePointRooms.value).filter(Boolean).length, 72);
  lights[3].intensity = 1; lights[8].intensity = .5; lights[8].visible = false;
  orderedLighting.update(points);
  assert.deepEqual(Array.from(orderedShader.uniforms.homeLitRooms.value), Array.from({length: 24}, (_, i) => Number(i === 3)),
    'Only rooms with visible contributing lights enable transmission calculations');
  const cacheAssignments = orderedShader.fragmentShader.match(/homeRoomTransmissions\[\d+\] = homeLitRooms/g) || [];
  assert.equal(cacheAssignments.length, rooms.length, 'Cache size and work grow with rooms, not the light count');

  let allocations = 0;
  class TrackedVector extends THREE.Vector3 { constructor(...args) { super(...args); allocations++; } }
  const rect = {width: 1200, height: 700};
  const label = {room: 'A', position: new THREE.Vector3(2, .06, 2), el: {style: {}}};
  const context = vm.createContext({
    THREE: {...THREE, Vector3: TrackedVector}, active: true, renderProfile: {pointShadows:8, pointShadowSize:512}, renderer: {}, camera: undefined, cameraFit: undefined,
    projectedPosition: new THREE.Vector3(), projectedForward: new THREE.Vector3(),
    selected: '', planRadius: 10, planBounds: true, zoom: 1, panX: 0, panY: 0,
    model: {ceiling_height_m: 3, rooms: [
      {id: 'A', polygon: [[0, 0], [4, 0], [4, 4], [0, 4]]},
      {id: 'B', polygon: [[4, 0], [10, 0], [10, 6], [4, 6]]},
    ]},
    xm: x => x, zm: z => z, $: id => id === 'homeStage' ? {getBoundingClientRect: () => rect} : {},
    roomLighting: null, lowerFloorContext: null, assumedZones: null, signalZone: '', showLowerFloor: true,
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
  console.log('PASS: Point-shadow samplers and atlas memory are bounded; every light retains its room; unlit rooms skip transmission work; Home fit and marker vectors are reused without changing pan, zoom, focus or resize.');
})().catch(error => { console.error(error); process.exitCode = 1; });
