// Integrated generated-viewer interactions with fictional HA state and a mocked parent only.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const http=require('node:http'),{spawnSync}=require('node:child_process'),{chromium}=require('playwright');
const {browserLaunchOptions}=require('./browser-stability-diagnostics.cjs');
const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'home-device-interactions-'));
(async()=>{
 let browser,server;
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
  browser=await chromium.launch(browserLaunchOptions('chromium',true));
  const errors=[],external=[];
  async function mount(context){
   const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(String(e)));
   await page.route('**/*',route=>{if(route.request().url().startsWith(origin+'/'))return route.continue();external.push(route.request().url());return route.abort();});
   await page.goto(origin);
   await page.evaluate(html=>{const el=document.createElement('iframe');el.sandbox='allow-scripts';el.srcdoc=html;document.body.append(el);},html);
   const frame=page.frameLocator('iframe');await frame.locator('#homeRoom').waitFor();
   await page.evaluate(items=>{
    const channel=new MessageChannel();window.channel=channel.port1;window.messages=[];
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
  await popup.locator('[data-media-action="media_pause"]').click();
  await page.waitForFunction(()=>messages.filter(m=>m.type==='media_command').length===2);
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='media_command').at(-1).action),'media_pause');
  assert.equal(await page.evaluate(()=>JSON.stringify(states)),initial,'control UI never fabricates HA state');
  await page.keyboard.press('Escape');await popup.waitFor({state:'hidden'});
  await page.waitForTimeout(250);assert.equal(await popup.isVisible(),false,'focus restoration does not reopen the remote');
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
  await card('light').hover();await page.waitForTimeout(350);await page.keyboard.press('Escape');await page.waitForTimeout(400);
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='more_info').length),0,'parent dismissal cancels the delayed native dialog');
  // Leave a native target before its delay: no native dialog and no command.
  await frame.locator('#homeConnection').hover();await card('light').hover();await page.waitForTimeout(350);await frame.locator('#homeConnection').hover();await page.waitForTimeout(400);
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='more_info').length),0);
  for(const id of ['tv','light','cover']){
   await frame.locator('#homeConnection').hover();
   await card(id).evaluate(el=>el.addEventListener('pointerenter',()=>{window.fixtureHoverAt=Date.now();},{once:true}));
   const before=await page.evaluate(()=>messages.filter(m=>m.type==='more_info').length);
   await card(id).hover();await page.locator('#native').waitFor({state:'visible'});
   const sent=await page.evaluate(()=>messages.filter(m=>m.type==='more_info').at(-1));
   const entered=await card(id).evaluate(()=>window.fixtureHoverAt);
   assert(sent.received_at-entered>=640,'native details waits for the hover delay');
   assert.equal(sent.entity_id,{tv:'media_player.screen',light:'light.fixture',cover:'cover.curtain'}[id]);
   await page.keyboard.press('Escape');await page.locator('#native').waitFor({state:'hidden'});
   // Native HA dialog teardown can re-enter the same marker without a pointer move.
   await card(id).dispatchEvent('pointerenter',{pointerType:'mouse',buttons:0});await page.waitForTimeout(750);
   assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='more_info').length),before+1,'closing native details on the same anchor does not reopen');
  }
  // Explicit clicks must also survive a native modal returning the pointer to its trigger.
  await frame.locator('#homeConnection').hover();
  const beforeClick=await page.evaluate(()=>messages.filter(m=>m.type==='more_info').length);
  await card('tv').click();await page.locator('#native').waitFor({state:'visible'});
  await page.keyboard.press('Escape');await page.locator('#native').waitFor({state:'hidden'});
  await card('tv').dispatchEvent('pointerenter',{pointerType:'mouse',buttons:0});await page.waitForTimeout(750);
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='more_info').length),beforeClick+1,'closing explicitly opened native details does not reopen');
  assert.deepEqual(await page.evaluate(()=>messages.filter(m=>['toggle','curtain_command','tv_power'].includes(m.type))),[],'native hover never toggles, powers or moves a device');
  await frame.locator('[data-home-details="light"]').focus();await frame.locator('[data-home-details="light"]').press('Enter');await page.locator('#native').waitFor({state:'visible'});await page.keyboard.press('Escape');
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
  await card('audio').hover();await popup.waitFor({state:'visible'});
  await frame.locator('#editLayout').click();await popup.waitFor({state:'hidden'});
  await frame.locator('#openHome').click();await frame.locator('#homeConnection').hover();
  const beforeDetach=await page.evaluate(()=>messages.filter(m=>m.type==='more_info').length);
  await card('light').hover();await page.waitForTimeout(250);
  await page.evaluate(()=>document.querySelector('iframe').remove());await page.waitForTimeout(750);
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='more_info').length),beforeDetach,'detaching the viewer cancels pending native hover');
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
  console.log('PASS: generated viewer media/native hover, explicit commands, keyboard/touch, 5,500-entity search and dense-model dependencies');
 }finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(temporary,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
