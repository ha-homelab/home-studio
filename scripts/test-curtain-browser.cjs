// Real inspector/export/viewer coverage using fictional cover states only.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), { spawnSync } = require('node:child_process'), { chromium } = require('playwright');
const { browserLaunchOptions } = require('./browser-stability-diagnostics.cjs');
const root = path.resolve(__dirname, '..'), temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'curtain-browser-'));
const fixture = JSON.parse(spawnSync('node', ['scripts/test-curtain-authoring.mjs', '--fixture'], { cwd: root, encoding: 'utf8' }).stdout);
delete fixture.floors[0].items[0].curtain; fixture.floors[0].items[0].entity_id = '';

(async () => {
  let browser, server;
  try {
    server = http.createServer((request, response) => {
      const route = new URL(request.url, 'http://localhost').pathname;
      if (route === '/host') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><style>body{margin:0}iframe{width:100%;height:100vh;border:0}</style>'); return; }
      const file = path.resolve(root, '.' + route, route.endsWith('/') ? 'index.html' : '');
      if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
      try { response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' })[path.extname(file)] || 'text/html'); response.end(fs.readFileSync(file)); }
      catch { response.writeHead(404).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch(browserLaunchOptions('chromium', true));
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage(), errors = [], external = [];
    page.on('pageerror', error => errors.push(String(error)));
    await context.route('**/*', route => { if (route.request().url().startsWith(origin + '/')) return route.continue(); external.push(route.request().url()); return route.abort(); });
    await page.addInitScript(value => { if (window.top === window) localStorage.setItem('home-studio.project.v1', JSON.stringify(value)); }, fixture);
    await page.goto(origin + '/planner/'); await page.waitForFunction(() => window.planner);
    await page.locator('[data-object-kind="items"]').first().click();
    const field = name => page.locator('#inspector-body').getByLabel(name, { exact: true });
    const project = () => page.evaluate(() => planner.getProject());
    await field('Window opening').selectOption('window');
    let bound = await project();
    assert.deepEqual(bound.floors[0].items[0].curtain, { opening_id: 'window', mode: 'pair' });
    assert.equal(bound.floors[0].items[0].dimensions_m.width, 2.2);
    assert.equal(bound.floors[0].items[0].position_m.z, .185, 'Binding aligns the curtain just inside the wall');
    await page.locator('#undo').click(); assert.deepEqual(await project(), fixture, 'Binding and alignment undo together');
    await page.locator('#redo').click();
    await page.locator('[data-object-kind="rooms"]').first().click();
    await field('Depth (m)').fill('40'); await field('Depth (m)').press('Tab');
    await field('Width (m)').fill('2'); await field('Width (m)').press('Tab');
    const resized = (await project()).floors[0];
    assert.equal(resized.openings[0].width_m, 2); assert.equal(resized.openings[0].offset_m, 0);
    assert.deepEqual(resized.items[0].position_m, { x: 1, y: .03, z: .185 }, 'Bound curtain follows the clamped window and keeps its wall clearance');
    assert.deepEqual(resized.items[0].dimensions_m, bound.floors[0].items[0].dimensions_m);
    await page.locator('#undo').click(); await page.locator('#undo').click();
    assert.deepEqual(await project(), bound, 'Window-relative curtain movement undoes with the room resize');
    await page.locator('[data-object-kind="items"]').first().click();
    await field('Entity ID (optional)').fill('light.wrong'); await field('Entity ID (optional)').press('Tab');
    assert.equal(await field('Entity ID (optional)').getAttribute('aria-invalid'), 'true');
    await field('Entity ID (optional)').fill('cover.fixture'); await field('Entity ID (optional)').press('Tab');
    await field('Opening direction').selectOption('right');
    bound = await project(); assert.equal(bound.floors[0].items[0].curtain.mode, 'right');
    const source = bound.floors[0].items[0];
    const sharedColor = (await import('../planner/furniture.js')).getCatalogStyle(source.style_id).materials.metal;
    bound.floors[0].items = ['pair', 'left', 'right'].map(mode => ({ ...structuredClone(source), id: mode, entity_id: `cover.${mode}`, curtain: { opening_id: 'window', mode }, color: sharedColor, pattern_id: 'checks', pattern_color: sharedColor }));
    fs.writeFileSync(path.join(temporary, 'project.json'), JSON.stringify(bound));
    const compiled = spawnSync(process.env.PYTHON || 'python3', ['scripts/build-planner-project.py', '--project', path.join(temporary, 'project.json'), '--output', path.join(temporary, 'build')], { cwd: root, encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
    const model = JSON.parse(fs.readFileSync(path.join(temporary, 'build/ground/model-data.json')));
    assert(model.inventory.every(item => !Object.hasOwn(item, 'curtain')));
    let html = fs.readFileSync(path.join(temporary, 'build/ground/index.html'), 'utf8');
    // Read-only instrumentation exposes the actual meshes built by production
    // batching; state still enters through the ordinary authenticated port.
    html = html.replace('window.floorplan={model,', 'window.floorplan={model,get curtainGeometry(){return Object.fromEntries([...objectsById].map(([id,object])=>[id,object.children.filter(mesh=>mesh.isMesh).map(mesh=>({fabric:!!mesh.userData.curtainFabric,panel:mesh.userData.curtainPanel,positions:Array.from(mesh.geometry.attributes.position.array)}))]))},')
      .replace('<head>', '<head><script>window.__HOME_FLOORPLAN_EMBED__=true;</script>');
    await page.goto(origin + '/host');
    await page.evaluate(html => { const frame = document.createElement('iframe'); frame.sandbox = 'allow-scripts'; frame.srcdoc = html; document.body.append(frame); }, html);
    const viewer = await (await page.locator('iframe').elementHandle()).contentFrame();
    await viewer.waitForFunction(() => window.floorplan?.renderCount > 0);
    await page.evaluate(items => {
      const channel = new MessageChannel(); window.channel = channel.port1; window.messages = [];
      channel.port1.onmessage = event => {
        if (event.data.type === 'map_request' && event.data.action === 'get') {
          channel.port1.postMessage({ type:'map_result', request_id:event.data.request_id, success:true, result:{ revision:0, configured:false, config:null, reference:null } }); return;
        }
        messages.push(event.data);
      };
      document.querySelector('iframe').contentWindow.postMessage({ type: 'home-floorplan:init', can_edit: true, items }, '*', [channel.port2]);
    }, model.inventory);
    await page.waitForFunction(() => messages.some(message => message.type === 'model_config'));
    const publish = async (position, remembered = false) => {
      await page.evaluate(({ position, remembered }) => channel.postMessage({ type: 'states', connected: true, states: Object.fromEntries(['pair', 'left', 'right'].map(mode => [`cover.${mode}`, { state: remembered ? 'unavailable' : position === 0 ? 'closed' : 'open', cover: remembered ? { last_known: { position }, supported_features: 15 } : { current_position: position, supported_features: 15 } }])) }), { position, remembered });
      await viewer.waitForFunction(expected => document.querySelector('[data-home-device="pair"]')?.getAttribute('aria-label')?.includes(expected), `${remembered ? 'last known ' : 'HA reports '}${position}%`);
      return viewer.evaluate(() => floorplan.curtainGeometry);
    };
    const closed = await publish(0), half = await publish(50), open = await publish(100);
    for (const mode of ['pair', 'left', 'right']) {
      const fabric = data => data[mode].filter(mesh => mesh.fabric).flatMap(mesh => mesh.positions.filter((_, index) => index % 3 === 0));
      const fixed = data => data[mode].filter(mesh => !mesh.fabric);
      assert(fabric(open).length > 0, 'The exported catalog has moving fabric');
      assert.deepEqual(fixed(closed), fixed(open), 'The production renderer keeps rail batches separate');
      assert.notDeepEqual(fabric(closed), fabric(open));
      const a = fabric(closed), b = fabric(half), c = fabric(open);
      for (let index = 0; index < a.length; index++) assert(Math.abs(b[index] - (a[index] + c[index]) / 2) < 1e-6);
      if (mode === 'left') assert(Math.max(...c) < 0);
      if (mode === 'right') assert(Math.min(...c) > 0);
    }
    assert.deepEqual(await publish(50, true), half, 'Last known cover position uses the same geometry');
    assert.deepEqual(await publish(0), closed, 'State roundtrips have no deformation drift');
    assert.deepEqual(await page.evaluate(() => messages.filter(message => ['curtain_command', 'toggle', 'media_command'].includes(message.type))), []);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log('Curtain browser passed: explicit inspector binding, alignment/Undo, cover-only validation, exported metadata, production fabric batching, live and remembered positions, fixed rails, no commands.');
  } finally {
    await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
