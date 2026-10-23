// Exercise both editor panes against one accepted document and one WebGL context.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const playwright = require('playwright');
const { browserLaunchOptions } = require('./browser-stability-diagnostics.cjs');
const root = path.resolve(__dirname, '..');
const engine = process.env.PLANNER_SPLIT_ENGINE || 'chromium';
const fixture = {
  schema_version: 1, id: 'split_fixture', title: 'Fictional split-view study',
  floors: [{ id: 'ground', name: 'Practice floor', elevation_m: 0, height_m: 2.8,
    rooms: [{ id: 'study', name: 'Practice room', polygon: [[0, 0], [5, 0], [5, 4], [0, 4]], material: 'floor' }],
    walls: [], openings: [], items: [{ id: 'box', name: 'Practice block', type: 'furniture', room: 'study',
      position_m: { x: 2, y: .4, z: 2 }, dimensions_m: { width: .8, depth: .7, height: .5 },
      rotation_deg: 0, entity_id: '', notes: '' }] }],
};
(async () => {
  const server = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + route, route.endsWith('/') ? 'index.html' : '');
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' })[path.extname(file)] || 'text/html');
      let source = fs.readFileSync(file);
      if (file === path.join(root, 'planner/editor.js')) source = source.toString() + '\nwindow.__splitTest = { dirty: () => previewDirty, rendered: () => previewMetadata.renderCount || 0, item: () => { const r = previewItemNodes.get("box"); return r ? r.nodes[0].position.toArray() : null; } };';
      res.end(source);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await playwright[engine].launch(browserLaunchOptions(engine));
    const page = await browser.newPage({ viewport: { width: 1800, height: 1050 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(value => {
      localStorage.setItem('home-studio.project.v1', JSON.stringify(value));
      const original = HTMLCanvasElement.prototype.getContext;
      window.__contexts = new Set();
      HTMLCanvasElement.prototype.getContext = function (name, ...args) {
        const result = original.call(this, name, ...args);
        if (/^webgl/.test(name) && result) window.__contexts.add(result);
        return result;
      };
    }, fixture);
    await page.goto(`http://127.0.0.1:${server.address().port}/planner/`);
    await page.waitForFunction(() => window.planner);
    await page.locator('#split-tab').click();
    await page.waitForFunction(() => window.planner.getView() === 'split' && window.planner.getPreviewMetadata().items === 1);
    await page.locator('#fit-view').click();
    const plan = await page.locator('#plan-canvas').boundingBox();
    const preview = await page.locator('#preview-canvas').boundingBox();
    assert(Math.abs(plan.width - preview.width) < 2 && plan.x + plan.width <= preview.x + 1, 'Panes are adjacent and equally sized');
    assert.equal(await page.evaluate(() => window.__contexts.size), 1, 'Only one WebGL context is created');
    const project = () => page.evaluate(() => window.planner.getProject());
    const before = await project();
    const camera = await page.evaluate(() => window.planner.getPreviewMetadata().camera);
    await page.mouse.move(preview.x + preview.width * .5, preview.y + preview.height * .45);
    await page.mouse.down(); await page.mouse.move(preview.x + preview.width * .5 + 60, preview.y + preview.height * .45 + 30, { steps: 12 }); await page.mouse.up();
    await page.waitForFunction(yaw => window.planner.getPreviewMetadata().camera.yaw !== yaw, camera.yaw);
    assert.deepEqual(await project(), before, 'Orbit changes no plan data');
    await page.locator('[data-object-kind="items"]').first().click();
    const nodeBefore = await page.evaluate(() => window.__splitTest.item());
    const [x, y] = await page.evaluate(() => window.planner.worldToScreen([2, 2]));
    await page.mouse.move(plan.x + x, plan.y + y); await page.mouse.down();
    await page.mouse.move(plan.x + x + 35, plan.y + y + 25, { steps: 10 }); await page.mouse.up();
    await page.waitForFunction(() => !window.__splitTest.dirty());
    const moved = await project();
    assert.notDeepEqual(moved.floors[0].items[0].position_m, before.floors[0].items[0].position_m, '2D drag edits the accepted item');
    assert.notDeepEqual(await page.evaluate(() => window.__splitTest.item()), nodeBefore, 'Committed 2D edit reaches the 3D mesh');
    await page.locator('#undo').click();
    await page.waitForFunction(expected => JSON.stringify(window.planner.getProject()) === expected, JSON.stringify(before));
    await page.waitForFunction(() => !window.__splitTest.dirty());
    assert.deepEqual(await page.evaluate(() => window.__splitTest.item()), nodeBefore, 'Undo updates both panes');
    // Drawing tools remain available without throwing the user out of split view.
    await page.locator('[data-tool="room"]').click();
    assert.equal(await page.evaluate(() => window.planner.getView()), 'split');
    await page.locator('[data-tool="select"]').click();
    const renders = await page.evaluate(() => window.__splitTest.rendered());
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => window.__splitTest.rendered()), renders, 'Idle split view does not animate');
    await page.locator('#preview-tab').click(); await page.locator('#split-tab').click();
    assert.equal(await page.evaluate(() => window.__contexts.size), 1, 'Switching views reuses the renderer');
    await page.setViewportSize({ width: 950, height: 900 });
    await page.waitForFunction(() => window.planner.getView() === 'plan');
    assert(await page.locator('#split-tab').isDisabled(), 'Small viewports keep usable full-width drawing');
    assert.deepEqual(await project(), before, 'Resizing changes no accepted geometry');
    assert.deepEqual(errors, []);
    console.log(`PASS: ${engine} split 2D + 3D editing, undo, orbit, context reuse, idle rendering and narrow-layout fallback.`);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
