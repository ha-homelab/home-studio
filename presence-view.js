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
  if(base==='quiet'&&values.some(value=>value==='unknown'||value==='unbound'))return 'unknown';
  return base|| (values.length&&values.every(v=>v==='quiet')?'quiet':'unknown');
}
// HA owns source freshness. Update timestamps never renew a browser lease.
function roomActivityChannels(reading,items,originals,connected){
  const channels=reading?.activity?.channels;
  if(!connected||reading?.restored||!['motion','presence','quiet','experimental','unknown'].includes(reading?.state)||!channels||typeof channels!=='object'||Array.isArray(channels)||Object.keys(channels).length>64)return {};
  return Object.fromEntries(Object.entries(channels).map(([id,value])=>{
    const item=items.find(item=>item.id===id),original=originals.find(item=>item.id===id);
    const bound=item&&original&&item.entity_id===original.entity_id&&item.room===original.room;
    const state=key=>bound&&['on','off'].includes(value?.[key])?value[key]:'unknown';
    return [id,{presence:state('presence'),motion:state('motion'),coverage:value?.coverage==='validated'?'validated':'unverified',
      presence_configured:value?.presence_configured!==false,motion_configured:value?.motion_configured!==false}];
  }));
}
function roomPresence(evidence,channels){
  const values=[...Object.values(evidence).map(value=>value==='presence'?'on':value==='quiet'?'off':'unknown'),...Object.values(channels).filter(value=>value.presence_configured!==false).map(value=>value.presence)];
  return values.includes('on')?'presence':values.length&&values.every(value=>value==='off')?'quiet':'unknown';
}
function createPresenceView(container,rooms,specs,THREE,xm,zm,roomSensors={}){
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg'),indicators=new Map();
  svg.classList.add('home-presence-layer');svg.setAttribute('aria-hidden','true');
  for(const room of rooms.filter(r=>roomSensors[r.id]||Object.values(specs||{}).some(s=>s.room===r.id))){
    if(!Array.isArray(room.polygon)||room.polygon.length<3)continue;
    const indicator=document.createElementNS(ns,'polygon');indicator.classList.add('home-presence-indicator');
    indicator.dataset.presenceRoom=room.id;indicator.style.opacity='0';
    // A room overlay, not a person location or a physical HA light.
    indicator.setAttribute('vector-effect','non-scaling-stroke');
    svg.append(indicator);
    indicators.set(room.id,{indicator,polygon:room.polygon.map(([x,z])=>new THREE.Vector3(xm(x),.04,zm(z)))});
  }
  container.append(svg);
  const setVisible=active=>{const display=active?'':'none';if(svg.style.display!==display)svg.style.display=display;};
  return {
    setVisible,
    update(items,states,connected,active,selected,channelsByRoom={}){
      setVisible(active);
      for(const [room,{indicator}] of indicators){
        const channels=connected?channelsByRoom[room]||{}:{};
        const evidence=presenceEvidence(specs,items,states,connected,room);
        if(roomSensors[room]&&!Object.keys(channels).length)evidence.__room_sensor='unknown';
        const state=roomPresence(evidence,channels);
        indicator.dataset.state=state;indicator.style.opacity=state==='presence'?'1':'0';
        indicator.dataset.coverage=state!=='presence'?'unknown':Object.values(channels).some(value=>value.presence==='on'&&value.coverage!=='validated')?'unverified':'validated';
        indicator.style.display=!selected||selected===room?'':'none';
      }
    },
    render(camera,rect){
      const bounds=`0 0 ${rect.width} ${rect.height}`;
      if(svg.getAttribute('viewBox')!==bounds)svg.setAttribute('viewBox',bounds);
      for(const {indicator,polygon} of indicators.values()){
        const points=polygon.map(position=>{const p=position.clone().project(camera);return `${(p.x+1)*rect.width/2},${(1-p.y)*rect.height/2}`;}).join(' ');
        if(indicator.getAttribute('points')!==points)indicator.setAttribute('points',points);
      }
    },
    dispose(){svg.remove();indicators.clear();}
  };
}
if(typeof module!=='undefined')module.exports={presenceState,presenceEvidence,mergePresenceActivity,roomActivityChannels,roomPresence,createPresenceView};
