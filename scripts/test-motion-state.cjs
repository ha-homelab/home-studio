const {test}=require('node:test'),assert=require('node:assert/strict');
const {nextMotionRoom,motionReadings,decorativeMotionPath}=require('../motion-state.js');
const item={id:'receiver',entity_id:'binary_sensor.receiver',room:'kitchen'},other={id:'other',entity_id:'binary_sensor.other',room:'kitchen'};
const model={inventory:[item,other],receiver_activity:{receiver:{},other:{}}};
const channel=(presence,motion)=>({presence,motion,coverage:'unverified'});
test('held presence cannot suppress separate motion edges or another source',()=>{
  const a={},b={};
  const observe=(source,point,presence,motion)=>{
    const [reading]=motionReadings(source,model,{}, {kitchen:{[source.id]:channel(presence,motion)}},true);
    return nextMotionRoom(point,reading.state,reading.room,true);
  };
  assert.equal(observe(item,a,'on','on'),null,'initial ON is not an event');
  assert.equal(observe(item,a,'on','off'),null);
  assert.equal(observe(item,a,'on','on'),'kitchen');
  assert.equal(observe(item,a,'on','on'),null);
  observe(other,b,'on','off');
  assert.equal(observe(other,b,'on','on'),'kitchen','second source has its own edge');
  observe(item,a,'on','off');assert.equal(observe(item,a,'on','on'),'kitchen');
  observe(item,a,'on','unknown');assert.equal(observe(item,a,'on','on'),null,'unknown never rearms');
  observe(item,a,'off','off');assert.equal(observe(item,a,'off','on'),'kitchen','motion is independent of the presence channel');
});
test('disconnect, rebinding, unresolved rooms and unconfigured occupancy do not invent movement',()=>{
  const channels={kitchen:{receiver:channel('on','on')}};
  assert.equal(motionReadings(item,model,{},channels,false)[0].state,'unknown');
  assert.equal(motionReadings({...item,room:'elsewhere'},model,{},channels,true)[0].state,'unknown');
  assert.equal(motionReadings(item,model,{}, {},true)[0].state,'unknown');
  assert.deepEqual(motionReadings(item,model,{}, {kitchen:{receiver:{...channel('on','unknown'),motion_configured:false}}},true),[]);
  assert.equal(motionReadings(item,model,{}, {...channels,other:{receiver:channel('on','on')}},true)[0].state,'unknown','multiple positive rooms cannot locate an event');
  const tracker={};nextMotionRoom(tracker,'off','kitchen',true);
  nextMotionRoom(tracker,'on','kitchen',false);assert.equal(nextMotionRoom(tracker,'on','kitchen',true),null);
});
test('legacy paths use motion entities, not held occupancy companions',()=>{
  const legacy={inventory:[item],motion_sources:{[item.entity_id]:['binary_sensor.movement','binary_sensor.occupancy']},motion_paths:{receiver:[[0,0],[1,0]]}};
  const states={'binary_sensor.movement':{state:'off',device_class:'motion'},'binary_sensor.occupancy':{state:'on',device_class:'occupancy'}};
  assert.deepEqual(motionReadings(item,legacy,states,{},true),[{key:'entity:binary_sensor.movement',state:'off',room:'kitchen'}]);
  states['binary_sensor.movement'].state='on';assert.equal(motionReadings(item,legacy,states,{},true)[0].state,'on');
  states['binary_sensor.movement'].restored=true;assert.equal(motionReadings(item,legacy,states,{},true)[0].state,'unknown');
});
test('decorative fallback is bounded within a contiguous room span',()=>{
  assert.deepEqual(decorativeMotionPath([[0,0],[4,0],[4,4],[0,4]]),[[1.45,2],[2.55,2]]);
  const path=decorativeMotionPath([[0,0],[1,0],[1,3],[3,3],[3,0],[4,0],[4,4],[0,4]]);
  assert(path.every(([x,z])=>x>0&&x<1&&z===2),'concave gap is not used as a route');
  assert.equal(decorativeMotionPath([[0,0],[.1,0],[.1,1],[0,1]]),null);
});
