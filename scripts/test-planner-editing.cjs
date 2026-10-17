// Real browser regression checks use temporary origins and fictional drafts only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const playwright = require('playwright');
const engine = process.env.PLANNER_EDITING_ENGINE || 'chromium';
assert(['chromium', 'firefox', 'webkit'].includes(engine), 'Unsupported browser engine');
const root = path.resolve(__dirname, '..');
const KEY = 'home-studio.project.v1';
const PREVIOUS = 'home-studio.previous-project.v1';
const DAMAGED = 'home-studio.damaged-project.v1';

(async () => {
  const server = http.createServer((request, response) => {
    const route = new URL(request.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + route, route.endsWith('/') ? 'index.html' : '');
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    try {
      response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      response.end(fs.readFileSync(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined } : {}) });
    const url = `http://127.0.0.1:${server.address().port}/planner/`;
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    context.on('page', page => { page.on('pageerror', error => errors.push(String(error))); page.on('dialog', dialog => dialog.accept()); });
    const page = await context.newPage();
    const open = async target => { await target.goto(url); await target.waitForFunction(() => window.planner); };
    const project = target => target.evaluate(() => window.planner.getProject());
    const saved = async target => target.waitForFunction(key => localStorage.getItem(key) === JSON.stringify(window.planner.getProject()), KEY);
    const field = label => page.locator('#inspector-body').getByLabel(label, { exact: true });
    const change = async (label, value) => { await field(label).fill(value); await field(label).press('Tab'); };
    const title = async (target, value) => { await target.locator('#project-title').fill(value); await target.locator('#project-title').press('Tab'); };
    await open(page);

    // Both the real node and native navigation survive each property update.
    await field('Width (m)').fill('8.75');
    await change('Floor name', 'Measured floor');
    assert.equal(await page.locator(':focus').getAttribute('aria-label'), 'Elevation (m)');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator(':focus').getAttribute('aria-label'), 'Floor name');
    assert.equal(await field('Width (m)').inputValue(), '8.75');
    await page.locator('#language-select').selectOption('ru');
    await page.waitForFunction(() => document.documentElement.lang === 'ru');
    await page.locator('#language-select').selectOption('en');
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    await change('Floor name', 'Still measured');
    assert.equal(await field('Width (m)').inputValue(), '8.75', 'language changes preserve dirty sibling fields');
    await page.getByRole('button', { name: 'Add room', exact: true }).click();
    assert.equal((await project(page)).floors[0].rooms[0].polygon[1][0], 8.75, 'the retained form controls supply button values');
    await page.getByRole('button', { name: 'Build wall outline', exact: true }).click();
    await page.getByRole('button', { name: 'Place item at room center', exact: true }).click();
    await field('Width (m)').fill('2'); await field('Depth (m)').click();
    assert.equal(await page.locator(':focus').getAttribute('aria-label'), 'Depth (m)');
    assert.equal((await project(page)).floors[0].items[0].dimensions_m.width, 2);
    const valid = await project(page);
    await change('Height (m)', '-1');
    assert.equal(await field('Height (m)').inputValue(), '-1');
    assert.equal(await field('Height (m)').getAttribute('aria-invalid'), 'true');
    assert.deepEqual(await project(page), valid, 'invalid dimensions never enter project/history/storage');
    await change('Height (m)', '1');
    assert.equal(await field('Height (m)').getAttribute('aria-invalid'), null);
    await field('Item name').fill('Named chair'); await page.locator('#floor-list button').click();
    assert.equal(await field('Floor name').count(), 1, 'a blur-triggered refresh preserves the next clicked navigation button');
    await saved(page);

    // A replacement remains recoverable across reload, and Undo saves the
    // document that is actually visible after restoration.
    const furnished = await project(page);
    await page.locator('#new-project').click();
    await page.waitForFunction(() => window.planner.getProject().floors[0].rooms.length === 0);
    await page.reload(); await page.waitForFunction(() => window.planner);
    await page.locator('#draft-recovery').click(); await page.locator('#recovery-restore').click();
    await page.waitForFunction(() => window.planner.getProject().floors[0].items.length === 1);
    assert.deepEqual(await project(page), furnished); await saved(page);
    await page.locator('#undo').click(); await saved(page);
    assert.equal((await project(page)).floors[0].rooms.length, 0);
    await page.locator('#redo').click(); await saved(page);

    // A stale tab cannot silently erase another tab's edit.
    const second = await context.newPage(); await open(second);
    await title(page, 'First tab latest'); await saved(page);
    await second.waitForFunction(() => document.getElementById('save-status').textContent.includes('Autosave paused'));
    await title(second, 'Second tab unsaved');
    assert.equal(await second.evaluate(key => JSON.parse(localStorage.getItem(key)).title, KEY), 'First tab latest');
    assert.equal((await project(second)).title, 'Second tab unsaved');
    await second.locator('#draft-recovery').click();
    const downloadEvent = second.waitForEvent('download'); await second.locator('#recovery-export').click();
    const download = await downloadEvent;
    assert.equal(JSON.parse(fs.readFileSync(await download.path(), 'utf8')).title, 'Second tab unsaved');
    await second.locator('#recovery-load').click();
    await second.waitForFunction(() => window.planner.getProject().title === 'First tab latest');
    assert.equal(await second.evaluate(key => JSON.parse(localStorage.getItem(key)).title, PREVIOUS), 'Second tab unsaved');
    await saved(second); await page.close();

    // Once a recovery commit starts, the dialog cannot be dismissed to race a
    // new edit against the pending origin-wide lock.
    await second.evaluate(() => {
      window.releaseDraftLock = null;
      navigator.locks.request('home-studio.draft-writer.v1', () => new Promise(resolve => { window.releaseDraftLock = resolve; }));
    });
    await second.waitForFunction(() => window.releaseDraftLock);
    await second.locator('#draft-recovery').click(); await second.locator('#recovery-restore').click();
    await second.keyboard.press('Escape');
    assert.equal(await second.locator('#recovery-dialog').evaluate(element => element.open), true);
    assert.equal(await second.locator('[data-close="recovery-dialog"]').isDisabled(), true);
    await second.evaluate(() => window.releaseDraftLock());
    await second.waitForFunction(() => !document.getElementById('recovery-dialog').open);
    assert.equal((await project(second)).title, 'Second tab unsaved'); await saved(second);

    // Damaged bytes survive normal editing and an explicit replacement.
    const damaged = '{"title":"Keep the original damaged bytes"';
    await second.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: KEY, value: damaged });
    await second.reload(); await second.waitForFunction(() => window.planner);
    await second.getByRole('button', { name: 'Add room', exact: true }).click();
    assert.equal(await second.evaluate(key => localStorage.getItem(key), KEY), damaged);
    await second.locator('#draft-recovery').click();
    const originalEvent = second.waitForEvent('download'); await second.locator('#recovery-original').click();
    assert.equal(fs.readFileSync(await (await originalEvent).path(), 'utf8'), damaged);
    await second.locator('#recovery-replace').click(); await saved(second);
    assert.equal(await second.evaluate(key => localStorage.getItem(key), DAMAGED), damaged);
    await second.reload(); await second.waitForFunction(() => window.planner);
    await second.setViewportSize({ width: 390, height: 844 });
    assert.equal(await second.locator('#draft-recovery').isVisible(), true, 'recovery stays reachable in a narrow layout');
    await second.locator('#draft-recovery').click(); assert.equal(await second.locator('#recovery-original').isEnabled(), true);
    if (process.env.PLANNER_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.PLANNER_SCREENSHOT_DIR, { recursive: true });
      await second.screenshot({ path: path.join(process.env.PLANNER_SCREENSHOT_DIR, 'draft-recovery-mobile.png') });
      await second.setViewportSize({ width: 1440, height: 1000 });
      await second.screenshot({ path: path.join(process.env.PLANNER_SCREENSHOT_DIR, 'draft-recovery-desktop.png') });
    }
    await second.locator('[data-close="recovery-dialog"]').click();
    assert.deepEqual(errors, []);
    await context.close();

    // Missing Web Locks leaves editing/export usable. Replacement needs an
    // explicit acknowledgement that this copy only lives in the current tab.
    const limited = await browser.newContext();
    await limited.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
    const offline = await limited.newPage(); const prompts = [];
    offline.on('dialog', dialog => { prompts.push(dialog.message()); dialog.accept(); });
    await open(offline);
    await offline.getByRole('button', { name: 'Add room', exact: true }).click();
    await offline.waitForFunction(() => document.getElementById('save-status').textContent.includes('Autosave unavailable'));
    await offline.locator('#new-project').click();
    await offline.waitForFunction(() => window.planner.getProject().floors[0].rooms.length === 0);
    assert(prompts.some(message => message.includes('Continue in this tab without saving')));
    assert.equal(await offline.evaluate(key => localStorage.getItem(key), KEY), null);
    const exportEvent = offline.waitForEvent('download'); await offline.locator('#export-project').click();
    assert.equal((await exportEvent).suggestedFilename(), 'project.json');
    await limited.close();

    const quotaContext = await browser.newContext(); const quotaPage = await quotaContext.newPage();
    await open(quotaPage);
    await quotaPage.evaluate(key => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name, value) {
        if (name === key) throw new DOMException('Quota exceeded', 'QuotaExceededError');
        return original.call(this, name, value);
      };
    }, KEY);
    await title(quotaPage, 'Quota failure');
    await quotaPage.waitForFunction(() => document.getElementById('save-status').textContent.includes('Autosave unavailable'));
    await title(quotaPage, 'Keep editing after quota failure');
    await quotaPage.waitForFunction(() => document.getElementById('status').textContent === 'Autosave unavailable · export a backup');
    await quotaContext.close();
    console.log('Planner editing checks passed: keyboard/click focus, unfinished values, invalid input, reload recovery, two-tab conflicts, pending recovery lock, raw downloads and export-only fallback.');
  } finally {
    await browser?.close(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
