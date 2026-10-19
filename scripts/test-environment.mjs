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
function checkSiteClear() {
  scene.updateMatrixWorld(true);
  const matrix = new THREE.Matrix4();
  for (const mesh of scene.children[0].children) {
    mesh.geometry.computeBoundingBox();
    for (let index = 0; index < mesh.count; index++) {
      mesh.getMatrixAt(index, matrix); matrix.premultiply(mesh.matrixWorld);
      const box = mesh.geometry.boundingBox.clone().applyMatrix4(matrix);
      assert(box.max.x < bounds.minX || box.min.x > bounds.maxX || box.max.z < bounds.minZ || box.min.z > bounds.maxZ,
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
console.log('Environment: lazy static batching, 108-second obstacle-free motion, visibility/reduced motion/lifecycle pause, palette rebuild and disposal passed.');
