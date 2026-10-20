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
