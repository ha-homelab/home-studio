const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname,'native-draw-diagnostic.js'),'utf8');

function fixture({draws=1, diffuse=true, failFinish=0, beforeDraw=()=>{}, uploadError=null}={}) {
  const events=[], calls={render:0,draw:0,finish:0,queries:0};
  const uniformCalls=[], locations=new WeakMap();
  let clock=0;
  const gl={FRAMEBUFFER:1,DRAW_FRAMEBUFFER:2,FRAMEBUFFER_BINDING:3,VIEWPORT:4,
    LINK_STATUS:5,VERTEX_SHADER:6,FRAGMENT_SHADER:7,drawingBufferWidth:100,drawingBufferHeight:80,
    createShader:()=>({}), shaderSource(){},attachShader(){},useProgram(){},
    getUniformLocation(target,name){
      uniformCalls.push(['getUniformLocation',target,name]);
      if(name==='absent')return null;
      if(!locations.has(target))locations.set(target,new Map());
      const names=locations.get(target);if(!names.has(name))names.set(name,{});return names.get(name);
    },
    uniform1i(...args){uniformCalls.push(['uniform1i',...args]);if(uploadError)throw uploadError;return 17;},
    uniform1f(...args){uniformCalls.push(['uniform1f',...args]);if(uploadError)throw uploadError;return 19;},
    deleteProgram(target){uniformCalls.push(['deleteProgram',target]);},
    bindFramebuffer(){},viewport(){},linkProgram(){},getProgramParameter(){return true;},
    getParameter(p){calls.queries++;return p===3?null:[0,0,100,80];},
    drawElements(){calls.draw++;},finish(){calls.finish++;clock+=3;if(calls.finish===failFinish)throw Error('GPU failed');}};
  const camera={}, light={type:'PointLight',name:'synthetic lamp',shadow:{camera,isPointLightShadow:true,updateMatrices(){},mapSize:{toArray:()=>[128,128]}}};
  const program={}, framebuffer={}, material={type:'MeshLambertMaterial',side:2,transparent:false};
  const mesh={name:'fictional floor',userData:{category:'floors'},material};
  const renderer={getContext:()=>gl,info:{render:{calls:draws}},
    renderBufferDirect(camera,fog,geometry,material,mesh){
      gl.useProgram(program);beforeDraw({gl,program,index:calls.draw});gl.drawElements(4,36,5123,0);
    },
    shadowMap:{render(){light.shadow.updateMatrices(light,3);renderer.renderBufferDirect(camera,null,null,{type:'MeshDistanceMaterial',side:0,transparent:false},mesh);}},
    render(scene){
      calls.render++;
      const vertex=gl.createShader(gl.VERTEX_SHADER),fragment=gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(vertex,'vertex');gl.shaderSource(fragment,'fragment');
      gl.attachShader(program,vertex);gl.attachShader(program,fragment);
      gl.linkProgram(program);gl.getProgramParameter(program,gl.LINK_STATUS);
      if(scene.shadow){gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.viewport(0,0,256,128);renderer.shadowMap.render([light]);}
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,null);gl.viewport(0,0,100,80);
      for(let i=0;i<draws;i++)renderer.renderBufferDirect({},null,null,material,mesh);
    }};
  const context={window:{},console:{info(line){events.push(JSON.parse(line.slice('HOME_NATIVE_DRAW '.length)));}},
    performance:{now:()=>++clock}};
  const originalUniformMethods=Object.fromEntries(['getUniformLocation','uniform1i','uniform1f','deleteProgram'].map(name=>[name,gl[name]]));
  vm.runInNewContext(source+'\nthis.attach=attachNativeDrawDiagnostic;',context);
  context.attach(renderer,()=>({connected:false,renderCount:0,profile:{diffuseLighting:diffuse}}));
  return {renderer,gl,calls,events,uniformCalls,originalUniformMethods,result:context.window.__nativeDrawDiagnostic};
}

test('only one naturally requested scene frame is fenced; queries and later frames are untouched',()=>{
  const f=fixture();assert.deepEqual(f.calls,{render:0,draw:0,finish:0,queries:0});
  f.renderer.render({shadow:true});
  assert.deepEqual(f.calls,{render:1,draw:2,finish:5,queries:2});
  assert.equal(f.result.done,true);assert.equal(f.result.draws,2);
  const before=f.events.filter(e=>e.event==='draw-before');
  assert.equal(before[0].phase,'shadow');assert.equal(before[0].shadow.type,'PointLight');
  assert.equal(before[0].shadow.faceIndex,3);
  assert.equal(before[0].material,'MeshDistanceMaterial');assert.equal(before[0].originalMaterial,'MeshLambertMaterial');
  assert.ok(before[0].framebuffer);assert.deepEqual(before[0].viewport,[0,0,256,128]);
  assert.equal(before[1].phase,'main');assert.equal(before[1].framebuffer,null);
  assert.equal(before[1].category,'floors');assert.deepEqual(before[1].shaders.map(s=>s.type),['vertex','fragment']);
  assert.ok(before[1].shaders.every(s=>/^fnv1a32:[a-f0-9]{8}$/.test(s.fingerprint)));
  assert.equal(f.events.filter(e=>e.event==='query-before').length,2);
  assert.ok(f.events.some(e=>e.event==='draw-after'&&e.completionMs>e.submissionMs));
  assert.ok(f.events.filter(e=>e.event==='draw-after').every(e=>e.preDrawDrainMs>0));
  assert.equal(f.result.timingMode,'pre-draw-drain-and-post-draw-fence-v1');
  f.renderer.render({});assert.equal(f.calls.finish,5);assert.equal(f.calls.render,2);
  assert.equal(f.events.filter(e=>e.event==='frame-before').length,1);
});

test('draw cap stops fencing rather than dropping scene draw calls',()=>{
  const f=fixture({draws:605});f.renderer.render({});
  assert.equal(f.calls.draw,605);assert.equal(f.calls.finish,1201);
  assert.equal(f.result.draws,600);assert.equal(f.result.truncated,true);assert.equal(f.result.done,true);
  assert.equal(f.events.filter(e=>e.event==='draw-limit').length,1);
});

test('before-draw evidence survives completion failure, and the error is preserved',()=>{
  const f=fixture({failFinish:3});assert.throws(()=>f.renderer.render({}),/GPU failed/);
  assert.equal(f.result.done,true);assert.match(f.result.error,/GPU failed/);
  assert.equal(f.events.filter(e=>e.event==='draw-before').length,1);
  assert.equal(f.events.filter(e=>e.event==='draw-after').length,0);
  assert.equal(f.events.find(e=>e.event==='draw-error').submitted,true);
  assert.equal(f.events.find(e=>e.event==='draw-error').stage,'completion');
});

test('pre-draw drain failure preserves evidence without submitting another draw',()=>{
  const f=fixture({failFinish:2});assert.throws(()=>f.renderer.render({}),/GPU failed/);
  assert.equal(f.calls.draw,0);
  assert.equal(f.events.filter(e=>e.event==='draw-before').length,1);
  const failure=f.events.find(e=>e.event==='draw-error');
  assert.equal(failure.submitted,false);assert.equal(failure.stage,'pre-draw-drain');
});

test('ordinary profiles are never fenced and copy passes cannot consume the scene capture',()=>{
  const ordinary=fixture({diffuse:false});ordinary.renderer.render({});
  assert.equal(ordinary.calls.finish,0);assert.match(ordinary.result.error,/legacy diffuse/);
  const f=fixture();f.renderer.render({name:'interaction-copy'});
  assert.equal(f.calls.finish,0);assert.equal(f.result.done,false);
  f.renderer.render({});assert.equal(f.calls.finish,3);assert.equal(f.result.done,true);
});

test('event persistence is capped even when a driver performs repeated link-status queries',()=>{
  const f=fixture();const direct=f.renderer.renderBufferDirect;
  f.renderer.renderBufferDirect=function(...args){for(let i=0;i<1200;i++)f.gl.getProgramParameter({},f.gl.LINK_STATUS);return direct.apply(this,args);};
  f.renderer.render({});assert.equal(f.events.length,2000);assert.equal(f.result.truncated,true);
  assert.equal(f.events.at(-1).event,'event-limit');assert.equal(f.calls.draw,1);
});

test('submitted scalar state is per program and per draw, with unknown distinct from zero',()=>{
  const other={}, f=fixture({draws:4,beforeDraw({gl,program,index}){
    if(index===0){
      assert.equal(gl.uniform1i(gl.getUniformLocation(program,'homePointLightingRequired'),false),17);
      assert.equal(gl.uniform1f(gl.getUniformLocation(program,'homeDaylight'),0),19);
      gl.uniform1f(gl.getUniformLocation(program,'homeExteriorSurface'),0);
      gl.uniform1i(gl.getUniformLocation(program,'homeWallSheenEnabled'),true);
      gl.uniform1i(gl.getUniformLocation(program,'homeFaceMode'),-1);
    }else if(index===1){
      gl.useProgram(other);
      gl.uniform1i(gl.getUniformLocation(other,'homePointLightingRequired'),true);
      gl.uniform1f(gl.getUniformLocation(other,'homeDaylight'),.5);
    }else if(index===3){
      gl.uniform1i(gl.getUniformLocation(program,'homePointLightingRequired'),true);
      gl.uniform1f(gl.getUniformLocation(program,'homeDaylight'),NaN);
    }
  }});
  f.renderer.render({});
  const draws=f.events.filter(e=>e.event==='draw-before');
  assert.deepEqual(draws[0].submittedUniforms,{homePointLightingRequired:false,homeDaylight:0,
    homeExteriorSurface:0,homeWallSurface:null,homeWallSheenEnabled:true,homeFaceMode:-1});
  assert.equal(draws[1].submittedUniforms.homePointLightingRequired,true);
  assert.equal(draws[1].submittedUniforms.homeDaylight,.5);
  assert.equal(draws[1].submittedUniforms.homeExteriorSurface,null);
  assert.deepEqual(draws[2].submittedUniforms,draws[0].submittedUniforms,'Other programs cannot overwrite cached values');
  assert.equal(draws[3].submittedUniforms.homePointLightingRequired,true);
  assert.equal(draws[3].submittedUniforms.homeDaylight,null,'Nonfinite is unknown, not false/zero');
  assert.equal(draws[0].submittedUniforms.homePointLightingRequired,false,'Snapshots cannot change after later uploads');
  assert.deepEqual(f.calls,{render:1,draw:4,finish:9,queries:2});
  assert.equal(f.uniformCalls.length,18,'Every observed GL call was requested by the renderer, with no diagnostic lookup/upload');
});

test('relink, deletion, stale locations and wrong current program never invent a value',()=>{
  let location;
  const f=fixture({draws:5,beforeDraw({gl,program,index}){
    if(index===0){location=gl.getUniformLocation(program,'homeFaceMode');gl.uniform1i(location,-1);}
    if(index===1){gl.linkProgram(program);gl.uniform1i(location,1);}
    if(index===2){location=gl.getUniformLocation(program,'homeFaceMode');gl.uniform1i(location,1);}
    if(index===3){gl.deleteProgram(program);gl.uniform1i(location,0);}
    if(index===4){
      gl.useProgram({});gl.uniform1i(gl.getUniformLocation(program,'homePointLightingRequired'),false);
      gl.useProgram(program);gl.uniform1f(gl.getUniformLocation(program,'absent'),0);
      gl.uniform1f(gl.getUniformLocation(program,'unrelated'),1);
    }
  }});
  f.renderer.render({});
  const draws=f.events.filter(e=>e.event==='draw-before');
  assert.deepEqual(draws.map(e=>e.submittedUniforms.homeFaceMode),[-1,null,1,null,null]);
  assert.equal(draws[4].submittedUniforms.homePointLightingRequired,null);
  assert.equal(Object.keys(draws[4].submittedUniforms).length,6,'Only the bounded allowlist is recorded');
});

test('observation restores owned wrappers and preserves later wrappers and original exceptions',()=>{
  for(const options of [{},{diffuse:false},{failFinish:1},{failFinish:2},{failFinish:3}]){
    const f=fixture(options);
    if(options.failFinish)assert.throws(()=>f.renderer.render({}),/GPU failed/);else f.renderer.render({});
    for(const [name,original] of Object.entries(f.originalUniformMethods))assert.equal(f.gl[name],original);
  }
  const marker=new Error('original upload exception');
  const f=fixture({uploadError:marker,beforeDraw({gl,program}){
    assert.throws(()=>gl.uniform1i(gl.getUniformLocation(program,'homePointLightingRequired'),false),error=>error===marker);
  }});
  const previous=f.gl.uniform1f, later=function(...args){return previous.apply(this,args);};f.gl.uniform1f=later;
  f.renderer.render({});
  assert.equal(f.gl.uniform1f,later,'Do not overwrite a later third-party wrapper');
  assert.equal(f.events.find(e=>e.event==='draw-before').submittedUniforms.homePointLightingRequired,null);
});
