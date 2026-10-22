// Exercise the real embedded host boundary without network, timers, or devices.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../custom_components/home_floorplan/static/panel.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const binding={entity_id:'vacuum.fixture',position_entity_id:'sensor.fixture_position'};
const sample={x:125,y:-70,observed_at:'2026-10-22T10:00:00.123456+00:00',map_id:0};

function fixture(){
  let Panel;const messages=[],events=[];
  const context=vm.createContext({HTMLElement:class{},customElements:{get(){},define(name,type){Panel=type;}},
    localStorage:{getItem(){return null;}},CustomEvent:class{constructor(type,options){Object.assign(this,{type},options);}}});
  vm.runInContext(source,context);
  const panel=Object.assign(Object.create(Panel.prototype),{generation:1,isConnected:true,serverCanEdit:false,dryRun:false,
    readableEntities:new Set(['vacuum.fixture','sensor.fixture_position','sensor.unrelated']),controllableEntities:new Set(),
    savedItems:[],vacuumSources:[binding],displayEntities:new Set(['sensor.unrelated']),scopedStates:true,tvFrameCache:{},
    curtains:{profiles:{},power:{},memory:{}},port:{postMessage(message){messages.push(plain(message));}},
    dispatchEvent(event){events.push(plain(event));},noticeKey(){},t:key=>key,
    refreshTVFrame(){},refreshCameraFrames(){},refreshMediaArtwork(){},
    _hass:{connected:true,user:{id:'fixture_reader',is_admin:false},states:{
      'vacuum.fixture':{state:'cleaning',attributes:{battery_level:43,token:'SECRET'}},
      'sensor.fixture_position':{state:'available',last_updated:'2026-10-22T10:00:20Z',attributes:{...sample,token:'SECRET',raw_map:{credential:'SECRET'}}},
      'sensor.unrelated':{state:'available',attributes:{...sample,battery_level:99}},
    }},
  });
  return {panel,messages,events,context,publish(){panel.publishEntityStates();return messages.at(-1);},
    project(state='available',attributes=sample){return plain(context.projectVacuumPosition(state,attributes));}};
}

test('only authenticated configured pairs expose position and battery, without attributes or update-time substitution',()=>{
  const f=fixture(),states=f.publish().states;
  assert.deepEqual(states['sensor.fixture_position'].vacuum_position,{...sample,valid:true});
  assert.equal(states['vacuum.fixture'].battery_level,43);
  assert.equal(states['sensor.unrelated'].vacuum_position,undefined);
  assert.equal(states['sensor.unrelated'].battery_level,undefined);
  assert.doesNotMatch(JSON.stringify(states),/SECRET|raw_map|credential|token/);
  assert.deepEqual(Object.keys(states['sensor.fixture_position'].vacuum_position).sort(),['map_id','observed_at','valid','x','y']);
  assert.equal(f.messages.length,1,'projection schedules no follow-up work');
});

test('unavailable, restored and malformed coordinates withdraw previous positions',()=>{
  const f=fixture();assert.equal(f.publish().states['sensor.fixture_position'].vacuum_position.valid,true);
  for(const state of ['unavailable','unknown','',null,'42'])assert.deepEqual(f.project(state),{vacuum_position:{valid:false}});
  assert.deepEqual(f.project('available',{...sample,restored:true}),{vacuum_position:{valid:false}});
  for(const valid of [false,null,'true',0,1])assert.deepEqual(f.project('available',{...sample,valid}),{vacuum_position:{valid:false}});
  for(const value of [null,undefined,true,false,'125',NaN,Infinity,-Infinity,[],{}]){
    for(const key of ['x','y'])assert.deepEqual(f.project('available',{...sample,[key]:value}),{vacuum_position:{valid:false}});
  }
  f.panel._hass.states['sensor.fixture_position'].state='unavailable';
  assert.deepEqual(f.publish().states['sensor.fixture_position'].vacuum_position,{valid:false});
  delete f.panel._hass.states['sensor.fixture_position'];
  assert.equal(f.publish().states['sensor.fixture_position'],undefined);
});

test('timestamp parsing requires the observed map time and rejects invalid or ambiguous dates',()=>{
  const f=fixture();
  for(const value of [undefined,null,true,1700000000,'1700000000','2026-10-22','2026-10-22T10:00:00',
    '2026-02-30T10:00:00Z','2025-02-29T10:00:00Z','2026-13-01T10:00:00Z','2026-10-22T24:00:00Z',
    '2026-10-22T10:60:00Z','2026-10-22T10:00:60Z','2026-10-22T10:00:00+14:30','2026-10-22T10:00:00+03:60',
    '2026-10-22T10:00:00.1234567Z','2026-10-22T10:00:00Z'+'x'.repeat(100)]){
    assert.deepEqual(f.project('available',{...sample,observed_at:value}),{vacuum_position:{valid:false}},String(value));
  }
  for(const value of ['2024-02-29T10:00:00Z','2026-10-22T10:00:00.1-07:00',sample.observed_at]){
    assert.equal(f.project('available',{...sample,observed_at:value}).vacuum_position.observed_at,value);
  }
  // The renderer applies freshness using max_age_seconds; the host never makes
  // an older real observation current by copying a newer HA last_updated.
  assert.equal(f.project('available',{...sample,observed_at:'2020-01-01T00:00:00Z'}).vacuum_position.observed_at,'2020-01-01T00:00:00Z');
});

test('sources without an observation timestamp explicitly preserve retrieval-time uncertainty',()=>{
  const f=fixture(),retrieved_at='2026-10-22T10:00:05Z';
  const attributes={...sample,observed_at:null,retrieved_at,timestamp_quality:'not_provided',valid:true,
    source:'fixture.position_service',token:'SECRET'};
  assert.deepEqual(f.project('available',attributes),{vacuum_position:{x:sample.x,y:sample.y,map_id:0,valid:true,
    observed_at:null,retrieved_at,timestamp_quality:'not_provided'}});
  for(const change of [{observed_at:undefined},{observed_at:'invalid'},{timestamp_quality:undefined},
    {timestamp_quality:'observed'},{retrieved_at:null},{retrieved_at:'2026-02-30T10:00:00Z'},{valid:false}]){
    assert.deepEqual(f.project('available',{...attributes,...change}),{vacuum_position:{valid:false}});
  }
  assert.deepEqual(f.project('unavailable',attributes),{vacuum_position:{valid:false}});
  assert.deepEqual(f.project('available',{...attributes,restored:true}),{vacuum_position:{valid:false}});
  // A real observation retains its own clock even when retrieval happened later.
  assert.deepEqual(f.project('available',{...attributes,observed_at:sample.observed_at}),{vacuum_position:{...sample,valid:true}});
  delete attributes.valid;
  assert.deepEqual(f.project('reported',attributes),{vacuum_position:{x:sample.x,y:sample.y,map_id:0,valid:true,
    observed_at:null,retrieved_at,timestamp_quality:'not_provided'}},'the native reported state needs no invented boolean validity attribute');
});

test('authoritative source-only vacuum details retain dry-run, read, lifecycle and target guards',()=>{
  const inspect=f=>f.panel.handleViewerMessage({type:'more_info',entity_id:'vacuum.fixture'},f.panel.generation);
  const f=fixture();inspect(f);
  assert.deepEqual(f.events,[{type:'hass-more-info',detail:{entityId:'vacuum.fixture'},bubbles:true,composed:true}]);
  assert.deepEqual(f.panel.savedItems,[],'inspection does not need a hidden inventory object');
  for(const mutate of [p=>p.vacuumSources=[],p=>p.readableEntities.delete('vacuum.fixture'),
    p=>p.readableEntities.delete('sensor.fixture_position'),p=>p.pending=1,p=>p.failed=true,
    p=>p._hass.connected=false,p=>p.isConnected=false,p=>p.dryRun=true,
    p=>delete p._hass.states['vacuum.fixture'],p=>delete p._hass.user.id]){
    const guarded=fixture();mutate(guarded.panel);inspect(guarded);assert.deepEqual(guarded.events,[]);
  }
  f.panel.handleViewerMessage({type:'more_info',entity_id:'sensor.fixture_position'},1);
  f.panel.handleViewerMessage({type:'more_info',entity_id:'sensor.unrelated'},1);
  f.panel.handleViewerMessage({type:'more_info',entity_id:'vacuum.fixture'},0);
  assert.equal(f.events.length,1,'position sensors, unrelated entities and stale generations remain ineligible');
});

test('map identifiers and battery values are bounded and type strict',()=>{
  const f=fixture();
  for(const value of [null,undefined,true,false,-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'','bad id','a'.repeat(65),{},[]]){
    assert.deepEqual(f.project('available',{...sample,map_id:value}),{vacuum_position:{valid:false}});
  }
  for(const value of [0,17,'map_17','a'.repeat(64)])assert.equal(f.project('available',{...sample,map_id:value}).vacuum_position.map_id,value);
  for(const value of [null,undefined,true,false,'43',-1,101,NaN,Infinity,{},[]]){
    f.panel._hass.states['vacuum.fixture'].attributes.battery_level=value;
    assert.equal(f.publish().states['vacuum.fixture'].battery_level,undefined);
  }
  f.panel._hass.states['vacuum.fixture'].attributes.battery_level=0;
  assert.equal(f.publish().states['vacuum.fixture'].battery_level,0);
  f.panel._hass.states['vacuum.fixture'].attributes.restored=true;
  assert.equal(f.publish().states['vacuum.fixture'].battery_level,undefined);
});

test('permission changes revoke the pair and an iframe cannot authorize another sensor',()=>{
  for(const denied of [binding.entity_id,binding.position_entity_id]){
    const f=fixture();f.publish();f.panel.readableEntities.delete(denied);
    const states=f.publish().states;
    assert.equal(states[denied],undefined);
    assert.equal(states['sensor.fixture_position']?.vacuum_position,undefined);
    assert.equal(states['vacuum.fixture']?.battery_level,undefined);
  }
  const f=fixture();f.panel.resetModelConfig();
  f.panel.handleViewerMessage({type:'model_config',state_entities:['vacuum.fixture','sensor.unrelated'],
    vacuum_sources:[{entity_id:'vacuum.fixture',position_entity_id:'sensor.unrelated'}]},1);
  const states=f.messages.at(-1).states;
  assert.equal(states['sensor.unrelated'].vacuum_position,undefined);
  assert.equal(states['vacuum.fixture'].battery_level,undefined);
});

test('configuration is bounded, rejects malformed IDs and loses all bindings on a floor reset',()=>{
  const f=fixture();
  for(const bindings of [null,{},'invalid',Array.from({length:65},()=>binding),
    [{...binding,entity_id:'sensor.fixture'}],[{...binding,position_entity_id:'vacuum.fixture'}],
    [{...binding,position_entity_id:'sensor.'+'a'.repeat(138)}],
    [{...binding,position_entity_id:123}],[{...binding,entity_id:true}]]){
    f.panel.vacuumSources=bindings;
    assert.equal(f.publish().states['sensor.fixture_position']?.vacuum_position,undefined);
  }
  f.panel.vacuumSources=[binding,binding];
  assert.equal(f.publish().states['sensor.fixture_position'].vacuum_position.valid,true);
  f.panel.resetModelConfig();f.panel.scopedStates=true;
  assert.equal(f.publish().states['sensor.fixture_position'],undefined);
});
