import assert from 'node:assert/strict';
import test from 'node:test';
import { addAreaRooms, addAreaDevices, areaDeviceChoices, availableAreas, deviceType } from '../planner/device-onboarding.js';
import { blankProject, clone, newFloor, pointInPolygon, validateProject } from '../planner/model.js';

const areas = [{ id: 'living', name: 'Living', floor_id: 'ha_ground' }, { id: 'kitchen', name: 'Kitchen', floor_id: '' }, { id: 'study', name: 'Study', floor_id: 'ha_upstairs' }];
const entity = (id, metadata = {}) => ({ entity_id: id, domain: id.split('.')[0], name: id, area_id: 'living', ...metadata });
function home() {
  const project = blankProject(); project.floors[0].ha_floor_id = 'ha_ground';
  addAreaRooms(project, 'ground', areas, [{ areaId: 'living', width: 4, depth: 3 }]);
  return project;
}

test('media uses explicit HA class, never name guesses, and permits either override', () => {
  assert.equal(deviceType(entity('media_player.television_sounding_name')), 'appliance');
  assert.equal(deviceType(entity('media_player.speaker', { device_class: 'speaker' })), 'appliance');
  assert.equal(deviceType(entity('media_player.television', { device_class: 'tv' })), 'tv');
  assert.equal(deviceType(entity('media_player.speaker', { device_class: 'speaker' }), 'tv'), 'tv');
  assert.equal(deviceType(entity('media_player.television', { device_class: 'tv' }), 'audio'), 'appliance');
});

test('suggestions exclude diagnostics, configuration, hidden entities and ambiguous sensor rows', () => {
  const project = home(), room = project.floors[0].rooms[0];
  const list = [entity('light.good'), entity('switch.config', { entity_category: 'config' }), entity('sensor.temp', { device_class: 'temperature' }),
    entity('sensor.battery', { device_class: 'battery' }), entity('sensor.raw'), entity('binary_sensor.window', { device_class: 'window' }),
    entity('switch.diagnostic', { entity_category: 'diagnostic' }), entity('light.hidden', { hidden: true }), entity('light.disabled', { disabled: true }),
    entity('light.elsewhere', { area_id: 'elsewhere' }), entity('button.restart'), entity('media_player.good')];
  assert.deepEqual(areaDeviceChoices(project, room, list).map(e => e.entity_id), ['light.good', 'sensor.temp', 'binary_sensor.window', 'media_player.good']);
  assert.deepEqual(areaDeviceChoices(project, room, list, 'BATTERY', true).map(e => e.entity_id), ['sensor.battery']);
  assert.equal(areaDeviceChoices(project, room, [...list, list[0]]).length, 4);
});

test('area import uses entered dimensions, creates unique bounded ids, and skips links on every floor', () => {
  const project = home(), floor = project.floors[0];
  const old = clone(floor);
  addAreaRooms(project, 'ground', areas, [{ areaId: 'kitchen', width: 5.25, depth: 2.5 }]);
  assert.deepEqual(floor.rooms[0], old.rooms[0]); assert.deepEqual(floor.walls.slice(0, 4), old.walls);
  const points = floor.rooms[1].polygon;
  assert.equal(points[1][0] - points[0][0], 5.25); assert.equal(points[2][1] - points[1][1], 2.5);
  project.floors.push(newFloor('upper', 'Upper', 3));
  assert.deepEqual(availableAreas(project, project.floors[1], areas).map(a => a.id), ['study']);
  validateProject(project);
});

test('invalid, duplicate, linked and wrong-floor area batches leave the project intact', () => {
  for (const requests of [[{ areaId: 'kitchen', width: 0, depth: 3 }], [{ areaId: 'living', width: 4, depth: 3 }],
    [{ areaId: 'study', width: 4, depth: 3 }], [{ areaId: 'kitchen', width: 4, depth: 3 }, { areaId: 'kitchen', width: 2, depth: 2 }]]) {
    const project = home(), before = clone(project);
    assert.throws(() => addAreaRooms(project, 'ground', areas, requests)); assert.deepEqual(project, before);
  }
});

test('64 selected small rooms pack within coordinate/id limits and preserve atomic overflow failure', () => {
  const project = blankProject(), list = Array.from({ length: 65 }, (_, i) => ({ id: `area_${i}`, name: 'Room' }));
  addAreaRooms(project, 'ground', list, list.slice(0, 64).map(area => ({ areaId: area.id, width: 3, depth: 3 })));
  validateProject(project); assert.equal(project.floors[0].walls.length, 256);
  const before = clone(project);
  assert.throws(() => addAreaRooms(project, 'ground', list, [{ areaId: 'area_64', width: 3, depth: 3 }]), /64 rooms/);
  assert.deepEqual(project, before);
});

test('chosen devices use separate valid positions in a concave room and reject duplicates globally', () => {
  const project = home(), floor = project.floors[0], room = floor.rooms[0];
  room.polygon = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]]; floor.walls = [];
  const list = [entity('media_player.speaker', { device_class: 'speaker' }), entity('media_player.tv', { device_class: 'tv' }), entity('media_player.unknown'), entity('light.lamp')];
  addAreaDevices(project, floor.id, room.id, list, list.map(e => ({ entityId: e.entity_id })));
  assert.deepEqual(floor.items.map(i => i.type), ['appliance', 'tv', 'appliance', 'lamp']);
  assert.equal(new Set(floor.items.map(i => `${i.position_m.x},${i.position_m.z}`)).size, 4);
  for (const item of floor.items) assert(pointInPolygon([item.position_m.x, item.position_m.z], room.polygon));
  const before = clone(project);
  assert.throws(() => addAreaDevices(project, floor.id, room.id, list, [{ entityId: list[0].entity_id }]), /already linked/);
  assert.deepEqual(project, before);
  const upper = newFloor('upper', 'Upper', 3); project.floors.push(upper); upper.rooms.push({ ...clone(room), id: 'other_room' });
  assert.deepEqual(areaDeviceChoices(project, upper.rooms[0], list), []);
});

test('tight room and item limit failures are atomic and require fewer selected devices', () => {
  const project = home(), floor = project.floors[0], room = floor.rooms[0], list = [entity('light.one'), entity('light.two')];
  room.polygon = [[0, 0], [.25, 0], [.25, .25], [0, .25]]; floor.walls = [];
  const before = clone(project);
  assert.throws(() => addAreaDevices(project, floor.id, room.id, list, list.map(e => ({ entityId: e.entity_id }))), /not enough room/);
  assert.deepEqual(project, before);
  floor.items = Array(256).fill({ entity_id: '' });
  assert.throws(() => addAreaDevices(project, floor.id, room.id, list, [{ entityId: list[0].entity_id }]), /256 items/);
});
