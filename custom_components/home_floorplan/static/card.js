/** Lovelace wrapper for the authenticated, sandboxed floorplan host. */
import './panel.js';

const floorIdPattern = /^[a-z][a-z0-9_]{0,47}$/;

/** Lovelace visual editor. Only the normal, permission-filtered status is read. */
class HomeFloorplanCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode:'open'});
    this.shadowRoot.innerHTML = `<style>
      :host{display:block;color:var(--primary-text-color);font-family:var(--paper-font-body1_-_font-family,system-ui)}
      .fields{display:grid;gap:20px;padding:8px 0 16px}
      .field{display:grid;gap:6px;min-width:0}
      label{font-size:14px;font-weight:500}
      input,select,button{box-sizing:border-box;font:inherit;color:var(--primary-text-color);background:var(--card-background-color,#fff)}
      input:not([type=checkbox]),select{width:100%;min-height:48px;padding:10px 12px;border:1px solid var(--divider-color,#888);border-radius:8px}
      input:focus-visible,select:focus-visible,button:focus-visible{outline:2px solid var(--primary-color,#03a9f4);outline-offset:2px}
      input[aria-invalid=true]{border-color:var(--error-color,#db4437)}
      .check{display:grid;grid-template-columns:24px 1fr;gap:10px;align-items:start;cursor:pointer;min-height:40px}
      .check input{width:20px;height:20px;margin:0;accent-color:var(--primary-color,#03a9f4)}
      .check span{display:grid;gap:6px}
      small,p{font-size:13px;line-height:1.5;color:var(--secondary-text-color)}
      small{font-weight:400}p{margin:0}
      #error{color:var(--error-color,#db4437)}
      button{justify-self:start;padding:8px 12px;border:1px solid var(--divider-color,#888);border-radius:8px;cursor:pointer}
      [hidden]{display:none!important}
    </style><div class="fields">
      <div class="field"><label id="floor-label" for="floor-select">Initial floor</label>
        <select id="floor-select" data-key="floor" aria-describedby="floor-help" hidden></select>
        <input id="floor-input" data-key="floor" type="text" maxlength="48" placeholder="Project default (leave empty)" aria-describedby="floor-help" autocapitalize="none" spellcheck="false">
        <small id="floor-help" role="status"></small><button id="refresh-floors" type="button">Refresh floors</button>
      </div>
      <div class="field"><label for="height">Card height (pixels)</label>
        <input id="height" data-key="height" type="number" min="240" max="1600" step="1" placeholder="600" aria-describedby="height-help">
        <small id="height-help">240–1600 pixels. Leave empty to use 600.</small>
      </div>
      <label class="check" for="sidebar_collapsed"><input id="sidebar_collapsed" data-key="sidebar_collapsed" type="checkbox"><span>Hide the sidebar initially<small>Leave more space for your home. The sidebar can be opened inside the card.</small></span></label>
      <label class="check" for="room_labels"><input id="room_labels" data-key="room_labels" type="checkbox"><span>Show room names<small>Display room labels when opening the card.</small></span></label>
      <div class="field"><label for="device_filter">Devices to show</label><select id="device_filter" data-key="device_filter"><option value="all">All devices and sensors</option><option value="controls">Controls only</option></select><small>Controls only hides passive sensor markers.</small></div>
      <label class="check" for="dry_run"><input id="dry_run" data-key="dry_run" type="checkbox"><span>Preview only (Dry run)<small>Block real device commands from this card. Your remembered Dry run preference may also block commands when this is off.</small></span></label>
      <label class="check" for="edit_locked"><input id="edit_locked" data-key="edit_locked" type="checkbox"><span>Lock layout editing<small>Hide layout-editing tools even for administrators. Family accounts cannot edit the layout, regardless of this setting.</small></span></label>
      <p>Uses your published home and Home Assistant permissions. No access token or public home URL is needed.</p>
      <p id="error" role="alert" hidden></p>
    </div>`;
    this.shadowRoot.addEventListener('change', event => this._change(event));
    this.shadowRoot.querySelector('#refresh-floors').onclick = () => this._loadFloors(true);
  }

  setConfig(config) {
    this._config = {...config};
    this.shadowRoot.querySelector('#error').hidden = true;
    for (const field of this.shadowRoot.querySelectorAll('[aria-invalid]')) field.removeAttribute('aria-invalid');
    this._render();
  }

  set hass(value) {
    this._hass = value;
    if (this._accountId !== value?.user?.id || this._accountAdmin !== value?.user?.is_admin ||
        this._connection !== value?.connection || this._connected !== value?.connected) {
      this._accountId = value?.user?.id;
      this._accountAdmin = value?.user?.is_admin;
      this._connection = value?.connection;
      this._connected = value?.connected;
      this._request = null;
      this._floors = null;
      this._floorState = '';
      this._render();
    }
    this._loadFloors();
  }

  connectedCallback() { this._render(); this._loadFloors(); }
  disconnectedCallback() { this._request = null; this._floors = null; this._floorState = ''; }

  async _loadFloors(refresh = false) {
    if (!this.isConnected || !this._hass?.user?.id || !this._hass.callWS || this._hass.connected === false) return;
    if (!refresh && (this._request || this._floorState)) return;
    const request = {};
    this._request = request;
    this._floorState = 'loading';
    this._renderFloors();
    try {
      const result = await this._hass.callWS({type:'home_floorplan/status'});
      if (this._request !== request || !this.isConnected) return;
      const names = new Map((Array.isArray(result.floor_options) ? result.floor_options : [])
        .filter(floor => floor && typeof floor.id === 'string' && typeof floor.name === 'string')
        .map(floor => [floor.id,floor.name]));
      this._floors = [...new Set(Array.isArray(result.floors) ? result.floors : [])]
        .filter(id => typeof id === 'string' && floorIdPattern.test(id))
        .map(id => ({id,name:names.get(id) || id.replaceAll('_',' ')}));
      this._floorState = 'ready';
    } catch {
      if (this._request !== request || !this.isConnected) return;
      this._floors = null;
      this._floorState = 'error';
    } finally {
      if (this._request === request) {
        this._request = null;
        this._renderFloors();
      }
    }
  }

  _renderFloors() {
    const select = this.shadowRoot.querySelector('#floor-select');
    const input = this.shadowRoot.querySelector('#floor-input');
    const help = this.shadowRoot.querySelector('#floor-help');
    const floor = this._config?.floor || '';
    const available = this._floors !== null && this._floors !== undefined;
    select.hidden = !available;
    input.hidden = available;
    this.shadowRoot.querySelector('#floor-label').htmlFor = available ? select.id : input.id;
    this.shadowRoot.querySelector('#refresh-floors').disabled = this._floorState === 'loading' ||
      !this._hass?.user?.id || this._hass?.connected === false;
    if (available) {
      const options = [{id:'',name:'Project default'},...this._floors];
      const missing = floor && !this._floors.some(option => option.id === floor);
      if (missing) options.push({id:floor,name:`${floor} (not currently available)`});
      select.replaceChildren(...options.map(({id,name}) => {
        const option = document.createElement('option'); option.value = id; option.textContent = name; return option;
      }));
      select.value = floor;
      help.textContent = missing ? 'The selected floor is unavailable to this account. Choose a published floor or the project default.' :
        this._floors.length ? 'Choose a published floor. You can still switch floors inside the card.' :
          'No published floors are available to this account. Publish your home in Home Studio, then refresh floors.';
    } else {
      input.value = floor;
      help.textContent = this._floorState === 'loading' ? 'Loading published floors…' :
        this._floorState === 'error' ? 'Floors could not be loaded. Refresh to try again, leave empty for the project default, or enter a known floor ID.' :
          'Connect to Home Assistant to choose a published floor. Leave empty for the project default, or enter a known floor ID.';
    }
  }

  _render() {
    if (!this._config) return;
    this._renderFloors();
    for (const key of ['sidebar_collapsed','room_labels','dry_run','edit_locked'])
      this.shadowRoot.getElementById(key).checked = this._config[key] ?? (key === 'sidebar_collapsed');
    this.shadowRoot.querySelector('#height').value = this._config.height ?? '';
    this.shadowRoot.querySelector('#device_filter').value = this._config.device_filter ?? 'all';
  }

  _change(event) {
    const field = event.target, key = field.dataset.key;
    if (!key || !this._config) return;
    let value = field.type === 'checkbox' ? field.checked : field.value;
    let error = '';
    if (key === 'height' && field.validity.badInput) error = 'Enter a card height from 240 to 1600 whole pixels.';
    if (key === 'height' && value !== '') {
      value = Number(value);
      if (!Number.isInteger(value) || value < 240 || value > 1600) error = 'Enter a card height from 240 to 1600 whole pixels.';
    }
    if (key === 'floor' && value && !floorIdPattern.test(value))
      error = 'A floor ID starts with a lowercase letter and contains up to 48 lowercase letters, numbers, or underscores.';
    field.setAttribute('aria-invalid',String(!!error));
    const message = this.shadowRoot.querySelector('#error');
    message.textContent = error; message.hidden = !error;
    if (error) return;
    const next = {...this._config};
    if ((key === 'height' || key === 'floor') && value === '') delete next[key];
    else next[key] = value;
    this._config = next;
    if (key === 'floor') this._renderFloors();
    this.dispatchEvent(new CustomEvent('config-changed',{detail:{config:{...next}},bubbles:true,composed:true}));
  }
}

class HomeFloorplanCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode:'open'});
    this.shadowRoot.innerHTML = `<style>
      :host{display:block;min-width:0}
      ha-card{display:flex;flex-direction:column;overflow:hidden;height:var(--home-floorplan-card-height,600px)}
      home-floorplan-panel{height:100%;width:100%;min-height:0;flex:1}
      #status{flex-shrink:0;padding:20px;color:var(--primary-text-color);font:14px/1.5 system-ui}
    </style><ha-card><div id="status" role="status">Connecting to Home Assistant…</div></ha-card>`;
  }

  static getStubConfig() {
    return {type:'custom:home-floorplan-card',height:600,sidebar_collapsed:true,edit_locked:true};
  }

  static getConfigElement() { return document.createElement('home-floorplan-card-editor'); }

  setConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('A floorplan card configuration is required.');
    if (config.floor !== undefined && (typeof config.floor !== 'string' || !floorIdPattern.test(config.floor)))
      throw Error('floor must be a floor ID from your project.');
    if (config.height !== undefined && (!Number.isInteger(config.height) || config.height < 240 || config.height > 1600))
      throw Error('height must be a number between 240 and 1600 pixels.');
    for (const key of ['sidebar_collapsed','dry_run','edit_locked','room_labels']) {
      if (config[key] !== undefined && typeof config[key] !== 'boolean') throw Error(`${key} must be true or false.`);
    }
    if (config.device_filter !== undefined && !['all','controls'].includes(config.device_filter)) throw Error('device_filter must be all or controls.');
    const next = {floor:config.floor,height:config.height ?? 600,
      sidebarCollapsed:config.sidebar_collapsed ?? true,dryRun:config.dry_run ?? false,
      editLocked:config.edit_locked ?? false,deviceFilter:config.device_filter ?? 'all',roomLabels:config.room_labels ?? false};
    const changed = this._config && ['floor','sidebarCollapsed','dryRun','editLocked','deviceFilter','roomLabels'].some(key => next[key] !== this._config[key]);
    if (changed && (this._panel?.pending || this._panel?.failed))
      throw Error('Save or recover your floorplan placements before changing the card settings.');
    this._config = next;
    this.style.setProperty('--home-floorplan-card-height',`${next.height}px`);
    if (changed) this._removePanel();
    this._render();
  }

  set hass(value) {
    this._hass = value;
    this._render();
  }

  connectedCallback() { this._render(); }

  getCardSize() { return Math.ceil((this._config?.height ?? 600) / 50); }

  getGridOptions() { return {columns:12,rows:'auto',min_columns:6}; }

  _removePanel() {
    this._panel?.removeEventListener('home-floorplan-save-status',this._onSaveStatus);
    this._panel?.discardLocalEdits();
    this._panel?.remove();
    this._panel = null;
  }

  _render() {
    if (!this._config || !this.isConnected) return;
    const status = this.shadowRoot.querySelector('#status');
    if (!this._hass?.user?.id) {
      this._removePanel();
      status.hidden = false;
      status.textContent = 'Connecting to Home Assistant…';
      return;
    }
    if (this._panel && (this._panelUser !== this._hass.user.id || this._panelAdmin !== this._hass.user.is_admin)) this._removePanel();
    if (this._panel && this._panelConnection !== this._hass.connection) {
      if (this._panel.pending || this._panel.failed) {
        // Keep the submitted draft available for export through session recovery.
        this._panel.hass = this._hass;
        status.hidden = false;
        status.textContent = this._panel.pending ? 'Home Assistant reconnected. Waiting for layout edits to finish saving…' :
          'Home Assistant reconnected. Layout edits are still here. Export inventory JSON before reloading the saved plan.';
        return;
      }
      this._removePanel();
    }
    if (!this._panel) {
      this._panel = document.createElement('home-floorplan-panel');
      this._panelUser = this._hass.user.id;
      this._panelAdmin = this._hass.user.is_admin;
      this._panelConnection = this._hass.connection;
      this._onSaveStatus ||= () => this._render();
      this._panel.addEventListener('home-floorplan-save-status',this._onSaveStatus);
      this._panel.configureDashboard(this._config);
      this._panel.hass = this._hass;
      this.shadowRoot.querySelector('ha-card').append(this._panel);
    } else {
      this._panel.hass = this._hass;
    }
    status.hidden = true;
  }
}

if (!customElements.get('home-floorplan-card')) customElements.define('home-floorplan-card',HomeFloorplanCard);
if (!customElements.get('home-floorplan-card-editor')) customElements.define('home-floorplan-card-editor',HomeFloorplanCardEditor);
globalThis.customCards ||= [];
if (!globalThis.customCards.some(card => card.type === 'home-floorplan-card')) {
  globalThis.customCards.push({type:'home-floorplan-card',name:'Home Studio',
    description:'Your saved Home Studio floorplan with live Home Assistant states and controls.'});
}
