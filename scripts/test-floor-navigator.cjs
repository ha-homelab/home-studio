// Browser checks for the standalone SVG navigator, independent of editor wiring.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const artifacts = path.resolve(process.env.FLOOR_NAVIGATOR_ARTIFACTS || path.join(root, 'acceptance-artifacts', 'floor-navigator'));
const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/planner/floor-navigator.css"><style>
* { box-sizing: border-box; } body { margin: 0; font-family: system-ui, sans-serif; }
#surface { position: relative; height: 650px; background: repeating-linear-gradient(0deg, transparent, transparent 29px, #dfe5d9 30px), repeating-linear-gradient(90deg, #f2f4ed, #f2f4ed 29px, #dfe5d9 30px); }
</style></head><body><div id="surface"><div id="navigator"></div></div><script type="module">
import { createFloorNavigator } from '/planner/floor-navigator.js';
import { demoProject, newFloor, clone } from '/planner/model.js';
window.contextCalls = 0; HTMLCanvasElement.prototype.getContext = () => { contextCalls++; throw Error('Unexpected rendering context'); };
window.animationCalls = 0; window.requestAnimationFrame = () => { animationCalls++; throw Error('Unexpected animation loop'); };
window.fixtureModel = { demoProject, newFloor, clone };
window.project = demoProject();
const upstairs = clone(project.floors[0]); upstairs.id = 'upper'; upstairs.name = 'Upper floor'; upstairs.rooms.splice(2); upstairs.items.splice(0, 2);
project.floors.push(upstairs, newFloor('empty', 'Future studio', 6));
window.active = 'ground'; window.selections = [];
window.navigatorUI = createFloorNavigator({ container: document.getElementById('navigator'), onSelect(id) { active = id; selections.push(id); navigatorUI.update(project, id); } });
navigatorUI.update(project, active); window.ready = true;
</script></body></html>`;
const server = http.createServer((request, response) => {
  try {
    const route = new URL(request.url, 'http://localhost').pathname;
    if (route === '/') return response.writeHead(200, { 'Content-Type': 'text/html' }).end(fixture);
    const file = path.resolve(root, '.' + route);
    if (!file.startsWith(root + path.sep)) return response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': file.endsWith('.css') ? 'text/css' : 'text/javascript' }).end(fs.readFileSync(file));
  } catch { response.writeHead(404).end(); }
});

(async () => {
  let browser;
  const errors = [];
  try {
    fs.mkdirSync(artifacts, { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.ready);
    assert.equal(await page.locator('.floor-navigator__floor').count(), 3);
    assert.equal(await page.getByRole('button', { name: 'Switch to Ground floor' }).getAttribute('aria-current'), 'true');
    assert.equal(await page.locator('.floor-navigator__empty:visible').count(), 1);
    await page.screenshot({ path: path.join(artifacts, 'desktop.png') });

    const lifecycle = await page.evaluate(() => {
      const rail = document.getElementById('navigator');
      const button = rail.children[1], svg = button.querySelector('svg'), originalShape = svg.firstChild;
      button.focus();
      const original = JSON.stringify(project);
      for (let i = 0; i < 50; i++) navigatorUI.update(project, i % 2 ? 'upper' : 'ground');
      const stableSelection = svg.firstChild === originalShape && document.activeElement === button && JSON.stringify(project) === original;
      project.floors[1].name = '<img src=x onerror=alert(1)>';
      project.title = 'Metadata only'; project.floors[1].elevation_m = 10; project.floors[1].items[0].notes = 'New note';
      navigatorUI.update(project, 'upper');
      const stableMetadata = svg.firstChild === originalShape && document.activeElement === button && button.textContent.includes('<img');
      const injected = rail.querySelector('img');
      project.floors.reverse(); navigatorUI.update(project, 'upper');
      const stableOrder = rail.children[1] === button && svg.firstChild === originalShape && document.activeElement === button;
      const emptyShape = rail.children[0].querySelector('svg').firstChild;
      const upper = project.floors[1]; upper.rooms[0].polygon[0][0] = -1;
      navigatorUI.update(project, 'upper');
      const changedShape = svg.firstChild;
      const geometryUpdates = changedShape !== originalShape && rail.children[0].querySelector('svg').firstChild === emptyShape;
      navigatorUI.update(project, 'upper');
      const stableAfterGeometry = svg.firstChild === changedShape;
      project.floors.splice(1, 1); navigatorUI.update(project, 'ground');
      const removalFocus = document.activeElement.dataset.floorId === 'ground';
      return { stableSelection, stableMetadata, stableOrder, injected: !!injected, geometryUpdates, stableAfterGeometry, removalFocus };
    });
    assert.deepEqual(lifecycle, { stableSelection: true, stableMetadata: true, stableOrder: true, injected: false, geometryUpdates: true, stableAfterGeometry: true, removalFocus: true });

    await page.evaluate(() => {
      project.floors = Array.from({ length: 30 }, (_, i) => fixtureModel.newFloor(`floor_${i}`, `Floor ${i + 1}`));
      navigatorUI.update(project, 'floor_0');
    });
    await page.setViewportSize({ width: 390, height: 700 });
    const first = page.locator('.floor-navigator__floor').first();
    await first.focus(); await page.keyboard.press('End');
    assert.equal(await page.locator(':focus').getAttribute('data-floor-id'), 'floor_29');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => selections), ['floor_29']);
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('Space');
    assert.deepEqual(await page.evaluate(() => selections), ['floor_29', 'floor_28']);
    const scroll = await page.evaluate(() => {
      const rail = document.getElementById('navigator'), focus = document.activeElement;
      const a = rail.getBoundingClientRect(), b = focus.getBoundingClientRect();
      return { count: rail.children.length, top: rail.scrollTop, visible: b.top >= a.top && b.bottom <= a.bottom, noOverflow: document.documentElement.scrollWidth <= innerWidth, compact: a.width <= 90 };
    });
    assert.equal(scroll.count, 30); assert(scroll.top > 0); assert(scroll.visible); assert(scroll.noOverflow); assert(scroll.compact);
    await page.screenshot({ path: path.join(artifacts, 'phone-many-floors.png') });
    await page.keyboard.press('Home'); assert.equal(await page.locator(':focus').getAttribute('data-floor-id'), 'floor_0');

    const cleanup = await page.evaluate(() => {
      const rail = document.getElementById('navigator'), button = rail.firstChild, before = selections.length;
      navigatorUI.destroy(); navigatorUI.destroy(); button.click(); navigatorUI.update(project, 'floor_0');
      return { children: rail.children.length, role: rail.getAttribute('role'), classRemoved: !rail.classList.contains('floor-navigator'), released: selections.length === before, contextCalls, animationCalls };
    });
    assert.deepEqual(cleanup, { children: 0, role: null, classRemoved: true, released: true, contextCalls: 0, animationCalls: 0 });
    assert.deepEqual(errors, []);
    const report = { status: 'PASS', lifecycle, scroll, cleanup, artifacts };
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
