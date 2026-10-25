#!/usr/bin/env python3
"""Build a plan-free Home Assistant integration and its HACS release ZIP."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
COMPONENT_FILES = (
    "__init__.py", "site.py", "validation.py", "curtains.py", "native.py", "generated.py", "permissions.py",
    "ai.py", "map.py", "config_flow.py", "manifest.json", "strings.json", "translations/en.json",
    "static/panel.js", "static/card.js", "static/studio.js",
)
RUNTIME_FILES = (
    "geometry.py", "exporters.py", "physical_exports.py", "material_textures.py", "material-textures.js", "pbr-color-data.js", "pbr-materials.js", "pbr_materials.py", "environment-lighting.js", "viewer_locales.py", "planner/project.py", "planner/site_model.py", "planner/furniture.py", "planner/catalog.json",
    "viewer.template.html", "viewer.js", "viewer-i18n.js", "home-view.html", "home-view.css", "home-view.js",
    "curtain-state.js", "motion-state.js", "appliance-state.js", "presence-view.js", "vacuum-state.js", "vacuum-view.js", "tv-screen.js", "camera-preview.js", "media-preview.js",
    "assumed-zone-view.js", "map-layer.js", "light-state.js", "planner/render-capacity.js", "planner/interaction-render.js",
    "room-lighting.js", "vendor/three.module.min.js", "planner/environment.js",
    "ai_companion/__init__.py", "ai_companion/protocol.py", "ai_companion/providers.py",
    "ai_companion/transport.py", "ai_companion/session.py",
    "scripts/download_tls.py", "scripts/tls_key_policy.py", "scripts/_darwin_certificate.py",
)
AI_EDITOR_FILES = ("ai/bootstrap.js", "ai/panel.js", "ai/panel.css", "ai/photo-worker.js", "ai/photo-processing.js", "ai/draft.js", "ai/json.js")


def regular_file(root, name):
    path = root / name
    if not path.is_file() or path.is_symlink() or any(parent.is_symlink() for parent in path.parents if parent != root.parent):
        raise ValueError("Expected a regular source file: " + name)
    return path


def bundle_component(source_root, destination):
    """Copy reviewed public sources into an isolated runtime namespace at build time."""
    spec = importlib.util.spec_from_file_location("home_studio_public_inventory", source_root / "scripts/validate-site.py")
    inventory = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(inventory)
    destination.mkdir(parents=True, exist_ok=False)

    def copy_file(name, target):
        source = regular_file(source_root, name)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)

    for name in COMPONENT_FILES:
        copy_file("custom_components/home_floorplan/" + name, destination / name)
    runtime_files = RUNTIME_FILES + ("viewer-locales/index.json",) + tuple(
        "viewer-locales/" + code + ".json" for code in inventory.LOCALE_CODES)
    for name in runtime_files:
        copy_file(name, destination / "runtime" / name)
    for name in ("runtime/__init__.py", "runtime/planner/__init__.py", "runtime/scripts/__init__.py"):
        (destination / name).write_text('"""Build-time bundled public Home Studio runtime."""\n', encoding="utf-8")
    public_files = tuple(sorted(set(inventory.EDITOR_FILES + AI_EDITOR_FILES)))
    for name in public_files:
        copy_file(name, destination / "static/studio" / name)
    (destination / "studio-files.json").write_text(json.dumps(public_files) + "\n", encoding="utf-8")
    for source, target in (("LICENSE", "LICENSE"), ("vendor/THREE-LICENSE.txt", "THREE-LICENSE.txt"),
                           ("THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md")):
        copy_file(source, destination / target)
    return destination


def build_integration(source_root, output):
    """Create a complete install folder and a ZIP with component files at its root."""
    output = Path(output).absolute()
    if output.exists():
        raise ValueError("Choose a new output directory; existing output is never overwritten.")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".home-studio-build-", dir=output.parent) as temporary:
        staged = Path(temporary)
        component = bundle_component(source_root, staged / "custom_components/home_floorplan")
        archive = staged / "home_floorplan.zip"
        with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED) as zipped:
            for path in sorted(component.rglob("*")):
                if path.is_file():
                    entry = zipfile.ZipInfo(path.relative_to(component).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
                    entry.create_system = 3
                    entry.compress_type = zipfile.ZIP_DEFLATED
                    entry.external_attr = 0o100644 << 16
                    zipped.writestr(entry, path.read_bytes())
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        (staged / "home_floorplan.zip.sha256").write_text(digest + "  home_floorplan.zip\n", encoding="utf-8")
        staged.rename(output)
    return output / "home_floorplan.zip"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "dist/home-assistant", help="A new output directory")
    args = parser.parse_args()
    try:
        archive = build_integration(ROOT, args.output)
    except (ValueError, OSError) as error:
        parser.exit(2, "Home Studio packaging failed: " + str(error) + "\n")
    print(json.dumps({"archive": str(archive), "component": str(archive.parent / "custom_components/home_floorplan")}))


if __name__ == "__main__":
    main()
