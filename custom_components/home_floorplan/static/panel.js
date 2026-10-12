/** Native HA host. Tokens stay outside the sandbox. */
function projectAssumedZoneActivity(id, state, attributes, configuration) {
  if(!configuration?.sensor||id!==configuration.sensor||attributes.restored)return {};
  if(state!=='active'){
    const expected={quiet:'no_elevated_signal_anomaly_not_empty',warming_up:'collecting_recent_ambient_baseline'};
    const reason=attributes.reason;
    const status=Object.hasOwn(expected,state)&&reason===expected[state]?state:
      state==='unknown'&&['source_unavailable','source_expired','receiver_binding_changed','invalid_source','required_node_unavailable'].includes(reason)?reason:null;
    if(status==='required_node_unavailable'){
      const issues=attributes.receiver_issues,seen=new Set();
      const receiverIds=Object.keys(configuration.receiver_names||{}).map(Number);
      if(Array.isArray(issues)&&issues.length>0&&issues.length<=receiverIds.length&&issues.every(row=>row&&receiverIds.includes(row.node_id)&&!seen.has(row.node_id)&&seen.add(row.node_id)&&['device_check_failed','signal_stale','checking_device','unavailable'].includes(row.reason)))
        return {signal_status:status,receiver_issues:issues.map(({node_id,reason})=>({node_id,reason}))};
      return {signal_status:'source_unavailable'};
    }
    return status?{signal_status:status}:{};
  }
  const invalid={signal_status:'invalid_source'},value=attributes.zone_activity;
  if(!value||typeof value.geometry_sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.geometry_sha256)||
    !Number.isFinite(value.observed_at_ms)||!Number.isFinite(value.expires_at_ms)||
    value.observed_at_ms<0||Math.abs(value.expires_at_ms-value.observed_at_ms-5000)>.001||
    !Array.isArray(value.zones)||!value.zones.length||value.zones.length>32)return invalid;
  const seen=new Set(),zones=[];
  for(const zone of value.zones){
    if(!zone||typeof zone.id!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(zone.id)||seen.has(zone.id)||
      !Number.isFinite(zone.score)||zone.score<0||zone.score>1)return invalid;
    seen.add(zone.id);zones.push({id:zone.id,score:zone.score});
  }
  return {signal_status:'active',zone_activity:{geometry_sha256:value.geometry_sha256,observed_at_ms:value.observed_at_ms,expires_at_ms:Math.min(value.expires_at_ms,value.observed_at_ms+5000),zones}};
}

function projectRoomActivity(id, state, attributes, configured = false) {
  if (!configured || attributes.restored ||
      !['motion','presence','experimental','quiet','unknown'].includes(state)) return {};
  const evidence = Object.create(null), source = attributes.evidence;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    let count = 0;
    for (const key in source) {
      if (!Object.hasOwn(source, key)) continue;
      // Oversized evidence cannot provide a complete room explanation.
      if (++count > 64) return {activity:{evidence:Object.create(null)}};
      if (/^[a-z][a-z0-9_]{0,79}$/.test(key) && !['constructor','prototype'].includes(key) &&
          ['motion','presence','quiet','unknown','unverified_motion','unverified_presence','unverified_quiet','misplaced'].includes(source[key])) {
        evidence[key] = source[key];
      }
    }
  }
  return {activity:{evidence}};
}

class HomeFloorplanPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode: 'open'});
    this.shadowRoot.innerHTML = `<style>:host{display:flex;flex-direction:column;height:100dvh;min-height:0;background:#11191f}header{flex-shrink:0;display:flex;align-items:center;gap:12px;padding:8px 12px;font:14px system-ui;color:#b8c8d0}button{padding:8px 10px;cursor:pointer;background:#202d35;color:#e9eeef;border:1px solid #44515a;border-radius:7px;min-height:40px}#notice{flex:1}iframe{border:0;flex:1;width:100%;min-height:0}.error{color:#ffd19b}#recovery{padding:20px;color:#e9eeef;font:14px/1.5 system-ui;overflow:auto}#recovery-details{white-space:pre-wrap;overflow-wrap:anywhere}button:disabled{opacity:.5}[hidden]{display:none!important}</style><header><button id="menu" aria-label="Open sidebar">☰</button><span id="notice" role="status">Connecting to Home Assistant…</span><button id="retry">Reload saved plan</button></header><section id="recovery" hidden><h2>Saved placements need repair</h2><p>Nothing has been overwritten. Export the original inventory, keep it as a backup, and edit a copy using the current floor and room IDs below. Importing the repaired copy replaces all saved floors only after validation.</p><pre id="recovery-details"></pre><button id="recovery-export">Export original inventory</button> <button id="recovery-import">Import repaired inventory</button><input id="recovery-file" type="file" accept="application/json,.json" hidden></section><iframe title="Private home floorplan" sandbox="allow-scripts allow-downloads allow-forms"></iframe>`;
    this.floor = null;
    this.floors = [];
    this.siteFeatures = false;
    this.recovery = null;
    this.savedItems = [];
    this.tvFrameCache = Object.create(null);
    this.resetModelConfig();
    this.queue = Promise.resolve();
    this.pending = 0;
    this.commands = new Set();
    this.curtains = {memory:{},power:{},checks:{},profiles:{},boot_seconds:50};
    this.viewPreferences = {sidebarCollapsed:false};
    try { this.viewPreferences.sidebarCollapsed=localStorage.getItem('home-floorplan:sidebar-collapsed')==='true'; } catch {}
    this.$('menu').onclick = () => this.dispatchEvent(new CustomEvent('hass-toggle-menu', {bubbles:true, composed:true}));
    this.$('retry').onclick = () => {
      if (this.pending) return this.notice('Wait for the current save to finish.', true);
      if (this.failed && !confirm('Unsaved edits will be discarded. Export inventory JSON first. Reload?')) return;
      this.loadFloor(this.revision === undefined ? undefined : this.floor);
    };
    this.$('recovery-export').onclick = () => this.exportRecovery();
    this.$('recovery-import').onclick = () => this.$('recovery-file').click();
    this.$('recovery-file').onchange = event => {
      const file = event.target.files[0]; event.target.value = '';
      if (file) this.importRecovery(file);
    };
  }

  resetModelConfig() {
    this.tvFrames={};this.cameraEntities={};this.roomActivity=new Set();this.moduleEntities=new Set();this.assumedActivity=null;this.modelConfigured=false;
  }
  set hass(value) {
    this._hass = value;
    if (!this.started && this.isConnected) { this.started = true; this.loadFloor(); }
    this.publishEntityStates();
  }
  connectedCallback() {
    if (this._hass && !this.started) { this.started = true; this.loadFloor(); }
  }
  disconnectedCallback() {
    this.generation = (this.generation || 0) + 1;
    this.clearViewerLoad();
    this.port?.close(); this.port = null; this.started = false;
    if (this.viewerURL) URL.revokeObjectURL(this.viewerURL);
    this.viewerURL = null;
    this.curtainSubscription?.unsubscribe?.(); this.curtainSubscription = null;
    for(const tv of Object.values(this.tvFrames)){clearTimeout(tv.timer);tv.timer=null;}
    clearTimeout(this.cameraTimer);this.cameraTimer=null;
    document.removeEventListener('visibilitychange', this.tvVisibility);
  }
  $(id, byId = true) { return this.shadowRoot.querySelector(byId ? '#' + id : id); }
  isCurrent(generation) { return generation === this.generation && this.isConnected; }
  notice(text, error = false) {
    const el = this.$('notice');
    el.textContent = text; el.classList.toggle('error', error);
  }
  exportRecovery() {
    if (!this.recovery) return;
    this.download(new Blob([JSON.stringify(this.recovery.backup, null, 2) + '\n'], {type:'application/json'}), 'home-floorplan-original-inventory.json');
  }
  async importRecovery(file) {
    const recovery = this.recovery, generation = this.generation;
    if (!recovery || this.pending) return;
    let applied = false;
    try {
      if (file.size > Math.max(5000000, new Blob([JSON.stringify(recovery.backup)]).size * 2)) throw Error('Recovery file is too large.');
      const value = JSON.parse(await file.text());
      if (generation !== this.generation || recovery !== this.recovery || !this.isConnected) return;
      if (value?.schema_version !== 1 || value.site_id !== recovery.backup.site_id || value.recovery_token !== recovery.token)
        throw Error('Use a repaired copy of the current original export. Reload and export again if the build changed.');
      if (!confirm('Replace all saved floor inventories with this repaired file? Removed floors and omitted objects will be removed. Keep the original export as a backup.')) return;
      this.pending++;
      this.$('recovery-import').disabled = true;
      const operation = this.queue.then(() => this._hass.callWS({type:'home_floorplan/recover', token:value.recovery_token, site_id:value.site_id, floors:value.floors}));
      this.queue = operation.catch(() => {});
      try { await operation; applied = true; }
      finally { this.pending--; }
    } catch (error) {
      if (generation === this.generation) this.notice(`Inventory not replaced: ${error.message || error}`, true);
    } finally {
      if (generation === this.generation) this.$('recovery-import').disabled = false;
    }
    if (applied && this.isCurrent(generation)) await this.loadFloor();
  }
  publishEntityStates() {
    if (!this.port || !this._hass) return;
    // Preserve recovery controls even while a bound motor is absent from HA.
    const available = {...Object.fromEntries(this.savedItems.filter(i=>i.entity_id?.startsWith('cover.')).map(i=>[i.entity_id,{state:'unavailable',attributes:{}}])),...this._hass.states};
    const states = Object.fromEntries(Object.entries(available).map(([id, entity]) => {
      const {state, attributes, last_changed, last_updated} = entity;
      const cover = id.startsWith('cover.');
      const guardId = cover ? this.curtains.profiles[id]?.guard : undefined;
      const powerOnAt = this.curtains.power?.[guardId];
      const stalePosition = powerOnAt && Date.parse(last_updated) < Date.parse(powerOnAt);
      if (cover && !attributes.restored && ['open','closed','opening','closing'].includes(state) &&
        this._hass.states[guardId]?.state !== 'off' && !stalePosition) {
        const position = attributes.current_position;
        if (Number.isFinite(position) && position >= 0 && position <= 100) this.curtains.memory[id] = {position, observed_at:last_updated};
      }
      return [id, {
        state, name:attributes.friendly_name || id, last_changed, last_updated, restored:attributes.restored,
        unit:attributes.unit_of_measurement || '', device_class:attributes.device_class || '',
        // Forward only display attributes; credentials and unrelated metadata stay in HA.
        ...projectRoomActivity(id, state, attributes, this.roomActivity?.has(id)),
        ...projectAssumedZoneActivity(id, state, attributes, this.assumedActivity),
        ...(this.moduleEntities?.has(id) ? {modules:{summary:typeof attributes.module_summary==='string'?attributes.module_summary.slice(0,200):'',details:typeof attributes.module_details==='string'?attributes.module_details.slice(0,16000):''}} : {}),
        ...(id === 'sun.sun' ? {sun:{elevation:attributes.elevation}} : {}),
        ...(cover ? {cover:{current_position:attributes.current_position,supported_features:attributes.supported_features,restored:attributes.restored,last_known:this.curtains.memory[id],position_checked_at:this.curtains.checks?.[id],guard:guardId,power_on_at:powerOnAt,boot_seconds:this.curtains.boot_seconds}} : {}),
        ...(id.startsWith('light.') ? {light:Object.fromEntries(
          ['brightness','color_mode','rgb_color','hs_color','xy_color','color_temp_kelvin','color_temp']
            .filter(key => attributes[key] !== undefined)
            .map(key => [key,attributes[key]])
        )} : {}),
      }];
    }));
    this.port.postMessage({type:'states', states, connected:this._hass.connected !== false});
    this.refreshTVFrame();
    this.refreshCameraFrames();
  }
  async refreshCameraFrames() {
    const port=this.port,generation=this.generation;
    const enabled=this.siteFeatures && port && !document.hidden && this._hass?.connected!==false &&
      this.savedItems.some(i=>Object.hasOwn(this.cameraEntities||{},i.id)&&i.entity_id===this.cameraEntities[i.id]);
    if(!enabled){
      clearTimeout(this.cameraTimer);this.cameraTimer=null;
      port?.postMessage({type:'camera_frames',frames:{}});return;
    }
    if(this.cameraBusy||this.cameraTimer)return;
    this.cameraBusy=true;
    let frames={};
    try {frames=await this._hass.callWS({type:'home_floorplan/camera_frames'});} catch {}
    finally {this.cameraBusy=false;}
    if(port!==this.port||generation!==this.generation){this.refreshCameraFrames();return;}
    port.postMessage({type:'camera_frames',frames:!document.hidden&&this._hass.connected!==false?frames:{}});
    if(!document.hidden&&this._hass.connected!==false)
      this.cameraTimer=setTimeout(()=>{this.cameraTimer=null;this.refreshCameraFrames();},1000);
  }
  refreshTVFrame() {
    return Promise.all(Object.keys(this.tvFrames).map(id=>this.refreshTV(id)));
  }
  async refreshTV(itemId) {
    const port=this.port, generation=this.generation, tv=this.tvFrames[itemId];
    if(!port || !this.siteFeatures || !tv)return;
    const id=tv.entity_id;
    const entity=this._hass.states[id];
    const source=!document.hidden && this._hass.connected!==false && !entity?.attributes.restored &&
      ['on','playing','paused','idle','buffering'].includes(entity?.state) &&
      this.savedItems.some(i=>i.id===itemId&&i.entity_id===id) ? entity.attributes.source||'' : null;
    if(source!==tv.source){
      tv.source=source;tv.version=(tv.version||0)+1;
      clearTimeout(tv.timer);tv.timer=null;
      port.postMessage({type:'tv_frame',item_id:itemId,image:null});
    }
    if(source===null || tv.busy)return;
    const delay=(tv.next||0)-Date.now();
    if(delay>0){tv.timer ||= setTimeout(()=>{tv.timer=null;this.refreshTV(itemId);},delay);return;}
    clearTimeout(tv.timer);tv.timer=null;
    tv.busy=true;tv.next=Date.now()+60000;
    const version=tv.version;
    let frame={image:null};
    try {frame=await this._hass.callWS({type:'home_floorplan/tv_frame',entity_id:id});} catch {}
    finally {tv.busy=false;}
    if(generation===this.generation && port===this.port && version===tv.version && !document.hidden)
      port.postMessage({type:'tv_frame',item_id:itemId,image:frame?.image,captured_at:frame?.captured_at});
    this.refreshTV(itemId);
  }
  clearViewerLoad() {
    clearTimeout(this.viewerLoadTimer); this.viewerLoadTimer = null;
    removeEventListener('message', this.viewerNavigation);
    this.viewerNavigation = null;
  }
  async loadFloor(floor) {
    this.notice('Loading private model…');
    this.clearViewerLoad();
    this.port?.close(); this.port = null;
    clearTimeout(this.cameraTimer);this.cameraTimer=null;
    for(const tv of Object.values(this.tvFrames)){clearTimeout(tv.timer);tv.timer=null;tv.source=null;}
    this.resetModelConfig();
    const generation = this.generation = (this.generation || 0) + 1;
    try {
      if (!this.curtainSubscription && this._hass.connection?.subscribeMessage) {
        // Share registration; release it if the panel detaches before it resolves.
        const subscription = this.curtainSubscription = {};
        subscription.ready = this._hass.connection.subscribeMessage(value => {
          if (this.curtainSubscription !== subscription) return;
          this.curtains = value; this.publishEntityStates();
        }, {type:'home_floorplan/curtains'}).then(unsubscribe => {
          if (this.curtainSubscription === subscription) subscription.unsubscribe = unsubscribe;
          else unsubscribe();
        }).catch(error => {
          if (this.curtainSubscription === subscription) this.curtainSubscription = null;
          throw error;
        });
      }
      await this.curtainSubscription?.ready; await this.queue;
      if (!this.isCurrent(generation)) return;
      this.failed=false;
      const result = await this._hass.callWS({type:'home_floorplan/viewer', ...(floor ? {floor} : {})});
      if (!this.isCurrent(generation)) return;
      this.floor = result.floor || floor || result.floors?.[0] || null;
      this.floors = result.floors || (this.floor ? [this.floor] : []);
      this.siteFeatures = result.site_features !== false;
      const iframe = this.$('iframe',false);
      this.recovery = result.recovery || null;
      this.$('recovery').hidden = !this.recovery;
      iframe.hidden = !!this.recovery;
      if (this.recovery) {
        this.revision = undefined; this.savedItems = [];
        iframe.onload = null; iframe.removeAttribute('src'); iframe.removeAttribute('srcdoc');
        if (this.viewerURL) URL.revokeObjectURL(this.viewerURL);
        this.viewerURL = null;
        this.$('recovery-details').textContent = [...this.recovery.issues, '', 'Current floors and room IDs:', ...Object.entries(this.recovery.backup.rooms).map(([id, rooms]) => `${id}: ${rooms.join(', ')}`)].join('\n');
        this.notice('Saved inventory does not match this build. Export and repair it below.', true);
        return;
      }
      this.revision = result.revision; this.savedItems = result.items;
      let loaded = false, navigating = false;
      iframe.onload = () => {
        if (loaded || !this.isCurrent(generation)) return;
        loaded = true;
        this.clearViewerLoad();
        const channel = new MessageChannel();
        this.port = channel.port1;
        this.port.onmessage = event => this.handleViewerMessage(event.data, generation);
        // An opaque sandbox has origin "null"; verify the parent in the viewer.
        iframe.contentWindow.postMessage({type:'home-floorplan:init', items:result.items,preferences:this.viewPreferences}, '*', [channel.port2]);
        this.publishEntityStates(); this.notice('Connected · placements are saved in Home Assistant');
        this.tvVisibility ||= () => {this.refreshTVFrame();this.refreshCameraFrames();};
        document.addEventListener('visibilitychange',this.tvVisibility);
      };
      // Child startup cancels fallback during cold WebGL initialization.
      this.viewerNavigation = event => {
        if (event.source !== iframe.contentWindow || event.data?.type !== 'home-floorplan:loading' ||
            event.data.generation !== generation || !this.isCurrent(generation)) return;
        navigating = true; this.clearViewerLoad();
      };
      addEventListener('message', this.viewerNavigation);
      const html = result.html.replace('<head>', `<head><script>parent.postMessage({type:'home-floorplan:loading',generation:${generation}},'*');</script>`);
      const previousURL = this.viewerURL;
      this.viewerURL = URL.createObjectURL(new Blob([html], {type:'text/html'}));
      iframe.src = this.viewerURL;
      iframe.removeAttribute('srcdoc');
      if (previousURL) URL.revokeObjectURL(previousURL);
      // Recover stalled Blob navigation within the same opaque sandbox.
      this.viewerLoadTimer = setTimeout(() => {
        if (loaded || navigating || !this.isCurrent(generation)) return;
        this.clearViewerLoad();
        URL.revokeObjectURL(this.viewerURL); this.viewerURL = null;
        iframe.srcdoc = result.html;
      }, 8000);
    } catch (error) { if (this.isCurrent(generation)) this.notice(`Cannot load plan: ${error.message || error}`, true); }
  }
  handleViewerMessage(message, generation) {
    if (generation !== this.generation || this.recovery || !message || typeof message !== 'object') return;
    if (message.type === 'model_config') {
      if(this.modelConfigured)return;
      this.modelConfigured=true;
      const sensor=id=>typeof id==='string'&&/^sensor\.[a-z0-9_]+$/.test(id);
      const bindings=(value,domain)=>Object.entries(value||{}).filter(([item,id])=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(item)&&typeof id==='string'&&id.startsWith(domain+'.'));
      this.tvFrames=Object.fromEntries(bindings(message.tv_entities,'media_player').map(([item,id])=>{
        return [item,this.tvFrameCache[item+':'+id]??={entity_id:id,source:null}];
      }));
      this.cameraEntities=Object.fromEntries(bindings(message.camera_entities,'binary_sensor'));
      this.roomActivity=new Set(Object.values(message.room_activity||{}).filter(sensor));
      this.moduleEntities=new Set(Object.values(message.receiver_activity||{}).map(value=>value?.modules_sensor).filter(sensor));
      this.assumedActivity=sensor(message.assumed_activity?.sensor)?message.assumed_activity:null;
      this.publishEntityStates();
    } else if (message.type === 'view_preferences') {
      if(typeof message.sidebarCollapsed!=='boolean')return;
      this.viewPreferences.sidebarCollapsed=message.sidebarCollapsed;
      try {localStorage.setItem('home-floorplan:sidebar-collapsed',String(message.sidebarCollapsed));} catch {}
    } else if (message.type === 'save') {
      const floor = this.floor;
      this.pending++;
      this.notice('Saving placements…');
      this.queue = this.queue.then(async () => {
        if (this.failed) throw Error('Saving is paused. Export JSON, then reload and merge your changes.');
        const result = await this._hass.callWS({type:'home_floorplan/save', floor, revision:this.revision, items:message.items});
        this.revision = result.revision; this.savedItems = message.items;
      }).catch(error => {
        this.failed = true;
        this.notice(`NOT SAVED: ${error.message || error}. Export JSON to keep your changes.`, true);
      }).finally(() => {
        this.pending--;
        if (!this.failed && !this.pending) this.notice('Saved in Home Assistant');
      });
    } else if (message.type === 'floor') {
      if (this.pending || this.failed) return this.notice('Save must finish successfully before changing floors. Export JSON if saving failed.', true);
      if (this.floors.includes(message.floor)) this.loadFloor(message.floor);
    } else if (message.type === 'more_info') {
      const id=message.entity_id;
      if(typeof id!=='string' || !this.savedItems.some(item=>item.entity_id===id) || !this._hass.states[id])return;
      this.dispatchEvent(new CustomEvent('hass-more-info',{detail:{entityId:id},bubbles:true,composed:true}));
    } else if (message.type === 'curtain_command' || message.type === 'toggle') {
      const curtain = message.type === 'curtain_command';
      const id = message.entity_id;
      // Reply only to the originating floor's channel.
      const port = this.port;
      const result = (ok, error) => {
        if (generation !== this.generation || port !== this.port) return;
        port?.postMessage({type:'command_result', request_id:message.request_id, entity_id:id, ok, error});
        if (error) this.notice(error, true);
        else if (ok && !this.pending && !this.failed) this.notice('Command sent · device state updates live');
      };
      if (this.pending || this.failed) return result(false, 'Wait for placements to save successfully before controlling devices.');
      if (!this.savedItems.some(item => item.entity_id === id)) return result(false, 'This device is not linked to the saved plan.');
      const domain = typeof id === 'string' ? id.split('.')[0] : '';
      if (this._hass.connected === false || (curtain ? domain !== 'cover' :
        !['light','switch','input_boolean','fan'].includes(domain) || !['on','off'].includes(this._hass.states[id]?.state))) return result(false, 'This device is unavailable or Home Assistant is disconnected.');
      if (this.commands.has(id)) return result(false, 'A command for this device is already in progress.');
      this.commands.add(id);
      Promise.resolve().then(() => curtain
        ? this._hass.callWS({type:'home_floorplan/curtain_command',entity_id:id,action:message.action,...(message.action==='set_cover_position'?{position:message.position}:{})})
        : this._hass.callService(domain, 'toggle', {entity_id:id}))
        .then(() => result(true))
        .catch(error => result(false, `Command failed: ${error.message || error}`))
        .finally(() => this.commands.delete(id));
    } else if (message.type === 'export' && ['glb','usdz','obj','mtl','dae'].includes(message.format)) {
      this.downloadModel(message.format).catch(error => this.notice(`Download failed: ${error.message || error}`, true));
    }
  }
  async downloadModel(format) {
    const result = await this._hass.callWS({type:'home_floorplan/export', floor:this.floor, format});
    const bytes = Uint8Array.from(atob(result.base64), char => char.charCodeAt(0));
    this.download(new Blob([bytes], {type:'application/octet-stream'}), result.filename);
  }
  download(blob, name) {
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}
if (!customElements.get('home-floorplan-panel')) customElements.define('home-floorplan-panel', HomeFloorplanPanel);
