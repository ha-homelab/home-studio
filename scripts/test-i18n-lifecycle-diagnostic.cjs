'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { ORIGINAL, OPERATIONS, instrumentEditor, lifecycleMessage, runChild, caseSucceeded } = require('./diagnose-i18n-lifecycle.cjs');

function execute(mode, { persisted = false, fail } = {}) {
  const calls = [], marks = [], handlers = {};
  const operation = name => () => { calls.push(name); if (name === fail) throw Error(name); };
  const context = vm.createContext({
    window: { addEventListener(name, handler) { handlers[name] = handler; } },
    console: { info(text) { marks.push(lifecycleMessage(text)); } }, performance: { now: () => 1 },
    canvasSuspended: false, view: 'preview', drag: true,
    siteEditor: { setSuspended: operation('site-suspend'), cancel: operation('site-cancel'), dispose: operation('site-dispose') },
    finishPointer: operation('finish-pointer'), releasePreviewPointer: operation('release-pointer'),
    cancelCanvasRender: operation('cancel-frame'), canvasObserver: { disconnect: operation('observer-disconnect') },
    previewEvents: { abort: operation('events-abort') }, floorNavigator: { destroy: operation('navigator-destroy') },
    disposePreviewRenderer: operation('renderer-dispose'), renderer: { forceContextLoss: operation('force-context-loss') },
  });
  vm.runInContext(mode === 'original' ? ORIGINAL : instrumentEditor(ORIGINAL, mode), context);
  let error;
  try { handlers.pagehide({ persisted }); } catch (failure) { error = failure; }
  return { calls, marks, error, suspended: context.canvasSuspended };
}

test('the exact current anchor is unique and instrumentation leaves all other source bytes alone', () => {
  const source = fs.readFileSync(path.join(__dirname, '../planner/editor.js'), 'utf8');
  const [before, after] = source.split(ORIGINAL);
  for (const mode of ['baseline', 'omit-force-context-loss']) {
    const result = instrumentEditor(source, mode);
    assert(result.startsWith(before)); assert(result.endsWith(after));
  }
  assert.throws(() => instrumentEditor('missing', 'baseline'), /exactly one/);
  assert.throws(() => instrumentEditor(ORIGINAL + ORIGINAL, 'baseline'), /exactly one/);
  assert.throws(() => instrumentEditor(ORIGINAL, 'unknown'), /Unknown/);
});

test('baseline preserves every cleanup operation and B omits only final context loss', () => {
  const original = execute('original'), baseline = execute('baseline'), omitted = execute('omit-force-context-loss');
  assert.deepEqual(baseline.calls, original.calls);
  assert.deepEqual(omitted.calls, original.calls.filter(name => name !== 'force-context-loss'));
  assert(baseline.suspended && omitted.suspended);
  assert.equal(baseline.marks.length, 2 + OPERATIONS.length * 2);
  assert.equal(baseline.marks.at(-1).stage, 'exit');
  assert.equal(omitted.marks.filter(mark => mark.stage === 'force-context-loss.omitted').length, 1);
  assert.deepEqual(execute('baseline', { persisted: true }).calls, execute('original', { persisted: true }).calls);
  assert(!execute('baseline', { persisted: true }).marks.some(mark => mark.stage.startsWith('renderer-dispose')));
});

test('native failures retain their exact stop position and are never swallowed by marking', () => {
  for (const fail of ['renderer-dispose', 'force-context-loss']) {
    const result = execute('baseline', { fail });
    assert.equal(result.error.message, fail);
    assert.equal(result.marks.at(-1).stage, fail + '.before');
    assert(!result.marks.some(mark => mark.stage === 'exit'));
  }
});

test('only bounded known marker fields can leave the page', () => {
  const good = { stage: 'enter', time: 1, view: 'preview', persisted: false, hasRenderer: true };
  assert.deepEqual(lifecycleMessage('HOME_STUDIO_LIFECYCLE ' + JSON.stringify({ ...good, private: 'never forwarded' })), good);
  for (const value of ['other', 'HOME_STUDIO_LIFECYCLE {}', 'HOME_STUDIO_LIFECYCLE ' + 'x'.repeat(600),
    'HOME_STUDIO_LIFECYCLE ' + JSON.stringify({ ...good, stage: 'unknown' })]) assert.equal(lifecycleMessage(value), null);
});

test('normal child output drains and an unsuccessful exit remains unsuccessful', { skip: process.platform === 'win32' }, async () => {
  const good = await runChild(['-e', "process.stdout.write('Browser i18n checks passed: synthetic\\n');"], { env: { ...process.env }, budgetMs: 2000, graceMs: 50, settleMs: 100 });
  assert.equal(good.exitCode, 0); assert.equal(good.assertionsPassed, true); assert.equal(good.timedOut, false);
  assert.deepEqual(good.remainingOwnedProcesses, []);
  const bad = await runChild(['-e', 'process.exitCode=7'], { env: { ...process.env }, budgetMs: 2000, graceMs: 50, settleMs: 100 });
  assert.equal(bad.exitCode, 7); assert.equal(bad.assertionsPassed, undefined);
});

test('preload changes only the served editor and forwards host and native-console events', { skip: process.platform === 'win32' }, async () => {
  const script = `const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
    const {EventEmitter}=require('node:events'), cp=require('node:child_process');
    const playwright=require('playwright'), context=new EventEmitter(), browser=new EventEmitter();
    browser.version=()=> 'synthetic-browser'; browser.newContext=async()=>context;
    playwright.chromium.launch=async()=>browser;
    const original=fs.readFileSync('planner/editor.js','utf8'), canonical=fs.readFileSync('scripts/test-i18n-browser.cjs');
    require('./scripts/diagnose-i18n-lifecycle.cjs');
    assert.notEqual(fs.readFileSync(path.resolve('planner/editor.js'),'utf8'),original);
    assert.deepEqual(fs.readFileSync('scripts/test-i18n-browser.cjs'),canonical);
    (async()=>{
      const observed=await playwright.chromium.launch(); await observed.newContext();
      const page=new EventEmitter(), failure=Error('synthetic');
      page.goto=async()=>42; page.reload=async()=>{throw failure;}; context.emit('page',page);
      assert.equal(await page.goto('http://127.0.0.1/'),42);
      await assert.rejects(page.reload(),error=>error===failure);
      page.emit('console',{text:()=> 'HOME_STUDIO_LIFECYCLE '+JSON.stringify({stage:'enter',time:1,view:'preview',persisted:false,hasRenderer:true})});
      page.emit('load'); browser.emit('disconnected');
      const helper=cp.spawn(process.execPath,['-e','process.exit(0)'],{detached:true,stdio:'ignore'});
      await new Promise(resolve=>helper.once('exit',resolve));
      console.log('Browser i18n checks passed: synthetic');
    })().catch(error=>{console.error(error);process.exitCode=1;});`;
  const result = await runChild(['-e', script], { env: { ...process.env,
    HOME_STUDIO_LIFECYCLE_CHILD: '1', HOME_STUDIO_LIFECYCLE_MODE: 'baseline' }, budgetMs: 4000, graceMs: 100, settleMs: 200 });
  assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.assertionsPassed, true);
  assert(result.events.some(event => event.kind === 'source' && event.original !== event.served));
  assert(result.events.some(event => event.kind === 'editor-served'));
  assert(result.events.some(event => event.kind === 'browser' && event.version === 'synthetic-browser'));
  assert(result.events.some(event => event.kind === 'navigation-end' && event.method === 'reload' && event.success === false));
  assert(result.events.some(event => event.kind === 'lifecycle' && event.stage === 'enter'));
  assert(result.events.some(event => event.kind === 'browser-disconnected'));
  assert(result.events.some(event => event.kind === 'owned-process' && event.detached));
  assert.deepEqual(result.remainingOwnedProcesses, []);
});

test('deadline stops both the owned test and separately detached browser-shaped helper', { skip: process.platform === 'win32' }, async () => {
  const script = `const cp=require('node:child_process');
    const helper=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    process.send({kind:'owned-process',pid:helper.pid,detached:true});
    setInterval(()=>{},1000);`;
  const result = await runChild(['-e', script], { env: { ...process.env }, budgetMs: 700, graceMs: 100, settleMs: 200 });
  assert.equal(result.timedOut, true); assert(result.elapsedMs < 1500);
  assert.deepEqual(result.remainingOwnedProcesses, []);
  const helper = result.events.find(event => event.kind === 'owned-process');
  assert(helper); assert(result.cleanupSignals.some(signal => signal.pid === helper.pid && signal.group));
  assert.throws(() => process.kill(helper.pid, 0), { code: 'ESRCH' });
});

test('a cleanup error remains a failure even after escalation removes all owned processes', { skip: process.platform === 'win32' }, async () => {
  let refused = false;
  const result = await runChild(['-e', 'setInterval(()=>{},1000)'], {
    env: { ...process.env }, budgetMs: 700, graceMs: 100, settleMs: 200,
    signalProcess(pid, signal) {
      if (signal === 'SIGTERM' && !refused) { refused = true; throw Object.assign(Error('synthetic refusal'), { code: 'EPERM' }); }
      return process.kill(pid, signal);
    },
  });
  assert.equal(result.cleanupError, 'EPERM'); assert.deepEqual(result.remainingOwnedProcesses, []);
  assert(result.cleanupSignals.some(entry => entry.signal === 'SIGKILL'));
  const source = { editor: 'original', canonicalTest: 'canonical' };
  const successful = { exitCode: 0, assertionsPassed: true, remainingOwnedProcesses: [],
    events: [{ kind: 'editor-served' }, { kind: 'source', original: source.editor, canonicalTest: source.canonicalTest }] };
  assert.equal(caseSucceeded(successful, source), true);
  assert.equal(caseSucceeded({ ...successful, cleanupError: result.cleanupError }, source), false);
  assert.equal(caseSucceeded({ ...successful, interrupted: 'SIGTERM' }, source), false);
});
