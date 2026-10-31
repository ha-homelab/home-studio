'use strict';
// Real decoded pixels must accept a delayed change and reject a static clip.
const assert = require('node:assert/strict');
const { decodeVideo } = require('./camera-tour-video-check.cjs');

async function checkVideoDecoder(browser) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const fixtures = await page.evaluate(async () => {
      const mimeType = ['video/mp4;codecs=avc1', 'video/mp4'].find(type => {
        try { return typeof MediaRecorder === 'function' && MediaRecorder.isTypeSupported(type); }
        catch { return false; }
      });
      if (!mimeType || typeof HTMLCanvasElement.prototype.captureStream !== 'function') return null;
      async function record(moving) {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 96;
        document.body.append(canvas);
        const ctx = canvas.getContext('2d');
        let changed = false, paintTimer, changeTimer, stopTimer, deadline;
        const draw = () => {
          ctx.fillStyle = changed ? '#ffffff' : '#000000'; ctx.fillRect(0, 0, 96, 96);
          ctx.fillStyle = changed ? '#000000' : '#ffffff'; ctx.fillRect(0, 0, 48, 96);
        };
        draw();
        const stream = canvas.captureStream(12), recorder = new MediaRecorder(stream, { mimeType });
        const chunks = [];
        try {
          const blob = await new Promise((resolve, reject) => {
            deadline = setTimeout(() => reject(new Error('Synthetic recording timed out')), 10000);
            recorder.addEventListener('error', () => reject(new Error('Synthetic recording failed')), { once: true });
            recorder.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
            recorder.addEventListener('stop', () => resolve(new Blob(chunks, { type: mimeType })), { once: true });
            recorder.addEventListener('start', () => {
              // The original fixed seek sees only the initial pose. Both clips
              // keep drawing so a static result cannot pass on frame count.
              if (moving) changeTimer = setTimeout(() => { changed = true; draw(); }, 1400);
              stopTimer = setTimeout(() => recorder.stop(), 3000);
            }, { once: true });
            paintTimer = setInterval(draw, 50);
            recorder.start(); draw();
          });
          if (!blob.size || blob.size > 1024 * 1024) throw new Error('Synthetic video exceeds its bound');
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 8192)
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
          return btoa(binary);
        } finally {
          clearTimeout(deadline); clearTimeout(changeTimer); clearTimeout(stopTimer); clearInterval(paintTimer);
          if (recorder.state !== 'inactive') recorder.stop();
          for (const track of stream.getTracks()) track.stop();
          canvas.remove();
        }
      }
      const [staticClip, delayedMotion] = await Promise.all([record(false), record(true)]);
      return { mimeType, staticClip, delayedMotion };
    });
    if (!fixtures) {
      console.log('Video decoder regression unavailable: browser cannot record canvas MP4.');
      return { supported: false };
    }
    const still = await decodeVideo(page, Buffer.from(fixtures.staticClip, 'base64'), fixtures.mimeType);
    const moving = await decodeVideo(page, Buffer.from(fixtures.delayedMotion, 'base64'), fixtures.mimeType);
    for (const decoded of [still, moving]) {
      assert(decoded.width > 0 && decoded.height > 0 && decoded.readyState >= 2);
      assert(decoded.colors > 1, 'the static negative must contain real rendered content');
      assert.equal(decoded.samples.length, 3, 'sampling has a fixed work bound');
      assert(decoded.samples.every(sample => sample.targetTime > 0 && sample.targetTime < decoded.duration), 'all targets are inside the clip');
    }
    assert(still.changedPixels <= 20, 'a decoded static clip must not satisfy the movement assertion');
    assert(moving.changedPixels > 20, 'decoded movement after the initial hold must satisfy the unchanged threshold');
    console.log('PASS video decoder: delayed movement detected; real static video rejected.');
    return { supported: true, still, moving };
  } finally { await context.close(); }
}

module.exports = { checkVideoDecoder };
if (require.main === module) (async () => {
  const engine = process.env.CAMERA_TOUR_ENGINE || 'chromium';
  assert(['chromium', 'firefox', 'webkit'].includes(engine));
  const { browserLaunchOptions } = require('./browser-stability-diagnostics.cjs');
  const browser = await require('playwright')[engine].launch(browserLaunchOptions(engine, true));
  try { await checkVideoDecoder(browser); }
  finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
