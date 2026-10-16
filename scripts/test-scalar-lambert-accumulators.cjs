// Pinned source expansion and operation traces; no actual GPU compilation.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
(async()=>{
  const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'room-lighting.js'),'utf8');
  const vendor=fs.readFileSync(path.join(root,'vendor/three.module.min.js'),'utf8');
  for(const token of ['function bl(t,e,n,i){','function Al(t,e,n,i,r,s,a){'])assert(vendor.includes(token));
  const THREE=await import('data:text/javascript;base64,'+Buffer.from(vendor+'\nexport {bl as TestProgram,Al as TestPrograms};').toString('base64'));
  const api=vm.createContext({Float32Array,Int32Array,Uint16Array,Uint32Array});vm.runInContext(source,api);
  function body(text,marker){let start=text.indexOf(marker);assert(start>=0,marker);start=text.indexOf('{',start)+1;let depth=1,end=start;for(;depth;end++){if(text[end]==='{')depth++;if(text[end]==='}')depth--;}return text.slice(start,end-1);}
  const options={packed:true,pointTexture:true,runTexture:true,geometryTexture:true,signalTexture:true,pointDecayTwo:true,literalLambertPointBody:true,literalLambertDirectional:true,literalLambertShadowPoint:true,literalLambertIndirect:true,directShadowUniforms:true,scalarLambertAccumulators:true,maxFragmentUniforms:2048,maxTextureSize:4096,maxTextures:16};
  const camera=new THREE.PerspectiveCamera();camera.position.set(2,7,12);camera.lookAt(1,0,0);camera.updateMatrixWorld(true);
  function fixture(capacity=18,extra={},type='lambert',category='floors',three=THREE,apiUnderTest=api,beforeAttach=null){
    const rooms=[{id:'a',polygon:[[0,0],[4,0],[4,4],[0,4]]},{id:'b',polygon:[[4,0],[8,0],[8,4],[6,4],[6,2],[4,2]]}];
    const controller=apiUnderTest.createRoomLighting(three,rooms,capacity,[{room:'a',a:[0,1],b:[0,3]}],{...options,...extra});
    let material=new (type==='lambert'?THREE.MeshLambertMaterial:THREE.MeshStandardMaterial)({side:THREE.DoubleSide,transparent:category==='walls',opacity:category==='walls'?.16:1});
    material.clippingPlanes=[new THREE.Plane(new THREE.Vector3(0,-1,0),4)];
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(),material),group=new THREE.Group();mesh.userData.category=category;group.add(mesh);beforeAttach?.(mesh,material);material=mesh.material;controller.attach(group,true,{staticGeometry:true});
    const points=Array.from({length:capacity},(_,i)=>{const light=new THREE.PointLight(new THREE.Color(.2,.4,.6),1,5,2);light.position.set(i*.01,1,2);return{item:{room:i%2?'b':'a'},light};});
    function shader(){const lib=three.ShaderLib[type],s={uniforms:THREE.UniformsUtils.clone(lib.uniforms),vertexShader:lib.vertexShader,fragmentShader:lib.fragmentShader};material.onBeforeCompile(s);return s;}
    return{controller,material,mesh,group,points,shader};
  }
  const submitted=[],gl={VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,createProgram:()=>({}),createShader:type=>({type}),shaderSource(s,text){submitted.push({type:s.type,text});},compileShader(){},attachShader(){},linkProgram(){},bindAttribLocation(){}};
  const renderer={getContext:()=>gl,getRenderTarget:()=>null,outputColorSpace:THREE.SRGBColorSpace,toneMapping:THREE.ACESFilmicToneMapping,shadowMap:{enabled:true,type:THREE.BasicShadowMap},debug:{checkShaderErrors:false}},bindings={releaseStatesOfProgram(){}};
  const programs=new THREE.TestPrograms(renderer,{get:()=>null},{get:()=>null},{has:()=>false},{precision:'highp',getMaxPrecision:x=>x,vertexTextures:true,logarithmicDepthBuffer:false,reverseDepthBuffer:false},bindings,{numPlanes:1,numIntersection:0});
  function expand(f,s,shadows,directional=1,spot=0,rect=0){const lights={directional:Array(directional).fill({}),point:Array(f.points.length).fill({}),spot:Array(spot).fill({}),spotLightMap:[],rectArea:Array(rect).fill({}),hemi:[{}],directionalShadowMap:Array(directional).fill({}),pointShadowMap:Array(shadows).fill({}),spotShadowMap:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};const p=programs.getParameters(f.material,lights,[{}],new THREE.Scene(),f.mesh);p.vertexShader=s.vertexShader;p.fragmentShader=s.fragmentShader;submitted.length=0;new THREE.TestProgram(renderer,programs.getProgramCacheKey(p),p,bindings);return submitted.map(s=>s.text);}
  const tag=':scalar-lambert-accumulators-v1';
  const initial=THREE.ShaderLib.lambert.fragmentShader.match(/ReflectedLight reflectedLight = [^;]+;/)[0];
  const setup=THREE.ShaderChunk.lights_lambert_fragment;
  const gate='#if NUM_SPOT_LIGHTS == 0 && NUM_RECT_AREA_LIGHTS == 0 && !defined(USE_ENVMAP) && !defined(USE_LIGHTMAP) && !defined(USE_AOMAP) && !defined(USE_IRIDESCENCE) && !defined(USE_TRANSMISSION) && !defined(USE_CLEARCOAT) && !defined(USE_SHEEN) && !defined(RE_IndirectSpecular)';
  const aliases={HOME_DIRECT_DIFFUSE:'reflectedLight.directDiffuse',HOME_INDIRECT_DIFFUSE:'reflectedLight.indirectDiffuse',HOME_DIFFUSE_COLOR:'material.diffuseColor'};
  function inverse(actual,expanded=false, directional=1){
    const begin=actual.lastIndexOf('#if ',actual.indexOf('#define HOME_SCALAR_ACCUMULATORS'));
    const end=actual.indexOf('void main() {',begin);assert(begin>=0&&end>begin);
    const controls=actual.slice(begin,end);
    assert(controls.startsWith(expanded?gate.replace('NUM_SPOT_LIGHTS','0').replace('NUM_RECT_AREA_LIGHTS','0'):gate));
    assert.equal((controls.match(/#define HOME_/g)||[]).length,7);
    for(const[name,value]of Object.entries(aliases))assert(controls.includes('#define '+name+' '+value));
    actual=actual.slice(0,begin)+actual.slice(end);
    const declarations='#ifdef HOME_SCALAR_ACCUMULATORS\nvec3 homeDirectDiffuse = vec3( 0.0 );\nvec3 homeIndirectDiffuse = vec3( 0.0 );\n#else\n'+initial+'\n#endif';
    assert.equal(actual.split(declarations).length,2);actual=actual.replace(declarations,initial);
    const material='#ifdef HOME_SCALAR_ACCUMULATORS\nvec3 homeDiffuseColor = diffuseColor.rgb;\n#else\n'+setup+'\n#endif';
    assert.equal(actual.split(material).length,2);actual=expanded?actual.replace('\t'+material,setup):actual.replace(material,'#include <lights_lambert_fragment>');
    for(const[name,value]of Object.entries(aliases))actual=actual.replaceAll(name,value);
    assert(!/\b(?:HOME_SCALAR_ACCUMULATORS|homeDirectDiffuse|homeIndirectDiffuse|homeDiffuseColor)\b/.test(actual));
    return actual;
  }
  function ready(f,shadows=2){f.points.forEach((p,i)=>p.light.castShadow=i<shadows);f.controller.update(f.points,camera);}
  function compare(a,b,active){const x=a.shader(),y=b.shader();assert.equal(a.material.customProgramCacheKey().includes(tag),active);assert.equal(x.vertexShader,y.vertexShader);assert.deepEqual(Object.keys(x.uniforms),Object.keys(y.uniforms));assert.equal(active?inverse(x.fragmentShader):x.fragmentShader,y.fragmentShader);assert.equal(a.material.customProgramCacheKey().replace(tag,''),b.material.customProgramCacheKey());return[x,y];}
  // Small independent preprocessor: evaluate actual emitted #if branches and
  // object aliases. Function-like macros are tracked as defined, never executed.
  function preprocess(source,extra={}){
    const defs=new Map(Object.entries(extra)),stack=[],out=[];let live=true;
    function condition(expression){
      let value=expression.replace(/defined\s*(?:\(\s*(\w+)\s*\)|(\w+))/g,(_,a,b)=>defs.has(a||b)?'1':'0');
      for(let n=0;n<16&&/[A-Za-z_]\w*/.test(value);n++)value=value.replace(/\b[A-Za-z_]\w*\b/g,name=>{const v=defs.get(name);return v===undefined?'0':v===''?'1':'('+v+')';});
      assert(/^[\d\s()+.!<>=&|+*%\/~^?:-]+$/.test(value),'Unsupported condition '+value);return Boolean(Function('return ('+value+');')());
    }
    for(const line of source.split('\n')){
      const directive=/^\s*#(\w+)\b\s*(.*)$/.exec(line);
      if(directive){const[,op,arg]=directive;
        if(['if','ifdef','ifndef'].includes(op)){const test=op==='if'?condition(arg):op==='ifdef'?defs.has(arg.trim()):!defs.has(arg.trim());stack.push({parent:live,selected:test});live=live&&test;}
        else if(op==='elif'){const top=stack.at(-1);assert(top);const test=!top.selected&&condition(arg);top.selected ||= test;live=top.parent&&test;}
        else if(op==='else'){const top=stack.at(-1);assert(top);live=top.parent&&!top.selected;top.selected=true;}
        else if(op==='endif'){assert(stack.length);live=stack.pop().parent;}
        else if(live&&op==='define'){const match=/^(\w+)(.*)$/.exec(arg);assert(match);defs.set(match[1],match[2].startsWith('(')?'1':match[2].trim());}
        else if(live&&op==='undef')defs.delete(arg.trim());
        continue;
      }
      if(live)out.push(line.replace(/\bHOME_(?:DIRECT_DIFFUSE|INDIRECT_DIFFUSE|DIFFUSE_COLOR)\b/g,name=>{assert(defs.has(name));return defs.get(name);}));
    }
    assert.equal(stack.length,0);return out.join('\n');
  }
  const main=s=>s.slice(s.indexOf('void main() {')).replace(/\s+/g,' ').trim();
  function scalarInverse(text){return text.replace('vec3 homeDirectDiffuse = vec3( 0.0 );\nvec3 homeIndirectDiffuse = vec3( 0.0 );',initial).replace('vec3 homeDiffuseColor = diffuseColor.rgb;',setup).replaceAll('homeDirectDiffuse','reflectedLight.directDiffuse').replaceAll('homeIndirectDiffuse','reflectedLight.indirectDiffuse').replaceAll('homeDiffuseColor','material.diffuseColor');}
  let expansions=0,branches=0,fallbacks=0,transitions=0;
  for(const capacity of[18,72])for(const shadows of[0,2,8])for(const decay of[false,true])for(const direct of[false,true])for(const category of['floors','walls'])for(const directional of[0,2,8]){
    const extra={pointDecayTwo:decay,directShadowUniforms:direct},a=fixture(capacity,extra,'lambert',category),b=fixture(capacity,{...extra,scalarLambertAccumulators:false},'lambert',category);ready(a,shadows);ready(b,shadows);
    const[x,y]=compare(a,b,true),xx=expand(a,x,shadows,directional),yy=expand(b,y,shadows,directional);assert.equal(xx[0],yy[0]);const restored=inverse(xx[1],true),mismatch=Array.from(restored).findIndex((c,i)=>c!==yy[1][i]);assert(restored===yy[1],JSON.stringify({mismatch,actual:restored.slice(mismatch-80,mismatch+140),expected:yy[1].slice(mismatch-80,mismatch+140)}));
    const processed=preprocess(xx[1]),reference=preprocess(yy[1]);assert(!/\b(?:material|reflectedLight)\b/.test(main(processed)));assert.equal(main(scalarInverse(processed)),main(reference));
    expansions++;a.controller.dispose();b.controller.dispose();
  }
  for(const feature of['spot','rect','USE_ENVMAP','USE_LIGHTMAP','USE_AOMAP','USE_IRIDESCENCE','USE_TRANSMISSION','USE_CLEARCOAT','USE_SHEEN','RE_IndirectSpecular']){
    const a=fixture(),b=fixture(18,{scalarLambertAccumulators:false});ready(a);ready(b);const[x,y]=compare(a,b,true);
    const xx=expand(a,x,2,1,feature==='spot'?1:0,feature==='rect'?1:0)[1],yy=expand(b,y,2,1,feature==='spot'?1:0,feature==='rect'?1:0)[1];
    const extra=['spot','rect'].includes(feature)?{}:{[feature]:'1'};
    const processed=preprocess(xx,extra);assert(!/\bhome(?:DirectDiffuse|IndirectDiffuse|DiffuseColor)\b/.test(main(processed)));assert.equal(main(processed),main(preprocess(yy,extra)));branches++;a.controller.dispose();b.controller.dispose();
  }
  for(const option of['packed','pointTexture','literalLambertPointBody','literalLambertShadowPoint','literalLambertDirectional','literalLambertIndirect']){
    const extra={[option]:false},a=fixture(18,extra),b=fixture(18,{...extra,scalarLambertAccumulators:false});ready(a);ready(b);compare(a,b,false);a.controller.dispose();b.controller.dispose();fallbacks++;
  }
  for(const value of[undefined,false,0,1,'true']){const a=fixture(18,{scalarLambertAccumulators:value}),b=fixture(18,{scalarLambertAccumulators:false});ready(a);ready(b);compare(a,b,false);a.controller.dispose();b.controller.dispose();fallbacks++;}
  for(const test of[{type:'standard'},{extra:{maxTextures:8}},{extra:{maxFragmentUniforms:0}},{mutate:f=>f.points[0].light.intensity=NaN},{mutate:f=>f.mesh.onBeforeRender=()=>{}},{mutate:f=>f.material.onBeforeRender=()=>{}},{mutate:f=>f.material.onBeforeCompile=()=>{}},{mutate:f=>f.material.customProgramCacheKey=()=>''},{mutate:f=>f.controller.environment(1,[NaN])},{mutate:f=>f.points[0].light.layers.set(1)}]){
    const a=fixture(18,test.extra,test.type),b=fixture(18,{...test.extra,scalarLambertAccumulators:false},test.type);for(const f of[a,b]){test.mutate?.(f);ready(f);}compare(a,b,false);a.controller.dispose();b.controller.dispose();fallbacks++;
  }
  for(const mutate of[(mesh,material)=>material.onBeforeCompile=()=>{},(mesh,material)=>material.customProgramCacheKey=()=>'',mesh=>mesh.onBeforeRender=()=>{}]){
    const a=fixture(18,{},'lambert','floors',THREE,api,mutate),b=fixture(18,{scalarLambertAccumulators:false},'lambert','floors',THREE,api,mutate);ready(a);ready(b);compare(a,b,false);a.controller.dispose();b.controller.dispose();fallbacks++;
  }
  for(const[key,change]of[
    ['lights_fragment_begin',s=>s+'\nfloat other = material.specularStrength;'],
    ['lights_fragment_begin',s=>s+'\nreflectedLight.directSpecular += vec3(1.0);'],
    ['lights_fragment_begin',s=>s+'\n#ifdef USE_ENVMAP\nfloat x=0.0;\n#else\nreflectedLight.directSpecular += vec3(1.0);\n#endif'],
    ['lights_fragment_begin',s=>s+'\n#ifdef USE_ENVMAP\nfloat x=0.0;\n#elif OTHER\nreflectedLight.directSpecular += vec3(1.0);\n#endif'],
    ['lights_lambert_fragment',s=>s+'\nmaterial.diffuseColor*=2.0;'],
    ['lights_lambert_fragment',s=>s.replace('material;','material ;')],
    ['opaque_fragment',s=>s+'\nfloat extra = material.specularStrength;'],
    ['opaque_fragment',s=>s+'\nfloat homeDirectDiffuse = 0.0;'],
    ['lights_fragment_begin',s=>s+'\n#define HOME_DIFFUSE_COLOR bad'],
  ]){
    const value=change(THREE.ShaderChunk[key]);assert.notEqual(value,THREE.ShaderChunk[key]);const three={...THREE,ShaderChunk:{...THREE.ShaderChunk,[key]:value}};
    const a=fixture(18,{},'lambert','floors',three),b=fixture(18,{scalarLambertAccumulators:false},'lambert','floors',three);ready(a);ready(b);compare(a,b,false);a.controller.dispose();b.controller.dispose();fallbacks++;
  }
  for(const replacement of['\nfloat extra = reflectedLight.directDiffuse.x;','\n#define HOME_SCALAR_ACCUMULATORS']){
    const template=THREE.ShaderLib.lambert.fragmentShader.replace('#include <opaque_fragment>','#include <opaque_fragment>'+replacement);
    const three={...THREE,ShaderLib:{...THREE.ShaderLib,lambert:{...THREE.ShaderLib.lambert,fragmentShader:template}}};
    const a=fixture(18,{},'lambert','floors',three),b=fixture(18,{scalarLambertAccumulators:false},'lambert','floors',three);ready(a);ready(b);compare(a,b,false);a.controller.dispose();b.controller.dispose();fallbacks++;
  }
  const a=fixture(),b=fixture(18,{scalarLambertAccumulators:false});compare(a,b,false);transitions++;
  for(const state of['ready','define-collision','define-inherited','define-restored','decay3','invalid-signal','valid-signal','no-camera','ready','editor','home','zero','restored','external-reattach','owned-reattach']){
    for(const f of[a,b]){if(state==='define-collision')f.material.defines={HOME_SCALAR_ACCUMULATORS:1};else if(state==='define-inherited')f.material.defines=Object.create({HOME_SCALAR_ACCUMULATORS:1});else if(state==='define-restored')f.material.defines={};else if(state.endsWith('reattach')){if(state==='external-reattach')f.material.onBeforeCompile=()=>{};f.controller.attach(f.group,true,{staticGeometry:true});}else if(state==='decay3')f.points[0].light.decay=3;else if(state==='invalid-signal')f.controller.environment(.5,[NaN]);else if(state==='valid-signal')f.controller.environment(.5,[1]);else if(state==='editor'||state==='home')f.controller.attach(f.group,state==='home',{staticGeometry:true});else if(state==='zero')f.points.forEach(p=>p.light.visible=false);else if(state==='restored')f.controller.releaseGPU();if(!['invalid-signal','valid-signal'].includes(state))f.controller.update(f.points,state==='no-camera'?null:camera);}
    compare(a,b,!['define-collision','define-inherited','invalid-signal','valid-signal','no-camera','editor','external-reattach','owned-reattach'].includes(state));transitions++;
  }a.controller.dispose();b.controller.dispose();
  // Storage illustration from the proven identical statements: binary32
  // scalar/vec3 operations including NaN, infinities, subnormals and signed zero.
  // This is not execution of candidate GLSL; the full inverse is the source proof.
  const ref=fixture(),changed=fixture(18,{scalarLambertAccumulators:false});ready(ref);ready(changed);const[actual,original]=compare(ref,changed,true);
  const statements=original.fragmentShader.match(/reflectedLight\.(?:directDiffuse|indirectDiffuse) \+= [^;]+;/g);assert.equal(statements.length,4);
  const F=Math.fround,mul=(a,b)=>a.map((x,i)=>F(x*b[i])),add=(a,b)=>a.map((x,i)=>F(x+b[i]));
  const values=[0,-0,1e-45,-1e-45,1,-1,1e20,Infinity,-Infinity,NaN];let traces=0;
  for(const x of values)for(const y of values){
    const color=[F(x),F(y),-0],light=[F(y),F(x),F(1)],emissive=[-0,F(x),F(y)];
    const aggregate={directDiffuse:[0,0,0],indirectDiffuse:[0,0,0]},scalar={direct:[0,0,0],indirect:[0,0,0]};
    for(const statement of statements){assert(/\b\w+ \* BRDF_Lambert\( material.diffuseColor \);$/.test(statement));const direct=statement.includes('.directDiffuse');const contribution=mul(light,color.map(v=>F(v*F(1/Math.PI))));
      aggregate[direct?'directDiffuse':'indirectDiffuse']=add(aggregate[direct?'directDiffuse':'indirectDiffuse'],contribution);
      scalar[direct?'direct':'indirect']=add(scalar[direct?'direct':'indirect'],contribution);
      assert.deepEqual(aggregate.directDiffuse,scalar.direct);assert.deepEqual(aggregate.indirectDiffuse,scalar.indirect);
    }assert.deepEqual(add(add(aggregate.directDiffuse,aggregate.indirectDiffuse),emissive),add(add(scalar.direct,scalar.indirect),emissive));traces++;
  }
  let mutations=0;for(const mutate of[s=>s.replace('homeDirectDiffuse = vec3( 0.0 )','homeDirectDiffuse = vec3( 1.0 )'),s=>s.replace('HOME_DIRECT_DIFFUSE +=','HOME_DIRECT_DIFFUSE -='),s=>s.replace('HOME_DIFFUSE_COLOR','UNKNOWN_COLOR')]){const value=mutate(actual.fragmentShader);assert.notEqual(value,actual.fragmentShader);assert.throws(()=>assert.equal(inverse(value),original.fragmentShader));mutations++;}
  ref.controller.dispose();changed.controller.dispose();
  if(process.env.ACCUMULATORS_BASE_SOURCE){const base=vm.createContext({Float32Array,Int32Array,Uint16Array,Uint32Array});vm.runInContext(fs.readFileSync(process.env.ACCUMULATORS_BASE_SOURCE,'utf8'),base);for(const type of['lambert','standard'])for(const packed of[false,true])for(const active of[false,true]){const extra={scalarLambertAccumulators:undefined,packed};const a=fixture(18,extra,type),b=fixture(18,extra,type,'floors',THREE,base);if(active){ready(a);ready(b);}compare(a,b,false);a.controller.dispose();b.controller.dispose();}}
  console.log(JSON.stringify({status:'PASS',expansions,branches,fallbacks,transitions,storageIllustrations:traces,mutations,scope:'Pinned source/preprocessor and binary32 storage traces only; no GPU compilation or performance claim'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
