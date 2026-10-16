// CPU/source proof only. Constant pow lowering and pixels still require real GL.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
(async()=>{
  const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
  const vendor=read('vendor/three.module.min.js');
  for(const token of ['function Ol(t){const e=new Ul,','function bl(t,e,n,i){','function Al(t,e,n,i,r,s,a){'])assert(vendor.includes(token));
  const THREE=await import('data:text/javascript;base64,'+Buffer.from(vendor+'\nexport {Ol as OracleLights,bl as TestProgram,Al as TestPrograms};').toString('base64'));
  const context=vm.createContext({Float32Array,Int32Array,Uint16Array,Uint32Array});vm.runInContext(read('room-lighting.js'),context);
  for(const name of ['beginWallShadow','endWallShadow'])vm.runInContext(read('viewer.js').match(new RegExp('function '+name+'\\([^\\n]+'))[0],context);
  const original=THREE.ShaderChunk.lights_pars_begin,special=context.pointDecayTwoChunk(THREE);
  const helper=original.match(/float getDistanceAttenuation\([^]*?\n\}/)[0];
  const dedicated=special.match(/float homePointDistanceAttenuation\([^]*?\n\}/)[0];
  assert.equal(dedicated,helper.replace('getDistanceAttenuation','homePointDistanceAttenuation').replace(', const in float decayExponent','').replace('pow( lightDistance, decayExponent )','pow( lightDistance, 2.0 )'));
  const call='getDistanceAttenuation( lightDistance, pointLight.distance, pointLight.decay )',replacement='homePointDistanceAttenuation( lightDistance, pointLight.distance )';
  assert.equal(special.replace(dedicated+'\n','').replace(replacement,call),original,'Nothing else in the pinned lighting declarations changes');
  assert.equal(special.match(/void getSpotLightInfo\([^]*?\n\t\}/)[0],original.match(/void getSpotLightInfo\([^]*?\n\t\}/)[0]);
  assert.equal(context.pointDecayTwoChunk({ShaderChunk:{lights_pars_begin:original.replace(call,'unsupported()')}}),null);
  assert.equal(context.pointDecayTwoChunk({ShaderChunk:{lights_pars_begin:original.replace('pow( lightDistance, decayExponent )','lightDistance')}}),null);
  // Execute the actual two function bodies using identical scalar operators;
  // trace pow/cutoff operations, not a substitute multiplication formula.
  const body=text=>text.slice(text.indexOf('{')+1,text.lastIndexOf('}')).replace(/\bfloat /g,'let ');
  const reference=new Function('lightDistance','cutoffDistance','decayExponent','pow','pow2','pow4','saturate','max',body(helper));
  const candidate=new Function('lightDistance','cutoffDistance','pow','pow2','pow4','saturate','max',body(dedicated));
  let numericCases=0;
  function evaluate(fn,args){const trace=[];const op=(name,f)=>(...values)=>{trace.push([name,...values]);return f(...values);};return {value:fn(...args,op('pow',Math.pow),op('pow2',x=>x*x),op('pow4',x=>{const y=x*x;return y*y;}),op('saturate',x=>Math.min(1,Math.max(0,x))),op('max',Math.max)),trace};}
  for(const d of [0,-0,1e-40,.01,.1,.333,1,3,7,100,1e10,Infinity,NaN])for(const cutoff of [0,-0,-1,.1,1,7,100,Infinity]){
    const a=evaluate(reference,[d,cutoff,2]),b=evaluate(candidate,[d,cutoff]);assert(Object.is(a.value,b.value));assert.deepEqual(a.trace,b.trace);numericCases++;
  }
  const rooms=[{id:'A',polygon:[[0,0],[4,0],[4,4],[0,4]]},{id:'B',polygon:[[4,0],[8,0],[8,4],[4,4]]}];
  const options={packed:true,pointDecayTwo:true,maxFragmentUniforms:2048};
  const point=(room='A',shadow=false)=>{const light=new THREE.PointLight(new THREE.Color(.2,.4,.6),0,7,2);light.position.set(1,2,3);light.castShadow=shadow;return {item:{room},light};};
  const shader=m=>{const lib=m.isMeshStandardMaterial?THREE.ShaderLib.standard:THREE.ShaderLib.lambert,s={uniforms:THREE.UniformsUtils.clone(lib.uniforms),vertexShader:lib.vertexShader,fragmentShader:lib.fragmentShader};m.onBeforeCompile(s);return s;};
  const selected=m=>shader(m).fragmentShader.includes('float homePointDistanceAttenuation(');
  function fixture(extra={},Material=THREE.MeshLambertMaterial,setup=()=>{},capacity=72){
    const c=context.createRoomLighting(THREE,rooms,capacity,[],{...options,...extra}),group=new THREE.Group(),mesh=new THREE.Mesh(new THREE.BoxGeometry(),new Material());mesh.userData.category='floors';group.add(mesh);setup(mesh,group);c.attach(group,true,{staticGeometry:true});return {c,group,mesh,m:mesh.material};
  }
  const f=fixture(),points=[point('B'),point('A',true),point('B',true),point('A')];
  const initial=shader(f.m),initialKey=f.m.customProgramCacheKey();assert(!selected(f.m));
  const identities=points.map(p=>[p.light,p.light.shadow,p.light.castShadow]);
  f.c.update(points);assert(selected(f.m));const key=f.m.customProgramCacheKey(),version=f.m.version;assert.notEqual(key,initialKey);
  const active=shader(f.m);assert.equal(active.vertexShader,initial.vertexShader);assert.equal(active.fragmentShader.replace(special,'#include <lights_pars_begin>'),initial.fragmentShader);
  assert.deepEqual(Object.keys(active.uniforms),Object.keys(initial.uniforms),'No new uploads or changed uniform schema');
  for(const name of Object.keys(initial.uniforms).filter(n=>n.startsWith('home')))assert.equal(active.uniforms[name].value,initial.uniforms[name].value);
  assert.deepEqual(Array.from(active.uniforms.homePointRooms.value.slice(0,4)),[1,2,2,1]);
  for(const intensity of [0,-0,1,-1,1e-30]){points[0].light.intensity=intensity;f.c.update(points);assert(selected(f.m));assert.equal(f.m.version,version);assert.equal(f.m.customProgramCacheKey(),key);}
  points[0].light.intensity=0;
  let rejected=0;
  for(const index of [0,1,2,3])for(const decay of [0,-0,-1,1,2+Number.EPSILON*2,3,NaN,Infinity,-Infinity,undefined,'2']){
    points[index].light.decay=decay;f.c.update(points);assert(!selected(f.m));assert.equal(f.m.customProgramCacheKey(),initialKey);assert.equal(shader(f.m).fragmentShader,initial.fragmentShader);
    points[index].light.decay=2;f.c.update(points);assert(selected(f.m));assert.equal(f.m.customProgramCacheKey(),key);rejected++;
  }
  for(const [object,field] of [[points[0].light,'intensity'],[points[0].light,'distance'],[points[0].light.color,'r'],[points[0].light.position,'x']])for(const value of [NaN,Infinity,1e50]){
    const saved=object[field];object[field]=value;f.c.update(points);assert(!selected(f.m));object[field]=saved;f.c.update(points);assert(selected(f.m));rejected++;
  }
  points[0].light.isPointLight=false;f.c.update(points);assert(!selected(f.m));points[0].light.isPointLight=true;
  Object.defineProperty(points[0].light,'decay',{get:()=>2,configurable:true});f.c.update(points);assert(!selected(f.m));Object.defineProperty(points[0].light,'decay',{value:2,writable:true,configurable:true});
  points[0].light.decay=3;points[0].light.visible=false;f.c.update(points);assert(selected(f.m));points[0].light.visible=true;f.c.update(points);assert(!selected(f.m));points[0].light.decay=2;
  points[0].item.room='unknown';f.c.update(points);assert(selected(f.m),'Decay proof is independent of room confinement');points[0].item.room='A';
  f.c.update([]);assert(!selected(f.m));f.c.update(points);assert(selected(f.m));
  f.c.environment(.6,[]);assert(selected(f.m));assert.equal(shader(f.m).uniforms.homeDaylight.value,.6);
  f.c.attach(f.group,false,{staticGeometry:true});f.c.update(points);assert(!selected(f.m));assert(!shader(f.m).fragmentShader.includes('homeWorldPosition'));
  f.c.attach(f.group,true,{staticGeometry:true});assert(!selected(f.m));f.c.update(points);assert(selected(f.m));assert.equal(f.m.customProgramCacheKey(),key);
  f.m.dispose();f.c.update(points);assert(selected(f.m),'Context-loss disposal needs no extra CPU/GPU resource');
  const replacementController=fixture();assert(!selected(replacementController.m));replacementController.c.update(points);assert(selected(replacementController.m));
  const limit=fixture({},THREE.MeshLambertMaterial,()=>{},1);limit.c.update(points);assert(!selected(limit.m));
  for(const [extra,Material] of [[{pointDecayTwo:false},THREE.MeshLambertMaterial],[{packed:false},THREE.MeshLambertMaterial],[{maxFragmentUniforms:1},THREE.MeshLambertMaterial],[{},THREE.MeshStandardMaterial]]){
    const v=fixture(extra,Material),before=shader(v.m),key=v.m.customProgramCacheKey();v.c.update(points);assert(!selected(v.m));assert.equal(shader(v.m).fragmentShader,before.fragmentShader);assert.equal(v.m.customProgramCacheKey(),key);
  }
  for(const setup of [m=>{m.material.onBeforeCompile=()=>{};},m=>{m.material.customProgramCacheKey=()=> 'custom';},m=>{m.material.onBeforeRender=()=>{};},m=>{m.onBeforeRender=()=>{};},m=>{m.onBeforeShadow=()=>{};},(_m,g)=>{g.onAfterRender=()=>{};}]){
    const v=fixture({},THREE.MeshLambertMaterial,setup);v.c.update(points);assert(!selected(v.m));
  }
  for(const [object,field] of [[f.mesh,'onBeforeRender'],[f.mesh,'onAfterShadow'],[f.m,'onBeforeRender'],[f.group,'onBeforeRender']]){
    const prior=object[field];object[field]=()=>{};f.c.update(points);assert(!selected(f.m));object[field]=prior;f.c.update(points);assert(selected(f.m));
  }
  const callback=f.m.onBeforeCompile;f.m.onBeforeCompile=()=>{};f.c.update(points);f.m.onBeforeCompile=callback;assert(!selected(f.m));f.c.update(points);assert(selected(f.m));
  const shared=new THREE.Mesh(f.mesh.geometry,f.m);shared.onBeforeRender=()=>{};f.group.add(shared);f.c.attach(f.group,true,{staticGeometry:true});f.c.update(points);assert(!selected(f.m));f.group.remove(shared);f.c.update(points);assert(!selected(f.m));f.c.update(points);assert(selected(f.m));
  f.group.remove(f.mesh);f.c.update(points);assert(!selected(f.m));
  // Exact viewer-owned wall callbacks remain eligible; arbitrary lookalikes do not.
  const wall=fixture({},THREE.MeshLambertMaterial,m=>{m.userData.category='walls';m.material.onBeforeCompile=context.applyWallSheen;m.onBeforeShadow=context.beginWallShadow;m.onAfterShadow=context.endWallShadow;});wall.c.update(points);assert(selected(wall.m));
  for(const custom of [false,true]){
    const geometry=new THREE.BoxGeometry();geometry.deleteAttribute('uv');geometry.clearGroups();
    const material=new THREE.MeshLambertMaterial({side:THREE.DoubleSide,transparent:true,opacity:.2,clippingPlanes:[new THREE.Plane(new THREE.Vector3(0,-1,0),4)]});
    const mesh=new THREE.Mesh(geometry,material);mesh.userData.category='windows';
    const passes=context.createStaticGlassPasses(THREE,mesh,true);assert(passes);
    if(custom)mesh.material.onBeforeCompile=()=>{};
    const group=new THREE.Group();group.add(mesh,passes.front);
    const lighting=context.createRoomLighting(THREE,rooms,72,[],options);lighting.attach(group,true,{staticGeometry:true});lighting.update(points);
    assert.equal(selected(mesh.material),!custom,'A matching glass key never permits an external compile callback');assert(selected(passes.front.material));passes.dispose();
  }
  const submissions=[],gl={VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,createProgram:()=>({}),createShader:type=>({type}),shaderSource(s,text){submissions.push({type:s.type,text});},compileShader(){},attachShader(){},linkProgram(){},bindAttribLocation(){}};
  const renderer={getContext:()=>gl,getRenderTarget:()=>null,outputColorSpace:THREE.SRGBColorSpace,toneMapping:THREE.ACESFilmicToneMapping,shadowMap:{enabled:true,type:THREE.BasicShadowMap},debug:{checkShaderErrors:false}},bindings={releaseStatesOfProgram(){}},caps={precision:'highp',getMaxPrecision:x=>x,vertexTextures:true,logarithmicDepthBuffer:false,reverseDepthBuffer:false};
  const programs=new THREE.TestPrograms(renderer,{get:()=>null},{get:()=>null},{has:()=>false},caps,bindings,{numPlanes:0,numIntersection:0});let expansions=0;
  for(const count of [18,72])for(const shadows of [0,1,2,8])for(const shadowEnabled of [false,true]){
    const a=fixture({},THREE.MeshLambertMaterial,()=>{},count),b=fixture({pointDecayTwo:false},THREE.MeshLambertMaterial,()=>{},count),p=Array.from({length:count},(_,i)=>point(i%2?'B':'A',i<shadows));a.c.update(p);b.c.update(p);
    const oracle=new THREE.OracleLights({get(){throw Error('Unexpected extension');}});oracle.setup([...p.map(v=>v.light),new THREE.SpotLight(0xffffff,1,7,Math.PI/3,0,3)]);renderer.shadowMap.enabled=shadowEnabled;
    const expanded=v=>{const s=shader(v.m),params=programs.getParameters(v.m,oracle.state,[{}],new THREE.Scene(),v.mesh);params.vertexShader=s.vertexShader;params.fragmentShader=s.fragmentShader;submissions.length=0;new THREE.TestProgram(renderer,programs.getProgramCacheKey(params),params,bindings);return submissions.find(s=>s.type===35632).text;};
    const x=expanded(a),y=expanded(b);assert.equal(x.replace(dedicated+'\n','').replace(replacement,call),y,'Actual pinned expansion differs only by point attenuation specialization');
    assert(x.includes('pow( lightDistance, 2.0 )'));assert(x.includes('getDistanceAttenuation( lightDistance, spotLight.distance, spotLight.decay )'));
    assert.deepEqual([...x.matchAll(/pointLight = pointLights\[\s*(\d+)\s*\]/g)].map(m=>+m[1]),Array.from({length:shadows},(_,i)=>i));expansions++;
  }
  points.forEach((p,i)=>assert.deepEqual([p.light,p.light.shadow,p.light.castShadow],identities[i]));
  assert(read('home-view.js').includes('pointDecayTwo:true'));
  console.log(JSON.stringify({status:'passed',numericCases,rejectedInputs:rejected,pinnedExpansions:expansions,scope:'Exact source/call order and eligibility transitions; no driver, pixel or performance claim'}));
})().catch(e=>{console.error(String(e.stack||e).replace(/data:text\/javascript;base64,[^\s)]+/g,'[pinned Three]'));process.exitCode=1;});
