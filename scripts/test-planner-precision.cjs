// Real pointer and inspector acceptance using a fictional project and an isolated origin.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createHash } = require('node:crypto');
const playwright = require('playwright');
const { browserLaunchOptions } = require('./browser-stability-diagnostics.cjs');
const root = path.resolve(__dirname, '..');
const engine = process.env.PLANNER_PRECISION_ENGINE || 'chromium';
assert(['chromium', 'firefox', 'webkit'].includes(engine), 'Unsupported browser engine');
const KEY = 'home-studio.project.v1';
const clone = value => structuredClone(value);
const close = (actual, expected, message, tolerance = .018) => assert(Math.abs(actual - expected) <= tolerance,
  `${message}: expected ${expected}, received ${actual}`);
const fixture = {
  schema_version: 1, id: 'precision_fixture', title: 'Fictional precision study',
  floors: [{ id: 'upper', name: 'Raised practice floor', elevation_m: 1.5, height_m: 2.8,
    rooms: [{ id: 'study', name: 'Practice room', polygon: [[1, 2], [7, 2], [7, 7], [1, 7]], material: 'floor' }],
    walls: [], openings: [], items: [{ id: 'box', name: 'Practice block', type: 'furniture', room: 'study',
      position_m: { x: 3.125, y: .4, z: 4.125 }, dimensions_m: { width: .8, depth: .7, height: .5 },
      rotation_deg: 0, entity_id: '', notes: '' }] }],
};
const outlinedFixture = clone(fixture);
outlinedFixture.floors[0].walls = fixture.floors[0].rooms[0].polygon.map((start, index, points) => ({
  id: `wall_${index}`, start: [...start], end: [...points[(index + 1) % points.length]], thickness_m: .15,
}));
outlinedFixture.floors[0].openings = [{ id: 'window', wall_id: 'wall_0', type: 'window',
  offset_m: 1.2, width_m: 1.5, sill_m: .7, head_m: 2.1 }];

(async () => {
  const server = http.createServer((request, response) => {
    const route = new URL(request.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + route, route.endsWith('/') ? 'index.html' : '');
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    try {
      response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' })[path.extname(file)] || 'text/html');
      response.end(fs.readFileSync(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await playwright[engine].launch(browserLaunchOptions(engine, process.env.PLANNER_PRECISION_HEADED !== '1'));
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    const page = await context.newPage(), errors = [], external = [];
    await page.addInitScript(() => document.addEventListener('pointerdown', event => { window.__precisionPointerId = event.pointerId; }, true));
    const origin = `http://127.0.0.1:${server.address().port}`;
    page.on('pageerror', error => errors.push(String(error)));
    page.on('dialog', dialog => dialog.accept());
    page.on('request', request => { if (!request.url().startsWith(origin + '/') && !/^(data|blob):/.test(request.url())) external.push(request.url()); });
    page.setDefaultTimeout(15000);
    const project = () => page.evaluate(() => window.planner.getProject());
    const item = async () => (await project()).floors[0].items[0];
    const field = label => page.locator('#inspector-body').getByLabel(label, { exact: true });
    const change = async (label, value) => { await field(label).fill(String(value)); await field(label).press('Tab'); };
    const saved = () => page.waitForFunction(key => localStorage.getItem(key) === JSON.stringify(window.planner.getProject()), KEY);
    const selectRoom = () => page.locator('[data-object-kind="rooms"]').first().click();
    const selectItem = () => page.locator('[data-object-kind="items"]').first().click();
    const load = async value => {
      await page.locator('#plan-tab').click();
      await page.locator('#file-input').setInputFiles({ name: 'precision.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
      await page.waitForFunction(expected => JSON.stringify(window.planner.getProject()) === expected, JSON.stringify(value));
      await page.locator('#fit-view').click();
      await page.locator('#snap').check();
      await page.locator('[data-tool="select"]').click();
      await saved();
    };
    const planPoint = point => page.evaluate(point => {
      const [x, y] = planner.worldToScreen(point), bounds = document.getElementById('plan-canvas').getBoundingClientRect();
      return { x: bounds.x + x, y: bounds.y + y };
    }, point);
    const dragPlan = async (from, to, { alt = false, cancel = null } = {}) => {
      const a = await planPoint(from), b = await planPoint(to);
      const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, a);
      assert.equal(hit, 'plan-canvas', 'A real canvas pointerdown must start the gesture');
      if (alt) await page.keyboard.down('Alt');
      await page.mouse.move(a.x, a.y); await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps: 5 });
      const provisional = await project();
      if (cancel === 'Escape') await page.keyboard.press('Escape');
      // Native focus loss and pointer cancellation are lifecycle events; real
      // mouse movement above proves there was a nonempty gesture to roll back.
      if (cancel === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      if (cancel === 'pointercancel') await page.locator('#plan-canvas').dispatchEvent('pointercancel', { pointerId: await page.evaluate(() => window.__precisionPointerId) });
      await page.mouse.up();
      if (alt) await page.keyboard.up('Alt');
      return provisional;
    };
    const undoTo = async expected => { await page.locator('#undo').click(); assert.deepEqual(await project(), expected, 'One Undo restores the entire gesture'); await saved(); };

    await page.goto(origin + '/planner/');
    await page.waitForFunction(() => window.planner);
    await load(fixture);
    await dragPlan([3.125, 4.125], [3.495, 4.535]);
    assert.deepEqual((await item()).position_m, { x: 3.5, y: .4, z: 4.5 }, 'Default snap places an off-grid item on the 0.25 m grid on both axes');
    const snapped = await project(); await saved(); await undoTo(fixture);
    await page.locator('#redo').click(); assert.deepEqual(await project(), snapped);
    await undoTo(fixture);
    await dragPlan([3.125, 4.125], [3.495, 4.535], { alt: true });
    close((await item()).position_m.x, 3.495, 'Alt retains the horizontal pointer displacement');
    close((await item()).position_m.z, 4.535, 'Alt retains the vertical pointer displacement');
    assert.equal(await page.locator('#snap').isChecked(), true, 'Alt bypass is temporary');
    const precise = await project(); await saved();
    for (const cancel of ['Escape', 'blur', 'pointercancel']) {
      await selectItem();
      const position = (await item()).position_m;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const beforePixels = await page.locator('#plan-canvas').evaluate(canvas => canvas.toDataURL());
      const provisional = await dragPlan([position.x, position.z], [position.x + .5, position.z + .5], { cancel });
      assert.notDeepEqual(provisional, precise, `${cancel} must cancel an actual moved working copy`);
      assert.deepEqual(await project(), precise, `${cancel} restores the committed project`);
      await saved();
      // Escape also clears selection. Restore the same visible selection before
      // comparing pixels so only committed geometry is being compared.
      await selectItem();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const afterPixels = await page.locator('#plan-canvas').evaluate(canvas => canvas.toDataURL());
      assert.equal(createHash('sha256').update(afterPixels).digest('hex'), createHash('sha256').update(beforePixels).digest('hex'), `${cancel} leaves no ghost item on the 2D canvas`);
    }
    await undoTo(fixture); await page.locator('#redo').click(); assert.deepEqual(await project(), precise, 'Cancelled gestures do not consume Undo entries'); await saved();
    await page.reload(); await page.waitForFunction(() => window.planner);
    assert.deepEqual(await project(), precise, 'Reload restores only committed coordinates');

    await load(fixture); await page.locator('#snap').uncheck();
    await dragPlan([3.125, 4.125], [3.495, 4.535]);
    close((await item()).position_m.x, 3.495, 'Disabling snap allows fine horizontal movement');
    close((await item()).position_m.z, 4.535, 'Disabling snap allows fine vertical movement');
    const empty = clone(fixture); empty.floors[0].rooms = []; empty.floors[0].items = [];
    await load(empty); await page.locator('[data-tool="room"]').click();
    await dragPlan([.37, .41], [2.73, 2.79]);
    assert.deepEqual((await project()).floors[0].rooms[0].polygon, [[.25, .5], [2.75, .5], [2.75, 2.75], [.25, 2.75]], 'Drawing snaps both axes at both endpoints');
    await load(empty); await page.locator('[data-tool="room"]').click();
    await dragPlan([.37, .41], [2.73, 2.79], { alt: true });
    const drawn = (await project()).floors[0].rooms[0].polygon;
    for (const [index, expected] of [[0, [.37, .41]], [2, [2.73, 2.79]]]) {
      close(drawn[index][0], expected[0], 'Alt drawing x'); close(drawn[index][1], expected[1], 'Alt drawing z');
    }

    await load(outlinedFixture); await selectRoom();
    await change('Width (m)', 7.2);
    let floor = (await project()).floors[0];
    assert.deepEqual(floor.rooms[0].polygon, [[1, 2], [8.2, 2], [8.2, 7], [1, 7]], 'Numeric width anchors minimum x/z');
    assert.deepEqual(floor.walls[0].end, [8.2, 2], 'Exclusive boundary wall follows dimensions');
    assert.deepEqual(floor.walls[1].start, [8.2, 2]); assert.deepEqual(floor.walls[1].end, [8.2, 7]);
    assert.equal(floor.openings[0].offset_m, 1.59, 'Opening center retains its proportional wall position');
    assert.equal(floor.openings[0].width_m, 1.5, 'Room dimensions preserve the measured opening width');
    assert.deepEqual(floor.items, outlinedFixture.floors[0].items, 'Room dimensions do not displace furniture');
    await undoTo(outlinedFixture); await selectRoom();
    await change('Depth (m)', 5.6);
    assert.deepEqual((await project()).floors[0].rooms[0].polygon, [[1, 2], [7, 2], [7, 7.6], [1, 7.6]]);
    await undoTo(outlinedFixture); await selectRoom();
    await change('Width (m)', .01);
    assert.equal(await field('Width (m)').getAttribute('aria-invalid'), 'true');
    assert.deepEqual(await project(), outlinedFixture, 'Invalid dimensions cannot enter model/history/storage');
    await change('Width (m)', 6); await saved();
    await dragPlan([7, 7], [7.37, 7.41], { alt: true });
    floor = (await project()).floors[0];
    close(floor.rooms[0].polygon[2][0], 7.37, 'Alt corner resize width');
    close(floor.rooms[0].polygon[2][1], 7.41, 'Alt corner resize depth');
    assert.deepEqual(floor.rooms[0].polygon[0], [1, 2], 'The opposite resize corner stays fixed');
    assert.deepEqual(floor.walls[1].end, floor.rooms[0].polygon[2], 'Corner resize keeps boundary walls joined');
    await undoTo(outlinedFixture); await selectRoom();
    const beforeCancel = await dragPlan([1, 2], [1.5, 2.5], { cancel: 'Escape' });
    assert.notDeepEqual(beforeCancel, outlinedFixture, 'Resize cancellation has a nonempty working copy');
    assert.deepEqual(await project(), outlinedFixture, 'Resize cancellation also restores walls and openings');

    const shared = clone(outlinedFixture);
    shared.floors[0].rooms.push({ id: 'neighbor', name: 'Neighbor', polygon: [[7, 2], [10, 2], [10, 7], [7, 7]], material: 'floor' });
    await load(shared); await selectRoom(); await change('Width (m)', 6.5);
    assert.deepEqual(await project(), shared, 'Shared-wall dimension changes reject the whole transaction');
    assert.equal(await field('Width (m)').getAttribute('aria-invalid'), 'true', 'Rejected shared-wall edit gives actionable field feedback');
    await change('Width (m)', 6);
    await dragPlan([7, 7], [7.5, 7.5]);
    assert.deepEqual(await project(), shared, 'Shared-wall corner gestures cannot distort a neighboring room');

    // A neighbor can share only the middle of a longer wall. Neither wall
    // endpoint belongs to that neighbor, so endpoint-only guards miss it.
    const partial = clone(fixture), partialFloor = partial.floors[0];
    partialFloor.items = [];
    partialFloor.rooms[0].polygon = [[0, 0], [10, 0], [10, 4], [0, 4]];
    partialFloor.rooms.push({ id: 'neighbor', name: 'Partial-edge neighbor', polygon: [[3, 4], [7, 4], [7, 8], [3, 8]], material: 'floor' });
    partialFloor.walls = partialFloor.rooms[0].polygon.map((start, index, points) => ({
      id: `wall_${index}`, start: [...start], end: [...points[(index + 1) % points.length]], thickness_m: .15,
    }));
    await load(partial); await selectRoom(); await change('Depth (m)', 3);
    assert.deepEqual(await project(), partial, 'A partial-edge neighbor prevents moving its shared wall');
    assert.equal(await field('Depth (m)').getAttribute('aria-invalid'), 'true');
    await change('Depth (m)', 4);
    const nearby = clone(partial);
    nearby.floors[0].rooms[1].polygon = [[3, 4.01], [7, 4.01], [7, 8.01], [3, 8.01]];
    await load(nearby); await selectRoom(); await change('Depth (m)', 3);
    assert.deepEqual((await project()).floors[0].rooms[0].polygon, [[0, 0], [10, 0], [10, 3], [0, 3]], 'A nearby unconnected room does not block resizing');
    assert.deepEqual((await project()).floors[0].rooms[1], nearby.floors[0].rooms[1], 'The nearby room remains unchanged');

    const tooNarrow = clone(outlinedFixture); tooNarrow.floors[0].items = [];
    await load(tooNarrow); await selectRoom(); await change('Width (m)', 1);
    assert.deepEqual(await project(), tooNarrow, 'An opening wider than the new wall rejects the whole room resize');
    assert.equal(await field('Width (m)').getAttribute('aria-invalid'), 'true');
    await change('Width (m)', 6);
    const concave = clone(fixture);
    concave.floors[0].rooms[0].polygon = [[1, 2], [7, 2], [7, 4], [4, 4], [4, 7], [1, 7]];
    await load(concave); await selectRoom(); await change('Width (m)', 7.2);
    assert.deepEqual((await project()).floors[0].rooms[0].polygon, [[1, 2], [8.2, 2], [8.2, 4], [4.6, 4], [4.6, 7], [1, 7]], 'Dimension changes preserve a concave room shape');

    await load(fixture); await selectItem();
    await change('y (m)', 2.3);
    assert.equal((await item()).position_m.y, 2.3, 'Elevation is measured from this floor, including elevated floors');
    const ceiling = await project(); await change('y (m)', 2.31);
    assert.equal(await field('y (m)').getAttribute('aria-invalid'), 'true');
    assert.deepEqual(await project(), ceiling, 'The complete item must remain below the ceiling');
    await change('y (m)', .4);
    await page.locator('#preview-tab').click();
    await page.waitForFunction(() => planner.getPreviewMetadata().renderCount > 0);
    await page.locator('#preview-edit').click();
    assert.equal(await page.locator('#snap').isVisible(), true, 'Snap remains available in 3D editing');
    assert.equal(await page.locator('#preview-edit').getAttribute('aria-pressed'), 'true');

    // Build an independent camera from public view metadata. The ray/plane
    // calculation predicts real mouse movement without calling editor handlers.
    const previewDrag = async ({ alt = false, cancel = false, dx = 35, dy = 12 } = {}) => {
      const geometry = await page.evaluate(async ({ dx, dy }) => {
        const THREE = await import('/vendor/three.module.min.js');
        const state = planner.getPreviewMetadata().camera, canvas = document.getElementById('preview-canvas'), rect = canvas.getBoundingClientRect();
        const floor = planner.getProject().floors[0], item = floor.items[0], position = item.position_m;
        const camera = new THREE.PerspectiveCamera(40, rect.width / rect.height, .02, 1500), horizontal = Math.cos(state.pitch) * state.radius;
        camera.position.set(state.target.x + Math.cos(state.yaw) * horizontal, state.target.y + Math.sin(state.pitch) * state.radius, state.target.z + Math.sin(state.yaw) * horizontal);
        camera.lookAt(new THREE.Vector3(state.target.x, state.target.y, state.target.z)); camera.updateMatrixWorld();
        const projected = new THREE.Vector3(position.x, floor.elevation_m + position.y + item.dimensions_m.height / 2, position.z).project(camera);
        const start = { x: rect.x + (projected.x + 1) * rect.width / 2, y: rect.y + (1 - projected.y) * rect.height / 2 };
        const end = { x: start.x + dx, y: start.y + dy };
        const rayAt = point => { const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2((point.x - rect.x) / rect.width * 2 - 1, 1 - (point.y - rect.y) / rect.height * 2), camera); return ray.ray; };
        const halfWidth = item.dimensions_m.width / 2, halfDepth = item.dimensions_m.depth / 2, bottom = floor.elevation_m + position.y;
        const box = new THREE.Box3(new THREE.Vector3(position.x - halfWidth, bottom, position.z - halfDepth), new THREE.Vector3(position.x + halfWidth, bottom + item.dimensions_m.height, position.z + halfDepth));
        const hit = rayAt(start).intersectBox(box, new THREE.Vector3());
        if (!hit) throw Error('The predicted pointer must intersect the visible item');
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -hit.y);
        const intersect = point => rayAt(point).intersectPlane(plane, new THREE.Vector3());
        const a = intersect(start), b = intersect(end);
        return { start, end, offset: { x: b.x - a.x, z: b.z - a.z } };
      }, { dx, dy });
      assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, geometry.start), 'preview-canvas');
      const before = await project(); if (alt) await page.keyboard.down('Alt');
      await page.mouse.move(geometry.start.x, geometry.start.y); await page.mouse.down();
      await page.mouse.move(geometry.end.x, geometry.end.y, { steps: 5 });
      const provisional = await project();
      if (cancel === 'Escape') await page.keyboard.press('Escape');
      if (cancel === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      if (cancel === 'pointercancel') await page.locator('#preview-canvas').dispatchEvent('pointercancel', { pointerId: await page.evaluate(() => window.__precisionPointerId) });
      await page.mouse.up(); if (alt) await page.keyboard.up('Alt');
      return { before, provisional, ...geometry };
    };
    let move = await previewDrag();
    let position = (await item()).position_m;
    close(position.x, Math.round((move.before.floors[0].items[0].position_m.x + move.offset.x) * 4) / 4, '3D snapped x', .001);
    close(position.z, Math.round((move.before.floors[0].items[0].position_m.z + move.offset.z) * 4) / 4, '3D snapped z', .001);
    assert.notDeepEqual(await project(), move.before, '3D canvas must move the item');
    await undoTo(move.before);
    move = await previewDrag({ alt: true }); position = (await item()).position_m;
    const beforePrecise3D = move.before;
    close(position.x, move.before.floors[0].items[0].position_m.x + move.offset.x, 'Alt 3D x');
    close(position.z, move.before.floors[0].items[0].position_m.z + move.offset.z, 'Alt 3D z');
    const moved = await project();
    for (const cancel of ['Escape', 'blur', 'pointercancel']) {
      move = await previewDrag({ cancel, dx: -32, dy: 18 });
      assert.notDeepEqual(move.provisional, moved); assert.deepEqual(await project(), moved, `${cancel} rolls back 3D item movement`);
    }
    await undoTo(beforePrecise3D);

    await selectItem();
    await page.getByRole('button', { name: 'Raise 5 cm', exact: true }).click();
    assert.equal((await item()).position_m.y, .45, 'Raise uses a 5 cm increment');
    await page.getByRole('button', { name: 'Lower 5 cm', exact: true }).click();
    assert.equal((await item()).position_m.y, .4, 'Lower uses a 5 cm increment');
    const handle = page.locator('#preview-elevation-handle');
    await handle.waitFor({ state: 'visible' });
    if (process.env.PLANNER_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.PLANNER_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.PLANNER_SCREENSHOT_DIR, `precision-height-${engine}.png`) });
    }
    await handle.focus(); await page.keyboard.press('ArrowUp');
    assert.equal((await item()).position_m.y, .45, 'Elevation handle supports keyboard input');
    await page.keyboard.press('ArrowDown');
    assert.equal((await item()).position_m.y, .4);
    const dragHeight = async ({ pixels = -35, alt = false, cancel = false } = {}) => {
      await selectItem(); await handle.waitFor({ state: 'visible' });
      const before = await project();
      const scale = await page.evaluate(() => {
        const camera = planner.getPreviewMetadata().camera, floor = planner.getProject().floors[0], position = floor.items[0].position_m;
        const horizontal = Math.cos(camera.pitch) * camera.radius;
        const cameraPosition = [camera.target.x + Math.cos(camera.yaw) * horizontal, camera.target.y + Math.sin(camera.pitch) * camera.radius, camera.target.z + Math.sin(camera.yaw) * horizontal];
        return 2 * Math.hypot(cameraPosition[0] - position.x, cameraPosition[1] - floor.elevation_m - position.y, cameraPosition[2] - position.z) * Math.tan(Math.PI / 9) / document.getElementById('preview-canvas').getBoundingClientRect().height;
      });
      const rect = await handle.boundingBox(); assert(rect && rect.width > 0, 'Height handle is rendered');
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      if (alt) await page.keyboard.down('Alt');
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x, y + pixels, { steps: 5 });
      const provisional = await project();
      if (cancel) await page.keyboard.press('Escape');
      await page.mouse.up(); if (alt) await page.keyboard.up('Alt');
      return { before, provisional, delta: -pixels * scale };
    };
    let raised = await dragHeight();
    close((await item()).position_m.y, Math.round((.4 + raised.delta) * 4) / 4, 'Height handle snaps its resulting elevation', .001);
    await undoTo(raised.before);
    raised = await dragHeight({ alt: true });
    close((await item()).position_m.y, .4 + raised.delta, 'Alt height follows the unsnapped pointer');
    const raisedProject = await project();
    const cancelledHeight = await dragHeight({ pixels: 25, cancel: true });
    assert.notDeepEqual(cancelledHeight.provisional, raisedProject);
    assert.deepEqual(await project(), raisedProject, 'Cancelled height never leaves a ghost coordinate');
    await undoTo(raised.before);
    await selectItem(); await change('y (m)', 2.2);
    await dragHeight({ pixels: -80 });
    assert.equal((await item()).position_m.y, 2.3, 'Height drag clamps the top of the item to the ceiling');
    assert.equal(await page.getByRole('button', { name: 'Raise 5 cm', exact: true }).isDisabled(), true);
    await change('y (m)', .1);
    await dragHeight({ pixels: 80 });
    assert.equal((await item()).position_m.y, 0, 'Height drag clamps to the current floor');
    assert.equal(await page.getByRole('button', { name: 'Lower 5 cm', exact: true }).isDisabled(), true);
    await saved();
    assert.deepEqual(errors, [], 'No page errors'); assert.deepEqual(external, [], 'Fictional tests must not contact external services');
    await context.close();
    console.log(`Planner precision passed (${engine}): 2D/3D snap and Alt movement, numeric and corner room dimensions, wall/opening consistency, shared-wall rejection, elevation bounds, cancellation, Undo/redo and persisted coordinates.`);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
