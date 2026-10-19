const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { browserLaunchOptions } = require('./browser-stability-diagnostics.cjs');
const root = path.resolve(__dirname, '..');
const fixture = `<!doctype html><html style="height:100%"><head><meta charset="utf-8"></head><body style="margin:0;height:100%"><home-floorplan-studio-panel></home-floorplan-studio-panel><script src="/custom_components/home_floorplan/static/studio.js"></script><script>
window.calls=[];window.failSave=false;window.holdSave=false;window.tokens='NEVER_SEND_TOKEN';
const saved=JSON.parse(sessionStorage.getItem('fixture-server')||'null')||{project:null,revision:0,published_revision:null};
window.server=saved;
window.catalog={floors:[{id:'ground',name:'Ground floor'}],areas:[{id:'living',name:'Living room',floor_id:'ground'}],entities:[{entity_id:'light.ceiling',name:'Ceiling light',domain:'light',area_id:'living',available:true,attributes:{secret:'PRIVATE_ATTRIBUTE'}},{entity_id:'sensor.temperature',name:'Temperature',domain:'sensor',area_id:'living',available:true},{entity_id:'switch.disabled',name:'Disabled',domain:'switch',area_id:'living',disabled:true}],secrets:'PRIVATE_CATALOG'};
window.host=document.querySelector('home-floorplan-studio-panel');
window.host.hass={user:{id:'test-user',is_admin:true},auth:{accessToken:window.tokens},callWS:async data=>{window.calls.push(structuredClone(data));if(data.type.endsWith('entity_catalog'))return window.catalog;if(data.type.endsWith('project_save')){if(window.failSave)throw {code:'connection_error',message:'Offline'};if(data.revision!==saved.revision)throw {code:'conflict'};if(window.holdSave)await new Promise(resolve=>window.releaseSave=resolve);saved.project=data.project;saved.revision++;sessionStorage.setItem('fixture-server',JSON.stringify(saved));}if(data.type.endsWith('project_publish')){if(data.revision!==saved.revision)throw {code:'conflict'};saved.published_revision=saved.revision;sessionStorage.setItem('fixture-server',JSON.stringify(saved));}return {...structuredClone(saved),can_edit:true,editor_url:'/home-floorplan-studio/planner/index.html',capabilities:{authoring:true}};}};
</script></body></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/fixture') return res.writeHead(200, {'Content-Type':'text/html'}).end(fixture);
  const route = url.pathname.replace(/^\/home-floorplan-studio\//, '/');
  const file = path.resolve(root, '.' + route + (route.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep)) return res.writeHead(404).end();
  try { const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.jpg':'image/jpeg'}; res.writeHead(200, {'Content-Type':mime[path.extname(file)]||'application/octet-stream','Access-Control-Allow-Origin':'*'}).end(fs.readFileSync(file)); } catch { res.writeHead(404).end(); }
});
(async()=>{
 let browser;
 try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch(browserLaunchOptions('chromium',true));
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
  assert.deepEqual(errors,[]);
  await context.close();
  console.log('Native studio passed: opaque sandbox, area/device onboarding, save/publish, JSON roundtrip, forged messages, local draft isolation, offline recovery, revision conflict, in-flight edits.');
 } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
