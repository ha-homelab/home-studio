const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'viewer.js'), 'utf8');

(async () => {
  const THREE = await import('data:text/javascript;base64,' + fs.readFileSync(path.join(root, 'vendor/three.module.min.js')).toString('base64'));
  const context = vm.createContext({THREE});
  vm.runInContext(source.slice(source.indexOf('function wallPrism('), source.indexOf('let wallOutlines,')), context);
  const {wallPrism, wallCenterlineAxes, roundedWallData, wallDisplayGeometry, wallBoundarySegments, beginWallShadow, endWallShadow, updateRoundedWallGeometry} = context;
  const roundedWalls = vm.runInContext('roundedWalls', context);
  const near = (a, b, message) => assert.ok(Math.abs(a-b) < 2e-6, message || `${a} != ${b}`);
  const dot = (a, b) => a.reduce((sum, v, i) => sum + v*b[i], 0);
  const minus = (a, b) => a.map((v, i) => v-b[i]);
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const pointKey = p => p.map(v => Math.round(v*1e6)).join(',');
  function box({angle=0, bottom=0, top=2.8, length=4, depth=.2, x=7, z=-3}={}) {
    const c=Math.cos(angle), s=Math.sin(angle);
    const vertices=[];
    for (const y of [bottom, top]) for (const [u, v] of [[0,-depth/2], [length,-depth/2], [length,depth/2], [0,depth/2]]) vertices.push([x+c*u-s*v,y,z+s*u+c*v]);
    return {kind:'walls',vertices,normals:vertices.map(() => [0,1,0]),indices:[0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7]};
  }
  function verifyClosed(data, original) {
    const edges = new Map();
    for(let i=0;i<data.indices.length;i+=3) {
      const ids=data.indices.slice(i,i+3), points=ids.map(j=>data.vertices[j]);
      const normal=cross(minus(points[1],points[0]),minus(points[2],points[0]));
      assert.ok(Math.hypot(...normal)>1e-10, 'No collapsed display triangles');
      assert.ok(dot(normal,data.normals[ids[0]])>0, 'Triangle winding matches outward normal');
      // A convex display volume must contain every original box corner.
      for(const p of original) assert.ok(dot(normal,minus(p,points[0]))<2e-6, 'Original wall remains contained, including joins');
      for(let j=0;j<3;j++) {
        const key=[pointKey(points[j]),pointKey(points[(j+1)%3])].sort().join('|');
        edges.set(key,(edges.get(key)||0)+1);
      }
    }
    assert.ok([...edges.values()].every(n=>n===2), 'All display edges form a closed manifold');
    data.normals.forEach(n=>near(Math.hypot(...n),1,'Unit shading normals'));
  }
  const perimeter = segments => segments.reduce((sum,[a,b])=>sum+Math.hypot(...minus(a,b)),0);
  for(const angle of [0,Math.PI/2,Math.PI/4,-.731]) for(const limit of [.07,.9,1.15,2.1,20]) {
    const mesh=box({angle}), saved=JSON.stringify(mesh), shape=wallPrism(mesh), data=roundedWallData(shape,limit);
    assert.ok(shape,'Rotated box is recognized');
    assert.equal(data.indices.length/3,64,'Fixed display triangle budget');
    const visibleTop=Math.min(limit,shape.top);
    verifyClosed(data,mesh.vertices.map(p=>[p[0],Math.min(p[1],visibleTop),p[2]]));
    const profileDepths=data.vertices.map(p=>-(p[0]-shape.center[0])*shape.axis[1]+(p[2]-shape.center[2])*shape.axis[0]);
    near(Math.max(...profileDepths),shape.depth/2+Math.min(.075,shape.depth*.32));
    assert.ok(data.normals.some(n=>Math.abs(n[1])>.05&&Math.abs(n[1])<.95),'Curved shoulders have real intermediate normals');
    for(const atBase of [false,true]) {
      const actual=wallBoundarySegments([{...data,kind:'walls'}],limit,atBase), expected=wallBoundarySegments([mesh],limit,atBase);
      near(perimeter(actual),perimeter(expected),'Cyan/blue outline follows exact cap perimeter');
    }
    assert.equal(JSON.stringify(mesh),saved,'Source/export geometry is immutable');
  }
  const low=box({top:.6}), raised=box({bottom:2.1});
  near(Math.max(...roundedWallData(wallPrism(low),1.15).vertices.map(p=>p[1])),.6,'Low wall keeps its own top');
  assert.equal(roundedWallData(wallPrism(raised),2.1).indices.length,0,'Hidden lintel has no display cap in doorway');
  assert.equal(roundedWallData(wallPrism(raised),1.15).indices.length,0);
  const original=box();
  for(const mutate of [m=>m.kind='floors', m=>m.vertices[0][0]+=.1, m=>m.indices.pop(), m=>m.indices[0]=99, m=>m.indices.splice(3,3,...m.indices.slice(0,3)), m=>m.vertices[0][1]=NaN]) {
    const invalid=structuredClone(original);mutate(invalid);assert.equal(wallPrism(invalid),null,'Invalid and non-wall shapes remain unchanged');
  }
  const short=box({angle:.47,length:.035,depth:.2});
  near(wallPrism(short,[Math.cos(.47),Math.sin(.47)]).length,.035,'Shared wall centerline preserves a narrow pier direction');

  // Use the actual compiler output, including face-expanded rotated geometry,
  // sills and lintels; furniture and downloadable models are not changed.
  const compiled=spawnSync('python3',['-c',`
import json
from pathlib import Path
from planner.project import load_project, make_floor
result=[]
for name in ['planner/example-home.json','planner/guide-assets/practice-home.json','planner/guide-assets/garage-and-studio.json','planner/guide-assets/decor-studio.json']:
    project=load_project(Path(name))
    for floor in project['floors']:
        data,_=make_floor(project,floor,None)
        result.append({'name':name+':'+floor['id'],'meshes':[m for m in data['meshes'] if m['kind']=='walls'],'openings':data['openings']})
# Regression: neither remaining pier's longest footprint side is the centerline.
project=load_project(Path('planner/example-home.json'))
floor=project['floors'][0]
floor['openings']=[{'id':'wide_passage','wall_id':'wall_shared','type':'passage','offset_m':.02,'width_m':4.96,'sill_m':0,'head_m':floor['height_m']}]
data,_=make_floor(project,floor,None)
result.append({'name':'full-height-passage','meshes':[m for m in data['meshes'] if m['kind']=='walls'],'openings':data['openings']})
print(json.dumps(result))
`],{cwd:root,encoding:'utf8',maxBuffer:10*1024*1024});
  assert.equal(compiled.status,0,compiled.stderr);
  const reports=[];
  for(const model of JSON.parse(compiled.stdout)) {
    const axes=wallCenterlineAxes(model.meshes,model.openings);
    for(const mesh of model.meshes) assert.ok(wallPrism(mesh),`Actual compiler prism ${mesh.name} is recognized`);
    if(model.name==='full-height-passage') {
      near(Math.abs(axes.get('wall_shared')[0]),0,'Opening endpoints override narrow-pier footprint inference');
      near(Math.abs(axes.get('wall_shared')[1]),1);
    }
    let visible=0;
    const scene=new THREE.Group();
    for(const mesh of model.meshes) {
      const shape=wallPrism(mesh,axes.get(mesh.wall_id)), data=roundedWallData(shape,2.1);
      if(model.name==='full-height-passage'&&mesh.wall_id==='wall_shared') {
        const originalZ=mesh.vertices.map(p=>p[2]),displayZ=data.vertices.map(p=>p[2]);
        near(Math.min(...originalZ),Math.min(...displayZ),'Narrow pier cannot expand along opening width');
        near(Math.max(...originalZ),Math.max(...displayZ));
      }
      const geometry=wallDisplayGeometry(mesh,shape,2.1), material=new THREE.MeshBasicMaterial({side:THREE.DoubleSide});
      scene.add(new THREE.Mesh(geometry,material));
      visible+=data.indices.length/3;
      const shadowIndices=Array.from(geometry.index.array.slice(0,36));
      assert.deepEqual(shadowIndices,mesh.indices,'Shadow triangle indices remain identical');
      mesh.vertices.forEach((p,i)=>p.forEach((v,j)=>near(geometry.attributes.position.array[i*3+j],v,'Full-height source shadow position remains identical')));
      beginWallShadow(null,null,null,null,geometry);
      assert.equal(geometry.drawRange.start,0);assert.equal(geometry.drawRange.count,36);
      endWallShadow(null,null,null,null,geometry);
      assert.equal(geometry.drawRange.start,36);assert.equal(geometry.drawRange.count,data.indices.length);
    }
    scene.updateMatrixWorld(true);
    for(const opening of model.openings) {
      const [ax,az]=opening.start_m,[bx,bz]=opening.end_m,length=Math.hypot(bx-ax,bz-az),nx=-(bz-az)/length,nz=(bx-ax)/length;
      // Across center and near both jambs: thickened walls cannot fill an opening.
      for(const t of [.02,.5,.98]) {
        const y=(opening.sill_m+Math.min(opening.head_m,2.1))/2;
        const ray=new THREE.Raycaster(new THREE.Vector3(ax+(bx-ax)*t+nx,y,az+(bz-az)*t+nz),new THREE.Vector3(-nx,0,-nz),0,1.6);
        assert.equal(ray.intersectObject(scene,true).length,0,`Open ${opening.type} remains clear beside both jambs`);
      }
    }
    reports.push(`${model.name}: ${model.meshes.length} walls, ${model.meshes.length*12} source/shadow triangles, ${model.meshes.length*64} full-height / ${visible} Home display triangles`);
    scene.children.forEach(mesh=>{mesh.geometry.dispose();mesh.material.dispose()});
  }
  const shape=wallPrism(original), mesh={geometry:wallDisplayGeometry(original,shape,20)},cache=new Map([[shape.top,mesh.geometry]]);
  roundedWalls.push({mesh,source:original,shape,cache});
  updateRoundedWallGeometry(1.15);const cutaway=mesh.geometry;
  updateRoundedWallGeometry(1.15);assert.equal(mesh.geometry,cutaway,'Unchanged height reuses buffers');
  updateRoundedWallGeometry(2.1);updateRoundedWallGeometry(20);updateRoundedWallGeometry(1.15);
  assert.equal(mesh.geometry,cutaway,'Three normal modes reuse their exact buffers');
  let disposed=false;cache.values().next().value.addEventListener('dispose',()=>disposed=true);
  updateRoundedWallGeometry(.8);assert.equal(cache.size,3,'Future clipping heights retain bounded cache');assert.equal(disposed,true,'Evicted GPU buffers are disposed');
  cache.forEach(geometry=>geometry.dispose());
  console.log('PASS: rounded closed geometry, source containment, rotations, exact cap outlines, low walls, invalid-shape fallback, real openings, original shadows and bounded reusable buffers.');
  reports.forEach(report=>console.log(report));
})().catch(error=>{console.error(error);process.exitCode=1});
