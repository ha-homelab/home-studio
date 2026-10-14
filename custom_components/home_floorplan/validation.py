"""Validate untrusted placement data before writing Home Assistant storage."""

import math
import re

KINDS = {"chandelier", "lamp", "tv", "appliance", "furniture", "switch", "outlet", "sensor"}
APPEARANCE_FIELDS = {"model_id", "style_id", "color"}


def validate_appearance(item):
    """Preserve bounded catalog metadata without loading the editor in HA.

    The project compiler validates catalog membership and exports the selected
    meshes. Runtime placement editing retains those identifiers and colors;
    they are never file paths, imports, URLs, or executable markup.
    """
    if ("style_id" in item or "color" in item) and "model_id" not in item:
        raise ValueError("A furniture finish or color requires a model")
    for key in ("model_id", "style_id"):
        if key in item and (not isinstance(item[key], str)
                            or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", item[key])):
            raise ValueError(f"Invalid {key}")
    if "color" in item and (not isinstance(item["color"], str)
                           or not re.fullmatch(r"#[0-9a-fA-F]{6}", item["color"])):
        raise ValueError("Invalid furniture color")


def validate_inventory(items, rooms):
    """Return a normalized inventory, rejecting unknown fields and invalid numbers."""
    if not isinstance(items, list) or len(items) > 2000:
        raise ValueError("Expected at most 2,000 objects")
    result, seen = [], set()
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("Every object must be a dictionary")
        required = {"id", "name", "type", "room", "position_m", "dimensions_m", "rotation_deg", "entity_id", "notes"}
        if not required.issubset(item) or set(item) - required - APPEARANCE_FIELDS:
            raise ValueError("Unexpected or missing object fields")
        validate_appearance(item)
        for key, maximum in (("id", 128), ("name", 100), ("type", 30), ("room", 100), ("entity_id", 150), ("notes", 2000)):
            if not isinstance(item[key], str) or len(item[key]) > maximum:
                raise ValueError(f"Invalid {key}")
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", item["id"]) or item["id"] in seen:
            raise ValueError("Object IDs must be unique portable identifiers")
        seen.add(item["id"])
        if not item["name"].strip() or item["type"] not in KINDS or item["room"] not in rooms:
            raise ValueError("Invalid name, type or room")
        if item["entity_id"] and not re.fullmatch(r"[a-z_]+\.[a-z0-9_]+", item["entity_id"]):
            raise ValueError("Invalid entity ID")

        def number(value, low, high):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
                raise ValueError("Coordinates or dimensions are outside supported bounds")
            return value

        vectors = {}
        for key, axes, low, high in (("position_m", ("x", "y", "z"), -100, 100), ("dimensions_m", ("width", "depth", "height"), .001, 100)):
            if not isinstance(item[key], dict) or set(item[key]) != set(axes):
                raise ValueError(f"Invalid {key}")
            vectors[key] = {axis: number(item[key][axis], low, high) for axis in axes}
        result.append({**item, **vectors, "rotation_deg": number(item["rotation_deg"], -36000, 36000)})
    return result
