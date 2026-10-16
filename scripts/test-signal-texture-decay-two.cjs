// Composition proof: pinned Three expansion/upload logic, never a GPU compiler.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
(async()=>{
  const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
  const vendor=read('vendor/three.module.min.js');
  for(const token of ['function Ol(t){const e=new Ul,','class il{constructor(t,e)','function bl(t,e,n,i){','function Al(t,e,n,i,r,s,a){'])assert(vendor.includes(token));
  const THREE=await import('data:text/javascript;base64,'+Buffer.from(vendor+'\nexport {Ol as OracleLights,il as OracleUniforms,bl as TestProgram,Al as TestPrograms};').toString('base64'));
  const context=vm.createContext({Float32Array,Int32Array,Uint16Array,Uint32Array});vm.runInContext(read('room-lighting.js'),context);
  const options={packed:true,pointTexture:true,runTexture:true,geometryTexture:true,signalTexture:true,pointDecayTwo:true,maxFragmentUniforms:2048,maxTextureSize:4096,maxTextures:16};
  const camera=new THREE.PerspectiveCamera();camera.position.set(2,7,12);camera.lookAt(1,0,0);camera.updateMatrixWorld(true);
  const compile=m=>{const s={uniforms:THREE.UniformsUtils.clone(THREE.ShaderLib[m.isMeshStandardMaterial?'standard':'lambert'].uniforms),vertexShader:THREE.ShaderLib[m.isMeshStandardMaterial?'standard':'lambert'].vertexShader,fragmentShader:THREE.ShaderLib[m.isMeshStandardMaterial?'standard':'lambert'].fragmentShader};m.onBeforeCompile(s);return s;};
  const mode=s=>[s.fragmentShader.includes('uniform highp sampler2D homePointTexture;'),s.fragmentShader.includes('float homePointDistanceAttenuation(')].map(Number).join('');
  function fixture(capacity=18,extra={},Material=THREE.MeshLambertMaterial,configure=()=>{}){
    const rooms=Array.from({length:capacity/3},(_,i)=>({id:'r'+i,polygon:[[i*4,0],[i*4+4,0],[i*4+4,4],[i*4,4]]}));
    const windows=rooms.slice(0,6).map((r,i)=>({id:'w'+i,room:r.id,a:r.polygon[0],b:r.polygon[1]}));
    const c=context.createRoomLighting(THREE,rooms,capacity,windows,{...options,...extra});
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(),new Material()),group=new THREE.Group();group.add(mesh);configure(mesh,group);c.attach(group,true,{staticGeometry:true});
    const points=Array.from({length:capacity},(_,i)=>{const light=new THREE.PointLight(new THREE.Color(.2,.4,.6),1,5,2);light.position.set(i*.01,1,2);light.updateMatrixWorld(true);return{item:{room:'r'+Math.floor(i/3)},light};});
    return{c,mesh,group,m:mesh.material,points};
  }
  function setup(f,shadows=2){f.points.forEach((p,i)=>p.light.castShadow=i<shadows);f.c.environment(.6,[.7,.8,.9]);f.c.update(f.points,camera);}
  function records(f){const oracle=new THREE.OracleLights({get(){throw Error('Unexpected extension');}});oracle.setup(f.points.filter(p=>p.light.visible).map(p=>p.light));oracle.setupView(f.points.filter(p=>p.light.visible).map(p=>p.light),camera);return oracle.state.point;}
  function texture(s,f){s.uniforms.pointLights.value=records(f);return s.uniforms.homePointTexture.value;}
  const original=THREE.ShaderChunk.lights_pars_begin;
  const generic=original.match(/float getDistanceAttenuation\([^]*?\n\}/)[0];
  const dedicated=generic.replace('getDistanceAttenuation','homePointDistanceAttenuation').replace(', const in float decayExponent','').replace('pow( lightDistance, decayExponent )','pow( lightDistance, 2.0 )');
  const oldCall='getDistanceAttenuation( lightDistance, pointLight.distance, pointLight.decay )',newCall='homePointDistanceAttenuation( lightDistance, pointLight.distance )';
  const inverse=s=>s.replace(dedicated+'\n','').replace(newCall,oldCall);
  const submissions=[],gl={VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,createProgram:()=>({}),createShader:type=>({type}),shaderSource(s,text){submissions.push({type:s.type,text});},compileShader(){},attachShader(){},linkProgram(){},bindAttribLocation(){}};
  const renderer={getContext:()=>gl,getRenderTarget:()=>null,outputColorSpace:THREE.SRGBColorSpace,toneMapping:THREE.ACESFilmicToneMapping,shadowMap:{enabled:true,type:THREE.BasicShadowMap},debug:{checkShaderErrors:false}},bindings={releaseStatesOfProgram(){}},caps={precision:'highp',getMaxPrecision:x=>x,vertexTextures:true,logarithmicDepthBuffer:false,reverseDepthBuffer:false};
  const programs=new THREE.TestPrograms(renderer,{get:()=>null},{get:()=>null},{has:()=>false},caps,bindings,{numPlanes:0,numIntersection:0});
  function expand(f,s,shadows){
    const lights={directional:[{}],point:Array(f.points.length).fill({}),spot:[{}],spotLightMap:[],rectArea:[],hemi:[{}],directionalShadowMap:[{}],pointShadowMap:Array(shadows).fill({}),spotShadowMap:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};
    const p=programs.getParameters(f.m,lights,[{}],new THREE.Scene(),f.mesh);p.vertexShader=s.vertexShader;p.fragmentShader=s.fragmentShader;
    const key=programs.getProgramCacheKey(p);submissions.length=0;new THREE.TestProgram(renderer,key,p,bindings);
    return{key,vertex:submissions.find(s=>s.type===35633).text,fragment:submissions.find(s=>s.type===35632).text};
  }
  let expansions=0,transitions=0;
  for(const capacity of [18,72])for(const shadows of [0,1,2,8])for(const enabled of [false,true]){
    renderer.shadowMap.enabled=enabled;
    const variants={};
    for(const storage of [false,true])for(const decay of [false,true]){
      const f=fixture(capacity,{pointTexture:storage,pointDecayTwo:decay});setup(f,shadows);
      const s=compile(f.m),id=`${+storage}${+decay}`;assert.equal(mode(s),id);
      variants[id]={f,s,...expand(f,s,shadows)};expansions++;
      const x=variants[id].fragment;
      assert.equal(x.includes(dedicated),decay);assert(x.includes(generic));
      assert(x.includes('getDistanceAttenuation( lightDistance, spotLight.distance, spotLight.decay )'));
      assert.equal((x.match(/uniform highp sampler2D /g)||[]).length,storage?3:0,'Composition adds no sampler');
      assert.deepEqual([...x.matchAll(/pointLight = pointLights\[\s*(\d+)\s*\]/g)].map(m=>+m[1]),Array.from({length:shadows},(_,i)=>i));
      if(storage){assert(!/home(?:LitRooms|WindowTransmission|LightRuns|RoomBounds)\[/.test(x));assert(!/pointLights\[\s*i/.test(x));assert(texture(s,f).isDataTexture);}
    }
    assert.equal(new Set(Object.values(variants).map(v=>v.key)).size,4,'All four real Three program keys are distinct');
    for(const storage of ['0','1']){
      const a=variants[storage+'1'],b=variants[storage+'0'];
      assert.equal(inverse(a.fragment),b.fragment,'Complete expanded fragment differs only by the point helper');
      assert.equal(a.vertex,b.vertex);assert.deepEqual(Object.keys(a.s.uniforms),Object.keys(b.s.uniforms));
    }
    for(const v of Object.values(variants))v.f.c.dispose();
  }
  const f=fixture();assert.equal(mode(compile(f.m)),'00','Initial state is unproved');setup(f);
  const full=compile(f.m),textures=[texture(full,f),full.uniforms.homeRunTexture.value,full.uniforms.homeGeometryTexture.value];
  assert.equal(new Set(textures).size,3);const arrays=textures.map(t=>t.image.data),keys=new Map();
  function expect(id){const s=compile(f.m);assert.equal(mode(s),id);const key=f.m.customProgramCacheKey();if(keys.has(id))assert.equal(key,keys.get(id));else keys.set(id,key);transitions++;return s;}
  expect('11');
  f.points[0].light.decay=3;f.c.update(f.points,camera);const textureOnly=expect('10');assert.equal(texture(textureOnly,f),textures[0]);
  assert.equal(textures[0].image.data[7],3,'Dynamic decay remains in the exact original point record');
  f.c.environment(.5,[NaN]);const neither=expect('00');
  f.points[0].light.decay=2;f.c.update(f.points,camera);const decayOnly=expect('01');
  f.c.environment(.5,[.25]);expect('01');f.c.update(f.points,camera);expect('11');
  assert.equal(keys.size,4);assert.equal(new Set(keys.values()).size,4);
  const materialVersion=f.m.version;f.c.update(f.points,camera);expect('11');assert.equal(f.m.version,materialVersion,'Stable eligibility never invalidates again');
  // No camera only rejects storage. A valid camera restores it independently.
  f.c.update(f.points);expect('01');f.c.update(f.points,camera);expect('11');
  // Environment-only changes update appended records without changing decay.
  f.c.environment(.2,[-0]);expect('11');const t=texture(full,f);assert(Object.is(t.image.data[(f.points.length*2+f.points.length/3)*4],-0));
  // Real pinned uploader: inactive maps must not evaluate leftover texture getters.
  const inactive={...decayOnly.uniforms,homePointTexture:{get value(){throw Error('Inactive texture getter evaluated');}}};
  const active=[{name:'homePointTexture',size:1,type:35678}],bound=[];
  const uploadGL={ACTIVE_UNIFORMS:35718,getProgramParameter:()=>active.length,getActiveUniform:(_,i)=>active[i],getUniformLocation:(_,n)=>n,uniform1i(){},uniform1f(){},uniform3f(){}};
  const upload=uniforms=>{const u=new THREE.OracleUniforms(uploadGL,{});THREE.OracleUniforms.upload(uploadGL,THREE.OracleUniforms.seqWithValue(u.seq,uniforms),uniforms,{allocateTextureUnit:()=>0,setTexture2D:(...v)=>bound.push(v)});};
  active.length=0;upload(inactive);assert.equal(bound.length,0);
  f.c.attach(f.group,false,{staticGeometry:true});const editor=compile(f.m);assert.equal(mode(editor),'00');assert(!editor.fragmentShader.includes('homeWorldPosition'));upload(editor.uniforms);
  f.c.attach(f.group,true,{staticGeometry:true});f.c.update(f.points,camera);expect('11');
  // Returning to a cached textured program uses whichever uniform map was last compiled.
  active.push({name:'homePointTexture',size:1,type:35678});
  for(const latest of [neither,decayOnly,textureOnly,editor,full]){
    f.points[0].light.intensity+=.1;camera.position.x+=.25;camera.updateMatrixWorld(true);f.c.update(f.points,camera);
    assert.equal(texture(latest,f),textures[0]);upload(latest.uniforms);assert.equal(bound.at(-1)[0],textures[0]);
    for(const [i,record]of records(f).entries())assert.deepEqual(Array.from(textures[0].image.data.slice(i*8,i*8+8)),[...record.position.toArray(),record.distance,...record.color.toArray(),record.decay].map(Math.fround));
  }
  // Owned callback identities are shared by both selectors; external hooks fail conservatively.
  const before=f.mesh.onBeforeRender;f.mesh.onBeforeRender=()=>{};f.c.update(f.points,camera);expect('00');f.mesh.onBeforeRender=before;f.c.update(f.points,camera);expect('11');
  f.c.update([],camera);expect('10');f.c.update(f.points,camera);expect('11');
  let disposals=0;textures.forEach(t=>t.addEventListener('dispose',()=>disposals++));
  const versions=textures.map(t=>t.version);f.c.releaseGPU();assert.equal(disposals,3);f.c.update(f.points,camera);expect('11');
  assert.equal(texture(full,f),textures[0]);textures.forEach((t,i)=>{assert.equal(t.image.data,arrays[i]);assert(t.version>versions[i]);});
  f.c.dispose();f.c.dispose();f.c.releaseGPU();assert.equal(disposals,6,'Only the existing three texture resources are released');
  for(const [extra,Material,id]of [[{packed:false},THREE.MeshLambertMaterial,'00'],[{},THREE.MeshStandardMaterial,'00'],[{maxTextures:15},THREE.MeshLambertMaterial,'01'],[{maxTextureSize:1},THREE.MeshLambertMaterial,'01']]){
    const x=fixture(18,extra,Material);setup(x);assert.equal(mode(compile(x.m)),id);x.c.dispose();
  }
  for(const configure of [m=>{m.material.onBeforeCompile=()=>{};},m=>{m.material.customProgramCacheKey=()=> 'external';}]){
    const x=fixture(18,{},THREE.MeshLambertMaterial,configure);setup(x);assert.equal(mode(compile(x.m)),'10','Decay keeps its prior-hook rejection independently of transport');x.c.dispose();
  }
  const home=read('home-view.js');assert(home.includes('pointDecayTwo:true,pointTexture:true,runTexture:true,geometryTexture:true,signalTexture:true'));
  assert.equal((home.match(/roomLighting(?:\?|)\.update\(points,camera\)/g)||[]).length,2,'Full and signal-only paths keep the same camera-aware proof');
  console.log(JSON.stringify({status:'PASS',pinnedExpansions:expansions,transitionChecks:transitions,textureResources:3,scope:'CPU source, keys and uploader only; no GPU compilation, pixel or performance claim'}));
})().catch(e=>{console.error(String(e.stack||e).replace(/data:text\/javascript;base64,[^\s)]+/g,'[pinned Three]'));process.exitCode=1;});
