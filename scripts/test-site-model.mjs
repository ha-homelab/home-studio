#!/usr/bin/env node
// Exercise the portable schema in both languages and the real Three.js layer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateSite, createSite, siteBounds, nextSiteId, SITE_KINDS, SITE_LIMITS } from '../planner/site-model.js';
import { blankProject, validateProject } from '../planner/model.js';
import { buildSitePreview } from '../planner/site-editor.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const clone = value => structuredClone(value);
const feature = (kind = 'home', index = 1) => ({ id: `${kind}_${index}`, name: `Site ${kind}`, kind, polygon: [[0, 0], [4, 0], [4, 3], [0, 3]], height_m: ['street', 'landscape'].includes(kind) ? 0 : 6, color: '#8A9bAF' });
const base = { ground_elevation_m: 10, features: SITE_KINDS.map(kind => feature(kind)) };
const regular = count => Array.from({ length: count }, (_, i) => [Math.cos(i * Math.PI * 2 / count) * 10, Math.sin(i * Math.PI * 2 / count) * 10]);
const accepted = [createSite(), clone(base), { ...clone(base), ground_elevation_m: -100 }, { ...clone(base), ground_elevation_m: 100 }];
function validPatch(patch) { const site = { ground_elevation_m: 0, features: [feature()] }; patch(site); accepted.push(site); }
validPatch(site => site.features[0].polygon.reverse());
validPatch(site => site.features[0].polygon = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]]);
validPatch(site => site.features[0].polygon = [[0, 0], [2, 0], [4, 0], [4, 4], [0, 4]]);
validPatch(site => site.features[0].polygon = [[-1000, -1000], [1000, -1000], [1000, 1000], [-1000, 1000]]);
validPatch(site => site.features[0].name = '🏡'.repeat(120));
validPatch(site => site.features[0].name = '\u0085');
validPatch(site => site.features[0].height_m = 0);
validPatch(site => site.features[0].height_m = 100);
for (const render_style of ['outline', 'solid']) validPatch(site => site.features = [{ ...feature('building'), render_style }]);
validPatch(site => site.features = Array.from({ length: 64 }, (_, i) => feature('building', i)));
validPatch(site => site.features = Array.from({ length: 16 }, (_, i) => ({ ...feature('building', i), polygon: regular(64) })));
const rejected = [null, [], {}, { ...createSite(), latitude: 0 }, { ground_elevation_m: 0 }, { features: [] }];
function invalidPatch(patch) { const site = clone(base); patch(site); rejected.push(site); }
for (const ground of [null, true, '0', -100.01, 100.01, Infinity, NaN]) invalidPatch(site => site.ground_elevation_m = ground);
for (const value of [null, {}, 'features']) invalidPatch(site => site.features = value);
invalidPatch(site => site.features = Array.from({ length: 65 }, (_, i) => feature('home', i)));
invalidPatch(site => site.features = Array.from({ length: 17 }, (_, i) => ({ ...feature('home', i), polygon: regular(64) })));
invalidPatch(site => site.features.push(clone(site.features[0])));
for (const key of Object.keys(feature())) invalidPatch(site => delete site.features[0][key]);
invalidPatch(site => site.features[0].latitude = 10);
for (const render_style of ['', 'wireframe', null, true, 1, {}, []]) invalidPatch(site => site.features[2].render_style = render_style);
for (const index of [0, 1, 3, 4]) invalidPatch(site => site.features[index].render_style = 'outline');
for (const id of ['', '1home', '__proto__', 'constructor', 'a'.repeat(65), 'home-neighbor', true, null]) invalidPatch(site => site.features[0].id = id);
for (const name of ['', '  ', '\ufeff', 'a'.repeat(121), '🏡'.repeat(121), '\u0000', '\ud800', null, 1]) invalidPatch(site => site.features[0].name = name);
for (const kind of ['garage', '', null, [], {}]) invalidPatch(site => site.features[0].kind = kind);
for (const color of ['red', '#fff', '#11223344', '112233', '#GGGGGG', null, []]) invalidPatch(site => site.features[0].color = color);
for (const height of [-.01, 100.01, null, true, '1', Infinity, NaN]) invalidPatch(site => site.features[0].height_m = height);
for (const kind of ['street', 'landscape']) invalidPatch(site => site.features[0].kind = kind);
for (const polygon of [null, [], [[0, 0], [1, 1]], regular(65), [[0, 0], [1, 1], [2, 2]], [[0, 0], [4, 4], [0, 4], [4, 0], [5, 2]], [[0, 0], [3, 0], [1, 0], [1, 3], [0, 3]], [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]], [[0, 0], [4, 0], [4, 4], [2, 0], [0, 4]], [[0, 0], [.005, 0], [0, 3]], [[0, 0], [.1, 0], [0, .1]]]) invalidPatch(site => site.features[0].polygon = polygon);
for (const point of [[1000.01, 0], [-1000.01, 0], [0, Infinity], [0, true], [0, '1'], [1], [1, 2, 3], null]) invalidPatch(site => site.features[0].polygon[0] = point);
const original = JSON.stringify(base);
for (const site of accepted) { assert.equal(validateSite(site), site); const project = blankProject(); project.site = site; validateProject(project); }
for (const site of rejected) { assert.throws(() => validateSite(site)); const project = blankProject(); project.site = site; assert.throws(() => validateProject(project)); }
assert.equal(JSON.stringify(base), original, 'Validation does not mutate authored data');
assert.equal(siteBounds(createSite()), null);
assert.deepEqual(siteBounds(base), { minX: 0, maxX: 4, minZ: 0, maxZ: 3 });
assert.equal(nextSiteId(base, 'home'), 'home_2');
assert.equal(nextSiteId({ features: [feature('home', 2)] }, 'home'), 'home_1');
assert.throws(() => nextSiteId(base, 'unsupported'));
const first = createSite(); first.features.push(feature()); assert.deepEqual(createSite().features, []);
assert.equal(SITE_LIMITS.totalPoints, 1024);
const legacy = blankProject(), before = JSON.stringify(legacy); validateProject(legacy); assert.equal(JSON.stringify(legacy), before);
const python = spawnSync(process.env.PYTHON || 'python3', ['-c', `import json,sys
from planner.site_model import validate_site
from planner.project import validate_project
values=json.load(sys.stdin)
results=[]
for value in values:
    try:
        validate_site(value)
        validate_project(dict(schema_version=1,title='Parity',floors=[dict(id='main',name='Main',elevation_m=0,height_m=2.7,rooms=[],walls=[],openings=[],items=[])],site=value),complete=False)
        results.append(True)
    except ValueError: results.append(False)
print(json.dumps(results))`], { cwd: root, input: JSON.stringify([...accepted, ...rejected]), encoding: 'utf8' });
assert.equal(python.status, 0, python.stderr);
assert.deepEqual(JSON.parse(python.stdout), [...accepted.map(() => true), ...rejected.map(() => false)], 'Python and JS accept the same fixtures');
const THREE = await import('data:text/javascript;base64,' + fs.readFileSync(new URL('../vendor/three.module.min.js', import.meta.url)).toString('base64'));
const previewSite = { ground_elevation_m: -2, features: [feature('home'), feature('roof'), feature('building'),
  { ...feature('building', 2), render_style: 'outline' }, { ...feature('building', 3), render_style: 'outline', height_m: 0 }] };
const preview = buildSitePreview(THREE, previewSite, options => new THREE.MeshStandardMaterial(options));
assert.equal(preview.getObjectByName('building_1').isMesh, true, 'Legacy neighbors remain solid');
const contour = preview.getObjectByName('building_2'), flatContour = preview.getObjectByName('building_3');
assert.equal(contour.isLineSegments, true); assert.equal(flatContour.isLineSegments, true);
assert.equal(contour.geometry.attributes.position.count, 24, 'Four bottom, four top and four vertical edges');
assert.equal(flatContour.geometry.attributes.position.count, 8, 'Zero-height contours do not duplicate edges');
assert.equal(contour.material, flatContour.material, 'Preview contours share one material');
assert.equal(contour.material.depthTest, true); assert.equal(contour.material.depthWrite, false);
assert.equal(contour.material.opacity, .65);
assert.deepEqual([...new Set(Array.from(contour.geometry.attributes.position.array).filter((_, i) => i % 3 === 1))].sort((a, b) => a - b), [-2, 4]);
const neighborhoodPreview = buildSitePreview(THREE, previewSite, options => new THREE.MeshStandardMaterial(options), { showHome: false });
assert.equal(neighborhoodPreview.getObjectByName('home_1'), undefined);
assert.equal(neighborhoodPreview.getObjectByName('roof_1'), undefined);
assert.equal(neighborhoodPreview.children.length, 3, 'Neighborhood preview leaves detailed indoor geometry unobscured');
for (const group of [preview, neighborhoodPreview]) {
  const materials = new Set(); group.traverse(object => { object.geometry?.dispose(); if (object.material) materials.add(object.material); });
  for (const material of materials) material.dispose();
}
const context = vm.createContext({ THREE, Promise, Map, Set, Math, Number, Error });
vm.runInContext(fs.readFileSync(new URL('../map-layer.js', import.meta.url), 'utf8') + '\nthis.math = homeMapMath;', context);
const model = { elevation_m: 16, site_context: { ground_elevation_m: -6, features: base.features, roof_outline: { elevation_m: 2, polygons_m: [feature().polygon] } } };
const resolved = context.math.context(model, [feature().polygon]);
assert.equal(resolved.groundElevation, -6);
assert.equal(resolved.polygons.length, 0, 'Authored home/roof suppresses legacy roof duplication');
assert.equal(resolved.features.length, 5);
for (const site of accepted) assert.equal(context.math.features(site.features).length, site.features.length);
for (const site of rejected.filter(site => site?.features && Array.isArray(site.features) && site.ground_elevation_m === 10)) assert.equal(context.math.features(site.features).length, 0, 'Invalid optional runtime features are omitted');
const neighbor = context.math.context({ site_context: { ground_elevation_m: 0, features: [feature('building')] } }, [feature().polygon]);
assert.equal(neighbor.polygons.length, 1, 'A neighboring building does not suppress the home fallback outline');
const scene = new THREE.Scene(), layer = context.createHomeMapLayer(THREE, scene, { ...resolved, requestTile: async () => { throw Error('Offline scene test'); } });
const siteGroup = layer.object.getObjectByName('home-site-features'), groundGroup = layer.object.getObjectByName('home-site-ground');
const siteObjects = [...siteGroup.children, ...groundGroup.children];
assert.equal(layer.stats.siteFeatures, 5); assert.equal(layer.stats.siteObjects, 7);
assert.equal(new Set(siteObjects.map(object => object.material)).size, 2, 'Ground and building objects share the same two materials');
const ys = object => Array.from(object.geometry.attributes.position.array).filter((_, i) => i % 3 === 1);
assert.equal(Math.min(...ys(siteGroup.getObjectByName('home_1'))), -6);
assert.equal(Math.max(...ys(siteGroup.getObjectByName('home_1'))), 0);
assert.equal(Math.max(...ys(siteGroup.getObjectByName('roof_1-outline'))), 0, 'Roof is ground plus height, relative to this floor');
assert.equal(Math.min(...ys(groundGroup.getObjectByName('street_1'))), Math.fround(-5.985));
assert.equal(Math.min(...ys(groundGroup.getObjectByName('landscape_1'))), Math.fround(-5.995));
assert.equal(groundGroup.children.length, 2, 'Only authored street and landscape surfaces use the ground group');
assert.equal(siteGroup.visible, false);
layer.setConfig({ enabled: true, latitude: 0, longitude: 0, model_x: 0, model_z: 0, north_deg: 0 });
const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, .1, 100); camera.position.set(0, 20, 0); camera.up.set(0, 0, -1); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
// The real camera is used; synthetic request failures stay inside this scene test.
layer.render(camera, { width: 500, height: 500 }, { coarse: false, editing: false, transition: false }); assert.equal(siteGroup.visible, false);
assert.equal(groundGroup.visible, true, 'Authored ground surfaces remain visible at detailed scale');
layer.render(camera, { width: 500, height: 500 }, { transition: true }); assert.equal(siteGroup.visible, true);
layer.render(camera, { width: 500, height: 500 }, { coarse: true }); assert.equal(siteGroup.visible, true);
layer.render(camera, { width: 500, height: 500 }, { editing: true }); assert.equal(siteGroup.visible, false, 'An editing flag alone cannot cover home controls with opaque context');
const geometryDisposals = new Map(siteObjects.map(object => [object.geometry, 0]));
const materialDisposals = new Map(siteObjects.map(object => [object.material, 0]));
assert.equal(geometryDisposals.size, 7); assert.equal(materialDisposals.size, 2);
for (const resourceCounts of [geometryDisposals, materialDisposals]) for (const resource of resourceCounts.keys()) {
  resource.addEventListener('dispose', () => resourceCounts.set(resource, resourceCounts.get(resource) + 1));
}
layer.dispose();
assert([...geometryDisposals.values()].every(count => count === 1), 'Every building and ground geometry is disposed exactly once');
assert([...materialDisposals.values()].every(count => count === 1), 'Materials shared across ground/building groups are disposed exactly once');
assert.equal(scene.children.length, 0);
const maximum = context.createHomeMapLayer(THREE, scene, { groundElevation: 0, features: accepted.find(site => site.features.length === 64).features });
assert.equal(maximum.stats.siteObjects, 128); maximum.dispose();
await new Promise(resolve => setImmediate(resolve));
console.log(`PASS: ${accepted.length + rejected.length} matching JS/Python site fixtures, portable roundtrip, floor-local scene heights, shared materials, visibility, bounds, and disposal.`);
