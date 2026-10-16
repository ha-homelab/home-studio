// CPU proof for exact Three records, program selection and texture lifecycle.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
(async()=>{
  const vendor=fs.readFileSync(path.join(root,'vendor/three.module.min.js'),'utf8');
  for(const token of ['function Ol(t){const e=new Ul,','class il{constructor(t,e)','function bl(t,e,n,i){','function Al(t,e,n,i,r,s,a){'])assert(vendor.includes(token));
  const THREE=await import('data:text/javascript;base64,'+Buffer.from(vendor+'\nexport {Ol as OracleLights,il as OracleUniforms,bl as TestProgram,Al as TestPrograms};').toString('base64'));
  const source=fs.readFileSync(path.join(root,'room-lighting.js'),'utf8');
  const context=vm.createContext({Float32Array,Int32Array});vm.runInContext(source,context);
  const rooms=Array.from({length:24},(_,i)=>({id:'r'+i,polygon:[[i*4,0],[i*4+4,0],[i*4+4,4],[i*4,4]]}));
  const options={packed:true,pointTexture:true,maxFragmentUniforms:2048,maxTextureSize:4096,maxTextures:16};
  const make=(capacity=72,opts={})=>context.createRoomLighting(THREE,rooms,capacity,[],{...options,...opts});
  const box=()=>new THREE.Mesh(new THREE.BoxGeometry(.5,.5,.5),new THREE.MeshLambertMaterial());
  function shader(mesh){const name=mesh.material.isMeshStandardMaterial?'standard':'lambert',s={uniforms:THREE.UniformsUtils.clone(THREE.ShaderLib[name].uniforms),vertexShader:THREE.ShaderLib[name].vertexShader,fragmentShader:THREE.ShaderLib[name].fragmentShader};mesh.material.onBeforeCompile(s);return s;}
  const textured=s=>s.fragmentShader.includes('uniform highp sampler2D homePointTexture;');
  const camera=new THREE.PerspectiveCamera(),cameraParent=new THREE.Group(),lightParent=new THREE.Group();cameraParent.add(camera);
  const points=Array.from({length:72},(_,i)=>{const light=new THREE.PointLight(new THREE.Color(.11+i*.002,.3,.7-i*.003),i%5?i/20:0,3+i*.1,1+i*.02);light.position.set(i*.03,i*.02,-i*.01);lightParent.add(light);return {light,item:{room:'r'+Math.floor(i/3)}};});
  function oracle(input=points){cameraParent.updateMatrixWorld(true);lightParent.updateMatrixWorld(true);const lights=input.filter(p=>p.light.visible).map(p=>p.light),state=new THREE.OracleLights({get(){throw Error('Unexpected extension');}});state.setup(lights);state.setupView(lights,camera);return state.state.point;}
  const lighting=make(),group=new THREE.Group(),mesh=box(),owned=box();
  mesh.userData.category='floors';mesh.material.side=THREE.DoubleSide;mesh.material.clippingPlanes=[new THREE.Plane(new THREE.Vector3(0,-1,0),40)];
  context.registerFallbackBoxProgram(THREE,owned,true);group.add(mesh,owned);lighting.attach(group,true,{staticGeometry:true});
  assert(!textured(shader(mesh)),'Before input proof, first compile uses the original program');
  const baseline=make(72,{pointTexture:false}),oldMesh=box();oldMesh.userData.category='floors';oldMesh.material.side=THREE.DoubleSide;oldMesh.material.clippingPlanes=[new THREE.Plane(new THREE.Vector3(0,-1,0),40)];baseline.attach(oldMesh,true,{staticGeometry:true});const old=shader(oldMesh);
  let lastTexture,checks=0;
  function checkRecords(s,input=points){
    const records=oracle(input);s.uniforms.pointLights.value=records;
    const texture=s.uniforms.homePointTexture.value;
    assert.equal(texture.type,THREE.FloatType);assert.equal(texture.internalFormat,'RGBA32F');assert.equal(texture.minFilter,THREE.NearestFilter);assert.equal(texture.magFilter,THREE.NearestFilter);assert.equal(texture.colorSpace,THREE.NoColorSpace);assert.equal(texture.generateMipmaps,false);assert.equal(texture.flipY,false);
    const expected=records.flatMap(r=>[...r.position.toArray(),r.distance,...r.color.toArray(),r.decay]).map(Math.fround);
    assert.deepEqual(Array.from(texture.image.data.slice(0,expected.length)),expected);
    assert(Array.from(texture.image.data.slice(expected.length)).every(x=>x===0));
    const version=texture.version;assert.equal(s.uniforms.homePointTexture.value,texture);assert.equal(texture.version,version,'Unchanged records do not upload again');checks+=expected.length;lastTexture=texture;return texture;
  }
  for(const shadows of [0,1,2,8])for(const view of [0,1,2])for(const hidden of [false,true]){
    points.forEach((p,i)=>{p.light.castShadow=i<shadows;p.light.visible=!(hidden&&i%7===1);});
    cameraParent.position.set(view,-view,2*view);cameraParent.rotation.set(.2*view,.3*view,-.1*view);camera.position.set(2+view,5,9);camera.lookAt(1,0,0);
    lightParent.position.set(1+view,-view,.3);lightParent.scale.set(-1.2,.7,1.3);lightParent.rotation.set(.2,.1*view,-.3);
    lighting.update(points,camera);const s=shader(mesh);assert(textured(s));checkRecords(s);
    const normalized=s.fragmentShader.replace('uniform highp sampler2D homePointTexture;\n','')
      .replace(THREE.ShaderChunk.lights_pars_begin.replace('uniform PointLight pointLights[ NUM_POINT_LIGHTS ];','#if NUM_POINT_LIGHT_SHADOWS > 0\n\tuniform PointLight pointLights[ NUM_POINT_LIGHT_SHADOWS ];\n\t#endif'),'#include <lights_pars_begin>')
      .replace(/\n            vec4 homePositionDistance=texelFetch[\s\S]*?pointLight.decay=homeColorDecay.w;/,'pointLight = pointLights[ i ];');
    assert.equal(normalized,old.fragmentShader,'Only source of the ordered unshadowed light record and declaration change');
    assert.equal(s.vertexShader,old.vertexShader);assert.equal(s.fragmentShader,shader(owned).fragmentShader,'Owned fallback retains shared structural program');
  }
  // The initial offline zero state is eligible before its first draw. Light
  // toggles and daylight retain the same program and the full record inventory.
  const savedIntensities=points.map(p=>p.light.intensity);
  for(const mode of ['off','partial','on']){
    points.forEach((p,i)=>{p.light.visible=true;p.light.castShadow=i<2;p.light.intensity=mode==='off'?0:mode==='partial'&&i%2?0:savedIntensities[i];});
    lighting.update(points,camera);const s=shader(mesh);assert(textured(s));checkRecords(s);
    const key=mesh.material.customProgramCacheKey(),version=lastTexture.version;
    lighting.environment(mode==='on'?1:0,[]);assert.equal(mesh.material.customProgramCacheKey(),key);checkRecords(s);assert.equal(lastTexture.version,version);
  }
  // Exact pinned shader expansion: all remaining pointLights accesses are literal shadow indices.
  const submitted=[],gl={VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,createProgram:()=>({}),createShader:type=>({type}),shaderSource(s,text){submitted.push({type:s.type,text});},compileShader(){},attachShader(){},linkProgram(){},bindAttribLocation(){}};
  const renderer={getContext:()=>gl,getRenderTarget:()=>null,outputColorSpace:THREE.SRGBColorSpace,toneMapping:THREE.ACESFilmicToneMapping,shadowMap:{enabled:true,type:THREE.BasicShadowMap},debug:{checkShaderErrors:false}};
  const bindings={releaseStatesOfProgram(){}},caps={precision:'highp',getMaxPrecision:x=>x,vertexTextures:true,logarithmicDepthBuffer:false,reverseDepthBuffer:false};
  const programs=new THREE.TestPrograms(renderer,{get:()=>null},{get:()=>null},{has:()=>false},caps,bindings,{numPlanes:1,numIntersection:0});
  for(const capacity of [18,72])for(const shadows of [0,1,2,8])for(const enabled of [false,true]){
    const controller=make(capacity),m=box(),input=points.slice(0,capacity);controller.attach(m,true);input.forEach((p,i)=>{p.light.visible=true;p.light.castShadow=i<shadows;});controller.update(input,camera);const s=shader(m);assert(textured(s));checkRecords(s,input);
    renderer.shadowMap.enabled=enabled;
    const lights={directional:[{}],point:Array(capacity).fill({}),spot:[],spotLightMap:[],rectArea:[],hemi:[{}],directionalShadowMap:[{}],pointShadowMap:Array(shadows).fill({}),spotShadowMap:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};
    const params=programs.getParameters(m.material,lights,[{}],new THREE.Scene(),m);params.vertexShader=s.vertexShader;params.fragmentShader=s.fragmentShader;submitted.length=0;new THREE.TestProgram(renderer,programs.getProgramCacheKey(params),params,bindings);
    const fragment=submitted.find(s=>s.type===35632).text;
    assert(fragment.includes(`uniform PointLight pointLights[ ${shadows} ];`));assert(fragment.includes('#if '+shadows+' > 0'));
    assert(!fragment.includes(`uniform PointLight pointLights[ ${capacity} ];`));
    assert.deepEqual([...fragment.matchAll(/pointLight = pointLights\[\s*(\d+)\s*\]/g)].map(m=>Number(m[1])),Array.from({length:shadows},(_,i)=>i));
    assert(!/pointLights\[\s*i/.test(fragment));assert(fragment.includes('texelFetch(homePointTexture,ivec2(i*2,0),0)'));controller.dispose();
  }
  points.forEach((p,i)=>{p.light.visible=true;p.light.castShadow=i<2;});lighting.update(points,camera);
  let current=shader(mesh);checkRecords(current);
  // The pinned uniform uploader binds a complete Float32 texture and just the original shadow prefix.
  const active=[{name:'homePointTexture',size:1,type:35678}],writes=[],bound=[];
  for(let i=0;i<2;i++)for(const [field,type]of [['position',35665],['color',35665],['distance',5126],['decay',5126]])active.push({name:`pointLights[${i}].${field}`,size:1,type});
  const uploadGL={ACTIVE_UNIFORMS:35718,getProgramParameter:()=>active.length,getActiveUniform:(_,i)=>active[i],getUniformLocation:(_,n)=>n,uniform1i:(...v)=>writes.push(v),uniform1f:(...v)=>writes.push(v),uniform3f:(...v)=>writes.push(v)};
  const uploader=new THREE.OracleUniforms(uploadGL,{});THREE.OracleUniforms.upload(uploadGL,uploader.seq,current.uniforms,{allocateTextureUnit:()=>0,setTexture2D:(...v)=>bound.push(v)});assert.equal(bound[0][0],lastTexture);assert.equal(writes.filter(w=>w[0].startsWith('pointLights')).length,8);
  // Unsupported records switch programs before compile and safely recover.
  for(const [target,key,value]of [[points[0].light,'intensity',NaN],[points[0].light,'distance',1e50],[points[0].light,'decay',Infinity],[points[0].light.color,'r',1e50],[points[0].light,'map',{}],[lightParent.position,'x',Infinity],[points[0].item,'room','unknown']]){
    const previous=target[key];target[key]=value;const version=mesh.material.version;lighting.update(points,camera);assert(mesh.material.version>version);assert(!textured(shader(mesh)));target[key]=previous;lighting.update(points,camera);assert(textured(shader(mesh)));
  }
  points[0].light.layers.set(2);lighting.update(points,camera);assert(!textured(shader(mesh)));points[0].light.layers.set(0);
  lightParent.visible=false;lighting.update(points,camera);assert(!textured(shader(mesh)));lightParent.visible=true;
  lighting.update([...points,{light:new THREE.PointLight(),item:{room:'r0'}}],camera);assert(!textured(shader(mesh)));
  lighting.update(points);assert(!textured(shader(mesh)));lighting.update(points,camera);assert(textured(shader(mesh)));
  // Latest full/editor uniform maps can serve a cached texture program; no stale records.
  lighting.update(points);let latest=shader(mesh);lighting.update(points,camera);checkRecords(latest);
  lighting.attach(group,false,{staticGeometry:true});latest=shader(mesh);assert(!textured(latest));lighting.attach(group,true,{staticGeometry:true});lighting.update(points,camera);checkRecords(latest);
  current=shader(mesh);checkRecords(current);const before=current.uniforms.pointLights.value;
  points[0].light.intensity=3.14;cameraParent.position.x+=2;lighting.update(points,camera);checkRecords(current);assert.notEqual(current.uniforms.pointLights.value,before);
  for(const opts of [{maxTextureSize:143},{maxTextures:15},{maxTextureSize:NaN},{maxTextures:undefined}]){const c=make(72,opts),m=box();c.attach(m,true);c.update(points,camera);assert(!textured(shader(m)));c.dispose();}
  const packed=context.packRoomLightingGeometry(rooms,[],72,2048),tight=make(72,{maxFragmentUniforms:packed.uniformVectors}),m=box();tight.attach(m,true);tight.update(points,camera);assert.equal(tight.geometryMode,'packed');assert(!textured(shader(m)));tight.dispose();
  for(const configure of [m=>m.material=new THREE.MeshStandardMaterial(),m=>m.material.map=new THREE.Texture(),m=>m.onBeforeRender=()=>{}]){const c=make(),m=box();configure(m);c.attach(m,true);c.update(points,camera);assert(!textured(shader(m)));c.dispose();}
  // Detached objects cannot retain an active texture program in a live controller.
  const detachedController=make(),detachedGroup=new THREE.Group(),detached=box();detachedGroup.add(detached);detachedController.attach(detachedGroup,true);detachedController.update(points,camera);assert(textured(shader(detached)));detachedGroup.remove(detached);detachedController.update(points,camera);assert(!textured(shader(detached)));detachedController.dispose();
  // A custom callback on any object sharing a material disables its transport.
  const sharedController=make(),sharedGroup=new THREE.Group(),first=box(),second=box();second.material=first.material;sharedGroup.add(first,second);sharedController.attach(sharedGroup,true);sharedController.update(points,camera);assert(textured(shader(first)));first.onBeforeRender=()=>{};sharedController.update(points,camera);assert(!textured(shader(second)));sharedController.dispose();
  // Loss preserves CPU storage, forces reupload, and terminal disposal is idempotent.
  checkRecords(current);const texture=lastTexture,data=texture.image.data,version=texture.version;let disposals=0;texture.addEventListener('dispose',()=>disposals++);lighting.releaseGPU();assert.equal(disposals,1);assert.equal(texture.image.data,data);assert.equal(texture.version,version+1);checkRecords(shader(mesh));lighting.dispose();lighting.dispose();lighting.releaseGPU();assert.equal(disposals,2);
  const home=fs.readFileSync(path.join(root,'home-view.js'),'utf8'),viewer=fs.readFileSync(path.join(root,'viewer.js'),'utf8');
  assert.equal((home.match(/roomLighting(?:\?|)\.update\(points,camera\)/g)||[]).length,2);
  const signal=vm.createContext({active:true,camera,renderer:{},points,roomLighting:{geometryMode:'packed',update(p,c){assert.equal(p,points);assert.equal(c,camera);signal.updated=true;}},refreshSignalStatus(){},drawScene(){assert(signal.updated);},renderCount:0});vm.runInContext(home.slice(home.indexOf('  function drawSignalFrame('),home.indexOf('  function render() {')),signal);signal.drawSignalFrame(true);assert.equal(signal.renderCount,1);
  const construct=home.split('\n').find(line=>line.includes('if(!roomLighting || roomLighting.capacity<lightCount)'));
  let retired=0;const replacement=vm.createContext({THREE,model:{rooms},lightCount:72,daylightWindows:[],renderProfile:{diffuseLighting:true},renderer:{capabilities:options},roomLighting:{capacity:1,dispose(){retired++;}},xm:x=>x,zm:z=>z,createRoomLighting:context.createRoomLighting});vm.runInContext(construct,replacement);assert.equal(retired,1);replacement.roomLighting.dispose();
  const calls=[],apiSource=home.slice(home.lastIndexOf('  return {get active()'),home.lastIndexOf('\n})();')).trim().replace(/^return /,'(').replace(/;$/,')');
  const names=['refreshLanguage','rebuildControls','refreshControls','refreshTVPreviews','render','handleCommandResult','setActive','applyViewPreferences'];
  const api=vm.runInNewContext(apiSource,{active:false,points:[],roomLighting:{releaseGPU(){calls.push('release');},dispose(){calls.push('texture');}},...Object.fromEntries(names.map(n=>[n,()=>{}]))});
  let lost,hide;const life={editorFloorMaterials:null,homeView:api,renderSuspended:false,renderLost:false,interactionPointer:null,interactionRenderer:null,cancelRender(){},releaseStaticGlassPasses(){},disposeStaticGlassPasses(){},releaseViewerGeometryGPU(){},releaseViewerTextureGPU(){},releaseWallOutlineMaterials(){},observer:{disconnect(){}},renderer:{dispose(){calls.push('renderer');},forceContextLoss(){},domElement:{addEventListener:(e,fn)=>lost=fn}},window:{addEventListener:(e,fn)=>hide=fn}};
  vm.runInNewContext(viewer.split('\n').find(l=>l.startsWith("renderer.domElement.addEventListener('webglcontextlost'")),life);vm.runInNewContext(viewer.split('\n').find(l=>l.startsWith("window.addEventListener('pagehide'")),life);hide({persisted:true});assert.deepEqual(calls,[]);lost({preventDefault(){}});hide({persisted:false});assert.deepEqual(calls,['release','texture','renderer']);
  console.log(JSON.stringify({status:'PASS',checkedFloat32Components:checks,pinnedProgramCases:16,scope:'CPU only; no driver performance claim'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
