// CPU equivalence proof for replacing the packed run array with exact texels.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
(async()=>{
  const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'room-lighting.js'),'utf8');
  const vendor=fs.readFileSync(path.join(root,'vendor/three.module.min.js'),'utf8');
  for(const token of ['function bl(t,e,n,i){','function Al(t,e,n,i,r,s,a){'])assert(vendor.includes(token));
  const THREE=await import('data:text/javascript;base64,'+Buffer.from(vendor+'\nexport {bl as TestProgram,Al as TestPrograms};').toString('base64'));
  const context=vm.createContext({Float32Array,Int32Array});vm.runInContext(source,context);
  const options={packed:true,pointTexture:true,runTexture:true,maxFragmentUniforms:2048,maxTextureSize:4096,maxTextures:16};
  const rooms=Array.from({length:24},(_,i)=>({id:'r'+i,polygon:[[i*4,0],[i*4+4,0],[i*4+4,4],[i*4,4]]}));
  const camera=new THREE.PerspectiveCamera();camera.position.set(3,7,12);camera.lookAt(4,0,0);
  const points=Array.from({length:72},(_,i)=>({item:{room:'r'+Math.floor(i/3)},light:new THREE.PointLight(0xffffff,1,5,2)}));
  const make=(capacity=72,opts={})=>context.createRoomLighting(THREE,rooms,capacity,[],{...options,...opts});
  const box=()=>new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshLambertMaterial());
  const compile=mesh=>{const s={uniforms:THREE.UniformsUtils.clone(THREE.ShaderLib.lambert.uniforms),vertexShader:THREE.ShaderLib.lambert.vertexShader,fragmentShader:THREE.ShaderLib.lambert.fragmentShader};mesh.material.onBeforeCompile(s);return s;};
  const hasRun=s=>s.fragmentShader.includes('uniform highp sampler2D homeRunTexture;');
  const normalize=(s,capacity)=>s.replace('uniform highp sampler2D homeRunTexture; uniform int homeRunBlock;',`uniform ivec4 homeLightRuns[${capacity}];`).replace('ivec4(texelFetch(homeRunTexture,ivec2(homeRun,homeRunBlock),0))','homeLightRuns[homeRun]');
  function geometry(){
    const statics=new THREE.Group(),dynamic=new THREE.Group();
    const floor=box();floor.userData.category='floors';floor.position.set(5,0,2);statics.add(floor);
    const shared=box();shared.material=floor.material;shared.position.set(9,0,2);statics.add(shared);
    const rounded=new THREE.Mesh(new THREE.CylinderGeometry(1,1,2,12),new THREE.MeshLambertMaterial());rounded.userData.category='walls';rounded.position.set(15,0,2);statics.add(rounded);
    const owned=box();context.registerFallbackBoxProgram(THREE,owned,true);owned.position.set(19,0,2);statics.add(owned);
    const movable=box();movable.position.set(23,0,2);dynamic.add(movable);
    const mixed=box();mixed.material=rounded.material;mixed.position.set(27,0,2);dynamic.add(mixed);
    return {statics,dynamic,meshes:[floor,shared,rounded,owned,movable,mixed]};
  }
  const candidate=make(),original=make(72,{runTexture:false}),a=geometry(),b=geometry();
  for(const [c,g]of [[candidate,a],[original,b]]){c.attach(g.statics,true,{staticGeometry:true});c.attach(g.dynamic,true);}
  assert(!hasRun(compile(a.meshes[0])),'Unproved initial state retains the full program');
  let comparisons=0,texture,rows,previousCount;
  function compare(input=points){
    candidate.update(input,camera);original.update(input,camera);
    const shaders=a.meshes.map(compile),old=b.meshes.map(compile);rows=[];
    for(let m=0;m<shaders.length;m++){
      const s=shaders[m],o=old[m];assert(hasRun(s));assert.equal(normalize(s.fragmentShader,72),o.fragmentShader);assert.equal(s.vertexShader,o.vertexShader);
      assert(!s.fragmentShader.includes('homeLightRuns['));assert.equal(s.uniforms.homeLightRunCount.value,o.uniforms.homeLightRunCount.value);
      texture=s.uniforms.homeRunTexture.value;const row=s.uniforms.homeRunBlock.value;rows.push(row);
      const texels=Array.from(texture.image.data.slice(row*72*4,(row+1)*72*4));
      assert.deepEqual(texels,Array.from(o.uniforms.homeLightRuns.value));comparisons+=texels.length;
      for(const prefix of [0,1,2,8]){
        const indices=data=>{const list=[];for(let r=0;r<o.uniforms.homeLightRunCount.value;r++)for(let i=Math.max(data[r*4],prefix);i<Math.min(data[r*4+1],input.filter(p=>p.light.visible).length);i++)list.push([i,data[r*4+2]]);return list;};
        assert.deepEqual(indices(texels),indices(o.uniforms.homeLightRuns.value));
      }
    }
    assert.equal(rows[0],rows[1],'Shared static material has one fixed block');assert.equal(rows[4],0,'Dynamic material uses the original global block');assert(rows.slice(0,4).every(r=>r>0));
    assert.equal(rows[2],rows[5],'A mixed static/dynamic material retains one fixed row');
    assert.equal(shaders[2].uniforms.homeLightRunCount.value,shaders[4].uniforms.homeLightRunCount.value);
    assert.deepEqual(Array.from(shaders[2].uniforms.homeLightRuns.value),Array.from(shaders[4].uniforms.homeLightRuns.value),'Mixed ownership makes the fixed row unbounded');
    assert.equal(texture.type,THREE.FloatType);assert.equal(texture.internalFormat,'RGBA32F');assert.equal(texture.minFilter,THREE.NearestFilter);assert.equal(texture.magFilter,THREE.NearestFilter);assert.equal(texture.colorSpace,THREE.NoColorSpace);assert.equal(texture.generateMipmaps,false);assert.equal(texture.flipY,false);
    const version=texture.version;candidate.update(input,camera);assert.equal(texture.version,version,'No redundant texture invalidation for identical runs');
    return shaders;
  }
  for(const shadows of [0,1,2,8])for(const mode of ['on','off','alternating','hidden']){
    points.forEach((p,i)=>{p.light.castShadow=i<shadows;p.light.visible=mode!=='hidden'||i%3!==1;p.light.intensity=mode==='off'?0:mode==='alternating'&&i%2?0:1;});
    compare();if(previousCount)assert.deepEqual(rows,previousCount);previousCount=[...rows];
  }
  points.forEach(p=>p.light.visible=false);compare([]);assert.equal(compile(a.meshes[0]).uniforms.homeLightRunCount.value,0);
  // Fewer runs retain valid old tail records, while scalar counts alone decide use.
  points.forEach((p,i)=>{p.light.visible=true;p.item.room=i%2?'r0':'r1';});compare();
  const tail=Array.from(texture.image.data);points.forEach(p=>p.item.room='r0');compare();assert(texture.image.data.some((v,i)=>v===tail[i]&&v!==0));
  // Full/editor cached uniform maps still read the current table and block.
  candidate.update(points);const full=compile(a.meshes[0]);assert(!hasRun(full));candidate.update(points,camera);assert.equal(full.uniforms.homeRunTexture.value,texture);
  candidate.attach(a.statics,false,{staticGeometry:true});const editor=compile(a.meshes[0]);assert(!hasRun(editor));candidate.attach(a.statics,true,{staticGeometry:true});candidate.update(points,camera);assert.equal(editor.uniforms.homeRunTexture.value,texture);assert.equal(editor.uniforms.homeRunBlock.value,rows[0]);
  for(const value of [NaN,Infinity,1e50]){points[0].light.intensity=value;candidate.update(points,camera);const s=compile(a.meshes[0]);assert(!hasRun(s));assert(s.fragmentShader.includes('uniform ivec4 homeLightRuns[72];'));assert(s.fragmentShader.includes('pointLight = pointLights[ i ];'));}points[0].light.intensity=1;candidate.update(points,camera);
  // The pinned GLSL expansion retains only literal shadow PointLights and no run array.
  const submitted=[],gl={VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,createProgram:()=>({}),createShader:type=>({type}),shaderSource(s,text){submitted.push({type:s.type,text});},compileShader(){},attachShader(){},linkProgram(){},bindAttribLocation(){}};
  const renderer={getContext:()=>gl,getRenderTarget:()=>null,outputColorSpace:THREE.SRGBColorSpace,toneMapping:THREE.ACESFilmicToneMapping,shadowMap:{enabled:true,type:THREE.BasicShadowMap},debug:{checkShaderErrors:false}},bindings={releaseStatesOfProgram(){}},caps={precision:'highp',getMaxPrecision:x=>x,vertexTextures:true,logarithmicDepthBuffer:false,reverseDepthBuffer:false};
  const programs=new THREE.TestPrograms(renderer,{get:()=>null},{get:()=>null},{has:()=>false},caps,bindings,{numPlanes:0,numIntersection:0});
  for(const capacity of [18,72])for(const prefix of [0,1,2,8]){
    const c=make(capacity),m=box(),input=points.slice(0,capacity);input.forEach((p,i)=>p.light.castShadow=i<prefix);c.attach(m,true);c.update(input,camera);const s=compile(m);assert(hasRun(s));
    const lights={directional:[{}],point:Array(capacity).fill({}),spot:[],spotLightMap:[],rectArea:[],hemi:[{}],directionalShadowMap:[{}],pointShadowMap:Array(prefix).fill({}),spotShadowMap:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};
    const params=programs.getParameters(m.material,lights,[{}],new THREE.Scene(),m);params.vertexShader=s.vertexShader;params.fragmentShader=s.fragmentShader;submitted.length=0;new THREE.TestProgram(renderer,programs.getProgramCacheKey(params),params,bindings);
    const fragment=submitted.find(s=>s.type===35632).text;assert(!fragment.includes('homeLightRuns['));assert(!fragment.includes(`uniform PointLight pointLights[ ${capacity} ];`));assert(fragment.includes(`uniform PointLight pointLights[ ${prefix} ];`));assert(fragment.includes('ivec4(texelFetch(homeRunTexture,ivec2(homeRun,homeRunBlock),0))'));c.dispose();
  }
  // Direct helper contract checks malformed integers without allocating large textures.
  const uniforms=(records=[0,1,1,0],count=1)=>({homeLightRuns:{value:records},homeLightRunCount:{value:count}});
  const helper=context.createLightRunTexture(THREE,1,2,{uniformVectors:1},options),material={},state={uniforms:uniforms()},map=new Map([[material,state]]),bound={uniforms:{}};helper.bind(material,bound);helper.update(uniforms(),map);assert(helper.ready);assert.equal(bound.uniforms.homeRunBlock.value,1);
  for(const records of [[-1,1,1,0],[0,2,1,0],[1,0,1,0],[0,1,3,0],[0,1,.5,0],[0,1,1,1],[0,1,Infinity,0],[0,1,NaN,0]]){helper.update(uniforms(records),map);assert(!helper.ready);}
  for(const count of [-1,2,.5,NaN]){helper.update(uniforms(undefined,count),map);assert(!helper.ready);}
  helper.update(uniforms(),map);assert(helper.ready);
  const oldTexture=bound.uniforms.homeRunTexture.value;let retired=0;oldTexture.addEventListener('dispose',()=>retired++);map.set({},state);helper.update(uniforms(),map);assert.equal(retired,1);assert.notEqual(bound.uniforms.homeRunTexture.value,oldTexture);assert.equal(bound.uniforms.homeRunBlock.value,1,'Allocation growth preserves fixed rows');
  const current=bound.uniforms.homeRunTexture.value,data=current.image.data,version=current.version;let disposal=0;current.addEventListener('dispose',()=>disposal++);helper.releaseGPU();assert.equal(current.image.data,data);assert.equal(current.version,version+1);helper.update(uniforms(),map);assert(helper.ready);helper.dispose();helper.dispose();helper.releaseGPU();assert.equal(disposal,2);assert(!helper.ready);
  const sizeGuard=context.createLightRunTexture(THREE,1,2,{uniformVectors:1},{...options,maxTextureSize:2});sizeGuard.update(uniforms(),new Map([[{},state],[{},state]]));assert(!sizeGuard.ready);sizeGuard.dispose();
  const memoryGuard=context.createLightRunTexture(THREE,32768,2,{uniformVectors:1},{...options,maxTextureSize:65536}),large={homeLightRuns:{value:new Int32Array(32768*4)},homeLightRunCount:{value:0}};memoryGuard.update(large,new Map(Array.from({length:32},()=>[{}, {uniforms:large}])));assert(!memoryGuard.ready);memoryGuard.dispose();
  for(const opts of [{maxTextureSize:71},{maxTextures:15},{maxFragmentUniforms:context.packRoomLightingGeometry(rooms,[],72,2048).uniformVectors+2}]){const c=make(72,opts),m=box();c.attach(m,true);c.update(points,camera);assert(!hasRun(compile(m)));assert(compile(m).fragmentShader.includes('pointLight = pointLights[ i ];'));c.dispose();}
  const crowded=make(1,{maxTextureSize:2}),crowd=new THREE.Group();crowd.add(box(),box());crowded.attach(crowd,true,{staticGeometry:true});crowded.update(points.slice(0,1),camera);assert(!hasRun(compile(crowd.children[0])));crowded.dispose();
  // Public lifecycle entry points dispose both resources, including replacement.
  const latest=compile(a.meshes[0]),run=latest.uniforms.homeRunTexture.value;let released=0;run.addEventListener('dispose',()=>released++);candidate.releaseGPU();candidate.dispose();candidate.dispose();assert.equal(released,2);original.dispose();
  const home=fs.readFileSync(path.join(root,'home-view.js'),'utf8');assert(home.includes('pointTexture:true,runTexture:true'));assert(home.includes('roomLighting?.dispose();roomLighting=createRoomLighting'));
  assert(source.indexOf('if(pointTexture)runTexture?.update(uniforms,staticRuns);')>source.lastIndexOf('pointRooms, state.uniforms.homeLightRunCount.value, state.uniforms.homeLightRuns.value);'));
  console.log(JSON.stringify({status:'PASS',exactRunComponents:comparisons,pinnedProgramCases:8,scope:'CPU only; no graphics execution or performance claim'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
