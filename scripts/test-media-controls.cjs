'use strict';
// Exercise the real remote with fictional states and a recording command callback.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium,firefox,webkit}=require('playwright');
const root=path.resolve(__dirname,'..');
const engine=process.env.MEDIA_CONTROLS_ENGINE||'chromium';
assert.ok(['chromium','firefox','webkit'].includes(engine));

(async()=>{
  const browser=await ({chromium,firefox,webkit}[engine]).launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:900,height:700},hasTouch:true});
    const page=await context.newPage(),errors=[],requests=[];
    page.on('pageerror',error=>errors.push(String(error)));page.on('request',request=>requests.push(request.url()));
    await page.setContent('<style>body{background:#10212a;color:white;font:14px system-ui}#homeView{padding:24px}#trigger{position:absolute;left:350px;top:250px}#outside{position:absolute;left:20px;top:630px}.tv-preview{left:30px;top:40px}button{cursor:pointer}</style><main id="homeView"><button id="trigger">Studio speaker marker</button><div id="homeTVs"></div><button id="outside">Outside remote</button></main>');
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'home-view.css'),'utf8')});
    await page.addScriptTag({content:`
      var $=id=>document.getElementById(id),items=[{id:'speaker',name:'Studio speaker',entity_id:'media_player.studio',room:'studio'}];
      var haConnected=true,haStates={'media_player.studio':{state:'playing'}},model={tv_entities:{}},tvFrames=new Map(),homeView={};
      window.commands=[];window.details=0;window.renders=0;window.requestModelRender=()=>renders++;
      window.entry={item:items[0],state:'on',enabled:true,busy:false,media:{state:'playing',supported_features:1|4|16|32|4096|16384,volume_level:.37,title:'A <fictional> song',artist:'Example ensemble',album:'Demonstration'},details:()=>details++,power:()=>commands.push({action:'power'}),command:(action,value,request_id)=>commands.push({action,value,request_id})};
    `});
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'media-preview.js'),'utf8')});
    await page.evaluate(()=>{window.refresh=()=>updateTVPreviews([entry]);refresh();window.unbind=bindMediaControlTrigger('speaker',$('trigger'));});
    const popup=page.getByRole('dialog',{name:'Studio speaker · Media controls'}),marker=page.getByRole('button',{name:'Studio speaker marker'});
    const action=name=>popup.getByRole('button',{name,exact:true});
    const count=()=>page.evaluate(()=>commands.length);
    const acknowledge=async(ok=true)=>page.evaluate(ok=>{const request=commands.at(-1);window.handleMediaCommandResult({entity_id:'media_player.studio',request_id:request.request_id,ok,error:ok?undefined:'A fictional command failure'});},ok);

    // Pointer intent only reveals controls; metadata remains literal text.
    await marker.hover();await popup.waitFor({state:'visible'});assert.equal(await count(),0);
    assert.equal(await popup.locator('.media-controls-track').textContent(),'A <fictional> song · Example ensemble · Demonstration');
    assert.equal(await popup.locator('fictional').count(),0);
    assert.equal(await popup.locator('output').textContent(),'37%');
    assert.equal(await page.locator('button button').count(),0);
    await page.mouse.move(5,5);await popup.waitFor({state:'hidden'});

    // Focus opens, Escape dismisses and restores the trigger without reopening.
    await marker.focus();await popup.waitFor({state:'visible'});assert.equal(await count(),0);
    await page.keyboard.press('Escape');await popup.waitFor({state:'hidden'});assert.equal(await marker.evaluate(el=>document.activeElement===el),true);
    assert.equal(await marker.getAttribute('aria-expanded'),'false');

    // Touch has an explicit button and does not depend on hover.
    await page.getByRole('button',{name:'Studio speaker · Media controls',exact:true}).tap();await popup.waitFor({state:'visible'});assert.equal(await count(),0);
    for(const [name,command] of [['Previous track','media_previous_track'],['Play','media_play'],['Pause','media_pause'],['Stop','media_stop'],['Next track','media_next_track']]){
      await action(name).click();assert.equal(await page.evaluate(()=>commands.at(-1).action),command);
      assert.equal(await action(name).isDisabled(),true);assert.equal(await popup.locator('input').isDisabled(),true);
      const before=await count();await page.evaluate(()=>sendMediaControl('media_play'));assert.equal(await count(),before,'a second command cannot bypass the pending guard');
      await page.evaluate(()=>window.handleMediaCommandResult({entity_id:'media_player.studio',request_id:'stale',ok:true}));assert.equal(await action(name).isDisabled(),true);
      await acknowledge();assert.equal(await action(name).isEnabled(),true);
    }
    // Range input is a local preview until the user commits change, including endpoints.
    const beforeVolume=await count();
    await popup.locator('input').evaluate(el=>{el.value='62';el.dispatchEvent(new Event('input',{bubbles:true}));});
    assert.equal(await count(),beforeVolume);assert.equal(await popup.locator('output').textContent(),'62%');
    await popup.locator('input').evaluate(el=>el.dispatchEvent(new Event('change',{bubbles:true})));
    assert.deepEqual(await page.evaluate(()=>({action:commands.at(-1).action,value:commands.at(-1).value})),{action:'volume_set',value:62});await acknowledge();
    for(const value of [0,100]){await popup.locator('input').fill(String(value));await popup.locator('input').dispatchEvent('change');assert.equal(await page.evaluate(()=>commands.at(-1).value),value);await acknowledge();}
    const afterVolume=await count();for(const value of [-1,101,1.5,NaN])await page.evaluate(value=>sendMediaControl('volume_set',value),value);assert.equal(await count(),afterVolume);

    // Unsupported controls disappear; unavailable/restored/disconnected/busy cannot send.
    await page.evaluate(()=>{entry.media.supported_features=4|16384;refresh();});
    for(const name of ['Previous track','Pause','Stop','Next track'])assert.equal(await action(name).isVisible(),false);
    assert.equal(await action('Play').isVisible(),true);
    for(const scenario of ['unavailable','restored','disconnected','busy']){
      await page.evaluate(scenario=>{entry.media.state=scenario==='unavailable'?'unavailable':'playing';entry.media.restored=scenario==='restored';haConnected=scenario!=='disconnected';entry.busy=scenario==='busy';refresh();},scenario);
      assert.equal(await action('Play').isDisabled(),true,scenario);assert.equal(await popup.locator('input').isDisabled(),true,scenario);
      const before=await count();await page.evaluate(()=>sendMediaControl('media_play'));assert.equal(await count(),before,scenario);
    }
    await page.evaluate(()=>{entry.media.state='playing';entry.media.restored=false;haConnected=true;entry.busy=false;refresh();});
    await action('Play').click();await acknowledge(false);assert.match(await popup.locator('[role="status"]').textContent(),/fictional command failure/);
    await action('Play').click();assert.doesNotMatch(await popup.locator('[role="status"]').textContent(),/failure/);await acknowledge();
    await action('Open Home Assistant controls').click();await popup.waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>details),1);

    // Existing callout hover opens the same remote; outside press closes it.
    await page.locator('[data-tv-preview="speaker"] .tv-preview-status').hover();await popup.waitFor({state:'visible'});
    await page.getByRole('button',{name:'Outside remote'}).click();await popup.waitFor({state:'hidden'});
    await marker.click();await popup.waitFor({state:'visible'});
    await page.setViewportSize({width:380,height:660});await popup.waitFor({state:'hidden'});
    await page.evaluate(()=>{$('trigger').style.left='320px';$('trigger').style.top='570px';showMediaControls('speaker',$('trigger'),{focus:true});});
    const bounds=await popup.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=380&&bounds.y>=0&&bounds.y+bounds.height<=660,'remote stays within a narrow viewport');

    // A configured television keeps its current snapshot/native controls behavior.
    await page.evaluate(()=>{model.tv_entities.speaker='media_player.studio';refresh();});await popup.waitFor({state:'hidden'});
    assert.equal(await page.locator('.tv-preview-controls').count(),0);assert.equal(await page.evaluate(()=>showMediaControls('speaker',$('trigger'))),false);
    await page.evaluate(()=>{delete model.tv_entities.speaker;entry.item.type='tv';refresh();});
    assert.equal(await page.locator('.tv-preview-controls').count(),0);assert.equal(await page.evaluate(()=>showMediaControls('speaker',$('trigger'))),false);
    await page.evaluate(()=>{entry.item.type='appliance';entry.media.supported_features=1|4|16|32|4096|16384;refresh();showMediaControls('speaker',$('trigger'),{focus:true});});
    const artifacts=process.env.MEDIA_CONTROLS_ARTIFACTS;if(artifacts){fs.mkdirSync(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,engine+'-media-controls.png')});}

    // Entity removal clears its pending timeout and late results cannot revive UI.
    await action('Play').click();const request=await page.evaluate(()=>commands.at(-1));
    await page.evaluate(()=>{updateTVPreviews([]);unbind();discardMediaControls();});assert.equal(await page.locator('.media-controls').count(),0);
    assert.equal(await page.evaluate(()=>mediaControlPending.size),0);
    assert.equal(await page.evaluate(request=>window.handleMediaCommandResult({entity_id:'media_player.studio',request_id:request.request_id,ok:false}),request),false);
    const finalCount=await count();await page.waitForTimeout(250);assert.equal(await count(),finalCount);assert.equal(await page.evaluate(()=>renders),0,'remote updates never request a model render');
    assert.deepEqual(requests,[],'remote performs no network requests or polling');assert.deepEqual(errors,[]);
    console.log(`PASS (${engine}): media hover/focus/touch, capability gating, explicit bounded commands, pending/error handling, narrow viewport, native details, TV preservation and removal cleanup.`);
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
