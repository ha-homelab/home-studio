"""Bounded, optional authoring documentation; never a geometry certificate."""
import copy
import json
import math
import re

DOCUMENTATION_LIMITS = dict(brief=4000, measurements=1024, finishes=1536,
                            ceilingFixtures=1024, note=1000, code=80,
                            specification=1000, bytes=256 * 1024)
COLLECTIONS = dict(room="rooms", wall="walls", opening="openings", item="items")
STATUSES = ("measured", "estimated", "imported", "unknown")
ITEM_TYPES = ("furniture", "lamp", "chandelier", "tv", "appliance", "switch", "outlet", "sensor")
ID = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}\Z")
FLOOR_ID = re.compile(r"[a-z][a-z0-9_]{0,47}\Z")
RESERVED = {"__proto__", "prototype", "constructor", "toString", "valueOf", "hasOwnProperty",
            "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
            "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"}


def fail(message):
    raise ValueError("Documentation: " + message)


def fields(value, names):
    if not isinstance(value, dict) or set(value) != set(names):
        fail("invalid fields.")


def text(value, maximum, multiline=False):
    if not isinstance(value, str) or len(value) > maximum or any(
            ord(char) < 32 and not (multiline and char in "\n\t") or
            0xD800 <= ord(char) <= 0xDFFF for char in value):
        fail("invalid text.")


def identifier(value, floor=False):
    if not isinstance(value, str) or not (FLOOR_ID if floor else ID).fullmatch(value) or value in RESERVED:
        fail("invalid identifier.")


def number(value, low, high):
    if type(value) not in (int, float) or not low <= value <= high or not math.isfinite(value):
        fail("invalid number.")


def choice(value, values):
    if value not in values:
        fail("invalid choice.")


def array(value, maximum):
    if not isinstance(value, list) or len(value) > maximum:
        fail("too many entries or invalid list.")


def point(value):
    if not isinstance(value, list) or len(value) != 2:
        fail("invalid point.")
    for n in value:
        number(n, -100, 100)


def wall_shape(value):
    fields(value, ("start", "end", "thickness_m"))
    point(value["start"])
    point(value["end"])
    number(value["thickness_m"], 0.04, 2)


def geometry(value, target_type):
    if value is None:
        return
    extra = dict(room=("polygon",), wall=("start", "end", "thickness_m"),
                 opening=("wall_id", "wall", "type", "offset_m", "width_m", "sill_m", "head_m"),
                 item=("type", "model_id", "room", "position_m", "dimensions_m", "rotation_deg"))
    fields(value, ("target_type", "elevation_m", "height_m", *extra[target_type]))
    if value["target_type"] != target_type:
        fail("geometry belongs to another target type.")
    number(value["elevation_m"], -100, 100)
    number(value["height_m"], 0.5, 20)
    if target_type == "room":
        array(value["polygon"], 64)
        if len(value["polygon"]) < 3:
            fail("invalid polygon.")
        for p in value["polygon"]:
            point(p)
    elif target_type == "wall":
        wall_shape({key: value[key] for key in ("start", "end", "thickness_m")})
    elif target_type == "opening":
        identifier(value["wall_id"])
        wall_shape(value["wall"])
        choice(value["type"], ("door", "window", "passage"))
        number(value["offset_m"], 0, 300)
        number(value["width_m"], 0.05, 300)
        number(value["sill_m"], 0, 20)
        number(value["head_m"], 0.05, 20)
    else:
        choice(value["type"], ITEM_TYPES)
        if value["model_id"] is not None:
            identifier(value["model_id"])
        identifier(value["room"])
        fields(value["position_m"], ("x", "y", "z"))
        for key in ("x", "z"):
            number(value["position_m"][key], -100, 100)
        number(value["position_m"]["y"], 0, 20)
        fields(value["dimensions_m"], ("width", "depth", "height"))
        for n in value["dimensions_m"].values():
            number(n, 0.001, 100)
        number(value["rotation_deg"], -36000, 36000)


def resolve(project, ref):
    floor = next((value for value in project["floors"] if value["id"] == ref["floor_id"]), None)
    target = next((value for value in floor.get(COLLECTIONS.get(ref["target_type"]), [])
                   if value["id"] == ref["target_id"]), None) if floor else None
    return (floor, target) if target else None


def encoded_budget(value):
    """Conservative UTF-8 JSON budget, stable across JS/Python number formatting."""
    if type(value) in (int, float):
        return 32
    if isinstance(value, list):
        return 2 + max(0, len(value) - 1) + sum(encoded_budget(entry) for entry in value)
    if isinstance(value, dict):
        return 2 + max(0, len(value) - 1) + sum(encoded_budget(key) + 1 + encoded_budget(entry)
                                                for key, entry in value.items())
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def create_documentation():
    return dict(schema_version=1, brief="", measurements=[], finishes=[], ceiling_fixture_ids=[])


def validate_documentation(documentation, project):
    """Run after project geometry validation; never modifies input."""
    fields(documentation, ("schema_version", "brief", "measurements", "finishes", "ceiling_fixture_ids"))
    if type(documentation["schema_version"]) is not int or documentation["schema_version"] != 1:
        fail("unsupported schema version.")
    text(documentation["brief"], DOCUMENTATION_LIMITS["brief"], True)
    for field, maximum in (("measurements", "measurements"), ("finishes", "finishes"), ("ceiling_fixture_ids", "ceilingFixtures")):
        array(documentation[field], DOCUMENTATION_LIMITS[maximum])
    measurements, finishes, fixtures = set(), set(), set()
    for row in documentation["measurements"]:
        fields(row, ("floor_id", "target_type", "target_id", "status", "note", "geometry"))
        identifier(row["floor_id"], True)
        choice(row["target_type"], tuple(COLLECTIONS))
        identifier(row["target_id"])
        if not resolve(project, row):
            fail("measurement target does not exist.")
        key = (row["floor_id"], row["target_type"], row["target_id"])
        if key in measurements:
            fail("duplicate measurement.")
        measurements.add(key)
        choice(row["status"], STATUSES)
        text(row["note"], DOCUMENTATION_LIMITS["note"], True)
        geometry(row["geometry"], row["target_type"])
    for row in documentation["finishes"]:
        fields(row, ("floor_id", "room_id", "surface", "code", "specification", "waste_percent"))
        identifier(row["floor_id"], True)
        identifier(row["room_id"])
        choice(row["surface"], ("floor", "walls", "ceiling"))
        if not resolve(project, dict(floor_id=row["floor_id"], target_type="room", target_id=row["room_id"])):
            fail("finish room does not exist.")
        key = (row["floor_id"], row["room_id"], row["surface"])
        if key in finishes:
            fail("duplicate finish.")
        finishes.add(key)
        text(row["code"], DOCUMENTATION_LIMITS["code"])
        text(row["specification"], DOCUMENTATION_LIMITS["specification"], True)
        number(row["waste_percent"], 0, 100)
    for row in documentation["ceiling_fixture_ids"]:
        fields(row, ("floor_id", "item_id"))
        identifier(row["floor_id"], True)
        identifier(row["item_id"])
        if not resolve(project, dict(floor_id=row["floor_id"], target_type="item", target_id=row["item_id"])):
            fail("ceiling item does not exist.")
        key = (row["floor_id"], row["item_id"])
        if key in fixtures:
            fail("duplicate ceiling item.")
        fixtures.add(key)
    if encoded_budget(documentation) > DOCUMENTATION_LIMITS["bytes"]:
        fail("encoded metadata budget exceeds 256 KiB.")
    return documentation


def measurement_geometry(project, ref):
    choice(ref["target_type"], tuple(COLLECTIONS))
    found = resolve(project, ref)
    if not found:
        fail("measurement target does not exist.")
    floor, target = found
    result = dict(target_type=ref["target_type"], elevation_m=floor["elevation_m"], height_m=floor["height_m"])
    if ref["target_type"] == "room":
        result["polygon"] = copy.deepcopy(target["polygon"])
    elif ref["target_type"] == "wall":
        result.update({key: copy.deepcopy(target[key]) for key in ("start", "end", "thickness_m")})
    elif ref["target_type"] == "opening":
        wall = next((value for value in floor["walls"] if value["id"] == target["wall_id"]), None)
        if not wall:
            fail("opening wall does not exist.")
        result.update({key: target[key] for key in ("wall_id", "type", "offset_m", "width_m", "sill_m", "head_m")})
        result["wall"] = {key: copy.deepcopy(wall[key]) for key in ("start", "end", "thickness_m")}
    else:
        result.update({key: copy.deepcopy(target[key]) for key in ("type", "room", "position_m", "dimensions_m", "rotation_deg")})
        result["model_id"] = target.get("model_id")
    return result


def measurement_state(project, row):
    if row is None or row["status"] == "unknown" or row["geometry"] is None:
        return "unknown"
    if not resolve(project, row):
        return "stale"
    return row["status"] if row["geometry"] == measurement_geometry(project, row) else "stale"


def prune_documentation(project):
    """Only for an editor deletion transaction, never import repair."""
    if "documentation" not in project:
        return None
    result = copy.deepcopy(project["documentation"])
    result["measurements"] = [row for row in result["measurements"] if resolve(project, row)]
    result["finishes"] = [row for row in result["finishes"] if resolve(project, dict(floor_id=row["floor_id"], target_type="room", target_id=row["room_id"]))]
    result["ceiling_fixture_ids"] = [row for row in result["ceiling_fixture_ids"] if resolve(project, dict(floor_id=row["floor_id"], target_type="item", target_id=row["item_id"]))]
    return result
