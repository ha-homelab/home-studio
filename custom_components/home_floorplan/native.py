"""Private project storage and executor-based compilation for Home Studio."""
from __future__ import annotations

import copy
import importlib
import json
import logging
import mimetypes
from pathlib import Path
import re
import shutil
import uuid

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.storage import Store

from .permissions import model_references

_LOGGER = logging.getLogger(__name__)
MAX_PROJECT_BYTES = 2_000_000
MAX_NATIVE_TRIANGLES = 200_000
MAX_GENERATED_BYTES = 128 * 1024 * 1024
MAX_VIEWER_BYTES = 16 * 1024 * 1024
GENERATION = re.compile(r"[a-f0-9]{32}\Z")
EDITOR_URL = "/home-floorplan-studio/planner/index.html"


class NativeError(ValueError):
    """An actionable native editing failure."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class NativeStore(Store):
    """Require a completed write before acknowledging a project transaction."""

    async def async_save(self, data):
        # Store normally defers saves during shutdown and silently accepts
        # read-only saves. Neither outcome is a committed editor transaction.
        if self.hass.is_stopping or self._read_only:
            raise NativeError("save_failed", "Home Studio storage is not writable. Your previous saved project remains available.")
        await super().async_save(data)

    async def _async_write_data(self, data):
        # Store._async_handle_write_data logs and swallows WriteError and
        # SerializationError. Translate at its write hook so callers can keep
        # their previous document and generation, while retaining HA's atomic
        # writer, locking, cache invalidation, and storage envelope.
        try:
            await super()._async_write_data(data)
        except (HomeAssistantError, OSError) as error:
            raise NativeError("save_failed", "The project could not be saved. Your previous saved project remains available.") from error


def compiler():
    """Import the bundled namespace without modifying process-wide import paths."""
    try:
        return importlib.import_module(".runtime.planner.project", __package__)
    except ModuleNotFoundError as error:
        if error.name and error.name.startswith(__package__ + ".runtime"):
            raise NativeError("unsupported", "Install the complete Home Studio integration to edit projects in Home Assistant.") from error
        raise


def bounded_project(project):
    """Reject deeply nested, oversized and non-JSON input before the compiler."""
    pending, nodes = [(project, 0)], 0
    while pending:
        value, depth = pending.pop()
        nodes += 1
        if depth > 12 or nodes > 100_000:
            raise NativeError("invalid_project", "Project structure exceeds the supported limit.")
        if isinstance(value, dict):
            if any(not isinstance(key, str) for key in value):
                raise NativeError("invalid_project", "Project keys must be strings.")
            pending.extend((item, depth + 1) for item in value.values())
        elif isinstance(value, list):
            pending.extend((item, depth + 1) for item in value)
    try:
        encoded = json.dumps(project, allow_nan=False, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except (ValueError, TypeError, UnicodeError, RecursionError) as error:
        raise NativeError("invalid_project", "Project must contain valid finite JSON values.") from error
    if len(encoded) > MAX_PROJECT_BYTES:
        raise NativeError("invalid_project", "Project exceeds the 2 MB limit.")
    return project


def validate_draft(project):
    bounded_project(project)
    try:
        return compiler().validate_project(project, complete=False)
    except ValueError as error:
        raise NativeError("invalid_project", str(error)) from error


def load_models(assets, floors):
    """Read and index a generation together before it can become active."""
    models = {floor: json.loads((assets / floor / "model-data.json").read_text(encoding="utf-8"))
              for floor in floors}
    references = model_references(models)
    if set(references) != set(models):
        raise RuntimeError("The model reference index does not match the loaded floors.")
    return models, references


def build_generation(project, root, generation):
    """Produce a complete immutable generation in private HA configuration storage."""
    runtime = compiler()
    runtime.validate_project(project)
    triangles = 0
    for floor in project["floors"]:
        triangles += len(floor["walls"]) * 60 + len(floor["openings"]) * 48
        triangles += sum(len(room["polygon"]) * 4 for room in floor["rooms"])
        if triangles > MAX_NATIVE_TRIANGLES:
            raise NativeError("invalid_project", "This project exceeds the native geometry budget.")
        for item in floor["items"]:
            if item.get("model_id"):
                asset = runtime.build_furniture_asset(item)
                triangles += sum(len(mesh["indices"]) // 3 for mesh in asset["meshes"])
            else:
                triangles += 12
            if triangles > MAX_NATIVE_TRIANGLES:
                raise NativeError("invalid_project", "This project exceeds the native geometry budget. Reduce detailed furniture before publishing.")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = root / generation
    try:
        runtime.compile_project(project, target)
        files = [path for path in target.rglob("*") if path.is_file()]
        if sum(path.stat().st_size for path in files) > MAX_GENERATED_BYTES or any(
                path.name == "index.html" and path.stat().st_size > MAX_VIEWER_BYTES for path in files):
            raise NativeError("invalid_project", "The generated plan exceeds the native size budget. Reduce its geometry before publishing.")
        target.chmod(0o700)
        site = json.loads((target / "site.json").read_text(encoding="utf-8"))
        models, references = load_models(target, site["floors"])
        return site, models, references
    except Exception:
        if target.exists():
            shutil.rmtree(target)
        raise


def load_generation(root, generation):
    """Only a server-created opaque generation can select a private directory."""
    if not isinstance(generation, str) or not GENERATION.fullmatch(generation):
        raise NativeError("invalid_storage", "Invalid stored project generation.")
    target = root / generation
    from .site import load_site
    site = load_site(target)
    models, references = load_models(target, site["floors"])
    return target, site, models, references


class NativeProject:
    """Commit source and active generation together using HA's atomic private Store."""

    def __init__(self, hass, root=None):
        self.hass = hass
        self.root = Path(root) if root is not None else Path(hass.config.path(".storage", "home_floorplan_studio_assets"))
        # Earlier native builds nested assets under home_floorplan, but that
        # name is also a regular Store file in older installations. New writes
        # use a distinct directory; existing native generations remain readable.
        self.legacy_root = Path(hass.config.path(".storage", "home_floorplan", "studio")) if root is None else None
        self.store = NativeStore(hass, 1, "home_floorplan.studio", private=True, atomic_writes=True)
        self.document = {"revision": 0, "project": None, "published_revision": None,
                         "generation": None, "inventory": {}}

    async def load(self):
        saved = await self.store.async_load()
        if saved is not None:
            if (not isinstance(saved, dict) or set(saved) != set(self.document)
                    or type(saved["revision"]) is not int or saved["revision"] < 0
                    or (saved["published_revision"] is not None and
                        (type(saved["published_revision"]) is not int or not 0 <= saved["published_revision"] <= saved["revision"]))
                    or not isinstance(saved["inventory"], dict)):
                raise NativeError("invalid_storage", "Stored project is invalid; restore its private backup before editing.")
            if saved["project"] is not None:
                await self.hass.async_add_executor_job(validate_draft, saved["project"])
            if (saved["generation"] is None) != (saved["published_revision"] is None):
                raise NativeError("invalid_storage", "Stored publication metadata is inconsistent.")
            if saved["generation"] is not None and saved["project"] is None:
                raise NativeError("invalid_storage", "Stored publication is missing its source project.")
            self.document = saved
        if self.document["generation"] is not None:
            return await self.hass.async_add_executor_job(self._load_generation)
        return None

    def _load_generation(self):
        generation = self.document["generation"]
        if (isinstance(generation, str) and GENERATION.fullmatch(generation)
                and not (self.root / generation).exists() and self.legacy_root is not None
                and (self.legacy_root / generation).is_dir()):
            return load_generation(self.legacy_root, generation)
        return load_generation(self.root, generation)

    def check_revision(self, revision):
        if type(revision) is not int or revision != self.document["revision"]:
            raise NativeError("conflict", "Another browser saved this project. Export your draft, reload, and merge your changes.")

    async def save(self, revision, project):
        self.check_revision(revision)
        validated = await self.hass.async_add_executor_job(validate_draft, project)
        updated = {**self.document, "revision": revision + 1, "project": validated}
        await self.store.async_save(updated)
        self.document = updated

    async def save_inventory(self, inventory):
        if self.document["revision"] != self.document["published_revision"]:
            raise NativeError("conflict", "This project has unpublished edits. Finish them in Home Studio before editing placements here.")
        project = copy.deepcopy(self.document["project"])
        for floor in project["floors"]:
            floor["items"] = copy.deepcopy(inventory[floor["id"]]["items"])
        await self.hass.async_add_executor_job(validate_draft, project)
        revision = self.document["revision"] + 1
        updated = {**self.document, "inventory": inventory, "project": project,
                   "revision": revision, "published_revision": revision}
        await self.store.async_save(updated)
        self.document = updated

    async def publish(self, revision):
        self.check_revision(revision)
        if self.document["project"] is None:
            raise NativeError("invalid_project", "Save a project before publishing it.")
        generation = uuid.uuid4().hex
        try:
            site, models, references = await self.hass.async_add_executor_job(
                build_generation, self.document["project"], self.root, generation)
        except NativeError:
            raise
        except ValueError as error:
            raise NativeError("invalid_project", str(error)) from error
        except Exception as error:
            _LOGGER.exception("Home Studio compilation failed; the previous plan remains active")
            raise NativeError("build_failed", "The project could not be built. The previous published plan is still active.") from error
        # Every publication has at least one floor. Carry the highest prior
        # revision onto every new floor so removal and recreation cannot reuse
        # a token held by an old viewer, including after repeated publication.
        inventory_revision = max(revision, max(
            (value["revision"] for value in self.document["inventory"].values()), default=0) + 1)
        inventory = {floor: {"revision": inventory_revision,
                             "items": copy.deepcopy(model.get("inventory", []))}
                     for floor, model in models.items()}
        updated = {**self.document, "generation": generation, "published_revision": revision, "inventory": inventory}
        try:
            await self.store.async_save(updated)
        except Exception:
            await self.hass.async_add_executor_job(shutil.rmtree, self.root / generation)
            raise
        old_generation = self.document["generation"]
        self.document = updated
        # Keep the previous generation available to any viewer request already reading it.
        try:
            await self.hass.async_add_executor_job(self._cleanup, {generation, old_generation})
        except OSError:
            _LOGGER.warning("Could not clean up old Home Studio generations")
        return self.root / generation, site, models, inventory, references

    def _cleanup(self, keep):
        for path in self.root.iterdir():
            if GENERATION.fullmatch(path.name) and path.name not in keep and path.is_dir() and not path.is_symlink():
                try:
                    shutil.rmtree(path)
                except OSError:
                    _LOGGER.warning("Could not remove an unused Home Studio generation")


class StudioAssetsView(HomeAssistantView):
    """Expose only reviewed editor resources, with CORS for an opaque sandbox."""

    url = "/home-floorplan-studio/{filename:.*}"
    name = "api:home_floorplan:studio_assets"
    requires_auth = False

    def __init__(self, files):
        self.files = files

    async def get(self, request, filename):
        path = self.files.get(filename)
        if path is None:
            raise web.HTTPNotFound()
        response = web.FileResponse(path)
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "no-cache"
        response.content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        return response


def studio_asset_files(component_root):
    """Load a build-time map; URL input is never treated as a filesystem path."""
    index = component_root / "studio-files.json"
    if not index.is_file():
        return {}
    names = json.loads(index.read_text(encoding="utf-8"))
    root = component_root / "static" / "studio"
    files = {}
    for name in names:
        if not isinstance(name, str):
            raise ValueError("Invalid bundled editor resource")
        path = root / name
        if (".." in Path(name).parts or Path(name).is_absolute()
                or not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(root.resolve())):
            raise ValueError("Invalid bundled editor resource")
        files[name] = path
    return files
