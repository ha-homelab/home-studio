#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CATALOG } from '../planner/furniture.js';
import { blankProject, clone, demoProject, newFloor, validateProject } from '../planner/model.js';
import { createDraftContext, draftSchema, footprintInsideRoom, itemFootprint, parseDraftJSON, prepareDraft, serializeProject } from '../ai/draft.js';

let checks = 0;
function test(name, run) {
  try { run(); checks++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
}
function item(overrides = {}) {
  return { candidate_key: 'candidate_1', name: 'Chair', model_id: 'dining_chair', style_id: 'contemporary',
    position_m: { x: 4.8, y: 0, z: 1.4 }, dimensions_m: { width: 0.5, depth: 0.5, height: 0.8 },
    rotation_deg: 0, evidence: 'Visible chair; dimensions are catalog estimates.', ...overrides };
}
function response(context, overrides = {}) {
  return { draft_version: 1, request_id: context.request_id, kind: context.mode, items: [item()], assumptions: ['Item sizes are estimates.'], needs_measurements: ['Confirm the chair size.'],
    ...(context.mode === 'new_room' ? { room_name: 'Measured room', openings: [] } : {}), ...overrides };
}
function contextFor(project = demoProject()) {
  return createDraftContext(project, { floorId: 'ground', roomId: 'living', mode: 'furnish_room' });
}
const base = demoProject(), context = contextFor(base), valid = response(context);
const original = serializeProject(base), result = prepareDraft(base, context, JSON.stringify(valid));
const fixtures = [result.project];

test('furnishing is additive, detached, and preserves bindings', () => {
  assert.equal(serializeProject(base), original);
  assert.deepEqual(result.project.floors[0].items.slice(0, base.floors[0].items.length), base.floors[0].items);
  assert.deepEqual(result.project.floors[0].rooms, base.floors[0].rooms);
  assert.deepEqual(result.project.floors[0].walls, base.floors[0].walls);
  const added = result.project.floors[0].items.at(-1);
  assert.equal(added.type, 'furniture'); assert.equal(added.entity_id, ''); assert.equal(added.notes, '');
  assert.equal(added.room, 'living'); assert.equal(Object.hasOwn(added, 'evidence'), false);
  assert.equal(result.candidates[0].item.evidence, valid.items[0].evidence);
  assert.deepEqual(result.needsMeasurements, valid.needs_measurements);
  const detached = prepareDraft(base, context, valid);
  detached.project.floors[0].items.at(-1).position_m.x = 0;
  assert.equal(valid.items[0].position_m.x, 4.8);
});
test('context sends only selected geometry and descriptors', () => {
  const serialized = JSON.stringify(context);
  for (const secret of ['entity_id', 'notes', 'light.demo', 'Studio', 'Terrace', 'Example entity', 'parts']) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(context.catalog.models.length, CATALOG.models.length);
  assert.equal(context.existing_items.length, 3);
  assert.throws(() => { context.room.polygon[0][0] = 200; }, TypeError);
});
test('requires legitimate frozen context and unchanged complete project', () => {
  assert.throws(() => prepareDraft(base, clone(context), valid), /context/);
  const changed = clone(base); changed.floors[0].items[0].entity_id = 'light.changed';
  assert.throws(() => prepareDraft(changed, context, valid), /project changed/);
  assert.throws(() => contextFor(blankProject()), /existing room/);
  assert.throws(() => createDraftContext(base, { floorId: 'other', roomId: 'living' }), /target floor/);
});
test('rejects unknown fields at every model-owned nesting level', () => {
  for (const key of ['entity_id', 'url', 'file_path', 'command', 'project', 'walls', 'floor_id', 'room_id']) {
    assert.throws(() => prepareDraft(base, context, { ...valid, [key]: 'malicious' }), /unknown fields/, key);
    assert.throws(() => prepareDraft(base, context, response(context, { items: [item({ [key]: 'malicious' })] })), /unknown fields/, key);
  }
  assert.throws(() => prepareDraft(base, context, response(context, { items: [item({ position_m: { x: 1, y: 0, z: 1, entity_id: 'light.x' } })] })), /unknown fields/);
  assert.throws(() => prepareDraft(base, context, response(context, { items: [item({ dimensions_m: { width: 1, depth: 1, height: 1, scale: 1 } })] })), /unknown fields/);
});
test('rejects duplicate and reserved JSON keys including escaped duplicates', () => {
  for (const raw of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"a":{"x":1,"x":2}}']) assert.throws(() => parseDraftJSON(raw), /duplicate/);
  for (const raw of ['{"__proto__":{"polluted":true}}', '{"constructor":1}', '{"prototype":1}']) assert.throws(() => parseDraftJSON(raw), /reserved/);
  assert.equal({}.polluted, undefined);
  const raw = JSON.stringify(valid).replace('"draft_version":1', '"draft_version":0,"draft_version":1');
  assert.throws(() => prepareDraft(base, context, raw), /duplicate/);
});
test('rejects non-JSON, wrappers, truncation, nonfinite values and excessive input', () => {
  for (const raw of ['undefined', 'NaN', 'Infinity', '1e1000', '[1,]', '{"a":1,}', '{"a":', '{"a":01}', '```json\n{}\n```', '{} {}', 'truex', '"unterminated', '\ufeff{}']) assert.throws(() => parseDraftJSON(raw), /JSON|finite/);
  assert.throws(() => parseDraftJSON(' '.repeat(256 * 1024) + '{}'), /256 KiB/);
  assert.throws(() => parseDraftJSON('['.repeat(33) + '0' + ']'.repeat(33)), /complex/);
  for (const bad of [NaN, Infinity, -Infinity, undefined, () => {}, 1n]) assert.throws(() => parseDraftJSON({ bad }), /finite JSON/);
  assert.throws(() => parseDraftJSON(new Date()), /plain JSON/);
  const cyclic = {}; cyclic.self = cyclic; assert.throws(() => parseDraftJSON(cyclic), /cycles/);
  const sparse = []; sparse[2] = 1; assert.throws(() => parseDraftJSON(sparse), /holes/);
  let executed = false;
  const getter = Object.defineProperty({}, 'run', { enumerable: true, get() { executed = true; return 1; } });
  assert.throws(() => parseDraftJSON(getter), /plain JSON/); assert.equal(executed, false);
  assert.deepEqual(parseDraftJSON('{"escaped":"quote \\\" and slash \\\\","values":[true,false,null,-2.3e+2]}'), { escaped: 'quote " and slash \\', values: [true, false, null, -230] });
});
test('response scope and version never select the target', () => {
  for (const override of [{ kind: 'new_room' }, { request_id: 'different' }, { draft_version: 2 }]) assert.throws(() => prepareDraft(base, context, { ...valid, ...override }), /request|version/);
  const missing = clone(valid); delete missing.items; assert.throws(() => prepareDraft(base, context, missing), /missing/);
});
test('missing required fields and null geometry cannot bypass the local contract', () => {
  for (const field of Object.keys(item())) {
    const missing = item(); delete missing[field];
    assert.throws(() => prepareDraft(base, context, response(context, { items: [missing] })), /missing/, field);
  }
  for (const field of ['position_m', 'dimensions_m', 'model_id', 'style_id', 'rotation_deg', 'candidate_key']) assert.throws(() => prepareDraft(base, context, response(context, { items: [item({ [field]: null })] })), undefined, field);
  for (const field of ['items', 'assumptions', 'needs_measurements']) assert.throws(() => prepareDraft(base, context, { ...valid, [field]: null }), /array/);
});
test('catalog and appearance form a closed vocabulary', () => {
  for (const override of [{ model_id: 'download_me' }, { style_id: 'arbitrary' }, { color: 'javascript:alert(1)' }, { pattern_id: 'custom' }, { pattern_id: 'none', pattern_color: '#ffffff' }, { model_id: 'round_rug', pattern_id: 'dots' }]) {
    assert.throws(() => prepareDraft(base, context, response(context, { items: [item(override)] })), /Unknown|color|pattern/);
  }
  const colored = prepareDraft(base, context, response(context, { items: [item({ model_id: 'rug', color: '#abcDEF', pattern_id: 'checks', pattern_color: '#112233' })] }));
  assert.equal(colored.project.floors[0].items.at(-1).pattern_color, '#112233'); fixtures.push(colored.project);
  const nullable = prepareDraft(base, context, response(context, { items: [item({ color: null, pattern_id: null, pattern_color: null })] }));
  assert.equal(Object.hasOwn(nullable.project.floors[0].items.at(-1), 'color'), false);
});
test('numbers, text and candidate limits are bounded', () => {
  for (const override of [{ rotation_deg: 36001 }, { rotation_deg: NaN }, { name: 'a'.repeat(101) }, { name: '\ud800' }, { evidence: '\n' }, { candidate_key: '../file' }, { candidate_key: 'constructor' }]) assert.throws(() => prepareDraft(base, context, response(context, { items: [item(override)] })));
  assert.throws(() => prepareDraft(base, context, response(context, { items: [item(), item()] })), /unique/);
  assert.throws(() => prepareDraft(base, context, response(context, { items: Array(65).fill(item()) })), /64/);
  assert.throws(() => prepareDraft(base, context, { ...valid, assumptions: Array(17).fill('x') }), /16/);
  assert.throws(() => prepareDraft(base, context, { ...valid, needs_measurements: ['x'.repeat(301)] }), /300/);
  assert.throws(() => prepareDraft(base, context, response(context, { items: [item({ dimensions_m: { width: 0, depth: 1, height: 1 } })] })), /width/);
});
test('normalizes rotation visibly and uses renderer clockwise coordinates', () => {
  const normalized = prepareDraft(base, context, response(context, { items: [item({ rotation_deg: -450 })] }));
  assert.equal(normalized.project.floors[0].items.at(-1).rotation_deg, 270);
  assert.match(normalized.warnings.join(' '), /normalized/);
  const footprint = itemFootprint(item({ rotation_deg: 90, position_m: { x: 0, y: 0, z: 0 }, dimensions_m: { width: 2, depth: 1, height: 1 } }));
  assert.ok(Math.abs(footprint[0][0] + 0.5) < 1e-8 && Math.abs(footprint[0][1] - 1) < 1e-8);
});
test('rejects rotated out-of-room footprints and above-ceiling items', () => {
  assert.throws(() => prepareDraft(base, context, response(context, { items: [item({ position_m: { x: 0.2, y: 0, z: 2 }, rotation_deg: 45 })] })), /footprint/);
  assert.throws(() => prepareDraft(base, context, response(context, { items: [item({ position_m: { x: 3, y: 2.5, z: 2 } })] })), /ceiling/);
});
test('checks entire edges in concave rooms, including notch vertices', () => {
  const polygon = [[0, 0], [4, 0], [4, 4], [3, 4], [3, 1], [1, 1], [1, 4], [0, 4]];
  const bridge = item({ position_m: { x: 2, y: 0, z: 2.5 }, dimensions_m: { width: 3, depth: 1, height: 0.5 } });
  assert.equal(footprintInsideRoom(bridge, polygon), false);
  assert.equal(footprintInsideRoom(item({ position_m: { x: 2, y: 0, z: 0.5 }, dimensions_m: { width: 4, depth: 1, height: 0.5 } }), polygon), true);
  const notched = [[0, 0], [4, 0], [4, 4], [3, 4], [2, 2], [1, 4], [0, 4]];
  assert.equal(footprintInsideRoom(item({ position_m: { x: 2, y: 0, z: 3 }, dimensions_m: { width: 4, depth: 2, height: 0.5 } }), notched), false);
  const concave = blankProject(); concave.floors[0].rooms.push({ id: 'living', name: 'Concave', polygon, material: 'floor' });
  assert.throws(() => prepareDraft(concave, contextFor(concave), response(contextFor(concave))), /request/);
  const captured = contextFor(concave); assert.throws(() => prepareDraft(concave, captured, response(captured, { items: [bridge] })), /footprint/);
});
test('selection omits individual candidates without touching existing items', () => {
  const selected = prepareDraft(base, context, valid, { selectedCandidateKeys: [] });
  assert.deepEqual(selected.project, base);
  assert.equal(selected.candidates.length, 1);
  assert.throws(() => prepareDraft(base, context, valid, { selectedCandidateKeys: ['absent'] }), /known/);
  assert.throws(() => prepareDraft(base, context, valid, { selectedCandidateKeys: ['candidate_1', 'candidate_1'] }), /unique/);
});
test('overlapping furniture and rug layers produce review warnings', () => {
  const overlap = prepareDraft(base, context, response(context, { items: [item({ model_id: 'rug', position_m: { x: 4.2, y: 0, z: 3.4 }, dimensions_m: { width: 2, depth: 2, height: 0.03 } })] }));
  assert.match(overlap.warnings.join(' '), /overlaps Dining table/);
  validateProject(overlap.project);
  const obstruction = prepareDraft(base, context, response(context, { items: [item({ position_m: { x: 2, y: 0, z: 4.75 } })] }));
  assert.match(obstruction.warnings.join(' '), /obstruct.*passage/);
});

const empty = blankProject();
const newContext = createDraftContext(empty, { floorId: 'ground', mode: 'new_room', measurements: { width: 4, depth: 4, height: 3 }, origin: { x: 0, z: 0 } });
const newResponse = response(newContext, { items: [item({ position_m: { x: 2, y: 0, z: 2 } })], openings: [{ candidate_key: 'opening_1', edge_index: 0, type: 'window', offset_m: 0.5, width_m: 1, sill_m: 0.8, head_m: 2.2 }] });
const created = prepareDraft(empty, newContext, newResponse).project;
fixtures.push(created);
test('new measured room creates exact editable geometry, walls, openings and furniture', () => {
  assert.equal(empty.floors[0].rooms.length, 0); assert.equal(empty.floors[0].height_m, 2.7);
  const floor = created.floors[0]; assert.equal(floor.height_m, 3); assert.equal(floor.walls.length, 4);
  assert.deepEqual(floor.rooms[0].polygon, [[0, 0], [4, 0], [4, 4], [0, 4]]);
  assert.equal(floor.items[0].room, floor.rooms[0].id); assert.equal(floor.openings[0].type, 'window');
  assert.equal(floor.openings[0].wall_id, floor.walls[0].id);
  validateProject(created, { complete: true });
});
test('measured geometry requires user dimensions and cannot be model overridden', () => {
  for (const values of [{}, { measurements: { width: 4, depth: 4, height: 3 } }, { measurements: { width: 4, depth: 4, height: NaN }, origin: { x: 0, z: 0 } }, { measurements: { width: 4, depth: 4, height: 3 }, origin: { x: 99, z: 0 } }]) assert.throws(() => createDraftContext(empty, { floorId: 'ground', mode: 'new_room', ...values }));
  assert.throws(() => prepareDraft(empty, newContext, { ...newResponse, polygon: [[1, 1], [2, 1], [2, 2]] }), /unknown/);
  assert.throws(() => prepareDraft(empty, newContext, { ...newResponse, measurements: { width: 8, depth: 8, height: 8 } }), /unknown/);
  assert.throws(() => createDraftContext(created, { floorId: 'ground', mode: 'new_room', measurements: { width: 4, depth: 4, height: 2.7 }, origin: { x: 4, z: 0 } }), /ceiling height must match/);
});
test('strict opening bounds and unknown fields are independently checked', () => {
  for (const override of [{ edge_index: 4 }, { edge_index: 1.5 }, { offset_m: 3.5 }, { width_m: 0 }, { sill_m: 2.5 }, { head_m: 4 }, { type: 'door', sill_m: 0.1 }, { type: 'script' }, { wall_id: 'existing' }, { candidate_key: 'candidate_1' }]) assert.throws(() => prepareDraft(empty, newContext, { ...newResponse, openings: [{ ...newResponse.openings[0], ...override }] }));
  assert.throws(() => prepareDraft(empty, newContext, { ...newResponse, openings: [newResponse.openings[0], { ...newResponse.openings[0], candidate_key: 'opening_2' }] }), /cannot overlap/);
});
const adjacentContext = createDraftContext(created, { floorId: 'ground', mode: 'new_room', measurements: { width: 4, depth: 4, height: 3 }, origin: { x: 4, z: 0 } });
const adjacentDraft = response(adjacentContext, { items: [], room_name: 'Second room', openings: [{ candidate_key: 'door_1', edge_index: 3, type: 'door', offset_m: 0.5, width_m: 1, sill_m: 0, head_m: 2.1 }] });
const adjacent = prepareDraft(created, adjacentContext, adjacentDraft);
fixtures.push(adjacent.project);
test('iterative new rooms reuse shared walls and reverse opening offsets', () => {
  assert.equal(adjacent.project.floors[0].rooms.length, 2); assert.equal(adjacent.project.floors[0].walls.length, 7);
  assert.deepEqual(adjacent.project.floors[0].rooms[0], created.floors[0].rooms[0]);
  assert.deepEqual(adjacent.project.floors[0].items, created.floors[0].items);
  assert.deepEqual(adjacent.project.floors[0].walls.slice(0, 4), created.floors[0].walls);
  assert.equal(adjacent.project.floors[0].openings[1].wall_id, created.floors[0].walls[1].id);
  assert.equal(adjacent.project.floors[0].openings[1].offset_m, 2.5);
  assert.match(adjacent.warnings.join(' '), /shared wall/);
});
test('new openings warn about obstructions from the existing side of shared walls', () => {
  const occupied = clone(created);
  occupied.floors[0].items[0].position_m = { x: 3.75, y: 0, z: 3 };
  const captured = createDraftContext(occupied, { floorId: 'ground', mode: 'new_room', measurements: { width: 4, depth: 4, height: 3 }, origin: { x: 4, z: 0 } });
  const prepared = prepareDraft(occupied, captured, { ...adjacentDraft, request_id: captured.request_id });
  assert.match(prepared.warnings.join(' '), /Chair may obstruct the proposed door/);
});
test('rejects overlapping rooms and partial shared wall changes before request', () => {
  assert.throws(() => createDraftContext(created, { floorId: 'ground', mode: 'new_room', measurements: { width: 4, depth: 4, height: 3 }, origin: { x: 0, z: 0 } }), /overlap/);
  assert.throws(() => createDraftContext(created, { floorId: 'ground', mode: 'new_room', measurements: { width: 4, depth: 3, height: 3 }, origin: { x: 4, z: 0 } }), /partly overlaps/);
});
test('more than two rooms retain unique IDs and work on another floor', () => {
  let project = adjacent.project;
  for (let i = 2; i < 6; i++) {
    const captured = createDraftContext(project, { floorId: 'ground', mode: 'new_room', measurements: { width: 4, depth: 4, height: 3 }, origin: { x: 4 * i, z: 0 } });
    project = prepareDraft(project, captured, response(captured, { items: [], room_name: `Room ${i + 1}` })).project;
  }
  const floor = project.floors[0], ids = ['rooms', 'walls', 'openings', 'items'].flatMap(collection => floor[collection].map(value => value.id));
  assert.equal(new Set(ids).size, ids.length); assert.equal(floor.rooms.length, 6); assert.equal(floor.walls.length, 19);
  assert.deepEqual(floor.items, created.floors[0].items); fixtures.push(project);
  const upperProject = clone(project); upperProject.floors.push(newFloor('upper', 'Upper', 3));
  const upperContext = createDraftContext(upperProject, { floorId: 'upper', mode: 'new_room', measurements: { width: 4, depth: 4, height: 2.5 }, origin: { x: 0, z: 0 } });
  const upper = prepareDraft(upperProject, upperContext, response(upperContext, { items: [], room_name: 'Upper room' })).project;
  assert.deepEqual(upper.floors[0], project.floors[0]); assert.equal(upper.floors[1].rooms.length, 1); fixtures.push(upper);
});
test('provider schema has strict deterministic object properties', () => {
  function inspect(schema) {
    if (schema.type === 'object') { assert.equal(schema.additionalProperties, false); assert.deepEqual(schema.required, Object.keys(schema.properties)); Object.values(schema.properties).forEach(inspect); }
    if (schema.items) inspect(schema.items);
  }
  inspect(draftSchema()); inspect(draftSchema('new_room'));
  assert.equal(draftSchema().items, undefined);
  assert.deepEqual(draftSchema().properties.items.items.properties.model_id.enum, CATALOG.models.map(model => model.id));
  assert.throws(() => draftSchema('replace_everything'), /mode/);
});
test('project size uses UTF-8 bytes and merged capacity is enforced', () => {
  assert.throws(() => serializeProject({ text: '界'.repeat(666667) }), /2 MB/);
  const full = demoProject(), floor = full.floors[0];
  floor.items = Array.from({ length: 256 }, (_, index) => ({ ...clone(floor.items[0]), id: `item_${index}` }));
  const captured = contextFor(full); assert.throws(() => prepareDraft(full, captured, response(captured)), /maximum 256/);
});

if (process.argv.includes('--fixtures')) {
  process.stdout.write(JSON.stringify(fixtures));
} else {
  test('real contexts and strict schemas fit every configured provider adapter', () => {
    const requests = [context, newContext].map(value => ({ request_id: value.request_id, mode: value.mode,
      context: value, instructions: 'Describe measured room additions.', images: [], schema: draftSchema(value.mode) }));
    const execution = spawnSync('python3', ['-c', `
import json, sys
from ai_companion.protocol import bounded_tree, dumps, validate_generate
from ai_companion.providers import PROFILES, request_payload
for request in json.load(sys.stdin):
    bounded_tree(request)
    validate_generate(request)
    for profile in PROFILES.values():
        payload = request_payload(profile, "test-model", request)
        assert payload["model"] == "test-model"
        dumps(payload)
`], { cwd: fileURLToPath(new URL('../', import.meta.url)), input: JSON.stringify(requests), encoding: 'utf8', maxBuffer: 1024 * 1024 });
    assert.equal(execution.status, 0, execution.stderr || execution.error?.message);
  });
  test('accepted projects pass the independent Python validator', () => {
    const execution = spawnSync('python3', ['-c', 'import json,sys; from planner.project import validate_project; [validate_project(p) for p in json.load(sys.stdin)]'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), input: JSON.stringify(fixtures), encoding: 'utf8', maxBuffer: 1024 * 1024,
    });
    assert.equal(execution.status, 0, execution.stderr || execution.error?.message);
  });
  test('accepted projects compile, round-trip and install into a temporary HA config', () => {
    const execution = spawnSync('python3', ['-c', `
import json, pathlib, subprocess, sys, tempfile
projects = json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix="home-studio-ai-e2e-") as temporary:
    # macOS /var is a symlink; the installer deliberately rejects such ancestors.
    root = pathlib.Path(temporary).resolve()
    for index, project in enumerate(projects):
        case = root / str(index)
        case.mkdir()
        source, destination = case / "project.json", case / "compiled"
        source.write_text(json.dumps(project), encoding="utf-8")
        subprocess.run([sys.executable, "scripts/build-planner-project.py", "--project", str(source), "--output", str(destination), "--ha-package"], check=True, capture_output=True)
        assert json.loads((destination / "project.json").read_text()) == project
        archives = list(destination.rglob("home-floorplan.tar.gz"))
        assert len(archives) == 1
        config = case / "ha-config"
        config.mkdir()
        subprocess.run([sys.executable, "scripts/install-home-assistant.py", str(archives[0]), "--config", str(config)], check=True, capture_output=True)
        assert (config / "custom_components" / "home_floorplan" / "manifest.json").is_file()
`], { cwd: fileURLToPath(new URL('../', import.meta.url)), input: JSON.stringify(fixtures), encoding: 'utf8', maxBuffer: 1024 * 1024 });
    assert.equal(execution.status, 0, execution.stderr || execution.error?.message);
  });
  console.log(`AI draft contract: ${checks} checks passed; ${fixtures.length} projects validated, compiled, round-tripped, and installed into temporary HA configs.`);
}
