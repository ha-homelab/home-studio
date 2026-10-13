// A held presence report is not motion, a location, a count, or a pulse reading.
function presenceState(item,spec,states,connected){
  if(!item||item.entity_id!==spec.entity_id||item.room!==spec.room)return 'unbound';
  const value=states[spec.entity_id];
  if(!connected||!value||value.restored)return 'unknown';
  return value.state==='on'?'presence':value.state==='off'?'quiet':'unknown';
}
function presenceEvidence(specs,items,states,connected,room){
  return Object.fromEntries(Object.entries(specs||{}).filter(([,s])=>s.room===room)
    .map(([id,s])=>[id,presenceState(items.find(i=>i.id===id),s,states,connected)]));
}
function mergePresenceActivity(base,evidence){
  if(base&&!['motion','presence','quiet','experimental','unknown'].includes(base))base='unknown';
  if(base==='motion')return base;
  const values=Object.values(evidence);
  if(values.includes('presence'))return 'presence';
  return base|| (values.length&&values.every(v=>v==='quiet')?'quiet':'unknown');
}
function createPresenceView(container,rooms,specs,THREE,xm,zm){
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg'),paths=new Map();
  svg.classList.add('home-presence-layer');svg.setAttribute('aria-hidden','true');
  const defs=document.createElementNS(ns,'defs'),gradient=document.createElementNS(ns,'radialGradient');
  gradient.id='presence-room-glow';gradient.setAttribute('r','75%');
  for(const [offset,opacity] of [['0%','.52'],['65%','.36'],['100%','.16']]){
    const stop=document.createElementNS(ns,'stop');stop.setAttribute('offset',offset);
    stop.setAttribute('stop-color','#36e7df');stop.setAttribute('stop-opacity',opacity);gradient.append(stop);
  }
  defs.append(gradient);svg.append(defs);
  for(const room of rooms.filter(r=>Object.values(specs||{}).some(s=>s.room===r.id))){
    const path=document.createElementNS(ns,'polygon');path.dataset.presenceRoom=room.id;
    path.setAttribute('fill','url(#presence-room-glow)');path.style.opacity='0';svg.append(path);
    paths.set(room.id,{path,vertices:room.polygon.map(([x,z])=>new THREE.Vector3(xm(x),.05,zm(z)))});
  }
  container.append(svg);
  return {
    update(items,states,connected,active,selected){
      svg.style.display=active?'':'none';
      for(const [room,{path}] of paths){
        const values=Object.values(presenceEvidence(specs,items,states,connected,room));
        const state=values.includes('presence')?'presence':values.every(v=>v==='quiet')?'quiet':'unknown';
        path.dataset.state=state;path.style.opacity=state==='presence'?'1':'0';
        path.style.display=!selected||selected===room?'':'none';
      }
    },
    render(camera,rect){
      const bounds=`0 0 ${rect.width} ${rect.height}`;
      if(svg.getAttribute('viewBox')!==bounds)svg.setAttribute('viewBox',bounds);
      for(const {path,vertices} of paths.values()){
        const points=vertices.map(v=>{
        const p=v.clone().project(camera);return `${(p.x+1)*rect.width/2},${(1-p.y)*rect.height/2}`;
        }).join(' ');
        if(path.getAttribute('points')!==points)path.setAttribute('points',points);
      }
    },
    dispose(){svg.remove();paths.clear();}
  };
}
if(typeof module!=='undefined')module.exports={presenceState,presenceEvidence,mergePresenceActivity,createPresenceView};
