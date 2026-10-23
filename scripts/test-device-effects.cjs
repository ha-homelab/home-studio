// Real Three transforms and a deterministic scene clock; no device commands.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'device-effects.js'),'utf8');
const three=import('data:text/javascript;base64,'+fs.readFileSync(path.join(root,'vendor/three.module.min.js')).toString('base64'));
class Element{
  constructor(tag='div',namespaceURI='http://www.w3.org/1999/xhtml'){
    this.tag=tag;this.namespaceURI=namespaceURI;this.children=[];this.attributes={};this.dataset={};this.hidden=false;this.listeners=new Map();
    this.style={setProperty(name,value){this[name]=value;}};
  }
  addEventListener(type,callback){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(callback);}
  removeEventListener(type,callback){this.listeners.get(type)?.delete(callback);}
  emit(type){for(const callback of this.listeners.get(type)||[])callback();}
  setAttribute(name,value){this.attributes[name]=String(value);}
  getAttribute(name){return this.attributes[name]??null;}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);this.parent=null;this.removed=true;}
  getBoundingClientRect(){throw Error('Effects must project the exact Three object, not measure a moving DOM marker');}
}
async function fixture(){
  const THREE=await three,document=new Element(),window=new Element(),media=new Element(),container=new Element(),timers=new Map(),draws=[];
  let now=0,sequence=0,canDraw=true,allowRotor=true,cost=0,onDraw=null,intersection=null,disconnected=false;
  document.hidden=false;media.matches=false;
  document.createElement=tag=>new Element(tag);document.createElementNS=(namespace,tag)=>new Element(tag,namespace);
  const context=vm.createContext({document,window,performance:{now:()=>now},
    matchMedia(query){assert.equal(query,'(prefers-reduced-motion: reduce)');return media;},
    setTimeout(fn,delay){assert(Number.isFinite(delay)&&delay>=0);const id=++sequence;timers.set(id,{fn,delay,due:now+delay});return id;},
    clearTimeout:id=>timers.delete(id),
    IntersectionObserver:class{constructor(callback){intersection=callback;}observe(element){assert.equal(element,container);}disconnect(){disconnected=true;intersection=null;}}
  });
  vm.runInContext(source,context);
  const effects=context.createDeviceEffects(THREE,container,{
    canDraw:()=>canDraw,allowRotor:()=>allowRotor,
    draw(){draws.push(now);now+=cost;onDraw?.();}
  });
  const camera=new THREE.OrthographicCamera(-4,4,3,-3,.1,100);
  camera.position.set(0,0,10);camera.lookAt(0,0,0);camera.updateMatrixWorld();
  const rect={width:800,height:600};
  function register({axis='z',rotor=true}={}){
    const object=new THREE.Group(),blade=new THREE.Group();blade.userData.axis=axis;object.add(blade);
    object.userData.deviceRotors=rotor?[blade]:[];
    object.userData.deviceAnimation={airflow:{origin:[0,0,0],direction:[0,1,0],width:.6,length:.5}};
    const marker=new Element('button'),card=new Element('button');
    return {entry:effects.register({object,marker,card}),object,blade,marker,card};
  }
  function update(device,status={running:true,effect:'fan',percentage:50},visible=true){effects.update(device.entry,status,visible);effects.sync();}
  function project(){effects.project(camera,rect);}
  function next(){
    const pending=[...timers].sort((a,b)=>a[1].due-b[1].due)[0];assert(pending,'a scheduled effect frame exists');
    now=Math.max(now,pending[1].due);timers.delete(pending[0]);pending[1].fn();
  }
  function advance(ms){const until=now+ms;while([...timers.values()].some(timer=>timer.due<=until))next();now=Math.max(now,until);}
  return {THREE,effects,document,window,media,container,timers,draws,camera,rect,register,update,project,next,advance,
    get now(){return now;},get disconnected(){return disconnected;},
    set canDraw(value){canDraw=value;},set allowRotor(value){allowRotor=value;},set cost(value){cost=value;},set onDraw(value){onDraw=value;},
    intersect(value){assert(intersection);intersection([{isIntersecting:value}]);}
  };
}
test('unprojected, off, and non-rotor effects never start a scene timer',async()=>{
  const f=await fixture(),fan=f.register();f.update(fan);
  assert.equal(f.timers.size,0,'wait for a valid on-screen projection before rendering motion');
  f.project();assert.equal(f.timers.size,1);assert.equal(fan.entry.air.hidden,false);
  f.update(fan,{running:false,effect:null});assert.equal(f.timers.size,0);assert.equal(fan.entry.air.hidden,true);
  assert.equal(fan.marker.dataset.running,'false');assert.equal(fan.card.dataset.running,'false');
  const climate=f.register({rotor:false});f.update(climate,{running:true,effect:'heat'});f.project();
  assert.equal(climate.entry.air.hidden,false);assert.equal(f.timers.size,0,'CSS airflow does not request WebGL frames');
  f.advance(1000);assert.equal(f.draws.length,0);f.effects.dispose();
});
test('many running rotors share one timer, stay below twelve scene frames per second, and rotate only their declared axes',async()=>{
  const f=await fixture(),slow=f.register({axis:'y'}),fast=f.register({axis:'z'}),unsupported=f.register({axis:'x'});
  f.update(slow,{running:true,effect:'fan',percentage:10});f.update(fast,{running:true,effect:'fan',percentage:100});f.update(unsupported);
  for(let i=0;i<30;i++){const extra=f.register();f.update(extra);}
  f.project();assert.equal(f.timers.size,1);
  const due=[...f.timers.values()][0].due;
  for(let i=0;i<100;i++){f.effects.sync();f.project();}
  assert.equal(f.timers.size,1);assert.equal([...f.timers.values()][0].due,due,'state and layout refreshes do not postpone or duplicate the timer');
  f.next();assert(slow.blade.rotation.y>0);assert(fast.blade.rotation.z>slow.blade.rotation.y);
  assert.equal(slow.blade.rotation.x,0);assert.equal(slow.blade.rotation.z,0);assert.equal(fast.blade.rotation.x,0);assert.equal(fast.blade.rotation.y,0);
  assert.deepEqual(unsupported.blade.rotation.toArray().slice(0,3),[0,0,0]);
  f.advance(916);assert(f.draws.length<=12);assert(f.draws.length>=10);
  for(let i=1;i<f.draws.length;i++)assert(f.draws[i]-f.draws[i-1]>=1000/12,'all scene work observes the frame-rate ceiling');
  assert.equal(f.timers.size,1);f.effects.dispose();assert.equal(f.timers.size,0);
});
test('slow scene draws lower the update rate, including reentrant projection during a draw',async()=>{
  for(const reentrant of [false,true]){
    const f=await fixture(),fan=f.register();f.update(fan);f.project();
    if(reentrant)f.onDraw=()=>f.project();
    f.cost=100;f.next();
    assert([...f.timers.values()][0].delay>=400,'the next scheduled frame immediately reflects a costly draw');
    assert.equal(f.timers.size,1);f.cost=200;f.next();
    assert.equal([...f.timers.values()][0].delay,500,'adaptive delay has a finite upper bound');
    f.cost=0;f.next();assert.equal([...f.timers.values()][0].delay,84,'cheap frames recover the normal frame budget');
    assert.equal(f.timers.size,1);f.effects.dispose();
  }
});
test('airflow follows the exact nested, rotated, scaled object and current camera rather than the floating marker',async()=>{
  const f=await fixture(),fan=f.register(),parent=new f.THREE.Group();parent.position.set(-1,-1,0);parent.add(fan.object);
  fan.object.position.set(1,2,0);fan.object.rotation.z=Math.PI/2;fan.object.scale.set(2,1,1);
  fan.object.userData.deviceAnimation.airflow={origin:[.25,.5,0],direction:[1,0,0],width:.6,length:.5};
  fan.marker.style.transform='translate3d(900px,900px,0)';
  f.update(fan);f.project();
  assert.equal(fan.entry.object,fan.object);assert.equal(fan.entry.svg.getAttribute('viewBox'),'0 0 800 600');
  const paths=()=>fan.entry.svg.children.map(path=>path.getAttribute('d'));
  assert.deepEqual(paths(),['M350.0,190.0 L350.0,140.0','M350.0,150.0 L350.0,100.0','M350.0,110.0 L350.0,60.0']);
  parent.position.x+=1;f.project();assert.equal(paths()[1],'M450.0,150.0 L450.0,100.0');
  f.camera.position.x+=1;f.camera.lookAt(1,0,0);f.camera.updateMatrixWorld();f.project();
  assert.equal(paths()[1],'M350.0,150.0 L350.0,100.0','camera movement reprojects the same physical anchor');
  f.rect.width=400;f.rect.height=300;f.project();assert.equal(paths()[1],'M175.0,75.0 L175.0,50.0');
  assert.equal(fan.marker.style.transform,'translate3d(900px,900px,0)','projection never overrides the separate icon layer');
  f.effects.dispose();
});
test('off-screen and behind-camera objects stop scene work and resume only when projected into view',async()=>{
  const f=await fixture(),fan=f.register();f.update(fan);f.project();assert.equal(f.timers.size,1);
  for(const position of [[100,0,0],[0,100,0],[0,0,20]]){
    fan.object.position.set(...position);f.project();assert.equal(fan.entry.projected,false);assert.equal(fan.entry.air.hidden,true);assert.equal(f.timers.size,0);
    assert(fan.entry.svg.children.every(path=>path.getAttribute('d')===''));
    fan.object.position.set(0,0,0);f.project();assert.equal(fan.entry.projected,true);assert.equal(f.timers.size,1);
  }
  f.effects.dispose();
});
test('hidden page, hidden layer, unavailable renderer, viewport exit, and low capacity stop all scene timers',async()=>{
  const f=await fixture(),fan=f.register();f.update(fan);f.project();assert.equal(f.timers.size,1);
  const guards=[
    [()=>{f.document.hidden=true;f.document.emit('visibilitychange');},()=>{f.document.hidden=false;f.document.emit('visibilitychange');}],
    [()=>f.window.emit('pagehide'),()=>f.window.emit('pageshow')],
    [()=>f.intersect(false),()=>f.intersect(true)],
    [()=>{f.canDraw=false;f.effects.sync();},()=>{f.canDraw=true;f.effects.sync();}],
    [()=>f.update(fan,undefined,false),()=>f.update(fan)],
  ];
  for(const [hide,show] of guards){
    hide();assert.equal(f.timers.size,0);assert.equal(fan.entry.air.hidden,true);const count=f.draws.length;
    f.advance(1000);assert.equal(f.draws.length,count);show();assert.equal(f.timers.size,1);assert.equal(fan.entry.air.hidden,false);
  }
  f.allowRotor=false;f.effects.sync();assert.equal(f.timers.size,0);assert.equal(fan.entry.air.hidden,false,'low-capacity renderers retain the inexpensive airflow indicator');
  f.allowRotor=true;f.effects.sync();assert.equal(f.timers.size,1);f.effects.dispose();
});
test('reduced motion retains a static airflow indicator but never rotates the scene',async()=>{
  const f=await fixture(),fan=f.register();f.update(fan);f.project();f.next();const before=fan.blade.rotation.z;
  f.media.matches=true;f.media.emit('change');assert.equal(f.timers.size,0);assert.equal(fan.entry.air.hidden,false);
  f.advance(3000);assert.equal(fan.blade.rotation.z,before);f.project();assert.equal(f.timers.size,0);
  f.media.matches=false;f.media.emit('change');assert.equal(f.timers.size,1);f.next();assert.notEqual(fan.blade.rotation.z,before);f.effects.dispose();
});
test('raw fan state uses the fan airflow fallback without requiring a climate effect field',async()=>{
  const f=await fixture(),fan=f.register();f.update(fan,{running:true,percentage:50});f.project();
  assert.equal(fan.entry.air.dataset.effect,'fan');assert.equal(fan.entry.air.hidden,false);assert.equal(fan.marker.dataset.effect,'fan');
  f.effects.dispose();
});
test('clear and disposal remove overlays and timers while preserving model-owned objects',async()=>{
  const f=await fixture(),fan=f.register();f.update(fan);f.project();assert.equal(f.container.children.length,1);
  f.effects.clear();assert.equal(f.container.children.length,0);assert.equal(f.timers.size,0);assert.equal(fan.object.children[0],fan.blade);
  f.effects.sync();assert.equal(f.timers.size,0);
  const replacement=f.register();f.update(replacement);f.project();assert.equal(f.timers.size,1);
  f.effects.dispose();f.effects.dispose();assert.equal(f.container.children.length,0);assert.equal(f.timers.size,0);assert.equal(f.disconnected,true);
  for(const element of [f.document,f.window,f.media])for(const listeners of element.listeners.values())assert.equal(listeners.size,0);
  const count=f.draws.length;f.effects.sync();f.advance(1000);assert.equal(f.draws.length,count);assert.equal(f.timers.size,0);
});
