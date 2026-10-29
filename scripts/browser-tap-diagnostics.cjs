// Acceptance-only evidence. Never substitutes input or retries a failed tap.
function readTapTarget(target) {
  const rect = target.getBoundingClientRect(), style = getComputedStyle(target);
  const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  const lifecycle = win => ({visibility:win.document.visibilityState, focused:win.document.hasFocus(),
    scroll:[win.scrollX,win.scrollY], viewport:[win.innerWidth,win.innerHeight],
    visual:win.visualViewport ? [win.visualViewport.offsetLeft,win.visualViewport.offsetTop,
      win.visualViewport.width,win.visualViewport.height,win.visualViewport.scale] : null});
  let parent = null;
  try { parent = lifecycle(window.parent); } catch { parent = {crossOrigin:true}; }
  return {at:performance.now(), connected:target.isConnected, disabled:target.matches(':disabled'),
    hidden:target.hidden, bounds:[rect.x,rect.y,rect.width,rect.height],
    style:{display:style.display,visibility:style.visibility,opacity:style.opacity,pointerEvents:style.pointerEvents},
    receivesInput:hit === target || target.contains(hit), lifecycle:lifecycle(window), parent};
}

// This runs only AFTER a real input failure, so a diagnostic RAF cannot make a
// stalled actionability check pass. The original failure is always rethrown.
function sampleFailedTap() {
  return new Promise(resolve => {
    const start = performance.now(), result = {scope:'after-input-failure',durationMs:0,
      timers:[], raf:[]};
    let active = true, frame, interval;
    const tick = time => {
      if (!active) return;
      if (result.raf.length < 40) result.raf.push(time - start);
      frame = requestAnimationFrame(tick);
    };
    interval = setInterval(() => {
      if (result.timers.length < 20) result.timers.push(performance.now() - start);
    }, 50);
    frame = requestAnimationFrame(tick);
    setTimeout(() => {
      active = false; clearInterval(interval); cancelAnimationFrame(frame);
      result.durationMs = performance.now() - start;
      resolve(result);
    }, 500);
  });
}

async function tapWithDiagnostics(locator, input, record, bounded) {
  const target = await locator.elementHandle();
  if (!target) throw new Error('Tap target is missing');
  try {
    try { record.before = await bounded(() => target.evaluate(readTapTarget), 500, 'Pre-tap evidence'); }
    catch (error) { record.beforeError = String(error); }
    try {
      await input.tap(locator);
      record.status = 'passed';
    } catch (error) {
      record.status = 'failed';
      record.error = {name:error.name,message:error.message};
      try {
        record.afterFailure = await bounded(async () => {
          const sample = await target.evaluate(sampleFailedTap);
          sample.target = await target.evaluate(readTapTarget);
          return sample;
        }, 1500, 'Post-failure tap evidence');
      } catch (diagnosticError) { record.diagnosticError = String(diagnosticError); }
      throw error;
    }
  } finally {
    try { await bounded(() => target.dispose(), 500, 'Tap handle cleanup'); }
    catch (error) {
      record.cleanupError = String(error);
      if (record.status === 'passed') throw error;
    }
  }
}

module.exports = {readTapTarget,sampleFailedTap,tapWithDiagnostics};
