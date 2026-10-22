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
const version = JSON.parse(fs.readFileSync(path.join(root, 'custom_components/home_floorplan/manifest.json'), 'utf8')).version;
const panelPath = `/home-floorplan-static/studio.js?v=${version}`;
const fixture = `<!doctype html><html style="height:100%"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;height:100%"><home-floorplan-studio-panel></home-floorplan-studio-panel><script type="module">
// Match Home Assistant's loadModule: append an async module script and wait for
// its load event before giving the registered custom element its hass object.
window.loadPanelModule = url => new Promise((resolve, reject) => {
  const script = document.createElement('script'); script.type = 'module'; script.async = true;
  script.onload = resolve; script.onerror = () => reject(new Error('Panel module failed to load'));
  script.src = url; document.body.append(script);
});
await window.loadPanelModule(${JSON.stringify(panelPath)});
window.calls=[];window.failSave=false;window.holdSave=false;window.tokens='NEVER_SEND_TOKEN';
const saved=JSON.parse(sessionStorage.getItem('fixture-server')||'null')||{project:null,revision:0,published_revision:null};
window.server=saved;
window.catalog={floors:[{id:'ground',name:'Ground floor'}],areas:[{id:'living',name:'Living room',floor_id:'ground'}],entities:[{entity_id:'light.ceiling',name:'Ceiling light',domain:'light',area_id:'living',available:true,attributes:{secret:'PRIVATE_ATTRIBUTE'}},{entity_id:'sensor.temperature',name:'Temperature',domain:'sensor',area_id:'living',available:true},{entity_id:'switch.disabled',name:'Disabled',domain:'switch',area_id:'living',disabled:true}],secrets:'PRIVATE_CATALOG'};
window.host=document.querySelector('home-floorplan-studio-panel');
window.host.hass={user:{id:'test-user',is_admin:true},auth:{accessToken:window.tokens},callWS:async data=>{window.calls.push(structuredClone(data));if(data.type.endsWith('entity_catalog'))return window.catalog;if(data.type==='home_floorplan/viewer')return {mode:saved.mode||'native',has_editor:true,can_edit:true,site_features:false,floor:'ground',floors:['ground'],revision:1,items:[],readable_entities:[],controllable_entities:[],html:'<html><head></head><body>Published synthetic home</body></html>'};if(data.type.endsWith('project_get')&&window.holdGet)await new Promise(resolve=>window.releaseGet=resolve);if(data.type.endsWith('project_save')){if(window.failSave)throw {code:'connection_error',message:'Offline'};if(data.revision!==saved.revision)throw {code:'conflict'};if(window.holdSave)await new Promise(resolve=>window.releaseSave=resolve);saved.project=data.project;saved.has_saved_draft=true;saved.revision++;sessionStorage.setItem('fixture-server',JSON.stringify(saved));}if(data.type.endsWith('project_publish')){if(data.revision!==saved.revision)throw {code:'conflict'};if(!saved.project?.floors?.length||saved.project.floors.some(floor=>!floor.rooms?.length))throw {code:'invalid_project',message:'Add at least one room to every floor before publishing.'};saved.published_revision=saved.revision;saved.published_project=structuredClone(saved.project);sessionStorage.setItem('fixture-server',JSON.stringify(saved));}return {...structuredClone(saved),can_edit:true,has_saved_draft:saved.has_saved_draft??!!saved.project,has_published:saved.has_published??Number.isInteger(saved.published_revision),editor_url:'/home-floorplan-studio/planner/index.html',capabilities:{authoring:true,...saved.capabilities}};}};
</script></body></html>`;
// This destination checks the real navigation URL and saved publication source.
// Rendering the generated family viewer is covered by separate acceptance tests.
const familyFixture = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<h1>3D Home navigation fixture</h1><p id="publication"></p><home-floorplan-panel></home-floorplan-panel>
<script type="module">await import('/home-floorplan-static/panel.js?v=${version}');
const saved=JSON.parse(sessionStorage.getItem('fixture-server')||'null');
document.getElementById('publication').textContent=saved?.published_project?.floors.flatMap(floor=>floor.rooms.map(room=>room.name)).join(', ')||'No published drawing';
window.viewer=document.querySelector('home-floorplan-panel');
viewer.hass={user:{id:'test-user',is_admin:true},states:{},callWS:async()=>({mode:saved?.mode||'native',has_editor:true,can_edit:true,site_features:false,floor:'ground',floors:['ground'],revision:1,items:[],readable_entities:[],controllable_entities:[],html:'<html><body>Published viewer navigation fixture</body></html>'})};
</script></body></html>`;
async function openMoreOptions(page) {
  const details=page.locator('#more-options');
  if (await details.getAttribute('open')===null) await details.getByText('More options',{exact:true}).click();
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (['/fixture','/home-studio'].includes(url.pathname)) return res.writeHead(200, {'Content-Type':'text/html'}).end(fixture);
  if (url.pathname === '/home-floorplan') return res.writeHead(200, {'Content-Type':'text/html'}).end(familyFixture);
  const route = url.pathname.replace(/^\/home-floorplan-static\//, '/custom_components/home_floorplan/static/')
    .replace(/^\/home-floorplan-studio\//, '/');
  const file = path.resolve(root, '.' + route + (route.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep)) return res.writeHead(404).end();
  try {
    const body=fs.readFileSync(file);
    const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.jpg':'image/jpeg'};
    const headers={'Content-Type':mime[path.extname(file)]||'application/octet-stream'};
    // Only sandboxed editor assets need CORS; the panel module is same-origin.
    if (url.pathname.startsWith('/home-floorplan-studio/')) headers['Access-Control-Allow-Origin']='*';
    res.writeHead(200, headers).end(body);
  } catch { res.writeHead(404).end(); }
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
  const moduleResponse = page.waitForResponse(response=>response.url()===origin+panelPath);
  await page.goto(origin+'/fixture');
  const response = await moduleResponse;
  assert.equal(response.status(),200,'The registered production panel URL must return JavaScript');
  assert.match(response.headers()['content-type'],/^(?:text|application)\/javascript\b/);
  assert.equal(response.headers()['access-control-allow-origin'],undefined,'The same-origin panel must not depend on editor CORS');
  await page.waitForFunction(()=>window.host?._ready);
  assert.equal(await page.evaluate(async url=>{
    const registered = customElements.get('home-floorplan-studio-panel');
    await window.loadPanelModule(url);
    await window.loadPanelModule(url+'&reload=1');
    return !!registered && customElements.get('home-floorplan-studio-panel')===registered;
  },panelPath),true,'Repeated module loads must preserve the registered custom element');
  let frame=page.frames().find(frame=>frame.url().includes('embed='));
  assert(frame,'Sandboxed editor loaded');
  assert.equal(await frame.evaluate(()=>{try{return parent.document.body.innerHTML;}catch{return 'isolated';}}),'isolated');
  assert.equal(await frame.evaluate(()=>{try{return localStorage.length;}catch{return 'isolated';}}),'isolated');
  // A novice who only opens Studio has no edits to recover or publish.
  assert.equal(await page.evaluate(()=>window.host._unsaved()),false);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem(window.host._key())),null);
  assert.equal(await page.getByRole('button',{name:'Save draft',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'Publish to 3D Home',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'Add devices',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('link',{name:'Open 3D Home',exact:true}).getAttribute('aria-disabled'),'true');
  assert.equal(await page.locator('#more-options').getAttribute('open'),null);
  assert.equal(await page.locator('#export').isVisible(),false);
  assert.equal(await page.locator('#reload').isVisible(),false);
  await page.reload(); await page.waitForFunction(()=>window.host?._ready);
  assert.equal(await page.locator('#recovery').isVisible(),false,'Revisiting an untouched blank drawing must not prompt for recovery');
  assert.equal(await page.evaluate(()=>sessionStorage.getItem(window.host._key())),null);
  frame=page.frames().find(frame=>frame.url().includes('embed='));
  await page.evaluate(()=>localStorage.setItem('home-studio.project.v1','standalone draft sentinel'));
  await frame.getByLabel('Home Assistant floor',{exact:true}).selectOption('ground');
  const firstRoom=page.getByRole('button',{name:'Add your first room',exact:true});
  await firstRoom.focus(); await firstRoom.press('Enter');
  const starter=frame.getByRole('dialog',{name:'Create a room',exact:true});
  await starter.waitFor({state:'visible'});
  assert.equal(await starter.getByLabel('Room name',{exact:true}).evaluate(field=>field===document.activeElement),true);
  await starter.getByLabel('Room name',{exact:true}).fill('Living room');
  await starter.getByLabel('Width (m)',{exact:true}).fill('5');
  await starter.getByLabel('Depth (m)',{exact:true}).fill('4');
  await starter.getByLabel('Depth (m)',{exact:true}).press('Enter');
  await page.getByRole('button',{name:'Add another room',exact:true}).waitFor();
  await page.getByRole('button',{name:'Add devices',exact:true}).click();
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
  await page.getByRole('button',{name:'Preview 3D',exact:true}).click();
  await frame.waitForFunction(()=>window.planner.getView()==='preview'&&window.planner.getPreviewMetadata().renderCount>0);
  await frame.getByRole('tab',{name:'Plan 2D',exact:true}).click();
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await page.waitForFunction(()=>window.server.revision===1 && !window.host._busy);
  assert.deepEqual(await page.evaluate(()=>window.server.project),project);
  assert.equal(await page.evaluate(()=>window.server.published_revision),null,'Saving a draft must not publish it');
  await page.getByRole('button',{name:'Publish to 3D Home',exact:true}).click();
  await page.waitForFunction(()=>window.server.published_revision===1&&!window.host._busy);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem(window.host._key())),null);
  // HA can detach and reattach a panel without a document reload.
  await page.evaluate(()=>{window.host.remove();document.body.append(window.host);});
  await page.waitForFunction(()=>window.host._ready);
  frame=page.frames().find(frame=>frame.url().includes('embed='));
  assert.deepEqual(await frame.evaluate(()=>window.planner.getProject()),project);
  assert.equal(await page.locator('#recovery').isVisible(),false);
  assert.equal(await page.evaluate(()=>window.host._unsaved()),false);
  // Follow the user-facing link, then return through the navigation fixture.
  await page.getByRole('link',{name:'Open 3D Home',exact:true}).click();
  await page.waitForURL(origin+'/home-floorplan');
  assert.equal(await page.locator('#publication').innerText(),'Living room');
  const editHome=page.getByRole('link',{name:'Edit home',exact:true});
  await editHome.waitFor({state:'visible'});
  await page.evaluate(()=>window.viewer.pending=1);
  await editHome.click();
  assert.equal(new URL(page.url()).pathname,'/home-floorplan');
  assert.match(await page.locator('#notice').innerText(),/Wait for the current save/);
  await page.evaluate(()=>{window.viewer.pending=0;window.viewer.failed=true;});
  await editHome.click();
  assert.equal(new URL(page.url()).pathname,'/home-floorplan');
  assert.match(await page.locator('#notice').innerText(),/Keep this view open/);
  await page.evaluate(()=>{window.viewer.failed=false;window.viewer.serverCanEdit=false;window.viewer.updateAccessUI();});
  assert.equal(await editHome.isVisible(),false,'A non-editable viewer must not expose authoring navigation');
  await page.evaluate(()=>{window.viewer.serverCanEdit=true;window.viewer.updateAccessUI();});
  await editHome.click();
  await page.waitForURL(origin+'/home-studio'); await page.waitForFunction(()=>window.host?._ready);
  frame=page.frames().find(frame=>frame.url().includes('embed='));
  assert.deepEqual(await frame.evaluate(()=>window.planner.getProject()),project);
  assert.equal(await page.locator('#recovery').isVisible(),false);
  assert.equal(await page.evaluate(()=>window.host._unsaved()),false);
  assert.equal(await page.evaluate(()=>window.server.published_revision),1);
  if (process.env.STUDIO_SCREENSHOT) await page.screenshot({path:process.env.STUDIO_SCREENSHOT,fullPage:true});
  // Metadata and device mapping survive JSON export.
  await openMoreOptions(page);
  const downloadEvent=page.waitForEvent('download'); await page.locator('#export').click();
  const downloaded=await downloadEvent;
  assert.deepEqual(JSON.parse(fs.readFileSync(await downloaded.path(),'utf8')),project);
  // Changes from an incorrect source/channel never reach HA or mutate the host.
  const previous=await page.evaluate(()=>JSON.stringify(window.host._project));
  await page.evaluate(()=>window.postMessage({protocol:'home-studio-editor-v1',channel:window.host._channel,type:'snapshot',sequence:500,project:{title:'forged'}},'*'));
  await frame.evaluate(()=>parent.postMessage({protocol:'home-studio-editor-v1',channel:'wrong',type:'snapshot',sequence:500,project:{title:'forged'}},'*'));
  await frame.evaluate(()=>new Promise(resolve=>{
    const received=event=>{
      if(event.source!==window||event.origin!=='null'||event.data?.requestId!=='forged-guide')return;
      window.removeEventListener('message',received);resolve();
    };
    window.addEventListener('message',received);
    window.postMessage({protocol:'home-studio-editor-v1',channel:new URLSearchParams(location.hash.slice(1)).get('ha-studio'),type:'guide-action',action:'room',requestId:'forged-guide'},'*');
  }));
  await page.evaluate(async()=>{
    window.host._frame.contentWindow.postMessage({protocol:'home-studio-editor-v1',channel:'wrong',type:'guide-action',action:'room'},'*');
    await window.host._snapshot(true);
  });
  assert.equal(await page.evaluate(()=>JSON.stringify(window.host._project)),previous);
  assert.equal(await frame.getByRole('dialog',{name:'Create a room',exact:true}).isVisible(),false,'Forged guide messages must not open editor controls');
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
  await openMoreOptions(page);
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
  assert.equal(await page.getByRole('link',{name:'Open 3D Home',exact:true}).getAttribute('aria-disabled'),'false','Non-admin users must retain access to the viewer link');
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
  assert.equal(await page.evaluate(()=>window.retryHost.$('family').getAttribute('aria-disabled')),'false','An unavailable authoring connection must not disable viewer navigation');
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
  await openMoreOptions(startup);
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
  await openMoreOptions(damaged);
  const originalExport=damaged.waitForEvent('download'); await damaged.locator('#export').click();
  assert.deepEqual(JSON.parse(fs.readFileSync(await (await originalExport).path(),'utf8')),{title:'Unreadable original'});
  await damaged.locator('#retry').click(); await damaged.waitForFunction(()=>window.host._startupFailed);
  assert.equal(await damaged.locator('iframe').count(),0);
  assert.equal(await damaged.evaluate(()=>window.host._startupTimer),null);
  await damaged.close();
  // A missing authoring source stays local and never sends users to an external editor.
  const legacy=await context.newPage();
  await legacy.addInitScript(project=>{
    if (window.parent !== window) return;
    sessionStorage.setItem('fixture-server',JSON.stringify({project,mode:'legacy',revision:1,published_revision:1,has_published:true,capabilities:{authoring:false}}));
  },project);
  await legacy.goto(origin+'/fixture'); await legacy.waitForFunction(()=>window.calls.length===2&&!window.host._startupTimer);
  assert.match(await legacy.locator('#status').innerText(),/drawing source.*unavailable/);
  assert.equal(await legacy.locator('#status').evaluate(status=>status.classList.contains('error')),true);
  assert.equal(await legacy.locator('#retry').isVisible(),false);
  assert.equal(await legacy.locator('#family').isVisible(),true);
  await openMoreOptions(legacy);
  assert.equal(await legacy.getByRole('link',{name:/browser editor/i}).count(),0);
  assert.equal(await legacy.locator('iframe').count(),0);
  assert.deepEqual(await legacy.evaluate(()=>window.server.project),project);
  assert.equal(await legacy.evaluate(()=>window.calls.some(call=>/project_(save|publish)$/.test(call.type))),false);
  await legacy.evaluate(()=>{window.host.hass=window.host._hass;window.host._retryStartup();});
  assert.equal(await legacy.evaluate(()=>window.calls.length),2);
  await legacy.close();
  // An existing generated home remains viewable while its genuine source opens
  // in the same native editor, even before its first native publication.
  const generatedProject=structuredClone(project);
  for(const floor of generatedProject.floors){floor.walls=[];floor.openings=[];for(const item of floor.items)for(const key of ['model_id','style_id','color','pattern_id','pattern_color'])delete item[key];}
  const generated=await context.newPage();generated.on('pageerror',error=>errors.push(String(error)));
  await generated.addInitScript(project=>{
    if(window.parent!==window||sessionStorage.getItem('generated-seeded'))return;
    sessionStorage.setItem('generated-seeded','1');
    sessionStorage.setItem('fixture-server',JSON.stringify({project,mode:'legacy',revision:0,published_revision:null,
      published_project:project,has_published:true,has_saved_draft:false,capabilities:{architecture_editing:false},source:{kind:'generated',protected_floors:project.floors.map(floor=>floor.id),
        protected_rooms:Object.fromEntries(project.floors.map(floor=>[floor.id,floor.rooms.map(room=>room.id)])),
        custom_items:Object.fromEntries(project.floors.map(floor=>[floor.id,floor.items.map(item=>item.id)]))}}));
  },generatedProject);
  await generated.goto(origin+'/fixture');await generated.waitForFunction(()=>window.host._ready);
  // A generated seed is editable source, but no private draft exists until Save succeeds.
  assert.equal(await generated.evaluate(()=>window.server.has_saved_draft),false);
  assert.equal(await generated.evaluate(()=>window.host._unsaved()),false);
  assert.equal(await generated.evaluate(()=>sessionStorage.getItem(window.host._key())),null);
  assert.equal(await generated.getByRole('button',{name:'Save draft',exact:true}).isDisabled(),false);
  assert.equal(await generated.getByRole('button',{name:'Publish to 3D Home',exact:true}).isDisabled(),true);
  await generated.evaluate(()=>window.host._publish());
  assert.equal(await generated.evaluate(()=>window.calls.some(call=>call.type.endsWith('project_publish'))),false);
  await generated.evaluate(()=>window.failSave=true);
  await generated.getByRole('button',{name:'Save draft',exact:true}).click();
  await generated.waitForFunction(()=>!window.host._busy&&window.host.$('status').textContent.includes('Save failed'));
  assert.equal(await generated.evaluate(()=>window.server.has_saved_draft),false);
  assert.equal(await generated.getByRole('button',{name:'Save draft',exact:true}).isDisabled(),false);
  assert.equal(await generated.getByRole('button',{name:'Publish to 3D Home',exact:true}).isDisabled(),true);
  await generated.evaluate(()=>window.failSave=false);
  await generated.getByRole('button',{name:'Save draft',exact:true}).click();
  await generated.waitForFunction(()=>!window.host._busy&&window.server.revision===1);
  assert.equal(await generated.evaluate(()=>window.server.has_saved_draft),true);
  assert.equal(await generated.evaluate(()=>window.server.published_revision),null);
  assert.equal(await generated.getByRole('button',{name:'Save draft',exact:true}).isDisabled(),true);
  assert.equal(await generated.getByRole('button',{name:'Publish to 3D Home',exact:true}).isDisabled(),false);
  await generated.reload();await generated.waitForFunction(()=>window.host._ready);
  assert.equal(await generated.evaluate(()=>window.host._saved.has_saved_draft),true);
  assert.equal(await generated.getByRole('button',{name:'Save draft',exact:true}).isDisabled(),true);
  assert.equal(await generated.getByRole('button',{name:'Publish to 3D Home',exact:true}).isDisabled(),false);
  let generatedFrame=generated.frames().find(frame=>frame.url().includes('embed='));
  assert.deepEqual(await generatedFrame.evaluate(()=>planner.getProject()),generatedProject);
  assert.equal(await generated.getByRole('link',{name:'Open 3D Home',exact:true}).getAttribute('aria-disabled'),'false');
  assert.equal(await generated.getByRole('link',{name:/browser editor/i}).count(),0);
  assert.equal(await generatedFrame.getByRole('button',{name:'Add floor',exact:true}).isDisabled(),true);
  assert.equal(await generatedFrame.getByLabel('Elevation (m)',{exact:true}).getAttribute('readonly'),'');
  await generatedFrame.locator('[data-object-kind="rooms"]').first().click();
  assert.equal(await generatedFrame.getByLabel('x, z coordinates (m)',{exact:true}).getAttribute('readonly'),'');
  assert.equal(await generatedFrame.getByLabel('Floor material',{exact:true}).isDisabled(),true);
  assert.equal(await generatedFrame.getByRole('button',{name:'Delete room',exact:true}).count(),0);
  await generatedFrame.locator('[data-object-kind="items"]').first().click();
  assert.equal(await generatedFrame.getByLabel('Design',{exact:true}).inputValue(),'');
  assert.match(await generatedFrame.getByLabel('Design',{exact:true}).locator('option:checked').innerText(),/Original installed model/);
  await generatedFrame.getByLabel('x (m)',{exact:true}).fill('2.2');
  await generatedFrame.getByLabel('x (m)',{exact:true}).press('Tab');
  await generated.waitForFunction(()=>window.host._project.floors[0].items[0].position_m.x===2.2);
  const generatedTitle=generatedFrame.locator('#project-title');
  await generatedTitle.fill('');
  await generated.getByRole('link',{name:'Open 3D Home',exact:true}).click();
  await generated.waitForFunction(()=>!window.host._busy&&window.host.$('status').textContent.includes('highlighted field'));
  assert.equal(new URL(generated.url()).pathname,'/fixture');
  assert.equal(await generatedTitle.inputValue(),'');
  // Published preview is the real read-only viewer, retaining the draft iframe
  // and its unfinished field instead of approximating the protected geometry.
  const draftBeforePreview=await generatedFrame.evaluate(()=>planner.getProject());
  await generated.evaluate(()=>window.originalEditorFrame=window.host._frame);
  await generatedFrame.getByRole('button',{name:'Published home',exact:true}).click();
  await generated.waitForFunction(()=>window.host._publishedPanel?.serverCanEdit===true);
  assert.deepEqual(await generated.evaluate(()=>({canEdit:window.host._publishedPanel.canEdit,dryRun:window.host._publishedPanel.dryRun,hidden:window.originalEditorFrame.hidden})),{canEdit:false,dryRun:true,hidden:true});
  assert.equal(await generatedFrame.evaluate(()=>planner.getView()),'plan');
  assert.equal(await generatedFrame.evaluate(()=>planner.getPreviewMetadata().renderCount||0),0);
  await generated.getByRole('button',{name:'Back to editing',exact:true}).click();
  assert.equal(await generated.evaluate(()=>window.host._frame===window.originalEditorFrame&&!window.originalEditorFrame.hidden&&window.host._publishedPanel===null),true);
  assert.equal(await generatedTitle.inputValue(),'');
  assert.deepEqual(await generatedFrame.evaluate(()=>planner.getProject()),draftBeforePreview);
  // Re-requesting the family view returns keyboard focus to the pending field.
  await generated.getByRole('link',{name:'Open 3D Home',exact:true}).click();
  await generated.waitForFunction(()=>!window.host._busy&&window.host.$('status').textContent.includes('highlighted field'));
  assert.equal(await generatedTitle.evaluate(input=>input===document.activeElement&&document.hasFocus()),true);
  assert.equal(await generated.evaluate(()=>window.server.project.title),project.title);
  assert.equal(await generated.evaluate(()=>window.calls.some(call=>/project_(save|publish)$/.test(call.type))),false);
  await generatedTitle.fill('Edited generated home');await generatedTitle.press('Tab');
  await generated.waitForFunction(()=>window.host._dirty());
  await generated.getByRole('link',{name:'Open 3D Home',exact:true}).click();
  await generated.waitForFunction(()=>!window.host._busy&&window.host.$('status').textContent.includes('Save draft before'));
  assert.equal(new URL(generated.url()).pathname,'/fixture');
  assert.equal(await generated.locator('#save').evaluate(button=>button===button.getRootNode().activeElement),true);
  await generated.evaluate(()=>window.holdSave=true);
  await generated.getByRole('button',{name:'Save draft',exact:true}).click();
  await generated.waitForFunction(()=>typeof window.releaseSave==='function');
  await generated.getByRole('link',{name:'Open 3D Home',exact:true}).click();
  assert.equal(new URL(generated.url()).pathname,'/fixture');
  assert.match(await generated.locator('#status').innerText(),/Wait for the current operation/);
  await generated.evaluate(()=>window.releaseSave());await generated.waitForFunction(()=>!window.host._busy);
  assert.equal(await generated.evaluate(()=>window.server.revision),2);
  assert.equal(await generated.evaluate(()=>window.server.published_revision),null);
  await generated.getByRole('button',{name:'Publish to 3D Home',exact:true}).click();
  await generated.waitForFunction(()=>window.server.published_revision===2&&!window.host._busy);
  await generated.getByRole('link',{name:'Open 3D Home',exact:true}).click();
  await generated.waitForURL(origin+'/home-floorplan');
  await generated.getByRole('link',{name:'Edit home',exact:true}).click();
  await generated.waitForURL(origin+'/home-studio');await generated.waitForFunction(()=>window.host._ready);
  generatedFrame=generated.frames().find(frame=>frame.url().includes('embed='));
  assert.equal(await generatedFrame.evaluate(()=>planner.getProject().title),'Edited generated home');
  assert.equal(await generatedFrame.evaluate(()=>planner.getProject().floors[0].items[0].position_m.x),2.2);
  assert.deepEqual(await generatedFrame.evaluate(()=>planner.getProject().floors[0].rooms),generatedProject.floors[0].rooms);
  assert.deepEqual(await generated.evaluate(()=>window.server.published_project),await generatedFrame.evaluate(()=>planner.getProject()));
  assert.equal(await generated.evaluate(()=>window.host._unsaved()),false);
  await generated.close();
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
  assert.equal(await page.evaluate(()=>window.lateHost.$('family').getAttribute('aria-disabled')),'false','Unknown publication state after startup timeout must retain viewer navigation');
  await page.evaluate(project=>window.lateResponse({project,revision:8,can_edit:true}),project);
  assert.equal(await page.evaluate(()=>window.lateHost.shadowRoot.querySelectorAll('iframe').length),0);
  const originalRecovery=await page.evaluate(()=>sessionStorage.getItem(window.lateHost._key()));
  await page.evaluate(project=>{
    window.newRemote={...project,title:'Newer server drawing'};
    window.lateHost.hass={user:{id:'late-admin',is_admin:true},callWS:async data=>{
      if (data.type.endsWith('entity_catalog')) return window.catalog;
      if (data.type.endsWith('project_save')) throw {code:'conflict'};
      return {project:window.newRemote,revision:9,published_revision:null,can_edit:true,capabilities:{authoring:true}};
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
  // Linking HA areas and devices is optional: plain room geometry can publish.
  const unlinkedProject=structuredClone(project);
  for (const floor of unlinkedProject.floors) {
    delete floor.ha_floor_id; floor.items=[];
    for (const room of floor.rooms) delete room.ha_area_id;
  }
  const incomplete=await context.newPage(); incomplete.on('pageerror',e=>errors.push(String(e)));
  await incomplete.addInitScript(project=>{
    if (window.parent!==window) return;
    sessionStorage.setItem('fixture-server',JSON.stringify({project,revision:1,published_revision:null}));
  },unlinkedProject);
  await incomplete.goto(origin+'/fixture'); await incomplete.waitForFunction(()=>window.host?._ready);
  await incomplete.getByRole('button',{name:'Publish to 3D Home',exact:true}).click();
  await incomplete.waitForFunction(()=>window.server.published_revision===1&&!window.host._busy);
  assert.deepEqual(await incomplete.evaluate(()=>window.server.published_project),unlinkedProject);
  // An empty additional floor remains a valid draft, but cannot be published.
  const incompleteFrame=incomplete.frames().find(frame=>frame.url().includes('embed='));
  await incompleteFrame.getByRole('button',{name:'Add floor',exact:true}).click();
  await incomplete.waitForFunction(()=>window.host._project.floors.length===2);
  await incomplete.getByRole('button',{name:'Save draft',exact:true}).click();
  await incomplete.waitForFunction(()=>window.server.revision===2&&!window.host._busy);
  assert.equal(await incomplete.evaluate(()=>window.host._unsaved()),false);
  assert.equal(await incomplete.evaluate(()=>window.server.project.floors[1].rooms.length),0);
  assert.equal(await incomplete.getByRole('button',{name:'Publish to 3D Home',exact:true}).isDisabled(),true);
  assert.match(await incomplete.locator('#status').innerText(),/room/i,'Publication guidance must explain the missing room');
  const incompletePublishes=await incomplete.evaluate(()=>window.calls.filter(call=>call.type.endsWith('project_publish')).length);
  await incomplete.evaluate(()=>window.host._publish());
  assert.equal(await incomplete.evaluate(()=>window.calls.filter(call=>call.type.endsWith('project_publish')).length),incompletePublishes,'The publish method also rejects incomplete floors');
  assert.equal(await incomplete.evaluate(()=>window.server.published_revision),1);
  assert.deepEqual(await incomplete.evaluate(()=>window.server.published_project),unlinkedProject,'The existing publication remains unchanged');
  await incomplete.close();
  // Exercise rejected shortcuts and recovery on their own first-room draft.
  {
    const page=await context.newPage();page.setDefaultTimeout(15000);
    page.on('pageerror',error=>errors.push(String(error)));
    await page.goto(origin+'/fixture');await page.waitForFunction(()=>window.host?._ready);
    const frame=page.frames().find(frame=>frame.url().includes('embed='));
    await page.getByRole('button',{name:'Add your first room',exact:true}).click();
    const starter=frame.getByRole('dialog',{name:'Create a room',exact:true});
    await starter.getByLabel('Room name',{exact:true}).fill('Field recovery room');
    await starter.getByRole('button',{name:'Create room',exact:true}).click();
    await page.getByRole('button',{name:'Add another room',exact:true}).waitFor();
    const originalProject=await frame.evaluate(()=>planner.getProject());
    // Host shortcuts must not discard raw inspector text while changing context.
    await frame.evaluate(parentOrigin=>{
      window.guideMessages=0;
      window.addEventListener('message',event=>{
        if(event.source===parent&&event.origin===parentOrigin&&event.data?.type==='guide-action')window.guideMessages++;
      });
    },origin);
    async function assertGuideRetainsField(buttonName,field,raw) {
      const before=await frame.evaluate(()=>({project:planner.getProject(),selection:planner.getSelection(),messages:window.guideMessages}));
      await page.waitForFunction(()=>window.host._edits.pending);
      await page.getByRole('button',{name:buttonName,exact:true}).click();
      // Observe the real bridge event without requesting a snapshot that would
      // itself validate the field and mask a missing shortcut guard.
      await frame.waitForFunction(count=>window.guideMessages>count,before.messages);
      assert.equal(await field.inputValue(),raw,`${buttonName} retains unfinished field text`);
      assert.equal(await frame.evaluate(()=>document.hasFocus()),true,`${buttonName} returns keyboard focus to the editor`);
      assert.equal(await field.evaluate(input=>input===document.activeElement),true,`${buttonName} returns focus to the unfinished field`);
      assert.equal(await starter.isVisible(),false,`${buttonName} does not open a new room over unfinished text`);
      assert.deepEqual(await frame.evaluate(()=>planner.getSelection()),before.selection);
      assert.deepEqual(await frame.evaluate(()=>planner.getProject()),before.project);
      assert.equal(await page.evaluate(()=>window.host._edits.pending),true);
    }
    const firstPolygon=frame.getByLabel('x, z coordinates (m)',{exact:true});
    const originalPolygon=await firstPolygon.inputValue();
    await firstPolygon.fill('unfinished corner');
    await assertGuideRetainsField('Add another room',firstPolygon,'unfinished corner');
    await assertGuideRetainsField('Add devices',firstPolygon,'unfinished corner');
    await firstPolygon.fill(originalPolygon);await firstPolygon.press('Tab');
    await page.getByRole('button',{name:'Save draft',exact:true}).click();
    await page.waitForFunction(()=>window.server.revision===1&&!window.host._busy&&!window.host._edits.pending);
    assert.deepEqual(await page.evaluate(()=>window.server.project),originalProject);
    assert.equal(await page.evaluate(()=>window.server.published_revision),null);
    const firstTitle=frame.locator('#project-title');
    // Global fields need the same guard after keyboard focus has moved elsewhere.
    await firstTitle.fill('');await firstTitle.press('Tab');
    await assertGuideRetainsField('Add another room',firstTitle,'');
    await firstTitle.fill('Recovered field edits');
    await page.getByRole('button',{name:'Save draft',exact:true}).click();
    await page.waitForFunction(()=>window.server.revision===2&&!window.host._busy&&!window.host._edits.pending);
    assert.deepEqual(await page.evaluate(()=>window.server.project),{...originalProject,title:'Recovered field edits'});
    assert.equal(await page.evaluate(()=>window.server.published_revision),null);
    await page.getByRole('button',{name:'Add another room',exact:true}).click();
    await starter.waitFor({state:'visible'});
    await starter.getByRole('button',{name:'Close',exact:true}).click();
    assert.equal(await frame.evaluate(()=>planner.getProject().floors[0].rooms.length),1);
    await page.getByRole('button',{name:'Add devices',exact:true}).click();
    await frame.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Home Assistant area');
    assert.equal(await page.evaluate(()=>window.host._unsaved()),false);
    await page.close();
  }
  // HA supplies a viewport meta tag. Exercise the actual narrow layout rather
  // than the 980px layout viewport that mobile browsers use without that tag.
  const mobileContext=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,
    ...(engine==='firefox'?{}:{isMobile:true})}); // Firefox supports the touch viewport, not isMobile emulation.
  const mobile=await mobileContext.newPage(); mobile.setDefaultTimeout(15000);
  mobile.on('pageerror',e=>errors.push(String(e)));
  await mobile.goto(origin+'/fixture'); await mobile.waitForFunction(()=>window.host?._ready);
  const mobileFrame=mobile.frames().find(frame=>frame.url().includes('embed='));
  async function checkMobileWidths() {
    const outer=await mobile.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,
      host:window.host.scrollWidth,hostClient:window.host.clientWidth}));
    const editor=await mobileFrame.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth}));
    assert.equal(outer.viewport,390);
    assert(outer.document<=outer.viewport&&outer.host<=outer.hostClient,'The native shell must not scroll horizontally');
    assert.equal(editor.viewport,390);
    assert(editor.document<=editor.viewport,'The embedded editor must not scroll horizontally');
  }
  function insideMobileViewport(box,label) {
    assert(box&&box.x>=0&&box.y>=0&&box.x+box.width<=391&&box.y+box.height<=845,`${label} must fit the visible mobile viewport`);
  }
  await checkMobileWidths();
  await mobile.getByRole('button',{name:'Add your first room',exact:true}).tap();
  const mobileStarter=mobileFrame.getByRole('dialog',{name:'Create a room',exact:true});
  await mobileStarter.waitFor({state:'visible'});
  const mobileName=mobileStarter.getByLabel('Room name',{exact:true});
  assert.equal(await mobileName.evaluate(field=>field===document.activeElement),true);
  insideMobileViewport(await mobileStarter.boundingBox(),'Room dialog');
  insideMobileViewport(await mobileName.boundingBox(),'Room name field');
  await mobileName.fill('Mobile room');
  await mobileStarter.getByRole('button',{name:'Create room',exact:true}).tap();
  await mobile.waitForFunction(()=>window.host._project.floors[0].rooms.length===1);
  assert.equal(await mobileFrame.evaluate(()=>window.planner.getProject().floors[0].walls.length),4);
  const mobileSave=mobile.getByRole('button',{name:'Save draft',exact:true});
  await mobileSave.scrollIntoViewIfNeeded();
  const mobileSaveBox=await mobileSave.boundingBox();
  insideMobileViewport(mobileSaveBox,'Save draft');
  assert(mobileSaveBox.height>=44,'Save draft retains a mobile touch target');
  await mobileSave.tap(); await mobile.waitForFunction(()=>window.server.revision===1&&!window.host._busy);
  assert.equal(await mobile.evaluate(()=>window.server.project.floors[0].rooms[0].name),'Mobile room');
  assert.equal(await mobile.evaluate(()=>window.host._unsaved()),false);
  await checkMobileWidths();
  await mobileContext.close();
  assert.deepEqual(errors,[]);
  await context.close();
  console.log(`Native studio passed (${engine}): production panel module route, repeated module loading, opaque sandbox, clean first visit, guided room/device/preview flow, unfinished-field guard and recovery, separate save/publish, generated protected editing and published preview, guarded navigation and remount, incomplete-floor publication guard, JSON roundtrip, forged messages, local draft isolation, offline recovery, revision conflict, in-flight edits, pending/invalid fields, loading timeout and recovery retry.`);
 } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
