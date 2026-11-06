'use strict';
// Diagnostic only: run the canonical assertions in three fresh owned processes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { performance } = require('node:perf_hooks');
const ROOT = path.resolve(__dirname, '..');
const TEST = path.join(ROOT, 'scripts/test-i18n-browser.cjs');
const EDITOR = path.join(ROOT, 'planner/editor.js');
const TEST_SHA = 'da79a4f4a5972dcdf8f96f61db03bc0a3ed9c9be4d58ff5755944f18f02a0c17';
const PREFIX = 'HOME_STUDIO_LIFECYCLE ';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const ORIGINAL = `window.addEventListener('pagehide', event => {
  canvasSuspended = true; siteEditor?.setSuspended(true); siteEditor?.cancel(); if (drag) finishPointer(null, true); releasePreviewPointer(); cancelCanvasRender();
  if (!event.persisted) { siteEditor?.dispose(); canvasObserver.disconnect(); previewEvents.abort(); releasePreviewPointer(); floorNavigator.destroy(); disposePreviewRenderer(); renderer?.forceContextLoss(); }
});`;
const OPERATIONS = [
  ['suspend', 'canvasSuspended = true;'],
  ['site-suspend', 'siteEditor?.setSuspended(true);'],
  ['site-cancel', 'siteEditor?.cancel();'],
  ['finish-pointer', 'if (drag) finishPointer(null, true);'],
  ['release-pointer', 'releasePreviewPointer();'],
  ['cancel-frame', 'cancelCanvasRender();'],
  ['site-dispose', 'siteEditor?.dispose();'],
  ['observer-disconnect', 'canvasObserver.disconnect();'],
  ['events-abort', 'previewEvents.abort();'],
  ['release-pointer-final', 'releasePreviewPointer();'],
  ['navigator-destroy', 'floorNavigator.destroy();'],
  ['renderer-dispose', 'disposePreviewRenderer();'],
  ['force-context-loss', 'renderer?.forceContextLoss();'],
];
const STAGES = new Set(['enter', 'exit', 'force-context-loss.omitted',
  ...OPERATIONS.flatMap(([name]) => [name + '.before', name + '.after'])]);

function instrumentEditor(source, mode) {
  if (!['baseline', 'omit-force-context-loss'].includes(mode)) throw Error('Unknown diagnostic mode');
  if (source.split(ORIGINAL).length !== 2) throw Error('Expected exactly one unchanged pagehide anchor');
  const mark = name => `mark(${JSON.stringify(name)});`;
  const operation = ([name, code]) => [mark(name + '.before'),
    name === 'force-context-loss' && mode === 'omit-force-context-loss' ? mark(name + '.omitted') : code,
    mark(name + '.after')].join(' ');
  const replacement = `window.addEventListener('pagehide', event => {
  const mark = stage => { try { console.info(${JSON.stringify(PREFIX)} + JSON.stringify({stage, time: performance.now(), persisted: event.persisted, view, hasRenderer: !!renderer})); } catch {} };
  ${mark('enter')}
  ${OPERATIONS.slice(0, 6).map(operation).join('\n  ')}
  if (!event.persisted) {
    ${OPERATIONS.slice(6).map(operation).join('\n    ')}
  }
  ${mark('exit')}
});`;
  return source.replace(ORIGINAL, replacement);
}

function lifecycleMessage(text) {
  if (!text.startsWith(PREFIX) || text.length > 512) return null;
  try {
    const value = JSON.parse(text.slice(PREFIX.length));
    if (!STAGES.has(value.stage) || !Number.isFinite(value.time) ||
        !['plan', 'preview', 'split'].includes(value.view) ||
        typeof value.persisted !== 'boolean' || typeof value.hasRenderer !== 'boolean') return null;
    return { stage: value.stage, time: value.time, view: value.view,
      persisted: value.persisted, hasRenderer: value.hasRenderer };
  } catch { return null; }
}

function installPreload() {
  const send = value => { if (process.connected) process.send(value); };
  const originalRead = fs.readFileSync;
  const source = originalRead(EDITOR, 'utf8');
  const transformed = instrumentEditor(source, process.env.HOME_STUDIO_LIFECYCLE_MODE);
  if (hash(originalRead(TEST)) !== TEST_SHA) throw Error('Canonical i18n test identity changed');
  send({ kind: 'source', original: hash(source), served: hash(transformed), canonicalTest: TEST_SHA });
  fs.readFileSync = function(file, options) {
    if (typeof file !== 'string' || path.resolve(file) !== EDITOR) return originalRead.apply(this, arguments);
    send({ kind: 'editor-served' });
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return encoding ? Buffer.from(transformed).toString(encoding) : Buffer.from(transformed);
  };
  // Chromium creates a separate process group. Record it before any browser
  // startup so the supervisor can also stop it when browser.close() stalls.
  const originalSpawn = cp.spawn;
  cp.spawn = function() {
    const child = originalSpawn.apply(this, arguments);
    if (child.pid) {
      const detached = !!arguments[2]?.detached;
      send({ kind: 'owned-process', pid: child.pid, detached });
      child.once('exit', () => send({ kind: 'owned-process-exit', pid: child.pid }));
    }
    return child;
  };
  const { chromium } = require('playwright');
  const launch = chromium.launch;
  let serial = 0;
  chromium.launch = async function() {
    const browser = await launch.apply(this, arguments);
    send({ kind: 'browser', version: browser.version() });
    browser.on('disconnected', () => send({ kind: 'browser-disconnected' }));
    const newContext = browser.newContext;
    browser.newContext = async function() {
      const context = await newContext.apply(this, arguments);
      context.on('page', page => {
        const id = ++serial;
        for (const event of ['domcontentloaded', 'load', 'crash', 'close'])
          page.on(event, () => send({ kind: 'page-event', page: id, event }));
        page.on('console', message => {
          const value = lifecycleMessage(message.text());
          if (value) send({ kind: 'lifecycle', page: id, ...value });
        });
        for (const method of ['goto', 'reload']) {
          const original = page[method];
          page[method] = async function() {
            send({ kind: 'navigation-start', page: id, method });
            try {
              const result = await original.apply(this, arguments);
              send({ kind: 'navigation-end', page: id, method, success: true });
              return result;
            } catch (error) {
              send({ kind: 'navigation-end', page: id, method, success: false });
              throw error;
            }
          };
        }
      });
      return context;
    };
    return browser;
  };
}

function runChild(args, { env, budgetMs = 100000, graceMs = 1500, settleMs = 500,
  signalProcess = (pid, signal) => process.kill(pid, signal) } = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now(), events = [], owned = new Map();
    const result = { startedAt: new Date().toISOString(), events, timedOut: false,
      stdout: '', stderr: '', outputTruncated: false, droppedEvents: 0, cleanupSignals: [] };
    const child = cp.spawn(process.execPath, args, { cwd: ROOT, env, detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    if (!child.pid) { child.once('error', reject); return; }
    owned.set(child.pid, true);
    let stopping = false, finished = false, timer, escalation, finishTimer;
    function append(channel, data) {
      const text = data.toString().replaceAll(ROOT, '[repository]').replaceAll(require('node:os').homedir(), '[home]');
      result[channel] += text;
      if (channel === 'stdout' && result.stdout.includes('Browser i18n checks passed:')) result.assertionsPassed = true;
      if (result[channel].length > 65536) { result[channel] = result[channel].slice(-65536); result.outputTruncated = true; }
    }
    child.stdout.on('data', data => append('stdout', data));
    child.stderr.on('data', data => append('stderr', data));
    function alive(pid, detached) {
      try { signalProcess(detached ? -pid : pid, 0); return true; }
      catch (error) {
        if (error.code === 'ESRCH') return false;
        result.cleanupError = error.code || 'UNKNOWN'; return true;
      }
    }
    function signalAll(signal) {
      for (const [pid, detached] of owned) {
        try {
          signalProcess(detached ? -pid : pid, signal);
          result.cleanupSignals.push({ pid, group: detached, signal });
        } catch (error) { if (error.code !== 'ESRCH') result.cleanupError = error.code; }
      }
    }
    child.on('message', message => {
      if (!message || typeof message !== 'object') return;
      if (message.kind === 'owned-process' && Number.isSafeInteger(message.pid) && message.pid > 1 && message.pid !== process.pid) {
        owned.set(message.pid, message.detached === true);
        if (stopping) signalAll('SIGTERM');
      }
      if (message.kind === 'owned-process-exit' &&
          (!owned.get(message.pid) || !alive(message.pid, true))) owned.delete(message.pid);
      if (events.length < 512 && JSON.stringify(message).length <= 2048)
        events.push({ elapsedMs: Math.round(performance.now() - started), ...message });
      else result.droppedEvents++;
    });
    function finish() {
      if (finished) return; finished = true;
      clearTimeout(timer); clearTimeout(escalation); clearTimeout(finishTimer);
      process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate);
      result.remainingOwnedProcesses = [...owned].filter(([pid, detached]) => alive(pid, detached)).map(([pid]) => pid);
      result.elapsedMs = Math.round(performance.now() - started);
      child.stdout.destroy(); child.stderr.destroy(); if (child.connected) child.disconnect(); child.unref();
      resolve(result);
    }
    function stop() {
      if (stopping) return; stopping = true; clearTimeout(timer);
      if (![...owned].some(([pid, detached]) => alive(pid, detached))) {
        // Let stdout/stderr drain after exit; close normally finishes sooner.
        finishTimer = setTimeout(finish, settleMs); return;
      }
      signalAll('SIGTERM');
      escalation = setTimeout(() => signalAll('SIGKILL'), graceMs);
      finishTimer = setTimeout(finish, graceMs + settleMs);
    }
    function interrupted(signal) { result.interrupted = signal; stop(); }
    const onInterrupt = () => interrupted('SIGINT'), onTerminate = () => interrupted('SIGTERM');
    process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
    child.once('error', error => { result.spawnError = error.code; stop(); });
    child.once('exit', (code, signal) => { result.exitCode = code; result.exitSignal = signal; stop(); });
    child.once('close', () => { if (stopping && ![...owned].some(([pid, detached]) => alive(pid, detached))) finish(); });
    timer = setTimeout(() => { result.timedOut = true; stop(); }, Math.max(1, budgetMs - graceMs - settleMs));
  });
}

function caseSucceeded(value, source) {
  return value.exitCode === 0 && !value.timedOut && !value.interrupted && !value.cleanupError &&
    value.assertionsPassed === true && value.remainingOwnedProcesses?.length === 0 &&
    value.events?.some(event => event.kind === 'editor-served') &&
    value.events?.some(event => event.kind === 'source' && event.original === source.editor && event.canonicalTest === source.canonicalTest);
}

async function main() {
  if (process.platform === 'win32') throw Error('Owned process-group diagnostics require Linux or macOS');
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output') throw Error('Usage: node scripts/diagnose-i18n-lifecycle.cjs --output NEW_DIRECTORY');
  const output = path.resolve(args[1]);
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.mkdirSync(output);
  const before = { editor: hash(fs.readFileSync(EDITOR)), canonicalTest: hash(fs.readFileSync(TEST)) };
  if (before.canonicalTest !== TEST_SHA) throw Error('Canonical i18n test identity changed');
  instrumentEditor(fs.readFileSync(EDITOR, 'utf8'), 'baseline');
  const report = { schema: 1, diagnosticOnly: true, sourceCommit: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, timeout: 5000, encoding: 'utf8' }).trim(),
    source: before, cases: [], limits: { caseMs: 100000, overallMs: 330000 },
    caveat: 'Console delivery can lag or be lost if a browser process blocks. Missing markers do not prove a particular operation began or completed. Instrumentation itself can affect timing. B is diagnostic and is not application acceptance.' };
  const deadline = performance.now() + 330000;
  for (const [label, mode] of [['A1', 'baseline'], ['B', 'omit-force-context-loss'], ['A2', 'baseline']]) {
    const budgetMs = Math.min(100000, deadline - performance.now());
    if (budgetMs < 3000) { report.cases.push({ label, mode, notRun: 'overall-deadline' }); break; }
    console.log(`I18N lifecycle ${label}: ${mode}`);
    const result = await runChild(['--require', __filename, TEST], { budgetMs,
      env: { ...process.env, HOME_STUDIO_LIFECYCLE_CHILD: '1', HOME_STUDIO_LIFECYCLE_MODE: mode } });
    report.cases.push({ label, mode, ...result });
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ label, exitCode: result.exitCode, timedOut: result.timedOut,
      assertionsPassed: !!result.assertionsPassed, cleanupError: result.cleanupError,
      remainingOwnedProcesses: result.remainingOwnedProcesses }));
    if (result.interrupted || result.cleanupError || result.remainingOwnedProcesses.length) break;
  }
  report.sourceUnchanged = before.editor === hash(fs.readFileSync(EDITOR)) && before.canonicalTest === hash(fs.readFileSync(TEST));
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  if (!report.sourceUnchanged || report.cases.length !== 3 || !report.cases.every(value => caseSucceeded(value, before))) process.exitCode = 1;
}

module.exports = { ORIGINAL, OPERATIONS, instrumentEditor, lifecycleMessage, runChild, caseSucceeded };
if (process.env.HOME_STUDIO_LIFECYCLE_CHILD === '1') installPreload();
else if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
