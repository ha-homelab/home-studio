// CPU-only ownership and pinned material/program lifecycle proof.
// This does not establish browser rendering, visual quality, or performance.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
(async()=>{
  const rootPath=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(rootPath,'viewer.js'),'utf8'),homeSource=fs.readFileSync(path.join(rootPath,'home-view.js'),'utf8');
  const vendor=fs.readFileSync(path.join(rootPath,'vendor/three.module.min.js'),'utf8');
  const THREE=await import('data:text/javascript;base64,'+Buffer.from(vendor+'\nexport {Al as TestPrograms};').toString('base64'));
  assert.equal(THREE.REVISION,'169');
  function extractFunction(text,name){const start=text.indexOf('function '+name+'(');assert(start>=0,name);let end=text.indexOf('}',start);for(;end>=0;end=text.indexOf('}',end+1)){const part=text.slice(start,end+1);try{new vm.Script(part);return part;}catch{}}throw Error('Unclosed '+name);}
  const helper=extractFunction(source,'createEditorFloorMaterials');
  // Execute the actual initial construction, before setActive runs in a
  // standalone Editor. Only backdrop visibility may differ between profiles.
  const initialGround=source.split('\n').find(line=>line.startsWith('ground=new THREE.Mesh('));
  assert(initialGround,'Initial standalone ground construction is present');
  for(const diffuseLighting of [false,true]) {
    const scene=new THREE.Scene(),material=new THREE.MeshLambertMaterial(),
      c=vm.createContext({THREE,scene,planRadius:40,planCenter:[7,9],renderProfile:{diffuseLighting},createSceneMaterial:()=>material});
    vm.runInContext(initialGround,c);
    assert.equal(c.ground.visible,!diffuseLighting);
    assert.equal(c.grid.visible,true);assert(scene.children.includes(c.ground)&&scene.children.includes(c.grid));
    assert.equal(c.ground.material,material);assert.equal(c.ground.receiveShadow,true);
    assert.deepEqual(c.ground.position.toArray(),[7,-1.97,9]);
    assert.equal(c.ground.rotation.x,-Math.PI/2);
    assert.equal(c.ground.geometry.parameters.width,80);assert.equal(c.ground.geometry.parameters.height,80);
    if(diffuseLighting){const legacy=initialGround.replace('ground.visible=!renderProfile.diffuseLighting;','');assert.notEqual(legacy,initialGround);vm.runInContext(legacy,c);assert.equal(c.ground.visible,true,'Negative control exposes the old standalone backdrop');}
  }
  const context=vm.createContext({});vm.runInContext(helper,context);
  const make=(r,g,profile={diffuseLighting:true})=>context.createEditorFloorMaterials(THREE,r,g,profile);
  function material(extra={}){const m=new THREE.MeshLambertMaterial({color:0xa4bbcd,side:THREE.DoubleSide,opacity:1,transparent:false,depthWrite:true,...extra});m.clippingPlanes=[new THREE.Plane(new THREE.Vector3(0,-1,0),1.15)];return m;}
  function mesh(m=material(),category='floors'){const x=new THREE.Mesh(new THREE.BoxGeometry(),m);x.userData.category=category;x.receiveShadow=true;x.castShadow=true;return x;}
  function fixture(){const root=new THREE.Group(),floor=mesh(),ground=mesh(material({color:0xdfe3d8}),'ground');root.add(floor);return{root,floor,ground,original:floor.material,groundOriginal:ground.material};}
  let roundtrips=0,fallbacks=0,lifecycle=0;
  {
    const f=fixture(),geometry=f.floor.geometry,matrix=f.floor.matrix,controller=make(f.root,f.ground),original=f.original;
    assert.equal(f.floor.material,original,'Creation does not replace the Home material');
    controller.setHomeActive(true);assert.equal(f.floor.material,original);
    controller.setHomeActive(false);const flat=f.floor.material,flatGround=f.ground.material;
    assert(flat.isMeshBasicMaterial&&flatGround.isMeshBasicMaterial);assert.notEqual(flat,original);
    for(const [a,b]of[[flat,original],[flatGround,f.groundOriginal]]){assert.equal(a.color.getHex(),b.color.getHex());for(const k of['opacity','transparent','side','depthTest','depthWrite','colorWrite','blending','polygonOffset','polygonOffsetFactor','polygonOffsetUnits'])assert.equal(a[k],b[k],k);assert.deepEqual(a.clippingPlanes,b.clippingPlanes);}
    const fixedProps={geometry:f.floor.geometry,matrix:f.floor.matrix,cast:f.floor.castShadow,receive:f.floor.receiveShadow};
    for(let i=0;i<24;i++){controller.setHomeActive(true);assert.equal(f.floor.material,original);assert.equal(f.ground.material,f.groundOriginal);controller.setHomeActive(false);assert.equal(f.floor.material,flat);assert.equal(f.ground.material,flatGround);roundtrips++;}
    assert.equal(f.floor.geometry,geometry);assert.equal(f.floor.matrix,matrix);assert.deepEqual({geometry:f.floor.geometry,matrix:f.floor.matrix,cast:f.floor.castShadow,receive:f.floor.receiveShadow},fixedProps);
    original.color.setHex(0x193c75);original.clippingPlanes[0].constant=20;controller.setHomeActive(true);controller.setHomeActive(false);assert.equal(f.floor.material.color.getHex(),original.color.getHex(),'Current supported material edits remain visible');assert.equal(f.floor.material.clippingPlanes[0].constant,20);
    const replacement=material({color:0xff2233});f.floor.material=replacement;controller.setHomeActive(true);assert.equal(f.floor.material,replacement,'Never overwrite an externally replaced material');controller.setHomeActive(false);assert.equal(f.floor.material,replacement);
    controller.dispose();assert.equal(f.floor.material,replacement);assert.equal(f.ground.material,f.groundOriginal);controller.dispose();lifecycle++;
  }
  for(const profile of[{diffuseLighting:false},{}]){const f=fixture(),c=make(f.root,f.ground,profile);c.setHomeActive(false);assert.equal(f.floor.material,f.original);assert.equal(f.ground.material,f.groundOriginal);c.releaseGPU();c.dispose();fallbacks++;}
  const cases=[()=>mesh(new THREE.MeshStandardMaterial()),()=>mesh(new THREE.MeshBasicMaterial()),()=>mesh(material({transparent:true,opacity:.5})),()=>mesh(material({map:new THREE.Texture()})),()=>mesh(material({alphaMap:new THREE.Texture()})),()=>mesh(material({envMap:new THREE.Texture()})),()=>mesh(material({lightMap:new THREE.Texture()})),()=>mesh(material({aoMap:new THREE.Texture()})),()=>mesh([material(),material()]),()=>mesh(material(),'walls'),()=>{const x=mesh();x.material.onBeforeCompile=()=>{};return x;},()=>{const x=mesh();x.material.customProgramCacheKey=()=> 'external';return x;},()=>{const x=mesh();x.onBeforeRender=()=>{};return x;},()=>{const x=mesh();x.onAfterRender=()=>{};return x;}];
  for(const makeMesh of cases){const root=new THREE.Group(),m=makeMesh();root.add(m);const before=m.material,c=make(root,null);c.setHomeActive(false);assert.equal(m.material,before,'Unsupported initial material is unchanged');c.setHomeActive(true);c.releaseGPU();c.dispose();assert.equal(m.material,before);fallbacks++;}
  for(const mutate of[m=>m.map=new THREE.Texture(),m=>{m.transparent=true;m.opacity=.4;},m=>m.onBeforeCompile=()=>{},m=>m.onBeforeRender=()=>{},m=>m.customProgramCacheKey=()=> 'external']){const f=fixture(),c=make(f.root,f.ground);c.setHomeActive(false);c.setHomeActive(true);mutate(f.original);c.setHomeActive(false);assert.equal(f.floor.material,f.original,'Newly unsupported original falls back');c.dispose();fallbacks++;}
  // Exercise the real Home room-lighting attachment: it changes the owned
  // compile/key identities and opaque blending to NoBlending. The swap must
  // still select Basic and never transfer those callbacks to the Basic clone.
  {
    const roomContext=vm.createContext({Float32Array,Int32Array,Uint16Array,Uint32Array});vm.runInContext(fs.readFileSync(path.join(rootPath,'room-lighting.js'),'utf8'),roomContext);
    const f=fixture(),controller=make(f.root,f.ground),objectGroup=new THREE.Group();
    const options={packed:true,pointTexture:true,runTexture:true,geometryTexture:true,signalTexture:true,pointDecayTwo:true,literalLambertDirectional:true,literalLambertPointBody:true,literalLambertShadowPoint:true,literalLambertIndirect:true,directShadowUniforms:true,scalarLambertAccumulators:true,maxFragmentUniforms:2048,maxTextureSize:4096,maxTextures:16};
    const room=roomContext.createRoomLighting(THREE,[{id:'a',polygon:[[0,0],[4,0],[4,4],[0,4]]}],2,[],options);
    const camera=new THREE.PerspectiveCamera();camera.position.set(2,7,12);camera.lookAt(1,0,0);camera.updateMatrixWorld(true);
    const points=Array.from({length:2},(_,i)=>{const light=new THREE.PointLight(0xffffff,1,5,2);light.position.set(i,1,2);light.castShadow=true;return{item:{room:'a'},light};});
    let updates=0;const update=room.update.bind(room);room.update=(...args)=>{updates++;return update(...args);};
    const c=vm.createContext({active:true,editorFloorMaterials:controller,roomLighting:room,root:f.root,objectGroup,camera,points,renderer:{},refreshSignalStatus(){},drawScene(){},renderCount:0});
    vm.runInContext(extractFunction(homeSource,'attachRoomLighting')+'\n'+extractFunction(homeSource,'drawSignalFrame')+'\n'+extractFunction(homeSource,'render'),c);
    assert.equal((homeSource.match(/roomLighting\??\.update\(points,camera\)/g)||[]).length,2,'Both update callsites are tested behind their real Home guards');
    function attach(active){c.active=active;controller.setHomeActive(active);c.attachRoomLighting();const before=updates;c.drawSignalFrame(true);if(!active){c.render();assert.equal(updates,before,'Editor cannot retire dormant Home material states');}else assert.equal(updates,before+1);}
    function shader(){const lib=THREE.ShaderLib.lambert,s={uniforms:THREE.UniformsUtils.clone(lib.uniforms),vertexShader:lib.vertexShader,fragmentShader:lib.fragmentShader};f.original.onBeforeCompile(s);return{vertex:s.vertexShader,fragment:s.fragmentShader,key:f.original.customProgramCacheKey(),uniformNames:Object.keys(s.uniforms)};}
    attach(true);assert.equal(f.floor.material,f.original);assert.equal(f.original.blending,THREE.NoBlending);const first=shader(),geometry=f.floor.geometry;
    for(let n=0;n<8;n++){attach(false);assert(f.floor.material.isMeshBasicMaterial,'Actual Home NoBlending floor still selects Basic');assert.equal(f.floor.material.onBeforeCompile,THREE.Material.prototype.onBeforeCompile);assert.equal(f.floor.material.customProgramCacheKey,THREE.Material.prototype.customProgramCacheKey);assert.equal(f.floor.material.onBeforeRender,THREE.Material.prototype.onBeforeRender);assert.equal(f.floor.onBeforeRender,THREE.Object3D.prototype.onBeforeRender);attach(true);assert.equal(f.floor.material,f.original);assert.deepEqual(shader(),first,'Original Home source/key restored exactly');assert.equal(f.floor.geometry,geometry);roundtrips++;}
    // Both actual attach callers must pass through the ownership boundary.
    const matches=homeSource.match(/attachRoomLighting\(\);/g)||[];assert.equal(matches.length,2);
    f.original.onBeforeCompile=()=>{};attach(true);attach(false);assert.equal(f.floor.material,f.original,'External callback remains ineligible after owned attachment replaces it');
    room.releaseGPU();controller.releaseGPU();attach(true);attach(false);assert.equal(f.floor.material,f.original,'Context release cannot clear sticky external ownership');room.dispose();controller.dispose();lifecycle++;
  }
  // Pinned Three material-dispose callback and program manager. Fake GL tracks
  // context generations, so forgotten dormant callbacks produce stale deletes.
  const disposeHandler=extractFunction(vendor,'Ft');assert(disposeHandler.includes('ct.releaseProgram')&&disposeHandler.includes('nt.remove'));
  function gpuCase(release){
    let epoch=1,lost=false,serial=0;const errors=[],created=[],deleted=[];
    const gl={VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,createShader:type=>({type}),shaderSource(){},compileShader(){},attachShader(){},linkProgram(){},bindAttribLocation(){},createProgram(){const p={id:++serial,epoch};created.push(p);return p;},deleteProgram(p){deleted.push(p);if(!lost&&p.epoch!==epoch)errors.push('stale program '+p.id);}};
    const renderer={getContext:()=>gl,getRenderTarget:()=>null,outputColorSpace:THREE.SRGBColorSpace,toneMapping:THREE.ACESFilmicToneMapping,shadowMap:{enabled:false,type:THREE.BasicShadowMap},debug:{checkShaderErrors:false}};
    const lights={directional:[],point:[],spot:[],spotLightMap:[],rectArea:[],hemi:[],directionalShadowMap:[],pointShadowMap:[],spotShadowMap:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};
    function manager(){const ct=new THREE.TestPrograms(renderer,{get:()=>null},{get:()=>null},{has:()=>false},{precision:'highp',getMaxPrecision:x=>x,vertexTextures:true,logarithmicDepthBuffer:false,reverseDepthBuffer:false},{releaseStatesOfProgram(){}},{numPlanes:1,numIntersection:0});const entries=new Map(),nt={get(m){if(!entries.has(m))entries.set(m,{});return entries.get(m);},remove(m){entries.delete(m);}};const c=vm.createContext({ct,nt});vm.runInContext(disposeHandler,c);return{ct,nt,handler:c.Ft};}
    let m=manager();const f=fixture(),controller=make(f.root,f.ground),materials=new Set([f.original,f.groundOriginal]);
    function upload(object){const mat=object.material,props=m.nt.get(mat);if(!props.programs){props.programs=new Map();mat.addEventListener('dispose',m.handler);}const p=m.ct.getParameters(mat,lights,[],new THREE.Scene(),object);const shader={uniforms:{},vertexShader:p.vertexShader,fragmentShader:p.fragmentShader};mat.onBeforeCompile(shader,renderer);p.vertexShader=shader.vertexShader;p.fragmentShader=shader.fragmentShader;const key=m.ct.getProgramCacheKey(p);if(!props.programs.has(key))props.programs.set(key,m.ct.acquireProgram(p,key));materials.add(mat);}
    upload(f.floor);upload(f.ground);controller.setHomeActive(false);const flat=f.floor.material;upload(f.floor);upload(f.ground);const first=m;
    lost=true;if(release)controller.releaseGPU();if(release)assert.equal(first.ct.programs.length,0,'Both active Basic and dormant Lambert programs released');epoch++;lost=false;m=manager();
    upload(f.floor);upload(f.ground);controller.setHomeActive(true);assert.equal(f.floor.material,f.original);upload(f.floor);upload(f.ground);controller.setHomeActive(false);assert.equal(f.floor.material,flat,'Same CPU Basic identity after restore');
    if(release){controller.setHomeActive(true);lost=true;controller.releaseGPU();assert.equal(m.ct.programs.length,0,'Home-active loss also releases dormant Basic');epoch++;lost=false;m=manager();upload(f.floor);controller.setHomeActive(false);upload(f.floor);}
    controller.dispose();for(const mat of materials)mat.dispose();assert.equal(m.ct.programs.length,0,'No live program after final owned disposal');
    assert.equal(deleted.length,created.length,'Every created program released exactly once');assert.equal(new Set(deleted).size,created.length);if(release)assert.deepEqual(errors,[]);else assert(errors.length>0,'Negative omission must expose stale pre-loss program listeners');return{epochs:epoch,created:created.length,deleted:deleted.length,staleErrors:errors.length};
  }
  const negative=gpuCase(false),positive=gpuCase(true);lifecycle+=2;
  // Keep mode wiring before the existing lighting attachment and lifecycle
  // paths visible in the production source, not just the helper model.
  const setActive=extractFunction(homeSource,'setActive'),call=setActive.indexOf('.setHomeActive('),attach=setActive.indexOf('attachRoomLighting()');assert(call>=0&&attach>call,'Restore Home originals before room lighting attaches');
  const loss=source.split('\n').find(line=>line.startsWith("renderer.domElement.addEventListener('webglcontextlost'"));assert(loss&&loss.includes('.releaseGPU('),'The loss path releases inactive cached materials');
  const pagehide=source.split('\n').find(line=>line.startsWith("window.addEventListener('pagehide'"));assert(pagehide&&pagehide.includes('.dispose('));
  console.log(JSON.stringify({status:'PASS',roundtrips,fallbacks,lifecycle,negative,positive,scope:'CPU identity/ownership and actual pinned Three material/program release; no real browser or visual/performance proof'}));
})().catch(error=>{console.error(String(error.message).slice(0,1800));process.exitCode=1;});
