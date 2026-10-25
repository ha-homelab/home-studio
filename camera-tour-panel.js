import { CAMERA_TOUR_LIMITS } from './camera-tour.js';

/** The owner handles visibility, manual input, and recording. refresh() reads the
 * current state without rebuilding unchanged rows. record() toggles recording;
 * the owner calls setRecording(boolean) and setStatus(string). dispose() removes
 * this panel and subscription; the owner disposes its tour separately. */
export function createCameraTourPanel({ container, tour, t = value => value, record, onClose, canExport = true } = {}) {
  if (!container || !tour) throw new TypeError('A camera tour and panel container are required.');
  const doc = container.ownerDocument;
  let recording = false, disposed = false, routeKey = '', customStatus = '', statusIsError = false, rows = [];
  let exportAllowed = canExport === true;
  const exportUnavailable = 'You can create and play tours here. Your Home Assistant access does not allow route or video downloads.';
  const label = (value, values = {}) => {
    let translated = t(value, values) || value;
    for (const [key, replacement] of Object.entries(values)) translated = translated.replaceAll(`{${key}}`, String(replacement));
    return translated;
  };
  function element(tag, content = '', className = '') {
    const node = doc.createElement(tag); node.textContent = content; node.className = className; return node;
  }
  function button(content, action, accessible = content) {
    const node = element('button', label(content)); node.type = 'button'; node.setAttribute('aria-label', label(accessible));
    node.addEventListener('click', () => run(action)); return node;
  }
  async function run(action) {
    if (disposed) return;
    customStatus = ''; statusIsError = false;
    try { await action(); } catch (failure) { customStatus = failure.message || label('Could not complete this action.'); statusIsError = true; }
    if (!disposed) refresh();
  }
  const panel = element('section', '', 'camera-tour-panel'); panel.setAttribute('aria-label', label('Camera tour'));
  const header = element('header', '', 'camera-tour-header');
  const close = button('Close', () => typeof onClose === 'function' ? onClose() : tour.stop(), 'Close camera tour');
  header.append(element('h2', label('Camera tour')), close);
  const help = element('p', label('Save views, arrange their order, then play or record the route.'), 'camera-tour-help');
  const storage = element('p', label('Views stay in this tab. Export the route to keep it.'), 'camera-tour-help');
  const add = button('Save current view', () => tour.add(label('View {number}', { number: tour.getState().waypoints.length + 1 })));
  add.classList.add('camera-tour-primary');
  const list = element('ol', '', 'camera-tour-list'); list.setAttribute('aria-label', label('Saved views'));
  const empty = element('p', label('Move the camera to your first viewpoint and save it.'), 'camera-tour-empty');
  const note = element('p', label('Seconds sets travel time to the next view; the last view holds. Changes of floor or room use a cut.'), 'camera-tour-help');
  const transport = element('div', '', 'camera-tour-actions');
  const play = button('Play', () => tour.play()), pause = button('Pause', () => tour.pause()), stop = button('Stop', () => tour.stop());
  transport.append(play, pause, stop);
  const progress = element('progress'); progress.setAttribute('aria-label', label('Tour progress'));
  const timing = element('span', '', 'camera-tour-timing');
  const meter = element('div', '', 'camera-tour-meter'); meter.append(progress, timing);
  const files = element('div', '', 'camera-tour-actions');
  const exportButton = button('Export route', () => {
    if (!exportAllowed) throw new Error(label(exportUnavailable));
    const blob = new Blob([JSON.stringify(tour.export(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = element('a'); link.href = url; link.download = 'camera-tour.json';
    panel.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
    customStatus = label('Route exported.');
  });
  const file = element('input'); file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
  file.setAttribute('aria-label', label('Import camera route JSON'));
  file.addEventListener('change', () => run(async () => {
    const selected = file.files?.[0];
    try {
      if (!selected) return;
      if (selected.size > CAMERA_TOUR_LIMITS.bytes) throw new Error(label('Tour file is too large.'));
      const value = await selected.text();
      if (disposed) return;
      if (recording || tour.getState().status === 'playing') throw new Error(label('Stop playback before importing a route.'));
      tour.import(value); customStatus = label('Route imported.');
    } finally { file.value = ''; }
  }));
  const importButton = button('Import route', () => file.click()); files.append(exportButton, importButton, file);
  const recordButton = typeof record === 'function' ? button('Record video', () => record()) : null;
  if (recordButton) files.append(recordButton);
  const status = element('p', '', 'camera-tour-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  // Route shortcuts must not reach the underlying house editor.
  panel.addEventListener('keydown', event => event.stopPropagation());
  panel.append(header, help, storage, add, empty, list, note, transport, meter, files, status); container.append(panel);

  function makeRow(view, index) {
    const row = element('li', '', 'camera-tour-view'); row.dataset.waypointId = view.id;
    const fields = element('div', '', 'camera-tour-fields');
    const nameLabel = element('label', '', 'camera-tour-field'), name = element('input');
    name.type = 'text'; name.maxLength = CAMERA_TOUR_LIMITS.text; name.value = view.name;
    name.setAttribute('aria-label', label('View {number} name', { number: index + 1 }));
    nameLabel.append(element('span', label('Name')), name);
    const durationLabel = element('label', '', 'camera-tour-field camera-tour-duration'), duration = element('input');
    duration.type = 'number'; duration.min = String(CAMERA_TOUR_LIMITS.minDuration); duration.max = String(CAMERA_TOUR_LIMITS.seconds);
    duration.step = '0.25'; duration.value = String(view.duration);
    duration.setAttribute('aria-label', label('View {number} seconds', { number: index + 1 }));
    durationLabel.append(element('span', label('Seconds')), duration); fields.append(nameLabel, durationLabel);
    const update = (input, change) => run(() => {
      try { tour.update(view.id, change); }
      catch (failure) { input.value = input === name ? view.name : String(view.duration); throw failure; }
    });
    name.addEventListener('change', () => update(name, { name: name.value }));
    duration.addEventListener('change', () => update(duration, { duration: duration.valueAsNumber }));
    const description = element('span', `${view.pose.floorId}${view.pose.type === 'home' && view.pose.room ? ` · ${view.pose.room}` : ''}`, 'camera-tour-location');
    const actions = element('div', '', 'camera-tour-row-actions');
    const preview = button('Preview', () => tour.seek(index), label('Preview view {number}', { number: index + 1 }));
    const up = button('↑', () => tour.move(view.id, -1), label('Move view {number} up', { number: index + 1 }));
    const down = button('↓', () => tour.move(view.id, 1), label('Move view {number} down', { number: index + 1 }));
    const remove = button('Remove', () => tour.remove(view.id), label('Remove view {number}', { number: index + 1 }));
    actions.append(preview, up, down, remove); row.append(fields, description, actions);
    return { row, name, duration, preview, up, down, remove };
  }
  function refresh() {
    if (disposed) return;
    const state = tour.getState(), key = JSON.stringify(state.waypoints), locked = recording || state.status === 'playing';
    if (key !== routeKey) {
      routeKey = key; rows = state.waypoints.map(makeRow); list.replaceChildren(...rows.map(item => item.row));
    }
    rows.forEach((item, index) => {
      for (const control of [item.name, item.duration, item.preview, item.remove]) control.disabled = locked;
      item.up.disabled = locked || index === 0; item.down.disabled = locked || index === rows.length - 1;
      if (state.status !== 'idle' && index === state.index) item.row.setAttribute('aria-current', 'step');
      else item.row.removeAttribute('aria-current');
    });
    const hasViews = state.waypoints.length > 0;
    const storageMessage = label(exportAllowed ? 'Views stay in this tab. Export the route to keep it.' : exportUnavailable);
    if (storage.textContent !== storageMessage) storage.textContent = storageMessage;
    empty.hidden = hasViews; note.hidden = !hasViews;
    add.disabled = locked || rows.length >= CAMERA_TOUR_LIMITS.waypoints || state.totalDuration + 3 > CAMERA_TOUR_LIMITS.seconds;
    play.disabled = !hasViews || state.status === 'playing' || recording; pause.disabled = state.status !== 'playing' || recording;
    stop.disabled = state.status === 'idle' && !recording;
    exportButton.disabled = !exportAllowed || !hasViews; importButton.disabled = locked;
    if (recordButton) {
      const caption = label(recording ? 'Stop recording' : 'Record video');
      recordButton.textContent = caption; recordButton.setAttribute('aria-label', caption);
      recordButton.setAttribute('aria-pressed', String(recording)); recordButton.disabled = !exportAllowed || (!recording && (!hasViews || state.status === 'playing'));
    }
    progress.max = state.totalDuration || 1; progress.value = state.elapsed;
    const time = `${state.elapsed.toFixed(1)} / ${state.totalDuration.toFixed(1)} ${label('s')}`;
    if (timing.textContent !== time) timing.textContent = time;
    const defaults = { idle: 'Ready', playing: 'Playing', paused: 'Paused', completed: 'Tour finished' };
    const message = customStatus || state.error || label(recording ? 'Recording' : defaults[state.status] || 'Ready');
    if (status.textContent !== message) status.textContent = message;
    status.classList.toggle('camera-tour-error', statusIsError || Boolean(state.error));
  }
  const unsubscribe = tour.subscribe(refresh); refresh();
  return {
    refresh,
    setExportAllowed(value) {
      if (disposed || exportAllowed === (value === true)) return;
      exportAllowed = value === true; customStatus = ''; statusIsError = false; refresh();
    },
    setRecording(value) { recording = Boolean(value); refresh(); },
    setStatus(value = '') { customStatus = String(value); statusIsError = false; refresh(); },
    dispose() { if (disposed) return; disposed = true; unsubscribe(); panel.remove(); }
  };
}
