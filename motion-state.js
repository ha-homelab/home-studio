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
if(typeof module!=='undefined')module.exports={resolveMotionState,nextMotionRoom,resolveMotionRoom};
