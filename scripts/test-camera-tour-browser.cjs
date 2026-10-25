// Real local browser coverage using the public fictional practice home only.
// NODE_PATH=/path/to/node_modules CAMERA_TOUR_ROOT=/checkout node scripts/test-camera-tour-browser.cjs
// CAMERA_TOUR_ENGINE=chromium|firefox|webkit, CAMERA_TOUR_ARTIFACTS=/output,
// and the existing HOME_STUDIO browser launch overrides are optional.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const playwright = require('playwright');

const root = path.resolve(process.env.CAMERA_TOUR_ROOT || path.join(__dirname, '..'));
const engine = process.env.CAMERA_TOUR_ENGINE || 'chromium';
const { browserLaunchOptions } = require(path.join(root, 'scripts/browser-stability-diagnostics.cjs'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'home-studio-tour-browser-'));
const artifacts = process.env.CAMERA_TOUR_ARTIFACTS ? path.resolve(process.env.CAMERA_TOUR_ARTIFACTS) : temporary;
fs.mkdirSync(artifacts, { recursive: true });
const compiled = path.join(temporary, 'compiled');
const fixturePath = path.join(root, 'planner/guide-assets/practice-home.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const report = { engine, root, fixture: 'planner/guide-assets/practice-home.json', cases: [] };
let server, browser, activePage, failed = false;

function instrument() {
  const stats = window.__cameraTourBrowser = { commands: [], permissionRequests: [], streams: [], recordings: [], unhandled: [] };
  window.addEventListener('unhandledrejection', event => stats.unhandled.push(String(event.reason)));
  const observe = data => {
    if (data && typeof data === 'object' && (/^(toggle|tv_power|.*_command|call_service|service_call)$/.test(data.type || '') || data.service)) {
      stats.commands.push({ type: data.type, service: data.service });
    }
  };
  for (const prototype of [Window.prototype, MessagePort.prototype]) {
    const send = prototype.postMessage;
    prototype.postMessage = function (data, ...args) { observe(data); return send.call(this, data, ...args); };
  }
  for (const method of ['getUserMedia', 'getDisplayMedia']) {
    if (navigator.mediaDevices?.[method]) navigator.mediaDevices[method] = (...args) => {
      stats.permissionRequests.push(method);
      return Promise.reject(new Error(`Unexpected ${method} request from a canvas-only tour.`));
    };
  }
  if (HTMLCanvasElement.prototype.captureStream) {
    const capture = HTMLCanvasElement.prototype.captureStream;
    HTMLCanvasElement.prototype.captureStream = function (...args) {
      const stream = capture.apply(this, args); stats.streams.push(stream); return stream;
    };
  }
  if (window.MediaRecorder) {
    const Recorder = window.MediaRecorder;
    window.MediaRecorder = class extends Recorder {
      constructor(...args) { super(...args); stats.recordings.push(this); }
    };
  }
}

async function download(page, action, filename) {
  const pending = page.waitForEvent('download', { timeout: 30000 });
  await action();
  const item = await pending;
  assert.equal(await item.failure(), null, 'download completed');
  const output = path.join(artifacts, filename || item.suggestedFilename());
  await item.saveAs(output);
  return { item, output, bytes: fs.readFileSync(output) };
}

async function decodeVideo(page, bytes, mimeType) {
  // The planner intentionally disallows inline media in its CSP. Inspect the
  // downloaded file in an isolated blank page, without weakening app policy.
  const decoder = await page.context().newPage();
  try { return await decoder.evaluate(async ({ base64, type }) => {
    const data = Uint8Array.from(atob(base64), value => value.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([data], { type }));
    const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.preload = 'auto';
    // WebKit can report loadeddata before a detached video's frame is ready
    // for canvas sampling. Keep it paused but attached, and await presentation.
    document.body.append(video);
    const timeout = setTimeout(() => video.dispatchEvent(new Event('testtimeout')), 15000);
    let frameCallback = null, animationFrame = null;
    try {
      const failure = new Promise((_, reject) => {
        video.addEventListener('error', () => reject(new Error(`Video decode error ${video.error?.code}: ${video.error?.message}`)), { once: true });
        video.addEventListener('testtimeout', () => reject(new Error('Timed out decoding recorded video')), { once: true });
      });
      const waitForFrame = async (event, change) => {
        const ready = new Promise(resolve => video.addEventListener(event, resolve, { once: true }));
        const presented = typeof video.requestVideoFrameCallback === 'function'
          ? new Promise(resolve => { frameCallback = video.requestVideoFrameCallback((_, metadata) => {
            frameCallback = null; resolve(metadata.mediaTime);
          }); })
          : ready.then(() => new Promise(resolve => { animationFrame = requestAnimationFrame(() => {
            animationFrame = requestAnimationFrame(() => { animationFrame = null; resolve(video.currentTime); });
          }); }));
        change();
        return (await Promise.race([Promise.all([ready, presented]), failure]))[1];
      };
      const firstFrameTime = await waitForFrame('loadeddata', () => { video.src = url; video.load(); });
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
      const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 32, 32);
      const pixels = context.getImageData(0, 0, 32, 32).data, colors = new Set();
      for (let i = 0; i < pixels.length; i += 4) colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
      // A nonempty file alone does not prove that the camera moved.
      const laterFrameTime = await waitForFrame('seeked', () => { video.currentTime = 1.1; });
      context.drawImage(video, 0, 0, 32, 32);
      const later = context.getImageData(0, 0, 32, 32).data;
      let changedPixels = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (Math.abs(pixels[i] - later[i]) + Math.abs(pixels[i+1] - later[i+1]) + Math.abs(pixels[i+2] - later[i+2]) > 45) changedPixels++;
      }
      return { width: video.videoWidth, height: video.videoHeight, readyState: video.readyState,
        duration: Number.isFinite(video.duration) ? video.duration : null, colors: colors.size, changedPixels,
        firstFrameTime, laterFrameTime };
    } finally {
      clearTimeout(timeout);
      if (frameCallback !== null) video.cancelVideoFrameCallback(frameCallback);
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      video.pause(); video.removeAttribute('src'); video.load(); video.remove(); URL.revokeObjectURL(url);
    }
  }, { base64: bytes.toString('base64'), type: mimeType });
  } finally { await decoder.close(); }
}

async function exercise(context, origin, name) {
  const page = activePage = await context.newPage();
  const errors = [], external = [], requests = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) requests.push({ method: request.method(), url: request.url() }); });
  await page.route('**/*', route => {
    const url = route.request().url();
    if (/^https?:/.test(url) && !url.startsWith(origin + '/')) { external.push(url); return route.abort(); }
    return route.continue();
  });
  await page.addInitScript(instrument);
  await page.addInitScript(project => { localStorage.setItem('home-studio.project.v1', JSON.stringify(project)); localStorage.setItem('home-studio.language', 'en'); }, fixture);
  const planner = name === 'planner';
  await page.goto(planner ? origin + '/planner/' : `${origin}/compiled/${fixture.floors[0].id}/index.html`);
  await page.waitForFunction(isPlanner => isPlanner ? Boolean(window.planner) : Boolean(window.floorplan?.renderCount), planner);
  if (planner) { await page.locator('#preview-tab').click(); await page.waitForFunction(() => planner.getView() === 'preview' && planner.getPreviewMetadata().renderCount > 0); }
  if (name === 'home') { await page.locator('#openHome').click(); await page.waitForFunction(() => floorplan.homeMode); }
  const canvasSelector = planner ? '#preview-canvas' : name === 'home' ? '#homeStage canvas' : '#view3d canvas';
  await page.locator(canvasSelector).waitFor({ state: 'visible' });
  const snapshot = () => page.evaluate(isPlanner => isPlanner ? window.planner.getProject() : { model: window.floorplan.model, items: window.floorplan.items }, planner);
  const before = await snapshot();
  const button = page.locator(planner ? '#preview-tour' : name === 'home' ? '#homeCameraTour' : '#editorCameraTour');
  const host = page.locator('.camera-tour-host:not([hidden])');
  const panel = host.locator('.camera-tour-panel');
  await button.click(); await panel.waitFor({ state: 'visible' });
  assert.equal(await panel.locator('.camera-tour-view').count(), 5, 'opening provides a ready full orbit');
  const initialRoute = await download(page, () => panel.getByRole('button', { name: 'Export route', exact: true }).click(), `${name}-default-orbit.json`);
  const initialViews = JSON.parse(initialRoute.bytes).waypoints;
  assert.equal(initialViews.reduce((sum, view) => sum + view.duration, 0), 20);
  let totalRotation = 0;
  for (let i = 1; i < initialViews.length; i++) {
    const previous = initialViews[i - 1].pose, current = initialViews[i].pose;
    const delta = (current.rotation ?? current.yaw) - (previous.rotation ?? previous.yaw);
    totalRotation += Math.atan2(Math.sin(delta), Math.cos(delta));
  }
  assert(Math.abs(Math.abs(totalRotation) - Math.PI * 2) < 1e-8, 'default route completes a revolution');
  assert.equal(await page.locator('canvas[data-camera-tour-playing="true"]').count(), 0, 'opening never starts animation');
  await panel.getByRole('button', { name: 'Clear route', exact: true }).click();
  await page.keyboard.press('Escape'); await button.click();
  assert.equal(await panel.locator('.camera-tour-view').count(), 0, 'reopening preserves a deliberately empty route');
  await panel.getByRole('button', { name: 'Save current view', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.camera-tour-host:not([hidden])'));
  assert.equal(await button.getAttribute('aria-expanded'), 'false', 'Escape resets the toggle state');
  await page.locator(planner ? '#preview-rotate-right' : name === 'home' ? '#homeZoomIn' : '#topView').click();
  await button.click();
  await panel.getByRole('button', { name: 'Save current view', exact: true }).click();
  assert.equal(await panel.locator('.camera-tour-view').count(), 2, 'two viewpoints saved through controls');
  for (let index = 0; index < 2; index++) {
    const seconds = panel.locator('input[type="number"]').nth(index);
    await seconds.fill('0.75'); await seconds.press('Tab');
  }
  const route = await download(page, () => panel.getByRole('button', { name: 'Export route', exact: true }).click(), `${name}-route.json`);
  const routeJson = JSON.parse(route.bytes);
  assert.equal(routeJson.waypoints.length, 2);
  assert.notDeepEqual(routeJson.waypoints[0].pose, routeJson.waypoints[1].pose, 'navigation produced distinct camera poses');
  await page.screenshot({ path: path.join(artifacts, `${name}-two-views.png`), fullPage: true });
  await panel.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.camera-tour-host:not([hidden]) .camera-tour-status')?.textContent === 'Tour finished');
  assert.deepEqual(await snapshot(), before, 'playing a tour changes no project or inventory data');
  const result = { name, savedViews: 2, playback: 'passed', escape: 'passed', defaultOrbit: 'passed' };
  await page.keyboard.press('Escape'); await button.click();
  assert.equal(await panel.locator('.camera-tour-view').count(), 2, 'reopening preserves a custom route');
  await panel.getByRole('button', { name: 'Full orbit', exact: true }).click();
  assert.equal(await panel.locator('.camera-tour-view').count(), 5);
  for (let index = 0; index < 5; index++) {
    const seconds = panel.locator('input[type="number"]').nth(index);
    await seconds.fill('0.75'); await seconds.press('Tab');
  }
  const support = await page.evaluate(selector => {
    const canvas = document.querySelector(selector);
    const supported = typeof canvas.captureStream === 'function' && typeof MediaRecorder === 'function' && typeof MediaRecorder.isTypeSupported === 'function' &&
      ['video/mp4;codecs=avc1', 'video/mp4'].some(type => {
        try { return MediaRecorder.isTypeSupported(type); } catch { return false; }
      });
    return Boolean(supported);
  }, canvasSelector);
  if (support) {
    const recorded = await download(page, () => panel.getByRole('button', { name: 'Record video', exact: true }).click(), `${name}-video`);
    const extension = path.extname(recorded.item.suggestedFilename());
    assert.equal(extension, '.mp4', 'recording is downloaded as MP4');
    assert(recorded.bytes.length > 100 && recorded.bytes.length <= 64 * 1024 * 1024, 'download has bounded, nonempty video data');
    assert.equal(recorded.bytes.subarray(4, 8).toString(), 'ftyp', 'genuine MP4 file-type header, never renamed WebM');
    const output = recorded.output + extension; fs.renameSync(recorded.output, output);
    const decoded = await decodeVideo(page, recorded.bytes, 'video/mp4');
    assert(decoded.width > 0 && decoded.height > 0 && decoded.readyState >= 2, 'recorded video decodes a complete frame');
    assert(decoded.colors > 1, 'the first recorded frame contains rendered canvas content');
    assert(decoded.changedPixels > 20, 'decoded frames show camera movement, not a static view');
    result.recording = { status: 'passed', file: path.basename(output), bytes: recorded.bytes.length, ...decoded };
    await page.waitForFunction(() => __cameraTourBrowser.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
    assert(await page.evaluate(() => __cameraTourBrowser.recordings.every(recorder => recorder.state === 'inactive')), 'all recorders stopped');
  } else {
    await panel.getByRole('button', { name: 'Record video', exact: true }).click();
    const reason = await panel.locator('.camera-tour-status').innerText();
    assert([
      'MP4 recording is unavailable in this browser. Camera tour playback is still available.',
      'MediaRecorder video recording is unavailable in this browser.',
      'Canvas video recording is unavailable in this browser.',
    ].includes(reason), `unsupported capture reports its actual capability limit: ${reason}`);
    assert.equal(await host.locator('.camera-tour-download').count(), 0, 'no WebM substitute is downloaded');
    result.recording = { status: 'unsupported', reason };
  }
  await panel.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForFunction(() => Boolean(document.querySelector('canvas[data-camera-tour-playing="true"]')));
  await page.locator(planner ? '#plan-tab' : name === 'home' ? '#editLayout' : '#openHome').click();
  await page.waitForFunction(() => !document.querySelector('.camera-tour-host:not([hidden])'));
  await page.waitForFunction(() => !document.querySelector('canvas[data-camera-tour-playing="true"]'));
  result.modeSwitch = 'passed';
  assert.deepEqual(await snapshot(), before, 'all tour controls leave project and inventory unchanged');
  const effects = await page.evaluate(() => ({ commands: __cameraTourBrowser.commands, permissions: __cameraTourBrowser.permissionRequests, unhandled: __cameraTourBrowser.unhandled }));
  assert.deepEqual(effects, { commands: [], permissions: [], unhandled: [] }, 'no device commands, media permissions, or unhandled errors');
  assert.deepEqual(requests, [], 'no network writes');
  assert.deepEqual(external, [], 'no external network requests');
  assert.deepEqual(errors, [], 'no page errors');
  result.projectUnchanged = true; result.serviceCommands = 0; result.pageErrors = 0;
  await page.close(); activePage = null;
  assert.deepEqual(errors, [], 'teardown produces no page errors');
  report.cases.push(result);
  console.log(`PASS ${name}: two views, playback, ${result.recording.status} recording, Escape, mode switch, unchanged project, zero commands/errors`);
}

(async () => {
  assert(['chromium', 'firefox', 'webkit'].includes(engine), 'supported browser engine');
  const built = spawnSync(process.env.PYTHON || 'python3', ['scripts/build-planner-project.py', '--project', fixturePath, '--output', compiled], { cwd: root, encoding: 'utf8', timeout: 120000 });
  if (built.error) throw built.error;
  assert.equal(built.status, 0, built.stderr || built.stdout);
  server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const isCompiled = pathname.startsWith('/compiled/'), base = isCompiled ? compiled : root;
    const route = isCompiled ? pathname.slice('/compiled'.length) : pathname;
    const file = path.resolve(base, '.' + route, route.endsWith('/') ? 'index.html' : '');
    if (!file.startsWith(base + path.sep)) { response.writeHead(403).end(); return; }
    try {
      const types = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/html', 'Cache-Control': 'no-store' });
      response.end(fs.readFileSync(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await playwright[engine].launch(browserLaunchOptions(engine, true));
  await require('./test-camera-tour-native-downloads.cjs').checkNativeTourDownloads(browser, root);
  for (const name of ['planner', 'editor', 'home']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', acceptDownloads: true });
    try { await exercise(context, origin, name); }
    catch (error) {
      if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: path.join(artifacts, `${name}-failure.png`) }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }
  report.status = 'passed';
})().catch(async error => {
  failed = true; report.status = 'failed'; report.error = String(error.stack || error);
  if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
  console.error(error); process.exitCode = 1;
}).finally(async () => {
  fs.writeFileSync(path.join(artifacts, 'camera-tour-browser.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  console.log(`Camera tour browser report: ${path.join(artifacts, 'camera-tour-browser.json')}`);
  if (!failed && artifacts !== temporary) fs.rmSync(temporary, { recursive: true, force: true });
});
