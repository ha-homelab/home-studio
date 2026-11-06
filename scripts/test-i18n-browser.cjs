// Exercise localized UI in real browsers, without live Home Assistant or a real home.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const load = file => import(pathToFileURL(path.join(root, file)).href);
const served = new Map([
  ...['pbr-color-data.js','pbr-materials.js','material-textures.js','environment-lighting.js','camera-tour.js','camera-tour-panel.js','camera-tour-session.js','camera-tour-recording.js'].map(name=>['/home-studio/'+name,[name,'text/javascript']]),
  ['/home-studio/planner/', ['planner/index.html', 'text/html']],
  ...['editor', 'model', 'documentation-model', 'site-model', 'site-editor', 'site-map-underlay', 'catalog', 'furniture', 'i18n', 'validation', 'language-links', 'render-capacity', 'interaction-render', 'environment', 'onboarding', 'device-onboarding', 'device-onboarding-ui', 'room-transform', 'draft-storage', 'inspector-dom', 'floor-navigator', 'ha-bridge', 'camera-tour-adapter'].map(name => [`/home-studio/planner/${name}.js`, [`planner/${name}.js`, 'text/javascript']]),
  ...fs.readdirSync(path.join(root, 'planner/locales')).filter(name => name.endsWith('.js')).map(name => [`/home-studio/planner/locales/${name}`, [`planner/locales/${name}`, 'text/javascript']]),
  ['/home-studio/camera-tour.css', ['camera-tour.css', 'text/css']],
  ['/home-studio/planner/editor.css', ['planner/editor.css', 'text/css']],
  ['/home-studio/planner/site-editor.css', ['planner/site-editor.css', 'text/css']],
  ['/home-studio/planner/floor-navigator.css', ['planner/floor-navigator.css', 'text/css']],
  ['/home-studio/vendor/three.module.min.js', ['vendor/three.module.min.js', 'text/javascript']],
]);

(async () => {
  const { LOCALES } = await load('planner/locales/index.js');
  const { LANGUAGE_STORAGE_KEY } = await load('planner/i18n.js');
  const server = http.createServer((request, response) => {
    const file = served.get(new URL(request.url, 'http://localhost').pathname);
    if (!file) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' });
    response.end(fs.readFileSync(path.join(root, file[0])));
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const url = origin + '/home-studio/planner/';
    // Use Chromium's full browser engine in headless mode, as in interactive use.
    browser = await chromium.launch({ headless: true, channel: 'chromium', executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
      args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const browserVersion = browser.version(), traces = new WeakMap();
    function watchPage(target, name) {
      const trace = { page: name, startedAt: new Date().toISOString(), startedMs: Date.now(), events: [], requests: [] };
      traces.set(target, trace);
      const localPath = value => { try { const parsed = new URL(value); return parsed.origin === origin ? served.has(parsed.pathname) ? parsed.pathname : '[unlisted]' : '[external]'; } catch { return '[unavailable]'; } };
      const add = (ledger, event) => {
        ledger.push({ ms: Date.now() - trace.startedMs, ...event });
        if (ledger.length > 48) ledger.shift();
      };
      for (const event of ['request', 'requestfinished', 'requestfailed']) target.on(event, request => {
        const pathname = localPath(request.url());
        if (pathname === '[external]' || pathname === '[unavailable]') return;
        add(trace.requests, { event, path: pathname, type: request.resourceType() });
      });
      target.on('pageerror', error => add(trace.events, { event: 'pageerror', name: /^[A-Za-z]+Error$/.test(error.name) ? error.name : 'Error' }));
      for (const event of ['crash', 'close', 'domcontentloaded', 'load']) target.on(event, () => add(trace.events, { event }));
      target.on('framenavigated', frame => add(trace.events, { event: 'framenavigated', main: frame === target.mainFrame(), path: localPath(frame.url()) }));
      target.on('dialog', dialog => add(trace.events, { event: 'dialog', type: dialog.type() }));
    }
    async function observed(target, operation, action) {
      const operationStartedMs = Date.now();
      try { return await action(); }
      catch (error) {
        // Diagnostics must not replace the original failure or wait on a hung renderer.
        try {
          const trace = traces.get(target);
          let timer;
          let state;
          try {
            state = await Promise.race([
              target.evaluate(() => {
                const safeLocale = value => typeof value === 'string' && /^[A-Za-z-]{1,16}$/.test(value) ? value : null;
                let savedLanguage = null;
                try { savedLanguage = safeLocale(localStorage.getItem('home-studio.language.v1')); } catch { /* Storage can be denied. */ }
                const view = window.planner?.getView();
                return { readyState: document.readyState, lang: safeLocale(document.documentElement.lang),
                  plannerReady: !!window.planner, savedLanguage, view: ['plan', 'preview', 'split'].includes(view) ? view : null };
              }).catch(() => ({ probe: 'unavailable' })),
              new Promise(resolve => { timer = setTimeout(() => resolve({ probe: 'timeout' }), 1000); }),
            ]);
          } finally { clearTimeout(timer); }
          console.error('I18N_NAVIGATION_DIAGNOSTIC ' + JSON.stringify({ operation, browserVersion,
            at: new Date().toISOString(), page: trace.page, startedAt: trace.startedAt,
            elapsedMs: Date.now() - trace.startedMs, operationElapsedMs: Date.now() - operationStartedMs,
            closed: target.isClosed(), state,
            events: trace.events, requests: trace.requests }));
        } catch { /* Preserve the original navigation or language assertion failure. */ }
        throw error;
      }
    }
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(), errors = [], requests = [];
    watchPage(page, 'main');
    page.on('pageerror', error => errors.push(String(error)));
    page.on('request', request => requests.push(request.url()));
    page.on('dialog', dialog => dialog.accept());
    await observed(page, 'initial-goto', () => page.goto(url));
    await page.waitForFunction(count => document.querySelectorAll('#language-select option').length === count, LOCALES.length);
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    assert.deepEqual(requests.filter(request => /\/locales\//.test(request)).map(request => request.split('/').at(-1)).sort(), ['en.js', 'index.js']);
    assert(requests.every(request => request.startsWith(origin + '/')), 'no external translation or font service');

    const change = async code => {
      await page.locator('#language-select').selectOption(code);
      await observed(page, 'language-change', () => page.waitForFunction(expected => document.documentElement.lang === expected && new URL(location.href).searchParams.get('lang') === expected, code));
    };
    await page.locator('#inspector-body').getByLabel('Width (m)', { exact: true }).fill('8.75');
    await change('ru');
    const ru = (await load('planner/locales/ru.js')).default;
    assert.equal(await page.locator('#inspector-body').getByLabel(ru['Width (m)'], { exact: true }).inputValue(), '8.75', 'unfinished room dimensions survive language switch');

    const fixture = JSON.parse(fs.readFileSync(path.join(root, 'planner/guide-assets/pattern-studio.json'), 'utf8'));
    fixture.title = 'Untouched title <b>غرفة</b>';
    fixture.floors[0].name = 'Keep my floor — 名';
    fixture.floors[0].rooms[0].name = 'Room'; // Exactly an English message key, still user content.
    fixture.floors[0].items = [fixture.floors[0].items[0]];
    fixture.floors[0].items[0].name = 'Color palette';
    fixture.floors[0].items[0].notes = '<b>Not markup</b> — لا تغيّر';
    fixture.floors[0].items[0].entity_id = 'light.fictional_test';
    await page.locator('#file-input').setInputFiles({ name: 'fictional.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
    await page.waitForFunction(expected => JSON.stringify(window.planner.getProject()) === expected, JSON.stringify(fixture));
    await page.locator('#object-list button').filter({ hasText: 'Color palette' }).click();
    const before = await page.evaluate(() => JSON.stringify(window.planner.getProject()));
    const selection = await page.evaluate(() => window.planner.getSelection());
    const undoBefore = await page.locator('#undo').isEnabled();
    const matrices = [];
    for (const locale of LOCALES) {
      await change(locale.code);
      const messages = (await load(`planner/locales/${locale.code}.js`)).default;
      assert.equal(await page.locator('html').getAttribute('dir'), locale.dir || 'ltr');
      assert.equal(await page.locator('#new-project').innerText(), messages['New project']);
      assert.equal(await page.locator('#project-title').inputValue(), fixture.title);
      assert.equal(await page.getByLabel(messages['Item name'], { exact: true }).inputValue(), 'Color palette');
      assert.equal(await page.getByLabel(messages['Notes'], { exact: true }).inputValue(), fixture.floors[0].items[0].notes);
      assert.equal(await page.getByLabel(messages['Entity ID (optional)'], { exact: true }).inputValue(), 'light.fictional_test');
      assert(await page.getByLabel(messages['Surface pattern'], { exact: true }).isVisible());
      assert.equal(await page.evaluate(() => JSON.stringify(window.planner.getProject())), before);
      assert.deepEqual(await page.evaluate(() => window.planner.getSelection()), selection);
      assert.equal(await page.locator('#undo').isEnabled(), undoBefore);
      await page.locator('#browse-items').click();
      await page.locator('#library-search').fill(messages['model.sofa_2']);
      const sofa = page.locator('.library-card[data-model-id="sofa_2"]');
      assert(await sofa.isVisible(), `${locale.code}: localized search finds the same model`);
      assert.equal(await sofa.locator('strong').innerText(), messages['model.sofa_2']);
      await page.locator('#library-clear').click();
      assert.equal(await page.locator('.library-card').count(), 24);
      await page.locator('[data-close="library-dialog"]').click();
      matrices.push(locale.code);
    }
    await change('ar');
    const ar = (await load('planner/locales/ar.js')).default;
    assert.equal(await page.getByLabel(ar['Entity ID (optional)'], { exact: true }).evaluate(input => getComputedStyle(input).direction), 'ltr');
    await page.locator('#object-list button').filter({ hasText: /^▱Room$/ }).click();
    assert.equal(await page.getByLabel(ar['x, z coordinates (m)'], { exact: true }).evaluate(input => getComputedStyle(input).direction), 'ltr', 'coordinate pairs never inherit RTL');
    await page.locator('#object-list button').filter({ hasText: `${ar.window} · window` }).click();
    assert.deepEqual(await page.getByLabel(ar['Opening type'], { exact: true }).locator('option').allTextContents(), [ar.door, ar.window, ar.passage]);
    const head = page.getByLabel(ar['Head height (m)'], { exact: true });
    await head.fill('0.1'); await head.press('Tab');
    assert((await page.locator('#status').innerText()).includes(ar['Opening head must be at least 0.05 m above its sill.']), 'interactive validation uses the selected language');
    assert.equal(await page.evaluate(() => JSON.stringify(window.planner.getProject())), before, 'invalid localized edits do not change the project');
    await change('ru');
    assert((await page.locator('#status').innerText()).includes(ru['Opening head must be at least 0.05 m above its sill.']), 'existing validation guidance switches languages');
    await page.locator('#object-list button').filter({ hasText: 'Color palette' }).click();
    await change('ar');
    await page.locator('#preview-tab').click();
    await page.waitForFunction(() => window.planner.getView() === 'preview');
    assert.equal(await page.locator('#preview-canvas').evaluate(canvas => getComputedStyle(canvas).direction), 'ltr');
    assert.equal(await page.evaluate(() => JSON.stringify(window.planner.getProject())), before);
    if (process.env.PLANNER_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.PLANNER_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.PLANNER_SCREENSHOT_DIR, 'i18n-arabic.png') });
    }
    await change('ja');
    if (process.env.PLANNER_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.PLANNER_SCREENSHOT_DIR, 'i18n-japanese.png') });
    await change('ru');
    if (process.env.PLANNER_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.PLANNER_SCREENSHOT_DIR, 'i18n-russian.png') });
    await observed(page, 'preview-reload', () => page.reload());
    await observed(page, 'reloaded-language', () => page.waitForFunction(() => document.documentElement.lang === 'ru'));
    assert.equal(await page.evaluate(() => JSON.stringify(window.planner.getProject())), before);
    await observed(page, 'deep-link-goto', () => page.goto(url + '?lang=ja&from=guide#language'));
    await observed(page, 'deep-link-language', () => page.waitForFunction(() => document.documentElement.lang === 'ja'));
    assert.equal(await page.evaluate(key => localStorage.getItem(key), LANGUAGE_STORAGE_KEY), 'ru', 'deep links do not overwrite explicit saved preferences');
    await change('fr');
    assert.equal(new URL(page.url()).searchParams.get('from'), 'guide');
    assert.equal(new URL(page.url()).hash, '#language');
    assert.equal(await page.evaluate(() => JSON.stringify(window.planner.getProject())), before, 'manual language choice does not change the project');
    await observed(page, 'deep-link-reload', () => page.reload());
    await observed(page, 'manual-language-after-reload', () => page.waitForFunction(() => window.planner && document.documentElement.lang === 'fr'));
    assert.equal(await page.locator('#language-select').inputValue(), 'fr', 'manual choice replaces the previous deep-link language on reload');
    assert.equal(await page.evaluate(() => JSON.stringify(window.planner.getProject())), before, 'reloading the new language preserves the project');

    for (const code of ['ar', 'de', 'ja']) {
      await change(code);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('#browse-items').click();
      const geometry = await page.locator('#library-dialog').evaluate(dialog => ({ width: dialog.getBoundingClientRect().width, right: dialog.getBoundingClientRect().right, viewport: innerWidth }));
      assert(geometry.width <= geometry.viewport && geometry.right <= geometry.viewport + 1, `${code}: mobile dialog fits`);
      assert(await page.locator('[data-close="library-dialog"]').isVisible());
      if (process.env.PLANNER_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.PLANNER_SCREENSHOT_DIR, `i18n-mobile-${code}.png`) });
      await page.locator('[data-close="library-dialog"]').click();
    }
    assert.deepEqual(errors, []);
    await context.close();

    const failureContext = await browser.newContext({ locale: 'en-US' });
    const failurePage = await failureContext.newPage();
    watchPage(failurePage, 'failed-locale-download');
    await failurePage.route('**/locales/ar.js', route => route.abort());
    await observed(failurePage, 'failed-download-goto', () => failurePage.goto(url + '?lang=ar'));
    await observed(failurePage, 'failed-download-language', () => failurePage.waitForFunction(() => window.planner && document.querySelector('#language-select').value === 'en'));
    assert.match(await failurePage.locator('#status').innerText(), /Language could not be loaded/);
    assert(await failurePage.getByRole('button', { name: 'Add room', exact: true }).isEnabled());
    await failureContext.close();

    const privateContext = await browser.newContext({ locale: 'ru-RU' });
    await privateContext.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage denied'); } }));
    const privatePage = await privateContext.newPage();
    watchPage(privatePage, 'denied-storage');
    const privateErrors = [];
    privatePage.on('pageerror', error => privateErrors.push(String(error)));
    await observed(privatePage, 'denied-storage-goto', () => privatePage.goto(url));
    await observed(privatePage, 'denied-storage-language', () => privatePage.waitForFunction(() => window.planner && document.documentElement.lang === 'ru'));
    await privatePage.evaluate(() => { history.replaceState = () => { throw new DOMException('history denied', 'SecurityError'); }; });
    await privatePage.locator('#language-select').selectOption('fr');
    await observed(privatePage, 'denied-history-language', () => privatePage.waitForFunction(() => document.documentElement.lang === 'fr'));
    assert.deepEqual(privateErrors, [], 'denied history does not block a manual language choice');
    await privateContext.close();
    console.log(`Browser i18n checks passed: ${matrices.join(', ')}; lazy local packs, translated search, preserved drafts/forms, RTL, mobile, reload, deep links, failed downloads and denied storage.`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
