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

// Pack only within a conservative fragment-uniform allowance. Coordinates use
// the same five-decimal literals as the original GLSL before Float32 storage.
function packRoomLightingGeometry(rooms, windows, capacity, maxFragmentUniforms) {
  const edgeCount = rooms.reduce((sum, room) => sum + room.polygon.length, 0);
  const windowRooms = rooms.flatMap((room, index) => windows.some(window => window.room === room.id) ? [index] : []);
  // Scalars in arrays may each consume a vector. Reserve the existing light,
  // shadow, material and transform uniforms before adding packed geometry,
  // plus explicit vectors for the wall-sheen switch and facing mode.
  const uniformVectors = 130 + capacity * 7 + rooms.length * 4 + edgeCount + windows.length * 2 + Math.max(1, windowRooms.length);
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
  if (packed) Object.assign(uniforms, packed.uniforms, {homeLightRunStarts:{value:new Int32Array(capacity)}});
  const staticRuns = new Map(), dynamicMaterials = new WeakSet();
  const geometryDeclarations = packed ? `
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
    uniform int homeLightRunEnds[${capacity}];
    uniform int homeLightRunCount;
    uniform int homeLitRooms[${Math.max(1, rooms.length)}];
    uniform float homeDaylight;
    uniform float homeExteriorSurface;
    uniform float homeWindowTransmission[${Math.max(1, windows.length)}];
${packed ? `    uniform int homeLightRunStarts[${capacity}];\n    ${geometryDeclarations}\n` : ''}    void homeRoomEdge(vec2 p, vec2 a, vec2 b, inout float d, inout bool inside) {
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
  ).replace('max(homeRunStart, NUM_POINT_LIGHT_SHADOWS)', 'max(homeLightRunStarts[homeRun], NUM_POINT_LIGHT_SHADOWS)') : boundedPointLighting;
  const lighting = (packed ? '' : transmissionCache) + lightChunk.slice(0, pointStart) + directPointLighting + lightChunk.slice(pointEnd);
  return {
    capacity, geometryMode: packed ? 'packed' : 'literal', geometryUniformVectors: packed?.uniformVectors ?? null,
    attach(group, enabled, {staticGeometry = false} = {}) {
      if (packed && staticGeometry) group?.updateWorldMatrix?.(true,true);
      // A material reused across wall/non-wall or unknown categories cannot
      // represent both fragment behaviours with one per-material uniform.
      const sharedWallRoles = new Map();
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
        const wallEnabled = prepareSharedWallProgram(THREE, mesh,
          !dynamicMaterials.has(mesh.material) && sharedWallRoles.get(mesh.material));
        const sharedWall = Boolean(wallEnabled);
        mesh.material.onBeforeCompile = shader => {
          if (sharedWall) applySharedWallSheen(shader, wallEnabled);
          else if (wall) applyWallSheen(shader);
          const facing = staticGlassFacing.get(mesh.material);
          if (sharedWall || facing) applyStaticFacing(THREE, shader, facing || bothFaces);
          // Keep uniform definitions identical in both material variants.
          Object.assign(shader.uniforms, uniforms, staticRuns.get(mesh.material)?.uniforms, {homeExteriorSurface:{value:mesh.userData.category==='stairs'?1:0}});
          // The editor needs no room/window shader, especially on software WebGL.
          if (!enabled) return;
          shader.vertexShader = 'varying vec3 homeWorldPosition;\n' + shader.vertexShader.replace(
            '#include <project_vertex>',
            '#include <project_vertex>\nhomeWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;'
          );
          shader.fragmentShader = fragment + shader.fragmentShader.replace('#include <lights_fragment_begin>', lighting).replace('#include <lights_fragment_end>', 'irradiance += homeDaylightIrradiance();\n#include <lights_fragment_end>');
        };
        mesh.material.customProgramCacheKey = () => (enabled ? fragment : 'home-editor') +
          (sharedWall ? ':wall-sheen-facing-v1' : wall ? ':wall-sheen-v2' : '') +
          (!sharedWall && staticGlassFacing.has(mesh.material) ? ':glass-facing-v1' : '');
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
    update(points) {
      // Three.js stably sorts shadow casters before unshadowed point lights.
      // These lights have no projection maps, so traversal order breaks ties.
      // Zero-intensity fixtures retain their slots across on/off state changes.
      uniforms.homePointRooms.value.fill(0);
      uniforms.homeLitRooms.value.fill(0);
      let slot = 0;
      for (const shadowed of [true, false]) for (const point of points) {
        if (point.light?.visible && Boolean(point.light.castShadow) === shadowed) {
          const room = roomIds.get(point.item.room) || 0;
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
      if (packed) for (const state of staticRuns.values()) {
        state.uniforms.homeLightRunCount.value = filterRoomLightingRuns(state.unbounded ? null : state.bounds,
          packed.uniforms.homeRoomBounds.value,pointRooms,runs,runCount,
          state.uniforms.homeLightRunStarts.value,state.uniforms.homeLightRunEnds.value);
      }
    }
  };
}
