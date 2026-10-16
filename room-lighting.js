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

// Pack only within a conservative fragment-uniform allowance. Coordinates use
// the same five-decimal literals as the original GLSL before Float32 storage.
function packRoomLightingGeometry(rooms, windows, capacity, maxFragmentUniforms) {
  const edgeCount = rooms.reduce((sum, room) => sum + room.polygon.length, 0);
  // Scalars in arrays may each consume a vector. Reserve the existing light,
  // shadow, material and transform uniforms before adding packed geometry.
  const uniformVectors = 128 + capacity * 6 + rooms.length * 4 + edgeCount + windows.length * 2;
  if (!Number.isFinite(maxFragmentUniforms) || uniformVectors > maxFragmentUniforms) return null;
  const edges = new Float32Array(Math.max(1, edgeCount) * 4);
  const ranges = new Int32Array(Math.max(1, rooms.length) * 4);
  const bounds = new Float32Array(Math.max(1, rooms.length) * 4);
  const exterior = new Int32Array(Math.max(1, rooms.length));
  const segments = new Float32Array(Math.max(1, windows.length) * 4), windowIndices = [];
  const windowSlots = new Int32Array(windows.length).fill(-1);
  const number = value => Number(Number(value).toFixed(5));
  let edge = 0;
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
    ranges.set([start, edge, windowStart, windowIndices.length], index * 4);
    const xs = room.polygon.map(point => point[0]), zs = room.polygon.map(point => point[1]);
    bounds.set([Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)].map(number), index * 4);
    exterior[index] = room.exterior === true ? 1 : 0;
  });
  return {edgeCount, uniformVectors, windowIndices, windowSlots, uniforms: {
    homeRoomEdges:{value:edges}, homeRoomRanges:{value:ranges}, homeRoomBounds:{value:bounds},
    homeRoomExterior:{value:exterior}, homeWindowSegments:{value:segments},
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
  if (packed) Object.assign(uniforms, packed.uniforms);
  const geometryDeclarations = packed ? `
    uniform vec4 homeRoomEdges[${Math.max(1, packed.edgeCount)}];
    uniform ivec4 homeRoomRanges[${Math.max(1, rooms.length)}];
    uniform vec4 homeRoomBounds[${Math.max(1, rooms.length)}];
    uniform int homeRoomExterior[${Math.max(1, rooms.length)}];
    uniform vec4 homeWindowSegments[${Math.max(1, windows.length)}];
  ` : '';
  const glslNumber = n => Number(n).toFixed(5);
  const glslVector = p => `vec2(${p.map(glslNumber).join(',')})`;
  // Call sites already know their room. Separate functions prevent a shader
  // compiler from inlining every room's branch chain at every literal call.
  const roomDistances = packed ? `
    float homeRoomDistance(int room) {
      vec2 p = homeWorldPosition.xz;
      float distanceToRoom = 100000000.0;
      bool inside = false;
      ivec4 range = homeRoomRanges[room];
      for (int edge = range.x; edge < range.y; edge++) {
        vec4 segment = homeRoomEdges[edge];
        homeRoomEdge(p, segment.xy, segment.zw, distanceToRoom, inside);
      }
      float distance = sqrt(distanceToRoom);
      return inside ? -distance : distance;
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
  const fragment = `
    varying vec3 homeWorldPosition;
    uniform int homePointRooms[${capacity}];
    uniform int homeLightRunEnds[${capacity}];
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
      ${packed ? `for (int room = 0; room < ${rooms.length}; room++) {
        if (homeRoomExterior[room] != 0) exterior = max(exterior, 1.0-smoothstep(0.0,0.04,homeRoomDistance(room)));
      }` : rooms.filter(room=>room.exterior===true).map(room=>`exterior = max(exterior, 1.0-smoothstep(0.0,0.04,homeRoomDistance${roomIds.get(room.id)}()));`).join('\n')}
      float incoming = 0.0;
      if (homeDaylight > 0.0) {
        ${packed ? `for (int room = 0; room < ${rooms.length}; room++) {
          ivec4 range = homeRoomRanges[room];
          if (range.z < range.w && homeRoomDistance(room) <= 0.015) {
            for (int window = range.z; window < range.w; window++) {
              vec4 segment = homeWindowSegments[window];
              incoming += homeWindowTransmission[window] * homeWindowGlow(segment.xy, segment.zw);
            }
          }
        }` : rooms.map(room=>{
          const openings=windows.flatMap((window,i)=>window.room===room.id?[{...window,index:i}]:[]);
          return openings.length?`if (homeRoomDistance${roomIds.get(room.id)}() <= 0.015) {\n${openings.map(window=>`incoming += homeWindowTransmission[${window.index}] * homeWindowGlow(${glslVector(window.a)}, ${glslVector(window.b)});`).join('\n')}\n}`:'';
        }).join('\n')}
      }
      // Diffuse skylight enters at glazing, fades inward and cannot cross a room wall.
      // Outdoor surfaces retain a gentle base at night and brighten with the sun.
      return 3.14159265 * vec3(0.93,0.97,1.0) *
        (homeDaylight * min(incoming,1.05) + exterior * (0.16 + 1.1*homeDaylight));
    }
  `;
  // Cache each room once per fragment, rather than evaluating its polygon for
  // every light fixture in that room.
  // Unlit rooms are skipped without changing the shader's fixed light count.
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
  const lighting = transmissionCache + lightChunk.slice(0, pointStart) + boundedPointLighting + lightChunk.slice(pointEnd);
  return {
    capacity, geometryMode: packed ? 'packed' : 'literal', geometryUniformVectors: packed?.uniformVectors ?? null,
    attach(group, enabled) {
      group?.traverse(mesh => {
        if (!mesh.material?.isMeshStandardMaterial && !mesh.material?.isMeshLambertMaterial) return;
        const wall = mesh.userData.category === 'walls';
        mesh.material.onBeforeCompile = shader => {
          if (wall) applyWallSheen(shader);
          // Keep uniform definitions identical in both material variants.
          Object.assign(shader.uniforms, uniforms, {homeExteriorSurface:{value:mesh.userData.category==='stairs'?1:0}});
          // The editor needs no room/window shader, especially on software WebGL.
          if (!enabled) return;
          shader.vertexShader = 'varying vec3 homeWorldPosition;\n' + shader.vertexShader.replace(
            '#include <project_vertex>',
            '#include <project_vertex>\nhomeWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;'
          );
          shader.fragmentShader = fragment + shader.fragmentShader.replace('#include <lights_fragment_begin>', lighting).replace('#include <lights_fragment_end>', 'irradiance += homeDaylightIrradiance();\n#include <lights_fragment_end>');
        };
        mesh.material.customProgramCacheKey = () => (enabled ? fragment : 'home-editor') + (wall ? ':wall-sheen-v2' : '');
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
      let runCount = 0;
      for (let i = 1; i <= slot; i++) {
        if (i === slot || pointRooms[i] !== pointRooms[i - 1]) runs[runCount++] = i;
      }
      uniforms.homeLightRunCount.value = runCount;
    }
  };
}
