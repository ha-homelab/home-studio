// A fixed startup workload for Gecko's ambiguous Apple renderer label. It
// measures capacity, not GPU identity, and never allocates another context.
const capacityByContext = new WeakMap();
const rasterVertex = `#version 300 es
void main(){ vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2)); gl_Position=vec4(p*2.0-1.0,0,1); }`;
const rasterFragment = `#version 300 es
precision highp float;
uniform int iterations;
uniform float seed;
out vec4 outColor;
void main(){
 vec3 v=normalize(vec3(gl_FragCoord.xy*0.03125,seed));
 vec3 sum=vec3(0.0);
 for(int i=0;i<iterations;i++){
  float x=float(i)+seed;
  vec3 n=normalize(vec3(fract(x*0.713),fract(x*0.371),0.4)+v*0.03);
  float d=max(dot(v,n),0.0);
  vec3 h=normalize(n+vec3(0.0,0.0,1.0));
  float s=pow(max(dot(v,h),0.0),16.0);
  sum+=vec3(d*0.003)+vec3(s*0.002);
  v=normalize(v+vec3(d,s,fract(x))*0.00071);
 }
 outColor=vec4(sum*0.25,1.0);
}`;

function measureAppleRaster(gl) {
  const started = performance.now(), shaders = [], samplesMs = [], pixels = [];
  let saved, program, texture, framebuffer, vertexArray;
  let result = { status: 'unavailable' };
  try {
    if (gl.isContextLost()) return result;
    // The caller runs this immediately after constructing its renderer. Direct
    // GL calls are fully reversed; Three's state cache is never changed. Do not
    // call resetState(): it would alter unrelated GL state and cache entries.
    const flags = ['DEPTH_TEST', 'STENCIL_TEST', 'BLEND', 'SCISSOR_TEST', 'CULL_FACE',
      'RASTERIZER_DISCARD', 'DITHER', 'POLYGON_OFFSET_FILL', 'SAMPLE_ALPHA_TO_COVERAGE', 'SAMPLE_COVERAGE'];
    const packs = ['PACK_ALIGNMENT', 'PACK_ROW_LENGTH', 'PACK_SKIP_PIXELS', 'PACK_SKIP_ROWS'];
    saved = {
      program: gl.getParameter(gl.CURRENT_PROGRAM),
      draw: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), read: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
      viewport: gl.getParameter(gl.VIEWPORT), mask: gl.getParameter(gl.COLOR_WRITEMASK),
      // ACTIVE_TEXTURE is never changed; only its current binding is touched.
      texture: gl.getParameter(gl.TEXTURE_BINDING_2D), vertexArray: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
      packBuffer: gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING),
      flags: flags.map(name => [gl[name], gl.isEnabled(gl[name])]),
      packs: packs.map(name => [gl[name], gl.getParameter(gl[name])]),
    };
    program = gl.createProgram();
    if (!program) throw Error('Probe program unavailable');
    for (const [type, source] of [[gl.VERTEX_SHADER, rasterVertex], [gl.FRAGMENT_SHADER, rasterFragment]]) {
      const shader = gl.createShader(type);
      if (!shader) throw Error('Probe shader unavailable');
      shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error('Probe shader did not compile');
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error('Probe program did not link');
    texture = gl.createTexture(); framebuffer = gl.createFramebuffer(); vertexArray = gl.createVertexArray();
    if (!texture || !framebuffer || !vertexArray) throw Error('Probe surface unavailable');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 32, 32);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw Error('Incomplete probe surface');
    gl.bindVertexArray(vertexArray); gl.useProgram(program);
    const iterations = gl.getUniformLocation(program, 'iterations'), seed = gl.getUniformLocation(program, 'seed');
    if (iterations === null || seed === null) throw Error('Probe uniforms unavailable');
    gl.uniform1i(iterations, 512);
    gl.viewport(0, 0, 32, 32); gl.colorMask(true, true, true, true);
    for (const [flag] of saved.flags) gl.disable(flag);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    for (const [parameter] of saved.packs) gl.pixelStorei(parameter, parameter === gl.PACK_ALIGNMENT ? 1 : 0);
    const pixel = new Uint8Array(4);
    for (let draw = 0; draw < 5; draw++) {
      pixel.fill(0);
      gl.uniform1f(seed, 0.25 + draw * 0.03125);
      const before = performance.now();
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(16, 16, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      const elapsed = performance.now() - before;
      if (!Number.isFinite(elapsed) || elapsed < 0 || gl.isContextLost() ||
          pixel[3] !== 255 || !pixel.slice(0, 3).every(value => value > 0 && value < 255)) throw Error('Invalid probe readback');
      pixels.push(Array.from(pixel));
      if (draw >= 2) samplesMs.push(elapsed);
    }
    if (!pixels.some(pixel => pixel.some((value, index) => value !== pixels[0][index]))) throw Error('Unchanging probe readback');
    result = { status: 'measured', samplesMs, pixels, bestMs: Math.min(...samplesMs) };
  } catch { /* Unsupported or failed probes keep the normal rendering profile. */ }
  finally {
    // Keep cleaning up if a host GL wrapper throws during a restoration call.
    const clean = action => { try { action(); } catch { result = { status: 'unavailable' }; } };
    if (saved) {
      clean(() => gl.useProgram(saved.program)); clean(() => gl.bindVertexArray(saved.vertexArray));
      clean(() => gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, saved.draw));
      clean(() => gl.bindFramebuffer(gl.READ_FRAMEBUFFER, saved.read));
      clean(() => gl.bindTexture(gl.TEXTURE_2D, saved.texture));
      clean(() => gl.bindBuffer(gl.PIXEL_PACK_BUFFER, saved.packBuffer));
      clean(() => gl.viewport(...saved.viewport)); clean(() => gl.colorMask(...saved.mask));
      for (const [flag, enabled] of saved.flags) clean(() => enabled ? gl.enable(flag) : gl.disable(flag));
      for (const [parameter, value] of saved.packs) clean(() => gl.pixelStorei(parameter, value));
    }
    if (vertexArray) clean(() => gl.deleteVertexArray(vertexArray));
    if (framebuffer) clean(() => gl.deleteFramebuffer(framebuffer));
    if (texture) clean(() => gl.deleteTexture(texture));
    if (program) clean(() => gl.deleteProgram(program));
    for (const shader of shaders) clean(() => gl.deleteShader(shader));
  }
  const totalMs = performance.now() - started;
  return Number.isFinite(totalMs) && totalMs >= 0 ? { ...result, totalMs } : { status: 'unavailable' };
}

export function getRenderCapacity(gl, userAgent = globalThis.navigator?.userAgent || '') {
  const normal = { reduced: false, diffuseLighting: false };
  try {
    if (capacityByContext.has(gl)) return capacityByContext.get(gl);
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
    let result = normal;
    if (/swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render|lavapipe|^Apple Software Renderer$/i.test(name)) {
      result = { reduced: true, diffuseLighting: /^Apple Software Renderer$/i.test(name) };
    } else if (name === 'Apple M1, or similar' && /\bGecko\/\d/.test(userAgent)) {
      const rasterProbe = measureAppleRaster(gl);
      const slow = rasterProbe.status === 'measured' && rasterProbe.bestMs >= 15;
      result = { reduced: slow, diffuseLighting: slow, rasterProbe };
    }
    capacityByContext.set(gl, result);
    return result;
  } catch { return normal; }
}
