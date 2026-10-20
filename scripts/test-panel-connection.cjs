// Exercise the real host lifecycle without HA, network traffic or device calls.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {Connection} = require('home-assistant-js-websocket');
const source = fs.readFileSync(path.join(__dirname, '../custom_components/home_floorplan/static/panel.js'), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve=yes; reject=no;});
  return {promise, resolve, reject};
};
const flush = async () => {for (let i=0; i<6; i++) await new Promise(setImmediate);};
const emptyPlan = floor => ({floor, floors:[floor], items:[], html:'', can_edit:false});
const connectionLost = () => ({type:'result', success:false, error:{code:3, message:'Connection lost'}});

function connection({subscribe, viewer, eventOnly = false} = {}) {
  const listeners = new Map(), reads = [], registrations = [], released = [];
  const value = {
    connected:true,
    addEventListener(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
    },
    removeEventListener(event, handler) {listeners.get(event)?.delete(handler);},
    emit(event) {
      if (!eventOnly) value.connected=event==='ready';
      for (const handler of [...(listeners.get(event) || [])]) handler();
    },
    subscribeMessage(callback, request, options) {
      assert.equal(request.type, 'home_floorplan/curtains');
      assert.equal(options?.resubscribe, false, 'the panel owns subscription recovery');
      registrations.push(callback);
      return subscribe ? subscribe(callback) : Promise.resolve(() => {released.push(callback);});
    },
    async callWS(request) {
      reads.push(request);
      assert.equal(request.type, 'home_floorplan/viewer', 'recovery may only read the viewer');
      return viewer ? viewer(request) : emptyPlan(request.floor || 'fixture');
    }
  };
  if (eventOnly) delete value.connected;
  return {value, listeners, reads, registrations, released};
}

function fixture() {
  let Panel;
  const notices=[], nodes=new Map();
  const document={addEventListener() {}, removeEventListener() {}};
  const context=vm.createContext({
    HTMLElement:class {}, customElements:{get() {}, define(_name, type) {Panel=type;}},
    URL, Blob, clearTimeout, document, removeEventListener() {},
  });
  vm.runInContext(source, context);
  const panel=Object.assign(Object.create(Panel.prototype), {
    isConnected:true, generation:0, queue:Promise.resolve(), pending:0, failed:false,
    tvFrames:{}, viewPreferences:{language:'en'}, savedItems:[], ownerDocument:document,
    clearMediaArtwork() {}, updateAccessUI() {}, publishEntityStates() {},
    checkDryRunStorage() {}, notifySaveStatus() {},
    notice(message) {notices.push(message);},
    $(key) {
      if (!nodes.has(key)) nodes.set(key, {
        hidden:false, removeAttribute(name) {delete this[name];}, classList:{toggle() {}}
      });
      return nodes.get(key);
    }
  });
  function hass(conn, overrides={}) {
    return {user:{id:'fixture-admin', is_admin:true}, connected:true, connection:conn.value,
      states:{}, callWS:request => conn.value.callWS(request), ...overrides};
  }
  return {panel, notices, nodes, hass, error:value => context.planLoadError(value)};
}

// Only the transport is synthetic: HAWS owns command IDs, pending requests,
// subscription restoration and its actual disconnected/ready event ordering.
class Socket {
  constructor({holdSubscription = false} = {}) {
    this.OPEN=1;
    this.readyState=this.OPEN;
    this.haVersion='2026.10.2';
    this.listeners=new Map();
    this.sent=[];
    this.subscriptions=new Set();
    this.holdSubscription=holdSubscription;
  }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) {this.listeners.get(type)?.delete(callback);}
  emit(type, event) {
    for (const callback of [...(this.listeners.get(type) || [])]) callback(event);
  }
  receive(message) {this.emit('message', {data:JSON.stringify(message)});}
  send(raw) {
    assert.equal(this.readyState, this.OPEN);
    const request=JSON.parse(raw);
    this.sent.push(request);
    assert.ok(['home_floorplan/curtains', 'home_floorplan/viewer', 'unsubscribe_events'].includes(request.type),
      'reconnect must never replay a save or device command');
    if (request.type==='home_floorplan/curtains') {
      this.subscriptions.add(request.id);
      if (this.holdSubscription) return;
    } else if (request.type==='unsubscribe_events') {
      this.subscriptions.delete(request.subscription);
    }
    queueMicrotask(() => {
      if (this.readyState!==this.OPEN) return;
      this.receive({id:request.id, type:'result', success:true,
        result:request.type==='home_floorplan/viewer' ? emptyPlan(request.floor || 'upper') : null});
    });
  }
  close() {
    if (this.readyState!==this.OPEN) return;
    this.readyState=3;
    this.subscriptions.clear();
    this.emit('close');
  }
}

function hawsFixture(t, firstSocketOptions) {
  const f=fixture(), sockets=[new Socket(firstSocketOptions)];
  const client=new Connection(sockets[0], {
    setupRetry:0,
    createSocket:async () => {
      const socket=new Socket();
      sockets.push(socket);
      return socket;
    }
  });
  t.after(async () => {
    f.panel.isConnected=false;
    f.panel.disconnectedCallback();
    await flush();
    client.close();
  });
  f.panel.hass=f.hass({value:client}, {callWS:request => client.sendMessagePromise(request)});
  const reconnect=async () => {
    const ready=new Promise(resolve => {
      const listener=() => {client.removeEventListener('ready', listener); resolve();};
      client.addEventListener('ready', listener);
    });
    sockets.at(-1).close();
    await ready;
    await flush();
  };
  return {...f, client, sockets, reconnect};
}

test('real HAWS reconnect keeps one curtain subscription across three reconnects', {timeout:3000}, async t => {
  const f=hawsFixture(t);
  await flush();
  for (let cycle=0; cycle<4; cycle++) {
    const socket=f.sockets.at(-1);
    assert.equal(socket.sent.filter(request => request.type==='home_floorplan/curtains').length, 1);
    assert.equal(socket.subscriptions.size, 1, 'only one backend curtain subscription may remain active');
    assert.equal(f.client.commands.size, 1, 'only the active curtain subscription remains in HAWS');
    assert.equal(socket.sent.filter(request => request.type==='home_floorplan/viewer').length, 1);
    const [id]=socket.subscriptions;
    socket.receive({id, type:'event', event:{cycle}});
    assert.equal(f.panel.curtains.cycle, cycle);
    if (cycle<3) await f.reconnect();
  }
  assert.equal(f.sockets.length, 4);
});

test('real HAWS reconnect abandons an unacknowledged old subscription without restoring it', {timeout:3000}, async t => {
  const f=hawsFixture(t, {holdSubscription:true});
  await flush();
  assert.equal(f.sockets[0].sent.length, 1, 'viewer waits for its first subscription');
  await f.reconnect();
  const current=f.sockets.at(-1);
  assert.equal(current.sent.filter(request => request.type==='home_floorplan/curtains').length, 1);
  assert.equal(current.subscriptions.size, 1);
  assert.equal(f.client.commands.size, 1);
  assert.equal(current.sent.filter(request => request.type==='home_floorplan/viewer').length, 1);
  assert.equal(f.panel.floor, 'upper');
});

test('errors normalize HA result envelopes, numeric disconnects and unknown values safely', () => {
  const f=fixture();
  assert.match(f.error(connectionLost()), /Connection lost/);
  assert.match(f.error(3), /Connection lost/);
  assert.equal(f.error({error:{message:'Permission denied'}}), 'Permission denied');
  assert.equal(f.error(Error('Plain error')), 'Plain error');
  for (const unknown of [null, undefined, {}, {message:{}}, {error:{code:'unknown'}}, 1])
    assert.equal(f.error(unknown), 'Home Assistant could not load the plan. Try reloading the saved plan.');
  assert.equal(f.error({message:'x'.repeat(1000)}).length, 500);
});

test('ordinary HA state updates never reload a successful or rejected viewer read', async () => {
  for (const viewer of [undefined, () => Promise.reject(connectionLost())]) {
    const f=fixture(), c=connection({viewer});
    f.panel.hass=f.hass(c);
    await flush();
    for (let i=0; i<20; i++) f.panel.hass=f.hass(c);
    await flush();
    assert.equal(c.reads.length, 1);
    assert.equal(c.registrations.length, 1);
    assert.equal(f.panel.started, true);
    if (viewer) assert.match(f.notices.at(-1), /Connection lost/);
  }
});

test('same connection reconnects once even when hosts mutate one hass object', async () => {
  const f=fixture(), c=connection({eventOnly:true}), hass=f.hass(c);
  f.panel.hass=hass;
  await flush();
  hass.connected=false; f.panel.hass=hass;
  assert.equal(f.panel.started, false);
  hass.connected=true; f.panel.hass=hass;
  for (let i=0; i<5; i++) f.panel.hass=hass;
  await flush();
  assert.equal(c.reads.length, 2);
  assert.equal(c.registrations.length, 2);
  assert.equal(c.released.length, 1);
});

test('disconnect disables the visible viewer before retiring its channel', async () => {
  for (const source of ['hass', 'event', 'replacement']) {
    const f=fixture(), c=connection({eventOnly:source==='hass'}), hass=f.hass(c);
    f.panel.hass=hass;
    await flush();
    const generation=f.panel.generation, events=[], messages=[];
    f.panel.port={
      postMessage(message) {events.push('message'); messages.push(message);},
      close() {events.push('close');}
    };
    if (source==='hass') {
      hass.connected=false; f.panel.hass=hass;
    } else if (source==='event') {
      c.value.emit('disconnected');
      assert.equal(hass.connected, true, 'connection events can precede the next hass update');
    } else {
      const replacement=connection();
      replacement.value.connected=false;
      f.panel.hass=f.hass(replacement, {connected:false});
      assert.equal(replacement.reads.length, 0);
    }
    assert.deepEqual(events, ['message', 'close']);
    assert.equal(messages[0].type, 'states');
    assert.equal(messages[0].connected, false);
    assert.equal(Object.keys(messages[0].states).length, 0);
    assert.equal(f.panel.generation, generation+1, 'queued messages from the old viewer remain invalid');
    assert.equal(f.panel.port, null);
    assert.equal(f.panel.started, false);
    assert.equal(c.reads.length, 1, 'disconnect must not queue another viewer read');
  }
});

test('connection events recover without hass replacement and duplicate ready events do not reload', async () => {
  const f=fixture(), c=connection();
  f.panel.hass=f.hass(c);
  await flush();
  c.value.emit('disconnected');
  c.value.emit('ready');
  c.value.emit('ready');
  await flush();
  assert.equal(c.reads.length, 2);
  assert.equal(c.registrations.length, 2);
  assert.equal(c.released.length, 1);
});

test('an initially disconnected connection waits for readiness instead of queuing a load', async () => {
  const f=fixture(), c=connection();
  c.value.connected=false;
  f.panel.hass=f.hass(c, {connected:false});
  await flush();
  assert.equal(c.reads.length, 0);
  assert.equal(c.registrations.length, 0);
  c.value.emit('ready');
  await flush();
  assert.equal(c.reads.length, 1);
  assert.equal(c.registrations.length, 1);
});

test('mutating the connection on the same hass object invalidates the old registration', async () => {
  const f=fixture(), old=connection(), current=connection(), hass=f.hass(old);
  f.panel.hass=hass;
  await flush();
  const generation=f.panel.generation;
  hass.connection=current.value;
  hass.callWS=request => current.value.callWS(request);
  f.panel.hass=hass;
  await flush();
  assert.ok(f.panel.generation>generation);
  assert.equal(current.reads.length, 1);
  assert.equal(old.released.length, 1);
  assert.equal(old.listeners.get('ready').size, 0);
});

test('a failed read is retried only after readiness changes or explicit reload', async () => {
  let attempt=0;
  const f=fixture(), c=connection({viewer:() => ++attempt===1 ? Promise.reject(connectionLost()) : emptyPlan('recovered')});
  f.panel.hass=f.hass(c);
  await flush();
  assert.equal(attempt, 1);
  c.value.emit('disconnected'); c.value.emit('ready');
  await flush();
  assert.equal(attempt, 2);
  assert.equal(f.panel.floor, 'recovered');
  await f.panel.loadFloor();
  assert.equal(attempt, 3);
});

test('a late viewer reply from the replaced connection cannot overwrite the new plan', async () => {
  const oldResult=deferred();
  const f=fixture(), old=connection({viewer:() => oldResult.promise}), current=connection({viewer:() => emptyPlan('current')});
  f.panel.hass=f.hass(old);
  await flush();
  f.panel.hass=f.hass(current);
  await flush();
  const generation=f.panel.generation;
  oldResult.resolve(emptyPlan('obsolete'));
  await flush();
  assert.equal(f.panel.floor, 'current');
  assert.equal(f.panel.generation, generation);
  assert.equal(current.reads.length, 1);
  assert.equal(old.listeners.get('ready').size, 0);
  assert.equal(old.listeners.get('disconnected').size, 0);
  old.value.emit('disconnected'); old.value.emit('ready');
  await flush();
  assert.equal(current.reads.length, 1);
});

test('reconnect retains the latest requested floor before its reply arrives', async () => {
  const interrupted=deferred();
  let groundReads=0;
  const f=fixture(), c=connection({viewer:request => {
    const floor=request.floor || 'upper';
    if (floor==='ground' && ++groundReads===1) return interrupted.promise;
    return emptyPlan(floor);
  }});
  f.panel.hass=f.hass(c);
  await flush();
  assert.equal(f.panel.floor, 'upper');
  const pending=f.panel.loadFloor('ground');
  await flush();
  assert.equal(f.panel.floor, 'upper', 'the new floor has not returned yet');
  c.value.emit('disconnected'); c.value.emit('ready');
  await flush();
  assert.deepEqual(c.reads.map(request => request.floor || 'upper'), ['upper', 'ground', 'ground']);
  assert.equal(f.panel.floor, 'ground');
  const generation=f.panel.generation;
  interrupted.resolve(emptyPlan('obsolete'));
  await pending;
  await flush();
  assert.equal(f.panel.floor, 'ground');
  assert.equal(f.panel.generation, generation);
});

test('replacement connection retains navigation awaiting its first subscription', async () => {
  const registration=deferred();
  const f=fixture(), old=connection({subscribe:() => registration.promise}), current=connection();
  f.panel.initialFloor='upper';
  f.panel.hass=f.hass(old);
  const pending=f.panel.loadFloor('ground');
  await flush();
  assert.equal(old.reads.length, 0);
  f.panel.hass=f.hass(current);
  await flush();
  assert.deepEqual(current.reads.map(request => request.floor), ['ground']);
  registration.resolve(() => {});
  await pending;
  await flush();
  assert.equal(old.reads.length, 0);
  assert.equal(f.panel.floor, 'ground');
});

test('an unresolved old subscription neither blocks recovery nor publishes stale curtain data', async () => {
  const registration=deferred();
  let lateReleased=0;
  const f=fixture(), old=connection({subscribe:() => registration.promise}), current=connection();
  f.panel.hass=f.hass(old);
  await flush();
  assert.equal(old.reads.length, 0);
  const oldCancellation=f.panel.cancelViewerRequest;
  f.panel.hass=f.hass(current);
  await flush();
  assert.equal(current.reads.length, 1);
  assert.notEqual(f.panel.cancelViewerRequest, oldCancellation);
  current.registrations[0]({fixture:'current'});
  old.registrations[0]({fixture:'obsolete'});
  assert.equal(f.panel.curtains.fixture, 'current');
  registration.resolve(() => {lateReleased++; throw Error('Socket already closed');});
  await flush();
  assert.equal(lateReleased, 1);
  assert.equal(old.reads.length, 0);
  assert.equal(current.reads.length, 1);
});

test('a rejected curtain subscription clears its cache and explicit reload registers afresh', async () => {
  let attempt=0;
  const f=fixture(), c=connection({subscribe:() => ++attempt===1 ? Promise.reject(connectionLost()) : Promise.resolve(() => {})});
  f.panel.hass=f.hass(c);
  await flush();
  assert.equal(f.panel.curtainSubscription, null);
  assert.equal(c.reads.length, 0);
  f.panel.hass=f.hass(c);
  await flush();
  assert.equal(attempt, 1, 'state updates must not turn rejection into a retry loop');
  await f.panel.loadFloor();
  assert.equal(attempt, 2);
  assert.equal(c.reads.length, 1);
});

test('an old subscription rejection cannot clear the replacement registration or its status', async () => {
  const registration=deferred();
  const f=fixture(), old=connection({subscribe:() => registration.promise}), current=connection();
  f.panel.hass=f.hass(old);
  f.panel.hass=f.hass(current);
  await flush();
  const active=f.panel.curtainSubscription, notice=f.notices.at(-1);
  registration.reject(connectionLost());
  await flush();
  assert.equal(f.panel.curtainSubscription, active);
  assert.equal(f.notices.at(-1), notice);
  assert.equal(current.reads.length, 1);
});

test('unsaved drafts survive reconnect without reads or writes and stay available for export', async () => {
  const f=fixture(), c=connection();
  f.panel.hass=f.hass(c);
  await flush();
  f.panel.serverCanEdit=true;
  const draft={account:'fixture-admin', model:'fixture', json:'{"items":[]}'};
  f.panel.localEdits=draft;
  f.panel.failed=true;
  c.value.emit('disconnected'); c.value.emit('ready');
  await flush();
  assert.equal(f.panel.localEdits, draft);
  assert.equal(f.panel.suspendedEdits, true);
  assert.equal(f.panel.failed, true);
  assert.equal(c.reads.length, 1);
  assert.equal(f.panel.$('local-recovery').hidden, false);
  assert.equal(f.panel.canEdit, true, 'the retained draft must remain exportable');
});

test('an in-flight save is not replayed or discarded by reconnect', async () => {
  for (const successfulLateResponse of [false, true]) {
    const save=deferred();
    const f=fixture(), c=connection();
    f.panel.hass=f.hass(c);
    await flush();
    f.panel.serverCanEdit=true;
    f.panel.inventoryModel='fixture';
    f.panel.readableEntities=new Set();
    f.panel.controllableEntities=new Set();
    let saves=0;
    f.panel._hass.callWS=message => {
      assert.equal(message.type, 'home_floorplan/save');
      saves++;
      return save.promise;
    };
    f.panel.handleViewerMessage({type:'save', items:[]}, f.panel.generation);
    await flush();
    const draft=f.panel.localEdits;
    c.value.emit('disconnected'); c.value.emit('ready');
    if (successfulLateResponse) save.resolve({revision:10});
    else save.reject(connectionLost());
    await flush();
    assert.equal(saves, 1);
    assert.equal(f.panel.localEdits, draft);
    assert.equal(f.panel.suspendedEdits, true);
    assert.equal(f.panel.failed, true);
    assert.equal(f.panel.pending, 0);
    assert.equal(c.reads.length, 1);
  }
});

test('detach cancels pending work, removes listeners and safely releases a late subscription', async () => {
  const registration=deferred();
  let released=0;
  const f=fixture(), c=connection({subscribe:() => registration.promise});
  f.panel.hass=f.hass(c);
  f.panel.isConnected=false;
  f.panel.disconnectedCallback();
  assert.equal(f.panel.connectionState, null);
  assert.equal(f.panel.cancelViewerRequest, null);
  assert.equal(c.listeners.get('ready').size, 0);
  assert.equal(c.listeners.get('disconnected').size, 0);
  registration.resolve(() => {released++; return Promise.reject(Error('Already closed'));});
  await flush();
  assert.equal(released, 1);
  assert.equal(c.reads.length, 0);
  c.value.emit('ready');
  await flush();
  assert.equal(c.registrations.length, 1);
  f.panel.isConnected=true;
  f.panel.connectedCallback();
  await flush();
  assert.equal(c.registrations.length, 2);
});
