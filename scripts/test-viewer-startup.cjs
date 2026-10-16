// Execute the real startup/render/resize functions with controlled frames/timers.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../viewer.js'), 'utf8');
const lines = source.split('\n');

function exercise(embedded, {hidden = false, documentHidden = false, initialRoom = null, failRender = false} = {}) {
  const errors = [], calls = [], sizes = [], frames = new Map(), timers = new Map(), events = {}, listeners = {};
  let serial = 0, now = 0, disposals = 0;
  const loadError = {style: {}};
  const box = {width: hidden ? 0 : 800, height: hidden ? 0 : 600};
  const c = vm.createContext({
    embedded, window: {addEventListener(type, fn) {events[type] = fn;}},
    homeView: null, renderCount: 0, scene: {}, devicePixelRatio: 1, renderProfile: {pixels: 2000000},
    document: {hidden: documentHidden, addEventListener(type, fn) {events[type] = fn;}},
    setTimeout(fn, delay) {timers.set(++serial, {fn, at: now + delay}); return serial;},
    clearTimeout(id) {timers.delete(id);},
    requestAnimationFrame(fn) {frames.set(++serial, fn); return serial;},
    cancelAnimationFrame(id) {frames.delete(id);},
    model: {initial_room: initialRoom}, camera: {updateProjectionMatrix() {}},
    console: {error(error) { errors.push(error.message); }},
    updateWallOutlines() {}, updateEditorCamera() {}, invalidateShadows() {},
    wallSheenMotion: {beforeRender() {}, afterRender() {}},
    observer: {disconnect() {}}, releaseStaticGlassPasses() {}, disposeStaticGlassPasses() {},
    $(id) { return id === 'loadError' ? loadError : {getBoundingClientRect: () => box}; },
    renderer: {
      domElement: {addEventListener(type, fn) {listeners[type] = fn;}},
      setDrawingBufferSize(width, height) { sizes.push([width, height]); },
      render() { calls.push({mode: 'editor', published: c.completed === true}); },
      dispose() {disposals++;}, forceContextLoss() {},
    },
    focusRoom(id) { c.focused = id; c.window.renderModel(); },
    rebuildInventoryView() { c.window.renderModel(); },
  });
  const prefixes = ['let initialViewReady=', 'let renderRequest=', 'let interactionRenderer=',
    'function finishInitialView(', 'function startInitialView(', 'function cancelInitialView(',
    'function report3DError(', 'function drawScene(', 'function renderPixelRatio(',
    'function cancelRender(', 'function requestRender(', 'function render(){'];
  for (const prefix of prefixes) {
    const line = lines.find(value => value.startsWith(prefix));
    assert(line, 'Actual startup function exists: ' + prefix);
    vm.runInContext(line, c);
  }
  const resize = lines.find(line => line.startsWith("let viewSize='';")).split(';const observer=')[0] + ';';
  vm.runInContext(resize, c);
  for (const prefix of ["renderer.domElement.addEventListener('webglcontextlost'", "renderer.domElement.addEventListener('webglcontextrestored'",
    "document.addEventListener('visibilitychange'", "window.addEventListener('pagehide'", "window.addEventListener('pageshow'"]) {
    vm.runInContext(lines.find(line => line.startsWith(prefix)), c);
  }
  c.window.resizeModel();
  c.homeView = {
    active: false,
    setActive(value) {this.active = value; c.requestAnimationFrame(() => c.window.resizeModel());},
    render() {
      if (failRender) throw Error('first draw failed');
      calls.push({mode: 'home', published: c.completed === true, state: c.latestState});
      c.renderCount++;
    },
  };
  const bootstrap = lines.find(line => line.startsWith('rebuildInventoryView();if(embedded)')).split('window.floorplan=')[0];
  vm.runInContext(bootstrap + 'this.completed=true;', c);
  const flushFrames = () => {
    let count = 0;
    while (frames.size) {
      assert(++count < 20, 'No idle frame loop');
      for (const [id, fn] of [...frames]) if (frames.delete(id)) fn();
    }
  };
  const advance = ms => {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a,b) => a[1].at-b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].fn();
    }
    now = end;
  };
  return {c, calls, sizes, box, frames, timers, events, listeners, flushFrames, advance, errors, loadError, get disposals() {return disposals;}};
}

const home = exercise(true);
assert.equal(home.c.completed, true);
assert.deepEqual(home.calls, [], 'Embedded bootstrap publishes before drawing');
assert.deepEqual(home.sizes, [], 'Skipped startup sizes do not poison the resize cache');
home.flushFrames();
assert.deepEqual(home.calls, [], 'First rendering opportunity waits for states or the bounded fallback');
home.c.latestState = 'new HA state';
home.c.rebuildInventoryView(); home.c.window.resizeModel(); home.c.requestRender();
home.c.finishInitialView(); home.c.finishInitialView();
assert.equal(home.timers.size, 0, 'A state receipt cancels the fallback');
assert.deepEqual(home.calls, [], 'State receipt never draws synchronously');
home.flushFrames();
assert.deepEqual(home.calls, [{mode: 'home', published: true, state: 'new HA state'}]);
assert.deepEqual(home.sizes, [[800, 600]]);
home.advance(1000); home.flushFrames();
assert.equal(home.calls.length, 1, 'The cancelled fallback cannot draw a duplicate frame');
home.c.window.resizeModel();
assert.equal(home.calls.length, 1, 'An unchanged resize cannot duplicate a draw');
home.c.homeView.setActive(false); home.flushFrames();
assert.equal(home.calls.at(-1).mode, 'editor');
home.c.homeView.setActive(true); home.flushFrames();
assert.equal(home.calls.at(-1).mode, 'home');
home.box.width = 1000; home.c.window.resizeModel();
assert.equal(home.calls.length, 4, 'Later resize still draws');
home.c.window.renderModel(); assert.equal(home.calls.length, 5);

const fallback = exercise(true);
fallback.advance(30); fallback.c.startInitialView();
fallback.advance(60); fallback.c.startInitialView(); fallback.flushFrames();
assert.equal(fallback.calls.length, 0);
fallback.advance(9); fallback.flushFrames(); assert.equal(fallback.calls.length, 0);
fallback.advance(1); assert.equal(fallback.calls.length, 0, 'Even fallback sizing waits for RAF');
fallback.flushFrames(); assert.equal(fallback.calls.length, 1, 'Missing host gets its preview after 100 ms, without resetting the deadline');
fallback.c.latestState = 'late state'; fallback.c.finishInitialView(); fallback.c.requestRender(); fallback.flushFrames();
assert.equal(fallback.calls.length, 2); assert.equal(fallback.calls.at(-1).state, 'late state');
assert.equal(fallback.timers.size, 0, 'Late states cannot restart the startup timer');

const switched = exercise(true);
switched.c.homeView.setActive(false); switched.box.width = 900;
switched.c.finishInitialView(); switched.flushFrames();
assert.deepEqual(switched.calls, [{mode: 'editor', published: true}], 'First draw honors early mode changes');
assert.deepEqual(switched.sizes, [[900, 600]], 'First sizing reads the latest preference/layout');
const hidden = exercise(true, {hidden: true});
hidden.advance(100); hidden.flushFrames(); assert.deepEqual(hidden.calls, []);
hidden.box.width = 800; hidden.box.height = 600; hidden.c.window.resizeModel();
assert.equal(hidden.calls[0].mode, 'home', 'A zero-sized panel draws once it is visible');
const background = exercise(true, {documentHidden: true});
background.advance(100); background.flushFrames(); assert.deepEqual(background.calls, []);
background.c.document.hidden = false; background.events.visibilitychange(); background.advance(100); background.flushFrames();
assert.equal(background.calls.length, 1, 'Visibility resumes the pending first draw without another timer');
const lost = exercise(true);
lost.c.finishInitialView(); lost.listeners.webglcontextlost({preventDefault(){}}); lost.flushFrames();
assert.equal(lost.calls.length, 0);
lost.listeners.webglcontextrestored(); lost.flushFrames();
assert.equal(lost.calls.length, 1, 'Context restoration resumes the pending first draw');
for (const received of [false, true]) {
  const cached = exercise(true);
  if (received) cached.c.finishInitialView();
  cached.events.pagehide({persisted:true}); cached.advance(1000); cached.flushFrames();
  assert.equal(cached.calls.length, 0); assert.equal(cached.timers.size, 0); assert.equal(cached.disposals, 0);
  cached.events.pageshow({persisted:true}); if (!received) cached.advance(100); cached.flushFrames();
  assert.equal(cached.calls.length, 1, 'BFCache preserves a received state or rearms one bounded fallback');
}
const retired = exercise(true);
retired.c.finishInitialView(); retired.events.pagehide({persisted:false});
retired.c.finishInitialView(); retired.advance(1000); retired.flushFrames();
assert.equal(retired.calls.length, 0); assert.equal(retired.frames.size, 0); assert.equal(retired.timers.size, 0);
assert.equal(retired.disposals, 1, 'Terminal pagehide cancels every pending startup callback');
const failed = exercise(true, {failRender: true});
failed.advance(100); failed.flushFrames();
assert.deepEqual(failed.errors, ['first draw failed']);
assert.equal(failed.loadError.style.display, 'block');
assert.match(failed.loadError.textContent, /first draw failed/);
assert.equal(failed.c.completed, true, 'A first-draw error cannot abort publication');
for (const initialRoom of [null, 'L']) {
  const standalone = exercise(false, {initialRoom});
  assert.deepEqual(standalone.calls.map(call => call.mode), initialRoom ? ['editor', 'editor', 'editor'] : ['editor', 'editor']);
  assert.deepEqual(standalone.sizes, [[800, 600]]);
  assert.equal(standalone.c.focused, initialRoom || undefined);
  assert.equal(standalone.timers.size, 0, 'Standalone preview never waits for host states');
}
console.log('PASS: bounded initial-state gate, RAF sizing, fallback, early mode/layout, visibility/loss/BFCache, terminal cancellation, standalone and first-draw errors.');

// A matching host handshake must not discard the geometry and shadow maps just
// built at boot. Execute the actual handler, validator and reconciler together.
function exerciseHostInventory(transform = value => value) {
  const bootItems = [{id: 'lamp', name: 'Lamp', type: 'lamp', room: 'A', entity_id: 'light.lamp',
    position_m: {x: 1, y: 2, z: 3}, dimensions_m: {width: .3, depth: .3, height: .2}, rotation_deg: 0}];
  const calls = {builds: 0, refreshes: 0, preferences: [], sent: [], status: [], removed: 0, releases: 0, cameraClears: 0};
  let handler;
  const aside = {inert: true}, parent = {}, port = {postMessage: message => calls.sent.push(message)};
  const c = vm.createContext({
    items: bootItems, bridge: null, parent, model: {rooms: [{id: 'A'}], inventory: bootItems}, presets: {lamp: {}},
    appearanceRefreshNotice: '', inventoryAppearance() { return {}; },
    window: {addEventListener(type, callback) { assert.equal(type, 'message'); handler = callback; },
      removeEventListener(type, callback) { assert.equal(callback, handler); calls.removed++; }},
    document: {querySelector: () => aside, createElement: () => ({})},
    $() {return {replaceChildren(){}};},
    finishInitialView() {calls.releases++;}, applyCameraFrames() {calls.cameraClears++;},
    homeView: {applyViewPreferences(value) { calls.preferences.push(value); }},
    setEditorStatus(value) { calls.status.push(value); },
    refreshEntityPresentation() { calls.refreshes++; },
    rebuildInventoryView() { calls.builds++; c.refreshEntityPresentation(); },
    haStates: {}, haConnected: false, entityOptions: '[]',
  });
  const reconcileStart = source.indexOf('function reconcileStoredAppearance(');
  const validateEnd = source.indexOf('\n', source.indexOf('function validateInventoryItems('));
  vm.runInContext(lines.find(line => line.startsWith('function isViewerStatesMessage(')), c);
  vm.runInContext(source.slice(reconcileStart, validateEnd), c);
  vm.runInContext(source.split('\n').find(line => line.startsWith('function inventorySnapshot(')), c);
  const initStart = source.indexOf("window.addEventListener('message',function init(event)");
  const initEnd = source.indexOf('\n});', initStart);
  assert(initStart >= 0 && initEnd > initStart, 'Actual host initialization handler exists');
  vm.runInContext(source.slice(initStart, initEnd + 4), c);
  const incoming = transform(JSON.parse(JSON.stringify(bootItems)));
  handler({source: parent, data: {type: 'home-floorplan:init', items: incoming, preferences: {sidebarCollapsed: true}}, ports: [port]});
  return {c, calls, bootItems, aside, port};
}
const sameInventory = exerciseHostInventory();
assert.equal(sameInventory.calls.builds, 0, 'Identical validated inventory reuses boot geometry and shadow maps');
assert.equal(sameInventory.c.items, sameInventory.bootItems, 'Identical data preserves the assigned array');
assert.equal(sameInventory.calls.refreshes, 0, 'An unchanged handshake does not redraw the already-presented disconnected state');
assert.equal(sameInventory.aside.inert, false);
assert.equal(sameInventory.c.bridge, sameInventory.port);
assert.equal(sameInventory.calls.preferences[0].sidebarCollapsed, true);
assert.equal(sameInventory.calls.sent[0].type, 'model_config');
assert.equal(sameInventory.calls.removed, 1);
for (const data of [null, {}, {type:'states',connected:true}, {type:'states',connected:true,states:null},
  {type:'states',connected:true,states:[]}, {type:'states',connected:'true',states:{}},
  {type:'states',connected:true,states:{'light.bad':null}}, {type:'states',connected:true,states:{'light.bad':[]} }]) {
  sameInventory.port.onmessage({data});
}
assert.equal(sameInventory.calls.refreshes, 0, 'Malformed state packets cannot replace presentation');
assert.equal(sameInventory.calls.releases, 0, 'Malformed state packets cannot release the startup gate');
sameInventory.port.onmessage({data: {type: 'states', connected: true, states: {}}});
assert.equal(sameInventory.calls.refreshes, 1, 'The first live host message refreshes presentation after skipping the unchanged handshake');
assert.equal(sameInventory.c.haConnected, true);
assert.equal(sameInventory.calls.releases, 1, 'An empty but valid first packet releases the gate');
const disconnectedInventory = exerciseHostInventory();
disconnectedInventory.port.onmessage({data: {type:'states', connected:false, states:{}}});
assert.equal(disconnectedInventory.calls.releases, 1, 'A disconnected packet releases the gate');
assert.equal(disconnectedInventory.calls.cameraClears, 1);
assert.equal(disconnectedInventory.c.haConnected, false);
const liveInventory = exerciseHostInventory();
liveInventory.port.onmessage({data: {type:'states', connected:true, states:{'light.lamp':{state:'on',name:'Lamp'}}}});
assert.equal(liveInventory.calls.releases, 1);
assert.equal(liveInventory.c.haStates['light.lamp'].state, 'on', 'The first real state is applied before release');
const reorderedInventory = exerciseHostInventory(items => items.map(item => Object.fromEntries(Object.entries(item).reverse().map(([key,value])=>[key,value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse()):value]))));
assert.equal(reorderedInventory.calls.builds, 0, 'JSON property order does not discard matching boot resources');
const changedInventory = exerciseHostInventory(items => { items[0].position_m.x = 7; return items; });
assert.equal(changedInventory.calls.builds, 1, 'Changed saved positions rebuild exactly once');
assert.notEqual(changedInventory.c.items, changedInventory.bootItems);
assert.equal(changedInventory.c.items[0].position_m.x, 7);
assert.equal(changedInventory.calls.refreshes, 1);
const invalidInventory = exerciseHostInventory(items => { items[0].position_m.x = 'invalid'; return items; });
assert.equal(invalidInventory.calls.builds, 0);
assert.equal(invalidInventory.calls.refreshes, 0);
assert.equal(invalidInventory.c.items, invalidInventory.bootItems, 'Invalid host data cannot replace boot data');
assert.equal(invalidInventory.c.bridge, null);
assert.equal(invalidInventory.aside.inert, true);
assert.equal(invalidInventory.calls.preferences.length, 0);
assert.equal(invalidInventory.calls.removed, 0, 'A rejected handshake can be retried');
assert.match(invalidInventory.calls.status[0], /Cannot load saved inventory: Coordinates must be finite numbers/);
console.log('PASS: matching host inventory retains boot resources; changed inventory, validation, preferences and live state delivery remain intact.');

// Feed the actual init/port handler into the same scheduler and paint counter.
// This catches ordering failures that isolated finishInitialView calls cannot.
function withHost(run) {
  const {c}=run, parent={}, sent=[];
  const port={postMessage(message){sent.push(message);}};
  let init;
  Object.assign(c,{parent,items:[],bridge:null,haStates:{},haConnected:false,entityOptions:'[]',
    appearanceRefreshNotice:'',validateInventoryItems:value=>value,reconcileStoredAppearance:value=>value,
    inventorySnapshot:JSON.stringify,setEditorStatus(){},applyCameraFrames(){},
    refreshEntityPresentation(){c.latestState={connected:c.haConnected,states:c.haStates};c.requestRender();}});
  c.homeView.applyViewPreferences=()=>{};
  c.document.querySelector=()=>({inert:true});
  c.document.createElement=()=>({});
  const element=c.$;c.$=id=>({...element(id),replaceChildren(){}});
  c.window.addEventListener=(type,fn)=>{assert.equal(type,'message');init=fn;};
  c.window.removeEventListener=()=>{};
  vm.runInContext(lines.find(line=>line.startsWith('function isViewerStatesMessage(')),c);
  const start=source.indexOf("window.addEventListener('message',function init(event)");
  vm.runInContext(source.slice(start,source.indexOf('\n});',start)+4),c);
  return {run,sent,init(){init({source:parent,data:{type:'home-floorplan:init',items:[],preferences:{}},ports:[port]});},
    state(data={type:'states',connected:true,states:{lamp:{state:'on',name:'Lamp'}}}){port.onmessage({data});}};
}

for(const order of [
  ['show','init','state','frame'],['init','show','state','frame'],
  ['init','state','show','frame'],['init','state','frame','show'],
  ['frame','show','init','state','frame'],
]) {
  const h=withHost(exercise(true)),r=h.run;
  for(const action of order) {
    if(action==='show')r.events.pageshow({persisted:false});
    else if(action==='frame')r.flushFrames();
    else h[action]();
  }
  r.flushFrames();r.advance(1000);r.flushFrames();
  assert.equal(h.sent[0].type,'model_config');
  assert.equal(r.calls.length,1,order.join(' → ')+' must produce one actual initial paint');
  assert.equal(r.calls[0].state.connected,true);
  assert.equal(r.calls[0].state.states.lamp.state,'on');
  assert.equal(r.c.renderCount,1);assert.equal(r.timers.size,0);
}

const burst=withHost(exercise(true));burst.init();burst.state();
burst.state({type:'states',connected:false,states:{}});
assert.equal(burst.run.calls.length,0,'No port message draws synchronously');
burst.run.flushFrames();
assert.equal(burst.run.calls.length,1);assert.equal(burst.run.calls[0].state.connected,false);
burst.state();burst.run.events.pageshow({persisted:false});burst.run.flushFrames();
assert.equal(burst.run.calls.length,2,'Later live state uses the ordinary single frame');
assert.equal(burst.run.calls[1].state.connected,true);assert.equal(burst.run.timers.size,0);

const atDeadline=withHost(exercise(true));atDeadline.run.advance(100);atDeadline.init();atDeadline.state();
atDeadline.run.flushFrames();assert.equal(atDeadline.run.calls.length,1);
assert.equal(atDeadline.run.calls[0].state.connected,true,'State arriving before fallback RAF replaces obsolete offline data');

for(const transition of ['hidden','lost','bfcache','discard']) {
  const h=withHost(exercise(true)),r=h.run;h.init();
  if(transition==='hidden'){r.c.document.hidden=true;r.events.visibilitychange();}
  else if(transition==='lost')r.listeners.webglcontextlost({preventDefault(){}});
  else r.events.pagehide({persisted:transition==='bfcache'});
  h.state();r.advance(1000);r.flushFrames();
  assert.equal(r.calls.length,0,transition+' suppresses delayed first paint');
  assert.equal(r.timers.size,0);assert.equal(r.frames.size,0);
  if(transition==='hidden'){r.c.document.hidden=false;r.events.visibilitychange();}
  else if(transition==='lost')r.listeners.webglcontextrestored();
  else if(transition==='bfcache')r.events.pageshow({persisted:true});
  r.flushFrames();assert.equal(r.calls.length,transition==='discard'?0:1);
  if(transition!=='discard')assert.equal(r.calls[0].state.connected,true);
  r.advance(1000);r.flushFrames();assert.equal(r.calls.length,transition==='discard'?0:1);
}
console.log('PASS: real bootstrap/init/states/pageshow ordering, latest-state first paint, deadline race and suspended first-state delivery.');

// Exercise the actual parent projection, including entities with no usable value.
// Availability is a state value, not grounds to reject a complete host snapshot.
const panel=fs.readFileSync(path.join(__dirname,'../custom_components/home_floorplan/static/panel.js'),'utf8');
const publishStart=panel.indexOf('  publishEntityStates() {');
const publishEnd=panel.indexOf('  async refreshCameraFrames() {',publishStart);
assert(publishStart>=0&&publishEnd>publishStart);
for(const connected of [undefined,true,false]) {
  const h=withHost(exercise(true));h.init();
  const emitted=[];
  const host={port:{postMessage(value){emitted.push(value);h.state(value);}},
    _hass:{connected,states:{'light.unknown':{state:'unknown',attributes:{friendly_name:'Unknown'}},
      'light.unavailable':{state:'unavailable',attributes:{friendly_name:'Unavailable'}}}},
    savedItems:[{entity_id:'cover.missing'}],curtains:{profiles:{},memory:{}},
    refreshTVFrame(){},refreshCameraFrames(){}};
  const parentContext=vm.createContext({host,projectRoomActivity:()=>({}),projectAssumedZoneActivity:()=>({})});
  vm.runInContext('('+`{${panel.slice(publishStart,publishEnd)}}`+').publishEntityStates.call(host)',parentContext);
  assert.equal(emitted.length,1);assert.equal(emitted[0].connected,connected!==false);
  h.run.flushFrames();
  assert.equal(h.run.calls.length,1,'An unavailable/unknown snapshot still permits the first real paint');
  const state=h.run.calls[0].state;
  assert.equal(state.connected,connected!==false);
  assert.equal(state.states['light.unknown'].state,'unknown');
  assert.equal(state.states['light.unavailable'].state,'unavailable');
  assert.equal(state.states['cover.missing'].state,'unavailable');
}
console.log('PASS: actual parent payloads preserve boolean connectivity and unknown/unavailable entity records.');
