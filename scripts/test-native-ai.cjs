// Exercise the real native host, opaque editor, and shared AI panel against a
// synthetic authenticated HA HTTP service. No provider or household data used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const playwright = require('playwright');
const { browserLaunchOptions } = require('./browser-stability-diagnostics.cjs');
const root = path.resolve(__dirname, '..');
const engine = process.env.BROWSER || 'chromium';
const AUTH = 'FAKE_HA_AUTH_NEVER_IN_IFRAME', KEY = 'synthetic-provider-secret';
const sessions = new Map(), calls = [], pendingGenerations = new Set(), pendingSessions = new Set();
const releaseGenerations = () => { for (const resolve of pendingGenerations) resolve(); pendingGenerations.clear(); };
const releaseSessions = () => { for (const resolve of pendingSessions) resolve(); pendingSessions.clear(); };
async function waitForPending(requests) {
  const deadline=Date.now()+5000;
  while (!requests.size) {
    if (Date.now()>deadline) throw new Error('Synthetic request was not received');
    await new Promise(resolve=>setTimeout(resolve,10));
  }
}
let nextSession = 0, failGenerate = false, failureUpstreamStatus = undefined, invalidDraft = false, slowGenerate = false, slowConnect = false, slowSession = false, failDisconnect = false;
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'planner/catalog.json')));
const model = catalog.models.find(item => item.id === 'round_dining_table');
function draft(body) {
  return { draft_version: 1, request_id: body.request_id, kind: 'new_room', room_name: 'Synthetic AI room',
    items: [{ candidate_key: 'table', name: 'Round table', model_id: model.id, style_id: model.default_style,
      position_m: { x: 2, y: 0, z: 1.5 }, dimensions_m: { width: 1.4, depth: .8, height: .75 },
      rotation_deg: 0, color: null, pattern_id: null, pattern_color: null, evidence: 'Synthetic image; check dimensions.' }],
    openings: [], assumptions: ['Furniture dimensions estimated.'], needs_measurements: [] };
}
const fixture = ai => `<!doctype html><html><body style="margin:0"><home-floorplan-studio-panel></home-floorplan-studio-panel><script type="module">
await import('/custom_components/home_floorplan/static/studio.js');
window.host=document.querySelector('home-floorplan-studio-panel');window.saved={project:null,revision:0};window.calls=[];
window.hass={user:{id:'native-ai-admin',is_admin:true},auth:{accessToken:'${AUTH}'},fetchWithAuth:(url,options)=>fetch(url,{...options,headers:{...options.headers,Authorization:'Bearer ${AUTH}'}}),callWS:async data=>{calls.push(structuredClone(data));if(data.type.endsWith('entity_catalog'))return {floors:[],areas:[],entities:[]};if(data.type.endsWith('project_save')){saved={project:data.project,revision:saved.revision+1};}return {...saved,can_edit:true,editor_url:'/home-floorplan-studio/planner/index.html',capabilities:{authoring:true,ai:${ai}}};}};host.hass=hass;
</script></body></html>`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/fixture') return res.writeHead(200, {'Content-Type':'text/html'}).end(fixture(url.searchParams.get('ai') !== '0'));
  if (url.pathname.startsWith('/api/home_floorplan/ai/')) {
    const action = url.pathname.split('/').pop();
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    calls.push({action,body,authorization:req.headers.authorization,session:req.headers['x-home-studio-session']});
    const reply = (code, value) => res.writeHead(code, {'Content-Type':'application/json'}).end(JSON.stringify(value));
    if (req.headers.authorization !== `Bearer ${AUTH}`) return reply(401,{error:{code:'unauthorized'}});
    if (action === 'session') {
      const token = `synthetic-native-session-token-${++nextSession}`;
      sessions.set(token,{connected:false});
      if (slowSession) await new Promise(resolve=>pendingSessions.add(resolve));
      return reply(200,{session:token,expires_at:Math.floor(Date.now()/1000)+1800});
    }
    const session=sessions.get(req.headers['x-home-studio-session']);
    if (!session) return reply(403,{error:{code:'session_expired'}});
    if (action === 'providers') return reply(200,{providers:[{id:'synthetic',label:'Synthetic cloud',requires_key:true,local:false,default_endpoint:'https://synthetic.invalid'},{id:'ollama',label:'Local model',requires_key:false,local:true,default_endpoint:'http://127.0.0.1:11434'}]});
    if (action === 'connect') {
      if (slowConnect) await new Promise(resolve=>setTimeout(resolve,300));
      Object.assign(session,{connected:true,provider:body.provider,model:body.model,endpoint:body.endpoint||'https://synthetic.invalid'});
      return reply(200,{...session,expires_at:Math.floor(Date.now()/1000)+1800});
    }
    if (action === 'close') { sessions.delete(req.headers['x-home-studio-session']); return reply(200,{connected:false}); }
    if (action === 'disconnect') { if (failDisconnect) return reply(503,{error:{code:'unavailable'}}); session.connected=false; return reply(200,{connected:false}); }
    if (action === 'cancel') return reply(200,{cancelled:true});
    if (action === 'generate') {
      if (failGenerate) return reply(failGenerate==='provider_timeout'?504:502,{error:{code:failGenerate===true?'upstream_auth':failGenerate,upstream_status:failureUpstreamStatus,message:'Internal secrets must never appear'}});
      if (slowGenerate) await new Promise(resolve=>pendingGenerations.add(resolve));
      const proposal=draft(body);if(invalidDraft)proposal.items[0].position_m.x=-3;
      return reply(200,{draft:proposal});
    }
    return reply(400,{error:{code:'invalid_request'}});
  }
  const route=url.pathname.replace(/^\/home-floorplan-studio\//,'/');
  const file=path.resolve(root,'.'+route+(route.endsWith('/')?'index.html':''));
  if (!file.startsWith(root+path.sep)) return res.writeHead(404).end();
  try { const body=fs.readFileSync(file);const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'};res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Access-Control-Allow-Origin':'*'}).end(body); } catch { res.writeHead(404).end(); }
});
(async()=>{
  let browser;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
    browser=await playwright[engine].launch(browserLaunchOptions(engine,true));
    const page=await browser.newPage({viewport:{width:1500,height:1100}});page.setDefaultTimeout(15000);
    const errors=[], external=[];page.on('pageerror',e=>errors.push(String(e)));
    page.on('request',req=>{if(!req.url().startsWith(origin)&&!req.url().startsWith('blob:'))external.push(req.url());});
    await page.addInitScript(()=>{window.received=[];window.addEventListener('message',event=>{if(event.data?.protocol==='home-studio-editor-v1')window.received.push(event.data);});});
    await page.goto(origin+'/fixture');await page.waitForFunction(()=>window.host?._ready);
    assert.equal(await page.evaluate(()=>host.getBoundingClientRect().height),1100,'Native host fills the viewport even when its parent has auto height');
    assert.equal(await page.evaluate(()=>host._frame.getBoundingClientRect().bottom),1100);
    // A stale error belongs to its old token, even when a new session was
    // established while that HTTP response was delayed.
    const staleSession = await page.evaluate(async()=>{
      const original={fetch:host._hass.fetchWithAuth,session:host._aiSession,sequence:host._aiSequence};
      let releaseOld, started;const pendingStarted=new Promise(resolve=>started=resolve);
      const oldToken='OLD_SYNTHETIC_SESSION_TOKEN',newToken='NEW_SYNTHETIC_SESSION_TOKEN';
      host._aiSession={token:oldToken,expires:Date.now()+60000};
      host._hass.fetchWithAuth=async url=>{
        if(url.endsWith('/status')){started();return new Promise(resolve=>releaseOld=resolve);}
        if(url.endsWith('/session'))return new Response(JSON.stringify({session:newToken,expires_at:Date.now()/1000+1800}));
        if(url.endsWith('/connect'))return new Response(JSON.stringify({connected:true,provider:'synthetic',model:'synthetic-vision'}));
        throw new Error('Unexpected synthetic request');
      };
      try {
        const old=host._aiRequest({requestId:`ai-${original.sequence+1}`,action:'status'});await pendingStarted;
        host._aiSession.expires=Date.now()-1;
        await host._aiRequest({requestId:`ai-${original.sequence+2}`,action:'connect',body:{provider:'synthetic',model:'synthetic-vision',api_key:'synthetic-only'}});
        const before=host._aiSession?.token;
        releaseOld(new Response(JSON.stringify({error:{code:'session_expired'}}),{status:403}));await old;
        return {before,after:host._aiSession?.token,pending:host._aiPending.size};
      } finally {host._hass.fetchWithAuth=original.fetch;host._aiSession=original.session;host._aiSequence=original.sequence;}
    });
    assert.deepEqual(staleSession,{before:'NEW_SYNTHETIC_SESSION_TOKEN',after:'NEW_SYNTHETIC_SESSION_TOKEN',pending:0});
    let frame=page.frames().find(value=>value.url().includes('embed='));await frame.locator('#ai-open').waitFor();
    assert.equal(nextSession,0,'Opening the drawing must not create an AI session');
    assert.match(await frame.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'),/connect-src 'none'/);
    assert.equal(await frame.evaluate(()=>{try{return parent.document.body.innerHTML;}catch{return 'isolated';}}),'isolated');
    const beforePhotoGuide=calls.length;
    await page.getByRole('button',{name:'Draft from photos (AI)',exact:true}).click();
    await frame.waitForFunction(()=>!document.getElementById('ai-provider').disabled);
    assert.equal(await frame.locator('#ai-panel').isVisible(),true,'The guide opens the existing AI panel');
    assert.equal(await frame.locator('#ai-panel').count(),1);
    assert.equal(calls.slice(beforePhotoGuide).some(call=>['connect','generate'].includes(call.action)),false,'Opening photo guidance must not connect a provider or generate a draft');
    assert.equal(await frame.locator('#ai-mode').inputValue(),'furnish_room','Inside opens the room workflow');
    await frame.locator('#ai-close').click();
    await frame.locator('#site-mode').click();
    await frame.getByRole('button',{name:'Neighborhood',exact:true}).click();
    await frame.locator('#ai-open').click();
    assert.equal(await frame.locator('#ai-mode').inputValue(),'site','Opening from Site automatically selects exterior planning');
    assert.equal(await frame.locator('#ai-site-fields').isVisible(),true);
    assert.match(await frame.locator('#ai-target').innerText(),/Neighborhood: add only neighboring/);
    await frame.locator('#ai-site-home').fill('My home is the center building.');
    const siteContext=JSON.parse(await frame.locator('#ai-context').textContent());
    assert.equal(Object.hasOwn(siteContext,'floor_footprints'),false);
    assert.equal(siteContext.exterior_reference.kind,'unavailable','An empty draft does not invent exterior geometry');
    await frame.locator('#ai-close').click();
    await frame.locator('#inside-mode').click();
    await frame.locator('#ai-open').click();
    assert.equal(await frame.locator('#ai-mode').inputValue(),'furnish_room','Returning Inside restores the previous room mode');
    await frame.locator('#ai-mode').selectOption('new_room');
    await frame.locator('#ai-close').click();
    await frame.locator('#site-mode').click();
    await frame.locator('#ai-open').click();
    assert.equal(await frame.locator('#ai-mode').inputValue(),'site');
    await frame.locator('#ai-close').click();
    await frame.locator('#inside-mode').click();
    await frame.locator('#ai-open').click();
    assert.equal(await frame.locator('#ai-mode').inputValue(),'new_room','An explicitly chosen measured-room workflow survives a Site visit');
    assert.equal(nextSession,1);
    assert.equal(await frame.locator('#ai-key').getAttribute('type'),'password');
    assert.equal(await frame.getByRole('button',{name:/reveal|show.*key/i}).count(),0);
    assert.match(await frame.locator('#ai-privacy').innerText(),/Home Assistant process session memory/);
    await frame.locator('#ai-provider').selectOption('ollama');
    assert.match(await frame.locator('#ai-privacy').innerText(),/Loopback means the Home Assistant host/);
    await frame.locator('#ai-provider').selectOption('synthetic');
    await frame.locator('#ai-model').fill('synthetic-vision');await frame.locator('#ai-key').fill(KEY);
    await frame.locator('#ai-connect').click();assert.equal(await frame.locator('#ai-key').inputValue(),'');
    await frame.waitForFunction(()=>document.getElementById('ai-status').textContent.includes('Session connected'));
    assert.equal(calls.find(call=>call.action==='connect').body.api_key,KEY);
    await frame.locator('#ai-mode').selectOption('new_room');await frame.locator('#ai-instructions').fill('A synthetic measured room.');
    const photo=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=64;c.getContext('2d').fillRect(0,0,64,64);return c.toDataURL('image/png').split(',')[1];});
    await frame.locator('#ai-photos-input').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from(photo,'base64')});
    await frame.waitForFunction(()=>document.getElementById('ai-photo-progress').textContent.includes('1 photos ready'));
    const before=await frame.evaluate(()=>planner.getProject());
    invalidDraft=true;await frame.locator('#ai-generate').click();
    await frame.waitForFunction(()=>document.getElementById('ai-status').textContent.includes('Draft could not be used'));
    assert.deepEqual(await frame.evaluate(()=>planner.getProject()),before);
    assert.match(await frame.locator('#ai-retry-hint').innerText(),/entire rotated width\/depth footprint/);
    const rejectedCount=calls.filter(call=>call.action==='generate').length;await page.waitForTimeout(50);
    assert.equal(calls.filter(call=>call.action==='generate').length,rejectedCount,'No automatic model retries');
    await frame.locator('#ai-instructions').fill('A synthetic measured room. Keep the table inside.');
    assert.equal(await frame.locator('#ai-retry-hint').isVisible(),false,'Input changes discard stale feedback');
    await frame.locator('#ai-generate').click();await frame.waitForFunction(()=>document.getElementById('ai-status').textContent.includes('Draft could not be used'));
    invalidDraft=false;
    await frame.locator('#ai-generate').click();await frame.waitForFunction(()=>document.getElementById('ai-status').textContent.includes('Draft ready'));
    assert.deepEqual(await frame.evaluate(()=>planner.getProject()),before);
    const generated=calls.filter(call=>call.action==='generate').at(-1);
    assert.match(generated.body.instructions,/Previous draft validation feedback:/);
    assert(!generated.body.instructions.includes('Round table'),'Only a fixed validation category is sent, not model names');
    assert.match(generated.body.instructions,/entire rotated width\/depth footprint/);
    assert.equal(await frame.locator('#ai-instructions').inputValue(),'A synthetic measured room. Keep the table inside.');
    assert.equal(await frame.locator('#ai-retry-hint').isVisible(),false);
    assert.equal(generated.body.images.length,1);assert.equal(generated.body.images[0].mime_type,'image/jpeg');
    assert.equal(generated.body.api_key,undefined);
    await frame.locator('#preview-tab').click();await frame.waitForFunction(()=>planner.getPreviewMetadata().items===1);
    await frame.locator('#ai-review-confirm').check();await frame.locator('#ai-apply').click();
    await frame.waitForFunction(()=>planner.getProject().floors[0].rooms.length===1);
    assert.match(await frame.locator('#ai-status').innerText(),/Save draft in Home Assistant, then Publish to 3D Home/);
    await page.locator('#save').click();await page.waitForFunction(()=>saved.revision===1&&!host._busy);
    const saved=await page.evaluate(()=>JSON.stringify(window.saved));assert(!saved.includes(KEY));assert(!saved.includes(AUTH));assert(!saved.includes('synthetic-native-session-token'));
    const moreOptions=page.locator('#more-options');
    assert.equal(await moreOptions.getAttribute('open'),null);
    await moreOptions.locator('summary').click();
    const download=page.waitForEvent('download');await page.locator('#export').click();
    assert(!fs.readFileSync(await(await download).path(),'utf8').includes(KEY));
    await moreOptions.locator('summary').click();
    assert.equal(await moreOptions.getAttribute('open'),null);
    await frame.locator('#undo').click();assert.deepEqual(await frame.evaluate(()=>planner.getProject()),before);
    failGenerate=true;await frame.locator('#ai-generate').click();await frame.waitForFunction(()=>document.getElementById('ai-status').textContent.includes('provider rejected'));
    assert.deepEqual(await frame.evaluate(()=>planner.getProject()),before);failGenerate=false;
    for (const [code,fragment,upstream] of [
      ['provider_timeout','provider took too long'],['provider_connection','Could not connect'],
      ['provider_http','provider rejected the request'],['provider_size','response exceeded the size limit'],
      ['invalid_provider_output','incomplete or invalid draft'],['dns_busy','address lookup'],
      ['provider_encoding','unsupported response encoding'],['provider_http','key or its model access',401],
      ['provider_http','rate or usage limit',429],['provider_http','selected model or input format',404],
      ['provider_http','redirected the request',302]]) {
      failGenerate=code;failureUpstreamStatus=upstream;await frame.locator('#ai-generate').click();
      await frame.waitForFunction(text=>document.getElementById('ai-status').textContent.includes(text),fragment);
      assert(!(await frame.locator('#ai-status').innerText()).includes('Internal secrets'));
      assert.deepEqual(await frame.evaluate(()=>planner.getProject()),before);
    }
    failGenerate=false;failureUpstreamStatus=undefined;
    slowGenerate=true;
    await frame.locator('#ai-generate').click();await page.waitForFunction(()=>host._aiPending.size>0);await waitForPending(pendingGenerations);
    await frame.locator('#ai-cancel-request').click();await frame.waitForFunction(()=>document.getElementById('ai-status').textContent.includes('Generation cancelled'));
    releaseGenerations();await page.waitForTimeout(100);assert.deepEqual(await frame.evaluate(()=>planner.getProject()),before);
    assert.equal(await frame.locator('#ai-review').isVisible(),false);assert(calls.some(call=>call.action==='cancel'));
    slowGenerate=false;
    const received=await frame.evaluate(()=>JSON.stringify(window.received));assert(!received.includes(AUTH));assert(!received.includes('synthetic-native-session-token'));assert(!received.includes(KEY));assert(!received.includes('Internal secrets'));
    // Wrong window and channel cannot dispatch HTTP.
    const count=calls.length;const channel=await page.evaluate(()=>host._channel);
    await page.evaluate(channel=>window.postMessage({protocol:'home-studio-editor-v1',channel,type:'ai-request',requestId:'ai-900',action:'providers'},'*'),channel);
    await frame.evaluate(()=>parent.postMessage({protocol:'home-studio-editor-v1',channel:'wrong',type:'ai-request',requestId:'ai-900',action:'providers'},'*'));
    await page.waitForTimeout(50);assert.equal(calls.length,count);
    await frame.locator('#ai-disconnect').click();await frame.waitForFunction(()=>document.getElementById('ai-status').textContent.includes('Session ended'));
    assert.equal(await frame.locator('#ai-instructions').inputValue(),'');
    // End during Connect must settle the late Connect before final Disconnect.
    slowConnect=true;await frame.locator('#ai-key').fill(KEY);await frame.locator('#ai-connect').click();await frame.locator('#ai-disconnect').click();
    await page.waitForFunction(()=>host._aiPending.size===0);await page.waitForTimeout(400);
    assert.equal([...sessions.values()].at(-1).connected,false);slowConnect=false;
    await frame.locator('#ai-key').fill(KEY);await frame.locator('#ai-connect').click();await frame.waitForFunction(()=>document.getElementById('ai-status').textContent.includes('Session connected'));
    failDisconnect=true;await frame.locator('#ai-disconnect').click();
    await frame.waitForFunction(()=>document.getElementById('ai-status').textContent.includes('could not confirm'));
    assert.equal([...sessions.values()].at(-1).connected,true);failDisconnect=false;
    await frame.locator('#ai-key').fill(KEY);await frame.locator('#ai-connect').click();await frame.waitForFunction(()=>document.getElementById('ai-status').textContent.includes('Session connected'));
    slowGenerate=true;await frame.locator('#ai-generate').click();await page.waitForFunction(()=>host._aiPending.size>0);await waitForPending(pendingGenerations);
    const admitted = calls.length, pendingId=await page.evaluate(()=>[...host._aiPending.keys()][0]);
    await frame.evaluate(({channel,pendingId})=>{
      for (const data of [
        {requestId:pendingId,action:'providers'},
        {requestId:'ai-900',action:'session'},
        {requestId:'ai-901',action:'close'},
        {requestId:'ai-902',action:'connect',body:{api_key:'x'.repeat(33000)}},
        {requestId:'ai-903',action:'providers',body:{url:'https://synthetic.invalid'}}])
        parent.postMessage({protocol:'home-studio-editor-v1',channel,type:'ai-request',...data},'*');
    },{channel,pendingId});
    await page.waitForTimeout(60);assert.equal(calls.length,admitted,'replay, unknown actions and oversized/extra payloads cannot dispatch');
    assert.equal(await frame.locator('#ai-review').isVisible(),false);
    await page.evaluate(()=>host.hass={...window.hass,user:{id:'another-user',is_admin:false}});
    releaseGenerations();await page.waitForTimeout(100);assert.equal(await page.locator('iframe').count(),0);assert.equal(await page.evaluate(()=>host._aiPending.size),0);assert.equal(await page.evaluate(()=>host._aiSession),null);
    assert.equal(sessions.size,0);
    await page.evaluate(()=>sessionStorage.clear());
    await page.goto(origin+'/fixture?ai=0');await page.waitForFunction(()=>window.host?._ready);frame=page.frames().find(value=>value.url().includes('embed='));assert.equal(await frame.locator('#ai-open').count(),0);
    assert.equal(await page.locator('#guide-photos').isVisible(),false,'Photo guidance is absent when the server disables AI');
    // Narrow screens keep the viewport-sized host and can scroll to the full editor.
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>host.getBoundingClientRect().height),844);
    assert(await page.evaluate(()=>{host.scrollTop=host.scrollHeight;return host.scrollTop>0&&host.scrollHeight>host.clientHeight;}));
    await page.setViewportSize({width:1500,height:1100});await page.evaluate(()=>host.scrollTop=0);
    assert.equal(await page.evaluate(()=>host._frame.getBoundingClientRect().bottom),1100);
    // A session created after its iframe has gone away is immediately closed.
    await page.evaluate(()=>sessionStorage.clear());
    slowSession=true;await page.goto(origin+'/fixture');await page.waitForFunction(()=>window.host?._ready);
    frame=page.frames().find(value=>value.url().includes('embed='));await frame.locator('#ai-open').click();
    await page.waitForFunction(()=>host._aiSessionPromise!==null);
    await waitForPending(pendingSessions);
    await page.evaluate(()=>host.hass={...window.hass,user:{id:'late-session-user',is_admin:false}});
    releaseSessions();
    const cleanupDeadline=Date.now()+5000;
    while (sessions.size && Date.now()<cleanupDeadline) await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(sessions.size,0);assert.equal(await page.evaluate(()=>host._aiSession),null);slowSession=false;
    await page.goto(origin+'/planner/');await page.waitForFunction(()=>!!window.planner);assert.equal(await page.locator('#ai-open').count(),0);
    assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
    console.log(`${engine}: native AI lazy session, opaque CSP, photo preparation, key masking/clearing, preview/apply/save/undo, errors/cancel and lifecycle isolation passed`);
  } finally { releaseGenerations();releaseSessions();if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
