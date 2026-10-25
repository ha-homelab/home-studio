import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Pure local integration fakes. An alternate source path lets isolated branches
// review the session before it is merged, without changing that checkout.
const sessionPath = process.env.CAMERA_TOUR_SESSION_PATH
  ? pathToFileURL(resolve(process.env.CAMERA_TOUR_SESSION_PATH))
  : new URL('../camera-tour-session.js', import.meta.url);
const dataModule = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
const source = await readFile(sessionPath, 'utf8');
const core = dataModule(await readFile(new URL('./camera-tour.js', sessionPath), 'utf8'));
const recorder = dataModule(await readFile(new URL('./camera-tour-recording.js', sessionPath), 'utf8'));
const panel = dataModule('export const createCameraTourPanel = options => globalThis.__cameraTourPanelTest(options);');
const { createCameraTourSession } = await import(dataModule(source
  .replace("'./camera-tour.js'", JSON.stringify(core))
  .replace("'./camera-tour-panel.js'", JSON.stringify(panel))
  .replace("'./camera-tour-recording.js'", JSON.stringify(recorder))));

class Target {
  listeners = new Map();
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  emit(type, data = {}) { for (const callback of [...(this.listeners.get(type) || [])]) callback({ type, ...data }); }
  get count() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(options = {}) {
  const original = new Map();
  const replace = (name, value) => { original.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); };
  const f = { time: 0, applies: 0, frames: new Map(), timers: new Map(), next: 1, instances: [], tracks: [], urls: [], revoked: [], clicks: 0, failApply: false, failCapture: options.initialCaptureFailure, panelDisposed: false };
  const window = new Target();
  const document = Object.assign(new Target(), { defaultView: window, hidden: false });
  const container = { hidden: false, children: [], append(node) { this.children.push(node); }, querySelector() { return this.children.find(node => node.className === 'camera-tour-download'); } };
  document.createElement = tag => ({ tag, attributes: {}, paused: true, loads: 0,
    click() { f.clicks++; }, remove() { container.children = container.children.filter(node => node !== this); },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; }, removeAttribute(name) { delete this.attributes[name]; },
    set src(value) { this.setAttribute('src', value); }, get src() { return this.getAttribute('src') || ''; },
    pause() { this.paused = true; }, load() { this.loads++; },
  });
  const canvas = Object.assign(new Target(), { width: 640, height: 360, ownerDocument: document, captureStream() {
    const track = Object.assign(new Target(), { kind: 'video', readyState: 'live', stopCalls: 0, stop() { this.stopCalls++; this.readyState = 'ended'; } });
    f.tracks.push(track);
    return Object.assign(new Target(), { getTracks: () => [track] });
  } });
  class Recorder extends Target {
    static isTypeSupported(type) { return type.startsWith('video/mp4'); }
    constructor(_stream, config) { super(); this.mimeType = config.mimeType; this.state = 'inactive'; f.instances.push(this); }
    start() {
      this.state = 'recording';
      f.encoderStartPose = structuredClone(f.pose);
      if (!options.deferRecorderStart) queueMicrotask(() => this.emit('start'));
      this.emit('dataavailable', { data: new Blob(['frame'], { type: this.mimeType }) });
    }
    stop() { this.state = 'inactive'; if (!options.delayStop) queueMicrotask(() => this.emit('stop')); }
  }
  window.MediaRecorder = Recorder; window.Blob = Blob;
  replace('document', document); replace('window', window);
  replace('performance', { now: () => f.time });
  replace('requestAnimationFrame', callback => { const id = f.next++; f.frames.set(id, callback); return id; });
  replace('cancelAnimationFrame', id => f.frames.delete(id));
  replace('setTimeout', callback => { const id = f.next++; f.timers.set(id, callback); return id; });
  replace('clearTimeout', id => f.timers.delete(id));
  replace('URL', {
    createObjectURL: () => { const url = `blob:test-${f.urls.length}`; f.urls.push(url); return url; },
    revokeObjectURL: url => f.revoked.push(url),
  });
  replace('__cameraTourPanelTest', args => {
    f.panel = args;
    return { setRecording: value => { f.recording = value; }, setExportAllowed: value => { f.exportAllowed = value; },
      setStatus: value => { f.status = value; }, setResult(...nodes) { container.children = nodes; },
      refresh() {}, dispose() { f.panelDisposed = true; } };
  });
  f.pose = structuredClone(options.pose || { type: 'perspective', floorId: 'floor', yaw: 0, pitch: 0.5, radius: 10, target: [0, 0, 0] });
  f.session = createCameraTourSession({ container, canvas: () => canvas, capture: () => {
    if (f.failCapture) throw new Error('Return to the house view before saving a camera view.');
    return f.pose;
  },
    captureOrbit: options.orbitPose ? () => options.orbitPose : undefined,
    render: options.deferRender ? () => new Promise(resolve => { f.finishRender = resolve; }) : undefined,
    apply(value) { f.applies++; f.applied = structuredClone(value); if (f.failApply) throw new Error('Apply failed'); f.pose = structuredClone(value); },
    onPlaying: options.onPlaying || (() => {}), canExport: options.canExport,
  });
  if (!options.defaultRoute) { f.session.tour.clear(); f.session.tour.add(); }
  f.tick = time => { f.time = time; const callbacks = [...f.frames.values()]; f.frames.clear(); for (const callback of callbacks) callback(time); };
  f.document = document; f.window = window; f.canvas = canvas; f.container = container;
  f.video = () => container.children.find(node => node.tag === 'video');
  f.restore = () => {
    f.failApply = false;
    try { f.session.dispose(); } catch { /* Assertions report cleanup failures. */ }
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
  return f;
}

const tests = [
  ['completed video stays in an inline player until the user explicitly downloads', async f => {
    await f.panel.record(); await f.panel.record();
    const video = f.video(), link = f.container.querySelector();
    assert(video); assert.equal(video.controls, true); assert.equal(video.playsInline, true);
    assert.equal(video.preload, 'metadata'); assert.equal(video.paused, true); assert(!video.autoplay);
    assert.equal(video.getAttribute('aria-label'), 'Recorded tour');
    assert.equal(video.src, f.urls[0]); assert.equal(link.href, video.src); assert.equal(f.urls.length, 1);
    assert.equal(link.textContent, 'Download MP4'); assert.equal(f.clicks, 0);
    link.click(); assert.equal(f.clicks, 1);
  }],
  ['close and mode hiding unload preview; reopening reuses its URL without autoplay', async f => {
    await f.panel.record(); await f.panel.record(); const video = f.video(), url = video.src;
    for (const hide of [() => f.session.close(), () => f.session.hide()]) {
      video.paused = false; hide();
      assert.equal(video.paused, true); assert.equal(video.getAttribute('src'), null);
      assert.equal(f.container.hidden, true); assert.equal(f.revoked.length, 0);
      f.session.show(); assert.equal(video.src, url); assert.equal(video.paused, true);
      assert.equal(f.urls.length, 1);
    }
  }],
  ['manual interruption pauses preview and hidden documents unload it until visible', async f => {
    await f.panel.record(); await f.panel.record(); const video = f.video(), url = video.src;
    video.paused = false; f.session.interrupt(); assert.equal(video.paused, true); assert.equal(video.src, url);
    video.paused = false; f.document.hidden = true; f.document.emit('visibilitychange');
    assert.equal(video.paused, true); assert.equal(video.getAttribute('src'), null);
    f.session.show(); assert.equal(video.getAttribute('src'), null, 'show cannot load media while the document is hidden');
    f.document.hidden = false; f.document.emit('visibilitychange'); assert.equal(video.src, url); assert.equal(video.paused, true);
    f.window.emit('pagehide'); assert.equal(video.getAttribute('src'), null);
    f.session.show(); assert.equal(video.getAttribute('src'), null);
    f.window.emit('pageshow'); assert.equal(video.src, url); assert.equal(video.paused, true);
  }],
  ['a result finalized after close retains its download but cannot decode while hidden', async f => {
    await f.panel.record(); f.session.close(); f.instances[0].emit('stop'); await flush();
    assert(f.video()); assert.equal(f.video().getAttribute('src'), null); assert.equal(f.urls.length, 1); assert.equal(f.clicks, 0);
    f.session.show(); assert.equal(f.video().src, f.urls[0]); assert.equal(f.video().paused, true);
  }, { delayStop: true }],
  ['permission loss unloads and removes both preview and explicit download', async f => {
    await f.panel.record(); await f.panel.record(); const video = f.video(); video.paused = false;
    f.session.setExportAllowed(false);
    assert.equal(video.paused, true); assert.equal(video.getAttribute('src'), null);
    assert.equal(f.container.children.length, 0); assert.deepEqual(f.revoked, f.urls);
  }],
  ['a failing player cannot block hiding or result teardown', async f => {
    await f.panel.record(); await f.panel.record(); const video = f.video(); video.paused = false;
    video.pause = video.load = () => { throw new Error('Player unavailable'); };
    f.session.close(); assert.equal(f.container.hidden, true); assert.equal(video.getAttribute('src'), null);
    f.session.setExportAllowed(false); assert.equal(f.container.children.length, 0); assert.deepEqual(f.revoked, f.urls);
  }],
  ['a failed new take preserves the previous inline result until successful replacement', async f => {
    await f.panel.record(); await f.panel.record(); const video = f.video(), url = video.src;
    f.failApply = true; await f.panel.record();
    assert.equal(f.video(), video); assert.equal(video.src, url); assert.equal(f.revoked.length, 0);
    f.failApply = false; await f.panel.record(); await f.panel.record();
    assert.notEqual(f.video(), video); assert.equal(video.getAttribute('src'), null); assert.deepEqual(f.revoked, [url]);
  }],
  ['an unavailable first camera leaves a usable idle panel and allows an explicit orbit retry', async f => {
    assert.match(f.status, /Return to the house view/);
    f.session.show(); assert.deepEqual(f.session.tour.getState().waypoints, []);
    assert.equal(f.applies, 0); assert.equal(f.frames.size, 0);
    f.failCapture = false; f.panel.tour.orbit();
    assert.equal(f.session.tour.getState().waypoints.length, 5);
    assert.equal(f.session.tour.getState().status, 'idle'); assert.equal(f.frames.size, 0);
  }, { defaultRoute: true, initialCaptureFailure: true }],
  ['first opening offers an idle full orbit and reopening preserves custom or empty routes', async f => {
    const tour = f.session.tour, original = tour.export();
    assert.equal(original.waypoints.length, 5); assert.equal(tour.getState().totalDuration, 20);
    f.session.show(); assert.equal(tour.getState().status, 'idle'); assert.equal(f.applies, 0); assert.equal(f.frames.size, 0);
    tour.update('orbit_1', { name: 'My view', duration: 2 }); const edited = tour.export();
    f.session.close(); f.session.show(); assert.deepEqual(tour.export(), edited);
    tour.clear(); f.session.close(); f.session.show(); assert.deepEqual(tour.getState().waypoints, []);
    tour.import(original); f.session.close(); f.session.show(); assert.deepEqual(tour.export(), original);
    assert.equal(f.applies, 0); assert.equal(f.frames.size, 0);
  }, { defaultRoute: true }],
  ['a default Home orbit centres the house only on Play and Stop restores the selected room', async f => {
    const tour = f.session.tour;
    assert.equal(f.applies, 0); assert.equal(f.frames.size, 0);
    tour.play();
    assert.equal(f.applied.room, ''); assert.deepEqual(f.applied.pan, [0, 0]); assert.equal(f.applied.zoom, 0.8);
    f.tick(1000); tour.stop();
    assert.equal(f.applied.room, 'study'); assert.deepEqual(f.applied.pan, [7, -2]); assert.equal(f.applied.zoom, 2);
    assert.equal(f.applied.rotation, 5); assert.equal(f.frames.size, 0);
  }, { defaultRoute: true, pose: { type: 'home', floorId: 'floor', rotation: 5, tilt: 0.2, zoom: 2, pan: [7, -2], room: 'study' } }],
  ['camera playback waits for actual encoder startup', async f => {
    const pending = f.panel.record();
    await flush();
    f.tick(1500);
    assert.equal(f.session.tour.getState().status, 'paused');
    assert.equal(f.session.tour.getState().elapsed, 0);
    assert.equal(f.applies, 1, 'startup prepares only the first route frame');
    assert.equal(f.frames.size, 0, 'startup must not consume the camera route');
    f.instances[0].emit('start');
    await pending;
    assert.equal(f.session.tour.getState().status, 'playing');
    f.tick(1550);
    assert(f.applies > 0);
  }, { deferRecorderStart: true }],
  ['recording begins at the route pose and Stop restores the original Home view', async f => {
    const original = structuredClone(f.pose), first = f.session.tour.getState().waypoints[0].pose;
    const pending = f.panel.record();
    await flush();
    assert.deepEqual(f.encoderStartPose, first, 'the native encoder must see the route pose on start');
    assert.equal(f.encoderStartPose.zoom, 0.8);
    assert.equal(f.session.tour.getState().elapsed, 0);
    f.instances[0].emit('start'); await pending;
    f.session.tour.stop(); await flush();
    assert.deepEqual(f.pose, original, 'play must retain the pre-seek restore snapshot');
    assert.equal(f.tracks[0].stopCalls, 1); assert.equal(f.frames.size, 0);
  }, { defaultRoute: true, deferRecorderStart: true,
    pose: { type: 'home', floorId: 'floor', rotation: 5, tilt: 0.2, zoom: 2, pan: [7, -2], room: 'study' } }],
  ['a host-fitted orbit remains idle until recording and restores a close-up afterward', async f => {
    const original = structuredClone(f.pose), first = f.session.tour.getState().waypoints[0].pose;
    assert.equal(f.applies, 0); assert.equal(f.frames.size, 0);
    assert.equal(first.radius, 45); assert.deepEqual(first.target, [10, 3, 6]);
    await f.panel.record();
    assert.deepEqual(f.encoderStartPose, first);
    f.session.tour.stop(); await flush();
    assert.deepEqual(f.pose, original); assert.equal(f.tracks[0].stopCalls, 1);
  }, { defaultRoute: true,
    pose: { type: 'perspective', floorId: 'floor', yaw: 0.2, pitch: 0.6, radius: 3, target: [2, 1, 1] },
    orbitPose: { type: 'perspective', floorId: 'floor', yaw: 0.2, pitch: 0.6, radius: 45, target: [10, 3, 6] } }],
  ['failure to prepare the first route pose never creates a capture', async f => {
    f.failApply = true;
    await f.panel.record();
    assert.equal(f.status, 'Apply failed');
    assert.equal(f.instances.length, 0); assert.equal(f.tracks.length, 0);
    assert.equal(f.recording, undefined); assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
  }],
  ['Stop while preparing the first route pose prevents capture', async f => {
    const unsubscribe = f.session.tour.subscribe(state => {
      if (state.status === 'paused') f.session.tour.stop();
    });
    await f.panel.record(); unsubscribe();
    assert.equal(f.session.tour.getState().status, 'idle');
    assert.equal(f.instances.length, 0); assert.equal(f.tracks.length, 0);
    assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
  }],
  ...['dispose', 'permission loss'].map(action => [`${action} while preparing the first route pose prevents capture`, async f => {
    const unsubscribe = f.session.tour.subscribe(state => {
      if (state.status !== 'paused') return;
      if (action === 'dispose') f.session.dispose();
      else f.session.setExportAllowed(false);
    });
    await f.panel.record(); unsubscribe();
    assert.equal(f.instances.length, 0); assert.equal(f.tracks.length, 0);
    assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0); assert.equal(f.urls.length, 0);
  }]),
  ['permission loss while awaiting the encoder cannot start late playback', async f => {
    const pending = f.panel.record();
    await flush();
    f.session.setExportAllowed(false);
    await pending;
    f.instances[0].emit('start');
    f.tick(1500);
    assert.equal(f.session.tour.getState().status, 'paused');
    assert.equal(f.applies, 1);
    assert.equal(f.frames.size, 0);
    assert.equal(f.tracks[0].stopCalls, 1);
    assert.equal(f.urls.length, 0);
  }, { deferRecorderStart: true }],
  ['denied exports retain playback without creating a capture or download', async f => {
    assert.equal(f.panel.canExport, false);
    f.session.tour.play(); f.tick(50);
    assert.equal(f.session.tour.getState().status, 'playing');
    assert(f.applies > 0);
    await f.panel.record();
    assert.equal(f.tracks.length, 0); assert.equal(f.urls.length, 0);
    f.session.tour.stop();
    f.session.setExportAllowed(true);
    await f.panel.record();
    assert.equal(f.tracks.length, 1, 'a later trusted grant enables recording');
  }, { canExport: false }],
  ['permission downgrade cancels recording while retaining camera playback', async f => {
    await f.panel.record();
    f.session.setExportAllowed(false);
    await flush();
    assert.equal(f.tracks[0].stopCalls, 1);
    assert.equal(f.recording, false); assert.equal(f.exportAllowed, false);
    assert.equal(f.urls.length, 0); assert.equal(f.timers.size, 0);
    assert.equal(f.session.tour.getState().status, 'playing');
    await f.panel.record();
    assert.equal(f.tracks.length, 1, 'a denied retry cannot open another capture');
  }],
  ['permission downgrade discards fulfilled output before its download handler', async f => {
    await f.panel.record();
    f.session.interrupt();
    queueMicrotask(() => f.session.setExportAllowed(false));
    await flush();
    assert.equal(f.urls.length, 0); assert.equal(f.tracks[0].stopCalls, 1);
  }],
  ['permission downgrade cancels pending finalization and removes saved download', async f => {
    await f.panel.record();
    const stopping = f.panel.record();
    f.session.setExportAllowed(false);
    await stopping;
    assert.equal(f.instances[0].count, 0); assert.equal(f.timers.size, 0);
    assert.equal(f.urls.length, 0);
  }, { delayStop: true }],
  ['permission downgrade revokes a completed video and disposal cannot reenable exports', async f => {
    await f.panel.record(); await f.panel.record();
    assert.equal(f.urls.length, 1);
    f.session.setExportAllowed(false);
    assert.deepEqual(f.revoked, f.urls);
    f.session.dispose(); f.session.setExportAllowed(true);
    await f.panel.record();
    assert.equal(f.tracks.length, 1); assert.equal(f.exportAllowed, false);
  }],
  ['permission downgrade during startup cannot start late playback', async f => {
    const starting = f.panel.record();
    await flush(); f.session.setExportAllowed(false);
    await starting; f.finishRender(); await flush();
    assert.equal(f.tracks[0].stopCalls, 1); assert.equal(f.urls.length, 0);
    assert.equal(f.session.tour.getState().status, 'paused'); assert.equal(f.frames.size, 0);
  }, { deferRender: true }],
  ['context-loss interruption discards capture before document event propagation', async f => {
    await f.panel.record();
    f.session.interrupt({ discard: true });
    await flush();
    assert.equal(f.tracks[0].stopCalls, 1);
    assert.equal(f.recording, false);
    assert.equal(f.urls.length, 0, 'a stopped encoder must not publish context-loss output');
    assert.equal(f.frames.size, 0);
    assert.equal(f.timers.size, 0);
  }],
  ['transport Stop also stops recording', async f => {
    await f.panel.record();
    f.session.tour.stop();
    await flush();
    assert.equal(f.tracks[0].stopCalls, 1, 'transport Stop must release the capture track');
    assert.equal(f.recording, false);
  }],
  ['context loss cancels a fulfilled capture before its download handler runs', async f => {
    await f.panel.record();
    f.session.interrupt();
    queueMicrotask(() => f.session.interrupt({ discard: true }));
    await flush();
    assert.equal(f.urls.length, 0, 'discard must survive an already-fulfilled encoder stop');
    assert.equal(f.tracks[0].stopCalls, 1);
    assert.equal(f.frames.size, 0);
    assert.equal(f.timers.size, 0);
  }],
  ['manual navigation preserves a completed capture', async f => {
    await f.panel.record();
    f.session.interrupt();
    await flush();
    assert.equal(f.urls.length, 1, 'normal interruption should still offer the video');
    assert.equal(f.tracks[0].stopCalls, 1);
    assert.equal(f.frames.size, 0);
    assert.equal(f.timers.size, 0);
  }],
  ['camera apply failure stops recording', async f => {
    await f.panel.record();
    f.failApply = true;
    f.tick(50);
    await flush();
    assert.equal(f.tracks[0].stopCalls, 1, 'failed playback must release the capture track');
    assert.equal(f.recording, false);
  }],
  ['60 Hz rendering averages 24 camera updates per second', async f => {
    f.session.tour.play(); f.applies = 0;
    for (let frame = 1; frame <= 120; frame++) f.tick(frame * 1000 / 60);
    assert(f.applies >= 47 && f.applies <= 48, `expected 47–48 updates over two seconds; received ${f.applies}`);
  }],
  ['restore error cannot skip URL or listener cleanup', async f => {
    await f.panel.record(); await f.panel.record(); await flush();
    assert.equal(f.urls.length, 1);
    f.failApply = true;
    try { f.session.dispose(); } catch { /* Cleanup is required even if restore errors propagate. */ }
    assert.deepEqual(f.revoked, f.urls, 'dispose must revoke the completed output URL');
    assert.equal(f.document.count, 0, 'dispose must remove the visibility listener');
    assert.equal(f.window.count, 0, 'dispose must remove the pagehide listener');
    assert.equal(f.panelDisposed, true);
  }],
  ['dispose cancels an already finishing recorder immediately', async f => {
    await f.panel.record();
    const stopping = f.panel.record();
    f.session.dispose();
    await stopping;
    assert.equal(f.instances[0].count, 0, 'disposed recorder must release all media listeners');
    assert.equal(f.timers.size, 0, 'disposed recorder must release its final-stop timeout');
    assert.equal(f.urls.length, 0);
  }, { delayStop: true }],
  ['throwing onPlaying callback cannot prevent completion cleanup', async f => {
    await f.panel.record();
    f.tick(3100);
    await flush();
    assert.equal(f.tracks[0].stopCalls, 1, 'completion cleanup must survive observer failure');
  }, { onPlaying() { throw new Error('Observer failed'); } }],
  ['automatic media stop clears recording even when pausing fails', async f => {
    await f.panel.record();
    f.failApply = true;
    f.instances[0].stop();
    await flush();
    assert.equal(f.recording, false, 'failed pause must not leave the recording UI active');
    assert.equal(f.urls.length, 1, 'completed video must still be made available');
  }],
  ['Stop during initial rendering cannot start late playback', async f => {
    const starting = f.panel.record();
    await flush();
    f.session.tour.stop();
    await starting;
    f.finishRender();
    await flush();
    assert.equal(f.tracks[0].stopCalls, 1);
    assert.equal(f.recording, false);
    assert.equal(f.session.tour.getState().status, 'idle');
    assert.equal(f.frames.size, 0);
  }, { deferRender: true }],
  ['dispose during initial rendering cannot start late playback', async f => {
    const starting = f.panel.record();
    await flush();
    f.session.dispose();
    await starting;
    f.finishRender();
    await flush();
    assert.equal(f.tracks[0].stopCalls, 1);
    assert.equal(f.recording, false);
    assert.equal(f.frames.size, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.urls.length, 0);
  }, { deferRender: true }],
  ['replacement downloads revoke old URLs and disposal revokes the last one', async f => {
    await f.panel.record(); await f.panel.record();
    assert.equal(f.urls.length, 1);
    await f.panel.record(); await f.panel.record();
    assert.equal(f.urls.length, 2);
    assert.deepEqual(f.revoked, [f.urls[0]]);
    f.session.dispose();
    assert.deepEqual(f.revoked, f.urls);
    assert.equal(f.frames.size, 0);
    assert.equal(f.timers.size, 0);
  }],
];

let failures = 0;
for (const [name, run, options] of tests) {
  const f = fixture(options);
  try {
    // A pending stop is itself a failure: pump only the microtask queue rather
    // than allowing an unresolved fake-media promise to end this test process.
    let done = false, failure;
    run(f).then(() => { done = true; }, error => { failure = error; done = true; });
    for (let turn = 0; turn < 6 && !done; turn++) await flush();
    if (!done) throw new Error('The session left the operation pending after disposal.');
    if (failure) throw failure;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++; console.error(`FAIL ${name}: ${error.message}`);
  } finally {
    f.restore(); await flush();
  }
}
if (failures) process.exitCode = 1;
else console.log(`Camera tour session: ${tests.length} local integration checks passed.`);
