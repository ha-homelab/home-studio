// Exercise the actual host with fake HA and MessagePorts. No external network or home data.
'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../custom_components/home_floorplan/static/panel.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const flush=async()=>{for(let i=0;i<6;i++)await new Promise(setImmediate);};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const config=()=>({enabled:true,latitude:0,longitude:0,model_x:0,model_z:0,north_deg:0});
const snapshot=()=>({revision:1,configured:true,config:config(),reference:{latitude:0,longitude:0}});
const navigation=()=>({mode:'map',zoom:.1,rotation:1,tilt:.2,pan_x:20,pan_y:30});
const preciseNavigation=()=>({...navigation(),target_x:1200,target_z:-3400,span_m:25000});
const tile=()=>({data_url:'data:image/png;base64,AQID'});

function fixture({callWS,admin=true,dryRun=false}={}) {
  let Panel,timer=0;const messages=[],calls=[],initializations=[],nodes=new Map(),timers=new Map(),ports=[];
  const makePort=()=>{const port={closed:false,postMessage(value){assert.equal(port.closed,false);messages.push(plain(value));},close(){port.closed=true;}};ports.push(port);return port;};
  class MessageChannel {constructor(){this.port1=makePort();this.port2={};}}
  const document={hidden:false,addEventListener(){},removeEventListener(){}};
  const context=vm.createContext({HTMLElement:class{},customElements:{get(){},define(name,type){Panel=type;}},
    Blob,URL:{createObjectURL(){return 'blob:fictional-viewer';},revokeObjectURL(){}},MessageChannel,document,
    addEventListener(){},removeEventListener(){},setTimeout(fn){timers.set(++timer,fn);return timer;},clearTimeout(id){timers.delete(id);}});
  vm.runInContext(source,context);
  const panel=Object.assign(Object.create(Panel.prototype),{generation:1,isConnected:true,serverCanEdit:admin,
    editLocked:false,recovery:null,dryRun,dryRunEpoch:0,mapView:null,viewPreferences:{language:'en'},savedItems:[],
    floor:'fictional_ground',requestedFloor:'fictional_ground',queue:Promise.resolve(),pending:0,tvFrames:{},
    port:makePort(),mapAttributionLink:{hidden:true},ownerDocument:document,notice(){},noticeKey(){},updateAccessUI(){},publishEntityStates(){},
    clearMediaArtwork(){},notifySaveStatus(){},checkDryRunStorage(){},
    $(key){if(!nodes.has(key))nodes.set(key,{hidden:false,classList:{toggle(){}},removeAttribute(name){delete this[name];},
      contentWindow:{postMessage(value,target,transfer){initializations.push({value:plain(value),target,transfer});}}});return nodes.get(key);},
    _hass:{user:{id:'fictional-user',is_admin:admin},connected:true,connection:{connected:true},
      auth:{accessToken:'PRIVATE_FAKE_TOKEN'},states:{},callWS(request){calls.push(plain(request));
        if(callWS)return callWS(request);
        if(request.type==='home_floorplan/viewer')return Promise.resolve({floor:request.floor,floors:['fictional_ground','fictional_upper'],items:[],can_edit:admin,html:'<head></head>'});
        return Promise.resolve(request.type==='home_floorplan/map_tile'?tile():snapshot());}}});
  const send=(value,generation=panel.generation)=>panel.handleViewerMessage({type:'map_request',...value},generation);
  return {panel,messages,calls,initializations,timers,ports,makePort,send};
}

test('get and save whitelist requests and responses; credentials and arbitrary fields stay outside the iframe',async()=>{
  const f=fixture({callWS:async()=>({...snapshot(),token:'PRIVATE_SERVER_TOKEN',config:{...config(),url:'https://secret.invalid'},reference:{latitude:0,longitude:0,secret:'PRIVATE_REFERENCE'}})});
  f.send({request_id:'get-1',action:'get',typeOverride:'arbitrary',url:'https://secret.invalid'});await flush();
  assert.deepEqual(f.calls,[{type:'home_floorplan/map_get'}]);
  assert.deepEqual(f.messages[0],{type:'map_result',request_id:'get-1',success:true,result:snapshot()});
  f.send({request_id:'save-1',action:'save',revision:0,config:{...config(),token:'PRIVATE_REQUEST_TOKEN'}});await flush();
  assert.deepEqual(f.calls[1],{type:'home_floorplan/map_save',revision:0,config:config()});
  assert.doesNotMatch(JSON.stringify(f.messages),/PRIVATE|secret\.invalid|accessToken/);
});

test('map navigation and settings remain available in dry run without enabling device commands',async()=>{
  const f=fixture({dryRun:true});
  f.send({request_id:'read',action:'get'});f.send({type:'map_view',view:navigation()});
  f.send({request_id:'write',action:'save',revision:0,config:config()});await flush();
  assert.deepEqual(f.calls.map(row=>row.type),['home_floorplan/map_get','home_floorplan/map_save']);
  assert.deepEqual(plain(f.panel.mapView),navigation());
  f.send({type:'toggle',request_id:'device',entity_id:'light.fictional'});
  assert.equal(f.messages.at(-1).type,'command_result');assert.equal(f.messages.at(-1).dry_run,true);
  assert.equal(f.calls.length,2);
});

test('only current administrators with an unlocked editable panel may save',async()=>{
  for(const change of [f=>{f.panel._hass.user.is_admin=false;},f=>{f.panel.serverCanEdit=false;},f=>{f.panel.editLocked=true;}]) {
    const f=fixture();change(f);f.send({request_id:'save',action:'save',revision:0,config:config()});await flush();
    assert.equal(f.calls.length,0);assert.equal(f.messages[0].success,false);assert.match(f.messages[0].error,/Administrator/);
  }
  const f=fixture();f.send({request_id:'save',action:'save',revision:0,config:config()});f.panel.editLocked=true;await flush();
  assert.equal(f.calls.length,0,'permission is checked again immediately before dispatch');
});

test('invalid request IDs, actions, tile coordinates and config fields never reach HA',async()=>{
  const f=fixture();
  for(const request_id of ['',null,1,'a'.repeat(65),'../../private','has space'])f.send({request_id,action:'get'});
  assert.equal(f.messages.length,0);
  const bad=[{action:'arbitrary'},{action:'tile',z:20,x:0,y:0},{action:'tile',z:0,x:1,y:0},
    {action:'tile',z:1,x:-1,y:0},{action:'tile',z:1,x:0,y:2},{action:'tile',z:true,x:0,y:0},
    {action:'tile',z:1,x:NaN,y:0},{action:'tile',z:1,x:0,y:.1},
    {action:'save',revision:-1,config:config()},{action:'save',revision:true,config:config()},
    {action:'save',revision:Number.MAX_SAFE_INTEGER+1,config:config()}];
  for(const [key,value]of Object.entries({enabled:1,latitude:85.01,longitude:-181,model_x:10001,model_z:Infinity,north_deg:361}))
    bad.push({action:'save',revision:0,config:{...config(),[key]:value}});
  for(let i=0;i<bad.length;i++)f.send({request_id:'bad-'+i,...bad[i]});await flush();
  assert.equal(f.calls.length,0);assert.equal(f.messages.length,bad.length);assert.ok(f.messages.every(row=>row.success===false));
});

test('tile proxy returns bounded PNG data and fixed attribution, rejecting other formats and oversized responses',async()=>{
  const f=fixture({callWS:async()=>({...tile(),attribution_url:'https://secret.invalid',token:'PRIVATE'})});
  f.send({request_id:'tile',action:'tile',z:19,x:524287,y:524287,url:'https://secret.invalid'});await flush();
  assert.deepEqual(f.calls,[{type:'home_floorplan/map_tile',z:19,x:524287,y:524287}]);
  assert.deepEqual(f.messages[0].result,{...tile(),attribution:'© OpenStreetMap contributors',attribution_url:'https://www.openstreetmap.org/copyright'});
  assert.equal(f.panel.mapAttributionLink.hidden,false);
  f.panel.invalidateViewerLoad();assert.equal(f.panel.mapAttributionLink.hidden,true);
  for(const data_url of ['https://secret.invalid/tile','data:image/svg+xml;base64,AQID','data:image/png;base64,A','data:image/png;base64,A===',
    'data:image/png;base64,'+'A'.repeat(699052),'data:image/png;base64,'+'A'.repeat(699056)]) {
    const bad=fixture({callWS:async()=>({data_url})});bad.send({request_id:'bad',action:'tile',z:0,x:0,y:0});await flush();
    assert.equal(bad.messages[0].success,false);assert.doesNotMatch(JSON.stringify(bad.messages),/secret\.invalid/);
  }
  const max=fixture({callWS:async()=>({data_url:'data:image/png;base64,'+'A'.repeat(699051)+'='})});
  max.send({request_id:'max',action:'tile',z:0,x:0,y:0});await flush();assert.equal(max.messages[0].success,true);
});

test('enabled map exposes the fixed native attribution link without widening the iframe sandbox',async()=>{
  const f=fixture();f.send({request_id:'read',action:'get'});await flush();
  assert.equal(f.panel.mapAttributionLink.hidden,false);
  assert.match(source,/<a id="map-attribution" href="https:\/\/www\.openstreetmap\.org\/copyright" target="_blank" rel="noopener noreferrer" hidden>© OpenStreetMap contributors<\/a>/);
  assert.doesNotMatch(source,/allow-popups/);
  const disabled=fixture({callWS:async()=>({...snapshot(),config:{...config(),enabled:false}})});
  disabled.send({request_id:'read',action:'get'});await flush();assert.equal(disabled.panel.mapAttributionLink.hidden,true);
});

test('invalid snapshots fail closed; an unset config and polar HA reference are valid',async()=>{
  for(const response of [{...snapshot(),revision:-1},{...snapshot(),configured:false},{...snapshot(),config:null},
    {...snapshot(),reference:{latitude:91,longitude:0}},{...snapshot(),config:{...config(),latitude:86}}]) {
    const f=fixture({callWS:async()=>response});f.send({request_id:'read',action:'get'});await flush();assert.equal(f.messages[0].success,false);
  }
  const value={revision:0,configured:false,config:null,reference:{latitude:90,longitude:-180}};
  const f=fixture({callWS:async()=>value});f.send({request_id:'read',action:'get'});await flush();assert.deepEqual(f.messages[0].result,value);
});

test('transport errors are bounded fixed messages and cannot reveal backend URLs or credentials',async()=>{
  for(const code of ['conflict','map_disabled','unauthorized','forbidden','unknown']) {
    const f=fixture({callWS:async()=>{throw {code,message:'PRIVATE https://secret.invalid/?token=PRIVATE'};}});
    f.send({request_id:'read',action:'get'});await flush();assert.equal(f.messages[0].success,false);
    assert.doesNotMatch(JSON.stringify(f.messages),/PRIVATE|secret\.invalid/);assert.ok(f.messages[0].error.length<150);
  }
});

test('tile concurrency and waiting queue are bounded; pending duplicate IDs do not dispatch again',async()=>{
  const waiting=[],f=fixture({callWS(){const request=deferred();waiting.push(request);return request.promise;}});
  for(let i=0;i<80;i++)f.send({request_id:'tile-'+i,action:'tile',z:7,x:i,y:0});
  f.send({request_id:'tile-0',action:'tile',z:0,x:0,y:0});await flush();
  assert.equal(f.calls.length,4);assert.equal(f.panel.mapBridge.tiles,4);assert.equal(f.panel.mapBridge.queue.length,64);
  assert.equal(f.messages.length,12);assert.ok(f.messages.every(row=>row.success===false));
  waiting[0].resolve(tile());await flush();assert.equal(f.calls.length,5);assert.equal(f.panel.mapBridge.tiles,4);
  f.panel.invalidateViewerLoad();assert.equal(f.panel.mapBridge.queue.length,0);assert.equal(f.panel.mapBridge.pending.size,0);
  for(const request of waiting)request.resolve(tile());await flush();assert.equal(f.calls.length,5);assert.equal(f.panel.mapBridge.tiles,0);
});

test('settings calls serialize independently of tile traffic and recheck queued save permission',async()=>{
  const waiting=[],f=fixture({callWS(){const request=deferred();waiting.push(request);return request.promise;}});
  for(let i=0;i<5;i++)f.send({request_id:'tile-'+i,action:'tile',z:3,x:i,y:0});
  f.send({request_id:'get',action:'get'});f.send({request_id:'save',action:'save',revision:0,config:config()});await flush();
  assert.equal(f.calls.length,5);assert.equal(f.panel.mapBridge.settings,1);assert.equal(f.panel.mapBridge.tiles,4);
  f.panel.editLocked=true;waiting[4].resolve(snapshot());await flush();
  assert.equal(f.calls.length,5);assert.equal(f.panel.mapBridge.settings,0);assert.match(f.messages.at(-1).error,/Administrator/);
  f.panel.invalidateViewerLoad();for(const request of waiting)request.resolve(tile());await flush();
});

test('responses from stale generation, port, account, connection or disconnected session are discarded',async()=>{
  for(const change of [f=>{f.panel.generation++;},f=>{f.panel.port=f.makePort();},f=>{f.panel._hass.user.id='different-user';},
    f=>{f.panel._hass.connection={connected:true};},f=>{f.panel._hass.connected=false;},f=>{f.panel._hass.connection.connected=false;},
    f=>{f.panel.isConnected=false;}]) {
    const pending=deferred(),f=fixture({callWS:()=>pending.promise});f.send({request_id:'read',action:'get'});await flush();
    change(f);pending.resolve(snapshot());await flush();assert.equal(f.messages.length,0);assert.equal(f.panel.mapBridge.settings,0);
  }
  const f=fixture();f.send({request_id:'read',action:'get'});f.panel.generation++;await flush();assert.equal(f.calls.length,0);
});

test('floor replacement preserves active limits, clears queued work and allows fresh-frame request IDs',async()=>{
  const waiting=[],f=fixture({callWS(){const request=deferred();waiting.push(request);return request.promise;}});
  f.send({request_id:'same-id',action:'get'});f.send({request_id:'never-dispatch',action:'get'});await flush();
  f.panel.invalidateViewerLoad();f.panel.port=f.makePort();f.send({request_id:'same-id',action:'get'});await flush();
  assert.equal(f.calls.length,1);assert.equal(f.panel.mapBridge.queue.length,1);
  waiting[0].resolve(snapshot());await flush();assert.equal(f.calls.length,2);assert.equal(f.messages.length,0);
  waiting[1].resolve(snapshot());await flush();assert.equal(f.messages.length,1);assert.equal(f.messages[0].request_id,'same-id');
});

test('navigation stores only validated local camera fields and survives floor initialization',async()=>{
  const f=fixture();f.send({type:'map_view',view:{...navigation(),latitude:51,longitude:2,token:'PRIVATE'}});
  assert.deepEqual(plain(f.panel.mapView),navigation());
  for(const [key,value]of Object.entries({mode:'unknown',zoom:0,rotation:7,tilt:1,pan_x:Infinity,pan_y:'20'})) {
    f.send({type:'map_view',view:{...navigation(),[key]:value}});assert.deepEqual(plain(f.panel.mapView),navigation());
  }
  f.send({type:'map_view',view:{...navigation(),zoom:2}},f.panel.generation-1);assert.deepEqual(plain(f.panel.mapView),navigation());
  await f.panel.loadFloor('fictional_upper');f.panel.$('iframe').onload();
  assert.equal(f.initializations.length,1);assert.deepEqual(f.initializations[0].value.map_view,navigation());
  assert.doesNotMatch(JSON.stringify(f.initializations[0].value),/latitude|longitude|PRIVATE/);
  const stalePort=f.panel.port;f.panel.port=f.makePort();stalePort.onmessage({data:{type:'map_view',view:{...navigation(),zoom:2}}});
  assert.deepEqual(plain(f.panel.mapView),navigation(),'obsolete MessagePort cannot update the camera');
  f.panel.disconnectedCallback();assert.equal(f.panel.mapView,null);assert.equal(f.panel.port,null);assert.equal(f.timers.size,0);
});

test('map camera target and vertical span pass through only as a complete bounded local-space triple',async()=>{
  const f=fixture();f.send({type:'map_view',view:{...preciseNavigation(),latitude:51,longitude:2,token:'PRIVATE'}});
  assert.deepEqual(plain(f.panel.mapView),preciseNavigation());
  const invalid=[...Object.entries({mode:'model',target_x:-2000001,target_z:2000001,span_m:40000001}).map(([key,value])=>({...preciseNavigation(),[key]:value})),
    ...[0,.009,Number.MIN_VALUE,-1,NaN,Infinity,'1',null].map(span_m=>({...preciseNavigation(),span_m})),
    ...['target_x','target_z','span_m'].map(key=>{const view=preciseNavigation();delete view[key];return view;}),
    ...['target_x','target_z','span_m'].map(key=>({...navigation(),[key]:preciseNavigation()[key]}))];
  for(const view of invalid){f.send({type:'map_view',view});assert.deepEqual(plain(f.panel.mapView),preciseNavigation());}
  const edge={...preciseNavigation(),target_x:-2000000,target_z:2000000,span_m:40000000};
  f.send({type:'map_view',view:edge});assert.deepEqual(plain(f.panel.mapView),edge);
  f.send({type:'map_view',view:{...edge,span_m:.01}});assert.equal(f.panel.mapView.span_m,.01);
  f.send({type:'map_view',view:preciseNavigation()});
  await f.panel.loadFloor('fictional_upper');f.panel.$('iframe').onload();
  assert.deepEqual(f.initializations[0].value.map_view,preciseNavigation());
  assert.doesNotMatch(JSON.stringify(f.initializations[0].value),/latitude|longitude|PRIVATE/);
  f.send({type:'map_view',view:{...navigation(),mode:'model'}});
  assert.deepEqual(plain(f.panel.mapView),{...navigation(),mode:'model'},'legacy navigation without the optional triple remains valid');
});

test('real opaque iframe exchanges map reads, preview tiles, revisioned saves and role failures over MessageChannel',async()=>{
  const http=require('node:http'),{chromium}=require('playwright');
  const server=http.createServer((request,response)=>{
    if(request.url==='/panel.js'){response.writeHead(200,{'content-type':'text/javascript'});response.end(source);return;}
    if(request.url==='/'){response.writeHead(200,{'content-type':'text/html'});response.end('<!doctype html><html><head><meta charset="utf-8"><script src="/panel.js"></script></head><body></body></html>');return;}
    response.writeHead(404);response.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    const origin='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
    const context=await browser.newContext(),requests=[],errors=[];
    await context.route('**/*',route=>{
      const url=route.request().url();requests.push(url);
      return url.startsWith(origin+'/')?route.continue():route.abort();
    });
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);
    const viewer='<!doctype html><html><head><meta charset="utf-8"></head><body><p>Fictional map bridge fixture</p><script>'+`\n
      window.received=[];
      addEventListener('message',event=>{
        if(event.source!==parent||event.data?.type!=='home-floorplan:init'||window.port)return;
        window.initial=event.data;window.port=event.ports[0];
        port.onmessage=event=>received.push(event.data);
        port.postMessage({type:'model_config',model_id:'fictional_model'});
      });`+'</script></body></html>';
    await page.evaluate(({viewer})=>{
      window.fake={calls:[],revision:0,config:null,failure:null,services:[]};
      window.fakeConnection={connected:true};
      window.makeHass=admin=>({user:{id:admin?'fixture-admin':'fixture-family',is_admin:admin},
        connected:true,connection:fakeConnection,states:{},auth:{accessToken:'PRIVATE_BROWSER_TOKEN'},
        callService:async(...args)=>fake.services.push(args),
        callWS:async request=>{
          fake.calls.push(structuredClone(request));
          if(request.type==='home_floorplan/viewer')return {html:viewer,floor:request.floor||'ground',floors:['ground','upper'],items:[],revision:0,can_edit:admin,site_features:false};
          if(fake.failure)throw {code:fake.failure,message:'PRIVATE_BACKEND_ERROR https://private.invalid'};
          const snapshot=()=>({revision:fake.revision,configured:fake.config!==null,config:fake.config,reference:{latitude:0,longitude:0},private:'PRIVATE_RESPONSE'});
          if(request.type==='home_floorplan/map_get')return snapshot();
          if(request.type==='home_floorplan/map_tile'){
            if(!admin&&!fake.config?.enabled)throw {code:'map_disabled'};
            return {data_url:'data:image/png;base64,AQID',private:'PRIVATE_TILE'};
          }
          if(request.type==='home_floorplan/map_save'){
            if(!admin)throw {code:'unauthorized'};
            if(request.revision!==fake.revision)throw {code:'conflict'};
            fake.config=request.config;fake.revision++;return snapshot();
          }
          throw Error('Unexpected fake API operation');
        }});
      window.panel=document.createElement('home-floorplan-panel');panel.hass=makeHass(true);document.body.append(panel);
    },{viewer});
    const iframe=page.locator('home-floorplan-panel iframe');
    const frame=await(await iframe.elementHandle()).contentFrame();
    await frame.waitForFunction(()=>!!window.initial);
    assert.equal(await frame.evaluate(()=>{try{return !!parent.fake;}catch(error){return error.name;}}),'SecurityError');
    assert.equal(await iframe.getAttribute('sandbox'),'allow-scripts allow-downloads allow-forms');
    const exchange=async request=>{
      await frame.evaluate(request=>port.postMessage({type:'map_request',...request}),request);
      await frame.waitForFunction(id=>received.some(row=>row.type==='map_result'&&row.request_id===id),request.request_id);
      return frame.evaluate(id=>received.find(row=>row.type==='map_result'&&row.request_id===id),request.request_id);
    };
    const unset=await exchange({request_id:'unset',action:'get'});
    assert.equal(unset.success,true);assert.equal(unset.result.configured,false);assert.equal(unset.result.config,null);
    assert.equal((await exchange({request_id:'preview',action:'tile',z:0,x:0,y:0})).success,true);
    const attribution=page.locator('home-floorplan-panel #map-attribution');await attribution.waitFor({state:'visible'});
    assert.equal(await attribution.getAttribute('href'),'https://www.openstreetmap.org/copyright');
    const popupPromise=page.waitForEvent('popup');await attribution.click();const popup=await popupPromise;await popup.close();
    assert.deepEqual(requests.filter(url=>new URL(url).origin!==origin),['https://www.openstreetmap.org/copyright'],'native attribution opens exactly the fixed URL; test transport blocks outbound traffic');
    const saved=await exchange({request_id:'save',action:'save',revision:0,config:config()});assert.equal(saved.result.revision,1);
    const conflict=await exchange({request_id:'conflict',action:'save',revision:0,config:config()});assert.equal(conflict.success,false);assert.match(conflict.error,/changed/);
    await frame.evaluate(view=>port.postMessage({type:'map_view',view}),preciseNavigation());
    await page.waitForFunction(()=>panel.mapView?.zoom===.1);
    await frame.evaluate(()=>port.postMessage({type:'floor',floor:'upper'}));
    await page.waitForFunction(()=>panel.floor==='upper');await frame.waitForFunction(()=>window.initial?.map_view?.zoom===.1);
    assert.deepEqual(await frame.evaluate(()=>initial.map_view),preciseNavigation());
    for(const failure of ['unknown_command','not_loaded']) {
      await page.evaluate(failure=>fake.failure=failure,failure);
      const missing=await exchange({request_id:failure,action:'get'});assert.equal(missing.success,false);assert.doesNotMatch(missing.error,/PRIVATE|private\.invalid/);
    }
    await page.evaluate(()=>fake.failure=null);
    assert.equal((await exchange({request_id:'disable',action:'save',revision:1,config:{...config(),enabled:false}})).success,true);
    await page.evaluate(()=>{panel.hass=makeHass(false);});
    await frame.waitForFunction(()=>window.initial?.can_edit===false);
    assert.equal(await iframe.getAttribute('sandbox'),'allow-scripts');
    assert.equal((await exchange({request_id:'family-get',action:'get'})).result.config.enabled,false);
    assert.equal((await exchange({request_id:'family-tile',action:'tile',z:0,x:0,y:0})).success,false);
    const before=await page.evaluate(()=>fake.calls.length);
    assert.equal((await exchange({request_id:'family-save',action:'save',revision:2,config:config()})).success,false);
    assert.equal(await page.evaluate(()=>fake.calls.length),before,'host rejects family save before the API');
    await page.evaluate(()=>{fake.config.enabled=true;});
    assert.equal((await exchange({request_id:'family-enabled',action:'tile',z:0,x:0,y:0})).success,true);
    assert.doesNotMatch(await frame.evaluate(()=>JSON.stringify({initial,received})),/PRIVATE|accessToken|private\.invalid/);
    assert.deepEqual(await page.evaluate(()=>fake.services),[]);assert.deepEqual(errors,[]);
    assert.ok(requests.every(url=>url.startsWith(origin+'/')||url==='https://www.openstreetmap.org/copyright'));
    await context.close();
  } finally {
    await browser?.close();await new Promise(resolve=>server.close(resolve));
  }
});
