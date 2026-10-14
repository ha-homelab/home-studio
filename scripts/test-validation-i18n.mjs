// Validation metadata preserves public English errors and never translates data.
import assert from 'node:assert/strict';
import { blankProject, clone, outlineRoom, validateProject } from '../planner/model.js';
import { validateFurnitureAppearance } from '../planner/furniture.js';
import { ValidationError, formatValidationError } from '../planner/validation.js';
import english from '../planner/locales/en.js';

const base = blankProject();
base.floors[0].rooms.push({ id: 'room', name: 'Room', polygon: [[0, 0], [4, 0], [4, 4], [0, 4]], material: 'floor' });
const wall = { id: 'wall', start: [0, 0], end: [4, 0], thickness_m: .15 };
const opening = { id: 'opening', wall_id: 'wall', type: 'window', offset_m: .5, width_m: 1, sill_m: .8, head_m: 2 };
const item = { id: 'item', name: 'Room', type: 'furniture', room: 'room', position_m: { x: 2, y: 0, z: 2 }, dimensions_m: { width: 1, depth: 1, height: 1 }, rotation_deg: 0, entity_id: '', notes: '' };
const errors = [];
function reject(change, expected) {
  const project = clone(base); change(project, project.floors[0]);
  const before = clone(project);
  let caught;
  try { validateProject(project); } catch (error) { caught = error; }
  assert(caught instanceof ValidationError, expected);
  assert.equal(caught.message, expected, 'public English message is unchanged');
  assert.deepEqual(project, before, 'validation must not mutate project data');
  assert(Object.hasOwn(english, caught.translation.key), 'error key is in the canonical catalog');
  assert(Object.isFrozen(caught.translation) && Object.isFrozen(caught.translation.params));
  errors.push(caught); return caught;
}
const range = reject((_p, floor) => { floor.height_m = .25; }, 'Ceiling height must be a number from 0.5 to 20.');
assert.deepEqual(range.translation.labels, { field: 'Ceiling height (m)' });
reject(project => { project.title = ''; }, 'Project title must be nonempty text of at most 120 characters.');
reject((_p, floor) => { floor.name = 'bad\u0001'; }, 'Floor name: control characters and invalid Unicode are not allowed.');
const coordinates = reject((_p, floor) => { floor.rooms[0].polygon[0][0] = 101; }, 'Room x must be a number from -100 to 100.');
assert.deepEqual(coordinates.translation.params, { field: 'Room x', min: -100, max: 100 });
assert.deepEqual(coordinates.translation.labels, {});
reject((_p, floor) => { floor.rooms[0].polygon = [[0, 0], [4, 4], [0, 4], [3, 0]]; }, 'Room: polygon edges cannot cross or touch each other.');
reject((_p, floor) => { floor.rooms[0].polygon = [[0, 0], [4, 0], [2, 0], [2, 4], [0, 4]]; }, 'Room: adjacent polygon edges cannot overlap or reverse direction.');
const overlap = reject((_p, floor) => { floor.rooms.push({ ...clone(floor.rooms[0]), id: 'other', name: '<b>Custom</b>' }); }, 'Room and <b>Custom</b> overlap. Rooms may share an edge, but their interiors must be separate.');
assert.deepEqual(overlap.translation.params, { first: 'Room', second: '<b>Custom</b>' });
reject((_p, floor) => { floor.walls = [{ ...clone(wall), end: [.01, 0] }]; }, 'Walls must be at least 0.05 m long.');
reject((_p, floor) => { floor.walls = [clone(wall), { ...clone(wall), id: 'other' }]; }, 'Walls wall and other overlap. Reuse exact shared walls, or split partial overlaps.');
reject((_p, floor) => { floor.walls = [clone(wall)]; floor.openings = [{ ...clone(opening), offset_m: 1, width_m: 3.5 }]; }, 'Opening extends past the wall. Reduce its width or offset.');
reject((_p, floor) => { floor.walls = [clone(wall)]; floor.openings = [{ ...clone(opening), sill_m: 1, head_m: 1 }]; }, 'Opening head must be at least 0.05 m above its sill.');
reject((_p, floor) => { floor.walls = [clone(wall)]; floor.openings = [clone(opening), { ...clone(opening), id: 'other' }]; }, 'Openings on the same wall cannot overlap.');
reject((_p, floor) => { floor.items = [{ ...clone(item), position_m: { x: 2, y: 2, z: 2 } }]; }, 'Room: top of item is above the ceiling. Lower the item or reduce its height.');
reject((_p, floor) => { floor.items = [{ ...clone(item), entity_id: 'Invalid.Entity' }]; }, 'Entity ID must look like light.living_room (lowercase domain.object_id).');
assert.throws(() => validateFurnitureAppearance({ ...item, model_id: 'sofa_2', color: 'invalid' }), error => error instanceof ValidationError && error.message === 'Furniture color must use #RRGGBB.' && error.translation.key === error.message);
assert.throws(() => outlineRoom({ ...clone(base.floors[0]), walls: [{ ...clone(wall), start: [1, 0], end: [3, 0] }] }, base.floors[0].rooms[0]), error => error instanceof ValidationError && error.translation.key === error.message);
assert.throws(() => validateProject({}), error => !(error instanceof ValidationError) && /missing fields/.test(error.message));

const calls = [];
const translate = (key, params = {}) => {
  calls.push(key);
  const translated = {
    'Ceiling height (m)': 'Hauteur du plafond (m)',
    '{field} must be a number from {min} to {max}.': '{field} doit être compris entre {min} et {max}.',
    '{first} and {second} overlap. Rooms may share an edge, but their interiors must be separate.': '{first} et {second} se chevauchent.',
    Room: 'MUST NOT TRANSLATE USER NAME',
    'Room x': 'MUST NOT TRANSLATE USER COORDINATE LABEL',
  }[key] || key;
  return translated.replace(/\{(\w+)\}/g, (_, name) => String(params[name]));
};
assert.equal(formatValidationError(range, translate), 'Hauteur du plafond (m) doit être compris entre 0.5 et 20.');
assert.equal(formatValidationError(coordinates, translate), 'Room x doit être compris entre -100 et 100.');
assert.equal(formatValidationError(overlap, translate), 'Room et <b>Custom</b> se chevauchent.');
assert(!calls.includes('Room') && !calls.includes('Room x'));
assert.equal(formatValidationError(new Error('Raw technical error'), translate), 'Raw technical error');
assert.equal(formatValidationError('Raw technical error', translate), 'Raw technical error');
for (const error of errors) {
  for (const key of Object.values(error.translation.labels)) assert(Object.hasOwn(english, key));
  const names = [...english[error.translation.key].matchAll(/\{(\w+)\}/g)].map(match => match[1]);
  assert(names.every(name => Object.hasOwn(error.translation.params, name) || Object.hasOwn(error.translation.labels, name)));
}
console.log('Validation i18n metadata passed: unchanged English errors, ranges, names, polygon/wall/opening/item bounds, appearance and literal user data.');
