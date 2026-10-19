// Optional decorative surroundings. No entities, model edits, textures or network.
// All scenery stays outside the supplied bounds, which must include the full site.
export const ENVIRONMENT_PALETTES = {
  sage: { label: 'Sage garden', lawn: '#6f8f7a', hedge: '#557463', leaf: '#7f9b78', leafLight: '#a2b595', path: '#afb5a5', road: '#697d75', trunk: '#8e8270', car: '#d6ba92' },
  meadow: { label: 'Summer meadow', lawn: '#c9d3a7', hedge: '#819168', leaf: '#91a477', leafLight: '#b2be87', path: '#e6ddc5', road: '#a9aaa0', trunk: '#97806b', car: '#b4cbd0' },
  dusk: { label: 'Blue dusk', lawn: '#aabbb8', hedge: '#697e7c', leaf: '#829998', leafLight: '#a0b4af', path: '#d5d9d3', road: '#939f9e', trunk: '#817c79', car: '#d4b8b0' },
};

export function createEnvironmentLayer(THREE, { scene, bounds, elevation = 0, requestRender = () => {}, frameInterval = 180, active = true, settings = {}, visibilityElement = null, document: doc = globalThis.document, window: win = globalThis.window } = {}) {
  const group = new THREE.Group(); group.name = 'decorative-surroundings'; group.visible = false; scene.add(group);
  const media = win?.matchMedia?.('(prefers-reduced-motion: reduce)');
  const state = { enabled: false, motion: false, palette: 'sage' };
  const geometry = new Map(), materials = new Map(), batches = [], actors = [];
  const dummy = new THREE.Object3D(), local = new THREE.Matrix4(), actorMatrix = new THREE.Matrix4();
  let area, base = elevation, timer = 0, elapsed = 0, disposed = false, suspended = false, inViewport = true, dirty = true;
  const tickMs = Math.max(180, Math.min(2000, Number.isFinite(frameInterval) ? frameInterval : 180)); // Never a permanent RAF loop.
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
    clear(); dirty = false; elapsed = 0;
    const p = ENVIRONMENT_PALETTES[state.palette], entries = new Map();
    const { minX, maxX, minZ, maxZ } = area, width = maxX - minX, depth = maxZ - minZ, center = (minX + maxX) / 2;
    function part(shape, color, position, scale, actor = null, rotation = 0) {
      const key = shape + ':' + color;
      if (!entries.has(key)) entries.set(key, { shape, color, parts: [] });
      dummy.position.set(...position); dummy.scale.set(...scale); dummy.rotation.set(0, rotation, 0); dummy.updateMatrix();
      entries.get(key).parts.push({ matrix: dummy.matrix.clone(), actor });
    }
    // Three disjoint garden strips, with no slab or scenery beneath the house.
    part('box', p.lawn, [minX - 2, -.07, (minZ + maxZ) / 2], [3, .1, depth + 5]);
    part('box', p.lawn, [maxX + 2, -.07, (minZ + maxZ) / 2], [3, .1, depth + 5]);
    for (const x of [minX - 2, maxX + 2]) {
      // A fine raised edge gives the planting beds a readable, restrained contour.
      for (const side of [-1, 1]) part('box', p.hedge, [x + side * 1.44, -.005, (minZ + maxZ) / 2], [.05, .035, depth + 4.9]);
      for (const z of [minZ - 2.44, maxZ + 2.44]) part('box', p.hedge, [x, -.005, z], [2.9, .035, .05]);
    }
    part('box', p.lawn, [center, -.07, minZ - 2], [width + 1, .1, 3]);
    part('box', p.path, [center, -.005, minZ - 4.1], [width + 9, .06, .7]);
    part('box', p.road, [center, -.025, minZ - 6], [width + 9, .06, 2.8]);
    const dashCount = Math.min(16, Math.max(3, Math.floor((width + 8) / 2)));
    for (let i = 0; i < dashCount; i++) part('box', '#d8ddd5', [minX - 3 + i * (width + 6) / Math.max(1, dashCount - 1), .015, minZ - 6], [.7, .015, .045]);
    for (const x of [minX - 3.2, maxX + 3.2]) {
      part('box', p.hedge, [x, .28, (minZ + maxZ) / 2], [.38, .56, depth + 3.4]);
      for (let i = 0; i < 3; i++) {
        const z = minZ - .5 + i * (depth + 1) / 2;
        part('cylinder', p.trunk, [x + (x < minX ? 1 : -1), .68, z], [.11, 1.36, .11]);
        part('sphere', i % 2 ? p.leaf : p.leafLight, [x + (x < minX ? 1 : -1), 1.8, z], [1.05, 1.35, 1.05]);
      }
    }
    // Cars have a dedicated lane beyond the site. Their whole envelope remains outside it.
    for (let i = 0; i < 2; i++) {
      const actor = { kind: 'car', x: center, z: minZ - (i ? 6.65 : 5.35), offset: i * .53, direction: i ? -1 : 1, start: minX - 3, span: width + 6, parts: [] };
      actors.push(actor);
      part('box', i ? '#d8ddd2' : p.car, [0, .3, 0], [1.55, .32, .65], actor);
      part('box', '#647c83', [-.06, .56, 0], [.78, .22, .57], actor);
      for (const x of [-.48, .48]) for (const z of [-.34, .34]) part('box', '#66706c', [x, .14, z], [.28, .23, .1], actor);
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
      if (!geometry.has(entry.shape)) geometry.set(entry.shape, entry.shape === 'box' ? new THREE.BoxGeometry(1, 1, 1) : entry.shape === 'cylinder' ? new THREE.CylinderGeometry(.5, .5, 1, 6) : new THREE.SphereGeometry(.5, 7, 4));
      if (!materials.has(entry.color)) materials.set(entry.color, new THREE.MeshBasicMaterial({ color: entry.color, toneMapped: false }));
      const mesh = new THREE.InstancedMesh(geometry.get(entry.shape), materials.get(entry.color), entry.parts.length);
      mesh.name = 'surroundings-' + entry.shape; mesh.frustumCulled = false;
      entry.parts.forEach((part, index) => { mesh.setMatrixAt(index, part.matrix); if (part.actor) part.actor.parts.push({ mesh, index, matrix: part.matrix }); });
      group.add(mesh); batches.push({ mesh });
    }
    group.position.y = base; moveActors();
  }
  function moveActors() {
    for (const actor of actors) {
      let x = actor.x, z = actor.z, angle = 0;
      if (actor.kind === 'car') {
        const fraction = (actor.offset + elapsed * .32 / actor.span) % 1;
        x = actor.start + actor.span * (actor.direction === 1 ? fraction : 1 - fraction);
        angle = actor.direction === 1 ? 0 : Math.PI;
      } else {
        x += .25 * Math.sin(elapsed * .17 + actor.offset);
        z += .22 * Math.cos(elapsed * .17 + actor.offset);
        angle = .25 * Math.sin(elapsed * .17 + actor.offset);
      }
      dummy.position.set(x, 0, z); dummy.rotation.set(0, angle, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix(); actorMatrix.copy(dummy.matrix);
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
    get stats() { return { enabled: state.enabled, moving: running(), drawCalls: group.visible ? batches.length : 0, actors: actors.length, timerPending: !!timer, frameInterval: tickMs, elapsed, elevation: base, bounds: { ...area } }; },
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
