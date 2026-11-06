#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createEnvironmentLayer } from '../planner/environment.js';
const THREE=await import('data:text/javascript;base64,'+readFileSync(new URL('../vendor/three.module.min.js',import.meta.url)).toString('base64'));
const scene=new THREE.Scene(),decorated=[],timers=new Map();let nextTimer=0;
const window={setTimeout(callback){const id=++nextTimer;timers.set(id,callback);return id;},clearTimeout(id){timers.delete(id);},addEventListener(){},removeEventListener(){}};
const layer=createEnvironmentLayer(THREE,{scene,bounds:{minX:0,maxX:8,minZ:0,maxZ:6},seed:42,settings:{enabled:true},window,decorateMaterial(material,family){
  assert.equal(material.userData.material_family,family);decorated.push(material);
}});
assert.equal(layer.stats.drawCalls,14);
assert.equal(decorated.length,14,'each differently shaded batch receives its own material');
const restingTriangles=layer.stats.triangles;
assert.equal(restingTriangles,64860,'the standard scene retains its original resting triangle count');
const families=new Set();let triangles=0,proxyTriangles=0,proxyBytes=0;
for(const mesh of scene.children[0].children){
  const geometry=mesh.geometry,positions=geometry.getAttribute('position'),uv=geometry.getAttribute('uv'),scale=geometry.getAttribute('materialUVScale');
  assert.equal(uv.count,positions.count);assert.equal(scale.count,mesh.count);
  assert([...uv.array,...scale.array].every(Number.isFinite));assert([...scale.array].every(value=>value>0));
  families.add(mesh.material.userData.material_family);
  triangles+=(geometry.index?geometry.index.count:positions.count)/3*mesh.count;
  if(mesh.name==='surroundings-tree-crown'){
    const range=geometry.userData.navigationRange,full=new THREE.Box3(),simple=new THREE.Box3(),point=new THREE.Vector3();
    proxyTriangles+=range.count/3;
    proxyBytes+=range.count*(3+3+2)*Float32Array.BYTES_PER_ELEMENT;
    for(let i=0;i<range.fullCount;i++)full.expandByPoint(point.fromBufferAttribute(positions,i));
    for(let i=range.start;i<range.start+range.count;i++)simple.expandByPoint(point.fromBufferAttribute(positions,i));
    assert(full.min.distanceTo(simple.min)<1e-6&&full.max.distanceTo(simple.max)<1e-6,'the canopy proxy retains the sampled outer envelope');
  }
  if(mesh.name==='surroundings-rabbit'){
    // Compare all decoded GPU attribute bytes to the independent Python author.
    const hash=createHash('sha256');
    for(const attribute of ['position','normal','uv','color'].map(name=>geometry.getAttribute(name)).concat(geometry.index)){
      hash.update(new Uint8Array(attribute.array.buffer,attribute.array.byteOffset,attribute.array.byteLength));
    }
    assert.equal(hash.digest('hex'),'9b3ff525eea61ea46b3f8de58d3f6eae1290af7b10b7333887810eb17c1ceff0');
    assert.equal(geometry.index.count/3,1488);
    assert.deepEqual(geometry.boundingBox.min.toArray().map(value=>value||0),[-.5,0,-.5]);
    assert.deepEqual(geometry.boundingBox.max.toArray(),[.5,1,.5]);
  }
}
assert.deepEqual([...families].sort(),['brushed_metal','car_paint','foliage','fur','glass','painted','rough_wood','rubber','stone']);
assert(triangles<80000,'decorative scene stays bounded even with smooth animal geometry');
assert.equal(triangles-restingTriangles,252,'six placed canopy proxies use 252 triangles');
assert.equal(proxyTriangles,84,'the two shared canopy buffers store only 84 extra triangles');
assert.equal(proxyBytes,8064,'proxy positions, normals and generated UVs add only 8064 bytes');
layer.noteNavigation();const navigationTriangles=layer.stats.triangles;
assert(navigationTriangles<restingTriangles/3,'navigation eliminates most fine leaf and branch triangles');
assert.equal(layer.stats.drawCalls,14);assert.equal(timers.size,1);
for(const mesh of scene.children[0].children.filter(mesh=>mesh.geometry.userData.navigationRange)){
  const range=mesh.geometry.userData.navigationRange;
  mesh.onBeforeShadow();assert.deepEqual(mesh.geometry.drawRange,{start:0,count:range.fullCount},'shadow maps retain complete foliage and branches');
  mesh.onAfterShadow();assert.deepEqual(mesh.geometry.drawRange,{start:range.start,count:range.count},'main-pass detail resumes after each shadow pass');
}
for(const callback of [...timers.values()]){timers.clear();callback();}
assert.equal(layer.stats.triangles,restingTriangles);assert.equal(layer.stats.detailTimerPending,false);
const counts=new Map(decorated.map(material=>[material,0]));
for(const material of decorated)material.addEventListener('dispose',()=>counts.set(material,counts.get(material)+1));
layer.dispose();assert([...counts.values()].every(count=>count===1));assert.equal(scene.children.length,0);
console.log(`Environment physical surfaces: ${families.size} families, 14 batches, ${restingTriangles} resting / ${navigationTriangles} navigation triangles, ${proxyTriangles} extra shared proxy triangles (${proxyBytes} bytes), matching canopy bounds, full-detail shadows, explicit UV/instance scales and disposal PASS.`);
