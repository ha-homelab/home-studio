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
  for(let i=range[room*4];i<range[room*4+1];i++)result.push(Array.from(edges.slice(i*4,i*4+4)));
  return result;
}
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
assert.deepEqual(Array.from(data.windowIndices),[1,3,0],'Grouped windows retain each room’s original accumulation order');
for(let i=0;i<rooms.length;i++)assert.deepEqual(packedEdges(data,i),edgesOf(rooms[i]));
for(const limit of [0,1,data.uniformVectors-1,NaN,undefined])assert.equal(context.packRoomLightingGeometry(rooms,windows,9,limit),null);
assert(context.packRoomLightingGeometry(rooms,windows,9,data.uniformVectors));
let checked=0;
const positions=[];
for(let x=-1;x<10;x+=.173)for(let z=-1;z<10;z+=.231)positions.push([x,z]);
for(const room of rooms)for(const vertex of room.polygon)for(const delta of [0,.0149,.0151,.0399,.0401,.1,.54999,.55,.55001,.55999,.56001]) {
  positions.push([vertex[0]+delta,vertex[1]],[vertex[0]-delta,vertex[1]]);
}
for(const p of positions) {
  for(let room=0;room<rooms.length;room++) {
    const original=distance(p,edgesOf(rooms[room])),packed=distance(p,packedEdges(data,room));
    assert.equal(packed,original);assert.equal(transmission(packed),transmission(original));
    const xs=rooms[room].polygon.map(v=>v[0]),zs=rooms[room].polygon.map(v=>v[1]);
    const oldBounds=[Math.min(...xs),Math.min(...zs),Math.max(...xs),Math.max(...zs)].map(rounded);
    assert.deepEqual(Array.from(data.uniforms.homeRoomBounds.value.slice(room*4,room*4+4)),oldBounds);
    checked++;
  }
  for(const day of [0,.2,1])for(const blinds of [[1,1,1,1],[0,.3,0,.8]]) {
    let oldIncoming=0,newIncoming=0,oldExterior=0,newExterior=0;
    rooms.forEach((room,i)=>{
      const oldDistance=distance(p,edgesOf(room)),newDistance=distance(p,packedEdges(data,i));
      if(room.exterior)oldExterior=Math.max(oldExterior,1-smooth(0,.04,oldDistance));
      if(data.uniforms.homeRoomExterior.value[i])newExterior=Math.max(newExterior,1-smooth(0,.04,newDistance));
      if(day>0 && oldDistance<=.015)for(let w=0;w<windows.length;w++)if(windows[w].room===room.id)
        oldIncoming+=Math.fround(blinds[w])*glow(p,[...windows[w].a,...windows[w].b].map(rounded));
      const ranges=data.uniforms.homeRoomRanges.value,segments=data.uniforms.homeWindowSegments.value;
      if(day>0 && newDistance<=.015)for(let w=ranges[i*4+2];w<ranges[i*4+3];w++)
        newIncoming+=Math.fround(blinds[data.windowIndices[w]])*glow(p,Array.from(segments.slice(w*4,w*4+4)));
    });
    assert.equal(newIncoming,oldIncoming);assert.equal(newExterior,oldExterior);
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
    const start='#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )';
    const end='#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )';
    const loop=s=>s.slice(s.indexOf(start),s.indexOf(end));
    const packedLoop=loop(packed.shader.fragmentShader);
    const cachedEquivalent=packedLoop.replace(/homePointTransmission\(homePointRooms\[([^\]]+)\]\)/g,
      'homeRoomTransmissions[homePointRooms[$1]]');
    assert.equal(cachedEquivalent,loop(literal.shader.fragmentShader),'Point-light order, culling and math differ only in equivalent transmission lookup');
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
      },index=>{checkIndex(index);return distance(p,packedEdges(data,index));},transmission);
      for(let id=0;id<=rooms.length;id++) {
        assert.equal(lookup(id),cached[id],'Actual direct helper equals independent per-room cache');checkedDirect++;
      }
      for(const prefix of [0,ordered.filter(point=>point.light.castShadow).length,ordered.length]) {
        const expected=ids.flatMap((id,index)=>cached[id]!==0?[[index,cached[id]]]:[]),actual=[];
        for(let index=0;index<prefix;index++)if(lookup(ids[index])!==0)actual.push([index,lookup(ids[index])]);
        let start=0;
        for(const end of Array.from(uniforms.homeLightRunEnds.value).slice(0,uniforms.homeLightRunCount.value)) {
          const first=Math.max(start,prefix);
          if(first<end) {const value=lookup(ids[first]);if(value!==0)for(let index=first;index<end;index++)actual.push([index,value]);}
          start=end;
        }
        assert.deepEqual(actual,expected,'Every shadow-prefix/runtime-run contribution retains its original order and exact transmission');
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
      'homeWindowSegments','homeWindowTransmission','homeRoomNearby','homeRoomDistance','homeWindowGlow',
      'max','min','smoothstep',result.replace(/\b(?:float|int|ivec4|vec4)\s+(\w+)/g,'let $1'));
  }
  const daylightPositions=[...positions];
  for(const room of rooms)for(const vertex of room.polygon)
    for(const edge of [.015,.04,.55,.56])for(const delta of [-1e-7,0,1e-7])
      for(const axis of [0,1])for(const sign of [-1,1]) {
        const point=[...vertex];point[axis]+=sign*(edge+delta);daylightPositions.push(point);
      }
  let checkedDaylight=0;
  for(const [inputRooms,inputWindows] of [
    [rooms,windows], [rooms.map(room=>({...room,exterior:false})),windows],
    [rooms,[]], [rooms,[windows[2]]], [[],windows], [[],[]],
  ]) {
    const packedGeometry=context.packRoomLightingGeometry(inputRooms,inputWindows,9,1024);
    const compiled=shaderFor(inputRooms,inputWindows,9,{packed:true,maxFragmentUniforms:1024});
    const body=daylightBody(compiled.shader.fragmentShader),evaluateDaylight=daylightEvaluator(body);
    const hasExterior=inputRooms.some(room=>room.exterior===true);
    if(hasExterior)assert.match(body,/homeRoomExterior\[room\] != 0 && homeRoomNearby\(room\)/);
    else assert.doesNotMatch(body,/homeRoomExterior\[/,'No exterior topology emits no exterior loop');
    if(packedGeometry.windowIndices.length)assert.match(body,/range\.z < range\.w && homeRoomNearby\(room\) && homeRoomDistance\(room\) <= 0\.015/);
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
      const actual=evaluateDaylight(materialExterior,day,packedGeometry.uniforms.homeRoomExterior.value,ranges,segments,
        packedGeometry.windowIndices.map(index=>incomingByWindow[index]),nearby,
        index=>{assert(nearby(index),'Distance is evaluated only after the conservative bounds guard');return distance(point,edgesOf(inputRooms[index]));},
        (a,b)=>{actualOrder.push(sourceForSegment.get(a));return glow(point,[...a,...b]);},Math.max,Math.min,smooth);
      assert.deepEqual(actual,expected,'Actual packed daylight equals original unguarded polygon/window accumulation');
      assert.deepEqual(actualOrder,expectedOrder,'Mapped window contribution order is unchanged');checkedDaylight++;
    }
  }
  console.log(JSON.stringify({checkedDaylight}));
  const full=Array.from({length:24},(_,i)=>{const x=i%6*4,z=Math.floor(i/6)*4;return{id:`room${i}`,polygon:[[x,z],[x+4,z],[x+4,z+4],[x,z+4]]};});
  const fullWindows=full.slice(0,6).map((r,i)=>({room:r.id,a:[i*4+1,0],b:[i*4+2.6,0]}));
  const literal=shaderFor(full,fullWindows,72),packed=shaderFor(full,fullWindows,72,{packed:true,maxFragmentUniforms:1024});
  assert.equal(packed.lighting.geometryMode,'packed');
  assert(packed.shader.fragmentShader.length<literal.shader.fragmentShader.length*.55);
  console.log(JSON.stringify({checkedRoomPoints:checked,rooms:24,lights:72,uniformVectorAllowance:packed.lighting.geometryUniformVectors,
    literalFragmentCharacters:literal.shader.fragmentShader.length,packedFragmentCharacters:packed.shader.fragmentShader.length}));
})().catch(error=>{console.error(error);process.exitCode=1;});
