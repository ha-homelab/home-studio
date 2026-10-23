import { DEVICE_PAGE_SIZE, areaDeviceChoices, availableAreas, deviceTypeLabel } from './device-onboarding.js';

function element(tag, text = '', className = '') {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
function inputField(parent, label, type = 'text') {
  const wrap = element('label', '', 'field'), input = element('input');
  input.type = type; input.setAttribute('aria-label', label);
  wrap.append(element('span', label), input); parent.append(wrap); return input;
}
function checkbox(parent, text) {
  const wrap = element('label', '', 'starter-walls'), input = element('input'); input.type = 'checkbox';
  wrap.append(input, element('span', text)); parent.append(wrap); return input;
}
function choiceList() {
  const list = element('div');
  list.style.maxHeight = '45vh'; list.style.overflowY = 'auto'; list.style.overflowWrap = 'anywhere'; list.style.margin = '12px 0';
  return list;
}
function dialog(title, description, action, commit) {
  const modal = element('dialog', '', 'onboarding-dialog'), form = element('form');
  const heading = element('h2', title); heading.id = 'ha-onboarding-title'; modal.setAttribute('aria-labelledby', heading.id);
  const content = element('div'), error = element('p', '', 'onboarding-status'), summary = element('p', '', 'field-note');
  error.setAttribute('role', 'alert'); summary.setAttribute('aria-live', 'polite');
  const buttons = element('div', '', 'field-row'), cancel = element('button', 'Cancel'), add = element('button', action, 'primary');
  cancel.type = 'button'; cancel.onclick = () => modal.close(); add.type = 'submit'; buttons.append(cancel, add);
  form.append(heading, element('p', description, 'field-note'), content, summary, error, buttons); modal.append(form);
  form.onsubmit = event => {
    event.preventDefault();
    try { if (commit() !== false) modal.close(); else error.textContent = 'Could not apply these choices. Check the editor status and try again.'; }
    catch (failure) { error.textContent = failure.message; }
  };
  modal.addEventListener('close', () => modal.remove(), { once: true });
  document.body.append(modal); modal.showModal();
  return { content, summary, add };
}

export function showAreaStarter({ project, floor, areas, commit }) {
  const choices = availableAreas(project, floor, areas), selected = new Map();
  let walls;
  const ui = dialog('Start rooms from Home Assistant areas',
    'Home Assistant supplies names, not room sizes or positions. Select areas and enter measured dimensions. This creates separate rectangular starter rooms; arrange and refine their shapes afterward. Existing area links are skipped. Only areas on the linked HA floor or without a floor are shown.',
    'Create selected rooms', () => commit([...selected.values()].map(row => ({ areaId: row.id, width: Number(row.width.value), depth: Number(row.depth.value) })), walls.checked));
  const search = inputField(ui.content, 'Find an area', 'search'), list = choiceList(); ui.content.append(list);
  const rows = new Map();
  const update = () => { ui.summary.textContent = `${selected.size} selected · ${choices.length} available · dimensions are required for each selected area.`; ui.add.disabled = !selected.size; };
  const render = () => {
    list.replaceChildren();
    const matches = choices.filter(area => `${area.name} ${area.id}`.toLowerCase().includes(search.value.toLowerCase()));
    for (const area of matches.slice(0, DEVICE_PAGE_SIZE)) {
      let row = rows.get(area.id);
      if (!row) {
        const container = element('div'), choice = checkbox(container, `${area.name} · ${area.id}`), sizes = element('div', '', 'field-row');
        const width = inputField(sizes, `${area.name} width (m)`, 'number'), depth = inputField(sizes, `${area.name} depth (m)`, 'number');
        for (const input of [width, depth]) { input.min = '.25'; input.max = '100'; input.step = '.01'; input.disabled = true; }
        container.append(sizes); row = { id: area.id, container, width, depth }; rows.set(area.id, row);
        choice.onchange = () => {
          if (choice.checked) selected.set(area.id, row); else selected.delete(area.id);
          for (const input of [width, depth]) { input.disabled = !choice.checked; input.required = choice.checked; }
          update();
        };
      }
      list.append(row.container);
    }
    if (matches.length > DEVICE_PAGE_SIZE) list.append(element('p', `Showing ${DEVICE_PAGE_SIZE} areas. Search to narrow the list.`, 'field-note'));
    if (!matches.length) list.append(element('p', 'No unlinked areas match this floor and search.', 'field-note'));
  };
  walls = checkbox(ui.content, 'Build wall outlines'); walls.checked = true;
  search.oninput = render; render(); update(); search.focus();
}

export function showDeviceChooser({ project, room, entities, commit }) {
  const selected = new Map();
  const ui = dialog(`Add devices to ${room.name}`, 'Choose the devices to draw. Suggested devices exclude hidden, diagnostic and configuration entities. Sensors need a useful room reading or detection class. Already linked entities are skipped throughout this home. New markers are spaced inside the room; drag them to their real positions afterward.',
    'Add selected devices', () => commit([...selected.values()]));
  const search = inputField(ui.content, 'Find a device', 'search');
  const other = checkbox(ui.content, 'Include other entities (helpers and diagnostics)'), list = choiceList(); ui.content.append(list);
  const update = () => { ui.summary.textContent = `${selected.size} selected. Only selected devices will be added, including selections outside the current list.`; ui.add.disabled = !selected.size; };
  const render = () => {
    list.replaceChildren();
    const choices = areaDeviceChoices(project, room, entities, search.value, other.checked);
    for (const entity of choices.slice(0, DEVICE_PAGE_SIZE)) {
      const container = element('div'), choice = checkbox(container, `${entity.name} · ${entity.entity_id}${entity.available === false ? ' (unavailable)' : ''}`);
      container.append(element('p', deviceTypeLabel(entity), 'field-note'));
      choice.checked = selected.has(entity.entity_id);
      let display;
      if (entity.domain === 'media_player') {
        const wrap = element('label', '', 'field'); display = element('select'); display.setAttribute('aria-label', `${entity.name} controls`);
        for (const [value, label] of [['auto', 'Use HA type (generic media if unknown)'], ['audio', 'Speaker / audio'], ['tv', 'TV / display']]) {
          const option = element('option', label); option.value = value; display.append(option);
        }
        display.value = selected.get(entity.entity_id)?.display || 'auto';
        display.onchange = () => { if (choice.checked) selected.set(entity.entity_id, { entityId: entity.entity_id, display: display.value }); };
        wrap.append(element('span', 'Media controls'), display); container.append(wrap);
      }
      choice.onchange = () => {
        if (choice.checked) selected.set(entity.entity_id, { entityId: entity.entity_id, display: display?.value || 'auto' });
        else selected.delete(entity.entity_id);
        update();
      };
      list.append(container);
    }
    if (choices.length > DEVICE_PAGE_SIZE) list.append(element('p', `Showing ${DEVICE_PAGE_SIZE} of ${choices.length} matches. Search to narrow the list.`, 'field-note'));
    if (!choices.length) list.append(element('p', 'No unlinked devices match. Try a different search or include other entities.', 'field-note'));
  };
  search.oninput = render; other.onchange = render; render(); update(); search.focus();
}
