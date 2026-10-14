// The authenticated host owns preference storage; the viewer has an opaque origin.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function fixture({ denied = false } = {}) {
  let Panel;
  const stored = new Map(), sent = [], calls = [];
  const context = vm.createContext({
    HTMLElement: class {},
    customElements: { get() {}, define(name, value) { Panel = value; } },
    localStorage: { setItem(key, value) { if (denied) throw Error('denied'); stored.set(key, value); } },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'custom_components/home_floorplan/static/panel.js'), 'utf8'), context);
  const panel = Object.assign(Object.create(Panel.prototype), {
    generation: 1, started: true, viewPreferences: { sidebarCollapsed: false },
    port: { postMessage(message) { sent.push(JSON.parse(JSON.stringify(message))); } },
    publishEntityStates() {}, loadFloor() { calls.push('load'); },
  });
  return { panel, stored, sent, calls, resolve: value => context.resolveViewerLanguage(value),
    languages: vm.runInContext('JSON.stringify(viewerLanguages)', context) };
}

test('host languages match the embedded viewer and normalize HA regional tags', () => {
  const { resolve, languages } = fixture();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'viewer-locales/index.json'), 'utf8'));
  assert.deepEqual(JSON.parse(languages), manifest.map(locale => locale.code));
  for (const [value, expected] of [['ru-RU', 'ru'], ['pt_BR', 'pt'], ['zh-TW', 'zh-Hant'], ['zh-Hans-CN', 'zh-Hans'],
    ['zh-HK', 'zh-Hant'], ['FR-ca', 'fr'], ['en', 'en'], ['../ru', null], ['constructor', null], [null, null]]) {
    assert.equal(resolve(value), expected);
  }
});

test('HA language follows updates until an explicit viewer choice wins', () => {
  const { panel, sent, stored, calls } = fixture();
  panel.hass = { locale: { language: 'ru-RU' } };
  panel.hass = { locale: { language: 'ru-RU' } };
  assert.deepEqual(sent, [{ type: 'view_preferences', language: 'ru' }]);
  panel.hass = { language: 'de' };
  assert.equal(sent.at(-1).language, 'de');
  panel.handleViewerMessage({ type: 'view_preferences', language: 'ar' }, 1);
  panel.hass = { locale: { language: 'fr' } };
  assert.equal(panel.viewPreferences.language, 'ar');
  assert.equal(stored.get('home-studio.language.v1'), 'ar');
  assert.equal(sent.length, 2, 'no HA update can overwrite the explicit choice');
  assert.deepEqual(calls, [], 'a language choice never reloads or saves a plan');
});

test('language and sidebar preference updates are independent and validated', () => {
  const { panel, stored } = fixture();
  const send = (message, generation = 1) => panel.handleViewerMessage({ type: 'view_preferences', ...message }, generation);
  send({ sidebarCollapsed: true });
  send({ language: 'ja' });
  assert.equal(panel.viewPreferences.sidebarCollapsed, true);
  assert.equal(panel.viewPreferences.language, 'ja');
  for (const language of ['../fr', 'en-US', 'constructor', null, {}, ['ru']]) send({ language });
  send({ language: 'de' }, 0);
  panel.recovery = {}; send({ language: 'fr' }); panel.recovery = null;
  assert.equal(panel.viewPreferences.language, 'ja');
  assert.equal(stored.get('home-studio.language.v1'), 'ja');
  send({ sidebarCollapsed: false, language: 'he' });
  assert.equal(panel.viewPreferences.sidebarCollapsed, false);
  assert.equal(panel.viewPreferences.language, 'he');
});

test('unsupported HA profile languages fall back to English, including after an update', () => {
  const { panel, sent } = fixture();
  panel.hass = { locale: { language: 'sv' } };
  assert.equal(panel.viewPreferences.language, 'en');
  panel.hass = { locale: { language: 'ru' } };
  panel.hass = { locale: { language: 'sv' } };
  assert.deepEqual(sent.map(message => message.language), ['en', 'ru', 'en']);
  panel.handleViewerMessage({ type: 'view_preferences', language: 'de' }, 1);
  panel.hass = { locale: { language: 'sv' } };
  assert.equal(panel.viewPreferences.language, 'de', 'explicit choices still win');
});

test('denied storage still permits the current-session language preference', () => {
  const { panel, stored } = fixture({ denied: true });
  assert.doesNotThrow(() => panel.handleViewerMessage({ type: 'view_preferences', language: 'fa' }, 1));
  panel.hass = { language: 'en' };
  assert.equal(panel.viewPreferences.language, 'fa');
  assert.equal(panel.explicitLanguage, 'fa');
  assert.equal(stored.size, 0);
});
