"""Load bounded, build-time site metadata without exposing filesystem paths."""
import copy
import hashlib
import json
import re


def load_site(root, fallback=None, *, allow_empty=False):
    """Require generated metadata unless the host supplies trusted local config."""
    path = root / "site.json"
    if not path.exists():
        if fallback is None:
            if allow_empty:
                return {"schema_version": 1, "site_id": None, "default_floor": None, "floors": {}, "site_features": False}
            raise ValueError("Missing site.json; install a complete generated Home Studio package")
        return copy.deepcopy(fallback)
    if path.stat().st_size > 65536:
        raise ValueError("Site manifest exceeds 64 KiB")
    site = json.loads(path.read_text())
    expected = {"schema_version", "site_id", "default_floor", "floors", "site_features"}
    def identifier(value):
        return isinstance(value, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,47}", value) is not None
    if not isinstance(site, dict) or set(site) != expected or type(site["schema_version"]) is not int or site["schema_version"] != 1:
        raise ValueError("Unsupported site manifest schema")
    # A private host may install its exact trusted local configuration explicitly.
    # JSON alone can never activate a site adapter in a public installation.
    if site["site_features"] is True and fallback is not None and site == fallback:
        return copy.deepcopy(fallback)
    # Generic packages must never activate adapters commissioned for another house.
    if not identifier(site["site_id"]) or site["site_features"] is not False:
        raise ValueError("A generic site needs a valid site_id and site_features=false")
    floors = site["floors"]
    if not isinstance(floors, dict) or not 1 <= len(floors) <= 8:
        raise ValueError("A site must contain one to eight floors")
    for key, floor in floors.items():
        if (not identifier(key) or not isinstance(floor, dict) or set(floor) != {"stem", "title"}
                or not identifier(floor["stem"]) or not isinstance(floor["title"], str)
                or not floor["title"].strip() or len(floor["title"]) > 120):
            raise ValueError("Invalid site floor metadata")
    if not identifier(site["default_floor"]) or site["default_floor"] not in floors:
        raise ValueError("Default floor is not present in site manifest")
    return site


def validate_floor_inventory(value, rooms, validate):
    """Validate a complete saved floor without accepting caller-supplied metadata."""
    if (not isinstance(value, dict) or set(value) != {"revision", "items"}
            or type(value["revision"]) is not int or value["revision"] < 0):
        raise ValueError("Expected a nonnegative revision and an items array")
    return validate(value["items"], rooms)


def prepare_inventory(saved, models, rooms, site_id, validate):
    """Keep incompatible saved data intact until an explicit, validated repair."""
    initial = {floor: {"revision": 0, "items": copy.deepcopy(model.get("inventory", []))}
               for floor, model in models.items()}
    for floor, value in initial.items():
        validate_floor_inventory(value, rooms[floor], validate)
    issues = []
    if not isinstance(saved, dict):
        issues.append("Saved inventory is not a floor mapping.")
    else:
        for floor, value in saved.items():
            if floor not in rooms:
                issues.append(f"Floor {floor} is no longer in this project.")
                continue
            try:
                validate_floor_inventory(value, rooms[floor], validate)
            except (ValueError, TypeError, KeyError) as error:
                issues.append(f"Floor {floor}: {error}.")
    if not issues:
        return {**initial, **copy.deepcopy(saved)}, None
    backup = {"schema_version": 1, "site_id": site_id, "floors": copy.deepcopy(saved),
              "rooms": {floor: sorted(ids) for floor, ids in rooms.items()}}
    token = hashlib.sha256(json.dumps(backup, sort_keys=True).encode()).hexdigest()
    backup["recovery_token"] = token
    # No incompatible or newly seeded bindings become active during recovery.
    inactive = {floor: {"revision": 0, "items": []} for floor in rooms}
    return inactive, {"token": token, "issues": issues, "backup": backup}


def repair_inventory(replacement, recovery, rooms, validate):
    """Validate all current floors; advance revisions from the original store."""
    if not isinstance(replacement, dict) or set(replacement) != set(rooms):
        raise ValueError("Replacement must include exactly the current floors: " + ", ".join(rooms))
    previous = recovery["backup"]["floors"]
    result = {}
    for floor, value in replacement.items():
        items = validate_floor_inventory(value, rooms[floor], validate)
        old = previous.get(floor, {}) if isinstance(previous, dict) else {}
        revision = old.get("revision", 0) if isinstance(old, dict) else 0
        if type(revision) is not int or revision < 0:
            revision = 0
        result[floor] = {"revision": revision + 1, "items": items}
    return result
