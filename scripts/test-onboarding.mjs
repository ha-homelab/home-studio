import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EXAMPLES, loadExample, addMeasuredRoom } from '../planner/onboarding.js';
import { blankProject, clone, validateProject } from '../planner/model.js';

const assets = { practice: 'practice-home', decor: 'decor-studio', patterns: 'pattern-studio', garage: 'garage-and-studio' };
assert.deepEqual(EXAMPLES.map(example => example.id).sort(), Object.keys(assets).sort());
for (const [id, asset] of Object.entries(assets)) {
  const expected = JSON.parse(fs.readFileSync(new URL(`../planner/guide-assets/${asset}.json`, import.meta.url)));
  const loaded = await loadExample(id);
  assert.deepEqual(loaded, expected, `${id}: module matches editable practice asset`);
  validateProject(loaded, { complete: true });
  loaded.title = 'Edited locally';
  assert.deepEqual(await loadExample(id), expected, `${id}: edits never mutate the cached module`);
}
for (const id of ['', '__proto__', 'constructor', '../model', 'https://example.invalid/project.json', 'practice.js', null]) {
  await assert.rejects(loadExample(id), /Unknown example/);
}
const project = blankProject(), floor = project.floors[0];
const id = addMeasuredRoom(floor, { name: ' Measured room ', width: 4.2, depth: 3.6, walls: true });
assert.equal(floor.rooms[0].id, id);
assert.equal(floor.rooms[0].name, 'Measured room');
assert.deepEqual(floor.rooms[0].polygon, [[0, 0], [4.2, 0], [4.2, 3.6], [0, 3.6]]);
assert.equal(floor.walls.length, 4);
validateProject(project, { complete: true });
addMeasuredRoom(floor, { name: 'Open terrace', width: 2, depth: 2, walls: false });
assert.equal(floor.walls.length, 4);
validateProject(project, { complete: true });
for (const invalid of [{ name: '' }, { width: NaN }, { depth: Infinity }, { width: .24 }, { depth: 101 }]) {
  const copy = clone(project);
  assert.throws(() => addMeasuredRoom(copy.floors[0], { name: 'Invalid', width: 4, depth: 3, walls: true, ...invalid }));
  assert.deepEqual(copy, project, 'Invalid dimensions/name do not partially add a room');
}
console.log('Onboarding model checks passed: four exact example assets, bounded identifiers, isolated copies, measured geometry and validation.');
