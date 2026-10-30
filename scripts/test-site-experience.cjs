// Exercise the shipped documents, public-data failure modes, and navigation lifecycle.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const playwright = require('playwright');
const root = path.resolve(__dirname, '..');
const API = 'https://api.github.com/repos/ha-homelab/home-studio';
const repository = { full_name: 'ha-homelab/home-studio', private: false, html_url: 'https://github.com/ha-homelab/home-studio', stargazers_count: 23, forks_count: 7, pushed_at: '2026-10-30T11:22:33Z' };
const engines = (process.env.SITE_BROWSER_ENGINES || 'chromium,firefox,webkit').split(',');
assert(engines.every(engine => ['chromium', 'firefox', 'webkit'].includes(engine)), 'unknown browser engine');

async function complete(page, pathname) {
  await page.waitForFunction(expected => location.pathname === expected && !document.documentElement.hasAttribute('data-site-loading'), pathname);
}

async function clickDocument(page, base, relative, wait = true) {
  const target = new URL(relative, base);
  const links = page.locator('a[href]');
  const index = await links.evaluateAll((nodes, expected) => {
    const matching = node => {
      const url = new URL(node.href);
      return !node.closest('details:not([open]), [hidden]') && node.getClientRects().length > 0 && url.origin === expected.origin && url.pathname === expected.pathname && (!expected.hash || url.hash === expected.hash);
    };
    const textLink = nodes.findIndex(node => matching(node) && !node.querySelector('img') && !node.classList.contains('system-card'));
    return textLink >= 0 ? textLink : nodes.findIndex(matching);
  }, { origin: target.origin, pathname: target.pathname, hash: target.hash });
  assert(index >= 0, `real document link to ${relative} exists`);
  await links.nth(index).click();
  if (wait) await complete(page, target.pathname);
}

async function exercise(engine, base) {
  const executablePath = process.env[`PLAYWRIGHT_${engine.toUpperCase()}_EXECUTABLE`] || undefined;
  const browser = await playwright[engine].launch({ headless: true, executablePath });
  try {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => {
      window.__documentIdentity = Math.random().toString(36);
      window.__cspErrors = [];
      document.addEventListener('securitypolicyviolation', event => window.__cspErrors.push(event.violatedDirective));
    });
    const errors = [], apiCalls = [], requests = [];
    let failAPI = false;
    await context.route(API, async route => {
      apiCalls.push(route.request());
      await route.fulfill({ status: failAPI ? 429 : 200, contentType: 'application/json', body: JSON.stringify(failAPI ? { message: 'API rate limit exceeded' } : repository) });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    page.on('request', request => requests.push({ url: request.url(), method: request.method(), type: request.resourceType() }));
    await page.goto(base + 'planner/guide.html?lang=ru#door');
    await page.locator('#help-language').waitFor();
    const identity = await page.evaluate(() => window.__documentIdentity);
    await page.locator('#help-language').selectOption('ja');
    await page.waitForFunction(() => new URL(location.href).searchParams.get('lang') === 'ja');
    assert(await page.evaluate(() => Boolean(history.state.homeStudioDocument)), 'language updates preserve navigation history');
    await clickDocument(page, base, 'planner/publishing.html');
    assert.equal(await page.locator('#quick-route .quick-step').count(), 2);
    assert.equal(await page.locator('html').getAttribute('lang'), 'ja');
    await clickDocument(page, base, 'install.html');
    assert.equal(await page.locator('#quick-route [data-command]').count(), 5);
    assert.equal(await page.locator('#quick-route').getAttribute('data-topic'), 'install');
    await clickDocument(page, base, 'ai-setup.html');
    assert.equal(await page.locator('#quick-route').count(), 0);
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    await clickDocument(page, base, 'privacy.html');
    assert.match(await page.title(), /data/i);
    await clickDocument(page, base, '');
    assert.equal(await page.evaluate(() => window.__documentIdentity), identity, 'all six docs use the same document');
    assert.equal(await page.locator('main h1').evaluate(node => node === document.activeElement), true, 'page heading receives keyboard focus');
    assert.equal(apiCalls.length, 0, 'metadata waits until its region is visible');
    await page.waitForFunction(() => document.querySelector('[data-scene]').classList.contains('is-in-view'));
    const tile = page.locator('[data-tilt]').first();
    const bounds = await tile.boundingBox();
    await page.mouse.move(bounds.x + bounds.width * 0.6, bounds.y + bounds.height * 0.6);
    await page.waitForFunction(() => document.querySelector('[data-tilt]').style.getPropertyValue('--tilt-y') !== '');
    await page.mouse.move(0, 0);
    await page.waitForFunction(() => document.querySelector('[data-tilt]').style.getPropertyValue('--tilt-y') === '');
    await page.locator('[data-github-metadata]').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('[data-github-stars]').textContent === '23');
    assert.equal(apiCalls.length, 1);
    assert.equal(await page.locator('[data-github-forks]').textContent(), '7');
    assert.match(await page.locator('[data-github-status]').textContent(), /^Checked /);
    const headers = apiCalls[0].headers();
    assert(!headers.authorization && !headers.cookie && !headers.referer, 'public metadata sends no credentials or referrer');
    assert.equal(await page.locator('video source').first().getAttribute('src'), base + 'docs/media/native-ha-workflow.mp4');
    assert.equal(await page.locator('video').getAttribute('poster'), base + 'docs/media/native-ha-workflow-poster.jpg');
    assert.match(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), /media-src 'self'/);
    await page.locator('[data-github-load]').click();
    await page.waitForFunction(() => document.querySelector('[data-github-status]').textContent.startsWith('Checked '));
    assert.equal(apiCalls.length, 2);
    failAPI = true;
    await page.locator('[data-github-load]').click();
    await page.waitForFunction(() => document.querySelector('[data-github-status]').textContent.includes('limited requests'));
    assert.equal(await page.locator('[data-github-stars]').textContent(), '23', 'rate limiting keeps the last observed data');
    const rememberedY = await page.evaluate(() => window.scrollY);
    await clickDocument(page, base, 'privacy.html');
    await page.goBack();
    await complete(page, new URL(base).pathname);
    assert.equal(apiCalls.length, 3, 'back navigation reuses the valid cache');
    assert.match(await page.locator('[data-github-status]').textContent(), /^Cached/);
    // Clicking the existing privacy link may scroll it into view before navigation;
    // the restoration must still return below the hero, not reset to the page top.
    assert(await page.evaluate(() => window.scrollY) > 100 && rememberedY > 100);
    await page.goForward();
    await complete(page, new URL('privacy.html', base).pathname);
    assert.equal(await page.evaluate(() => window.__documentIdentity), identity);
    await clickDocument(page, base, '');
    await clickDocument(page, base, '#native-ha-demo');
    assert.equal(new URL(page.url()).hash, '#native-ha-demo');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'native-ha-demo');
    await page.waitForFunction(() => document.querySelector('#native-ha-demo [data-reveal]').classList.contains('is-visible'));
    await page.waitForFunction(() => !document.querySelector('[data-scene]').classList.contains('is-in-view'));

    // A later click wins even if a previous document fetch finishes later.
    let releaseSlow;
    const slow = new Promise(resolve => { releaseSlow = resolve; });
    await page.route('**/privacy.html', async route => {
      if (route.request().resourceType() !== 'fetch') return route.continue();
      await slow;
      try { await route.continue(); } catch { /* The newer navigation aborted it. */ }
    });
    await clickDocument(page, base, 'privacy.html', false);
    await clickDocument(page, base, 'ai-setup.html');
    releaseSlow();
    await page.unroute('**/privacy.html');
    assert.equal(new URL(page.url()).pathname, new URL('ai-setup.html', base).pathname);
    assert.equal(await page.evaluate(() => window.__documentIdentity), identity);

    // A failed enhancement falls back to an ordinary request for the same link.
    await page.route('**/privacy.html', route => route.request().resourceType() === 'fetch' ? route.abort() : route.continue());
    await clickDocument(page, base, 'privacy.html');
    assert.notEqual(await page.evaluate(() => window.__documentIdentity), identity);
    await page.unroute('**/privacy.html');
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.__cspErrors), []);
    const unexpected = requests.filter(({ url, method, type }) => {
      // WebKit reports in-memory copies of same-origin images after DOM import.
      // These are not network requests; do not permit other blob types/origins.
      const parsed = new URL(url);
      const localImage = parsed.protocol === 'blob:' && parsed.origin === new URL(base).origin && method === 'GET' && type === 'image';
      return !url.startsWith(base) && url !== API && !localImage;
    });
    assert.deepEqual(unexpected, [], 'only local files and the one public API endpoint are requested');
    await context.close();

    // Storage denial and reduced motion retain usable content and normal links.
    const privateContext = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });
    await privateContext.addInitScript(() => {
      for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(window, name, { get() { throw new Error('storage denied'); } });
    });
    await privateContext.route(API, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
    const privatePage = await privateContext.newPage();
    await privatePage.goto(base);
    assert.equal(await privatePage.locator('html').evaluate(node => node.classList.contains('motion-ready')), false);
    const overflow = await privatePage.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth,
      nodes: [...document.querySelectorAll('body *')].filter(node => { const rect = node.getBoundingClientRect(); return rect.width && (rect.right > innerWidth + 1 || rect.left < -1); }).slice(0, 12).map(node => ({ tag: node.tagName, class: node.className, right: node.getBoundingClientRect().right })) }));
    assert(overflow.width <= overflow.viewport + 1, `mobile page does not overflow: ${JSON.stringify(overflow)}`);
    assert.equal(await privatePage.locator('[data-tilt]').evaluate(node => node.style.getPropertyValue('--tilt-y')), '');
    await privatePage.locator('[data-github-metadata]').scrollIntoViewIfNeeded();
    await privatePage.waitForFunction(() => document.querySelector('[data-github-status]').textContent.includes('unavailable'));
    assert.equal(await privatePage.locator('[data-github-stars]').textContent(), '—', 'no invented zero counts on failure');
    await clickDocument(privatePage, base, 'install.html');
    await privatePage.locator('#help-language').selectOption('ar');
    await privatePage.waitForFunction(() => document.documentElement.lang === 'ar');
    await clickDocument(privatePage, base, 'planner/guide.html');
    assert.equal(await privatePage.locator('#quick-route').getAttribute('dir'), 'rtl');
    assert.equal(await privatePage.locator('main').getAttribute('dir'), 'ltr');
    await privateContext.close();

    const noJS = await browser.newContext({ javaScriptEnabled: false });
    const plain = await noJS.newPage();
    await plain.goto(base);
    assert(await plain.locator('main h1').isVisible());
    assert.equal(await plain.locator('[data-github-stars]').textContent(), '—');
    assert.equal(await plain.locator('[data-github-load]').isVisible(), false);
    await clickDocument(plain, base, 'install.html');
    assert(await plain.locator('main h1').isVisible());
    await noJS.close();

    // A dynamic import cannot be canceled by fetch's AbortSignal. The complete
    // preparation/mount deadline must still release the visitor to normal HTML.
    const timeoutContext = await browser.newContext();
    await timeoutContext.route(API, route => route.fulfill({ json: repository }));
    let releaseModule;
    const moduleGate = new Promise(resolve => { releaseModule = resolve; });
    await timeoutContext.route('**/planner/help.js', async route => {
      await moduleGate;
      try { await route.continue(); } catch { /* A timed-out document may have gone away. */ }
    });
    const timeoutPage = await timeoutContext.newPage();
    await timeoutPage.goto(base);
    const nativeFallback = timeoutPage.waitForRequest(request => request.isNavigationRequest() && new URL(request.url()).pathname === new URL('planner/guide.html', base).pathname);
    const startedAt = Date.now();
    await clickDocument(timeoutPage, base, 'planner/guide.html', false);
    await nativeFallback;
    assert(Date.now() - startedAt < 16000, 'stalled imports use the bounded normal-navigation fallback');
    releaseModule();
    await timeoutPage.waitForURL('**/planner/guide.html*');
    await timeoutPage.locator('#help-language').waitFor();
    await timeoutContext.close();

    // Initial fragments still resolve after an asynchronous help translation.
    const hashContext = await browser.newContext();
    const hashPage = await hashContext.newPage();
    await hashPage.goto(base + 'planner/guide.html?lang=ja#quick-route');
    await hashPage.locator('#help-language').waitFor();
    await hashPage.waitForFunction(() => {
      const top = document.getElementById('quick-route').getBoundingClientRect().top;
      return top >= 0 && top < innerHeight / 2;
    });
    await hashPage.evaluate(() => window.scrollTo({ top: 1000, behavior: 'instant' }));
    await hashPage.waitForFunction(() => Math.abs((history.state?.homeStudioDocument?.position?.[1] ?? -1000) - 1000) < 2);
    await hashPage.reload();
    await hashPage.locator('#help-language').waitFor();
    await hashPage.waitForFunction(() => Math.abs(window.scrollY - 1000) < 2);
    await hashContext.close();

    // Leaving for the real editor URL must invalidate an abandoned site fetch.
    const exitContext = await browser.newContext();
    await exitContext.route(API, route => route.fulfill({ json: repository }));
    let releaseDocument;
    const documentGate = new Promise(resolve => { releaseDocument = resolve; });
    await exitContext.route('**/planner/guide.html*', async route => {
      if (route.request().resourceType() !== 'fetch') return route.continue();
      await documentGate;
      try { await route.continue(); } catch { /* Abandoned by the native link. */ }
    });
    await exitContext.route(url => url.pathname === new URL('planner/', base).pathname, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Editor destination</title><h1>Editor destination</h1>' }));
    const exitPage = await exitContext.newPage();
    await exitPage.goto(base);
    await clickDocument(exitPage, base, 'planner/guide.html', false);
    const nativeLink = exitPage.locator('a.text-link[href="./planner/"]');
    await nativeLink.focus();
    await nativeLink.press('Enter');
    await complete(exitPage, new URL('planner/', base).pathname);
    assert.equal(await exitPage.locator('h1').textContent(), 'Editor destination');
    releaseDocument();
    await exitPage.goBack();
    await complete(exitPage, new URL(base).pathname);
    assert(await exitPage.locator('main h1').isVisible());
    await exitContext.close();
    console.log(`${engine}: document lifecycle, locale remounting, history, anchors, API cache/errors, race/fallback, mobile/reduced motion, no-JS passed.`);
  } finally { await browser.close(); }
}

(async () => {
  const listed = spawnSync(process.env.PYTHON || 'python3', ['-c', 'import runpy,json; print(json.dumps(runpy.run_path("scripts/validate-site.py")["SITE_FILES"]))'], { cwd: root, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const files = new Set(JSON.parse(listed.stdout));
  const server = http.createServer((request, response) => {
    let file = new URL(request.url, 'http://localhost').pathname.replace(/^\/home-studio\//, '');
    if (!file || file.endsWith('/')) file += 'index.html';
    if (!files.has(file)) return response.writeHead(404).end();
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.mp4': 'video/mp4', '.vtt': 'text/vtt' }[path.extname(file)] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    fs.createReadStream(path.join(root, file)).pipe(response);
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/home-studio/`;
    for (const engine of engines) await exercise(engine, base);
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
