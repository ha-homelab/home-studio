// The embedded editor is deliberately unprivileged. This protocol carries only
// editable drawings, registry labels, and bounded AI operations; HA authentication stays in the host.
export const PROTOCOL = 'home-studio-editor-v1';
const GUIDE_ACTIONS = Object.freeze(['room', 'devices', 'preview', 'photos', 'focus-edit']);
export function embeddedContext(win = window) {
  const url = new URL(win.location.href);
  if (win.parent === win) return null;
  if (url.href === 'about:srcdoc') {
    try {
      const entries = win.document.querySelectorAll('meta[name="home-studio-bootstrap"]');
      if (entries.length !== 1) return null;
      const value = JSON.parse(entries[0].content), origin = new URL(value.origin);
      if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== value.origin || !/^[a-f0-9]{32}$/.test(value.channel || '')) return null;
      return { channel: value.channel, origin: value.origin };
    } catch { return null; }
  }
  const channel = new URLSearchParams(url.hash.slice(1)).get('ha-studio');
  if (!['http:', 'https:'].includes(url.protocol) || url.searchParams.get('embed') !== 'home-assistant' || !/^[a-f0-9]{32}$/.test(channel || '')) return null;
  return { channel, origin: url.origin };
}
// A separate, dependency-free module entry reports that the document committed
// before the larger editor import graph or initialization is ready.
if (typeof window !== 'undefined') {
  const context = embeddedContext();
  if (context) window.parent.postMessage({ protocol: PROTOCOL, channel: context.channel, type: 'loading' }, context.origin);
}
export function memoryDraftOptions() {
  const values = new Map();
  return {
    storage: () => ({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }),
    locks: { request: async (_name, operation) => operation() },
  };
}
export function connectHost(context, { initialize, snapshot, currentFloor, editState, subscribe, flush, failed, guideAction, theme }, win = window) {
  const ai = createNativeAiTransport(context, win);
  let initialized = false, previous = '', previousState = '', sequence = 0;
  const send = (type, payload = {}) => win.parent.postMessage({ protocol: PROTOCOL, channel: context.channel, type, ...payload }, context.origin);
  const changed = (requestId) => {
    if (!initialized) return;
    const project = snapshot(), raw = JSON.stringify(project), edits = editState(), state = JSON.stringify(edits);
    if (raw !== previous || state !== previousState || requestId) {
      previous = raw; previousState = state;
      const floor = currentFloor?.();
      send('snapshot', { project, edits, current_floor: typeof floor === 'string' && floor.length <= 128 ? floor : null, sequence: ++sequence, requestId });
    }
  };
  const receive = event => {
    const data = event.data;
    if (event.source !== win.parent || event.origin !== context.origin || data?.protocol !== PROTOCOL || data.channel !== context.channel) return;
    if (data.type === 'initialize' && !initialized) {
      try {
        theme?.(data.theme);
        initialize(data.project, data.catalog, data.capabilities?.ai === true ? ai : null,
          { architectureEditing: data.capabilities?.architecture_editing !== false, source: data.source },
          { publishedPreview: () => { if (initialized) send('published-preview'); } });
        initialized = true; changed();
      }
      catch { failed(); send('error', { message: 'The saved drawing could not be opened. Export its JSON from Home Assistant for recovery.' }); }
    } else if (data.type === 'snapshot-request' && initialized && typeof data.requestId === 'string' && data.requestId.length < 80) {
      try { if (data.commit !== false) flush(data.allowInvalid === true); changed(data.requestId); }
      catch (error) { changed(); send('snapshot-error', { requestId: data.requestId, message: error.message }); }
    } else if (data.type === 'guide-action' && initialized && GUIDE_ACTIONS.includes(data.action)) {
      // Navigation only: the existing editor controls still own every edit.
      guideAction?.(data.action);
    } else if (data.type === 'theme' && initialized) {
      theme?.(data.theme);
    }
  };
  win.addEventListener('message', receive);
  // Transactions refresh inspector controls before the host reads field state.
  const unsubscribe = subscribe(() => queueMicrotask(() => changed()));
  send('ready');
  return () => { unsubscribe(); ai.dispose(); win.removeEventListener('message', receive); };
}

// This is an RPC for the AI service only, never a general URL/fetch proxy. The
// opaque child receives no HA credential or AI session token in either direction.
const AI_ACTION_LIMITS = Object.freeze({ providers: 0, status: 0, connect: 32768, disconnect: 2, cancel: 256, generate: 17 * 1024 * 1024 });
const MAX_AI_RESPONSE = 2 * 1024 * 1024;
export function createNativeAiTransport(context, win = window) {
  let sequence = 0, disposed = false;
  const pending = new Map();
  const send = (type, payload = {}) => win.parent.postMessage({ protocol: PROTOCOL, channel: context.channel, type, ...payload }, context.origin);
  const finish = (requestId, error, result) => {
    const entry = pending.get(requestId); if (!entry) return;
    pending.delete(requestId); clearTimeout(entry.timer); entry.signal?.removeEventListener('abort', entry.abort);
    error ? entry.reject(error) : entry.resolve(result);
  };
  const receive = event => {
    const data = event.data;
    if (event.source !== win.parent || event.origin !== context.origin || data?.protocol !== PROTOCOL || data.channel !== context.channel || data.type !== 'ai-response' || !pending.has(data.requestId)) return;
    try {
      if (new Blob([JSON.stringify(data)]).size > MAX_AI_RESPONSE) throw new Error('AI response exceeds the limit');
      if (data.error) finish(data.requestId, Object.assign(new Error('AI request failed'), { code: data.error.code, status: data.error.status, upstreamStatus: data.error.upstreamStatus }));
      else finish(data.requestId, null, data.result);
    } catch { finish(data.requestId, Object.assign(new Error('Invalid AI response'), { code: 'invalid_response' })); }
  };
  win.addEventListener('message', receive);
  const close = () => {
    send('ai-close');
    for (const id of [...pending.keys()]) finish(id, new DOMException('AI session closed.', 'AbortError'));
  };
  return Object.freeze({
    request(action, body, signal) {
      if (disposed || signal?.aborted) return Promise.reject(new DOMException('AI request aborted.', 'AbortError'));
      if (!Object.hasOwn(AI_ACTION_LIMITS, action) || pending.size >= 8) return Promise.reject(new Error('AI request unavailable'));
      const raw = body === undefined ? '' : JSON.stringify(body);
      if (new Blob([raw]).size > AI_ACTION_LIMITS[action]) return Promise.reject(new Error('AI request exceeds the limit'));
      const requestId = `ai-${++sequence}`;
      return new Promise((resolve, reject) => {
        const abort = () => { send('ai-abort', { requestId }); finish(requestId, new DOMException('AI request aborted.', 'AbortError')); };
        const timer = setTimeout(() => { send('ai-abort', { requestId }); finish(requestId, Object.assign(new Error('AI request timed out'), { code: 'timeout' })); }, action === 'generate' ? 125000 : 25000);
        pending.set(requestId, { resolve, reject, timer, signal, abort });
        signal?.addEventListener('abort', abort, { once: true });
        send('ai-request', { requestId, action, ...(body === undefined ? {} : { body }) });
      });
    },
    close,
    dispose() { if (disposed) return; close(); disposed = true; win.removeEventListener('message', receive); },
  });
}
