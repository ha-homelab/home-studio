import { createDraftContext, draftSchema, prepareDraft } from './draft.js';

const PHOTO_LIMIT = 6, TOTAL_BYTES = 30 * 1024 * 1024;
const SAFE_ERRORS = {
  session_expired: 'This AI session expired. Reload this page to start another session.',
  unauthorized: 'This AI session expired. Reload this page to start another session.',
  invalid_key: 'The provider rejected the key. Check the key and connect again.',
  upstream_auth: 'The provider rejected the key. Check the key and connect again.',
  timeout: 'The model took too long. The plan is unchanged; you can try again.',
  cancelled: 'Generation cancelled. Your plan is unchanged.',
  busy: 'The companion is already generating a draft. Wait for it to finish or cancel it.',
};
function el(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
function control(label, type, value, onChange) {
  const wrapper = el('label'), caption = el('span', label), input = el('input');
  input.type = type; input.value = value; input.setAttribute('aria-label', label);
  if (type === 'number') input.step = '0.01';
  input.addEventListener('change', () => onChange(type === 'number' ? Number(input.value) : input.value));
  wrapper.append(caption, input); return wrapper;
}

export function mountAiPanel(bridge, session) {
  const panel = el('aside', undefined, 'ai-panel'); panel.id = 'ai-panel'; panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'ai-title');
  // Static template only. All filenames, provider values and model text below
  // are assigned through textContent or input.value, never interpreted as HTML.
  panel.innerHTML = `
    <div class="ai-header"><div><p class="eyebrow">OPTIONAL AI ASSISTANT</p><h2 id="ai-title" tabindex="-1">Plan from room photos</h2></div><button type="button" class="quiet" id="ai-close" aria-label="Close AI panel">×</button></div>
    <p class="ai-note">AI can suggest editable objects. Photos do not establish accurate scale; use measured dimensions. This first AI interface is in English.</p>
    <section aria-labelledby="ai-session-title"><h3 id="ai-session-title">1. Choose the destination</h3>
      <label><span>Provider</span><select id="ai-provider" disabled></select></label>
      <label><span>Model ID</span><input id="ai-model" autocomplete="off" spellcheck="false" placeholder="Exact model ID from your provider"></label>
      <label id="ai-endpoint-label"><span>Local endpoint</span><input id="ai-endpoint" type="url" autocomplete="off" spellcheck="false"></label>
      <label id="ai-key-label"><span>API key · this session only</span><input id="ai-key" type="password" autocomplete="off" spellcheck="false"></label>
      <p id="ai-privacy" class="ai-privacy"></p>
      <div class="ai-actions"><button id="ai-connect" class="primary" disabled>Connect session</button><button id="ai-disconnect" class="quiet" disabled>End session</button></div>
      <p id="ai-connection" class="ai-note">Disconnected. Connect a session before generating.</p>
    </section>
    <section aria-labelledby="ai-input-title"><h3 id="ai-input-title">2. Describe one room</h3>
      <label><span>Task</span><select id="ai-mode"><option value="furnish_room">Furnish selected measured room</option><option value="new_room">Create a measured rectangular room</option></select></label>
      <p id="ai-target" class="ai-note"></p>
      <div id="ai-measurements" hidden><div class="ai-grid">
        <label><span>Measured width (m)</span><input id="ai-width" type="number" min="0.1" max="100" step="0.01" value="4"></label>
        <label><span>Measured depth (m)</span><input id="ai-depth" type="number" min="0.1" max="100" step="0.01" value="3"></label>
        <label><span>Measured ceiling (m)</span><input id="ai-height" type="number" min="0.5" max="20" step="0.01" value="2.7"></label>
        <label><span>Origin X (m)</span><input id="ai-origin-x" type="number" min="-100" max="100" step="0.01" value="0"></label>
        <label><span>Origin Z (m)</span><input id="ai-origin-z" type="number" min="-100" max="100" step="0.01" value="0"></label>
      </div><p class="ai-note">Origin is the top-left corner in 2D. Width goes right (+X); depth goes down (+Z). Edges 0–3 run clockwise from the top wall. On a populated floor, ceiling height must match that floor. Existing rooms are preserved.</p></div>
      <label><span>Instructions and known measurements</span><textarea id="ai-instructions" rows="4" maxlength="8000" placeholder="Describe the furniture, photo directions, reference wall, and measurements. Any language is welcome."></textarea></label>
      <label><span>Room photos · optional</span><input id="ai-photos-input" type="file" accept="image/jpeg,image/png,image/webp" multiple></label>
      <p class="ai-note">Up to 6 JPEG, PNG, or WebP photos, 10 MiB each, 30 MiB total, and 24 megapixels each. Convert HEIC/SVG first. Photos are resized to 1600 px and re-encoded locally to remove metadata. Remove or crop sensitive details before choosing files.</p>
      <div id="ai-photos" class="ai-photos"></div><p id="ai-photo-progress" class="ai-note" role="status"></p>
      <details><summary>Review room context sent to the model</summary><pre id="ai-context" class="ai-note"></pre></details>
      <p id="ai-send-summary" class="ai-note"></p>
      <div class="ai-actions"><button id="ai-generate" class="primary" disabled>Generate draft</button><button id="ai-cancel-request" class="quiet" hidden>Cancel generation</button></div>
    </section>
    <p id="ai-status" class="ai-status" role="status" aria-live="polite"></p>
    <section id="ai-review" aria-labelledby="ai-review-title" hidden><h3 id="ai-review-title">3. Review the draft</h3>
      <p class="ai-preview-label">Preview only · not saved</p><p id="ai-review-summary"></p>
      <p class="ai-note">Purple outlines mark additions in 2D. Use the existing 2D / 3D tabs to inspect the preview. Select candidates and correct dimensions below. Editing the main plan invalidates this draft.</p>
      <div id="ai-review-notes"></div><div id="ai-candidates"></div>
      <label><input id="ai-review-confirm" type="checkbox">I reviewed the dimensions, assumptions, and selected additions.</label>
      <div class="ai-actions"><button id="ai-apply" class="primary" disabled>Apply selected additions</button><button id="ai-discard" class="quiet">Discard draft</button></div>
    </section>`;
  document.body.append(panel);
  const $ = id => panel.querySelector(`#ai-${id}`);
  const open = el('button', 'Plan from photos', 'quiet'); open.id = 'ai-open'; open.type = 'button'; open.setAttribute('aria-expanded', 'false'); open.setAttribute('aria-controls', panel.id);
  document.querySelector('.file-actions').append(open);
  const previewBadge = el('div', 'AI preview · not saved', 'ai-preview-badge'); previewBadge.hidden = true; document.querySelector('.canvas-shell').append(previewBadge);
  let providers = [], connection = null, photos = [], photoEpoch = 0, photoWorker = null, cancelPhoto = null, processing = false;
  let contextPreviewKey = null;
  let controller = null, requestEpoch = 0, pending = null, review = null, connecting = false, connectionEpoch = 0, expiryTimer = null, disconnectPromise = null, connectPromise = null, cancelPromise = null;
  const selectedProvider = () => providers.find(provider => provider.id === $('provider').value);
  const setStatus = (text, error = false) => { $('status').textContent = text; $('status').classList.toggle('ai-error', error); };
  async function api(path, body, signal) {
    const deadline = signal ? null : new AbortController();
    const timer = deadline ? setTimeout(() => deadline.abort(), 20000) : null;
    let response, result;
    try {
      response = await fetch(`/api/ai/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Home-Studio-Session': session, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal || deadline.signal, credentials: 'omit', cache: 'no-store' });
      try { result = await response.json(); }
      catch { throw new Error('The local companion returned an unreadable response. Your plan is unchanged.'); }
    } catch (error) {
      if (deadline?.signal.aborted) throw new Error('The local companion did not respond in time. Check that it is running and try again.');
      throw error;
    } finally { clearTimeout(timer); }
    if (!response.ok) {
      const code = result?.error?.code;
      const error = new Error(SAFE_ERRORS[code] || 'The AI request failed. Check your model, endpoint, and connection, then try again. Your plan is unchanged.');
      error.status = response.status; throw error;
    }
    return result;
  }
  function clearReview() {
    review = null; bridge.cancelPreview(); previewBadge.hidden = true;
    $('review').hidden = true; $('candidates').replaceChildren(); $('review-notes').replaceChildren(); $('review-confirm').checked = false;
  }
  function invalidate(message) {
    const hadWork = Boolean(pending || review);
    requestEpoch++; controller?.abort(); controller = null;
    if (pending) {
      const cancellation = api('cancel', { request_id: pending.context.request_id }).catch(() => {});
      cancelPromise = cancellation;
      void cancellation.then(() => { if (cancelPromise === cancellation) { cancelPromise = null; update(); } });
    }
    pending = null; clearReview();
    if (hadWork && message) setStatus(message, true);
    update();
  }
  function clearPhotos() {
    photoEpoch++; cancelPhoto?.(); cancelPhoto = null; photoWorker?.terminate(); photoWorker = null; processing = false;
    for (const photo of photos) URL.revokeObjectURL(photo.url);
    photos = []; $('photos-input').value = ''; $('photo-progress').textContent = ''; renderPhotos();
  }
  function forgetSession(message = 'Session ended. The local key, photos, instructions, and draft were cleared.') {
    invalidate(); connection = null; clearTimeout(expiryTimer); expiryTimer = null;
    $('key').value = ''; $('instructions').value = ''; clearPhotos();
    if (message) setStatus(message); update();
  }
  async function endSession(message) {
    const wasActive = Boolean(connection || connecting); connecting = false; connectionEpoch++;
    forgetSession(message);
    if (wasActive) {
      // A late Connect must settle before the final Disconnect, otherwise it
      // could resurrect a key after the UI has forgotten the session.
      const connectingNow = connectPromise, cancellingNow = cancelPromise;
      const current = Promise.allSettled([connectingNow, cancellingNow]).then(() => api('disconnect', {})).catch(() => {});
      disconnectPromise = current; update();
      await current;
      if (disconnectPromise === current) { disconnectPromise = null; update(); }
    } else if (disconnectPromise) await disconnectPromise;
  }
  function context() {
    const selected = bridge.selectionContext();
    return createDraftContext(bridge.snapshot(), { ...selected, mode: $('mode').value,
      measurements: { width: Number($('width').value), depth: Number($('depth').value), height: Number($('height').value) },
      origin: { x: Number($('origin-x').value), z: Number($('origin-z').value) } });
  }
  function update() {
    const provider = selectedProvider(), active = Boolean(connection);
    $('connect').disabled = !provider || connecting || active || Boolean(disconnectPromise);
    $('disconnect').disabled = !active && !connecting;
    $('generate').disabled = !active || Boolean(pending) || Boolean(cancelPromise) || processing;
    $('photos-input').disabled = processing || Boolean(pending);
    $('cancel-request').hidden = !pending;
    $('connection').textContent = active ? `Connected session · ${connection.provider} · ${connection.model} · ${connection.endpoint || provider?.default_endpoint || ''}. Connection does not test model vision capability.` : 'Disconnected. Connect a session before generating.';
    $('measurements').hidden = $('mode').value !== 'new_room';
    const selected = bridge.selectionContext(), project = bridge.snapshot();
    const floor = project.floors.find(value => value.id === selected.floorId), room = floor?.rooms.find(value => value.id === selected.roomId);
    $('target').textContent = $('mode').value === 'new_room' ? `New measured room on ${floor?.name || 'the current floor'}.` : room ? `Selected room: ${room.name}. Measured walls and existing objects remain fixed.` : 'Select an existing room in the plan, or choose Create a measured rectangular room.';
    const contextKey = [bridge.revision(), $('mode').value, ...['width', 'depth', 'height', 'origin-x', 'origin-z'].map(id => $(id).value)].join('|');
    if (contextKey !== contextPreviewKey) {
      contextPreviewKey = contextKey;
      try { const preview = context(); $('context').textContent = JSON.stringify({ ...preview, catalog: { version: preview.catalog.version, model_count: preview.catalog.models.length, description: 'Built-in catalog names, dimensions, styles, and patterns; no private project data.' } }, null, 2); $('context').dataset.valid = 'true'; }
      catch (error) { $('context').textContent = error.message; $('context').dataset.valid = 'false'; }
    }
    if ($('context').dataset.valid !== 'true') $('generate').disabled = true;
    const bytes = photos.reduce((total, photo) => total + photo.blob.size, 0);
    $('send-summary').textContent = `Generate sends the ${photos.length} photos shown (${(bytes / 1024).toFixed(0)} KiB after processing), your instructions, the limited room context above, and the catalog/schema to ${active ? connection.provider + ' / ' + connection.model : 'the destination you connect'}. Photos are not sent when selected or when connecting.`;
    $('apply').disabled = !review || !$('review-confirm').checked || Boolean(review.invalid);
  }
  function providerFields() {
    const provider = selectedProvider(); if (!provider) return;
    $('endpoint-label').hidden = !provider.local; $('endpoint').value = provider.default_endpoint || '';
    $('key-label').hidden = !provider.requires_key && !provider.local; $('key-label').querySelector('span').textContent = provider.local ? 'Local server token · optional, this session only' : 'API key · this session only'; $('key').value = '';
    $('privacy').textContent = provider.local
      ? 'Requests go through the local companion to the loopback model address below. Keep cloud features and fallbacks disabled in that model server; its downloads and logs are controlled separately. Only same-computer local endpoints are accepted. If your local server needs authentication, enter its token below; it stays in session memory.'
      : `Your API key is kept in memory by this session and the local companion, then sent to ${provider.label} to authenticate. Approved photos, instructions, and room details go to this provider. Its data policy and API charges apply. Home Studio operates no relay or key database.${provider.id === 'openrouter' ? ' OpenRouter is a gateway: your request also goes to its selected upstream provider under its routing and data policies.' : ''} End session forgets local state; it cannot delete provider records.`;
    update();
  }
  function renderPhotos() {
    $('photos').replaceChildren();
    photos.forEach((photo, index) => {
      const figure = el('figure'), img = el('img'), caption = el('figcaption', `Photo ${index + 1} · ${photo.width} × ${photo.height} · ${Math.ceil(photo.blob.size / 1024)} KiB`), remove = el('button', `Remove photo ${index + 1}`, 'quiet');
      img.src = photo.url; img.alt = `Selected room photo ${index + 1}`; remove.type = 'button';
      remove.addEventListener('click', () => { invalidate('Photos changed. Generate a fresh draft.'); URL.revokeObjectURL(photo.url); photos = photos.filter(value => value !== photo); renderPhotos(); update(); });
      figure.append(img, caption, remove); $('photos').append(figure);
    });
  }
  function processPhoto(file) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./photo-worker.js', import.meta.url), { type: 'module' }); photoWorker = worker;
      const finish = (error, result) => { clearTimeout(timeout); worker.terminate(); if (photoWorker === worker) photoWorker = null; cancelPhoto = null; error ? reject(error) : resolve(result); };
      const timeout = setTimeout(() => finish(new Error('Photo processing took too long. Resize this image and try again.')), 15000);
      cancelPhoto = () => finish(new Error('Photo processing cancelled.'));
      worker.onerror = () => finish(new Error('This browser could not process the photo. Try a smaller JPEG in a current browser.'));
      worker.onmessage = event => event.data.error ? finish(new Error(event.data.error)) : finish(null, event.data);
      worker.postMessage(file);
    });
  }
  $('photos-input').addEventListener('change', async event => {
    const files = Array.from(event.target.files); event.target.value = ''; if (!files.length) return;
    invalidate('Photos changed. Generate a fresh draft.');
    if (photos.length + files.length > PHOTO_LIMIT || files.some(file => file.size > 10 * 1024 * 1024) || photos.reduce((sum, photo) => sum + photo.originalSize, 0) + files.reduce((sum, file) => sum + file.size, 0) > TOTAL_BYTES) {
      setStatus('Choose at most 6 photos: 10 MiB each and 30 MiB total.', true); return;
    }
    const epoch = ++photoEpoch; processing = true; update();
    try {
      for (let i = 0; i < files.length; i++) {
        $('photo-progress').textContent = `Processing photo ${i + 1} of ${files.length} locally…`;
        const processed = await processPhoto(files[i]);
        if (epoch !== photoEpoch) return;
        if (photos.reduce((sum, photo) => sum + photo.blob.size, 0) + processed.blob.size > 12 * 1024 * 1024) throw new Error('The processed photos exceed 12 MiB. Remove a photo and try again.');
        photos.push({ ...processed, originalSize: files[i].size, url: URL.createObjectURL(processed.blob) }); renderPhotos();
      }
      $('photo-progress').textContent = `${photos.length} photos ready. Sent only when you choose Generate.`;
    } catch (error) { if (epoch === photoEpoch) setStatus(error.message, true); }
    finally { if (epoch === photoEpoch) { processing = false; update(); } }
  });
  function renderReviewMetadata() {
    const data = review.prepared;
    $('review-summary').textContent = data.summary;
    $('review-notes').replaceChildren();
    for (const [title, values] of [['Assumptions', data.assumptions], ['Measurements still needed', data.needsMeasurements], ['Geometry checks', data.warnings]]) {
      if (!values?.length) continue;
      const list = el('ul'); for (const value of values) list.append(el('li', value)); $('review-notes').append(el('h4', title), list);
    }
  }
  function renderReview() {
    const data = review.prepared;
    $('review').hidden = false; previewBadge.hidden = false;
    renderReviewMetadata();
    $('candidates').replaceChildren();
    for (const candidate of data.candidates) {
      const card = el('div', undefined, 'ai-candidate'), label = el('label'), checkbox = el('input');
      checkbox.type = 'checkbox'; checkbox.checked = review.selected.has(candidate.candidate_key); checkbox.dataset.candidateKey = candidate.candidate_key;
      label.append(checkbox, el('span', candidate.name || candidate.candidate_key)); card.append(label);
      if (candidate.evidence) card.append(el('p', candidate.evidence, 'ai-note'));
      const detail = el('details'), grid = el('div', undefined, 'ai-grid'); detail.append(el('summary', 'Dimensions and position'));
      const source = candidate.kind === 'item' ? review.raw.items.find(item => item.candidate_key === candidate.candidate_key) : review.raw.openings.find(item => item.candidate_key === candidate.candidate_key);
      const addNumber = (caption, object, key) => grid.append(control(caption, 'number', object[key], value => { object[key] = value; refreshPreview(); }));
      if (candidate.kind === 'item') {
        for (const axis of ['x', 'y', 'z']) addNumber(`${axis.toUpperCase()} (m) · ${candidate.name}`, source.position_m, axis);
        for (const dimension of ['width', 'depth', 'height']) addNumber(`${dimension} (m) · ${candidate.name}`, source.dimensions_m, dimension);
        addNumber(`Rotation (°) · ${candidate.name}`, source, 'rotation_deg');
        card.append(el('p', `${source.dimensions_m.width} × ${source.dimensions_m.depth} × ${source.dimensions_m.height} m · ${source.model_id}`, 'ai-note'));
      } else {
        for (const key of ['edge_index', 'offset_m', 'width_m', 'sill_m', 'head_m']) addNumber(`${key.replaceAll('_', ' ')} · ${candidate.name}`, source, key);
      }
      detail.append(grid); card.append(detail);
      checkbox.addEventListener('change', () => { checkbox.checked ? review.selected.add(candidate.candidate_key) : review.selected.delete(candidate.candidate_key); refreshPreview(); });
      $('candidates').append(card);
    }
    if (!data.candidates.length) $('candidates').append(el('p', 'No furniture or opening candidates. A new-room draft can still add its measured shell.'));
    bridge.previewProject(data.project); update();
  }
  function refreshPreview() {
    if (!review) return;
    $('review-confirm').checked = false;
    try {
      review.prepared = prepareDraft(review.baseProject, review.context, review.raw, { selectedCandidateKeys: [...review.selected] });
      review.invalid = false; renderReviewMetadata(); bridge.previewProject(review.prepared.project); previewBadge.hidden = false;
      setStatus('Preview updated. Review the selected dimensions before applying.');
    } catch (error) { review.invalid = true; $('review-summary').textContent = 'Invalid correction — fix the input described in the error before reviewing this draft.'; $('review-notes').replaceChildren(); bridge.cancelPreview(); previewBadge.hidden = true; setStatus(`Draft correction needs attention: ${error.message}`, true); }
    update();
  }
  $('generate').addEventListener('click', async () => {
    if (!connection || pending || cancelPromise || processing) return;
    clearReview();
    const epoch = ++requestEpoch, baseProject = bridge.snapshot(), revision = bridge.revision();
    let draftContext;
    try { draftContext = context(); } catch (error) { setStatus(error.message, true); return; }
    controller = new AbortController(); const signal = controller.signal;
    pending = { context: draftContext }; update(); setStatus('Generating a detached draft… You can still inspect the plan in 2D and 3D.');
    const timeout = setTimeout(() => { if (epoch === requestEpoch) invalidate('Generation timed out. Your plan is unchanged. Try again when the model is ready.'); }, 120000);
    try {
      const images = [];
      for (const photo of photos) {
        const bytes = new Uint8Array(await photo.blob.arrayBuffer());
        let binary = ''; for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
        images.push({ mime_type: photo.blob.type, data: btoa(binary) });
      }
      if (epoch !== requestEpoch) return;
      const result = await api('generate', { request_id: draftContext.request_id, mode: $('mode').value, context: draftContext, instructions: $('instructions').value, images, schema: draftSchema($('mode').value) }, signal);
      if (epoch !== requestEpoch || bridge.revision() !== revision || !connection) return;
      const prepared = prepareDraft(baseProject, draftContext, result.draft);
      review = { baseProject, revision, context: draftContext, raw: structuredClone(result.draft), prepared, selected: new Set(prepared.candidates.map(candidate => candidate.candidate_key)), invalid: false };
      pending = null; renderReview(); setStatus('Draft ready for review. Your saved plan is unchanged.'); $('review-title').scrollIntoView({ block: 'nearest' });
    } catch (error) {
      if (epoch === requestEpoch) {
        if ([401, 403, 410].includes(error.status)) forgetSession(error.message);
        else if (error.name !== 'AbortError') setStatus(error.message, true);
      }
    } finally { clearTimeout(timeout); if (epoch === requestEpoch) { pending = null; controller = null; update(); } }
  });
  $('apply').addEventListener('click', () => {
    if (!review || !$('review-confirm').checked || review.invalid) return;
    const current = review;
    try {
      // Revalidate the complete selected project immediately before one undoable transaction.
      const prepared = prepareDraft(bridge.snapshot(), current.context, current.raw, { selectedCandidateKeys: [...current.selected] });
      if (!bridge.applyProject(prepared.project, current.revision)) throw new Error('The editor could not apply this draft.');
      clearReview(); clearPhotos(); setStatus('Selected additions applied. Use Undo to restore the previous plan, or Export JSON to keep the editable result.');
    } catch (error) { setStatus(error.message, true); }
    update();
  });
  $('review-confirm').addEventListener('change', update);
  $('discard').addEventListener('click', () => { invalidate(); clearPhotos(); setStatus('Draft discarded. Your plan is unchanged.'); update(); });
  $('cancel-request').addEventListener('click', () => { invalidate(); setStatus('Generation cancelled. Your plan is unchanged.'); });
  $('connect').addEventListener('click', async () => {
    const provider = selectedProvider(), model = $('model').value.trim();
    if (!provider || !model || connecting || connection || disconnectPromise) { setStatus('Enter the exact model ID before connecting.', true); return; }
    if (provider.requires_key && !$('key').value.trim()) { setStatus('Enter a provider API key for this session.', true); return; }
    connecting = true; const epoch = ++connectionEpoch;
    const payload = { provider: provider.id, model, api_key: $('key').value.trim(), ...(provider.local ? { endpoint: $('endpoint').value.trim() } : {}) }; $('key').value = ''; update();
    try {
      const attempt = api('connect', payload); connectPromise = attempt;
      const result = await attempt; if (connectPromise === attempt) connectPromise = null; payload.api_key = '';
      if (epoch !== connectionEpoch) return;
      connection = { provider: provider.id, model, endpoint: provider.default_endpoint, ...result }; connecting = false;
      if (result.expires_at) expiryTimer = setTimeout(() => { void endSession('The AI session expired. Reload this page to start another session.'); }, Math.max(0, result.expires_at * 1000 - Date.now()));
      setStatus('Session connected. Generate sends the reviewed inputs; no photo or model request was sent by Connect.');
    } catch (error) { connectPromise = null; payload.api_key = ''; if (epoch === connectionEpoch) { connecting = false; setStatus(error.message, true); } }
    update();
  });
  $('disconnect').addEventListener('click', () => { void endSession(); });
  $('provider').addEventListener('change', () => { void endSession('Destination changed. Connect a new session before sending.'); providerFields(); });
  for (const id of ['model', 'endpoint']) $(id).addEventListener('input', () => { if (connection || connecting) void endSession('Connection settings changed. Connect a new session before sending.'); });
  for (const id of ['mode', 'width', 'depth', 'height', 'origin-x', 'origin-z', 'instructions']) $(id).addEventListener('input', () => { invalidate('Request inputs changed. Generate a fresh draft.'); update(); });
  bridge.subscribe(() => invalidate('The plan or selection changed. Generate a fresh draft for the current room.'));
  open.addEventListener('click', () => { panel.hidden = false; open.setAttribute('aria-expanded', 'true'); $('title').focus(); update(); });
  function closePanel() { invalidate(); clearPhotos(); panel.hidden = true; open.setAttribute('aria-expanded', 'false'); open.focus(); }
  $('close').addEventListener('click', closePanel);
  panel.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); closePanel(); } });
  window.addEventListener('pagehide', () => {
    connectionEpoch++; connecting = false; forgetSession('Session closed. Connect again before generating.');
    const cleanup = () => fetch('/api/ai/disconnect', { method: 'POST', headers: { 'X-Home-Studio-Session': session, 'Content-Type': 'application/json' }, body: '{}', credentials: 'omit', keepalive: true }).catch(() => {});
    void cleanup();
    // Best effort on unload; the companion also expires abandoned sessions.
    // A bfcache restore must never accept a late connection or generation.
    if (connectPromise) void connectPromise.then(cleanup, cleanup);
  });
  api('providers').then(result => {
    providers = result.providers;
    for (const provider of providers) { const option = el('option', `${provider.label}${provider.local ? ' · local' : ' · cloud'}`); option.value = provider.id; $('provider').append(option); }
    $('provider').disabled = false; providerFields();
  }).catch(error => setStatus(error.message, true));
  update();
}
