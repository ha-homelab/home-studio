// A notification's existing frames, never a stream URL or camera request.
const cameraPreviews=new Map();
const dismissedCameraEvents=new Map();
function applyCameraFrames(frames={}){
  let changed=false;
  for(const [id,entry] of cameraPreviews)if(!frames?.[id]){clearTimeout(entry.timer);entry.el.remove();cameraPreviews.delete(id);changed=true}
  for(const [id,frame] of Object.entries(frames||{})){
    const item=items.find(i=>i.id===id),age=Date.now()/1000-frame?.captured_at;
    if(!item||!Object.hasOwn(model.camera_entities||{},id)||item.entity_id!==model.camera_entities[id]||
      !/^[0-9a-f]{32}$/.test(frame?.event_id)||!Number.isFinite(age)||age<0||age>=5||
      typeof frame.image!=='string'||frame.image.length>250000||!frame.image.startsWith('data:image/jpeg;base64,'))continue;
    let entry=cameraPreviews.get(id);
    if(entry?.captured===frame.captured_at&&entry.event===frame.event_id)continue;
    changed=true;
    if(!entry){
      const el=document.createElement('figure'),caption=document.createElement('figcaption'),name=document.createElement('span'),close=document.createElement('button'),img=document.createElement('img');
      el.className='camera-preview';el.dataset.cameraPreview=id;el.hidden=true;
      name.textContent=item.name+' · Motion';close.textContent='×';close.setAttribute('aria-label','Dismiss camera preview');img.alt=item.name+' notification video';
      caption.append(name,close);el.append(img,caption);$('homeCameras').append(el);
      entry={el,img};cameraPreviews.set(id,entry);
      close.onclick=()=>{dismissedCameraEvents.set(id,entry.event);el.hidden=true};
    }
    entry.event=frame.event_id;entry.captured=frame.captured_at;entry.img.src=frame.image;
    clearTimeout(entry.timer);entry.timer=setTimeout(()=>{entry.el.remove();cameraPreviews.delete(id)},(5-age)*1000);
  }
  if(changed)window.renderModel?.();
}
function positionCameraPreviews(camera,height,room){
  for(const [id,entry] of cameraPreviews){
    const item=items.find(i=>i.id===id);
    entry.el.hidden=!item||dismissedCameraEvents.get(id)===entry.event||!!room&&item.room!==room;
    if(entry.el.hidden)continue;
    const p=new THREE.Vector3(item.position_m.x,item.position_m.y,item.position_m.z).project(camera);
    entry.el.style.top=Math.max(4,Math.min(height-entry.el.offsetHeight-4,(1-p.y)*height/2-entry.el.offsetHeight-12))+'px';
  }
}
