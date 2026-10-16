// Pinned source expansion and operation traces; no actual GPU compilation.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
(async()=>{
  const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'room-lighting.js'),'utf8');
  const vendor=fs.readFileSync(path.join(root,'vendor/three.module.min.js'),'utf8');
  for(const token of ['function bl(t,e,n,i){','function Al(t,e,n,i,r,s,a){'])assert(vendor.includes(token));
  const THREE=await import('data:text/javascript;base64,'+Buffer.from(vendor+'\nexport {bl as TestProgram,Al as TestPrograms};').toString('base64'));
  const api=vm.createContext({Float32Array,Int32Array,Uint16Array,Uint32Array});vm.runInContext(source,api);
  function body(text,marker){let start=text.indexOf(marker);assert(start>=0,marker);start=text.indexOf('{',start)+1;let depth=1,end=start;for(;depth;end++){if(text[end]==='{')depth++;if(text[end]==='}')depth--;}return text.slice(start,end-1);}
  const options={packed:true,pointTexture:true,runTexture:true,geometryTexture:true,signalTexture:true,pointDecayTwo:true,literalLambertPointBody:true,literalLambertDirectional:true,literalLambertShadowPoint:true,literalLambertIndirect:true,directShadowUniforms:true,scalarLambertAccumulators:true,cachedLambertDiffuse:true,maxFragmentUniforms:2048,maxTextureSize:4096,maxTextures:16};
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
      if(live){let value=line;for(let n=0;n<4;n++)value=value.replace(/\bHOME_(?:DIRECT_DIFFUSE|INDIRECT_DIFFUSE|DIFFUSE_COLOR|CACHED_LAMBERT_DIFFUSE)\b/g,name=>{assert(defs.has(name));return defs.get(name);});out.push(value);}
    }
    assert.equal(stack.length,0);return out.join('\n');
  }
  const tag=':cached-lambert-diffuse-v1',name='HOME_CACHED_LAMBERT_DIFFUSE';
  const aliases='#ifdef HOME_SCALAR_ACCUMULATORS\n#define HOME_CACHED_LAMBERT_DIFFUSE homeCachedLambertDiffuse\n#else\n#define HOME_CACHED_LAMBERT_DIFFUSE BRDF_Lambert( HOME_DIFFUSE_COLOR )\n#endif\n';
  const declaration='vec3 homeCachedLambertDiffuse = BRDF_Lambert( homeDiffuseColor );';
  function inverse(text){
    assert.equal(text.split(aliases).length,2);assert.equal(text.split(declaration).length,2);
    const result=text.replace(aliases,'').replace('\n'+declaration,'').replaceAll(name,'BRDF_Lambert( HOME_DIFFUSE_COLOR )');
    assert(!result.includes('homeCachedLambertDiffuse'));return result;
  }
  function ready(f,shadows=2){f.points.forEach((p,i)=>p.light.castShadow=i<shadows);f.controller.update(f.points,camera);}
  function compare(a,b,selected){
    const x=a.shader(),y=b.shader();
    assert.equal(a.material.customProgramCacheKey().includes(tag),selected);
    assert.equal(a.material.customProgramCacheKey().replace(tag,''),b.material.customProgramCacheKey());
    assert.equal(x.vertexShader,y.vertexShader);assert.deepEqual(Object.keys(x.uniforms),Object.keys(y.uniforms));
    assert.equal(selected?inverse(x.fragmentShader):x.fragmentShader,y.fragmentShader);return[x,y];
  }
  const main=s=>s.slice(s.indexOf('void main() {'));
  function liveInverse(text){return text.replace('\n'+declaration,'').replaceAll('homeCachedLambertDiffuse','BRDF_Lambert( homeDiffuseColor )');}
  let pairs=0,branches=0,fallbacks=0,transitions=0;
  for(const capacity of[18,72])for(const shadows of[0,1,2,8])for(const storage of[false,true])for(const decay of[false,true])for(const editor of[false,true]){
    const extra={pointTexture:storage,pointDecayTwo:decay},a=fixture(capacity,extra),b=fixture(capacity,{...extra,cachedLambertDiffuse:false});
    for(const f of[a,b]){ready(f,shadows);if(editor)f.controller.attach(f.group,false,{staticGeometry:true});}
    const selected=storage&&!editor,[x,y]=compare(a,b,selected);
    const xx=expand(a,x,shadows),yy=expand(b,y,shadows);
    assert.equal(xx[0],yy[0]);assert.equal(selected?inverse(xx[1]):xx[1],yy[1]);
    const actual=main(preprocess(xx[1])),original=main(preprocess(yy[1]));
    assert.equal(selected?liveInverse(actual):actual,original);
    if(selected){
      assert.equal((actual.match(/BRDF_Lambert\(/g)||[]).length,1);
      assert(actual.indexOf(declaration)>actual.indexOf('vec3 homeDiffuseColor = diffuseColor.rgb;'));
      assert.equal((actual.match(/homeDiffuseColor\s*=/g)||[]).length,1);
    }
    pairs++;a.controller.dispose();b.controller.dispose();
  }
  // Compile-time rejected features retain the exact preprocessed original main.
  for(const feature of['spot','rect','USE_ENVMAP','USE_LIGHTMAP','USE_AOMAP','USE_IRIDESCENCE','USE_TRANSMISSION','USE_CLEARCOAT','USE_SHEEN','RE_IndirectSpecular']){
    const a=fixture(),b=fixture(18,{cachedLambertDiffuse:false});ready(a);ready(b);const[x,y]=compare(a,b,true);
    const xx=expand(a,x,2,1,feature==='spot'?1:0,feature==='rect'?1:0)[1],yy=expand(b,y,2,1,feature==='spot'?1:0,feature==='rect'?1:0)[1];
    const extra=['spot','rect'].includes(feature)?{}:{[feature]:'1'};
    assert.equal(main(preprocess(xx,extra)),main(preprocess(yy,extra)));assert(!main(preprocess(xx,extra)).includes('homeCachedLambertDiffuse'));branches++;
    a.controller.dispose();b.controller.dispose();
  }
  for(const directional of[0,2,8])for(const category of['floors','walls']){
    const a=fixture(18,{},'lambert',category),b=fixture(18,{cachedLambertDiffuse:false},'lambert',category);ready(a);ready(b);
    const[x,y]=compare(a,b,true),xx=expand(a,x,2,directional),yy=expand(b,y,2,directional);
    assert.equal(inverse(xx[1]),yy[1]);assert.equal(liveInverse(main(preprocess(xx[1]))),main(preprocess(yy[1])));
    a.controller.dispose();b.controller.dispose();pairs++;
  }
  for(const option of['packed','pointTexture','scalarLambertAccumulators','literalLambertPointBody','literalLambertShadowPoint','literalLambertDirectional','literalLambertIndirect']){
    const extra={[option]:false},a=fixture(18,extra),b=fixture(18,{...extra,cachedLambertDiffuse:false});ready(a);ready(b);compare(a,b,false);a.controller.dispose();b.controller.dispose();fallbacks++;
  }
  for(const value of[undefined,false,0,1,'true']){
    const a=fixture(18,{cachedLambertDiffuse:value}),b=fixture(18,{cachedLambertDiffuse:false});ready(a);ready(b);compare(a,b,false);a.controller.dispose();b.controller.dispose();fallbacks++;
  }
  for(const test of[{type:'standard'},{extra:{maxTextures:8}},{extra:{maxFragmentUniforms:0}},{mutate:f=>f.points[0].light.intensity=NaN},{mutate:f=>f.mesh.onBeforeRender=()=>{}},{mutate:f=>f.material.onBeforeRender=()=>{}},{mutate:f=>f.material.onBeforeCompile=()=>{}},{mutate:f=>f.material.customProgramCacheKey=()=>''},{mutate:f=>f.controller.environment(1,[NaN])}]){
    const a=fixture(18,test.extra,test.type),b=fixture(18,{...test.extra,cachedLambertDiffuse:false},test.type);
    for(const f of[a,b]){test.mutate?.(f);ready(f);}compare(a,b,false);a.controller.dispose();b.controller.dispose();fallbacks++;
  }
  const helper='vec3 BRDF_Lambert( const in vec3 diffuseColor ) {\n\treturn RECIPROCAL_PI * diffuseColor;\n}';
  assert.equal(THREE.ShaderChunk.common.split(helper).length,2);
  for(const[key,change]of[
    ['common',s=>s.replace('return RECIPROCAL_PI * diffuseColor;','return diffuseColor / PI;')],
    ['common',s=>s.replace(helper,helper+'\n'+helper)],
    ['common',s=>s.replace('RECIPROCAL_PI 0.3183098861837907','RECIPROCAL_PI 0.3')],
    ['common',s=>s+'\n#define BRDF_Lambert(x) (x)'],
    ['common',s=>s+'\n#undef RECIPROCAL_PI\n#define RECIPROCAL_PI 1.0'],
    ['common',s=>s+'\n#define HOME_CACHED_LAMBERT_DIFFUSE other'],
    ['opaque_fragment',s=>s+'\nfloat homeCachedLambertDiffuse = 0.0;'],
    ['lights_lambert_fragment',s=>s+'\nmaterial.diffuseColor *= 2.0;'],
    ['lights_fragment_begin',s=>s+'\nmaterial.diffuseColor = vec3(1.0);']
  ]){
    const value=change(THREE.ShaderChunk[key]);assert.notEqual(value,THREE.ShaderChunk[key]);const three={...THREE,ShaderChunk:{...THREE.ShaderChunk,[key]:value}};
    const a=fixture(18,{},'lambert','floors',three),b=fixture(18,{cachedLambertDiffuse:false},'lambert','floors',three);ready(a);ready(b);compare(a,b,false);a.controller.dispose();b.controller.dispose();fallbacks++;
  }
  // Source and definitions can change after controller construction; only the
  // cache is rejected, retaining the independently selected scalar baseline.
  const three={...THREE,ShaderChunk:{...THREE.ShaderChunk},ShaderLib:{...THREE.ShaderLib,lambert:{...THREE.ShaderLib.lambert}}};
  const a=fixture(18,{},'lambert','floors',three),b=fixture(18,{cachedLambertDiffuse:false},'lambert','floors',three);
  compare(a,b,false);transitions++;
  for(const state of['ready','own-define','inherited-define','brdf-define','constant-define','clear-defines','common-change','common-restore','chunk-change','chunk-restore','template-change','template-restore','decay3','invalid-signal','valid-signal','update','no-camera','update','editor','home','zero','restored','external-reattach','owned-reattach']){
    for(const f of[a,b]){
      if(state==='own-define')f.material.defines={HOME_CACHED_LAMBERT_DIFFUSE:1};
      else if(state==='inherited-define')f.material.defines=Object.create({homeCachedLambertDiffuse:1});
      else if(state==='brdf-define')f.material.defines=Object.create({BRDF_Lambert:'different'});
      else if(state==='constant-define')f.material.defines={RECIPROCAL_PI:1};
      else if(state==='clear-defines')f.material.defines={};
      else if(state==='common-change')three.ShaderChunk.common=THREE.ShaderChunk.common+'\n// changed externally';
      else if(state==='common-restore')three.ShaderChunk.common=THREE.ShaderChunk.common;
      else if(state==='chunk-change')three.ShaderChunk.opaque_fragment=THREE.ShaderChunk.opaque_fragment+'\n// changed externally';
      else if(state==='chunk-restore')three.ShaderChunk.opaque_fragment=THREE.ShaderChunk.opaque_fragment;
      else if(state==='template-change')three.ShaderLib.lambert.fragmentShader=THREE.ShaderLib.lambert.fragmentShader+'\n// changed externally';
      else if(state==='template-restore')three.ShaderLib.lambert.fragmentShader=THREE.ShaderLib.lambert.fragmentShader;
      else if(state==='decay3')f.points[0].light.decay=3;
      else if(state==='invalid-signal')f.controller.environment(.5,[NaN]);
      else if(state==='valid-signal')f.controller.environment(.5,[1]);
      else if(state==='editor'||state==='home')f.controller.attach(f.group,state==='home',{staticGeometry:true});
      else if(state==='zero')f.points.forEach(p=>p.light.visible=false);
      else if(state==='restored')f.controller.releaseGPU();
      else if(state.endsWith('reattach')){if(state==='external-reattach')f.material.onBeforeCompile=()=>{};f.controller.attach(f.group,true,{staticGeometry:true});}
      if(!['invalid-signal','valid-signal'].includes(state))f.controller.update(f.points,state==='no-camera'?null:camera);
    }
    const off=['own-define','inherited-define','brdf-define','constant-define','common-change','chunk-change','template-change','invalid-signal','valid-signal','no-camera','editor','external-reattach','owned-reattach'].includes(state);
    compare(a,b,!off);transitions++;
  }
  a.controller.dispose();b.controller.dispose();
  // Pinned helper arithmetic and actual four source statements, evaluated with
  // binary32 operations. This is not execution of the driver/compiler GLSL.
  const f=fixture(),g=fixture(18,{cachedLambertDiffuse:false});ready(f);ready(g);const[x,y]=compare(f,g,true);
  const statements=y.fragmentShader.match(/HOME_(?:DIRECT|INDIRECT)_DIFFUSE \+= [^;]+;/g);assert.equal(statements.length,4);
  assert(statements.every(s=>/\w+ \* BRDF_Lambert\( HOME_DIFFUSE_COLOR \);$/.test(s)));
  const F=Math.fround,constant=F(Number(THREE.ShaderChunk.common.match(/#define RECIPROCAL_PI ([^\n]+)/)[1]));
  const mul=(a,b)=>a.map((v,i)=>F(v*b[i])),add=(a,b)=>a.map((v,i)=>F(v+b[i]));
  const values=[0,-0,1e-45,-1e-45,1,-1,1e20,Infinity,-Infinity,NaN];let traces=0;
  for(const c of values)for(const light of values){
    const color=[F(c),F(light),-0],irradiance=[F(light),-0,F(c)];let calls=0;
    const brdf=value=>{calls++;return value.map(v=>F(constant*v));};
    const cached=brdf(color),expected={direct:[0,0,0],indirect:[0,0,0]},actual={direct:[0,0,0],indirect:[0,0,0]};
    for(const statement of statements){const field=statement.includes('DIRECT_DIFFUSE')&&!statement.includes('INDIRECT_DIFFUSE')?'direct':'indirect';
      expected[field]=add(expected[field],mul(irradiance,brdf(color)));actual[field]=add(actual[field],mul(irradiance,cached));
      assert.deepEqual(actual,expected);
    }assert.equal(calls,5);assert.deepEqual(add(actual.direct,actual.indirect),add(expected.direct,expected.indirect));traces++;
  }
  let mutations=0;for(const change of[s=>s.replace(declaration,declaration.replace('homeDiffuseColor','homeDiffuseColor.bgr')),s=>s.replace('HOME_DIRECT_DIFFUSE +=','HOME_DIRECT_DIFFUSE -='),s=>s.replace('#define HOME_CACHED_LAMBERT_DIFFUSE homeCachedLambertDiffuse','#define HOME_CACHED_LAMBERT_DIFFUSE other')]){
    const text=change(x.fragmentShader);assert.notEqual(text,x.fragmentShader);assert.throws(()=>assert.equal(inverse(text),y.fragmentShader));mutations++;
  }
  f.controller.dispose();g.controller.dispose();
  if(process.env.CACHED_LAMBERT_BASE_SOURCE){
    const prior=vm.createContext({Float32Array,Int32Array,Uint16Array,Uint32Array});vm.runInContext(fs.readFileSync(process.env.CACHED_LAMBERT_BASE_SOURCE,'utf8'),prior);
    for(const type of['lambert','standard'])for(const packed of[false,true])for(const enabled of[false,true]){
      const extra={cachedLambertDiffuse:undefined,packed},a=fixture(18,extra,type),b=fixture(18,extra,type,'floors',THREE,prior);if(enabled){ready(a);ready(b);}compare(a,b,false);a.controller.dispose();b.controller.dispose();
    }
  }
  console.log(JSON.stringify({status:'PASS',pairs,branches,fallbacks,transitions,storageTraces:traces,mutations,scope:'Pinned source/preprocessor and binary32 arithmetic only; no GPU or performance proof'}));
})().catch(error=>{console.error(String(error.stack).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g,'[pinned Three]'));process.exitCode=1;});
