// Exercise the actual HA gateway. No network or real device calls.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../custom_components/home_floorplan/static/panel.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  let Panel;const sent=[],calls=[];
  const context={HTMLElement:class{},customElements:{get(){},define(name,type){Panel=type;}},
    location:{search:''},localStorage:{getItem(){return null;}},URLSearchParams};
  vm.runInNewContext(source,context);
  const panel=Object.assign(Object.create(Panel.prototype),{generation:1,isConnected:true,dryRun:false,dryRunEpoch:0,
    pending:0,failed:false,serverCanEdit:true,readableEntities:new Set(['media_player.speaker']),controllableEntities:new Set(['media_player.speaker']),commands:new Set(),savedItems:[{id:'speaker',entity_id:'media_player.speaker'}],
    port:{postMessage(message){sent.push(plain(message));}},
    _hass:{user:{id:'admin',is_admin:true},connection:{},connected:true,states:{'media_player.speaker':{state:'playing',attributes:{supported_features:1|4|16|32|4096|16384}}},
      async callService(...args){calls.push(plain(args));}}});
  panel.noticeKey=()=>{};
  return {panel,sent,calls,send(overrides={}){panel.handleViewerMessage({type:'media_command',request_id:'media_1',entity_id:'media_player.speaker',action:'media_pause',...overrides},panel.generation);}};
}
test('media transport uses only the saved entity and exact action, and percent volume is converted once',async()=>{
  const f=fixture();
  for(const action of ['media_pause','media_play','media_stop','media_next_track','media_previous_track']){f.send({action});await flush();assert.equal(f.sent.at(-1).ok,true);}
  for(const value of [0,37,100]){f.send({action:'volume_set',value});await flush();assert.deepEqual(f.calls.at(-1),['media_player','volume_set',{entity_id:'media_player.speaker',volume_level:value/100}]);}
  assert.equal(f.calls.length,8);assert.equal(f.panel.commands.size,0);
});
test('unknown actions, unsupported features, invalid volume and unbound targets never call a service',async()=>{
  const f=fixture();
  for(const change of [{action:'turn_on'},{action:'__proto__'},{entity_id:'media_player.other'},
    ...[-1,101,NaN,Infinity,'50',null,{},1.5].map(value=>({action:'volume_set',value})),
    {action:'media_play',value:20},{request_id:'bad!'}]){f.send(change);await flush();}
  f.panel._hass.states['media_player.speaker'].attributes.supported_features=0;f.send();await flush();
  assert.deepEqual(f.calls,[]);
});
test('busy, missing, stale, disconnected and unsaved placements block media actions',async()=>{
  for(const mutate of [p=>p.pending=1,p=>p.failed=true,p=>p._hass.connected=false,
    p=>p._hass.states['media_player.speaker'].attributes.restored=true,
    p=>p._hass.states['media_player.speaker'].state='unavailable',p=>p._hass.states['media_player.speaker'].state='off',
    p=>delete p._hass.states['media_player.speaker'],p=>p.commands.add('media_player.speaker')]){
    const f=fixture();mutate(f.panel);f.send();await flush();assert.equal(f.calls.length,0);assert.equal(f.sent.at(-1).ok,false);
  }
});
test('dry run and dispatch-time account, binding, capability and connection changes invalidate queued actions',async()=>{
  for(const mutate of [p=>p.dryRun=true,p=>p.dryRunEpoch++,p=>p.generation++,p=>p.isConnected=false,
    p=>p.savedItems=[],p=>p._hass.user={id:'other'},p=>p._hass.connection={},p=>p._hass.connected=false,
    p=>p._hass.states['media_player.speaker'].attributes.supported_features=0]){
    const f=fixture();f.send();mutate(f.panel);await flush();assert.equal(f.calls.length,0);assert.equal(f.panel.commands.size,0);
  }
});
test('double click sends one action; failures return actionable bounded feedback',async()=>{
  const f=fixture();f.panel._hass.callService=async()=>{throw Error('Device rejected command');};
  f.send();f.send({request_id:'media_2'});await flush();
  assert.match(f.sent.find(v=>v.request_id==='media_2').error,/progress/);
  assert.match(f.sent.find(v=>v.request_id==='media_1').error,/Device rejected/);assert.equal(f.panel.commands.size,0);
});

test('large HA catalog does not forward unrelated raw states; explicit display dependencies survive',()=>{
  const f=fixture(),p=f.panel;
  p.scopedStates=true;
  p.curtains={profiles:{'cover.shade':{guard:'switch.motor'}},power:{},memory:{}};
  p.refreshTVFrame=p.refreshCameraFrames=p.refreshMediaArtwork=()=>{};
  const entity=(state,attributes={})=>({state,attributes});
  for(let i=0;i<5500;i++)p._hass.states['text.unrelated_'+i]=entity('SECRET VALUE '+i,{friendly_name:'Device '+i});
  p._hass.states['sensor.temperature']=entity('-8.5',{unit_of_measurement:'°C',device_class:'temperature'});
  p._hass.states['cover.shade']=entity('closed');p._hass.states['switch.motor']=entity('off');
  p._hass.states['sensor.zone']=entity('quiet');p._hass.states['sun.sun']=entity('above_horizon',{elevation:42});
  p._hass.states['climate.room']=entity('heat',{current_temperature:18,temperature:21,hvac_action:'heating',unsafe:'SECRET'});
  p._hass.config={unit_system:{temperature:'°C'}};
  p.savedItems.push({entity_id:'sensor.temperature'},{entity_id:'cover.shade'},{entity_id:'climate.room'});
  p.displayEntities=new Set(['sensor.zone']);p.readableEntities=new Set(Object.keys(p._hass.states));p.publishEntityStates();
  const catalog=f.sent.find(m=>m.type==='entity_catalog'),snapshot=f.sent.at(-1);
  assert.equal(catalog.entities.length,5507);assert.equal(Object.keys(snapshot.states).length,7);
  assert.doesNotMatch(JSON.stringify(f.sent),/SECRET|unsafe/);
  assert.equal(snapshot.states['sensor.temperature'].state,'-8.5');assert.equal(snapshot.states['switch.motor'].state,'off');
  assert.equal(snapshot.states['climate.room'].climate.temperature,21);assert.equal(snapshot.states['climate.room'].climate.temperature_unit,'°C');
  assert.equal(snapshot.states['media_player.speaker'].media.supported_features,20533);
  p.publishEntityStates();assert.equal(f.sent.filter(m=>m.type==='entity_catalog').length,1);
  assert.ok(JSON.stringify(snapshot).length<3000,'Only the bound and declared display states travel with each update');
});

// Include the real save path and its Blob limit without changing the command-only fixture.
function stateFixture(){
  let Panel;const sent=[],writes=[];
  vm.runInNewContext(source,{Blob,HTMLElement:class{},customElements:{get(){},define(name,type){Panel=type;}},localStorage:{getItem(){return null;}}});
  const panel=Object.assign(Object.create(Panel.prototype),{generation:1,isConnected:true,started:true,dryRun:false,dryRunEpoch:0,
    pending:0,failed:false,serverCanEdit:true,readableEntities:new Set(['media_player.speaker','light.unbound','sensor.room_activity']),controllableEntities:new Set(['media_player.speaker','light.unbound']),queue:Promise.resolve(),commands:new Set(),floor:'main',revision:1,tvFrameCache:{},viewPreferences:{language:'en'},
    savedItems:[{id:'speaker',entity_id:'media_player.speaker'}],curtains:{profiles:{},power:{},memory:{}},
    port:{postMessage(message){sent.push(plain(message));}},notice(){},noticeKey(){},notifySaveStatus(){},updateAccessUI(){},
    refreshTVFrame(){},refreshCameraFrames(){},refreshMediaArtwork(){},clearMediaArtwork(){},
    _hass:{user:{id:'fictional_admin',is_admin:true},connection:{},connected:true,states:{
      'media_player.speaker':{state:'playing',attributes:{friendly_name:'Fictional speaker',supported_features:16384}},
      'light.unbound':{state:'off',attributes:{friendly_name:'Unbound fictional lamp'}},
      'sensor.room_activity':{state:'motion',attributes:{evidence:{sample:'motion'}}},
    },async callWS(message){writes.push(plain(message));return {revision:2,readable_entities:Object.keys(this.states),controllable_entities:Object.keys(this.states)};}}});
  panel.resetModelConfig();
  return {panel,sent,writes,configure(extra={}){panel.handleViewerMessage({type:'model_config',...extra},panel.generation);},
    snapshot(){return sent.filter(message=>message.type==='states').at(-1);},catalogs(){return sent.filter(message=>message.type==='entity_catalog');}};
}

test('legacy compiled viewers retain unbound picker states and configured activity without a new catalog contract',()=>{
  for(const compatibility of [{},{state_entities:null},{state_entities:'sensor.room_activity'}]){
    const f=stateFixture();
    f.configure({...compatibility,room_activity:{studio:'sensor.room_activity'}});
    assert.equal(f.panel.scopedStates,false);
    assert.deepEqual(Object.keys(f.snapshot().states).sort(),['light.unbound','media_player.speaker','sensor.room_activity']);
    assert.equal(f.snapshot().states['sensor.room_activity'].activity.evidence.sample,'motion');
    assert.equal(f.catalogs().length,0,'older viewers obtain picker options from the states message');
  }
});

test('the actual viewer collector retains all display dependencies even after a large geometry payload',()=>{
  const viewer=fs.readFileSync(path.join(__dirname,'../viewer.js'),'utf8');
  const start=viewer.indexOf('const stateEntities=new Set()'),end=viewer.indexOf("bridge.postMessage({type:'model_config'",start);
  assert.ok(start>=0&&end>start,'the model-config collector exists');
  const model={meshes:[{vertices:Array.from({length:100010},(_,i)=>i)}],inventory:[{entity_id:'light.original_inventory'}],
    tv_entities:{tv:'media_player.television'},camera_entities:{camera:'binary_sensor.camera_motion'},
    room_activity:{studio:'sensor.room_activity'},
    receiver_activity:{receiver:{entity_id:'binary_sensor.receiver',sensor:'sensor.receiver_activity',modules_sensor:'sensor.receiver_modules'}},
    assumed_activity:{sensor:'sensor.signal_activity'},motion_sources:{'binary_sensor.camera_motion':['binary_sensor.person','binary_sensor.motion']},
    motion_zones:{camera:{entity_id:'sensor.motion_room',paths:{studio:[[0,0],[1,1]]}}},
    telemetry:[{metrics:[{entity_id:'sensor.temperature'}]}],power_labels:[{entity_id:'sensor.power'}],
    notes:'sensor.unrelated_note'};
  const context={model};vm.runInNewContext(viewer.slice(start,end)+'\nglobalThis.result=[...stateEntities];',context);
  const expected=['media_player.television','binary_sensor.camera_motion','sensor.room_activity','binary_sensor.receiver','sensor.receiver_activity','sensor.receiver_modules','sensor.signal_activity','binary_sensor.person','binary_sensor.motion','sensor.motion_room','sensor.temperature','sensor.power'].sort();
  assert.deepEqual(plain(context.result).sort(),expected,'geometry and unrelated text cannot exhaust or expand the dependency list');
  const f=stateFixture();for(const id of expected){f.panel._hass.states[id]={state:'on',attributes:{}};f.panel.readableEntities.add(id);}
  f.configure({state_entities:[...context.result,'invalid reference',null]});
  assert.equal(f.panel.scopedStates,true);assert.equal(f.catalogs().length,1);
  assert.deepEqual(Object.keys(f.snapshot().states).sort(),[...expected,'media_player.speaker'].sort());
  assert.equal(f.snapshot().states['light.unbound'],undefined);
  assert.ok(f.catalogs()[0].entities.some(([id])=>id==='light.unbound'),'unbound picker choices remain available without raw state');
});

test('a successful saved binding immediately republishes its state without waiting for an HA update',async()=>{
  const f=stateFixture(),p=f.panel;
  p._hass.states['sensor.new_binding']={state:'21.5',attributes:{unit_of_measurement:'°C'}};
  f.configure({state_entities:[]});assert.equal(f.snapshot().states['sensor.new_binding'],undefined);
  let complete;p._hass.callWS=message=>{f.writes.push(plain(message));return new Promise(resolve=>complete=resolve);};
  const items=[{id:'thermometer',entity_id:'sensor.new_binding'}];
  p.handleViewerMessage({type:'save',items},p.generation);await flush();
  assert.equal(p.pending,1);assert.equal(f.snapshot().states['sensor.new_binding'],undefined,'an unconfirmed binding does not expand live state');
  complete({revision:2,readable_entities:['sensor.new_binding'],controllable_entities:[]});await p.queue;
  assert.equal(p.pending,0);assert.equal(p.failed,false);assert.equal(p.revision,2);
  assert.equal(f.snapshot().states['sensor.new_binding'].state,'21.5');assert.equal(f.snapshot().states['sensor.new_binding'].unit,'°C');
  assert.equal(f.snapshot().states['media_player.speaker'],undefined,'the removed binding is withdrawn in the same snapshot');
  assert.deepEqual(f.writes,[{type:'home_floorplan/save',floor:'main',revision:1,items}]);
  assert.equal(f.catalogs().length,1,'saving does not resend the full picker catalog');
});

test('catalogs refresh for a replacement connection and floor while routine state updates stay compact',()=>{
  const f=stateFixture(),p=f.panel;f.configure({state_entities:[]});assert.equal(f.catalogs().length,1);
  p.hass={...p._hass,states:{...p._hass.states,'sensor.new_choice':{state:'17',attributes:{friendly_name:'New fictional choice'}}}};
  assert.equal(f.catalogs().length,1);
  p.hass={...p._hass,connection:{}};assert.equal(f.catalogs().length,2);
  assert.ok(f.catalogs()[1].entities.some(([id])=>id==='sensor.new_choice'));
  p.resetModelConfig();f.configure({state_entities:[]});assert.equal(f.catalogs().length,3,'the next floor negotiates and publishes a fresh catalog');
});


test('family viewers get only server-permitted states and cannot widen scope or edit',async()=>{
  const f=stateFixture(),p=f.panel;
  p._hass.user={id:'family',is_admin:false};p.serverCanEdit=false;
  p.readableEntities=new Set(['media_player.speaker']);
  p.controllableEntities=new Set(['media_player.speaker']);
  f.configure({state_entities:['light.unbound','sensor.room_activity'],room_activity:{studio:'sensor.room_activity'}});
  assert.deepEqual(Object.keys(f.snapshot().states),['media_player.speaker']);
  assert.deepEqual(f.snapshot().states['media_player.speaker'].can_control,true);
  assert.equal(f.catalogs().length,0);
  p.handleViewerMessage({type:'view_preferences',can_edit:true,editLocked:false},p.generation);
  p.handleViewerMessage({type:'save',items:[]},p.generation);
  p.handleViewerMessage({type:'export',format:'glb'},p.generation);
  await p.downloadModel('glb');await p.queue;
  assert.equal(p.canEdit,false);assert.deepEqual(f.writes,[]);assert.equal(p.pending,0);
});

test('a server edit grant never elevates a family account and a card lock overrides an administrator',async()=>{
  for(const family of [true,false]){
    const f=stateFixture(),p=f.panel;
    p._hass.user.is_admin=!family;p.serverCanEdit=true;p.editLocked=!family;
    p.handleViewerMessage({type:'save',items:[]},p.generation);
    p.handleViewerMessage({type:'export',format:'obj'},p.generation);
    await p.queue;assert.equal(p.canEdit,false);assert.deepEqual(f.writes,[]);
  }
});

test('family media controls require the server control capability and retain exact action validation',async()=>{
  const f=fixture(),p=f.panel;p._hass.user={id:'family',is_admin:false};p.serverCanEdit=false;
  f.send();await flush();assert.equal(f.calls.length,1);
  p.controllableEntities.clear();f.send();await flush();assert.equal(f.calls.length,1);
  assert.equal(f.sent.at(-1).ok,false);
  p.controllableEntities.add('media_player.speaker');
  f.send();p.controllableEntities.clear();await flush();assert.equal(f.calls.length,1,'queued capability revocation blocks dispatch');
});
