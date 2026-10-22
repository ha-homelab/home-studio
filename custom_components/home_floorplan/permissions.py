"""Apply Home Assistant entity permissions at the authenticated host boundary."""
import re
from types import MappingProxyType

from homeassistant.auth.permissions.const import POLICY_CONTROL, POLICY_READ

ENTITY_ID = re.compile(r"[a-z_]+\.[a-z0-9_]+\Z")


def can_read(connection, entity_id):
    return bool(connection.user and connection.user.permissions.check_entity(entity_id, POLICY_READ))


def can_control(connection, entity_id):
    return can_read(connection, entity_id) and connection.user.permissions.check_entity(entity_id, POLICY_CONTROL)


def referenced_entities(value):
    """Find entity references without accepting client claims about authorization."""
    if isinstance(value, str):
        return {value} if ENTITY_ID.fullmatch(value) else set()
    if isinstance(value, dict):
        return set().union(*(referenced_entities(item) for item in value.values())) if value else set()
    if isinstance(value, list):
        return set().union(*(referenced_entities(item) for item in value)) if value else set()
    return set()


def model_references(models):
    """Index all model values once in the loader's executor, including assets."""
    return MappingProxyType({floor: frozenset(referenced_entities(model))
                             for floor, model in models.items()})


def vacuum_source_bindings(model):
    """Authorize only configured vacuum/position pairs, without copying metadata."""
    sources = model.get("vacuum_sources", [])
    if not isinstance(sources, list) or len(sources) > 64:
        return []
    result, seen = [], set()
    for source in sources:
        if not isinstance(source, dict):
            continue
        vacuum, position = source.get("entity_id"), source.get("position_entity_id")
        if not isinstance(vacuum, str) or not re.fullmatch(r"vacuum\.[a-z0-9_]{1,137}", vacuum):
            continue
        if not isinstance(position, str) or not re.fullmatch(r"sensor\.[a-z0-9_]{1,137}", position):
            continue
        if (vacuum, position) not in seen:
            seen.add((vacuum, position))
            result.append({"entity_id": vacuum, "position_entity_id": position})
    return result


def floor_entities(state, floor, profiles):
    # Models are immutable within an active generation. Placements and profile
    # guards remain live inputs, and authorization is never cached here.
    result = set(state["model_entities"][floor])
    result.update(referenced_entities(state["data"].get(floor, {})))
    for entity_id in tuple(result):
        guard = profiles.get(entity_id, {}).get("guard")
        if guard:
            result.add(guard)
    return result
