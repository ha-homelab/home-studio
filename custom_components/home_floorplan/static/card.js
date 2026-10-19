/** Lovelace wrapper for the authenticated, sandboxed floorplan host. */
import './panel.js';

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
    return {type:'custom:home-floorplan-card',height:600,sidebar_collapsed:true};
  }

  setConfig(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('A floorplan card configuration is required.');
    if (config.floor !== undefined && (typeof config.floor !== 'string' || !/^[a-z][a-z0-9_]{0,47}$/.test(config.floor)))
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
        // Keep the edited viewer available; the current connection supports recovery.
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
globalThis.customCards ||= [];
if (!globalThis.customCards.some(card => card.type === 'home-floorplan-card')) {
  globalThis.customCards.push({type:'home-floorplan-card',name:'Home Studio',
    description:'Your saved Home Studio floorplan with live Home Assistant states and controls.'});
}
