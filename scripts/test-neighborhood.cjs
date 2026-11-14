// Isolated Neighborhood behavior and real panel.js integration, with deterministic
// MapLibre and HA doubles. These tests do not qualify actual GL rendering.
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../custom_components/home_floorplan/static');
const fake=`window.fakeLoads=(window.fakeLoads||0)+1;export default {setWorkerUrl(url){window.workerURL=url},addProtocol(name,fn){window.protocol=fn},Map:class{constructor(options){window.options=options;window.map=this;this.events={};window.created=(window.created||0)+1;queueMicrotask(()=>this.events.load?.())}on(n,cb){this.events[n]=cb}remove(){window.removed=(window.removed||0)+1}setStyle(style){window.styles=(window.styles||0)+1;window.style=style}jumpTo(o){window.jump=o}zoomIn(){}zoomOut(){}},Marker:class{setLngLat(){return this}addTo(){return this}remove(){}}};`;
// Keyboard activation exercises the native button without Playwright's pointer
// stability check, which waits on two animation frames in background test tabs.
async function activate(button) { await button.focus(); await button.press('Enter'); }
async function until(page, predicate) {
  try { await page.waitForFunction(predicate,null,{polling:50}); }
  catch(error) {
    const snapshot=await page.evaluate(()=>({hidden:document.hidden,ready:document.readyState,created:window.created,opened:(window.actual?.neighborhood||window.p?.n)?.opened,status:document.querySelector('home-floorplan-panel,test-panel')?.shadowRoot?.querySelector('.status')?.textContent}));
    error.message+=`\nBrowser state: ${JSON.stringify(snapshot)}`;throw error;
  }
}
(async()=>{const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/javascript');if(req.url==='/vendor/maplibre-gl.mjs')return res.end(fake);if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><body></body>');}const file=path.join(root,req.url.split('?')[0]);if(!file.startsWith(root))return res.end();fs.readFile(file,(err,data)=>{res.statusCode=err?404:200;res.end(err?'':data)});});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const browser=await chromium.launch({headless:true});try{const page=await browser.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>console.error('Browser:',e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
await page.evaluate(async()=>{const {Neighborhood}=await import('/neighborhood.js');customElements.define('test-panel',class extends HTMLElement{constructor(){super();this.attachShadow({mode:'open'});this.shadowRoot.innerHTML='<button id="launch">Neighborhood</button>';this.calls=[];this._hass={user:{id:'one'},connection:{connected:true},themes:{darkMode:false},callWS:async msg=>{this.calls.push(msg);if(this.reply)return this.reply(msg);return msg.type.endsWith('map_get')?{configured:true,config:{enabled:true,latitude:37,longitude:-122}}:msg.resource==='metadata'?{minzoom:0,maxzoom:14}:{data:'AQID'};}};this.n=new Neighborhood(this);this.shadowRoot.querySelector('button').onclick=()=>this.n.open();}});window.p=document.createElement('test-panel');document.body.append(p);p.style.cssText='display:block;position:relative;height:700px';});
assert.equal(await page.evaluate(()=>window.fakeLoads||0),0,'no MapLibre import at idle');
await activate(page.locator('test-panel').locator('#launch'));await until(page,()=>window.created===1);
assert.match(await page.evaluate(()=>workerURL),/\/vendor\/maplibre-gl-worker.mjs$/);
assert.deepEqual(await page.evaluate(()=>[options.maxZoom,options.maxPitch,options.style.sources.neighborhood.maxzoom]),[19,60,14]);
assert.equal(await page.evaluate(async()=>{const data=await protocol({url:options.style.sources.neighborhood.tiles[0].replace('{z}','14').replace('{x}','1').replace('{y}','2')},new AbortController());return [...new Uint8Array(data.data)].join(',');}),'1,2,3');
await page.evaluate(()=>{p.n.applyTheme();p.n.applyTheme();});assert.equal(await page.evaluate(()=>window.styles||0),0,'same theme does not reload style');
await page.evaluate(()=>{p._hass.themes.darkMode=true;p.n.applyTheme();});assert.equal(await page.evaluate(()=>styles),1);
await page.evaluate(()=>{try{options.transformRequest('https://external.invalid/tile')}catch(e){window.externalBlocked=true}});assert.equal(await page.evaluate(()=>externalBlocked),true);
await page.evaluate(()=>p.n.close());assert.equal(await page.evaluate(()=>removed),1);assert.equal(await page.evaluate(()=>p.shadowRoot.activeElement?.id),'launch','focus restored');
await page.evaluate(()=>{p.reply=async()=>({configured:false,config:null});});await activate(page.locator('test-panel').locator('#launch'));await until(page,()=>p.shadowRoot.querySelector('.status')?.textContent.includes('save your home alignment'));assert.equal(await page.evaluate(()=>created),1,'disabled alignment never creates map');
await page.evaluate(()=>{p.n.close();p.reply=null;});await activate(page.locator('test-panel').locator('#launch'));await until(page,()=>created===2);
await page.evaluate(()=>map.events.error());assert.equal(await page.evaluate(()=>removed),2,'map error disposes GL');assert.equal(await page.locator('test-panel').locator('[data-action="retry"]').isVisible(),true);
await page.evaluate(()=>{p.n.close();p.reply=msg=>msg.type.endsWith('map_get')?new Promise(r=>window.resolveSaved=r):Promise.resolve({minzoom:0,maxzoom:14});});await activate(page.locator('test-panel').locator('#launch'));await until(page,()=>window.resolveSaved);await page.evaluate(()=>{p.n.close();resolveSaved({configured:true,config:{enabled:true,latitude:37,longitude:-122}})});await page.waitForTimeout(30);assert.equal(await page.evaluate(()=>created),2,'late settings do not reopen map');
await page.evaluate(()=>{p.reply=null;});await activate(page.locator('test-panel').locator('#launch'));await until(page,()=>created===3);
assert.equal(await page.evaluate(async()=>{const url=options.style.sources.neighborhood.tiles[0].replace('{z}','14').replace('{x}','1').replace('{y}','2');p.reply=()=>new Promise(r=>window.finishTile=r);const control=new AbortController();const pending=protocol({url},control).then(()=>false,e=>e.name==='AbortError');await new Promise(r=>setTimeout(r,0));control.abort();finishTile({data:'AQID'});return pending;}),true,'protocol abort rejects stale work');
assert.equal(await page.evaluate(async()=>{p._hass={...p._hass,user:{id:'other'}};const url=options.style.sources.neighborhood.tiles[0].replace('{z}','14').replace('{x}','1').replace('{y}','2');return protocol({url},new AbortController()).then(()=>false,e=>e.name==='AbortError')}),true,'account changes reject tiles');
await page.evaluate(()=>p.n.close(false));assert.equal(await page.evaluate(()=>removed),3);
await page.evaluate(()=>{p._hass={...p._hass,user:{id:'one'}};p.reply=null;});await activate(page.locator('test-panel').locator('#launch'));await until(page,()=>created===4);
assert.deepEqual(await page.evaluate(async()=>{const base=options.style.sources.neighborhood.tiles[0];window.tileFinishes=[];let started=0;p.reply=()=>{started++;return new Promise(r=>tileFinishes.push(r));};const controls=Array.from({length:40},()=>new AbortController());const pending=controls.map((c,i)=>protocol({url:base.replace('{z}','14').replace('{x}',String(i)).replace('{y}','2')},c).catch(e=>e.name));await new Promise(r=>setTimeout(r,0));const before=started;controls.forEach(c=>c.abort());tileFinishes.forEach(r=>r({data:'AQID'}));const results=await Promise.all(pending);return [before,results.filter(x=>x==='Error').length,results.filter(x=>x==='AbortError').length]}),[4,4,36],'four real slots, 32 waiting, excess refused; abort cancels waiting');
await page.evaluate(()=>{p.hidden=true;});await until(page,()=>!p.n.opened);assert.equal(await page.evaluate(()=>removed),4,'hidden host disposes map');

// Independent document: use the real custom element and lifecycle methods.
// Stub only initial floor loading; this fixture does not own a viewer bundle.
const host=await browser.newPage();host.setDefaultTimeout(10000);
await host.goto(`http://127.0.0.1:${server.address().port}`);
await host.evaluate(async()=>{
  await import('/panel.js');
  window.hostMessages=[];window.hostRequests=[];
  const panel=window.actual=document.createElement('home-floorplan-panel');
  panel.loadFloor=async()=>{panel.runtimeMode='native';panel.shadowRoot.querySelector('#neighborhood').hidden=false;};
  document.body.append(panel);
  const connection=new EventTarget();connection.connected=true;
  window.hostHass={user:{id:'real-host-account',is_admin:true},connection,connected:true,states:{},themes:{darkMode:false},locale:{language:'en'},callWS:async msg=>{
    hostRequests.push(msg);
    if(msg.type==='home_floorplan/map_get')return {configured:true,config:{enabled:true,latitude:37,longitude:-122}};
    if(msg.type==='home_floorplan/map_vector'&&msg.resource==='metadata')return {minzoom:0,maxzoom:14};
    if(msg.type==='home_floorplan/map_vector')return {data:'AQID'};
    throw Error('Unexpected host WS request');
  }};
  panel.hass=hostHass;
  window.readyViewer=()=>{
    panel.port={postMessage:message=>hostMessages.push(message),close(){window.hostPortCloses=(window.hostPortCloses||0)+1;}};
    panel.resetModelConfig();
    panel.handleViewerMessage({type:'model_config',state_entities:[]},panel.generation);
  };
  readyViewer();
  window.originalFrame=panel.shadowRoot.querySelector('iframe');
  originalFrame.srcdoc='<p>Retained detailed Home fixture</p>';
  window.originalFrameWindow=originalFrame.contentWindow;
});
assert.equal(await host.evaluate(()=>window.fakeLoads||0),0,'actual panel imports no MapLibre at idle');
assert.equal(await host.evaluate(()=>hostRequests.length),0,'actual panel makes no map WS calls at idle');
await activate(host.locator('home-floorplan-panel').locator('#neighborhood'));
await until(host,()=>window.created===1&&!actual.neighborhoodOpening);
assert.deepEqual(await host.evaluate(()=>[originalFrame.hidden,originalFrame.inert,hostMessages.filter(m=>m.type==='viewer_visibility').map(m=>m.hidden)]),[true,true,[true]],'actual host hides/inerts and suspends detailed Home');
assert.equal(await host.evaluate(()=>actual.shadowRoot.querySelector('iframe')===originalFrame&&originalFrame.contentWindow===originalFrameWindow&&originalFrame.srcdoc.includes('Retained detailed Home fixture')),true,'actual host preserves iframe identity and content');
await host.evaluate(()=>map.events.error());
assert.equal(await host.evaluate(()=>removed),1,'actual host error disposes map');
await activate(host.locator('home-floorplan-panel').locator('[data-action="retry"]'));
await until(host,()=>created===2&&!actual.neighborhoodOpening);
assert.deepEqual(await host.evaluate(()=>[originalFrame.hidden,originalFrame.inert,hostMessages.filter(m=>m.type==='viewer_visibility').map(m=>m.hidden)]),[true,true,[true,false,true]],'actual Retry resumes then re-suspends through panel.openNeighborhood');
await activate(host.locator('home-floorplan-panel').locator('[data-action="home"]'));
assert.deepEqual(await host.evaluate(()=>[originalFrame.hidden,originalFrame.inert,removed,hostMessages.filter(m=>m.type==='viewer_visibility').map(m=>m.hidden)]),[false,false,2,[true,false,true,false]],'actual Home removes MapLibre and restores retained iframe');
assert.equal(await host.evaluate(()=>actual.shadowRoot.activeElement?.id),'neighborhood','actual host restores launcher focus');
await activate(host.locator('home-floorplan-panel').locator('#neighborhood'));
await until(host,()=>created===3&&!actual.neighborhoodOpening);
await host.evaluate(()=>actual.invalidateViewerLoad());
assert.deepEqual(await host.evaluate(()=>[actual.neighborhood.opened,removed,originalFrame.hidden,originalFrame.inert,actual.port,actual.shadowRoot.querySelector('#neighborhood').disabled,hostPortCloses]),[false,3,false,false,null,true,1],'viewer invalidation closes GL, restores retained iframe, retires port and disables launcher');
const beforePending=await host.evaluate(()=>hostRequests.length);
await host.evaluate(()=>actual.openNeighborhood());
assert.deepEqual(await host.evaluate(()=>[created,hostRequests.length]),[3,beforePending],'pending viewer load cannot allocate another map or issue map WS requests');
await host.evaluate(()=>readyViewer());
assert.equal(await host.evaluate(()=>actual.shadowRoot.querySelector('#neighborhood').disabled),false,'fresh model_config re-enables launcher');
await activate(host.locator('home-floorplan-panel').locator('#neighborhood'));
await until(host,()=>created===4&&!actual.neighborhoodOpening);
assert.deepEqual(await host.evaluate(()=>[originalFrame.hidden,originalFrame.inert]),[true,true],'fresh ready viewer can reopen neighborhood');
await host.evaluate(()=>{actual.hass={...hostHass,user:{id:'replacement-account',is_admin:true}};});
assert.deepEqual(await host.evaluate(()=>[actual.neighborhood.opened,removed,originalFrame.inert]),[false,4,false],'actual hass setter closes map on account transition');
await host.close();
console.log('Neighborhood module and actual panel.js integration checks passed: lazy import, saved alignment, local protocol/worker, queue, abort/auth, theme, iframe preservation, Retry pause/resume, focus and viewer invalidation/reload gating.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}})().catch(err=>{console.error(err);process.exitCode=1});
