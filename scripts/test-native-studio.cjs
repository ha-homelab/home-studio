const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, firefox, webkit } = require('playwright');
const { browserLaunchOptions } = require('./browser-stability-diagnostics.cjs');
const engine = process.env.BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[engine];
assert(browserType, 'BROWSER must be chromium, firefox, or webkit');
const root = path.resolve(__dirname, '..');
const fixture = `<!doctype html><html style="height:100%"><head><meta charset="utf-8"></head><body style="margin:0;height:100%"><home-floorplan-studio-panel></home-floorplan-studio-panel><script src="/custom_components/home_floorplan/static/studio.js"></script><script>
window.calls=[];window.failSave=false;window.holdSave=false;window.tokens='NEVER_SEND_TOKEN';
const saved=JSON.parse(sessionStorage.getItem('fixture-server')||'null')||{project:null,revision:0,published_revision:null};
window.server=saved;
window.catalog={floors:[{id:'ground',name:'Ground floor'}],areas:[{id:'living',name:'Living room',floor_id:'ground'}],entities:[{entity_id:'light.ceiling',name:'Ceiling light',domain:'light',area_id:'living',available:true,attributes:{secret:'PRIVATE_ATTRIBUTE'}},{entity_id:'sensor.temperature',name:'Temperature',domain:'sensor',area_id:'living',available:true},{entity_id:'switch.disabled',name:'Disabled',domain:'switch',area_id:'living',disabled:true}],secrets:'PRIVATE_CATALOG'};
window.host=document.querySelector('home-floorplan-studio-panel');
window.host.hass={user:{id:'test-user',is_admin:true},auth:{accessToken:window.tokens},callWS:async data=>{window.calls.push(structuredClone(data));if(data.type.endsWith('entity_catalog'))return window.catalog;if(data.type.endsWith('project_get')&&window.holdGet)await new Promise(resolve=>window.releaseGet=resolve);if(data.type.endsWith('project_save')){if(window.failSave)throw {code:'connection_error',message:'Offline'};if(data.revision!==saved.revision)throw {code:'conflict'};if(window.holdSave)await new Promise(resolve=>window.releaseSave=resolve);saved.project=data.project;saved.revision++;sessionStorage.setItem('fixture-server',JSON.stringify(saved));}if(data.type.endsWith('project_publish')){if(data.revision!==saved.revision)throw {code:'conflict'};saved.published_revision=saved.revision;sessionStorage.setItem('fixture-server',JSON.stringify(saved));}return {...structuredClone(saved),can_edit:true,editor_url:'/home-floorplan-studio/planner/index.html',capabilities:{authoring:true}};}};
</script></body></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/fixture') return res.writeHead(200, {'Content-Type':'text/html'}).end(fixture);
  const route = url.pathname.replace(/^\/home-floorplan-studio\//, '/');
  const file = path.resolve(root, '.' + route + (route.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep)) return res.writeHead(404).end();
  try { const body=fs.readFileSync(file); const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.jpg':'image/jpeg'}; res.writeHead(200, {'Content-Type':mime[path.extname(file)]||'application/octet-stream','Access-Control-Allow-Origin':'*'}).end(body); } catch { res.writeHead(404).end(); }
});
(async()=>{
 let browser;
 try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await browserType.launch(browserLaunchOptions(engine,true));
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage(); page.setDefaultTimeout(15000); const errors=[];
  if (process.env.DEBUG_STUDIO) { page.on('console', m=>console.log('browser:',m.text())); page.on('pageerror',e=>console.log('pageerror:',String(e))); }
  page.on('requestfailed',r=>{if(process.env.DEBUG_STUDIO)console.log('failed',r.url(),r.failure());});
  page.on('pageerror', e=>errors.push(String(e)));
  page.on('dialog', dialog=>dialog.accept());
  await page.goto(origin+'/fixture');
  await page.waitForFunction(()=>window.host._ready);
  let frame=page.frames().find(frame=>frame.url().includes('embed='));
  assert(frame,'Sandboxed editor loaded');
  assert.equal(await frame.evaluate(()=>{try{return parent.document.body.innerHTML;}catch{return 'isolated';}}),'isolated');
  assert.equal(await frame.evaluate(()=>{try{return localStorage.length;}catch{return 'isolated';}}),'isolated');
  await page.evaluate(()=>localStorage.setItem('home-studio.project.v1','standalone draft sentinel'));
  await frame.getByLabel('Home Assistant floor',{exact:true}).selectOption('ground');
  await frame.locator('#start-room').click();
  await frame.locator('#starter-name').fill('Living room');
  await frame.locator('#starter-width').fill('5'); await frame.locator('#starter-depth').fill('4');
  await frame.locator('#starter-create').click();
  await frame.getByLabel('Home Assistant area',{exact:true}).selectOption('living');
  await frame.getByLabel('Add device to this room',{exact:true}).selectOption('light.ceiling');
  await frame.getByRole('button',{name:'Add linked item',exact:true}).click();
  let project=await frame.evaluate(()=>window.planner.getProject());
  assert.equal(project.floors[0].ha_floor_id,'ground');
  assert.equal(project.floors[0].rooms[0].ha_area_id,'living');
  assert.equal(project.floors[0].items[0].entity_id,'light.ceiling');
  assert.equal(project.floors[0].walls.length,4);
  assert.equal(await page.evaluate(()=>localStorage.getItem('home-studio.project.v1')),'standalone draft sentinel');
  assert.equal(await page.evaluate(()=>JSON.stringify(window.host._catalog).includes('PRIVATE')),false);
  assert.equal(await page.evaluate(()=>JSON.stringify(window.host._catalog).includes('NEVER_SEND_TOKEN')),false);
  await page.locator('#save').click();
  await page.waitForFunction(()=>window.server.revision===1 && !window.host._busy);
  assert.deepEqual(await page.evaluate(()=>window.server.project),project);
  await page.locator('#publish').click(); await page.waitForFunction(()=>window.server.published_revision===1);
  if (process.env.STUDIO_SCREENSHOT) await page.screenshot({path:process.env.STUDIO_SCREENSHOT,fullPage:true});
  // Metadata and device mapping survive JSON export.
  const downloadEvent=page.waitForEvent('download'); await page.locator('#export').click();
  const downloaded=await downloadEvent;
  assert.deepEqual(JSON.parse(fs.readFileSync(await downloaded.path(),'utf8')),project);
  // Changes from an incorrect source/channel never reach HA or mutate the host.
  const previous=await page.evaluate(()=>JSON.stringify(window.host._project));
  await page.evaluate(()=>window.postMessage({protocol:'home-studio-editor-v1',channel:window.host._channel,type:'snapshot',sequence:500,project:{title:'forged'}},'*'));
  await frame.evaluate(()=>parent.postMessage({protocol:'home-studio-editor-v1',channel:'wrong',type:'snapshot',sequence:500,project:{title:'forged'}},'*'));
  assert.equal(await page.evaluate(()=>JSON.stringify(window.host._project)),previous);
  // Failure keeps editing usable and recovery intact.
  await page.evaluate(()=>window.failSave=true);
  await frame.locator('#project-title').fill('Offline edits'); await frame.locator('#project-title').press('Tab');
  await page.locator('#save').click(); await page.waitForFunction(()=>!window.host._busy);
  assert.match(await page.locator('#status').innerText(),/Save failed/);
  assert.equal(await page.evaluate(()=>window.server.project.title),project.title);
  await page.reload(); await page.waitForFunction(()=>!window.host.$('recovery').hidden);
  await page.locator('#resume').click(); await page.waitForFunction(()=>window.host._ready);
  frame=page.frames().find(frame=>frame.url().includes('embed='));
  assert.equal(await frame.evaluate(()=>window.planner.getProject().title),'Offline edits');
  // Optimistic revision conflicts preserve the working copy.
  await page.evaluate(()=>window.server.revision++);
  await page.locator('#save').click(); await page.waitForFunction(()=>!window.host._busy);
  assert.match(await page.locator('#status').innerText(),/Another session/);
  assert.equal(await frame.evaluate(()=>window.planner.getProject().title),'Offline edits');
  await page.locator('#reload').click(); await page.waitForFunction(()=>window.host._ready && window.host._revision===2);
  frame=page.frames().find(frame=>frame.url().includes('embed='));
  assert.equal(await frame.evaluate(()=>window.planner.getProject().title),project.title);
  // The isolated editor still supports normal project replacement/import.
  const imported={...project,title:'Imported portable drawing'};
  await frame.locator('#file-input').setInputFiles({name:'project.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(imported))});
  await frame.waitForFunction(()=>window.planner.getProject().title==='Imported portable drawing');
  // Saving a snapshot never marks edits made during the request as saved.
  await page.evaluate(()=>window.holdSave=true);
  await page.locator('#save').click(); await page.waitForFunction(()=>typeof window.releaseSave==='function');
  await frame.locator('#project-title').fill('Newer than saved snapshot'); await frame.locator('#project-title').press('Tab');
  await page.waitForFunction(()=>window.host._project.title==='Newer than saved snapshot');
  await page.evaluate(()=>window.releaseSave()); await page.waitForFunction(()=>!window.host._busy);
  assert.equal(await page.evaluate(()=>window.server.project.title),'Imported portable drawing');
  assert.equal(await page.evaluate(()=>window.host._dirty()),true);
  assert.equal(await page.locator('#publish').isDisabled(),true);
  // A delayed reload must not discard edits made after its confirmation.
  await page.evaluate(()=>{window.holdGet=true;delete window.releaseGet;});
  await page.locator('#reload').click(); await page.waitForFunction(()=>typeof window.releaseGet==='function');
  await frame.locator('#project-title').fill('Edit made while reloading');
  // Leave the field focused: the final snapshot must flush this unfinished edit.
  await page.evaluate(()=>window.releaseGet()); await page.waitForFunction(()=>!window.host._busy);
  assert.equal(await frame.evaluate(()=>window.planner.getProject().title),'Edit made while reloading');
  assert.equal(await page.evaluate(()=>window.host._project.title),'Edit made while reloading');
  assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem(window.host._key())).project.title),'Edit made while reloading');
  assert.match(await page.locator('#status').innerText(),/Reload cancelled/);
  // The next deliberate reload still succeeds when no intervening edit occurs.
  await page.evaluate(()=>window.holdGet=false);
  await page.locator('#reload').click(); await page.waitForFunction(()=>window.host._ready&&!window.host._busy&&!window.host._dirty());
  assert.equal(await page.evaluate(()=>window.host._project.title),'Imported portable drawing');
  // A still-focused field is unsaved, and one click saves its entered value.
  frame=page.frames().find(frame=>frame.url().includes('embed='));
  await page.evaluate(()=>window.holdSave=false);
  await frame.locator('#project-title').fill('Saved with one click');
  await page.waitForFunction(()=>window.host._edits.pending);
  assert.equal(await page.locator('#save').isEnabled(),true);
  assert.equal(await page.locator('#publish').isDisabled(),true);
  await page.locator('#save').click();
  await page.waitForFunction(()=>window.server.project.title==='Saved with one click'&&!window.host._busy);
  assert.equal(await page.evaluate(()=>window.host._unsaved()),false);
  const savedCalls=await page.evaluate(()=>calls.filter(call=>call.type.endsWith('project_save')).length);
  // Invalid title text is retained, described, focused, and never saved.
  await frame.locator('#project-title').fill('');
  await page.locator('#save').click(); await page.waitForFunction(()=>!window.host._busy&&window.host._edits.invalid);
  assert.equal(await frame.locator('#project-title').inputValue(),'');
  assert.equal(await frame.locator('#project-title').getAttribute('aria-invalid'),'true');
  assert.equal(await frame.locator('#project-title').getAttribute('aria-describedby'),'status');
  assert.equal(await frame.locator('#project-title').evaluate(field=>field===document.activeElement),true);
  assert.match(await page.locator('#status').innerText(),/Correct Project title/);
  assert.equal(await page.evaluate(()=>calls.filter(call=>call.type.endsWith('project_save')).length),savedCalls);
  assert.equal(await page.evaluate(()=>window.host._pending.size),0);
  await frame.locator('#project-title').fill('Saved with one click'); await frame.locator('#project-title').press('Tab');
  await page.waitForFunction(()=>!window.host._unsaved());
  await frame.locator('[data-object-kind="rooms"]').first().click();
  const polygon=frame.getByLabel('x, z coordinates (m)',{exact:true});
  const validPolygon=await polygon.inputValue();
  await polygon.fill('invalid polygon'); await page.locator('#save').click();
  await page.waitForFunction(()=>!window.host._busy&&window.host._edits.invalid);
  assert.equal(await polygon.inputValue(),'invalid polygon');
  assert.equal(await polygon.evaluate(field=>field===document.activeElement),true);
  assert.equal(await page.locator('#publish').isDisabled(),true);
  const publishedCalls=await page.evaluate(()=>calls.filter(call=>call.type.endsWith('project_publish')).length);
  // Exercise the snapshot guard as well as the disabled Publish button.
  await page.evaluate(()=>window.host._publish());
  assert.equal(await page.evaluate(()=>calls.filter(call=>call.type.endsWith('project_publish')).length),publishedCalls);
  assert.equal(await page.evaluate(()=>calls.filter(call=>call.type.endsWith('project_save')).length),savedCalls);
  const validExport=page.waitForEvent('download'); await page.locator('#export').click();
  assert.deepEqual(JSON.parse(fs.readFileSync(await (await validExport).path(),'utf8')),await page.evaluate(()=>window.server.project));
  assert.match(await page.locator('#status').innerText(),/Unfinished or invalid field text is not included/);
  assert.equal(await polygon.inputValue(),'invalid polygon');
  // Editing rejected text while a reload is in flight must still cancel replacement.
  await page.evaluate(()=>{window.holdGet=true;delete window.releaseGet;});
  await page.locator('#reload').click(); await page.waitForFunction(()=>typeof window.releaseGet==='function');
  await polygon.fill('new invalid text entered during reload');
  await page.evaluate(()=>window.releaseGet()); await page.waitForFunction(()=>!window.host._busy);
  assert.equal(await polygon.inputValue(),'new invalid text entered during reload');
  assert.match(await page.locator('#status').innerText(),/Reload cancelled/);
  await page.evaluate(()=>window.holdGet=false);
  await polygon.fill(validPolygon); await polygon.press('Tab'); await page.waitForFunction(()=>!window.host._unsaved());
  // An administrator role change immediately removes private authoring data.
  await page.evaluate(()=>{window.host.hass={...window.host._hass,user:{id:'test-user',is_admin:false}};});
  assert.equal(await page.locator('iframe').count(),0);
  assert.equal(await page.evaluate(()=>window.host._project),null);
  assert.equal(await page.locator('#export').isDisabled(),true);
  assert.match(await page.locator('#status').innerText(),/administrator/);
  // Late initialization cannot mount a frame after its host is detached.
  await page.evaluate(async()=>{
    const detached=document.createElement('home-floorplan-studio-panel'); window.detached=detached;
    const pending=[]; detached.hass={user:{id:'other-admin',is_admin:true},callWS:data=>new Promise(resolve=>pending.push([data,resolve]))};
    document.body.append(detached); detached.remove();
    pending.forEach(([data,resolve])=>resolve(data.type.endsWith('entity_catalog')?window.catalog:{project:window.server.project,revision:1,can_edit:true}));
    await Promise.resolve();await Promise.resolve();
  });
  assert.equal(await page.evaluate(()=>window.detached.shadowRoot.querySelector('iframe')),null);
  // Repeated HA state updates do not turn a failed initialization into a retry loop.
  await page.evaluate(async()=>{
    const retry=document.createElement('home-floorplan-studio-panel');window.retryHost=retry;window.retryCalls=0;
    const hass={user:{id:'retry-admin',is_admin:true},callWS:async()=>{window.retryCalls++;throw new Error('Offline');}};
    retry.hass=hass;document.body.append(retry);await Promise.resolve();await Promise.resolve();
    retry.hass=hass;retry.hass=hass;
  });
  assert.equal(await page.evaluate(()=>window.retryCalls),2);
  await page.evaluate(()=>window.retryHost.$('retry').click());
  await page.waitForFunction(()=>window.retryCalls===4);
  // Script failures have a bounded wait and retry preserves the chosen recovery.
  const startup=await context.newPage(); startup.on('pageerror',e=>errors.push(String(e)));
  const recovered={...project,title:'Recovery after loading failure'};
  await startup.addInitScript(({project,recovered})=>{
    if (window.parent !== window) return;
    sessionStorage.setItem('fixture-server',JSON.stringify({project,revision:5,published_revision:5}));
    sessionStorage.setItem('home-studio.ha-tab-draft.v1:test-user',JSON.stringify({project:recovered,revision:5}));
  },{project,recovered});
  await startup.clock.install();
  await startup.route('**/planner/editor.js',route=>route.abort());
  await startup.goto(origin+'/fixture'); await startup.locator('#resume').click();
  await startup.waitForFunction(()=>window.host._frame);
  await startup.clock.fastForward(15001);
  await startup.waitForFunction(()=>window.host._startupFailed);
  assert.equal(await startup.locator('iframe').count(),0);
  assert.equal(await startup.locator('#retry').isVisible(),true);
  assert.equal(await startup.locator('#export').isEnabled(),true);
  assert.equal(await startup.evaluate(()=>window.host._startupTimer),null);
  assert.equal(await startup.evaluate(()=>window.host._project.title),recovered.title);
  const recoveryExport=startup.waitForEvent('download'); await startup.locator('#export').click();
  assert.deepEqual(JSON.parse(fs.readFileSync(await (await recoveryExport).path(),'utf8')),recovered);
  await startup.unroute('**/planner/editor.js');
  await startup.locator('#retry').click(); await startup.waitForFunction(()=>window.host._ready);
  assert.equal(await startup.locator('iframe').count(),1);
  assert.equal(await startup.evaluate(()=>window.host._project.title),recovered.title);
  assert.equal(await startup.evaluate(()=>window.host._startupTimer),null);
  assert.equal(await startup.evaluate(()=>window.calls.filter(call=>call.type.endsWith('project_get')).length),1);
  await startup.setViewportSize({width:390,height:844});
  assert.equal(await startup.locator('header').evaluate(header=>header.scrollWidth<=header.clientWidth),true);
  assert.equal(await startup.locator('#save').evaluate(button=>button.getBoundingClientRect().height>=44),true);
  // An obsolete timeout cannot remove a ready editor; teardown clears a pending one.
  await startup.clock.fastForward(16000); assert.equal(await startup.locator('iframe').count(),1);
  await startup.evaluate(()=>{window.host._openEditor(window.host._project);window.host.remove();});
  assert.equal(await startup.evaluate(()=>window.host._startupTimer),null);
  await startup.clock.fastForward(16000); assert.equal(await startup.evaluate(()=>window.host._startupFailed),false);
  await startup.close();
  // Initialization errors retain even an unreadable original for portable recovery.
  const damaged=await context.newPage(); damaged.on('pageerror',e=>errors.push(String(e)));
  await damaged.addInitScript(()=>{
    if (window.parent !== window) return;
    sessionStorage.setItem('fixture-server',JSON.stringify({project:{title:'Unreadable original'},revision:3,published_revision:null}));
  });
  await damaged.goto(origin+'/fixture'); await damaged.waitForFunction(()=>window.host._startupFailed);
  assert.equal(await damaged.locator('iframe').count(),0);
  const originalExport=damaged.waitForEvent('download'); await damaged.locator('#export').click();
  assert.deepEqual(JSON.parse(fs.readFileSync(await (await originalExport).path(),'utf8')),{title:'Unreadable original'});
  await damaged.locator('#retry').click(); await damaged.waitForFunction(()=>window.host._startupFailed);
  assert.equal(await damaged.locator('iframe').count(),0);
  assert.equal(await damaged.evaluate(()=>window.host._startupTimer),null);
  await damaged.close();
  // A generated installation uses its established source workflow, not connection retry.
  const legacy=await context.newPage();
  await legacy.addInitScript(project=>{
    if (window.parent !== window) return;
    sessionStorage.setItem('fixture-server',JSON.stringify({project,mode:'legacy',revision:1,published_revision:1}));
  },project);
  await legacy.goto(origin+'/fixture'); await legacy.waitForFunction(()=>window.calls.length===2&&!window.host._startupTimer);
  assert.match(await legacy.locator('#status').innerText(),/original project JSON/);
  assert.equal(await legacy.locator('#status').evaluate(status=>status.classList.contains('error')),false);
  assert.equal(await legacy.locator('#retry').isVisible(),false);
  assert.equal(await legacy.locator('#family').isVisible(),true);
  assert.equal(await legacy.locator('a.external').isVisible(),true);
  assert.equal(await legacy.locator('iframe').count(),0);
  assert.deepEqual(await legacy.evaluate(()=>window.server.project),project);
  assert.equal(await legacy.evaluate(()=>window.calls.some(call=>/project_(save|publish)$/.test(call.type))),false);
  await legacy.evaluate(()=>{window.host.hass=window.host._hass;window.host._retryStartup();});
  assert.equal(await legacy.evaluate(()=>window.calls.length),2);
  await legacy.close();
  // A late HA response after the connection deadline cannot mount a stale frame.
  await page.clock.install();
  await page.evaluate(project=>{
    sessionStorage.setItem('home-studio.ha-tab-draft.v1:late-admin',JSON.stringify({project,revision:8}));
    window.lateHost=document.createElement('home-floorplan-studio-panel');
    lateHost.hass={user:{id:'late-admin',is_admin:true},callWS:data=>data.type.endsWith('entity_catalog')?Promise.resolve(window.catalog):new Promise(resolve=>window.lateResponse=resolve)};
    document.body.append(lateHost);
  },recovered);
  await page.clock.fastForward(15001);
  assert.equal(await page.evaluate(()=>window.lateHost._startupFailed),true);
  assert.equal(await page.evaluate(()=>window.lateHost.$('export').disabled),false);
  await page.evaluate(project=>window.lateResponse({project,revision:8,can_edit:true}),project);
  assert.equal(await page.evaluate(()=>window.lateHost.shadowRoot.querySelectorAll('iframe').length),0);
  const originalRecovery=await page.evaluate(()=>sessionStorage.getItem(window.lateHost._key()));
  await page.evaluate(project=>{
    window.newRemote={...project,title:'Newer server drawing'};
    window.lateHost.hass={user:{id:'late-admin',is_admin:true},callWS:async data=>{
      if (data.type.endsWith('entity_catalog')) return window.catalog;
      if (data.type.endsWith('project_save')) throw {code:'conflict'};
      return {project:window.newRemote,revision:9,published_revision:null,can_edit:true};
    }};
    window.lateHost._retryStartup();
  },project);
  await page.waitForFunction(()=>!window.lateHost.$('recovery').hidden);
  assert.equal(await page.evaluate(()=>window.lateHost._revision),9);
  assert.equal(await page.evaluate(()=>window.lateHost._project.title),recovered.title);
  await page.evaluate(()=>window.lateHost.remove());
  assert.equal(await page.evaluate(()=>sessionStorage.getItem(window.lateHost._key())),originalRecovery,'unresolved recovery retains its original revision after detach');
  await page.evaluate(()=>document.body.append(window.lateHost));
  await page.waitForFunction(()=>!window.lateHost.$('recovery').hidden);
  await page.evaluate(()=>window.lateHost.$('resume').click());
  await page.waitForFunction(()=>window.lateHost._ready);
  assert.equal(await page.evaluate(()=>window.lateHost._revision),8);
  await page.evaluate(()=>window.lateHost._save());
  assert.match(await page.evaluate(()=>window.lateHost.$('status').textContent),/Another session/);
  assert.equal(await page.evaluate(()=>window.newRemote.title),'Newer server drawing');
  await page.evaluate(()=>window.lateHost.remove());
  assert.deepEqual(errors,[]);
  await context.close();
  console.log(`Native studio passed (${engine}): opaque sandbox, area/device onboarding, save/publish, JSON roundtrip, forged messages, local draft isolation, offline recovery, revision conflict, in-flight edits, pending/invalid fields, loading timeout and recovery retry.`);
 } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
