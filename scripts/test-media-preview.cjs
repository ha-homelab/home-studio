const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){
 const nodes=new Map(),loads=[];
 const element=tag=>({tag,hidden:false,style:{},dataset:{},children:[],attributes:{},
  append(...children){this.children.push(...children)},remove(){this.removed=true},
  getAttribute(key){return key==='src'?this.src:this.attributes[key]},setAttribute(key,value){this.attributes[key]=value},removeAttribute(key){delete this[key];delete this.attributes[key]},
  getBoundingClientRect(){return {left:100,top:20,width:200,height:120}},
  querySelectorAll(tag){return this.children.filter(child=>child.tag===tag)},querySelector(tag){return this.querySelectorAll(tag)[0]}});
 const item={id:'tv',name:'Study TV',entity_id:'media_player.study',room:'study',position_m:{x:0,y:0,z:0},dimensions_m:{height:1}};
 class Image{constructor(){this.naturalWidth=320;this.naturalHeight=180;loads.push(this)}removeAttribute(key){delete this[key]}}
 const context=vm.createContext({document:{createElement:element,createElementNS:(ns,tag)=>element(tag)},Image,
  $:id=>{if(!nodes.has(id))nodes.set(id,element('div'));return nodes.get(id)},
  tvFrames:new Map(),cameraPreviews:new Map(),dismissedCameraEvents:new Map(),items:[item],objectsById:new Map(),
  haConnected:true,haStates:{'media_player.study':{state:'playing'}},homeView:{},window:{requestModelRender(){}},
  model:{tv_entities:{tv:item.entity_id}},xm:x=>x,zm:z=>z,lowerFloorContext:{visible:true},root:{children:[]},objectGroup:{children:[]},THREE:{Vector3:class{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z})}project(){return this}}}});
 vm.runInContext(fs.readFileSync('media-preview.js','utf8'),context);
 const update=(state='off',extra={})=>context.updateTVPreviews([{item,state,busy:false,enabled:true,details(){},power(){},...extra}]);
 return {context,nodes,element,item,update,loads};
}

const artworkJPEG='data:image/jpeg;base64,/9j/YXJ0';
function artworkFixture(){
 const fixtureValue=fixture(),{context:c,update,item,nodes}=fixtureValue;
 delete c.model.tv_entities;
 const media={title:'A song',artist:'An artist',album:'An album'};
 c.homeView.refreshTVPreviews=()=>update('on',{media});
 update('on',{media});
 return {...fixtureValue,media,card:nodes.get('homeTVs').children[0],
  send:(identity='artwork-1',image=artworkJPEG)=>c.window.applyMediaArtwork({[item.id]:{entity_id:item.entity_id,identity,image}})};
}

test('saved media players show decoded HA artwork and bounded text without a TV screen',()=>{
 const {card,loads,send,update,media}=artworkFixture(),[image,status]=card.children;
 send();assert.equal(loads.length,1);assert.equal(image.hidden,true);
 loads[0].onload();assert.equal(image.src,artworkJPEG);assert.equal(image.alt,'Study TV cover art');
 assert.equal(card.dataset.mediaKind,'cover');assert.equal(status.textContent,'A song · An artist · An album');assert.equal(status.hidden,false);
 send();assert.equal(loads.length,1,'Repeated snapshots reuse an already decoded image');
 update('on',{media:{title:'<img src=x onerror=alert(1)>',artist:'a'.repeat(500)}});
 assert.equal(status.textContent,'<img src=x onerror=alert(1)> · '+'a'.repeat(200));
 update('off',{media});assert.equal(image.hidden,true);assert.equal(status.textContent,'Media player is off');
});

test('artwork switches clear old covers immediately and reject late decodes',()=>{
 const {card,loads,send,context:c}=artworkFixture(),image=card.children[0];
 send();loads[0].onload();assert.equal(image.src,artworkJPEG);
 send('artwork-2',artworkJPEG+'Mg==');const late=loads[1].onload;
 assert.equal(image.src,undefined,'The previous media identity must disappear before the next decode');
 send('artwork-3',artworkJPEG+'Mw==');late();assert.equal(image.src,undefined);
 loads[2].onload();assert.equal(image.src,artworkJPEG+'Mw==');
 c.window.applyMediaArtwork({});assert.equal(image.src,undefined);
 send('artwork-4');const afterClear=loads[3].onload;c.window.applyMediaArtwork({});afterClear();assert.equal(image.src,undefined);
});

test('same-media transport and decode failures retain a valid cover, while invalid URLs never load',()=>{
 const {card,loads,send,context:c,item}=artworkFixture(),image=card.children[0];
 send();loads[0].onload();
 c.window.applyMediaArtwork({[item.id]:{entity_id:item.entity_id,identity:'artwork-1'}});assert.equal(image.src,artworkJPEG);
 send('artwork-1',artworkJPEG+'Mg==');loads[1].onerror();assert.equal(image.src,artworkJPEG);
 for(const bad of ['https://example.test/image.jpg','data:image/svg+xml;base64,YQ==','data:image/png;base64,YQ==',artworkJPEG+'!','data:image/jpeg;base64,'+'a'.repeat(250000)])send('artwork-1',bad);
 assert.equal(loads.length,2);assert.equal(image.src,artworkJPEG);
 send('artwork-1',artworkJPEG+'Mw==');loads[2].naturalWidth=513;loads[2].onload();assert.equal(image.src,artworkJPEG);
 send('artwork-2',null);assert.equal(image.src,undefined);
});

test('off, unavailable, restored, disconnected, removed and rebound entities reject stale artwork',()=>{
 for(const change of ['off','unavailable','unknown','restored','disconnected','removed','rebound']){
  const {card,loads,send,context:c,item,update}=artworkFixture(),image=card.children[0];
  send();const late=loads[0].onload;
  if(change==='restored')c.haStates[item.entity_id].restored=true;
  else if(change==='disconnected')c.haConnected=false;
  else if(change==='removed')c.items=[];
  else if(change==='rebound')c.items=[{...item,entity_id:'media_player.new'}];
  else c.haStates[item.entity_id].state=change;
  update('on');late();assert.equal(image.src,undefined,change);
  send();assert.equal(loads.length,1,change+' does not decode another stale image');
 }
});

test('artwork messages cannot bind unrelated entities or override an existing TV snapshot',()=>{
 const {card,loads,send,context:c,item,update}=artworkFixture(),image=card.children[0];
 c.window.applyMediaArtwork({other:{entity_id:item.entity_id,identity:'artwork-1',image:artworkJPEG},tv:{entity_id:'media_player.other',identity:'artwork-1',image:artworkJPEG}});
 assert.equal(loads.length,0);
 send();loads[0].onload();c.tvFrames.set(item.id,{image:'data:image/jpeg;base64,c25hcHNob3Q='});update('on');
 assert.equal(image.src,'data:image/jpeg;base64,c25hcHNob3Q=');assert.equal(image.alt,'Study TV picture');
 assert.equal(card.dataset.mediaKind,'snapshot');assert.equal(card.children[1].hidden,true);
});
test('TV cards reuse frames, show truthful off/unknown states and disable pending power',()=>{
 const {context:c,nodes,update}=fixture();
 c.tvFrames.set('tv',{image:'data:image/jpeg;base64,frame'});update('on');
 const card=nodes.get('homeTVs').children[0],[image,status,caption]=card.children;
 assert.equal(image.src,'data:image/jpeg;base64,frame');assert.equal(status.hidden,true);
 update('off');assert.equal(image.hidden,true);assert.equal(image.src,undefined);assert.equal(status.textContent,'TV is off');assert.equal(caption.children[1].disabled,false);
 update('off',{busy:true});assert.equal(caption.children[1].disabled,true);assert.match(status.textContent,/Waiting/);
 update('disconnected',{enabled:false});assert.equal(caption.children[0].disabled,true);assert.equal(caption.children[1].disabled,true);
 update('on');assert.equal(nodes.get('homeTVs').children.length,1);
 c.positionMediaPreviews({matrixWorld:{elements:[]},projectionMatrix:{elements:[]}}, {width:1200,height:700}, '');assert.equal(nodes.get('homeMediaLinks').children.length,1);
 c.updateTVPreviews([]);assert.equal(card.removed,true);assert.equal(nodes.get('homeMediaLinks').children[0].removed,true);
});
test('room filtering hides callouts and removes their leaders',()=>{
 const {context:c,nodes,update}=fixture();update();const camera={matrixWorld:{elements:[]},projectionMatrix:{elements:[]}};
 c.positionMediaPreviews(camera,{width:1200,height:700},'');const line=nodes.get('homeMediaLinks').children[0];assert.match(line.children[0].attributes.d,/^M /);
 c.positionMediaPreviews(camera,{width:1200,height:700},'other');assert.equal(line.removed,true);assert.equal(nodes.get('homeTVs').children[0].hidden,true);
});
test('camera leaders follow physical anchors and disappear on dismissal',()=>{
 const {context:c,nodes,element}=fixture(),camera={matrixWorld:{elements:[]},projectionMatrix:{elements:[]}};
 c.items.push({id:'camera',room:'study',position_m:{x:.2,y:.1,z:0},dimensions_m:{height:.2}});
 c.cameraPreviews.set('camera',{el:element('figure'),event:'event-a'});
 c.positionMediaPreviews(camera,{width:1000,height:700},'');const line=nodes.get('homeMediaLinks').children[0];
 assert.equal(line.children[2].attributes.cx,600);assert.equal(line.children[2].attributes.cy,280);
 c.dismissedCameraEvents.set('camera','event-a');c.positionMediaPreviews(camera,{width:1000,height:700},'');assert.equal(line.removed,true);
});
test('automatic placement uses only free pixels and returns nothing when the map fills the viewport',()=>{
 const {context:c}=fixture(),view={width:600,height:400},size={width:160,height:100},point={x:350,y:200};
 const blocked=[{x:0,y:130,width:600,height:270}];const placed=c.findMediaSpace(size,view,blocked,point);
 assert.ok(placed);assert.ok(placed.y+placed.height<=120);assert.ok(placed.x>=8&&placed.x+placed.width<=592);
 assert.equal(c.findMediaSpace(size,view,[{x:0,y:0,width:600,height:400}],point),null);
 assert.equal(c.findMediaSpace(size,{width:120,height:80},[],point),null);
 const next=c.findMediaSpace(size,view,[...blocked,placed],point);assert.ok(next);assert.ok(Math.abs(next.x-placed.x)>=170);
});
test('leaders contain only horizontal and vertical runs, including above/below cases',()=>{
 const {context:c}=fixture(),box={x:100,y:100,width:160,height:100};
 for(const point of [{x:400,y:300},{x:20,y:50},{x:200,y:300},{x:200,y:30}]){
  const path=c.mediaLeaderPath(box,point);assert.match(path,/^M [\d.]+ [\d.]+ [HV] /);assert.ok(!/[CLQAS]/.test(path));
  const commands=path.match(/[MHV][^MHV]*/g);let x=0,y=0;
  for(const command of commands){const nums=command.slice(1).trim().split(/ +/).map(Number);if(command[0]==='M')[x,y]=nums;else if(command[0]==='H')x=nums[0];else y=nums[0];}
  assert.deepEqual({x,y},point);
 }
});
test('host restricts TV power to explicit actions on saved media entities and serializes requests',async()=>{
 let Panel;const context=vm.createContext({localStorage:{getItem(){return null;}},HTMLElement:class{},customElements:{get(){},define(name,value){Panel=value}}});
 vm.runInContext(fs.readFileSync('custom_components/home_floorplan/static/panel.js','utf8'),context);
 const messages=[],calls=[];let complete;
 const panel=Object.assign(Object.create(Panel.prototype),{generation:1,readableEntities:new Set(['media_player.study','light.study']),controllableEntities:new Set(['media_player.study','light.study']),savedItems:[{entity_id:'media_player.study'},{entity_id:'light.study'}],commands:new Set(),port:{postMessage:m=>messages.push(m)},notice(){},
  _hass:{user:{id:'fixture-admin',is_admin:true},connected:true,states:{'media_player.study':{state:'off'},'light.study':{state:'off'}},callService:(...args)=>{calls.push(args);return new Promise(resolve=>complete=resolve)}}});
 const send=(entity_id,action)=>panel.handleViewerMessage({type:'tv_power',entity_id,action,request_id:'request'},1);
 for(const [id,action] of [['media_player.other','turn_on'],['light.study','turn_on'],['media_player.study','play_media'],['media_player.study','toggle']])send(id,action);
 await Promise.resolve();assert.equal(calls.length,0);assert.equal(messages.length,4);assert.ok(messages.every(message=>message.ok===false));
 send('media_player.study','turn_on');send('media_player.study','turn_on');await Promise.resolve();assert.equal(calls.length,1);assert.equal(calls[0][0],'media_player');assert.equal(calls[0][1],'turn_on');
 complete();await new Promise(resolve=>setImmediate(resolve));assert.equal(panel.commands.size,0);assert.equal(messages.at(-1).ok,true);
 panel._hass.connected=false;send('media_player.study','turn_on');await Promise.resolve();assert.equal(calls.length,1);assert.equal(messages.at(-1).ok,false);
});

test('rebinding or renaming a TV updates existing card callbacks and accessible text',()=>{
 const {nodes,update,item}=fixture();let called='';update('off',{power:()=>called='old'});
 const renamed={...item,name:'Renamed TV',entity_id:'media_player.new'};
 update('off',{item:renamed,power:()=>called='new',details:()=>called='details-new'});
 const [image,,caption]=nodes.get('homeTVs').children[0].children;
 caption.children[1].onclick();assert.equal(called,'new');caption.children[0].onclick();assert.equal(called,'details-new');
 assert.equal(image.alt,'Renamed TV picture');assert.equal(caption.children[0].textContent,'Renamed TV');
});

test('telemetry formats valid units and rejects absent, restored and invalid values',()=>{
 const {context:c}=fixture(),format=(state,unit,metric={format:'pressure'},extra={})=>c.formatTelemetryReading({state,unit,...extra},metric);
 assert.equal(format('235','kPa'),'34 PSI');assert.equal(format('2.75','bar'),'40 PSI');assert.equal(format('34','psi'),'34 PSI');
 for(const value of ['unknown','unavailable','',' ',null,undefined,'NaN','-4','0'])assert.equal(format(value,'psi'),'—');
 assert.equal(format('34','psi',{}, {restored:true}),'—');assert.equal(format('34','unknown'),'—');
 assert.equal(format('80','%',{format:'percent'}),'80%');assert.equal(format('101','%',{format:'percent'}),'—');
 assert.equal(format('0','W',{format:'power'}),'0 W');assert.equal(format('0.5','W',{format:'power'}),'0.5 W');assert.equal(format('1.5','kW',{format:'power'}),'1.5 kW');
 assert.equal(format('2.57','kWh',{format:'number',decimals:2}),'2.57 kWh');
});
test('telemetry cards reuse HA values, never create leaders, and follow lower-floor visibility',()=>{
 const {context:c,nodes}=fixture(),camera={matrixWorld:{elements:[]},projectionMatrix:{elements:[]}};
 c.model.telemetry=[{id:'car',name:'Garage vehicle',lower_floor:true,position_m:{x:0,y:0,z:0},metrics:[{label:'Battery',entity_id:'sensor.example',format:'percent'}]}];
 c.updateTelemetryPreviews({'sensor.example':{state:'80',unit:'%'}},true);
 const card=nodes.get('homeTelemetry').children[0],value=card.children[1].children[0].children[1];assert.equal(value.textContent,'80%');
 c.positionMediaPreviews(camera,{width:1200,height:700},'');assert.equal(card.hidden,false);assert.equal(nodes.get('homeMediaLinks').children.length,0);
 c.lowerFloorContext.visible=false;c.positionMediaPreviews(camera,{width:1200,height:700},'');assert.equal(card.hidden,true);
 c.updateTelemetryPreviews({},false);assert.equal(value.textContent,'—');assert.equal(nodes.get('homeTelemetry').children.length,1);
 c.lowerFloorContext.visible=true;c.positionMediaPreviews(camera,{width:1200,height:700},'other');assert.equal(card.hidden,true);
});
test('power labels vanish for zero, missing and disconnected readings',()=>{
 const {context:c,nodes,item}=fixture(),camera={matrixWorld:{elements:[]},projectionMatrix:{elements:[]}};
 item.dimensions_m.height=0;c.items.push(item);c.model.power_labels=[{object_id:item.id,name:'Power strip',entity_id:'sensor.power'}];
 for(const [state,connected,visible] of [['123',true,true],['0',true,false],['unavailable',true,false],['123',false,false]]){
  c.updateTelemetryPreviews({'sensor.power':{state,unit:'W'}},connected);c.positionMediaPreviews(camera,{width:1200,height:700},'');
  const label=nodes.get('homeTelemetry').children[0];assert.equal(!label.hidden,visible);assert.equal(label.onclick,undefined);
 }
});

test('shared circuit watts reuse the existing room caption without creating another label',()=>{
 const {context:c,nodes}=fixture();
 c.model.power_labels=[{id:'shared',room_ids:['study','hall'],name:'Study and hall circuit',entity_id:'sensor.circuit'}];
 c.updateTelemetryPreviews({'sensor.circuit':{state:'158',unit:'W'}},true);
 assert.equal(nodes.has('homeTelemetry'),false);
 assert.equal(c.roomPowerText('study',''),'158 W');
 assert.equal(c.roomPowerText('hall',''),'');
 assert.equal(c.roomPowerText('hall','hall'),'158 W');
 assert.equal(c.roomPowerText('study','hall'),'');
 assert.equal(c.roomPowerText('other','other'),'');
 c.updateTelemetryPreviews({},false);assert.equal(c.roomPowerText('hall','hall'),'');
});

test('signed circuit power preserves direction only when explicitly configured',()=>{
 const {context:c}=fixture(),negative={state:'-1.25',unit:'kW'};
 assert.equal(c.formatTelemetryReading(negative,{format:'power'}),'—');
 assert.equal(c.formatTelemetryReading(negative,{format:'power',signed:true}),'-1.3 kW');
 assert.equal(c.formatTelemetryReading({state:'-0.5',unit:'W'},{format:'power',signed:true}),'-0.5 W');
 c.model.power_labels=[{id:'signed',room_ids:['hall'],name:'Signed circuit',entity_id:'sensor.circuit',signed:true}];
 c.updateTelemetryPreviews({'sensor.circuit':negative},true);assert.equal(c.roomPowerText('hall',''),'-1.3 kW');
 for(const state of ['0','unknown','unavailable']){
  c.updateTelemetryPreviews({'sensor.circuit':{state,unit:'W'}},true);assert.equal(c.roomPowerText('hall',''),'');
 }
});

test('multiple circuits keep separate readings in one room caption',()=>{
 const {context:c,nodes}=fixture();
 c.model.power_labels=[{id:'left',room_ids:['kitchen'],entity_id:'sensor.left'},
  {id:'right',room_ids:['kitchen'],entity_id:'sensor.right'}];
 c.updateTelemetryPreviews({'sensor.left':{state:'10',unit:'W'},'sensor.right':{state:'20',unit:'W'}},true);
 assert.equal(c.roomPowerText('kitchen',''),'10 W · 20 W');assert.equal(nodes.has('homeTelemetry'),false);
 c.updateTelemetryPreviews({'sensor.left':{state:'0',unit:'W'},'sensor.right':{state:'20',unit:'W',restored:true}},true);
 assert.equal(c.roomPowerText('kitchen',''),'');
});

test('a missing appliance never turns into an unrelated room measurement',()=>{
 const {context:c,nodes}=fixture(),camera={matrixWorld:{elements:[]},projectionMatrix:{elements:[]}};
 c.model.rooms=[{id:'study',label:[0,0]}];
 c.model.power_labels=[{object_id:'missing',name:'Missing appliance',entity_id:'sensor.circuit'}];
 c.updateTelemetryPreviews({'sensor.circuit':{state:'50',unit:'W'}},true);c.positionMediaPreviews(camera,{width:1200,height:700},'study');
 assert.equal(nodes.get('homeTelemetry').children[0].hidden,true);
});
