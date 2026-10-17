const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const playwright = require('playwright');
const { browserLaunchOptions } = require('./browser-stability-diagnostics.cjs');
const engine = process.env.ONBOARDING_ENGINE || 'chromium';
assert(['chromium', 'firefox', 'webkit'].includes(engine), 'Unsupported browser engine');

const root = path.resolve(__dirname, '..');
const storageKey = 'home-studio.project.v1';
const artifacts = path.join(process.env.ONBOARDING_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'home-studio-onboarding-')), engine);
fs.mkdirSync(artifacts, { recursive: true });
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.json': 'application/json' };
const server = http.createServer((request, response) => {
  let descriptor;
  try {
    const route = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\/home-studio\//, '');
    const file = path.resolve(root, route.endsWith('/') ? route + 'index.html' : route);
    if (!file.startsWith(root + path.sep)) return response.writeHead(404).end();
    descriptor = fs.openSync(file, 'r');
    if (!fs.fstatSync(descriptor).isFile()) return response.writeHead(404).end();
    const body = fs.readFileSync(descriptor);
    response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
});

(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`, url = `${origin}/home-studio/planner/`;
    browser = await playwright[engine].launch(browserLaunchOptions(engine, process.env.ONBOARDING_HEADED !== '1'));
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
    await context.addInitScript(() => {
      window.testWebGLContexts = 0;
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(kind, ...args) {
        if (/webgl/.test(kind)) window.testWebGLContexts++;
        return getContext.call(this, kind, ...args);
      };
    });
    const page = await context.newPage(), errors = [], requests = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('request', request => requests.push(request.url()));
    const project = () => page.evaluate(() => window.planner.getProject());
    const saved = () => page.evaluate(key => localStorage.getItem(key), storageKey);
    const ready = () => page.waitForFunction(() => !!window.planner);
    await page.goto(url); await ready();
    const blank = await project(), originalStorage = await saved();
    assert(!requests.some(request => /\/examples\//.test(request)), 'Example data is not loaded on startup');
    assert.equal(await page.evaluate(() => window.testWebGLContexts), 0, 'Startup does not initialize 3D');

    await page.locator('#start-room').click();
    assert.equal(await page.locator(':focus').getAttribute('id'), 'starter-name');
    await page.locator('#starter-name').fill('Measured living room');
    await page.locator('#starter-width').fill('0');
    await page.locator('#starter-create').click();
    assert.equal(await page.locator('#starter-width').getAttribute('aria-invalid'), 'true');
    assert.deepEqual(await project(), blank); assert.equal(await saved(), originalStorage);
    await page.keyboard.press('Escape');
    assert.deepEqual(await project(), blank, 'Cancel is side-effect free');
    await page.locator('#start-room').click();
    await page.locator('#starter-name').fill('Measured living room');
    await page.locator('#starter-width').fill('4.2');
    await page.locator('#starter-depth').fill('3.6');
    await page.locator('#starter-create').click();
    await page.waitForFunction(() => window.planner.getProject().floors[0].walls.length === 4);
    assert.deepEqual((await project()).floors[0].rooms[0].polygon, [[0, 0], [4.2, 0], [4.2, 3.6], [0, 3.6]]);
    await page.locator('#undo').click(); assert.deepEqual(await project(), blank, 'Room and walls undo together');
    await page.locator('#redo').click();
    await page.locator('#measured-room').click(); await page.locator('#starter-walls').uncheck();
    await page.locator('#starter-create').click();
    assert.equal((await project()).floors[0].rooms.length, 2);
    assert.equal((await project()).floors[0].walls.length, 4, 'No walls added when unchecked');
    await page.locator('#undo').click();
    const measured = await project();
    await page.locator('#measured-room').click();
    await page.locator('#starter-width').fill('100');
    await page.locator('#starter-create').click();
    assert(await page.locator('#room-starter').isVisible(), 'Out-of-bounds room remains available to correct');
    assert((await page.locator('#starter-error').innerText()).length > 0);
    assert.deepEqual(await project(), measured, 'Failed geometry leaves the project unchanged');
    await page.keyboard.press('Escape');

    // Complete the first-room journey through the normal drawing controls.
    await page.locator('[data-tool="door"]').click();
    const [x, y] = await page.evaluate(() => window.planner.worldToScreen([2.1, 0]));
    const canvas = await page.locator('#plan-canvas').boundingBox();
    await page.mouse.click(canvas.x + x, canvas.y + y);
    assert.equal((await project()).floors[0].openings.length, 1);
    await page.locator('button[title="room: Measured living room"]').click();
    await page.getByRole('button', { name: 'Place item at room center', exact: true }).click();
    assert.equal((await project()).floors[0].items.length, 1);
    await page.locator('#preview-tab').click();
    await page.waitForFunction(() => window.planner.getPreviewMetadata().renderCount > 0);
    const downloadEvent = page.waitForEvent('download');
    await page.locator('#export-project').click();
    const download = await downloadEvent;
    const completed = await project();
    assert.deepEqual(JSON.parse(fs.readFileSync(await download.path())), completed, 'Export preserves measured room, walls, opening and item');
    await page.locator('#plan-tab').click();

    await page.locator('#browse-examples').click();
    assert.equal(await page.locator('.example-card').count(), 4);
    assert(!requests.some(request => /\/examples\//.test(request)), 'Opening gallery loads thumbnails only');
    await page.waitForFunction(() => [...document.querySelectorAll('.example-card img')].every(image => image.complete && image.naturalWidth > 0));
    await page.screenshot({ path: path.join(artifacts, 'examples-desktop.png') });
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('[data-example="practice"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-example="practice"]').disabled);
    assert.deepEqual(await project(), completed, 'Declining replacement preserves project');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-example="practice"]').click();
    await page.waitForFunction(() => window.planner.getView() === 'preview');
    const practice = JSON.parse(fs.readFileSync(path.join(root, 'planner/guide-assets/practice-home.json')));
    assert.deepEqual(await project(), practice);
    assert.equal(requests.filter(request => /\/examples\//.test(request)).length, 1, 'Only selected example loaded');
    await page.locator('#undo').click(); assert.deepEqual(await project(), completed, 'Example replacement is undoable');

    // Closing a gallery while its selected module is in flight cancels replacement.
    let pendingRoute;
    const pendingImport = new Promise(resolve => { pendingRoute = resolve; });
    await page.route('**/examples/decor.js', route => pendingRoute(route));
    await page.locator('#browse-examples').click();
    await page.locator('[data-example="decor"]').click();
    const route = await pendingImport;
    await page.locator('[data-close="examples-dialog"]').click();
    const responseEvent = page.waitForResponse(response => response.url().endsWith('/examples/decor.js'));
    await route.continue(); await (await responseEvent).finished();
    assert.deepEqual(await project(), completed, 'Canceled async example leaves project unchanged');
    await page.unroute('**/examples/decor.js');
    await page.route('**/examples/patterns.js', route => route.abort());
    await page.locator('#browse-examples').click();
    await page.locator('[data-example="patterns"]').click();
    await page.waitForFunction(() => document.querySelector('#examples-status').textContent.startsWith('Could not'));
    assert.deepEqual(await project(), completed, 'Failed async example leaves project unchanged');
    await page.keyboard.press('Escape');

    // A direct launch consumes its query, so refreshing retains later edits.
    page.once('dialog', dialog => dialog.accept());
    await page.goto(url + '?example=practice'); await ready();
    await page.waitForFunction(() => window.planner.getView() === 'preview');
    assert.equal(new URL(page.url()).searchParams.get('example'), null);
    await page.locator('#project-title').fill('My continued example');
    await page.locator('#project-title').press('Tab');
    await page.waitForFunction(key => JSON.parse(localStorage.getItem(key)).title === 'My continued example', storageKey);
    await page.reload(); await ready();
    assert.equal((await project()).title, 'My continued example');
    const beforeInvalid = await project(), requestCount = requests.filter(request => /\/examples\//.test(request)).length;
    await page.goto(url + '?example=https%3A%2F%2Fexample.invalid%2Ffile.js'); await ready();
    assert.deepEqual(await project(), beforeInvalid);
    assert.equal(requests.filter(request => /\/examples\//.test(request)).length, requestCount);
    // Each direct example must finish a real render and leave the editor usable.
    for (const [example, fixture] of [['practice', 'practice-home'], ['decor', 'decor-studio'],
      ['patterns', 'pattern-studio'], ['garage', 'garage-and-studio']]) {
      const cleanContext = await browser.newContext({ locale: 'en-US' });
      const cleanPage = await cleanContext.newPage();
      let unexpectedConfirmation = false;
      cleanPage.on('pageerror', error => errors.push(`${example}: ${error}`));
      cleanPage.on('dialog', dialog => { unexpectedConfirmation = true; void dialog.dismiss(); });
      await cleanPage.goto(url + '?example=' + example);
      await cleanPage.waitForFunction(() => window.planner?.getView() === 'preview' &&
        window.planner.getPreviewMetadata().renderCount > 0, null, { timeout: 20000 });
      assert.equal(unexpectedConfirmation, false, `${example}: clean launch needs no replacement confirmation`);
      const expected = JSON.parse(fs.readFileSync(path.join(root, `planner/guide-assets/${fixture}.json`)));
      assert.deepEqual(await cleanPage.evaluate(() => window.planner.getProject()), expected);
      const metadata = await cleanPage.evaluate(() => window.planner.getPreviewMetadata());
      assert.equal(metadata.error, undefined, `${example}: preview has no rendering error`);
      assert.equal(metadata.items, expected.floors[0].items.length, `${example}: preview includes every item`);
      await cleanPage.locator('#plan-tab').click({ timeout: 5000 });
      assert.equal(await cleanPage.evaluate(() => window.planner.getView()), 'plan', `${example}: 2D control responds after rendering`);
      await cleanContext.close();
    }

    // Model a replacement waiting for the draft lock, without changing the real
    // editor's storage implementation. Accepted commits cannot be canceled halfway.
    const heldContext = await browser.newContext({ locale: 'en-US' });
    await heldContext.addInitScript(() => {
      window.testCommitGate = new Promise(resolve => { window.releaseTestCommit = resolve; });
    });
    await heldContext.route('**/onboarding.js', async route => {
      const response = await route.fetch(), body = await response.text();
      const marker = 'const replaced = await replaceProject(';
      assert(body.includes(marker));
      await route.fulfill({ response, body: body.replace(marker, 'await window.testCommitGate; ' + marker) });
    });
    const heldPage = await heldContext.newPage();
    await heldPage.goto(url + '?example=practice');
    await heldPage.waitForFunction(() => document.querySelector('#examples-dialog [data-close]').disabled);
    await heldPage.keyboard.press('Escape');
    assert(await heldPage.locator('#examples-dialog').isVisible());
    assert.equal((await heldPage.evaluate(() => window.planner.getProject())).floors[0].rooms.length, 0);
    await heldPage.evaluate(() => window.releaseTestCommit());
    await heldPage.waitForFunction(() => window.planner.getView() === 'preview');
    assert.deepEqual(await heldPage.evaluate(() => window.planner.getProject()), practice);
    await heldContext.close();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#language-select').selectOption('ar');
    await page.waitForFunction(() => document.documentElement.dir === 'rtl');
    await page.locator('#measured-room').click();
    await page.locator('#starter-name').fill('A name kept while changing language');
    await page.screenshot({ path: path.join(artifacts, 'starter-rtl-mobile.png') });
    const box = await page.locator('#room-starter').boundingBox();
    assert(box.x >= 0 && box.x + box.width <= 391, 'Starter fits narrow RTL viewport');
    assert.notEqual(await page.locator('#starter-title').innerText(), 'Create a room');
    await page.keyboard.press('Escape');
    await page.locator('#browse-examples').click();
    await page.waitForFunction(() => document.querySelector('.example-card img')?.naturalWidth > 0);
    await page.screenshot({ path: path.join(artifacts, 'examples-rtl-mobile.png') });
    const galleryBox = await page.locator('#examples-dialog').boundingBox();
    assert(galleryBox.x >= 0 && galleryBox.x + galleryBox.width <= 391, 'Gallery fits narrow RTL viewport');
    assert(requests.every(request => request.startsWith(origin + '/') || request.startsWith('data:')), 'No external requests');
    assert.deepEqual(errors, []);
    console.log(`Onboarding browser checks passed. Screenshots: ${artifacts}`);
  } finally {
    await browser?.close(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
