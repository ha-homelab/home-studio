const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../viewer.js'),'utf8');
const actual=source.slice(source.indexOf('function setHostViewVisibility('),source.indexOf('function cancelRender('));
const calls=[];
const context=vm.createContext({renderSuspended:false,hostViewSuspended:false,renderLost:false,interactionPointer:{moved:true},
  syncViewerTours:()=>calls.push('stop-tours'),cancelRender:()=>calls.push('cancel'),requestRender:()=>calls.push('draw'),
  environmentLayer:{setActive:value=>calls.push(['environment',value])},
  homeView:{dismissOverlays:()=>calls.push('dismiss')},window:{resizeModel:value=>calls.push(['resize',value])}});
vm.runInContext(actual,context);
context.setHostViewVisibility('false');assert.deepEqual(calls,[]);
context.setHostViewVisibility(true);
assert.equal(context.hostViewSuspended,true);assert.equal(context.interactionPointer,null);
assert.deepEqual(calls,['cancel',['environment',false],'dismiss','stop-tours']);
calls.length=0;context.setHostViewVisibility(false);
assert.equal(context.hostViewSuspended,false);
assert.deepEqual(calls,['cancel',['environment',true],['resize',false],'draw']);
calls.length=0;context.renderLost=true;context.setHostViewVisibility(false);
assert.deepEqual(calls,['cancel',['environment',false],['resize',false],'draw']);
assert.match(source,/bridge\.onmessage=event=>\{[^]*?message\?\.type==='viewer_visibility'&&typeof message\.hidden==='boolean'/);
// A restored context or BFCache pageshow must not override the host's pause.
const handlers={};
context.renderer={domElement:{addEventListener:(name,fn)=>{handlers[name]=fn;}}};
context.window.addEventListener=(name,fn)=>{handlers[name]=fn;};
context.homeView.active=true;context.renderCount=2;
context.reflectionEnvironment={restore(){}};context.invalidateShadows=()=>{};
context.resize=()=>{};context.hostViewSuspended=true;context.renderSuspended=true;
context.document={hidden:false};context.failed3D=false;
vm.runInContext(source.split('\n').find(line=>line.startsWith('function requestRender(')),context);
vm.runInContext(source.split('\n').find(line=>line.startsWith("renderer.domElement.addEventListener('webglcontextrestored'")),context);
vm.runInContext(source.split('\n').find(line=>line.startsWith("window.addEventListener('pageshow'")),context);
calls.length=0;handlers.webglcontextrestored();
assert.equal(context.hostViewSuspended,true);assert.equal(context.renderLost,false);
assert.deepEqual(calls[0],['environment',false]);
handlers.pageshow({persisted:true});
assert.equal(context.renderSuspended,false);assert.equal(context.hostViewSuspended,true);
console.log('PASS: retained viewer pauses draws/effects and resumes without replacing live model state.');
