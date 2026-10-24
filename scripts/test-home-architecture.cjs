// Authored Home colors are a reversible display choice, never an edit to the model.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),viewer=fs.readFileSync(path.join(root,'viewer.js'),'utf8');
(async()=>{
  const THREE=await import('data:text/javascript;base64,'+fs.readFileSync(path.join(root,'vendor/three.module.min.js')).toString('base64'));
  const context=vm.createContext({});
  vm.runInContext(viewer.slice(viewer.indexOf('function createHomeArchitectureMaterials('),viewer.indexOf('// The software Editor')),context);
  vm.runInContext(fs.readFileSync(path.join(root,'room-lighting.js'),'utf8'),context);
  const model={materials:{paint:[.7,.25,.15,1],frame:[.25,.3,.2,1]},meshes:[
    {name:'wall',kind:'walls',material:'paint'},{name:'frame',kind:'frames',material:'frame'},
    {name:'mapped-wall',kind:'walls',material:'paint'},{name:'object',kind:'inventory',material:'paint'}]};
  const group=new THREE.Group(),source=JSON.stringify(model),initial=[];
  for(const m of model.meshes){
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshStandardMaterial({color:0xb2d8d2,emissive:0x315d59,emissiveIntensity:.4,transparent:true,opacity:.16,depthWrite:false}));
    mesh.name=m.name;mesh.userData.category=m.kind;if(m.name==='mapped-wall')mesh.material.map=new THREE.Texture();group.add(mesh);
    initial.push({material:mesh.material,color:mesh.material.color.clone(),emissive:mesh.material.emissive.clone(),callback:mesh.material.onBeforeCompile,map:mesh.material.map});
  }
  const owner=context.createHomeArchitectureMaterials(THREE,group,model);
  for(const active of [true,false,true,false]){
    owner.setHomeActive(active);
    group.children.forEach((mesh,i)=>{
      const original=initial[i],mat=mesh.material;
      assert.equal(mat,original.material);assert.equal(mat.map,original.map);assert.equal(mat.onBeforeCompile,original.callback);
      assert.equal(mat.opacity,.16);assert.equal(mat.depthWrite,false);assert.equal(mat.emissiveIntensity,.4);
      const expected=active&&i<3?(mat.map?new THREE.Color(1,1,1):new THREE.Color(...model.materials[model.meshes[i].material].slice(0,3))):original.color;
      assert(mat.color.equals(expected));assert(mat.emissive.equals(active&&i<3?new THREE.Color(0,0,0):original.emissive));
    });
  }
  assert.equal(JSON.stringify(model),source);
  // Opt-in native Home neutral mode suppresses only ornamental wall sheen.
  const lighting=context.createRoomLighting(THREE,[],1,[],{neutralArchitecture:true});
  for(const enabled of [true,false,true]){
    lighting.attach(group,enabled,{staticGeometry:true});
    const shader={uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader};
    group.children[0].material.onBeforeCompile(shader);
    assert.equal(shader.fragmentShader.includes('totalEmissiveRadiance += wallSheen'),!enabled);
    assert.equal(shader.vertexShader.includes('homeWorldPosition ='),enabled);
    assert(shader.fragmentShader.includes('#include <clipping_planes_fragment>'));
  }
  const homeSource=fs.readFileSync(path.join(root,'home-view.js'),'utf8');
  const updateDaylight=homeSource.slice(homeSource.indexOf('  function updateDaylight()'),homeSource.indexOf('  function updateFixtureShadows()'));
  const levels=vm.createContext({active:true,haConnected:true,haStates:{},daylightWindows:[],bindings:[],hemisphere:{intensity:0},sun:{intensity:0},roomLighting:{environment(day){levels.daylight=day;}}});
  vm.runInContext(updateDaylight,levels);
  for(const [state,day] of [[undefined,0],[{state:'below_horizon',sun:{elevation:-10}},0],[{state:'above_horizon',sun:{elevation:45}},1],[{state:'above_horizon',sun:{elevation:NaN}},1]]) {
    levels.haStates={'sun.sun':state};levels.updateDaylight();assert.equal(levels.daylight,day);
    assert(Math.abs(levels.hemisphere.intensity-(.16+.24*day))<1e-12);assert(Math.abs(levels.sun.intensity-(.18+.72*day))<1e-12);
  }
  levels.haConnected=false;levels.updateDaylight();assert.equal(levels.daylight,0);
  levels.active=false;levels.hemisphere.intensity=1.8;levels.sun.intensity=2.3;levels.updateDaylight();
  assert.equal(levels.hemisphere.intensity,1.8);assert.equal(levels.sun.intensity,2.3);
  lighting.dispose();group.children.forEach(m=>{m.geometry.dispose();m.material.map?.dispose();m.material.dispose()});
  console.log('Home architecture: authored color, map/alpha/callback identity, Editor restoration and neutral shader passed.');
})().catch(error=>{console.error(error);process.exitCode=1});
