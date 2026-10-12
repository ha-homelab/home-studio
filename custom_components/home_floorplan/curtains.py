"""Retain HA-reported positions and explicit user checks across restarts."""
import json
from pathlib import Path

from homeassistant.core import callback
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

VALID_STATES = {"open", "closed", "opening", "closing"}
BOOT_SECONDS = 50
PROFILES = json.loads(Path(__file__).with_name("curtains.json").read_text())


def is_motor_available(state):
    """HA availability and supported commands do not require a measured position."""
    return bool(state and not state.attributes.get("restored") and (
        state.state in VALID_STATES or
        (state.state == "unknown" and state.attributes.get("supported_features", 0) & 15)
    ))


def read_reported_position(state):
    """Never replace a known position with unavailable, a target, or a guess."""
    if state is None or state.attributes.get("restored") or state.state not in VALID_STATES:
        return None
    position = state.attributes.get("current_position")
    if isinstance(position, bool) or not isinstance(position, (int, float)) or not 0 <= position <= 100:
        return None
    return {"position": position, "observed_at": state.last_updated.isoformat()}


async def async_setup_curtains(hass, storage_key="home_floorplan.curtains"):
    store = Store(hass, 1, storage_key, private=True, atomic_writes=True)
    memory = await store.async_load() or {}
    power = memory.pop("_power", {})
    checks = memory.pop("_checks", {})
    listeners = set()
    guards = {p["guard"] for p in PROFILES.values()}

    def schedule_save():
        store.async_delay_save(lambda: {**memory, "_power": power, "_checks": checks}, 2)

    def notify_subscribers():
        for listener in list(listeners):
            listener()

    def clear_guard_position_checks(guard_id):
        for entity_id, profile in PROFILES.items():
            if profile["guard"] == guard_id:
                checks.pop(entity_id, None)

    @callback
    def record_power_on(guard_id, timestamp=None):
        # Start the wait after a successful wake, even before the socket's state event.
        power[guard_id] = timestamp or dt_util.utcnow().isoformat()
        clear_guard_position_checks(guard_id)
        schedule_save()
        notify_subscribers()

    @callback
    def record_position_check(entity_id):
        # An explicit user attestation, not inferred from a timestamp or endpoint.
        checks[entity_id] = dt_util.utcnow().isoformat()
        schedule_save()
        notify_subscribers()

    def read_current_position(entity_id, state):
        guard_id = PROFILES.get(entity_id, {}).get("guard")
        guard = hass.states.get(guard_id) if guard_id else None
        started = dt_util.parse_datetime(power[guard_id]) if guard_id in power else None
        if (guard and guard.state == "off") or (started and state and state.last_updated < started):
            return None
        return read_reported_position(state)

    def tracked_curtain_ids():
        return {item["entity_id"] for floor in hass.data["home_floorplan"]["data"].values()
                for item in floor["items"] if item.get("entity_id", "").startswith("cover.")}

    @callback
    def on_state_changed(event):
        entity_id = event.data["entity_id"]
        if entity_id in guards:
            old, new = event.data.get("old_state"), event.data.get("new_state")
            if new and new.state == "off":
                power.pop(entity_id, None)
                clear_guard_position_checks(entity_id)
            elif new and new.state == "on" and old and old.state == "off":
                record_power_on(entity_id, new.last_changed.isoformat())
                return
            else:
                return
            schedule_save()
            notify_subscribers()
            return
        if not entity_id.startswith("cover.") or entity_id not in tracked_curtain_ids():
            return
        value = read_current_position(entity_id, event.data.get("new_state"))
        if value is not None:
            memory[entity_id] = value
            schedule_save()
            notify_subscribers()

    @callback
    def capture_current_positions():
        for guard_id in guards:
            guard = hass.states.get(guard_id)
            if guard and guard.state == "off":
                clear_guard_position_checks(guard_id)
        for entity_id in tracked_curtain_ids():
            value = read_current_position(entity_id, hass.states.get(entity_id))
            if value is not None:
                memory[entity_id] = value
        schedule_save()
        notify_subscribers()
    capture_current_positions()
    # The inventory is editable, so filter dynamically instead of freezing its IDs.
    hass.bus.async_listen("state_changed", on_state_changed)
    return {"memory": memory, "power": power, "checks": checks, "pending_wakes": set(),
            "record_check": record_position_check, "wake": record_power_on,
            "listeners": listeners, "capture": capture_current_positions}
