// Decode completion, disposal and retention after refresh failures without WebGL or TV access.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
function fixture(tvEntities={living_tv:'media_player.living_room_tv_77',bedroom_tv:'media_player.lg2'}){
  const loads=[],timers=new Map();let sequence=0;
  const preview={hidden:true,style:{},offsetWidth:360,offsetHeight:203,hasAttribute(){return !!this.src},removeAttribute(){delete this.src}};
  const screen={visible:false,material:{map:null}},bedroom={visible:false,material:{map:null}},objects=new Map([['living_tv',{userData:{screen}}],['bedroom_tv',{userData:{screen:bedroom}}]]);
  class TextureLoader{load(url,success,progress,error){const texture={disposed:false,dispose(){this.disposed=true}};loads.push({texture,success,error,url});return texture}}
  const context=vm.createContext({model:{tv_entities:tvEntities},objectsById:objects,$:()=>preview,homeView:{active:true},innerWidth:1024,innerHeight:768,window:{renderModel(){}},
    setTimeout:fn=>{timers.set(++sequence,fn);return sequence},clearTimeout:id=>timers.delete(id),
    THREE:{TextureLoader,SRGBColorSpace:'srgb'}});
  vm.runInContext(fs.readFileSync('tv-screen.js','utf8'),context);
  return {screen,bedroom,objects,loads,timers,preview,hover:context.previewTV,apply:context.applyTVFrame};
}
const jpeg='data:image/jpeg;base64,/9j/test';
test('latest decoded frame replaces and disposes the previous texture; explicit clear disposes it',()=>{
  const {screen,loads,timers,apply}=fixture();
  apply(jpeg);loads[0].success(loads[0].texture);
  assert.equal(screen.visible,true);assert.equal(screen.material.map.colorSpace,'srgb');
  apply(jpeg);assert.equal(screen.visible,true,'Keep the previous frame while decoding');
  loads[1].success(loads[1].texture);assert.equal(loads[0].texture.disposed,true);
  assert.equal(timers.size,0,'A missed refresh must not expire the last successful frame');
  apply(null);assert.equal(screen.visible,false);assert.equal(loads[1].texture.disposed,true);
});
test('clears, newer requests and rebuilt objects reject late decode completion',()=>{
  for(const change of ['clear','newer','rebuild']){
    const {screen,objects,loads,apply}=fixture();apply(jpeg);
    if(change==='clear')apply(null);
    if(change==='newer')apply(jpeg);
    if(change==='rebuild')objects.clear();
    loads[0].success(loads[0].texture);
    assert.equal(screen.visible,false,change);assert.equal(loads[0].texture.disposed,true,change);
  }
});
test('removing a TV clears its cached hover image even after its mesh is gone',()=>{
  for(const next of [null,jpeg]){
    const {objects,loads,preview,hover,apply,timers}=fixture();
    apply(jpeg);loads[0].success(loads[0].texture);hover({x:10,y:10});
    assert.equal(preview.hidden,false);
    objects.clear();apply(next);
    assert.equal(preview.hasAttribute('src'),false);
    assert.equal(preview.hidden,true);
    assert.equal(timers.size,0);
    assert.equal(loads.length,1,'An absent screen must not decode another JPEG');
  }
});
test('an old decode failure does not erase a newer decoded frame',()=>{
  const {screen,loads,preview,hover,apply}=fixture();hover({x:10,y:10});
  apply(jpeg);apply(jpeg+'new');loads[1].success(loads[1].texture);loads[0].error();
  assert.equal(loads[0].texture.disposed,true);
  assert.equal(screen.visible,true);
  assert.equal(screen.material.map,loads[1].texture);
  assert.equal(preview.src,jpeg+'new');
});
test('external URLs and oversized images never load; decode failures retain the last good frame',()=>{
  const {screen,loads,apply}=fixture();
  for(const value of ['https://tv/capture.jpg','data:image/svg+xml,test',jpeg+'a'.repeat(250000)])apply(value);
  assert.equal(loads.length,0);
  apply(jpeg);loads[0].success(loads[0].texture);apply(jpeg);loads[1].error();
  assert.equal(screen.visible,true);assert.equal(screen.material.map,loads[0].texture);assert.equal(loads[0].texture.disposed,false);assert.equal(loads[1].texture.disposed,true);
  apply(undefined);assert.equal(screen.material.map,loads[0].texture);assert.equal(loads.length,2);
});

test('hover magnifies only the current texture, stays in the viewport, and clears with it',()=>{
  const {loads,preview,hover,apply}=fixture();
  hover({x:1000,y:750});assert.equal(preview.hidden,true);
  apply(jpeg);loads[0].success(loads[0].texture);
  assert.equal(preview.hidden,false);assert.equal(preview.src,jpeg);
  assert.equal(preview.style.left,'656px');assert.equal(preview.style.top,'557px');
  hover(null);assert.equal(preview.hidden,true);assert.equal(loads.length,1);
  hover({x:10,y:10});assert.equal(preview.hidden,false);
  apply(null);assert.equal(preview.hidden,true);assert.equal(preview.hasAttribute('src'),false);
});

test('bedroom frames decode, clear and hover independently of the living-room TV',()=>{
  const {screen,bedroom,loads,preview,hover,apply,timers}=fixture();
  apply(jpeg);apply(jpeg+'bedroom',true,'bedroom_tv');
  loads[1].success(loads[1].texture);loads[0].success(loads[0].texture);
  assert.equal(screen.visible,true);assert.equal(bedroom.visible,true);
  hover({id:'bedroom_tv',x:10,y:10});assert.equal(preview.src,jpeg+'bedroom');
  apply(null);assert.equal(preview.src,jpeg+'bedroom');assert.equal(bedroom.visible,true);
  assert.equal(timers.size,0);
  apply(null,true,'bedroom_tv');assert.equal(preview.hidden,true);assert.equal(bedroom.visible,false);
  assert.equal(loads[1].texture.disposed,true);
  apply(jpeg,true,'office_tv');assert.equal(loads.length,2);
});

test('an unconfigured model has no default TV bindings',()=>{
  const {loads,apply,hover,preview}=fixture({});
  apply(jpeg);apply(jpeg,true,'living_tv');hover({x:10,y:10});
  assert.equal(loads.length,0);assert.equal(preview.hidden,true);
});
