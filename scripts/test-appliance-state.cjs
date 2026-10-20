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
  assert.equal(status(item,smoke,{[item.entity_id]:{state:'off',device_class:'door'}},true).tone,'unknown','a non-smoke capability cannot report smoke all-clear');
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

test('symbolic rings are bounded and reject invalid normalized geometry',()=>{
  const previous=global.document;
  global.document={createElement:()=>({children:[],setAttribute(){},append(node){this.children.push(node);}})};
  try{
    const {createCooktopFlames}=require('../appliance-state.js');
    const valid=[0,.9,0,.15];
    assert.equal(createCooktopFlames({burners:Array(100).fill(valid)}).children.length,8);
    const invalid=[[1,.9,0,.15],[0,-1,0,.15],[0,.9,1,.15],[0,.9,0,0],[0,.9,0,1],[0,NaN,0,.15],null];
    assert.equal(createCooktopFlames({burners:[valid,...invalid]}).children.length,1);
  }finally{global.document=previous;}
});

test('missing objects or nonfinite projections cannot leave overlays at the viewport origin',()=>{
  const {positionCooktopFlames,positionOvenGlow}=require('../appliance-state.js');
  for(const position of [positionCooktopFlames,positionOvenGlow]){
    const el={hidden:false,style:{}};position(el,null);assert.equal(el.hidden,true);
  }
  class Vector3 {
    constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}
    project(){this.x=NaN;return this;}
    transformDirection(){return this;}
    dot(){return 1;}
  }
  const object={localToWorld:point=>point,getWorldPosition:point=>point};
  const camera={position:{clone:()=>({sub:()=>({})})}},rect={width:100,height:100};
  const flame={burner:[0,.9,0,.1],style:{}},rings={hidden:false,children:[flame]};
  positionCooktopFlames(rings,object,camera,rect,{Vector3});
  assert.equal(flame.style.visibility,'hidden');assert.equal(flame.style.transform,undefined);
  const glow={hidden:false,style:{}};positionOvenGlow(glow,object,camera,rect,{Vector3});
  assert.equal(glow.style.visibility,'hidden');assert.equal(glow.style.transform,undefined);
});
