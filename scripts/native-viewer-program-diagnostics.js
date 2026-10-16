// Injected only into the fictional native viewer, before WebGL construction.
// No source hashes, GL queries, extra draws or unbounded per-frame records.
function installNativeViewerProgramObserver(expected) {
  const contexts = [], errors = [], seen = new WeakSet();
  const fail = message => { if (errors.length < 16) errors.push(message); };
  let scope = null;
  window.__nativeTrackViewerContext = (gl, canvas) => {
    if (seen.has(gl)) return;
    seen.add(gl);
    if (contexts.length >= 2) { fail('Context ledger limit'); return; }
    const context = {id: contexts.length + 1, epoch: 0, links: []};
    contexts.push(context);
    const shaders = new WeakMap(), programs = new WeakMap();
    let shaderCount = 0, programCount = 0, active = null;
    canvas.addEventListener('webglcontextrestored', () => { context.epoch++; active = null; });
    const create = gl.createShader;
    gl.createShader = function(type) {
      const shader = create.call(this, type);
      if (shader) {
        if (++shaderCount > 256) fail('Shader ledger limit');
        else shaders.set(shader, {type, copy: false});
      }
      return shader;
    };
    const source = gl.shaderSource;
    gl.shaderSource = function(shader, text) {
      const result = source.call(this, shader, text), item = shaders.get(shader);
      if (item) item.copy = typeof text === 'string' && text === expected[item.type === gl.VERTEX_SHADER ? 'vertex' : item.type === gl.FRAGMENT_SHADER ? 'fragment' : 'unsupported'];
      return result;
    };
    const attach = gl.attachShader, detach = gl.detachShader;
    gl.attachShader = function(program, shader) {
      const result = attach.call(this, program, shader);
      let item = programs.get(program);
      if (!item) {
        if (++programCount > 128) { fail('Program ledger limit'); return result; }
        item = {id: programCount, shaders: new Set(), latest: null}; programs.set(program, item);
      }
      if (item.shaders.size >= 4) fail('Attachment ledger limit'); else item.shaders.add(shader);
      return result;
    };
    gl.detachShader = function(program, shader) {
      const result = detach.call(this, program, shader); programs.get(program)?.shaders.delete(shader); return result;
    };
    const link = gl.linkProgram;
    gl.linkProgram = function(program) {
      const result = link.call(this, program), item = programs.get(program);
      if (!item || context.links.length >= 128) { fail('Incomplete link ledger'); return result; }
      const attached = [...item.shaders].map(shader => shaders.get(shader));
      const exactCopy = attached.length === 2 && attached.every(shader => shader?.copy) &&
        attached.some(shader => shader.type === gl.VERTEX_SHADER) && attached.some(shader => shader.type === gl.FRAGMENT_SHADER);
      const event = {ordinal: context.links.length + 1, program: item.id, epoch: context.epoch,
        exactCopy, copyDraws: 0, outsideCopyDraw: false};
      if (exactCopy) event.sources = {...expected}; // Only the tiny known pair is retained.
      item.latest = event; context.links.push(event); return result;
    };
    const use = gl.useProgram;
    gl.useProgram = function(program) { const result = use.call(this, program); active = program; return result; };
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      const draw = gl[name];
      gl[name] = function(...args) {
        const result = draw.apply(this, args), event = programs.get(active)?.latest;
        if (!event || event.epoch !== context.epoch) fail('Draw without current linked program');
        else if (scope?.copy) event.copyDraws++;
        else event.outsideCopyDraw = true;
        return result;
      };
    }
  };
  window.__nativeViewerPrograms = {
    snapshot() { return JSON.parse(JSON.stringify({contexts, errors})); },
    attachRenderer(renderer) {
      const render = renderer.render;
      renderer.render = function(scene, camera) {
        const previous = scope, child = scene?.children?.[0], material = child?.material;
        // The actual GL program is additionally matched at every submitted draw.
        scope = {copy: scene?.name === 'interaction-copy' && scene.children?.length === 1 && child.isMesh === true &&
          material?.isRawShaderMaterial === true && material.vertexShader === expected.rawVertex && material.fragmentShader === expected.rawFragment};
        try { return render.call(this, scene, camera); } finally { scope = previous; }
      };
    },
  };
}
