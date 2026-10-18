// Reuse decoded TV frames, HA artwork and notification frames; these callouts never poll.
const tvPreviews=new Map(),mediaLeaders=new Map();
const mediaArtwork=new Map();
// The trusted host validates these same HA feature flags before dispatch.
const mediaControlFeatures={media_previous_track:16,media_play:16384,media_pause:1,media_stop:4096,media_next_track:32,volume_set:4};
const mediaControlPending=new Map(),mediaControlErrors=new Map();
let mediaControls=null,mediaControlSequence=0,mediaControlDismissTimer;
const mediaText=(key,params)=>typeof vt==='function'?vt(key,params):key;
function hasMediaControls(entry){return !!entry&&entry.item.type!=='tv'&&typeof entry.command==='function'&&!model.tv_entities?.[entry.item.id];}
function mediaControlFlags(entry){const flags=entry?.media?.supported_features;return Number.isSafeInteger(flags)&&flags>=0?flags:0;}
function mediaControlsReady(entry){
  return !!entry?.enabled&&haConnected&&!entry.busy&&!mediaControlPending.has(entry.item.entity_id)&&!entry.media?.restored&&!haStates[entry.item.entity_id]?.restored&&['on','playing','paused','idle','buffering'].includes(entry.media?.state);
}
function hideMediaControls({restoreFocus=false}={}){
  if(!mediaControls)return;
  clearTimeout(mediaControlDismissTimer);
  const anchor=mediaControls.anchor;
  mediaControls.el.hidden=true;mediaControls.id=null;mediaControls.anchor=null;mediaControls.volumeEditing=false;
  anchor?.setAttribute('aria-expanded','false');
  document.removeEventListener('pointerdown',mediaControls.outside,true);
  document.removeEventListener('focusin',mediaControls.outsideFocus,true);
  document.removeEventListener('keydown',mediaControls.escape,true);
  document.removeEventListener('scroll',mediaControls.scroll,true);
  window.removeEventListener('resize',mediaControls.scroll);
  if(restoreFocus&&anchor?.isConnected){mediaControls.restoringFocus=true;anchor.focus();mediaControls.restoringFocus=false;}
}
function discardMediaControls(){
  hideMediaControls();
  for(const pending of mediaControlPending.values())clearTimeout(pending.timer);
  mediaControlPending.clear();mediaControlErrors.clear();
  mediaControls?.el.remove();mediaControls=null;
}
function scheduleMediaControlDismiss(){
  clearTimeout(mediaControlDismissTimer);
  mediaControlDismissTimer=setTimeout(()=>{
    if(!mediaControls?.el.contains(document.activeElement)&&document.activeElement!==mediaControls?.anchor)hideMediaControls();
  },180);
}
function bindMediaControlTrigger(id,element){
  const enter=event=>{if(event.pointerType==='mouse'&&!event.buttons)showMediaControls(id,element);};
  const focus=()=>{if(!mediaControls?.restoringFocus)showMediaControls(id,element);};
  const leave=event=>{if(!mediaControls?.el.contains(event.relatedTarget))scheduleMediaControlDismiss();};
  const click=event=>{if(showMediaControls(id,element,{focus:true})){event.preventDefault();event.stopPropagation();}};
  element.setAttribute('aria-haspopup','dialog');element.setAttribute('aria-controls','homeMediaControls');element.setAttribute('aria-expanded','false');
  element.addEventListener('pointerenter',enter);element.addEventListener('pointerleave',leave);element.addEventListener('focus',focus);element.addEventListener('click',click);
  return ()=>{
    element.removeEventListener('pointerenter',enter);element.removeEventListener('pointerleave',leave);element.removeEventListener('focus',focus);element.removeEventListener('click',click);
    if(mediaControls?.anchor===element)hideMediaControls();
    for(const name of ['aria-haspopup','aria-controls','aria-expanded'])element.removeAttribute(name);
  };
}
function ensureMediaControls(){
  if(mediaControls)return mediaControls;
  const el=document.createElement('section'),header=document.createElement('div'),title=document.createElement('strong'),close=document.createElement('button'),track=document.createElement('p'),status=document.createElement('p'),actions=document.createElement('div'),volume=document.createElement('label'),volumeTitle=document.createElement('span'),level=document.createElement('input'),output=document.createElement('output'),details=document.createElement('button');
  el.id='homeMediaControls';el.className='media-controls';el.hidden=true;el.tabIndex=-1;el.setAttribute('role','dialog');
  header.className='media-controls-header';close.type='button';close.textContent='×';close.setAttribute('aria-label',mediaText('Close media controls'));close.onclick=()=>hideMediaControls({restoreFocus:true});header.append(title,close);
  track.className='media-controls-track';status.className='media-controls-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  actions.className='media-controls-actions';actions.setAttribute('role','group');actions.setAttribute('aria-label',mediaText('Playback'));
  const buttons=new Map();
  for(const [action,label,symbol] of [['media_previous_track','Previous track','⏮'],['media_play','Play','▶'],['media_pause','Pause','Ⅱ'],['media_stop','Stop','■'],['media_next_track','Next track','⏭']]){
    const button=document.createElement('button');button.type='button';button.textContent=symbol;button.dataset.mediaAction=action;button.setAttribute('aria-label',mediaText(label));button.title=mediaText(label);button.onclick=()=>sendMediaControl(action);actions.append(button);buttons.set(action,button);
  }
  volume.className='media-controls-volume';volumeTitle.textContent=mediaText('Volume');level.type='range';level.min='0';level.max='100';level.step='1';level.setAttribute('aria-label',mediaText('Volume'));level.dataset.mediaAction='volume_set';
  level.oninput=()=>{mediaControls.volumeEditing=true;output.textContent=level.value+'%';level.setAttribute('aria-valuetext',output.textContent);};
  level.onchange=()=>{mediaControls.volumeEditing=false;sendMediaControl('volume_set',Number(level.value));};volume.append(volumeTitle,output,level);
  details.type='button';details.className='media-controls-details';details.textContent=mediaText('Open Home Assistant controls');details.onclick=()=>{const entry=tvPreviews.get(mediaControls.id);hideMediaControls();entry?.details?.();};
  el.append(header,track,actions,volume,status,details);$('homeView').append(el);
  mediaControls={el,title,track,status,buttons,volume,level,output,details,id:null,anchor:null,volumeEditing:false};
  mediaControls.outside=event=>{if(!el.contains(event.target)&&!mediaControls.anchor?.contains(event.target))hideMediaControls();};
  mediaControls.outsideFocus=event=>{if(!el.contains(event.target)&&!mediaControls.anchor?.contains(event.target))hideMediaControls();};
  mediaControls.escape=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();hideMediaControls({restoreFocus:true});}};
  mediaControls.scroll=event=>{if(event?.type==='resize'||!el.contains(event?.target))hideMediaControls();};
  el.addEventListener('pointerenter',()=>clearTimeout(mediaControlDismissTimer));el.addEventListener('pointerleave',scheduleMediaControlDismiss);
  return mediaControls;
}
function updateMediaControls(){
  if(!mediaControls?.id)return;
  const ui=mediaControls,entry=tvPreviews.get(ui.id);
  if(!hasMediaControls(entry)){hideMediaControls();return;}
  const flags=mediaControlFlags(entry),ready=mediaControlsReady(entry),pending=mediaControlPending.has(entry.item.entity_id),state=entry.media?.state;
  ui.title.textContent=entry.item.name;ui.el.setAttribute('aria-label',entry.item.name+' · '+mediaText('Media controls'));ui.el.setAttribute('aria-busy',String(pending||!!entry.busy));
  ui.track.textContent=[entry.media?.title,entry.media?.artist,entry.media?.album].filter(value=>typeof value==='string'&&value.trim()).map(value=>value.trim().slice(0,200)).join(' · ');
  ui.track.hidden=!ui.track.textContent;
  for(const [action,button] of ui.buttons){button.hidden=!(flags&mediaControlFeatures[action]);button.disabled=!ready;}
  ui.volume.hidden=!(flags&mediaControlFeatures.volume_set);ui.level.disabled=!ready;
  if(!ui.volumeEditing&&!pending){
    const value=entry.media?.volume_level,valid=typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
    ui.level.value=valid?String(Math.round(value*100)):'0';ui.output.textContent=valid?ui.level.value+'%':'—';ui.level.setAttribute('aria-valuetext',valid?ui.output.textContent:mediaText('Volume unavailable'));
  }
  const error=mediaControlErrors.get(entry.item.entity_id);
  ui.status.textContent=error||(pending||entry.busy?mediaText('Sending media command…'):!entry.enabled||!haConnected?mediaText('Home Assistant disconnected'):entry.media?.restored||haStates[entry.item.entity_id]?.restored||!['on','playing','paused','idle','buffering'].includes(state)?mediaText('Media player unavailable'):!(flags&Object.values(mediaControlFeatures).reduce((all,flag)=>all|flag,0))?mediaText('No supported playback controls'):mediaText(({playing:'Playing',paused:'Paused',buffering:'Buffering',idle:'Idle',on:'On'})[state]||'Media player unavailable'));
  ui.status.dataset.error=String(!!error);ui.details.disabled=!entry.enabled||!haConnected;
}
function showMediaControls(id,anchor,{focus=false}={}){
  const entry=tvPreviews.get(id);
  if(!hasMediaControls(entry)||!anchor?.isConnected)return false;
  clearTimeout(mediaControlDismissTimer);
  const ui=ensureMediaControls();
  if(ui.anchor!==anchor)ui.anchor?.setAttribute('aria-expanded','false');
  ui.id=id;ui.anchor=anchor;ui.el.hidden=false;anchor.setAttribute('aria-expanded','true');updateMediaControls();
  const rect=anchor.getBoundingClientRect(),box=ui.el.getBoundingClientRect(),width=window.innerWidth,height=window.innerHeight;
  ui.el.style.left=Math.max(8,Math.min(rect.left,width-box.width-8))+'px';
  ui.el.style.top=Math.max(8,Math.min(rect.bottom+8+box.height<=height-8?rect.bottom+8:rect.top-box.height-8,height-box.height-8))+'px';
  document.addEventListener('pointerdown',ui.outside,true);document.addEventListener('focusin',ui.outsideFocus,true);document.addEventListener('keydown',ui.escape,true);document.addEventListener('scroll',ui.scroll,true);window.addEventListener('resize',ui.scroll);
  if(focus)ui.el.focus();
  return true;
}
function sendMediaControl(action,value){
  const entry=tvPreviews.get(mediaControls?.id);
  if(!hasMediaControls(entry)||!mediaControlsReady(entry)||!(mediaControlFlags(entry)&mediaControlFeatures[action]))return;
  if(action==='volume_set'&&(!Number.isInteger(value)||value<0||value>100))return;
  const entity=entry.item.entity_id,request_id='media_'+(++mediaControlSequence);
  mediaControlErrors.delete(entity);
  const timer=setTimeout(()=>{
    if(mediaControlPending.get(entity)?.request_id!==request_id)return;
    mediaControlPending.delete(entity);mediaControlErrors.set(entity,mediaText('Media command was not confirmed. Check the player before trying again.'));updateMediaControls();
  },12000);
  mediaControlPending.set(entity,{request_id,timer});updateMediaControls();
  try{entry.command(action,value,request_id);}catch{window.handleMediaCommandResult({entity_id:entity,request_id,ok:false});}
}
window.handleMediaCommandResult=function(message){
  const pending=mediaControlPending.get(message?.entity_id);
  if(!pending||pending.request_id!==message.request_id)return false;
  clearTimeout(pending.timer);mediaControlPending.delete(message.entity_id);
  if(!message.ok)mediaControlErrors.set(message.entity_id,typeof message.error==='string'?message.error.slice(0,240):mediaText('The media command could not be sent.'));
  updateMediaControls();return true;
};
const mediaArtworkActive=item=>item?.entity_id?.startsWith('media_player.')&&haConnected&&!haStates[item.entity_id]?.restored&&['on','playing','paused','idle','buffering'].includes(haStates[item.entity_id]?.state);
function discardMediaArtwork(id){
  const frame=mediaArtwork.get(id);
  if(frame?.decoder){frame.decoder.onload=frame.decoder.onerror=null;frame.decoder.removeAttribute('src');}
  mediaArtwork.delete(id);
}
function pruneMediaArtwork(){
  for(const [id,frame] of mediaArtwork){
    const item=items.find(item=>item.id===id);
    if(!mediaArtworkActive(item)||item.entity_id!==frame.entity_id)discardMediaArtwork(id);
  }
}
// Explicit bridge entry point shared by the compiled viewer fragments.
window.applyMediaArtwork=function(artwork={}){
  const retained=new Set();
  for(const [id,value] of Object.entries(artwork&&typeof artwork==='object'&&!Array.isArray(artwork)?artwork:{})){
    const item=items.find(item=>item.id===id);
    if(!mediaArtworkActive(item)||value?.entity_id!==item.entity_id||typeof value.identity!=='string'||!value.identity||value.identity.length>128)continue;
    retained.add(id);
    let frame=mediaArtwork.get(id);
    if(frame?.identity!==value.identity||frame.entity_id!==value.entity_id){
      discardMediaArtwork(id);frame={entity_id:value.entity_id,identity:value.identity,image:null};mediaArtwork.set(id,frame);
    }
    if(value.image===null){discardMediaArtwork(id);continue;}
    // Only the trusted host's bounded JPEG data is decoded; never fetch a URL here.
    const image=value.image;
    if(typeof image!=='string'||image.length>250000||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)||frame.image===image||frame.pending===image)continue;
    if(frame.decoder){frame.decoder.onload=frame.decoder.onerror=null;frame.decoder.removeAttribute('src');}
    const decoder=new Image();frame.decoder=decoder;frame.pending=image;
    const finish=()=>{decoder.onload=decoder.onerror=null;if(frame.decoder===decoder){frame.decoder=null;frame.pending=null;}};
    decoder.onload=()=>{
      const current=items.find(item=>item.id===id);
      if(mediaArtwork.get(id)===frame&&frame.decoder===decoder&&current?.entity_id===frame.entity_id&&mediaArtworkActive(current)&&decoder.naturalWidth>0&&decoder.naturalWidth<=512&&decoder.naturalHeight>0&&decoder.naturalHeight<=512){
        frame.image=image;homeView?.refreshTVPreviews?.();window.requestModelRender?.();
      }
      finish();
    };
    decoder.onerror=finish;decoder.src=image;
  }
  for(const id of mediaArtwork.keys())if(!retained.has(id))discardMediaArtwork(id);
  homeView?.refreshTVPreviews?.();window.requestModelRender?.();
};
const telemetryPreviews=new Map();
const powerLabels=new Map();
function formatTelemetryReading(reading,metric){
  if(!reading||reading.restored||reading.state==null||!String(reading.state).trim()||['unknown','unavailable'].includes(reading.state))return '—';
  if(metric.format==='status')return metric.labels?.[reading.state]||String(reading.state).replaceAll('_',' ').slice(0,32);
  let value=Number(reading.state),unit=String(reading.unit||'').trim();
  if(!Number.isFinite(value)||(value<0&&!(metric.format==='power'&&metric.signed)))return '—';
  if(metric.format==='percent'&&(unit!=='%'||value>100))return '—';
  if(metric.format==='pressure'){
    const factor={psi:1,kpa:1/6.894757,bar:14.503774,pa:1/6894.757}[unit.toLowerCase()];
    if(!factor||value===0)return '—';value*=factor;unit='PSI';
  }
  if(metric.format==='power'){if(!['W','kW'].includes(unit))return '—';const watts=value*(unit==='kW'?1000:1),magnitude=Math.abs(watts);return magnitude>=1000?`${(watts/1000).toFixed(1)} kW`:`${magnitude>0&&magnitude<10?watts.toFixed(1):Math.round(watts)} W`;}
  return `${value.toFixed(Math.max(0,Math.min(2,metric.decimals||0)))}${unit==='%'?'':' '}${unit}`.trim();
}
function updateTelemetryPreviews(states,connected){
  for(const item of (model.telemetry||[]).slice(0,4)){
    if(!item.position_m||!['x','y','z'].every(k=>Number.isFinite(item.position_m[k])))continue;
    let entry=telemetryPreviews.get(item.id);
    if(!entry){
      const el=document.createElement('section'),title=document.createElement('strong'),grid=document.createElement('dl'),note=document.createElement('small');
      el.className='telemetry-preview';el.dataset.telemetryPreview=item.id;title.textContent=item.name;el.setAttribute('aria-label',item.name+' · Last reported telemetry');
      const rows=(item.metrics||[]).slice(0,8).map(metric=>{const row=document.createElement('div'),label=document.createElement('dt'),value=document.createElement('dd');label.textContent=metric.label;row.dataset.format=metric.format;row.append(label,value);grid.append(row);return {metric,value};});
      el.append(title,grid,note);$('homeTelemetry').append(el);entry={el,item,rows,note};telemetryPreviews.set(item.id,entry);
    }
    for(const {metric,value} of entry.rows)value.textContent=formatTelemetryReading(connected?states[metric.entity_id]:null,metric);
    entry.note.textContent=connected?'Last reported · updates may be delayed':'Home Assistant disconnected';
  }
  for(const spec of (model.power_labels||[]).slice(0,12)){
    const id=spec.id||spec.object_id;if(!id)continue;
    let entry=powerLabels.get(id);
    if(!entry){
      const el=spec.object_id?document.createElement('span'):null;
      if(el){el.className='home-power-label';el.dataset.powerLabel=id;$('homeTelemetry').append(el);}
      entry={el,spec};powerLabels.set(id,entry);
    }
    const reading=connected?states[spec.entity_id]:null,text=formatTelemetryReading(reading,{format:'power',signed:spec.signed});
    entry.available=text!=='—'&&Number(reading.state)!==0;entry.text=text;
    if(entry.el){entry.el.textContent=text;entry.el.title=spec.name+' · '+text;entry.el.setAttribute('aria-label',entry.el.title);}
  }
}

function roomPowerText(room,selected){
  return [...powerLabels.values()].filter(e=>!e.el&&e.available&&(selected?selected===room&&e.spec.room_ids?.includes(room):e.spec.room_ids?.[0]===room)).map(e=>e.text).join(' · ');
}

function positionPowerLabels(camera,rect,room){
  if(!powerLabels.size)return;
  const stage=$('homeStage').getBoundingClientRect(),blocked=[];
  for(const el of $('homeStage').querySelectorAll('.home-marker:not([hidden]),.home-room-label:not([hidden])')){
    const b=el.getBoundingClientRect();blocked.push({x:b.left-stage.left,y:b.top-stage.top,width:b.width,height:b.height});
  }
  for(const entry of powerLabels.values()){
    if(!entry.el)continue;
    const item=items.find(item=>item.id===entry.spec.object_id);
    entry.el.hidden=!entry.available||!item||!!room&&item.room!==room;
    if(entry.el.hidden)continue;
    const point=new THREE.Vector3(item.position_m.x,item.position_m.y+(item.dimensions_m?.height||0),item.position_m.z).project(camera),size=entry.el.getBoundingClientRect();
    const x=(point.x+1)*rect.width/2-size.width-18,y=(1-point.y)*rect.height/2-size.height/2;
    const box=[0,-1,1,-2,2].map(d=>({x,y:y+d*(size.height+8),width:size.width,height:size.height})).find(b=>point.z>=-1&&point.z<=1&&b.x>=4&&b.y>=4&&b.x+b.width<=rect.width-4&&b.y+b.height<=rect.height-4&&!blocked.some(o=>b.x<o.x+o.width+4&&b.x+b.width>o.x-4&&b.y<o.y+o.height+4&&b.y+b.height>o.y-4));
    entry.el.hidden=!box;
    if(box){entry.el.style.left=box.x+'px';entry.el.style.top=box.y+'px';blocked.push(box);}
  }
}
function removeMediaLeader(id){mediaLeaders.get(id)?.remove();mediaLeaders.delete(id);}
function updateTVPreviews(entries){
  pruneMediaArtwork();
  const ids=new Set(entries.map(entry=>entry.item.id));
  const entities=new Set(entries.map(entry=>entry.item.entity_id));
  for(const [entity,pending] of mediaControlPending)if(!entities.has(entity)){clearTimeout(pending.timer);mediaControlPending.delete(entity);}
  for(const entity of mediaControlErrors.keys())if(!entities.has(entity))mediaControlErrors.delete(entity);
  for(const [id,entry] of tvPreviews)if(!ids.has(id)){entry.removeRemoteTrigger?.();entry.el.remove();tvPreviews.delete(id);removeMediaLeader('tv:'+id);}
  for(const {item,state,busy,enabled,details,power,media,command} of entries){
    let entry=tvPreviews.get(item.id);
    if(!entry){
      const el=document.createElement('figure'),img=document.createElement('img'),caption=document.createElement('figcaption'),name=document.createElement('button'),button=document.createElement('button'),status=document.createElement('span');
      el.className='tv-preview';el.dataset.tvPreview=item.id;img.width=320;img.height=180;
      name.className='tv-preview-details';
      button.className='tv-preview-power';button.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9m-5-7a8 8 0 1 0 10 0"/></svg>';
      status.className='tv-preview-status';caption.append(name,button);el.append(img,status,caption);$('homeTVs').append(el);
      entry={el,img,name,button,status,caption,item};tvPreviews.set(item.id,entry);
    }
    if(entry.item.entity_id!==item.entity_id&&mediaControls?.id===item.id)hideMediaControls();
    Object.assign(entry,{item,state,busy,enabled,details,media,command});
    const snapshot=state==='on'?tvFrames.get(item.id)?.image:null,artwork=state==='on'?mediaArtwork.get(item.id)?.image:null;
    const image=snapshot||artwork,cover=!!artwork&&!snapshot,configuredTV=!!model.tv_entities?.[item.id];
    const label=media&&typeof media==='object'?[media.title,media.artist,media.album].filter(value=>typeof value==='string'&&value.trim()).map(value=>value.trim().slice(0,200)).join(' · '):'';
    entry.img.alt=item.name+(cover?' cover art':' picture');entry.name.textContent=item.name;
    entry.name.title=item.name+' · Open Home Assistant media controls';entry.name.onclick=()=>{hideMediaControls();details?.();};entry.button.onclick=power;
    entry.el.dataset.mediaKind=!snapshot&&(cover||!configuredTV)?'cover':'snapshot';
    if(image){if(entry.img.getAttribute('src')!==image)entry.img.src=image;}else entry.img.removeAttribute('src');
    entry.img.hidden=!image;entry.status.hidden=!!snapshot;
    entry.status.textContent=cover?(label||'Cover art'):busy?'Waiting for media player…':({off:configuredTV?'TV is off':'Media player is off',on:configuredTV?'Waiting for a picture':label||'Cover art unavailable',disconnected:'Disconnected',missing:'Entity not found',unavailable:'Media player unavailable',preview:'Offline preview'})[state]||'Media player unavailable';
    entry.el.dataset.state=state;entry.name.disabled=!enabled;
    entry.button.disabled=!enabled||busy||!['on','off'].includes(state);
    entry.button.setAttribute('aria-label',(state==='on'?'Turn off ':'Turn on ')+item.name);
    entry.button.setAttribute('aria-busy',String(busy));
    entry.button.title=state==='on'?'Power off':'Power on';
    if(hasMediaControls(entry)){
      if(!entry.remote){
        const remote=document.createElement('button');remote.type='button';remote.className='tv-preview-controls';remote.textContent=mediaText('Controls');entry.caption.append(remote);entry.remote=remote;
        entry.removeRemoteTrigger=bindMediaControlTrigger(item.id,remote);
        entry.el.onpointerenter=event=>{if(event.pointerType==='mouse'&&!event.buttons)showMediaControls(item.id,remote);};
        entry.el.onpointerleave=event=>{if(!mediaControls?.el.contains(event.relatedTarget))scheduleMediaControlDismiss();};
      }
      entry.remote.hidden=false;entry.remote.setAttribute('aria-label',entry.item.name+' · '+mediaText('Media controls'));
      entry.button.hidden=!(mediaControlFlags(entry)&(state==='on'?256:128));
    }else{
      entry.button.hidden=false;
      if(entry.remote){entry.removeRemoteTrigger?.();entry.remote.remove();entry.remote=null;entry.removeRemoteTrigger=null;entry.el.onpointerenter=entry.el.onpointerleave=null;}
    }
  }
  updateMediaControls();
}

// Fit callouts into unused pixels. This never changes the camera or stage size.
const mediaWorldBounds=new WeakMap();
let mediaLayout=null;
function mediaLeaderPath(box,point){
  const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
  if(point.x<box.x||point.x>box.x+box.width){
    const x=point.x<box.x?box.x:box.x+box.width,y=clamp(point.y,box.y+8,box.y+box.height-8),mid=(x+point.x)/2;
    return `M ${x} ${y} H ${mid} V ${point.y} H ${point.x}`;
  }
  const x=clamp(point.x,box.x+8,box.x+box.width-8),y=point.y<box.y?box.y:box.y+box.height,mid=(y+point.y)/2;
  return `M ${x} ${y} V ${mid} H ${point.x} V ${point.y}`;
}
function findMediaSpace(size,viewport,obstacles,point){
  const maxX=viewport.width-size.width-8,maxY=viewport.height-size.height-8;
  if(maxX<8||maxY<8)return null;
  const xs=[maxX],ys=[maxY];
  for(let x=8;x<maxX;x+=24)xs.push(x);
  for(let y=8;y<maxY;y+=24)ys.push(y);
  let best=null,score=Infinity;
  for(const y of ys)for(const x of xs){
    if(obstacles.some(b=>x<b.x+b.width+10&&x+size.width>b.x-10&&y<b.y+b.height+10&&y+size.height>b.y-10))continue;
    // Prefer a short connection, with a slight right-side bias for equal fits.
    const distance=Math.hypot(x+size.width/2-point.x,y+size.height/2-point.y)+(viewport.width-x)*.03;
    if(distance<score){score=distance;best={x,y,...size};}
  }
  return best;
}
function mediaSceneObstacles(camera,rect){
  const blocked=[],point=new THREE.Vector3();
  for(const object of [...(root?.children||[]).filter(object=>object.isMesh),...(objectGroup?.children||[])]){
    if(!object.visible)continue;
    let box=mediaWorldBounds.get(object);
    if(!box){box=new THREE.Box3().setFromObject(object);mediaWorldBounds.set(object,box);}
    if(box.isEmpty())continue;
    let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
    for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]){
      point.set(x,y,z).project(camera);
      const px=(point.x+1)*rect.width/2,py=(1-point.y)*rect.height/2;
      left=Math.min(left,px);right=Math.max(right,px);top=Math.min(top,py);bottom=Math.max(bottom,py);
    }
    blocked.push({x:left,y:top,width:right-left,height:bottom-top});
  }
  const stage=$('homeStage').getBoundingClientRect();
  for(const node of $('homeStage').querySelectorAll('.home-marker:not([hidden]),.home-room-label:not([hidden]),.home-power-label:not([hidden])')){
    const b=node.getBoundingClientRect();if(b.width&&b.height)blocked.push({x:b.left-stage.left,y:b.top-stage.top,width:b.width,height:b.height});
  }
  return blocked;
}
function positionMediaPreviews(camera,rect,room){
  positionPowerLabels(camera,rect,room);
  const svg=$('homeMediaLinks'),visible=new Set(),cards=[];
  svg.setAttribute('viewBox',`0 0 ${rect.width} ${rect.height}`);
  const collect=(id,entry,item)=>{
    entry.el.hidden=!!room&&item.room!==room||item.lower_floor&&!lowerFloorContext?.visible||id.startsWith('camera:')&&dismissedCameraEvents.get(item.id)===entry.event;
    if(entry.el.hidden)return;
    const screen=objectsById.get(item.id)?.userData.screen;
    const anchor=screen?screen.getWorldPosition(new THREE.Vector3()):new THREE.Vector3(item.position_m.x,item.position_m.y+(item.dimensions_m?.height||0)/2,item.position_m.z);
    const p=anchor.project(camera),b=entry.el.getBoundingClientRect();
    if(p.z < -1||p.z > 1||!b.width||!b.height){entry.el.hidden=true;return;}
    cards.push({id,entry,size:{width:b.width,height:b.height},point:{x:(p.x+1)*rect.width/2,y:(1-p.y)*rect.height/2}});
  };
  for(const [id,entry] of tvPreviews)collect('tv:'+id,entry,entry.item);
  for(const [id,entry] of cameraPreviews){const item=items.find(item=>item.id===id);if(item)collect('camera:'+id,entry,item);else entry.el.hidden=true;}
  for(const [id,entry] of telemetryPreviews)collect('telemetry:'+id,entry,entry.item);
  const key=[rect.width,rect.height,room,...camera.matrixWorld.elements,...camera.projectionMatrix.elements,...cards.flatMap(c=>[c.id,c.size.width,c.size.height,c.point.x,c.point.y]),...[...powerLabels.values()].map(e=>e.el?.hidden?'':e.text)].join('|');
  const first=objectGroup?.children[0];
  if(!mediaLayout||mediaLayout.key!==key||mediaLayout.first!==first){
    const blocked=mediaSceneObstacles(camera,rect),boxes=new Map();
    for(const card of cards){const box=findMediaSpace(card.size,rect,blocked,card.point);if(box){boxes.set(card.id,box);blocked.push(box);}}
    mediaLayout={key,first,boxes};
  }
  for(const {id,entry,point} of cards){
    const box=mediaLayout.boxes.get(id);
    entry.el.hidden=!box;if(!box)continue;
    entry.el.style.left=box.x+'px';entry.el.style.top=box.y+'px';
    // Telemetry cards must never draw a leader across the active storey.
    if(id.startsWith('telemetry:'))continue;
    let group=mediaLeaders.get(id);
    if(!group){
      const create=tag=>document.createElementNS('http://www.w3.org/2000/svg',tag);
      group=create('g');group.dataset.mediaLeader=id;
      for(const className of ['media-leader-halo','media-leader-line']){const path=create('path');path.setAttribute('class',className);group.append(path);}
      const dot=create('circle');dot.setAttribute('r','3');group.append(dot);svg.append(group);mediaLeaders.set(id,group);
    }
    const d=mediaLeaderPath(box,point);
    for(const path of group.querySelectorAll('path'))path.setAttribute('d',d);
    const dot=group.querySelector('circle');dot.setAttribute('cx',point.x);dot.setAttribute('cy',point.y);visible.add(id);
  }
  for(const id of mediaLeaders.keys())if(!visible.has(id))removeMediaLeader(id);
}
