// Compute the view-dependent palette per vertex; no clock, texture or extra pass.
function applyWallSheen(shader) {
  shader.vertexShader = 'varying vec3 wallSheen;\n' + shader.vertexShader.replace(
    '#include <project_vertex>', `#include <project_vertex>
    vec3 wallView = isOrthographic ? vec3(0.0,0.0,1.0) : normalize(-mvPosition.xyz);
    float grazing = 1.0-abs(dot(normalize(transformedNormal),wallView));
    float band = 0.5+0.5*sin(dot(position,vec3(0.35,0.65,0.25)));
    float tint = clamp(0.75*grazing+0.25*band,0.0,1.0);
    wallSheen = mix(vec3(0.10,0.72,0.56),vec3(0.15,0.40,0.85),smoothstep(0.0,0.65,tint));
    wallSheen = mix(wallSheen,vec3(0.55,0.36,0.75),smoothstep(0.65,1.0,tint));`
  );
  shader.fragmentShader = 'varying vec3 wallSheen;\n' + shader.fragmentShader.replace(
    '#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb,wallSheen,0.48);'
  ).replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += wallSheen*0.16;');
}

// Softly confine each fixture's direct light to its room, retaining a short
// doorway spill. Full-height shadow geometry still blocks opaque walls/doors.
function createRoomLighting(THREE, rooms, capacity, windows) {
  capacity = Math.max(1, capacity);
  const roomIds = new Map(rooms.map((room, i) => [room.id, i + 1]));
  const uniforms = {
    homePointRooms: {value: new Int32Array(capacity)},
    homeDaylight: {value: 0},
    homeWindowTransmission: {value: new Float32Array(Math.max(1, windows.length)).fill(1)}
  };
  const glslNumber = n => Number(n).toFixed(5);
  const glslVector = p => `vec2(${p.map(glslNumber).join(',')})`;
  const zones = rooms.map((room, i) => `if (zone == ${i + 1}) {
    ${room.polygon.map((a, j) => `homeRoomEdge(p, ${glslVector(a)}, ${glslVector(room.polygon[(j + 1) % room.polygon.length])}, distanceToRoom, inside);`).join('\n')}
  }`).join('\n');
  const fragment = `
    varying vec3 homeWorldPosition;
    uniform int homePointRooms[${capacity}];
    uniform float homeDaylight;
    uniform float homeExteriorSurface;
    uniform float homeWindowTransmission[${Math.max(1, windows.length)}];
    void homeRoomEdge(vec2 p, vec2 a, vec2 b, inout float d, inout bool inside) {
      vec2 edge = b - a;
      d = min(d, length(p - a - edge * clamp(dot(p - a, edge) / dot(edge, edge), 0.0, 1.0)));
      if ((a.y > p.y) != (b.y > p.y)) {
        if (p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
      }
    }
    float homeRoomDistance(int zone) {
      vec2 p = homeWorldPosition.xz;
      float distanceToRoom = 10000.0;
      bool inside = false;
      ${zones}
      return inside ? -distanceToRoom : distanceToRoom;
    }
    float homeRoomTransmission(int zone) {
      if (zone == 0) return 1.0;
      float distanceToRoom = homeRoomDistance(zone);
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
      ${rooms.filter(room=>room.exterior===true).map(room=>`exterior = max(exterior, 1.0-smoothstep(0.0,0.04,homeRoomDistance(${roomIds.get(room.id)})));`).join('\n')}
      float incoming = 0.0;
      if (homeDaylight > 0.0) {
        ${rooms.map(room=>{
          const openings=windows.flatMap((window,i)=>window.room===room.id?[{...window,index:i}]:[]);
          return openings.length?`if (homeRoomDistance(${roomIds.get(room.id)}) <= 0.015) {\n${openings.map(window=>`incoming += homeWindowTransmission[${window.index}] * homeWindowGlow(${glslVector(window.a)}, ${glslVector(window.b)});`).join('\n')}\n}`:'';
        }).join('\n')}
      }
      // Diffuse skylight enters at glazing, fades inward and cannot cross a room wall.
      // Outdoor surfaces retain a gentle base at night and brighten with the sun.
      return 3.14159265 * vec3(0.93,0.97,1.0) *
        (homeDaylight * min(incoming,1.05) + exterior * (0.16 + 1.1*homeDaylight));
    }
  `;
  const lighting = THREE.ShaderChunk.lights_fragment_begin.replace(
    'getPointLightInfo( pointLight, geometryPosition, directLight );',
    'getPointLightInfo( pointLight, geometryPosition, directLight );\n directLight.color *= homeRoomTransmission(homePointRooms[ i ]);'
  );
  return {
    capacity,
    attach(group, enabled) {
      group?.traverse(mesh => {
        if (!mesh.material?.isMeshStandardMaterial) return;
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
        mesh.material.customProgramCacheKey = () => (enabled ? fragment : 'home-editor') + (wall ? ':wall-sheen-v1' : '');
        mesh.material.needsUpdate = true;
      });
    },
    environment(daylight, transmission) {
      uniforms.homeDaylight.value=daylight;
      transmission.forEach((value,i)=>uniforms.homeWindowTransmission.value[i]=value);
    },
    update(points) {
      // These are all scene point lights, in traversal order. Every emitter
      // casts shadows, so Three.js's stable shadow/map sort preserves this order.
      // Rebuild on every render: switching a light off removes its shader slot.
      uniforms.homePointRooms.value.fill(0);
      let slot = 0;
      for (const point of points) if (point.light?.visible) {
        uniforms.homePointRooms.value[slot++] = roomIds.get(point.item.room) || 0;
      }
    }
  };
}
