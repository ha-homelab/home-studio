// Local ES modules keep translations available under the planner's offline CSP.
import english from './locales/en.js';
import { LOCALES } from './locales/index.js';

export { LOCALES };
export const LANGUAGE_STORAGE_KEY = 'home-studio.language.v1';
let locale = 'en', dictionary = english, revision = 0;
const listeners = new Set();
const supported = new Map(LOCALES.map(entry => [entry.code.toLowerCase(), entry.code]));

export function resolveLocale(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().replaceAll('_', '-').toLowerCase();
  if (supported.has(code)) return supported.get(code);
  if (/^zh(?:-|$)/.test(code)) {
    return /(?:^|-)(?:hant|tw|hk|mo)(?:-|$)/.test(code) ? 'zh-Hant' : 'zh-Hans';
  }
  return supported.get(code.split('-')[0]) || null;
}

export function getLocale() { return locale; }
export function getDirection() {
  return LOCALES.find(entry => entry.code === locale)?.dir || (/^(ar|he|fa|ur)(-|$)/.test(locale) ? 'rtl' : 'ltr');
}

export function t(key, params = {}) {
  const own = Object.prototype.hasOwnProperty;
  const translated = own.call(dictionary, key) && typeof dictionary[key] === 'string' ? dictionary[key] : null;
  const fallback = own.call(english, key) && typeof english[key] === 'string' ? english[key] : key;
  const text = translated ?? fallback;
  return text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, name) => own.call(params, name) ? String(params[name]) : placeholder);
}

export function onLocaleChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }

export async function setLocale(requested, { persist = true } = {}) {
  const request = ++revision;
  let next = resolveLocale(requested) || 'en', nextDictionary = english, loaded = true;
  if (next !== 'en') {
    try {
      // The module name comes only from LOCALES, never directly from input.
      const module = await import(`./locales/${next}.js`);
      if (!module.default || typeof module.default !== 'object' || Array.isArray(module.default)) throw new Error('Invalid locale dictionary');
      nextDictionary = module.default;
    } catch { next = 'en'; loaded = false; }
  }
  if (request !== revision) return { locale, loaded, applied: false };
  locale = next; dictionary = nextDictionary;
  if (persist) { try { globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, locale); } catch { /* The editor also works without storage. */ } }
  for (const listener of listeners) listener({ locale, loaded });
  return { locale, loaded, applied: true };
}

export async function initI18n() {
  let saved;
  try { saved = globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY); } catch { /* Private browsers can deny storage. */ }
  const browserLanguages = [...(globalThis.navigator?.languages || []), globalThis.navigator?.language];
  const requested = new URLSearchParams(globalThis.location?.search || '').get('lang');
  const preferred = resolveLocale(requested) || resolveLocale(saved) || browserLanguages.map(resolveLocale).find(Boolean) || 'en';
  return setLocale(preferred, { persist: false });
}

// Only explicit translation markers are touched. Values, user names, and IDs
// never pass through this function, and translated strings are never HTML.
export function translateStatic(root = document) {
  for (const element of root.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
  for (const element of root.querySelectorAll('[data-i18n-attrs]')) {
    const attrs = JSON.parse(element.dataset.i18nAttrs);
    for (const [attribute, key] of Object.entries(attrs)) {
      if (['title', 'aria-label', 'placeholder'].includes(attribute)) element.setAttribute(attribute, t(key));
    }
  }
  const page = root.documentElement || root.ownerDocument?.documentElement;
  if (page) { page.lang = locale; page.dir = getDirection(); }
}
