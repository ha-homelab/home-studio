// CPU equivalence for the packed Lambert loop; no WebGL context is created.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'room-lighting.js'),'utf8');
(async()=>{
  const vendor=fs.readFileSync(path.join(root,'vendor/three.module.min.js'),'utf8');
  assert(vendor.includes('function bl(t,e,n,i){const r=t.getContext()'));
  assert(vendor.includes('function Al(t,e,n,i,r,s,a){'));
  const THREE=await import('data:text/javascript;base64,'+Buffer.from(vendor+'\nexport {bl as TestProgram,Al as TestPrograms};').toString('base64'));
  function context(text){const result=vm.createContext({Float32Array,Uint16Array,Uint32Array});vm.runInContext(text,result);return result;}
  const selected='mesh.material.isMeshLambertMaterial ? lambertLighting : lighting';
  assert.equal(source.split(selected).length,2);
  // The generic body is the unchanged path still used by Standard/Physical.
  const actual=context(source),reference=context(source.replace(selected,'lighting'));
  const compact=s=>s.replace(/\s+/g,'');
  function body(text,marker){let start=text.indexOf(marker);assert(start>=0,marker);start=text.indexOf('{',start)+1;let depth=1,end=start;for(;depth;end++){if(text[end]==='{')depth++;if(text[end]==='}')depth--;}return text.slice(start,end-1);}
  const pointInfo=body(THREE.ShaderChunk.lights_pars_begin,'void getPointLightInfo(');
  assert.equal(compact(pointInfo),compact(`vec3 lVector = pointLight.position - geometryPosition;
    light.direction = normalize(lVector); float lightDistance = length(lVector); light.color = pointLight.color;
    light.color *= getDistanceAttenuation(lightDistance,pointLight.distance,pointLight.decay);
    light.visible = (light.color != vec3(0.0));`));
  assert.equal(compact(body(THREE.ShaderChunk.lights_lambert_pars_fragment,'void RE_Direct_Lambert(')),compact(`
    float dotNL = saturate(dot(geometryNormal,directLight.direction)); vec3 irradiance = dotNL * directLight.color;
    reflectedLight.directDiffuse += irradiance * BRDF_Lambert(material.diffuseColor);`));
  assert.equal(compact(body(THREE.ShaderChunk.common,'vec3 BRDF_Lambert(')),compact('return RECIPROCAL_PI * diffuseColor;'));
  const loopMarker='for ( int i = homeFirstLight; i < homeRunEnd; i ++ )';
  const rooms=[{id:'A',polygon:[[0,0],[4,0],[4,4],[0,4]]},{id:'B',polygon:[[4,0],[8,0],[8,4],[6,4],[6,2],[4,2]]}];
  const windows=[{room:'A',a:[0,1],b:[0,3]}];
  function build(api,{type='lambert',packed=true,limit=4096,enabled=true,capacity=72,category='floors'}={}){
    const lighting=api.createRoomLighting(THREE,rooms,capacity,windows,{packed,maxFragmentUniforms:limit});
    const constructors={lambert:THREE.MeshLambertMaterial,standard:THREE.MeshStandardMaterial,physical:THREE.MeshPhysicalMaterial};
    const material=new constructors[type]({side:THREE.DoubleSide,transparent:category==='walls',opacity:category==='walls'?.16:1});
    material.clippingPlanes=[new THREE.Plane(new THREE.Vector3(0,-1,0),4)];
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(),material);mesh.userData.category=category;
    const group=new THREE.Group();group.add(mesh);lighting.attach(group,enabled,{staticGeometry:true});
    const lib=THREE.ShaderLib[type==='physical'?'physical':type];
    function shader(){const s={uniforms:THREE.UniformsUtils.clone(lib.uniforms),vertexShader:lib.vertexShader,fragmentShader:lib.fragmentShader};material.onBeforeCompile(s);return s;}
    return {lighting,mesh,group,shader,initial:shader()};
  }
  const a=build(actual),b=build(reference),local=body(a.initial.fragmentShader,loopMarker),generic=body(b.initial.fragmentShader,loopMarker);
  assert(local.includes('vec3 homeLightVector'));assert(!local.includes('pointLight =')&&!local.includes('directLight')&&!local.includes('RE_Direct('));
  assert.equal(a.initial.fragmentShader.replace(local,generic),b.initial.fragmentShader,'Only the inner unshadowed loop changes; prefix/directional/daylight are byte-identical');
  const expected=pointInfo
    .replaceAll('pointLight.','pointLights[ i ].').replaceAll('lVector','homeLightVector')
    .replace('light.direction =','vec3 homeLightDirection =').replaceAll('lightDistance','homeLightDistance')
    .replace('light.color =','vec3 homeLightColor =').replaceAll('light.color','homeLightColor')
    .replace('light.visible = ( homeLightColor != vec3( 0.0 ) );',`if (homeLightColor != vec3(0.0)) {
      homeLightColor *= homeRunTransmission; if (homeLightColor != vec3(0.0)) {
        ${body(THREE.ShaderChunk.lights_lambert_pars_fragment,'void RE_Direct_Lambert(')
          .replaceAll('directLight.direction','homeLightDirection').replaceAll('directLight.color','homeLightColor')
          .replaceAll('dotNL','homeDotNL').replaceAll('irradiance','homeIrradiance')}
      }
    }`);
  assert.equal(compact(local),compact(expected),'Local body is the exact pinned arithmetic expansion, with the existing two visibility gates');
  let selectionCases=0;
  for(const options of [{type:'standard'},{type:'physical'},{packed:false},{limit:0},{enabled:false}]){
    const candidate=build(actual,options),baseline=build(reference,options);
    assert.equal(candidate.initial.vertexShader,baseline.initial.vertexShader);
    assert.equal(candidate.initial.fragmentShader,baseline.initial.fragmentShader,'Unselected paths are unchanged');
    assert(!candidate.initial.fragmentShader.includes('homeLightVector'));
    selectionCases++;
  }
  // Exercise Three's real include expansion, light/shadow loop unrolling and prefixes.
  const submitted=[],gl={VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,createProgram:()=>({}),createShader:type=>({type}),
    shaderSource(shader,text){submitted.push({type:shader.type,text});},compileShader(){},attachShader(){},linkProgram(){},bindAttribLocation(){}};
  const renderer={getContext:()=>gl,getRenderTarget:()=>null,outputColorSpace:THREE.SRGBColorSpace,toneMapping:THREE.ACESFilmicToneMapping,
    shadowMap:{enabled:true,type:THREE.BasicShadowMap},debug:{checkShaderErrors:false}};
  const bindings={releaseStatesOfProgram(){}},programs=new THREE.TestPrograms(renderer,{get:()=>null},{get:()=>null},{has:()=>false},
    {precision:'highp',getMaxPrecision:x=>x,vertexTextures:true,logarithmicDepthBuffer:false,reverseDepthBuffer:false},bindings,{numPlanes:1,numIntersection:0});
  const lights={directional:[{}],point:[],spot:[],spotLightMap:[],rectArea:[],hemi:[{}],directionalShadowMap:[{}],pointShadowMap:[],spotShadowMap:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};
  function expanded(item,shader){const parameters=programs.getParameters(item.mesh.material,lights,[{}],new THREE.Scene(),item.mesh);parameters.vertexShader=shader.vertexShader;parameters.fragmentShader=shader.fragmentShader;submitted.length=0;new THREE.TestProgram(renderer,programs.getProgramCacheKey(parameters),parameters,bindings);return submitted.map(value=>value.text);}
  let expandedCases=0;
  for(const capacity of [18,72])for(const shadows of [0,1,2,8])for(const shadowEnabled of [false,true])for(const category of ['floors','walls','frames']){
    const candidate=build(actual,{capacity,category}),baseline=build(reference,{capacity,category});
    const candidateShader=candidate.initial,candidateLoop=body(candidateShader.fragmentShader,loopMarker),baselineLoop=body(baseline.initial.fragmentShader,loopMarker);
    lights.point=Array.from({length:capacity},()=>({}));lights.pointShadowMap=Array.from({length:shadows},()=>({}));renderer.shadowMap.enabled=shadowEnabled;
    const restored={...candidateShader,fragmentShader:candidateShader.fragmentShader.replace(candidateLoop,baselineLoop)};
    assert.deepEqual(expanded(candidate,restored),expanded(baseline,baseline.initial),'Real expanded shadow prefix, directional, daylight, normal and material code is unchanged');
    const emitted=expanded(candidate,candidateShader)[1];assert(emitted.includes('homeLightVector'));assert(!emitted.includes('#include'));
    expandedCases++;
  }
  // Execute the emitted local arithmetic with per-operation Float32 rounding.
  // Pinned stock functions form the independent reference; compare operation
  // traces too, so reassociation/hoisting cannot pass on coincidental values.
  const executable=local.replace(/\b(?:vec3|float) (\w+) =/g,'let $1 =')
    .replace('pointLights[ i ].position - geometryPosition','sub(pointLights[i].position,geometryPosition)')
    .replace('pointLights[ i ].color;','pointLights[i].color.slice();')
    .replace(/homeLightColor \*= ([^;]+);/g,'homeLightColor = mul(homeLightColor,$1);')
    .replace(/homeLightColor != vec3\( 0\.0 \)/g,'nonzero(homeLightColor)')
    .replace('homeDotNL * homeLightColor','mul(homeDotNL,homeLightColor)')
    .replace('reflectedLight.directDiffuse += homeIrradiance * BRDF_Lambert( material.diffuseColor );','reflectedLight.directDiffuse = add(reflectedLight.directDiffuse,mul(homeIrradiance,BRDF_Lambert(material.diffuseColor)));');
  const evaluate=new Function('pointLights','i','geometryPosition','geometryNormal','homeRunTransmission','material','reflectedLight','sub','normalize','length','getDistanceAttenuation','nonzero','mul','saturate','dot','BRDF_Lambert','add',executable);
  const f=Math.fround;
  function operations(){const trace=[];function mark(name,value){trace.push(name);return value;}
    const mulRaw=(a,b)=>Array.isArray(a)||Array.isArray(b)?(Array.isArray(a)?a:b).map((v,i)=>f((Array.isArray(a)?a[i]:a)*(Array.isArray(b)?b[i]:b))):f(a*b);
    const lengthRaw=v=>f(Math.sqrt(f(f(f(v[0]*v[0])+f(v[1]*v[1]))+f(v[2]*v[2]))));
    return {trace,sub:(a,b)=>mark('sub',a.map((v,i)=>f(v-b[i]))),normalize:v=>{const n=lengthRaw(v);return mark('normalize',v.map(x=>f(x/n)));},length:v=>mark('length',lengthRaw(v)),
      attenuation:(d,cut,decay)=>{let a=f(1/Math.max(f(Math.pow(d,decay)),f(.01)));if(cut>0){const x=f(d/cut),x2=f(x*x),x4=f(x2*x2),s=f(Math.min(1,Math.max(0,f(1-x4))));a=f(a*f(s*s));}return mark('attenuation',a);},
      nonzero:v=>mark('nonzero',v.some(x=>x!==0)),mul:(a,b)=>mark('mul',mulRaw(a,b)),saturate:v=>mark('saturate',f(Math.min(1,Math.max(0,v)))),
      dot:(a,b)=>mark('dot',f(f(f(a[0]*b[0])+f(a[1]*b[1]))+f(a[2]*b[2]))),brdf:v=>mark('brdf',mulRaw(f(1/Math.PI),v)),add:(a,b)=>mark('add',a.map((v,i)=>f(v+b[i])))};
  }
  function stock(light,position,normal,transmission,diffuse,initial,op){
    const vector=op.sub(light.position,position),direction=op.normalize(vector),distance=op.length(vector);
    let color=light.color.slice();color=op.mul(color,op.attenuation(distance,light.distance,light.decay));
    let visible=op.nonzero(color);if(visible){color=op.mul(color,transmission);visible=op.nonzero(color);}
    let result=initial.slice();if(visible){const dotNL=op.saturate(op.dot(normal,direction)),irradiance=op.mul(dotNL,color);result=op.add(result,op.mul(irradiance,op.brdf(diffuse)));}return result;
  }
  let seed=1927;const random=()=>((seed=Math.imul(seed,1664525)+1013904223|0)>>>0)/2**32;let numericCases=0;
  const special=[0,-0,1e-45,1e-30,1,100,-1,Infinity,-Infinity,NaN];
  for(let index=0;index<2048;index++){
    const vector=()=>Array.from({length:3},()=>f((random()-.5)*20));
    const light={position:vector(),color:vector(),distance:f(random()*30),decay:f(random()*4)},position=vector(),normal=vector(),diffuse=vector(),initial=vector();let transmission=f(random());
    if(index<special.length){light.color=[special[index],0,0];transmission=index%2?0:1;}
    if(index>=10&&index<20)light.distance=special[index-10];
    if(index>=20&&index<30)light.decay=special[index-20];
    if(index===30)light.position=position.slice();if(index===31)transmission=NaN;
    const expectedOps=operations(),actualOps=operations(),expected=stock(light,position,normal,transmission,diffuse,initial,expectedOps),reflected={directDiffuse:initial.slice()};
    evaluate([light],0,position,normal,transmission,{diffuseColor:diffuse},reflected,actualOps.sub,actualOps.normalize,actualOps.length,actualOps.attenuation,actualOps.nonzero,actualOps.mul,actualOps.saturate,actualOps.dot,actualOps.brdf,actualOps.add);
    assert.deepEqual(reflected.directDiffuse,expected);assert.deepEqual(actualOps.trace,expectedOps.trace);numericCases++;
  }
  const key=a.mesh.material.customProgramCacheKey(),guard=a.initial.uniforms.homePointLightingRequired;
  a.lighting.update([]);assert.equal(guard.value,false);assert.equal(a.mesh.material.customProgramCacheKey(),key);
  a.lighting.attach(a.group,false,{staticGeometry:true});assert(!a.shader().fragmentShader.includes('homeLightVector'));
  a.lighting.attach(a.group,true,{staticGeometry:true});assert(a.shader().fragmentShader.includes('homeLightVector'));assert.equal(a.shader().uniforms.homePointLightingRequired,guard);
  console.log(JSON.stringify({status:'PASS',pinnedThree:THREE.REVISION,expandedCases,negativeSelectionCases:selectionCases,numericAndOperationTraceCases:numericCases,stockShadowDirectionalDaylightPreserved:true,browserLaunched:false}));
})().catch(error=>{console.error(error);process.exitCode=1;});
