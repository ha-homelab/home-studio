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
async function previewPoint(page, point) {
  return page.evaluate(async point => {
    const THREE = await import('/vendor/three.module.min.js');
    const state = planner.getPreviewMetadata().camera, rect = document.getElementById('preview-canvas').getBoundingClientRect();
    const camera = new THREE.PerspectiveCamera(40, rect.width / rect.height, .02, 1500), horizontal = Math.cos(state.pitch) * state.radius;
    camera.position.set(state.target.x + Math.cos(state.yaw) * horizontal,
      state.target.y + Math.sin(state.pitch) * state.radius, state.target.z + Math.sin(state.yaw) * horizontal);
    camera.lookAt(new THREE.Vector3(state.target.x, state.target.y, state.target.z)); camera.updateMatrixWorld();
    const projected = new THREE.Vector3(...point).project(camera);
    return { x: rect.x + (projected.x + 1) * rect.width / 2, y: rect.y + (1 - projected.y) * rect.height / 2 };
  }, point);
}
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
      window.__planPaints = 0;
      const clear = CanvasRenderingContext2D.prototype.clearRect;
      CanvasRenderingContext2D.prototype.clearRect = function (...args) {
        if (this.canvas.id === 'plan-canvas') window.__planPaints++;
        return clear.apply(this, args);
      };
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
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const planPaints = await page.evaluate(() => window.__planPaints);
    const camera = await page.evaluate(() => window.planner.getPreviewMetadata().camera);
    await page.mouse.move(preview.x + preview.width * .5, preview.y + preview.height * .45);
    await page.mouse.down(); await page.mouse.move(preview.x + preview.width * .5 + 60, preview.y + preview.height * .45 + 30, { steps: 12 }); await page.mouse.up();
    await page.waitForFunction(yaw => window.planner.getPreviewMetadata().camera.yaw !== yaw, camera.yaw);
    assert.deepEqual(await project(), before, 'Orbit changes no plan data');
    assert.equal(await page.evaluate(() => window.__planPaints), planPaints, 'Orbit redraws only 3D, keeping the 2D plan idle');
    const radius = await page.evaluate(() => window.planner.getPreviewMetadata().camera.radius);
    await page.locator('#preview-canvas').press('+');
    await page.waitForFunction(radius => window.planner.getPreviewMetadata().camera.radius !== radius, radius);
    assert.equal(await page.evaluate(() => window.__planPaints), planPaints, 'Camera keyboard zoom also leaves 2D idle');

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('.environment-controls summary').click();
    await page.locator('[data-environment="enabled"]').check();
    await page.locator('[data-environment="motion"]').check();
    await page.waitForFunction(() => window.planner.getPreviewMetadata().surroundings.elapsed > 0);
    assert.equal(await page.evaluate(() => window.__planPaints), planPaints, 'Scenery setup and animation never repaint the unchanged plan');
    await page.locator('[data-environment="motion"]').uncheck();
    await page.locator('[data-environment="enabled"]').uncheck();
    await page.locator('.environment-controls summary').click();
    await page.locator('[data-object-kind="items"]').first().click();
    const nodeBefore = await page.evaluate(() => window.__splitTest.item());
    const [x, y] = await page.evaluate(() => window.planner.worldToScreen([2, 2]));
    await page.mouse.move(plan.x + x, plan.y + y); await page.mouse.down();
    await page.mouse.move(plan.x + x + 35, plan.y + y + 25, { steps: 10 }); await page.mouse.up();
    await page.waitForFunction(() => !window.__splitTest.dirty());
    const moved = await project();
    assert.notDeepEqual(moved.floors[0].items[0].position_m, before.floors[0].items[0].position_m, '2D drag edits the accepted item');
    assert(await page.evaluate(() => window.__planPaints) > planPaints, 'Geometry changes still repaint 2D');
    assert.notDeepEqual(await page.evaluate(() => window.__splitTest.item()), nodeBefore, 'Committed 2D edit reaches the 3D mesh');
    await page.locator('#undo').click();
    await page.waitForFunction(expected => JSON.stringify(window.planner.getProject()) === expected, JSON.stringify(before));
    await page.waitForFunction(() => !window.__splitTest.dirty());
    assert.deepEqual(await page.evaluate(() => window.__splitTest.item()), nodeBefore, 'Undo updates both panes');

    // A tool change must roll back the active 3D transaction, even though the
    // left drawing pane stays visible and the selected workspace does not change.
    await page.locator('[data-object-kind="items"]').first().click();
    await page.locator('#preview-edit').click();
    await page.waitForFunction(() => !window.__splitTest.dirty());
    const item = before.floors[0].items[0];
    const editPoint = await previewPoint(page, [item.position_m.x, item.position_m.y + item.dimensions_m.height / 2, item.position_m.z]);
    await page.mouse.move(editPoint.x, editPoint.y); await page.mouse.down();
    await page.mouse.move(editPoint.x + 40, editPoint.y + 20, { steps: 6 });
    assert.notDeepEqual(await project(), before, 'The real 3D drag changed the working copy');
    await page.keyboard.press('r');
    assert.deepEqual(await project(), before, 'Changing drawing tools cancels the 3D move');
    await page.mouse.up();
    assert.deepEqual(await project(), before, 'The released 3D pointer cannot commit a cancelled move');
    assert.equal(await page.evaluate(() => window.planner.getView()), 'split');
    assert.equal(await page.locator('[data-tool="room"]').getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => !window.__splitTest.dirty());
    assert.deepEqual(await page.evaluate(() => window.__splitTest.item()), nodeBefore, 'Cancellation restores the 3D mesh');
    assert.equal(await page.locator('#undo').isDisabled(), true, 'A cancelled move adds no undo entry');

    // Clearing selection takes the pan path through finishPointer. That path
    // must refresh the other pane even without a geometry change.
    await page.locator('[data-tool="select"]').click();
    await page.locator('#preview-elevation-handle').waitFor({ state: 'visible' });
    await page.mouse.click(plan.x + 5, plan.y + plan.height * .5);
    assert.equal(await page.evaluate(() => window.planner.getSelection()), null);
    await page.waitForFunction(() => !window.__splitTest.dirty());
    assert.equal(await page.locator('#preview-elevation-handle').isVisible(), false, 'Deselecting in 2D clears the 3D edit handle');
    assert.deepEqual(await project(), before, 'Deselecting changes no geometry');

    // Drawing tools remain available without throwing the user out of split view.
    await page.locator('[data-tool="room"]').click();
    assert.equal(await page.evaluate(() => window.planner.getView()), 'split');
    await page.locator('[data-tool="select"]').click();
    const renders = await page.evaluate(() => window.__splitTest.rendered());
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => window.__splitTest.rendered()), renders, 'Idle split view does not animate');
    await page.locator('#preview-tab').click(); await page.locator('#split-tab').click();
    assert.equal(await page.evaluate(() => window.__contexts.size), 1, 'Switching views reuses the renderer');
    for (const focus of ['#preview-canvas', '#split-tab']) {
      await page.locator(focus).focus();
      await page.setViewportSize({ width: 950, height: 900 });
      await page.waitForFunction(() => window.planner.getView() === 'plan');
      assert(await page.locator('#split-tab').isDisabled(), 'Small viewports keep usable full-width drawing');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'plan-canvas', `${focus} focus follows the surviving pane`);
      assert.deepEqual(await project(), before, 'Resizing changes no accepted geometry');
      await page.setViewportSize({ width: 1800, height: 1050 });
      await page.locator('#split-tab').click();
      await page.waitForFunction(() => window.planner.getView() === 'split');
    }

    // Losing WebGL must leave the independent 2D editor and its undo usable.
    await page.evaluate(() => {
      const extension = document.getElementById('preview-canvas').getContext('webgl2').getExtension('WEBGL_lose_context');
      if (!extension) throw Error('WEBGL_lose_context is required for the graphics-loss regression');
      extension.loseContext();
    });
    await page.locator('#preview-error').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#plan-canvas').isVisible(), true);
    const lostPlan = await page.locator('#plan-canvas').boundingBox();
    const [lostX, lostY] = await page.evaluate(() => window.planner.worldToScreen([2, 2]));
    await page.mouse.move(lostPlan.x + lostX, lostPlan.y + lostY); await page.mouse.down();
    await page.mouse.move(lostPlan.x + lostX + 35, lostPlan.y + lostY + 25, { steps: 6 }); await page.mouse.up();
    assert.notDeepEqual(await project(), before, '2D editing commits after WebGL context loss');
    await page.locator('#undo').click();
    assert.deepEqual(await project(), before, '2D undo works after WebGL context loss');
    assert.equal(await page.evaluate(() => window.__contexts.size), 1, '2D fallback does not create replacement GL contexts');
    assert.deepEqual(errors, []);
    console.log(`PASS: ${engine} split editing, cancellation, deselection, undo, isolated camera/scenery paints, context reuse, idle rendering, responsive focus and 2D editing after graphics loss.`);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
