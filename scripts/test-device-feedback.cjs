// Real generated viewer, catalog geometry and MessageChannel states. No HA/device calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const http=require('node:http'),{spawnSync}=require('node:child_process');
const playwright=require('playwright');
const {browserLaunchOptions}=require('./browser-stability-diagnostics.cjs');
const engine=process.env.DEVICE_FEEDBACK_ENGINE||'chromium';
assert.ok(['chromium','firefox','webkit'].includes(engine),'DEVICE_FEEDBACK_ENGINE must be chromium, firefox or webkit');
const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'home-device-feedback-'));
const screenshotDir=process.env.DEVICE_FEEDBACK_QA_DIR;
if(screenshotDir)fs.mkdirSync(screenshotDir,{recursive:true});
const models=['ceiling_fan','standing_fan','desk_fan','wall_air_conditioner','panel_heater'];
const entities=['fan.ceiling','fan.standing','switch.desk','climate.cooling','climate.heating'];
const positions=[[2,2.3,2],[1,0,4],[3,.8,4],[5.6,2.05,.3],[5.5,0,3.5]];
const initialStates={
 'fan.ceiling':{state:'on',fan:{percentage:65}},
 'fan.standing':{state:'on',fan:{percentage:35}},
 'switch.desk':{state:'on'},
 'climate.cooling':{state:'cool',climate:{hvac_action:'cooling',current_temperature:25.5,temperature:22,temperature_unit:'°C'}},
 'climate.heating':{state:'heat',climate:{hvac_action:'heating',current_temperature:18,temperature:21,temperature_unit:'°C'}},
};

(async()=>{
 let browser,server,page,view,diagnosticsWritten=false;
 const failureDiagnostics=async(context={})=>{
  if(diagnosticsWritten)return;diagnosticsWritten=true;
  let timer;
  try{
   const snapshot=await Promise.race([Promise.all([
    page?.evaluate(()=>{
     const element=document.querySelector('iframe'),rect=element?.getBoundingClientRect();
     return {hidden:document.hidden,visibility:document.visibilityState,scroll:[scrollX,scrollY],viewport:[innerWidth,innerHeight],
      frame:rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height,transform:getComputedStyle(element).transform}:null};
    }),
    view?.evaluate(()=>({hidden:document.hidden,visibility:document.visibilityState,scene:window.__deviceFeedback?.(),
     effects:window.__feedbackEffectsState?.(),intersections:window.__feedbackIntersections||[],
     markers:[...document.querySelectorAll('[data-home-item]')].slice(0,8).map(element=>{
      const rect=element.getBoundingClientRect();return {id:element.dataset.homeItem,running:element.dataset.running,hidden:element.hidden,
       x:rect.x,y:rect.y,width:rect.width,height:rect.height};
     })})),
   ]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('diagnostic snapshot exceeded 2 seconds')),2000);})]);
   console.error('Device feedback failure diagnostics:',JSON.stringify({context,host:snapshot[0],viewer:snapshot[1]}));
  }catch(error){console.error('Device feedback diagnostic error:',String(error));}
  finally{clearTimeout(timer);}
 };
 try{
  const project=JSON.parse(fs.readFileSync(path.join(root,'planner/example-home.json'),'utf8'));
  const catalog=JSON.parse(fs.readFileSync(path.join(root,'planner/catalog.json'),'utf8'));
  const items=models.map((id,i)=>{
   const model=catalog.models.find(model=>model.id===id);assert.ok(model,`${id} exists in the catalog`);
   const [x,y,z]=positions[i];
   return {id,name:model.label,type:model.type,room:i<3?'living':'studio',model_id:id,style_id:model.default_style,
    entity_id:entities[i],position_m:{x,y,z},dimensions_m:model.dimensions_m,rotation_deg:0,notes:'Fictional device feedback test'};
  });
  project.floors[0].items=items;
  fs.writeFileSync(path.join(temporary,'project.json'),JSON.stringify(project));
  const built=spawnSync(process.env.PYTHON||'python3',['scripts/build-planner-project.py','--project',path.join(temporary,'project.json'),'--output',path.join(temporary,'build')],{cwd:root,encoding:'utf8',timeout:120000});
  assert.equal(built.status,0,built.error?.message||built.stderr||built.stdout);
  let html=fs.readFileSync(path.join(temporary,'build/main/index.html'),'utf8');
  const compiled=JSON.parse(html.match(/<script id="modelData" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  for(const id of models)assert.ok(compiled.object_assets[id]?.device_animation,`${id} keeps its animation metadata through the compiler`);
  // Read real geometry and capture final projection targets without adding a production debug API.
  const snapshotAnchor='window.floorplan={model,';
  assert.ok(html.includes(snapshotAnchor));
  html=html.replace(snapshotAnchor,`window.__deviceFeedback=()=>({reducedRenderer:coalesceMotion,renderCount,failed3D,renderLost,renderSuspended,renderPending:!!renderRequest,renderDelayed:!!renderDelay,homeActive:homeView?.active,
   rotors:Object.fromEntries([...objectsById].map(([id,object])=>[id,(object.userData.deviceRotors||[]).map(rotor=>({axis:rotor.userData.axis,angle:rotor.rotation[rotor.userData.axis]}))]))});${snapshotAnchor}`);
  const drawAnchor='function drawScene(camera){';
  assert.ok(html.includes(drawAnchor),'the generated viewer includes the shared scene draw');
  html=html.replace(drawAnchor,`${drawAnchor}if(window.__failDeviceFeedbackDraw){window.__deviceFeedbackFailedDraws=(window.__deviceFeedbackFailedDraws||0)+1;throw new Error('Synthetic device feedback draw failure');}`);
  const effectsAnchor='  const spinning = () =>';
  assert.ok(html.includes(effectsAnchor),'the generated viewer includes the device effects scheduler');
  html=html.replace(effectsAnchor,`  window.__feedbackEffectsState=()=>({inViewport,pageHidden,disposed,frameDelay,timerActive:!!timer,
   canDraw:canDraw(),allowRotor:allowRotor(),entries:entries.map(entry=>({id:entry.item?.id,visible:entry.visible,
    projected:entry.projected,running:entry.status?.running,effect:entry.effect,airHidden:entry.air.hidden}))});\n${effectsAnchor}`);
  const intersectionAnchor='inViewport = records.some(record => record.isIntersecting); sync();';
  assert.ok(html.includes(intersectionAnchor),'the generated viewer includes the viewport observer');
  html=html.replace(intersectionAnchor,`const box=rect=>rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null;
   window.__feedbackIntersections=(window.__feedbackIntersections||[]).concat(records.map(record=>({time:record.time,
    intersecting:record.isIntersecting,ratio:record.intersectionRatio,bounds:box(record.boundingClientRect),
    intersection:box(record.intersectionRect),root:box(record.rootBounds)}))).slice(-16);${intersectionAnchor}`);
  const targetAnchor='function target(element,x,y){';
  assert.ok(html.includes(targetAnchor),'the generated viewer includes marker damping');
  html=html.replace(targetAnchor,`${targetAnchor}element.dataset.qaTargetX=String(x);element.dataset.qaTargetY=String(y);`);
  html=html.replace('<head>','<head><script>window.__HOME_FLOORPLAN_EMBED__=true;</script>');
  server=http.createServer((request,response)=>{
   if(new URL(request.url,'http://localhost').pathname!=='/'){response.writeHead(404).end();return;}
   response.setHeader('Content-Type','text/html');response.end('<!doctype html><style>body{margin:0}iframe{width:100%;height:100vh;border:0;display:block}</style>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await playwright[engine].launch(browserLaunchOptions(engine,process.env.DEVICE_FEEDBACK_HEADED!=='1'));
  page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.setDefaultTimeout(15000);
  const errors=[],external=[];
  page.on('pageerror',error=>errors.push(String(error)));
  await page.route('**/*',route=>{
   if(route.request().url().startsWith(origin+'/'))return route.continue();
   external.push(route.request().url());return route.abort();
  });
  await page.goto(origin);
  await page.evaluate(html=>{const frame=document.createElement('iframe');frame.sandbox='allow-scripts allow-forms';frame.srcdoc=html;document.body.append(frame);},html);
  const frame=page.frameLocator('iframe');
  await frame.locator('#homeRoom').waitFor();
  view=await (await page.locator('iframe').elementHandle()).contentFrame();
  await page.evaluate(({items,states})=>{
   const channel=new MessageChannel();window.feedbackMessages=[];window.feedbackPort=channel.port1;window.feedbackStates=states;
   channel.port1.onmessage=event=>{
    if(event.data.type==='map_request'&&event.data.action==='get'){
     channel.port1.postMessage({type:'map_result',request_id:event.data.request_id,success:true,result:{revision:0,configured:false,config:null,reference:null}});return;
    }
    feedbackMessages.push(event.data);
   };
   document.querySelector('iframe').contentWindow.postMessage({type:'home-floorplan:init',can_edit:true,items},'*',[channel.port2]);
   window.publishFeedback=(connected=true)=>feedbackPort.postMessage({type:'states',states:feedbackStates,connected});
  },{items,states:initialStates});
  await page.waitForFunction(()=>feedbackMessages.some(message=>message.type==='model_config'));
  const publish=async(updates={},connected=true)=>page.evaluate(({updates,connected})=>{Object.assign(feedbackStates,updates);publishFeedback(connected);},{updates,connected});
  const marker=id=>frame.locator(`[data-home-item="${id}"]`),card=id=>frame.locator(`[data-home-device="${id}"]`);
  // Offscreen iframes can suspend RAF; state assertions must also run offscreen.
  const running=async(id,expected)=>{
   try{await view.waitForFunction(({id,expected})=>document.querySelector(`[data-home-item="${id}"]`)?.dataset.running===String(expected),{id,expected},{polling:100});}
   catch(error){await failureDiagnostics({id,expected});throw error;}
  };
  const screenshot=async name=>{if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,name+'.png')});};
  const settle=async()=>{
   let previous=-1,stable=0;
   for(let i=0;i<30;i++){
    await page.waitForTimeout(100);
    const count=await view.evaluate(()=>window.floorplan.renderCount);
    stable=count===previous?stable+1:0;previous=count;
    if(stable>=3)return count;
   }
   assert.fail('the scene did not stop drawing within three seconds');
  };
  await publish();
  for(const id of models)await running(id,true);
  for(const id of models.slice(0,3)){
   assert.equal(await marker(id).getAttribute('data-kind'),'fan');
   assert.equal(await card(id).getAttribute('data-kind'),'fan');
   assert.equal(await marker(id).getAttribute('data-effect'),'fan');
  }
  assert.equal(await marker('wall_air_conditioner').getAttribute('data-effect'),'cool');
  assert.equal(await marker('panel_heater').getAttribute('data-effect'),'heat');
  assert.equal(await marker('wall_air_conditioner').locator('.climate-reading').textContent(),'25.5 °C');
  assert.equal(await marker('panel_heater').locator('.climate-reading').textContent(),'18 °C');
  assert.match(await card('wall_air_conditioner').textContent(),/Current: 25.5 °C.*Target: 22 °C.*Cooling/);
  assert.equal(await frame.locator('.device-airflow:not([hidden])').count(),5,'all five catalog models have projected airflow');
  assert.equal(await frame.locator('.device-airflow[data-effect="cool"]:not([hidden])').count(),1);
  assert.equal(await frame.locator('.device-airflow[data-effect="heat"]:not([hidden])').count(),1);
  assert.equal(await frame.locator('[data-kind="fan"] .fan-blades').count(),6,'each fan has a marker and card rotor glyph');
  assert.ok((await frame.locator('[data-kind="fan"] .fan-blades').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).animationName))).every(value=>value!=='none'),'running fan glyphs animate even with a software renderer');
  const cool=await frame.locator('.device-airflow[data-effect="cool"] path').first().evaluate(node=>getComputedStyle(node).stroke.match(/[\d.]+/g).map(Number));
  const heat=await frame.locator('.device-airflow[data-effect="heat"] path').first().evaluate(node=>getComputedStyle(node).stroke.match(/[\d.]+/g).map(Number));
  assert.ok(cool[2]>cool[0]&&heat[0]>heat[2],'cooling airflow is blue and heating airflow is warm');
  assert.ok((await frame.locator('.device-airflow:not([hidden]) path').evaluateAll(paths=>paths.map(path=>path.getAttribute('d')))).every(value=>/^M[\d.-]+,[\d.-]+ L[\d.-]+,[\d.-]+$/.test(value)),'airflow uses finite projected paths');
  await screenshot('device-feedback-active');

  const first=await view.evaluate(()=>window.__deviceFeedback());
  assert.deepEqual(Object.values(first.rotors).map(rotors=>rotors.length),[1,1,1,0,0],'three fan models have independent rotors');
  await page.waitForTimeout(350);
  const second=await view.evaluate(()=>window.__deviceFeedback());
  for(const id of models.slice(0,3)){
   if(first.reducedRenderer)assert.equal(second.rotors[id][0].angle,first.rotors[id][0].angle,'software rendering keeps the 3D scene idle');
   else assert.notEqual(second.rotors[id][0].angle,first.rotors[id][0].angle,'hardware rendering animates the real rotor');
  }
  if(first.reducedRenderer){const count=await settle();await page.waitForTimeout(200);assert.equal(await view.evaluate(()=>window.floorplan.renderCount),count,'CSS airflow and fan badges do not redraw WebGL');}

  await publish({
   'fan.ceiling':{state:'off',fan:{percentage:65}},'fan.standing':{state:'on',fan:{percentage:0}},'switch.desk':{state:'off'},
   'climate.cooling':{state:'cool',climate:{hvac_action:'idle',current_temperature:22,temperature:22,temperature_unit:'°C'}},
   'climate.heating':{state:'off',climate:{hvac_action:'heating',current_temperature:21,temperature:21,temperature_unit:'°C'}},
  });
  for(const id of models)await running(id,false);
  assert.equal(await frame.locator('.device-airflow:not([hidden])').count(),0);
  assert.ok((await frame.locator('[data-kind="fan"] .fan-blades').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).animationName))).every(value=>value==='none'),'off and zero-speed fan glyphs stop animating');
  assert.equal(await marker('wall_air_conditioner').locator('.climate-reading').textContent(),'22 °C','idle preserves current temperature');
  assert.match(await card('wall_air_conditioner').textContent(),/Idle/);
  assert.doesNotMatch(await card('panel_heater').textContent(),/Heating|Preheating/,'off mode does not claim heating from a stale HVAC action');
  const stopped=await view.evaluate(()=>window.__deviceFeedback().rotors);
  const stoppedCount=await settle();await page.waitForTimeout(200);
  assert.deepEqual(await view.evaluate(()=>window.__deviceFeedback().rotors),stopped,'off and zero-speed fans retain a stationary rotor');
  assert.equal(await view.evaluate(()=>window.floorplan.renderCount),stoppedCount);
  await screenshot('device-feedback-idle');

  // Damping must move the actual button hitbox and finish without drawing the scene.
  const motion=await view.evaluate(()=>{
   document.querySelector('#homeZoomIn').click();
   const element=document.querySelector('[data-home-item="standing_fan"]'),stage=document.querySelector('#homeStage').getBoundingClientRect(),box=element.getBoundingClientRect();
   return {lag:Math.hypot(box.x+box.width/2-stage.x-Number(element.dataset.qaTargetX),box.y+box.height/2-stage.y-Number(element.dataset.qaTargetY)),count:window.floorplan.renderCount};
  });
  assert.ok(motion.lag<=24.1,'a large camera move leaves at most 24px of marker lag');
  await page.waitForTimeout(420);
  const settled=await marker('standing_fan').evaluate(element=>{
   const stage=document.querySelector('#homeStage').getBoundingClientRect(),box=element.getBoundingClientRect(),x=box.x+box.width/2,y=box.y+box.height/2;
   return {lag:Math.hypot(x-stage.x-Number(element.dataset.qaTargetX),y-stage.y-Number(element.dataset.qaTargetY)),hit:element.contains(document.elementFromPoint(x,y)),count:window.floorplan.renderCount};
  });
  assert.ok(settled.lag<.1,'the marker settles exactly onto its projected point');
  assert.equal(settled.hit,true,'the visible marker center belongs to its real button hitbox');
  assert.equal(settled.count,motion.count,'marker settling does not schedule WebGL redraws');
  await frame.locator('#homeZoomReset').click();

  await publish({'climate.cooling':{state:'cool',climate:{temperature:23,temperature_unit:'°C'}}});
  await marker('wall_air_conditioner').locator('.climate-reading').filter({hasText:'23 °C'}).waitFor();
  await running('wall_air_conditioner',false);
  assert.match(await card('wall_air_conditioner').textContent(),/Target: 23 °C/);
  await publish({'climate.cooling':{state:'heat_cool',climate:{hvac_action:'idle',target_temp_low:18,target_temp_high:24,temperature_unit:'°C'}}});
  await marker('wall_air_conditioner').locator('.climate-reading').filter({hasText:'18 °C – 24 °C'}).waitFor();
  await publish({'climate.cooling':{state:'cool',climate:{hvac_action:'cooling',current_temperature:'25',temperature:Infinity,temperature_unit:'<img>'}}});
  await running('wall_air_conditioner',true);
  assert.equal(await marker('wall_air_conditioner').locator('.climate-reading').isVisible(),false,'malformed temperatures do not display a fabricated value');
  assert.equal(await frame.locator('img[onerror],svg[onload]').count(),0);

  await publish(initialStates);
  for(const id of models)await running(id,true);
  await page.emulateMedia({reducedMotion:'reduce'});
  await settle();
  const reducedStart=await view.evaluate(()=>window.__deviceFeedback());
  await page.waitForTimeout(250);
  assert.deepEqual(await view.evaluate(()=>window.__deviceFeedback().rotors),reducedStart.rotors,'reduced motion stops 3D rotor updates');
  assert.equal(await view.evaluate(()=>window.floorplan.renderCount),reducedStart.renderCount);
  assert.ok((await frame.locator('.device-airflow path').evaluateAll(paths=>paths.map(path=>getComputedStyle(path).animationName))).every(value=>value==='none'),'reduced motion disables airflow animation');
  assert.ok((await frame.locator('[data-kind="fan"] .fan-blades').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).animationName))).every(value=>value==='none'),'reduced motion disables fan badge animation');
  await screenshot('device-feedback-reduced-motion');

  await frame.locator('#homeRoom').selectOption('studio');
  for(const id of models.slice(0,3)){await running(id,false);assert.equal(await marker(id).isVisible(),false);}
  assert.equal(await frame.locator('.device-airflow:not([hidden])').count(),2,'room filtering suppresses hidden fan effects');
  await frame.locator('#homeRoom').selectOption('');
  for(const id of models)await running(id,true);
  await view.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  for(const id of models)await running(id,false);
  assert.equal(await frame.locator('.device-airflow:not([hidden])').count(),0,'a hidden document suppresses effects');
  await view.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
  for(const id of models)await running(id,true);
  await page.locator('iframe').evaluate(frame=>frame.style.transform='translateY(150vh)');
  for(const id of models)await running(id,false);
  await page.locator('iframe').evaluate(frame=>frame.style.transform='');
  for(const id of models)await running(id,true);

  await publish(Object.fromEntries(entities.map(id=>[id,{...initialStates[id],restored:true}])));
  for(const id of models)await running(id,false);
  assert.equal(await frame.locator('.climate-reading:visible').count(),0,'restored temperatures are not live indicators');
  await publish(Object.fromEntries(entities.map(id=>[id,{state:'unavailable'}])));
  for(const id of models)await running(id,false);
  assert.equal(await frame.locator('.device-airflow:not([hidden])').count(),0);
  await screenshot('device-feedback-unavailable');
  await publish(initialStates,false);
  await card('wall_air_conditioner').filter({hasText:'Disconnected'}).waitFor();
  for(const id of models)await running(id,false);
  assert.equal(await frame.locator('.climate-reading:visible').count(),0,'disconnect removes stale temperature indicators');
  assert.match(await card('wall_air_conditioner').textContent(),/Disconnected/);
  assert.equal(await card('standing_fan').isDisabled(),true);

  assert.deepEqual(await page.evaluate(()=>feedbackMessages.filter(message=>['toggle','media_command','curtain_command'].includes(message.type))),[],'visual effects never issue device commands');
  await publish(initialStates);
  for(const id of models)await running(id,true);
  await marker('standing_fan').click();
  await page.waitForFunction(()=>feedbackMessages.some(message=>message.type==='toggle'&&message.entity_id==='fan.standing'));
  assert.equal(await page.evaluate(()=>feedbackMessages.filter(message=>message.type==='toggle').length),1,'clicking the visible fan marker retains one deliberate toggle');
  await card('wall_air_conditioner').click();
  assert.equal(await page.evaluate(()=>feedbackMessages.filter(message=>message.type==='more_info').length),0,'a short card click does not open native details');
  await frame.locator('[data-home-details="wall_air_conditioner"]').click();
  await page.waitForFunction(()=>feedbackMessages.some(message=>message.type==='more_info'&&message.entity_id==='climate.cooling'));

  // Changing semantic type discards the compiled fan asset. Its original id
  // must not make an unrelated replacement switch inherit fan presentation.
  await frame.locator('#editLayout').click();
  await frame.locator('li').filter({has:frame.locator('[data-details-for="desk_fan"]')}).getByRole('button',{name:'Edit',exact:true}).click();
  await frame.locator('#kind').selectOption('outlet');
  await frame.locator('#entity').fill('switch.kettle');
  await frame.locator('#itemForm').evaluate(form=>form.requestSubmit());
  const replacement=await view.evaluate(()=>window.floorplan.items.find(item=>item.id==='desk_fan'));
  assert.equal(replacement.type,'outlet');assert.equal(replacement.entity_id,'switch.kettle');
  assert.equal(Object.hasOwn(replacement,'model_id'),false,'changing kind removes the compiled fan appearance');
  await frame.locator('#openHome').click();
  await publish({'switch.kettle':{state:'on'}});
  await card('desk_fan').filter({hasText:'On'}).waitFor();
  assert.equal(await marker('desk_fan').getAttribute('data-kind'),'control','classification follows the accepted object, not stale fan metadata');
  assert.equal(await marker('desk_fan').locator('.fan-blades').count(),0);
  assert.equal(await card('desk_fan').locator('.fan-blades').count(),0);
  assert.deepEqual(await view.evaluate(()=>window.__deviceFeedback().rotors.desk_fan),[],'the replacement object has no fan rotor');
  assert.equal(await frame.locator('.device-airflow').count(),4,'the replacement switch creates no fan airflow overlay');

  // A fatal scene draw must stop CSS feedback too, even when a low-capacity
  // renderer has no rotor timer that could notice the failure on a later tick.
  await page.emulateMedia({reducedMotion:'no-preference'});
  for(const id of models.filter(id=>id!=='desk_fan'))await running(id,true);
  assert.equal(await frame.locator('.device-airflow:not([hidden])').count(),4);
  assert.ok((await frame.locator('[data-kind="fan"] .fan-blades').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).animationName))).every(value=>value!=='none'),'fan badges animate before the injected failure');
  assert.equal(await view.evaluate(()=>window.__deviceFeedback().failed3D),false);
  await view.evaluate(()=>{window.__failDeviceFeedbackDraw=true;window.requestModelRender();});
  await frame.locator('#loadError').waitFor({state:'visible'});
  assert.equal(await view.evaluate(()=>window.__deviceFeedback().failed3D),true);
  for(const id of models.filter(id=>id!=='desk_fan'))await running(id,false);
  assert.equal(await frame.locator('.device-airflow:not([hidden])').count(),0,'fatal failure immediately hides all airflow');
  assert.ok((await frame.locator('[data-kind="fan"] .fan-blades').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).animationName))).every(value=>value==='none'),'fatal failure stops fan marker and card animations');
  const failedCount=await settle();
  await publish(initialStates);
  await view.evaluate(()=>window.requestModelRender());
  await page.waitForTimeout(300);
  assert.equal(await view.evaluate(()=>window.floorplan.renderCount),failedCount,'state updates cannot restart a failed renderer');
  assert.equal(await view.evaluate(()=>window.__deviceFeedbackFailedDraws),1,'the failed scene draw is not retried');
  assert.equal(await frame.locator('.device-airflow:not([hidden])').count(),0,'live states cannot restart feedback after fatal failure');
  for(const id of models.filter(id=>id!=='desk_fan'))await running(id,false);
  assert.deepEqual(external,[],'fixture never contacts external services');assert.deepEqual(errors,[]);
  console.log(`PASS: five catalog models, live fan/climate feedback, safe temperatures, visibility, reduced motion, marker hitbox and bounded settle (${engine}, ${first.reducedRenderer?'software':'hardware'} renderer)`);
 }catch(error){
  await failureDiagnostics({error:String(error)});
  if(screenshotDir&&page)await page.screenshot({path:path.join(screenshotDir,'device-feedback-failure.png')}).catch(()=>{});
  throw error;
 }finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(temporary,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
