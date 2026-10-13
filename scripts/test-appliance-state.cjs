'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {resolveApplianceStatus:status,resolveOvenStatus:oven}=require('../appliance-state.js');
const item={entity_id:'binary_sensor.example',room:'kitchen'};
const smoke={...item,kind:'smoke',battery_entity_id:'sensor.battery'};
const cooktop={...item,kind:'cooktop',oven_entity_id:'sensor.oven'};
const states=(state,battery='39.0')=>({[item.entity_id]:{state},'sensor.battery':{state:battery,unit:'%'}});

test('smoke status distinguishes clear, alarm, and loss of evidence',()=>{
  assert.deepEqual(status(item,smoke,states('off'),true),{tone:'ok',text:'OK · 39%',running:false});
  assert.deepEqual(status(item,smoke,states('on'),true),{tone:'alarm',text:'SMOKE ALARM · 39%',running:false});
  for(const reading of [undefined,{state:'unknown'},{state:'unavailable'},{state:'off',restored:true}]){
    assert.equal(status(item,smoke,{[item.entity_id]:reading},true).tone,'unknown');
  }
  assert.equal(status(item,smoke,states('off'),false).tone,'unknown');
  assert.equal(status({...item,room:'elsewhere'},smoke,states('off'),true).tone,'unknown');
  assert.equal(status({...item,entity_id:'binary_sensor.other'},smoke,states('off'),true).tone,'unknown');
});
test('battery accepts zero and declines missing, restored, or malformed values',()=>{
  assert.equal(status(item,smoke,states('off','0'),true).text,'OK · 0%');
  for(const battery of [undefined,{state:'',unit:'%'},{state:null,unit:'%'},{state:'101',unit:'%'},
    {state:'39',unit:'V'},{state:'39',unit:'%',restored:true},{state:'unavailable',unit:'%'}]){
    assert.equal(status(item,smoke,{...states('on'),'sensor.battery':battery},true).text,'SMOKE ALARM · Battery —');
  }
});
test('cooktop and oven operate independently, and paused is not heating',()=>{
  for(const cooktopState of ['on','off'])for(const ovenState of ['running','ready','paused']){
    const live={...states(cooktopState),'sensor.oven':{state:ovenState}};
    assert.equal(status(item,cooktop,live,true).running,cooktopState==='on');
    assert.equal(oven(cooktop,live,true).running,ovenState==='running');
  }
  assert.equal(oven(cooktop,{'sensor.oven':{state:'running'},[item.entity_id]:{state:'unavailable'}},true).running,true);
  for(const reading of [undefined,{state:'unknown'},{state:'unavailable'},{state:'running',restored:true}]){
    assert.equal(oven(cooktop,{'sensor.oven':reading},true).running,false);
  }
  assert.equal(oven(cooktop,{'sensor.oven':{state:'running'}},false).running,false);
  assert.equal(status(item,cooktop,states('on'),false).running,false);
});
