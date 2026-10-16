// Real browser UI + isolated mock companion. No provider calls or household data.
// AI_PLANNER_ENGINES=chromium,firefox,webkit node scripts/test-ai-planner.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const playwright = require('playwright');
const { browserLaunchOptions } = require('./browser-stability-diagnostics.cjs');
const root = path.resolve(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'planner/catalog.json')));
const engines = (process.env.AI_PLANNER_ENGINES || 'chromium').split(',');
const secret = 'SYNTHETIC_KEY_MUST_NEVER_PERSIST', promptMarker = 'SYNTHETIC_PRIVATE_INSTRUCTION', photoMarker = 'SYNTHETIC_EXIF_PRIVATE_MARKER';
function crc(bytes) { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const body = Buffer.concat([Buffer.from(type), data]), size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(body)); return Buffer.concat([size, body, checksum]); }
function png(width = 64, height = 48, headerOnly = false) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('tEXt', Buffer.from(`Comment\0${photoMarker}`)), ...(headerOnly ? [] : [chunk('IDAT', zlib.deflateSync(Buffer.alloc((width * 3 + 1) * height, 0)))]), chunk('IEND', Buffer.alloc(0))]);
}
function item(id, key, position) {
  const model = catalog.models.find(value => value.id === id);
  return { candidate_key: key, name: key === 'sofa' ? 'Suggested <img onerror="alert(1)"> sofa' : 'Suggested lamp', model_id: id, style_id: model.default_style, position_m: { x: position[0], y: 0, z: position[1] }, dimensions_m: { ...model.dimensions_m }, rotation_deg: 0, evidence: 'SYNTHETIC_REVIEW_EVIDENCE; catalog size, not measured.' };
}
function draft(body) {
  const result = { draft_version: 1, request_id: body.request_id, kind: body.mode, items: body.mode === 'new_room' ? [item('sofa_3', 'sofa', [2, 1.3]), item('floor_lamp', 'lamp', [.6, 2.5])] : [item('floor_lamp', 'lamp', [3.6, 2.6])], assumptions: ['Furniture dimensions are estimates from the catalog.'], needs_measurements: ['Confirm the sofa width.'] };
  if (body.mode === 'new_room') Object.assign(result, { room_name: 'Fictional measured room', openings: [{ candidate_key: 'window', type: 'window', edge_index: 0, offset_m: 1, width_m: 1, sill_m: .9, head_m: 2.1 }, { candidate_key: 'door', type: 'door', edge_index: 3, offset_m: 1, width_m: .8, sill_m: 0, head_m: 2.1 }] });
  return result;
}
const bodies = [], connections = new Map(); let counter = 0, responseMode = 'valid', held = null, delayConnect = false, heldConnect = null;
const json = (response, code, value) => response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname.startsWith('/api/ai/')) {
    const token = request.headers['x-home-studio-session'];
    assert(connections.has(token), 'API must carry per-tab session header');
    let body; if (request.method === 'POST') { try { const parts = []; for await (const part of request) parts.push(part); body = JSON.parse(Buffer.concat(parts)); } catch { response.destroy(); return; } }
    bodies.push({ path: url.pathname, body, token });
    if (url.pathname.endsWith('/providers')) return json(response, 200, { providers: [{ id: 'openai', label: 'OpenAI', local: false, default_endpoint: 'https://api.openai.com/v1/responses', requires_key: true }, { id: 'ollama', label: 'Ollama', local: true, default_endpoint: 'http://127.0.0.1:11434/api/chat', requires_key: false }, { id: 'openrouter', label: 'OpenRouter', local: false, default_endpoint: 'https://openrouter.ai/api/v1/chat/completions', requires_key: true }] });
    if (url.pathname.endsWith('/connect')) {
      const finish = () => { connections.set(token, { connected: true, ...body, api_key: undefined, expires_at: Math.floor(Date.now() / 1000) + 1800 }); json(response, 200, connections.get(token)); };
      if (delayConnect) { heldConnect = finish; return; } finish(); return;
    }
    if (url.pathname.endsWith('/disconnect')) { connections.set(token, { connected: false }); return json(response, 200, { connected: false }); }
    if (url.pathname.endsWith('/status')) return json(response, 200, connections.get(token));
    if (url.pathname.endsWith('/cancel')) return json(response, 200, { cancelled: true });
    if (url.pathname.endsWith('/generate')) {
      if (responseMode === 'hold') { held = () => json(response, 200, { draft: draft(body) }); return; }
      if (responseMode === 'refuse') return json(response, 400, { error: { code: 'provider_refusal', message: 'Should not echo upstream messages.' } });
      const result = draft(body); if (responseMode === 'invalid') result.items[0].model_id = 'untrusted_asset';
      return json(response, 200, { draft: result });
    }
    return json(response, 404, {});
  }
  const relative = url.pathname === '/planner/' ? 'planner/index.html' : url.pathname.slice(1);
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) return response.writeHead(404).end();
  let body = fs.readFileSync(target);
  if (relative === 'planner/index.html' && !url.searchParams.has('static')) {
    const token = `test_session_${++counter}`; connections.set(token, { connected: false });
    body = Buffer.from(body.toString().replace("connect-src 'none'", "connect-src 'self'; worker-src 'self'").replace('</head>', `<meta name="home-studio-ai-session" content="${token}"></head>`).replace('</body>', '<script type="module" src="/ai/bootstrap.js"></script></body>'));
  }
  response.writeHead(200, { 'Content-Type': relative.endsWith('.html') ? 'text/html' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.json') ? 'application/json' : 'text/javascript', 'Cache-Control': 'no-store', ...(relative === 'ai/photo-worker.js' ? { 'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'none'; img-src blob:" } : {}) }); response.end(body);
});
function python(args) {
  const result = spawnSync(process.env.PYTHON || 'python3', args, { cwd: root, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
}
async function waitPreview(page, expected) {
  try {
    await page.waitForFunction(expected => {
      const metadata = window.planner.getPreviewMetadata();
      if (metadata.error) throw new Error(`3D preview failed: ${metadata.error}`);
      return Object.entries(expected).every(([key, value]) => metadata[key] === value);
    }, expected);
  } catch (error) {
    const details = await page.evaluate(() => ({ metadata: window.planner.getPreviewMetadata(),
      view: window.planner.getView(), rendererMessage: document.getElementById('preview-error').textContent,
      visibility: document.visibilityState })).catch(() => ({ pageClosed: true }));
    throw new Error(`3D preview did not reach ${JSON.stringify(expected)}: ${JSON.stringify(details)}`, { cause: error });
  }
}
const waitStatus = (page, text) => page.waitForFunction(value => document.getElementById('ai-status').textContent.includes(value), text);
async function waitHeld(which = 'generate') {
  const deadline = Date.now() + 5000;
  while (!(which === 'connect' ? heldConnect : held)) {
    if (Date.now() > deadline) throw new Error(`Mock ${which} request did not arrive.`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function state(page) { return page.evaluate(() => window.planner.getProject()); }
async function connect(page, provider = 'openai') {
  await page.locator('#ai-provider').selectOption(provider); await page.locator('#ai-model').fill('synthetic-vision-model');
  if (provider === 'openai') await page.locator('#ai-key').fill(secret);
  await page.locator('#ai-connect').click(); await waitStatus(page, 'Session connected');
  assert.equal(await page.locator('#ai-key').inputValue(), '');
}
async function generate(page) { await page.locator('#ai-generate').click(); await waitStatus(page, 'Draft ready'); }
async function run(engine, origin) {
  assert(['chromium', 'firefox', 'webkit'].includes(engine), `Unknown AI_PLANNER_ENGINES engine: ${engine}`);
  const browser = await playwright[engine].launch(browserLaunchOptions(engine, process.env.AI_PLANNER_HEADED !== '1'));
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-studio-ai-ui-')));
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, acceptDownloads: true });
    const page = await context.newPage(), errors = [], external = [];
    page.on('pageerror', error => errors.push(String(error))); page.on('dialog', dialog => dialog.accept());
    page.on('request', request => { if (!request.url().startsWith(origin + '/') && !request.url().startsWith('blob:') && !request.url().startsWith('data:')) external.push(request.url()); });
    await page.goto(`${origin}/planner/?static=1`); await page.waitForFunction(() => Boolean(window.planner));
    assert.equal(await page.locator('#ai-open').count(), 0, 'ordinary planner has no AI entry point');
    assert.equal(bodies.length, 0, 'ordinary planner makes no AI calls');
    await page.goto(`${origin}/planner/`); await page.locator('#ai-open').click(); await page.waitForFunction(() => !document.getElementById('ai-provider').disabled);
    await connect(page); assert.equal(bodies.filter(value => value.path.endsWith('/generate')).length, 0, 'connect must not run inference');
    await page.locator('#ai-mode').selectOption('new_room'); await page.locator('#ai-instructions').fill(promptMarker);
    const initial = await state(page), initialStorage = await page.evaluate(() => localStorage.getItem('home-studio.project.v1'));
    await page.locator('#ai-photos-input').setInputFiles({ name: 'synthetic-photo.png', mimeType: 'image/png', buffer: png() });
    await page.waitForFunction(() => document.getElementById('ai-photo-progress').textContent.includes('1 photos ready'));
    assert.equal(bodies.filter(value => value.path.endsWith('/generate')).length, 0, 'choosing photos must not send them');
    await generate(page);
    const sent = bodies.findLast(value => value.path.endsWith('/generate')).body;
    assert.equal(sent.instructions, promptMarker); assert.equal(sent.images.length, 1); assert.equal(sent.images[0].mime_type, 'image/jpeg');
    assert(!Buffer.from(sent.images[0].data, 'base64').includes(Buffer.from(photoMarker)), 'reencoding removes original photo metadata');
    assert(!JSON.stringify(sent.context).includes(secret));
    assert.deepEqual(await state(page), initial, 'preview cannot mutate accepted project');
    assert.equal(await page.evaluate(() => localStorage.getItem('home-studio.project.v1')), initialStorage, 'preview cannot autosave');
    const [beforeApplyDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#export-project').click()]);
    const beforeApplyPath = path.join(temporary, 'before-apply.json'); await beforeApplyDownload.saveAs(beforeApplyPath);
    assert.deepEqual(JSON.parse(fs.readFileSync(beforeApplyPath, 'utf8')), initial, 'export during preview contains only the accepted plan');
    assert.equal(await page.locator('#ai-candidates img').count(), 0, 'candidate names are text, not HTML');
    await page.locator('#preview-tab').click();
    await waitPreview(page, { items: 2 });
    assert.equal((await page.evaluate(() => window.planner.getPreviewMetadata())).rooms, 1, '3D renders detached room');
    await page.locator('input[data-candidate-key="lamp"]').uncheck();
    assert((await page.locator('#ai-review-summary').textContent()).includes('1 item'), 'review counts follow candidate selection');
    const sofaDetail = page.locator('.ai-candidate').filter({ has: page.locator('input[data-candidate-key="sofa"]') });
    await sofaDetail.locator('summary').click(); await sofaDetail.getByLabel('width (m) · Suggested <img onerror="alert(1)"> sofa', { exact: true }).fill('2.1');
    await sofaDetail.getByLabel('width (m) · Suggested <img onerror="alert(1)"> sofa', { exact: true }).press('Tab');
    await page.locator('#ai-review-confirm').check(); await page.locator('#ai-apply').click(); await waitStatus(page, 'Selected additions applied');
    const accepted = await state(page); assert.equal(accepted.floors[0].rooms.length, 1); assert.equal(accepted.floors[0].items.length, 1); assert.equal(accepted.floors[0].walls.length, 4); assert.equal(accepted.floors[0].openings.length, 2); assert.equal(accepted.floors[0].items[0].dimensions_m.width, 2.1);
    assert.equal(await page.locator('#ai-photos img').count(), 0, 'apply releases photos');
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export-project').click()]); const exported = path.join(temporary, 'project.json'); await download.saveAs(exported);
    const exportedText = fs.readFileSync(exported, 'utf8'); assert.deepEqual(JSON.parse(exportedText), accepted);
    const built = path.join(temporary, 'built'), config = path.join(temporary, 'ha-config');
    fs.mkdirSync(config); fs.writeFileSync(path.join(config, 'configuration.yaml'), 'default_config:\n');
    python(['scripts/build-planner-project.py', '--project', exported, '--output', built, '--ha-package']);
    python(['scripts/install-home-assistant.py', path.join(built, 'home-floorplan.tar.gz'), '--config', config, '--dry-run']);
    python(['scripts/install-home-assistant.py', path.join(built, 'home-floorplan.tar.gz'), '--config', config]);
    for (const marker of [secret, promptMarker, photoMarker, 'SYNTHETIC_REVIEW_EVIDENCE']) assert(!exportedText.includes(marker), `exports exclude ${marker}`);
    assert.equal(await page.evaluate(() => sessionStorage.length), 0);
    const storage = await page.evaluate(() => JSON.stringify({ ...localStorage })); for (const marker of [secret, promptMarker, photoMarker, 'SYNTHETIC_REVIEW_EVIDENCE']) assert(!storage.includes(marker), 'AI inputs must never persist');
    await page.locator('#undo').click(); assert.deepEqual(await state(page), initial, 'one Undo reverses all AI additions'); await page.locator('#redo').click(); assert.deepEqual(await state(page), accepted);
    const existing = structuredClone(accepted); existing.floors[0].items[0].entity_id = 'light.synthetic_private_binding'; existing.floors[0].items[0].notes = 'SYNTHETIC_PRIVATE_NOTE';
    existing.floors[0].rooms.push({ id: 'private_room', name: 'SYNTHETIC_UNRELATED_ROOM', polygon: [[10, 0], [14, 0], [14, 3], [10, 3]], material: 'floor' });
    await page.locator('#file-input').setInputFiles({ name: 'existing.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(existing)) });
    await page.waitForFunction(() => window.planner.getProject().floors[0].rooms.length === 2);
    await page.locator('#plan-tab').click(); await page.locator('[data-object-kind="rooms"]').first().click(); await page.locator('#ai-mode').selectOption('furnish_room');
    await generate(page); await page.locator('#ai-discard').click(); assert.deepEqual(await state(page), existing, 'discard preserves existing geometry');
    await generate(page);
    const limitedContext = JSON.stringify(bodies.findLast(value => value.path.endsWith('/generate')).body.context);
    for (const marker of ['synthetic_private_binding', 'SYNTHETIC_PRIVATE_NOTE', 'SYNTHETIC_UNRELATED_ROOM']) assert(!limitedContext.includes(marker), 'request omits bindings, notes, and unrelated rooms');
    await page.locator('#ai-review-confirm').check(); await page.locator('#ai-apply').click(); await waitStatus(page, 'Selected additions applied');
    const furnished = await state(page); assert.equal(furnished.floors[0].items.length, 2); assert.deepEqual(furnished.floors[0].items[0], existing.floors[0].items[0]); assert.deepEqual(furnished.floors[0].rooms, existing.floors[0].rooms); assert.deepEqual(furnished.floors[0].walls, existing.floors[0].walls); assert.deepEqual(furnished.floors[0].openings, existing.floors[0].openings);
    await page.locator('#undo').click(); assert.deepEqual(await state(page), existing); await page.locator('[data-object-kind="rooms"]').first().click();
    responseMode = 'hold'; await page.locator('#ai-generate').click(); await page.waitForFunction(() => document.getElementById('ai-status').textContent.includes('Generating'));
    await waitHeld();
    await page.locator('#preview-tab').click(); await waitPreview(page, { rooms: 2 });
    await page.locator('#plan-tab').click();
    await page.locator('#project-title').fill('Edited while waiting'); await page.locator('#project-title').press('Tab');
    await waitStatus(page, 'plan or selection changed'); held(); held = null;
    await page.waitForTimeout(100); assert(await page.locator('#ai-review').isHidden()); assert.equal((await state(page)).title, 'Edited while waiting');
    // Selection changes invalidate outstanding results, including changing away and back.
    await page.locator('#ai-generate').click(); await waitHeld();
    await page.locator('[data-object-kind="walls"]').first().click(); await waitStatus(page, 'plan or selection changed'); held(); held = null;
    await page.locator('[data-object-kind="rooms"]').first().click();
    await page.locator('#ai-generate').click(); await waitHeld(); await page.locator('#ai-cancel-request').click(); held(); held = null; await waitStatus(page, 'cancelled');
    await page.locator('#ai-generate').click(); await waitHeld(); await page.locator('#undo').click();
    await waitStatus(page, 'plan or selection changed'); held(); held = null; await page.locator('[data-object-kind="rooms"]').first().click();
    await page.locator('#ai-generate').click(); await waitHeld();
    await page.locator('#file-input').setInputFiles({ name: 'reopened.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(existing)) });
    await waitStatus(page, 'plan or selection changed'); held(); held = null; await page.locator('[data-object-kind="rooms"]').first().click();
    responseMode = 'invalid'; await page.locator('#ai-generate').click(); await waitStatus(page, 'Unknown furniture model'); assert(await page.locator('#ai-review').isHidden());
    responseMode = 'refuse'; await page.locator('#ai-generate').click(); await waitStatus(page, 'AI request failed'); assert(!(await page.locator('#ai-status').textContent()).includes('Should not echo'));
    responseMode = 'valid';
    await page.locator('#ai-photos-input').setInputFiles({ name: 'too-many-pixels.png', mimeType: 'image/png', buffer: png(6000, 5000, true) }); await waitStatus(page, '24 megapixels');
    await page.locator('#ai-photos-input').setInputFiles({ name: 'unsafe.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') }); await waitStatus(page, 'Convert this image');
    await page.locator('#ai-provider').selectOption('openrouter'); assert((await page.locator('#ai-privacy').textContent()).includes('upstream provider'));
    await connect(page, 'ollama'); assert(await page.locator('#ai-key-label').isVisible()); assert((await page.locator('#ai-key-label').textContent()).includes('optional'));
    await page.locator('#ai-disconnect').click(); await waitStatus(page, 'Session ended'); assert.equal(await page.locator('#ai-instructions').inputValue(), ''); assert.equal(await page.locator('#ai-key').inputValue(), '');
    // A delayed Connect cannot resurrect a credential after End session.
    await page.locator('#ai-provider').selectOption('openai'); await page.locator('#ai-key').fill(secret);
    delayConnect = true; await page.locator('#ai-connect').click(); await waitHeld('connect');
    await page.locator('#ai-disconnect').click();
    assert(await page.locator('#ai-connect').isDisabled(), 'new connections wait for pending-connect cleanup');
    heldConnect(); heldConnect = null; delayConnect = false;
    await page.waitForFunction(() => !document.getElementById('ai-connect').disabled);
    const token = await page.locator('meta[name="home-studio-ai-session"]').getAttribute('content');
    assert.equal(connections.get(token).connected, false, 'final Disconnect runs after the delayed Connect');
    assert((await page.locator('#ai-connection').textContent()).startsWith('Disconnected'));
    const second = await context.newPage(); await second.goto(`${origin}/planner/`); await second.locator('#ai-open').click();
    assert((await second.locator('#ai-connection').textContent()).startsWith('Disconnected'), 'new tab never inherits provider connection');
    assert.notEqual(await second.locator('meta[name="home-studio-ai-session"]').getAttribute('content'), await page.locator('meta[name="home-studio-ai-session"]').getAttribute('content'));
    assert.deepEqual(external, [], 'browser never contacts a provider directly'); assert.deepEqual(errors, [], 'browser errors');
    if (process.env.AI_PLANNER_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.AI_PLANNER_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.AI_PLANNER_SCREENSHOT_DIR, `${engine}-ai-planner.png`) });
    }
    console.log(`${engine}: AI photos → detached 2D/3D review → partial apply → undo → export; cancellation, stale edits/selection, invalid drafts, privacy, and worker limits passed.`);
    await context.close();
  } finally { await browser.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { for (const engine of engines) { bodies.length = 0; responseMode = 'valid'; held = null; await run(engine, `http://127.0.0.1:${server.address().port}`); } }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
