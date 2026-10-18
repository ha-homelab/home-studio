// Real generated viewer + Lovelace card + authenticated host, using only fictional local data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const {spawnSync} = require('node:child_process');
const playwright = require('playwright');
const {browserLaunchOptions} = require('./browser-stability-diagnostics.cjs');
const root = path.resolve(process.env.MEDIA_ARTWORK_SOURCE_ROOT || path.join(__dirname,'..'));
const engine = process.env.MEDIA_ARTWORK_ENGINE || 'chromium';
assert(['chromium','firefox','webkit'].includes(engine),'Unsupported browser engine');
const work = fs.mkdtempSync(path.join(os.tmpdir(),'home-studio-media-browser-'));
const artifacts = path.resolve(process.env.MEDIA_ARTWORK_ARTIFACTS || path.join(work,'artifacts'));
fs.mkdirSync(artifacts,{recursive:true});

// A deterministic, valid PNG exercises native image decode and host JPEG normalization.
function coverPNG(color) {
  const chunk = (name,data) => {
    const type = Buffer.from(name), bytes = Buffer.concat([type,data]);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit=0;bit<8;bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    const result = Buffer.alloc(data.length+12);
    result.writeUInt32BE(data.length); bytes.copy(result,4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0,data.length+8);
    return result;
  };
  const width=240,height=240,header=Buffer.alloc(13),pixels=Buffer.alloc(height*(width*3+1));
  header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
    const distance=Math.hypot(x-width/2,y-height/2),stripe=Math.floor(distance/18)%2;
    const shade=stripe?.6:1,index=y*(width*3+1)+1+x*3;
    for(let component=0;component<3;component++)pixels[index+component]=Math.round(color[component]*shade);
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
const covers={a:coverPNG([234,159,64]),b:coverPNG([180,75,120]),c:coverPNG([59,190,175]),d:coverPNG([74,104,210])};
const project=JSON.parse(fs.readFileSync(path.join(root,'planner/example-home.json'),'utf8'));
project.title='Fictional music cottage';
project.floors[0].items.push(
  {id:'speaker',name:'Study speaker',type:'appliance',room:'studio',position_m:{x:6.4,y:.8,z:1.3},dimensions_m:{width:.3,depth:.25,height:.4},rotation_deg:0,entity_id:'media_player.study',notes:'Fictional media player'},
  {id:'private_tv',name:'Private TV',type:'tv',room:'living',position_m:{x:.5,y:1,z:2},dimensions_m:{width:1,depth:.12,height:.6},rotation_deg:90,entity_id:'media_player.private_tv',notes:'Fictional private snapshot adapter'});
const projectPath=path.join(work,'project.json'),output=path.join(work,'compiled');
fs.writeFileSync(projectPath,JSON.stringify(project));
const compiled=spawnSync(process.env.PYTHON || 'python3',[path.join(root,'scripts/build-planner-project.py'),'--project',projectPath,'--output',output],{cwd:root,encoding:'utf8'});
assert.equal(compiled.status,0,compiled.stderr || compiled.stdout);
let viewer=fs.readFileSync(path.join(output,'main/index.html'),'utf8');
const model=JSON.parse(fs.readFileSync(path.join(output,'main/model-data.json'),'utf8'));
// Exercise the documented optional private-TV binding with the same generated runtime.
model.tv_entities={private_tv:'media_player.private_tv'};model.site_features=true;
viewer=viewer.replace(/(<script id="modelData" type="application\/json">)[\s\S]*?(<\/script>)/,
  (_,start,end)=>start+JSON.stringify(model).replaceAll('<','\\u003c')+end);
viewer=viewer.replace('<head>','<head><script>window.__HOME_FLOORPLAN_EMBED__=true;</script>');
const js=value=>JSON.stringify(value).replaceAll('<','\\u003c');
const html=`<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:24px;background:#e8edf0;font:15px system-ui;color:#1b2d38}main{max-width:1400px;margin:auto}
  h1{font-size:24px;margin:0 0 4px}p{margin:0 0 16px;color:#52606d}
</style></head><body><main><h1>Fictional music cottage</h1><p>Local dashboard fixture · synthetic cover art · no real Home Assistant connection</p><home-floorplan-card></home-floorplan-card></main><script type="module">
import '/home-floorplan-static/card.js';
window.card=document.querySelector('home-floorplan-card');
window.calls=[];window.artRequests=[];window.deferred=[];window.subscriptions=0;window.track='a';window.holdNext=false;
window.hostMessages=[];const send=MessagePort.prototype.postMessage;
MessagePort.prototype.postMessage=function(message,...options){hostMessages.push(message);return send.call(this,message,...options);};
window.haConnection={subscribeMessage:async()=>{subscriptions++;return()=>subscriptions--;}};
window.media={state:'playing',attributes:{friendly_name:'Study speaker',entity_picture:'https://untrusted.invalid/cover?token=PRIVATE_SOURCE_TOKEN',
  media_content_id:'a',media_title:'Golden hour',media_artist:'Example ensemble',media_album_name:'Fictional sessions'}};
window.makeHass=()=>({user:{id:'local-fixture-admin',is_admin:true},connected:true,locale:{language:'en'},connection:haConnection,
  states:{'media_player.study':media,'media_player.private_tv':{state:'playing',attributes:{source:'Fixture',entity_picture:'https://untrusted.invalid/private?token=PRIVATE_TV_TOKEN',media_title:'Private source'}}},
  callWS:async message=>{calls.push(message);if(message.type==='home_floorplan/viewer')return {html:${js(viewer)},floor:'main',floors:['main'],site_features:true,revision:0,items:${js(model.inventory)}};
    if(message.type==='home_floorplan/tv_frame')return {image:null};throw Error('Unexpected fixture command: '+message.type);},
  fetchWithAuth:async(url,options)=>{
    const entry={url,options,track,held:holdNext};holdNext=false;artRequests.push(entry);
    // The synthetic auth marker only exists in the trusted host. Deliberately ignore
    // abort for held replies so a late HTTP response must still be discarded.
    const response=await fetch(url,{...options,signal:entry.held?undefined:options.signal,
      headers:{...options.headers,'X-Fixture-Auth':'local-only','X-Fixture-Track':entry.track}});
    if(!entry.held)return response;
    return await new Promise(resolve=>deferred.push({entry,release:()=>resolve(response)}));
  },callService:async()=>{throw Error('The browser regression must not send device commands.');}});
window.publish=()=>{card.hass=makeHass();};
window.changeTrack=(next,title)=>{track=next;media={...media,state:'playing',attributes:{...media.attributes,media_content_id:next,media_title:title}};publish();};
card.setConfig({floor:'main',height:850,dry_run:true});publish();window.ready=true;
</script></body></html>`;

(async()=>{
  const incoming=[];
  const server=http.createServer((request,response)=>{
    const url=new URL(request.url,'http://localhost');
    if(['/home-floorplan-static/card.js','/home-floorplan-static/panel.js'].includes(url.pathname)){
      response.setHeader('Content-Type','text/javascript');response.end(fs.readFileSync(path.join(root,'custom_components/home_floorplan/static',path.basename(url.pathname))));
    }else if(url.pathname==='/api/media_player_proxy/media_player.study'){
      incoming.push({url:request.url,auth:request.headers['x-fixture-auth'],track:request.headers['x-fixture-track']});
      const cover=covers[request.headers['x-fixture-track']];
      response.writeHead(200,{'Content-Type':'image/png','Content-Length':cover.length,'Cache-Control':'no-store'});response.end(cover);
    }else if(url.pathname==='/'){
      response.setHeader('Content-Type','text/html');response.end(html);
    }else{response.writeHead(404);response.end();}
  });
  let browser;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${server.address().port}`;
    browser=await playwright[engine].launch(browserLaunchOptions(engine,true));
    const page=await browser.newPage({viewport:{width:1460,height:970}}),errors=[],external=[];
    page.setDefaultTimeout(20000);
    page.on('pageerror',error=>errors.push(String(error)));
    page.on('request',request=>{if(/^https?:/.test(request.url())&&!request.url().startsWith(origin+'/'))external.push(request.url());});
    await page.goto(origin);await page.waitForFunction(()=>window.ready&&card._panel?.modelConfigured);
    assert.equal(await page.evaluate(()=>card._panel.inventoryModel),'main','generated viewer sends its inventory model ID');
    const frame=page.frames().find(frame=>frame.parentFrame());
    const image=frame.locator('[data-tv-preview="speaker"] img');
    const status=frame.locator('[data-tv-preview="speaker"] .tv-preview-status');
    await frame.waitForFunction(()=>document.querySelector('[data-tv-preview="speaker"] img')?.getAttribute('src')?.startsWith('data:image/jpeg;base64,'));
    await frame.locator('#homeZoomOut').click();
    assert.equal(await image.isVisible(),true,'cover is presented in the actual 3D callout');
    const first=await image.getAttribute('src');
    assert.equal(await status.textContent(),'Golden hour · Example ensemble · Fictional sessions');
    assert.equal(await frame.evaluate(()=>window.origin),'null');
    assert.equal(await frame.evaluate(()=>document.querySelector('[data-tv-preview="speaker"] img').naturalWidth),240);
    assert.doesNotMatch(await page.evaluate(()=>JSON.stringify(hostMessages)),/PRIVATE_SOURCE_TOKEN|PRIVATE_TV_TOKEN|untrusted\.invalid/);
    assert.deepEqual(incoming,[{url:'/api/media_player_proxy/media_player.study',auth:'local-only',track:'a'}]);
    assert.deepEqual(await page.evaluate(()=>artRequests.map(({url,options})=>({url,method:options.method,redirect:options.redirect,cache:options.cache}))),
      [{url:'/api/media_player_proxy/media_player.study',method:'GET',redirect:'error',cache:'no-store'}]);
    assert.equal(await page.evaluate(()=>calls.filter(call=>call.type==='home_floorplan/tv_frame').length),1,'private TV retains its snapshot adapter');
    await page.screenshot({path:path.join(artifacts,engine+'-media-artwork.png')});

    // Progress-only updates and idle time do not schedule repeated artwork requests.
    await page.evaluate(()=>{for(let index=0;index<25;index++){media={...media,attributes:{...media.attributes,media_position:index}};publish();}});
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(()=>artRequests.length),1);

    // A late reply for an intermediate track cannot replace the current cover.
    await page.evaluate(()=>{holdNext=true;changeTrack('b','Intermediate track');});
    await page.waitForFunction(()=>deferred.length===1);
    await frame.waitForFunction(()=>!document.querySelector('[data-tv-preview="speaker"] img').hasAttribute('src'));
    const hostile='<img src=x onerror="window.untrustedMetadataRan=true">';
    await page.evaluate(title=>changeTrack('c',title),hostile);
    await frame.waitForFunction(previous=>{const image=document.querySelector('[data-tv-preview="speaker"] img');return image.getAttribute('src')?.startsWith('data:image/jpeg;base64,')&&image.getAttribute('src')!==previous;},first);
    const current=await image.getAttribute('src');
    assert.equal(await status.textContent(),hostile+' · Example ensemble · Fictional sessions');
    assert.equal(await status.locator('*').count(),0,'metadata is text, never HTML');
    assert.equal(await frame.evaluate(()=>window.untrustedMetadataRan),undefined);
    assert.equal(await page.evaluate(()=>artRequests[1].options.signal.aborted),true);
    await page.evaluate(()=>deferred[0].release());await page.waitForTimeout(100);
    assert.equal(await image.getAttribute('src'),current);

    await page.evaluate(()=>{media={...media,state:'off'};publish();});
    await frame.waitForFunction(()=>!document.querySelector('[data-tv-preview="speaker"] img').hasAttribute('src'));
    assert.equal(await image.isVisible(),false);assert.equal(await status.textContent(),'Media player is off');
    assert.equal(await page.evaluate(()=>artRequests.length),3);

    // Removing the card cancels even an HTTP implementation that resolves after abort.
    await page.evaluate(()=>{holdNext=true;changeTrack('d','Removed card');});
    await page.waitForFunction(()=>deferred.length===2);
    await page.evaluate(()=>{window.detachedPanel=card._panel;card.remove();});
    assert.equal(await page.locator('iframe').count(),0);
    assert.deepEqual(await page.evaluate(()=>[detachedPanel.port,detachedPanel.viewerURL,detachedPanel.mediaArtwork.size,subscriptions,artRequests[3].options.signal.aborted]),[null,null,0,0,true]);
    await page.evaluate(()=>deferred[1].release());
    await page.waitForFunction(()=>detachedPanel.mediaArtworkRequests===0);
    assert.equal(await page.evaluate(()=>detachedPanel.mediaArtwork.size),0);
    assert.equal(incoming.length,4);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
    console.log(`PASS (${engine}): real generated viewer/card, authenticated canonical proxy, native PNG/JPEG decode, private TV isolation, literal metadata, no progress polling, stale replies, off and removal cleanup. Screenshot: ${path.join(artifacts,engine+'-media-artwork.png')}`);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
