// Keep the editable JSON format compatible with earlier releases. All writers
// share a Web Lock; comparing bytes alone would leave a cross-tab write race.
export const DRAFT_KEY = 'home-studio.project.v1';
export const PREVIOUS_KEY = 'home-studio.previous-project.v1';
export const DAMAGED_KEY = 'home-studio.damaged-project.v1';
const LOCK_NAME = 'home-studio.draft-writer.v1';

export function createDraftStorage({ validate, maxBytes, storage = () => globalThis.localStorage, locks = globalThis.navigator?.locks } = {}) {
  let baseline, initial = false, paused = null, tail = Promise.resolve();
  function parse(raw) {
    if (raw === null) return null;
    if (new Blob([raw]).size > maxBytes) throw new Error('Saved draft is too large.');
    return validate(JSON.parse(raw));
  }
  function inspect() {
    const store = storage(), raw = store.getItem(DRAFT_KEY);
    let current = null, previous = null, error = null;
    try { current = parse(raw); } catch (failure) { error = failure; }
    const previousRaw = store.getItem(PREVIOUS_KEY);
    try { previous = parse(previousRaw); } catch { /* An invalid checkpoint is never offered for restoration. */ }
    return { raw, current, previous, previousRaw: previous ? previousRaw : null, damaged: error ? raw : store.getItem(DAMAGED_KEY), error };
  }
  function read() {
    try {
      const result = inspect(); baseline = result.raw; initial = true;
      paused = result.error ? 'unreadable' : null;
      return result;
    } catch (error) { paused = 'unavailable'; return { current: null, error }; }
  }
  function changed() {
    try {
      if (!initial || storage().getItem(DRAFT_KEY) !== baseline) paused = 'conflict';
    } catch { paused = 'unavailable'; }
    return paused;
  }
  function enqueue(operation) {
    const job = tail.then(async () => {
      try {
        // Without an origin-wide lock, a check followed by setItem is not atomic.
        // Keep editing/export available instead of risking another tab's draft.
        if (!locks?.request) throw new Error('This browser cannot coordinate draft saves.');
        return await locks.request(LOCK_NAME, operation);
      } catch (error) { paused = 'unavailable'; return { status: paused, error }; }
    });
    tail = job.then(() => {});
    return job;
  }
  function checkpoint(store, raw) {
    if (raw !== null && raw !== undefined) { parse(raw); store.setItem(PREVIOUS_KEY, raw); }
  }
  function save(raw, { previous, replace, isCurrent } = {}) {
    return enqueue(() => {
      if (isCurrent && !isCurrent()) return { status: 'cancelled' };
      parse(raw);
      const store = storage(), current = store.getItem(DRAFT_KEY);
      const expected = replace ? replace.raw : baseline;
      if ((!initial && !replace) || current !== expected) { paused = 'conflict'; return { status: paused }; }
      if (paused && !replace) return { status: paused };
      let validCurrent = null;
      try { validCurrent = parse(current); } catch { /* Explicit replacement preserves the unreadable bytes first. */ }
      const oldPrevious = store.getItem(PREVIOUS_KEY), oldDamaged = store.getItem(DAMAGED_KEY);
      function rollback() {
        for (const [key, value] of [[PREVIOUS_KEY, oldPrevious], [DAMAGED_KEY, oldDamaged]]) {
          try { if (value === null) store.removeItem(key); else store.setItem(key, value); } catch { /* Preserve the current draft even if storage is no longer writable. */ }
        }
      }
      try {
        if (replace && current !== null && !validCurrent) store.setItem(DAMAGED_KEY, current);
        if (replace && validCurrent && current !== raw) checkpoint(store, current);
        else if (previous !== undefined) checkpoint(store, previous);
        else if (!store.getItem(PREVIOUS_KEY) && validCurrent && current !== raw) checkpoint(store, current);
        // Recheck after writing recovery data as protection against older clients
        // that do not participate in our lock protocol.
        if (store.getItem(DRAFT_KEY) !== current) { rollback(); paused = 'conflict'; return { status: paused }; }
        store.setItem(DRAFT_KEY, raw); baseline = raw; initial = true; paused = null;
        return { status: 'saved' };
      } catch (error) { rollback(); throw error; }
    });
  }
  function load(snapshot, local) {
    return enqueue(() => {
      const store = storage();
      if (store.getItem(DRAFT_KEY) !== snapshot.raw) { paused = 'conflict'; return { status: paused }; }
      const current = parse(snapshot.raw);
      if (!current) throw new Error('No saved draft is available.');
      if (local !== snapshot.raw) checkpoint(store, local);
      baseline = snapshot.raw; initial = true; paused = null;
      return { status: 'saved', current };
    });
  }
  return Object.freeze({ read, inspect, changed, save, load });
}
