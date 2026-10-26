// Real native host + opaque editor + PNG decode. Only fictional local data.
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const engines = require('playwright'), { browserLaunchOptions } = require('./browser-stability-diagnostics.cjs');
const root = path.resolve(__dirname, '..'), engine = process.env.BROWSER || 'chromium';
assert(['chromium', 'firefox', 'webkit'].includes(engine));
const project = JSON.parse(fs.readFileSync(path.join(root, 'planner/example-home.json'), 'utf8'));
const fixture = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><home-floorplan-studio-panel></home-floorplan-studio-panel><script type="module">
await import('/home-floorplan-static/studio.js');
window.calls=[];window.runningTiles=0;window.maxTiles=0;window.heldTiles=[];window.holdTiles=false;
window.saved={project:${JSON.stringify(project)},revision:0};
window.mapAvailable=true;window.mapConfig={enabled:true,latitude:0,longitude:0,model_x:3,model_z:2,north_deg:27};
const tile=document.createElement('canvas');tile.width=tile.height=256;const context=tile.getContext('2d');context.fillStyle='#1fa0ae';context.fillRect(0,0,256,256);context.strokeStyle='#e3f0c2';context.lineWidth=10;context.beginPath();context.moveTo(0,128);context.lineTo(256,128);context.stroke();const png=tile.toDataURL('image/png');
window.host=document.querySelector('home-floorplan-studio-panel');
window.connection=Object.assign(new EventTarget(),{connected:true});
window.hass={connection:window.connection,user:{id:'fictional-map-admin',is_admin:true},auth:{accessToken:'PRIVATE_SYNTHETIC_TOKEN'},callWS:async request=>{
calls.push(structuredClone(request));
if(request.type==='home_floorplan/entity_catalog')return {floors:[],areas:[],entities:[]};
if(request.type==='home_floorplan/map_get')return {revision:1,configured:mapAvailable,config:mapAvailable?structuredClone(mapConfig):null,reference:{latitude:0,longitude:0},token:'PRIVATE_SYNTHETIC_SERVER_TOKEN'};
if(request.type==='home_floorplan/map_tile'){maxTiles=Math.max(maxTiles,++runningTiles);try{if(holdTiles)await new Promise(resolve=>heldTiles.push(resolve));return {data_url:png,token:'PRIVATE_SYNTHETIC_TILE_TOKEN'};}finally{runningTiles--;}}
if(request.type==='home_floorplan/project_save'){saved={project:request.project,revision:saved.revision+1};}
return {...structuredClone(saved),can_edit:true,has_saved_draft:true,has_published:false,editor_url:'/home-floorplan-studio/planner/index.html',capabilities:{authoring:true,ai:false}};
}};host.hass=hass;
</script></body></html>`;
let server, browser;
(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/fixture') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(fixture); return; }
    const relative = url.pathname.startsWith('/home-floorplan-static/') ? 'custom_components/home_floorplan/static/' + url.pathname.slice('/home-floorplan-static/'.length) :
      url.pathname.startsWith('/home-floorplan-studio/') ? url.pathname.slice('/home-floorplan-studio/'.length) : null;
    if (!relative || relative.split('/').includes('..')) { response.writeHead(404); response.end(); return; }
    const file = path.join(root, relative);
    let descriptor;
    try {
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      if (!fs.fstatSync(descriptor).isFile()) { response.writeHead(404); response.end(); return; }
      const body = fs.readFileSync(descriptor);
      response.writeHead(200, { 'Content-Type': ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json' })[path.extname(file)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
      response.end(body);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'ELOOP', 'EISDIR'].includes(error.code)) throw error;
      response.writeHead(404); response.end();
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(origin + '/home-floorplan-studio/planner/not-a-fixture.js')).status, 404);
  assert.equal((await fetch(origin + '/home-floorplan-studio/planner')).status, 404);
  const nativeOpen = fs.openSync;
  try {
    fs.openSync = (file, ...args) => {
      if (file === path.join(root, 'planner')) throw Object.assign(new Error('Directory open rejected'), { code: 'EISDIR' });
      return nativeOpen(file, ...args);
    };
    assert.equal((await fetch(origin + '/home-floorplan-studio/planner')).status, 404, 'Directory-open errors also remain a 404');
  } finally { fs.openSync = nativeOpen; }
  browser = await engines[engine].launch(browserLaunchOptions(engine, true));
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(String(error))); page.on('dialog', dialog => dialog.accept());
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    window.mapWebGLCanvases = new Set(); window.mapTilePaints = 0;
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) { if (type === 'webgl' || type === 'webgl2') mapWebGLCanvases.add(this); return getContext.call(this, type, ...args); };
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) { if (this.canvas.id === 'plan-canvas') mapTilePaints++; return drawImage.apply(this, args); };
  });
  await page.goto(origin + '/fixture'); await page.waitForFunction(() => window.host?._ready);
  assert.equal(await page.locator('#studio-map-credit').isVisible(), false);
  const frame = page.frames().find(value => value.url().includes('embed=home-assistant')); assert(frame);
  await page.waitForFunction(() => calls.filter(call => call.type === 'home_floorplan/map_get').length === 1);
  await frame.locator('#site-mode').click();
  await frame.locator('#preview-tab').click();
  await frame.waitForFunction(() => planner.getPreviewMetadata().surroundings?.siteContext === true);
  assert.equal(await page.evaluate(() => calls.filter(call => call.type === 'home_floorplan/map_tile').length), 0, 'Map-only preview learns authority without loading raster tiles');
  await frame.locator('#plan-tab').click();
  const initial = await frame.evaluate(() => ({ project: planner.getProject(), contexts: mapWebGLCanvases.size, canvases: document.querySelectorAll('canvas').length }));
  assert.equal(await page.evaluate(() => calls.filter(call => /\/map_/.test(call.type)).length), 1, 'The initial context probe is the only map read before raster opt-in');
  await frame.evaluate(() => { const canvas = document.querySelector('#plan-canvas'); window.beforeMapPixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; });
  await frame.locator('#site-map-toggle').click();
  await page.waitForFunction(() => calls.some(call => call.type.endsWith('/map_tile')) && runningTiles === 0);
  await frame.waitForFunction(() => mapTilePaints > 0 && !document.querySelector('#site-map-status').textContent.includes('Loading'));
  const visible = await frame.evaluate(() => {
    const canvas = document.querySelector('#plan-canvas'), pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let changed = 0; for (let i = 0; i < pixels.length; i += 4) if (Math.abs(pixels[i] - beforeMapPixels[i]) + Math.abs(pixels[i + 1] - beforeMapPixels[i + 1]) + Math.abs(pixels[i + 2] - beforeMapPixels[i + 2]) > 15) changed++;
    return { changed, project: planner.getProject(), contexts: mapWebGLCanvases.size, canvases: document.querySelectorAll('canvas').length, status: document.querySelector('#site-map-status').textContent };
  });
  assert(visible.changed > 10000, 'Real decoded tiles contribute visible canvas pixels'); assert.deepEqual(visible.project, initial.project);
  assert.equal(visible.contexts, initial.contexts); assert.equal(visible.canvases, initial.canvases, 'Map reuses the existing plan canvas');
  assert.match(visible.status, /OpenStreetMap/); assert(await page.evaluate(() => maxTiles <= 4));
  assert.equal(await page.locator('#studio-map-credit').isVisible(), true);
  const credit = page.locator('#studio-map-credit a');
  assert.equal(await credit.getAttribute('href'), 'https://www.openstreetmap.org/copyright');
  assert.equal(await credit.getAttribute('target'), '_blank');
  assert.equal(await credit.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts allow-downloads allow-modals allow-forms');
  const idle = await frame.evaluate(() => mapTilePaints), count = await page.evaluate(() => calls.length);
  await page.waitForTimeout(250); assert.equal(await frame.evaluate(() => mapTilePaints), idle); assert.equal(await page.evaluate(() => calls.length), count);
  await frame.locator('#site-kind').selectOption('building'); await frame.locator('[data-site-tool="rectangle"]').click();
  const points = await frame.evaluate(() => [[1, 1], [3, 3]].map(point => planner.worldToScreen(point))), rect = await frame.locator('#plan-canvas').boundingBox();
  await page.mouse.move(rect.x + points[0][0], rect.y + points[0][1]); await page.mouse.down(); await page.mouse.move(rect.x + points[1][0], rect.y + points[1][1]); await page.mouse.up();
  await frame.waitForFunction(() => planner.getProject().site?.features.length === 1);
  const drawn = await frame.evaluate(() => planner.getProject());
  assert.equal(drawn.site.features[0].render_style, 'outline'); assert.deepEqual(drawn.floors, initial.project.floors);
  assert.doesNotMatch(JSON.stringify(drawn), /latitude|longitude|model_x|north_deg|data:image|PRIVATE_SYNTHETIC/);
  await page.locator('#save').click(); await page.waitForFunction(() => !host._busy && saved.revision === 1);
  assert.deepEqual(await page.evaluate(() => saved.project), drawn, 'Only the drawing is saved, never alignment or tiles');
  await frame.locator('#inside-mode').click(); const stopped = await page.evaluate(() => calls.length); await page.waitForTimeout(150);
  assert.equal(await page.locator('#studio-map-credit').isVisible(), false);
  assert.equal(await page.evaluate(() => calls.length), stopped, 'Leaving Site stops map work');
  await frame.locator('#site-mode').click(); await page.waitForFunction(() => calls.length > 0 && runningTiles === 0);
  await frame.waitForFunction(() => !document.querySelector('#site-map-status').textContent.includes('Loading'));
  await frame.locator('#site-map-toggle').click();
  // An unavailable map stays usable across live language changes in native Site mode.
  await page.evaluate(()=>{mapAvailable=false;});await frame.locator('#site-map-toggle').click();
  await frame.waitForFunction(()=>document.querySelector('#site-map-status').textContent==='Align and enable the map in Home Assistant first, then retry.');
  await frame.locator('[data-site-scope="neighborhood"]').click();
  const beforeLocale=await frame.evaluate(()=>planner.getProject());
  const beforeLocaleRequests=await page.evaluate(()=>calls.filter(call=>/\/map_/.test(call.type)).length);
  await frame.locator('#language-select').selectOption('ru');await frame.waitForFunction(()=>document.documentElement.lang==='ru');
  assert.equal(await frame.locator('[data-site-scope="neighborhood"]').innerText(),'Окружение');
  assert.equal(await frame.locator('#site-map-toggle').innerText(),'Карта на фоне');
  assert.equal(await frame.locator('#site-map-reload').innerText(),'Перезагрузить карту');
  assert.equal(await frame.locator('#site-map-reload').isEnabled(),true);
  assert.match(await frame.locator('#site-map-status').innerText(),/^Сначала выровняйте и включите карту/);
  assert.match(await frame.locator('#plan-canvas').getAttribute('aria-label'),/^План участка в метрах/);
  assert.equal(await frame.getByLabel('Отметка земли (м)',{exact:true}).getAttribute('readonly'),'');
  const localizedDownloadPromise=page.waitForEvent('download');await frame.locator('#export-project').click();
  const localizedDownload=await localizedDownloadPromise;const chunks=[];
  for await(const chunk of await localizedDownload.createReadStream())chunks.push(chunk);
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')),beforeLocale,'Native localized export preserves the project');
  await frame.locator('#language-select').selectOption('en');await frame.waitForFunction(()=>document.documentElement.lang==='en');
  assert.equal(await frame.locator('#site-map-status').innerText(),'Align and enable the map in Home Assistant first, then retry.');
  assert.deepEqual(await frame.evaluate(()=>planner.getProject()),beforeLocale);
  assert.equal(await page.evaluate(()=>calls.filter(call=>/\/map_/.test(call.type)).length),beforeLocaleRequests,'Language changes do not reload the map or add transport listeners');
  await frame.locator('#site-map-toggle').click();
  // Exercise the actual host origin guard and read-only action boundary after
  // normal operations, so synthetic high request IDs cannot disrupt the UI.
  const beforeForbidden = await page.evaluate(() => calls.length);
  await page.evaluate(() => host._onMessage({ source: {}, origin: 'null', data: { protocol: 'home-studio-editor-v1', channel: host._channel, type: 'map-request', requestId: 'map-9000000', action: 'get' } }));
  await frame.evaluate(async () => {
    const { embeddedContext } = await import('./ha-bridge.js'), context = embeddedContext();
    parent.postMessage({ protocol: 'home-studio-editor-v1', channel: context.channel, type: 'map-request', requestId: 'map-9000001', action: 'save', body: { config: {}, revision: 1 } }, context.origin);
  });
  await page.waitForTimeout(100); assert.equal(await page.evaluate(() => calls.length), beforeForbidden);
  assert.equal(await page.evaluate(() => calls.some(call => call.type === 'home_floorplan/map_save')), false);
  assert.deepEqual(errors, []);
  console.log(`PASS (${engine}): native read-only map RPC, opaque frame, decoded underlay pixels, one existing canvas, manual outline drawing/save without geolocation, bounded requests, attribution and idle/exit lifecycle.`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); });
