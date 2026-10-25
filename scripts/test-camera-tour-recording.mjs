import assert from 'node:assert/strict';
import { createTourRecorder, recordingSupport } from '../camera-tour-recording.js';

// All media and timing are faked: this suite never uses browser permissions,
// devices, network, animation frames, or an actual MediaRecorder.
class Target {
  listeners = new Map();
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  emit(type, data = {}) { for (const listener of [...(this.listeners.get(type) || [])]) listener({ type, ...data }); }
  get listenerCount() { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
}

class FakeClock {
  now = 0;
  nextId = 1;
  timers = new Map();
  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + delay, callback });
    return id;
  };
  clearTimeout = id => { this.timers.delete(id); };
  tick(milliseconds) {
    const end = this.now + milliseconds;
    while (true) {
      const next = [...this.timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.now = end;
  }
}

function fixture(options = {}) {
  const targets = [];
  const target = () => { const value = new Target(); targets.push(value); return value; };
  const window = target();
  const document = Object.assign(target(), { defaultView: window, hidden: false, visibilityState: 'visible' });
  const tracks = (options.kinds || ['video']).map(kind => Object.assign(target(), {
    kind, readyState: options.ended ? 'ended' : 'live', stopCalls: 0,
    stop() { this.stopCalls++; this.readyState = 'ended'; if (options.trackStopThrows) throw new Error('Track stop failed'); },
  }));
  const stream = Object.assign(target(), { getTracks: () => tracks });
  const instances = [];
  class Recorder extends Target {
    static isTypeSupported(type) {
      if (options.probeThrows?.includes(type)) throw new Error('Codec probe failed');
      return (options.supported || ['video/webm;codecs=vp9']).includes(type);
    }
    constructor(input, config) {
      super();
      if (options.constructorThrows) throw new Error('Recorder construction failed');
      this.mimeType = options.actualMime || config.mimeType;
      this.stream = input;
      this.state = 'inactive';
      this.stopCalls = 0;
      instances.push(this);
      targets.push(this);
    }
    start(timeslice) {
      this.timeslice = timeslice;
      if (options.startThrows) throw new Error('Recorder start failed');
      this.state = 'recording';
      if (!options.manualStart) queueMicrotask(() => this.emit('start'));
    }
    stop() {
      this.stopCalls++;
      if (options.stopThrows) throw new Error('Recorder stop failed');
      this.state = 'inactive';
      if (options.noStopEvent) return;
      queueMicrotask(() => {
        if (options.finalData) this.chunk(options.finalData, options.finalMime || this.mimeType);
        this.emit('stop');
      });
    }
    chunk(value, type = this.mimeType) { this.emit('dataavailable', { data: new Blob([value], { type }) }); }
  }
  window.MediaRecorder = Recorder;
  window.Blob = Blob;
  const canvas = Object.assign(target(), {
    width: 640, height: 360, ownerDocument: document, captures: 0,
    captureStream(fps) {
      this.captures++;
      this.fps = fps;
      if (options.captureThrows) throw new Error('Canvas is not origin-clean');
      return stream;
    },
  });
  const states = [];
  const errors = [];
  const create = extra => createTourRecorder({ canvas, onState: state => states.push(state), onError: error => errors.push(error), ...extra });
  const clean = (clock, acquired = true) => {
    assert.equal(clock.timers.size, 0, 'all timers must be released');
    for (const item of targets) assert.equal(item.listenerCount, 0, 'all listeners must be removed');
    if (acquired) for (const track of tracks) assert.equal(track.stopCalls, 1, 'every acquired track is stopped exactly once');
  };
  return { canvas, document, window, tracks, stream, instances, states, errors, create, clean };
}

const tests = [];
const test = (name, action) => tests.push([name, action]);
const flush = async () => { for (let index = 0; index < 5; index++) await Promise.resolve(); };

test('support probes are permission-free and select supported WebM/MP4', () => {
  const f = fixture();
  assert.deepEqual(recordingSupport(f.canvas), { supported: true, reason: '', mimeType: 'video/webm;codecs=vp9', extension: 'webm' });
  assert.equal(f.canvas.captures, 0);
  const mp4 = fixture({ supported: ['video/mp4'] });
  assert.equal(recordingSupport(mp4.canvas).extension, 'mp4');
  const fallback = fixture({ supported: ['video/webm'], probeThrows: ['video/webm;codecs=vp9'] });
  assert.equal(recordingSupport(fallback.canvas).mimeType, 'video/webm');
  assert.equal(recordingSupport(fixture({ supported: [] }).canvas).supported, false);
  assert.equal(recordingSupport(null).supported, false);
  f.canvas.width = 0;
  assert.match(recordingSupport(f.canvas).reason, /nonzero/);
  f.canvas.width = 640;
  f.window.MediaRecorder.isTypeSupported = undefined;
  assert.equal(recordingSupport(f.canvas).supported, false);
});

test('normal stop retains final bytes, releases resources, and can restart', async clock => {
  const f = fixture({ finalData: 'tail' });
  let paints = 0;
  const recorder = f.create({ render: () => {
    paints++;
    assert.equal(f.instances.at(-1).state, 'recording', 'initial paint happens while capture is active');
  } });
  assert.equal(recorder.state, 'idle');
  assert.equal(clock.timers.size, 0, 'idle recorder schedules no work');
  await recorder.start();
  assert.equal(paints, 1);
  assert.equal(f.canvas.fps, 24);
  assert.equal(f.instances[0].timeslice, 250);
  f.instances[0].chunk('head');
  const stopped = recorder.stop();
  assert.equal(recorder.stop(), stopped, 'concurrent stops share a promise');
  assert.equal(f.tracks[0].stopCalls, 1, 'tracks stop before final recorder data');
  const result = await stopped;
  assert.equal(await result.blob.text(), 'headtail');
  assert.equal(result.mimeType, 'video/webm;codecs=vp9');
  assert.equal(result.extension, 'webm');
  assert.equal(await recorder.stop(), result);
  assert.deepEqual(f.states, ['starting', 'recording', 'stopping', 'idle']);
  f.clean(clock);
  // Supply a new live track, as native canvas.captureStream does on every call.
  f.tracks[0].readyState = 'live';
  await recorder.start();
  recorder.cancel();
  assert.equal(f.tracks[0].stopCalls, 2);
  assert.equal(clock.timers.size, 0);
  await assert.rejects(recorder.stop(), /no recording/);
});

test('actual MIME determines extension without mislabeling WebM as MP4', async clock => {
  const f = fixture({ supported: ['video/mp4'], actualMime: 'video/webm;codecs=vp8' });
  const recorder = f.create();
  await recorder.start();
  f.instances[0].chunk('video');
  const result = await recorder.stop();
  assert.equal(result.extension, 'webm');
  assert.equal(result.blob.type, result.mimeType);
  f.clean(clock);
  const mp4 = fixture({ supported: ['video/mp4'] });
  const other = mp4.create();
  await other.start();
  mp4.instances[0].chunk('mp4');
  assert.equal((await other.stop()).extension, 'mp4');
  mp4.clean(clock);
});

test('start waits for the recorder event before allowing a short tour to run', async clock => {
  const f = fixture({ manualStart: true, finalData: 'video' });
  let painted = 0, started = false;
  const recorder = f.create({ render: () => { painted++; } });
  const pending = recorder.start().then(() => { started = true; });
  await flush();
  assert.equal(painted, 1, 'paint supplies an initial frame while startup is pending');
  clock.tick(1500);
  await flush();
  assert.equal(started, false, 'a short tour cannot consume its duration before encoder startup');
  assert.equal(recorder.state, 'starting');
  assert.equal(f.instances[0].stopCalls, 0);
  f.instances[0].emit('start');
  await pending;
  assert.equal(recorder.state, 'recording');
  assert.equal((await recorder.stop()).blob.size, 5);
  f.clean(clock);
});

test('recorder startup and asynchronous first paint may complete in either order', async clock => {
  for (const paintFirst of [false, true]) {
    const f = fixture({ manualStart: true, finalData: 'video' });
    let finishPaint, started = false;
    const recorder = f.create({ render: () => new Promise(resolve => { finishPaint = resolve; }) });
    const pending = recorder.start().then(() => { started = true; });
    await flush();
    if (paintFirst) finishPaint(); else f.instances[0].emit('start');
    await flush();
    assert.equal(started, false);
    assert.equal(recorder.state, 'starting');
    if (paintFirst) f.instances[0].emit('start'); else finishPaint();
    await pending;
    await recorder.stop();
    f.clean(clock);
  }
});

test('pending encoder startup is cancellable and cannot revive on a late start event', async clock => {
  for (const action of ['cancel', 'dispose']) {
    const f = fixture({ manualStart: true });
    const recorder = f.create();
    const pending = assert.rejects(recorder.start(), { name: 'AbortError' });
    await flush();
    recorder[action]();
    f.instances[0].emit('start');
    await pending;
    assert.equal(recorder.state, action === 'dispose' ? 'disposed' : 'idle');
    assert(!f.states.includes('recording'));
    f.clean(clock);
  }
});

test('missing encoder startup stays bounded by the existing duration limit', async clock => {
  const f = fixture({ manualStart: true });
  const recorder = f.create({ maxDurationMs: 5 });
  const pending = assert.rejects(recorder.start(), /video data/);
  await flush();
  clock.tick(5);
  await pending;
  f.instances[0].emit('start');
  assert.equal(recorder.state, 'idle');
  assert(!f.states.includes('recording'));
  f.clean(clock);
});

test('Stop during encoder startup releases resources without starting playback', async clock => {
  const f = fixture({ manualStart: true });
  const recorder = f.create();
  const started = assert.rejects(recorder.start(), /video data/);
  await flush();
  await assert.rejects(recorder.stop(), /video data/);
  await started;
  f.instances[0].emit('start');
  assert.equal(recorder.state, 'idle');
  assert(!f.states.includes('recording'));
  f.clean(clock);
});

test('only one start can run; cancel and dispose discard output', async clock => {
  const f = fixture();
  const recorder = f.create();
  const first = recorder.start();
  await assert.rejects(recorder.start(), /already active/);
  await first;
  f.instances[0].chunk('discard');
  recorder.cancel();
  await assert.rejects(recorder.stop(), /no recording/);
  assert.equal(f.errors.length, 0);
  recorder.dispose();
  recorder.dispose();
  assert.equal(recorder.state, 'disposed');
  await assert.rejects(recorder.start(), /disposed/);
  f.clean(clock);
});

test('cancellation or stop during asynchronous initial paint releases capture', async clock => {
  for (const action of ['cancel', 'stop', 'dispose']) {
    const f = fixture();
    let finishPaint;
    const recorder = f.create({ render: () => new Promise(resolve => { finishPaint = resolve; }) });
    const started = assert.rejects(recorder.start(), action === 'stop' ? /video data/ : { name: 'AbortError' });
    await flush();
    const result = recorder[action]();
    if (action === 'stop') await assert.rejects(result, /video data/);
    await started;
    finishPaint();
    await flush();
    assert.equal(f.canvas.captures, 1);
    assert.equal(f.errors.length, action === 'stop' ? 1 : 0);
    f.clean(clock);
  }
});

test('immediate cancellation and observer disposal cannot acquire a late stream', async clock => {
  for (const immediate of [true, false]) {
    const f = fixture();
    let recorder;
    recorder = f.create(immediate ? {} : { onState: state => { if (state === 'starting') recorder.dispose(); } });
    const started = assert.rejects(recorder.start(), { name: 'AbortError' });
    if (immediate) recorder.cancel();
    await started;
    await flush();
    assert.equal(f.canvas.captures, 0);
    f.clean(clock, false);
  }
});

test('automatic stops on visibility, pagehide, ended track, and inactive stream', async clock => {
  for (const trigger of ['hidden', 'pagehide', 'ended', 'inactive']) {
    const f = fixture();
    const recorder = f.create();
    await recorder.start();
    f.instances[0].chunk(trigger);
    if (trigger === 'hidden') { f.document.hidden = true; f.document.emit('visibilitychange'); }
    if (trigger === 'pagehide') f.window.emit('pagehide');
    if (trigger === 'ended') f.tracks[0].emit('ended');
    if (trigger === 'inactive') f.stream.emit('inactive');
    assert.equal(await (await recorder.stop()).blob.text(), trigger);
    f.clean(clock);
  }
});

test('duration caps at two minutes and supports a lower limit', async clock => {
  for (const [requested, limit] of [[999999, 120000], [20, 20]]) {
    const f = fixture();
    const recorder = f.create({ maxDurationMs: requested });
    await recorder.start();
    f.instances[0].chunk('video');
    clock.tick(limit - 1);
    assert.equal(recorder.state, 'recording');
    clock.tick(1);
    assert.equal(recorder.state, 'stopping');
    assert.equal(await (await recorder.stop()).blob.text(), 'video');
    f.clean(clock);
  }
});

test('exact byte limit stops, and overflow never returns truncated video', async clock => {
  const f = fixture();
  const recorder = f.create({ maxBytes: 4 });
  await recorder.start();
  f.instances[0].chunk('1234');
  assert.equal((await recorder.stop()).blob.size, 4);
  f.clean(clock);
  for (const finalData of [undefined, 'tail']) {
    const overflow = fixture({ finalData });
    const capture = overflow.create({ maxBytes: 4 });
    await capture.start();
    overflow.instances[0].chunk(finalData ? '1234' : '12345');
    await assert.rejects(capture.stop(), /file size limit/);
    assert.equal(overflow.errors.length, 1);
    overflow.clean(clock);
  }
  const capped = fixture();
  const capture = capped.create({ maxBytes: 999999999 });
  await capture.start();
  // Synthetic metadata checks the hard cap without allocating a 64 MiB chunk.
  capped.instances[0].emit('dataavailable', { data: { size: 64 * 1024 * 1024 + 1, type: 'video/webm' } });
  await assert.rejects(capture.stop(), /file size limit/);
  capped.clean(clock);
});

test('context loss and recorder errors discard chunks and clean every resource', async clock => {
  for (const kind of ['context', 'recorder']) {
    const f = fixture();
    const recorder = f.create();
    await recorder.start();
    f.instances[0].chunk('discard');
    if (kind === 'context') f.canvas.emit('webglcontextlost');
    else f.instances[0].emit('error', { error: new Error('Encoder failed') });
    await assert.rejects(recorder.stop(), kind === 'context' ? /context was lost/ : /Encoder failed/);
    assert.equal(f.errors.length, 1);
    f.clean(clock);
  }
});

test('startup and capture errors leave no partial active recording', async clock => {
  for (const options of [
    { constructorThrows: true }, { startThrows: true }, { actualMime: 'application/octet-stream' },
    { kinds: ['video', 'audio'] }, { kinds: ['video', 'video'], trackStopThrows: true, startThrows: true },
    { ended: true }, { kinds: [] },
  ]) {
    const f = fixture(options);
    const recorder = f.create();
    await assert.rejects(recorder.start());
    assert.equal(recorder.state, 'idle');
    assert.equal(f.errors.length, 1);
    f.clean(clock);
  }
  for (const issue of ['capture', 'render', 'zero', 'hidden']) {
    const f = fixture({ captureThrows: issue === 'capture' });
    if (issue === 'zero') f.canvas.height = 0;
    if (issue === 'hidden') f.document.hidden = true;
    const recorder = f.create({ render: issue === 'render' ? () => { throw new Error('Render failed'); } : undefined });
    await assert.rejects(recorder.start());
    f.clean(clock, issue === 'render');
  }
});

test('missing final stop event times out after releasing tracks', async clock => {
  const f = fixture({ noStopEvent: true });
  const recorder = f.create();
  await recorder.start();
  f.instances[0].chunk('video');
  const stopped = assert.rejects(recorder.stop(), /did not finish/);
  assert.equal(f.tracks[0].stopCalls, 1);
  clock.tick(3000);
  await stopped;
  f.clean(clock);
});

test('stop exceptions, empty video, and inconsistent MIME reject cleanly', async clock => {
  for (const issue of ['stop', 'empty', 'mixed']) {
    const f = fixture({ stopThrows: issue === 'stop' });
    const recorder = f.create();
    await recorder.start();
    if (issue === 'mixed') { f.instances[0].chunk('webm'); f.instances[0].chunk('mp4', 'video/mp4'); }
    await assert.rejects(recorder.stop(), issue === 'stop' ? /stop failed/ : issue === 'empty' ? /video data/ : /inconsistent/);
    f.clean(clock);
  }
});

test('observer errors cannot interrupt cleanup; disposal during stop discards output', async clock => {
  const f = fixture();
  const recorder = f.create({ onState: () => { throw new Error('Observer failed'); }, onError: () => { throw new Error('Error observer failed'); } });
  await recorder.start();
  f.instances[0].chunk('video');
  const stopped = assert.rejects(recorder.stop(), { name: 'AbortError' });
  recorder.dispose();
  await stopped;
  await flush();
  f.clean(clock);
});

test('unresolved initial render is bounded and releases capture resources', async clock => {
  const f = fixture();
  const recorder = f.create({ maxDurationMs: 5, render: () => new Promise(() => {}) });
  const started = assert.rejects(recorder.start(), /video data/);
  await flush();
  clock.tick(5);
  await started;
  assert.equal(f.canvas.captures, 1);
  f.clean(clock);
});

test('invalid limits are rejected and frame rate is capped', async clock => {
  for (const [key, value] of [['maxBytes', 0], ['maxDurationMs', Infinity], ['frameRate', -1], ['maxBytes', '4']]) {
    assert.throws(() => fixture().create({ [key]: value }), RangeError);
  }
  const f = fixture();
  const recorder = f.create({ frameRate: 1000 });
  await recorder.start();
  assert.equal(f.canvas.fps, 60);
  recorder.cancel();
  f.clean(clock);
});

for (const [name, action] of tests) {
  const clock = new FakeClock();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = clock.setTimeout;
  globalThis.clearTimeout = clock.clearTimeout;
  try {
    await action(clock);
    await flush();
    assert.equal(clock.timers.size, 0, `${name}: no timer survives the test`);
    console.log(`PASS ${name}`);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}
console.log(`Camera tour recording: ${tests.length} fake-media checks passed.`);
