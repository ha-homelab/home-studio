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
  project.floors[0].items=[['audio','media_player.speaker','appliance'],['tv','media_player.screen','tv'],['light','light.fixture','lamp'],['cover','cover.curtain','appliance'],['switch','switch.fixture','appliance']].map(([id,entity_id,type],i)=>({...source,id,entity_id,type,name:id,position_m:{x:1+i*.7,y:.1,z:1},dimensions_m:{width:.2,height:.2,depth:.2}}));
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
    window.nativePressProbes={};
    const viewerWindow=document.querySelector('iframe').contentWindow;
    window.addEventListener('message',event=>{
     if(event.source===viewerWindow&&event.data?.type==='fixture:press-probe')nativePressProbes[event.data.id]=event.data;
    });
    // The trusted host listens on its own document; hovering the opaque frame
    // deliberately leaves keyboard focus here until the user chooses a control.
    window.parentDismissals=[];
    document.addEventListener('keydown',event=>{if(event.key==='Escape'){parentDismissals.push('escape');channel.port1.postMessage({type:'dismiss_overlays'});}});
    document.addEventListener('pointerdown',event=>{if(!event.composedPath().includes(document.querySelector('iframe'))){parentDismissals.push('pointer');channel.port1.postMessage({type:'dismiss_overlays'});}});
    channel.port1.onmessage=event=>{
     if(event.data.type==='map_request'&&event.data.action==='get'){
      channel.port1.postMessage({type:'map_result',request_id:event.data.request_id,success:true,result:{revision:0,configured:false,config:null,reference:null}});return;
     }
     const message=event.data;messages.push({...message,received_at:Date.now()});
     if(message.type==='more_info')document.querySelector('#native').showModal();
     if(message.type==='media_command')channel.port1.postMessage({type:'command_result',entity_id:message.entity_id,request_id:message.request_id,ok:true});
    };
    window.states={
     'media_player.speaker':{state:'playing',media:{state:'playing',title:'Track <img src=x>',artist:'Fictional artist',album:'Fixture album',supported_features:20533,volume_level:.42}},
     'media_player.screen':{state:'on',media:{state:'on',supported_features:384}},
     'light.fixture':{state:'on',light:{brightness:128}},
     'cover.curtain':{state:'open',cover:{current_position:50,supported_features:15}},
     'switch.fixture':{state:'off'},
    };
    window.publish=()=>channel.port1.postMessage({type:'states',states,connected:true});
    document.querySelector('iframe').contentWindow.postMessage({type:'home-floorplan:init',can_edit:true,items},'*',[channel.port2]);
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
  let pressProbeSequence=0;
  const commandTypes=['more_info','media_command','toggle','curtain_command','tv_power'];
  const sentCommands=page=>page.evaluate(types=>messages.filter(message=>types.includes(message.type)),commandTypes);
  async function pointerEvent(target,type,pointerType='mouse',extra={}){
   const point=await target.evaluate(el=>{const r=el.getBoundingClientRect();return {clientX:r.x+r.width/2,clientY:r.y+r.height/2};});
   await target.dispatchEvent(type,{pointerId:41,pointerType,isPrimary:true,button:0,buttons:type==='pointerup'?0:1,...point,...extra});
  }
  async function checkPressCancellation(page,frame,cancellation,pointerType='mouse'){
   // Hold only the native-press deadline. Slow protocol round trips cannot
   // race the deadline, while the real production event handlers still run.
   const target=frame.locator('[data-home-device="light"]');
   const id=String(++pressProbeSequence),viewer=await (await page.locator('iframe').elementHandle()).contentFrame();
   const before=await sentCommands(page);
   await viewer.evaluate(id=>{
    const originalSet=window.setTimeout,originalClear=window.clearTimeout,held=new Set();
    let next=-1,armed=0,cleared=0,restored=false;
    const report=()=>parent.postMessage({type:'fixture:press-probe',id,armed,cleared,pending:held.size,restored},'*');
    const restore=()=>{
     if(restored)return;
     window.setTimeout=originalSet;window.clearTimeout=originalClear;
     window.removeEventListener('pagehide',restore);
     restored=true;report();held.clear();delete window.restoreNativePressProbe;
    };
    window.setTimeout=function(callback,delay,...args){
     if(delay!==650)return originalSet.call(window,callback,delay,...args);
     const timer=next--;held.add(timer);armed++;report();return timer;
    };
    window.clearTimeout=function(timer){
     if(held.delete(timer)){cleared++;report();}else originalClear.call(window,timer);
    };
    window.restoreNativePressProbe=restore;
    window.addEventListener('pagehide',restore);
   },id);
   try{
    await pointerEvent(target,'pointerdown',pointerType);
    await page.waitForFunction(id=>nativePressProbes[id]?.armed>0,id);
    const armed=await page.evaluate(id=>nativePressProbes[id],id);
    assert.equal(armed.pending,1,`${pointerType}: primary press arms one native deadline`);
    if(cancellation==='secondary-contact'||cancellation==='primary-other')await pointerEvent(target,'pointerdown',
     cancellation==='primary-other'?(pointerType==='touch'?'mouse':'touch'):pointerType,{pointerId:42,isPrimary:cancellation==='primary-other'});
    else if(cancellation==='movement')await pointerEvent(target,'pointermove',pointerType,{clientX:0,clientY:0});
    else if(cancellation==='hidden')await viewer.evaluate(()=>{
     Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
     document.dispatchEvent(new Event('visibilitychange'));
    });
    else if(cancellation==='dismiss')await page.evaluate(()=>channel.postMessage({type:'dismiss_overlays'}));
    else if(cancellation==='pagehide')await viewer.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:false})));
    else await pointerEvent(target,cancellation,pointerType);
    await page.waitForFunction(id=>{
     const probe=nativePressProbes[id];
     return probe?.armed>0&&probe.cleared===probe.armed&&probe.pending===0;
    },id);
    if(cancellation==='secondary-contact'||cancellation==='primary-other'){
     const secondType=cancellation==='primary-other'?(pointerType==='touch'?'mouse':'touch'):pointerType;
     await pointerEvent(target,'pointerup',pointerType);
     await pointerEvent(target,'click',pointerType,{buttons:0,detail:1});
     await pointerEvent(target,'pointerup',secondType,{pointerId:42});
     await pointerEvent(target,'click',secondType,{pointerId:42,buttons:0,detail:1});
     await page.waitForTimeout(80);
    }
    assert.deepEqual(await sentCommands(page),before,`${pointerType} ${cancellation}: canceled press sends no native details or device command`);
   }finally{
    if(!viewer.isDetached()){
     await pointerEvent(target,'pointercancel',pointerType);
     await pointerEvent(target,'pointercancel',pointerType,{pointerId:42});
     await pointerEvent(target,'pointercancel',pointerType==='touch'?'mouse':'touch',{pointerId:42});
     await viewer.evaluate(()=>{
      delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));
      window.restoreNativePressProbe?.();
     });
    }
   }
  }
  async function checkNativeHold(page,frame,id,pointerType='mouse',selector='data-home-device'){
   const target=frame.locator(`[${selector}="${id}"]`),before=await sentCommands(page);
   await target.evaluate(el=>el.addEventListener('pointerdown',()=>{window.fixturePressAt=Date.now();},{once:true}));
   await pointerEvent(target,'pointerdown',pointerType);
   await page.locator('#native').waitFor({state:'visible'});
   const commands=await sentCommands(page),last=commands.at(-1);
   assert.equal(commands.length,before.length+1,`${pointerType} ${id}: one hold sends exactly one request`);
   assert.equal(last.type,'more_info');
   assert.equal(last.entity_id,{tv:'media_player.screen',light:'light.fixture',cover:'cover.curtain',switch:'switch.fixture'}[id]);
   assert(last.received_at-await target.evaluate(()=>window.fixturePressAt)>=640,'native details waits for the press deadline');
   // A parent modal can hide the original button before the browser emits its
   // compatibility click. Deliver that click explicitly to its original target.
   await pointerEvent(target,'pointerup',pointerType);
   await pointerEvent(target,'click',pointerType,{buttons:0,detail:1});
   await page.waitForTimeout(80);
   assert.deepEqual(await sentCommands(page),commands,`${pointerType} ${id}: release click after a hold cannot toggle or open twice`);
   await closeNative(page);
   await pointerEvent(target,'pointermove',pointerType,{buttons:0});
   await page.waitForTimeout(750);
   assert.deepEqual(await sentCommands(page),commands,`${pointerType} ${id}: released hold does not reopen native details`);
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
  await page.waitForTimeout(750);
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='more_info').length),0,
   'movement over the exposed curtain without pressing cannot open native details');
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
  // A stationary hover and subsequent pointer movement cannot request HA's
  // native dialog. Audio's separate compact remote remains hoverable above.
  for(const id of ['tv','light','cover','switch'])for(const selector of ['data-home-device','data-home-item']){
   const target=frame.locator(`[${selector}="${id}"]`);
   await frame.locator('#homeConnection').hover();
   await target.hover({force:true});await page.waitForTimeout(750);
   assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='more_info').length),nativeBeforeKeyboard,
    `${id} ${selector}: passive hover must not open native details`);
  }
  // Keyboard focus is passive. A short click on a native-only device is not
  // a request for its properties; explicit Details remains keyboard reachable.
  const beforePassiveFocus=await sentCommands(page);
  for(const id of ['tv','light','cover','switch'])await card(id).focus();
  await page.waitForTimeout(750);
  assert.deepEqual(await sentCommands(page),beforePassiveFocus,'keyboard focus alone cannot open native details');
  await card('tv').click();await page.waitForTimeout(750);
  assert.deepEqual(await sentCommands(page),beforePassiveFocus,'a short native-only card click does not open properties');
  for(const extra of [{button:2,buttons:2},{isPrimary:false,pointerId:42}]){
   await pointerEvent(card('light'),'pointerdown','mouse',extra);
   await page.waitForTimeout(750);
   await pointerEvent(card('light'),'pointercancel','mouse',extra);
   assert.deepEqual(await sentCommands(page),beforePassiveFocus,'non-primary and secondary-button presses cannot open properties');
  }
  for(const cancellation of ['pointerup','movement','pointerleave','pointercancel','lostpointercapture','hidden','dismiss','primary-other'])
   await checkPressCancellation(page,frame,cancellation);
  for(const id of ['tv','light','cover','switch'])await checkNativeHold(page,frame,id);
  await checkNativeHold(page,frame,'light','mouse','data-home-item');
  // Also exercise a trusted browser mouse press, not just dispatched events.
  await frame.locator('#homeConnection').hover();
  const beforeRealHold=await sentCommands(page);
  await card('switch').hover();await page.mouse.down();
  await page.locator('#native').waitFor({state:'visible'});await page.mouse.up();
  await closeNative(page);
  assert.equal((await sentCommands(page)).length,beforeRealHold.length+1,'a real mouse hold opens once and does not toggle on release');
  assert.deepEqual(await page.evaluate(()=>messages.filter(m=>['toggle','curtain_command','tv_power'].includes(m.type))),[],
   'hover and native-detail holds never toggle, power or move devices');
  await frame.locator('[data-home-details="light"]').focus();await frame.locator('[data-home-details="light"]').press('Enter');await page.locator('#native').waitFor({state:'visible'});await closeNative(page);
  // Catalogue entries are metadata, not 5,500 live states or thousands of DOM nodes.
  await page.evaluate(()=>channel.postMessage({type:'entity_catalog',entities:Array.from({length:5500},(_,i)=>['sensor.catalog_'+String(i).padStart(4,'0'),'Fixture sensor '+i])}));
  await frame.locator('#editLayout').click();
  await frame.locator('#haEntities option').nth(79).waitFor({state:'attached'});
  assert.equal(await frame.locator('#haEntities option').count(),80);
  await frame.locator('#entity').fill('catalog_5499');
  await frame.locator('#haEntities option[value="sensor.catalog_5499"]').waitFor({state:'attached'});
  assert.equal(await frame.locator('#haEntities option').count(),1);
  assert.equal(await page.evaluate(()=>Object.keys(states).length),5);
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
  await checkPressCancellation(page,frame,'pagehide');
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
  for(const cancellation of ['pointerup','movement','pointerleave','pointercancel','lostpointercapture','hidden','dismiss','secondary-contact','primary-other'])
   await checkPressCancellation(touch.page,touch.frame,cancellation,'touch');
  for(const id of ['light','cover','switch'])await checkNativeHold(touch.page,touch.frame,id,'touch');
  await touch.frame.locator('[data-home-details="light"]').tap();await touch.page.locator('#native').waitFor({state:'visible'});
  await closeNative(touch.page);
  assert.deepEqual(await touch.page.evaluate(()=>messages.filter(m=>['toggle','curtain_command','tv_power'].includes(m.type))),[]);
  await touch.frame.locator('[data-home-device="light"]').tap();
  await touch.page.waitForFunction(()=>messages.filter(message=>message.type==='toggle').length===1);
  assert.equal(await touch.page.evaluate(()=>messages.find(message=>message.type==='toggle').entity_id),'light.fixture',
   'a fresh isolated tap still toggles after canceled overlapping contacts');
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  const liveViewers=await viewerDiagnostics();
  assert(liveViewers.length>0,'a live viewer remains after lifecycle checks');
  for(const viewer of liveViewers){
   assert.equal(viewer.errorVisible,false,'live viewer has no 3D failure: '+JSON.stringify(viewer));
   assert(viewer.renderCount>0,'live viewer completed a real 3D frame: '+JSON.stringify(viewer));
  }
  console.log('PASS ('+engine+'): generated viewer local media hover, native long press, cancellation, release suppression, keyboard/touch, 5,500-entity search and dense-model dependencies');
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
