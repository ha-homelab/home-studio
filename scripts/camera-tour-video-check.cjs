'use strict';
// Shared only by the real-browser recording checks and their decoder regression.
async function decodeVideo(page, bytes, mimeType) {
  // Decode the downloaded bytes independently of the inline player so the
  // saved file's content and motion are verified as well as on-page playback.
  const decoder = await page.context().newPage();
  try { return await decoder.evaluate(async ({ base64, type }) => {
    const data = Uint8Array.from(atob(base64), value => value.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([data], { type }));
    const video = document.createElement('video'); video.muted = true; video.playsInline = true; video.preload = 'auto';
    // WebKit can report loadeddata before a detached video's frame is ready
    // for canvas sampling. Keep it paused but attached, and await presentation.
    document.body.append(video);
    const timeout = setTimeout(() => video.dispatchEvent(new Event('testtimeout')), 15000);
    let frameCallback = null, animationFrame = null;
    try {
      const failure = new Promise((_, reject) => {
        video.addEventListener('error', () => reject(new Error(`Video decode error ${video.error?.code}: ${video.error?.message}`)), { once: true });
        video.addEventListener('testtimeout', () => reject(new Error('Timed out decoding recorded video')), { once: true });
      });
      const waitForFrame = async (event, change) => {
        const ready = new Promise(resolve => video.addEventListener(event, resolve, { once: true }));
        const presented = typeof video.requestVideoFrameCallback === 'function'
          ? new Promise(resolve => { frameCallback = video.requestVideoFrameCallback((_, metadata) => {
            frameCallback = null; resolve(metadata.mediaTime);
          }); })
          : ready.then(() => new Promise(resolve => { animationFrame = requestAnimationFrame(() => {
            animationFrame = requestAnimationFrame(() => { animationFrame = null; resolve(video.currentTime); });
          }); }));
        change();
        return (await Promise.race([Promise.all([ready, presented]), failure]))[1];
      };
      const firstFrameTime = await waitForFrame('loadeddata', () => { video.src = url; video.load(); });
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
      const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 32, 32);
      const pixels = context.getImageData(0, 0, 32, 32).data, colors = new Set();
      for (let i = 0; i < pixels.length; i += 4) colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('Recorded video needs a finite positive duration');
      const samples = [];
      // Encoder startup can retain the initial pose beyond a fixed 1.1-second
      // seek. Sample the clip's interior; the final orbit returns to its start.
      for (const fraction of [0.25, 0.5, 0.75]) {
        const targetTime = duration * fraction;
        const mediaTime = await waitForFrame('seeked', () => { video.currentTime = targetTime; });
        if (!Number.isFinite(mediaTime) || mediaTime < 0 || mediaTime > duration)
          throw new Error('Decoded frame timestamp is outside the recorded video');
        context.drawImage(video, 0, 0, 32, 32);
        const later = context.getImageData(0, 0, 32, 32).data;
        let changedPixels = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (Math.abs(pixels[i] - later[i]) + Math.abs(pixels[i+1] - later[i+1]) + Math.abs(pixels[i+2] - later[i+2]) > 45) changedPixels++;
        }
        samples.push({ targetTime, mediaTime, changedPixels });
      }
      const changedPixels = Math.max(0, ...samples.filter(sample => sample.mediaTime > firstFrameTime).map(sample => sample.changedPixels));
      return { width: video.videoWidth, height: video.videoHeight, readyState: video.readyState,
        duration, colors: colors.size, changedPixels, firstFrameTime, samples };
    } finally {
      clearTimeout(timeout);
      if (frameCallback !== null) video.cancelVideoFrameCallback(frameCallback);
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      video.pause(); video.removeAttribute('src'); video.load(); video.remove(); URL.revokeObjectURL(url);
    }
  }, { base64: bytes.toString('base64'), type: mimeType });
  } finally { await decoder.close(); }
}

module.exports = { decodeVideo };
