// Output-only derivative of d934c6a: observe one naturally requested restored frame.
// No finish/readback/getParameter calls, no extra draw, no scheduling action.
function attachPassiveRestoreDrawDiagnostic(renderer, stateFor) {
  const gl = renderer.getContext(), now = () => performance.now();
  const ids = new WeakMap(), shaders = new WeakMap(), programs = new WeakMap();
  let nextId = 1, sequence = 0, active = false, started = false;
  let program = null, framebuffer = null, viewport = null, mesh = null, material = null, camera = null;
  let phase = 'main', shadowCameras = new Map();
  const result = window.__passiveRestoreDrawDiagnostic = {diagnosticOnly:true, timingMode:'passive-restored-draw-submission-v1', done:false, truncated:false, draws:0};
  // Observe calls already made by Three. These are submitted values, not GL
  // readbacks; absent, stale or unsupported uploads must remain unknown.
  const uniformNames = ['homePointLightingRequired','homeDaylight','homeExteriorSurface',
    'homeWallSurface','homeWallSheenEnabled','homeFaceMode'];
  const uniformLocations = new WeakMap(), uniformValues = new WeakMap(), uniformWrappers = [];
  let observeUniforms = true;
  const observe = (name, handler) => {
    const original = gl[name];
    const wrapped = function(...args) { return handler(original, args); };
    gl[name] = wrapped; uniformWrappers.push({name,original,wrapped});
  };
  observe('getUniformLocation', (original, args) => {
    const location = original.apply(gl,args), [target,name] = args;
    if (observeUniforms && location && uniformNames.includes(name)) {
      let values = uniformValues.get(target);
      if (!values) { values = new Map(); uniformValues.set(target,values); }
      uniformLocations.set(location,{target,name,values});
    }
    return location;
  });
  for (const method of ['uniform1i','uniform1f']) observe(method, (original, args) => {
    const returned = original.apply(gl,args), entry = uniformLocations.get(args[0]);
    if (observeUniforms && entry && entry.target === program && uniformValues.get(program) === entry.values) {
      const value = args[1];
      entry.values.set(entry.name, typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ? value : null);
    }
    return returned;
  });
  observe('deleteProgram', (original, args) => {
    const returned = original.apply(gl,args);
    if (observeUniforms) uniformValues.delete(args[0]);
    return returned;
  });
  const submittedUniforms = target => Object.fromEntries(uniformNames.map(name =>
    [name,uniformValues.get(target)?.get(name) ?? null]));
  const stopUniformObservation = () => {
    observeUniforms = false;
    for (const {name,original,wrapped} of uniformWrappers) if (gl[name] === wrapped) gl[name] = original;
  };
  const id = value => { if (!value) return null; if (!ids.has(value)) ids.set(value, nextId++); return ids.get(value); };
  const emit = value => {
    if (sequence >= 1999) {
      if (sequence === 1999) console.info('HOME_NATIVE_RESTORE_DRAW ' + JSON.stringify({sequence:++sequence,event:'event-limit',limit:2000}));
      result.truncated=true;
      return;
    }
    console.info('HOME_NATIVE_RESTORE_DRAW ' + JSON.stringify({sequence:++sequence, timeMs:now(), ...value}));
  };
  const fingerprint = text => {
    const hashedLength=Math.min(text.length,65536);
    let hash = 2166136261;
    for (let i=0;i<hashedLength;i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return {hashedLength,fingerprint:'fnv1a32:' + (hash >>> 0).toString(16).padStart(8,'0')};
  };
  const create = gl.createShader.bind(gl);
  gl.createShader = type => {
    const shader=create(type);
    if (shader) shaders.set(shader,{type:type===gl.VERTEX_SHADER?'vertex':type===gl.FRAGMENT_SHADER?'fragment':'unknown'});
    return shader;
  };
  const source = gl.shaderSource.bind(gl);
  gl.shaderSource = (shader, text) => {
    shaders.set(shader, {...shaders.get(shader),id:id(shader), length:text.length, ...fingerprint(text)});
    return source(shader,text);
  };
  const attach = gl.attachShader.bind(gl);
  gl.attachShader = (target, shader) => {
    const list = programs.get(target) || [];
    list.push(shader); programs.set(target,list); return attach(target,shader);
  };
  const use = gl.useProgram.bind(gl);
  gl.useProgram = value => { program=value; return use(value); };
  const bind = gl.bindFramebuffer.bind(gl);
  gl.bindFramebuffer = (target,value) => {
    if (target === gl.FRAMEBUFFER || target === gl.DRAW_FRAMEBUFFER) framebuffer=value;
    return bind(target,value);
  };
  const setViewport = gl.viewport.bind(gl);
  gl.viewport = (...args) => { viewport=args.slice(); return setViewport(...args); };
  const describeProgram = target => ({program:id(target), shaders:(programs.get(target)||[]).map(shader=>shaders.get(shader)||{id:id(shader)})});
  for (const name of ['linkProgram','getProgramParameter']) {
    const original = gl[name].bind(gl);
    gl[name] = (...args) => {
      if (name === 'linkProgram' && observeUniforms) uniformValues.delete(args[0]);
      const measured = active && (name === 'linkProgram' || args[1] === gl.LINK_STATUS);
      if (!measured) return original(...args);
      const began=now(); emit({event:'query-before',method:name,...describeProgram(args[0])});
      try { return original(...args); }
      finally { emit({event:'query-after',method:name,durationMs:now()-began,...describeProgram(args[0])}); }
    };
  }
  for (const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']) {
    if (typeof gl[name] !== 'function') continue;
    const original = gl[name].bind(gl);
    gl[name] = (...args) => {
      if (!active) return original(...args);
      if (result.draws >= 600) {
        result.truncated=true; active=false; emit({event:'draw-limit',limit:600});
        return original(...args);
      }
      const draw=++result.draws, owner={draw,method:name,phase,...describeProgram(program),
        submittedUniforms:submittedUniforms(program),
        category:mesh?.userData?.category||null, mesh:(mesh?.name||'').slice(0,128),
        material:material?.type||null, originalMaterial:mesh?.material?.type||null,
        side:material?.side??null, transparent:material?.transparent??null,
        framebuffer:id(framebuffer), viewport, shadow:shadowCameras.get(camera)||null,
        count:Number(name.includes('Elements')?args[1]:args[2])||0,
        instances:name.endsWith('Instanced')?Number(args.at(-1)):1};
      emit({event:'draw-before',...owner});
      const began=now();
      try {
        const value=original(...args);
        emit({event:'draw-after',...owner,submissionMs:now()-began});
        return value;
      } catch (error) {
        emit({event:'draw-error',...owner,error:String(error),submissionMs:now()-began}); throw error;
      }
    };
  }
  const direct = renderer.renderBufferDirect, render = renderer.render;
  // Context restoration replaces shadowMap; wrap its current instance only at
  // the first restored render, after Three has rebuilt its renderer state.
  const instrumentShadow = () => {
  const shadow = renderer.shadowMap.render;
  renderer.shadowMap.render = function(lights,...args) {
    const oldPhase=phase, oldCameras=shadowCameras, restore=[];
    phase='shadow'; shadowCameras=new Map();
    for (const light of lights) {
      const shadow=light.shadow;
      if (!shadow?.camera) continue;
      const metadata={light:id(light),type:light.type,name:(light.name||'').slice(0,128),mapSize:shadow.mapSize.toArray(),faceIndex:null};
      shadowCameras.set(shadow.camera,metadata);
      if (typeof shadow.updateMatrices === 'function') {
        const update=shadow.updateMatrices;
        // Three passes the point-shadow atlas face index here. Record the
        // original call rather than reconstructing it from rounded viewports.
        shadow.updateMatrices=function(...values) {
          if (this.isPointLightShadow) metadata.faceIndex=values[1]??0;
          return update.apply(this,values);
        };
        restore.push(()=>{shadow.updateMatrices=update;});
      }
    }
    try { return shadow.call(this,lights,...args); }
    finally { for(const reset of restore)reset();phase=oldPhase; shadowCameras=oldCameras; }
  };
  };
  renderer.renderBufferDirect = function(...args) {
    const old=[camera,material,mesh]; [camera,material,mesh]=[args[0],args[3],args[4]];
    try { return direct.apply(this,args); } finally { [camera,material,mesh]=old; }
  };
  renderer.render = function(scene,camera) {
    if (started || scene?.name === 'interaction-copy') return render.call(this,scene,camera);
    started=true;
    const state=stateFor(); result.state=state;
    // The diagnostic is scoped to the selected legacy diffuse profile.
    if (!state.profile?.diffuseLighting) {
      result.done=true; result.error='Expected the measured legacy diffuse profile';
      emit({event:'profile-rejected',state}); stopUniformObservation(); return render.call(this,scene,camera);
    }
    instrumentShadow();
    // Values remain unknown until an existing bind/viewport call is observed.
    emit({event:'frame-before',state,buffer:[gl.drawingBufferWidth,gl.drawingBufferHeight],viewport,
      stack:String(new Error().stack).split('\n').slice(1,10)});
    const began=now(); active=true;
    try { return render.call(this,scene,camera); }
    catch(error) { result.error=String(error); throw error; }
    finally {
      active=false; result.done=true; result.frameMs=now()-began;
      emit({event:'frame-after',...result,renderInfo:{...renderer.info.render}});
      stopUniformObservation();
    }
  };
}
