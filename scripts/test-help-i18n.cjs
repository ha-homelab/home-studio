// Test the shipped website allowlist and cross-page language journey, not live HA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const load = name => import(pathToFileURL(path.join(root, name)).href);

(async () => {
  const { LOCALES } = await load('planner/locales/index.js');
  const { HELP_MESSAGES } = await load('planner/help-locales.js');
  const canonical = Object.keys(HELP_MESSAGES.en).sort();
  assert.deepEqual(Object.keys(HELP_MESSAGES).sort(), LOCALES.map(row => row.code).sort());
  for (const { code } of LOCALES) {
    assert.deepEqual(Object.keys(HELP_MESSAGES[code]).sort(), canonical, code);
    for (const key of canonical) {
      const text = HELP_MESSAGES[code][key];
      assert.equal(typeof text, 'string'); assert(text.trim());
      for (const literal of HELP_MESSAGES.en[key].match(/home_floorplan: \{\}|\/path\/to\/ha\/config|configuration\.yaml|--dry-run/g) || []) {
        assert(text.includes(literal), `${code}.${key} preserves ${literal}`);
      }
    }
  }
  const listed = spawnSync(process.env.PYTHON || 'python3', ['-c',
    'import runpy,json; print(json.dumps(runpy.run_path("scripts/validate-site.py")["SITE_FILES"]))'], { cwd: root, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const publicFiles = new Set(JSON.parse(listed.stdout));
  const server = http.createServer((request, response) => {
    let file = new URL(request.url, 'http://localhost').pathname.replace(/^\/home-studio\//, '');
    if (file.endsWith('/')) file += 'index.html';
    if (!publicFiles.has(file)) return response.writeHead(404).end();
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' }[path.extname(file)] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(fs.readFileSync(path.join(root, file)));
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`, base = origin + '/home-studio/';
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
      args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage(), errors = [], requests = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('request', request => requests.push(request.url()));
    await page.goto(base + 'install.html?lang=ru');
    await page.locator('#help-language').waitFor();
    const englishText = await page.locator('main').textContent();
    const commands = await page.locator('#quick-route [data-command]').allTextContents();
    assert.equal(commands.length, 5);
    assert(commands.includes('home_floorplan: {}'));
    assert(commands.some(text => text.endsWith('--dry-run')));
    for (const locale of LOCALES) {
      await page.locator('#help-language').selectOption(locale.code);
      await page.waitForFunction(code => document.documentElement.lang === code, locale.code);
      assert.equal(await page.locator('#quick-route').getAttribute('dir'), locale.dir || 'ltr');
      assert.equal(await page.locator('#quick-route .eyebrow').textContent(), HELP_MESSAGES[locale.code].quick);
      assert.deepEqual(await page.locator('#quick-route [data-command]').allTextContents(), commands);
      assert.equal(await page.locator('main').textContent(), englishText, 'full English reference stays intact');
      assert.equal(await page.locator('main').getAttribute('lang'), 'en');
      assert.equal(await page.locator('#quick-route pre').first().evaluate(node => getComputedStyle(node).direction), 'ltr');
      const editor = await page.locator('#quick-route nav a').first().getAttribute('href');
      assert.equal(new URL(editor, base).searchParams.get('lang'), locale.code);
    }
    for (const code of ['ar', 'de', 'ja']) {
      await page.locator('#help-language').selectOption(code);
      await page.waitForFunction(code => document.documentElement.lang === code, code);
      await page.setViewportSize({ width: 390, height: 844 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${code}: no page overflow`);
      if (process.env.PLANNER_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.PLANNER_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.PLANNER_SCREENSHOT_DIR, `help-mobile-${code}.png`) });
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(base + 'planner/guide.html?lang=ru#door');
    await page.locator('#help-language').waitFor();
    assert.equal(await page.locator('#quick-route .quick-step').count(), 5);
    await page.locator('#help-language').selectOption('de');
    await page.waitForFunction(() => new URL(location.href).searchParams.get('lang') === 'de');
    assert.equal(new URL(page.url()).hash, '#door');
    await page.reload();
    await page.waitForFunction(() => document.documentElement.lang === 'de');
    await page.goto(base + 'planner/publishing.html?lang=ru');
    await page.locator('#help-language').waitFor();
    assert.equal(await page.locator('#quick-route .quick-step').count(), 2);
    assert.equal(await page.locator('main').getAttribute('dir'), 'ltr');
    assert.deepEqual(errors, []);
    assert(requests.every(url => url.startsWith(origin + '/')), 'no translation service or external resource');
    await context.close();

    const privateContext = await browser.newContext({ locale: 'en-US' });
    await privateContext.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw Error('denied'); } }));
    const privatePage = await privateContext.newPage();
    await privatePage.goto(base + 'planner/guide.html?lang=ar');
    await privatePage.locator('#help-language').waitFor();
    await privatePage.locator('#help-language').selectOption('ja');
    await privatePage.waitForFunction(() => document.documentElement.lang === 'ja');
    await privatePage.locator('#quick-route nav a').nth(2).click();
    await privatePage.waitForFunction(() => document.documentElement.lang === 'ja' && document.querySelector('#quick-route')?.dataset.topic === 'install');
    await privatePage.locator('#quick-route nav a').first().click();
    await privatePage.waitForFunction(() => window.planner && document.documentElement.lang === 'ja');
    const links = await privatePage.locator('a[href*="guide.html"]').evaluateAll(nodes => nodes.map(node => node.href));
    assert(links.length && links.every(url => new URL(url).searchParams.get('lang') === 'ja'));
    await privateContext.close();

    const fallback = await browser.newContext({ locale: 'en-US' });
    const fallbackPage = await fallback.newPage();
    await fallbackPage.route('**/locales/ru.js', route => route.abort());
    await fallbackPage.goto(base + 'install.html?lang=ru');
    await fallbackPage.locator('#help-language').waitFor();
    assert.equal(await fallbackPage.locator('html').getAttribute('lang'), 'en');
    assert.match(await fallbackPage.locator('#quick-route [role=status]').textContent(), /could not be loaded/);
    await fallback.close();
    const noScripts = await browser.newContext({ javaScriptEnabled: false });
    const staticPage = await noScripts.newPage();
    await staticPage.goto(base + 'install.html');
    assert(await staticPage.locator('main h1').isVisible());
    assert(!(await staticPage.locator('#quick-route').isVisible()));
    await noScripts.close();
    console.log('Help i18n passed: 24 languages, literal commands, English reference, RTL/mobile, cross-page navigation, denied storage and failed language download.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
