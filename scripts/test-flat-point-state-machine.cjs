// Execute the emitted packed control flow; retain the pinned shadow and light body.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
(async()=>{
  const vendor=fs.readFileSync(path.join(root,'vendor/three.module.min.js'),'utf8');
  assert(vendor.includes('function bl(t,e,n,i){const r=t.getContext()'));
  assert(vendor.includes('function Al(t,e,n,i,r,s,a){'));
  const THREE=await import('data:text/javascript;base64,'+Buffer.from(vendor+'\nexport {bl as TestProgram,Al as TestPrograms};').toString('base64'));
  const context=vm.createContext({Float32Array,Int32Array,Uint16Array,Uint32Array});
  vm.runInContext(fs.readFileSync(path.join(root,'room-lighting.js'),'utf8'),context);
  const rooms=[{id:'a',polygon:[[0,0],[4,0],[4,4],[0,4]]},{id:'b',polygon:[[10,0],[14,0],[14,4],[10,4]]}];
  function build(capacity,packed=true,kind='lambert',limit=1024){
    const lighting=context.createRoomLighting(THREE,rooms,capacity,[],{packed,maxFragmentUniforms:limit});
    const material=kind==='lambert'?new THREE.MeshLambertMaterial():new THREE.MeshStandardMaterial();
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(),material),group=new THREE.Group();group.add(mesh);
    lighting.attach(group,true);
    const shader={uniforms:{},vertexShader:THREE.ShaderLib[kind].vertexShader,fragmentShader:THREE.ShaderLib[kind].fragmentShader};
    material.onBeforeCompile(shader);return {lighting,material,mesh,shader};
  }
  const start='#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )';
  const end='#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )';
  const point=s=>s.slice(s.indexOf(start),s.indexOf(end));
  const blockStart='{\n      int homeRun = 0;';
  function block(s){
    const a=s.indexOf(blockStart);assert(a>=0,'actual emitted state-machine block exists');
    let depth=1,b=a+1;
    for(;depth;b++){assert(b<s.length);if(s[b]==='{')depth++;if(s[b]==='}')depth--;}
    return s.slice(a,b);
  }
  const call='if (directLight.visible) RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
  const body=s=>s.slice(s.lastIndexOf('pointLight = pointLights[ i ];'),s.lastIndexOf(call)+call.length);
  let realProgramCases=0;
  const submitted=[];
  const gl={VERTEX_SHADER:35633,FRAGMENT_SHADER:35632,createProgram:()=>({}),createShader:type=>({type}),
    shaderSource(shader,text){submitted.push({type:shader.type,text});},compileShader(){},attachShader(){},linkProgram(){},bindAttribLocation(){}};
  const renderer={getContext:()=>gl,getRenderTarget:()=>null,outputColorSpace:THREE.SRGBColorSpace,toneMapping:THREE.ACESFilmicToneMapping,
    shadowMap:{enabled:true,type:THREE.BasicShadowMap},debug:{checkShaderErrors:false}};
  const capabilities={precision:'highp',getMaxPrecision:x=>x,vertexTextures:true,logarithmicDepthBuffer:false,reverseDepthBuffer:false};
  const bindings={releaseStatesOfProgram(){}};
  const programs=new THREE.TestPrograms(renderer,{get:()=>null},{get:()=>null},{has:()=>false},capabilities,bindings,{numPlanes:0,numIntersection:0});
  const scene=new THREE.Scene();
  const lights={directional:[{}],point:[],spot:[{}],spotLightMap:[],rectArea:[],hemi:[{}],directionalShadowMap:[{}],pointShadowMap:[],spotShadowMap:[],numSpotLightShadowsWithMaps:0,numLightProbes:0};
  let control;
  for(const capacity of [18,72])for(const kind of ['lambert','standard']){
    const packed=build(capacity,true,kind),literal=build(capacity,false,kind),fallback=build(capacity,true,kind,1);
    assert.equal(fallback.shader.fragmentShader,literal.shader.fragmentShader,'low-budget literal fallback is byte-identical');
    const actual=point(packed.shader.fragmentShader),original=point(literal.shader.fragmentShader);
    const prefix=s=>s.slice(0,s.indexOf('#pragma unroll_loop_end')+'#pragma unroll_loop_end'.length);
    assert.equal(prefix(actual).replace(/homePointTransmission\(homePointRooms\[([^\]]+)\]\)/g,'homeRoomTransmissions[homePointRooms[$1]]'),prefix(original));
    assert.equal(body(actual),body(original),'entire unshadowed body stays byte-identical, including visibility tests and addition order');
    assert.equal(packed.shader.fragmentShader.slice(packed.shader.fragmentShader.indexOf(end)),literal.shader.fragmentShader.slice(literal.shader.fragmentShader.indexOf(end)),
      'all later light families and material output remain unchanged');
    const flat=block(actual);assert.equal((flat.match(/\bwhile\s*\(/g)||[]).length,1);assert.doesNotMatch(flat,/\bfor\s*\(/);
    assert(!flat.includes('pointShadowMap['),'shadow samplers are confined to the original literal prefix');
    const replaced=flat.replace(body(flat),'visit(i,homeRunTransmission);').replace(/\b(?:int|float|ivec4)\b/g,'let');
    if(control)assert.equal(replaced,control);else control=replaced;
    for(const shadows of [0,1,2,8]){
      lights.point=Array.from({length:capacity},()=>({}));lights.pointShadowMap=Array.from({length:shadows},()=>({}));
      const params=programs.getParameters(packed.material,lights,[{}],scene,packed.mesh);
      params.vertexShader=packed.shader.vertexShader;params.fragmentShader=packed.shader.fragmentShader;
      submitted.length=0;new THREE.TestProgram(renderer,programs.getProgramCacheKey(params),params,bindings);
      const expanded=submitted.find(s=>s.type===35632).text;
      assert.doesNotMatch(expanded,/#pragma unroll_loop_(?:start|end)|UNROLLED_LOOP_INDEX|#include\s*</);
      const expandedBlock=block(expanded);
      assert.match(expandedBlock,/^\{\s+int homeRun = 0;\s+int i = 0;/,'loop index has its own scope after literal unrolling');
      assert(expandedBlock.includes(`i = max(homeRunData.x, ${shadows});`));
      assert(expandedBlock.includes(`homeRunEnd = min(homeRunData.y, ${capacity});`));
      // Compare complete post-expansion shadow prefix and later light families
      // with the original nested packed control reconstructed from literal GLSL.
      const oldPacked=original.replace('int homeRunStart = 0;','')
        .replace('int homeRunEnd = min(homeLightRunEnds[homeRun], NUM_POINT_LIGHTS);','ivec4 homeRunData = homeLightRuns[homeRun];\n      int homeRunEnd = min(homeRunData.y, NUM_POINT_LIGHTS);')
        .replace('max(homeRunStart, NUM_POINT_LIGHT_SHADOWS)','max(homeRunData.x, NUM_POINT_LIGHT_SHADOWS)')
        .replace(/homeRoomTransmissions\[homePointRooms\[([^\]]+)\]\]/g,'homePointTransmission(homePointRooms[$1])')
        .replace('homePointTransmission(homePointRooms[homeFirstLight])','homePointTransmission(homeRunData.z)')
        .replace('homeRunStart = homeRunEnd;','');
      const oldParams={...params,fragmentShader:params.fragmentShader.replace(actual,oldPacked+'}\n')};
      submitted.length=0;new THREE.TestProgram(renderer,'reference',oldParams,bindings);
      const oldExpanded=submitted.find(s=>s.type===35632).text;
      const shadowEnd=expanded.indexOf(blockStart),oldShadowEnd=oldExpanded.indexOf('for ( int homeRun = 0;');
      assert.equal(expanded.slice(expanded.indexOf(`#if ( ${capacity} > 0 ) && defined( RE_Direct )`),shadowEnd).trim(),oldExpanded.slice(oldExpanded.indexOf(`#if ( ${capacity} > 0 ) && defined( RE_Direct )`),oldShadowEnd).trim());
      // Later source identity was checked before expansion; the generated loop
      // is explicitly closed before its enclosing point guard and spot branch.
      assert.match(expanded.slice(expanded.indexOf(blockStart)+expandedBlock.length),/^\s*#endif\s*}\s*#if \( 1 > 0 \)/);
      realProgramCases++;
    }
  }
  const execute=Function('homeLightRuns','homeLightRunCount','NUM_POINT_LIGHTS','NUM_POINT_LIGHT_SHADOWS','homePointTransmission','visit','min','max',control);
  let cases=0,visits=0,transmissions=0;
  function check(records,capacity,shadows,values,count=records.length,runner=execute){
    const expected=[],actual=[];
    const lookup=(events,room)=>{const value=values[((room%values.length)+values.length)%values.length];events.push(['transmission',room,value]);return value;};
    // Independent nested reference: each selected record is clipped then read
    // exactly once. It deliberately does not share the state machine's cursor.
    for(let run=0;run<count;run++){
      const r=records[run],first=Math.max(r.x,shadows),last=Math.min(r.y,capacity);
      if(first<last){const t=lookup(expected,r.z);if(t!==0)for(let i=first;i<last;i++)expected.push(['light',i,t]);}
    }
    const checked=new Proxy(records,{get(target,key){assert(/^\d+$/.test(key)&&+key<count,'no inactive or out-of-range record read');return target[key];}});
    runner(checked,count,capacity,shadows,room=>lookup(actual,room),(i,t)=>actual.push(['light',i,t]),Math.min,Math.max);
    assert.deepEqual(actual,expected);
    // Include order-sensitive accumulated values, signed zero and NaN.
    const sum=events=>events.reduce((s,e)=>e[0]==='light'?s+e[2]*(e[1]+.25):s,0);
    assert(Object.is(sum(actual),sum(expected)));
    transmissions+=actual.filter(e=>e[0]==='transmission').length;visits+=actual.length;cases++;
  }
  const mutate=(from,to)=>{
    assert(control.includes(from));
    return Function('homeLightRuns','homeLightRunCount','NUM_POINT_LIGHTS','NUM_POINT_LIGHT_SHADOWS','homePointTransmission','visit','min','max',control.replace(from,to));
  };
  assert.throws(()=>check([{x:0,y:2,z:0}],18,0,[NaN],1,mutate('homeRunTransmission == 0.0','!(homeRunTransmission > 0.0)')),
    'the oracle rejects treating NaN/negative transmission as zero');
  assert.throws(()=>check([{x:0,y:3,z:0}],18,2,[1],1,mutate('max(homeRunData.x, NUM_POINT_LIGHT_SHADOWS)','homeRunData.x')),
    'the oracle rejects revisiting the shadow prefix');
  assert.throws(()=>check([{x:0,y:2,z:0},{x:2,y:4,z:1}],18,0,[1,-1],2,mutate('homePointTransmission(homeRunData.z)','homePointTransmission(0)')),
    'the oracle rejects reusing transmission from another run');
  assert.throws(()=>check([{x:0,y:1,z:0},{x:1,y:2,z:0}],18,0,[1],2,mutate('homeRun++;','homeRun += 2;')),
    'the oracle rejects skipped run records');
  const vals=[0,-0,1,-1,Number.MIN_VALUE,NaN,Infinity,-Infinity];
  for(const capacity of [18,72])for(const shadows of [0,1,2,8]){
    check([],capacity,shadows,vals);check([{x:0,y:capacity,z:0}],capacity,shadows,vals,0);
    check([],capacity,shadows,vals,-1);
    // Every clipped integer start/end pair, including empty/reversed ranges.
    for(let x=-1;x<=capacity+1;x++)for(let y=-1;y<=capacity+1;y++)for(let v=0;v<vals.length;v++)
      check([{x,y,z:v,w:0}],capacity,shadows,vals);
    // Every partition and selected subset of six lights: repeated/split rooms,
    // filtered gaps, consecutive zero runs, and stale inactive array tails.
    for(let split=0;split<32;split++){
      const runs=[];let x=0;
      for(let y=1;y<=6;y++)if(y===6||(split&(1<<(y-1)))){runs.push({x,y,z:runs.length%3,w:0});x=y;}
      for(let selected=0;selected<(1<<runs.length);selected++){
        const chosen=runs.filter((_,i)=>selected&(1<<i));
        for(const values of [vals,[1],[0,0,NaN],[-1,Infinity,-Infinity]]){
          check(chosen,capacity,shadows,values);
          check([...chosen,{x:0,y:capacity,z:999,w:0}],capacity,shadows,values,chosen.length);
        }
      }
    }
    // Full-capacity singleton, same-room and varying-length multi-run cases.
    for(const step of [1,2,5,capacity])for(const values of [vals,[1],[0,0,NaN]]){
      const records=[];for(let x=0;x<capacity;x+=step)records.push({x,y:Math.min(capacity,x+step),z:records.length%values.length,w:0});
      check(records,capacity,shadows,values);
    }
  }
  console.log(`flat packed state machine: ${cases} exact call-sequence cases, ${transmissions} transmission calls, ${visits} events; ${realProgramCases} pinned Three GLSL expansions PASS`);
})().catch(error=>{console.error(String(error.stack).replace(/data:text\/javascript;base64,[^\s)]+/g,'[pinned Three module]'));process.exitCode=1;});
