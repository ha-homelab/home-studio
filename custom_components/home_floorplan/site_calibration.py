"""Snapshot-bound, explicit calibration; original assets remain immutable.

Call preview/apply while holding the integration project lock. A transaction
creates a metadata baseline and keeps the old Store document beside it.
"""
import asyncio
import copy
import hashlib
import json
import secrets
import shutil
import time
import uuid

from .baseline_transaction import commit_baseline, settle
from .generated import GeneratedProject, _embedded, _hashes, _json
from .native import NativeError, load_models, validate_draft
from .site_frame import propose_site_frame


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _read(native, revision):
    if not isinstance(native, GeneratedProject):
        raise NativeError("unsupported", "Site-frame calibration is available only for imported homes.")
    native.check_revision(revision)
    if not native.document.get("baseline"):
        raise NativeError("save_required", "Save the imported draft before previewing site-frame calibration.")
    document = copy.deepcopy(native.document)
    native._validate(document["project"])
    root = native.root / "baselines" / document["baseline"]
    source = root / "source.json"
    if root.is_symlink() or source.is_symlink() or not source.is_file():
        raise NativeError("source_changed", "The original home snapshot is unavailable. Restore its private backup.")
    source_bytes = source.read_bytes()
    metadata = json.loads(source_bytes)
    hashes = _hashes(root / "assets")
    if (hashes != metadata["hashes"] or hashes != native._source_hashes or
            metadata["project"] != native.baseline_project or
            document["generation"] is None and _hashes(native.component_root / "assets") != hashes):
        raise NativeError("source_changed", "The original home snapshot changed. Reload its matching source before calibration.")
    models, _ = load_models(root / "assets", metadata["site"]["floors"])
    embedded = {fid: _embedded((root / "assets" / fid / "index.html").read_text(encoding="utf-8"))[1]
                for fid in models}
    try:
        project, baseline_project, offsets = propose_site_frame(document["project"], metadata["project"], models, embedded)
        project, baseline_project = validate_draft(project), validate_draft(baseline_project)
    except ValueError as error:
        raise NativeError("invalid_site_frame", str(error)) from error
    signature = _digest({"document": document, "source": hashlib.sha256(source_bytes).hexdigest(), "hashes": hashes})
    return {"document": document, "metadata": metadata, "models": models, "source_bytes": source_bytes,
            "project": project, "baseline_project": baseline_project, "offsets": offsets,
            "signature": signature, "root": root}


def _copy_baseline(native, snapshot):
    identifier = uuid.uuid4().hex
    target = native.root / "baselines" / identifier
    target.mkdir(mode=0o700)
    try:
        shutil.copytree(snapshot["root"] / "assets", target / "assets", symlinks=True)
        if (_hashes(target / "assets") != snapshot["metadata"]["hashes"] or
                _hashes(snapshot["root"] / "assets") != snapshot["metadata"]["hashes"] or
                (snapshot["root"] / "source.json").read_bytes() != snapshot["source_bytes"]):
            raise NativeError("source_changed", "The source changed during calibration. The saved draft is unchanged.")
        metadata = {**snapshot["metadata"], "project": snapshot["baseline_project"]}
        for name, value in (("source.json", metadata), ("previous-document.json", snapshot["document"])):
            path = target / name
            with path.open("x", encoding="utf-8") as stream:
                stream.write(_json(value))
            path.chmod(0o600)
        return identifier
    except BaseException:
        shutil.rmtree(target)
        raise


class SiteCalibration:
    """Short-lived previews bound to an administrator and native adapter."""

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
            raise NativeError("conflict", "The draft changed while preparing calibration. Preview it again.")
        token = secrets.token_urlsafe(32)
        self.previews = {key: value for key, value in self.previews.items() if value["owner"] != owner}
        if len(self.previews) >= 8:
            self.previews.pop(next(iter(self.previews)))
        self.previews[token] = {"owner": owner, "native": native, "signature": snapshot["signature"],
                                "revision": revision, "expires": time.monotonic() + 300}
        return {"token": token, "revision": revision, "global_ground_m": 0, "floors": snapshot["offsets"]}

    async def apply(self, native, revision, owner, token, *, validate_current=None):
        if validate_current:
            validate_current()
        preview = self.previews.pop(token, None)
        if (not preview or preview["owner"] != owner or preview["native"] is not native or
                preview["revision"] != revision or preview["expires"] <= time.monotonic()):
            raise NativeError("stale_preview", "The calibration preview expired or belongs to another session. Preview it again.")
        snapshot = await native.hass.async_add_executor_job(_read, native, revision)
        if validate_current:
            validate_current()
        if snapshot["signature"] != preview["signature"]:
            raise NativeError("conflict", "The source or saved draft changed after preview. Preview calibration again.")
        identifier, cancelled = await settle(native.hass.async_add_executor_job(_copy_baseline, native, snapshot))
        try:
            if cancelled:
                raise asyncio.CancelledError
            if native.document != snapshot["document"]:
                raise NativeError("conflict", "The saved draft changed during calibration. Preview it again.")
            current = await native.hass.async_add_executor_job(_read, native, revision)
            if current["signature"] != snapshot["signature"] or native.document != snapshot["document"]:
                raise NativeError("source_changed", "The original home changed during calibration. Preview it again.")
            if validate_current:
                validate_current()
            updated = {**snapshot["document"], "project": snapshot["project"],
                       "baseline": identifier, "revision": revision + 1}
        except BaseException:
            await native.hass.async_add_executor_job(shutil.rmtree, native.root / "baselines" / identifier)
            raise
        def accept():
            native.document = updated
            native._metadata(snapshot["baseline_project"], snapshot["models"])
        await commit_baseline(native, snapshot["document"], updated, identifier, accept)
