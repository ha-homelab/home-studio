"""Authenticated Home Assistant floorplan viewing and local authoring."""

import asyncio
import base64
import copy
import json
import logging
from functools import wraps
from pathlib import Path

import voluptuous as vol
from homeassistant.components import frontend, panel_custom, websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import Context
from homeassistant.helpers import area_registry, device_registry, entity_registry, floor_registry
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .validation import validate_inventory
from .site import load_site, prepare_inventory, repair_inventory
from .curtains import async_setup_curtains, PROFILES, BOOT_SECONDS, is_motor_available, read_reported_position
from .native import NativeError, NativeProject, StudioAssetsView, EDITOR_URL, studio_asset_files, load_models
from .generated import GeneratedProject
from .permissions import can_read, can_control, floor_entities, model_references, vacuum_source_bindings

DOMAIN = "home_floorplan"
_LOGGER = logging.getLogger(__name__)
ROOT = Path(__file__).parent
VERSION = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]
LOCAL_SITE = None
try:
    from .private_site_config import SITE as LOCAL_SITE
except ModuleNotFoundError as error:
    if error.name != __package__ + ".private_site_config":
        raise
SITE = load_site(ROOT, LOCAL_SITE, allow_empty=True)
if SITE["site_features"]:
    from . import private_site as SITE_ADAPTER
FLOORS = {key: floor["stem"] for key, floor in SITE["floors"].items()}
STORE_KEY = DOMAIN if SITE["site_id"] is None else DOMAIN + "." + SITE["site_id"]
FORMATS = ("glb", "usdz", "obj", "mtl", "dae")
CONFIG_SCHEMA = vol.Schema({DOMAIN: SITE_ADAPTER.CONFIG_SCHEMA if SITE["site_features"] else vol.Schema({})}, extra=vol.ALLOW_EXTRA)


def _apply_active(state, assets, site, models, data, references):
    if set(references) != set(models) or set(models) != set(site["floors"]):
        raise RuntimeError("The model reference index does not match the active floors.")
    state.update(assets=assets, site=site, models=models, data=data, model_entities=references,
                 rooms={floor: {room["id"] for room in model["rooms"]} for floor, model in models.items()})


def _read_open_file(stream):
    """Finish an asset read and close its pinned file in the executor."""
    with stream:
        return stream.read()


async def async_setup(hass, config):
    """Load a private native project or an explicitly installed legacy package."""
    if DOMAIN in hass.data:
        if hass.data[DOMAIN].get("initialized"):
            return True
        return await _finish_setup(hass, hass.data[DOMAIN])
    if SITE["site_features"]:
        await SITE_ADAPTER.async_prepare(hass, config)
    state = {"lock": asyncio.Lock(), "recovery": None, "native": None, "config": config, "initialized": False}
    if SITE["floors"]:
        store = Store(hass, 1, STORE_KEY, private=True, atomic_writes=True)
        saved = await store.async_load()
        models, references = await hass.async_add_executor_job(load_models, ROOT / "assets", FLOORS)
        rooms = {floor: {room["id"] for room in model["rooms"]} for floor, model in models.items()}
        if SITE["site_id"]:
            data, recovery = prepare_inventory({} if saved is None else saved, models, rooms, SITE["site_id"], validate_inventory)
        else:
            data = {floor: value for floor, value in (saved or {}).items() if floor in FLOORS}
            for floor in FLOORS:
                data.setdefault(floor, {"revision": 0, "items": []})
                validate_inventory(data[floor]["items"], rooms[floor])
            recovery = None
        state.update(store=store, recovery=recovery)
        _apply_active(state, ROOT / "assets", SITE, models, data, references)
        # Thin generated packages remain valid viewers. Only complete Studio
        # installations offer the preservation adapter and its bundled compiler.
        editor_files = await hass.async_add_executor_job(studio_asset_files, ROOT)
        if editor_files and (ROOT / "runtime" / "planner" / "project.py").is_file() and not recovery:
            generated = GeneratedProject(hass, ROOT, SITE, models, data)
            try:
                active = await generated.load()
            except (NativeError, OSError, ValueError, KeyError, TypeError):
                _LOGGER.exception("Generated home authoring could not be loaded; the installed viewer is unchanged")
                state["source_error"] = "The installed home could not be opened for editing. Its existing view is preserved; check the integration log and restore its matching private source if needed."
            else:
                state["native"] = generated
                if active:
                    assets, site, models, references = active
                    _apply_active(state, assets, site, models, generated.document["inventory"], references)
                else:
                    _apply_active(state, ROOT / "assets", SITE, models, data, generated.references)
    else:
        native = NativeProject(hass)
        active = await native.load()
        state["native"] = native
        if active:
            assets, site, models, references = active
            rooms = {floor: {room["id"] for room in model["rooms"]} for floor, model in models.items()}
            data, recovery = prepare_inventory(native.document["inventory"], models, rooms, site["site_id"], validate_inventory)
            state["recovery"] = recovery
            _apply_active(state, assets, site, models, data, references)
        else:
            _apply_active(state, None, SITE, {}, {}, model_references({}))
    hass.data[DOMAIN] = state
    return await _finish_setup(hass, state)


async def _finish_setup(hass, state):
    """Retry every incomplete stage without duplicating successful setup."""
    async with state.setdefault("setup_lock", asyncio.Lock()):
        if state.get("initialized"):
            return True
        if "curtains" not in state:
            state["curtains"] = await async_setup_curtains(hass, STORE_KEY + ".curtains")
        if SITE["site_features"] and not state.get("site_registered"):
            await SITE_ADAPTER.async_setup(hass, state["config"])
            state["site_registered"] = True
        if not state.get("static_registered"):
            await hass.http.async_register_static_paths([
                StaticPathConfig("/home-floorplan-static", str(ROOT / "static"), cache_headers=False)
            ])
            state["static_registered"] = True
        asset_files = await hass.async_add_executor_job(studio_asset_files, ROOT)
        if asset_files and not state.get("editor_registered"):
            hass.http.register_view(StudioAssetsView(asset_files))
            state["editor_registered"] = True
        if asset_files and state["native"] and not state.get("ai_registered"):
            from .ai import NativeAI, NativeAIView
            if "ai" not in state:
                state["ai"] = NativeAI(hass)
            hass.http.register_view(NativeAIView(state["ai"]))
            state["ai_registered"] = True
        if not state.get("ws_registered"):
            for handler in (ws_status, ws_viewer, ws_save, ws_recover, ws_export, ws_curtains, ws_curtain_command,
                            ws_project_get, ws_project_save, ws_project_publish, ws_entity_catalog):
                websocket_api.async_register_command(hass, handler)
            state["ws_registered"] = True
        await _register_panels(hass, bool(asset_files))
        state["has_editor"] = bool(asset_files)
        state["initialized"] = True
        return True


async def _register_panels(hass, has_editor):
    frontend.async_remove_panel(hass, "home-floorplan", warn_if_unknown=False)
    frontend.async_remove_panel(hass, "home-studio", warn_if_unknown=False)
    await panel_custom.async_register_panel(
        hass, "home-floorplan", "home-floorplan-panel",
        sidebar_title="3D Home", sidebar_icon="mdi:floor-plan",
        module_url=f"/home-floorplan-static/panel.js?v={VERSION}", require_admin=False)
    if has_editor:
        await panel_custom.async_register_panel(
            hass, "home-studio", "home-floorplan-studio-panel", sidebar_title="Home Studio",
            sidebar_icon="mdi:floor-plan", module_url=f"/home-floorplan-static/studio.js?v={VERSION}",
            require_admin=True)


async def async_setup_entry(hass, entry):
    if DOMAIN not in hass.data or not hass.data[DOMAIN].get("initialized"):
        return await async_setup(hass, {})
    if hass.data[DOMAIN].pop("panels_unloaded", False):
        await _register_panels(hass, hass.data[DOMAIN]["has_editor"])
    return True


async def async_unload_entry(hass, entry):
    """Remove navigation; preserve private state and shared YAML registrations."""
    if DOMAIN not in hass.data or DOMAIN in hass.data[DOMAIN]["config"]:
        return True
    frontend.async_remove_panel(hass, "home-floorplan", warn_if_unknown=False)
    if hass.data[DOMAIN]["has_editor"]:
        frontend.async_remove_panel(hass, "home-studio", warn_if_unknown=False)
    hass.data[DOMAIN]["panels_unloaded"] = True
    if ai := hass.data[DOMAIN].get("ai"):
        ai.clear()
    return True


def _status_snapshot(state):
    """Pin publication facts without retaining any user's permission decisions."""
    native = state["native"]
    snapshot = {"mode": getattr(native, "mode", "native") if native else "legacy",
                "has_editor": bool(state.get("has_editor")),
                "default_floor": state["site"]["default_floor"],
                "references": {floor: frozenset(floor_entities(state, floor, PROFILES))
                               for floor in state["site"]["floors"]}}
    if native:
        snapshot.update(revision=native.document["revision"], published_revision=native.document["published_revision"])
    return snapshot


def _status_from_snapshot(snapshot, connection):
    """Filter pinned publication facts using the connection's current permissions."""
    admin = bool(connection.user and connection.user.is_admin)
    floors = [floor for floor, references in snapshot["references"].items()
              if all(can_read(connection, entity_id) for entity_id in references)]
    default_floor = snapshot["default_floor"]
    if default_floor not in floors:
        default_floor = floors[0] if floors else None
    result = {"mode": snapshot["mode"], "can_edit": admin,
              "has_editor": snapshot["has_editor"], "has_published": bool(floors),
              "floors": floors, "default_floor": default_floor}
    if snapshot["mode"] in ("native", "generated") and admin:
        result.update(revision=snapshot["revision"], published_revision=snapshot["published_revision"])
    return result


def _status(state, connection):
    return _status_from_snapshot(_status_snapshot(state), connection)


def _project_result(state, connection):
    native = state["native"]
    return {**_status(state, connection), "project": copy.deepcopy(native.document["project"]) if native else None,
            "revision": native.document["revision"] if native else 0,
            "published_revision": native.document["published_revision"] if native else None,
            "has_saved_draft": bool(native and (native.document["baseline"] is not None
                                                if isinstance(native, GeneratedProject)
                                                else native.document["project"] is not None)),
            "source": copy.deepcopy(getattr(native, "source", None)),
            "source_error": state.get("source_error"),
            "editor_url": EDITOR_URL, "capabilities": {
                "authoring": bool(native),
                "architecture_editing": bool(native and not isinstance(native, GeneratedProject)),
                "ai": bool(native and state.get("ai_registered") and state.get("initialized")
                           and not state.get("panels_unloaded") and connection.user and connection.user.is_admin)}}


def _capabilities(connection, references):
    readable = {entity_id for entity_id in references if can_read(connection, entity_id)}
    if can_read(connection, "sun.sun"):
        readable.add("sun.sun")
    return {"readable_entities": sorted(readable),
            "controllable_entities": sorted(entity_id for entity_id in references if can_control(connection, entity_id))}


def _floor(state, msg, connection):
    floor = msg.get("floor") or state["site"]["default_floor"]
    if floor not in state["site"]["floors"]:
        connection.send_error(msg["id"], "not_found", "This floor is not in the published project.")
        return None
    return floor


async def _persist_inventory(state, updated):
    native = state["native"]
    if isinstance(native, GeneratedProject) and native.document["generation"] is None:
        document = await native.hass.async_add_executor_job(native.prepare_legacy_inventory, updated)
        await state["store"].async_save(updated)
        native.accept_legacy_inventory(document)
    elif native:
        await native.save_inventory(updated)
    else:
        await state["store"].async_save(updated)
    state["data"] = updated
    state["curtains"]["capture"]()


def _when_active(handler):
    """Keep registered routes inert while a config entry is unloaded or setup failed."""
    @wraps(handler)
    def guarded(hass, connection, msg):
        state = hass.data.get(DOMAIN)
        if state is None or state.get("panels_unloaded") or not state.get("initialized", True):
            connection.send_error(msg["id"], "not_loaded", "Home Studio is not currently loaded.")
            return None
        return handler(hass, connection, msg)
    return guarded


@websocket_api.websocket_command({vol.Required("type"): "home_floorplan/status"})
@_when_active
def ws_status(hass, connection, msg):
    connection.send_result(msg["id"], _status(hass.data[DOMAIN], connection))


@websocket_api.websocket_command({vol.Required("type"): "home_floorplan/project_get"})
@_when_active
@websocket_api.require_admin
def ws_project_get(hass, connection, msg):
    connection.send_result(msg["id"], _project_result(hass.data[DOMAIN], connection))


@websocket_api.websocket_command({vol.Required("type"): "home_floorplan/project_save",
                                 vol.Required("revision"): cv.positive_int, vol.Required("project"): dict})
@_when_active
@websocket_api.require_admin
@websocket_api.async_response
async def ws_project_save(hass, connection, msg):
    state = hass.data[DOMAIN]
    if not state["native"]:
        connection.send_error(msg["id"], "unsupported", state.get("source_error") or "Install the complete Home Studio integration to edit this home in Home Assistant.")
        return
    try:
        async with state["lock"]:
            await state["native"].save(msg["revision"], msg["project"])
            connection.send_result(msg["id"], _project_result(state, connection))
    except NativeError as error:
        connection.send_error(msg["id"], error.code, str(error))
    except OSError:
        connection.send_error(msg["id"], "save_failed", "The project could not be saved. Your previous saved project remains active.")


@websocket_api.websocket_command({vol.Required("type"): "home_floorplan/project_publish", vol.Required("revision"): cv.positive_int})
@_when_active
@websocket_api.require_admin
@websocket_api.async_response
async def ws_project_publish(hass, connection, msg):
    state = hass.data[DOMAIN]
    if not state["native"]:
        connection.send_error(msg["id"], "unsupported", state.get("source_error") or "Install the complete Home Studio integration to publish edits in Home Assistant.")
        return
    try:
        async with state["lock"]:
            assets, site, models, data, references = await state["native"].publish(msg["revision"])
            _apply_active(state, assets, site, models, data, references)
            state["recovery"] = None
            state["curtains"]["capture"]()
            connection.send_result(msg["id"], _project_result(state, connection))
    except NativeError as error:
        connection.send_error(msg["id"], error.code, str(error))
    except OSError:
        connection.send_error(msg["id"], "save_failed", "Publication could not be saved. The previous plan remains active.")


@websocket_api.websocket_command({vol.Required("type"): "home_floorplan/entity_catalog"})
@_when_active
@websocket_api.require_admin
def ws_entity_catalog(hass, connection, msg):
    """Return bounded names, relationships and display hints, never raw state data."""
    areas = area_registry.async_get(hass)
    devices = device_registry.async_get(hass)
    entities = entity_registry.async_get(hass)
    floors = floor_registry.async_get(hass)
    current_states = hass.states.async_all()
    if len(entities.entities) > 20_000 or len(devices.devices) > 5_000 or len(current_states) > 20_000:
        connection.send_error(msg["id"], "catalog_too_large", "The entity catalog exceeds the supported limit.")
        return
    result = {"floors": [{"id": item.floor_id, "name": item.name, "level": item.level} for item in floors.async_list_floors()],
              "areas": [{"id": item.id, "name": item.name, "floor_id": item.floor_id} for item in areas.async_list_areas()],
              "devices": [{"id": item.id, "name": item.name_by_user or item.name or item.id, "area_id": item.area_id}
                          for item in devices.devices], "entities": []}
    def display_hints(current, entity=None):
        device_class = (getattr(entity, "device_class", None)
                        or (current.attributes.get("device_class") if current else None)
                        or getattr(entity, "original_device_class", None))
        category = getattr(entity, "entity_category", None)
        category = getattr(category, "value", category)
        return {"device_class": device_class if isinstance(device_class, str) and len(device_class) <= 40 else None,
                "entity_category": category if category in ("config", "diagnostic") else None,
                "hidden": getattr(entity, "hidden_by", None) is not None}

    for entity in entities.entities.values():
        current = hass.states.get(entity.entity_id)
        device = devices.async_get(entity.device_id) if entity.device_id else None
        result["entities"].append({"entity_id": entity.entity_id,
                                   "name": entity.name or entity.original_name or (current.name if current else entity.entity_id),
                                   "domain": entity.entity_id.split(".", 1)[0], "device_id": entity.device_id,
                                   "area_id": entity.area_id or (device.area_id if device else None),
                                   "disabled": entity.disabled_by is not None,
                                   **display_hints(current, entity),
                                   "available": bool(current and current.state not in ("unavailable", "unknown"))})
    registered = {item["entity_id"] for item in result["entities"]}
    for current in current_states:
        if current.entity_id not in registered:
            result["entities"].append({"entity_id": current.entity_id, "name": current.name,
                                       "domain": current.entity_id.split(".", 1)[0], "device_id": None, "area_id": None,
                                       "disabled": False, **display_hints(current),
                                       "available": current.state not in ("unavailable", "unknown")})
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command({vol.Required("type"): "home_floorplan/viewer", vol.Optional("floor"): str})
@_when_active
@websocket_api.async_response
async def ws_viewer(hass, connection, msg):
    """Send private assets only to an authenticated user who can read their entities."""
    state = hass.data[DOMAIN]
    async with state["lock"]:
        snapshot = _status_snapshot(state)
        result = _status_from_snapshot(snapshot, connection)
        if not state["site"]["floors"]:
            connection.send_result(msg["id"], {**result, "html": None, "items": [], "floor": None, "site_features": False})
            return
        if not (floor := _floor(state, msg, connection)):
            return
        references = snapshot["references"][floor]
        if any(not can_read(connection, entity_id) for entity_id in references):
            connection.send_error(msg["id"], "unauthorized", "You do not have permission to view all entities in this floor.")
            return
        if recovery := state.get("recovery"):
            if not result["can_edit"]:
                connection.send_error(msg["id"], "recovery_required", "An administrator must repair the saved project.")
                return
            connection.send_result(msg["id"], {**result, "floor": floor, "site_features": False, "recovery": recovery})
            return
        # Open under the publication lock to pin this generation's file. The
        # descriptor remains readable after later cleanup unlinks its path.
        path = state["assets"] / floor / "index.html"
        inventory = copy.deepcopy(state["data"][floor])
        site_features = state["site"]["site_features"]
        stale_exports = isinstance(state["native"], GeneratedProject) and state["native"].document["generation"] is not None
        vacuum_sources = vacuum_source_bindings(state["models"][floor])
        stream = await hass.async_add_executor_job(path.open, "r", -1, "utf-8")
    content = await hass.async_add_executor_job(_read_open_file, stream)
    if state.get("panels_unloaded") or any(not can_read(connection, entity_id) for entity_id in references):
        connection.send_error(msg["id"], "unauthorized", "Your access to this floor changed. Reload the view.")
        return
    # The file and inventory belong to the pinned publication, but permission
    # decisions may have changed during either executor await.
    result = _status_from_snapshot(snapshot, connection)
    capabilities = _capabilities(connection, references)
    content = content.replace("<head>", "<head><script>window.__HOME_FLOORPLAN_EMBED__=true;</script>", 1)
    if stale_exports:
        # Immutable commissioned exports do not describe the newly edited
        # home. Keep the originals in its backup, but do not offer them as
        # current downloads. Inventory and draft JSON remain available.
        content = content.replace("<head>", "<head><style>a.download,a[download]{display:none!important}</style>", 1)
    connection.send_result(msg["id"], {**result, **inventory, **capabilities, "html": content, "floor": floor,
                                     "site_features": site_features, "vacuum_sources": vacuum_sources})


@websocket_api.websocket_command({vol.Required("type"): "home_floorplan/save", vol.Required("floor"): str,
                                 vol.Required("revision"): cv.positive_int, vol.Required("items"): list})
@_when_active
@websocket_api.require_admin
@websocket_api.async_response
async def ws_save(hass, connection, msg):
    state = hass.data[DOMAIN]
    if state.get("recovery"):
        connection.send_error(msg["id"], "recovery_required", "Export and repair the saved inventory before editing this project.")
        return
    if not (floor := _floor(state, msg, connection)):
        return
    try:
        async with state["lock"]:
            if floor not in state["rooms"]:
                connection.send_error(msg["id"], "conflict", "The published floors changed. Reload this view before saving.")
                return
            items = validate_inventory(msg["items"], state["rooms"][floor])
            current = state["data"][floor]
            if msg["revision"] != current["revision"]:
                connection.send_error(msg["id"], "conflict", "Another browser saved changes. Export your inventory before reloading and merging it.")
                return
            updated = {**state["data"], floor: {"revision": current["revision"] + 1, "items": items}}
            await _persist_inventory(state, updated)
            if refresh := state.get("activity_refresh"):
                refresh()
            connection.send_result(msg["id"], {"revision": updated[floor]["revision"],
                                              **_capabilities(connection, floor_entities(state, floor, PROFILES))})
    except NativeError as error:
        connection.send_error(msg["id"], error.code, str(error))
    except ValueError as error:
        connection.send_error(msg["id"], "invalid_inventory", str(error))


@websocket_api.websocket_command({vol.Required("type"): "home_floorplan/recover", vol.Required("token"): str,
                                 vol.Required("site_id"): str, vol.Required("floors"): dict})
@_when_active
@websocket_api.require_admin
@websocket_api.async_response
async def ws_recover(hass, connection, msg):
    state = hass.data[DOMAIN]
    async with state["lock"]:
        recovery = state.get("recovery")
        if not recovery or msg["token"] != recovery["token"] or msg["site_id"] != state["site"]["site_id"]:
            connection.send_error(msg["id"], "conflict", "Recovery data changed. Reload and export the current original before repairing it.")
            return
        try:
            updated = repair_inventory(msg["floors"], recovery, state["rooms"], validate_inventory)
            await _persist_inventory(state, updated)
        except NativeError as error:
            connection.send_error(msg["id"], error.code, str(error))
            return
        except (ValueError, TypeError, KeyError) as error:
            connection.send_error(msg["id"], "invalid_inventory", str(error))
            return
        state["recovery"] = None
    connection.send_result(msg["id"], {})


@websocket_api.websocket_command({vol.Required("type"): "home_floorplan/export", vol.Required("floor"): str,
                                 vol.Required("format"): vol.In(FORMATS)})
@_when_active
@websocket_api.require_admin
@websocket_api.async_response
async def ws_export(hass, connection, msg):
    state = hass.data[DOMAIN]
    try:
        async with state["lock"]:
            if isinstance(state["native"], GeneratedProject) and state["native"].document["generation"] is not None:
                connection.send_error(msg["id"], "not_available", "The original model downloads do not include these Home Studio edits. Export the saved drawing or inventory JSON instead.")
                return
            if not (floor := _floor(state, msg, connection)):
                return
            filename = f"{state['site']['floors'][floor]['stem']}.{msg['format']}"
            path = state["assets"] / floor / filename
            stream = await hass.async_add_executor_job(path.open, "rb")
        content = await hass.async_add_executor_job(_read_open_file, stream)
    except FileNotFoundError:
        connection.send_error(msg["id"], "not_available", "This export format was not included in the build.")
        return
    connection.send_result(msg["id"], {"filename": filename, "base64": base64.b64encode(content).decode()})


@websocket_api.websocket_command({vol.Required("type"): "home_floorplan/curtains"})
@_when_active
def ws_curtains(hass, connection, msg):
    """Subscribe to persistent observations, without exposing credentials."""
    state = hass.data[DOMAIN]["curtains"]
    def send():
        plan = hass.data[DOMAIN]
        if plan.get("panels_unloaded"):
            return
        bound = {item["entity_id"] for value in plan["data"].values() for item in value["items"] if item.get("entity_id")}
        readable = {entity_id for entity_id in bound if can_read(connection, entity_id)}
        profiles = {entity_id: profile for entity_id, profile in PROFILES.items()
                    if entity_id in readable and can_read(connection, profile["guard"])}
        guards = {profile["guard"] for profile in profiles.values()}
        connection.send_event(msg["id"], {"memory": {k: v for k, v in state["memory"].items() if k in readable},
                                         "power": {k: v for k, v in state["power"].items() if k in guards},
                                         "checks": {k: v for k, v in state["checks"].items() if k in readable},
                                         "profiles": profiles, "boot_seconds": BOOT_SECONDS})
    state["listeners"].add(send)
    connection.subscriptions[msg["id"]] = lambda: state["listeners"].discard(send)
    connection.send_result(msg["id"])
    send()


@websocket_api.websocket_command({
    vol.Required("type"): "home_floorplan/curtain_command",
    vol.Required("entity_id"): cv.entity_id,
    vol.Required("action"): vol.In(("power_on", "open_cover", "close_cover", "stop_cover", "set_cover_position", "record_position_check")),
    vol.Optional("position"): vol.All(vol.Coerce(int), vol.Range(min=0, max=100)),
})
@_when_active
@websocket_api.async_response
async def ws_curtain_command(hass, connection, msg):
    entity_id, action = msg["entity_id"], msg["action"]
    bound = any(item.get("entity_id") == entity_id for floor in hass.data[DOMAIN]["data"].values() for item in floor["items"])
    if not bound or not entity_id.startswith("cover."):
        connection.send_error(msg["id"], "not_bound", "This curtain is not linked to the saved plan.")
        return
    if not can_control(connection, entity_id):
        connection.send_error(msg["id"], "unauthorized", "You do not have permission to control this entity.")
        return
    if action == "record_position_check" and not connection.user.is_admin:
        connection.send_error(msg["id"], "unauthorized", "Only an administrator can record a physical position check.")
        return
    guard_id = PROFILES.get(entity_id, {}).get("guard")
    if guard_id and (not can_read(connection, guard_id) or (action == "power_on" and not can_control(connection, guard_id))):
        connection.send_error(msg["id"], "unauthorized", "You do not have permission to access this power guard.")
        return
    guard = hass.states.get(guard_id) if guard_id else None
    cover = hass.states.get(entity_id)
    timestamp = hass.data[DOMAIN]["curtains"]["power"].get(guard_id)
    started = dt_util.parse_datetime(timestamp) if timestamp else None
    booting = started and (dt_util.utcnow() - started).total_seconds() < BOOT_SECONDS
    if action == "power_on":
        pending_wakes = hass.data[DOMAIN]["curtains"]["pending_wakes"]
        if guard_id in pending_wakes:
            connection.send_error(msg["id"], "not_ready", "This power switch is already being turned on.")
            return
        if guard and guard.state == "on":
            # A stale browser must not restart warm-up for an already-powered motor.
            connection.send_result(msg["id"], {})
            return
        if booting:
            connection.send_error(msg["id"], "not_ready", "The power-on countdown is already running.")
            return
        if not guard or guard.state != "off":
            connection.send_error(msg["id"], "unavailable", "No confirmed, available power switch is linked to this curtain.")
            return
        # Covers on either floor can share a guard; exclude wakes until its service settles.
        pending_wakes.add(guard_id)
        try:
            await hass.services.async_call("switch", "turn_on", {"entity_id": guard_id}, blocking=True, context=Context(user_id=connection.user.id))
            hass.data[DOMAIN]["curtains"]["wake"](guard_id)
        finally:
            pending_wakes.discard(guard_id)
    else:
        stale = started and cover and cover.last_updated < started
        if not is_motor_available(cover) or (guard and guard.state == "off") or booting or stale:
            connection.send_error(msg["id"], "not_ready", "Wait for the curtain to reconnect after its power-on countdown.")
            return
        if action == "record_position_check":
            if read_reported_position(cover) is None or not cover.attributes.get("supported_features", 0) & 4:
                connection.send_error(msg["id"], "unsupported", "A reported position and percentage control are required to record a physical check.")
                return
            hass.data[DOMAIN]["curtains"]["record_check"](entity_id)
            connection.send_result(msg["id"], {})
            return
        feature = {"open_cover": 1, "close_cover": 2, "set_cover_position": 4, "stop_cover": 8}[action]
        if not cover.attributes.get("supported_features", 0) & feature or (action == "set_cover_position" and "position" not in msg):
            connection.send_error(msg["id"], "unsupported", "This curtain does not support that command.")
            return
        data = {"entity_id": entity_id}
        if action == "set_cover_position":
            data["position"] = msg["position"]
        await hass.services.async_call("cover", action, data, blocking=True, context=Context(user_id=connection.user.id))
    connection.send_result(msg["id"], {})
