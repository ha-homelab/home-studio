#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { blankProject, clone, demoProject, validateProject } from '../planner/model.js';
import { createDocumentation, DOCUMENTATION_LIMITS, measurementGeometry, measurementState, pruneDocumentation, validateDocumentation } from '../planner/documentation-model.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const ref = (target_type, target_id) => ({ floor_id: 'ground', target_type, target_id });
const references = [ref('room', 'living'), ref('wall', 'wall_1'), ref('opening', 'entry'), ref('item', 'sofa')];
const base = demoProject();
base.documentation = createDocumentation();
base.documentation.brief = 'Retain the measured layout.\nReview finishes before ordering.';
base.documentation.measurements = references.map((value, i) => ({ ...value, status: ['measured', 'estimated', 'imported', 'unknown'][i], note: 'User-authored evidence.', geometry: measurementGeometry(base, value) }));
base.documentation.finishes = [{ floor_id: 'ground', room_id: 'living', surface: 'floor', code: 'F-01', specification: 'Sample finish\nConfirm supplier dimensions.', waste_percent: 10 }];
base.documentation.ceiling_fixture_ids = [{ floor_id: 'ground', item_id: 'light' }];
const accepted = [clone(base)], rejected = [];
function valid(patch) { const value = clone(base); patch(value); accepted.push(value); return value; }
function invalid(patch) { const value = clone(base); patch(value); rejected.push(value); }
const legacy = demoProject(), legacyBefore = JSON.stringify(legacy);
validateProject(legacy); assert.equal(JSON.stringify(legacy), legacyBefore); assert.equal(pruneDocumentation(legacy), undefined);
assert.equal(Object.hasOwn(blankProject(), 'documentation'), false);
assert.deepEqual(createDocumentation(), { schema_version: 1, brief: '', measurements: [], finishes: [], ceiling_fixture_ids: [] });
const fresh = createDocumentation(); fresh.measurements.push({}); assert.equal(createDocumentation().measurements.length, 0);
valid(project => project.documentation = createDocumentation());
valid(project => { project.documentation.brief = '🏠'.repeat(DOCUMENTATION_LIMITS.brief); project.documentation.measurements[0].note = '🏠'.repeat(DOCUMENTATION_LIMITS.note); });
valid(project => { project.documentation.finishes[0].code = ''; project.documentation.finishes[0].specification = ''; project.documentation.finishes[0].waste_percent = 100; });
valid(project => project.documentation.measurements.forEach(row => row.geometry = null));
valid(project => project.documentation.measurements[0].geometry.height_m = 3.5); // Stale snapshots are retained, not rejected.
for (const status of ['measured', 'estimated', 'imported', 'unknown']) valid(project => project.documentation.measurements.forEach(row => row.status = status));
for (const surface of ['floor', 'walls', 'ceiling']) valid(project => project.documentation.finishes[0].surface = surface);
for (const value of [null, [], {}, 1, 'documentation']) invalid(project => project.documentation = value);
for (const field of Object.keys(base.documentation)) invalid(project => delete project.documentation[field]);
for (const value of [0, 2, true, '1', null]) invalid(project => project.documentation.schema_version = value);
invalid(project => project.documentation.provider_key = 'not permitted');
for (const value of [true, null, {}, 'x'.repeat(4001), '\u0000', '\r', '\ud800']) invalid(project => project.documentation.brief = value);
for (const field of ['measurements', 'finishes', 'ceiling_fixture_ids']) {
  for (const value of [null, {}, 'rows']) invalid(project => project.documentation[field] = value);
  invalid(project => project.documentation[field].push(clone(project.documentation[field][0])));
}
for (const [field, maximum] of [['measurements', 1024], ['finishes', 1536], ['ceiling_fixture_ids', 1024]]) invalid(project => project.documentation[field] = Array.from({ length: maximum + 1 }, () => clone(project.documentation[field][0])));
for (const field of Object.keys(base.documentation.measurements[0])) invalid(project => delete project.documentation.measurements[0][field]);
for (const value of ['missing', '__proto__', 'Ground', null, 1]) invalid(project => project.documentation.measurements[0].floor_id = value);
for (const value of ['living', 'missing', '__proto__', null, 1]) invalid(project => project.documentation.measurements[3].target_id = value);
for (const value of ['rooms', 'site', '__proto__', [], null]) invalid(project => project.documentation.measurements[0].target_type = value);
for (const value of ['stale', 'verified', '', null, true]) invalid(project => project.documentation.measurements[0].status = value);
for (const value of ['x'.repeat(1001), '\u0001', '\udfff', null]) invalid(project => project.documentation.measurements[0].note = value);
for (const value of [{}, [], 'snapshot', true]) invalid(project => project.documentation.measurements[0].geometry = value);
invalid(project => project.documentation.measurements[0].geometry.target_type = 'wall');
invalid(project => project.documentation.measurements[0].geometry.provider = 'unrecognized');
invalid(project => project.documentation.measurements[0].geometry.polygon[0][0] = true);
invalid(project => project.documentation.measurements[0].geometry.polygon = [[0, 0]]);
invalid(project => project.documentation.measurements[1].geometry.thickness_m = 0);
const wallOpening = clone(base.documentation.measurements[1].geometry.openings[0]);
assert.deepEqual(wallOpening, { id: 'view', type: 'window', offset_m: 1.1, width_m: 3.4, sill_m: .75, head_m: 2.2 });
valid(project => { delete project.documentation.measurements[1].geometry.openings; }); // Legacy evidence needs rechecking, not repair on import.
valid(project => { project.documentation.measurements[1].geometry.openings = []; });
valid(project => { project.documentation.measurements[1].geometry.openings[0].id = 'historical_window'; });
valid(project => { project.documentation.measurements[1].geometry.openings = Array.from({ length: 256 }, (_, i) => ({ ...wallOpening, id: `historical_${String(i).padStart(3, '0')}` })); });
for (const value of [null, {}, 'openings', true]) invalid(project => project.documentation.measurements[1].geometry.openings = value);
invalid(project => project.documentation.measurements[1].geometry.openings = Array.from({ length: 257 }, (_, i) => ({ ...wallOpening, id: `historical_${String(i).padStart(3, '0')}` })));
invalid(project => project.documentation.measurements[1].geometry.openings.push(clone(wallOpening)));
invalid(project => project.documentation.measurements[1].geometry.openings = [{ ...wallOpening, id: 'z' }, { ...wallOpening, id: 'a' }]);
for (const field of Object.keys(wallOpening)) invalid(project => delete project.documentation.measurements[1].geometry.openings[0][field]);
invalid(project => project.documentation.measurements[1].geometry.openings[0].wall_id = 'wall_1');
for (const value of ['__proto__', 'invalid id', 1, null]) invalid(project => project.documentation.measurements[1].geometry.openings[0].id = value);
for (const value of ['skylight', {}, null]) invalid(project => project.documentation.measurements[1].geometry.openings[0].type = value);
for (const [field, values] of [['offset_m', [-1, 301]], ['width_m', [0, 301]], ['sill_m', [-1, 21]], ['head_m', [0, 21]]]) {
  for (const value of [...values, null, true, '1']) invalid(project => project.documentation.measurements[1].geometry.openings[0][field] = value);
}
invalid(project => project.documentation.measurements[2].geometry.wall_id = '__proto__');
invalid(project => project.documentation.measurements[2].geometry.type = 'skylight');
invalid(project => project.documentation.measurements[3].geometry.model_id = '__proto__');
invalid(project => project.documentation.measurements[3].geometry.dimensions_m.width = -1);
invalid(project => project.documentation.measurements[3].geometry.position_m.y = 21);
for (const field of Object.keys(base.documentation.finishes[0])) invalid(project => delete project.documentation.finishes[0][field]);
for (const value of [null, 'roof', [], 2]) invalid(project => project.documentation.finishes[0].surface = value);
invalid(project => project.documentation.finishes[0].room_id = 'sofa');
invalid(project => project.documentation.finishes[0].floor_id = 'missing');
for (const value of [-0.01, 100.01, true, '5', null]) invalid(project => project.documentation.finishes[0].waste_percent = value);
for (const value of ['x'.repeat(81), '\n', '\t', null]) invalid(project => project.documentation.finishes[0].code = value);
invalid(project => project.documentation.finishes[0].specification = 'x'.repeat(1001));
invalid(project => project.documentation.ceiling_fixture_ids[0].item_id = 'living');
invalid(project => project.documentation.ceiling_fixture_ids[0].floor_id = 'missing');
invalid(project => project.documentation.ceiling_fixture_ids[0].automatic = true);

// Valid, unique references can still exceed the aggregate metadata budget.
const large = blankProject(); large.documentation = createDocumentation();
large.floors[0].rooms = Array.from({ length: 64 }, (_, i) => ({ id: `room_${i}`, name: `Room ${i}`, material: 'floor', polygon: [[i, 0], [i + .9, 0], [i + .9, .9], [i, .9]] }));
for (const room of large.floors[0].rooms) {
  for (const surface of ['floor', 'walls', 'ceiling']) large.documentation.finishes.push({ floor_id: 'ground', room_id: room.id, surface, code: 'F', specification: '界'.repeat(1000), waste_percent: 10 });
}
rejected.push(large);
for (const project of accepted) {
  const before = JSON.stringify(project); assert.equal(validateDocumentation(project.documentation, project), project.documentation); assert.equal(validateProject(project), project); assert.equal(JSON.stringify(project), before);
}
for (const project of rejected) assert.throws(() => validateProject(project));
for (const value of [NaN, Infinity, -Infinity]) {
  const project = clone(base); project.documentation.finishes[0].waste_percent = value; assert.throws(() => validateProject(project));
}

// Every geometry dependency invalidates evidence, while labels/appearance do not.
const stateCases = [];
function states(project) { return project.documentation.measurements.map(row => measurementState(project, row)); }
const measured = clone(base); measured.documentation.measurements.forEach(row => row.status = 'measured');
stateCases.push(clone(measured)); assert.deepEqual(states(measured), ['measured', 'measured', 'measured', 'measured']);
for (const mutate of [p => p.floors[0].height_m += .1, p => p.floors[0].elevation_m += 1]) {
  const project = clone(measured); mutate(project); assert.deepEqual(states(project), ['stale', 'stale', 'stale', 'stale']); stateCases.push(project);
}
for (const mutate of [p => p.floors[0].items[0].position_m.x += .1, p => p.floors[0].items[0].rotation_deg += 1, p => p.floors[0].items[0].dimensions_m.width += .1, p => p.floors[0].items[0].model_id = 'dining_table']) {
  const project = clone(measured); mutate(project); assert.equal(measurementState(project, project.documentation.measurements[3]), 'stale'); stateCases.push(project);
}
const movedWall = clone(measured); movedWall.floors[0].walls.find(wall => wall.id === 'wall_4').thickness_m += .1;
assert.equal(measurementState(movedWall, movedWall.documentation.measurements[2]), 'stale'); stateCases.push(movedWall);
const changedRoom = clone(measured); changedRoom.floors[0].rooms[0].polygon[1][0] -= .1;
assert.equal(measurementState(changedRoom, changedRoom.documentation.measurements[0]), 'stale'); stateCases.push(changedRoom);
const changedOpening = clone(measured); changedOpening.floors[0].openings[0].width_m -= .1;
assert.equal(measurementState(changedOpening, changedOpening.documentation.measurements[2]), 'stale'); stateCases.push(changedOpening);
// Wall-finish evidence must cover the opening set, including a deleted opening
// whose own measurement is pruned. An undo restores the original snapshot.
const wallState = project => measurementState(project, project.documentation.measurements[1]);
const openingChanges = [
  p => p.floors[0].openings.push({ id: 'new_window', wall_id: 'wall_1', type: 'window', offset_m: 5, width_m: .5, sill_m: .8, head_m: 2 }),
  p => { p.floors[0].openings = p.floors[0].openings.filter(o => o.id !== 'view'); },
  p => { p.floors[0].openings.find(o => o.id === 'view').offset_m -= .1; },
  p => { p.floors[0].openings.find(o => o.id === 'view').width_m -= .1; },
  p => { p.floors[0].openings.find(o => o.id === 'view').sill_m += .1; },
  p => { p.floors[0].openings.find(o => o.id === 'view').head_m -= .1; },
  p => { const o = p.floors[0].openings.find(o => o.id === 'view'); o.type = 'passage'; o.sill_m = 0; },
  p => { p.floors[0].openings.find(o => o.id === 'view').id = 'replacement_window'; },
  p => { p.floors[0].openings.find(o => o.id === 'view').wall_id = 'wall_6'; },
];
for (const change of openingChanges) {
  const project = clone(measured), previous = clone(project);
  change(project); project.documentation = pruneDocumentation(project); validateProject(project);
  assert.equal(wallState(project), 'stale');
  assert.deepEqual(project.documentation.measurements[1], previous.documentation.measurements[1]);
  assert.equal(wallState(previous), 'measured'); stateCases.push(project, previous);
}
const deletedDocumentedOpening = clone(measured), deletedRef = ref('opening', 'view');
deletedDocumentedOpening.documentation.measurements.push({ ...deletedRef, status: 'measured', note: 'Opening checked', geometry: measurementGeometry(deletedDocumentedOpening, deletedRef) });
const deletionUndo = clone(deletedDocumentedOpening);
deletedDocumentedOpening.floors[0].openings = deletedDocumentedOpening.floors[0].openings.filter(o => o.id !== 'view');
deletedDocumentedOpening.documentation = pruneDocumentation(deletedDocumentedOpening);
validateProject(deletedDocumentedOpening);
assert.equal(deletedDocumentedOpening.documentation.measurements.some(row => row.target_id === 'view'), false);
assert.equal(wallState(deletedDocumentedOpening), 'stale');
assert.equal(wallState(deletionUndo), 'measured');
stateCases.push(deletedDocumentedOpening, deletionUndo);
const unrelatedOpening = clone(measured); unrelatedOpening.floors[0].openings.find(o => o.id === 'entry').width_m -= .1;
assert.equal(wallState(unrelatedOpening), 'measured'); stateCases.push(unrelatedOpening);
const orderedOpenings = clone(measured);
orderedOpenings.floors[0].openings.push({ id: 'a_window', wall_id: 'wall_1', type: 'window', offset_m: 5, width_m: .5, sill_m: .8, head_m: 2 });
orderedOpenings.documentation.measurements[1].geometry = measurementGeometry(orderedOpenings, references[1]);
assert.deepEqual(orderedOpenings.documentation.measurements[1].geometry.openings.map(o => o.id), ['a_window', 'view']);
const beforeReorder = clone(orderedOpenings.documentation.measurements[1]);
orderedOpenings.floors[0].openings.reverse();
assert.equal(wallState(orderedOpenings), 'measured');
assert.deepEqual(orderedOpenings.documentation.measurements[1], beforeReorder); stateCases.push(orderedOpenings);
const legacyWall = clone(measured); delete legacyWall.documentation.measurements[1].geometry.openings;
const legacyWallBefore = clone(legacyWall); validateProject(legacyWall);
assert.deepEqual(legacyWall, legacyWallBefore); assert.equal(wallState(legacyWall), 'stale'); stateCases.push(clone(legacyWall));
for (const status of ['estimated', 'imported', 'unknown']) {
  const old = clone(legacyWall); old.documentation.measurements[1].status = status;
  assert.equal(wallState(old), status === 'unknown' ? 'unknown' : 'stale'); stateCases.push(old);
}
legacyWall.documentation.measurements[1].geometry = measurementGeometry(legacyWall, references[1]);
assert.equal(wallState(legacyWall), 'measured');
assert.equal(legacyWall.documentation.measurements[1].note, legacyWallBefore.documentation.measurements[1].note); stateCases.push(legacyWall);
const noOpenings = clone(measured); noOpenings.floors[0].openings = [];
noOpenings.documentation = pruneDocumentation(noOpenings);
noOpenings.documentation.measurements[1].geometry = measurementGeometry(noOpenings, references[1]);
assert.deepEqual(noOpenings.documentation.measurements[1].geometry.openings, []);
assert.equal(wallState(noOpenings), 'measured'); stateCases.push(noOpenings);
const detachedWall = measurementGeometry(measured, references[1]); detachedWall.openings[0].width_m = .1;
assert.notEqual(measured.floors[0].openings.find(o => o.id === 'view').width_m, .1);
const renamed = clone(measured); renamed.title = 'Renamed'; renamed.floors[0].items[0].name = 'Renamed sofa'; renamed.floors[0].items[0].notes = 'Private runtime note';
assert.deepEqual(states(renamed), states(measured)); stateCases.push(renamed);
const snapshot = measurementGeometry(base, references[3]); snapshot.position_m.x = -50; assert.notEqual(base.floors[0].items[0].position_m.x, -50);
assert.equal(JSON.stringify(measurementGeometry(base, references[3])).includes('entity_id'), false);
assert.equal(JSON.stringify(measurementGeometry(base, references[3])).includes('notes'), false);
assert.equal(measurementState(base, null), 'unknown');
const removed = clone(measured); removed.floors[0].items = []; const beforePrune = JSON.stringify(removed);
assert.equal(measurementState(removed, removed.documentation.measurements[3]), 'stale');
const pruned = pruneDocumentation(removed); assert.equal(JSON.stringify(removed), beforePrune);
assert.equal(pruned.measurements.length, 3); assert.equal(pruned.ceiling_fixture_ids.length, 0); assert.deepEqual(pruned.measurements[0].geometry, removed.documentation.measurements[0].geometry);
removed.documentation = pruned; validateProject(removed);
const noFloor = clone(base); noFloor.floors = []; assert.deepEqual(pruneDocumentation(noFloor), { ...createDocumentation(), brief: base.documentation.brief });

const python = spawnSync(process.env.PYTHON || 'python3', ['-B', '-c', `import copy,json,sys
from planner.project import validate_project,make_floor
from planner.documentation_model import measurement_geometry,measurement_state,prune_documentation
payload=json.load(sys.stdin)
results=[]
for value in payload['projects']:
    try:
        original=copy.deepcopy(value)
        detached=validate_project(value,complete=False)
        assert value==original and detached==value and detached is not value
        results.append(True)
    except ValueError: results.append(False)
states=[[measurement_state(p,r) for r in p['documentation']['measurements']] for p in payload['states']]
base=payload['base']; stripped=copy.deepcopy(base);del stripped['documentation']
for floor,plain_floor in zip(base['floors'],stripped['floors']):
    assert make_floor(base,floor,None)==make_floor(stripped,plain_floor,None), 'Documentation leaked into generated model or SVG'
print(json.dumps(dict(results=results,states=states,geometry=[measurement_geometry(base,r) for r in payload['refs']],pruned=prune_documentation(payload['removed']))))
`], { cwd: root, input: JSON.stringify({ projects: [...accepted, ...rejected], states: stateCases, base, refs: references, removed }), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
assert.equal(python.status, 0, python.stderr || python.error?.message);
const parity = JSON.parse(python.stdout);
assert.deepEqual(parity.results, [...accepted.map(() => true), ...rejected.map(() => false)]);
assert.deepEqual(parity.states, stateCases.map(states));
assert.deepEqual(parity.geometry, references.map(value => measurementGeometry(base, value)));
assert.deepEqual(parity.pruned, pruneDocumentation(removed));
console.log(`Documentation model: ${accepted.length + rejected.length} validation cases, ${stateCases.length} freshness cases, JS/Python parity and unchanged generated output passed.`);
