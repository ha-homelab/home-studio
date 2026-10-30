// Progressive enhancements for public documentation. The editor is a separate app.
const SITE_BASE = new URL('./', import.meta.url);
const ROUTES = new Set(['', 'index.html', 'install.html', 'ai-setup.html', 'privacy.html', 'planner/guide.html', 'planner/publishing.html']);
const STYLES = ['planner/guide.css', 'planner/help.css', 'site.css'];
const SCRIPTS = ['site-experience.js', 'planner/help.js'];
export const REPOSITORY = 'ha-homelab/home-studio';
export const METADATA_TTL = 20 * 60 * 1000;
export const METADATA_KEY = 'home-studio.public-repository.v1';
const HISTORY_KEY = 'homeStudioDocument';
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT = 8000;

// Exact paths, including the project-site prefix: never intercept editor routes,
// another project on the same origin, external links, or URL credentials.
export function documentRoute(value, base = SITE_BASE) {
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== base.origin || url.username || url.password || !url.pathname.startsWith(base.pathname)) return null;
    return ROUTES.has(url.pathname.slice(base.pathname.length)) ? url : null;
  } catch { return null; }
}

export function shouldHandleLink(event, link, base = SITE_BASE) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !link || link.hasAttribute('download') || link.hasAttribute('data-native-navigation')) return false;
  const target = link.getAttribute('target');
  return (!target || target.toLowerCase() === '_self') && Boolean(documentRoute(link.href, base));
}

export function repositorySnapshot(data, checkedAt = Date.now()) {
  if (!data || data.full_name !== REPOSITORY || data.private !== false || data.html_url !== `https://github.com/${REPOSITORY}` || !Number.isFinite(checkedAt)) return null;
  if (![data.stargazers_count, data.forks_count].every(value => Number.isSafeInteger(value) && value >= 0)) return null;
  const pushedAt = typeof data.pushed_at === 'string' && Number.isFinite(Date.parse(data.pushed_at)) ? data.pushed_at : null;
  return { checkedAt, stars: data.stargazers_count, forks: data.forks_count, pushedAt };
}

export function cachedSnapshot(value, now = Date.now()) {
  try {
    const row = typeof value === 'string' ? JSON.parse(value) : value;
    if (!row || row.version !== 1 || !Number.isFinite(row.checkedAt) || row.checkedAt < 0 || row.checkedAt > now || now - row.checkedAt > 7 * 24 * 60 * 60 * 1000) return null;
    const result = repositorySnapshot(row.data, row.checkedAt);
    return result ? { ...result, fresh: now - result.checkedAt < METADATA_TTL } : null;
  } catch { return null; }
}

function cacheRecord(snapshot) {
  return { version: 1, checkedAt: snapshot.checkedAt, data: {
    full_name: REPOSITORY, private: false, html_url: `https://github.com/${REPOSITORY}`,
    stargazers_count: snapshot.stars, forks_count: snapshot.forks, pushed_at: snapshot.pushedAt,
  } };
}

let memorySnapshot = null;
function mountMetadata(signal) {
  const region = document.querySelector('[data-github-metadata]');
  if (!region) return () => {};
  const status = region.querySelector('[data-github-status]');
  const refresh = region.querySelector('[data-github-load]');
  const write = (selector, value) => { const node = region.querySelector(selector); if (node) node.textContent = value; };
  let snapshot = cachedSnapshot(memorySnapshot);
  if (!snapshot) { try { snapshot = cachedSnapshot(sessionStorage.getItem(METADATA_KEY)); } catch { /* Storage is optional. */ } }
  let request = null, observer = null, visible = false, started = false;
  function render(row, prefix) {
    write('[data-github-stars]', row.stars.toLocaleString());
    write('[data-github-forks]', row.forks.toLocaleString());
    write('[data-github-updated]', row.pushedAt ? new Date(row.pushedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Not reported');
    if (status) status.textContent = `${prefix} ${new Date(row.checkedAt).toLocaleString()}. Public GitHub repository data.`;
  }
  async function load(force = false) {
    if (signal.aborted || request) return;
    if (!force && snapshot && Date.now() - snapshot.checkedAt < METADATA_TTL) { render(snapshot, 'Cached; checked'); return; }
    request = new AbortController();
    const current = request;
    const abort = () => current.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, REQUEST_TIMEOUT);
    if (refresh) refresh.disabled = true;
    region.setAttribute('aria-busy', 'true');
    if (status) status.textContent = snapshot ? 'Refreshing public GitHub data; previous values remain visible.' : 'Loading public GitHub repository data…';
    try {
      const response = await fetch(`https://api.github.com/repos/${REPOSITORY}`, {
        credentials: 'omit', referrerPolicy: 'no-referrer', signal: current.signal,
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? 'GitHub temporarily limited requests' : 'GitHub is unavailable');
      const result = repositorySnapshot(await response.json());
      if (!result) throw new Error('GitHub returned unexpected repository data');
      if (signal.aborted) return;
      snapshot = result;
      memorySnapshot = cacheRecord(result);
      try { sessionStorage.setItem(METADATA_KEY, JSON.stringify(memorySnapshot)); } catch { /* The in-memory cache still works. */ }
      render(snapshot, 'Checked');
    } catch (error) {
      if (signal.aborted) return;
      if (snapshot) render(snapshot, 'Saved data; last checked');
      if (status) status.textContent = `${snapshot ? status.textContent + ' ' : ''}${current.signal.aborted ? 'Request timed out' : error.message}. Use Refresh or open the repository on GitHub.`;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      request = null;
      if (!signal.aborted) { if (refresh) refresh.disabled = false; region.removeAttribute('aria-busy'); }
    }
  }
  if (snapshot) render(snapshot, snapshot.fresh ? 'Cached; checked' : 'Saved data; last checked');
  refresh?.addEventListener('click', () => { started = true; void load(true); }, { signal });
  if (refresh) refresh.hidden = false;
  const maybeLoad = () => {
    if (visible && !document.hidden && !started) { started = true; observer?.disconnect(); void load(); }
  };
  document.addEventListener('visibilitychange', maybeLoad, { signal });
  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); maybeLoad(); }, { threshold: 0.05 });
    observer.observe(region);
  } else { visible = true; maybeLoad(); }
  return () => { observer?.disconnect(); request?.abort(); };
}

function mountMotion(signal) {
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const fine = matchMedia('(hover: hover) and (pointer: fine)');
  const reveals = [...document.querySelectorAll('[data-reveal]')];
  const scenes = [...document.querySelectorAll('[data-scene]')];
  const tiles = [...document.querySelectorAll('[data-tilt]')];
  let revealObserver = null, sceneObserver = null;
  const frames = new Map();
  const reset = tile => {
    cancelAnimationFrame(frames.get(tile)); frames.delete(tile);
    tile.style.removeProperty('--tilt-x'); tile.style.removeProperty('--tilt-y');
  };
  function configure() {
    revealObserver?.disconnect(); sceneObserver?.disconnect();
    scenes.forEach(node => node.classList.remove('is-in-view'));
    tiles.forEach(reset);
    if (reduced.matches || !('IntersectionObserver' in window)) {
      root.classList.remove('motion-ready');
      reveals.forEach(node => node.classList.add('is-visible'));
      scenes.forEach(node => node.classList.remove('is-in-view'));
      return;
    }
    revealObserver = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('is-visible'); revealObserver.unobserve(entry.target); }
    }, { threshold: 0.08 });
    reveals.forEach(node => { if (!node.classList.contains('is-visible')) revealObserver.observe(node); });
    sceneObserver = new IntersectionObserver(entries => {
      for (const entry of entries) entry.target.classList.toggle('is-in-view', entry.isIntersecting && !document.hidden);
    }, { threshold: 0.01 });
    scenes.forEach(node => sceneObserver.observe(node));
    root.classList.add('motion-ready');
  }
  for (const tile of tiles) {
    tile.addEventListener('pointermove', event => {
      if (reduced.matches || !fine.matches || document.hidden || event.pointerType === 'touch') return;
      const rect = tile.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width - 0.5) * 2));
      const y = Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height - 0.5) * 2));
      cancelAnimationFrame(frames.get(tile));
      frames.set(tile, requestAnimationFrame(() => {
        frames.delete(tile);
        tile.style.setProperty('--tilt-x', `${(-y * 4).toFixed(2)}deg`);
        tile.style.setProperty('--tilt-y', `${(x * 4).toFixed(2)}deg`);
      }));
    }, { signal, passive: true });
    tile.addEventListener('pointerleave', () => reset(tile), { signal });
    tile.addEventListener('pointercancel', () => reset(tile), { signal });
  }
  reduced.addEventListener('change', configure, { signal });
  fine.addEventListener('change', configure, { signal });
  document.addEventListener('visibilitychange', configure, { signal });
  configure();
  const header = document.querySelector('.site-header');
  const measure = () => { if (header) root.style.setProperty('--site-header-height', `${Math.ceil(header.getBoundingClientRect().height)}px`); };
  const resize = 'ResizeObserver' in window ? new ResizeObserver(measure) : null;
  if (header) resize?.observe(header);
  window.addEventListener('resize', measure, { signal, passive: true });
  measure();
  return () => { revealObserver?.disconnect(); sceneObserver?.disconnect(); resize?.disconnect(); tiles.forEach(reset); root.classList.remove('motion-ready'); };
}

let helpModule = null;
const stylesheetLoads = new Map();
async function prepareHelp() {
  helpModule ??= await import('./planner/help.js');
  return helpModule;
}

function untilAborted(work, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Navigation canceled', 'AbortError'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function pageDocument(source, target) {
  if (source.length > MAX_DOCUMENT_BYTES) throw new Error('Document exceeds the navigation limit');
  const page = new DOMParser().parseFromString(source, 'text/html');
  if (!page.querySelector('main') || !page.title || !page.querySelector('.site-header')) throw new Error('Not a site document');
  const scripts = new Set(SCRIPTS.map(path => new URL(path, SITE_BASE).href));
  for (const script of page.querySelectorAll('script')) {
    if (script.type !== 'module' || script.textContent.trim() || !scripts.has(new URL(script.getAttribute('src'), target).href)) throw new Error('Document requires a full load');
  }
  const styles = new Set(STYLES.map(path => new URL(path, SITE_BASE).href));
  for (const style of page.querySelectorAll('link[rel="stylesheet"]')) {
    if (!styles.has(new URL(style.getAttribute('href'), target).href)) throw new Error('Document requires a different stylesheet');
  }
  // Fetched documents never execute scripts or install event handlers. Shared
  // behavior is mounted explicitly from the already trusted module graph.
  page.body.querySelectorAll('script, style, link, meta, base, iframe, object, embed').forEach(node => node.remove());
  for (const node of page.body.querySelectorAll('*')) {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || ['srcdoc', 'ping', 'autofocus', 'srcset'].includes(name)) { node.removeAttribute(attribute.name); continue; }
      if (!['href', 'src', 'poster', 'action', 'xlink:href'].includes(name)) continue;
      if (attribute.value.startsWith('#') && node.namespaceURI === 'http://www.w3.org/2000/svg') continue;
      try {
        const url = new URL(attribute.value, target);
        const allowed = name === 'href' ? ['http:', 'https:', 'mailto:', 'tel:'] : ['http:', 'https:'];
        if (allowed.includes(url.protocol)) node.setAttribute(attribute.name, url.href);
        else node.removeAttribute(attribute.name);
      } catch { node.removeAttribute(attribute.name); }
    }
  }
  return page;
}

async function prepareStyles(page, target) {
  const required = new Set([...page.querySelectorAll('link[rel="stylesheet"]')].map(link => new URL(link.getAttribute('href'), target).href));
  for (const path of STYLES) {
    const href = new URL(path, SITE_BASE).href;
    let link = [...document.querySelectorAll('link[rel="stylesheet"]')].find(node => node.href === href);
    if (!link && required.has(href)) {
      link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href;
      const loaded = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { link.remove(); reject(new Error('Stylesheet timed out')); }, REQUEST_TIMEOUT);
        link.onload = () => { clearTimeout(timer); resolve(); };
        link.onerror = () => { clearTimeout(timer); link.remove(); reject(new Error('Stylesheet unavailable')); };
      });
      stylesheetLoads.set(href, loaded);
      document.head.append(link);
      try { await loaded; } finally { stylesheetLoads.delete(href); }
    } else if (stylesheetLoads.has(href)) {
      await stylesheetLoads.get(href);
    }
  }
  // Preserve the same cascade for every entry page and navigation direction.
  for (const path of STYLES) {
    const href = new URL(path, SITE_BASE).href;
    const link = [...document.querySelectorAll('link[rel="stylesheet"]')].find(node => node.href === href);
    if (link) document.head.append(link);
  }
}

function updateHead(page) {
  document.title = page.title;
  for (const name of ['description', 'color-scheme']) {
    const next = page.querySelector(`meta[name="${name}"]`);
    let current = document.querySelector(`meta[name="${name}"]`);
    if (!next) { current?.remove(); continue; }
    if (!current) { current = document.createElement('meta'); current.name = name; document.head.append(current); }
    current.content = next.content;
  }
  // Preserve the initial CSP, referrer policy, module graph, and viewport.
}

function focusDestination(url, position) {
  let destination;
  try { destination = url.hash ? document.getElementById(decodeURIComponent(url.hash.slice(1))) : null; } catch { /* A malformed anchor means the page top. */ }
  const focus = destination || document.querySelector('main h1') || document.querySelector('main');
  if (focus) {
    const old = focus.getAttribute('tabindex');
    if (old === null) focus.setAttribute('tabindex', '-1');
    focus.focus({ preventScroll: true });
    if (old === null) focus.addEventListener('blur', () => focus.removeAttribute('tabindex'), { once: true });
  }
  if (Array.isArray(position) && position.length === 2 && position.every(Number.isFinite)) window.scrollTo({ left: position[0], top: position[1], behavior: 'instant' });
  else if (destination) destination.scrollIntoView({ behavior: 'instant', block: 'start' });
  else window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
}

function startSite() {
  if (!documentRoute(location.href) || !document.querySelector('.site-header')) return;
  const initialURL = location.href;
  const initialEntry = history.state?.[HISTORY_KEY];
  const navigationType = performance.getEntriesByType?.('navigation')[0]?.type;
  const restoring = ['reload', 'back_forward'].includes(navigationType);
  const initialPosition = restoring && initialEntry?.url === initialURL && Array.isArray(initialEntry.position) && initialEntry.position.length === 2 && initialEntry.position.every(value => Number.isFinite(value) && value >= 0) ? initialEntry.position : null;
  const initialHashNeedsLayout = Boolean(location.hash) && !initialEntry?.position && !restoring;
  let initialUserInteraction = false;
  const initialInput = new AbortController();
  const touched = () => { initialUserInteraction = true; };
  for (const name of ['pointerdown', 'wheel', 'touchstart', 'keydown']) window.addEventListener(name, touched, { signal: initialInput.signal, passive: true });
  let pageController = null, cleanups = [], documentURL = location.href;
  let navigation = null, revision = 0, saveTimer = null;
  const state = position => ({ ...(history.state && typeof history.state === 'object' ? history.state : {}), [HISTORY_KEY]: { url: location.href, position } });
  const savePosition = () => {
    clearTimeout(saveTimer);
    if (location.href !== documentURL) return;
    try { history.replaceState(state([window.scrollX, window.scrollY]), '', location.href); } catch { /* Normal navigation remains available. */ }
  };
  const dispose = () => { pageController?.abort(); cleanups.forEach(cleanup => cleanup()); cleanups = []; helpModule?.disposeHelp(); };
  const mount = async () => {
    pageController = new AbortController();
    const signal = pageController.signal;
    cleanups = [mountMotion(signal), mountMetadata(signal)];
    if (document.getElementById('quick-route')) {
      const help = await prepareHelp();
      if (!signal.aborted) await help.mountHelp();
    }
  };
  function announce(message) {
    let live = document.getElementById('site-navigation-status');
    if (!live) {
      live = document.createElement('div'); live.id = 'site-navigation-status'; live.className = 'site-announcer';
      live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); live.setAttribute('aria-atomic', 'true');
      document.body.append(live);
    }
    live.textContent = message;
  }
  async function navigate(target, { pop = false, position } = {}) {
    const attempt = ++revision;
    navigation?.abort(); navigation = new AbortController();
    const controller = navigation;
    clearTimeout(saveTimer);
    if (!pop) savePosition();
    document.documentElement.setAttribute('data-site-loading', '');
    announce('Loading page…');
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const response = await fetch(target.href, { signal: controller.signal, credentials: 'same-origin', headers: { Accept: 'text/html' } });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/html') || (response.url && !documentRoute(response.url)) || Number(response.headers.get('content-length')) > MAX_DOCUMENT_BYTES) throw new Error('Document unavailable');
      const source = await response.text();
      const page = pageDocument(source, target);
      await untilAborted(Promise.all([prepareStyles(page, target), page.getElementById('quick-route') ? prepareHelp() : Promise.resolve()]), controller.signal);
      if (attempt !== revision) return;
      if (controller.signal.aborted) throw new Error('Navigation timed out');
      if (!pop) history.pushState({ [HISTORY_KEY]: { url: target.href, position: null } }, '', target.href);
      dispose();
      document.body.className = page.body.className;
      document.body.replaceChildren(...[...page.body.childNodes].map(node => document.importNode(node, true)));
      document.documentElement.lang = page.documentElement.lang || 'en';
      document.documentElement.dir = page.documentElement.dir || 'ltr';
      updateHead(page);
      documentURL = location.href;
      await untilAborted(mount(), controller.signal);
      if (attempt !== revision) return;
      documentURL = location.href;
      focusDestination(target, position);
      savePosition();
      announce(`${document.title} loaded.`);
      document.dispatchEvent(new CustomEvent('site:navigated', { detail: { url: location.href } }));
    } catch {
      if (attempt === revision) location.assign(target.href);
    } finally {
      clearTimeout(timeout);
      if (attempt === revision) { navigation = null; document.documentElement.removeAttribute('data-site-loading'); }
    }
  }
  document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!shouldHandleLink(event, link)) {
      // A regular same-tab link supersedes an in-flight enhanced navigation
      // immediately, even when its destination takes a long time to respond.
      const sameTab = !link?.target || link.target.toLowerCase() === '_self';
      if (link && sameTab && !link.hasAttribute('download') && !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && /^https?:$/.test(link.protocol)) {
        ++revision; navigation?.abort(); navigation = null;
        document.documentElement.removeAttribute('data-site-loading');
      }
      return;
    }
    const target = documentRoute(link.href), current = new URL(documentURL);
    event.preventDefault();
    if (target.pathname === current.pathname && target.search === current.search) {
      ++revision; navigation?.abort(); navigation = null;
      document.documentElement.removeAttribute('data-site-loading');
      savePosition();
      try {
        if (target.href !== location.href) history.pushState({ [HISTORY_KEY]: { url: target.href, position: null } }, '', target.href);
        documentURL = location.href;
        focusDestination(target);
        savePosition();
      } catch { location.assign(target.href); }
    } else void navigate(target);
  });
  window.addEventListener('popstate', event => {
    const target = documentRoute(location.href);
    if (!target) { location.reload(); return; }
    const current = new URL(documentURL);
    const entry = event.state?.[HISTORY_KEY];
    const position = entry?.url === target.href ? entry.position : undefined;
    if (target.pathname === current.pathname && target.search === current.search) {
      ++revision; navigation?.abort(); navigation = null; clearTimeout(saveTimer);
      document.documentElement.removeAttribute('data-site-loading');
      documentURL = location.href; focusDestination(target, position); savePosition();
    } else void navigate(target, { pop: true, position });
  });
  window.addEventListener('scroll', () => { clearTimeout(saveTimer); saveTimer = setTimeout(savePosition, 120); }, { passive: true });
  window.addEventListener('pagehide', () => { savePosition(); ++revision; navigation?.abort(); navigation = null; document.documentElement.removeAttribute('data-site-loading'); dispose(); });
  window.addEventListener('pageshow', event => { if (event.persisted) void mount(); });
  document.addEventListener('site:language-changed', () => { documentURL = location.href; savePosition(); });
  try { history.scrollRestoration = 'manual'; savePosition(); } catch { /* Restricted origins retain normal links. */ }
  void mount().then(() => {
    // A fresh fragment can target the initially hidden translated guide. Wait
    // for its content, without stealing a visitor's scroll or restored history.
    if (!initialUserInteraction && revision === 0 && location.href === initialURL && (initialPosition || initialHashNeedsLayout)) {
      if (initialPosition) window.scrollTo({ left: initialPosition[0], top: initialPosition[1], behavior: 'instant' });
      else focusDestination(new URL(initialURL));
      savePosition();
    }
  }).catch(() => { dispose(); document.documentElement.classList.remove('motion-ready'); }).finally(() => initialInput.abort());
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') startSite();
