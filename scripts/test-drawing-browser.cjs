const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, firefox, webkit } = require('playwright');
const { browserLaunchOptions } = require('./browser-stability-diagnostics.cjs');
const root = path.resolve(__dirname, '..');
const engine = process.env.BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[engine];
assert(browserType, 'Choose chromium, firefox, or webkit.');
const artifactDir = process.env.DRAWING_ARTIFACTS;
const diagnostic = { phase: 'startup', lifecycle: [], errors: [], requests: [] };
let activePage, activeFrame;
const bounded = async (read, milliseconds = 2000) => {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(read), new Promise(resolve => {
      timer = setTimeout(() => resolve({ unavailable: 'diagnostic deadline' }), milliseconds);
    })]);
  } catch (error) { return { unavailable: String(error.message).slice(0, 240) }; }
  finally { clearTimeout(timer); }
};
// Passive, bounded evidence survives an input-command timeout. No form values,
// project contents, request bodies, focus changes or replacement clicks.
function installInputDiagnostics() {
  const describe = element => element?.tagName ? {
    tag: element.tagName, id: element.id, action: element.dataset?.drawingAction,
  } : null;
  const rect = element => element?.getBoundingClientRect().toJSON() || null;
  window.__drawingInputEvents = [];
  window.__drawingSelectEvents = [];
  for (const type of ['input', 'change']) {
    document.addEventListener(type, event => {
      if (event.target.tagName !== 'SELECT' || !event.target.dataset.drawingField) return;
      window.__drawingSelectEvents.push({ type, trusted: event.isTrusted, field: event.target.dataset.drawingField });
      if (window.__drawingSelectEvents.length > 16) window.__drawingSelectEvents.shift();
    }, { capture: true, passive: true });
  }
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'focusin', 'scroll']) {
    document.addEventListener(type, event => {
      window.__drawingInputEvents.push({ type, at: performance.now(), target: describe(event.target),
        point: typeof event.clientX === 'number' ? [event.clientX, event.clientY] : null,
        record: rect(document.querySelector('[data-drawing-action="record-measurement"]')) });
      if (window.__drawingInputEvents.length > 48) window.__drawingInputEvents.shift();
    }, { capture: true, passive: true });
  }
}
function documentDiagnostics() {
  const describe = element => element?.tagName ? {
    tag: element.tagName, id: element.id, action: element.dataset?.drawingAction,
  } : null;
  const geometry = element => {
    if (!element) return null;
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { ...describe(element), rect: rect.toJSON(), scroll: [element.scrollLeft, element.scrollTop, element.scrollWidth, element.scrollHeight],
      display: style.display, visibility: style.visibility, pointerEvents: style.pointerEvents,
      centerTarget: describe(element.getRootNode().elementFromPoint?.(rect.x + rect.width / 2, rect.y + rect.height / 2)) };
  };
  const host = document.querySelector('home-floorplan-studio-panel');
  return { readyState: document.readyState, visibility: document.visibilityState, focused: document.hasFocus(),
    viewport: [innerWidth, innerHeight, devicePixelRatio], scroll: [scrollX, scrollY], active: describe(document.activeElement),
    fonts: document.fonts.status, styles: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).slice(0, 8).map(link => ({
      path: new URL(link.href).pathname, loaded: !!link.sheet,
    })),
    dialog: geometry(document.querySelector('dialog[open]')),
    record: geometry(document.querySelector('[data-drawing-action="record-measurement"]')),
    header: geometry(document.querySelector('.drawing-header')), footer: geometry(document.querySelector('.drawing-panel>footer')),
    host: geometry(host), iframe: geometry(host?.shadowRoot?.querySelector('iframe')),
    native: host ? { ready: host._ready, busy: host._busy, generation: host._generation, sequence: host._sequence } : null,
    events: window.__drawingInputEvents || [], selectEvents: window.__drawingSelectEvents || [] };
}
async function failureDiagnostics(browser, context) {
  const targets = [...new Set([activePage, activeFrame])].filter(Boolean);
  // Keep this free of layout/style reads: a blocked rendering query is not
  // sufficient evidence that the document's JavaScript also stopped running.
  const heartbeats = await Promise.all(targets.map(target => bounded(() => target.evaluate(() => ({
    at: performance.now(), readyState: document.readyState, visibility: document.visibilityState,
  })), 500)));
  const documents = await Promise.all(targets.map(target => bounded(() => target.evaluate(documentDiagnostics))));
  const report = { engine, browser: browser?.version(), node: process.version, platform: process.platform,
    ...diagnostic, pageCount: context?.pages().length, heartbeats, documents };
  console.error('Drawing failure diagnostics:', JSON.stringify(report));
  if (!artifactDir) return;
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, `drawing-${engine}-failure.json`), JSON.stringify(report, null, 2) + '\n');
  if (activePage) await bounded(() => activePage.screenshot({ path: path.join(artifactDir, `drawing-${engine}-failure.png`), timeout: 2000 }));
}
const fixture = { schema_version: 1, id: 'drawing_check', title: 'Measured studio', floors: [{
  id: 'ground', name: 'Ground floor', elevation_m: 0, height_m: 2.7,
  rooms: [{ id: 'studio', name: 'Studio', material: 'floor', polygon: [[0,0],[4,0],[4,3],[0,3]] }],
  walls: [
    { id:'south', start:[0,0], end:[4,0], thickness_m:.15 },
    { id:'east', start:[4,0], end:[4,3], thickness_m:.15 },
    { id:'north', start:[4,3], end:[0,3], thickness_m:.15 },
    { id:'west', start:[0,3], end:[0,0], thickness_m:.15 }
  ], openings: [
    { id:'door', wall_id:'south', type:'door', offset_m:.2, width_m:.9, sill_m:0, head_m:2 },
    { id:'window', wall_id:'north', type:'window', offset_m:1, width_m:1.2, sill_m:.6, head_m:2.1 }
  ], items: [{id:'pendant', name:'Studio pendant', type:'chandelier', room:'studio',
    position_m:{x:2,y:2.4,z:1.5},dimensions_m:{width:.3,depth:.3,height:.3},rotation_deg:0,
    entity_id:'light.private_fixture',notes:'PRIVATE_NOTE_NOT_FOR_EXPORT'}]
}] };
const hostHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;--primary-background-color:#111b2a;--card-background-color:#202d40;--primary-text-color:#e6edf4;--secondary-text-color:#aabbcc;--divider-color:#40506a;--primary-color:#58baff;--error-color:#ff8877;color-scheme:dark}
</style></head><body><home-floorplan-studio-panel></home-floorplan-studio-panel><script type="module">
await import('/home-floorplan-static/studio.js');
const state={project:${JSON.stringify(fixture)},mode:'native',revision:1,published_revision:null,has_saved_draft:true,has_published:false};
window.host=document.querySelector('home-floorplan-studio-panel'); window.server=state;
host.hass={user:{id:'synthetic-admin',is_admin:true},language:'en',locale:{language:'en'},themes:{darkMode:true},states:{},callWS:async data=>{
 if(data.type==='home_floorplan/entity_catalog')return {floors:[],areas:[],entities:[]};
 if(data.type==='home_floorplan/project_save'){state.project=data.project;state.revision++;}
 return {...structuredClone(state),can_edit:true,editor_url:'/home-floorplan-studio/planner/index.html',capabilities:{authoring:true}};
}};
</script></body></html>`;
const allowed = new Set(JSON.parse(fs.readFileSync(path.join(root,'ai_companion/assets.json'),'utf8')));
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg'};
const server=http.createServer((request,response)=>{
  const url=new URL(request.url,'http://localhost');
  if(url.pathname==='/native'){response.writeHead(200,{'Content-Type':'text/html'}).end(hostHtml);return;}
  let name=url.pathname.replace(/^\/home-floorplan-studio\//,'').replace(/^\//,'');
  if(['home-floorplan-static/studio.js','home-floorplan-static/map-transport.js'].includes(name))name='custom_components/'+name.replace('home-floorplan-static/','home_floorplan/static/');
  if(!allowed.has(name)&&!['custom_components/home_floorplan/static/studio.js','custom_components/home_floorplan/static/map-transport.js'].includes(name)){response.writeHead(404).end();return;}
  response.writeHead(200,{'Content-Type':types[path.extname(name)]||'application/octet-stream','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'});
  response.end(fs.readFileSync(path.join(root,name)));
});
const action=(scope,name)=>scope.locator(`[data-drawing-action="${name}"]`);
async function openPanel(frame){await frame.locator('#drawing-package').click();const dialog=frame.getByRole('dialog',{name:'Drawings & materials',exact:true});await dialog.waitFor();return dialog;}
async function step(dialog,n){await dialog.getByRole('button',{name:new RegExp(`^${n}\\.`)}).click();}
async function readDownload(page,click){const pending=page.waitForEvent('download');await click();const download=await pending;return fs.promises.readFile(await download.path(),'utf8');}
async function exerciseKeyboardAndReview(page, frame, native) {
  activePage = page; activeFrame = frame;
  diagnostic.phase = `${native ? 'native' : 'standalone'}: keyboard and geometry review`;
  const project = structuredClone(fixture);
  // Floor keeps its select node across rerenders. A shared initial exercises
  // native first-character cycling without assuming blur clears typeahead.
  const upper = structuredClone(project.floors[0]); upper.id = 'upper'; upper.name = 'Gallery floor'; upper.elevation_m = 3;
  project.floors.push(upper);
  project.floors[0].rooms.push({ id: 'annex', name: 'Annex', material: 'floor', polygon: [[6,0],[8,0],[8,2],[6,2]] });
  await frame.evaluate(async value => {
    const { editorBridge } = await import('./editor.js'); editorBridge.applyProject(value, editorBridge.revision());
  }, project);
  let dialog = await openPanel(frame);
  const field = name => dialog.getByLabel(name, { exact: true });
  const focused = async control => assert.ok(await control.evaluate(element => element === document.activeElement), 'The changed selector retains keyboard focus.');
  const keyboardChoice = async (name, key, expected) => {
    const control = field(name);
    // Use closed-select typeahead: native popups are unavailable in headless
    // macOS. The persistent Floor selector uses the same cycling key each time.
    if (await control.evaluate(element => element === document.activeElement)) await page.keyboard.press('Tab');
    await control.focus();
    const fieldKey = await control.getAttribute('data-drawing-field');
    await frame.evaluate(() => { window.__drawingSelectEvents = []; });
    await page.keyboard.press(key);
    await control.locator(`option[value="${expected}"]:checked`).waitFor({ state: 'attached' });
    assert.equal(await control.inputValue(), expected); await focused(control);
    const events = await frame.evaluate(() => window.__drawingSelectEvents);
    for (const type of ['input', 'change']) assert.ok(events.some(event => event.field === fieldKey && event.type === type && event.trusted),
      `Keyboard ${name} selection emits trusted ${type}: ${JSON.stringify(events)}`);
  };
  const roomScope = async value => {
    // Room labels share the floor-name prefix, so cover this ambiguous selector's
    // focus separately; the rebuilt type/element/floor/room controls use real keys.
    const control = field('Rooms'); await control.focus(); await control.selectOption(value); await focused(control);
  };
  const geometry = dialog.getByRole('region', { name: 'Current drawing dimensions', exact: true });
  const value = async (label, expected) => {
    assert.equal(await geometry.getByText(label, { exact: true }).locator('..').locator('dd').innerText(), expected);
  };
  assert.deepEqual(await field('Floor').locator('option').allTextContents(), ['Ground floor', 'Gallery floor']);
  await value('Floor area', '12 m²'); await value('Perimeter', '14 m'); await value('Ceiling height', '2.7 m');
  await keyboardChoice('Element type', 'w', 'wall');
  await value('Length', '4 m'); await value('Height', '2.7 m'); await value('Thickness', '0.15 m'); await value('Openings included', '1');
  await page.keyboard.press('Tab'); await focused(field('Element'));
  await keyboardChoice('Element', 'w', 'west'); await value('Length', '3 m'); await value('Openings included', '0');
  await keyboardChoice('Element type', 'd', 'opening');
  await value('Width', '0.9 m'); await value('Height', '2 m');
  await keyboardChoice('Element', 'w', 'window');
  await value('Width', '1.2 m'); await value('Height', '1.5 m'); await value('Sill height above floor', '0.6 m');
  await keyboardChoice('Element type', 'i', 'item');
  await value('Width × depth × height', '0.3 × 0.3 × 0.3 m'); await value('Base height above floor', '2.4 m');
  await keyboardChoice('Element type', 'r', 'room');
  await keyboardChoice('Floor', 'g', 'upper'); await keyboardChoice('Floor', 'g', 'ground');
  await step(dialog, 2);
  await keyboardChoice('Room', 'a', 'annex'); await keyboardChoice('Room', 's', 'studio');
  await step(dialog, 3);
  await keyboardChoice('Floors', 's', 'current');
  await roomScope('ground/annex'); await roomScope('all');
  await keyboardChoice('Floors', 'a', 'all');
  assert.equal(await field('Rooms').locator('option[value="upper/studio"]').innerText(), 'Gallery floor · Studio');
  assert.equal(await frame.evaluate(() => planner.getProject().documentation), undefined, 'Reviewing geometry and scope does not record measurements or save documentation.');
  await action(dialog, 'generate').click();
  const warnings = dialog.locator('summary').filter({ hasText: /^Measurement rules and limitations/ });
  assert.match(await warnings.innerText(), /[1-9][0-9]* warnings/);
  assert.equal(await warnings.evaluate(element => element.parentElement.open), false, 'Warning count is visible without expanding the rules.');
  await field('Schedule').selectOption('items');
  const rows = dialog.locator('tbody tr'); assert.equal(await rows.count(), 2);
  assert.match(await rows.nth(0).innerText(), /Ground floor \/ Studio/);
  assert.match(await rows.nth(1).innerText(), /Gallery floor \/ Studio/);
  for (let i = 0; i < 2; i++) assert.match(await rows.nth(i).innerText(), /Studio pendant \(pendant\)/);
  await field('Schedule').selectOption('openings'); assert.equal(await rows.count(), 4);
  for (const [index, floor] of [[0, 'Ground floor'], [2, 'Gallery floor']]) {
    const cells = rows.nth(index).locator('td');
    assert.equal(await cells.nth(0).innerText(), floor);
    assert.equal(await cells.nth(1).innerText(), 'door'); assert.equal(await cells.nth(2).innerText(), 'south');
  }
  diagnostic.phase = `${native ? 'native' : 'standalone'}: stale text remains copyable`;
  await step(dialog, 1);
  await field('Design brief').fill('Unsaved brief to copy before reloading.');
  const note = field('Measurement note'), pending = 'Unsaved source note to copy.', upperPending = 'Unsaved upper-floor item note.';
  await note.fill(pending);
  await keyboardChoice('Floor', 'g', 'upper'); await keyboardChoice('Element type', 'i', 'item');
  await note.fill(upperPending);
  await keyboardChoice('Floor', 'g', 'ground'); await keyboardChoice('Element type', 'r', 'room');
  assert.equal(await note.inputValue(), pending); await note.focus(); await note.press('ControlOrMeta+A');
  await frame.evaluate(async () => {
    const { editorBridge } = await import('./editor.js'); const next = editorBridge.snapshot();
    next.floors[1].name = 'Updated upper floor'; editorBridge.applyProject(next, editorBridge.revision());
  });
  assert.equal(await note.isDisabled(), false); assert.equal(await note.getAttribute('readonly'), ''); await focused(note);
  assert.deepEqual(await note.evaluate(element => [element.selectionStart, element.selectionEnd]), [0, pending.length]);
  await note.press('x'); assert.equal(await note.inputValue(), pending, 'Stale text can be selected but cannot be edited.');
  assert.ok(await action(dialog, 'save').isDisabled()); assert.ok(await action(dialog, 'record-measurement').isDisabled());
  assert.ok(await field('Dimension source').isDisabled());
  await keyboardChoice('Floor', 'g', 'upper'); await keyboardChoice('Element type', 'i', 'item');
  assert.equal(await note.inputValue(), upperPending, 'Stale navigation retains pending notes on another floor and element.');
  assert.equal(await note.getAttribute('readonly'), ''); assert.equal(await note.isDisabled(), false);
  assert.deepEqual(await field('Floor').locator('option').allTextContents(), ['Ground floor', 'Gallery floor'], 'Stale navigation stays within the retained snapshot.');
  await note.press('ControlOrMeta+A');
  assert.deepEqual(await note.evaluate(element => [element.selectionStart, element.selectionEnd]), [0, upperPending.length]);
  await keyboardChoice('Floor', 'g', 'ground'); await keyboardChoice('Element type', 'r', 'room');
  assert.equal(await note.inputValue(), pending);
  await step(dialog, 2); await keyboardChoice('Room', 'a', 'annex'); await keyboardChoice('Room', 's', 'studio');
  await step(dialog, 1);
  assert.ok(await action(dialog, 'save').isDisabled()); assert.ok(await action(dialog, 'record-measurement').isDisabled());
  await note.press('Escape');
  const keep = dialog.getByRole('button', { name: 'Keep editing', exact: true });
  await focused(keep); await keep.press('Enter');
  await step(dialog, 3); assert.ok(await action(dialog, 'generate').isDisabled());
  await step(dialog, 1); await action(dialog, 'reload').click();
  assert.equal(await note.getAttribute('readonly'), null); assert.equal(await note.inputValue(), '');
  assert.equal(await field('Design brief').inputValue(), '');
  assert.equal(await frame.evaluate(() => planner.getProject().documentation), undefined, 'Reload explicitly discards pending documentation without saving it.');
  await action(dialog, 'close').click();
  // Duplicate display names are a separate identity case, not an ambiguous
  // typeahead target. Per-floor element IDs are deliberately identical too.
  await frame.evaluate(async () => {
    const { editorBridge } = await import('./editor.js'); const next = editorBridge.snapshot();
    next.floors[1].name = next.floors[0].name; editorBridge.applyProject(next, editorBridge.revision());
  });
  dialog = await openPanel(frame);
  assert.deepEqual(await field('Floor').locator('option').allTextContents(), ['Ground floor (ground)', 'Ground floor (upper)']);
  await step(dialog, 3);
  assert.equal(await field('Rooms').locator('option[value="upper/studio"]').innerText(), 'Ground floor (upper) · Studio');
  await action(dialog, 'generate').click(); await field('Schedule').selectOption('items');
  assert.match(await rows.nth(0).innerText(), /Ground floor \(ground\) \/ Studio/);
  assert.match(await rows.nth(1).innerText(), /Ground floor \(upper\) \/ Studio/);
  await field('Schedule').selectOption('openings');
  for (const [index, floor] of [[0, 'Ground floor (ground)'], [2, 'Ground floor (upper)']]) {
    assert.equal(await rows.nth(index).locator('td').first().innerText(), floor);
  }
  await action(dialog, 'close').click();
}
async function exerciseNativeViewport(page, frame, viewport) {
  diagnostic.phase = `native: dialog viewport ${viewport.width}x${viewport.height}`;
  await page.setViewportSize(viewport);
  const dialog = await openPanel(frame);
  await frame.waitForFunction(() => Boolean(document.querySelector('.drawing-panel')?.style.maxHeight));
  await dialog.getByLabel('Design brief', { exact: true }).fill(`Viewport ${viewport.width}x${viewport.height} check.`);
  const insideViewport = async (control, label) => {
    const box = await control.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, `${label} has visible bounds.`);
    assert.ok(box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1,
      `${label} remains inside the host viewport: ${JSON.stringify(box)}`);
  };
  for (const index of [1, 2, 3]) {
    await step(dialog, index);
    await action(dialog, 'close').click({ trial: true });
    await action(dialog, 'save').click({ trial: true });
    await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // boundingBox uses main-frame coordinates, including the opaque iframe offset.
    await insideViewport(dialog, 'Dialog');
    await insideViewport(action(dialog, 'close'), 'Close');
    await insideViewport(action(dialog, 'save'), 'Save documentation');
  }
  await action(dialog, 'save').click(); await action(dialog, 'close').click();
  await page.waitForFunction(() => window.host._dialogViewportCleanup === null);
}
async function exercise(page,frame,native){
  activePage = page; activeFrame = frame;
  const stage = name => { diagnostic.phase = `${native ? 'native' : 'standalone'}: ${name}`; };
  stage('open and edit measurements');
  let dialog=await openPanel(frame);
  await dialog.getByLabel('Design brief',{exact:true}).fill('Keep the doorway clear.');
  await dialog.getByLabel('Dimension source',{exact:true}).selectOption('measured');
  await dialog.getByLabel('Measurement note',{exact:true}).fill('Tape measure checked.');
  stage('record first measurement');
  await action(dialog,'record-measurement').click();
  stage('finishes and documentation save');
  await step(dialog,2);
  const finish=dialog.locator('[data-drawing-surface="floor"]');
  await finish.getByLabel('Finish code',{exact:true}).fill('F-01');
  await finish.getByLabel('Specification',{exact:true}).fill('Oak boards');
  await finish.getByLabel('Waste allowance (%)',{exact:true}).fill('10');
  await dialog.getByLabel('Studio pendant',{exact:true}).check();
  await step(dialog,1);
  assert.equal(await dialog.getByLabel('Measurement note',{exact:true}).inputValue(),'Tape measure checked.','Switching steps retains evidence.');
  await action(dialog,'close').click();
  await dialog.getByRole('button',{name:'Keep editing',exact:true}).click();
  await action(dialog,'save').click();
  await frame.waitForFunction(()=>window.planner.getProject().documentation?.finishes.length===1);
  const documented=await frame.evaluate(()=>planner.getProject());
  assert.equal(documented.documentation.measurements[0].status,'measured');
  assert.equal(documented.documentation.ceiling_fixture_ids[0].item_id,'pendant');
  assert.equal(documented.documentation.brief,'Keep the doorway clear.');
  stage('generate and download');
  await step(dialog,3);await action(dialog,'generate').click();
  await dialog.locator('img.drawing-sheet').waitFor();
  await dialog.locator('img.drawing-sheet').evaluate(image=>image.decode());
  const html=await readDownload(page,()=>action(dialog,'download-html').click());
  assert.match(html,/34\.2/);assert.match(html,/12/);assert.match(html,/F-01/);assert.match(html,/Oak boards/);
  assert.ok(!html.includes('light.private_fixture'));assert.ok(!html.includes('PRIVATE_NOTE_NOT_FOR_EXPORT'));
  assert.ok(!html.includes('Tape measure checked.'));assert.ok(!html.includes('Keep the doorway clear.'));
  await dialog.getByLabel('Preview sheet',{exact:true}).selectOption({label:'Ground floor — Ceiling fixture plan'});
  const svg=await readDownload(page,()=>action(dialog,'download-svg').click());
  assert.match(svg,/Studio pendant/);assert.match(svg,/width="420mm"/);
  await dialog.getByLabel('Schedule',{exact:true}).selectOption('materials');
  assert.equal(await dialog.getByRole('columnheader',{name:'Net m²',exact:true}).count(),1);
  assert.equal(await dialog.locator('tbody tr').count(),3);
  const csv=await readDownload(page,()=>action(dialog,'download-csv').click());
  assert.match(csv,/F-01/);assert.match(csv,/13\.2/);
  assert.equal(await dialog.evaluate(element=>getComputedStyle(element,'::backdrop').backdropFilter),'none',
    'The drawing dialog dims the editor without a full-viewport backdrop filter.');
  if(native){
    assert.equal(await frame.evaluate(()=>getComputedStyle(document.querySelector('.drawing-panel')).backgroundColor),'rgb(32, 45, 64)','Native theme applies to the document panel.');
    const dir=process.env.DRAWING_ARTIFACTS;
    if(dir){fs.mkdirSync(dir,{recursive:true});await page.screenshot({path:path.join(dir,`native-drawings-${engine}.png`),fullPage:true});}
  }
  // A changed accepted snapshot must revoke all old download controls.
  stage('stale output invalidation');
  await frame.evaluate(async()=>{const {editorBridge}=await import('./editor.js');const next=editorBridge.snapshot();next.floors[0].rooms[0].name='Renamed studio';editorBridge.applyProject(next,editorBridge.revision());});
  assert.equal(await action(dialog,'download-html').count(),0);
  assert.ok(await action(dialog,'generate').isDisabled());await action(dialog,'reload').click();
  await action(dialog,'generate').click();assert.ok(await action(dialog,'download-html').isEnabled());
  await action(dialog,'close').click();
  if(native){await page.locator('#save').click();await page.waitForFunction(()=>window.server.project?.documentation?.finishes.length===1);}
  // Geometry changes leave authored evidence intact but mark it out of date.
  stage('measurement freshness and undo');
  await frame.evaluate(async()=>{const {editorBridge}=await import('./editor.js');const next=editorBridge.snapshot();next.floors[0].height_m=2.8;editorBridge.applyProject(next,editorBridge.revision());});
  dialog=await openPanel(frame);
  assert.match(await dialog.innerText(),/Current evidence: Out of date/);
  await action(dialog,'close').click();
  await frame.locator('#undo').click();
  dialog=await openPanel(frame);assert.match(await dialog.innerText(),/Current evidence: Measured/);await action(dialog,'close').click();
  // Removing a referenced item prunes only its metadata within the same undo step.
  stage('deleted reference pruning and undo');
  await frame.locator('[data-object-kind="items"]').first().click();
  await frame.getByRole('button',{name:'Delete item',exact:true}).click();
  assert.equal(await frame.evaluate(()=>planner.getProject().floors[0].items.length),0);
  assert.equal(await frame.evaluate(()=>planner.getProject().documentation.ceiling_fixture_ids.length),0);
  await frame.locator('#undo').click();
  assert.equal(await frame.evaluate(()=>planner.getProject().documentation.ceiling_fixture_ids.length),1);
  stage('source change and explicit re-record');
  dialog=await openPanel(frame);
  await dialog.getByLabel('Dimension source',{exact:true}).selectOption('imported');
  await action(dialog,'save').click();
  assert.equal(await frame.evaluate(()=>planner.getProject().documentation.measurements[0].geometry),null,'Changing source does not re-certify existing dimensions.');
  assert.match(await dialog.innerText(),/Current evidence: Unknown/);
  await action(dialog,'record-measurement').click();await action(dialog,'save').click();
  assert.match(await dialog.innerText(),/Current evidence: Imported/);
  await step(dialog,2);
  await dialog.locator('[data-drawing-surface="floor"]').getByLabel('Waste allowance (%)',{exact:true}).fill('');
  await action(dialog,'save').click();
  assert.equal(await frame.evaluate(()=>planner.getProject().documentation.finishes[0].waste_percent),0);
  await action(dialog,'close').click();
}
(async()=>{
 let browser, context, tracing = false, failed = false;
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await browserType.launch(browserLaunchOptions(engine));
  context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  await context.addInitScript(installInputDiagnostics);
  if (artifactDir) { fs.mkdirSync(artifactDir, { recursive: true }); await context.tracing.start({ screenshots: true, snapshots: true }); tracing = true; }
  const errors=[],outside=[];context.on('page',page=>{
    page.on('pageerror',e=>{errors.push(String(e));if(diagnostic.errors.length<8)diagnostic.errors.push(String(e).slice(0,240));});
    page.on('dialog',d=>d.accept());
  });
  context.on('page', page => {
    const record = (event, frame) => {
      diagnostic.lifecycle.push({ event, path: frame ? new URL(frame.url() || 'about:blank').pathname : null, at: Date.now() });
      if (diagnostic.lifecycle.length > 24) diagnostic.lifecycle.shift();
    };
    for (const event of ['frameattached', 'framenavigated', 'framedetached']) page.on(event, frame => record(event, frame));
    for (const event of ['crash', 'close']) page.on(event, () => record(event));
  });
  context.on('request',request=>{if(!request.url().startsWith(origin+'/')&&!/^(data:|blob:)/.test(request.url()))outside.push(request.url());});
  context.on('requestfailed',request=>{
    if(diagnostic.requests.length<8)diagnostic.requests.push({path:new URL(request.url()).pathname,error:request.failure()?.errorText?.slice(0,160)});
  });
  const page=await context.newPage();page.setDefaultTimeout(20000);
  activePage = page; activeFrame = page; diagnostic.phase = 'standalone: startup';
  await page.goto(origin+'/planner/index.html');await page.waitForFunction(()=>window.planner);
  await page.locator('#file-input').setInputFiles({name:'measured.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
  await page.waitForFunction(()=>planner.getProject().id==='drawing_check');await exercise(page,page,false);await exerciseKeyboardAndReview(page,page,false);console.log(`${engine}: standalone drawing workflow PASS`);
  const native=await context.newPage();native.setDefaultTimeout(20000);
  activePage = native; activeFrame = native; diagnostic.phase = 'native: startup';
  await native.goto(origin+'/native');await native.waitForFunction(()=>window.host?._ready);
  const frame=native.frames().find(f=>f.url().includes('embed='));assert(frame,'Native editor frame initialized.');
  await exercise(native,frame,true);await exerciseKeyboardAndReview(native,frame,true);
  await exerciseNativeViewport(native, frame, {width:430,height:600});
  await exerciseNativeViewport(native, frame, {width:850,height:450});
  assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
  console.log(`${engine}: drawing workflow, native theme/save, private-field exclusion, downloads, stale invalidation, undo and narrow dialog PASS`);
 }catch(error){
  failed = true;
  await bounded(() => failureDiagnostics(browser, context), 5000);
  throw error;
 }finally{
  if (tracing) await bounded(() => context.tracing.stop(failed ? { path: path.join(artifactDir, `drawing-${engine}-trace.zip`) } : {}), 5000);
  await browser?.close();await new Promise(resolve=>server.close(resolve));
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
