#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createEnvironmentLayer } from '../planner/environment.js';
const THREE=await import('data:text/javascript;base64,'+readFileSync(new URL('../vendor/three.module.min.js',import.meta.url)).toString('base64'));
const scene=new THREE.Scene(),decorated=[];
const layer=createEnvironmentLayer(THREE,{scene,bounds:{minX:0,maxX:8,minZ:0,maxZ:6},seed:42,settings:{enabled:true},decorateMaterial(material,family){
  assert.equal(material.userData.material_family,family);decorated.push(material);
}});
assert.equal(layer.stats.drawCalls,14);
assert.equal(decorated.length,14,'each differently shaded batch receives its own material');
const families=new Set();let triangles=0;
for(const mesh of scene.children[0].children){
  const geometry=mesh.geometry,positions=geometry.getAttribute('position'),uv=geometry.getAttribute('uv'),scale=geometry.getAttribute('materialUVScale');
  assert.equal(uv.count,positions.count);assert.equal(scale.count,mesh.count);
  assert([...uv.array,...scale.array].every(Number.isFinite));assert([...scale.array].every(value=>value>0));
  families.add(mesh.material.userData.material_family);
  triangles+=(geometry.index?geometry.index.count:positions.count)/3*mesh.count;
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
const counts=new Map(decorated.map(material=>[material,0]));
for(const material of decorated)material.addEventListener('dispose',()=>counts.set(material,counts.get(material)+1));
layer.dispose();assert([...counts.values()].every(count=>count===1));assert.equal(scene.children.length,0);
console.log(`Environment physical surfaces: ${families.size} families, 14 batches, ${triangles} placed triangles, explicit UV/instance scales and disposal PASS.`);
