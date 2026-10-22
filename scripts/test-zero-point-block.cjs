// Actual-source CPU contract. Pixel/performance acceptance remains a browser check.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'room-lighting.js'), 'utf8');
const home = fs.readFileSync(path.join(root, 'home-view.js'), 'utf8');
const code = vm.createContext({});
vm.runInContext(source, code);

(async () => {
  const THREE = await import('data:text/javascript;base64,' + fs.readFileSync(path.join(root, 'vendor/three.module.min.js')).toString('base64'));
  const rooms = [{id:'A', polygon:[[0,0],[4,0],[4,4],[0,4]]},
    {id:'B', polygon:[[4,0],[8,0],[8,4],[4,4]]}];
  const windows = [{room:'A', a:[0,1], b:[0,3]}];
  function build(options = {packed:true, maxFragmentUniforms:1024}) {
    const lighting = code.createRoomLighting(THREE, rooms, 6, windows, options);
    const group = new THREE.Group();
    for (let i=0; i<2; i++) group.add(new THREE.Mesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshLambertMaterial()));
    const compile = enabled => {
      lighting.attach(group, enabled, {staticGeometry:true});
      return group.children.map(mesh => {
        const shader = {uniforms:{}, vertexShader:THREE.ShaderLib.lambert.vertexShader, fragmentShader:THREE.ShaderLib.lambert.fragmentShader};
        mesh.material.onBeforeCompile(shader); return shader;
      });
    };
    const shaders = compile(true);
    return {lighting, group, compile, shader:shaders[0], shaders};
  }
  const state = build(), flag = state.shader.uniforms.homePointLightingRequired;
  assert.equal(flag.value, true, 'Uninitialized/replacement controllers fail open until a current update');
  assert.equal(state.shaders[1].uniforms.homePointLightingRequired, flag, 'Every material shares the same current guard');
  const shader = state.shader.fragmentShader;
  const guarded = shader.match(/if \(homePointLightingRequired\) \{\n([\s\S]*?)\n\}\n(?=#if \( NUM_SPOT_LIGHTS)/);
  assert(guarded, 'The runtime guard encloses exactly the complete original point block');
  assert.match(guarded[1], /^#if \( NUM_POINT_LIGHTS > 0 \) && defined\( RE_Direct \)/);
  assert.match(guarded[1], /i < NUM_POINT_LIGHT_SHADOWS/);
  assert.match(guarded[1], /homeRun < homeLightRunCount/);
  assert.match(guarded[1], /getPointLightInfo\( pointLight, geometryPosition, directLight \)/);
  assert.doesNotMatch(guarded[1], /NUM_SPOT_LIGHTS|NUM_DIR_LIGHTS|homeDaylightIrradiance\(\)/);
  assert.equal((shader.match(/if \(homePointLightingRequired\)/g)||[]).length, 1);
  const executeGuard = new Function('homePointLightingRequired','visit', guarded[0].replace(guarded[1], 'visit();'));
  for (const enabled of [false,true]) {
    let calls=0; executeGuard(enabled,()=>calls++); assert.equal(calls, Number(enabled));
  }
  const makePoint = (room, shadow=false) => {
    const light = new THREE.PointLight(0xffffff,0,7,2); light.castShadow=shadow;
    light.position.set(1,2,3); light.shadow.mapSize.set(128,128);
    return {item:{room}, light, position:light.position, marker:{style:{}}};
  };
  const points = [makePoint('A'),makePoint('B',true),makePoint('A',true),makePoint('B')];
  const parent = new THREE.Group(); points.forEach(p=>parent.add(p.light));
  const identity = points.map(p=>({light:p.light,shadow:p.light.shadow,castShadow:p.light.castShadow,map:p.light.shadow.mapSize.clone()}));
  const key = state.group.children[0].material.customProgramCacheKey();
  const version = state.group.children[0].material.version;
  const check = expected => {
    state.lighting.update(points); assert.equal(flag.value, expected);
    assert.equal(state.group.children[0].material.customProgramCacheKey(),key,'Light state does not select another program family');
    assert.equal(state.group.children[0].material.version,version,'Light state does not invalidate programs');
    identity.forEach((prior,i)=>{
      assert.equal(points[i].light,prior.light); assert.equal(points[i].light.shadow,prior.shadow);
      assert.equal(points[i].light.castShadow,prior.castShadow); assert(points[i].light.shadow.mapSize.equals(prior.map));
    });
  };
  check(false);
  assert.deepEqual(Array.from(state.shader.uniforms.homePointRooms.value),[2,1,1,2,0,0], 'Shadow-first order and all zero-light slots remain');
  let traversed=0; parent.traverseVisible(o=>{if(o.isPointLight)traversed++;}); assert.equal(traversed,4);
  let cases=0;
  for(const intensity of [0,-0,1,1e-30,-1,NaN,Infinity,-Infinity,undefined]) {
    points[0].light.intensity=intensity; check(intensity!==0); cases++;
  }
  points[0].light.intensity=0;
  for(const field of ['r','g','b']) for(const value of [NaN,Infinity,-Infinity,undefined]) {
    const saved=points[0].light.color[field]; points[0].light.color[field]=value;
    check(true); points[0].light.color[field]=saved; cases++;
  }
  for(const field of ['x','y','z']) for(const value of [NaN,Infinity,-Infinity]) {
    const saved=points[0].light.position[field]; points[0].light.position[field]=value;
    check(true); points[0].light.position[field]=saved; cases++;
  }
  for(const field of ['distance','decay']) for(const value of [NaN,Infinity,-Infinity,-1,undefined]) {
    const saved=points[0].light[field]; points[0].light[field]=value;
    check(true); points[0].light[field]=saved; cases++;
  }
  points[0].light.color.setRGB(0,0,0); points[0].light.intensity=2; check(true);
  points[0].light.intensity=0; check(false);
  points[0].item.room='missing'; check(true);
  // A roomless zero light with a malformed parent must retain Three's original path.
  parent.matrixWorld.elements[12]=NaN; check(true); parent.matrixWorld.identity();
  points[0].item.room='A'; check(false);
  points[0].light.visible=false; points[0].light.intensity=NaN; check(false);
  points[0].light.visible=true; check(true); points[0].light.intensity=0;
  state.lighting.update([]); assert.equal(flag.value,false,'No visible owned lights is an empty point contribution');
  check(false);
  // The shortcut is justified independently by the unchanged known-room gate:
  // all room masks are zero, so no point-position/attenuation operation is reached.
  const helper = shader.match(/float homePointTransmission\(int room\) \{([\s\S]*?)\n    \}/)[1];
  const evaluate = new Function('room','homeLitRooms','homeRoomNearby','homeRoomDistance','homeRoomTransmission',helper.replace(/\bint index\b/,'const index'));
  const forbidden=()=>assert.fail('An unlit known room must not evaluate spatial/attenuation work');
  for(const room of [1,2]) assert.equal(evaluate(room,state.shader.uniforms.homeLitRooms.value,forbidden,forbidden,forbidden),0);
  assert.equal(evaluate(0,state.shader.uniforms.homeLitRooms.value,forbidden,forbidden,forbidden),1,'Unknown rooms cannot use the shortcut proof');
  state.lighting.environment(.6,[.25]); check(false);
  assert.equal(state.shader.uniforms.homeDaylight.value,.6);
  assert.equal(state.shader.uniforms.homeWindowTransmission.value[0],.25,'Daylight/windows are outside the point guard');

  const editor = state.compile(false)[0]; assert.doesNotMatch(editor.fragmentShader,/homePointLightingRequired/);
  const restored = state.compile(true)[0]; assert.equal(restored.uniforms.homePointLightingRequired,flag);
  points[0].light.intensity=1; state.lighting.update(points); assert.equal(flag.value,true);
  const replacement=build(); assert.equal(replacement.shader.uniforms.homePointLightingRequired.value,true);
  replacement.lighting.update(points); assert.equal(replacement.shader.uniforms.homePointLightingRequired.value,true);
  points[0].light.intensity=0; replacement.lighting.update(points); assert.equal(replacement.shader.uniforms.homePointLightingRequired.value,false);
  const exact=state.lighting.geometryUniformVectors;
  assert.equal(build({packed:true,maxFragmentUniforms:exact}).lighting.geometryMode,'packed');
  const fallback=build({packed:true,maxFragmentUniforms:exact-1});
  assert.equal(fallback.lighting.geometryMode,'literal');
  assert.equal(fallback.shader.fragmentShader,build({}).shader.fragmentShader);
  assert(!('homePointLightingRequired' in fallback.shader.uniforms));

  // Execute both actual Home draw functions. The signal path must update a
  // just-mutated light before drawing without waiting for a scheduled full frame.
  const captures=[], rect={width:1200,height:700}; let blocked=false, statusIntensity=0;
  const draw = vm.createContext({THREE,active:true,renderer:{},camera:new THREE.OrthographicCamera(-1,1,1,-1,.1,150),
    cameraFit:undefined,selected:'',zoom:1,panX:0,panY:0,homeRotation:0,homeTilt:0,
    planRadius:10,planBounds:true,xm:x=>x,zm:z=>z,
    model:{rooms,ceiling_height_m:3},points,labels:[],roomLighting:state.lighting,
    projectedPosition:new THREE.Vector3(),projectedForward:new THREE.Vector3(),
    lowerFloorContext:null,showLowerFloor:true,assumedZones:null,presenceView:null,vacuumView:null,signalZone:'',renderCount:0,
    $:id=>id==='homeStage'?{getBoundingClientRect:()=>rect}:{},isCover:()=>false,
    positionMediaPreviews(){},refreshSignalStatus(){points[0].light.intensity=statusIntensity;},
    drawScene(){if(!blocked)captures.push(flag.value);}
  });
  vm.runInContext(home.slice(home.indexOf('  function drawSignalFrame('),home.indexOf('  function clearTrail(')),draw);
  statusIntensity=1; draw.drawSignalFrame(false); assert.equal(captures.length,0);
  draw.drawSignalFrame(true); assert.equal(captures.at(-1),true);
  statusIntensity=0; draw.drawSignalFrame(true); assert.equal(captures.at(-1),false);
  statusIntensity=2; draw.render(); assert.equal(captures.at(-1),true,'Full render samples after the last synchronous status refresh');
  assert.equal(draw.cameraFit.rotation,0,'The draw-boundary fixture initializes the real Home camera fit');
  assert.equal(draw.cameraFit.tilt,0);
  blocked=true; statusIntensity=0; draw.render();
  const before=captures.length; draw.active=false; draw.drawSignalFrame(true); assert.equal(captures.length,before);
  draw.active=true; blocked=false; statusIntensity=3; draw.render(); assert.equal(captures.at(-1),true,'Resume/recovery gets current light values');
  draw.roomLighting=replacement.lighting; statusIntensity=0;
  draw.drawScene=()=>captures.push(replacement.shader.uniforms.homePointLightingRequired.value);
  draw.drawSignalFrame(true); assert.equal(captures.at(-1),false,'A replacement controller is refreshed at the same draw boundary');
  for(const value of [state,replacement,fallback]) value.group.traverse(mesh=>{mesh.material?.dispose();mesh.geometry?.dispose();});
  console.log(JSON.stringify({status:'passed',numericInputCases:cases,drawBoundaryCaptures:captures.length,
    scope:'One shared runtime guard; stable light/shadow/program identity; malformed/roomless fallback; signal/full/recovery/replacement draws; explicit uniform boundary.'}));
})().catch(error=>{console.error(error);process.exitCode=1;});
