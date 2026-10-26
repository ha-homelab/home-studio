import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { createNativeMapTransport, mapReadResult, validMapRequest } from '../planner/ha-bridge.js';
import { createSiteMapUnderlay, siteMapMath } from '../planner/site-map-underlay.js';
const root = new URL('../', import.meta.url);
const host = await import('data:text/javascript;base64,' + fs.readFileSync(new URL('custom_components/home_floorplan/static/map-transport.js', root)).toString('base64'));
const plain = value => JSON.parse(JSON.stringify(value)), tick = () => new Promise(setImmediate);
const flush = async () => { for (let i = 0; i < 12; i++) await tick(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const config = { enabled: true, latitude: 0, longitude: 0, model_x: 3, model_z: -2, north_deg: 27 };
const snapshot = () => ({ revision: 1, configured: true, config: { ...config }, reference: { latitude: 0, longitude: 0 } });
const tile = () => ({ data_url: 'data:image/png;base64,AQID' });
const view = offset => ({ width: 800, height: 600, toWorld: ([x, y]) => [x - 400 + offset, y - 300] });

test('map validation matches the native viewer and strips unrelated private metadata', () => {
  const source = fs.readFileSync(new URL('custom_components/home_floorplan/static/panel.js', root), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('const mapBridgeLimits'), source.indexOf('class HomeFloorplanPanel')) + '\nthis.parse={mapConfig,mapSnapshot,mapTileResult};', context);
  const cases = [null, {}, config, { ...config, token: 'PRIVATE' }, ...Object.entries({ latitude: 86, longitude: 181, north_deg: -1, model_x: Infinity, enabled: 1 }).map(([key, value]) => ({ ...config, [key]: value }))];
  for (const value of cases) assert.deepEqual(host.mapConfig(value), plain(context.parse.mapConfig(value)));
  for (const value of [null, {}, snapshot(), { ...snapshot(), configured: false, config: null }, { ...snapshot(), revision: -1 }, { ...snapshot(), reference: {} }]) {
    const expected = plain(context.parse.mapSnapshot(value)); if (expected) delete expected.reference;
    assert.deepEqual(host.mapSnapshot(value), expected);
  }
  for (const value of [null, tile(), { data_url: 'https://private.invalid/tile?token=PRIVATE' }, { data_url: 'data:image/svg+xml;base64,AQID' }, { data_url: 'data:image/png;base64,AQID=' }, { data_url: 'data:image/png;base64,' + 'A'.repeat(699052) }, { ...tile(), url: 'PRIVATE' }]) {
    const expected = plain(context.parse.mapTileResult(value));
    assert.deepEqual(host.mapTileResult(value), expected); assert.deepEqual(mapReadResult('tile', value), expected);
  }
  assert.deepEqual(mapReadResult('get', { ...snapshot(), token: 'PRIVATE' }), host.mapSnapshot(snapshot()));
  assert.equal(validMapRequest('get', { url: 'https://private.invalid' }), false);
  for (const action of ['save', 'clear', 'delete', 'fetch']) assert.equal(validMapRequest(action), false);
  for (const body of [{ z: 20, x: 0, y: 0 }, { z: 0, x: 1, y: 0 }, { z: 1, x: 0, y: -1 }, { z: 1, x: 0, y: 0, url: 'PRIVATE' }]) assert.equal(validMapRequest('tile', body), false);
});

function hostFixture(callWS = async request => request.type.endsWith('map_get') ? snapshot() : tile()) {
  const calls = [], messages = [], state = { ready: true, connected: true, frame: {}, channel: 'a'.repeat(32), generation: 1, connectionEpoch: 0,
    hass: { user: { id: 'synthetic-account' }, connection: { connected: true }, auth: { accessToken: 'PRIVATE' }, callWS(request) { calls.push(request); return callWS(request); } } };
  const transport = host.createStudioMapTransport({ getContext: () => state, send: (type, payload) => messages.push({ type, ...payload }) });
  let id = 0; const send = (action, body) => { const requestId = `map-${++id}`; transport.handle({ type: 'map-request', requestId, action, ...(body === undefined ? {} : { body }) }); return requestId; };
  return { calls, messages, state, transport, send };
}
test('host allows only bounded read requests, excludes tokens, and rejects replays', async () => {
  const f = hostFixture(async request => request.type.endsWith('map_get') ? { ...snapshot(), token: 'PRIVATE', config: { ...config, endpoint: 'PRIVATE' } } : { ...tile(), token: 'PRIVATE' });
  f.send('get'); f.send('tile', { z: 1, x: 0, y: 1 });
  f.send('save', { revision: 1, config }); f.send('get', { url: 'PRIVATE' }); f.send('tile', { z: 1, x: 0, y: 1, token: 'PRIVATE' });
  f.transport.handle({ type: 'map-request', requestId: 'map-2', action: 'get' });
  await flush(); assert.deepEqual(f.calls, [{ type: 'home_floorplan/map_get' }, { type: 'home_floorplan/map_tile', z: 1, x: 0, y: 1 }]);
  assert.doesNotMatch(JSON.stringify(f.messages), /PRIVATE|reference|endpoint/);
  assert.equal(f.messages.filter(message => message.error).length, 3); f.transport.dispose();
});
test('host preserves concurrency slots through abort and session replacement', async () => {
  const held = []; let running = 0, peak = 0;
  const f = hostFixture(() => { const d = deferred(); held.push(d); peak = Math.max(peak, ++running); return d.promise.finally(() => running--); });
  for (let i = 0; i < 70; i++) f.send('tile', { z: 1, x: 0, y: 0 }); await flush();
  assert.equal(f.calls.length, 4); assert.equal(f.messages.filter(message => message.error?.code === 'busy').length, 2);
  f.transport.handle({ type: 'map-abort', requestId: 'map-1' });
  f.transport.reset(); f.state.generation++;
  for (let i = 0; i < 4; i++) f.send('tile', { z: 1, x: 0, y: 1 }); await flush(); assert.equal(f.calls.length, 4);
  held.splice(0).forEach(d => d.resolve(tile())); await flush(); assert.equal(f.calls.length, 8); assert.equal(peak, 4);
  assert.equal(f.messages.filter(message => message.result).length, 0, 'Old frame responses never cross sessions');
  held.splice(0).forEach(d => d.resolve(tile())); await flush(); assert.equal(f.messages.filter(message => message.result).length, 4); f.transport.dispose();
});
test('host rejects responses after account, connection, permission, or frame changes', async () => {
  for (const change of [f => f.state.hass.user.id = 'other-account', f => f.state.hass.connection = {}, f => f.state.connectionEpoch++, f => f.state.frame = {}, f => f.state.connected = false, f => f.state.ready = false]) {
    const d = deferred(), f = hostFixture(() => d.promise); f.send('get'); await tick(); change(f); d.resolve(snapshot()); await flush(); assert.equal(f.messages.length, 0); f.transport.dispose();
  }
  const f = hostFixture(async () => { throw { code: 'PRIVATE', message: 'PRIVATE URL and token' }; }); f.send('get'); await flush();
  assert.deepEqual(f.messages[0].error, { code: 'unavailable' }); f.transport.dispose();
});

function childFixture() {
  const messages = [], listeners = new Map(), context = { channel: 'b'.repeat(32), origin: 'https://ha.example' };
  const win = { parent: { postMessage: (data, origin) => messages.push({ data, origin }) },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); } };
  const transport = createNativeMapTransport(context, win);
  const receive = (data, extra = {}) => { for (const fn of listeners.get('message')) fn({ source: win.parent, origin: context.origin, data: { protocol: 'home-studio-editor-v1', channel: context.channel, type: 'map-response', ...data }, ...extra }); };
  return { transport, messages, win, context, receive, listeners };
}
test('child checks exact parent, origin and channel; bounds and aborts its RPCs', async () => {
  const f = childFixture(), result = f.transport.request('get'); let settled = false; result.then(() => settled = true);
  for (const extra of [{ origin: 'https://other.example' }, { source: {} }]) f.receive({ requestId: 'map-1', result: snapshot() }, extra);
  f.receive({ requestId: 'map-1', channel: 'c'.repeat(32), result: snapshot() }); await tick(); assert.equal(settled, false);
  f.receive({ requestId: 'map-1', result: { ...snapshot(), token: 'PRIVATE' } }); assert.deepEqual(await result, host.mapSnapshot(snapshot()));
  await assert.rejects(f.transport.request('save', { config }));
  const pending = Array.from({ length: 4 }, () => f.transport.request('tile', { z: 1, x: 0, y: 0 }).catch(error => error));
  await assert.rejects(f.transport.request('tile', { z: 1, x: 0, y: 0 }));
  f.transport.close(); assert((await Promise.all(pending)).every(error => error.name === 'AbortError'));
  const controller = new AbortController(), aborted = f.transport.request('get', undefined, controller.signal); controller.abort(); await assert.rejects(aborted, { name: 'AbortError' });
  assert(f.messages.some(message => message.data.type === 'map-abort')); assert(f.messages.every(message => message.origin === f.context.origin));
  f.transport.dispose(); assert.equal(f.listeners.get('message').size, 0); assert.equal(f.listeners.get('pagehide').size, 0);
});

test('underlay uses the exact home map projection, rotation and tile selection', () => {
  const context = vm.createContext({}); vm.runInContext(fs.readFileSync(new URL('map-layer.js', root), 'utf8') + '\nthis.math=homeMapMath;', context);
  for (const latitude of [-85, 0, 85]) for (const longitude of [-180, 0, 180]) for (const north_deg of [0, 27, 90, 180, 270, 360]) {
    const placement = { ...config, latitude, longitude, north_deg }, expected = context.math.transform(placement), actual = siteMapMath.transform(placement);
    for (const point of [[0, 0], [.3, .6], [1, 1]]) assert.deepEqual(actual.toWorld(...point), plain(expected.toWorld(...point)));
    for (const span of [10, 1000, 100000]) {
      const bounds = [[-span, -span], [-span, span], [span, span], [span, -span]];
      assert.deepEqual(siteMapMath.tiles(placement, bounds, 800), plain(context.math.tiles(placement, bounds, 800)));
    }
  }
});
function underlayFixture(custom = {}) {
  const calls = [], images = [], statuses = [], contexts = []; let paints = 0, clock = 0;
  const layer = createSiteMapUnderlay({ request: async (action, body, signal) => { calls.push({ action, body }); return custom.request ? custom.request(action, body, signal) : action === 'get' ? host.mapSnapshot(snapshot()) : tile(); },
    decode: custom.decode || (async () => { const image = { width: 256, height: 256, closed: 0, close() { this.closed++; } }; images.push(image); return image; }),
    onContext: value => contexts.push(value), now: () => clock, onChange: () => paints++, onStatus: (text, state) => statuses.push(state) });
  return { layer, calls, images, statuses, contexts, paints: () => paints, advance: () => clock += 60001 };
}
test('underlay has bounded cache/rate, read-only requests, exact canvas transform and no idle work', async () => {
  const f = underlayFixture(); f.layer.setView(view(0)); await flush(); assert.equal(f.calls.length, 0, 'Disabled underlay performs no reads');
  f.layer.setEnabled(true); await flush(); assert(f.layer.stats.loaded > 0); assert(f.layer.stats.visible <= 36);
  const transforms = [], painted = [], ctx = { globalAlpha: 1, save() {}, restore() {}, transform(...args) { transforms.push(args); }, drawImage(...args) { painted.push(args); } };
  const worldToCanvas = ([x, z]) => [x + 400, z + 300]; f.layer.draw(ctx, { worldToCanvas }); assert.equal(painted.length, f.layer.stats.loaded);
  const first = siteMapMath.tiles(config, [[-400, 300], [-400, -300], [400, -300], [400, 300]], 800)[0], n = 2 ** first.z, math = siteMapMath.transform(config);
  const [a, b, c] = [[first.worldX / n, first.y / n], [(first.worldX + 1) / n, first.y / n], [first.worldX / n, (first.y + 1) / n]].map(point => worldToCanvas(math.toWorld(...point)));
  assert.deepEqual(transforms[0], [(b[0] - a[0]) / 256, (b[1] - a[1]) / 256, (c[0] - a[0]) / 256, (c[1] - a[1]) / 256, a[0], a[1]]);
  const idle = { calls: f.calls.length, paints: f.paints() }; for (let i = 0; i < 40; i++) { f.layer.setView(view(0)); f.layer.draw(ctx, { worldToCanvas }); } await flush();
  assert.deepEqual({ calls: f.calls.length, paints: f.paints() }, idle);
  for (let i = 1; i < 60; i++) { f.layer.setView(view(i * 5000)); await flush(); assert(f.layer.stats.cached <= 48); assert(f.layer.stats.inflight <= 4); }
  assert.equal(f.calls.filter(call => call.action === 'tile').length, 120); assert.match(f.layer.state.status, /limit/);
  assert(f.calls.every(call => ['get', 'tile'].includes(call.action))); assert.doesNotMatch(JSON.stringify(f.layer.state), /latitude|longitude|model_x|reference/);
  f.advance(); await f.layer.reload(); await flush(); assert(f.calls.filter(call => call.action === 'tile').length > 120);
  f.layer.dispose(); assert(f.images.every(image => image.closed === 1)); assert.equal(f.layer.stats.cached, 0);
});
test('underlay retries only failed tiles and discards stale settings and decodes', async () => {
  let failed = false;
  const f = underlayFixture({ request: async action => { if (action === 'get') return snapshot(); if (!failed) { failed = true; throw Error('offline'); } return tile(); } });
  f.layer.setView(view(0)); f.layer.setEnabled(true); await flush(); assert.equal(f.layer.state.failed, true);
  const before = f.calls.length; for (let i = 0; i < 20; i++) f.layer.setView(view(0)); await flush(); assert.equal(f.calls.length, before);
  await f.layer.reload(); await flush(); assert.equal(f.calls.length - before, 2, 'Reload reads settings and retries only the failed tile'); assert.equal(f.layer.state.failed, false); f.layer.dispose();
  const settings = deferred(), stale = underlayFixture({ request: () => settings.promise }); stale.layer.setEnabled(true); stale.layer.setEnabled(false); settings.resolve(snapshot()); await flush();
  assert.equal(stale.calls.length, 1); assert.equal(stale.layer.stats.cached, 0); assert.equal(stale.layer.state.configured, false); stale.layer.dispose();
  const held = [], late = underlayFixture({ decode: () => { const d = deferred(); held.push(d); return d.promise; } });
  late.layer.setView(view(0)); late.layer.setEnabled(true); await flush(); assert.equal(held.length, 4); late.layer.dispose();
  const images = held.map(() => ({ closed: 0, close() { this.closed++; } })); held.forEach((d, i) => d.resolve(images[i])); const paints = late.paints(); await flush();
  assert(images.every(image => image.closed === 1)); assert.equal(late.paints(), paints); assert.equal(late.layer.stats.inflight, 0);
});
test('initial map context can be learned without enabling or fetching the raster', async () => {
  const f = underlayFixture();
  f.layer.setView(view(0)); await f.layer.readContext(); await flush();
  assert.deepEqual(f.contexts, [true]); assert.equal(f.layer.state.enabled, false);
  assert.deepEqual(f.calls.map(call => call.action), ['get']);
  assert.equal(f.layer.stats.inflight, 0); assert.equal(f.layer.stats.cached, 0);
  f.layer.dispose();
  const pending = deferred(), stale = underlayFixture({ request: () => pending.promise });
  const read = stale.layer.readContext(); stale.layer.dispose(); pending.resolve(snapshot()); await read;
  assert.deepEqual(stale.contexts, [], 'Detached context probes cannot affect the replacement preview');
});
test('map authority survives hidden/disabled raster and errors, but ignores stale settings', async () => {
  let result = snapshot(), fail = false;
  const f = underlayFixture({ request: async action => {
    if (action !== 'get') return tile();
    if (fail) throw Error('temporary settings failure');
    return result;
  } });
  f.layer.setEnabled(true); await flush(); assert.deepEqual(f.contexts, [true]);
  f.layer.setEnabled(false); assert.deepEqual(f.contexts, [true], 'Hiding the raster cannot erase learned authority');
  result = { ...snapshot(), config: { ...config, enabled: false } };
  f.layer.setEnabled(true); await flush(); assert.deepEqual(f.contexts, [true, true]);
  assert.equal(f.layer.state.configured, false, 'A saved disabled map does not request raster tiles');
  fail = true; await f.layer.reload(); assert.deepEqual(f.contexts, [true, true]);
  fail = false; result = { ...snapshot(), configured: false, config: null };
  await f.layer.reload(); assert.deepEqual(f.contexts, [true, true, false], 'Only an accepted unconfigured response clears map authority');
  f.layer.dispose();
  for (const dispose of [false, true]) {
    const pending = deferred(), stale = underlayFixture({ request: () => pending.promise });
    stale.layer.setEnabled(true); if (dispose) stale.layer.dispose(); else stale.layer.setEnabled(false);
    pending.resolve(snapshot()); await flush(); assert.deepEqual(stale.contexts, []);
    stale.layer.dispose();
  }
});
test('image decoding rejects invalid signatures and oversized dimensions before allocation', async () => {
  const previous = globalThis.createImageBitmap; let decodes = 0;
  globalThis.createImageBitmap = async (source, options) => {
    assert(source instanceof Blob); assert.equal(source.type, 'image/png');
    assert.equal(options, undefined); decodes++; throw Error('Not a real PNG');
  };
  try {
    const header = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
    header.writeUInt32BE(13, 8); header.write('IHDR', 12); header.writeUInt32BE(65536, 16); header.writeUInt32BE(256, 20);
    for (const data_url of [tile().data_url, 'data:image/png;base64,' + header.toString('base64')]) {
      const layer = createSiteMapUnderlay({ request: async action => action === 'get' ? snapshot() : { data_url } });
      layer.setView(view(0)); layer.setEnabled(true); await flush(); assert.equal(layer.state.failed, true); assert.equal(layer.stats.loaded, 0); layer.dispose();
    }
    assert.equal(decodes, 0);
    header.writeUInt32BE(256, 16);
    const layer = createSiteMapUnderlay({ request: async action => action === 'get' ? snapshot() : { data_url: 'data:image/png;base64,' + header.toString('base64') } });
    layer.setView(view(0)); layer.setEnabled(true); await flush();
    assert(decodes > 0, 'A valid bounded header reaches the Blob decoder');
    assert.equal(layer.state.failed, true); assert.equal(layer.stats.loaded, 0); layer.dispose();
  } finally { if (previous) globalThis.createImageBitmap = previous; else delete globalThis.createImageBitmap; }
});
