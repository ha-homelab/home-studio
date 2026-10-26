'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {resolveFanStatus:fan,resolveClimateStatus:climate}=require('../climate-state.js');
const thermostat=(state='heat',hvac_action='heating',attributes={})=>({state,climate:{hvac_action,...attributes}});

test('a speed-controlled fan only moves while on with a nonzero reported speed',()=>{
  assert.deepEqual(fan({state:'on',fan:{percentage:65}}),{available:true,powered:true,running:true,percentage:65,activity:'running'});
  assert.deepEqual(fan({state:'on',fan:{percentage:0}}),{available:true,powered:true,running:false,percentage:0,activity:'idle'});
  assert.deepEqual(fan({state:'off',fan:{percentage:65}}),{available:true,powered:false,running:false,percentage:65,activity:'off'});
  assert.equal(fan({state:'on',fan:{percentage:.1}}).running,true,'a small nonzero speed is not rounded down to idle');
  assert.equal(fan({state:'on',fan:{percentage:100}}).percentage,100);
});

test('binary fans work without speed telemetry; malformed percentages are not displayed',()=>{
  assert.equal(fan({state:'on'}).running,true);
  assert.equal(fan({state:'off'}).running,false);
  for(const percentage of [undefined,null,'65',NaN,Infinity,-1,101,true,{},[]]){
    const result=fan({state:'on',fan:{percentage}});
    assert.equal(result.percentage,null);
    assert.equal(result.running,true,'the binary on state remains evidence of operation');
  }
});

test('loss of live state clears all activity and temperature evidence',()=>{
  const active=thermostat('heat','heating',{current_temperature:19,temperature:22,temperature_unit:'°C'});
  for(const [reading,connected,activity] of [
    [undefined,true,'missing'],[null,true,'missing'],[{state:'unavailable'},true,'unavailable'],
    [{state:'unknown'},true,'unknown'],[{state:'constructor'},true,'unknown'],
    [{...active,restored:true},true,'restored'],[active,false,'disconnected'],
  ]){
    const result=climate(reading,connected);
    assert.equal(result.activity,activity);
    assert.equal(result.available,false);
    assert.equal(result.powered,false);
    assert.equal(result.running,false);
    assert.equal(result.effect,null);
    assert.equal(result.temperatureText,null);
    assert.equal(result.currentTemperature,null);
  }
  for(const [reading,connected,activity] of [
    [undefined,true,'missing'],[{state:'unavailable'},true,'unavailable'],[{state:'unknown'},true,'unknown'],
    [{state:'on',restored:true,fan:{percentage:65}},true,'restored'],[{state:'on'},false,'disconnected'],
  ])assert.deepEqual(fan(reading,connected),{available:false,powered:false,running:false,percentage:null,activity});
});

test('thermostat cycling keeps power and temperature visible while idle stops airflow',()=>{
  const attributes={current_temperature:20,temperature:22,temperature_unit:'°C'};
  const active=climate(thermostat('heat','heating',attributes));
  assert.equal(active.running,true);assert.equal(active.effect,'heat');
  const idle=climate(thermostat('heat','idle',attributes));
  assert.equal(idle.powered,true);assert.equal(idle.running,false);assert.equal(idle.effect,null);
  assert.equal(idle.activity,'idle');assert.equal(idle.temperatureText,'20 °C');
  const off=climate(thermostat('off','heating',attributes));
  assert.equal(off.powered,false);assert.equal(off.running,false);assert.equal(off.effect,null);
  assert.equal(off.activity,'off','off mode overrides a stale activity attribute');
});

test('reported HVAC activity determines the effect even in automatic or combined mode',()=>{
  for(const [mode,action,effect] of [
    ['cool','cooling','cool'],['heat','heating','heat'],['heat','preheating','heat'],
    ['dry','drying','cool'],['fan_only','fan','fan'],['heat_cool','heating','heat'],
    ['auto','cooling','cool'],['cool','fan','fan'],['cool','heating','heat'],
  ]){
    const result=climate(thermostat(mode,action));
    assert.equal(result.running,true);assert.equal(result.effect,effect);assert.equal(result.activity,action);
  }
  const defrosting=climate(thermostat('heat','defrosting'));
  assert.equal(defrosting.running,true);
  assert.equal(defrosting.effect,null,'defrosting does not claim heat delivery into the room');
});

test('mode or temperature differences alone never claim HVAC operation',()=>{
  for(const state of ['heat','cool','dry','fan_only','auto','heat_cool']){
    for(const action of [undefined,null,'','unknown','unavailable','constructor','<svg>']){
      const result=climate({state,climate:{hvac_action:action,current_temperature:10,temperature:25}});
      assert.equal(result.available,true);assert.equal(result.powered,true);
      assert.equal(result.running,false);assert.equal(result.effect,null);assert.equal(result.activity,'unknown');
    }
    const result=climate(thermostat(state,'off'));
    assert.equal(result.running,false);assert.equal(result.effect,null);assert.equal(result.activity,'off');
  }
});

test('temperatures retain zero and negative readings, safe units, and source information',()=>{
  const zero=climate(thermostat('cool','idle',{current_temperature:0,temperature:19.25,temperature_unit:'°C'}));
  assert.equal(zero.temperatureText,'0 °C');assert.equal(zero.temperatureSource,'current');
  assert.equal(zero.targetTemperature,19.25);
  const negative=climate(thermostat('heat','heating',{current_temperature:-5.25,temperature_unit:'°F'}));
  assert.equal(negative.temperatureText,'-5.3 °F');
  const kelvin=climate(thermostat('cool','idle',{temperature:295.15,temperature_unit:'K'}));
  assert.equal(kelvin.temperatureText,'295.1 K');assert.equal(kelvin.temperatureSource,'target');
  const unsafeUnit=climate(thermostat('heat','idle',{temperature:22,temperature_unit:'<img>'}));
  assert.equal(unsafeUnit.temperatureText,'22');assert.equal(unsafeUnit.unit,'');
});

test('missing or invalid temperatures are omitted instead of becoming a zero reading',()=>{
  for(const value of [undefined,null,'22','',true,{},[],NaN,Infinity,-Infinity,1001,-1001]){
    const result=climate(thermostat('heat','idle',{current_temperature:value,temperature:value}));
    assert.equal(result.currentTemperature,null);assert.equal(result.targetTemperature,null);
    assert.equal(result.temperatureText,null);assert.equal(result.temperatureSource,null);
  }
  const fallback=climate(thermostat('cool','idle',{current_temperature:'22',temperature:24,temperature_unit:'°C'}));
  assert.equal(fallback.temperatureText,'24 °C');assert.equal(fallback.temperatureSource,'target');
});

test('valid target ranges are available without a single setpoint, inverted or partial ranges are omitted',()=>{
  const range=climate(thermostat('heat_cool','idle',{target_temp_low:18,target_temp_high:24,temperature_unit:'°C'}));
  assert.equal(range.temperatureText,'18 °C – 24 °C');assert.equal(range.temperatureSource,'range');
  for(const [target_temp_low,target_temp_high] of [[24,18],[18,null],['18',24],[NaN,24]]){
    const result=climate(thermostat('heat_cool','idle',{target_temp_low,target_temp_high}));
    assert.equal(result.targetLow,null);assert.equal(result.targetHigh,null);assert.equal(result.temperatureText,null);
  }
});

test('normalizers are pure and can be loaded as a plain browser script',()=>{
  const reading=Object.freeze({state:'heat',climate:Object.freeze({hvac_action:'heating',current_temperature:20})});
  assert.equal(climate(reading).running,true);
  assert.equal(fan(Object.freeze({state:'on',fan:Object.freeze({percentage:50})})).running,true);
  const vm=require('node:vm'),fs=require('node:fs');
  const context=vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../climate-state.js'),'utf8'),context);
  assert.equal(vm.runInContext("resolveFanStatus({state:'on'}).running",context),true);
  assert.equal(vm.runInContext("resolveClimateStatus({state:'cool',climate:{hvac_action:'cooling'}}).effect",context),'cool');
});
