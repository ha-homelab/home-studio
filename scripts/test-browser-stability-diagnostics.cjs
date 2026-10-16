// Fast unit checks for acceptance receipts; no browser or graphics driver needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const vm = require('node:vm');
const {test, after} = require('node:test');
const {createDiagnostics, positiveInteger, selectedEngines, browserLaunchOptions, browserProfile, loadPlaywright, browserIdentity, createInputDriver, viewerInputOptions} = require('./browser-stability-diagnostics.cjs');

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
    evaluate: async () => ({userAgent: 'Mozilla/5.0 Firefox/157.0', platform: 'test-platform', maxTouchPoints: 0}),
    isClosed: () => false,
    frames: () => [{evaluate: async () => ({stats: {gpu: {renderer: 'Fictional GPU'}, contexts: 1}})}],
    screenshot: async ({path: filename}) => fs.writeFileSync(filename, 'fictional screenshot'),
  });
  const context = {addInitScript: async () => {}, newPage: async () => page, close: async () => { context.closed = true; }};
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
  for (const value of ['', 'chromium,,firefox', 'firefox,firefox', 'safari']) {
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
  assert.deepEqual(browserLaunchOptions('webkit', true), {headless: true});
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

test('software compositor opt-in reaches Firefox and its receipt without changing WebGL', async () => {
  const previous = process.env.FIREFOX_COMPOSITOR_BACKEND;
  try {
    process.env.FIREFOX_COMPOSITOR_BACKEND = 'default';
    const baseline = browserLaunchOptions('firefox', false);
    assert.equal(baseline.firefoxUserPrefs['gfx.webrender.software'], undefined);
    process.env.FIREFOX_COMPOSITOR_BACKEND = 'software';
    const launch = browserLaunchOptions('firefox', false);
    assert.deepEqual(launch.firefoxUserPrefs, {...baseline.firefoxUserPrefs, 'gfx.webrender.software': true});
    const fake = fakeBrowser();
    let launched;
    const diagnostics = suite('software-compositor', {firefox: {launch: async value => {
      launched = value;
      return fake.browser;
    }}});
    await diagnostics.run('firefox', {...options, launch}, async () => {});
    assert.deepEqual(launched.firefoxUserPrefs, launch.firefoxUserPrefs);
    assert.deepEqual(read(diagnostics).launch.firefoxUserPrefs, launch.firefoxUserPrefs);
    assert.equal(browserLaunchOptions('chromium', false).firefoxUserPrefs, undefined);
    assert.deepEqual(browserLaunchOptions('webkit', false), {headless: false});
    process.env.FIREFOX_COMPOSITOR_BACKEND = 'typo';
    assert.throws(() => browserLaunchOptions('firefox', false), /must be default or software/);
  } finally {
    if (previous === undefined) delete process.env.FIREFOX_COMPOSITOR_BACKEND;
    else process.env.FIREFOX_COMPOSITOR_BACKEND = previous;
  }
});

test('GPU process opt-in permits parent WebGL and retains both preferences in its receipt', async () => {
  const names = ['FIREFOX_GPU_PROCESS', 'FIREFOX_COMPOSITOR_BACKEND', 'FIREFOX_WEBGL_BACKEND'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    delete process.env.FIREFOX_GPU_PROCESS;
    process.env.FIREFOX_COMPOSITOR_BACKEND = 'software';
    process.env.FIREFOX_WEBGL_BACKEND = 'angle';
    const baseline = browserLaunchOptions('firefox', false);
    assert.equal(baseline.firefoxUserPrefs['layers.gpu-process.enabled'], undefined);
    assert.equal(baseline.firefoxUserPrefs['webgl.allow-in-parent'], undefined);
    process.env.FIREFOX_GPU_PROCESS = 'default';
    assert.deepEqual(browserLaunchOptions('firefox', false), baseline);
    process.env.FIREFOX_GPU_PROCESS = 'disabled';
    const launch = browserLaunchOptions('firefox', false);
    assert.deepEqual(launch.firefoxUserPrefs, {...baseline.firefoxUserPrefs,
      'layers.gpu-process.enabled': false, 'webgl.allow-in-parent': true});
    assert.deepEqual(browserLaunchOptions('firefox', true).firefoxUserPrefs, launch.firefoxUserPrefs);
    const fake = fakeBrowser();
    let launched;
    const diagnostics = suite('disabled-gpu-process', {firefox: {launch: async value => {
      launched = value;
      return fake.browser;
    }}});
    await diagnostics.run('firefox', {...options, launch}, async ({record}) => {
      record.gpu = {unmaskedRenderer: 'ANGLE Metal Renderer: Fixture GPU'};
    });
    assert.deepEqual(launched.firefoxUserPrefs, launch.firefoxUserPrefs);
    assert.deepEqual(read(diagnostics).launch.firefoxUserPrefs, launch.firefoxUserPrefs);
    process.env.FIREFOX_GPU_PROCESS = 'default';
    assert.deepEqual(browserLaunchOptions('firefox', false), baseline,
      'Returning to the default mode must restore both browser defaults');
    for (const invalid of ['', 'typo', 'false']) {
      process.env.FIREFOX_GPU_PROCESS = invalid;
      assert.throws(() => browserLaunchOptions('firefox', false), /must be default or disabled/);
      assert.equal(browserLaunchOptions('chromium', false).firefoxUserPrefs, undefined);
      assert.deepEqual(browserLaunchOptions('webkit', false), {headless: false});
    }
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
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

test('Chromium ANGLE selection preserves software coverage and rejects an unconfirmed backend', async () => {
  const previous = process.env.CHROMIUM_ANGLE_BACKEND;
  try {
    delete process.env.CHROMIUM_ANGLE_BACKEND;
    assert.deepEqual(browserLaunchOptions('chromium', true).args,
      ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']);
    for (const backend of ['metal', 'swiftshader']) {
      process.env.CHROMIUM_ANGLE_BACKEND = backend;
      const launch = browserLaunchOptions('chromium', false);
      assert.equal(launch.headless, false);
      assert.deepEqual(launch.args, ['--enable-webgl', `--use-angle=${backend}`,
        ...(backend === 'swiftshader' ? ['--enable-unsafe-swiftshader'] : [])]);
      const matching = backend === 'metal'
        ? 'ANGLE (Apple, ANGLE Metal Renderer: Apple Paravirtual device, Version 15.7.9)'
        : 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)';
      const mismatching = backend === 'metal' ? 'SwiftShader Device' : 'ANGLE Metal Renderer: Fixture GPU';
      for (const gpu of [{unmaskedRenderer: matching}, {renderer: matching}, {renderer: mismatching}, undefined]) {
        const fake = fakeBrowser();
        let launched;
        const diagnostics = suite(`chromium-${backend}`, {chromium: {launch: async value => {
          launched = value;
          return fake.browser;
        }}});
        const run = diagnostics.run('chromium', {...options, launch}, async ({record}) => { record.gpu = gpu; });
        const expected = gpu && (gpu.unmaskedRenderer || gpu.renderer) === matching;
        if (expected) await run;
        else await assert.rejects(run, /must be confirmed by the actual renderer/);
        const record = read(diagnostics, 'chromium.json');
        assert.equal(record.status, expected ? 'passed' : 'failed');
        assert.deepEqual(launched.args, launch.args);
        assert.deepEqual(record.launch.args, launch.args);
        assert(fake.context.closed && fake.browser.closed);
      }
    }
    process.env.CHROMIUM_ANGLE_BACKEND = 'typo';
    assert.throws(() => browserLaunchOptions('chromium', false), /must be metal or swiftshader/);
    assert.deepEqual(browserLaunchOptions('webkit', false), {headless: false});
    assert.equal(browserLaunchOptions('firefox', false).args, undefined);
  } finally {
    if (previous === undefined) delete process.env.CHROMIUM_ANGLE_BACKEND;
    else process.env.CHROMIUM_ANGLE_BACKEND = previous;
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
    startup: require('./browser-startup-diagnostics.cjs').createStartupDiagnostics(), sourceHash: null,
    http: {createServer: callback => callback}, URL, fs, path, root: path.join(__dirname, '..'), editor: '',
  });
  for (const [url, expected] of [['/favicon.ico', 204], ['/planner/nonexistent.js', 404], ['/unserved.js', 404]]) {
    const response = {writeHead(status) { this.status = status; return this; }, end() { this.ended = true; }};
    handle({url}, response);
    assert.equal(response.status, expected, url);
    assert(response.ended);
  }
});


test('browser profiles preserve real UA and use Firefox-compatible context options', () => {
  const previous = process.env.HOME_STUDIO_BROWSER_PROFILE;
  try {
    const desktop = {viewport: {width: 1440, height: 1000}, deviceScaleFactor: 2};
    delete process.env.HOME_STUDIO_BROWSER_PROFILE;
    assert.deepEqual(browserProfile('chromium', desktop).context, {...desktop, locale: 'en-US'});
    for (const name of ['phone', 'tablet']) {
      process.env.HOME_STUDIO_BROWSER_PROFILE = name;
      for (const engine of ['chromium', 'firefox', 'webkit']) {
        const profile = browserProfile(engine, desktop);
        assert.equal(profile.name, name);
        assert.equal(profile.context.hasTouch, true);
        assert.equal(profile.context.isMobile, engine === 'firefox' ? undefined : true);
        assert.equal(profile.context.viewport.width, name === 'phone' ? 390 : 820);
        assert.equal(profile.context.userAgent, undefined, 'Never replace actual browser identity with a device preset UA');
        assert.equal(profile.realMobileOS, false);
        assert.equal(profile.input, engine === 'chromium' ? 'native-touch' : 'native-tap-and-mouse-drag');
      }
    }
    process.env.HOME_STUDIO_BROWSER_PROFILE = 'typo';
    assert.throws(() => browserProfile('chromium', desktop), /must be desktop, phone or tablet/);
  } finally {
    if (previous === undefined) delete process.env.HOME_STUDIO_BROWSER_PROFILE;
    else process.env.HOME_STUDIO_BROWSER_PROFILE = previous;
  }
});

test('installed channels are explicit and do not allow unsupported engine combinations', () => {
  const previous = process.env.HOME_STUDIO_BROWSER_CHANNEL;
  try {
    for (const channel of ['chrome', 'chrome-beta', 'msedge', 'msedge-beta']) {
      process.env.HOME_STUDIO_BROWSER_CHANNEL = channel;
      assert.equal(browserLaunchOptions('chromium', true).channel, channel);
      assert.throws(() => browserLaunchOptions('firefox', true), /require the Chromium/);
      assert.throws(() => browserLaunchOptions('webkit', true), /require the Chromium/);
    }
    process.env.HOME_STUDIO_BROWSER_CHANNEL = 'safari';
    assert.throws(() => browserLaunchOptions('chromium', true), /must be chrome/);
  } finally {
    if (previous === undefined) delete process.env.HOME_STUDIO_BROWSER_CHANNEL;
    else process.env.HOME_STUDIO_BROWSER_CHANNEL = previous;
  }
});

test('actual identity rejects mismatched browser versions and mislabeled channels', async () => {
  const previous = process.env.HOME_STUDIO_EXPECT_BROWSER_MAJOR;
  const previousVersion = process.env.HOME_STUDIO_EXPECT_BROWSER_VERSION;
  const page = (ua, brands) => ({evaluate: async () => ({userAgent: ua, platform: 'actual-desktop', maxTouchPoints: 1,
    userAgentData: brands ? {brands: brands.map(brand => ({brand, version:'142'}))} : null})});
  try {
    process.env.HOME_STUDIO_EXPECT_BROWSER_MAJOR = '142';
    const chrome = await browserIdentity(page('Mozilla Chrome/142.0', ['Google Chrome','Chromium']), 'chromium', {channel: 'chrome'}, '142.0.1');
    assert.equal(chrome.product, 'Google Chrome');
    assert.equal(chrome.platform, 'actual-desktop');
    const unbranded = await browserIdentity(page('Chrome/142.0'), 'chromium', {}, '142.0');
    assert.equal(unbranded.product, 'Chromium-compatible', 'A Chrome UA token alone cannot prove a Google Chrome binary');
    await assert.rejects(browserIdentity(page('Chrome/142.0', ['Chromium']), 'chromium', {channel:'chrome'}, '142.0'), /actual Google Chrome brand/);
    const edge = await browserIdentity(page('Mozilla Chrome/142.0 Edg/142.0'), 'chromium', {channel: 'msedge'}, '142.0.1');
    assert.equal(edge.product, 'Microsoft Edge');
    await assert.rejects(browserIdentity(page('Chrome/141.0'), 'chromium', {channel: 'chrome'}, '141.0'), /pinned browser major/);
    await assert.rejects(browserIdentity(page('Chrome/142.0'), 'chromium', {channel: 'msedge'}, '142.0'), /identify itself as Edge/);
    await assert.rejects(browserIdentity(page('Chrome/142.0 Edg/142.0'), 'chromium', {channel: 'chrome'}, '142.0'), /identify itself as Chrome/);
    process.env.HOME_STUDIO_EXPECT_BROWSER_VERSION = '142.0.2';
    await assert.rejects(browserIdentity(page('Chrome/142.0'), 'chromium', {}, '142.0.1'), /complete pinned browser version/);
    delete process.env.HOME_STUDIO_EXPECT_BROWSER_VERSION;
    process.env.HOME_STUDIO_EXPECT_BROWSER_MAJOR = 'not-a-major';
    await assert.rejects(browserIdentity(page('Chrome/142.0'), 'chromium', {}, '142.0'), /positive integer/);
  } finally {
    if (previous === undefined) delete process.env.HOME_STUDIO_EXPECT_BROWSER_MAJOR;
    else process.env.HOME_STUDIO_EXPECT_BROWSER_MAJOR = previous;
    if (previousVersion === undefined) delete process.env.HOME_STUDIO_EXPECT_BROWSER_VERSION;
    else process.env.HOME_STUDIO_EXPECT_BROWSER_VERSION = previousVersion;
  }
});

test('isolated pinned Playwright package supplies both API and matching version evidence', () => {
  const packagePath = fs.mkdtempSync(path.join(directory, 'isolated-playwright-'));
  fs.writeFileSync(path.join(packagePath, 'index.js'), 'module.exports = {isolated: true};');
  fs.writeFileSync(path.join(packagePath, 'package.json'), JSON.stringify({name:'playwright',version:'1.2.3'}));
  assert.deepEqual(loadPlaywright(packagePath), {playwright:{isolated:true},version:'1.2.3'});
  assert.throws(() => loadPlaywright('relative/path'), /absolute package directory/);
});

test('native touch drags use browser protocol and release a failed gesture', async () => {
  const commands = [];
  const page = {context: () => ({newCDPSession: async () => ({send: async (method, payload) => commands.push({method, payload})})})};
  const input = await createInputDriver(page, 'chromium', {input:'native-touch',emulated:true});
  await assert.rejects(input.drag({x:10,y:20},{x:100,y:200},async () => {throw Error('cancel failed');}), /cancel failed/);
  assert.equal(commands.length, 14);
  assert(commands.every(value => value.method === 'Input.dispatchTouchEvent'));
  assert.equal(commands[0].payload.type, 'touchStart');
  assert.equal(commands[12].payload.type, 'touchMove');
  assert.deepEqual(commands[12].payload.touchPoints, [{x:100,y:200,id:0}]);
  assert.deepEqual(commands[13].payload, {type:'touchEnd',touchPoints:[]});
});

test('Chromium touch defaults to serialized native taps with explicit comparison modes', async () => {
  const touch = {input:'native-touch',emulated:true};
  assert.deepEqual(viewerInputOptions('chromium', touch, {}), {tapMode:'sequential',traceInput:false});
  assert.deepEqual(viewerInputOptions('chromium', {input:'mouse'}, {}), {tapMode:'playwright',traceInput:false});
  assert.deepEqual(viewerInputOptions('webkit', {input:'native-tap-mouse-drag',emulated:true}, {}), {tapMode:'playwright',traceInput:false});
  for (const mode of ['', 'retry', 'gesture']) assert.throws(() =>
    viewerInputOptions('chromium', touch, {BROWSER_STABILITY_TOUCH_TAP:mode}), /must be playwright/);
  assert.throws(() => viewerInputOptions('webkit', touch, {BROWSER_STABILITY_TOUCH_TAP:'sequential'}), /Chromium touch/);
  assert.throws(() => viewerInputOptions('chromium', {input:'mouse'}, {BROWSER_STABILITY_TOUCH_TAP:'gesture50'}), /Chromium touch/);
  assert.throws(() => viewerInputOptions('chromium', touch, {BROWSER_STABILITY_TRACE_INPUT:'true'}), /must be 0 or 1/);
  assert.throws(() => viewerInputOptions('firefox', touch, {BROWSER_STABILITY_TRACE_INPUT:'1'}), /requires Chromium/);
  const commands = [];
  const page = {context:()=>({newCDPSession:async()=>({send:async command=>commands.push(command)})})};
  const driver = await createInputDriver(page, 'chromium', touch, {tapMode:'playwright'});
  let taps = 0;
  await driver.tap({tap:async(...args)=>{assert.equal(args.length,0);taps++;}});
  assert.equal(taps,1); assert.deepEqual(commands,[]);
});

test('each native transport sends one tap with no trial or retry input', async () => {
  for (const tapMode of ['sequential','gesture50']) {
    const commands = [];
    let startAcknowledged = false;
    const page = {context:()=>({newCDPSession:async()=>({send:async(method,payload)=>{
      commands.push({method,payload});
      if (payload.type === 'touchStart') {await Promise.resolve();startAcknowledged=true;}
      if (payload.type === 'touchEnd') assert(startAcknowledged, 'Start must be acknowledged before end');
    }})})};
    let hit = true, enabled = true;
    const locator = {tap:()=>assert.fail('No intercepted trial input'), click:()=>assert.fail('No fallback click'),
      waitFor:async options=>assert.deepEqual(options,{state:'visible'}), scrollIntoViewIfNeeded:async()=>{},
      isEnabled:async()=>enabled, evaluate:async()=>hit, boundingBox:async()=>({x:20,y:30,width:60,height:40})};
    const driver = await createInputDriver(page,'chromium',{input:'native-touch',emulated:true},{tapMode});
    await driver.tap(locator);
    if (tapMode === 'sequential') assert.deepEqual(commands,[
      {method:'Input.dispatchTouchEvent',payload:{type:'touchStart',touchPoints:[{x:50,y:50,id:0}]}},
      {method:'Input.dispatchTouchEvent',payload:{type:'touchEnd',touchPoints:[]}},
    ]);
    else assert.deepEqual(commands,[{method:'Input.synthesizeTapGesture',
      payload:{x:50,y:50,duration:50,tapCount:1,gestureSourceType:'touch'}}]);
    commands.length=0; hit=false;
    await assert.rejects(driver.tap(locator),/center must receive input/);
    assert.deepEqual(commands,[],'Failed hit testing must not dispatch any touch');
    hit=true; enabled=false;
    await assert.rejects(driver.tap(locator),/must be enabled/);
    assert.deepEqual(commands,[],'Disabled controls must not receive any touch');
  }
});

test('default taps and drags share one CDP session and preserve exactly four touch sequences', async () => {
  let sessions = 0, pendingStart = false;
  const commands = [];
  const page = {context:()=>({newCDPSession:async()=>{
    sessions++; return {send:async(method,payload)=>{
      commands.push({method,payload});
      if(payload.type==='touchStart') {pendingStart=true;await Promise.resolve();pendingStart=false;}
      if(payload.type==='touchEnd') assert.equal(pendingStart,false,'Never end before the start response');
    }};
  }})};
  const locator = {waitFor:async()=>{},scrollIntoViewIfNeeded:async()=>{},isEnabled:async()=>true,
    evaluate:async()=>true,boundingBox:async()=>({x:320,y:240,width:80,height:40}),
    tap:()=>assert.fail('Default must use native CDP'),click:()=>assert.fail('No synthetic click')};
  const driver=await createInputDriver(page,'chromium',{input:'native-touch',emulated:true});
  await driver.drag({x:10,y:20},{x:30,y:40}); await driver.tap(locator);
  await driver.drag({x:10,y:20},{x:30,y:40}); await driver.tap(locator);
  assert.equal(sessions,1);
  assert.equal(commands.filter(c=>c.payload.type==='touchStart').length,4);
  assert.equal(commands.filter(c=>c.payload.type==='touchEnd').length,4);
  assert.equal(commands.filter(c=>c.payload.type==='touchMove').length,24);
  assert.deepEqual(commands[14].payload.touchPoints,[{x:360,y:260,id:0}],
    'Native taps use main-frame CSS coordinates from the locator, including iframe offsets');
  const viewer=fs.readFileSync(path.join(__dirname,'test-browser-stability.cjs'),'utf8');
  assert.match(viewer,/trustedTouchStarts===4 && sample\.input\.trustedTouchEnds===4/,
    'The real suite retains its exact trusted native sequence assertion');
});

function fakeInputTrace(fake, {lost=false, readFails=false} = {}) {
  const commands = [];
  const session = Object.assign(new EventEmitter(), {detach:async()=>commands.push('detach'),
    send:async(method)=>{
      commands.push(method);
      if (method === 'Tracing.end') queueMicrotask(()=>session.emit('Tracing.tracingComplete',
        {stream:'fictional-stream',dataLossOccurred:lost}));
      if (method === 'IO.read') {
        if (readFails) throw Error('synthetic trace stream failure');
        return {data:Buffer.from('{"traceEvents":[]}').toString('base64'),base64Encoded:true,eof:true};
      }
      return {};
    }});
  fake.context.newCDPSession=async()=>session;
  return commands;
}

test('requested input traces survive assertion failures and keep the original failure', async () => {
  const fake=fakeBrowser(), commands=fakeInputTrace(fake);
  const diagnostics=suite('input-trace-failure',{chromium:{launch:async()=>fake.browser}});
  await assert.rejects(diagnostics.run('chromium', {...options,
    inputDiagnostics:{tapMode:'gesture50',traceInput:true}}, async({check})=>check(false,'original missing click')), /original missing click/);
  const record=read(diagnostics,'chromium.json');
  assert.equal(record.status,'failed'); assert.equal(record.inputDiagnostics.tapMode,'gesture50');
  assert.equal(record.inputTrace.status,'saved'); assert.equal(record.inputTrace.dataLoss,false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(diagnostics.directory,record.inputTrace.file))),{traceEvents:[]});
  assert.deepEqual(commands,['Tracing.start','Tracing.end','IO.read','IO.close','detach']);
  assert(fake.context.closed && fake.browser.closed);
});

test('trace data loss or stream failure cannot create a green diagnostic', async () => {
  for (const setup of [{lost:true},{readFails:true}]) {
    const fake=fakeBrowser(); fakeInputTrace(fake,setup);
    const diagnostics=suite(`input-trace-incomplete-${Object.keys(setup)[0]}`,{chromium:{launch:async()=>fake.browser}});
    await assert.rejects(diagnostics.run('chromium', {...options,
      inputDiagnostics:{tapMode:'sequential',traceInput:true}}, async()=>{}), /trace buffer|trace stream/);
    const record=read(diagnostics,'chromium.json');
    assert.equal(record.status,'failed'); assert.equal(record.inputTrace.status,'failed');
    assert.equal(record.diagnosticsErrors.length,1); assert(fake.context.closed && fake.browser.closed);
  }
});

test('input evidence retains event targets and viewport without changing native events', () => {
  const source=fs.readFileSync(path.join(__dirname,'browser-stability-diagnostics.cjs'),'utf8');
  const instrument=source.slice(source.indexOf('function inputInstrumentation()'),source.indexOf('async function createInputDriver'));
  const listeners=[],target={tagName:'BUTTON',id:'openHome',parentElement:{closest:()=>({id:'toolbar'})}};
  const window={floorplan:{homeMode:false},visualViewport:{scale:1,offsetLeft:0,offsetTop:2},
    addEventListener:(type,callback,options)=>listeners.push({type,callback,capture:options===true||options?.capture})};
  vm.runInNewContext(instrument+'\ninputInstrumentation();',{window,innerWidth:375,innerHeight:784,devicePixelRatio:1,performance:{now:()=>25}});
  const emit=(type,capture,overrides={})=>{
    const event=Object.freeze({type,target,isTrusted:true,pointerType:'touch',pointerId:7,clientX:50,clientY:100,
      defaultPrevented:false,timeStamp:12.75,cancelable:true,...overrides});
    for(const listener of listeners)if(listener.type===type&&(capture===undefined||Boolean(listener.capture)===capture))listener.callback(event);
  };
  emit('touchstart');emit('touchend');emit('click',true);
  window.floorplan.homeMode=true;emit('click',false);
  const input=JSON.parse(JSON.stringify(window.__acceptanceInput));
  assert.equal(input.trustedTouchStarts,1);assert.equal(input.trustedTouchEnds,1);
  const click=input.events.slice(-2);
  assert.deepEqual(click.map(event=>[event.phase,event.homeMode]),[['capture',false],['bubble',true]]);
  assert.deepEqual(click[0].target,{tag:'BUTTON',id:'openHome',container:'toolbar'});
  assert.deepEqual(click[0].client,[50,100]);
  assert.equal(click[0].eventTimeStamp,12.75,'Preserve the native timestamp separately from rounded observation time');
  assert.equal(click[0].time,25);assert.equal(click[0].cancelable,true);
  emit('pointerdown',true);emit('pointerdown',false,{defaultPrevented:true});
  const cancellation=window.__acceptanceInput.events.slice(-2);
  assert.equal(cancellation[0].defaultPrevented,false);
  assert.equal(cancellation[1].defaultPrevented,true);
  assert.equal(cancellation[1].phase,'bubble');
  assert.deepEqual(click[0].viewport,{width:375,height:784,dpr:1,scale:1,x:0,y:2});
  for(let n=0;n<100;n++)emit('pointercancel');
  assert.equal(window.__acceptanceInput.events.length,64,'Input evidence must remain bounded');
});

function freshPreviewHarness(view = 'preview') {
  const source = fs.readFileSync(path.join(__dirname, '../planner/editor.js'), 'utf8');
  const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const traces = [], canvases = [], renderers = [], scheduled = [], allocations = [];
  const error = {hidden:true}, rect = {width:774,height:724};
  let context, activeCanvas, currentFocus, layoutReads = 0, fitCalls = 0, reusedRestores = 0;
  class Canvas extends EventTarget {
    constructor() { super(); this.id='preview-canvas';this.width=934;this.height=824;this.isConnected=true;this.attributes={tabindex:'0','aria-label':'Preview'};this.captured=new Set();canvases.push(this); }
    focus() { currentFocus=this; }
    setPointerCapture(id) { this.captured.add(id); }
    hasPointerCapture(id) { return this.captured.has(id); }
    releasePointerCapture(id) { this.captured.delete(id); }
    cloneNode() {const copy=new Canvas();copy.isConnected=false;copy.attributes={...this.attributes};return copy;}
    replaceWith(next) { assert.equal(activeCanvas,this);this.isConnected=false;next.isConnected=true;activeCanvas=next; }
    emit(type, values={}) { const event=new Event(type,{cancelable:true});Object.assign(event,values);this.dispatchEvent(event);return event; }
  }
  for(const dimension of ['width','height']) Object.defineProperty(Canvas.prototype,dimension,{
    get(){return this[`_${dimension}`];},
    set(value){
      const renderer=renderers.find(renderer=>renderer.domElement===this);
      if(value===0&&renderer) {
        assert(renderer.lost&&renderer.disposed,'Shrink only after disposing the lost renderer');
        assert.equal(this.captured.size,0,'Release captured pointers before shrinking the lost canvas');
      }
      this[`_${dimension}`]=value;
    },
  });
  activeCanvas=new Canvas();
  const vector = () => ({x:0,y:0,z:0,set(x,y,z){Object.assign(this,{x,y,z});}});
  const resource = name => ({dispose(){traces.push(name);}});
  class Group {
    constructor() {this.children=[];}
    add(child) {this.children.push(child);}
    remove(child) {this.children.splice(this.children.indexOf(child),1);}
  }
  class Renderer {
    constructor({canvas}) {
      this.domElement=canvas;this.shadowMap={};this.id=renderers.length+1;this.lost=false;renderers.push(this);
      this.restored=()=>reusedRestores++;
      canvas.addEventListener('webglcontextrestored',this.restored);
    }
    setClearColor() {}
    getContext() {return {getExtension:()=>null};}
    setDrawingBufferSize(...args) {allocations.push(args);this.domElement.width=Math.floor(args[0]*args[2]);this.domElement.height=Math.floor(args[1]*args[2]);}
    render() {assert(!this.lost&&!this.disposed);traces.push(`render-${this.id}`);}
    dispose() { assert(this.lost || vm.runInContext('canvasSuspended',context));this.disposed=true;traces.push(`dispose-${this.id}`);this.domElement.removeEventListener('webglcontextrestored',this.restored); }
    forceContextLoss() {this.lost=true;traces.push(`retire-${this.id}`);this.domElement.emit('webglcontextlost');}
  }
  class Light {constructor(){this.position=vector();this.target={position:vector()};this.shadow={mapSize:{set(){}},map:resource('shadow-map'),mapPass:resource('shadow-pass'),dispose(){this.map?.dispose();this.mapPass?.dispose();}};}}
  const document = {hidden:false,get activeElement(){return currentFocus;},querySelector:()=>({getBoundingClientRect:()=>{layoutReads++;return rect;}})};
  const window = new EventTarget();
  context=vm.createContext({AbortController,console,document,window,devicePixelRatio:2,
    THREE:{WebGLRenderer:Renderer,Scene:Group,Group,Vector3:class {constructor(x,y,z){Object.assign(this,vector(),{x,y,z});}},HemisphereLight:Light,DirectionalLight:Light,
      PerspectiveCamera:class {constructor(){this.position=vector();}lookAt(){}updateProjectionMatrix(){} }},
    $:id=>id==='preview-canvas'?activeCanvas:error,translatedText(){},
    fitPreview(){fitCalls++;},fitPlan(){},updateZoom(){},previewFloors:()=>[],
    cancelCanvasRender(){traces.push('cancel');},onSchedule:value=>scheduled.push(JSON.parse(JSON.stringify(value))),
    testMesh:()=>({traverse(callback){callback({geometry:resource('geometry'),material:[resource('material-a'),resource('material-b')]});}}),
    planCanvas:{},ctx:{setTransform(){}},canvasObserver:{disconnect(){traces.push('disconnect');}},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../planner/render-capacity.js'), 'utf8').replace('export function ', 'function '), context);
  vm.runInContext(`
    let previewDirty=true,canvasSuspended=false,size={width:934,height:824},view=${JSON.stringify(view)};
    let firstResize=false,planSize='old',map={x:0,y:0};
    const project={floors:[{items:[{position_m:{x:7,z:9}}]}]};
    function requestCanvasRender(){if(!canvasSuspended&&!document.hidden)onSchedule(size);}
    ${section('function canvasPixelRatio(', 'let startupMessage')}
    ${section('let renderer =', 'function previewFloors()')}
    ${section('function disposePreviewGeometry()', 'function rebuildPreview()')}
    function rebuildPreview(){worldGroup.add(testMesh());previewDirty=false;}
    ${section('function drawPreview()', '// Project actions and keyboard navigation.')}
    ${section('function resizeCanvases(', 'const canvasObserver')}
    ${section("window.addEventListener('pagehide'", "window.planner =")}
    initPreview();rebuildPreview();
  `,context);
  const evaluate = code => vm.runInContext(code,context);
  return {traces,canvases,renderers,scheduled,allocations,error,rect,window,evaluate,
    get canvas(){return activeCanvas;},get layoutReads(){return layoutReads;},get fitCalls(){return fitCalls;},get reusedRestores(){return reusedRestores;},
    lose(){const renderer=renderers.at(-1);renderer.lost=true;return renderer.domElement.emit('webglcontextlost');},
    restore(){const renderer=renderers.at(-1);renderer.lost=false;renderer.domElement.emit('webglcontextrestored');},
    flush(){evaluate("view='preview';renderPreview();");},
  };
}

test('fresh preview retires old resources and handlers while preserving orbit, project and canvas identity', () => {
  const h=freshPreviewHarness();
  const original=h.canvas, project=h.evaluate('JSON.stringify(project)');
  original.focus();original.emit('pointerdown',{button:0,pointerId:9,clientX:10,clientY:20});
  assert(original.hasPointerCapture(9));
  h.evaluate('orbit.yaw=.7;orbit.pitch=.9;orbit.radius=42;orbit.baseRadius=30;orbit.target.set(4,5,6)');
  const orbit=h.evaluate('JSON.stringify({...orbit,pointer:null})');
  assert(h.lose().defaultPrevented);
  assert(!original.hasPointerCapture(9));
  assert.equal(h.evaluate('orbit.pointer'),null);
  assert.deepEqual(h.traces,['cancel','geometry','material-a','material-b','shadow-map','shadow-pass','dispose-1']);
  assert.deepEqual([original.width,original.height],[0,0],'A lost canvas must not restore its former full-size backing buffer');
  h.restore();
  assert.notEqual(h.canvas,original);
  assert.deepEqual(h.canvas.attributes,original.attributes);
  assert.equal(h.reusedRestores,0,'Disposed Three listeners cannot initialize a restored native context');
  assert.equal(h.renderers.length,1,'No renderer is allocated in the restored event');
  assert(h.renderers[0].lost&&h.renderers[0].disposed);
  assert.equal(h.canvases.filter(canvas=>canvas.isConnected).length,1);
  assert.equal(h.evaluate('JSON.stringify({...orbit,pointer:null})'),orbit);
  assert.equal(h.evaluate('JSON.stringify(project)'),project);
  assert.equal(h.error.hidden,true);
  assert(h.evaluate('document.activeElement === previewCanvas'),'Canvas focus survives replacement');
  h.flush();
  assert.equal(h.renderers.length,2);
  assert(h.canvas.width>1&&h.canvas.height>1,'The replacement resumes rendering at the full viewport budget');
  assert.deepEqual([original.width,original.height],[0,0],'The detached canvas keeps minimal storage after its replacement renders');
  assert.equal(h.renderers.filter(renderer=>!renderer.lost).length,1);
  assert.equal(h.fitCalls,2,'Replacement initialization must not refit and reset the saved orbit');
  assert.equal(h.evaluate('JSON.stringify({...orbit,pointer:null})'),orbit);
  const before=h.evaluate('orbit.yaw');
  original.emit('pointerdown',{button:0,pointerId:3,clientX:10,clientY:20});
  original.emit('pointermove',{pointerId:3,clientX:40,clientY:30});
  original.emit('keydown',{key:'ArrowLeft'});original.emit('wheel',{deltaY:10});
  assert.equal(h.evaluate('orbit.yaw'),before,'The detached canvas has no surviving input callbacks');
  h.canvas.emit('pointerdown',{button:0,pointerId:4,clientX:10,clientY:20});
  h.canvas.emit('pointermove',{pointerId:4,clientX:40,clientY:30});
  h.canvas.emit('pointerup',{pointerId:4});h.flush();
  assert.notEqual(h.evaluate('orbit.yaw'),before,'Replacement canvas still supports actual pointer orbit');
  assert(!h.canvas.hasPointerCapture(4));
  assert.equal(h.evaluate('JSON.stringify(project)'),project);
  h.lose();h.restore();h.flush();
  assert.equal(h.renderers.length,3);
  assert.equal(h.renderers.filter(renderer=>!renderer.lost).length,1,'Repeated recovery does not leak active contexts');
  assert.equal(h.canvases.filter(canvas=>canvas.isConnected).length,1);
  const pagehide=new Event('pagehide');Object.assign(pagehide,{persisted:false});h.window.dispatchEvent(pagehide);
  assert(h.renderers.every(renderer=>renderer.disposed&&renderer.lost),'Final navigation releases every context');
  const finalOrbit=h.evaluate('orbit.yaw');h.canvas.emit('keydown',{key:'ArrowLeft'});
  assert.equal(h.evaluate('orbit.yaw'),finalOrbit,'Final teardown removes input listeners');
});

test('replacement preview keeps the active orbit when another pointer presses or releases', () => {
  const h=freshPreviewHarness();h.lose();h.restore();h.flush();
  const canvas=h.canvas;
  canvas.emit('pointerdown',{button:0,pointerId:1,clientX:10,clientY:20});
  canvas.emit('pointerdown',{button:0,pointerId:2,clientX:100,clientY:200});
  assert.equal(h.evaluate('orbit.pointer.id'),1,'A second pointer cannot replace the active gesture');
  assert(!canvas.hasPointerCapture(2));
  const yaw=h.evaluate('orbit.yaw');
  canvas.emit('pointermove',{pointerId:2,clientX:180,clientY:250});
  assert.equal(h.evaluate('orbit.yaw'),yaw);
  canvas.emit('pointerup',{pointerId:2});canvas.emit('pointercancel',{pointerId:2});
  assert.equal(h.evaluate('orbit.pointer.id'),1,'Unrelated up/cancel events cannot end the active gesture');
  canvas.emit('pointermove',{pointerId:1,clientX:40,clientY:30});
  assert.notEqual(h.evaluate('orbit.yaw'),yaw);
  canvas.emit('pointerup',{pointerId:1});
  assert.equal(h.evaluate('orbit.pointer'),null);assert(!canvas.hasPointerCapture(1));
});

test('restoration while in the page cache retires the context and resumes rendering on pageshow', () => {
  const h=freshPreviewHarness();h.lose();
  const pagehide=new Event('pagehide');Object.assign(pagehide,{persisted:true});h.window.dispatchEvent(pagehide);
  const scheduled=h.scheduled.length;h.restore();
  assert.equal(h.scheduled.length,scheduled,'A cached page cannot schedule a preview frame');
  assert(h.evaluate('canvasSuspended && !previewLost'));
  assert.equal(h.renderers.length,1);
  h.window.dispatchEvent(new Event('pageshow'));h.flush();
  assert(h.evaluate('!canvasSuspended && !previewLost'));
  assert.equal(h.renderers.length,2);
  assert.equal(h.renderers.filter(renderer=>!renderer.lost).length,1);
});

test('planner records the phase and lost state of failed restored shader links', () => {
  const source = fs.readFileSync(path.join(__dirname, 'test-planner-stability.cjs'), 'utf8');
  const instrument = source.slice(source.indexOf('function instrument()'), source.indexOf('const server='));
  let lost = false;
  const gl = {VERSION:1,RENDERER:2,LINK_STATUS:3,getExtension:()=>null,getParameter:()=> 'WebGL 2.0',
    linkProgram() {},getProgramParameter:()=>!lost,getProgramInfoLog:()=>null,isContextLost:()=>lost};
  class Canvas extends EventEmitter {
    get width() {return 1462;} set width(value) {}
    get height() {return 1367;} set height(value) {}
    getContext() {return gl;}
    addEventListener(name, callback) {this.on(name, callback);}
  }
  const window = {addEventListener() {},planner:{getView:()=> 'preview'}};
  const context = vm.createContext({window,HTMLCanvasElement:Canvas,performance:{now:()=>100},console:{error() {},info() {}}});
  vm.runInContext(instrument + '\ninstrument();', context);
  const canvas = new Canvas();canvas.getContext('webgl2');
  window.__plannerRecoveryPhase='request-loss';lost=true;canvas.emit('webglcontextlost',{statusMessage:''});
  window.__plannerRecoveryPhase='request-restore';lost=false;canvas.emit('webglcontextrestored',{statusMessage:''});
  lost=true;gl.linkProgram({});canvas.emit('webglcontextlost',{statusMessage:'driver reset'});
  const stats=JSON.parse(JSON.stringify(window.__plannerStats));
  assert.equal(stats.contextLosses,2);
  assert.deepEqual(stats.shaderErrors,[null],'A null driver log remains a failed shader link');
  assert.deepEqual(stats.linkFailures,[{log:null,lost:true,program:1,phase:'request-restore',time:100}]);
  assert.equal(stats.contextEvents[2].phase,'request-restore');
  assert.equal(stats.contextEvents[2].statusMessage,'driver reset');
  assert.deepEqual(stats.contextEvents[2].buffer,[1462,1367]);
});

test('a detached context loss is retirement only when its actual loseContext request was recorded', () => {
  const source=fs.readFileSync(path.join(__dirname,'test-planner-stability.cjs'),'utf8');
  const instrument=source.slice(source.indexOf('function instrument()'),source.indexOf('const server='));
  for(const [detached,requested,expected] of [[true,false,0],[true,true,1],[false,true,0]]) {
    let lost=false,current;
    const extension={loseContext(){lost=true;},restoreContext(){lost=false;}};
    const gl={VERSION:1,RENDERER:2,LINK_STATUS:3,getExtension:name=>name==='WEBGL_lose_context'?extension:null,
      getParameter:()=> 'WebGL 2.0',linkProgram(){},getProgramParameter:()=>true,isContextLost:()=>lost};
    class Canvas extends EventEmitter {
      constructor(){super();this.isConnected=true;}
      get width(){return 800;}set width(value){}
      get height(){return 600;}set height(value){}
      getContext(){return gl;}
      addEventListener(name,callback){this.on(name,callback);}
    }
    const window={addEventListener(){},planner:{getView:()=> 'preview'}};
    const context=vm.createContext({window,HTMLCanvasElement:Canvas,document:{getElementById:()=>current},
      performance:{now:()=>100},console:{error(){},info(){}}});
    vm.runInContext(instrument+'\ninstrument();',context);
    const canvas=current=new Canvas();const ext=canvas.getContext('webgl2').getExtension('WEBGL_lose_context');
    ext.loseContext();canvas.emit('webglcontextlost',{});
    ext.restoreContext();canvas.emit('webglcontextrestored',{});
    if(detached){canvas.isConnected=false;current={};}
    if(requested)ext.loseContext();else lost=true;
    canvas.emit('webglcontextlost',{});
    const stats=JSON.parse(JSON.stringify(window.__plannerStats));
    assert.equal(stats.contextLosses,2,'Every real and synthetic event remains counted');
    assert.equal(stats.retiredContextLosses,expected);
    assert.equal(stats.contextEvents[2].retired,Boolean(expected));
    assert.equal(stats.contextEvents[2].lossRequest,requested?2:null);
    assert.equal(stats.contextLossRequests.length,requested?2:1);
    assert(stats.contextLossRequests.every(request=>request.matched));
  }
});

test('planner recovery variants select real actions and retain restoration checks', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'test-planner-stability.cjs'), 'utf8');
  const settings = source.slice(source.indexOf('const restoreLayout ='), source.indexOf('const diagnostics ='));
  const recoveryBlock = source.slice(source.indexOf('    let recovery=null;'), source.indexOf('    record.input='));
  assert(settings && recoveryBlock, 'Exercise the actual selector and recovery sequence');
  for (const value of ['', 'typo', 'edit,resize']) {
    assert.throws(() => vm.runInNewContext(settings, {assert, process:{env:{PLANNER_STABILITY_RECOVERY_ACTIONS:value}}}), /RECOVERY_ACTIONS must be/);
  }
  async function recover(actions, layoutMode, secondLoss = false) {
    const env = {PLANNER_STABILITY_RESTORE_LAYOUT:layoutMode};
    if (actions !== undefined) env.PLANNER_STABILITY_RECOVERY_ACTIONS=actions;
    const trace = [], record = {}, checks = [], stats = {contextLosses:0,retiredContextLosses:0,contexts:1,contextLossRequests:[],restoredBuffers:[],shaderErrors:[],errors:[]};
    const project = {floors:[{items:[{position_m:{x:2,z:1}}]}]};
    const memory = {geometries:2077,textures:1}, orbit=[0,0,10];
    let lost=false, renderCount=1, viewport={width:1440,height:1000}, exported, resizedWhileLost=false;
    const beforeImmediateRestore=[];
    const recordRoundTrip=operation=>{if(resizedWhileLost&&layoutMode==='immediate')beforeImmediateRestore.push(operation);};
    const copy = value => JSON.parse(JSON.stringify(value));
    const current = () => copy({stats,preview:{renderCount,catalogItems:256,viewport},
      scene:{memory,pixelRatio:1,buffer:[viewport.width,viewport.height],orbit}});
    const extension = {
      loseContext() {lost=true;stats.contextLosses++;stats.contextLossRequests.push({contextId:1,attached:true,retirement:false,matched:true});trace.push('lose');},
      restoreContext() {assert(lost);lost=false;resizedWhileLost=false;stats.contextLosses++;stats.retiredContextLosses=1;stats.contexts=2;stats.contextLossRequests.push({contextId:1,attached:false,retirement:true,matched:true});stats.restoredBuffers.push({contextId:1,canvas:[0,0],drawingBuffer:[1,1],lost:false});if(secondLoss)stats.contextLosses++;trace.push('restore');},
    };
    const window = {__plannerStats:stats,planner:{getPreviewMetadata:()=>current().preview},
      __plannerScene:()=>({layout:viewport}),
      __plannerContextStates:()=>[{id:1,attached:false,lost:true,restores:1},{id:2,attached:true,lost:false,restores:0}]};
    const document = {querySelector: selector => selector === '.canvas-shell'
      ? {getBoundingClientRect:()=>viewport}
      : {getContext:()=>({getExtension:()=>extension})}};
    const page = {
      locator: selector => selector==='#preview-canvas'?{count:async()=>1,scrollIntoViewIfNeeded:async()=>{},boundingBox:async()=>({x:0,y:0,width:800,height:600})}:selector,
      evaluate: async (callback, argument) => {recordRoundTrip('evaluate');return callback(argument);},
      waitForFunction: async (callback, argument) => assert(callback(argument)),
      waitForEvent: async event => {assert.equal(event,'download');return {path:async ()=>'fixture-export.json'};},
      setViewportSize: async size => {assert(lost);trace.push('resize');viewport=copy(size);resizedWhileLost=true;},
    };
    const input = {drag:async()=>{orbit[0]+=.2;renderCount++;},tap:async selector => {
      if(selector==='#preview-tab'&&!lost)renderCount++;
      if(selector==='#export-project'){assert(lost);trace.push('export');exported=copy(project);}
    }};
    const crossRealmAssert = Object.assign((...args)=>assert(...args), assert, {
      deepEqual:(actual,expected,message)=>assert.deepEqual(copy(actual),copy(expected),message),
    });
    const context = {assert:crossRealmAssert,process:{env},record,reportOnly:false,page,input,window,document,
      frames:async()=>{recordRoundTrip('frames');},save(){},getProject:async()=>copy(project),
      snapshot:async()=>{recordRoundTrip('snapshot');return current();},
      profile:{emulated:false},consoleErrors:[],samples:[{scene:{memory}}],
      fs:{readFileSync:()=>JSON.stringify(exported)},
      check:(condition,message)=>{checks.push(message);assert(condition,message);},
      burst:async()=>assert(lost),
      dragWorld:async (from,to)=>{assert(lost);trace.push('edit');project.floors[0].items[0].position_m={x:to[0],z:to[1]};},
    };
    Object.defineProperties(context, {innerWidth:{get:()=>viewport.width},innerHeight:{get:()=>viewport.height}});
    await vm.runInNewContext(settings + '\n(async()=>{\n' + recoveryBlock + '\n})()', context);
    return {trace,record,checks,project,exported,beforeImmediateRestore};
  }
  for (const actions of [undefined,'all','none','edit','resize']) {
    for (const layout of ['immediate','settled']) {
      const {trace,record,checks,project,exported,beforeImmediateRestore}=await recover(actions,layout);
      const mode=actions??'all', edit=['all','edit'].includes(mode), resize=['all','resize'].includes(mode);
      assert.deepEqual(trace,['lose',...(edit?['edit']:[]),'export',...(resize?['resize']:[]),'restore']);
      assert.equal(record.recovery.actions,mode);
      assert.equal(record.recovery.layoutMode,layout);
      assert.equal(record.recovery.traceEnabled,false);
      assert.equal(Boolean(record.recovery.settledLayout),layout==='settled');
      if(resize&&layout==='immediate')assert.deepEqual(beforeImmediateRestore,['evaluate'],
        'The very next browser evaluation after resizing must capture evidence and restore without an intervening round trip');
      const restore=record.recovery.steps.find(step=>step.phase==='request-restore');
      assert.equal(restore.snapshot.stats.contextLosses,1);
      assert.equal(restore.snapshot.preview.renderCount,record.recovery.steps[0].snapshot.preview.renderCount,
        'The checkpoint must precede the restored draw');
      assert.equal(project.floors[0].items[0].position_m.x,edit?1.5:2);
      assert.deepEqual(project,exported,'Each selected sequence preserves its own exported project');
      assert(checks.includes('Restoration must have only the deliberate loss and detached-context retirement'));
      assert(checks.includes('Restored preview shaders link successfully'));
    }
    await assert.rejects(recover(actions,'immediate',true), /must have only the deliberate loss and detached-context retirement/);
  }
});

test('planner recovery traces loss across resize and render without sampling normal frames', () => {
  const source=fs.readFileSync(path.join(__dirname,'test-planner-stability.cjs'),'utf8');
  const instrument=source.slice(source.indexOf('function instrument()'),source.indexOf('const server='));
  class Canvas {
    get width(){return 800;} set width(value){}
    get height(){return 600;} set height(value){}
    getContext(){}
  }
  let time=0, reads=0, lost=false, failRender=false, failLayout=false;
  const gl={isContextLost:()=>lost,drawingBufferWidth:800,drawingBufferHeight:600};
  const canvas={width:800,height:600}, originalError=new Error('original render failure');
  const renderer={domElement:canvas,
    getContext(){reads++;return gl;},getRenderTarget:()=>null,
    setDrawingBufferSize(width,height,ratio){
      assert.equal(this,renderer);canvas.width=width*ratio;canvas.height=height*ratio;
      gl.drawingBufferWidth=canvas.width;gl.drawingBufferHeight=canvas.height;lost=true;return 'resized';
    },
    render(scene,camera){assert.equal(this,renderer);assert.equal(scene,'scene');assert.equal(camera,'camera');if(failRender)throw originalError;return 'rendered';},
  };
  const window={addEventListener(){}};
  const context=vm.createContext({window,HTMLCanvasElement:Canvas,performance:{now:()=>++time},console:{error(){},info(){}}});
  vm.runInContext(instrument+'\ninstrument();',context);
  const readLayout=()=>{if(failLayout)throw Error('layout probe failed');return {layout:{width:800,height:600},shell:{width:700,height:500},viewport:[1280,900],view:'preview'};};
  window.__plannerTraceRenderer(renderer,readLayout);
  window.__plannerTraceRenderer(renderer,readLayout);
  assert.equal(renderer.render('scene','camera'),'rendered');
  assert.equal(reads,0,'Ordinary frames perform no GL sampling');
  assert.equal(window.__plannerStats.recoveryOperations.length,0);
  window.__plannerRecoveryPhase='request-restore';
  assert.equal(renderer.setDrawingBufferSize(700,500,2),'resized');
  const resize=JSON.parse(JSON.stringify(window.__plannerStats.recoveryOperations[0]));
  assert.deepEqual(resize.requestedSize,[700,500,2]);
  assert.equal(resize.before.lost,false);assert.equal(resize.after.lost,true);
  assert.deepEqual(resize.before.buffer,[800,600]);assert.deepEqual(resize.after.drawingBuffer,[1400,1000]);
  assert.deepEqual(resize.before.layout,{width:800,height:600});assert.deepEqual(resize.before.shell,{width:700,height:500});
  assert(resize.after.time>resize.before.time);
  failRender=true;
  assert.throws(()=>renderer.render('scene','camera'),error=>error===originalError);
  const failed=window.__plannerStats.recoveryOperations[1];
  assert.equal(failed.before.lost,true);assert.equal(failed.after.lost,true);
  assert.match(failed.error,/original render failure/);
  failLayout=true;
  assert.throws(()=>renderer.render('scene','camera'),error=>error===originalError,'A failed diagnostic cannot replace the original render exception');
  assert.match(window.__plannerStats.recoveryOperations[2].after.diagnosticError,/layout probe failed/);
  failLayout=false;failRender=false;
  for(let i=0;i<30;i++)renderer.render('scene','camera');
  assert.equal(window.__plannerStats.recoveryOperations.length,30);
  const cappedReads=reads;
  assert.equal(renderer.render('scene','camera'),'rendered');
  assert.equal(reads,cappedReads,'The bounded trace stops GL sampling after 30 recovery operations');
});

test('planner operation tracing is opt-in and primary acceptance makes no layout probes', () => {
  const source=fs.readFileSync(path.join(__dirname,'test-planner-stability.cjs'),'utf8');
  const settings=source.slice(source.indexOf('const restoreLayout ='),source.indexOf('const diagnostics ='));
  const start=source.indexOf('const server=http.createServer('),end=source.indexOf('\nasync function run(',start);
  for(const value of ['', 'true', 'typo']) {
    assert.throws(()=>vm.runInNewContext(settings,{assert,process:{env:{PLANNER_STABILITY_TRACE_RECOVERY:value}}}),/TRACE_RECOVERY must be/);
  }
  for(const value of [undefined,'0','1']) {
    const env=value===undefined?{}:{PLANNER_STABILITY_TRACE_RECOVERY:value};
    const traceRecovery=vm.runInNewContext(settings+'\ntraceRecovery',{assert,process:{env}});
    assert.equal(traceRecovery,value==='1');
    const handle=vm.runInNewContext(source.slice(start,end)+'\nserver',{
      startup:require('./browser-startup-diagnostics.cjs').createStartupDiagnostics(),sourceHash:null,
      http:{createServer:callback=>callback},URL,path,root:'/fixture',fixtureOnly:false,traceRecovery,
      fs:{existsSync:()=>true,statSync:()=>({isFile:()=>true})},
      editor:'function initPreview(){renderer={ready:true};return 42;}',
    });
    let served,layoutReads=0;
    handle({url:'/planner/editor.js'},{writeHead(){return this;},end(content){served=content;}});
    const attached=[],context={renderer:null,size:{width:800,height:600},view:'preview',innerWidth:1280,innerHeight:900,
      document:{querySelector:()=>({getBoundingClientRect:()=>{layoutReads++;return {width:700,height:500};}})},
      window:{__plannerRecoveryPhase:'request-restore',__plannerTraceRenderer:(renderer,readLayout)=>attached.push({renderer,layout:readLayout()})},
    };
    assert.equal(vm.runInNewContext(served+'\ninitPreview();',context),42);
    assert.equal(attached.length,traceRecovery?1:0,'Primary acceptance installs no renderer operation wrappers');
    assert.equal(layoutReads,traceRecovery?1:0,'Primary acceptance performs no operation-trace layout reads');
    if(traceRecovery) {
      assert.equal(attached[0].renderer.ready,true);
      assert.deepEqual(JSON.parse(JSON.stringify(attached[0].layout)),{layout:{width:800,height:600},shell:{width:700,height:500},viewport:[1280,900],view:'preview'});
    }
  }
});

test('the first replacement drawing buffer uses actual layout before ResizeObserver delivery', () => {
  for(const view of ['plan','preview']) {
    const h=freshPreviewHarness(view);h.lose();h.restore();
    assert.equal(h.layoutReads,1);
    assert.equal(h.allocations.length,0,'The context event only schedules rendering');
    assert(h.scheduled.length>0);
    assert(h.scheduled.every(layout=>layout.width===774&&layout.height===724));
    h.flush();
    assert.equal(h.allocations.length,1);
    assert.deepEqual(h.allocations[0],[774,724,Math.sqrt(2000000/(774*724))]);
  }
});
