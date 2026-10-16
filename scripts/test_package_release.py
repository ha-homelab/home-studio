"""Public source release inventory and reproducibility checks."""

import hashlib
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import patch
import zipfile

import package_release as packaging


class PublicPackageTests(unittest.TestCase):
    def test_deterministic_allowlist_and_embedded_version(self):
        with tempfile.TemporaryDirectory(prefix="home studio-é-") as temp:
            root = Path(temp).resolve()
            manifest = root / "custom_components/home_floorplan/manifest.json"
            manifest.parent.mkdir(parents=True)
            manifest.write_text('{"version":"0.6.1"}')
            source = "Fictional example — Maison été — 家\n".encode("utf-8")
            (root / "README.md").write_bytes(source)
            (root / "project.json").write_text("PRIVATE_SENTINEL")
            with patch.object(packaging.public_site, "validate"), patch.object(
                packaging.public_site, "SITE_FILES", ("README.md",)
            ), patch.object(packaging.public_site, "REPO_FILES", (manifest.relative_to(root).as_posix(),)):
                first = packaging.package(root, root / "one", "a" * 40)
                second = packaging.package(root, root / "two", "a" * 40)
                self.assertEqual(first.name, "home-studio-0.6.1.zip")
                self.assertEqual(first.read_bytes(), second.read_bytes())
                with zipfile.ZipFile(first) as archive:
                    self.assertEqual(len(archive.namelist()), 2)
                    self.assertNotIn("home-studio/project.json", archive.namelist())
                    self.assertEqual(archive.read("home-studio/README.md"), source)
                    for entry in archive.infolist():
                        self.assertEqual(entry.create_system, 3)
                        self.assertEqual(entry.external_attr >> 16, 0o100644)
                        self.assertEqual(entry.date_time, (1980, 1, 1, 0, 0, 0))
                        self.assertNotIn("\\", entry.filename)
                    self.assertEqual(json.loads(archive.read("home-studio/custom_components/home_floorplan/manifest.json"))["version"], "0.6.1")
                metadata = json.loads((first.parent / "home-studio.version.json").read_text())
                self.assertEqual(metadata["sha256"], hashlib.sha256(first.read_bytes()).hexdigest())
                self.assertEqual(metadata["source_sha"], "a" * 40)
                checksum = f"{metadata['sha256']}  {first.name}\n".encode("utf-8")
                self.assertEqual(first.with_suffix(".sha256").read_bytes(), checksum)
                self.assertEqual((first.parent / "home-studio.version.json").read_bytes(),
                                 (second.parent / "home-studio.version.json").read_bytes())
                self.assertNotIn(b"\r", (first.parent / "home-studio.version.json").read_bytes())
                with self.assertRaises(FileExistsError):
                    packaging.package(root, root / "one", "a" * 40)

    def test_extracted_public_source_compiles_and_installs_without_checkout(self):
        with tempfile.TemporaryDirectory(prefix="home-studio-source-") as temporary:
            work = Path(temporary)
            archive = packaging.package(packaging.ROOT, work / "dist", "a" * 40)
            with zipfile.ZipFile(archive) as contents:
                self.assertIn("home-studio/planner/interaction-render.js", contents.namelist())
                action = ".github/actions/upload-acceptance-artifact/action.yml"
                self.assertEqual(contents.read("home-studio/" + action),
                                 (packaging.ROOT / action).read_bytes())
                contents.extractall(work / "extracted")
            source = work / "extracted/home-studio"
            result = subprocess.run([sys.executable, "scripts/test-public-package.py"],
                                    cwd=source, capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_invalid_source_is_rejected_before_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaises(ValueError):
                packaging.package(root, root / "output", "main")
            self.assertFalse((root / "output").exists())


if __name__ == "__main__":
    unittest.main()
