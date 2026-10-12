"""Authenticated, administrator-only floorplan panel for Home Assistant."""

import asyncio
import base64
import json
from pathlib import Path

import voluptuous as vol
from homeassistant.components import panel_custom, websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.storage import Store

from .validation import validate_inventory
from .site import load_site, prepare_inventory, repair_inventory
from .curtains import async_setup_curtains, PROFILES, BOOT_SECONDS, is_motor_available, read_reported_position
from homeassistant.util import dt as dt_util

DOMAIN = "home_floorplan"
ROOT = Path(__file__).parent
LOCAL_SITE = None
try:
    from .private_site_config import SITE as LOCAL_SITE
except ModuleNotFoundError as error:
    if error.name != __package__ + ".private_site_config":
        raise
SITE = load_site(ROOT, LOCAL_SITE)
if SITE["site_features"]:
    from . import private_site as SITE_ADAPTER
FLOORS = {key: floor["stem"] for key, floor in SITE["floors"].items()}
STORE_KEY = DOMAIN if SITE["site_id"] is None else DOMAIN + "." + SITE["site_id"]
FORMATS = ("glb", "usdz", "obj", "mtl", "dae")
CONFIG_SCHEMA = vol.Schema({DOMAIN: SITE_ADAPTER.CONFIG_SCHEMA if SITE["site_features"] else vol.Schema({})}, extra=vol.ALLOW_EXTRA)


async def async_setup(hass, config):
    """Register only the generic bootstrap publicly; keep all home data private."""
    if SITE["site_features"]:
        await SITE_ADAPTER.async_prepare(hass, config)
    store = Store(hass, 1, STORE_KEY, private=True, atomic_writes=True)
    saved = await store.async_load()
    if saved is None:
        saved = {}
    models = await hass.async_add_executor_job(
        lambda: {floor: json.loads((ROOT / "assets" / floor / "model-data.json").read_text()) for floor in FLOORS}
    )
    rooms = {floor: {room["id"] for room in model["rooms"]} for floor, model in models.items()}
    if SITE["site_id"]:
        data, recovery = prepare_inventory(saved, models, rooms, SITE["site_id"], validate_inventory)
    else:
        data = {floor: value for floor, value in (saved or {}).items() if floor in FLOORS}
        for floor in FLOORS:
            data.setdefault(floor, {"revision": 0, "items": []})
            validate_inventory(data[floor]["items"], rooms[floor])
        recovery = None
    hass.data[DOMAIN] = {"data": data, "store": store, "lock": asyncio.Lock(), "rooms": rooms,
                        "recovery": recovery}
    hass.data[DOMAIN]["curtains"] = await async_setup_curtains(hass, STORE_KEY + ".curtains")
    if SITE["site_features"]:
        await SITE_ADAPTER.async_setup(hass, config)
    await hass.http.async_register_static_paths([
        StaticPathConfig("/home-floorplan-static", str(ROOT / "static"), cache_headers=False)
    ])
    for handler in (ws_viewer, ws_save, ws_recover, ws_export, ws_curtains, ws_curtain_command):
        websocket_api.async_register_command(hass, handler)
    await panel_custom.async_register_panel(
        hass, "home-floorplan", "home-floorplan-panel",
        sidebar_title="3D Home", sidebar_icon="mdi:floor-plan",
        module_url="/home-floorplan-static/panel.js?v=0.6.0",
        require_admin=True,
    )
    return True


@websocket_api.websocket_command({vol.Required("type"): "home_floorplan/viewer", vol.Optional("floor", default=SITE["default_floor"]): vol.In(FLOORS)})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_viewer(hass, connection, msg):
    """Send the self-contained viewer and shared inventory over authenticated WS."""
    floor = msg["floor"]
    if recovery := hass.data[DOMAIN].get("recovery"):
        connection.send_result(msg["id"], {"floor": floor, "floors": list(FLOORS),
                                          "site_features": False, "recovery": recovery})
        return
    content = await hass.async_add_executor_job((ROOT / "assets" / floor / "index.html").read_text)
    content = content.replace("<head>", "<head><script>window.__HOME_FLOORPLAN_EMBED__=true;</script>", 1)
    connection.send_result(msg["id"], {"html": content, "floor": floor, "floors": list(FLOORS), "site_features": SITE["site_features"], **hass.data[DOMAIN]["data"][floor]})


@websocket_api.websocket_command({
    vol.Required("type"): "home_floorplan/save", vol.Required("floor"): vol.In(FLOORS),
    vol.Required("revision"): cv.positive_int, vol.Required("items"): list,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_save(hass, connection, msg):
    """Use compare-and-swap so two browsers cannot silently overwrite placements."""
    state = hass.data[DOMAIN]
    if state.get("recovery"):
        connection.send_error(msg["id"], "recovery_required", "Export and repair the saved inventory before editing this project.")
        return
    try:
        items = validate_inventory(msg["items"], state["rooms"][msg["floor"]])
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_inventory", str(err))
        return
    async with state["lock"]:
        current = state["data"][msg["floor"]]
        if msg["revision"] != current["revision"]:
            connection.send_error(msg["id"], "conflict", "Another browser saved changes. Export your inventory before reloading and merging it.")
            return
        updated = {**state["data"], msg["floor"]: {"revision": current["revision"] + 1, "items": items}}
        await state["store"].async_save(updated)
        state["data"] = updated
        state["curtains"]["capture"]()
        if refresh := state.get("activity_refresh"):
            refresh()
    connection.send_result(msg["id"], {"revision": updated[msg["floor"]]["revision"]})


@websocket_api.websocket_command({
    vol.Required("type"): "home_floorplan/recover", vol.Required("token"): str,
    vol.Required("site_id"): str, vol.Required("floors"): dict,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_recover(hass, connection, msg):
    """Replace incompatible inventory only by explicit, current administrator input."""
    state = hass.data[DOMAIN]
    async with state["lock"]:
        recovery = state.get("recovery")
        if (not recovery or msg["token"] != recovery["token"]
                or msg["site_id"] != SITE["site_id"]):
            connection.send_error(msg["id"], "conflict", "Recovery data changed. Reload and export the current original before repairing it.")
            return
        try:
            updated = repair_inventory(msg["floors"], recovery, state["rooms"], validate_inventory)
        except (ValueError, TypeError, KeyError) as error:
            connection.send_error(msg["id"], "invalid_inventory", str(error))
            return
        await state["store"].async_save(updated)
        state["data"], state["recovery"] = updated, None
        state["curtains"]["capture"]()
    connection.send_result(msg["id"], {})


@websocket_api.websocket_command({
    vol.Required("type"): "home_floorplan/export", vol.Required("floor"): vol.In(FLOORS),
    vol.Required("format"): vol.In(FORMATS),
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_export(hass, connection, msg):
    """Allow only explicitly packaged model files, never arbitrary paths."""
    filename = f"{FLOORS[msg['floor']]}.{msg['format']}"
    path = ROOT / "assets" / msg["floor"] / filename
    if not path.is_file():
        connection.send_error(msg["id"], "not_available", "This export format was not included in the build.")
        return
    content = await hass.async_add_executor_job(path.read_bytes)
    connection.send_result(msg["id"], {"filename": filename, "base64": base64.b64encode(content).decode()})


@websocket_api.websocket_command({vol.Required("type"): "home_floorplan/curtains"})
@websocket_api.require_admin
def ws_curtains(hass, connection, msg):
    """Subscribe to persistent observations, without exposing credentials."""
    state = hass.data[DOMAIN]["curtains"]
    def send():
        connection.send_event(msg["id"], {"memory": state["memory"], "power": state["power"], "checks": state["checks"], "profiles": PROFILES, "boot_seconds": BOOT_SECONDS})
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
@websocket_api.require_admin
@websocket_api.async_response
async def ws_curtain_command(hass, connection, msg):
    entity_id, action = msg["entity_id"], msg["action"]
    bound = any(item.get("entity_id") == entity_id for floor in hass.data[DOMAIN]["data"].values() for item in floor["items"])
    if not bound or not entity_id.startswith("cover."):
        connection.send_error(msg["id"], "not_bound", "This curtain is not linked to the saved plan.")
        return
    guard_id = PROFILES.get(entity_id, {}).get("guard")
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
            await hass.services.async_call("switch", "turn_on", {"entity_id": guard_id}, blocking=True)
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
        await hass.services.async_call("cover", action, data, blocking=True)
    connection.send_result(msg["id"], {})
