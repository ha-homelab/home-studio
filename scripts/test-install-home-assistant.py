#!/usr/bin/env python3
"""Exercise the local installer with real archives and temporary config trees."""
import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/install-home-assistant.py"
SPEC = importlib.util.spec_from_file_location("home_studio_installer", SCRIPT)
installer = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = installer
SPEC.loader.exec_module(installer)


def json_bytes(value):
    return json.dumps(value).encode()


def fixture_files():
    site = {"schema_version": 1, "site_id": "example_home", "default_floor": "main",
            "floors": {"main": {"stem": "main", "title": "Main floor"}}, "site_features": False}
    files = {name: b"# placeholder, never executed\n" for name in installer.CORE_FILES}
    files.update({
        "site.json": json_bytes(site),
        "manifest.json": json_bytes({"domain": "home_floorplan", "version": "1.0.0"}),
        "curtains.json": b"{}", "motion-room.json": b"{}",
        "room-activity.json": json_bytes({"floor": "main", "rooms": {}, "sources": [], "receivers": []}),
        "assumed-activity.json": json_bytes({"schema": "ruview.assumed-activity.config.v1",
                                            "coordinate_frame": "example_home", "geometry_assumed": False,
                                            "receivers": [], "zones": []}),
    })
    files.update({f"assets/main/{name}": b"fixture" for name in installer.FLOOR_FILES})
    files.update({f"assets/main/main.{ext}": b"fixture" for ext in installer.FLOOR_FORMATS})
    return files


def snapshot(root):
    return {p.relative_to(root).as_posix(): p.read_bytes() if p.is_file() else None
            for p in root.rglob("*")}


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="home-studio-installer-test-")
        self.addCleanup(self.temp.cleanup)
        # macOS /var is a symlink; tests intentionally use its real destination.
        self.work = Path(self.temp.name).resolve()
        self.config = self.work / "config"
        self.config.mkdir()
        (self.config / "configuration.yaml").write_text("default_config:\n")
        (self.config / ".storage").mkdir()
        (self.config / ".storage/saved-data").write_text("keep saved inventory")
        self.original = snapshot(self.config)
        self.target = self.config / "custom_components/home_floorplan"
        self.files = fixture_files()
        self.archive = self.work / "home-floorplan.tar.gz"
        self.write_package()

    def write_package(self, files=None, extra=()):
        with tarfile.open(self.archive, "w:gz") as archive:
            for name, data in (self.files if files is None else files).items():
                entry = tarfile.TarInfo(installer.ARCHIVE_ROOT + "/" + name)
                entry.size = len(data)
                entry.mode = 0o7777
                archive.addfile(entry, io.BytesIO(data))
            for entry, data in extra:
                archive.addfile(entry, io.BytesIO(data))

    def reject(self, pattern=None, **options):
        before = snapshot(self.config)
        with self.assertRaisesRegex(installer.InstallError, pattern or "."):
            installer.install(self.archive, self.config, **options)
        self.assertEqual(snapshot(self.config), before)
        self.assertFalse(any(self.config.glob(".home-studio-install-*")))

    def test_install_preserves_config_and_storage_and_sanitizes_modes(self):
        result = installer.install(self.archive, self.config)
        self.assertEqual(result.site_id, "example_home")
        self.assertIsNone(result.backup)
        for name, expected in self.files.items():
            path = self.target / name
            self.assertEqual(path.read_bytes(), expected)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)
        for name, expected in self.original.items():
            if expected is not None:
                self.assertEqual((self.config / name).read_bytes(), expected)
        self.assertFalse((self.config / ".home-studio-backups").exists())
        self.assertFalse(any(self.config.glob(".home-studio-install-*")))

    def test_existing_component_requires_replace(self):
        installer.install(self.archive, self.config)
        self.reject("--replace")

    def test_replace_keeps_complete_timestamped_backup_outside_components(self):
        installer.install(self.archive, self.config)
        (self.target / "old-only.txt").write_text("previous custom file")
        previous = snapshot(self.target)
        self.files["static/panel.js"] = b"updated panel"
        self.write_package()
        result = installer.install(self.archive, self.config, replace=True)
        self.assertEqual(snapshot(result.backup), previous)
        self.assertEqual(result.backup.parent, self.config / ".home-studio-backups")
        self.assertRegex(result.backup.name, r"^home_floorplan-\d{8}T\d{6}\.\d{6}Z-[a-f0-9]{32}$")
        self.assertFalse((self.target / "old-only.txt").exists())
        self.assertEqual((self.target / "static/panel.js").read_bytes(), b"updated panel")
        again = installer.install(self.archive, self.config, replace=True)
        self.assertNotEqual(result.backup, again.backup)
        self.assertTrue(result.backup.is_dir())

    def test_dry_run_does_not_write(self):
        result = installer.install(self.archive, self.config, dry_run=True)
        self.assertTrue(result.dry_run)
        self.assertEqual(snapshot(self.config), self.original)
        installer.install(self.archive, self.config)
        before = snapshot(self.config)
        result = installer.install(self.archive, self.config, dry_run=True, replace=True)
        self.assertTrue(result.replacing)
        self.assertIsNone(result.backup)
        self.assertEqual(snapshot(self.config), before)

    def test_dry_run_also_rejects_invalid_archive(self):
        del self.files["site.json"]
        self.write_package()
        self.reject("site.json", dry_run=True)

    def test_all_missing_and_empty_required_files_fail_before_writes(self):
        required = set(installer.CORE_FILES) | {name for name in self.files if name.startswith("assets/")}
        for name in required:
            with self.subTest(name=name):
                incomplete = dict(self.files)
                del incomplete[name]
                self.write_package(incomplete)
                self.reject("Missing or empty")
        incomplete = dict(self.files, **{"static/panel.js": b""})
        self.write_package(incomplete)
        self.reject("Missing or empty")

    def test_unsafe_paths_rejected(self):
        for name in ("../escape", "/tmp/escape", "custom_components/other/file.py",
                     "custom_components/home_floorplan_evil/file.py",
                     installer.ARCHIVE_ROOT + "/../escape", installer.ARCHIVE_ROOT + "/./file",
                     installer.ARCHIVE_ROOT + "//file", installer.ARCHIVE_ROOT + "/file\\bad",
                     installer.ARCHIVE_ROOT + "/file\nname", installer.ARCHIVE_ROOT + "/file\x7fname",
                     installer.ARCHIVE_ROOT + "/file\u202ename", installer.ARCHIVE_ROOT + "/" + "x" * 241,
                     installer.ARCHIVE_ROOT + "/a/b/c/d/e/f/g/h/i"):
            with self.subTest(name=name):
                entry = tarfile.TarInfo(name)
                entry.size = 1
                self.write_package(extra=[(entry, b"x")])
                self.reject("Unsafe")

    def test_duplicate_case_collisions_and_file_directory_conflicts(self):
        for name in ("site.json", "SITE.json", "STATIC/extra.js", "static", "site.json/child"):
            with self.subTest(name=name):
                entry = tarfile.TarInfo(installer.ARCHIVE_ROOT + "/" + name)
                entry.size = 1
                self.write_package(extra=[(entry, b"x")])
                self.reject("Duplicate|Case-colliding|conflict")

    def test_only_regular_files_and_directories_allowed(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE,
                     tarfile.CHRTYPE, tarfile.BLKTYPE, tarfile.GNUTYPE_SPARSE, b"V"):
            with self.subTest(kind=kind):
                entry = tarfile.TarInfo(installer.ARCHIVE_ROOT + "/danger")
                entry.type = kind
                if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                    entry.linkname = "../../outside"
                self.write_package(extra=[(entry, b"")])
                self.reject()

    def test_normal_directory_entries_and_pax_mtime_are_supported(self):
        directory = tarfile.TarInfo(installer.ARCHIVE_ROOT + "/assets/main")
        directory.type = tarfile.DIRTYPE
        directory.pax_headers = {"mtime": "1234.56789"}
        self.write_package(extra=[(directory, b"")])
        installer.install(self.archive, self.config)
        self.assertTrue((self.target / "assets/main/index.html").is_file())

    def test_directory_data_and_sparse_pax_are_rejected(self):
        directory = tarfile.TarInfo(installer.ARCHIVE_ROOT + "/empty")
        directory.type, directory.size = tarfile.DIRTYPE, 1
        self.write_package(extra=[(directory, b"x")])
        self.reject("zero data size")
        sparse = tarfile.TarInfo(installer.ARCHIVE_ROOT + "/sparse")
        sparse.pax_headers = {"GNU.sparse.name": "sparse"}
        self.write_package(extra=[(sparse, b"")])
        self.reject()

    def test_manifest_validation_never_executes_package_code(self):
        marker = self.work / "executed"
        evil = f"from pathlib import Path\nPath({str(marker)!r}).touch()\n".encode()
        self.files["site.py"] = evil
        self.files["__init__.py"] = evil
        self.write_package()
        installer.install(self.archive, self.config)
        self.assertFalse(marker.exists())

    def test_generic_site_json_is_mandatory_and_strict(self):
        original = json.loads(self.files["site.json"])
        cases = [None, {}, [], {**original, "schema_version": True}, {**original, "schema_version": 2},
                 {**original, "site_features": True}, {**original, "site_features": 0},
                 {**original, "site_id": "../house"}, {**original, "default_floor": "missing"},
                 {**original, "floors": {}}, {**original, "extra": 1},
                 {**original, "floors": {"main": {"stem": "../bad", "title": "Floor"}}},
                 {**original, "floors": {"main": {"stem": "main", "title": "Bad\nname"}}}]
        for value in cases:
            with self.subTest(value=value):
                self.files["site.json"] = json_bytes(value)
                self.write_package()
                self.reject()
        for raw in (b"{", b"\xff", b'{"x":1,"x":2}', b'{"x":NaN}', b" " * 65537):
            self.files["site.json"] = raw
            self.write_package()
            self.reject()

    def test_site_adapters_must_be_disabled(self):
        for name in ("curtains.json", "motion-room.json", "room-activity.json", "assumed-activity.json"):
            with self.subTest(name=name):
                files = dict(self.files)
                files[name] = b'{"enabled":true}'
                self.write_package(files)
                self.reject("disabled generic")

    def test_minimal_public_core_does_not_require_private_adapters(self):
        self.files = {name: data for name, data in self.files.items()
                      if name in installer.CORE_FILES or name.startswith("assets/")}
        self.write_package()
        installer.install(self.archive, self.config)
        self.assertFalse((self.target / "access.py").exists())
        self.assertFalse((self.target / "room-activity.json").exists())

    def test_private_household_requires_explicit_flag_and_preserves_storage(self):
        site = json.loads(self.files["site.json"])
        site.update(site_id=None, site_features=True)
        self.files["site.json"] = json_bytes(site)
        self.files["curtains.json"] = json_bytes({"cover.example": {"guard": "switch.example"}})
        for name in ("plan.svg", "inventory.json", "inventory-template.json", "main.usda"):
            del self.files["assets/main/" + name]
        self.files["assets/main/main.usdz"] = b"optional private export"
        self.write_package()
        self.reject("--allow-site-features")
        result = installer.install(self.archive, self.config, allow_site_features=True)
        self.assertIsNone(result.site_id)
        self.assertTrue(json.loads((self.target / "site.json").read_text())["site_features"])
        self.assertEqual((self.config / ".storage/saved-data").read_text(), "keep saved inventory")

    def test_private_flag_does_not_relax_generic_validation_or_archive_paths(self):
        self.files["site.json"] = json_bytes({**json.loads(self.files["site.json"]), "site_id": None})
        self.write_package()
        self.reject("valid site_id", allow_site_features=True)
        self.files = fixture_files()
        bad = tarfile.TarInfo("../outside")
        self.write_package(extra=[(bad, b"")])
        self.reject("Unsafe", allow_site_features=True)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "Named pipes are unavailable")
    def test_fifo_archive_rejected_without_blocking(self):
        self.archive.unlink()
        os.mkfifo(self.archive)
        self.reject("regular")

    def test_wrong_integration_manifest_rejected(self):
        self.files["manifest.json"] = json_bytes({"domain": "other", "version": "1"})
        self.write_package()
        self.reject("manifest.json")

    def test_resource_limits_fail_closed(self):
        for constant, limit in (("MAX_ARCHIVE_BYTES", 1), ("MAX_TAR_BYTES", 512),
                                ("MAX_FILE_BYTES", 1), ("MAX_TOTAL_BYTES", 1), ("MAX_MEMBERS", 1)):
            with self.subTest(limit=constant), patch.object(installer, constant, limit):
                self.reject("limit")
        bomb = gzip.compress(b"0" * (1024 * 1024))
        self.archive.write_bytes(bomb)
        with patch.object(installer, "MAX_TAR_BYTES", 65536):
            self.reject("Expanded tar")

    def test_oversized_pax_metadata_and_sparse_maps_rejected_before_expansion(self):
        entry = tarfile.TarInfo(installer.ARCHIVE_ROOT + "/extra")
        entry.pax_headers = {"comment": "x" * 65537}
        self.write_package(extra=[(entry, b"")])
        self.reject("extension metadata")
        for version in ("0", "1"):
            entry.pax_headers = {"GNU.sparse.major": version, "GNU.sparse.minor": "0"}
            self.write_package(extra=[(entry, b"")])
            self.reject("Sparse")

    def test_larger_private_limits_require_explicit_flag(self):
        for name in ("MAX_ARCHIVE_BYTES", "MAX_TAR_BYTES", "MAX_FILE_BYTES", "MAX_TOTAL_BYTES"):
            with self.subTest(limit=name), patch.object(installer, name, 1):
                self.reject("limit", dry_run=True)
                result = installer.install(self.archive, self.config, dry_run=True, allow_site_features=True)
                self.assertTrue(result.dry_run)
        self.assertEqual(snapshot(self.config), self.original)

    def test_private_limits_remain_bounded_and_do_not_change_defaults(self):
        for name in ("PRIVATE_MAX_ARCHIVE_BYTES", "PRIVATE_MAX_TAR_BYTES",
                     "PRIVATE_MAX_FILE_BYTES", "PRIVATE_MAX_TOTAL_BYTES"):
            with self.subTest(limit=name), patch.object(installer, name, 1):
                self.reject("limit", dry_run=True, allow_site_features=True)
                result = installer.install(self.archive, self.config, dry_run=True)
                self.assertTrue(result.dry_run)
        self.assertEqual(snapshot(self.config), self.original)

    def test_corruption_truncation_and_appended_archives_fail_closed(self):
        valid = self.archive.read_bytes()
        tar = gzip.decompress(valid)
        for data in (b"not gzip", valid[:-8], gzip.compress(tar[:1200]),
                     gzip.compress(tar + b"hidden content"), gzip.compress(tar + tar)):
            with self.subTest(size=len(data)):
                self.archive.write_bytes(data)
                self.reject()

    def test_missing_or_non_directory_config_is_never_created(self):
        missing = self.work / "missing/nested"
        with self.assertRaisesRegex(installer.InstallError, "does not exist"):
            installer.install(self.archive, missing)
        self.assertFalse((self.work / "missing").exists())
        file = self.work / "file-config"
        file.write_text("keep")
        with self.assertRaisesRegex(installer.InstallError, "Expected a directory"):
            installer.install(self.archive, file)

    def test_symlink_config_or_ancestor_rejected(self):
        link = self.work / "linked-config"
        link.symlink_to(self.config, target_is_directory=True)
        for path in (link, link / ".storage"):
            with self.subTest(path=path), self.assertRaisesRegex(installer.InstallError, "Symlink"):
                installer.install(self.archive, path)
        self.assertEqual(snapshot(self.config), self.original)

    def test_symlink_components_target_and_backup_roots_rejected(self):
        elsewhere = self.work / "elsewhere"
        elsewhere.mkdir()
        parent = self.target.parent
        parent.symlink_to(elsewhere, target_is_directory=True)
        self.reject("Symlink", replace=True)
        parent.unlink()
        parent.mkdir()
        self.target.symlink_to(elsewhere, target_is_directory=True)
        self.reject("Symlink", replace=True)
        self.target.unlink()
        self.target.symlink_to(self.work / "missing", target_is_directory=True)
        self.reject("Symlink", replace=True)
        self.target.unlink()
        self.target.mkdir()
        backups = self.config / ".home-studio-backups"
        backups.symlink_to(elsewhere, target_is_directory=True)
        self.reject("Symlink", replace=True)
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_existing_regular_file_target_rejected(self):
        self.target.parent.mkdir()
        self.target.write_text("keep")
        self.reject("Expected a directory", replace=True)

    def test_parent_traversal_in_config_rejected(self):
        with self.assertRaisesRegex(installer.InstallError, "without '..'"):
            installer.install(self.archive, self.config / ".storage/..")

    def test_failed_new_install_cleans_staging_and_new_parent(self):
        with patch.object(installer.os, "replace", side_effect=OSError("simulated swap failure")):
            with self.assertRaisesRegex(OSError, "simulated"):
                installer.install(self.archive, self.config)
        self.assertEqual(snapshot(self.config), self.original)

    def test_failed_update_restores_previous_component(self):
        installer.install(self.archive, self.config)
        previous = snapshot(self.config)
        original_replace = os.replace

        def fail_staged_move(source, destination):
            if Path(source).name.startswith(".home-studio-install-"):
                raise OSError("simulated swap failure")
            return original_replace(source, destination)

        with patch.object(installer.os, "replace", side_effect=fail_staged_move):
            with self.assertRaisesRegex(OSError, "simulated swap failure"):
                installer.install(self.archive, self.config, replace=True)
        self.assertEqual(snapshot(self.config), previous)

    def test_failed_rollback_retains_previous_backup_and_reports_path(self):
        installer.install(self.archive, self.config)
        previous = snapshot(self.target)
        original_replace = os.replace

        def fail_after_backup(source, destination):
            if Path(source) == self.target:
                return original_replace(source, destination)
            raise OSError("simulated failure")

        with patch.object(installer.os, "replace", side_effect=fail_after_backup):
            with self.assertRaisesRegex(installer.InstallError, "Previous component is preserved at") as error:
                installer.install(self.archive, self.config, replace=True)
        backups = list((self.config / ".home-studio-backups").iterdir())
        self.assertEqual(len(backups), 1)
        self.assertIn(str(backups[0]), str(error.exception))
        self.assertEqual(snapshot(backups[0]), previous)
        self.assertFalse(any(self.config.glob(".home-studio-install-*")))

    def test_late_invalid_member_does_not_modify_existing_install(self):
        installer.install(self.archive, self.config)
        bad = tarfile.TarInfo("../../escape")
        self.write_package(extra=[(bad, b"")])
        self.reject("Unsafe", replace=True)

    def test_cli_prints_yaml_restart_and_backup_steps(self):
        result = subprocess.run([sys.executable, str(SCRIPT), str(self.archive), "--config", str(self.config)],
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        for phrase in ("home_floorplan:", "configuration.yaml", "configuration check", "Restart Home Assistant", "3D Home"):
            self.assertIn(phrase, result.stdout)
        result = subprocess.run([sys.executable, str(SCRIPT), str(self.archive), "--config", str(self.config), "--replace"],
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Previous component backup:", result.stdout)
        self.assertIn(".home-studio-backups/home_floorplan-", result.stdout)

    def test_cli_errors_are_concise_and_nonzero(self):
        self.archive.write_bytes(b"invalid")
        result = subprocess.run([sys.executable, str(SCRIPT), str(self.archive), "--config", str(self.config)],
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("Installation failed:", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(snapshot(self.config), self.original)

    def test_real_compiler_archive_installs(self):
        build = self.work / "compiled"
        result = subprocess.run([sys.executable, str(ROOT / "scripts/build-planner-project.py"),
                                 "--project", str(ROOT / "planner/example-home.json"),
                                 "--output", str(build), "--ha-package"],
                                text=True, capture_output=True,
                                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(result.returncode, 0, result.stderr)
        result = installer.install(build / "home-floorplan.tar.gz", self.config)
        self.assertEqual(result.site_id, "example_cottage")
        self.assertTrue((self.target / "assets/main/main.glb").is_file())
        self.assertFalse(json.loads((self.target / "site.json").read_text())["site_features"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
