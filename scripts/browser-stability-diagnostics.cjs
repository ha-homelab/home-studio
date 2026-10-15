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
  assert(engines.length > 0 && engines.every(engine => ['chromium', 'firefox'].includes(engine)),
    'Select Chromium and/or Firefox; empty or unsupported engine names are not accepted');
  assert(new Set(engines).size === engines.length, 'Each browser engine must be selected only once');
  return engines;
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
      launch: {headless: options.launch.headless, args: options.launch.args || []},
      browserContext: options.context, gpu: null, samples: [], errors: [], crashes: [], consoleErrors: [],
      failedAssertions: [], diagnosticsErrors: [], cleanupErrors: [], screenshot: null, snapshot: null, error: null,
    };
    const file = `${engine}.json`;
    const reference = {engine, file, status: record.status};
    summary.browsers.push(reference);
    const save = () => { write(file, record); reference.status = record.status; saveSummary(); };
    save();
    let browser, context, page, failure, expired = false, watchdog, launchPending = false;
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
    }, options.deadlineMs + 25000);
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
        const playwright = dependencies.playwright || require('playwright');
        record.playwrightVersion = dependencies.playwright ? 'test-double' : require('playwright/package.json').version;
        launchPending = true;
        try { browser = await playwright[engine].launch({...options.launch, timeout: 30000}); }
        finally { launchPending = false; }
        if (expired) { await browser.close(); clearTimeout(hardDeadline); return; }
        record.browserVersion = browser.version();
        save();
        context = await browser.newContext(options.context);
        if (options.instrument) await context.addInitScript(options.instrument);
        page = await context.newPage();
        page.setDefaultTimeout(30000);
        page.on('pageerror', error => { record.errors.push(String(error)); save(); });
        page.on('crash', () => { record.crashes.push('Page crashed'); save(); });
        page.on('console', message => {
          if (message.type() === 'error') { record.consoleErrors.push(message.text().slice(0, 1600)); save(); }
        });
        await execute({browser, context, page, record, check, save});
      })()]);
      record.status = options.reportOnly ? 'observation' : 'passed';
    } catch (error) {
      failure = error;
      record.status = 'failed';
      record.error = errorDetails(error);
      save();
      await capture(true);
    } finally {
      clearTimeout(watchdog);
      // Write before teardown: evidence must survive a hung or failing browser close.
      record.finishedAt = new Date().toISOString();
      save();
      let browserClosed = !browser;
      for (const [label, resource] of [['context', context], ['browser', browser]]) {
        if (!resource) continue;
        try {
          await bounded(() => resource.close(), 5000, `${engine} ${label} cleanup`);
          if (label === 'browser') browserClosed = true;
        }
        catch (error) { record.cleanupErrors.push(errorDetails(error)); failure ||= error; }
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

module.exports = {createDiagnostics, positiveInteger, selectedEngines};
