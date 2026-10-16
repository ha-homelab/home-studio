// Persistent evidence for the fictional-data browser acceptance checks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

function positiveInteger(name, fallback, maximum) {
  const value = Number(process.env[name] ?? fallback);
  assert(Number.isSafeInteger(value) && value > 0 && value <= maximum,
    `${name} must be an integer between 1 and ${maximum}`);
  return value;
}

function selectedEngines(value = 'chromium,firefox') {
  const engines = value.split(',').map(engine => engine.trim());
  assert(engines.length > 0 && engines.every(engine => ['chromium', 'firefox', 'webkit'].includes(engine)),
    'Select Chromium, Firefox and/or WebKit; empty or unsupported engine names are not accepted');
  assert(new Set(engines).size === engines.length, 'Each browser engine must be selected only once');
  return engines;
}

function browserLaunchOptions(engine, headless) {
  const channel = process.env.HOME_STUDIO_BROWSER_CHANNEL || undefined;
  assert(!channel || ['chrome', 'chrome-beta', 'msedge', 'msedge-beta'].includes(channel),
    'HOME_STUDIO_BROWSER_CHANNEL must be chrome, chrome-beta, msedge or msedge-beta');
  assert(!channel || engine === 'chromium', 'Browser channels require the Chromium engine');
  if (engine === 'webkit') return {headless};
  if (engine === 'chromium') {
    const backend = process.env.CHROMIUM_ANGLE_BACKEND || 'swiftshader';
    assert(['metal', 'swiftshader'].includes(backend), 'CHROMIUM_ANGLE_BACKEND must be metal or swiftshader');
    // Software rendering remains explicit on GPU-less runners. macOS can
    // exercise its native Metal backend without forcing the SwiftShader driver.
    return {headless, channel, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
      args: ['--enable-webgl', `--use-angle=${backend}`,
        ...(backend === 'swiftshader' ? ['--enable-unsafe-swiftshader'] : [])]};
  }
  assert.equal(engine, 'firefox', 'A supported browser engine is required');
  const backend = process.env.FIREFOX_WEBGL_BACKEND || 'default';
  assert(['default', 'angle'].includes(backend), 'FIREFOX_WEBGL_BACKEND must be default or angle');
  const compositor = process.env.FIREFOX_COMPOSITOR_BACKEND || 'default';
  assert(['default', 'software'].includes(compositor), 'FIREFOX_COMPOSITOR_BACKEND must be default or software');
  const gpuProcess = process.env.FIREFOX_GPU_PROCESS ?? 'default';
  assert(['default', 'disabled'].includes(gpuProcess), 'FIREFOX_GPU_PROCESS must be default or disabled');
  // GPU-less Windows runners otherwise block WebGL2 before creating a context.
  // This allows the real software backend; all rendering assertions still run.
  // https://bugzilla.mozilla.org/show_bug.cgi?id=1970486
  return {headless, firefoxUserPrefs: {
    'webgl.force-enabled': true,
    // Firefox otherwise collapses all Apple renderer names, including software,
    // to "Apple M1, or similar". Expose the real backend in this test profile.
    // This preference changes the reported string, not the selected GL backend.
    'webgl.sanitize-unmasked-renderer': false,
    // Opt-in for macOS virtual machines whose native CGL implementation falls
    // back to Apple Software Renderer. Verify the selected backend below.
    ...(backend === 'angle' ? {'webgl.disable-angle': false} : {}),
    // Isolate the legacy macOS VM compositor fallback experiment from WebGL.
    // The requested preference is preserved in launch diagnostics; the actual
    // WebGL renderer and all acceptance assertions remain independently checked.
    ...(compositor === 'software' ? {'gfx.webrender.software': true} : {}),
    // Software WebRender does not disable the separate GPU process on macOS.
    // This opt-in isolates that process while retaining the WebGL backend.
    // ESR153 defaults layers.gpu-process.force-enabled to false.
    // Headed macOS/Windows also require parent-process WebGL permission:
    // gfxPlatform::InitWebGLConfig otherwise disables WebGL before force-enabled.
    ...(gpuProcess === 'disabled' ? {
      'layers.gpu-process.enabled': false, 'webgl.allow-in-parent': true,
    } : {}),
  }};
}

// These are viewport/input profiles, not claims of testing a real Android/iOS OS.
function browserProfile(engine, desktop) {
  const name = process.env.HOME_STUDIO_BROWSER_PROFILE || 'desktop';
  assert(['desktop', 'phone', 'tablet'].includes(name),
    'HOME_STUDIO_BROWSER_PROFILE must be desktop, phone or tablet');
  const touch = name !== 'desktop';
  const context = touch ? {
    viewport: name === 'phone' ? {width: 390, height: 844} : {width: 820, height: 1180},
    deviceScaleFactor: 2, hasTouch: true, locale: 'en-US',
    // Playwright explicitly does not support isMobile on Firefox.
    ...(engine === 'firefox' ? {} : {isMobile: true}),
  } : {...desktop, locale: 'en-US'};
  return {name, context, emulated: touch, realMobileOS: false,
    input: touch ? (engine === 'chromium' ? 'native-touch' : 'native-tap-and-mouse-drag') : 'mouse',
    limitation: touch && engine !== 'chromium'
      ? 'Playwright exposes native taps but no public native touch-drag transport for this engine.' : null};
}

function loadPlaywright(modulePath = process.env.HOME_STUDIO_PLAYWRIGHT_MODULE) {
  assert(!modulePath || path.isAbsolute(modulePath), 'HOME_STUDIO_PLAYWRIGHT_MODULE must be an absolute package directory');
  const resolved = modulePath || 'playwright';
  return {playwright: require(resolved), version: require(path.join(resolved, 'package.json')).version};
}

// Persist actual platform/UA independently from the requested channel/profile.
async function browserIdentity(page, engine, launch, version) {
  const identity = await page.evaluate(() => ({userAgent: navigator.userAgent,
    platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints,
    userAgentData: navigator.userAgentData?.toJSON() || null}));
  const ua = identity.userAgent;
  const brands = identity.userAgentData?.brands?.map(value => value.brand) || [];
  const product = /Edg\//.test(ua) ? 'Microsoft Edge' : /(?:Chrome|HeadlessChrome)\//.test(ua)
    ? (brands.includes('Google Chrome') ? 'Google Chrome' : 'Chromium-compatible')
    : /Firefox\//.test(ua) ? 'Firefox' : engine === 'webkit' ? 'Playwright WebKit' : 'unknown';
  const expected = process.env.HOME_STUDIO_EXPECT_BROWSER_MAJOR;
  if (expected) {
    assert(/^[1-9]\d*$/.test(expected), 'HOME_STUDIO_EXPECT_BROWSER_MAJOR must be a positive integer');
    assert.equal(Number(version.split('.')[0]), Number(expected), 'Actual browser major must match the pinned browser major');
  }
  const expectedVersion = process.env.HOME_STUDIO_EXPECT_BROWSER_VERSION;
  if (expectedVersion) assert.equal(version, expectedVersion, 'Actual browser version must match the complete pinned browser version');
  if (launch.channel?.startsWith('msedge')) assert(/Edg\//.test(ua), 'The requested Edge executable must identify itself as Edge');
  if (launch.channel?.startsWith('chrome')) assert(/(?:Chrome|HeadlessChrome)\//.test(ua) && !/Edg\//.test(ua),
    'The requested Chrome executable must identify itself as Chrome');
  if (launch.channel?.startsWith('chrome') && brands.length) assert(brands.includes('Google Chrome'),
    'The requested Chrome channel must report its actual Google Chrome brand');
  return {...identity, product, engine, browserVersion: version, requestedChannel: launch.channel || null};
}

function inputInstrumentation() {
  window.__acceptanceInput = {trustedTouchStarts: 0, trustedTouchMoves: 0, trustedTouchEnds: 0,
    trustedTouchPointerDowns: 0, trustedTouchPointerMoves: 0, trustedMousePointerDowns: 0, events: []};
  const counts = window.__acceptanceInput;
  const record = (event, phase) => {
    const point = event.changedTouches?.[0] || event;
    const viewport = window.visualViewport;
    counts.events.push({type:event.type,phase,time:Math.round(performance.now()),eventTimeStamp:event.timeStamp,
      cancelable:event.cancelable,trusted:event.isTrusted,
      target:{tag:event.target?.tagName||null,id:event.target?.id||null,container:event.target?.parentElement?.closest('[id]')?.id||null},
      pointerType:event.pointerType||null,pointerId:event.pointerId??null,client:[point.clientX??null,point.clientY??null],
      defaultPrevented:event.defaultPrevented,homeMode:window.floorplan?.homeMode??null,
      viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scale:viewport?.scale??null,x:viewport?.offsetLeft??null,y:viewport?.offsetTop??null}});
    if(counts.events.length>64)counts.events.shift();
  };
  for(const type of ['pointerdown','pointerup','pointercancel','gotpointercapture','lostpointercapture','touchstart','touchend','touchcancel','click']) {
    window.addEventListener(type,event=>record(event,'capture'),{capture:true,passive:true});
  }
  // Capture precedes later preventDefault calls. Bubble evidence retains
  // cancellation after target handlers, and shows whether a click reached them.
  // Native event timestamps distinguish press duration from delayed dispatch.
  for (const type of ['pointerdown','pointerup','pointercancel','touchstart','touchend','touchcancel','click']) {
    window.addEventListener(type,event=>record(event,'bubble'),{passive:true});
  }
  for (const [event, key] of [['touchstart', 'trustedTouchStarts'], ['touchmove', 'trustedTouchMoves'], ['touchend', 'trustedTouchEnds']]) {
    window.addEventListener(event, value => { if (value.isTrusted) counts[key]++; }, {capture: true, passive: true});
  }
  window.addEventListener('pointerdown', value => {
    if (value.isTrusted && value.pointerType === 'touch') counts.trustedTouchPointerDowns++;
    if (value.isTrusted && value.pointerType === 'mouse') counts.trustedMousePointerDowns++;
  }, true);
  window.addEventListener('pointermove', value => {
    if (value.isTrusted && value.pointerType === 'touch') counts.trustedTouchPointerMoves++;
  }, true);
}

const TOUCH_DRAG_RELEASE_HOLD_MS = 100;

function viewerInputOptions(engine, profile, environment = process.env) {
  const tapMode = environment.BROWSER_STABILITY_TOUCH_TAP ??
    (engine === 'chromium' && profile.input === 'native-touch' ? 'sequential' : 'playwright');
  assert(['playwright', 'sequential', 'gesture50'].includes(tapMode),
    'BROWSER_STABILITY_TOUCH_TAP must be playwright, sequential or gesture50');
  assert(tapMode === 'playwright' || (engine === 'chromium' && profile.input === 'native-touch'),
    'Native tap transports require a Chromium touch profile');
  const trace = environment.BROWSER_STABILITY_TRACE_INPUT ?? '0';
  assert(['0', '1'].includes(trace), 'BROWSER_STABILITY_TRACE_INPUT must be 0 or 1');
  assert(trace === '0' || engine === 'chromium', 'Input tracing requires Chromium');
  return {tapMode, traceInput:trace === '1', dragReleaseHoldMs:profile.input === 'native-touch' ? TOUCH_DRAG_RELEASE_HOLD_MS : 0};
}

async function createInputDriver(page, engine, profile, {tapMode = viewerInputOptions(engine, profile, {}).tapMode} = {}) {
  viewerInputOptions(engine, profile, {BROWSER_STABILITY_TOUCH_TAP:tapMode});
  const touch = profile.input === 'native-touch';
  assert(!touch || engine === 'chromium', 'Native touch drags require the Chromium CDP transport');
  const cdp = touch ? await page.context().newCDPSession(page) : null;
  return {
    async tap(locator) {
      if (tapMode === 'playwright') return profile.emulated ? locator.tap() : locator.click();
      // trial:true still emits intercepted native input in Playwright. Check
      // visibility, stability and the hit target without an extra touch sequence.
      await locator.waitFor({state:'visible'});
      await locator.scrollIntoViewIfNeeded();
      assert(await locator.isEnabled(), 'The native tap target must be enabled');
      const hit = await locator.evaluate(target => {
        const bounds = target.getBoundingClientRect();
        const element = document.elementFromPoint(bounds.x+bounds.width/2, bounds.y+bounds.height/2);
        return element === target || target.contains(element);
      });
      assert(hit, 'The native tap target center must receive input');
      const bounds = await locator.boundingBox();
      assert(bounds && bounds.width > 0 && bounds.height > 0, 'The native tap target must have visible bounds');
      // Playwright boundingBox uses main-frame CSS coordinates, including for
      // iframe locators; the hit test above uses the target document's coordinates.
      const x = bounds.x+bounds.width/2, y = bounds.y+bounds.height/2;
      if (tapMode === 'gesture50') {
        await cdp.send('Input.synthesizeTapGesture', {x,y,duration:50,tapCount:1,gestureSourceType:'touch'});
      } else {
        // Share the drag session and await the start response before ending.
        // One native sequence only: no replacement click or repeated attempt.
        await cdp.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[{x,y,id:0}]});
        await cdp.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
      }
    },
    async drag(from, to, beforeRelease) {
      const marks = [Date.now()];
      if (touch) {
        marks.push(Date.now());
        await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: from.x, y: from.y, id: 0}]});
      } else {
        await page.mouse.move(from.x, from.y); marks.push(Date.now());
        await page.mouse.down();
      }
      marks.push(Date.now());
      try {
        if (touch) {
          for (let step = 1; step <= 12; step++) await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove', touchPoints: [{x: from.x + (to.x-from.x)*step/12, y: from.y + (to.y-from.y)*step/12, id: 0}],
          });
        } else await page.mouse.move(to.x, to.y, {steps: 12});
        marks.push(Date.now());
        if (beforeRelease) await beforeRelease();
        // End an intentional drag with a stationary finger, not a synthetic flick.
        // Chromium clears release velocity after 80 ms without movement. Keep
        // this real hold inside the measured release and overall drag budgets.
        if (touch) await new Promise(resolve => setTimeout(resolve, TOUCH_DRAG_RELEASE_HOLD_MS));
      } finally {
        if (touch) await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
        else await page.mouse.up();
      }
      marks.push(Date.now());
      return Object.fromEntries(['hoverMs', 'pressMs', 'moveMs', 'releaseMs'].map((key, i) => [key, marks[i+1]-marks[i]]));
    },
  };
}

function errorDetails(error) {
  return {name: error.name || 'Error', message: error.message || String(error), stack: error.stack || null};
}

async function bounded(operation, milliseconds, description) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} exceeded ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function createDiagnostics(name, prefix, sourceRoot, dependencies = {}) {
  const base = path.resolve(process.env[`${prefix}_DIAGNOSTICS_DIR`] ||
    process.env.HOME_STUDIO_DIAGNOSTICS_DIR || path.join(__dirname, '..', 'acceptance-artifacts'));
  fs.mkdirSync(base, {recursive: true});
  const directory = fs.mkdtempSync(path.join(base, `${name}-${process.platform}-${process.arch}-`));
  let sourceRevision = process.env.GITHUB_SHA || null;
  if (!sourceRevision) {
    try {
      sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: sourceRoot, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch { /* A source archive can still run acceptance without Git metadata. */ }
  }
  const summary = {
    schemaVersion: 1, suite: name, status: 'running', startedAt: new Date().toISOString(),
    os: {platform: process.platform, arch: process.arch, type: os.type(), release: os.release(),
      version: os.version(), cpuCount: os.cpus().length, totalMemoryBytes: os.totalmem()},
    nodeVersion: process.version, sourceRevision, browsers: [], error: null,
  };
  const write = (file, value) => {
    const target = path.join(directory, file);
    fs.writeFileSync(`${target}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(`${target}.tmp`, target);
  };
  const saveSummary = () => write('summary.json', summary);
  saveSummary();
  console.log(`Browser diagnostics: ${directory}`);

  async function run(engine, options, execute) {
    const record = {
      schemaVersion: 1, suite: name, engine, status: 'running', startedAt: new Date().toISOString(),
      os: summary.os, nodeVersion: process.version, browserVersion: null, playwrightVersion: null,
      reportOnly: options.reportOnly, fixture: options.fixture, sourceRevision, sourceHash: options.sourceHash || null,
      ...(options.sourceFiles ? {sourceFiles:options.sourceFiles, sourceHashScope:options.sourceHashScope} : {}),
      profile: options.profile || {name: 'desktop', emulated: false, realMobileOS: false}, identity: null,
      launch: {headless: options.launch.headless, channel: options.launch.channel || null,
        executablePath: options.launch.executablePath || null, args: options.launch.args || [],
        firefoxUserPrefs: options.launch.firefoxUserPrefs || {}},
      browserContext: options.context, gpu: null, samples: [], errors: [], crashes: [], consoleErrors: [],
      consoleErrorDetails: [], httpErrors: [], requestFailures: [],
      failedAssertions: [], diagnosticsErrors: [], cleanupErrors: [], screenshot: null, snapshot: null, error: null,
      inputDiagnostics: options.inputDiagnostics || null, inputTrace: null,
      cleanupTimeoutsMs: {context: 5000, browser: 15000}, cleanupDurationsMs: {},
    };
    const file = `${engine}.json`;
    const reference = {engine, file, status: record.status};
    summary.browsers.push(reference);
    const save = () => { write(file, record); reference.status = record.status; saveSummary(); };
    save();
    let browser, context, page, failure, expired = false, watchdog, launchPending = false, traceSession;
    const hardDeadline = setTimeout(() => {
      const error = new Error(`${engine}: browser cleanup exceeded the hard process deadline`);
      record.status = 'failed';
      record.hardDeadlineExceeded = true;
      record.error ||= errorDetails(error);
      record.finishedAt = new Date().toISOString();
      summary.status = 'failed';
      summary.error = errorDetails(error);
      summary.finishedAt = record.finishedAt;
      try { save(); } finally { process.exit(1); }
    // Trace draining has its own bound; scene and browser-close limits are
    // unchanged. Only requested diagnostic traces need this extra cleanup room.
    }, options.deadlineMs + 35000 + (options.inputDiagnostics?.traceInput ? 11000 : 0));
    hardDeadline.unref();
    async function capture(screenshot) {
      if (!page || page.isClosed()) return;
      try {
        record.snapshot = await bounded(() => Promise.all(page.frames().map(frame => frame.evaluate(() => {
          let scene = null, sceneError = null;
          try { scene = window.__browserScene?.() || window.__plannerScene?.() || null; }
          catch (error) { sceneError = String(error); }
          return {
            url: location.href === 'about:srcdoc' ? 'about:srcdoc' : location.pathname,
            userAgent: navigator.userAgent, devicePixelRatio: window.devicePixelRatio,
            viewport: {width:innerWidth,height:innerHeight,scrollX,scrollY,visual:window.visualViewport ?
              {width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale,x:visualViewport.offsetLeft,y:visualViewport.offsetTop} : null},
            input: window.__acceptanceInput || null,
            stats: window.__browserStability || window.__plannerStats || null, scene, sceneError,
          };
        }))), 2500, 'Failure snapshot');
        record.gpu ||= record.snapshot.find(frame => frame.stats?.gpu)?.stats.gpu || null;
      } catch (error) { record.diagnosticsErrors.push(errorDetails(error)); }
      if (screenshot) {
        try {
          const filename = `${engine}-failure.png`;
          await bounded(() => page.screenshot({path: path.join(directory, filename), timeout: 5000}), 6000, 'Failure screenshot');
          record.screenshot = filename;
        } catch (error) { record.diagnosticsErrors.push(errorDetails(error)); }
      }
    }
    const check = (condition, message) => {
      if (condition) return;
      record.failedAssertions.push(message);
      save();
      if (options.reportOnly) console.warn(`OBSERVED ${engine}: ${message}`);
      else assert(condition, message);
    };
    try {
      const deadline = new Promise((_, reject) => {
        watchdog = setTimeout(() => {
          expired = true;
          record.timedOut = true;
          save();
          reject(new Error(`${engine}: ${name} exceeded the ${options.deadlineMs / 1000}-second browser deadline`));
        }, options.deadlineMs);
      });
      await Promise.race([deadline, (async () => {
        const loaded = dependencies.playwright ? {playwright: dependencies.playwright, version: 'test-double'} : loadPlaywright();
        const {playwright} = loaded;
        record.playwrightVersion = loaded.version;
        launchPending = true;
        try { browser = await playwright[engine].launch({...options.launch, timeout: 30000}); }
        finally { launchPending = false; }
        if (expired) { await browser.close(); clearTimeout(hardDeadline); return; }
        record.browserVersion = browser.version();
        save();
        context = await browser.newContext(options.context);
        await context.addInitScript(inputInstrumentation);
        if (options.instrument) await context.addInitScript(options.instrument);
        page = await context.newPage();
        page.setDefaultTimeout(30000);
        record.identity = await browserIdentity(page, engine, options.launch, record.browserVersion);
        save();
        page.on('pageerror', error => { record.errors.push(String(error)); save(); });
        page.on('crash', () => { record.crashes.push('Page crashed'); save(); });
        page.on('console', message => {
          // Persist the renderer before first-draw shader work can stall the
          // content process and prevent an evaluate-based failure snapshot.
          const text = message.text();
          const gpuPrefix = '[home-studio-test-gpu]';
          if (message.type() === 'info' && text.startsWith(gpuPrefix)) {
            try { record.gpu = JSON.parse(text.slice(gpuPrefix.length)); save(); }
            catch { /* Other console output must not break diagnostics. */ }
          }
          if (message.type() === 'error') {
            const text = message.text().slice(0, 1600);
            record.consoleErrors.push(text);
            record.consoleErrorDetails.push({text, location: message.location()});
            save();
          }
        });
        page.on('response', response => {
          if (response.status() >= 400) {
            const request = response.request();
            record.httpErrors.push({url: response.url(), status: response.status(),
              method: request.method(), resourceType: request.resourceType()});
            save();
          }
        });
        page.on('requestfailed', request => {
          record.requestFailures.push({url: request.url(), method: request.method(),
            resourceType: request.resourceType(), error: request.failure()?.errorText || null});
          save();
        });
        if (options.inputDiagnostics?.traceInput) {
          assert.equal(engine, 'chromium', 'Input tracing requires Chromium');
          record.inputTrace = {file:`${engine}-input-trace.json`, status:'starting',
            categories:'input,latencyInfo,benchmark,disabled-by-default-devtools.timeline.inputs'};
          traceSession = await context.newCDPSession(page);
          await traceSession.send('Tracing.start', {categories:record.inputTrace.categories,
            options:'record-until-full', transferMode:'ReturnAsStream', streamFormat:'json'});
          record.inputTrace.status = 'recording'; save();
        }
        await execute({browser, context, page, record, check, save});
        // Chromium exposes UA client-hint brands only after a secure navigation.
        record.identity = await browserIdentity(page, engine, options.launch, record.browserVersion);
        save();
        if (process.platform === 'darwin' && options.launch.firefoxUserPrefs?.['webgl.disable-angle'] === false) {
          check(/ANGLE Metal Renderer/i.test(record.gpu?.unmaskedRenderer || record.gpu?.renderer || ''),
            'The requested Firefox Metal ANGLE backend must be confirmed by the actual renderer');
        }
        if (engine === 'chromium') {
          for (const [backend, expected] of [['metal', /ANGLE Metal Renderer/i], ['swiftshader', /SwiftShader/i]]) {
            if (options.launch.args?.includes(`--use-angle=${backend}`)) {
              check(expected.test(record.gpu?.unmaskedRenderer || record.gpu?.renderer || ''),
                `The requested Chromium ${backend} ANGLE backend must be confirmed by the actual renderer`);
            }
          }
        }
      })()]);
      record.status = options.reportOnly ? 'observation' : 'passed';
    } catch (error) {
      failure = error;
      record.status = 'failed';
      record.error = errorDetails(error);
      if (record.inputTrace?.status === 'starting') {
        record.inputTrace.status = 'failed'; record.inputTrace.error = errorDetails(error);
      }
      save();
      await capture(true);
    } finally {
      clearTimeout(watchdog);
      if (traceSession && record.inputTrace.status === 'recording') {
        try {
          await bounded(async () => {
            const completed = new Promise(resolve => traceSession.once('Tracing.tracingComplete', resolve));
            await traceSession.send('Tracing.end');
            const event = await completed;
            record.inputTrace.dataLoss = Boolean(event.dataLossOccurred);
            assert(event.stream, 'Input trace must return a stream');
            const output = fs.openSync(path.join(directory, record.inputTrace.file), 'w');
            try {
              while (true) {
                const chunk = await traceSession.send('IO.read', {handle:event.stream, size:1024*1024});
                fs.writeSync(output, chunk.base64Encoded ? Buffer.from(chunk.data,'base64') : chunk.data);
                if (chunk.eof) break;
              }
            } finally { fs.closeSync(output); }
            await traceSession.send('IO.close', {handle:event.stream});
            assert(!record.inputTrace.dataLoss, 'Input trace buffer must not lose events');
          }, 10000, 'Input trace capture');
          record.inputTrace.status = 'saved';
        } catch (error) {
          record.inputTrace.status = 'failed'; record.inputTrace.error = errorDetails(error);
          record.diagnosticsErrors.push(errorDetails(error)); failure ||= error;
        }
      }
      if (traceSession) {
        try { await bounded(() => traceSession.detach(), 1000, 'Input trace session cleanup'); }
        catch (error) { record.diagnosticsErrors.push(errorDetails(error)); failure ||= error; }
      }
      // Write before teardown: evidence must survive a hung or failing browser close.
      record.finishedAt = new Date().toISOString();
      save();
      let browserClosed = !browser;
      for (const [label, resource] of [['context', context], ['browser', browser]]) {
        if (!resource) continue;
        const cleanupStarted = Date.now();
        try {
          await bounded(() => resource.close(), record.cleanupTimeoutsMs[label], `${engine} ${label} cleanup`);
          if (label === 'browser') browserClosed = true;
        }
        catch (error) { record.cleanupErrors.push(errorDetails(error)); failure ||= error; }
        finally { record.cleanupDurationsMs[label] = Date.now()-cleanupStarted; save(); }
      }
      if (failure) { record.status = 'failed'; record.error ||= errorDetails(failure); }
      save();
      // An unresolved Playwright transport may keep Node alive after close times out.
      // Leave the unreferenced hard deadline armed in that case.
      if (browserClosed && !launchPending) clearTimeout(hardDeadline);
      console.log(`${engine}: ${record.status}; evidence ${path.join(directory, file)}`);
    }
    if (failure) throw failure;
    return record;
  }

  return {
    directory, summary, run,
    configure(engines, reportOnly) {
      summary.selectedEngines = engines;
      summary.reportOnly = reportOnly;
      saveSummary();
      assert(!(reportOnly && process.env.CI && process.env.CI !== 'false'),
        'REPORT_ONLY is a local baseline tool and cannot satisfy CI acceptance');
    },
    async runAll(engines, execute) {
      const failures = [];
      for (const engine of engines) {
        try { await execute(engine); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, `${failures.length} browser acceptance run(s) failed`);
    },
    finish(error) {
      summary.finishedAt = new Date().toISOString();
      summary.status = error ? 'failed' : summary.reportOnly ? 'observation' : 'passed';
      summary.error = error ? errorDetails(error) : null;
      saveSummary();
    },
  };
}

// Injected into the fictional viewer after its renderer exists. CPU state can
// change before a queued frame; only a successful draw advances this receipt.
function captureViewerFrames(renderer) {
  const draw = renderer.render.bind(renderer);
  renderer.render = (scene, camera) => {
    const result = draw(scene, camera);
    window.__browserCamera = {projection: camera.projectionMatrix.toArray(), world: camera.matrixWorld.toArray()};
    window.__browserRenderedLights = window.__browserScene().activePointLights;
    return result;
  };
}

module.exports = {createDiagnostics, positiveInteger, selectedEngines, browserLaunchOptions, browserProfile, loadPlaywright, browserIdentity, createInputDriver, viewerInputOptions, captureViewerFrames};
