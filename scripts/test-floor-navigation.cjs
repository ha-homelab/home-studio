// Real-browser navigation checks use temporary origins and fictional projects only.
// PLANNER_NAVIGATION_ENGINES=chromium,firefox node scripts/test-floor-navigation.cjs
// PLANNER_NAVIGATION_SOURCE_ROOT=/path/to/checkout tests an integration worktree.
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {browserLaunchOptions, createDiagnostics, selectedEngines} = require('./browser-stability-diagnostics.cjs');

const root = path.resolve(process.env.PLANNER_NAVIGATION_SOURCE_ROOT || path.join(__dirname, '..'));
const KEY = 'home-studio.project.v1';
const THUMB = '#floor-navigator button[data-floor-id]';
const diagnostics = createDiagnostics('floor-navigation', 'PLANNER_NAVIGATION', root);
const editor = fs.readFileSync(path.join(root, 'planner/editor.js'), 'utf8');
const sourceFiles = Object.fromEntries(['planner/editor.js', 'planner/index.html', 'planner/editor.css',
  'planner/floor-navigator.js', 'planner/floor-navigator.css']
  .map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));

function fixture(count = 3) {
  return {schema_version: 1, id: `fictional_navigation_${count}`, title: 'Fictional navigation study',
    floors: Array.from({length: count}, (_, index) => {
      const width = 7 - index / 2, depth = 5 + index / 4;
      const floor = {id: `level_${index}`, name: index === count - 1 ? 'Empty roof terrace' :
        count === 8 && index === 0 ? 'Fictional ground floor with a deliberately long visible name' : `Fictional level ${index + 1}`,
        elevation_m: index * 3, height_m: 2.7, rooms: [], walls: [], openings: [], items: []};
      if (index === count - 1) return floor;
      floor.rooms.push({id: 'living', name: 'Fictional living room', material: 'floor',
        polygon: [[0, 0], [width, 0], [width, depth], [0, depth]]});
      floor.walls.push({id: 'south', start: [0, 0], end: [width, 0], thickness_m: .15});
      floor.openings.push({id: 'entry', wall_id: 'south', type: 'door', offset_m: 1, width_m: 1, sill_m: 0, head_m: 2.1});
      floor.items.push({id: 'chair', name: 'Fictional chair', type: 'furniture', room: 'living',
        position_m: {x: 2, y: 0, z: 2}, dimensions_m: {width: 1, depth: 1, height: 1},
        rotation_deg: index * 30, entity_id: '', notes: ''});
      return floor;
    })};
}

function instrument() {
  const stats = window.__plannerStats = {contexts: 0, planDraws: 0, canvasResizes: 0, shaderErrors: [], gpu: null};
  for (const property of ['width', 'height']) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, property);
    Object.defineProperty(HTMLCanvasElement.prototype, property, {...descriptor, set(value) {
      if (this.id === 'preview-canvas') stats.canvasResizes++;
      descriptor.set.call(this, value);
    }});
  }
  const original = HTMLCanvasElement.prototype.getContext;
  const seen = new WeakSet();
  HTMLCanvasElement.prototype.getContext = function (...args) {
    const context = original.apply(this, args);
    if (!context || seen.has(context)) return context;
    seen.add(context);
    if (args[0] === '2d' && this.id === 'plan-canvas') {
      const clear = context.clearRect.bind(context);
      context.clearRect = (...values) => { stats.planDraws++; return clear(...values); };
    }
    if (String(args[0]).startsWith('webgl')) {
      stats.contexts++;
      const debug = context.getExtension('WEBGL_debug_renderer_info');
      stats.gpu = {renderer: context.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : context.RENDERER)};
      console.info('[home-studio-test-gpu]' + JSON.stringify(stats.gpu));
      const link = context.linkProgram.bind(context);
      context.linkProgram = program => {
        link(program);
        if (!context.getProgramParameter(program, context.LINK_STATUS)) stats.shaderErrors.push(context.getProgramInfoLog(program));
      };
    }
    return context;
  };
}

// Read-only instrumentation exposes internal ownership and history, not an alternate input path.
const readState = `
window.__navigationState=()=>({history:history.length,future:future.length,activeFloorId,
  camera:{yaw:orbit.yaw,pitch:orbit.pitch,radius:orbit.radius,target:{x:orbit.target.x,y:orbit.target.y,z:orbit.target.z}},
  memory:renderer?{...renderer.info.memory}:null,programs:renderer?.info.programs.length||0});
`;
const server = http.createServer((request, response) => {
  let route = new URL(request.url, 'http://localhost').pathname;
  if (route === '/favicon.ico') { response.writeHead(204).end(); return; }
  if (route === '/planner/') route = '/planner/index.html';
  const editorModules = ['/pbr-color-data.js', '/pbr-materials.js', '/material-textures.js', '/environment-lighting.js',
    '/camera-tour.js', '/camera-tour-panel.js', '/camera-tour-session.js', '/camera-tour-recording.js', '/camera-tour.css'];
  if ((!/^\/(planner|vendor)\/[\w./-]+$/.test(route) && !editorModules.includes(route)) || route.includes('..')) { response.writeHead(404).end(); return; }
  const file = path.join(root, route);
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'r');
    if (!fs.fstatSync(descriptor).isFile()) { response.writeHead(404).end(); return; }
    const content = route === '/planner/editor.js' ? editor + readState : fs.readFileSync(descriptor);
    response.writeHead(200, {'Content-Type': {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
      '.json': 'application/json'}[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store'}).end(content);
  } catch {
    response.writeHead(404).end();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
});

const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const project = page => page.evaluate(() => window.planner.getProject());
const state = page => page.evaluate(() => window.__navigationState());
const camera = async page => (await state(page)).camera;
const saved = page => page.waitForFunction(key => localStorage.getItem(key) === JSON.stringify(window.planner.getProject()), KEY);
const thumb = (page, id) => page.locator(`${THUMB}[data-floor-id="${id}"]`);
const svg = (page, id) => thumb(page, id).locator('svg').evaluate(element => element.outerHTML);
const documentState = page => page.evaluate(key => ({project: window.planner.getProject(),
  raw: localStorage.getItem(key), history: window.__navigationState().history, future: window.__navigationState().future}), KEY);
async function open(page, origin) {
  page.on('dialog', dialog => dialog.accept());
  await page.goto(origin + '/planner/?lang=en');
  await page.waitForFunction(() => window.planner && window.__navigationState);
  await frames(page);
}
async function importProject(page, value) {
  await page.locator('#file-input').setInputFiles({name: 'fictional-navigation.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(value))});
  await page.waitForFunction(id => window.planner.getProject().id === id, value.id);
  await saved(page); await frames(page);
  assert.deepEqual(await project(page), value, 'Import preserves all fictional project data');
}
async function change(page, label, value) {
  const field = page.locator('#inspector-body').getByLabel(label, {exact: true});
  await field.fill(value); await field.press('Tab'); await saved(page); await frames(page);
}
async function active(page, id) {
  assert.equal((await state(page)).activeFloorId, id);
  assert.equal(await thumb(page, id).getAttribute('aria-current'), 'true');
  assert.equal(await page.locator(`${THUMB}[aria-current="true"]`).count(), 1);
  assert.equal(await page.locator('#floor-list button[aria-current="true"]').count(), 1);
  assert.equal(await page.locator('#floor-caption').textContent(), (await project(page)).floors.find(floor => floor.id === id).name);
}

async function run(engine, origin) {
  return diagnostics.run(engine, {reportOnly: false, deadlineMs: 180000,
    launch: browserLaunchOptions(engine, process.env.PLANNER_NAVIGATION_HEADED !== '1'),
    context: {viewport: {width: 1440, height: 1000}, deviceScaleFactor: 2, locale: 'en-US'},
    fixture: {floors: 3, maximumFloors: 8, fictional: true}, sourceFiles,
    sourceHash: crypto.createHash('sha256').update(editor + readState).digest('hex'),
    sourceHashScope: 'instrumented-planner-editor', instrument}, async ({browser, page, record, save}) => {
    const external = record.external = [];
    await page.context().route('**/*', route => {
      if (!route.request().url().startsWith(origin + '/')) { external.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    await open(page, origin);
    assert.equal(await page.locator(THUMB).count(), 1, 'A new project has an empty-floor thumbnail');
    assert.equal(await page.locator('#floor-navigator .floor-navigator__empty').count(), 1);
    assert.equal((await page.evaluate(() => window.__plannerStats)).contexts, 0, 'Thumbnails do not create WebGL contexts');
    const value = fixture(); await importProject(page, value);
    assert.equal(await page.locator(THUMB).count(), 3);
    for (const floor of value.floors) {
      assert((await thumb(page, floor.id).getAttribute('aria-label')).includes(floor.name), 'Accessible floor name is present');
    }
    assert.notEqual(await svg(page, 'level_0'), await svg(page, 'level_1'), 'Different floor geometry produces different thumbnails');
    assert.equal(await thumb(page, 'level_2').locator('.floor-navigator__empty').count(), 1);

    await page.evaluate(selector => {
      window.__thumbnailNodes = [...document.querySelectorAll(selector)].map(button => {
        const picture = button.querySelector('svg'); return [button, picture, picture.firstElementChild];
      });
    }, THUMB);
    const beforeSwitch = await documentState(page);
    await page.locator('[data-object-kind="items"][data-object-id="chair"]').click();
    await thumb(page, 'level_1').click(); await active(page, 'level_1');
    assert.equal(await page.evaluate(() => window.planner.getSelection()), null, 'Switching floors clears the previous object selection');
    await thumb(page, 'level_0').focus(); await page.keyboard.press('Enter'); await active(page, 'level_0');
    assert.equal(await thumb(page, 'level_0').evaluate(element => element === document.activeElement), true, 'Keyboard activation retains floor focus');
    await thumb(page, 'level_1').focus(); await page.keyboard.press('Space'); await active(page, 'level_1');
    await page.keyboard.press('End');
    assert.equal(await thumb(page, 'level_2').evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Home');
    assert.equal(await thumb(page, 'level_0').evaluate(element => element === document.activeElement), true);
    await active(page, 'level_1');
    assert.deepEqual(await documentState(page), beforeSwitch, 'Floor navigation does not change project, saved draft, Undo or Redo');
    assert(await page.evaluate(() => window.__thumbnailNodes.every(([button, picture, geometry]) =>
      button.isConnected && button.querySelector('svg') === picture && picture.firstElementChild === geometry)),
      'Selection and active-floor changes preserve thumbnail DOM and geometry');

    const beforeRename = await svg(page, 'level_1');
    await page.locator('#inspector-body').getByLabel('Floor name', {exact: true}).fill('Upper floor with a deliberately long label');
    await thumb(page, 'level_0').click(); await saved(page); await active(page, 'level_0');
    assert((await thumb(page, 'level_1').getAttribute('aria-label')).includes('Upper floor with a deliberately long label'));
    assert.equal(await svg(page, 'level_1'), beforeRename, 'Renaming changes labels without repainting geometry');
    assert(await page.evaluate(() => window.__thumbnailNodes.every(([button, picture, geometry]) =>
      button.isConnected && button.querySelector('svg') === picture && picture.firstElementChild === geometry)),
      'A blur-triggered rename preserves the clicked navigation button');

    const originalThumbnail = await svg(page, 'level_0');
    await page.locator('[data-object-kind="rooms"][data-object-id="living"]').click();
    await change(page, 'x, z coordinates (m)', '0, 0\n7, 0\n5, 5\n0, 5');
    assert.notEqual(await svg(page, 'level_0'), originalThumbnail, 'Editing room geometry updates its thumbnail');
    await page.locator('#undo').click(); await saved(page); await frames(page);
    assert.equal(await svg(page, 'level_0'), originalThumbnail, 'Undo restores the original thumbnail geometry');
    await page.locator('#add-floor').click(); await saved(page); await frames(page);
    const addedId = (await state(page)).activeFloorId;
    assert.equal(await page.locator(THUMB).count(), 4); await active(page, addedId);
    assert.equal(await thumb(page, addedId).locator('.floor-navigator__empty').count(), 1);
    await page.getByRole('button', {name: 'Delete this floor', exact: true}).click(); await saved(page); await frames(page);
    assert.equal(await page.locator(THUMB).count(), 3, 'Deleting a floor removes the corresponding thumbnail');
    await thumb(page, 'level_0').click(); await saved(page); await frames(page);
    record.thumbnailChecks = {floorSwitches: 5, geometryEditAndUndo: true, rename: true, addAndDelete: true}; save();

    await page.locator('#preview-tab').click();
    await page.waitForFunction(() => window.planner.getPreviewMetadata().renderCount > 0); await frames(page);
    const baseline = await documentState(page), resourceBaseline = await state(page);
    const statsBaseline = await page.evaluate(() => window.__plannerStats);
    async function drag(options = {}) {
      const canvas = page.locator('#preview-canvas'); await canvas.scrollIntoViewIfNeeded();
      const box = await canvas.boundingBox();
      await page.mouse.move(box.x + box.width * .45, box.y + box.height * .45);
      if (options.shift) await page.keyboard.down('Shift');
      await page.mouse.down({button: options.button || 'left'});
      assert.equal(await canvas.getAttribute('data-navigating'), 'true', 'Pointer capture starts a navigation gesture');
      await page.mouse.move(box.x + box.width * .57, box.y + box.height * .54, {steps: 5});
      await page.mouse.up({button: options.button || 'left'});
      if (options.shift) await page.keyboard.up('Shift');
      await frames(page);
      assert.notEqual(await canvas.getAttribute('data-navigating'), 'true', 'Pointer release clears navigation state');
    }
    const start = await camera(page); await drag(); const orbited = await camera(page);
    assert.notEqual(orbited.yaw, start.yaw); assert.notEqual(orbited.pitch, start.pitch);
    assert.deepEqual(orbited.target, start.target, 'Orbit does not pan the target');
    await page.locator('#preview-pan').click(); await frames(page);
    assert.equal(await page.locator('#preview-pan').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#preview-canvas').getAttribute('data-navigation-mode'), 'pan');
    const beforePan = await camera(page); await drag(); const panned = await camera(page);
    assert.notDeepEqual(panned.target, beforePan.target, 'Pan mode moves the camera target');
    assert.equal(panned.yaw, beforePan.yaw); assert.equal(panned.pitch, beforePan.pitch); assert.equal(panned.radius, beforePan.radius);
    await page.locator('#preview-orbit').click(); await frames(page);
    const beforeShift = await camera(page); await drag({shift: true});
    assert.notDeepEqual((await camera(page)).target, beforeShift.target, 'Shift-drag pans while orbit mode is selected');
    const beforeMiddle = await camera(page); await drag({button: 'middle'});
    assert.notDeepEqual((await camera(page)).target, beforeMiddle.target, 'Middle-drag pans');
    const beforeWheel = await camera(page);
    await page.locator('#preview-canvas').hover(); await page.mouse.wheel(0, -120); await frames(page);
    assert((await camera(page)).radius < beforeWheel.radius, 'Native wheel input zooms toward the scene');

    const canvas = page.locator('#preview-canvas'); await canvas.focus();
    const beforeKey = await camera(page); await page.keyboard.press('ArrowRight'); await frames(page);
    assert.notEqual((await camera(page)).yaw, beforeKey.yaw, 'Arrow keys orbit the focused canvas');
    const beforeKeyPan = await camera(page); await page.keyboard.press('Shift+ArrowRight'); await frames(page);
    assert.notDeepEqual((await camera(page)).target, beforeKeyPan.target, 'Shift-arrow keys pan the focused canvas');
    await page.locator('#project-title').focus(); const beforeTextKey = await camera(page);
    await page.keyboard.press('ArrowLeft'); await frames(page);
    assert.deepEqual(await camera(page), beforeTextKey, 'Text-field arrow input does not navigate the camera');
    await page.locator('#preview-top').click(); await frames(page);
    assert((await camera(page)).pitch > 1.55, 'Top view looks down at the floor');
    const beforeRotate = await camera(page);
    await page.locator('#preview-rotate-right').click(); await frames(page); const rotated = await camera(page);
    assert.notEqual(rotated.yaw, beforeRotate.yaw); assert.deepEqual(rotated.target, beforeRotate.target); assert.equal(rotated.radius, beforeRotate.radius);
    await page.locator('#preview-rotate-left').click(); await frames(page);
    assert(Math.abs((await camera(page)).yaw - beforeRotate.yaw) < 1e-9, 'Opposite rotation controls restore heading');
    await page.locator('#fit-view').click(); await frames(page);
    const bounds = await page.evaluate(() => window.planner.getPreviewMetadata().projectedBounds);
    assert(bounds.minX >= -1 && bounds.maxX <= 1 && bounds.minY >= -1 && bounds.maxY <= 1, 'Fit view contains the active floor');
    assert.deepEqual(await documentState(page), baseline, 'Camera gestures and toolbar actions preserve project, draft and history');
    const resourceAfter = await state(page), statsAfter = await page.evaluate(() => window.__plannerStats);
    assert.deepEqual(resourceAfter.memory, resourceBaseline.memory, 'Camera navigation does not allocate scene geometry or textures');
    assert.equal(resourceAfter.programs, resourceBaseline.programs, 'Camera navigation does not compile extra shader programs');
    assert.equal(statsAfter.contexts, 1, 'The preview and every thumbnail share exactly one preview WebGL context');
    assert.equal(statsAfter.canvasResizes, statsBaseline.canvasResizes, 'Camera navigation does not reallocate the drawing buffer');

    const burst = await page.evaluate(async () => {
      const canvas = document.getElementById('preview-canvas'), box = canvas.getBoundingClientRect();
      const before = window.planner.getPreviewMetadata().renderCount;
      for (let i = 0; i < 40; i++) canvas.dispatchEvent(new WheelEvent('wheel', {deltaY: 1, bubbles: true, cancelable: true,
        clientX: box.x + box.width / 2, clientY: box.y + box.height / 2}));
      const immediate = window.planner.getPreviewMetadata().renderCount - before;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {immediate, total: window.planner.getPreviewMetadata().renderCount - before};
    });
    assert(burst.immediate <= 1 && burst.total > 0 && burst.total <= 2, 'A same-task wheel burst coalesces into at most two draws');
    const idle = await page.evaluate(() => ({draws: window.planner.getPreviewMetadata().renderCount, plan: window.__plannerStats.planDraws}));
    await page.waitForTimeout(300);
    assert.deepEqual(await page.evaluate(() => ({draws: window.planner.getPreviewMetadata().renderCount, plan: window.__plannerStats.planDraws})), idle,
      'The idle preview and thumbnails do not run a render loop');
    await thumb(page, 'level_1').click(); await frames(page); await active(page, 'level_1');
    assert.deepEqual(await page.evaluate(() => window.planner.getPreviewMetadata().floors), ['level_1']);
    await page.locator('#all-floors').check(); await frames(page);
    assert.deepEqual(await page.evaluate(() => window.planner.getPreviewMetadata().floors), value.floors.map(floor => floor.id));
    assert.deepEqual(await documentState(page), baseline, 'Preview floor scope is navigation state only');
    await page.screenshot({path: path.join(diagnostics.directory, `${engine}-desktop-preview.png`)});
    await page.locator('#plan-tab').click(); await frames(page);
    const hiddenDraws = await page.evaluate(() => window.planner.getPreviewMetadata().renderCount);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => window.planner.getPreviewMetadata().renderCount), hiddenDraws, 'The closed preview stops drawing');
    record.navigationChecks = {burst, contexts: statsAfter.contexts, idleDraws: idle.draws, camera: await camera(page)}; save();

    const phone = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2,
      hasTouch: true, locale: 'en-US', ...(engine === 'firefox' ? {} : {isMobile: true})});
    let mobilePage;
    try {
      await phone.addInitScript(instrument);
      const mobile = mobilePage = await phone.newPage(); const mobileErrors = [];
      mobile.on('pageerror', error => mobileErrors.push(String(error)));
      await open(mobile, origin); await importProject(mobile, fixture(8));
      assert.equal(await mobile.locator(THUMB).count(), 8, 'All eight supported floors are represented on a narrow viewport');
      await thumb(mobile, 'level_7').tap(); await active(mobile, 'level_7');
      await thumb(mobile, 'level_0').tap(); await active(mobile, 'level_0');
      const layout = await mobile.evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth,
        navigator: (() => { const rect = document.getElementById('floor-navigator').getBoundingClientRect(); return {left: rect.left, right: rect.right}; })()}));
      assert(layout.scroll <= layout.width + 1, 'Eight thumbnails and long labels do not overflow the mobile page');
      assert(layout.navigator.left >= 0 && layout.navigator.right <= layout.width + 1, 'The floor navigator remains inside the narrow viewport');
      if (await mobile.locator('#floor-navigator-toggle').count()) {
        await mobile.locator('#floor-navigator-toggle').tap();
        assert.equal(await mobile.locator('#floor-navigator-toggle').getAttribute('aria-expanded'), 'false');
        await mobile.locator('#floor-list button').last().tap(); await active(mobile, 'level_7');
        await mobile.locator('#floor-navigator-toggle').tap();
        assert.equal(await mobile.locator('#floor-navigator-toggle').getAttribute('aria-expanded'), 'true');
        await frames(mobile);
        const reveal = await thumb(mobile, 'level_7').evaluate(button => {
          const rail = button.parentElement.getBoundingClientRect(), rect = button.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return {insideRail: rect.top >= rail.top && rect.bottom <= rail.bottom,
            receivesInput: hit === button || button.contains(hit)};
        });
        assert(reveal.insideRail, 'Reopening the rail reveals the floor selected while thumbnails were hidden');
        assert(reveal.receivesInput, 'The revealed thumbnail is not covered by the rail toggle or other controls');
        await thumb(mobile, 'level_7').tap();
      }
      await mobile.screenshot({path: path.join(diagnostics.directory, `${engine}-phone-floors.png`)});
      assert.deepEqual(mobileErrors, []); record.mobile = {layout, floors: 8, nativeTaps: 3, realMobileOS: false}; save();
    } catch (error) {
      if (mobilePage) {
        try {
          record.mobileFailure = await mobilePage.evaluate(() => {
            const box = selector => {
              const element = document.querySelector(selector), rect = element?.getBoundingClientRect();
              return rect ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height,
                hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.outerHTML.slice(0, 500)} : null;
            };
            return {viewport: [innerWidth, innerHeight], rail: box('#floor-navigator'),
              toggle: box('#floor-navigator-toggle'), firstFloor: box('#floor-navigator button')};
          });
          await mobilePage.screenshot({path: path.join(diagnostics.directory, `${engine}-phone-failure.png`), timeout: 5000});
        } catch (captureError) { record.mobileFailureCaptureError = String(captureError); }
        save();
      }
      throw error;
    } finally { await phone.close(); }

    const limited = await browser.newContext({viewport: {width: 1280, height: 900}, locale: 'en-US'});
    try {
      await limited.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
          return String(kind).startsWith('webgl') ? null : original.call(this, kind, ...rest);
        };
      });
      const fallback = await limited.newPage(); const fallbackErrors = [];
      fallback.on('pageerror', error => fallbackErrors.push(String(error)));
      await open(fallback, origin); await importProject(fallback, value);
      const fallbackBefore = await documentState(fallback);
      await fallback.locator('#preview-tab').click(); await fallback.locator('#preview-error').waitFor({state: 'visible'});
      await thumb(fallback, 'level_1').click(); await active(fallback, 'level_1');
      assert.deepEqual(await documentState(fallback), fallbackBefore, 'Fallback floor navigation preserves project, draft and history');
      await fallback.locator('#plan-tab').click();
      await fallback.getByRole('button', {name: 'Add room', exact: true}).click(); await saved(fallback);
      assert.equal((await project(fallback)).floors[1].rooms.length, 2, 'The 2D editor still accepts geometry edits without WebGL');
      assert.notDeepEqual(await documentState(fallback), fallbackBefore);
      const downloadPromise = fallback.waitForEvent('download'); await fallback.locator('#export-project').click();
      const download = await downloadPromise;
      assert.deepEqual(JSON.parse(fs.readFileSync(await download.path(), 'utf8')), await project(fallback), 'Fallback JSON export retains every edit');
      assert.deepEqual(fallbackErrors, []); record.fallback = {edited: true, exported: true}; save();
    } finally { await limited.close(); }
    assert.deepEqual(external, []); assert.deepEqual(record.errors, []); assert.deepEqual(record.crashes, []);
    assert.deepEqual(record.consoleErrors, []); assert.deepEqual(record.httpErrors, []);
    assert.deepEqual(statsAfter.shaderErrors, []); save();
  });
}

(async () => {
  const engines = selectedEngines(process.env.PLANNER_NAVIGATION_ENGINES || 'chromium,firefox');
  diagnostics.configure(engines, false);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await diagnostics.runAll(engines, engine => run(engine, `http://127.0.0.1:${server.address().port}`));
  } finally { await new Promise(resolve => server.close(resolve)); }
})().then(() => diagnostics.finish(), error => { diagnostics.finish(error); console.error(error); process.exitCode = 1; });
