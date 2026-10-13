const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){
 const nodes=new Map();
 const element=tag=>({tag,hidden:false,style:{},dataset:{},children:[],attributes:{},
  append(...children){this.children.push(...children)},remove(){this.removed=true},
  getAttribute(key){return key==='src'?this.src:this.attributes[key]},setAttribute(key,value){this.attributes[key]=value},removeAttribute(key){delete this[key];delete this.attributes[key]},
  getBoundingClientRect(){return {left:100,top:20,width:200,height:120}},
  querySelectorAll(tag){return this.children.filter(child=>child.tag===tag)},querySelector(tag){return this.querySelectorAll(tag)[0]}});
 const context=vm.createContext({document:{createElement:element,createElementNS:(ns,tag)=>element(tag)},
  $:id=>{if(!nodes.has(id))nodes.set(id,element('div'));return nodes.get(id)},
  tvFrames:new Map(),cameraPreviews:new Map(),dismissedCameraEvents:new Map(),items:[],objectsById:new Map(),
  THREE:{Vector3:class{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z})}project(){return this}}}});
 vm.runInContext(fs.readFileSync('media-preview.js','utf8'),context);
 const item={id:'tv',name:'Study TV',room:'study',position_m:{x:0,y:0,z:0},dimensions_m:{height:1}};
 const update=(state='off',extra={})=>context.updateTVPreviews([{item,state,busy:false,enabled:true,details(){},power(){},...extra}]);
 return {context,nodes,element,item,update};
}
test('TV cards reuse frames, show truthful off/unknown states and disable pending power',()=>{
 const {context:c,nodes,update}=fixture();
 c.tvFrames.set('tv',{image:'data:image/jpeg;base64,frame'});update('on');
 const card=nodes.get('homeTVs').children[0],[image,status,caption]=card.children;
 assert.equal(image.src,'data:image/jpeg;base64,frame');assert.equal(status.hidden,true);
 update('off');assert.equal(image.hidden,true);assert.equal(image.src,undefined);assert.equal(status.textContent,'TV is off');assert.equal(caption.children[1].disabled,false);
 update('off',{busy:true});assert.equal(caption.children[1].disabled,true);assert.match(status.textContent,/Waiting/);
 update('disconnected',{enabled:false});assert.equal(caption.children[0].disabled,true);assert.equal(caption.children[1].disabled,true);
 update('on');assert.equal(nodes.get('homeTVs').children.length,1);
 c.positionMediaPreviews({}, {width:1200,height:700}, '');assert.equal(nodes.get('homeMediaLinks').children.length,1);
 c.updateTVPreviews([]);assert.equal(card.removed,true);assert.equal(nodes.get('homeMediaLinks').children[0].removed,true);
});
test('room filtering reserves empty map space only for visible media and removes links',()=>{
 const {context:c,nodes,update}=fixture();update();
 assert.deepEqual({...c.mediaPreviewInsets({width:1200,height:700},'')},{left:0,right:220,top:0,bottom:0});
 c.positionMediaPreviews({}, {width:1200,height:700}, '');const line=nodes.get('homeMediaLinks').children[0];assert.match(line.children[0].attributes.d,/^M /);
 assert.deepEqual({...c.mediaPreviewInsets({width:480,height:700},'')},{left:0,right:0,top:0,bottom:150});
 c.positionMediaPreviews({}, {width:1200,height:700}, 'other');assert.equal(line.removed,true);
 assert.deepEqual({...c.mediaPreviewInsets({width:1200,height:700},'other')},{left:0,right:0,top:0,bottom:0});
});
test('camera leaders follow physical anchors and disappear on dismissal or expiry',()=>{
 const {context:c,nodes,element}=fixture();
 c.items.push({id:'camera',room:'study',position_m:{x:.2,y:.1,z:0},dimensions_m:{height:.2}});
 c.cameraPreviews.set('camera',{el:element('figure'),event:'event-a'});
 c.positionMediaPreviews({}, {width:1000,height:700}, '');const line=nodes.get('homeMediaLinks').children[0];
 assert.equal(line.children[2].attributes.cx,600);assert.equal(line.children[2].attributes.cy,280);
 assert.deepEqual({...c.mediaPreviewInsets({width:480,height:700},'')},{left:0,right:0,top:150,bottom:0});
 c.dismissedCameraEvents.set('camera','event-a');c.positionMediaPreviews({}, {width:1000,height:700}, '');assert.equal(line.removed,true);
 c.cameraPreviews.clear();assert.deepEqual({...c.mediaPreviewInsets({width:1200,height:700},'')},{left:0,right:0,top:0,bottom:0});
});
test('host restricts TV power to explicit actions on saved media entities and serializes requests',async()=>{
 let Panel;const context=vm.createContext({HTMLElement:class{},customElements:{get(){},define(name,value){Panel=value}}});
 vm.runInContext(fs.readFileSync('custom_components/home_floorplan/static/panel.js','utf8'),context);
 const messages=[],calls=[];let complete;
 const panel=Object.assign(Object.create(Panel.prototype),{generation:1,savedItems:[{entity_id:'media_player.study'},{entity_id:'light.study'}],commands:new Set(),port:{postMessage:m=>messages.push(m)},notice(){},
  _hass:{connected:true,states:{'media_player.study':{state:'off'},'light.study':{state:'off'}},callService:(...args)=>{calls.push(args);return new Promise(resolve=>complete=resolve)}}});
 const send=(entity_id,action)=>panel.handleViewerMessage({type:'tv_power',entity_id,action,request_id:'request'},1);
 for(const [id,action] of [['media_player.other','turn_on'],['light.study','turn_on'],['media_player.study','play_media'],['media_player.study','toggle']])send(id,action);
 await Promise.resolve();assert.equal(calls.length,0);assert.equal(messages.length,4);assert.ok(messages.every(message=>message.ok===false));
 send('media_player.study','turn_on');send('media_player.study','turn_on');await Promise.resolve();assert.equal(calls.length,1);assert.equal(calls[0][0],'media_player');assert.equal(calls[0][1],'turn_on');
 complete();await new Promise(resolve=>setImmediate(resolve));assert.equal(panel.commands.size,0);assert.equal(messages.at(-1).ok,true);
 panel._hass.connected=false;send('media_player.study','turn_on');await Promise.resolve();assert.equal(calls.length,1);assert.equal(messages.at(-1).ok,false);
});

test('leaders are withheld while a card is fully scrolled out of its rail',()=>{
 const {context:c,nodes,update}=fixture();update();
 const card=nodes.get('homeTVs').children[0];
 card.parentElement={getBoundingClientRect:()=>({top:200,bottom:500,left:0,right:300})};
 card.getBoundingClientRect=()=>({top:20,bottom:140,left:10,right:210,width:200,height:120});
 c.positionMediaPreviews({}, {width:1000,height:700}, '');assert.equal(nodes.get('homeMediaLinks').children.length,0);
});

test('rebinding or renaming a TV updates existing card callbacks and accessible text',()=>{
 const {nodes,update,item}=fixture();let called='';update('off',{power:()=>called='old'});
 const renamed={...item,name:'Renamed TV',entity_id:'media_player.new'};
 update('off',{item:renamed,power:()=>called='new',details:()=>called='details-new'});
 const [image,,caption]=nodes.get('homeTVs').children[0].children;
 caption.children[1].onclick();assert.equal(called,'new');caption.children[0].onclick();assert.equal(called,'details-new');
 assert.equal(image.alt,'Renamed TV picture');assert.equal(caption.children[0].textContent,'Renamed TV');
});
