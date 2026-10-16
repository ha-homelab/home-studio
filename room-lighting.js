const wallSheenPhase = {value: 0};

// Advance only during nearby, already requested frames. Idle/hidden time never
// accumulates and this helper never schedules a frame. Capability checks are
// conservative hints, not a hardware benchmark; expensive CPU frames also stop it.
function createWallSheenMotion(host = globalThis) {
  const nav = host.navigator || {};
  const reduced = host.matchMedia?.('(prefers-reduced-motion: reduce)');
  const coarse = host.matchMedia?.('(any-pointer: coarse)');
  const limited = !reduced || !coarse || !nav.hardwareConcurrency || nav.hardwareConcurrency <= 4 ||
    (nav.deviceMemory !== undefined && nav.deviceMemory <= 4) || nav.userAgentData?.mobile ||
    /Android|iPhone|iPad|iPod/i.test(nav.userAgent || '');
  let previous = null, started = null, slowFrames = 0, stopped = false;
  return {
    beforeRender() {
      if (limited || stopped || reduced.matches || coarse.matches || host.document?.hidden || nav.connection?.saveData) {
        previous = started = null;
        return;
      }
      const now = host.performance.now();
      const elapsed = previous === null ? 0 : now - previous;
      if (elapsed > 0 && elapsed <= 100) {
        // A 90-second active cycle, with no jump on sparse updates or resume.
        wallSheenPhase.value = (wallSheenPhase.value + Math.min(elapsed, 32) * Math.PI * 2 / 90000) % (Math.PI * 2);
      }
      previous = started = now;
    },
    afterRender() {
      if (started === null) return;
      slowFrames = host.performance.now() - started > 32 ? slowFrames + 1 : 0;
      if (slowFrames >= 3) stopped = true;
      started = null;
    }
  };
}

// Compute the view-dependent palette per vertex; no texture or extra pass.
function applyWallSheen(shader) {
  shader.uniforms.wallSheenPhase = wallSheenPhase;
  shader.vertexShader = 'uniform float wallSheenPhase;\nvarying vec3 wallSheen;\n' + shader.vertexShader.replace(
    '#include <project_vertex>', `#include <project_vertex>
    vec3 wallView = isOrthographic ? vec3(0.0,0.0,1.0) : normalize(-mvPosition.xyz);
    float grazing = 1.0-abs(dot(normalize(transformedNormal),wallView));
    float band = 0.5+0.5*sin(dot(position,vec3(0.35,0.65,0.25))+wallSheenPhase);
    float tint = clamp(0.75*grazing+0.25*band,0.0,1.0);
    wallSheen = mix(vec3(0.10,0.72,0.56),vec3(0.15,0.40,0.85),smoothstep(0.0,0.65,tint));
    wallSheen = mix(wallSheen,vec3(0.55,0.36,0.75),smoothstep(0.65,1.0,tint));
    wallSheen = mix(wallSheen,vec3(0.65,0.95,1.0),0.4*clamp(grazing*grazing,0.0,1.0));`
  );
  shader.fragmentShader = 'varying vec3 wallSheen;\n' + shader.fragmentShader.replace(
    '#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb,wallSheen,0.48);'
  ).replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += wallSheen*0.16;');
}

// Keep applyWallSheen compatible with Three's (shader, renderer) callback.
// Only this internal helper accepts the private per-material switch.
function applySharedWallSheen(shader, enabled) {
  applyWallSheen(shader);
  shader.uniforms.homeWallSheenEnabled = enabled;
  shader.fragmentShader = 'uniform bool homeWallSheenEnabled;\n' + shader.fragmentShader
    .replace('diffuseColor.rgb = mix(diffuseColor.rgb,wallSheen,0.48);',
      'if (homeWallSheenEnabled) diffuseColor.rgb = mix(diffuseColor.rgb,wallSheen,0.48);')
    .replace('totalEmissiveRadiance += wallSheen*0.16;',
      'if (homeWallSheenEnabled) totalEmissiveRadiance += wallSheen*0.16;');
}

// Two private materials retain the original glass passes while sharing the
// DoubleSide program. Back-side normals must change in the vertex shader too:
// shadow normal bias consumes transformedNormal before fragment lighting.
const staticGlassFacing = new WeakMap(), staticGlassPasses = new Set();
const bothFaces = {value:0};
function applyStaticFacing(THREE, shader, facing) {
  shader.uniforms.homeFaceMode = facing;
  shader.vertexShader = 'uniform int homeFaceMode;\n' + shader.vertexShader.replace(
    '#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>\nif (homeFaceMode < 0) transformedNormal = -transformedNormal;');
  shader.fragmentShader = 'uniform int homeFaceMode;\n' + shader.fragmentShader
    .replace('void main() {', 'void main() {\nif ((homeFaceMode < 0 && gl_FrontFacing) || (homeFaceMode > 0 && !gl_FrontFacing)) discard;')
    .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace(
      'normal *= faceDirection;', 'if (homeFaceMode == 0) normal *= faceDirection;'));
}

function createStaticGlassPasses(THREE, mesh, diffuse) {
  const original = mesh.material, geometry = mesh.geometry;
  if (!diffuse || mesh.userData.category !== 'windows' || !mesh.isMesh || mesh.isSkinnedMesh || mesh.isInstancedMesh || mesh.isBatchedMesh ||
      mesh.parent || mesh.children.length || mesh.castShadow || mesh.boundingSphere !== undefined ||
      !original?.isMeshLambertMaterial || !original.transparent || original.side !== THREE.DoubleSide || original.forceSinglePass !== false ||
      original.blending !== THREE.NormalBlending || original.premultipliedAlpha || original.stencilWrite ||
      original.flatShading || original.wireframe || original.vertexColors || original.alphaTest !== 0 || original.alphaHash || original.alphaToCoverage ||
      (original.defines && Object.keys(original.defines).length) ||
      original.clippingPlanes?.length !== 1 || original.clipShadows ||
      Object.keys(original).some(key => (key === 'map' || key.endsWith('Map')) && original[key]) ||
      original.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile || original.onBeforeRender !== THREE.Material.prototype.onBeforeRender ||
      original.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey ||
      ['onBeforeRender','onAfterRender','onBeforeShadow','onAfterShadow'].some(key => mesh[key] !== THREE.Object3D.prototype[key]) ||
      !geometry?.isBufferGeometry || geometry.isInstancedBufferGeometry || geometry.groups.length ||
      Object.keys(geometry.morphAttributes).length ||
      Object.keys(geometry.attributes).some(key => !['position','normal'].includes(key)) ||
      geometry.drawRange.start !== 0 || geometry.drawRange.count !== Infinity) return null;
  const position = geometry.attributes.position, normal = geometry.attributes.normal, index = geometry.index;
  if (!position || !normal || !position.count || position.itemSize !== 3 || normal.itemSize !== 3 || position.count !== normal.count ||
      position.isInterleavedBufferAttribute || normal.isInterleavedBufferAttribute || position.normalized || normal.normalized ||
      !(position.array instanceof Float32Array) || !(normal.array instanceof Float32Array) ||
      !index || !index.count || index.itemSize !== 1 || index.normalized || index.count % 3 ||
      ![Uint16Array,Uint32Array].some(type => index.array instanceof type) ||
      !position.array.every(Number.isFinite) || !normal.array.every(Number.isFinite) || !index.array.every(value => value < position.count)) return null;
  geometry.computeBoundingSphere();
  if (!Number.isFinite(geometry.boundingSphere.radius) || !geometry.boundingSphere.center.toArray().every(Number.isFinite)) return null;
  const materials = [-1,1].map(value => {
    const material = original.clone(), facing = {value};
    // Keep the same live cutaway plane, not Material.copy's cloned plane.
    material.clippingPlanes = original.clippingPlanes;
    material.forceSinglePass = true;
    staticGlassFacing.set(material, facing);
    material.onBeforeCompile = shader => applyStaticFacing(THREE, shader, facing);
    material.customProgramCacheKey = () => 'home-glass-facing-v1';
    return material;
  });
  // Allocate before any later factory mesh so equal-depth passes stay adjacent.
  const front = new THREE.Mesh(geometry, materials[1]).copy(mesh, false);
  front.material = materials[1]; front.userData = mesh.userData;
  mesh.material = materials[0];
  mesh.boundingSphere = geometry.boundingSphere.clone(); front.boundingSphere = geometry.boundingSphere.clone();
  let disposed = false;
  const passes = {front, releaseGPU() {if (!disposed) materials.forEach(material => material.dispose());}, dispose() {
    if (disposed) return;
    passes.releaseGPU(); disposed = true;
    front.removeFromParent(); mesh.material = original; delete mesh.boundingSphere;
    materials.forEach(material => staticGlassFacing.delete(material)); staticGlassPasses.delete(passes);
  }};
  staticGlassPasses.add(passes);
  return passes;
}
function releaseStaticGlassPasses() {for (const passes of staticGlassPasses) passes.releaseGPU();}
function disposeStaticGlassPasses() {for (const passes of staticGlassPasses) passes.dispose();}

// Only the viewer's plain fallback-box factory registers these meshes. Their
// pose changes through an inventory rebuild; live color/emissive updates remain
// on the same material. No GPU resource or geometry clone is introduced.
const fallbackBoxMaterials = new WeakMap();
function registerFallbackBoxProgram(THREE, mesh, diffuse) {
  const material = mesh.material;
  if (!diffuse || !mesh.isMesh || mesh.isSkinnedMesh || mesh.isInstancedMesh || mesh.isBatchedMesh ||
      mesh.parent || mesh.children.length || !(mesh.geometry instanceof THREE.BoxGeometry) ||
      !material?.isMeshLambertMaterial || mesh.raycast !== THREE.Mesh.prototype.raycast ||
      material.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile ||
      material.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey) return;
  const state = {mesh,geometry:mesh.geometry,original:{side:material.side,shadowSide:material.shadowSide,
    clippingPlanes:material.clippingPlanes,clipShadows:material.clipShadows,blending:material.blending},
    facing:{value:1},planes:[new THREE.Plane(new THREE.Vector3(0,-1,0),4)],raycast:null,active:false,rejected:false};
  fallbackBoxMaterials.set(material,state);
  state.raycast = function(raycaster, intersections) {
    if (!state.active || this.material !== material || material.side!==THREE.DoubleSide) return THREE.Mesh.prototype.raycast.call(this,raycaster,intersections);
    // GPU face discard replaces culling, but CPU picking must retain FrontSide.
    const side=material.side;
    try {material.side=THREE.FrontSide;return THREE.Mesh.prototype.raycast.call(this,raycaster,intersections);}
    finally {material.side=side;}
  };
}
function prepareFallbackBoxProgram(THREE, mesh, packed, exclusive) {
  const material=mesh.material,state=fallbackBoxMaterials.get(material);
  if (!state) return null;
  if (state.active) {
    const assigned={side:THREE.DoubleSide,shadowSide:THREE.BackSide,clippingPlanes:state.planes,
      clipShadows:false,blending:THREE.NoBlending};
    for (const key of Object.keys(assigned)) {
      if (material[key]===assigned[key]) material[key]=state.original[key];
      else state.rejected=true; // Never overwrite a non-owned external edit.
    }
    if(state.mesh.raycast===state.raycast) state.mesh.raycast=THREE.Mesh.prototype.raycast;
    else state.rejected=true;
    state.active=false;
  }
  if (mesh!==state.mesh || !exclusive) state.rejected=true;
  if (!packed || state.rejected || mesh.geometry!==state.geometry || mesh.raycast!==THREE.Mesh.prototype.raycast ||
      material.side!==THREE.FrontSide || material.shadowSide!==null || material.clippingPlanes?.length || material.clipShadows ||
      material.blending!==THREE.NormalBlending || material.transparent || material.opacity!==1 ||
      material.flatShading || material.wireframe || material.vertexColors || material.stencilWrite ||
      material.alphaTest!==0 || material.alphaHash || material.alphaToCoverage || material.premultipliedAlpha ||
      (material.defines && Object.keys(material.defines).length) ||
      Object.keys(material).some(key=>(key==='map'||key.endsWith('Map'))&&material[key]) ||
      mesh.geometry.getAttribute('color') || Object.keys(mesh.geometry.morphAttributes).length) return null;
  const position=mesh.geometry.getAttribute('position'),normal=mesh.geometry.getAttribute('normal');
  if(!position || !normal || position.itemSize!==3 || normal.itemSize!==3 || position.count!==normal.count || !position.count) return null;
  mesh.updateWorldMatrix(true,false);
  const point=new THREE.Vector3();
  let extent=1;
  for(let i=0;i<position.count;i++) {
    point.fromBufferAttribute(position,i).applyMatrix4(mesh.matrixWorld);
    for(const value of point.toArray()) {
      if(!Number.isFinite(value)||!Number.isFinite(Math.fround(value))) return null;
      extent=Math.max(extent,Math.abs(value));
    }
  }
  const far=extent*4;
  if(!Number.isFinite(Math.fround(far))) return null;
  state.planes[0].constant=far;
  material.side=THREE.DoubleSide;material.shadowSide=THREE.BackSide;
  material.clippingPlanes=state.planes;material.clipShadows=false;
  mesh.raycast=state.raycast;state.active=true;
  return state.facing;
}

// Only immutable packed-Lambert walls and alpha-free floors/frames share this
// program. NoBlending is the same disabled GPU blend state as opaque normal
// blending, but omits Three's redundant OPAQUE shader define. Restore the
// original setting if a later attachment is dynamic, literal or unsupported.
const sharedWallMaterials = new WeakMap();
function prepareSharedWallProgram(THREE, mesh, role) {
  const material = mesh.material;
  let state = sharedWallMaterials.get(material);
  if (state?.blending !== undefined) {
    if (material.blending === THREE.NoBlending) material.blending = state.blending;
    delete state.blending;
  }
  if (!role || !material.isMeshLambertMaterial || material.side !== THREE.DoubleSide ||
      material.blending !== THREE.NormalBlending || material.clippingPlanes?.length !== 1 ||
      material.clipShadows || material.map || material.alphaMap || material.vertexColors ||
      mesh.geometry?.getAttribute?.('color') ||
      material.alphaTest !== 0 || material.alphaHash || material.alphaToCoverage || material.premultipliedAlpha) return false;
  if (role === 'wall' || role === 'glass' ? material.transparent !== true : material.transparent || material.opacity !== 1) return false;
  if (!state) {
    state = {enabled:{value:false}};
    sharedWallMaterials.set(material, state);
  }
  // Cached programs retain this same uniform object across reattachments.
  state.enabled.value = role === 'wall';
  if (role === 'opaque') {
    state.blending = material.blending;
    material.blending = THREE.NoBlending;
  }
  return state.enabled;
}

// Point shadows use a 4-by-2 atlas, not one mapSize-sized texture. Keep the
// combined atlas allocation bounded as the number of linked fixtures grows.
function pointShadowMapSize(lightCount, maxTextureSize = 4096, maxFaceSize = 512) {
  const maxFace = Math.max(1, Math.min(maxFaceSize, Math.floor(maxTextureSize / 4)));
  let size = 2 ** Math.floor(Math.log2(maxFace));
  const pixelBudget = 8 * 1024 * 1024;
  while (size > 1 && Math.max(1, lightCount) * 8 * size * size > pixelBudget) size /= 2;
  return size;
}

// Configure newly built lights once. Reserve fragment texture units for the
// directional shadow and material maps; extra fixtures still illuminate rooms.
function configurePointShadows(lights, capabilities = {}, profile = {}) {
  const maxTextures = Number.isFinite(capabilities.maxTextures) ? capabilities.maxTextures : 8;
  const shadowCount = Math.max(0, Math.min(lights.length, profile.pointShadows ?? 8, Math.floor(maxTextures) - 4));
  const size = pointShadowMapSize(shadowCount, capabilities.maxTextureSize, profile.pointShadowSize);
  lights.forEach((light, i) => {
    light.castShadow = i < shadowCount;
    light.shadow.mapSize.set(size, size);
  });
}

// Bound immutable viewer building meshes using their complete position buffer.
// Clipped wall variants retain the original full wall vertices. Dynamic inventory
// does not opt in; unsupported vertex deformation always keeps every light run.
function roomLightingWorldBounds(mesh) {
  const geometry = mesh.geometry, position = geometry?.attributes?.position;
  const elements = mesh.matrixWorld?.elements;
  if (!geometry?.isBufferGeometry || geometry.isInstancedBufferGeometry || !position || position.isGLBufferAttribute || position.itemSize < 3 ||
      ![position.getX,position.getY,position.getZ].every(method=>typeof method === 'function') ||
      !position.count || mesh.isSkinnedMesh || mesh.isInstancedMesh || mesh.isBatchedMesh ||
      geometry.morphAttributes?.position?.length || mesh.material?.displacementMap ||
      !elements || elements.length !== 16 || !Array.from(elements).every(Number.isFinite) ||
      elements[3] !== 0 || elements[7] !== 0 || elements[11] !== 0 || elements[15] !== 1) return null;
  const low = [Infinity,Infinity,Infinity], high = [-Infinity,-Infinity,-Infinity];
  for (let i = 0; i < position.count; i++) {
    const point = [position.getX(i),position.getY(i),position.getZ(i)];
    if (!point.every(Number.isFinite)) return null;
    for (let axis = 0; axis < 3; axis++) {
      low[axis] = Math.min(low[axis],point[axis]); high[axis] = Math.max(high[axis],point[axis]);
    }
  }
  // Matrix uniforms use Float32. Include arithmetic-rounding slack, especially
  // when a large translation cancels another term, before the 0.56 m room halo.
  const e = Array.from(elements,Math.fround), bounds = [Infinity,Infinity,-Infinity,-Infinity];
  let magnitude = 1;
  for (const x of [low[0],high[0]]) for (const y of [low[1],high[1]]) for (const z of [low[2],high[2]]) {
    for (const [axis,column] of [[0,0],[1,2]]) {
      const terms = [e[column]*x,e[column+4]*y,e[column+8]*z,e[column+12]];
      const value = terms.reduce((sum,term)=>sum+term,0);
      bounds[axis] = Math.min(bounds[axis],value); bounds[axis+2] = Math.max(bounds[axis+2],value);
      magnitude = Math.max(magnitude,terms.reduce((sum,term)=>sum+Math.abs(term),0));
    }
  }
  const slack = magnitude*0.00001;
  const result = [bounds[0]-slack,bounds[1]-slack,bounds[2]+slack,bounds[3]+slack];
  return result.every(Number.isFinite) ? result : null;
}

// Keep whole existing runs in their original order. A nonintersecting room's
// contribution is exactly zero everywhere on this material's static geometry.
function filterRoomLightingRuns(bounds, roomBounds, pointRooms, ends, count, targetStarts, targetEnds) {
  let start = 0, selected = 0;
  for (let run = 0; run < count; run++) {
    const end = ends[run], room = pointRooms[start], index = (room-1)*4;
    if (!bounds || room === 0 || index < 0 || index+3 >= roomBounds.length ||
        (bounds[2] >= roomBounds[index]-.56 && bounds[0] <= roomBounds[index+2]+.56 &&
         bounds[3] >= roomBounds[index+1]-.56 && bounds[1] <= roomBounds[index+3]+.56)) {
      targetStarts[selected] = start; targetEnds[selected++] = end;
    }
    start = end;
  }
  return selected;
}

// Store one complete run in a single vector instead of three scalar arrays.
// Shadowed slots still use the original constant-index room lookup.
function packLightRunRecords(starts, ends, pointRooms, count, target) {
  for (let run = 0; run < count; run++) {
    const offset = run * 4, start = starts[run];
    target[offset] = start; target[offset + 1] = ends[run];
    target[offset + 2] = pointRooms[start]; target[offset + 3] = 0;
  }
}

// Pack only within a conservative fragment-uniform allowance. Coordinates use
// the same five-decimal literals as the original GLSL before Float32 storage.
function packRoomLightingGeometry(rooms, windows, capacity, maxFragmentUniforms) {
  const edgeCount = rooms.reduce((sum, room) => sum + room.polygon.length, 0);
  const windowRooms = rooms.flatMap((room, index) => windows.some(window => window.room === room.id) ? [index] : []);
  // Keep the conservative seven-vector per-light allowance even though packed
  // run records now share one vector. Reserve light/shadow/material/transform
  // state and the wall-sheen, facing and zero-point switches; do not broaden
  // eligibility based on driver-dependent inactive-array elimination.
  const uniformVectors = 131 + capacity * 7 + rooms.length * 4 + edgeCount + windows.length * 2 + Math.max(1, windowRooms.length);
  if (!Number.isFinite(maxFragmentUniforms) || uniformVectors > maxFragmentUniforms) return null;
  const edges = new Float32Array(Math.max(1, edgeCount) * 4);
  const ranges = new Int32Array(Math.max(1, rooms.length) * 4);
  const bounds = new Float32Array(Math.max(1, rooms.length) * 4);
  const exterior = new Int32Array(Math.max(1, rooms.length));
  const segments = new Float32Array(Math.max(1, windows.length) * 4), windowIndices = [];
  const windowSlots = new Int32Array(windows.length).fill(-1);
  const number = value => Number(Number(value).toFixed(5));
  let edge = 0, rectanglesOnly = true;
  rooms.forEach((room, index) => {
    const start = edge, windowStart = windowIndices.length;
    room.polygon.forEach((a, i) => {
      const b = room.polygon[(i + 1) % room.polygon.length];
      edges.set([...a, ...b].map(number), edge++ * 4);
    });
    windows.forEach((window, source) => {
      if (window.room !== room.id) return;
      segments.set([...window.a, ...window.b].map(number), windowIndices.length * 4);
      windowSlots[source] = windowIndices.length;
      windowIndices.push(source);
    });
    const xs = room.polygon.map(point => point[0]), zs = room.polygon.map(point => point[1]);
    bounds.set([Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)].map(number), index * 4);
    const corners = room.polygon.map(point => point.map(value => Math.fround(number(value))));
    const [left, bottom, right, top] = bounds.subarray(index * 4, index * 4 + 4);
    const rectangle = corners.length === 4 && left < right && bottom < top &&
      new Set(corners.map(point => point.join(','))).size === 4 && corners.every(([x, z], i) => {
        const next = corners[(i + 1) % 4];
        return (x === left || x === right) && (z === bottom || z === top) &&
          (x === next[0] || z === next[1]);
      });
    rectanglesOnly = rectanglesOnly && rectangle;
    // A negative edge end marks an exact axis-aligned rectangle. The bound is
    // its signed-distance shape; arbitrary and rotated polygons keep all edges.
    ranges.set([start, rectangle ? -edge : edge, windowStart, windowIndices.length], index * 4);
    exterior[index] = room.exterior === true ? 1 : 0;
  });
  return {edgeCount, rectanglesOnly, uniformVectors, windowIndices, windowSlots, windowRoomCount:windowRooms.length, uniforms: {
    homeRoomEdges:{value:edges}, homeRoomRanges:{value:ranges}, homeRoomBounds:{value:bounds},
    homeRoomExterior:{value:exterior}, homeWindowSegments:{value:segments},
    homeWindowRooms:{value:new Int32Array(windowRooms.length ? windowRooms : [0])},
  }};
}

// Retain the original shader path for malformed light inputs: zero intensity
// multiplied by a nonfinite color/attenuation is not necessarily zero in GLSL.
function pointLightIsFiniteZero(light) {
  return light.intensity === 0 &&
    [light.color?.r,light.color?.g,light.color?.b,
      light.position?.x,light.position?.y,light.position?.z,
      light.distance,light.decay].every(Number.isFinite) &&
    light.distance >= 0 && light.decay >= 0;
}

// Run records are exact nonnegative integers. RGBA32F preserves every value
// admitted here; one texture row is a fixed block for one static material.
function createLightRunTexture(THREE, capacity, roomCount, packed, options) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 32768 ||
      !Number.isInteger(roomCount) || roomCount < 0 || roomCount > 16777216 ||
      !Number.isInteger(options.maxTextureSize) || capacity > options.maxTextureSize ||
      !Number.isInteger(options.maxTextures) || options.maxTextures < 16 ||
      packed.uniformVectors+3 > options.maxFragmentUniforms) return null;
  const rows=new Map();
  let texture=null, ready=false, disposed=false;
  function valid(uniforms) {
    const count=uniforms.homeLightRunCount.value, data=uniforms.homeLightRuns.value;
    if(!Number.isInteger(count)||count<0||count>capacity||data.length!==capacity*4)return false;
    for(let i=0;i<data.length;i+=4)if(
      !Number.isInteger(data[i])||data[i]<0||data[i]>capacity||
      !Number.isInteger(data[i+1])||data[i+1]<data[i]||data[i+1]>capacity||
      !Number.isInteger(data[i+2])||data[i+2]<0||data[i+2]>roomCount||data[i+3]!==0)return false;
    return true;
  }
  return {
    get ready(){return ready;},
    bind(material,shader){
      // Getters also serve a cached texture program after a full/editor variant.
      shader.uniforms.homeRunTexture={get value(){return texture;}};
      shader.uniforms.homeRunBlock={get value(){return rows.get(material)||0;}};
    },
    update(global,materials){
      ready=false;
      if(disposed||!valid(global))return;
      for(const state of materials.values())if(!valid(state.uniforms))return;
      const added=[...materials.keys()].filter(material=>!rows.has(material));
      const height=1+rows.size+added.length;
      // Bound both GL dimensions and CPU allocation; unsupported scenes retain
      // their original uniform program rather than dropping any run records.
      if(height>options.maxTextureSize||capacity*height>1048576)return;
      for(const material of added)rows.set(material,rows.size+1);
      if(!texture||texture.image.height!==height){
        texture?.dispose();
        texture=new THREE.DataTexture(new Float32Array(capacity*height*4),capacity,height,THREE.RGBAFormat,THREE.FloatType);
        texture.name='material-light-runs';texture.internalFormat='RGBA32F';
        texture.minFilter=texture.magFilter=THREE.NearestFilter;texture.generateMipmaps=false;
        texture.flipY=false;texture.colorSpace=THREE.NoColorSpace;texture.unpackAlignment=1;
        texture.needsUpdate=true;
      }
      let changed=false;
      const copy=(uniforms,row)=>{
        const input=uniforms.homeLightRuns.value,offset=row*capacity*4,data=texture.image.data;
        for(let i=0;i<input.length;i++)if(data[offset+i]!==input[i]){data[offset+i]=input[i];changed=true;}
      };
      copy(global,0);
      for(const [material,state] of materials)copy(state.uniforms,rows.get(material));
      if(changed)texture.needsUpdate=true;
      ready=true;
    },
    releaseGPU(){if(!disposed&&texture){texture.dispose();texture.needsUpdate=true;}},
    dispose(){if(disposed)return;disposed=true;ready=false;texture?.dispose();rows.clear();}
  };
}

// Optional software-renderer transport. Selection happens before rendering;
// the texture shader contains no dynamic fallback to the full PointLight array.
function createPointLightTexture(THREE, capacity, packed, options, pointRooms, runTexture) {
  if ((options.runTexture && !runTexture) || !Number.isInteger(capacity) || capacity < 1 || capacity > 32768 ||
      !Number.isInteger(options.maxTextureSize) || capacity*2 > options.maxTextureSize ||
      !Number.isInteger(options.maxTextures) || options.maxTextures < 16 ||
      packed.uniformVectors+1 > options.maxFragmentUniforms) return null;
  const data=new Float32Array(capacity*8), staging=new Float32Array(data.length), states=new Map();
  const texture=new THREE.DataTexture(data,capacity*2,1,THREE.RGBAFormat,THREE.FloatType);
  texture.name='view-space-point-lights';texture.internalFormat='RGBA32F';
  texture.minFilter=texture.magFilter=THREE.NearestFilter;texture.generateMipmaps=false;
  texture.flipY=false;texture.colorSpace=THREE.NoColorSpace;texture.unpackAlignment=1;
  texture.needsUpdate=true;
  let disposed=false, count=0;
  const finite=value=>Number.isFinite(value)&&Number.isFinite(Math.fround(value));
  function activate(state,active) {
    if(state.active!==active){state.active=active;state.material.needsUpdate=true;}
  }
  return {
    attach(mesh,group,enabled) {
      const material=mesh.material;
      let state=states.get(material);
      if(!state){state={material,active:false,meshes:new Map()};states.set(material,state);}
      state.meshes.set(mesh,group);state.enabled=enabled;
      return state;
    },
    bind(state,shader) {
      runTexture?.bind(state.material,shader);
      const source=shader.uniforms.pointLights;
      // Install in every variant: Three may reuse a cached texture program with
      // the most recently compiled full/editor variant's uniform map.
      shader.uniforms.homePointTexture={get value(){
        staging.fill(0);
        for(let i=0;i<count;i++){
          const light=source.value[i],offset=i*8;
          if(!light)throw new Error('Missing Three point-light record for texture');
          staging[offset]=light.position.x;staging[offset+1]=light.position.y;staging[offset+2]=light.position.z;
          staging[offset+3]=light.distance;staging[offset+4]=light.color.r;staging[offset+5]=light.color.g;
          staging[offset+6]=light.color.b;staging[offset+7]=light.decay;
        }
        if(staging.some((value,index)=>!Object.is(value,data[index]))){data.set(staging);texture.needsUpdate=true;}
        return texture;
      }};
    },
    update(points,camera) {
      const ordered=[];
      for(const shadowed of [true,false])for(const point of points)
        if(point.light?.visible&&Boolean(point.light.castShadow)===shadowed)ordered.push(point);
      count=ordered.length;
      let ready=!disposed&&(!runTexture||runTexture.ready)&&count<=capacity&&ordered.filter(p=>p.light.castShadow).length<=8&&
        camera?.isCamera&&typeof camera.updateWorldMatrix==='function'&&camera.layers&&camera.matrixWorldInverse?.elements?.length===16;
      if(ready){
        camera.updateWorldMatrix(true,false);
        const view=camera.matrixWorldInverse.elements,magnitude=Math.max(...view.map(Math.abs));
        if(!view.every(finite)||view[3]!==0||view[7]!==0||view[11]!==0||!view[15])ready=false;
        for(let i=0;i<count;i++){
          const light=ordered[i].light;
          if(!light.isPointLight||!pointRooms.value[i]||light.map||typeof light.layers?.test!=='function'||!light.layers.test(camera.layers)||
              typeof light.updateWorldMatrix!=='function'||light.matrixWorld?.elements?.length!==16||
              ![light.intensity,light.color?.r,light.color?.g,light.color?.b,light.distance,light.decay,
                light.position?.x,light.position?.y,light.position?.z].every(finite)){ready=false;break;}
          for(let parent=light;parent;parent=parent.parent)if(!parent.visible)ready=false;
          light.updateWorldMatrix(true,false);
          const world=light.matrixWorld.elements,position=Math.max(1,Math.abs(world[12]),Math.abs(world[13]),Math.abs(world[14]));
          if(!world.every(finite)||!finite(position*magnitude*4/Math.abs(view[15]))||
              ![light.color.r*light.intensity,light.color.g*light.intensity,light.color.b*light.intensity].every(finite))ready=false;
        }
      }
      for(const state of states.values()){
        const {material,meshes}=state;
        for(const [mesh,group] of meshes){
          let attached=false;
          for(let node=mesh;node;node=node.parent)if(node===group)attached=true;
          if(!attached||mesh.material!==material)meshes.delete(mesh);
        }
        if(!meshes.size){activate(state,false);states.delete(material);continue;}
        // Untextured Lambert materials leave ample sampler space for the
        // original shadow prefix. External callbacks retain the full program.
        activate(state,Boolean(ready&&state.enabled&&material.isMeshLambertMaterial&&
          !Object.values(material).some(value=>value?.isTexture)&&
          material.onBeforeCompile===state.callback&&material.customProgramCacheKey===state.cacheKey&&
          [...meshes.keys()].every(mesh=>mesh.onBeforeRender===THREE.Object3D.prototype.onBeforeRender)&&
          material.onBeforeRender===THREE.Material.prototype.onBeforeRender));
      }
    },
    releaseGPU(){if(!disposed){texture.dispose();texture.needsUpdate=true;}},
    dispose(){if(disposed)return;disposed=true;for(const state of states.values())activate(state,false);states.clear();texture.dispose();}
  };
}

// Softly confine each fixture's direct light to its room, retaining a short
// doorway spill. Full-height shadow geometry still blocks opaque walls/doors.
function createRoomLighting(THREE, rooms, capacity, windows, geometryOptions = {}) {
  capacity = Math.max(1, capacity);
  const roomIds = new Map(rooms.map((room, i) => [room.id, i + 1]));
  const uniforms = {
    homePointRooms: {value: new Int32Array(capacity)},
    homeLightRunEnds: {value: new Int32Array(capacity)},
    homeLightRunCount: {value: 0},
    homeLitRooms: {value: new Int32Array(Math.max(1, rooms.length))},
    homeDaylight: {value: 0},
    homeWindowTransmission: {value: new Float32Array(Math.max(1, windows.length)).fill(1)}
  };
  const packed = geometryOptions.packed ? packRoomLightingGeometry(rooms, windows, capacity, geometryOptions.maxFragmentUniforms) : null;
  if (packed) Object.assign(uniforms, packed.uniforms, {
    homeLightRunStarts:{value:new Int32Array(capacity)}, homePointLightingRequired:{value:true},
    homeLightRuns:{value:new Int32Array(capacity * 4)}
  });
  const runTexture=packed&&geometryOptions.pointTexture&&geometryOptions.runTexture ? createLightRunTexture(THREE,capacity,rooms.length,packed,geometryOptions) : null;
  const pointTexture=packed&&geometryOptions.pointTexture ? createPointLightTexture(THREE,capacity,packed,geometryOptions,uniforms.homePointRooms,runTexture) : null;
  const staticRuns = new Map(), dynamicMaterials = new WeakSet();
  const geometryDeclarations = packed ? `
    uniform bool homePointLightingRequired;
    uniform vec4 homeRoomEdges[${Math.max(1, packed.edgeCount)}];
    uniform ivec4 homeRoomRanges[${Math.max(1, rooms.length)}];
    uniform vec4 homeRoomBounds[${Math.max(1, rooms.length)}];
    uniform int homeRoomExterior[${Math.max(1, rooms.length)}];
    uniform vec4 homeWindowSegments[${Math.max(1, windows.length)}];
    uniform int homeWindowRooms[${Math.max(1, packed.windowRoomCount)}];
  ` : '';
  const glslNumber = n => Number(n).toFixed(5);
  const glslVector = p => `vec2(${p.map(glslNumber).join(',')})`;
  const boxDistance = `vec4 bounds = homeRoomBounds[room];
      vec2 distanceToBox = max(bounds.xy - p, p - bounds.zw);
      return length(max(distanceToBox, vec2(0.0))) + min(max(distanceToBox.x, distanceToBox.y), 0.0);`;
  // Call sites already know their room. Separate functions prevent a shader
  // compiler from inlining every room's branch chain at every literal call.
  const roomDistances = packed ? `
    float homeRoomDistance(int room) {
      vec2 p = homeWorldPosition.xz;
      ${packed.rectanglesOnly ? boxDistance : `float distanceToRoom = 100000000.0;
      bool inside = false;
      ivec4 range = homeRoomRanges[room];
      if (range.y < 0) {
        ${boxDistance}
      }
      for (int edge = range.x; edge < range.y; edge++) {
        vec4 segment = homeRoomEdges[edge];
        homeRoomEdge(p, segment.xy, segment.zw, distanceToRoom, inside);
      }
      float distance = sqrt(distanceToRoom);
      return inside ? -distance : distance;`}
    }
  ` : rooms.map((room, i) => `float homeRoomDistance${i + 1}() {
    vec2 p = homeWorldPosition.xz;
    float distanceToRoom = 100000000.0;
    bool inside = false;
    ${room.polygon.map((a, j) => `homeRoomEdge(p, ${glslVector(a)}, ${glslVector(room.polygon[(j + 1) % room.polygon.length])}, distanceToRoom, inside);`).join('\n')}
    float distance = sqrt(distanceToRoom);
    return inside ? -distance : distance;
  }`).join('\n');
  // Transmission reaches exactly zero at 0.55 m from a room. A slightly
  // wider axis-aligned bound rejects distant rooms before their polygon edges
  // are evaluated, retaining concave shapes and every doorway-spill fragment.
  const roomBounds = packed ? `
    bool homeRoomNearby(int room) {
      vec2 p = homeWorldPosition.xz;
      vec4 bounds = homeRoomBounds[room];
      return all(greaterThanEqual(p, bounds.xy - vec2(0.56))) &&
        all(lessThanEqual(p, bounds.zw + vec2(0.56)));
    }
  ` : rooms.map((room, i) => {
    const xs = room.polygon.map(p => p[0]), zs = room.polygon.map(p => p[1]);
    return `bool homeRoomNearby${i + 1}() {
      vec2 p = homeWorldPosition.xz;
      return all(greaterThanEqual(p, ${glslVector([Math.min(...xs), Math.min(...zs)])} - vec2(0.56))) &&
        all(lessThanEqual(p, ${glslVector([Math.max(...xs), Math.max(...zs)])} + vec2(0.56)));
    }`;
  }).join('\n');
  // The shared 0.56 m bound also contains daylight's 0.015 m and exterior's
  // 0.04 m reach. Absent static topologies need no packed room loop at all.
  const fragment = `
    varying vec3 homeWorldPosition;
    uniform int homePointRooms[${capacity}];
    ${packed ? `uniform ivec4 homeLightRuns[${capacity}];` : `uniform int homeLightRunEnds[${capacity}];`}
    uniform int homeLightRunCount;
    uniform int homeLitRooms[${Math.max(1, rooms.length)}];
    uniform float homeDaylight;
    uniform float homeExteriorSurface;
    uniform float homeWindowTransmission[${Math.max(1, windows.length)}];
${packed ? `    ${geometryDeclarations}\n` : ''}    void homeRoomEdge(vec2 p, vec2 a, vec2 b, inout float d, inout bool inside) {
      vec2 edge = b - a;
      vec2 delta = p - a - edge * clamp(dot(p - a, edge) / dot(edge, edge), 0.0, 1.0);
      d = min(d, dot(delta, delta));
      if ((a.y > p.y) != (b.y > p.y)) {
        if (p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
      }
    }
    ${roomDistances}
    ${roomBounds}
    float homeRoomTransmission(float distanceToRoom) {
      if (distanceToRoom <= 0.0) return 1.0;
      return exp(-8.0 * distanceToRoom) * (1.0 - smoothstep(0.1, 0.55, distanceToRoom));
    }
    float homeWindowGlow(vec2 a, vec2 b) {
      vec2 edge = b-a;
      float d = length(homeWorldPosition.xz-a-edge*clamp(dot(homeWorldPosition.xz-a,edge)/dot(edge,edge),0.0,1.0));
      return 1.0 * exp(-0.55*d);
    }
    vec3 homeDaylightIrradiance() {
      float exterior = homeExteriorSurface;
      ${packed ? (rooms.some(room=>room.exterior===true) ? `for (int room = 0; room < ${rooms.length}; room++) {
        if (homeRoomExterior[room] != 0 && homeRoomNearby(room)) exterior = max(exterior, 1.0-smoothstep(0.0,0.04,homeRoomDistance(room)));
      }` : '') : rooms.filter(room=>room.exterior===true).map(room=>`exterior = max(exterior, 1.0-smoothstep(0.0,0.04,homeRoomDistance${roomIds.get(room.id)}()));`).join('\n')}
      float incoming = 0.0;
      if (homeDaylight > 0.0) {
        ${packed ? (packed.windowIndices.length ? `for (int windowRoom = 0; windowRoom < ${packed.windowRoomCount}; windowRoom++) {
          int room = homeWindowRooms[windowRoom];
          ivec4 range = homeRoomRanges[room];
          if (homeRoomNearby(room) && homeRoomDistance(room) <= 0.015) {
            for (int window = range.z; window < range.w; window++) {
              vec4 segment = homeWindowSegments[window];
              incoming += homeWindowTransmission[window] * homeWindowGlow(segment.xy, segment.zw);
            }
          }
        }` : '') : rooms.map(room=>{
          const openings=windows.flatMap((window,i)=>window.room===room.id?[{...window,index:i}]:[]);
          return openings.length?`if (homeRoomDistance${roomIds.get(room.id)}() <= 0.015) {\n${openings.map(window=>`incoming += homeWindowTransmission[${window.index}] * homeWindowGlow(${glslVector(window.a)}, ${glslVector(window.b)});`).join('\n')}\n}`:'';
        }).join('\n')}
      }
      // Diffuse skylight enters at glazing, fades inward and cannot cross a room wall.
      // Outdoor surfaces retain a gentle base at night and brighten with the sun.
      return 3.14159265 * vec3(0.93,0.97,1.0) *
        (homeDaylight * min(incoming,1.05) + exterior * (0.16 + 1.1*homeDaylight));
    }${packed ? `
    float homePointTransmission(int room) {
      if (room == 0) return 1.0;
      int index = room - 1;
      return homeLitRooms[index] != 0 && homeRoomNearby(index)
        ? homeRoomTransmission(homeRoomDistance(index)) : 0.0;
    }` : ''}
  `;
  // The literal shader caches each lit room once per fragment. The packed
  // software path uses direct lookups below: a dynamically indexed local float
  // array is expensive on Apple's legacy fragment interpreter.
  const transmissionCache = `
    #if NUM_POINT_LIGHTS > 0
      float homeRoomTransmissions[${rooms.length + 1}];
      homeRoomTransmissions[0] = 1.0;
      ${packed ? `for (int room = 0; room < ${rooms.length}; room++) {
        homeRoomTransmissions[room + 1] = homeLitRooms[room] != 0 && homeRoomNearby(room) ? homeRoomTransmission(homeRoomDistance(room)) : 0.0;
      }` : rooms.map((_, i) => `homeRoomTransmissions[${i + 1}] = homeLitRooms[${i}] != 0 && homeRoomNearby${i + 1}() ? homeRoomTransmission(homeRoomDistance${i + 1}()) : 0.0;`).join('\n')}
    #endif
  `;
  const lightChunk = THREE.ShaderChunk.lights_fragment_begin;
  const pointStart = lightChunk.indexOf('#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )');
  const pointEnd = lightChunk.indexOf('#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )', pointStart);
  const directCall = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
  // A room with zero transmission cannot receive this light. Cull it before
  // distance/attenuation work, while retaining every nonzero contribution.
  const pointLighting = lightChunk.slice(pointStart, pointEnd).replace(
    'pointLight = pointLights[ i ];',
    'if (homeRoomTransmissions[homePointRooms[ i ]] != 0.0) {\npointLight = pointLights[ i ];'
  ).replace(
    'getPointLightInfo( pointLight, geometryPosition, directLight );',
    `getPointLightInfo( pointLight, geometryPosition, directLight );
    if (directLight.visible) {
      directLight.color *= homeRoomTransmissions[homePointRooms[ i ]];
      directLight.visible = (directLight.color != vec3(0.0));
    }`
  ).replace(directCall, 'if (directLight.visible) ' + directCall + '\n}');
  // Shadow samplers keep their bounded literal prefix. Consecutive lights in
  // the same room share one transmission lookup; skip their entire runtime
  // range when it contributes nothing. Runs retain Three's exact light order,
  // and one shared PBR body avoids expanding it for every room or fixture.
  const guardedDirectCall = 'if (directLight.visible) ' + directCall;
  const unshadowedBody = pointLighting.slice(pointLighting.indexOf('pointLight = pointLights'),
    pointLighting.indexOf(guardedDirectCall) + guardedDirectCall.length)
    .replace(/#if defined\( USE_SHADOWMAP \) && \( UNROLLED_LOOP_INDEX < NUM_POINT_LIGHT_SHADOWS \)[\s\S]*?#endif/, '')
    .replaceAll('homeRoomTransmissions[homePointRooms[ i ]]', 'homeRunTransmission');
  const boundedPointLighting = pointLighting.replace('i < NUM_POINT_LIGHTS', 'i < NUM_POINT_LIGHT_SHADOWS')
    .replace('#pragma unroll_loop_end', `#pragma unroll_loop_end
    int homeRunStart = 0;
    for ( int homeRun = 0; homeRun < homeLightRunCount; homeRun ++ ) {
      int homeRunEnd = min(homeLightRunEnds[homeRun], NUM_POINT_LIGHTS);
      int homeFirstLight = max(homeRunStart, NUM_POINT_LIGHT_SHADOWS);
      if (homeFirstLight < homeRunEnd) {
        float homeRunTransmission = homeRoomTransmissions[homePointRooms[homeFirstLight]];
        if (homeRunTransmission != 0.0) {
          for ( int i = homeFirstLight; i < homeRunEnd; i ++ ) {
            ${unshadowedBody}
          }
        }
      }
      homeRunStart = homeRunEnd;
    }`);
  // Keep shadow sampler indices literal and share one lookup per unshadowed
  // room run. Both paths retain exactly the same zero-transmission culling.
  const directPointLighting = packed ? boundedPointLighting.replace(
    /homeRoomTransmissions\[homePointRooms\[([^\]]+)\]\]/g,
    'homePointTransmission(homePointRooms[$1])'
  ).replace('int homeRunStart = 0;', '')
    .replace('int homeRunEnd = min(homeLightRunEnds[homeRun], NUM_POINT_LIGHTS);',
      'ivec4 homeRunData = homeLightRuns[homeRun];\n      int homeRunEnd = min(homeRunData.y, NUM_POINT_LIGHTS);')
    .replace('max(homeRunStart, NUM_POINT_LIGHT_SHADOWS)', 'max(homeRunData.x, NUM_POINT_LIGHT_SHADOWS)')
    .replace('homePointTransmission(homePointRooms[homeFirstLight])', 'homePointTransmission(homeRunData.z)')
    .replace('homeRunStart = homeRunEnd;', '') : boundedPointLighting;
  // A runtime branch retains the same light slots, shadow maps and program
  // family when every point is off. Never infer zero from a brightness epsilon.
  const guardedPointLighting = packed ? 'if (homePointLightingRequired) {\n' + directPointLighting + '\n}\n' : directPointLighting;
  const lighting = (packed ? '' : transmissionCache) + lightChunk.slice(0, pointStart) + guardedPointLighting + lightChunk.slice(pointEnd);
  const textureParameters=pointTexture ? THREE.ShaderChunk.lights_pars_begin.replace('uniform PointLight pointLights[ NUM_POINT_LIGHTS ];',
    '#if NUM_POINT_LIGHT_SHADOWS > 0\n\tuniform PointLight pointLights[ NUM_POINT_LIGHT_SHADOWS ];\n\t#endif') : '';
  const textureBody=unshadowedBody.replace('pointLight = pointLights[ i ];',`
            vec4 homePositionDistance=texelFetch(homePointTexture,ivec2(i*2,0),0);
            vec4 homeColorDecay=texelFetch(homePointTexture,ivec2(i*2+1,0),0);
            pointLight.position=homePositionDistance.xyz;pointLight.distance=homePositionDistance.w;
            pointLight.color=homeColorDecay.xyz;pointLight.decay=homeColorDecay.w;`);
  const textureLighting=pointTexture ? lighting.replace(unshadowedBody,textureBody) : '';
  const runLighting=runTexture ? textureLighting.replace('homeLightRuns[homeRun]',
    'ivec4(texelFetch(homeRunTexture,ivec2(homeRun,homeRunBlock),0))') : textureLighting;
  const runFragment=runTexture ? fragment.replace(`uniform ivec4 homeLightRuns[${capacity}];`,
    'uniform highp sampler2D homeRunTexture; uniform int homeRunBlock;') : fragment;
  return {
    releaseGPU(){pointTexture?.releaseGPU();runTexture?.releaseGPU();},
    dispose(){pointTexture?.dispose();runTexture?.dispose();},
    capacity, geometryMode: packed ? 'packed' : 'literal', geometryUniformVectors: packed?.uniformVectors ?? null,
    attach(group, enabled, {staticGeometry = false} = {}) {
      if (packed && staticGeometry) group?.updateWorldMatrix?.(true,true);
      // A material reused across wall/non-wall or unknown categories cannot
      // represent both fragment behaviours with one per-material uniform.
      const sharedWallRoles = new Map(), materialUses = new Map();
      if(packed) group?.traverse(mesh => {if(fallbackBoxMaterials.has(mesh.material)) materialUses.set(mesh.material,(materialUses.get(mesh.material)||0)+1);});
      if (packed && staticGeometry) group?.traverse(mesh => {
        if (!mesh.material) return;
        const category = mesh.userData.category;
        const role = category === 'walls' ? 'wall' : ['floors','frames'].includes(category) ? 'opaque' :
          category === 'windows' && staticGlassFacing.has(mesh.material) ? 'glass' : null;
        sharedWallRoles.set(mesh.material, !sharedWallRoles.has(mesh.material) || sharedWallRoles.get(mesh.material) === role ? role : null);
      });
      group?.traverse(mesh => {
        if (!mesh.material?.isMeshStandardMaterial && !mesh.material?.isMeshLambertMaterial) return;
        if (packed) {
          const material = mesh.material;
          if (!staticGeometry) {
            dynamicMaterials.add(material);
            if (staticRuns.has(material)) staticRuns.get(material).unbounded = true;
          } else {
            let state = staticRuns.get(material);
            if (!state) {
              state = {bounds:null,unbounded:dynamicMaterials.has(material),uniforms:{
                homeLightRunStarts:{value:new Int32Array(capacity)},
                homeLightRuns:{value:new Int32Array(capacity * 4)},
                homeLightRunEnds:{value:new Int32Array(capacity)},homeLightRunCount:{value:0}}};
              staticRuns.set(material,state);
            }
            const bounds = roomLightingWorldBounds(mesh);
            if (!bounds) state.unbounded = true;
            else if (!state.bounds) state.bounds = bounds;
            else state.bounds = [Math.min(state.bounds[0],bounds[0]),Math.min(state.bounds[1],bounds[1]),
              Math.max(state.bounds[2],bounds[2]),Math.max(state.bounds[3],bounds[3])];
          }
        }
        const wall = mesh.userData.category === 'walls';
        const fallbackFacing=prepareFallbackBoxProgram(THREE,mesh,Boolean(packed),!packed||materialUses.get(mesh.material)===1);
        const wallEnabled = prepareSharedWallProgram(THREE, mesh,
          fallbackFacing ? 'opaque' : !dynamicMaterials.has(mesh.material) && sharedWallRoles.get(mesh.material));
        const sharedWall = Boolean(wallEnabled);
        const textureState=pointTexture?.attach(mesh,group,enabled);
        mesh.material.onBeforeCompile = shader => {
          if (sharedWall) applySharedWallSheen(shader, wallEnabled);
          else if (wall) applyWallSheen(shader);
          const facing = fallbackFacing || staticGlassFacing.get(mesh.material);
          if (sharedWall || facing) applyStaticFacing(THREE, shader, facing || bothFaces);
          // Keep uniform definitions identical in both material variants.
          Object.assign(shader.uniforms, uniforms, staticRuns.get(mesh.material)?.uniforms, {homeExteriorSurface:{value:mesh.userData.category==='stairs'?1:0}});
          if(textureState)pointTexture.bind(textureState,shader);
          // The editor needs no room/window shader, especially on software WebGL.
          if (!enabled) return;
          shader.vertexShader = 'varying vec3 homeWorldPosition;\n' + shader.vertexShader.replace(
            '#include <project_vertex>',
            '#include <project_vertex>\nhomeWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;'
          );
          if(textureState?.active)shader.fragmentShader=shader.fragmentShader.replace('#include <lights_pars_begin>',textureParameters);
          shader.fragmentShader = (textureState?.active?'uniform highp sampler2D homePointTexture;\n':'') + (textureState?.active?runFragment:fragment) + shader.fragmentShader.replace('#include <lights_fragment_begin>', textureState?.active?runLighting:lighting).replace('#include <lights_fragment_end>', 'irradiance += homeDaylightIrradiance();\n#include <lights_fragment_end>');
        };
        mesh.material.customProgramCacheKey = () => (enabled ? fragment+(textureState?.active?':point-texture-v2'+(runTexture?':run-texture-v1':''):'') : 'home-editor') +
          (sharedWall ? ':wall-sheen-facing-v1' : wall ? ':wall-sheen-v2' : '') +
          (!sharedWall && staticGlassFacing.has(mesh.material) ? ':glass-facing-v1' : '');
        if(textureState){textureState.callback=mesh.material.onBeforeCompile;textureState.cacheKey=mesh.material.customProgramCacheKey;}
        mesh.material.needsUpdate = true;
      });
    },
    environment(daylight, transmission) {
      uniforms.homeDaylight.value=daylight;
      if (packed) transmission.forEach((value, source) => {
        const index = packed.windowSlots[source];
        if (index >= 0) uniforms.homeWindowTransmission.value[index] = value;
      });
      else transmission.forEach((value,i)=>uniforms.homeWindowTransmission.value[i]=value);
    },
    update(points, camera) {
      // Three.js stably sorts shadow casters before unshadowed point lights.
      // These lights have no projection maps, so traversal order breaks ties.
      // Zero-intensity fixtures retain their slots across on/off state changes.
      uniforms.homePointRooms.value.fill(0);
      uniforms.homeLitRooms.value.fill(0);
      if (packed) uniforms.homePointLightingRequired.value = false;
      let slot = 0;
      for (const shadowed of [true, false]) for (const point of points) {
        if (point.light?.visible && Boolean(point.light.castShadow) === shadowed) {
          const room = roomIds.get(point.item.room) || 0;
          // Unknown/nonfinite inputs and negative/nonfinite intensity retain
          // the original path. Unbound lights also retain it: unlike known
          // unlit rooms, they do not reject attenuation before world math.
          if (packed && (!room || !pointLightIsFiniteZero(point.light))) {
            uniforms.homePointLightingRequired.value = true;
          }
          uniforms.homePointRooms.value[slot++] = room;
          if (room && point.light.intensity > 0) uniforms.homeLitRooms.value[room - 1] = 1;
        }
      }
      // Include shadowed slots in the runs, then clip them against the actual
      // shader prefix above. This also covers rendering with shadow maps off.
      // Reuse fixed storage; changing HA state never changes the shader layout.
      const runs = uniforms.homeLightRunEnds.value, pointRooms = uniforms.homePointRooms.value;
      runs.fill(0);
      let runCount = 0, runStart = 0;
      for (let i = 1; i <= slot; i++) {
        if (i === slot || pointRooms[i] !== pointRooms[i - 1]) {
          if (packed) uniforms.homeLightRunStarts.value[runCount] = runStart;
          runs[runCount++] = i; runStart = i;
        }
      }
      uniforms.homeLightRunCount.value = runCount;
      if (packed) packLightRunRecords(uniforms.homeLightRunStarts.value, runs, pointRooms, runCount, uniforms.homeLightRuns.value);
      if (packed) for (const state of staticRuns.values()) {
        state.uniforms.homeLightRunCount.value = filterRoomLightingRuns(state.unbounded ? null : state.bounds,
          packed.uniforms.homeRoomBounds.value,pointRooms,runs,runCount,
          state.uniforms.homeLightRunStarts.value,state.uniforms.homeLightRunEnds.value);
        packLightRunRecords(state.uniforms.homeLightRunStarts.value, state.uniforms.homeLightRunEnds.value,
          pointRooms, state.uniforms.homeLightRunCount.value, state.uniforms.homeLightRuns.value);
      }
      if(pointTexture)runTexture?.update(uniforms,staticRuns);
      pointTexture?.update(points,camera);
    }
  };
}
