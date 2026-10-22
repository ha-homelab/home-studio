// Real generated viewer; fictional coordinates and a mocked parent, never Home Assistant.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const http=require('node:http'),{spawnSync}=require('node:child_process'),playwright=require('playwright');
const {browserLaunchOptions}=require('./browser-stability-diagnostics.cjs');
const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'home-vacuum-browser-'));
const engine=process.env.VACUUM_BROWSER_ENGINE||'chromium';
assert(['chromium','firefox','webkit'].includes(engine));
(async()=>{
  let browser,server,page;
  const errors=[],external=[];
  try{
    const project=JSON.parse(fs.readFileSync(path.join(root,'planner/example-home.json'),'utf8'));
    project.floors[0].items=[];
    fs.writeFileSync(path.join(temporary,'project.json'),JSON.stringify(project));
    const built=spawnSync(process.env.PYTHON||'python3',['scripts/build-planner-project.py','--project',path.join(temporary,'project.json'),'--output',path.join(temporary,'build')],{cwd:root,encoding:'utf8',timeout:30000});
    assert.equal(built.status,0,built.error?.message||built.stderr||built.stdout);
    let html=fs.readFileSync(path.join(temporary,'build/main/index.html'),'utf8');
    const model=JSON.parse(fs.readFileSync(path.join(temporary,'build/main/model-data.json'),'utf8'));
    model.vacuum_sources=[{id:'fictional_cleaner',name:'Fictional cleaner',entity_id:'vacuum.fictional',position_entity_id:'sensor.fictional_position',floor_id:model.floor,map_id:0,transform:[.001,0,0,0,.001,0],bounds:[0,0,7,5],max_age_seconds:120,calibration:'approximate'}];
    html=html.replace(/(<script id="modelData" type="application\/json">)[\s\S]*?(<\/script>)/,(_,a,b)=>a+JSON.stringify(model)+b)
      .replace('<head>','<head><script>window.__HOME_FLOORPLAN_EMBED__=true;</script>');
    server=http.createServer((request,response)=>{
      const route=new URL(request.url,'http://localhost').pathname;
      if(route==='/'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><style>body{margin:0}iframe{border:0;width:100vw;height:100vh}</style>');return;}
      const file=path.resolve(root,'.'+route);
      if(!file.startsWith(root+path.sep)){response.writeHead(403).end();return;}
      try{response.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');response.end(fs.readFileSync(file));}
      catch{response.writeHead(404).end();}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+server.address().port;
    browser=await playwright[engine].launch(browserLaunchOptions(engine,true));
    page=await browser.newPage({viewport:{width:1400,height:950}});page.setDefaultTimeout(15000);
    page.on('pageerror',error=>errors.push(String(error).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g,'[embedded module]').slice(0,2000)));
    await page.route('**/*',route=>{if(route.request().url().startsWith(origin+'/'))return route.continue();external.push(route.request().url());return route.abort();});
    await page.clock.install({time:new Date('2030-01-01T12:00:00Z')});
    await page.goto(origin);
    await page.evaluate(source=>{const iframe=document.createElement('iframe');iframe.sandbox='allow-scripts allow-forms';iframe.srcdoc=source;document.body.append(iframe);},html);
    const frame=page.frameLocator('iframe'),marker=frame.locator('[data-vacuum-id="fictional_cleaner"]');
    await frame.locator('#homeRoom').waitFor();
    await page.evaluate(()=>{
      const channel=new MessageChannel();window.messages=[];window.port=channel.port1;
      channel.port1.onmessage=event=>messages.push(event.data);
      document.querySelector('iframe').contentWindow.postMessage({type:'home-floorplan:init',can_edit:true,items:[]},'*',[channel.port2]);
      window.states={'vacuum.fictional':{state:'cleaning',battery_level:75},'sensor.fictional_position':{state:'reported',vacuum_position:{valid:false}}};
      window.publish=(connected=true)=>port.postMessage({type:'states',states,connected});
    });
    await page.waitForFunction(()=>messages.some(message=>message.type==='model_config'));
    const view=await(await page.locator('iframe').elementHandle()).contentFrame();
    await view.waitForFunction(()=>window.floorplan?.renderCount>0);
    await page.clock.pauseAt(new Date(await page.evaluate(()=>Date.now()+1000)));
    const settle=()=>page.clock.runFor(50);
    await page.evaluate(()=>publish());await settle();
    assert.equal(await marker.isVisible(),false,'invalid startup coordinates must not place the cleaner');
    await page.evaluate(()=>{states['sensor.fictional_position'].vacuum_position={x:2000,y:2000,map_id:0,valid:true,observed_at:null,retrieved_at:new Date().toISOString(),timestamp_quality:'not_provided'};publish();});
    await settle();await marker.waitFor();
    assert.equal(await marker.getAttribute('data-position-state'),'reported');
    assert.equal(await marker.locator('.home-vacuum-caption').textContent(),'Reported position');
    assert.match(await marker.getAttribute('title'),/Fictional cleaner.*Battery 75%.*Observation time unavailable.*Retrieved.*Approximate calibration/);
    const before=await marker.evaluate(element=>({left:parseFloat(element.style.left),top:parseFloat(element.style.top)}));
    assert(Number.isFinite(before.left)&&Number.isFinite(before.top),'calibrated position is projected onto the real camera');
    const box=await marker.boundingBox();assert(box&&box.width===32&&box.height===32,'the marker stays a compact 32-pixel icon');
    await marker.click();await page.waitForFunction(()=>messages.some(message=>message.type==='more_info'&&message.entity_id==='vacuum.fictional'));
    await page.clock.fastForward(1000);
    await page.evaluate(()=>{Object.assign(states['sensor.fictional_position'].vacuum_position,{x:3000,retrieved_at:new Date().toISOString()});publish();});
    await settle();
    const moved=await marker.evaluate(element=>({left:parseFloat(element.style.left),top:parseFloat(element.style.top)}));
    assert.notDeepEqual(moved,before,'a new native position moves the existing marker');
    assert.equal(await frame.locator('.home-vacuum-marker').count(),1,'updates reuse the marker');
    const count=await view.evaluate(()=>window.floorplan.renderCount);
    await page.clock.fastForward(121000);
    assert.equal(await marker.getAttribute('data-position-state'),'last_known');
    assert.match(await marker.locator('.home-vacuum-caption').textContent(),/^Last known · retrieved 2m ago$/);
    assert.equal(await view.evaluate(()=>window.floorplan.renderCount),count,'expiry and age updates do not schedule WebGL rendering');
    await page.evaluate(()=>publish(false));await settle();assert.equal(await marker.isDisabled(),true);
    assert.match(await marker.getAttribute('title'),/Disconnected.*Last known/);
    await page.evaluate(()=>{Object.assign(states['sensor.fictional_position'].vacuum_position,{map_id:1,retrieved_at:new Date().toISOString()});publish();});
    await settle();assert.equal(await marker.isVisible(),false,'a different active map removes the calibrated marker');
    await page.evaluate(()=>{states['sensor.fictional_position'].vacuum_position={valid:false};publish();});await settle();
    assert.equal(await marker.isVisible(),false,'missing data cannot resurrect the previous floor position');
    await page.evaluate(()=>{states['sensor.fictional_position'].vacuum_position={x:2000,y:2000,map_id:0,valid:true,observed_at:new Date().toISOString()};publish();});
    await settle();assert.equal(await marker.getAttribute('data-position-state'),'live','genuine observation time remains supported');
    await view.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
    assert.equal(await marker.isVisible(),false);await page.clock.fastForward(121000);
    await view.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});await settle();
    assert.equal(await marker.getAttribute('data-position-state'),'last_known','visibility restoration reevaluates freshness');
    assert.deepEqual(await page.evaluate(()=>messages.filter(message=>['toggle','service','command','vacuum_command'].includes(message.type))),[],'position inspection cannot dispatch movement');
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    console.log('PASS ('+engine+'): generated vacuum projection, reported/observed labels, native details, expiry, no rendering loop, disconnect, map change and hidden-page freshness.');
  }catch(error){
    const artifacts=process.env.VACUUM_BROWSER_ARTIFACTS?path.resolve(process.env.VACUUM_BROWSER_ARTIFACTS):fs.mkdtempSync(path.join(os.tmpdir(),'home-vacuum-failure-'));
    fs.mkdirSync(artifacts,{recursive:true});
    if(page&&!page.isClosed())await page.screenshot({path:path.join(artifacts,engine+'-failure.png'),timeout:5000}).catch(()=>{});
    fs.writeFileSync(path.join(artifacts,engine+'-failure.json'),JSON.stringify({error:String(error),pageErrors:errors,external},null,2));
    console.error('Vacuum browser failure evidence: '+artifacts);throw error;
  }finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(temporary,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
