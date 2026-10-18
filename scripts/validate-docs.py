#!/usr/bin/env python3
"""Check the shipped operating guides, localized quick starts and source diagrams."""
import argparse
import importlib.util
import json
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
GUIDES = ('README.md', 'CHANGELOG.md', 'docs/dry-run.md', 'docs/i18n.md', 'docs/architecture.md',
          'docs/first-session.md', 'docs/dashboard-and-media.md', 'docs/process-and-results.md', 'docs/quality-and-release.md', 'docs/quality.md',
          'docs/fuzzing.md', 'docs/browser-compatibility.md', 'docs/release-workflow.md',
          'docs/VERSIONING.md', 'docs/translations/README.md')
WIKI = ('Home', '_Sidebar', 'Getting-started', 'Dry-run', 'Troubleshooting',
        'Languages', 'Development')
DIAGRAMS = ('docs/images/dry-run-command-flow.svg', 'docs/images/plan-state-lifecycle.svg',
            'docs/images/dry-run-delivery-process.svg', 'docs/images/dry-run-validation.svg',
            'docs/assets/quality/browser-coverage.svg', 'docs/assets/quality/fuzz-results.svg',
            'docs/assets/quality/release-pipeline.svg', 'docs/assets/quality/webgl-recovery.svg')
LINK = re.compile(r'!?\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[\"\'][^\n)]*)?\s*\)')
REFERENCE = re.compile(r'^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)', re.M)


def regular(root, name):
    """Reject escapes, symlinks and case typos, including on macOS/Windows."""
    path = root / name
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError(f'Documentation path escapes root: {name}')
    current = root
    for part in path.relative_to(root).parts:
        if part == '..':
            current = current.parent
            continue
        if part not in {entry.name for entry in current.iterdir()}:
            raise ValueError(f'Missing or incorrectly cased documentation target: {name}')
        current /= part
        if current.is_symlink():
            raise ValueError(f'Symlink in documentation: {name}')
    if not current.is_file():
        raise ValueError(f'Expected documentation file: {name}')
    return current


def anchors(source):
    found, counts = set(), {}
    for heading in re.findall(r'^#{1,6}\s+(.+?)\s*#*$', source, re.M):
        heading = re.sub(r'<[^>]*>', '', heading).strip().lower()
        slug = re.sub(r'[^\w\- ]', '', heading).replace(' ', '-')
        count = counts.get(slug, 0)
        counts[slug] = count + 1
        found.add(slug + (f'-{count}' if count else ''))
    found.update(re.findall(r'\bid=[\"\']([^\"\']+)[\"\']', source))
    return found


def validate_svg(path):
    source = path.read_text(encoding='utf-8')
    if '<!DOCTYPE' in source.upper() or '<!ENTITY' in source.upper():
        raise ValueError(f'External entities are not allowed: {path.name}')
    tree = ET.fromstring(source)
    if tree.tag != '{http://www.w3.org/2000/svg}svg' or not tree.get('viewBox'):
        raise ValueError(f'SVG requires a namespace and viewBox: {path.name}')
    text = lambda tag: ''.join(tree.findtext('{http://www.w3.org/2000/svg}' + tag, '')).strip()
    if not text('title') or not text('desc'):
        raise ValueError(f'SVG needs accessible title and description: {path.name}')
    for node in tree.iter():
        kind = node.tag.rsplit('}', 1)[-1]
        if kind in ('script', 'foreignObject', 'image', 'iframe', 'audio', 'video'):
            raise ValueError(f'SVG must remain a standalone vector diagram: {path.name}: {kind}')
        for name, value in node.attrib.items():
            local = name.rsplit('}', 1)[-1].lower()
            if local.startswith('on') or local in ('href', 'src') and not value.startswith('#'):
                raise ValueError(f'Active or external SVG content: {path.name}')
        css = ' '.join(node.attrib.values()) + (node.text or '')
        # Diagrams use plain CSS only. Reject imports and escapes rather than
        # attempting to interpret CSS obfuscation as a browser would.
        if re.search(r'@import', css, re.I) or '\\' in css:
            raise ValueError(f'External or escaped SVG styles are not supported: {path.name}')
        for value in re.findall(r'url\(([^)]+)\)', css, re.I):
            if not value.strip(' \"\'').startswith('#'):
                raise ValueError(f'External SVG style resource: {path.name}')


def validate(root=ROOT):
    root = root.resolve()
    spec = importlib.util.spec_from_file_location('public_site', root / 'scripts/validate-site.py')
    public_site = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(public_site)
    shipped = set(public_site.SITE_FILES + public_site.REPO_FILES)
    locales = json.loads(regular(root, 'viewer-locales/index.json').read_text(encoding='utf-8'))
    codes = [locale['code'] for locale in locales]
    if len(codes) != len(set(codes)) or 'en' not in codes:
        raise ValueError('Invalid locale manifest')
    documents = (*GUIDES, *(f'docs/wiki/{name}.md' for name in WIKI),
                 *(f'docs/translations/README.{code}.md' for code in codes if code != 'en'))
    for name in (*documents, *DIAGRAMS):
        if name not in shipped:
            raise ValueError(f'Documentation omitted from the source ZIP: {name}')
        path = regular(root, name)
        if path.suffix == '.svg':
            validate_svg(path)
            continue
        source = path.read_text(encoding='utf-8')
        if not re.search(r'^#\s+\S', source, re.M):
            raise ValueError(f'Missing document title: {name}')
        # Literal command/code examples are not documentation navigation.
        prose = re.sub(r'^```.*?^```\s*$', '', source, flags=re.M | re.S)
        for raw in (*LINK.findall(prose), *REFERENCE.findall(prose)):
            target = urlsplit(raw.strip('<>'))
            if target.scheme in ('https', 'http', 'mailto') or target.netloc:
                continue
            if target.scheme or target.path.startswith('/'):
                raise ValueError(f'Nonportable documentation link in {name}: {raw}')
            destination = (path.parent / unquote(target.path)).resolve() if target.path else path
            if not destination.is_relative_to(root):
                raise ValueError(f'Link escapes public documentation: {name}: {raw}')
            relative = destination.relative_to(root).as_posix()
            linked = regular(root, relative)
            if relative not in shipped:
                raise ValueError(f'Linked file omitted from the source ZIP: {name}: {raw}')
            if target.fragment and linked.suffix == '.md':
                if unquote(target.fragment) not in anchors(linked.read_text(encoding='utf-8')):
                    raise ValueError(f'Missing Markdown anchor: {name}: {raw}')
    return {'languages': len(codes), 'guides': len(documents), 'diagrams': len(DIAGRAMS)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    print(json.dumps(validate(args.root), sort_keys=True))
