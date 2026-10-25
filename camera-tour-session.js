import { createCameraTour } from './camera-tour.js';
import { createCameraTourPanel } from './camera-tour-panel.js';
import { createTourRecorder, recordingSupport } from './camera-tour-recording.js';

// Presentation state stays separate from the house project and HA commands.
export function createCameraTourSession({ container, capture, apply, canvas, render,
  t = text => text, onClose = () => {}, onPlaying = () => {}, canExport = true }) {
  let panel, recorder = null, recording = false, finishing = null, finishingCapture = null, disposed = false;
  let exportAllowed = canExport === true;
  let downloadUrl = null, downloadLink = null, lastFrame = 0, generation = 0;
  const frameInterval = 1000 / 24;
  const notify = (callback, value) => {
    try { callback(value); } catch { /* Observer errors must not interrupt resource cleanup. */ }
  };
  const requestFrame = callback => {
    const ticket = { id: 0, cancelled: false };
    const step = time => {
      if (ticket.cancelled || disposed) return;
      const intervals = Math.floor((time - lastFrame + 0.000001) / frameInterval);
      if (intervals < 1) { ticket.id = requestAnimationFrame(step); return; }
      // Retain the remainder so a 60 Hz display alternates between two and
      // three display frames instead of rounding every update down to 20 fps.
      lastFrame += intervals * frameInterval;
      callback(time);
    };
    ticket.id = requestAnimationFrame(step); return ticket;
  };
  const tour = createCameraTour({ capture, apply, requestFrame,
    cancelFrame: ticket => { ticket.cancelled = true; cancelAnimationFrame(ticket.id); } });
  // Sessions are created lazily on first open. Reopening never replaces a route,
  // including an intentionally cleared one. Preparing views does not render.
  let initialError = '';
  try { tour.orbit(t('Orbit')); }
  catch (error) { initialError = error.message; }
  function releaseDownload() {
    const url = downloadUrl, link = downloadLink;
    downloadUrl = null;
    downloadLink = null;
    try { link?.remove(); } finally { if (url) URL.revokeObjectURL(url); }
  }
  function offerDownload(result) {
    if (!exportAllowed) return;
    releaseDownload();
    const link = document.createElement('a');
    downloadUrl = URL.createObjectURL(result.blob);
    downloadLink = link;
    try {
      link.href = downloadUrl; link.download = `home-studio-tour.${result.extension}`;
      link.textContent = t('Download video'); link.className = 'camera-tour-download';
      container.append(link);
    } catch (error) { releaseDownload(); throw error; }
    // The visible link remains available when automatic downloads are blocked.
    try { link.click(); } catch { /* The user can still use the visible link. */ }
    panel.setStatus(t('Video ready. Only the 3D canvas is included.'));
  }
  function pauseTour() {
    if (disposed) return;
    try { tour.pause(); } catch (error) { panel.setStatus(error.message); }
  }
  function finishRecording(save = true) {
    if (finishing) {
      if (!save && finishingCapture) {
        // stop() may have fulfilled before its download handler runs. Keep
        // cancellation attached to that finalization, not only its encoder.
        finishingCapture.discarded = true;
        finishingCapture.recorder.cancel(); finishingCapture.recorder.dispose();
      }
      return finishing;
    }
    if (!recorder) return Promise.resolve();
    const current = recorder;
    recorder = null; recording = false; panel.setRecording(false);
    if (!save) { current.cancel(); current.dispose(); return Promise.resolve(); }
    const finalization = { recorder: current, discarded: false };
    finishingCapture = finalization;
    finishing = current.stop().then(result => {
      if (!disposed && !finalization.discarded) offerDownload(result);
    }).catch(error => {
      if (!disposed && !finalization.discarded && error.name !== 'AbortError') panel.setStatus(error.message);
    }).finally(() => {
      current.dispose();
      if (finishingCapture === finalization) { finishingCapture = null; finishing = null; }
    });
    return finishing;
  }
  async function record() {
    if (disposed || !exportAllowed) return;
    if (recording || finishing) {
      const stopped = finishRecording();
      pauseTour();
      await stopped;
      return;
    }
    const surface = canvas(), support = recordingSupport(surface);
    if (!support.supported) { panel.setStatus(support.reason); return; }
    if (!tour.getState().waypoints.length) { panel.setStatus(t('Save a view before recording.')); return; }
    // Reset before marking capture active. Every later transition out of
    // playback, including Stop during startup, must finish that capture.
    tour.stop({ restore: false });
    if (disposed) return;
    const attempt = ++generation;
    // The encoder's first frame must already match the route. Seeking saves
    // the original view without starting its clock; play resumes at zero.
    try { tour.seek(0); }
    catch (error) {
      if (!disposed && generation === attempt) panel.setStatus(error.message);
      return;
    }
    if (disposed || !exportAllowed || generation !== attempt || tour.getState().status !== 'paused') return;
    const current = createTourRecorder({ canvas: surface, render, frameRate: 24,
      onState(state) {
        if (!disposed && state === 'idle' && recording && recorder === current) {
          void finishRecording();
          pauseTour();
        }
      },
      onError(error) {
        if (disposed || generation !== attempt) return;
        if (recorder === current) void finishRecording(false);
        panel.setStatus(error.message); pauseTour();
      },
    });
    recorder = current; recording = true; panel.setRecording(true);
    try {
      await current.start();
      if (disposed || recorder !== current) return;
      tour.play();
    } catch (error) {
      if (recorder === current) await finishRecording(false);
      else current.dispose();
      if (!disposed && generation === attempt && error.name !== 'AbortError') panel.setStatus(error.message);
    }
  }
  function close() {
    if (disposed) return;
    void finishRecording();
    try { tour.stop({ restore: true }); }
    catch (error) { panel.setStatus(error.message); }
    finally { container.hidden = true; notify(onClose); }
  }
  panel = createCameraTourPanel({ container, tour, t, record, onClose: close, canExport: exportAllowed });
  if (initialError) panel.setStatus(initialError);
  const unsubscribe = tour.subscribe(state => {
    notify(onPlaying, state.status === 'playing');
    if (recording && state.status !== 'playing') void finishRecording();
  });
  function interrupt({ discard = false } = {}) {
    if (disposed) return;
    // A user's drag takes over without snapping back to an earlier view.
    if (recording || discard) void finishRecording(!discard);
    if (tour.getState().status !== 'idle') tour.stop({ restore: false });
  }
  function hidden() { if (document.hidden) interrupt(); }
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('pagehide', interrupt);
  return {
    tour, interrupt, close,
    setExportAllowed(value) {
      if (disposed || exportAllowed === (value === true)) return;
      exportAllowed = value === true;
      if (!exportAllowed) {
        generation++;
        void finishRecording(false);
        releaseDownload();
      }
      panel.setExportAllowed(exportAllowed);
    },
    show() { if (!disposed) { container.hidden = false; panel.refresh(); } },
    dispose() {
      if (disposed) return;
      disposed = true; generation++;
      // A failed camera restore or observer must not prevent the remaining
      // resources from being released, including an in-flight final video.
      for (const cleanup of [
        () => { void finishRecording(false); }, unsubscribe,
        () => tour.dispose(), () => panel.dispose(), releaseDownload,
        () => document.removeEventListener('visibilitychange', hidden),
        () => window.removeEventListener('pagehide', interrupt),
        () => notify(onPlaying, false),
      ]) {
        try { cleanup(); } catch { /* Continue through every teardown action. */ }
      }
    },
  };
}
