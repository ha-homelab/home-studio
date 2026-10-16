const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test');
const trace=fs.readFileSync(path.join(__dirname,'restore-trace.js'),'utf8');
const draw=fs.readFileSync(path.join(__dirname,'passive-restore-draw.js'),'utf8');
function setup({draws=2,drawError=null}={}) {
 const lines=[],listeners=new Map(),calls={restore:0,render:0,draw:0,query:0,finish:0,parameter:0};let time=0;
 const host={performance:{now:()=>++time},console:{info:line=>lines.push(line)},
  addEventListener(name,listener){listeners.set(name,listener);},removeEventListener(name,listener){if(listeners.get(name)===listener)listeners.delete(name);}};
 const context={window:host,performance:host.performance,console:host.console};
 vm.runInNewContext(trace+'\n'+draw+'\nwindow.attach=attachPassiveRestoreDrawDiagnostic;',context);
 const gl={VERTEX_SHADER:1,FRAGMENT_SHADER:2,LINK_STATUS:3,FRAMEBUFFER:4,DRAW_FRAMEBUFFER:5,
  drawingBufferWidth:632,drawingBufferHeight:394,createShader:()=>({}),shaderSource(){},attachShader(){},useProgram(){},
  bindFramebuffer(){},viewport(){},linkProgram(){},getProgramParameter(){calls.query++;return true;},
  getUniformLocation:()=>({}),uniform1i(){},uniform1f(){},deleteProgram(){},
  drawElements(){calls.draw++;if(drawError)throw drawError;},
  finish(){calls.finish++;throw Error('No extra fence permitted');},getParameter(){calls.parameter++;throw Error('No extra query permitted');}};
 const program={},canvas={},camera={},mesh={name:'fixture floor',userData:{category:'floors'},material:{type:'MeshLambertMaterial',side:2,transparent:false}};
 const shadow={camera,isPointLightShadow:true,updateMatrices(){},mapSize:{toArray:()=>[128,128]}};
 const light={type:'PointLight',name:'fixture light',shadow};
 const renderer={getContext:()=>gl,domElement:canvas,info:{render:{calls:draws}},
  renderBufferDirect(camera,fog,geometry,material,object){gl.useProgram(program);gl.drawElements(4,36,5123,0);},
  shadowMap:{render(){throw Error('Stale pre-restore shadow map must not be used');}},
  render(scene){calls.render++;
   const shader=gl.createShader(gl.FRAGMENT_SHADER);gl.shaderSource(shader,'fixture shader');gl.attachShader(program,shader);
   gl.linkProgram(program);gl.getProgramParameter(program,gl.LINK_STATUS);gl.useProgram(program);
   gl.uniform1i(gl.getUniformLocation(program,'homePointLightingRequired'),1);
   gl.viewport(0,0,632,394);gl.bindFramebuffer(gl.FRAMEBUFFER,null);
   if(scene.shadow)this.shadowMap.render([light]);
   for(let i=0;i<draws;i++)this.renderBufferDirect(camera,null,null,mesh.material,mesh);
  }};
 host.__prepareRestoreDrawObserver=()=>host.attach(renderer,()=>({connected:true,renderCount:9,profile:{diffuseLighting:true}}));
 function dispatch() {
  const event={target:canvas,isTrusted:true};listeners.get('webglcontextrestored')?.(event);
  // Model Three's native restored listener replacing its shadow subsystem.
  renderer.shadowMap={render(){shadow.updateMatrices(light,4);renderer.renderBufferDirect(camera,null,null,{type:'MeshDistanceMaterial',side:1,transparent:false},mesh);}};
  host.__nativeRestoreTrace.targetRestored(event);
 }
 const events=()=>lines.filter(line=>line.startsWith('HOME_NATIVE_RESTORE_DRAW ')).map(line=>JSON.parse(line.slice('HOME_NATIVE_RESTORE_DRAW '.length)));
 return {host,renderer,gl,calls,dispatch,events,listeners};
}
test('restore call and event boundaries preserve return, with no extra GL call or draw',()=>{
 const f=setup();const marker={};
 assert.equal(f.host.__nativeRestoreTrace.invoke(()=>{f.calls.restore++;return marker;}),marker);
 assert.equal(f.calls.restore,1);assert.equal(f.calls.render,0);assert.equal(f.calls.query,0);
 f.dispatch();f.renderer.render({shadow:true});
 assert.deepEqual(f.calls,{restore:1,render:1,draw:3,query:1,finish:0,parameter:0});
 const ev=f.host.__nativeRestoreTrace.snapshot().events.map(e=>e.event);
 assert.deepEqual(Array.from(ev),['restore-request','draw-observer-installed','restore-call-before','restore-call-return','context-restored-capture','context-restored-target-tail']);
 const draws=f.events().filter(e=>e.event==='draw-before');
 assert.equal(draws[0].phase,'shadow');assert.equal(draws[0].shadow.faceIndex,4);assert.equal(draws[1].category,'floors');
 assert.equal(draws[1].submittedUniforms.homePointLightingRequired,1);
 assert.equal(draws[1].submittedUniforms.homeDaylight,null,'Unknown submitted values are not false');
 assert(f.events().filter(e=>e.event==='draw-after').every(e=>!('completionMs' in e)&&!('preDrawDrainMs' in e)));
 assert.equal(f.host.__passiveRestoreDrawDiagnostic.done,true);
});
test('synchronous event dispatch can occur inside original API; original exception is preserved',()=>{
 const f=setup(),error=new Error('original API error');
 assert.throws(()=>f.host.__nativeRestoreTrace.invoke(()=>{f.dispatch();throw error;}),value=>value===error);
 const events=Array.from(f.host.__nativeRestoreTrace.snapshot().events,e=>e.event);
 assert(events.indexOf('context-restored-capture')<events.indexOf('restore-call-error'));
 assert.equal(f.calls.render,0);
});
test('observer installation error cannot prevent original restore call',()=>{
 const f=setup();f.host.__prepareRestoreDrawObserver=()=>{throw Error('observer installation');};
 assert.equal(f.host.__nativeRestoreTrace.invoke(()=>{f.calls.restore++;return 7;}),7);assert.equal(f.calls.restore,1);
 assert.match(f.host.__nativeRestoreTrace.snapshot().observerError,/observer installation/);
});
test('only the first scene frame is captured, later real draws and copy passes remain intact',()=>{
 const f=setup();f.host.__nativeRestoreTrace.invoke(()=>undefined);f.dispatch();
 f.renderer.render({name:'interaction-copy'});assert.equal(f.events().length,0);
 f.renderer.render({});f.renderer.render({});
 assert.equal(f.calls.render,3);assert.equal(f.calls.draw,6);assert.equal(f.events().filter(e=>e.event==='frame-before').length,1);
});
test('bounded output never drops original draws; failed original draw keeps error identity',()=>{
 const f=setup({draws:605});f.host.__nativeRestoreTrace.invoke(()=>undefined);f.dispatch();f.renderer.render({});
 assert.equal(f.calls.draw,605);assert.equal(f.host.__passiveRestoreDrawDiagnostic.draws,600);assert.equal(f.host.__passiveRestoreDrawDiagnostic.truncated,true);
 assert(f.events().length<=2000);
 const error=new Error('driver draw'),g=setup({drawError:error});g.host.__nativeRestoreTrace.invoke(()=>undefined);g.dispatch();
 assert.throws(()=>g.renderer.render({}),value=>value===error);
 assert.equal(g.events().filter(e=>e.event==='draw-before').length,1);assert.equal(g.events().filter(e=>e.event==='draw-error').length,1);
});
