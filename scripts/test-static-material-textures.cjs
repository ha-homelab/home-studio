// Native compiled-viewer check for static floors and rounded/cutaway walls.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
(async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'home-studio-static-materials-'));
  try {
    const output=path.join(temp,'viewer.html');
    const command=spawnSync(process.env.PYTHON||'python3',[path.join(__dirname,'test-material-textures.py'),'--fixture-static',output],{encoding:'utf8'});
    assert.equal(command.status,0,command.stderr);
    const hook=`window.__staticTest={renderer,root,roundedWalls,clipping,updateRoundedWallGeometry,homeView,
      inspect(){return root.children.filter(o=>o.isMesh&&o.material.map).map(o=>({name:o.name,type:o.material.type,
        count:o.geometry.attributes.position.count,uvCount:o.geometry.attributes.uv?.count,
        finite:[...o.geometry.attributes.uv.array].every(Number.isFinite),cast:o.castShadow,receive:o.receiveShadow,
        map:o.material.map.uuid,roughness:o.material.roughness,range:{...o.geometry.drawRange}}))}};`;
    const original=fs.readFileSync(output,'utf8').replace('</script></body>',hook+'</script></body>');
    const {chromium}=require('playwright');
    const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    try {
      for(const diffuse of [false,true]) {
        const page=await browser.newPage({viewport:{width:1100,height:800}}),errors=[];
        page.on('pageerror',error=>errors.push(String(error)));
        page.on('console',message=>{if(message.type()==='error')errors.push(message.text())});
        const html=original.replace('renderProfile=selectRenderProfile(renderer.getContext());','renderProfile=selectRenderProfile(renderer.getContext());renderProfile.diffuseLighting='+diffuse+';');
        await page.setContent(html);await page.waitForFunction(()=>window.__staticTest?.inspect().length>1);
        const baseline=await page.evaluate(()=>__staticTest.inspect());
        assert(baseline.some(o=>o.type===(diffuse?'MeshBasicMaterial':'MeshStandardMaterial')));
        assert(baseline.every(o=>o.count===o.uvCount&&o.finite&&o.cast&&o.receive));
        if(!diffuse)assert(baseline.every(o=>o.roughness===.24),'explicit static ceramic overrides wood/wall palette names');
        for(const height of [1.1,2.1,20,1.1]) {
          const rows=await page.evaluate(height=>{const t=__staticTest;t.clipping.constant=height;t.updateRoundedWallGeometry(height);window.renderModel();return t.inspect()},height);
          assert.deepEqual(rows.map(o=>o.map),baseline.map(o=>o.map),'cutaway keeps the same decoded maps');
          assert(rows.every(o=>o.count===o.uvCount&&o.finite));
        }
        for(const active of [true,false,true])await page.evaluate(active=>{__staticTest.homeView.setActive(active);window.renderModel()},active);
        const state=await page.evaluate(()=>({rows:__staticTest.inspect(),error:__staticTest.renderer.getContext().getError()}));
        assert.equal(state.error,0);assert.equal(state.rows.length,baseline.length);assert.deepEqual(errors,[]);
        const difference=await page.evaluate(()=>{const t=__staticTest;window.renderModel();const before=t.renderer.domElement.toDataURL();t.root.traverse(o=>{if(o.isMesh&&o.material.map){o.material.map=null;o.material.needsUpdate=true}});window.renderModel();return before!==t.renderer.domElement.toDataURL()});
        assert(difference,'static maps must affect actual pixels');assert.deepEqual(errors,[]);
        await page.close();console.log((diffuse?'Lambert/Basic':'Standard')+': static maps, rounded cutaway UVs, shadows and Home/Editor passed.');
      }
    } finally {await browser.close()}
  } finally {fs.rmSync(temp,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
