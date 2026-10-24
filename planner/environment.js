// Optional decorative surroundings. No entities, model edits, textures or network.
// All scenery stays outside the supplied bounds, which must include the full site.
export const ENVIRONMENT_PALETTES = {
  sage: { label: 'Sage garden', lawn: '#6f8f7a', hedge: '#557463', leaf: '#7f9b78', leafLight: '#a2b595', path: '#afb5a5', road: '#697d75', trunk: '#8e8270', car: '#d6ba92' },
  meadow: { label: 'Summer meadow', lawn: '#c9d3a7', hedge: '#819168', leaf: '#91a477', leafLight: '#b2be87', path: '#e6ddc5', road: '#a9aaa0', trunk: '#97806b', car: '#b4cbd0' },
  dusk: { label: 'Blue dusk', lawn: '#aabbb8', hedge: '#697e7c', leaf: '#829998', leafLight: '#a0b4af', path: '#d5d9d3', road: '#939f9e', trunk: '#817c79', car: '#d4b8b0' },
};

// All detail is bounded, reusable solid geometry. This deterministic layout is
// deliberately independent of the traffic RNG, so visual work cannot change a
// saved scene's arrival times, speeds, colours or animation counters.
function environmentGeometry(THREE, shape) {
  if (shape === 'box') return new THREE.BoxGeometry(1, 1, 1);
  if (shape === 'sphere') return new THREE.SphereGeometry(.5, 7, 4);
  const positions = [], indices = [], colours = [];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = a => { const length = Math.hypot(...a); return a.map(v => v / length); };
  const point = (p, shade = 1) => { const i = positions.length / 3; positions.push(...p); colours.push(...(Array.isArray(shade) ? shade : [shade, shade, shade])); return i; };
  function tube(a, b, r, top = r, segments = 8, shade = 1) {
    const axis = unit(b.map((v, k) => v - a[k])), u = unit(cross(axis, Math.abs(axis[1]) < .9 ? [0, 1, 0] : [1, 0, 0])), v = cross(axis, u);
    const offset = positions.length / 3;
    for (const [origin, radius] of [[a, r], [b, top]]) for (let i = 0; i < segments; i++) {
      const angle = i * Math.PI * 2 / segments;
      point(origin.map((c, k) => c + radius * (u[k] * Math.cos(angle) + v[k] * Math.sin(angle))), shade);
    }
    for (let i = 0; i < segments; i++) { const j = (i + 1) % segments; indices.push(offset + i, offset + j, offset + j + segments, offset + i, offset + j + segments, offset + i + segments); }
    // Separate cap vertices keep branch/tire side normals smooth.
    for (const [origin, radius, sign] of [[a, r, -1], [b, top, 1]]) {
      const center = point(origin, shade), start = positions.length / 3;
      for (let i = 0; i < segments; i++) { const angle = i * Math.PI * 2 / segments; point(origin.map((c, k) => c + radius * (u[k] * Math.cos(angle) + v[k] * Math.sin(angle))), shade); }
      for (let i = 0; i < segments; i++) { const j = (i + 1) % segments; indices.push(...(sign > 0 ? [center, start + i, start + j] : [center, start + j, start + i])); }
    }
  }
  const clusters = Array.from({ length: 9 }, (_, i) => {
    const angle = i * 2.399963229728653, ring = i < 6 ? .23 : .1;
    return [ring * Math.cos(angle), i < 6 ? -.12 + (i % 3) * .12 : (i - 7) * .28, ring * Math.sin(angle)];
  });
  const leaves = [], twigs = [], crownVertices = [];
  if (shape === 'tree-crown' || shape === 'tree-branches') {
    for (const [cluster, c] of clusters.entries()) for (let twig = 0; twig < 5; twig++) {
      const angle = cluster * 1.17 + twig * 2.399963229728653;
      const offset = [.20 * Math.cos(angle), .16 * Math.sin(twig * 1.3 + cluster), .20 * Math.sin(angle)];
      twigs.push([c, c.map((v, k) => v + offset[k])]);
      for (let i = 0; i < 8; i++) {
        const side = i % 2 ? -1 : 1, yaw = angle + side * .75, tilt = .7 * Math.sin(i * 2.7 + cluster);
        const along = unit([Math.cos(yaw), .30 * Math.sin(i * 1.71), Math.sin(yaw)]), baseAcross = unit(cross(along, [0, 1, 0])), up = cross(baseAcross, along);
        const across = baseAcross.map((v, k) => v * Math.cos(tilt) + up[k] * Math.sin(tilt)), normal = cross(across, along);
        const length = .034 + .010 * (1 + Math.sin(i * 2.7 + cluster)), width = length * .42;
        const attachment = c.map((v, k) => v + offset[k] * (.16 + i * .11)), center = attachment.map((v, k) => v + along[k] * length);
        const vertices = [];
        for (let j = 0; j < 10; j++) {
          const a = j * Math.PI * 2 / 10;
          vertices.push(center.map((v, k) => v + along[k] * Math.cos(a) * length + across[k] * Math.sin(a) * width));
        }
        for (const crown of [.075, -.012]) vertices.push(center.map((v, k) => v + normal[k] * length * crown));
        leaves.push(vertices); crownVertices.push(...vertices);
      }
    }
  }
  const crownLow = [0, 1, 2].map(k => Math.min(...crownVertices.map(p => p[k]))), crownHigh = [0, 1, 2].map(k => Math.max(...crownVertices.map(p => p[k])));
  // The previous seven-sided sphere had slightly asymmetric sampled bounds.
  // Match that actual envelope, not a larger idealized half-unit sphere.
  const oldCrown = new THREE.SphereGeometry(.5, 7, 4); oldCrown.computeBoundingBox();
  const targetLow = oldCrown.boundingBox.min.toArray(), targetHigh = oldCrown.boundingBox.max.toArray(); oldCrown.dispose();
  const crownPoint = p => p.map((v, k) => targetLow[k] + (v - crownLow[k]) / (crownHigh[k] - crownLow[k]) * (targetHigh[k] - targetLow[k]));
  const treePoint = p => crownPoint(p).map((v, k) => v * [1.05, 1.35, 1.05][k] + (k === 1 ? 1.8 : 0));
  if (shape === 'tree-crown') {
    for (const vertices of leaves) {
      const offset = positions.length / 3;
      // Each thin closed leaf attaches to a twig. A ten-sided curved outline
      // and shared normals avoid the diamond/paper-flock appearance.
      for (const p of vertices) point(crownPoint(p));
      for (let j = 0; j < 10; j++) { const next = (j + 1) % 10; indices.push(offset + 10, offset + next, offset + j, offset + 11, offset + j, offset + next); }
    }
  } else if (shape === 'tree-branches') {
    tube([0, 0, 0], [0, 1.55, 0], .055, .022, 10);
    tube([0, 1.55, 0], [0, 2.28, 0], .022, .004);
    for (const [i, c] of clusters.entries()) {
      const start = [0, 1.2 + .08 * (i % 3), 0], end = treePoint(c);
      const joint = end.map((v, k) => start[k] * .35 + v * .65);
      tube(start, joint, .025, .013); tube(joint, end, .013, .005, 7);
    }
    for (const [a, b] of twigs) tube(treePoint(a), treePoint(b), .004, .0013, 5);
    // Keep the old trunk instance matrix; branch geometry is authored in metres.
    for (let i = 0; i < positions.length; i += 3) { positions[i] /= .11; positions[i + 1] = (Math.min(2.475, positions[i + 1]) - .68) / 1.36; positions[i + 2] /= .11; }
  } else if (shape === 'car-body' || shape === 'car-glass') {
    const body = shape === 'car-body', rings = body ? [-.499, -.47, -.39, -.30, 0, .28, .40, .47, .499] : [-.5, -.40, -.25, .16, .32, .5], segments = 24;
    for (const x of rings) for (let j = 0; j < segments; j++) {
      const angle = j * Math.PI * 2 / segments, c = Math.cos(angle), s = Math.sin(angle);
      const end = Math.min(1, (1 - Math.abs(x) * 2) * 5 + .74);
      let y = Math.sign(c) * Math.abs(c) ** .40 * .5, z = Math.sign(s) * Math.abs(s) ** .40 * .5 * end;
      if (body) {
        y *= end;
        // Both wheel arches rise into the lower side panels.
        if (y < 0) y += .26 * Math.exp(-(((Math.abs(x) - .31) / .095) ** 4)) * Math.abs(z) * 2;
      } else {
        const roof = Math.max(.18, 1 - Math.max(0, x - .14) * 1.9 - Math.max(0, -.27 - x) * 1.7);
        y = (y + .5) * roof - .5; z *= 1 - .21 * (y + .5);
      }
      point([x, y, z]);
    }
    for (let ring = 0; ring < rings.length - 1; ring++) for (let j = 0; j < segments; j++) { const a = ring * segments + j, b = ring * segments + (j + 1) % segments; indices.push(a, b, b + segments, a, b + segments, a + segments); }
    for (const [ring, sign] of [[0, -1], [rings.length - 1, 1]]) { const centroid = [0, 1, 2].map(k => Array.from({ length: segments }, (_, j) => positions[(ring * segments + j) * 3 + k]).reduce((a, b) => a + b, 0) / segments), center = point(centroid); for (let j = 0; j < segments; j++) { const a = ring * segments + j, b = ring * segments + (j + 1) % segments; indices.push(...(sign < 0 ? [center, b, a] : [center, a, b])); } }
    if (body) {
      // Painted roof and four slender pillars belong to the same tinted body
      // buffer, keeping exactly two traffic-colour instances and one draw call.
      const roof = new THREE.BoxGeometry(.40 / 1.55, .018 / .32, .42 / .65, 1, 1, 1);
      roof.translate(-.08 / 1.55, (.661 - .30) / .32, 0);
      const off = positions.length / 3, pos = roof.getAttribute('position');
      for (let i = 0; i < pos.count; i++) point([pos.getX(i), pos.getY(i), pos.getZ(i)]);
      for (const i of roof.index.array) indices.push(off + i);
      roof.dispose();
      for (const side of [-1, 1]) for (const front of [-1, 1]) {
        const a = [front > 0 ? .32 : -.40, .455, side * .26], b = [front > 0 ? .12 : -.28, .657, side * .205], start = positions.length;
        tube(a, b, .010, .010, 6);
        for (let i = start; i < positions.length; i++) { const k = (i - start) % 3; positions[i] = (positions[i] - (k === 1 ? .3 : 0)) / [1.55, .32, .65][k]; }
      }
    } else {
      // Lamps and grille share the existing glazing batch. Vertex colour
      // preserves their distinct surface roles without new draw calls.
      const base = new THREE.Color('#647c83');
      function detail(position, size, colour) {
        const box = new THREE.BoxGeometry(...size), tint = new THREE.Color(colour), off = positions.length / 3;
        box.translate(...position); const p = box.getAttribute('position');
        for (let i = 0; i < p.count; i++) point([(p.getX(i) + .06) / .78, (p.getY(i) - .56) / .22, p.getZ(i) / .57], [tint.r / base.r, tint.g / base.g, tint.b / base.b]);
        for (const i of box.index.array) indices.push(off + i);
        box.dispose();
      }
      for (const side of [-1, 1]) {
        detail([.772, .36, side * .22], [.006, .055, .11], '#e8e5cf');
        detail([-.772, .34, side * .23], [.006, .045, .09], '#8b2925');
      }
      detail([.773, .25, 0], [.004, .075, .27], '#343d3b');
    }
  } else if (shape === 'car-wheel') {
    // Existing wheel instance dimensions encode width/height/depth. Cylinder
    // axis Z replaces the old square blocks without moving any wheel anchor.
    const profile = [[-.43, .20], [-.5, .26], [-.5, .34], [-.44, .47], [-.36, .5], [.36, .5], [.44, .47], [.5, .34], [.5, .26], [.43, .20]], segments = 24;
    for (const [z, r] of profile) for (let i = 0; i < segments; i++) { const angle = i * Math.PI * 2 / segments; point([r * Math.cos(angle), r * Math.sin(angle), z], .28); }
    for (let row = 0; row < profile.length; row++) for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments, a = row * segments + i, b = row * segments + next, c = ((row + 1) % profile.length) * segments + i, d = ((row + 1) % profile.length) * segments + next;
      indices.push(a, b, d, a, d, c);
    }
    // Recessed hubs have no coplanar overlap with the tyre sidewalls.
    tube([0, 0, -.435], [0, 0, .435], .24, .24, 20, 1);
  } else return new THREE.CylinderGeometry(.5, .5, 1, 16);
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  result.setIndex(indices); result.computeVertexNormals(); result.computeBoundingBox(); result.computeBoundingSphere();
  if (shape === 'car-wheel' || shape === 'car-glass') result.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  return result;
}

export function createEnvironmentLayer(THREE, { scene, bounds, elevation = 0, requestRender = () => {}, frameInterval = 180, active = true, settings = {}, seed = settings.seed, roadSide = settings.road_side, visibilityElement = null, document: doc = globalThis.document, window: win = globalThis.window } = {}) {
  const group = new THREE.Group(); group.name = 'decorative-surroundings'; group.visible = false; scene.add(group);
  const media = win?.matchMedia?.('(prefers-reduced-motion: reduce)');
  const state = { enabled: false, motion: false, palette: 'sage' };
  const geometry = new Map(), materials = new Map(), batches = [], actors = [];
  const dummy = new THREE.Object3D(), local = new THREE.Matrix4(), actorMatrix = new THREE.Matrix4();
  const trafficSeed = Number.isFinite(seed) ? seed >>> 0 : Math.floor(Math.random() * 0x100000000);
  // Site configuration is fixed for this layer, independent of UI preferences.
  const roadDirection = roadSide === 'maxZ' ? 1 : -1;
  let randomState = trafficSeed, trafficColors = [];
  let area, base = elevation, timer = 0, elapsed = 0, disposed = false, suspended = false, inViewport = true, dirty = true;
  const tickMs = Math.max(180, Math.min(2000, Number.isFinite(frameInterval) ? frameInterval : 180)); // Never a permanent RAF loop.
  function random() {
    // Seed once per layer; rebuilding a palette replays the same bounded traffic.
    let value = randomState = (randomState + 0x6D2B79F5) >>> 0;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 0x100000000;
  }
  function validBounds(value) {
    if (!value || !['minX', 'maxX', 'minZ', 'maxZ'].every(key => Number.isFinite(value[key]))) throw new Error('Surroundings require finite site bounds.');
    if (value.minX > value.maxX || value.minZ > value.maxZ) throw new Error('Surroundings require ordered site bounds.');
    // An unfinished draft may contain just a point or a straight wall.
    return { minX: value.minX - (value.minX === value.maxX ? .25 : 0), maxX: value.maxX + (value.minX === value.maxX ? .25 : 0), minZ: value.minZ - (value.minZ === value.maxZ ? .25 : 0), maxZ: value.maxZ + (value.minZ === value.maxZ ? .25 : 0) };
  }
  function stop() { if (timer) win.clearTimeout(timer); timer = 0; }
  function running() { return !disposed && !suspended && inViewport && active && state.enabled && state.motion && !doc?.hidden && !media?.matches; }
  function schedule() {
    stop();
    if (running()) timer = win.setTimeout(() => {
      timer = 0;
      if (!running()) return;
      elapsed += tickMs / 1000; moveActors(); requestRender(true); schedule();
    }, tickMs);
  }
  function clear() {
    for (const batch of batches) { group.remove(batch.mesh); batch.mesh.dispose(); }
    batches.length = 0; actors.length = 0;
    for (const resource of geometry.values()) resource.dispose();
    for (const resource of materials.values()) resource.dispose();
    geometry.clear(); materials.clear();
  }
  function build() {
    clear(); dirty = false; elapsed = 0; randomState = trafficSeed;
    const p = ENVIRONMENT_PALETTES[state.palette], entries = new Map();
    trafficColors = [p.car, '#d8ddd2', '#9caeaa', '#a8a2ae'].map(color => new THREE.Color(color));
    const { minX, maxX, minZ, maxZ } = area, width = maxX - minX, depth = maxZ - minZ, center = (minX + maxX) / 2;
    const roadEdge = roadDirection === 1 ? maxZ : minZ;
    function part(shape, color, position, scale, actor = null, rotation = 0, tint = false) {
      const key = shape + ':' + color + (tint ? ':traffic' : '');
      if (!entries.has(key)) entries.set(key, { shape, color, parts: [] });
      dummy.position.set(...position); dummy.scale.set(...scale); dummy.rotation.set(0, rotation, 0); dummy.updateMatrix();
      entries.get(key).parts.push({ matrix: dummy.matrix.clone(), actor, tint });
    }
    // Three disjoint garden strips, with no slab or scenery beneath the house.
    part('box', p.lawn, [minX - 2, -.07, (minZ + maxZ) / 2], [3, .1, depth + 5]);
    part('box', p.lawn, [maxX + 2, -.07, (minZ + maxZ) / 2], [3, .1, depth + 5]);
    for (const x of [minX - 2, maxX + 2]) {
      // A fine raised edge gives the planting beds a readable, restrained contour.
      for (const side of [-1, 1]) part('box', p.hedge, [x + side * 1.44, -.005, (minZ + maxZ) / 2], [.05, .035, depth + 4.9]);
      for (const z of [minZ - 2.44, maxZ + 2.44]) part('box', p.hedge, [x, -.005, z], [2.9, .035, .05]);
    }
    part('box', p.lawn, [center, -.07, roadEdge + roadDirection * 2], [width + 1, .1, 3]);
    part('box', p.path, [center, -.005, roadEdge + roadDirection * 4.1], [width + 9, .06, .7]);
    part('box', p.road, [center, -.025, roadEdge + roadDirection * 6], [width + 9, .06, 2.8]);
    const dashCount = Math.min(16, Math.max(3, Math.floor((width + 8) / 2)));
    for (let i = 0; i < dashCount; i++) part('box', '#d8ddd5', [minX - 3 + i * (width + 6) / Math.max(1, dashCount - 1), .015, roadEdge + roadDirection * 6], [.7, .015, .045]);
    for (const x of [minX - 3.2, maxX + 3.2]) {
      part('box', p.hedge, [x, .28, (minZ + maxZ) / 2], [.38, .56, depth + 3.4]);
      for (let i = 0; i < 3; i++) {
        const z = minZ - .5 + i * (depth + 1) / 2;
        part('tree-branches', p.trunk, [x + (x < minX ? 1 : -1), .68, z], [.11, 1.36, .11]);
        part('tree-crown', i % 2 ? p.leaf : p.leafLight, [x + (x < minX ? 1 : -1), 1.8, z], [1.05, 1.35, 1.05]);
      }
    }
    // Cars have a dedicated lane beyond the site. Their whole envelope remains outside it.
    for (let i = 0; i < 2; i++) {
      const speed = .22 + random() * .24, span = width + 6;
      // Start partway through a pass so static surroundings also show both cars.
      const startAt = -(span / speed) * (.05 + random() * .7);
      // Keep the +X car on the +Z lane on either side of the site.
      const actor = { kind: 'car', x: center, z: roadEdge + roadDirection * 6 + (i ? -.65 : .65), direction: i ? -1 : 1, start: minX - 3, span, speed, startAt, endAt: startAt + span / speed, entryDelay: 0, color: Math.floor(random() * trafficColors.length), cycle: 0, visible: true, parts: [] };
      actors.push(actor);
      part('car-body', '#ffffff', [0, .3, 0], [1.55, .32, .65], actor, 0, true);
      part('car-glass', '#647c83', [-.06, .56, 0], [.78, .22, .57], actor);
      for (const x of [-.48, .48]) for (const z of [-.34, .34]) part('car-wheel', '#66706c', [x, .14, z], [.23, .23, .1], actor);
    }
    for (let i = 0; i < 3; i++) {
      const actor = { kind: 'animal', x: maxX + 1.6, z: minZ + depth * (.2 + i * .3), offset: i * 2.1, parts: [] };
      actors.push(actor);
      const fur = i === 1 ? '#d6c9b4' : '#eee9dc';
      part('sphere', fur, [0, .2, 0], [.38, .25, .22], actor);
      part('sphere', fur, [.16, .31, 0], [.18, .19, .18], actor);
      for (const z of [-.045, .045]) part('sphere', fur, [.17, .47, z], [.065, .22, .06], actor);
      part('sphere', '#c3baa8', [-.2, .22, 0], [.1, .1, .1], actor);
    }
    for (const entry of entries.values()) {
      if (!geometry.has(entry.shape)) geometry.set(entry.shape, environmentGeometry(THREE, entry.shape));
      if (!materials.has(entry.color)) materials.set(entry.color, new THREE.MeshStandardMaterial({ color: entry.color,
        roughness: entry.shape === 'car-glass' ? .24 : entry.shape === 'car-body' ? .36 : .88,
        metalness: entry.shape === 'car-body' ? .12 : 0, vertexColors: entry.shape === 'car-wheel' || entry.shape === 'car-glass' }));
      const mesh = new THREE.InstancedMesh(geometry.get(entry.shape), materials.get(entry.color), entry.parts.length);
      mesh.name = 'surroundings-' + entry.shape; mesh.frustumCulled = false;
      mesh.castShadow = entry.shape.startsWith('tree-') || entry.shape.startsWith('car-') || entry.shape === 'sphere';
      mesh.receiveShadow = true;
      entry.parts.forEach((part, index) => {
        mesh.setMatrixAt(index, part.matrix);
        // Allocate the shared instance-color buffer at build time, never during motion.
        if (part.tint) mesh.setColorAt(index, trafficColors[part.actor.color]);
        if (part.actor) part.actor.parts.push({ mesh, index, matrix: part.matrix, tint: part.tint });
      });
      group.add(mesh); batches.push({ mesh });
    }
    group.position.y = base; moveActors();
  }
  function moveActors() {
    for (const actor of actors) {
      let x = actor.x, z = actor.z, angle = 0, scale = 1;
      if (actor.kind === 'car') {
        if (elapsed >= actor.endAt) {
          actor.entryDelay = 2 + random() * 7;
          actor.startAt = actor.endAt + actor.entryDelay;
          actor.speed = .22 + random() * .24;
          actor.endAt = actor.startAt + actor.span / actor.speed;
          actor.color = (actor.color + 1 + Math.floor(random() * (trafficColors.length - 1))) % trafficColors.length;
          actor.cycle++;
          for (const part of actor.parts) if (part.tint) {
            part.mesh.setColorAt(part.index, trafficColors[actor.color]);
            part.mesh.instanceColor.needsUpdate = true;
          }
        }
        actor.visible = elapsed >= actor.startAt;
        scale = actor.visible ? 1 : 0;
        const fraction = Math.max(0, Math.min(1, (elapsed - actor.startAt) * actor.speed / actor.span));
        x = actor.start + actor.span * (actor.direction === 1 ? fraction : 1 - fraction);
        angle = actor.direction === 1 ? 0 : Math.PI;
      } else {
        x += .25 * Math.sin(elapsed * .17 + actor.offset);
        z += .22 * Math.cos(elapsed * .17 + actor.offset);
        angle = .25 * Math.sin(elapsed * .17 + actor.offset);
      }
      dummy.position.set(x, 0, z); dummy.rotation.set(0, angle, 0); dummy.scale.set(scale, scale, scale); dummy.updateMatrix(); actorMatrix.copy(dummy.matrix);
      for (const part of actor.parts) { local.multiplyMatrices(actorMatrix, part.matrix); part.mesh.setMatrixAt(part.index, local); part.mesh.instanceMatrix.needsUpdate = true; }
    }
  }
  function setSettings(next = {}) {
    if (disposed) return;
    if ('enabled' in next) state.enabled = next.enabled === true;
    if ('motion' in next) state.motion = next.motion === true;
    if (Object.hasOwn(ENVIRONMENT_PALETTES, next.palette) && next.palette !== state.palette) { state.palette = next.palette; dirty = true; }
    if (state.enabled && dirty) build();
    group.visible = state.enabled;
    schedule(); requestRender();
  }
  function setBounds(next, nextElevation = base) {
    const candidate = validBounds(next);
    if (!Number.isFinite(nextElevation)) throw new Error('Surroundings require finite ground elevation.');
    if (JSON.stringify(candidate) === JSON.stringify(area) && nextElevation === base) return;
    area = candidate; base = nextElevation; dirty = true;
    if (state.enabled) { build(); requestRender(); }
  }
  const visibility = () => schedule(), hide = () => { suspended = true; stop(); }, show = () => { suspended = false; schedule(); };
  const observer = visibilityElement && win?.IntersectionObserver ? new win.IntersectionObserver(entries => {
    inViewport = entries.some(entry => entry.isIntersecting); schedule();
  }) : null;
  observer?.observe(visibilityElement);
  doc?.addEventListener('visibilitychange', visibility); media?.addEventListener('change', visibility);
  win?.addEventListener('pagehide', hide); win?.addEventListener('pageshow', show);
  setBounds(bounds, elevation); setSettings(settings);
  return {
    setSettings, setBounds,
    setActive(value) { active = value === true; schedule(); },
    get settings() { return { ...state }; },
    get stats() { return { enabled: state.enabled, moving: running(), drawCalls: group.visible ? batches.length : 0, actors: actors.length, timerPending: !!timer, frameInterval: tickMs, elapsed, elevation: base, bounds: { ...area }, roadSide: roadDirection === 1 ? 'maxZ' : 'minZ', trafficSeed, traffic: actors.filter(actor => actor.kind === 'car').map(({ speed, entryDelay, color, cycle, visible }) => ({ speed, entryDelay, color, cycle, visible })) }; },
    dispose() { if (disposed) return; disposed = true; stop(); observer?.disconnect(); clear(); scene.remove(group); doc?.removeEventListener('visibilitychange', visibility); media?.removeEventListener('change', visibility); win?.removeEventListener('pagehide', hide); win?.removeEventListener('pageshow', show); },
  };
}

export function createEnvironmentControls(container, { getLayer, t = value => value, onChange = () => {} } = {}) {
  const doc = container.ownerDocument, panel = doc.createElement('details'); panel.className = 'environment-controls';
  const labels = [], label = (element, key) => { labels.push([element, key]); element.textContent = t(key); return element; };
  const summary = label(doc.createElement('summary'), 'Surroundings'); panel.append(summary);
  const body = doc.createElement('div'); body.className = 'environment-options'; panel.append(body);
  const inputs = {};
  for (const [key, text] of [['enabled', 'Show garden surroundings'], ['motion', 'Decorative motion']]) {
    const row = doc.createElement('label'), input = doc.createElement('input'); input.type = 'checkbox'; input.dataset.environment = key; inputs[key] = input;
    row.append(input, label(doc.createElement('span'), text)); body.append(row);
  }
  const row = doc.createElement('label'); row.append(label(doc.createElement('span'), 'Garden palette')); const palette = doc.createElement('select'); palette.dataset.environment = 'palette'; inputs.palette = palette;
  for (const [value, entry] of Object.entries(ENVIRONMENT_PALETTES)) { const option = label(doc.createElement('option'), entry.label); option.value = value; palette.append(option); }
  row.append(palette); body.append(row);
  body.append(label(doc.createElement('small'), 'Decorative only. Motion pauses when hidden or reduced motion is preferred.'));
  function refresh() { for (const [element, key] of labels) element.textContent = t(key); const settings = getLayer()?.settings || { enabled: false, motion: false, palette: 'sage' }; inputs.enabled.checked = settings.enabled; inputs.motion.checked = settings.motion; inputs.palette.value = settings.palette; inputs.motion.disabled = inputs.palette.disabled = !settings.enabled; }
  function position() {
    if (!panel.open) return;
    // Escape scrolling toolbar clipping, including the narrow Home layout.
    const win = doc.defaultView, anchor = summary.getBoundingClientRect();
    const width = Math.min(275, win.innerWidth - 24);
    body.style.position = 'fixed'; body.style.width = width + 'px'; body.style.right = 'auto';
    body.style.left = Math.max(12, Math.min(win.innerWidth - width - 12, anchor.right - width)) + 'px';
    body.style.top = Math.max(12, Math.min(win.innerHeight - body.offsetHeight - 12, anchor.bottom + 5)) + 'px';
  }
  panel.addEventListener('change', () => { const settings = { enabled: inputs.enabled.checked, motion: inputs.motion.checked, palette: inputs.palette.value }; getLayer()?.setSettings(settings); onChange(settings); refresh(); });
  panel.addEventListener('toggle', () => { refresh(); position(); });
  doc.defaultView.addEventListener('resize', position); doc.addEventListener('scroll', position, true);
  container.append(panel); refresh();
  return { refresh, element: panel };
}
