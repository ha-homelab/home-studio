// Real locally shipped MapLibre + module worker + synthetic MVT. No map network.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const crypto=require('node:crypto');
const vendor=path.join(root,'custom_components/home_floorplan/static/vendor');
const manifest=JSON.parse(fs.readFileSync(path.join(vendor,'maplibre-manifest.json'),'utf8'));
for(const [name,expected] of Object.entries(manifest.files)){
 const body=fs.readFileSync(path.join(vendor,name));assert.equal(body.length,expected.bytes);
 assert.equal(crypto.createHash('sha256').update(body).digest('hex'),expected.sha256);
}
assert.equal(manifest.version,'6.17.0');
const vint=n=>{const bytes=[];do{let b=n&127;n>>>=7;bytes.push(b|(n?128:0));}while(n);return Buffer.from(bytes);};
const field=(n,wire,data)=>Buffer.concat([vint(n*8+wire),wire===2?vint(data.length):Buffer.alloc(0),data]);
const str=s=>Buffer.from(s);
const zz=n=>n<0?-n*2-1:n*2;
function layer(name,kind,geometry,keys=[],values=[]){
  const tags=keys.flatMap((_,i)=>[i,i]);
  const feature=Buffer.concat([field(1,0,vint(42)),field(2,2,Buffer.concat(tags.map(vint))),field(3,0,vint(kind)),field(4,2,Buffer.concat(geometry.map(vint)))]);
  return field(3,2,Buffer.concat([field(15,0,vint(2)),field(1,2,str(name)),field(2,2,feature),
    ...keys.map(k=>field(3,2,str(k))),...values.map(v=>field(4,2,field(4,0,vint(v)))),field(5,0,vint(4096))]));
}
const tile=Buffer.concat([
  layer('building',3,[9,zz(1700),zz(1700),26,zz(600),0,0,zz(600),zz(-600),0,15],['render_height','render_min_height'],[12,0]),
  layer('transportation',2,[9,0,zz(2600),10,zz(4096),0]),
]).toString('base64');
const sampleRoot=process.env.NEIGHBORHOOD_TILE_FIXTURE;
const sample=sampleRoot?JSON.parse(fs.readFileSync(path.join(sampleRoot,'sample.json'),'utf8')):null;
const sampleTiles=sampleRoot?Object.fromEntries(fs.readdirSync(sampleRoot).filter(n=>/^14-\d+-\d+\.pbf$/.test(n)).map(n=>[n.slice(0,-4).replaceAll('-','/'),fs.readFileSync(path.join(sampleRoot,n)).toString('base64')])):null;
const center=sample?.center||[.010986328125,.010986328];
const fixture=`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self'; connect-src 'none';"></head><body style="margin:0;height:100vh"><home-fixture style="display:block;position:relative;height:100vh"></home-fixture><script type="module">
import {Neighborhood} from '/home-floorplan-static/neighborhood.js';
const panel=document.querySelector('home-fixture');panel.attachShadow({mode:'open'});window.calls=[];
panel._hass={user:{id:'synthetic'},connected:true,connection:{connected:true},themes:{darkMode:true},callWS:async message=>{
  calls.push(message);if(message.type==='home_floorplan/map_get')return {configured:true,config:{enabled:true,longitude:${center[0]},latitude:${center[1]},model_x:0,model_z:0,north_deg:0}};
  return message.resource==='metadata'?{minzoom:0,maxzoom:14,attribution:'© OpenMapTiles · © OpenStreetMap contributors',attribution_url:'https://www.openstreetmap.org/copyright'}:{data:${JSON.stringify(sampleTiles)}?.[message.z+'/'+message.x+'/'+message.y] || ${JSON.stringify(tile)}};
}};panel.neighborhoodClosed=()=>{};window.view=new Neighborhood(panel);panel.openNeighborhood=()=>view.open();await view.open();window.ready=true;
</script></body></html>`;
async function assertEventually(predicate,message){const deadline=Date.now()+5000;while(!predicate()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));assert.ok(predicate(),message);}
(async()=>{
  const server=http.createServer((req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/fixture')return res.writeHead(200,{'Content-Type':'text/html'}).end(fixture);
    const relative=pathname.replace(/^\/home-floorplan-static\//,'/custom_components/home_floorplan/static/');
    const file=path.resolve(root,'.'+relative);
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return res.writeHead(404).end();
    res.writeHead(200,{'Content-Type':file.endsWith('.css')?'text/css':'text/javascript'});res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--use-angle=swiftshader','--enable-webgl']});
    const page=await browser.newPage({viewport:{width:1100,height:760},deviceScaleFactor:2});
    const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',req=>{if(!req.url().startsWith(`http://127.0.0.1:${server.address().port}/`))external.push(req.url());});
    await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
    await page.waitForFunction(()=>window.ready&&view.map?.isStyleLoaded(),null,{timeout:30000});
    await page.waitForFunction(()=>view.map.queryRenderedFeatures({layers:['buildings']}).length>0,null,{timeout:30000});
    const data=await page.evaluate(()=>({version:window.view.map.version,tiles:calls.filter(c=>c.resource==='tile').length,pixelRatio:view.map.getPixelRatio(),features:view.map.queryRenderedFeatures({layers:['buildings']}).length}));
    assert.equal(data.version,manifest.version);assert.equal(data.pixelRatio,1.5);assert.ok(data.tiles>0);assert.ok(data.features>0);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    await page.getByRole('button',{name:'Theme: Auto',exact:true}).click();
    await page.waitForFunction(()=>view.map.isStyleLoaded()&&view.map.getPaintProperty('ground','background-color')==='#eeeae1');
    await page.evaluate(()=>new Promise(resolve=>{view.map.once('idle',resolve);view.map.triggerRepaint();}));
    await page.evaluate(()=>{window.idleFrames=0;view.map.on('render',()=>idleFrames++);});
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(()=>idleFrames),0,'Idle overview must not run a continuous render loop');
    if(process.env.NEIGHBORHOOD_SCREENSHOT)await page.screenshot({path:process.env.NEIGHBORHOOD_SCREENSHOT});
    await page.getByRole('button',{name:'Home',exact:true}).click();
    assert.equal(await page.evaluate(()=>view.map),null);
    assert.equal(await page.locator('canvas').count(),0);
    await assertEventually(()=>page.workers().length===0,'Map workers must stop after returning Home');
    console.log('PASS: real MapLibre module/worker decodes local vector tiles, renders buildings, changes theme and releases map without external requests.',JSON.stringify(data));
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
