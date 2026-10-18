// Pinned source expansion and operation traces; no actual GPU compilation.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
(async()=>{
  const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'room-lighting.js'),'utf8');
  const vendor=fs.readFileSync(path.join(root,'vendor/three.module.min.js'),'utf8');
  for(const token of ['function bl(t,e,n,i){','function Al(t,e,n,i,r,s,a){'])assert(vendor.includes(token));
  const THREE=await import('data:text/javascript;base64,'+Buffer.from(vendor+'\nexport {bl as TestProgram,Al as TestPrograms};').toString('base64'));
  const api=vm.createContext({Float32Array,Int32Array,Uint16Array,Uint32Array});vm.runInContext(source,api);
  const options={packed:true,pointTexture:true,runTexture:true,geometryTexture:true,signalTexture:true,pointDecayTwo:true,literalLambertPointBody:true,literalLambertDirectional:true,literalLambertShadowPoint:true,literalLambertIndirect:true,directShadowUniforms:true,maxFragmentUniforms:2048,maxTextureSize:4096,maxTextures:16};
  const camera=new THREE.PerspectiveCamera();camera.position.set(2,7,12);camera.lookAt(1,0,0);camera.updateMatrixWorld(true);
  function fixture(capacity=18,extra={},type='lambert',category='floors',three=THREE,apiUnderTest=api,beforeAttach=null){
    const rooms=[{id:'a',polygon:[[0,0],[4,0],[4,4],[0,4]]},{id:'b',polygon:[[4,0],[8,0],[8,4],[6,4],[6,2],[4,2]]}];
    const controller=apiUnderTest.createRoomLighting(three,rooms,capacity,[{room:'a',a:[0,1],b:[0,3]}],{...options,...extra});
    let material=new (type==='lambert'?THREE.MeshLambertMaterial:THREE.MeshStandardMaterial)({side:THREE.DoubleSide,transparent:category==='walls',opacity:category==='walls'?.16:1});
    material.clippingPlanes=[new THREE.Plane(new THREE.Vector3(0,-1,0),4)];
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(),material),group=new THREE.Group();mesh.userData.category=category;group.add(mesh);beforeAttach?.(mesh,material);material=mesh.material;controller.attach(group,true,{staticGeometry:true});
    const points=Array.from({length:capacity},(_,i)=>{const light=new THREE.PointLight(new THREE.Color(.2,.4,.6),1,5,2);light.position.set(i*.01,1,2);return{item:{room:i%2?'b':'a'},light};});
    function shader(){const lib=THREE.ShaderLib[type],s={uniforms:THREE.UniformsUtils.clone(lib.uniforms),vertexShader:lib.vertexShader,fragmentShader:lib.fragmentShader};material.onBeforeCompile(s);return s;}
    return{controller,material,mesh,group,points,shader};
  }
  const tag=':direct-shadow-uniforms-v1';
  const kinds=[['PointLightShadow','pointLightShadow'],['DirectionalLightShadow','directionalLightShadow']];
  // Independent line-wise inverse: permit only exact copy removal and field
  // substitution with the array/index from that original copy. All other bytes
  // must match, including shader helpers, vertex data, samplers and arithmetic.
  function inverse(original,actual,active){
    const before=original.split('\n'),after=actual.split('\n'),indices={};assert.equal(after.length,before.length);
    let declarations=0,copies=0,reads=0;
    const restored=before.map((line,i)=>{
      let expected=line;
      if(active)for(const[type,name]of kinds){
        const declaration=new RegExp('^(\\s*)'+type+' '+name+';$').exec(line);
        const copy=new RegExp('^(\\s*)'+name+' = ('+name+'s\\[([^\\]]+)\\]);$').exec(line);
        if(declaration){expected=declaration[1];declarations++;}
        else if(copy){indices[name]=copy[2];expected=copy[1];copies++;}
        else if(line.includes(name+'.')){
          assert(indices[name],'Field read must follow its original copy');
          expected=expected.replaceAll(name+'.',indices[name]+'.');reads++;
        }
      }
      assert.equal(after[i],expected,'Unexpected shader change on line '+(i+1));
      return line;
    }).join('\n');
    assert.equal(restored,original);if(active)assert.equal(declarations,2);
    return{declarations,copies,reads};
  }
  function ready(f,shadows=2){f.points.forEach((p,i)=>p.light.castShadow=i<shadows);f.controller.update(f.points,camera);}
  function compare(a,b,active){const x=a.shader(),y=b.shader();assert.equal(a.material.customProgramCacheKey().includes(tag),active);assert.equal(x.vertexShader,y.vertexShader);assert.deepEqual(Object.keys(x.uniforms),Object.keys(y.uniforms));inverse(y.fragmentShader,x.fragmentShader,active);assert.equal(a.material.customProgramCacheKey().replace(tag,''),b.material.customProgramCacheKey());return[x,y];}
  const submitted=[],gl={VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,createProgram:()=>({}),createShader:type=>({type}),shaderSource(s,text){submitted.push({type:s.type,text});},compileShader(){},attachShader(){},linkProgram(){},bindAttribLocation(){}};
  const renderer={getContext:()=>gl,getRenderTarget:()=>null,outputColorSpace:THREE.SRGBColorSpace,toneMapping:THREE.ACESFilmicToneMapping,shadowMap:{enabled:true,type:THREE.BasicShadowMap},debug:{checkShaderErrors:false}},bindings={releaseStatesOfProgram(){}};
  const programs=new THREE.TestPrograms(renderer,{get:()=>null},{get:()=>null},{has:()=>false},{precision:'highp',getMaxPrecision:x=>x,vertexTextures:true,logarithmicDepthBuffer:false,reverseDepthBuffer:false},bindings,{numPlanes:1,numIntersection:0});
  function expand(f,s,shadows,directional=1){const lights={directional:Array(directional).fill({}),point:Array(f.points.length).fill({}),spot:[{}],spotLightMap:[],rectArea:[],hemi:[{}],directionalShadowMap:Array(directional).fill({}),pointShadowMap:Array(shadows).fill({}),spotShadowMap:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};const p=programs.getParameters(f.material,lights,[{}],new THREE.Scene(),f.mesh);p.vertexShader=s.vertexShader;p.fragmentShader=s.fragmentShader;submitted.length=0;new THREE.TestProgram(renderer,programs.getProgramCacheKey(p),p,bindings);return submitted.map(s=>s.text);}
  let expansions=0,fallbacks=0,transitions=0;
  for(const capacity of[18,72])for(const shadows of[0,1,2,8])for(const directional of[0,1,2,8])for(const enabled of[false,true])for(const decay of[false,true])for(const scalar of[false,true]){
    renderer.shadowMap.enabled=enabled;
    const extra={pointDecayTwo:decay,literalLambertPointBody:scalar,literalLambertDirectional:scalar,literalLambertShadowPoint:scalar,literalLambertIndirect:scalar};
    const a=fixture(capacity,extra),b=fixture(capacity,{...extra,directShadowUniforms:false});ready(a,shadows);ready(b,shadows);
    const[x,y]=compare(a,b,true),xx=expand(a,x,shadows,directional),yy=expand(b,y,shadows,directional);
    assert.equal(xx[0],yy[0]);const proof=inverse(yy[1],xx[1],true);assert.equal(proof.copies,shadows+directional);
    assert.equal(proof.reads,shadows+directional);assert(!/\b(?:pointLightShadow|directionalLightShadow)\b/.test(xx[1]));
    assert(xx[1].includes('struct PointLightShadow'));assert(xx[1].includes('struct DirectionalLightShadow'));
    expansions++;a.controller.dispose();b.controller.dispose();
  }
  const reject=[{extra:{packed:false}},{extra:{pointTexture:false}},{extra:{maxTextures:8}},{extra:{maxFragmentUniforms:0}},{type:'standard'},{mutate:f=>f.points[0].light.intensity=NaN},{mutate:f=>f.mesh.onBeforeRender=()=>{}},{mutate:f=>f.material.onBeforeRender=()=>{}},{mutate:f=>f.material.onBeforeCompile=()=>{}},{mutate:f=>f.material.customProgramCacheKey=()=>''},{mutate:f=>f.controller.environment(1,[NaN])},{mutate:f=>f.points[0].light.layers.set(1)}];
  for(const test of reject){
    const a=fixture(18,test.extra,test.type),b=fixture(18,{...test.extra,directShadowUniforms:false},test.type);for(const f of[a,b]){test.mutate?.(f);ready(f);}compare(a,b,false);a.controller.dispose();b.controller.dispose();fallbacks++;
  }
  for(const mutate of[(mesh,material)=>material.onBeforeCompile=()=>{},(mesh,material)=>material.customProgramCacheKey=()=>'',mesh=>mesh.onBeforeRender=()=>{}]){
    const a=fixture(18,{},'lambert','floors',THREE,api,mutate),b=fixture(18,{directShadowUniforms:false},'lambert','floors',THREE,api,mutate);ready(a);ready(b);compare(a,b,false);a.controller.dispose();b.controller.dispose();fallbacks++;
  }
  for(const kind of ['wall','glass','spoofed-glass']){
    const prepare=(mesh,material)=>{
      if(kind==='wall'){material.onBeforeCompile=api.applyWallSheen;return;}
      const parent=mesh.parent;mesh.removeFromParent();mesh.userData.category='windows';
      mesh.geometry.clearGroups();mesh.geometry.deleteAttribute('uv');material.transparent=true;material.forceSinglePass=false;material.opacity=.35;
      const passes=api.createStaticGlassPasses(THREE,mesh,true);assert(passes);parent.add(mesh,passes.front);
      if(kind==='spoofed-glass')mesh.material.onBeforeCompile=()=>{};
    };
    const a=fixture(18,{},'lambert','walls',THREE,api,prepare),b=fixture(18,{directShadowUniforms:false},'lambert','walls',THREE,api,prepare);ready(a);ready(b);compare(a,b,kind!=='spoofed-glass');a.controller.dispose();b.controller.dispose();api.disposeStaticGlassPasses();
  }
  for(const[key,change]of[
    ['lights_fragment_begin',s=>s.replace('pointLightShadow = pointLightShadows[ i ];','pointLightShadow  = pointLightShadows[ i ];')],
    ['lights_fragment_begin',s=>s.replace('pointLightShadow.shadowRadius','pointLightShadow.shadowRadius * 2.0')],
    ['lights_fragment_begin',s=>s.replace('directionalLightShadow = directionalLightShadows[ i ];','directionalLightShadow = directionalLightShadows[ i + 1 ];')],
    ['lights_fragment_begin',s=>s.replace('directionalLightShadow.shadowBias','directionalLightShadow.shadowNormalBias')],
    ['lights_fragment_begin',s=>s.replace('pointLightShadow = pointLightShadows[ i ];','pointLightShadow = pointLightShadows[ i ];\npointLightShadow.shadowBias = 0.0;')],
    ['lights_fragment_begin',s=>s.replace('DirectionalLightShadow directionalLightShadow;','DirectionalLightShadow directionalLightShadow;\nfloat other = 0.0;')],
    ['lights_fragment_begin',s=>s+'\nfloat other = pointLightShadow.shadowRadius;'],
    ['lights_fragment_begin',s=>s+'\nfloat other = directionalLightShadow.shadowBias;'],
    ['lights_lambert_pars_fragment',s=>s+'\n#define RE_Direct Other'],
    ['lights_pars_begin',s=>s.replace('light.visible = true;', 'light.visible = false;')],
  ]){
    const value=change(THREE.ShaderChunk[key]);assert.notEqual(value,THREE.ShaderChunk[key]);const three={...THREE,ShaderChunk:{...THREE.ShaderChunk,[key]:value}};
    assert.equal(api.directShadowUniforms(three),null);
    const a=fixture(18,{},'lambert','floors',three),b=fixture(18,{directShadowUniforms:false},'lambert','floors',three);ready(a);ready(b);compare(a,b,false);assert(a.material.customProgramCacheKey().includes(':literal-lambert-indirect-v1'),'Independent indirect rewrite remains selected');a.controller.dispose();b.controller.dispose();fallbacks++;
  }
  for(const value of[undefined,false,0,1,'true']){const a=fixture(18,{directShadowUniforms:value}),b=fixture(18,{directShadowUniforms:false});ready(a);ready(b);compare(a,b,false);a.controller.dispose();b.controller.dispose();fallbacks++;}
  const a=fixture(),b=fixture(18,{directShadowUniforms:false});compare(a,b,false);transitions++;
  for(const state of['ready','decay3','invalid-signal','valid-signal','no-camera','ready','editor','home','zero','restored','external-reattach','owned-reattach']){
    for(const f of[a,b]){if(state.endsWith('reattach')){if(state==='external-reattach')f.material.onBeforeCompile=()=>{};f.controller.attach(f.group,true,{staticGeometry:true});}else if(state==='decay3')f.points[0].light.decay=3;else if(state==='invalid-signal')f.controller.environment(.5,[NaN]);else if(state==='valid-signal')f.controller.environment(.5,[1]);else if(state==='editor'||state==='home')f.controller.attach(f.group,state==='home',{staticGeometry:true});else if(state==='zero')f.points.forEach(p=>p.light.visible=false);else if(state==='restored')f.controller.releaseGPU();if(!['invalid-signal','valid-signal'].includes(state))f.controller.update(f.points,state==='no-camera'?null:camera);}
    compare(a,b,!['invalid-signal','valid-signal','no-camera','editor','external-reattach','owned-reattach'].includes(state));transitions++;
  }
  a.controller.dispose();b.controller.dispose();
  // Shader uniforms are immutable within the invocation. Derive both argument
  // lists from the original/emitted call text, retaining sampler/index/order.
  const reference=fixture(),candidate=fixture(18,{directShadowUniforms:false});ready(reference);ready(candidate);
  const actual=reference.shader().fragmentShader,original=candidate.shader().fragmentShader;
  let negativeControls=0;
  for(const mutate of[
    s=>s.replace('pointLightShadows[ i ].shadowBias','pointLightShadows[ i + 1 ].shadowBias'),
    s=>s.replace('pointShadowMap[ i ]','pointShadowMap[ i + 1 ]'),
    s=>s.replace('directionalLightShadows[ i ].shadowRadius','directionalLightShadows[ i ].shadowIntensity'),
    s=>s.replace('receiveShadow','false'),
    s=>s.replace('irradiance += homeDaylightIrradiance();','irradiance *= homeDaylightIrradiance();')
  ]){const changed=mutate(actual);assert.notEqual(changed,actual);assert.throws(()=>inverse(original,changed,true));negativeControls++;}
  let argumentCases=0;
  const values=[0,-0,1e-45,-1e-45,1,100,-1,Infinity,-Infinity,NaN];
  for(const[type,name]of kinds){
    const call=type==='PointLightShadow'?'getPointShadow':'getShadow';
    const find=s=>s.split('\n').find(line=>line.includes(call+'( ')&&line.includes(name));
    const oldLine=find(original),newLine=find(actual);assert(oldLine&&newLine);
    const args=line=>line.slice(line.indexOf(call+'( ')+call.length+2,line.lastIndexOf(' ) : 1.0;')).split(',').map(x=>x.trim());
    const oldArgs=args(oldLine),newArgs=args(newLine);assert.equal(newArgs.length,oldArgs.length);
    for(let index=0;index<8;index++)for(const value of values){
      const record={shadowMapSize:[Math.fround(value),-0],shadowIntensity:Math.fround(value),shadowBias:-0,shadowRadius:Math.fround(value),shadowCameraNear:Math.fround(value),shadowCameraFar:Math.fround(value),shadowNormalBias:99};
      const array=Array.from({length:8},()=>({...record})),local={...array[index]};
      const evalArg=(arg,copy)=>{const field=arg.match(/\.(\w+)$/)?.[1];if(field)return(copy?local:array[index])[field];return arg.replace(/\[ i \]/g,'[ '+index+' ]');};
      assert.deepEqual(oldArgs.map(x=>evalArg(x,true)),newArgs.map(x=>evalArg(x,false)));argumentCases++;
    }
  }
  reference.controller.dispose();candidate.controller.dispose();
  // Optional freeze proof against an exact independently supplied base source.
  if(process.env.DIRECT_SHADOW_BASE_SOURCE){const base=vm.createContext({Float32Array,Int32Array,Uint16Array,Uint32Array});vm.runInContext(fs.readFileSync(process.env.DIRECT_SHADOW_BASE_SOURCE,'utf8'),base);for(const type of['lambert','standard'])for(const scalar of[false,true])for(const packed of[false,true])for(const active of[false,true]){const extra={directShadowUniforms:undefined,packed,literalLambertPointBody:scalar,literalLambertDirectional:scalar,literalLambertShadowPoint:scalar,literalLambertIndirect:scalar};const a=fixture(18,extra,type),b=fixture(18,extra,type,'floors',THREE,base);if(active){ready(a);ready(b);}compare(a,b,false);a.controller.dispose();b.controller.dispose();}}
  console.log(JSON.stringify({status:'PASS',expansions,fallbacks,transitions,argumentCases,negativeControls,scope:'Pinned CPU expansion and exact uniform argument model only; no GPU compilation, pixel or performance claim'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
