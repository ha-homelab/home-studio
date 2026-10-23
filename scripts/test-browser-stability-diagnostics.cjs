// Fast unit checks for acceptance receipts; no browser or graphics driver needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const vm = require('node:vm');
const {test, after} = require('node:test');
const {createDiagnostics, createPhaseTimings, positiveInteger, selectedEngines, browserLaunchOptions, browserProfile, loadPlaywright, browserIdentity, createInputDriver, viewerInputOptions, captureViewerFrames, waitForViewerLightState, assertViewerInteraction} = require('./browser-stability-diagnostics.cjs');

test('host phase timing closes sequential phases and preserves the timeout observation', () => {
  let now=100;
  const record={}, phases=createPhaseTimings(record,()=>now);
  phases.start('viewer-load',{cycle:0});
  now=125;phases.start('light-state',{cycle:0,activeLights:72});
  assert.deepEqual(record.phases[0],{cycle:0,name:'viewer-load',startedMs:0,completedMs:25,durationMs:25});
  now=140;phases.freezeTimeout();
  const frozen=JSON.stringify(record.timeoutPhase);
  assert.deepEqual(record.timeoutPhase,{elapsedMs:40,activePhase:{cycle:0,activeLights:72,name:'light-state',startedMs:25,completedMs:null,durationMs:null}});
  now=160;phases.start('viewer-detach',{cycle:0});
  now=170;phases.complete();phases.complete();phases.freezeTimeout();
  assert.equal(record.activePhase,null);
  assert.equal(record.phases[1].durationMs,35);
  assert.equal(record.phases[2].durationMs,10);
  assert.equal(JSON.stringify(record.timeoutPhase),frozen,'Late completion and repeated timeout capture cannot rewrite the original active phase');
  const empty={}, idle=createPhaseTimings(empty,()=>now);
  idle.freezeTimeout();assert.deepEqual(empty.timeoutPhase,{elapsedMs:0,activePhase:null});
});

test('viewer drag receipts preserve native phases and the existing two-frame completion wait', async () => {
  const source=fs.readFileSync(path.join(__dirname,'test-browser-stability.cjs'),'utf8');
  const start=source.indexOf('const dragCanvas = async'),end=source.indexOf("    phases.start('dashboard-navigation');",start);
  assert(start>=0&&end>start);
  let now=100,drags=0,frames=0,evaluations=0,fail=false;
  const phases={hoverMs:2,pressMs:3,moveMs:20,releaseMs:4};
  const env={Date:{now:()=>now},input:{drag:async()=>{drags++;if(fail)throw Error('native failure');now+=29;return phases;}},
    requestAnimationFrame:callback=>{frames++;now+=7;callback();}};
  vm.runInNewContext(source.slice(start,end).replace('const dragCanvas','globalThis.dragCanvas'),env);
  const locator={scrollIntoViewIfNeeded:async()=>{},boundingBox:async()=>({x:10,y:20,width:100,height:100}),evaluate:async()=>({x:.25,y:.35})};
  const child={evaluate:async callback=>{evaluations++;return callback();}};
  const result=await env.dragCanvas(locator,child);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{durationMs:43,phases:{...phases,framesMs:14}});
  assert.equal(drags,1);assert.equal(frames,2);assert.equal(evaluations,1);
  assert.deepEqual(phases,{hoverMs:2,pressMs:3,moveMs:20,releaseMs:4},'Input phase data is not mutated');
  fail=true;await assert.rejects(env.dragCanvas(locator,child),/native failure/);
  assert.equal(drags,2);assert.equal(frames,2,'Failed native input cannot be replaced by another action');
  assert.match(source,/sample\.homeDragPhases = homeDrag\.phases/);
  assert.match(source,/sample\.editorDragPhases = editorDrag\.phases/);
});

// Drive the exact function serialized into the real viewer with a virtual
// clock. This exercises deadlines and draw receipts without real-time sleeps.
async function wheelMeasurement({draws=[16],receipt=true,camera=true,idleRaf=false,sized=true,blank=false}={}) {
  const source=fs.readFileSync(path.join(__dirname,'test-browser-stability.cjs'),'utf8');
  const start=source.indexOf('async function measureEditorWheelBurst()'),end=source.indexOf('\nasync function run(',start);
  assert(start>=0&&end>start);
  let now=0,nextId=1,wheels=0,demand=false,done=false,result,error;
  const timers=new Map(),frames=new Map(),cancelled=[];
  const state={renderCount:4,passes:4,camera:{projection:[1],world:[1]}};
  const schedule=(callback,delay)=>{const id=nextId++;timers.set(id,{callback,at:now+delay});return id;};
  const bounds={width:945,height:516.609375,top:190.390625,bottom:707};
  const canvas={width:945,height:sized?516:1,getBoundingClientRect:()=>bounds,dispatchEvent(event){
    assert.equal(event.type,'wheel');assert.deepEqual({...event.options},{deltaY:1,cancelable:true,bubbles:true});wheels++;
    if(demand)return;
    demand=true;
    for(const pending of frames.values())pending.at=now+16;
    for(const delay of draws)schedule(()=>{
      state.renderCount++;
      if(receipt)state.passes++;
      if(receipt&&camera)state.camera={projection:[1],world:[2]};
    },delay);
  }};
  const env={performance:{now:()=>now},setTimeout:schedule,clearTimeout:id=>timers.delete(id),
    requestAnimationFrame(callback){const id=nextId++;frames.set(id,{callback,at:idleRaf||demand?now+16:Infinity});return id;},
    cancelAnimationFrame(id){cancelled.push(id);frames.delete(id);},
    WheelEvent:class{constructor(type,options){this.type=type;this.options=options;}},
    matchMedia:()=>({matches:true}),document:{hidden:false,visibilityState:'visible',hasFocus:()=>true,
      querySelector:selector=>selector==='#view3d canvas'?canvas:{getBoundingClientRect:()=>bounds}},
    floorplan:{get renderCount(){return state.renderCount;},homeMode:false},
    __browserScene:()=>({pixelRatio:1,camera:state.camera,renderPasses:{scene:state.passes,last:'scene',
      sceneViewport:[0,0,945,516],sceneDrawCalls:blank?0:74}})};
  env.window=env;
  vm.runInNewContext(source.slice(start,end)+'\nglobalThis.measure=measureEditorWheelBurst;',env);
  env.measure().then(value=>{done=true;result=value;},failure=>{done=true;error=failure;});
  for(let turns=0;!done&&turns<5000;turns++) {
    await Promise.resolve();await Promise.resolve();
    if(done)break;
    const queue=[...timers].map(([id,value])=>({id,...value,source:timers}))
      .concat([...frames].map(([id,value])=>({id,...value,source:frames}))).sort((a,b)=>a.at-b.at||a.id-b.id);
    assert(queue.length&&Number.isFinite(queue[0].at),'Measurement must not block on idle RAF');
    const next=queue[0];now=next.at;next.source.delete(next.id);next.callback(now);
  }
  assert(done,'Measurement must finish under the existing deadline');
  assert.equal(frames.size,0,'The diagnostic RAF heartbeat is cancelled');
  assert(cancelled.length>0);
  return {result,error,now,wheels};
}

test('wheel acceptance tolerates stopped idle RAF and requires a fresh demand draw',async()=>{
  const {result,error,now,wheels}=await wheelMeasurement();
  assert.ifError(error);assert.equal(wheels,40);
  assert.equal(result.settled.lifecycle.raf.callbacks,0,'No idle animation callback is needed to settle');
  assert.equal(result.settled.stableSamples,7);assert.equal(result.settled.waitMs,150);
  assert.equal(result.lifecycle.visibility,'visible');assert.equal(result.lifecycle.focused,true);
  assert(result.lifecycle.raf.callbacks>0,'Fresh demand can resume the observed heartbeat');
  assert.equal(result.synchronousDraws,0);assert.equal(result.totalDraws,1);assert.equal(result.sceneDraws,1);
  assert.equal(result.cameraChanged,true);assert(now<10000);
});

test('wheel acceptance rejects missing, stale, blank and excess real draws',async()=>{
  for(const options of [{draws:[]},{draws:[9800]},{receipt:false},{camera:false},{blank:true}]) {
    const {error,now,wheels}=await wheelMeasurement(options);
    assert.match(error.message,/did not produce a fresh complete scene draw and changed camera/);
    assert.match(error.message,/"visibility":"visible"/);assert.match(error.message,/"raf":/);
    assert.equal(now,10000);assert.equal(wheels,40);
  }
  const excess=await wheelMeasurement({draws:[16,32,100]});
  assert.match(excess.error.message,/exceeded two draws/);
  assert(excess.now<10000);assert.equal(excess.wheels,40);
});

test('wheel acceptance preserves the sized idle deadline and accepts two bounded draws',async()=>{
  const unsized=await wheelMeasurement({sized:false});
  assert.match(unsized.error.message,/did not settle/);assert.equal(unsized.now,10000);assert.equal(unsized.wheels,0);
  const twice=await wheelMeasurement({idleRaf:true,draws:[16,32]});
  assert.ifError(twice.error);assert.equal(twice.result.totalDraws,2);assert.equal(twice.result.sceneDraws,2);
  assert(twice.result.settled.lifecycle.raf.callbacks>0);
});

test('Viewer frame receipts advance only after the real draw succeeds', () => {
  let active = 18, fail = false;
  const env = {renderer: {info:{render:{calls:1,triangles:1}},domElement:{width:632,height:394},getViewport(v){return v.copy({x:0,y:0,z:632,w:394});},getPixelRatio(){return 1;},render() {if (fail) throw Error('draw failed'); return 42;}},
    __browserScene: () => ({activePointLights: active})};
  env.window = env;
  vm.runInNewContext(`(${captureViewerFrames.toString()})(renderer)`, env);
  const camera = {projectionMatrix: {toArray: () => [1]}, matrixWorld: {toArray: () => [2]}};
  assert.equal(env.renderer.render({}, camera), 42);
  active = 0;
  assert.equal(env.__browserRenderedLights, 18, 'CPU state is not a completed frame');
  env.renderer.render({}, camera);
  assert.equal(env.__browserRenderedLights, 0);
  active = 9;
  env.renderer.render({name:'interaction-copy'}, {});
  assert.equal(env.__browserRenderedLights,0,'A copy pass cannot certify a new light state');
  assert.deepEqual(Array.from(env.__browserCamera.world),[2],'The copy camera cannot replace the scene camera');
  assert.equal(env.__browserRenderPasses.copy,1,'Copy passes remain visible in receipts');
  assert.equal(env.__browserRenderPasses.scene,2);
  assert.equal(env.__browserRenderPasses.last,'copy');
  assert.deepEqual(Array.from(env.__browserRenderPasses.copyViewport),[0,0,632,394]);
  fail = true;
  assert.throws(() => env.renderer.render({}, camera), /draw failed/);
  assert.equal(env.__browserRenderedLights, 0, 'A failed draw cannot certify new state');
});

async function lightStateMeasurement({drawAt=50, expectedLights=71, mutation, lateRead=false}={}) {
  let now=0, serial=0, completed=false, result, error, measuring=false;
  const timers=new Map(), state={renderCount:0, activeLights:72, markers:72, slots:72};
  const camera={projectionMatrix:{toArray:()=>[1]},matrixWorld:{toArray:()=>[1]}};
  const env={performance:{now:()=>now},
    setTimeout(callback, delay){const id=++serial;timers.set(id,{at:now+delay,callback});return id;},
    // Model a browser that never delivers additional idle RAF callbacks.
    requestAnimationFrame(){throw Error('Light-state receipt must not request an idle animation frame');},
    document:{querySelectorAll:()=>({length:state.markers}),visibilityState:'visible',hidden:false,hasFocus:()=>true},
    floorplan:{homeMode:true,get renderCount(){return state.renderCount;}},__browserStability:{linkedPrograms:19},
    renderer:{info:{render:{calls:8,triangles:12}},domElement:{width:920,height:622},
      getViewport(value){return value.copy({x:0,y:0,z:920,w:622});},getPixelRatio:()=>1,
      render(){state.renderCount++;}},
    __browserScene(){
      if(measuring&&lateRead)now=30000;
      return {activePointLights:state.activeLights,pointLights:state.slots,
        drawingBuffer:[920,622],renderPasses:env.__browserRenderPasses};
    }};
  env.window=env;
  vm.runInNewContext(`(${captureViewerFrames.toString()})(renderer);globalThis.wait=${waitForViewerLightState.toString()};`,env);
  env.renderer.render({},camera);
  const before={beforeRenderCount:state.renderCount,beforeSceneDraws:env.__browserRenderPasses.scene};
  state.markers=state.activeLights=expectedLights;
  const draw=()=>{
    env.renderer.render(mutation==='copy'?{name:'interaction-copy'}:{},camera);
    if(mutation==='markers')state.markers++;
    if(mutation==='active')state.activeLights++;
    if(mutation==='slots')state.slots++;
    if(mutation==='rendered')env.__browserRenderedLights++;
    if(mutation==='render-count')state.renderCount=before.beforeRenderCount;
    if(mutation==='scene-count')env.__browserRenderPasses.scene=before.beforeSceneDraws;
    if(mutation==='blank')env.__browserRenderPasses.sceneDrawCalls=0;
    if(mutation==='viewport')env.__browserRenderPasses.sceneViewport=[0,0,460,311];
  };
  if(drawAt===0)draw();
  else if(drawAt!==null)env.setTimeout(draw,drawAt);
  measuring=true;
  env.wait({...before,expectedLights,expectedSlots:72}).then(value=>{completed=true;result=value;},failure=>{completed=true;error=failure;});
  for(let turn=0;!completed&&turn<1500;turn++) {
    for(let microtask=0;microtask<6;microtask++)await Promise.resolve();
    if(completed)break;
    const next=[...timers].sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
    assert(next,'Receipt must make progress using a bounded timer');
    timers.delete(next[0]);now=next[1].at;next[1].callback();
  }
  assert(completed,'Receipt must finish within its fixed operation deadline');
  assert.equal(timers.size,0,'Receipt leaves no polling timers running');
  return {result,error,now};
}

test('light-state receipt accepts a real draw without extra idle animation frames',async()=>{
  for(const drawAt of [0,50])for(const expectedLights of [0,71,72]) {
    const {result,error,now}=await lightStateMeasurement({drawAt,expectedLights});
    assert.ifError(error);assert.equal(now,drawAt);assert.equal(result.waitMs,drawAt);
    assert.equal(result.renderedLights,expectedLights);assert.equal(result.markerCount,expectedLights);
    assert.equal(result.scene.activePointLights,expectedLights);
    assert.equal(result.renderCount,2);assert.equal(result.scene.renderPasses.scene,2);
  }
});

test('light-state receipt rejects missing draws, wrong counts, stale frames and copy-only output',async()=>{
  for(const mutation of ['markers','active','slots','rendered','render-count','scene-count','copy','blank','viewport']) {
    const {error,now}=await lightStateMeasurement({mutation});
    assert.match(error.message,/Light state did not produce a fresh complete scene draw/);
    assert.equal(now,30000);
  }
  for(const options of [{drawAt:null},{drawAt:null,expectedLights:72}]) {
    const {error,now}=await lightStateMeasurement(options);
    assert.match(error.message,/beforeSceneDraws/);assert.equal(now,30000);
  }
});

test('light-state receipt rejects a fresh result observed at the deadline',async()=>{
  const {error,now}=await lightStateMeasurement({drawAt:0,lateRead:true});
  assert.match(error.message,/Light state did not produce/);assert.equal(now,30000);
});

test('real light-state loop captures a baseline before sending and retains state assertions',()=>{
  const source=fs.readFileSync(path.join(__dirname,'test-browser-stability.cjs'),'utf8');
  const start=source.indexOf('for(const [next,onCount]'),end=source.indexOf("phases.start('state-checks'",start);
  const block=source.slice(start,end);assert(start>0&&end>start);
  assert(block.indexOf('const beforeState = await snapshot()')<block.indexOf('window.viewerPort.postMessage'));
  assert(block.includes('child.evaluate(waitForViewerLightState'));
  assert(block.includes('beforeSceneDraws:beforeState.scene.renderPasses.scene'));
  assert(block.includes('expectedLights:onCount, expectedSlots:lights'));
  assert(!/requestAnimationFrame|waitForFunction|renderModel\(/.test(block));
  for(const assertion of ['value.scene.pointLights===lights','value.scene.activePointLights===onCount','value.renderedLights===onCount'])assert(block.includes(assertion));
  assert(source.includes('reportOnly, deadlineMs: 180000'));
});

test('real software gestures require bounded scene and full copy passes before full-quality release', () => {
  const before={scene:{renderPasses:{copy:0}}};
  const after={gpu:{unmaskedRenderer:'Apple Software Renderer'},scene:{drawingBuffer:[632,394],renderPasses:{copy:1,motionDrawCalls:91,motionSceneDrawCalls:90,last:'scene',sceneViewport:[0,0,632,394],motionSceneViewport:[0,0,223,139],copyViewport:[0,0,632,394],motionBuffer:[632,394]}}};
  assertViewerInteraction(before,after);
  for(const change of [{copy:0},{motionDrawCalls:90},{last:'copy'},{sceneViewport:[0,0,316,197]},{motionSceneViewport:[0,0,632,394]},{copyViewport:[0,0,631,394]}]) {
    assert.throws(()=>assertViewerInteraction(before,{...after,scene:{...after.scene,renderPasses:{...after.scene.renderPasses,...change}}}));
  }
  for(const renderer of ['SwiftShader','llvmpipe','Microsoft Basic Render Driver']) {
    const software={...after,gpu:{unmaskedRenderer:renderer},scene:{...after.scene,renderPasses:{...after.scene.renderPasses,motionSceneViewport:[0,0,316,197]}}};
    assertViewerInteraction(before,software);
    assert.throws(()=>assertViewerInteraction(before,{...software,scene:{...software.scene,renderPasses:{...software.scene.renderPasses,motionSceneViewport:[0,0,317,198]}}}),/bounded copy budget/);
  }
  const native={...after,gpu:{unmaskedRenderer:'Apple M5 Pro'}};
  assert.throws(()=>assertViewerInteraction(before,native),/direct rendering/);
  native.scene={...after.scene,renderPasses:{...after.scene.renderPasses,copy:0}};
  assertViewerInteraction(before,native);
});

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

test('watchdog freezes the active phase before late callback work resumes during capture', async () => {
  const fake=fakeBrowser(), diagnostics=suite('phase-timeout',{firefox:{launch:async()=>fake.browser}});
  let resume, lateFinished;
  const late=new Promise(resolve=>{lateFinished=resolve;});
  fake.page.frames=()=>[{evaluate:async()=>{
    const atCapture=read(diagnostics);
    assert.equal(atCapture.timeoutPhase.activePhase.name,'context-restore');
    assert.equal(atCapture.timeoutPhase.activePhase.completedMs,null);
    resume();await late;
    return {stats:{gpu:{renderer:'Fictional GPU'}}};
  }}];
  await assert.rejects(diagnostics.run('firefox',{...options,deadlineMs:10},async({phases})=>{
    phases.start('context-restore',{cycle:1});
    await new Promise(resolve=>{resume=resolve;});
    phases.start('viewer-detach',{cycle:1});
    phases.complete();lateFinished();
  }),/browser deadline/);
  const record=read(diagnostics);
  assert.equal(record.status,'failed');
  assert.equal(record.timeoutPhase.activePhase.name,'context-restore');
  assert.equal(record.timeoutPhase.activePhase.cycle,1);
  assert.equal(record.timeoutPhase.activePhase.completedMs,null);
  const lateRestore=record.phases.find(entry=>entry.name==='context-restore');
  assert(lateRestore.completedMs>=record.timeoutPhase.elapsedMs);
  assert(record.phases.some(entry=>entry.name==='viewer-detach'&&entry.completedMs!==null));
  assert(fake.context.closed&&fake.browser.closed);
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

test('native drag holds its final position before release within the measured budget', async t => {
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const commands = [];
  const page = {context:()=>({newCDPSession:async()=>({send:async(method,payload)=>commands.push({method,payload})})})};
  const driver = await createInputDriver(page,'chromium',{input:'native-touch',emulated:true});
  let finished = false;
  const drag = driver.drag({x:10,y:20},{x:100,y:200}).then(value=>{finished=true;return value;});
  await new Promise(setImmediate);
  assert.equal(commands.length,13,'Only start and twelve moves precede the stationary hold');
  assert.deepEqual(commands.at(-1).payload.touchPoints,[{x:100,y:200,id:0}]);
  t.mock.timers.tick(99); await new Promise(setImmediate);
  assert.equal(finished,false); assert.equal(commands.length,13,'No early release or extra input');
  t.mock.timers.tick(1);
  const timings = await drag;
  assert.equal(timings.releaseMs,100,'The hold is included in measured drag latency');
  assert.equal(commands.length,14);
  assert.deepEqual(commands.at(-1),{method:'Input.dispatchTouchEvent',payload:{type:'touchEnd',touchPoints:[]}});
  assert(commands.every(command=>command.method==='Input.dispatchTouchEvent'),'No synthetic click or extra transport');
});

test('Chromium touch defaults to serialized native taps with explicit comparison modes', async () => {
  const touch = {input:'native-touch',emulated:true};
  assert.deepEqual(viewerInputOptions('chromium', touch, {}), {tapMode:'sequential',traceInput:false,dragReleaseHoldMs:100});
  assert.deepEqual(viewerInputOptions('chromium', {input:'mouse'}, {}), {tapMode:'playwright',traceInput:false,dragReleaseHoldMs:0});
  assert.deepEqual(viewerInputOptions('webkit', {input:'native-tap-mouse-drag',emulated:true}, {}), {tapMode:'playwright',traceInput:false,dragReleaseHoldMs:0});
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
  const elevationHandle = Object.assign(new EventTarget(), {hidden:true, style:{}});
  const splitTab = Object.assign(new EventTarget(), {id:'split-tab',hidden:false,disabled:false,title:'',tabIndex:-1});
  let context, activeCanvas, currentFocus, layoutReads = 0, fitCalls = 0, reusedRestores = 0;
  class Canvas extends EventTarget {
    constructor() { super(); this.id='preview-canvas';this.width=934;this.height=824;this.isConnected=true;this.attributes={tabindex:'0','aria-label':'Preview'};this.dataset={};this.style={};this.captured=new Set();canvases.push(this); }
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
  const vector = () => ({x:0,y:0,z:0,set(x,y,z){Object.assign(this,{x,y,z});},clone(){return Object.assign(vector(),{x:this.x,y:this.y,z:this.z});}});
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
    // The isolated lifecycle fixture uses the normal, unthemed canvas palette.
    planColors:{background:'#f2f4ed'},
    // This renderer-lifecycle fixture has no scenery; preserve its optional layer contract.
    createEnvironmentControls:()=>({refresh(){}}),createEnvironmentLayer:()=>({setActive(){},dispose(){}}),
    t:value=>value,floorBounds:()=>({minX:0,maxX:8,minZ:0,maxZ:10}),
    THREE:{WebGLRenderer:Renderer,Scene:Group,Group,Vector3:class {constructor(x,y,z){Object.assign(this,vector(),{x,y,z});}},HemisphereLight:Light,DirectionalLight:Light,
      PerspectiveCamera:class {constructor(){this.position=vector();}lookAt(){}updateProjectionMatrix(){} }},
    $:id=>id==='preview-canvas'?activeCanvas:id==='preview-error'?error:id==='preview-elevation-handle'?elevationHandle:id==='split-tab'?splitTab:null,translatedText(){},
    fitPreview(){fitCalls++;},fitPlan(){},updateZoom(){},previewFloors:()=>[],
    cancelCanvasRender(){traces.push('cancel');},onSchedule:value=>scheduled.push(JSON.parse(JSON.stringify(value))),
    testMesh:()=>({traverse(callback){callback({geometry:resource('geometry'),material:[resource('material-a'),resource('material-b')]});}}),
    planCanvas:{},ctx:{setTransform(){}},canvasObserver:{disconnect(){traces.push('disconnect');}},floorNavigator:{destroy(){}},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../planner/render-capacity.js'), 'utf8').replace('export function ', 'function '), context);
  vm.runInContext(`
    let drag=null,previewEdit=null,selection=null,previewDirty=true,canvasSuspended=false,spaceHeld=false,size={width:934,height:824},view=${JSON.stringify(view)};
    let firstResize=false,planSize='old',map={x:0,y:0};
    const project={floors:[{elevation_m:0,walls:[],items:[{position_m:{x:7,z:9}}]}]};
    function displayedProject(){return project;}
    // This lifecycle fixture records render requests; the real RAF coalescing
    // and pane invalidation are exercised by test-planner-render-budget.cjs.
    function requestCanvasRender(){if(!canvasSuspended&&!document.hidden)onSchedule(size);}
    function requestPreviewRender(){requestCanvasRender();}
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
  return {traces,canvases,renderers,scheduled,allocations,error,rect,splitTab,window,evaluate,
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
  const orbit=h.evaluate('JSON.stringify({...orbit,pointers:null,gesture:null})');
  assert(h.lose().defaultPrevented);
  assert(!original.hasPointerCapture(9));
  assert.equal(h.evaluate('orbit.pointers.size'),0);
  assert.deepEqual(h.traces,['cancel','geometry','material-a','material-b','shadow-map','shadow-pass','dispose-1']);
  assert.deepEqual([original.width,original.height],[0,0],'A lost canvas must not restore its former full-size backing buffer');
  h.restore();
  assert.notEqual(h.canvas,original);
  assert.deepEqual(h.canvas.attributes,original.attributes);
  assert.equal(h.reusedRestores,0,'Disposed Three listeners cannot initialize a restored native context');
  assert.equal(h.renderers.length,1,'No renderer is allocated in the restored event');
  assert(h.renderers[0].lost&&h.renderers[0].disposed);
  assert.equal(h.canvases.filter(canvas=>canvas.isConnected).length,1);
  assert.equal(h.evaluate('JSON.stringify({...orbit,pointers:null,gesture:null})'),orbit);
  assert.equal(h.evaluate('JSON.stringify(project)'),project);
  assert.equal(h.error.hidden,true);
  assert(h.evaluate('document.activeElement === previewCanvas'),'Canvas focus survives replacement');
  h.flush();
  assert.equal(h.renderers.length,2);
  assert(h.canvas.width>1&&h.canvas.height>1,'The replacement resumes rendering at the full viewport budget');
  assert.deepEqual([original.width,original.height],[0,0],'The detached canvas keeps minimal storage after its replacement renders');
  assert.equal(h.renderers.filter(renderer=>!renderer.lost).length,1);
  assert.equal(h.fitCalls,2,'Replacement initialization must not refit and reset the saved orbit');
  assert.equal(h.evaluate('JSON.stringify({...orbit,pointers:null,gesture:null})'),orbit);
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
  assert.equal(h.evaluate('orbit.pointers.size === 1 && orbit.pointers.has(1)'),true,'A second pointer cannot replace the active gesture');
  assert(!canvas.hasPointerCapture(2));
  const yaw=h.evaluate('orbit.yaw');
  canvas.emit('pointermove',{pointerId:2,clientX:180,clientY:250});
  assert.equal(h.evaluate('orbit.yaw'),yaw);
  canvas.emit('pointerup',{pointerId:2});canvas.emit('pointercancel',{pointerId:2});
  assert.equal(h.evaluate('orbit.pointers.size === 1 && orbit.pointers.has(1)'),true,'Unrelated up/cancel events cannot end the active gesture');
  canvas.emit('pointermove',{pointerId:1,clientX:40,clientY:30});
  assert.notEqual(h.evaluate('orbit.yaw'),yaw);
  canvas.emit('pointerup',{pointerId:1});
  assert.equal(h.evaluate('orbit.pointers.size'),0);assert(!canvas.hasPointerCapture(1));
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

test('planner operation tracing is opt-in and primary acceptance makes no layout probes', t => {
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'planner-trace-source-'));
  t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
  fs.mkdirSync(path.join(fixture,'planner'));
  fs.writeFileSync(path.join(fixture,'planner/editor.js'),'// Local source fixture.');
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
      http:{createServer:callback=>callback},URL,path,root:fixture,fixtureOnly:false,traceRecovery,fs,
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
    assert.equal(h.splitTab.disabled,false,'Recovered layout keeps the actual split-view control available');
    assert.equal(h.splitTab.title,'Draw in 2D and inspect your changes in 3D.');
    assert.equal(h.allocations.length,0,'The context event only schedules rendering');
    assert(h.scheduled.length>0);
    assert(h.scheduled.every(layout=>layout.width===774&&layout.height===724));
    h.flush();
    assert.equal(h.allocations.length,1);
    assert.deepEqual(h.allocations[0],[774,724,Math.sqrt(2000000/(774*724))]);
  }
});

// Execute the actual shared helper with a deterministic host clock. Timers are
// delivered separately from elapsed time so overdue-microtask races are real.
function clockedDiagnostics(label, configure = () => {}) {
  let now = 0, next = 0;
  const timers = new Map(), exits = [], calls = [];
  const clock = {
    now: () => { clock.beforeRead?.(); return now; },
    beforeRead: null,
    elapse(ms) { now += ms; },
    setTimeout(callback, delay) {
      const timer = {id: ++next, at: now + delay, callback, unref() { return this; }};
      timers.set(timer.id, timer); return timer;
    },
    clearTimeout(timer) { if (timer) timers.delete(timer.id); },
    async flush() { for (let i = 0; i < 60; i++) await Promise.resolve(); },
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const timer = [...timers.values()].filter(t => t.at <= target).sort((a,b) => a.at-b.at || a.id-b.id)[0];
        if (!timer) break;
        now = Math.max(now, timer.at); timers.delete(timer.id); timer.callback(); await this.flush();
      }
      now = Math.max(now, target); await this.flush();
    },
    fireEarly(at) {
      const timer = [...timers.values()].find(value => value.at === at);
      assert(timer, 'Expected scheduled timer'); timers.delete(timer.id); timer.callback();
    },
    pending: () => [...timers.values()].map(t => t.at), exits, calls,
  };
  const fake = fakeBrowser();
  fake.page.close = async () => { calls.push('page-close'); fake.page.closed = true; };
  fake.context.close = async () => { calls.push('context-close'); fake.context.closed = true; };
  fake.browser.close = async () => { calls.push('browser-close'); fake.browser.closed = true; };
  const playwright = {firefox:{launch:async () => fake.browser},chromium:{launch:async () => fake.browser}};
  const settings = {load() {}, fake, playwright, clock}; configure(settings);
  const loaded = {exports:{}};
  const nativeRequire = require('node:module').createRequire(path.join(__dirname,'browser-stability-diagnostics.cjs'));
  const env = {module:loaded,exports:loaded.exports,__dirname,
    require(name) { if(name==='playwright'){settings.load();return playwright;} if(name==='playwright/package.json')return {version:'clock-test'};return nativeRequire(name); },
    console:{log(){},warn(){}}, performance:{now:clock.now},setTimeout:clock.setTimeout,clearTimeout:clock.clearTimeout,
    Buffer,process:{env:{STABILITY_UNIT_DIAGNOSTICS_DIR:directory,GITHUB_SHA:'clock-test'},platform:process.platform,arch:process.arch,version:process.version,exit:code=>exits.push(code)},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'browser-stability-diagnostics.cjs'),'utf8'),env,{filename:'actual-browser-stability-diagnostics.cjs'});
  const diagnostics=loaded.exports.createDiagnostics(label,'STABILITY_UNIT',path.join(__dirname,'..'));
  return {diagnostics,fake,clock,createViewerLoadDeadline:loaded.exports.createViewerLoadDeadline};
}
function deferred() { let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; }

test('bootstrap and scenario have separate absolute budgets including final identity', async () => {
  const {diagnostics,fake,clock}=clockedDiagnostics('split-budget',({clock,fake,playwright})=>{
    playwright.firefox.launch=async()=>{clock.elapse(12000);return fake.browser;};
    fake.browser.newContext=async()=>{clock.elapse(8000);return fake.context;};
    const identity=fake.page.evaluate;let identities=0;
    fake.page.evaluate=async()=>{clock.elapse(++identities===1?9999:499);return identity();};
  });
  const result=await diagnostics.run('firefox',options,async()=>clock.elapse(500));
  assert.equal(result.status,'passed');assert.equal(result.bootstrapDurationMs,29999);
  assert.equal(result.scenarioStartedMs,29999);assert.equal(result.scenarioDurationMs,999);
  assert.equal(result.deadlineScope.bootstrapMs,30000);assert.equal(result.deadlineScope.scenarioMs,1000);
  assert.equal(result.deadlineScope.hardProcessMs,66000);
  assert(fake.context.closed&&fake.browser.closed);assert.equal(clock.pending().length,0);
});

test('all synchronous bootstrap stages count and overdue completion cannot enter the app', async () => {
  for (const stage of ['module','launch','context','init','custom-init','page','default-timeout','identity','listeners','trace-session','trace-start']) {
    let executed=0;
    const {diagnostics,clock}=clockedDiagnostics('overdue-'+stage,settings=>{
      const {fake,playwright,clock}=settings,late=()=>clock.elapse(30000);
      if(stage==='module')settings.load=late;
      if(stage==='launch')playwright.firefox.launch=async()=>{late();return fake.browser;};
      if(stage==='context')fake.browser.newContext=async()=>{late();return fake.context;};
      if(stage==='init'||stage==='custom-init'){let n=0;fake.context.addInitScript=async()=>{if(++n===(stage==='init'?1:2))late();};}
      if(stage==='page')fake.context.newPage=async()=>{late();return fake.page;};
      if(stage==='default-timeout')fake.page.setDefaultTimeout=late;
      if(stage==='identity'){const identity=fake.page.evaluate;fake.page.evaluate=async()=>{late();return identity();};}
      if(stage==='listeners'){const on=fake.page.on;fake.page.on=function(...args){if(args[0]==='requestfailed')late();return on.apply(this,args);};}
      if(stage.startsWith('trace')){
        playwright.chromium.launch=playwright.firefox.launch;
        fake.context.newCDPSession=async()=>{if(stage==='trace-session')late();return {send:async()=>{if(stage==='trace-start')late();},detach:async()=>{}};};
      }
    });
    const tracing=stage.startsWith('trace');
    await assert.rejects(diagnostics.run(tracing?'chromium':'firefox',{...options,instrument:()=>{},inputDiagnostics:tracing?{traceInput:true}:null},async()=>{executed++;}),/30-second bootstrap deadline/);
    const record=read(diagnostics,tracing?'chromium.json':'firefox.json');
    assert.equal(executed,0,stage);assert.equal(record.timeoutScope,'bootstrap',stage);
    assert.equal(record.bootstrapDurationMs,30000,stage);assert.equal(record.scenarioStartedMs,null,stage);
    assert.equal(record.status,'failed',stage);assert.deepEqual(clock.exits,[],stage);
  }
});

test('bootstrap timeout is aggregate and cannot be renewed by context or identity progress', async () => {
  let executed=0;
  const {diagnostics}=clockedDiagnostics('aggregate-setup',({fake,clock,playwright})=>{
    playwright.firefox.launch=async()=>{clock.elapse(15000);return fake.browser;};
    fake.context.newPage=async()=>{clock.elapse(10000);return fake.page;};
    const identity=fake.page.evaluate;fake.page.evaluate=async()=>{clock.elapse(5000);return identity();};
  });
  await assert.rejects(diagnostics.run('firefox',options,async()=>executed++),/bootstrap deadline/);
  assert.equal(executed,0);assert.equal(read(diagnostics).bootstrapDurationMs,30000);
});

test('hanging bootstrap stages time out and late resources close without entering the app', async () => {
  for(const stage of ['launch','context','init','page','identity','trace-session','trace-start']) {
    const gate=deferred();let executed=0;
    const {diagnostics,fake,clock}=clockedDiagnostics('hanging-'+stage,({fake,playwright})=>{
      if(stage==='launch')playwright.firefox.launch=()=>gate.promise;
      if(stage==='context')fake.browser.newContext=()=>gate.promise;
      if(stage==='init')fake.context.addInitScript=()=>gate.promise;
      if(stage==='page')fake.context.newPage=()=>gate.promise;
      if(stage==='identity')fake.page.evaluate=()=>gate.promise;
      if(stage.startsWith('trace'))fake.context.newCDPSession=()=>stage==='trace-session'?gate.promise:Promise.resolve({send:()=>gate.promise,detach:async()=>{}});
    });
    const tracing=stage.startsWith('trace');
    const pending=diagnostics.run(tracing?'chromium':'firefox',{...options,inputDiagnostics:tracing?{traceInput:true}:null},async()=>executed++).then(()=>null,error=>error);
    await clock.flush();await clock.advance(30000);
    const error=await pending;assert.match(error.message,/bootstrap deadline/,stage);
    const before=read(diagnostics,tracing?'chromium.json':'firefox.json');
    assert.equal(before.status,'failed');assert.equal(before.timeoutScope,'bootstrap');assert.equal(executed,0);
    const late=stage==='launch'?fake.browser:stage==='context'?fake.context:stage==='page'?fake.page:stage==='trace-session'?{detach:async()=>clock.calls.push('trace-detach')}:{};
    gate.resolve(late);await clock.flush();
    const after=read(diagnostics,tracing?'chromium.json':'firefox.json');
    assert.deepEqual(after.error,before.error,'Late completion cannot replace original failure');
    assert.equal(after.scenarioStartedMs,null);assert.equal(executed,0);
    if(stage==='launch')assert(fake.browser.closed);
    if(stage==='context')assert(fake.context.closed);
    if(stage==='page')assert(fake.page.closed);
    if(stage==='trace-session')assert(clock.calls.includes('trace-detach'));
    assert.equal(clock.pending().length,0,stage);
  }
});

test('scenario late execute or final identity completion remains failed before delayed timers fire', async () => {
  for(const stage of ['execute','final-identity']) {
    let evaluations=0;
    const {diagnostics,clock}=clockedDiagnostics('late-'+stage,({fake,clock})=>{
      const identity=fake.page.evaluate;
      fake.page.evaluate=async()=>{if(++evaluations===2&&stage==='final-identity')clock.elapse(1000);return identity();};
    });
    await assert.rejects(diagnostics.run('firefox',options,async()=>{
      if(stage==='execute')clock.elapse(1000);
    }),/browser deadline/);
    const record=read(diagnostics);assert.equal(record.timeoutScope,'scenario');assert.equal(record.scenarioDurationMs,1000);
    assert.equal(record.scenarioCompletedMs,null);
    if(stage==='execute')assert.equal(evaluations,1,'No final identity after overdue execute');
  }
  const {diagnostics,clock}=clockedDiagnostics('late-final-check');
  await assert.rejects(diagnostics.run('chromium',{...options,launch:{headless:true,args:['--use-angle=swiftshader']}},async({record})=>{
    Object.defineProperty(record,'gpu',{get(){clock.elapse(1000);return {renderer:'SwiftShader'};},configurable:true});
  }),/browser deadline/);
  assert.equal(read(diagnostics,'chromium.json').timeoutScope,'scenario');
});

test('a never-resolving launch retains the absolute hard process cap', async () => {
  const {diagnostics,clock}=clockedDiagnostics('hard-launch',({playwright})=>{playwright.firefox.launch=()=>new Promise(()=>{});});
  const pending=diagnostics.run('firefox',options,async()=>assert.fail('Must not enter app')).catch(error=>error);
  await clock.flush();await clock.advance(30000);assert.match((await pending).message,/bootstrap/);
  assert(clock.pending().includes(66000));await clock.advance(35999);assert.deepEqual(clock.exits,[]);
  await clock.advance(1);assert.deepEqual(clock.exits,[1]);assert.equal(read(diagnostics).hardDeadlineExceeded,true);
});


test('failed late bootstrap cleanup retains the hard cap and original timeout', async () => {
  for(const stage of ['launch','context','page','trace-session']) {
    for(const hangs of [false,true]) {
      const gate=deferred();let executed=0;
      const {diagnostics,clock}=clockedDiagnostics(`late-close-${stage}-${hangs}`,({fake,playwright})=>{
        if(stage==='launch')playwright.firefox.launch=()=>gate.promise;
        if(stage==='context')fake.browser.newContext=()=>gate.promise;
        if(stage==='page')fake.context.newPage=()=>gate.promise;
        if(stage==='trace-session')fake.context.newCDPSession=()=>gate.promise;
      });
      const trace=stage==='trace-session',engine=trace?'chromium':'firefox';
      const pending=diagnostics.run(engine,{...options,inputDiagnostics:trace?{traceInput:true}:null},async()=>executed++).catch(error=>error);
      await clock.flush();await clock.advance(30000);
      assert.match((await pending).message,/bootstrap deadline/);
      const original=read(diagnostics,`${engine}.json`).error;
      const close=()=>hangs?new Promise(()=>{}):Promise.reject(Error('synthetic late cleanup failure'));
      gate.resolve(trace?{detach:close}:{close});await clock.flush();
      if(hangs)await clock.advance(stage==='launch'?15000:trace?1000:5000);
      const record=read(diagnostics,`${engine}.json`);
      assert.deepEqual(record.error,original);assert.equal(record.cleanupErrors.length,1);
      assert.equal(executed,0);assert.equal(record.scenarioStartedMs,null);
      const hard=trace?77000:66000;
      assert.deepEqual(clock.pending(),[hard]);await clock.advance(hard-clock.now());
      assert.deepEqual(clock.exits,[1]);assert.equal(read(diagnostics,`${engine}.json`).hardDeadlineExceeded,true);
    }
  }
});

test('viewer and planner phases and cycles cannot renew the scenario deadline', async () => {
  for(const deadlineMs of [120000,180000]) {
    const {diagnostics,clock}=clockedDiagnostics(`aggregate-scenario-${deadlineMs}`,({clock,playwright,fake})=>{
      playwright.firefox.launch=async()=>{clock.elapse(12000);return fake.browser;};
    });
    await assert.rejects(diagnostics.run('firefox',{...options,deadlineMs},async({phases})=>{
      for(let cycle=0;cycle<2;cycle++) {
        phases.start('viewer-load',{cycle});clock.elapse(deadlineMs/4);
        phases.start('state-changes',{cycle});clock.elapse(deadlineMs/4);
      }
      phases.start('recovery');
    }),/browser deadline/);
    const record=read(diagnostics);
    assert.equal(record.deadlineScope.scenarioMs,deadlineMs);
    assert.equal(record.deadlineScope.hardProcessMs,deadlineMs+65000);
    assert.equal(record.bootstrapDurationMs,12000);assert.equal(record.scenarioStartedMs,12000);
    assert.equal(record.scenarioDurationMs,deadlineMs);assert.equal(record.scenarioCompletedMs,null);
    assert.equal(record.timeoutScope,'scenario');assert.equal(record.timeoutPhase.elapsedMs,12000+deadlineMs);
    assert.equal(record.timeoutPhase.activePhase.name,'recovery');assert.equal(clock.pending().length,0);
  }
});

test('successful final completion and phase timestamps share the case clock', async () => {
  const {diagnostics,clock}=clockedDiagnostics('completion-clock',({fake,clock,playwright})=>{
    playwright.firefox.launch=async()=>{clock.elapse(500);return fake.browser;};
  });
  const record=await diagnostics.run('firefox',options,async({phases})=>{
    clock.elapse(200);phases.start('final-checks');clock.elapse(100);
  });
  assert.equal(record.bootstrapDurationMs,500);assert.equal(record.scenarioStartedMs,500);
  assert.equal(record.scenarioDurationMs,300);assert.equal(record.scenarioCompletedMs,800);
  assert.equal(record.phases.find(phase=>phase.name==='test').startedMs,500);
  assert.equal(record.phases.at(-1).completedMs,800);assert.equal(record.timedOut,undefined);
});

test('invalid scenario budgets fail before module loading or application work', async () => {
  for(const deadlineMs of [0,-1,NaN,Infinity,1.5]) {
    const {diagnostics}=clockedDiagnostics('invalid-budget',settings=>{settings.load=()=>assert.fail('Do not load browser');});
    await assert.rejects(diagnostics.run('firefox',{...options,deadlineMs},async()=>assert.fail('Do not execute')),/positive integer/);
  }
});


test('bootstrap crossing its limit at the scenario handoff never starts execute', async () => {
  let executed=0;
  const {diagnostics}=clockedDiagnostics('handoff-boundary',({clock,fake})=>{
    fakeInputTrace(fake);
    const sessionFor=fake.context.newCDPSession;
    fake.context.newCDPSession=async()=>{
      const session=await sessionFor(),send=session.send;
      session.send=async(method,...args)=>{
        const result=await send(method,...args);
        if(method==='Tracing.start') {
          clock.elapse(29999);let reads=0;
          clock.beforeRead=()=>{if(++reads===2){clock.elapse(1);clock.beforeRead=null;}};
        }
        return result;
      };
      return session;
    };
  });
  await assert.rejects(diagnostics.run('chromium',{...options,inputDiagnostics:{traceInput:true}},async()=>executed++),/bootstrap deadline/);
  const record=read(diagnostics,'chromium.json');
  assert.equal(executed,0);assert.equal(record.bootstrapDurationMs,30000);
  assert.equal(record.timeoutScope,'bootstrap');assert.equal(record.scenarioStartedMs,null);
  assert.equal(record.deadlineScope.hardProcessMs,77000);
  assert.equal(record.inputTrace.status,'saved');assert.deepEqual(record.diagnosticsErrors,[]);
});

test('post-restoration UI transitions use the existing handlers without synthetic frames or pointer credit', () => {
  const {changeRestoredViewerMode} = require('./browser-stability-diagnostics.cjs');
  const events=[], state={homeMode:true}, cutaway={checked:false,dispatchEvent(event){events.push(['cutaway',this.checked,event.type]);}};
  const nodes={'#editLayout':{click(){events.push(['editor']);state.homeMode=false;}},
    '#openHome':{click(){events.push(['home']);state.homeMode=true;}},'#cutaway':cutaway};
  const env={window:{floorplan:state},document:{querySelector:key=>nodes[key]},Event:class{constructor(type){this.type=type;}}};
  vm.runInNewContext('globalThis.change='+changeRestoredViewerMode.toString(),env);
  for(const mode of ['editor-cutaway','editor-full','home'])env.change(mode);
  assert.deepEqual(events,[['editor'],['cutaway',true,'change'],['cutaway',false,'change'],['home']]);
  assert.throws(()=>env.change('unknown'),/Unknown restored/);
});

test('post-restoration snapshots retain GL errors and reject stale frames, wrong modes and lost lighting', () => {
  const {captureRestoredViewerMode,assertRestoredViewerMode}=require('./browser-stability-diagnostics.cjs');
  let errors=[1282,0], lost=false, reads=0;
  const gl={NO_ERROR:0,isContextLost:()=>lost,getError:()=>{reads++;return errors.shift()??0;}};
  const scene={pointLights:18,activePointLights:18,drawingBuffer:[632,394],renderPasses:{last:'scene',sceneViewport:[0,0,632,394]}};
  const env={window:{__browserStability:{contexts:1,contextLosses:1,errors:[],shaderErrors:[]},floorplan:{homeMode:true,renderCount:4},__browserRenderedLights:18,__browserScene:()=>scene},
    document:{querySelector:key=>key==='#cutaway'?{checked:false}:{getContext:()=>gl}}};
  vm.runInNewContext('globalThis.capture='+captureRestoredViewerMode.toString(),env);
  const captured=JSON.parse(JSON.stringify(env.capture()));
  assert.deepEqual(captured.glErrors,[1282]);assert.equal(reads,2);
  assert.throws(()=>assertRestoredViewerMode(3,captured,'home',18),/GL errors/);
  errors=[0];const valid=JSON.parse(JSON.stringify(env.capture()));
  assertRestoredViewerMode(3,valid,'home',18);
  for(const patch of [{renderCount:3},{homeMode:false},{contexts:2},{contextLosses:2},{contextLost:true},{errors:['error']},{shaderErrors:['link']}])
    assert.throws(()=>assertRestoredViewerMode(3,{...valid,...patch},'home',18));
  for(const patch of [{pointLights:17},{activePointLights:17},{renderPasses:{last:'copy',sceneViewport:[0,0,632,394]}},{drawingBuffer:[631,394]}])
    assert.throws(()=>assertRestoredViewerMode(3,{...valid,scene:{...valid.scene,...patch}},'home',18));
  assert.throws(()=>assertRestoredViewerMode(3,{...valid,renderedLights:17},'home',18));
  assertRestoredViewerMode(3,{...valid,homeMode:false,cutaway:true},'editor-cutaway',18);
  assert.throws(()=>assertRestoredViewerMode(3,{...valid,homeMode:false,cutaway:false},'editor-cutaway',18));
  assertRestoredViewerMode(3,{...valid,homeMode:false,cutaway:false},'editor-full',18);
  lost=true;const prior=reads;assert.equal(env.capture().contextLost,true);assert.equal(reads,prior,'Lost context is never drained');
  lost=false;errors=Array(32).fill(1282);assert.throws(()=>env.capture(),/queue did not drain/);
});

test('post-restoration cases keep deadlines and preserve pending transition receipts on failure', async () => {
  const source=fs.readFileSync(path.join(__dirname,'test-browser-stability.cjs'),'utf8');
  const start=source.indexOf('        sample.postRestoreViews = [];'),end=source.indexOf("\n      }\n      phases.start('input-receipt'",start);
  assert(start>0&&end>start);
  const code=source.slice(start,end);
  assert(!/waitForTimeout|screenshot|timeout\s*:|renderModel|requestAnimationFrame/.test(code));
  let fail=false,calls=[],count=3,now=100;
  const sample={}, env={sample,cycle:1,started:50,lights:18,Date:{now:()=>++now},
    phases:{start:name=>calls.push(name)},snapshot:async()=>({renderCount:count}),save:()=>{},
    changeRestoredViewerMode:()=>{},captureRestoredViewerMode:()=>{},
    child:{evaluate:async(fn,mode)=>{if(mode){count++;return;}return {renderCount:count};},
      waitForFunction:async()=>{if(fail)throw Error('primary transition failure');}},
    assertRestoredViewerMode:()=>{}};
  await vm.runInNewContext('(async()=>{'+code+'})()',env);
  assert.deepEqual(Array.from(sample.postRestoreViews,row=>row.mode),['editor-cutaway','editor-full','home']);
  assert(sample.postRestoreViews.every(row=>row.durationMs>=0&&row.snapshot&&row.completed===true));
  fail=true;await assert.rejects(vm.runInNewContext('(async()=>{'+code+'})()',env),/primary transition failure/);
  assert.equal(sample.postRestoreViews.length,1);assert(sample.postRestoreViews[0].durationMs>=0);
  assert.equal(sample.postRestoreViews[0].snapshot,undefined);
  assert.equal(sample.postRestoreViews[0].completed,false);
  fail=false;env.assertRestoredViewerMode=()=>{throw Error('restored graphics failure');};
  await assert.rejects(vm.runInNewContext('(async()=>{'+code+'})()',env),/restored graphics failure/);
  assert.equal(sample.postRestoreViews[0].completed,false,'A captured but rejected frame cannot receive completion credit');
});


test('cold viewer load has one60s monotonic clock and immutable successful completion time', async () => {
  const {diagnostics,clock}=clockedDiagnostics('viewer');
  let sample;
  const result=await diagnostics.run('firefox',{...options,deadlineMs:120000},async({createViewerLoad,record})=>{
    sample={cycle:0};record.samples.push(sample);const load=createViewerLoad(sample);
    try {
      await load.run(()=>clock.elapse(20000));assert.equal(load.remainingMs(),40000);
      await load.run(()=>clock.elapse(20000));assert.equal(load.remainingMs(),20000);
      await load.run(()=>clock.elapse(19999));load.complete();
      clock.elapse(1000);
    } finally {load.close();}
  });
  assert.equal(result.status,'passed');assert.equal(result.loadBudgetMs,60000);
  assert.equal(sample.loadBudgetMs,60000);assert.equal(sample.loadMs,59999);assert.equal(sample.loadCompleted,true);
  assert.equal(result.deadlineScope.scenarioMs,120000);assert.equal(clock.pending().length,0);
});

test('cold viewer rejects exact boundary and late true before overdue timer delivery', async () => {
  for (const elapsed of [60000,60001]) {
    const {diagnostics,clock}=clockedDiagnostics('viewer');let sample,next=false;
    await assert.rejects(diagnostics.run('firefox',{...options,deadlineMs:120000},async({createViewerLoad,record})=>{
      sample={cycle:0};record.samples.push(sample);const load=createViewerLoad(sample);
      try {await load.run(()=>{clock.elapse(elapsed);return true;});next=true;load.complete();}
      finally {load.close();}
    }),/cold load/);
    assert.equal(next,false);assert.equal(sample.loadCompleted,false);assert.equal(sample.loadMs,elapsed);
    assert.equal(read(diagnostics).status,'failed');assert.equal(clock.pending().length,0);
  }
});

test('cold viewer timeout rearms an early timer and rejects a hanging operation', async () => {
  const {clock,createViewerLoadDeadline}=clockedDiagnostics('cold-direct');
  const sample={};const load=createViewerLoadDeadline(sample,120000,()=>{});
  const pending=load.run(()=>new Promise(()=>{})).catch(error=>error);await clock.flush();
  clock.elapse(59999.5);clock.fireEarly(60000);await clock.flush();
  assert(clock.pending().some(time=>time>=60000));
  await clock.advance(1);
  assert.match((await pending).message,/cold load/);load.close();
  assert.equal(sample.loadCompleted,false);assert.equal(clock.pending().length,0);
});

test('cold stages and second cycle never renew the enclosing180s scenario', async () => {
  const {diagnostics,clock}=clockedDiagnostics('viewer');const samples=[];
  await assert.rejects(diagnostics.run('firefox',{...options,deadlineMs:180000},async({createViewerLoad,record})=>{
    for(let cycle=0;cycle<2;cycle++) {
      const sample={cycle};samples.push(sample);record.samples.push(sample);const load=createViewerLoad(sample);
      try {
        assert.equal(load.remainingMs(),cycle===0?60000:50000);
        await load.run(()=>clock.elapse(50000));load.complete();
      } finally {load.close();}
      if(cycle===0)clock.elapse(80000);
    }
  }),/180-second browser deadline/);
  assert.equal(samples[0].loadCompleted,true);assert.equal(samples[1].loadCompleted,false);assert.equal(samples[1].loadTimedOut,true);
  assert.equal(read(diagnostics).timeoutScope,'scenario');assert.equal(read(diagnostics).deadlineScope.scenarioMs,180000);
});

test('cold viewer uses remaining operation waits while all ordinary defaults stay30s', () => {
  const source=fs.readFileSync(path.join(__dirname,'test-browser-stability.cjs'),'utf8');
  assert.equal((source.match(/timeout: load.remainingMs\(\)/g)||[]).length,2);
  assert(source.includes('load.run(() => page.evaluate('));
  assert(source.includes('load.run(() => page.locator('));
  assert(source.includes('loadMs<sample.loadBudgetMs && dragMs<15000 && editorDragMs<15000'));
  assert(source.includes('reportOnly, deadlineMs: 180000'));
  const shared=fs.readFileSync(path.join(__dirname,'browser-stability-diagnostics.cjs'),'utf8');
  assert(shared.includes('page.setDefaultTimeout(30000)'));
  assert(shared.includes('bootstrapMs = 30000'));
});

test('the actual viewer driver forwards180s uniformly for every engine, profile and fixture size', async () => {
  const source=fs.readFileSync(path.join(__dirname,'test-browser-stability.cjs'),'utf8');
  const start=source.indexOf('async function run(browserName,'),end=source.indexOf('\n(async () => {',start);
  assert(start>0&&end>start);
  const calls=[],env={browserProfile,viewerInputOptions,browserLaunchOptions,reportOnly:false,
    sourceFiles:{},sourceHashScope:'instrumented-compiled-viewer',process,
    diagnostics:{run:async(engine,options)=>{calls.push({engine,...options});}}};
  vm.runInNewContext(source.slice(start,end)+'\nglobalThis.runViewer=run;',env);
  const previous=process.env.HOME_STUDIO_BROWSER_PROFILE;
  try {
    for(const profile of ['desktop','phone','tablet']) {
      process.env.HOME_STUDIO_BROWSER_PROFILE=profile;
      for(const engine of ['chromium','firefox','webkit'])for(const rooms of [6,24]) {
        await env.runViewer(engine,'http://127.0.0.1',
          {floors:[{rooms:Array(rooms),items:Array(rooms*3)}]},'fixture-source');
        const call=calls.at(-1);
        assert.equal(call.deadlineMs,180000);assert.equal(call.profile.name,profile);
        assert.equal(call.fixture.rooms,rooms);assert.equal(call.reportOnly,false);
      }
    }
  } finally {
    if(previous===undefined)delete process.env.HOME_STUDIO_BROWSER_PROFILE;
    else process.env.HOME_STUDIO_BROWSER_PROFILE=previous;
  }
  assert.equal(calls.length,18);
  assert.match(source,/if \(!reportOnly\) assertViewerScenarioComplete\(record\);/);
  assert(source.indexOf('sample.completed = true;')>source.indexOf('The dashboard remains responsive after closing the floorplan'));
});

function completeViewerRecord() {
  const samples=[0,1].map(cycle=>({cycle,completed:true,loadCompleted:true,loadBudgetMs:60000,
    loadMs:59999,dragMs:14999,editorDragMs:14999,burst:{settled:{waitMs:9999}},detachMs:10}));
  samples[1].recovery={contextLosses:1,before:20,after:21};
  samples[1].postRestoreViews=['editor-cutaway','editor-full','home'].map(mode=>({mode,completed:true,snapshot:{},durationMs:1}));
  return {samples};
}

test('viewer completion rejects incomplete cycles, recovery, individual limits and late progress', () => {
  const {assertViewerScenarioComplete}=require('./browser-stability-diagnostics.cjs');
  const record=completeViewerRecord();assertViewerScenarioComplete(record);
  assert.deepEqual(record.viewerCompletion,{version:1,cycles:2,postRestoreModes:['editor-cutaway','editor-full','home']});
  const mutations=[
    r=>r.samples.pop(),r=>r.samples.push({...r.samples[1]}),r=>r.samples.reverse(),
    r=>r.samples[1].cycle=0,r=>r.samples[0].completed=false,r=>delete r.samples[1].completed,
    r=>r.samples[0].loadCompleted=false,r=>r.samples[0].loadBudgetMs=60001,
    r=>r.samples[0].loadMs=60000,r=>r.samples[0].dragMs=15000,r=>r.samples[1].editorDragMs=15000,
    r=>r.samples[1].burst.settled.waitMs=10000,r=>r.samples[0].dragMs=NaN,r=>r.samples[0].detachMs=-1,
    r=>delete r.samples[1].recovery,r=>r.samples[1].recovery.after=20,r=>r.samples[1].recovery.contextLosses=2,
    r=>delete r.samples[1].postRestoreViews,r=>r.samples[1].postRestoreViews.reverse(),
    r=>r.samples[1].postRestoreViews.pop(),r=>r.samples[1].postRestoreViews[0].completed=false,
    r=>delete r.samples[1].postRestoreViews[2].snapshot,r=>r.samples[1].postRestoreViews[1].durationMs=null,
    r=>r.timedOut=true,
  ];
  for(const mutate of mutations) {
    const invalid=completeViewerRecord();mutate(invalid);
    assert.throws(()=>assertViewerScenarioComplete(invalid));
    assert.equal(invalid.viewerCompletion,undefined,'Rejected progress cannot produce a completion marker');
  }
});

test('the180s viewer admits only timely final identity and retains the245s hard envelope', async () => {
  for(const elapsed of [179999,180000,180001])for(const finalIdentity of [false,true]) {
    const {diagnostics,clock}=clockedDiagnostics(`viewer180-${elapsed}-${finalIdentity}`,({fake,clock,playwright})=>{
      playwright.firefox.launch=async()=>{clock.elapse(29999);return fake.browser;};
      const identity=fake.page.evaluate;let identities=0;
      fake.page.evaluate=async()=>{if(++identities===2&&finalIdentity)clock.elapse(elapsed);return identity();};
    });
    const pending=diagnostics.run('firefox',{...options,deadlineMs:180000},async({record})=>{
      Object.assign(record,completeViewerRecord());
      require('./browser-stability-diagnostics.cjs').assertViewerScenarioComplete(record);
      if(!finalIdentity)clock.elapse(elapsed);
    });
    if(elapsed<180000)await pending;
    else await assert.rejects(pending,/180-second browser deadline/);
    const record=read(diagnostics);
    assert.equal(record.deadlineScope.bootstrapMs,30000);assert.equal(record.deadlineScope.scenarioMs,180000);
    assert.equal(record.deadlineScope.hardProcessMs,245000);assert.equal(record.bootstrapDurationMs,29999);
    assert.equal(record.status,elapsed<180000?'passed':'failed');
    assert.equal(record.scenarioCompletedMs,elapsed<180000?29999+elapsed:null);
    assert.equal(record.timeoutScope,elapsed<180000?undefined:'scenario');
    assert.equal(clock.pending().length,0);
  }
});

test('a stalled180s viewer still expires once and cannot gain time from phase progress', async () => {
  const {diagnostics,clock}=clockedDiagnostics('viewer180-stalled');
  let executions=0;
  const pending=diagnostics.run('firefox',{...options,deadlineMs:180000},async({phases})=>{
    executions++;phases.start('viewer-load',{cycle:0});await new Promise(()=>{});
  }).catch(error=>error);
  await clock.flush();await clock.advance(179999);
  assert.equal(read(diagnostics).status,'running');
  await clock.advance(1);assert.match((await pending).message,/180-second browser deadline/);
  const record=read(diagnostics);
  assert.equal(executions,1);assert.equal(record.status,'failed');assert.equal(record.scenarioCompletedMs,null);
  assert.equal(record.timeoutPhase.activePhase.name,'viewer-load');assert.equal(clock.pending().length,0);
});

test('planner framing chooses visible canvas input without hiding floating controls', () => {
  const source=fs.readFileSync(path.join(__dirname,'test-planner-stability.cjs'),'utf8');
  const start=source.indexOf('function inspectWorldDrag('),end=source.indexOf('async function run(',start);
  assert(start>=0&&end>start);
  const box={x:64,y:196,width:326,height:490},map={x:-800,y:40,scale:60};
  const canvas={tagName:'CANVAS',id:'plan-canvas',getBoundingClientRect:()=>box};
  const toggle={tagName:'BUTTON',id:'floor-navigator-toggle'};
  const card={tagName:'BUTTON',id:'floor-card'};
  let covered=false;
  const document={getElementById:id=>id==='plan-canvas'?canvas:null,elementFromPoint(x,y){
    if(x<0||x>=390||y<0||y>=844||x<box.x||x>box.x+box.width||y<box.y||y>box.y+box.height)return null;
    if(covered)return toggle;
    if(x>=72&&x<=155&&y>=261&&y<=302)return toggle;
    if(x>=70&&x<=155&&y>=355&&y<=480)return card;
    return canvas;
  }};
  const context={document,innerWidth:390,innerHeight:844,
    window:{planner:{worldToScreen:point=>[map.x+point[0]*map.scale,map.y+point[1]*map.scale]}}};
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  const inspect=(from,to,touch=true)=>context.inspectWorldDrag({from,to,touch});
  let result,attempts=0;
  for(;attempts<30;attempts++) {
    result=inspect([1,1],[1.5,1]);
    if(result.action==='ready')break;
    assert.equal(result.action,'pan');
    assert.equal(document.elementFromPoint(result.start.x,result.start.y),canvas,'Only an actual canvas hit may begin a pan');
    assert(result.end.x>=79&&result.end.x<=375&&result.end.y>=211&&result.end.y<=671);
    map.x+=result.end.x-result.start.x;map.y+=result.end.y-result.start.y;
  }
  assert.equal(result.action,'ready');assert(attempts<10,'Offscreen metric points are reached with bounded real pans');
  for(const point of result.points)assert.equal(document.elementFromPoint(box.x+point[0],box.y+point[1]),canvas);

  map.x=20-map.scale;map.y=80-map.scale;
  result=inspect([1,1],[1.5,1]);
  assert.equal(result.endpointHits[0].id,'floor-navigator-toggle');
  assert.equal(result.action,'pan','An in-bounds endpoint under a control must be reframed');
  assert.equal(document.elementFromPoint(result.start.x,result.start.y),canvas);

  box.y=700;map.x=100-map.scale;map.y=200-map.scale;
  result=inspect([1,1],[1.5,1]);
  assert.equal(result.action,'pan','A point inside the bitmap but below the viewport is not visible');
  assert(result.start.y<=829&&result.end.y<=829,'Pan endpoints retain the viewport margin');
  map.x+=result.end.x-result.start.x;map.y+=result.end.y-result.start.y;
  assert.equal(inspect([1,1],[1.5,1]).action,'pan','Large offscreen distances can require more than one bounded pan');

  covered=true;result=inspect([1,1],[1.5,1]);
  assert.equal(result.action,'blocked');assert.match(result.reason,/No visible, unobstructed/);
  assert.equal(inspect([1,1],[1.01,1]).action,'zoom','The native-touch minimum distance remains 28 pixels');
  assert.equal(document.getElementById('plan-canvas'),canvas,'Measurement leaves controls and canvas intact');
});
