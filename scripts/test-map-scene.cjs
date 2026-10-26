'use strict';
// Local synthetic map tiles; these checks never contact a map provider or HA.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),os=require('node:os'),http=require('node:http');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHklEQVR4nGO4dP3Cf3yYAUTM3jETjtH5VFIwwG4AAJrHyi0UM1mUAAAAAElFTkSuQmCC';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
// Observe the actual desired set in test copies only; production stats include
// healthy cached textures outside the viewport and cannot express readiness.
function instrumentMapLayer(source){
  const hook='return {get object(){return group;}';
  assert.equal(source.split(hook).length,2,'Map instrumentation must match exactly once');
  return source.replace(hook,'return {get debugVisibleTiles(){return desired.map(tile=>{const entry=cache.get(tile.key);return {key:tile.key,ready:!!entry?.texture,failed:!!entry?.failed,loading:!!entry?.loading};});},get object(){return group;}');
}
async function mapSnapshot(page){
  return page.evaluate(()=>({stats:window.__mapTest?.mapStats,tiles:window.__mapTest?.debugMap?.debugVisibleTiles,
    failedKey:window.recoveryKey,attempts:window.recoveryTileAttempts,sampling:window.recoverySampling,
    status:document.querySelector('#homeMapStatus')?.textContent,
    retryVisible:!!document.querySelector('#homeMapRetry')&&!document.querySelector('#homeMapRetry').hidden&&document.querySelector('#homeMapRetry').getBoundingClientRect().width>0,
    stage:document.querySelector('#homeStage')?.getBoundingClientRect().toJSON()}));
}
(async()=>{
  const THREE=await import('data:text/javascript;base64,'+fs.readFileSync(path.join(root,'vendor/three.module.min.js')).toString('base64'));
  const context=vm.createContext({THREE,Promise,Map,Set,Math,Number,Error});
  vm.runInContext(instrumentMapLayer(fs.readFileSync(path.join(root,'map-layer.js'),'utf8'))+'\nthis.math=homeMapMath;',context);
  const math=context.math,config={enabled:true,latitude:37.78,longitude:-122.42,model_x:3,model_z:-2,north_deg:0};
  assert(math.validConfig(config));for(const invalid of [{latitude:86},{north_deg:-1},{north_deg:361},{model_x:10001},{longitude:Infinity},{enabled:1}])assert.equal(math.validConfig({...config,...invalid}),null);
  const map=math.project(config.latitude,config.longitude),round=math.unproject(...map);
  assert(Math.abs(round.latitude-config.latitude)<1e-8&&Math.abs(round.longitude-config.longitude)<1e-8);
  for(const angle of [0,45,90,180,270,360]){
    const local=math.transform({...config,north_deg:angle}),anchor=local.toWorld(...map),east=local.toWorld(map[0]+10/local.scale,map[1]);
    assert(Math.abs(anchor[0]-3)<1e-8&&Math.abs(anchor[1]+2)<1e-8);
    assert(Math.abs(east[0]-3-10*Math.cos(angle*Math.PI/180))<1e-8);
    assert(Math.abs(east[1]+2+10*Math.sin(angle*Math.PI/180))<1e-8);
    const back=local.toMap(...east);assert(Math.abs(back[0]-map[0]-10/local.scale)<1e-10&&Math.abs(back[1]-map[1])<1e-10);
  }
  for(const longitude of [-180,0,180])for(const latitude of [-85,0,85])for(const span of [10,100,1000,10000,100000]){
    const tiles=math.tiles({...config,latitude,longitude},[[-span,-span],[-span,span],[span,span],[span,-span]],1200);
    assert(tiles.length>0&&tiles.length<=36);for(const tile of tiles){assert(tile.z>=0&&tile.z<=19);assert(tile.x>=0&&tile.x<2**tile.z&&tile.y>=0&&tile.y<2**tile.z);}
  }
  const plain=value=>JSON.parse(JSON.stringify(value));
  const rooms=[[[0,0],[4,0],[4,5],[0,5]],[[4,0],[7,0],[7,3],[4,3]]],outline=math.context({},rooms);
  assert.equal(outline.polygons.length,1,'Shared partial room edges form one exterior contour');
  assert(outline.polygons[0].some(p=>p[0]===4&&p[1]===3),'Concave exterior corner is retained');
  assert.equal(math.context({},[rooms[0],rooms[0]]).polygons.length,0,'Overlapping rooms do not invent a roof');
  assert.equal(math.context({},[rooms[0],rooms[0].map(([x,z])=>[x+10,z])]).polygons.length,0,'Disconnected rooms do not expose internal room contours');
  for(const other of [[[1,1],[2,1],[2,2],[1,2]],[[2,2],[6,2],[6,6],[2,6]],[[2,0],[6,0],[6,5],[2,5]]]){
    assert.equal(math.context({},[rooms[0],other]).polygons.length,0,'Nested or partly overlapping rooms cannot supply a reliable exterior');
  }
  const junction=math.context({},[rooms[0],[[4,0],[7,0],[7,2],[4,2]],[[4,2],[7,2],[7,5],[4,5]]]).polygons;
  assert.equal(junction.length,1,'A shared T-junction produces one exterior');
  assert(junction[0].every((p,i)=>{const q=junction[0][(i+1)%junction[0].length];return p[0]===q[0]&&[0,7].includes(p[0])||p[1]===q[1]&&[0,5].includes(p[1]);}),'No T-junction interior edge survives');
  const roof={polygons_m:[[[0,0],[7,0],[7,3],[4,3],[4,5],[0,5]]],elevation_m:2.8};
  const legacy={environment:{elevation:-1.8},meshes:[{kind:'floors',vertices:[[0,-.16,0]]}],lower_floor_context:{elevation_m:-2.86,surfaces:[0,-3.02,0,1,-3.02,0,1,-2.86,1]},site_context:{ground_elevation_m:-2.86,roof_outline:roof}};
  const source=JSON.stringify(legacy),resolved=math.context(legacy,rooms);
  assert(Math.abs(resolved.elevation+3.1)<1e-10);assert.equal(resolved.outlineElevation,2.8);assert.deepEqual(plain(resolved.polygons),roof.polygons_m);assert.equal(JSON.stringify(legacy),source);
  assert.equal(math.context({elevation_m:16,environment:{elevation:-6}},[]).elevation,-6.08,'The site datum need not be zero');
  assert.equal(math.context({...legacy,site_context:{}},rooms).elevation,resolved.elevation,'Legacy lower slabs recover the missing datum');
  const topFloor={elevation_m:6,site_context:{ground_elevation_m:-6,lowest_slab_elevation_m:-6.16},meshes:[{kind:'floors',vertices:[[0,-.16,0]]}],lower_floor_context:{elevation_m:-3,surfaces:[0,-3.16,0]}};
  const topSource=JSON.stringify(topFloor);
  assert(Math.abs(math.context(topFloor).elevation+6.24)<1e-10,'The map includes the lowest slab even when only the nearest lower storey is displayed');
  assert.equal(JSON.stringify(topFloor),topSource,'Resolving the shared slab datum preserves model geometry and metadata');
  const oldTop=math.context({...topFloor,site_context:{ground_elevation_m:-6}});
  for(const invalid of [undefined,null,true,'-6.16',NaN,Infinity,-Infinity,-1001,1001]){
    assert.deepEqual(plain(math.context({...topFloor,site_context:{...topFloor.site_context,lowest_slab_elevation_m:invalid}})),plain(oldTop),'Invalid slab metadata retains the legacy fallback');
  }
  assert.equal(math.context({site_context:{lowest_slab_elevation_m:-1000}}).elevation,-1000.08,'The documented slab bound is inclusive');
  for(const bad of [null,{...roof,elevation_m:Infinity},{...roof,elevation_m:1001},{...roof,polygons_m:[[[0,0],[1,1],[0,1],[1,0]]]},{...roof,polygons_m:[[[0,0],[10001,0],[0,1]]]},{...roof,polygons_m:Array(17).fill(roof.polygons_m[0])}]){
    const value=math.context({site_context:{roof_outline:bad}},[]);assert.equal(value.polygons.length,0,'Invalid optional roof is omitted');
  }
  const crossed={...roof,polygons_m:[[[0,0],[4,4],[0,4],[4,0],[5,2]]]};
  assert.equal(math.context({site_context:{roof_outline:crossed}},[]).polygons.length,0,'A self-crossing roof with nonzero signed area is rejected');
  assert.deepEqual(plain(math.context({site_context:{roof_outline:crossed}},rooms).polygons),plain(outline.polygons),'Invalid explicit roof falls back safely to a reliable exterior');
  const neighbor={id:'neighbor',name:'Synthetic neighbor',kind:'building',polygon:[[12,0],[20,0],[20,3],[16,3],[16,7],[12,7]],height_m:5.5,color:'#589aa8',render_style:'outline'};
  const legacyNeighbor={...neighbor};delete legacyNeighbor.render_style;
  assert.deepEqual(plain(math.features([legacyNeighbor])),[legacyNeighbor],'Missing render_style retains the legacy solid contract');
  for(const render_style of ['solid','outline'])assert.equal(math.features([{...neighbor,render_style}]).length,1);
  for(const render_style of [undefined,null,true,'wireframe','OUTLINE',0,{},[]])assert.equal(math.features([{...neighbor,render_style}]).length,0,'Invalid explicit styles fail closed');
  for(const kind of ['home','roof','street','landscape'])for(const render_style of ['outline','solid'])assert.equal(math.features([{...neighbor,kind,height_m:0,render_style}]).length,0,'Styles apply only to neighboring buildings');
  for(const extra of [{unknown:true},{style:'outline'}])assert.equal(math.features([{...legacyNeighbor,...extra}]).length,0,'Unknown seventh keys remain invalid');
  assert.equal(math.features([{...neighbor,unknown:true}]).length,0,'Unknown eighth keys remain invalid');
  const outlineSource=JSON.stringify(neighbor),contourScene=new THREE.Scene();
  const contourCamera=new THREE.OrthographicCamera(-30,30,30,-30,.1,200);contourCamera.position.set(0,60,20);contourCamera.lookAt(0,0,0);contourCamera.updateMatrixWorld();
  const ownHome={...legacyNeighbor,id:'own_home',kind:'home'},ownRoof={...legacyNeighbor,id:'own_roof',kind:'roof'};
  const contourLayer=context.createHomeMapLayer(THREE,contourScene,{groundElevation:-12,features:[neighbor,{...neighbor,id:'reversed',color:'#3377bb',polygon:neighbor.polygon.slice().reverse()},{...neighbor,id:'flat',height_m:0},{...legacyNeighbor,id:'legacy'},{...neighbor,id:'solid',render_style:'solid'},ownHome,ownRoof],requestTile:async()=>({data_url:png}),loadTexture:async()=>new THREE.Texture()});
  const contours=contourLayer.object.getObjectByName('home-site-context'),solids=contourLayer.object.getObjectByName('home-site-features');
  assert.equal(contours.children.length,1);assert(contours.children.every(object=>object.isLineSegments),'Outlined buildings share one line object without surface meshes');
  assert.equal(contourLayer.stats.siteObjects,8);
  assert.equal(new Set(contours.children.map(object=>object.material)).size,1,'All neighboring contours share one material');
  const material=contours.children[0].material;assert.equal(material.opacity,.65);assert.equal(material.depthWrite,false);assert.equal(material.depthTest,true);
  assert.equal(material.vertexColors,true);assert(!material.map,'Contours add no texture');
  const segments=object=>{const p=object.geometry.attributes.position;return Array.from({length:p.count/2},(_,i)=>[[p.getX(i*2),p.getY(i*2),p.getZ(i*2)],[p.getX(i*2+1),p.getY(i*2+1),p.getZ(i*2+1)]]);};
  const segmentKey=points=>points.map(point=>point.join(',')).sort().join('|');
  const expectedEdges=[];
  for(let i=0;i<neighbor.polygon.length;i++){
    const a=neighbor.polygon[i],b=neighbor.polygon[(i+1)%neighbor.polygon.length];
    for(const y of [-12,-6.5])expectedEdges.push(segmentKey([[a[0],y,a[1]],[b[0],y,b[1]]]));
    expectedEdges.push(segmentKey([[a[0],-12,a[1]],[a[0],-6.5,a[1]]]));
  }
  const contourSegments=segments(contours.children[0]);
  for(let i=0;i<2;i++)assert.deepEqual(contourSegments.slice(i*expectedEdges.length,(i+1)*expectedEdges.length).map(segmentKey).sort(),expectedEdges.slice().sort(),'Concave contours contain only the two perimeters and vertical corners, in either winding');
  const flatEdges=contourSegments.slice(expectedEdges.length*2);
  assert.equal(flatEdges.length,neighbor.polygon.length,'Zero-height context has one perimeter without duplicate or zero-length edges');
  assert(flatEdges.every(edge=>edge.every(point=>point[1]===-12)),'Zero-height context remains at ground elevation');
  const color=new THREE.Color(neighbor.color),colors=contours.children[0].geometry.attributes.color;
  assert(Math.abs(colors.getX(0)-color.r)<1e-7&&Math.abs(colors.getY(0)-color.g)<1e-7&&Math.abs(colors.getZ(0)-color.b)<1e-7,'Outline honors the authored color');
  const secondColor=new THREE.Color('#3377bb'),secondStart=expectedEdges.length*2;
  assert(Math.abs(colors.getX(secondStart)-secondColor.r)<1e-7&&Math.abs(colors.getY(secondStart)-secondColor.g)<1e-7&&Math.abs(colors.getZ(secondStart)-secondColor.b)<1e-7,'Batched buildings retain their individual colors');
  assert.deepEqual(Array.from(solids.getObjectByName('legacy').geometry.attributes.position.array),Array.from(solids.getObjectByName('solid').geometry.attributes.position.array),'Explicit solid preserves legacy geometry');
  assert.equal(JSON.stringify(neighbor),outlineSource,'Contour construction preserves portable source geometry');
  contourLayer.setConfig(config);
  for(const state of [{},{transition:true},{coarse:true},{editing:true},{coarse:true,editing:true}]){
    contourLayer.render(contourCamera,{width:500,height:500},state);
    assert.equal(contours.visible,true,'Neighbor contours remain visible at detail, transition, overview and alignment scales');
    for(const name of ['own_home','own_home-outline','own_roof-outline'])assert.equal(solids.getObjectByName(name).visible,!!state.coarse,'Own-home shell cannot cover a detailed home during a transition');
    assert.equal(solids.visible,!!(state.coarse||state.transition),'Legacy solid context keeps its original visibility threshold');
  }
  await settle(contourLayer);
  contourLayer.setActive(false);assert.equal(contourLayer.object.visible,false);
  contourLayer.setActive(true);assert.equal(contourLayer.object.visible,true);
  contourLayer.setConfig({...config,enabled:false});assert.equal(contourLayer.object.visible,false,'Map disabled hides neighboring contours too');
  const disposed=new Map(),watch=resource=>{if(!disposed.has(resource)){disposed.set(resource,0);resource.addEventListener('dispose',()=>disposed.set(resource,disposed.get(resource)+1));}};
  contourLayer.object.traverse(object=>{if(object.geometry)watch(object.geometry);if(object.material)watch(object.material);});
  contourLayer.dispose();assert([...disposed.values()].every(count=>count===1),'Every contour/solid geometry and shared material is disposed exactly once');assert.equal(contourScene.children.length,0);
  const ring=Array.from({length:16},(_,i)=>[Math.cos(i*Math.PI/8)*5,Math.sin(i*Math.PI/8)*5]);
  const maximumContours=context.createHomeMapLayer(THREE,contourScene,{groundElevation:0,features:Array.from({length:64},(_,i)=>({...neighbor,id:'neighbor_'+i,polygon:ring.map(([x,z])=>[x+i*12,z])}))});
  const maximumGroup=maximumContours.object.getObjectByName('home-site-context');
  assert.equal(maximumContours.stats.siteObjects,1,'All 64 buildings share one line draw');
  assert.equal(new Set(maximumGroup.children.map(object=>object.material)).size,1);
  assert.equal(maximumGroup.children.reduce((sum,object)=>sum+object.geometry.attributes.position.count,0),6144,'The full 1024-point budget produces six vertices per corner');
  assert.equal(maximumGroup.children.reduce((sum,object)=>sum+object.geometry.attributes.position.array.byteLength+object.geometry.attributes.color.array.byteLength,0),147456,'Maximum contour attributes stay within 144 KiB');
  maximumContours.dispose();
  // Authored ground features use their exact local coordinates at all zoom/rotation states.
  const street={id:'street',name:'Traced street',kind:'street',height_m:0,color:'#777777',polygon:[[-9,15],[11,20],[10,24],[-10,19]]};
  const landscape={id:'landscape',name:'Traced garden',kind:'landscape',height_m:0,color:'#779977',polygon:[[-9,-4],[-5,-4],[-5,3],[-9,3]]};
  const groundSource=JSON.stringify([street,landscape]);
  const groundLayer=context.createHomeMapLayer(THREE,new THREE.Scene(),{groundElevation:-2.86,features:[street,landscape],requestTile:async()=>({data_url:png}),loadTexture:async()=>new THREE.Texture()});
  groundLayer.setConfig(config);
  const groundGroup=groundLayer.object.getObjectByName('home-site-ground');
  assert.equal(groundGroup.children.length,2);assert.equal(groundLayer.stats.siteObjects,2);
  const beforeGround=groundGroup.children.map(mesh=>({geometry:mesh.geometry,positions:Array.from(mesh.geometry.attributes.position.array)}));
  for(const angle of [0,Math.PI])for(const state of [{},{transition:true},{coarse:true},{editing:true}]){
    contourCamera.position.set(Math.sin(angle)*60,60,Math.cos(angle)*60);contourCamera.lookAt(0,0,0);contourCamera.updateMatrixWorld();
    groundLayer.render(contourCamera,{width:500,height:500},state);
    assert(groundGroup.visible&&groundLayer.object.visible,'Ground surfaces remain visible in detailed and map views');
    groundGroup.children.forEach((mesh,i)=>{assert.equal(mesh.geometry,beforeGround[i].geometry);assert.deepEqual(Array.from(mesh.geometry.attributes.position.array),beforeGround[i].positions);});
  }
  for(const feature of [street,landscape]){
    const positions=groundGroup.getObjectByName(feature.id).geometry.attributes.position;
    for(let i=0;i<positions.count;i++){
      assert(feature.polygon.some(([x,z])=>Math.fround(x)===positions.getX(i)&&Math.fround(z)===positions.getZ(i)),'No guessed road dimensions or offsets');
      assert.equal(positions.getY(i),Math.fround(-2.86+(feature.kind==='street'?.015:.005)));
    }
  }
  assert.equal(JSON.stringify([street,landscape]),groundSource);
  const groundDisposed=new Map();
  groundGroup.children.forEach(mesh=>{groundDisposed.set(mesh.geometry,0);mesh.geometry.addEventListener('dispose',()=>groundDisposed.set(mesh.geometry,groundDisposed.get(mesh.geometry)+1));});
  groundLayer.dispose();assert([...groundDisposed.values()].every(count=>count===1));
  const levelLayer=context.createHomeMapLayer(THREE,new THREE.Scene(),{...resolved,requestTile:async()=>({data_url:png}),loadTexture:async()=>new THREE.Texture()});
  const levelCamera=new THREE.OrthographicCamera(-10,10,10,-10,.1,100);levelCamera.position.set(0,20,10);levelCamera.lookAt(0,0,0);levelCamera.updateMatrixWorld();
  assert(Math.abs(levelLayer.pointAt(levelCamera,0,0).y-resolved.elevation)<1e-8,'Navigation ray uses the same physical ground plane');
  levelLayer.setConfig(config);levelLayer.render(levelCamera,{width:500,height:500});
  for(let i=0;i<50&&levelLayer.stats.inflight;i++)await tick();levelLayer.render(levelCamera,{width:500,height:500});
  const tile=levelLayer.object.children[0].children[0];assert(tile);assert.equal(tile.geometry.attributes.position.getY(0),Math.fround(resolved.elevation),'Rendered tile uses the navigation plane height');
  const line=levelLayer.object.children[1].children[0];assert.equal(line.geometry.attributes.position.getY(0),Math.fround(2.8));assert.equal(line.material.depthWrite,false);levelLayer.dispose();
  const scene=new THREE.Scene();let active=0,maxActive=0,requests=0,changes=0,disposedTextures=0,status='';
  const layer=context.createHomeMapLayer(THREE,scene,{polygons:[[[0,0],[10,0],[10,8],[0,8]]],requestTile:async()=>{active++;maxActive=Math.max(active,maxActive);requests++;await tick();active--;return {data_url:png};},loadTexture:async()=>{const texture=new THREE.Texture();texture.addEventListener('dispose',()=>disposedTextures++);return texture;},onChange:()=>changes++,onStatus:text=>status=text});
  layer.setConfig(config);
  const camera=new THREE.OrthographicCamera(-100,100,80,-80,.1,1e7);camera.position.set(3,200,-2);camera.up.set(0,0,-1);camera.lookAt(3,0,-2);camera.updateMatrixWorld();
  async function settle(target=layer){for(let i=0;i<200&&target.stats.inflight;i++)await tick();assert.equal(target.stats.inflight,0);}
  for(let i=0;i<18;i++){
    const span=50*2**(i%9);camera.left=-span+i*span;camera.right=span+i*span;camera.top=span;camera.bottom=-span;camera.updateProjectionMatrix();
    layer.render(camera,{width:1200,height:800},{coarse:true});await settle();layer.render(camera,{width:1200,height:800},{coarse:true});
    assert(layer.stats.cached<=48&&layer.stats.visible<=36);
  }
  assert(maxActive<=4&&requests>36&&disposedTextures>0&&changes>0);assert.equal(status,'');
  const before=requests;for(let i=0;i<20;i++)layer.render(camera,{width:1200,height:800},{coarse:true});assert.equal(requests,before,'Idle redraws cannot re-fetch tiles');
  for(let i=0;i<100;i++){layer.setConfig({...config,latitude:config.latitude+i*1e-9,north_deg:i*.001});layer.render(camera,{width:1200,height:800},{coarse:true});await settle();}
  assert(requests-before<=4,'Fine alignment drags reuse tile textures instead of refetching every frame');
  layer.setActive(false);assert.equal(layer.object.visible,false);layer.dispose();assert.equal(scene.children.length,0);assert.equal(layer.stats.cached,0);
  // Old requests must not install textures after an alignment change or teardown.
  let release;const stale=context.createHomeMapLayer(THREE,scene,{requestTile:()=>new Promise(resolve=>{release=resolve;}),loadTexture:async()=>new THREE.Texture()});stale.setConfig(config);stale.render(camera,{width:500,height:500});await tick();stale.dispose();release?.({data_url:png});await tick();assert.equal(scene.children.length,0);
  // A failed tile stays visible as a recoverable error even when its 15 neighbors load.
  const attempts=new Map();let failedKey,failTile=true,recoveryStatus,recoveryActive=0,recoveryMax=0;
  const recovery=context.createHomeMapLayer(THREE,scene,{requestTile:async tile=>{
    const key=`${tile.z}/${tile.x}/${tile.y}`;failedKey??=key;attempts.set(key,(attempts.get(key)||0)+1);recoveryMax=Math.max(recoveryMax,++recoveryActive);
    await tick();recoveryActive--;if(key===failedKey&&failTile)throw Error('Transient tile failure');return {data_url:png};
  },loadTexture:async()=>new THREE.Texture(),onStatus:(text,retry)=>recoveryStatus={text,retry}});
  camera.left=camera.bottom=-350;camera.right=camera.top=350;camera.updateProjectionMatrix();recovery.setConfig(config);
  recovery.render(camera,{width:1200,height:1200});await settle(recovery);
  assert.equal(recovery.stats.visible,16);assert.equal(recovery.stats.loaded,15);assert.equal(recoveryStatus.retry,true);assert.match(recoveryStatus.text,/Some map tiles/);
  for(let i=0;i<10;i++){recovery.render(camera,{width:1200,height:1200});await tick();}
  assert.equal(attempts.get(failedKey),1,'Redraws must not automatically retry a failed tile');
  camera.left+=5000;camera.right+=5000;camera.updateProjectionMatrix();recovery.render(camera,{width:1200,height:1200});await settle(recovery);
  assert.equal(recoveryStatus.text,'','A cached failure outside the viewport must not mark loaded tiles as unavailable');
  assert(recovery.debugVisibleTiles.every(tile=>tile.ready&&!tile.loading&&!tile.failed),'Current viewport is fully ready after a pan');
  assert(recovery.stats.loaded>recovery.debugVisibleTiles.length,'Healthy cached textures outside the current viewport must not count as visible readiness');
  camera.left-=5000;camera.right-=5000;camera.updateProjectionMatrix();recovery.render(camera,{width:1200,height:1200});
  assert.equal(recoveryStatus.retry,true);assert.equal(attempts.get(failedKey),1,'Returning to the failed tile still requires explicit retry');
  assert.equal(recovery.debugVisibleTiles.filter(tile=>tile.ready).length,recovery.debugVisibleTiles.length-1,'Partial readiness counts current tiles even with retained cache entries');
  assert.equal(recovery.debugVisibleTiles.find(tile=>tile.key===failedKey).failed,true);
  failTile=false;const beforeRetry=new Map(attempts);recovery.clearFailures();recovery.clearFailures();await settle(recovery);
  assert.equal(attempts.get(failedKey),2,'Explicit retry reloads the failed tile exactly once, including repeated clicks while pending');
  for(const [key,count] of beforeRetry)if(key!==failedKey)assert.equal(attempts.get(key),count,'Healthy cached tiles are retained');
  assert.equal(recoveryStatus.text,'');assert.equal(recoveryStatus.retry,false);assert(recoveryMax<=4&&recovery.stats.cached<=48&&recovery.stats.visible<=36);recovery.dispose();
  // Real Home status owners must survive tiles settling after a settings failure.
  const homeSource=fs.readFileSync(path.join(root,'home-view.js'),'utf8');
  for(const scenario of ['disabled','healthy','partial']){
    const nodes=new Map(),held=[],tileAttempts=new Map();let failFirst=scenario==='partial',firstKey;
    const node=id=>{if(!nodes.has(id))nodes.set(id,{hidden:true,textContent:'',setAttribute(){}});return nodes.get(id);};
    const c=vm.createContext({THREE,Promise,Map,Set,Math,Number,Error,$:node,scene:new THREE.Scene(),renderer:{},canEdit:true,zoom:1,panX:0,panY:0,
      model:{rooms:[]},environmentLayer:{contexts:[],setSiteContext(value){this.contexts.push(value);}},xm:x=>x,zm:z=>z,updateZoom(){},applyNavigationState(){},window:{}});
    vm.runInContext(fs.readFileSync(path.join(root,'map-layer.js'),'utf8'),c);
    const factory=c.createHomeMapLayer;
    c.createHomeMapLayer=(three,scene,options)=>factory(three,scene,{...options,loadTexture:()=>new Promise(resolve=>held.push(resolve))});
    const declarations=homeSource.split('\n').filter(line=>line.startsWith('  let navigationMode=')||line.startsWith('  let mapSettingsError='));
    const statusStart=homeSource.indexOf('  function refreshMapStatus('),controlsStart=homeSource.indexOf('  function refreshMapControls(');
    const statusEnd=homeSource.indexOf('\n  const mapFields=',controlsStart);
    assert(controlsStart>=0&&statusEnd>controlsStart);
    vm.runInContext(declarations.join('\n')+'\nfunction mapAvailable(){return !!mapLayer?.config?.enabled;}\n'+
      homeSource.slice(statusStart>=0?statusStart:controlsStart,statusEnd)+'\nthis.layer=()=>mapLayer;',c);
    c.window.homeMapRequest=async(action,tile)=>{
      if(action!=='tile')throw Error('Settings offline');
      const key=`${tile.z}/${tile.x}/${tile.y}`;firstKey??=key;tileAttempts.set(key,(tileAttempts.get(key)||0)+1);
      if(failFirst&&key===firstKey)throw Error('Tile offline');return {data_url:png};
    };
    c.configureMap({revision:1,configured:true,config});assert.equal(c.environmentLayer.contexts.at(-1),true);c.layer().render(camera,{width:1200,height:1200});await tick();
    assert(held.length>0,'The failure overlaps real pending tile decodes');
    if(scenario==='disabled')c.configureMap({revision:2,configured:false,config:null});
    await c.loadMap();
    const assertSettingsFailure=()=>{
      c.refreshMapControls();assert.match(node('homeMapStatus').textContent,/settings unavailable/);
      assert.equal(node('homeMapRetry').hidden,false);assert.equal(node('homeMapCaption').hidden,false);
    };
    assertSettingsFailure();
    const drain=async()=>{for(let i=0;i<100&&c.layer().stats.inflight;i++){held.splice(0).forEach(resolve=>resolve(new THREE.Texture()));await tick();}assert.equal(c.layer().stats.inflight,0);};
    await drain();assertSettingsFailure();
    const priorContext=c.environmentLayer.contexts.length;
    c.configureMap({revision:0,configured:true,config});assertSettingsFailure();assert.equal(c.environmentLayer.contexts.length,priorContext,'Stale map results cannot change scenery authority');
    c.window.homeMapRequest=async(action,tile)=>{
      if(action!=='tile')return {revision:3,configured:scenario!=='disabled',config:scenario==='disabled'?null:config};
      const key=`${tile.z}/${tile.x}/${tile.y}`;tileAttempts.set(key,(tileAttempts.get(key)||0)+1);return {data_url:png};
    };
    await c.loadMap();
    if(scenario==='partial'){
      assert.match(node('homeMapStatus').textContent,/Some map tiles/);assert.equal(node('homeMapRetry').hidden,false);
      c.layer().render(camera,{width:1200,height:1200});c.layer().clearFailures();await drain();
      assert.equal(tileAttempts.get(firstKey),2,'Normal tile retry remains explicit and recovers after settings success');
    }
    assert.equal(node('homeMapStatus').textContent,'','Accepted success clears the settings error even if the tile status is unchanged');
    assert.equal(node('homeMapRetry').hidden,true);assert.equal(node('homeMapCaption').hidden,scenario==='disabled');
    c.configureMap({revision:4,configured:true,config:{...config,enabled:false}});
    assert.equal(c.environmentLayer.contexts.at(-1),true,'A saved disabled map still suppresses generated scenery');
    c.model.site_context={features:[neighbor]};
    c.configureMap({revision:5,configured:false,config:null});
    assert.equal(c.environmentLayer.contexts.at(-1),true,'Removing map alignment cannot erase authored site authority');
    c.model.site_context.features=[];c.configureMap({revision:6,configured:false,config:null});
    assert.equal(c.environmentLayer.contexts.at(-1),false,'Without either context, demo mode is available again');
    c.layer().dispose();
  }
  console.log('PASS: map coordinates, multistorey ground, validated neighbor/roof contours, legacy solids, detail visibility, bounded geometry/materials, LOD, tile recovery and disposal.');
  if(process.argv.includes('--unit-only'))return;
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'home-map-test-'));let browser,server,page;
  try{
    const project=JSON.parse(fs.readFileSync(path.join(root,'planner/example-home.json'),'utf8'));
    project.floors[0].elevation_m=3;
    const lower=JSON.parse(JSON.stringify(project.floors[0]));lower.id='lower';lower.name='Lower floor';lower.elevation_m=0;
    for(const room of lower.rooms)for(const p of room.polygon)p[0]-=4;
    for(const wall of lower.walls){wall.start[0]-=4;wall.end[0]-=4;}for(const item of lower.items)item.position_m.x-=4;
    project.floors.push(lower);
    project.site={ground_elevation_m:0,features:[
      {id:'synthetic_neighbor',name:'Synthetic solid neighbor',kind:'building',polygon:[[15,0],[24,0],[24,10],[15,10]],height_m:4,color:'#f256aa'},
      {id:'synthetic_contour',name:'Synthetic contour neighbor',kind:'building',polygon:[[8,0],[11,0],[11,5],[9,5],[9,3],[8,3]],height_m:4,color:'#589aa8',render_style:'outline'}
    ]};
    fs.writeFileSync(path.join(temporary,'project.json'),JSON.stringify(project));
    const built=spawnSync(process.env.PYTHON||'python3',['scripts/build-planner-project.py','--project',path.join(temporary,'project.json'),'--output',path.join(temporary,'build')],{cwd:root,encoding:'utf8'});
    assert.equal(built.status,0,built.stderr||built.stdout);
    let html=fs.readFileSync(path.join(temporary,'build/main/index.html'),'utf8');
    html=instrumentMapLayer(html);
    html=html.replace(/(<script id="modelData" type="application\/json">)([\s\S]*?)(<\/script>)/,(_all,start,json,end)=>{
      const model=JSON.parse(json);delete model.elevation_m;model.environment.elevation=-1.8;model.site_context={...model.site_context,roof_outline:roof};return start+JSON.stringify(model)+end;
    });
    html=html.replace('rebuildInventoryView();if(embedded)','window.__mapMath=homeMapMath;window.__mapThree=THREE;window.__mapRenderer=renderer;window.__mapTest=homeView;rebuildInventoryView();if(embedded)');
    html=html.replaceAll('roomLighting?.update(points,camera);', 'window.__mapLightUpdates=(window.__mapLightUpdates||0)+1;roomLighting?.update(points,camera);');
    html=html.replace('return {get active(){return active},get mapStats()', 'return {debugResetFit(){cameraFit=null},get debugCamera(){return camera},get debugMap(){return mapLayer},get active(){return active},get mapStats()');
    server=http.createServer((request,response)=>{response.setHeader('Content-Type','text/html');response.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const engine=process.env.MAP_ENGINE||'chromium';assert(['chromium','firefox','webkit'].includes(engine));
    const engines=require('playwright'),{browserLaunchOptions}=require('./browser-stability-diagnostics.cjs');browser=await engines[engine].launch(browserLaunchOptions(engine,true));
    page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',error=>errors.push(String(error)));
    const waitForCurrentTiles=async(failedKey=null)=>{
      const handle=await page.waitForFunction(failedKey=>{
        const stats=window.__mapTest.mapStats,tiles=window.__mapTest.debugMap.debugVisibleTiles,
          status=document.querySelector('#homeMapStatus').textContent,retry=document.querySelector('#homeMapRetry'),
          retryVisible=!retry.hidden&&retry.getBoundingClientRect().width>0;
        if(stats.inflight||tiles.length<2||tiles.some(tile=>tile.loading))return false;
        if(failedKey?(!tiles.some(tile=>tile.key===failedKey&&tile.failed&&!tile.ready)||!/Some map tiles/.test(status)||!retryVisible):(status!==''||retryVisible))return false;
        return tiles.every(tile=>tile.key===failedKey?tile.failed&&!tile.ready:tile.ready&&!tile.failed)?{stats,tiles,status,retryVisible,attempts:window.recoveryTileAttempts}:false;
      },failedKey);
      try{return await handle.jsonValue();}finally{await handle.dispose();}
    };
    // Read the real compiled model and real map group, without replacing either.
    const authoredSitePixels=async(name='home-site-features')=>page.evaluate(name=>{
      const layer=window.__mapTest.debugMap,site=layer.object.getObjectByName(name);
      const gl=window.__mapRenderer.getContext(),w=gl.drawingBufferWidth,h=gl.drawingBufferHeight;
      const sample=()=>{window.renderModel();const pixels=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return pixels;};
      const visible=sample(),visibleStats={...window.__mapRenderer.info.render};site.children.forEach(object=>{object.visible=false;});const hidden=sample(),hiddenStats={...window.__mapRenderer.info.render};site.children.forEach(object=>{object.visible=true;});window.renderModel();
      let changed=0;for(let i=0;i<visible.length;i+=4)if(Math.max(...[0,1,2].map(channel=>Math.abs(visible[i+channel]-hidden[i+channel])))>=2)changed++;
      return {visible:layer.object.visible&&site.visible,changed,objects:site.children.map(object=>object.name),drawCalls:visibleStats.calls-hiddenStats.calls,triangles:visibleStats.triangles-hiddenStats.triangles,lines:visibleStats.lines-hiddenStats.lines};
    },name);
    const assertCompassLayout=async()=>{
      const layout=await page.evaluate(()=>{
        const compass=document.querySelector('#homeMapCompass'),stage=document.querySelector('#homeStage'),rect=compass.getBoundingClientRect();
        const overlaps=[...document.querySelectorAll('#homeStage,#homeTVs,#homeTVs>*,#homeTelemetry,#homeTelemetry>*')].filter(element=>{
          const other=element.getBoundingClientRect();return other.width>0&&other.height>0&&rect.left<other.right&&rect.right>other.left&&rect.top<other.bottom&&rect.bottom>other.top;
        }).map(element=>element.id||element.className);
        return {toolbar:compass.parentElement.classList.contains('home-map-navigation'),afterAlign:compass.previousElementSibling.id==='homeMapAlign',outsideStage:!stage.contains(compass),arrow:compass.firstElementChild.tagName==='SPAN'&&/^rotate\(/.test(compass.firstElementChild.style.transform),rowHeight:rect.height===document.querySelector('#homeMapAlign').getBoundingClientRect().height,withinViewport:rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight,overlaps};
      });
      assert.deepEqual(layout,{toolbar:true,afterAlign:true,outsideStage:true,arrow:true,rowHeight:true,withinViewport:true,overlaps:[]},'Compass stays in its toolbar row, clear of scene overlays');
    };
    const origin=`http://127.0.0.1:${server.address().port}`;await page.route('**/*',route=>route.request().url().startsWith(origin)||route.request().url().startsWith('data:')?route.continue():route.abort());
    await page.goto(origin);await page.waitForFunction(()=>window.__mapTest&&window.floorplan);
    await page.evaluate(({config,png})=>{
      window.mapRequests=[];window.mapSaves=[];window.navigation=[];
      window.homeMapNavigationChanged=state=>navigation.push(state);
      window.homeMapRequest=async(action,payload)=>{mapRequests.push({action,payload});if(action==='tile')return {data_url:png};if(action==='save'){mapSaves.push(payload);return {revision:2,configured:true,config:payload.config};}return {revision:1,configured:true,config,reference:{latitude:37.78,longitude:-122.42}};};
      window.__mapTest.setActive(true);
    },{config,png});
    await page.evaluate(()=>window.__mapTest.loadMap());await page.locator('#homeMapOverview').waitFor({state:'visible'});
    await page.waitForFunction(()=>window.__mapTest.mapStats?.loaded>0);
    const gpu=await page.evaluate(()=>{const gl=window.__mapRenderer.getContext(),info=gl.getExtension('WEBGL_debug_renderer_info');return info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);});
    if(process.env.CHROMIUM_ANGLE_BACKEND==='metal')assert.match(gpu,/ANGLE.*Apple.*Metal|ANGLE.*Metal.*Apple/i,'Requested native Metal renderer must actually be active');
    console.log('Map renderer: '+gpu);
    const compiledSite=await page.evaluate(()=>({site:window.floorplan.model.site_context,stats:window.__mapTest.mapStats,
      roomIds:window.floorplan.model.rooms.map(room=>room.id),roomOptions:[...document.querySelector('#homeRoom').options].map(option=>option.value)}));
    assert.deepEqual(compiledSite.site.features,project.site.features,'Compiler site features reach the actual Home view model unchanged');
    assert.equal(compiledSite.site.ground_elevation_m,-3,'Compiler shifts the site ground to the selected floor origin');
    assert.equal(compiledSite.stats.siteFeatures,2,'createHomeView passes authored features to its actual map layer');
    assert.equal(compiledSite.stats.siteObjects,3,'The solid neighbor has two objects and contour neighbor has only one line object');
    for(const zoom of [.6,.24]){
      await page.evaluate(zoom=>window.__mapTest.applyNavigationState({mode:'map',zoom,rotation:0,tilt:0,pan_x:0,pan_y:0}),zoom);
      await page.waitForFunction(()=>window.__mapTest.mapStats.inflight===0);
      const visible=await page.evaluate(()=>{
        const gl=window.__mapRenderer.getContext(),w=gl.drawingBufferWidth,h=gl.drawingBufferHeight;
        const sample=()=>{window.renderModel();const data=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,data);return data;};
        const before=sample(),button=document.querySelector('#homeFloorContext');button.click();const absent=sample();button.click();
        let changed=0;for(let i=0;i<before.length;i+=4)if(Math.max(...[0,1,2].map(j=>Math.abs(before[i+j]-absent[i+j])))>=2)changed++;
        const map=window.__mapTest.debugMap,camera=window.__mapTest.debugCamera;
        return {changed,ground:map.pointAt(camera,0,0).y,outline:map.object.children[1].visible,roofY:map.object.children[1].children[0].geometry.attributes.position.getY(0)};
      });
      assert(visible.changed>20,`Lower storey contributes actual visible pixels at ${zoom}: ${JSON.stringify(visible)}`);
      assert(Math.abs(visible.ground+3.24)<1e-6,'Map lies below the lower slab, not the upper floor');
      assert.equal(visible.outline,true);assert.equal(visible.roofY,Math.fround(2.8));
      const contourPixels=await authoredSitePixels('home-site-context');
      assert.equal(contourPixels.visible,true);assert(contourPixels.changed>5,'Neighbor contours contribute pixels alongside the detailed home: '+JSON.stringify(contourPixels));
      assert.equal(contourPixels.drawCalls,1);assert.equal(contourPixels.triangles,0);assert.equal(contourPixels.lines,18,'The real renderer draws only the lower/upper perimeter and corner lines');
    }
    assert.equal(await page.getByRole('img',{name:'Geographic north',exact:true}).isVisible(),true);
    await assertCompassLayout();
    assert.equal(await page.locator('canvas').count(),1,'Map uses the existing renderer canvas');
    await page.locator('#homeMapOverview').click();await page.waitForFunction(()=>document.querySelector('#homeStage').dataset.mapCoarse==='true');
    assert.equal(await page.locator('#homeMapCompass').isVisible(),true);assert.equal(await page.locator('#homeMapCaption').isVisible(),true);
    await assertCompassLayout();
    assert.equal(await page.locator('#homeMarkers').isVisible(),false,'Device overlays disappear at map scale');
    const siteOverview=await authoredSitePixels();
    assert.equal(siteOverview.visible,true,'Authored surroundings are visible in map overview');
    assert.deepEqual(siteOverview.objects,['synthetic_neighbor','synthetic_neighbor-outline']);
    assert(siteOverview.changed>5,'Authored surroundings contribute actual overview pixels: '+JSON.stringify(siteOverview));
    const contourOverview=await authoredSitePixels('home-site-context');
    assert.equal(contourOverview.visible,true);assert.deepEqual(contourOverview.objects,['home-neighbor-contours']);
    assert(contourOverview.changed>2,'Neighbor contours contribute actual overview pixels: '+JSON.stringify(contourOverview));
    assert.equal(await page.evaluate(()=>{const before=window.__mapLightUpdates;window.renderModel();return window.__mapLightUpdates===before;}),true,'Coarse maps skip house lighting uploads');
    const coarse=await page.evaluate(()=>window.__mapTest.exportNavigationState());assert.equal(coarse.mode,'map');assert(coarse.zoom<.65);
    if(process.env.MAP_SCENE_SCREENSHOT)await page.screenshot({path:process.env.MAP_SCENE_SCREENSHOT});
    const anchored=await page.evaluate(()=>window.__mapTest.debugMap.pointAt(window.__mapTest.debugCamera,.3,.2).toArray());
    const box=await page.locator('#homeStage canvas').boundingBox();await page.mouse.move(box.x+box.width*.65,box.y+box.height*.4);await page.mouse.wheel(0,-300);
    await page.waitForFunction(old=>window.__mapTest.exportNavigationState().zoom>old,coarse.zoom);
    const projected=await page.evaluate(point=>new window.__mapThree.Vector3().fromArray(point).project(window.__mapTest.debugCamera).toArray(),anchored);
    assert(Math.abs(projected[0]-.3)*box.width/2<2&&Math.abs(projected[1]-.2)*box.height/2<2,'Wheel keeps the geographic point under the cursor: '+JSON.stringify({projected,box}));
    const zoomed=await page.evaluate(()=>window.__mapTest.exportNavigationState());assert(zoomed.pan_x!==0||zoomed.pan_y!==0,'Wheel zoom preserves a noncentral ground anchor');
    await page.evaluate(()=>{
      // Real touch contacts are exercised below via CDP; here restore a portable map state.
      window.__mapTest.applyNavigationState({mode:'map',zoom:.08,rotation:.2,tilt:0,pan_x:20,pan_y:-10});
    });
    if(engine==='chromium'){
      const cdp=await page.context().newCDPSession(page),x=box.x+box.width/2,y=box.y+box.height/2;
      const touch=(type,points)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(([id,x,y])=>({id,x,y,radiusX:2,radiusY:2,force:1}))});
      await touch('touchStart',[[1,x-50,y],[2,x+50,y]]);await touch('touchMove',[[1,x-90,y],[2,x+90,y]]);await touch('touchEnd',[]);
    }else await page.evaluate(()=>{
      const canvas=document.querySelector('#homeStage canvas'),r=canvas.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
      // Synthetic pointer events exercise the same production pinch handler on engines without CDP.
      const capture=canvas.setPointerCapture;canvas.setPointerCapture=()=>{};
      const pointer=(type,id,dx)=>canvas.dispatchEvent(new PointerEvent(type,{pointerId:id,pointerType:'touch',isPrimary:id===1,button:0,buttons:type==='pointerup'?0:1,clientX:x+dx,clientY:y,bubbles:true}));
      pointer('pointerdown',1,-50);pointer('pointerdown',2,50);pointer('pointermove',1,-90);pointer('pointermove',2,90);pointer('pointerup',1,-90);pointer('pointerup',2,90);canvas.setPointerCapture=capture;
    });
    const pinched=await page.evaluate(()=>window.__mapTest.exportNavigationState());assert(pinched.zoom>.08,'Two contacts continuously zoom the existing camera');
    const restored=await page.evaluate(()=>{
      const state=window.__mapTest.exportNavigationState(),rooms=window.floorplan.model.rooms,original=rooms.map(room=>room.polygon);
      rooms.forEach(room=>room.polygon=room.polygon.map(([x,z])=>[x*2+200,z*3-50]));window.__mapTest.debugResetFit();window.__mapTest.applyNavigationState(state);
      const next=window.__mapTest.exportNavigationState();rooms.forEach((room,index)=>room.polygon=original[index]);window.__mapTest.debugResetFit();window.__mapTest.applyNavigationState(state);
      return {state,next};
    });
    for(const key of ['target_x','target_z','span_m'])assert(Math.abs(restored.state[key]-restored.next[key])<1e-6,'Different floor footprints preserve map '+key);

    await page.locator('#homeMapHome').click();await page.waitForFunction(()=>document.querySelector('#homeStage').dataset.mapCoarse==='false');
    assert.equal(await page.evaluate(()=>window.__mapTest.exportNavigationState().zoom),1);
    assert.equal(await page.evaluate(()=>window.__mapTest.debugMap.object.children[1].visible),false,'Roof contour yields to Home controls at normal scale');
    assert.equal(await page.locator('#homeMarkers').isVisible(),true,'Home restores the device overlay layer');
    assert.equal(await page.evaluate(()=>window.__mapTest.debugMap.object.getObjectByName('home-site-features').visible),false,'Authored surroundings yield to interior controls at Home scale');
    const contourHome=await authoredSitePixels('home-site-context');
    assert.equal(contourHome.visible,true);assert(contourHome.changed>5,'Neighbor contours remain visible beside the home at normal scale: '+JSON.stringify(contourHome));
    assert.deepEqual(await page.evaluate(()=>({roomIds:window.floorplan.model.rooms.map(room=>room.id),roomOptions:[...document.querySelector('#homeRoom').options].map(option=>option.value)})),
      {roomIds:compiledSite.roomIds,roomOptions:compiledSite.roomOptions},'Site visibility never mutates interior rooms or selector choices');
    await page.locator('#homeRoom').selectOption(compiledSite.roomIds[0]);
    assert.equal(await page.locator('#homeRoom').inputValue(),compiledSite.roomIds[0],'The real interior room selector remains usable');
    await page.locator('#homeRoom').selectOption('');
    await page.locator('#homeMapAlign').click();await page.locator('#homeMapEditor').waitFor({state:'visible'});
    const siteAlignment=await authoredSitePixels();
    assert.equal(siteAlignment.visible,true,'Authored surroundings are visible during geographic alignment');
    assert(siteAlignment.changed>5,'Authored surroundings contribute actual alignment pixels: '+JSON.stringify(siteAlignment));
    await page.locator('#homeMapNorth').fill('90');await page.locator('#homeMapNorth').dispatchEvent('change');await page.locator('#homeMapCancel').click();assert.equal(await page.evaluate(()=>mapSaves.length),0,'Cancel keeps alignment local');
    await page.locator('#homeMapAlign').click();await page.locator('#homeMapNorth').fill('25.05');await page.locator('#homeMapNorth').dispatchEvent('change');
    await page.locator('#homeMapLatitude').fill('37.1234567');await page.locator('#homeMapLatitude').dispatchEvent('change');
    await page.locator('#homeMapX').fill('2.345');await page.locator('#homeMapX').dispatchEvent('change');
    assert.equal(await page.locator('#homeMapForm').evaluate(form=>form.checkValidity()),true,'Precise HA coordinates, model anchors and angles can be saved');
    const editorBox=await page.locator('#homeStage canvas').boundingBox();await page.mouse.move(editorBox.x+editorBox.width/2,editorBox.y+editorBox.height/2);await page.mouse.down();await page.mouse.move(editorBox.x+editorBox.width/2+25,editorBox.y+editorBox.height/2+10,{steps:3});await page.mouse.up();
    assert.equal(await page.locator('#homeMapForm').evaluate(form=>form.checkValidity()),true,'Dragging produces a valid saveable alignment');
    await page.locator('#homeMapSave').click();await page.locator('#homeMapEditor').waitFor({state:'hidden'});
    const saves=await page.evaluate(()=>mapSaves);assert.equal(saves.length,1);assert.equal(saves[0].revision,1);assert.equal(saves[0].config.north_deg,25.05);
    await page.locator('#homeMapHome').click();await page.waitForFunction(()=>window.__mapTest.mapStats.inflight===0);
    const idle=await page.evaluate(()=>({renders:floorplan.renderCount,requests:mapRequests.length}));await page.waitForTimeout(250);const after=await page.evaluate(()=>({renders:floorplan.renderCount,requests:mapRequests.length}));assert.deepEqual(after,idle,'Idle map runs no animation/request loop');
    // Establish final layout/view with healthy tiles before injecting a fault.
    // Clear only the layer cache, without hide/show of the caption or controls.
    await page.evaluate(()=>window.__mapTest.applyNavigationState({mode:'map',zoom:.035,rotation:0,tilt:0,pan_x:0,pan_y:0}));
    await waitForCurrentTiles();
    // Place sampling halfway between LOD thresholds. Real error-caption resize
    // can then change the viewport without invalidating the chosen center tile.
    await page.evaluate(()=>{
      const state=window.__mapTest.exportNavigationState(),map=window.__mapTest.debugMap,camera=window.__mapTest.debugCamera,
        rect=document.querySelector('#homeStage').getBoundingClientRect(),transform=window.__mapMath.transform(map.config),
        corners=[[-1,-1],[-1,1],[1,1],[1,-1]].map(p=>map.pointAt(camera,...p)).map(p=>transform.toMap(p.x,p.z)),
        ratio=rect.width/(256*(Math.max(...corners.map(p=>p[0]))-Math.min(...corners.map(p=>p[0])))),
        level=Number(map.debugVisibleTiles[0].key.split('/')[0]);
      window.recoverySampling={before:ratio,level,target:2**(level+.5)};
      state.span_m*=ratio/recoverySampling.target;window.__mapTest.applyNavigationState(state);
    });
    await waitForCurrentTiles();
    const recoveryKey=await page.evaluate(png=>{
      const map=window.__mapTest.debugMap,config=map.config;
      window.recoveryTileAttempts={};window.recoveryKey=map.debugVisibleTiles[0].key;window.recoveryFail=true;
      window.homeMapRequest=async(action,tile)=>{
        if(action!=='tile')return {revision:4,configured:true,config};
        const key=`${tile.z}/${tile.x}/${tile.y}`;recoveryTileAttempts[key]=(recoveryTileAttempts[key]||0)+1;
        if(key===recoveryKey&&recoveryFail)throw Error('Transient tile failure');return {data_url:png};
      };
      map.setConfig(null);map.setConfig(config);window.renderModel();return recoveryKey;
    },png);
    const partial=await waitForCurrentTiles(recoveryKey);
    assert.equal(partial.tiles.filter(tile=>tile.ready).length,partial.tiles.length-1);
    assert.match(partial.status,/Some map tiles/);assert.equal(partial.retryVisible,true,'A partial map failure exposes Retry map');
    await page.evaluate(()=>{for(let i=0;i<10;i++)window.renderModel();});await page.waitForTimeout(100);
    const stablePartial=await mapSnapshot(page);
    assert(stablePartial.tiles.some(tile=>tile.key===recoveryKey&&tile.failed&&!tile.ready),'The selected failure remains in the viewport after redraws');
    assert(stablePartial.tiles.every(tile=>tile.key===recoveryKey?tile.failed&&!tile.ready:tile.ready&&!tile.failed),'Every other current tile remains ready');
    assert.match(stablePartial.status,/Some map tiles/);assert.equal(stablePartial.retryVisible,true);
    assert.equal(stablePartial.attempts[recoveryKey],1,'Rendering a partial map does not run an automatic retry loop');
    await page.evaluate(()=>{recoveryFail=false;});await page.locator('#homeMapRetry').click();
    await waitForCurrentTiles();await page.waitForTimeout(100);
    const recovered=await mapSnapshot(page);
    assert.equal(recovered.stats.inflight,0);assert(recovered.tiles.every(tile=>tile.ready&&!tile.failed&&!tile.loading),'All current tiles remain healthy after Retry settles');
    assert(recovered.tiles.some(tile=>tile.key===recoveryKey&&tile.ready),'The explicitly retried tile remains ready in the viewport');
    assert.equal(recovered.attempts[recoveryKey],2,'Explicit retry requests the failed current tile exactly once');
    assert.equal(recovered.retryVisible,false);assert.equal(recovered.status,'');
    assert.equal(Object.entries(recovered.attempts).every(([key,count])=>count===(key===recoveryKey?2:1)),true,'Retry preserves all healthy tile requests');
    await page.setViewportSize({width:390,height:844});await assertCompassLayout();
    await page.locator('#homeMapHome').click();
    await assertCompassLayout();
    // Family view permissions are still derived from the authenticated host init.
    await page.evaluate(()=>{window.__mapTest.configureMap({revision:5,configured:false,config:null});});
    assert.equal(await page.locator('#homeMapOverview').isVisible(),false);assert.equal(await page.evaluate(()=>window.__mapTest.exportNavigationState().zoom),1);
    assert.equal(await page.locator('#homeMapCompass').isVisible(),false,'Unconfigured maps hide the toolbar compass');
    await page.evaluate(()=>{window.homeMapRequest=async()=>{throw Error('offline');};return window.__mapTest.loadMap();});
    assert.match(await page.locator('#homeMapStatus').textContent(),/unavailable/);assert.equal(await page.locator('#homeMapOverview').isVisible(),false);
    assert.deepEqual(errors,[]);
    console.log('PASS ('+engine+'): compiled site overview/alignment pixels and interior preservation, same-renderer map/Home transitions, wheel and touch zoom, overlays, desktop/mobile compass layout, alignment Save/Cancel, navigation state and idle budget.');
  }catch(error){
    const snapshot=page?await mapSnapshot(page).catch(diagnosticError=>({diagnosticError:String(diagnosticError)})):{pageCreated:false};
    throw Error('Map scene browser check failed: '+JSON.stringify(snapshot),{cause:error});
  }finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());fs.rmSync(temporary,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
