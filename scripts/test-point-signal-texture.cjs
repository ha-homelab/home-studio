// CPU proof for exact dynamic signals in the existing PointLight texture.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
(async()=>{
  const root=path.resolve(__dirname,'..'),vendor=fs.readFileSync(path.join(root,'vendor/three.module.min.js'),'utf8');
  for(const token of ['function Ol(t){const e=new Ul,','function bl(t,e,n,i){','function Al(t,e,n,i,r,s,a){'])assert(vendor.includes(token));
  const THREE=await import('data:text/javascript;base64,'+Buffer.from(vendor+'\nexport {Ol as OracleLights,bl as TestProgram,Al as TestPrograms};').toString('base64'));
  const context=vm.createContext({Float32Array,Int32Array});vm.runInContext(fs.readFileSync(path.join(root,'room-lighting.js'),'utf8'),context);
  const options={packed:true,pointTexture:true,runTexture:true,geometryTexture:true,signalTexture:true,maxFragmentUniforms:2048,maxTextureSize:4096,maxTextures:16};
  const camera=new THREE.PerspectiveCamera();camera.position.set(2,7,12);camera.lookAt(1,0,0);
  const box=()=>new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshLambertMaterial());
  const compile=m=>{const s={uniforms:THREE.UniformsUtils.clone(THREE.ShaderLib.lambert.uniforms),vertexShader:THREE.ShaderLib.lambert.vertexShader,fragmentShader:THREE.ShaderLib.lambert.fragmentShader};m.material.onBeforeCompile(s);return s;};
  const active=s=>!s.fragmentShader.includes('uniform int homeLitRooms[')&&s.fragmentShader.includes('uniform highp sampler2D homePointTexture;');
  function fixture(roomCount,extra={}){
    const rooms=Array.from({length:roomCount},(_,i)=>({id:'r'+i,polygon:[[i*4,0],[i*4+4,0],[i*4+4,4],[i*4,4]]}));
    const windows=rooms.slice(0,6).reverse().map((r,i)=>({id:'w'+i,room:r.id,a:r.polygon[0],b:r.polygon[1]}));
    const capacity=Math.max(1,roomCount*3),c=context.createRoomLighting(THREE,rooms,capacity,windows,{...options,...extra}),m=box();c.attach(m,true);
    const points=Array.from({length:roomCount*3},(_,i)=>{const light=new THREE.PointLight(new THREE.Color(.2,.4,.6),1,5,2);light.position.set(i*.01,1,2);return {item:{room:'r'+Math.floor(i/3)},light};});
    return {c,m,points,capacity,rooms,windows};
  }
  function records(points){camera.updateMatrixWorld(true);for(const p of points)p.light.updateMatrixWorld(true);const lights=points.filter(p=>p.light.visible).map(p=>p.light),oracle=new THREE.OracleLights({get(){throw Error('Unexpected extension');}});oracle.setup(lights);oracle.setupView(lights,camera);return oracle.state.point;}
  let components=0,programCases=0;
  function check(s,points,capacity){
    s.uniforms.pointLights.value=records(points);const texture=s.uniforms.homePointTexture.value,data=texture.image.data;
    const fields=[s.uniforms.homeLitRooms.value,s.uniforms.homeWindowTransmission.value];
    assert.equal(texture.image.width,capacity*2+fields[0].length+fields[1].length);assert.equal(texture.image.height,1);
    assert.equal(texture.type,THREE.FloatType);assert.equal(texture.internalFormat,'RGBA32F');assert.equal(texture.minFilter,THREE.NearestFilter);assert.equal(texture.magFilter,THREE.NearestFilter);assert.equal(texture.colorSpace,THREE.NoColorSpace);assert.equal(texture.generateMipmaps,false);
    const lights=s.uniforms.pointLights.value.flatMap(r=>[...r.position.toArray(),r.distance,...r.color.toArray(),r.decay]);
    assert.deepEqual(Array.from(data.slice(0,lights.length)),lights.map(Math.fround));assert(data.slice(lights.length,capacity*8).every(v=>v===0));
    let offset=capacity*2;
    for(const field of fields){for(let i=0;i<field.length;i++){assert(Object.is(data[(offset+i)*4],Math.fround(field[i])));assert.deepEqual(Array.from(data.slice((offset+i)*4+1,(offset+i+1)*4)),[0,0,0]);components++;}offset+=field.length;}
    const version=texture.version;assert.equal(s.uniforms.homePointTexture.value,texture);assert.equal(texture.version,version,'Unchanged points/signals never upload again');return texture;
  }
  const submissions=[],gl={VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,createProgram:()=>({}),createShader:type=>({type}),shaderSource(s,text){submissions.push({type:s.type,text});},compileShader(){},attachShader(){},linkProgram(){},bindAttribLocation(){}};
  const renderer={getContext:()=>gl,getRenderTarget:()=>null,outputColorSpace:THREE.SRGBColorSpace,toneMapping:THREE.ACESFilmicToneMapping,shadowMap:{enabled:true,type:THREE.BasicShadowMap},debug:{checkShaderErrors:false}},bindings={releaseStatesOfProgram(){}},caps={precision:'highp',getMaxPrecision:x=>x,vertexTextures:true,logarithmicDepthBuffer:false,reverseDepthBuffer:false};
  const programs=new THREE.TestPrograms(renderer,{get:()=>null},{get:()=>null},{has:()=>false},caps,bindings,{numPlanes:0,numIntersection:0});
  for(const count of [6,24]){
    const f=fixture(count),old=fixture(count,{signalTexture:false});let texture,data;
    assert(!active(compile(f.m)),'Unproved first compile retains original shader');
    for(const shadows of [0,1,2,8])for(const mode of ['off','on','partial']){
      f.points.forEach((p,i)=>{p.light.castShadow=i<shadows;p.light.intensity=mode==='off'?0:mode==='partial'&&i%2?0:1;});
      old.points.forEach((p,i)=>{p.light.castShadow=i<shadows;p.light.intensity=f.points[i].light.intensity;});
      const values=[-0,-1,1e-40,.25,.7,1];for(const c of [f.c,old.c])c.environment(mode==='off'?0:1,values);
      f.c.update(f.points,camera);old.c.update(old.points,camera);const s=compile(f.m),o=compile(old.m);assert(active(s));texture=check(s,f.points,f.capacity);
      if(data)assert.equal(texture.image.data,data);else data=texture.image.data;
      let normalized=s.fragmentShader;
      for(const [name,offset,integer]of [['homeLitRooms',f.capacity*2,true],['homeWindowTransmission',f.capacity*2+count,false]]){
        const declaration=o.fragmentShader.match(new RegExp('uniform (?:int|float) '+name+'\\[\\d+\\];'))[0];
        assert(!normalized.includes(name+'['));
        for(const match of o.fragmentShader.replace(declaration,'').matchAll(new RegExp(name+'\\[([^\\]]+)\\]','g'))){
          const fetch=`texelFetch(homePointTexture,ivec2(${offset}+(${match[1]}),0),0).x`,expression=integer?`int(${fetch})`:fetch;
          assert(normalized.includes(expression));normalized=normalized.replace(expression,match[0]);
        }
      }
      assert.equal(normalized,o.fragmentShader.replace(/uniform (?:int homeLitRooms|float homeWindowTransmission)\[\d+\];/g,''),'Every byte outside two declarations/reads remains unchanged');assert.equal(s.vertexShader,o.vertexShader);
      assert.equal((s.fragmentShader.match(/uniform highp sampler2D /g)||[]).length,3,'No fourth sampler');
      if(mode==='on')for(const enabled of [false,true]){
        renderer.shadowMap.enabled=enabled;const lights={directional:[{}],point:Array(f.capacity).fill({}),spot:[],spotLightMap:[],rectArea:[],hemi:[{}],directionalShadowMap:[{}],pointShadowMap:Array(shadows).fill({}),spotShadowMap:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};
        const params=programs.getParameters(f.m.material,lights,[{}],new THREE.Scene(),f.m);params.vertexShader=s.vertexShader;params.fragmentShader=s.fragmentShader;submissions.length=0;new THREE.TestProgram(renderer,programs.getProgramCacheKey(params),params,bindings);
        const expanded=submissions.find(s=>s.type===35632).text;
        assert(!/home(?:LitRooms|WindowTransmission|LightRuns|RoomBounds)\[/.test(expanded));assert(!expanded.includes(`uniform PointLight pointLights[ ${f.capacity} ];`));assert(!/pointLights\[\s*i/.test(expanded));
        assert.deepEqual([...expanded.matchAll(/pointLight = pointLights\[\s*(\d+)\s*\]/g)].map(m=>+m[1]),Array.from({length:shadows},(_,i)=>i));programCases++;
      }
    }
    let s=compile(f.m),key=f.m.material.customProgramCacheKey();check(s,f.points,f.capacity);const before=s.uniforms.homeWindowTransmission.value.slice(),version=texture.version;
    f.c.environment(.2,[-.75]);assert.equal(f.m.material.customProgramCacheKey(),key);check(s,f.points,f.capacity);assert(texture.version>version);
    const changed=Array.from(s.uniforms.homeWindowTransmission.value).map((v,i)=>Object.is(v,before[i])?null:i).filter(v=>v!==null);assert.equal(changed.length,1,'Partial environment update retains untouched slots');
    const stable=texture.version;f.c.environment(.2,[-.75]);check(s,f.points,f.capacity);assert.equal(texture.version,stable);
    // Invalid environment-only writes select the old program before compilation.
    for(const invalid of [NaN,Infinity,-Infinity,1e50]){
      const materialVersion=f.m.material.version;f.c.environment(1,[invalid]);assert(f.m.material.version>materialVersion);assert(!active(compile(f.m)));f.c.update(f.points,camera);assert(!active(compile(f.m)));
      const cachedFull=compile(f.m);f.c.environment(.5,[-0]);assert(!active(compile(f.m)),'Recovery waits for normal camera/light proof');f.c.update(f.points,camera);assert(active(compile(f.m)));check(cachedFull,f.points,f.capacity);check(s,f.points,f.capacity);
    }
    f.c.attach(f.m,false);const cachedEditor=compile(f.m);assert(!active(cachedEditor));f.c.attach(f.m,true);f.c.update(f.points,camera);f.c.environment(.4,[.875]);check(cachedEditor,f.points,f.capacity);check(s,f.points,f.capacity);
    camera.position.x+=1;f.c.update(f.points,camera);check(s,f.points,f.capacity);assert.equal(texture.image.data,data);
    f.c.update([],camera);s=compile(f.m);assert(active(s));check(s,[],f.capacity);assert(s.uniforms.homeLitRooms.value.every(v=>v===0));
    let disposed=0;texture.addEventListener('dispose',()=>disposed++);const v=texture.version;f.c.releaseGPU();assert.equal(disposed,1);assert.equal(texture.image.data,data);assert.equal(texture.version,v+1);check(s,[],f.capacity);f.c.dispose();f.c.dispose();f.c.releaseGPU();assert.equal(disposed,2);old.c.dispose();
  }
  // No room/window data still has the existing one-slot defaults.
  const empty=fixture(0);empty.c.update([],camera);check(compile(empty.m),[],1);empty.c.dispose();
  // Appended width is checked independently of legacy point/geometry sizing.
  const small=fixture(6,{maxTextureSize:47,runTexture:false,geometryTexture:false});small.c.update(small.points,camera);assert(!active(compile(small.m)));assert(compile(small.m).fragmentShader.includes('pointLight = pointLights[ i ];'));small.c.dispose();
  const exact=fixture(6,{maxTextureSize:48,runTexture:false,geometryTexture:false});exact.c.update(exact.points,camera);assert(active(compile(exact.m)));assert.equal(check(compile(exact.m),exact.points,exact.capacity).image.width,48);exact.c.dispose();
  const signals={homeLitRooms:{value:new Int32Array([0])},homeWindowTransmission:{value:new Float32Array([1])}};
  const helper=context.createPointLightTexture(THREE,1,{uniformVectors:1},{...options,runTexture:false,geometryTexture:false},{value:new Int32Array(1)},null,null,signals),m=box();const state=helper.attach(m,m,true);state.callback=m.material.onBeforeCompile;state.cacheKey=m.material.customProgramCacheKey;helper.update([],camera);assert(state.active);
  signals.homeLitRooms.value[0]=2;helper.signalsChanged();assert(!state.active);helper.update([],camera);assert(!state.active);signals.homeLitRooms.value[0]=1;helper.update([],camera);assert(state.active);signals.homeWindowTransmission.value=new Float32Array(2);helper.signalsChanged();assert(!state.active);helper.dispose();
  assert.equal(context.createPointLightTexture(THREE,32768,{uniformVectors:1},{...options,maxTextureSize:100000,runTexture:false,geometryTexture:false},{value:new Int32Array(1)},null,null,signals),null,'Bound appended CPU allocation');
  const first=fixture(6),second=fixture(24);first.c.update(first.points,camera);second.c.update(second.points,camera);const a=compile(first.m),b=compile(second.m);assert.notEqual(first.m.material.customProgramCacheKey(),second.m.material.customProgramCacheKey());assert.notEqual(a.fragmentShader,b.fragmentShader);assert.notEqual(check(a,first.points,first.capacity),check(b,second.points,second.capacity));first.c.dispose();second.c.dispose();
  const home=fs.readFileSync(path.join(root,'home-view.js'),'utf8');assert(home.includes('geometryTexture:true,signalTexture:true'));assert(home.includes('roomLighting?.dispose();roomLighting=createRoomLighting'));
  console.log(JSON.stringify({status:'PASS',exactSignalComponents:components,pinnedProgramCases:programCases,scope:'CPU only; no GPU compilation, pixels or performance claim'}));
})().catch(e=>{console.error(String(e.stack).replace(/data:text\/javascript;base64,[^\s)]+/g,'[pinned Three]'));process.exitCode=1;});
