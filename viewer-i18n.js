// Small, self-contained runtime: the compiler embeds only viewer-locales/*.json.
// No network requests or editor catalog are needed by a downloaded viewer.
function createViewerI18n(data, environment = globalThis) {
  const english = data.dictionaries.en, locales = data.locales;
  const supported = new Map(locales.map(entry => [entry.code.toLowerCase(), entry.code]));
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const listeners = new Set(), storageKey = 'home-studio.language.v1';
  let locale = 'en', explicitQuery = false;
  function resolve(value) {
    if (typeof value !== 'string') return null;
    const code = value.trim().replaceAll('_', '-').toLowerCase();
    if (supported.has(code)) return supported.get(code);
    if (/^zh(?:-|$)/.test(code)) return /(?:^|-)(?:hant|tw|hk|mo)(?:-|$)/.test(code) ? 'zh-Hant' : 'zh-Hans';
    return supported.get(code.split('-')[0]) || null;
  }
  function t(key, params = {}) {
    const dictionary = data.dictionaries[locale] || english;
    const value = own(dictionary, key) && typeof dictionary[key] === 'string' ? dictionary[key] : own(english, key) ? english[key] : key;
    return value.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, name) => own(params, name) ? String(params[name]) : placeholder);
  }
  function translate(root = environment.document) {
    if (!root) return;
    for (const element of root.querySelectorAll('[data-viewer-i18n]')) element.textContent = t(element.dataset.viewerI18n);
    for (const element of root.querySelectorAll('[data-viewer-i18n-attrs]')) {
      for (const [attribute, key] of Object.entries(JSON.parse(element.dataset.viewerI18nAttrs))) {
        if (['title', 'aria-label', 'placeholder', 'alt'].includes(attribute)) element.setAttribute(attribute, t(key));
      }
    }
    for (const picker of root.querySelectorAll('[data-viewer-language]')) picker.value = locale;
    if (root.documentElement) {
      root.documentElement.lang = locale;
      root.documentElement.dir = locales.find(entry => entry.code === locale)?.dir || 'ltr';
    }
  }
  function setLocale(requested, { source = 'user' } = {}) {
    const next = resolve(requested);
    if (!next) return false;
    locale = next;
    if (source === 'user') {
      explicitQuery = false;
      try { environment.localStorage?.setItem(storageKey, locale); } catch { /* Opaque-origin installed frames use the host preference channel. */ }
      try {
        const url = new URL(environment.location?.href);
        if (['https:', 'http:', 'file:'].includes(url.protocol)) {
          url.searchParams.set('lang', locale);
          environment.history?.replaceState(environment.history.state, '', url.href);
        }
      } catch { /* Sandboxed frames retain their choice through the host; form state is unchanged. */ }
    }
    translate();
    for (const listener of listeners) listener({ locale, source });
    return true;
  }
  function init() {
    let saved;
    try { saved = environment.localStorage?.getItem(storageKey); } catch { /* Optional in sandboxed frames and private browsers. */ }
    const query = resolve(new URLSearchParams(environment.location?.search || '').get('lang'));
    explicitQuery = !!query;
    const browser = [...(environment.navigator?.languages || []), environment.navigator?.language].map(resolve).find(Boolean);
    for (const picker of environment.document?.querySelectorAll('[data-viewer-language]') || []) {
      for (const entry of locales) {
        const option = environment.document.createElement('option');
        option.value = entry.code; option.textContent = entry.name; option.lang = entry.code; option.dir = entry.dir || 'ltr';
        picker.append(option);
      }
      picker.addEventListener('change', () => setLocale(picker.value));
    }
    setLocale(query || resolve(saved) || browser || 'en', { source: 'initial' });
  }
  return { t, resolve, init, translate, setLocale, get locale() { return locale; },
    applyPreferences(value) { if (!explicitQuery && value && resolve(value.language)) setLocale(value.language, { source: 'host' }); },
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}
