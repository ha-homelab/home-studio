// Actual pinned parameter/state functions with a recording GL, not a GPU.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
(async()=>{
  const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8'),source=read('room-lighting.js');
  const vendor=read('vendor/three.module.min.js');assert(vendor.includes('function Gl(t){'));
  const THREE=await import('data:text/javascript;base64,'+Buffer.from(vendor+'\nexport {Gl as TestState,Al as TestPrograms,bl as TestProgram};').toString('base64'));
  const c=vm.createContext({Float32Array,Int32Array,Uint16Array,Uint32Array});vm.runInContext(source,c);
  const plane=new THREE.Plane(new THREE.Vector3(0,-1,0),4),rooms=[{id:'r',polygon:[[0,0],[4,0],[4,4],[0,4]]}];
  function object(role='floors'){
    const m=new THREE.MeshLambertMaterial({side:THREE.DoubleSide,transparent:role==='walls'||role==='windows',opacity:role==='windows'?.4:1,depthWrite:role!=='walls'});m.clippingPlanes=[plane];
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(),m);mesh.userData.category=role;return mesh;
  }
  function controller(enabled=true,packed=true){return c.createRoomLighting(THREE,rooms,3,[],{packed,maxFragmentUniforms:1024,sharedOpaqueBlend:enabled});}
  const keys=['blending','blendEquation','blendSrc','blendDst','blendEquationAlpha','blendSrcAlpha','blendDstAlpha'];
  const protectedKeys=['opacity','transparent','depthWrite','depthTest','depthFunc','colorWrite','side','shadowSide','toneMapped','fog','premultipliedAlpha','alphaTest','alphaHash','alphaToCoverage','clipShadows'];
  const props=m=>Object.fromEntries([...keys,...protectedKeys].map(k=>[k,m[k]]));
  function recordingGL(){const calls=[],state={enabled:new Set()};let next=1000;const constants=new Map();const gl=new Proxy({
    getParameter(p){if(p===gl.VERSION)return'WebGL 2.0';if(p===gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS)return 16;return[0,0,640,480];},
    createTexture(){return{};},enable(k){state.enabled.add(k);calls.push(['enable',k]);},disable(k){state.enabled.delete(k);calls.push(['disable',k]);},
    blendEquation(v){state.equations=[v,v];},blendEquationSeparate(a,b){state.equations=[a,b];},blendFuncSeparate(...v){state.factors=v;},
    depthMask(v){state.depthMask=v;},depthFunc(v){state.depthFunc=v;},frontFace(v){state.frontFace=v;},colorMask(...v){state.colorMask=v;},
  },{get(t,k){if(k in t)return t[k];if(typeof k==='string'&&k===k.toUpperCase()){if(!constants.has(k))constants.set(k,next++);return constants.get(k);}return()=>{};}});
    const api=new THREE.TestState(gl);return{gl,api,state,calls};}
  const floor=object(),frame=object('frames'),wall=object('walls'),group=new THREE.Group();group.add(floor,frame,wall);
  const originals=group.children.map(o=>props(o.material)),identities=group.children.map(o=>({o,m:o.material,g:o.geometry,id:o.id,order:o.renderOrder}));
  const old=controller(false);old.attach(group,true,{staticGeometry:true});assert.equal(floor.material.blending,THREE.NoBlending);
  const controlGL=recordingGL();controlGL.api.setMaterial(floor.material,false);assert(!controlGL.state.enabled.has(controlGL.gl.BLEND));
  const active=controller(true);active.attach(group,true,{staticGeometry:true});
  const actual=recordingGL();actual.api.setMaterial(floor.material,false);
  assert(actual.state.enabled.has(actual.gl.BLEND));assert.deepEqual(actual.state.equations,[actual.gl.FUNC_ADD,actual.gl.FUNC_ADD]);
  assert.deepEqual(actual.state.factors,[actual.gl.SRC_ALPHA,actual.gl.ONE_MINUS_SRC_ALPHA,actual.gl.ONE,actual.gl.ONE_MINUS_SRC_ALPHA]);
  assert.equal(actual.state.depthMask,true);assert.equal(floor.material.transparent,false);
  const floorState={factors:actual.state.factors.slice(),equations:actual.state.equations.slice()};actual.api.setMaterial(wall.material,false);
  assert.deepEqual(actual.state.factors,floorState.factors);assert.deepEqual(actual.state.equations,floorState.equations);assert.equal(actual.state.depthMask,false);
  for(const [i,o]of group.children.entries()){for(const k of protectedKeys)assert.equal(o.material[k],originals[i][k],k);assert.equal(o,identities[i].o);assert.equal(o.material,identities[i].m);assert.equal(o.geometry,identities[i].g);assert.equal(o.id,identities[i].id);assert.equal(o.renderOrder,identities[i].order);}
  // Actual Three parameter builder proves the OPAQUE macro and shader family
  // remain shared, while its render-list source still classifies by transparent.
  const submitted=[],gl={VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,createProgram:()=>({}),createShader:type=>({type}),shaderSource(s,text){submitted.push({type:s.type,text});},compileShader(){},attachShader(){},linkProgram(){},bindAttribLocation(){}};
  const renderer={getContext:()=>gl,getRenderTarget:()=>null,outputColorSpace:THREE.SRGBColorSpace,toneMapping:THREE.ACESFilmicToneMapping,shadowMap:{enabled:true,type:THREE.BasicShadowMap},debug:{checkShaderErrors:false}},bindings={releaseStatesOfProgram(){}};
  const programs=new THREE.TestPrograms(renderer,{get:()=>null},{get:()=>null},{has:()=>false},{precision:'highp',getMaxPrecision:x=>x,vertexTextures:true,logarithmicDepthBuffer:false,reverseDepthBuffer:false},bindings,{numPlanes:1,numIntersection:0});
  const lights={directional:[{}],point:[{},{},{}],spot:[],spotLightMap:[],rectArea:[],hemi:[],directionalShadowMap:[{}],pointShadowMap:[{},{}],spotShadowMap:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};
  function expand(o){const p=programs.getParameters(o.material,lights,[{}],new THREE.Scene(),o),s={uniforms:{},vertexShader:THREE.ShaderLib.lambert.vertexShader,fragmentShader:THREE.ShaderLib.lambert.fragmentShader};o.material.onBeforeCompile(s);Object.assign(p,s);const key=programs.getProgramCacheKey(p);submitted.length=0;new THREE.TestProgram(renderer,key,p,bindings);return{key,opaque:p.opaque,vertex:submitted[0].text,fragment:submitted[1].text};}
  const a=expand(floor),b=expand(wall);assert.equal(a.opaque,false);assert.deepEqual(a,b);
  old.attach(group,true,{staticGeometry:true});assert.deepEqual(expand(floor),a,'Candidate and original full GLSL/key are byte-identical');
  // Blend arithmetic at alpha=1 is the exact original source RGBA, including
  // multisample coverage: this changes neither coverage nor depth testing.
  let colors=0;for(const r of [0,1/255,.25,1])for(const g of [0,.5,1])for(const b of [0,.75,1])for(const d of [[0,0,0,0],[1,.4,.2,.5],[.3,.8,.9,1]]){const src=[r,g,b,1],out=src.map((x,i)=>x*(i===3?1:src[3])+d[i]*(1-src[3]));assert.deepEqual(out,src);colors++;}
  // A partial-alpha negative control would be different and must be rejected.
  const partial=object();partial.material.opacity=.5;const partialOriginal=props(partial.material);active.attach(partial,true,{staticGeometry:true});assert.deepEqual(props(partial.material),partialOriginal);
  let transitions=0;
  for(const [enabled,packed,staticGeometry]of [[true,true,true],[false,true,true],[true,false,true],[true,true,false],[true,true,true]]){
    const ctl=controller(enabled,packed);ctl.attach(group,true,{staticGeometry});assert.equal(floor.material.blending,enabled&&packed&&staticGeometry?THREE.CustomBlending:packed&&staticGeometry?THREE.NoBlending:THREE.NormalBlending);transitions++;
  }
  // Fallback-box preparation expects the former NoBlending assignment. Owned
  // custom fields must be restored before that helper checks for user edits.
  const fallback=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshLambertMaterial());c.registerFallbackBoxProgram(THREE,fallback,true);
  for(let i=0;i<3;i++){active.attach(fallback,true);assert.equal(fallback.material.blending,THREE.CustomBlending);assert.equal(fallback.material.side,THREE.DoubleSide);assert.equal(fallback.material.transparent,false);}
  controller(false,false).attach(fallback,true);assert.equal(fallback.material.side,THREE.FrontSide);assert.equal(fallback.material.blending,THREE.NormalBlending);
  // Every externally changed assigned field is retained, with no reapplication.
  for(const k of keys){const o=object();active.attach(o,true,{staticGeometry:true});const edit=k==='blending'?THREE.AdditiveBlending:12345;o.material[k]=edit;active.attach(o,true,{staticGeometry:true});assert.equal(o.material[k],edit);active.attach(o,true,{staticGeometry:true});assert.equal(o.material[k],edit);}
  // Ordinary user changes to alpha/role become authoritative on reattachment.
  for(const change of [o=>o.material.opacity=.5,o=>o.material.transparent=true,o=>o.material.alphaTest=.1,o=>o.material.map=new THREE.Texture(),o=>o.material.premultipliedAlpha=true,o=>o.onBeforeRender=()=>{}]){const o=object();active.attach(o,true,{staticGeometry:true});change(o);active.attach(o,true,{staticGeometry:true});assert.notEqual(o.material.blending,THREE.CustomBlending);}
  const fresh=object();const orig=props(fresh.material);for(let i=0;i<3;i++){active.attach(fresh,true,{staticGeometry:true});active.releaseGPU();active.attach(fresh,false,{staticGeometry:true});assert.equal(fresh.material.blending,THREE.CustomBlending);}
  controller(false,false).attach(fresh,false);assert.deepEqual(props(fresh.material),orig);
  assert(read('home-view.js').includes('sharedOpaqueBlend:true'));
  console.log(JSON.stringify({status:'PASS',pinnedState:true,pinnedShaderIdentity:true,colors,transitions,externalEdits:keys.length,scope:'CPU state/arithmetic/source only; no native driver or pixel claim'}));
})().catch(e=>{console.error(String(e.stack||e).replace(/data:text\/javascript;base64,[^\s)]+/g,'[pinned Three]'));process.exitCode=1;});
