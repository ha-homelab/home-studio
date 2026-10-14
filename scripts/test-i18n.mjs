// Translation contracts: complete packs, safe interpolation, and stable identifiers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { LOCALES, t, setLocale, getLocale, getDirection, resolveLocale, initI18n, LANGUAGE_STORAGE_KEY } from '../planner/i18n.js';
import english from '../planner/locales/en.js';
import { CATALOG } from '../planner/catalog.js';
import { PATTERNS } from '../planner/furniture.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keys = Object.keys(english).sort();
const placeholders = text => [...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]).sort();
assert.equal(new Set(LOCALES.map(entry => entry.code)).size, LOCALES.length);
assert(LOCALES.some(entry => entry.code === 'en'));
for (const [kind, entries] of [['model', CATALOG.models], ['category', CATALOG.categories], ['palette', CATALOG.styles], ['pattern', PATTERNS]]) {
  for (const entry of entries) assert.equal(english[`${kind}.${entry.id}`], entry.label, `${kind}.${entry.id}`);
}

for (const locale of LOCALES) {
  assert.match(locale.code, /^[a-z]{2}(?:-[A-Za-z]{2,4})?$/);
  assert(locale.name && (!locale.dir || ['ltr', 'rtl'].includes(locale.dir)));
  const { default: messages } = await import(`../planner/locales/${locale.code}.js`);
  const missing = keys.filter(key => !(key in messages));
  const extra = Object.keys(messages).filter(key => !(key in english));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${locale.code}: complete key coverage`);
  for (const key of keys) {
    assert.equal(typeof messages[key], 'string', `${locale.code}: ${key}`);
    assert(messages[key].trim(), `${locale.code}: empty ${key}`);
    assert.deepEqual(placeholders(messages[key]), placeholders(english[key]), `${locale.code}: placeholders in ${key}`);
  }
  if (locale.code !== 'en') {
    // Proper names, acronyms and coordinate labels may legitimately be identical.
    const translated = keys.filter(key => messages[key] !== english[key]).length;
    assert(translated > keys.length * .9, `${locale.code}: copied English cannot stand in for a language pack`);
    const readme = path.join(root, `docs/translations/README.${locale.code}.md`);
    assert(fs.existsSync(readme), `${locale.code}: localized quick start`);
    const source = fs.readFileSync(readme, 'utf8');
    assert(source.includes(`?lang=${locale.code}`));
    assert(source.includes('python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package'));
  }
}

assert.equal(resolveLocale('ru-RU'), 'ru');
assert.equal(resolveLocale('pt_BR'), 'pt');
assert.equal(resolveLocale('zh-CN'), 'zh-Hans');
assert.equal(resolveLocale('zh-SG'), 'zh-Hans');
for (const code of ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant-TW']) assert.equal(resolveLocale(code), 'zh-Hant');
for (const value of [null, 42, '', '../../../evil', 'https://example.test/ar.js', 'unsupported']) assert.equal(resolveLocale(value), null);

await setLocale('en', { persist: false });
assert.equal(t('unknown key'), 'unknown key');
assert.equal(t('ID: {id}', { id: '<img onerror=evil()>' }), 'ID: <img onerror=evil()>');
assert.equal(t('ID: {id}', Object.create({ id: 'inherited' })), 'ID: {id}');
assert.equal(t('constructor'), 'constructor');
const pending = setLocale('ar', { persist: false });
await setLocale('en', { persist: false });
assert.equal((await pending).applied, false, 'obsolete async language request cannot replace the latest selection');
assert.equal(getLocale(), 'en');
await setLocale('he', { persist: false });
assert.equal(getDirection(), 'rtl');
await setLocale('ja', { persist: false });
assert.equal(getDirection(), 'ltr');

const storage = new Map();
const properties = ['localStorage', 'navigator', 'location'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
try {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { languages: ['unsupported', 'ru-RU'] } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: '' } });
  await initI18n(); assert.equal(getLocale(), 'ru');
  await setLocale('de'); assert.equal(storage.get(LANGUAGE_STORAGE_KEY), 'de');
  await initI18n(); assert.equal(getLocale(), 'de');
  globalThis.location.search = '?lang=ja'; await initI18n(); assert.equal(getLocale(), 'ja');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage denied'); } });
  await setLocale('fr'); assert.equal(getLocale(), 'fr', 'denied storage does not break switching');
} finally {
  for (const [key, descriptor] of properties) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
}
console.log(`Translation contracts passed: ${LOCALES.length} complete languages × ${keys.length} messages, catalog coverage, placeholders, fallback, regional matching, async races and denied storage.`);
