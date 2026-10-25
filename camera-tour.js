// Camera-only routes. Angles are radians; durations and elapsed time are seconds.
// A waypoint's duration leads to the next view. The last duration holds that view.
export const CAMERA_TOUR_LIMITS = Object.freeze({ waypoints: 32, seconds: 120, text: 80, bytes: 100_000, minDuration: 0.25 });
const TAU = Math.PI * 2;
const copy = value => JSON.parse(JSON.stringify(value));

function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be an object.`);
  if (Object.keys(value).some(key => !keys.includes(key))) throw new TypeError(`${label} contains an unsupported field.`);
}
function text(value, label, empty = false) {
  if (typeof value !== 'string' || value.length > CAMERA_TOUR_LIMITS.text || /[\u0000-\u001f\u007f]/.test(value) || (!empty && !value.trim())) {
    throw new TypeError(`${label} must be ${empty ? 'at most' : '1 to'} 80 characters.`);
  }
  return value;
}
function number(value, label, positive = false) {
  if (!Number.isFinite(value) || Math.abs(value) > 1e9 || (positive && value <= 0)) {
    throw new TypeError(`${label} must be a ${positive ? 'positive ' : ''}finite number within camera bounds.`);
  }
  return value;
}
function vector(value, length, label) {
  if (!Array.isArray(value) || value.length !== length) throw new TypeError(`${label} needs ${length} coordinates.`);
  return Array.from(value, coordinate => number(coordinate, label));
}
function pose(value) {
  if (value?.type === 'perspective') {
    object(value, ['type', 'floorId', 'yaw', 'pitch', 'radius', 'target'], 'Camera pose');
    return { type: 'perspective', floorId: text(value.floorId, 'Floor ID'), yaw: number(value.yaw, 'Yaw'),
      pitch: number(value.pitch, 'Pitch'), radius: number(value.radius, 'Radius', true), target: vector(value.target, 3, 'Target') };
  }
  if (value?.type === 'home') {
    object(value, ['type', 'floorId', 'rotation', 'tilt', 'zoom', 'pan', 'room'], 'Camera pose');
    return { type: 'home', floorId: text(value.floorId, 'Floor ID'), rotation: number(value.rotation, 'Rotation'),
      tilt: number(value.tilt, 'Tilt'), zoom: number(value.zoom, 'Zoom', true), pan: vector(value.pan, 2, 'Pan'), room: text(value.room, 'Room', true) };
  }
  throw new TypeError('Camera pose must use the perspective or home view.');
}

/** Validate and return an independent, camera-only schema 1 document. Throws on invalid input. */
export function validateTour(value) {
  if (typeof value === 'string') {
    if (value.length > CAMERA_TOUR_LIMITS.bytes) throw new TypeError('Tour file is too large.');
    try { value = JSON.parse(value); } catch { throw new TypeError('Tour file must contain valid JSON.'); }
  }
  object(value, ['schema', 'waypoints'], 'Tour');
  if (value.schema !== 1) throw new TypeError('Unsupported tour schema. Expected schema 1.');
  if (!Array.isArray(value.waypoints) || value.waypoints.length > CAMERA_TOUR_LIMITS.waypoints) throw new TypeError('A tour can contain up to 32 views.');
  const ids = new Set(); let total = 0;
  const waypoints = Array.from(value.waypoints, waypoint => {
    object(waypoint, ['id', 'name', 'duration', 'pose'], 'View');
    const id = text(waypoint.id, 'View ID');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || ids.has(id)) throw new TypeError('Every view needs a unique, simple ID.');
    ids.add(id);
    const duration = number(waypoint.duration, 'Duration', true);
    if (duration < CAMERA_TOUR_LIMITS.minDuration || duration > CAMERA_TOUR_LIMITS.seconds) throw new TypeError('Each duration must be between 0.25 and 120 seconds.');
    total += duration;
    return { id, name: text(waypoint.name, 'View name').trim(), duration, pose: pose(waypoint.pose) };
  });
  if (total > CAMERA_TOUR_LIMITS.seconds) throw new TypeError('A tour can last up to 120 seconds.');
  return { schema: 1, waypoints };
}

const compatible = (a, b) => a.type === b.type && a.floorId === b.floorId && (a.type !== 'home' || a.room === b.room);
const lerp = (a, b, t) => a + (b - a) * t;
const angle = (a, b, t) => a + (((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI) * t;
function interpolate(a, b, t) {
  if (t >= 1) return copy(b);
  if (t <= 0 || !compatible(a, b)) return copy(a);
  if (a.type === 'perspective') return { type: a.type, floorId: a.floorId, yaw: angle(a.yaw, b.yaw, t),
    pitch: lerp(a.pitch, b.pitch, t), radius: lerp(a.radius, b.radius, t), target: a.target.map((v, i) => lerp(v, b.target[i], t)) };
  return { type: a.type, floorId: a.floorId, room: a.room, rotation: angle(a.rotation, b.rotation, t),
    tilt: lerp(a.tilt, b.tilt, t), zoom: lerp(a.zoom, b.zoom, t), pan: a.pan.map((v, i) => lerp(v, b.pan[i], t)) };
}

/** Linear position/scale interpolation and shortest-angle rotation. Incompatible views cut at t=1. */
export function interpolatePose(from, to, progress) {
  if (!Number.isFinite(progress)) throw new TypeError('Interpolation progress must be finite.');
  return interpolate(pose(from), pose(to), Math.max(0, Math.min(1, progress)));
}

/** Adapters capture/apply synchronous poses. No frame is requested while idle, paused, or complete. */
export function createCameraTour({ capture, apply, onChange, requestFrame = callback => globalThis.requestAnimationFrame(callback),
  cancelFrame = id => globalThis.cancelAnimationFrame(id), now = () => globalThis.performance.now() } = {}) {
  if (typeof capture !== 'function' || typeof apply !== 'function') throw new TypeError('Camera capture and apply adapters are required.');
  let document = { schema: 1, waypoints: [] }, status = 'idle', elapsed = 0, index = 0, original = null;
  let frame = null, generation = 0, startedAt = 0, disposed = false, error = '';
  const listeners = new Set();
  if (typeof onChange === 'function') listeners.add(onChange);
  const duration = () => document.waypoints.reduce((sum, view) => sum + view.duration, 0);
  const getState = () => ({ status, waypoints: copy(document.waypoints), elapsed, totalDuration: duration(), index, error });
  const ensureLive = () => { if (disposed) throw new Error('This camera tour has been disposed.'); };
  const notify = () => {
    for (const listener of [...listeners]) {
      // A failed UI observer must not interrupt the camera's lifecycle.
      try { listener(getState()); } catch { /* Observers own their error reporting. */ }
    }
  };
  const cancel = () => { generation++; if (frame !== null) cancelFrame(frame); frame = null; };
  const snapshot = () => { if (original === null) original = pose(capture()); };
  function sample() {
    let remaining = elapsed;
    for (let i = 0; i < document.waypoints.length; i++) {
      const view = document.waypoints[i], next = document.waypoints[i + 1];
      if (remaining < view.duration || !next) {
        index = i;
        const t = Math.min(1, remaining / view.duration), eased = t * t * (3 - 2 * t);
        apply(next ? interpolate(view.pose, next.pose, eased) : copy(view.pose));
        return;
      }
      remaining -= view.duration;
    }
  }
  function advance() {
    const current = now();
    if (!Number.isFinite(current)) throw new Error('Camera tour clock must be finite.');
    elapsed = Math.min(duration(), Math.max(elapsed, (current - startedAt) / 1000));
    sample();
    if (elapsed >= duration()) { status = 'completed'; cancel(); }
  }
  function schedule() {
    if (status !== 'playing' || frame !== null || disposed) return;
    const token = generation;
    frame = requestFrame(() => {
      if (token !== generation || status !== 'playing' || disposed) return;
      frame = null;
      try { advance(); } catch (failure) { cancel(); status = 'paused'; error = failure.message || 'Could not apply this camera view.'; }
      notify();
      schedule();
    });
  }
  function stop({ restore = true } = {}) {
    ensureLive(); cancel();
    const saved = original; original = null; status = 'idle'; elapsed = 0; index = 0; error = '';
    try { if (restore && saved) apply(copy(saved)); }
    catch (failure) { error = failure.message || 'Could not restore the camera.'; throw failure; }
    finally { notify(); }
    return getState();
  }
  function replace(next) {
    const validated = validateTour(next); // A rejected edit leaves playback and the current route intact.
    stop(); document = validated; notify(); return getState();
  }
  function find(id) {
    const found = document.waypoints.findIndex(view => view.id === id);
    if (found < 0) throw new Error('This saved view no longer exists.');
    return found;
  }
  const api = {
    getState,
    subscribe(listener) {
      ensureLive(); if (typeof listener !== 'function') throw new TypeError('A tour listener must be a function.');
      listeners.add(listener); return () => listeners.delete(listener);
    },
    add(name = `View ${document.waypoints.length + 1}`) {
      ensureLive();
      let suffix = 1; while (document.waypoints.some(view => view.id === `view_${suffix}`)) suffix++;
      const view = { id: `view_${suffix}`, name, duration: 3, pose: pose(capture()) };
      replace({ schema: 1, waypoints: [...document.waypoints, view] }); return copy(view);
    },
    remove(id) {
      ensureLive(); const next = copy(document); next.waypoints.splice(find(id), 1); return replace(next);
    },
    move(id, delta) {
      ensureLive(); if (!Number.isInteger(delta)) throw new TypeError('Move distance must be an integer.');
      const from = find(id), to = Math.max(0, Math.min(document.waypoints.length - 1, from + delta));
      const next = copy(document), [view] = next.waypoints.splice(from, 1); next.waypoints.splice(to, 0, view); return replace(next);
    },
    update(id, change) {
      ensureLive(); object(change, ['name', 'duration'], 'View update');
      const next = copy(document), at = find(id); next.waypoints[at] = { ...next.waypoints[at], ...change }; return replace(next);
    },
    seek(at) {
      ensureLive();
      if (!Number.isInteger(at) || at < 0 || at >= document.waypoints.length) throw new RangeError('Choose a saved view to preview.');
      snapshot(); cancel(); status = 'paused'; error = ''; index = at;
      elapsed = document.waypoints.slice(0, at).reduce((sum, view) => sum + view.duration, 0);
      try { apply(copy(document.waypoints[at].pose)); } finally { notify(); }
      return getState();
    },
    play() {
      ensureLive(); if (status === 'playing') return getState();
      if (!document.waypoints.length) throw new Error('Save at least one view before playing a tour.');
      snapshot(); error = '';
      if (status !== 'paused') { elapsed = 0; index = 0; }
      startedAt = now() - elapsed * 1000;
      if (!Number.isFinite(startedAt)) throw new Error('Camera tour clock must be finite.');
      status = 'playing';
      try { sample(); schedule(); }
      catch (failure) { cancel(); status = 'paused'; error = failure.message || 'Could not play this camera tour.'; throw failure; }
      finally { notify(); }
      return getState();
    },
    pause() {
      ensureLive(); if (status !== 'playing') return getState();
      cancel();
      try { advance(); if (status === 'playing') status = 'paused'; }
      catch (failure) { status = 'paused'; error = failure.message || 'Could not pause this camera tour.'; throw failure; }
      finally { notify(); }
      return getState();
    },
    stop,
    export() { ensureLive(); return validateTour(document); },
    import(value) { ensureLive(); return replace(validateTour(value)); },
    dispose() {
      if (disposed) return;
      try { stop(); } finally { disposed = true; listeners.clear(); }
    }
  };
  return api;
}
