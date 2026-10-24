// Exercise the real HA host, authenticated bridge, CSS and drawing canvas.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, firefox, webkit } = require('playwright');
const { browserLaunchOptions } = require('./browser-stability-diagnostics.cjs');
const engine = process.env.BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[engine];
assert(browserType, 'BROWSER must be chromium, firefox, or webkit');
const root = path.resolve(__dirname, '..');
const project = { schema_version: 1, id: 'theme_home', title: 'Synthetic theme home', floors: [{
  id: 'ground', name: 'Ground floor', elevation_m: 0, height_m: 2.7,
  rooms: [{ id: 'living', name: 'Living room', polygon: [[0, 0], [5, 0], [5, 4], [0, 4]], material: 'floor' }],
  walls: [], openings: [], items: [{ id: 'lamp', name: 'Synthetic lamp', type: 'lamp', room: 'living',
    position_m: { x: 1.5, y: 0, z: 1.5 }, dimensions_m: { width: .6, depth: .6, height: 1 }, rotation_deg: 0, entity_id: '', notes: '' }],
}] };
const palettes = {
  light: { 'primary-background-color': '#fafafa', 'card-background-color': '#ffffff', 'primary-text-color': '#212121',
    'secondary-text-color': '#727272', 'divider-color': 'rgba(0,0,0,0.12)', 'primary-color': 'rgb(3,169,244)', 'text-primary-color': '#ffffff', 'error-color': '#db4437' },
  dark: { 'primary-background-color': '#111111', 'card-background-color': '#1c1c1c', 'primary-text-color': '#e1e1e1',
    'secondary-text-color': '#9b9b9b', 'divider-color': 'rgba(255,255,255,0.12)', 'primary-color': 'rgb(3,169,244)', 'text-primary-color': '#ffffff', 'error-color': '#cf6679' },
};
const fixture = `<!doctype html><html style="height:100%"><body style="margin:0;height:100%">
<home-floorplan-studio-panel></home-floorplan-studio-panel><script type="module">
await import('/home-floorplan-static/studio.js');
window.host = document.querySelector('home-floorplan-studio-panel');
window.calls = [];
window.setTheme = (mode, colors) => {
  for (const [name, value] of Object.entries(colors)) host.style.setProperty('--' + name, value);
  host.hass = { ...host._hass, themes: { darkMode: mode === 'dark' } };
};
const project = ${JSON.stringify(project)};
for (const [name, value] of Object.entries(${JSON.stringify(palettes.light)})) host.style.setProperty('--' + name, value);
host.hass = { user: { id: 'synthetic-admin', is_admin: true }, themes: { darkMode: false }, callWS: async data => {
  calls.push(data.type);
  if (data.type.endsWith('entity_catalog')) return { floors: [], areas: [], entities: [] };
  return { project, revision: 1, published_revision: 1, has_saved_draft: true, has_published: true, can_edit: true,
    capabilities: { authoring: true }, editor_url: '/home-floorplan-studio/planner/index.html' };
} };
</script></body></html>`;
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/fixture') return res.writeHead(200, { 'Content-Type': 'text/html' }).end(fixture);
  const route = pathname.replace(/^\/home-floorplan-static\//, '/custom_components/home_floorplan/static/')
    .replace(/^\/home-floorplan-studio\//, '/');
  const editorModules = ['/pbr-color-data.js', '/pbr-materials.js', '/material-textures.js', '/environment-lighting.js'];
  if (!/^\/(planner|vendor|ai|custom_components\/home_floorplan\/static)\//.test(route) && !editorModules.includes(route)) return res.writeHead(404).end();
  const file = path.resolve(root, '.' + route);
  if (!file.startsWith(root + path.sep)) return res.writeHead(404).end();
  try {
    const body = fs.readFileSync(file);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
    const headers = { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' };
    if (pathname.startsWith('/home-floorplan-studio/')) headers['Access-Control-Allow-Origin'] = '*';
    res.writeHead(200, headers).end(body);
  } catch { res.writeHead(404).end(); }
});
function rgb(color) { return color.startsWith('#') ? [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16)) : color.match(/[\d.]+/g).slice(0, 3).map(Number); }
function contrast(a, b) {
  const lum = color => rgb(color).map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
  const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
async function presentation(frame) {
  await frame.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})));
  });
  return frame.evaluate(() => {
    const style = selector => { const s = getComputedStyle(document.querySelector(selector)); return { color: s.color, background: s.backgroundColor }; };
    const rootStyle = getComputedStyle(document.documentElement);
    const canvas = document.querySelector('#plan-canvas'), context = canvas.getContext('2d');
    const [x, y] = planner.worldToScreen([1.5, 1.5]), ratio = canvas.width / canvas.getBoundingClientRect().width;
    const pixel = (a, b) => [...context.getImageData(Math.round(a * ratio), Math.round(b * ratio), 1, 1).data].slice(0, 3);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const selection = rootStyle.getPropertyValue('--studio-selection').trim();
    const selectedRgb = [1, 3, 5].map(i => parseInt(selection.slice(i, i + 2), 16));
    let selectionPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) if (selectedRgb.every((c, channel) => pixels[i + channel] === c)) selectionPixels++;
    return { body: style('body'), input: style('#inspector-body input'), panel: style('.left-panel'),
      selected: style('.object-button[aria-pressed=true]'), tool: style('[data-tool][aria-pressed=true]'),
      background: rootStyle.getPropertyValue('--studio-background').trim(), selection, link: rootStyle.getPropertyValue('--studio-link').trim(),
      lamp: pixel(x, y), selectionPixels, canvasBackground: pixel(7, 13),
      project: planner.getProject(), currentSelection: planner.getSelection(), toolName: document.querySelector('[data-tool][aria-pressed=true]').dataset.tool,
    };
  });
}
function assertPresentation(result, mode) {
  assert.equal(result.background, palettes[mode]['primary-background-color']);
  for (const name of ['body', 'input', 'panel', 'selected', 'tool']) {
    assert(contrast(result[name].color, result[name].background) >= 4.5, `${mode} ${name} text needs 4.5:1 contrast: ${JSON.stringify(result[name])}`);
  }
  assert(contrast(result.selection, result.background) >= 3, `${mode} selection needs 3:1 contrast`);
  assert(contrast(result.link, result.panel.background) >= 4.5, `${mode} text links need 4.5:1 contrast`);
  assert.deepEqual(result.lamp, [217, 174, 104], 'Changing the UI theme must preserve the lamp material');
  assert(result.selectionPixels > 20, 'The selected item has a visible themed canvas outline');
  assert.deepEqual(result.canvasBackground, rgb(result.background), 'The real canvas follows the host background');
}

(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await browserType.launch(browserLaunchOptions(engine, true));
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
    const errors = [], page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(String(error)));
    // OS dark mode alone does not alter the standalone editor's existing design.
    await page.goto(origin + '/planner/index.html'); await page.waitForFunction(() => window.planner);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(246, 246, 241)');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.haTheme), undefined);
    await page.goto(origin + '/fixture'); await page.waitForFunction(() => window.host?._ready);
    const frame = await page.locator('iframe').elementHandle().then(handle => handle.contentFrame());
    await frame.waitForFunction(() => document.documentElement.dataset.haTheme === 'light');
    assert.deepEqual(await page.evaluate(async () => {
      const create = document.createElement, count = { span: 0, canvas: 0 };
      document.createElement = function (tag, ...args) { if (Object.hasOwn(count, tag)) count[tag]++; return create.call(this, tag, ...args); };
      try {
        for (let update = 0; update < 4; update++) {
          host.hass = { ...host._hass };
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }
      } finally { document.createElement = create; }
      return count;
    }), { span: 0, canvas: 0 }, 'Ordinary HA state updates must not recreate theme probes or canvases');
    await frame.getByRole('button', { name: 'Synthetic lamp', exact: false }).click();
    await frame.locator('[data-tool="wall"]').click();
    await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const initial = await presentation(frame); assertPresentation(initial, 'light');
    assert.deepEqual(initial.project, project); assert.deepEqual(initial.currentSelection, { kind: 'items', id: 'lamp' });
    const name = frame.getByLabel('Item name', { exact: true });
    await name.fill('Unfinished theme edit');
    await frame.evaluate(() => { window.originalNameField = document.activeElement; window.themeFrameMarker = 'same editor'; });
    await page.evaluate(() => { window.originalFrame = host._frame; window.originalChannel = host._channel; });
    const savedCalls = await page.evaluate(() => calls.slice());
    for (const mode of ['dark', 'light']) {
      await page.evaluate(({ mode, colors }) => setTheme(mode, colors), { mode, colors: palettes[mode] });
      await frame.waitForFunction(mode => document.documentElement.dataset.haTheme === mode, mode);
      await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const result = await presentation(frame); assertPresentation(result, mode);
      assert.deepEqual(result.project, initial.project, 'Theme changes do not edit the project');
      assert.deepEqual(result.currentSelection, initial.currentSelection); assert.equal(result.toolName, initial.toolName);
      assert.equal(await name.inputValue(), 'Unfinished theme edit');
      assert.equal(await frame.evaluate(() => document.activeElement === originalNameField && originalNameField.isConnected && themeFrameMarker === 'same editor'), true);
      assert.equal(await page.evaluate(() => host._frame === originalFrame && host._channel === originalChannel), true);
      assert.deepEqual(await page.evaluate(() => calls), savedCalls, 'Theme changes do not save or reload the drawing');
      const hostStyle = await page.evaluate(() => {
        const button = host.$('save'), primary = getComputedStyle(button), recovery = getComputedStyle(host.$('recovery'));
        return { enabled: !button.disabled, primary: primary.backgroundColor, text: primary.color,
          recovery: recovery.backgroundColor, frame: getComputedStyle(host._frame).backgroundColor };
      });
      assert(hostStyle.enabled, 'An unfinished edit enables the host Save button');
      assert.deepEqual(rgb(hostStyle.primary), [3, 169, 244], 'The host primary button inherits the exact HA accent');
      assert(contrast(hostStyle.text, hostStyle.primary) >= 4.5, `${mode} host primary text needs 4.5:1 contrast`);
      assert.deepEqual(rgb(hostStyle.recovery), rgb(palettes[mode]['card-background-color']));
      assert.deepEqual(rgb(hostStyle.frame), rgb(palettes[mode]['primary-background-color']));
      if (process.env.THEME_SCREENSHOT_DIR) { fs.mkdirSync(process.env.THEME_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.THEME_SCREENSHOT_DIR, `editor-${mode}-${engine}.png`) }); }
    }
    await page.evaluate(() => { host.style.setProperty('--primary-color', 'rgb(120,160,210)'); host.hass = { ...host._hass }; });
    await page.waitForFunction(() => host._theme.accent === '#78a0d2');
    await page.evaluate(colors => setTheme('light', colors), palettes.light);
    await page.waitForFunction(() => host._theme.accent === '#03a9f4');
    // Only the parent/origin/channel combination may deliver a theme; even it
    // cannot turn theme input into arbitrary CSS, resource URLs or extra keys.
    await page.evaluate(() => {
      const theme = { ...host._theme, mode: 'dark', background: '#000000' };
      const data = { protocol: 'home-studio-editor-v1', channel: host._channel, type: 'theme', theme };
      host._frame.contentWindow.postMessage({ ...data, channel: 'wrong-channel' }, '*');
      for (const invalid of [{ ...theme, background: 'url(https://invalid.test/theme)' }, { ...theme, color: '#ffffff' },
        { ...theme, mode: 'auto' }, { ...theme, text: null }, { ...theme, accent: '#123' }]) {
        host._frame.contentWindow.postMessage({ ...data, theme: invalid }, '*');
      }
    });
    await frame.evaluate(() => {
      const channel = location.hash.split('=')[1];
      const theme = { mode: 'dark', background: '#000000', surface: '#111111', text: '#ffffff', muted: '#aaaaaa', border: '#888888', accent: '#00aaff', accentText: '#ffffff', error: '#ff0000' };
      const data = { protocol: 'home-studio-editor-v1', channel, type: 'theme', theme };
      for (const [source, origin] of [[window, new URL(location.href).origin], [parent, 'https://wrong-origin.invalid']]) {
        // Firefox's isolated evaluation realm cannot pass WindowProxy through
        // MessageEventInit; own event properties exercise the same receiver.
        const event = new Event('message');
        Object.defineProperties(event, { source: { value: source }, origin: { value: origin }, data: { value: data } });
        dispatchEvent(event);
      }
    });
    await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await frame.evaluate(() => document.documentElement.dataset.haTheme), 'light');
    assert.equal(await frame.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--studio-background').trim()), '#fafafa');
    // Check keyboard focus after the unfinished-field preservation checks.
    await page.keyboard.press('Tab'); await page.locator('#save').focus();
    for (const mode of ['light', 'dark']) {
      await page.evaluate(({ mode, colors }) => setTheme(mode, colors), { mode, colors: palettes[mode] });
      await frame.waitForFunction(mode => document.documentElement.dataset.haTheme === mode, mode);
      const focus = await page.evaluate(() => {
        const button = host.$('save'), style = getComputedStyle(button);
        return { visible: button.matches(':focus-visible'), color: style.outlineColor, width: style.outlineWidth };
      });
      assert(focus.visible); assert(parseFloat(focus.width) >= 2);
      assert(contrast(focus.color, palettes[mode]['primary-background-color']) >= 3, `${mode} host focus needs 3:1 contrast`);
    }
    assert.deepEqual(errors, []);
    console.log(`Native theme passed (${engine}): light/dark contrast, canvas materials, live unfinished edits, trusted bounded colors, standalone fallback.`);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
