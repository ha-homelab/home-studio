// Native trusted HA surface. Vector data crosses only the authenticated WS bridge.
const vendor = new URL('./vendor/', import.meta.url);
const sessions = new Map();
const queues = new WeakMap();
let nextSession = 0, libraryPromise;
const abortError = () => new DOMException('Map request cancelled', 'AbortError');
function lane(connection) {
  if (!queues.has(connection)) queues.set(connection, {active:0, waiting:[]});
  return queues.get(connection);
}
function drain(queue) {
  while (queue.active < 4 && queue.waiting.length) {
    const job = queue.waiting.shift();
    if (!job.valid()) { job.reject(abortError()); job.finish(); continue; }
    queue.active++;
    Promise.resolve().then(() => { if (!job.valid()) throw abortError(); return job.run(); })
      .then(value => job.valid() ? job.resolve(value) : job.reject(abortError()), job.reject)
      .finally(() => { queue.active--; job.finish(); drain(queue); });
  }
}
function request(hass, message, signal, current) {
  const queue = lane(hass.connection || hass);
  return new Promise((resolve, reject) => {
    if (signal.aborted || !current()) return reject(abortError());
    if (queue.waiting.length >= 32) return reject(Error('Map request queue is full.'));
    const abort = () => { const i=queue.waiting.indexOf(job); if(i>=0) queue.waiting.splice(i,1); reject(abortError()); finish(); };
    const finish = () => signal.removeEventListener('abort', abort);
    const job={resolve,reject,finish,valid:()=>!signal.aborted && current(),run:()=>hass.callWS(message)};
    signal.addEventListener('abort',abort,{once:true});queue.waiting.push(job);drain(queue);
  });
}
export function neighborhoodStyle(id, metadata, dark) {
  const colors=dark?['#17232b','#203e4e','#26372d','#69757b','#45545d']:['#eeeae1','#a8ceda','#cbdabc','#fffefa','#d5ccc0'];
  return {version:8,sources:{neighborhood:{type:'vector',tiles:[`home-map://${id}/{z}/{x}/{y}`],minzoom:metadata.minzoom,maxzoom:metadata.maxzoom}},layers:[
    {id:'ground',type:'background',paint:{'background-color':colors[0]}},
    {id:'land',type:'fill',source:'neighborhood','source-layer':'landuse',paint:{'fill-color':colors[2],'fill-opacity':.6}},
    {id:'water',type:'fill',source:'neighborhood','source-layer':'water',paint:{'fill-color':colors[1]}},
    {id:'roads',type:'line',source:'neighborhood','source-layer':'transportation',paint:{'line-color':colors[3],'line-width':['interpolate',['linear'],['zoom'],10,.6,19,7]}},
    {id:'buildings',type:'fill-extrusion',source:'neighborhood','source-layer':'building',minzoom:15,filter:['!=',['get','hide_3d'],true],paint:{'fill-extrusion-color':colors[4],'fill-extrusion-height':['max',0,['min',300,['coalesce',['get','render_height'],['get','height'],3]]],'fill-extrusion-base':['max',0,['min',['coalesce',['get','render_min_height'],0],['coalesce',['get','render_height'],['get','height'],3]]],'fill-extrusion-opacity':.85}}
  ]};
}
async function library() {
  if (!libraryPromise) libraryPromise=import('./vendor/maplibre-gl.mjs').then(module=>{
    const lib=module.default || module;
    lib.setWorkerUrl(new URL('maplibre-gl-worker.mjs',vendor).href);
    lib.addProtocol('home-map',async (params, controller)=>{
      const match=/^home-map:\/\/(\d+)\/(\d+)\/(\d+)\/(\d+)$/.exec(params.url);
      const session=match && sessions.get(match[1]);
      if(!session) throw abortError();
      const [z,x,y]=match.slice(2).map(Number);
      if(!Number.isInteger(z)||z<0||z>session.metadata.maxzoom||x<0||y<0||x>=2**z||y>=2**z) throw Error('Invalid map tile.');
      const value=await session.tile({z,x,y},controller.signal);
      if(typeof value?.data!=='string'||value.data.length>1398104||value.data.length%4||! /^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) throw Error('Invalid map tile response.');
      const binary=atob(value.data);if(binary.length>1048576) throw Error('Map tile is too large.');
      return {data:Uint8Array.from(binary,c=>c.charCodeAt(0)).buffer};
    });return lib;
  }).catch(error=>{libraryPromise=null;throw error;});
  return libraryPromise;
}
export class Neighborhood {
  constructor(panel) {this.panel=panel;this.epoch=0;}
  current() {const h=this.panel._hass;return this.opened && this.panel.isConnected && !this.panel.ownerDocument.hidden && h?.user?.id===this.account && h?.connection===this.connection && h?.connected!==false && h?.connection?.connected!==false;}
  async open() {
    if(this.opened) return;
    const panel=this.panel,hass=panel._hass;
    if(!hass?.user?.id) return;
    this.opened=true;this.failed=false;this.account=hass.user.id;this.connection=hass.connection;this.controller=new AbortController();
    const epoch=++this.epoch;this.focus=panel.shadowRoot.activeElement;
    const overlay=this.overlay=document.createElement('section');overlay.className='neighborhood';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-label','Neighborhood');
    overlay.innerHTML=`<style>.neighborhood{position:absolute;inset:0;z-index:10;display:flex;flex-direction:column;background:var(--primary-background-color,#11191f);color:var(--primary-text-color,#e9eeef);font:14px system-ui}.neighborhood nav{display:flex;gap:8px;flex-wrap:wrap;padding:10px;align-items:center}.neighborhood button{color:var(--primary-text-color,#e9eeef);background:var(--card-background-color,#202d35)}.neighborhood .map{position:relative;flex:1;min-height:100px}.neighborhood .status{padding:0 12px}.neighborhood a{color:var(--primary-color,#68b8e0)}.neighborhood footer{padding:8px 12px;font-size:12px}.neighborhood .home-marker{display:grid;place-items:center;background:#df7139;color:white;border:2px solid white;border-radius:50%;width:30px;height:30px;min-height:30px;padding:3px;box-shadow:0 2px 12px #0006;cursor:pointer}.neighborhood .home-marker svg{width:18px;height:18px}.neighborhood [hidden]{display:none!important}</style><nav><button data-action="home">Home</button><strong>Neighborhood</strong><button data-action="in" aria-label="Zoom in">+</button><button data-action="out" aria-label="Zoom out">−</button><button data-action="north">Reset north</button><button data-action="anchor">Locate home</button><button data-action="theme">Theme: Auto</button><button data-action="retry" hidden>Try again</button></nav><p class="status" role="status">Loading neighborhood…</p><div class="map"></div><footer>Home marker is approximate; building outlines are map data. <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a> · <a href="https://openmaptiles.org/" target="_blank" rel="noopener noreferrer">© OpenMapTiles</a></footer>`;
    panel.shadowRoot.append(overlay);
    this.visibility=()=>{if(panel.ownerDocument.hidden || panel.hidden)this.close(false);};
    this.hiddenObserver=new MutationObserver(this.visibility);this.hiddenObserver.observe(panel,{attributes:true,attributeFilter:['hidden']});panel.ownerDocument.addEventListener('visibilitychange',this.visibility);
    this.key=event=>{if(event.key==='Escape'){event.preventDefault();this.close();}if(event.key==='Tab'){const buttons=[...overlay.querySelectorAll('button:not([hidden]),a')];const first=buttons[0],last=buttons.at(-1);if(event.shiftKey && panel.shadowRoot.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey && panel.shadowRoot.activeElement===last){event.preventDefault();first.focus();}}};overlay.addEventListener('keydown',this.key);
    const button=action=>overlay.querySelector(`[data-action="${action}"]`);
    button('home').onclick=()=>this.close();button('retry').onclick=()=>{const launchFocus=this.focus;this.close(false);Promise.resolve(panel.openNeighborhood?panel.openNeighborhood():this.open()).then(()=>{if(this.opened&&launchFocus?.isConnected)this.focus=launchFocus;});};
    button('in').onclick=()=>this.map?.zoomIn({duration:0});button('out').onclick=()=>this.map?.zoomOut({duration:0});
    button('north').onclick=()=>this.map?.jumpTo({bearing:0,pitch:0});button('anchor').onclick=()=>this.map?.jumpTo({center:this.center,zoom:17,bearing:0,pitch:45});
    let theme='Auto';const dark=()=>theme==='Dark'||theme==='Auto'&&(panel._hass?.themes?.darkMode===true || panel._hass?.themes?.darkMode===undefined && globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches);
    this.applyTheme=()=>{const next=dark();if(this.map && this.metadata && this.lastDark!==next){this.lastDark=next;this.map.setStyle(neighborhoodStyle(this.id,this.metadata,next));}};
    button('theme').onclick=()=>{theme=theme==='Auto'?'Light':theme==='Light'?'Dark':'Auto';button('theme').textContent=`Theme: ${theme}`;this.applyTheme();};
    this.media=globalThis.matchMedia?.('(prefers-color-scheme: dark)');this.media?.addEventListener('change',this.applyTheme);
    button('home').focus();
    try {
      const signal=this.controller.signal,current=()=>epoch===this.epoch&&this.current();
      const saved=await request(hass,{type:'home_floorplan/map_get'},signal,current);
      const config=saved?.config;
      if(!current())return;
      if(!saved.configured||config?.enabled!==true||!Number.isFinite(config.latitude)||Math.abs(config.latitude)>85||!Number.isFinite(config.longitude)||Math.abs(config.longitude)>180)throw Error('Enable the map and save your home alignment in Home first.');
      const metadata=await request(hass,{type:'home_floorplan/map_vector',resource:'metadata'},signal,current);
      if(!current())return;
      if(!Number.isInteger(metadata?.minzoom)||!Number.isInteger(metadata?.maxzoom)||metadata.minzoom<0||metadata.maxzoom<metadata.minzoom||metadata.maxzoom>19)throw Error('Home Assistant returned invalid map metadata.');
      this.metadata=metadata;this.center=[config.longitude,config.latitude];this.id=String(++nextSession);
      const lib=await library();if(!current())return;
      const css=document.createElement('link');css.rel='stylesheet';css.href=new URL('maplibre-gl.css',vendor).href;overlay.prepend(css);
      sessions.set(this.id,{metadata,tile:(coords,tileSignal)=>{const combined=AbortSignal.any([signal,tileSignal]);return request(hass,{type:'home_floorplan/map_vector',resource:'tile',...coords},combined,current);}});
      this.lastDark=dark();
      this.map=new lib.Map({container:overlay.querySelector('.map'),style:neighborhoodStyle(this.id,metadata,dark()),center:this.center,zoom:17,maxZoom:19,minZoom:metadata.minzoom,maxPitch:60,pitch:45,attributionControl:false,trackResize:true,refreshExpiredTiles:false,maxTileCacheSize:64,maxTileCacheZoomLevels:2,fadeDuration:0,pixelRatio:Math.min(1.5,Math.max(1,globalThis.devicePixelRatio||1)),transformRequest:url=>{if(!url.startsWith(`home-map://${this.id}/`))throw Error('External map requests are disabled.');return {url};}});
      const marker=document.createElement('button');marker.type='button';marker.onclick=()=>this.close();marker.className='home-marker';marker.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 10 12 3l9 7v11h-6v-7H9v7H3Z"/></svg>';marker.setAttribute('aria-label','Approximate home location');marker.title='Approximate home location · return Home';
      this.marker=new lib.Marker({element:marker}).setLngLat(this.center).addTo(this.map);
      this.map.on('load',()=>{if(current())overlay.querySelector('.status').textContent='Drag to move · pinch or scroll to zoom · rotate with two fingers or right drag.';});
      this.map.on('webglcontextlost',event=>{event?.preventDefault?.();if(current())this.fail('The map graphics context was lost. Try again or return Home.');});
      this.map.on('error',()=>{if(current())this.fail('Neighborhood could not load. Your Home view is available.');});
    }catch(error){if(epoch===this.epoch&&this.current()&&error.name!=='AbortError')this.fail(error.message==='Enable the map and save your home alignment in Home first.'?error.message:'Neighborhood is unavailable. Check the Home Assistant connection and try again.');}
  }
  fail(message){if(!this.opened||this.failed)return;this.failed=true;this.controller.abort();this.disposeMap();this.overlay.querySelector('.status').textContent=message;this.overlay.querySelector('[data-action="retry"]').hidden=false;}
  disposeMap(){if(this.id)sessions.delete(this.id);const marker=this.marker,map=this.map;this.marker=null;this.map=null;marker?.remove();map?.remove();}
  close(restore=true){if(!this.opened)return;this.opened=false;this.epoch++;this.controller.abort();this.disposeMap();this.panel.ownerDocument.removeEventListener('visibilitychange',this.visibility);this.hiddenObserver?.disconnect();this.media?.removeEventListener('change',this.applyTheme);this.overlay.remove();this.overlay=null;if(restore&&this.focus?.isConnected)this.focus.focus();this.panel.neighborhoodClosed?.();}
}
