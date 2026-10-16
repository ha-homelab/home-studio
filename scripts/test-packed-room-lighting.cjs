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
    assert.equal(loop(packed.shader.fragmentShader),loop(literal.shader.fragmentShader),'Point-light loop is byte-identical');
    const values=ws.map((_,i)=>.1+i*.2);
    packed.lighting.environment(.7,values);
    if(ws.length) {
      assert.deepEqual(Array.from(packed.shader.uniforms.homeWindowTransmission.value).slice(0,3),[values[1],values[3],values[0]].map(Math.fround));
      packed.lighting.environment(.4,[.9]);
      assert.deepEqual(Array.from(packed.shader.uniforms.homeWindowTransmission.value).slice(0,3),[values[1],values[3],.9].map(Math.fround),
        'A partial environment update retains untouched window values');
    }
  }
  const full=Array.from({length:24},(_,i)=>{const x=i%6*4,z=Math.floor(i/6)*4;return{id:`room${i}`,polygon:[[x,z],[x+4,z],[x+4,z+4],[x,z+4]]};});
  const fullWindows=full.slice(0,6).map((r,i)=>({room:r.id,a:[i*4+1,0],b:[i*4+2.6,0]}));
  const literal=shaderFor(full,fullWindows,72),packed=shaderFor(full,fullWindows,72,{packed:true,maxFragmentUniforms:1024});
  assert.equal(packed.lighting.geometryMode,'packed');
  assert(packed.shader.fragmentShader.length<literal.shader.fragmentShader.length*.55);
  console.log(JSON.stringify({checkedRoomPoints:checked,rooms:24,lights:72,uniformVectorAllowance:packed.lighting.geometryUniformVectors,
    literalFragmentCharacters:literal.shader.fragmentShader.length,packedFragmentCharacters:packed.shader.fragmentShader.length}));
})().catch(error=>{console.error(error);process.exitCode=1;});
