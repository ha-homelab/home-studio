// Real browser-to-compiler-to-installer coverage using a fictional home only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'planner/catalog.json')));
const files = new Map([
  ...['pbr-color-data.js','pbr-materials.js','material-textures.js','environment-lighting.js'].map(name=>[name,[name,'text/javascript']]),
  ['planner/', ['planner/index.html', 'text/html']],
  ...['editor', 'model', 'site-model', 'site-editor', 'catalog', 'furniture', 'i18n', 'validation', 'language-links', 'render-capacity', 'interaction-render', 'environment', 'onboarding', 'device-onboarding', 'device-onboarding-ui', 'room-transform', 'draft-storage', 'inspector-dom', 'floor-navigator', 'ha-bridge'].map(name => [`planner/${name}.js`, [`planner/${name}.js`, 'text/javascript']]),
  ...fs.readdirSync(path.join(root, 'planner/locales')).filter(name => name.endsWith('.js')).map(name => [`planner/locales/${name}`, [`planner/locales/${name}`, 'text/javascript']]),
  ['planner/editor.css', ['planner/editor.css', 'text/css']],
  ['planner/site-editor.css', ['planner/site-editor.css', 'text/css']],
  ['planner/floor-navigator.css', ['planner/floor-navigator.css', 'text/css']],
  ['vendor/three.module.min.js', ['vendor/three.module.min.js', 'text/javascript']],
]);
function runPython(args) {
  const result = spawnSync(process.env.PYTHON || 'python3', args, { cwd: root, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
}
function findFiles(folder, name) {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(folder, entry.name);
    return entry.isDirectory() ? findFiles(file, name) : entry.name === name ? [file] : [];
  });
}

(async () => {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-studio-furniture-')));
  let compiledPage;
  const server = http.createServer((request, response) => {
    const route = new URL(request.url, 'http://localhost').pathname.replace(/^\/(?:home-studio\/)?/, '');
    if (route === 'compiled/' && compiledPage) {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end(compiledPage); return;
    }
    const file = files.get(route);
    if (!file) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' });
    response.end(fs.readFileSync(path.join(root, file[0])));
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
      args: ['--enable-webgl', '--use-angle='+(process.env.CHROMIUM_ANGLE_BACKEND||'swiftshader'), '--enable-unsafe-swiftshader'] });
    const errors = [], external = [];
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => errors.push(String(error)));
    page.on('dialog', dialog => dialog.accept());
    page.on('request', request => { if (!request.url().startsWith(origin + '/') && !request.url().startsWith('data:')) external.push(request.url()); });
    const project = () => page.evaluate(() => window.planner.getProject());
    const lastItem = async () => (await project()).floors[0].items.at(-1);
    const change = async (label, value) => {
      const input = page.locator('#inspector-body').getByLabel(label, { exact: true });
      await input.fill(String(value)); await input.press('Tab');
    };
    const chooseModel = async id => {
      await page.locator('#browse-items').click();
      await page.locator('#library-clear').click();
      await page.locator('#library-search').fill(catalog.models.find(model => model.id === id).label);
      await page.locator(`.library-card[data-model-id="${id}"]`).click();
    };
    const placeCenter = async () => {
      await page.locator('button[title="room: Room 1"]').click();
      await page.getByRole('button', { name: 'Place item at room center' }).click();
    };
    const importProject = async value => {
      await page.locator('#file-input').setInputFiles({ name: 'fictional.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
      await page.waitForFunction(expected => JSON.stringify(window.planner.getProject()) === expected, JSON.stringify(value));
      assert.deepEqual(await project(), value);
    };
    await page.goto(origin + '/home-studio/planner/');
    await page.getByRole('button', { name: 'Add room', exact: true }).click();
    await page.getByRole('button', { name: 'Build wall outline' }).click();
    await page.locator('#fit-view').click();
    await page.locator('#browse-items').click();
    assert.equal(await page.locator('.library-card').count(), Math.min(24, catalog.models.length));
    assert.match(await page.locator('#library-count').innerText(), new RegExp(`of ${catalog.models.length} designs`));
    while (await page.locator('#library-more').isVisible()) {
      const previous = await page.locator('.library-card').count();
      await page.locator('#library-more').focus(); await page.keyboard.press('Enter');
      assert.equal(await page.locator(':focus').getAttribute('data-model-id'), catalog.models[previous].id,
        'Keyboard pagination focuses the first newly available design, including the final page');
    }
    assert.equal(await page.locator('.library-card').count(), catalog.models.length);
    assert.equal(new Set(await page.locator('.library-card').evaluateAll(cards => cards.map(card => card.dataset.modelId))).size, catalog.models.length);
    await page.locator('#library-category').selectOption('seating');
    assert.equal(await page.locator('.library-card').count(), catalog.models.filter(model => model.category === 'seating').length);
    await page.locator('#library-search').fill('not-a-real-chair');
    assert(await page.locator('#library-empty').isVisible());
    await page.locator('#library-clear').click();
    assert.equal(await page.locator('.library-card').count(), Math.min(24, catalog.models.length));
    if (process.env.PLANNER_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.PLANNER_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.PLANNER_SCREENSHOT_DIR, '08-library.jpg'), type: 'jpeg', quality: 88 });
    }
    await page.locator('#library-category').selectOption('technology');
    await page.locator('#library-search').fill('rack');
    assert(await page.locator('.library-card[data-model-id="server_rack"]').isVisible());
    await page.locator('#library-clear').click();
    await page.locator('#library-search').fill('hipster');
    assert(await page.locator('.library-card[data-model-id="cafe_racer_motorcycle"]').isVisible());
    await page.locator('[data-close="library-dialog"]').click();
    // Pick real new designs through the UI, including each new shape family.
    for (const id of ['server_rack', 'teddy_bear', 'tesla_model_y', 'cafe_racer_motorcycle', 'retro_moped', 'skis_and_poles',
      'road_bicycle', 'satellite_dish', 'kilim_rug', 'tasseled_wall_rug', 'sunburst_mirror', 'starburst_chandelier',
      'globe_wall_sconce', 'classic_balustrade', 'christmas_tree', 'standing_brown_bear', 'square_cushion', 'curtain_pair_open', 'nursery_crib', 'hanging_egg_chair']) {
      await chooseModel(id); await placeCenter();
      assert.equal((await lastItem()).model_id, id);
      await page.getByLabel('Color palette', { exact: true }).selectOption('ocean_blue');
      assert.equal((await lastItem()).style_id, 'ocean_blue');
      await page.getByRole('button', { name: 'Delete item', exact: true }).click();
    }
    await page.locator('#browse-items').click();
    await page.locator('#library-clear').click();
    await page.locator('#library-search').fill('three seat');
    assert.equal(await page.locator('.library-card').count(), 1);
    await page.locator('.library-card[data-model-id="sofa_3"]').click();
    await placeCenter();
    assert.equal((await lastItem()).model_id, 'sofa_3');
    await page.getByLabel('Color palette', { exact: true }).selectOption('warm_wood');
    await page.getByRole('button', { name: 'Ocean', exact: true }).click();
    await change('Width (m)', 2.8);
    await change('Rotation (degrees)', 30);
    await change('Item name', 'Reading sofa');
    const customized = await lastItem();
    assert.equal(customized.color, '#507b95'); assert.equal(customized.style_id, 'warm_wood');
    assert.equal(customized.dimensions_m.width, 2.8); assert.equal(customized.rotation_deg, 30);
    await page.getByLabel('Custom body color', { exact: true }).fill('#a14283');
    assert.equal((await lastItem()).color, '#a14283');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.equal((await lastItem()).color, '#507b95');
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    assert.equal((await lastItem()).color, '#a14283');
    await page.locator('button[title="item: Reading sofa"]').click();
    await page.getByLabel('Design', { exact: true }).selectOption('sofa_2');
    assert.equal((await lastItem()).dimensions_m.width, 2.8, 'Switching design retains explicit dimensions');
    assert.equal((await lastItem()).name, 'Reading sofa');
    await page.getByRole('button', { name: 'Use design’s original size' }).click();
    assert.deepEqual((await lastItem()).dimensions_m, catalog.models.find(model => model.id === 'sofa_2').dimensions_m);
    await page.getByLabel('Color palette', { exact: true }).selectOption('monochrome');
    assert(!Object.hasOwn(await lastItem(), 'color'), 'A coordinated finish resets the body override');
    await page.getByRole('button', { name: 'Ocean', exact: true }).click();

    // Patterns update the real preview and survive every export/install boundary.
    const plainAppearance = await page.locator('.appearance-preview').evaluate(canvas => canvas.toDataURL());
    await page.getByLabel('Surface pattern', { exact: true }).selectOption('checks');
    await page.getByLabel('Pattern color', { exact: true }).fill('#ffeedd');
    assert.equal((await lastItem()).pattern_id, 'checks');
    assert.equal((await lastItem()).pattern_color, '#ffeedd');
    assert.notEqual(await page.locator('.appearance-preview').evaluate(canvas => canvas.toDataURL()), plainAppearance);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    assert(!Object.hasOwn(await lastItem(), 'pattern_color'));
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    assert.equal((await lastItem()).pattern_color, '#ffeedd');
    await page.locator('button[title="item: Reading sofa"]').click();
    await page.getByLabel('Color palette', { exact: true }).selectOption('sage_linen');
    assert(!Object.hasOwn(await lastItem(), 'color')); assert(!Object.hasOwn(await lastItem(), 'pattern_color'));
    assert.equal((await lastItem()).pattern_id, 'checks');
    await page.getByLabel('Design', { exact: true }).selectOption('floor_lamp');
    assert(!Object.hasOwn(await lastItem(), 'pattern_id')); assert(!Object.hasOwn(await lastItem(), 'pattern_color'));
    assert.equal(await page.getByLabel('Surface pattern', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.equal((await lastItem()).color, '#507b95'); assert.equal((await lastItem()).pattern_color, '#ffeedd');

    // Catalog and basic shapes must remain explicitly selectable even for the same type.
    await page.locator('.basic-items summary').click();
    await page.locator('#place-type').selectOption('furniture');
    await placeCenter();
    assert(!Object.hasOwn(await lastItem(), 'model_id'));
    await page.getByRole('button', { name: 'Delete item', exact: true }).click();
    await chooseModel('rug'); await placeCenter();
    const plainRug = await page.locator('#plan-canvas').evaluate(canvas => canvas.toDataURL());
    for (const pattern of ['stripes', 'checks', 'diamonds', 'dots', 'herringbone', 'chevrons']) {
      await page.getByLabel('Surface pattern', { exact: true }).selectOption(pattern);
      assert.equal((await lastItem()).pattern_id, pattern);
    }
    assert.notEqual(await page.locator('#plan-canvas').evaluate(canvas => canvas.toDataURL()), plainRug);
    await page.getByLabel('Surface pattern', { exact: true }).selectOption('none');
    assert(!Object.hasOwn(await lastItem(), 'pattern_id')); assert(!Object.hasOwn(await lastItem(), 'pattern_color'));
    await page.getByLabel('Surface pattern', { exact: true }).selectOption('herringbone');
    const withRug = await project();
    await page.locator('#plan-canvas').focus(); await page.keyboard.press('Escape');
    const beforeOrder = await page.locator('#plan-canvas').evaluate(canvas => canvas.toDataURL());
    withRug.floors[0].items.reverse(); await importProject(withRug);
    const afterOrder = await page.locator('#plan-canvas').evaluate(canvas => canvas.toDataURL());
    assert.equal(afterOrder, beforeOrder, 'Top-down surfaces follow height, not insertion order');
    const center = await page.evaluate(() => window.planner.worldToScreen([2, 2]));
    const box = await page.locator('#plan-canvas').boundingBox();
    await page.mouse.click(box.x + center[0], box.y + center[1]);
    assert.equal(await page.getByLabel('Item name', { exact: true }).inputValue(), 'Reading sofa', 'A low rug does not steal the sofa selection');

    await page.locator('#preview-tab').click();
    await page.waitForFunction(() => window.planner.getPreviewMetadata().renderCount > 0);
    const metadata = await page.evaluate(() => window.planner.getPreviewMetadata());
    assert.equal(metadata.catalogItems, 2); assert(metadata.itemMeshes > metadata.items);
    await page.waitForTimeout(150);
    const idle = await page.evaluate(() => window.planner.getPreviewMetadata().renderCount);
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => window.planner.getPreviewMetadata().renderCount), idle, 'Idle furniture does not introduce an animation loop');
    if (process.env.PLANNER_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.PLANNER_SCREENSHOT_DIR, 'furniture-preview.jpg'), type: 'jpeg', quality: 88 });
    await page.locator('#plan-tab').click();
    const expected = await project();
    const downloadPromise = page.waitForEvent('download'); await page.locator('#export-project').click();
    const download = await downloadPromise, source = path.join(temporary, 'project.json');
    await download.saveAs(source);
    assert.deepEqual(JSON.parse(fs.readFileSync(source)), expected);
    await page.reload(); await page.waitForFunction(() => window.planner);
    assert.deepEqual(await project(), expected, 'Local draft retains all appearances');
    await importProject(expected);

    // A narrow display can browse and dismiss the modal without horizontal clipping.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#browse-items').click();
    const dialog = await page.locator('#library-dialog').boundingBox();
    assert(dialog.x >= 0 && dialog.x + dialog.width <= 391);
    const overflow = await page.locator('#library-dialog').evaluate(element => element.scrollWidth > element.clientWidth + 1);
    assert.equal(overflow, false);
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#library-dialog').isVisible(), false);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const legacy = JSON.parse(fs.readFileSync(path.join(root, 'planner/example-home.json')));
    await importProject(legacy);
    await page.goto(origin + '/planner/'); await page.waitForFunction(() => window.planner);
    assert.deepEqual(await project(), legacy, 'Root and GitHub Pages project paths both load');
    assert.deepEqual(errors, []); assert.deepEqual(external, []);

    // Install the actual file downloaded above, without private code or a live HA server.
    const built = path.join(temporary, 'built'), config = path.join(temporary, 'config');
    fs.mkdirSync(config); fs.writeFileSync(path.join(config, 'configuration.yaml'), 'default_config:\n');
    runPython(['scripts/build-planner-project.py', '--project', source, '--output', built, '--ha-package']);
    const archive = path.join(built, 'home-floorplan.tar.gz');
    runPython(['scripts/install-home-assistant.py', archive, '--config', config, '--dry-run']);
    assert.equal(fs.existsSync(path.join(config, 'custom_components')), false);
    runPython(['scripts/install-home-assistant.py', archive, '--config', config]);
    const component = path.join(config, 'custom_components/home_floorplan');
    const assets = findFiles(component, 'model-data.json').map(file => JSON.parse(fs.readFileSync(file)));
    assert(assets.some(asset => expected.floors[0].items.every(item => asset.object_assets[item.id]?.model_id === item.model_id)), 'Installed model contains the selected catalog geometries');
    assert.equal(fs.readFileSync(path.join(config, 'configuration.yaml'), 'utf8'), 'default_config:\n');
    compiledPage = fs.readFileSync(path.join(built, expected.floors[0].id, 'index.html'));
    await page.goto(origin + '/compiled/');
    await page.waitForFunction(() => window.floorplan?.objectCount === 2);
    assert(await page.evaluate(() => window.floorplan.objectMeshCount > window.floorplan.objectCount));
    await page.locator('#items li').filter({ hasText: 'Reading sofa' }).getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByLabel('Object name', { exact: true }).fill('Sofa moved in installed viewer');
    await page.getByLabel('X position (m)', { exact: true }).fill('2.5');
    await page.locator('#addItem').click();
    const savedItem = await page.evaluate(() => window.floorplan.items.find(item => item.model_id === 'sofa_2'));
    assert.equal(savedItem.position_m.x, 2.5); assert.equal(savedItem.color, '#507b95');
    assert.equal(savedItem.pattern_id, 'checks'); assert.equal(savedItem.pattern_color, '#ffeedd');
    const rebuilt = JSON.parse(JSON.stringify(expected));
    Object.assign(rebuilt.floors[0].items.find(item => item.model_id === 'sofa_2'), { color: '#c18c42', pattern_id: 'stripes', pattern_color: '#112233' });
    const rebuiltSource = path.join(temporary, 'rebuilt.json'), rebuiltOutput = path.join(temporary, 'rebuilt');
    fs.writeFileSync(rebuiltSource, JSON.stringify(rebuilt));
    runPython(['scripts/build-planner-project.py', '--project', rebuiltSource, '--output', rebuiltOutput]);
    compiledPage = fs.readFileSync(path.join(rebuiltOutput, expected.floors[0].id, 'index.html'));
    await page.reload(); await page.waitForFunction(() => window.floorplan?.objectCount === 2);
    const refreshed = await page.evaluate(() => window.floorplan.items.find(item => item.model_id === 'sofa_2'));
    assert.equal(refreshed.pattern_id, 'stripes'); assert.equal(refreshed.pattern_color, '#112233');
    assert.equal(refreshed.color, '#c18c42'); assert.equal(refreshed.position_m.x, 2.5);
    assert.equal(refreshed.name, 'Sofa moved in installed viewer');
    assert(await page.evaluate(() => Object.hasOwn(window.floorplan.model.materials, 'furniture_c18c42')));
    assert.match(await page.locator('#status').textContent(), /appearances refreshed/);

    // Each downloadable example follows the real browser/export/install path.
    for (const [example, screenshot] of [['garage-and-studio', '09-garage-studio.jpg'], ['decor-studio', '10-decor-studio.jpg'], ['pattern-studio', '11-pattern-studio.jpg']]) {
      await page.goto(origin + '/planner/'); await page.waitForFunction(() => window.planner);
      const advanced = JSON.parse(fs.readFileSync(path.join(root, `planner/guide-assets/${example}.json`)));
      await importProject(advanced);
      await page.locator('#preview-tab').click();
      await page.waitForFunction(count => window.planner.getPreviewMetadata().catalogItems === count, advanced.floors[0].items.length);
      const advancedIdle = await page.evaluate(() => window.planner.getPreviewMetadata().renderCount);
      await page.waitForTimeout(350);
      assert.equal(await page.evaluate(() => window.planner.getPreviewMetadata().renderCount), advancedIdle);
      if (process.env.PLANNER_SCREENSHOT_DIR) {
        await page.locator('#preview-canvas').focus();
        await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
        if (example === 'pattern-studio') {
          for (let turn = 0; turn < 26; turn++) await page.keyboard.press('ArrowRight');
          await page.locator('button[title="item: Rounded square cushion"]').first().click();
          await page.getByLabel('Surface pattern', { exact: true }).scrollIntoViewIfNeeded();
        }
        await page.screenshot({ path: path.join(process.env.PLANNER_SCREENSHOT_DIR, screenshot), type: 'jpeg', quality: 92 });
      }
      const advancedDownload = page.waitForEvent('download'); await page.locator('#export-project').click();
      const advancedSource = path.join(temporary, example + '.json');
      await (await advancedDownload).saveAs(advancedSource);
      assert.deepEqual(JSON.parse(fs.readFileSync(advancedSource)), advanced);
      const advancedOutput = path.join(temporary, example + '-built'), advancedConfig = path.join(temporary, example + '-config');
      fs.mkdirSync(advancedConfig); fs.writeFileSync(path.join(advancedConfig, 'configuration.yaml'), 'default_config:\n');
      runPython(['scripts/build-planner-project.py', '--project', advancedSource, '--output', advancedOutput, '--ha-package']);
      runPython(['scripts/install-home-assistant.py', path.join(advancedOutput, 'home-floorplan.tar.gz'), '--config', advancedConfig]);
      const advancedAssets = findFiles(advancedConfig, 'model-data.json').map(file => JSON.parse(fs.readFileSync(file)));
      assert(advancedAssets.some(asset => advanced.floors[0].items.every(item => asset.object_assets[item.id]?.model_id === item.model_id)));
    }
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log('Browser furniture checks passed: paged catalog and keyboard focus, new designs, colors, history, layering, idle rendering, mobile dialog, JSON round trip, real installs and rebuilt viewer with preserved placements.');
  } finally {
    await browser?.close(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
