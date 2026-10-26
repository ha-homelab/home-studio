// Real generated viewer and planner DOM, fictional entities, no Home Assistant or device calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const http=require('node:http'),{spawnSync}=require('node:child_process');
const {chromium}=require('playwright');
const {browserLaunchOptions}=require('./browser-stability-diagnostics.cjs');
const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'home-generic-'));
const screenshotDir=process.env.INDICATOR_QA_DIR;
if(screenshotDir)fs.mkdirSync(screenshotDir,{recursive:true});
const bindings={cold:'sensor.cold',motion:'binary_sensor.motion',entry:'binary_sensor.entry',thermostat:'climate.zone',vacuum:'vacuum.cleaner',action:'button.example',future:'custom_thing.future',fan:'fan.study',light:'light.fixture',missing:'sensor.missing',injected:'sensor.injected',range:'binary_sensor.cooktop',alarm:'binary_sensor.smoke',presence:'binary_sensor.presence',receiver1:'binary_sensor.receiver1',receiver2:'binary_sensor.receiver2'};
(async()=>{
 let browser,server;
 try{
  const project=JSON.parse(fs.readFileSync(path.join(root,'planner/example-home.json'),'utf8'));
  const template=project.floors[0].items[0];
  project.floors[0].items=Object.entries(bindings).map(([id,entity_id],i)=>({...template,id,name:id==='injected'?'<img src=x onerror=alert(1)>':id,entity_id,type:id==='future'?'lamp':'appliance',position_m:{x:1+i*.15,y:0,z:1},dimensions_m:{width:.1,depth:.1,height:.2}}));
  fs.writeFileSync(path.join(temporary,'project.json'),JSON.stringify(project));
  const built=spawnSync(process.env.PYTHON||'python3',['scripts/build-planner-project.py','--project',path.join(temporary,'project.json'),'--output',path.join(temporary,'build')],{cwd:root,encoding:'utf8'});
  assert.equal(built.status,0,built.stderr||built.stdout);
  let plain=fs.readFileSync(path.join(temporary,'build/main/index.html'),'utf8');
  const model=JSON.parse(plain.match(/<script id="modelData" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  model.appliance_status={range:{kind:'cooktop',room:template.room,entity_id:bindings.range,oven_entity_id:'sensor.oven',burners:[[0,.925,0,.15]]},alarm:{kind:'smoke',room:template.room,entity_id:bindings.alarm,battery_entity_id:'sensor.smoke_battery'}};
  model.presence_sources={presence:{room:template.room,entity_id:bindings.presence}};
  model.room_activity={[template.room]:'sensor.room_activity'};
  model.receiver_activity=Object.fromEntries(['receiver1','receiver2'].map(id=>[id,{room:template.room,entity_id:bindings[id],sensor:'sensor.'+id+'_activity'}]));
  plain=plain.replace(/(<script id="modelData" type="application\/json">)[\s\S]*?(<\/script>)/,(_,a,b)=>a+JSON.stringify(model).replaceAll('<','\\u003c')+b);
  const html=plain.replace('<head>','<head><script>window.__HOME_FLOORPLAN_EMBED__=true;</script>');
  server=http.createServer((request,response)=>{
   const route=new URL(request.url,'http://localhost').pathname;
   if(route==='/'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><style>body{margin:0}iframe{width:100%;height:100vh;border:0}</style>');return;}
   if(route==='/offline'){response.setHeader('Content-Type','text/html');response.end(plain);return;}
   const file=path.resolve(root,'.'+route,route.endsWith('/')?'index.html':'');
   if(!file.startsWith(root+path.sep)){response.writeHead(403).end();return;}
   try{response.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');response.end(fs.readFileSync(file));}catch{response.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch(browserLaunchOptions('chromium',true));
  const page=await browser.newPage({viewport:{width:1400,height:950}}),errors=[],external=[];
  page.on('pageerror',error=>errors.push(String(error)));
  await page.route('**/*',route=>{if(route.request().url().startsWith(origin+'/'))return route.continue();external.push(route.request().url());return route.abort();});
  await page.goto(origin);
  await page.evaluate(html=>{const frame=document.createElement('iframe');frame.sandbox='allow-scripts allow-forms';frame.srcdoc=html;document.body.append(frame);},html);
  const frame=page.frameLocator('iframe');
  await frame.locator('#homeRoom').waitFor();
  await page.evaluate(items=>{
   const channel=new MessageChannel();window.messages=[];window.channel=channel.port1;channel.port1.onmessage=event=>{
    if(event.data.type==='map_request'&&event.data.action==='get'){
     channel.port1.postMessage({type:'map_result',request_id:event.data.request_id,success:true,result:{revision:0,configured:false,config:null,reference:null}});return;
    }
    messages.push(event.data);
   };
   document.querySelector('iframe').contentWindow.postMessage({type:'home-floorplan:init',can_edit:true,items},'*',[channel.port2]);
   window.states={
    'binary_sensor.cooktop':{state:'off'},'sensor.oven':{state:'ready'},'binary_sensor.smoke':{state:'off',device_class:'smoke'},'sensor.smoke_battery':{state:'0',unit:'%'},'binary_sensor.presence':{state:'off',device_class:'occupancy'},
    'sensor.cold':{state:'-12.5',unit:'°C',device_class:'temperature'},
    'binary_sensor.entry':{state:'on',device_class:'door'},'binary_sensor.motion':{state:'off',device_class:'motion'},
    'climate.zone':{state:'heat',climate:{current_temperature:18.2,temperature:20,hvac_action:'heating',temperature_unit:'°C'}},
    'vacuum.cleaner':{state:'cleaning'},'button.example':{state:'unknown'},'custom_thing.future':{state:'on'},
    'fan.study':{state:'on'},'light.fixture':{state:'on',light:{brightness:128}},
    'sensor.injected':{state:'<img src=x onerror=alert(2)>',unit:'<svg onload=alert(3)>',device_class:'temperature'},
   };
   states['sensor.room_activity']={state:'unknown',activity:{evidence:{receiver1:'unknown',receiver2:'unknown'},channels:{receiver1:{presence:'off',motion:'off',coverage:'unverified'},receiver2:{presence:'off',motion:'off',coverage:'unverified'}}}};
   window.publish=(connected=true)=>channel.port1.postMessage({type:'states',states,connected});
  },project.floors[0].items);
  await page.waitForFunction(()=>messages.some(m=>m.type==='model_config'));
  await page.evaluate(()=>publish());
  const card=id=>frame.locator(`[data-home-device="${id}"]`);
  async function holdForDetails(id){
   const before=await page.evaluate(()=>messages.filter(message=>message.type==='more_info').length);
   await card(id).hover();await page.mouse.down();
   await page.waitForFunction(before=>messages.filter(message=>message.type==='more_info').length===before+1,before);
   await page.mouse.up();
   assert.equal(await page.evaluate(()=>messages.filter(message=>message.type==='more_info').length),before+1,
    `${id}: releasing a hold does not open native details twice`);
  }
  await card('cold').filter({hasText:'Temperature: -12.5 °C'}).waitFor();
  assert.equal(await frame.locator('[data-home-device]').count(),Object.keys(bindings).length,'every bound domain remains visible');
  assert.match(await card('entry').textContent(),/Door: Open/);
  assert.equal(await card('motion').getAttribute('data-kind'),'motion','late capability projection preserves specialized motion presentation');
  assert.match(await card('thermostat').textContent(),/Current: 18.2 °C.*Target: 20 °C.*Heating/);
  assert.match(await card('vacuum').textContent(),/cleaning/);
  assert.match(await card('action').textContent(),/Unknown/);
  assert.match(await card('missing').textContent(),/Entity not found/);assert.equal(await card('missing').isDisabled(),true);
  assert.match(await card('injected').textContent(),/<img src=x onerror=alert\(2\)>/);
  assert.equal(await card('injected').locator('img,svg[onload]').count(),0,'untrusted display strings are text');
  assert.equal(await card('cold').getAttribute('aria-pressed'),null,'readings are not toggles');
  await card('range').filter({hasText:'Cooktop off · Oven off'}).waitFor();
  assert.match(await card('alarm').textContent(),/OK · 0%/);
  assert.equal(await card('presence').getAttribute('data-kind'),'presence');
  assert.equal(await frame.locator('[data-home-item="presence"]').isVisible(),false,'quiet presence does not cover whole-floor controls');
  await page.evaluate(()=>{states['binary_sensor.cooktop'].state='on';states['binary_sensor.smoke'].state='on';states['binary_sensor.presence'].state='on';publish();});
  await card('range').filter({hasText:'Individual burners are not reported'}).waitFor();
  await card('alarm').filter({hasText:'SMOKE ALARM'}).waitFor();
  assert.equal(await frame.locator('[data-home-item="presence"]').isVisible(),true,'active presence remains inspectable');
  assert.equal(await frame.locator('.cooktop-flames').isVisible(),true);
  assert.equal(await frame.locator('.oven-glow').isVisible(),false);
  assert.equal(await frame.locator('[data-motion-trail="presence"]').count(),0,'held presence never creates footsteps');
  await frame.locator('#homeRoomLabels').click();
  await frame.locator('.home-presence-indicator[data-state="presence"]').waitFor();
  assert.equal(await frame.locator('.home-presence-indicator').evaluate(el=>el.tagName),'polygon','presence follows the room outline');
  if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,'indicators-active.png')});
  await page.evaluate(()=>{states['binary_sensor.cooktop'].state='off';states['sensor.oven'].state='running';publish();});
  await card('range').filter({hasText:'Cooktop off · Oven on'}).waitFor();
  assert.equal(await frame.locator('.cooktop-flames').isVisible(),false);
  assert.equal(await frame.locator('.oven-glow').getAttribute('hidden'),null,'oven does not depend on cooktop state');

  const view=await (await page.locator('iframe').elementHandle()).contentFrame();
  // Separate room presence from per-source movement, using the shipped viewer.
  const glow=frame.locator('.home-presence-indicator'),trails=frame.locator('[data-motion-trail]');
  const channelValue=(presence,motion)=>({presence,motion,coverage:'unverified'});
  const sendActivity=async(changes={},connected=true)=>{
   await page.evaluate(({changes,connected})=>{Object.assign(states['sensor.room_activity'].activity.channels,changes);publish(connected);},{changes,connected});
   await view.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  };
  await page.evaluate(()=>{states['binary_sensor.presence'].state='off';publish(false);});
  await sendActivity({receiver1:channelValue('on','on'),receiver2:channelValue('off','off')});
  assert.equal(await trails.count(),0,'initial or reconnect ON never creates footsteps');
  assert.equal(await glow.getAttribute('data-state'),'presence');
  assert.equal(await glow.evaluate(el=>getComputedStyle(el).fill),'rgb(57, 154, 255)','presence stays blue');
  assert.equal(await glow.getAttribute('data-coverage'),'unverified');
  await frame.locator('#homeRoomLabels').click();
  assert.equal(await frame.locator('#homeRoomLabels').getAttribute('aria-pressed'),'false');
  assert.equal(await glow.isVisible(),true,'room glow is independent of room labels');
  await sendActivity({receiver2:channelValue('on','off')});
  await sendActivity({receiver1:channelValue('off','off')});
  assert.equal(await glow.getAttribute('data-state'),'presence','one source OFF cannot erase another ON');
  await sendActivity({receiver2:channelValue('unknown','off')});
  assert.equal(await glow.getAttribute('data-state'),'unknown');
  assert.equal(await glow.evaluate(el=>getComputedStyle(el).opacity),'0','unknown withdraws the glow immediately');
  await sendActivity({receiver2:channelValue('off','off')});
  assert.equal(await glow.getAttribute('data-state'),'quiet');
  assert.equal(await glow.evaluate(el=>getComputedStyle(el).transitionDuration),'0s','OFF does not leave a fading presence claim');
  await sendActivity({receiver1:{...channelValue('unknown','unknown'),presence_configured:false}});
  assert.equal(await glow.getAttribute('data-state'),'quiet','motion-only unknown is not unavailable presence');
  await frame.locator('#homeToggleActivity').click();await frame.locator('#homeRoom').selectOption(template.room);
  await frame.locator('#homeActivitySummary').filter({hasText:'No presence detected · Motion unknown'}).waitFor();
  await frame.locator('[data-activity-source="receiver1"]').filter({hasText:'Presence not configured'}).waitFor();
  await frame.locator('#homeRoom').selectOption('');await frame.locator('#homeToggleActivity').click();
  await sendActivity({receiver1:channelValue('off','off')});
  await sendActivity({receiver1:channelValue('on','on')});assert.equal(await trails.count(),1);
  await sendActivity({receiver2:channelValue('on','on')});assert.equal(await trails.count(),2,'each source owns its edge');
  assert((await trails.first().evaluate(el=>getComputedStyle(el).clipPath)).startsWith('polygon('),'full footprint stays inside the projected room');
  const projected=await glow.getAttribute('points');
  await frame.locator('#homeStage canvas').focus();await page.keyboard.press('ArrowRight');
  await view.waitForFunction(before=>document.querySelector('.home-presence-indicator').getAttribute('points')!==before,projected);
  await page.waitForTimeout(100);
  const movingIdle=await view.evaluate(()=>window.floorplan.renderCount);await page.waitForTimeout(180);
  assert.equal(await view.evaluate(()=>window.floorplan.renderCount),movingIdle,'footsteps do not add a WebGL rendering loop');
  await page.waitForTimeout(2300);assert.equal(await trails.count(),0,'brief bursts expire during held presence');
  await sendActivity();assert.equal(await trails.count(),0,'repeated ON never restarts the deadline');
  await sendActivity({receiver1:channelValue('on','off')});await sendActivity({receiver1:channelValue('on','on')});
  assert.equal(await trails.count(),1,'a new edge works while presence remains ON');
  await sendActivity({receiver1:channelValue('on','unknown')});assert.equal(await trails.count(),0);
  assert.equal(await glow.getAttribute('data-state'),'presence','motion unavailable does not erase current presence');
  await sendActivity({receiver1:channelValue('unknown','off'),receiver2:channelValue('off','off')});
  await sendActivity({receiver1:channelValue('unknown','on')});assert.equal(await trails.count(),1,'motion survives unknown presence');
  assert.equal(await glow.getAttribute('data-state'),'unknown');
  await sendActivity({},false);assert.equal(await trails.count(),0);assert.equal(await glow.getAttribute('data-state'),'unknown');
  await sendActivity({receiver1:channelValue('on','on')});assert.equal(await trails.count(),0,'reconnect restores glow without replay');
  await sendActivity({receiver1:channelValue('on','off')});await sendActivity({receiver1:channelValue('on','on')});
  await view.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  assert.equal(await trails.count(),0);assert.equal(await frame.locator('.home-presence-layer').isVisible(),false);
  await view.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
  assert.equal(await trails.count(),0,'showing the page does not replay held motion');
  await page.emulateMedia({reducedMotion:'reduce'});
  await sendActivity({receiver1:channelValue('on','off')});await sendActivity({receiver1:channelValue('on','on')});
  assert.equal(await trails.first().locator('.home-footstep').first().evaluate(el=>getComputedStyle(el).animationName),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await view.evaluate(()=>{
   const gl=document.querySelector('#homeStage canvas').getContext('webgl2');
   window.activityContextLoss=gl.getExtension('WEBGL_lose_context');
   if(!window.activityContextLoss)throw Error('Context loss extension is required for lifecycle verification');
   window.activityContextLoss.loseContext();
  });
  await view.waitForFunction(()=>getComputedStyle(document.querySelector('.home-presence-layer')).display==='none');
  assert.equal(await trails.count(),0,'GPU loss clears movement');
  await sendActivity();assert.equal(await frame.locator('.home-presence-layer').isVisible(),false,'new HA states cannot show an orphan glow after GPU loss');
  await view.evaluate(()=>window.activityContextLoss.restoreContext());
  await view.waitForFunction(()=>getComputedStyle(document.querySelector('.home-presence-layer')).display!=='none');
  assert.equal(await trails.count(),0,'GPU restore does not replay motion');
  await sendActivity({receiver1:channelValue('off','off'),receiver2:channelValue('off','off')},false);
  await page.evaluate(()=>{states['binary_sensor.presence'].state='on';publish();});
  await frame.locator('#homeRoomLabels').click();
  await view.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const idleCount=await view.evaluate(()=>window.floorplan.renderCount);
  await page.waitForTimeout(150);
  assert.equal(await view.evaluate(()=>window.floorplan.renderCount),idleCount,'active indicators do not schedule WebGL frames');
  await view.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  assert.equal(await frame.locator('.oven-glow').isVisible(),false,'hidden documents suppress appliance animation');
  await view.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await frame.locator('.oven-glow>span').evaluate(el=>getComputedStyle(el).animationName),'none');
  await page.evaluate(()=>{states['sensor.oven'].restored=true;states['binary_sensor.smoke'].restored=true;states['binary_sensor.presence'].restored=true;publish();});
  await card('alarm').filter({hasText:'Unavailable'}).waitFor();
  assert.equal(await frame.locator('.oven-glow').isVisible(),false);
  assert.equal(await frame.locator('.home-presence-indicator').getAttribute('data-state'),'unknown');
  if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,'indicators-unknown.png')});
  await page.evaluate(()=>{for(const id of ['sensor.oven','binary_sensor.smoke','binary_sensor.presence'])delete states[id].restored;publish();});

  for(const id of ['cold','entry','thermostat','vacuum','action','future'])await card(id).click();
  await page.waitForTimeout(750);
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='more_info').length),0,'short clicks and hover do not inspect generic entities');
  for(const id of ['cold','entry','thermostat','vacuum','action','future'])await holdForDetails(id);
  await page.waitForFunction(()=>messages.filter(m=>m.type==='more_info').length===6);
  for(const id of ['range','alarm','presence'])await holdForDetails(id);
  await page.waitForFunction(()=>messages.filter(m=>m.type==='more_info').length===9);
  assert.deepEqual(await page.evaluate(()=>messages.filter(m=>m.type==='toggle')),[],'generic entities and read-only indicators cannot send toggles');
  assert.equal((await frame.locator('#homeView').evaluate(()=>window.floorplan.illuminated)).includes('future'),false,'a generic entity on a lamp shape does not illuminate');
  for(const id of ['fan','light']){
   await frame.locator(`[data-home-details="${id}"]`).click();
   await card(id).click();
  }
  await page.waitForFunction(()=>messages.filter(m=>m.type==='toggle').length===2);
  assert.deepEqual(await page.evaluate(()=>messages.filter(m=>m.type==='toggle').map(m=>m.entity_id).sort()),['fan.study','light.fixture']);
  await frame.locator('#homeRoom').selectOption('living');
  assert.equal(await frame.locator('[data-home-details="fan"]').isVisible(),false,'Details follows room filtering');
  await frame.locator('#homeRoom').selectOption('');
  for(const [state,label] of [['unknown','Unknown'],['unavailable','Unavailable']]){
   await page.evaluate(state=>{states['sensor.cold'].state=state;publish();},state);
   await card('cold').filter({hasText:label}).waitFor();
  }
  await page.evaluate(()=>{states['sensor.cold']={state:'-12.5',restored:true,unit:'°C'};publish();});
  await card('cold').filter({hasText:'Restored state'}).waitFor();
  await page.evaluate(()=>{states['sensor.injected']={state:'on',device_class:'constructor'};states['climate.zone'].state='constructor';states['climate.zone'].climate={hvac_action:'constructor'};publish();});
  await card('thermostat').filter({hasText:'constructor'}).waitFor();
  await page.evaluate(()=>{states['climate.zone'].state='heat';states['climate.zone'].climate={current_temperature:-5,target_temp_low:18,target_temp_high:23,temperature_unit:'°C'};publish();});
  await card('thermostat').filter({hasText:'Current: -5 °C · Target: 18 °C – 23 °C'}).waitFor();
  await page.evaluate(()=>{states['climate.zone'].climate={current_temperature:'20',temperature:100000,temperature_unit:'<img>',hvac_action:'<svg>'};publish();});
  await card('thermostat').filter({hasText:/Heat mode$/}).waitFor();
  assert.doesNotMatch(await card('thermostat').textContent(),/Current:|Target:|<svg>|<img>/);
  await frame.locator('#homeToggleActivity').click();
  await frame.locator('#homeRoom').selectOption(template.room);
  assert.deepEqual(await frame.locator('#homeActivitySources [data-activity-source]:visible').evaluateAll(nodes=>nodes.map(node=>node.dataset.activitySource)),['receiver1','receiver2','presence'],'only configured sources are shown');
  await page.evaluate(()=>publish(false));await card('cold').filter({hasText:'Disconnected'}).waitFor();
  assert.equal(await frame.locator('#homeActivitySources button:visible').count(),0,'disconnection withholds all source rows');
  assert.equal(await card('cold').isDisabled(),true);assert.equal(await frame.locator('[data-home-details="light"]').isDisabled(),true);
  assert.equal(await frame.locator('.oven-glow').isVisible(),false);assert.equal(await frame.locator('.cooktop-flames').isVisible(),false);
  assert.equal(await frame.locator('.home-presence-indicator').getAttribute('data-state'),'unknown');
  await page.evaluate(()=>publish());await card('cold').filter({hasText:'Restored state'}).waitFor();
  await frame.locator('#homeToggleActivity').click();
  await frame.locator('#homeRoom').selectOption('');
  await frame.locator('#editLayout').click();
  assert.equal(await frame.locator('[data-details-for]').count(),Object.keys(bindings).length,'inventory also exposes Details for every binding');
  await frame.locator('[data-details-for="vacuum"]').click();
  assert.equal(await frame.locator('[data-state-for="cold"]').textContent(),'Restored state');
  await frame.locator('#entityGuidance').filter({hasText:'Offline previews do not control devices'}).waitFor();
  // Rebinding an indicator must not expose the specialized media/cover action path.
  for(const [id,entity] of [['range','media_player.rebound'],['alarm','cover.rebound'],['presence','light.rebound']]){
   await frame.locator('li').filter({has:frame.locator(`[data-details-for="${id}"]`)}).getByRole('button',{name:'Edit',exact:true}).click();
   await frame.locator('#entity').fill(entity);
   await frame.locator('#itemForm').evaluate(form=>form.requestSubmit());
   assert.equal(await view.evaluate(id=>window.floorplan.items.find(item=>item.id===id).entity_id,id),entity,await frame.locator('#status').textContent());
  }
  await page.evaluate(()=>{states['media_player.rebound']={state:'playing'};states['cover.rebound']={state:'open'};states['light.rebound']={state:'on'};publish();});
  await frame.locator('#openHome').click();
  await card('range').filter({hasText:'Unavailable'}).waitFor();
  for(const id of ['range','alarm','presence']){
   assert.equal(await card(id).getAttribute('aria-pressed'),null,'indicators remain readings after rebinding');
   await holdForDetails(id);
  }
  await page.waitForFunction(()=>messages.filter(m=>m.type==='more_info').length>=15);
  assert.equal(await frame.locator('#curtainDialog').evaluate(dialog=>dialog.open),false);
  assert.equal(await frame.locator('.cooktop-flames').isVisible(),false);
  assert.equal(await frame.locator('.oven-glow').isVisible(),false);
  assert.equal(await view.evaluate(()=>window.floorplan.illuminated.includes('presence')),false);
  assert.equal(await page.evaluate(()=>messages.filter(m=>m.type==='toggle').length),2,'rebound indicators do not add toggle commands');
  assert.deepEqual(await page.evaluate(()=>messages.filter(m=>['media_command','curtain_command'].includes(m.type))),[],'no specialized commands escape the read-only path');
  await sendActivity({receiver1:channelValue('on','off')});await sendActivity({receiver1:channelValue('on','on')});
  assert.equal(await trails.count(),1);
  await view.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:false})));
  assert.equal(await trails.count(),0,'page disposal clears every motion timer and trail');
  await sendActivity();assert.equal(await trails.count(),0,'disposed view cannot recreate motion');
  assert.equal(await frame.locator('.home-presence-layer').count(),0,'page disposal removes the presence layer');
  await page.goto(origin+'/offline');await page.locator('#openHome').click();
  await page.locator('[data-home-device="cold"]').filter({hasText:'Offline preview'}).waitFor();
  assert.equal(await page.locator('[data-home-device="cold"]').isDisabled(),true);
  await page.goto(origin+'/planner/');await page.waitForFunction(()=>window.planner);
  await page.getByRole('button',{name:'Add room',exact:true}).click();
  await page.getByRole('button',{name:'Place item at room center',exact:true}).click();
  await page.locator('#inspector-body').getByText(/Any Home Assistant entity can be linked/).waitFor();
  assert.deepEqual(external,[],'fixtures never contact external services');assert.deepEqual(errors,[]);
  console.log('PASS: generic entity visibility, truthful readings, native details, toggle isolation, offline planner guidance');
 }finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(temporary,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
