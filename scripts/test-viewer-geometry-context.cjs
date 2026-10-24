// Use the actual pinned renderer managers; no browser or GPU is required.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
(async()=>{
  const vendor=fs.readFileSync(path.join(root,'vendor/three.module.min.js'),'utf8');
  for(const name of ['da','Ma','ja'])assert(vendor.includes('function '+name+'('),'Pinned manager alias: '+name);
  const THREE=await import('data:text/javascript;base64,'+Buffer.from(vendor+'\nexport {da as TestAttributes,Ma as TestBindings,ja as TestGeometries};').toString('base64'));
  assert.equal(THREE.REVISION,'169');
  const lines=fs.readFileSync(path.join(root,'viewer.js'),'utf8').split('\n');
  const helper=lines.find(line=>line.startsWith('function releaseViewerGeometryGPU('));
  const handler=lines.find(line=>line.startsWith("renderer.domElement.addEventListener('webglcontextlost'"));
  const restored=lines.find(line=>line.startsWith("renderer.domElement.addEventListener('webglcontextrestored'"));
  assert(helper&&handler&&restored&&handler.includes('releaseViewerGeometryGPU();'));
  // Execute the pinned loss/restore handlers, in their real registration order.
  const lossStart=vendor.indexOf('function Rt('),restoreStart=vendor.indexOf('function Pt(',lossStart),restoreEnd=vendor.indexOf('function Lt(',restoreStart);
  assert(lossStart>0&&restoreStart>lossStart&&restoreEnd>restoreStart);
  const pinnedHandlers=vendor.slice(lossStart,restoreEnd);
  assert(vendor.includes('n.addEventListener("webglcontextlost",Rt,!1),n.addEventListener("webglcontextrestored",Pt,!1)'));
  assert(lines.findIndex(line=>line.includes('new THREE.WebGLRenderer('))<lines.indexOf(handler));
  function run(fixed){
    let epoch=1,lost=false,serial=0,programId=0;const errors=[],deleted=[],created=[],listeners={},order=[];
    const make=kind=>{const value={kind,epoch,id:++serial};created.push(value);return value;};
    const remove=(kind,value)=>{if(!value)return;deleted.push({kind,id:value.id,epoch,lost});if(!lost&&value.epoch!==epoch)errors.push('stale '+kind+' '+value.epoch+' in '+epoch);};
    const gl={MAX_VERTEX_ATTRIBS:1,ARRAY_BUFFER:2,ELEMENT_ARRAY_BUFFER:3,FLOAT:4,HALF_FLOAT:5,UNSIGNED_SHORT:6,SHORT:7,UNSIGNED_INT:8,INT:9,BYTE:10,UNSIGNED_BYTE:11,
      getParameter(name){assert.equal(name,this.MAX_VERTEX_ATTRIBS);return 8;},createBuffer:()=>make('buffer'),deleteBuffer:value=>remove('buffer',value),createVertexArray:()=>make('vao'),deleteVertexArray:value=>remove('vao',value),
      bindBuffer(){},bufferData(){},bufferSubData(){},bindVertexArray(){},enableVertexAttribArray(){},disableVertexAttribArray(){},vertexAttribDivisor(){},vertexAttribPointer(){},vertexAttribIPointer(){}};
    function managers(){const attributes=THREE.TestAttributes(gl),bindings=THREE.TestBindings(gl,attributes),info={memory:{geometries:0}},geometries=THREE.TestGeometries(gl,attributes,info,bindings);return {attributes,bindings,info,geometries,program:{id:++programId,getAttributes:()=>({position:{location:0,locationSize:1}})}};}
    const scene=new THREE.Scene(),hidden=new THREE.Group();hidden.visible=false;scene.add(hidden);
    const material=new THREE.MeshBasicMaterial(),shared=new THREE.BoxGeometry();
    const outlineGroup=new THREE.Group();scene.add(outlineGroup);
    const outlines=Array.from({length:4},()=>new THREE.PlaneGeometry());outlines.forEach(geometry=>outlineGroup.add(new THREE.Mesh(geometry,material)));
    scene.add(new THREE.Mesh(shared,material));hidden.add(new THREE.Mesh(shared,material));
    const ground=new THREE.Mesh(new THREE.PlaneGeometry(),material),grid=new THREE.GridHelper();ground.visible=false;grid.visible=false;scene.add(ground,grid);
    const overlay=new THREE.Mesh(new THREE.PlaneGeometry(),material);hidden.add(overlay);
    const wall=new THREE.Mesh(new THREE.BoxGeometry(),material);scene.add(wall);
    const dormant=new THREE.BoxGeometry(),otherDormant=new THREE.BoxGeometry();
    const roundedWalls=[{mesh:wall,cache:new Map([[1,wall.geometry],[2,dormant],[3,otherDormant]])},{mesh:wall,cache:new Map([[1,wall.geometry]])}];
    const owned=new Set();scene.traverse(object=>{if(object.geometry)owned.add(object.geometry)});for(const entry of roundedWalls)for(const geometry of entry.cache.values())owned.add(geometry);
    const snapshots=new Map([...owned].map(g=>[g,{index:g.index,indexArray:g.index?.array,attributes:{...g.attributes},arrays:Object.fromEntries(Object.entries(g.attributes).map(([k,a])=>[k,a.array])),range:{...g.drawRange}}]));
    const releases=new Map([...owned].map(g=>[g,0]));for(const g of owned)g.addEventListener('dispose',()=>releases.set(g,releases.get(g)+1));
    const external=new THREE.BoxGeometry();let externalDisposes=0;external.addEventListener('dispose',()=>externalDisposes++);
    let manager=managers();
    function upload(g){manager.geometries.get({geometry:g},g);manager.geometries.update(g);manager.bindings.setup({},material,manager.program,g,g.index);const wire=manager.geometries.getWireframeAttribute(g);manager.attributes.update(wire,gl.ELEMENT_ARRAY_BUFFER);manager.bindings.setup({},{wireframe:true},manager.program,g,wire);}
    for(const geometry of owned)upload(geometry);
    const canvas={addEventListener(name,fn){(listeners[name]??=[]).push(fn);}};
    const c=vm.createContext({scene,roundedWalls,Set,reflectionEnvironment:null,contactShading:null,inventoryTextures:{dispose(){},releaseGPU(){},configure(){}},environmentLayer:null,renderLost:false,cancelRender(){order.push('app-lost');},interactionPointer:{},interactionRenderer:null,releaseStaticGlassPasses(){},editorFloorMaterials:null,homeView:null,releaseViewerTextureGPU(){},releaseWallOutlineMaterials(){},renderer:{domElement:canvas},
      S:false,et:{autoReset:true},mt:{enabled:true,autoUpdate:false,needsUpdate:true,type:0},console:{log(message){order.push(message.includes('Lost')?'three-lost':'three-restored');}},
      Tt(){epoch++;manager=managers();order.push('new-managers');},renderCount:0,window:{},invalidateShadows(){order.push('app-restored');},requestRender(){order.push('app-draw-request');}});
    vm.runInContext(pinnedHandlers,c);canvas.addEventListener('webglcontextlost',c.Rt);canvas.addEventListener('webglcontextrestored',c.Pt);
    vm.runInContext(helper,c);vm.runInContext(fixed?handler:handler.replace('releaseViewerGeometryGPU();',''),c);vm.runInContext(restored,c);
    function loss(){lost=true;let prevented=false;const before=order.length;for(const fn of listeners.webglcontextlost)fn({preventDefault(){prevented=true;}});assert(prevented);assert(c.renderLost);assert(c.S);assert.deepEqual(order.slice(before),['three-lost','app-lost']);}
    function restore(){lost=false;const before=order.length;for(const fn of listeners.webglcontextrestored)fn();assert.equal(c.renderLost,false);assert.equal(c.S,false);assert.deepEqual(order.slice(before),['three-restored','new-managers','app-restored','app-draw-request']);}
    loss();
    if(fixed){assert.equal(manager.info.memory.geometries,0);for(const count of releases.values())assert.equal(count,1,'Each owned geometry is released once despite aliases');}
    restore();
    // Reupload the visible/hidden scene, but leave inactive wall cache entries dormant.
    const active=new Set();scene.traverse(object=>{if(object.geometry)active.add(object.geometry)});for(const geometry of active)upload(geometry);
    for(const geometry of outlines)geometry.dispose(); // The real post-restore cutaway disposal.
    dormant.dispose(); // Eviction before it has ever been redrawn in this generation.
    if(fixed)assert.deepEqual(errors,[]);else assert(errors.some(error=>error.startsWith('stale buffer'))&&errors.some(error=>error.startsWith('stale vao')),'Omitting the loss hook must reproduce both old-generation errors');
    if(fixed){
      for(const geometry of outlines)upload(geometry);upload(dormant);
      const before=new Map(releases);loss();for(const [g,count]of releases)assert.equal(count,before.get(g)+1,'Second loss still deduplicates every owned geometry');assert.equal(manager.info.memory.geometries,0);
      restore();for(const geometry of owned)upload(geometry);
      for(const geometry of owned)geometry.dispose();assert.deepEqual(errors,[]);assert.equal(manager.info.memory.geometries,0);
      assert(created.some(x=>x.epoch===1)&&created.some(x=>x.epoch===2)&&created.some(x=>x.epoch===3),'Each restored manager lazily uploads new handles');
      assert.equal(externalDisposes,0,'Never release unrelated geometry');
      for(const [g,before]of snapshots){assert.equal(g.index,before.index);assert.equal(g.index?.array,before.indexArray);assert.deepEqual(g.drawRange,before.range);for(const [key,attribute]of Object.entries(before.attributes)){assert.equal(g.attributes[key],attribute);assert.equal(g.attributes[key].array,before.arrays[key]);}}
    }
    return {errors:errors.length,geometries:owned.size,epochs:epoch};
  }
  const negative=run(false),positive=run(true);assert(negative.errors>0);assert.equal(positive.errors,0);
  console.log(JSON.stringify({pinnedThree:THREE.REVISION,negative,positive,meaning:'actual attributes/geometries/binding managers; hidden, shared and dormant CPU geometry preserved'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
