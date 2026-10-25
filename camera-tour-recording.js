/**
 * Local, canvas-only tour recording. CSS/DOM overlays and audio are not included.
 * This module never requests device/screen permissions, uploads data, creates
 * object URLs, or runs an animation loop. The caller owns rendering and any URL
 * created for the returned Blob, including revoking that URL after use.
 */

const MAX_DURATION_MS = 120000;
const MAX_BYTES = 64 * 1024 * 1024;
const STOP_TIMEOUT_MS = 3000;
const MIME_TYPES = [
  // Let the encoder choose an H.264 level appropriate for the canvas size.
  'video/mp4;codecs=avc1',
  'video/mp4',
];

function extensionFor(mimeType) {
  const base = String(mimeType || '').split(';', 1)[0].trim().toLowerCase();
  return base === 'video/mp4' ? 'mp4' : '';
}

function supportedMimeTypes(Recorder) {
  return MIME_TYPES.filter(mimeType => {
    try { return Recorder.isTypeSupported(mimeType); }
    catch { return false; } // A browser may reject an individual codec probe.
  });
}

function environment(canvas) {
  const document = canvas?.ownerDocument || globalThis.document;
  const window = document?.defaultView || globalThis.window;
  return {
    document,
    window,
    Recorder: window?.MediaRecorder || globalThis.MediaRecorder,
    Blob: window?.Blob || globalThis.Blob,
  };
}

/** Capability check only: does not create a stream or request permissions. */
export function recordingSupport(canvas) {
  const unavailable = reason => ({ supported: false, reason, mimeType: '', extension: '' });
  if (!canvas || typeof canvas.captureStream !== 'function') {
    return unavailable('Canvas video recording is unavailable in this browser.');
  }
  if (!Number.isFinite(canvas.width) || !Number.isFinite(canvas.height) || canvas.width <= 0 || canvas.height <= 0) {
    return unavailable('The canvas must have a nonzero size before recording.');
  }
  const { Recorder, Blob } = environment(canvas);
  if (typeof Recorder !== 'function' || typeof Recorder.isTypeSupported !== 'function' || typeof Blob !== 'function') {
    return unavailable('MediaRecorder video recording is unavailable in this browser.');
  }
  const [mimeType] = supportedMimeTypes(Recorder);
  if (mimeType) return { supported: true, reason: '', mimeType, extension: 'mp4' };
  return unavailable('MP4 recording is unavailable in this browser. Camera tour playback is still available.');
}

function bounded(value, fallback, maximum, label) {
  const number = value === undefined ? fallback : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 1) {
    throw new RangeError(`${label} must be a positive finite number.`);
  }
  return Math.min(Math.floor(number), maximum);
}

function asError(error, message) {
  if (error instanceof Error) return error;
  return new Error(message);
}

function abortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function hidden(document) {
  return document?.hidden === true || document?.visibilityState === 'hidden';
}

/**
 * start(): Promise<void>; waits for recorder startup and the initial render;
 * rejects if a recording is already active.
 * stop(): Promise<{blob, mimeType, extension}>; repeated calls share the result.
 * cancel()/dispose(): discard output; dispose permanently prevents new starts.
 * onState receives idle/starting/recording/stopping/disposed. onError receives an
 * Error for failures, but not explicit cancellation. Callbacks cannot interrupt
 * cleanup. Automatic stops retain their result for a subsequent stop() call.
 * Limits can be lowered but never exceed two minutes or 64 MiB of retained data.
 */
export function createTourRecorder({
  canvas, render, onState, onError,
  maxDurationMs = MAX_DURATION_MS, maxBytes = MAX_BYTES, frameRate = 24,
} = {}) {
  const durationLimit = bounded(maxDurationMs, MAX_DURATION_MS, MAX_DURATION_MS, 'maxDurationMs');
  const byteLimit = bounded(maxBytes, MAX_BYTES, MAX_BYTES, 'maxBytes');
  const fps = bounded(frameRate, 24, 60, 'frameRate');
  let state = 'idle';
  let disposed = false;
  let active = null;
  let resultPromise = null;

  const notify = (callback, value) => {
    try { if (typeof callback === 'function') callback(value); } catch { /* Observer errors must not retain capture resources. */ }
  };
  const setState = value => {
    if (state === value) return;
    state = value;
    notify(onState, value);
  };
  const listen = (target, type, callback, removers) => {
    if (typeof target?.addEventListener !== 'function' || typeof target?.removeEventListener !== 'function') return;
    target.addEventListener(type, callback);
    removers.push(() => target.removeEventListener(type, callback));
  };
  const clearListeners = removers => {
    for (const remove of removers.splice(0)) {
      try { remove(); } catch { /* Continue releasing the remaining resources. */ }
    }
  };
  const releaseCapture = session => {
    clearTimeout(session.durationTimer);
    session.durationTimer = null;
    clearListeners(session.captureListeners);
    for (const track of session.tracks.splice(0)) {
      try { track.stop(); } catch { /* A failing track must not leave other tracks running. */ }
    }
    session.stream = null;
  };

  function finish(session, error = null, cancelled = false) {
    if (session.finished) return;
    session.finished = true;
    clearTimeout(session.stopTimer);
    session.stopTimer = null;
    clearListeners(session.recorderListeners);
    releaseCapture(session);
    // Stop before dropping our last recorder reference, including constructor/
    // start failures and browsers which never dispatch their final stop event.
    try {
      if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop();
    } catch { /* Capture tracks have already been released. */ }
    let result;
    if (!error && !cancelled) {
      try {
        if (!session.bytes) throw new Error('The recording did not contain any video data.');
        const extension = extensionFor(session.mimeType);
        if (!extension) throw new Error('The browser returned an unsupported video format.');
        result = { blob: new session.Blob(session.chunks, { type: session.mimeType }), mimeType: session.mimeType, extension };
        if (result.blob.size > byteLimit) throw new Error('The recording exceeded its file size limit.');
      } catch (cause) { error = asError(cause, 'The recorded video could not be created.'); }
    }
    session.chunks.length = 0;
    session.bytes = 0;
    session.recorder = null;
    if (active === session) active = null;
    if (error || cancelled) {
      const reason = error || abortError('Recording was cancelled.');
      session.rejectStart(reason);
      session.rejectResult(reason);
    } else {
      session.resolveStart();
      session.resolveResult(result);
    }
    setState(disposed ? 'disposed' : 'idle');
    if (error && !cancelled) notify(onError, error);
  }

  function requestStop(session) {
    if (session.finished || session.stopping) return;
    session.stopping = true;
    if (!session.recorder || !session.started) {
      finish(session, abortError('Recording was stopped before it started.'), true);
      return;
    }
    setState('stopping');
    if (session.finished) return; // An observer may cancel or dispose.
    session.stopTimer = setTimeout(() => finish(session, new Error('The browser did not finish the recording.')), STOP_TIMEOUT_MS);
    try {
      if (session.recorder.state !== 'inactive') session.recorder.stop();
    } catch (error) {
      finish(session, asError(error, 'The recording could not be stopped.'));
      return;
    }
    releaseCapture(session);
  }

  function start() {
    if (disposed) return Promise.reject(new Error('This recorder has been disposed.'));
    if (active) return Promise.reject(new Error('A recording is already active.'));
    resultPromise = null;
    const support = recordingSupport(canvas);
    if (!support.supported) {
      const error = new Error(support.reason);
      notify(onError, error);
      return Promise.reject(error);
    }
    const env = environment(canvas);
    if (hidden(env.document)) {
      const error = new Error('Keep this page visible to start recording.');
      notify(onError, error);
      return Promise.reject(error);
    }
    const session = {
      ...env, mimeType: support.mimeType, stream: null, recorder: null,
      chunks: [], bytes: 0, tracks: [], captureListeners: [], recorderListeners: [],
      started: false, stopping: false, finished: false, durationTimer: null, stopTimer: null,
    };
    const startPromise = new Promise((resolve, reject) => { session.resolveStart = resolve; session.rejectStart = reject; });
    resultPromise = new Promise((resolve, reject) => { session.resolveResult = resolve; session.rejectResult = reject; });
    // Automatic errors/cancellation may precede the caller asking for the result.
    resultPromise.catch(() => {});
    active = session;
    setState('starting');
    if (session.finished) return startPromise;
    Promise.resolve().then(async () => {
      try {
        if (session.finished) return;
        listen(env.document, 'visibilitychange', () => { if (hidden(env.document)) requestStop(session); }, session.captureListeners);
        listen(env.window, 'pagehide', () => requestStop(session), session.captureListeners);
        listen(canvas, 'webglcontextlost', () => finish(session, new Error('The canvas graphics context was lost.')), session.captureListeners);
        // Also bounds an asynchronous initial render which never completes.
        session.durationTimer = setTimeout(() => requestStop(session), durationLimit);
        if (hidden(env.document)) throw new Error('The page became hidden before recording started.');
        if (canvas.width <= 0 || canvas.height <= 0) throw new Error('The canvas must have a nonzero size before recording.');
        session.stream = canvas.captureStream(fps);
        session.tracks = Array.from(session.stream?.getTracks() || []);
        if (session.finished) { releaseCapture(session); return; }
        if (!session.tracks.length || !session.tracks.some(track => track.kind === 'video') || session.tracks.some(track => track.kind !== 'video' || track.readyState === 'ended')) {
          throw new Error('The canvas did not provide an active video-only stream.');
        }
        for (const track of session.tracks) listen(track, 'ended', () => requestStop(session), session.captureListeners);
        listen(session.stream, 'inactive', () => requestStop(session), session.captureListeners);
        let constructionError;
        for (const mimeType of supportedMimeTypes(env.Recorder)) {
          if (session.finished) return;
          let recorder;
          try {
            recorder = new env.Recorder(session.stream, { mimeType });
            if (!extensionFor(recorder.mimeType || mimeType)) throw new Error('The browser did not select an MP4 recording format.');
            session.recorder = recorder;
            session.mimeType = recorder.mimeType || mimeType;
            break;
          } catch (error) {
            // A successful capability probe does not guarantee construction.
            // Retry only another MP4 candidate; never fall back to WebM.
            constructionError = error;
            try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* Try the remaining candidate. */ }
          }
        }
        if (!session.recorder) throw asError(constructionError, 'The browser could not create an MP4 recorder.');
        if (session.finished) {
          try { if (session.recorder.state !== 'inactive') session.recorder.stop(); } catch { /* Capture has already been released. */ }
          session.recorder = null;
          return;
        }
        if (typeof session.recorder.addEventListener !== 'function' || typeof session.recorder.removeEventListener !== 'function') throw new Error('MediaRecorder events are unavailable in this browser.');
        let painted = false, recordingStarted = false;
        const ready = () => {
          if (!painted || !recordingStarted || session.finished || session.stopping) return;
          setState('recording');
          if (!session.finished && !session.stopping) session.resolveStart();
        };
        listen(session.recorder, 'start', () => { recordingStarted = true; ready(); }, session.recorderListeners);
        listen(session.recorder, 'dataavailable', event => {
          if (session.finished || !event.data?.size) return;
          if (!Number.isFinite(event.data.size) || event.data.size < 0 || event.data.size > byteLimit - session.bytes) {
            finish(session, new Error('The recording exceeded its file size limit.'));
            return;
          }
          if (event.data.type) {
            const extension = extensionFor(event.data.type);
            if (!extension) {
              finish(session, new Error('The browser returned a non-MP4 or inconsistent video format.'));
              return;
            }
            session.mimeType = event.data.type;
          }
          session.chunks.push(event.data);
          session.bytes += event.data.size;
          if (session.bytes === byteLimit) requestStop(session);
        }, session.recorderListeners);
        listen(session.recorder, 'error', event => finish(session, asError(event.error, 'The browser could not record this canvas.')), session.recorderListeners);
        listen(session.recorder, 'stop', () => finish(session), session.recorderListeners);
        session.started = true;
        session.recorder.start(250);
        if (session.finished) return;
        // Canvas capture observes draws, so paint after the stream and recorder
        // are active rather than relying on an earlier WebGL back buffer.
        if (typeof render === 'function') await render();
        // start() changes the native state synchronously, but the encoder can
        // start later. A short tour must not finish before that start event.
        painted = true;
        ready();
      } catch (error) { finish(session, asError(error, 'The canvas could not be recorded.')); }
    });
    return startPromise;
  }

  return {
    get state() { return state; },
    start,
    stop() {
      const promise = resultPromise;
      if (active) requestStop(active);
      return promise || Promise.reject(new Error('There is no recording to save.'));
    },
    cancel() {
      resultPromise = null;
      if (active) finish(active, null, true);
    },
    dispose() {
      disposed = true;
      resultPromise = null;
      if (active) finish(active, null, true);
      setState('disposed');
    },
  };
}
