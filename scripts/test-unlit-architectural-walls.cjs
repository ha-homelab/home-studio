// Actual factory, geometry and native contract checks; no browser or GPU.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),viewer=fs.readFileSync(path.join(root,'viewer.js'),'utf8');
(async()=>{
  const THREE=await import('data:text/javascript;base64,'+fs.readFileSync(path.join(root,'vendor/three.module.min.js')).toString('base64'));
  const factory=viewer.split('\n').find(line=>line.startsWith('function createSceneMaterial('));
  const clip=viewer.split('\n').find(line=>line.startsWith('function applyStaticMeshClipping('));
  const capacity=await import('data:text/javascript;base64,'+fs.readFileSync(path.join(root,'planner/render-capacity.js')).toString('base64'));
  const appearance={color:0xb2d8d2,roughness:.8,metalness:0,emissive:0x315d59,emissiveIntensity:1,
    transparent:true,opacity:.16,depthWrite:false,side:THREE.DoubleSide,forceSinglePass:true};
  let selections=0;
  for(const renderer of ['Apple Software Renderer','Apple M5 Pro','ANGLE (Apple, Apple M5 Pro)','SwiftShader','llvmpipe','Microsoft Basic Render Driver','Unknown']) {
    const gl={getExtension:()=>({UNMASKED_RENDERER_WEBGL:1}),getParameter:()=>renderer};
    const profile=capacity.getRenderCapacity(gl,'Gecko/20100101');
    assert.equal(profile.diffuseLighting,renderer==='Apple Software Renderer');
    const context=vm.createContext({THREE,renderProfile:profile});vm.runInContext(factory,context);
    for(const kind of ['walls','floors','frames','windows','doors','stairs','vehicles',undefined]) {
      const material=context.createSceneMaterial(appearance,kind);
      const basic=profile.diffuseLighting&&kind==='walls';
      assert.equal(Boolean(material.isMeshBasicMaterial),basic,renderer+':'+kind);
      assert.equal(Boolean(material.isMeshLambertMaterial),profile.diffuseLighting&&!basic);
      assert.equal(Boolean(material.isMeshStandardMaterial),!profile.diffuseLighting);
      assert.equal(material.color.getHex(),appearance.color);
      for(const key of ['transparent','opacity','depthWrite','side','forceSinglePass'])assert.equal(material[key],appearance[key]);
      assert.equal(material.depthTest,true);assert.equal(material.toneMapped,true);
      if(!basic)assert.equal(material.emissive.getHex(),appearance.emissive);
      else assert.equal(material.emissive,undefined);
      material.dispose();selections++;
    }
  }
  function box(name,kind='walls',material='solid',x=0) {
    const vertices=[];for(const y of [0,2.8])for(const [a,z]of[[0,0],[4,0],[4,.2],[0,.2]])vertices.push([a+x,y,z]);
    return {name,kind,material,vertices,normals:vertices.map(()=>[0,1,0]),indices:[0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7]};
  }
  const model={materials:{solid:[.73,.65,.51,1],glass:[.5,.7,.8,.3]},openings:[],meshes:[
    box('rounded-wall'),{name:'plain-wall',kind:'walls',material:'solid',vertices:[[0,0,0],[1,0,0],[0,1,0]],normals:[[0,0,1],[0,0,1],[0,0,1]],indices:[0,1,2]},
    box('floor','floors'),box('frame','frames'),box('door','doors'),box('window','windows','glass')]};
  const original=JSON.stringify(model);
  const loop=viewer.slice(viewer.indexOf('// A wall_id shares'),viewer.indexOf('ground=new THREE.Mesh'));
  assert(loop.includes('createSceneMaterial(')&&loop.includes('createStaticGlassPasses('));
  function scene(diffuse){
    const context=vm.createContext({THREE,Float32Array,Uint16Array,Uint32Array,model,
      renderProfile:{diffuseLighting:diffuse},root:new THREE.Group(),clipping:new THREE.Plane(new THREE.Vector3(0,-1,0),2.1)});
    vm.runInContext(fs.readFileSync(path.join(root,'room-lighting.js'),'utf8'),context);
    vm.runInContext(viewer.slice(viewer.indexOf('function wallPrism('),viewer.indexOf('let wallOutlines,')),context);
    vm.runInContext(factory+'\n'+clip+'\n'+loop,context);
    return context;
  }
  const lit=scene(false),unlit=scene(true),values=geometry=>Object.fromEntries(['position','normal'].map(k=>[k,Array.from(geometry.getAttribute(k).array)]).concat([['index',Array.from(geometry.index.array)],['range',{...geometry.drawRange}]]));
  let geometryChecks=0;
  for(const height of [2.1,1.15,20,2.1]) {
    for(const context of [lit,unlit]){context.clipping.constant=height;context.updateRoundedWallGeometry(height);}
    for(const source of model.meshes) {
      const a=lit.root.children.find(m=>m.name===source.name),b=unlit.root.children.find(m=>m.name===source.name);
      assert.deepEqual(values(a.geometry),values(b.geometry),'Material selection cannot alter geometry: '+source.name);
      assert.equal(a.castShadow,b.castShadow);assert.equal(b.castShadow,source.material==='solid');
      assert.equal(a.receiveShadow,b.receiveShadow);assert.equal(b.receiveShadow,true);
      if(source.kind==='walls') {
      for(const key of ['side','shadowSide','transparent','opacity','depthWrite','depthTest','forceSinglePass','alphaTest','blending','polygonOffset'])assert.equal(a.material[key],b.material[key],source.name+': '+key);
        assert(b.material.isMeshBasicMaterial);assert(a.material.isMeshStandardMaterial);
        assert.equal(b.material.opacity,.16);assert.equal(b.material.depthWrite,false);
        assert.equal(b.material.clippingPlanes[0],unlit.clipping);assert.equal(b.material.clipShadows,false);
        assert.equal(b.material.onBeforeCompile,THREE.Material.prototype.onBeforeCompile,'Do not run Lambert sheen against Basic normals');
        assert.equal(a.material.onBeforeCompile,lit.applyWallSheen);
        if(source.name==='rounded-wall') {
          b.onBeforeShadow(null,null,null,null,b.geometry);assert.equal(b.geometry.drawRange.start,0);assert.equal(b.geometry.drawRange.count,36);
          assert.deepEqual(Array.from(b.geometry.index.array.slice(0,36)),source.indices);
          b.onAfterShadow(null,null,null,null,b.geometry);assert.deepEqual(values(a.geometry),values(b.geometry));
        }
      } else assert(b.material.isMeshLambertMaterial);
      geometryChecks++;
    }
  }
  assert.equal(JSON.stringify(model),original,'Compiler/export input stays untouched');
  const wall=unlit.root.children[0],originalMaterial=wall.material,originalGeometry=wall.geometry;
  const rooms=[{id:'A',polygon:[[-1,-1],[6,-1],[6,4],[-1,4]]}];
  for(const lightCount of [18,72]) {
    const lights=Array.from({length:lightCount},()=>{const light=new THREE.PointLight(0xffffff,0);light.visible=true;return {light,item:{room:'A'}};});
    const controller=unlit.createRoomLighting(THREE,rooms,lightCount,[],{packed:true,pointTexture:true,maxFragmentUniforms:1024,maxTextureSize:4096,maxTextures:16});
    for(const enabled of [true,false,true])for(const intensity of [0,1]) {
      lights.forEach(p=>{p.light.intensity=intensity;});controller.attach(unlit.root,enabled,{staticGeometry:true});controller.update(lights,new THREE.PerspectiveCamera());
      assert.equal(wall.material,originalMaterial);assert.equal(wall.geometry,originalGeometry);
      assert.equal(wall.material.onBeforeCompile,THREE.Material.prototype.onBeforeCompile);
      assert.equal(lights.filter(p=>p.light.visible).length,lightCount);
      assert(lights.every(p=>p.light.intensity===intensity));
    }
    controller.releaseGPU();controller.dispose();
    assert.equal(wall.material,originalMaterial);assert.equal(wall.material.onBeforeCompile,THREE.Material.prototype.onBeforeCompile);
  }
  const basic={uniforms:THREE.UniformsUtils.clone(THREE.ShaderLib.basic.uniforms),vertexShader:THREE.ShaderLib.basic.vertexShader,fragmentShader:THREE.ShaderLib.basic.fragmentShader};
  wall.material.onBeforeCompile(basic,{});
  assert.equal(basic.vertexShader,THREE.ShaderLib.basic.vertexShader);assert.equal(basic.fragmentShader,THREE.ShaderLib.basic.fragmentShader);
  assert(!basic.fragmentShader.includes('homePoint'));assert(!basic.vertexShader.includes('wallSheen'));
  // Exercise the unchanged native profile assertion with actual material types.
  const types=[...new Set(unlit.root.children.map(m=>m.material.type))].sort();
  const contract=spawnSync('python3',['-c',`
import importlib.util,json,sys
sys.path.insert(0,'scripts')
s=importlib.util.spec_from_file_location('acceptance','scripts/test-waterfox-acceptance.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
types=json.load(sys.stdin)
scene={'materialTypes':types,'rasterProbe':{'status':'measured','samplesMs':[16,17,18],'bestMs':16,'totalMs':60,'pixels':[[i+1,20,30,255] for i in range(5)]},'drawingBuffer':[632,394],'shadowType':0,'shadowMaps':[['DirectionalLight',512,512],['PointLight',128,128],['PointLight',128,128]],'pointLights':72}
r={'preferences':{'webgl.sanitize-unmasked-renderer':True},'userAgent':'Gecko/20100101','suite':'viewer-24','samples':[{'initial':{'gpu':{'unmaskedRenderer':'Apple M1, or similar','textureUnits':16,'maxTextureSize':4096},'scene':scene}}]}
m.assert_masked_capacity(r)
for key,value in [('materialTypes',['MeshBasicMaterial']),('shadowType',2),('drawingBuffer',[2000,2000]),('shadowMaps',[['DirectionalLight',512,512]])]:
 old=scene[key];scene[key]=value
 try:m.assert_masked_capacity(r)
 except AssertionError:pass
 else:raise AssertionError('Original native contract accepted '+key)
 scene[key]=old
print('native profile contract and four negative controls passed')
`],{cwd:root,input:JSON.stringify(types),encoding:'utf8'});
  assert.equal(contract.status,0,contract.stderr);assert(contract.stdout.includes('four negative'));
  for(const context of [lit,unlit]){context.root.traverse(m=>{m.geometry?.dispose();m.material?.dispose();});context.releaseStaticGlassPasses();}
  console.log(`Unlit walls: ${selections} profile/category selections, ${geometryChecks} geometry/cutaway comparisons, 18/72-light transitions and native negative contracts passed.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
