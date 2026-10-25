#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { blankProject, clone, demoProject, validateProject } from '../planner/model.js';
import { createSite } from '../planner/site-model.js';
import { createDraftContext, draftSchema, prepareDraft, serializeProject } from '../ai/draft.js';

let checks = 0;
function test(name, run) { try { run(); checks++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; } }
const root = fileURLToPath(new URL('../', import.meta.url));
const notes = { own_home: 'The white house in photo 1 is mine.\nPhoto 2 shows its rear.', include: 'My roof, the right neighbor and the street.', reference: 'Front wall 10 m along +X; street is toward +Z.' };
const contextFor = (project, overrides = {}) => createDraftContext(project, { mode: 'site', siteNotes: notes, ...overrides });
const feature = (overrides = {}) => ({ candidate_key: 'photo_home', name: 'My home', kind: 'home', polygon: [[0, 0], [10, 0], [10, 8], [0, 8]], height_m: 6, color: '#d6d1c2', evidence: 'White house in photo 1; height estimated.', ...overrides });
const response = (context, overrides = {}) => ({ draft_version: 1, request_id: context.request_id, kind: 'site', features: [feature()], assumptions: ['Height and depth are estimates.'], needs_measurements: ['Confirm height and depth.'], ...overrides });
const project = demoProject();
project.site = { ground_elevation_m: -1.5, features: [{ id: 'home_1', name: 'Existing garage', kind: 'building', polygon: [[-5, 0], [-2, 0], [-2, 3], [-5, 3]], height_m: 3, color: '#aabbcc' }] };
const original = serializeProject(project), context = contextFor(project), draft = response(context);
const prepared = prepareDraft(project, context, draft), fixtures = [prepared.project];

test('site merge preserves every existing field and allocates safe IDs', () => {
  assert.equal(serializeProject(project), original);
  assert.equal(JSON.stringify(prepared.project.floors), JSON.stringify(project.floors));
  assert.deepEqual({ ...prepared.project, site: undefined }, { ...project, site: undefined });
  assert.equal(prepared.project.site.ground_elevation_m, -1.5);
  assert.deepEqual(prepared.project.site.features[0], project.site.features[0]);
  assert.equal(prepared.project.site.features[1].id, 'home_2');
  assert.equal(Object.hasOwn(prepared.project.site.features[1], 'evidence'), false);
  assert.equal(Object.hasOwn(prepared.project.site.features[1], 'candidate_key'), false);
  assert.match(prepared.summary, /interior geometry remain unchanged/);
  assert.match(prepared.warnings.join(' '), /approximate/);
  prepared.project.site.features[1].polygon[0][0] = -0.5;
  assert.equal(draft.features[0].polygon[0][0], 0);
});
test('context sends only disclosed site, reference footprints and user text', () => {
  assert.deepEqual(context.site, project.site);
  assert.deepEqual(context.site_notes, notes);
  assert.deepEqual(context.floor_footprints[0].polygons, project.floors[0].rooms.map(room => room.polygon));
  for (const secret of ['entity_id', 'light.demo', 'Studio', 'Example entity', 'catalog', 'ha_floor_id']) assert.equal(JSON.stringify(context).includes(secret), false, secret);
  assert.throws(() => { context.site.features[0].name = 'Changed'; }, TypeError);
  assert.throws(() => { context.site_notes.own_home = 'Changed'; }, TypeError);
});
test('requires own-home identification without requiring a selected floor or room', () => {
  const empty = blankProject(), captured = contextFor(empty);
  assert.deepEqual(captured.site, createSite());
  assert.equal(prepareDraft(empty, captured, response(captured)).project.site.features.length, 1);
  for (const siteNotes of [undefined, {}, { ...notes, own_home: '' }, { ...notes, own_home: '  ' }, { ...notes, reference: 'x'.repeat(1001) }, { ...notes, latitude: 0 }]) assert.throws(() => contextFor(empty, { siteNotes }));
});
test('all site kinds can be reviewed and selected independently', () => {
  const features = [feature(), feature({ candidate_key: 'roof', name: 'Roof', kind: 'roof', height_m: 6 }), feature({ candidate_key: 'neighbor', kind: 'building' }), feature({ candidate_key: 'street', kind: 'street', height_m: 0 }), feature({ candidate_key: 'garden', kind: 'landscape', height_m: 0 })];
  const all = prepareDraft(project, context, response(context, { features }));
  assert.equal(all.candidates.length, 5); assert.equal(all.project.site.features.length, 6); fixtures.push(all.project);
  const selected = prepareDraft(project, context, response(context, { features }), { selectedCandidateKeys: ['roof', 'street'] });
  assert.deepEqual(selected.project.site.features.slice(1).map(value => value.kind), ['roof', 'street']);
  assert.deepEqual(prepareDraft(project, context, draft, { selectedCandidateKeys: [] }).project, project);
  const blank = blankProject(), blankContext = contextFor(blank);
  assert.equal(Object.hasOwn(prepareDraft(blank, blankContext, response(blankContext), { selectedCandidateKeys: [] }).project, 'site'), false);
  for (const selectedCandidateKeys of [['missing'], ['photo_home', 'photo_home'], 'photo_home']) assert.throws(() => prepareDraft(project, context, draft, { selectedCandidateKeys }));
});
test('stale project, forged context and mismatched response cannot apply', () => {
  assert.throws(() => prepareDraft(project, clone(context), draft), /context/);
  const changed = clone(project); changed.floors[0].items[0].entity_id = 'light.changed';
  assert.throws(() => prepareDraft(changed, context, draft), /project changed/);
  const changedSite = clone(project); changedSite.site.ground_elevation_m = 1;
  assert.throws(() => prepareDraft(changedSite, context, draft), /project changed/);
  for (const patch of [{ request_id: 'old_request' }, { kind: 'new_room' }, { draft_version: 2 }]) assert.throws(() => prepareDraft(project, context, { ...draft, ...patch }), /request|version/);
});
test('rejects injected actions, geocoordinates, private fields and project IDs', () => {
  for (const name of ['id', 'site', 'ground_elevation_m', 'floors', 'items', 'entity_id', 'url', 'command', 'latitude', 'longitude', 'georeference', 'api_key']) {
    assert.throws(() => prepareDraft(project, context, { ...draft, [name]: 'injected' }), /unknown/);
    assert.throws(() => prepareDraft(project, context, response(context, { features: [feature({ [name]: 'injected' })] })), /unknown/);
  }
  for (const name of Object.keys(feature())) { const missing = feature(); delete missing[name]; assert.throws(() => prepareDraft(project, context, response(context, { features: [missing] })), /missing/); }
  for (const candidate_key of ['../bad', '__proto__', 'constructor', '__defineGetter__']) assert.throws(() => prepareDraft(project, context, response(context, { features: [feature({ candidate_key })] })));
  assert.throws(() => prepareDraft(project, context, response(context, { features: [feature(), feature()] })), /unique/);
  assert.throws(() => prepareDraft(project, context, JSON.stringify(draft).replace('"draft_version":1', '"draft_version":1,"draft_version":1')), /duplicate/);
});
test('bounded simple polygons and numeric dimensions are mandatory even when unchecked', () => {
  const overrides = [{ polygon: null }, { polygon: [] }, { polygon: [[0, 0], [1, 1]] }, { polygon: [[0, 0], [2, 2], [0, 2], [2, 0]] },
    { polygon: [[0, 0], [2, 0], [2, 2], [0, 0]] }, { polygon: [[0, 0, 0], [2, 0], [2, 2]] }, { polygon: [[0, 0], [1001, 0], [0, 2]] },
    { polygon: [[0, 0], [Infinity, 0], [0, 2]] }, { height_m: -1 }, { height_m: 101 }, { height_m: NaN }, { height_m: '3' },
    { kind: 'street', height_m: 1 }, { kind: 'landscape', height_m: 1 }, { kind: 'script' }, { color: 'url(invalid)' }, { name: '\ud800' }];
  for (const value of overrides) assert.throws(() => prepareDraft(project, context, response(context, { features: [feature(value)] }), { selectedCandidateKeys: [] }));
});
test('feature and aggregate vertex capacity include the existing site', () => {
  const features = Array.from({ length: 65 }, (_, i) => feature({ candidate_key: `f_${i}` }));
  assert.throws(() => prepareDraft(project, context, response(context, { features })), /64/);
  const ring = n => Array.from({ length: n }, (_, i) => [20 * Math.cos(i * Math.PI * 2 / n), 20 * Math.sin(i * Math.PI * 2 / n)]);
  assert.throws(() => prepareDraft(project, context, response(context, { features: [feature({ polygon: ring(65) })] })), /64/);
  const manyVertices = Array.from({ length: 17 }, (_, i) => feature({ candidate_key: `f_${i}`, polygon: ring(64) }));
  assert.throws(() => prepareDraft(project, context, response(context, { features: manyVertices })), /1024/);
  assert.throws(() => prepareDraft(project, context, response(context, { features: features.slice(0, 64) })), /64/);
  assert.throws(() => prepareDraft(project, context, response(context, { features: manyVertices.slice(0, 16) })), /1024/);
});
test('strict schema and real site context serialize through every provider', () => {
  const schema = draftSchema('site');
  function inspect(node) { if (!node || typeof node !== 'object') return; if (node.type === 'object') { assert.equal(node.additionalProperties, false); assert.deepEqual(node.required, Object.keys(node.properties)); } Object.values(node).forEach(inspect); }
  inspect(schema);
  const request = { request_id: context.request_id, mode: 'site', context, instructions: 'Use the supplied references.', images: [], schema };
  const result = spawnSync('python3', ['-c', `
import copy,json,sys
from ai_companion.protocol import CompanionError,dumps,validate_generate
from ai_companion.providers import PROFILES,SITE_RULES,request_payload
request=json.load(sys.stdin)
validate_generate(request)
for profile in PROFILES.values():
    payload=request_payload(profile,'synthetic-model',request)
    prompt=payload.get('instructions',payload.get('system')) or payload['messages'][0]['content']
    assert SITE_RULES in prompt
    assert 'Never infer or return latitude' in prompt
    dumps(payload)
for field in ('catalog','room','api_key','georeference'):
    bad=copy.deepcopy(request);bad['context'][field]={}
    try: validate_generate(bad)
    except CompanionError: pass
    else: raise AssertionError(field)
for field in ('api_key','entity_id','notes','token'):
    bad=copy.deepcopy(request);bad['context']['site'][field]='private'
    try: validate_generate(bad)
    except CompanionError: pass
    else: raise AssertionError(field)
`], { cwd: root, input: JSON.stringify(request), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
test('accepted site drafts round-trip and compile with interior data unchanged', () => {
  for (const fixture of fixtures) { const reloaded = JSON.parse(serializeProject(fixture)); validateProject(reloaded); assert.deepEqual(reloaded, fixture); assert.equal(JSON.stringify(reloaded.floors), JSON.stringify(project.floors)); }
  const result = spawnSync('python3', ['-c', `
import json,pathlib,subprocess,sys,tempfile
from planner.project import validate_project
projects=json.load(sys.stdin)
for project in projects: validate_project(project)
with tempfile.TemporaryDirectory(prefix='home-studio-ai-site-') as directory:
    root=pathlib.Path(directory).resolve();source=root/'project.json';destination=root/'compiled'
    source.write_text(json.dumps(projects[-1]),encoding='utf-8')
    result=subprocess.run([sys.executable,'scripts/build-planner-project.py','--project',str(source),'--output',str(destination)],capture_output=True,text=True)
    assert result.returncode==0,result.stderr
    restored=json.loads((destination/'project.json').read_text())
    assert restored==projects[-1]
`], { cwd: root, input: JSON.stringify(fixtures), encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
console.log(`AI site draft: ${checks} checks passed.`);
