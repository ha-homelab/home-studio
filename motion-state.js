// One device may report overlapping motion/person events. Missing is not clear.
function resolveMotionState(entityIds, states) {
  const values=entityIds.map(id=>states[id]?.restored?'unavailable':states[id]?.state);
  return values.includes('on')?'on':values.length&&values.every(value=>value==='off')?'off':values.every(value=>value===undefined)?'missing':'unavailable';
}
// A continuous detection may cross rooms, but never replay on startup/reconnect.
function nextMotionRoom(point,state,room,active){
  if(!active||state!=='on'){point.motionArmed=active&&state==='off';point.motionRoom=null;return null;}
  if(!point.motionArmed||!room||point.motionRoom===room)return null;
  point.motionRoom=room;return room;
}
function resolveMotionRoom(zones,reading,now=Date.now()){
  const age=now-Date.parse(reading?.last_updated);
  // This backend owns freshness.
  return !reading?.restored&&age>=0&&(age<8000||zones.backend_freshness===true)&&Object.hasOwn(zones.paths,reading?.state)?reading.state:null;
}
// Independent source edges keep held presence from masking later movement.
function motionReadings(item,model,states,channelsByRoom,connected){
  const original=model.inventory.find(value=>value.id===item.id);
  const bound=original&&original.entity_id===item.entity_id&&original.room===item.room;
  const rows=Object.entries(channelsByRoom).filter(([,channels])=>Object.hasOwn(channels,item.id));
  if(rows.length||model.receiver_activity?.[item.id]){
    const applicable=rows.filter(([,channels])=>channels[item.id].motion_configured!==false);
    if(rows.length&&!applicable.length)return [];
    const moving=applicable.filter(([,channels])=>channels[item.id].motion==='on');
    const state=!connected||!bound?'unknown':moving.length===1?'on':applicable.length&&applicable.every(([,channels])=>channels[item.id].motion==='off')?'off':'unknown';
    return [{key:'item:'+item.id,state,room:moving.length===1?moving[0][0]:item.room}];
  }
  if(model.presence_sources?.[item.id])return [];
  const sources=model.motion_sources?.[item.entity_id]||[item.entity_id];
  return sources.filter(id=>states[id]?.device_class==='motion'||sources.length===1&&model.motion_paths?.[item.id]&&!states[id]?.device_class).map(id=>({
    key:'entity:'+id,
    state:connected&&bound&&!states[id]?.restored&&['on','off'].includes(states[id]?.state)?states[id].state:'unknown',
    room:model.motion_zones?.[item.id]?resolveMotionRoom(model.motion_zones[item.id],states[model.motion_zones[item.id].entity_id]):item.room,
  }));
}
// Used only when a source has no saved decorative route. The short line is a
// room-level activity symbol; it is never a measured human coordinate/track.
function decorativeMotionPath(polygon){
  if(!polygon?.length)return null;
  const zs=polygon.map(p=>p[1]),z=(Math.min(...zs)+Math.max(...zs))/2;
  const crossings=[];
  for(let i=0;i<polygon.length;i++){
    const a=polygon[i],b=polygon[(i+1)%polygon.length];
    if((a[1]>z)!==(b[1]>z))crossings.push(a[0]+(z-a[1])*(b[0]-a[0])/(b[1]-a[1]));
  }
  crossings.sort((a,b)=>a-b);
  let span=null;
  for(let i=0;i+1<crossings.length;i+=2)if(!span||crossings[i+1]-crossings[i]>span[1]-span[0])span=[crossings[i],crossings[i+1]];
  if(!span||span[1]-span[0]<.2)return null;
  const x=(span[0]+span[1])/2,half=Math.min(.55,(span[1]-span[0])*.3);
  return [[x-half,z],[x+half,z]];
}
if(typeof module!=='undefined')module.exports={resolveMotionState,nextMotionRoom,resolveMotionRoom,motionReadings,decorativeMotionPath};
