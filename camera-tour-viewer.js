// Included in the generated viewer closure. The optional tools parse on demand.
let tourModulePromise = null, tourDisposed = false;
function tourModeAvailable(mode) {
  return !!renderer && !failed3D && !renderLost && !renderSuspended && !document.hidden &&
    (mode === 'home' ? homeView?.active : !homeView?.active && $('view3d').style.display !== 'none');
}
function syncViewerTourPermissions() {
  for (const { session } of tourSessions.values()) session.setExportAllowed(!embedded || canEdit);
}
function syncViewerTours() {
  syncViewerTourPermissions();
  for (const [mode, entry] of tourSessions) if (!tourModeAvailable(mode)) {
    entry.session.hide();
    $(mode === 'home' ? 'homeCameraTour' : 'editorCameraTour').setAttribute('aria-expanded', 'false');
  }
}
async function openViewerTour() {
  if (tourDisposed) return;
  const mode = homeView?.active ? 'home' : 'editor';
  if (!tourModeAvailable(mode)) {
    const message = vt('Open the available 3D view before using a camera tour.');
    setEditorStatus(message);
    if (mode === 'home') { $('homeFeedback').textContent = message; $('homeFeedback').hidden = false; }
    return;
  }
  const button = $(mode === 'home' ? 'homeCameraTour' : 'editorCameraTour');
  try {
    tourModulePromise ??= import('data:text/javascript;base64,__CAMERA_TOUR_MODULE_B64__')
      .catch(error => { tourModulePromise = null; throw error; });
    const { createCameraTourSession } = await tourModulePromise;
    if (tourDisposed || !tourModeAvailable(mode)) return;
    let entry = tourSessions.get(mode);
    if (entry && !entry.container.hidden) { entry.session.close(); return; }
    if (!entry) {
      const container = document.createElement('section');
      container.className = 'camera-tour-host'; document.body.append(container);
      const session = createCameraTourSession({ container, t: vt,
        canExport: !embedded || canEdit,
        canvas: () => renderer?.domElement, render: () => window.renderModel?.(),
        capture() {
          if ((homeView?.active ? 'home' : 'editor') !== mode) throw Error(vt('Open this view before playing its tour.'));
          if (mode === 'home') return homeView.captureTourPose();
          return { type: 'perspective', floorId: 'viewer:' + model.id,
            yaw: Math.PI / 2 - azimuth, pitch: Math.PI / 2 - polar, radius,
            target: [target.x, target.y, target.z] };
        },
        captureOrbit() {
          if (!tourModeAvailable(mode)) throw Error(vt('Open this view before playing its tour.'));
          if (mode === 'home') return homeView.captureTourPose();
          // Fit static architecture, not the focused room, movable inventory
          // or scene backdrop. This computes a pose without moving the camera.
          const bounds = new THREE.Box3().setFromObject(root);
          const center = bounds.isEmpty() ? new THREE.Vector3(planCenter[0], planBounds ? model.ceiling_height_m / 2 : 0, planCenter[1]) : bounds.getCenter(new THREE.Vector3());
          const sphereRadius = bounds.isEmpty() ? 0 : bounds.getSize(new THREE.Vector3()).length() / 2;
          const vertical = camera.fov * Math.PI / 360, horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
          const fittedRadius = sphereRadius ? sphereRadius / Math.sin(Math.min(vertical, horizontal)) * 1.12 : planRadius;
          return { type: 'perspective', floorId: 'viewer:' + model.id,
            yaw: Math.PI / 2 - azimuth, pitch: Math.PI / 2 - polar, radius: Math.max(1, fittedRadius),
            target: [center.x, center.y, center.z] };
        },
        apply(pose) {
          if (!tourModeAvailable(mode)) throw Error(vt('Open this view before playing its tour.'));
          if (pose.floorId !== 'viewer:' + model.id) throw Error(vt('This view belongs to another plan.'));
          if (mode === 'home') { homeView.applyTourPose(pose); return; }
          if (pose.type !== 'perspective' || pose.target.some(v => Math.abs(v) > 10000)) throw Error(vt('This view belongs to another plan.'));
          azimuth = Math.PI / 2 - pose.yaw; polar = Math.max(.001, Math.min(1.56, Math.PI / 2 - pose.pitch));
          radius = Math.max(1, Math.min(10000, pose.radius)); target.set(...pose.target);
          const far = Math.max(150, planRadius * 5, radius * 4);
          if (camera.far !== far) { camera.far = far; camera.updateProjectionMatrix(); }
          requestRender();
        },
        onPlaying(active) { if (renderer) renderer.domElement.dataset.cameraTourPlaying = String(active); },
        onClose() { button.setAttribute('aria-expanded', 'false'); button.focus(); },
      });
      entry = { session, container }; tourSessions.set(mode, entry);
    }
    for (const [key, other] of tourSessions) if (key !== mode) other.session.hide();
    syncViewerTourPermissions();
    entry.session.show(); button.setAttribute('aria-expanded', 'true');
  } catch (error) {
    setEditorStatus(error.message);
    if (mode === 'home') { $('homeFeedback').textContent = error.message; $('homeFeedback').hidden = false; }
  }
}
for (const id of ['homeCameraTour', 'editorCameraTour']) $(id).addEventListener('click', openViewerTour);
function interruptViewerTours() { for (const { session } of tourSessions.values()) session.interrupt(); }
for (const type of ['pointerdown', 'wheel', 'keydown']) document.addEventListener(type, event => {
  if (event.type === 'keydown' && event.key === 'Escape') {
    for (const entry of tourSessions.values()) if (!entry.container.hidden) entry.session.close();
    return;
  }
  if (!event.target.closest?.('.camera-tour-host') && !['homeCameraTour', 'editorCameraTour'].includes(event.target.id)) interruptViewerTours();
}, { capture: true, passive: type === 'wheel' });
document.addEventListener('webglcontextlost', () => {
  for (const { session } of tourSessions.values()) session.interrupt({ discard: true });
}, true);
window.addEventListener('pagehide', event => {
  if (!event.persisted) {
    tourDisposed = true;
    for (const { session } of tourSessions.values()) session.dispose();
  }
});
