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
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg'),indicators=new Map();
  svg.classList.add('home-presence-layer');svg.setAttribute('aria-hidden','true');
  for(const room of rooms.filter(r=>Object.values(specs||{}).some(s=>s.room===r.id))){
    const indicator=document.createElementNS(ns,'g');indicator.classList.add('home-presence-indicator');
    indicator.dataset.presenceRoom=room.id;indicator.style.opacity='0';
    // A fixed-size badge beside the room caption denotes room-level evidence,
    // never a person's position or a light cast onto the floor.
    for(const [tag,attributes] of [
      ['circle',{r:10,fill:'#183330','fill-opacity':'.8',stroke:'#83bca9','stroke-opacity':'.4'}],
      ['circle',{cy:-3,r:2,fill:'#9bcfbc'}],
      ['path',{d:'M-4 5V4a4 4 0 0 1 8 0v1',fill:'none',stroke:'#9bcfbc','stroke-width':1.4,'stroke-linecap':'round'}]
    ]){
      const node=document.createElementNS(ns,tag);
      for(const [name,value] of Object.entries(attributes))node.setAttribute(name,value);
      indicator.append(node);
    }
    svg.append(indicator);
    indicators.set(room.id,{indicator,position:new THREE.Vector3(xm(room.label[0]),.06,zm(room.label[1]))});
  }
  container.append(svg);
  return {
    update(items,states,connected,active,selected){
      svg.style.display=active?'':'none';
      for(const [room,{indicator}] of indicators){
        const values=Object.values(presenceEvidence(specs,items,states,connected,room));
        const state=values.includes('presence')?'presence':values.every(v=>v==='quiet')?'quiet':'unknown';
        indicator.dataset.state=state;indicator.style.opacity=state==='presence'?'1':'0';
        indicator.style.display=!selected||selected===room?'':'none';
      }
    },
    render(camera,rect){
      const bounds=`0 0 ${rect.width} ${rect.height}`;
      if(svg.getAttribute('viewBox')!==bounds)svg.setAttribute('viewBox',bounds);
      for(const {indicator,position} of indicators.values()){
        const p=position.clone().project(camera);
        const transform=`translate(${(p.x+1)*rect.width/2} ${(1-p.y)*rect.height/2+22})`;
        if(indicator.getAttribute('transform')!==transform)indicator.setAttribute('transform',transform);
      }
    },
    dispose(){svg.remove();indicators.clear();}
  };
}
if(typeof module!=='undefined')module.exports={presenceState,presenceEvidence,mergePresenceActivity,createPresenceView};
