// Visual feedback only. This module never sends device commands.
function createDeviceEffects(THREE, container, {canDraw, draw, allowRotor, onGeometryChange}) {
  const entries = [], reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const a = new THREE.Vector3(), b = new THREE.Vector3(), direction = new THREE.Vector3(), orientation = new THREE.Quaternion();
  let timer = 0, last = 0, inViewport = true, disposed = false, pageHidden = false, frameDelay = 84;
  const visible = entry => !disposed && !pageHidden && !document.hidden && inViewport &&
    canDraw() && entry.visible && entry.projected && entry.status?.running;
  const spinning = () => !reduced.matches && allowRotor() && entries.some(entry =>
    visible(entry) && entry.object?.userData.deviceRotors?.length);
  function stop() { clearTimeout(timer); timer = 0; last = 0; }
  function sync() {
    for (const entry of entries) {
      entry.air.hidden = !visible(entry) || !entry.effect || !entry.projected;
      entry.marker.dataset.running = String(visible(entry));
      entry.card.dataset.running = String(visible(entry));
    }
    if (!spinning()) stop();
    else if (!timer) timer = setTimeout(tick, frameDelay);
  }
  function tick() {
    timer = 0;
    if (!spinning()) { last = 0; return; }
    const now = performance.now(), delta = last ? Math.min(.25, (now - last) / 1000) : frameDelay / 1000;
    last = now;
    let moved = false;
    for (const entry of entries) if (visible(entry)) {
      const rate = .4 + 1.6 * (entry.status.percentage ?? 50) / 100;
      for (const rotor of entry.object?.userData.deviceRotors || []) {
        const axis = rotor.userData.axis;
        if (axis === 'x' || axis === 'y' || axis === 'z') {
          const angle = (rotor.rotation[axis] + delta * rate * Math.PI * 2) % (Math.PI * 2);
          if (angle !== rotor.rotation[axis]) { rotor.rotation[axis] = angle; moved = true; }
        }
      }
    }
    // A pending camera/tour draw may own this frame; its cached shadows still
    // need the changed geometry, without scheduling a second scene render.
    if (moved) onGeometryChange?.();
    draw();
    if(timer){clearTimeout(timer);timer=0;}
    // Bound scene work; expensive frames automatically reduce the update rate.
    frameDelay = Math.max(84, Math.min(500, (performance.now() - now) * 4));
    sync();
  }
  function register(point) {
    const air = document.createElement('div');
    air.className = 'device-airflow'; air.hidden = true; air.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (let i = 0; i < 3; i++) {
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.style.animationDelay = `${-i * .4}s`; svg.append(path);
    }
    air.append(svg); container.append(air);
    const entry = {...point, air, svg, visible: false, projected: false}; entries.push(entry);
    return entry;
  }
  function update(entry, status, isVisible) {
    entry.status = status; entry.visible = isVisible;
    const effect = status.effect || (status.running && status.percentage !== undefined ? 'fan' : '');
    entry.effect=effect;
    entry.air.dataset.effect = effect;
    for (const node of [entry.marker, entry.card]) {
      node.dataset.effect = effect;
      node.style.setProperty('--fan-period', `${3 - 2.4 * (status.percentage ?? 50) / 100}s`);
    }
  }
  function project(camera, rect) {
    for (const entry of entries) {
      const object = entry.object;
      if (!object || !entry.status?.running) { entry.projected = false; continue; }
      const config = object.userData.deviceAnimation?.airflow;
      const origin = config?.origin || [0, .5, .52];
      const flow = config?.direction || (entry.status.effect === 'heat' ? [0, 1, .15] : [0, -.2, 1]);
      const width = config?.width ?? .7, length = config?.length ?? .9;
      object.updateWorldMatrix(true, false);
      object.getWorldQuaternion(orientation);
      direction.set(...flow).normalize().applyQuaternion(orientation).multiplyScalar(length);
      let projected = false;
      entry.svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
      for (let i = 0; i < 3; i++) {
        a.set(origin[0] + (i - 1) * width / 3, origin[1], origin[2]); object.localToWorld(a);
        b.copy(a).add(direction); a.project(camera); b.project(camera);
        const x = (a.x + 1) * rect.width / 2, y = (1 - a.y) * rect.height / 2;
        const endX = (b.x + 1) * rect.width / 2, endY = (1 - b.y) * rect.height / 2;
        const path = entry.svg.children[i];
        const valid = [x, y, endX, endY].every(Number.isFinite) && a.z >= -1 && a.z <= 1 &&
          Math.max(x, endX) >= 0 && Math.min(x, endX) <= rect.width && Math.max(y, endY) >= 0 && Math.min(y, endY) <= rect.height;
        path.setAttribute('d', valid ? `M${x.toFixed(1)},${y.toFixed(1)} L${endX.toFixed(1)},${endY.toFixed(1)}` : '');
        projected ||= valid;
      }
      entry.projected = projected;
    }
    sync();
  }
  function clear() { stop(); for (const entry of entries) entry.air.remove(); entries.length = 0; }
  const hide = () => { pageHidden = true; sync(); }, show = () => { pageHidden = false; sync(); };
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(records => {
    inViewport = records.some(record => record.isIntersecting); sync();
  }) : null;
  observer?.observe(container);
  reduced.addEventListener('change', sync); document.addEventListener('visibilitychange', sync);
  window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
  return {register, update, project, sync, clear, dispose() {
    disposed = true; clear(); observer?.disconnect(); reduced.removeEventListener('change', sync);
    document.removeEventListener('visibilitychange', sync); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show);
  }};
}
if (typeof module !== 'undefined') module.exports = {createDeviceEffects};
