// Actual Studio UI with local fictional data and synthetic websocket replies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {chromium, firefox, webkit} = require('playwright');
const {browserLaunchOptions} = require('./browser-stability-diagnostics.cjs');
const root = path.resolve(__dirname, '..'), engine = process.env.BROWSER || 'chromium';
const html = `<!doctype html><html><body><script type="module">
await import('/studio.js');
const host = window.host = document.createElement('home-floorplan-studio-panel');
const connection = window.connection = new EventTarget();connection.connected=true;
const floor=id=>({id,name:id==='upper'?'Upper floor':'Ground floor',elevation_m:0,height_m:3,rooms:[{id:'room',name:'Room',polygon:[[0,0],[4,0],[4,4],[0,4]],material:'floor'}],walls:[],openings:[],items:[]});
const project={schema_version:1,title:'Fictional imported home',floors:[floor('upper'),floor('ground')]};
const initial={project,revision:1,published_revision:1,has_saved_draft:true,has_published:true,can_edit:true,
 capabilities:{authoring:true,architecture_editing:false,imported_runtime_upgrade:true},
 source:{kind:'generated',protected_floors:['upper','ground'],protected_rooms:{upper:['room'],ground:['room']},custom_items:{}}};
window.calls=[];window.mode='normal';window.invalid='';window.reopened=0;
host._snapshot=async()=>structuredClone(host._project);
host._openEditor=()=>{window.reopened++;throw Error('Runtime upgrade must preserve the current editor');};
host._hass={user:{id:'fixture-admin',is_admin:true},connection,callWS:async data=>{
 calls.push(structuredClone(data));
 if(data.type==='home_floorplan/project_save'){
  window.saved={...window.saved,project:structuredClone(data.project),revision:data.revision+1};return structuredClone(window.saved);
 }
 if(data.type==='home_floorplan/project_runtime_upgrade_preview'){
  if(mode==='fail-preview')throw {code:'unsupported_runtime',message:'The saved viewer is not a supported source.'};
  const reply={token:'fixture-upgrade-token',revision:data.revision,current_runtime:{version:0,sha256:'a'.repeat(64)},target_runtime:{version:1,sha256:'b'.repeat(64)},files:['upper/index.html','ground/index.html'],changed_file_count:2};
  if(invalid==='files')reply.files=['upper/index.html','other/index.html'];
  if(invalid==='duplicate')reply.files=['upper/index.html','upper/index.html'];
  if(invalid==='token')reply.token='';
  if(invalid==='hash')reply.target_runtime.sha256=reply.current_runtime.sha256;
  if(invalid==='version')reply.target_runtime.version=2;
  if(invalid==='count')reply.changed_file_count=1;
  if(mode==='pending-preview')return new Promise(resolve=>window.release=()=>resolve(reply));
  return reply;
 }
 if(data.type==='home_floorplan/project_runtime_upgrade_apply'){
  if(mode==='fail-apply')throw {code:'source_changed',message:'The saved source changed.'};
  const reply={...structuredClone(window.saved),revision:data.revision+1};
  if(mode==='changed-apply-project')reply.project.title='Unexpected server project';
  const finish=()=>{window.saved=structuredClone(reply);return reply;};
  if(mode==='pending-apply')return new Promise(resolve=>window.release=()=>resolve(finish()));
  return finish();
 }
 throw Error('Unexpected request: '+data.type);
}};
window.resetFixture=()=>{
 host._cancelViewerRuntime();host._generation++;window.calls=[];window.mode='normal';window.invalid='';window.release=null;
 window.saved=structuredClone(initial);host._saved=window.saved;host._source=structuredClone(initial.source);
 host._project=structuredClone(project);host._savedRaw=JSON.stringify(project);host._revision=1;host._publishedRevision=1;
 host._edits={};host._started=true;host._ready=true;host._busy=false;host._showingPublished=false;host._viewerRuntimeUnconfirmed=false;
 host._hass.user.is_admin=true;connection.connected=true;host._syncConnection();host._buttons();
 host.$('more-options').open=true;
};
window.resetFixture();document.body.append(host);host._buttons();
</script></body></html>`;

(async()=>{
  const server=http.createServer((req,res)=>{
    const file=req.url==='/studio.js'?'studio.js':req.url==='/map-transport.js'?'map-transport.js':null;
    if(file){res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(path.join(root,'custom_components/home_floorplan/static',file)));}
    else if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(html);}
    else{res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await ({chromium,firefox,webkit}[engine]).launch(browserLaunchOptions(engine,true));
  try{
    const page=await browser.newPage(),errors=[],external=[];
    page.on('pageerror',error=>errors.push(String(error)));
    await page.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():(external.push(route.request().url()),route.abort()));
    await page.goto(origin);await page.waitForFunction(()=>window.host?._ready);
    const button=page.locator('#viewer-runtime'),dialog=page.locator('#viewer-runtime-dialog');
    const reset=async()=>{await page.evaluate(()=>resetFixture());await dialog.waitFor({state:'hidden'});};
    const preview=async()=>{await button.click();await dialog.waitFor({state:'visible'});await page.waitForFunction(()=>!host._busy);};
    const disconnect=()=>page.evaluate(()=>{connection.connected=false;connection.dispatchEvent(new Event('disconnected'));});
    const reconnect=()=>page.evaluate(()=>{connection.connected=true;connection.dispatchEvent(new Event('ready'));});
    const count=type=>page.evaluate(type=>calls.filter(call=>call.type.endsWith(type)).length,type);

    await preview();
    assert.match(await dialog.innerText(),/Map renderer: version 0 → version 1/);
    assert.match(await dialog.innerText(),/active published home stays unchanged/);
    assert.match(await page.locator('#viewer-runtime-files').innerText(),/Upper floor: saved viewer/);
    assert.equal(await dialog.locator('input,textarea').count(),0,'No URL, script or source inputs');
    assert.deepEqual(await page.evaluate(()=>Object.keys(calls[0]).sort()),['revision','type']);
    assert.equal(await count('_apply'),0,'Preview never applies or publishes');
    await page.locator('#viewer-runtime-cancel').click();
    await page.waitForFunction(()=>host._viewerRuntimePreview===null);
    assert.equal(await page.evaluate(()=>host._revision),1);

    await reset();await page.evaluate(()=>{host._project.title='Edited fictional home';host._buttons();});
    assert(await button.isDisabled(),'Latest draft must be saved first');
    await page.locator('#save').click();await page.waitForFunction(()=>host._revision===2&&!host._busy);
    await preview();assert.equal(await page.evaluate(()=>calls.find(x=>x.type.endsWith('_preview')).revision),2);
    await page.locator('#viewer-runtime-apply').click();await page.waitForFunction(()=>host._revision===3&&!host._busy);
    assert.equal(await page.evaluate(()=>host._project.title),'Edited fictional home');
    assert.equal(await page.evaluate(()=>host._publishedRevision),1,'Preparation never publishes');
    assert.equal(await page.evaluate(()=>reopened),0,'Preparation keeps the current editor');
    assert.equal(await count('project_publish'),0);
    assert.deepEqual(await page.evaluate(()=>Object.keys(calls.find(x=>x.type.endsWith('_apply'))).sort()),['revision','token','type']);
    assert.match(await page.locator('#status').innerText(),/Publish to 3D Home when ready/);

    for(const invalid of ['files','duplicate','token','hash','version','count']){
      await reset();await page.evaluate(value=>window.invalid=value,invalid);await button.click();
      await page.waitForFunction(()=>!host._busy);
      assert.equal(await dialog.isVisible(),false,invalid+' preview must fail closed');
      assert.match(await page.locator('#status').innerText(),/preview is invalid/);
      assert.equal(await count('_apply'),0);
    }
    await reset();await page.evaluate(()=>window.mode='fail-preview');await button.click();await page.waitForFunction(()=>!host._busy);
    assert.match(await page.locator('#status').innerText(),/not a supported source/);
    await reset();await preview();await page.evaluate(()=>window.mode='fail-apply');
    await page.locator('#viewer-runtime-apply').click();await page.waitForFunction(()=>!host._busy&&!host._viewerRuntimePreview);
    assert.equal(await page.evaluate(()=>host._revision),1);assert.match(await page.locator('#status').innerText(),/Load saved draft/);
    assert.equal(await dialog.isVisible(),false);

    await reset();await preview();await page.evaluate(()=>window.mode='changed-apply-project');
    await page.locator('#viewer-runtime-apply').click();await page.waitForFunction(()=>!host._busy);
    assert.equal(await page.evaluate(()=>host._revision),1,'Unexpected response must not partially update state');
    assert.equal(await page.evaluate(()=>host._project.title),'Fictional imported home');
    assert.match(await page.locator('#status').innerText(),/unexpected project state/);

    await reset();await preview();await page.evaluate(()=>{host._project.title='New local edit';host._buttons();});
    assert(await page.locator('#viewer-runtime-apply').isDisabled());
    await page.evaluate(()=>host._applyViewerRuntime());assert.equal(await count('_apply'),0);

    await reset();await page.evaluate(()=>window.mode='pending-preview');await button.click();await page.waitForFunction(()=>typeof release==='function');
    await disconnect();assert.equal(await page.evaluate(()=>host._busy),false,'Disconnect clears the owned operation');
    assert(await button.isDisabled());await reconnect();
    assert.equal(await count('_preview'),1,'Reconnection never replays a request');
    await page.evaluate(()=>release());await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
    assert.equal(await dialog.isVisible(),false,'Stale preview must not reopen after reconnect');

    await reset();await page.evaluate(()=>window.mode='pending-preview');await button.click();await page.waitForFunction(()=>typeof release==='function');
    await page.evaluate(()=>{host._project.title='Edited during preview';release();});await page.waitForFunction(()=>!host._busy);
    assert.equal(await dialog.isVisible(),false);assert.match(await page.locator('#status').innerText(),/drawing changed/);

    await reset();await preview();await page.evaluate(()=>window.mode='pending-apply');await page.locator('#viewer-runtime-apply').click();
    await page.waitForFunction(()=>typeof release==='function');await disconnect();await reconnect();
    await page.evaluate(()=>release());await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
    assert.equal(await page.evaluate(()=>host._revision),1,'A late result from an old connection is not adopted');
    assert.equal(await page.evaluate(()=>host._busy),false);assert.equal(await count('_apply'),1);
    assert.equal(await dialog.isVisible(),false);
    assert(await button.isDisabled(),'An uncertain apply requires reloading saved state');
    assert.match(await page.locator('#status').innerText(),/Load saved draft/);

    await reset();await preview();await page.evaluate(()=>window.mode='pending-apply');await page.locator('#viewer-runtime-apply').click();
    await page.waitForFunction(()=>typeof release==='function');
    await page.evaluate(()=>{host._project.title='Newer unsaved title';host._buttons();release();});
    await page.waitForFunction(()=>host._revision===2&&!host._busy);
    assert.equal(await page.evaluate(()=>host._project.title),'Newer unsaved title','A successful apply preserves newer local edits');
    assert.equal(await page.evaluate(()=>JSON.parse(host._savedRaw).title),'Fictional imported home');
    assert.match(await page.locator('#status').innerText(),/Newer edits remain unsaved/);

    await reset();await page.evaluate(()=>window.mode='pending-preview');await button.click();await page.waitForFunction(()=>typeof release==='function');
    await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));await page.evaluate(()=>release());
    await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
    assert.equal(await page.evaluate(()=>host._busy),false);assert.equal(await dialog.isVisible(),false);

    for(const restriction of ['native','viewer','read-only','capability']){
      await reset();await page.evaluate(value=>{
        if(value==='native')host._saved.source=null;
        if(value==='viewer')host._hass.user.is_admin=false;
        if(value==='read-only')host._saved.can_edit=false;
        if(value==='capability')host._saved.capabilities.imported_runtime_upgrade=false;
        host._buttons();
      },restriction);
      assert.equal(await button.isVisible(),false,restriction+' is not eligible');
      await page.evaluate(()=>host._previewViewerRuntime());assert.equal(await count('_preview'),0);
    }
    await reset();await page.evaluate(()=>{host._saved.has_saved_draft=false;host._buttons();});
    assert(await button.isDisabled(),'Imported source must first have a saved draft');
    await reset();await page.evaluate(()=>{host._saved.has_published=false;host._publishedRevision=null;host._buttons();});
    assert(await button.isDisabled(),'The service needs a matching published generation');
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    console.log(engine+': imported viewer preview, save requirement, explicit apply, preservation, invalid replies, cancellation and authority guards passed');
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
