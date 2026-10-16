// CPU equivalence proof against the actual pinned Lambert shader chunks.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'room-lighting.js'),'utf8');
const viewer=fs.readFileSync(path.join(root,'viewer.js'),'utf8');
(async()=>{
  const vendor=fs.readFileSync(path.join(root,'vendor/three.module.min.js'),'utf8');
  // Test-only access to the pinned source's parameter/prefix builders. The real
  // renderer never sees this re-export; capture submitted GLSL without a GPU.
  assert(vendor.includes('function bl(t,e,n,i){const r=t.getContext()'));
  assert(vendor.includes('function Al(t,e,n,i,r,s,a){'));
  const THREE=await import('data:text/javascript;base64,'+Buffer.from(vendor+'\nexport {bl as TestProgram,Al as TestPrograms};').toString('base64'));
  const context=vm.createContext({Float32Array,Uint16Array,Uint32Array});
  vm.runInContext(source,context);
  const plane=new THREE.Plane(new THREE.Vector3(0,-1,0),1.5);
  function mesh(category='windows'){
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,0,0,1,0,0,1,2,0,-1,2,0],3));
    geometry.setAttribute('normal',new THREE.Float32BufferAttribute([0,0,1,0,0,1,0,0,1,0,0,1],3));
    geometry.setIndex([0,1,2,0,2,3]);
    const opaque=category==='floors'||category==='frames';
    const material=new THREE.MeshLambertMaterial({color:0x89b7d3,emissive:0x050a13,transparent:!opaque,
      opacity:opaque?1:.35,side:THREE.DoubleSide,forceSinglePass:category==='walls',depthWrite:category!=='walls'});
    material.clippingPlanes=[plane];
    const object=new THREE.Mesh(geometry,material);object.userData.category=category;object.receiveShadow=true;
    object.position.set(2,3,-4);object.rotation.set(.1,.3,-.2);object.scale.set(1.2,.8,1.4);object.updateMatrixWorld(true);
    return object;
  }
  const shaderFor=material=>{
    const shader={uniforms:{},vertexShader:THREE.ShaderLib.lambert.vertexShader,fragmentShader:THREE.ShaderLib.lambert.fragmentShader};
    material.onBeforeCompile(shader,{isWebGLRenderer:true});return shader;
  };
  const back=mesh(),original=back.material,geometry=back.geometry;
  const values=Object.fromEntries(['position','normal'].map(key=>[key,Array.from(geometry.attributes[key].array)]));
  const indices=Array.from(geometry.index.array);
  const passes=context.createStaticGlassPasses(THREE,back,true),front=passes.front;
  assert.equal(front.id,back.id+1,'transparent passes get adjacent object IDs');
  assert.equal(back.geometry,geometry);assert.equal(front.geometry,geometry,'no cloned GPU geometry');
  assert.notEqual(back.material,front.material);assert.notEqual(back.material,original);
  assert.equal(back.material.clippingPlanes,original.clippingPlanes);assert.equal(front.material.clippingPlanes,original.clippingPlanes);
  for(const object of [back,front]){
    for(const key of ['color','emissive'])assert(object.material[key].equals(original[key]));
    for(const key of ['opacity','transparent','blending','depthWrite','depthTest','depthFunc','colorWrite','side','toneMapped','fog','premultipliedAlpha','clipShadows'])
      assert.equal(object.material[key],original[key],key);
    assert.equal(object.material.forceSinglePass,true);
    for(const key of ['position','quaternion','scale','matrix','matrixWorld'])assert(object[key].equals(back[key]));
  }
  assert.equal(front.userData,back.userData);assert(back.boundingSphere.equals(front.boundingSphere));
  const initialBack=shaderFor(back.material),initialFront=shaderFor(front.material);
  assert.equal(initialBack.vertexShader,initialFront.vertexShader);assert.equal(initialBack.fragmentShader,initialFront.fragmentShader);
  assert.equal(initialBack.uniforms.homeFaceMode.value,-1);assert.equal(initialFront.uniforms.homeFaceMode.value,1);
  assert.notEqual(initialBack.uniforms.homeFaceMode,initialFront.uniforms.homeFaceMode);
  // Verify the precise insertion points, not just a stand-alone equivalent formula.
  assert(initialBack.vertexShader.indexOf('transformedNormal = -transformedNormal')>initialBack.vertexShader.indexOf('#include <defaultnormal_vertex>'));
  assert(initialBack.vertexShader.indexOf('transformedNormal = -transformedNormal')<initialBack.vertexShader.indexOf('#include <normal_vertex>'));
  assert(initialBack.vertexShader.indexOf('transformedNormal = -transformedNormal')<initialBack.vertexShader.indexOf('#include <shadowmap_vertex>'));
  assert(THREE.ShaderChunk.defaultnormal_vertex.includes('transformedNormal = normalMatrix * transformedNormal;\n#ifdef FLIP_SIDED\n\ttransformedNormal = - transformedNormal;'));
  assert(THREE.ShaderChunk.shadowmap_vertex.includes('inverseTransformDirection( transformedNormal, viewMatrix )'));
  assert(initialBack.fragmentShader.includes(THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;',
    'if (homeFaceMode == 0) normal *= faceDirection;')),'all other normal-fragment code remains byte-identical');
  const discard='if ((homeFaceMode < 0 && gl_FrontFacing) || (homeFaceMode > 0 && !gl_FrontFacing)) discard;';
  assert(initialBack.fragmentShader.indexOf(discard)<initialBack.fragmentShader.indexOf('#include <clipping_planes_fragment>'));
  const rooms=[{id:'room',polygon:[[-5,-5],[5,-5],[5,5],[-5,5]]}],windows=[{room:'room',a:[-1,-5],b:[1,-5]}];
  const group=new THREE.Group(),floor=mesh('floors'),frame=mesh('frames'),wall=mesh('walls');group.add(floor,frame,wall,back,front);
  const create=limit=>context.createRoomLighting(THREE,rooms,3,windows,{packed:true,maxFragmentUniforms:limit});
  let controller=create(1024);
  const identities=group.children.map(object=>[object.id,object.material,object.geometry]);
  for(const enabled of [true,false,true]){
    controller.attach(group,enabled,{staticGeometry:true});
    const shaders=group.children.map(object=>shaderFor(object.material));
    for(const shader of shaders){assert.equal(shader.vertexShader,shaders[0].vertexShader);assert.equal(shader.fragmentShader,shaders[0].fragmentShader);}
    assert.equal(new Set(group.children.map(object=>object.material.customProgramCacheKey())).size,1,'one shared family for all eligible roles');
    assert.deepEqual(shaders.map(shader=>shader.uniforms.homeFaceMode.value),[0,0,0,-1,1]);
    assert.deepEqual(shaders.map(shader=>shader.uniforms.homeWallSheenEnabled.value),[false,false,true,false,false]);
    assert.equal(shaders[3].uniforms.homeFaceMode,initialBack.uniforms.homeFaceMode,'cached facing uniform ownership survives reattachment');
    assert.equal(shaders[4].uniforms.homeFaceMode,initialFront.uniforms.homeFaceMode);
  }
  // Include built-in side/OPAQUE/light/clipping prefixes and actual cache keys,
  // not only onBeforeCompile output. GL methods record source; no linking occurs.
  const submitted=[];
  const gl={VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,
    createProgram:()=>({}),createShader:type=>({type}),shaderSource(shader,text){submitted.push({type:shader.type,text});},
    compileShader(){},attachShader(){},linkProgram(){},bindAttribLocation(){}};
  const renderer={getContext:()=>gl,getRenderTarget:()=>null,outputColorSpace:THREE.SRGBColorSpace,
    toneMapping:THREE.ACESFilmicToneMapping,shadowMap:{enabled:true,type:THREE.BasicShadowMap},debug:{checkShaderErrors:false}};
  const capabilities={precision:'highp',getMaxPrecision:value=>value,vertexTextures:true,logarithmicDepthBuffer:false,reverseDepthBuffer:false};
  const bindings={releaseStatesOfProgram(){}},clipping={numPlanes:1,numIntersection:0};
  const programs=new THREE.TestPrograms(renderer,{get:()=>null},{get:()=>null},{has:()=>false},capabilities,bindings,clipping);
  const lights={directional:[{}],point:[{},{},{}],spot:[],spotLightMap:[],rectArea:[],hemi:[{}],
    directionalShadowMap:[{}],pointShadowMap:[{},{}],spotShadowMap:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};
  const scene=new THREE.Scene();let compiledCases=0;
  for(const enabled of [true,false])for(const pointCount of [0,3,72])for(const shadowCount of [0,Math.min(2,pointCount)]){
    controller.attach(group,enabled,{staticGeometry:true});
    lights.point=Array.from({length:pointCount},()=>({}));lights.pointShadowMap=Array.from({length:shadowCount},()=>({}));
    const outputs=group.children.map(object=>{
      const params=programs.getParameters(object.material,lights,[{}],scene,object);
      const shader=shaderFor(object.material);params.vertexShader=shader.vertexShader;params.fragmentShader=shader.fragmentShader;
      const key=programs.getProgramCacheKey(params);submitted.length=0;
      new THREE.TestProgram(renderer,key,params,bindings);
      assert.equal(submitted.length,2);assert(params.doubleSided);assert.equal(params.flipSided,false);assert.equal(params.opaque,false);
      return {key,vertex:submitted[0].text,fragment:submitted[1].text};
    });
    for(const output of outputs)assert.deepEqual(output,outputs[0],'actual submitted prefixes, expanded GLSL and cache keys match all five roles');
    compiledCases+=outputs.length;
  }
  // New controller objects may fall back to literal geometry and later recover.
  for(const limit of [1,1024,1,1024]){
    controller=create(limit);controller.attach(group,true,{staticGeometry:true});
    assert.equal(controller.geometryMode,limit===1?'literal':'packed');
    assert.equal(floor.material.blending,limit===1?THREE.NormalBlending:THREE.NoBlending);
    for(const [index,object] of group.children.entries()){
      assert.equal(object.id,identities[index][0]);assert.equal(object.material,identities[index][1]);assert.equal(object.geometry,identities[index][2]);
    }
    const b=shaderFor(back.material),f=shaderFor(front.material);
    assert.equal(b.vertexShader,f.vertexShader);assert.equal(b.fragmentShader,f.fragmentShader);
    assert.equal(b.uniforms.homeFaceMode,initialBack.uniforms.homeFaceMode);assert.equal(f.uniforms.homeFaceMode,initialFront.uniforms.homeFaceMode);
    assert.equal(back.material.blending,THREE.NormalBlending);assert.equal(front.material.blending,THREE.NormalBlending);
  }
  // Test original/candidate face selection and normals in actual camera space,
  // including mirrored transforms and the world-normal shadow-bias calculation.
  let checked=0;
  for(const scale of [[1.2,.8,1.4],[-1.2,.8,1.4],[1.2,-.8,1.4],[1.2,.8,-1.4]])for(const eye of [[0,4,10],[10,3,-6],[-7,8,2]]){
    const world=new THREE.Matrix4().compose(back.position,back.quaternion,new THREE.Vector3(...scale));
    const camera=new THREE.PerspectiveCamera(42,1.4,.1,100);camera.position.set(...eye);camera.lookAt(back.position);camera.updateMatrixWorld(true);
    const normalMatrix=new THREE.Matrix3().getNormalMatrix(new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse,world));
    const project=index=>new THREE.Vector3().fromBufferAttribute(geometry.attributes.position,index).applyMatrix4(world).project(camera);
    for(let triangle=0;triangle<indices.length;triangle+=3){
      const [a,b,c]=indices.slice(triangle,triangle+3).map(project);
      const ccw=(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)>0;
      const facing=world.determinant()<0?!ccw:ccw;
      for(const mode of [-1,0,1]){
        const discardCandidate=(mode<0&&facing)||(mode>0&&!facing);
        const stockSurvives=mode===0||(mode<0?!facing:facing);
        assert.equal(!discardCandidate,stockSurvives);
        for(let vertex=0;vertex<geometry.attributes.normal.count;vertex++){
          const transformed=new THREE.Vector3().fromBufferAttribute(geometry.attributes.normal,vertex).applyMatrix3(normalMatrix);
          const stock=transformed.clone().multiplyScalar(mode<0?-1:1);
          const candidate=transformed.clone();if(mode<0)candidate.negate();
          const stockWorld=stock.clone().transformDirection(camera.matrixWorld),candidateWorld=candidate.clone().transformDirection(camera.matrixWorld);
          assert(stockWorld.distanceTo(candidateWorld)<1e-12);
          const point=new THREE.Vector3().fromBufferAttribute(geometry.attributes.position,vertex).applyMatrix4(world);
          for(const bias of [0,.035,.1])assert(point.clone().addScaledVector(stockWorld,bias).distanceTo(point.clone().addScaledVector(candidateWorld,bias))<1e-12);
          stock.normalize();candidate.normalize();if(mode===0){stock.multiplyScalar(facing?1:-1);candidate.multiplyScalar(facing?1:-1);}
          assert(stock.distanceTo(candidate)<1e-12);checked++;
        }
      }
    }
  }
  const compare=(a,b)=>a.groupOrder-b.groupOrder||a.renderOrder-b.renderOrder||b.z-a.z||a.id-b.id;
  for(const eye of [[0,4,10],[10,3,-6],[-7,8,2]]){
    group.updateMatrixWorld(true);const camera=new THREE.PerspectiveCamera(42,1.4,.1,100);camera.position.set(...eye);camera.lookAt(0,1,0);camera.updateMatrixWorld(true);
    const entries=group.children.map(object=>{
      object.geometry.computeBoundingSphere();return {object,id:object.id,groupOrder:0,renderOrder:object.renderOrder,
        z:(object.boundingSphere||object.geometry.boundingSphere).center.clone().applyMatrix4(object.matrixWorld).project(camera).z};
    }).sort(compare);
    assert.equal(entries[entries.findIndex(entry=>entry.object===back)+1].object,front);
  }
  // Real production lifecycle handlers release material cache listeners while
  // lost; CPU material/geometry identities remain valid for restored uploads.
  const eventSource=(start,end)=>viewer.slice(viewer.indexOf(start)+start.length,viewer.indexOf(end,viewer.indexOf(start)));
  const loss=eventSource("renderer.domElement.addEventListener('webglcontextlost',",");\nrenderer.domElement.addEventListener('webglcontextrestored'");
  Object.assign(context,{cancelRender(){},interactionPointer:{},interactionRenderer:null,renderLost:false});
  vm.runInContext('this.loss='+loss,context);
  let generation=0,lost=false,stale=0,disposals=0;
  function register(){for(const material of [back.material,front.material]){
    const created=generation;const listener=()=>{if(!lost&&generation!==created)stale++;disposals++;material.removeEventListener('dispose',listener);};material.addEventListener('dispose',listener);
  }}
  register();for(let cycle=0;cycle<2;cycle++){
    lost=true;context.loss({preventDefault(){}});lost=false;generation++;register();
    assert.equal(back.geometry,geometry);assert.equal(front.geometry,geometry);assert.equal(front.parent,group);
    assert.equal(shaderFor(back.material).uniforms.homeFaceMode,initialBack.uniforms.homeFaceMode);
  }
  let geometryDisposals=0,originalDisposals=0;geometry.addEventListener('dispose',()=>geometryDisposals++);original.addEventListener('dispose',()=>originalDisposals++);
  passes.dispose();passes.dispose();assert.equal(disposals,6);assert.equal(stale,0);assert.equal(geometryDisposals,0);assert.equal(originalDisposals,0);
  assert.equal(back.material,original);assert.equal(front.parent,null);assert.equal(back.boundingSphere,undefined);
  for(const key of ['position','normal'])assert.deepEqual(Array.from(geometry.attributes[key].array),values[key]);
  assert.deepEqual(Array.from(geometry.index.array),indices);
  const rejected=[o=>o.castShadow=true,o=>o.material.flatShading=true,o=>o.material.stencilWrite=true,o=>o.material.map=new THREE.Texture(),
    o=>o.material.alphaTest=.1,o=>o.material.blending=THREE.AdditiveBlending,o=>o.material.premultipliedAlpha=true,
    o=>o.onBeforeRender=()=>{},o=>o.material.onBeforeCompile=()=>{},o=>o.material.clipShadows=true,o=>o.material.clippingPlanes=[],
    o=>o.geometry.setAttribute('tangent',new THREE.Float32BufferAttribute(new Float32Array(16),4)),o=>o.geometry.setIndex(null),o=>new THREE.Group().add(o)];
  for(const change of rejected){const object=mesh();change(object);const material=object.material;assert.equal(context.createStaticGlassPasses(THREE,object,true),null);assert.equal(object.material,material);}
  assert.equal(context.createStaticGlassPasses(THREE,mesh(),false),null,'non-diffuse path unchanged');
  assert(viewer.includes('createStaticGlassPasses(THREE,mesh,renderProfile.diffuseLighting);root.add(mesh);if(glassPasses)root.add(glassPasses.front)'));
  assert(viewer.includes('disposeStaticGlassPasses();renderer.dispose()'));
  context.disposeStaticGlassPasses();
  console.log(JSON.stringify({checkedNormalAndBiasCases:checked,compiledPrefixCases:compiledCases,rejectionCases:rejected.length,sharedRoles:5,restorationGenerations:2}));
})().catch(error=>{console.error(error);process.exitCode=1;});
