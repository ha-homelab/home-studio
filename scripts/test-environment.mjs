import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEnvironmentLayer } from '../planner/environment.js';
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
layer.setSettings({ motion: false }); assert.equal(timers.size, 0); const stoppedRenders = renders; advance(); assert.equal(renders, stoppedRenders);
layer.dispose(); assert.equal(scene.children.length, 0); assert.equal(intersection,null); assert.equal(timers.size, 0);
assert([...doc.listeners.values(), ...win.listeners.values(), ...media.listeners.values()].every(set => set.size === 0));

function simulateTraffic(seed, site = bounds, useMetadata = false) {
  const target = new THREE.Scene();
  const options = { scene: target, bounds: site, frameInterval: 2000, document: doc, window: win, settings: { enabled: true, motion: true } };
  if (useMetadata) options.settings.seed = seed; else options.seed = seed;
  const trafficLayer = createEnvironmentLayer(THREE, options);
  assert.equal(trafficLayer.stats.trafficSeed, seed);
  const meshes = [...target.children[0].children];
  const resources = meshes.map(mesh => [mesh.geometry, mesh.material, mesh.instanceMatrix, mesh.instanceMatrix.array, mesh.instanceColor, mesh.instanceColor?.array]);
  const bodies = meshes.filter(mesh => mesh.instanceColor);
  assert.equal(bodies.length, 1, 'Both car bodies share one color-enabled batch');
  assert.equal(bodies[0].count, 2, 'Traffic always consists of exactly two car instances');
  const positions = new Float64Array(2), previousColors = new Float32Array(6), matrix = new THREE.Matrix4();
  const changes = [[], []], seenColors = [new Set(), new Set()], waiting = [0, 0];
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
assert([...doc.listeners.values(), ...win.listeners.values(), ...media.listeners.values()].every(set => set.size === 0));
console.log('Environment: lazy batching, obstacle-free seeded traffic over repeated 30-minute runs, fixed actor/buffer counts, individual speeds/arrival gaps/colors, visibility/reduced-motion/lifecycle pause and disposal passed.');
