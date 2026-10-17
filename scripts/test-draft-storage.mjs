import assert from 'node:assert/strict';
import { createDraftStorage, DRAFT_KEY, PREVIOUS_KEY, DAMAGED_KEY } from '../planner/draft-storage.js';
import { blankProject, validateProject, LIMITS } from '../planner/model.js';

const document = title => JSON.stringify({ ...blankProject(), title });
const original = document('Original'), edited = document('Edited'), replacement = document('Replacement');
function fixture(seed = {}, options = {}) {
  const values = new Map(Object.entries(seed));
  let tail = Promise.resolve(), failingKey;
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) { if (key === failingKey) throw new Error('Quota exceeded'); values.set(key, value); },
    removeItem: key => values.delete(key),
  };
  const locks = { request(_name, action) { const job = tail.then(action); tail = job.catch(() => {}); return job; } };
  const create = () => createDraftStorage({ validate: validateProject, maxBytes: LIMITS.bytes, storage: () => storage, locks, ...options });
  return { values, storage, create, fail: key => { failingKey = key; } };
}

{
  const f = fixture({ [DRAFT_KEY]: original }), drafts = f.create();
  assert.equal(drafts.read().current.title, 'Original');
  assert.deepEqual(await drafts.save(edited), { status: 'saved' });
  assert.equal(f.values.get(PREVIOUS_KEY), original);
  assert.equal((await drafts.save(replacement, { previous: edited })).status, 'saved');
  assert.equal(f.values.get(PREVIOUS_KEY), edited);
  assert.equal((await drafts.save(document('Later edit'))).status, 'saved');
  assert.equal(f.values.get(PREVIOUS_KEY), edited, 'ordinary edits retain the previous project');
  const fresh = f.create(); assert.equal(fresh.read().previous.title, 'Edited');
  const snapshot = fresh.inspect();
  assert.equal((await fresh.save(snapshot.previousRaw, { replace: snapshot })).status, 'saved');
  assert.equal(f.values.get(DRAFT_KEY), edited);
  assert.equal(JSON.parse(f.values.get(PREVIOUS_KEY)).title, 'Later edit');
}
{
  const damaged = '{"title":"Recover these original bytes"';
  const f = fixture({ [DRAFT_KEY]: damaged, [PREVIOUS_KEY]: original }), drafts = f.create();
  assert(drafts.read().error);
  assert.equal((await drafts.save(edited)).status, 'unreadable');
  assert.equal(f.values.get(DRAFT_KEY), damaged);
  assert.equal(drafts.inspect().damaged, damaged);
  assert.equal((await drafts.save(edited, { replace: drafts.inspect() })).status, 'saved');
  assert.equal(f.values.get(DAMAGED_KEY), damaged);
  assert.equal(f.create().read().damaged, damaged, 'damaged data survives reload and explicit replacement');
}
{
  const f = fixture({ [DRAFT_KEY]: original }), first = f.create(), second = f.create();
  first.read(); second.read();
  const results = await Promise.all([first.save(edited), second.save(replacement)]);
  assert.deepEqual(results.map(result => result.status), ['saved', 'conflict']);
  assert.equal(f.values.get(DRAFT_KEY), edited, 'two writers cannot silently replace one another');
  const staleReview = second.inspect();
  await first.save(document('Another edit'));
  assert.equal((await second.save(replacement, { replace: staleReview })).status, 'conflict');
  assert.equal(JSON.parse(f.values.get(DRAFT_KEY)).title, 'Another edit');
  assert.equal((await second.load(second.inspect(), replacement)).status, 'saved');
  assert.equal(f.values.get(PREVIOUS_KEY), replacement, 'loading saved work keeps the outgoing local version');
  assert.equal((await second.save(edited)).status, 'saved');
}
{
  const f = fixture({ [DRAFT_KEY]: original, [PREVIOUS_KEY]: replacement }), drafts = f.create(); drafts.read();
  f.fail(DRAFT_KEY);
  assert.equal((await drafts.save(edited, { previous: original })).status, 'unavailable');
  assert.equal(f.values.get(DRAFT_KEY), original);
  assert.equal(f.values.get(PREVIOUS_KEY), replacement, 'failed main write rolls the checkpoint back');
  f.fail(PREVIOUS_KEY);
  assert.equal((await drafts.save(edited, { previous: original, replace: drafts.inspect() })).status, 'unavailable');
  assert.equal(f.values.get(DRAFT_KEY), original);
}
{
  const f = fixture({ [DRAFT_KEY]: original, [PREVIOUS_KEY]: 'x'.repeat(LIMITS.bytes + 1) }), drafts = f.create();
  assert.equal(drafts.read().previous, null, 'oversized or invalid checkpoints are not offered');
  assert.equal((await drafts.save(edited, { previous: 'invalid JSON' })).status, 'unavailable');
  assert.equal(f.values.get(DRAFT_KEY), original);
}
{
  const f = fixture({ [DRAFT_KEY]: original }, { locks: null }), drafts = f.create(); drafts.read();
  assert.equal((await drafts.save(edited)).status, 'unavailable');
  assert.equal(f.values.get(DRAFT_KEY), original, 'unsupported coordination never risks a competing draft');
  const denied = createDraftStorage({ validate: validateProject, maxBytes: LIMITS.bytes, storage() { throw new Error('Denied'); } });
  assert(denied.read().error);
}
{
  const f = fixture({ [DRAFT_KEY]: original }), drafts = f.create(); drafts.read();
  let current = true;
  const stale = drafts.save(replacement, { previous: original, isCurrent: () => current }); current = false;
  assert.equal((await stale).status, 'cancelled'); assert.equal(f.values.get(DRAFT_KEY), original);
  await drafts.save(edited);
  await drafts.save(replacement, { previous: edited });
  await drafts.save(edited);
  assert.equal(f.values.get(DRAFT_KEY), edited, 'queued edit, replacement and undo keep invocation order');
}
console.log('Draft storage checks passed: recovery, raw preservation, shared writer lock, stale review, quota rollback, unavailable storage and cancelled replacement.');
