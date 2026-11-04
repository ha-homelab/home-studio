#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildDrawingPackage } from '../planner/drawing-package.js';
import { createDocumentation, measurementGeometry } from '../planner/documentation-model.js';

let passed = 0;
function test(name, fn) { try { fn(); passed++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; } }
function home() {
  return { schema_version: 1, id: 'drawing_fixture', title: 'Measured room', floors: [{ id: 'ground', name: 'Ground', elevation_m: 0, height_m: 2.7,
    rooms: [{ id: 'room', name: 'Room', polygon: [[0, 0], [4, 0], [4, 3], [0, 3]], material: 'floor' }],
    walls: [
      { id: 'south', start: [0, 0], end: [4, 0], thickness_m: .15 },
      { id: 'east', start: [4, 0], end: [4, 3], thickness_m: .15 },
      { id: 'north', start: [4, 3], end: [0, 3], thickness_m: .15 },
      { id: 'west', start: [0, 3], end: [0, 0], thickness_m: .15 },
    ],
    openings: [
      { id: 'door', wall_id: 'south', type: 'door', offset_m: .5, width_m: .9, sill_m: 0, head_m: 2 },
      { id: 'window', wall_id: 'north', type: 'window', offset_m: 1, width_m: 1.2, sill_m: .8, head_m: 2.3 },
    ], items: [] }] };
}
function measured(project) {
  project.documentation = createDocumentation();
  for (const floor of project.floors) for (const [type, name] of [['room', 'rooms'], ['wall', 'walls'], ['opening', 'openings'], ['item', 'items']]) {
    for (const target of floor[name]) {
      const ref = { floor_id: floor.id, target_type: type, target_id: target.id };
      project.documentation.measurements.push({ ...ref, status: 'measured', note: '', geometry: measurementGeometry(project, ref) });
    }
  }
  return project;
}
const build = (p = home(), o = {}) => buildDrawingPackage(p, { revision: 7, ...o });

test('4×3×2.7 room deducts exact door and window areas', () => {
  const r = build(measured(home()));
  assert.equal(r.schedules.rooms[0].floor_area_m2, 12);
  assert.equal(r.schedules.rooms[0].perimeter_m, 14);
  assert.equal(r.schedules.rooms[0].gross_wall_area_m2, 37.8);
  assert.equal(r.schedules.rooms[0].opening_deduction_m2, 3.6);
  assert.equal(r.schedules.rooms[0].net_wall_area_m2, 34.2);
  assert.equal(r.schedules.rooms[0].wall_area_status, 'measured');
  assert(r.sheets.every(s => s.measurementStatus === 'measured' && s.svg.includes('Geometry evidence: measured')));
  assert.equal(r.sheets.length, 6);
  assert.equal(r.schedules.openings.length, 2);
  assert.equal(r.schedules.items.length, 0);
  assert.equal(r.csv.items, '');
});

test('detached, deterministic output independent of clocks and object key ordering', () => {
  const p = measured(home()), before = JSON.stringify(p), originalNow = Date.now, originalRandom = Math.random;
  Date.now = Math.random = () => { throw Error('Nondeterministic call'); };
  try {
    const a = build(p), b = build(p);
    assert.deepEqual(a, b);
    assert.deepEqual(a, build(Object.fromEntries(Object.entries(p).reverse())));
    assert.equal(JSON.stringify(p), before);
    a.schedules.rooms[0].room = 'changed';
    assert.equal(p.floors[0].rooms[0].name, 'Room');
    assert.notEqual(build(p, { revision: 8 }).fingerprint, b.fingerprint);
  } finally { Date.now = originalNow; Math.random = originalRandom; }
});

test('unknown, estimated, imported and stale geometry remain explicit', () => {
  assert.equal(build().schedules.rooms[0].wall_area_status, 'unknown');
  for (const status of ['estimated', 'imported']) {
    const p = measured(home()); p.documentation.measurements[0].status = status;
    assert.equal(build(p).schedules.rooms[0].floor_area_status, status);
  }
  const p = measured(home()); p.floors[0].height_m = 2.8;
  const r = build(p);
  assert.equal(r.schedules.rooms[0].wall_area_status, 'stale');
  assert(r.sheets.every(s => s.svg.includes('Geometry evidence: stale')));
  assert(r.warnings.some(v => v.includes('stale')));
});

test('concave outline uses polygon area and actual edge perimeter', () => {
  const p = home(), f = p.floors[0];
  f.rooms[0].polygon = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 3], [0, 3]];
  f.walls = []; f.openings = [];
  const r = build(p);
  assert.equal(r.schedules.rooms[0].floor_area_m2, 6);
  assert.equal(r.schedules.rooms[0].perimeter_m, 14);
  assert.equal(r.schedules.rooms[0].unmatched_boundary_m, 14);
  assert.equal(r.sheets.filter(s => s.kind === 'elevation').length, 6);
  assert(r.warnings.some(w => w.includes('assumed faces')));
});

test('opening deductions clip at room edges and respect reversed host walls', () => {
  const p = home(), f = p.floors[0];
  f.walls[0] = { id: 'south', start: [5, 0], end: [-1, 0], thickness_m: .15 };
  f.openings = [{ id: 'window', wall_id: 'south', type: 'window', offset_m: .5, width_m: 1, sill_m: 1, head_m: 2 }];
  const r = build(p);
  assert.equal(r.schedules.rooms[0].opening_deduction_m2, .5);
  assert.equal(r.schedules.rooms[0].net_wall_area_m2, 37.3);
  assert(r.sheets.find(s => s.edgeIndex === 0).svg.includes('0.5 × 1 m'));
});

test('shared wall deductions count each interior face, physical opening once', () => {
  const p = home(), f = p.floors[0];
  f.rooms.push({ id: 'other', name: 'Other', polygon: [[4, 0], [8, 0], [8, 3], [4, 3]], material: 'floor' });
  f.walls.push({ id: 'other_south', start: [4, 0], end: [8, 0], thickness_m: .15 },
    { id: 'other_east', start: [8, 0], end: [8, 3], thickness_m: .15 },
    { id: 'other_north', start: [8, 3], end: [4, 3], thickness_m: .15 });
  f.openings = [{ id: 'shared_door', wall_id: 'east', type: 'door', offset_m: .5, width_m: .9, sill_m: 0, head_m: 2 }];
  const r = build(p);
  assert.deepEqual(r.schedules.rooms.map(v => v.opening_deduction_m2), [1.8, 1.8]);
  assert.equal(r.schedules.openings.length, 1);
  assert.equal(r.schedules.rooms.reduce((s, v) => s + v.net_wall_area_m2, 0), 72);
  assert(r.measurementRules.some(v => v.includes('one interior finish face')));
});

test('overlapping openings and invalid geometry are rejected before documents', () => {
  const p = home(); p.floors[0].openings.push({ ...p.floors[0].openings[0], id: 'overlap' });
  assert.throws(() => build(p), /overlap/i);
  const nan = home(); nan.floors[0].height_m = NaN;
  assert.throws(() => build(nan), /nonfinite/i);
});

test('waste is separate from net quantities, per-finish override is explicit', () => {
  const p = measured(home());
  p.documentation.finishes.push({ floor_id: 'ground', room_id: 'room', surface: 'floor', code: 'T1', specification: 'Tile', waste_percent: 10 });
  const r = build(p, { wastePercent: 5 });
  const floor = r.schedules.materials.find(v => v.surface === 'floor'), wall = r.schedules.materials.find(v => v.surface === 'walls');
  assert.equal(floor.quantity_m2, 12); assert.equal(floor.waste_m2, 1.2); assert.equal(floor.quantity_with_waste_m2, 13.2);
  assert.equal(wall.quantity_m2, 34.2); assert.equal(wall.waste_percent, 5);
});

test('ceiling fixtures require explicit designation and no entity metadata leaks', () => {
  const p = home(), f = p.floors[0];
  f.items.push({ id: 'fixture', name: 'Ceiling Fixture', type: 'lamp', room: 'room', position_m: { x: 2, y: 2.5, z: 1 },
    dimensions_m: { width: .2, depth: .2, height: .2 }, rotation_deg: 0, entity_id: 'light.private_secret', notes: 'PRIVATE_NOTE' });
  let r = build(p);
  assert(!r.sheets.find(s => s.kind === 'ceiling').svg.includes('Ceiling Fixture'));
  measured(p); p.documentation.ceiling_fixture_ids.push({ floor_id: 'ground', item_id: 'fixture' });
  r = build(p);
  assert.equal(r.schedules.items[0].quantity, 1);
  assert(r.sheets.find(s => s.kind === 'ceiling').svg.includes('Ceiling Fixture'));
  assert(!JSON.stringify(r).includes('light.private_secret')); assert(!JSON.stringify(r).includes('PRIVATE_NOTE'));
});

test('optional furniture envelopes use rotated metric placement', () => {
  const p = home();
  p.floors[0].items.push({ id: 'cabinet', name: 'Cabinet', type: 'furniture', room: 'room', position_m: { x: 2, y: 0, z: .4 },
    dimensions_m: { width: 1, depth: .4, height: .8 }, rotation_deg: 90, entity_id: '', notes: '' });
  const plain = build(p), shown = build(p, { includeFurniture: true });
  assert(!plain.sheets.find(s => s.kind === 'elevation').svg.includes('stroke-dasharray'));
  assert(shown.sheets.find(s => s.kind === 'elevation').svg.includes('stroke-dasharray'));
  assert(shown.sheets.find(s => s.kind === 'floor-plan').svg.includes('1.8,0.9'));
  measured(p); p.floors[0].items[0].dimensions_m.width = 1.1;
  const stale = build(p);
  assert(stale.warnings.some(v => v.includes('cabinet') && v.includes('stale')));
  assert(!stale.html.includes('No unresolved measurement flags were found.'));
});

test('markup is escaped and spreadsheet formula strings are neutralized', () => {
  const p = measured(home()); p.title = '<script>alert(1)</script>'; p.floors[0].rooms[0].name = '=SUM(1,2)';
  p.documentation.finishes.push({ floor_id: 'ground', room_id: 'room', surface: 'walls', code: '@danger', specification: '<img src=x onerror=alert(1)>', waste_percent: 0 });
  p.documentation.brief = 'DO_NOT_EXPORT_PRIVATE_BRIEF';
  const r = build(p);
  assert(!r.html.includes('<script>')); assert(!r.html.includes('<img'));
  assert(r.html.includes('&lt;script&gt;'));
  assert(r.csv.rooms.includes("'=SUM(1,2)")); assert(r.csv.materials.includes("'@danger"));
  assert(!r.html.includes('DO_NOT_EXPORT_PRIVATE_BRIEF'));
});

test('SVG and printable HTML declare physical page, actual scale and metre bar', () => {
  const r = build(home(), { scale: 100, paper: 'A4' });
  for (const s of r.sheets) {
    assert.equal(s.scale, 100); assert(s.svg.includes('width="297mm" height="210mm"'));
    assert(s.svg.includes('scale(10)')); assert(s.svg.includes('Scale bar: 1 m'));
  }
  assert(r.html.includes('@page{size:A4 landscape;margin:0}'));
  assert(!r.html.includes('<script')); assert(!r.html.includes('<iframe')); assert(!r.html.includes('https://'));
});

test('auto scale fits explicitly and strict requested scale rejects overflow', () => {
  const p = home(), f = p.floors[0]; f.rooms[0].polygon = [[0, 0], [30, 0], [30, 20], [0, 20]]; f.walls = []; f.openings = [];
  assert.equal(build(p).sheets[0].scale, 100);
  assert.throws(() => build(p, { scale: 50 }), /does not fit/);
});

test('invalid options and oversized source refuse before output', () => {
  for (const option of [{ revision: -1 }, { revision: true }, { paper: 'A0' }, { scale: 0 }, { includeFurniture: 1 },
    { floorIds: ['missing'] }, { floorIds: ['ground', 'ground'] }, { roomIds: ['room'] }, { wastePercent: Infinity }, { wallProjectionDepthM: 0 }])
    assert.throws(() => build(home(), option));
  const p = home(); p.title = 'x'.repeat(2_000_001); assert.throws(() => build(p), /large|2 MB/);
  const cycle = home(); cycle.loop = cycle; assert.throws(() => build(cycle), /acyclic/);
});

test('sheet cap is enforced and selecting one room narrows package', () => {
  const p = home(), f = p.floors[0]; f.rooms = []; f.walls = []; f.openings = [];
  for (let i = 0; i < 64; i++) {
    const x = (i % 8) * 3, z = Math.floor(i / 8) * 3;
    f.rooms.push({ id: 'room_' + i, name: 'Room ' + i, polygon: [[x, z], [x + 2, z], [x + 2, z + 2], [x, z + 2]], material: 'floor' });
  }
  assert.throws(() => build(p), /256 sheets/);
  const r = build(p, { roomIds: ['ground/room_0'] });
  assert.equal(r.schedules.rooms.length, 1); assert.equal(r.sheets.length, 6);
  f.rooms.pop();
  f.rooms[0].polygon = [[0, 0], [1, 0], [2, 0], [2, 2], [0, 2], [0, 1]];
  assert.equal(build(p).sheets.length, 256);
});

test('empty unselected floors do not block partial-home documents', () => {
  const p = home();
  p.floors.push({ id: 'upper', name: 'Unfinished floor', elevation_m: 3, height_m: 2.7, rooms: [], walls: [], openings: [], items: [] });
  const r = build(p, { floorIds: ['ground'] });
  assert.equal(r.sheets.length, 6);
  assert.throws(() => build(p, { floorIds: ['upper'] }), /Select at least one room/);
});

test('unmatched interior walls remain visible and explicitly excluded from quantities', () => {
  const p = home(), f = p.floors[0];
  f.walls.push({ id: 'partition', start: [1, 1], end: [3, 1], thickness_m: .2 });
  f.openings.push({ id: 'partition_door', wall_id: 'partition', type: 'door', offset_m: .3, width_m: .9, sill_m: 0, head_m: 2 });
  const r = build(p);
  assert.equal(r.schedules.openings.length, 3);
  assert.equal(r.schedules.rooms[0].net_wall_area_m2, 34.2);
  assert(r.warnings.some(w => w.includes('partition') && w.includes('additional finish faces')));
  assert(r.sheets[0].svg.includes('x1="1" y1="1" x2="3" y2="1"'));
});

console.log(`PASS: ${passed} drawing package checks`);
