// Real native-panel dialog behavior with synthetic server responses only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium, firefox, webkit } = require('playwright');
const { browserLaunchOptions } = require('./browser-stability-diagnostics.cjs');
const engine = process.env.BROWSER || 'chromium';
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'custom_components/home_floorplan/static/studio.js'));
const html = `<!doctype html><html><body><script type="module">
await import('/studio.js');
const host = document.createElement('home-floorplan-studio-panel');
window.host=host; window.calls=[]; window.failApply=false;
const floor=id=>({id,name:id,elevation_m:0,height_m:3,rooms:[],walls:[],openings:[],items:[]});
const project={schema_version:1,title:'Synthetic home',floors:[floor('upper'),floor('ground')]};
window.saved={project,revision:1,published_revision:1,capabilities:{authoring:true,architecture_editing:false,site_frame_calibration:true},source:{kind:'generated',protected_floors:['upper','ground'],protected_rooms:{upper:[],ground:[]},custom_items:{}}};
host._started=true; host._ready=true; host._project=structuredClone(project);host._savedRaw=JSON.stringify(project);host._revision=1;host._saved=window.saved;
host._snapshot=async()=>structuredClone(host._project);
host._online=()=>true;host._requireConnection=()=>{};
host._hass={user:{id:'admin',is_admin:true},callWS:async data=>{
 calls.push(data);
 if(data.type==='home_floorplan/site_frame_preview')return {token:'synthetic-preview',revision:host._revision,global_ground_m:0,floors:host._project.floors.map((f,i)=>({id:f.id,name:f.name,before_m:f.elevation_m,after_m:i===0?3:0,baseline_ground_m:i===0?-3:0}))};
 if(data.type==='home_floorplan/site_frame_apply'){
   if(window.failApply)throw {message:'Source changed'};
   const result=structuredClone(window.saved);result.revision=2;result.project.floors[0].elevation_m=3;return result;
 }
 throw Error('Unexpected request');
}};
host._openEditor=project=>{host._project=structuredClone(project);host._ready=true;};
document.body.append(host);host._buttons();
</script></body></html>`;
(async()=>{
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/studio.js'?'text/javascript':'text/html');res.end(req.url==='/studio.js'?source:html);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await ({chromium,firefox,webkit}[engine]).launch(browserLaunchOptions(engine));
 try {
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.route('**/*',route=>route.request().url().startsWith(`http://127.0.0.1:${server.address().port}/`)?route.continue():route.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>window.host?._ready);
  await page.locator('#more-options').evaluate(node=>node.open=true);
  await page.locator('#site-frame').click();
  await page.locator('#site-frame-dialog').waitFor({state:'visible'});
  assert.match(await page.locator('#site-frame-offsets').innerText(),/upper: 0 m → 3 m/);
  assert.equal(await page.evaluate(()=>calls.filter(x=>x.type.endsWith('_apply')).length),0,'preview never applies');
  await page.locator('#site-frame-cancel').click();
  assert.equal(await page.evaluate(()=>host._revision),1);
  await page.locator('#site-frame').click();await page.locator('#site-frame-dialog').waitFor({state:'visible'});
  await page.evaluate(()=>window.failApply=true);await page.locator('#site-frame-apply').click();
  await page.waitForFunction(()=>!host._busy&&!host._siteFramePreview);
  assert.equal(await page.evaluate(()=>host._project.floors[0].elevation_m),0,'failure preserves local project');
  assert.match(await page.locator('#status').innerText(),/Load saved draft/);
  await page.evaluate(()=>window.failApply=false);await page.locator('#site-frame').click();
  await page.locator('#site-frame-dialog').waitFor({state:'visible'});await page.locator('#site-frame-apply').click();
  await page.waitForFunction(()=>host._revision===2&&!host._busy);
  assert.equal(await page.evaluate(()=>host._project.floors[0].elevation_m),3);
  assert.equal(await page.evaluate(()=>host._publishedRevision),1,'calibration never publishes');
  await page.evaluate(()=>{host._project.title='Unsaved edit';host._buttons();});
  assert.equal(await page.locator('#site-frame').isDisabled(),true,'unsaved edits block calibration');
  assert.deepEqual(errors,[]);console.log(engine+': calibration preview, cancel, failure, apply and dirty guards passed');
 } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
