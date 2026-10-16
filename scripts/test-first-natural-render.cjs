'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {spawnSync} = require('node:child_process');
const crypto = require('node:crypto');
const {observeFirstNaturalRender, createFirstRenderCapture, validateStamp} = require('./first-natural-render.cjs');
const {adaptFixture} = require('./preload-first-natural-render.cjs');
let checks = 0;
function check(name, test) { test(); checks++; console.log('PASS: '+name); }
function exercise({throws=false, deliveryThrows=false}={}) {
  const messages=[], order=[], result={original:true}, failure=Error('original draw');
  const camera={layers:{}};
  const point=(intensity,visible=true)=>({isPointLight:true,intensity,visible,layers:{test:()=>true}});
  const points=[point(0),point(4),point(2,false)];
  const scene={name:'',traverse:fn=>points.forEach(fn),traverseVisible:fn=>points.filter(p=>p.visible).forEach(fn)};
  const renderer={render(s,c){assert.equal(this,renderer);assert.equal(c,camera);order.push('draw');if(throws)throw failure;return result;}};
  let connected=false;
  const context=vm.createContext({renderer,performance:{now:()=>12,timeOrigin:345},
    fetch(endpoint,options){order.push('stamp');if(deliveryThrows)throw Error('delivery');messages.push({endpoint,value:JSON.parse(options.body)});return Promise.resolve();},
    state:()=>({connected,renderCount:0,homeActive:true})});
  vm.runInContext(`(${observeFirstNaturalRender})(renderer,state,'http://127.0.0.1:1234/stamp')`,context);
  return {renderer,camera,scene,messages,order,result,failure,connect(){connected=true;}};
}
check('one CPU stamp precedes original first scene draw; later state/draws unchanged',()=>{
  const r=exercise();assert.equal(r.renderer.render(r.scene,r.camera),r.result);
  r.connect();r.renderer.render(r.scene,r.camera);
  assert.deepEqual(r.order,['stamp','draw','draw']);assert.equal(r.messages.length,1);
  assert.deepEqual(r.messages[0].value,{stage:'before-render',time:12,timeOrigin:345,connected:false,
    renderCount:0,homeActive:true,ownedPointLights:3,visiblePointLights:2,activePointLights:1});
});
check('connected first draw and original render exception both preserved',()=>{
  const r=exercise({throws:true});r.connect();assert.throws(()=>r.renderer.render(r.scene,r.camera),error=>error===r.failure);
  assert.equal(r.messages[0].value.connected,true);assert.deepEqual(r.order,['stamp','draw']);
});
check('delivery errors cannot suppress the original draw and copy is not first scene',()=>{
  const r=exercise({deliveryThrows:true});r.renderer.render({name:'interaction-copy'},r.camera);
  assert.equal(r.renderer.render(r.scene,r.camera),r.result);assert.deepEqual(r.order,['draw','stamp','draw']);
});
check('strict bounded endpoint writes two original-source records and rejects extras',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'first-render-test-'));
  try {
    const capture=createFirstRenderCapture(path.join(directory,'startup.jsonl'));
    const value=exercise();value.renderer.render(value.scene,value.camera);const base=value.messages[0].value;
    function post(stamp, address='127.0.0.1') {
      const request=new EventEmitter();Object.assign(request,{url:'/__home-studio-first-natural-render',method:'POST',headers:{'content-type':'text/plain'},socket:{remoteAddress:address}});
      let status;const response={writeHead(code){status=code;return this;},end(){}};
      assert(capture.handle(request,response,'a'.repeat(64)));request.emit('data',Buffer.from(JSON.stringify(stamp)));request.emit('end');return status;
    }
    assert.equal(post(base),204);assert.equal(post(base),204);
    assert.equal(post({...base,timeOrigin:346}),204);assert.equal(post({...base,timeOrigin:347}),204);
    assert.equal(post({...base,privateField:'not allowed'}),400);
    assert.equal(post(base,'10.0.0.1'),400);
    const records=fs.readFileSync(path.join(directory,'first-natural-render.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length,2);assert(records.every(record=>record.sourceHash==='a'.repeat(64)));
    assert.throws(()=>capture.source('https://example.com'));assert.throws(()=>validateStamp({...base,activePointLights:4}));
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
check('actual fixture adaptation parses, changes three anchors, leaves assertions/actions untouched',()=>{
  const filename=path.join(__dirname,'test-browser-stability.cjs');const original=fs.readFileSync(filename,'utf8');
  const adapted=adaptFixture(original);new vm.Script(adapted,{filename});
  const begin=original.indexOf('async function run('),end=original.indexOf('\n(async () =>');
  assert(adapted.includes(original.slice(begin,end)),'Entire original test function is byte-identical');
  assert.throws(()=>adaptFixture(adapted));assert.throws(()=>adaptFixture(original.replace('const startupScript = startup.scriptFor(origin);','missing')));
});
check('complete emitted tail and original native injection remain literal valid JavaScript',()=>{
  const capture=createFirstRenderCapture('/tmp/first-render-startup.jsonl');
  const runtime="let calls=0;const renderer={render(){calls++;return 7;}};let haConnected=true,renderCount=0;const homeView={active:true};";
  let html='<script>'+runtime+'</script></body>';
  html=html.replace('</script></body>',()=>capture.source('http://127.0.0.1:1234')+'</script></body>');
  // Mirrors the pinned native string replacement; helper must not introduce
  // replacement-token sequences which changed historical srcdoc injections.
  const native='window.originalNativeObserver=true;';html=html.replace('</script></body>',native+'</script></body>');
  const js=html.slice('<script>'.length,html.lastIndexOf('</script>'));new vm.Script(js);
  assert(js.includes(capture.source('http://127.0.0.1:1234')));assert(js.includes(native));
  assert(!/getContext|getParameter|getError|readPixels|requestAnimationFrame|setTimeout/.test(observeFirstNaturalRender.toString()));
});
check('real Node preload hooks only the fixture and saves source-bound adaptation before executing it',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'first-render-preload-'));
  try {
    const target=path.join(directory,'test-browser-stability.cjs');
    const source=`const fs=require('node:fs');
const fixtureOnly=true;
const createStartupDiagnostics=()=>({scriptFor:()=>'',handle:()=>false});
const startup = createStartupDiagnostics(fixtureOnly && process.env.HOME_STUDIO_STARTUP_DIAGNOSTICS_FILE);
const sourceHash='a'.repeat(64);
function server(request,response){
    if(startup.handle(request,response,sourceHash))return;
}
let html='<script>let renderer=null,haConnected=false,renderCount=0,homeView=null;</script></body>';
const origin='http://127.0.0.1:1234';
    const startupScript = startup.scriptFor(origin);
fs.writeFileSync(__dirname+'/emitted.html',html);
`;
    fs.writeFileSync(target,source);
    const preload=path.join(__dirname,'preload-first-natural-render.cjs');
    const child=spawnSync(process.execPath,[target],{encoding:'utf8',timeout:5000,
      env:{PATH:process.env.PATH,NODE_OPTIONS:'--require='+JSON.stringify(preload),
        HOME_STUDIO_STARTUP_DIAGNOSTICS_FILE:path.join(directory,'startup.jsonl')}});
    assert.equal(child.status,0,child.stderr);
    const receipt=JSON.parse(fs.readFileSync(path.join(directory,'first-render-adaptation.json'),'utf8'));
    const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
    assert.equal(receipt.originalSha256,digest(source));assert.equal(receipt.adaptedSha256,digest(adaptFixture(source)));
    assert.equal(receipt.helperSha256,digest(fs.readFileSync(path.join(__dirname,'first-natural-render.cjs'))));
    const emitted=fs.readFileSync(path.join(directory,'emitted.html'),'utf8');
    assert(emitted.includes('observeFirstNaturalRender'));new vm.Script(emitted.slice(8,emitted.indexOf('</script>')));
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
console.log(`${checks} passive first-render contracts passed`);
