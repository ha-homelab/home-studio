// Exercise the real factory with pinned Three; synthetic finish names only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'viewer.js'),'utf8');
(async()=>{
  const THREE=await import('data:text/javascript;base64,'+fs.readFileSync(path.join(root,'vendor/three.module.min.js')).toString('base64'));
  const factory=source.split('\n').find(line=>line.startsWith('function createSceneMaterial('));
  const python=spawnSync(process.env.PYTHON||'python3',['-c','import json; from material_textures import MATERIAL_FINISH_RULES; print(json.dumps(MATERIAL_FINISH_RULES))'],{cwd:root,encoding:'utf8'});
  assert.equal(python.status,0,python.stderr);
  const jsRules=JSON.parse(factory.split('const rules=')[1].split(';const name=')[0]);
  assert.deepEqual(jsRules,JSON.parse(python.stdout),'every ordered Python/GLB and JS/HA rule must match');
  for(const diffuseLighting of [false,true]){
    const context=vm.createContext({THREE,renderProfile:{diffuseLighting}});vm.runInContext(factory,context);
    const appearance={color:0x778899,roughness:.8,metalness:0,opacity:.4,transparent:true,depthWrite:false,side:THREE.DoubleSide};
    for(const [name,roughness,metalness] of [['brushed_steel',.4,.75],['chrome',.3,.9],['matte_chrome',.5,.9],['matte_steel',.5,.75],['brushed_chrome',.4,.9],['steel',.3,.75],['painted_steel',.48,0],['plastic_black',.48,0],['upholstery_taupe',.92,0],['upholstery_leather',.5,0],['rubber',.95,0],['ceramic',.24,0],['glass',.12,0],['wood_walnut',.58,0],['unknown',.7,0]]){
      const material=context.createSceneMaterial(appearance,undefined,name);
      assert.equal(material.type,diffuseLighting?'MeshLambertMaterial':'MeshStandardMaterial');
      if(!diffuseLighting){assert.equal(material.roughness,roughness,name);assert.equal(material.metalness,metalness,name)}
      for(const key of ['opacity','transparent','depthWrite','side'])assert.equal(material[key],appearance[key]);
      assert.equal(material.color.getHex(),appearance.color);material.dispose();
    }
    const wall=context.createSceneMaterial({...appearance,emissive:0x123456},'walls','plaster');
    assert.equal(wall.type,diffuseLighting?'MeshBasicMaterial':'MeshStandardMaterial');wall.dispose();
    assert.equal(appearance.roughness,.8,'factory never mutates caller options');
  }
  console.log('Material finish profiles, painted metal precedence, transparency and Lambert/wall fallback passed.');
})().catch(error=>{console.error(error);process.exitCode=1});
