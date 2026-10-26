import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createEnvironmentLayer, ENVIRONMENT_PALETTES } from '../planner/environment.js';
const THREE = await import('data:text/javascript;base64,' + readFileSync(new URL('../vendor/three.module.min.js', import.meta.url)).toString('base64'));
class Events {
  listeners = new Map();
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  emit(name) { for (const fn of this.listeners.get(name) || []) fn(); }
}
const doc = new Events(), win = new Events(), media = new Events(), timers = new Map();
let sequence = 0, renders = 0, intersection; const renderRequests = [];
win.IntersectionObserver = class { constructor(callback) { intersection = callback; } observe() {} disconnect() { intersection = null; } };
win.matchMedia = () => media;
win.setTimeout = fn => { const id = ++sequence; timers.set(id, fn); return id; };
win.clearTimeout = id => timers.delete(id);
const advance = () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); };
const scene = new THREE.Scene(), bounds = { minX: 0, maxX: 10, minZ: 0, maxZ: 8 };
const layer = createEnvironmentLayer(THREE, { scene, bounds, elevation: -3, visibilityElement: {}, document: doc, window: win, requestRender: motion => { renders++; renderRequests.push(motion); } });
assert.equal(layer.stats.drawCalls, 0); assert.equal(layer.stats.actors, 0); assert.equal(timers.size, 0);
assert.equal(scene.children[0].children.length, 0, 'Off creates no geometry or GPU materials');
layer.setSettings({ enabled: true });
assert.equal(timers.size, 0, 'Static scenery never schedules frames');
assert(layer.stats.drawCalls <= 16, 'Shared instance batches keep scenery draw calls bounded');
assert.equal(layer.stats.actors, 5);
function checkSiteClear(target = scene, site = bounds) {
  target.updateMatrixWorld(true);
  const matrix = new THREE.Matrix4();
  for (const mesh of target.children[0].children) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    for (let index = 0; index < mesh.count; index++) {
      mesh.getMatrixAt(index, matrix); matrix.premultiply(mesh.matrixWorld);
      const box = mesh.geometry.boundingBox.clone().applyMatrix4(matrix);
      assert(box.max.x < site.minX || box.min.x > site.maxX || box.max.z < site.minZ || box.min.z > site.maxZ,
        'Every complete scenery envelope stays outside the existing site');
    }
  }
}
checkSiteClear();
layer.setSettings({ motion: true });
assert.equal(timers.size, 1);
renderRequests.length = 0;
for (let i = 0; i < 600; i++) { advance(); checkSiteClear(); }
assert(renderRequests.every(motion => motion === true), 'Decorative ticks preserve the viewer adaptive motion throttle');
assert(layer.stats.elapsed > 100, 'Long run exercises lane wrapping without entering site');
const elapsed = layer.stats.elapsed;
doc.hidden = true; doc.emit('visibilitychange'); assert.equal(timers.size, 0); advance(); assert.equal(layer.stats.elapsed, elapsed);
doc.hidden = false; doc.emit('visibilitychange'); assert.equal(timers.size, 1);
media.matches = true; media.emit('change'); assert.equal(timers.size, 0); assert.equal(layer.stats.moving, false);
media.matches = false; media.emit('change'); assert.equal(timers.size, 1);
layer.setActive(false); assert.equal(timers.size, 0); layer.setActive(true); assert.equal(timers.size, 1);
intersection([{isIntersecting:false}]); assert.equal(timers.size, 0); intersection([{isIntersecting:true}]); assert.equal(timers.size, 1);
win.emit('pagehide'); assert.equal(timers.size, 0); win.emit('pageshow'); assert.equal(timers.size, 1);
for (const palette of ['meadow', 'dusk', 'sage']) { layer.setSettings({ palette }); checkSiteClear(); assert.equal(layer.stats.actors, 5); }
// Exercise the real viewer failure path with a running layer, not a timer stub.
const reportError = readFileSync(new URL('../viewer.js', import.meta.url), 'utf8').split('\n').find(line => line.startsWith('function report3DError('));
assert(reportError);
runInNewContext(reportError + '; report3DError(new Error("Synthetic render failure"));', {
  reflectionEnvironment: null, contactShading: null, environmentLayer: layer, homeView: null, failed3D: false, initialViewReady: true, requestRender() {},
  cancelRender() {}, $: () => ({ style: {} }), console: { error() {} },
});
assert.equal(timers.size, 0, 'A fatal viewer error stops decorative work as well as rendering');
assert.equal(layer.stats.actors, 0, 'A fatal viewer error releases its decorative resources');
const failedElapsed = layer.stats.elapsed;
win.emit('pageshow'); layer.setActive(true); advance();
assert.equal(timers.size, 0); assert.equal(layer.stats.elapsed, failedElapsed, 'A failed viewer does not resume decorative work');
layer.setSettings({ motion: false }); assert.equal(timers.size, 0); const stoppedRenders = renders; advance(); assert.equal(renders, stoppedRenders);
layer.dispose(); assert.equal(scene.children.length, 0); assert.equal(intersection,null); assert.equal(timers.size, 0);
assert([...doc.listeners.values(), ...win.listeners.values(), ...media.listeners.values()].every(set => set.size === 0));

function simulateTraffic(seed, site = bounds, useMetadata = false, roadSide = 'minZ') {
  const target = new THREE.Scene();
  const options = { scene: target, bounds: site, frameInterval: 2000, document: doc, window: win, settings: { enabled: true, motion: true } };
  if (useMetadata) Object.assign(options.settings, { seed, road_side: roadSide });
  else Object.assign(options, { seed, roadSide });
  const trafficLayer = createEnvironmentLayer(THREE, options);
  assert.equal(trafficLayer.stats.trafficSeed, seed);
  assert.equal(trafficLayer.stats.roadSide, roadSide);
  const meshes = [...target.children[0].children];
  const resources = meshes.map(mesh => [mesh.geometry, mesh.material, mesh.instanceMatrix, mesh.instanceMatrix.array, mesh.instanceColor, mesh.instanceColor?.array]);
  const bodies = meshes.filter(mesh => mesh.instanceColor);
  assert.equal(bodies.length, 1, 'Both car bodies share one color-enabled batch');
  assert.equal(bodies[0].count, 2, 'Traffic always consists of exactly two car instances');
  const positions = new Float64Array(2), previousColors = new Float32Array(6), matrix = new THREE.Matrix4();
  const changes = [[], []], seenColors = [new Set(), new Set()], waiting = [0, 0];
  const roadEdge = roadSide === 'maxZ' ? site.maxZ : site.minZ, roadDirection = roadSide === 'maxZ' ? 1 : -1;
  let previous = trafficLayer.stats;
  function recordPositions() {
    for (let index = 0; index < 2; index++) { bodies[0].getMatrixAt(index, matrix); positions[index] = matrix.elements[12]; }
    previousColors.set(bodies[0].instanceColor.array);
  }
  recordPositions();
  for (let tick = 0; tick < 900; tick++) {
    advance();
    const current = trafficLayer.stats;
    assert.equal(current.actors, 5); assert.equal(current.traffic.length, 2); assert.equal(timers.size, 1);
    checkSiteClear(target, site);
    for (let index = 0; index < 2; index++) {
      const car = current.traffic[index], before = previous.traffic[index];
      assert(car.speed >= .22 && car.speed < .46, 'Every pass has a restrained bounded speed');
      assert(car.cycle === 0 ? car.entryDelay === 0 : car.entryDelay >= 2 && car.entryDelay < 9, 'Arrival gaps stay bounded');
      seenColors[index].add(car.color);
      bodies[0].getMatrixAt(index, matrix);
      assert(Math.abs(matrix.elements[14] - (roadEdge + roadDirection * 6 + (index ? -.65 : .65))) < .00001,
        'Cars stay on the configured side throughout waiting and repeated passes');
      assert.equal(matrix.elements[0] === 0, !car.visible, 'The waiting car is hidden by its instance transform');
      if (!car.visible) waiting[index]++;
      if (car.cycle !== before.cycle) {
        assert.equal(car.cycle, before.cycle + 1);
        assert.notEqual(car.color, before.color, 'A new pass changes body color without replacing its material');
        const offset = index * 3, colors = bodies[0].instanceColor.array;
        assert(colors[offset] !== previousColors[offset] || colors[offset + 1] !== previousColors[offset + 1] || colors[offset + 2] !== previousColors[offset + 2], 'The rendered body color changes with the new pass');
        changes[index].push([tick, car.speed, car.entryDelay, car.color]);
      } else if (car.visible && before.visible) {
        const distance = (matrix.elements[12] - positions[index]) * (index ? -1 : 1);
        assert(Math.abs(distance - car.speed * 2) < .00001, 'Rendered car travel follows its individual speed and fixed lane direction');
      }
    }
    bodies[0].getMatrixAt(0, matrix); const positiveLaneZ = matrix.elements[14];
    bodies[0].getMatrixAt(1, matrix);
    assert(positiveLaneZ > matrix.elements[14], 'The +X car stays on the +Z lane on either side of the site');
    if (tick === 100) {
      const paused = trafficLayer.stats;
      doc.hidden = true; doc.emit('visibilitychange'); advance();
      assert.deepEqual(trafficLayer.stats.traffic, paused.traffic, 'Hidden time does not change arrivals, speed or color');
      assert.equal(trafficLayer.stats.elapsed, paused.elapsed);
      doc.hidden = false; doc.emit('visibilitychange');
    }
    recordPositions(); previous = current;
  }
  for (let index = 0; index < 2; index++) {
    assert(changes[index].length > 10, 'The simulation covers many reuse cycles per lane');
    assert(waiting[index] > 10, 'Traffic includes observable gaps instead of continuous wrapping');
    assert(seenColors[index].size >= 3, 'Passing traffic uses a restrained variety of colors');
    assert(new Set(changes[index].map(change => change[1])).size > 10, 'Passes vary their speeds');
  }
  assert.deepEqual(target.children[0].children, meshes, 'No mesh is added or replaced during repeated passes');
  meshes.forEach((mesh, index) => [mesh.geometry, mesh.material, mesh.instanceMatrix, mesh.instanceMatrix.array, mesh.instanceColor, mesh.instanceColor?.array].forEach((resource, slot) => assert.equal(resource, resources[index][slot], 'Animation reuses every geometry, material and instance buffer')));
  trafficLayer.dispose(); assert.equal(timers.size, 0); assert.equal(target.children.length, 0);
  return changes;
}
const seedZero = simulateTraffic(0), seedOne = simulateTraffic(1), seed42 = simulateTraffic(42);
simulateTraffic(0xffffffff, { minX: 0, maxX: .5, minZ: 0, maxZ: .5 });
assert.deepEqual(simulateTraffic(42, bounds, true), seed42, 'The same direct or model-metadata seed reproduces every pass');
assert.notDeepEqual(seedZero, seedOne, 'Different seeds produce different traffic');
for (const seed of [0, 1, 42, 0xffffffff]) {
  const site = seed === 0xffffffff ? { minX: -3, maxX: -2.5, minZ: 4, maxZ: 4.5 } : bounds;
  const expected = seed === 0 ? seedZero : seed === 1 ? seedOne : seed === 42 ? seed42 : simulateTraffic(seed, site);
  assert.deepEqual(simulateTraffic(seed, site, true, 'maxZ'), expected,
    'Changing the road side preserves traffic timing, X direction, reuse and seeded variation');
}

// Non-origin bounds catch incorrect mirroring around world zero. Check the real
// world matrices after palette/settings and site changes, not just the metadata.
const configuredScene = new THREE.Scene(), configuredSite = { minX: -4, maxX: 9, minZ: -7, maxZ: 17 };
const configured = createEnvironmentLayer(THREE, { scene: configuredScene, bounds: configuredSite, elevation: -2,
  settings: { enabled: true, road_side: 'maxZ' }, document: doc, window: win });
function checkApproach(site, palette) {
  assert.equal(configured.stats.roadSide, 'maxZ');
  checkSiteClear(configuredScene, site);
  const meshes = configuredScene.children[0].children, matrix = new THREE.Matrix4();
  for (const [kind, distance, index] of [['road', 6, 0], ['path', 4.1, 0], ['lawn', 2, 2]]) {
    const color = new THREE.Color(ENVIRONMENT_PALETTES[palette][kind]);
    const mesh = meshes.find(mesh => mesh.material.color.equals(color));
    assert(mesh, kind + ' has a shared rendered batch');
    mesh.getMatrixAt(index, matrix); matrix.premultiply(mesh.matrixWorld);
    assert(Math.abs(matrix.elements[14] - site.maxZ - distance) < .00001, kind + ' follows the selected site edge');
  }
  assert.equal(configured.stats.actors, 5); assert.equal(configured.stats.drawCalls, 14);
  assert.equal(timers.size, 0, 'Road configuration never starts an animation timer');
}
checkApproach(configuredSite, 'sage');
const defaultScene = new THREE.Scene();
const defaultLayer = createEnvironmentLayer(THREE, { scene: defaultScene, bounds: configuredSite,
  settings: { enabled: true }, document: doc, window: win });
assert.equal(defaultLayer.stats.roadSide, 'minZ');
assert.equal(configured.stats.drawCalls, defaultLayer.stats.drawCalls, 'Changing sides creates no extra batches');
const plantingColors = ['hedge', 'leaf', 'leafLight', 'trunk'].map(key => new THREE.Color(ENVIRONMENT_PALETTES.sage[key]));
for (const mesh of defaultScene.children[0].children.filter(mesh => plantingColors.some(color => mesh.material.color.equals(color)))) {
  const other = configuredScene.children[0].children.find(candidate => candidate.material.color.equals(mesh.material.color));
  assert.deepEqual(other.instanceMatrix.array, mesh.instanceMatrix.array, 'Side planting stays in place');
}
assert.deepEqual(configuredScene.children[0].children[0].instanceMatrix.array.slice(0, 32),
  defaultScene.children[0].children[0].instanceMatrix.array.slice(0, 32), 'Both long lawn strips stay in place');
defaultLayer.dispose();
configured.setSettings({ enabled: false }); configured.setSettings({ enabled: true, motion: false, palette: 'dusk' });
checkApproach(configuredSite, 'dusk');
const expandedSite = { ...configuredSite, maxX: 14, maxZ: 24 };
configured.setBounds(expandedSite); checkApproach(expandedSite, 'dusk');
configured.dispose(); assert.equal(configuredScene.children.length, 0);
assert([...doc.listeners.values(), ...win.listeners.values(), ...media.listeners.values()].every(set => set.size === 0));
// Real context is conservative: unknown land is never synthesized around a map.
// The model's manually placed tree is outside the disposable demo group.
const realScene = new THREE.Scene(), manual = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
realScene.add(manual); const manualGeometry = manual.geometry;
const real = createEnvironmentLayer(THREE, { scene: realScene, bounds: configuredSite, siteContext: true,
  settings: { enabled: true, motion: true }, document: doc, window: win });
const demoGroup = realScene.getObjectByName('decorative-surroundings');
assert.equal(real.stats.siteContext, true); assert.equal(real.stats.actors, 0);
assert.equal(real.stats.drawCalls, 0); assert.equal(timers.size, 0); assert.equal(demoGroup.children.length, 0);
real.setSettings({ palette: 'dusk' }); real.setBounds(expandedSite, -2.86);
assert.equal(demoGroup.children.length, 0, 'Palette and bounds changes cannot synthesize roads or vegetation in real context');
real.setSiteContext(false);
assert.equal(real.stats.actors, 5); assert.equal(real.stats.drawCalls, 14); assert.equal(timers.size, 1);
assert.equal(real.settings.palette, 'dusk'); assert.equal(real.stats.elevation, -2.86);
const released = new Map();
for (const mesh of demoGroup.children) for (const resource of [mesh.geometry, mesh.material]) if (!released.has(resource)) {
  released.set(resource, 0); resource.addEventListener('dispose', () => released.set(resource, released.get(resource) + 1));
}
real.setSiteContext(true);
assert.equal(real.stats.actors, 0); assert.equal(real.stats.drawCalls, 0); assert.equal(real.stats.moving, false);
assert.equal(timers.size, 0); assert.equal(demoGroup.children.length, 0);
assert([...released.values()].every(count => count === 1), 'Late map context disposes every generated geometry/material exactly once');
real.setSiteContext(true); real.setSettings({ enabled: false }); real.setSettings({ enabled: true });
assert([...released.values()].every(count => count === 1)); assert.equal(timers.size, 0);
assert.equal(manual.parent, realScene); assert.equal(manual.geometry, manualGeometry, 'Manually placed assets retain ownership and geometry');
real.dispose(); real.setSiteContext(false); assert.equal(timers.size, 0);
assert.deepEqual(realScene.children, [manual]); manual.geometry.dispose(); manual.material.dispose();
// Exercise the actual caller expressions, so the shared module receives context
// even outside site-edit mode and before an asynchronous map response arrives.
const editorSource = readFileSync(new URL('../planner/editor.js', import.meta.url), 'utf8');
const siteFunction = editorSource.slice(editorSource.indexOf('function environmentSite() {'), editorSource.indexOf('let previewDetails='));
const project = { floors: [{ walls: [], elevation_m: 0 }], site: { features: [] } };
const editorContext = { displayedProject: () => project, floorBounds: () => bounds, siteEditor: { mapConfigured: false } };
assert.equal(runInNewContext(siteFunction + '; environmentSite().siteContext', editorContext), false);
project.site.features.push({ kind: 'building', polygon: [[-3,0],[-1,0],[-1,8],[-3,8]] });
assert.equal(runInNewContext(siteFunction + '; environmentSite().siteContext', editorContext), true);
project.site.features = []; editorContext.siteEditor.mapConfigured = true;
assert.equal(runInNewContext(siteFunction + '; environmentSite().siteContext', editorContext), true);
const viewerSource = readFileSync(new URL('../viewer.js', import.meta.url), 'utf8');
const createViewerEnvironment = viewerSource.split('\n').find(line => line.startsWith('environmentLayer=createEnvironmentLayer('));
for (const features of [[], [{ kind: 'building' }]]) {
  const context = { THREE, scene: new THREE.Scene(), renderer: { domElement: {} }, environmentConfig: { bounds }, model: { site_context: { features } }, renderProfile: {}, requestRender() {}, createEnvironmentLayer: (_three, options) => options };
  const options = runInNewContext(createViewerEnvironment + '; environmentLayer', context);
  assert.equal(options.siteContext, features.length > 0);
}
console.log('Environment: lazy batching, obstacle-free seeded traffic on both road sides over repeated 30-minute runs, fixed actor/buffer counts, individual speeds/arrival gaps/colors, settings and bounds rebuilds, visibility/reduced-motion/lifecycle pause and disposal passed.');
