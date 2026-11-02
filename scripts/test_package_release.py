"""Public source release inventory and reproducibility checks."""

import hashlib
import importlib.metadata
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import package_release as packaging

RELEASE_REPLAY_FILES = (
    'scripts/closed_upload_control_v2.py', 'scripts/closed_release_worker.py', 'scripts/closed_release_transport.py',
    'scripts/test_closed_upload_control_v2.py', 'scripts/test_closed_transport.py',
    'scripts/test-closed-release-worker.py', 'scripts/test-closed-release-transport.py',
    'scripts/fixtures/release_transport_tls_child.py', 'docs/closed-release-bootstrap.md',
    'scripts/release_control.py', 'scripts/release_fuzz.py', 'scripts/version_plan.py', 'scripts/version_receipt.py',
)


def has_release_runtime():
    # Cross-platform source packaging needs no optional transport installation.
    # Exercise the executable replay when its declared POSIX runtime is present.
    if os.name != 'posix':
        return False
    try:
        return importlib.metadata.version('cryptography') == '50.0.1'
    except importlib.metadata.PackageNotFoundError:
        return False


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

    def test_operating_guides_work_from_the_extracted_source_archive(self):
        import importlib.util
        with tempfile.TemporaryDirectory(prefix='home-studio-docs-') as temp:
            directory = Path(temp)
            archive = packaging.package(packaging.ROOT, directory / 'release', 'a' * 40)
            with zipfile.ZipFile(archive) as zipped:
                zipped.extractall(directory / 'extracted')
            extracted = directory / 'extracted/home-studio'
            spec = importlib.util.spec_from_file_location('packaged_docs', extracted / 'scripts/validate-docs.py')
            docs = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(docs)
            result = docs.validate(extracted)
            self.assertEqual(result['languages'], len(packaging.public_site.LOCALE_CODES))
            self.assertGreater(result['guides'], result['languages'])

    def test_extracted_public_source_compiles_and_installs_without_checkout(self):
        with tempfile.TemporaryDirectory(prefix="home-studio-source-") as temporary:
            work = Path(temporary)
            archive = packaging.package(packaging.ROOT, work / "dist", "a" * 40)
            with zipfile.ZipFile(archive) as contents:
                self.assertIn("home-studio/planner/interaction-render.js", contents.namelist())
                feedback_files = {"home-studio/" + name for name in (
                    "climate-state.js", "marker-motion.js", "device-effects.js",
                    "scripts/test-climate-state.cjs", "scripts/test-marker-motion.cjs",
                    "scripts/test-device-effects.cjs", "scripts/test-device-feedback.cjs",
                    "scripts/test-fixture-animation.cjs", "scripts/test-fixture-animation.py")}
                self.assertEqual(feedback_files - set(contents.namelist()), set(),
                                 "The public source archive retains device feedback and its CI checks")
                action = ".github/actions/upload-acceptance-artifact/action.yml"
                self.assertEqual(contents.read("home-studio/" + action),
                                 (packaging.ROOT / action).read_bytes())
                for name in RELEASE_REPLAY_FILES:
                    self.assertEqual(contents.read("home-studio/" + name),
                                     (packaging.ROOT / name).read_bytes(), name)
                contents.extractall(work / "extracted")
            source = work / "extracted/home-studio"
            # -I excludes the checkout and PYTHONPATH. Import the lazy public
            # input helpers from the extracted package, with no network calls.
            probe = '''import importlib,pathlib,sys
root=pathlib.Path(sys.argv[1]).resolve()
sys.path.insert(0,str(root/'scripts'))
for name in ('release_control','release_fuzz','version_plan','version_receipt'):
 module=importlib.import_module(name)
 assert pathlib.Path(module.__file__).resolve().parent == root/'scripts'
'''
            result = subprocess.run([sys.executable, '-I', '-c', probe, str(source)],
                                    cwd=work, capture_output=True, text=True, timeout=30, check=False)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            result = subprocess.run([sys.executable, "scripts/test-public-package.py"],
                                    cwd=source, capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    @unittest.skipUnless(has_release_runtime(), 'requires the locked POSIX closed-release runtime')
    def test_closed_release_replays_from_extracted_source_without_checkout(self):
        with tempfile.TemporaryDirectory(prefix='home-studio-release-replay-') as temporary:
            root = Path(temporary).resolve()
            archive = packaging.package(packaging.ROOT, root / 'dist', 'a' * 40)
            with zipfile.ZipFile(archive) as contents:
                contents.extractall(root / 'extracted')
            source = root / 'extracted/home-studio'
            # The suite exercises real crypto, all sibling imports, the USTAR
            # bootstrap, and builder/output checks. Its transport is synthetic.
            probe = '''import pathlib,runpy,sys
root=pathlib.Path(sys.argv[1]).resolve()
sys.path.insert(0,str(root/'scripts'))
sys.argv=[str(root/'scripts/test-closed-release-worker.py')]
runpy.run_path(sys.argv[0],run_name='__main__')
'''
            result = subprocess.run([sys.executable, '-I', '-c', probe, str(source)],
                                    cwd=root, capture_output=True, text=True, timeout=60, check=False)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_invalid_source_is_rejected_before_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaises(ValueError):
                packaging.package(root, root / "output", "main")
            self.assertFalse((root / "output").exists())


if __name__ == "__main__":
    unittest.main()
