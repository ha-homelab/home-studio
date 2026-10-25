'use strict';
// Small browser regression: real tour/session DOM, synthetic encoded output,
// and the actual native stale-export stylesheet. No renderer or HA is needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dataModule = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');

async function checkNativeTourDownloads(browser, root = path.resolve(__dirname, '..')) {
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  const native = read('custom_components/home_floorplan/__init__.py');
  const styles = [...native.matchAll(/<head><style>([^<]+)<\/style>/g)];
  assert.equal(styles.length, 1, 'Native stale-export stylesheet must be identified explicitly');
  const core = dataModule(read('camera-tour.js'));
  const panel = dataModule(read('camera-tour-panel.js').replaceAll("'./camera-tour.js'", JSON.stringify(core)));
  const recorder = dataModule(`
    export const recordingSupport=()=>({supported:true});
    export function createTourRecorder({onState}){
      return {async start(){window.captureStarts++;onState('recording');},
        async stop(){onState('stopped');return {blob:new Blob(['synthetic video'],{type:'video/webm'}),extension:'webm'};},
        cancel(){},dispose(){}};
    }
  `);
  const sessionModule = dataModule(read('camera-tour-session.js')
    .replaceAll("'./camera-tour.js'", JSON.stringify(core))
    .replaceAll("'./camera-tour-panel.js'", JSON.stringify(panel))
    .replaceAll("'./camera-tour-recording.js'", JSON.stringify(recorder)));
  const context = await browser.newContext({acceptDownloads: true});
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(String(error))));
  await context.route(/^https?:/, route => { errors.push('Unexpected network request'); return route.abort(); });
  try {
    for (const stale of [false, true]) {
      const page = await context.newPage();
      await page.setContent('<!doctype html><html><head></head><body>' +
        '<a class="download" id="model" href="model.glb" download>Static model</a>' +
        ['glb','usdz','obj','mtl','dae'].map(format =>
          `<a class="legacy-model" href="legacy.${format}" download>Legacy ${format}</a>`).join('') +
        '<a class="download" id="floor" href="#floor">Other floor</a>' +
        '<section class="camera-tour-host"></section></body></html>');
      await page.addStyleTag({content: read('camera-tour.css') + (stale ? styles[0][1] : '')});
      await page.evaluate(async module => {
        const {createCameraTourSession} = await import(module);
        window.captureStarts = 0;
        const click = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          // Model a browser blocking only the automatic video download. The
          // fallback must still be visible and work with an actual user click.
          if (this.classList.contains('camera-tour-download')) return;
          return click.call(this);
        };
        window.session = createCameraTourSession({container: document.querySelector('section'),
          canvas: () => ({}), capture: () => ({type:'home',floorId:'viewer:synthetic',room:'',
            rotation:0,tilt:0.2,zoom:1,pan:[0,0]}),apply() {},canExport:true});
        session.show();
      }, sessionModule);
      assert.equal(await page.locator('#model').isVisible(), !stale, 'Only stale static model exports are hidden');
      for (const link of await page.locator('.legacy-model').all())
        assert.equal(await link.isVisible(), !stale, 'Legacy static exports without the download class stay hidden');
      assert.equal(await page.locator('#floor').isVisible(), true, 'Floor navigation is not an export');
      const host = page.locator('.camera-tour-host'), panel = host.locator('.camera-tour-panel');
      await panel.getByRole('button', {name:'Save current view', exact:true}).click();
      await panel.getByLabel('View 1 seconds', {exact:true}).fill('0.25');
      await panel.getByLabel('View 1 seconds', {exact:true}).press('Tab');
      const route = page.waitForEvent('download');
      await panel.getByRole('button', {name:'Export route', exact:true}).click();
      assert.equal((await route).suggestedFilename(), 'camera-tour.json');
      await panel.getByRole('button', {name:'Record video', exact:true}).click();
      const video = host.locator('.camera-tour-download');
      await video.waitFor({state:'visible'});
      const download = page.waitForEvent('download');
      await video.click();
      assert.equal((await download).suggestedFilename(), 'home-studio-tour.webm');
      assert.equal(await page.evaluate(() => captureStarts), 1);
      await page.evaluate(() => session.setExportAllowed(false));
      assert.equal(await video.count(), 0, 'Permission loss removes the output link');
      assert.equal(await panel.getByRole('button', {name:'Export route', exact:true}).isDisabled(), true);
      assert.equal(await panel.getByRole('button', {name:'Record video', exact:true}).isDisabled(), true);
      await panel.getByRole('button', {name:'Play', exact:true}).click();
      await page.waitForFunction(() => session.tour.getState().status === 'completed');
      assert.equal(await page.evaluate(() => captureStarts), 1, 'Family playback creates no recorder');
      await page.evaluate(() => session.dispose());
      await page.close();
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
  console.log('PASS native tour downloads: static export branches, visible owner fallback, route export and family restrictions');
}

module.exports = {checkNativeTourDownloads};
if (require.main === module) (async () => {
  const engine = process.env.CAMERA_TOUR_ENGINE || 'chromium';
  assert(['chromium','firefox','webkit'].includes(engine));
  const {browserLaunchOptions} = require('./browser-stability-diagnostics.cjs');
  const browser = await require('playwright')[engine].launch(browserLaunchOptions(engine, true));
  try { await checkNativeTourDownloads(browser); } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
