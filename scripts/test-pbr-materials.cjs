const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=process.env.PBR_TEST_OUTPUT||'/tmp/home-studio-pbr-tests';fs.mkdirSync(out,{recursive:true});
const python=(args)=>{const result=spawnSync(process.env.PYTHON||'python3',args,{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024});if(result.status!==0)throw Error(result.error?.message||result.stderr||result.stdout.slice(-1000));return result.stdout};
(async()=>{
  const THREE=await import('data:text/javascript;base64,'+fs.readFileSync(path.join(root,'vendor/three.module.min.js')).toString('base64'));
  const context=vm.createContext({Uint8Array,Map,Set,atob});vm.runInContext(['pbr-color-data.js','pbr-materials.js'].map(p=>fs.readFileSync(path.join(root,p),'utf8')).join('\n').replaceAll('export ',''),context);
  const expected=JSON.parse(python(['scripts/test-pbr-materials.py','--hashes']));
  for(const [family,hashes] of Object.entries(expected))assert.deepEqual(Object.values(context.pbrDetailPixels(family,128,vm.runInContext('PBR_COLOR_DATA',context))).map(p=>crypto.createHash('sha256').update(p).digest('hex')),hashes,family+' Python/JS pixels');
  assert.equal(context.pbrDetailPixels('constructor'),null);assert.equal(context.pbrDetailPixels('__proto__'),null);
  const details=context.createPBRDetails(THREE),a=details.get('fabric'),b=details.get('fabric');assert.equal(a.normal_texture,b.normal_texture);assert.equal(a.normal_texture.colorSpace,THREE.NoColorSpace);assert.equal(a.normal_texture.repeat.x,40);
  const mat=new THREE.MeshStandardMaterial({color:0x786040});const original=mat.color.clone();context.applyMaterialPBR(THREE,mat,{channels:a,normalScale:.4});assert(mat.color.equals(original));assert.equal(mat.normalScale.x,.4);assert.equal(mat.normalMap,a.normal_texture);
  assert.equal(details.count,3);details.dispose();assert.equal(details.count,0);
  console.log(Object.keys(expected).length+' physical families: exact Python/JS byte parity, shared ownership, color and metric scale passed.');
  if(process.env.PBR_SKIP_BROWSER==='1')return;
  const html=python(['-c',`import importlib.util,sys,json;sys.path.insert(0,'.');s=importlib.util.spec_from_file_location('f','scripts/test-material-textures.py');f=importlib.util.module_from_spec(s);s.loader.exec_module(f);m,svg,_=f.fixture();p=m['object_assets']['textured']['meshes'][1];p['material_family']='leather';p['normal_scale']=0.5;from pbr_materials import family_textures,png_spec;b=m['object_assets']['textured']['meshes'][0];b.update(uv=[[x,z] for x,y,z in b['vertices']],normal_texture='normal',roughness_texture='orm',metalness_texture='orm',ao_texture='orm',albedo_texture='orm',albedo_tint=True);m['material_textures'].update(normal=family_textures('wood')['normal_texture'],orm=png_spec(bytes([180,200,255])*128*128));print(f.render_viewer(m,svg))`]);
  const hook=`window.__pbr={renderer,scene,objectsById,reflectionEnvironment,contactShading,inventoryTextures,homeView,drawScene,camera,sharing(){const owner=createPBRDetails(THREE),before=renderer.info.memory.textures,a=owner.get("wood",1),b=owner.get("wood",.25);for(const t of [...Object.values(a),...Object.values(b)])renderer.initTexture(t);const result={shared:a.normal_texture.source===b.normal_texture.source,allocated:renderer.info.memory.textures-before};owner.dispose();result.retained=renderer.info.memory.textures-before;return result},stats(){return {profile:renderProfile,env:!!scene.environment,contactPixels:contactShading.pixels,textures:renderer.info.memory.textures,draws:renderer.info.render.calls,glError:renderer.getContext().getError()}}};`;
  const hooked=html.replace('</script></body>',hook+'</script></body>');fs.writeFileSync(path.join(out,'fixture.html'),hooked);
  const {chromium}=require('playwright');const browser=await chromium.launch({headless:true,args:['--use-angle=metal']});
  try{
    const page=await browser.newPage({viewport:{width:1000,height:760}}),errors=[],requests=[];
    page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
    await page.route('**/*',route=>{requests.push(route.request().url());route.abort()});
    await page.setContent(hooked,{timeout:120000});await page.waitForFunction(()=>window.__pbr&&window.__pbr.objectsById.size===3,{timeout:120000});
    await page.evaluate(()=>{__pbr.homeView.setActive(true);window.renderModel()});
    const sharing=await page.evaluate(()=>__pbr.sharing());assert.deepEqual(sharing,{shared:true,allocated:3,retained:0});
    const before=await page.evaluate(()=>__pbr.stats());assert.equal(before.glError,0);assert(before.env);assert(before.contactPixels>0&&before.contactPixels<=250000);
    const properties=await page.evaluate(()=>__pbr.objectsById.get('textured').children.map(o=>({type:o.material.type,map:!!o.material.map,normal:!!o.material.normalMap,rough:!!o.material.roughnessMap,scale:o.material.normalScale?.x,ao:!!o.material.aoMap,metal:!!o.material.metalnessMap,linear:o.material.normalMap?.colorSpace,shared:o.material.roughnessMap===o.material.aoMap&&o.material.aoMap===o.material.metalnessMap,separateColor:o.material.map!==o.material.roughnessMap})));
    assert(properties.some(p=>p.map&&p.normal&&p.rough&&p.scale===.5));assert(properties.some(p=>p.ao&&p.metal&&p.shared&&p.separateColor&&p.linear===''));
    await page.screenshot({path:path.join(out,'pbr-enabled.png')});
    const comparison=await page.evaluate(()=>{window.renderModel();const a=__pbr.renderer.domElement.toDataURL();const maps=[];__pbr.objectsById.get('textured').traverse(o=>{if(o.material){maps.push([o.material,o.material.normalMap,o.material.roughnessMap]);o.material.normalMap=o.material.roughnessMap=null;o.material.needsUpdate=true}});window.renderModel();const b=__pbr.renderer.domElement.toDataURL();for(const [m,n,r]of maps){m.normalMap=n;m.roughnessMap=r;m.needsUpdate=true}window.renderModel();return {different:a!==b}});assert(comparison.different);
    await page.evaluate(()=>new Promise(resolve=>{const c=__pbr.renderer.domElement;window.__lost=__pbr.renderer.getContext().getExtension('WEBGL_lose_context');c.addEventListener('webglcontextlost',resolve,{once:true});__lost.loseContext()}));
    await page.evaluate(()=>new Promise(resolve=>{__pbr.renderer.domElement.addEventListener('webglcontextrestored',resolve,{once:true});__lost.restoreContext()}));
    await page.evaluate(()=>window.renderModel());const after=await page.evaluate(()=>__pbr.stats());assert.equal(after.glError,0);assert(after.env);assert.equal(after.textures,before.textures);assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
    const result={status:'PASS',node:process.version,playwright:require('playwright/package.json').version,browser:browser.version(),backend:'angle-metal',sharing,before,after,properties,errors,requests};fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
