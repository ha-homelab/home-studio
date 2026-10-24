'use strict';
// Local synthetic map tiles; these checks never contact a map provider or HA.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),os=require('node:os'),http=require('node:http');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHklEQVR4nGO4dP3Cf3yYAUTM3jETjtH5VFIwwG4AAJrHyi0UM1mUAAAAAElFTkSuQmCC';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
  const THREE=await import('data:text/javascript;base64,'+fs.readFileSync(path.join(root,'vendor/three.module.min.js')).toString('base64'));
  const context=vm.createContext({THREE,Promise,Map,Set,Math,Number,Error});
  vm.runInContext(fs.readFileSync(path.join(root,'map-layer.js'),'utf8')+'\nthis.math=homeMapMath;',context);
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
  camera.left-=5000;camera.right-=5000;camera.updateProjectionMatrix();recovery.render(camera,{width:1200,height:1200});
  assert.equal(recoveryStatus.retry,true);assert.equal(attempts.get(failedKey),1,'Returning to the failed tile still requires explicit retry');
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
      model:{rooms:[]},xm:x=>x,zm:z=>z,updateZoom(){},applyNavigationState(){},window:{}});
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
    c.configureMap({revision:1,configured:true,config});c.layer().render(camera,{width:1200,height:1200});await tick();
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
    c.configureMap({revision:0,configured:true,config});assertSettingsFailure();
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
    assert.equal(node('homeMapRetry').hidden,true);assert.equal(node('homeMapCaption').hidden,scenario==='disabled');c.layer().dispose();
  }
  console.log('PASS: map coordinates, north rotation, dateline/pole tile indices, LOD, four-request limit, cache eviction, explicit tile recovery and disposal.');
  if(process.argv.includes('--unit-only'))return;
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'home-map-test-'));let browser,server;
  try{
    const project=JSON.parse(fs.readFileSync(path.join(root,'planner/example-home.json'),'utf8'));
    fs.writeFileSync(path.join(temporary,'project.json'),JSON.stringify(project));
    const built=spawnSync(process.env.PYTHON||'python3',['scripts/build-planner-project.py','--project',path.join(temporary,'project.json'),'--output',path.join(temporary,'build')],{cwd:root,encoding:'utf8'});
    assert.equal(built.status,0,built.stderr||built.stdout);
    let html=fs.readFileSync(path.join(temporary,'build/main/index.html'),'utf8');
    html=html.replace('rebuildInventoryView();if(embedded)','window.__mapThree=THREE;window.__mapTest=homeView;rebuildInventoryView();if(embedded)');
    html=html.replaceAll('roomLighting?.update(points,camera);', 'window.__mapLightUpdates=(window.__mapLightUpdates||0)+1;roomLighting?.update(points,camera);');
    html=html.replace('return {get active(){return active},get mapStats()', 'return {debugResetFit(){cameraFit=null},get debugCamera(){return camera},get debugMap(){return mapLayer},get active(){return active},get mapStats()');
    server=http.createServer((request,response)=>{response.setHeader('Content-Type','text/html');response.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const engine=process.env.MAP_ENGINE||'chromium';assert(['chromium','firefox','webkit'].includes(engine));
    const engines=require('playwright'),{browserLaunchOptions}=require('./browser-stability-diagnostics.cjs');browser=await engines[engine].launch(browserLaunchOptions(engine,true));
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',error=>errors.push(String(error)));
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
    assert.equal(await page.getByRole('img',{name:'Geographic north',exact:true}).isVisible(),true);
    await assertCompassLayout();
    assert.equal(await page.locator('canvas').count(),1,'Map uses the existing renderer canvas');
    await page.locator('#homeMapOverview').click();await page.waitForFunction(()=>document.querySelector('#homeStage').dataset.mapCoarse==='true');
    assert.equal(await page.locator('#homeMapCompass').isVisible(),true);assert.equal(await page.locator('#homeMapCaption').isVisible(),true);
    await assertCompassLayout();
    assert.equal(await page.locator('#homeMarkers').isVisible(),false,'Device overlays disappear at map scale');
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
    await page.locator('#homeMapAlign').click();await page.locator('#homeMapEditor').waitFor({state:'visible'});
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
    await page.evaluate(png=>{
      const config=mapSaves[0].config;window.recoveryTileAttempts={};window.recoveryKey=null;window.recoveryFail=true;
      window.__mapTest.configureMap({revision:3,configured:false,config:null});
      window.__mapTest.applyNavigationState({mode:'map',zoom:.035,rotation:0,tilt:0,pan_x:0,pan_y:0});
      window.homeMapRequest=async(action,tile)=>{
        if(action!=='tile')return {revision:4,configured:true,config};
        const key=`${tile.z}/${tile.x}/${tile.y}`;window.recoveryKey??=key;recoveryTileAttempts[key]=(recoveryTileAttempts[key]||0)+1;
        if(key===recoveryKey&&recoveryFail)throw Error('Transient tile failure');return {data_url:png};
      };
      window.__mapTest.configureMap({revision:4,configured:true,config});
    },png);
    await page.waitForFunction(()=>window.__mapTest.mapStats.inflight===0&&window.__mapTest.mapStats.loaded>0);
    assert.equal(await page.evaluate(()=>window.__mapTest.mapStats.loaded),await page.evaluate(()=>window.__mapTest.mapStats.visible-1));
    assert.match(await page.locator('#homeMapStatus').textContent(),/Some map tiles/);assert.equal(await page.locator('#homeMapRetry').isVisible(),true,'A partial map failure exposes Retry map');
    await page.evaluate(()=>{for(let i=0;i<10;i++)window.renderModel();});await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>recoveryTileAttempts[recoveryKey]),1,'Rendering a partial map does not run an automatic retry loop');
    await page.evaluate(()=>{recoveryFail=false;});await page.locator('#homeMapRetry').click();
    await page.waitForFunction(()=>window.__mapTest.mapStats.inflight===0&&recoveryTileAttempts[recoveryKey]===2);
    assert.equal(await page.locator('#homeMapRetry').isVisible(),false);assert.equal(await page.locator('#homeMapStatus').textContent(),'');
    assert.equal(await page.evaluate(()=>Object.entries(recoveryTileAttempts).every(([key,count])=>count===(key===recoveryKey?2:1))),true,'Retry preserves all healthy tile requests');
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
    console.log('PASS ('+engine+'): same-renderer map/Home transitions, wheel and touch zoom, overlays, desktop/mobile compass layout, alignment Save/Cancel, navigation state and idle budget.');
  }finally{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());fs.rmSync(temporary,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
