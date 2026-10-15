// Fast unit checks for acceptance receipts; no browser or graphics driver needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const vm = require('node:vm');
const {test, after} = require('node:test');
const {createDiagnostics, positiveInteger, selectedEngines, browserLaunchOptions} = require('./browser-stability-diagnostics.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'home-studio-diagnostics-unit-'));
const previousDirectory = process.env.STABILITY_UNIT_DIAGNOSTICS_DIR;
process.env.STABILITY_UNIT_DIAGNOSTICS_DIR = directory;
after(() => {
  if (previousDirectory === undefined) delete process.env.STABILITY_UNIT_DIAGNOSTICS_DIR;
  else process.env.STABILITY_UNIT_DIAGNOSTICS_DIR = previousDirectory;
  fs.rmSync(directory, {recursive: true, force: true});
});

function fakeBrowser() {
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {},
    isClosed: () => false,
    frames: () => [{evaluate: async () => ({stats: {gpu: {renderer: 'Fictional GPU'}, contexts: 1}})}],
    screenshot: async ({path: filename}) => fs.writeFileSync(filename, 'fictional screenshot'),
  });
  const context = {newPage: async () => page, close: async () => { context.closed = true; }};
  const browser = {version: () => 'fictional-browser', newContext: async () => context,
    close: async () => { browser.closed = true; }};
  return {page, context, browser};
}

function suite(name, playwright) {
  return createDiagnostics(name, 'STABILITY_UNIT', path.join(__dirname, '..'), {playwright});
}

const options = {deadlineMs: 1000, reportOnly: false, launch: {headless: true},
  context: {viewport: {width: 1280, height: 800}}, fixture: {rooms: 6, lights: 18}};
const read = (diagnostics, file = 'firefox.json') => JSON.parse(fs.readFileSync(path.join(diagnostics.directory, file)));

test('invalid engines and bounded fixture values cannot produce an empty green run', () => {
  assert.deepEqual(selectedEngines(' firefox, chromium '), ['firefox', 'chromium']);
  for (const value of ['', 'chromium,,firefox', 'firefox,firefox', 'webkit']) {
    assert.throws(() => selectedEngines(value));
  }
  assert.throws(() => positiveInteger('STABILITY_UNIT_UNSET', 0, 24));
  assert.throws(() => positiveInteger('STABILITY_UNIT_UNSET', 25, 24));
});

test('Firefox software WebGL2 preferences reach the browser and its diagnostic receipt', async () => {
  const fake = fakeBrowser();
  let launched;
  const diagnostics = suite('firefox-webgl2', {firefox: {launch: async value => {
    launched = value;
    return fake.browser;
  }}});
  const launch = browserLaunchOptions('firefox', false);
  await diagnostics.run('firefox', {...options, launch}, async () => {});
  assert.equal(launched.headless, false);
  assert.deepEqual(launched.firefoxUserPrefs, {
    'webgl.force-enabled': true, 'webgl.sanitize-unmasked-renderer': false,
  });
  assert.deepEqual(read(diagnostics).launch.firefoxUserPrefs, launched.firefoxUserPrefs);
  assert.equal(read(diagnostics).status, 'passed');
  const chromium = browserLaunchOptions('chromium', true);
  assert.equal(chromium.headless, true);
  assert.equal(chromium.firefoxUserPrefs, undefined);
  assert(chromium.args.includes('--use-angle=swiftshader'));
  assert.throws(() => browserLaunchOptions('webkit', true));
});

test('launch failures persist and do not prevent the next selected engine from running', async () => {
  const fake = fakeBrowser();
  const diagnostics = suite('launch-and-assertion', {
    chromium: {launch: async () => { throw new Error('synthetic launch failure'); }},
    firefox: {launch: async () => fake.browser},
  });
  diagnostics.configure(['chromium', 'firefox'], false);
  let failure;
  try {
    await diagnostics.runAll(['chromium', 'firefox'], engine => diagnostics.run(engine, options,
      async ({check}) => check(false, 'original assertion failure')));
  } catch (error) { failure = error; }
  assert.equal(failure.errors.length, 2);
  diagnostics.finish(failure);
  assert.equal(read(diagnostics, 'chromium.json').status, 'failed');
  assert.match(read(diagnostics, 'chromium.json').error.message, /synthetic launch failure/);
  const record = read(diagnostics);
  assert.equal(record.status, 'failed');
  assert.match(record.error.message, /original assertion failure/);
  assert.equal(record.os.platform, process.platform);
  assert.equal(record.browserVersion, 'fictional-browser');
  assert.equal(record.gpu.renderer, 'Fictional GPU');
  assert.equal(record.snapshot[0].stats.contexts, 1);
  assert(fs.existsSync(path.join(diagnostics.directory, record.screenshot)));
  assert(fake.context.closed && fake.browser.closed);
  assert.equal(read(diagnostics, 'summary.json').status, 'failed');
  assert.equal(read(diagnostics, 'summary.json').browsers.length, 2);
});

test('the Metal profile is explicit and rejects an unconfirmed macOS backend', async () => {
  const previous = process.env.FIREFOX_WEBGL_BACKEND;
  try {
    process.env.FIREFOX_WEBGL_BACKEND = 'angle';
    const launch = browserLaunchOptions('firefox', false);
    assert.equal(launch.firefoxUserPrefs['webgl.disable-angle'], false);
    assert.equal(launch.firefoxUserPrefs['webgl.sanitize-unmasked-renderer'], false);
    if (process.platform === 'darwin') {
      for (const renderer of ['Apple Software Renderer', 'ANGLE Metal Renderer: Fixture GPU']) {
        const fake = fakeBrowser();
        const diagnostics = suite('metal-backend', {firefox: {launch: async () => fake.browser}});
        const run = diagnostics.run('firefox', {...options, launch}, async ({record}) => {
          record.gpu = {unmaskedRenderer: renderer};
        });
        if (renderer.startsWith('ANGLE')) await run;
        else await assert.rejects(run, /must be confirmed by the actual renderer/);
        assert.deepEqual(read(diagnostics).launch.firefoxUserPrefs, launch.firefoxUserPrefs);
      }
    }
    process.env.FIREFOX_WEBGL_BACKEND = 'default';
    assert.equal(browserLaunchOptions('firefox', false).firefoxUserPrefs['webgl.disable-angle'], undefined);
    process.env.FIREFOX_WEBGL_BACKEND = 'typo';
    assert.throws(() => browserLaunchOptions('firefox', false), /must be default or angle/);
  } finally {
    if (previous === undefined) delete process.env.FIREFOX_WEBGL_BACKEND;
    else process.env.FIREFOX_WEBGL_BACKEND = previous;
  }
});

test('the browser watchdog fails a stalled test and saves evidence before closing', async () => {
  const fake = fakeBrowser();
  const diagnostics = suite('watchdog', {firefox: {launch: async () => fake.browser}});
  await assert.rejects(diagnostics.run('firefox', {...options, deadlineMs: 10},
    () => new Promise(() => {})), /browser deadline/);
  const record = read(diagnostics);
  assert.equal(record.status, 'failed');
  assert.equal(record.timedOut, true);
  assert(record.screenshot);
  assert(fake.context.closed && fake.browser.closed);
});

test('screenshot failure preserves the original assertion error', async () => {
  const fake = fakeBrowser();
  fake.page.screenshot = async () => { throw new Error('synthetic screenshot failure'); };
  const diagnostics = suite('screenshot-failure', {firefox: {launch: async () => fake.browser}});
  await assert.rejects(diagnostics.run('firefox', options,
    async () => { throw new Error('original test failure'); }), /original test failure/);
  const record = read(diagnostics);
  assert.equal(record.status, 'failed');
  assert.match(record.error.message, /original test failure/);
  assert.match(record.diagnosticsErrors[0].message, /synthetic screenshot failure/);
});

test('failed cleanup cannot convert a passing test into green acceptance', async () => {
  const fake = fakeBrowser();
  fake.context.close = async () => { throw new Error('synthetic cleanup failure'); };
  const diagnostics = suite('cleanup-failure', {firefox: {launch: async () => fake.browser}});
  await assert.rejects(diagnostics.run('firefox', options, async () => {}), /synthetic cleanup failure/);
  const record = read(diagnostics);
  assert.equal(record.status, 'failed');
  assert.match(record.cleanupErrors[0].message, /synthetic cleanup failure/);
  assert.match(record.error.message, /synthetic cleanup failure/);
  assert(fake.browser.closed);
  assert.deepEqual(record.cleanupTimeoutsMs, {context: 5000, browser: 15000});
  assert(Number.isFinite(record.cleanupDurationsMs.context));
  assert(Number.isFinite(record.cleanupDurationsMs.browser));
});

test('CI rejects report-only mode with a failed summary receipt', () => {
  const previousCI = process.env.CI;
  process.env.CI = 'true';
  try {
    const diagnostics = suite('ci-report-only', {});
    assert.throws(() => {
      try { diagnostics.configure(['firefox'], true); }
      catch (error) { diagnostics.finish(error); throw error; }
    }, /cannot satisfy CI acceptance/);
    assert.equal(read(diagnostics, 'summary.json').status, 'failed');
  } finally {
    if (previousCI === undefined) delete process.env.CI;
    else process.env.CI = previousCI;
  }
});

test('resource failures retain the request URL and console location', async () => {
  const fake = fakeBrowser();
  const diagnostics = suite('resource-failure', {firefox: {launch: async () => fake.browser}});
  const url = 'http://127.0.0.1:1234/planner/missing.js';
  const request = {url: () => url, method: () => 'GET', resourceType: () => 'script',
    failure: () => ({errorText: 'net::ERR_FAILED'})};
  const location = {url, lineNumber: 0, columnNumber: 0};
  const gpu = {version: 'WebGL 2.0', renderer: 'Fixture renderer'};
  await assert.rejects(diagnostics.run('firefox', options, async ({page, check}) => {
    page.emit('console', {type: () => 'info', text: () => '[home-studio-test-gpu]' + JSON.stringify(gpu)});
    page.emit('console', {type: () => 'error', text: () => 'Resource failed', location: () => location});
    page.emit('response', {url: () => url, status: () => 404, request: () => request});
    page.emit('requestfailed', request);
    check(false, 'Resource failure remains a test failure');
  }), /Resource failure remains/);
  const record = read(diagnostics);
  assert.deepEqual(record.gpu, gpu, 'Renderer evidence survives a failure before the first scene snapshot');
  assert.deepEqual(record.consoleErrors, ['Resource failed']);
  assert.deepEqual(record.consoleErrorDetails, [{text: 'Resource failed', location}]);
  assert.deepEqual(record.httpErrors, [{url, status: 404, method: 'GET', resourceType: 'script'}]);
  assert.deepEqual(record.requestFailures, [{url, method: 'GET', resourceType: 'script', error: 'net::ERR_FAILED'}]);
  assert.equal(record.status, 'failed');
});

test('the planner fixture serves the implicit favicon but still rejects missing resources', () => {
  const source = fs.readFileSync(path.join(__dirname, 'test-planner-stability.cjs'), 'utf8');
  const start = source.indexOf('const server=http.createServer(');
  const end = source.indexOf('\nasync function run(', start);
  assert(start >= 0 && end > start, 'Exercise the actual planner fixture request handler');
  const handle = vm.runInNewContext(source.slice(start, end) + '\nserver', {
    http: {createServer: callback => callback}, URL, fs, path, root: path.join(__dirname, '..'), editor: '',
  });
  for (const [url, expected] of [['/favicon.ico', 204], ['/planner/nonexistent.js', 404], ['/unserved.js', 404]]) {
    const response = {writeHead(status) { this.status = status; return this; }, end() { this.ended = true; }};
    handle({url}, response);
    assert.equal(response.status, expected, url);
    assert(response.ended);
  }
});
