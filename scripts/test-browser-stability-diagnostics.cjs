// Fast unit checks for acceptance receipts; no browser or graphics driver needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const vm = require('node:vm');
const {test, after} = require('node:test');
const {createDiagnostics, positiveInteger, selectedEngines, browserLaunchOptions, browserProfile, loadPlaywright, browserIdentity, createInputDriver} = require('./browser-stability-diagnostics.cjs');

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

test('planner disposes geometry and shadow callbacks before restoring the GL context', () => {
  const source = fs.readFileSync(path.join(__dirname, '../planner/editor.js'), 'utf8');
  const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  let lost = false, scheduled = 0, cancelled = 0;
  const disposed = [], handlers = {};
  const resource = name => ({dispose() {
    assert(lost, 'Old WebGL resources must be released while their context is lost');
    disposed.push(name);
  }});
  const objects = [{geometry:resource('geometry'),material:[resource('material-a'),resource('material-b')]}];
  const group = {children:[{traverse: callback => objects.forEach(callback)}],
    remove(child) { this.children.splice(this.children.indexOf(child), 1); }};
  const shadow = {map:resource('shadow-map'),mapPass:resource('shadow-pass'),needsUpdate:false,
    dispose() { this.map?.dispose(); this.mapPass?.dispose(); }};
  const error = {hidden:true};
  const context = vm.createContext({worldGroup:group,previewSun:{shadow},
    previewCanvas:{addEventListener: (name, callback) => { handlers[name] = callback; }},
    cancelCanvasRender: () => cancelled++,requestCanvasRender: () => scheduled++,$: () => error,translatedText() {}});
  vm.runInContext("let previewLost = false, previewDirty = false, previewSize = 'before';\n" +
    section('function disposePreviewGeometry()', 'function rebuildPreview()') +
    section("previewCanvas.addEventListener('webglcontextlost'", '// Project actions and keyboard navigation.'), context);
  lost = true;
  let prevented = false;
  handlers.webglcontextlost({preventDefault() { prevented = true; }});
  assert(prevented);
  assert.equal(cancelled, 1);
  assert.equal(scheduled, 0, 'A lost context cannot schedule drawing');
  assert.deepEqual(disposed, ['geometry','material-a','material-b','shadow-map','shadow-pass']);
  assert.equal(group.children.length, 0);
  assert.equal(shadow.map, null);
  assert.equal(shadow.mapPass, null);
  assert.equal(vm.runInContext('previewDirty && previewLost', context), true);
  lost = false;
  handlers.webglcontextrestored();
  shadow.dispose(); // Later page teardown must not invoke stale target callbacks.
  assert.equal(scheduled, 1);
  assert.equal(shadow.needsUpdate, true);
  assert.equal(error.hidden, true);
  assert.equal(vm.runInContext("!previewLost && previewSize === '' && previewDirty", context), true);
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
    const trace = [], record = {}, checks = [], stats = {contextLosses:0,shaderErrors:[]};
    const project = {floors:[{items:[{position_m:{x:2,z:1}}]}]};
    const memory = {geometries:2077,textures:1};
    let lost=false, renderCount=1, viewport={width:1440,height:1000}, exported;
    const copy = value => JSON.parse(JSON.stringify(value));
    const current = () => copy({stats,preview:{renderCount,catalogItems:256,viewport},
      scene:{memory,pixelRatio:1,buffer:[viewport.width,viewport.height]}});
    const extension = {
      loseContext() {lost=true;stats.contextLosses++;trace.push('lose');},
      restoreContext() {assert(lost);lost=false;if(secondLoss)stats.contextLosses++;trace.push('restore');},
    };
    const window = {__plannerStats:stats,planner:{getPreviewMetadata:()=>current().preview},
      __plannerScene:()=>({layout:viewport})};
    const document = {querySelector: selector => selector === '.canvas-shell'
      ? {getBoundingClientRect:()=>viewport}
      : {getContext:()=>({getExtension:()=>extension})}};
    const page = {
      locator: selector => selector,
      evaluate: async (callback, argument) => callback(argument),
      waitForFunction: async (callback, argument) => assert(callback(argument)),
      waitForEvent: async event => {assert.equal(event,'download');return {path:async ()=>'fixture-export.json'};},
      setViewportSize: async size => {assert(lost);trace.push('resize');viewport=copy(size);},
    };
    const input = {tap:async selector => {
      if(selector==='#preview-tab'&&!lost)renderCount++;
      if(selector==='#export-project'){assert(lost);trace.push('export');exported=copy(project);}
    }};
    const crossRealmAssert = Object.assign((...args)=>assert(...args), assert, {
      deepEqual:(actual,expected,message)=>assert.deepEqual(copy(actual),copy(expected),message),
    });
    const context = {assert:crossRealmAssert,process:{env},record,reportOnly:false,page,input,window,document,
      frames:async()=>{},save(){},getProject:async()=>copy(project),snapshot:async()=>current(),
      profile:{emulated:false},consoleErrors:[],samples:[{scene:{memory}}],
      fs:{readFileSync:()=>JSON.stringify(exported)},
      check:(condition,message)=>{checks.push(message);assert(condition,message);},
      burst:async()=>assert(lost),
      dragWorld:async (from,to)=>{assert(lost);trace.push('edit');project.floors[0].items[0].position_m={x:to[0],z:to[1]};},
    };
    Object.defineProperties(context, {innerWidth:{get:()=>viewport.width},innerHeight:{get:()=>viewport.height}});
    await vm.runInNewContext(settings + '\n(async()=>{\n' + recoveryBlock + '\n})()', context);
    return {trace,record,checks,project,exported};
  }
  for (const actions of [undefined,'all','none','edit','resize']) {
    for (const layout of ['immediate','settled']) {
      const {trace,record,checks,project,exported}=await recover(actions,layout);
      const mode=actions??'all', edit=['all','edit'].includes(mode), resize=['all','resize'].includes(mode);
      assert.deepEqual(trace,['lose',...(edit?['edit']:[]),'export',...(resize?['resize']:[]),'restore']);
      assert.equal(record.recovery.actions,mode);
      assert.equal(record.recovery.layoutMode,layout);
      assert.equal(Boolean(record.recovery.settledLayout),layout==='settled');
      assert.equal(project.floors[0].items[0].position_m.x,edit?1.5:2);
      assert.deepEqual(project,exported,'Each selected sequence preserves its own exported project');
      assert(checks.includes('Restoration must not lose the graphics context again'));
      assert(checks.includes('Restored preview shaders link successfully'));
    }
    await assert.rejects(recover(actions,'immediate',true), /must not lose the graphics context again/);
  }
});
