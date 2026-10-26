/* Trusted Home Assistant authoring host. Credentials never enter the editor. */
import { createStudioMapTransport } from './map-transport.js';
const STUDIO_PROTOCOL = 'home-studio-editor-v1';
const MAX_PROJECT_BYTES = 2000000;
const AI_RESPONSE_LIMIT = 2 * 1024 * 1024;
const AI_ACTIONS = Object.freeze({
  providers: {}, status: {},
  connect: { fields: ['provider', 'model', 'api_key', 'endpoint'], limit: 32768 },
  disconnect: { fields: [], limit: 2 }, cancel: { fields: ['request_id'], limit: 256 },
  generate: { fields: ['request_id', 'mode', 'context', 'instructions', 'images', 'schema'], limit: 17 * 1024 * 1024 },
});
const STARTUP_TIMEOUT_MS = 15000;
const EDITOR_NAVIGATION_TIMEOUT_MS = 8000;
const EDITOR_FETCH_TIMEOUT_MS = 15000;
const MAX_EDITOR_HTML_BYTES = 128 * 1024;
const MAX_MODEL_EXPORT_BYTES = 32 * 1024 * 1024;
const MODEL_EXPORT_TIMEOUT_MS = 120000;
const EDITOR_PATH = '/home-floorplan-studio/planner/index.html';
const EDITOR_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src blob:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const EDITOR_LOAD_MESSAGES = Object.freeze({
  http: 'Home Assistant returned an HTTP error for the local editor',
  redirect: 'The local editor request was redirected',
  address: 'The local editor responded from an unexpected address',
  type: 'The local editor returned an unsupported file type',
  size: 'The local editor response exceeded its size limit',
  body: 'The local editor download was interrupted',
  decode: 'The local editor text could not be decoded',
  parse: 'The browser could not prepare the local editor document',
  policy: 'The local editor security policy did not match this version',
  document: 'The local editor document did not match this version',
  assets: 'The local editor scripts or styles did not match this version',
  open: 'The browser could not open the prepared editor document',
  fetch: 'Could not fetch the local editor',
  timeout: 'Loading the local drawing tools timed out',
});
function editorLoadError(code, status) {
  return Object.assign(new Error(EDITOR_LOAD_MESSAGES[code]), { editorCode: code, status });
}
function editorLoadHelp(code, status) {
  if (code === 'http' && [401, 403].includes(status)) return 'Open another Home Assistant dashboard using this same address and check your login or proxy access policy.';
  if (code === 'redirect' || code === 'type') return 'A login page or proxy response may have replaced the editor. Check that the editor route returns the bundled file, then retry.';
  if (code === 'policy') return 'A proxy login page, rewritten response, or files from a different release may have replaced the editor. Check your login and that the proxy returns the bundled editor unchanged.';
  if (['assets', 'policy', 'document'].includes(code)) return 'Check that the installed files are from one release and that your proxy preserves editor resources without rewriting them.';
  if (code === 'http' && status === 404) return 'Check the complete integration installation and any proxy cache for this route, then retry.';
  if (['timeout', 'fetch', 'body'].includes(code)) return 'Check whether another Home Assistant dashboard works using this same address. Keep this tab open; retry when the connection is available.';
  return 'Keep this tab open and retry. If the problem continues, report this error code with your browser and Home Studio versions.';
}
function modelExportFile(result, format) {
  const extension = format === 'glb' ? 'glb' : 'zip';
  if (typeof result?.filename !== 'string' || !/^home-studio-[a-zA-Z0-9_-]+\.(glb|zip)$/.test(result.filename) ||
      result.filename.length > 180 || !result.filename.endsWith('.' + extension) || typeof result.base64 !== 'string' ||
      !result.base64.length || result.base64.length > 4 * Math.ceil(MAX_MODEL_EXPORT_BYTES / 3) ||
      result.base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.base64)) throw new Error('Home Assistant returned an invalid model file. Nothing was downloaded.');
  const binary = atob(result.base64);
  if (binary.length > MAX_MODEL_EXPORT_BYTES || (format === 'glb' ? binary.slice(0, 4) !== 'glTF' : binary.slice(0, 4) !== 'PK\x03\x04')) throw new Error('Home Assistant returned an invalid model file. Nothing was downloaded.');
  return { filename: result.filename, blob: new Blob([Uint8Array.from(binary, character => character.charCodeAt(0))],
    { type: format === 'glb' ? 'model/gltf-binary' : 'application/zip' }) };
}
const THEME_COLORS = Object.freeze({ background: 'primary-background-color', surface: 'card-background-color',
  text: 'primary-text-color', muted: 'secondary-text-color', border: 'divider-color',
  accent: 'primary-color', accentText: 'text-primary-color', error: 'error-color' });
const clone = value => JSON.parse(JSON.stringify(value));
const boundedText = (value, max = 128) => typeof value === 'string' ? value.slice(0, max) : '';
function projectBytes(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) throw new Error('Invalid drawing');
  const raw = JSON.stringify(project);
  if (new Blob([raw]).size > MAX_PROJECT_BYTES) throw new Error('Drawing exceeds the 2 MB limit');
  return raw;
}
async function editorDocument(response, url, channel) {
  if (response.type === 'opaqueredirect' || response.redirected) throw editorLoadError('redirect');
  if (!response.ok) throw editorLoadError('http', response.status);
  if (response.url !== url.href) throw editorLoadError('address');
  if (!/^text\/html(?:\s*;|\s*$)/i.test(response.headers.get('Content-Type') || '')) throw editorLoadError('type');
  if (Number(response.headers.get('Content-Length')) > MAX_EDITOR_HTML_BYTES) throw editorLoadError('size');
  const chunks = []; let reader, size = 0;
  try {
    reader = response.body?.getReader(); if (!reader) throw editorLoadError('body');
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_EDITOR_HTML_BYTES) throw editorLoadError('size');
      chunks.push(value);
    }
  } catch (error) { throw error?.editorCode ? error : editorLoadError('body'); }
  finally { await reader?.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let html, document;
  try { html = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw editorLoadError('decode'); }
  try { document = new DOMParser().parseFromString(html, 'text/html'); }
  catch { throw editorLoadError('parse'); }
  const policy = document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]');
  if (policy.length !== 1 || policy[0].content !== EDITOR_CSP) throw editorLoadError('policy');
  if (document.querySelector('base, meta[http-equiv="refresh"], meta[name="home-studio-bootstrap"]')) throw editorLoadError('document');
  // Firefox resolves srcdoc's 'self' to its opaque origin. Spell out the same
  // trusted origin allowed by the URL document, without widening its CSP scope.
  policy[0].content = EDITOR_CSP.replaceAll("'self'", url.origin);
  // Only the known bundled entry points are rebased; module-relative imports
  // then resolve from these URLs. No base tag or arbitrary URL is accepted.
  const assets = [['link[rel="stylesheet"]', 'href', ['./editor.css', './floor-navigator.css', '../camera-tour.css', './site-editor.css']],
    ['script', 'src', ['./ha-bridge.js', './editor.js']]];
  for (const [selector, attribute, expected] of assets) {
    const elements = [...document.querySelectorAll(selector)];
    if (elements.length !== expected.length || elements.some((element, index) =>
      element.getAttribute(attribute) !== expected[index] || (selector === 'script' && element.type !== 'module'))) throw editorLoadError('assets');
    for (const element of elements) element.setAttribute(attribute, new URL(element.getAttribute(attribute), url).href);
  }
  const context = document.createElement('meta'); context.name = 'home-studio-bootstrap';
  context.content = JSON.stringify({ origin: url.origin, channel }); document.head.append(context);
  return '<!doctype html>\n' + document.documentElement.outerHTML;
}
function catalogForEditor(catalog = {}) {
  // Copy an explicit allowlist. Raw state attributes, integration settings, registry
  // internals, and the authenticated hass object are never forwarded.
  const list = key => Array.isArray(catalog[key]) ? catalog[key].slice(0, 10000) : [];
  const floors = list('floors').map(item => ({ id: boundedText(item.id), name: boundedText(item.name, 120) }));
  const areas = list('areas').map(item => ({ id: boundedText(item.id), name: boundedText(item.name, 120), floor_id: boundedText(item.floor_id) }));
  const entities = list('entities').filter(item => typeof item.entity_id === 'string' && item.entity_id.length <= 150 && /^[a-z_]+\.[a-z0-9_]+$/.test(item.entity_id) && !item.disabled).map(item => ({
    entity_id: boundedText(item.entity_id, 150), name: boundedText(item.name || item.entity_id, 100), domain: item.entity_id.split('.')[0],
    area_id: boundedText(item.area_id), disabled: false, available: item.available !== false,
    device_class: /^[a-z][a-z0-9_]{0,39}$/.test(item.device_class || '') ? item.device_class : '',
    entity_category: ['config', 'diagnostic'].includes(item.entity_category) ? item.entity_category : '', hidden: item.hidden === true,
  }));
  return { floors, areas, entities };
}
function sourceForEditor(saved) {
  if (saved.capabilities?.architecture_editing !== false) return undefined;
  const source = saved.source;
  if (source?.kind !== 'generated' || !Array.isArray(source.protected_floors) || source.protected_floors.length > 8) throw new Error('The protected home source is unavailable.');
  const ids = value => {
    if (!Array.isArray(value) || value.length > 256 || value.some(id => typeof id !== 'string' || id.length > 128)) throw new Error('The protected home source is invalid.');
    return [...value];
  };
  const floors = ids(source.protected_floors);
  return { kind: 'generated', protected_floors: floors,
    protected_rooms: Object.fromEntries(floors.map(id => [id, ids(source.protected_rooms?.[id])])),
    custom_items: Object.fromEntries(floors.map(id => [id, ids(source.custom_items?.[id] || [])])),
  };
}
class HomeFloorplanStudioPanel extends HTMLElement {
  constructor() {
    super(); this.attachShadow({ mode: 'open' });
    this._busy = false; this._ready = false; this._started = false; this._project = null;
    this._savedRaw = null; this._pristineRaw = null; this._initializingBlank = false; this._revision = 0; this._publishedRevision = null;
    this._pending = new Map(); this._sequence = 0; this._request = 0; this._generation = 0;
    this._aiPending = new Map(); this._aiEpoch = 0; this._aiSequence = 0; this._aiSession = null; this._aiSessionPromise = null;
    this._pagehide = () => {
      this._disposeAi();
      this._resetMapTransport();
      if (this._exportBusy) {
        this._exportSequence++;
        this._cancelExport?.(new Error('Export download cancelled when leaving the page.'));
        this._cancelExport = null; this._exportBusy = false;
        this._modelExportStatus('Export download cancelled when leaving the page. Your drawing remains in this tab.');
        this._buttons();
      }
    };
    this._edits = {}; this._startupTimer = null; this._startupFailed = false;
    this._exportBusy = false; this._exportSequence = 0; this._currentFloor = null; this._connectionEpoch = 0;
    this._mapTransport = createStudioMapTransport({
      getContext: () => ({ hass: this._hass, ready: this._ready, connected: this.isConnected && this._online(),
        frame: this._frame?.contentWindow, channel: this._channel, generation: this._generation, connectionEpoch: this._connectionEpoch }),
      send: (type, payload) => {
        if (type === 'map-response' && payload.result?.data_url) this.$('studio-map-credit').hidden = false;
        this._send(type, payload);
      },
    });
    this._receive = event => this._onMessage(event);
    this._beforeUnload = event => { if (this._unsaved() || this._busy) { event.preventDefault(); event.returnValue = ''; } };
    this.shadowRoot.innerHTML = `
      <style>
      :host{display:flex;flex-direction:column;height:100vh;height:100dvh;min-height:640px;overflow:auto;color:var(--primary-text-color,#263737);background:var(--primary-background-color,#f7f8f5);font:14px system-ui,sans-serif}
      *{box-sizing:border-box}header{padding:14px 20px 10px;border-bottom:1px solid var(--divider-color,#d9e0d9)}h1{font-size:22px;margin:0}p{line-height:1.5;margin:6px 0}.muted{color:var(--secondary-text-color,#5b6d67);font-size:13px}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.actions{margin:12px 0 8px}button,a{font:inherit}button,summary{min-height:44px;padding:9px 14px;border:1px solid var(--divider-color,#becbc2);border-radius:7px;background:var(--card-background-color,#fff);color:inherit;cursor:pointer}button.primary{background:var(--primary-color,#326857);color:var(--home-studio-primary-foreground,var(--text-primary-color,#fff));border-color:var(--primary-color,#326857)}button:disabled,a[aria-disabled=true]{opacity:.5;cursor:default}a{color:var(--primary-color,#326857);text-underline-offset:3px}button:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid var(--primary-text-color,#263737);outline-offset:3px}#family{margin-inline-start:auto;display:inline-flex;align-items:center;min-height:44px;padding:8px}#status{min-height:22px;overflow-wrap:anywhere}#status.error{color:var(--error-color,#a53d29)}#more-options{position:relative;margin-inline-start:auto}#more-options summary{list-style:revert}#more-options .options{position:absolute;inset-inline-end:0;top:100%;z-index:5;min-width:260px;max-width:90vw;display:grid;gap:8px;padding:12px;border:1px solid var(--divider-color,#becbc2);border-radius:8px;background:var(--card-background-color,#fff);box-shadow:var(--ha-card-box-shadow,0 8px 24px #0002)}#guide{border-bottom:1px solid var(--divider-color,#d9e0d9);padding:0 20px 10px}#guide summary{border:0;background:transparent;font-weight:600;padding-inline:0}.steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.step{padding:10px 12px;border:1px solid var(--divider-color,#d9e0d9);border-radius:9px;background:var(--card-background-color,#fff)}.step h2{font-size:14px;margin:0 0 5px}.step p{font-size:12px;color:var(--secondary-text-color,#5b6d67)}.step button{font-size:12px;min-height:40px;padding:7px 10px}.step-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.step[data-current=true]{border-color:var(--primary-color,#398472);box-shadow:inset 3px 0 var(--primary-color,#398472)}#next-step{font-size:13px;margin:10px 0 0}#published-view{display:flex;flex:1;min-height:580px;flex-direction:column}.published-heading{padding:12px 20px;background:var(--card-background-color,#fff)}.published-heading h2{font-size:18px;margin:10px 0 4px}.published-heading p{font-size:13px}#published-canvas{display:flex;flex:1;min-height:460px}#published-canvas>home-floorplan-panel{width:100%;height:65vh;min-height:460px}#recovery{padding:14px 22px;background:var(--card-background-color,#fff0d5);color:var(--primary-text-color,#4c402c);border-bottom:1px solid var(--warning-color,var(--divider-color,#e2c996))}iframe{display:block;flex:1;width:100%;border:0;min-height:520px;background:var(--primary-background-color,#f6f6f1)}#loading{padding:24px}[hidden]{display:none!important}@media(max-width:700px){header{padding:12px}.actions{gap:6px}.actions button{padding:8px 10px;font-size:12px}#guide{padding-inline:12px}.steps{grid-template-columns:1fr}.step{padding:9px 12px}#family{font-size:13px}iframe{min-height:780px}}
      #connection-notice{padding:8px 12px;border:1px solid var(--warning-color,#b18425);border-radius:7px}dialog{max-width:min(480px,calc(100vw - 32px));max-height:calc(100dvh - 32px);box-sizing:border-box;overflow:auto;border:1px solid var(--divider-color,#becbc2);border-radius:12px;padding:24px;color:inherit;background:var(--card-background-color,#fff)}dialog::backdrop{background:#0007}dialog h2{margin:0 0 12px;font-size:20px}dialog label{display:grid;gap:6px;margin:16px 0}dialog select{font:inherit;max-width:100%;min-height:44px;padding:8px;border:1px solid var(--divider-color,#becbc2);border-radius:6px;color:inherit;background:var(--card-background-color,#fff)}#model-export-status{overflow-wrap:anywhere;min-height:22px}#model-export-status.error{color:var(--error-color,#a53d29)}
      </style>
      <header>
        <div class="row"><button id="menu" aria-label="Open navigation menu">☰</button><h1>Home Studio</h1><a id="family" href="/home-floorplan">Open 3D Home</a></div>
        <p id="workflow-description" class="muted">Draw here. Save your draft, then publish it to use your home in 3D Home.</p>
        <div class="row actions">
          <button id="save" class="primary" aria-describedby="status" disabled>Save draft</button>
          <button id="publish" aria-describedby="status next-step" disabled>Publish to 3D Home</button>
          <button id="model-export" aria-haspopup="dialog" disabled>Export for Blender</button>
          <details id="more-options"><summary>More options</summary><div class="options">
            <button id="export" disabled>Export drawing (JSON)</button>
            <button id="reload" disabled>Load saved draft</button>
            <button id="site-frame" aria-haspopup="dialog" hidden disabled>Calibrate imported site frame</button>
          </div></details>
        </div>
        <div id="status" role="status" aria-live="polite" aria-atomic="true">Opening your drawing…</div><button id="retry" aria-describedby="status" hidden>Retry connection</button>
        <p id="connection-notice" role="status" aria-live="polite" hidden>Home Assistant is disconnected. Keep drawing or export JSON to keep a copy. Saving, publishing, and Blender export will be available after reconnection.</p>
      </header>
      <dialog id="site-frame-dialog" aria-labelledby="site-frame-title">
        <h2 id="site-frame-title">Review floor offsets</h2>
        <p>Use the original model's ground datums to align these floors to global site ground 0 m. Review the proposed offsets before applying.</p>
        <ul id="site-frame-offsets"></ul>
        <p>Apply saves floor offsets and a private recovery copy. Local rooms, objects, bindings, roof and yard geometry stay fixed. Your published home changes only after Publish to 3D Home.</p>
        <div class="row"><button id="site-frame-apply" class="primary" disabled>Apply floor offsets</button><button id="site-frame-cancel">Cancel</button></div>
      </dialog>
      <dialog id="model-export-dialog" aria-labelledby="model-export-title" aria-describedby="model-export-help">
        <h2 id="model-export-title">Export for Blender</h2>
        <p id="model-export-help">Download your current drawing, including valid unsaved edits. This does not save or publish your home.</p>
        <label for="model-export-floor">Floors</label><select id="model-export-floor"></select>
        <label for="model-export-format">Format</label><select id="model-export-format"><option value="glb">GLB (.glb)</option><option value="obj">OBJ + materials (.zip)</option></select>
        <p class="muted">A single floor starts at ground level. All floors keep their elevations. GLB keeps furniture groups; OBJ includes a material file.</p>
        <p id="model-export-status" role="status" aria-live="polite"></p>
        <div class="row"><button id="model-export-download" class="primary">Download model</button><button id="model-export-close">Close</button></div>
      </dialog>
      <details id="guide" open hidden><summary>Getting started · one room is enough</summary>
        <div class="steps">
          <section class="step" id="step-room"><h2>1. Draw a room</h2><p>Name it and enter its width and depth. Walls are included. Approximate measurements are fine to start.</p><div class="step-actions"><button id="guide-room" disabled>Add your first room</button><button id="guide-photos" hidden disabled>Draft from photos (AI)</button></div></section>
          <section class="step" id="step-devices"><h2>2. Add devices <span class="muted">(optional)</span></h2><p>Select a room, choose its Home Assistant area, then add a light or another device. You can do this later.</p><div class="step-actions"><button id="guide-devices" disabled>Add devices</button></div></section>
          <section class="step" id="step-publish"><h2>3. Save and publish</h2><p id="publish-help">Preview your drawing, then use Save draft and Publish to 3D Home above. Saving alone keeps the live plan unchanged.</p><div class="step-actions"><button id="guide-preview" disabled>Preview 3D</button></div></section>
        </div><p id="next-step">Start with one room. Add the rest of your home whenever you are ready.</p>
      </details>
      <section id="recovery" hidden><strong>Unsaved drawing found in this tab</strong><p id="recovery-description"></p><div class="row"><button id="resume">Resume recovered drawing</button><button id="download-recovery">Export recovered JSON</button><button id="discard">Use saved drawing</button></div></section>
      <section id="published-view" hidden><div class="published-heading"><button id="back-to-editor">Back to editing</button><h2>Published home</h2><p>This is the current published home. Draft changes appear here only after you publish. Device controls and layout editing are disabled.</p></div><div id="published-canvas"></div></section>
      <p id="studio-map-credit" class="muted" style="padding:0 20px" hidden>© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a></p>
      <p id="loading">Loading the local editor…</p>`;
    this.$('menu').onclick = () => this.dispatchEvent(new Event('hass-toggle-menu', { bubbles: true, composed: true }));
    for (const action of ['room', 'devices', 'preview', 'photos']) this.$('guide-' + action).onclick = () => this._guideAction(action);
    this.$('family').onclick = event => {
      if (this._busy) { event.preventDefault(); this._status('Wait for the current operation to finish before opening 3D Home.'); return; }
      if (this.$('family').getAttribute('aria-disabled') === 'true') { event.preventDefault(); this._status('Create and publish your first room to open it in 3D Home.'); return; }
      if (this._ready) { event.preventDefault(); void this._openFamily(); }
    };
    this.$('retry').onclick = () => this._retryStartup();
    this.$('back-to-editor').onclick = () => this._closePublishedHome();
    this.$('save').onclick = () => this._save();
    this.$('publish').onclick = () => this._publish();
    this.$('export').onclick = () => this._exportCurrent();
    this.$('model-export').onclick = () => this._openModelExport();
    this.$('model-export-download').onclick = () => this._exportModel();
    this.$('model-export-close').onclick = () => this.$('model-export-dialog').close();
    this.$('reload').onclick = () => this._reload();
    this.$('site-frame').onclick = () => this._previewSiteFrame();
    this.$('site-frame-apply').onclick = () => this._applySiteFrame();
    this.$('site-frame-cancel').onclick = () => this.$('site-frame-dialog').close();
    this.$('site-frame-dialog').addEventListener('close', () => { this._siteFramePreview = null; this._buttons(); });
    this.$('site-frame-dialog').addEventListener('cancel', event => { if (this._busy) event.preventDefault(); });
    this.$('resume').onclick = () => this._resolveRecovery(true);
    this.$('discard').onclick = () => this._resolveRecovery(false);
    this.$('download-recovery').onclick = () => this._download(this._recovery.project, 'recovered-project.json');
  }
  $(id) { return this.shadowRoot.getElementById(id); }
  set hass(value) {
    const identity = `${value?.user?.id || ''}:${value?.user?.is_admin === true}`;
    if (this._identity !== undefined && this._identity !== identity) this._reset();
    this._identity = identity; this._hass = value;
    this._scheduleTheme();
    if (this._publishedPanel) this._publishedPanel.hass = value;
    this._syncConnection();
    if (this.isConnected && !this._started && this._online()) void this._start();
  }
  _online() { return !!this._hass && this._connectionState?.ready === true; }
  _stopConnectionTracking() {
    const state = this._connectionState; this._connectionState = null;
    state?.connection?.removeEventListener?.('disconnected', state.disconnected);
    state?.connection?.removeEventListener?.('ready', state.connected);
  }
  _syncConnection() {
    if (!this.isConnected) return;
    const connection = this._hass?.connection;
    if (!this._connectionState || this._connectionState.connection !== connection) {
      this._connectionEpoch++;
      this._resetMapTransport();
      this._cancelExport?.(new Error('The Home Assistant connection changed. Nothing was downloaded. Try the export again.'));
      this._stopConnectionTracking();
      const state = this._connectionState = { connection, ready: null };
      state.disconnected = () => this._connectionReadiness(state, false);
      state.connected = () => this._connectionReadiness(state, true);
      connection?.addEventListener?.('disconnected', state.disconnected);
      connection?.addEventListener?.('ready', state.connected);
    }
    this._connectionReadiness(this._connectionState, !!this._hass &&
      (typeof connection?.connected === 'boolean' ? connection.connected : this._hass.connected !== false));
  }
  _connectionReadiness(state, ready) {
    if (state !== this._connectionState || !this.isConnected) return;
    if (state.ready === ready) return;
    this._connectionEpoch++;
    this._resetMapTransport();
    state.ready = ready;
    this.$('connection-notice').hidden = ready || !this._hass;
    if (!ready) { this._siteFramePreview = null; this.$('site-frame-dialog').close(); }
    if (!ready) this._cancelExport?.(new Error('Home Assistant disconnected. Nothing was downloaded. Reconnect and try the export again.'));
    this._buttons();
    if (this._ready && !this._busy) this._drawingStatus();
    // Reconnection never reloads an open draft or repeats a write/export.
    if (ready && this._hass && !this._started) void this._start();
  }
  _requireConnection(epoch = this._connectionEpoch) {
    if (!this._online() || epoch !== this._connectionEpoch) throw new Error('The Home Assistant connection changed. Keep this tab open and try again after reconnecting.');
  }
  _reset() {
    this._resetMapTransport();
    this._siteFramePreview = null; this.$('site-frame-dialog').close();
    this._closePublishedHome(false);
    this._disposeAi();
    this._stopConnectionTracking();
    this._exportSequence++; this._cancelExport?.(new Error('Editor session changed')); this._cancelExport = null;
    this._exportBusy = false; this._currentFloor = null; this.$('model-export-dialog').close();
    this._clearStartup(); this._clearEditorNavigation(); this._startupFailed = false; this._edits = {};
    cancelAnimationFrame(this._themeFrame); this._themeFrame = null;
    this._generation++; this._started = false; this._ready = false; this._busy = false;
    this._project = null; this._savedRaw = null; this._pristineRaw = null; this._initializingBlank = false; this._saved = null; this._source = null; this._publishedRevision = null; this.$('guide').hidden = true; this._catalog = null; this._recovery = null; this._channel = null;
    this._frame?.remove(); this._frame = null;
    for (const { reject, timer } of this._pending.values()) { clearTimeout(timer); reject(new Error('Editor session changed')); }
    this._pending.clear(); this.$('recovery').hidden = true; this.$('retry').hidden = true; this._buttons();
  }
  connectedCallback() {
    window.addEventListener('pagehide', this._pagehide);
    window.addEventListener('message', this._receive); window.addEventListener('beforeunload', this._beforeUnload);
    this._scheduleTheme();
    this._syncConnection();
  }
  disconnectedCallback() {
    window.removeEventListener('pagehide', this._pagehide);
    this._persist(); window.removeEventListener('message', this._receive); window.removeEventListener('beforeunload', this._beforeUnload);
    this._reset();
  }
  _scheduleTheme() {
    if (!this.isConnected || this._themeFrame != null) return;
    this._themeFrame = requestAnimationFrame(() => { this._themeFrame = null; this._refreshTheme(); });
  }
  _refreshTheme() {
    if (!this.isConnected) return;
    const dark = this._hass?.themes?.darkMode;
    const hostStyle = getComputedStyle(this);
    const inputs = JSON.stringify([dark, ...Object.values(THEME_COLORS).map(variable => hostStyle.getPropertyValue('--' + variable))]);
    // Entity state updates normally reuse the theme. Check its raw inputs once
    // before creating probes or reading pixels; direct CSS changes still apply.
    if (this._themeInputs === inputs && this._themeSource === this._hass?.themes) return;
    const defaults = dark === true
      ? { background: '#111b21', surface: '#1c282e', text: '#e7eef1', muted: '#a7b7bf', border: '#42545d', accent: '#6acdb0', accentText: '#111b21', error: '#ff9e91' }
      : { background: '#f7f8f5', surface: '#ffffff', text: '#263737', muted: '#5b6d67', border: '#becbc2', accent: '#326857', accentText: '#ffffff', error: '#a53d29' };
    const probe = document.createElement('span'), colors = {};
    probe.style.display = 'none'; this.shadowRoot.append(probe);
    try {
      for (const [key, variable] of Object.entries(THEME_COLORS)) {
        probe.style.color = `var(--${variable}, ${defaults[key]})`;
        colors[key] = getComputedStyle(probe).color;
      }
    } finally { probe.remove(); }
    this._themeInputs = inputs; this._themeSource = this._hass?.themes;
    const raw = JSON.stringify([dark, colors]); if (raw === this._themeRaw) return;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true }); if (!context) return;
    const normalize = (color, background) => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = '#000000'; context.fillStyle = color; context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      return '#' + [red, green, blue].map((value, index) => Math.round(value * alpha / 255 +
        parseInt(background.slice(1 + index * 2, 3 + index * 2), 16) * (1 - alpha / 255)).toString(16).padStart(2, '0')).join('');
    };
    const background = normalize(colors.background, defaults.background);
    const theme = { mode: typeof dark === 'boolean' ? dark ? 'dark' : 'light'
      : [1, 3, 5].reduce((sum, index) => sum + parseInt(background.slice(index, index + 2), 16), 0) < 384 ? 'dark' : 'light' };
    for (const key of Object.keys(THEME_COLORS)) theme[key] = key === 'background' ? background : normalize(colors[key], background);
    const luminance = color => [1, 3, 5].map(index => {
      const channel = parseInt(color.slice(index, index + 2), 16) / 255;
      return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    const accentLuminance = luminance(theme.accent);
    const contrast = color => (Math.max(accentLuminance, luminance(color)) + .05) / (Math.min(accentLuminance, luminance(color)) + .05);
    // Some HA accents are too light for the theme's usual white button label.
    const foreground = contrast(theme.accentText) >= 4.5 ? theme.accentText
      : contrast('#000000') > contrast('#ffffff') ? '#000000' : '#ffffff';
    this.style.setProperty('--home-studio-primary-foreground', foreground);
    // Only concrete, bounded colors cross the bridge; no theme CSS, variables,
    // URLs, or the authenticated hass object are exposed to the child.
    this._themeRaw = raw; this._theme = theme;
    if (this._ready) this._send('theme', { theme });
  }
  _key() { return `home-studio.ha-tab-draft.v1:${this._hass?.user?.id || 'unknown'}`; }
  _dirty() { return !!this._project && JSON.stringify(this._project) !== (this._savedRaw ?? this._pristineRaw); }
  _unsaved() { return this._dirty() || this._edits.pending === true; }
  _hasPublishedHome() { return this._saved?.has_published === true || this._publishedRevision != null; }
  _requiresInitialSave() { return !!this._source && this._saved?.has_saved_draft === false; }
  _status(message, error = false) { this.$('status').textContent = message; this.$('status').classList.toggle('error', error); }
  _publicationIssue() {
    const floors = Array.isArray(this._project?.floors) ? this._project.floors : [];
    if (!floors.length) return 'Add a floor and draw your first room before publishing.';
    const empty = floors.find(floor => !Array.isArray(floor.rooms) || !floor.rooms.length);
    return empty ? `Add a room to “${boundedText(empty.name || empty.id, 120)}” before publishing, or remove that unused floor.` : '';
  }
  _drawingStatus() {
    // Snapshots may arrive after an operation's disconnect error. Keep their
    // normal draft guidance truthful while server actions are unavailable.
    if (!this._online()) {
      const field = this._edits.invalid ? `Correct ${this._edits.field || 'the highlighted field'}. `
        : this._edits.pending ? 'Your unfinished field edits are still here. ' : '';
      this._status(`Home Assistant is disconnected. ${field}Keep this tab open to continue editing. More options → Export drawing (JSON) keeps a copy of the last valid drawing.`, this._edits.invalid);
      return;
    }
    if (this._edits.invalid) this._status(`Correct ${this._edits.field || 'the highlighted field'} before saving or publishing. Save draft will take you to the field.`, true);
    else if (this._edits.pending) this._status('Unsaved field edits · Save draft applies and saves your entered values.');
    else if (this._requiresInitialSave() && !this._dirty()) this._status('Save draft to create a private draft in Home Assistant. Your published home stays unchanged.');
    else if (!this._savedRaw && !this._dirty()) this._status(this._hasPublishedHome() ? 'Start with one room below. Your published home stays unchanged until you publish.' : 'Start with one room below. Nothing has been published yet.');
    else this._status(this._dirty() ? 'Unsaved changes · Save draft keeps them in Home Assistant.' : this._publicationIssue() || (this._publishedRevision === this._revision ? 'Draft saved · 3D Home is up to date.' : 'Draft saved · Publish to 3D Home when you are ready.'));
  }
  _buttons() {
    const disabled = !this._ready || this._busy || this._showingPublished;
    const networkDisabled = disabled || !this._online() || this._exportBusy;
    const floors = Array.isArray(this._project?.floors) ? this._project.floors : [];
    const rooms = floors.reduce((count, floor) => count + (floor.rooms?.length || 0), 0);
    const issue = this._publicationIssue();
    const needsSave = this._unsaved() || this._requiresInitialSave();
    this.$('save').disabled = networkDisabled || !needsSave;
    this.$('publish').disabled = networkDisabled || needsSave || !this._savedRaw || !!issue;
    this.$('model-export').disabled = networkDisabled || !rooms;
    this.$('model-export-download').disabled = networkDisabled || !rooms;
    this.$('model-export-floor').disabled = this._exportBusy;
    this.$('model-export-format').disabled = this._exportBusy;
    this.$('publish').classList.toggle('primary', !this.$('publish').disabled && this._publishedRevision !== this._revision);
    this.$('save').classList.toggle('primary', needsSave);
    this.$('export').disabled = !this._project || (this._busy && this._online());
    this.$('reload').disabled = networkDisabled;
    this.$('site-frame').hidden = this._saved?.capabilities?.site_frame_calibration !== true;
    this.$('site-frame').disabled = networkDisabled || needsSave || !this._savedRaw;
    this.$('site-frame-apply').disabled = networkDisabled || !this._siteFramePreview || needsSave;
    this.$('site-frame-cancel').disabled = this._busy;
    this.$('retry').disabled = !this._online();
    // Unknown publication state must not block access to an existing live home.
    const unpublished = !!this._saved && !this._hasPublishedHome();
    this.$('family').setAttribute('aria-disabled', String(unpublished));
    this.$('family').title = unpublished ? 'Publish your first room to open the live plan' : 'Open the published plan and device controls';
    this.$('guide-room').disabled = disabled;
    const roomLabel = rooms ? 'Add another room' : 'Add your first room';
    // A field can commit between pointerdown and click. Replacing this label
    // then cancels the pending click in WebKit, even if its text is unchanged.
    if (this.$('guide-room').textContent !== roomLabel) this.$('guide-room').textContent = roomLabel;
    this.$('guide-devices').disabled = disabled || !rooms;
    this.$('guide-preview').disabled = disabled || !rooms;
    this.$('guide-photos').hidden = this._saved?.capabilities?.ai !== true;
    this.$('guide-photos').disabled = networkDisabled;
    this.$('step-room').dataset.current = String(!rooms);
    this.$('step-publish').dataset.current = String(!!rooms);
    this.$('next-step').textContent = !rooms ? 'Start with one room. Add the rest of your home whenever you are ready.'
      : issue || (needsSave ? this._source ? 'Next: Save draft, then publish when you are ready. Your installed home stays unchanged until you publish.' : 'Next: preview your room, then Save draft. Devices and furniture can be added later.'
      : this._publishedRevision !== this._revision ? 'Next: Publish to 3D Home. Your saved draft will become the live plan.'
      : 'Your plan is ready. Open 3D Home to use it, or keep editing here and publish again later.');
  }
  _guideAction(action) {
    if (!this._ready || this._busy || !['room', 'devices', 'preview', 'photos'].includes(action)) return;
    if (action === 'preview' && this._source) { void this._showPublishedHome(); return; }
    this._send('guide-action', { action });
    this._frame?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }
  async _showPublishedHome() {
    if (!this._ready || this._busy || !this._source || !this._hasPublishedHome() || this._showingPublished) return;
    const generation = this._generation;
    this._showingPublished = true; this._buttons();
    try {
      // Generated drawings use the published renderer on demand. Their editor
      // stays in 2D, so this is the only active WebGL context.
      await import(new URL('./panel.js', import.meta.url));
      if (generation !== this._generation || !this.isConnected || !this._showingPublished) return;
      const panel = document.createElement('home-floorplan-panel');
      panel.configureDashboard({ editLocked: true, dryRun: true });
      this._publishedPanel = panel;
      this._frame.hidden = true; this.$('guide').hidden = true; this.$('published-view').hidden = false;
      this.$('published-canvas').append(panel); panel.hass = this._hass;
      this.$('back-to-editor').focus(); this.$('published-view').scrollIntoView({ block: 'start' });
    } catch {
      if (generation === this._generation) { this._closePublishedHome(false); this._status('Could not open the published home. Your drawing is still available. Try again.', true); }
    }
  }
  _closePublishedHome(focus = true) {
    this._showingPublished = false;
    this._publishedPanel?.remove(); this._publishedPanel = null;
    this.$('published-view').hidden = true;
    if (this._frame) this._frame.hidden = false;
    this.$('guide').hidden = !this._ready;
    this._buttons();
    if (focus && this._ready) { this.$('guide-preview').focus(); this._drawingStatus(); }
  }
  async _openFamily() {
    if (!this._ready || this._busy) return;
    const generation = this._generation;
    let navigate = false, focusSave = false;
    this._busy = true; this._buttons();
    try {
      // Read current field state without applying unfinished values. A field's
      // latest message may still be crossing the sandbox boundary on click.
      await this._snapshot(true, false);
      if (generation !== this._generation) return;
      if (this._edits.pending) {
        this._closePublishedHome(false);
        this._status('Finish the highlighted field, then Save draft before opening 3D Home. Your entered text is still here.', true);
        this._send('guide-action', { action: 'focus-edit' });
        this._frame?.scrollIntoView({ block: 'nearest' });
      } else if (this._dirty()) {
        this._closePublishedHome(false);
        this._status('Save draft before opening 3D Home. Your changes are kept in this tab.');
        focusSave = true;
      } else navigate = true;
    } catch (error) {
      if (generation === this._generation) this._status(error.message || 'Could not check your edits. Keep this tab open and try again.', true);
    } finally {
      if (generation === this._generation) {
        this._busy = false; this._buttons();
        if (focusSave) this.$('save').focus();
        if (navigate) location.assign(this.$('family').href);
      }
    }
  }
  _clearStartup() { clearTimeout(this._startupTimer); this._startupTimer = null; }
  _clearEditorNavigation() {
    clearTimeout(this._editorNavigationTimer); this._editorNavigationTimer = null;
    clearTimeout(this._editorFetchTimer); this._editorFetchTimer = null;
    this._editorFetchController?.abort(); this._editorFetchController = null;
  }
  async _fallbackEditor(frame, channel, generation) {
    this._editorNavigationTimer = null;
    const current = () => this.isConnected && this._frame === frame && this._channel === channel &&
      this._generation === generation && !this._editorLoading && !this._ready;
    if (!current()) return;
    const controller = new AbortController(); this._editorFetchController = controller;
    let timedOut = false, stage = 'fetch';
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, EDITOR_FETCH_TIMEOUT_MS);
    this._editorFetchTimer = timer;
    try {
      // The parent fetch carries only this origin's normal cookies. Only this
      // fixed bundled HTML is loaded; no HA token enters the sandbox.
      const url = new URL(EDITOR_PATH, location.origin);
      // Manual redirects are never followed and can be reported separately
      // from a network failure without exposing their destination.
      const response = await fetch(url, { credentials: 'same-origin', redirect: 'manual', cache: 'no-store', signal: controller.signal });
      stage = 'document';
      const html = await editorDocument(response, url, channel);
      stage = 'open';
      if (current() && !controller.signal.aborted) frame.srcdoc = html;
    } catch (error) {
      if (current() && (timedOut || !controller.signal.aborted)) {
        const code = timedOut ? 'timeout' : Object.hasOwn(EDITOR_LOAD_MESSAGES, error?.editorCode) ? error.editorCode : stage;
        const status = code === 'http' && Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? `-${error.status}` : '';
        // Keep the fixed diagnostic visible instead of replacing it with the
        // generic slow-start warning. Never display raw exception/response data.
        this._clearStartup();
        this._startupFailed = true; this.$('retry').hidden = false;
        this._status(`${EDITOR_LOAD_MESSAGES[code]} (editor-${code}${status}). ${editorLoadHelp(code, error?.status)}`, true); this._buttons();
      }
    } finally {
      controller.abort(); // Stop any unread body after a header/validation rejection.
      clearTimeout(timer); if (this._editorFetchTimer === timer) this._editorFetchTimer = null;
      if (this._editorFetchController === controller) this._editorFetchController = null;
    }
  }
  _watchStartup(message) {
    this._clearStartup();
    this._startupTimer = setTimeout(() => {
      this._startupTimer = null;
      // Cold HA startup can outlast this warning. Keep the request and iframe
      // alive so a late response can finish without losing its initialized state.
      this._startupFailed = true;
      if (!this._project && this._recovery) { this._project = clone(this._recovery.project); this._revision = this._recovery.revision; }
      this.$('retry').hidden = !this._hass?.user?.is_admin;
      this._status(message); this._buttons();
    }, STARTUP_TIMEOUT_MS);
  }
  _failStartup(message, allowRetry = true, error = true) {
    this._disposeAi();
    this._clearStartup(); this._clearEditorNavigation(); this._generation++; this._startupFailed = allowRetry; this._ready = false; this._busy = false;
    this._frame?.remove(); this._frame = null; this._channel = null;
    // A connection failure must not hide a recovery copy already in this tab.
    if (!this._project && this._recovery) { this._project = clone(this._recovery.project); this._revision = this._recovery.revision; }
    this.$('loading').hidden = true; this.$('retry').hidden = !allowRetry || !this._hass?.user?.is_admin;
    this._status(`${message}${this._project ? ' More options → Export drawing (JSON) is available for your preserved drawing.' : ''}`, error); this._buttons();
  }
  _retryStartup() {
    if (!this._startupFailed || !this.isConnected || !this._online()) return;
    this._startupFailed = false;
    if (this._saved && this._catalog) this._openEditor(this._project);
    else { this._started = false; void this._start(); }
  }
  _persist() {
    // Before initialization the displayed/exportable source may be an unresolved
    // recovery copy, while _revision already describes a newer server draft.
    if (!this._project || !this._ready) return;
    try {
      if (this._dirty()) sessionStorage.setItem(this._key(), JSON.stringify({ project: this._project, revision: this._revision }));
      else sessionStorage.removeItem(this._key());
    } catch { this._status('Tab recovery is unavailable. Use More options → Export drawing (JSON) before leaving; you can still save to Home Assistant.', true); }
  }
  _readRecovery() {
    try {
      const raw = sessionStorage.getItem(this._key());
      if (!raw || new Blob([raw]).size > MAX_PROJECT_BYTES + 100) return null;
      const value = JSON.parse(raw); projectBytes(value.project);
      return Number.isInteger(value.revision) && value.revision >= 0 ? value : null;
    } catch { return null; }
  }
  async _start() {
    if (!this.isConnected || !this._online()) return;
    this._started = true; this.$('retry').hidden = true; const generation = ++this._generation;
    try {
      if (!this._hass.user?.is_admin) throw new Error('An administrator account is required to edit this home.');
      this._recovery = this._readRecovery();
      this._watchStartup('Home Assistant is taking longer than expected. You can keep waiting or retry.');
      const [saved, catalog] = await Promise.all([this._hass.callWS({ type: 'home_floorplan/project_get' }), this._hass.callWS({ type: 'home_floorplan/entity_catalog' })]);
      if (generation !== this._generation || !this.isConnected) return;
      this._clearStartup(); this._startupFailed = false; this.$('retry').hidden = true;
      this._saved = saved; this._revision = saved.revision; this._publishedRevision = saved.published_revision;
      // The live home may still use generated assets while a local drawing is
      // editable. Only the server's authoring capability controls this editor.
      if (saved.capabilities?.authoring !== true) {
        this._failStartup(boundedText(saved.source_error, 500) || 'The drawing source for this home is unavailable. Restore its editable source to use Home Studio. You can still open the installed home in 3D Home.', false);
        return;
      }
      if (saved.can_edit === false) { this._failStartup('Editing is unavailable for this account. Open 3D Home to use the installed home.', false); return; }
      const url = new URL(saved.editor_url || EDITOR_PATH, location.origin);
      if (url.origin !== location.origin || url.pathname !== EDITOR_PATH || url.search || url.hash) throw new Error('Unexpected local editor address.');
      this._editorUrl = url; this._catalog = catalogForEditor(catalog);
      this._source = sourceForEditor(saved);
      this.$('guide-preview').textContent = this._source ? 'Published home' : 'Preview 3D';
      this.$('workflow-description').textContent = this._source ? 'Edit your home here. Save a draft, then publish it when you are ready to update 3D Home.' : 'Draw here. Save your draft, then publish it to use your home in 3D Home.';
      this.$('publish-help').textContent = this._source ? 'Use Save draft, then Publish to 3D Home above. Published home shows the current installed details; your draft changes appear there after you publish.' : 'Preview your drawing, then use Save draft and Publish to 3D Home above. Saving alone keeps the live plan unchanged.';
      this._savedRaw = saved.project ? projectBytes(saved.project) : null;
      this.$('guide').hidden = false; this.$('guide').open = !this._hasPublishedHome();
      this._recovery = this._readRecovery();
      if (this._recovery && JSON.stringify(this._recovery.project) !== this._savedRaw) {
        this.$('recovery').hidden = false; this.$('loading').hidden = true;
        this.$('recovery-description').textContent = this._recovery.revision === this._revision ? 'Resume your edits, or export them before using the Home Assistant copy.' : 'The Home Assistant copy has changed since these edits. Resume keeps both copies separate; saving will report a conflict until you load the current saved draft.';
        this._status('Choose which drawing to open. Your recovered work has not been replaced.'); this._buttons();
      } else this._openEditor(saved.project);
    } catch (error) { if (generation === this._generation) this._failStartup(error.message || 'Could not open Home Studio. Check the connection, then retry.'); }
  }
  _resolveRecovery(resume) {
    if (!resume && !window.confirm('Use the saved Home Assistant drawing? Export the recovered JSON first if you need that separate copy.')) return;
    this.$('recovery').hidden = true;
    if (resume) { this._revision = this._recovery.revision; this._openEditor(this._recovery.project); }
    else { try { sessionStorage.removeItem(this._key()); } catch {} this._openEditor(this._saved.project); }
  }
  _openEditor(project) {
    this._resetMapTransport();
    this._disposeAi(); this._aiSequence = 0;
    this._clearEditorNavigation(); this._editorLoading = false;
    this._ready = false; this._sequence = 0; this._edits = {}; this._startupFailed = false; this.$('retry').hidden = true;
    this._project = project ? clone(project) : null;
    this._pristineRaw = null; this._initializingBlank = !project && !this._savedRaw;
    this._channel = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
    this._frame?.remove();
    const frame = document.createElement('iframe'); this._frame = frame;
    frame.title = 'Home Studio drawing editor';
    frame.setAttribute('sandbox', 'allow-scripts allow-downloads allow-modals allow-forms');
    frame.referrerPolicy = 'no-referrer';
    const url = new URL(this._editorUrl); url.searchParams.set('embed', 'home-assistant'); url.hash = `ha-studio=${this._channel}`;
    frame.src = url.href; this.shadowRoot.append(frame); this.$('loading').hidden = true;
    const channel = this._channel, generation = this._generation;
    this._editorNavigationTimer = setTimeout(() => void this._fallbackEditor(frame, channel, generation), EDITOR_NAVIGATION_TIMEOUT_MS);
    this._watchStartup('The drawing tools are taking longer than expected. You can keep waiting or retry.');
    this._status('Opening the drawing tools…'); this._buttons();
  }
  _send(type, payload = {}) {
    // Opaque sandbox origins require *. The exact WindowProxy and random
    // channel are checked in both directions; no token is ever in this payload.
    this._frame?.contentWindow?.postMessage({ protocol: STUDIO_PROTOCOL, channel: this._channel, type, ...payload }, '*');
  }
  _onMessage(event) {
    const data = event.data;
    if (event.source !== this._frame?.contentWindow || event.origin !== 'null' || data?.protocol !== STUDIO_PROTOCOL || data.channel !== this._channel) return;
    if (this._mapTransport.handle(data)) {
      if (data.type === 'map-close') this.$('studio-map-credit').hidden = true;
      return;
    }
    if (data.type === 'loading' || data.type === 'ready') { this._editorLoading = true; this._clearEditorNavigation(); }
    if (data.type === 'ready' && !this._ready) {
      this._refreshTheme();
      this._send('initialize', { project: this._project, catalog: this._catalog, source: this._source, theme: this._theme,
        capabilities: { ai: this._saved?.capabilities?.ai === true, architecture_editing: !this._source } });
    }
    if (data.type === 'published-preview') { void this._showPublishedHome(); return; }
    if (data.type === 'ai-request') { void this._aiRequest(data); return; }
    if (data.type === 'ai-abort') { this._aiPending.get(data.requestId)?.controller.abort(); return; }
    if (data.type === 'ai-close') { this._disposeAi(); return; }
    if (data.type === 'error' && !this._ready) { this._failStartup('The drawing could not be opened. Retry or export the original JSON.'); return; }
    if (data.type === 'snapshot-error') {
      const pending = this._pending.get(data.requestId);
      if (pending) {
        clearTimeout(pending.timer); this._pending.delete(data.requestId);
        pending.reject(Object.assign(new Error(boundedText(data.message, 400) || 'Correct the highlighted field before saving or publishing.'), { code: 'invalid_fields' }));
      }
      return;
    }
    if (data.type !== 'snapshot' || !Number.isInteger(data.sequence) || data.sequence <= this._sequence) return;
    try {
      const raw = projectBytes(data.project);
      const initializing = !this._ready;
      if (this._initializingBlank) { this._pristineRaw = raw; this._initializingBlank = false; }
      this._sequence = data.sequence; this._project = clone(data.project); this._ready = true;
      this._currentFloor = typeof data.current_floor === 'string' && data.current_floor.length <= 128 &&
        this._project.floors?.some(floor => floor.id === data.current_floor) ? data.current_floor : null;
      // A HA theme change may arrive while the child's initialize is in flight.
      if (initializing && this._theme) this._send('theme', { theme: this._theme });
      this._clearStartup(); this._startupFailed = false; this.$('retry').hidden = true;
      this._edits = { pending: data.edits?.pending === true, invalid: data.edits?.invalid === true, field: boundedText(data.edits?.field) };
      this._persist(); this._buttons();
      if (!this._busy) this._drawingStatus();
      const pending = this._pending.get(data.requestId);
      if (pending) { clearTimeout(pending.timer); this._pending.delete(data.requestId); pending.resolve(clone(this._project)); }
    } catch { this._status('The editor returned an invalid drawing. Your saved copy is unchanged.', true); }
  }
  _resetMapTransport() {
    this._mapTransport.reset();
    this.$('studio-map-credit').hidden = true;
  }
  _disposeAi() {
    this._aiEpoch++;
    for (const entry of this._aiPending.values()) entry.controller.abort();
    this._aiPending.clear();
    const session = this._aiSession, hass = this._hass;
    this._aiSession = null; this._aiSessionPromise = null;
    if (session) this._cleanupAiSession(hass, session.token);
  }
  _cleanupAiSession(hass, token) {
    // Best effort on navigation; the HA service also expires abandoned sessions.
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    try {
      Promise.resolve(hass.fetchWithAuth('/api/home_floorplan/ai/close', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Home-Studio-Session': token },
        body: '{}', signal: controller.signal, keepalive: true,
      })).catch(() => {}).finally(() => clearTimeout(timer));
    } catch { clearTimeout(timer); }
  }
  async _readAiResponse(response) {
    if (Number(response.headers?.get('content-length')) > AI_RESPONSE_LIMIT) throw new Error('invalid_response');
    const raw = await response.text();
    if (new Blob([raw]).size > AI_RESPONSE_LIMIT) throw new Error('invalid_response');
    let result;
    try { result = JSON.parse(raw); } catch { throw new Error('invalid_response'); }
    if (!response.ok) throw Object.assign(new Error('AI service request failed'), {
      code: /^[a-z_]{1,60}$/.test(result?.error?.code || '') ? result.error.code : 'request_failed', status: response.status,
      upstreamStatus: Number.isInteger(result?.error?.upstream_status) && result.error.upstream_status >= 300 && result.error.upstream_status <= 599 ? result.error.upstream_status : undefined,
    });
    return result;
  }
  async _ensureAiSession() {
    if (this._aiSession && this._aiSession.expires > Date.now()) return this._aiSession.token;
    if (this._aiSessionPromise) return this._aiSessionPromise;
    const hass = this._hass, epoch = this._aiEpoch;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    const attempt = (async () => {
      const response = await hass.fetchWithAuth('/api/home_floorplan/ai/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal,
      });
      const result = await this._readAiResponse(response);
      if (typeof result.session !== 'string' || result.session.length < 20 || result.session.length > 256 || !Number.isFinite(result.expires_at)) throw new Error('invalid_response');
      if (epoch !== this._aiEpoch) { this._cleanupAiSession(hass, result.session); throw new DOMException('Editor session changed', 'AbortError'); }
      this._aiSession = { token: result.session, expires: result.expires_at * 1000 };
      return result.session;
    })();
    this._aiSessionPromise = attempt;
    try { return await attempt; }
    finally { clearTimeout(timer); if (this._aiSessionPromise === attempt) this._aiSessionPromise = null; }
  }
  async _aiRequest(data) {
    const match = /^ai-([1-9][0-9]{0,9})$/.exec(data.requestId || '');
    if (!match || Number(match[1]) <= this._aiSequence || !this._ready || this._saved?.capabilities?.ai !== true || !this._hass?.user?.is_admin) return;
    this._aiSequence = Number(match[1]);
    const action = data.action, epoch = this._aiEpoch;
    const reply = payload => { if (epoch === this._aiEpoch) this._send('ai-response', { requestId: data.requestId, ...payload }); };
    let body, requestToken;
    try {
      if (!Object.hasOwn(AI_ACTIONS, action) || this._aiPending.size >= 8) throw new Error('invalid_request');
      const spec = AI_ACTIONS[action];
      if (!spec.fields) {
        if (data.body !== undefined) throw new Error('invalid_request');
      } else {
        if (!data.body || typeof data.body !== 'object' || Array.isArray(data.body) || Object.keys(data.body).some(key => !spec.fields.includes(key))) throw new Error('invalid_request');
        body = JSON.stringify(data.body);
        if (new Blob([body]).size > spec.limit) throw new Error('invalid_request');
      }
    } catch { reply({ error: { code: 'invalid_request', status: 400 } }); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), action === 'generate' ? 120000 : 20000);
    this._aiPending.set(data.requestId, { controller, action });
    try {
      const token = await this._ensureAiSession(); requestToken = token;
      if (epoch !== this._aiEpoch || controller.signal.aborted) throw new DOMException('AI request aborted', 'AbortError');
      const response = await this._hass.fetchWithAuth(`/api/home_floorplan/ai/${action}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'X-Home-Studio-Session': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body, signal: controller.signal,
      });
      body = undefined;
      const result = await this._readAiResponse(response);
      // No token or unexpected server metadata crosses into the untrusted child.
      const clean = action === 'generate' ? { draft: result.draft }
        : action === 'providers' ? { providers: Array.isArray(result.providers) ? result.providers.slice(0, 32).map(value => ({
          id: boundedText(value.id, 60), label: boundedText(value.label, 100), local: value.local === true,
          requires_key: value.requires_key === true, default_endpoint: boundedText(value.default_endpoint, 2048),
        })) : [] }
        : action === 'cancel' ? { cancelled: result.cancelled === true }
        : { connected: result.connected === true, expires_at: result.expires_at,
          provider: boundedText(result.provider, 60), model: boundedText(result.model, 200), endpoint: boundedText(result.endpoint, 2048), local: result.local === true };
      reply({ result: clean });
    } catch (error) {
      if (epoch === this._aiEpoch && this._aiSession?.token === requestToken && [401, 403, 410].includes(error.status)) this._aiSession = null;
      reply({ error: { code: error.name === 'AbortError' ? 'timeout' : error.code || 'request_failed', status: error.status || 503, upstreamStatus: error.upstreamStatus } });
    } finally {
      clearTimeout(timer); body = undefined;
      if (this._aiPending.get(data.requestId)?.controller === controller) this._aiPending.delete(data.requestId);
    }
  }
  _snapshot(allowInvalid = false, commit = true) {
    const requestId = String(++this._request);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._pending.delete(requestId); reject(new Error('The editor did not respond. Your saved copy is unchanged.')); }, 5000);
      this._pending.set(requestId, { resolve, reject, timer }); this._send('snapshot-request', { requestId, allowInvalid, commit });
    });
  }
  async _previewSiteFrame() {
    if (this.$('site-frame').disabled || this._saved?.capabilities?.site_frame_calibration !== true) return;
    const generation = this._generation, connectionEpoch = this._connectionEpoch;
    this._siteFramePreview = null; this._busy = true; this._buttons();
    try {
      await this._snapshot(true); if (generation !== this._generation) return;
      if (this._unsaved()) throw new Error('Save your latest edits before previewing calibration.');
      this._requireConnection(connectionEpoch);
      const result = await this._hass.callWS({ type: 'home_floorplan/site_frame_preview', revision: this._revision });
      if (generation !== this._generation) return;
      this._requireConnection(connectionEpoch);
      await this._snapshot(true); if (generation !== this._generation) return;
      if (this._unsaved() || result.revision !== this._revision) throw new Error('The drawing changed. Save it and preview calibration again.');
      if (typeof result.token !== 'string' || result.token.length > 128 || result.global_ground_m !== 0 ||
          !Array.isArray(result.floors) || result.floors.length !== this._project.floors.length ||
          result.floors.some((floor, index) => floor.id !== this._project.floors[index].id ||
            typeof floor.name !== 'string' || floor.name.length > 120 ||
            !['before_m', 'after_m', 'baseline_ground_m'].every(key => Number.isFinite(floor[key]) && Math.abs(floor[key]) <= 100))) {
        throw new Error('The calibration preview is invalid.');
      }
      this.$('site-frame-offsets').replaceChildren(...result.floors.map(floor => {
        const row = document.createElement('li'); row.textContent = `${floor.name}: ${floor.before_m} m → ${floor.after_m} m (original ground ${floor.baseline_ground_m} m)`; return row;
      }));
      this._siteFramePreview = result; this.$('site-frame-dialog').showModal();
      this._status('Review the floor offsets. Nothing has been changed.');
    } catch (error) { if (generation === this._generation) this._status(error.message || 'Could not prepare calibration.', true); }
    finally { if (generation === this._generation) { this._busy = false; this._buttons(); } }
  }
  async _applySiteFrame() {
    if (this.$('site-frame-apply').disabled || !this._siteFramePreview) return;
    const preview = this._siteFramePreview, generation = this._generation, connectionEpoch = this._connectionEpoch;
    this._busy = true; this._buttons();
    try {
      await this._snapshot(true); if (generation !== this._generation) return;
      if (this._unsaved() || preview.revision !== this._revision) throw new Error('The drawing changed. Save it and preview calibration again.');
      this._requireConnection(connectionEpoch);
      const saved = await this._hass.callWS({ type: 'home_floorplan/site_frame_apply', revision: preview.revision, token: preview.token });
      if (generation !== this._generation) return;
      this._requireConnection(connectionEpoch);
      this._revision = saved.revision; this._publishedRevision = saved.published_revision;
      this._saved = saved; this._savedRaw = projectBytes(saved.project); this._source = sourceForEditor(saved);
      this.$('site-frame-dialog').close(); this._openEditor(saved.project); this._persist();
      this._status('Floor offsets saved with a recovery copy. Review the site, then publish when ready.');
    } catch (error) {
      if (generation === this._generation) { this._siteFramePreview = null; this.$('site-frame-dialog').close(); this._status(`Calibration was not confirmed: ${error.message || 'connection failed'}. Load saved draft before retrying.`, true); }
    } finally { if (generation === this._generation) { this._busy = false; this._buttons(); } }
  }
  async _save() {
    if (this._busy || this._exportBusy || !this._ready || !this._online()) return;
    const generation = this._generation, connectionEpoch = this._connectionEpoch;
    this._busy = true; this._buttons(); this._status('Saving draft…');
    try {
      const project = await this._snapshot(); if (generation !== this._generation) return; const raw = projectBytes(project);
      this._requireConnection(connectionEpoch);
      const saved = await this._hass.callWS({ type: 'home_floorplan/project_save', revision: this._revision, project });
      if (generation !== this._generation) return;
      this._revision = saved.revision; this._publishedRevision = saved.published_revision; this._savedRaw = raw;
      this._saved = { ...this._saved, ...saved };
      this._persist(); this._status(this._unsaved() ? 'Draft saved. Newer edits remain unsaved; save again when ready.' : this._publicationIssue() || 'Draft saved in Home Assistant. Next: Publish to 3D Home.');
    } catch (error) { if (generation !== this._generation) return; this._status(error.code === 'invalid_fields' ? error.message : error.code === 'conflict' ? 'Another session changed the saved draft. Your edits are safe in this tab. Use More options to export your drawing (JSON), then Load saved draft to review the current copy.' : `Save failed: ${error.message || 'check your Home Assistant connection'}. Your edits remain in this tab.`, true); }
    finally { if (generation === this._generation) { this._busy = false; this._buttons(); } }
  }
  async _publish() {
    if (this._busy || this._exportBusy || !this._ready || this._dirty() || !this._online()) return;
    if (this._requiresInitialSave()) { this._status('Save draft to create a private draft in Home Assistant before publishing.'); return; }
    if (this._publicationIssue()) { this._status(this._publicationIssue(), true); return; }
    const generation = this._generation, connectionEpoch = this._connectionEpoch;
    this._busy = true; this._buttons();
    try {
      await this._snapshot(); if (generation !== this._generation) return;
      if (this._dirty() || !this._savedRaw || this._requiresInitialSave()) { this._status('Save your latest edits before publishing.'); return; }
      if (this._publicationIssue()) { this._status(this._publicationIssue(), true); return; }
      this._requireConnection(connectionEpoch);
      this._status('Building and publishing the saved drawing…');
      const saved = await this._hass.callWS({ type: 'home_floorplan/project_publish', revision: this._revision });
      if (generation !== this._generation) return;
      this._publishedRevision = saved.published_revision;
      this._status(this._unsaved() ? 'Published the saved drawing. Newer edits remain unsaved; save and publish again when ready.' : 'Published. Open 3D Home to use your home.');
    } catch (error) { if (generation !== this._generation) return; this._status(error.code === 'invalid_fields' ? error.message : error.code === 'conflict' ? 'The saved draft changed in another session. Load saved draft before publishing.' : `Publish failed: ${error.message || 'check the drawing and connection'}. Your draft is still available.`, true); }
    finally { if (generation === this._generation) { this._busy = false; this._buttons(); } }
  }
  async _reload() {
    if (this._busy || this._exportBusy || !this._ready || !this._online()) return;
    const generation = this._generation, connectionEpoch = this._connectionEpoch;
    this._busy = true; this._buttons();
    try {
      await this._snapshot(true); if (generation !== this._generation) return;
      if (this._unsaved() && !window.confirm('Replace this tab’s edits, including any unfinished field text, with the current saved draft? Export your drawing (JSON) from More options first to keep a separate copy of the last valid drawing.')) return;
      const sequence = this._sequence;
      this._requireConnection(connectionEpoch);
      const saved = await this._hass.callWS({ type: 'home_floorplan/project_get' });
      if (generation !== this._generation) return;
      this._requireConnection(connectionEpoch);
      // Flush the editor after the network wait as well: an edit's message can
      // still be crossing the sandbox boundary when the HA response arrives.
      await this._snapshot(true); if (generation !== this._generation) return;
      this._requireConnection(connectionEpoch);
      // The requested snapshot advances the sequence once even without changes.
      if (this._sequence !== sequence + 1) {
        this._persist();
        this._status('Reload cancelled because you edited the drawing while it was loading. Your edits are kept in this tab. Save or export them, then load the saved draft again.');
        return;
      }
      this._revision = saved.revision; this._publishedRevision = saved.published_revision; this._savedRaw = saved.project ? projectBytes(saved.project) : null;
      this._saved = saved; this._source = sourceForEditor(saved); this._openEditor(saved.project); this._persist();
    } catch (error) { if (generation !== this._generation) return; this._status(`Could not load the saved draft: ${error.message || 'check the connection'}`, true); }
    finally { if (generation === this._generation) { this._busy = false; this._buttons(); } }
  }
  _downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = name; this.shadowRoot.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  _download(project, name = 'project.json') {
    this._downloadBlob(new Blob([projectBytes(project)], { type: 'application/json' }), name);
  }
  _modelExportStatus(message, error = false) {
    this.$('model-export-status').textContent = message;
    this.$('model-export-status').classList.toggle('error', error);
  }
  async _openModelExport() {
    if (this._busy || this._exportBusy || !this._ready || !this._online()) return;
    const generation = this._generation, connectionEpoch = this._connectionEpoch;
    this._busy = true; this._buttons();
    try {
      // Read the selected floor without committing unfinished input. The export
      // itself requests a fresh, valid snapshot before sending anything to HA.
      await this._snapshot(true, false);
      if (generation !== this._generation) return;
      this._requireConnection(connectionEpoch);
      const select = this.$('model-export-floor');
      select.replaceChildren(new Option('All floors', ''));
      for (const floor of this._project.floors || []) {
        select.append(new Option(`${floor.id === this._currentFloor ? 'Current floor · ' : ''}${floor.name || floor.id}`, floor.id));
      }
      select.value = this._currentFloor || this._project.floors?.[0]?.id || '';
      this._modelExportStatus('Choose the floors and format to download.');
      this.$('model-export-dialog').showModal(); select.focus();
    } catch (error) { if (generation === this._generation) this._status(error.message || 'Could not open the export options. Your drawing is unchanged.', true); }
    finally { if (generation === this._generation) { this._busy = false; this._buttons(); } }
  }
  async _exportModel() {
    if (this._busy || this._exportBusy || !this._ready || !this._online()) return;
    const generation = this._generation, sequence = ++this._exportSequence, connectionEpoch = this._connectionEpoch;
    const floor = this.$('model-export-floor').value || null, format = this.$('model-export-format').value;
    if (!['glb', 'obj'].includes(format)) return;
    const current = () => generation === this._generation && sequence === this._exportSequence;
    this._exportBusy = true; this._buttons(); this._modelExportStatus('Preparing your model… You can close this dialog and keep drawing.');
    let timer;
    try {
      const project = await this._snapshot();
      if (!current()) return;
      this._requireConnection(connectionEpoch);
      if (floor !== null && !project.floors.some(value => value.id === floor)) throw new Error('That floor is no longer in the drawing. Close this dialog and choose the floors again.');
      const cancelled = new Promise((_, reject) => {
        this._cancelExport = reject;
        timer = setTimeout(() => reject(new Error('The export timed out. Nothing was downloaded. Your drawing is still available; try again.')), MODEL_EXPORT_TIMEOUT_MS);
      });
      const result = await Promise.race([this._hass.callWS({ type: 'home_floorplan/export_model', revision: this._revision, project, floor, format }), cancelled]);
      if (!current()) return;
      this._requireConnection(connectionEpoch);
      const file = modelExportFile(result, format);
      this._downloadBlob(file.blob, file.filename);
      this._modelExportStatus(`Downloaded ${file.filename}. Changes made while preparing it are not included. Your draft has not been saved or published.`);
      if (!this.$('model-export-dialog').open) this._status(`Downloaded ${file.filename}. Your draft has not been saved or published.`);
    } catch (error) {
      if (!current()) return;
      const message = error.code === 'conflict' ? 'The saved draft changed in another session. Export your drawing as JSON before loading the current saved draft, then try again.'
        : error.code === 'unknown_command' ? 'This Home Assistant installation does not support model export yet. Update the complete Home Studio integration.'
        : boundedText(error.message, 400) || 'The model could not be exported. Check the drawing and connection, then try again.';
      this._modelExportStatus(`Export failed: ${message} Your drawing remains in this tab.`, true);
      if (!this.$('model-export-dialog').open) this._status(`Export failed: ${message} Your drawing remains in this tab.`, true);
      if (error.code === 'invalid_fields') { this.$('model-export-dialog').close(); this._status(message, true); }
    } finally {
      clearTimeout(timer);
      if (current()) { this._cancelExport = null; this._exportBusy = false; this._buttons(); }
    }
  }
  async _exportCurrent() {
    const generation = this._generation;
    try {
      const project = this._ready ? await this._snapshot(true) : this._project;
      if (generation === this._generation) {
        this._download(project);
        this._status(this._edits.pending ? 'Exported the last valid drawing. Unfinished or invalid field text is not included; keep this tab open to correct it.' : 'Exported project.json. Keep it as a portable backup.', this._edits.pending);
      }
    }
    catch (error) { if (generation === this._generation) this._status(error.message, true); }
  }
}
if (!customElements.get('home-floorplan-studio-panel')) customElements.define('home-floorplan-studio-panel', HomeFloorplanStudioPanel);
