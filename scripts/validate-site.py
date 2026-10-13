#!/usr/bin/env python3
"""Validate and stage the explicit public website, never an entire checkout."""
import argparse
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import shutil
from urllib.parse import unquote, urlsplit

SITE_FILES = (
    'index.html', 'site.css', 'privacy.html', 'install.html', '404.html', '.nojekyll',
    'planner/index.html', 'planner/editor.css', 'planner/editor.js',
    'planner/model.js', 'planner/guide.html', 'planner/guide.css',
    'planner/publishing.html', 'planner/guide-assets/practice-home.json',
    'planner/guide-assets/01-room.jpg', 'planner/guide-assets/02-rooms.jpg',
    'planner/guide-assets/03-door.jpg', 'planner/guide-assets/04-window.jpg',
    'planner/guide-assets/05-item.jpg', 'planner/guide-assets/06-preview.jpg',
    'planner/guide-assets/07-export.jpg',
    'vendor/three.module.min.js', 'vendor/THREE-LICENSE.txt',
)
REPO_FILES = ('README.md', 'LICENSE', '.gitignore', 'scripts/validate-site.py', '.github/workflows/pages.yml',
              '.github/workflows/package.yml', 'docs/architecture.md',
              'scripts/build-planner-project.py', 'scripts/install-home-assistant.py',
              'scripts/test-install-home-assistant.py', 'scripts/test-public-package.py', 'scripts/test-wall-tops.cjs',
              'scripts/test-viewer-startup.cjs', 'scripts/test-module-expiry.cjs', 'scripts/test-floor-context.py', 'scripts/test-floor-context.cjs',
              'planner/project.py', 'planner/example-home.json', 'geometry.py', 'exporters.py',
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
    for relative in ('planner/editor.js', 'planner/model.js'):
        code = (root / relative).read_text()
        for imported in re.findall(r'from\s+[\'"]([^\'"]+)[\'"]', code):
            target = ((root / relative).parent / imported).resolve()
            if not target.is_relative_to(root) or target.relative_to(root).as_posix() not in SITE_FILES:
                raise ValueError(f'Unpublished import: {relative}: {imported}')
        if re.search(r'\b(?:fetch|WebSocket|XMLHttpRequest|sendBeacon)\s*\(', code):
            raise ValueError(f'New network API needs public-data review: {relative}')
    practice = json.loads((root / 'planner/guide-assets/practice-home.json').read_text())
    for floor in practice['floors']:
        if any(item.get('entity_id') for item in floor['items']):
            raise ValueError('The public practice project must have empty device bindings')
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
