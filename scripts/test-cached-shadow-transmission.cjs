// Source and scalar-operation proof; no driver compilation or GPU is exercised.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'room-lighting.js'),'utf8');
const transform=source.match(/  \/\/ Packed transmission is pure[\s\S]*?(?=  const boundedPointLighting)/)?.[0];
assert(transform,'Cache transformation must remain narrowly bounded');
const originalSource=source.replace(transform,'').replace('const boundedPointLighting = shadowPointLighting.replace(',
  'const boundedPointLighting = pointLighting.replace(');
const contexts=[originalSource,source].map(text=>{const c=vm.createContext({});vm.runInContext(text,c);return c;});
(async()=>{
  const vendor=fs.readFileSync(path.join(root,'vendor/three.module.min.js'),'utf8');
  const THREE=await import('data:text/javascript;base64,'+Buffer.from(vendor+'\nexport {bl as TestProgram,Al as TestPrograms};').toString('base64'));
  assert.equal(THREE.REVISION,'169');
  const submitted=[],gl={VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,createProgram:()=>({}),createShader:type=>({type}),
    shaderSource(shader,text){submitted.push({type:shader.type,text});},compileShader(){},attachShader(){},linkProgram(){},bindAttribLocation(){}};
  const renderer={getContext:()=>gl,getRenderTarget:()=>null,outputColorSpace:THREE.SRGBColorSpace,toneMapping:THREE.ACESFilmicToneMapping,
    shadowMap:{enabled:true,type:THREE.BasicShadowMap},debug:{checkShaderErrors:false}};
  const programs=new THREE.TestPrograms(renderer,{get:()=>null},{get:()=>null},{has:()=>false},
    {precision:'highp',getMaxPrecision:x=>x,vertexTextures:true,logarithmicDepthBuffer:false,reverseDepthBuffer:false},
    {releaseStatesOfProgram(){}},{numPlanes:1,numIntersection:0});
  const rooms=[{id:'A',polygon:[[0,0],[4,0],[4,4],[0,4]]},{id:'B',polygon:[[4,0],[8,0],[8,4],[6,2],[4,4]]}];
  const lights={directional:[{}],point:[],spot:[{}],spotLightMap:[],rectArea:[],hemi:[],directionalShadowMap:[{}],pointShadowMap:[],spotShadowMap:[{}],numSpotLightShadowsWithMaps:0,numLightProbes:0};
  function build(context,{count=18,prefix=2,packed=true,enabled=true,lambert=true,limit=1024,shadow=true}={}) {
    const controller=context.createRoomLighting(THREE,rooms,count,[],{packed,maxFragmentUniforms:limit});
    const material=lambert?new THREE.MeshLambertMaterial():new THREE.MeshStandardMaterial();
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),material),group=new THREE.Group();group.add(mesh);
    controller.attach(group,enabled,{staticGeometry:true});const lib=lambert?THREE.ShaderLib.lambert:THREE.ShaderLib.standard;
    const shader={uniforms:{},vertexShader:lib.vertexShader,fragmentShader:lib.fragmentShader};material.onBeforeCompile(shader,renderer);
    lights.point=Array.from({length:count},()=>({}));lights.pointShadowMap=Array.from({length:prefix},()=>({}));renderer.shadowMap.enabled=shadow;
    const params=programs.getParameters(material,lights,[{}],new THREE.Scene(),mesh);Object.assign(params,shader);
    submitted.length=0;new THREE.TestProgram(renderer,programs.getProgramCacheKey(params),params,{releaseStatesOfProgram(){}});
    material.dispose();mesh.geometry.dispose();return {shader,controller,vertex:submitted[0].text,fragment:submitted[1].text};
  }
  // Restore the original complete raw shader with only the intended local CSE
  // reversed. This also proves spot/directional/daylight and unshadowed identity.
  function inverse(text){return text.replace(
    /\{\nfloat homeShadowTransmission = homePointTransmission\(homePointRooms\[ (i|\d+) \]\);\nif \(homeShadowTransmission != 0.0\) \{([\s\S]*?reflectedLight \);)\n\}\n\}/g,
    (_,index,body)=>`if (homePointTransmission(homePointRooms[ ${index} ]) != 0.0) {${body.replace('directLight.color *= homeShadowTransmission;',
      `directLight.color *= homePointTransmission(homePointRooms[ ${index} ]);`)}\n}`);}
  let expansions=0;
  for(const count of [0,18,72])for(const prefix of count?[0,1,2,8]:[0])for(const lambert of [false,true])for(const shadow of [false,true]) {
    const options={count,prefix,lambert,shadow},a=build(contexts[0],options),b=build(contexts[1],options);
    assert.equal(inverse(b.shader.fragmentShader),a.shader.fragmentShader);
    assert.equal(inverse(b.fragment),a.fragment,'Complete pinned expansion changes only the scoped pure-call reuse');
    assert.equal(b.vertex,a.vertex);assert.deepEqual(Object.keys(b.shader.uniforms),Object.keys(a.shader.uniforms));
    assert.equal(b.controller.geometryUniformVectors,a.controller.geometryUniformVectors);
    assert.equal((b.fragment.match(/float homeShadowTransmission =/g)||[]).length,prefix);
    // Each literal expansion owns a lexical block: no redeclaration is placed
    // in the scope left behind when Three removes the loop's outer braces.
    assert.equal((b.fragment.match(/\{\nfloat homeShadowTransmission = homePointTransmission\(homePointRooms\[ \d+ \]\);/g)||[]).length,prefix);
    expansions++;
  }
  let fallbacks=0;
  for(const options of [{packed:false},{enabled:false},{limit:1},{limit:'1024'}]) {
    const a=build(contexts[0],options),b=build(contexts[1],options);
    assert.equal(a.fragment,b.fragment);assert.equal(a.vertex,b.vertex);assert.doesNotMatch(b.fragment,/homeShadowTransmission/);fallbacks++;
  }
  function prefixBody(text) {
    const start=text.indexOf('for ( int i = 0; i < NUM_POINT_LIGHT_SHADOWS; i ++ )');assert(start>0);
    const open=text.indexOf('{',start);let depth=1,end=open+1;
    for(;depth&&end<text.length;end++){if(text[end]==='{')depth++;else if(text[end]==='}')depth--;}
    assert.equal(depth,0);return text.slice(open+1,end-1);
  }
  const original=build(contexts[0]).shader.fragmentShader,candidate=build(contexts[1]).shader.fragmentShader;
  const bodyA=prefixBody(original),bodyB=prefixBody(candidate);
  assert.equal((bodyA.match(/homePointTransmission\(/g)||[]).length,2);
  assert.equal((bodyB.match(/homePointTransmission\(/g)||[]).length,1);
  function lower(body,shadow) {
    return body.replace(/#if defined\( USE_SHADOWMAP \)[^\n]*\n([\s\S]*?)#endif/g,(_,content)=>shadow?content:'')
      .replace('float homeShadowTransmission','const homeShadowTransmission')
      .replace('directLight.color *= homeShadowTransmission;','directLight.color = scale(directLight.color, homeShadowTransmission);')
      .replace('directLight.color *= homePointTransmission(homePointRooms[ i ]);','directLight.color = scale(directLight.color, homePointTransmission(homePointRooms[ i ]));')
      .replace('directLight.color != vec3(0.0)','directLight.color.some(value => value !== 0)')
      .replace(/directLight.color \*= (.*);/g,'directLight.color = scale(directLight.color, $1);');
  }
  const args=['i','pointLights','homePointRooms','homePointTransmission','getPointLightInfo','pointLightShadows','pointShadowMap',
    'vPointShadowCoord','getPointShadow','receiveShadow','RE_Direct','scale'];
  function run(body,values,visible,color,shadow,receiveShadow,guard=true) {
    const trace=[],calls=[],result=[];
    const record=(name,fn)=>(...xs)=>{trace.push([name,...xs.map(x=>Array.isArray(x)?x.slice():x)]);return fn(...xs);};
    const execute=new Function(...args,'let pointLight,pointLightShadow;const directLight={};const geometryPosition={},geometryNormal={},geometryViewDir={},geometryClearcoatNormal={},material={},reflectedLight={};'+lower(body,shadow));
    if(guard)values.forEach((transmission,i)=>execute(i,values.map((_,id)=>({id})),values.map((_,id)=>id),room=>{calls.push(room);return values[room];},
      (light,position,target)=>{trace.push(['info',light.id]);target.visible=visible;target.color=color.slice();},
      values.map((_,id)=>({shadowMapSize:128,shadowIntensity:1,shadowBias:0,shadowRadius:1,shadowCameraNear:0,shadowCameraFar:10})),values.map((_,id)=>id),values.map((_,id)=>id),
      record('shadow',()=>.5),receiveShadow,(light)=>{trace.push(['direct',...light.color]);result.push(light.color.slice());},
      record('scale',(rgb,scalar)=>rgb.map(value=>value*scalar))));
    return {trace,calls,result};
  }
  let cases=0;
  const values=[0,-0,1,-1,.25,Number.MIN_VALUE,NaN,Infinity,-Infinity];
  for(const prefix of [0,1,2,8])for(const value of values)for(const visible of [false,true])for(const color of [[0,0,0],[1,.5,-1],[NaN,1,0]])for(const shadow of [false,true])for(const receive of [false,true])for(const guard of [false,true]) {
    const transmissions=Array.from({length:prefix},(_,i)=>i%2?1:value);
    const a=run(bodyA,transmissions,visible,color,shadow,receive,guard),b=run(bodyB,transmissions,visible,color,shadow,receive,guard);
    assert.deepEqual(b.trace,a.trace);assert.deepEqual(b.result,a.result);
    assert.deepEqual(b.calls,guard?transmissions.map((_,i)=>i):[]);
    const expected=guard?transmissions.flatMap((v,i)=>v!==0&&visible?[i,i]:[i]):[];
    assert.deepEqual(a.calls,expected,'Only the second pure transmission evaluation is removed');cases++;
  }
  const helper=fragment=>fragment.match(/float homePointTransmission\(int room\) \{[\s\S]*?\n    \}/)[0];
  assert.equal(helper(candidate),helper(original),'Every operation inside the pure helper is unchanged');
  console.log(JSON.stringify({status:'PASS',expansions,fallbacks,operationCases:cases,
    limitation:'Pinned source expansion and JavaScript traces do not compile GLSL or prove CSE/performance.'}));
})().catch(error=>{console.error(String(error.stack).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g,'[pinned Three module]'));process.exitCode=1;});
