// Real pinned Three ownership tests plus the compiled viewer, with fictional data.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const path = require('node:path'), os = require('node:os'), {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..'), source = fs.readFileSync(path.join(root, 'material-textures.js'), 'utf8');
function python(args) {
  const run = spawnSync(process.env.PYTHON || 'python3', [path.join(__dirname, 'test-material-textures.py'), ...args], {encoding:'utf8'});
  if (run.status !== 0) throw Error(run.stderr || run.stdout); return run.stdout;
}
const spec = JSON.parse(python(['--spec']));
(async () => {
  const THREE = await import('data:text/javascript;base64,' + fs.readFileSync(path.join(root, 'vendor/three.module.min.js')).toString('base64'));
  assert.equal(THREE.REVISION, '169');
  const made = [], loads = [];
  class TestTexture extends THREE.Texture { constructor(image) { super(image); made.push(this); this.released=0; this.addEventListener('dispose',()=>this.released++); } }
  class Image { constructor() { loads.push(this); this.naturalWidth=this.naturalHeight=256; } set src(value) { this.url=value; } }
  const context = vm.createContext({Image, atob, btoa}); vm.runInContext(source, context);
  const engine = {...THREE, Texture:TestTexture};
  const part = {material:'wood',vertices:[[0,1,0],[1,1,0],[0,1,1]],normals:[[0,1,0],[0,1,0],[0,1,0]],indices:[0,1,2],
    albedo_texture:'fabric',uv:[[0,0],[4,0],[0,4]],uv_dimensions:['width','depth']};
  const plain = {...part}; delete plain.albedo_texture;
  const asset={meshes:[part,plain]}, size={width:2,depth:3,height:1}, materials={wood:[.4,.3,.2,1]};
  let owner=context.createMaterialTextures(engine, {fabric:spec, same:spec});
  assert.equal(loads.length,1,'identical payloads decode only once');
  assert.equal(context.inventoryMaterialBatches(asset,size,materials,owner).length,1,'pending image retains original batch');
  loads[0].onload(); assert(await owner.ready);
  let batches=context.inventoryMaterialBatches(asset,size,materials,owner);
  assert.equal(batches.length,2); assert.equal(batches[0].uv[2],8); assert.equal(batches[0].uv[5],12);
  assert.equal(batches.reduce((sum,b)=>sum+b.indices.length,0),6);
  assert.equal(owner.count,1); assert.equal(batches[0].texture.colorSpace,THREE.SRGBColorSpace);
  assert.equal(owner.get({...part,uv:[]},size),null); assert.equal(owner.get({...part,uv:[[NaN,0],[0,0],[0,0]]},size),null);
  assert.equal(owner.get({...part,uv_dimensions:['width','width']},size),null);
  // Real room-lighting owns the original material throughout mode changes.
  vm.runInContext(fs.readFileSync(path.join(root,'room-lighting.js'),'utf8'),context);
  for(const Type of [THREE.MeshStandardMaterial,THREE.MeshLambertMaterial]) {
    const group=new THREE.Group(), material=new Type({map:batches[0].texture,color:0xffffff});
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(),material);group.add(mesh);
    const lighting=context.createRoomLighting(THREE,[{id:'room',polygon:[[0,0],[4,0],[4,4],[0,4]]}],1,[],{});
    for(const active of [true,false,true,false,true]) {
      lighting.attach(group,active); assert.equal(mesh.material,material); assert.equal(material.map,batches[0].texture);
      const lib=Type===THREE.MeshLambertMaterial?THREE.ShaderLib.lambert:THREE.ShaderLib.standard;
      const shader={uniforms:{},vertexShader:lib.vertexShader,fragmentShader:lib.fragmentShader};material.onBeforeCompile(shader);
      assert.equal(shader.vertexShader.includes('varying vec3 homeWorldPosition'),active);
      assert(shader.fragmentShader.includes('#include <map_fragment>'));
    }
    lighting.dispose();mesh.geometry.dispose();material.dispose();
  }
  for(let i=0;i<2;i++){owner.releaseGPU();assert.equal(made[0].released,i+1)}
  owner.dispose();assert.equal(made[0].released,3);assert.equal(owner.count,0);
  const count=loads.length;
  for(const bad of [{fabric:{...spec,data_uri:'https://example.invalid/image.png'}},{fabric:{...spec,width:512}}]) {
    const rejected=context.createMaterialTextures(engine,bad);assert.equal(await rejected.ready,false);
    assert.equal(context.inventoryMaterialBatches(asset,size,materials,rejected).length,1);
  }
  assert.equal(loads.length,count,'invalid payload never starts a decode');
  owner=context.createMaterialTextures(engine,{fabric:spec});loads.at(-1).onload();const raced=made.at(-1);owner.dispose();
  assert.equal(await owner.ready,false);assert.equal(raced.released,1,'onload-to-promise disposal race releases ownership');
  owner=context.createMaterialTextures(engine,{fabric:spec});loads.at(-1).onerror();assert.equal(await owner.ready,false);
  owner=context.createMaterialTextures(engine,{fabric:spec});owner.dispose();assert.equal(await owner.ready,false);
  console.log('Material ownership, UV scaling, fallback, room-lighting and disposal tests passed.');

  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'home-studio-materials-'));
  try {
    const file=path.join(temp,'viewer.html');python(['--fixture',file]);let html=fs.readFileSync(file,'utf8');
    const hook=`window.__materialTest={owner:inventoryTextures,renderer,objectsById,items,rebuildInventoryView,homeView,
      stats(){window.renderModel();const all=[];objectGroup.traverse(o=>{if(o.isMesh)all.push(o)});return {count:inventoryTextures.count,
      mapped:all.filter(o=>o.material.map).length,triangles:all.reduce((s,o)=>s+o.geometry.index.count/3,0),
      objects:all.length,types:all.map(o=>o.material.type),draws:renderer.info.render.calls};}};`;
    html=html.replace('</script></body>',hook+'</script></body>');
    const playwright=require('playwright');
    for(const name of (process.env.MATERIAL_TEXTURE_ENGINES||'chromium').split(',')) for(const diffuse of [false,true]) {
      const browser=await playwright[name].launch({headless:true,...(name==='chromium'?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}: {})});
      try {
        const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[],network=[];
        page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>{if(!r.url().startsWith('data:')&&!r.url().startsWith('about:'))network.push(r.url())});
        page.on('console',message=>{if(message.type()==='error')errors.push(message.text())});
        const rendered=html.replace('renderProfile=selectRenderProfile(renderer.getContext());',
          'renderProfile=selectRenderProfile(renderer.getContext());renderProfile.diffuseLighting='+diffuse+';');
        await page.setContent(rendered);await page.waitForFunction(()=>window.__materialTest?.owner.count===1&&window.__materialTest.stats().mapped===1);
        const before=await page.evaluate(()=>__materialTest.stats());assert.equal(before.triangles,36);assert.equal(before.objects,4);
        assert(before.types.every(type=>type===(diffuse?'MeshLambertMaterial':'MeshStandardMaterial')));
        await page.evaluate(()=>{const t=__materialTest;t.items[0].dimensions_m.width=2;t.rebuildInventoryView()});
        const u=await page.evaluate(()=>{const mesh=__materialTest.objectsById.get('textured').children.find(m=>m.material.map);return Math.max(...Array.from(mesh.geometry.attributes.uv.array).filter((_,i)=>i%2===0))});assert.equal(u,8);
        for(const active of [true,false,true,false]) {
          await page.evaluate(active=>{__materialTest.homeView.setActive(active);window.renderModel()},active);
          assert.equal((await page.evaluate(()=>__materialTest.stats())).mapped,1);
        }
        // BFCache suspension during decoded-map delivery must still rebuild.
        await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
        await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
        const recoverySupported=await page.evaluate(()=>!!__materialTest.renderer.getContext().getExtension('WEBGL_lose_context'));
        assert(recoverySupported,'Context-loss extension required for acceptance');
        for(let n=0;n<2;n++) {
          await page.evaluate(()=>new Promise(resolve=>{const r=__materialTest.renderer,c=r.domElement;window.__loss=r.getContext().getExtension('WEBGL_lose_context');c.addEventListener('webglcontextlost',resolve,{once:true});__loss.loseContext()}));
          await page.evaluate(()=>new Promise(resolve=>{__materialTest.renderer.domElement.addEventListener('webglcontextrestored',resolve,{once:true});__loss.restoreContext()}));
          const state=await page.evaluate(()=>__materialTest.stats());assert.equal(state.mapped,1);assert.equal(state.triangles,36);
        }
        const pixels=await page.evaluate(()=>{window.renderModel();return __materialTest.renderer.domElement.toDataURL()});
        await page.evaluate(()=>{__materialTest.owner.dispose();__materialTest.rebuildInventoryView();window.renderModel()});
        const fallback=await page.evaluate(()=>__materialTest.stats());assert.equal(fallback.mapped,0);assert.equal(fallback.objects,3);assert.equal(fallback.triangles,36);
        assert.notEqual(await page.evaluate(()=>__materialTest.renderer.domElement.toDataURL()),pixels,'map affects real pixels');
        assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
        console.log(name+' '+(diffuse?'Lambert':'Standard')+': compiled viewer pixels, bound lamp, resize, Home/Editor, two recoveries and original batching passed.');
      } finally {await browser.close()}
    }
  } finally {fs.rmSync(temp,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
