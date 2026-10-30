"""Validation for portable local site geometry, independent of geographic maps."""
import math
import re

SITE_KINDS = ("home", "roof", "building", "street", "landscape")
SITE_LIMITS = dict(features=64, points=64, totalPoints=1024, coordinate=1000, groundElevation=100, height=100)
EPS = 1e-8
# Match JavaScript String.trim exactly, including BOM and excluding NEL.
NAME_WHITESPACE = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
ID = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}\Z")
RESERVED = {"__proto__", "prototype", "constructor", "toString", "valueOf", "hasOwnProperty",
            "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
            "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"}


def _fields(value, keys, label, optional=()):
    if not isinstance(value, dict):
        raise ValueError(f"{label}: expected an object")
    if set(keys) - value.keys():
        raise ValueError(f"{label}: missing fields")
    if value.keys() - set(keys) - set(optional):
        raise ValueError(f"{label}: unknown fields")


def _number(value, low, high, label):
    try:
        valid = not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) and low <= value <= high
    except OverflowError:
        valid = False
    if not valid:
        raise ValueError(f"{label}: expected a finite number between {low} and {high}")


def _cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _on_edge(p, a, b):
    return abs(_cross(a, b, p)) <= EPS and all(min(a[i], b[i]) - EPS <= p[i] <= max(a[i], b[i]) + EPS for i in (0, 1))


def _intersects(a, b, c, d):
    def opposite(x, y):
        return x > EPS and y < -EPS or y > EPS and x < -EPS
    return (opposite(_cross(a, b, c), _cross(a, b, d)) and opposite(_cross(c, d, a), _cross(c, d, b)) or
            any((_on_edge(a, c, d), _on_edge(b, c, d), _on_edge(c, a, b), _on_edge(d, a, b))))


def validate_site(site):
    """Validate without modifying the source; return the same site object."""
    _fields(site, ("ground_elevation_m", "features"), "Site")
    _number(site["ground_elevation_m"], -SITE_LIMITS["groundElevation"], SITE_LIMITS["groundElevation"], "Site ground elevation")
    features = site["features"]
    if not isinstance(features, list) or len(features) > SITE_LIMITS["features"]:
        raise ValueError("Site: at most 64 features are allowed")
    ids, count = set(), 0
    for feature in features:
        _fields(feature, ("id", "name", "kind", "polygon", "height_m", "color"), "Site feature", ("render_style",))
        identifier = feature["id"]
        if not isinstance(identifier, str) or not ID.fullmatch(identifier) or identifier in RESERVED:
            raise ValueError("Site feature: invalid identifier")
        if identifier in ids:
            raise ValueError(f"Site: duplicate identifier {identifier}")
        ids.add(identifier)
        name = feature["name"]
        if not isinstance(name, str) or not name.strip(NAME_WHITESPACE) or len(name) > 120 or any(ord(c) < 32 or 0xd800 <= ord(c) <= 0xdfff for c in name):
            raise ValueError("Site feature: name must be nonempty text of at most 120 characters without control characters or invalid Unicode")
        if feature["kind"] not in SITE_KINDS:
            raise ValueError("Site feature: invalid kind")
        if "render_style" in feature and (feature["kind"] != "building" or feature["render_style"] not in ("outline", "solid")):
            raise ValueError("Site feature: render style must be outline or solid, for a neighboring building only")
        if not isinstance(feature["color"], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", feature["color"]):
            raise ValueError("Site feature: color must be #RRGGBB")
        _number(feature["height_m"], 0, SITE_LIMITS["height"], "Site feature height")
        if feature["kind"] in ("street", "landscape") and feature["height_m"] != 0:
            raise ValueError("Street and landscape heights must be zero")
        polygon = feature["polygon"]
        if not isinstance(polygon, list) or not 3 <= len(polygon) <= SITE_LIMITS["points"]:
            raise ValueError("Site feature: use 3–64 polygon points")
        count += len(polygon)
        if count > SITE_LIMITS["totalPoints"]:
            raise ValueError("Site: at most 1024 polygon points are allowed")
        for point in polygon:
            if not isinstance(point, list) or len(point) != 2:
                raise ValueError("Site polygon point must be [x, z]")
            for value in point:
                _number(value, -SITE_LIMITS["coordinate"], SITE_LIMITS["coordinate"], "Site coordinate")
        area = 0
        for i, a in enumerate(polygon):
            b, c = polygon[(i + 1) % len(polygon)], polygon[(i + 2) % len(polygon)]
            area += a[0] * b[1] - b[0] * a[1]
            if math.dist(a, b) < .01:
                raise ValueError("Site polygon edges must be at least 0.01 m long")
            if abs(_cross(a, b, c)) <= EPS and sum((a[j] - b[j]) * (c[j] - b[j]) for j in (0, 1)) > EPS:
                raise ValueError("Site polygon edges cannot overlap or reverse direction")
            for j in range(i + 1, len(polygon)):
                if j == i + 1 or i == 0 and j == len(polygon) - 1:
                    continue
                if _intersects(a, b, polygon[j], polygon[(j + 1) % len(polygon)]):
                    raise ValueError("Site polygon edges cannot cross or touch")
        if abs(area) / 2 < .01:
            raise ValueError("Site polygon area must be at least 0.01 square metres")
    return site
