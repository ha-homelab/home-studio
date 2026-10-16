// Exercise real storage, native custom elements and cross-tab events on a local origin.
// The fake HA object only records calls; it cannot reach any real device or service.
const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium}=require('playwright');
const panelScript=fs.readFileSync(path.join(__dirname,'../custom_components/home_floorplan/static/panel.js'));
const html=`<!doctype html><meta charset="utf-8"><script src="/panel.js"></script><home-floorplan-panel></home-floorplan-panel><script>
window.panel=document.querySelector('home-floorplan-panel');
window.calls=[];window.messages=[];panel.generation=1;
panel.port={postMessage:message=>messages.push(message)};
panel.savedItems=[{entity_id:'switch.test'}];
panel._hass={connected:true,states:{'switch.test':{state:'on'}},callService:(...args)=>calls.push(args)};
window.command=()=>panel.handleViewerMessage({type:'toggle',entity_id:'switch.test',request_id:'test'},1);
</script>`;
(async()=>{
  const server=http.createServer((request,response)=>{
    response.setHeader('Content-Type',request.url==='/panel.js'?'text/javascript':'text/html');
    response.end(request.url==='/panel.js'?panelScript:html);
  });
  let browser;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({headless:true});
    const context=await browser.newContext(),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(String(error)));
    await page.goto(origin);assert.equal(await page.evaluate(()=>panel.dryRun),false);
    const button=page.locator('#dry-run');
    await button.click();assert.equal(await page.evaluate(()=>panel.dryRun),true);
    await page.reload();assert.equal(await page.evaluate(()=>panel.dryRun),true);
    await page.evaluate(()=>command());await page.waitForFunction(()=>messages.length===1);
    assert.deepEqual(await page.evaluate(()=>calls),[]);assert.equal(await page.evaluate(()=>messages[0].dry_run),true);
    await button.click();await page.reload();assert.equal(await page.evaluate(()=>panel.dryRun),false,'explicit off persists too');
    await page.evaluate(()=>command());await page.waitForFunction(()=>messages.length===1);
    assert.equal(await page.evaluate(()=>calls.length),1,'live-mode dispatch survives real reconstruction');

    const second=await context.newPage();await second.goto(origin);
    await button.click();await second.waitForFunction(()=>panel.dryRun===true);
    await second.evaluate(()=>command());assert.deepEqual(await second.evaluate(()=>calls),[]);
    await button.click();await second.waitForFunction(()=>panel.dryRun===false);
    await page.evaluate(()=>localStorage.removeItem('home-floorplan:dry-run'));
    await second.waitForFunction(()=>panel.dryRun===true,undefined,{timeout:5000});
    await second.evaluate(()=>command());assert.deepEqual(await second.evaluate(()=>calls),[],'removed preference protects already-open sibling');

    await page.goto(origin+'/?dry_run=1&lang=ru&keep=value#view');
    assert.equal(await button.isDisabled(),true);assert.equal(await button.textContent(),'Пробный режим: вкл.');
    await second.evaluate(()=>localStorage.setItem('home-floorplan:dry-run','false'));
    await page.waitForFunction(()=>localStorage.getItem('home-floorplan:dry-run')==='false');
    assert.equal(await page.evaluate(()=>panel.dryRun),true,'URL pin wins cross-tab off');
    await page.evaluate(()=>panel.handleViewerMessage({type:'view_preferences',language:'ar'},1));
    assert.equal(new URL(page.url()).searchParams.get('lang'),'ar');
    assert.equal(new URL(page.url()).searchParams.get('dry_run'),'1');
    assert.equal(new URL(page.url()).searchParams.get('keep'),'value');
    assert.equal(new URL(page.url()).hash,'#view');
    await page.evaluate(()=>command());
    assert.match(await page.locator('#notice').textContent(),/لم يُرسل/);
    await page.setViewportSize({width:360,height:740});
    assert.equal(await page.locator('header').getAttribute('dir'),'rtl');
    for(const selector of ['#dry-run','#retry','#notice']){
      const box=await page.locator(selector).boundingBox();assert(box.x>=0&&box.x+box.width<=361,`Arabic ${selector} fits phone width`);
    }
    await page.reload();assert.equal(await page.locator('header').getAttribute('lang'),'ar');
    assert.equal(await page.evaluate(()=>panel.dryRun),true);
    await context.close();

    const denied=await browser.newContext();
    await denied.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw Error('Storage denied');}}));
    const privatePage=await denied.newPage();privatePage.on('pageerror',error=>errors.push(String(error)));
    await privatePage.goto(origin);assert.equal(await privatePage.evaluate(()=>panel.dryRun),true);
    await privatePage.locator('#dry-run').click();
    assert.equal(await privatePage.evaluate(()=>panel.dryRun),true,'failed preference save cannot disable guard');
    await privatePage.evaluate(()=>command());assert.deepEqual(await privatePage.evaluate(()=>calls),[]);
    await privatePage.reload();assert.equal(await privatePage.evaluate(()=>panel.dryRun),true);
    await denied.close();assert.deepEqual(errors,[]);
    console.log('PASS: real storage on/off persistence, cross-tab changes/removal, URL pinning, live dispatch, localized status/RTL layout and denied-storage safety.');
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
