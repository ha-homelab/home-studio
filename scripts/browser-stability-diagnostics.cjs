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

// Host-side timestamps only: changing phases adds no browser work or awaits.
// Live entries may finish after the watchdog wins Promise.race, so retain an
// independent copy of the phase that was active at the actual deadline.
function createPhaseTimings(record, now = () => performance.now(), origin = now()) {
  record.phases = [];
  record.activePhase = null;
  const elapsed = () => Math.round((now() - origin) * 1000) / 1000;
  const completeAt = at => {
    if (!record.activePhase) return;
    record.activePhase.completedMs = at;
    record.activePhase.durationMs = Math.round((at - record.activePhase.startedMs) * 1000) / 1000;
    record.activePhase = null;
  };
  return {
    start(name, details = {}) {
      const at = elapsed();
      completeAt(at);
      const entry = {...details, name, startedMs: at, completedMs: null, durationMs: null};
      record.phases.push(entry);
      record.activePhase = entry;
    },
    complete() { completeAt(elapsed()); },
    freezeTimeout() {
      if (!record.timeoutPhase) record.timeoutPhase = JSON.parse(JSON.stringify({
        elapsedMs: elapsed(), activePhase: record.activePhase,
      }));
    },
  };
}

// This local allowance never renews or extends the enclosing scenario clock.
const VIEWER_LOAD_BUDGET_MS = 60000;
function createViewerLoadDeadline(sample, outerDeadlineAt, checkOuter) {
  const started = performance.now(), deadlineAt = Math.min(started + VIEWER_LOAD_BUDGET_MS, outerDeadlineAt);
  Object.assign(sample, {loadBudgetMs: VIEWER_LOAD_BUDGET_MS, loadMs: null, loadCompleted: false});
  let timer, closed = false, failed, completedAt;
  const check = () => {
    checkOuter();
    if (failed) throw failed;
    if (performance.now() >= deadlineAt) {
      sample.loadTimedOut = true;
      throw (failed = new Error('Viewer cold load exceeded its 60-second deadline'));
    }
  };
  const timeout = new Promise((_, reject) => {
    const expire = () => {
      try {
        check();
        timer = setTimeout(expire, Math.max(1, Math.ceil(deadlineAt - performance.now())));
      } catch (error) { failed = error; reject(error); }
    };
    timer = setTimeout(expire, Math.max(1, Math.ceil(deadlineAt - performance.now())));
  });
  // The timer may expire between operations; retain its rejection for run().
  timeout.catch(() => {});
  return {
    remainingMs() { check(); return Math.max(1, Math.floor(deadlineAt - performance.now())); },
    async run(operation) {
      check();
      const value = await Promise.race([timeout, Promise.resolve().then(() => { check(); return operation(); })]);
      check();
      return value;
    },
    complete() { const now = performance.now(); check(); completedAt = now; sample.loadCompleted = true; },
    close() {
      if (closed) return;
      closed = true; clearTimeout(timer);
      if (completedAt === undefined && performance.now() >= deadlineAt) sample.loadTimedOut = true;
      sample.loadMs = Math.floor(((completedAt ?? performance.now()) - started) * 1000) / 1000;
    },
  };
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
    assert(Number.isSafeInteger(options.deadlineMs) && options.deadlineMs > 0, 'Scenario deadline must be a positive integer');
    const bootstrapMs = 30000, caseStarted = performance.now();
    record.deadlineScope = {version: 2, bootstrapMs, scenarioMs: options.deadlineMs,
      scenario: 'execute-through-final-identity-and-checks',
      hardProcessMs: bootstrapMs + options.deadlineMs + 35000 + (options.inputDiagnostics?.traceInput ? 11000 : 0)};
    if (name === 'viewer') record.loadBudgetMs = VIEWER_LOAD_BUDGET_MS;
    record.bootstrapDurationMs = null;
    record.scenarioStartedMs = null;
    record.scenarioDurationMs = null;
    record.scenarioCompletedMs = null;
    const phases = createPhaseTimings(record, undefined, caseStarted);
    const file = `${engine}.json`;
    const reference = {engine, file, status: record.status};
    summary.browsers.push(reference);
    const save = () => { write(file, record); reference.status = record.status; saveSummary(); };
    save();
    let browser, context, page, failure, expired = false, watchdog, traceSession;
    let scope = 'bootstrap', scopeStarted = caseStarted, deadlineAt = caseStarted + bootstrapMs;
    let deadlineError, rejectDeadline, bootstrapPending = 0, cleanupFinished = false, browserClosed = true, lateCleanupFailed = false;
    const duration = start => Math.round((performance.now() - start) * 1000) / 1000;
    const finishTiming = () => {
      if (scope === 'bootstrap') record.bootstrapDurationMs ??= duration(caseStarted);
      else record.scenarioDurationMs ??= duration(scopeStarted);
    };
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
    }, Math.max(0, caseStarted + record.deadlineScope.hardProcessMs - performance.now()));
    hardDeadline.unref();
    const clearHardIfClosed = () => {
      if (cleanupFinished && browserClosed && !bootstrapPending && !lateCleanupFailed) clearTimeout(hardDeadline);
    };
    const expire = () => {
      if (expired) return deadlineError;
      expired = true;
      finishTiming();
      phases.freezeTimeout();
      record.timedOut = true;
      record.timeoutScope = scope;
      deadlineError = new Error(scope === 'bootstrap'
        ? `${engine}: browser bootstrap exceeded the 30-second bootstrap deadline`
        : `${engine}: ${name} exceeded the ${options.deadlineMs / 1000}-second browser deadline`);
      save();
      rejectDeadline(deadlineError);
      return deadlineError;
    };
    const checkDeadline = () => {
      // Timers cannot run while JS is busy. A late successful callback must fail
      // even if its microtask runs before the overdue timer callback.
      if (expired || performance.now() >= deadlineAt) throw expire();
    };
    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(expire, Math.max(0, deadlineAt - performance.now()));
    };
    const bootstrap = async (operation, lateResource) => {
      checkDeadline();
      bootstrapPending++;
      try {
        const result = await operation();
        try { checkDeadline(); }
        catch (error) {
          // The main failure path may already have closed its known resources.
          // Do not adopt a late context/page/browser or proceed into the app.
          if (lateResource && result) {
            const limit = lateResource === 'browser' ? 15000 : lateResource === 'trace' ? 1000 : 5000;
            try { await bounded(() => lateResource === 'trace' ? result.detach() : result.close(), limit, `${engine} late ${lateResource} cleanup`); }
            catch (cleanupError) { lateCleanupFailed = true; record.cleanupErrors.push(errorDetails(cleanupError)); save(); }
          }
          throw error;
        }
        return result;
      } finally { bootstrapPending--; clearHardIfClosed(); }
    };
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
      const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
      armWatchdog();
      await Promise.race([deadline, (async () => {
        phases.start('browser-module');
        const loaded = await bootstrap(() => dependencies.playwright ? {playwright: dependencies.playwright, version: 'test-double'} : loadPlaywright());
        const {playwright} = loaded;
        record.playwrightVersion = loaded.version;
        phases.start('browser-launch');
        browser = await bootstrap(() => playwright[engine].launch({...options.launch, timeout: 30000}), 'browser');
        browserClosed = false;
        record.browserVersion = browser.version();
        save();
        phases.start('browser-context');
        context = await bootstrap(() => browser.newContext(options.context), 'context');
        phases.start('browser-initialization');
        await bootstrap(() => context.addInitScript(inputInstrumentation));
        if (options.instrument) await bootstrap(() => context.addInitScript(options.instrument));
        page = await bootstrap(() => context.newPage(), 'page');
        page.setDefaultTimeout(30000);
        phases.start('browser-identity');
        record.identity = await bootstrap(() => browserIdentity(page, engine, options.launch, record.browserVersion));
        save();
        phases.start('browser-listeners');
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
        checkDeadline();
        if (options.inputDiagnostics?.traceInput) {
          assert.equal(engine, 'chromium', 'Input tracing requires Chromium');
          record.inputTrace = {file:`${engine}-input-trace.json`, status:'starting',
            categories:'input,latencyInfo,benchmark,disabled-by-default-devtools.timeline.inputs'};
          phases.start('browser-tracing');
          traceSession = await bootstrap(() => context.newCDPSession(page), 'trace');
          await bootstrap(() => traceSession.send('Tracing.start', {categories:record.inputTrace.categories,
            options:'record-until-full', transferMode:'ReturnAsStream', streamFormat:'json'}));
          record.inputTrace.status = 'recording'; save();
        }
        // Compare and reuse one timestamp so the transition cannot grant a
        // scenario budget to bootstrap work that has already expired.
        const scenarioStart = performance.now();
        if (expired || scenarioStart >= deadlineAt) throw expire();
        record.bootstrapDurationMs = Math.round((scenarioStart - caseStarted) * 1000) / 1000;
        // Exactly one reset, immediately before the unchanged scenario callback.
        scope = 'scenario';
        scopeStarted = scenarioStart;
        record.scenarioStartedMs = record.bootstrapDurationMs;
        deadlineAt = scopeStarted + options.deadlineMs;
        armWatchdog();
        phases.start('test');
        checkDeadline();
        await execute({browser, context, page, record, check, save, phases,
          createViewerLoad(sample) {
            assert.equal(name, 'viewer', 'Only viewer creation has a cold-load allowance');
            checkDeadline();
            return createViewerLoadDeadline(sample, deadlineAt, checkDeadline);
          }});
        checkDeadline();
        // Chromium exposes UA client-hint brands only after a secure navigation.
        phases.start('browser-final-identity');
        record.identity = await browserIdentity(page, engine, options.launch, record.browserVersion);
        checkDeadline();
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
        checkDeadline();
        phases.complete();
      })()]);
      const completed = performance.now();
      if (expired || completed >= deadlineAt) throw expire();
      record.scenarioDurationMs = Math.round((completed - scopeStarted) * 1000) / 1000;
      record.scenarioCompletedMs = Math.round((completed - caseStarted) * 1000) / 1000;
      record.status = options.reportOnly ? 'observation' : 'passed';
    } catch (error) {
      finishTiming();
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
      browserClosed = !browser;
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
      cleanupFinished = true;
      clearHardIfClosed();
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
  const passes = window.__browserRenderPasses = {scene: 0, copy: 0, last: null, sceneViewport: null, copyViewport: null};
  const viewport = {copy(value) {this.x=value.x;this.y=value.y;this.z=value.z;this.w=value.w;return this;}};
  renderer.render = (scene, camera) => {
    const result = draw(scene, camera);
    const copy = scene?.name === 'interaction-copy';
    const kind = copy ? 'copy' : 'scene';
    passes[kind]++; passes.last = kind;
    renderer.getViewport(viewport);
    const ratio = renderer.getPixelRatio();
    passes[kind + 'Viewport'] = [viewport.x,viewport.y,viewport.z,viewport.w].map(value=>Math.floor(value*ratio));
    if (copy) {
      passes.motionSceneViewport = passes.sceneViewport.slice();
      passes.motionBuffer = [renderer.domElement.width,renderer.domElement.height];
      passes.motionSceneDrawCalls = passes.sceneDrawCalls;
      passes.motionDrawCalls = renderer.info.render.calls;
      passes.motionTriangles = renderer.info.render.triangles;
    }
    if (!copy) {
      passes.sceneDrawCalls = renderer.info.render.calls;
      window.__browserCamera = {projection: camera.projectionMatrix.toArray(), world: camera.matrixWorld.toArray()};
      window.__browserRenderedLights = window.__browserScene().activePointLights;
    }
    return result;
  };
}

// Serialized into the viewer frame. Observe a completed application draw with
// timers: an idle viewer need not deliver additional animation frames afterward.
// The outer scenario deadline still owns the whole test; this retains the
// ordinary 30-second operation limit without renewing it on each poll.
async function waitForViewerLightState({beforeRenderCount, beforeSceneDraws, expectedLights, expectedSlots}) {
  const started = performance.now(), deadline = started + 30000;
  let latest = null;
  while (performance.now() < deadline) {
    const scene = window.__browserScene();
    latest = {...window.__browserStability, scene, homeMode:window.floorplan.homeMode,
      renderCount:window.floorplan.renderCount, renderedLights:window.__browserRenderedLights,
      markerCount:document.querySelectorAll('.home-marker[data-state="on"]').length};
    const passes = scene.renderPasses, now = performance.now();
    if (now >= deadline) break;
    if (latest.homeMode && latest.markerCount === expectedLights &&
        latest.renderedLights === expectedLights && scene.activePointLights === expectedLights &&
        scene.pointLights === expectedSlots && latest.renderCount > beforeRenderCount &&
        passes.scene > beforeSceneDraws && passes.last === 'scene' && passes.sceneDrawCalls > 0 &&
        scene.drawingBuffer.every(value => value > 0) &&
        JSON.stringify(passes.sceneViewport) === JSON.stringify([0, 0, ...scene.drawingBuffer])) {
      return {...latest, waitMs:now-started};
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(0, deadline-performance.now()))));
  }
  throw Error('Light state did not produce a fresh complete scene draw: ' + JSON.stringify({
    elapsedMs:performance.now()-started, expectedLights, expectedSlots, beforeRenderCount, beforeSceneDraws,
    renderCount:latest?.renderCount, renderedLights:latest?.renderedLights, markerCount:latest?.markerCount,
    activePointLights:latest?.scene.activePointLights, pointLights:latest?.scene.pointLights,
    renderPasses:latest?.scene.renderPasses, drawingBuffer:latest?.scene.drawingBuffer,
    visibility:document.visibilityState, hidden:document.hidden, focused:document.hasFocus(),
  }));
}

function assertViewerInteraction(before, after) {
  const scene = after.scene, passes = scene.renderPasses;
  assert.equal(passes.last, 'scene', 'Pointer release must finish with a full scene draw');
  assert.deepEqual(passes.sceneViewport, [0,0,...scene.drawingBuffer], 'Pointer release must restore the original drawing-buffer resolution');
  const renderer = after.gpu.unmaskedRenderer || after.gpu.renderer;
  const diffuse = /^Apple Software Renderer$/i.test(renderer) || (renderer === 'Apple M1, or similar' && scene.rasterProbe?.status === 'measured' && scene.rasterProbe.bestMs >= 15);
  const reduced = diffuse || /swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render|lavapipe/i.test(renderer);
  if (reduced) {
    assert(passes.copy > before.scene.renderPasses.copy, 'The real software-viewer gesture must execute a copy pass');
    assert.equal(passes.motionDrawCalls, passes.motionSceneDrawCalls+1, 'The copy draw must remain in actual renderer draw-call counts');
    const motion = passes.motionSceneViewport;
    assert(Array.isArray(motion) && motion.length===4 && motion[0]===0 && motion[1]===0 && motion[2]>0 && motion[3]>0 && motion[2]*motion[3]<=(diffuse?31250:62500), 'Motion scene pixels must respect the bounded copy budget');
    assert.deepEqual(passes.copyViewport, [0,0,...passes.motionBuffer], 'The copy pass must cover its unchanged full drawing buffer');
    assert(motion[2]<=passes.motionBuffer[0] && motion[3]<=passes.motionBuffer[1], 'The scene copy cannot read outside its framebuffer');
  } else assert.equal(passes.copy, 0, 'Other graphics profiles must retain direct rendering');
}

// Exercise the existing UI handlers after a real context restoration. These
// are lifecycle actions, not additional pointer gestures or rendering shortcuts.
function changeRestoredViewerMode(mode) {
  if (!['editor-cutaway', 'editor-full', 'home'].includes(mode)) throw Error('Unknown restored viewer mode');
  if (mode === 'home') document.querySelector('#openHome').click();
  else {
    if (window.floorplan.homeMode) document.querySelector('#editLayout').click();
    const cutaway = document.querySelector('#cutaway');
    cutaway.checked = mode === 'editor-cutaway';
    cutaway.dispatchEvent(new Event('change'));
  }
}

function captureRestoredViewerMode() {
  const canvas = document.querySelector('#homeStage canvas, #view3d canvas');
  const gl = canvas.getContext('webgl2'), glErrors = [];
  const contextLost = gl.isContextLost();
  if (!contextLost) for (let n = 0; n < 32; n++) {
    const code = gl.getError();
    if (code === gl.NO_ERROR) break;
    glErrors.push(code);
    if (n === 31) throw Error('Restored viewer GL error queue did not drain');
  }
  return {...window.__browserStability, homeMode:window.floorplan.homeMode,
    cutaway:document.querySelector('#cutaway').checked, contextLost, glErrors,
    renderedLights:window.__browserRenderedLights, renderCount:window.floorplan.renderCount,
    scene:window.__browserScene()};
}

function assertRestoredViewerMode(beforeCount, value, mode, expectedLights) {
  assert(['editor-cutaway', 'editor-full', 'home'].includes(mode));
  assert.equal(value.contexts, 1, 'Mode changes reuse the restored WebGL context');
  assert.equal(value.contextLosses, 1, 'Mode changes cause no additional context loss');
  assert.equal(value.contextLost, false, 'The restored context remains live');
  assert.deepEqual(value.glErrors, [], 'Post-restoration mode changes must not produce GL errors');
  assert.deepEqual(value.errors, [], 'Post-restoration mode changes must not produce browser errors');
  assert.deepEqual(value.shaderErrors, [], 'Post-restoration mode programs must link');
  assert(value.renderCount > beforeCount, 'Every restored mode must complete a new frame');
  assert.equal(value.homeMode, mode === 'home', 'The requested restored mode is active');
  if (mode !== 'home') assert.equal(value.cutaway, mode === 'editor-cutaway', 'The requested wall height is active');
  assert.equal(value.scene.pointLights, expectedLights, 'Restored modes retain every light slot');
  if (mode === 'home') {
    assert.equal(value.scene.activePointLights, expectedLights, 'Restored Home retains every on-state light');
    assert.equal(value.renderedLights, expectedLights, 'Restored Home draws the current light state');
  }
  const passes = value.scene.renderPasses;
  assert.equal(passes.last, 'scene', 'Restored modes finish with a full scene draw');
  assert.deepEqual(passes.sceneViewport, [0, 0, ...value.scene.drawingBuffer], 'Restored modes retain the full drawing buffer');
}

function assertViewerScenarioComplete(record) {
  assert(!record.timedOut, 'A timed-out viewer cannot receive completion credit');
  const samples = record.samples;
  assert.deepEqual(samples.map(sample => sample.cycle), [0, 1], 'Exactly two fresh viewer cycles must complete in order');
  for (const sample of samples) {
    assert.equal(sample.completed, true, 'Each viewer cycle must finish detachment and dashboard responsiveness checks');
    assert.equal(sample.loadCompleted, true, 'Each viewer must complete cold readiness');
    assert.equal(sample.loadBudgetMs, VIEWER_LOAD_BUDGET_MS, 'Cold readiness retains its fixed 60-second limit');
    for (const [value, limit, label] of [[sample.loadMs, VIEWER_LOAD_BUDGET_MS, 'load'],
      [sample.dragMs, 15000, 'Home drag'], [sample.editorDragMs, 15000, 'Editor drag'],
      [sample.burst?.settled?.waitMs, 10000, 'Editor settling']]) {
      assert(Number.isFinite(value) && value >= 0 && value < limit, `${label} must finish within its individual limit`);
    }
    assert(Number.isFinite(sample.detachMs) && sample.detachMs >= 0, 'Each viewer must retain its completed detachment receipt');
  }
  const recovery = samples[1].recovery;
  assert(recovery && recovery.contextLosses === 1 && recovery.after > recovery.before, 'The second viewer must complete context recovery');
  const modes = ['editor-cutaway', 'editor-full', 'home'];
  const views = samples[1].postRestoreViews;
  assert(Array.isArray(views), 'Restored viewer transitions must be recorded');
  assert.deepEqual(views.map(view => view.mode), modes, 'All three restored viewer modes must complete in order');
  for (const view of views) {
    assert(view.completed === true && view.snapshot && Number.isFinite(view.durationMs) && view.durationMs >= 0,
      'Each restored mode must finish its existing frame and graphics checks');
  }
  // This certifies the application sequence only. The shared runner still
  // requires final browser identity, its absolute deadline and clean shutdown.
  record.viewerCompletion = {version: 1, cycles: 2, postRestoreModes: modes};
}

module.exports = {VIEWER_LOAD_BUDGET_MS, createViewerLoadDeadline, changeRestoredViewerMode, captureRestoredViewerMode, assertRestoredViewerMode, assertViewerScenarioComplete, createDiagnostics, createPhaseTimings, positiveInteger, selectedEngines, browserLaunchOptions, browserProfile, loadPlaywright, browserIdentity, createInputDriver, viewerInputOptions, captureViewerFrames, waitForViewerLightState, assertViewerInteraction};
