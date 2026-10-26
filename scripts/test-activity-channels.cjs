const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../custom_components/home_floorplan/static/panel.js'),'utf8');
const project=vm.runInNewContext(source+';projectRoomActivity',{HTMLElement:class{},customElements:{get(){},define(){}}});
const plain=value=>JSON.parse(JSON.stringify(value));
test('backend synthetic contract survives projection and independent presence aggregation',()=>{
  const {roomPresence}=require('../presence-view.js');
  const fixture=require('./fixtures/room-activity-channels.synthetic.json');
  for(const row of fixture.cases){
    const projected=plain(project('sensor.room','unknown',{channels:{source:row.expected}},true)).activity.channels;
    assert.deepEqual(projected.source,row.expected,row.id);
    assert.equal(roomPresence({},projected),row.expected.presence==='on'?'presence':row.expected.presence==='off'?'quiet':'unknown',row.id);
  }
});
test('only explicit false marks a channel not configured',()=>{
  for(const value of [false,true,undefined,null,0,'false']){
    const row=plain(project('sensor.room','unknown',{channels:{source:{presence_configured:value,motion_configured:value}}},true)).activity.channels.source;
    assert.equal(row.presence_configured,value!==false);assert.equal(row.motion_configured,value!==false);
    assert.equal(row.presence,'unknown');assert.equal(row.motion,'unknown');
  }
});
test('activity projection is backward compatible and forwards only normalized independent channels',()=>{
  assert.deepEqual(plain(project('sensor.room','presence',{evidence:{a:'presence'}},true)),{activity:{evidence:{a:'presence'}}});
  const result=plain(project('sensor.room','unknown',{evidence:{a:'unknown'},channels:{a:{presence:'on',motion:'unavailable',coverage:'unverified',credential:'secret',x:99},b:{presence:'off',motion:'on',coverage:'validated'}}},true));
  assert.deepEqual(result,{activity:{evidence:{a:'unknown'},channels:{a:{presence:'on',motion:'unknown',coverage:'unverified',presence_configured:true,motion_configured:true},b:{presence:'off',motion:'on',coverage:'validated',presence_configured:true,motion_configured:true}}}});
});
test('bad and missing inputs remain unknown; restored/unconfigured data is withheld',()=>{
  for(const value of [null,[],true,'on',42]){
    const projected=plain(project('sensor.room','unknown',{channels:{a:value}},true));
    assert.deepEqual(projected.activity.channels.a,{presence:'unknown',motion:'unknown',coverage:'unverified',presence_configured:true,motion_configured:true});
  }
  for(const attributes of [{channels:[]},{channels:'invalid'},{channels:Object.fromEntries(Array.from({length:65},(_,i)=>['a'+i,{presence:'on'}]))}])assert.deepEqual(plain(project('sensor.room','presence',attributes,true)).activity.channels,{});
  for(const [state,attributes,configured] of [['unavailable',{channels:{a:{presence:'on'}}},true],['presence',{restored:true},true],['presence',{},false]])assert.deepEqual(plain(project('sensor.room',state,attributes,configured)),{});
});
