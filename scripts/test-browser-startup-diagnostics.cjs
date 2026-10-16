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

function simulatedBrowser(referrer = 'http://127.0.0.1:12345/', block) {
  const sent = [], calls = [];
  const gl = {VERSION:1, RENDERER:2, LINK_STATUS:3, VERTEX_SHADER:5, FRAGMENT_SHADER:6, drawingBufferWidth:500, drawingBufferHeight:500,
    getExtension:()=>({UNMASKED_RENDERER_WEBGL:4}),
    getParameter:key=>key === 1 ? 'WebGL 2.0' : 'Apple Software Renderer',
    createShader(type){return {type};}, shaderSource(){}, attachShader(){},
    compileShader(){calls.push('compile');if(block === 'compile')throw Error('blocked compile');},
    linkProgram(){calls.push('link');if(block === 'link')throw Error('blocked link');},
    getProgramParameter(){calls.push('status');return true;},
  };
  class Canvas {constructor(){this.width=500;this.height=500;}getContext(){calls.push('context');return gl;}}
  const context = {window:{}, document:{referrer}, location:{href:'about:srcdoc'}, URL,
    HTMLCanvasElement:Canvas, performance:{now:()=>7},
    fetch:(url, options)=>{sent.push({url,options,value:JSON.parse(options.body)});return Promise.resolve();}};
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
    for(let sequence=2;sequence<=40;sequence++)assert.equal((await post({sequence,event:'context-before',time:sequence})).status,204);
    assert.equal((await post({sequence:41,event:'context-before',time:41})).status,400);
    const records=fs.readFileSync(filename,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length,40);
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
