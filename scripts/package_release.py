#!/usr/bin/env python3
"""Package only the public website/compiler inventory, never a user's project."""

import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PREFIX = "home-studio/"
SPEC = importlib.util.spec_from_file_location("validate_site", ROOT / "scripts/validate-site.py")
public_site = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(public_site)


def package(root: Path, output: Path, source_sha: str) -> Path:
    """Preserve the ZIP distribution with deterministic metadata and version."""
    if re.fullmatch(r"[a-f0-9]{40}", source_sha) is None:
        raise ValueError("Expected an exact source commit")
    public_site.validate(root)
    manifest = json.loads((root / "custom_components/home_floorplan/manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    if re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?", version) is None:
        raise ValueError("Invalid prepared Home Studio version")
    names = sorted(set(public_site.SITE_FILES + public_site.REPO_FILES))
    payload = {name: public_site.regular_file(root, name).read_bytes() for name in names}
    output.mkdir(parents=True, exist_ok=False)
    archive = output / f"home-studio-{version}.zip"
    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED) as zipped:
        for name, data in payload.items():
            entry = zipfile.ZipInfo(PREFIX + name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3  # Keep UNIX mode metadata identical on Windows.
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            zipped.writestr(entry, data)
    with zipfile.ZipFile(archive) as zipped:
        if len(zipped.namelist()) != len(payload):
            raise ValueError("Archive inventory mismatch")
        for name, expected in payload.items():
            if zipped.read(PREFIX + name) != expected:
                raise ValueError("Archive content mismatch")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix(".sha256").write_bytes(f"{digest}  {archive.name}\n".encode("utf-8"))
    metadata = {"schema": 1, "version": version, "source_sha": source_sha,
                "archive": archive.name, "sha256": digest, "files": len(payload),
                "scope": "public editor and compiler source with fictional examples"}
    (output / "home-studio.version.json").write_bytes((json.dumps(metadata, indent=2) + "\n").encode("utf-8"))
    return archive


if __name__ == "__main__":
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    print(package(ROOT, ROOT / "release-dist", sha))
