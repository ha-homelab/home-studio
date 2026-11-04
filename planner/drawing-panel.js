import { createDocumentation, validateDocumentation, measurementGeometry, measurementState } from './documentation-model.js';
import { buildDrawingPackage } from './drawing-package.js';
import { signedArea } from './model.js';
import { fitHostDialog } from './ha-bridge.js';

let panelSequence = 0;
const copy = value => JSON.parse(JSON.stringify(value));
const TARGETS = { room: 'rooms', wall: 'walls', opening: 'openings', item: 'items' };
const STATUS_LABELS = { measured: 'Measured', estimated: 'Estimated', imported: 'Imported', unknown: 'Unknown', stale: 'Out of date' };
const STEPS = ['Brief & measurements', 'Finishes & ceiling fixtures', 'Preview & download'];

// This module is loaded only by the authoring editor. Generated viewers do not
// import it, and opening it never starts a build, provider request, or HA action.
export function createDrawingPanel({ bridge, translate = text => text } = {}) {
  for (const method of ['snapshot', 'revision', 'subscribe', 'applyDocumentation']) {
    if (typeof bridge?.[method] !== 'function') throw new Error('Drawing panel needs an editor bridge.');
  }
  const t = translate, prefix = `drawing-package-${++panelSequence}`;
  let fieldSequence = 0;
  let modal = null, unsubscribe = null, stopFitting = null, opener = null, project, documentation, baseRevision;
  let dirty = false, stale = false, applying = false, step = 0, floorId, roomId, targetType = 'room', targetId;
  let result = null, previewUrl = null, downloadUrl = null, disposed = false;
  let pages, stepButtons, message, freshness, saveButton, nextButton, backButton, reloadButton;
  let floorSelect, previewContent, discardPrompt;
  let options = { paper: 'A3', scale: 'auto', includeFurniture: false };

  function node(tag, text = '', className = '') {
    const element = document.createElement(tag); element.textContent = text; element.className = className; return element;
  }
  function button(text, action, className = '') {
    const element = node('button', t(text), className); element.type = 'button'; element.addEventListener('click', action); return element;
  }
  function field(parent, label, tag = 'input', type = 'text') {
    const wrap = node('label', '', 'drawing-field'), control = node(tag);
    if (tag === 'input') control.type = type;
    control.dataset.drawingField = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '');
    const caption = node('span', t(label)); caption.id = `${prefix}-field-${++fieldSequence}`;
    control.setAttribute('aria-labelledby', caption.id);
    wrap.append(caption, control); parent.append(wrap); return control;
  }
  function choices(control, values, selected) {
    control.replaceChildren();
    for (const [value, label] of values) { const option = node('option', label); option.value = value; control.append(option); }
    control.value = selected;
  }
  function check(parent, label, checked, action) {
    const wrap = node('label', '', 'drawing-check'), input = node('input'); input.type = 'checkbox'; input.checked = checked;
    input.addEventListener('change', () => action(input.checked)); wrap.append(input, node('span', label)); parent.append(wrap); return input;
  }
  function notice(text, error = false) {
    message.textContent = text; message.classList.toggle('drawing-error', error); message.setAttribute('role', error ? 'alert' : 'status');
  }
  function revokePreview() { if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; }
  function invalidate() {
    result = null; revokePreview();
    if (previewContent) previewContent.replaceChildren(node('p', t('Generate a fresh package to preview and download the saved drawing.'), 'drawing-note'));
  }
  function changed() { dirty = true; invalidate(); updateControls(); }
  function currentFloor() { return project.floors.find(floor => floor.id === floorId) || project.floors[0]; }
  function currentRoom() { return currentFloor().rooms.find(room => room.id === roomId) || currentFloor().rooms[0]; }
  function floorName(floor) {
    return project.floors.filter(value => value.name === floor.name).length > 1 ? `${floor.name} (${floor.id})` : floor.name;
  }
  function selectDefaults() {
    const floor = currentFloor(); floorId = floor.id; roomId = currentRoom()?.id;
    if (!floor[TARGETS[targetType]].some(target => target.id === targetId)) targetId = floor[TARGETS[targetType]][0]?.id;
  }
  function syncFromEditor() {
    project = bridge.snapshot(); baseRevision = bridge.revision(); documentation = copy(project.documentation || createDocumentation());
    validateDocumentation(documentation, project); dirty = false; stale = false; selectDefaults(); invalidate();
    if (discardPrompt) discardPrompt.hidden = true;
  }
  function updateControls() {
    if (!modal) return;
    saveButton.disabled = stale || !dirty;
    backButton.disabled = step === 0; nextButton.hidden = step === STEPS.length - 1;
    reloadButton.hidden = !stale;
    freshness.textContent = stale ? t('The drawing changed. Text remains selectable for copying. Reload before saving or downloading; reloading discards unsaved documentation edits.')
      : dirty ? t('Documentation has unsaved changes. Save it before generating a package.') : t('Documentation matches the saved editor snapshot.');
    freshness.classList.toggle('drawing-error', stale);
    for (const control of modal.querySelectorAll('[data-drawing-edit]')) {
      const textField = control.matches('textarea, input:not([type=checkbox])');
      control.disabled = stale && !textField && !control.hasAttribute('data-drawing-navigate');
      if (textField) control.readOnly = stale;
    }
    const generate = modal.querySelector('[data-drawing-generate]'); if (generate) generate.disabled = stale || dirty;
    for (const control of modal.querySelectorAll('[data-drawing-download]')) control.disabled = stale || dirty || !result;
  }
  function checkFresh() {
    if (stale || bridge.revision() !== baseRevision) { stale = true; invalidate(); updateControls(); throw new Error(t('The drawing changed. Reload the latest drawing to continue.')); }
  }
  function editable(control) { control.dataset.drawingEdit = ''; return control; }
  function navigable(control) { control.dataset.drawingNavigate = ''; return editable(control); }
  function guard(action) {
    return () => { try { checkFresh(); action(); } catch (error) { notice(error.message || t('The drawing package could not be prepared.'), true); } };
  }
  function save() {
    try {
      checkFresh(); validateDocumentation(documentation, project); applying = true;
      const accepted = bridge.applyDocumentation(copy(documentation), baseRevision);
      if (accepted === false) throw new Error(t('Documentation was not saved. Check the editor status.'));
      syncFromEditor(); renderPages(); notice(t('Documentation saved. Undo in the editor restores the previous version.'));
    } catch (error) { notice(error.message || t('Documentation could not be saved.'), true); }
    finally { applying = false; updateControls(); }
  }
  function measurementRow() {
    return documentation.measurements.find(row => row.floor_id === floorId && row.target_type === targetType && row.target_id === targetId);
  }
  function renderGeometry(page) {
    const geometry = measurementGeometry(project, { floor_id: floorId, target_type: targetType, target_id: targetId });
    const metric = value => String(Math.round(value * 1e6) / 1e6);
    const metres = value => `${metric(value)} m`;
    let values;
    if (targetType === 'room') {
      const perimeter = geometry.polygon.reduce((total, point, index, points) => {
        const next = points[(index + 1) % points.length]; return total + Math.hypot(next[0] - point[0], next[1] - point[1]);
      }, 0);
      values = [['Floor area', `${metric(Math.abs(signedArea(geometry.polygon)))} m²`], ['Perimeter', metres(perimeter)], ['Ceiling height', metres(geometry.height_m)]];
    } else if (targetType === 'wall') {
      values = [['Length', metres(Math.hypot(geometry.end[0] - geometry.start[0], geometry.end[1] - geometry.start[1]))], ['Height', metres(geometry.height_m)], ['Thickness', metres(geometry.thickness_m)], ['Openings included', String(geometry.openings.length)]];
    } else if (targetType === 'opening') {
      values = [['Width', metres(geometry.width_m)], ['Height', metres(geometry.head_m - geometry.sill_m)], ['Sill height above floor', metres(geometry.sill_m)]];
    } else {
      values = [['Width × depth × height', `${metric(geometry.dimensions_m.width)} × ${metric(geometry.dimensions_m.depth)} × ${metric(geometry.dimensions_m.height)} m`], ['Base height above floor', metres(geometry.position_m.y)]];
    }
    const group = node('section', '', 'drawing-geometry'), title = node('h4', t('Current drawing dimensions'));
    title.id = `${prefix}-geometry-title`; group.setAttribute('aria-labelledby', title.id);
    group.dataset.drawingGeometry = targetType;
    const element = currentFloor()[TARGETS[targetType]].find(value => value.id === targetId);
    const list = node('dl');
    for (const [label, value] of values) { const row = node('div'); row.append(node('dt', t(label)), node('dd', value)); list.append(row); }
    group.append(title, node('p', `${floorName(currentFloor())} / ${element.name || element.id}`, 'drawing-note'), list,
      node('p', t('These values come from the drawing, not a new measurement. Check them before recording their source.'), 'drawing-note'));
    page.append(group);
  }
  function renderMeasurements(page) {
    const heading = node('h3', t(STEPS[0])); heading.tabIndex = -1; page.append(heading);
    const brief = editable(field(page, 'Design brief', 'textarea')); brief.maxLength = 4000; brief.value = documentation.brief;
    brief.addEventListener('input', guard(() => { documentation.brief = brief.value; changed(); }));
    page.append(node('p', t('Record where dimensions came from. This does not change geometry. Photos and estimates are not a survey.'), 'drawing-note'));
    const selectors = node('div', '', 'drawing-grid'); page.append(selectors);
    const type = navigable(field(selectors, 'Element type', 'select'));
    choices(type, [['room', t('Room')], ['wall', t('Wall')], ['opening', t('Door or window')], ['item', t('Item')]], targetType);
    type.addEventListener('change', () => { targetType = type.value; targetId = null; selectDefaults(); renderPages(); });
    const target = navigable(field(selectors, 'Element', 'select'));
    choices(target, currentFloor()[TARGETS[targetType]].map(value => [value.id, value.name || value.id]), targetId);
    target.addEventListener('change', () => { targetId = target.value; renderPages(); });
    if (!targetId) { page.append(node('p', t('There are no elements of this type on this floor.'), 'drawing-note')); return; }
    const row = measurementRow(), status = editable(field(page, 'Dimension source', 'select'));
    choices(status, ['unknown', 'measured', 'estimated', 'imported'].map(value => [value, t(STATUS_LABELS[value])]), row?.status || 'unknown');
    const note = editable(field(page, 'Measurement note', 'textarea')); note.maxLength = 1000; note.value = row?.note || '';
    const state = node('p', '', 'drawing-note'); state.setAttribute('aria-live', 'polite'); page.append(state);
    const updateState = () => {
      const saved = measurementRow(), value = saved ? measurementState(project, saved) : 'unknown';
      state.textContent = `${t('Current evidence')}: ${t(STATUS_LABELS[value] || STATUS_LABELS.unknown)}. ${t('Use Record current dimensions only after checking the selected element.')}`;
    };
    const storeRow = (record = false) => {
      const previous = measurementRow();
      if (!previous && documentation.measurements.length >= 1024) throw new Error(t('The measurement limit has been reached.'));
      const sourceChanged = previous && previous.status !== status.value;
      const retainedGeometry = sourceChanged ? null : previous?.geometry ?? null;
      const next = { floor_id: floorId, target_type: targetType, target_id: targetId, status: status.value, note: note.value,
        geometry: status.value === 'unknown' ? null : record ? measurementGeometry(project, { floor_id: floorId, target_type: targetType, target_id: targetId }) : retainedGeometry };
      if (previous) documentation.measurements[documentation.measurements.indexOf(previous)] = next; else documentation.measurements.push(next);
      changed(); updateState();
    };
    status.addEventListener('change', guard(() => storeRow())); note.addEventListener('input', guard(() => storeRow()));
    renderGeometry(page);
    const actions = node('div', '', 'drawing-actions');
    const record = editable(button('Record current dimensions', guard(() => { storeRow(true); notice(t('Dimension source recorded locally. Save documentation to keep it.')); }), 'quiet'));
    record.dataset.drawingAction = 'record-measurement'; actions.append(record);
    const clear = editable(button('Clear measurement record', guard(() => {
      documentation.measurements = documentation.measurements.filter(value => value !== measurementRow()); changed(); renderPages();
    }))); clear.dataset.drawingAction = 'clear-measurement'; actions.append(clear); page.append(actions); updateState();
  }
  function renderFinishes(page) {
    const heading = node('h3', t(STEPS[1])); heading.tabIndex = -1; page.append(heading);
    page.append(node('p', t('Finish codes and specifications describe your intent. Quantities are derived from drawing geometry; waste is an explicit allowance.'), 'drawing-note'));
    const room = navigable(field(page, 'Room', 'select'));
    choices(room, currentFloor().rooms.map(value => [value.id, value.name]), roomId);
    room.addEventListener('change', () => { roomId = room.value; renderPages(); });
    if (!currentRoom()) { page.append(node('p', t('Add a room before describing finishes or ceiling fixtures.'), 'drawing-note')); return; }
    for (const [surface, title] of [['floor', 'Floor finish'], ['walls', 'Wall finish'], ['ceiling', 'Ceiling finish']]) {
      const group = node('fieldset', '', 'drawing-finish'); group.dataset.drawingSurface = surface; group.append(node('legend', t(title))); page.append(group);
      const previous = documentation.finishes.find(value => value.floor_id === floorId && value.room_id === roomId && value.surface === surface);
      const code = editable(field(group, 'Finish code')); code.maxLength = 80; code.value = previous?.code || '';
      const specification = editable(field(group, 'Specification', 'textarea')); specification.maxLength = 1000; specification.value = previous?.specification || '';
      const waste = editable(field(group, 'Waste allowance (%)', 'input', 'number')); waste.min = '0'; waste.max = '100'; waste.step = '0.1'; waste.value = String(previous?.waste_percent ?? 0);
      group.append(node('p', t('Blank means no additional allowance (0%).'), 'drawing-note'));
      const change = guard(() => {
        const index = documentation.finishes.findIndex(value => value.floor_id === floorId && value.room_id === roomId && value.surface === surface);
        if (!code.value && !specification.value && Number(waste.value) === 0) { if (index >= 0) documentation.finishes.splice(index, 1); }
        else {
          if (index < 0 && documentation.finishes.length >= 1536) throw new Error(t('The finish limit has been reached.'));
          const value = { floor_id: floorId, room_id: roomId, surface, code: code.value, specification: specification.value, waste_percent: Number(waste.value) };
          if (index < 0) documentation.finishes.push(value); else documentation.finishes[index] = value;
        }
        changed();
      });
      for (const control of [code, specification, waste]) control.addEventListener('input', change);
    }
    const fixtures = node('fieldset', '', 'drawing-fixtures'); fixtures.append(node('legend', t('Ceiling-mounted items')),
      node('p', t('Select only items you have confirmed are mounted at the ceiling. Height or item type never selects an item automatically.'), 'drawing-note')); page.append(fixtures);
    const items = currentFloor().items.filter(item => item.room === roomId);
    if (!items.length) fixtures.append(node('p', t('No items in this room.'), 'drawing-note'));
    for (const item of items) {
      const included = documentation.ceiling_fixture_ids.some(value => value.floor_id === floorId && value.item_id === item.id);
      editable(check(fixtures, item.name, included, guard(() => {
        const index = documentation.ceiling_fixture_ids.findIndex(value => value.floor_id === floorId && value.item_id === item.id);
        if (index >= 0) documentation.ceiling_fixture_ids.splice(index, 1);
        else {
          if (documentation.ceiling_fixture_ids.length >= 1024) throw new Error(t('The ceiling fixture limit has been reached.'));
          documentation.ceiling_fixture_ids.push({ floor_id: floorId, item_id: item.id });
        }
        changed();
      })));
    }
  }
  function download(text, type, filename) {
    checkFresh(); if (!result || dirty) throw new Error(t('Generate a fresh package before downloading.'));
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(new Blob([text], { type }));
    const link = node('a'); link.href = downloadUrl; link.download = filename.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
    modal.append(link); link.click(); link.remove();
  }
  function renderResult() {
    previewContent.replaceChildren(); revokePreview(); if (!result) return;
    const packageResult = result;
    previewContent.append(node('p', `${packageResult.sheets.length} ${t('sheets generated from this saved snapshot.')}`, 'drawing-note'));
    const rules = node('details'), list = node('ul');
    rules.append(node('summary', `${t('Measurement rules and limitations')} · ${(packageResult.warnings || []).length} ${t('warnings')}`));
    for (const text of [...(packageResult.measurementRules || []), ...(packageResult.warnings || [])]) list.append(node('li', text));
    rules.append(list); previewContent.append(rules);
    const sheet = field(previewContent, 'Preview sheet', 'select');
    choices(sheet, packageResult.sheets.map((value, index) => [String(index), value.title]), '0');
    const image = node('img', '', 'drawing-sheet'); previewContent.append(image);
    const showSheet = () => {
      revokePreview(); const value = packageResult.sheets[Number(sheet.value)];
      if (!value) { image.hidden = true; return; }
      image.hidden = false; image.alt = value.title; previewUrl = URL.createObjectURL(new Blob([value.svg], { type: 'image/svg+xml' })); image.src = previewUrl;
    };
    sheet.addEventListener('change', showSheet); showSheet();
    const actions = node('div', '', 'drawing-actions');
    const html = button('Download printable HTML', guard(() => download(packageResult.html, 'text/html', packageResult.filename || 'drawing-package.html')), 'primary');
    const svg = button('Download selected SVG', guard(() => { const value = packageResult.sheets[Number(sheet.value)]; if (value) download(value.svg, 'image/svg+xml', value.filename || `${value.id}.svg`); }), 'quiet');
    html.dataset.drawingDownload = ''; html.dataset.drawingAction = 'download-html'; svg.dataset.drawingDownload = ''; svg.dataset.drawingAction = 'download-svg'; actions.append(html, svg); previewContent.append(actions);
    const schedules = node('details'); schedules.open = true; schedules.append(node('summary', t('Schedule preview and CSV'))); previewContent.append(schedules);
    const schedule = field(schedules, 'Schedule', 'select');
    choices(schedule, [['rooms', t('Rooms')], ['openings', t('Doors and windows')], ['items', t('Items')], ['materials', t('Materials')]], 'rooms');
    const tableHost = node('div', '', 'drawing-table-region'); tableHost.tabIndex = 0; tableHost.setAttribute('role', 'region'); schedules.append(tableHost);
    const rowCount = node('p', '', 'drawing-note'); rowCount.setAttribute('aria-live', 'polite'); schedules.append(rowCount);
    const raw = node('details', '', 'drawing-raw-csv'); raw.append(node('summary', t('Raw CSV preview'))); schedules.append(raw);
    const text = field(raw, 'CSV preview', 'textarea'); text.readOnly = true; text.className = 'drawing-csv';
    raw.append(node('p', t('Raw preview is limited to 12,000 characters. The CSV download contains the complete schedule.'), 'drawing-note'));
    const sourceLabel = value => t(STATUS_LABELS[value] || value || 'Unknown');
    const floorLabel = row => {
      const floor = project.floors.find(value => value.id === row.floor_id); return floor ? floorName(floor) : row.floor_id;
    };
    const roomLabel = row => `${floorLabel(row)} / ${row.room || project.floors.find(floor => floor.id === row.floor_id)?.rooms.find(room => room.id === row.room_id)?.name || row.room_id}`;
    const columns = {
      rooms: [
        ['Room', roomLabel], ['Floor m²', row => row.floor_area_m2], ['Walls m²', row => row.net_wall_area_m2],
        ['Source', row => row.floor_area_status === row.wall_area_status ? sourceLabel(row.floor_area_status) : `${t('Floor')}: ${sourceLabel(row.floor_area_status)}; ${t('Walls')}: ${sourceLabel(row.wall_area_status)}`],
      ],
      materials: [
        ['Room', roomLabel], ['Surface', row => t({ floor: 'Floor', walls: 'Walls', ceiling: 'Ceiling' }[row.surface] || row.surface)],
        ['Finish', row => [row.code, row.specification].filter(Boolean).join(' — ') || t('Unspecified')],
        ['Net m²', row => row.quantity_m2], ['Waste m²', row => row.waste_m2], ['Total m²', row => row.quantity_with_waste_m2], ['Source', row => sourceLabel(row.measurement_status)],
      ],
      items: [
        ['Room', roomLabel], ['Item', row => `${row.name} (${row.item_id})`], ['Quantity', row => row.quantity], ['Dimensions (m)', row => `${row.width_m} × ${row.depth_m} × ${row.height_m}`], ['Source', row => sourceLabel(row.measurement_status)],
      ],
      openings: [
        ['Floor', floorLabel], ['Opening', row => row.opening_id], ['Wall', row => row.wall_id],
        ['Type', row => t({ door: 'Door', window: 'Window', passage: 'Passage' }[row.type] || row.type)],
        ['Width (m)', row => row.width_m], ['Height (m)', row => row.height_m], ['Source', row => sourceLabel(row.measurement_status)],
      ],
    };
    const showSchedule = () => {
      const kind = schedule.value, rows = packageResult.schedules[kind], visible = rows.slice(0, 50);
      text.value = packageResult.csv[kind].slice(0, 12000);
      tableHost.replaceChildren(); tableHost.setAttribute('aria-label', `${schedule.selectedOptions[0].textContent} ${t('schedule')}`);
      if (visible.length) {
        const table = node('table', '', 'drawing-table'), head = node('thead'), header = node('tr'), body = node('tbody');
        table.append(node('caption', schedule.selectedOptions[0].textContent));
        for (const [label] of columns[kind]) { const cell = node('th', t(label)); cell.scope = 'col'; header.append(cell); }
        head.append(header); table.append(head, body);
        for (const row of visible) {
          const line = node('tr');
          for (const [, value] of columns[kind]) line.append(node('td', String(value(row) ?? '')));
          body.append(line);
        }
        tableHost.append(table);
      } else tableHost.append(node('p', t('No entries in this schedule.'), 'drawing-note'));
      rowCount.textContent = `${visible.length} / ${rows.length} ${t('rows shown. Download CSV for the complete schedule.')}`;
    };
    schedule.addEventListener('change', showSchedule); showSchedule();
    const csv = button('Download selected CSV', guard(() => download(packageResult.csv[schedule.value], 'text/csv;charset=utf-8', `${schedule.value}.csv`)), 'quiet');
    csv.dataset.drawingDownload = ''; csv.dataset.drawingAction = 'download-csv'; schedules.append(csv); updateControls();
  }
  function renderPreview(page) {
    const heading = node('h3', t(STEPS[2])); heading.tabIndex = -1; page.append(heading);
    page.append(node('p', t('Generate sheets and schedules from the saved drawing. Open the downloaded HTML in a browser to print; use its scale instructions.'), 'drawing-note'));
    const controls = node('div', '', 'drawing-grid'); page.append(controls);
    const paper = editable(field(controls, 'Paper', 'select')); choices(paper, [['A3', 'A3'], ['A4', 'A4']], options.paper);
    const scale = editable(field(controls, 'Scale', 'select')); choices(scale, [['auto', t('Fit to sheet')], ['50', '1:50'], ['100', '1:100'], ['200', '1:200']], String(options.scale));
    const scope = editable(field(controls, 'Floors', 'select')); choices(scope, [['all', t('All floors')], ['current', t('Selected floor')]], options.scope || 'all');
    const roomChoices = (options.scope === 'current' ? [currentFloor()] : project.floors).flatMap(floor => floor.rooms.map(room => [`${floor.id}/${room.id}`, `${floorName(floor)} · ${room.name}`]));
    if (!roomChoices.some(([id]) => id === options.room)) options.room = 'all';
    const room = editable(field(controls, 'Rooms', 'select')); choices(room, [['all', t('All rooms')], ...roomChoices], options.room);
    for (const control of [paper, scale]) control.addEventListener('change', () => {
      options = { ...options, paper: paper.value, scale: scale.value === 'auto' ? 'auto' : Number(scale.value), scope: scope.value }; invalidate(); updateControls();
    });
    scope.addEventListener('change', () => { options.scope = scope.value; invalidate(); renderPages(); });
    room.addEventListener('change', () => { options.room = room.value; invalidate(); updateControls(); });
    editable(check(page, t('Include furniture in drawing sheets'), options.includeFurniture, value => { options.includeFurniture = value; invalidate(); updateControls(); }));
    const generate = button('Generate drawing package', guard(() => {
      if (dirty) throw new Error(t('Save documentation before generating a package.'));
      const candidate = buildDrawingPackage(project, { revision: baseRevision, paper: options.paper, scale: options.scale, includeFurniture: options.includeFurniture,
        ...(options.scope === 'current' ? { floorIds: [floorId] } : {}), ...(options.room !== 'all' ? { roomIds: [options.room] } : {}) });
      checkFresh(); result = candidate; renderResult(); notice(t('Package generated. Review the sheets and quantities before downloading.'));
    }), 'primary');
    generate.dataset.drawingGenerate = ''; generate.dataset.drawingAction = 'generate'; page.append(generate); previewContent = node('div', '', 'drawing-results'); page.append(previewContent);
    if (result) renderResult(); else previewContent.append(node('p', t('Generate a fresh package to preview and download the saved drawing.'), 'drawing-note'));
  }
  function showStep(next, focus = true) {
    step = Math.max(0, Math.min(STEPS.length - 1, next));
    pages.forEach((page, index) => { page.hidden = index !== step; stepButtons[index].setAttribute('aria-current', index === step ? 'step' : 'false'); });
    updateControls(); if (focus) pages[step].querySelector('h3')?.focus();
  }
  function renderPages() {
    if (!modal) return;
    const active = document.activeElement;
    const focus = modal.contains(active) && (active.dataset.drawingField || active.dataset.drawingAction) ? {
      field: active.dataset.drawingField, action: active.dataset.drawingAction,
      surface: active.closest('[data-drawing-surface]')?.dataset.drawingSurface,
      start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection,
    } : null;
    previewContent = null; pages.forEach(page => page.replaceChildren());
    choices(floorSelect, project.floors.map(floor => [floor.id, floorName(floor)]), floorId);
    renderMeasurements(pages[0]); renderFinishes(pages[1]); renderPreview(pages[2]); showStep(step, false);
    if (focus) {
      const target = [...modal.querySelectorAll('[data-drawing-field], [data-drawing-action]')].find(control =>
        control.dataset.drawingField === focus.field && control.dataset.drawingAction === focus.action
        && control.closest('[data-drawing-surface]')?.dataset.drawingSurface === focus.surface);
      if (target && !target.disabled) {
        target.focus({ preventScroll: true });
        if (typeof focus.start === 'number') target.setSelectionRange(focus.start, focus.end, focus.direction);
      }
    }
  }
  function cleanup() {
    if (!modal) return;
    stopFitting?.(); stopFitting = null;
    unsubscribe?.(); unsubscribe = null; revokePreview(); if (downloadUrl) URL.revokeObjectURL(downloadUrl); downloadUrl = null;
    const old = modal, returnFocus = opener;
    modal = null; opener = null; result = null; project = undefined; documentation = undefined; baseRevision = undefined;
    pages = null; stepButtons = null; message = null; freshness = null;
    saveButton = null; nextButton = null; backButton = null; reloadButton = null;
    floorSelect = null; previewContent = null; discardPrompt = null;
    floorId = undefined; roomId = undefined; targetId = undefined; targetType = 'room';
    dirty = false; stale = false; applying = false; step = 0;
    old.remove(); if (returnFocus?.isConnected) returnFocus.focus();
  }
  function finishClose() { if (modal?.open) modal.close(); cleanup(); }
  function close() {
    if (!modal) return;
    if (!dirty) { finishClose(); return; }
    discardPrompt.hidden = false; discardPrompt.querySelector('button').focus();
  }
  function open() {
    if (disposed) throw new Error('Drawing panel has been disposed.');
    if (modal) { modal.focus(); return; }
    if (!document.getElementById('drawing-package-styles')) {
      const link = node('link'); link.id = 'drawing-package-styles'; link.rel = 'stylesheet'; link.href = new URL('./drawing-panel.css', import.meta.url).href; document.head.append(link);
    }
    opener = document.activeElement;
    const selection = bridge.selectionContext?.(); floorId = selection?.floorId; roomId = selection?.roomId; targetType = 'room'; targetId = roomId; step = 0;
    syncFromEditor(); modal = node('dialog', '', 'drawing-panel'); modal.setAttribute('aria-labelledby', `${prefix}-title`);
    const header = node('header', '', 'drawing-header'), heading = node('h2', t('Drawings & materials')); heading.id = `${prefix}-title`;
    const closeButton = button('Close', close, 'quiet'); closeButton.dataset.drawingAction = 'close';
    header.append(heading, closeButton); modal.append(header);
    discardPrompt = node('div', '', 'drawing-discard'); discardPrompt.hidden = true; discardPrompt.setAttribute('role', 'group'); discardPrompt.setAttribute('aria-label', t('Unsaved documentation'));
    discardPrompt.append(node('p', t('Documentation has unsaved changes. Keep editing or discard them and close.')));
    const discardActions = node('div', '', 'drawing-actions');
    discardActions.append(button('Keep editing', () => { discardPrompt.hidden = true; pages[step].querySelector('h3')?.focus(); }, 'quiet'),
      button('Discard documentation edits and close', finishClose, 'quiet')); discardPrompt.append(discardActions); modal.append(discardPrompt);
    const nav = node('nav'); nav.setAttribute('aria-label', t('Drawing package steps')); const list = node('ol', '', 'drawing-steps'); nav.append(list); modal.append(nav);
    stepButtons = STEPS.map((title, index) => { const item = node('li'), control = button(`${index + 1}. ${t(title)}`, () => showStep(index)); item.append(control); list.append(item); return control; });
    freshness = node('p', '', 'drawing-freshness'); freshness.setAttribute('aria-live', 'polite'); modal.append(freshness);
    reloadButton = button('Reload drawing and discard documentation edits', () => {
      try { syncFromEditor(); renderPages(); notice(t('Latest drawing loaded. Unsaved documentation edits were discarded.')); } catch (error) { notice(error.message, true); }
    }, 'quiet'); reloadButton.dataset.drawingAction = 'reload'; reloadButton.hidden = true; modal.append(reloadButton);
    const body = node('div', '', 'drawing-body'); modal.append(body);
    floorSelect = navigable(field(body, 'Floor', 'select'));
    floorSelect.addEventListener('change', () => { floorId = floorSelect.value; roomId = null; targetId = null; selectDefaults(); invalidate(); renderPages(); });
    pages = STEPS.map((_, index) => { const page = node('section', '', 'drawing-step'); page.dataset.drawingStep = String(index + 1); body.append(page); return page; });
    message = node('p', '', 'drawing-message'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite'); modal.append(message);
    const footer = node('footer', '', 'drawing-actions');
    backButton = button('Back', () => showStep(step - 1), 'quiet'); nextButton = button('Next', () => showStep(step + 1), 'quiet'); saveButton = button('Save documentation', save, 'primary');
    saveButton.dataset.drawingAction = 'save';
    footer.append(backButton, nextButton, saveButton); modal.append(footer);
    const openedModal = modal;
    modal.addEventListener('close', () => { if (modal === openedModal) cleanup(); });
    modal.addEventListener('cancel', event => { if (dirty) { event.preventDefault(); close(); } });
    renderPages(); document.body.append(modal);
    unsubscribe = bridge.subscribe(() => { if (!applying && bridge.revision() !== baseRevision) { stale = true; invalidate(); updateControls(); } });
    modal.showModal(); stopFitting = fitHostDialog(modal); pages[0].querySelector('h3').focus();
  }
  return Object.freeze({ open, close, dispose() { finishClose(); disposed = true; } });
}
