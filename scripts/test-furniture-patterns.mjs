#!/usr/bin/env node
import assert from 'node:assert/strict';
import { CATALOG, PATTERNS, buildFurnitureAsset, getCatalogModel, primitive, supportsFurniturePattern, validateFurnitureAppearance } from '../planner/furniture.js';

const model = getCatalogModel('rug');
const item = { type: model.type, model_id: model.id };
const box = { shape: 'box', center: [.03,.5,-.02], size: [.4,.35,.3], material: 'body' };
const originalParts = model.parts;
function withParts(parts, operation) {
  model.parts = parts;
  try { return operation(); } finally { model.parts = originalParts; }
}
function unrotate(point, rotation = [0,0,0]) {
  let [x,y,z] = point;
  for (const axis of [2,1,0]) {
    const angle = -rotation[axis]*Math.PI/180, c = Math.cos(angle), s = Math.sin(angle);
    if (axis === 0) [y,z] = [c*y-s*z,s*y+c*z];
    if (axis === 1) [x,z] = [c*x+s*z,-s*x+c*z];
    if (axis === 2) [x,y] = [c*x-s*y,s*x+c*y];
  }
  return [x,y,z];
}
function bounds(meshes) {
  return [0,1,2].map(axis => {
    const values = meshes.flatMap(mesh => mesh.vertices.map(point => point[axis]));
    return [Math.min(...values), Math.max(...values)];
  });
}
function close(actual, expected, context) { assert.ok(Math.abs(actual-expected) < 1e-10, `${context}: ${actual} != ${expected}`); }
function cross(a,b,c) {
  const u = b.map((value,axis) => value-a[axis]), v = c.map((value,axis) => value-a[axis]);
  return [u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
}
function verifySurface(part, asset) {
  const [base, accent] = asset.meshes;
  assert.equal(base.name, 'part_0'); assert.equal(accent.name, 'pattern');
  const expectedBounds = bounds([primitive(part)]), actualBounds = bounds(asset.meshes);
  actualBounds.forEach((values,axis) => values.forEach((value,side) => close(value,expectedBounds[axis][side],'exact rotated bounds')));
  const local = point => unrotate(point.map((value,axis) => value-part.center[axis]),part.rotation_deg);
  const axis = part.pattern_face === 'top' ? 1 : 2;
  let area = 0, accentArea = 0;
  const faceTriangles = [];
  for (const mesh of asset.meshes) {
    assert.equal(mesh.indices.length,mesh.vertices.length);
    assert.equal(mesh.normals.length,mesh.vertices.length);
    for (let index = 0; index < mesh.indices.length; index += 3) {
      const triangle = mesh.vertices.slice(index,index+3), normal = cross(...triangle), length = Math.hypot(...normal);
      assert.ok(length > 1e-14,'nondegenerate triangles');
      area += length/2;
      if (mesh === accent) accentArea += length/2;
      triangle.forEach((point,corner) => {
        const n = mesh.normals[index+corner], p = local(point), direction = unrotate(n,part.rotation_deg);
        assert.equal(mesh.indices[index+corner],index+corner);
        assert.ok(point.every(Number.isFinite));
        close(Math.hypot(...n),1,'unit normals');
        n.forEach((value,axis) => close(value,normal[axis]/length,'winding matches normal'));
        assert.ok(p.reduce((sum,value,axis) => sum+value*direction[axis],0) > 0,'outward normal');
        p.forEach((value,axis) => assert.ok(Math.abs(value) <= part.size[axis]/2+1e-12,'inside original box'));
        if (mesh === accent) {
          close(p[axis],part.size[axis]/2,'pattern on original face');
          close(direction[axis],1,'pattern facing outward');
        }
      });
      const points = triangle.map(local);
      if (points.every(point => Math.abs(point[axis]-part.size[axis]/2) < 1e-10)) {
        faceTriangles.push(points.map(point => [point[0]/part.size[0]+.5,part.pattern_face === 'top' ? .5-point[2]/part.size[2] : point[1]/part.size[1]+.5]));
      }
    }
  }
  const [w,h,d] = part.size;
  close(area,2*(w*h+w*d+h*d),'closed box surface area');
  assert.ok(accentArea > 0 && accentArea < w*part.size[part.pattern_face === 'top' ? 2 : 1],'both colors visible');
  assert.ok(asset.meshes.reduce((sum,mesh) => sum+mesh.indices.length/3,0) <= 138,'bounded pattern geometry');
  // Off-grid probes detect holes and coplanar overlaps across the replaced face.
  for (let y = 0; y < 17; y++) for (let x = 0; x < 19; x++) {
    const probe = [(x+.321)/19,(y+.427)/17];
    let count = 0;
    for (const triangle of faceTriangles) {
      const distances = triangle.map((a,i) => {
        const b = triangle[(i+1)%3];
        return (b[0]-a[0])*(probe[1]-a[1])-(b[1]-a[1])*(probe[0]-a[0]);
      });
      if (distances.every(distance => distance > 1e-12)) count++;
    }
    assert.equal(count,1,'every probe is covered once, without z-fighting');
  }
}

const fixtures = [];
for (const pattern of PATTERNS.slice(1)) for (const face of ['top','front']) {
  for (const [index,rotation] of [null,[90,0,0],[0,0,90],[23,-41,67]].entries()) {
    const part = { ...box, pattern_face: face, ...(rotation ? { rotation_deg: rotation } : {}) };
    const choice = { ...item, pattern_id: pattern.id, style_id: index%2 ? 'warm_wood' : 'ocean_blue',
      ...(index%2 ? { color: '#A1B2C3', pattern_color: '#D4E5F6' } : {}) };
    fixtures.push(withParts([part],() => ({ part, item: choice, asset: buildFurnitureAsset(choice) })));
  }
}
if (process.argv.includes('--fixtures')) {
  process.stdout.write(JSON.stringify({ patterns: PATTERNS, fixtures }));
} else {
  assert.deepEqual(PATTERNS.map(pattern => pattern.id),['none','stripes','checks','diamonds','dots','herringbone','chevrons']);
  assert.equal(supportsFurniturePattern(null),false);
  for (const fixture of fixtures) verifySurface(fixture.part,fixture.asset);
  for (const catalogModel of CATALOG.models) {
    const choice = { type: catalogModel.type, model_id: catalogModel.id };
    const original = JSON.stringify(catalogModel), plain = buildFurnitureAsset(choice);
    assert.deepEqual(buildFurnitureAsset({ ...choice,pattern_id: 'none' }),plain,'explicit none preserves original geometry');
    for (const [index,part] of catalogModel.parts.entries()) {
      const stripped = { ...part }; delete stripped.pattern_face;
      for (const key of ['vertices','normals','indices']) assert.deepEqual(plain.meshes[index][key],primitive(stripped)[key]);
    }
    if (supportsFurniturePattern(catalogModel)) for (const pattern of PATTERNS.slice(1)) {
      const asset = buildFurnitureAsset({ ...choice,pattern_id: pattern.id });
      assert.equal(asset.meshes.length,catalogModel.parts.length+1);
      const expectedBounds = bounds(plain.meshes), actualBounds = bounds(asset.meshes);
      actualBounds.forEach((values,axis) => values.forEach((value,side) => close(value,expectedBounds[axis][side],'catalog bounds')));
    }
    assert.equal(JSON.stringify(catalogModel),original,'catalog is immutable');
  }
  withParts([{ ...box,pattern_face: 'top' }],() => {
    for (const style of CATALOG.styles) {
      const choice = { ...item,style_id: style.id,pattern_id: 'dots',color: '#A1B2C3' };
      const asset = buildFurnitureAsset(choice);
      assert.equal(asset.meshes[0].material,'furniture_a1b2c3');
      assert.equal(asset.meshes[1].material,'furniture_'+style.materials.accent.slice(1).toLowerCase());
      assert.equal(buildFurnitureAsset({ ...choice,pattern_color: '#D4E5F6' }).meshes[1].material,'furniture_d4e5f6');
      const sameColor = buildFurnitureAsset({ ...choice,pattern_color: '#a1b2c3' });
      assert.deepEqual(Object.keys(sameColor.materials),['furniture_a1b2c3'],'matching pattern and body colors remain valid');
      assert.deepEqual(sameColor.meshes.map(mesh => mesh.vertices),asset.meshes.map(mesh => mesh.vertices));
      assert.equal(JSON.stringify(choice),JSON.stringify({ ...item,style_id: style.id,pattern_id: 'dots',color: '#A1B2C3' }));
    }
    for (const patch of [{ pattern_id: 'missing' },{ pattern_id: null },{ pattern_id: [] },{ pattern_id: 1 },
      { pattern_color: '#123456' },{ pattern_id: 'none',pattern_color: '#123456' },
      ...['#fff','#12345678','red','',null,1,{},true].map(pattern_color => ({ pattern_id: 'dots',pattern_color }))]) {
      assert.throws(() => validateFurnitureAppearance({ ...item,...patch }),Error);
    }
    for (const choice of [{ pattern_id: 'dots' },{ pattern_id: 'none' },{ pattern_color: '#123456' }]) {
      assert.throws(() => validateFurnitureAppearance({ type: 'furniture',...choice }),Error);
    }
  });
  withParts([box],() => {
    assert.equal(supportsFurniturePattern(model),false);
    assert.throws(() => buildFurnitureAsset({ ...item,pattern_id: 'dots' }),/does not support/);
  });
  withParts([{ ...box,pattern_face: 'top' },{ ...box,pattern_face: 'front',rotation_deg: [15,25,35] }],() => {
    const asset = buildFurnitureAsset({ ...item,pattern_id: 'dots' });
    assert.equal(asset.meshes.length,3,'one combined pattern mesh for all marked parts');
    assert.equal(asset.meshes[2].vertices.length,216);
  });
  for (const patch of [{ pattern_face: 'left' },{ pattern_face: null },{ pattern_face: [] },{ pattern_face: 'top',shape: 'sphere' },{ pattern_face: 'front',shape: 'cylinder' }]) {
    assert.throws(() => primitive({ ...box,...patch }),/pattern_face/);
  }
  console.log(`Furniture patterns JS: ${fixtures.length} rotated surface fixtures; exact bounds, outward normals, closed coverage, palettes, validation, and legacy compatibility passed.`);
}
