// Native map coordinates are admitted only through an explicit floor calibration.
function vacuumSourceKey(spec,floorId){
  if(!spec||typeof spec.id!=='string'||!spec.id||typeof floorId!=='string'||spec.floor_id!==floorId||
    !/^vacuum\.[a-z0-9_]+$/.test(spec.entity_id||'')||!/^sensor\.[a-z0-9_]+$/.test(spec.position_entity_id||'')||
    !['string','number'].includes(typeof spec.map_id)||spec.map_id===''||typeof spec.map_id==='number'&&!Number.isFinite(spec.map_id)||
    !Array.isArray(spec.transform)||spec.transform.length!==6||!spec.transform.every(Number.isFinite)||
    !Array.isArray(spec.bounds)||spec.bounds.length!==4||!spec.bounds.every(Number.isFinite)||
    spec.bounds[0]>=spec.bounds[2]||spec.bounds[1]>=spec.bounds[3])return null;
  const [a,b,,d,e]=spec.transform;
  if(Math.abs(a*e-b*d)<1e-15)return null;
  const maxAge=spec.max_age_seconds??120;
  if(!Number.isFinite(maxAge)||maxAge<=0||maxAge>86400)return null;
  return JSON.stringify([spec.id,spec.entity_id,spec.position_entity_id,spec.floor_id,spec.map_id,spec.transform,spec.bounds,maxAge]);
}
function vacuumObservedAt(value){
  // Match the host's ISO contract, including real calendar dates and microseconds.
  if(typeof value!=='string'||value.length>35)return NaN;
  const parts=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if(!parts)return NaN;
  const [,year,month,day,hour,minute,second,zone]=parts,date=new Date(Date.UTC(+year,+month-1,+day));
  const valid=+year>=1970&&date.getUTCFullYear()===+year&&date.getUTCMonth()===+month-1&&date.getUTCDate()===+day&&
    +hour<24&&+minute<60&&+second<60&&(zone==='Z'||(+zone.slice(1,3)<=14&&+zone.slice(4)<60&&(+zone.slice(1,3)<14||+zone.slice(4)===0)));
  return valid?Date.parse(value):NaN;
}
function resolveVacuumPosition(spec,states,connected,floorId,previous,now=Date.now()){
  const key=vacuumSourceKey(spec,floorId),robot=states?.[spec?.entity_id],reading=states?.[spec?.position_entity_id];
  let lastGood=key&&previous?.key===key?previous:null,reason='unavailable';
  const available=value=>value&&!value.restored&&typeof value.state==='string'&&value.state.trim()&&
    !['unknown','unavailable','offline','disconnected'].includes(value.state.trim().toLowerCase());
  const robotValid=connected&&available(robot);
  const battery=robotValid&&Number.isFinite(robot.battery_level)&&robot.battery_level>=0&&robot.battery_level<=100?Math.round(robot.battery_level):null;
  if(!key)reason='unconfigured';
  else if(!connected)reason='disconnected';
  else if(!robotValid||!available(reading))reason='unavailable';
  else{
    const position=reading.vacuum_position;
    const observationKnown=position?.observed_at!==null;
    const timestampQuality=observationKnown?'observed':position?.timestamp_quality;
    const observedAt=observationKnown?vacuumObservedAt(position?.observed_at):null;
    const retrievedAt=!observationKnown&&timestampQuality==='not_provided'?vacuumObservedAt(position?.retrieved_at):null;
    const sampleAt=observationKnown?observedAt:retrievedAt;
    if(!position||position.valid!==true||!Number.isFinite(position.x)||!Number.isFinite(position.y)||!Number.isFinite(sampleAt)||!Number.isFinite(now))reason='invalid';
    else if(position.map_id!==spec.map_id){lastGood=null;reason='map_changed';}
    else if(sampleAt>now)reason='future';
    else{
      const [a,b,c,d,e,f]=spec.transform,x=a*position.x+b*position.y+c,z=d*position.x+e*position.y+f;
      // Retrieval freshness is not observation freshness. Its marker remains
      // explicitly "reported" for sources that do not provide observation time.
      const expiresAt=sampleAt+(spec.max_age_seconds??120)*1000;
      const [minX,minZ,maxX,maxZ]=spec.bounds;
      if(!Number.isFinite(x)||!Number.isFinite(z)||x<minX||x>maxX||z<minZ||z>maxZ)reason='outside';
      else if(lastGood&&timestampQuality===lastGood.timestampQuality&&sampleAt<lastGood.sampleAt)reason='older';
      else if(lastGood&&timestampQuality===lastGood.timestampQuality&&sampleAt===lastGood.sampleAt&&(x!==lastGood.x||z!==lastGood.z))reason='changed_sample';
      else if(now>=expiresAt)reason='stale';
      else{lastGood={key,x,z,observedAt,retrievedAt,timestampQuality,sampleAt,expiresAt};reason=observationKnown?'live':'reported';}
    }
  }
  const current=['live','reported'].includes(reason);
  return {lastGood,position:lastGood?{x:lastGood.x,z:lastGood.z}:null,status:current?reason:lastGood?'last_known':'unknown',reason,
    ageMs:lastGood?Math.max(0,now-lastGood.sampleAt):null,observationKnown:lastGood?.timestampQuality==='observed',expiresAt:current?lastGood.expiresAt:null,
    robotState:robotValid?robot.state:connected?'Unavailable':'Disconnected',battery};
}
function vacuumAgeText(ageMs){
  const seconds=Math.floor(Math.max(0,ageMs)/1000);
  if(seconds<60)return seconds+'s ago';
  if(seconds<3600)return Math.floor(seconds/60)+'m ago';
  if(seconds<86400)return Math.floor(seconds/3600)+'h ago';
  return Math.floor(seconds/86400)+'d ago';
}
if(typeof module!=='undefined')module.exports={vacuumSourceKey,vacuumObservedAt,resolveVacuumPosition,vacuumAgeText};
