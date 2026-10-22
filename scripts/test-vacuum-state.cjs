const {test}=require('node:test'),assert=require('node:assert/strict');
const {resolveVacuumPosition,vacuumObservedAt}=require('../vacuum-state.js');
const now=Date.parse('2026-01-01T12:00:00Z');
const spec={id:'cleaner',name:'Cleaner',entity_id:'vacuum.cleaner',position_entity_id:'sensor.cleaner_position',floor_id:'main',map_id:0,transform:[.001,0,1,0,-.001,4],bounds:[0,0,8,8],max_age_seconds:120,calibration:'approximate'};
function states(position={},robot={}){return {'vacuum.cleaner':{state:'cleaning',battery_level:72,...robot},'sensor.cleaner_position':{state:'ready',vacuum_position:{x:1000,y:2000,observed_at:new Date(now).toISOString(),map_id:0,valid:true,...position}}};}
const resolve=(data=states(),options={})=>resolveVacuumPosition(options.spec||spec,data,options.connected??true,options.floor||'main',options.previous,options.now??now);
test('native axes, scale and translation determine metres, with truthful state and battery',()=>{
  const result=resolve();assert.deepEqual(result.position,{x:2,z:2});assert.equal(result.status,'live');assert.equal(result.battery,72);assert.equal(result.robotState,'cleaning');
  assert.equal(result.expiresAt,now+120000);assert.equal(result.ageMs,0);
  assert.equal(resolve(states({}, {battery_level:'72'})).battery,null);
});
test('invalid readings never invent a position, including coercion, future data and wrong maps',()=>{
  for(const position of [{valid:false},{x:'1000'},{x:NaN},{x:Infinity},{y:null},{x:1000000},{map_id:1},{map_id:'0'},{observed_at:now},{observed_at:'2026-01-01 12:00:00'},{observed_at:'invalid'},{observed_at:new Date(now+1).toISOString()}]){
    const result=resolve(states(position));assert.equal(result.status,'unknown',JSON.stringify(position));assert.equal(result.position,null);
  }
  for(const state of ['unknown','unavailable','offline','disconnected','']){
    assert.equal(resolve(states({}, {state})).position,null);
    const data=states();data[spec.position_entity_id].state=state;assert.equal(resolve(data).position,null);
  }
  assert.equal(resolve(states({}, {restored:true})).position,null);
  const data=states();data[spec.position_entity_id].restored=true;assert.equal(resolve(data).position,null);
  assert.equal(resolve({},{}).position,null);assert.equal(resolve(states(),{connected:false}).position,null);
});
test('floor, transform and bounds must be explicit and valid',()=>{
  assert.equal(resolve(states(),{floor:'upstairs'}).position,null);
  for(const change of [{floor_id:undefined},{map_id:null},{transform:[0,0,1,0,0,2]},{transform:[1,2,3]},{bounds:[0,0,0,8]},{max_age_seconds:0},{entity_id:'sensor.cleaner'}])assert.equal(resolve(states(),{spec:{...spec,...change}}).position,null);
  assert.ok(Number.isNaN(vacuumObservedAt('2026-01-01T12:00:00')));
});
test('expiry uses original observation; stale startup is hidden and replay cannot renew it',()=>{
  assert.equal(resolve(states(),{now:now+120000}).position,null,'stale startup is not last known');
  const good=resolve().lastGood;
  const before=resolve(states(),{now:now+119999,previous:good});assert.equal(before.status,'live');
  const after=resolve(states(),{now:now+120000,previous:good});assert.equal(after.status,'last_known');assert.equal(after.reason,'stale');assert.deepEqual(after.position,{x:2,z:2});assert.equal(after.expiresAt,null);
  assert.equal(resolve(states(),{now:now+120001,previous:after.lastGood}).status,'last_known');
});
test('disconnect and invalid data retain only the last accepted position',()=>{
  const good=resolve().lastGood;
  for(const [data,options] of [[states(),{connected:false}],[states({valid:false}),{}],[{},{}]]){
    const result=resolve(data,{previous:good,now:now+10000,...options});assert.equal(result.status,'last_known');assert.deepEqual(result.position,{x:2,z:2});assert.equal(result.ageMs,10000);
  }
  assert.equal(resolve(states(),{previous:good,spec:{...spec,transform:[.002,0,1,0,-.001,4]},connected:false}).position,null,'a changed calibration clears retained coordinates');
  const older=resolve(states({x:2000,observed_at:new Date(now-1000).toISOString()}),{previous:good});assert.equal(older.reason,'older');assert.deepEqual(older.position,{x:2,z:2});
  const changed=resolve(states({x:2000}),{previous:good});assert.equal(changed.reason,'changed_sample');assert.deepEqual(changed.position,{x:2,z:2});
  const fresh=resolve(states({x:2000,observed_at:new Date(now+1000).toISOString()}),{previous:good,now:now+1000});assert.equal(fresh.status,'live');assert.deepEqual(fresh.position,{x:3,z:2});
});
test('a different active map clears the old floor marker instead of presenting it as last known',()=>{
  const good=resolve().lastGood,result=resolve(states({map_id:1}),{previous:good});
  assert.equal(result.reason,'map_changed');assert.equal(result.position,null);assert.equal(result.lastGood,null);
  assert.equal(resolve({}, {previous:result.lastGood}).position,null);
});
test('ISO parsing agrees with the host on real dates, microseconds and timezone offsets',()=>{
  for(const value of ['2026-01-01T12:00:00.123456Z','2024-02-29T23:59:59+14:00','2026-01-01T00:00:00-08:00'])assert.ok(Number.isFinite(vacuumObservedAt(value)),value);
  for(const value of ['2026-02-29T12:00:00Z','2026-04-31T12:00:00Z','1969-12-31T23:59:59Z','2026-00-01T12:00:00Z','2026-01-00T12:00:00Z','2026-01-01T24:00:00Z','2026-01-01T12:60:00Z','2026-01-01T12:00:60Z','2026-01-01T12:00:00+14:01','2026-01-01T12:00:00+15:00','2026-01-01T12:00:00+00:60','2026-01-01T12:00:00.1234567Z'])assert.ok(Number.isNaN(vacuumObservedAt(value)),value);
});
test('retrieval-only sources are reported positions and never acquire an invented observation time',()=>{
  const position={observed_at:null,retrieved_at:new Date(now).toISOString(),timestamp_quality:'not_provided'};
  const result=resolve(states(position));assert.equal(result.status,'reported');assert.equal(result.observationKnown,false);
  assert.equal(result.lastGood.observedAt,null);assert.equal(result.lastGood.retrievedAt,now);assert.deepEqual(result.position,{x:2,z:2});
  const expired=resolve(states(position),{previous:result.lastGood,now:now+120000});assert.equal(expired.status,'last_known');assert.equal(expired.observationKnown,false);assert.equal(expired.ageMs,120000);
  assert.equal(resolve(states(position),{now:now+120000}).position,null,'an old retrieval is not a known current position at startup');
  for(const change of [{timestamp_quality:undefined},{timestamp_quality:'observed'},{observed_at:'invalid'},{observed_at:undefined},{retrieved_at:now},{retrieved_at:new Date(now+1).toISOString()}])assert.equal(resolve(states({...position,...change})).position,null,JSON.stringify(change));
  const moved=resolve(states({...position,retrieved_at:new Date(now+1000).toISOString(),x:2000}),{previous:result.lastGood,now:now+1000});
  assert.equal(moved.status,'reported');assert.deepEqual(moved.position,{x:3,z:2});assert.equal(moved.lastGood.observedAt,null);
});
