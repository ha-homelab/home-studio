// Static floor previews share the model's metric bounds, without a render loop.
import { distance, floorBounds } from './model.js';
import { getCatalogModel, getCatalogStyle } from './furniture.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const WIDTH = 128, HEIGHT = 84, PADDING = 8;
const COLORS = {
  floor: '#e7dac2', tile: '#e0e8df', deck: '#d8dfbe',
  furniture: '#96aca6', lamp: '#d9ae68', chandelier: '#d9ae68',
  tv: '#677d89', appliance: '#a1abb0', switch: '#b4c39d', outlet: '#b4c39d', sensor: '#c4b09a',
};
const number = value => Math.round(value * 1000) / 1000;
const isEmpty = floor => !floor.rooms.length && !floor.walls.length && !floor.items.length;

function itemColor(item) {
  if (/^#[0-9a-f]{6}$/i.test(item.color || '')) return item.color;
  const model = getCatalogModel(item.model_id);
  return getCatalogStyle(item.style_id || model?.default_style)?.materials.body || COLORS[item.type] || COLORS.furniture;
}

function geometryKey(floor) {
  // Only retain drawing inputs. Names, notes, bindings and floor elevation do
  // not affect a plan thumbnail; in-place edits still invalidate this key.
  return JSON.stringify([
    floor.rooms.map(room => [room.polygon, room.material]),
    floor.walls.map(wall => [wall.id, wall.start, wall.end, wall.thickness_m]),
    floor.openings.map(opening => [opening.wall_id, opening.type, opening.offset_m, opening.width_m]),
    floor.items.map(item => [item.type, item.position_m.x, item.position_m.y, item.position_m.z,
      item.dimensions_m.width, item.dimensions_m.depth, item.dimensions_m.height, item.rotation_deg, itemColor(item)]),
  ]);
}

function svgNode(document, tag, attributes) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

function drawFloor(svg, floor, bounds) {
  const document = svg.ownerDocument, content = document.createDocumentFragment();
  if (isEmpty(floor)) {
    content.append(svgNode(document, 'path', {
      d: 'M45 20H83V48H45Z M45 34H62V48 M62 20V27', fill: 'none',
      stroke: '#9aa98e', 'stroke-width': 1.4, 'stroke-dasharray': '3 3',
    }));
    svg.replaceChildren(content);
    return;
  }
  const scale = Math.min((WIDTH - PADDING * 2) / Math.max(.25, bounds.maxX - bounds.minX),
    (HEIGHT - PADDING * 2) / Math.max(.25, bounds.maxZ - bounds.minZ));
  const centerX = (bounds.minX + bounds.maxX) / 2, centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const point = ([x, z]) => [number(WIDTH / 2 + (x - centerX) * scale), number(HEIGHT / 2 + (z - centerZ) * scale)];
  const path = points => points.map((p, i) => `${i ? 'L' : 'M'}${point(p).join(' ')}`).join('');
  const add = (tag, attributes) => content.append(svgNode(document, tag, attributes));

  for (const room of floor.rooms) add('path', {
    d: path(room.polygon) + 'Z', fill: COLORS[room.material] || COLORS.floor,
    'fill-opacity': .85, stroke: '#9aaa8e', 'stroke-width': .7, 'stroke-linejoin': 'round',
  });
  const walls = new Map(floor.walls.map(wall => [wall.id, wall]));
  for (const wall of floor.walls) add('path', {
    d: path([wall.start, wall.end]), fill: 'none', stroke: '#657461',
    'stroke-width': number(Math.max(1.6, wall.thickness_m * scale)), 'stroke-linecap': 'square',
  });
  for (const opening of floor.openings) {
    const wall = walls.get(opening.wall_id);
    if (!wall) continue;
    const length = distance(wall.start, wall.end);
    if (!length) continue;
    const ux = (wall.end[0] - wall.start[0]) / length, uz = (wall.end[1] - wall.start[1]) / length;
    const start = [wall.start[0] + ux * opening.offset_m, wall.start[1] + uz * opening.offset_m];
    const end = [start[0] + ux * opening.width_m, start[1] + uz * opening.width_m];
    add('path', { d: path([start, end]), fill: 'none', stroke: '#f6f8f1', 'stroke-width': number(Math.max(2.8, wall.thickness_m * scale + 1)) });
    if (opening.type === 'door') {
      const swung = [start[0] - uz * opening.width_m, start[1] + ux * opening.width_m];
      const radius = number(opening.width_m * scale);
      add('path', { d: path([start, swung]), fill: 'none', stroke: '#b28d60', 'stroke-width': 1 });
      add('path', { d: `${path([end])}A${radius} ${radius} 0 0 1 ${point(swung).join(' ')}`, fill: 'none', stroke: '#b28d60', 'stroke-width': .65 });
    } else add('path', {
      d: path([start, end]), fill: 'none', stroke: opening.type === 'window' ? '#609ea9' : '#98a98b',
      'stroke-width': opening.type === 'window' ? 1.5 : 1, ...(opening.type === 'passage' ? { 'stroke-dasharray': '2 2' } : {}),
    });
  }
  const items = [...floor.items].sort((a, b) => a.position_m.y + a.dimensions_m.height - b.position_m.y - b.dimensions_m.height);
  for (const item of items) {
    const [x, y] = point([item.position_m.x, item.position_m.z]);
    const width = number(Math.max(2.5, item.dimensions_m.width * scale)), depth = number(Math.max(2.5, item.dimensions_m.depth * scale));
    const attributes = {
      fill: itemColor(item), stroke: '#657d73', 'stroke-width': .65,
      transform: `translate(${x} ${y}) rotate(${number(-item.rotation_deg)})`,
    };
    if (['lamp', 'chandelier', 'sensor'].includes(item.type)) add('ellipse', { ...attributes, cx: 0, cy: 0, rx: width / 2, ry: depth / 2 });
    else add('rect', { ...attributes, x: -width / 2, y: -depth / 2, width, height: depth, rx: Math.min(1, width / 8, depth / 8) });
  }
  svg.replaceChildren(content);
}

function revealButton(container, button) {
  // Scroll only this rail. scrollIntoView could also move the editor/page.
  const top = button.offsetTop, bottom = top + button.offsetHeight;
  if (top < container.scrollTop) container.scrollTop = top;
  else if (bottom > container.scrollTop + container.clientHeight) container.scrollTop = bottom - container.clientHeight;
}

/**
 * Mount a navigator in an empty wrapper within the canvas shell. update accepts
 * a validated planner project, including in-place edits; it does not mutate it.
 * The caller owns selection and visibility (the wrapper's hidden attribute).
 */
export function createFloorNavigator({ container, onSelect, t = (key, params = {}) => key.replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match) }) {
  const document = container.ownerDocument, entries = new Map();
  let order = [], previousActive, previousBounds = '', destroyed = false;
  const originalRole = container.getAttribute('role'), originalLabel = container.getAttribute('aria-label');
  const hadClass = container.classList.contains('floor-navigator');
  container.classList.add('floor-navigator');
  container.setAttribute('role', 'group');

  function makeEntry(id) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'floor-navigator__floor'; button.dataset.floorId = id;
    const svg = svgNode(document, 'svg', { class: 'floor-navigator__preview', viewBox: `0 0 ${WIDTH} ${HEIGHT}`, 'aria-hidden': 'true', focusable: 'false' });
    const empty = document.createElement('span'); empty.className = 'floor-navigator__empty'; empty.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span'); name.className = 'floor-navigator__name';
    button.append(svg, empty, name);
    const click = () => { if (!destroyed) onSelect(id); };
    const keydown = event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const index = order.indexOf(id);
      const next = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: order.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault(); event.stopPropagation();
      const target = entries.get(order[Math.max(0, Math.min(order.length - 1, next))])?.button;
      if (target) { target.focus({ preventScroll: true }); revealButton(container, target); }
    };
    button.addEventListener('click', click); button.addEventListener('keydown', keydown);
    return { button, svg, empty, name, key: null, bounds: null, release() {
      button.removeEventListener('click', click); button.removeEventListener('keydown', keydown); button.remove();
    } };
  }

  function update(project, activeFloorId) {
    if (destroyed) return;
    const floors = project.floors, ids = new Set(floors.map(floor => floor.id));
    const focused = document.activeElement, hadFocus = container.contains(focused);
    const focusedIndex = order.findIndex(id => entries.get(id)?.button === focused);
    for (const [id, entry] of entries) if (!ids.has(id)) { entry.release(); entries.delete(id); }
    order = floors.map(floor => floor.id);
    container.setAttribute('aria-label', t('Floor navigator'));
    let bounds = null;
    for (const floor of floors) {
      let entry = entries.get(floor.id);
      if (!entry) { entry = makeEntry(floor.id); entries.set(floor.id, entry); }
      const key = geometryKey(floor);
      entry.changed = entry.key !== key;
      if (entry.changed) {
        entry.key = key;
        entry.bounds = isEmpty(floor) ? null : floorBounds(floor);
        if (entry.bounds) {
          const padding = floor.walls.reduce((largest, wall) => Math.max(largest, wall.thickness_m / 2), 0);
          entry.bounds.minX -= padding; entry.bounds.maxX += padding;
          entry.bounds.minZ -= padding; entry.bounds.maxZ += padding;
        }
      }
      if (entry.bounds) bounds = bounds ? {
        minX: Math.min(bounds.minX, entry.bounds.minX), maxX: Math.max(bounds.maxX, entry.bounds.maxX),
        minZ: Math.min(bounds.minZ, entry.bounds.minZ), maxZ: Math.max(bounds.maxZ, entry.bounds.maxZ),
      } : { ...entry.bounds };
    }
    const boundsKey = JSON.stringify(bounds), boundsChanged = previousBounds !== boundsKey;
    for (const [index, floor] of floors.entries()) {
      const entry = entries.get(floor.id), active = floor.id === activeFloorId;
      const label = t('Switch to {floor}', { floor: floor.name });
      entry.button.setAttribute('aria-label', label); entry.button.title = label;
      entry.button.setAttribute('aria-current', String(active)); entry.button.setAttribute('aria-pressed', String(active));
      if (entry.name.textContent !== floor.name) entry.name.textContent = floor.name;
      const emptyLabel = t('Empty floor');
      if (entry.empty.textContent !== emptyLabel) entry.empty.textContent = emptyLabel;
      entry.empty.hidden = !isEmpty(floor);
      if (entry.changed || boundsChanged && !isEmpty(floor)) drawFloor(entry.svg, floor, bounds);
      // Reuse buttons even on import, rename and reordering to retain focus.
      if (container.children[index] !== entry.button) container.insertBefore(entry.button, container.children[index] || null);
    }
    if (hadFocus) {
      const target = container.contains(focused) ? focused : entries.get(activeFloorId)?.button || entries.get(order[Math.min(focusedIndex, order.length - 1)])?.button;
      if (target && document.activeElement !== target) target.focus({ preventScroll: true });
    }
    if (activeFloorId !== previousActive) {
      const activeButton = entries.get(activeFloorId)?.button;
      if (activeButton) revealButton(container, activeButton);
    }
    previousActive = activeFloorId; previousBounds = boundsKey;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const entry of entries.values()) entry.release();
    entries.clear(); order = [];
    if (!hadClass) container.classList.remove('floor-navigator');
    for (const [name, value] of [['role', originalRole], ['aria-label', originalLabel]]) {
      if (value === null) container.removeAttribute(name); else container.setAttribute(name, value);
    }
  }
  return { update, destroy };
}
