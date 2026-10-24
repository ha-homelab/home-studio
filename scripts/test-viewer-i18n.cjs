'use strict';
// Fictional geometry, denied storage, and a synthetic MessagePort only: no HA service calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { gzipSync } = require('node:zlib');
const { pathToFileURL } = require('node:url');
const browserTypes = require('playwright');
const engine = process.env.VIEWER_I18N_ENGINE || 'chromium';
assert.ok(['chromium', 'firefox', 'webkit'].includes(engine), 'supported viewer test engine');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const locales = JSON.parse(read('viewer-locales/index.json'));
const dictionaries = Object.fromEntries(locales.map(({ code }) => [code, JSON.parse(read(`viewer-locales/${code}.json`))]));
const data = { locales, dictionaries }, english = dictionaries.en;
const screenshotDir = process.env.VIEWER_I18N_QA_DIR || process.env.PLANNER_SCREENSHOT_DIR;
const placeholders = value => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]).sort();
assert.equal(locales.length, 24);
assert.ok(Object.keys(english).length <= 153, 'the viewer catalog stays scoped, including eight surroundings and ten indicator labels');
for (const { code } of locales) {
  assert.deepEqual(Object.keys(dictionaries[code]).sort(), Object.keys(english).sort(), code);
  for (const key of Object.keys(english)) {
    assert.equal(typeof dictionaries[code][key], 'string');
    assert.ok(dictionaries[code][key].trim(), `${code}: ${key}`);
    assert.deepEqual(placeholders(dictionaries[code][key]), placeholders(english[key]), `${code}: ${key}`);
  }
}
const context = vm.createContext({ URLSearchParams, URL });
vm.runInContext(read('viewer-i18n.js'), context);
function core(environment = {}, value = data) { return context.createViewerI18n(value, environment); }
function compactCatalog(directory) {
  const loaded = spawnSync(process.env.PYTHON || 'python3', ['-c',
    'import json,sys\nfrom pathlib import Path\nfrom viewer_locales import load_viewer_i18n\njson.dump(load_viewer_i18n(Path(sys.argv[1])),sys.stdout,ensure_ascii=False)',
    directory], { cwd: root, encoding: 'utf8' });
  assert.equal(loaded.status, 0, loaded.stderr || loaded.stdout);
  return JSON.parse(loaded.stdout);
}
function assertCatalogParity(original, compact) {
  assert.deepEqual(compact.locales, original.locales);
  assert.deepEqual(compact.dictionaries.en, original.dictionaries.en);
  const full = core({}, original), sparse = core({}, compact);
  const keys = new Set(['unknown technical detail', ...Object.values(original.dictionaries).flatMap(Object.keys)]);
  for (const { code } of original.locales) {
    assert.equal(full.setLocale(code), true);
    assert.equal(sparse.setLocale(code), true);
    for (const key of keys) {
      const tokens = placeholders(full.t(key));
      const params = Object.fromEntries(tokens.map(name => [name, `<${name}> {untouched}`]));
      assert.equal(sparse.t(key), full.t(key), `${code}: ${key}`);
      assert.equal(sparse.t(key, params), full.t(key, params), `${code}: ${key} with parameters`);
    }
  }
}
const compactData = compactCatalog(root);
assertCatalogParity(data, compactData);
assert.ok(JSON.stringify(compactData).length < JSON.stringify(data).length, 'fallback copies are omitted from generated payloads');
for (const { code } of locales) {
  for (const [key, value] of Object.entries(dictionaries[code])) {
    assert.equal(Object.hasOwn(compactData.dictionaries[code], key), code === 'en' || value !== english[key], `${code}: ${key} compactness`);
  }
}
const catalogFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'home-viewer-locales-'));
try {
  const fixture = {
    locales: [{ code: 'en', name: 'English' }, { code: 'de', name: 'Deutsch' }],
    dictionaries: {
      en: { same: 'Same', translated: 'English', blank: 'Not empty', bothBlank: '', template: 'Hello {name} {count}', missing: 'Fallback', invalid: 'Fallback', case: 'Case' },
      de: { same: 'Same', translated: 'Deutsch', blank: '', bothBlank: '', template: 'Hello {name} {count}', invalid: null, case: 'CASE', localOnly: 'Local {name}' },
    },
  };
  const directory = path.join(catalogFixture, 'viewer-locales');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify(fixture.locales));
  for (const [code, dictionary] of Object.entries(fixture.dictionaries)) fs.writeFileSync(path.join(directory, `${code}.json`), JSON.stringify(dictionary));
  const compact = compactCatalog(catalogFixture);
  assertCatalogParity(fixture, compact);
  assert.deepEqual(compact.dictionaries.de, { translated: 'Deutsch', blank: '', invalid: null, case: 'CASE', localOnly: 'Local {name}' });
  for (const [code, dictionary] of Object.entries(fixture.dictionaries)) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, `${code}.json`), 'utf8')), dictionary, 'source catalogs are never rewritten');
  }
} finally {
  fs.rmSync(catalogFixture, { recursive: true, force: true });
}
const stored = new Map(), environment = { location: { search: '?lang=zh-TW' }, navigator: { languages: ['de-DE'] }, localStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) } };
stored.set('home-studio.language.v1', 'ru');
let instance = core(environment); instance.init();
assert.equal(instance.locale, 'zh-Hant');
instance.applyPreferences({ language: 'es' }); assert.equal(instance.locale, 'zh-Hant', 'explicit query wins');
instance.setLocale('ar'); assert.equal(stored.get('home-studio.language.v1'), 'ar');
assert.equal(instance.setLocale('../../private'), false);
assert.equal(instance.resolve('zh-SG'), 'zh-Hans');
assert.equal(instance.resolve('pt-BR'), 'pt');
assert.equal(instance.resolve('__proto__'), null);
const historyWrites = [], urlEnvironment = { location: { href: 'https://example.invalid/viewer?lang=de&floor=main#view', search: '?lang=de&floor=main' }, history: { state: { retained: true }, replaceState(...args) { historyWrites.push(args); } } };
const withHistory = core(urlEnvironment); withHistory.init(); withHistory.setLocale('fr');
assert.deepEqual(historyWrites, [[urlEnvironment.history.state, '', 'https://example.invalid/viewer?lang=fr&floor=main#view']]);
const deniedHistory = core({ location: { href: 'https://example.invalid/viewer', search: '' }, get history() { throw Error('sandbox'); } });
deniedHistory.init(); assert.equal(deniedHistory.setLocale('ar'), true);

environment.location.search = ''; instance = core(environment); instance.init(); assert.equal(instance.locale, 'ar');
const denied = { navigator: { languages: ['unsupported', 'fr-CA'] }, get localStorage() { throw Error('blocked'); } };
instance = core(denied); instance.init(); assert.equal(instance.locale, 'fr'); instance.setLocale('he');
instance.applyPreferences({ language: 'uk-UA' }); assert.equal(instance.locale, 'uk');
instance = core({}, { ...data, dictionaries: { en: english, de: { Edit: 'Bearbeiten' } } });
instance.setLocale('de'); assert.equal(instance.t('Home view'), 'Home view');
assert.equal(instance.t('Remove {name}', { name: '<img src=x>{name}' }), 'Remove <img src=x>{name}');
assert.equal(instance.t('noncatalog technical detail'), 'noncatalog technical detail');
// HA state strings are data: inherited object keys must never become messages.
context.vt = (key, params) => instance.t(key, params);
vm.runInContext(read('viewer.js').match(/^function viewerStateLabel\(state\).*$/m)[0], context);
for (const state of ['constructor', 'toString', '__proto__', 'hasOwnProperty', '__defineGetter__', 'custom_state', '0']) {
  assert.equal(context.viewerStateLabel(state), state);
}
assert.equal(context.viewerStateLabel('on'), 'On');


(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'home-viewer-i18n-'));
  let browser;
  try {
    const generated = path.join(temp, 'viewer.html');
    const script = `import json,sys\nfrom pathlib import Path\nfrom planner.project import validate_project,make_floor,render_viewer\np=json.loads(Path('planner/example-home.json').read_text())\nf=p['floors'][0]\nf['name']='User <room> __VIEWER_I18N_DATA__ /*__ENVIRONMENT_JS__*/'\nf['items'][1]['entity_id']='light.user_lamp'\nf['items'][1]['name']='My <lamp> العربية'\np=validate_project(p)\ndata,svg=make_floor(p,p['floors'][0],None)\nPath(sys.argv[1]).write_text(render_viewer(data,svg))\n`;
    const built = spawnSync(process.env.PYTHON || 'python3', ['-c', script, generated], { cwd: root, encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const html = fs.readFileSync(generated, 'utf8');
    assert.ok(html.includes("connect-src 'none'"));
    assert.ok(!html.includes('planner/locales/'), 'editor translations are not embedded');
    assert.ok(!html.includes('__VIEWER_I18N_JS__'));
    assert.deepEqual(JSON.parse(html.match(/^const viewerI18n=createViewerI18n\((.+)\),vt=/m)[1]), compactData, 'the compiler embeds the compact payload');
    assert.ok(html.includes('User &lt;room&gt; __VIEWER_I18N_DATA__ /*__ENVIRONMENT_JS__*/'), 'user tokens are not expanded');
    browser = await browserTypes[engine].launch({ headless: true, ...(engine === 'chromium' ? {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
      args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    } : {}) });
    const browserContext = await browser.newContext({ viewport: { width: 1400, height: 1000 }, locale: 'en-US', offline: true });
    const page = await browserContext.newPage(), errors = [], requests = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('request', request => { if (!/^(file|data):/.test(request.url())) requests.push(request.url()); });
    await page.goto(pathToFileURL(generated).href + '?lang=de-DE');
    await page.waitForFunction(() => window.floorplan);
    assert.equal(await page.locator('#modePlan').textContent(), dictionaries.de['Plan & placement']);
    const original = await page.evaluate(() => JSON.stringify(window.floorplan.items));
    await page.locator('#items li').first().getByRole('button', { name: dictionaries.de.Edit, exact: true }).click();
    await page.locator('#name').fill('Unsaved пользователь <draft>');
    await page.locator('#entity').fill('light.unchanged_id');
    await page.locator('#viewerLanguage').selectOption('ar');
    assert.equal(await page.locator('#name').inputValue(), 'Unsaved пользователь <draft>');
    assert.equal(await page.locator('#entity').inputValue(), 'light.unchanged_id');
    assert.equal(await page.evaluate(() => JSON.stringify(window.floorplan.items)), original);
    assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
    assert.equal(await page.locator('#addItem').textContent(), dictionaries.ar['Save changes']);
    for (const selector of ['#entity', '#x', '#plan', '#view3d']) assert.equal(await page.locator(selector).evaluate(node => getComputedStyle(node).direction), 'ltr', selector);
    assert.equal(await page.locator('h1').textContent(), 'User <room> __VIEWER_I18N_DATA__ /*__ENVIRONMENT_JS__*/');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'RTL layout stays within the viewport');
    if(screenshotDir){fs.mkdirSync(screenshotDir,{recursive:true});await page.screenshot({path:path.join(screenshotDir,'viewer-ar.png'),fullPage:true});}
    // RTL text can resize the stage after the synchronous language update.
    // Let fonts/layout and the ensuing ResizeObserver render finish before
    // measuring idle work; the strict no-render observation below is unchanged.
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const count = await page.evaluate(() => window.floorplan.renderCount);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => window.floorplan.renderCount), count, 'language switching does not start an idle loop');
    // All packs work without any network, including native RTL and CJK scripts.
    for (const { code, dir } of locales) {
      await page.locator('#viewerLanguage').selectOption(code);
      assert.equal(await page.locator('#modePlan').textContent(), dictionaries[code]['Plan & placement']);
      assert.equal(await page.locator('html').getAttribute('dir'), dir || 'ltr');
      assert.equal(await page.locator('#homeLanguage').inputValue(), code);
      if(screenshotDir&&code==='ru')await page.screenshot({path:path.join(screenshotDir,'viewer-ru.png'),fullPage:true});
    }
    await page.locator('#viewerLanguage').selectOption('fr');
    assert.equal(new URL(page.url()).searchParams.get('lang'), 'fr');
    assert.equal(await page.locator('#name').inputValue(), 'Unsaved пользователь <draft>', 'replacing the language query leaves form drafts intact');
    await page.reload(); await page.waitForFunction(() => window.floorplan);
    assert.equal(await page.locator('#modePlan').textContent(), dictionaries.fr['Plan & placement'], 'reload retains the selected language over the original query');
    // The installed view is a genuinely opaque-origin srcdoc with an authenticated port.
    const installed = await browserContext.newPage();
    installed.on('pageerror', error => errors.push(String(error)));
    await installed.setContent('<iframe id="viewer" sandbox="allow-scripts allow-downloads" style="width:1350px;height:950px;border:0"></iframe>');
    await installed.evaluate(content => {
      const iframe = document.getElementById('viewer');
      iframe.srcdoc = content.replace('<body>', '<body><script>window.__HOME_FLOORPLAN_EMBED__=true;<\/script>');
    }, html);
    const frame = installed.frameLocator('#viewer');
    await frame.locator('#homeLanguage').waitFor();
    await installed.waitForFunction(() => document.getElementById('viewer').contentWindow !== null);
    // Wait for the module, whose completion cannot be inspected across opaque origins.
    await frame.locator('#homeConnection').filter({ hasText: 'Disconnected' }).waitFor();
    await installed.evaluate(() => {
      const channel = new MessageChannel(); window.testMessages = []; window.testPort = channel.port1;
      channel.port1.onmessage = event => {
        if (event.data.type === 'map_request' && event.data.action === 'get') {
          channel.port1.postMessage({ type:'map_result', request_id:event.data.request_id, success:true, result:{ revision:0, configured:false, config:null, reference:null } }); return;
        }
        window.testMessages.push(event.data);
      };
      const items = JSON.parse(document.getElementById('viewer').srcdoc.match(/<script id="modelData" type="application\/json">([\s\S]*?)<\/script>/)[1]).inventory;
      document.getElementById('viewer').contentWindow.postMessage({ type: 'home-floorplan:init', can_edit:true, items, preferences: { language: 'fr', sidebarCollapsed: true } }, '*', [channel.port2]);
      channel.port1.postMessage({ type: 'states', connected: true, states: { 'light.user_lamp': { state: 'on', name: 'HA user name' } } });
    });
    await frame.locator('#editLayout').filter({ hasText: dictionaries.fr['Edit layout'] }).waitFor();
    assert.equal(await frame.locator('#homeControls').isHidden(), true);
    await frame.locator('#homeLanguage').selectOption('he');
    await installed.waitForFunction(() => window.testMessages.some(message => message.type === 'view_preferences' && message.language === 'he'));
    assert.equal(await frame.locator('#homeControls').isHidden(), true, 'language-only update preserves sidebar');
    if(screenshotDir)await installed.screenshot({path:path.join(screenshotDir,'installed-viewer-he.png'),fullPage:true});
    await installed.evaluate(() => window.testPort.postMessage({ type: 'view_preferences', language: 'de' }));
    await frame.locator('#editLayout').filter({ hasText: dictionaries.de['Edit layout'] }).waitFor();
    assert.equal(await frame.locator('#homeControls').isHidden(), true);
    assert.deepEqual(await installed.evaluate(() => window.testMessages.filter(message => !['view_preferences', 'model_config'].includes(message.type))), [], 'switching language never saves inventory or sends device commands');
    for (const state of ['constructor', 'toString', '__proto__', 'custom_state']) {
      await installed.evaluate(state => window.testPort.postMessage({ type: 'states', connected: true, states: { 'light.user_lamp': { state, name: 'HA user name' } } }), state);
      await frame.locator('[data-state-for="living_light"]').filter({ hasText: state }).waitFor({state:'attached'});
      assert.equal(await frame.locator('[data-state-for="living_light"]').textContent(), state);
    }
    // A visible fallback must survive the real Home-mode CSS and an opaque
    // iframe. Neither a missing WebGL context nor a failed first draw may
    // prevent editing and exporting the host's saved inventory.
    for (const failure of ['webgl', 'first-draw']) {
      const recovery = await browserContext.newPage();
      recovery.on('pageerror', error => errors.push(String(error)));
      recovery.on('request', request => { if (!/^(about|data|blob):/.test(request.url())) requests.push(request.url()); });
      const prefix = failure === 'webgl'
        ? '<script>const getContext=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return /^webgl/.test(type)?null:getContext.call(this,type,...args)};<\/script>'
        : '';
      const content = (failure === 'first-draw' ? html.replace('function drawScene(camera){', 'function drawScene(camera){throw Error("Synthetic first-draw failure");') : html)
        .replace('<body>', '<body><script>window.__HOME_FLOORPLAN_EMBED__=true;<\/script>' + prefix);
      await recovery.setContent('<iframe id="viewer" sandbox="allow-scripts allow-downloads allow-forms" style="width:1250px;height:900px;border:0"></iframe>');
      await recovery.evaluate(content => { document.getElementById('viewer').srcdoc = content; }, content);
      const recovered = recovery.frameLocator('#viewer');
      await recovered.locator('#homeConnection').filter({ hasText: 'Disconnected' }).waitFor();
      assert.equal(await recovered.locator('body').evaluate(body => body.classList.contains('home-mode')), true);
      assert.equal(await recovered.locator('#loadError').isVisible(), true, `${failure}: error is visible outside the hidden editor`);
      assert.equal(await recovered.locator('#loadError').evaluate(node => {
        const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight;
      }), true, `${failure}: recovery is inside the viewport`);
      assert.equal(await recovered.locator('#loadError').textContent().then(text => text.includes('Synthetic')), false, 'the public recovery message does not copy arbitrary exception details');
      await recovery.evaluate(() => {
        const iframe = document.getElementById('viewer'), channel = new MessageChannel();
        window.testMessages = []; window.testPort = channel.port1;
        channel.port1.onmessage = event => {
          if (event.data.type === 'map_request' && event.data.action === 'get') {
            channel.port1.postMessage({ type:'map_result', request_id:event.data.request_id, success:true, result:{ revision:0, configured:false, config:null, reference:null } }); return;
          }
          window.testMessages.push(event.data);
        };
        const items = JSON.parse(iframe.srcdoc.match(/<script id="modelData" type="application\/json">([\s\S]*?)<\/script>/)[1]).inventory;
        items[0].name = 'Saved host placement';
        window.savedItems = items;
        iframe.contentWindow.postMessage({ type: 'home-floorplan:init', can_edit:true, items, preferences: { language: 'ar' } }, '*', [channel.port2]);
        channel.port1.postMessage({ type: 'states', connected: false, states: {} });
      });
      await recovered.locator('#recoverPlan').filter({ hasText: dictionaries.ar['Plan & placement'] }).waitFor();
      assert.equal(await recovered.locator('#loadError p').textContent(), dictionaries.ar['3D view could not start. Plan editing and JSON export are still available.']);
      if (screenshotDir) await recovery.screenshot({ path: path.join(screenshotDir, `recovery-${failure}.png`), fullPage: true });
      await recovered.locator('#recoverPlan').click();
      assert.equal(await recovered.locator('#planPane').isVisible(), true);
      assert.equal(await recovered.locator('#loadError').isHidden(), true);
      assert.equal(await recovered.locator('aside').evaluate(node => node.inert), false);
      assert.equal(await recovered.locator('#modePlan').evaluate(node => document.activeElement === node), true);
      assert.equal(await recovered.locator('#mode3d').isDisabled(), true);
      assert.equal(await recovered.locator('#openHome').isDisabled(), true);
      const focusedRoom = await recovered.locator('#focusRoom option').nth(1).getAttribute('value');
      await recovered.locator('#focusRoom').selectOption(focusedRoom);
      assert.equal(await recovered.locator('#room').inputValue(), focusedRoom, `${failure}: room selection still sets the placement room`);
      assert.equal(await recovered.locator('#planPane').isVisible(), true, `${failure}: room focus stays in the working 2D plan`);
      assert.equal(await recovered.locator('#view3d').isHidden(), true);
      await recovered.locator('#focusRoom').selectOption('');
      assert.equal(await recovered.locator('#planPane').isVisible(), true, `${failure}: whole-floor focus stays in the working 2D plan`);
      await recovered.locator('#items li').first().getByRole('button', { name: dictionaries.ar.Edit, exact: true }).click();
      assert.equal(await recovered.locator('#name').inputValue(), 'Saved host placement');
      await recovered.locator('#name').fill('Edited after 3D failure');
      await recovered.locator('#addItem').click();
      await recovery.waitForFunction(() => window.testMessages.some(message => message.type === 'save'));
      const saved = await recovery.evaluate(() => window.testMessages.find(message => message.type === 'save').items);
      assert.equal(saved[0].name, 'Edited after 3D failure');
      const originalSaved = await recovery.evaluate(() => window.savedItems);
      assert.deepEqual(saved.slice(1), originalSaved.slice(1), 'recovery preserves other saved placements');
      for (const key of ['id', 'position_m', 'dimensions_m', 'entity_id']) assert.deepEqual(saved[0][key], originalSaved[0][key], key);
      const downloadEvent = recovery.waitForEvent('download');
      await recovered.locator('#export').click();
      const download = await downloadEvent;
      const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
      assert.deepEqual(exported.items, saved, `${failure}: exported inventory matches the edited saved placements`);
      assert.equal(await recovered.locator('#loadError').isHidden(), true, 'editing and export do not retry the failed renderer');
      assert.deepEqual(await recovery.evaluate(() => window.testMessages.filter(message => !['model_config', 'save'].includes(message.type))), [], 'recovery sends no device commands');
      await recovery.close();
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, []);
    console.log(`PASS (${engine}): 24 viewer catalogs; fallback, query/storage/browser/host preference; offline generated viewer; RTL, unchanged drafts/items; opaque srcdoc MessagePort; visible WebGL/first-draw recovery, editing and JSON export; no device commands. Catalog gzip: ${gzipSync(JSON.stringify(data)).length} bytes.`);
  } finally {
    await browser?.close(); fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
