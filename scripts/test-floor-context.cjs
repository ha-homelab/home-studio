const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');
const root=path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'viewer.js'),'utf8');
const code=source.slice(source.indexOf('let lowerFloorContext;'),source.indexOf('function updateWallOutlines'));
const three=import('data:text/javascript;base64,'+fs.readFileSync(path.join(root,'vendor/three.module.min.js')).toString('base64'));
test('context is opt-in, two static batches, hidden initially and independent of active geometry',async()=>{
  const THREE=await three;
  const scene=new THREE.Scene(),model={};
  const ctx=vm.createContext({THREE,scene,model});
  vm.runInContext(code+';buildLowerFloorContext()',ctx);
  assert.equal(scene.children.length,0);
  model.lower_floor_context={lines:[0,-3,0,1,-3,0],surfaces:[0,-3,0,1,-3,0,0,-3,1]};
  vm.runInContext('buildLowerFloorContext()',ctx);
  const group=scene.children[0];
  assert.equal(group.visible,false);
  assert.equal(group.children.length,2);
  for(const object of group.children){
    assert.equal(object.castShadow,false);
    assert.equal(object.receiveShadow,false);
    assert.equal(object.material.depthWrite,false);
    assert.equal(object.material.toneMapped,false);
    assert.ok(object.material.opacity<=.3);
    assert.equal(object.material.clippingPlanes,null);
    object.geometry.dispose();object.material.dispose();
  }
  assert.equal(group.parent,scene);
});
