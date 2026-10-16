// Exercise the real pinned Lambert source, CPU picking and owned-state lifecycle.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'room-lighting.js'),'utf8');
const viewer=fs.readFileSync(path.join(root,'viewer.js'),'utf8');
(async()=>{
  const vendor=fs.readFileSync(path.join(root,'vendor/three.module.min.js'),'utf8');
  assert(vendor.includes('function bl(t,e,n,i){const r=t.getContext()'));
  assert(vendor.includes('function Al(t,e,n,i,r,s,a){'));
  const THREE=await import('data:text/javascript;base64,'+Buffer.from(vendor+'\nexport {bl as TestProgram,Al as TestPrograms};').toString('base64'));
  const context=vm.createContext({Float32Array,Uint16Array,Uint32Array});vm.runInContext(source,context);
  const rooms=[{id:'room',polygon:[[-5,-5],[5,-5],[5,5],[-5,5]]}],windows=[{room:'room',a:[-1,-5],b:[1,-5]}];
  const controller=(packed=true,limit=1024)=>context.createRoomLighting(THREE,rooms,18,windows,{packed,maxFragmentUniforms:limit});
  function box(register=true){
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(2,3,4),new THREE.MeshLambertMaterial({color:0xb87637}));
    mesh.position.set(2,1.5,-3);mesh.rotation.y=.37;mesh.castShadow=mesh.receiveShadow=true;
    if(register)context.registerFallbackBoxProgram(THREE,mesh,true);
    return mesh;
  }
  function shaderFor(material){const shader={uniforms:{},vertexShader:THREE.ShaderLib.lambert.vertexShader,fragmentShader:THREE.ShaderLib.lambert.fragmentShader};material.onBeforeCompile(shader,{});return shader;}
  const object=box(),material=object.material,geometry=object.geometry;
  const objects=new THREE.Group();objects.add(object);
  const reference=box(false),referenceGroup=new THREE.Group();referenceGroup.add(reference);
  const structural=new THREE.Group();
  for(const category of ['floors','frames','walls']){
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(2,3,4),new THREE.MeshLambertMaterial({side:THREE.DoubleSide,transparent:category==='walls',opacity:category==='walls'?.16:1,forceSinglePass:category==='walls'}));
    mesh.userData.category=category;mesh.material.clippingPlanes=[new THREE.Plane(new THREE.Vector3(0,-1,0),40)];mesh.receiveShadow=true;structural.add(mesh);
  }
  const identity={object:object.id,material:material.id,geometry:geometry.id};
  const values={position:Array.from(geometry.attributes.position.array),normal:Array.from(geometry.attributes.normal.array),index:Array.from(geometry.index.array)};
  let lighting=controller();
  lighting.attach(structural,true,{staticGeometry:true});lighting.attach(objects,true);
  const firstShader=shaderFor(material),firstFacing=firstShader.uniforms.homeFaceMode;
  assert.equal(firstFacing.value,1);assert.equal(firstShader.uniforms.homeWallSheenEnabled.value,false);
  assert.equal(material.side,THREE.DoubleSide);assert.equal(material.blending,THREE.NoBlending);assert.equal(material.shadowSide,THREE.BackSide);assert.equal(material.clipShadows,false);
  assert.equal(material.transparent,false);assert.equal(material.opacity,1);
  assert.equal(object.id,identity.object);assert.equal(material.id,identity.material);assert.equal(geometry.id,identity.geometry);
  // The new callback is installed only in the plain fallback branch, never on assets.
  assert.equal(viewer.split('registerFallbackBoxProgram(THREE,o,renderProfile.diffuseLighting)').length-1,1);
  assert.match(viewer,/else\{const geo=new THREE\.BoxGeometry[^\n]+registerFallbackBoxProgram\(THREE,o,renderProfile\.diffuseLighting\)/);

  const submitted=[];
  const gl={VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,createProgram:()=>({}),createShader:type=>({type}),
    shaderSource(shader,text){submitted.push({type:shader.type,text});},compileShader(){},attachShader(){},linkProgram(){},bindAttribLocation(){}};
  const renderer={getContext:()=>gl,getRenderTarget:()=>null,outputColorSpace:THREE.SRGBColorSpace,toneMapping:THREE.ACESFilmicToneMapping,
    shadowMap:{enabled:true,type:THREE.BasicShadowMap},debug:{checkShaderErrors:false}};
  const capabilities={precision:'highp',getMaxPrecision:x=>x,vertexTextures:true,logarithmicDepthBuffer:false,reverseDepthBuffer:false};
  const bindings={releaseStatesOfProgram(){}},clipping={numPlanes:1,numIntersection:0};
  const programs=new THREE.TestPrograms(renderer,{get:()=>null},{get:()=>null},{has:()=>false},capabilities,bindings,clipping);
  const lights={directional:[{}],point:[],spot:[],spotLightMap:[],rectArea:[],hemi:[{}],directionalShadowMap:[{}],pointShadowMap:[],spotShadowMap:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};
  const scene=new THREE.Scene();let compiled=0;
  for(const enabled of [true,false])for(const count of [0,18,72])for(const shadows of [0,Math.min(count,2)]){
    lighting.attach(structural,enabled,{staticGeometry:true});lighting.attach(objects,enabled);
    lights.point=Array.from({length:count},()=>({}));lights.pointShadowMap=Array.from({length:shadows},()=>({}));
    const outputs=[...structural.children,object].map(mesh=>{
      const params=programs.getParameters(mesh.material,lights,[{}],scene,mesh),shader=shaderFor(mesh.material);
      params.vertexShader=shader.vertexShader;params.fragmentShader=shader.fragmentShader;
      const key=programs.getProgramCacheKey(params);submitted.length=0;new THREE.TestProgram(renderer,key,params,bindings);
      assert.equal(params.doubleSided,true);assert.equal(params.flipSided,false);assert.equal(params.opaque,false);
      return {key,vertex:submitted[0].text,fragment:submitted[1].text};
    });
    for(const output of outputs)assert.deepEqual(output,outputs[0],'real expanded GLSL, prefixes and program keys share the structural family');
    compiled+=outputs.length;
  }
  // An original FrontSide caster uses BackSide in Three's BasicShadowMap path.
  const shadowSource=fs.readFileSync(path.join(root,'vendor/three.module.min.js'),'utf8');
  assert(shadowSource.includes('f={[u]:d,[d]:u,2:2}'));
  const shadowStart=shadowSource.indexOf('function b(e,n,i,r){let s=null;const a=!0===i.isPointLight?e.customDistanceMaterial:e.customDepthMaterial;');
  assert(shadowStart>0);const shadowEnd=shadowSource.indexOf('function w(',shadowStart);
  const shadowContext=vm.createContext({t:{localClippingEnabled:true,properties:{get:()=>({})}},h:THREE.VSMShadowMap,
    f:{[THREE.FrontSide]:THREE.BackSide,[THREE.BackSide]:THREE.FrontSide,[THREE.DoubleSide]:THREE.DoubleSide},
    c:new THREE.MeshDistanceMaterial(),o:new THREE.MeshDepthMaterial(),p:{},T(){}});
  vm.runInContext(shadowSource.slice(shadowStart,shadowEnd),shadowContext);
  for(const isPointLight of [false,true]){
    const stock=shadowContext.b(reference,reference.material,{isPointLight},THREE.BasicShadowMap).clone();
    const candidate=shadowContext.b(object,material,{isPointLight},THREE.BasicShadowMap).clone();
    for(const key of ['side','clipShadows','map','alphaMap','alphaTest','wireframe','displacementMap'])assert.equal(candidate[key],stock[key],key);
    assert.equal(candidate.side,THREE.BackSide);assert.equal(candidate.clipShadows,false);
  }
  assert.equal(material.shadowSide,THREE.BackSide);
  assert(firstShader.vertexShader.includes('if (homeFaceMode < 0) transformedNormal = -transformedNormal;'));
  assert(firstShader.fragmentShader.includes('if (homeFaceMode == 0) normal *= faceDirection;'));
  const originalNormal=THREE.ShaderChunk.defaultnormal_vertex;
  assert(originalNormal.includes('transformedNormal = normalMatrix * transformedNormal;'));
  assert(THREE.ShaderChunk.shadowmap_vertex.includes('inverseTransformDirection( transformedNormal, viewMatrix )'));
  function preprocess(text,defines){
    const stack=[];let active=true;const out=[];
    const expression=value=>Function('return '+value.replace(/defined\(\s*(\w+)\s*\)/g,(_,name)=>defines.has(name)?'true':'false'))();
    for(const line of text.split('\n')){
      const t=line.trim();let match;
      if((match=t.match(/^#(ifdef|ifndef) (\w+)$/))){const pass=defines.has(match[2])===(match[1]==='ifdef');stack.push({parent:active,matched:pass});active=active&&pass;}
      else if(t.startsWith('#if ')){const pass=expression(t.slice(4));stack.push({parent:active,matched:pass});active=active&&pass;}
      else if(t.startsWith('#elif ')){const top=stack.at(-1),pass=!top.matched&&expression(t.slice(6));active=top.parent&&pass;top.matched||=pass;}
      else if(t==='#else'){const top=stack.at(-1);active=top.parent&&!top.matched;top.matched=true;}
      else if(t==='#endif')active=stack.pop().parent;
      else if(active&&t)out.push(t);
    }
    assert.equal(stack.length,0);return out.join('\n');
  }
  const stockNormal=preprocess(THREE.ShaderChunk.normal_fragment_begin,new Set());
  const normalStart=firstShader.fragmentShader.indexOf('float faceDirection ='),normalEnd=firstShader.fragmentShader.indexOf('vec3 nonPerturbedNormal = normal;');
  assert(normalStart>=0&&normalEnd>normalStart);
  const emittedNormal=firstShader.fragmentShader.slice(normalStart,normalEnd+'vec3 nonPerturbedNormal = normal;'.length);
  const normalGuard='if (homeFaceMode == 0) normal *= faceDirection;';
  assert.equal(emittedNormal.split(normalGuard).length-1,1);
  const candidateNormal=preprocess(emittedNormal.replace(normalGuard,''),new Set(['DOUBLE_SIDED']));
  assert.equal(candidateNormal,stockNormal,'mode +1 yields byte-identical active normal expressions, including all retained normal stages');
  assert.equal(preprocess(THREE.ShaderChunk.defaultnormal_vertex,new Set(['DOUBLE_SIDED'])),preprocess(THREE.ShaderChunk.defaultnormal_vertex,new Set()));
  const discardMatch=firstShader.fragmentShader.match(/if \(([^\n]+)\) discard;/);
  assert(discardMatch,'the actual emitted fragment must contain its facing discard');
  const emittedDiscard=Function('homeFaceMode','gl_FrontFacing','return ('+discardMatch[1]+');');
  let rays=0,bounds=0,clipChecks=0,faceChecks=0;
  const seenFaces=new Set();
  for(const scale of [[1,1,1],[-1.2,.8,1.4],[1,-1,1],[1,1,-1]])for(const position of [[2,1.5,-3],[1e5,-1e5,1e5],[-1e8,1e8,-1e8]]){
    object.scale.set(...scale);object.position.set(...position);reference.scale.copy(object.scale);reference.position.copy(object.position);
    objects.updateMatrixWorld(true);referenceGroup.updateMatrixWorld(true);lighting.attach(objects,true);
    const plane=material.clippingPlanes[0];
    for(let i=0;i<geometry.attributes.position.count;i++){
      const point=new THREE.Vector3().fromBufferAttribute(geometry.attributes.position,i).applyMatrix4(object.matrixWorld);
      assert(plane.distanceToPoint(point)>0,'every original vertex stays in the nonbinding half-space');
      assert(Math.fround(plane.constant)-Math.fround(point.y)>0,'Float32 world-plane distance remains positive');bounds++;
    }
    for(const direction of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]])for(const inside of [false,true]){
      const delta=new THREE.Vector3(...direction),origin=object.position.clone().addScaledVector(delta,inside?0:12),raycaster=new THREE.Raycaster(origin,delta.clone().multiplyScalar(inside?1:-1));
      const actual=[],expected=[];object.raycast(raycaster,actual);reference.raycast(raycaster,expected);
      assert.deepEqual(actual.map(h=>[h.distance,h.faceIndex,h.point.toArray()]),expected.map(h=>[h.distance,h.faceIndex,h.point.toArray()]));
      assert.equal(material.side,THREE.DoubleSide);rays++;
    }
    for(const eye of [[0,10,20],[20,10,0],[-10,5,-15]]){
      const camera=new THREE.PerspectiveCamera(42,1.4,.1,1e10);camera.position.copy(object.position).add(new THREE.Vector3(...eye));camera.lookAt(object.position);camera.updateMatrixWorld(true);
      const viewPlane=plane.clone().applyMatrix4(camera.matrixWorldInverse),planeNormal=viewPlane.normal.toArray().map(Math.fround),constant=Math.fround(viewPlane.constant);
      for(let triangle=0;triangle<geometry.index.count;triangle+=3){
        const vertices=[0,1,2].map(offset=>new THREE.Vector3().fromBufferAttribute(geometry.attributes.position,geometry.index.getX(triangle+offset)).applyMatrix4(object.matrixWorld));
        const [a,b,c]=vertices.map(v=>v.clone().project(camera)),ccw=(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)>0;
        const frontFacing=object.matrixWorld.determinant()<0?!ccw:ccw;
        // Three reverses GL front winding for a negative object determinant;
        // the original FrontSide material keeps exactly this raster face set.
        const stockSurvives=frontFacing;
        assert.equal(!emittedDiscard(1,frontFacing),stockSurvives,'actual emitted mode +1 predicate retains the stock front face');
        seenFaces.add(frontFacing);faceChecks++;
        for(let i=0;i<=3;i++)for(let j=0;j<=3-i;j++){
          const point=vertices[0].clone().multiplyScalar(i/3).addScaledVector(vertices[1],j/3).addScaledVector(vertices[2],1-(i+j)/3);
          const view=point.applyMatrix4(camera.matrixWorldInverse).toArray().map(Math.fround);
          const dot=Math.fround(planeNormal.reduce((sum,n,k)=>Math.fround(sum+Math.fround(-view[k]*n)),0));
          assert(dot<=constant,'camera-transformed Float32 plane preserves interior triangle samples');clipChecks++;
        }
      }
    }
  }
  assert.deepEqual([...seenFaces].sort(),[false,true],'both front and back raster cases were exercised');
  // Exact original fields return across distinct controllers and Home/editor switches.
  const original={side:THREE.FrontSide,shadowSide:null,blending:THREE.NormalBlending,clippingPlanes:null,clipShadows:false};
  for(const [packed,limit] of [[false,1024],[true,1],[true,1024],[false,1024],[true,1024]]){
    lighting=controller(packed,limit);lighting.attach(objects,false);lighting.attach(objects,true);
    if(lighting.geometryMode==='literal'){for(const [key,value] of Object.entries(original))assert.equal(material[key],value,key);assert.equal(object.raycast,THREE.Mesh.prototype.raycast);}
    else {assert.equal(shaderFor(material).uniforms.homeFaceMode,firstFacing);assert.equal(material.side,THREE.DoubleSide);}
    assert.equal(material.id,identity.material);assert.equal(geometry.id,identity.geometry);
  }
  for(let generation=0;generation<2;generation++){
    material.dispose();lighting=controller();lighting.attach(objects,true);
    assert.equal(shaderFor(material).uniforms.homeFaceMode,firstFacing,'controller and GPU cache generations retain the owned uniform');
    assert.equal(object.material,material);assert.equal(object.geometry,geometry);
  }
  assert.throws(()=>object.raycast(null,[]));assert.equal(material.side,THREE.DoubleSide,'raycast errors restore the render side');
  material.emissive.setRGB(.2,.3,.4);material.emissiveIntensity=.7;lighting.attach(objects,true);
  assert.deepEqual(material.emissive.toArray(),[.2,.3,.4]);assert.equal(material.emissiveIntensity,.7);
  for(const mutate of [m=>m.transparent=true,m=>m.opacity=.5,m=>m.map={},m=>m.alphaMap={},m=>m.vertexColors=true,m=>m.alphaTest=.1,m=>m.wireframe=true,m=>m.shadowSide=THREE.FrontSide]){
    const mesh=box(),group=new THREE.Group();group.add(mesh);mutate(mesh.material);controller().attach(group,true);
    assert.equal(mesh.material.side,THREE.FrontSide);assert.equal(mesh.material.blending,THREE.NormalBlending);assert(!shaderFor(mesh.material).uniforms.homeFaceMode);
  }
  // Shared or externally changed materials cannot silently acquire a private mode.
  const shared=box(),other=new THREE.Mesh(shared.geometry,shared.material),sharedGroup=new THREE.Group();sharedGroup.add(shared,other);controller().attach(sharedGroup,true);
  assert.equal(shared.material.side,THREE.FrontSide);assert.equal(shared.material.blending,THREE.NormalBlending);
  material.side=THREE.BackSide;controller().attach(objects,true);assert.equal(material.side,THREE.BackSide);assert.equal(material.blending,THREE.NormalBlending);
  assert.equal(material.shadowSide,null);assert.equal(material.clippingPlanes,null);
  const externallyBlended=box(),externalGroup=new THREE.Group();externalGroup.add(externallyBlended);controller().attach(externalGroup,true);
  externallyBlended.material.blending=THREE.AdditiveBlending;controller().attach(externalGroup,true);
  assert.equal(externallyBlended.material.blending,THREE.AdditiveBlending);assert.equal(externallyBlended.material.side,THREE.FrontSide);
  assert.equal(externallyBlended.raycast,THREE.Mesh.prototype.raycast);
  const ordinary=box(false),ordinaryGroup=new THREE.Group();ordinaryGroup.add(ordinary);controller().attach(ordinaryGroup,true);assert.equal(ordinary.material.side,THREE.FrontSide);
  for(const key of ['position','normal'])assert.deepEqual(Array.from(geometry.attributes[key].array),values[key]);assert.deepEqual(Array.from(geometry.index.array),values.index);
  console.log(`fallback shared program: ${compiled} compiled material cases, ${rays} picking rays, ${bounds} world bounds, ${clipChecks} Float32 clip samples, ${faceChecks} emitted-predicate cases, active normal-stage byte parity PASS`);
})().catch(error=>{console.error(error);process.exitCode=1;});
