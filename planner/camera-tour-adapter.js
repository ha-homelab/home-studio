// The editor supplies camera-only callbacks, never its save or device bridge.
export function installPlannerTour({ button, parent, capture, apply, canvas, render, available, t, report }) {
  let session = null, loading = null, disposed = false;
  const container = document.createElement('section');
  container.className = 'camera-tour-host'; container.hidden = true; parent.append(container);
  button.addEventListener('click', async () => {
    if (session && !container.hidden) { session.close(); return; }
    if (!available()) { report(t('Open the 3D preview to use a camera tour.')); return; }
    try {
      loading ??= import('../camera-tour-session.js').catch(error => { loading = null; throw error; });
      const { createCameraTourSession } = await loading;
      if (disposed || !available()) return;
      session ??= createCameraTourSession({ container, capture, canvas, render, t,
        apply(pose) { if (!available()) throw Error(t('Open the 3D preview to use a camera tour.')); apply(pose); },
        onPlaying(active) { if (canvas()) canvas().dataset.cameraTourPlaying = String(active); },
        onClose() { button.setAttribute('aria-expanded', 'false'); button.focus(); },
      });
      session.show(); button.setAttribute('aria-expanded', 'true');
    } catch (error) { report(error.message); }
  });
  for (const type of ['pointerdown', 'wheel', 'keydown']) document.addEventListener(type, event => {
    if (event.type === 'keydown' && event.key === 'Escape' && !container.hidden) { session?.close(); return; }
    if (!event.target.closest?.('.camera-tour-host') && event.target !== button) session?.interrupt();
  }, { capture: true, passive: type === 'wheel' });
  document.addEventListener('webglcontextlost', () => session?.interrupt({ discard: true }), true);
  window.addEventListener('pagehide', event => { if (!event.persisted) { disposed = true; session?.dispose(); } });
  return { refresh() {
    if (!available() && !container.hidden) { session?.interrupt(); container.hidden = true; button.setAttribute('aria-expanded', 'false'); }
  } };
}
