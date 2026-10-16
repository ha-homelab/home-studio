#!/usr/bin/env python3
"""Validate and stage the explicit public website, never an entire checkout."""
import argparse
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import shutil
from urllib.parse import unquote, urlsplit

LOCALE_CODES = (
    'en', 'ar', 'bn', 'cs', 'de', 'es', 'fa', 'fr', 'he', 'hi', 'id', 'it',
    'ja', 'ko', 'nl', 'pl', 'pt', 'ru', 'th', 'tr', 'uk', 'vi', 'zh-Hans', 'zh-Hant',
)
# These reviewed binary seeds encode only byte extrema, not arbitrary files.
BINARY_REPLAY_SEEDS = {
    'fuzz/corpus/wall-geometry/rectangle': bytes(range(14)),
    'fuzz/corpus/wall-geometry/limits': bytes([255]) * 14,
}
FUZZ_REPLAY_FILES = (
    'fuzz/project-validation.test.mjs', 'fuzz/wall-geometry.test.mjs',
    'fuzz/project-validation.mjs', 'fuzz/wall-geometry.mjs', 'fuzz/bounds-oracle.mjs',
    'fuzz/corpus/project-validation/empty.json',
    'fuzz/corpus/project-validation/example-home.json',
    'fuzz/corpus/project-validation/practice-home.json',
    'fuzz/corpus/project-validation/invalid-title.json',
    'fuzz/corpus/project-validation/prototype.json',
    'fuzz/corpus/project-validation/furniture-valid.json',
    'fuzz/corpus/project-validation/furniture-invalid-type.json',
    'fuzz/corpus/project-validation/furniture-invalid-color.json',
    'fuzz/corpus/project-validation/furniture-invalid-model.json',
    'fuzz/corpus/project-validation/furniture-invalid-style.json',
    'fuzz/corpus/project-validation/furniture-invalid-pattern.json',
    *BINARY_REPLAY_SEEDS,
)

SITE_FILES = (
    'index.html', 'site.css', 'privacy.html', 'install.html', '404.html', '.nojekyll',
    'planner/index.html', 'planner/editor.css', 'planner/editor.js', 'planner/render-capacity.js', 'planner/interaction-render.js',
    'planner/i18n.js', 'planner/validation.js', 'planner/locales/index.js',
    'planner/help.js', 'planner/help.css', 'planner/help-locales.js', 'planner/language-links.js',
    *(f'planner/locales/{code}.js' for code in LOCALE_CODES),
    'planner/model.js', 'planner/catalog.js', 'planner/furniture.js', 'planner/guide.html', 'planner/guide.css',
    'planner/publishing.html', 'planner/guide-assets/practice-home.json',
    'planner/guide-assets/01-room.jpg', 'planner/guide-assets/02-rooms.jpg',
    'planner/guide-assets/03-door.jpg', 'planner/guide-assets/04-window.jpg',
    'planner/guide-assets/05-item.jpg', 'planner/guide-assets/06-preview.jpg',
    'planner/guide-assets/07-export.jpg',
    'planner/guide-assets/08-library.jpg', 'planner/guide-assets/09-garage-studio.jpg',
    'planner/guide-assets/garage-and-studio.json',
    'planner/guide-assets/decor-studio.json', 'planner/guide-assets/10-decor-studio.jpg',
    'planner/guide-assets/pattern-studio.json', 'planner/guide-assets/11-pattern-studio.jpg',
    'vendor/three.module.min.js', 'vendor/THREE-LICENSE.txt',
)
REPO_FILES = ('docs/i18n.md', 'docs/translations/README.md',
              *(f'docs/translations/README.{code}.md' for code in LOCALE_CODES if code != 'en'),
              'scripts/test-i18n.mjs', 'scripts/test-i18n-browser.cjs', 'scripts/test-validation-i18n.mjs',
              'scripts/test-help-i18n.cjs', 'scripts/test-panel-language.cjs', 'scripts/test-viewer-i18n.cjs', 'scripts/test-lock-control.cjs',
              'viewer-i18n.js', 'viewer-locales/index.json',
              *(f'viewer-locales/{code}.json' for code in LOCALE_CODES),
              'README.md', 'LICENSE', '.gitignore', '.gitattributes', 'scripts/validate-site.py', '.github/workflows/pages.yml',
              '.github/workflows/package.yml', '.github/workflows/platform-acceptance.yml',
              'docs/architecture.md', 'docs/platform-acceptance.md',
              'scripts/build-planner-project.py', 'scripts/install-home-assistant.py',
              'scripts/package_release.py', 'scripts/test_package_release.py',
              'scripts/test_source_replay.py', *FUZZ_REPLAY_FILES,
              'scripts/test-light-state.cjs', 'scripts/test-tv-screen.cjs', 'scripts/test-media-preview.cjs',
              'scripts/test-install-home-assistant.py', 'scripts/test-public-package.py', 'scripts/test-wall-tops.cjs',
              'scripts/test-rounded-walls.cjs', 'scripts/test-wall-sheen.cjs', 'scripts/test-wall-motion.cjs', 'docs/rounded-walls.md',
              'scripts/test-browser-stability.cjs', 'scripts/browser-stability-diagnostics.cjs',
              'scripts/browser-startup-diagnostics.cjs', 'scripts/test-browser-startup-diagnostics.cjs',
              'scripts/test-browser-stability-diagnostics.cjs', 'scripts/test-home-render-budget.cjs',
              'scripts/test-packed-room-lighting.cjs', 'scripts/test-zero-point-block.cjs', 'scripts/test-glass-wall-program.cjs', 'scripts/test-fallback-shared-program.cjs',
              'scripts/waterfox-versions.json', 'scripts/setup-waterfox.py', 'scripts/test-waterfox-acceptance.py',
              'scripts/test-waterfox-tooling.py',
              'scripts/prepare-intel-macos-ci.py', 'scripts/test-intel-macos-ci.py',
              'scripts/firefox-versions.json', 'scripts/native_browser.py',
              'scripts/setup-native-browser.py', 'scripts/test-native-browser-acceptance.py',
              'scripts/diagnose-native-draw.py', 'scripts/native-draw-diagnostic.js',
              'scripts/test-native-draw-diagnostic.py', 'scripts/test-native-draw-diagnostic.cjs',
              'scripts/test-safari-acceptance.py', 'scripts/test-safari-tooling.py',
              'scripts/browser-matrix.json', 'scripts/browser-matrix.py',
              'scripts/setup-browser-toolchain.py', 'scripts/setup-chrome-for-testing.py',
              'scripts/install-browser-with-retry.py', 'scripts/test-browser-install.py',
              'scripts/test-browser-matrix.py',
              'scripts/test-render-capacity.cjs', 'scripts/test-interaction-render.cjs', 'scripts/test-render-lifecycle.cjs', 'docs/browser-compatibility.md',
              'scripts/test-planner-stability.cjs', 'scripts/test-planner-render-budget.cjs',
              'scripts/test-viewer-startup.cjs', 'scripts/test-module-expiry.cjs', 'scripts/test-floor-context.py', 'scripts/test-floor-context.cjs',
              'planner/project.py', 'planner/package.json', 'planner/catalog.json', 'planner/furniture.py',
              'scripts/generate-furniture-catalog.py', 'scripts/test-furniture.mjs', 'scripts/test-furniture.py',
              'scripts/test-inventory-appearance.cjs', 'scripts/test-inventory-appearance.py',
              'scripts/test-furniture-patterns.mjs', 'scripts/test-furniture-patterns.py',
              'scripts/test-furniture-editor.cjs', 'package.json', 'package-lock.json',
              'planner/example-home.json', 'geometry.py', 'exporters.py',
              'viewer.template.html', 'viewer.js', 'home-view.html', 'home-view.css',
              'curtain-state.js', 'motion-state.js', 'tv-screen.js', 'camera-preview.js', 'media-preview.js',
              'assumed-zone-view.js', 'home-view.js', 'light-state.js', 'room-lighting.js',
              'custom_components/home_floorplan/__init__.py',
              'custom_components/home_floorplan/site.py',
              'custom_components/home_floorplan/validation.py',
              'custom_components/home_floorplan/curtains.py',
              'custom_components/home_floorplan/manifest.json',
              'custom_components/home_floorplan/static/panel.js')
# Supplementary tripwires, not a substitute for reviewing source and image pixels.
PRIVATE = re.compile(r'\bunit\d{3}\b|/Users/|-----BEGIN .*PRIVATE KEY|'
                     r'\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})\b', re.I)


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links, self.ids = [], set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if 'id' in attrs:
            if attrs['id'] in self.ids:
                raise ValueError(f"Duplicate HTML id: {attrs['id']}")
            self.ids.add(attrs['id'])
        for key in ('src', 'href'):
            if attrs.get(key):
                self.links.append((tag, key, attrs[key]))


def regular_file(root, relative):
    path = root / relative
    if not path.is_file() or any(part.is_symlink() for part in [path, *path.parents] if part != root.parent):
        raise ValueError(f'Missing file or symlink: {relative}')
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError(f'File escapes the public directory: {relative}')
    return path


def validate(root):
    root = root.resolve()
    documents = {}
    for relative in (*SITE_FILES, *REPO_FILES):
        path = regular_file(root, relative)
        if relative in BINARY_REPLAY_SEEDS:
            if path.read_bytes() != BINARY_REPLAY_SEEDS[relative]:
                raise ValueError(f'Unexpected binary replay seed: {relative}')
            continue
        if path.suffix == '.jpg':
            continue
        text = path.read_text(encoding='utf-8')
        # The validator intentionally contains its own private-pattern tripwires.
        if relative != 'scripts/validate-site.py' and PRIVATE.search(text):
            raise ValueError(f'Private-data tripwire in {relative}')
        if path.suffix == '.html' and relative in SITE_FILES:
            parser = Links()
            parser.feed(text)
            documents[relative] = parser
    for relative, parser in documents.items():
        for tag, key, link in parser.links:
            parsed = urlsplit(link)
            if parsed.scheme or parsed.netloc:
                if tag != 'a' or parsed.scheme not in ('https', 'http'):
                    raise ValueError(f'External executable/resource or unsafe URL in {relative}: {link}')
                continue
            if parsed.path.startswith('/'):
                raise ValueError(f'Root-relative link would break project Pages: {relative}: {link}')
            target = (root / relative).parent / unquote(parsed.path) if parsed.path else root / relative
            if not target.resolve().is_relative_to(root):
                raise ValueError(f'Link escapes public site: {relative}: {link}')
            if target.is_dir():
                target /= 'index.html'
            name = target.resolve().relative_to(root).as_posix()
            if name not in SITE_FILES:
                raise ValueError(f'Link to unpublished file: {relative}: {link}')
            if parsed.fragment and name in documents and unquote(parsed.fragment) not in documents[name].ids:
                raise ValueError(f'Missing anchor: {relative}: {link}')
    for relative in (name for name in SITE_FILES if name.startswith('planner/') and name.endswith('.js')):
        code = (root / relative).read_text(encoding="utf-8")
        for imported in re.findall(r'from\s+[\'"]([^\'"]+)[\'"]', code):
            target = ((root / relative).parent / imported).resolve()
            if not target.is_relative_to(root) or target.relative_to(root).as_posix() not in SITE_FILES:
                raise ValueError(f'Unpublished import: {relative}: {imported}')
        if re.search(r'\b(?:fetch|WebSocket|XMLHttpRequest|sendBeacon)\s*\(', code):
            raise ValueError(f'New network API needs public-data review: {relative}')
    for relative in SITE_FILES:
        if relative.startswith('planner/guide-assets/') and relative.endswith('.json'):
            practice = json.loads((root / relative).read_text(encoding="utf-8"))
            for floor in practice['floors']:
                if any(item.get('entity_id') for item in floor['items']):
                    raise ValueError(f'The public practice project must have empty device bindings: {relative}')
    return len(SITE_FILES)


def stage(root, output):
    validate(root)
    if output.exists():
        raise ValueError('Output already exists; choose a new empty destination')
    output.mkdir(parents=True)
    for relative in SITE_FILES:
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / relative, target)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--output', type=Path)
    args = ap.parse_args()
    root = Path(__file__).resolve().parents[1]
    count = validate(root)
    if args.output:
        stage(root, args.output.resolve())
    print(f'Validated {count} public website files, local links and browser imports.')
