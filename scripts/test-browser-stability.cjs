// Real WebGL regression coverage. Uses fictional rooms and an isolated browser
// profile; the sandboxed iframe and MessageChannel mirror the HA panel contract.
// Install browsers: npx playwright install chromium firefox
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
const {createDiagnostics, positiveInteger, selectedEngines, browserLaunchOptions} = require('./browser-stability-diagnostics.cjs');

const root = path.resolve(process.env.HOME_STUDIO_SOURCE_ROOT || path.join(__dirname, '..'));
const fixtureOnly = process.env.HOME_STUDIO_FIXTURE_ONLY === '1';
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
      unmaskedRenderer:debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,textureUnits:gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)};
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
  return diagnostics.run(browserName, {
    reportOnly, deadlineMs: 120000, sourceHash,
    fixture: {floors: 1, rooms: project.floors[0].rooms.length, lights: project.floors[0].items.length},
    launch: browserLaunchOptions(browserName, process.env.BROWSER_STABILITY_HEADED !== '1'),
    context: {viewport: {width: 1280, height: 800}, locale: 'en-US'},
  }, async ({browser, page, record, check, save}) => {
  const {samples, errors, crashes, consoleErrors} = record;
  const dragCanvas = async (locator, child) => {
    const bounds = await locator.boundingBox();
    const point = await locator.evaluate(canvas => {
      const rect = canvas.getBoundingClientRect();
      for(const y of [.18,.35,.6,.8])for(const x of [.12,.25,.5,.8]) {
        if(document.elementFromPoint(rect.x+rect.width*x,rect.y+rect.height*y)===canvas)return {x,y};
      }
      throw Error('No exposed canvas pixel is available for a real drag');
    });
    const started = Date.now();
    await page.mouse.move(bounds.x+bounds.width*point.x,bounds.y+bounds.height*point.y);
    await page.mouse.down();
    await page.mouse.move(bounds.x+bounds.width*(point.x+.15),bounds.y+bounds.height*(point.y+.1),{steps:12});
    await page.mouse.up();
    await child.evaluate(() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    return Date.now()-started;
  };
    await page.goto(origin);
    const states = Object.fromEntries(project.floors[0].items.map(item => [item.entity_id,{state:'on',name:item.name,light:{brightness:180,color_mode:'color_temp',color_temp_kelvin:3000}}]));
    states['sun.sun'] = {state:'above_horizon',elevation:30};
    for (let cycle = 0; cycle < 2; cycle++) {
      console.log(`${browserName} ${browser.version()}: loading fictional dashboard, cycle ${cycle + 1}`);
      const started = Date.now();
      await page.evaluate(async ({items,states}) => {
        const html = await (await fetch('/viewer')).text();
        const iframe = document.createElement('iframe');
        iframe.id = 'viewer';iframe.sandbox = 'allow-scripts allow-downloads allow-forms';
        iframe.style.cssText = 'width:100%;height:740px;border:0';
        iframe.onload = () => {
          const channel = new MessageChannel();window.viewerPort = channel.port1;
          channel.port1.onmessage = event => { if(event.data.type==='model_config') channel.port1.postMessage({type:'states',connected:true,states}); };
          iframe.contentWindow.postMessage({type:'home-floorplan:init',items,preferences:{}},'*',[channel.port2]);
        };
        iframe.srcdoc = html;document.body.append(iframe);
      }, {items:project.floors[0].items,states});
      await page.waitForFunction(() => document.querySelector('#viewer'));
      const frame = await page.locator('#viewer').contentFrame();
      // FrameLocator supports locators, but evaluate uses the actual child Frame.
      const child = page.frames().find(value => value !== page.mainFrame());
      await child.waitForFunction(() => window.floorplan?.renderCount > 0 && document.querySelector('#homeConnection')?.dataset.connected === 'true');
      const loadMs = Date.now()-started;
      const sample = {cycle,loadMs};samples.push(sample);save();
      console.log(`${browserName}: first connected draw in ${loadMs} ms`);
      const snapshot = () => child.evaluate(() => ({...window.__browserStability,renderCount:window.floorplan.renderCount,homeMode:window.floorplan.homeMode,scene:window.__browserScene?.()}));
      let initial = await snapshot();
      record.gpu = initial.gpu;
      Object.assign(sample, initial);
      save();
      sample.initialPrograms = initial.linkedPrograms;
      check(initial.contexts===1, 'One WebGL context is created per viewer');
      check(initial.shaderErrors.length===0, 'All actual WebGL programs link successfully');
      check(initial.scene.pointLights===project.floors[0].items.length, 'Every fixture retains a shader light slot');
      check(initial.scene.activePointLights===project.floors[0].items.length, 'Every active fixture still contributes illumination');
      const software = /swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render|lavapipe/i.test(initial.gpu.unmaskedRenderer || '');
      check(initial.scene.drawingBuffer[0]*initial.scene.drawingBuffer[1]<=(software?250000:2000000), 'The actual drawing buffer respects the detected graphics budget');
      const pointShadows = initial.scene.shadowMaps.filter(([type]) => type==='PointLight');
      const expectedShadows = Math.max(0,Math.min(project.floors[0].items.length,software?2:8,initial.gpu.textureUnits-4));
      check(pointShadows.length===expectedShadows, 'Point shadows respect the graphics profile and available samplers');
      check(pointShadows.every(([,width,height]) => width<=(software?128:512) && height<=(software?128:512)), 'Point shadow faces respect the graphics profile');
      const sunShadow = initial.scene.shadowMaps.find(([type]) => type==='DirectionalLight');
      check(sunShadow && sunShadow[1]===(software?512:2048) && sunShadow[2]===(software?512:2048), 'The sun shadow respects the graphics profile');
      await page.waitForTimeout(200);
      const idleBefore = (await snapshot()).renderCount;
      await page.waitForTimeout(350);
      check((await snapshot()).renderCount===idleBefore, 'An idle Home view does not continuously render');
      const canvas = frame.locator('#homeStage canvas');
      const homeCameraBefore = (await snapshot()).scene.camera;
      const dragMs = await dragCanvas(canvas,child);
      sample.dragMs = dragMs;
      sample.readyAfterDragMs = Date.now()-started;
      console.log(`${browserName}: Home drag and frame completion in ${dragMs} ms`);
      const afterHomeDrag = await snapshot();
      sample.homeCameraChanged = Boolean(homeCameraBefore && afterHomeDrag.scene.camera &&
        JSON.stringify(homeCameraBefore) !== JSON.stringify(afterHomeDrag.scene.camera));
      save();
      check(afterHomeDrag.errors.length===0, `No rendering errors after Home drag: ${afterHomeDrag.errors.join('; ')}`);
      check(afterHomeDrag.renderCount>idleBefore, 'Dragging Home updates the rendered scene');
      check(sample.homeCameraChanged, 'Dragging Home changes the camera used to draw the scene');
      await frame.locator('#editLayout').click();
      await child.waitForFunction(() => !window.floorplan.homeMode);
      // Exercise a burst of editor wheel events in a single task, as high-frequency
      // trackpad input must not perform an unbounded number of synchronous draws.
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
        return {synchronousDraws,totalDraws:window.floorplan.renderCount-before,settled};
      });
      sample.burst = burst;
      check(burst.synchronousDraws<=1 && burst.totalDraws>0 && burst.totalDraws<=2, 'Wheel bursts coalesce into at most one scheduled scene draw');
      const editorCameraBefore = (await snapshot()).scene.camera;
      const editorDragMs = await dragCanvas(frame.locator('#view3d canvas'),child);
      sample.editorDragMs = editorDragMs;
      const editorCameraAfter = (await snapshot()).scene.camera;
      sample.editorCameraChanged = Boolean(editorCameraBefore && editorCameraAfter &&
        JSON.stringify(editorCameraBefore) !== JSON.stringify(editorCameraAfter));
      save();
      check(sample.editorCameraChanged, 'Dragging the editor changes the camera used to draw the scene');
      await frame.locator('#openHome').click();
      await child.waitForFunction(() => window.floorplan.homeMode);
      await child.evaluate(() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      sample.statePrograms = [(await snapshot()).linkedPrograms];
      const lights = project.floors[0].items.length;
      const allOff = Object.fromEntries(Object.entries(states).map(([key,value])=>[key,{...value,state:'off'}]));
      const firstEntity = project.floors[0].items[0].entity_id;
      const oneOff = {...states,[firstEntity]:{...states[firstEntity],state:'off'}};
      for(const [next,onCount] of [[allOff,0],[oneOff,lights-1],[states,lights]]) {
        await page.evaluate(states => window.viewerPort.postMessage({type:'states',connected:true,states}),next);
        await child.waitForFunction(expected => document.querySelectorAll('.home-marker[data-state="on"]').length===expected,onCount);
        await child.evaluate(() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const value = await snapshot();
        sample.statePrograms.push(value.linkedPrograms);
        check(value.scene.pointLights===lights, 'Light state changes retain stable shader slots');
        check(value.scene.activePointLights===onCount, 'Only lights whose live state is on contribute intensity');
      }
      check(new Set(sample.statePrograms).size===1, 'All-off, partially lit and all-on states do not compile new programs');
      initial = await snapshot();
      check(initial.shaderErrors.length===0, 'Light changes and editor/Home transitions keep every shader linked');
      check(initial.contextLosses===0, 'No unexpected WebGL context loss');
      check(loadMs<30000 && dragMs<15000 && editorDragMs<15000, `Load and drag remain responsive (load ${loadMs} ms, Home drag ${dragMs} ms, editor drag ${editorDragMs} ms)`);
      let recovery = null;
      if(cycle===1 && !reportOnly) {
        const beforeLoss = initial.renderCount;
        await child.evaluate(() => {
          const gl = document.querySelector('#homeStage canvas').getContext('webgl2');
          const extension = gl.getExtension('WEBGL_lose_context');
          if(!extension)throw Error('WebGL context-loss testing requires WEBGL_lose_context');
          window.__restoreContext = () => extension.restoreContext();
          extension.loseContext();
        });
        await child.waitForFunction(() => window.__browserStability.contextLosses===1);
        await page.setViewportSize({width:1100,height:700});
        await child.evaluate(() => {for(let i=0;i<40;i++){window.requestModelRender();window.renderModel();}});
        await page.waitForTimeout(100);
        check((await snapshot()).renderCount===beforeLoss, 'Lost WebGL contexts suppress pending and explicit draws');
        await child.evaluate(() => window.__restoreContext());
        await child.waitForFunction(before => window.floorplan.renderCount>before,beforeLoss);
        check((await snapshot()).shaderErrors.length===0, 'Restored WebGL contexts rebuild valid programs');
        const restored = await child.evaluate(() => {
          const size = document.querySelector('#homeStage').getBoundingClientRect(), scene = window.__browserScene();
          return {actual:scene.drawingBuffer,expected:[Math.floor(size.width*scene.pixelRatio),Math.floor(size.height*scene.pixelRatio)]};
        });
        assert.deepEqual(restored.actual,restored.expected, 'Context restoration applies viewport changes made while the context was lost');
        recovery = {before:beforeLoss,after:(await snapshot()).renderCount,contextLosses:(await snapshot()).contextLosses,drawingBuffer:restored.actual};
      }
      Object.assign(sample,{recovery,...initial});
      save();
      // Screenshot readback drains GPU work. Capture after latency checks so it
      // cannot accidentally warm the first interaction being measured.
      if(process.env.BROWSER_STABILITY_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.BROWSER_STABILITY_SCREENSHOT_DIR,{recursive:true});
        await frame.locator('#homeZoomReset').click();
        await child.evaluate(() => new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        await page.screenshot({path:path.join(process.env.BROWSER_STABILITY_SCREENSHOT_DIR,`${browserName}-${cycle+1}.png`)});
      }
      // Browser teardown and Playwright's frame registry update asynchronously.
      // Subscribe before removing the iframe so even a fast detach is observed.
      const detachStarted = Date.now();
      await Promise.all([
        page.waitForEvent('framedetached',{predicate:detached=>detached===child,timeout:30000}),
        page.evaluate(() => {window.viewerPort.close();window.viewerPort=null;document.querySelector('#viewer').remove();})
      ]);
      sample.detachMs = Date.now()-detachStarted;
      assert.equal(page.frames().length,1,'Removing the floorplan releases its browsing context');
      assert.equal(await page.evaluate(() => 6*7),42,'The dashboard remains responsive after closing the floorplan');
    }
    check(errors.length===0, `No uncaught exceptions: ${errors.join('; ')}`);
    check(crashes.length===0, 'No page crashes');
    check(consoleErrors.length===0, `No browser error logs: ${consoleErrors.join('; ')}`);
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
  html = html.replace('</script></body>', `if(renderer){const captureRender=renderer.render.bind(renderer);renderer.render=(scene,camera)=>{const result=captureRender(scene,camera);window.__browserCamera={projection:camera.projectionMatrix.toArray(),world:camera.matrixWorld.toArray()};return result;};}window.__browserScene=()=>({camera:window.__browserCamera,drawingBuffer:[renderer.domElement.width,renderer.domElement.height],pixelRatio:renderer.getPixelRatio(),programs:renderer.info.programs.length,textures:renderer.info.memory.textures,geometries:renderer.info.memory.geometries,triangles:renderer.info.render.triangles,drawCalls:renderer.info.render.calls,shadowMaps:(()=>{const sizes=[];scene.traverse(o=>{if(o.castShadow&&o.shadow)sizes.push([o.type,o.shadow.mapSize.x,o.shadow.mapSize.y])});return sizes})(),pointLights:(()=>{let n=0;scene.traverse(o=>{if(o.isPointLight&&o.visible)n++});return n})(),activePointLights:(()=>{let n=0;scene.traverse(o=>{if(o.isPointLight&&o.visible&&o.intensity>0)n++});return n})()});\n</script></body>`);
  const sourceHash = crypto.createHash('sha256').update(html).digest('hex');
  const server = http.createServer((request,response) => {
    if(request.url==='/fixture.json'){response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(project));return;}
    response.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});
    response.end(request.url==='/viewer'?html:'<!doctype html><html lang="en"><title>Fictional dashboard fixture</title><body style="margin:0"><p>Isolated dashboard fixture</p></body></html>');
  });
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    if(fixtureOnly) {
      console.log(JSON.stringify({fixtureServer:true,origin:`http://127.0.0.1:${server.address().port}`,sourceHash}));
      await new Promise(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
    } else {
      await diagnostics.runAll(engines, browserName=>run(browserName,`http://127.0.0.1:${server.address().port}`,project,sourceHash));
    }
  } finally {await new Promise(resolve=>server.close(resolve));}
})().then(()=>diagnostics?.finish(),error=>{diagnostics?.finish(error);console.error(error);process.exitCode=1;})
  .finally(()=>{if(temporary)fs.rmSync(temporary,{recursive:true,force:true});});
