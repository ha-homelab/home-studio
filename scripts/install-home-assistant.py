#!/usr/bin/env python3
"""Install a compiler-generated Home studio archive into an existing HA config.

Usage: python3 scripts/install-home-assistant.py home-floorplan.tar.gz --config /config
Use --dry-run to validate without writing, and --replace to update an existing
component. Only install archives from a trusted source: layout validation does
not audit the Python or JavaScript that Home Assistant will later run.

Python 3.10+, standard library only. No network, HA API, YAML edits, or restart.
The config directory must be local, writable, and not concurrently modified.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import gzip
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tarfile
import tempfile
import uuid
import zlib


COMPONENT = "home_floorplan"
ARCHIVE_ROOT = "custom_components/" + COMPONENT
MIB = 1024 * 1024
MAX_ARCHIVE_BYTES = 64 * MIB
MAX_TAR_BYTES = 128 * MIB
MAX_FILE_BYTES = 32 * MIB
MAX_TOTAL_BYTES = 96 * MIB
PRIVATE_MAX_ARCHIVE_BYTES = 128 * MIB
PRIVATE_MAX_TAR_BYTES = 512 * MIB
PRIVATE_MAX_FILE_BYTES = 64 * MIB
PRIVATE_MAX_TOTAL_BYTES = 384 * MIB
MAX_MEMBERS = 2048
MAX_JSON_BYTES = 65536
MAX_PATH_BYTES = 240
MAX_PATH_DEPTH = 8
IDENTIFIER = re.compile(r"[a-z][a-z0-9_]{0,47}\Z")
SEGMENT = re.compile(r"[A-Za-z0-9_.-]+\Z")
WINDOWS_DEVICE = re.compile(r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", re.I)
CORE_FILES = frozenset({
    "__init__.py", "curtains.py", "site.py", "validation.py", "manifest.json",
    "site.json", "curtains.json", "static/panel.js",
})
FLOOR_FILES = ("index.html", "model-data.json", "plan.svg", "inventory.json",
               "inventory-template.json")
FLOOR_FORMATS = ("glb", "obj", "mtl", "dae", "usda")


class InstallError(ValueError):
    """An invalid archive, unsafe destination, or recoverable installation error."""


class BoundedTarInfo(tarfile.TarInfo):
    """Bound hidden extension records before tarfile expands their metadata.

    The parser callback is available across supported Python versions. Ordinary
    member checks alone run too late for oversized PAX records or sparse maps.
    """

    def _proc_member(self, archive):
        if self.type == tarfile.GNUTYPE_SPARSE:
            raise InstallError("Sparse archive members are forbidden")
        if self.size < 0:
            raise InstallError("Negative archive member sizes are forbidden")
        extensions = (tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.SOLARIS_XHDTYPE,
                      tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK)
        if self.type in extensions:
            if self.size > MAX_JSON_BYTES:
                raise InstallError("Archive extension metadata exceeds the 64 KiB limit")
            if self.type in (tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.SOLARIS_XHDTYPE):
                position = archive.fileobj.tell()
                metadata = archive.fileobj.read(self.size)
                archive.fileobj.seek(position)
                if b"GNU.sparse." in metadata:
                    raise InstallError("Sparse archive metadata is forbidden")
        return super()._proc_member(archive)


@dataclass
class Package:
    files: dict[str, memoryview]
    site: dict
    total_bytes: int


@dataclass
class Result:
    target: Path
    backup: Path | None
    site_id: str | None
    file_count: int
    total_bytes: int
    dry_run: bool
    replacing: bool


def read_json(data: memoryview, label: str):
    """Reject ambiguous JSON without importing anything from the package."""
    if len(data) > MAX_JSON_BYTES:
        raise InstallError(f"{label} exceeds the 64 KiB metadata limit")

    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise InstallError(f"{label} contains a duplicate JSON key")
            value[key] = item
        return value

    def invalid_constant(_value):
        raise InstallError(f"{label} contains a non-finite JSON number")

    try:
        return json.loads(bytes(data).decode("utf-8"), object_pairs_hook=unique,
                          parse_constant=invalid_constant)
    except (UnicodeError, ValueError, RecursionError) as error:
        raise InstallError(f"Invalid {label}: {error}") from error


def valid_identifier(value):
    return isinstance(value, str) and IDENTIFIER.fullmatch(value) is not None


def validate_site(files, *, allow_site_features=False):
    site = read_json(files["site.json"], "site.json")
    expected = {"schema_version", "site_id", "default_floor", "floors", "site_features"}
    if (not isinstance(site, dict) or set(site) != expected
            or type(site["schema_version"]) is not int or site["schema_version"] != 1):
        raise InstallError("site.json must use the exact schema version 1")
    if type(site["site_features"]) is not bool:
        raise InstallError("site_features must be a JSON boolean")
    private = site["site_features"]
    if private and not allow_site_features:
        raise InstallError("Household-specific site_features require explicit --allow-site-features")
    if not valid_identifier(site["site_id"]) and not (private and site["site_id"] is None):
        raise InstallError("Generic packages require a valid site_id; only explicit private packages may use null")
    floors = site["floors"]
    if not isinstance(floors, dict) or not 1 <= len(floors) <= 8:
        raise InstallError("site.json must contain one to eight floors")
    stems = set()
    for floor_id, floor in floors.items():
        if (not valid_identifier(floor_id) or not isinstance(floor, dict)
                or set(floor) != {"stem", "title"} or not valid_identifier(floor["stem"])
                or not isinstance(floor["title"], str) or not floor["title"].strip()
                or len(floor["title"]) > 120
                or any(ord(c) < 32 or 127 <= ord(c) <= 159 or 0xD800 <= ord(c) <= 0xDFFF
                       for c in floor["title"])):
            raise InstallError("site.json contains invalid floor metadata")
        if floor["stem"] in stems:
            raise InstallError("site.json contains duplicate floor stems")
        stems.add(floor["stem"])
        names = ("index.html", "model-data.json") if private else FLOOR_FILES
        formats = ("glb", "obj", "mtl", "dae") if private else FLOOR_FORMATS
        required = {f"assets/{floor_id}/{name}" for name in names}
        required.update(f"assets/{floor_id}/{floor['stem']}.{ext}" for ext in formats)
        require_files(files, required)
    if not valid_identifier(site["default_floor"]) or site["default_floor"] not in floors:
        raise InstallError("site.json default_floor is not a declared floor")

    manifest = read_json(files["manifest.json"], "manifest.json")
    if (not isinstance(manifest, dict) or manifest.get("domain") != COMPONENT
            or not isinstance(manifest.get("version"), str) or not manifest["version"].strip()):
        raise InstallError("manifest.json must identify a versioned home_floorplan integration")
    disabled = {
        "curtains.json": {}, "motion-room.json": {},
        "room-activity.json": {"floor": site["default_floor"], "rooms": {}, "sources": [], "receivers": []},
        "assumed-activity.json": {"schema": "ruview.assumed-activity.config.v1",
                                  "coordinate_frame": site["site_id"], "geometry_assumed": False,
                                  "receivers": [], "zones": []},
    }
    for name, expected_value in disabled.items():
        if name not in files:
            continue
        value = read_json(files[name], name)
        if private:
            if not isinstance(value, dict):
                raise InstallError(f"{name} must contain a JSON object")
            continue
        if value != expected_value or (name == "assumed-activity.json" and value["geometry_assumed"] is not False):
            raise InstallError(f"{name} must contain the compiler's disabled generic configuration")
    return site


def require_files(files, required):
    missing = sorted(name for name in required if name not in files or not len(files[name]))
    if missing:
        raise InstallError("Missing or empty required package files: " + ", ".join(missing))


def member_path(member):
    name = member.name
    if member.isdir() and name.endswith("/"):
        name = name[:-1]
    parts = name.split("/")
    if (len(name) > MAX_PATH_BYTES or len(parts) > MAX_PATH_DEPTH
            or any(p in ("", ".", "..") or not SEGMENT.fullmatch(p)
                   or p.endswith(".") or WINDOWS_DEVICE.match(p) for p in parts)
            or parts[:2] != ["custom_components", COMPONENT]
            or (len(parts) == 2 and not member.isdir())):
        raise InstallError(f"Unsafe or out-of-component archive path: {member.name!r}")
    return "/".join(parts[2:])


def read_package(path: Path, *, allow_site_features=False) -> Package:
    """Validate the entire bounded archive in memory before filesystem writes.

    Retaining the validated bytes also prevents a changed archive from replacing
    data between validation and staging. Tar ownership, modes, links and extension
    attributes are never applied to the destination.
    """
    archive_limit = PRIVATE_MAX_ARCHIVE_BYTES if allow_site_features else MAX_ARCHIVE_BYTES
    tar_limit = PRIVATE_MAX_TAR_BYTES if allow_site_features else MAX_TAR_BYTES
    file_limit = PRIVATE_MAX_FILE_BYTES if allow_site_features else MAX_FILE_BYTES
    total_limit = PRIVATE_MAX_TOTAL_BYTES if allow_site_features else MAX_TOTAL_BYTES
    try:
        # O_NONBLOCK prevents an archive path pointing at a FIFO from hanging.
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
        with os.fdopen(descriptor, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise InstallError("The package must be a regular .tar.gz file")
            if info.st_size > archive_limit:
                raise InstallError(f"Compressed package exceeds the {archive_limit // MIB} MiB limit")
            # Bound the compressed snapshot too, including concurrent growth.
            compressed = source.read(archive_limit + 1)
            if len(compressed) > archive_limit:
                raise InstallError(f"Compressed package exceeds the {archive_limit // MIB} MiB limit")
        with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as zipped:
            raw = zipped.read(tar_limit + 1)
            if len(raw) > tar_limit:
                raise InstallError(f"Expanded tar exceeds the {tar_limit // MIB} MiB limit")
        del compressed
        files, members, paths, kinds = {}, set(), {}, {}
        total = 0
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:", tarinfo=BoundedTarInfo) as archive:
            for count, member in enumerate(archive, 1):
                if count > MAX_MEMBERS:
                    raise InstallError("Package exceeds the 2048-member limit")
                if (member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE)
                        or member.linkname or member.sparse is not None
                        or any("sparse" in key.lower() for key in member.pax_headers)):
                    raise InstallError("Archive entries must be regular files or directories; links and sparse files are forbidden")
                name = member_path(member)
                if name in members:
                    raise InstallError(f"Duplicate archive member: {name!r}")
                members.add(name)
                pieces = name.split("/") if name else []
                for i in range(1, len(pieces) + 1):
                    part = "/".join(pieces[:i])
                    alias = part.casefold()
                    if alias in paths and paths[alias] != part:
                        raise InstallError(f"Case-colliding archive paths: {part!r}")
                    paths[alias] = part
                    kind = "directory" if i < len(pieces) or member.isdir() else "file"
                    if part in kinds and kinds[part] != kind:
                        raise InstallError(f"Archive file/directory conflict: {part!r}")
                    kinds[part] = kind
                if member.size < 0 or member.size > file_limit:
                    raise InstallError(f"An archive member exceeds the {file_limit // MIB} MiB file limit")
                if member.isdir():
                    if member.size:
                        raise InstallError("Archive directories must have zero data size")
                    continue
                total += member.size
                if total > total_limit:
                    raise InstallError(f"Package files exceed the {total_limit // MIB} MiB total limit")
                end = member.offset_data + member.size
                if member.offset_data < 0 or end > len(raw):
                    raise InstallError("Truncated archive member")
                files[name] = memoryview(raw)[member.offset_data:end]
            # Reject truncated trailers, hidden concatenated tars and nonzero junk.
            trailer = memoryview(raw)[archive.offset:]
            if len(trailer) < 1024 or len(raw) % 512 or any(trailer):
                raise InstallError("Invalid tar trailer or trailing archive data")
        require_files(files, CORE_FILES)
        return Package(files, validate_site(files, allow_site_features=allow_site_features), total)
    except InstallError:
        raise
    except (OSError, EOFError, tarfile.TarError, zlib.error, ValueError, IndexError,
            KeyError, OverflowError, RecursionError) as error:
        raise InstallError(f"Cannot read package: {error}") from error


def check_directory(path: Path, *, missing_ok=False):
    """Check every existing ancestor without resolving away any symlinks."""
    chain = [*reversed(path.parents), path]
    for entry in chain:
        try:
            info = entry.lstat()
        except FileNotFoundError:
            if missing_ok:
                return
            raise InstallError(f"Required config directory does not exist: {path}") from None
        # Windows junctions are directory reparse points, not S_IFLNK entries.
        if (stat.S_ISLNK(info.st_mode)
                or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT):
            raise InstallError(f"Symlink or reparse-point destinations and ancestors are forbidden: {entry}")
        if not stat.S_ISDIR(info.st_mode):
            raise InstallError(f"Expected a directory: {entry}")


def config_path(value: Path) -> Path:
    value = value.expanduser()
    if ".." in value.parts:
        raise InstallError("Use a config path without '..' segments")
    path = value.absolute()
    check_directory(path)
    return path


def target_state(config: Path):
    check_directory(config)
    parent = config / "custom_components"
    target = parent / COMPONENT
    check_directory(parent, missing_ok=True)
    check_directory(target, missing_ok=True)
    return target, target.exists()


def install(archive: Path, config: Path, *, dry_run=False, replace=False,
            allow_site_features=False) -> Result:
    config = config_path(config)
    target, exists = target_state(config)
    identity = (target.stat().st_dev, target.stat().st_ino) if exists else None
    if exists and not replace:
        raise InstallError(f"Component already exists: {target}. Inspect it and pass --replace to retain a backup and update it")
    backup_root = config / ".home-studio-backups"
    if exists:
        check_directory(backup_root, missing_ok=True)
    package = read_package(archive, allow_site_features=allow_site_features)
    result = Result(target, None, package.site["site_id"], len(package.files),
                    package.total_bytes, dry_run, exists)
    if dry_run:
        return result

    stage = None
    made_parent = False
    made_backup_root = False
    backup = None
    moved_previous = False
    try:
        # Recheck after archive parsing, before creating anything in the config.
        _, current_exists = target_state(config)
        if current_exists != exists:
            raise InstallError("Component changed during validation; retry after other installers finish")
        stage = Path(tempfile.mkdtemp(prefix=".home-studio-install-", dir=config))
        for name, data in package.files.items():
            destination = stage / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            with destination.open("xb") as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            destination.chmod(0o644)
        for directory, _dirs, _files in os.walk(stage):
            Path(directory).chmod(0o755)
        _, current_exists = target_state(config)
        current_identity = (target.stat().st_dev, target.stat().st_ino) if current_exists else None
        if current_exists != exists or current_identity != identity:
            raise InstallError("Component changed during staging; retry after other installers finish")
        if not target.parent.exists():
            target.parent.mkdir(mode=0o755)
            made_parent = True
        if exists:
            check_directory(backup_root, missing_ok=True)
            if not backup_root.exists():
                backup_root.mkdir(mode=0o700)
                made_backup_root = True
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
            backup = backup_root / f"{COMPONENT}-{stamp}-{uuid.uuid4().hex}"
            os.replace(target, backup)
            moved_previous = True
        try:
            os.replace(stage, target)
        except BaseException as swap_error:
            if moved_previous:
                try:
                    os.replace(backup, target)
                    moved_previous = False
                except OSError as rollback_error:
                    raise InstallError(f"Install and rollback failed. Previous component is preserved at {backup}. "
                                       f"Install error: {swap_error}; rollback error: {rollback_error}") from swap_error
            raise
        stage = None
        result.backup = backup
        return result
    finally:
        if stage is not None:
            shutil.rmtree(stage)
        if made_parent and not target.exists():
            try:
                target.parent.rmdir()
            except OSError:
                pass
        if made_backup_root and not moved_previous:
            try:
                backup_root.rmdir()
            except OSError:
                pass


def print_result(result: Result):
    action = "Would replace" if result.replacing else "Would install"
    if not result.dry_run:
        action = "Replaced" if result.replacing else "Installed"
    print(f"{action}: {result.target}")
    print(f"Validated site {result.site_id or 'legacy household'}: {result.file_count} files, {result.total_bytes:,} bytes")
    if result.backup:
        print(f"Previous component backup: {result.backup}")
    elif result.dry_run and result.replacing:
        print(f"Replacement will retain a timestamped backup in: {result.target.parent.parent / '.home-studio-backups'}")
    if result.dry_run:
        print("Dry run complete. No files were created or changed.")
        print("After installation:")
    else:
        print("Next steps:")
    print(f"1. In {result.target.parent.parent / 'configuration.yaml'}, add this top-level entry once (keep an existing entry):")
    print("\n   home_floorplan:\n")
    print("2. Run the Home Assistant YAML configuration check (or ha core check on HAOS).")
    print("3. If the check succeeds, restart Home Assistant from Settings > System > Restart Home Assistant.")
    print("4. Sign in as an administrator and open 3D Home in the sidebar.")
    print("Configuration YAML and saved .storage data were not changed. Home Assistant was not restarted.")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("archive", type=Path, help="Trusted compiler-generated home-floorplan.tar.gz")
    parser.add_argument("--config", required=True, type=Path, help="Existing local Home Assistant config directory, with no symlink ancestors")
    parser.add_argument("--dry-run", action="store_true", help="Validate the complete package and destination without writing")
    parser.add_argument("--replace", action="store_true", help="Replace an existing component and retain a timestamped backup outside custom_components")
    parser.add_argument("--allow-site-features", action="store_true",
                        help="Explicitly allow trusted private household packages with camera, TV and sensing adapters (site_features=true, including legacy site_id=null), and bounded larger packages (128 MiB compressed, 512 MiB tar, 64 MiB/file, 384 MiB total)")
    args = parser.parse_args(argv)
    try:
        result = install(args.archive, args.config, dry_run=args.dry_run, replace=args.replace,
                         allow_site_features=args.allow_site_features)
    except (InstallError, OSError) as error:
        parser.exit(2, f"Installation failed: {error}\n")
    print_result(result)


if __name__ == "__main__":
    main()
