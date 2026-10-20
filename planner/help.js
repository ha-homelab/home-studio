import { LOCALES, getDirection, getLocale, initI18n, onLocaleChange, setLocale, t } from './i18n.js';
import { HELP_MESSAGES } from './help-locales.js';
import { updateLanguageLinks } from './language-links.js';

const root = document.getElementById('quick-route');
const topic = root.dataset.topic;
const toolkit = new URL('../', import.meta.url);
const local = path => new URL(path, toolkit).href;
const commands = Object.freeze({
  build: 'python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package',
  preview: 'python3 -m http.server 8099 --bind 127.0.0.1 --directory dist/my-home',
  dryRun: 'python3 scripts/install-home-assistant.py dist/my-home/home-floorplan.tar.gz --config /path/to/ha/config --dry-run',
  install: 'python3 scripts/install-home-assistant.py dist/my-home/home-floorplan.tar.gz --config /path/to/ha/config',
  enable: 'home_floorplan: {}',
});
const literalPattern = /(home_floorplan: \{\}|\/path\/to\/ha\/config|configuration\.yaml|--dry-run)/g;

function element(tag, text, className) {
  const result = document.createElement(tag);
  if (text) result.textContent = text;
  if (className) result.className = className;
  return result;
}
function link(label, href, className = '') {
  const result = element('a', label, className);
  result.href = href;
  return result;
}
function paragraph(key) { return element('p', t(key)); }
function helpText(key) {
  const result = element('p');
  const text = HELP_MESSAGES[getLocale()]?.[key] ?? HELP_MESSAGES.en[key];
  // Isolate literal syntax in RTL prose. Translations never become markup.
  for (const piece of text.split(literalPattern)) {
    if (!piece) continue;
    if (/^(?:home_floorplan: \{\}|\/path\/to\/ha\/config|configuration\.yaml|--dry-run)$/.test(piece)) {
      const code = element('code', piece); code.dir = 'ltr'; result.append(code);
    } else result.append(document.createTextNode(piece));
  }
  return result;
}
function codeBlock(name) {
  const pre = element('pre'); pre.dir = 'ltr'; pre.lang = 'en';
  const code = element('code', commands[name]); code.dataset.command = name;
  pre.append(code); return pre;
}
function card(title, paragraphs, { image, id } = {}) {
  const item = element('li', '', 'quick-step');
  if (id) item.id = id;
  const body = element('div', '', 'quick-step-body');
  body.append(element('h3', t(title)));
  for (const key of paragraphs) body.append(paragraph(key));
  item.append(body);
  if (image) {
    const figure = element('figure');
    const img = element('img'); img.src = local(`planner/guide-assets/${image}`); img.alt = ''; img.width = 1280; img.height = 720; img.loading = 'lazy';
    const full = link(t(title), img.src); full.textContent = ''; full.setAttribute('aria-label', t(title));
    full.target = '_blank'; full.rel = 'noopener'; full.append(img); figure.append(full);
    item.append(figure);
  }
  return { item, body };
}
function renderDraw(steps) {
  for (const [title, text, image] of [
    ['Draw the rooms.', 'Drag a rectangle on the metric plan, or add a room by dimensions in Floor settings. Edit its polygon points for other shapes. Rooms define floor areas only.', '01-room.jpg'],
    ['Give them walls.', 'Select a room and choose Build wall outline, or draw individual wall segments. Exact shared walls are reused. Walls stay separate when rooms move.', '02-rooms.jpg'],
    ['Open up the space.', 'Choose Add door or Add window, then click a wall. Adjust width, distance from wall start, sill, and head in the inspector. These are actual holes in the 3D walls.', '04-window.jpg'],
    ['Make it your own.', 'Open the Item library, choose a design, and click inside a room to place it. Change its finish and color in Item details, inspect the 3D preview, and export JSON when ready. Entity IDs are optional; leave them blank for a drawing.', '05-item.jpg'],
    ['Save a portable draft.', 'Download project.json and keep it somewhere you can find again. This file contains your drawing and any entity IDs you entered. It is not an installed dashboard.', '07-export.jpg'],
  ]) steps.append(card(title, [text], { image }).item);
}
function renderInstall(steps) {
  steps.append(card('Save a portable draft.', [
    'Download project.json and keep it somewhere you can find again. This file contains your drawing and any entity IDs you entered. It is not an installed dashboard.',
  ], { image: '06-preview.jpg' }).item);
  const download = card('Get the complete toolkit.', ["Download and extract the public package. The local compiler and installer use Python's standard library; no extra packages are needed."]);
  download.body.append(link(t('Download the complete ZIP ↗'), 'https://github.com/ha-homelab/home-studio/releases/latest', 'text-link'));
  steps.append(download.item);
  const build = card('Build, preview, and install.', ['Open a terminal in the extracted toolkit folder. Replace the project path with the location of your exported file; quote paths containing spaces.']);
  build.body.append(codeBlock('build'), paragraph('This creates your viewer and installation archive. Follow the guide to preview and install it. Keep your editable JSON outside the generated output folder.'), element('h4', t('Preview')), codeBlock('preview'));
  const preview = link('http://127.0.0.1:8099/', 'http://127.0.0.1:8099/'); preview.dir = 'ltr'; preview.target = '_blank'; preview.rel = 'noopener';
  build.body.append(preview);
  steps.append(build.item);
  const install = card('Build & install', [], { id: 'quick-install' });
  const route = element('aside', '', 'quick-note');
  route.append(helpText('routes'), link(HELP_MESSAGES[getLocale()].reference, '#install'));
  install.body.append(route, helpText('dryRun'), codeBlock('dryRun'), helpText('install'), codeBlock('install'));
  steps.append(install.item);
  const enable = card('Home Assistant', [], { id: 'quick-enable' });
  enable.body.append(helpText('enable'), codeBlock('enable'), link(HELP_MESSAGES[getLocale()].reference, '#enable', 'text-link'));
  steps.append(enable.item);
}
function renderShare(steps) {
  steps.append(card('Save a portable draft.', [
    'Drafts stay in this browser. Export to keep a copy.',
    'Download project.json and keep it somewhere you can find again. This file contains your drawing and any entity IDs you entered. It is not an installed dashboard.',
  ], { image: '07-export.jpg' }).item);
  steps.append(card('Build, preview, and install.', ['The guide walks through the local build, your Home Assistant config folder, a dry run, backups, the YAML entry, and restart. It includes a file-copy route for Home Assistant OS.']).item);
}
function render({ loaded = true } = {}) {
  const focusLanguage = document.activeElement?.id === 'help-language';
  const locale = getLocale(), copy = HELP_MESSAGES[locale];
  document.documentElement.lang = locale; document.documentElement.dir = getDirection();
  root.lang = locale; root.dir = getDirection();
  root.replaceChildren();
  const bar = element('div', '', 'quick-toolbar');
  bar.append(element('p', copy.quick, 'eyebrow'));
  const control = element('label', '', 'help-language'); control.htmlFor = 'help-language';
  control.append(element('span', t('Language')));
  const select = element('select'); select.id = 'help-language'; select.setAttribute('aria-label', t('Language'));
  for (const entry of LOCALES) {
    const option = element('option', entry.name); option.value = entry.code; option.lang = entry.code; option.dir = entry.dir || 'ltr'; select.append(option);
  }
  select.value = locale;
  select.addEventListener('change', async () => {
    const result = await setLocale(select.value);
    if (result.applied) {
      // Keep a deep link in sync with an explicit user choice, including reloads.
      const url = new URL(location.href); url.searchParams.set('lang', result.locale);
      try { history.replaceState(null, '', url); } catch { /* Files or restricted hosts may deny history. */ }
    }
  });
  control.append(select); bar.append(control); root.append(bar);
  const title = element('h2', t(topic === 'draw' ? 'Draw your first home.' : topic === 'install' ? 'Export, build, and install your plan.' : 'Saving, sharing and next steps ↗'));
  title.id = 'quick-title'; root.append(title);
  root.append(helpText('scope'));
  if (!loaded) { const warning = paragraph('Language could not be loaded. English is shown instead.'); warning.role = 'status'; root.append(warning); }
  const navigation = element('nav', '', 'quick-links'); navigation.setAttribute('aria-label', copy.quick);
  navigation.append(
    link(t('Start designing'), local('planner/'), 'button button-small'),
    link(t('Drawing guide with screenshots'), local('planner/guide.html')),
    link(t('Build & install'), local('install.html')),
    link(copy.reference, '#english-reference'),
  );
  root.append(navigation);
  if (topic === 'draw') root.append(paragraph('This website works in your browser; no Python or installation is needed.'));
  if (topic === 'install') root.append(paragraph('The complete public toolkit includes the compiler and Home Assistant installer. Export your drawing here, then run the local tools on your computer with Python 3.10 or newer. This browser editor does not connect to or control Home Assistant.'));
  const steps = element('ol', '', 'quick-steps');
  if (topic === 'draw') renderDraw(steps);
  else if (topic === 'install') renderInstall(steps);
  else renderShare(steps);
  root.append(steps);
  const next = element('div', '', 'quick-next');
  next.append(link(t(topic === 'install' ? 'Start designing' : 'Build & install'), local(topic === 'install' ? 'planner/' : 'install.html'), 'button'));
  const reference = link(copy.reference, '#english-reference', 'text-link'); next.append(reference); root.append(next);
  document.querySelectorAll('[data-english-reference-label]').forEach(node => {
    node.textContent = copy.reference; node.lang = locale; node.dir = getDirection();
  });
  root.hidden = false;
  updateLanguageLinks();
  if (focusLanguage) select.focus();
}

onLocaleChange(render);
await initI18n();
