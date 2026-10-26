import { createSite, nextSiteId, siteBounds, SITE_LIMITS } from './site-model.js';
import { clone, round, pointInPolygon, signedArea, floorBounds } from './model.js';
import { createSiteMapUnderlay } from './site-map-underlay.js';

const KINDS = [ ['home', 'My home', '#bca88a', 3], ['roof', 'Roof', '#9b7768', 3], ['building', 'Neighbor', '#589aa8', 3], ['street', 'Street', '#9a9b94', 0], ['landscape', 'Landscape', '#a9bd91', 0] ];
const label = kind => KINDS.find(entry => entry[0] === kind)?.[1] || kind;
const flat = kind => kind === 'street' || kind === 'landscape';

// Site edits use the editor's ordinary transaction boundary: floors, history,
// host saves and browser drafts remain one document. Gestures keep detached
// working polygons until pointerup, so an interrupted drag cannot leak a draft.
export function createSiteEditor(api) {
  const { canvas, ctx, $, node, button, field, row, section, t } = api;
  let active = false, selectedId = null, tool = 'select', kind = 'home', scope = 'all', points = [], hover = null, gesture = null;
  let mapUnderlay = null, mapTransport = null, mapWanted = false, suspended = false;
  const editableKind = value => scope !== 'neighborhood' || !['home', 'roof'].includes(value);
  const current = () => api.getProject().site || createSite();
  const accepted = () => api.getAcceptedProject().site || createSite();
  const selected = () => accepted().features.find(feature => feature.id === selectedId && editableKind(feature.kind));
  const refresh = (revision = false) => { if (revision) api.changed(); api.renderUI(); api.render(); };
  const options = () => KINDS.filter(([value]) => editableKind(value)).map(([value, name]) => ({ value, label: t(name) }));
  const point = event => api.toWorld(api.localPoint(event)).map(value => api.snap(value, event.altKey));
  function cancel() {
    const previous = gesture; gesture = null; points = []; hover = null;
    if (previous && canvas.hasPointerCapture(previous.pointerId)) canvas.releasePointerCapture(previous.pointerId);
    api.render();
  }
  function setTool(next) { cancel(); tool = next; api.ensurePlan(); refresh(true); canvas.focus({ preventScroll: true }); }
  function setScope(next) {
    if (scope === next) return;
    cancel(); scope = next; selectedId = null; tool = 'select';
    if (!editableKind(kind)) kind = 'building';
    api.ensurePlan(); refresh(true);
  }
  function setActive(next) {
    next = !!next; if (active === next) return;
    api.beforeModeChange(); cancel(); active = next; selectedId = null; tool = 'select';
    syncMapUnderlay();
    document.body.classList.toggle('site-mode', active);
    $('site-tools').hidden = !active;
    const previewNote = document.querySelector('.preview-note');
    previewNote.textContent = active ? 'Site shapes · approximate exterior' : t('Real wall openings · geometry preview');
    $('inside-mode').setAttribute('aria-pressed', String(!active)); $('site-mode').setAttribute('aria-pressed', String(active));
    canvas.setAttribute('aria-label', active ? 'Site plan in meters. Draw polygon corners, Enter to finish, Escape to cancel. Select features in Site layers to edit coordinates.' : t('Metric floor plan. Draw with pointer tools or use Add room by dimensions for keyboard input. Select objects from the On this floor list to edit precise coordinates.'));
    api.modeChanged(); api.changed(); api.fit(); refresh();
  }
  function choose(id) { cancel(); tool = 'select'; selectedId = accepted().features.some(feature => feature.id === id && editableKind(feature.kind)) ? id : null; refresh(true); }
  function commitPolygon(polygon) {
    if (!editableKind(kind)) return false;
    let id;
    const [,, color, height] = KINDS.find(entry => entry[0] === kind);
    const ok = api.transact(project => {
      project.site ||= createSite(); id = nextSiteId(project.site, kind);
      project.site.features.push({ id, name: label(kind), kind, polygon: clone(polygon), height_m: height, color,
        ...(kind === 'building' ? { render_style: 'outline' } : {}) });
      selectedId = id;
    }, 'Site feature added. Drag its corners or edit the exact points.');
    if (ok) { cancel(); tool = 'select'; refresh(); }
    return ok;
  }
  function finish() {
    if (points.length < 3) { api.status('Choose at least three corners to finish a polygon.', true); return; }
    commitPolygon(points);
  }
  function edit(change) { const id = selectedId; return api.transact(project => { const feature = project.site?.features.find(entry => entry.id === id); if (feature) change(feature); }, 'Site feature updated.'); }
  function remove() { if (!selected()) return; const id = selectedId; cancel(); api.transact(project => { project.site.features = project.site.features.filter(feature => feature.id !== id); selectedId = null; }, 'Site feature deleted. Undo is available.'); }
  function updateUI() {
    if (!active) return;
    syncMapUnderlay();
    document.querySelector('.preview-note').textContent = 'Site shapes · approximate exterior';
    if (selectedId && !selected()) selectedId = null;
    $('empty-state').hidden = true; $('floor-caption').textContent = `${scope === 'neighborhood' ? 'Neighborhood' : 'Site & roof'} · meters`;
    for (const element of scopeButtons) element.setAttribute('aria-pressed', String(element.dataset.siteScope === scope));
    for (const option of $('site-kind').options) { option.hidden = !editableKind(option.value); option.disabled = !editableKind(option.value); }
    $('site-kind').value = kind;
    for (const element of document.querySelectorAll('[data-site-tool]')) element.setAttribute('aria-pressed', String(element.dataset.siteTool === tool));
    $('site-finish').disabled = points.length < 3; $('site-cancel').disabled = !points.length && !gesture;
    $('site-progress').textContent = points.length ? `${points.length} corners · Enter to finish · Escape to cancel` : scope === 'neighborhood' ? 'Draw neighboring buildings, streets and landscape. Your home stays a locked reference.' : 'Trace your home, roof and surroundings in meters.';
    const list = node('div');
    const visibleFeatures = accepted().features.filter(feature => editableKind(feature.kind));
    for (const feature of visibleFeatures) {
      const item = button('', () => choose(feature.id), 'site-feature');
      item.dataset.inspectorKey = `site:${feature.id}`; item.dataset.siteId = feature.id;
      item.setAttribute('aria-pressed', String(feature.id === selectedId)); item.setAttribute('aria-label', `${label(feature.kind)}: ${feature.name}`);
      const swatch = node('span', 'site-swatch'); swatch.style.backgroundColor = feature.color; swatch.setAttribute('aria-hidden', 'true');
      const text = node('span', 'site-feature-text'); text.append(node('strong', '', feature.name), node('small', '', `${label(feature.kind)}${feature.render_style === 'outline' ? ' · outline' : ''} · ${Math.abs(signedArea(feature.polygon)).toFixed(1)} m²`)); item.append(swatch, text); list.append(item);
    }
    if (!visibleFeatures.length) list.append(node('p', 'site-empty', scope === 'neighborhood' ? 'Draw your first neighbor. Existing home and roof shapes stay visible as locked references.' : 'Choose a type, then draw a polygon or rectangle. Your floors stay visible as a reference.'));
    api.reconcile($('site-list'), list); $('site-count').textContent = String(visibleFeatures.length);
    if (api.getView() !== 'preview') $('tool-hint').textContent = hint();
  }
  function hint() { return tool === 'polygon' ? 'Click corners · click the first corner or Enter to finish · Escape cancels' : tool === 'rectangle' ? 'Drag opposite corners to draw a rectangle · Alt bypasses snap' : 'Select a shape · drag to move · drag corners to reshape · Space + drag pans'; }
  function buildInspector(parent) {
    const feature = selected();
    $('selected-item-details').hidden = true;
    $('inspector-title').textContent = feature ? feature.name : scope === 'neighborhood' ? 'Neighborhood' : 'Site & roof';
    $('inspector-subtitle').textContent = feature ? `${label(feature.kind)} · ${Math.abs(signedArea(feature.polygon)).toFixed(1)} m²` : scope === 'neighborhood' ? 'Edit surroundings on the same drawing grid.' : 'A shared exterior around all your floors.';
    if (feature) {
      field(parent, 'Feature name', feature.name, value => edit(entry => { entry.name = value; }));
      field(parent, 'Feature type', feature.kind, value => edit(entry => {
        if (!editableKind(value)) throw new Error('Switch to All site features to edit your home and roof.');
        const previous = entry.kind; entry.kind = value;
        if (flat(value)) entry.height_m = 0;
        if (value !== 'building') delete entry.render_style;
        else if (previous !== 'building') entry.render_style = 'outline';
      }), { options: options() });
      field(parent, feature.kind === 'roof' ? 'Roof elevation above ground (m)' : 'Height above ground (m)', feature.height_m, flat(feature.kind) ? null : value => edit(entry => { entry.height_m = value; }), { type: 'number', min: 0, max: SITE_LIMITS.height, readOnly: flat(feature.kind), help: feature.kind === 'roof' ? 'A flat roof surface at this elevation. Roof pitch is not modeled.' : flat(feature.kind) ? 'Street and landscape surfaces lie on the ground.' : 'Simple exterior mass measured from site ground.' });
      field(parent, 'Feature color', feature.color, value => edit(entry => { entry.color = value; }), { type: 'color' });
      if (feature.kind === 'building') field(parent, 'Neighbor appearance', feature.render_style || 'solid', value => edit(entry => { entry.render_style = value; }), {
        options: [{ value: 'outline', label: 'Subdued outline' }, { value: 'solid', label: 'Solid volume' }],
        help: 'Outlines keep the detailed home visible. Existing neighbors keep their saved appearance.' });
      section(parent, 'Exact outline');
      field(parent, 'Polygon points (x, z meters)', feature.polygon.map(pair => pair.join(', ')).join('\n'), value => edit(entry => {
        entry.polygon = value.trim().split(/\n/).filter(line => line.trim()).map(line => {
          const values = line.trim().split(/[\s,]+/); if (values.length !== 2 || values.some(v => !v.trim() || !Number.isFinite(Number(v)))) throw new Error('Each point needs two numbers: x, z.');
          return values.map(Number);
        });
      }), { rows: Math.min(7, feature.polygon.length + 1), help: 'One x, z pair per line. Add or remove lines to change corners. You can also drag corner handles on the plan.' });
      parent.append(button('Delete feature', remove, 'danger'));
      parent.append(node('p', 'property-id', `ID: ${feature.id}`));
    } else {
      field(parent, 'Ground elevation (m)', accepted().ground_elevation_m, scope === 'neighborhood' ? null : value => api.transact(project => { project.site ||= createSite(); project.site.ground_elevation_m = value; }, 'Site ground elevation updated.'), { type: 'number', min: -SITE_LIMITS.groundElevation, max: SITE_LIMITS.groundElevation, readOnly: scope === 'neighborhood', help: scope === 'neighborhood' ? 'Shared with your home. Change it in All site features.' : 'Uses the same vertical origin as floor elevations.' });
      parent.append(node('p', 'callout', scope === 'neighborhood' ? 'Draw neighboring footprints, then set their heights and outline colors. Your home and roof stay locked; choose All site features to edit them.' : 'Draw the outline of your own home and roof, then add neighboring buildings, streets and landscape. Choose Neighborhood to edit surroundings with your home locked.'));
      section(parent, 'Add a rectangle by dimensions');
      const origin = row(parent), dimensions = row(parent);
      const x = field(origin, 'Site x (m)', 0, null, { type: 'number', min: -1000, max: 1000 });
      const z = field(origin, 'Site z (m)', 0, null, { type: 'number', min: -1000, max: 1000 });
      const width = field(dimensions, 'Site width (m)', 8, null, { type: 'number', min: .05, max: 2000 });
      const depth = field(dimensions, 'Site depth (m)', 6, null, { type: 'number', min: .05, max: 2000 });
      parent.append(button('Add site rectangle', () => {
        const values = [x,z,width,depth].map(input => api.inspectorValue(input)).map(value => value.trim() ? Number(value) : NaN);
        if (!values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0) { api.status('Enter a valid origin and positive width and depth.', true); return; }
        const [a,b,w,d] = values; if (commitPolygon([[a,b],[round(a+w),b],[round(a+w),round(b+d)],[a,round(b+d)]])) api.fit();
      }, 'quiet'));
      parent.append(node('p', 'field-note', `Creates the type selected in the Site tools: ${label(kind)}.`));
      parent.append(node('p', 'field-note', 'These are local drawing coordinates. Use Align map in Home Assistant separately for geographic placement.'));
    }
  }
  function bounds() {
    const boxes = api.getProject().floors.map(floorBounds), site = siteBounds(current()); if (site) boxes.push(site);
    return { minX: Math.min(...boxes.map(b => b.minX)), maxX: Math.max(...boxes.map(b => b.maxX)), minZ: Math.min(...boxes.map(b => b.minZ)), maxZ: Math.max(...boxes.map(b => b.maxZ)) };
  }
  function paintPath(polygon, closed = true) { ctx.beginPath(); polygon.forEach((pair, index) => { const [x,y] = api.toScreen(pair); if (index) ctx.lineTo(x,y); else ctx.moveTo(x,y); }); if (closed) ctx.closePath(); }
  function render() {
    const colors = api.colors(), scale = api.viewport().map.scale;
    ctx.save();
    if (mapUnderlay?.state.enabled) {
      const { width, height } = api.viewport().size;
      mapUnderlay.setView({ width, height, toWorld: api.toWorld });
      mapUnderlay.draw(ctx, { worldToCanvas: api.toScreen });
    }
    // Every floor is a reference only; this layer never changes indoor geometry.
    ctx.globalAlpha = .24;
    for (const floor of api.getProject().floors) {
      for (const room of floor.rooms) { paintPath(room.polygon); ctx.fillStyle = colors.room.floor; ctx.fill(); ctx.strokeStyle = colors.wall; ctx.lineWidth = 1; ctx.stroke(); }
      for (const wall of floor.walls) { paintPath([wall.start,wall.end], false); ctx.strokeStyle = colors.wall; ctx.lineWidth = Math.max(1, wall.thickness_m * scale); ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
    const features = [...current().features].sort((a,b) => Number(!flat(a.kind))-Number(!flat(b.kind)));
    const labelBoxes = [];
    for (const feature of features) {
      const polygon = gesture?.id === feature.id && gesture.polygon ? gesture.polygon : feature.polygon;
      const chosen = feature.id === selectedId, reference = !editableKind(feature.kind), outline = feature.kind === 'building' && feature.render_style === 'outline';
      paintPath(polygon); ctx.fillStyle = feature.color; ctx.globalAlpha = reference ? .1 : outline ? .08 : feature.kind === 'roof' ? .33 : .48; ctx.fill(); ctx.globalAlpha = reference ? .3 : 1;
      ctx.strokeStyle = api.isCandidate() ? colors.candidate : chosen ? colors.selection : outline ? feature.color : colors.wall; ctx.lineWidth = chosen ? 2.5 : 1.5;
      ctx.setLineDash(feature.kind === 'roof' || api.isCandidate() ? [6,4] : []); ctx.stroke(); ctx.setLineDash([]);
      const [cx,centerY] = api.toScreen(polygon.reduce((sum,p) => [sum[0]+p[0]/polygon.length,sum[1]+p[1]/polygon.length],[0,0]));
      ctx.font = '600 12px -apple-system, sans-serif'; ctx.textAlign = 'center';
      const title = feature.name.length > 24 ? feature.name.slice(0,23)+'…' : feature.name;
      const width = ctx.measureText(title).width + 12; let cy = centerY;
      const projected = polygon.map(api.toScreen), maxY = Math.max(...projected.map(p => p[1]));
      const canLabel = chosen || Math.max(...projected.map(p => p[0]))-Math.min(...projected.map(p => p[0])) >= width+4 && maxY-Math.min(...projected.map(p => p[1])) >= 22;
      if (canLabel && !reference) {
        const overlaps = () => labelBoxes.some(box => Math.abs(box.x-cx) < (box.width+width)/2 && Math.abs(box.y-cy) < 22);
        for (let attempt = 0; attempt < 4 && overlaps() && cy+23 < maxY-8; attempt++) cy += 23;
        if (chosen || !overlaps()) {
          labelBoxes.push({ x: cx, y: cy, width });
          ctx.fillStyle = colors.background; ctx.globalAlpha = .9; ctx.fillRect(cx-width/2,cy-12,width,19); ctx.globalAlpha = 1; ctx.fillStyle = colors.roomText; ctx.fillText(title,cx,cy+1);
        }
      }
      if (chosen) for (const [index,pair] of polygon.entries()) {
        const [x,y] = api.toScreen(pair); ctx.beginPath(); ctx.arc(x,y,5,0,Math.PI*2); ctx.fillStyle = colors.handle; ctx.fill(); ctx.strokeStyle = colors.selection; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = colors.roomText; ctx.font = '10px sans-serif'; ctx.fillText(String(index+1),x+12,y-9);
      }
      ctx.globalAlpha = 1;
    }
    let draft = points;
    if (gesture?.type === 'rectangle') draft = rectangle(gesture.start,gesture.end);
    else if (points.length && hover) draft = [...points,hover];
    if (draft.length) {
      paintPath(draft, draft.length >= 3); ctx.fillStyle = colors.drawing; ctx.globalAlpha = .12; ctx.fill(); ctx.globalAlpha = 1;
      ctx.strokeStyle = colors.drawing; ctx.lineWidth = 2; ctx.setLineDash([5,4]); ctx.stroke(); ctx.setLineDash([]);
      for (const p of points) { const [x,y] = api.toScreen(p); ctx.beginPath(); ctx.arc(x,y,5,0,Math.PI*2); ctx.fillStyle = colors.handle; ctx.fill(); ctx.stroke(); }
    }
    const meters = Math.pow(10, Math.ceil(Math.log10(50 / scale))), size = api.viewport().size;
    const sx = 18, sy = size.height - 76;
    ctx.strokeStyle = colors.scale; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(sx,sy-3); ctx.lineTo(sx,sy+3); ctx.moveTo(sx,sy); ctx.lineTo(sx+meters*scale,sy); ctx.lineTo(sx+meters*scale,sy-3); ctx.moveTo(sx+meters*scale,sy); ctx.lineTo(sx+meters*scale,sy+3); ctx.stroke();
    ctx.fillStyle = colors.scaleText; ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.fillText(`${meters} m · local coordinates`,sx,sy-9);
    if (mapUnderlay?.state.attribution) {
      const text = mapUnderlay.state.attribution, width = ctx.measureText(text).width, x = size.width - 12, y = size.height - (size.width < 380 ? 101 : 76);
      ctx.fillStyle = colors.background; ctx.globalAlpha = .9; ctx.fillRect(x-width-5,y-13,width+10,18); ctx.globalAlpha = 1;
      ctx.fillStyle = colors.scaleText; ctx.textAlign = 'right'; ctx.fillText(text,x,y);
    }
    ctx.restore();
  }
  function rectangle(a,b) { return [a,[b[0],a[1]],b,[a[0],b[1]]]; }
  function pointerDown(event) {
    if (!active || api.getView() === 'preview') return false;
    if (gesture || event.isPrimary === false || ![0,1].includes(event.button)) return true;
    event.preventDefault(); canvas.focus({ preventScroll: true });
    const screen = api.localPoint(event), world = point(event), map = api.viewport().map;
    if (api.spaceHeld() || event.shiftKey || event.button === 1) gesture = { type: 'pan', screen, map: {...map} };
    else if (tool === 'polygon') {
      if (points.length >= 3 && Math.hypot(...api.toScreen(points[0]).map((value,index) => value-screen[index])) < 12) finish();
      else if (points.length < SITE_LIMITS.points) { points.push(world); hover = null; refresh(true); }
      else api.status(`A polygon can have up to ${SITE_LIMITS.points} corners.`, true);
      return true;
    } else if (tool === 'rectangle') gesture = { type: 'rectangle', start: world, end: world };
    else {
      const feature = selected();
      const corner = feature?.polygon.findIndex(pair => Math.hypot(...api.toScreen(pair).map((value,index) => value-screen[index])) < 10) ?? -1;
      if (corner >= 0) gesture = { type: 'vertex', id: feature.id, corner, original: clone(feature.polygon), polygon: clone(feature.polygon), start: world };
      else {
        const hit = accepted().features.filter(feature => editableKind(feature.kind)).sort((a,b) => Number(!flat(a.kind))-Number(!flat(b.kind))).reverse().find(feature => pointInPolygon(world,feature.polygon));
        choose(hit?.id || null);
        if (hit) gesture = { type: 'move', id: hit.id, original: clone(hit.polygon), polygon: clone(hit.polygon), start: world };
        else gesture = { type: 'pan', screen, map: {...map} };
      }
    }
    if (gesture.type !== 'pan') api.changed();
    gesture.pointerId = event.pointerId; canvas.setPointerCapture(event.pointerId); api.render(); return true;
  }
  function pointerMove(event) {
    if (!active || api.getView() === 'preview') return false;
    const world = point(event); $('pointer-position').textContent = `x ${world[0].toFixed(2)} · z ${world[1].toFixed(2)} m`;
    if (gesture && gesture.pointerId !== event.pointerId) return true;
    if (gesture && !event.buttons) { pointerUp(event,true); return true; }
    if (!gesture) { if (points.length) { hover = world; api.render(); } canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair'; return true; }
    if (gesture.type === 'pan') { const screen = api.localPoint(event), map = api.viewport().map; map.x = gesture.map.x+screen[0]-gesture.screen[0]; map.y = gesture.map.y+screen[1]-gesture.screen[1]; }
    else if (gesture.type === 'rectangle') gesture.end = world;
    else if (gesture.type === 'vertex') gesture.polygon[gesture.corner] = world;
    else gesture.polygon = gesture.original.map(pair => [round(pair[0]+world[0]-gesture.start[0]),round(pair[1]+world[1]-gesture.start[1])]);
    api.render(); return true;
  }
  function pointerUp(event, cancelled = false) {
    if (!active) return false;
    if (!gesture || event && gesture.pointerId !== event.pointerId) return true;
    const previous = gesture; gesture = null;
    if (canvas.hasPointerCapture(previous.pointerId)) canvas.releasePointerCapture(previous.pointerId);
    if (!cancelled) {
      if (previous.type === 'rectangle') commitPolygon(rectangle(previous.start,previous.end));
      else if (previous.polygon && JSON.stringify(previous.polygon) !== JSON.stringify(previous.original)) edit(entry => { entry.polygon = previous.polygon; });
    }
    refresh(); return true;
  }
  function keyDown(event) {
    if (!active) return false;
    if (event.key === 'Escape') { cancel(); tool = 'select'; selectedId = null; refresh(true); event.preventDefault(); return true; }
    if (event.key === 'Enter' && points.length) { finish(); event.preventDefault(); return true; }
    if (event.ctrlKey || event.metaKey || event.code === 'Space' || event.key.startsWith('Arrow') || ['+','=','-'].includes(event.key)) return false;
    if (event.key === 'Delete' || event.key === 'Backspace') { if (points.length) { points.pop(); refresh(); } else remove(); event.preventDefault(); return true; }
    if (event.key.toLowerCase() === 'v') setTool('select');
    else if (event.key.toLowerCase() === 'p') setTool('polygon');
    else if (event.key.toLowerCase() === 'r') setTool('rectangle');
    return true;
  }
  const scopes = node('div', 'site-scopes'); scopes.setAttribute('role', 'group'); scopes.setAttribute('aria-label', 'Site editing scope');
  const scopeButtons = [['all', 'All site features'], ['neighborhood', 'Neighborhood']].map(([value, title]) => {
    const control = button(title, () => setScope(value)); control.dataset.siteScope = value; control.setAttribute('aria-pressed', String(value === scope)); scopes.append(control); return control;
  });
  $('site-tools').insertBefore(scopes, $('site-settings'));
  const mapControls = node('section', 'site-map-controls'); mapControls.hidden = true; mapControls.setAttribute('aria-label', 'Map background');
  const mapToggle = button('Map background', () => { mapWanted = !mapWanted; syncMapUnderlay(); }); mapToggle.id = 'site-map-toggle'; mapToggle.setAttribute('aria-pressed', 'false');
  const mapReload = button('Reload map', () => { void mapUnderlay?.reload(); }); mapReload.id = 'site-map-reload';
  const mapStatus = node('p', 'site-map-status'); mapStatus.id = 'site-map-status'; mapStatus.setAttribute('role', 'status');
  mapControls.append(mapToggle, mapReload, mapStatus); $('site-tools').insertBefore(mapControls, $('site-settings'));
  function updateMapControls() {
    const state = mapUnderlay?.state;
    mapControls.hidden = !mapUnderlay;
    mapToggle.setAttribute('aria-pressed', String(mapWanted));
    mapReload.hidden = !mapWanted; mapReload.disabled = !state?.enabled || state.loading;
    mapStatus.textContent = mapWanted ? state?.status || state?.attribution || '' : 'Show your saved Home Assistant map alignment beneath this drawing.';
  }
  function syncMapUnderlay() {
    const wasEnabled = mapUnderlay?.state.enabled, enabled = active && mapWanted && api.getView() !== 'preview' && !suspended && !document.hidden;
    mapUnderlay?.setEnabled(enabled);
    if (wasEnabled && !enabled) mapTransport?.close?.();
    updateMapControls();
  }
  function setMapTransport(transport) {
    mapUnderlay?.dispose(); mapTransport?.close?.(); mapUnderlay = null; mapTransport = transport; mapWanted = false;
    if (typeof transport?.request === 'function') mapUnderlay = createSiteMapUnderlay({ request: (...args) => transport.request(...args), onChange: api.render, onStatus: updateMapControls });
    syncMapUnderlay();
  }
  function setSuspended(value) { suspended = !!value; syncMapUnderlay(); }
  function dispose() { mapUnderlay?.dispose(); mapTransport?.close?.(); mapUnderlay = null; mapTransport = null; }
  $('site-settings').addEventListener('click', () => choose(null));
  $('inside-mode').addEventListener('click', () => setActive(false)); $('site-mode').addEventListener('click', () => setActive(true));
  for (const control of document.querySelectorAll('[data-site-tool]')) control.addEventListener('click', () => setTool(control.dataset.siteTool));
  for (const [value,name] of KINDS) { const option = node('option','',t(name)); option.value = value; $('site-kind').append(option); }
  $('site-kind').addEventListener('change', event => { kind = event.target.value; refresh(); });
  $('site-finish').addEventListener('click',finish); $('site-cancel').addEventListener('click',() => { cancel(); refresh(); });
  return { get active() { return active; }, get neighborhood() { return scope === 'neighborhood'; }, get selectedId() { return selectedId; }, get busy() { return !!gesture || points.length > 0; }, setActive, cancel, updateUI, buildInspector, bounds, render, pointerDown, pointerMove, pointerUp, keyDown, hint, setMapTransport, setSuspended, dispose };
}

export function buildSitePreview(THREE, site, material, { showHome = true } = {}) {
  const group = new THREE.Group(); group.name = 'site-exterior';
  if (!site) return group;
  let outlineMaterial;
  for (const feature of site.features) {
    if (!showHome && ['home', 'roof'].includes(feature.kind)) continue;
    if (feature.kind === 'building' && feature.render_style === 'outline') {
      outlineMaterial ||= new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .65, depthTest: true, depthWrite: false });
      const positions = [], colors = [], color = new THREE.Color(feature.color), ground = site.ground_elevation_m, top = ground + feature.height_m;
      const edge = (a, b) => { positions.push(...a, ...b); colors.push(color.r, color.g, color.b, color.r, color.g, color.b); };
      for (let i = 0; i < feature.polygon.length; i++) {
        const a = feature.polygon[i], b = feature.polygon[(i + 1) % feature.polygon.length];
        edge([a[0], ground, a[1]], [b[0], ground, b[1]]);
        if (feature.height_m > 0) { edge([a[0], top, a[1]], [b[0], top, b[1]]); edge([a[0], ground, a[1]], [a[0], top, a[1]]); }
      }
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      const outline = new THREE.LineSegments(geometry, outlineMaterial); outline.name = feature.id; group.add(outline);
      continue;
    }
    const shape = new THREE.Shape(); feature.polygon.forEach(([x,z],i) => i ? shape.lineTo(x,-z) : shape.moveTo(x,-z)); shape.closePath();
    const surface = flat(feature.kind) || feature.kind === 'roof' || feature.height_m === 0;
    const geometry = surface ? new THREE.ShapeGeometry(shape) : new THREE.ExtrudeGeometry(shape,{ depth:feature.height_m, bevelEnabled:false }); geometry.rotateX(-Math.PI/2);
    const mesh = new THREE.Mesh(geometry,material({color:feature.color,roughness:.9,side:THREE.DoubleSide}));
    mesh.name = feature.id; mesh.position.y = site.ground_elevation_m + (feature.kind === 'roof' ? feature.height_m : surface ? .012 : 0); mesh.receiveShadow = true; mesh.castShadow = !flat(feature.kind);
    group.add(mesh);
  }
  return group;
}
