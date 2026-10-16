'use strict';
// Execute the actual controller and readiness call sites without a GL context.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'viewer.js'),'utf8'),home=fs.readFileSync(path.join(root,'home-view.js'),'utf8');
const start=source.indexOf('function createInitialHomePrimer('),end=source.indexOf('\nconst wallSheenMotion=',start);
assert(start>=0&&end>start);
const controllerSource=source.slice(start,end),line=prefix=>{const found=source.split('\n').find(s=>s.startsWith(prefix));assert(found,prefix);return found;};
(async()=>{
 const THREE=await import('data:text/javascript;base64,'+fs.readFileSync(path.join(root,'vendor/three.module.min.js')).toString('base64'));
 const copy=v=>Array.from(v.toArray()),equal=(a,b)=>assert.deepEqual(Array.from(a),Array.from(b));let checks=0;
 // Execute the pinned renderer setters, including the complete null-target path,
 // independently of the controller fixture's state model.
 const vendor=fs.readFileSync(path.join(root,'vendor/three.module.min.js'),'utf8');
 const method=(name,next)=>vendor.slice(vendor.indexOf('this.'+name+'=')+('this.'+name+'=').length,vendor.indexOf(',this.'+next+'=',vendor.indexOf('this.'+name+'=')));
 for(const D of [.5860412396258964,1.25,2]){
  let actualViewport,actualScissor;
  const oracle=vm.createContext({D,R:new THREE.Vector4(),B:new THREE.Vector4(0,0,1080,674),C:new THREE.Vector4(),z:new THREE.Vector4(1,2,300,150),k:false,
   St:{FRAMEBUFFER:1},tt:{viewport(v){actualViewport=copy(v);},scissor(v){actualScissor=copy(v);},setScissorTest(){},bindFramebuffer(){return false;}}});
  vm.runInContext('this.setViewport='+method('setViewport','getScissor')+';this.setScissor='+method('setScissor','getScissorTest')+';this.setRenderTarget='+method('setRenderTarget','readRenderTargetPixels')+';',oracle);
  oracle.setViewport(oracle.B);equal(actualViewport,[0,0,Math.round(1080*D),Math.round(674*D)]);
  oracle.setScissor(oracle.z);equal(actualScissor,copy(oracle.z.clone().multiplyScalar(D).round()));
  oracle.setRenderTarget(null);equal(actualViewport,[0,0,Math.floor(1080*D),Math.floor(674*D)]);equal(actualScissor,copy(oracle.z.clone().multiplyScalar(D).floor()));
 }

 function fixture({ratio=.5860412396258964,width=1080,height=674,floor=false,selected=true,styleValue='',priority=''}={}){
  const tasks=new Map(),errors=[],draws=[],restores=[];let serial=0,requests=0,flushes=0,shadowUpdates=0,needsShadow=true,behavior=null;
  let value=styleValue,rank=priority;
  const style={getPropertyValue:()=>value,getPropertyPriority:()=>rank,setProperty(k,v,p=''){value=v;rank=p;},removeProperty(){value='';rank='';}};
  const logical=new THREE.Vector4(0,0,width,height),current=logical.clone().multiplyScalar(ratio)[floor?'floor':'round'](),scissor=new THREE.Vector4(1,2,300,150);
  let physical=current.clone(),physicalScissor=scissor.clone().multiplyScalar(ratio).floor(),target=null,scissorTest=false,lost=false;
  const gl={SCISSOR_BOX:1,VIEWPORT:2,drawingBufferWidth:Math.floor(width*ratio),drawingBufferHeight:Math.floor(height*ratio),
   getParameter(name){return copy(name===1?physicalScissor:physical);},isContextLost:()=>lost,flush(){flushes++;}};
  const renderer={domElement:{style},getContext:()=>gl,getPixelRatio:()=>ratio,getRenderTarget:()=>target,getScissorTest:()=>scissorTest,
   getViewport:v=>v.copy(logical),getCurrentViewport:v=>v.copy(current),getScissor:v=>v.copy(scissor),
   setRenderTarget(v){restores.push('target');target=v;current.copy(logical).multiplyScalar(ratio).floor();physical.copy(current);physicalScissor.copy(scissor).multiplyScalar(ratio).floor();},
   setViewport(v){restores.push('viewport');logical.copy(v);current.copy(v).multiplyScalar(ratio).round();physical.copy(current);},
   setScissor(...args){restores.push('scissor');args[0]?.isVector4?scissor.copy(args[0]):scissor.set(...args);physicalScissor.copy(scissor).multiplyScalar(ratio).round();},
   setScissorTest(v){restores.push('test');scissorTest=v;},
   state:{scissor(v){restores.push('physicalScissor');physicalScissor.copy(v);}},
   render(scene,camera){
    // The first natural shadow pass restores Three's floor-rounded target state.
    if(needsShadow){shadowUpdates++;needsShadow=false;renderer.setRenderTarget(null);}
    draws.push({scene,camera,state:scene.userData.state,scissor:copy(physicalScissor),viewport:copy(physical),scissorTest,visible:value});
    behavior?.();
   }};
  const scene=new THREE.Scene(),mesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshLambertMaterial());scene.add(mesh);scene.userData.state='off';const camera=new THREE.OrthographicCamera();
  const wallBefore=()=>{},wallAfter=()=>{};mesh.onBeforeShadow=wallBefore;mesh.onAfterShadow=wallAfter;
  const context=vm.createContext({THREE,setTimeout(fn,ms){assert.equal(ms,2500);tasks.set(++serial,fn);return serial;},clearTimeout(id){tasks.delete(id);}});
  vm.runInContext(controllerSource,context);
  const primer=context.createInitialHomePrimer(THREE,renderer,selected,()=>{requests++;},e=>errors.push(e),wallBefore,wallAfter);
  const saved={logical:copy(logical),current:copy(current),scissor:copy(scissor),physical:copy(physical),physicalScissor:copy(physicalScissor),target,test:scissorTest};
  return{THREE,context,renderer,scene,mesh,camera,primer,tasks,draws,errors,restores,gl,saved,style,
   get requests(){return requests;},get flushes(){return flushes;},get shadowUpdates(){return shadowUpdates;},
   setBehavior(fn){behavior=fn;},setLost(){lost=true;},setTarget(v){target=v;},setTest(v){scissorTest=v;},setCurrent(v){current.copy(v);physical.copy(v);},
   tick(){const pending=[...tasks.values()];tasks.clear();for(const fn of pending)fn();},
   verifyRestored(){equal(copy(logical),saved.logical);equal(copy(current),saved.current);equal(copy(scissor),saved.scissor);equal(copy(physical),saved.physical);equal(copy(physicalScissor),saved.physicalScissor);assert.equal(target,saved.target);assert.equal(scissorTest,saved.test);}};
 }
 for(const ratio of [.5,.5860412396258964,1,1.25,1.5,2])for(const floor of [false,true]){
  const f=fixture({ratio,floor});assert.equal(f.primer.beforeDraw(f.scene,f.camera,true),false);f.verifyRestored();assert.equal(f.tasks.size,1);assert.equal(f.flushes,1);
  const d=f.draws[0];equal(d.scissor,[Math.floor(f.gl.drawingBufferWidth/2)-1,Math.floor(f.gl.drawingBufferHeight/2)-1,2,2]);
  equal(d.viewport,[0,0,f.gl.drawingBufferWidth,f.gl.drawingBufferHeight]);assert.equal(d.scissorTest,true);assert.equal(d.visible,'hidden');
  f.scene.userData.state='new-live-state';for(let i=0;i<10;i++)assert.equal(f.primer.beforeDraw(f.scene,f.camera,true),false);
  assert.equal(f.draws.length,1);assert.equal(f.tasks.size,1);f.tick();assert.equal(f.requests,1);assert.equal(f.primer.beforeDraw(f.scene,f.camera,true),true);
  f.renderer.render(f.scene,f.camera);f.primer.completed();assert.equal(f.draws.at(-1).state,'new-live-state');assert.equal(f.style.getPropertyValue(),'');assert.equal(f.shadowUpdates,1);checks++;
 }
 // Actual readiness sites: neither the full Home nor signal-only entry credits the primer.
 const f=fixture(),c=f.context;let phases=0,signalUpdates=0;
 Object.assign(c,{initialHomePrimer:f.primer,renderer:f.renderer,scene:f.scene,camera:f.camera,homeView:{active:true},renderCount:0,renderSuspended:false,renderLost:false,document:{hidden:false},
  renderProfile:{diffuseLighting:true},interactionRenderer:null,interactionPointer:null,createInteractionRenderer:()=>({draw:(scene,camera)=>f.renderer.render(scene,camera)}),
  wallSheenMotion:{beforeRender(){phases++;},afterRender(){phases++;}},active:true,points:[],roomLighting:{geometryMode:'packed',update(){signalUpdates++;}},refreshSignalStatus(){}});
 vm.runInContext(line('function drawScene('),c);
 const homeStatement=home.split('\n').filter(s=>s.trim()==='if(drawScene(camera)!==false)renderCount++;');assert.equal(homeStatement.length,2);
 vm.runInContext(homeStatement[0],c);assert.equal(c.renderCount,0);assert.equal(phases,0);assert.equal(f.draws.length,1);
 const signalStart=home.indexOf('  function drawSignalFrame('),signalEnd=home.indexOf('  function render()',signalStart);vm.runInContext(home.slice(signalStart,signalEnd),c);
 f.scene.userData.state='signal-during-wait';c.drawSignalFrame(true);assert.equal(signalUpdates,1);assert.equal(c.renderCount,0);assert.equal(f.draws.length,1);
 // The delayed full draw must use the current camera and viewport, not captured startup values.
 c.camera=new THREE.OrthographicCamera(-9,9,5,-5);c.camera.position.set(4,7,11);
 const resized=new THREE.Vector4(0,0,800,500);f.renderer.setViewport(resized);
 f.gl.drawingBufferWidth=Math.floor(800*f.renderer.getPixelRatio());f.gl.drawingBufferHeight=Math.floor(500*f.renderer.getPixelRatio());
 f.tick();vm.runInContext(homeStatement[1],c);assert.equal(c.renderCount,1);assert.equal(phases,2);assert.equal(f.draws.at(-1).state,'signal-during-wait');assert.equal(f.style.getPropertyValue(),'');
 assert.strictEqual(f.draws.at(-1).camera,c.camera);equal(f.renderer.getViewport(new THREE.Vector4()).toArray(),resized.toArray());
 equal(f.draws.at(-1).viewport,resized.clone().multiplyScalar(f.renderer.getPixelRatio()).round().toArray());checks++;
 for(const cancel of ['hidden','loss','pagehide','explicit']){
  const f=fixture();f.primer.beforeDraw(f.scene,f.camera,true);const stale=[...f.tasks.values()][0];
  if(cancel==='explicit')f.primer.cancel();else{
   const listeners={};Object.assign(f.context,{initialHomePrimer:f.primer,document:{hidden:true,addEventListener(k,fn){listeners[k]=fn;}},window:{addEventListener(k,fn){listeners[k]=fn;}},
    renderer:{domElement:{addEventListener(k,fn){listeners[k]=fn;}}},renderSuspended:false,renderLost:false,interactionPointer:{},interactionRenderer:null,homeView:null,
    cancelRender(){},releaseStaticGlassPasses(){},disposeStaticGlassPasses(){},observer:{disconnect(){}},renderCount:0,requestRender(){},resize(){}});
   const prefix=cancel==='hidden'?"document.addEventListener('visibilitychange'":cancel==='loss'?"renderer.domElement.addEventListener('webglcontextlost'":"window.addEventListener('pagehide'";
   vm.runInContext(line(prefix),f.context);listeners[cancel==='hidden'?'visibilitychange':cancel==='loss'?'webglcontextlost':'pagehide']({persisted:true,preventDefault(){}});
  }
  assert.equal(f.tasks.size,0);stale();assert.equal(f.requests,0);assert.equal(f.style.getPropertyValue(),'');assert.equal(f.primer.beforeDraw(f.scene,f.camera,true),true);checks++;
 }
 {const f=fixture();f.primer.beforeDraw(f.scene,f.camera,true);assert.equal(f.primer.beforeDraw(f.scene,f.camera,false),true);assert.equal(f.tasks.size,0);assert.equal(f.style.getPropertyValue(),'');assert.equal(f.primer.beforeDraw(f.scene,f.camera,true),true);checks++;}
 for(const mutate of [f=>f.setTarget({}),f=>f.setTest(true),f=>f.setLost(),f=>f.gl.drawingBufferWidth=1,f=>f.setCurrent(new THREE.Vector4(4,4,10,10)),
  f=>f.scene.onBeforeRender=()=>{},f=>f.mesh.onAfterRender=()=>{},f=>f.mesh.onBeforeShadow=()=>{},f=>f.mesh.material.onBeforeRender=()=>{},f=>f.scene.overrideMaterial={},f=>f.mesh.customDepthMaterial={}]){
  const f=fixture();mutate(f);assert.equal(f.primer.beforeDraw(f.scene,f.camera,true),true);assert.equal(f.draws.length,0);assert.equal(f.tasks.size,0);assert.equal(f.style.getPropertyValue(),'');checks++;
 }
 for(const [selected,initialHome]of [[false,true],[true,false],[1,true]]){const f=fixture({selected});assert.equal(f.primer.beforeDraw(f.scene,f.camera,initialHome),true);assert.equal(f.tasks.size,0);checks++;}
 for(const [value,priority]of [['collapse','important'],['hidden',''],['','']]){
  const f=fixture({styleValue:value,priority});f.primer.beforeDraw(f.scene,f.camera,true);f.primer.cancel();assert.equal(f.style.getPropertyValue(),value);assert.equal(f.style.getPropertyPriority(),priority);checks++;
 }
 {const f=fixture();f.primer.beforeDraw(f.scene,f.camera,true);f.style.setProperty('visibility','visible','important');f.primer.cancel();assert.equal(f.style.getPropertyValue(),'visible');assert.equal(f.style.getPropertyPriority(),'important');checks++;}
 {const f=fixture(),original=Error('original draw');f.setBehavior(()=>{throw original;});assert.throws(()=>f.primer.beforeDraw(f.scene,f.camera,true),e=>e===original);f.verifyRestored();assert.equal(f.tasks.size,0);assert.equal(f.style.getPropertyValue(),'');checks++;}
 {const f=fixture(),original=Error('original draw'),restore=Error('restore failed');f.setBehavior(()=>{f.renderer.setRenderTarget=()=>{throw restore;};throw original;});assert.throws(()=>f.primer.beforeDraw(f.scene,f.camera,true),e=>e===original);assert.equal(f.renderer.getScissorTest(),false);assert.equal(f.style.getPropertyValue(),'');assert.equal(f.tasks.size,0);assert(f.restores.includes('physicalScissor'));checks++;}
 {const f=fixture();f.setBehavior(()=>{f.setLost();f.primer.cancel();});assert.equal(f.primer.beforeDraw(f.scene,f.camera,true),false);assert.equal(f.tasks.size,0);assert.equal(f.flushes,0);checks++;}
 // Only the allowed startup machinery and completion guards may differ from the base.
 assert(source.includes('createInitialHomePrimer(THREE,renderer,renderProfile.diffuseLighting,requestRender,report3DError,beginWallShadow,endWallShadow)'));
 assert.equal((controllerSource.match(/setTimeout\(/g)||[]).length,1);assert(!/finish\(|readPixels|WebGLRenderTarget|new THREE\.(?:Material|.*Geometry)|toneMapping\s*=/.test(controllerSource));
 assert(line('function render(){').includes('if(drawScene(camera)!==false)renderCount++'));
 console.log(`PASS ${checks} controller/physical-state/readiness/cancellation cases; exact production call sites, no GL or timing claim.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
