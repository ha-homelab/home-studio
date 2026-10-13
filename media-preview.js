// Reuse decoded TV frames and notification frames; these callouts never poll.
const tvPreviews=new Map(),mediaLeaders=new Map();
function removeMediaLeader(id){mediaLeaders.get(id)?.remove();mediaLeaders.delete(id);}
function updateTVPreviews(entries){
  const ids=new Set(entries.map(entry=>entry.item.id));
  for(const [id,entry] of tvPreviews)if(!ids.has(id)){entry.el.remove();tvPreviews.delete(id);removeMediaLeader('tv:'+id);}
  for(const {item,state,busy,enabled,details,power} of entries){
    let entry=tvPreviews.get(item.id);
    if(!entry){
      const el=document.createElement('figure'),img=document.createElement('img'),caption=document.createElement('figcaption'),name=document.createElement('button'),button=document.createElement('button'),status=document.createElement('span');
      el.className='tv-preview';el.dataset.tvPreview=item.id;img.width=320;img.height=180;
      name.className='tv-preview-details';
      button.className='tv-preview-power';button.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9m-5-7a8 8 0 1 0 10 0"/></svg>';
      status.className='tv-preview-status';caption.append(name,button);el.append(img,status,caption);$('homeTVs').append(el);
      entry={el,img,name,button,status,item};tvPreviews.set(item.id,entry);
    }
    entry.item=item;entry.state=state;
    entry.img.alt=item.name+' picture';entry.name.textContent=item.name;
    entry.name.title=item.name+' · Open Home Assistant TV controls';entry.name.onclick=details;entry.button.onclick=power;
    const image=state==='on'?tvFrames.get(item.id)?.image:null;
    if(image){if(entry.img.getAttribute('src')!==image)entry.img.src=image;}else entry.img.removeAttribute('src');
    entry.img.hidden=!image;entry.status.hidden=!!image;
    entry.status.textContent=busy?'Waiting for TV…':({off:'TV is off',on:'Waiting for a picture',disconnected:'Disconnected',missing:'Entity not found',unavailable:'TV unavailable',preview:'Offline preview'})[state]||'TV unavailable';
    entry.el.dataset.state=state;entry.name.disabled=!enabled;
    entry.button.disabled=!enabled||busy||!['on','off'].includes(state);
    entry.button.setAttribute('aria-label',(state==='on'?'Turn off ':'Turn on ')+item.name);
    entry.button.setAttribute('aria-busy',String(busy));
    entry.button.title=state==='on'?'Power off':'Power on';
  }
}

// Keep the plan inside a media-free viewport, including on narrow screens.
function mediaPreviewInsets(rect,room){
  let tv=0,cameras=0;
  for(const entry of tvPreviews.values()){
    entry.el.hidden=!!room&&entry.item.room!==room;if(!entry.el.hidden)tv++;
  }
  for(const [id,entry] of cameraPreviews){
    const item=items.find(item=>item.id===id);
    entry.el.hidden=!item||dismissedCameraEvents.get(id)===entry.event||!!room&&item.room!==room;
    if(!entry.el.hidden)cameras++;
  }
  const wide=rect.width>=900;
  $('homeStage').dataset.media=String(!!(tv||cameras));
  $('homeTVs').hidden=!tv;$('homeCameras').hidden=!cameras;
  return wide?{left:cameras?240:0,right:tv?220:0,top:0,bottom:0}:
    {left:0,right:0,top:cameras?150:0,bottom:tv?150:0};
}

function mediaLeaderPath(box,point){
  const x=Math.max(box.x,Math.min(box.x+box.width,point.x)),y=Math.max(box.y,Math.min(box.y+box.height,point.y));
  const mid=(x+point.x)/2;
  return `M ${x} ${y} C ${mid} ${y} ${mid} ${point.y} ${point.x} ${point.y}`;
}
function positionMediaPreviews(camera,rect,room){
  mediaPreviewInsets(rect,room);
  const svg=$('homeMediaLinks'),visible=new Set(),stage=$('homeStage').getBoundingClientRect();
  svg.setAttribute('viewBox',`0 0 ${rect.width} ${rect.height}`);
  const link=(id,entry,item)=>{
    if(entry.el.hidden)return;
    const screen=objectsById.get(item.id)?.userData.screen;
    const anchor=screen?screen.getWorldPosition(new THREE.Vector3()):new THREE.Vector3(item.position_m.x,item.position_m.y+(item.dimensions_m?.height||0)/2,item.position_m.z);
    const p=anchor.project(camera);
    if(p.z < -1||p.z > 1)return;
    const bounds=entry.el.getBoundingClientRect();
    if(!bounds.width||!bounds.height)return;
    const rail=entry.el.parentElement?.getBoundingClientRect();
    if(rail&&(bounds.bottom<=rail.top||bounds.top>=rail.bottom||bounds.right<=rail.left||bounds.left>=rail.right))return;
    const point={x:(p.x+1)*rect.width/2,y:(1-p.y)*rect.height/2};
    const d=mediaLeaderPath({x:bounds.left-stage.left,y:bounds.top-stage.top,width:bounds.width,height:bounds.height},point);
    let group=mediaLeaders.get(id);
    if(!group){
      const create=tag=>document.createElementNS('http://www.w3.org/2000/svg',tag);
      group=create('g');group.dataset.mediaLeader=id;
      for(const className of ['media-leader-halo','media-leader-line']){const path=create('path');path.setAttribute('class',className);group.append(path);}
      const dot=create('circle');dot.setAttribute('r','3');group.append(dot);svg.append(group);mediaLeaders.set(id,group);
    }
    for(const path of group.querySelectorAll('path'))path.setAttribute('d',d);
    const dot=group.querySelector('circle');dot.setAttribute('cx',point.x);dot.setAttribute('cy',point.y);visible.add(id);
  };
  for(const [id,entry] of tvPreviews)link('tv:'+id,entry,entry.item);
  for(const [id,entry] of cameraPreviews){const item=items.find(item=>item.id===id);if(item)link('camera:'+id,entry,item);}
  for(const id of mediaLeaders.keys())if(!visible.has(id))removeMediaLeader(id);
}
