/* Trusted Home Assistant authoring host. Credentials never enter the editor. */
const STUDIO_PROTOCOL = 'home-studio-editor-v1';
const MAX_PROJECT_BYTES = 2000000;
const STARTUP_TIMEOUT_MS = 15000;
const EDITOR_PATH = '/home-floorplan-studio/planner/index.html';
const EXTERNAL_EDITOR = 'https://ha-homelab.github.io/home-studio/planner/';
const clone = value => JSON.parse(JSON.stringify(value));
const boundedText = (value, max = 128) => typeof value === 'string' ? value.slice(0, max) : '';
function projectBytes(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) throw new Error('Invalid drawing');
  const raw = JSON.stringify(project);
  if (new Blob([raw]).size > MAX_PROJECT_BYTES) throw new Error('Drawing exceeds the 2 MB limit');
  return raw;
}
function catalogForEditor(catalog = {}) {
  // Copy an explicit allowlist. State attributes, integration settings, registry
  // internals, and the authenticated hass object are never forwarded.
  const list = key => Array.isArray(catalog[key]) ? catalog[key].slice(0, 10000) : [];
  const floors = list('floors').map(item => ({ id: boundedText(item.id), name: boundedText(item.name, 120) }));
  const areas = list('areas').map(item => ({ id: boundedText(item.id), name: boundedText(item.name, 120), floor_id: boundedText(item.floor_id) }));
  const entities = list('entities').filter(item => /^[a-z_]+\.[a-z0-9_]+$/.test(item.entity_id || '') && !item.disabled).map(item => ({
    entity_id: boundedText(item.entity_id, 255), name: boundedText(item.name || item.entity_id, 100), domain: boundedText(item.domain, 40),
    area_id: boundedText(item.area_id), disabled: false, available: item.available !== false,
  }));
  return { floors, areas, entities };
}
class HomeFloorplanStudioPanel extends HTMLElement {
  constructor() {
    super(); this.attachShadow({ mode: 'open' });
    this._busy = false; this._ready = false; this._started = false; this._project = null;
    this._savedRaw = null; this._revision = 0; this._publishedRevision = null;
    this._pending = new Map(); this._sequence = 0; this._request = 0; this._generation = 0;
    this._edits = {}; this._startupTimer = null; this._startupFailed = false;
    this._receive = event => this._onMessage(event);
    this._beforeUnload = event => { if (this._unsaved() || this._busy) { event.preventDefault(); event.returnValue = ''; } };
    this.shadowRoot.innerHTML = `
      <style>
      :host{display:flex;flex-direction:column;height:100%;min-height:640px;color:var(--primary-text-color,#263737);background:var(--primary-background-color,#f7f8f5);font:14px system-ui,sans-serif}
      *{box-sizing:border-box}header{padding:16px 22px 12px;border-bottom:1px solid var(--divider-color,#d9e0d9)}h1{font-size:22px;margin:0 0 5px}p{line-height:1.5;margin:6px 0}.muted{color:var(--secondary-text-color,#5b6d67);font-size:13px}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.actions{margin:12px 0 8px}button,a{font:inherit}button{min-height:44px;padding:9px 14px;border:1px solid var(--divider-color,#becbc2);border-radius:7px;background:var(--card-background-color,#fff);color:inherit;cursor:pointer}button.primary{background:#326857;color:white;border-color:#326857}button:disabled{opacity:.5;cursor:default}a{color:var(--primary-color,#326857);text-underline-offset:3px}a.external{margin-inline-start:auto}button:focus-visible,a:focus-visible{outline:3px solid #ce8c52;outline-offset:3px}#status{min-height:22px;overflow-wrap:anywhere}#status.error{color:var(--error-color,#a53d29)}#recovery{padding:14px 22px;background:#fff0d5;color:#4c402c;border-bottom:1px solid #e2c996}iframe{display:block;flex:1;width:100%;border:0;min-height:600px;background:#f6f6f1}#loading{padding:24px}[hidden]{display:none!important}details{font-size:13px;margin:8px 0}summary{cursor:pointer}details p{max-width:900px} @media(max-width:600px){header{padding:12px}.actions{gap:6px}.actions button{padding:8px 10px;font-size:12px}a.external{margin-inline-start:0}iframe{min-height:780px}}
      </style>
      <header>
        <div class="row"><button id="menu" aria-label="Open navigation menu">☰</button><h1>Home Studio</h1><a id="family" href="/home-floorplan">Open family view</a></div>
        <p class="muted">Draw your home, link its areas and devices, then publish the family view.</p>
        <div class="row actions">
          <button id="save" class="primary" aria-describedby="status" disabled>Save draft</button>
          <button id="publish" aria-describedby="status" disabled>Publish family view</button>
          <button id="export" disabled>Export JSON</button>
          <button id="reload" disabled>Load saved draft</button>
          <a class="external" href="${EXTERNAL_EDITOR}" target="_blank" rel="noopener noreferrer">Open browser editor ↗</a>
        </div>
        <div id="status" role="status" aria-live="polite" aria-atomic="true">Opening your drawing…</div><button id="retry" aria-describedby="status" hidden>Retry connection</button>
        <details><summary>Two ways to design your home</summary><p>Here, use your Home Assistant areas and devices while drawing. Save draft keeps the editable project in Home Assistant; Publish family view updates the runnable plan. Draft changes stay separate until you publish.</p><p>The browser editor also works independently, including its offline and optional AI workflows. Export JSON here, then open it there, or use Open JSON below to bring a drawing back. Opening the browser editor never sends it your drawing or Home Assistant access.</p><p>Accepted drawing changes are kept in this browser tab, separately from standalone editor drafts. Correct unfinished or invalid fields before leaving. Export JSON for a portable backup of the last valid drawing. The drawing tools do not operate devices.</p></details>
      </header>
      <section id="recovery" hidden><strong>Unsaved drawing found in this tab</strong><p id="recovery-description"></p><div class="row"><button id="resume">Resume recovered drawing</button><button id="download-recovery">Export recovered JSON</button><button id="discard">Use saved drawing</button></div></section>
      <p id="loading">Loading the local editor…</p>`;
    this.$('menu').onclick = () => this.dispatchEvent(new Event('hass-toggle-menu', { bubbles: true, composed: true }));
    this.$('retry').onclick = () => this._retryStartup();
    this.$('save').onclick = () => this._save();
    this.$('publish').onclick = () => this._publish();
    this.$('export').onclick = () => this._exportCurrent();
    this.$('reload').onclick = () => this._reload();
    this.$('resume').onclick = () => this._resolveRecovery(true);
    this.$('discard').onclick = () => this._resolveRecovery(false);
    this.$('download-recovery').onclick = () => this._download(this._recovery.project, 'recovered-project.json');
  }
  $(id) { return this.shadowRoot.getElementById(id); }
  set hass(value) {
    const identity = `${value?.user?.id || ''}:${value?.user?.is_admin === true}`;
    if (this._identity !== undefined && this._identity !== identity) this._reset();
    this._identity = identity; this._hass = value;
    if (this.isConnected && !this._started && value) void this._start();
  }
  _reset() {
    this._clearStartup(); this._startupFailed = false; this._edits = {};
    this._generation++; this._started = false; this._ready = false; this._busy = false;
    this._project = null; this._savedRaw = null; this._catalog = null; this._recovery = null; this._saved = null; this._channel = null;
    this._frame?.remove(); this._frame = null;
    for (const { reject, timer } of this._pending.values()) { clearTimeout(timer); reject(new Error('Editor session changed')); }
    this._pending.clear(); this.$('recovery').hidden = true; this.$('retry').hidden = true; this._buttons();
  }
  connectedCallback() {
    window.addEventListener('message', this._receive); window.addEventListener('beforeunload', this._beforeUnload);
    if (this._hass && !this._started) void this._start();
  }
  disconnectedCallback() {
    this._persist(); window.removeEventListener('message', this._receive); window.removeEventListener('beforeunload', this._beforeUnload);
    this._reset();
  }
  _key() { return `home-studio.ha-tab-draft.v1:${this._hass?.user?.id || 'unknown'}`; }
  _dirty() { return !!this._project && JSON.stringify(this._project) !== this._savedRaw; }
  _unsaved() { return this._dirty() || this._edits.pending === true; }
  _status(message, error = false) { this.$('status').textContent = message; this.$('status').classList.toggle('error', error); }
  _drawingStatus() {
    if (this._edits.invalid) this._status(`Correct ${this._edits.field || 'the highlighted field'} before saving or publishing. Save draft will take you to the field.`, true);
    else if (this._edits.pending) this._status('Unsaved field edits · Save draft applies and saves your entered values.');
    else this._status(this._dirty() ? 'Unsaved changes · save draft to keep them in Home Assistant.' : `Draft saved · revision ${this._revision}${this._publishedRevision === this._revision ? ' · family view is current.' : ' · publish when ready.'}`);
  }
  _buttons() {
    const disabled = !this._ready || this._busy;
    this.$('save').disabled = disabled || !this._unsaved();
    this.$('publish').disabled = disabled || this._unsaved() || !this._savedRaw;
    this.$('export').disabled = !this._project || this._busy;
    this.$('reload').disabled = disabled;
  }
  _clearStartup() { clearTimeout(this._startupTimer); this._startupTimer = null; }
  _watchStartup(message) {
    this._clearStartup();
    this._startupTimer = setTimeout(() => this._failStartup(message), STARTUP_TIMEOUT_MS);
  }
  _failStartup(message, allowRetry = true, error = true) {
    this._clearStartup(); this._generation++; this._startupFailed = allowRetry; this._ready = false; this._busy = false;
    this._frame?.remove(); this._frame = null; this._channel = null;
    // A connection failure must not hide a recovery copy already in this tab.
    if (!this._project && this._recovery) { this._project = clone(this._recovery.project); this._revision = this._recovery.revision; }
    this.$('loading').hidden = true; this.$('retry').hidden = !allowRetry || !this._hass?.user?.is_admin;
    this._status(`${message}${this._project ? ' Export JSON is available for your preserved drawing.' : ''}`, error); this._buttons();
  }
  _retryStartup() {
    if (!this._startupFailed || !this.isConnected) return;
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
    } catch { this._status('Tab recovery is unavailable. Export JSON before leaving; you can still save to Home Assistant.', true); }
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
    if (!this.isConnected || !this._hass) return;
    this._started = true; this.$('retry').hidden = true; const generation = ++this._generation;
    try {
      if (!this._hass.user?.is_admin) throw new Error('An administrator account is required to edit this home.');
      this._recovery = this._readRecovery();
      this._watchStartup('Home Assistant did not respond. Check the connection, then retry.');
      const [saved, catalog] = await Promise.all([this._hass.callWS({ type: 'home_floorplan/project_get' }), this._hass.callWS({ type: 'home_floorplan/entity_catalog' })]);
      if (generation !== this._generation || !this.isConnected) return;
      this._clearStartup();
      if (saved.mode === 'legacy' || saved.capabilities?.authoring === false) {
        this._failStartup('This installation uses a generated home. Open the browser editor with your original project JSON, then use your existing build and installation workflow. Open family view to use the installed home.', false, false);
        return;
      }
      if (saved.can_edit === false) { this._failStartup('Editing is unavailable for this account. Open family view to use the installed home.', false); return; }
      const url = new URL(saved.editor_url || EDITOR_PATH, location.origin);
      if (url.origin !== location.origin || url.pathname !== EDITOR_PATH || url.search || url.hash) throw new Error('Unexpected local editor address.');
      this._editorUrl = url; this._catalog = catalogForEditor(catalog); this._saved = saved;
      this._revision = saved.revision; this._publishedRevision = saved.published_revision;
      this._savedRaw = saved.project ? projectBytes(saved.project) : null;
      this._recovery = this._readRecovery();
      if (this._recovery && JSON.stringify(this._recovery.project) !== this._savedRaw) {
        this.$('recovery').hidden = false; this.$('loading').hidden = true;
        this.$('recovery-description').textContent = this._recovery.revision === this._revision ? 'Resume your edits, or export them before using the Home Assistant copy.' : 'The Home Assistant copy has changed since these edits. Resume keeps both copies separate; saving will report a conflict until you load the current saved draft.';
        this._status('Choose which drawing to open. Your recovered work has not been replaced.');
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
    this._ready = false; this._sequence = 0; this._edits = {}; this._startupFailed = false; this.$('retry').hidden = true;
    this._project = project ? clone(project) : null;
    this._channel = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
    this._frame?.remove();
    const frame = document.createElement('iframe'); this._frame = frame;
    frame.title = 'Home Studio drawing editor';
    frame.setAttribute('sandbox', 'allow-scripts allow-downloads allow-modals allow-forms');
    frame.referrerPolicy = 'no-referrer';
    const url = new URL(this._editorUrl); url.searchParams.set('embed', 'home-assistant'); url.hash = `ha-studio=${this._channel}`;
    frame.src = url.href; this.shadowRoot.append(frame); this.$('loading').hidden = true;
    this._watchStartup('The drawing tools did not finish loading. Retry to reopen your preserved drawing.');
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
    if (data.type === 'ready' && !this._ready) this._send('initialize', { project: this._project, catalog: this._catalog });
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
      projectBytes(data.project); this._sequence = data.sequence; this._project = clone(data.project); this._ready = true;
      this._clearStartup();
      this._edits = { pending: data.edits?.pending === true, invalid: data.edits?.invalid === true, field: boundedText(data.edits?.field) };
      this._persist(); this._buttons();
      if (!this._busy) this._drawingStatus();
      const pending = this._pending.get(data.requestId);
      if (pending) { clearTimeout(pending.timer); this._pending.delete(data.requestId); pending.resolve(clone(this._project)); }
    } catch { this._status('The editor returned an invalid drawing. Your saved copy is unchanged.', true); }
  }
  _snapshot(allowInvalid = false) {
    const requestId = String(++this._request);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._pending.delete(requestId); reject(new Error('The editor did not respond. Your saved copy is unchanged.')); }, 5000);
      this._pending.set(requestId, { resolve, reject, timer }); this._send('snapshot-request', { requestId, allowInvalid });
    });
  }
  async _save() {
    if (this._busy || !this._ready) return;
    const generation = this._generation;
    this._busy = true; this._buttons(); this._status('Saving draft…');
    try {
      const project = await this._snapshot(); if (generation !== this._generation) return; const raw = projectBytes(project);
      const saved = await this._hass.callWS({ type: 'home_floorplan/project_save', revision: this._revision, project });
      if (generation !== this._generation) return;
      this._revision = saved.revision; this._publishedRevision = saved.published_revision; this._savedRaw = raw;
      this._persist(); this._status(this._unsaved() ? 'Draft saved. Newer edits remain unsaved; save again when ready.' : 'Draft saved in Home Assistant. Publish when ready to update the family view.');
    } catch (error) { if (generation !== this._generation) return; this._status(error.code === 'invalid_fields' ? error.message : error.code === 'conflict' ? 'Another session changed the saved draft. Your edits are safe in this tab. Export JSON, then Load saved draft to review the current copy.' : `Save failed: ${error.message || 'check your Home Assistant connection'}. Your edits remain in this tab.`, true); }
    finally { if (generation === this._generation) { this._busy = false; this._buttons(); } }
  }
  async _publish() {
    if (this._busy || !this._ready || this._dirty()) return;
    const generation = this._generation;
    this._busy = true; this._buttons();
    try {
      await this._snapshot(); if (generation !== this._generation) return;
      if (this._dirty()) { this._status('Save your latest edits before publishing.'); return; }
      this._status('Building and publishing the saved drawing…');
      const saved = await this._hass.callWS({ type: 'home_floorplan/project_publish', revision: this._revision });
      if (generation !== this._generation) return;
      this._publishedRevision = saved.published_revision;
      this._status(this._unsaved() ? 'Published the saved drawing. Newer edits remain unsaved; save and publish again when ready.' : 'Published. Open family view to use your home.');
    } catch (error) { if (generation !== this._generation) return; this._status(error.code === 'invalid_fields' ? error.message : error.code === 'conflict' ? 'The saved draft changed in another session. Load saved draft before publishing.' : `Publish failed: ${error.message || 'check the drawing and connection'}. Your draft is still available.`, true); }
    finally { if (generation === this._generation) { this._busy = false; this._buttons(); } }
  }
  async _reload() {
    if (this._busy || !this._ready) return;
    const generation = this._generation;
    this._busy = true; this._buttons();
    try {
      await this._snapshot(true); if (generation !== this._generation) return;
      if (this._unsaved() && !window.confirm('Replace this tab’s edits, including any unfinished field text, with the current saved draft? Export JSON first to keep a separate copy of the last valid drawing.')) return;
      const sequence = this._sequence;
      const saved = await this._hass.callWS({ type: 'home_floorplan/project_get' });
      if (generation !== this._generation) return;
      // Flush the editor after the network wait as well: an edit's message can
      // still be crossing the sandbox boundary when the HA response arrives.
      await this._snapshot(true); if (generation !== this._generation) return;
      // The requested snapshot advances the sequence once even without changes.
      if (this._sequence !== sequence + 1) {
        this._persist();
        this._status('Reload cancelled because you edited the drawing while it was loading. Your edits are kept in this tab. Save or export them, then load the saved draft again.');
        return;
      }
      this._revision = saved.revision; this._publishedRevision = saved.published_revision; this._savedRaw = saved.project ? projectBytes(saved.project) : null;
      this._saved = saved; this._openEditor(saved.project); this._persist();
    } catch (error) { if (generation !== this._generation) return; this._status(`Could not load the saved draft: ${error.message || 'check the connection'}`, true); }
    finally { if (generation === this._generation) { this._busy = false; this._buttons(); } }
  }
  _download(project, name = 'project.json') {
    const url = URL.createObjectURL(new Blob([projectBytes(project)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = name; this.shadowRoot.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
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
