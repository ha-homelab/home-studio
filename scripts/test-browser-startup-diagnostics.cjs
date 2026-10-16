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
  const gl = {VERSION:1, RENDERER:2, LINK_STATUS:3, drawingBufferWidth:500, drawingBufferHeight:500,
    getExtension:()=>({UNMASKED_RENDERER_WEBGL:4}),
    getParameter:key=>key === 1 ? 'WebGL 2.0' : 'Apple Software Renderer',
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

test('opaque-frame probe keeps original calls and emits at most ten safe loopback checkpoints', () => {
  const {context,Canvas,gl,sent,calls} = simulatedBrowser();
  const canvas = new Canvas();
  assert.equal(canvas.getContext('webgl2'),gl);
  context.window.__homeStudioStartupProfile({pixels:250000,pointShadows:2,pointShadowSize:128,sunShadowSize:512});
  gl.compileShader({});gl.linkProgram({});assert.equal(gl.getProgramParameter({},gl.LINK_STATUS),true);
  gl.compileShader({});gl.linkProgram({});gl.getProgramParameter({},gl.LINK_STATUS);
  new Canvas().getContext('webgl2');
  context.window.__homeStudioStartupProfile({pixels:2000000});
  assert.equal(sent.length,10);
  assert.deepEqual(sent.map(item=>item.value.event),['context-before','context-after','gpu','profile',
    'compile-before','compile-after','link-before','link-after','link-status-before','link-status-after']);
  assert.deepEqual(calls,['context','compile','link','status','compile','link','status','context']);
  for (const item of sent) {
    assert.equal(item.url,'http://127.0.0.1:12345/__home-studio-startup');
    assert.equal(item.options.mode,'no-cors');
    validateCheckpoint(item.value);
  }
  assert.equal(sent[3].value.profile.pixels,250000);
  assert.equal(sent[2].value.gpu.renderer,'Apple Software Renderer');
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
    for(let sequence=2;sequence<=10;sequence++)assert.equal((await post({sequence,event:'context-before',time:sequence})).status,204);
    assert.equal((await post({sequence:11,event:'context-before',time:11})).status,400);
    const records=fs.readFileSync(filename,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length,10);
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
