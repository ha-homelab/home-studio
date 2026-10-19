// The embedded editor is deliberately unprivileged. This protocol carries only
// editable drawings and registry labels; authentication stays in the HA host.
export const PROTOCOL = 'home-studio-editor-v1';
export function embeddedContext(win = window) {
  const url = new URL(win.location.href);
  const channel = new URLSearchParams(url.hash.slice(1)).get('ha-studio');
  if (win.parent === win || url.searchParams.get('embed') !== 'home-assistant' || !/^[a-f0-9]{32}$/.test(channel || '')) return null;
  return { channel, origin: url.origin };
}
export function memoryDraftOptions() {
  const values = new Map();
  return {
    storage: () => ({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }),
    locks: { request: async (_name, operation) => operation() },
  };
}
export function connectHost(context, { initialize, snapshot, editState, subscribe, flush, failed }, win = window) {
  let initialized = false, previous = '', previousState = '', sequence = 0;
  const send = (type, payload = {}) => win.parent.postMessage({ protocol: PROTOCOL, channel: context.channel, type, ...payload }, context.origin);
  const changed = (requestId) => {
    if (!initialized) return;
    const project = snapshot(), raw = JSON.stringify(project), edits = editState(), state = JSON.stringify(edits);
    if (raw !== previous || state !== previousState || requestId) {
      previous = raw; previousState = state;
      send('snapshot', { project, edits, sequence: ++sequence, requestId });
    }
  };
  const receive = event => {
    const data = event.data;
    if (event.source !== win.parent || event.origin !== context.origin || data?.protocol !== PROTOCOL || data.channel !== context.channel) return;
    if (data.type === 'initialize' && !initialized) {
      try { initialize(data.project, data.catalog); initialized = true; changed(); }
      catch { failed(); send('error', { message: 'The saved drawing could not be opened. Export its JSON from Home Assistant for recovery.' }); }
    } else if (data.type === 'snapshot-request' && initialized && typeof data.requestId === 'string' && data.requestId.length < 80) {
      try { flush(data.allowInvalid === true); changed(data.requestId); }
      catch (error) { changed(); send('snapshot-error', { requestId: data.requestId, message: error.message }); }
    }
  };
  win.addEventListener('message', receive);
  // Transactions refresh inspector controls before the host reads field state.
  const unsubscribe = subscribe(() => queueMicrotask(() => changed()));
  send('ready');
  return () => { unsubscribe(); win.removeEventListener('message', receive); };
}
