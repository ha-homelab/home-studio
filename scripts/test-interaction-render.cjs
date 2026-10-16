'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
(async()=>{
const root=path.resolve(__dirname,'..');
const THREE=await import('data:text/javascript;base64,'+fs.readFileSync(path.join(root,'vendor/three.module.min.js')).toString('base64'));
const {createInteractionRenderer}=await import('data:text/javascript;base64,'+fs.readFileSync(path.join(root,'planner/interaction-render.js')).toString('base64'));
function renderer(){
 const log=[], textures=[], state={size:new THREE.Vector2(632,394),viewport:new THREE.Vector4(0,0,1264,788),ratio:.5,scissor:false,target:null};
 const r={log,textures,state,info:{autoReset:true,render:{calls:0,triangles:0}},autoClear:true,
 getDrawingBufferSize:v=>v.copy(state.size),getViewport:v=>v.copy(state.viewport),getPixelRatio:()=>state.ratio,
 getRenderTarget:()=>state.target,getScissorTest:()=>state.scissor,
 setViewport(...args){state.viewport.copy(args[0]?.isVector4?args[0]:new THREE.Vector4(...args));log.push(['viewport',state.viewport.toArray()]);},
 initTexture(t){textures.push(t);log.push(['allocate',t.image.width,t.image.height]);},
 compile(s,c){log.push(['compile',s,c]);},
 copyFramebufferToTexture(t){log.push(['copy',t,state.viewport.toArray()]);if(r.failCopy)throw new Error('copy failed');},
 render(s,c){if(r.info.autoReset){r.info.render.calls=0;r.info.render.triangles=0;}r.info.render.calls+=s.name==='interaction-copy'?1:90;r.info.render.triangles+=s.name==='interaction-copy'?1:2508;log.push(['render',s,c,state.viewport.toArray(),r.autoClear]);},
 };return r;
}
const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera();
const r=renderer(),p=createInteractionRenderer(THREE,r);
p.draw(scene,camera,false);
assert.equal(r.textures.length,1);assert.equal(r.log.filter(x=>x[0]==='render').length,1);assert.equal(r.log.filter(x=>x[0]==='compile').length,1);
const texture=r.textures[0];assert(texture.image.width*texture.image.height<=62500);assert.equal(texture.colorSpace,THREE.NoColorSpace);assert.equal(texture.minFilter,THREE.LinearFilter);assert.equal(texture.generateMipmaps,false);
p.draw(scene,camera,true);p.draw(scene,camera,true);
assert.equal(r.textures.length,1,'Motion reuses the existing allocation');
let renders=r.log.filter(x=>x[0]==='render');const low=renders.at(-2),copy=renders.at(-1);
assert.strictEqual(low[1],scene);assert.strictEqual(low[2],camera,'Scene camera is unchanged');assert.equal(low[3][2],(texture.image.width+.25)/r.state.ratio);assert.equal(low[3][3],(texture.image.height+.25)/r.state.ratio);
assert.equal(copy[1].name,'interaction-copy');assert.deepEqual(copy[3],[0,0,632.25/.5,394.25/.5]);assert.equal(copy[4],false);
assert.equal(r.info.render.calls,91,'Copy draw is included, not substituted for scene draw counts');assert.equal(r.info.render.triangles,2509);
const mesh=copy[1].children[0];assert.equal(mesh.material.blending,THREE.NoBlending);assert.equal(mesh.material.toneMapped,false);assert.equal(mesh.material.depthWrite,false);assert.equal(mesh.material.depthTest,false);assert.match(mesh.material.fragmentShader,/gl_FragColor=texture2D\(source,sampleUV\)/);assert.doesNotMatch(mesh.material.fragmentShader,/pow|toneMapping|colorspace|sRGB/);
assert.match(mesh.material.fragmentShader,/floor\(gl_FragCoord.xy\)\+vec2\(0.5\)/,'Every multisample location samples the resolved destination pixel center');assert.deepEqual(mesh.material.uniforms.outputSize.value.toArray(),[632,394]);assert.doesNotMatch(mesh.material.vertexShader,/varying|sampleUV/,'Copy UVs cannot vary across multisample locations');
p.draw(scene,camera,false);assert.equal(r.info.render.calls,90);assert.strictEqual(r.log.at(-1)[1],scene,'Release uses a direct full-size scene frame');
r.failCopy=true;assert.throws(()=>p.draw(scene,camera,true),/copy failed/);assert.deepEqual(r.state.viewport.toArray(),[0,0,1264,788]);assert.equal(r.info.autoReset,true);assert.equal(r.autoClear,true);r.failCopy=false;
let disposed=0;texture.addEventListener('dispose',()=>disposed++);r.state.size.set(800,400);r.state.viewport.set(0,0,1600,800);p.draw(scene,camera,false);assert.equal(disposed,1);assert.equal(r.textures.length,2);
let resourceDisposals=0;for(const resource of [r.textures.at(-1),mesh.geometry,mesh.material])resource.addEventListener('dispose',()=>resourceDisposals++);p.dispose();p.dispose();assert.equal(resourceDisposals,3,'Context loss/pagehide cleanup is idempotent');
const full=renderer(),identity=createInteractionRenderer(THREE,full,632*394);identity.draw(scene,camera,true);assert.equal(full.textures[0].image.width,632);assert.equal(full.textures[0].image.height,394);assert(full.log.some(x=>x[0]==='copy'),'Equal-sized diagnostic exercises the same copy pipeline');identity.dispose();
for(const state of [{scissor:true},{target:{}},{viewport:new THREE.Vector4(1,0,1264,788)},{viewport:new THREE.Vector4(0,0,1200,788)},{size:new THREE.Vector2(0,0)}]){
 const f=renderer();Object.assign(f.state,state);const a=createInteractionRenderer(THREE,f);a.draw(scene,camera,true);assert(!f.log.some(x=>x[0]==='copy'),'Unsupported/clipped viewport stays on direct path');a.dispose();
}
const fractional=renderer();fractional.state.ratio=.6;fractional.state.viewport.set(0,0,1054.9,658.2);const fractionalCopy=createInteractionRenderer(THREE,fractional);fractionalCopy.draw(scene,camera,true);assert(fractional.log.some(x=>x[0]==='copy'),'Fractional DPR floor/round difference must not reject the normal full viewport');const fractionalPass=fractional.log.filter(x=>x[0]==='render').at(-1);assert.deepEqual(fractionalPass[3],[0,0,632.25/.6,394.25/.6],'Copy fits exactly within actual drawing-buffer pixels');assert.deepEqual(fractional.state.viewport.toArray(),[0,0,1054.9,658.2]);fractionalCopy.dispose();
for(const dpr of [.5860412396258964,.6,1,1.25,2])for(const n of [197,279,394,447,632]){const p=(n+.25)/dpr*dpr;assert.equal(Math.floor(p),n);assert.equal(Math.round(p),n);}
assert.throws(()=>createInteractionRenderer(THREE,renderer(),0),/pixel budget/);
// Exercise real pointer bookkeeping without a DOM or a graphics driver.
const text=fs.readFileSync(path.join(root,'viewer.js'),'utf8');
const block=text.slice(text.indexOf('if(coalesceMotion){\nrenderer.domElement.addEventListener'),text.indexOf('let drag=null;'));
function input(enabled){const handlers={};const context={coalesceMotion:enabled,renderLost:false,renderSuspended:false,interactionPointer:null,renderer:{domElement:{addEventListener:(name,fn)=>handlers[name]=fn}},renders:0,requestRender(){context.renders++;}};vm.createContext(context);vm.runInContext(block,context);return {context,handlers};}
const {context,handlers}=input(true);handlers.pointerdown({button:0,pointerId:1,clientX:20,clientY:20});handlers.pointermove({pointerId:1,clientX:40,clientY:20});assert.equal(context.interactionPointer.moved,true);handlers.pointerup({pointerId:2});assert(context.interactionPointer,'Unrelated pointer release does not end motion');handlers.pointerup({pointerId:1});assert.equal(context.interactionPointer,null);assert.equal(context.renders,1,'Release schedules one direct full-quality frame');handlers.lostpointercapture({pointerId:1});assert.equal(context.renders,1,'Duplicate capture release adds no frame');assert.deepEqual(Object.keys(input(false).handlers),[],'Normal GPUs have no interaction hooks');
const lifecycleHandlers={}, lifecycleOrder=[];
const lifecycle={initialViewReady:true,renderLost:false,renderSuspended:false,interactionPointer:{moved:true},interactionRenderer:{dispose(){lifecycleOrder.push('dispose');}},cancelRender(){lifecycleOrder.push('cancel');},observer:{disconnect(){lifecycleOrder.push('disconnect');}},renderer:{domElement:{addEventListener:(name,fn)=>lifecycleHandlers[name]=fn},dispose(){lifecycleOrder.push('renderer-dispose');},forceContextLoss(){lifecycleOrder.push('force-loss');}},window:{addEventListener:(name,fn)=>lifecycleHandlers[name]=fn}};
lifecycle.homeView=null;
lifecycle.releaseStaticGlassPasses=()=>lifecycleOrder.push('glass-release');
lifecycle.disposeStaticGlassPasses=()=>lifecycleOrder.push('glass-dispose');
vm.createContext(lifecycle);
for(const prefix of ["renderer.domElement.addEventListener('webglcontextlost'","window.addEventListener('pagehide'"]){vm.runInContext(text.split('\n').find(line=>line.startsWith(prefix)),lifecycle);}
lifecycleHandlers.webglcontextlost({preventDefault(){lifecycleOrder.push('prevent');}});assert.equal(lifecycle.renderLost,true);assert.equal(lifecycle.interactionPointer,null);assert.equal(lifecycle.interactionRenderer,null);assert.deepEqual(lifecycleOrder,['prevent','cancel','dispose','glass-release']);
lifecycleOrder.length=0;lifecycle.interactionRenderer={dispose(){lifecycleOrder.push('dispose');}};lifecycle.interactionPointer={moved:true};lifecycleHandlers.pagehide({persisted:true});assert.equal(lifecycle.renderSuspended,true);assert.equal(lifecycle.interactionPointer,null);assert(lifecycle.interactionRenderer,'BFCache retains bounded resources');assert.deepEqual(lifecycleOrder,['cancel']);
lifecycleOrder.length=0;lifecycleHandlers.pagehide({persisted:false});assert.equal(lifecycle.interactionRenderer,null);assert.deepEqual(lifecycleOrder,['cancel','disconnect','dispose','glass-dispose','renderer-dispose','force-loss'],'Copy resources are released before native context retirement');
// Re-enter the actual draw path after context restoration and page-cache resume.
const hooks={}, history=[];
let created=0;
const c={initialViewReady:true,homeView:null,renderProfile:{diffuseLighting:true},renderSuspended:false,renderLost:false,renderCount:0,
 interactionRenderer:null,interactionPointer:{moved:true},scene:{},THREE:{},document:{hidden:false},
 wallSheenMotion:{beforeRender(){},afterRender(){}},cancelRender(){},invalidateShadows(){},
 requestRender(){history.push('request');},resize(){},observer:{disconnect(){}},releaseStaticGlassPasses(){},disposeStaticGlassPasses(){},
 renderer:{domElement:{addEventListener:(key,fn)=>hooks[key]=fn},dispose(){},forceContextLoss(){}},
 window:{resizeModel(){},addEventListener:(key,fn)=>hooks[key]=fn},
 createInteractionRenderer(){const id=++created;return {draw(scene,camera,moving){history.push({id,moving});},dispose(){history.push({disposed:id});}}},
};
vm.createContext(c);
for(const prefix of ['function drawScene(',"renderer.domElement.addEventListener('webglcontextlost'", "renderer.domElement.addEventListener('webglcontextrestored'", "window.addEventListener('pagehide'", "window.addEventListener('pageshow'"])
 vm.runInContext(text.split('\n').find(line=>line.startsWith(prefix)),c);
c.drawScene({});assert.deepEqual(history.at(-1),{id:1,moving:true});
hooks.webglcontextlost({preventDefault(){}});c.drawScene({});assert.equal(created,1,'Lost contexts cannot allocate or render');
hooks.webglcontextrestored();c.drawScene({});assert.equal(created,2);assert.deepEqual(history.at(-1),{id:2,moving:false},'Restoration recreates the helper and draws full quality');
c.interactionPointer={moved:true};hooks.pagehide({persisted:true});c.drawScene({});assert.equal(created,2);
hooks.pageshow({persisted:true});c.drawScene({});assert.equal(created,2,'Page cache resumes its one bounded helper');assert.deepEqual(history.at(-1),{id:2,moving:false},'Page-cache resume cannot retain a low-resolution gesture');
hooks.pagehide({persisted:false});assert.equal(history.filter(v=>v.disposed===2).length,1);assert.equal(c.interactionRenderer,null);
console.log('Interaction-copy: allocation, copy/color contract, frame counts, bounds, cleanup and release tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
