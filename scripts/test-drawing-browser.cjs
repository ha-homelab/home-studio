const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, firefox, webkit } = require('playwright');
const { browserLaunchOptions } = require('./browser-stability-diagnostics.cjs');
const root = path.resolve(__dirname, '..');
const engine = process.env.BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[engine];
assert(browserType, 'Choose chromium, firefox, or webkit.');
const artifactDir = process.env.DRAWING_ARTIFACTS;
const diagnostic = { phase: 'startup', lifecycle: [], errors: [], requests: [] };
let activePage, activeFrame;
const bounded = async (read, milliseconds = 2000) => {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(read), new Promise(resolve => {
      timer = setTimeout(() => resolve({ unavailable: 'diagnostic deadline' }), milliseconds);
    })]);
  } catch (error) { return { unavailable: String(error.message).slice(0, 240) }; }
  finally { clearTimeout(timer); }
};
// Passive, bounded evidence survives an input-command timeout. No form values,
// project contents, request bodies, focus changes or replacement clicks.
function installInputDiagnostics() {
  const describe = element => element?.tagName ? {
    tag: element.tagName, id: element.id, action: element.dataset?.drawingAction,
  } : null;
  const rect = element => element?.getBoundingClientRect().toJSON() || null;
  window.__drawingInputEvents = [];
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'focusin', 'scroll']) {
    document.addEventListener(type, event => {
      window.__drawingInputEvents.push({ type, at: performance.now(), target: describe(event.target),
        point: typeof event.clientX === 'number' ? [event.clientX, event.clientY] : null,
        record: rect(document.querySelector('[data-drawing-action="record-measurement"]')) });
      if (window.__drawingInputEvents.length > 48) window.__drawingInputEvents.shift();
    }, { capture: true, passive: true });
  }
}
function documentDiagnostics() {
  const describe = element => element?.tagName ? {
    tag: element.tagName, id: element.id, action: element.dataset?.drawingAction,
  } : null;
  const geometry = element => {
    if (!element) return null;
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { ...describe(element), rect: rect.toJSON(), scroll: [element.scrollLeft, element.scrollTop, element.scrollWidth, element.scrollHeight],
      display: style.display, visibility: style.visibility, pointerEvents: style.pointerEvents,
      centerTarget: describe(element.getRootNode().elementFromPoint?.(rect.x + rect.width / 2, rect.y + rect.height / 2)) };
  };
  const host = document.querySelector('home-floorplan-studio-panel');
  return { readyState: document.readyState, visibility: document.visibilityState, focused: document.hasFocus(),
    viewport: [innerWidth, innerHeight, devicePixelRatio], scroll: [scrollX, scrollY], active: describe(document.activeElement),
    fonts: document.fonts.status, styles: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).slice(0, 8).map(link => ({
      path: new URL(link.href).pathname, loaded: !!link.sheet,
    })),
    dialog: geometry(document.querySelector('dialog[open]')),
    record: geometry(document.querySelector('[data-drawing-action="record-measurement"]')),
    header: geometry(document.querySelector('.drawing-header')), footer: geometry(document.querySelector('.drawing-panel>footer')),
    host: geometry(host), iframe: geometry(host?.shadowRoot?.querySelector('iframe')),
    native: host ? { ready: host._ready, busy: host._busy, generation: host._generation, sequence: host._sequence } : null,
    events: window.__drawingInputEvents || [] };
}
async function failureDiagnostics(browser, context) {
  const targets = [...new Set([activePage, activeFrame])].filter(Boolean);
  // Keep this free of layout/style reads: a blocked rendering query is not
  // sufficient evidence that the document's JavaScript also stopped running.
  const heartbeats = await Promise.all(targets.map(target => bounded(() => target.evaluate(() => ({
    at: performance.now(), readyState: document.readyState, visibility: document.visibilityState,
  })), 500)));
  const documents = await Promise.all(targets.map(target => bounded(() => target.evaluate(documentDiagnostics))));
  const report = { engine, browser: browser?.version(), node: process.version, platform: process.platform,
    ...diagnostic, pageCount: context?.pages().length, heartbeats, documents };
  console.error('Drawing failure diagnostics:', JSON.stringify(report));
  if (!artifactDir) return;
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, `drawing-${engine}-failure.json`), JSON.stringify(report, null, 2) + '\n');
  if (activePage) await bounded(() => activePage.screenshot({ path: path.join(artifactDir, `drawing-${engine}-failure.png`), timeout: 2000 }));
}
const fixture = { schema_version: 1, id: 'drawing_check', title: 'Measured studio', floors: [{
  id: 'ground', name: 'Ground floor', elevation_m: 0, height_m: 2.7,
  rooms: [{ id: 'studio', name: 'Studio', material: 'floor', polygon: [[0,0],[4,0],[4,3],[0,3]] }],
  walls: [
    { id:'south', start:[0,0], end:[4,0], thickness_m:.15 },
    { id:'east', start:[4,0], end:[4,3], thickness_m:.15 },
    { id:'north', start:[4,3], end:[0,3], thickness_m:.15 },
    { id:'west', start:[0,3], end:[0,0], thickness_m:.15 }
  ], openings: [
    { id:'door', wall_id:'south', type:'door', offset_m:.2, width_m:.9, sill_m:0, head_m:2 },
    { id:'window', wall_id:'north', type:'window', offset_m:1, width_m:1.2, sill_m:.6, head_m:2.1 }
  ], items: [{id:'pendant', name:'Studio pendant', type:'chandelier', room:'studio',
    position_m:{x:2,y:2.4,z:1.5},dimensions_m:{width:.3,depth:.3,height:.3},rotation_deg:0,
    entity_id:'light.private_fixture',notes:'PRIVATE_NOTE_NOT_FOR_EXPORT'}]
}] };
const hostHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;--primary-background-color:#111b2a;--card-background-color:#202d40;--primary-text-color:#e6edf4;--secondary-text-color:#aabbcc;--divider-color:#40506a;--primary-color:#58baff;--error-color:#ff8877;color-scheme:dark}
</style></head><body><home-floorplan-studio-panel></home-floorplan-studio-panel><script type="module">
await import('/home-floorplan-static/studio.js');
const state={project:${JSON.stringify(fixture)},mode:'native',revision:1,published_revision:null,has_saved_draft:true,has_published:false};
window.host=document.querySelector('home-floorplan-studio-panel'); window.server=state;
host.hass={user:{id:'synthetic-admin',is_admin:true},language:'en',locale:{language:'en'},themes:{darkMode:true},states:{},callWS:async data=>{
 if(data.type==='home_floorplan/entity_catalog')return {floors:[],areas:[],entities:[]};
 if(data.type==='home_floorplan/project_save'){state.project=data.project;state.revision++;}
 return {...structuredClone(state),can_edit:true,editor_url:'/home-floorplan-studio/planner/index.html',capabilities:{authoring:true}};
}};
</script></body></html>`;
const allowed = new Set(JSON.parse(fs.readFileSync(path.join(root,'ai_companion/assets.json'),'utf8')));
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg'};
const server=http.createServer((request,response)=>{
  const url=new URL(request.url,'http://localhost');
  if(url.pathname==='/native'){response.writeHead(200,{'Content-Type':'text/html'}).end(hostHtml);return;}
  let name=url.pathname.replace(/^\/home-floorplan-studio\//,'').replace(/^\//,'');
  if(['home-floorplan-static/studio.js','home-floorplan-static/map-transport.js'].includes(name))name='custom_components/'+name.replace('home-floorplan-static/','home_floorplan/static/');
  if(!allowed.has(name)&&!['custom_components/home_floorplan/static/studio.js','custom_components/home_floorplan/static/map-transport.js'].includes(name)){response.writeHead(404).end();return;}
  response.writeHead(200,{'Content-Type':types[path.extname(name)]||'application/octet-stream','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'});
  response.end(fs.readFileSync(path.join(root,name)));
});
const action=(scope,name)=>scope.locator(`[data-drawing-action="${name}"]`);
async function openPanel(frame){await frame.locator('#drawing-package').click();const dialog=frame.getByRole('dialog',{name:'Drawings & materials',exact:true});await dialog.waitFor();return dialog;}
async function step(dialog,n){await dialog.getByRole('button',{name:new RegExp(`^${n}\\.`)}).click();}
async function readDownload(page,click){const pending=page.waitForEvent('download');await click();const download=await pending;return fs.promises.readFile(await download.path(),'utf8');}
async function exercise(page,frame,native){
  activePage = page; activeFrame = frame;
  const stage = name => { diagnostic.phase = `${native ? 'native' : 'standalone'}: ${name}`; };
  stage('open and edit measurements');
  let dialog=await openPanel(frame);
  await dialog.getByLabel('Design brief',{exact:true}).fill('Keep the doorway clear.');
  await dialog.getByLabel('Dimension source',{exact:true}).selectOption('measured');
  await dialog.getByLabel('Measurement note',{exact:true}).fill('Tape measure checked.');
  stage('record first measurement');
  await action(dialog,'record-measurement').click();
  stage('finishes and documentation save');
  await step(dialog,2);
  const finish=dialog.locator('[data-drawing-surface="floor"]');
  await finish.getByLabel('Finish code',{exact:true}).fill('F-01');
  await finish.getByLabel('Specification',{exact:true}).fill('Oak boards');
  await finish.getByLabel('Waste allowance (%)',{exact:true}).fill('10');
  await dialog.getByLabel('Studio pendant',{exact:true}).check();
  await step(dialog,1);
  assert.equal(await dialog.getByLabel('Measurement note',{exact:true}).inputValue(),'Tape measure checked.','Switching steps retains evidence.');
  await action(dialog,'close').click();
  await dialog.getByRole('button',{name:'Keep editing',exact:true}).click();
  await action(dialog,'save').click();
  await frame.waitForFunction(()=>window.planner.getProject().documentation?.finishes.length===1);
  const documented=await frame.evaluate(()=>planner.getProject());
  assert.equal(documented.documentation.measurements[0].status,'measured');
  assert.equal(documented.documentation.ceiling_fixture_ids[0].item_id,'pendant');
  assert.equal(documented.documentation.brief,'Keep the doorway clear.');
  stage('generate and download');
  await step(dialog,3);await action(dialog,'generate').click();
  await dialog.locator('img.drawing-sheet').waitFor();
  await dialog.locator('img.drawing-sheet').evaluate(image=>image.decode());
  const html=await readDownload(page,()=>action(dialog,'download-html').click());
  assert.match(html,/34\.2/);assert.match(html,/12/);assert.match(html,/F-01/);assert.match(html,/Oak boards/);
  assert.ok(!html.includes('light.private_fixture'));assert.ok(!html.includes('PRIVATE_NOTE_NOT_FOR_EXPORT'));
  assert.ok(!html.includes('Tape measure checked.'));assert.ok(!html.includes('Keep the doorway clear.'));
  await dialog.getByLabel('Preview sheet',{exact:true}).selectOption({label:'Ground floor — Ceiling fixture plan'});
  const svg=await readDownload(page,()=>action(dialog,'download-svg').click());
  assert.match(svg,/Studio pendant/);assert.match(svg,/width="420mm"/);
  await dialog.getByLabel('Schedule',{exact:true}).selectOption('materials');
  assert.equal(await dialog.getByRole('columnheader',{name:'Net m²',exact:true}).count(),1);
  assert.equal(await dialog.locator('tbody tr').count(),3);
  const csv=await readDownload(page,()=>action(dialog,'download-csv').click());
  assert.match(csv,/F-01/);assert.match(csv,/13\.2/);
  assert.equal(await dialog.evaluate(element=>getComputedStyle(element,'::backdrop').backdropFilter),'none',
    'The drawing dialog dims the editor without a full-viewport backdrop filter.');
  if(native){
    assert.equal(await frame.evaluate(()=>getComputedStyle(document.querySelector('.drawing-panel')).backgroundColor),'rgb(32, 45, 64)','Native theme applies to the document panel.');
    const dir=process.env.DRAWING_ARTIFACTS;
    if(dir){fs.mkdirSync(dir,{recursive:true});await page.screenshot({path:path.join(dir,`native-drawings-${engine}.png`),fullPage:true});}
  }
  // A changed accepted snapshot must revoke all old download controls.
  stage('stale output invalidation');
  await frame.evaluate(async()=>{const {editorBridge}=await import('./editor.js');const next=editorBridge.snapshot();next.floors[0].rooms[0].name='Renamed studio';editorBridge.applyProject(next,editorBridge.revision());});
  assert.equal(await action(dialog,'download-html').count(),0);
  assert.ok(await action(dialog,'generate').isDisabled());await action(dialog,'reload').click();
  await action(dialog,'generate').click();assert.ok(await action(dialog,'download-html').isEnabled());
  await action(dialog,'close').click();
  if(native){await page.locator('#save').click();await page.waitForFunction(()=>window.server.project?.documentation?.finishes.length===1);}
  // Geometry changes leave authored evidence intact but mark it out of date.
  stage('measurement freshness and undo');
  await frame.evaluate(async()=>{const {editorBridge}=await import('./editor.js');const next=editorBridge.snapshot();next.floors[0].height_m=2.8;editorBridge.applyProject(next,editorBridge.revision());});
  dialog=await openPanel(frame);
  assert.match(await dialog.innerText(),/Current evidence: Out of date/);
  await action(dialog,'close').click();
  await frame.locator('#undo').click();
  dialog=await openPanel(frame);assert.match(await dialog.innerText(),/Current evidence: Measured/);await action(dialog,'close').click();
  // Removing a referenced item prunes only its metadata within the same undo step.
  stage('deleted reference pruning and undo');
  await frame.locator('[data-object-kind="items"]').first().click();
  await frame.getByRole('button',{name:'Delete item',exact:true}).click();
  assert.equal(await frame.evaluate(()=>planner.getProject().floors[0].items.length),0);
  assert.equal(await frame.evaluate(()=>planner.getProject().documentation.ceiling_fixture_ids.length),0);
  await frame.locator('#undo').click();
  assert.equal(await frame.evaluate(()=>planner.getProject().documentation.ceiling_fixture_ids.length),1);
  stage('source change and explicit re-record');
  dialog=await openPanel(frame);
  await dialog.getByLabel('Dimension source',{exact:true}).selectOption('imported');
  await action(dialog,'save').click();
  assert.equal(await frame.evaluate(()=>planner.getProject().documentation.measurements[0].geometry),null,'Changing source does not re-certify existing dimensions.');
  assert.match(await dialog.innerText(),/Current evidence: Unknown/);
  await action(dialog,'record-measurement').click();await action(dialog,'save').click();
  assert.match(await dialog.innerText(),/Current evidence: Imported/);
  await step(dialog,2);
  await dialog.locator('[data-drawing-surface="floor"]').getByLabel('Waste allowance (%)',{exact:true}).fill('');
  await action(dialog,'save').click();
  assert.equal(await frame.evaluate(()=>planner.getProject().documentation.finishes[0].waste_percent),0);
  await action(dialog,'close').click();
}
(async()=>{
 let browser, context, tracing = false, failed = false;
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await browserType.launch(browserLaunchOptions(engine));
  context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  await context.addInitScript(installInputDiagnostics);
  if (artifactDir) { fs.mkdirSync(artifactDir, { recursive: true }); await context.tracing.start({ screenshots: true, snapshots: true }); tracing = true; }
  const errors=[],outside=[];context.on('page',page=>{
    page.on('pageerror',e=>{errors.push(String(e));if(diagnostic.errors.length<8)diagnostic.errors.push(String(e).slice(0,240));});
    page.on('dialog',d=>d.accept());
  });
  context.on('page', page => {
    const record = (event, frame) => {
      diagnostic.lifecycle.push({ event, path: frame ? new URL(frame.url() || 'about:blank').pathname : null, at: Date.now() });
      if (diagnostic.lifecycle.length > 24) diagnostic.lifecycle.shift();
    };
    for (const event of ['frameattached', 'framenavigated', 'framedetached']) page.on(event, frame => record(event, frame));
    for (const event of ['crash', 'close']) page.on(event, () => record(event));
  });
  context.on('request',request=>{if(!request.url().startsWith(origin+'/')&&!/^(data:|blob:)/.test(request.url()))outside.push(request.url());});
  context.on('requestfailed',request=>{
    if(diagnostic.requests.length<8)diagnostic.requests.push({path:new URL(request.url()).pathname,error:request.failure()?.errorText?.slice(0,160)});
  });
  const page=await context.newPage();page.setDefaultTimeout(20000);
  activePage = page; activeFrame = page; diagnostic.phase = 'standalone: startup';
  await page.goto(origin+'/planner/index.html');await page.waitForFunction(()=>window.planner);
  await page.locator('#file-input').setInputFiles({name:'measured.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
  await page.waitForFunction(()=>planner.getProject().id==='drawing_check');await exercise(page,page,false);console.log(`${engine}: standalone drawing workflow PASS`);
  const native=await context.newPage();native.setDefaultTimeout(20000);
  activePage = native; activeFrame = native; diagnostic.phase = 'native: startup';
  await native.goto(origin+'/native');await native.waitForFunction(()=>window.host?._ready);
  const frame=native.frames().find(f=>f.url().includes('embed='));assert(frame,'Native editor frame initialized.');
  await exercise(native,frame,true);
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  diagnostic.phase = 'native: narrow viewport';
  await native.setViewportSize({width:430,height:880});const modal=await openPanel(frame);
  const bounds=await modal.boundingBox();assert(bounds.width<=430,'Dialog fits a narrow viewport.');await action(modal,'close').click();
  console.log(`${engine}: drawing workflow, native theme/save, private-field exclusion, downloads, stale invalidation, undo and narrow dialog PASS`);
 }catch(error){
  failed = true;
  await bounded(() => failureDiagnostics(browser, context), 5000);
  throw error;
 }finally{
  if (tracing) await bounded(() => context.tracing.stop(failed ? { path: path.join(artifactDir, `drawing-${engine}-trace.zip`) } : {}), 5000);
  await browser?.close();await new Promise(resolve=>server.close(resolve));
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
