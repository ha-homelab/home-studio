// Isolated, real-browser planner stress checks. No Home Assistant or user data.
// npx playwright install chromium firefox webkit
// PLANNER_STABILITY_ENGINES=firefox,chromium node scripts/test-planner-stability.cjs
// PLANNER_STABILITY_SOURCE_ROOT=/path/to/baseline PLANNER_STABILITY_REPORT_ONLY=1 ...
// PLANNER_STABILITY_RECOVERY_ACTIONS=none|edit|resize isolates recovery diagnostics (default: all).
// HOME_STUDIO_DIAGNOSTICS_DIR (or PLANNER_STABILITY_DIAGNOSTICS_DIR) keeps JSON/failure PNGs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const {createDiagnostics, positiveInteger, selectedEngines, browserLaunchOptions, browserProfile, createInputDriver} = require('./browser-stability-diagnostics.cjs');

const root = path.resolve(process.env.PLANNER_STABILITY_SOURCE_ROOT || path.join(__dirname, '..'));
const reportOnly = process.env.PLANNER_STABILITY_REPORT_ONLY === '1';
const fixtureOnly = process.env.HOME_STUDIO_FIXTURE_ONLY === '1';
const restoreLayout = process.env.PLANNER_STABILITY_RESTORE_LAYOUT || 'immediate';
assert(['immediate','settled'].includes(restoreLayout), 'PLANNER_STABILITY_RESTORE_LAYOUT must be immediate or settled');
const recoveryActions = process.env.PLANNER_STABILITY_RECOVERY_ACTIONS ?? 'all';
assert(['all','none','edit','resize'].includes(recoveryActions), 'PLANNER_STABILITY_RECOVERY_ACTIONS must be all, none, edit, or resize');
const recoveryEdit = recoveryActions === 'all' || recoveryActions === 'edit';
const recoveryResize = recoveryActions === 'all' || recoveryActions === 'resize';
const traceRecoveryValue = process.env.PLANNER_STABILITY_TRACE_RECOVERY ?? '0';
assert(['0','1'].includes(traceRecoveryValue), 'PLANNER_STABILITY_TRACE_RECOVERY must be 0 or 1');
const traceRecovery = traceRecoveryValue === '1';
const diagnostics = fixtureOnly ? null : createDiagnostics('planner', 'PLANNER_STABILITY', root);
let cycles, catalog, editor, sourceHash, project;

function fixture() {
  const project = {schema_version:1,id:'planner_stress',title:'Fictional planner stress fixture',floors:[]};
  const designs = ['sofa_3','armchair','dining_table','dining_chair','bookcase','rug','floor_lamp','plant'];
  const positions = Array.from({length:16},(_,i)=>[1+(i%4)*2,1+Math.floor(i/4)*2]);
  for(let level=0;level<2;level++) {
    const floor = {id:`floor_${level}`,name:`Fictional floor ${level+1}`,elevation_m:level*3,height_m:2.8,rooms:[],walls:[],openings:[],items:[]};
    for(let z=0;z<2;z++)for(let x=0;x<4;x++) {
      const id=`room_${x}_${z}`;
      floor.rooms.push({id,name:`Room ${x+1}/${z+1}`,polygon:[[x*8,z*8],[(x+1)*8,z*8],[(x+1)*8,(z+1)*8],[x*8,(z+1)*8]],material:'floor'});
      positions.forEach((position,i)=>{
        const design=designs[i%designs.length];
        const model=catalog.models.find(value=>value.id===design);
        floor.items.push({id:`${id}_item_${i}`,name:`Fictional ${design} ${x}/${z}`,type:model.type,room:id,
          position_m:{x:x*8+position[0],y:model.elevation_m,z:z*8+position[1]},dimensions_m:model.dimensions_m,
          rotation_deg:0,entity_id:'',notes:'',model_id:model.id,style_id:model.default_style,...(design==='rug'?{pattern_id:'checks'}:{})});
      });
    }
    for(let x=0;x<=4;x++)for(let z=0;z<2;z++)floor.walls.push({id:`v_${x}_${z}`,start:[x*8,z*8],end:[x*8,(z+1)*8],thickness_m:.15});
    for(let z=0;z<=2;z++)for(let x=0;x<4;x++)floor.walls.push({id:`h_${x}_${z}`,start:[x*8,z*8],end:[(x+1)*8,z*8],thickness_m:.15});
    for(let x=0;x<4;x++)floor.openings.push({id:`window_${x}`,wall_id:`h_${x}_0`,type:'window',offset_m:2,width_m:1.5,sill_m:.9,head_m:2.2});
    project.floors.push(floor);
  }
  return project;
}

function instrument() {
  const stats=window.__plannerStats={planDraws:0,canvasResizes:0,contexts:0,contextLosses:0,linkedPrograms:0,shaderErrors:[],errors:[],contextEvents:[],linkFailures:[],recoveryOperations:[]};
  window.__plannerTraceRenderer=(renderer,readLayout)=>{
    if(!renderer || renderer.__plannerRecoveryInstrumented)return;
    renderer.__plannerRecoveryInstrumented=true;
    const capture=()=>{
      try {
        const gl=renderer.getContext(),target=renderer.getRenderTarget();
        return {time:performance.now(),lost:gl.isContextLost(),buffer:[renderer.domElement.width,renderer.domElement.height],
          drawingBuffer:[gl.drawingBufferWidth,gl.drawingBufferHeight],linkedPrograms:stats.linkedPrograms,
          renderTarget:target?{width:target.width,height:target.height,texture:target.texture?.uuid}:null,...readLayout()};
      } catch(error) { return {time:performance.now(),diagnosticError:String(error)}; }
    };
    for(const method of ['setDrawingBufferSize','render']) {
      const original=renderer[method];
      renderer[method]=function(...args) {
        // No GL queries on ordinary editing frames; retain at most 30 recovery operations.
        if(!window.__plannerRecoveryPhase || stats.recoveryOperations.length>=30)return original.apply(this,args);
        const operation={method,phase:window.__plannerRecoveryPhase,before:capture()};
        if(method==='setDrawingBufferSize')operation.requestedSize=args.slice(0,3);
        stats.recoveryOperations.push(operation);
        try { return original.apply(this,args); }
        catch(error) { operation.error=String(error);throw error; }
        finally { operation.after=capture(); }
      };
    }
  };
  window.addEventListener('error', event=>stats.errors.push(event.message || String(event.error)));
  window.addEventListener('unhandledrejection', event=>stats.errors.push(String(event.reason)));
  const originalError=console.error.bind(console);
  console.error=(...args)=>{stats.errors.push(args.map(value=>value?.message || String(value)).join(' '));originalError(...args);};
  for(const property of ['width','height']) {
    const descriptor=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,property);
    Object.defineProperty(HTMLCanvasElement.prototype,property,{...descriptor,set(value){if(this.id==='preview-canvas')stats.canvasResizes++;descriptor.set.call(this,value);}});
  }
  const original=HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext=function(...args) {
    const context=original.apply(this,args);
    if(!context || context.__plannerInstrumented)return context;
    context.__plannerInstrumented=true;
    if(args[0]==='2d' && this.id==='plan-canvas') {
      const clear=context.clearRect.bind(context);context.clearRect=(...values)=>{stats.planDraws++;return clear(...values);};
    }
    if(String(args[0]).startsWith('webgl')) {
      stats.contexts++;
      const info=context.getExtension('WEBGL_debug_renderer_info');
      stats.gpu={version:context.getParameter(context.VERSION),renderer:info?context.getParameter(info.UNMASKED_RENDERER_WEBGL):context.getParameter(context.RENDERER)};
      console.info('[home-studio-test-gpu]' + JSON.stringify(stats.gpu));
      const link=context.linkProgram.bind(context);
      context.linkProgram=program=>{
        link(program);stats.linkedPrograms++;
        if(!context.getProgramParameter(program,context.LINK_STATUS)) {
          const log=context.getProgramInfoLog(program);stats.shaderErrors.push(log);
          stats.linkFailures.push({log,lost:context.isContextLost(),program:stats.linkedPrograms,phase:window.__plannerRecoveryPhase||'edit-and-preview',time:performance.now()});
        }
      };
      for(const type of ['webglcontextlost','webglcontextrestored']) this.addEventListener(type,event=>{
        if(type==='webglcontextlost')stats.contextLosses++;
        stats.contextEvents.push({type,statusMessage:event.statusMessage||'',lost:context.isContextLost(),phase:window.__plannerRecoveryPhase||'edit-and-preview',time:performance.now(),buffer:[this.width,this.height],view:window.planner?.getView(),linkedPrograms:stats.linkedPrograms});
      });
    }
    return context;
  };
}

const server=http.createServer((request,response)=>{
  let route=new URL(request.url,'http://localhost').pathname;
  // Headed Chromium requests this implicitly even without an icon link.
  if(route==='/favicon.ico'){response.writeHead(204,{'Cache-Control':'no-store'}).end();return;}
  if(route==='/fixture.json'){response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(project));return;}
  if(route==='/planner/')route='/planner/index.html';
  if(!/^\/(planner|vendor)\/[\w./-]+$/.test(route) || route.includes('..')){response.writeHead(404).end();return;}
  const file=path.join(root,route),extension=path.extname(file);
  if(!fs.existsSync(file) || !fs.statSync(file).isFile()){response.writeHead(404).end();return;}
  let content=route==='/planner/editor.js'?editor:fs.readFileSync(file);
  if(fixtureOnly && route==='/planner/index.html')content=content.toString().replace('<head>',`<head><script>(${instrument.toString()})();</script>`);
  if(route==='/planner/editor.js')content+=`
window.__plannerScene=()=>renderer?({layout:{...size},viewport:[innerWidth,innerHeight],memory:{...renderer.info.memory},programs:renderer.info.programs.length,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,buffer:[renderer.domElement.width,renderer.domElement.height],pixelRatio:renderer.getPixelRatio(),shadowMap:[previewSun.shadow.mapSize.x,previewSun.shadow.mapSize.y],orbit:[orbit.yaw,orbit.pitch,orbit.radius]}):null;`;
  // Layout probes can settle the race under investigation. Never install them in primary acceptance.
  if(route==='/planner/editor.js' && traceRecovery)content+=`
const __plannerOriginalInitPreview=initPreview;
initPreview=function(...args){
  const result=__plannerOriginalInitPreview.apply(this,args);
  window.__plannerTraceRenderer?.(renderer,()=>{
    const rect=document.querySelector('.canvas-shell').getBoundingClientRect();
    return {layout:{...size},shell:{width:rect.width,height:rect.height},viewport:[innerWidth,innerHeight],view};
  });
  return result;
};`;
  response.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'}[extension]||'application/octet-stream','Cache-Control':'no-store'}).end(content);
});

async function run(engine,origin) {
  const profile = browserProfile(engine, {viewport: {width: 1440, height: 1000}, deviceScaleFactor: 2});
  return diagnostics.run(engine, {
    reportOnly, deadlineMs: 180000, sourceHash,
    fixture: {floors: 2, rooms: 16, catalogItems: 256},
    launch: browserLaunchOptions(engine, process.env.PLANNER_STABILITY_HEADED !== '1'),
    context: profile.context, profile,
    instrument,
  }, async ({browser, page, record, check, save}) => {
  const {samples, errors, crashes, consoleErrors} = record, external = record.external = [];
  page.on('dialog',dialog=>dialog.accept());
  page.on('request',request=>{if(!request.url().startsWith(origin+'/')&&!request.url().startsWith('data:')){external.push(request.url());save();}});
  const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const snapshot=()=>page.evaluate(()=>({stats:window.__plannerStats,preview:window.planner.getPreviewMetadata(),scene:window.__plannerScene()}));
  const getProject=()=>page.evaluate(()=>window.planner.getProject());
  const input = await createInputDriver(page, engine, profile);
  let dragPhases;
  async function prepareWorldDrag(from,to) {
    const canvas = page.locator('#plan-canvas');
    await canvas.scrollIntoViewIfNeeded();
    // Small touch motions below the browser's gesture threshold produce no drag;
    // at phone zoom, nearby furniture hit areas also overlap for mouse input.
    // Zoom through the real toolbar, then pan through real pointer input to keep
    // both endpoints visible; the fixture and its metric coordinates stay intact.
    for (let attempt=0; attempt<30; attempt++) {
      const points=await page.evaluate(({from,to})=>[window.planner.worldToScreen(from),window.planner.worldToScreen(to)],{from,to});
      const box=await canvas.boundingBox();
      if (profile.emulated && Math.hypot(points[1][0]-points[0][0],points[1][1]-points[0][1])<28) {
        await input.tap(page.locator('#zoom-in')); await frames(); continue;
      }
      const mid=[(points[0][0]+points[1][0])/2,(points[0][1]+points[1][1])/2];
      if (points.every(p=>p[0]>=15&&p[0]<=box.width-15&&p[1]>=15&&p[1]<=box.height-15)) return {points,box};
      const dx=Math.max(-box.width*.6,Math.min(box.width*.6,box.width/2-mid[0]));
      const dy=Math.max(-box.height*.6,Math.min(box.height*.6,box.height/2-mid[1]));
      const start={x:box.x+box.width/2-dx/2,y:box.y+box.height/2-dy/2};
      await canvas.focus(); await page.keyboard.down('Space');
      try { await input.drag(start,{x:start.x+dx,y:start.y+dy}); }
      finally { await page.keyboard.up('Space'); }
      await frames();
    }
    throw Error('Unable to frame the complete metric drag inside the visible plan canvas');
  }
  async function dragWorld(from,to) {
    const {points,box}=await prepareWorldDrag(from,to);
    const start=Date.now();
    dragPhases=await input.drag({x:box.x+points[0][0],y:box.y+points[0][1]}, {x:box.x+points[1][0],y:box.y+points[1][1]});
    const frameStart=Date.now();await frames();dragPhases.framesMs=Date.now()-frameStart;
    return Date.now()-start;
  }
  async function burst(canvasId) {
    return page.evaluate(async id=>{
      const canvas=document.getElementById(id),before=window.__plannerStats.planDraws,previewBefore=window.planner.getPreviewMetadata().renderCount||0;
      for(let i=0;i<40;i++)canvas.dispatchEvent(new WheelEvent('wheel',{deltaY:1,bubbles:true,cancelable:true,clientX:canvas.getBoundingClientRect().x+200,clientY:canvas.getBoundingClientRect().y+200}));
      const sync=id==='plan-canvas'?window.__plannerStats.planDraws-before:(window.planner.getPreviewMetadata().renderCount||0)-previewBefore;
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return {sync,total:id==='plan-canvas'?window.__plannerStats.planDraws-before:(window.planner.getPreviewMetadata().renderCount||0)-previewBefore};
    },canvasId);
  }
    console.log(`${engine} ${browser.version()}: loading fictional planner`);
    const started=Date.now();await page.goto(origin+'/planner/?lang=en');await page.waitForFunction(()=>window.planner);
    const shellLoadMs=Date.now()-started,importStart=Date.now();
    await page.locator('#file-input').setInputFiles({name:'fictional.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
    await page.waitForFunction(()=>window.planner.getProject().id==='planner_stress');await frames();
    const importMs=Date.now()-importStart;
    assert.deepEqual(await getProject(),project,'The complete larger fictional project imports without data loss');
    await input.tap(page.locator('[data-tool="room"]'));const roomDrawMs=await dragWorld([32.25,.25],[33.75,1.75]);
    assert.equal((await getProject()).floors[0].rooms.length,9,'Pointer drawing adds a room');
    await input.tap(page.locator('#undo'));
    await input.tap(page.locator('[data-tool="wall"]'));const wallDrawMs=await dragWorld([32.25,3],[33.75,3]);
    assert.equal((await getProject()).floors[0].walls.length,23,'Pointer drawing adds a wall');
    await input.tap(page.locator('#undo'));await input.tap(page.locator('[data-tool="select"]'));
    const planBurst=await burst('plan-canvas');check(planBurst.sync<=1&&planBurst.total>0&&planBurst.total<=2,'Plan wheel bursts coalesce into one frame');
    await input.tap(page.locator('#fit-view'));
    const beforeCancel=await getProject(),cancel=await prepareWorldDrag([1,1],[1.5,1]);
    await input.drag({x:cancel.box.x+cancel.points[0][0],y:cancel.box.y+cancel.points[0][1]},
      {x:cancel.box.x+cancel.points[1][0],y:cancel.box.y+cancel.points[1][1]},()=>page.keyboard.press('Escape'));
    await frames();
    assert.deepEqual(await getProject(),beforeCancel,'Cancelling a furniture drag restores the complete original project');
    const initial=record.initial={shellLoadMs,importMs,roomDrawMs,wallDrawMs,planBurst};save();console.log(`${engine}: ${JSON.stringify(initial)}`);
    for(let cycle=0;cycle<cycles;cycle++) {
      const sample={cycle};samples.push(sample);save();
      const item=(await getProject()).floors[0].items[0],before=[item.position_m.x,item.position_m.z];
      const itemDragMs=await dragWorld(before,[before[0]+.5,before[1]]);
      sample.itemDragMs=itemDragMs;sample.itemDragPhases=dragPhases;save();
      const moved=(await getProject()).floors[0].items[0];assert.equal(moved.position_m.x,before[0]+.5,'Pointer dragging moves the intended catalog furniture');
      const previewStart=Date.now();await input.tap(page.locator('#preview-tab'));await page.waitForFunction(()=>window.planner.getPreviewMetadata().items>0);await frames();
      const previewLoadMs=Date.now()-previewStart;
      sample.previewLoadMs=previewLoadMs;save();
      let allFloorsMs=null;
      if(cycle===0){const allFloorsStart=Date.now();await input.tap(page.locator('#all-floors'));assert(await page.locator('#all-floors').isChecked(),'All-floors control responds to the selected input');await frames();allFloorsMs=Date.now()-allFloorsStart;}
      sample.allFloorsMs=allFloorsMs;save();
      await page.locator('#preview-canvas').scrollIntoViewIfNeeded();
      const preOrbit=await snapshot(),box=await page.locator('#preview-canvas').boundingBox(),orbitStart=Date.now();
      await input.drag({x:box.x+box.width*.45,y:box.y+box.height*.45},
        {x:box.x+box.width*.6,y:box.y+box.height*.55});await frames();
      const orbitMs=Date.now()-orbitStart,afterOrbit=await snapshot();
      sample.orbitMs=orbitMs;save();
      assert.notDeepEqual(afterOrbit.scene.orbit,preOrbit.scene.orbit,'Actual pointer input changes the preview camera');
      check(afterOrbit.stats.canvasResizes===preOrbit.stats.canvasResizes,'Orbit does not reallocate the canvas drawing buffer');
      const previewBurst=await burst('preview-canvas');sample.previewBurst=previewBurst;save();
      check(previewBurst.sync<=1&&previewBurst.total>0&&previewBurst.total<=2,'Preview wheel bursts coalesce into one frame');
      const current=await snapshot();
      record.gpu=current.stats.gpu;
      record.lastSnapshot=current;
      Object.assign(sample,current);
      save();
      check(current.stats.contexts===1,'Repeated edit and preview uses one WebGL context');
      check(current.stats.contextLosses===0,'Editing and preview do not unexpectedly lose the graphics context');
      check(current.preview.items===256&&current.preview.catalogItems===256,'All catalog furniture is retained in the two-floor preview');
      check(current.stats.shaderErrors.length===0&&current.stats.errors.length===0,'Every actual preview shader links without rendering errors');
      const software=/swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render|lavapipe|^Apple Software Renderer$/i.test(current.stats.gpu.renderer);
      check(current.scene.buffer[0]*current.scene.buffer[1]<=(software?250000:2000000),'Preview drawing buffer respects the graphics budget at DPR 2');
      check(current.scene.shadowMap.every(size=>size===(software?512:2048)),'Preview shadow map matches the graphics profile');
      if(cycle>0)assert.deepEqual(current.scene.memory,samples[0].scene.memory,'Editing and rebuilding does not accumulate GPU resources');
      const idle=current.preview.renderCount;await page.waitForTimeout(250);check((await snapshot()).preview.renderCount===idle,'An idle preview does not render continuously');
      check(itemDragMs<10000&&previewLoadMs<30000&&orbitMs<10000,`Planner editing and preview gestures remain responsive (item drag ${itemDragMs} ms, preview ${previewLoadMs} ms, orbit ${orbitMs} ms)`);
      console.log(`${engine}: cycle ${cycle+1}, item drag ${itemDragMs} ms, preview ${previewLoadMs} ms, orbit ${orbitMs} ms`);
      if(cycle===cycles-1&&process.env.PLANNER_STABILITY_SCREENSHOT_DIR){fs.mkdirSync(process.env.PLANNER_STABILITY_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.PLANNER_STABILITY_SCREENSHOT_DIR,`${engine}.png`)});}
      await input.tap(page.locator('#plan-tab'));await frames();
      const hidden=(await snapshot()).preview.renderCount;await page.waitForTimeout(150);check((await snapshot()).preview.renderCount===hidden,'A closed preview stops rendering');
    }
    let recovery=null;
    if(!reportOnly) {
      await input.tap(page.locator('#preview-tab'));await frames();
      const saved=await getProject(),before=await snapshot();
      recovery=record.recovery={savedItems:saved.floors.flatMap(f=>f.items).length,layoutMode:restoreLayout,actions:recoveryActions,traceEnabled:traceRecovery,steps:[]};
      const checkpoint=async phase=>{
        await page.evaluate(value=>{window.__plannerRecoveryPhase=value;},phase);
        recovery.steps.push({phase,snapshot:await snapshot()});save();
      };
      await checkpoint('request-loss');
      await page.evaluate(()=>{const extension=document.querySelector('#preview-canvas').getContext('webgl2').getExtension('WEBGL_lose_context');if(!extension)throw Error('WEBGL_lose_context required');window.__restorePlanner=()=>extension.restoreContext();extension.loseContext();});
      await page.waitForFunction(()=>window.__plannerStats.contextLosses===1);
      await checkpoint(recoveryEdit ? 'edit-while-lost' : 'plan-while-lost');
      await burst('preview-canvas');check((await snapshot()).preview.renderCount===before.preview.renderCount,'Lost contexts suppress preview draws');
      await input.tap(page.locator('#plan-tab'));
      if(recoveryEdit) {
        const drag=(await getProject()).floors[0].items[0].position_m;await dragWorld([drag.x,drag.z],[drag.x-.5,drag.z]);
        assert.equal((await getProject()).floors[0].items[0].position_m.x,drag.x-.5,'Furniture remains editable while the graphics context is lost');
      } else assert.deepEqual(await getProject(),saved,'Recovery without an edit preserves the complete project');
      const [download]=await Promise.all([page.waitForEvent('download'),input.tap(page.locator('#export-project'))]);
      const exported=JSON.parse(fs.readFileSync(await download.path(),'utf8'));assert.deepEqual(exported,await getProject(),'JSON export remains intact while the graphics context is lost');
      if(recoveryResize) {
        await checkpoint('resize-while-lost');
        await page.setViewportSize(profile.emulated ? {width:profile.context.viewport.width-40,height:profile.context.viewport.height-80} : {width:1280,height:900});
      }
      // Keep the immediate resize/restore race in the normal acceptance run.
      // The explicit settled variant isolates pending ResizeObserver work.
      if(restoreLayout==='settled') {
        await frames();
        const layout=await page.evaluate(()=>{
          const box=document.querySelector('.canvas-shell').getBoundingClientRect();
          return {actual:window.__plannerScene().layout,expected:{width:box.width,height:box.height},viewport:[innerWidth,innerHeight]};
        });
        recovery.settledLayout=layout;save();
        check(['width','height'].every(key=>Math.abs(layout.actual[key]-layout.expected[key])<1),'Settled recovery uses the actual canvas layout');
      }
      // Capture the pre-restore evidence in the very next browser task. Extra
      // round trips here would let the immediate variant's layout settle.
      const restoreSnapshot=await page.evaluate(()=>{
        window.__plannerRecoveryPhase='request-restore';
        const value=JSON.parse(JSON.stringify({stats:window.__plannerStats,preview:window.planner.getPreviewMetadata(),scene:window.__plannerScene()}));
        window.__restorePlanner();
        return value;
      });
      recovery.steps.push({phase:'request-restore',snapshot:restoreSnapshot});save();
      check(restoreSnapshot.preview.renderCount===before.preview.renderCount,'Recovery actions while the graphics context is lost must not draw');
      await input.tap(page.locator('#preview-tab'));await page.waitForFunction(count=>window.planner.getPreviewMetadata().renderCount>count,before.preview.renderCount);await frames();
      recovery.after=await snapshot();save();
      check(recovery.after.stats.contextLosses===1,'Restoration must not lose the graphics context again');
      check(recovery.after.stats.shaderErrors.length===0,'Restored preview shaders link successfully');
      const restored=recovery.after;
      check(consoleErrors.length===0,'Restoring and rebuilding preview geometry produces no browser graphics errors');
      check(restored.preview.catalogItems===256,'Restoration rebuilds every catalog item after the selected recovery actions');
      assert.deepEqual(restored.scene.memory,samples[0].scene.memory,'Restoration rebuilds the scene without leaking or omitting GPU resources');
      assert.deepEqual(restored.scene.buffer,[Math.floor(restored.preview.viewport.width*restored.scene.pixelRatio),Math.floor(restored.preview.viewport.height*restored.scene.pixelRatio)],'Restoration uses the current viewport size');
      assert.deepEqual(await getProject(),exported,'Graphics restoration preserves the exported project');
    }
    record.input=await page.evaluate(()=>window.__acceptanceInput);
    if(profile.emulated) check(record.input.trustedTouchStarts>0&&record.input.trustedTouchEnds>0,
      'Touch profiles exercise trusted browser touch input');
    if(profile.input==='native-touch') check(record.input.trustedTouchMoves>0&&record.input.trustedTouchPointerMoves>0,
      'Native touch drags reach the planner as trusted touch and pointer movement');
    record.recovery=recovery;
    save();
    const beforeReload=await getProject();await page.reload();await page.waitForFunction(()=>window.planner);
    assert.deepEqual(await getProject(),beforeReload,'Closing and reopening the planner restores its saved draft');
    check(errors.length===0&&crashes.length===0&&external.length===0&&consoleErrors.length===0,'The isolated planner runs without crashes, uncaught errors, browser error logs, or external requests');
    save();
  });
}

(async()=>{
  const engines=selectedEngines(process.env.PLANNER_STABILITY_ENGINES);
  diagnostics?.configure(engines,reportOnly);
  cycles=positiveInteger('PLANNER_STABILITY_CYCLES',3,10);
  catalog=JSON.parse(fs.readFileSync(path.join(root,'planner/catalog.json')));
  editor=fs.readFileSync(path.join(root,'planner/editor.js'),'utf8');
  sourceHash=crypto.createHash('sha256').update(editor).digest('hex');
  project=fixture();
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    if(fixtureOnly) {
      console.log(JSON.stringify({fixtureServer:true,origin:`http://127.0.0.1:${server.address().port}`,sourceHash}));
      await new Promise(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
    } else {
      await diagnostics.runAll(engines,engine=>run(engine,`http://127.0.0.1:${server.address().port}`));
    }
  } finally {await new Promise(resolve=>server.close(resolve));}
})().then(()=>diagnostics?.finish(),error=>{diagnostics?.finish(error);console.error(error);process.exitCode=1;});
