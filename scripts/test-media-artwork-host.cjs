// Actual host code, fake HA authentication and browser images: no network or devices.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../custom_components/home_floorplan/static/panel.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const flush=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
const chunk=(type,data)=>{const result=Buffer.alloc(data.length+12);result.writeUInt32BE(data.length);result.write(type,4);Buffer.from(data).copy(result,8);return result;};
function png(width=1200,height=800,animated=false){
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),...(animated?[chunk('acTL',Buffer.alloc(8))]:[]),chunk('IDAT',Buffer.from([1,2,3])),chunk('IEND',Buffer.alloc(0))]);
}
function jpeg(width=100,height=100){
  const bytes=Buffer.from([255,216,255,192,0,8,8,0,0,0,0,1,255,218,0,2,255,217]);
  bytes.writeUInt16BE(height,7);bytes.writeUInt16BE(width,9);return bytes;
}
function webp(width=100,height=100,animated=false){
  const bytes=Buffer.alloc(30);bytes.write('RIFF');bytes.writeUInt32LE(22,4);bytes.write('WEBPVP8X',8);bytes.writeUInt32LE(10,16);
  bytes[20]=animated?2:0;bytes.writeUIntLE(width-1,24,3);bytes.writeUIntLE(height-1,27,3);return bytes;
}
function response(bytes=png(),mime='image/png',headers={}){
  return new Response(bytes,{status:200,headers:{'content-type':mime,...headers}});
}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture({fetch,decode=false,output='data:image/jpeg;base64,AQID',imageWidth=1200,imageHeight=800}={}){
  let Panel,nextTimer=0;const messages=[],calls=[],timers=new Map(),urls=[],images=[],canvases=[];
  class Image {
    constructor(){this.naturalWidth=imageWidth;this.naturalHeight=imageHeight;images.push(this);}
    set src(value){this.url=value;if(!decode)queueMicrotask(()=>this.onload?.());}
    removeAttribute(){this.url=null;}
  }
  const document={hidden:false,removeEventListener(){},createElement(type){assert.equal(type,'canvas');
    const canvas={width:0,height:0,getContext(){return {fillRect(){},drawImage(image,x,y,width,height){canvas.drawn={width,height};}};},toDataURL(mime,quality){assert.equal(mime,'image/jpeg');assert.equal(quality,.8);return output;}};
    canvases.push(canvas);return canvas;}};
  const context=vm.createContext({HTMLElement:class{},customElements:{get(){},define(name,value){Panel=value;}},
    AbortController,Blob,Response,Uint8Array,DataView,URL:{createObjectURL(){const url='blob:private-'+urls.length;urls.push({url,revoked:false});return url;},revokeObjectURL(url){urls.find(row=>row.url===url).revoked=true;}},
    document,Image,setTimeout(fn){const id=++nextTimer;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);},removeEventListener(){}});
  vm.runInContext(source,context);
  const iframe={src:'blob:viewer',srcdoc:'viewer',removeAttribute(name){delete this[name];}};
  const panel=Object.assign(Object.create(Panel.prototype),{generation:1,isConnected:true,modelConfigured:true,siteFeatures:false,tvFrames:{},savedItems:[{id:'speaker',entity_id:'media_player.study'}],
    shadowRoot:{querySelector(){return iframe;}},
    port:{postMessage(message){messages.push(plain(message));},close(){}},
    _hass:{connected:true,states:{'media_player.study':{state:'playing',attributes:{entity_picture:'https://untrusted.invalid/image?token=PRIVATE',media_title:'First track',media_artist:'Artist'}}},
      fetchWithAuth(url,options){calls.push({url,options});return fetch?fetch(url,options):Promise.resolve(response());}}});
  return {panel,messages,calls,timers,urls,images,canvases,document,context,iframe,
    expire(){for(const [id,fn]of [...timers]){timers.delete(id);fn();}},
    dimensions:(bytes,mime)=>plain(context.mediaArtworkDimensions(bytes,mime)),
    read:(reply,signal=new AbortController().signal)=>context.readMediaArtwork(reply,signal)};
}

test('fetch uses only canonical authenticated proxy and sends a bounded JPEG with opaque identity',async()=>{
  const f=fixture();f.panel.refreshMediaArtwork();await flush();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'/api/media_player_proxy/media_player.study');
  assert.equal(f.calls[0].options.redirect,'error');assert.equal(f.calls[0].options.cache,'no-store');assert.ok(f.calls[0].options.signal instanceof AbortSignal);
  const entry=f.messages.at(-1).artwork.speaker;
  assert.deepEqual(entry,{entity_id:'media_player.study',identity:'artwork-1',image:'data:image/jpeg;base64,AQID'});
  assert.doesNotMatch(JSON.stringify(f.messages),/PRIVATE|untrusted|First track/);
  assert.deepEqual(f.canvases[0].drawn,{width:512,height:341});assert.equal(f.canvases[0].width,0);
  assert.ok(f.urls.every(url=>url.revoked));assert.equal(f.timers.size,0);assert.equal(f.panel.mediaArtworkRequests,0);
});

test('identity ignores playback progress and deduplicates updates and duplicate saved bindings',async()=>{
  const f=fixture();f.panel.savedItems.push({id:'second',entity_id:'media_player.study'});f.panel.refreshMediaArtwork();await flush();
  assert.equal(f.calls.length,1);assert.deepEqual(Object.keys(f.messages.at(-1).artwork),['speaker','second']);
  const count=f.messages.length;
  for(let i=0;i<20;i++){f.panel._hass.states['media_player.study'].attributes.media_position=i;f.panel.refreshMediaArtwork();}
  await flush();assert.equal(f.calls.length,1);assert.equal(f.messages.length,count);
});

test('only saved valid active media bindings fetch; private TV snapshots retain priority',async()=>{
  const f=fixture();f.panel.siteFeatures=true;f.panel.tvFrames.speaker={entity_id:'media_player.study'};
  f.panel.savedItems.push({id:'wrong',entity_id:'light.study'},{id:'traversal',entity_id:'media_player.../secret'},{id:'missing',entity_id:'media_player.missing'});
  f.panel.refreshMediaArtwork();await flush();assert.equal(f.calls.length,0);
  f.panel.siteFeatures=false;
  for(const state of ['off','unknown','unavailable','standby']){f.panel._hass.states['media_player.study'].state=state;f.panel.refreshMediaArtwork();}
  f.panel._hass.states['media_player.study'].state='playing';f.panel._hass.states['media_player.study'].attributes.restored=true;f.panel.refreshMediaArtwork();
  await flush();assert.equal(f.calls.length,0);
  delete f.panel._hass.states['media_player.study'].attributes.restored;delete f.panel._hass.states['media_player.study'].attributes.entity_picture;
  f.panel.refreshMediaArtwork();await flush();assert.equal(f.calls.length,0);
});

test('identity changes clear immediately and late old responses cannot replace the new track',async()=>{
  const pending=[];const f=fixture({fetch(){const request=deferred();pending.push(request);return request.promise;}});
  f.panel.refreshMediaArtwork();pending[0].resolve(response());await flush();assert.ok(f.messages.at(-1).artwork.speaker);
  f.panel._hass.states['media_player.study'].attributes.media_title='Next track';f.panel.refreshMediaArtwork();
  assert.deepEqual(f.messages.at(-1).artwork,{});await flush();
  f.panel._hass.states['media_player.study'].attributes.entity_picture='/new?token=SECRET';f.panel.refreshMediaArtwork();
  assert.equal(f.calls[1].options.signal.aborted,true);await flush();
  pending[2].resolve(response());await flush();const current=f.messages.at(-1).artwork.speaker;
  pending[1].resolve(response());await flush();assert.deepEqual(f.messages.at(-1).artwork.speaker,current);assert.equal(current.identity,'artwork-3');
});

test('off, disconnect, rebinding and hidden documents clear and abort outstanding work',async()=>{
  for(const change of [f=>f.panel._hass.states['media_player.study'].state='off',f=>f.panel._hass.connected=false,
    f=>f.panel.savedItems[0].entity_id='media_player.other',f=>f.document.hidden=true]){
    const pending=deferred(),f=fixture({fetch:()=>pending.promise});f.panel.refreshMediaArtwork();change(f);f.panel.refreshMediaArtwork();
    assert.equal(f.calls[0].options.signal.aborted,true);assert.deepEqual(f.messages.at(-1).artwork,{});
    pending.resolve(response());await flush();assert.deepEqual(f.messages.at(-1).artwork,{});assert.equal(f.panel.mediaArtworkRequests,0);
  }
});

test('detach and floor generation changes discard old decoded images and release resources',async()=>{
  const f=fixture({decode:true});f.panel.refreshMediaArtwork();await flush();assert.equal(f.images.length,1);
  f.panel.isConnected=false;f.panel.disconnectedCallback();await flush();
  assert.equal(f.images[0].url,null);assert.ok(f.urls[0].revoked);assert.equal(f.panel.mediaArtworkRequests,0);
  assert.deepEqual(f.messages.at(-1).artwork,{});assert.equal(f.panel.port,null);
  assert.equal(f.iframe.src,undefined);assert.equal(f.iframe.srcdoc,undefined);
});

test('account or HA connection changes invalidate both cached art and in-flight old-session responses',async()=>{
  for(const change of [hass=>({...hass,user:{id:'account-b'}}),hass=>({...hass,connection:{}})]){
    const pending=[],f=fixture({fetch(){const request=deferred();pending.push(request);return request.promise;}});
    f.panel._hass.user={id:'account-a'};f.panel._hass.connection={};f.panel.started=true;f.panel.viewPreferences={};
    f.panel.publishEntityStates=()=>f.panel.refreshMediaArtwork();
    f.panel.refreshMediaArtwork();pending[0].resolve(response());await flush();
    const old=f.messages.at(-1).artwork.speaker.identity;
    f.panel.hass=change(f.panel._hass);assert.deepEqual(f.messages.at(-1).artwork,{});await flush();
    f.panel.hass={...f.panel._hass,user:{id:'account-c'},connection:{}};await flush();
    pending[1].resolve(response());await flush();assert.deepEqual(f.messages.at(-1).artwork,{});
    pending[2].resolve(response());await flush();assert.notEqual(f.messages.at(-1).artwork.speaker.identity,old);
  }
});

test('bounded queue caps concurrent fetches and saved artwork entries without polling or retry storms',async()=>{
  const pending=[],f=fixture({fetch(){const request=deferred();pending.push(request);return request.promise;}});
  f.panel.savedItems=[];f.panel._hass.states={};
  for(let i=0;i<30;i++){
    const entity_id='media_player.player_'+i;f.panel.savedItems.push({id:'item_'+i,entity_id});f.panel._hass.states[entity_id]={state:'playing',attributes:{entity_picture:'/image'}};
  }
  f.panel.refreshMediaArtwork();assert.equal(f.calls.length,2);assert.equal(f.panel.mediaArtwork.size,16);
  for(let i=0;i<16;i++){pending[i].reject(Error('missing'));await flush();assert.ok(f.panel.mediaArtworkRequests<=2);}
  assert.equal(f.calls.length,16);assert.equal(f.panel.mediaArtworkRequests,0);assert.equal(f.timers.size,0);
  for(let i=0;i<10;i++)f.panel.refreshMediaArtwork();await flush();assert.equal(f.calls.length,16);
});

test('request and decoder deadlines abort and clean up even when auth transport ignores its signal',async()=>{
  const waiting=deferred(),f=fixture({fetch:()=>waiting.promise});f.panel.refreshMediaArtwork();f.expire();await flush();
  assert.equal(f.calls[0].options.signal.aborted,true);assert.equal(f.panel.mediaArtworkRequests,0);assert.equal(f.calls.length,1);
  waiting.resolve(response());await flush();assert.equal(f.images.length,0);
  const g=fixture({decode:true});g.panel.refreshMediaArtwork();await flush();g.expire();await flush();
  assert.equal(g.images[0].url,null);assert.ok(g.urls[0].revoked);assert.equal(g.panel.mediaArtworkRequests,0);
});

test('streaming reader rejects oversized, unsupported and redirected bodies before decoding',async()=>{
  const f=fixture();
  await assert.rejects(f.read(response(png(),'image/svg+xml')),/Unsupported/);
  await assert.rejects(f.read(response(png(),'image/png',{'content-length':'2097153'})),/Unsupported/);
  await assert.rejects(f.read(response(png(),'image/png',{'content-length':'invalid'})),/Unsupported/);
  const redirected=response();Object.defineProperty(redirected,'redirected',{value:true});await assert.rejects(f.read(redirected),/Unsupported/);
  let cancelled=false;
  const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(1048576));controller.enqueue(new Uint8Array(1048577));},cancel(){cancelled=true;}});
  await assert.rejects(f.read(new Response(stream,{headers:{'content-type':'image/png'}})),/too large/);assert.equal(cancelled,true);
  assert.equal(f.images.length,0);
});

test('raster headers reject huge dimensions, animated PNG/WebP, GIF, SVG and malformed images',()=>{
  const f=fixture();assert.deepEqual(f.dimensions(png(),'image/png'),{width:1200,height:800});
  assert.deepEqual(f.dimensions(jpeg(),'image/jpeg'),{width:100,height:100});assert.deepEqual(f.dimensions(webp(),'image/webp'),{width:100,height:100});
  for(const [bytes,mime]of [[png(4097,1),'image/png'],[png(4096,4096),'image/png'],[png(10,10,true),'image/png'],[webp(10,10,true),'image/webp'],
    [Buffer.from('<svg/>'),'image/svg+xml'],[Buffer.from('GIF89a'),'image/gif'],[Buffer.from([255,216,255,192]),'image/jpeg'],[png().subarray(0,40),'image/png']])assert.throws(()=>f.dimensions(bytes,mime));
});

test('invalid decoder dimensions and oversized normalized output never reach the sandbox',async()=>{
  for(const options of [{imageWidth:50000},{output:'data:image/jpeg;base64,'+'A'.repeat(250000)}]){
    const f=fixture(options);f.panel.refreshMediaArtwork();await flush();assert.deepEqual(f.messages.at(-1).artwork,{});assert.ok(f.urls.every(url=>url.revoked));
  }
});

test('state projection exposes bounded media captions only for saved media players',()=>{
  const f=fixture();f.panel.refreshTVFrame=()=>{};f.panel.refreshCameraFrames=()=>{};f.panel.refreshMediaArtwork=()=>{};
  f.panel.curtains={profiles:{},power:{},memory:{}};
  f.panel._hass.states['media_player.study'].attributes.media_title='x'.repeat(300);
  f.panel._hass.states['media_player.study'].attributes.media_album_name={unsafe:true};
  f.panel._hass.states['media_player.unbound']={state:'playing',attributes:{media_title:'Private unrelated title',entity_picture:'PRIVATE'}};
  f.panel.publishEntityStates();const states=f.messages.at(-1).states;
  assert.equal(states['media_player.study'].media.title.length,200);assert.equal(states['media_player.study'].media.album,'');
  assert.equal(states['media_player.unbound'].media,undefined);assert.doesNotMatch(JSON.stringify(states),/PRIVATE|untrusted|entity_picture/);
});
