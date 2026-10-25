// Real browser acceptance with a fictional multi-floor home; no live services.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium, firefox, webkit } = require('playwright');
const { browserLaunchOptions } = require('./browser-stability-diagnostics.cjs');
const root = path.resolve(__dirname, '..');
const engine = process.env.SITE_EDITOR_ENGINE || process.env.BROWSER || 'chromium';
const fixture = { schema_version:1, id:'site_fixture', title:'Fictional Willow House', floors:[
  {id:'ground',name:'Ground floor',elevation_m:0,height_m:2.8,rooms:[{id:'living',name:'Living room',polygon:[[0,0],[8,0],[8,6],[0,6]],material:'floor'}],walls:[],openings:[],items:[]},
  {id:'upper',name:'Upper floor',elevation_m:2.8,height_m:2.8,rooms:[{id:'bedroom',name:'Bedroom',polygon:[[0,0],[5,0],[5,6],[0,6]],material:'floor'}],walls:[],openings:[],items:[]},
]};
const hostFixture = `<!doctype html><html style="height:100%"><body style="margin:0;height:100%"><home-floorplan-studio-panel></home-floorplan-studio-panel><script type="module">
await import('/custom_components/home_floorplan/static/studio.js');
window.host=document.querySelector('home-floorplan-studio-panel'); window.saved=null;
const initial=${JSON.stringify(fixture)}; let revision=1; const generated=location.search.includes('generated');
host.hass={user:{id:'fictional_admin',is_admin:true},callWS:async data=>{
 if(data.type.endsWith('entity_catalog'))return {floors:[],areas:[],entities:[]};
 if(data.type.endsWith('project_save')){window.saved=data.project;revision++;}
 return {project:window.saved||initial,revision,published_revision:0,has_saved_draft:true,has_published:false,can_edit:true,capabilities:{authoring:true,architecture_editing:!generated},source:generated?{kind:'generated',protected_floors:initial.floors.map(f=>f.id),protected_rooms:Object.fromEntries(initial.floors.map(f=>[f.id,f.rooms.map(r=>r.id)])),custom_items:{}}:undefined,editor_url:'/home-floorplan-studio/planner/index.html'};
}};
</script></body></html>`;
const server = http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/fixture')return res.writeHead(200,{'Content-Type':'text/html'}).end(hostFixture);
  const route=pathname.replace(/^\/home-floorplan-studio\//,'/');
  const file=path.resolve(root,'.'+route);
  if(!file.startsWith(root+path.sep))return res.writeHead(404).end();
  let body;
  try { body=fs.readFileSync(file); }
  catch { return res.writeHead(404).end(); }
  res.writeHead(200,{'Access-Control-Allow-Origin':'*','Content-Type':{'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.jpg':'image/jpeg'}[path.extname(file)]||'application/octet-stream'}).end(body);
});
async function screenshot(page,name){
  await page.screenshot({path:path.join(process.env.SITE_SCREENSHOT_DIR,`${name}-${engine}.png`)});
  await page.screenshot({path:path.join(process.env.SITE_SCREENSHOT_DIR,`${name}-${engine}.jpg`),quality:88});
}
async function model(page){return page.evaluate(()=>planner.getProject());}
async function at(page,point){const rect=await page.locator('#plan-canvas').boundingBox();const p=await page.evaluate(p=>planner.worldToScreen(p),point);return [rect.x+p[0],rect.y+p[1]];}
async function clickPoint(page,point){await page.mouse.click(...await at(page,point));}
async function dragPoint(page,a,b){await page.mouse.move(...await at(page,a));await page.mouse.down();await page.mouse.move(...await at(page,b),{steps:5});await page.mouse.up();}
async function field(page,label,value){const input=page.getByLabel(label,{exact:true});await input.fill(value);await input.press('Tab');}
async function addRectangle(page,kind,x,z,w,d){
 await page.locator('#site-settings').click();
 await page.getByLabel('Draw next',{exact:true}).selectOption(kind);
 await field(page,'Site x (m)',String(x));await field(page,'Site z (m)',String(z));
 await field(page,'Site width (m)',String(w));await field(page,'Site depth (m)',String(d));
 await page.getByRole('button',{name:'Add site rectangle',exact:true}).click();
}
(async()=>{let browser;const errors=[];const temp=fs.mkdtempSync(path.join(os.tmpdir(),'site-editor-'));
 try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await ({chromium,firefox,webkit}[engine]).launch(browserLaunchOptions(engine,true));
 const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
 const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(String(error)));page.on('dialog',dialog=>dialog.accept());
 await page.goto(origin+'/planner/index.html');await page.waitForFunction(()=>window.planner);
 await page.locator('#file-input').setInputFiles({name:'fictional.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
 await page.waitForFunction(()=>planner.getProject().id==='site_fixture');
 await page.getByRole('button',{name:'Site & roof',exact:true}).click();
 assert.equal(await page.evaluate(()=>planner.getEditingMode()),'site');
 assert.deepEqual((await model(page)).floors,fixture.floors);
 // Keyboard-only dimension authoring works before any site data exists.
 await field(page,'Site width (m)','8');await field(page,'Site depth (m)','6');
 await page.getByRole('button',{name:'Add site rectangle',exact:true}).click();
 assert.equal((await model(page)).site.features.length,1);
 await field(page,'Feature name','Willow house');await field(page,'Height above ground (m)','5.6');
 await page.getByLabel('Feature color',{exact:true}).fill('#b89372');await page.getByLabel('Feature color',{exact:true}).dispatchEvent('change');
 // Polygon drawing, Enter completion, numeric points, and preview remain separate from floors.
 await page.getByLabel('Draw next',{exact:true}).selectOption('roof');
 await page.getByRole('button',{name:'Draw polygon',exact:false}).click();
 for(const p of [[0,0],[8,0],[8,6],[0,6]])await clickPoint(page,p);
 await page.keyboard.press('Enter');
 assert.equal((await model(page)).site.features.length,2);
 await field(page,'Feature name','Warm roof');await field(page,'Roof elevation above ground (m)','5.8');
 await field(page,'Polygon points (x, z meters)','-0.25, -0.25\n8.25, -0.25\n8.25, 6.25\n-0.25, 6.25');
 // Invalid geometry fails without mutating anything and remains visibly editable.
 const good=await model(page);
 await field(page,'Polygon points (x, z meters)','0,0\n8,6\n8,0\n0,6');
 assert.deepEqual(await model(page),good);
 assert.equal(await page.getByLabel('Polygon points (x, z meters)',{exact:true}).getAttribute('aria-invalid'),'true');
 await field(page,'Polygon points (x, z meters)',good.site.features[1].polygon.map(p=>p.join(', ')).join('\n'));
 const roofBefore=structuredClone((await model(page)).site.features[1]);
 await dragPoint(page,[-.25,-.25],[-.75,-.25]);
 assert.deepEqual((await model(page)).site.features[1].polygon[0],[-.75,-.25]);
 await page.getByRole('button',{name:'Undo',exact:true}).click();assert.deepEqual((await model(page)).site.features[1],roofBefore);
 await page.getByRole('button',{name:'Redo',exact:true}).click();assert.equal((await model(page)).site.features[1].polygon[0][0],-.75);
 // Escape cancels a partial polygon without history/storage mutation.
 const beforeCancel=await model(page);await page.getByRole('button',{name:'Draw polygon',exact:false}).click();
 await clickPoint(page,[9,1]);await clickPoint(page,[10,2]);await page.keyboard.press('Escape');assert.deepEqual(await model(page),beforeCancel);
 await addRectangle(page,'building',11,0,4,5);await field(page,'Feature name','Neighbor');
 await addRectangle(page,'street',-4,9,22,3);await field(page,'Feature name','Willow lane');
 assert.equal((await model(page)).site.features.at(-1).height_m,0);
 await addRectangle(page,'landscape',-4,-5,22,3);await field(page,'Feature name','Garden');
 assert.deepEqual((await model(page)).floors,fixture.floors);
 const accepted=await model(page);
 await page.getByRole('button',{name:'Delete feature',exact:true}).click();assert.equal((await model(page)).site.features.length,4);
 await page.getByRole('button',{name:'Undo',exact:true}).click();assert.deepEqual(await model(page),accepted);
 await page.waitForFunction(p=>JSON.stringify(JSON.parse(localStorage.getItem('home-studio.project.v1')))===JSON.stringify(p),accepted);
 await page.getByRole('button',{name:'Fit view',exact:false}).click();
 if(process.env.SITE_SCREENSHOT_DIR){fs.mkdirSync(process.env.SITE_SCREENSHOT_DIR,{recursive:true});await screenshot(page,'site-editor');}
 await page.locator('#preview-tab').click();await page.waitForFunction(()=>planner.getPreviewMetadata().siteFeatures===5);
 assert.equal((await page.evaluate(()=>planner.getPreviewMetadata())).floors.length,2);
 if(process.env.SITE_SCREENSHOT_DIR)await screenshot(page,'site-preview');
 const count=await page.evaluate(()=>planner.getPreviewMetadata().renderCount);await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>planner.getPreviewMetadata().renderCount),count,'Site preview is on-demand');
 await page.locator('#plan-tab').click();
 const downloadPromise=page.waitForEvent('download');await page.locator('#export-project').click();const download=await downloadPromise;const saved=path.join(temp,'export.json');await download.saveAs(saved);assert.deepEqual(JSON.parse(fs.readFileSync(saved,'utf8')),accepted);
 await page.reload();await page.waitForFunction(()=>window.planner);assert.deepEqual(await model(page),accepted);
 await page.locator('#site-mode').click();
 if(process.env.SITE_SCREENSHOT_DIR){await page.setViewportSize({width:390,height:844});await page.locator('#fit-view').click();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await screenshot(page,'site-editor-mobile');await page.setViewportSize({width:1440,height:1000});}
 // Detached candidate previews never enter accepted state until Apply.
 await page.evaluate(async()=>{const {editorBridge:b}=await import('/planner/editor.js');const p=b.snapshot();p.site.features.push({...p.site.features[0],id:'candidate_house',name:'Candidate',polygon:[[30,0],[34,0],[34,4],[30,4]]});window.siteCandidate=p;window.siteRevision=b.revision();b.previewProject(p);});
 assert.deepEqual(await model(page),accepted);
 await page.evaluate(async()=>{const {editorBridge:b}=await import('/planner/editor.js');b.cancelPreview();});assert.deepEqual(await model(page),accepted);
 // Site-only blank projects can be authored and previewed.
 await page.locator('#new-project').click();await page.locator('#site-mode').click();
 await page.getByRole('button',{name:'Add site rectangle',exact:true}).click();
 assert.equal((await model(page)).floors[0].rooms.length,0);
 await page.locator('#preview-tab').click();await page.waitForFunction(()=>planner.getPreviewMetadata().siteFeatures===1);
 await page.locator('#plan-tab').click();await page.getByLabel('Draw next',{exact:true}).selectOption('building');
 await page.getByRole('button',{name:'Draw rectangle',exact:false}).click();await dragPoint(page,[1,1],[3,2]);
 assert.equal((await model(page)).site.features.length,2,'Pointer rectangle creates a feature');
 await dragPoint(page,[2,1.5],[3,2.5]);assert.deepEqual((await model(page)).site.features[1].polygon[0],[2,2]);
 const beforeDragCancel=await model(page);await page.mouse.move(...await at(page,[3,2.5]));await page.mouse.down();await page.mouse.move(...await at(page,[4,3.5]),{steps:3});await page.keyboard.press('Escape');await page.mouse.up();
 assert.deepEqual(await model(page),beforeDragCancel,'Escape rolls back a detached move');
 // The full supported coordinate range fits without an excessive grid or clipped camera.
 await page.evaluate(async()=>{const {editorBridge:b}=await import('/planner/editor.js');const p=b.snapshot();p.site.features.push({id:'wide_site',name:'Wide site',kind:'landscape',polygon:[[-1000,-1000],[1000,-1000],[1000,1000],[-1000,1000]],height_m:0,color:'#a9bd91'});b.applyProject(p,b.revision());});
 await page.locator('#preview-tab').click();await page.waitForFunction(()=>planner.getPreviewMetadata().siteFeatures===3);
 assert(await page.evaluate(()=>Number.isFinite(planner.getPreviewMetadata().camera.radius)&&planner.getPreviewMetadata().camera.radius>1000));
 // Actual Home Assistant host bridge carries the complete site and floors.
 await page.goto(origin+'/fixture');await page.waitForFunction(()=>window.host?._ready);
 const frame=await page.locator('iframe').elementHandle().then(handle=>handle.contentFrame());await frame.waitForFunction(()=>window.planner);
 await frame.locator('#site-mode').click();await frame.getByRole('button',{name:'Add site rectangle',exact:true}).click();
 await page.evaluate(()=>host._save());await page.waitForFunction(()=>window.saved?.site?.features.length===1);
 assert.deepEqual(await page.evaluate(()=>saved.floors),fixture.floors);
 await page.goto(origin+'/fixture?generated');await page.waitForFunction(()=>window.host?._ready);
 const protectedFrame=await page.locator('iframe').elementHandle().then(handle=>handle.contentFrame());await protectedFrame.waitForFunction(()=>window.planner);
 assert.equal(await protectedFrame.locator('#add-floor').isDisabled(),true);
 await protectedFrame.locator('#site-mode').click();await protectedFrame.getByRole('button',{name:'Add site rectangle',exact:true}).click();
 await protectedFrame.locator('#preview-tab').click();await protectedFrame.waitForFunction(()=>planner.getView()==='preview' && planner.getPreviewMetadata().siteFeatures===1);
 assert.deepEqual(await protectedFrame.evaluate(()=>planner.getProject().floors),fixture.floors);
 await page.evaluate(()=>host._save());await page.waitForFunction(()=>window.saved?.site?.features.length===1);
 assert.deepEqual(await page.evaluate(()=>saved.floors),fixture.floors);
 await protectedFrame.locator('#inside-mode').click();assert.equal(await protectedFrame.locator('#preview-tab').innerText(),'Published home');
 assert.equal(await protectedFrame.locator('#add-floor').isDisabled(),true);
 assert.deepEqual(errors,[]);
 console.log(`Site editor browser acceptance passed (${engine}): dimension and polygon authoring, fields/invalid geometry, vertex drag, undo/redo, cancel, five kinds, autosave/export/reload, detached preview, empty floors, and HA save bridge.`);
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
