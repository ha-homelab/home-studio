// Carry presentation preferences between local pages even when storage is denied.
import { getLocale, onLocaleChange } from './i18n.js';

const base = new URL('../', import.meta.url);
const paths = new Set([
  'planner/', 'planner/index.html', 'planner/guide.html',
  'planner/publishing.html', 'install.html',
].map(path => new URL(path, base).pathname));

export function updateLanguageLinks(root = document) {
  for (const link of root.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#') || link.hasAttribute('download')) continue;
    const url = new URL(href, document.baseURI);
    if (url.origin !== base.origin || !paths.has(url.pathname)) continue;
    url.searchParams.set('lang', getLocale());
    link.setAttribute('href', `${url.pathname}${url.search}${url.hash}`);
  }
}

if (typeof document !== 'undefined') {
  onLocaleChange(() => updateLanguageLinks());
  updateLanguageLinks();
}
