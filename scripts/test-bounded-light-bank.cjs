// CPU-only proof of the bounded shader interface and its live Three bindings.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const os=require('node:os'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
(async()=>{
  const vendor=fs.readFileSync(path.join(root,'vendor/three.module.min.js'),'utf8');
  for(const token of ['function Ol(t){const e=new Ul,','class il{constructor(t,e)','function bl(t,e,n,i){','function Al(t,e,n,i,r,s,a){']) assert(vendor.includes(token));
  const THREE=await import('data:text/javascript;base64,'+Buffer.from(vendor+'\nexport {Ol as OracleLights,il as OracleUniforms,bl as TestProgram,Al as TestPrograms};').toString('base64'));
  const source=fs.readFileSync(path.join(root,'room-lighting.js'),'utf8'),viewer=fs.readFileSync(path.join(root,'viewer.js'),'utf8');
  const context=vm.createContext({THREE,Float32Array,Int32Array,Uint16Array,Uint32Array});vm.runInContext(source,context);
  vm.runInContext(viewer.slice(viewer.indexOf('function wallPrism('),viewer.indexOf('const roundedWalls=[];')),context);
  const rooms=Array.from({length:8},(_,i)=>({id:'r'+i,polygon:[[i*10,0],[i*10+4,0],[i*10+4,4],[i*10,4]]}));
  const make=(capacity=64,limit=2048,enabled=true)=>context.createRoomLighting(THREE,rooms,capacity,[],{packed:true,maxFragmentUniforms:limit,boundedLightBank:enabled});
  function box(x=2){const mesh=new THREE.Mesh(new THREE.BoxGeometry(.5,.5,.5),new THREE.MeshLambertMaterial());mesh.position.set(x,1,2);return mesh;}
  function shader(mesh){const shader={uniforms:THREE.UniformsUtils.clone(THREE.ShaderLib.lambert.uniforms),vertexShader:THREE.ShaderLib.lambert.vertexShader,fragmentShader:THREE.ShaderLib.lambert.fragmentShader};mesh.material.onBeforeCompile(shader);return shader;}
  const banked=s=>s.fragmentShader.includes('uniform PointLight homeLocalPointLights');
  const cameraParent=new THREE.Group(),camera=new THREE.PerspectiveCamera(45,1,.1,1000);cameraParent.add(camera);
  const lightParent=new THREE.Group();lightParent.scale.set(-1.2,.8,1.4);lightParent.rotation.set(.2,-.4,.1);
  const points=Array.from({length:64},(_,i)=>{const light=new THREE.PointLight(new THREE.Color(.1+i*.003,.4,.7-i*.002),i%4?i+.5:0,3+i*.4,1+i*.1);light.position.set(i*.7,i%3-1,i*.2);lightParent.add(light);return {light,item:{room:'r'+(i%8)}};});
  function oracle(){lightParent.updateMatrixWorld(true);cameraParent.updateMatrixWorld(true);const lights=points.filter(p=>p.light.visible).map(p=>p.light);const state=new THREE.OracleLights({get(){throw Error('No point-light extensions expected');}});state.setup(lights);state.setupView(lights,camera);return {lights,values:state.state.point};}
  const lighting=make(),building=new THREE.Group(),floor=box(),far=box(72),objects=new THREE.Group(),fallback=box(22),dynamic=box(100);
  fallback.scale.set(-1.2,.8,1.4);fallback.rotation.y=.37;
  floor.material.side=THREE.DoubleSide;floor.material.clippingPlanes=[new THREE.Plane(new THREE.Vector3(0,-1,0),40)];floor.userData.category='floors';
  context.registerFallbackBoxProgram(THREE,fallback,true);building.add(floor,far);objects.add(fallback,dynamic);
  lighting.attach(building,true,{staticGeometry:true});lighting.attach(objects,true);
  const original=make(64,2048,false),originalMesh=box();original.attach(originalMesh,true);const oldShader=shader(originalMesh);
  let visits=0,scenarios=0;
  function execute(s,ref,expectedRooms,shadows){
    s.uniforms.pointLights.value=ref.values;
    const first=s.fragmentShader.indexOf('for ( int homeRun = 0;'),opening=s.fragmentShader.indexOf('{',first);
    let depth=1,end=opening+1;for(;depth;end++){if(s.fragmentShader[end]==='{')depth++;if(s.fragmentShader[end]==='}')depth--;assert(end<s.fragmentShader.length);}
    let control=s.fragmentShader.slice(first,end);
    const bodyStart=control.indexOf('getPointLightInfo( pointLight, geometryPosition, directLight );');
    const direct='if (directLight.visible) RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
    const bodyEnd=control.indexOf(direct,bodyStart)+direct.length;
    const oldStart=oldShader.fragmentShader.indexOf('getPointLightInfo( pointLight, geometryPosition, directLight );',oldShader.fragmentShader.indexOf('for ( int homeRun = 0;'));
    assert.equal(control.slice(bodyStart,bodyEnd),oldShader.fragmentShader.slice(oldStart,oldShader.fragmentShader.indexOf(direct,oldStart)+direct.length),'Direct-light arithmetic is unchanged');
    control=(control.slice(0,bodyStart)+'visit(pointLight,homeRunTransmission);'+control.slice(bodyEnd)).replace(/\b(?:int|float|ivec4)\b/g,'let');
    const run=new Function('homeLightRuns','homeLightRunCount','homeLocalPointLights','homePointTransmission','visit','let pointLight;'+control);
    const data=s.uniforms.homeLightRuns.value,runs=Array.from({length:data.length/4},(_,i)=>({x:data[i*4],y:data[i*4+1],z:data[i*4+2]}));
    for(const zeroRoom of [-1,1,3,8]){
      const actual=[],lookup=room=>room===zeroRoom?0:.25+room*.125;
      run(runs,s.uniforms.homeLightRunCount.value,s.uniforms.homeLocalPointLights.value,lookup,(p,t)=>{actual.push([ref.values.indexOf(p),t]);visits++;});
      const expected=ref.lights.flatMap((light,index)=>{const item=points.find(p=>p.light===light).item,room=Number(item.room.slice(1))+1;return index>=shadows&&expectedRooms.has(room)&&lookup(room)!==0?[[index,lookup(room)]]:[];});
      assert.deepEqual(actual,expected,'Every retained unshadowed light appears once in global order');scenarios++;
    }
  }
  for(const shadows of [0,1,2,5,8])for(const view of [0,1,2])for(const hidden of [false,true]){
    points.forEach((p,i)=>{p.light.castShadow=i<shadows;p.light.visible=!(hidden&&i%4===1);});
    cameraParent.position.set(view*3,-view,view*2);cameraParent.rotation.set(view*.2,-view*.3,.1);camera.position.set(7-view,8+view,20-view);camera.lookAt(2,1,2);
    lightParent.position.set(4+view,-2-view,7+view*.5);
    const ref=oracle(),prefix=ref.lights.filter(p=>p.castShadow).length;lighting.update(points,camera);
    const local=shader(floor),distant=shader(far),owned=shader(fallback);
    assert(banked(local)&&banked(distant)&&banked(owned));assert(!banked(shader(dynamic)));
    assert.equal(local.fragmentShader,owned.fragmentShader,'Fallback and structural objects share one banked family');
    assert.equal(floor.material.customProgramCacheKey(),fallback.material.customProgramCacheKey());
    const prefixStart='#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )';
    const prefixOf=s=>s.slice(s.indexOf(prefixStart),s.indexOf('for ( int homeRun = 0;'));
    assert.equal(prefixOf(local.fragmentShader),prefixOf(oldShader.fragmentShader),'Stock shadow prefix is unchanged');
    execute(local,ref,new Set([1]),prefix);execute(distant,ref,new Set([8]),prefix);execute(owned,ref,new Set([3]),prefix);
  }
  // Real Three uniform upload traverses only active shadow-prefix fields, even
  // though the renderer supplies the original full global light-state array.
  points.forEach((p,i)=>{p.light.visible=true;p.light.castShadow=i<2;});let ref=oracle();lighting.update(points,camera);
  let current=shader(floor);current.uniforms.pointLights.value=ref.values;
  const active=[],writes=[];for(const [name,size]of [['pointLights',2],['homeLocalPointLights',32]])for(let i=0;i<size;i++)for(const [field,type]of [['position',35665],['color',35665],['distance',5126],['decay',5126]])active.push({name:`${name}[${i}].${field}`,size:1,type});
  const gl={ACTIVE_UNIFORMS:35718,getProgramParameter:()=>active.length,getActiveUniform:(_,i)=>active[i],getUniformLocation:(_,name)=>name,uniform3f:(...v)=>writes.push(v),uniform1f:(...v)=>writes.push(v)};
  const uploader=new THREE.OracleUniforms(gl,{});THREE.OracleUniforms.upload(gl,uploader.seq,current.uniforms);
  assert.equal(writes.filter(w=>w[0].startsWith('pointLights')).length,8);
  const selected=current.uniforms.homeLocalPointLights.value;
  for(let i=0;i<32;i++)for(const field of ['position','color','distance','decay']){
    const value=selected[i][field],expected=typeof value==='number'?[value]:value.toArray();
    assert.deepEqual(writes.find(w=>w[0]===`homeLocalPointLights[${i}].${field}`).slice(1).map(Math.fround),expected.map(Math.fround));
  }
  // Expand the actual pinned program: no global 64-slot declaration survives.
  const submitted=[],programGL={VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,createProgram:()=>({}),createShader:type=>({type}),shaderSource(s,t){submitted.push({type:s.type,text:t});},compileShader(){},attachShader(){},linkProgram(){},bindAttribLocation(){}};
  const renderer={getContext:()=>programGL,getRenderTarget:()=>null,outputColorSpace:THREE.SRGBColorSpace,toneMapping:THREE.ACESFilmicToneMapping,shadowMap:{enabled:true,type:THREE.BasicShadowMap},debug:{checkShaderErrors:false}};
  const caps={precision:'highp',getMaxPrecision:x=>x,vertexTextures:true,logarithmicDepthBuffer:false,reverseDepthBuffer:false},bindings={releaseStatesOfProgram(){}};
  const programs=new THREE.TestPrograms(renderer,{get:()=>null},{get:()=>null},{has:()=>false},caps,bindings,{numPlanes:1,numIntersection:0});
  const lights={directional:[{}],point:Array(64).fill({}),spot:[],spotLightMap:[],rectArea:[],hemi:[{}],directionalShadowMap:[{}],pointShadowMap:[{},{}],spotShadowMap:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};
  const params=programs.getParameters(floor.material,lights,[{}],new THREE.Scene(),floor);params.vertexShader=current.vertexShader;params.fragmentShader=current.fragmentShader;
  new THREE.TestProgram(renderer,programs.getProgramCacheKey(params),params,bindings);
  const expanded=submitted.find(s=>s.type===35632).text;
  assert.match(expanded,/uniform PointLight pointLights\[ 2 \]/);assert.match(expanded,/uniform PointLight homeLocalPointLights\[ 32 \]/);
  assert.match(expanded,/uniform int homePointRooms\[2\]/);assert.match(expanded,/uniform ivec4 homeLightRuns\[32\]/);
  assert.doesNotMatch(expanded,/pointLights\[ 64 \]|homeLightRunStarts\[|homeLightRunEnds\[/);
  assert.deepEqual([...expanded.matchAll(/pointLight = pointLights\[\s*(\d+)\s*\]/g)].map(m=>Number(m[1])),[0,1]);
  assert(!expanded.includes('pointLight = pointLights[ i ]'),'No reachable global-index fallback remains');
  // Latest compiled uniforms also work when switching back to a cached bank.
  lighting.update(points);assert(!banked(shader(floor)));assert.equal(current.uniforms.homePointRooms.value.length,64);assert.equal(current.uniforms.homeLightRuns.value.length,256);let latest=shader(floor);
  lighting.update(points,camera);latest.uniforms.pointLights.value=ref.values;execute({...latest,fragmentShader:current.fragmentShader},ref,new Set([1]),2);
  lighting.attach(building,false,{staticGeometry:true});latest=shader(floor);assert(!banked(latest));
  lighting.attach(building,true,{staticGeometry:true});lighting.update(points,camera);latest.uniforms.pointLights.value=ref.values;
  assert.equal(latest.uniforms.homePointRooms.value.length,2);assert.equal(latest.uniforms.homeLightRuns.value.length,128);
  const before=latest.uniforms.homeLocalPointLights.value.slice();ref=oracle();latest.uniforms.pointLights.value=ref.values;
  assert.notEqual(latest.uniforms.homeLocalPointLights.value[0],before[0],'Restoration/recompilation cannot retain old Three light records');
  execute(shader(floor),ref,new Set([1]),2);
  // Shadow-map enablement changes sampling, not the original prefix ordering.
  for(const count of [18,64])for(const shadowCount of [0,1,2,8])for(const enabled of [false,true]){
    renderer.shadowMap.enabled=enabled;lights.point=Array(count).fill({});lights.pointShadowMap=Array(shadowCount).fill({});
    const p=programs.getParameters(floor.material,lights,[{}],new THREE.Scene(),floor),s=shader(floor);
    p.vertexShader=s.vertexShader;p.fragmentShader=s.fragmentShader;submitted.length=0;new THREE.TestProgram(renderer,programs.getProgramCacheKey(p),p,bindings);
    const fragment=submitted.find(value=>value.type===35632).text;
    assert.deepEqual([...fragment.matchAll(/pointLight = pointLights\[\s*(\d+)\s*\]/g)].map(m=>Number(m[1])),Array.from({length:shadowCount},(_,i)=>i));
    assert(fragment.includes(`uniform PointLight pointLights[ ${shadowCount} ];`));
    assert(fragment.includes(`uniform int homePointRooms[${shadowCount}];`));
    assert(fragment.includes('#if '+shadowCount+' > 0'),'Zero-prefix arrays are guarded out before GLSL compilation');
  }
  // Unsupported inputs select the original program, then finite data recovers.
  for(const [target,key,value]of [[points[0].light,'intensity',NaN],[points[0].light,'distance',1e50],[points[0].light,'decay',Infinity],[points[0].light.color,'r',1e50],[lightParent.position,'x',Infinity]]){
    const previous=target[key];target[key]=value;lighting.update(points,camera);assert(!banked(shader(floor)));target[key]=previous;lighting.update(points,camera);assert(banked(shader(floor)));
  }
  const saved=points.map(p=>p.item.room);points[0].item.room='unbound';lighting.update(points,camera);assert(!banked(shader(floor)),'An unknown room conservatively retains the original program');
  points.forEach(p=>p.item.room='r0');lighting.update(points,camera);assert(!banked(shader(floor)),'An oversized selected set uses the original full program');
  points.forEach((p,i)=>p.item.room=saved[i]);lighting.update([...points,{light:new THREE.PointLight(),item:{room:'r0'}}],camera);assert(!banked(shader(floor)));
  lighting.update(points,camera);assert(banked(shader(floor)));
  const packedData=context.packRoomLightingGeometry(rooms,[],64,2048),tight=make(64,packedData.uniformVectors);
  const tightMesh=box();tight.attach(tightMesh,true,{staticGeometry:true});tight.update(points,camera);assert(banked(shader(tightMesh)),'Reduced bank fits the original packed allowance');
  const literal=make(64,packedData.uniformVectors-1),literalMesh=box();literal.attach(literalMesh,true,{staticGeometry:true});literal.update(points,camera);assert.equal(literal.geometryMode,'literal');assert(!banked(shader(literalMesh)));
  const smallData=context.packRoomLightingGeometry(rooms,[],18,2048),small=make(18,smallData.uniformVectors),smallMesh=box();small.attach(smallMesh,true,{staticGeometry:true});small.update(points.slice(0,18),camera);
  assert.equal(small.geometryMode,'packed');assert(!banked(shader(smallMesh)),'An optional bank exceeding its allowance preserves the original packed program');
  // External motion, sharing and mutable/unsupported geometry leave no stale
  // static subset active in either the bank or the original fallback program.
  for(const mutation of ['move','parent','geometry','vertices','share','callback','skin','morph','displacement']){
    const controller=make(),group=new THREE.Group(),mesh=box();context.registerFallbackBoxProgram(THREE,mesh,true);group.add(mesh);controller.attach(group,true);controller.update(points,camera);assert(banked(shader(mesh)));
    if(mutation==='move')mesh.position.x+=10;
    if(mutation==='parent'){const parent=new THREE.Group();group.add(parent);parent.add(mesh);}
    if(mutation==='geometry')mesh.geometry=new THREE.BoxGeometry(1,1,1);
    if(mutation==='vertices')mesh.geometry.attributes.position.needsUpdate=true;
    if(mutation==='share'){const other=box(70);other.material=mesh.material;group.add(other);}
    if(mutation==='callback')mesh.onBeforeRender=()=>{};
    if(mutation==='skin')mesh.isSkinnedMesh=true;
    if(mutation==='morph')mesh.geometry.morphAttributes.position=[mesh.geometry.attributes.position];
    if(mutation==='displacement')mesh.material.displacementMap={};
    controller.update(points,camera);const s=shader(mesh);assert(!banked(s),mutation);assert.equal(s.uniforms.homeLightRunCount.value,64,mutation+' retains every global run');
  }
  const moved=make(),movedMesh=box();moved.attach(movedMesh,true,{staticGeometry:true});moved.update(points,camera);assert(banked(shader(movedMesh)));movedMesh.position.x=72;moved.update(points,camera);assert(!banked(shader(movedMesh)));assert.equal(shader(movedMesh).uniforms.homeLightRunCount.value,64);
  // Build the actual fixture and execute the real rounded-wall geometry code.
  const fixtureSource=fs.readFileSync(path.join(root,'scripts/test-browser-stability.cjs'),'utf8');
  const fixtureContext=vm.createContext({positiveInteger:name=>name.endsWith('ROOMS')?24:3});vm.runInContext(fixtureSource.slice(fixtureSource.indexOf('function fixture()'),fixtureSource.indexOf('function instrumentation()')),fixtureContext);
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'home-light-bank-proof-'));const fixtureCounts=[];let roundedCases=0;
  try{
    for(const roomCount of [6,24]){
    fixtureContext.positiveInteger=name=>name.endsWith('ROOMS')?roomCount:3;
    const input=path.join(temporary,'fixture'+roomCount+'.json'),output=path.join(temporary,'compiled'+roomCount);fs.writeFileSync(input,JSON.stringify(fixtureContext.fixture()));
    const built=spawnSync(process.env.PYTHON||'python3',['scripts/build-planner-project.py','--project',input,'--output',output],{cwd:root,encoding:'utf8'});assert.equal(built.status,0,built.stderr);
    const html=fs.readFileSync(path.join(output,'main/index.html'),'utf8'),model=JSON.parse(html.match(/<script[^>]*id=["']modelData["'][^>]*>([\s\S]*?)<\/script>/)[1]);
    const interpolate=(v,a)=>{let pair=a.slice(0,2);for(let i=0;i<a.length-1;i++){pair=a.slice(i,i+2);if(v<=pair[1][0])break;}return pair[0][1]+(v-pair[0][0])*(pair[1][1]-pair[0][1])/(pair[1][0]-pair[0][0]);};
    const rs=model.rooms.map(r=>({...r,polygon:r.polygon.map(([x,z])=>[interpolate(x,model.calibration.x_anchors),interpolate(z,model.calibration.z_anchors)])}));
    const controller=context.createRoomLighting(THREE,rs,roomCount*3,[],{packed:true,maxFragmentUniforms:1024,boundedLightBank:true}),structure=new THREE.Group(),inventory=new THREE.Group(),rounded=[];
    const axes=context.wallCenterlineAxes(model.meshes,model.openings);
    for(const m of model.meshes){const shape=context.wallPrism(m,axes.get(m.wall_id));const geo=shape?context.wallDisplayGeometry(m,shape,20):new THREE.BufferGeometry();if(!shape)geo.setAttribute('position',new THREE.Float32BufferAttribute(m.vertices.flat(),3));const mesh=new THREE.Mesh(geo,new THREE.MeshLambertMaterial());mesh.userData.category=m.kind;structure.add(mesh);if(shape)rounded.push({mesh,m,shape});}
    const fixturePoints=model.inventory.map((item,i)=>{const d=item.dimensions_m,mesh=new THREE.Mesh(new THREE.BoxGeometry(d.width,d.height,d.depth),new THREE.MeshLambertMaterial());mesh.position.set(item.position_m.x,item.position_m.y+d.height/2,item.position_m.z);context.registerFallbackBoxProgram(THREE,mesh,true);inventory.add(mesh);const light=new THREE.PointLight(0xffffff,0);light.castShadow=i<2;return {item,light};});
    controller.attach(structure,true,{staticGeometry:true});controller.attach(inventory,true);controller.update(fixturePoints,camera);
    const counts={rooms:roomCount,structural:structure.children.length,fallback:inventory.children.length,maxUnshadowed:0};
    for(const mesh of [...structure.children,...inventory.children]){const s=shader(mesh);assert(banked(s),'The offline first frame is already banked before any draw');assert.equal(s.uniforms.homePointLightingRequired.value,false);const data=s.uniforms.homeLightRuns.value,n=s.uniforms.homeLightRunCount.value;counts.maxUnshadowed=Math.max(counts.maxUnshadowed,n?data[(n-1)*4+1]:0);}
    if(roomCount===24)assert.deepEqual(counts,{rooms:24,structural:130,fallback:72,maxUnshadowed:27});
    fixtureCounts.push(counts);fixturePoints.forEach(p=>p.light.intensity=1);controller.update(fixturePoints,camera);
    for(const height of [2.1,1.15,20]){for(const entry of rounded)entry.mesh.geometry=context.wallDisplayGeometry(entry.m,entry.shape,height);controller.update(fixturePoints,camera);for(const {mesh}of rounded){assert(banked(shader(mesh)),'All owned rounded-wall variants fit the original envelope');roundedCases++;}}
    }
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
  const home=fs.readFileSync(path.join(root,'home-view.js'),'utf8');assert(home.includes('boundedLightBank:true'));assert.equal((home.match(/roomLighting(?:\?|)\.update\(points,camera\)/g)||[]).length,2);
  console.log(JSON.stringify({status:'PASS',scenarios,visits,fixtureCounts,roundedCases,oracle:'actual pinned Three records, uploads, expanded shader and compiled fixture'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
