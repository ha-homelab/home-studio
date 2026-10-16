// CPU oracle for packed room geometry. No browser/GPU is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname,'..');
const source = fs.readFileSync(path.join(root,'room-lighting.js'),'utf8');
const context = vm.createContext({});
vm.runInContext(source,context);
const rounded = n => Math.fround(Number(Number(n).toFixed(5)));
const smooth = (a,b,x) => {const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
function distance(p,edges) {
  let nearest=100000000,inside=false;
  for(const [ax,az,bx,bz] of edges) {
    const x=bx-ax,z=bz-az,t=Math.max(0,Math.min(1,((p[0]-ax)*x+(p[1]-az)*z)/(x*x+z*z)));
    nearest=Math.min(nearest,(p[0]-ax-x*t)**2+(p[1]-az-z*t)**2);
    if((az>p[1])!==(bz>p[1]) && p[0]<(bx-ax)*(p[1]-az)/(bz-az)+ax)inside=!inside;
  }
  return (inside?-1:1)*Math.sqrt(nearest);
}
const transmission = d => d<=0?1:Math.exp(-8*d)*(1-smooth(.1,.55,d));
const edgesOf = room => room.polygon.map((a,i)=>[...a,...room.polygon[(i+1)%room.polygon.length]].map(rounded));
function glow(p,edge) {
  const [ax,az,bx,bz]=edge,x=bx-ax,z=bz-az;
  const t=Math.max(0,Math.min(1,((p[0]-ax)*x+(p[1]-az)*z)/(x*x+z*z)));
  return Math.exp(-.55*Math.hypot(p[0]-ax-x*t,p[1]-az-z*t));
}
function packedEdges(data,room) {
  const range=data.uniforms.homeRoomRanges.value,edges=data.uniforms.homeRoomEdges.value,result=[];
  for(let i=range[room*4];i<Math.abs(range[room*4+1]);i++)result.push(Array.from(edges.slice(i*4,i*4+4)));
  return result;
}
// Execute the production box expression, translating only vector syntax. The
// independent reference remains the original quantized polygon-edge walk.
const boxSource=source.match(/const boxDistance = `([\s\S]*?)`;/)?.[1];
assert(boxSource,'The rectangle specialization exposes its production expression');
const boxBody=boxSource.replace(/\bvec[24] (\w+) =/g,'const $1 =')
  .replace('bounds.xy - p','subtract(bounds.slice(0,2), p)')
  .replace('p - bounds.zw','subtract(p, bounds.slice(2,4))')
  .replaceAll('distanceToBox.x','distanceToBox[0]').replaceAll('distanceToBox.y','distanceToBox[1]');
const evaluateBox=new Function('homeRoomBounds','room','p','max','min','length','vec2','subtract',boxBody);
const boxMax=(a,b)=>Array.isArray(a)?a.map((value,index)=>Math.max(value,Array.isArray(b)?b[index]:b)):Math.max(a,b);
function packedDistance(data, room, p) {
  if(data.uniforms.homeRoomRanges.value[room*4+1]>=0)return distance(p,packedEdges(data,room));
  return evaluateBox([Array.from(data.uniforms.homeRoomBounds.value.slice(room*4,room*4+4))],0,p,
    boxMax,Math.min,value=>Math.sqrt(value.reduce((sum,n)=>sum+n*n,0)),value=>[value,value],
    (a,b)=>a.map((value,index)=>value-b[index]));
}
// This bound covers JavaScript double arithmetic on Float32-quantized geometry,
// not GLSL Float32 execution. Rendered comparisons remain necessary for both
// all-rectangle and mixed/concave scenes before accepting the specialization.
let maxNumericDelta=0;
const near = (actual, expected, message) => {
  const delta=Math.abs(actual-expected);
  maxNumericDelta=Math.max(maxNumericDelta,delta);
  assert(delta<1e-12,`${message ? message+': ' : ''}${actual} differs from ${expected}`);
};
const rooms=[
  {id:'A',polygon:[[.123456,0],[4,0],[4,4],[.123456,4]]},
  {id:'B',exterior:true,polygon:[[4,0],[8,0],[8,4],[6,4],[6,2],[4,2]]},
  {id:'C',polygon:[[0,8],[4,8],[4,4],[0,4]]},
];
const windows=[
  {room:'B',a:[5,0],b:[7,0]}, {room:'A',a:[.123456,1],b:[.123456,2]},
  {room:'missing',a:[99,0],b:[100,0]}, {room:'A',a:[1,0],b:[2,0]},
];
const data=context.packRoomLightingGeometry(rooms,windows,9,1024);
assert(data);
assert.equal(data.rectanglesOnly,false);
assert.deepEqual(Array.from(data.uniforms.homeRoomRanges.value).filter((_,i)=>i%4===1),[-4,10,-14]);
const rejectedRectangles=[
  [[0,0],[2,1],[1,3],[-1,2]], // Rotated rectangle.
  [[0,0],[3,0],[2,2],[0,2]], // Trapezoid.
  [[0,0],[2,2],[2,0],[0,2]], // Crossed corners are not a rectangle boundary.
  [[0,0],[2,0],[2,0],[0,0]], // Degenerate/repeated points.
  [[0,0],[2,0],[2,2],[2.000001,2]], // Distinct inputs become a repeated corner after decimal rounding.
  [[1,0],[1.000004,0],[1.000004,2],[1,2]], // Width collapses after decimal rounding.
  [[1e8,0],[1e8+1,0],[1e8+1,2],[1e8,2]], // Width collapses only after Float32 packing.
  [[0,0],[4.000006,0],[4,3],[0,3]], // Decimal rounding retains a non-axis-aligned edge.
  [[0,0],[1,0],[2,0],[3,0]], // Zero-height bound despite four distinct vertices.
  [[0,0],[2,0],[2,2],[1,2],[0,2]], // Conservative four-corner classification.
];
const acceptedRectangles=[
  [[0,0],[4,0],[4,3],[0,3]],
  [[-3.123456,2.654324],[5.987654,2.654324],[5.987654,8.012345],[-3.123456,8.012345]],
  [[.000001,0],[4.000004,.000003],[4,3],[0,3.000002]], // Only the packed polygon is rectangular.
  [[9996,0],[10000.000001,0],[10000.0004,3],[9996,3]], // Float32 removes the residual diagonal.
];
let checkedRectanglePoints=0;
for(const [polygons,expected] of [[rejectedRectangles,false],[acceptedRectangles,true]])
for(const original of polygons)for(const reversed of [false,true])for(let offset=0;offset<original.length;offset++) {
  const ordered=reversed?[...original].reverse():original;
  const polygon=ordered.slice(offset).concat(ordered.slice(0,offset));
  const packed=context.packRoomLightingGeometry([{id:'shape',polygon}],[],1,1024);
  assert.equal(packed.rectanglesOnly,expected,'Classification uses the exact quantized polygon in either winding');
  assert.equal(packed.uniforms.homeRoomRanges.value[1]<0,expected);
  assert.deepEqual(packedEdges(packed,0),edgesOf({polygon}),'The original packed edges remain available');
  if(!expected)continue;
  const [left,bottom,right,top]=packed.uniforms.homeRoomBounds.value;
  const center=[(left+right)/2,(bottom+top)/2],points=[center,[left,bottom],[right,top],[left,top],[right,bottom]];
  for(const threshold of [0,.015,.04,.1,.55,.56])for(const delta of [-1e-7,0,1e-7])for(const sign of [-1,1]) {
    const gap=sign*(threshold+delta),diagonal=gap/Math.sqrt(2);
    points.push([left-gap,center[1]],[right+gap,center[1]],[center[0],bottom-gap],[center[0],top+gap]);
    points.push([left-diagonal,bottom-diagonal],[right+diagonal,bottom-diagonal],
      [left-diagonal,top+diagonal],[right+diagonal,top+diagonal]);
  }
  for(const point of points) {
    const originalDistance=distance(point,edgesOf({polygon})),actual=packedDistance(packed,0,point);
    near(actual,originalDistance,'Rectangle and polygon distance at edges/corners/transition boundaries');
    near(transmission(actual),transmission(originalDistance),'Point-light transmission at transition boundaries');
    near(1-smooth(0,.04,actual),1-smooth(0,.04,originalDistance),'Exterior illumination at transition boundaries');
    checkedRectanglePoints++;
  }
}
assert.deepEqual(Array.from(data.windowIndices),[1,3,0],'Grouped windows retain each room’s original accumulation order');
assert.deepEqual(Array.from(data.uniforms.homeWindowRooms.value),[0,1],
  'The immutable window-room list retains source room order, not incoming window order');
assert.equal(data.windowRoomCount,2);
for(let i=0;i<rooms.length;i++)assert.deepEqual(packedEdges(data,i),edgesOf(rooms[i]));
for(const limit of [0,1,data.uniformVectors-1,NaN,undefined])assert.equal(context.packRoomLightingGeometry(rooms,windows,9,limit),null);
assert(context.packRoomLightingGeometry(rooms,windows,9,data.uniformVectors));
const withoutWallSwitch=128+9*7+rooms.length*4+rooms.reduce((sum,room)=>sum+room.polygon.length,0)+windows.length*2+Math.max(1,data.windowRoomCount);
assert.equal(data.uniformVectors,withoutWallSwitch+3,'Wall sheen, facing and the zero-point guard have explicit vector allowances');
assert.equal(context.packRoomLightingGeometry(rooms,windows,9,withoutWallSwitch),null,'The old exact limit must fall back instead of overcommitting');
let checked=0;
const positions=[];
for(let x=-1;x<10;x+=.173)for(let z=-1;z<10;z+=.231)positions.push([x,z]);
for(const room of rooms)for(const vertex of room.polygon)for(const delta of [0,.0149,.0151,.0399,.0401,.1,.54999,.55,.55001,.55999,.56001]) {
  positions.push([vertex[0]+delta,vertex[1]],[vertex[0]-delta,vertex[1]]);
}
for(const p of positions) {
  for(let room=0;room<rooms.length;room++) {
    const original=distance(p,edgesOf(rooms[room])),packed=packedDistance(data,room,p);
    if(data.uniforms.homeRoomRanges.value[room*4+1]>=0)assert.equal(packed,original,'Nonrectangle edge distance stays bit-identical');
    else near(packed,original);
    near(transmission(packed),transmission(original));
    const xs=rooms[room].polygon.map(v=>v[0]),zs=rooms[room].polygon.map(v=>v[1]);
    const oldBounds=[Math.min(...xs),Math.min(...zs),Math.max(...xs),Math.max(...zs)].map(rounded);
    assert.deepEqual(Array.from(data.uniforms.homeRoomBounds.value.slice(room*4,room*4+4)),oldBounds);
    checked++;
  }
  for(const day of [0,.2,1])for(const blinds of [[1,1,1,1],[0,.3,0,.8]]) {
    let oldIncoming=0,newIncoming=0,oldExterior=0,newExterior=0;
    rooms.forEach((room,i)=>{
      const oldDistance=distance(p,edgesOf(room)),newDistance=packedDistance(data,i,p);
      if(room.exterior)oldExterior=Math.max(oldExterior,1-smooth(0,.04,oldDistance));
      if(data.uniforms.homeRoomExterior.value[i])newExterior=Math.max(newExterior,1-smooth(0,.04,newDistance));
      if(day>0 && oldDistance<=.015)for(let w=0;w<windows.length;w++)if(windows[w].room===room.id)
        oldIncoming+=Math.fround(blinds[w])*glow(p,[...windows[w].a,...windows[w].b].map(rounded));
      const ranges=data.uniforms.homeRoomRanges.value,segments=data.uniforms.homeWindowSegments.value;
      if(day>0 && newDistance<=.015)for(let w=ranges[i*4+2];w<ranges[i*4+3];w++)
        newIncoming+=Math.fround(blinds[data.windowIndices[w]])*glow(p,Array.from(segments.slice(w*4,w*4+4)));
    });
    near(newIncoming,oldIncoming);near(newExterior,oldExterior);
  }
}

(async()=>{
  const THREE=await import('data:text/javascript;base64,'+fs.readFileSync(path.join(root,'vendor/three.module.min.js')).toString('base64'));
  const construction=fs.readFileSync(path.join(root,'home-view.js'),'utf8').split('\n')
    .find(line=>line.trimStart().startsWith('if(!roomLighting || roomLighting.capacity<lightCount)'));
  assert(construction,'Exercise the actual Home lighting construction');
  for(const [diffuseLighting,maxFragmentUniforms,expected] of [[false,1024,'literal'],[true,1024,'packed'],[true,128,'literal']]) {
    const state={THREE,model:{rooms},lightCount:9,daylightWindows:windows,renderProfile:{diffuseLighting},
      renderer:{capabilities:{maxFragmentUniforms}},roomLighting:null,xm:x=>x,zm:z=>z,
      createRoomLighting:context.createRoomLighting};
    vm.runInNewContext(construction,state);
    assert.equal(state.roomLighting.geometryMode,expected,'Home packs only the selected profile within its real uniform limit');
  }
  function shaderFor(inputRooms,inputWindows,capacity,options) {
    const lighting=context.createRoomLighting(THREE,inputRooms,capacity,inputWindows,options);
    const material=new THREE.MeshLambertMaterial();
    lighting.attach({traverse:visit=>visit({material,userData:{}})},true);
    const shader={uniforms:{},vertexShader:THREE.ShaderLib.lambert.vertexShader,fragmentShader:THREE.ShaderLib.lambert.fragmentShader};
    material.onBeforeCompile(shader);material.dispose();return {lighting,shader};
  }
  for(const [rs,ws,capacity] of [[[],[],0],[rooms,windows,9]]) {
    const literal=shaderFor(rs,ws,capacity),packed=shaderFor(rs,ws,capacity,{packed:true,maxFragmentUniforms:1024});
    const fallback=shaderFor(rs,ws,capacity,{packed:true,maxFragmentUniforms:1});
    assert.equal(literal.lighting.geometryMode,'literal');assert.equal(packed.lighting.geometryMode,'packed');
    assert.equal(fallback.shader.fragmentShader,literal.shader.fragmentShader,'Low-budget fallback is the unchanged literal shader');
    assert.doesNotMatch(packed.shader.fragmentShader,/homeRoomDistance\d+\(/);
    assert.equal((packed.shader.fragmentShader.match(/float homeRoomDistance\(/g)||[]).length,1);
    assert(packed.shader.fragmentShader.includes(boxSource),'The numeric oracle executes the expression emitted into the shader');
    if(rs.length)assert.match(packed.shader.fragmentShader,/if \(range.y < 0\)/);
    const start='#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )';
    const end='#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )';
    const loop=s=>s.slice(s.indexOf(start),s.indexOf(end)).replace(/\n}\n$/, '');
    const packedLoop=loop(packed.shader.fragmentShader);
    const cachedEquivalent=packedLoop
      .replace('ivec4 homeRunData = homeLightRuns[homeRun];\n      ', '')
      .replaceAll('homeRunData.y','homeLightRunEnds[homeRun]')
      .replaceAll('homeRunData.x','homeRunStart')
      .replace('homePointTransmission(homeRunData.z)','homePointTransmission(homePointRooms[homeFirstLight])')
      .replace(/homePointTransmission\(homePointRooms\[([^\]]+)\]\)/g,
        'homeRoomTransmissions[homePointRooms[$1]]')
      .replace('\n    \n    for ( int homeRun','\n    int homeRunStart = 0;\n    for ( int homeRun')
      .replace('\n      \n    }','\n      homeRunStart = homeRunEnd;\n    }');
    assert.equal(cachedEquivalent,loop(literal.shader.fragmentShader),'Point-light order, culling and math differ only in equivalent transmission lookup');
    assert.match(packed.shader.fragmentShader,/uniform ivec4 homeLightRuns\[/);
    assert.doesNotMatch(packed.shader.fragmentShader,/uniform int homeLightRun(?:Starts|Ends)\[/,
      'Packed shaders no longer declare the separate dynamic start/end arrays');
    assert.doesNotMatch(packed.shader.fragmentShader,/homeRoomTransmissions\[/,'Packed mode has no dynamically indexed local transmission array');
    assert.match(packed.shader.fragmentShader,/if \(room == 0\) return 1\.0;/,'Unbound lights keep unrestricted transmission');
    assert.match(packed.shader.fragmentShader,/homeLitRooms\[index\] != 0 && homeRoomNearby\(index\)\s*\? homeRoomTransmission\(homeRoomDistance\(index\)\) : 0\.0;/,'On-demand lookup retains lit-room and spatial guards');
    const values=ws.map((_,i)=>.1+i*.2);
    packed.lighting.environment(.7,values);
    if(ws.length) {
      assert.deepEqual(Array.from(packed.shader.uniforms.homeWindowTransmission.value).slice(0,3),[values[1],values[3],values[0]].map(Math.fround));
      packed.lighting.environment(.4,[.9]);
      assert.deepEqual(Array.from(packed.shader.uniforms.homeWindowTransmission.value).slice(0,3),[values[1],values[3],.9].map(Math.fround),
        'A partial environment update retains untouched window values');
    }
  }
  // Execute the actual scalar GLSL helper as JavaScript, against an independent
  // precomputed-cache oracle. The unchanged geometry math is checked above.
  const direct=shaderFor(rooms,windows,12,{packed:true,maxFragmentUniforms:1024});
  const helper=direct.shader.fragmentShader.match(/float homePointTransmission\(int room\) \{([\s\S]*?)\n    \}/);
  assert(helper,'The packed shader exposes one on-demand transmission helper');
  const evaluate=new Function('room','homeLitRooms','homeRoomNearby','homeRoomDistance','homeRoomTransmission',
    helper[1].replace(/\bint index\b/,'const index'));
  // Execute the emitted run-control code, replacing only the already verified
  // unchanged direct-light body with a visit recorder. This catches record
  // channel/index, prefix-clipping and loop-bound errors independently of the
  // CPU producer rather than reconstructing its algorithm in the test.
  const runStart=direct.shader.fragmentShader.indexOf('for ( int homeRun = 0;');
  assert(runStart>=0);
  const opening=direct.shader.fragmentShader.indexOf('{',runStart);
  let depth=1,runEnd=opening+1;
  for(;depth;runEnd++) {
    assert(runEnd<direct.shader.fragmentShader.length,'Run loop has balanced braces');
    if(direct.shader.fragmentShader[runEnd]==='{')depth++;
    if(direct.shader.fragmentShader[runEnd]==='}')depth--;
  }
  const emittedRun=direct.shader.fragmentShader.slice(runStart,runEnd);
  const firstBody=emittedRun.indexOf('pointLight = pointLights[ i ];');
  const lastCall='if (directLight.visible) RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
  const lastBody=emittedRun.indexOf(lastCall,firstBody)+lastCall.length;
  assert(firstBody>=0 && lastBody>firstBody);
  const runControl=(emittedRun.slice(0,firstBody)+'visit(i,homeRunTransmission);'+emittedRun.slice(lastBody))
    .replace(/\b(?:int|float|ivec4)\b/g,'let');
  const executeRuns=new Function('homeLightRuns','homeLightRunCount','NUM_POINT_LIGHTS','NUM_POINT_LIGHT_SHADOWS',
    'homePointTransmission','visit','min','max',runControl);
  const recordValues=uniforms=>Array.from({length:uniforms.homeLightRunCount.value},(_,i)=>
    Array.from(uniforms.homeLightRuns.value.slice(i*4,i*4+4)));
  const visitRuns=(uniforms,count,prefix,lookup,visit)=> {
    const records=recordValues(uniforms).map(([x,y,z,w])=>({x,y,z,w}));
    const checkedRecords=new Proxy(records,{get:(target,key)=> {
      assert(Number.isInteger(Number(key))&&Number(key)>=0&&Number(key)<target.length,'Only active run records are read');
      return target[key];
    }});
    executeRuns(checkedRecords,records.length,count,prefix,lookup,visit,Math.min,Math.max);
  };
  const roomNumber=room=>rooms.findIndex(value=>value.id===room)+1;
  const checkIndex=index=>assert(Number.isInteger(index)&&index>=0&&index<rooms.length,'No out-of-range room access');
  let checkedDirect=0,checkedRuns=0;
  for(const mask of [0,1,2,3,4,5,6,7])for(const mode of ['grouped','interleaved','hidden']) {
    const points=Array.from({length:12},(_,i)=>({item:{room:i===11?'unknown':rooms[mode==='grouped'?Math.floor(i/4):i%3].id},
      light:{visible:mode!=='hidden'||i%4!==1,castShadow:i<2||i===7,intensity:mask&(1<<(i%3))?1:0}}));
    direct.lighting.update(points);
    const uniforms=direct.shader.uniforms;
    const ordered=points.filter(p=>p.light.visible).sort((a,b)=>Number(b.light.castShadow)-Number(a.light.castShadow));
    const ids=ordered.map(p=>roomNumber(p.item.room));
    assert.deepEqual(Array.from(uniforms.homePointRooms.value).slice(0,ids.length),ids);
    const lit=Array.from(uniforms.homeLitRooms.value);
    const guardedLit=new Proxy(lit,{get:(target,key)=>{checkIndex(Number(key));return target[key];}});
    for(const p of positions) {
      const cached=[1,...rooms.map((room,index)=>lit[index]?transmission(distance(p,edgesOf(room))):0)];
      const lookup=id=>evaluate(id,guardedLit,index=>{
        checkIndex(index);const b=data.uniforms.homeRoomBounds.value.slice(index*4,index*4+4);
        return p[0]>=b[0]-.56&&p[1]>=b[1]-.56&&p[0]<=b[2]+.56&&p[1]<=b[3]+.56;
      },index=>{checkIndex(index);return packedDistance(data,index,p);},transmission);
      for(let id=0;id<=rooms.length;id++) {
        near(lookup(id),cached[id],'Actual direct helper equals independent per-room cache');checkedDirect++;
      }
      for(const prefix of [0,ordered.filter(point=>point.light.castShadow).length,ordered.length]) {
        const expected=ids.flatMap((id,index)=>cached[id]!==0?[[index,cached[id]]]:[]),actual=[];
        for(let index=0;index<prefix;index++)if(lookup(ids[index])!==0)actual.push([index,lookup(ids[index])]);
        visitRuns(uniforms,ordered.length,prefix,lookup,(index,value)=>actual.push([index,value]));
        assert.deepEqual(actual.map(v=>v[0]),expected.map(v=>v[0]),'Every contribution retains its original order');
        actual.forEach((v,i)=>near(v[1],expected[i][1],'Transmission retains polygon distance within floating-point arithmetic precision'));
        checkedRuns++;
      }
    }
  }
  // Empty geometry and unknown/unassigned room IDs must never index room -1.
  assert.equal(evaluate(0,new Proxy([],{get:()=>{throw Error('Unexpected room read');}}),
    ()=>{throw Error('Unexpected bounds read');},()=>{throw Error('Unexpected geometry read');},transmission),1);
  console.log(JSON.stringify({checkedDirect,checkedRuns}));

  // Execute the actual generated daylight control flow. The independent oracle
  // visits original rooms/windows without the new bounds or topology shortcuts.
  function daylightBody(fragment) {
    const marker='vec3 homeDaylightIrradiance() {';
    const begin=fragment.indexOf(marker)+marker.length;
    assert(begin>=marker.length);
    let depth=1,end=begin;
    while(depth&&end<fragment.length) {if(fragment[end]==='{')depth++;if(fragment[end]==='}')depth--;end++;}
    assert.equal(depth,0);return fragment.slice(begin,end-1);
  }
  function daylightEvaluator(body) {
    const result=body.replace(/return 3\.14159265 \* vec3\(([^)]+)\) \*\s*([^;]+);/,
      'return [$1].map(channel=>3.14159265*channel*($2));');
    assert.notEqual(result,body,'Translate the unchanged vec3 irradiance expression');
    return new Function('homeExteriorSurface','homeDaylight','homeRoomExterior','homeRoomRanges',
      'homeWindowRooms','homeWindowSegments','homeWindowTransmission','homeRoomNearby','homeRoomDistance','homeWindowGlow',
      'max','min','smoothstep',result.replace(/\b(?:float|int|ivec4|vec4)\s+(\w+)/g,'let $1'));
  }
  const daylightPositions=[...positions];
  for(const room of rooms)for(const vertex of room.polygon)
    for(const edge of [.015,.04,.1,.55,.56])for(const delta of [-1e-7,0,1e-7])
      for(const axis of [0,1])for(const sign of [-1,1]) {
        const point=[...vertex];point[axis]+=sign*(edge+delta);daylightPositions.push(point);
      }
  let checkedDaylight=0;
  for(const [inputRooms,inputWindows] of [
    [rooms,windows], [rooms.map(room=>({...room,exterior:false})),windows],
    [rooms.filter((_,index)=>index!==1).map(room=>({...room,exterior:true})),windows],
    [rooms,[windows[0]]], // Leading and trailing rooms without windows.
    [rooms,[{room:'C',a:[1,8],b:[2,8]},windows[1],windows[2],windows[3]]], // A gap and reordered windows.
    [rooms,[]], [rooms,[windows[2]]], [[],windows], [[],[]],
  ]) {
    const packedGeometry=context.packRoomLightingGeometry(inputRooms,inputWindows,9,1024);
    const compiled=shaderFor(inputRooms,inputWindows,9,{packed:true,maxFragmentUniforms:1024});
    const body=daylightBody(compiled.shader.fragmentShader),evaluateDaylight=daylightEvaluator(body);
    const hasExterior=inputRooms.some(room=>room.exterior===true);
    if(hasExterior)assert.match(body,/homeRoomExterior\[room\] != 0 && homeRoomNearby\(room\)/);
    else assert.doesNotMatch(body,/homeRoomExterior\[/,'No exterior topology emits no exterior loop');
    if(packedGeometry.windowIndices.length) {
      assert.match(body,/int room = homeWindowRooms\[windowRoom\];/);
      assert.match(body,/if \(homeRoomNearby\(room\) && homeRoomDistance\(room\) <= 0\.015\)/);
      const expectedRooms=inputRooms.flatMap((room,index)=>inputWindows.some(window=>window.room===room.id)?[index]:[]);
      assert.deepEqual(Array.from(packedGeometry.uniforms.homeWindowRooms.value),expectedRooms);
      assert.equal(packedGeometry.windowRoomCount,expectedRooms.length);
      assert(body.includes(`windowRoom < ${expectedRooms.length}`),'The emitted loop visits only nonempty rooms');
    }
    else assert.doesNotMatch(body,/homeRoomRanges\[/,'No mapped windows emit no window-room loop');
    if(!hasExterior&&!packedGeometry.windowIndices.length)assert.doesNotMatch(body,/for \(/);
    const bounds=packedGeometry.uniforms.homeRoomBounds.value;
    const ranges=Array.from({length:inputRooms.length},(_,i)=>({
      z:packedGeometry.uniforms.homeRoomRanges.value[i*4+2],w:packedGeometry.uniforms.homeRoomRanges.value[i*4+3]}));
    const segments=packedGeometry.windowIndices.map((source,i)=>({source,
      xy:Array.from(packedGeometry.uniforms.homeWindowSegments.value.slice(i*4,i*4+2)),
      zw:Array.from(packedGeometry.uniforms.homeWindowSegments.value.slice(i*4+2,i*4+4))}));
    const sourceForSegment=new Map(segments.map(segment=>[segment.xy,segment.source]));
    for(const point of daylightPositions)for(const day of [0,.2,1])for(const materialExterior of [0,1]) {
      const incomingByWindow=inputWindows.map((_,i)=>Math.fround([.08,.55,1,0][i%4]));
      let incoming=0,exterior=materialExterior;const expectedOrder=[],actualOrder=[];
      inputRooms.forEach(room=>{
        const d=distance(point,edgesOf(room));
        if(room.exterior===true)exterior=Math.max(exterior,1-smooth(0,.04,d));
        if(day>0&&d<=.015)inputWindows.forEach((window,index)=>{
          if(window.room!==room.id)return;
          incoming+=incomingByWindow[index]*glow(point,[...window.a,...window.b].map(rounded));expectedOrder.push(index);
        });
      });
      const expected=[.93,.97,1].map(channel=>3.14159265*channel*(day*Math.min(incoming,1.05)+exterior*(.16+1.1*day)));
      const nearby=index=>point[0]>=bounds[index*4]-.56&&point[1]>=bounds[index*4+1]-.56&&
        point[0]<=bounds[index*4+2]+.56&&point[1]<=bounds[index*4+3]+.56;
      const visitedRanges=[];
      const checkedRanges=new Proxy(ranges,{get(target,key){
        const index=Number(key);assert(Number.isInteger(index)&&index>=0&&index<inputRooms.length);
        assert(target[index].z<target[index].w,'The window loop cannot load a room without windows');
        visitedRanges.push(index);return target[index];
      }});
      const actual=evaluateDaylight(materialExterior,day,packedGeometry.uniforms.homeRoomExterior.value,checkedRanges,
        packedGeometry.uniforms.homeWindowRooms.value,segments,
        packedGeometry.windowIndices.map(index=>incomingByWindow[index]),nearby,
        index=>{assert(nearby(index),'Distance is evaluated only after the conservative bounds guard');return packedDistance(packedGeometry,index,point);},
        (a,b)=>{actualOrder.push(sourceForSegment.get(a));return glow(point,[...a,...b]);},Math.max,Math.min,smooth);
      actual.forEach((channel,index)=>near(channel,expected[index],'Actual packed daylight equals original unguarded polygon/window accumulation'));
      assert.deepEqual(actualOrder,expectedOrder,'Mapped window contribution order is unchanged');checkedDaylight++;
      assert.deepEqual(visitedRanges,day>0?Array.from(packedGeometry.uniforms.homeWindowRooms.value).slice(0,packedGeometry.windowRoomCount):[],
        'Every daylight evaluation visits each nonempty room once in original order');
    }
  }
  console.log(JSON.stringify({checkedDaylight,checkedRectanglePoints}));
  // Conservative static bounds are checked with actual Three transforms and
  // independent points on each mesh, including negative/nonuniform scales.
  const box = new THREE.BoxGeometry(1.3,2.1,.9);
  const cullRooms = Array.from({length:25},(_,i)=>{const x=(i%5-2)*4,z=(Math.floor(i/5)-2)*4;
    return {id:`cull${i}`,polygon:[[x,z],[x+4,z],[x+4,z+4],[x,z+4]]};});
  const cullData = context.packRoomLightingGeometry(cullRooms,[],26,2048);
  const pointRooms = new Int32Array([...cullRooms.map((_,i)=>i+1),0]);
  const ends = new Int32Array(Array.from({length:26},(_,i)=>i+1));
  let checkedCulledPoints=0;
  for (const translation of [[0,0,0],[-8,3,-4],[5,-2,7],[100000,-3,-100000]])
  for (const angle of [0,.3,Math.PI/2]) for (const scale of [[1,1,1],[-2,.3,1.7],[.01,4,-.2]]) {
    const mesh = new THREE.Mesh(box,new THREE.MeshLambertMaterial());
    mesh.position.set(...translation);mesh.rotation.set(angle/2,angle,angle/3);mesh.scale.set(...scale);mesh.updateMatrixWorld();
    const bounds = context.roomLightingWorldBounds(mesh);assert(bounds);
    const starts = new Int32Array(26), filteredEnds = new Int32Array(26);
    const count = context.filterRoomLightingRuns(bounds,cullData.uniforms.homeRoomBounds.value,
      pointRooms,ends,26,starts,filteredEnds);
    const kept = Array.from(starts.slice(0,count));
    assert(kept.includes(25),'Unassigned-room lights always remain');
    assert.deepEqual(kept,[...kept].sort((a,b)=>a-b),'Original light order remains unchanged');
    for(const x of [-.65,0,.65])for(const y of [-1.05,0,1.05])for(const z of [-.45,0,.45]) {
      const point = new THREE.Vector3(x,y,z).applyMatrix4(mesh.matrixWorld);
      assert(point.x>=bounds[0]&&point.x<=bounds[2]&&point.z>=bounds[1]&&point.z<=bounds[3]);
      cullRooms.forEach((room,i)=>{if(transmission(distance([point.x,point.z],edgesOf(room)))>0)
        assert(kept.includes(i),'Every potentially nonzero room contribution remains');});
      checkedCulledPoints++;
    }
    mesh.material.dispose();
  }
  for(const point of positions) {
    const starts=new Int32Array(4),endsOut=new Int32Array(4);
    const count=context.filterRoomLightingRuns([point[0],point[1],point[0],point[1]],data.uniforms.homeRoomBounds.value,
      new Int32Array([1,2,3,0]),new Int32Array([1,2,3,4]),4,starts,endsOut);
    const kept=Array.from(starts.slice(0,count));assert(kept.includes(3));
    rooms.forEach((room,i)=>{if(transmission(distance(point,edgesOf(room)))>0)assert(kept.includes(i),
      'Concave polygons and spill-boundary samples cannot be falsely culled');});
  }
  const invalid = new THREE.Mesh(box,new THREE.MeshLambertMaterial());invalid.updateMatrixWorld();
  for(const flag of ['isSkinnedMesh','isInstancedMesh','isBatchedMesh']) {
    invalid[flag]=true;assert.equal(context.roomLightingWorldBounds(invalid),null);delete invalid[flag];
  }
  invalid.material.displacementMap={};assert.equal(context.roomLightingWorldBounds(invalid),null);invalid.material.displacementMap=null;
  invalid.matrixWorld.elements[3]=.1;assert.equal(context.roomLightingWorldBounds(invalid),null);invalid.updateMatrix();invalid.updateMatrixWorld();
  const invalidGeometry=new THREE.BufferGeometry();invalidGeometry.setAttribute('position',new THREE.Float32BufferAttribute([NaN,0,0],3));
  invalid.geometry=invalidGeometry;assert.equal(context.roomLightingWorldBounds(invalid),null);
  invalidGeometry.dispose();invalid.material.dispose();

  const closeRooms=[{id:'near',polygon:[[-2,-2],[2,-2],[2,2],[-2,2]]},
    {id:'far',polygon:[[18,-2],[22,-2],[22,2],[18,2]]},
    {id:'other',polygon:[[38,-2],[42,-2],[42,2],[38,2]]}];
  const makePoints=()=>['near','near','far','far','other','missing'].map((room,i)=>({item:{room},light:{visible:true,castShadow:i<2,intensity:1}}));
  const localLighting=context.createRoomLighting(THREE,closeRooms,6,[],{packed:true,maxFragmentUniforms:1024});
  const rootGroup=new THREE.Group(),staticMaterial=new THREE.MeshLambertMaterial();
  const first=new THREE.Mesh(box,staticMaterial),second=new THREE.Mesh(box,staticMaterial);second.position.x=20;rootGroup.add(first,second);
  localLighting.attach(rootGroup,true,{staticGeometry:true});
  const compiled={uniforms:{},vertexShader:THREE.ShaderLib.lambert.vertexShader,fragmentShader:THREE.ShaderLib.lambert.fragmentShader};
  staticMaterial.onBeforeCompile(compiled);
  const selected=()=>Array.from(compiled.uniforms.homeLightRunStarts.value.slice(0,compiled.uniforms.homeLightRunCount.value));
  localLighting.update(makePoints());assert.deepEqual(selected(),[0,2,5],'Shared static material uses the union of both mesh bounds');
  assert.deepEqual(recordValues(compiled.uniforms),[[0,2,1,0],[2,4,2,0],[5,6,0,0]],
    'Filtered records retain global indices, roomless lights and the static material union');
  // The first retained run need not start at zero, later runs may have gaps,
  // and the actual shadow-prefix count may split a retained multi-light run.
  const gapStarts=new Int32Array(6),gapEnds=new Int32Array(6);
  const orderedIds=new Int32Array([1,1,2,2,3,0]),orderedEnds=new Int32Array([2,4,5,6]);
  const gapBounds=[19,-1,21,1],closeBounds=context.packRoomLightingGeometry(closeRooms,[],6,1024).uniforms.homeRoomBounds.value;
  const gapCount=context.filterRoomLightingRuns(gapBounds,closeBounds,orderedIds,orderedEnds,4,gapStarts,gapEnds);
  assert.deepEqual(Array.from(gapStarts.slice(0,gapCount)),[2,5]);
  assert.deepEqual(Array.from(gapEnds.slice(0,gapCount)),[4,6]);
  const gapRecords=new Int32Array(24).fill(-999);
  context.packLightRunRecords(gapStarts,gapEnds,orderedIds,gapCount,gapRecords);
  const gapUniforms={homeLightRunCount:{value:gapCount},homeLightRuns:{value:gapRecords}};
  assert.deepEqual(recordValues(gapUniforms),[[2,4,2,0],[5,6,0,0]]);
  for(const prefix of [0,1,2,3,4,5,6]) for(const point of [[19.5,0],[20.5,.5]]) {
    const value=index=>orderedIds[index]===0?1:transmission(distance(point,edgesOf(closeRooms[orderedIds[index]-1])));
    const expected=Array.from(orderedIds,(_,index)=>index).filter(index=>value(index)!==0),actual=[];
    for(let index=0;index<prefix;index++)if(value(index)!==0)actual.push(index);
    visitRuns(gapUniforms,orderedIds.length,prefix,room=>room===0?1:transmission(distance(point,edgesOf(closeRooms[room-1]))),
      index=>actual.push(index));
    assert.deepEqual(actual,expected,'Filtered nonzero starts/gaps and clipped shadow prefix preserve each contribution once');
  }
  const dynamicGroup=new THREE.Group(),moving=new THREE.Mesh(box,staticMaterial);dynamicGroup.add(moving);
  localLighting.attach(dynamicGroup,true);localLighting.update(makePoints());
  assert.deepEqual(selected(),[0,2,4,5],'Sharing with mutable inventory permanently retains all original runs');
  assert.deepEqual(recordValues(compiled.uniforms),[[0,2,1,0],[2,4,2,0],[4,5,3,0],[5,6,0,0]]);
  moving.position.x=40;moving.scale.set(-3,2,4);moving.updateMatrixWorld();localLighting.update(makePoints());
  assert.deepEqual(selected(),[0,2,4,5],'Inventory movement never relies on a cached static bound');
  const changed=makePoints();changed[2].light.visible=false;changed[4].light.intensity=0;
  localLighting.update(changed);assert.deepEqual(selected(),[0,2,3,4],'Visibility/light changes retain the current exact global run order');
  assert.deepEqual(recordValues(compiled.uniforms),[[0,2,1,0],[2,3,2,0],[3,4,3,0],[4,5,0,0]]);
  const recordStorage=compiled.uniforms.homeLightRuns.value;
  const allHidden=makePoints();allHidden.forEach(point=>point.light.visible=false);
  localLighting.update(allHidden);
  assert.equal(compiled.uniforms.homeLightRunCount.value,0);
  visitRuns(compiled.uniforms,0,0,()=>assert.fail('Empty runs cannot evaluate a room'),()=>assert.fail('Empty runs cannot visit a light'));
  localLighting.update([]);
  assert.equal(compiled.uniforms.homeLightRunCount.value,0,'Empty updates cannot revive stale records');
  const reenabled=makePoints();reenabled.forEach((point,i)=>{point.light.intensity=0;point.light.castShadow=i===4;});
  localLighting.update(reenabled);
  assert.equal(compiled.uniforms.homeLightRuns.value,recordStorage,'Updates reuse the same per-material upload storage');
  assert.deepEqual(recordValues(compiled.uniforms),[[0,1,3,0],[1,3,1,0],[3,5,2,0],[5,6,0,0]],
    'Reenabled lights retain zero-intensity slots and current shadow-first ordering');
  const priorAllowance=128+6*6+closeRooms.length*4+closeRooms.reduce((sum,room)=>sum+room.polygon.length,0);
  assert.equal(context.createRoomLighting(THREE,closeRooms,6,[],{packed:true,maxFragmentUniforms:priorAllowance}).geometryMode,'literal',
    'Packed run records retain the conservative per-light uniform allowance');
  staticMaterial.dispose();box.dispose();
  console.log(JSON.stringify({checkedCulledPoints}));
  const full=Array.from({length:24},(_,i)=>{const x=i%6*4,z=Math.floor(i/6)*4;return{id:`room${i}`,polygon:[[x,z],[x+4,z],[x+4,z+4],[x,z+4]]};});
  const fullWindows=full.slice(0,6).map((r,i)=>({room:r.id,a:[i*4+1,0],b:[i*4+2.6,0]}));
  const literal=shaderFor(full,fullWindows,72),packed=shaderFor(full,fullWindows,72,{packed:true,maxFragmentUniforms:1024});
  const fullData=context.packRoomLightingGeometry(full,fullWindows,72,1024);
  assert.equal(fullData.windowRoomCount,6,'The 24-room fixture visits only its six window rooms');
  assert.deepEqual(Array.from(fullData.uniforms.homeWindowRooms.value),[0,1,2,3,4,5]);
  const previousAllowance=130+72*7+full.length*4+full.length*4+fullWindows.length*2;
  assert.equal(fullData.uniformVectors,previousAllowance+7,'Window-room array elements and the zero-point guard reserve full uniform vectors');
  assert.equal(context.packRoomLightingGeometry(full,fullWindows,72,fullData.uniformVectors-1),null);
  assert(context.packRoomLightingGeometry(full,fullWindows,72,fullData.uniformVectors));
  assert.equal(shaderFor(full,fullWindows,72,{packed:true,maxFragmentUniforms:previousAllowance}).shader.fragmentShader,
    literal.shader.fragmentShader,'A limit fitting only the old arrays falls back to the unchanged literal shader');
  assert.equal(context.packRoomLightingGeometry(full,fullWindows,72,1024).rectanglesOnly,true);
  assert.doesNotMatch(packed.shader.fragmentShader,/for \(int edge|if \(range.y < 0\)/,'An all-rectangle plan omits the generic edge loop entirely');
  assert.match(packed.shader.fragmentShader,/return length\(max\(distanceToBox, vec2\(0.0\)\)\) \+ min\(max\(distanceToBox.x, distanceToBox.y\), 0.0\);/);
  assert.equal(packed.lighting.geometryMode,'packed');
  assert.equal(packed.lighting.geometryUniformVectors,845,'Full fixture allowance includes wall-sheen, facing, zero-point guard and the window-room list');
  assert(packed.shader.fragmentShader.length<literal.shader.fragmentShader.length*.55);
  console.log(JSON.stringify({checkedRoomPoints:checked,maxNumericDelta,rooms:24,lights:72,uniformVectorAllowance:packed.lighting.geometryUniformVectors,
    literalFragmentCharacters:literal.shader.fragmentShader.length,packedFragmentCharacters:packed.shader.fragmentShader.length}));
})().catch(error=>{console.error(error);process.exitCode=1;});
