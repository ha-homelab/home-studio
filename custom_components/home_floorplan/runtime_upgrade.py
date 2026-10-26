"""Explicit, snapshot-bound upgrades of a known imported map renderer.

Call preview/apply under the integration's project lock after checking admin
access. Only a new baseline is prepared; ordinary publication activates it.
"""
import asyncio
import copy
import hashlib
import json
import re
import secrets
import shutil
import time
import uuid

from .baseline_transaction import commit_baseline, settle
from .generated import APPEARANCE, GeneratedProject, _ViewerScripts, _embedded, _hashes, _json, _merge_model, _point
from .native import NativeError, load_models

# Public map-layer.js at b4bd8de, excluding trailing whitespace. This is a
# compatibility fingerprint, not executable code or an arbitrary replacement.
LEGACY_SIZE = 18394
LEGACY_SHA256 = "3bc86903ee91040f08627688ce2860c633a71b6c6bb653991892d4073aa796d4"
HEADER = b"// Optional geographic context. All tiles share the viewer's scene and renderer."
MAX_TARGET_BYTES = 256 * 1024
MAX_IMPORTED_VIEWER_BYTES = 64 * 1024 * 1024
MAX_ASSET_BYTES = 512 * 1024 * 1024
MAX_ASSET_FILES = 4096


def _sha(value):
    return hashlib.sha256(value).hexdigest()


def _digest(value):
    return _sha(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode())


def _regular_bytes(path, maximum):
    if path.is_symlink() or path.parent.is_symlink() or not path.is_file():
        raise NativeError("unsupported_runtime", "The original viewer and installed runtime must be regular local files.")
    if path.stat().st_size > maximum:
        raise NativeError("unsupported_runtime", "The viewer runtime exceeds the supported upgrade size.")
    with path.open("rb") as stream:
        value = stream.read(maximum + 1)
    if len(value) > maximum:
        raise NativeError("unsupported_runtime", "The viewer runtime exceeds the supported upgrade size.")
    return value


def _asset_hashes(root):
    count = total = 0
    if root.is_symlink() or not root.is_dir():
        raise NativeError("source_changed", "The original viewer snapshot is unavailable.")
    for path in root.rglob("*"):
        if path.is_symlink() or not (path.is_dir() or path.is_file()):
            raise NativeError("source_changed", "The original viewer snapshot contains unsupported links or files.")
        if path.is_file():
            count += 1
            total += path.stat().st_size
            if count > MAX_ASSET_FILES or total > MAX_ASSET_BYTES:
                raise NativeError("unsupported_runtime", "The original viewer snapshot exceeds the upgrade size limit.")
    return _hashes(root)


def _target(native):
    value = _regular_bytes(native.component_root / "runtime" / "map-layer.js", MAX_TARGET_BYTES).rstrip()
    try:
        code = value.decode("utf-8")
    except UnicodeError as error:
        raise NativeError("unsupported_runtime", "The installed map renderer is invalid. Reinstall the current integration.") from error
    if (not value.startswith(HEADER) or value.count(HEADER) != 1 or
            len(re.findall(r"\bconst HOME_SITE_RENDER_STYLE_VERSION = 1;", code)) != 1 or
            "const homeMapMath = (() => {" not in code or "function createHomeMapLayer(" not in code or
            "</script" in code.lower()):
        raise NativeError("unsupported_runtime", "The installed integration has no supported map renderer upgrade.")
    return value


def _replace(html, target):
    """Require exact known bytes inside executable script, with no ambiguity."""
    try:
        text = html.decode("utf-8")
    except UnicodeError as error:
        raise NativeError("unsupported_runtime", "The original viewer is not valid UTF-8.") from error
    _embedded(text)
    if html.count(HEADER) != 1:
        raise NativeError("unsupported_runtime", "The original viewer has an unknown or ambiguous map renderer. Rebuild its original source.")
    start = html.index(HEADER)
    scripts = _ViewerScripts()
    scripts.feed(text)
    if html[start:start + len(target)] == target:
        candidate, version = target, 1
    else:
        candidate, version = html[start:start + LEGACY_SIZE], 0
        if len(candidate) != LEGACY_SIZE or _sha(candidate) != LEGACY_SHA256:
            raise NativeError("unsupported_runtime", "The original map renderer is not a recognized compatible version. Rebuild its original source.")
    if sum(part.count(candidate.decode("utf-8")) for part in scripts.parts) != 1:
        raise NativeError("unsupported_runtime", "The map renderer is not one executable script block.")
    result = html[:start] + target + html[start + len(candidate):]
    before, _ = _embedded(text)
    after, _ = _embedded(result.decode("utf-8"))
    if before.group(2) != after.group(2) or len(result) > MAX_IMPORTED_VIEWER_BYTES:
        raise NativeError("unsupported_runtime", "The runtime upgrade would change model data or exceed the viewer size limit.")
    return version, result


def _check_rooms(model, floor):
    rooms = {room["id"]: room for room in model["rooms"]}
    expected = {room["id"]: room for room in floor["rooms"]}
    if (len(rooms) != len(model["rooms"]) or rooms.keys() != expected.keys() or
            any([_point(point, model) for point in room["polygon"]] != expected[fid]["polygon"] or
                room.get("material", "deck" if fid in model.get("exterior_rooms", []) else "floor") != expected[fid]["material"]
                for fid, room in rooms.items())):
        raise NativeError("unsupported_rebase", "The published model and saved room geometry do not match. "
                          "Retain your private backup and reconcile the original source before upgrading.")


def _read(native, revision):
    if not isinstance(native, GeneratedProject):
        raise NativeError("unsupported", "Viewer runtime upgrades are available only for imported homes.")
    native.check_revision(revision)
    if not native.document.get("baseline"):
        raise NativeError("save_required", "Save the imported draft before previewing its viewer upgrade.")
    if not native.document.get("generation"):
        raise NativeError("publish_required", "This upgrade requires an existing published imported home. "
                          "Keep a private backup and export your draft; reconcile its original source before upgrading.")
    document = copy.deepcopy(native.document)
    native._validate(document["project"])
    if document["revision"] != document["published_revision"]:
        raise NativeError("unpublished_changes", "This upgrade requires the unchanged published draft. "
                          "Export your pending edits and retain your private backup before reconciling the original source. "
                          "Do not publish solely to bypass this check.")
    root = native.root / "baselines" / document["baseline"]
    source_bytes = _regular_bytes(root / "source.json", 4 * 1024 * 1024)
    metadata = json.loads(source_bytes)
    hashes = _asset_hashes(root / "assets")
    if hashes != metadata["hashes"] or hashes != native._source_hashes or metadata["project"] != native.baseline_project:
        raise NativeError("source_changed", "The original viewer snapshot changed. Reload its matching source before upgrading.")
    assets = native.root / document["generation"]
    active_hashes = _asset_hashes(assets)
    site = json.loads(_regular_bytes(assets / "site.json", 4 * 1024 * 1024))
    if (any(site.get(key) != metadata["site"].get(key) for key in
            ("schema_version", "site_id", "default_floor", "site_features")) or
            list(site["floors"]) != list(metadata["site"]["floors"]) or
            any(site["floors"][fid].get("stem") != value.get("stem") for fid, value in metadata["site"]["floors"].items())):
        raise NativeError("source_changed", "The published home no longer matches its original source. Retain its private backup and reconcile the source before upgrading.")
    target = _target(native)
    models, _ = load_models(assets, site["floors"])
    changes, versions = {}, set()
    for floor, original in zip(document["project"]["floors"], metadata["project"]["floors"]):
        rooms = lambda value: {room["id"]: [room["polygon"], room["material"]] for room in value["rooms"]}
        if (floor["walls"] or floor["openings"] or rooms(floor) != rooms(original) or
                floor["items"] != document["inventory"][floor["id"]]["items"]):
            raise NativeError("unsupported_rebase", "This home has added architecture or unmatched saved placements. "
                              "Keep its private backup and export the draft for original-source reconciliation before upgrading.")
        relative = floor["id"] + "/index.html"
        old = _regular_bytes(assets / relative, MAX_IMPORTED_VIEWER_BYTES)
        text = old.decode("utf-8")
        block, model = _embedded(text)
        baseline_text = _regular_bytes(root / "assets" / relative, MAX_IMPORTED_VIEWER_BYTES).decode("utf-8")
        baseline_block, _ = _embedded(baseline_text)
        if text[:block.start(2)] + text[block.end(2):] != baseline_text[:baseline_block.start(2)] + baseline_text[baseline_block.end(2):]:
            raise NativeError("unsupported_rebase", "The original and published viewers contain different executable code or markup. "
                              "Retain your private backup and reconcile the original source before upgrading.")
        _check_rooms(models[floor["id"]], floor)
        _check_rooms(model, floor)
        for active_model in (models[floor["id"]], model):
            expected = _merge_model(active_model, floor, original, None).get("control_anchors", {})
            if expected != active_model.get("control_anchors", {}):
                raise NativeError("unsupported_rebase", "The published control anchors no longer match the saved placements. "
                                  "Keep your private backup and reconcile the original source before upgrading.")
        references = {item["id"]: item for item in model.get("inventory", [])}
        if (len(references) != len(model.get("inventory", [])) or
                any(item["id"] not in references or
                    any(item.get(key) != references[item["id"]].get(key) for key in ("type", *APPEARANCE)) or
                    item.get("model_id") and item["id"] not in model.get("object_assets", {})
                    for item in floor["items"])):
            raise NativeError("unsupported_rebase", "The published viewer does not contain matching saved object references and appearances. "
                              "Retain your private backup and export the draft for original-source reconciliation before upgrading.")
        version, new = _replace(old, target)
        versions.add(version)
        if new != old:
            changes[relative] = new
    if versions == {1}:
        raise NativeError("runtime_current", "This published home already has the installed map renderer.")
    if versions != {0} or not changes:
        raise NativeError("unsupported_runtime", "The imported floors use different map renderer versions. Rebuild their matching original source.")
    signature = _digest({"document": document, "source": _sha(source_bytes), "hashes": hashes,
                         "active_hashes": active_hashes, "target": _sha(target)})
    return {"document": document, "metadata": {**metadata, "site": site, "project": copy.deepcopy(document["project"])},
            "original_hashes": hashes, "active_hashes": active_hashes, "assets": assets,
            "models": models, "source_bytes": source_bytes, "changes": changes,
            "signature": signature, "root": root, "target_hash": _sha(target)}


def _copy_baseline(native, snapshot):
    identifier = uuid.uuid4().hex
    target = native.root / "baselines" / identifier
    target.mkdir(mode=0o700)
    try:
        # Start empty: overlaying the old baseline could resurrect obsolete files.
        shutil.copytree(snapshot["assets"], target / "assets", symlinks=True)
        if (_asset_hashes(target / "assets") != snapshot["active_hashes"] or
                _asset_hashes(snapshot["assets"]) != snapshot["active_hashes"] or
                _asset_hashes(snapshot["root"] / "assets") != snapshot["original_hashes"] or
                (snapshot["root"] / "source.json").read_bytes() != snapshot["source_bytes"]):
            raise NativeError("source_changed", "The original viewer changed during the upgrade. The saved draft is unchanged.")
        expected = dict(snapshot["active_hashes"])
        for relative, contents in snapshot["changes"].items():
            (target / "assets" / relative).write_bytes(contents)
            expected[relative] = _sha(contents)
        if _asset_hashes(target / "assets") != expected:
            raise NativeError("source_changed", "The prepared runtime snapshot did not match its verified files.")
        metadata = {**snapshot["metadata"], "hashes": expected}
        receipt = {"schema": 1, "kind": "imported_map_runtime_upgrade", "previous_baseline": snapshot["document"]["baseline"],
                   "source_generation": snapshot["document"]["generation"],
                   "previous_baseline_hashes": snapshot["original_hashes"], "source_hashes": snapshot["active_hashes"],
                   "current_runtime": {"version": 0, "sha256": LEGACY_SHA256},
                   "target_runtime": {"version": 1, "sha256": snapshot["target_hash"]},
                   "files": {name: {"before": snapshot["active_hashes"][name], "after": expected[name]}
                             for name in snapshot["changes"]}}
        for name, value in (("source.json", metadata), ("previous-document.json", snapshot["document"]),
                            ("runtime-upgrade.json", receipt)):
            path = target / name
            with path.open("x", encoding="utf-8") as stream:
                stream.write(_json(value))
            path.chmod(0o600)
        return identifier, expected
    except BaseException:
        shutil.rmtree(target)
        raise


def _accept(native, snapshot, updated, hashes):
    native.document = updated
    native._source_hashes = hashes
    native._metadata(snapshot["metadata"]["project"], snapshot["models"])


class ImportedRuntimeUpgrade:
    """An explicit upgrade bound to one admin, adapter, revision and source."""

    def __init__(self):
        self.previews = {}

    async def preview(self, native, revision, owner, *, validate_current=None):
        if validate_current:
            validate_current()
        self.previews = {key: value for key, value in self.previews.items() if value["expires"] > time.monotonic()}
        snapshot = await native.hass.async_add_executor_job(_read, native, revision)
        if validate_current:
            validate_current()
        if native.document != snapshot["document"]:
            raise NativeError("conflict", "The draft changed while preparing the runtime upgrade. Preview it again.")
        token = secrets.token_urlsafe(32)
        self.previews = {key: value for key, value in self.previews.items() if value["owner"] != owner}
        if len(self.previews) >= 8:
            self.previews.pop(next(iter(self.previews)))
        self.previews[token] = {"owner": owner, "native": native, "revision": revision,
                                "signature": snapshot["signature"], "expires": time.monotonic() + 300}
        return {"token": token, "revision": revision, "current_runtime": {"version": 0, "sha256": LEGACY_SHA256},
                "target_runtime": {"version": 1, "sha256": snapshot["target_hash"]},
                "source": "published_generation", "source_file_count": len(snapshot["active_hashes"]),
                "files": list(snapshot["changes"]), "changed_file_count": len(snapshot["changes"])}

    async def apply(self, native, revision, owner, token, *, validate_current=None):
        if validate_current:
            validate_current()
        preview = self.previews.pop(token, None)
        if (not preview or preview["owner"] != owner or preview["native"] is not native or
                preview["revision"] != revision or preview["expires"] <= time.monotonic()):
            raise NativeError("stale_preview", "The runtime upgrade preview expired or belongs to another session. Preview it again.")
        snapshot = await native.hass.async_add_executor_job(_read, native, revision)
        if validate_current:
            validate_current()
        if snapshot["signature"] != preview["signature"]:
            raise NativeError("conflict", "The source, installed runtime or draft changed after preview. Preview the upgrade again.")
        copied, copy_cancelled = await settle(native.hass.async_add_executor_job(_copy_baseline, native, snapshot))
        identifier, hashes = copied
        try:
            if copy_cancelled:
                raise asyncio.CancelledError
            if native.document != snapshot["document"]:
                raise NativeError("conflict", "The draft changed during the runtime upgrade. Preview it again.")
            current = await native.hass.async_add_executor_job(_read, native, revision)
            if current["signature"] != snapshot["signature"] or native.document != snapshot["document"]:
                raise NativeError("source_changed", "The source changed during the runtime upgrade. Preview it again.")
            if validate_current:
                validate_current()
            updated = {**snapshot["document"], "baseline": identifier, "revision": revision + 1}
        except BaseException:
            await native.hass.async_add_executor_job(shutil.rmtree, native.root / "baselines" / identifier)
            raise
        await commit_baseline(native, snapshot["document"], updated, identifier,
                              lambda: _accept(native, snapshot, updated, hashes))
