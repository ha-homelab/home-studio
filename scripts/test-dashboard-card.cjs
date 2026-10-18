// Exercise the real Lovelace module and host using only a local fake HA server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {chromium} = require('playwright');
const root = path.resolve(__dirname,'..');
const viewer = `<!doctype html><html><head><meta charset="utf-8"></head><body><button id="toggle">Toggle</button><script>
  window.received = [];
  addEventListener('message',event => {
    if (event.source !== parent || event.data?.type !== 'home-floorplan:init') return;
    window.initial = event.data;
    window.port = event.ports[0];
    port.onmessage = event => received.push(event.data);
    document.querySelector('#toggle').onclick = () => port.postMessage({type:'toggle',entity_id:'switch.lamp',request_id:'toggle'});
  });
</script></body></html>`;
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
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
      return {html:${JSON.stringify(viewer).replaceAll('<','\\u003c')},floor:message.floor || 'main',floors:['main','upper'],
        site_features:false,revision:0,items:[{id:'lamp',entity_id:'switch.lamp'}]};
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
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.ready);
    assert.deepEqual(await page.evaluate(() => {
      const card = document.createElement('home-floorplan-card');
      return [card.getCardSize(),card.getGridOptions(),customCards.filter(card => card.type === 'home-floorplan-card').length];
    }),[12,{columns:12,rows:'auto',min_columns:6},1]);
    await page.evaluate(() => {
      const invalid = [null,[],{floor:'../main'},{floor:'A'},{floor:'a'.repeat(49)},{height:'600px'},
        {height:239},{height:1601},{height:NaN},{sidebar_collapsed:'true'},{dry_run:1}];
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

    // Demotion removes private content immediately and closes the same host resources.
    await page.evaluate(() => card.hass = makeHass(false));
    assert.equal(await page.locator('iframe').count(),0);
    assert.match(await page.locator('#status').textContent(),/Administrator access/);
    assert.deepEqual(await page.evaluate(() => [original.port,original.viewerURL,original.started,subscriptions]),[null,null,false,0]);
    await page.evaluate(() => card.hass = makeHass());
    await page.waitForFunction(() => card._panel?.port);
    assert.equal(await page.evaluate(() => calls.length),2);
    await page.evaluate(() => { window.original = card._panel; card.remove(); });
    assert.deepEqual(await page.evaluate(() => [original.port,original.viewerURL,original.started,subscriptions]),[null,null,false,0]);
    await page.evaluate(() => document.body.append(card));
    await page.waitForFunction(() => card._panel?.port);
    assert.deepEqual(await page.evaluate(() => [card._panel === original,calls.length,subscriptions]),[true,3,1]);
    await page.evaluate(() => card.hass = makeHass(true,'other-admin'));
    await page.waitForFunction(() => card._panel?.port);
    assert.deepEqual(await page.evaluate(() => [card._panel === original,original.port,original.viewerURL,calls.length,subscriptions]),[false,null,null,4,1]);

    // A non-admin cannot bootstrap any floor or obtain an active subscription.
    await page.evaluate(() => {
      card.remove(); calls.length = 0;
      window.denied = document.createElement('home-floorplan-card');
      denied.setConfig({}); denied.hass = makeHass(false); document.body.append(denied);
    });
    assert.deepEqual(await page.evaluate(() => [calls.length,subscriptions]),[0,0]);
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
    assert.deepEqual(errors,[]);
    console.log('PASS: dashboard module, validation, sizing, floor selection, opaque sandbox, pinned dry run, live controls, admin gating, state updates and reconnect cleanup.');
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
