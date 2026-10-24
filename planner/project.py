"""Validated, metric project compiler; independent of household plans and catalogs.

Coordinates are local to each floor, with Y=0 at the finished floor. Elevation
also aligns the muted lower-floor context; each floor is exported separately. No image tracing or
household inventory is loaded by this module.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import html
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import struct
import tarfile
import tempfile

if __package__ and "." in __package__:
    # The HA distribution nests these same sources in its private runtime
    # package. Relative imports avoid changing the host interpreter's sys.path.
    from ..geometry import MATERIALS, create_geometry, floor_context
    from ..exporters import export_models
    from ..viewer_locales import load_viewer_i18n
    from ..material_textures import validate_material_textures, material_uv
else:
    from geometry import MATERIALS, create_geometry, floor_context
    from exporters import export_models
    from viewer_locales import load_viewer_i18n
    from material_textures import validate_material_textures, material_uv
from .furniture import build_furniture_asset, validate_furniture_appearance, supports_curtain, MODELS

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "dist" / "planner-project"
MAX_BYTES = 2_000_000
EPS = 1e-8
ID = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}\Z")
FLOOR_ID = re.compile(r"[a-z][a-z0-9_]{0,47}\Z")
KINDS = {"chandelier", "lamp", "tv", "appliance", "furniture", "switch", "outlet", "sensor"}
RESERVED = {"__proto__", "prototype", "constructor", "toString", "valueOf", "hasOwnProperty",
            "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
            "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"}
MARKER = ".planner-output.json"


class ProjectError(ValueError):
    """An actionable error in an untrusted project or output destination."""


def fail(path, message):
    raise ProjectError(f"{path}: {message}")


def fields(value, required, path, optional=()):
    if not isinstance(value, dict):
        fail(path, "expected an object")
    missing, extra = set(required) - value.keys(), value.keys() - set(required) - set(optional)
    if missing:
        fail(path, "missing fields: " + ", ".join(sorted(missing)))
    if extra:
        fail(path, "unknown fields: " + ", ".join(sorted(extra)))


def text(value, path, maximum=120, empty=False, multiline=False):
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value.strip()):
        fail(path, f"expected {'an optional' if empty else 'a nonempty'} string of at most {maximum} characters")
    if any((ord(c) < 32 and not (multiline and c in "\n\t")) or 0xD800 <= ord(c) <= 0xDFFF for c in value):
        fail(path, "control characters and invalid Unicode are not allowed")
    return value


def identifier(value, path, floor=False):
    if not isinstance(value, str) or not (FLOOR_ID if floor else ID).fullmatch(value) or value in RESERVED:
        fail(path, "expected a portable " + ("lowercase " if floor else "") + "identifier (letters, digits, underscores; start with a letter)")
    return value


def number(value, path, low, high):
    if isinstance(value, bool) or not isinstance(value, (float, int)):
        fail(path, f"expected a finite number between {low} and {high}")
    try:
        valid = math.isfinite(value) and low <= value <= high
    except OverflowError:
        valid = False
    if not valid:
        fail(path, f"expected a finite number between {low} and {high}")
    return value


def sequence(value, path, minimum, maximum):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        fail(path, f"expected an array with {minimum} to {maximum} entries")
    return value


def point(value, path):
    sequence(value, path, 2, 2)
    for i, v in enumerate(value):
        number(v, f"{path}[{i}]", -100, 100)


def cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def on_segment(p, a, b):
    return abs(cross(a, b, p)) <= EPS and all(min(a[i], b[i]) - EPS <= p[i] <= max(a[i], b[i]) + EPS for i in (0, 1))


def proper_cross(a, b, c, d):
    return ((cross(a, b, c) > EPS and cross(a, b, d) < -EPS) or
            (cross(a, b, c) < -EPS and cross(a, b, d) > EPS)) and (
            (cross(c, d, a) > EPS and cross(c, d, b) < -EPS) or
            (cross(c, d, a) < -EPS and cross(c, d, b) > EPS))


def intersects(a, b, c, d):
    return proper_cross(a, b, c, d) or any((on_segment(c, a, b), on_segment(d, a, b), on_segment(a, c, d), on_segment(b, c, d)))


def collinear_overlap(a, b, c, d):
    if abs(cross(a, b, c)) > EPS or abs(cross(a, b, d)) > EPS:
        return False
    axis = 0 if abs(b[0] - a[0]) >= abs(b[1] - a[1]) else 1
    return min(max(a[axis], b[axis]), max(c[axis], d[axis])) - max(min(a[axis], b[axis]), min(c[axis], d[axis])) > EPS


def edges(poly):
    return list(zip(poly, poly[1:] + poly[:1]))


def area(poly):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in edges(poly)) / 2


def inside(p, poly):
    if any(on_segment(p, a, b) for a, b in edges(poly)):
        return False
    result = False
    for a, b in edges(poly):
        if (a[1] > p[1]) != (b[1] > p[1]) and p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]:
            result = not result
    return result


def validate_polygon(poly, path):
    sequence(poly, path, 3, 64)
    for i, p in enumerate(poly):
        point(p, f"{path}[{i}]")
    if len(set(map(tuple, poly))) != len(poly):
        fail(path, "vertices must be distinct; do not repeat the first vertex at the end")
    for i, (a, b) in enumerate(edges(poly)):
        if math.dist(a, b) < .01:
            fail(path, "each polygon edge must be at least 0.01 m long")
        # Collinear forward vertices are harmless; a reversal overlaps an edge.
        c = poly[(i + 2) % len(poly)]
        if abs(cross(a, b, c)) <= EPS and sum((a[j] - b[j]) * (c[j] - b[j]) for j in (0, 1)) > EPS:
            fail(path, "adjacent edges overlap or reverse direction")
        for k in range(i + 1, len(poly)):
            if k == i + 1 or (i == 0 and k == len(poly) - 1):
                continue
            if intersects(a, b, poly[k], poly[(k + 1) % len(poly)]):
                fail(path, f"edges {i + 1} and {k + 1} intersect; use a simple polygon")
    if abs(area(poly)) < .01:
        fail(path, "room area must be at least 0.01 square metres")


def rooms_overlap(a, b):
    if any(max(p[axis] for p in a) <= min(p[axis] for p in b) or max(p[axis] for p in b) <= min(p[axis] for p in a) for axis in (0, 1)):
        return False
    if any(inside(p, b) for p in a) or any(inside(p, a) for p in b):
        return True
    for p, q in edges(a):
        for r, s in edges(b):
            if proper_cross(p, q, r, s):
                return True
            if collinear_overlap(p, q, r, s) and area(a) * area(b) * sum((q[i] - p[i]) * (s[i] - r[i]) for i in (0, 1)) > 0:
                return True
    return False


def validate_project(project, *, complete=True):
    """Validate completely and return a detached copy; never write partial output."""
    fields(project, {"schema_version", "title", "floors"}, "project", {"id"})
    if type(project["schema_version"]) is not int or project["schema_version"] != 1:
        fail("project.schema_version", "only version 1 is supported")
    text(project["title"], "project.title")
    if "id" in project:
        identifier(project["id"], "project.id", floor=True)
    sequence(project["floors"], "project.floors", 1, 8)
    floor_ids, count = set(), 0
    for fi, floor in enumerate(project["floors"]):
        path = f"project.floors[{fi}]"
        fields(floor, {"id", "name", "elevation_m", "height_m", "rooms", "walls", "openings", "items"}, path, {"ha_floor_id"})
        fid = identifier(floor["id"], path + ".id", floor=True)
        if fid in floor_ids:
            fail(path + ".id", "duplicate floor ID " + fid)
        floor_ids.add(fid)
        text(floor["name"], path + ".name")
        if "ha_floor_id" in floor:
            text(floor["ha_floor_id"], path + ".ha_floor_id", 128)
        number(floor["elevation_m"], path + ".elevation_m", -100, 100)
        height = number(floor["height_m"], path + ".height_m", .5, 20)
        used = set()
        for collection in ("rooms", "walls", "openings", "items"):
            sequence(floor[collection], path + "." + collection, 1 if complete and collection == "rooms" else 0, 64 if collection == "rooms" else 256)
            count += len(floor[collection])
            for index, entry in enumerate(floor[collection]):
                ep = f"{path}.{collection}[{index}]"
                if not isinstance(entry, dict):
                    fail(ep, "expected an object")
                eid = identifier(entry.get("id"), ep + ".id")
                if eid in used:
                    fail(ep + ".id", "duplicate ID across this floor: " + eid)
                used.add(eid)
        if count > 2048:
            fail("project.floors", "at most 2,048 rooms, walls, openings and objects are supported in total")
        for ri, room in enumerate(floor["rooms"]):
            rp = f"{path}.rooms[{ri}]"
            fields(room, {"id", "name", "polygon", "material"}, rp, {"ha_area_id"})
            text(room["name"], rp + ".name")
            if "ha_area_id" in room:
                text(room["ha_area_id"], rp + ".ha_area_id", 128)
            if room["material"] not in ("floor", "tile", "deck"):
                fail(rp + ".material", "choose floor, tile or deck")
            validate_polygon(room["polygon"], rp + ".polygon")
        if sum(len(room["polygon"]) for room in floor["rooms"]) > 2048:
            fail(path + ".rooms", "at most 2,048 polygon vertices are supported per floor")
        for ri, room in enumerate(floor["rooms"]):
            for prior in floor["rooms"][:ri]:
                if rooms_overlap(room["polygon"], prior["polygon"]):
                    fail(f"{path}.rooms[{ri}].polygon", f"room interiors overlap: {room['id']} and {prior['id']}")
        walls = {}
        for wi, wall in enumerate(floor["walls"]):
            wp = f"{path}.walls[{wi}]"
            fields(wall, {"id", "start", "end", "thickness_m"}, wp)
            point(wall["start"], wp + ".start")
            point(wall["end"], wp + ".end")
            number(wall["thickness_m"], wp + ".thickness_m", .04, 2)
            if math.dist(wall["start"], wall["end"]) < .05:
                fail(wp, "wall length must be at least 0.05 m")
            for prior in walls.values():
                if collinear_overlap(wall["start"], wall["end"], prior["start"], prior["end"]):
                    fail(wp, f"wall overlaps {prior['id']}; use a single shared wall")
                if proper_cross(wall["start"], wall["end"], prior["start"], prior["end"]):
                    fail(wp, f"wall crosses {prior['id']}; split walls at the intersection")
            walls[wall["id"]] = wall
        openings = {}
        for oi, opening in enumerate(floor["openings"]):
            op = f"{path}.openings[{oi}]"
            fields(opening, {"id", "wall_id", "type", "offset_m", "width_m", "sill_m", "head_m"}, op)
            identifier(opening["wall_id"], op + ".wall_id")
            if opening["wall_id"] not in walls:
                fail(op + ".wall_id", "unknown wall ID " + opening["wall_id"])
            if opening["type"] not in ("door", "window", "passage"):
                fail(op + ".type", "choose door, window or passage")
            length = math.dist(walls[opening["wall_id"]]["start"], walls[opening["wall_id"]]["end"])
            offset = number(opening["offset_m"], op + ".offset_m", 0, length)
            width = number(opening["width_m"], op + ".width_m", .05, length)
            sill = number(opening["sill_m"], op + ".sill_m", 0, height)
            head = number(opening["head_m"], op + ".head_m", 0, height)
            if offset + width > length + EPS:
                fail(op, "opening extends beyond the wall; reduce offset_m or width_m")
            if head - sill < .05:
                fail(op, "head_m must be at least 0.05 m above sill_m")
            if opening["type"] in ("door", "passage") and sill != 0:
                fail(op + ".sill_m", "doors and passages must start at floor level (0)")
            for prior in openings.setdefault(opening["wall_id"], []):
                if min(offset + width, prior["offset_m"] + prior["width_m"]) - max(offset, prior["offset_m"]) > EPS:
                    fail(op, "opening overlaps " + prior["id"])
            openings[opening["wall_id"]].append(opening)
        room_ids = {room["id"] for room in floor["rooms"]}
        for ii, item in enumerate(floor["items"]):
            ip = f"{path}.items[{ii}]"
            fields(item, {"id", "name", "type", "room", "position_m", "dimensions_m", "rotation_deg", "entity_id", "notes"}, ip,
                   {"model_id", "style_id", "color", "pattern_id", "pattern_color", "curtain"})
            text(item["name"], ip + ".name", 100)
            text(item["type"], ip + ".type", 30)
            if item["type"] not in KINDS:
                fail(ip + ".type", "unsupported inventory type; choose " + ", ".join(sorted(KINDS)))
            try:
                validate_furniture_appearance(item)
            except ValueError as error:
                fail(ip, str(error))
            identifier(item["room"], ip + ".room")
            if item["room"] not in room_ids:
                fail(ip + ".room", "unknown room ID " + item["room"])
            fields(item["position_m"], {"x", "y", "z"}, ip + ".position_m")
            for axis in ("x", "y", "z"):
                number(item["position_m"][axis], ip + ".position_m." + axis, 0 if axis == "y" else -100, height if axis == "y" else 100)
            fields(item["dimensions_m"], {"width", "depth", "height"}, ip + ".dimensions_m")
            for axis in ("width", "depth", "height"):
                number(item["dimensions_m"][axis], ip + ".dimensions_m." + axis, .001, 100)
            if item["position_m"]["y"] + item["dimensions_m"]["height"] > height + EPS:
                fail(ip, "object extends above the ceiling; reduce its Y position or height")
            number(item["rotation_deg"], ip + ".rotation_deg", -36000, 36000)
            entity = text(item["entity_id"], ip + ".entity_id", 150, empty=True)
            if entity and not re.fullmatch(r"[a-z_]+\.[a-z0-9_]+", entity):
                fail(ip + ".entity_id", "expected an empty string or Home Assistant domain.object_id")
            text(item["notes"], ip + ".notes", 2000, empty=True, multiline=True)
            if "curtain" in item:
                binding = item["curtain"]
                fields(binding, {"opening_id", "mode"}, ip + ".curtain")
                identifier(binding["opening_id"], ip + ".curtain.opening_id")
                if not supports_curtain(MODELS.get(item.get("model_id"))):
                    fail(ip + ".curtain", "a curtain binding requires a curtain design")
                if binding["mode"] not in ("left", "right", "pair"):
                    fail(ip + ".curtain.mode", "choose left, right, or pair")
                if not any(opening["id"] == binding["opening_id"] and opening["type"] == "window" for opening in floor["openings"]):
                    fail(ip + ".curtain.opening_id", "choose an existing window on this floor")
                if entity and not entity.startswith("cover."):
                    fail(ip + ".entity_id", "a bound curtain requires a cover entity or an empty entity ID")
    return copy.deepcopy(project)


def _load_project_source(path):
    path = Path(path)
    with path.open("rb") as source:
        raw = source.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        fail("project", f"file exceeds {MAX_BYTES:,} bytes")
    def pairs(entries):
        result = {}
        for key, value in entries:
            if key in result:
                fail("project", "duplicate JSON property " + key)
            result[key] = value
        return result
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs,
                           parse_constant=lambda v: fail("project", "non-finite JSON number " + v))
    except (UnicodeError, json.JSONDecodeError, RecursionError, ValueError) as error:
        if isinstance(error, ProjectError):
            raise
        fail("project", "invalid UTF-8 JSON: " + str(error))
    return validate_project(value), raw


def load_project(path):
    return _load_project_source(path)[0]


def site_id(project):
    return project.get("id") or "home_" + hashlib.sha256(project["title"].encode()).hexdigest()[:16]


def box(g, name, start, direction, left, right, depth, bottom, top, material="wall", kind="walls", **meta):
    """Closed outward-facing oriented box, measured along a wall centerline."""
    if right - left < EPS or top - bottom < EPS:
        return
    ux, uz = direction
    corners = [(left, -depth / 2), (right, -depth / 2), (right, depth / 2), (left, depth / 2)]
    vertices = [[start[0] + ux * u - uz * v, y, start[1] + uz * u + ux * v] for y in (bottom, top) for u, v in corners]
    faces = [[0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 5, 1], [0, 4, 5],
             [1, 6, 2], [1, 5, 6], [2, 7, 3], [2, 6, 7], [3, 4, 0], [3, 7, 4]]
    g.mesh(name, vertices, faces, material, kind, **meta)


def clean_polygon(poly):
    # Ear clipping in the shared primitive expects no redundant straight vertices.
    result = list(poly)
    while len(result) > 3:
        for i, p in enumerate(result):
            if abs(cross(result[i - 1], p, result[(i + 1) % len(result)])) <= EPS:
                result.pop(i)
                break
        else:
            break
    # The shared floor cap triangulator normalizes winding internally; its side
    # faces use the supplied outline, so normalize that outline too.
    return result if area(result) > 0 else list(reversed(result))


def make_floor(project, floor, next_floor):
    g = create_geometry([(0, 0), (1, 1)], [(0, 0), (1, 1)], floor["height_m"])
    for room in floor["rooms"]:
        g.floor("room_" + room["id"], clean_polygon(room["polygon"]), room["material"])
    openings = []
    for wall in floor["walls"]:
        start, end = wall["start"], wall["end"]
        length = math.dist(start, end)
        direction = [(end[i] - start[i]) / length for i in (0, 1)]
        cursor = 0
        cuts = sorted((o for o in floor["openings"] if o["wall_id"] == wall["id"]), key=lambda o: o["offset_m"])
        def segment(name, a, b, y0, y1, material="wall", kind="walls", depth=None):
            box(g, name, start, direction, a, b, depth or wall["thickness_m"], y0, y1, material, kind, wall_id=wall["id"])
        for oi, opening in enumerate(cuts):
            a, b = opening["offset_m"], opening["offset_m"] + opening["width_m"]
            sill, head = opening["sill_m"], opening["head_m"]
            segment(f"wall_{wall['id']}_solid_{oi}", cursor, a, 0, floor["height_m"])
            segment("opening_" + opening["id"] + "_sill", a, b, 0, sill)
            segment("opening_" + opening["id"] + "_lintel", a, b, head, floor["height_m"])
            if opening["type"] != "passage":
                frame = min(.035, (b - a) / 5, (head - sill) / 5)
                for suffix, aa, bb, y0, y1 in (("left", a, a + frame, sill, head), ("right", b - frame, b, sill, head), ("head", a + frame, b - frame, head - frame, head)):
                    segment("opening_" + opening["id"] + "_" + suffix, aa, bb, y0, y1, "frame", "frames")
                if opening["type"] == "window":
                    segment("opening_" + opening["id"] + "_bottom", a + frame, b - frame, sill, sill + frame, "frame", "frames")
                    segment("opening_" + opening["id"] + "_glass", a + frame, b - frame, sill + frame, head - frame, "glass", "windows", .012)
            openings.append({**opening, "start_m": [start[i] + a * direction[i] for i in (0, 1)], "end_m": [start[i] + b * direction[i] for i in (0, 1)], "thickness_m": wall["thickness_m"]})
            cursor = b
        segment(f"wall_{wall['id']}_solid_{len(cuts)}", cursor, length, 0, floor["height_m"])
    materials, object_assets = dict(MATERIALS), {}
    for item_index, item in enumerate(floor["items"]):
        p, d = item["position_m"], item["dimensions_m"]
        angle = math.radians(item["rotation_deg"])
        # The ordinal makes each item's namespace unambiguous even when a
        # portable user ID looks like another item's generated part suffix.
        item_name = f"item_{item_index}_{item['id']}"
        asset = build_furniture_asset(item)
        if asset is None:
            box(g, item_name, [p["x"], p["z"]], [math.cos(angle), -math.sin(angle)], -d["width"] / 2, d["width"] / 2,
                d["depth"], p["y"], p["y"] + d["height"], "dark" if item["type"] == "tv" else "added", "inventory", item_id=item["id"], entity_id=item["entity_id"])
            continue
        object_assets[item["id"]] = {"model_id": item["model_id"], "meshes": asset["meshes"]}
        materials.update(asset["materials"])
        cosine, sine = math.cos(angle), math.sin(angle)
        for part in asset["meshes"]:
            vertices = []
            for x, y, z in part["vertices"]:
                x, z = x * d["width"], z * d["depth"]
                vertices.append([p["x"] + cosine * x + sine * z, p["y"] + y * d["height"], p["z"] - sine * x + cosine * z])
            faces = [part["indices"][index:index + 3] for index in range(0, len(part["indices"]), 3)]
            g.mesh(item_name + "_" + part["name"], vertices, faces, part["material"], "inventory",
                   item_id=item["id"], entity_id=item["entity_id"], model_id=item["model_id"])
    points = [p for mesh in g.meshes for p in mesh["vertices"]]
    minx, maxx = min(p[0] for p in points), max(p[0] for p in points)
    minz, maxz = min(p[2] for p in points), max(p[2] for p in points)
    scale, margin = 100, 50
    width, depth = maxx - minx, maxz - minz
    size = [math.ceil(width * scale + margin * 2), math.ceil(depth * scale + margin * 2)]
    def pixel(p):
        return [(p[0] - minx) * scale + margin, (p[1] - minz) * scale + margin]
    rooms = []
    for room in floor["rooms"]:
        poly = room["polygon"]
        # A top-triangle centroid is guaranteed to lie within a concave room.
        mesh = next(m for m in g.meshes if m["name"] == "room_" + room["id"])
        top = next([mesh["vertices"][j] for j in mesh["indices"][i:i + 3]] for i in range(0, len(mesh["indices"]), 3)
                   if all(abs(mesh["vertices"][j][1]) < EPS for j in mesh["indices"][i:i + 3]))
        label = pixel([sum(p[0] for p in top) / 3, sum(p[2] for p in top) / 3])
        rooms.append({**room, "polygon": [pixel(p) for p in poly], "label": label})
    for opening in openings:
        a, b = pixel(opening["start_m"]), pixel(opening["end_m"])
        half = opening["thickness_m"] * scale / 2
        opening["rect"] = [min(a[0], b[0]) - half, min(a[1], b[1]) - half, max(a[0], b[0]) + half, max(a[1], b[1]) + half]
    data = dict(schema_version=1, id=floor["id"], title=floor["name"], project_title=project["title"], floor=floor["id"],
                site_id=site_id(project), storage_key=site_id(project) + ":" + floor["id"], site_features=False, units="metres", up_axis="Y",
                ceiling_height_m=floor["height_m"], elevation_m=floor["elevation_m"], origin="Floor-local metric coordinates; Y=0 at finished floor",
                calibration=dict(reference_size=size, source_size=size, x_anchors=[[margin, minx], [margin + width * scale, maxx]], z_anchors=[[margin, minz], [margin + depth * scale, maxz]]),
                dimensions_m=dict(width=width, depth=depth, height=floor["height_m"]), bounds_m=dict(min_x=minx, min_z=minz, max_x=maxx, max_z=maxz),
                dimension_checks=[], rooms=rooms, materials=materials, meshes=g.meshes, openings=openings, inventory=[{key: value for key, value in item.items() if key != "curtain"} for item in floor["items"]], object_assets=object_assets,
                initial_room=None, next_floor=next_floor, exterior_rooms=[r["id"] for r in floor["rooms"] if r["material"] == "deck"], exports=["glb", "obj", "mtl", "dae", "usda"])
    for name in ("room_activity", "receiver_activity", "motion_paths", "motion_sources", "motion_zones", "cover_windows", "control_anchors", "control_groups", "room_views", "room_display_names", "room_display_ids", "camera_entities", "tv_entities"):
        data[name] = {}
    data["cover_windows"] = {item["id"]: {"openings": [item["curtain"]["opening_id"]], "mode": item["curtain"]["mode"]}
                             for item in floor["items"] if "curtain" in item}
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size[0]} {size[1]}" width="{size[0]}" height="{size[1]}"><title>{html.escape(project["title"] + " — " + floor["name"])}</title><rect width="100%" height="100%" fill="#f7f5ef"/>']
    for room in rooms:
        color = {"floor": "#d8c7a4", "tile": "#c3d3cd", "deck": "#a8b8a3"}[room["material"]]
        coords = " ".join(f"{x:.3f},{z:.3f}" for x, z in room["polygon"])
        svg.append(f'<polygon points="{coords}" fill="{color}" stroke="#87958a" stroke-width="1"/>')
    for wall in floor["walls"]:
        a, b = pixel(wall["start"]), pixel(wall["end"])
        svg.append(f'<path d="M{a[0]:.3f},{a[1]:.3f} L{b[0]:.3f},{b[1]:.3f}" stroke="#445a59" stroke-width="{wall["thickness_m"] * scale:.3f}"/>')
    for opening in openings:
        a, b = pixel(opening["start_m"]), pixel(opening["end_m"])
        svg.append(f'<path d="M{a[0]:.3f},{a[1]:.3f} L{b[0]:.3f},{b[1]:.3f}" stroke="#f7f5ef" stroke-width="{opening["thickness_m"] * scale + 1:.3f}"/>')
        if opening["type"] == "window":
            svg.append(f'<path d="M{a[0]:.3f},{a[1]:.3f} L{b[0]:.3f},{b[1]:.3f}" stroke="#53a5bd" stroke-width="3"/>')
    # Top-facing furniture surfaces produce the same footprints and finishes in
    # the portable plan as in the 3D scene, including rotation and raised items.
    tops = []
    for mesh in g.meshes:
        if mesh["kind"] != "inventory":
            continue
        for index in range(0, len(mesh["indices"]), 3):
            indices = mesh["indices"][index:index + 3]
            if mesh["normals"][indices[0]][1] <= .01:
                continue
            triangle = [mesh["vertices"][j] for j in indices]
            tops.append((sum(v[1] for v in triangle) / 3, mesh["material"], triangle))
    svg.append('<g id="furniture">')
    for _, material, triangle in sorted(tops, key=lambda entry: entry[0]):
        if material.startswith("furniture_"):
            color = "#" + material[len("furniture_"):]
        else:
            color = "#" + "".join(f"{round(channel * 255):02x}" for channel in materials[material][:3])
        coords = " ".join(f"{x:.3f},{z:.3f}" for x, z in (pixel([v[0], v[2]]) for v in triangle))
        svg.append(f'<polygon points="{coords}" fill="{color}"/>')
    svg.append("</g></svg>")
    return data, "".join(svg)


def json_text(value, pretty=False):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2 if pretty else None, separators=None if pretty else (",", ":"))


def runtime_model_data(data):
    """Keep one renderable representation of editable inventory in HA assets.

    Export formats still receive every transformed mesh. The runtime builds
    furniture from normalized object_assets and placements, so retaining those
    transformed copies would double geometry data and exceed package limits.
    """
    return {**data, "meshes": [mesh for mesh in data["meshes"] if mesh["kind"] != "inventory"]}


def render_viewer(data, svg):
    template = (ROOT / "viewer.template.html").read_text(encoding="utf-8")
    # Saved model downloads represent the built project. The editable viewer
    # must not leave those static furniture silhouettes behind after a move.
    viewer_plan = re.sub(r'<g id="furniture">.*?</g>', '', svg, flags=re.S)
    viewer_i18n = json.dumps(load_viewer_i18n(ROOT), ensure_ascii=False, separators=(",", ":"))
    replacements = {
        "__VIEWER_I18N_JS__": (ROOT / "viewer-i18n.js").read_text(encoding="utf-8"),
        "__VIEWER_I18N_DATA__": viewer_i18n.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"),
        "__VIEWER_JS__": (ROOT / "viewer.js").read_text(encoding="utf-8"),
        "__HOME_HTML__": (ROOT / "home-view.html").read_text(encoding="utf-8"),
        "__HOME_CSS__": (ROOT / "home-view.css").read_text(encoding="utf-8"),
        "__HOME_JS__": "\n".join((ROOT / name).read_text(encoding="utf-8") for name in ("curtain-state.js", "motion-state.js", "appliance-state.js", "presence-view.js", "vacuum-state.js", "vacuum-view.js", "tv-screen.js", "camera-preview.js", "media-preview.js", "assumed-zone-view.js", "home-view.js")),
        "__LIGHT_STATE_JS__": (ROOT / "light-state.js").read_text(encoding="utf-8"),
        "__RENDER_CAPACITY_JS__": (ROOT / "planner/render-capacity.js").read_text(encoding="utf-8").replace("export function getRenderCapacity", "function getRenderCapacity"),
        "/*__ENVIRONMENT_JS__*/": (ROOT / "planner/environment.js").read_text(encoding="utf-8").replace("export ", ""),
        "__INTERACTION_RENDER_JS__": (ROOT / "planner/interaction-render.js").read_text(encoding="utf-8").replace("export function createInteractionRenderer", "function createInteractionRenderer"),
        "__ROOM_LIGHTING_JS__": (ROOT / "room-lighting.js").read_text(encoding="utf-8"),
        "/*__MATERIAL_TEXTURES_JS__*/": (ROOT / "material-textures.js").read_text(encoding="utf-8"),
        "__THREE_B64__": base64.b64encode((ROOT / "vendor/three.module.min.js").read_bytes()).decode(),
        "__PLAN_MIME__": "image/svg+xml", "__PLAN_DATA__": base64.b64encode(viewer_plan.encode()).decode(),
        "__PLAN_WIDTH__": str(data["calibration"]["reference_size"][0]), "__PLAN_HEIGHT__": str(data["calibration"]["reference_size"][1]),
        "__MODEL_STEM__": data["id"], "__FLOOR_TITLE__": html.escape(data["title"]),
        "__OTHER_URL__": data["next_floor"]["url"] if data["next_floor"] else "#",
        "__OTHER_TITLE__": html.escape(data["next_floor"]["title"]) if data["next_floor"] else "Only floor",
        "__ASSUMPTIONS__": "<p>Authored geometry in metres. Check measurements, wall thickness, opening heights and object dimensions before use. Floor elevations align a muted lower-floor outline; exported models remain separate.</p>",
    }
    # Expand source fragments before inserting user text, so a title resembling a
    # template token cannot trigger a replacement inside the model or HTML.
    source_tokens = {k: v for k, v in replacements.items() if k.endswith(("_JS__", "_JS__*/")) or k in {"__HOME_HTML__", "__HOME_CSS__"}}
    token = re.compile("|".join(map(re.escape, replacements)))
    while any(key in template for key in source_tokens):
        template = token.sub(lambda m: source_tokens.get(m.group(), m.group()), template)
    validate_material_textures(data)
    viewer_data = runtime_model_data(data)
    replacements["__MODEL_JSON__"] = json_text(viewer_data).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    token = re.compile("|".join(map(re.escape, replacements)))
    return token.sub(lambda m: replacements[m.group()], template)


def normalize_glb(path, data):
    """Keep the shared export geometry while replacing legacy scene metadata."""
    raw = path.read_bytes()
    length = struct.unpack_from("<I", raw, 12)[0]
    document = json.loads(raw[20:20 + length])
    document["asset"]["generator"] = "Home planner project compiler"
    document["scenes"][0]["name"] = data["id"]
    document["extras"] = {"units": "metres", "ceiling_height": data["ceiling_height_m"], "elevation_m": data["elevation_m"], "site_id": data["site_id"]}
    payload = json_text(document).encode()
    payload += b" " * (-len(payload) % 4)
    binary_chunk = raw[20 + length:]
    path.write_bytes(struct.pack("<III", 0x46546C67, 2, 20 + len(payload) + len(binary_chunk)) + struct.pack("<II", len(payload), 0x4E4F534A) + payload + binary_chunk)


def package_ha(output, manifest):
    """Allowlist integration code and newly generated assets, never old assets."""
    base = "custom_components/home_floorplan"
    component = ROOT / base
    configs = {"site.json": manifest, "curtains.json": {}, "motion-room.json": {},
               "room-activity.json": {"floor": manifest["default_floor"], "rooms": {}, "sources": [], "receivers": []},
               "assumed-activity.json": {"schema": "ruview.assumed-activity.config.v1", "coordinate_frame": manifest["site_id"], "geometry_assumed": False, "receivers": [], "zones": []}}
    with tarfile.open(output / "home-floorplan.tar.gz", "w:gz") as archive:
        # This is a portable distribution, not a copy of the local installation.
        # Private adapters are deliberately outside this reviewed source list.
        sources = [component / name for name in (
            "__init__.py", "site.py", "validation.py", "curtains.py",
            "manifest.json", "native.py", "generated.py", "permissions.py", "config_flow.py",
            "strings.json", "translations/en.json", "static/panel.js", "static/card.js",
        )]
        for source in sources:
            if source.is_symlink():
                fail("ha-package", "refusing symlink source " + str(source))
            archive.add(source, arcname=base + "/" + source.relative_to(component).as_posix(), recursive=False)
        license_path = ROOT / "LICENSE"
        if not license_path.exists():
            license_path = ROOT / "public-site/LICENSE"
        for source, name in ((license_path, "LICENSE"), (ROOT / "vendor/THREE-LICENSE.txt", "THREE-LICENSE.txt")):
            if not source.is_file() or source.is_symlink():
                fail("ha-package", "missing regular license file " + source.name)
            archive.add(source, arcname=base + "/" + name, recursive=False)
        for name, value in configs.items():
            contents = (json_text(value, True) + "\n").encode()
            entry = tarfile.TarInfo(base + "/" + name)
            entry.size, entry.mode = len(contents), 0o644
            archive.addfile(entry, io.BytesIO(contents))
        for floor_id in manifest["floors"]:
            for source in sorted((output / floor_id).iterdir()):
                archive.add(source, arcname=base + "/assets/" + floor_id + "/" + source.name, recursive=False)


def compile_project(project, output=DEFAULT_OUTPUT, ha_package=False, project_path=None):
    """Validate and stage all floors, then replace only a compiler-owned directory."""
    project = validate_project(project)
    requested = Path(output).expanduser().absolute()
    if requested.is_symlink():
        fail("output", "symlink destinations are not supported")
    output = requested.resolve()
    if output == ROOT or ROOT.is_relative_to(output):
        fail("output", "choose a separate build directory, never the repository or one of its parents")
    if project_path and Path(project_path).resolve().is_relative_to(output):
        fail("output", "the project input must not be inside the replaceable output directory")
    if output.exists():
        if not output.is_dir():
            fail("output", "expected a directory")
        if any(output.iterdir()):
            try:
                owned = json.loads((output / MARKER).read_text(encoding="utf-8")).get("generator") == "home-planner-v1"
            except (OSError, ValueError, AttributeError):
                owned = False
            if not owned:
                fail("output", "directory is not compiler-owned; choose an empty directory or an earlier planner build")
    snapshot = json_text(project).encode("utf-8")
    if len(snapshot) > MAX_BYTES and project_path:
        # Python may render 1e-7 as 1e-07. Preserve a validated source rather
        # than round numbers or export a snapshot that cannot be opened.
        source_project, source_bytes = _load_project_source(project_path)
        if source_project != project:
            fail("project", "input changed before compilation; reload it and retry")
        snapshot = source_bytes
    if len(snapshot) > MAX_BYTES:
        fail("project", f"serialized snapshot exceeds {MAX_BYTES:,} bytes")
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix="." + output.name + "-build-", dir=output.parent))
    backup = None
    try:
        manifest = {"schema_version": 1, "site_id": site_id(project), "default_floor": project["floors"][0]["id"],
                    "floors": {f["id"]: {"stem": f["id"], "title": f["name"]} for f in project["floors"]}, "site_features": False}
        compiled = []
        for i, floor in enumerate(project["floors"]):
            following = project["floors"][(i + 1) % len(project["floors"])]
            next_floor = {"id": following["id"], "title": following["name"], "url": "../" + following["id"] + "/index.html"} if len(project["floors"]) > 1 else None
            data, svg = make_floor(project, floor, next_floor)
            compiled.append((floor, data, svg))
        site_bounds = dict(minX=min(d["bounds_m"]["min_x"] for _, d, _ in compiled), maxX=max(d["bounds_m"]["max_x"] for _, d, _ in compiled),
                           minZ=min(d["bounds_m"]["min_z"] for _, d, _ in compiled), maxZ=max(d["bounds_m"]["max_z"] for _, d, _ in compiled))
        ground_elevation = min(d["elevation_m"] for _, d, _ in compiled)
        for floor, data, svg in compiled:
            data["environment"] = dict(enabled=False, motion=False, palette="sage", bounds=site_bounds, elevation=ground_elevation - data["elevation_m"])
            below = [other for _, other, _ in compiled if other['elevation_m'] < data['elevation_m']]
            if below:
                lower = max(below, key=lambda other: other['elevation_m'])
                data['lower_floor_context'] = floor_context(lower['meshes'], lower['elevation_m'] - data['elevation_m'])
            folder = stage / floor["id"]
            folder.mkdir()
            (folder / "model-data.json").write_text(json_text(runtime_model_data(data)), encoding="utf-8")
            (folder / "plan.svg").write_text(svg, encoding="utf-8")
            inventory = {"schema_version": 1, "model": floor["id"], "units": "metres", "up_axis": "Y", "items": floor["items"]}
            (folder / "inventory.json").write_text(json_text(inventory, True) + "\n", encoding="utf-8")
            (folder / "inventory-template.json").write_text(json_text({**inventory, "items": []}, True) + "\n", encoding="utf-8")
            export_models(data, folder, floor["id"])
            normalize_glb(folder / (floor["id"] + ".glb"), data)
            (folder / "index.html").write_text(render_viewer(data, svg), encoding="utf-8")
        (stage / "site.json").write_text(json_text(manifest, True) + "\n", encoding="utf-8")
        # Keep the editable snapshot within the same byte limit as its input.
        # Pretty-printing can turn a valid near-limit project into an unreadable one.
        (stage / "project.json").write_bytes(snapshot)
        links = "".join('<li><a href="' + f["id"] + '/index.html">' + html.escape(f["name"]) + "</a></li>" for f in project["floors"])
        (stage / "index.html").write_text('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + html.escape(project["title"]) + '</title><h1>' + html.escape(project["title"]) + '</h1><p>Choose a floor</p><ul>' + links + "</ul></html>", encoding="utf-8")
        (stage / MARKER).write_text(json_text({"generator": "home-planner-v1", "site_id": manifest["site_id"]}) + "\n", encoding="utf-8")
        if ha_package:
            package_ha(stage, manifest)
        if output.exists():
            backup = Path(tempfile.mkdtemp(prefix="." + output.name + "-previous-", dir=output.parent))
            backup.rmdir()
            os.replace(output, backup)
        try:
            os.replace(stage, output)
        except OSError:
            if backup:
                os.replace(backup, output)
            raise
        if backup:
            shutil.rmtree(backup)
        return {"output": str(output), "site_id": manifest["site_id"], "floors": list(manifest["floors"]), "ha_package": str(output / "home-floorplan.tar.gz") if ha_package else None}
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def export_geometry_budget(floors, maximum=200_000):
    """Bound mesh generation before allocating the export's triangle arrays."""
    triangles = 0
    for floor in floors:
        triangles += len(floor['walls']) * 60 + len(floor['openings']) * 48
        triangles += sum(len(room['polygon']) * 4 for room in floor['rooms'])
        for item in floor['items']:
            asset = build_furniture_asset(item)
            triangles += sum(len(mesh['indices']) // 3 for mesh in asset['meshes']) if asset else 12
            if triangles > maximum:
                fail('export', 'Export exceeds 200,000 triangles. Export one floor or reduce detailed furniture.')
        if triangles > maximum:
            fail('export', 'Export exceeds 200,000 triangles. Export one floor or reduce detailed furniture.')


def export_floor(model, floor, reference_items=None, *, elevated=False):
    """Build a geometry-only scene preserving custom normalized object assets.

    Raw legacy item meshes are converted back to their original local frame, so
    current placements can be applied without losing their custom geometry.
    Architecture is copied directly from the trusted model, never reconstructed
    from a generated home's deliberately incomplete authoring projection.
    """
    references = {item['id']: item for item in (reference_items or floor['items'])}
    item_ids = set(references) | {item['id'] for item in floor['items']}
    groups = []
    materials = model['materials']
    validate_material_textures(model)

    def mesh_data(mesh, dimensions=None):
        result = {key: mesh[key] for key in ('vertices', 'normals', 'indices')} | {'color': materials[mesh['material']], 'material_name': mesh['material']}
        if 'albedo_texture' in mesh:
            result['uv'] = material_uv(mesh, dimensions)
            result['texture'] = model['material_textures'][mesh['albedo_texture']]
        return result

    for index, mesh in enumerate(model['meshes']):
        if mesh.get('kind') == 'inventory' and mesh.get('item_id') in item_ids:
            continue
        groups.append({'name': 'Architecture ' + str(index + 1), 'translation': [0, 0, 0],
                       'rotation': 0, 'scale': [1, 1, 1], 'meshes': [mesh_data(mesh)]})
    for item_number, item in enumerate(floor['items'], 1):
        position, dimensions = item['position_m'], item['dimensions_m']
        display_name = MODELS.get(item.get('model_id'), {}).get('label') or item['type'].replace('_', ' ').title()
        group = {'name': display_name + ' ' + str(item_number), 'translation': [position[axis] for axis in ('x', 'y', 'z')],
                 'rotation': math.radians(item['rotation_deg']),
                 'scale': [dimensions[axis] for axis in ('width', 'height', 'depth')], 'meshes': []}
        asset = model.get('object_assets', {}).get(item['id'])
        original = references.get(item['id'], item)
        source_model_id = asset.get('model_id') if asset else original.get('model_id')
        replaced_asset = bool(source_model_id and source_model_id != item.get('model_id'))
        if replaced_asset:
            asset = None
        if asset:
            group['meshes'] = [mesh_data(mesh, dimensions) for mesh in asset['meshes']]
        else:
            original_position, size = original['position_m'], original['dimensions_m']
            cosine, sine = math.cos(math.radians(original['rotation_deg'])), math.sin(math.radians(original['rotation_deg']))
            for mesh in (() if replaced_asset else model['meshes']):
                if mesh.get('kind') != 'inventory' or mesh.get('item_id') != item['id']:
                    continue
                local = mesh_data(mesh)
                vertices, normals = [], []
                for x, y, z in mesh['vertices']:
                    x, y, z = x-original_position['x'], y-original_position['y'], z-original_position['z']
                    vertices.append([(cosine*x-sine*z)/size['width'], y/size['height'], (sine*x+cosine*z)/size['depth']])
                for x, y, z in mesh['normals']:
                    normal = [(cosine*x-sine*z)*size['width'], y*size['height'], (sine*x+cosine*z)*size['depth']]
                    length = math.sqrt(sum(value*value for value in normal)) or 1
                    normals.append([value/length for value in normal])
                local.update(vertices=vertices, normals=normals)
                group['meshes'].append(local)
            if not group['meshes']:
                # New simple objects have the same bottom-centred unit box as
                # the native compiler and live viewer.
                geometry = create_geometry([(0, 0), (1, 1)], [(0, 0), (1, 1)])
                geometry.box_m('object', -.5, -.5, .5, .5, 0, 1)
                color = MATERIALS['dark' if item['type'] == 'tv' else 'added']
                group['meshes'] = [{key: mesh[key] for key in ('vertices', 'normals', 'indices')} | {'color': color}
                                   for mesh in geometry.meshes]
        groups.append(group)
    return {'name': 'Floor', 'elevation': floor['elevation_m'] if elevated else 0, 'groups': groups}


def render_model_export(floors, format):
    # This relative import also works in the packaged HA runtime namespace.
    if __package__ and '.' in __package__:
        from ..exporters import export_scene
    else:
        from exporters import export_scene
    return export_scene(floors, format)
