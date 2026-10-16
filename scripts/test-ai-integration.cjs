// Exercise the real Python companion and strict browser CSP against a local fake
// Ollama. No provider credentials, external network, or household data are used.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const playwright = require('playwright');
const root = path.resolve(__dirname, '..');
const engines = (process.env.AI_PLANNER_ENGINES || 'chromium').split(',');
let inferenceCount = 0;
const runtime = http.createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/api/chat');
    assert.equal(request.method, 'POST');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks));
    assert.equal(payload.model, 'synthetic-vision');
    assert.equal(payload.stream, false);
    assert.equal(payload.format.additionalProperties, false);
    assert(payload.format.properties.items.items.required.includes('color'));
    assert.equal(payload.options.num_predict, 8192);
    assert.equal(payload.options.num_ctx, 32768);
    assert.equal(payload.messages[1].images.length, 1);
    assert(Buffer.from(payload.messages[1].images[0], 'base64').subarray(0, 2).equals(Buffer.from([255, 216])));
    const context = JSON.parse(payload.messages[1].content);
    assert.equal(context.mode, 'new_room');
    assert.equal(context.context.measurements.width, 4);
    inferenceCount++;
    const draft = { draft_version: 1, request_id: context.request_id, kind: 'new_room', room_name: 'Fictional photo room',
      items: [{ candidate_key: 'table', name: 'Round table', model_id: 'dining_table', style_id: 'contemporary',
        position_m: { x: 2, y: 0, z: 1.5 }, dimensions_m: { width: 1.4, depth: .8, height: .75 },
        rotation_deg: 0, color: null, pattern_id: null, pattern_color: null, evidence: 'Synthetic fixture; confirm table measurements.' }],
      openings: [], assumptions: ['Furniture size is estimated.'], needs_measurements: [] };
    // Resolve a real catalog model rather than depend on a specific historical ID.
    const catalog = JSON.parse(fs.readFileSync(path.join(root, 'planner/catalog.json')));
    const table = catalog.models.find(item => item.id === 'round_dining_table');
    draft.items[0].model_id = table.id; draft.items[0].style_id = table.default_style;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(draft) }, done: true, done_reason: 'stop' }));
  } catch (error) { response.writeHead(500); response.end('{}'); console.error(error); }
});
function startCompanion() {
  const child = spawn(process.env.PYTHON || 'python3', ['-u', '-c',
    "from pathlib import Path; from ai_companion.server import CompanionServer; s=CompanionServer(('127.0.0.1',0),Path.cwd()); print(s.origin,flush=True); s.serve_forever()"],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let output = '', errors = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Companion startup timeout')); }, 10000);
    child.stderr.on('data', data => { errors += data; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); if (!output.includes('http://')) reject(new Error(`Companion exited ${code}: ${errors}`)); });
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timeout); resolve({ child, origin: match[0] }); }
    });
  });
}
(async () => {
  await new Promise(resolve => runtime.listen(0, '127.0.0.1', resolve));
  let companion;
  try {
    companion = await startCompanion();
    for (const engine of engines) {
      assert(['chromium', 'firefox', 'webkit'].includes(engine));
      const browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}) });
      try {
        const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
        const errors = [], external = [];
        page.on('pageerror', error => errors.push(String(error)));
        page.on('request', request => { if (!request.url().startsWith(companion.origin) && !/^(blob|data):/.test(request.url())) external.push(request.url()); });
        await page.goto(companion.origin + '/planner/?lang=en');
        await page.locator('#ai-open').click();
        await page.waitForFunction(() => !document.getElementById('ai-provider').disabled);
        await page.locator('#ai-provider').selectOption('ollama');
        await page.locator('#ai-model').fill('synthetic-vision');
        await page.locator('#ai-endpoint').fill(`http://127.0.0.1:${runtime.address().port}`);
        await page.locator('#ai-connect').click();
        await page.waitForFunction(() => document.getElementById('ai-status').textContent.includes('Session connected'));
        await page.locator('#ai-mode').selectOption('new_room');
        await page.locator('#ai-instructions').fill('Sketch the synthetic measured room.');
        const photo = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64; const c = canvas.getContext('2d'); c.fillStyle = '#368d9e'; c.fillRect(0,0,64,64); return canvas.toDataURL('image/png').split(',')[1]; });
        await page.locator('#ai-photos-input').setInputFiles({ name: 'fictional.png', mimeType: 'image/png', buffer: Buffer.from(photo, 'base64') });
        await page.waitForFunction(() => document.getElementById('ai-photo-progress').textContent.includes('1 photos ready'));
        const before = await page.evaluate(() => window.planner.getProject());
        await page.locator('#ai-generate').click();
        await page.waitForFunction(() => document.getElementById('ai-status').textContent.includes('Draft ready'));
        assert.deepEqual(await page.evaluate(() => window.planner.getProject()), before);
        if (process.env.AI_REVIEW_SCREENSHOT && engine === 'chromium') {
          await page.locator('#preview-tab').click();
          await page.waitForFunction(() => window.planner.getPreviewMetadata().items === 1);
          await page.locator('#ai-review-title').evaluate(node => node.scrollIntoView({ block: 'start' }));
          await page.screenshot({ path: process.env.AI_REVIEW_SCREENSHOT, type: 'jpeg', quality: 88 });
        }
        await page.locator('#ai-review-confirm').check(); await page.locator('#ai-apply').click();
        await page.waitForFunction(() => window.planner.getProject().floors[0].rooms.length === 1);
        await page.locator('#undo').click();
        assert.deepEqual(await page.evaluate(() => window.planner.getProject()), before);
        await page.locator('#ai-disconnect').click();
        assert.deepEqual(external, []); assert.deepEqual(errors, []);
        console.log(`${engine}: real companion → local fake Ollama → photo preparation → draft → Apply/Undo passed`);
      } finally { await browser.close(); }
    }
    assert.equal(inferenceCount, engines.length);
  } finally {
    if (companion?.child.exitCode === null) { const stopped = new Promise(resolve => companion.child.once('exit', resolve)); companion.child.kill(); await stopped; }
    runtime.closeAllConnections(); await new Promise(resolve => runtime.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
