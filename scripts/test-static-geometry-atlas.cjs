// Exact geometry transport proof; uses the pinned shader builder without a GPU.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
(async()=>{
  const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'room-lighting.js'),'utf8');
  const vendor=fs.readFileSync(path.join(root,'vendor/three.module.min.js'),'utf8');
  assert(vendor.includes('function bl(t,e,n,i){'));assert(vendor.includes('function Al(t,e,n,i,r,s,a){'));
  const THREE=await import('data:text/javascript;base64,'+Buffer.from(vendor+'\nexport {bl as TestProgram,Al as TestPrograms};').toString('base64'));
  const context=vm.createContext({Float32Array,Int32Array});vm.runInContext(source,context);
  const options={packed:true,pointTexture:true,runTexture:true,geometryTexture:true,maxFragmentUniforms:2048,maxTextureSize:4096,maxTextures:16};
  const fields=[['homeRoomEdges',4,false],['homeRoomRanges',4,true],['homeRoomBounds',4,false],['homeRoomExterior',1,true],['homeWindowSegments',4,false],['homeWindowRooms',1,true]];
  const rectangles=Array.from({length:24},(_,i)=>({id:'r'+i,polygon:[[i*4,0],[i*4+4,0],[i*4+4,4],[i*4,4]]}));
  const polygons=[{id:'r0',exterior:true,polygon:[[-3.123456,-2],[-1,-3.7654321],[1,-2],[0,0],[-1,-1]]},{id:'r1',polygon:[[2,0],[3,1],[2,2],[1,1]]}];
  const windows=rooms=>rooms.slice(0,6).map((r,i)=>({id:'w'+i,room:r.id,a:r.polygon[0],b:r.polygon[1]}));
  const mesh=()=>new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshLambertMaterial());
  const compile=m=>{const s={uniforms:THREE.UniformsUtils.clone(THREE.ShaderLib.lambert.uniforms),vertexShader:THREE.ShaderLib.lambert.vertexShader,fragmentShader:THREE.ShaderLib.lambert.fragmentShader};m.material.onBeforeCompile(s);return s;};
  const camera=new THREE.PerspectiveCamera();camera.position.set(2,8,14);camera.lookAt(1,0,0);
  const hasAtlas=s=>s.fragmentShader.includes('uniform highp sampler2D homeGeometryTexture;');
  const submissions=[],gl={VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,createProgram:()=>({}),createShader:type=>({type}),shaderSource(s,text){submissions.push({type:s.type,text});},compileShader(){},attachShader(){},linkProgram(){},bindAttribLocation(){}};
  const renderer={getContext:()=>gl,getRenderTarget:()=>null,outputColorSpace:THREE.SRGBColorSpace,toneMapping:THREE.ACESFilmicToneMapping,shadowMap:{enabled:true,type:THREE.BasicShadowMap},debug:{checkShaderErrors:false}},bindings={releaseStatesOfProgram(){}},caps={precision:'highp',getMaxPrecision:x=>x,vertexTextures:true,logarithmicDepthBuffer:false,reverseDepthBuffer:false};
  const programs=new THREE.TestPrograms(renderer,{get:()=>null},{get:()=>null},{has:()=>false},caps,bindings,{numPlanes:0,numIntersection:0});
  let valuesChecked=0,programCases=0;
  for(const rooms of [rectangles,polygons])for(const openings of [[],windows(rooms)]){
    const count=rooms.length*3,packed=context.packRoomLightingGeometry(rooms,openings,count,2048);
    const c=context.createRoomLighting(THREE,rooms,count,openings,options),old=context.createRoomLighting(THREE,rooms,count,openings,{...options,geometryTexture:false});
    const m=mesh(),n=mesh();c.attach(m,true);old.attach(n,true);
    const points=Array.from({length:count},(_,i)=>({item:{room:rooms[Math.floor(i/3)].id},light:new THREE.PointLight(0xffffff,1,5,2)}));
    let texture,firstData,firstVersion;
    for(const shadows of [0,1,2])for(const state of ['on','off','day']){
      points.forEach((p,i)=>{p.light.castShadow=i<shadows;p.light.intensity=state==='off'?0:1;});
      camera.position.x+=.01;c.environment(state==='day'?1:0,openings.map(()=>.25));old.environment(state==='day'?1:0,openings.map(()=>.25));c.update(points,camera);old.update(points,camera);
      const s=compile(m),o=compile(n);assert(hasAtlas(s));texture=s.uniforms.homeGeometryTexture.value;
      assert.equal(texture.type,THREE.FloatType);assert.equal(texture.internalFormat,'RGBA32F');assert.equal(texture.minFilter,THREE.NearestFilter);assert.equal(texture.magFilter,THREE.NearestFilter);assert.equal(texture.generateMipmaps,false);assert.equal(texture.colorSpace,THREE.NoColorSpace);assert.equal(texture.flipY,false);assert.equal(texture.image.height,1);
      let offset=0,normalized=s.fragmentShader.replace('uniform highp sampler2D homeGeometryTexture;\n','');
      for(const [name,components,integer] of fields){
        const input=packed.uniforms[name].value;
        for(let i=0;i<input.length;i++){
          const actual=texture.image.data[(offset+Math.floor(i/components))*4+i%components];
          assert(Object.is(actual,Math.fround(input[i])));if(integer)assert.equal(Math.trunc(actual),input[i]);valuesChecked++;
        }
        const declaration=o.fragmentShader.match(new RegExp('uniform (?:vec4|ivec4|int) '+name+'\\[\\d+\\];'))[0];
        assert(!s.fragmentShader.includes(name+'['));
        // Independently reverse each concrete lookup present in the original,
        // then compare every remaining byte of the fragment and vertex source.
        for(const match of o.fragmentShader.replace(declaration,'').matchAll(new RegExp(name+'\\[([^\\]]+)\\]','g'))){
          const fetch=`texelFetch(homeGeometryTexture,ivec2(${offset}+(${match[1]}),0),0)`;
          const expression=integer?(components===1?`int(${fetch}.x)`:`ivec4(${fetch})`):fetch;
          assert(normalized.includes(expression));normalized=normalized.replace(expression,match[0]);
        }
        offset+=input.length/components;
      }
      const stripDeclarations=text=>{for(const [name] of fields)text=text.replace(new RegExp('uniform (?:vec4|ivec4|int) '+name+'\\[\\d+\\];'),'');return text;};
      assert.equal(normalized,stripDeclarations(o.fragmentShader),'Only typed record lookups and declarations change');assert.equal(s.vertexShader,o.vertexShader);
      assert.equal(texture.image.width,offset);
      assert(s.fragmentShader.includes('uniform int homeLitRooms['));assert(s.fragmentShader.includes('uniform float homeWindowTransmission['));
      if(firstData){assert.equal(texture.image.data,firstData);assert.equal(texture.version,firstVersion,'State/camera changes never reallocate or upload immutable geometry');}else{firstData=texture.image.data;firstVersion=texture.version;}
      if(state==='on'){
        const lights={directional:[{}],point:Array(count).fill({}),spot:[],spotLightMap:[],rectArea:[],hemi:[{}],directionalShadowMap:[{}],pointShadowMap:Array(shadows).fill({}),spotShadowMap:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};
        const params=programs.getParameters(m.material,lights,[{}],new THREE.Scene(),m);params.vertexShader=s.vertexShader;params.fragmentShader=s.fragmentShader;submissions.length=0;new THREE.TestProgram(renderer,programs.getProgramCacheKey(params),params,bindings);
        const expanded=submissions.find(x=>x.type===35632).text;for(const [name] of fields)assert(!expanded.includes(name+'['));assert(!expanded.includes('homeLightRuns['));assert(!expanded.includes(`uniform PointLight pointLights[ ${count} ];`));programCases++;
      }
    }
    // Cached full and editor maps keep the same immutable texture binding.
    c.update(points);const full=compile(m);assert(!hasAtlas(full));assert(full.fragmentShader.includes('uniform vec4 homeRoomBounds['));assert.equal(full.uniforms.homeGeometryTexture.value,texture);
    c.attach(m,false);const editor=compile(m);assert(!hasAtlas(editor));c.attach(m,true);c.update(points,camera);assert.equal(editor.uniforms.homeGeometryTexture.value,texture);
    const data=texture.image.data,version=texture.version;let disposals=0;texture.addEventListener('dispose',()=>disposals++);c.releaseGPU();assert.equal(texture.image.data,data);assert.equal(texture.version,version+1);c.update(points,camera);assert.equal(compile(m).uniforms.homeGeometryTexture.value,texture);c.dispose();c.dispose();c.releaseGPU();assert.equal(disposals,2);old.dispose();
  }
  const packed=context.packRoomLightingGeometry(rectangles,windows(rectangles),72,2048);
  for(const opts of [{maxTextureSize:179},{maxTextures:15},{maxFragmentUniforms:packed.uniformVectors+3}]){
    const c=context.createRoomLighting(THREE,rectangles,72,windows(rectangles),{...options,...opts}),m=mesh();c.attach(m,true);c.update([{item:{room:'r0'},light:new THREE.PointLight()}],camera);const s=compile(m);assert(!hasAtlas(s));assert(s.fragmentShader.includes('pointLight = pointLights[ i ];'));assert(s.fragmentShader.includes('uniform ivec4 homeLightRuns[72];'));c.dispose();
  }
  for(const [name,index,value]of [['homeRoomBounds',0,Infinity],['homeRoomEdges',0,NaN],['homeRoomRanges',0,16777217],['homeRoomExterior',0,.5],['homeWindowRooms',0,-16777217]]){
    const original=packed.uniforms[name].value;packed.uniforms[name].value=Array.from(original);packed.uniforms[name].value[index]=value;assert.equal(context.createRoomGeometryTexture(THREE,packed,options),null);packed.uniforms[name].value=original;
  }
  // Exact negative range sentinels and IEEE signed zero survive transport.
  const original=packed.uniforms.homeRoomBounds.value;original[0]=-0;const atlas=context.createRoomGeometryTexture(THREE,packed,options);assert(Object.is(atlas.texture.image.data[atlas.offsets.homeRoomBounds*4],-0));assert(packed.uniforms.homeRoomRanges.value[1]<0);assert.equal(atlas.texture.image.data[atlas.offsets.homeRoomRanges*4+1],packed.uniforms.homeRoomRanges.value[1]);atlas.dispose();
  const home=fs.readFileSync(path.join(root,'home-view.js'),'utf8');assert(home.includes('runTexture:true,geometryTexture:true'));assert(home.includes('roomLighting?.dispose();roomLighting=createRoomLighting'));
  console.log(JSON.stringify({status:'PASS',exactGeometryComponents:valuesChecked,pinnedProgramCases:programCases,scope:'CPU only; no driver performance or pixel claim'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
