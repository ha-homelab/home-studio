"""Public source release inventory and reproducibility checks."""

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import package_release as packaging


class PublicPackageTests(unittest.TestCase):
    def test_deterministic_allowlist_and_embedded_version(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            manifest = root / "custom_components/home_floorplan/manifest.json"
            manifest.parent.mkdir(parents=True)
            manifest.write_text('{"version":"0.6.1"}')
            (root / "README.md").write_text("Fictional example only")
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
                    self.assertEqual(json.loads(archive.read("home-studio/custom_components/home_floorplan/manifest.json"))["version"], "0.6.1")
                metadata = json.loads((first.parent / "home-studio.version.json").read_text())
                self.assertEqual(metadata["sha256"], hashlib.sha256(first.read_bytes()).hexdigest())
                self.assertEqual(metadata["source_sha"], "a" * 40)
                with self.assertRaises(FileExistsError):
                    packaging.package(root, root / "one", "a" * 40)

    def test_invalid_source_is_rejected_before_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaises(ValueError):
                packaging.package(root, root / "output", "main")
            self.assertFalse((root / "output").exists())


if __name__ == "__main__":
    unittest.main()
