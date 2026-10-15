// Fast unit checks for acceptance receipts; no browser or graphics driver needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {test, after} = require('node:test');
const {createDiagnostics, positiveInteger, selectedEngines} = require('./browser-stability-diagnostics.cjs');

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
