// Read-only map RPC for the opaque native editor. Keep these bounds aligned
// with panel.js and the authenticated map.py adapter; no URL reaches callWS.
export const mapBridgeLimits = Object.freeze({ tiles: 4, settings: 1, queued: 64, tileCharacters: 699074 });
const number = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
export function mapConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean' ||
      !number(value.latitude, -85, 85) || !number(value.longitude, -180, 180) ||
      !number(value.model_x, -10000, 10000) || !number(value.model_z, -10000, 10000) || !number(value.north_deg, 0, 360)) return null;
  const { enabled, latitude, longitude, model_x, model_z, north_deg } = value;
  return { enabled, latitude, longitude, model_x, model_z, north_deg };
}
export function mapSnapshot(value) {
  const config = mapConfig(value?.config);
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.configured !== 'boolean' ||
      (value.configured ? !config : value.config !== null) ||
      !number(value.reference?.latitude, -90, 90) || !number(value.reference?.longitude, -180, 180)) return null;
  // The editor needs the saved alignment, never HA's unrelated home reference.
  return { revision: value.revision, configured: value.configured, config };
}
export function mapTileResult(value) {
  if (typeof value?.data_url !== 'string' || value.data_url.length > mapBridgeLimits.tileCharacters ||
      !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.data_url)) return null;
  const body = value.data_url.slice(22), bytes = body.length / 4 * 3 - (body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0);
  if (body.length % 4 !== 0 || bytes > 524288) return null;
  return { data_url: value.data_url, attribution: '© OpenStreetMap contributors', attribution_url: 'https://www.openstreetmap.org/copyright' };
}
const validTile = body => body && typeof body === 'object' && !Array.isArray(body) &&
  Object.keys(body).length === 3 && ['z', 'x', 'y'].every(key => Object.hasOwn(body, key)) &&
  Number.isInteger(body.z) && body.z >= 0 && body.z <= 19 &&
  Number.isInteger(body.x) && Number.isInteger(body.y) && body.x >= 0 && body.y >= 0 && body.x < 2 ** body.z && body.y < 2 ** body.z;

export function createStudioMapTransport({ getContext, send }) {
  let session = null, sequence = 0, disposed = false;
  const pending = new Map(), queue = [], active = { tiles: 0, settings: 0 };
  const snapshot = () => {
    const value = getContext(), hass = value?.hass;
    if (!value?.ready || !value.connected || !value.frame || !/^[a-f0-9]{32}$/.test(value.channel || '') ||
        !hass?.user?.id || !hass.connection || hass.connected === false || hass.connection.connected === false || typeof hass.callWS !== 'function') return null;
    return { ...value, account: hass.user.id, connection: hass.connection };
  };
  const same = (a, b) => !!a && !!b && ['frame', 'channel', 'generation', 'connectionEpoch', 'account', 'connection'].every(key => a[key] === b[key]);
  const current = job => !disposed && !job.cancelled && job.session === session && same(job.session, snapshot());
  function reset() {
    for (const job of pending.values()) job.cancelled = true;
    pending.clear(); queue.length = 0; session = null; sequence = 0;
    // callWS has no cancellation API. Its occupied slots remain occupied until
    // settlement, including across frame replacement, reconnect and abort.
  }
  function reply(job, payload) { if (current(job)) send('map-response', { requestId: job.id, ...payload }); }
  function drain() {
    if (disposed) return;
    for (let i = 0; i < queue.length;) {
      const job = queue[i];
      if (!current(job)) { queue.splice(i, 1); if (pending.get(job.id) === job) pending.delete(job.id); continue; }
      if (active[job.kind] >= mapBridgeLimits[job.kind]) { i++; continue; }
      queue.splice(i, 1); active[job.kind]++;
      Promise.resolve().then(() => current(job) ? job.session.hass.callWS(job.request) : null).then(value => {
        if (!current(job)) return;
        const result = job.kind === 'tiles' ? mapTileResult(value) : mapSnapshot(value);
        reply(job, result ? { result } : { error: { code: 'invalid_response' } });
      }).catch(error => {
        const code = error?.code || error?.error?.code;
        reply(job, { error: { code: code === 'map_disabled' ? 'map_disabled' : ['unauthorized', 'forbidden'].includes(code) ? 'access_denied' : 'unavailable' } });
      }).finally(() => {
        active[job.kind]--; if (pending.get(job.id) === job) pending.delete(job.id); drain();
      });
    }
  }
  return Object.freeze({
    handle(data) {
      if (!['map-request', 'map-abort', 'map-close'].includes(data?.type)) return false;
      if (disposed) return true;
      if (data.type === 'map-close') { reset(); return true; }
      const context = snapshot();
      if (!context) { reset(); return true; }
      if (!same(session, context)) { reset(); session = context; }
      if (data.type === 'map-abort') {
        const job = pending.get(data.requestId); if (job) { job.cancelled = true; pending.delete(job.id); drain(); }
        return true;
      }
      const match = /^map-([1-9][0-9]{0,9})$/.exec(data.requestId || '');
      if (!match || Number(match[1]) <= sequence) return true;
      sequence = Number(match[1]);
      const job = { id: data.requestId, session, cancelled: false };
      if (data.action === 'get' && data.body === undefined) { job.kind = 'settings'; job.request = { type: 'home_floorplan/map_get' }; }
      else if (data.action === 'tile' && validTile(data.body)) { job.kind = 'tiles'; job.request = { type: 'home_floorplan/map_tile', z: data.body.z, x: data.body.x, y: data.body.y }; }
      else { reply(job, { error: { code: 'invalid_request' } }); return true; }
      if (queue.length >= mapBridgeLimits.queued) { reply(job, { error: { code: 'busy' } }); return true; }
      pending.set(job.id, job); queue.push(job); drain(); return true;
    },
    reset,
    dispose() { if (disposed) return; reset(); disposed = true; },
  });
}
