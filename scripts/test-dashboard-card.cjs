// Exercise the real Lovelace module and host using only a local fake HA server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require('playwright');
const root = path.resolve(__dirname,'..');
const viewer = `<!doctype html><html><head><meta charset="utf-8"></head><body><button id="toggle">Toggle</button><button id="inside">Inside viewer</button><script>
  window.received = [];
  addEventListener('message',event => {
    if (event.source !== parent || event.data?.type !== 'home-floorplan:init') return;
    window.initial = event.data;
    window.port = event.ports[0];
    port.onmessage = event => received.push(event.data);
    port.postMessage({type:'model_config',model_id:'fictional_layout'});
    document.querySelector('#toggle').onclick = () => port.postMessage({type:'toggle',entity_id:'switch.lamp',request_id:'toggle'});
  });
</script></body></html>`;
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><button id="outside">Outside viewer</button><script type="module">
  import '/home-floorplan-static/card.js';
  window.calls = []; window.services = []; window.subscriptions = 0;
  window.haConnection = {subscribeMessage:async () => {subscriptions++; return () => subscriptions--;}};
  window.makeHass = (admin = true, id = 'admin') => ({user:{is_admin:admin,id},connected:true,locale:{language:'en'},
    states:{'switch.lamp':{state:'off',attributes:{friendly_name:'Lamp'}}},
    connection:haConnection,
    callWS:async message => {
      calls.push(message);
      if (message.type !== 'home_floorplan/viewer') throw Error('Unexpected request');
      if (message.floor === 'missing') throw Error('Unknown floor');
      if (message.floor === 'empty') return {html:null,items:[],can_edit:admin,mode:'native',has_editor:true,floors:[]};
      return {mode:message.floor==='legacy'?'legacy':'native',has_editor:message.floor!=='legacy',html:${JSON.stringify(viewer).replaceAll('<','\\u003c')},floor:message.floor || 'main',floors:['main','upper'],
        site_features:false,can_edit:admin,readable_entities:['switch.lamp'],controllable_entities:['switch.lamp'],revision:0,items:[{id:'lamp',entity_id:'switch.lamp'}]};
    },callService:async (...args) => services.push(args)});
  window.makeCard = config => {
    const card = document.createElement('home-floorplan-card');
    card.setConfig(config); card.hass = makeHass(); document.body.append(card); return card;
  };
  window.ready = true;
</script></body></html>`;

(async () => {
  const server = http.createServer((request,response) => {
    const filename = new URL(request.url,'http://localhost').pathname;
    if (['/home-floorplan-static/card.js','/home-floorplan-static/panel.js'].includes(filename)) {
      response.setHeader('Content-Type','text/javascript');
      response.end(fs.readFileSync(path.join(root,'custom_components/home_floorplan/static',path.basename(filename))));
    } else { response.setHeader('Content-Type','text/html'); response.end(html); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    browser = await chromium.launch({headless:true});
    const page = await browser.newPage({viewport:{width:390,height:844}});
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror',error => errors.push(String(error)));
    await page.addInitScript(() => {
      window.parentListeners=new Map(['keydown','pointerdown'].map(type=>[type,new Set()]));
      const add=document.addEventListener.bind(document),remove=document.removeEventListener.bind(document);
      document.addEventListener=(type,listener,options)=>{if(options===true)parentListeners.get(type)?.add(listener);add(type,listener,options);};
      document.removeEventListener=(type,listener,options)=>{if(options===true)parentListeners.get(type)?.delete(listener);remove(type,listener,options);};
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.ready);
    assert.deepEqual(await page.evaluate(() => {
      const card = document.createElement('home-floorplan-card');
      return [card.getCardSize(),card.getGridOptions(),customCards.filter(card => card.type === 'home-floorplan-card').length];
    }),[12,{columns:12,rows:'auto',min_columns:6},1]);
    await page.evaluate(() => {
      const invalid = [null,[],{floor:'../main'},{floor:'A'},{floor:'a'.repeat(49)},{height:'600px'},
        {height:239},{height:1601},{height:NaN},{sidebar_collapsed:'true'},{dry_run:1},{edit_locked:'yes'},{room_labels:1},{device_filter:'invalid'}];
      for (const config of invalid) {
        const card = document.createElement('home-floorplan-card');
        let rejected = false;
        try { card.setConfig(config); } catch { rejected = true; }
        if (!rejected) throw Error('Invalid configuration was accepted: '+JSON.stringify(config));
      }
      window.card = makeCard({floor:'upper',height:500,dry_run:true});
    });
    await page.waitForFunction(() => card._panel?.port);
    let frame = page.frames().find(frame => frame.parentFrame());
    await frame.waitForFunction(() => window.initial);
    assert.equal(await frame.evaluate(() => initial.preferences.sidebarCollapsed),true);
    assert.equal(await frame.evaluate(() => window.origin),'null','viewer retains its opaque sandbox');
    assert.deepEqual(await page.evaluate(() => calls),[{type:'home_floorplan/viewer',floor:'upper'}]);
    assert.equal(await page.locator('iframe').getAttribute('sandbox'),'allow-scripts allow-downloads allow-forms');
    assert.equal(await page.locator('#menu').isVisible(),false);
    assert.equal(await page.locator('#dry-run').isDisabled(),true);
    assert.equal((await page.locator('ha-card').boundingBox()).height,500);
    assert((await page.locator('iframe').boundingBox()).height > 300,'compact host leaves useful viewer space');
    // A hovered child cannot receive Escape while keyboard focus remains in HA.
    await page.locator('#outside').focus();
    await page.keyboard.press('Escape');
    await frame.waitForFunction(()=>received.filter(message=>message.type==='dismiss_overlays').length===1);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'outside','dismissal never steals parent focus');
    await page.keyboard.press('ArrowRight');
    await page.locator('#outside').click();
    await frame.waitForFunction(()=>received.filter(message=>message.type==='dismiss_overlays').length===2);
    await frame.locator('#inside').click();
    // Composed paths preserve the actual iframe target through nested card shadow roots.
    await page.locator('iframe').dispatchEvent('pointerdown',{bubbles:true,composed:true});
    await page.locator('#notice').click();
    await frame.waitForFunction(()=>received.filter(message=>message.type==='dismiss_overlays').length>=3);
    assert.equal(await frame.evaluate(()=>received.filter(message=>message.type==='dismiss_overlays').length),3,
      'outside and host-header clicks dismiss; child events and iframe targets do not');
    assert.deepEqual(await page.evaluate(()=>services),[],'dismissal cannot send device commands');
    assert.deepEqual(await page.evaluate(()=>[parentListeners.get('keydown').has(card._panel.onOverlayEscape),
      parentListeners.get('pointerdown').has(card._panel.onOverlayPointer)]),[true,true]);
    await frame.locator('#toggle').click();
    await frame.waitForFunction(() => received.some(message => message.type === 'command_result'));
    assert.equal(await frame.evaluate(() => received.find(message => message.type === 'command_result').dry_run),true);
    assert.deepEqual(await page.evaluate(() => services),[]);
    await page.evaluate(() => {
      card._panel.setDryRun(false);
      card._panel.onDryRunStorage({key:'home-floorplan:dry-run',newValue:'false'});
      window.original = card._panel;
      for (let index=0;index<5;index++) card.hass = makeHass();
      card.setConfig({floor:'upper',height:700,dry_run:true});
    });
    assert.deepEqual(await page.evaluate(() => [card._panel === original,card._panel.dryRun,calls.length,subscriptions,card.getCardSize()]),[true,true,1,1,14]);
    await frame.evaluate(() => port.postMessage({type:'view_preferences',sidebarCollapsed:false}));
    await page.waitForFunction(() => card._panel.viewPreferences.sidebarCollapsed === false);
    assert.equal(await page.evaluate(() => localStorage.getItem('home-floorplan:sidebar-collapsed')),null);

    // Signing out removes private content immediately and closes the same host resources.
    await page.evaluate(() => card.hass = {...makeHass(false),user:null});
    assert.equal(await page.locator('iframe').count(),0);
    assert.match(await page.locator('#status').textContent(),/Connecting to Home Assistant/);
    assert.deepEqual(await page.evaluate(() => [original.port,original.viewerURL,original.started,subscriptions]),[null,null,false,0]);
    assert.deepEqual(await page.evaluate(()=>[original.overlayDocument,parentListeners.get('keydown').has(original.onOverlayEscape),
      parentListeners.get('pointerdown').has(original.onOverlayPointer)]),[null,false,false],
      'account removal unregisters parent-document dismissal listeners');
    await page.evaluate(() => card.hass = makeHass());
    await page.waitForFunction(() => card._panel?.port);
    assert.equal(await page.evaluate(() => calls.length),2);
    await page.evaluate(() => { window.original = card._panel; card.remove(); });
    assert.deepEqual(await page.evaluate(() => [original.port,original.viewerURL,original.started,subscriptions]),[null,null,false,0]);
    assert.deepEqual(await page.evaluate(()=>[parentListeners.get('keydown').has(original.onOverlayEscape),
      parentListeners.get('pointerdown').has(original.onOverlayPointer)]),[false,false]);
    await page.evaluate(() => document.body.append(card));
    await page.waitForFunction(() => card._panel?.port);
    assert.deepEqual(await page.evaluate(() => [card._panel === original,calls.length,subscriptions]),[true,3,1]);
    frame = page.frames().find(frame => frame.parentFrame());
    await frame.waitForFunction(()=>window.initial);
    await page.locator('#outside').focus();await page.keyboard.press('Escape');
    await frame.waitForFunction(()=>received.some(message=>message.type==='dismiss_overlays'));
    assert.equal(await frame.evaluate(()=>received.filter(message=>message.type==='dismiss_overlays').length),1,
      'reattaching the same host restores one dismissal listener');
    await page.evaluate(() => card.hass = makeHass(true,'other-admin'));
    await page.waitForFunction(() => card._panel?.port);
    assert.deepEqual(await page.evaluate(() => [card._panel === original,original.port,original.viewerURL,calls.length,subscriptions]),[false,null,null,4,1]);

    // Ordinary users get control-only access and cannot forge editing capabilities.
    await page.evaluate(() => {
      card.remove(); calls.length = 0;
      window.denied = document.createElement('home-floorplan-card');
      denied.setConfig({}); denied.hass = makeHass(false); document.body.append(denied);
    });
    await page.waitForFunction(() => denied._panel?.port);
    frame = page.frames().find(frame => frame.parentFrame());
    await frame.waitForFunction(() => window.initial);
    assert.equal(await frame.evaluate(() => initial.can_edit),false);
    assert.equal(await page.locator('iframe').getAttribute('sandbox'),'allow-scripts');
    assert.equal(await page.locator('#studio').isVisible(),false);
    assert.deepEqual(await page.evaluate(() => [calls.length,subscriptions]),[1,1]);
    await frame.evaluate(() => {
      port.postMessage({type:'view_preferences',can_edit:true,editLocked:false});
      port.postMessage({type:'save',items:[]});port.postMessage({type:'export',format:'glb'});
    });
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve,50)));
    assert.deepEqual(await page.evaluate(() => [denied._panel.canEdit,calls.length,denied._panel.pending]),[false,1,0]);
    await frame.locator('#toggle').click();
    await page.waitForFunction(() => services.length===1);
    await page.evaluate(() => services.length=0);
    await page.evaluate(() => { denied.remove(); window.live = makeCard({floor:'main',sidebar_collapsed:false}); });
    await page.waitForFunction(() => live._panel?.port);
    frame = page.frames().find(frame => frame.parentFrame());
    await frame.waitForFunction(() => window.initial);
    assert.equal(await frame.evaluate(() => initial.preferences.sidebarCollapsed),false);
    await frame.locator('#toggle').click();
    await page.waitForFunction(() => services.length === 1);
    assert.deepEqual(await page.evaluate(() => services),[['switch','toggle',{entity_id:'switch.lamp'}]]);

    // A configured unknown floor surfaces the server error without retrying another floor.
    await page.evaluate(() => { live.remove(); window.missing = makeCard({floor:'missing'}); });
    await page.waitForFunction(() => missing._panel?.$('notice').textContent.includes('Unknown floor'));
    assert.equal(await page.evaluate(() => missing._panel.port),null);
    assert.equal(await page.evaluate(() => calls.at(-1).floor),'missing');
    await page.evaluate(() => missing.remove());
    assert.equal(await page.evaluate(() => subscriptions),0);

    // Same-user reconnects retain the edited viewer until a pending save settles.
    await page.evaluate(() => { window.protectedCard = makeCard({floor:'main'}); });
    await page.waitForFunction(() => protectedCard._panel?.port);
    await page.evaluate(() => {
      window.protectedPanel = protectedCard._panel;
      window.saveCalls = [];
      const originalCall = protectedPanel._hass.callWS;
      protectedPanel._hass.callWS = message => {
        if (message.type !== 'home_floorplan/save') return originalCall(message);
        saveCalls.push(message);return new Promise(resolve => window.finishSave = resolve);
      };
      protectedPanel.handleViewerMessage({type:'save',items:[{id:'edited',entity_id:'switch.lamp'}]},protectedPanel.generation);
    });
    await page.waitForFunction(() => window.finishSave);
    await page.evaluate(() => {
      window.reconnected = {...makeHass(),connection:{subscribeMessage:haConnection.subscribeMessage}};
      protectedCard.hass = reconnected;
    });
    assert.deepEqual(await page.evaluate(() => [protectedCard._panel === protectedPanel,protectedPanel.pending,!!protectedPanel.port]),[true,1,true]);
    assert.match(await page.locator('#status').textContent(),/Waiting for layout edits/);
    assert((await page.locator('iframe').boundingBox()).height > 200,'reconnect notice leaves edited viewer usable');
    await page.evaluate(() => finishSave({revision:1}));
    await page.waitForFunction(() => protectedCard._panel !== protectedPanel && protectedCard._panel?.port);
    assert.deepEqual(await page.evaluate(() => [protectedPanel.savedItems[0].id,protectedPanel.port,saveCalls.length]),['edited',null,1]);
    assert.equal(await page.locator('#status').isVisible(),false);

    // Failed edits remain available for export; a successful explicit reload releases the hold.
    await page.evaluate(() => {
      window.protectedPanel = protectedCard._panel;
      const originalCall = protectedPanel._hass.callWS;
      protectedPanel._hass.callWS = message => message.type === 'home_floorplan/save' ? Promise.reject(Error('Save failed')) : originalCall(message);
      protectedPanel.handleViewerMessage({type:'save',items:[{id:'unsaved',entity_id:'switch.lamp'}]},protectedPanel.generation);
    });
    await page.waitForFunction(() => protectedPanel.failed && !protectedPanel.pending);
    await page.evaluate(() => protectedCard.hass = {...makeHass(),connection:{subscribeMessage:haConnection.subscribeMessage}});
    assert.deepEqual(await page.evaluate(() => [protectedCard._panel === protectedPanel,protectedPanel.failed,!!protectedPanel.port]),[true,true,true]);
    assert.match(await page.locator('#status').textContent(),/Export inventory JSON/);
    page.once('dialog',dialog => dialog.accept());
    await page.locator('#retry').click();
    await page.waitForFunction(() => protectedCard._panel !== protectedPanel && protectedCard._panel?.port);
    assert.equal(await page.locator('#status').isVisible(),false);

    // Queued saves cannot dispatch after account replacement or direct card removal.
    await page.evaluate(() => {
      window.protectedPanel = protectedCard._panel;window.staleSaveCalls = [];
      const originalCall = protectedPanel._hass.callWS;
      protectedPanel._hass.callWS = message => {
        if (message.type === 'home_floorplan/save') {staleSaveCalls.push(message);return Promise.resolve({revision:2});}
        return originalCall(message);
      };
      protectedPanel.handleViewerMessage({type:'save',items:[]},protectedPanel.generation);
      protectedCard.hass = makeHass(true,'replacement-admin');
    });
    await page.waitForFunction(() => protectedCard._panel?.port && !protectedPanel.pending);
    assert.deepEqual(await page.evaluate(() => [protectedCard._panel === protectedPanel,protectedPanel.port,staleSaveCalls.length]),[false,null,0]);
    await page.evaluate(() => {
      window.protectedPanel = protectedCard._panel;
      protectedPanel._hass.callWS = message => {staleSaveCalls.push(message);return Promise.resolve({revision:3});};
      protectedPanel.handleViewerMessage({type:'save',items:[]},protectedPanel.generation);
      protectedCard.remove();
    });
    await page.waitForFunction(() => !protectedPanel.pending);
    assert.deepEqual(await page.evaluate(() => [protectedPanel.port,staleSaveCalls.length,subscriptions]),[null,0,0]);

    // A remounted card exports the newest submitted layout without reviving its destroyed iframe.
    await page.evaluate(() => { window.remountCard=makeCard({floor:'main'}); });
    await page.waitForFunction(() => remountCard._panel?.port);
    frame=page.frames().find(frame=>frame.parentFrame());
    await frame.waitForFunction(() => window.port);
    await page.evaluate(() => {
      window.remountPanel=remountCard._panel;window.saveReplies=[];
      window.viewCountBefore=calls.filter(call=>call.type==='home_floorplan/viewer').length;
      const originalCall=remountPanel._hass.callWS;
      remountPanel._hass.callWS=message=>message.type==='home_floorplan/save' ?
        new Promise((resolve,reject)=>saveReplies.push({resolve,reject})) : originalCall(message);
      window.latestItems=[{id:'recovered_lamp',name:'Unsaved desk lamp',type:'lamp',room:'study',
        position_m:{x:1,y:0,z:2},dimensions_m:{width:.3,depth:.3,height:.6},rotation_deg:90,
        entity_id:'switch.lamp',notes:'Latest edits must survive remount.'}];
    });
    await frame.evaluate(() => port.postMessage({type:'save',items:[{id:'earlier'}]}));
    await page.waitForFunction(() => saveReplies.length===1);
    await frame.evaluate(items=>port.postMessage({type:'save',items}),await page.evaluate(()=>latestItems));
    await page.waitForFunction(() => remountPanel.pending===2);
    await page.evaluate(() => saveReplies[0].resolve({revision:4}));
    await page.waitForFunction(() => saveReplies.length===2 && remountPanel.pending===1);
    assert.deepEqual(await page.evaluate(() => JSON.parse(remountPanel.localEdits.json).items),await page.evaluate(()=>latestItems),
      'an earlier successful save must not clear the latest outstanding submission');
    await page.evaluate(() => { remountCard.remove();document.body.append(remountCard); });
    assert.deepEqual(await page.evaluate(() => [remountCard._panel===remountPanel,remountPanel.port,remountPanel.viewerURL,subscriptions,
      calls.filter(call=>call.type==='home_floorplan/viewer').length===viewCountBefore]),[true,null,null,0,true]);
    assert.equal(await page.locator('#local-recovery').isVisible(),true);
    assert.equal(await page.locator('iframe').getAttribute('src'),null);
    await page.evaluate(() => saveReplies[1].resolve({revision:5}));
    await page.waitForFunction(() => !remountPanel.pending && remountPanel.failed);
    assert.equal(await page.evaluate(() => saveReplies.length),2,'remount never resubmits pending edits');
    assert.deepEqual(await page.evaluate(() => JSON.parse(remountPanel.localEdits.json).items),await page.evaluate(()=>latestItems));
    const downloading=page.waitForEvent('download');
    await page.locator('#local-export').click();
    const download=await downloading,stream=await download.createReadStream(),chunks=[];
    for await (const chunk of stream) chunks.push(chunk);
    const recovered=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(recovered.model,'fictional_layout');assert.equal(recovered.units,'metres');
    assert.deepEqual(recovered.items,await page.evaluate(()=>latestItems));
    assert.equal(download.suggestedFilename(),'fictional_layout-unsaved-inventory.json');
    page.once('dialog',dialog=>dialog.dismiss());await page.locator('#retry').click();
    assert.equal(await page.evaluate(()=>!!remountPanel.localEdits),true,'cancelled reload retains the export');
    page.once('dialog',dialog=>dialog.accept());await page.locator('#retry').click();
    await page.waitForFunction(()=>remountPanel.port && !remountPanel.failed);
    assert.equal(await page.evaluate(()=>remountPanel.localEdits),null);
    assert.equal(await page.locator('#local-recovery').isVisible(),false);

    // Already-failed layouts survive repeated detach, but never transfer to another account.
    await page.evaluate(() => {
      remountPanel._hass.callWS=()=>Promise.reject(Error('Save rejected'));
      remountPanel.handleViewerMessage({type:'save',items:latestItems},remountPanel.generation);
    });
    await page.waitForFunction(()=>remountPanel.failed && !remountPanel.pending);
    await page.evaluate(()=>{remountCard.remove();document.body.append(remountCard);});
    assert.equal(await page.locator('#local-recovery').isVisible(),true);
    assert.deepEqual(await page.evaluate(()=>JSON.parse(remountPanel.localEdits.json).items),recovered.items);
    await page.evaluate(()=>{remountCard.remove();remountCard.hass=makeHass(true,'new-account');document.body.append(remountCard);});
    await page.waitForFunction(()=>remountCard._panel!==remountPanel && remountCard._panel?.port);
    assert.equal(await page.evaluate(()=>remountPanel.localEdits),null);
    assert.equal(await page.locator('#local-recovery').isVisible(),false);
    await page.evaluate(()=>{
      window.remountPanel=remountCard._panel;
      remountPanel._hass.callWS=()=>Promise.reject(Error('Save rejected'));
      remountPanel.handleViewerMessage({type:'save',items:latestItems},remountPanel.generation);
    });
    await page.waitForFunction(()=>remountPanel.failed && !remountPanel.pending);
    await page.evaluate(()=>{remountCard.remove();remountCard.hass=makeHass(false,'new-account');document.body.append(remountCard);});
    assert.equal(await page.evaluate(()=>remountPanel.localEdits),null);
    await page.waitForFunction(()=>remountCard._panel?.port);
    assert.equal(await page.locator('iframe').getAttribute('sandbox'),'allow-scripts');
    assert.equal(await page.evaluate(()=>remountCard._panel.canEdit),false);
    await page.evaluate(()=>remountCard.remove());
    assert.equal(await page.evaluate(()=>subscriptions),0);
    // Card edit locks also apply to administrators; live control remains available.
    await page.evaluate(()=>{window.locked=makeCard({edit_locked:true});});
    await page.waitForFunction(()=>locked._panel?.port);
    frame=page.frames().find(frame=>frame.parentFrame());await frame.waitForFunction(()=>window.initial);
    assert.equal(await frame.evaluate(()=>initial.can_edit),false);
    assert.equal(await page.locator('#studio').isVisible(),false);
    assert.equal(await page.locator('iframe').getAttribute('sandbox'),'allow-scripts');
    await frame.evaluate(()=>port.postMessage({type:'save',items:[]}));
    assert.equal(await page.evaluate(()=>locked._panel.pending),0);
    await page.evaluate(()=>{locked.remove();window.empty=makeCard({floor:'empty'});});
    await page.waitForFunction(()=>empty._panel?.$('notice').textContent.includes('Create and publish'));
    assert.equal(await page.locator('#studio').isVisible(),true);
    assert.equal(await page.locator('#studio').getAttribute('href'),'/home-studio');
    assert.equal(await page.locator('iframe').isVisible(),false);
    assert.equal(await page.evaluate(()=>empty._panel.port),null);
    await page.evaluate(()=>{empty.hass=makeHass(false,'family');});
    await page.waitForFunction(()=>empty._panel?.$('notice').textContent.includes('Ask an administrator'));
    assert.equal(await page.locator('#studio').isVisible(),false);
    await page.evaluate(()=>{empty.remove();window.legacy=makeCard({floor:'legacy'});});
    await page.waitForFunction(()=>legacy._panel?.port);
    assert.equal(await page.evaluate(()=>legacy._panel.canEdit),true);
    assert.equal(await page.locator('#studio').isVisible(),false,'portable builds do not link to an unavailable native editor');
    await page.evaluate(()=>legacy.remove());
    assert.deepEqual(errors,[]);
    console.log('PASS: dashboard module, validation, sizing, floor selection, opaque sandbox, pinned dry run, live controls, admin gating, reconnect/remount edit recovery and stale-save rejection.');
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
