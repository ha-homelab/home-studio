const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'planner/render-capacity.js'), 'utf8');
const gecko = 'Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/153.0';

function fixture({name = 'Apple M1, or similar', times = [30, 30, 16, 17, 18], failure} = {}) {
  let now = 0, draws = 0;
  const created = new Set(), deleted = new Set(), flags = new Map(), state = new Map();
  const gl = {};
  for (const key of ['CURRENT_PROGRAM','DRAW_FRAMEBUFFER_BINDING','READ_FRAMEBUFFER_BINDING','VIEWPORT','COLOR_WRITEMASK',
    'TEXTURE_BINDING_2D','ACTIVE_TEXTURE','VERTEX_ARRAY_BINDING','PIXEL_PACK_BUFFER_BINDING','DEPTH_TEST','STENCIL_TEST','BLEND','SCISSOR_TEST',
    'CULL_FACE','RASTERIZER_DISCARD','DITHER','POLYGON_OFFSET_FILL','SAMPLE_ALPHA_TO_COVERAGE','SAMPLE_COVERAGE',
    'PACK_ALIGNMENT','PACK_ROW_LENGTH','PACK_SKIP_PIXELS','PACK_SKIP_ROWS','VERTEX_SHADER','FRAGMENT_SHADER','COMPILE_STATUS',
    'LINK_STATUS','TEXTURE_2D','RGBA8','FRAMEBUFFER','DRAW_FRAMEBUFFER','READ_FRAMEBUFFER','COLOR_ATTACHMENT0',
    'FRAMEBUFFER_COMPLETE','PIXEL_PACK_BUFFER','TRIANGLES','RGBA','UNSIGNED_BYTE']) gl[key] = key;
  for (const key of Object.keys(gl)) {state.set(key, {old: key}); flags.set(key, true);}
  // Start on unit7 with a separate, live unit0 texture; the probe must preserve both.
  state.set(gl.ACTIVE_TEXTURE, 7);
  const textures = new Map([[0, {old:'unit0'}], [7, state.get(gl.TEXTURE_BINDING_2D)]]), initialTextures = new Map(textures);
  gl.activeTexture = unit => state.set(gl.ACTIVE_TEXTURE, unit);
  state.set(gl.VIEWPORT, [9, 8, 700, 500]); state.set(gl.COLOR_WRITEMASK, [false, true, false, true]);
  for (const key of ['PACK_ALIGNMENT','PACK_ROW_LENGTH','PACK_SKIP_PIXELS','PACK_SKIP_ROWS']) state.set(key, 8);
  const initialState = new Map(state), initialFlags = new Map(flags);
  gl.getExtension = () => ({UNMASKED_RENDERER_WEBGL: 'NAME'});
  gl.getParameter = key => key === 'NAME' ? name : state.get(key);
  gl.isEnabled = flag => flags.get(flag);
  gl.enable = flag => flags.set(flag, true); gl.disable = flag => flags.set(flag, false);
  gl.isContextLost = () => failure === 'lost' && draws > 0;
  for (const type of ['Program','Shader','Texture','Framebuffer','VertexArray']) {
    gl['create' + type] = () => { if (failure === 'create' + type) return null; const handle = {type}; created.add(handle); return handle; };
    gl['delete' + type] = handle => {assert(created.has(handle)); assert(!deleted.has(handle)); deleted.add(handle);};
  }
  gl.shaderSource = () => {}; gl.compileShader = () => {}; gl.attachShader = () => {}; gl.linkProgram = () => {};
  gl.getShaderParameter = () => failure !== 'compile'; gl.getProgramParameter = () => failure !== 'link';
  gl.bindTexture = (_, value) => { textures.set(state.get(gl.ACTIVE_TEXTURE), value); state.set(gl.TEXTURE_BINDING_2D, value); };
  gl.bindVertexArray = value => state.set(gl.VERTEX_ARRAY_BINDING, value);
  gl.bindBuffer = (_, value) => state.set(gl.PIXEL_PACK_BUFFER_BINDING, value);
  gl.bindFramebuffer = (target, value) => {
    if (target !== gl.READ_FRAMEBUFFER) state.set(gl.DRAW_FRAMEBUFFER_BINDING, value);
    if (target !== gl.DRAW_FRAMEBUFFER) state.set(gl.READ_FRAMEBUFFER_BINDING, value);
  };
  gl.texStorage2D = (...args) => assert.deepEqual(args, [gl.TEXTURE_2D, 1, gl.RGBA8, 32, 32]);
  gl.framebufferTexture2D = () => {};
  gl.checkFramebufferStatus = () => failure === 'framebuffer' ? 'INCOMPLETE' : gl.FRAMEBUFFER_COMPLETE;
  gl.useProgram = value => state.set(gl.CURRENT_PROGRAM, value);
  gl.getUniformLocation = (_, uniform) => failure === 'uniform' ? null : uniform;
  gl.uniform1i = (_, value) => assert.equal(value, 512); gl.uniform1f = () => {};
  gl.viewport = (...value) => state.set(gl.VIEWPORT, value); gl.colorMask = (...value) => state.set(gl.COLOR_WRITEMASK, value);
  gl.pixelStorei = (parameter, value) => state.set(parameter, value);
  gl.drawArrays = (...args) => {
    assert.deepEqual(args, [gl.TRIANGLES, 0, 3]); draws++;
    assert.equal(state.get(gl.PIXEL_PACK_BUFFER_BINDING), null);
    assert.deepEqual(state.get(gl.VIEWPORT), [0,0,32,32]);
    assert.deepEqual(state.get(gl.COLOR_WRITEMASK), [true,true,true,true]);
    assert.equal(flags.get(gl.RASTERIZER_DISCARD), false);
    if (failure === 'draw') throw Error('driver exception');
  };
  gl.readPixels = (x, y, width, height, format, type, pixel) => {
    assert.deepEqual([x,y,width,height,format,type], [16,16,1,1,gl.RGBA,gl.UNSIGNED_BYTE]);
    now += times[draws - 1];
    pixel.set(failure === 'blank' ? [0,0,0,255] : failure === 'transparent' ? [48,40,33,0] :
      failure === 'white' ? [255,255,255,255] : failure === 'constant' ? [88,88,88,255] : [88+draws,88+draws,88+draws,255]);
  };
  const context = vm.createContext({performance: {now: () => now}});
  vm.runInContext(source.replace('export function ', 'function '), context);
  return {gl, context, get: (ua = gecko) => context.getRenderCapacity(gl, ua), created, deleted,
    draws: () => draws, clean: () => { assert.deepEqual(state, initialState); assert.deepEqual(flags, initialFlags); assert.deepEqual(deleted, created); assert.deepEqual(textures, initialTextures); }};
}

test('only exact masked Apple renderer on Gecko runs a probe', () => {
  for (const name of ['Apple M1','Apple M2','Apple Software Renderer, or similar','ANGLE Metal Renderer: Apple M1','']) {
    const f = fixture({name}); assert.equal(f.get().reduced, false); assert.equal(f.draws(), 0); f.clean();
  }
  for (const ua of ['', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0']) {
    const f = fixture(); assert.equal(f.get(ua).reduced, false); assert.equal(f.draws(), 0); f.clean();
  }
});
test('positive software identification retains existing profiles without probing', () => {
  for (const name of ['Apple Software Renderer','SwiftShader','llvmpipe','softpipe','Microsoft Basic Render Driver','lavapipe']) {
    const f = fixture({name}), result = f.get(); assert.equal(result.reduced, true);
    assert.equal(result.diffuseLighting, name === 'Apple Software Renderer'); assert.equal(f.draws(), 0); f.clean();
  }
});
test('two warm draws and all three measured draws must be slow; result cached per context', () => {
  for (const [times, slow] of [[[100,100,15,16,17], true], [[100,100,30,1,30], false], [[1,1,14.99,20,30], false]]) {
    const f = fixture({times}), result = f.get(); assert.equal(result.reduced, slow); assert.equal(result.diffuseLighting, slow);
    assert.equal(result.rasterProbe.status, 'measured'); assert(Math.abs(result.rasterProbe.bestMs - Math.min(...times.slice(2))) < 1e-9);
    result.rasterProbe.samplesMs.forEach((value, index) => assert(Math.abs(value - times[index + 2]) < 1e-9)); assert.equal(result.rasterProbe.totalMs, times.reduce((a,b)=>a+b));
    assert.equal(f.get(), result); assert.equal(f.draws(), 5); f.clean();
    const replacement = fixture({times}); replacement.get(); assert.equal(replacement.draws(), 5); replacement.clean();
  }
});
test('all partial allocation, compile, link, framebuffer, draw and readback failures clean up and retain normal profile', () => {
  for (const failure of ['createProgram','createShader','createTexture','createFramebuffer','createVertexArray',
    'compile','link','framebuffer','uniform','draw','blank','transparent','white','constant','lost']) {
    const f = fixture({failure}), result = f.get(); assert.equal(result.reduced, false, failure); assert.equal(result.diffuseLighting, false);
    assert.equal(result.rasterProbe.status, 'unavailable'); assert.equal(f.get(), result, 'Failed probe is not repeatedly retried'); f.clean();
  }
});
test('invalid timing never selects a reduced profile', () => {
  for (const value of [-1, NaN, Infinity]) { const f = fixture({times:[1,1,value,16,16]}); assert.equal(f.get().reduced, false); f.clean(); }
});
test('viewer compiler embeds the same helper without runtime imports or template remnants', () => {
  const compiled = execFileSync('python3', ['-c', `from pathlib import Path
import json
from planner.project import render_viewer
from geometry import create_geometry
# Compiler rendering needs only the public viewer metadata fields below.
data={'title':'Test','id':'test','next_floor':None,'meshes':[],'calibration':{'reference_size':[1,1]}}
print(render_viewer(data,'<svg/>'))`], {cwd:root, encoding:'utf8', maxBuffer:8 * 1024 * 1024});
  assert(compiled.includes(source.replace('export function getRenderCapacity', 'function getRenderCapacity')));
  assert(!compiled.includes('__RENDER_CAPACITY_JS__'));
  assert(!compiled.includes('export function getRenderCapacity'));
  assert(fs.readFileSync(path.join(root,'planner/editor.js'),'utf8').includes("import { getRenderCapacity } from './render-capacity.js'"));
});


test('both real profile selectors use measured capacity and retain its evidence', () => {
  for (const [times, reduced] of [[[30,30,16,17,18],true], [[1,1,1,1,1],false]]) {
    const f = fixture({times}), capacity = f.get();
    const viewer = fs.readFileSync(path.join(root,'viewer.js'),'utf8').split('\n').find(line => line.startsWith('function selectRenderProfile('));
    const planner = fs.readFileSync(path.join(root,'planner/editor.js'),'utf8');
    const a = planner.indexOf('function previewRenderProfile('), b = planner.indexOf('\nfunction initPreview()',a);
    vm.runInContext(viewer + '\n' + planner.slice(a,b), f.context);
    const v = f.context.selectRenderProfile(f.gl), p = f.context.previewRenderProfile(f.gl);
    for (const profile of [v,p]) {
      assert.equal(profile.pixels, reduced ? 250000 : 2000000);
      assert.equal(profile.diffuseLighting, reduced);
      assert.equal(profile.rasterProbe, capacity.rasterProbe);
    }
    assert.equal(v.pointShadows, reduced ? 2 : 8); assert.equal(v.pointShadowSize, reduced ? 128 : 512);
    assert.equal(v.sunShadowSize, reduced ? 512 : 2048); assert.equal(p.shadowSize, reduced ? 512 : 2048);
    assert.equal(p.instanceCatalog, reduced); assert.equal(f.draws(),5); f.clean();
  }
});
