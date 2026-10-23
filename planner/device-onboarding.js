import { LIMITS, clone, nextId, outlineRoom, pointInPolygon, round, validateProject } from './model.js';

const DEVICE_DOMAINS = new Set(['light', 'switch', 'fan', 'media_player', 'climate', 'cover', 'vacuum', 'lock', 'sensor', 'binary_sensor']);
const SENSOR_CLASSES = new Set(['temperature', 'humidity', 'illuminance', 'carbon_dioxide', 'carbon_monoxide', 'pm25', 'pm10', 'volatile_organic_compounds', 'power', 'energy', 'moisture']);
const BINARY_CLASSES = new Set(['motion', 'occupancy', 'presence', 'door', 'window', 'opening', 'smoke', 'gas', 'moisture', 'safety']);
export const DEVICE_PAGE_SIZE = 80;

export function deviceType(entity, display = 'auto') {
  if (entity.domain === 'media_player') {
    if (!['auto', 'audio', 'tv'].includes(display)) throw new Error('Choose audio or TV controls.');
    return display === 'tv' || (display === 'auto' && entity.device_class === 'tv') ? 'tv' : 'appliance';
  }
  return ({ light: 'lamp', switch: 'switch', sensor: 'sensor', binary_sensor: 'sensor' })[entity.domain] || 'appliance';
}

export function deviceTypeLabel(entity) {
  if (entity.domain !== 'media_player') return entity.domain.replaceAll('_', ' ');
  return entity.device_class === 'tv' ? 'TV' : entity.device_class === 'speaker' ? 'Speaker / audio' : 'Media player · choose audio or TV';
}

export function suitableDevice(entity) {
  if (!entity || entity.disabled || entity.hidden || entity.entity_category || !DEVICE_DOMAINS.has(entity.domain)) return false;
  if (entity.domain === 'sensor') return SENSOR_CLASSES.has(entity.device_class);
  if (entity.domain === 'binary_sensor') return BINARY_CLASSES.has(entity.device_class);
  return true;
}

export function boundEntityIds(project) {
  return new Set(project.floors.flatMap(floor => floor.items.map(item => item.entity_id).filter(Boolean)));
}

export function areaDeviceChoices(project, room, entities, query = '', includeOther = false) {
  const bound = boundEntityIds(project), seen = new Set(), search = query.trim().toLowerCase();
  return entities.filter(entity => {
    if (!room.ha_area_id || entity.area_id !== room.ha_area_id || entity.disabled || bound.has(entity.entity_id) || seen.has(entity.entity_id)) return false;
    seen.add(entity.entity_id);
    return (includeOther || suitableDevice(entity)) && (!search || `${entity.name} ${entity.entity_id}`.toLowerCase().includes(search));
  });
}

export function availableAreas(project, target, areas) {
  const linked = new Set(project.floors.flatMap(floor => floor.rooms.map(room => room.ha_area_id).filter(Boolean))), seen = new Set();
  return areas.filter(area => {
    if (!area.id || area.id.length > 128 || linked.has(area.id) || seen.has(area.id)) return false;
    seen.add(area.id);
    return !target.ha_floor_id || !area.floor_id || area.floor_id === target.ha_floor_id;
  });
}

function bounds(points) {
  return { minX: Math.min(...points.map(p => p[0])), maxX: Math.max(...points.map(p => p[0])), minZ: Math.min(...points.map(p => p[1])), maxZ: Math.max(...points.map(p => p[1])) };
}

function roomPosition(floor, width, depth) {
  const occupied = [...floor.rooms.map(room => bounds(room.polygon)), ...floor.walls.map(wall => bounds([wall.start, wall.end])), ...floor.items.map(item => bounds([[item.position_m.x, item.position_m.z]]))];
  const axes = (min, max, size) => [...new Set([0, -100, ...occupied.flatMap(box => [round(box[max] + 1), round(box[min] - size - 1)])])]
    .filter(value => value >= -100 && value + size <= 100).sort((a, b) => Math.abs(a) - Math.abs(b) || b - a);
  for (const z of axes('minZ', 'maxZ', depth)) for (const x of axes('minX', 'maxX', width)) {
    if (occupied.every(box => x + width <= box.minX - .5 || x >= box.maxX + .5 || z + depth <= box.minZ - .5 || z >= box.maxZ + .5)) return [x, z];
  }
  throw new Error('There is no space for these room dimensions on this floor. Add fewer rooms or use another floor.');
}

// The caller receives one validated transaction. HA provides names/links only;
// the user supplies every dimension and these rectangles are starter geometry.
export function addAreaRooms(project, floorId, areas, requests, walls = true) {
  if (!requests.length) throw new Error('Select at least one area and enter its measured width and depth.');
  const candidate = clone(project), target = candidate.floors.find(floor => floor.id === floorId);
  if (!target) throw new Error('Choose a floor.');
  if (target.rooms.length + requests.length > LIMITS.rooms) throw new Error(`A floor can contain at most ${LIMITS.rooms} rooms. Select fewer areas.`);
  const choices = new Map(availableAreas(project, target, areas).map(area => [area.id, area]));
  const ids = [];
  for (const request of requests) {
    const area = choices.get(request.areaId);
    if (!area) throw new Error('An area is already linked, repeated, or no longer available for this floor.');
    choices.delete(request.areaId);
    const { width, depth } = request;
    if (![width, depth].every(value => Number.isFinite(value) && value >= .25 && value <= 100)) throw new Error(`${area.name}: enter measured width and depth between 0.25 and 100 m.`);
    const [x, z] = roomPosition(target, width, depth);
    const room = { id: nextId(target, 'room'), name: (area.name || area.id).slice(0, 100), ha_area_id: area.id, polygon: [[x, z], [round(x + width), z], [round(x + width), round(z + depth)], [x, round(z + depth)]], material: 'floor' };
    target.rooms.push(room); ids.push(room.id);
    if (walls) outlineRoom(target, room);
  }
  validateProject(candidate);
  Object.assign(project.floors.find(floor => floor.id === floorId), target);
  return ids;
}

function devicePositions(floor, room, count) {
  const box = bounds(room.polygon), inset = .125;
  const axis = (min, max) => {
    const span = max - min - inset * 2;
    if (span < 0) return [];
    const steps = Math.max(1, Math.min(50, Math.ceil(span / .35)));
    return Array.from({ length: steps + 1 }, (_, i) => round(min + inset + span * i / steps));
  };
  const existing = floor.items.map(item => [item.position_m.x, item.position_m.z]);
  const distance2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  const center = [(box.minX + box.maxX) / 2, (box.minZ + box.maxZ) / 2];
  const candidates = [];
  for (const x of axis(box.minX, box.maxX)) for (const z of axis(box.minZ, box.maxZ)) {
    if (![[x, z], [x - inset, z - inset], [x + inset, z - inset], [x + inset, z + inset], [x - inset, z + inset]].every(p => pointInPolygon(p, room.polygon))) continue;
    const point = [x, z];
    candidates.push({ point, distance: existing.length ? Math.min(...existing.map(p => distance2(p, point))) : Infinity, center: distance2(center, point) });
  }
  const result = [];
  for (let i = 0; i < count; i++) {
    candidates.sort((a, b) => b.distance - a.distance || a.center - b.center);
    const chosen = candidates.shift();
    if (!chosen || chosen.distance < .35 ** 2) throw new Error('There is not enough room for separate device markers. Select fewer devices or move existing items.');
    result.push(chosen.point);
    for (const candidate of candidates) candidate.distance = Math.min(candidate.distance, distance2(candidate.point, chosen.point));
  }
  return result;
}

export function addAreaDevices(project, floorId, roomId, entities, requests) {
  if (!requests.length) throw new Error('Choose at least one device.');
  const candidate = clone(project), target = candidate.floors.find(floor => floor.id === floorId), room = target?.rooms.find(room => room.id === roomId);
  if (!room?.ha_area_id) throw new Error('Link this room to a Home Assistant area first.');
  if (target.items.length + requests.length > LIMITS.items) throw new Error(`A floor can contain at most ${LIMITS.items} items. Select fewer devices.`);
  // Explicit individual selection may include a helper/diagnostic entity. Batch
  // defaults filter those out, but choosing Other entities is an intentional act.
  const choices = new Map(areaDeviceChoices(candidate, room, entities, '', true).map(entity => [entity.entity_id, entity]));
  const positions = devicePositions(target, room, requests.length), ids = [];
  for (const [index, request] of requests.entries()) {
    const entity = choices.get(request.entityId);
    if (!entity) throw new Error('A device is already linked, repeated, or no longer available in this area.');
    choices.delete(request.entityId);
    const id = nextId(target, 'item'), [x, z] = positions[index];
    target.items.push({ id, name: (entity.name || entity.entity_id).slice(0, 100), type: deviceType(entity, request.display), room: room.id, entity_id: entity.entity_id, notes: '', position_m: { x, y: 0, z }, dimensions_m: { width: .25, depth: .25, height: .3 }, rotation_deg: 0 });
    ids.push(id);
  }
  validateProject(candidate);
  Object.assign(project.floors.find(floor => floor.id === floorId), target);
  return ids;
}
