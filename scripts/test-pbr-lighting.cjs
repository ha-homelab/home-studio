const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),output=process.env.PBR_TEST_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'pbr-lighting-'));fs.mkdirSync(output,{recursive:true,mode:0o700});
if(!fs.lstatSync(output).isDirectory()||fs.lstatSync(output).isSymbolicLink())throw Error('PBR output must be a real directory');
const writeOutput=(name,data)=>fs.writeFileSync(path.join(output,name),data,{flag:'wx',mode:0o600});

// Fixed byte expectations from the piecewise sRGB transfer function: decode the
// already tone-mapped source, multiply by ao/255, encode, then round to UNORM8.
// These are display-linear AO expectations, not pre-tone-map irradiance tests.
const compositeCases=[
  {name:'dark-mid-high',source:[5,128,240,77],ao:209,mask:255,depth:128,expected:[4,117,220,77]},
  {name:'srgb-knee',source:[0,10,11,255],ao:230,mask:255,depth:128,expected:[0,9,10,255]},
  {name:'high-and-zero-alpha',source:[255,180,40,0],ao:230,mask:255,depth:128,expected:[244,172,38,0]},
  {name:'unoccluded',source:[8,96,224,128],ao:255,mask:255,depth:128,expected:[8,96,224,128],exact:true},
  {name:'nonreceiver',source:[5,128,240,77],ao:209,mask:0,depth:128,expected:[5,128,240,77],exact:true},
  {name:'background-depth',source:[5,128,240,77],ao:209,mask:255,depth:255,expected:[5,128,240,77],exact:true}
];

// Serialized into the existing browser fixture. Capture the material constructed
// by production code; do not copy its GLSL or add an inspection API to the app.
function probeContactComposite(THREE,renderer,createContactShading,cases) {
  let composite;
  class CaptureMaterial extends THREE.RawShaderMaterial {
    constructor(parameters){super(parameters);if(parameters?.uniforms?.aoMap){if(composite)throw Error('Multiple contact composites');composite=this}}
  }
  const owner=createContactShading({...THREE,RawShaderMaterial:CaptureMaterial},renderer,{pixels:2000000,diffuseLighting:false});
  if(!composite)throw Error('Contact composite was not constructed');
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
  const scene=new THREE.Scene(),camera=new THREE.Camera(),quad=new THREE.Mesh(geometry,composite);quad.frustumCulled=false;scene.add(quad);
  const target=new THREE.WebGLRenderTarget(2,2,{format:THREE.RGBAFormat,type:THREE.UnsignedByteType,depthBuffer:false,stencilBuffer:false,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter});
  target.texture.colorSpace=THREE.NoColorSpace;
  const textures=Array.from({length:4},()=>{
    const texture=new THREE.DataTexture(new Uint8Array(4),1,1,THREE.RGBAFormat,THREE.UnsignedByteType);
    texture.colorSpace=THREE.NoColorSpace;texture.minFilter=texture.magFilter=THREE.NearestFilter;
    texture.wrapS=texture.wrapT=THREE.ClampToEdgeWrapping;texture.generateMipmaps=false;texture.premultiplyAlpha=false;return texture;
  });
  const saved={target:renderer.getRenderTarget(),viewport:renderer.getViewport(new THREE.Vector4()),scissor:renderer.getScissor(new THREE.Vector4()),scissorTest:renderer.getScissorTest(),autoClear:renderer.autoClear};
  const variants=[['production',composite]],observations={};
  try {
    // Mutation sites only construct negative controls. Correctness below comes
    // from actual GPU pixels, never from finding these strings in the source.
    const site='linear*=ao;';
    if(composite.fragmentShader.split(site).length!==2)throw Error('Update the doubled-AO mutation site after shader refactoring');
    const doubled=composite.clone();doubled.fragmentShader=doubled.fragmentShader.replace(site,site+site);variants.push(['doubledAO',doubled]);
    const inverted=composite.clone(),end=inverted.fragmentShader.lastIndexOf('}');
    if(end<0)throw Error('Missing composite main body');
    inverted.fragmentShader=inverted.fragmentShader.slice(0,end)+'gl_FragColor.rgb=1.-gl_FragColor.rgb;'+inverted.fragmentShader.slice(end);variants.push(['invertedRGB',inverted]);
    renderer.setRenderTarget(target);renderer.setViewport(0,0,2,2);renderer.setScissorTest(false);renderer.autoClear=true;
    for(const [name,material] of variants) {
      quad.material=material;
      for(const [index,uniform] of ['source','aoMap','depthMap','maskMap'].entries())material.uniforms[uniform].value=textures[index];
      material.uniforms.outputSize.value.set(2,2);material.uniforms.depthSize.value.set(1,1);
      observations[name]=cases.map(test=>{
        const rgba=[test.source,[test.ao,test.ao,test.ao,255],[test.depth,test.depth,test.depth,255],[test.mask,test.mask,test.mask,255]];
        textures.forEach((texture,index)=>{texture.image.data.set(rgba[index]);texture.needsUpdate=true});
        renderer.render(scene,camera);
        const pixels=new Uint8Array(16);renderer.readRenderTargetPixels(target,0,0,2,2,pixels);
        return {name:test.name,pixels:Array.from(pixels),glError:renderer.getContext().getError()};
      });
    }
    return observations;
  }finally{
    renderer.setRenderTarget(saved.target);renderer.setViewport(saved.viewport);renderer.setScissor(saved.scissor);renderer.setScissorTest(saved.scissorTest);renderer.autoClear=saved.autoClear;
    for(const [,material] of variants.slice(1))material.dispose();
    textures.forEach(texture=>texture.dispose());target.dispose();geometry.dispose();owner.dispose();
  }
}

function compositeMismatches(observations) {
  assert.equal(observations.length,compositeCases.length);
  const mismatches=[];
  for(const [index,result] of observations.entries()) {
    const test=compositeCases[index];assert.equal(result.name,test.name);assert.equal(result.glError,0,test.name);assert.equal(result.pixels.length,16);
    for(const [offset,actual] of result.pixels.entries()) {
      const channel=offset%4,expected=test.expected[channel],tolerance=channel===3||test.exact?0:1;
      assert(Number.isInteger(actual)&&actual>=0&&actual<=255,'Readback must contain UNORM8 bytes');
      if(Math.abs(actual-expected)>tolerance)mismatches.push({name:test.name,pixel:Math.floor(offset/4),channel,actual,expected,tolerance});
    }
  }
  return mismatches;
}
(async()=>{
  const THREE='data:text/javascript;base64,'+fs.readFileSync(path.join(root,'vendor/three.module.min.js')).toString('base64');
  const src=['pbr-color-data.js','pbr-materials.js','environment-lighting.js'].map(p=>fs.readFileSync(path.join(root,p),'utf8')).join('\n');
  // Three attaches geometry-dispose listeners to each renderer context epoch.
  // Exercise actual BufferGeometry events: no old epoch may survive GPU release.
  const api=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
  const three=await import(THREE),tracked=new Set();let epoch=1,uploads=0;
  const probe={info:{autoReset:true},shadowMap:{enabled:true},autoClear:true,
    getRenderTarget:()=>null,getScissorTest:()=>false,getDrawingBufferSize:v=>v.set(800,600),
    getViewport:v=>v.set(0,0,800,600),setViewport(){},setRenderTarget(){},initTexture(){},copyFramebufferToTexture(){},
    render(scene){scene.traverse(object=>{const geometry=object.geometry;if(!geometry||tracked.has(geometry))return;
      tracked.add(geometry);uploads++;const created=epoch;
      const dispose=()=>{assert.equal(created,epoch,'No stale context may delete a new-epoch buffer');tracked.delete(geometry);geometry.removeEventListener('dispose',dispose)};
      geometry.addEventListener('dispose',dispose);
    })}};
  const lifecycle=api.createContactShading(three,probe,{pixels:2000000,diffuseLighting:false});
  const empty=new three.Scene(),probeCamera=new three.PerspectiveCamera();
  lifecycle.apply(empty,probeCamera);assert.equal(tracked.size,1);
  const quad=[...tracked][0],positions=Array.from(quad.attributes.position.array);
  lifecycle.releaseGPU();assert.equal(tracked.size,0,'Contact quad must release its old context buffers');
  epoch++;lifecycle.apply(empty,probeCamera);assert.equal(tracked.size,1);assert.equal([...tracked][0],quad);
  assert.deepEqual(Array.from(quad.attributes.position.array),positions,'Restoration retains authored fullscreen geometry');
  lifecycle.dispose();lifecycle.dispose();assert.equal(tracked.size,0);assert.equal(uploads,2);
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
  window.test={renderer,scene,camera,render,pixels,sample,metal,panel,cube,THREE,contact,probeComposite:cases=>(${probeContactComposite.toString()})(THREE,renderer,createContactShading,cases),enableEnvironment(){environment=createReflectionEnvironment(THREE,renderer,scene,quality);environment.update(.4);return environment.active},fallback(){const p={pixels:250000,diffuseLighting:false};const e=createReflectionEnvironment(THREE,renderer,scene,p),a=createContactShading(THREE,renderer,p);const r={env:e.active,contact:a.active};e.dispose();a.dispose();return r}};render(false);</script>`;
  const browser=await chromium.launch({headless:true,args:['--use-angle=metal']});
  try{
    const page=await browser.newPage({viewport:{width:800,height:600}}),errors=[],network=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});await page.route('**/*',r=>{network.push(r.request().url());r.abort()});
    await page.setContent(html);await page.waitForFunction(()=>window.test);
    const composite=await page.evaluate(cases=>test.probeComposite(cases),compositeCases);
    const mismatches=Object.fromEntries(Object.entries(composite).map(([name,results])=>[name,compositeMismatches(results)]));
    writeOutput('composite.json',JSON.stringify({cases:compositeCases,observations:composite,mismatches},null,2));
    assert.deepEqual(mismatches.production,[],'Actual contact composite must match display-linear sRGB byte expectations');
    assert(mismatches.doubledAO?.length>0,'Readback oracle must reject doubled AO');
    assert(mismatches.invertedRGB?.length>0,'Readback oracle must reject inverted RGB');
    assert.deepEqual(errors,[],'All three composite shader variants must compile and render');
    const baseline=await page.evaluate(()=>{test.render(false);const p=test.pixels();return {metal:test.sample([-1.1,.45,.44],p),panel:test.sample([1,.25,.46],p)}});writeOutput('baseline.png',await page.screenshot());
    const reflected=await page.evaluate(()=>{test.enableEnvironment();test.render(false);const p=test.pixels();window.beforeAO=p;return {metal:test.sample([-1.1,.45,.44],p),panel:test.sample([1,.25,.46],p)}});writeOutput('reflection.png',await page.screenshot());
    const ao=await page.evaluate(()=>{test.render(true);const p=test.pixels();let darker=0,delta=0;for(let i=0;i<p.length;i+=4){const d=beforeAO[i]-p[i];if(d>1){darker++;delta+=d}}return {darker,delta,panel:test.sample([1,.25,.46],p),contactPixels:test.contact.pixels,glError:test.renderer.getContext().getError(),fallback:test.fallback()}});writeOutput('reflection-contact.png',await page.screenshot());
    assert(reflected.metal>baseline.metal+3,'metal needs reflected environment light');assert(ao.darker>100,'contact shading must affect real contact pixels');assert.equal(ao.panel,reflected.panel,'emissive display must not be darkened');assert.equal(ao.glError,0);assert.deepEqual(ao.fallback,{env:false,contact:false});assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
    const clipping=await page.evaluate(()=>{test.cube.material.clippingPlanes=[new test.THREE.Plane(new test.THREE.Vector3(1,0,0),-5)];test.render(false);const before=test.sample([.45,0,0],test.pixels());test.render(true);const after=test.sample([.45,0,0],test.pixels());return {before,after}});assert(Math.abs(clipping.before-clipping.after)<1,'replaced clipping arrays cannot leave stale contact occluders');
    const report={status:'PASS',node:process.version,playwright:require('playwright/package.json').version,chromium:browser.version(),composite:{cases:compositeCases.length,productionMismatches:mismatches.production.length,negativeControlMismatches:{doubledAO:mismatches.doubledAO.length,invertedRGB:mismatches.invertedRGB.length}},baseline,reflected,ao,clipping,errors,network};writeOutput('report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
