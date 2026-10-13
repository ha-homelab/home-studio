const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../viewer.js'),'utf8');
const context=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function wallBoundarySegments('),source.indexOf('let wallOutlines,')),context);
const slice=context.wallBoundarySegments;
function box(bottom=0,top=2.7,angle=0){
  const c=Math.cos(angle),s=Math.sin(angle);
  const vertices=[[0,bottom,0],[2,bottom,0],[2,bottom,3],[0,bottom,3],
    [0,top,0],[2,top,0],[2,top,3],[0,top,3]].map(([x,y,z])=>[x*c-z*s,y,x*s+z*c]);
  return {kind:'walls',vertices,indices:[0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7]};
}
function perimeter(segments){return segments.reduce((sum,[a,b])=>sum+Math.hypot(...a.map((v,i)=>v-b[i])),0)}
for(const angle of [0,Math.PI/4])for(const height of [.82,1.15,2.7,20]){
  const wall=box(0,2.7,angle),original=JSON.stringify(wall),segments=slice([wall],height);
  assert.ok(Math.abs(perimeter(segments)-10)<1e-5,'Only the rectangular boundary is drawn, without face diagonals');
  assert.ok(segments.flat().every(p=>Math.abs(p[1]-Math.min(height,2.7))<1e-6));
  assert.equal(JSON.stringify(wall),original,'Rendering does not modify export geometry');
}
assert.equal(slice([box(2.1)],.82).length,0,'A doorway lintel must not create an outline across the opening');
assert.equal(slice([box(.82)],.82).length,0,'A wall beginning at the clipping plane has no visible slice');
assert.equal(slice([{...box(),kind:'floors'}],.82).length,0,'Floor meshes are not wall outlines');
assert.ok(slice([box(0,.6)],.82).flat().every(p=>p[1]===.6),'Low walls keep their own top elevation');
assert.equal(slice([box(),box()],.82).length,slice([box()],.82).length,'Coincident boundaries do not accumulate brightness');
console.log('PASS: full/cutaway/rotated wall boundaries, lintel gaps, low walls, deduplication and unchanged geometry.');

for(const angle of [0,Math.PI/4])for(const bottom of [0,.2])for(const height of [.82,1.15,20]){
  const segments=slice([box(bottom,2.7,angle)],height,true);
  assert.ok(Math.abs(perimeter(segments)-10)<1e-5,'Base outline has no face diagonals');
  assert.ok(segments.flat().every(p=>p[1]===bottom),'Blue boundary follows the wall base');
}
assert.equal(slice([box(2.1)],.82,true).length,0,'Hidden lintels have no base contour');
console.log('PASS: blue base boundaries at floor and raised elevations, including rotated walls.');
