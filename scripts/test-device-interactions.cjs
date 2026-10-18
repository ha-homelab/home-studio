// Integrated generated-viewer interactions with fictional HA state and a mocked parent only.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const http=require('node:http'),{spawnSync}=require('node:child_process'),{chromium,firefox,webkit}=require('playwright');
const {browserLaunchOptions}=require('./browser-stability-diagnostics.cjs');
const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'home-device-interactions-'));
const engine=process.env.DEVICE_INTERACTIONS_ENGINE||'chromium';
const headless=process.env.DEVICE_INTERACTIONS_HEADED!=='1';
assert(['chromium','firefox','webkit'].includes(engine));
(async()=>{
 let browser,server;
 const errors=[],consoleErrors=[],external=[],pages=[];
 const errorText=value=>String(value).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g,'[embedded Three.js]').slice(0,8000);
 const viewerDiagnostics=()=>Promise.all(pages.flatMap(page=>page.frames()).filter(frame=>frame.parentFrame()).map(async frame=>{
  try{return await frame.evaluate(()=>{
   const error=document.querySelector('#loadError');
   return {errorVisible:!!error&&getComputedStyle(error).display!=='none',errorText:error?.textContent,renderCount:window.floorplan?.renderCount};
  });}catch{return {unavailable:true};}
 }));
 try{
  const project=JSON.parse(fs.readFileSync(path.join(root,'planner/example-home.json'),'utf8'));
  const source=project.floors[0].items[0];
  project.floors[0].items=[['audio','media_player.speaker','appliance'],['tv','media_player.screen','tv'],['light','light.fixture','lamp'],['cover','cover.curtain','appliance']].map(([id,entity_id,type],i)=>({...source,id,entity_id,type,name:id,position_m:{x:1+i*.7,y:.1,z:1},dimensions_m:{width:.2,height:.2,depth:.2}}));
  fs.writeFileSync(path.join(temporary,'project.json'),JSON.stringify(project));
  const compiled=spawnSync(process.env.PYTHON||'python3',['scripts/build-planner-project.py','--project',path.join(temporary,'project.json'),'--output',path.join(temporary,'build')],{cwd:root,encoding:'utf8'});
  assert.equal(compiled.status,0,compiled.stderr||compiled.stdout);
  let html=fs.readFileSync(path.join(temporary,'build/main/index.html'),'utf8');
  const model=JSON.parse(fs.readFileSync(path.join(temporary,'build/main/model-data.json'),'utf8'));
  // Unreferenced vertices preserve the rendered triangles while exercising a large real geometry field.
  const mesh=model.meshes[0];
  for(let n=0;n<26000;n++){mesh.vertices.push([...mesh.vertices[0]]);mesh.normals.push([...mesh.normals[0]]);}
  model.telemetry=[{id:'telemetry_probe',name:'Fixture telemetry',position_m:{x:0,y:0,z:0},metrics:[{label:'Reading',entity_id:'sensor.telemetry_probe',format:'number'}]}];
  model.power_labels=[{id:'power_probe',room_ids:['studio'],entity_id:'sensor.power_probe',name:'Fixture power'}];
  model.room_activity={studio:'sensor.room_activity_probe'};
  model.receiver_activity={unused_receiver:{entity_id:'binary_sensor.receiver_probe',sensor:'sensor.receiver_activity_probe',modules_sensor:'sensor.receiver_modules_probe',room:'studio'}};
  model.motion_sources={'binary_sensor.unused_motion':['binary_sensor.motion_source_probe']};
  model.motion_zones={unused_motion:{entity_id:'sensor.motion_zone_probe'}};
  model.camera_entities={unused_camera:'camera.preview_probe'};
  html=html.replace(/(<script id="modelData" type="application\/json">)[\s\S]*?(<\/script>)/,(_,a,b)=>a+JSON.stringify(model).replaceAll('<','\\u003c')+b).replace('<head>','<head><script>window.__HOME_FLOORPLAN_EMBED__=true;</script>');
  server=http.createServer((request,response)=>{response.setHeader('Content-Type','text/html');response.end('<!doctype html><style>body{margin:0}iframe{width:100%;height:100vh;border:0}dialog{width:100vw;height:100vh;max-width:none;max-height:none;margin:0;border:0;padding:0}dialog::backdrop{background:#0008}#parentControl{position:fixed;right:0;top:0;z-index:3}</style><button id="parentControl">Parent control</button><dialog id="native"><button onclick="this.parentElement.close()">Close native details</button></dialog>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await ({chromium,firefox,webkit}[engine]).launch(browserLaunchOptions(engine,headless));
  async function mount(context){
   const page=await context.newPage();pages.push(page);page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(errorText(e)));
   page.on('console',message=>{
    if(message.type()!=='error')return;
    const text=errorText(message.text());consoleErrors.push(text);console.error('Browser console.error ('+engine+'): '+text);
   });
   await page.route('**/*',route=>{if(route.request().url().startsWith(origin+'/'))return route.continue();external.push(route.request().url());return route.abort();});
   await page.goto(origin);
   await page.evaluate(html=>{const el=document.createElement('iframe');el.sandbox='allow-scripts';el.srcdoc=html;document.body.append(el);},html);
   const frame=page.frameLocator('iframe');await frame.locator('#loadError').waitFor({state:'attached'});
   const viewer=await (await page.locator('iframe').elementHandle()).contentFrame();
   await viewer.waitForFunction(()=>{
    const error=document.querySelector('#loadError');
    return (error&&getComputedStyle(error).display!=='none')||window.floorplan?.renderCount>0;
   });
   assert.equal(await frame.locator('#loadError').isVisible(),false,
    '3D viewer startup failed ('+engine+', '+(headless?'headless':'headed')+'): '+
    await frame.locator('#loadError').innerText()+'\n'+[...errors,...consoleErrors].join('\n'));
   await frame.locator('#homeRoom').waitFor();
   await page.evaluate(items=>{
    const channel=new MessageChannel();window.channel=channel.port1;window.messages=[];
    window.nativeHoverProbes={};
    const viewerWindow=document.querySelector('iframe').contentWindow;
    window.addEventListener('message',event=>{
     if(event.source===viewerWindow&&event.data?.type==='fixture:hover-probe')nativeHoverProbes[event.data.id]=event.data;
    });
    // The trusted host listens on its own document; hovering the opaque frame
    // deliberately leaves keyboard focus here until the user chooses a control.
    window.parentDismissals=[];
    document.addEventListener('keydown',event=>{if(event.key==='Escape'){parentDismissals.push('escape');channel.port1.postMessage({type:'dismiss_overlays'});}});
    document.addEventListener('pointerdown',event=>{if(!event.composedPath().includes(document.querySelector('iframe'))){parentDismissals.push('pointer');channel.port1.postMessage({type:'dismiss_overlays'});}});
    channel.port1.onmessage=event=>{
     const message=event.data;messages.push({...message,received_at:Date.now()});
     if(message.type==='more_info')document.querySelector('#native').showModal();
     if(message.type==='media_command')channel.port1.postMessage({type:'command_result',entity_id:message.entity_id,request_id:message.request_id,ok:true});
    };
    window.states={
     'media_player.speaker':{state:'playing',media:{state:'playing',title:'Track <img src=x>',artist:'Fictional artist',album:'Fixture album',supported_features:20533,volume_level:.42}},
     'media_player.screen':{state:'on',media:{state:'on',supported_features:384}},
     'light.fixture':{state:'on',light:{brightness:128}},
     'cover.curtain':{state:'open',cover:{current_position:50,supported_features:15}},
    };
    window.publish=()=>channel.port1.postMessage({type:'states',states,connected:true});
    document.querySelector('iframe').contentWindow.postMessage({type:'home-floorplan:init',items},'*',[channel.port2]);
   },project.floors[0].items);
   await page.waitForFunction(()=>messages.some(m=>m.type==='model_config'));
   await page.evaluate(()=>publish());
   await frame.locator('[data-home-device="audio"][data-state="on"]').waitFor();
   return {page,frame};
  }
  async function closeNative(page){
   // This bare HTML fixture has no HA focus manager. In Firefox, an iframe
   // click can return focus to BODY after showModal; focus the native control
   // before testing Escape, without moving the pointer off its viewer marker.
   await page.locator('#native button').focus();await page.keyboard.press('Escape');
   await page.locator('#native').waitFor({state:'hidden'});
  }
  let hoverProbeSequence=0;
  async function checkHoverCancellation(page,frame,cancel){
   // Hold only the native-hover deadline. Protocol latency cannot let the
   // deadline win, while actual pointer/keyboard/pagehide handlers still run.
   await frame.locator('#homeConnection').hover();
   const id=String(++hoverProbeSequence),viewer=await (await page.locator('iframe').elementHandle()).contentFrame();
   const before=await page.evaluate(()=>messages.filter(message=>['more_info','media_command','toggle','curtain_command','tv_power'].includes(message.type)).length);
   await viewer.evaluate(id=>{
    const originalSet=window.setTimeout,originalClear=window.clearTimeout,held=new Set();
    let next=-1,armed=0,cleared=0,restored=false;
    const report=()=>parent.postMessage({type:'fixture:hover-probe',id,armed,cleared,pending:held.size,restored},'*');
    const restore=()=>{
     if(restored)return;
     window.setTimeout=originalSet;window.clearTimeout=originalClear;
     window.removeEventListener('pagehide',restore);
     // Cleanup does not count as cancellation by the production handler.
     restored=true;report();held.clear();delete window.restoreNativeHoverProbe;
    };
    window.setTimeout=function(callback,delay,...args){
     if(delay!==650)return originalSet.call(window,callback,delay,...args);
     const timer=next--;held.add(timer);armed++;report();return timer;
    };
    window.clearTimeout=function(timer){
     if(held.delete(timer)){cleared++;report();}else originalClear.call(window,timer);
    };
    window.restoreNativeHoverProbe=restore;
    // Registered after the viewer: its real pagehide cancellation must happen
    // before cleanup reports the final counts to the surviving parent frame.
    window.addEventListener('pagehide',restore);
   },id);
   try{
    await frame.locator('[data-home-device="light"]').hover();
    await page.waitForFunction(id=>nativeHoverProbes[id]?.armed>0,id);
    const armed=await page.evaluate(id=>nativeHoverProbes[id],id);
    assert.equal(armed.pending,1,'a real pointer hover must arm the held native deadline');
    await cancel();
    await page.waitForFunction(id=>{
     const probe=nativeHoverProbes[id];
     return probe?.armed>0&&probe.cleared===probe.armed&&probe.pending===0;
    },id);
    const result=await page.evaluate(id=>nativeHoverProbes[id],id);
    assert.equal(result.cleared,result.armed,'the production handler must cancel every armed hover deadline');
    assert.equal(result.pending,0,'no native deadline may survive cancellation');
    assert.equal(await page.evaluate(()=>messages.filter(message=>['more_info','media_command','toggle','curtain_command','tv_power'].includes(message.type)).length),before,
     'canceling hover must not open native details or issue a device command');
   }finally{
    if(!viewer.isDetached())await viewer.evaluate(()=>window.restoreNativeHoverProbe?.());
   }
  }
  {
  const desktop=await browser.newContext({viewport:{width:1440,height:1000}}),{page,frame}=await mount(desktop);
  const config=await page.evaluate(()=>messages.find(m=>m.type==='model_config'));
  for(const id of ['sensor.telemetry_probe','sensor.power_probe','sensor.room_activity_probe','binary_sensor.receiver_probe','sensor.receiver_activity_probe','sensor.receiver_modules_probe','binary_sensor.motion_source_probe','sensor.motion_zone_probe','camera.preview_probe'])assert(config.state_entities.includes(id),'large geometry must not hide dependency '+id);
  const initial=await page.evaluate(()=>JSON.stringify(states));
  const card=id=>frame.locator(`[data-home-device="${id}"]`),popup=frame.locator('#homeMediaControls');
  await card('audio').hover();await popup.waitFor({state:'visible'});await popup.hover();
  assert.equal(await popup.locator('.media-controls-track').textContent(),'Track <img src=x> · Fictional artist · Fixture album');
  assert.equal(await popup.locator('input[type="range"]').inputValue(),'42');
  assert.equal(await popup.locator('img').count(),0);
  assert.deepEqual(await page.evaluate(()=>messages.filter(m=>['media_command','toggle','curtain_command','tv_power','more_info'].includes(m.type))),[],'hover only opens local controls');
  const level=popup.locator('input[type="range"]');
  await level.evaluate(el=>{el.value='60';el.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='media_command').length),0,'an unfinished range drag sends no command');
  await level.evaluate(el=>el.dispatchEvent(new Event('change',{bubbles:true})));
  await page.waitForFunction(()=>messages.filter(m=>m.type==='media_command').length===1);
  assert.deepEqual(await page.evaluate(()=>messages.filter(m=>m.type==='media_command').map(({action,value})=>({action,value}))),[{action:'volume_set',value:60}]);
  const pause=popup.locator('[data-media-action="media_pause"]');
  const pausePoint=await pause.evaluate(el=>{const rect=el.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};});
  // Keep a real native target beneath the popup across browser font metrics.
  // Dismissing the popup must not treat newly exposed content as pointer intent.
  const coverStyle=await card('cover').evaluate((el,point)=>{
   const rect=el.getBoundingClientRect(),original=el.getAttribute('style');
   if(point.x<rect.left+8||point.x>rect.right-8||point.y<rect.top+8||point.y>rect.bottom-8)
    Object.assign(el.style,{position:'fixed',left:(point.x-60)+'px',top:(point.y-22)+'px',width:'120px',height:'44px',zIndex:'1'});
   return original;
  },pausePoint);
  await pause.evaluate(el=>el.addEventListener('pointerdown',event=>{
   window.fixturePausePointer={x:event.clientX,y:event.clientY};
  },{once:true}));
  await pause.click();
  const stationaryPointer=await pause.evaluate(()=>window.fixturePausePointer);
  await page.waitForFunction(()=>messages.filter(m=>m.type==='media_command').length===2);
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='media_command').at(-1).action),'media_pause');
  assert.equal(await page.evaluate(()=>JSON.stringify(states)),initial,'control UI never fabricates HA state');
  await page.keyboard.press('Escape');await popup.waitFor({state:'hidden'});
  assert.equal(await card('cover').evaluate((el,point)=>el.contains(document.elementFromPoint(point.x,point.y)),stationaryPointer),true,
   'the stationary pointer now rests over the exposed curtain control');
  // Layout changes can also replay pointermove at the last physical position.
  // Use recorded event coordinates rather than the rounded element center.
  for(const type of ['pointerenter','pointermove'])await card('cover').dispatchEvent(type,{
   pointerType:'mouse',buttons:0,clientX:stationaryPointer.x,clientY:stationaryPointer.y,
  });
  await page.waitForTimeout(750);assert.equal(await popup.isVisible(),false,'focus restoration does not reopen the remote');
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='more_info').length),0,
   'dismissing audio must not open unrelated native details under a stationary pointer');
  const iframeBox=await page.locator('iframe').boundingBox();
  await page.mouse.move(iframeBox.x+stationaryPointer.x+4,iframeBox.y+stationaryPointer.y);
  await page.locator('#native').waitFor({state:'visible'});
  assert.deepEqual(await page.evaluate(()=>messages.filter(m=>m.type==='more_info').map(m=>m.entity_id)),['cover.curtain'],
   'deliberate movement over the exposed target still opens its native details');
  await closeNative(page);
  await card('cover').evaluate((el,style)=>{if(style===null)el.removeAttribute('style');else el.setAttribute('style',style);},coverStyle);
  await frame.locator('#homeConnection').hover();
  const nativeBeforeKeyboard=await page.evaluate(()=>messages.filter(m=>m.type==='more_info').length);
  // Keyboard and click use the same remote without dispatching an action.
  await frame.locator('#homeRoom').focus();await card('audio').focus();await popup.waitFor({state:'visible'});await card('audio').press('Enter');
  assert.equal(await popup.evaluate(el=>document.activeElement===el),true);
  await page.keyboard.press('Escape');await popup.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='media_command').length),2);
  // Parent-focused Escape and outside pointerdown cross the bridge without
  // moving focus into the iframe or dispatching a device action.
  const parentControl=page.locator('#parentControl');
  await parentControl.focus();await frame.locator('#homeConnection').hover();await card('audio').hover();await popup.waitFor({state:'visible'});
  assert.equal(await parentControl.evaluate(el=>document.activeElement===el),true,'hover does not steal parent keyboard focus');
  await page.keyboard.press('Escape');await popup.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>parentDismissals.at(-1)),'escape');
  assert.equal(await parentControl.evaluate(el=>document.activeElement===el),true,'dismissal preserves parent keyboard focus');
  await frame.locator('#homeConnection').hover();await card('audio').hover();await popup.waitFor({state:'visible'});
  await parentControl.click();await popup.waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>parentDismissals.at(-1)),'pointer');
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='media_command').length),2);
  // Escape also cancels a pending native hover while the pointer stays over it.
  await checkHoverCancellation(page,frame,()=>page.keyboard.press('Escape'));
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='more_info').length),nativeBeforeKeyboard,'parent dismissal cancels the delayed native dialog');
  // Leave a native target before its delay: no native dialog and no command.
  await checkHoverCancellation(page,frame,()=>frame.locator('#homeConnection').hover());
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='more_info').length),nativeBeforeKeyboard);
  for(const id of ['tv','light','cover']){
   await frame.locator('#homeConnection').hover();
   await card(id).evaluate(el=>el.addEventListener('pointerenter',()=>{window.fixtureHoverAt=Date.now();},{once:true}));
   const before=await page.evaluate(()=>messages.filter(m=>m.type==='more_info').length);
   await card(id).hover();await page.locator('#native').waitFor({state:'visible'});
   const sent=await page.evaluate(()=>messages.filter(m=>m.type==='more_info').at(-1));
   const entered=await card(id).evaluate(()=>window.fixtureHoverAt);
   assert(sent.received_at-entered>=640,'native details waits for the hover delay');
   assert.equal(sent.entity_id,{tv:'media_player.screen',light:'light.fixture',cover:'cover.curtain'}[id]);
   await closeNative(page);
   // Native HA dialog teardown can re-enter the same marker without a pointer move.
   await card(id).dispatchEvent('pointerenter',{pointerType:'mouse',buttons:0});await page.waitForTimeout(750);
   assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='more_info').length),before+1,'closing native details on the same anchor does not reopen');
  }
  // Explicit clicks must also survive a native modal returning the pointer to its trigger.
  await frame.locator('#homeConnection').hover();
  const beforeClick=await page.evaluate(()=>messages.filter(m=>m.type==='more_info').length);
  await card('tv').click();await page.locator('#native').waitFor({state:'visible'});
  await closeNative(page);
  await card('tv').dispatchEvent('pointerenter',{pointerType:'mouse',buttons:0});await page.waitForTimeout(750);
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='more_info').length),beforeClick+1,'closing explicitly opened native details does not reopen');
  assert.deepEqual(await page.evaluate(()=>messages.filter(m=>['toggle','curtain_command','tv_power'].includes(m.type))),[],'native hover never toggles, powers or moves a device');
  await frame.locator('[data-home-details="light"]').focus();await frame.locator('[data-home-details="light"]').press('Enter');await page.locator('#native').waitFor({state:'visible'});await closeNative(page);
  // Catalogue entries are metadata, not 5,500 live states or thousands of DOM nodes.
  await page.evaluate(()=>channel.postMessage({type:'entity_catalog',entities:Array.from({length:5500},(_,i)=>['sensor.catalog_'+String(i).padStart(4,'0'),'Fixture sensor '+i])}));
  await frame.locator('#editLayout').click();
  await frame.locator('#haEntities option').nth(79).waitFor({state:'attached'});
  assert.equal(await frame.locator('#haEntities option').count(),80);
  await frame.locator('#entity').fill('catalog_5499');
  await frame.locator('#haEntities option[value="sensor.catalog_5499"]').waitFor({state:'attached'});
  assert.equal(await frame.locator('#haEntities option').count(),1);
  assert.equal(await page.evaluate(()=>Object.keys(states).length),4);
  await frame.locator('#openHome').click();await card('audio').hover();await popup.waitFor({state:'visible'});
  await frame.locator('#homeRoom').selectOption('living');await popup.waitFor({state:'hidden'});
  await frame.locator('#homeRoom').selectOption('');
  await frame.locator('#homeConnection').hover();
  await card('audio').hover();await popup.waitFor({state:'visible'});
  await frame.locator('#editLayout').click();await popup.waitFor({state:'hidden'});
  await frame.locator('#openHome').click();await frame.locator('#homeConnection').hover();
  const beforeDetach=await page.evaluate(()=>messages.filter(m=>m.type==='more_info').length);
  // Removal-time messages lose their source in Firefox/WebKit. Exercise our
  // lifecycle handler while connected, then separately destroy the context.
  await checkHoverCancellation(page,frame,()=>frame.locator('#homeView').evaluate(()=>
   window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:false}))));
  await page.evaluate(()=>document.querySelector('iframe').remove());await page.waitForTimeout(750);
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='more_info').length),beforeDetach,'hidden then detached viewer emits no late native details');
  // Touch must have an explicit route; touch pointer entry itself does not launch native details.
  }
  const touchContext=await browser.newContext({viewport:{width:900,height:1000},hasTouch:true}),touch=await mount(touchContext);
  const touchAudio=touch.frame.locator('[data-home-device="audio"]'),touchPopup=touch.frame.locator('#homeMediaControls');
  await touchAudio.tap();await touchPopup.waitFor({state:'visible'});
  assert.equal(await touch.page.evaluate(()=>messages.filter(m=>m.type==='media_command').length),0);
  await touchPopup.locator('[data-media-action="media_pause"]').tap();await touch.page.waitForFunction(()=>messages.filter(m=>m.type==='media_command').length===1);
  await touch.page.waitForTimeout(250);
  assert.equal(await touchPopup.isVisible(),true,'touch command and temporary focus loss must not dismiss the remote');
  await touchPopup.getByRole('button',{name:'Close media controls',exact:true}).tap();
  await touchPopup.waitFor({state:'hidden'});
  await touch.frame.locator('[data-home-details="light"]').tap();await touch.page.locator('#native').waitFor({state:'visible'});
  assert.deepEqual(await touch.page.evaluate(()=>messages.filter(m=>['toggle','curtain_command','tv_power'].includes(m.type))),[]);
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  const liveViewers=await viewerDiagnostics();
  assert(liveViewers.length>0,'a live viewer remains after lifecycle checks');
  for(const viewer of liveViewers){
   assert.equal(viewer.errorVisible,false,'live viewer has no 3D failure: '+JSON.stringify(viewer));
   assert(viewer.renderCount>0,'live viewer completed a real 3D frame: '+JSON.stringify(viewer));
  }
  console.log('PASS ('+engine+'): generated viewer media/native hover, explicit commands, keyboard/touch, 5,500-entity search and dense-model dependencies');
 }catch(error){
  const viewers=await viewerDiagnostics();
  const nativeMessages=await Promise.all(pages.map(async(page,index)=>{
   try{return {page:index,...await page.evaluate(()=>{
    const requests=Array.isArray(window.messages)?window.messages.filter(message=>message.type==='more_info'):[];
    return {count:requests.length,recent:requests.slice(-12).map(message=>({entity_id:String(message.entity_id).slice(0,128),received_at:message.received_at}))};
   })};}catch{return {page:index,unavailable:true};}
  }));
  console.error('Device interaction diagnostics: '+JSON.stringify({engine,headless,viewers,pageErrors:errors,consoleErrors,nativeMessages}));
  if(viewers.some(viewer=>viewer.errorVisible))throw Error('3D viewer failed ('+engine+', '+(headless?'headless':'headed')+'); see loadError and browser console diagnostics above.',{cause:error});
  throw error;
 }finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(temporary,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
