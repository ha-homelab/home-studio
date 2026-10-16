// Exact native link/source attribution, including pinned Three expansion; no GPU.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const payload = JSON.parse(execFileSync('python3', ['-c', "import importlib.util,json,sys;sys.path.insert(0,'scripts');s=importlib.util.spec_from_file_location('a','scripts/test-waterfox-acceptance.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps({'sources':m.COPY_SOURCES,'nativeGL':m.NATIVE_GL_DIAGNOSTICS,'frame':m.NATIVE_VIEWER_FRAME_DIAGNOSTICS}))"], {cwd:root, encoding:'utf8'}));
const expected = payload.sources;
const source = fs.readFileSync(path.join(__dirname, 'native-viewer-program-diagnostics.js'), 'utf8');
let cases = 0;
function fixture() {
  const handlers = {}, calls = [];
  const gl = {VERTEX_SHADER:35633, FRAGMENT_SHADER:35632,
    createShader(type) {return {type};}, shaderSource(){}, attachShader(){}, detachShader(){}, linkProgram(){}, useProgram(){},
    drawArrays(){calls.push('draw');}, drawElements(){calls.push('draw');}, drawArraysInstanced(){calls.push('draw');}, drawElementsInstanced(){calls.push('draw');}};
  const canvas = {addEventListener(name, fn){handlers[name] = fn;}}, context = vm.createContext({window:{}});
  vm.runInContext(source, context); context.installNativeViewerProgramObserver(expected);
  context.window.__nativeTrackViewerContext(gl, canvas);
  const api = context.window.__nativeViewerPrograms;
  const make = (vertex=expected.vertex, fragment=expected.fragment, program={}) => {
    for(const [type,text] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]) {
      const shader=gl.createShader(type);gl.shaderSource(shader,text);gl.attachShader(program,shader);
    }
    gl.linkProgram(program);return program;
  };
  const copy = {name:'interaction-copy', children:[{isMesh:true,material:{isRawShaderMaterial:true,vertexShader:expected.rawVertex,fragmentShader:expected.rawFragment}}]};
  const renderer = {render(scene){gl.useProgram(scene.program);gl.drawArrays();}};api.attachRenderer(renderer);
  const snapshot = () => JSON.parse(JSON.stringify(api.snapshot()));
  return {gl, api, make, copy, renderer, snapshot, handlers, calls};
}
{
 const f=fixture(),p=f.make();f.copy.program=p;f.renderer.render(f.copy);
 const x=f.snapshot();assert.deepEqual(x.errors,[]);assert.equal(x.contexts.length,1);
 assert.deepEqual(x.contexts[0].links[0],{ordinal:1,program:1,epoch:0,exactCopy:true,copyDraws:1,outsideCopyDraw:false,sources:expected});cases++;
}
for (const [vertex,fragment] of [[expected.vertex+' ',expected.fragment],[expected.vertex,expected.fragment.replace('texture2D','texture')],['#version 300 es\n'+expected.vertex,expected.fragment],['x'.repeat(1000000),expected.fragment]]) {
 const f=fixture();f.make(vertex,fragment);const x=f.snapshot().contexts[0].links[0];
 assert.equal(x.exactCopy,false);assert(!('sources' in x));assert(JSON.stringify(x).length<200);cases++;
}
{
 const f=fixture(),p=f.make();f.gl.linkProgram(p);const x=f.snapshot().contexts[0].links;
 assert.equal(x.length,2);assert.equal(x[0].program,x[1].program);assert.equal(x[1].ordinal,2);cases++;
}
{
 const f=fixture(),p=f.make();f.renderer.render({name:'ordinary',program:p});
 assert.equal(f.snapshot().contexts[0].links[0].outsideCopyDraw,true);assert.equal(f.snapshot().contexts[0].links[0].copyDraws,0);cases++;
}
for (const mutation of [c=>c.children.push(c.children[0]),c=>c.children[0].material.vertexShader+=' ',c=>c.children[0].isMesh=false]) {
 const f=fixture(),p=f.make();f.copy.program=p;mutation(f.copy);f.renderer.render(f.copy);
 assert.equal(f.snapshot().contexts[0].links[0].copyDraws,0);cases++;
}
{
 const f=fixture(),p=f.make();f.copy.program=p;
 const broken={render(){throw Error('original draw failure');}};f.api.attachRenderer(broken);
 assert.throws(()=>broken.render(f.copy),/original draw failure/);f.gl.useProgram(p);f.gl.drawElements();
 assert.equal(f.snapshot().contexts[0].links[0].outsideCopyDraw,true);cases++;
}
{
 const f=fixture(),p=f.make();f.handlers.webglcontextrestored();f.gl.useProgram(p);f.gl.drawArrays();
 assert(f.snapshot().errors.includes('Draw without current linked program'));
 const next=f.make();f.copy.program=next;f.renderer.render(f.copy);assert.equal(f.snapshot().contexts[0].links[1].epoch,1);cases++;
}
{
 const f=fixture(),p=f.make();for(let i=0;i<128;i++)f.gl.linkProgram(p);
 assert.equal(f.snapshot().contexts[0].links.length,128);assert(f.snapshot().errors.includes('Incomplete link ledger'));cases++;
}
{
 const f=fixture();const p={},v=f.gl.createShader(f.gl.VERTEX_SHADER),w=f.gl.createShader(f.gl.VERTEX_SHADER);
 for(const shader of [v,w]){f.gl.shaderSource(shader,expected.vertex);f.gl.attachShader(p,shader);}f.gl.linkProgram(p);
 assert.equal(f.snapshot().contexts[0].links[0].exactCopy,false);f.gl.detachShader(p,w);f.gl.linkProgram(p);
 assert.equal(f.snapshot().contexts[0].links[1].exactCopy,false);cases++;
}
// Exercise the actual native GL insertion point, not only the direct tracker API.
{
 const handlers={}, raw={VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,NO_ERROR:0,
  createShader:type=>({type}),shaderSource(){},attachShader(){},detachShader(){},linkProgram(){},useProgram(){},
  drawArrays(){},drawElements(){},drawArraysInstanced(){},drawElementsInstanced(){},getError:()=>0,isContextLost:()=>false,getExtension:()=>null};
 class Canvas {getContext(){return raw;}addEventListener(name,fn){(handlers[name]??=[]).push(fn);}}
 const canvas=new Canvas(), env={window:{addEventListener(){}},HTMLCanvasElement:Canvas,document:{readyState:'complete'},parent:{}};
 const context=vm.createContext(env);vm.runInContext(source,context);context.installNativeViewerProgramObserver(expected);
 vm.runInContext(payload.nativeGL,context);const gl=canvas.getContext('webgl2');
 assert.equal(context.window.__nativeViewerPrograms.snapshot().contexts.length,1);
 for(const [type,text] of [[gl.VERTEX_SHADER,expected.vertex],[gl.FRAGMENT_SHADER,expected.fragment]]){const shader=gl.createShader(type);gl.shaderSource(shader,text);gl.attachShader(raw,shader);}
 gl.linkProgram(raw);assert.equal(context.window.__nativeViewerPrograms.snapshot().contexts[0].links[0].exactCopy,true);
 new vm.Script(payload.frame);cases++;
}
(async()=>{
 const vendor=fs.readFileSync(path.join(root,'vendor/three.module.min.js'),'utf8');
 assert(vendor.includes('function bl(t,e,n,i){')&&vendor.includes('function Al(t,e,n,i,r,s,a){'));
 // Pinned Three installs restoration before calling getContext; its restore
 // callback rebuilds renderer state without rendering. Our epoch listener is
 // therefore active before the later viewer restore callback can draw.
 const listener=vendor.indexOf('n.addEventListener("webglcontextrestored",Pt,!1)');
 assert(listener>0&&vendor.indexOf('St=bt(t,e)',listener)>listener);
 const restore=vendor.slice(vendor.indexOf('function Pt(){',listener),vendor.indexOf('function Lt(',listener));
 assert(restore.includes('Tt()'));assert(!restore.includes('.render(')&&!restore.includes('.compile('));cases++;
 const THREE=await import('data:text/javascript;base64,'+Buffer.from(vendor+'\nexport {bl as TestProgram,Al as TestPrograms};').toString('base64'));
 const interaction=await import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync(path.join(root,'planner/interaction-render.js'),'utf8')).toString('base64'));
 let material,mesh;
 const capture={getRenderTarget:()=>null,getScissorTest:()=>false,getDrawingBufferSize:v=>v.set(632,394),initTexture(){},compile(scene){mesh=scene.children[0];material=mesh.material;throw Error('captured');}};
 assert.throws(()=>interaction.createInteractionRenderer(THREE,capture).draw({}, {}, true),/captured/);
 const submitted=[],gl={VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,createProgram:()=>({}),createShader:type=>({type}),shaderSource(s,text){submitted.push([s.type,text]);},compileShader(){},attachShader(){},linkProgram(){},bindAttribLocation(){}};
 const renderer={getContext:()=>gl,getRenderTarget:()=>null,outputColorSpace:THREE.SRGBColorSpace,toneMapping:THREE.ACESFilmicToneMapping,shadowMap:{enabled:true,type:THREE.BasicShadowMap},debug:{checkShaderErrors:false}},bindings={releaseStatesOfProgram(){}};
 const programs=new THREE.TestPrograms(renderer,{get:()=>null},{get:()=>null},{has:()=>false},{precision:'highp',getMaxPrecision:x=>x,vertexTextures:true,logarithmicDepthBuffer:false,reverseDepthBuffer:false},bindings,{numPlanes:1,numIntersection:0});
 const lights={directional:[],point:[],spot:[],spotLightMap:[],rectArea:[],hemi:[],directionalShadowMap:[],pointShadowMap:[],spotShadowMap:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};
 const p=programs.getParameters(material,lights,[],new THREE.Scene(),mesh);new THREE.TestProgram(renderer,programs.getProgramCacheKey(p),p,bindings);
 assert.deepEqual(submitted,[[gl.VERTEX_SHADER,expected.vertex],[gl.FRAGMENT_SHADER,expected.fragment]]);
 assert.equal(material.vertexShader,expected.rawVertex);assert.equal(material.fragmentShader,expected.rawFragment);cases++;
 console.log(JSON.stringify({status:'passed',observerCases:cases,pinnedCopyVertexBytes:expected.vertex.length,pinnedCopyFragmentBytes:expected.fragment.length,actualGPUCompilation:false}));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
