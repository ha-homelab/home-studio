// Real generated viewer and planner DOM, fictional entities, no Home Assistant or device calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const http=require('node:http'),{spawnSync}=require('node:child_process');
const {chromium}=require('playwright');
const {browserLaunchOptions}=require('./browser-stability-diagnostics.cjs');
const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'home-generic-'));
const bindings={cold:'sensor.cold',motion:'binary_sensor.motion',entry:'binary_sensor.entry',thermostat:'climate.zone',vacuum:'vacuum.cleaner',action:'button.example',future:'custom_thing.future',fan:'fan.study',light:'light.fixture',missing:'sensor.missing',injected:'sensor.injected'};
(async()=>{
 let browser,server;
 try{
  const project=JSON.parse(fs.readFileSync(path.join(root,'planner/example-home.json'),'utf8'));
  const template=project.floors[0].items[0];
  project.floors[0].items=Object.entries(bindings).map(([id,entity_id],i)=>({...template,id,name:id==='injected'?'<img src=x onerror=alert(1)>':id,entity_id,type:id==='future'?'lamp':'appliance',position_m:{x:1+i*.15,y:0,z:1},dimensions_m:{width:.1,depth:.1,height:.2}}));
  fs.writeFileSync(path.join(temporary,'project.json'),JSON.stringify(project));
  const built=spawnSync(process.env.PYTHON||'python3',['scripts/build-planner-project.py','--project',path.join(temporary,'project.json'),'--output',path.join(temporary,'build')],{cwd:root,encoding:'utf8'});
  assert.equal(built.status,0,built.stderr||built.stdout);
  const plain=fs.readFileSync(path.join(temporary,'build/main/index.html'),'utf8');
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
  await page.evaluate(html=>{const frame=document.createElement('iframe');frame.sandbox='allow-scripts';frame.srcdoc=html;document.body.append(frame);},html);
  const frame=page.frameLocator('iframe');
  await frame.locator('#homeRoom').waitFor();
  await page.evaluate(items=>{
   const channel=new MessageChannel();window.messages=[];window.channel=channel.port1;channel.port1.onmessage=event=>messages.push(event.data);
   document.querySelector('iframe').contentWindow.postMessage({type:'home-floorplan:init',items},'*',[channel.port2]);
   window.states={
    'sensor.cold':{state:'-12.5',unit:'°C',device_class:'temperature'},
    'binary_sensor.entry':{state:'on',device_class:'door'},'binary_sensor.motion':{state:'off',device_class:'motion'},
    'climate.zone':{state:'heat',climate:{current_temperature:18.2,temperature:20,hvac_action:'heating',temperature_unit:'°C'}},
    'vacuum.cleaner':{state:'cleaning'},'button.example':{state:'unknown'},'custom_thing.future':{state:'on'},
    'fan.study':{state:'on'},'light.fixture':{state:'on',light:{brightness:128}},
    'sensor.injected':{state:'<img src=x onerror=alert(2)>',unit:'<svg onload=alert(3)>',device_class:'temperature'},
   };
   window.publish=(connected=true)=>channel.port1.postMessage({type:'states',states,connected});
  },project.floors[0].items);
  await page.waitForFunction(()=>messages.some(m=>m.type==='model_config'));
  await page.evaluate(()=>publish());
  const card=id=>frame.locator(`[data-home-device="${id}"]`);
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
  for(const id of ['cold','entry','thermostat','vacuum','action','future'])await card(id).click();
  await page.waitForFunction(()=>messages.filter(m=>m.type==='more_info').length===6);
  assert.deepEqual(await page.evaluate(()=>messages.filter(m=>m.type==='toggle')),[],'generic on/off entities cannot send toggles');
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
  await page.evaluate(()=>publish(false));await card('cold').filter({hasText:'Disconnected'}).waitFor();
  assert.equal(await card('cold').isDisabled(),true);assert.equal(await frame.locator('[data-home-details="light"]').isDisabled(),true);
  await page.evaluate(()=>publish());await card('cold').filter({hasText:'Restored state'}).waitFor();
  await frame.locator('#editLayout').click();
  assert.equal(await frame.locator('[data-details-for]').count(),Object.keys(bindings).length,'inventory also exposes Details for every binding');
  await frame.locator('[data-details-for="vacuum"]').click();
  assert.equal(await frame.locator('[data-state-for="cold"]').textContent(),'Restored state');
  await frame.locator('#entityGuidance').filter({hasText:'Offline previews do not control devices'}).waitFor();
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
