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
  for(const node of $('homeStage').querySelectorAll('.home-marker:not([hidden]),.home-room-label:not([hidden])')){
    const b=node.getBoundingClientRect();if(b.width&&b.height)blocked.push({x:b.left-stage.left,y:b.top-stage.top,width:b.width,height:b.height});
  }
  return blocked;
}
function positionMediaPreviews(camera,rect,room){
  const svg=$('homeMediaLinks'),visible=new Set(),cards=[];
  svg.setAttribute('viewBox',`0 0 ${rect.width} ${rect.height}`);
  const collect=(id,entry,item)=>{
    entry.el.hidden=!!room&&item.room!==room||id.startsWith('camera:')&&dismissedCameraEvents.get(item.id)===entry.event;
    if(entry.el.hidden)return;
    const screen=objectsById.get(item.id)?.userData.screen;
    const anchor=screen?screen.getWorldPosition(new THREE.Vector3()):new THREE.Vector3(item.position_m.x,item.position_m.y+(item.dimensions_m?.height||0)/2,item.position_m.z);
    const p=anchor.project(camera),b=entry.el.getBoundingClientRect();
    if(p.z < -1||p.z > 1||!b.width||!b.height){entry.el.hidden=true;return;}
    cards.push({id,entry,size:{width:b.width,height:b.height},point:{x:(p.x+1)*rect.width/2,y:(1-p.y)*rect.height/2}});
  };
  for(const [id,entry] of tvPreviews)collect('tv:'+id,entry,entry.item);
  for(const [id,entry] of cameraPreviews){const item=items.find(item=>item.id===id);if(item)collect('camera:'+id,entry,item);else entry.el.hidden=true;}
  const key=[rect.width,rect.height,room,...camera.matrixWorld.elements,...camera.projectionMatrix.elements,...cards.flatMap(c=>[c.id,c.size.width,c.size.height,c.point.x,c.point.y])].join('|');
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
