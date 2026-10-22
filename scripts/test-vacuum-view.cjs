const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..'),origin=Date.parse('2026-01-01T12:00:00Z');
class Element{
  constructor(){this.children=[];this.attributes={};this.style={};this.dataset={};this.listeners=new Map();}
  append(...nodes){this.children.push(...nodes);}
  addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn);}
  removeEventListener(name,fn){this.listeners.get(name)?.delete(fn);}
  dispatch(name){for(const fn of this.listeners.get(name)||[])fn();}
  setAttribute(name,value){this.attributes[name]=value;}
  remove(){this.removed=true;}
}
class Vector3{set(x,y,z){Object.assign(this,{x,y,z});return this;}project(){this.y=this.z;this.z=0;return this;}}
function fixture(){
  let wall=origin,tick=0,sequence=0,inspected=[];const timers=new Map(),document=new Element(),window=new Element(),container=new Element();
  document.createElement=()=>new Element();document.hidden=false;
  const ClockDate=class extends Date{static now(){return wall;}};
  const context=vm.createContext({document,window,Date:ClockDate,performance:{now:()=>tick},Number,Math,JSON,
    setTimeout(fn,delay){const id=++sequence;timers.set(id,{fn,at:tick+delay});return id;},clearTimeout:id=>timers.delete(id)});
  for(const file of ['vacuum-state.js','vacuum-view.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context);
  const spec={id:'sample',name:'Sample cleaner',entity_id:'vacuum.sample',position_entity_id:'sensor.sample_position',floor_id:'main',map_id:0,transform:[.001,0,0,0,.001,0],bounds:[-2,-2,2,2],max_age_seconds:2,calibration:'approximate'};
  const view=context.createVacuumView(container,[spec],'main',{Vector3},{onInspect:id=>inspected.push(id),onResume:()=>view.update(data,true,true)});
  const data={'vacuum.sample':{state:'cleaning',battery_level:80},'sensor.sample_position':{state:'ready',vacuum_position:{x:250,y:-500,valid:true,map_id:0,observed_at:new Date(origin).toISOString()}}};
  const layer=container.children[0],marker=layer.children[0],caption=marker.children[0];
  function advance(ms){wall+=ms;tick+=ms;for(const [id,timer] of [...timers])if(timer.at<=tick){timers.delete(id);timer.fn();}}
  return {view,data,document,window,layer,marker,caption,timers,advance,inspected,rollback(){wall-=10000;}};
}
test('compact icon projects on the floor, opens only entity details and labels approximate calibration',()=>{
  const f=fixture();assert.equal(f.layer.hidden,true);assert.equal(f.marker.hidden,true);
  f.view.update(f.data,true,true);assert.equal(f.marker.hidden,false);assert.equal(f.marker.dataset.positionState,'live');
  f.view.render({}, {width:200,height:100});assert.equal(f.marker.style.left,'125px');assert.equal(f.marker.style.top,'75px');
  assert.match(f.marker.title,/Sample cleaner.*cleaning.*Battery 80%.*0s ago.*Approximate calibration/);
  f.marker.dispatch('click');assert.deepEqual(f.inspected,['vacuum.sample']);
  f.view.update(f.data,false,true);assert.equal(f.marker.disabled,true);assert.match(f.caption.textContent,/Last known/);
  f.marker.dispatch('click');assert.equal(f.inspected.length,1);
  f.view.dispose();
});
test('original expiry, wall-clock rollback and sparse age refresh retain truthful last-known text',()=>{
  const f=fixture();f.view.update(f.data,true,true);assert.equal(f.timers.size,1);
  f.advance(1000);f.rollback();f.advance(1000);assert.equal(f.marker.dataset.positionState,'last_known');assert.equal(f.caption.textContent,'Last known · 2s ago');
  f.view.update(f.data,true,true);assert.equal(f.marker.dataset.positionState,'last_known','a replay cannot extend the sample lease');
  f.advance(58000);assert.equal(f.caption.textContent,'Last known · 1m ago');assert.equal(f.timers.size,1);
  f.view.dispose();assert.equal(f.timers.size,0);
});
test('hidden, inactive, page suspension and disposal release timers and handlers',()=>{
  const f=fixture();f.view.update(f.data,true,true);assert.equal(f.timers.size,1);
  f.document.hidden=true;f.document.dispatch('visibilitychange');assert.equal(f.timers.size,0);assert.equal(f.layer.hidden,true);
  f.advance(3000);f.document.hidden=false;f.document.dispatch('visibilitychange');assert.equal(f.marker.dataset.positionState,'last_known');assert.equal(f.timers.size,1);
  f.view.update(f.data,true,false);assert.equal(f.timers.size,0);assert.equal(f.layer.hidden,true);
  f.view.update(f.data,true,true);f.window.dispatch('pagehide');assert.equal(f.timers.size,0);assert.equal(f.layer.hidden,true);
  f.window.dispatch('pageshow');assert.equal(f.layer.hidden,false);assert.equal(f.marker.dataset.positionState,'last_known');
  f.view.dispose();f.view.dispose();assert.equal(f.timers.size,0);assert.equal(f.layer.removed,true);
  for(const target of [f.document,f.window,f.marker])for(const handlers of target.listeners.values())assert.equal(handlers.size,0);
  f.view.update(f.data,true,true);assert.equal(f.timers.size,0);
});
test('no accepted initial position means no marker or timer; offscreen markers do not capture input',()=>{
  const f=fixture();f.data['sensor.sample_position'].vacuum_position.valid=false;f.view.update(f.data,true,true);assert.equal(f.marker.hidden,true);assert.equal(f.timers.size,0);
  f.data['sensor.sample_position'].vacuum_position.valid=true;f.view.update(f.data,true,true);f.view.render({}, {width:200,height:100});
  f.data['sensor.sample_position'].vacuum_position.x=1500;f.data['sensor.sample_position'].vacuum_position.observed_at=new Date(origin+1).toISOString();f.advance(1);f.view.update(f.data,true,true);
  assert.equal(f.marker.style.visibility,'hidden');f.view.dispose();
});
test('missing observation time stays visible as reported and retrieval age remains qualified after disconnect',()=>{
  const f=fixture();Object.assign(f.data['sensor.sample_position'].vacuum_position,{observed_at:null,retrieved_at:new Date(origin).toISOString(),timestamp_quality:'not_provided'});
  f.view.update(f.data,true,true);assert.equal(f.marker.dataset.positionState,'reported');assert.equal(f.caption.textContent,'Reported position');
  assert.match(f.marker.title,/Reported position.*Observation time unavailable.*Retrieved 0s ago/);assert.doesNotMatch(f.marker.title,/Live/);
  f.advance(2000);assert.equal(f.marker.dataset.positionState,'last_known');assert.equal(f.caption.textContent,'Last known · retrieved 2s ago');
  assert.match(f.marker.title,/Last known.*Observation time unavailable.*Retrieved 2s ago/);
  f.view.update(f.data,false,true);assert.match(f.marker.title,/Disconnected/);assert.equal(f.marker.dataset.positionState,'last_known');f.view.dispose();
});
