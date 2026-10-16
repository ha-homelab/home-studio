// CPU proof for owned contour materials. No browser, timing or pixel claim.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
(async()=>{
  const rootPath=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(rootPath,'viewer.js'),'utf8');
  const vendor=fs.readFileSync(path.join(rootPath,'vendor/three.module.min.js'),'utf8');
  const THREE=await import('data:text/javascript;base64,'+Buffer.from(vendor+'\nexport {Al as TestPrograms};').toString('base64'));
  assert.equal(THREE.REVISION,'169');
  function extract(text,name){const start=text.indexOf('function '+name+'(');assert(start>=0,name);for(let end=text.indexOf('}',start);end>=0;end=text.indexOf('}',end+1)){const part=text.slice(start,end+1);try{new vm.Script(part);return part}catch{}}throw Error(name);}
  function box(bottom=0,top=2.7,angle=0){const c=Math.cos(angle),s=Math.sin(angle);return{kind:'walls',vertices:[[0,bottom,0],[2,bottom,0],[2,bottom,3],[0,bottom,3],[0,top,0],[2,top,0],[2,top,3],[0,top,3]].map(([x,y,z])=>[c*x-s*z,y,s*x+c*z]),indices:[0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7]};}
  const construction=source.slice(source.indexOf('let wallOutlines,'),source.indexOf('const wallSheenMotion='));
  function fixture(negative=false){
    const context=vm.createContext({THREE,root:null,clipping:{constant:2.1},model:{meshes:[box(),box(2.1,2.7,.4)]},updateRoundedWallGeometry(){}});
    vm.runInContext(extract(source,'wallBoundarySegments'),context);
    let text=construction;
    if(negative){text=text.replace('o.geometry?.dispose()','o.geometry?.dispose();o.material?.dispose()').replace(/wallOutlineMaterials\[slot(?:\+1)?\]\?\?=/g,'');}
    vm.runInContext(text,context);context.updateWallOutlines();
    assert.equal(vm.runInContext('wallOutlineMaterials.length',context),0,'Missing root cannot allocate contour materials');
    context.root=new THREE.Group();
    return {context,update(height){context.clipping.constant=height;context.updateWallOutlines();return vm.runInContext('wallOutlines',context);},slots(){return vm.runInContext('wallOutlineMaterials',context);}};
  }
  function expectedPositions(context,height,base){
    const edges=[],halo=[];
    for(const[a,b]of context.wallBoundarySegments(context.model.meshes,height,base)){
      const dx=b[0]-a[0],dz=b[2]-a[2],length=Math.hypot(dx,dz);if(length<1e-6)continue;
      const nx=-dz/length*.03,nz=dx/length*.03,y=a[1]+.008;
      edges.push(a[0],y,a[2],b[0],y,b[2]);
      const p=[a[0]+nx,y,a[2]+nz],q=[b[0]+nx,y,b[2]+nz],r=[b[0]-nx,y,b[2]-nz],s=[a[0]-nx,y,a[2]-nz];
      halo.push(...p,...q,...r,...p,...r,...s);
    }
    return[halo,edges].map(v=>Array.from(new Float32Array(v)));
  }
  const f=fixture(),saved=JSON.stringify(f.context.model),first=f.update(2.1),materials=first.children.map(o=>o.material);
  assert.equal(first.children.length,4);assert.equal(f.slots().length,4);assert.equal(first.renderOrder,1);
  for(const [i,m]of materials.entries()){
    assert.equal(m.type,i%2?'LineBasicMaterial':'MeshBasicMaterial');
    assert.equal(m.color.getHex(),i<2?0x387bff:0x81fff0);assert.equal(m.opacity,i%2?1:i<2?.22:.42);
    assert.equal(m.transparent,true);assert.equal(m.depthWrite,false);assert.equal(m.toneMapped,false);
    assert.equal(m.side,i%2?THREE.FrontSide:THREE.DoubleSide);assert.equal(m.forceSinglePass,i%2?false:true);
  }
  let geometryDisposals=0,materialDisposals=0,roundtrips=0,previous=first;
  materials.forEach(m=>m.addEventListener('dispose',()=>materialDisposals++));
  for(const height of[1.15,20,2.1,.82,2.7,1.15,20,2.1]){
    for(const o of previous.children)o.geometry.addEventListener('dispose',()=>geometryDisposals++);
    const group=f.update(height);roundtrips++;
    assert.notEqual(group,previous,'Keep fresh Object3D allocation/order');assert.equal(previous.parent,null);
    assert.deepEqual(group.children.map(o=>o.material),materials,'Exactly four retained material identities');
    assert.equal(f.slots().length,4);assert.equal(materialDisposals,0,'Height changes cannot evict programs');
    assert.equal(geometryDisposals,4*roundtrips,'Dispose every obsolete geometry once');
    assert(group.children.every((o,i)=>o.id>previous.children.at(-1).id&&(!i||o.id>group.children[i-1].id)));
    assert.deepEqual(group.children.map(o=>o.renderOrder),[0,1,0,1]);
    for(const base of[true,false]){const positions=expectedPositions(f.context,height,base),offset=base?0:2;positions.forEach((p,i)=>assert.deepEqual(Array.from(group.children[offset+i].geometry.attributes.position.array),p));}
    const unchanged=f.update(height);assert.equal(unchanged,group,'Unchanged cutaway is a no-op');assert.equal(geometryDisposals,4*roundtrips);
    previous=group;
  }
  assert.equal(JSON.stringify(f.context.model),saved,'Authored geometry remains immutable');
  const other=fixture();assert(other.update(2.1).children.every((o,i)=>o.material!==materials[i]),'No material cache shared across viewers');
  const sorting=vm.createContext({});vm.runInContext(['Cl','Pl','Il'].map(name=>extract(vendor,name)).join('\n'),sorting);
  for(const [groupOrder,renderOrder,z]of[[0,0,0],[1,1,.5],[2,-1,-3]]){
    const list=sorting.Il();
    for(const [i,material]of materials.entries())list.unshift({id:previous.children[i].id,renderOrder},null,material,groupOrder,z,null);
    assert.equal(list.opaque.length,0);assert.equal(list.transparent.length,4);list.sort();
    const before=Array.from(list.transparent,x=>x.id);
    list.transparent.forEach((item,i)=>item.material={id:100000-i});list.transparent.reverse();list.sort();
    const after=Array.from(list.transparent,x=>x.id);
    assert.deepEqual(after,before,'Transparent depth ties depend on fresh object order, not retained material IDs');
  }
  // Exercise real Three program ownership and material-dispose listeners with
  // generation-tagged inert handles. No WebGL execution or fake timing benefit.
  const disposeHandler=extract(vendor,'Ft');assert(disposeHandler.includes('ct.releaseProgram')&&disposeHandler.includes('nt.remove'));
  function programProof(negative=false,skipLossRelease=false){
    const test=fixture(negative);let epoch=1,lost=false,serial=0;const created=[],deleted=[],errors=[];
    const gl={VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,createShader:type=>({type}),shaderSource(){},compileShader(){},attachShader(){},linkProgram(){},bindAttribLocation(){},createProgram(){const p={id:++serial,epoch};created.push(p);return p;},deleteProgram(p){deleted.push(p);if(!lost&&p.epoch!==epoch)errors.push('stale program');}};
    const renderer={getContext:()=>gl,getRenderTarget:()=>null,outputColorSpace:THREE.SRGBColorSpace,toneMapping:THREE.ACESFilmicToneMapping,shadowMap:{enabled:false,type:THREE.BasicShadowMap},debug:{checkShaderErrors:false}};
    const lights={directional:[],point:[],spot:[],spotLightMap:[],rectArea:[],hemi:[],directionalShadowMap:[],pointShadowMap:[],spotShadowMap:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};
    function manager(){const ct=new THREE.TestPrograms(renderer,{get:()=>null},{get:()=>null},{has:()=>false},{precision:'highp',getMaxPrecision:x=>x,vertexTextures:true,logarithmicDepthBuffer:false,reverseDepthBuffer:false},{releaseStatesOfProgram(){}},{numPlanes:0,numIntersection:0}),entries=new Map(),nt={get(m){if(!entries.has(m))entries.set(m,{});return entries.get(m);},remove(m){entries.delete(m);}},c=vm.createContext({ct,nt});vm.runInContext(disposeHandler,c);return{ct,nt,handler:c.Ft};}
    let m=manager();const allMaterials=new Set();
    function upload(group){for(const object of group.children){const mat=object.material;allMaterials.add(mat);const props=m.nt.get(mat);if(!props.programs){props.programs=new Map();mat.addEventListener('dispose',m.handler);}const p=m.ct.getParameters(mat,lights,[],new THREE.Scene(),object),key=m.ct.getProgramCacheKey(p);if(!props.programs.has(key))props.programs.set(key,m.ct.acquireProgram(p,key));}}
    upload(test.update(2.1));const initialLinks=created.length;assert.equal(initialLinks,2,'Two exact original shader families');
    for(const height of[1.15,20,2.1,1.15,20,2.1])upload(test.update(height));
    const afterChanges=created.length;
    if(negative){assert(afterChanges>initialLinks,'Old material destruction exposes actual program churn');for(const mat of allMaterials)mat.dispose();return{initialLinks,afterChanges};}
    assert.equal(afterChanges,initialLinks,'No new program from height-only changes');assert.equal(deleted.length,0);
    const handlers={},c=test.context;
    Object.assign(c,{renderSuspended:false,renderLost:false,cancelRender(){},releaseViewerGeometryGPU(){},releaseViewerTextureGPU(){},editorFloorMaterials:null,interactionPointer:null,interactionRenderer:null,releaseStaticGlassPasses(){},disposeStaticGlassPasses(){},homeView:null,observer:{disconnect(){}},window:{addEventListener:(event,fn)=>handlers[event]=fn},renderer:{domElement:{addEventListener:(event,fn)=>handlers[event]=fn},dispose(){},forceContextLoss(){}}});
    for(const prefix of["renderer.domElement.addEventListener('webglcontextlost'","window.addEventListener('pagehide'"]){let line=source.split('\n').find(x=>x.startsWith(prefix));if(skipLossRelease&&prefix.includes('webglcontextlost'))line=line.replace('releaseWallOutlineMaterials();','');vm.runInContext(line,c);}
    handlers.pagehide({persisted:true});assert.equal(deleted.length,0,'BFCache retains programs');
    const firstMaterials=test.update(2.1).children.map(o=>o.material);
    lost=true;handlers.webglcontextlost({preventDefault(){}});epoch++;lost=false;m=manager();
    assert.deepEqual(test.update(1.15).children.map(o=>o.material),firstMaterials,'Restoration retains CPU material identities');upload(test.update(1.15));
    handlers.pagehide({persisted:false});assert.equal(test.slots().length,0);assert.equal(m.ct.programs.length,0);
    assert.equal(deleted.length,created.length);assert.equal(new Set(deleted).size,deleted.length,'Delete each program exactly once');
    if(skipLossRelease)assert(errors.length>0,'Missing loss release exposes stale-generation deletes');else assert.deepEqual(errors,[]);
    const finished=deleted.length;handlers.pagehide({persisted:false});assert.equal(deleted.length,finished,'Final release is idempotent');
    return{initialLinks,afterChanges,totalLinks:created.length,staleErrors:errors.length};
  }
  const positive=programProof(),negative=programProof(true),missingLossRelease=programProof(false,true);
  console.log(JSON.stringify({status:'PASS',roundtrips,geometryDisposals,materialSlots:4,positive,negative,missingLossRelease,scope:'CPU geometry/material/order parity and actual pinned program ownership; browser performance and pixels require separate validation'}));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
