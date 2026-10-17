import { clone, floorBounds, nextId, outlineRoom, round } from './model.js';

// Local modules keep example data lazy without relaxing connect-src 'none'.
// Neither a query value nor a project document can choose a module URL.
export const EXAMPLES = Object.freeze([
  { id: 'practice', title: 'Practice home', image: '06-preview.jpg', load: () => import('./examples/practice.js') },
  { id: 'decor', title: 'Decorated studio', image: '10-decor-studio.jpg', load: () => import('./examples/decor.js') },
  { id: 'patterns', title: 'Pattern studio', image: '11-pattern-studio.jpg', load: () => import('./examples/patterns.js') },
  { id: 'garage', title: 'Garage and studio', image: '09-garage-studio.jpg', load: () => import('./examples/garage.js') },
]);

export async function loadExample(id) {
  const example = EXAMPLES.find(entry => entry.id === id);
  if (!example) throw new Error('Unknown example');
  return clone((await example.load()).default);
}

// Call on the editor's transaction copy: room and outline succeed or undo together.
export function addMeasuredRoom(floor, { name, width, depth, walls }) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Room name is required.');
  if (![width, depth].every(value => Number.isFinite(value) && value >= .25 && value <= 100)) {
    throw new Error('Width and depth must be between 0.25 and 100 m.');
  }
  const bounds = floorBounds(floor);
  const x = floor.rooms.length || floor.walls.length || floor.items.length ? Math.ceil(bounds.maxX + 1) : 0;
  const room = { id: nextId(floor, 'room'), name: name.trim(), polygon: [[x, 0], [round(x + width), 0], [round(x + width), round(depth)], [x, round(depth)]], material: 'floor' };
  floor.rooms.push(room);
  if (walls) outlineRoom(floor, room);
  return room.id;
}

export function installOnboarding({ t, getFloor, createRoom, hasContent, replaceProject, validateProject, status, preview, draw, focusPlan, onLocaleChange }) {
  const $ = id => document.getElementById(id);
  const starter = $('room-starter'), gallery = $('examples-dialog');
  const galleryClose = gallery.querySelector('[data-close]');
  const name = $('starter-name'), width = $('starter-width'), depth = $('starter-depth');
  let request = 0, loading = false, exampleMessage = null, roomMessage = null;

  function renderExamples() {
    $('examples-grid').replaceChildren();
    for (const example of EXAMPLES) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'example-card'; button.dataset.example = example.id; button.disabled = loading;
      const image = document.createElement('img');
      image.src = `./guide-assets/${example.image}`; image.alt = ''; image.width = 1280; image.height = 720; image.loading = 'lazy';
      const label = document.createElement('strong'); label.textContent = t(example.title);
      button.append(image, label); button.addEventListener('click', () => openExample(example.id));
      $('examples-grid').append(button);
    }
  }
  function renderMessages() {
    $('examples-status').textContent = exampleMessage ? t(exampleMessage) : '';
    $('starter-error').textContent = roomMessage ? t(roomMessage) : '';
  }
  function showExamples() {
    exampleMessage = null; renderMessages(); renderExamples(); gallery.showModal();
    $('examples-title').focus();
  }
  async function openExample(id) {
    const currentRequest = ++request;
    let committing = false;
    loading = true; exampleMessage = 'Loading example…'; renderMessages();
    gallery.setAttribute('aria-busy', 'true');
    for (const button of $('examples-grid').querySelectorAll('button')) button.disabled = true;
    try {
      const project = await loadExample(id);
      // Closing the dialog cancels an in-flight import; it must not replace a draft later.
      if (currentRequest !== request || !gallery.open) return;
      validateProject(project);
      if (hasContent() && !confirm(t('Open this project and replace the current plan? Export the current plan first if needed. You can undo this.'))) return;
      // After acceptance, replacement may wait for the shared draft lock. It is
      // one commit, not a cancellable download; keep its dialog visibly busy.
      committing = true; galleryClose.disabled = true;
      const replaced = await replaceProject(project, () => t('Fictional demo loaded. All names, geometry, and entities are examples.'));
      committing = false; galleryClose.disabled = false;
      if (currentRequest !== request || !gallery.open) return;
      if (replaced === false) { gallery.close(); return; }
      gallery.close(); preview();
    } catch {
      if (currentRequest !== request || !gallery.open) return;
      exampleMessage = 'Could not open example. Your current plan is unchanged.';
      renderMessages(); status(() => t('Could not open example. Your current plan is unchanged.'), true);
    } finally {
      if (committing) galleryClose.disabled = false;
      if (currentRequest === request) {
        gallery.removeAttribute('aria-busy');
        loading = false;
        if (exampleMessage === 'Loading example…') exampleMessage = null;
        renderMessages();
        for (const button of $('examples-grid').querySelectorAll('button')) button.disabled = false;
        if (gallery.open) $('examples-grid').querySelector(`[data-example="${id}"]`)?.focus();
      }
    }
  }
  gallery.addEventListener('cancel', event => { if (galleryClose.disabled) event.preventDefault(); });
  gallery.addEventListener('close', () => { request++; loading = false; gallery.removeAttribute('aria-busy'); });
  $('browse-examples').addEventListener('click', showExamples);
  $('load-demo').addEventListener('click', showExamples);

  function showStarter() {
    name.value = `${t('Room')} ${getFloor().rooms.length + 1}`;
    width.value = '4'; depth.value = '3'; $('starter-walls').checked = true;
    roomMessage = null; renderMessages();
    for (const input of [name, width, depth]) input.removeAttribute('aria-invalid');
    starter.showModal(); name.focus(); name.select();
  }
  $('start-room').addEventListener('click', showStarter);
  $('measured-room').addEventListener('click', showStarter);
  $('start-drawing').addEventListener('click', draw);
  $('room-starter-form').addEventListener('submit', event => {
    event.preventDefault(); roomMessage = null;
    for (const input of [name, width, depth]) input.removeAttribute('aria-invalid');
    const invalid = !name.value.trim() ? name : [width, depth].find(input => !input.value || !Number.isFinite(Number(input.value)) || Number(input.value) < .25 || Number(input.value) > 100);
    if (invalid) {
      roomMessage = invalid === name ? 'Room name is required.' : 'Width and depth must be between 0.25 and 100 m.';
      invalid.setAttribute('aria-invalid', 'true'); renderMessages(); invalid.focus(); return;
    }
    const result = createRoom({ name: name.value, width: Number(width.value), depth: Number(depth.value), walls: $('starter-walls').checked });
    if (!result.ok) { $('starter-error').textContent = result.error; return; }
    starter.close(); focusPlan();
  });
  onLocaleChange(() => { if (gallery.open) renderExamples(); renderMessages(); });

  const url = new URL(location.href), selected = url.searchParams.get('example');
  if (EXAMPLES.some(example => example.id === selected)) {
    // Consume the launch intent so a reload restores edits instead of reopening the sample.
    url.searchParams.delete('example');
    try { window.history.replaceState(window.history.state, '', url); } catch { /* History may be restricted. */ }
    showExamples(); void openExample(selected);
  }
}
