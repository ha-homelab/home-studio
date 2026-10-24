// Exercise the real factory with pinned Three; synthetic finish names only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'viewer.js'),'utf8'),materialSource=fs.readFileSync(path.join(root,'material-textures.js'),'utf8').replaceAll('export ','');
(async()=>{
  const THREE=await import('data:text/javascript;base64,'+fs.readFileSync(path.join(root,'vendor/three.module.min.js')).toString('base64'));
  const factory=source.split('\n').find(line=>line.startsWith('function createSceneMaterial('));
  const python=spawnSync(process.env.PYTHON||'python3',['-c','import json; from material_textures import MATERIAL_FINISH_RULES, MATERIAL_SURFACE_PROFILES; print(json.dumps([MATERIAL_FINISH_RULES, MATERIAL_SURFACE_PROFILES]))'],{cwd:root,encoding:'utf8'});
  assert.equal(python.status,0,python.stderr);
  const jsRules=JSON.parse(factory.split('const rules=')[1].split(';const name=')[0]);
  const [pythonRules,pythonProfiles]=JSON.parse(python.stdout);
  assert.deepEqual(jsRules,pythonRules,'every ordered Python/GLB and JS/HA rule must match');
  for(const diffuseLighting of [false,true]){
    const context=vm.createContext({THREE,renderProfile:{diffuseLighting}});vm.runInContext(materialSource+'\n'+factory,context);
    const actualProfiles=vm.runInContext('JSON.stringify(MATERIAL_SURFACE_PROFILES)',context);
    assert.deepEqual(JSON.parse(actualProfiles),pythonProfiles,'explicit profile tables must match');
    const appearance={color:0x778899,roughness:.8,metalness:0,opacity:.4,transparent:true,depthWrite:false,side:THREE.DoubleSide};
    for(const [name,roughness,metalness] of [['brushed_steel',.4,.75],['chrome',.3,.9],['matte_chrome',.5,.9],['matte_steel',.5,.75],['brushed_chrome',.4,.9],['steel',.3,.75],['painted_steel',.48,0],['plastic_black',.48,0],['upholstery_taupe',.92,0],['upholstery_leather',.5,0],['rubber',.95,0],['ceramic',.24,0],['glass',.12,0],['wood_walnut',.58,0],['unknown',.7,0]]){
      const material=context.createSceneMaterial(appearance,undefined,name);
      assert.equal(material.type,diffuseLighting?'MeshLambertMaterial':'MeshStandardMaterial');
      if(!diffuseLighting){assert.equal(material.roughness,roughness,name);assert.equal(material.metalness,metalness,name)}
      for(const key of ['opacity','transparent','depthWrite','side'])assert.equal(material[key],appearance[key]);
      assert.equal(material.color.getHex(),appearance.color);material.dispose();
    }
    for(const [finish,[roughness,metalness]] of Object.entries(pythonProfiles)) {
      const material=context.createSceneMaterial({...appearance,emissive:0x123456,emissiveIntensity:.3},undefined,'upholstery_black',finish);
      if(!diffuseLighting){assert.equal(material.roughness,roughness,finish);assert.equal(material.metalness,metalness,finish)}
      assert.equal(material.emissive.getHex(),0x123456);assert.equal(material.emissiveIntensity,.3);material.dispose();
    }
    for(const bad of [null,'unknown','FABRIC',{},'x'.repeat(65)])assert.throws(()=>context.createSceneMaterial(appearance,undefined,'wood',bad),/surface finish/);
    const part={material:'upholstery_black',vertices:[[0,0,0],[1,0,0],[0,1,0]],normals:[[0,0,1],[0,0,1],[0,0,1]],indices:[0,1,2]};
    const batches=context.inventoryMaterialBatches({meshes:[{...part,surface_finish:'fabric'},{...part,surface_finish:'plastic'}]}, {}, {upholstery_black:[0,0,0,1]}, {get:()=>null});
    assert.equal(batches.length,2,'equal palette IDs must not merge distinct per-part finishes');
    assert.deepEqual(Array.from(batches,b=>b.surfaceFinish),['fabric','plastic']);
    const wall=context.createSceneMaterial({...appearance,emissive:0x123456},'walls','plaster');
    assert.equal(wall.type,diffuseLighting?'MeshBasicMaterial':'MeshStandardMaterial');wall.dispose();
    assert.equal(appearance.roughness,.8,'factory never mutates caller options');
  }
  console.log('Material finish tables, per-part overrides/batching, emissive preservation, transparency and Lambert/wall fallback passed.');
})().catch(error=>{console.error(error);process.exitCode=1});
