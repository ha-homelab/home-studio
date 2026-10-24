const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const {createStartupDiagnostics, installStartupProbe, validateCheckpoint} = require('./browser-startup-diagnostics.cjs');

test('startup diagnostics default to no injection, handler or source mutation', () => {
  const disabled = createStartupDiagnostics();
  assert.equal(disabled.scriptFor(), '');
  assert.equal(disabled.handle(), false);
  assert.equal(disabled.checkpointSource('original'), 'original');
  assert.equal(disabled.allowLoopback("connect-src 'none'"), "connect-src 'none'");
  assert.throws(() => createStartupDiagnostics('../outside.jsonl'), /absolute host path/);
});

function simulatedBrowser(referrer = 'http://127.0.0.1:12345/', block, configure = () => {}) {
  const sent = [], calls = [];
  const gl = {VERSION:1, RENDERER:2, LINK_STATUS:3, VERTEX_SHADER:5, FRAGMENT_SHADER:6, drawingBufferWidth:500, drawingBufferHeight:500,
    getExtension:()=>({UNMASKED_RENDERER_WEBGL:4}),
    getParameter:key=>key === 1 ? 'WebGL 2.0' : 'Apple Software Renderer',
    createShader(type){return {type};}, shaderSource(){}, attachShader(){},
    compileShader(){calls.push('compile');if(block === 'compile')throw Error('blocked compile');},
    linkProgram(){calls.push('link');if(block === 'link')throw Error('blocked link');},
    getProgramParameter(){calls.push('status');return true;},
    useProgram(){calls.push('use');}, deleteProgram(){calls.push('delete');},
    drawArrays(){calls.push('drawArrays');}, drawElements(){calls.push('drawElements');},
    drawArraysInstanced(){calls.push('drawArraysInstanced');}, drawElementsInstanced(){calls.push('drawElementsInstanced');},
  };
  class Canvas {constructor(){this.width=500;this.height=500;}getContext(){calls.push('context');return gl;}}
  const context = {window:{}, document:{referrer}, location:{href:'about:srcdoc'}, URL,
    HTMLCanvasElement:Canvas, performance:{now:()=>7},
    fetch:(url, options)=>{sent.push({url,options,value:JSON.parse(options.body)});return Promise.resolve();}};
  configure({gl,context,calls});
  // No parent.location is exposed: real sandboxed srcdoc cannot read it.
  vm.runInNewContext(`(${installStartupProbe.toString()})(${JSON.stringify(referrer)});`,context);
  return {context,Canvas,gl,sent,calls};
}

function makeProgram(gl, index) {
  const program = {};
  for (const type of [gl.VERTEX_SHADER,gl.FRAGMENT_SHADER]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader,`private-source-${index}-${type}`);
    gl.compileShader(shader);
    gl.attachShader(program,shader);
  }
  return program;
}

test('opaque-frame probe records eight distinct programs within forty safe checkpoints', () => {
  const {context,Canvas,gl,sent,calls} = simulatedBrowser();
  assert.equal(new Canvas().getContext('webgl2'),gl);
  context.window.__homeStudioStartupProfile({pixels:250000,pointShadows:2,pointShadowSize:128,sunShadowSize:512,instanceCatalog:true});
  for (let index=1;index<=9;index++) {
    const program=makeProgram(gl,index);
    gl.linkProgram(program);
    assert.equal(gl.getProgramParameter(program,gl.LINK_STATUS),true);
    // Repeated queries/relinks must neither consume the budget nor disappear
    // from the application's actual GL calls.
    gl.linkProgram(program);gl.getProgramParameter(program,gl.LINK_STATUS);
  }
  new Canvas().getContext('webgl2');
  context.window.__homeStudioStartupProfile({pixels:2000000});
  assert.equal(sent.length,40);
  assert.deepEqual(sent.slice(0,8).map(item=>item.value.event),['context-before','context-after','gpu','profile',
    'compile-before','compile-after','compile-before','compile-after']);
  assert.deepEqual(sent.filter(item=>item.value.event==='link-before').map(item=>item.value.program),[1,2,3,4,5,6,7,8]);
  assert.equal(calls.filter(call=>call==='link').length,18);
  assert.equal(calls.filter(call=>call==='status').length,18);
  assert.equal(calls.filter(call=>call==='compile').length,18);
  for (const item of sent) {
    assert.equal(item.url,'http://127.0.0.1:12345/__home-studio-startup');
    assert.equal(item.options.mode,'no-cors');
    validateCheckpoint(item.value);
  }
  const first = sent.find(item=>item.value.event==='link-before').value;
  assert.deepEqual(first.shaders.map(shader=>shader.type),['vertex','fragment']);
  assert.notEqual(first.shaders[0].fingerprint,first.shaders[1].fingerprint);
  assert(!JSON.stringify(sent).includes('private-source'));
  assert.equal(sent[3].value.profile.pixels,250000);
  assert.equal(sent[3].value.profile.instanceCatalog,true);
  assert.equal(sent[2].value.gpu.renderer,'Apple Software Renderer');
});

test('startup profiles accept only the exact optional rendering booleans', () => {
  const profile = {sequence:1,event:'profile',time:1,profile:{pixels:250000,shadowSize:512}};
  for (const key of ['instanceCatalog','diffuseLighting']) {
  for (const value of [true,false]) assert.equal(validateCheckpoint({...profile,
    profile:{...profile.profile,[key]:value}}).profile[key],value);
  for (const value of [0,1,'true',null,{},[]]) assert.throws(()=>validateCheckpoint({...profile,
    profile:{...profile.profile,[key]:value}}));
  }
  assert.throws(()=>validateCheckpoint({...profile,profile:{pixels:true}}));
  assert.throws(()=>validateCheckpoint({...profile,profile:{privateFlag:true}}));
});

test('a later blocked lighting link retains program identity and source fingerprints', () => {
  const {Canvas,gl,sent} = simulatedBrowser(undefined,'link');
  new Canvas().getContext('webgl2');
  const first=makeProgram(gl,1);
  assert.throws(()=>gl.linkProgram(first),/blocked link/);
  const second=makeProgram(gl,2);
  assert.throws(()=>gl.linkProgram(second),/blocked link/);
  assert.equal(sent.at(-1).value.event,'link-before');
  assert.equal(sent.at(-1).value.program,2);
  assert.equal(sent.at(-1).value.shaders.length,2);
  assert(!JSON.stringify(sent).includes('private-source'));
});

test('fingerprints hash bounded prefixes and schema rejects full sources or malformed metadata', () => {
  const {Canvas,gl,sent} = simulatedBrowser();new Canvas().getContext('webgl2');
  const shader=gl.createShader(gl.FRAGMENT_SHADER), program={};
  gl.shaderSource(shader,'a'.repeat(100000));gl.attachShader(program,shader);gl.linkProgram(program);
  const value=sent.at(-1).value, metadata=value.shaders[0];
  assert.equal(metadata.length,100000);assert.equal(metadata.hashedLength,65536);
  assert.match(metadata.fingerprint,/^fnv1a32:[0-9a-f]{8}$/);
  validateCheckpoint(value);
  for (const change of [{source:'private'},{length:-1},{hashedLength:100000},{fingerprint:'private'}, {type:'program'}]) {
    assert.throws(()=>validateCheckpoint({...value,shaders:[{...metadata,...change}]}));
  }
  assert.throws(()=>validateCheckpoint({...value,program:9}));
  assert.throws(()=>validateCheckpoint({...value,shaders:[metadata,metadata,metadata]}));
});

test('a blocked first GL call retains its before checkpoint and preserves the exception', () => {
  const {Canvas,gl,sent} = simulatedBrowser(undefined,'compile');
  new Canvas().getContext('webgl2');
  assert.throws(()=>gl.compileShader({}),/blocked compile/);
  assert.equal(sent.at(-1).value.event,'compile-before');
  const outside=simulatedBrowser('https://example.com/private');
  new outside.Canvas().getContext('webgl2');
  assert.deepEqual(outside.sent,[]);
  assert.equal(outside.context.window.__homeStudioStartupProfile,undefined);
});

test('the real planner fixture permits only its exact diagnostic origin', () => {
  const source=fs.readFileSync(path.join(__dirname,'test-planner-stability.cjs'),'utf8');
  const start=source.indexOf('const server=http.createServer('), end=source.indexOf('\nasync function run(',start);
  const startup=createStartupDiagnostics(path.join(os.tmpdir(),'unused-startup.jsonl'));
  const handle=vm.runInNewContext(source.slice(start,end)+'\nserver',{
    http:{createServer:callback=>Object.assign(callback,{address:()=>({port:12345})})},
    URL,fs,path,root:path.join(__dirname,'..'),startup,sourceHash:'a'.repeat(64),fixtureOnly:true,traceRecovery:false,
    instrument:function instrument() {},
  });
  let html;
  handle({url:'/planner/'},{writeHead(){return this;},end(value){html=value;}});
  assert(html.includes('connect-src http://127.0.0.1:12345;'));
  assert(!html.includes('connect-src http://127.0.0.1:*'));
  assert(html.includes('})("http://127.0.0.1:12345");'));
  assert(fs.readFileSync(path.join(__dirname,'../planner/index.html'),'utf8').includes("connect-src 'none'"));
});

test('the real planner fixture serves its complete local module graph without exposing root files', () => {
  const root=path.join(__dirname,'..'),source=fs.readFileSync(path.join(__dirname,'test-planner-stability.cjs'),'utf8');
  const start=source.indexOf('const server=http.createServer('),end=source.indexOf('\nasync function run(',start);
  const handle=vm.runInNewContext(source.slice(start,end)+'\nserver',{
    http:{createServer:callback=>Object.assign(callback,{address:()=>({port:12345})})},
    URL,fs,path,root,startup:createStartupDiagnostics(),sourceHash:'a'.repeat(64),fixtureOnly:false,traceRecovery:false,
    editor:fs.readFileSync(path.join(root,'planner/editor.js'),'utf8'),
  });
  const request=route=>{
    let status,headers,content;
    handle({url:route},{writeHead(code,value){status=code;headers=value;return this;},end(value){content=value;}});
    return {status,headers,content};
  };
  const pending=['/planner/editor.js'],seen=new Set();
  while(pending.length){
    const route=pending.pop();if(seen.has(route))continue;seen.add(route);
    const response=request(route);assert.equal(response.status,200,route);
    assert.equal(response.headers['Content-Type'],'text/javascript',route);
    const code=response.content.toString();
    for(const match of code.matchAll(/(?:\bfrom\s*|\bimport\s*)['"]([^'"]+)['"]/g)){
      assert(match[1].startsWith('.'),'Fixture modules must remain local');
      pending.push(new URL(match[1],`http://fixture${route}`).pathname);
    }
  }
  for(const name of ['pbr-color-data','pbr-materials','material-textures','environment-lighting'])assert(seen.has(`/${name}.js`));
  for(const route of ['/package.json','/build.py','/runtime-size-budget.json','/pbr-materials.js.bak','/not-a-module.js','/planner/../build.py','/planner/%2e%2e/build.py'])
    assert.equal(request(route).status,404,`Do not expose ${route}`);
});

test('loopback receiver persists bounded whitelisted data, rejecting paths, private fields and excess payloads', async () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'home-studio-startup-test-'));
  const filename=path.join(directory,'startup.jsonl'), receiver=createStartupDiagnostics(filename), sourceHash='a'.repeat(64);
  const server=http.createServer((request,response)=>{
    if(!receiver.handle(request,response,sourceHash))response.writeHead(404).end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const post=(body,route='/__home-studio-startup')=>fetch(origin+route,{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify(body)});
  try {
    const value={sequence:1,event:'gpu',time:1,gpu:{version:'WebGL 2.0',renderer:'Apple Software Renderer'}};
    assert.equal((await post({...value,path:'../../private.txt'})).status,400);
    assert.equal((await post({...value,project:{title:'private'}})).status,400);
    assert.equal((await post({...value,gpu:{version:'WebGL 2.0',renderer:'x'.repeat(5000)}})).status,413);
    assert.equal((await post(value,'/other')).status,404);
    assert.equal((await post(value)).status,204);
    assert.equal((await post(value)).status,204);
    for(let sequence=2;sequence<=56;sequence++)assert.equal((await post({sequence,event:'context-before',time:sequence})).status,204);
    assert.equal((await post({sequence:57,event:'context-before',time:57})).status,400);
    const records=fs.readFileSync(filename,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length,56);
    assert.deepEqual(records[0],{sourceHash,...value});
    assert.deepEqual(fs.readdirSync(directory),['startup.jsonl']);
    assert.equal(receiver.checkpointSource('a;const profile = detect();b;','const profile = detect();','profile'),
      'a;const profile = detect();;window.__homeStudioStartupProfile?.(profile);b;');
    assert.throws(()=>receiver.checkpointSource('changed','missing','profile'),/exactly once/);
    assert.equal(receiver.allowLoopback("default-src 'none'; connect-src 'none';", origin),
      `default-src 'none'; connect-src ${origin};`);
    assert.throws(()=>receiver.allowLoopback("connect-src 'none'",'https://example.com'),/Exact loopback/);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(directory,{recursive:true,force:true});
  }
});


test('raster capacity checkpoints accept only bounded measured evidence or unavailable status', () => {
  const check = rasterProbe => validateCheckpoint({sequence:1,event:'profile',time:1,profile:{pixels:250000,rasterProbe}});
  const pixels = Array.from({length:5}, (_,i) => [88+i,88+i,88+i,255]);
  const measured = {status:'measured',samplesMs:[15,16,17],pixels,bestMs:15,totalMs:110};
  check(measured); check({status:'unavailable'}); check({status:'unavailable',totalMs:8});
  for (const rasterProbe of [null, [], {}, {status:'software'},
    {...measured,identity:'Apple Software Renderer'}, {...measured,samplesMs:[15,16]},
    {...measured,samplesMs:[15,16,17,18]}, {...measured,samplesMs:[15,-1,17]},
    {...measured,samplesMs:[15,Infinity,17]}, {...measured,samplesMs:[15,NaN,17]},
    {...measured,samplesMs:[15,'16',17]}, {...measured,samplesMs:[15,1e10,17]},
    {...measured,pixels:undefined}, {...measured,pixels:pixels.slice(1)},
    {...measured,pixels:Array(5).fill([88,88,88,255])}, {...measured,pixels:[...pixels.slice(1),[255,255,255,255]]},
    {...measured,pixels:[...pixels.slice(1),[0,0,0,255]]}, {...measured,pixels:[...pixels.slice(1),[88,88,88,0]]},
    {...measured,pixels:[...pixels.slice(1),[88.5,88,88,255]]}, {...measured,bestMs:16}, {...measured,bestMs:NaN}, {...measured,totalMs:47},
    {...measured,totalMs:Infinity}, {...measured,totalMs:-1}, {...measured,totalMs:undefined},
    {status:'unavailable',samplesMs:[1,2,3]}, {status:'unavailable',bestMs:15},
    {status:'unavailable',totalMs:NaN}, {status:'unavailable',totalMs:1e10}]) assert.throws(() => check(rasterProbe));
});

test('first draw per initial program adds at most sixteen records and restores native methods', () => {
  let original;
  const names=['useProgram','drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced'];
  const {context,Canvas,gl,sent,calls}=simulatedBrowser(undefined,undefined,({gl})=>{
    original=Object.fromEntries(names.map(name=>[name,gl[name]]));
  });
  new Canvas().getContext('webgl2');
  context.window.__homeStudioStartupProfile({pixels:250000});
  for(let index=1;index<=9;index++) {
    const program=makeProgram(gl,index);
    gl.linkProgram(program);gl.getProgramParameter(program,gl.LINK_STATUS);
    gl.useProgram(program);
    const kind=names[1+(index-1)%4];
    gl[kind](4,0,3);gl[kind](4,0,3);
  }
  assert.equal(sent.length,56);
  const records=sent.filter(({value})=>value.event.startsWith('draw-')).map(({value})=>value);
  assert.equal(records.length,16);
  assert.deepEqual(records.filter(value=>value.event==='draw-before').map(value=>value.program),[1,2,3,4,5,6,7,8]);
  assert.deepEqual([...new Set(records.map(value=>value.drawKind))],names.slice(1));
  assert(records.filter(value=>value.event==='draw-after').every(value=>value.durationMs===0 && value.threw===false));
  assert(records.every(value=>JSON.stringify(value.drawingBuffer)==='[500,500]'));
  assert.equal(calls.filter(call=>call.startsWith('draw')).length,18);
  for(const name of names)assert.equal(gl[name],original[name]);
  for(const {value} of sent)validateCheckpoint(value);
});

test('draw submission timing excludes diagnostic sends and preserves receiver, arguments and return value', () => {
  let clock=0, received, programReceived, result={native:true};
  const {Canvas,gl,sent}=simulatedBrowser(undefined,undefined,({gl,context})=>{
    context.performance.now=()=>clock;
    const send=context.fetch;
    context.fetch=(...args)=>{clock+=100;return send(...args);};
    gl.useProgram=function(...args){programReceived={receiver:this,args};return result;};
    gl.drawElements=function(...args){received={receiver:this,args};clock+=37;return result;};
  });
  new Canvas().getContext('webgl2');
  const program=makeProgram(gl,1);gl.linkProgram(program);
  assert.equal(gl.useProgram(program,'extra'),result);
  assert.equal(programReceived.receiver,gl);assert.deepEqual(programReceived.args,[program,'extra']);
  for(const name of ['getParameter','getExtension','readPixels','finish','flush','fenceSync','clientWaitSync']) {
    gl[name]=()=>{throw Error(`unexpected synchronizing/query call ${name}`);};
  }
  assert.equal(gl.drawElements(4,123,5123,24),result);
  assert.equal(received.receiver,gl);assert.deepEqual(received.args,[4,123,5123,24]);
  const after=sent.at(-1).value;
  assert.equal(after.event,'draw-after');assert.equal(after.durationMs,37);assert.equal(after.threw,false);
});

test('native draw and useProgram exception identities survive diagnostic failures', () => {
  for(const fault of ['none','clock','send']) {
    const failure={nativeFailure:true};let draws=0;
    const {Canvas,gl,sent,context}=simulatedBrowser(undefined,undefined,({gl})=>{
      gl.drawArrays=()=>{draws++;throw failure;};
    });
    new Canvas().getContext('webgl2');
    const program=makeProgram(gl,1);gl.linkProgram(program);gl.useProgram(program);
    if(fault==='clock')context.performance.now=()=>{throw Error('clock unavailable');};
    if(fault==='send')context.fetch=()=>{throw Error('send unavailable');};
    assert.throws(()=>gl.drawArrays(4,0,3),error=>error===failure);
    assert.equal(draws,1);
    if(fault==='none') {
      assert.equal(sent.at(-1).value.event,'draw-after');
      assert.equal(sent.at(-1).value.threw,true);
    }
  }
  const failure={useProgramFailure:true};
  const {Canvas,gl,sent}=simulatedBrowser(undefined,undefined,({gl})=>{
    gl.useProgram=()=>{throw failure;};
  });
  new Canvas().getContext('webgl2');
  const program=makeProgram(gl,1);gl.linkProgram(program);
  assert.throws(()=>gl.useProgram(program),error=>error===failure);
  gl.drawArrays(4,0,3);
  assert(!sent.some(({value})=>value.event.startsWith('draw-')));
});

test('out-of-order use and relinked program objects do not finish or replenish the initial set', () => {
  const {Canvas,gl,sent}=simulatedBrowser();new Canvas().getContext('webgl2');
  const initialWrapper=gl.drawElements;
  const programs=Array.from({length:8},(_,index)=>{
    const program=makeProgram(gl,index);gl.linkProgram(program);return program;
  });
  gl.useProgram(programs[7]);gl.drawElements(4,3,5123,0);
  assert.equal(gl.drawElements,initialWrapper,'using program8 first does not end the probe');
  gl.linkProgram(programs[7]);gl.deleteProgram(programs[7]);
  gl.drawElements(4,3,5123,0);
  for(const program of programs.slice(0,7)){gl.useProgram(program);gl.drawElements(4,3,5123,0);}
  assert.notEqual(gl.drawElements,initialWrapper);
  assert.deepEqual(sent.filter(({value})=>value.event==='draw-before').map(({value})=>value.program),[8,1,2,3,4,5,6,7]);
});

test('throwing draws still exhaust the bounded sample and restore the original method', () => {
  const failure={nativeDrawFailure:true};let original;
  const {Canvas,gl,sent}=simulatedBrowser(undefined,undefined,({gl})=>{
    gl.drawElements=original=()=>{throw failure;};
  });
  new Canvas().getContext('webgl2');
  for(let index=1;index<=8;index++) {
    const program=makeProgram(gl,index);gl.linkProgram(program);gl.useProgram(program);
    assert.throws(()=>gl.drawElements(4,3,5123,0),error=>error===failure);
  }
  assert.equal(gl.drawElements,original);
  const records=sent.filter(({value})=>value.event.startsWith('draw-')).map(({value})=>value);
  assert.equal(records.length,16);
  assert(records.filter(value=>value.event==='draw-after').every(value=>value.threw===true));
});

test('unused programs stop at a later untracked program without clobbering replacement wrappers', () => {
  let original;
  const {Canvas,gl,sent}=simulatedBrowser(undefined,undefined,({gl})=>{original=gl.drawArrays;});
  new Canvas().getContext('webgl2');
  for(let index=1;index<=9;index++){const program=makeProgram(gl,index);gl.linkProgram(program);if(index===9)gl.useProgram(program);}
  assert.equal(gl.drawArrays,original);
  assert(!sent.some(({value})=>value.event.startsWith('draw-')));

  const next=simulatedBrowser();new next.Canvas().getContext('webgl2');
  const replacement=()=>{};next.gl.drawElements=replacement;
  for(let index=1;index<=8;index++) {
    const program=makeProgram(next.gl,index);next.gl.linkProgram(program);
    next.gl.useProgram(program);next.gl.drawArrays(4,0,3);
  }
  assert.equal(next.gl.drawElements,replacement);
});

test('few-program scenes detach after a fixed observation budget with no subsequent timing overhead', () => {
  let original,reads=0;
  const {Canvas,gl,sent}=simulatedBrowser(undefined,undefined,({gl,context})=>{
    original={draw:gl.drawArrays,use:gl.useProgram};context.performance.now=()=>{reads++;return 1;};
  });
  new Canvas().getContext('webgl2');
  const program=makeProgram(gl,1);gl.linkProgram(program);gl.useProgram(program);
  for(let index=1;index<4096;index++)gl.drawArrays(4,0,3);
  assert.notEqual(gl.drawArrays,original.draw);
  gl.drawArrays(4,0,3);
  assert.equal(gl.drawArrays,original.draw);assert.equal(gl.useProgram,original.use);
  const before=reads, count=sent.length;
  for(let index=0;index<100;index++){gl.useProgram(program);gl.drawArrays(4,0,3);}
  assert.equal(reads,before);assert.equal(sent.length,count);
  assert.equal(sent.filter(({value})=>value.event.startsWith('draw-')).length,2);
});

test('draw schema accepts only bounded submission metadata and exception booleans', () => {
  const before={sequence:41,event:'draw-before',time:1,program:1,drawKind:'drawElements'};
  const after={...before,sequence:42,event:'draw-after',durationMs:3,threw:false};
  validateCheckpoint(before);validateCheckpoint(after);validateCheckpoint({...after,threw:true});
  for(const patch of [{program:0},{program:9},{program:null},{drawKind:'readPixels'},{drawKind:'drawRangeElements'},
    {durationMs:-1},{durationMs:Infinity},{durationMs:NaN},{durationMs:1e10},{durationMs:undefined},
    {durationMs:'3'},{threw:null},{threw:1},{threw:undefined},{source:'private'}]) {
    assert.throws(()=>validateCheckpoint({...after,...patch}));
  }
  assert.throws(()=>validateCheckpoint({...before,durationMs:0}));
  assert.throws(()=>validateCheckpoint({...before,threw:false}));
  assert.throws(()=>validateCheckpoint({...after,event:'link-after'}));
  assert.throws(()=>validateCheckpoint({...after,sequence:57}));
});
