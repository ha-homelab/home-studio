// Advisory signal scores are not occupancy or confidence. Geometry stays local.
function createAssumedZoneView(THREE, scene, spec, requestRender) {
  const sourceLifetime = 5000, fadeLifetime = 15000;
  const group = new THREE.Group(), zones = new Map(), observation = {expires:0, deadline:0};
  let selected = '', selectedZone = '', visible = false, inspecting = false, disposed = false, timer = 0, latest = -1, fresh = false, glowing = false;
  const id = value => typeof value === 'string' && value.length > 0 && value.length <= 80;
  const timestamp = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
  const definitions = Array.isArray(spec?.zones) && spec.zones.length <= 64 ? spec.zones : [];
  const valid = typeof spec?.geometry_sha256 === 'string' && /^[a-f0-9]{64}$/.test(spec.geometry_sha256) && definitions.every((zone, index) => zone && id(zone.zone_id) && id(zone.room_id) &&
    definitions.findIndex(other => other?.zone_id === zone.zone_id) === index &&
    Array.isArray(zone.polygon_xz_m) && zone.polygon_xz_m.length >= 3 && zone.polygon_xz_m.length <= 64 &&
    zone.polygon_xz_m.every(point => Array.isArray(point) && point.length === 2 && point.every(n => Number.isFinite(n) && Math.abs(n) <= 1000)) &&
    zone.polygon_xz_m.every((point, i, polygon) => point.some((n, axis) => n !== polygon[(i + 1) % polygon.length][axis])) &&
    Math.abs(zone.polygon_xz_m.reduce((area, p, i, polygon) => {
      const q = polygon[(i + 1) % polygon.length]; return area + p[0] * q[1] - q[0] * p[1];
    }, 0)) > .000001);
  if (valid) for (const zone of definitions) {
    const polygon = zone.polygon_xz_m.map(([x, z]) => new THREE.Vector2(x, -z));
    const vector = p => `vec2(${p.x.toFixed(6)},${p.y.toFixed(6)})`;
    const bounds = new THREE.Box2().setFromPoints(polygon), center = bounds.getCenter(new THREE.Vector2()), half = bounds.getSize(new THREE.Vector2()).multiplyScalar(.5);
    const material = new THREE.ShaderMaterial({transparent:true, depthTest:true, depthWrite:false, toneMapped:false, side:THREE.DoubleSide,
      uniforms:{opacity:{value:0}, blue:{value:new THREE.Color(0x21b7ff)}},
      vertexShader:'varying vec2 point; void main(){point=position.xy;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader:`varying vec2 point; uniform float opacity; uniform vec3 blue;
        float edge(vec2 a, vec2 b){vec2 e=b-a;return length(point-a-e*clamp(dot(point-a,e)/max(dot(e,e),0.00000001),0.0,1.0));}
        void main(){float d=10000.0;
        ${polygon.map((p, i) => `d=min(d,edge(${vector(p)},${vector(polygon[(i + 1) % polygon.length])}));`).join('')}
        vec2 p=point-${vector(center)}, halfSize=${vector(half)};
        float radius=min(halfSize.x,halfSize.y)*0.6;
        vec2 q=abs(p)-halfSize+radius;
        float contour=length(max(q,0.0))+min(max(q.x,q.y),0.0)-radius;
        float ripple=0.06*sin(p.x*2.3+p.y*1.2)+0.04*sin(p.y*2.7-p.x);
        float pool=1.0-smoothstep(-0.24,0.08,contour+ripple);
        gl_FragColor=vec4(blue,opacity*pool*smoothstep(0.0,0.3,d));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        }`});
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(polygon)), material);
    mesh.rotation.x = -Math.PI / 2; mesh.position.y = .04; mesh.renderOrder = 3;
    mesh.visible = false; mesh.raycast = () => {};
    group.add(mesh); zones.set(zone.zone_id, {mesh, room:zone.room_id, level:0, expires:0, deadline:0});
  }
  group.visible = false; scene.add(group);
  function remaining(lease = observation) {
    // Either clock can expire this observation; neither can revive it. A new
    // source observation gets its own deadline after a corrected clock jump.
    const left = Math.max(0, Math.min(lease.expires - Date.now(), lease.deadline - performance.now()));
    if (!left) lease.expires = 0;
    return left;
  }
  function render(room = selected, zoneId) {
    if (disposed) return false;
    // Internal refreshes retain a region focus; changing rooms clears it.
    if (zoneId !== undefined) selectedZone = zones.has(zoneId) && (!room || zones.get(zoneId).room === room) ? zoneId : '';
    else if (room !== selected) selectedZone = '';
    selected = room;
    let left = remaining();
    const nextFresh = left > 0;
    const showing = visible && !document.hidden;
    let changed = group.visible !== showing, live = false, nextGlow = false;
    group.visible = showing;
    for (const [key, zone] of zones) {
      const zoneLeft = remaining(zone);
      nextGlow ||= zoneLeft > 0;
      if (zoneLeft) left = Math.min(left || Infinity, zoneLeft);
      const opacity = showing && (!selected || selected === zone.room) && (!selectedZone || selectedZone === key) ? .84 * zone.level * Math.min(1, zoneLeft / fadeLifetime) : 0;
      const uniform = zone.mesh.material.uniforms.opacity;
      changed ||= uniform.value !== opacity;
      uniform.value = opacity; zone.mesh.visible = opacity > 0; live ||= opacity > 0;
    }
    changed ||= fresh !== nextFresh || glowing !== nextGlow; fresh = nextFresh; glowing = nextGlow;
    clearTimeout(timer);
    // Visible glow fades at 20 Hz. Off-screen details tick at 1 Hz while open;
    // otherwise wake only at expiry. All paths share this one display timer.
    timer = showing && (fresh || glowing) ? setTimeout(refresh, Math.max(1, Math.ceil(Math.min(left, live ? 50 : inspecting && glowing ? 1000 : Infinity)))) : 0;
    return changed;
  }
  function refresh() { const changed = render(); if (!document.hidden && (changed || inspecting && glowing)) requestRender(changed); }
  function clear() { observation.expires = 0; for (const zone of zones.values()) zone.expires = 0; }
  function update(entity, connected) {
    if (disposed) return;
    const activity = entity?.zone_activity, observed = activity?.observed_at_ms, end = activity?.expires_at_ms;
    // Quiet or source expiry preserves already accepted display history, never
    // renews it. Missing/invalid data still withdraws the layer below.
    if (connected && valid && !entity?.restored && !activity &&
        (entity?.state === 'quiet' && entity.signal_status === 'quiet' || entity?.state === 'unknown' && entity.signal_status === 'source_expired')) { render(); return; }
    const entries = activity?.zones, current = Date.now();
    const seen = new Set();
    const newer = timestamp(observed) && observed > latest && observed <= current;
    if (newer) latest = observed;
    if (!connected || !valid || activity?.geometry_sha256 !== spec.geometry_sha256 ||
        entity?.restored || entity?.state !== 'active' || !timestamp(observed) ||
        !timestamp(end) || Math.abs(end - observed - sourceLifetime) > .001 || observed > current ||
        !Array.isArray(entries) || entries.length > zones.size || !entries.every(entry => {
          if (!entry || !zones.has(entry.id) || seen.has(entry.id) || !Number.isFinite(entry.score) || entry.score < 0 || entry.score > 1) return false;
          seen.add(entry.id); return true;
        })) clear();
    else if (newer && Math.min(end, observed + sourceLifetime) > current) {
      // The source window is immutable, including after disconnect or expiry.
      // Millisecond floats may round slightly; their tolerance cannot extend TTL.
      observation.expires = Math.min(end, observed + sourceLifetime);
      observation.deadline = performance.now() + Math.max(0, observation.expires - current);
      // Display memory lasts fifteen seconds from source time, not receipt.
      // Zero/missing scores do not interrupt or renew another region's fade.
      const tail = fadeLifetime - sourceLifetime;
      for (const entry of entries) if (entry.score > 0) Object.assign(zones.get(entry.id), {
        expires:observation.expires + tail, deadline:observation.deadline + tail, level:.8 + .2 * entry.score});
    }
    // The host already draws after state changes. Only the decay timer and
    // visibility event request an independent frame, avoiding duplicate draws.
    render();
  }
  document.addEventListener('visibilitychange', refresh);
  return {update, render,
    // Text alternatives use the same display window, independent of map filters.
    intensity(zoneId) { const zone = zones.get(zoneId); return !disposed && zone ? zone.level * Math.min(1, remaining(zone) / fadeLifetime) : 0; },
    secondsRemaining(zoneId) { const zone = zones.get(zoneId); return !disposed && zone ? Math.ceil(remaining(zone) / 1000) : 0; },
    get hasFreshObservation() { return !disposed && remaining() > 0; },
    setVisible(value, details = false) { if (!disposed) { visible = value === true; inspecting = details === true; render(); } },
    dispose() {
      if (disposed) return;
      disposed = true; clearTimeout(timer); document.removeEventListener('visibilitychange', refresh); scene.remove(group);
      for (const {mesh} of zones.values()) { mesh.geometry.dispose(); mesh.material.dispose(); }
      zones.clear(); group.clear();
    }
  };
}
