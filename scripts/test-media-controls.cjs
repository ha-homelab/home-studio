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
      window.entry={item:items[0],state:'on',enabled:true,busy:false,media:{state:'playing',supported_features:1|4|16|32|128|256|4096|16384,volume_level:.37,title:'A <fictional> song',artist:'Example ensemble',album:'Demonstration'},details:()=>details++,power:()=>commands.push({action:entry.state==='off'?'turn_on':'turn_off'}),command:(action,value,request_id)=>commands.push({action,value,request_id})};
    `});
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'media-preview.js'),'utf8')});
    await page.evaluate(()=>{window.refresh=()=>updateTVPreviews([entry]);refresh();window.unbind=bindMediaControlTrigger('speaker',$('trigger'));});
    const popup=page.getByRole('dialog',{name:'Studio speaker · Media controls'}),marker=page.getByRole('button',{name:'Studio speaker marker'});
    const card=page.locator('[data-tv-preview="speaker"]'),launcher=card.locator('.tv-preview-launcher');
    const action=name=>popup.getByRole('button',{name,exact:true});
    const count=()=>page.evaluate(()=>commands.length);
    const acknowledge=async(ok=true)=>page.evaluate(ok=>{const request=commands.at(-1);window.handleMediaCommandResult({entity_id:'media_player.studio',request_id:request.request_id,ok,error:ok?undefined:'A fictional command failure'});},ok);
    const assertCompact=async()=>{
      assert.equal(await card.getAttribute('data-compact'),'true');
      const bounds=await card.boundingBox(),limit=await page.evaluate(()=>matchMedia('(pointer:coarse)').matches?44:36);
      assert.ok(bounds&&bounds.width<=limit&&bounds.height<=limit,'pictureless media occupies only a compact button');
      assert.equal(await launcher.isVisible(),true);assert.equal(await launcher.getAttribute('aria-label'),'Studio speaker · Media controls');
      for(const selector of ['img','.tv-preview-status','figcaption'])assert.equal(await card.locator(selector).isVisible(),false,selector+' reserves no visible preview space');
    };

    await assertCompact();
    // A pictureless player uses the same accessible launcher for mouse, keys and touch.
    await launcher.hover();await popup.waitFor({state:'visible'});assert.equal(await count(),0);
    await page.mouse.move(5,5);await popup.waitFor({state:'hidden'});
    await launcher.focus();await popup.waitFor({state:'visible'});assert.equal(await count(),0);
    await page.keyboard.press('Escape');await popup.waitFor({state:'hidden'});
    assert.equal(await launcher.evaluate(el=>document.activeElement===el),true);assert.equal(await launcher.getAttribute('aria-expanded'),'false');
    await launcher.tap();await popup.waitFor({state:'visible'});assert.equal(await count(),0);
    await page.getByRole('button',{name:'Outside remote'}).click();await popup.waitFor({state:'hidden'});

    // Off players have no blank artwork region; only explicit supported power clicks send.
    await page.evaluate(()=>{entry.state='off';entry.media.state='off';haStates['media_player.studio'].state='off';refresh();});
    await assertCompact();await launcher.hover();await popup.waitFor({state:'visible'});assert.equal(await count(),0);
    assert.equal(await popup.locator('.media-controls-track').isVisible(),false,'stale media metadata is hidden while off');
    assert.equal(await action('Play').isDisabled(),true);assert.equal(await action('Turn on Studio speaker').isEnabled(),true);
    await action('Turn on Studio speaker').click();assert.equal(await count(),1);assert.equal(await page.evaluate(()=>commands.at(-1).action),'turn_on');
    await page.evaluate(()=>{entry.busy=true;refresh();});assert.equal(await action('Turn on Studio speaker').isDisabled(),true);
    await popup.locator('.media-controls-power').evaluate(el=>el.onclick());assert.equal(await count(),1,'pending power cannot be resent');
    await page.evaluate(()=>{entry.busy=false;entry.media.supported_features=4|16384;refresh();});
    assert.equal(await popup.locator('.media-controls-power').isVisible(),false,'unsupported audio power is not offered');
    await popup.locator('.media-controls-power').evaluate(el=>el.onclick());assert.equal(await count(),1,'hidden unsupported power remains guarded');
    await page.evaluate(()=>{entry.state='on';entry.media.state='playing';haStates['media_player.studio'].state='playing';entry.media.supported_features=1|4|16|32|128|256|4096|16384;refresh();commands.length=0;});
    await page.keyboard.press('Escape');await popup.waitFor({state:'hidden'});

    // A received picture restores the normal card and dismisses its now-hidden launcher.
    await launcher.tap();await popup.waitFor({state:'visible'});
    await page.evaluate(()=>{tvFrames.set('speaker',{image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII='});refresh();});
    await popup.waitFor({state:'hidden'});assert.equal(await card.getAttribute('data-compact'),'false');
    assert.equal(await launcher.isVisible(),false);assert.equal(await card.locator('img').isVisible(),true);assert.equal(await card.locator('figcaption').isVisible(),true);
    assert.ok((await card.boundingBox()).width>100,'a real image retains the full preview card');
    await page.mouse.move(5,5);await card.locator('img').hover();await popup.waitFor({state:'visible'});assert.equal(await count(),0,'a real image keeps its existing hover controls');
    await page.evaluate(()=>{tvFrames.clear();refresh();});await popup.waitFor({state:'hidden'});await assertCompact();assert.equal(await card.locator('img').getAttribute('src'),null);
    await page.getByRole('button',{name:'Outside remote'}).click();

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
    await launcher.tap();await popup.waitFor({state:'visible'});assert.equal(await count(),0);
    for(const [name,command] of [['Previous track','media_previous_track'],['Play','media_play'],['Pause','media_pause'],['Stop','media_stop'],['Next track','media_next_track']]){
      await action(name).click();assert.equal(await page.evaluate(()=>commands.at(-1).action),command);
      assert.equal(await action(name).isDisabled(),true);assert.equal(await popup.locator('input').isDisabled(),true);
      assert.equal(await popup.locator('.media-controls-power').isDisabled(),true,'pending playback also blocks power');
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

    // The compact callout opens the same remote; outside press closes it.
    await launcher.hover();await popup.waitFor({state:'visible'});
    await page.getByRole('button',{name:'Outside remote'}).click();await popup.waitFor({state:'hidden'});
    await marker.click();await popup.waitFor({state:'visible'});
    await page.setViewportSize({width:380,height:660});await popup.waitFor({state:'hidden'});
    await page.evaluate(()=>{$('trigger').style.left='320px';$('trigger').style.top='570px';showMediaControls('speaker',$('trigger'),{focus:true});});
    const bounds=await popup.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=380&&bounds.y>=0&&bounds.y+bounds.height<=660,'remote stays within a narrow viewport');

    // Both configured televisions and typed TVs expose a compact power/native-controls panel.
    for(const tvKind of ['configured','typed']){
      await page.evaluate(tvKind=>{hideMediaControls();delete model.tv_entities.speaker;entry.item.type=tvKind==='typed'?'tv':'appliance';if(tvKind==='configured')model.tv_entities.speaker='media_player.studio';entry.state='off';entry.media.state='off';haStates['media_player.studio'].state='off';entry.media.supported_features=0;refresh();},tvKind);
      await assertCompact();const before=await count();await launcher.tap();await popup.waitFor({state:'visible'});assert.equal(await count(),before,tvKind+' opening does not turn on the TV');
      for(const name of ['Previous track','Play','Pause','Stop','Next track'])assert.equal(await action(name).isVisible(),false);
      assert.equal(await popup.locator('input').isVisible(),false);assert.equal(await action('Turn on Studio speaker').isEnabled(),true);
      await action('Turn on Studio speaker').click();assert.equal(await count(),before+1);assert.equal(await page.evaluate(()=>commands.at(-1).action),'turn_on');
      for(const scenario of ['unavailable','restored','disconnected','disabled','busy']){
        await page.evaluate(scenario=>{entry.state=scenario==='unavailable'?'unavailable':'off';entry.media.state=entry.state;entry.media.restored=scenario==='restored';haConnected=scenario!=='disconnected';entry.enabled=scenario!=='disabled';entry.busy=scenario==='busy';refresh();},scenario);
        assert.equal(await popup.locator('.media-controls-power').isDisabled(),true,tvKind+' '+scenario);
        if(scenario==='disconnected'||scenario==='disabled')assert.equal(await action('Open Home Assistant controls').isDisabled(),true);
        const previous=await count();await popup.locator('.media-controls-power').evaluate(el=>el.onclick());assert.equal(await count(),previous,tvKind+' '+scenario+' cannot send');
      }
      await page.evaluate(()=>{entry.state='off';entry.media.state='off';entry.media.restored=false;haConnected=true;entry.enabled=true;entry.busy=false;refresh();});
      const previousDetails=await page.evaluate(()=>details);await action('Open Home Assistant controls').click();await popup.waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>details),previousDetails+1);
    }
    await page.evaluate(()=>{delete model.tv_entities.speaker;entry.item.type='appliance';entry.state='on';entry.media.state='playing';haStates['media_player.studio'].state='playing';entry.media.supported_features=1|4|16|32|128|256|4096|16384;refresh();showMediaControls('speaker',$('trigger'),{focus:true});});
    const stableNodes=await page.locator('#homeTVs *').count(),stableCommands=await count();
    for(let cycle=0;cycle<20;cycle++)await page.evaluate(()=>{refresh();hideMediaControls();showMediaControls('speaker',$('trigger'));});
    assert.equal(await page.locator('#homeTVs *').count(),stableNodes);assert.equal(await page.locator('.media-controls').count(),1);assert.equal(await count(),stableCommands);
    const artifacts=process.env.MEDIA_CONTROLS_ARTIFACTS;if(artifacts){fs.mkdirSync(artifacts,{recursive:true});await page.screenshot({path:path.join(artifacts,engine+'-media-controls.png')});}

    // Entity removal clears its pending timeout and late results cannot revive UI.
    await action('Play').click();const request=await page.evaluate(()=>commands.at(-1));
    await page.evaluate(()=>{updateTVPreviews([]);unbind();discardMediaControls();});assert.equal(await page.locator('.media-controls').count(),0);
    assert.equal(await page.evaluate(()=>mediaControlPending.size),0);
    assert.equal(await page.evaluate(request=>window.handleMediaCommandResult({entity_id:'media_player.studio',request_id:request.request_id,ok:false}),request),false);
    const finalCount=await count();await page.waitForTimeout(250);assert.equal(await count(),finalCount);assert.equal(await page.evaluate(()=>renders),0,'remote updates never request a model render');
    assert.deepEqual(requests.filter(url=>!url.startsWith('data:image/')),[],'remote performs no network requests or polling');assert.deepEqual(errors,[]);
    console.log(`PASS (${engine}): compact media footprint, hover/focus/touch, explicit TV/audio power, capability gating, image preservation, bounded commands, dismissal, stable DOM and removal cleanup.`);
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
