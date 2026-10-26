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

WEBSITE_MEDIA_FILES = (
    'docs/media/native-ha-workflow.mp4',
    'docs/media/native-ha-workflow-poster.jpg',
    'docs/media/native-ha-workflow-preview.gif',
    'docs/media/native-ha-workflow.en.vtt',
    'docs/media/blender-workflow.gif',
    'docs/media/blender-export-dialog.jpg',
    'docs/media/blender-import.jpg',
    'docs/media/site-editor.jpg',
    'docs/media/site-preview.jpg',
)
SITE_FILES = (
    'camera-tour.js', 'camera-tour-panel.js', 'camera-tour-recording.js', 'camera-tour-session.js', 'camera-tour.css', 'planner/camera-tour-adapter.js',
    'pbr-color-data.js','pbr-materials.js','material-textures.js','environment-lighting.js',
    'index.html', 'site.css', 'docs/images/native-editor.png', 'privacy.html', 'install.html', 'ai-setup.html', '404.html', '.nojekyll',
    *WEBSITE_MEDIA_FILES,
    'planner/index.html', 'planner/editor.css', 'planner/editor.js', 'planner/floor-navigator.js', 'planner/floor-navigator.css', 'planner/render-capacity.js', 'planner/interaction-render.js', 'planner/environment.js',
    'planner/i18n.js', 'planner/validation.js', 'planner/locales/index.js',
    'planner/ha-bridge.js', 'planner/draft-storage.js', 'planner/inspector-dom.js', 'planner/onboarding.js', 'planner/device-onboarding.js', 'planner/room-transform.js', 'planner/device-onboarding-ui.js', *(f'planner/examples/{name}.js' for name in ('practice', 'decor', 'patterns', 'garage')),
    'planner/help.js', 'planner/help.css', 'planner/help-locales.js', 'planner/language-links.js',
    *(f'planner/locales/{code}.js' for code in LOCALE_CODES),
    'planner/model.js', 'planner/site-model.js', 'planner/site-editor.js', 'planner/site-editor.css', 'planner/site-map-underlay.js', 'planner/catalog.js', 'planner/furniture.js', 'planner/guide.html', 'planner/guide.css',
    'planner/publishing.html', 'planner/guide-assets/practice-home.json',
    'planner/guide-assets/01-room.jpg', 'planner/guide-assets/02-rooms.jpg',
    'planner/guide-assets/03-door.jpg', 'planner/guide-assets/04-window.jpg',
    'planner/guide-assets/05-item.jpg', 'planner/guide-assets/06-preview.jpg',
    'planner/guide-assets/07-export.jpg',
    'planner/guide-assets/08-library.jpg', 'planner/guide-assets/09-garage-studio.jpg',
    'planner/guide-assets/garage-and-studio.json',
    'planner/guide-assets/decor-studio.json', 'planner/guide-assets/10-decor-studio.jpg',
    'planner/guide-assets/pattern-studio.json', 'planner/guide-assets/11-pattern-studio.jpg',
    'planner/guide-assets/12-ai-review.jpg',
    'vendor/three.module.min.js', 'vendor/THREE-LICENSE.txt',
)
# The HA host and loopback companion open planner/index.html directly. Keep
# the website landing page and its promotional media out of both editor bundles.
EDITOR_FILES = tuple(name for name in SITE_FILES if name not in ('index.html', *WEBSITE_MEDIA_FILES))
REPO_FILES = (
    'camera-tour-viewer.js', 'docs/camera-tours.md', 'docs/images/camera-tour-workflow.svg', 'scripts/test-camera-tour.mjs', 'scripts/test-camera-tour-recording.mjs', 'scripts/test-camera-tour-session-contract.mjs', 'scripts/test-camera-tour-browser.cjs', 'scripts/test-camera-tour-native-downloads.cjs', 'scripts/test-camera-tour-hosts.cjs','scripts/tls_key_policy.py', 'scripts/_darwin_certificate.py', 'THIRD_PARTY_NOTICES.md',
              'docs/closed-build.md', '.closed-build-policy.json', 'requirements-closed-build.txt',
              '.github/workflows/closed-build.yml', 'docker/closed-worker.Dockerfile',
              'scripts/closed_build.py', 'scripts/closed_envelope.py', 'scripts/closed_worker.py',
              'scripts/closed_synthetic.py', 'scripts/test_closed_build.py',
              'scripts/download_tls.py', 'scripts/test-download-tls.py', 'requirements-tls-test.txt',
              'requirements-strict-tls.txt', 'docs/transport-security.md',
              'docs/vacuum-position.md', 'scripts/test-vacuum-state.cjs', 'scripts/test-vacuum-view.cjs', 'scripts/test-vacuum-position-host.cjs', 'scripts/test-vacuum-browser.cjs',
              'docs/indicators.md', 'scripts/test-appliance-state.cjs', 'scripts/test-presence-view.cjs',
              'docs/environment.md', 'docs/images/garden-surroundings.png',
              'scripts/test-environment.mjs', 'scripts/test-environment-browser.cjs',
              'scripts/test-environment-surfaces.mjs', 'scripts/author-environment-animal.py',
              'docs/i18n.md', 'docs/translations/README.md',
              'docs/dry-run.md', 'scripts/test-dry-run.cjs',
              'scripts/build-panel-locales.py', 'scripts/test-dry-run-browser.cjs',
              'scripts/validate-docs.py', 'scripts/test-docs.py',
              *(f'docs/wiki/{name}.md' for name in ('Home', '_Sidebar', 'Getting-started', 'Dry-run', 'Troubleshooting', 'Languages', 'Development')),
              'docs/images/home-studio-hero.jpg', 'scripts/render-docs-hero.sh',
              'docs/images/dry-run-command-flow.svg', 'docs/images/plan-state-lifecycle.svg',
              'docs/process-and-results.md', 'docs/images/dry-run-delivery-process.svg',
              'docs/images/dry-run-validation.svg', 'docs/data/dry-run-validation.json',
              'scripts/render-validation-chart.py',
              *(f'docs/translations/README.{code}.md' for code in LOCALE_CODES if code != 'en'),
              'scripts/build-example-modules.py', 'scripts/test-draft-storage.mjs', 'scripts/test-planner-editing.cjs', 'scripts/test-planner-precision.cjs', 'scripts/test-planner-split-view.cjs', 'scripts/test-onboarding.mjs', 'scripts/test-onboarding-browser.cjs',
              'scripts/test-floor-navigator.cjs', 'scripts/test-planner-navigation.cjs', 'scripts/test-floor-navigation.cjs',
              'scripts/test-i18n.mjs', 'scripts/test-i18n-browser.cjs', 'scripts/test-validation-i18n.mjs',
              'scripts/test-help-i18n.cjs', 'scripts/test-panel-language.cjs', 'scripts/test-viewer-i18n.cjs', 'scripts/test-lock-control.cjs',
              'viewer-i18n.js', 'viewer_locales.py', 'viewer-locales/index.json',
              *(f'viewer-locales/{code}.json' for code in LOCALE_CODES),
              'README.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md',
              'GOVERNANCE.md', 'CODE_OF_CONDUCT.md', 'ROADMAP.md', 'docs/quality.md',
              'RELEASING.md', 'CHANGELOG.md', 'docs/fuzzing.md',
              'docs/rc-fuzzing.md', 'docs/release-workflow.md', '.gitignore', '.gitattributes', 'scripts/validate-site.py', '.github/workflows/pages.yml',
              '.github/workflows/package.yml', '.github/workflows/platform-acceptance.yml',
              '.github/actions/upload-acceptance-artifact/action.yml',
              'docs/architecture.md', 'docs/first-session.md', 'docs/home-assistant-editor.md', 'docs/blender-export.md', 'docs/dashboard-and-media.md', 'docs/curtain-authoring.md', 'scripts/test-curtain-authoring.mjs', 'scripts/test-curtain-authoring.py', 'scripts/test-curtain-browser.cjs', 'docs/platform-acceptance.md',
              'docs/quality-and-release.md', 'docs/VERSIONING.md',
              'docs/assets/quality/release-pipeline.svg',
              'docs/assets/quality/browser-coverage.svg',
              'docs/assets/quality/webgl-recovery.svg',
              'docs/assets/quality/fuzz-results.svg',
              'docs/ai-planning.md', 'docs/ai-planner-architecture.md',
              'docs/ai-provider-setup.md', 'docs/ai-local-models.md',
              'docs/assets/ai/planning-data-flow.svg',
              'ai/package.json', 'ai/bootstrap.js', 'ai/panel.js', 'ai/panel.css',
              'ai/photo-worker.js', 'ai/photo-processing.js', 'ai/draft.js', 'ai/json.js',
              'ai_companion/__init__.py', 'ai_companion/assets.json',
              'ai_companion/server.py', 'ai_companion/protocol.py',
              'ai_companion/providers.py', 'ai_companion/transport.py', 'ai_companion/session.py',
              'scripts/serve-ai-planner.py', 'scripts/test-ai-companion.py',
              'scripts/test-ai-draft.mjs', 'scripts/test-ai-planner.cjs',
              'scripts/test-ai-integration.cjs',
              'scripts/build-planner-project.py', 'scripts/install-home-assistant.py',
              'scripts/package_release.py', 'scripts/test_package_release.py',
              'scripts/test_source_replay.py', 'scripts/test-device-onboarding.mjs', 'scripts/test-room-transform.mjs', 'scripts/device-onboarding-browser-check.cjs', *FUZZ_REPLAY_FILES,
              'scripts/test-light-state.cjs', 'scripts/test-tv-screen.cjs', 'scripts/test-media-preview.cjs',
              'scripts/test-install-home-assistant.py', 'scripts/test-public-package.py', 'scripts/test-wall-tops.cjs',
              'scripts/test-rounded-walls.cjs', 'scripts/test-wall-sheen.cjs', 'scripts/test-wall-motion.cjs', 'scripts/test-wall-outline-materials.cjs', 'scripts/test-unlit-architectural-walls.cjs', 'scripts/test-flat-editor-floors.cjs', 'docs/rounded-walls.md',
              'scripts/test-browser-stability.cjs', 'scripts/browser-stability-diagnostics.cjs',
              'scripts/browser-startup-diagnostics.cjs', 'scripts/test-browser-startup-diagnostics.cjs',
              'scripts/test-browser-stability-diagnostics.cjs', 'scripts/test-home-render-budget.cjs',
              'scripts/test-packed-room-lighting.cjs', 'scripts/test-zero-point-block.cjs', 'scripts/test-point-decay-two.cjs', 'scripts/test-cached-shadow-transmission.cjs', 'scripts/test-literal-lambert-directional.cjs', 'docs/literal-lambert-directional.md', 'docs/point-decay-two.md', 'scripts/test-glass-wall-program.cjs', 'scripts/test-fallback-shared-program.cjs',
              'scripts/test-point-texture-current.cjs', 'scripts/test-point-run-texture.cjs', 'scripts/test-static-geometry-atlas.cjs', 'scripts/test-point-signal-texture.cjs', 'scripts/test-signal-texture-decay-two.cjs', 'scripts/test-literal-lambert-point-body.cjs', 'scripts/test-scalar-shadow-point.cjs', 'scripts/test-scalar-indirect-lambert.cjs', 'scripts/test-direct-shadow-uniforms.cjs', 'scripts/test-scalar-lambert-accumulators.cjs',
              'scripts/waterfox-versions.json', 'scripts/setup-waterfox.py', 'scripts/test-waterfox-acceptance.py',
              'scripts/test-waterfox-tooling.py', 'scripts/native-viewer-program-diagnostics.js', 'scripts/test-native-viewer-programs.cjs',
              'scripts/prepare-intel-macos-ci.py', 'scripts/test-intel-macos-ci.py',
              'scripts/prepare-ubuntu-apt.py', 'scripts/test-ubuntu-apt.py',
              'scripts/firefox-versions.json', 'scripts/native_browser.py',
              'scripts/setup-native-browser.py', 'scripts/test-native-browser-acceptance.py',
              'scripts/diagnose-native-draw.py', 'scripts/native-draw-diagnostic.js',
              'scripts/test-native-draw-diagnostic.py', 'scripts/test-native-draw-diagnostic.cjs',
              'scripts/test-safari-acceptance.py', 'scripts/test-safari-tooling.py',
              'scripts/browser-matrix.json', 'scripts/browser-matrix.py',
              'scripts/setup-browser-toolchain.py', 'scripts/setup-chrome-for-testing.py',
              'scripts/install-browser-with-retry.py', 'scripts/test-browser-install.py',
              'scripts/test-browser-matrix.py',
              'scripts/test-render-capacity.cjs', 'scripts/test-interaction-render.cjs', 'scripts/test-render-lifecycle.cjs', 'scripts/test-pointer-ownership.cjs', 'scripts/test-viewer-geometry-context.cjs', 'scripts/test-viewer-texture-context.cjs', 'docs/browser-compatibility.md',
              'scripts/test-planner-stability.cjs', 'scripts/test-planner-render-budget.cjs',
              'scripts/test-viewer-startup.cjs', 'scripts/test-module-expiry.cjs', 'scripts/test-floor-context.py', 'scripts/test-floor-context.cjs',
              'planner/project.py', 'planner/site_model.py', 'planner/package.json', 'planner/catalog.json', 'planner/furniture.py',
              'docs/site-editor.md', 'docs/images/site-editor-layers.svg',
              'scripts/test-site-model.mjs', 'scripts/test-site-compiler.py', 'scripts/test-site-editor.cjs', 'scripts/test-ai-site.mjs',
              'scripts/test-site-map-underlay.mjs', 'scripts/test-native-site-map.cjs',
              'scripts/generate-furniture-catalog.py', 'scripts/test-furniture.mjs', 'scripts/test-furniture.py',
              'planner/anatomy.json', 'planner/vehicle_authoring.py', 'planner/bath_authoring.py', 'scripts/author-furniture-profiles.py',
              'scripts/test-furniture-profiles.py', 'docs/catalog-material-authoring.md',
              'scripts/test-inventory-appearance.cjs', 'scripts/test-inventory-appearance.py',
              'scripts/test-furniture-patterns.mjs', 'scripts/test-furniture-patterns.py',
              'scripts/test-furniture-editor.cjs', 'package.json', 'package-lock.json',
              'planner/example-home.json', 'geometry.py', 'exporters.py', 'physical_exports.py', 'material_textures.py', 'material-textures.js', 'pbr-color-data.js','pbr-materials.js', 'pbr_materials.py', 'environment-lighting.js',
              'scripts/test-material-textures.py', 'scripts/test-material-textures.cjs', 'scripts/test-pbr-materials.py', 'scripts/test-pbr-materials.cjs', 'scripts/test-pbr-lighting.cjs', 'scripts/test-physical-exports.py', 'docs/material-textures.md', 'docs/material-color-provenance.json',
              'viewer.template.html', 'viewer.js', 'home-view.html', 'home-view.css',
              'curtain-state.js', 'motion-state.js', 'appliance-state.js', 'presence-view.js', 'vacuum-state.js', 'vacuum-view.js', 'tv-screen.js', 'camera-preview.js', 'media-preview.js',
              'assumed-zone-view.js', 'map-layer.js', 'home-view.js', 'light-state.js', 'room-lighting.js',
              'custom_components/home_floorplan/__init__.py',
              'custom_components/home_floorplan/site.py',
              'custom_components/home_floorplan/native.py', 'custom_components/home_floorplan/ai.py', 'custom_components/home_floorplan/map.py',
              'docs/map-navigation.md', 'scripts/test-ha-map.py', 'scripts/test-ha-map-bridge.cjs', 'scripts/test-map-scene.cjs',
              'custom_components/home_floorplan/generated.py',
              'custom_components/home_floorplan/site_frame.py', 'custom_components/home_floorplan/site_calibration.py',
              'scripts/test-site-calibration.py', 'scripts/test-site-calibration.cjs',
              'docs/imported-site-calibration.md',
              'custom_components/home_floorplan/permissions.py',
              'custom_components/home_floorplan/config_flow.py',
              'custom_components/home_floorplan/strings.json',
              'custom_components/home_floorplan/translations/en.json',
              'custom_components/home_floorplan/static/studio.js',
              'custom_components/home_floorplan/static/map-transport.js',
              'hacs.json', 'requirements-ha-test.txt',
              'scripts/build-home-studio.py', 'scripts/test-ha-native.py', 'scripts/test-blender-export.py', 'scripts/test-blender-import.py',
              'scripts/test-ha-generated.py',
              'scripts/test-ha-project-metadata.py', 'scripts/test-ha-core.py', 'scripts/test-ha-ai.py',
              'scripts/test-native-studio.cjs', 'scripts/test-native-theme.cjs', 'scripts/test-native-ai.cjs', 'scripts/test-family-view.cjs',
              'custom_components/home_floorplan/validation.py',
              'custom_components/home_floorplan/curtains.py',
              'custom_components/home_floorplan/manifest.json',
              'custom_components/home_floorplan/static/panel.js',
              'custom_components/home_floorplan/static/card.js',
              'scripts/test-dashboard-card.cjs', 'scripts/test-media-artwork-host.cjs',
              'scripts/test-media-artwork-browser.cjs', 'docs/images/dashboard-media-example.png',
              'scripts/test-media-command-host.cjs', 'scripts/test-media-controls.cjs',
              'scripts/test-generic-entities.cjs', 'scripts/test-device-interactions.cjs', 'docs/device-controls.md')
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
        for key in ('src', 'href', 'poster'):
            if attrs.get(key):
                self.links.append((tag, key, attrs[key]))


def regular_file(root, relative):
    path = root / relative
    if not path.is_file() or any(part.is_symlink() for part in [path, *path.parents] if part != root.parent):
        raise ValueError(f'Missing file or symlink: {relative}')
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError(f'File escapes the public directory: {relative}')
    return path


def validate_website_media(path):
    """Bound the reviewed demo files; video/image content still needs visual review."""
    limits = {'.mp4': 90 * 1024 * 1024, '.gif': 12 * 1024 * 1024,
              '.jpg': 2 * 1024 * 1024, '.vtt': 256 * 1024}
    if not 0 < path.stat().st_size <= limits[path.suffix]:
        raise ValueError(f'Website media exceeds its size bound: {path.name}')
    with path.open('rb') as stream:
        header = stream.read(32)
    valid = {'.mp4': header[4:8] == b'ftyp', '.gif': header[:6] in (b'GIF87a', b'GIF89a'),
             '.jpg': header[:3] == b'\xff\xd8\xff',
             '.vtt': bool(re.match(rb'(?:\xef\xbb\xbf)?WEBVTT(?:[ \t].*)?\r?\n', header))}
    if not valid[path.suffix]:
        raise ValueError(f'Unexpected website media format: {path.name}')


def validate(root):
    root = root.resolve()
    documents = {}
    for relative in (*SITE_FILES, *REPO_FILES):
        path = regular_file(root, relative)
        if relative in BINARY_REPLAY_SEEDS:
            if path.read_bytes() != BINARY_REPLAY_SEEDS[relative]:
                raise ValueError(f'Unexpected binary replay seed: {relative}')
            continue
        if relative in WEBSITE_MEDIA_FILES:
            validate_website_media(path)
            if path.suffix != '.vtt':
                continue
        if path.suffix == '.jpg' or relative in ('docs/images/dashboard-media-example.png', 'docs/images/native-editor.png', 'docs/images/garden-surroundings.png'):
            continue
        text = path.read_text(encoding='utf-8')
        # The validator intentionally contains its own private-pattern tripwires.
        if relative != 'scripts/validate-site.py' and PRIVATE.search(text):
            raise ValueError(f'Private-data tripwire in {relative}')
        if path.suffix == '.html' and relative in SITE_FILES:
            parser = Links()
            parser.feed(text)
            documents[relative] = parser
    # The companion may serve only reviewed UI files, never its Python source or
    # arbitrary repository content. Network-capable AI modules stay off Pages.
    ai_assets = {'ai/bootstrap.js', 'ai/panel.js', 'ai/panel.css',
                 'ai/photo-worker.js', 'ai/photo-processing.js', 'ai/draft.js', 'ai/json.js'}
    allowed = json.loads(regular_file(root, 'ai_companion/assets.json').read_text())
    if (not isinstance(allowed, list) or not all(isinstance(name, str) for name in allowed)
            or len(allowed) != len(set(allowed)) or set(allowed) != set(EDITOR_FILES) | ai_assets):
        raise ValueError('Companion asset allowlist must exactly match reviewed UI assets')
    if ai_assets & set(SITE_FILES):
        raise ValueError('AI network modules must not be published on the shared Pages origin')
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
        for imported in re.findall(r'(?:from\s+|import\(\s*)[\'"]([^\'"]+)[\'"]', code):
            target = ((root / relative).parent / imported).resolve()
            # Reviewed native-only dynamic import: the authenticated host capability
            # gates this module; it is bundled into HA and never loaded by Pages.
            native_ai = (relative == "planner/editor.js" and imported == "../ai/panel.js")
            if not target.is_relative_to(root) or (target.relative_to(root).as_posix() not in SITE_FILES and not native_ai):
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
