// Pinned source expansion and operation traces; no actual GPU compilation.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
(async()=>{
  const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'room-lighting.js'),'utf8');
  const vendor=fs.readFileSync(path.join(root,'vendor/three.module.min.js'),'utf8');
  for(const token of ['function bl(t,e,n,i){','function Al(t,e,n,i,r,s,a){'])assert(vendor.includes(token));
  const THREE=await import('data:text/javascript;base64,'+Buffer.from(vendor+'\nexport {bl as TestProgram,Al as TestPrograms};').toString('base64'));
  const api=vm.createContext({Float32Array,Int32Array});vm.runInContext(source,api);
  function body(text,marker){let start=text.indexOf(marker);assert(start>=0,marker);start=text.indexOf('{',start)+1;let depth=1,end=start;for(;depth;end++){if(text[end]==='{')depth++;if(text[end]==='}')depth--;}return text.slice(start,end-1);}
  const options={packed:true,pointTexture:true,runTexture:true,geometryTexture:true,signalTexture:true,pointDecayTwo:true,literalLambertPointBody:true,literalLambertDirectional:true,literalLambertShadowPoint:true,literalLambertIndirect:true,maxFragmentUniforms:2048,maxTextureSize:4096,maxTextures:16};
  const camera=new THREE.PerspectiveCamera();camera.position.set(2,7,12);camera.lookAt(1,0,0);camera.updateMatrixWorld(true);
  function fixture(capacity=18,extra={},type='lambert',category='floors',three=THREE){
    const rooms=[{id:'a',polygon:[[0,0],[4,0],[4,4],[0,4]]},{id:'b',polygon:[[4,0],[8,0],[8,4],[6,4],[6,2],[4,2]]}];
    const controller=api.createRoomLighting(three,rooms,capacity,[{room:'a',a:[0,1],b:[0,3]}],{...options,...extra});
    const material=new (type==='lambert'?THREE.MeshLambertMaterial:THREE.MeshStandardMaterial)({side:THREE.DoubleSide,transparent:category==='walls',opacity:category==='walls'?.16:1});
    material.clippingPlanes=[new THREE.Plane(new THREE.Vector3(0,-1,0),4)];
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(),material),group=new THREE.Group();mesh.userData.category=category;group.add(mesh);controller.attach(group,true,{staticGeometry:true});
    const points=Array.from({length:capacity},(_,i)=>{const light=new THREE.PointLight(new THREE.Color(.2,.4,.6),1,5,2);light.position.set(i*.01,1,2);return{item:{room:i%2?'b':'a'},light};});
    function shader(){const lib=THREE.ShaderLib[type],s={uniforms:THREE.UniformsUtils.clone(lib.uniforms),vertexShader:lib.vertexShader,fragmentShader:lib.fragmentShader};material.onBeforeCompile(s);return s;}
    return{controller,material,mesh,group,points,shader};
  }
  const original = THREE.ShaderChunk.lights_fragment_end;
  const call = 'RE_IndirectDiffuse( irradiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
  const statement = 'reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );';
  const replacement = original.replace(call,statement), tag=':literal-lambert-indirect-v1';
  // Independent oracle comes from the actual pinned helper and its call.
  assert.equal(body(THREE.ShaderChunk.lights_lambert_pars_fragment,'void RE_IndirectDiffuse_Lambert(').trim(),statement);
  assert.equal(original.split(call).length,2);
  const selected=s=>s.fragmentShader.includes(replacement);
  function ready(f,shadows=2){f.points.forEach((p,i)=>p.light.castShadow=i<shadows);f.controller.update(f.points,camera);}
  function compare(a,b,active){const x=a.shader(),y=b.shader();assert.equal(selected(x),active);assert.equal(x.vertexShader,y.vertexShader);assert.deepEqual(Object.keys(x.uniforms),Object.keys(y.uniforms));assert.equal(active?x.fragmentShader.replace(replacement,'#include <lights_fragment_end>'):x.fragmentShader,y.fragmentShader);assert.equal(a.material.customProgramCacheKey().replace(tag,''),b.material.customProgramCacheKey());return[x,y];}
  const submitted=[],gl={VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,createProgram:()=>({}),createShader:type=>({type}),shaderSource(s,text){submitted.push({type:s.type,text});},compileShader(){},attachShader(){},linkProgram(){},bindAttribLocation(){}};
  const renderer={getContext:()=>gl,getRenderTarget:()=>null,outputColorSpace:THREE.SRGBColorSpace,toneMapping:THREE.ACESFilmicToneMapping,shadowMap:{enabled:true,type:THREE.BasicShadowMap},debug:{checkShaderErrors:false}},bindings={releaseStatesOfProgram(){}};
  const programs=new THREE.TestPrograms(renderer,{get:()=>null},{get:()=>null},{has:()=>false},{precision:'highp',getMaxPrecision:x=>x,vertexTextures:true,logarithmicDepthBuffer:false,reverseDepthBuffer:false},bindings,{numPlanes:1,numIntersection:0});
  function expand(f,s,shadows){const lights={directional:[{}],point:Array(f.points.length).fill({}),spot:[{}],spotLightMap:[],rectArea:[],hemi:[{}],directionalShadowMap:[{}],pointShadowMap:Array(shadows).fill({}),spotShadowMap:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};const p=programs.getParameters(f.material,lights,[{}],new THREE.Scene(),f.mesh);p.vertexShader=s.vertexShader;p.fragmentShader=s.fragmentShader;submitted.length=0;new THREE.TestProgram(renderer,programs.getProgramCacheKey(p),p,bindings);return submitted.map(s=>s.text);}
  let expansions=0,fallbacks=0,transitions=0;
  for(const capacity of[18,72])for(const shadows of[0,1,2,8])for(const enabled of[false,true])for(const decay of[false,true])for(const scalar of[false,true])for(const category of['floors','walls']){
    renderer.shadowMap.enabled=enabled;
    const extra={pointDecayTwo:decay,literalLambertPointBody:scalar,literalLambertDirectional:scalar,literalLambertShadowPoint:scalar};
    const a=fixture(capacity,extra,'lambert',category),b=fixture(capacity,{...extra,literalLambertIndirect:false},'lambert',category);ready(a,shadows);ready(b,shadows);
    const[x,y]=compare(a,b,true),xx=expand(a,x,shadows),yy=expand(b,y,shadows);
    assert.equal(xx[0],yy[0]);assert.equal(xx[1].split(replacement).length,2);assert.equal(xx[1].replace(replacement,original),yy[1]);
    expansions++;a.controller.dispose();b.controller.dispose();
  }
  for(const test of[{extra:{packed:false}},{extra:{pointTexture:false}},{extra:{maxTextures:8}},{extra:{maxFragmentUniforms:0}},{type:'standard'},{mutate:f=>f.points[0].light.intensity=NaN},{mutate:f=>f.mesh.onBeforeRender=()=>{}},{mutate:f=>f.material.onBeforeRender=()=>{}},{mutate:f=>f.controller.environment(1,[NaN])},{mutate:f=>f.points[0].light.layers.set(1)}]){
    const a=fixture(18,test.extra,test.type),b=fixture(18,{...test.extra,literalLambertIndirect:false},test.type);for(const f of[a,b]){test.mutate?.(f);ready(f);}compare(a,b,false);a.controller.dispose();b.controller.dispose();fallbacks++;
  }
  for(const[key,change]of[
    ['lights_lambert_pars_fragment',s=>s.replace(statement,statement+'\n\treflectedLight.indirectDiffuse *= 0.5;')],
    ['lights_lambert_pars_fragment',s=>s.replace(statement,statement.replace(' += ','  += '))],
    ['lights_lambert_pars_fragment',s=>s.replace(/#define RE_IndirectDiffuse\t\tRE_IndirectDiffuse_Lambert/,'#define RE_IndirectDiffuse Other')],
    ['lights_lambert_pars_fragment',s=>s+'\n#define RE_IndirectDiffuse RE_IndirectDiffuse_Lambert'],
    ['lights_pars_begin',s=>s+'\n#undef RE_IndirectDiffuse'],
    ['lights_fragment_end',s=>s.replace(call,call+'\n\tirradiance *= 2.0;')],
    ['lights_fragment_end',s=>s.replace(call,call.replace('irradiance,','irradiance ,'))],
    ['lights_fragment_end',s=>s+'\n'+call],
    ['lights_lambert_pars_fragment',s=>s+'\n'+s.match(/void RE_IndirectDiffuse_Lambert\([^]*?\n\}/)[0]],
  ]){
    const value=change(THREE.ShaderChunk[key]);assert.notEqual(value,THREE.ShaderChunk[key]);const three={...THREE,ShaderChunk:{...THREE.ShaderChunk,[key]:value}};
    assert.equal(api.literalLambertIndirect(three),null);
    const a=fixture(18,{},'lambert','floors',three),b=fixture(18,{literalLambertIndirect:false},'lambert','floors',three);ready(a);ready(b);compare(a,b,false);assert(a.material.customProgramCacheKey().includes(':literal-lambert-shadow-point-v1'),'Independent direct optimizations remain selected');a.controller.dispose();b.controller.dispose();fallbacks++;
  }
  assert.equal(api.literalLambertIndirect({...THREE,ShaderChunk:{...THREE.ShaderChunk,lights_fragment_end:null}}),null);
  for(const value of[undefined,false,0,1,'true']){const a=fixture(18,{literalLambertIndirect:value}),b=fixture(18,{literalLambertIndirect:false});ready(a);ready(b);compare(a,b,false);a.controller.dispose();b.controller.dispose();fallbacks++;}
  const a=fixture(),b=fixture(18,{literalLambertIndirect:false});compare(a,b,false);transitions++;
  for(const state of['ready','decay3','invalid-signal','valid-signal','no-camera','ready','editor','home','zero','restored']){
    for(const f of[a,b]){if(state==='decay3')f.points[0].light.decay=3;else if(state==='invalid-signal')f.controller.environment(.5,[NaN]);else if(state==='valid-signal')f.controller.environment(.5,[1]);else if(state==='editor'||state==='home')f.controller.attach(f.group,state==='home',{staticGeometry:true});else if(state==='zero')f.points.forEach(p=>p.light.visible=false);else if(state==='restored')f.controller.releaseGPU();if(!['invalid-signal','valid-signal'].includes(state))f.controller.update(f.points,state==='no-camera'?null:camera);}
    compare(a,b,!['invalid-signal','valid-signal','no-camera','editor'].includes(state));transitions++;
  }
  a.controller.dispose();b.controller.dispose();
  // Evaluate the emitted statement, preserving the pinned multiplication and
  // addition order, including zero/NaN/Inf; no finite-value shortcut is added.
  const f32=Math.fround,brdf=THREE.ShaderChunk.common.match(/vec3 BRDF_Lambert\([^]*?\n\}/)?.[0] || THREE.ShaderChunk.bsdfs.match(/vec3 BRDF_Lambert\([^]*?\n\}/)[0];
  assert.match(brdf,/return RECIPROCAL_PI \* diffuseColor;/);
  const sample=fixture();ready(sample);const tail=sample.shader().fragmentShader.split('irradiance += homeDaylightIrradiance();\n')[1];const emitted=tail.match(/^#if defined\( RE_IndirectDiffuse \)\n\t([^]*?)\n#endif/)[1];assert.equal(emitted,statement);sample.controller.dispose();
  const evaluate=new Function('irradiance','material','reflectedLight','mul','add','BRDF_Lambert',emitted.replace(statement,'reflectedLight.indirectDiffuse = add(reflectedLight.indirectDiffuse,mul(irradiance,BRDF_Lambert(material.diffuseColor)));'));
  const reciprocal=f32(Number(THREE.ShaderChunk.common.match(/#define RECIPROCAL_PI ([\d.]+)/)[1]));
  let numericCases=0,seed=15433;const random=()=>((seed=Math.imul(seed,1664525)+1013904223|0)>>>0)/2**32,special=[0,-0,1e-45,-1e-45,1e-30,1,100,-1,Infinity,-Infinity,NaN];
  for(let i=0;i<2048;i++){
    const vector=()=>Array.from({length:3},()=>f32((random()-.5)*100));let irr=vector(),diff=vector(),initial=vector();
    if(i<special.length)irr=[special[i],0,-0];else if(i<2*special.length)diff=[special[i-special.length],-0,0];else if(i<3*special.length)initial=[special[i-2*special.length],0,-0];
    const expected=initial.map((v,j)=>f32(v+f32(irr[j]*f32(reciprocal*diff[j]))));
    const trace=[],reflected={directDiffuse:[1,2,3],indirectDiffuse:initial.slice(),directSpecular:[4,5,6],indirectSpecular:[7,8,9]};
    evaluate(irr,{diffuseColor:diff},reflected,(x,y)=>{trace.push('multiply');return x.map((v,j)=>f32(v*y[j]));},(x,y)=>{trace.push('add');return x.map((v,j)=>f32(v+y[j]));},x=>{trace.push('brdf');return x.map(v=>f32(reciprocal*v));});
    assert.deepEqual(reflected.indirectDiffuse,expected);assert.deepEqual(trace,['brdf','multiply','add']);assert.deepEqual(reflected.directDiffuse,[1,2,3]);assert.deepEqual(reflected.directSpecular,[4,5,6]);assert.deepEqual(reflected.indirectSpecular,[7,8,9]);numericCases++;
  }
  console.log(JSON.stringify({status:'PASS',expansions,fallbacks,transitions,numericAndOperationTraceCases:numericCases,scope:'Pinned CPU expansion and binary32 model only; no GPU compilation, pixel or performance claim'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
