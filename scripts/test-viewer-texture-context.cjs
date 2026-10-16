// Actual pinned WebGLTextures/WebGLProperties managers across context generations.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
(async()=>{
 const vendor=fs.readFileSync(path.join(root,'vendor/three.module.min.js'),'utf8');
 assert(vendor.includes('nt=new Rl,it=new jl(St,$,tt,nt,Q,xt,et)'),'Pinned manager construction');
 const THREE=await import('data:text/javascript;base64,'+Buffer.from(vendor+'\nexport {jl as TestTextures,Rl as TestProperties};').toString('base64'));
 const lines=fs.readFileSync(path.join(root,'viewer.js'),'utf8').split('\n'),helper=lines.find(x=>x.startsWith('function releaseViewerTextureGPU(')),handler=lines.find(x=>x.startsWith("renderer.domElement.addEventListener('webglcontextlost'"));
 assert(helper&&handler.includes('releaseViewerTextureGPU();'));
 function run(fixed){
  let epoch=1,lost=false,serial=0,enumId=20000;const errors=[],created=[],uploads=[];
  const make=kind=>{const value={kind,epoch,id:++serial};created.push(value);return value;};
  const remove=(kind,value)=>{if(value&&!lost&&value.epoch!==epoch)errors.push('stale '+kind);};
  const noop=()=>{};
  const gl=new Proxy({createTexture:()=>make('texture'),createFramebuffer:()=>make('framebuffer'),createRenderbuffer:()=>make('renderbuffer'),deleteTexture:x=>remove('texture',x),deleteFramebuffer:x=>remove('framebuffer',x),deleteRenderbuffer:x=>remove('renderbuffer',x)}, {get(target,key){if(key in target)return target[key];return target[key]=/^[A-Z0-9_]+$/.test(key)?++enumId:noop;}});
  const state=new Proxy({}, {get(target,key){return target[key]??=(key.startsWith('tex')?(...args)=>{uploads.push({epoch,method:key});}:key==='bindFramebuffer'?()=>true:noop);}});
  const extensions={has:()=>false,get:()=>null},capabilities={isWebGL2:true,maxTextures:16,maxTextureSize:4096,maxCubemapSize:4096,maxSamples:4,getMaxAnisotropy:()=>1};
  const utils={convert:value=>value===THREE.RGBAFormat?gl.RGBA:value===THREE.UnsignedByteType?gl.UNSIGNED_BYTE:value};
  let info,properties;
  function managers(){properties=new THREE.TestProperties();info={memory:{textures:0},render:{frame:0}};return new THREE.TestTextures(gl,extensions,state,properties,capabilities,utils,info);}
  let manager=managers();
  const scene=new THREE.Scene(),point=new THREE.PointLight(),sun=new THREE.DirectionalLight();scene.add(point,sun);
  point.visible=false;point.shadow.map=new THREE.WebGLRenderTarget(8,8);sun.shadow.map=new THREE.WebGLRenderTarget(16,16);sun.shadow.mapPass=new THREE.WebGLRenderTarget(16,16);
  // A repeated target reference must not cause duplicate disposal.
  point.shadow.mapPass=sun.shadow.mapPass;
  const targets=new Set([point.shadow.map,sun.shadow.map,sun.shadow.mapPass]);
  const texture=new THREE.Texture({width:2,height:2,complete:true});texture.needsUpdate=true;
  const untouched=new THREE.Texture({width:2,height:2,complete:true});untouched.needsUpdate=true;
  const unrelated=new THREE.Mesh(new THREE.PlaneGeometry(),new THREE.MeshBasicMaterial({map:untouched}));scene.add(unrelated);
  const material=new THREE.MeshBasicMaterial({map:texture}),screen=new THREE.Mesh(new THREE.PlaneGeometry(),material),item=new THREE.Group();item.userData.screen=screen;item.add(screen);scene.add(item);
  const tvEntities={a:'media_player.a',alias:'media_player.a',unloaded:'media_player.b'},objectsById=new Map([['a',item],['alias',item],['unloaded',new THREE.Group()]]),frame={version:7};
  const image=texture.image,source=texture.source,refs=[point.shadow.map,sun.shadow.map,sun.shadow.mapPass],counts=new Map([...targets,texture,untouched].map(x=>[x,0]));
  for(const object of counts.keys())object.addEventListener('dispose',()=>counts.set(object,counts.get(object)+1));
  const listeners={};const c=vm.createContext({scene,tvEntities,objectsById,tvFrames:new Map([['a',frame],['alias',frame]]),Set,Object,renderLost:false,cancelRender(){},releaseViewerGeometryGPU(){},interactionPointer:null,interactionRenderer:null,releaseStaticGlassPasses(){},editorFloorMaterials:null,homeView:null,renderer:{domElement:{addEventListener:(name,fn)=>listeners[name]=fn}}});
  vm.runInContext(helper,c);vm.runInContext(fixed?handler:handler.replace('releaseViewerTextureGPU();',''),c);
  function upload(){for(const target of targets)manager.setupRenderTarget(target);manager.setTexture2D(texture,0);}
  function loss(){lost=true;listeners.webglcontextlost({preventDefault(){}});}
  function restore(){lost=false;epoch++;manager=managers();}
  upload();const initialVersion=texture.version;assert.equal(info.memory.textures,4);
  loss();
  if(fixed){assert.equal(info.memory.textures,0);for(const object of [...targets,texture])assert.equal(counts.get(object),1);assert.equal(texture.version,initialVersion+1);}
  assert.equal(texture.image,image);assert.equal(texture.source,source);assert.equal(frame.version,7);assert.equal(screen.material.map,texture);assert.deepEqual([point.shadow.map,sun.shadow.map,sun.shadow.mapPass],refs);
  restore();upload();
  // Real owner paths after restore: replace a decoded TV frame, rebuild shadows.
  texture.dispose();for(const target of targets)target.dispose();
  if(!fixed){assert(errors.includes('stale texture')&&errors.includes('stale framebuffer')&&errors.includes('stale renderbuffer'));return {errors:errors.length,epochs:epoch};}
  assert.deepEqual(errors,[]);assert.equal(info.memory.textures,0);
  texture.needsUpdate=true;upload();const before=new Map(counts);loss();for(const object of [...targets,texture])assert.equal(counts.get(object),before.get(object)+1);
  restore();upload();texture.dispose();for(const target of targets)target.dispose();assert.deepEqual(errors,[]);assert.equal(info.memory.textures,0);
  assert.equal(counts.get(untouched),0,'Unowned or unuploaded textures are not traversed');assert.equal(texture.image,image);assert.equal(texture.source,source);assert.equal(frame.version,7);assert.equal(material.map,texture);
  assert(created.some(x=>x.epoch===3));for(const n of [1,2,3])assert(uploads.some(x=>x.epoch===n),'Each restored generation uploads pixels again');
  return {errors:errors.length,epochs:epoch,shadowTargets:targets.size,tvMaps:1};
 }
 console.log(JSON.stringify({pinnedThree:THREE.REVISION,negative:run(false),positive:run(true)}));
})().catch(error=>{console.error(error);process.exitCode=1;});
