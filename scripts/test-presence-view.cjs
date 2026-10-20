const {test}=require('node:test'),assert=require('node:assert/strict');
const {presenceState,presenceEvidence,mergePresenceActivity}=require('../presence-view.js');
const item={id:'presence',room:'living',entity_id:'binary_sensor.presence'};
const spec={room:item.room,entity_id:item.entity_id};
const reading=(state,restored=false)=>({[item.entity_id]:{state,restored}});
test('a held occupancy signal remains presence without inventing motion or vital signs',()=>{
  assert.equal(presenceState(item,spec,reading('on'),true),'presence');
  assert.equal(presenceState(item,spec,{[item.entity_id]:{state:'on',last_updated:'2000-01-01'}},true),'presence');
  assert.equal(presenceState(item,spec,reading('off'),true),'quiet');
  for(const state of ['unavailable','unknown','moving','72'])assert.equal(presenceState(item,spec,reading(state),true),'unknown');
  assert.equal(presenceState(item,spec,reading('on',true),true),'unknown');
  assert.equal(presenceState(item,spec,reading('on'),false),'unknown');
  assert.equal(presenceState(item,spec,{},true),'unknown');
});
test('only the reviewed binding and room admit presence evidence',()=>{
  assert.equal(presenceState({...item,room:'dining'},spec,reading('on'),true),'unbound');
  assert.equal(presenceState({...item,entity_id:'binary_sensor.other'},spec,reading('on'),true),'unbound');
  assert.equal(presenceState(undefined,spec,reading('on'),true),'unbound');
  assert.deepEqual(presenceEvidence({presence:spec},[item],reading('on'),true,'living'),{presence:'presence'});
  assert.deepEqual(presenceEvidence({presence:spec},[item],reading('on'),true,'dining'),{});
});
test('room captions and inspector merge direct presence without promoting quiet or signal estimates',()=>{
  assert.equal(mergePresenceActivity('experimental',{presence:'presence'}),'presence');
  assert.equal(mergePresenceActivity('motion',{presence:'presence'}),'motion');
  assert.equal(mergePresenceActivity('unknown',{presence:'quiet'}),'unknown');
  assert.equal(mergePresenceActivity('experimental',{presence:'quiet'}),'experimental');
  assert.equal(mergePresenceActivity(null,{presence:'quiet'}),'quiet');
  assert.equal(mergePresenceActivity(null,{presence:'unknown'}),'unknown');
  assert.equal(mergePresenceActivity('invalid',{}),'unknown');
  for(const presence of ['unknown','unbound']){
    assert.equal(mergePresenceActivity('quiet',{presence}),'unknown','quiet motion cannot establish absence when direct presence is unavailable');
    assert.equal(mergePresenceActivity('motion',{presence}),'motion','positive current evidence remains visible');
  }
});
test('compact presence badge follows the room label without filling or scaling with the room',()=>{
  class Element {
    constructor(tag){this.tag=tag;this.attributes={};this.children=[];this.dataset={};this.style={};this.classList={add(){}};this.writes=0;}
    append(...nodes){this.children.push(...nodes);}
    setAttribute(key,value){this.attributes[key]=value;this.writes++;}
    getAttribute(key){return this.attributes[key];}
    remove(){this.removed=true;}
  }
  class Vector3 {
    constructor(x,y,z){Object.assign(this,{x,y,z});}
    clone(){return new Vector3(this.x,this.y,this.z);}
    project(camera){this.x+=camera.x;this.y=this.z;return this;}
  }
  const previous=global.document;global.document={createElementNS:(_ns,tag)=>new Element(tag)};
  try{
    const container=new Element();
    const {createPresenceView}=require('../presence-view.js');
    // No polygon is needed: presence belongs to the room caption, not its floor.
    const view=createPresenceView(container,[{id:'living',label:[.25,-.5]},{id:'dining',label:[0,0]}],{presence:spec},{Vector3},x=>x,z=>z);
    const svg=container.children[0],indicator=svg.children[0];
    assert.equal(svg.children.length,1,'only the configured room has a badge');
    assert.equal(svg.getAttribute('aria-hidden'),'true','the existing room caption provides the text alternative');
    assert.equal(indicator.tag,'g');
    assert.deepEqual(indicator.children.map(node=>node.tag),['circle','circle','path'],'no floor polygon, gradient or trail is created');
    assert.equal(indicator.children[0].getAttribute('r'),10,'the badge is only 20 screen pixels across');
    assert.equal(indicator.style.opacity,'0','nothing is shown before current evidence arrives');
    view.update([item],reading('on'),true,true,'');
    assert.equal(indicator.style.opacity,'1');assert.equal(indicator.dataset.state,'presence');
    view.render({x:0},{width:200,height:100});
    assert.equal(indicator.getAttribute('transform'),'translate(125 97)','the badge stays 22 screen pixels below the label');
    const writes=indicator.writes;view.render({x:0},{width:200,height:100});
    assert.equal(indicator.writes,writes,'an unchanged camera does not repaint attributes');
    view.render({x:1},{width:200,height:100});
    assert.equal(indicator.getAttribute('transform'),'translate(225 97)');
    view.render({x:0},{width:400,height:200});
    assert.equal(indicator.getAttribute('transform'),'translate(250 172)');
    assert.equal(indicator.children[0].getAttribute('r'),10,'resizing moves the badge without enlarging it');
    view.update([item],reading('off'),true,true,'');
    assert.equal(indicator.dataset.state,'quiet');assert.equal(indicator.style.opacity,'0');
    view.update([item],reading('on'),true,true,'');
    assert.equal(indicator.dataset.state,'presence');assert.equal(indicator.style.opacity,'1');
    view.update([item],reading('on'),false,true,'');
    assert.equal(indicator.dataset.state,'unknown');assert.equal(indicator.style.opacity,'0');
    view.update([],reading('on'),true,true,'');
    assert.equal(indicator.dataset.state,'unknown');
    view.update([item],reading('on'),true,true,'dining');assert.equal(indicator.style.display,'none');
    view.update([item],reading('on'),true,false,'');assert.equal(svg.style.display,'none');
    view.dispose();assert.equal(svg.removed,true);
  }finally{global.document=previous;}
});
