// Pinned source expansion and operation traces; no actual GPU compilation.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
(async()=>{
  const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'room-lighting.js'),'utf8');
  const vendor=fs.readFileSync(path.join(root,'vendor/three.module.min.js'),'utf8');
  for(const token of ['function bl(t,e,n,i){','function Al(t,e,n,i,r,s,a){'])assert(vendor.includes(token));
  const THREE=await import('data:text/javascript;base64,'+Buffer.from(vendor+'\nexport {bl as TestProgram,Al as TestPrograms};').toString('base64'));
  const api=vm.createContext({Float32Array,Int32Array});vm.runInContext(source,api);
  const compact=s=>s.replace(/\s+/g,'');
  function body(text,marker){let start=text.indexOf(marker);assert(start>=0,marker);start=text.indexOf('{',start)+1;let depth=1,end=start;for(;depth;end++){if(text[end]==='{')depth++;if(text[end]==='}')depth--;}return text.slice(start,end-1);}
  const options={packed:true,pointTexture:true,runTexture:true,geometryTexture:true,signalTexture:true,pointDecayTwo:true,literalLambertPointBody:true,literalLambertDirectional:true,literalLambertShadowPoint:true,maxFragmentUniforms:2048,maxTextureSize:4096,maxTextures:16};
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
  const selected=s=>s.fragmentShader.includes('vec3 homeShadowVector');
  function ready(f,shadows=2){f.points.forEach((p,i)=>p.light.castShadow=i<shadows);f.controller.update(f.points,camera);}
  function prefix(text){const start=text.indexOf('PointLight pointLight;'),end=text.indexOf('for ( int homeRun =',start);assert(start>=0&&end>start);return text.slice(start,end);}
  function compare(a,b,active){const x=a.shader(),y=b.shader();assert.equal(selected(x),active);assert.equal(x.vertexShader,y.vertexShader);assert.deepEqual(Object.keys(x.uniforms),Object.keys(y.uniforms));if(active)assert.equal(x.fragmentShader.replace(prefix(x.fragmentShader),prefix(y.fragmentShader)),y.fragmentShader);else assert.equal(x.fragmentShader,y.fragmentShader);assert.equal(a.material.customProgramCacheKey().replace(':literal-lambert-shadow-point-v1',''),b.material.customProgramCacheKey());return[x,y];}
  const submitted=[],gl={VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,createProgram:()=>({}),createShader:type=>({type}),shaderSource(s,text){submitted.push({type:s.type,text});},compileShader(){},attachShader(){},linkProgram(){},bindAttribLocation(){}};
  const renderer={getContext:()=>gl,getRenderTarget:()=>null,outputColorSpace:THREE.SRGBColorSpace,toneMapping:THREE.ACESFilmicToneMapping,shadowMap:{enabled:true,type:THREE.BasicShadowMap},debug:{checkShaderErrors:false}},bindings={releaseStatesOfProgram(){}};
  const programs=new THREE.TestPrograms(renderer,{get:()=>null},{get:()=>null},{has:()=>false},{precision:'highp',getMaxPrecision:x=>x,vertexTextures:true,logarithmicDepthBuffer:false,reverseDepthBuffer:false},bindings,{numPlanes:1,numIntersection:0});
  function expand(f,s,shadows){const lights={directional:[{}],point:Array(f.points.length).fill({}),spot:[{}],spotLightMap:[],rectArea:[],hemi:[{}],directionalShadowMap:[{}],pointShadowMap:Array(shadows).fill({}),spotShadowMap:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};const p=programs.getParameters(f.material,lights,[{}],new THREE.Scene(),f.mesh);p.vertexShader=s.vertexShader;p.fragmentShader=s.fragmentShader;submitted.length=0;new THREE.TestProgram(renderer,programs.getProgramCacheKey(p),p,bindings);return submitted.map(s=>s.text);}
  // Independent inverse: restore aggregate operations from pinned stock helper
  // definitions, then retain every original room/shadow statement verbatim.
  const pinnedPoint=body(THREE.ShaderChunk.lights_pars_begin,'void getPointLightInfo(');
  const pinnedDirect=body(THREE.ShaderChunk.lights_lambert_pars_fragment,'void RE_Direct_Lambert(');
  function expectedPrefix(original,decay){
    let point=pinnedPoint.replaceAll('pointLight.','pointLights[ i ].').replaceAll('lVector','homeShadowVector').replaceAll('lightDistance','homeShadowDistance')
      .replace('light.direction =','vec3 homeShadowDirection =').replace('light.color =','vec3 homeShadowColor =').replaceAll('light.color','homeShadowColor').replace('light.visible =','bool homeShadowVisible =');
    if(decay)point=point.replace('getDistanceAttenuation( homeShadowDistance, pointLights[ i ].distance, pointLights[ i ].decay )','homePointDistanceAttenuation( homeShadowDistance, pointLights[ i ].distance )');
    const direct=pinnedDirect.replaceAll('directLight.direction','homeShadowDirection').replaceAll('directLight.color','homeShadowColor').replaceAll('dotNL','homeShadowDot').replaceAll('irradiance','homeShadowIrradiance');
    return original.replace('pointLight = pointLights[ i ];',point).replace('getPointLightInfo( pointLight, geometryPosition, directLight );','')
      .replace('RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );','{'+direct+'}')
      .replaceAll('directLight.color','homeShadowColor').replaceAll('directLight.visible','homeShadowVisible');
  }
  let expansions=0,fallbacks=0,transitions=0;
  for(const capacity of[18,72])for(const shadows of[0,1,2,8])for(const shadowEnabled of[false,true])for(const decay of[false,true])for(const pointBody of[false,true])for(const direction of[false,true])for(const category of['floors','walls','frames']){
    renderer.shadowMap.enabled=shadowEnabled;
    const extra={pointDecayTwo:decay,literalLambertPointBody:pointBody,literalLambertDirectional:direction};
    const a=fixture(capacity,extra,'lambert',category),b=fixture(capacity,{...extra,literalLambertShadowPoint:false},'lambert',category);ready(a,shadows);ready(b,shadows);
    const[x,y]=compare(a,b,true);assert.equal(compact(prefix(x.fragmentShader)),compact(expectedPrefix(prefix(y.fragmentShader),decay)));
    const xx=expand(a,x,shadows),yy=expand(b,y,shadows);assert.equal(xx[0],yy[0]);assert.equal(xx[1].replace(prefix(xx[1]),prefix(yy[1])),yy[1]);
    assert.equal((prefix(xx[1]).match(/vec3 homeShadowVector/g)||[]).length,shadows);
    assert.equal((prefix(xx[1]).match(/float homeShadowTransmission/g)||[]).length,shadows);
    assert.equal((prefix(xx[1]).match(/getPointLightInfo\(/g)||[]).length,0);
    assert.equal((prefix(xx[1]).match(/RE_Direct\(/g)||[]).length,0);
    const samples=s=>[...prefix(s).matchAll(/getPointShadow\( pointShadowMap\[ (\d+) \]/g)].map(m=>Number(m[1]));
    assert.deepEqual(samples(xx[1]),samples(yy[1]));assert.deepEqual(samples(xx[1]),Array.from({length:shadows},(_,i)=>i));
    expansions++;a.controller.dispose();b.controller.dispose();
  }
  const fallbackCases=[{extra:{packed:false}},{extra:{pointTexture:false}},{extra:{maxTextures:8}},{extra:{maxFragmentUniforms:0}},{type:'standard'},{mutate:f=>f.points[0].light.intensity=NaN},{mutate:f=>f.mesh.onBeforeRender=()=>{}},{mutate:f=>f.material.onBeforeRender=()=>{}},{mutate:f=>f.controller.environment(1,[NaN])},{mutate:f=>f.points[0].light.layers.set(1)}];
  for(const test of fallbackCases){const a=fixture(18,test.extra,test.type),b=fixture(18,{...test.extra,literalLambertShadowPoint:false},test.type);for(const f of[a,b]){test.mutate?.(f);ready(f);}compare(a,b,false);a.controller.dispose();b.controller.dispose();fallbacks++;}
  const mutations=[['lights_pars_begin',s=>s.replace('normalize( lVector )','lVector')],['lights_lambert_pars_fragment',s=>s.replace('dotNL * directLight.color','directLight.color')],['lights_lambert_pars_fragment',s=>s.replace(/#define RE_Direct\s+RE_Direct_Lambert/,'#define RE_Direct Other')],['lights_lambert_pars_fragment',s=>s+'\n#define RE_Direct RE_Direct_Lambert\n'],['lights_fragment_begin',s=>s.replace('pointLight = pointLights[ i ];','pointLight = pointLights[ i ];\nfloat unknown = 1.0;')]];
  for(const[key,change]of mutations){const value=change(THREE.ShaderChunk[key]);assert.notEqual(value,THREE.ShaderChunk[key]);const three={...THREE,ShaderChunk:{...THREE.ShaderChunk,[key]:value}};
    const a=fixture(18,{},'lambert','floors',three),b=fixture(18,{literalLambertShadowPoint:false},'lambert','floors',three);ready(a);ready(b);compare(a,b,false);a.controller.dispose();b.controller.dispose();fallbacks++;}
  // The shared point guard normalizes whitespace. Shadow derivation must fail
  // closed if its exact assignment/field substitutions no longer consume it.
  const pointWhitespace=(source,from,to)=>source.replace(/void getPointLightInfo\([^]*?\n\t\}/,chunk=>chunk.replace(from,to));
  const whitespaceMutations=[['lights_pars_begin',s=>pointWhitespace(s,'light.direction =','light.direction  =')],['lights_pars_begin',s=>pointWhitespace(s,'light.color =','light.color  =')],['lights_pars_begin',s=>pointWhitespace(s,'light.visible =','light.visible  =')],['lights_pars_begin',s=>pointWhitespace(s,'pointLight.position','pointLight .position')],['lights_lambert_pars_fragment',s=>s.replace('directLight.direction','directLight .direction')]];
  for(const[key,change]of whitespaceMutations){const value=change(THREE.ShaderChunk[key]);assert.notEqual(value,THREE.ShaderChunk[key]);const three={...THREE,ShaderChunk:{...THREE.ShaderChunk,[key]:value}};
    assert(api.literalLambertPointBody(three,false),'Independent unshadowed scalar path remains supported');
    const a=fixture(18,{},'lambert','floors',three),b=fixture(18,{literalLambertShadowPoint:false},'lambert','floors',three);ready(a);ready(b);const[x]=compare(a,b,false);assert(x.fragmentShader.includes('vec3 homeLightVector'));a.controller.dispose();b.controller.dispose();fallbacks++;
  }
  const a=fixture(),b=fixture(18,{literalLambertShadowPoint:false});compare(a,b,false);transitions++;
  for(const state of['ready','decay3','invalid-signal','valid-signal','no-camera','ready','editor','home','zero','restored']){
    for(const f of[a,b]){if(state==='decay3')f.points[0].light.decay=3;else if(state==='invalid-signal')f.controller.environment(.5,[NaN]);else if(state==='valid-signal')f.controller.environment(.5,[1]);else if(state==='editor'||state==='home')f.controller.attach(f.group,state==='home',{staticGeometry:true});else if(state==='zero')f.points.forEach(p=>p.light.visible=false);else if(state==='restored')f.controller.releaseGPU();if(!['invalid-signal','valid-signal'].includes(state))f.controller.update(f.points,state==='no-camera'?null:camera);}
    compare(a,b,!['invalid-signal','valid-signal','no-camera','editor'].includes(state));transitions++;
  }
  a.controller.dispose();b.controller.dispose();
  const f32=Math.fround;
  function operations(){const trace=[];function mark(name,value){trace.push(name);return value;}
    const mulRaw=(a,b)=>Array.isArray(a)||Array.isArray(b)?(Array.isArray(a)?a:b).map((v,i)=>f32((Array.isArray(a)?a[i]:a)*(Array.isArray(b)?b[i]:b))):f32(a*b);
    const lengthRaw=v=>f32(Math.sqrt(f32(f32(f32(v[0]*v[0])+f32(v[1]*v[1]))+f32(v[2]*v[2]))));
    return{trace,sub:(a,b)=>mark('sub',a.map((v,i)=>f32(v-b[i]))),normalize:v=>{const n=lengthRaw(v);return mark('normalize',v.map(x=>f32(x/n)));},length:v=>mark('length',lengthRaw(v)),attenuation:(d,cut,decay)=>{let a=f32(1/Math.max(f32(Math.pow(d,decay)),f32(.01)));if(cut>0){const x=f32(d/cut),x2=f32(x*x),x4=f32(x2*x2),s=f32(Math.min(1,Math.max(0,f32(1-x4))));a=f32(a*f32(s*s));}return mark('attenuation',a);},nonzero:v=>mark('nonzero',v.some(x=>x!==0)),mul:(a,b)=>mark('mul',mulRaw(a,b)),saturate:v=>mark('saturate',f32(Math.min(1,Math.max(0,v)))),dot:(a,b)=>mark('dot',f32(f32(f32(a[0]*b[0])+f32(a[1]*b[1]))+f32(a[2]*b[2]))),brdf:v=>mark('brdf',mulRaw(f32(1/Math.PI),v)),add:(a,b)=>mark('add',a.map((v,i)=>f32(v+b[i])))};
  }
  function stock(light,position,normal,transmission,diffuse,initial,op,decay,shadowEnabled,receive,shadow){
    op.trace.push('transmission');let result=initial.slice();if(transmission===0)return result;
    const v=op.sub(light.position,position),direction=op.normalize(v),distance=op.length(v);let color=op.mul(light.color,op.attenuation(distance,light.distance,decay?2:light.decay)),visible=op.nonzero(color);
    if(visible){color=op.mul(color,transmission);visible=op.nonzero(color);}
    if(shadowEnabled){if(visible&&receive)op.trace.push('shadow');color=op.mul(color,visible&&receive?shadow:1);}
    if(visible){const dot=op.saturate(op.dot(normal,direction)),irradiance=op.mul(dot,color);result=op.add(result,op.mul(irradiance,op.brdf(diffuse)));}return result;
  }
  let numericCases=0,seed=9221;const random=()=>((seed=Math.imul(seed,1664525)+1013904223|0)>>>0)/2**32,special=[0,-0,1e-45,1e-30,1,100,-1,Infinity,-Infinity,NaN];
  for(const decay of[false,true])for(const shadowEnabled of[false,true])for(const receive of[false,true]){
    const f=fixture(18,{pointDecayTwo:decay});ready(f);let code=body(f.shader().fragmentShader,'{\nfloat homeShadowTransmission');
    code=code.replace(/#if defined\( USE_SHADOWMAP \)[^]*?#endif/,s=>shadowEnabled?s.replace(/^#if[^\n]*\n|#endif/g,''):'');
    code=code.replace(/\b(?:vec3|float|bool) (\w+) =/g,'let $1 =').replace('pointLights[ i ].position - geometryPosition','sub(pointLights[i].position,geometryPosition)')
      .replace('pointLights[ i ].color;','pointLights[i].color.slice();').replace(/homeShadowColor \*= ([^;]+);/g,'homeShadowColor = mul(homeShadowColor,$1);')
      .replace(/homeShadowColor != vec3\(\s*0\.0\s*\)/g,'nonzero(homeShadowColor)').replace('homeShadowDot * homeShadowColor','mul(homeShadowDot,homeShadowColor)')
      .replace('reflectedLight.directDiffuse += homeShadowIrradiance * BRDF_Lambert( material.diffuseColor );','reflectedLight.directDiffuse = add(reflectedLight.directDiffuse,mul(homeShadowIrradiance,BRDF_Lambert(material.diffuseColor)));');
    const evaluate=new Function('pointLights','i','homePointRooms','homePointTransmission','geometryPosition','geometryNormal','material','reflectedLight','receiveShadow','pointLightShadows','pointShadowMap','vPointShadowCoord','getPointShadow','sub','normalize','length','getDistanceAttenuation','homePointDistanceAttenuation','nonzero','mul','saturate','dot','BRDF_Lambert','add','let pointLightShadow;'+code);
    f.controller.dispose();
    for(let index=0;index<512;index++){
      const vector=()=>Array.from({length:3},()=>f32((random()-.5)*20));const light={position:vector(),color:vector(),distance:f32(random()*30),decay:f32(random()*4)},position=vector(),normal=vector(),diffuse=vector(),initial=vector();let transmission=f32(random()),shadow=f32(random());
      if(index<10){light.color=[special[index],0,0];transmission=index%2?0:1;}if(index>=10&&index<20)light.distance=special[index-10];if(index>=20&&index<30)light.decay=special[index-20];if(index===30)light.position=position.slice();if(index>=31&&index<41)transmission=special[index-31];if(index>=41&&index<51)shadow=special[index-41];
      const expectedOps=operations(),actualOps=operations(),expected=stock(light,position,normal,transmission,diffuse,initial,expectedOps,decay,shadowEnabled,receive,shadow),reflected={directDiffuse:initial.slice()};
      evaluate([light],0,[1],()=>{actualOps.trace.push('transmission');return transmission;},position,normal,{diffuseColor:diffuse},reflected,receive,[{}],[{}],[{}],()=>{actualOps.trace.push('shadow');return shadow;},actualOps.sub,actualOps.normalize,actualOps.length,actualOps.attenuation,(d,c)=>actualOps.attenuation(d,c,2),actualOps.nonzero,actualOps.mul,actualOps.saturate,actualOps.dot,actualOps.brdf,actualOps.add);
      assert.deepEqual(reflected.directDiffuse,expected);assert.deepEqual(actualOps.trace,expectedOps.trace);numericCases++;
    }
  }
  console.log(JSON.stringify({status:'PASS',expansions,fallbacks,transitions,numericAndOperationTraceCases:numericCases,scope:'Pinned CPU expansion and binary32 model only; no GPU compilation, pixel or performance claim'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
