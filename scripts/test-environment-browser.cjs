'use strict';
// Fictional example only. Exercises placement, compiler, UI, and idle rendering.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-check-'));
  const server = http.createServer((req, res) => {
    const route = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const base = route.startsWith('/compiled/') ? temp : root;
    const name = path.resolve(base, route.replace(/^\/(?:compiled\/)?/, '') + (route.endsWith('/') ? 'index.html' : ''));
    if (!name.startsWith(base + path.sep)) { res.writeHead(404).end(); return; }
    let descriptor;
    try {
      descriptor = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      if (!fs.fstatSync(descriptor).isFile()) { res.writeHead(404).end(); return; }
      const content = fs.readFileSync(descriptor);
      res.writeHead(200, { 'Content-Type': ({'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json'})[path.extname(name)] || 'application/octet-stream' });
      res.end(content);
    } catch {
      res.writeHead(404).end();
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 1520, height: 1000 } });
    const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('dialog', d => d.accept());
    await page.goto(origin + '/planner/'); await page.waitForFunction(() => window.planner);
    const fixture = JSON.parse(fs.readFileSync(path.join(root, 'planner/example-home.json'))); fixture.title = 'Garden Studio · fictional example'; fixture.id = 'garden_studio';
    const wallOnly=structuredClone(fixture);wallOnly.id='wall_only';wallOnly.floors[0].rooms=[];wallOnly.floors[0].items=[];wallOnly.floors[0].openings=[];wallOnly.floors[0].walls=[{id:'wall',start:[0,0],end:[5,0],thickness_m:2}];
    await page.locator('#file-input').setInputFiles({name:'wall.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(wallOnly))});
    await page.locator('#preview-tab').click();await page.waitForFunction(()=>window.planner.getPreviewMetadata().renderCount>0);
    assert.equal(await page.locator('#preview-error').isVisible(),false,'A single thick wall remains a valid draft');
    assert.equal((await page.evaluate(()=>window.planner.getPreviewMetadata())).surroundings.bounds.minZ,-1);
    await page.locator('#plan-tab').click();
    await page.locator('#file-input').setInputFiles({ name:'garden.json', mimeType:'application/json', buffer:Buffer.from(JSON.stringify(fixture)) });
    await page.waitForFunction(() => window.planner.getProject().id === 'garden_studio');
    await page.getByRole('button', { name:'Add garden area', exact:true }).click();
    let project = await page.evaluate(() => window.planner.getProject());
    assert.equal(project.floors[0].rooms.at(-1).material, 'deck'); assert.equal(project.floors[0].items.at(-1).model_id, 'lawn_patch');
    for (const id of ['round_canopy_tree','columnar_tree','clipped_hedge','stepping_stone_path','garden_rabbit','small_dog','sitting_cat']) {
      await page.locator('#browse-items').click(); await page.locator('#library-clear').click(); await page.locator('#library-search').fill(id.replaceAll('_',' '));
      await page.locator(`.library-card[data-model-id="${id}"]`).click();
      const pt = await page.evaluate(() => window.planner.worldToScreen([9.5, 2]));
      await page.locator('#plan-canvas').click({position:{x:pt[0],y:pt[1]}});
      assert.equal((await page.evaluate(() => window.planner.getProject())).floors[0].items.at(-1).model_id,id);
    }
    project = await page.evaluate(() => window.planner.getProject());
    const points = [[8.8,.7],[11,3.2],[10.7,.6],[9.8,2],[10.7,2],[8.8,2.9],[2,2]];
    project.floors[0].items.slice(-7).forEach((item,i) => { item.position_m.x=points[i][0]; item.position_m.z=points[i][1]; if(i===6)item.room='living'; });
    await page.locator('#file-input').setInputFiles({ name:'garden.json', mimeType:'application/json', buffer:Buffer.from(JSON.stringify(project)) });
    await page.waitForFunction(() => window.planner.getProject().floors[0].items.at(-1).room === 'living');
    await page.locator('#preview-tab').click(); await page.waitForFunction(() => window.planner.getPreviewMetadata().renderCount>0);
    const controls = page.locator('#preview-view .environment-controls'); await controls.locator('summary').click();
    const before = await page.evaluate(() => window.planner.getPreviewMetadata());
    await controls.getByLabel('Show garden surroundings',{exact:true}).check();
    await page.waitForFunction(count => window.planner.getPreviewMetadata().renderCount>count && window.planner.getPreviewMetadata().surroundings?.enabled, before.renderCount);
    await page.waitForTimeout(500); const enabled = await page.evaluate(() => window.planner.getPreviewMetadata());
    assert.deepEqual(enabled.camera, before.camera, 'Scenery must not change camera fit');
    await page.waitForTimeout(600); assert.equal((await page.evaluate(() => window.planner.getPreviewMetadata())).renderCount, enabled.renderCount, 'Static scenery stays idle');
    await controls.getByLabel('Decorative motion',{exact:true}).check();
    await page.waitForFunction(count => window.planner.getPreviewMetadata().renderCount>count+1,enabled.renderCount);
    await page.emulateMedia({reducedMotion:'reduce'}); await page.waitForTimeout(400);
    const paused = await page.evaluate(() => window.planner.getPreviewMetadata()); assert.equal(paused.surroundings.timerPending,false);
    await page.waitForTimeout(400); assert.equal((await page.evaluate(() => window.planner.getPreviewMetadata())).renderCount,paused.renderCount);
    await controls.getByLabel('Decorative motion',{exact:true}).uncheck(); await page.emulateMedia({reducedMotion:'no-preference'});
    const shots=process.env.ENVIRONMENT_SCREENSHOT_DIR; if(shots){fs.mkdirSync(shots,{recursive:true});await controls.locator('summary').click();await page.locator('#preview-canvas').focus();await page.keyboard.press('-');await page.keyboard.press('-');await page.waitForTimeout(400);await page.screenshot({path:path.join(shots,'garden-planner.png')});}
    await page.locator('#plan-tab').click(); assert.equal((await page.evaluate(() => window.planner.getPreviewMetadata())).surroundings.timerPending,false);
    // Exported coordinates, room ownership, and the upper-floor ground alignment survive compilation.
    project.floors.push({...structuredClone(project.floors[0]),id:'upper',name:'Upper floor',elevation_m:3});
    fs.writeFileSync(path.join(temp,'project.json'),JSON.stringify(project));
    const compiled=spawnSync(process.env.PYTHON||'python3',['scripts/build-planner-project.py','--project',path.join(temp,'project.json'),'--output',path.join(temp,'build')],{cwd:root,encoding:'utf8'});assert.equal(compiled.status,0,compiled.stderr);
    const upper=JSON.parse(fs.readFileSync(path.join(temp,'build/upper/model-data.json')));assert.equal(upper.environment.elevation,-3);
    await page.goto(origin+'/compiled/build/main/'); await page.waitForFunction(() => window.floorplan);
    assert.equal((await page.evaluate(() => window.floorplan.surroundings)).drawCalls,0);
    assert.equal((await page.evaluate(() => window.floorplan.surroundings)).roadSide,'minZ');
    const viewerControls=page.locator('.toolbar .environment-controls');await viewerControls.locator('summary').click();await viewerControls.getByLabel('Show garden surroundings',{exact:true}).check();
    await page.waitForFunction(()=>window.floorplan.surroundings.enabled && window.floorplan.renderCount>1);await page.waitForTimeout(400);const viewerCount=await page.evaluate(() => window.floorplan.renderCount);await page.waitForTimeout(500);assert.equal(await page.evaluate(() => window.floorplan.renderCount),viewerCount);
    await viewerControls.getByLabel('Decorative motion',{exact:true}).check();await page.waitForFunction(count=>window.floorplan.renderCount>count+1,viewerCount);
    await page.locator('#modePlan').click();assert.equal(await page.evaluate(()=>window.floorplan.surroundings.timerPending),false);
    await page.locator('#openHome').click();await page.waitForFunction(()=>window.floorplan.homeMode && window.floorplan.surroundings.moving);
    const homeControls=page.locator('.home-map-tools .environment-controls');await homeControls.locator('summary').click();await homeControls.getByLabel('Decorative motion',{exact:true}).uncheck();
    if(shots){await page.locator('#homeZoomOut').click();await page.locator('#homeZoomOut').click();await page.waitForTimeout(400);await page.screenshot({path:path.join(shots,'garden-home-view.png')});}
    await page.setViewportSize({width:480,height:800});await page.waitForTimeout(200);const menuBox=await homeControls.locator('.environment-options').boundingBox();assert(menuBox.x>=0 && menuBox.x+menuBox.width<=480,'Home surroundings menu stays reachable on narrow screens');
    // Legacy builders provide model metadata directly. Exercise that same entry
    // point without changing the public compiler's default scenery configuration.
    const compiledPath=path.join(temp,'build/main/index.html');
    const modelSlot=/(<script\b[^>]*\bid="modelData"[^>]*>)([\s\S]*?)(<\/script>)/;
    const html=fs.readFileSync(compiledPath,'utf8');assert(modelSlot.test(html));
    fs.writeFileSync(compiledPath,html.replace(modelSlot,(_,open,json,close)=>{
      const model=JSON.parse(json);model.environment.road_side='maxZ';
      return open+JSON.stringify(model).replaceAll('<','\\u003c')+close;
    }));
    await page.reload();await page.waitForFunction(()=>window.floorplan);
    assert.equal((await page.evaluate(()=>floorplan.surroundings)).roadSide,'maxZ');
    await page.locator('#openHome').click();
    const configuredControls=page.locator('.home-map-tools .environment-controls');await configuredControls.locator('summary').click();
    await configuredControls.getByLabel('Show garden surroundings',{exact:true}).check();
    await configuredControls.locator('[data-environment="palette"]').selectOption('dusk');
    await configuredControls.getByLabel('Decorative motion',{exact:true}).check();
    await page.waitForFunction(()=>floorplan.surroundings.elapsed>0);
    await configuredControls.getByLabel('Decorative motion',{exact:true}).uncheck();
    const configuredStats=await page.evaluate(()=>floorplan.surroundings);
    assert.equal(configuredStats.roadSide,'maxZ','Home preference updates retain the builder-selected road side');
    assert.equal(configuredStats.actors,5);assert.equal(configuredStats.drawCalls,14);assert.equal(configuredStats.timerPending,false);
    assert.deepEqual(errors,[]);console.log('Environment browser: editable garden and indoor/outdoor animals, camera stability, zero idle redraws, reduced-motion pause, compiled Home controls, both road-side metadata paths, and upper-floor ground alignment passed.');
  } finally { await browser?.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1;});
