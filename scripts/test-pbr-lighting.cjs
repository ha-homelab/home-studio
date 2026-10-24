const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),output=process.env.PBR_TEST_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'pbr-lighting-'));fs.mkdirSync(output,{recursive:true,mode:0o700});
if(!fs.lstatSync(output).isDirectory()||fs.lstatSync(output).isSymbolicLink())throw Error('PBR output must be a real directory');
const writeOutput=(name,data)=>fs.writeFileSync(path.join(output,name),data,{flag:'wx',mode:0o600});
(async()=>{
  const THREE='data:text/javascript;base64,'+fs.readFileSync(path.join(root,'vendor/three.module.min.js')).toString('base64');
  const src=['pbr-color-data.js','pbr-materials.js','environment-lighting.js'].map(p=>fs.readFileSync(path.join(root,p),'utf8')).join('\n');
  const html=`<!doctype html><style>body{margin:0;background:#ddd}</style><script type="module">import * as THREE from '${THREE}';${src}
  const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setSize(800,600);renderer.localClippingEnabled=true;renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;document.body.append(renderer.domElement);
  const scene=new THREE.Scene();scene.background=new THREE.Color(.12,.12,.12);const camera=new THREE.PerspectiveCamera(38,800/600,.05,50);camera.position.set(3,3.2,4.5);camera.lookAt(0,.2,0);
  const light=new THREE.DirectionalLight(0xffffff,1.5);light.position.set(3,6,4);scene.add(light,new THREE.HemisphereLight(0xffffff,0x555555,.6));
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(8,8),new THREE.MeshStandardMaterial({color:0xa7a49d,roughness:.9}));floor.rotation.x=-Math.PI/2;scene.add(floor);
  const cube=new THREE.Mesh(new THREE.BoxGeometry(.8,.8,.8),new THREE.MeshStandardMaterial({color:0x9d5c39,roughness:.75}));cube.position.set(0,.4,0);scene.add(cube);
  const metal=new THREE.Mesh(new THREE.SphereGeometry(.45,48,32),new THREE.MeshStandardMaterial({color:0xbec6cf,metalness:1,roughness:.2}));metal.position.set(-1.1,.45,0);scene.add(metal);
  const panel=new THREE.Mesh(new THREE.BoxGeometry(.5,.5,.1),new THREE.MeshBasicMaterial({color:0xffffff,toneMapped:false}));panel.position.set(1,.25,.4);scene.add(panel);
  const detailOwner=createPBRDetails(THREE),instancedGeometry=new THREE.BoxGeometry(1,1,1),instancedMaterial=new THREE.MeshStandardMaterial();instancedGeometry.setAttribute('materialUVScale',new THREE.InstancedBufferAttribute(new Float32Array([2,3]),2));applyMaterialPBR(THREE,instancedMaterial,{channels:detailOwner.get('wood')});installInstanceMaterialUV(instancedMaterial);const instanced=new THREE.InstancedMesh(instancedGeometry,instancedMaterial,1);instanced.frustumCulled=false;instanced.setMatrixAt(0,new THREE.Matrix4().makeTranslation(100,0,0));scene.add(instanced);
  const quality={pixels:2000000,diffuseLighting:false},contact=createContactShading(THREE,renderer,quality);let environment=null;
  const render=ao=>{renderer.render(scene,camera);if(ao)contact.apply(scene,camera)};
  const pixels=()=>{const p=new Uint8Array(800*600*4);renderer.getContext().readPixels(0,0,800,600,renderer.getContext().RGBA,renderer.getContext().UNSIGNED_BYTE,p);return p};
  function sample(point,p){const v=new THREE.Vector3(...point).project(camera),x=Math.round((v.x*.5+.5)*800),y=Math.round((v.y*.5+.5)*600),values=[];for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){const i=((y+dy)*800+x+dx)*4;values.push((p[i]+p[i+1]+p[i+2])/3)}return values.reduce((a,b)=>a+b,0)/values.length}
  window.test={renderer,scene,camera,render,pixels,sample,metal,panel,cube,THREE,contact,enableEnvironment(){environment=createReflectionEnvironment(THREE,renderer,scene,quality);environment.update(.4);return environment.active},fallback(){const p={pixels:250000,diffuseLighting:false};const e=createReflectionEnvironment(THREE,renderer,scene,p),a=createContactShading(THREE,renderer,p);const r={env:e.active,contact:a.active};e.dispose();a.dispose();return r}};render(false);</script>`;
  const browser=await chromium.launch({headless:true,args:['--use-angle=metal']});
  try{
    const page=await browser.newPage({viewport:{width:800,height:600}}),errors=[],network=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});await page.route('**/*',r=>{network.push(r.request().url());r.abort()});
    await page.setContent(html);await page.waitForFunction(()=>window.test);
    const baseline=await page.evaluate(()=>{test.render(false);const p=test.pixels();return {metal:test.sample([-1.1,.45,.44],p),panel:test.sample([1,.25,.46],p)}});writeOutput('baseline.png',await page.screenshot());
    const reflected=await page.evaluate(()=>{test.enableEnvironment();test.render(false);const p=test.pixels();window.beforeAO=p;return {metal:test.sample([-1.1,.45,.44],p),panel:test.sample([1,.25,.46],p)}});writeOutput('reflection.png',await page.screenshot());
    const ao=await page.evaluate(()=>{test.render(true);const p=test.pixels();let darker=0,delta=0;for(let i=0;i<p.length;i+=4){const d=beforeAO[i]-p[i];if(d>1){darker++;delta+=d}}return {darker,delta,panel:test.sample([1,.25,.46],p),contactPixels:test.contact.pixels,glError:test.renderer.getContext().getError(),fallback:test.fallback()}});writeOutput('reflection-contact.png',await page.screenshot());
    assert(reflected.metal>baseline.metal+3,'metal needs reflected environment light');assert(ao.darker>100,'contact shading must affect real contact pixels');assert.equal(ao.panel,reflected.panel,'emissive display must not be darkened');assert.equal(ao.glError,0);assert.deepEqual(ao.fallback,{env:false,contact:false});assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
    const clipping=await page.evaluate(()=>{test.cube.material.clippingPlanes=[new test.THREE.Plane(new test.THREE.Vector3(1,0,0),-5)];test.render(false);const before=test.sample([.45,0,0],test.pixels());test.render(true);const after=test.sample([.45,0,0],test.pixels());return {before,after}});assert(Math.abs(clipping.before-clipping.after)<1,'replaced clipping arrays cannot leave stale contact occluders');
    const report={status:'PASS',node:process.version,playwright:require('playwright/package.json').version,chromium:browser.version(),baseline,reflected,ao,clipping,errors,network};writeOutput('report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
