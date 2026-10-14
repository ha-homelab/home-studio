// Real host gateway, fake HA: these tests never connect to a home or device.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../custom_components/home_floorplan/static/panel.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({storage=new Map(),search='',storageFails=false}={}){
  const types=new Map(),sent=[],calls=[],events=[];
  class HTMLElement {
    constructor(){this.isConnected=true;}
    attachShadow(){const nodes=new Map();this.shadowRoot={set innerHTML(value){},querySelector(selector){
      if(!nodes.has(selector))nodes.set(selector,{classList:{toggle(){}},removeAttribute(){}});
      return nodes.get(selector);
    }};}
    dispatchEvent(event){events.push(event);}
  }
  const context={HTMLElement,URLSearchParams,location:{search},
    localStorage:{getItem(key){if(storageFails)throw Error('Denied');return storage.get(key)||null;},
      setItem(key,value){if(storageFails)throw Error('Denied');storage.set(key,value);}},
    CustomEvent:class{constructor(type,options){this.type=type;Object.assign(this,options);}},
    customElements:{get:name=>types.get(name),define:(name,type)=>types.set(name,type)}};
  vm.runInNewContext(source,context);
  const panel=new(types.get('home-floorplan-panel'))();
  panel.generation=1;panel.port={postMessage:message=>sent.push(plain(message))};
  const ids=['light.lamp','switch.relay','input_boolean.helper','fan.room','cover.curtain','media_player.tv','lock.door'];
  panel.savedItems=ids.map(entity_id=>({entity_id}));
  panel._hass={connected:true,states:Object.fromEntries(ids.map(id=>[id,{state:id==='lock.door'?'locked':'on'}])),
    callService:async(...args)=>calls.push(['service',...args]),callWS:async message=>calls.push(['ws',plain(message)])};
  const send=message=>panel.handleViewerMessage(message,panel.generation);
  return {panel,send,sent,calls,events,storage};
}
test('dry run blocks every device path, native details, calibration and unknown future commands',async()=>{
  const f=fixture();f.panel.setDryRun(true);
  const commands=[...['light.lamp','switch.relay','input_boolean.helper','fan.room'].map(entity_id=>({type:'toggle',entity_id})),
    ...['turn_on','turn_off'].map(action=>({type:'tv_power',entity_id:'media_player.tv',action})),
    ...['open_cover','close_cover','stop_cover','set_cover_position','power_on','record_position_check'].map(action=>({type:'curtain_command',entity_id:'cover.curtain',action,position:50})),
    ...['lock.door','media_player.tv','cover.curtain'].map(entity_id=>({type:'more_info',entity_id})),
    {type:'lock',entity_id:'lock.door',action:'unlock'}, {type:'future_action',entity_id:'switch.relay'}];
  const before=JSON.stringify(f.panel._hass.states);
  commands.forEach((command,index)=>f.send({...command,request_id:'dry_'+index}));await flush();
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.events,[]);
  assert.equal(JSON.stringify(f.panel._hass.states),before,'Dry run never fabricates device state');
  assert.equal(f.panel.commands.size,0);assert.equal(f.sent.length,commands.length);
  for(const [index,result] of f.sent.entries()){
    assert.equal(result.type,'command_result');assert.equal(result.request_id,'dry_'+index);
    assert.equal(result.ok,false);assert.equal(result.dry_run,true);assert.match(result.error,/no command sent/);
  }
});
test('preference survives reconstruction; child preferences cannot disable it',()=>{
  const f=fixture();f.panel.setDryRun(true);
  const next=fixture({storage:f.storage});assert.equal(next.panel.dryRun,true);
  next.send({type:'view_preferences',sidebarCollapsed:true,dryRun:false,dry_run:false});
  assert.equal(next.panel.dryRun,true);assert.equal(next.panel.viewPreferences.sidebarCollapsed,true);
  next.panel.setDryRun(false);assert.equal(fixture({storage:f.storage}).panel.dryRun,false);
});
test('dry_run=1 pins the guard and storage denial cannot disable an active guard',()=>{
  const pinned=fixture({search:'?dry_run=1'});pinned.panel.setDryRun(false);
  assert.equal(pinned.panel.dryRun,true);assert.equal(pinned.panel.$('dry-run').disabled,true);
  const denied=fixture({storageFails:true});denied.panel.setDryRun(true);assert.equal(denied.panel.dryRun,true);
  denied.panel.setDryRun(false);assert.equal(denied.panel.dryRun,true);
});
test('the dispatch microtask rechecks the guard and never reports a simulated success',async()=>{
  const f=fixture();f.send({type:'toggle',entity_id:'switch.relay',request_id:'race'});
  f.panel.setDryRun(true);await flush();assert.deepEqual(f.calls,[]);
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].dry_run,true);assert.equal(f.sent[0].ok,false);
  assert.equal(f.panel.commands.size,0);
});
test('normal mode retains validated service, curtain and native details behavior',async()=>{
  const f=fixture();assert.equal(f.panel.dryRun,false);
  f.send({type:'toggle',entity_id:'switch.relay',request_id:'normal'});
  f.send({type:'tv_power',entity_id:'media_player.tv',action:'turn_off',request_id:'tv'});
  f.send({type:'curtain_command',entity_id:'cover.curtain',action:'close_cover',request_id:'cover'});
  f.send({type:'more_info',entity_id:'lock.door'});await flush();
  assert.deepEqual(plain(f.calls),[
    ['service','switch','toggle',{entity_id:'switch.relay'}],
    ['service','media_player','turn_off',{entity_id:'media_player.tv'}],
    ['ws',{type:'home_floorplan/curtain_command',entity_id:'cover.curtain',action:'close_cover'}]]);
  assert.equal(f.events[0].type,'hass-more-info');assert.equal(f.sent.length,3);assert.ok(f.sent.every(result=>result.ok));
});
