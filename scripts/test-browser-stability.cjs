// Real WebGL regression coverage. Uses fictional rooms and an isolated browser
// profile; the sandboxed iframe and MessageChannel mirror the HA panel contract.
// Install browsers: npx playwright install chromium firefox webkit
// Select engines: BROWSER_STABILITY_ENGINES=firefox,chromium node scripts/test-browser-stability.cjs
// Compare a checkout: HOME_STUDIO_SOURCE_ROOT=/path/to/checkout node scripts/test-browser-stability.cjs
// Default: six rooms / eighteen lights. BROWSER_STABILITY_ROOMS supports 1–24 rooms.
// BROWSER_STABILITY_LIGHTS_PER_ROOM supports 1–16 fictional lights per room.
// HOME_STUDIO_DIAGNOSTICS_DIR (or BROWSER_STABILITY_DIAGNOSTICS_DIR) keeps JSON/failure PNGs.
// BROWSER_STABILITY_REPORT_ONLY=1 records failing baselines without gating on assertions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {changeRestoredViewerMode, captureRestoredViewerMode, assertRestoredViewerMode, assertViewerScenarioComplete, createDiagnostics, positiveInteger, selectedEngines, browserLaunchOptions, browserProfile, createInputDriver, viewerInputOptions, captureViewerFrames, assertViewerInteraction} = require('./browser-stability-diagnostics.cjs');
const {createStartupDiagnostics} = require('./browser-startup-diagnostics.cjs');

const root = path.resolve(process.env.HOME_STUDIO_SOURCE_ROOT || path.join(__dirname, '..'));
const sourceFiles = Object.fromEntries(['viewer.js','home-view.js','room-lighting.js','planner/render-capacity.js','planner/interaction-render.js'].filter(name=>fs.existsSync(path.join(root,name))).map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex')]));
const sourceHashScope = 'instrumented-compiled-viewer';
const fixtureOnly = process.env.HOME_STUDIO_FIXTURE_ONLY === '1';
const startup = createStartupDiagnostics(fixtureOnly && process.env.HOME_STUDIO_STARTUP_DIAGNOSTICS_FILE);
const diagnostics = fixtureOnly ? null : createDiagnostics('viewer', 'BROWSER_STABILITY', root);
let temporary;
const reportOnly = process.env.BROWSER_STABILITY_REPORT_ONLY === '1';

function fixture() {
  const rooms = positiveInteger('BROWSER_STABILITY_ROOMS', 6, 24);
  const lightsPerRoom = positiveInteger('BROWSER_STABILITY_LIGHTS_PER_ROOM', 3, 16);
  const columns = Math.ceil(Math.sqrt(rooms * 1.5));
  const floor = { id: 'main', name: 'Fictional main floor', elevation_m: 0, height_m: 2.8, rooms: [], walls: [], openings: [], items: [] };
  const walls = new Map();
  for (let room = 0; room < rooms; room++) {
    const x = room % columns, z = Math.floor(room / columns);
    const id = `room_${x}_${z}`;
    floor.rooms.push({ id, name: `Room ${x + 1}/${z + 1}`, polygon: [[x*4,z*4],[(x+1)*4,z*4],[(x+1)*4,(z+1)*4],[x*4,(z+1)*4]], material: 'floor' });
    for (let n = 0; n < lightsPerRoom; n++) floor.items.push({ id: `${id}_light_${n}`, name: `Fictional light ${x}/${z}/${n}`, type: 'chandelier', room: id,
      position_m: { x:x*4+0.75+(n%4)*0.75, y:2.3, z:z*4+(n<4?2:0.75+Math.floor(n/4)*0.75) }, dimensions_m:{width:0.4,depth:0.4,height:0.25}, rotation_deg:0, entity_id:`light.${id}_${n}`, notes:'' });
    for (const edgeX of [x, x+1]) walls.set(`vertical_${edgeX}_${z}`, {id:`vertical_${edgeX}_${z}`,start:[edgeX*4,z*4],end:[edgeX*4,(z+1)*4],thickness_m:0.16});
    for (const edgeZ of [z, z+1]) walls.set(`horizontal_${edgeZ}_${x}`, {id:`horizontal_${edgeZ}_${x}`,start:[x*4,edgeZ*4],end:[(x+1)*4,edgeZ*4],thickness_m:0.16});
    if (z===0) floor.openings.push({id:`window_${x}`,wall_id:`horizontal_0_${x}`,type:'window',offset_m:1,width_m:1.6,sill_m:0.9,head_m:2.2});
  }
  floor.walls = [...walls.values()];
  return { schema_version:1, id:'browser_stability', title:'Fictional browser stability fixture', floors:[floor] };
}

function instrumentation() {
  const stats = window.__browserStability = { shaderErrors:[], errors:[], linkedPrograms:0, contexts:0, contextLosses:0 };
  window.addEventListener('error', event=>stats.errors.push(event.message || String(event.error)));
  window.addEventListener('unhandledrejection', event=>stats.errors.push(String(event.reason)));
  const logError = console.error.bind(console);
  console.error = (...args) => {stats.errors.push(args.map(value=>value?.message || String(value)).join(' '));logError(...args);};
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (...args) {
    const gl = original.apply(this, args);
    if (!gl || !String(args[0]).startsWith('webgl') || gl.__stabilityInstrumented) return gl;
    gl.__stabilityInstrumented = true;
    stats.contexts++;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    stats.gpu = {version:gl.getParameter(gl.VERSION),renderer:gl.getParameter(gl.RENDERER),
      unmaskedRenderer:debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,textureUnits:gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),maxTextureSize:gl.getParameter(gl.MAX_TEXTURE_SIZE)};
    console.info('[home-studio-test-gpu]' + JSON.stringify(stats.gpu));
    this.addEventListener('webglcontextlost', () => stats.contextLosses++);
    const link = gl.linkProgram.bind(gl);
    gl.linkProgram = program => {
      link(program);stats.linkedPrograms++;
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) stats.shaderErrors.push(gl.getProgramInfoLog(program));
    };
    return gl;
  };
}

async function run(browserName, origin, project, sourceHash) {
  const profile = browserProfile(browserName, {viewport: {width: 1280, height: 800}});
  const inputDiagnostics = viewerInputOptions(browserName, profile);
  return diagnostics.run(browserName, {
    reportOnly, deadlineMs: 180000, sourceHash, sourceFiles, sourceHashScope,
    fixture: {floors: 1, rooms: project.floors[0].rooms.length, lights: project.floors[0].items.length},
    launch: browserLaunchOptions(browserName, process.env.BROWSER_STABILITY_HEADED !== '1'),
    context: profile.context, profile, inputDiagnostics,
  }, async ({browser, page, record, check, save, phases, createViewerLoad}) => {
  const {samples, errors, crashes, consoleErrors} = record;
  phases.start('input-setup');
  const input = await createInputDriver(page, browserName, profile, inputDiagnostics);
  const dragCanvas = async (locator, child) => {
    await locator.scrollIntoViewIfNeeded();
    const bounds = await locator.boundingBox();
    const point = await locator.evaluate(canvas => {
      const rect = canvas.getBoundingClientRect();
      for(const y of [.18,.35,.6,.8])for(const x of [.12,.25,.5,.8]) {
        if(document.elementFromPoint(rect.x+rect.width*x,rect.y+rect.height*y)===canvas)return {x,y};
      }
      throw Error('No exposed canvas pixel is available for a real drag');
    });
    const started = Date.now();
    const phases = await input.drag({x: bounds.x+bounds.width*point.x, y: bounds.y+bounds.height*point.y},
      {x: bounds.x+bounds.width*(point.x+.15), y: bounds.y+bounds.height*(point.y+.1)});
    const framesStarted = Date.now();
    await child.evaluate(() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const completed = Date.now();
    return {durationMs:completed-started,phases:{...phases,framesMs:completed-framesStarted}};
  };
    phases.start('dashboard-navigation');
    await page.goto(origin);
    const states = Object.fromEntries(project.floors[0].items.map(item => [item.entity_id,{state:'on',name:item.name,light:{brightness:180,color_mode:'color_temp',color_temp_kelvin:3000}}]));
    states['sun.sun'] = {state:'above_horizon',elevation:30};
    for (let cycle = 0; cycle < 2; cycle++) {
      console.log(`${browserName} ${browser.version()}: loading fictional dashboard, cycle ${cycle + 1}`);
      phases.start('viewer-load', {cycle});
      const started = Date.now();
      const sample = {cycle, completed:false}; samples.push(sample);
      const load = createViewerLoad(sample);
      let frame, child;
      try {
        await load.run(() => page.evaluate(async ({items,states,height}) => {
          const html = await (await fetch('/viewer')).text();
          const iframe = document.createElement('iframe');
          iframe.id = 'viewer';iframe.sandbox = 'allow-scripts allow-downloads allow-forms';
          iframe.style.cssText = `width:100%;height:${height}px;border:0`;
          iframe.onload = () => {
            const channel = new MessageChannel();window.viewerPort = channel.port1;window.viewerCommands=[];
            channel.port1.onmessage = event => {
              if(event.data.type==='model_config') channel.port1.postMessage({type:'states',connected:true,states});
              if(['toggle','tv_power','curtain_command','media_command','more_info'].includes(event.data.type)) window.viewerCommands.push(event.data);
            };
            iframe.contentWindow.postMessage({type:'home-floorplan:init',can_edit:true,items,preferences:{}},'*',[channel.port2]);
          };
          iframe.srcdoc = html;document.body.append(iframe);
        }, {items:project.floors[0].items,states,height:profile.emulated?profile.context.viewport.height-60:740}));
        await load.run(() => page.waitForFunction(() => document.querySelector('#viewer'), null, {timeout: load.remainingMs()}));
        frame = await load.run(() => page.locator('#viewer').contentFrame());
        // FrameLocator supports locators, but evaluate uses the actual child Frame.
        child = page.frames().find(value => value !== page.mainFrame());
        await load.run(() => child.waitForFunction(expected => window.floorplan?.renderCount > 0 && document.querySelector('#homeConnection')?.dataset.connected === 'true' && window.__browserRenderedLights === expected, project.floors[0].items.length, {timeout: load.remainingMs()}));
        load.complete();
      } finally { load.close(); save(); }
      const loadMs = sample.loadMs;
      phases.start('initial-checks', {cycle});
      console.log(`${browserName}: first connected draw in ${sample.loadMs} ms`);
      const snapshot = () => child.evaluate(() => ({...window.__browserStability,renderedLights:window.__browserRenderedLights,renderCount:window.floorplan.renderCount,homeMode:window.floorplan.homeMode,scene:window.__browserScene?.()}));
      let initial = await snapshot();
      record.gpu = initial.gpu;
      Object.assign(sample, initial);
      save();
      sample.initialPrograms = initial.linkedPrograms;
      check(initial.contexts===1, 'One WebGL context is created per viewer');
      check(initial.shaderErrors.length===0, 'All actual WebGL programs link successfully');
      check(initial.scene.pointLights===project.floors[0].items.length, 'Every fixture retains a shader light slot');
      check(initial.scene.activePointLights===project.floors[0].items.length, 'Every active fixture still contributes illumination');
      const software = /swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render|lavapipe|^Apple Software Renderer$/i.test(initial.gpu.unmaskedRenderer || '');
      check(initial.scene.drawingBuffer[0]*initial.scene.drawingBuffer[1]<=(software?250000:2000000), 'The actual drawing buffer respects the detected graphics budget');
      const pointShadows = initial.scene.shadowMaps.filter(([type]) => type==='PointLight');
      const expectedShadows = Math.max(0,Math.min(project.floors[0].items.length,software?2:8,initial.gpu.textureUnits-4));
      check(pointShadows.length===expectedShadows, 'Point shadows respect the graphics profile and available samplers');
      check(pointShadows.every(([,width,height]) => width<=(software?128:512) && height<=(software?128:512)), 'Point shadow faces respect the graphics profile');
      const sunShadow = initial.scene.shadowMaps.find(([type]) => type==='DirectionalLight');
      check(sunShadow && sunShadow[1]===(software?512:2048) && sunShadow[2]===(software?512:2048), 'The sun shadow respects the graphics profile');
      phases.start('home-idle', {cycle});
      await page.waitForTimeout(200);
      const idleBefore = (await snapshot()).renderCount;
      await page.waitForTimeout(350);
      check((await snapshot()).renderCount===idleBefore, 'An idle Home view does not continuously render');
      phases.start('home-drag', {cycle});
      const canvas = frame.locator('#homeStage canvas');
      const homeCameraBefore = (await snapshot()).scene.camera;
      const homeDrag = await dragCanvas(canvas,child), dragMs = homeDrag.durationMs;
      sample.homeDragPhases = homeDrag.phases;
      sample.dragMs = dragMs;
      sample.readyAfterDragMs = Date.now()-started;
      console.log(`${browserName}: Home drag and frame completion in ${dragMs} ms`);
      const afterHomeDrag = await snapshot();
      sample.homeInteraction = afterHomeDrag.scene.renderPasses;
      assertViewerInteraction(initial, afterHomeDrag);
      sample.homeCameraChanged = Boolean(homeCameraBefore && afterHomeDrag.scene.camera &&
        JSON.stringify(homeCameraBefore) !== JSON.stringify(afterHomeDrag.scene.camera));
      // Camera translation or an orthographic projection shift alone is only
      // panning. A Home orbit must change the rendered camera's rotation basis.
      const rotationIndices = [0,1,2,4,5,6,8,9,10];
      sample.homeCameraRotated = Boolean(homeCameraBefore?.world && afterHomeDrag.scene.camera?.world &&
        rotationIndices.some(index => Math.abs(homeCameraBefore.world[index]-afterHomeDrag.scene.camera.world[index])>1e-7));
      sample.homeDragCommands = await page.evaluate(() => window.viewerCommands);
      save();
      check(afterHomeDrag.errors.length===0, `No rendering errors after Home drag: ${afterHomeDrag.errors.join('; ')}`);
      check(afterHomeDrag.renderCount>idleBefore, 'Dragging Home updates the rendered scene');
      check(sample.homeCameraChanged, 'Dragging Home changes the camera used to draw the scene');
      check(sample.homeCameraRotated, 'Dragging Home rotates the rendered camera, rather than only panning its projection');
      check(sample.homeDragCommands.length===0, 'A real Home orbit never issues a device command or opens native details');
      await page.waitForTimeout(200);
      const orbitIdle = await snapshot();
      await page.waitForTimeout(350);
      const orbitSettled = await snapshot();
      check(orbitSettled.renderCount===orbitIdle.renderCount, 'A released Home orbit returns to idle without continuous rendering');
      check(JSON.stringify(orbitSettled.scene.camera)===JSON.stringify(afterHomeDrag.scene.camera),
        'The orbited Home view remains at its released camera position');
      phases.start('editor-enter', {cycle});
      await input.tap(frame.locator('#editLayout'));
      await child.waitForFunction(() => !window.floorplan.homeMode);
      // Exercise a burst of editor wheel events in a single task, as high-frequency
      // trackpad input must not perform an unbounded number of synchronous draws.
      phases.start('editor-settle-and-wheel', {cycle});
      const burst = await child.evaluate(async () => {
        const canvas = document.querySelector('#view3d canvas');
        const stage = document.querySelector('#view3d');
        const settleStarted = performance.now();
        let previous = null, stableSince = settleStarted, stableFrames = 0, settled = null;
        // Switching modes queues both a frame and ResizeObserver work. Keep
        // those draws outside the input baseline, without hiding a busy renderer.
        while (performance.now()-settleStarted < 10000) {
          await new Promise((resolve,reject) => {
            const timer = setTimeout(() => {
              cancelAnimationFrame(frame);
              reject(new Error(`Editor frames stopped before wheel measurement: ${previous}`));
            }, Math.max(1,10000-(performance.now()-settleStarted)));
            const frame = requestAnimationFrame(() => {clearTimeout(timer);resolve();});
          });
          const now = performance.now(), viewport = stage.getBoundingClientRect();
          if (now-settleStarted >= 10000) break;
          const canvasBounds = canvas.getBoundingClientRect(), scene = window.__browserScene();
          const state = {
            homeMode: window.floorplan.homeMode, renderCount: window.floorplan.renderCount,
            viewport: [viewport.width,viewport.height], canvas: [canvasBounds.width,canvasBounds.height],
            drawingBuffer: [canvas.width,canvas.height], pixelRatio: scene.pixelRatio,
          };
          const sized = !state.homeMode && viewport.width > 0 && viewport.height > 0 &&
            canvas.width === Math.floor(viewport.width*scene.pixelRatio) &&
            canvas.height === Math.floor(viewport.height*scene.pixelRatio);
          const key = JSON.stringify(state);
          if (sized && key === previous) stableFrames++;
          else { stableFrames = 1; stableSince = now; }
          previous = key;
          if (sized && stableFrames >= 3 && now-stableSince >= 150) {
            settled = {...state,waitMs:now-settleStarted,stableFrames};
            break;
          }
        }
        if (!settled) throw new Error(`Editor did not settle before wheel measurement: ${previous}`);
        const before = window.floorplan.renderCount;
        for(let i=0;i<40;i++)canvas.dispatchEvent(new WheelEvent('wheel',{deltaY:1,cancelable:true,bubbles:true}));
        const synchronousDraws = window.floorplan.renderCount-before;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const bounds = selector => {
          const rect = document.querySelector(selector).getBoundingClientRect();
          return {top:rect.top,bottom:rect.bottom,height:rect.height};
        };
        const layout = {desktop:matchMedia('(min-width:851px)').matches,
          main:bounds('main'),stage:bounds('main > .stage'),view:bounds('#view3d'),footer:bounds('.stage > .measure')};
        return {synchronousDraws,totalDraws:window.floorplan.renderCount-before,settled,layout};
      });
      sample.burst = burst;
      check(burst.synchronousDraws<=1 && burst.totalDraws>0 && burst.totalDraws<=2, 'Wheel bursts coalesce into at most one scheduled scene draw');
      if (burst.layout.desktop) {
        const {main,stage,view,footer} = burst.layout;
        check(stage.top>=main.top-1 && stage.bottom<=main.bottom+1 && view.bottom<=footer.top+1 && footer.bottom<=main.bottom+1,
          'Desktop Editor stage and footer stay inside the available grid height');
      }
      phases.start('editor-drag', {cycle});
      const beforeEditorDrag = await snapshot();
      const editorCameraBefore = beforeEditorDrag.scene.camera;
      const editorDrag = await dragCanvas(frame.locator('#view3d canvas'),child), editorDragMs = editorDrag.durationMs;
      sample.editorDragPhases = editorDrag.phases;
      sample.editorDragMs = editorDragMs;
      const afterEditorDrag = await snapshot();
      const editorCameraAfter = afterEditorDrag.scene.camera;
      sample.editorInteraction = afterEditorDrag.scene.renderPasses;
      assertViewerInteraction(beforeEditorDrag, afterEditorDrag);
      sample.editorCameraChanged = Boolean(editorCameraBefore && editorCameraAfter &&
        JSON.stringify(editorCameraBefore) !== JSON.stringify(editorCameraAfter));
      save();
      check(sample.editorCameraChanged, 'Dragging the editor changes the camera used to draw the scene');
      phases.start('home-enter', {cycle});
      await input.tap(frame.locator('#openHome'));
      await child.waitForFunction(() => window.floorplan.homeMode);
      await child.evaluate(() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      sample.statePrograms = [(await snapshot()).linkedPrograms];
      const lights = project.floors[0].items.length;
      const allOff = Object.fromEntries(Object.entries(states).map(([key,value])=>[key,{...value,state:'off'}]));
      const firstEntity = project.floors[0].items[0].entity_id;
      const oneOff = {...states,[firstEntity]:{...states[firstEntity],state:'off'}};
      for(const [next,onCount] of [[allOff,0],[oneOff,lights-1],[states,lights]]) {
        phases.start('light-state', {cycle, activeLights:onCount});
        await page.evaluate(states => window.viewerPort.postMessage({type:'states',connected:true,states}),next);
        await child.waitForFunction(expected => document.querySelectorAll('.home-marker[data-state="on"]').length===expected,onCount);
        await child.evaluate(() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const value = await snapshot();
        sample.statePrograms.push(value.linkedPrograms);
        check(value.scene.pointLights===lights, 'Light state changes retain stable shader slots');
        check(value.scene.activePointLights===onCount, 'Only lights whose live state is on contribute intensity');
        check(value.renderedLights===onCount, 'The queued frame has rendered the new light state');
      }
      phases.start('state-checks', {cycle});
      check(new Set(sample.statePrograms).size===1, 'All-off, partially lit and all-on states do not compile new programs');
      initial = await snapshot();
      check(initial.shaderErrors.length===0, 'Light changes and editor/Home transitions keep every shader linked');
      check(initial.contextLosses===0, 'No unexpected WebGL context loss');
      check(loadMs<sample.loadBudgetMs && dragMs<15000 && editorDragMs<15000, `Load and drag remain responsive (load ${loadMs} ms, Home drag ${dragMs} ms, editor drag ${editorDragMs} ms)`);
      let recovery = null;
      if(cycle===1 && !reportOnly) {
        phases.start('context-loss', {cycle});
        const beforeLoss = initial.renderCount;
        await child.evaluate(() => {
          const gl = document.querySelector('#homeStage canvas').getContext('webgl2');
          const extension = gl.getExtension('WEBGL_lose_context');
          if(!extension)throw Error('WebGL context-loss testing requires WEBGL_lose_context');
          window.__restoreContext = () => extension.restoreContext();
          extension.loseContext();
        });
        await child.waitForFunction(() => window.__browserStability.contextLosses===1);
        phases.start('lost-resize-and-checks', {cycle});
        await page.setViewportSize(profile.emulated ? {width:profile.context.viewport.width-40,height:profile.context.viewport.height-80} : {width:1100,height:700});
        await child.evaluate(() => {for(let i=0;i<40;i++){window.requestModelRender();window.renderModel();}});
        await page.waitForTimeout(100);
        check((await snapshot()).renderCount===beforeLoss, 'Lost WebGL contexts suppress pending and explicit draws');
        phases.start('context-restore', {cycle});
        await child.evaluate(() => window.__restoreContext());
        await child.waitForFunction(before => window.floorplan.renderCount>before,beforeLoss);
        phases.start('restored-checks', {cycle});
        check((await snapshot()).shaderErrors.length===0, 'Restored WebGL contexts rebuild valid programs');
        const restored = await child.evaluate(() => {
          const size = document.querySelector('#homeStage').getBoundingClientRect(), scene = window.__browserScene();
          return {actual:scene.drawingBuffer,expected:[Math.floor(size.width*scene.pixelRatio),Math.floor(size.height*scene.pixelRatio)]};
        });
        assert.deepEqual(restored.actual,restored.expected, 'Context restoration applies viewport changes made while the context was lost');
        recovery = {before:beforeLoss,after:(await snapshot()).renderCount,contextLosses:(await snapshot()).contextLosses,drawingBuffer:restored.actual};
        // Disposing outlines and revisiting cached wall geometry after restoration
        // must not delete handles from the lost generation. Keep the same case
        // deadline and existing per-operation limits; no screenshots or link queries.
        sample.postRestoreViews = [];
        for (const mode of ['editor-cutaway', 'editor-full', 'home']) {
          phases.start('post-restore-' + mode, {cycle});
          const beforeCount = (await snapshot()).renderCount;
          const transition = {mode, startedMs:Date.now()-started, durationMs:null, completed:false};
          sample.postRestoreViews.push(transition);save();
          try {
            await child.evaluate(changeRestoredViewerMode, mode);
            await child.waitForFunction(({beforeCount, home}) => window.floorplan.renderCount > beforeCount && window.floorplan.homeMode === home,
              {beforeCount, home:mode === 'home'});
            transition.snapshot = await child.evaluate(captureRestoredViewerMode);
            save();
            assertRestoredViewerMode(beforeCount, transition.snapshot, mode, lights);
            transition.completed = true;
          } finally {
            transition.durationMs = Date.now()-started-transition.startedMs;save();
          }
        }
      }
      phases.start('input-receipt', {cycle});
      sample.input = await child.evaluate(() => window.__acceptanceInput);
      if (inputDiagnostics.tapMode !== 'playwright') check(sample.input.trustedTouchStarts===4 && sample.input.trustedTouchEnds===4,
        'Diagnostic transport emits exactly two drag and two button touch sequences per cycle');
      if (profile.emulated) check(sample.input.trustedTouchStarts>0 && sample.input.trustedTouchEnds>0,
        'Touch profiles exercise trusted browser touch input');
      if (profile.input === 'native-touch') check(sample.input.trustedTouchMoves>0 && sample.input.trustedTouchPointerMoves>0,
        'Native touch drags reach the viewer as trusted touch and pointer movement');
      Object.assign(sample,{recovery,...initial});
      save();
      // Screenshot readback drains GPU work. Capture after latency checks so it
      // cannot accidentally warm the first interaction being measured.
      if(process.env.BROWSER_STABILITY_SCREENSHOT_DIR) {
        phases.start('comparison-screenshot', {cycle});
        fs.mkdirSync(process.env.BROWSER_STABILITY_SCREENSHOT_DIR,{recursive:true});
        await input.tap(frame.locator('#homeZoomReset'));
        await child.evaluate(() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        await page.screenshot({path:path.join(process.env.BROWSER_STABILITY_SCREENSHOT_DIR,`${browserName}-${cycle+1}.png`)});
      }
      // Browser teardown and Playwright's frame registry update asynchronously.
      // Subscribe before removing the iframe so even a fast detach is observed.
      phases.start('viewer-detach', {cycle});
      const detachStarted = Date.now();
      await Promise.all([
        page.waitForEvent('framedetached',{predicate:detached=>detached===child,timeout:30000}),
        page.evaluate(() => {window.viewerPort.close();window.viewerPort=null;document.querySelector('#viewer').remove();})
      ]);
      sample.detachMs = Date.now()-detachStarted;
      phases.start('dashboard-after-detach', {cycle});
      assert.equal(page.frames().length,1,'Removing the floorplan releases its browsing context');
      assert.equal(await page.evaluate(() => 6*7),42,'The dashboard remains responsive after closing the floorplan');
      sample.completed = true;save();
    }
    phases.start('final-checks');
    check(errors.length===0, `No uncaught exceptions: ${errors.join('; ')}`);
    check(crashes.length===0, 'No page crashes');
    check(consoleErrors.length===0, `No browser error logs: ${consoleErrors.join('; ')}`);
    if (!reportOnly) assertViewerScenarioComplete(record);
    phases.complete();
    save();
  });
}

(async () => {
  const engines = selectedEngines(process.env.BROWSER_STABILITY_ENGINES);
  diagnostics?.configure(engines, reportOnly);
  const project = fixture();
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'home-studio-browser-'));
  const source = path.join(temporary,'fictional.json'), output = path.join(temporary,'compiled');
  fs.writeFileSync(source,JSON.stringify(project));
  const built = spawnSync(process.env.PYTHON || 'python3',['scripts/build-planner-project.py','--project',source,'--output',output],{cwd:root,encoding:'utf8',timeout:120000});
  if (built.error) throw built.error;
  assert.equal(built.status,0,built.stderr || built.stdout || `Python builder exited with signal ${built.signal}`);
  let html = fs.readFileSync(path.join(output,'main/index.html'),'utf8');
  html = html.replace('<head>',`<head><script>window.__HOME_FLOORPLAN_EMBED__=true;(${instrumentation.toString()})();</script>`);
  html = startup.checkpointSource(html, 'renderProfile=selectRenderProfile(renderer.getContext());', 'renderProfile');
  html = html.replace('</script></body>', `if(renderer)(${captureViewerFrames.toString()})(renderer);window.__browserScene=()=>({rasterProbe:renderProfile.rasterProbe||null,shadowType:renderer.shadowMap.type,materialTypes:(()=>{const types=new Set();scene.traverse(o=>{for(const m of (Array.isArray(o.material)?o.material:[o.material]))if(m)types.add(m.type)});return [...types].sort()})(),camera:window.__browserCamera,renderPasses:window.__browserRenderPasses,drawingBuffer:[renderer.domElement.width,renderer.domElement.height],pixelRatio:renderer.getPixelRatio(),programs:renderer.info.programs.length,textures:renderer.info.memory.textures,geometries:renderer.info.memory.geometries,triangles:renderer.info.render.triangles,drawCalls:renderer.info.render.calls,shadowMaps:(()=>{const sizes=[];scene.traverse(o=>{if(o.castShadow&&o.shadow)sizes.push([o.type,o.shadow.mapSize.x,o.shadow.mapSize.y])});return sizes})(),pointLights:(()=>{let n=0;scene.traverse(o=>{if(o.isPointLight&&o.visible)n++});return n})(),activePointLights:(()=>{let n=0;scene.traverse(o=>{if(o.isPointLight&&o.visible&&o.intensity>0)n++});return n})()});\n</script></body>`);
  let sourceHash = crypto.createHash('sha256').update(html).digest('hex');
  const server = http.createServer((request,response) => {
    if(startup.handle(request,response,sourceHash))return;
    if(request.url==='/fixture.json'){response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(project));return;}
    response.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});
    response.end(request.url==='/viewer'?html:'<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fictional dashboard fixture</title><body style="margin:0"><p>Isolated dashboard fixture</p></body></html>');
  });
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const origin = `http://127.0.0.1:${server.address().port}`;
    const startupScript = startup.scriptFor(origin);
    if(startupScript) html = html.replace('<head>',`<head><script>${startupScript}</script>`);
    html = startup.allowLoopback(html, origin);
    sourceHash = crypto.createHash('sha256').update(html).digest('hex');
    if(fixtureOnly) {
      console.log(JSON.stringify({fixtureServer:true,origin:`http://127.0.0.1:${server.address().port}`,sourceHash,sourceFiles,sourceHashScope}));
      await new Promise(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
    } else {
      await diagnostics.runAll(engines, browserName=>run(browserName,`http://127.0.0.1:${server.address().port}`,project,sourceHash));
    }
  } finally {await new Promise(resolve=>server.close(resolve));}
})().then(()=>diagnostics?.finish(),error=>{diagnostics?.finish(error);console.error(error);process.exitCode=1;})
  .finally(()=>{if(temporary)fs.rmSync(temporary,{recursive:true,force:true});});
