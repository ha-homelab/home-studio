import { mapReadResult } from './ha-bridge.js';

const LIMITS = Object.freeze({ visible: 36, cache: 48, requests: 4, perMinute: 120 });
const ATTRIBUTION = '© OpenStreetMap contributors', ATTRIBUTION_URL = 'https://www.openstreetmap.org/copyright';
// These are the viewer's homeMapMath projection, rotation and LOD equations.
// Parity tests cover rotations, Mercator limits and antimeridian placement.
export const siteMapMath = (() => {
  const circumference = 2 * Math.PI * 6378137, clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function project(latitude, longitude) { return [(longitude + 180) / 360, (1 - Math.asinh(Math.tan(clamp(latitude, -85.05112878, 85.05112878) * Math.PI / 180)) / Math.PI) / 2]; }
  function transform(config) {
    const [x, y] = project(config.latitude, config.longitude), scale = circumference * Math.cos(config.latitude * Math.PI / 180), angle = config.north_deg * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    return { scale, toWorld: (u, v) => { const dx = (u - x) * scale, dz = (v - y) * scale; return [config.model_x + dx * c + dz * s, config.model_z - dx * s + dz * c]; },
      toMap: (wx, wz) => { const dx = wx - config.model_x, dz = wz - config.model_z; return [x + (dx * c - dz * s) / scale, y + (dx * s + dz * c) / scale]; } };
  }
  function tiles(config, bounds, pixels) {
    const t = transform(config), corners = bounds.map(p => t.toMap(...p)), span = Math.max(...corners.map(p => p[0])) - Math.min(...corners.map(p => p[0]));
    let z = clamp(Math.floor(Math.log2(Math.max(1, pixels) / (256 * Math.max(span, 1e-12)))), 3, 19), result;
    do {
      const n = 2 ** z, minX = Math.floor(Math.min(...corners.map(p => p[0])) * n), maxX = Math.floor(Math.max(...corners.map(p => p[0])) * n),
        minY = clamp(Math.floor(Math.min(...corners.map(p => p[1])) * n), 0, n - 1), maxY = clamp(Math.floor(Math.max(...corners.map(p => p[1])) * n), 0, n - 1);
      result = [];
      if ((maxX - minX + 1) * (maxY - minY + 1) <= LIMITS.visible) for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) result.push({ z, x: ((x % n) + n) % n, y, worldX: x, key: `${z}/${((x % n) + n) % n}/${y}` });
    } while (!result.length && --z >= 0);
    const center = corners.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
    return result.sort((a, b) => Math.hypot((a.worldX + .5) / 2 ** a.z - center[0], (a.y + .5) / 2 ** a.z - center[1]) - Math.hypot((b.worldX + .5) / 2 ** b.z - center[0], (b.y + .5) / 2 ** b.z - center[1]));
  }
  return { project, transform, tiles };
})();

async function decodeTile(url) {
  const bytes = Uint8Array.from(atob(url.slice(22)), character => character.charCodeAt(0)), header = new DataView(bytes.buffer);
  if (bytes.length < 33 || [137, 80, 78, 71, 13, 10, 26, 10].some((value, i) => bytes[i] !== value) ||
      header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452 || header.getUint32(16) !== 256 || header.getUint32(20) !== 256) throw Error('Invalid map image');
  const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  if (image.width !== 256 || image.height !== 256) { image.close(); throw Error('Invalid map image'); }
  return image;
}

// Coordinates and tile pixels are session state, never part of the drawing.
// This paints the existing 2D canvas and schedules no frame/timer of its own.
export function createSiteMapUnderlay({ request, onChange = () => {}, onStatus = () => {}, decode = decodeTile, now = Date.now }) {
  let enabled = false, disposed = false, config = null, view = null, desired = [], epoch = 0, inflight = 0, used = 0;
  let settings = null, loadingConfig = false, settingsError = false, budget = false, lastStatus = '';
  const cache = new Map(), times = [];
  const stats = () => ({ cached: cache.size, inflight, visible: desired.length, loaded: desired.filter(tile => cache.get(tile.key)?.image).length });
  function state() {
    const failed = desired.some(tile => cache.get(tile.key)?.failed), loaded = stats().loaded;
    const status = !enabled ? '' : loadingConfig ? 'Loading saved map alignment…' : settingsError ? 'Map unavailable. Check the Home Assistant connection and retry.' :
      !config ? 'Align and enable the map in Home Assistant first, then retry.' : budget ? 'Map request limit reached. Wait a minute, then retry.' :
      failed ? 'Some map tiles are unavailable. Retry to reload them.' : loaded < desired.length ? 'Loading map…' : '';
    return { enabled, configured: !!config, loading: enabled && (loadingConfig || !settingsError && !!config && !budget && !failed && loaded < desired.length),
      failed: enabled && (settingsError || budget || failed), status, attribution: enabled && config ? ATTRIBUTION : '', attributionUrl: enabled && config ? ATTRIBUTION_URL : '' };
  }
  function notify() {
    if (disposed) return;
    const value = state(), key = JSON.stringify(value);
    if (key !== lastStatus) { lastStatus = key; onStatus(value.status, value); }
  }
  function remove(entry) { entry.controller?.abort(); entry.image?.close(); if (cache.get(entry.key) === entry) cache.delete(entry.key); }
  function trim() {
    const wanted = new Set(desired.map(tile => tile.key));
    for (const entry of [...cache.values()].filter(entry => !wanted.has(entry.key) && !entry.controller).sort((a, b) => a.used - b.used)) {
      if (cache.size <= LIMITS.cache) break; remove(entry);
    }
  }
  function abortPending() {
    settings?.abort(); settings = null; loadingConfig = false;
    for (const entry of [...cache.values()]) if (entry.controller) remove(entry);
  }
  function pump() {
    if (disposed || !enabled || !config || loadingConfig) return;
    const cutoff = now() - 60000; while (times.length && times[0] <= cutoff) times.shift(); budget = false;
    for (const tile of desired) {
      if (inflight >= LIMITS.requests) break;
      let entry = cache.get(tile.key);
      if (entry) { entry.used = ++used; continue; }
      if (times.length >= LIMITS.perMinute) { budget = true; break; }
      const controller = new AbortController(), generation = epoch;
      entry = { key: tile.key, used: ++used, controller }; cache.set(tile.key, entry); inflight++; times.push(now()); trim();
      Promise.resolve().then(() => {
        if (controller.signal.aborted || generation !== epoch) throw new DOMException('Map request aborted', 'AbortError');
        return request('tile', { z: tile.z, x: tile.x, y: tile.y }, controller.signal);
      }).then(result => {
        if (controller.signal.aborted || generation !== epoch) return null;
        const value = mapReadResult('tile', result); if (!value) throw Error('Invalid map tile');
        return decode(value.data_url);
      }).then(image => {
        if (!image) return;
        if (disposed || controller.signal.aborted || generation !== epoch || !enabled) { image.close(); return; }
        entry.image = image;
        if (desired.some(tile => tile.key === entry.key)) onChange();
      }).catch(() => {
        if (!disposed && generation === epoch && !controller.signal.aborted) entry.failed = true;
      }).finally(() => {
        entry.controller = null; inflight--;
        if (!disposed) { trim(); pump(); notify(); }
      });
    }
    trim(); notify();
  }
  function updateView() {
    desired = [];
    if (config && view) {
      const { width, height, toWorld } = view, bounds = [[0, height], [0, 0], [width, 0], [width, height]].map(toWorld);
      if (bounds.every(point => Array.isArray(point) && point.length === 2 && point.every(value => Number.isFinite(value) && Math.abs(value) <= 2000000))) desired = siteMapMath.tiles(config, bounds, width);
    }
    pump(); notify();
  }
  async function reload() {
    if (disposed || !enabled) return;
    epoch++; abortPending();
    for (const entry of [...cache.values()]) if (entry.failed) remove(entry);
    const controller = new AbortController(), generation = epoch; settings = controller; loadingConfig = true; settingsError = false; notify();
    try {
      const result = mapReadResult('get', await request('get', undefined, controller.signal));
      if (disposed || generation !== epoch || controller.signal.aborted) return;
      if (!result) throw Error('Invalid map settings');
      config = result.configured && result.config.enabled ? result.config : null;
      if (!config) for (const entry of [...cache.values()]) remove(entry);
    } catch {
      if (disposed || generation !== epoch || controller.signal.aborted) return;
      settingsError = true; config = null; for (const entry of [...cache.values()]) remove(entry);
    } finally {
      if (!disposed && generation === epoch) { settings = null; loadingConfig = false; updateView(); onChange(); }
    }
  }
  return Object.freeze({
    get state() { return state(); }, get stats() { return stats(); },
    setEnabled(value) {
      value = !!value; if (disposed || value === enabled) return;
      enabled = value;
      if (enabled) void reload();
      else { epoch++; abortPending(); for (const entry of [...cache.values()]) remove(entry); config = null; desired = []; notify(); onChange(); }
    },
    setView(value) {
      if (disposed) return;
      view = value && typeof value.toWorld === 'function' && [value.width, value.height].every(number => Number.isFinite(number) && number > 0 && number <= 32768) ? value : null;
      updateView();
    },
    draw(ctx, { worldToCanvas }) {
      if (disposed || !enabled || !config) return;
      const transform = siteMapMath.transform(config);
      for (const tile of desired) {
        const image = cache.get(tile.key)?.image; if (!image) continue;
        const n = 2 ** tile.z, points = [[tile.worldX / n, tile.y / n], [(tile.worldX + 1) / n, tile.y / n], [tile.worldX / n, (tile.y + 1) / n]].map(point => worldToCanvas(transform.toWorld(...point)));
        const [a, b, c] = points;
        ctx.save(); ctx.globalAlpha *= .85;
        ctx.transform((b[0] - a[0]) / 256, (b[1] - a[1]) / 256, (c[0] - a[0]) / 256, (c[1] - a[1]) / 256, a[0], a[1]);
        ctx.drawImage(image, 0, 0, 256, 256); ctx.restore();
      }
    },
    reload,
    dispose() { if (disposed) return; disposed = true; enabled = false; epoch++; abortPending(); for (const entry of [...cache.values()]) remove(entry); config = null; view = null; desired = []; },
  });
}
