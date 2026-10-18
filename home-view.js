// Embedded offline/HA view; see docs/architecture.md.
homeView = (() => {
  let active = false, camera, overlayGroup, roomLighting, selected = '', bindings = [], points = [], labels = [];
  let assumedZones, signalZone='', cameraFit;
  const projectedPosition = new THREE.Vector3(), projectedForward = new THREE.Vector3();
  let showLowerFloor=true;
  $('homeFloorContext').hidden=!lowerFloorContext;
  $('homeFloorContext').onclick=()=>{
    showLowerFloor=!showLowerFloor;
    $('homeFloorContext').setAttribute('aria-pressed',String(showLowerFloor));
    window.renderModel?.();
  };
  const signalRegions=new Map();
  // Diffuse daylight: the plan does not establish compass orientation.
  const daylightWindows=model.openings.filter(o=>['window','sliding_door'].includes(o.type)).flatMap(o=>{
    const [x0,z0,x1,z1]=o.rect, horizontal=x1-x0>z1-z0;
    const x=(x0+x1)/2,z=(z0+z1)/2;
    const room=model.rooms.find(r=>!(model.exterior_rooms||[]).includes(r.id) &&
      (horizontal?[ [x,z0-2],[x,z1+2] ]:[ [x0-2,z],[x1+2,z] ]).some(([x,z])=>inPoly(x,z,r.polygon)));
    return room?[{id:o.id,room:room.id,a:horizontal?[xm(x0),zm(z)]:[xm(x),zm(z0)],b:horizontal?[xm(x1),zm(z)]:[xm(x),zm(z1)]}]:[];
  });
  const pending = new Map(), errors = new Map();
  let curtainError=null;
  const errorText=value=>value && typeof value==='object' ? vt(value.key,value.params) : value || '';
  const commandError=message=>typeof message.error_key==='string' ? {key:message.error_key,params:message.error_params || {}} : message.error || {key:'The command could not be sent.'};
  let countdownTimer, moduleItem;
  let sequence = 0, zoom = 1, panX = 0, panY = 0, controlsCollapsed = false;
  const icon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6m-5 3h4M8.5 14.5a6 6 0 1 1 7 0L15 16H9z"/></svg>';
  const motionIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="14" cy="4" r="2"/><path d="m10 22 2-7-4-3 3-5 4 5 4 1M5 11l3-4 3-1M5 21l3-6"/></svg>';
  const tvIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>';
  const receiverSpec=item=>model.receiver_activity?.[item.id];
  const activityState=id=>haConnected&&!haStates[id]?.restored?haStates[id]?.state||'unknown':'unknown';
  const receiverState=item=>{const spec=receiverSpec(item);return spec.entity_id===item.entity_id&&spec.room===item.room?activityState(spec.sensor):'unbound';};
  const activityText={motion:'Motion detected',presence:'Presence detected',quiet:'No detection',experimental:'Signal activity · room coverage unverified',unverified_motion:'Motion signal · room coverage unverified',unverified_presence:'Presence signal · room coverage unverified',unverified_quiet:'No elevated signal · room coverage unverified',misplaced:'Receiver moved · room sensing disabled',unbound:'Receiver binding changed',unknown:'Activity unknown'};
  const activityRooms=new Map(),activitySources=new Map();
  let activityLocation;
  const updateNode=(el,properties={},attributes={})=>{
    for(const [key,value] of Object.entries(properties))if(el[key]!==value)el[key]=value;
    for(const [key,value] of Object.entries(attributes))if(el.getAttribute(key)!==value)el.setAttribute(key,value);
  };
  const roomActivity=room=>['motion','presence','quiet','experimental'].includes(activityState(model.room_activity?.[room]))?activityState(model.room_activity[room]):'unknown';
  function clearActivityLocation(){
    if(activityLocation)for(const el of [activityLocation.marker,activityLocation.card])el.removeAttribute('data-activity-location');
    activityLocation=null;
  }
  function restoreActivityFocus(container){
    if(container.contains(document.activeElement))(activityRooms.get(selected)||$('homeToggleActivity')).focus();
  }
  function selectHomeRoom(room,zone=''){hideMediaControls();cancelNativeHover(true);clearActivityLocation();selected=room;signalZone=zone;$('homeRoom').value=room;refreshControls();resetZoom();}
  function locateActivitySource(item){
    if(!item)return;
    selectHomeRoom(item.room);
    activityLocation=points.find(point=>point.item.id===item.id);
    if(activityLocation)for(const el of [activityLocation.marker,activityLocation.card])el.setAttribute('data-activity-location','true');
    (activityLocation&&!activityLocation.marker.disabled?activityLocation.marker:$('homeRoom')).focus();
  }
  function inspectActivitySource(item){
    if(!item||!bridge||!haConnected)return;
    if(receiverSpec(item)){moduleItem=item;$('moduleDialog').showModal();updateModuleDialog();}
    else if(haStates[item.entity_id])bridge.postMessage({type:'more_info',entity_id:item.entity_id});
  }
  function refreshActivity(){
    if($('homeActivity').hidden)return;
    let detected=0,signalOnly=0,unknown=0;
    for(const [room,button] of activityRooms){
      const value=roomActivity(room);
      updateNode(button,{textContent:roomName(room)+' · '+(value==='experimental'?'Signal activity':activityText[value])},
        {'data-activity':value,'aria-pressed':String(room===selected)});
      if(['motion','presence'].includes(value))detected++;
      if(value==='experimental')signalOnly++;
      if(value==='unknown')unknown++;
    }
    const visibleSources=new Set();
    const id=model.room_activity?.[selected],entity=haConnected?haStates[id]:null;
    let sources=0;
    if(entity&&!entity.restored&&['motion','presence','quiet','experimental','unknown'].includes(entity.state))for(const [itemId,value] of Object.entries(entity.activity?.evidence||{})){
      const item=items.find(i=>i.id===itemId);
      if(!item||!Object.hasOwn(activityText,value))continue;
      visibleSources.add(itemId);
      const binding=receiverSpec(item)||model.inventory.find(i=>i.id===itemId);
      const bound=binding?.entity_id===item.entity_id&&binding?.room===item.room;
      let source=activitySources.get(itemId);
      if(!source){
        const row=document.createElement('div'),details=document.createElement('button'),locate=document.createElement('button');
        row.className='activity-source';details.dataset.activitySource=itemId;locate.dataset.activityLocate=itemId;
        details.onclick=()=>inspectActivitySource(items.find(i=>i.id===itemId));locate.onclick=()=>locateActivitySource(items.find(i=>i.id===itemId));
        row.append(details,locate);source={row,details,locate};activitySources.set(itemId,source);$('homeActivitySources').append(row);
      }
      const {row,details,locate}=source,disabled=!bound||!bridge||!haConnected||(!receiverSpec(item)&&!haStates[item.entity_id]);
      if(disabled)restoreActivityFocus(details);
      if(!bound)restoreActivityFocus(locate);
      updateNode(row,{hidden:false});
      updateNode(details,{textContent:item.name+' · '+(bound?activityText[value]:'Source binding changed'),disabled},
        {'data-activity':bound?value:'unbound'});
      updateNode(locate,{disabled:!bound,textContent:'Show on plan · '+roomName(item.room),title:'Saved device location · '+roomName(item.room)},
        {'aria-label':'Show saved position of '+item.name+' in '+roomName(item.room)});sources++;
    }
    for(const [itemId,{row}] of activitySources){
      const hidden=!visibleSources.has(itemId);if(hidden)restoreActivityFocus(row);updateNode(row,{hidden});
    }
    updateNode($('homeActivityAll'),{},{'aria-pressed':String(!selected)});
    updateNode($('homeActivitySummary'),{textContent:!activityRooms.size?'Room sensing not configured':!haConnected?'Disconnected · activity unavailable':selected?
      roomName(selected)+' · '+(id?activityText[roomActivity(selected)]:'Room sensing not configured')+(sources?' · Select a source for details':id?' · Source details unavailable':''):
      `${detected} room${detected===1?'':'s'} with detection · ${signalOnly} signal only · ${unknown} unknown. Select a room for sources.`});
  }
  $('homeActivityAll').onclick=()=>selectHomeRoom('');
  $('homeToggleActivity').onclick=()=>{
    $('homeActivity').hidden=!$('homeActivity').hidden;
    $('homeToggleActivity').setAttribute('aria-expanded',String(!$('homeActivity').hidden));
    refreshActivity();requestAnimationFrame(()=>window.resizeModel?.());
  };
  const isMotion=item=>item.entity_id?.startsWith('binary_sensor.') && (receiverSpec(item) || model.motion_paths?.[item.id] || model.motion_sources?.[item.entity_id] || ['motion','occupancy','presence'].includes(haStates[item.entity_id]?.device_class));
  const coverIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 3h20M4 4v17h5V4m11 0v17h-5V4M7 5v13m10-13v13M9 16l-5-2m11 2 5-2"/></svg>';
  const isCover=item=>item.entity_id?.startsWith('cover.');
  const curtainStateFor=item=>deriveCurtainStatus(haStates[item.entity_id],haStates);
  let curtainItem=null,curtainDirty=false,curtainCheckCycle=null;
  const curtainCommands=new Map();
  const describeCurtain=item=>{const info=curtainStateFor(item);return (info.description||describeDeviceState(deviceDisplayState(item)))+(info.position!==null?` · ${info.remembered?'last known ':'HA reports '}${info.position}% open`:' · position unknown');};
  const isTV=item=>item.entity_id?.startsWith('media_player.');
  const isAudio=item=>isTV(item)&&item.type!=='tv'&&!model.tv_entities?.[item.id];
  const isLock=item=>item.entity_id?.startsWith('lock.');
  const lockStates=['locked','unlocked','locking','unlocking','jammed','open'];
  const lockIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path data-lock-shackle d="M8 10V6a4 4 0 0 1 8 0v4"/><path d="M12 14v3"/></svg>';
  const entityDomain=item=>item.entity_id?.split('.')[0]||'';
  const isToggle=item=>['light','switch','input_boolean','fan'].includes(entityDomain(item));
  const isGeneric=item=>!isToggle(item)&&!isMotion(item)&&!isTV(item)&&!isCover(item)&&!isLock(item);
  const isSupportedControl=item=>typeof item.entity_id==='string'&&item.entity_id.length<=150&&/^[a-z_]+\.[a-z0-9_]+$/.test(item.entity_id);
  const unavailableStates=['preview','disconnected','missing','unknown','unavailable','restored'];
  // Telemetry bound to a lamp-shaped object must not create a light source.
  const isLight=item=>entityDomain(item)==='light'||isToggle(item)&&['chandelier','lamp'].includes(item.type);
  const genericIcons={
    sensor:'<path d="M4 19a9 9 0 1 1 16 0M12 14l4-6"/><circle cx="12" cy="14" r="2"/>',
    binary_sensor:'<rect x="4" y="3" width="11" height="18" rx="1"/><path d="M18 5h2v14h-2M11 12h1"/>',
    climate:'<path d="M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0M12 9v9M18 5h3M18 9h2"/>',
    vacuum:'<circle cx="12" cy="12" r="9"/><path d="M6 15h12M9 8h6"/>',
  };
  const knownValue=(values,key)=>Object.hasOwn(values,key)?values[key]:null;
  const genericGlyph=item=>'<svg viewBox="0 0 24 24" aria-hidden="true">'+(knownValue(genericIcons,entityDomain(item))||'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>')+'</svg>';
  const deviceKind=item=>isMotion(item)?'motion':isTV(item)?'tv':isCover(item)?'cover':isLock(item)?'lock':isGeneric(item)?entityDomain(item):'control';
  const deviceGlyph=item=>receiverSpec(item)?'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/></svg>':isMotion(item)?motionIcon:isTV(item)?tvIcon:isCover(item)?coverIcon:isLock(item)?lockIcon:isGeneric(item)?genericGlyph(item):icon;
  const classLabels={temperature:'Temperature',humidity:'Humidity',battery:'Battery',battery_charging:'Battery charging',power:'Power',energy:'Energy',illuminance:'Illuminance',aqi:'Air quality',pm25:'PM2.5',pressure:'Pressure',atmospheric_pressure:'Atmospheric pressure',duration:'Duration',water:'Water',carbon_dioxide:'Carbon dioxide',door:'Door',window:'Window',opening:'Opening',smoke:'Smoke',moisture:'Moisture',gas:'Gas',problem:'Problem',safety:'Safety',tamper:'Tamper',connectivity:'Connectivity',lock:'Lock'};
  const boundedText=(value,length=200)=>typeof value==='string'?value.slice(0,length):'';
  function describeGeneric(item,state){
    if(unavailableStates.includes(state))return describeDeviceState(state);
    const entity=haStates[item.entity_id],domain=entityDomain(item);
    if(domain==='climate'){
      const climate=entity?.climate||{},unit=['°C','°F','K'].includes(climate.temperature_unit)?climate.temperature_unit:'';
      const temperature=value=>Number.isFinite(value)&&Math.abs(value)<=1000?String(Number(value.toFixed(1)))+(unit?' '+unit:''):null;
      const mode=knownValue({heat:'Heat mode',cool:'Cool mode',heat_cool:'Heat/cool mode',auto:'Automatic',dry:'Dry mode',fan_only:'Fan only',off:'Off'},state);
      const parts=[mode?vt(mode):boundedText(state).replaceAll('_',' ')];
      const current=temperature(climate.current_temperature),target=temperature(climate.temperature),low=temperature(climate.target_temp_low),high=temperature(climate.target_temp_high);
      if(current!==null)parts.push(vt('Current')+': '+current);
      if(target!==null)parts.push(vt('Target')+': '+target);
      else if(low!==null&&high!==null&&climate.target_temp_low<=climate.target_temp_high)parts.push(vt('Target')+': '+low+' – '+high);
      const action=knownValue({heating:'Heating',cooling:'Cooling',drying:'Drying',idle:'Idle',off:'Off',fan:'Fan running',preheating:'Preheating',defrosting:'Defrosting'},climate.hvac_action);
      if(action)parts.push(vt(action));
      return parts.join(' · ');
    }
    let value=boundedText(state).replaceAll('_',' ');
    const deviceClass=boundedText(entity?.device_class,60);
    if(domain==='binary_sensor'&&['on','off'].includes(state)){
      const pair=knownValue({door:['Open','Closed'],window:['Open','Closed'],opening:['Open','Closed'],lock:['Unlocked','Locked'],connectivity:['Connected','Disconnected'],problem:['Detected','Clear'],safety:['Unsafe','Safe'],smoke:['Detected','Clear'],gas:['Detected','Clear'],tamper:['Detected','Clear'],moisture:['Wet','Dry'],battery:['Low','Normal'],battery_charging:['Charging','Not charging']},deviceClass)||['On','Off'];
      value=vt(pair[state==='on'?0:1]);
    }else if(['on','off'].includes(state))value=describeDeviceState(state);
    if(domain==='sensor'){
      const unit=boundedText(entity?.unit,24);if(unit)value+=' '+unit;
    }
    const label=knownValue(classLabels,deviceClass);
    return label?vt(label)+': '+value:value;
  }
  function openEntityDetails(item){
    if(isSupportedControl(item)&&bridge&&haConnected&&haStates[item.entity_id]){
      cancelNativeHover();nativeHoverId=item.id;
      bridge.postMessage({type:'more_info',entity_id:item.entity_id});
    }
  }
  const deviceDisplayState = item => {
    if(!embedded)return 'preview';if(!haConnected)return 'disconnected';
    if(isMotion(item))return resolveMotionState(model.motion_sources?.[item.entity_id]||[item.entity_id],haStates);
    const entity=haStates[item.entity_id];if(!entity)return 'missing';if(entity.restored)return 'restored';
    const state=boundedText(entity.state)||'unknown';
    if(isGeneric(item))return state;
    if(isLock(item))return lockStates.includes(state)?state:'unavailable';
    if(isCover(item)&&['open','closed','opening','closing'].includes(state))return state;
    if(isTV(item)&&['playing','paused','idle','buffering'].includes(state))return 'on';
    return ['on','off'].includes(state)?state:'unavailable';
  };
  const describeDeviceState = state => vt(({on:'On',off:'Off',open:'Open',closed:'Closed',opening:'Opening',closing:'Closing',locked:'Locked',unlocked:'Unlocked',locking:'Locking',unlocking:'Unlocking',jammed:'Jammed',missing:'Entity not found',unknown:'Unknown',unavailable:'Unavailable',restored:'Restored state',disconnected:'Disconnected',preview:'Offline preview'})[state] || state);

  for (const room of model.rooms) {
    const option = document.createElement('option'); option.value = room.id; option.textContent = roomName(room.id); $('homeRoom').append(option);
    if(model.room_activity?.[room.id]){
      const button=document.createElement('button');button.onclick=()=>selectHomeRoom(room.id);
      activityRooms.set(room.id,button);$('homeActivityRooms').append(button);
    }
  }
  $('homeRoom').onchange = () => selectHomeRoom($('homeRoom').value);
  $('homeOtherFloor').onclick = () => $('otherFloor').click();
  $('editLayout').onclick = () => setActive(false);
  $('openHome').onclick = () => setActive(true);

  function resetZoom(){zoom=1;panX=panY=0;updateZoom();}
  function updateZoom(){
    previewTV(null);
    $('homeZoomReset').textContent=Math.round(zoom*100)+'%';
    $('homeZoomOut').disabled=zoom<=.65;$('homeZoomIn').disabled=zoom>=3;
    window.renderModel?.();
  }
  $('homeZoomIn').onclick=()=>{zoom=Math.min(3,zoom*1.25);updateZoom()};
  $('homeZoomOut').onclick=()=>{zoom=Math.max(.65,zoom/1.25);updateZoom()};
  $('homeZoomReset').onclick=resetZoom;
  function applyViewPreferences(value){
    viewerI18n.applyPreferences(value);
    if(typeof value.sidebarCollapsed!=='boolean')return;
    controlsCollapsed=value.sidebarCollapsed;
    $('homeControls').hidden=controlsCollapsed;
    document.querySelector('.home-layout').classList.toggle('controls-collapsed',controlsCollapsed);
    $('homeToggleControls').textContent=vt(controlsCollapsed?'Show controls':'Hide controls');
    $('homeToggleControls').setAttribute('aria-expanded',String(!controlsCollapsed));
    requestAnimationFrame(()=>window.resizeModel?.());
  }
  $('homeToggleControls').onclick=()=>{
    applyViewPreferences({sidebarCollapsed:!controlsCollapsed});
    bridge?.postMessage({type:'view_preferences',sidebarCollapsed:controlsCollapsed});
  };

  function attachRoomLighting() {
    const attach=()=>{roomLighting?.attach(root,active,{staticGeometry:true});roomLighting?.attach(objectGroup,active)};
    if(editorFloorMaterials)editorFloorMaterials.attachLighting(attach);else attach();
  }

  function setActive(value) {
    hideMediaControls();cancelNativeHover(true);
    active = value;previewTV(null);
    if(lowerFloorContext)lowerFloorContext.visible=value&&showLowerFloor&&!selected;
    document.body.classList.toggle('home-mode', value); $('homeView').hidden = !value;
    if (renderer) {
      (value ? $('homeStage') : $('view3d')).prepend(renderer.domElement);
      scene.background = new THREE.Color(value ? '#18242c' : '#e7e8df');
      // A dim base keeps unlit rooms readable while HA lights provide the contrast.
      hemisphere.intensity = value ? .16 : 1.8; sun.intensity = value ? .18 : 2.3;
      // Keep the Editor grid and real floors; omit its backdrop on the diffuse profile.
      ground.visible = !value && !renderProfile.diffuseLighting; grid.visible = !value;
      // Keep window heads visible.
      clipping.constant = value ? 2.1 : $('cutaway').checked ? 1.15 : 20;
      // Keep full-height shadow blockers when changing view modes.
      editorFloorMaterials?.setHomeActive(value);
      attachRoomLighting();
      updateFixtureShadows();
      for (const mesh of root.children) if (['fixtures','stairs'].includes(mesh.userData.category)) mesh.visible = value || $(mesh.userData.category).checked;
    }
    if (overlayGroup) overlayGroup.visible = value;
    if(!value)for(const point of points)clearTrail(point);
    if (!value) showMode(false);
    refreshControls();
    const before=window.floorplan?.renderCount;
    requestAnimationFrame(()=>{window.resizeModel?.();if(window.floorplan?.renderCount===before)window.requestModelRender?.()});
  }

  let nativeHoverTimer=null,nativeHoverId=null;
  function cancelNativeHover(reset=false){clearTimeout(nativeHoverTimer);nativeHoverTimer=null;if(reset)nativeHoverId=null;}
  function bindNativeHover(item,element){
    const enter=event=>{
      cancelNativeHover();
      if(event.pointerType!=='mouse'||event.buttons||nativeHoverId===item.id)return;
      nativeHoverTimer=setTimeout(()=>{
        if(!active||element.disabled||!element.isConnected||!element.matches(':hover')||!bridge||!haConnected)return;
        openEntityDetails(item);
      },650);
    };
    const leave=()=>cancelNativeHover();
    element.addEventListener('pointerenter',enter);element.addEventListener('pointerleave',leave);element.addEventListener('pointerdown',leave);
    return ()=>{element.removeEventListener('pointerenter',enter);element.removeEventListener('pointerleave',leave);element.removeEventListener('pointerdown',leave);};
  }
  // A dialog closing over the same marker must not immediately reopen it.
  document.addEventListener('pointermove',event=>{
    const target=event.target.closest?.('[data-home-item],[data-home-device],[data-home-details]');
    const id=target?.dataset.homeItem||target?.dataset.homeDevice||target?.dataset.homeDetails;
    if(id!==nativeHoverId)nativeHoverId=null;
  });
  window.addEventListener('pagehide',()=>{cancelNativeHover(true);discardMediaControls();});
  function rebuildControls() {
    hideMediaControls();cancelNativeHover(true);
    for(const point of points)for(const cleanup of point.controlCleanup||[])cleanup();
    applyCameraFrames();
    previewTV(null);
    for(const point of points)clearTrail(point);
    bindings = items.filter(isSupportedControl);
    restoreActivityFocus($('homeActivitySources'));clearActivityLocation();
    activitySources.clear();$('homeActivitySources').replaceChildren();
    $('homeDeviceList').replaceChildren(); $('homeMarkers').replaceChildren(); $('homeLabels').replaceChildren(); points = []; labels = [];
    if (scene) {
      if (overlayGroup) { overlayGroup.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); o.shadow?.dispose(); }); scene.remove(overlayGroup); }
      overlayGroup = new THREE.Group(); overlayGroup.visible = active; scene.add(overlayGroup);
    }
    for (const room of model.rooms) {
      const label = document.createElement('button'); label.className = 'home-room-label'; label.textContent = roomName(room.id);
      label.setAttribute('aria-label', vt('Focus room')+': '+roomName(room.id));
      label.onclick = () => selectHomeRoom(room.id);
      $('homeLabels').append(label);
      labels.push({el:label,room:room.id,position:new THREE.Vector3(xm(room.label[0]), .06, zm(room.label[1]))});
    }
    for (const item of bindings) {
      const glyph=deviceGlyph(item);
      const marker = document.createElement('button'); marker.className = 'home-marker'; marker.dataset.homeItem = item.id; marker.innerHTML = glyph;
      const card = document.createElement('button'); card.className = 'home-device'; card.dataset.homeDevice = item.id;
      const symbol = document.createElement('span'); symbol.className = 'home-device-icon'; symbol.innerHTML = glyph;
      const text = document.createElement('span'), name = document.createElement('span'), detail = document.createElement('span');
      name.className = 'home-device-name'; name.textContent = item.name; detail.className = 'home-device-detail'; text.append(name,detail); card.append(symbol,text);
      if(!isAudio(item)){marker.onclick = () => activateDevice(item);card.onclick = () => activateDevice(item,false);}
      let details;
      if(isToggle(item)){
        const row=document.createElement('div');row.className='home-device-row';
        details=document.createElement('button');details.className='home-device-details';details.dataset.homeDetails=item.id;
        details.onclick=()=>openEntityDetails(item);row.append(card,details);$('homeDeviceList').append(row);
      }else $('homeDeviceList').append(card);
      $('homeMarkers').append(marker);
      const position = new THREE.Vector3(item.position_m.x,item.position_m.y + item.dimensions_m.height / 2,item.position_m.z);
      const point = {item,marker,card,detail,details,position,object:objectsById.get(item.id),original:model.inventory.find(i=>i.id===item.id),duplicateControl:isCover(item)&&points.some(p=>p.item.entity_id===item.entity_id)}; points.push(point);
      point.controlCleanup=[marker,card].map(element=>isAudio(item)?bindMediaControlTrigger(item.id,element):bindNativeHover(item,element));
      const anchor=objectsById.get(model.control_anchors?.[item.id]);
      if(anchor)point.anchor=anchor.localToWorld(new THREE.Vector3(0,.5,.5));
      else if(isMotion(item))point.anchor=position.clone().setY(.12);
      for(const el of [marker,card])el.dataset.kind=deviceKind(item);
      const room = model.rooms.find(r => r.id === item.room);
      if (overlayGroup && room && isLight(item)) {
        const shape = new THREE.Shape(room.polygon.map(([x,z]) => new THREE.Vector2(xm(x),-zm(z))));
        const material = new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,
          uniforms:{center:{value:new THREE.Vector2(position.x,position.z)},lightColor:{value:new THREE.Color()},brightness:{value:0}},
          vertexShader:'varying vec3 world; void main(){vec4 p=modelMatrix*vec4(position,1.0);world=p.xyz;gl_Position=projectionMatrix*viewMatrix*p;}',
          fragmentShader:'varying vec3 world; uniform vec2 center; uniform vec3 lightColor; uniform float brightness; void main(){float a=.22*brightness*exp(-.13*dot(world.xz-center,world.xz-center));gl_FragColor=vec4(lightColor,a);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}' });
        const overlay = new THREE.Mesh(new THREE.ShapeGeometry(shape),material); overlay.rotation.x=-Math.PI/2; overlay.position.y=.035; overlay.renderOrder=2;
        const light = new THREE.PointLight(0xfff4e2,0,7,2); light.position.copy(position); light.position.y=Math.min(2.3,Math.max(.12,position.y));
        light.shadow.camera.near=.05; light.shadow.bias=-.0001; light.shadow.normalBias=.015;
        // Reuse shadow maps until their casters change.
        overlayGroup.add(overlay,light); point.overlay=overlay; point.light=light;
      }
    }
    const lights=points.filter(point=>point.light).map(point=>point.light),lightCount=lights.length;
    configurePointShadows(lights, renderer?.capabilities, renderProfile);
    if(renderer && (!roomLighting || roomLighting.capacity<lightCount)){roomLighting?.dispose();roomLighting=createRoomLighting(THREE,model.rooms.map(room=>({...room,exterior:(model.exterior_rooms||[]).includes(room.id),polygon:room.polygon.map(([x,z])=>[xm(x),zm(z)])})),lightCount,daylightWindows,{packed:renderProfile.diffuseLighting===true,maxFragmentUniforms:renderer.capabilities.maxFragmentUniforms,literalLambertDirectional:true,literalLambertPointBody:true,literalLambertShadowPoint:true,literalLambertIndirect:true,directShadowUniforms:true,scalarLambertAccumulators:true,pointDecayTwo:true,pointTexture:true,runTexture:true,geometryTexture:true,signalTexture:true,maxTextureSize:renderer.capabilities.maxTextureSize,maxTextures:renderer.capabilities.maxTextures});}
    attachRoomLighting();
    updateFixtureShadows();
  }

  function updateDaylight() {
    const state=haConnected?haStates['sun.sun']:null;
    let daylight=0;
    if(state && ['above_horizon','below_horizon'].includes(state.state)){
      const elevation=state.sun?.elevation;
      const t=Number.isFinite(elevation)?Math.max(0,Math.min(1,(elevation+6)/41)):(state.state==='above_horizon'?1:0);
      daylight=t*t*(3-2*t);
    }
    const transmission=daylightWindows.map(window=>{
      const channels=new Map();
      for(const item of bindings.filter(isCover)){
        const spec=model.cover_windows?.[item.id];
        if(!spec?.openings.includes(window.id))continue;
        const position=curtainStateFor(item).position;
        if(position===null)continue;
        const openness=Math.max(0,Math.min(1,position/100));
        channels.set(item.entity_id,(spec.sheer ? .55 : .08)+(spec.sheer ? .45 : .92)*openness);
      }
      return [...channels.values()].reduce((a,b)=>a*b,1);
    });
    roomLighting?.environment(daylight,transmission);
  }

  function updateFixtureShadows() {
    invalidateShadows();
    const emitters=new Set(bindings.filter(isLight).map(item=>item.id));
    for (const object of objectGroup?.children || []) object.traverse(mesh => {
      if (!mesh.isMesh) return;
      // A single proxy emitter sits inside its fixture; the fixture must not hide it.
      mesh.castShadow=mesh!==object.userData.screen && mesh.material.opacity===1 && !(active && emitters.has(object.userData.id));
    });
  }

  function refreshControls() {
    if(model.assumed_activity){
      assumedZones?.setVisible(active&&$('homeSignalToggle').checked,$('homeSignals').open);
      assumedZones?.update(haStates[model.assumed_activity.sensor],haConnected);
      refreshSignalStatus();
    }
    const connected = embedded && haConnected;
    $('homeConnection').textContent = !embedded ? vt('Offline preview') : '● '+vt(connected ? 'Live' : 'Disconnected');
    $('homeConnection').dataset.connected = String(connected);
    let on=0, motion=0, unavailable=0, total=0; const counted=new Set();
    for (const point of points) {
      const {item,marker,card,detail} = point, sensing=receiverSpec(item)?receiverState(item):null;
      const state=sensing?['motion','presence','unverified_motion','unverified_presence'].includes(sensing)?'on':['quiet','unverified_quiet'].includes(sensing)?'off':'unavailable':deviceDisplayState(item), waiting=pending.get(item.entity_id);
      const kind=deviceKind(item);
      if(marker.dataset.kind!==kind){
        const glyph=deviceGlyph(item);marker.innerHTML=glyph;card.querySelector('.home-device-icon').innerHTML=glyph;
        for(const el of [marker,card])el.dataset.kind=kind;
        if(isMotion(item)&&!point.anchor)point.anchor=point.position.clone().setY(.12);
      }
      const visible=!selected || selected===item.room;
      card.hidden = marker.hidden = !visible || point.duplicateControl;
      if(point.details)point.details.parentElement.hidden=card.hidden;
      if(isMotion(item) && !selected && state!=='on')marker.hidden=true;
      const enabled=isGeneric(item)?!unavailableStates.includes(state):isLock(item)?lockStates.includes(state):['on','off','open','closed','opening','closing'].includes(state);
      if (waiting && state !== waiting.before && enabled) { clearTimeout(waiting.timer); pending.delete(item.entity_id); }
      const busy=pending.has(item.entity_id)||curtainCommands.has(item.entity_id);
      const appearance=resolveLightAppearance(haStates[item.entity_id]);
      if(isCover(item)){
        const {position,seconds}=curtainStateFor(item);
        marker.dataset.countdown=seconds?`${seconds}s`:'';
        if(position!==point.curtainPosition){
          const anchor=updateCurtainFabric(point.object,item,model.cover_windows?.[item.id],position,model.openings,point.original);
          if(anchor)point.position.copy(anchor);
          point.curtainPosition=position;
          invalidateShadows();
        }
      }
      const description=(isGeneric(item)?describeGeneric(item,state):sensing?activityText[sensing]||activityText.unknown:isCover(item)?describeCurtain(item):isMotion(item)&&enabled?vt(state==='on'?'Motion detected':'No detection'):isTV(item)&&enabled?haStates[item.entity_id].state:describeDeviceState(state))+(isLight(item) && state==='on' && appearance.percent!==null?' · '+appearance.percent+'%':'')+
        (isLight(item) && state==='on' && appearance.kelvin?' · '+appearance.kelvin+' K':'');
      for (const button of [marker,card]) {
        button.dataset.activity=sensing||'';
        button.style.setProperty('--light-rgb',appearance.rgb.join(','));
        button.style.setProperty('--light-level',String(appearance.brightness));
        button.style.setProperty('--light-fill-rgb',appearance.indicatorRGB.join(','));
        button.style.setProperty('--light-text',appearance.text);
        button.dataset.state=state; button.disabled=(isGeneric(item)||isTV(item)||isMotion(item)||isCover(item)||isLock(item)?!haConnected||(!receiverSpec(item)&&!haStates[item.entity_id]):!enabled) || busy || !bridge;
        if(isLock(item)||isGeneric(item))button.removeAttribute('aria-pressed');
        else button.setAttribute('aria-pressed',String(state==='on'));
        button.setAttribute('aria-busy',String(busy));
        button.setAttribute('aria-label',busy?vt('{name}: {state}; waiting for confirmation',{name:item.name,state:description}):`${item.name}: ${description}`);
        button.title=`${roomName(item.room)} · ${item.name} · ${description}`;
      }
      if(point.details){
        point.details.textContent=vt('Details');point.details.setAttribute('aria-label',vt('Details')+': '+item.name);
        point.details.disabled=!bridge||!haConnected||!haStates[item.entity_id];
      }
      if(isLock(item)&&point.lockState!==state){
        point.lockState=state;
        for(const button of [marker,card])button.querySelector('[data-lock-shackle]').setAttribute('d',
          ['unlocked','unlocking','open'].includes(state)?'M8 10V6a4 4 0 0 1 8 0':'M8 10V6a4 4 0 0 1 8 0v4');
      }
      detail.textContent=roomName(item.room)+' · '+(busy ? vt('Waiting for confirmation…') : description);
      if(isMotion(item)&&!receiverSpec(item)){
        const zones=model.motion_zones?.[item.id],reading=haStates[zones?.entity_id];
        const room=zones?item.entity_id===point.original.entity_id?resolveMotionRoom(zones,reading):null:item.room;
        const next=nextMotionRoom(point,state,room,active);
        if(next&&(!point.trail||point.trailRoom!==next))startTrail(point,next);
        if(!enabled||zones&&!room)clearTrail(point);
        if(point.trail)point.trail.hidden=!!selected&&selected!==point.trailRoom;
      }
      if (point.overlay) {
        const color=new THREE.Color().setRGB(...appearance.rgb.map(c=>c/255),THREE.SRGBColorSpace);
        // Keep a stable shader slot for every fixture. Hiding a point light
        // changes Three's light/shadow counts and recompiles material programs.
        point.light.color.copy(color); point.light.intensity=state==='on'?12*appearance.brightness:0;
        point.overlay.material.uniforms.lightColor.value.copy(color);
        point.overlay.material.uniforms.brightness.value=appearance.brightness;
        point.overlay.visible=state==='on';
      }
      if (visible && !counted.has(item.entity_id)) { counted.add(item.entity_id);total++; if(state==='on'){if(isMotion(item))motion++;else on++;} if(!enabled)unavailable++; }
    }
    refreshTVPreviews();
    updateTelemetryPreviews(haStates,haConnected);
    updateDaylight();
    updateCurtainDialog();
    refreshActivity();
    for (const label of labels) {
      label.power=roomPowerText(label.room,selected);
      label.el.hidden=!!selected&&(label.room!==selected||!label.power);
      const value=activityState(model.room_activity?.[label.room]);
      label.el.dataset.activity=value||'unknown';
      label.el.title=roomName(label.room)+(label.power?' · '+label.power:'')+' · '+(activityText[value]||activityText.unknown);
      label.el.setAttribute('aria-description',label.el.title);
    }
    $('homeSummary').textContent=vt('{on} on · {total} linked · {motion} active sensors · {unavailable} unavailable',{on,total,motion,unavailable});
    $('homeEmpty').hidden=total>0;
    $('homeFeedback').textContent=errorText([...errors.values()].at(-1))||(!renderer ? vt('The 3D view is unavailable in this browser. Use the device cards to control your lights.') : '');
    $('homeFeedback').hidden=!$('homeFeedback').textContent;
    if(moduleItem)updateModuleDialog();
    // Run the clock only through warm-up, including its transition to zero.
    clearTimeout(countdownTimer);
    if((active||$('curtainDialog').open)&&points.some(p=>isCover(p.item)&&curtainStateFor(p.item).seconds>0))countdownTimer=setTimeout(()=>{refreshControls();window.renderModel?.();},1000);
  }

  function refreshTVPreviews(){
    updateTVPreviews(bindings.filter(isTV).map(item=>({item,state:deviceDisplayState(item),
      busy:pending.has(item.entity_id),enabled:!!(bridge&&haConnected&&haStates[item.entity_id]),media:haStates[item.entity_id]?.restored?null:haStates[item.entity_id]?.media,
      command:(action,value,request_id)=>bridge?.postMessage({type:'media_command',entity_id:item.entity_id,action,...(value!==undefined?{value}:{}),request_id}),
      details:()=>openEntityDetails(item),power:()=>activateDevice(item,false,true)})));
  }
  function activateDevice(item,quick=true,tvPower=false) {
    const state=deviceDisplayState(item);
    if(!tvPower&&isAudio(item)){const anchor=points.find(point=>point.item.id===item.id)?.marker;if(showMediaControls(item.id,anchor,{focus:true}))return;}
    if(receiverSpec(item)&&bridge&&haConnected){inspectActivitySource(item);return;}
    if(isCover(item)&&bridge&&haConnected){curtainItem=item;curtainDirty=false;curtainCheckCycle=null;curtainError=null;$('curtainChecked').checked=false;$('curtainError').hidden=true;updateCurtainDialog();$('curtainDialog').showModal();const action=curtainStateFor(item).action;if(quick&&action)curtainCommand(action);return;}
    // Locks always use HA's explicit lock/unlock controls, never a toggle.
    if(bridge && haConnected && haStates[item.entity_id] && !tvPower && (isGeneric(item)||isTV(item)||isMotion(item)||isLock(item))){openEntityDetails(item);return;}
    if ((!tvPower&&!isToggle(item)) || !bridge || !haConnected || !['on','off'].includes(state) || pending.has(item.entity_id)) return;
    errors.delete(item.entity_id);
    const request_id='home_'+(++sequence);
    const timer=setTimeout(() => {
      if(pending.get(item.entity_id)?.request_id!==request_id)return;
      pending.delete(item.entity_id); errors.set(item.entity_id,{key:'{name}: state change was not confirmed. Check the device before trying again.',params:{name:item.name}}); refreshControls();
    },12000);
    pending.set(item.entity_id,{request_id,before:state,timer});
    bridge.postMessage({type:tvPower?'tv_power':'toggle',...(tvPower?{action:state==='on'?'turn_off':'turn_on'}:{}),entity_id:item.entity_id,request_id}); refreshControls();
  }

  function handleCommandResult(message) {
    if(curtainCommands.get(message.entity_id)===message.request_id){
      curtainCommands.delete(message.entity_id);
      if(curtainItem?.entity_id===message.entity_id)curtainError=message.ok ? null : commandError(message);
      refreshControls();
      return;
    }
    const entry=pending.get(message.entity_id);
    if(!entry || entry.request_id!==message.request_id || message.ok)return;
    clearTimeout(entry.timer); pending.delete(message.entity_id);
    errors.set(message.entity_id,commandError(message)); refreshControls();
  }

  function updateCurtainDialog(){
    if(!curtainItem)return;
    $('curtainError').hidden=!curtainError;
    $('curtainError').textContent=errorText(curtainError);
    const info=curtainStateFor(curtainItem),entity=haStates[curtainItem.entity_id],features=entity?.cover?.supported_features||0;
    const ready=info.ready&&haConnected&&!curtainCommands.has(curtainItem.entity_id);
    $('curtainTitle').textContent=curtainItem.name;
    $('curtainStatus').textContent=haConnected?describeCurtain(curtainItem):'Disconnected · controls unavailable';
    $('curtainAccuracy').textContent=info.accuracy+(info.checkedAt?' · '+new Date(info.checkedAt).toLocaleString():'');
    const cycle=entity?.cover?.power_on_at||info.poweredOff;
    if(curtainCheckCycle!==cycle){curtainCheckCycle=cycle;$('curtainChecked').checked=false;}
    $('curtainRecordCheck').disabled=!ready||info.remembered||!(features&4)||!$('curtainChecked').checked;
    const guard=entity?.cover?.guard;
    $('curtainPower').hidden=!guard||haStates[guard]?.state==='on';
    $('curtainPower').textContent=`Power on · ${haStates[guard]?.name||guard} · ${info.seconds?info.seconds+'s':info.canPowerOn?'wait 50s':'unavailable'}`;
    $('curtainPower').disabled=!haConnected||!info.canPowerOn||curtainCommands.has(curtainItem.entity_id);
    for(const [id,feature] of [['curtainOpen',1],['curtainClose',2],['curtainStop',8],['curtainPosition',4],['curtainApply',4]])$(id).disabled=!ready||!(features&feature);
    if(!curtainDirty){$('curtainPosition').value=info.position??50;$('curtainPercent').textContent=info.position===null?'Unknown':info.position+'%';}
  }
  function curtainCommand(action){
    if(!curtainItem||!bridge||!haConnected)return;
    const entity_id=curtainItem.entity_id,info=curtainStateFor(curtainItem);
    if(curtainCommands.has(entity_id)||(action==='power_on'?!info.canPowerOn:!info.ready))return;
    const feature={open_cover:1,close_cover:2,stop_cover:8,set_cover_position:4}[action];
    if(feature&&!(haStates[entity_id]?.cover?.supported_features&feature))return;
    if(action==='record_position_check'&&(!$('curtainChecked').checked||info.remembered))return;
    const request_id='curtain_'+(++sequence);curtainCommands.set(entity_id,request_id);
    curtainError=null;
    $('curtainError').hidden=true;
    bridge.postMessage({type:'curtain_command',entity_id,action,request_id,...(action==='set_cover_position'?{position:Number($('curtainPosition').value)}:{})});
    refreshControls();
    setTimeout(()=>{if(curtainCommands.get(entity_id)!==request_id)return;curtainCommands.delete(entity_id);if(curtainItem?.entity_id===entity_id)curtainError={key:'Command confirmation timed out. Check device state before retrying.'};refreshControls();},15000);
  }
  $('curtainChecked').onchange=updateCurtainDialog;
  $('curtainRecordCheck').onclick=()=>curtainCommand('record_position_check');
  $('curtainPosition').oninput=()=>{curtainDirty=true;$('curtainPercent').textContent=$('curtainPosition').value+'%';};
  for(const [id,action] of [['curtainPower','power_on'],['curtainOpen','open_cover'],['curtainClose','close_cover'],['curtainStop','stop_cover'],['curtainApply','set_cover_position']])$(id).onclick=()=>curtainCommand(action);
  $('curtainDetails').onclick=()=>{if(curtainItem){bridge?.postMessage({type:'more_info',entity_id:curtainItem.entity_id});$('curtainDialog').close();}};
  // Advance the receipt clock monotonically even if wall time moves backward.
  // Repeated states, dialog reopening and rerenders cannot restart a lease.
  let moduleWall=Date.now(),moduleMono=performance.now(),moduleTimer;
  const moduleLeases=new Map();
  function updateModuleDialog(){
    clearTimeout(moduleTimer);moduleTimer=null;
    const mono=performance.now();
    moduleWall=Math.max(Date.now(),moduleWall+mono-moduleMono);moduleMono=mono;
    const item=items.find(item=>item.id===moduleItem?.id),spec=item&&receiverSpec(item);
    const same=spec&&spec.entity_id===item.entity_id&&spec.room===item.room;
    const unavailable=!item?'Receiver removed from plan':!same?'Receiver binding changed':null;
    const entity=same&&haConnected?haStates[spec.modules_sensor]:null;
    $('moduleTitle').textContent=item?.name||moduleItem?.name||'Receiver';
    $('moduleActivity').textContent=unavailable||activityText[receiverState(item)]||activityText.unknown;
    const info=entity&&!entity.restored&&!['unknown','unavailable'].includes(entity.state)?entity.modules:null;
    let expiry=info?.expires_at_ms;
    const snapshot=info?.snapshot_at_ms,count=info?.fresh_count,last=moduleLeases.get(spec?.modules_sensor);
    const valid=Number.isSafeInteger(expiry)&&Number.isSafeInteger(snapshot)&&snapshot>0&&
      Number.isInteger(count)&&count>=0&&count<=64&&snapshot<=moduleWall+250&&
      expiry>snapshot&&expiry<=snapshot+2000&&expiry<=moduleWall+2000;
    if(valid&&entity?.state==='experimental'){
      // Counts only fall within one source snapshot as outputs expire. Keep
      // one watermark per receiver; replay cannot reintroduce expired outputs.
      if(last&&(snapshot<last.snapshot||snapshot===last.snapshot&&count>last.count))expiry=0;
      else{
        if(last&&snapshot===last.snapshot&&count===last.count)expiry=Math.min(expiry,last.expiry);
        moduleLeases.set(spec.modules_sensor,{snapshot,count,expiry});
      }
    }
    const fresh=entity?.state==='experimental'&&valid&&expiry>moduleWall;
    const summary=entity?.state==='experimental'?!valid?'Algorithm diagnostics unavailable':!fresh?'Algorithm diagnostics expired':info.summary:
      entity?.state==='stale'?'Algorithm diagnostics expired':null;
    $('moduleSummary').textContent=!haConnected?'Disconnected':unavailable||summary||'Algorithm diagnostics unavailable';
    $('moduleDetails').textContent=fresh?info.details:'No current algorithm data. Room activity is shown separately.';
    if(fresh&&$('moduleDialog').open)moduleTimer=setTimeout(updateModuleDialog,expiry-moduleWall);
  }
  $('moduleDialog').addEventListener('close',()=>{if(!$('moduleDialog').open){clearTimeout(moduleTimer);moduleTimer=null;}});
  document.addEventListener('visibilitychange',()=>{if(moduleItem)updateModuleDialog();});
  window.addEventListener('pageshow',()=>{if(moduleItem)updateModuleDialog();});
  window.addEventListener('pagehide',()=>{clearTimeout(moduleTimer);moduleTimer=null;});
  function dismissOnBackdrop(dialog){
    const outside=e=>{const r=dialog.getBoundingClientRect();return e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom;};
    let pressed=false;
    dialog.onpointerdown=e=>{pressed=outside(e);};
    dialog.onclick=e=>{if(pressed&&outside(e)){e.stopPropagation();dialog.close();}pressed=false;};
  }
  dismissOnBackdrop($('curtainDialog'));
  dismissOnBackdrop($('moduleDialog'));

  // A fade changes only material alpha and its text alternatives. Reuse the
  // current camera, lights and control positions instead of laying out again.
  function drawSignalFrame(redraw){
    if(!active||!camera||!renderer)return;
    refreshSignalStatus();
    if(redraw){
      // A state update can change lights before its scheduled full frame.
      if(roomLighting?.geometryMode==='packed')roomLighting.update(points,camera);
      drawScene(camera);renderCount++;
    }
  }
  function render() {
    if(!active || !renderer)return;
    const rect=$('homeStage').getBoundingClientRect(); if(!rect.width || !rect.height)return;
    camera ??= new THREE.OrthographicCamera(-1,1,1,-1,.1,Math.max(150,planRadius*5));
    // Room geometry is fixed for this viewer. Panning, live states and media
    // frames reuse its fit instead of allocating/projecting every vertex again.
    const landscape=rect.width>rect.height*1.2;
    if (!cameraFit || cameraFit.room!==selected || cameraFit.landscape!==landscape) {
      const rooms=selected ? model.rooms.filter(r=>r.id===selected) : model.rooms;
      const vertices=rooms.flatMap(r=>r.polygon.map(([x,z])=>new THREE.Vector3(xm(x),0,zm(z))));
      const box=new THREE.Box3().setFromPoints(vertices), center=box.getCenter(new THREE.Vector3()); center.y=planBounds?model.ceiling_height_m/2:.6;
      // Opposite-side view: fit landscape sideways and phones lengthwise, with labels upright.
      const offset=landscape ? new THREE.Vector3(-22,27,-7) : new THREE.Vector3(-6,28,-18);
      if(planBounds)offset.multiplyScalar(Math.max(1,planRadius/32));
      camera.up.set(0,1,0); camera.position.copy(center).add(offset); camera.lookAt(center); camera.updateMatrixWorld();
      const bounds=new THREE.Box3().setFromPoints(vertices.flatMap(v=>[v,v.clone().setY(model.ceiling_height_m)]).map(v=>v.applyMatrix4(camera.matrixWorldInverse)));
      cameraFit={room:selected,landscape,width:bounds.max.x-bounds.min.x,height:bounds.max.y-bounds.min.y,
        x:(bounds.min.x+bounds.max.x)/2,y:(bounds.min.y+bounds.max.y)/2};
    }
    const aspect=rect.width/rect.height;
    const half=Math.max(cameraFit.height/2,cameraFit.width/aspect/2)*1.15/zoom;
    const cx=cameraFit.x+panX, cy=cameraFit.y+panY;
    camera.left=cx-half*aspect;camera.right=cx+half*aspect;camera.top=cy+half;camera.bottom=cy-half;camera.updateProjectionMatrix();
    if(lowerFloorContext)lowerFloorContext.visible=showLowerFloor&&!selected;
    $('homeFloorContext').disabled=!!selected;
    assumedZones?.render(selected,signalZone);refreshSignalStatus();
    roomLighting?.update(points,camera);
    drawScene(camera);renderCount++;
    for(const label of labels) label.el.textContent=(rect.width<600 ? roomCode(label.room) : roomName(label.room))+(label.power?' · '+label.power:'');
    for(const point of [...labels,...points.map(p=>({el:p.marker,position:p.anchor||(!isCover(p.item)&&model.control_groups?.[p.item.id]?p.position.clone().setY(p.item.position_m.y+p.item.dimensions_m.height):p.position)}))]) {
      const p=projectedPosition.copy(point.position).project(camera);
      point.el.style.left=((p.x+1)*rect.width/2)+'px'; point.el.style.top=((1-p.y)*rect.height/2)+'px';
    }
    // Separate controls for two bulbs in one fitting without moving its geometry.
    const groups=new Map();
    for(const point of points){const group=model.control_groups?.[point.item.id];if(group&&!isCover(point.item)){if(!groups.has(group))groups.set(group,[]);groups.get(group).push(point);}}
    for(const group of groups.values())group.forEach((point,i)=>point.marker.style.left=(parseFloat(point.marker.style.left)+(i-(group.length-1)/2)*28)+'px');
    for(const point of points)for(const step of point.steps||[]){
      const p=projectedPosition.copy(step.position).project(camera),q=projectedForward.copy(step.forward).project(camera);
      step.el.style.left=((p.x+1)*rect.width/2)+'px';step.el.style.top=((1-p.y)*rect.height/2)+'px';
      step.el.style.setProperty('--angle',(Math.atan2(-(q.y-p.y)*rect.height,(q.x-p.x)*rect.width)*180/Math.PI+90)+'deg');
    }
    positionMediaPreviews(camera,rect,selected);
  }

  function clearTrail(point){clearTimeout(point.trailTimer);point.trail?.remove();point.trail=null;point.steps=[];}
  function startTrail(point,room){
    clearTrail(point);
    const zones=model.motion_zones?.[point.item.id],sourcePath=zones?.paths[room]||model.motion_paths?.[point.item.id];if(!sourcePath)return;
    const original=point.original,current=point.item;
    const rotation=(current.rotation_deg-original.rotation_deg)*Math.PI/180,c=Math.cos(rotation),s=Math.sin(rotation);
    const path=zones?sourcePath:sourcePath.map(([x,z])=>{x-=original.position_m.x;z-=original.position_m.z;return [current.position_m.x+x*c+z*s,current.position_m.z-x*s+z*c]});
    const polygon=model.rooms.find(r=>r.id===room)?.polygon.map(([x,z])=>[xm(x),zm(z)]);
    if(!polygon)return;
    const trail=point.trail=document.createElement('div');trail.dataset.motionTrail=point.item.id;
    trail.dataset.room=point.trailRoom=room;
    $('homeMotion').append(trail);
    for(let i=0;i<6;i++){
      const t=i/5,dx=path[1][0]-path[0][0],dz=path[1][1]-path[0][1],length=Math.hypot(dx,dz),side=i%2?1:-1;
      const x=path[0][0]+t*dx+side*dz/length*.065,z=path[0][1]+t*dz-side*dx/length*.065;
      if(!inPoly(x,z,polygon))continue;
      const el=document.createElement('span');el.className='home-footstep';el.style.setProperty('--delay',i*.28+'s');
      el.innerHTML='<svg viewBox="0 0 14 28"><path d="M7 1C2 1 1 5 2 11c.5 4 2 7 5 7s5-4 5-9c0-5-1-8-5-8ZM4 21h6l1 4c-1 3-7 3-8 0Z"/></svg>';
      if(i%2)el.classList.add('right');trail.append(el);
      point.steps.push({el,position:new THREE.Vector3(x,.06,z),forward:new THREE.Vector3(x+dx/length,.06,z+dz/length)});
    }
    point.trailTimer=setTimeout(()=>clearTrail(point),7800);
  }

  // Magnify the existing frame; hovering never requests another capture.
  const tvControl=Object.keys(tvEntities).map(id=>`[data-home-item="${id}"],[data-home-device="${id}"]`).join(',');
  const tvId=el=>el?.dataset.homeItem||el?.dataset.homeDevice;
  const hoverRay=new THREE.Raycaster();
  $('homeView').addEventListener('pointermove',e=>{
    if(!active||e.pointerType!=='mouse'||e.buttons){previewTV(null);return;}
    let id=tvControl?tvId(e.target.closest(tvControl)):null;
    if(!id&&e.target===renderer?.domElement&&camera){
      const r=renderer.domElement.getBoundingClientRect();
      hoverRay.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,1-(e.clientY-r.top)/r.height*2),camera);
      const tvs=Object.keys(tvEntities).map(id=>objectsById.get(id)).filter(tv=>tv?.userData.screen?.visible);
      let hit=hoverRay.intersectObjects(tvs,true)[0]?.object;
      while(hit&&!hit.userData.id)hit=hit.parent;
      id=hit?.userData.id;
    }
    previewTV(id?{id,x:e.clientX,y:e.clientY}:null);
  });
  for(const event of ['pointerleave','pointerdown','focusout'])$('homeView').addEventListener(event,()=>previewTV(null));
  $('homeView').addEventListener('focusin',e=>{if(tvControl&&e.target.matches(tvControl)){const r=e.target.getBoundingClientRect();previewTV({id:tvId(e.target),x:r.left,y:r.bottom});}});
  function dismissOverlays(){hideMediaControls();previewTV(null);cancelNativeHover();}
  document.addEventListener('keydown',e=>{if(e.key==='Escape')dismissOverlays();});
  document.addEventListener('scroll',()=>previewTV(null),true);
  window.addEventListener('resize',()=>previewTV(null));
  if(renderer) {
    let start=null;
    renderer.domElement.addEventListener('pointerdown',e=>{if(active && e.button===0){start={x:e.clientX,y:e.clientY,lastX:e.clientX,lastY:e.clientY};renderer.domElement.setPointerCapture(e.pointerId);}});
    renderer.domElement.addEventListener('pointermove',e=>{if(!start || !active || !camera)return;
      if(Math.hypot(e.clientX-start.x,e.clientY-start.y)>6)start.moved=true;
      if(start.moved){const rect=renderer.domElement.getBoundingClientRect();panX-=(e.clientX-start.lastX)*(camera.right-camera.left)/rect.width;panY+=(e.clientY-start.lastY)*(camera.top-camera.bottom)/rect.height;window.requestModelRender?.(true);}
      start.lastX=e.clientX;start.lastY=e.clientY;});
    renderer.domElement.addEventListener('pointercancel',()=>start=null);
    renderer.domElement.addEventListener('pointerup',e=>{
      const previous=start;start=null;
      if(!active || !camera || !previous || previous.moved || Math.hypot(e.clientX-previous.x,e.clientY-previous.y)>6)return;
      const rect=renderer.domElement.getBoundingClientRect(),ray=new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2((e.clientX-rect.left)/rect.width*2-1,1-(e.clientY-rect.top)/rect.height*2),camera);
      const hit=ray.intersectObjects(objectGroup.children,true)[0];let object=hit?.object;
      while(object && !object.userData.id)object=object.parent;
      const item=bindings.find(i=>i.id===object?.userData.id);
      if(item && (!selected || item.room===selected))activateDevice(item);
    });
  }
  const signalText={active:'Signal changes · approximate zones',fading:'Recent signal · fading',quiet:'No elevated signal',warming_up:'Learning ambient signal',off:'Hidden',unknown:'No fresh signal data'};
  const signalReasons={
    active:'Bright blue highlights recent signal changes, not probability.',
    fading:'Recent activity fades over 15 seconds from its observation. New activity restores brightness.',
    quiet:'No elevated signal was reported. This does not establish that a room is empty.',
    warming_up:'Learning the recent ambient baseline before reporting signal changes.',
    source_unavailable:'No usable live signal source is available.',
    required_node_unavailable:'Blue zones need all three receivers. Waiting for device checks or fresh measurements.',
    source_expired:'The previous observation expired. Waiting for fresh signal data.',
    receiver_binding_changed:'A receiver no longer matches its configured position. Check its placement.',
    invalid_source:'Source data did not pass validation. Waiting for usable data.',
    geometry_mismatch:'Signal geometry differs from this plan. Reload the plan to check for an update.',
    display_unavailable:'The 3D view is unavailable in this browser.',
    disconnected:'Home Assistant is disconnected. Waiting to reconnect.'
  };
  function refreshSignalStatus(){
    if(!model.assumed_activity)return;
    const entity=haStates[model.assumed_activity.sensor],value=entity?.zone_activity;
    let reason=!haConnected?'disconnected':entity?.restored?'source_unavailable':entity?.signal_status;
    if(!Object.hasOwn(signalReasons,reason))reason='source_unavailable';
    if(reason==='active')reason=entity?.state!=='active'||!value?'invalid_source':
      value.geometry_sha256!==model.assumed_activity.geometry_sha256?'geometry_mismatch':
      !assumedZones?'display_unavailable':!assumedZones.hasFreshObservation?'source_expired':'active';
    if(['quiet','source_expired'].includes(reason)&&model.assumed_activity.zones.some(zone=>assumedZones?.intensity(zone.zone_id)>0))reason='fading';
    const available=['active','fading','quiet'].includes(reason),hidden=!$('homeSignalToggle').checked,status=hidden?'off':['active','fading','quiet','warming_up'].includes(reason)?reason:'unknown';
    updateNode($('homeSignals'),{},{'data-state':status,'data-reason':reason});
    updateNode($('homeSignalStatus'),{textContent:!hidden&&reason==='required_node_unavailable'?'Waiting for receivers':signalText[status]});
    let explanation=reason==='active'&&selected&&!model.assumed_activity.zones.some(zone=>zone.room_id===selected)?
      'No signal region is configured for this room. Choose Whole floor or a signal room to view fresh data.':signalReasons[reason];
    if(reason==='required_node_unavailable'){
      const names=model.assumed_activity.receiver_names||{},causes={device_check_failed:'device check failed',signal_stale:'signal is stale',checking_device:'checking device',unavailable:'unavailable'};
      const issues=entity.receiver_issues||[];
      explanation+=' '+issues.map(row=>(names[row.node_id]||'Receiver '+row.node_id)+': '+causes[row.reason]).join('; ');
    }
    updateNode($('homeSignalReason'),{textContent:hidden?'Blue zones are hidden. Enable them to show fresh signal changes.':explanation});
    updateNode($('homeSignalAll'),{},{'aria-pressed':String(!selected&&!signalZone)});
    for(const [zoneId,{row,button,meter,detail}] of signalRegions){
      const seconds=available?assumedZones?.secondsRemaining(zoneId)||0:0;
      updateNode(button,{},{'aria-pressed':String(zoneId===signalZone)});
      updateNode(row,{},{'data-recent':String(!hidden&&seconds>0)});
      updateNode(detail,{textContent:hidden?'Hidden':seconds?`Fades in ${seconds} s`:reason==='warming_up'?'Learning baseline':available?'No recent signal':'Unavailable'});
      updateNode(meter,{hidden:hidden||!available||!seconds,value:seconds?Math.round(assumedZones.intensity(zoneId)*1000)/1000:0});
    }
  }
  if(model.assumed_activity){
    $('homeSignals').hidden=false;
    if(renderer)assumedZones=createAssumedZoneView(THREE,scene,model.assumed_activity,drawSignalFrame);
    const names=model.assumed_activity.zone_names||{};
    for(const zone of model.assumed_activity.zones){
      const row=document.createElement('div'),button=document.createElement('button'),meter=document.createElement('meter'),detail=document.createElement('small'),name=names[zone.zone_id]||zone.zone_id;
      button.dataset.zone=zone.zone_id;button.dataset.room=zone.room_id;
      button.textContent=name;button.title='Focus this signal region';button.onclick=()=>selectHomeRoom(zone.room_id,zone.zone_id);
      detail.id='homeSignal_'+zone.zone_id;button.setAttribute('aria-describedby',detail.id);
      meter.min=0;meter.max=1;meter.value=0;meter.hidden=true;meter.setAttribute('aria-label',name+' · fading signal intensity');
      row.append(button,meter,detail);signalRegions.set(zone.zone_id,{row,button,meter,detail});$('homeSignalRegions').append(row);
    }
    $('homeSignalAll').onclick=()=>selectHomeRoom('');
    $('homeSignals').ontoggle=()=>{assumedZones?.setVisible(active&&$('homeSignalToggle').checked,$('homeSignals').open);refreshSignalStatus();};
    $('homeSignalToggle').onchange=()=>{refreshControls();window.renderModel?.();};
    window.addEventListener('pagehide',event=>{if(!event.persisted)assumedZones?.dispose();});
  }
  function refreshLanguage(){
    $('homeToggleControls').textContent=vt(controlsCollapsed?'Show controls':'Hide controls');
    for(const label of labels)label.el.setAttribute('aria-label',vt('Focus room')+': '+roomName(label.room));
  }
  return {get active(){return active},releaseGPU(){roomLighting?.releaseGPU();},dispose(){roomLighting?.dispose();},dismissOverlays,refreshLanguage,rebuildControls,refreshControls,refreshTVPreviews,render,handleCommandResult,setActive,applyViewPreferences,
    get illuminated(){return points.filter(p=>p.overlay?.visible && active).map(p=>p.item.id)}};
})();
