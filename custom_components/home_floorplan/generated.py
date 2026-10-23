"""Edit a generated home's inventory without rebuilding its original architecture.

The installed viewer and models are trusted, server-owned source files. A draft
contains only calibrated room outlines and editable inventory; it cannot supply
HTML, replacement runtime code, or a path to another installation. Publications
clone the private baseline and replace only its inert model data.
"""
from __future__ import annotations

import copy
import hashlib
from html.parser import HTMLParser
import json
import logging
import math
from pathlib import Path
import re
import shutil
from types import MappingProxyType
import uuid

from .native import (GENERATION, MAX_NATIVE_TRIANGLES, MAX_GENERATED_BYTES, NativeError, NativeProject,
                     compiler, load_models, validate_draft)
from .site import validate_floor_inventory
from .validation import validate_inventory
from .permissions import model_references, referenced_entities

_LOGGER = logging.getLogger(__name__)
MODEL_BLOCK = re.compile(r'(<script\s+id=[\"\']modelData[\"\']\s+type=[\"\']application/json[\"\']\s*>)(.*?)(</script\s*>)', re.S | re.I)
MODEL_ID = re.compile(r'<script\b[^>]*\bid\s*=\s*[\"\']modelData[\"\']', re.I)
APPEARANCE = ("model_id", "style_id", "color", "pattern_id", "pattern_color", "curtain")


def _json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def _anchors(model, axis):
    anchors = model.get("calibration", {}).get(axis + "_anchors")
    if (not isinstance(anchors, list) or len(anchors) < 2 or
            any(not isinstance(pair, list) or len(pair) != 2 or
                any(type(number) not in (int, float) or not math.isfinite(number) for number in pair)
                for pair in anchors) or
            any(b[0] <= a[0] or b[1] <= a[1] for a, b in zip(anchors, anchors[1:]))):
        raise NativeError("unsupported_source", "The installed plan needs valid metric calibration before it can be edited.")
    return anchors


def _interpolate(value, anchors):
    left, right = anchors[-2:]
    for left, right in zip(anchors, anchors[1:]):
        if value <= right[0]:
            break
    return left[1] + (value - left[0]) * (right[1] - left[1]) / (right[0] - left[0])


def _point(point, model, inverse=False):
    result = []
    for value, axis in zip(point, ("x", "z")):
        anchors = _anchors(model, axis)
        result.append(_interpolate(value, [[b, a] for a, b in anchors] if inverse else anchors))
    return result


def _embedded(html):
    matches = list(MODEL_BLOCK.finditer(html))
    if len(matches) != 1 or len(MODEL_ID.findall(html)) != 1:
        raise NativeError("unsupported_source", "The installed viewer needs one inert modelData block before it can be edited safely.")
    try:
        model = json.loads(matches[0].group(2))
        if not isinstance(model, dict) or not isinstance(model.get("meshes"), list):
            raise ValueError("invalid model")
    except (ValueError, TypeError) as error:
        raise NativeError("unsupported_source", "The installed viewer's model data is invalid; its current files have been preserved.") from error
    return matches[0], model


class _ViewerScripts(HTMLParser):
    """Inspect trusted inline runtime code, excluding inert model/user data."""

    def __init__(self):
        super().__init__()
        self.active = False
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == "script":
            attrs = dict(attrs)
            self.active = not attrs.get("src") and attrs.get("type", "").lower() in (
                "", "module", "text/javascript", "application/javascript")

    def handle_endtag(self, tag):
        if tag == "script":
            self.active = False

    def handle_data(self, data):
        if self.active:
            self.parts.append(data)


def _check_curtain_runtime(html, floor):
    # Commissioned cover_windows remain supported by their original viewer.
    # Only source-authored bindings need the newer catalog fabric/mode path.
    if not any("curtain" in item for item in floor["items"]):
        return
    scripts = _ViewerScripts()
    scripts.feed(html)
    code = re.sub(r"\s+", "", "\n".join(scripts.parts))
    # These are the shared runtime's tag propagation and mode dispatch, not
    # arbitrary mentions in modelData or the rendered page's text.
    required = ("curtainFabric:part.curtain_fabric===true", "curtainPanel:part.curtain_panel",
                "child.userData.curtainPanel=batch.curtainPanel",
                "functionupdateCatalogCurtainFabric(", "if(spec.mode)returnupdateCatalogCurtainFabric(")
    if not all(fragment in code for fragment in required):
        raise NativeError("unsupported_curtain_runtime",
                          "This generated home's saved viewer does not support newly bound curtains. "
                          "Update its generated viewer through the original home build/update process, "
                          "or choose Decorative only for the new curtains before publishing. "
                          "The current published home is unchanged.")


def _hashes(root):
    """Accept regular source files only, never follow a source symlink."""
    if root.is_symlink() or not root.is_dir():
        raise NativeError("unsupported_source", "The installed plan must use regular local asset files.")
    result = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink() or not (path.is_dir() or path.is_file()):
            raise NativeError("unsupported_source", "The installed plan contains an unsupported asset link.")
        if path.is_file():
            with path.open("rb") as stream:
                result[path.relative_to(root).as_posix()] = hashlib.file_digest(stream, "sha256").hexdigest()
    return result


def _with_viewer_references(assets, references):
    """Authorize every value sent in HTML, including commissioned origins."""
    result = {}
    for floor, entities in references.items():
        _, embedded = _embedded((assets / floor / "index.html").read_text(encoding="utf-8"))
        result[floor] = frozenset(entities | referenced_entities(embedded))
    return MappingProxyType(result)


def seed_project(site, models, inventory):
    floors = []
    for floor_id, metadata in site["floors"].items():
        model = models[floor_id]
        rooms = []
        for room in model["rooms"]:
            value = {"id": room["id"], "name": room["name"],
                     "polygon": [_point(point, model) for point in room["polygon"]],
                     "material": room.get("material", "deck" if room["id"] in model.get("exterior_rooms", []) else "floor")}
            if room.get("ha_area_id"):
                value["ha_area_id"] = room["ha_area_id"]
            rooms.append(value)
        floor = {"id": floor_id, "name": metadata["title"], "elevation_m": model.get("elevation_m", 0),
                 "height_m": model["ceiling_height_m"], "rooms": rooms, "walls": [], "openings": [],
                 "items": copy.deepcopy(inventory[floor_id]["items"])}
        if model.get("ha_floor_id"):
            floor["ha_floor_id"] = model["ha_floor_id"]
        floors.append(floor)
    title = next(iter(models.values())).get("project_title", "My home")
    return validate_draft({"schema_version": 1, "title": title, "floors": floors})


def _check_architecture(project, baseline):
    if [floor["id"] for floor in project["floors"]] != [floor["id"] for floor in baseline["floors"]]:
        raise NativeError("protected_architecture", "Keep the installed floors and their order. You can add rooms and devices within them.")
    for floor, original in zip(project["floors"], baseline["floors"]):
        if any(floor[key] != original[key] for key in ("id", "elevation_m", "height_m")):
            raise NativeError("protected_architecture", "The installed floor elevation and height are protected.")
        rooms = {room["id"]: room for room in floor["rooms"]}
        for room in original["rooms"]:
            if room["id"] not in rooms or any(rooms[room["id"]][key] != room[key] for key in ("polygon", "material")):
                raise NativeError("protected_architecture", "Keep the installed room outlines and materials. Room names and Home Assistant areas can be changed.")


def _additions(runtime, project, floor, original):
    """Compile only overlay objects; never compile the detailed original home."""
    protected = {room["id"] for room in original["rooms"]}
    old_items = {item["id"]: item for item in original["items"]}
    changed_items = [item for item in floor["items"] if item["id"] not in old_items or
                     (item.get("model_id") and any(item.get(key) != old_items[item["id"]].get(key) for key in APPEARANCE))]
    new_rooms = {room["id"] for room in floor["rooms"]} - protected
    if not (changed_items or new_rooms or floor["walls"]):
        return None
    # Original room outlines supply compiler bounds and labels, but their
    # generated floor meshes are discarded before merging the overlay.
    source = {**floor, "items": changed_items}
    triangles = len(floor["walls"]) * 60 + len(floor["openings"]) * 48 + sum(len(r["polygon"]) * 4 for r in floor["rooms"])
    for item in changed_items:
        asset = runtime.build_furniture_asset(item)
        triangles += sum(len(mesh["indices"]) // 3 for mesh in asset["meshes"]) if asset else 12
        if triangles > MAX_NATIVE_TRIANGLES:
            raise NativeError("invalid_project", "The added geometry exceeds the editing budget. Reduce detailed furniture before publishing.")
    data, _ = runtime.make_floor(project, source, None)
    data["rooms"] = [room for room in data["rooms"] if room["id"] in new_rooms]
    data["meshes"] = [mesh for mesh in data["meshes"] if mesh["name"] not in {"room_" + room for room in protected}]
    return data


def _merge_model(base, floor, original, additions, runtime=False):
    # Detailed custom meshes can be tens of megabytes. Share their immutable
    # objects; copy only the collections that this merge actually changes.
    model = dict(base)
    model["rooms"] = copy.deepcopy(base["rooms"])
    model["inventory"] = copy.deepcopy(floor["items"])
    old_items = {item["id"]: item for item in original["items"]}
    current_items = {item["id"]: item for item in floor["items"]}
    for item_id, anchor_id in base.get("control_anchors", {}).items():
        if not isinstance(anchor_id, str) or item_id not in old_items or item_id not in current_items:
            continue
        old, current = old_items[item_id], current_items[item_id]
        delta = [current["position_m"][axis] - old["position_m"][axis] for axis in ("x", "y", "z")]
        if not any(abs(value) > 1e-8 for value in delta):
            continue
        anchor_delta = ([current_items[anchor_id]["position_m"][axis] - old_items[anchor_id]["position_m"][axis]
                         for axis in ("x", "y", "z")]
                        if anchor_id in old_items and anchor_id in current_items else [0, 0, 0])
        if any(abs(a - b) > 1e-8 for a, b in zip(delta, anchor_delta)):
            # Independently moving a control intentionally detaches its visual
            # marker from the old fitting; moving the fitting and control
            # together retains the commissioned relationship.
            model["control_anchors"] = dict(model.get("control_anchors", {}))
            model["control_anchors"].pop(item_id, None)
    if floor["name"] != original["name"]:
        model["title"] = floor["name"]
    if floor.get("ha_floor_id") != original.get("ha_floor_id"):
        model["ha_floor_id"] = floor.get("ha_floor_id")
    current_rooms = {room["id"]: room for room in floor["rooms"]}
    original_rooms = {room["id"]: room for room in original["rooms"]}
    for room in model["rooms"]:
        edited, old = current_rooms[room["id"]], original_rooms[room["id"]]
        if edited["name"] != old["name"]:
            room["name"] = edited["name"]
            if room["id"] in model.get("room_display_names", {}):
                model["room_display_names"] = dict(model["room_display_names"])
                model["room_display_names"][room["id"]] = edited["name"]
        if edited.get("ha_area_id") != old.get("ha_area_id"):
            room["ha_area_id"] = edited.get("ha_area_id")
    if additions:
        overlay = copy.deepcopy(additions)
        for key in ("materials", "object_assets"):
            model[key] = dict(base.get(key, {}))
        for key in ("meshes", "openings", "exterior_rooms"):
            model[key] = list(base.get(key, []))
        used = {mesh["material"] for mesh in overlay["meshes"]}
        used.update(mesh["material"] for asset in overlay["object_assets"].values() for mesh in asset["meshes"])
        mapping = {}
        for name in used:
            value = overlay["materials"][name]
            # A stable value-derived namespace cannot overwrite a custom finish.
            target = "studio_" + hashlib.sha256(_json([name, value]).encode()).hexdigest()[:24]
            if target in model.get("materials", {}) and model["materials"][target] != value:
                raise NativeError("unsupported_source", "An added material conflicts with the installed model.")
            mapping[name] = target
            model.setdefault("materials", {})[target] = value
        for mesh in overlay["meshes"]:
            mesh["name"] = "studio_" + mesh["name"]
            mesh["material"] = mapping[mesh["material"]]
        for asset in overlay["object_assets"].values():
            for mesh in asset["meshes"]:
                mesh["material"] = mapping[mesh["material"]]
        model.setdefault("meshes", []).extend(overlay["meshes"])
        model.setdefault("object_assets", {}).update(overlay["object_assets"])
        for room in overlay["rooms"]:
            room["polygon"] = [_point(_point(point, overlay), base, True) for point in room["polygon"]]
            room["label"] = _point(_point(room["label"], overlay), base, True)
            model["rooms"].append(room)
            if room["material"] == "deck":
                model.setdefault("exterior_rooms", []).append(room["id"])
        for opening in overlay["openings"]:
            rect = opening["rect"]
            opening["rect"] = (_point(_point(rect[:2], overlay), base, True) +
                               _point(_point(rect[2:], overlay), base, True))
            # Original openings may use the same user-friendly ID. The runtime
            # has no project lookup for these additive opening records.
            opening["id"] = "studio_" + opening["id"]
            model.setdefault("openings", []).append(opening)
    # Authoring bindings address the additive windows by their runtime IDs.
    # Preserve commissioned bindings unless an editable binding replaced them.
    if any("curtain" in item for item in [*original["items"], *floor["items"]]):
        model["cover_windows"] = dict(base.get("cover_windows", {}))
        for item in original["items"]:
            if "curtain" in item:
                model["cover_windows"].pop(item["id"], None)
        for item in floor["items"]:
            if "curtain" in item:
                model["cover_windows"][item["id"]] = {
                    "openings": ["studio_" + item["curtain"]["opening_id"]], "mode": item["curtain"]["mode"]}
    if runtime:
        # The existing viewer uses model.inventory as the ORIGINAL reference
        # for curtain offsets, motion paths, and rebinding checks. Current
        # placements arrive separately over its authenticated HA bridge.
        # New IDs also need an original record; removed IDs are harmless here
        # because only bridge placements are rendered.
        baseline_ids = {item["id"] for item in base.get("inventory", [])}
        originals = []
        for item in base.get("inventory", []):
            reference = dict(item)
            if item["id"] in current_items:
                # The viewer also reconciles catalog appearance against these
                # records. Keep commissioned transforms/entity references but
                # make the explicitly published appearance authoritative.
                reference["type"] = current_items[item["id"]]["type"]
                for key in APPEARANCE:
                    reference.pop(key, None)
                    if key in current_items[item["id"]]:
                        reference[key] = current_items[item["id"]][key]
                if "curtain" in current_items[item["id"]]:
                    # An explicitly selected new window defines a new fabric
                    # reference, including the alignment made in the editor.
                    for key in ("position_m", "dimensions_m", "rotation_deg"):
                        reference[key] = copy.deepcopy(current_items[item["id"]][key])
            originals.append(reference)
        model["inventory"] = [*originals, *[copy.deepcopy(item) for item in floor["items"] if item["id"] not in baseline_ids]]
        # Inventory is rendered from placements and local object_assets. Old
        # transformed copies in a raw build must never appear at stale positions.
        model["meshes"] = [mesh for mesh in model["meshes"] if mesh.get("kind") != "inventory"]
    # Window bindings belong to the source project and cover_windows. Runtime
    # placement messages keep their existing inventory schema.
    model["inventory"] = [{key: value for key, value in item.items() if key != "curtain"} for item in model["inventory"]]
    return model


class GeneratedProject(NativeProject):
    """Persist a small draft and an immutable server-owned generated baseline."""

    mode = "generated"

    def __init__(self, hass, component_root, site, models, inventory):
        super().__init__(hass, root=hass.config.path(".storage", "home_floorplan_generated_assets"),
                         store_key="home_floorplan.generated_studio")
        self.component_root = Path(component_root)
        self.installed_site, self.installed_models = copy.deepcopy(site), models
        self.installed_inventory = copy.deepcopy(inventory)
        self.document.update(inventory=copy.deepcopy(inventory), baseline=None)
        self.baseline_project = None
        self.source = {"kind": "generated", "protected_floors": [], "protected_rooms": {}, "custom_items": {}}

    def _metadata(self, project, models):
        self.baseline_project = project
        self.source = {"kind": "generated", "protected_floors": [floor["id"] for floor in project["floors"]],
                       "protected_rooms": {floor["id"]: [room["id"] for room in floor["rooms"]] for floor in project["floors"]},
                       "custom_items": {floor: list(model.get("object_assets", {})) for floor, model in models.items()}}

    def _prepare(self):
        project = seed_project(self.installed_site, self.installed_models, self.document["inventory"])
        self.references = _with_viewer_references(self.component_root / "assets", model_references(self.installed_models))
        self._source_hashes = _hashes(self.component_root / "assets")
        self._metadata(project, self.installed_models)
        return project

    async def load(self):
        saved = await self.store.async_load()
        if saved is None:
            self.document["project"] = await self.hass.async_add_executor_job(self._prepare)
            self.installed_models = None
            return None
        if (not isinstance(saved, dict) or set(saved) != set(self.document) or
                type(saved["revision"]) is not int or saved["revision"] < 0 or
                not isinstance(saved["inventory"], dict) or
                not isinstance(saved["baseline"], str) or not GENERATION.fullmatch(saved["baseline"]) or
                (saved["published_revision"] is not None and
                 (type(saved["published_revision"]) is not int or not 0 <= saved["published_revision"] <= saved["revision"])) or
                (saved["generation"] is None) != (saved["published_revision"] is None)):
            raise NativeError("invalid_storage", "The saved generated-home draft needs its private backup restored.")
        self.document = saved
        result = await self.hass.async_add_executor_job(self._restore)
        self.installed_models = None
        return result

    def _restore(self):
        baseline = self.root / "baselines" / self.document["baseline"]
        metadata = json.loads((baseline / "source.json").read_text(encoding="utf-8"))
        if _hashes(baseline / "assets") != metadata["hashes"]:
            raise NativeError("invalid_storage", "The saved original home has changed; restore its private backup before editing.")
        models, _ = load_models(baseline / "assets", metadata["site"]["floors"])
        self._metadata(validate_draft(metadata["project"]), models)
        self._source_hashes = metadata["hashes"]
        self._validate(self.document["project"])
        if self.document["generation"] is None:
            if self.installed_site != metadata["site"] or _hashes(self.component_root / "assets") != metadata["hashes"]:
                raise NativeError("source_changed", "The installed home changed after this draft was saved. Restore its matching source before publishing.")
            if self.installed_inventory != self.document["inventory"]:
                raise NativeError("source_changed", "The published placements changed after this draft was saved. Its newer placements have been preserved.")
            self.references = _with_viewer_references(baseline / "assets", model_references(models))
            return None
        generation = self.document["generation"]
        if not isinstance(generation, str) or not GENERATION.fullmatch(generation):
            raise NativeError("invalid_storage", "The saved generated-home publication is invalid.")
        assets = self.root / generation
        site = json.loads((assets / "site.json").read_text(encoding="utf-8"))
        # Site features originate only in the trusted server baseline, never
        # in browser project fields or a generic site's uploaded JSON.
        if any(site.get(key) != metadata["site"].get(key) for key in ("schema_version", "site_id", "default_floor", "site_features")) or list(site["floors"]) != list(metadata["site"]["floors"]):
            raise NativeError("invalid_storage", "The saved publication no longer matches its original home.")
        if any(value.get("stem") != metadata["site"]["floors"][floor]["stem"]
               for floor, value in site["floors"].items()):
            raise NativeError("invalid_storage", "The saved publication contains invalid export metadata.")
        models, references = load_models(assets, site["floors"])
        references = _with_viewer_references(assets, references)
        if set(self.document["inventory"]) != set(models):
            raise NativeError("invalid_storage", "The saved placements no longer match the published floors.")
        for floor, model in models.items():
            validate_floor_inventory(self.document["inventory"][floor], {room["id"] for room in model["rooms"]}, validate_inventory)
        return assets, site, models, references

    def _validate(self, project):
        validated = validate_draft(project)
        _check_architecture(validated, self.baseline_project)
        return validated

    def _snapshot(self):
        baseline_id = uuid.uuid4().hex
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        (self.root / "baselines").mkdir(exist_ok=True, mode=0o700)
        target = self.root / "baselines" / baseline_id
        target.mkdir(parents=True, mode=0o700)
        try:
            if _hashes(self.component_root / "assets") != self._source_hashes:
                raise NativeError("source_changed", "The installed home changed while you were editing. Reload before saving.")
            shutil.copytree(self.component_root / "assets", target / "assets", symlinks=True)
            if _hashes(target / "assets") != self._source_hashes:
                raise NativeError("source_changed", "The installed home changed during the save. Reload before saving.")
            (target / "source.json").write_text(_json({"site": self.installed_site, "project": self.baseline_project,
                                                       "hashes": self._source_hashes}), encoding="utf-8")
            return baseline_id
        except Exception:
            shutil.rmtree(target)
            raise

    async def save(self, revision, project):
        self.check_revision(revision)
        validated = await self.hass.async_add_executor_job(self._validate, project)
        baseline = self.document["baseline"] or await self.hass.async_add_executor_job(self._snapshot)
        updated = {**self.document, "revision": revision + 1, "project": validated, "baseline": baseline}
        try:
            await self.store.async_save(updated)
        except Exception:
            if self.document["baseline"] is None:
                await self.hass.async_add_executor_job(shutil.rmtree, self.root / "baselines" / baseline)
            raise
        self.document = updated

    def prepare_legacy_inventory(self, inventory):
        """Keep the original Store authoritative until the first publication."""
        if self.document["baseline"] is not None:
            raise NativeError("conflict", "This home has a saved draft. Publish its edits in Home Studio before editing placements here.")
        project = copy.deepcopy(self.document["project"])
        for floor in project["floors"]:
            floor["items"] = copy.deepcopy(inventory[floor["id"]]["items"])
        project = self._validate(project)
        return {**self.document, "inventory": copy.deepcopy(inventory), "project": project,
                "revision": self.document["revision"] + 1}

    def accept_legacy_inventory(self, document):
        """Advance the import seed only after the legacy Store acknowledged it."""
        self.document = document
        self.baseline_project = copy.deepcopy(document["project"])

    def _export_floors(self, runtime, project, floor_id):
        _check_architecture(project, self.baseline_project)
        floors = [floor for floor in project['floors'] if floor_id is None or floor['id'] == floor_id]
        if not floors:
            raise NativeError('invalid_floor', 'Choose a floor in the current drawing.')
        # A saved baseline is immutable and survives later publications. Before
        # the first save, verify the installed source without creating a draft.
        if self.document['baseline'] is None:
            assets = self.component_root / 'assets'
            expected = self._source_hashes
        else:
            baseline = self.root / 'baselines' / self.document['baseline']
            assets = baseline / 'assets'
            expected = json.loads((baseline / 'source.json').read_text(encoding='utf-8'))['hashes']
        files, source_bytes = 0, 0
        for path in assets.rglob('*'):
            if path.is_file():
                files += 1
                source_bytes += path.stat().st_size
                if files > 4096 or source_bytes > MAX_GENERATED_BYTES:
                    raise NativeError('invalid_export', 'The original model exceeds the export source size limit.')
        if _hashes(assets) != expected:
            raise NativeError('source_changed', 'The original home changed. Reload before exporting.')
        originals = {floor['id']: floor for floor in self.baseline_project['floors']}
        result = []
        for floor in floors:
            base = json.loads((assets / floor['id'] / 'model-data.json').read_text(encoding='utf-8'))
            # Some commissioned homes keep richer render geometry in the
            # embedded model than in their metadata JSON. That is the trusted
            # geometry actually shown by the original viewer.
            _, embedded = _embedded((assets / floor['id'] / 'index.html').read_text(encoding='utf-8'))
            base = {**base, **embedded}
            original = originals[floor['id']]
            additions = _additions(runtime, project, floor, original)
            model = _merge_model(base, floor, original, additions)
            result.append(runtime.export_floor(model, floor, reference_items=base.get('inventory', original['items']),
                                               elevated=floor_id is None))
        return result

    def _build(self, project, generation):
        self._validate(project)
        runtime = compiler()
        runtime.validate_project(project)
        baseline = self.root / "baselines" / self.document["baseline"]
        metadata = json.loads((baseline / "source.json").read_text(encoding="utf-8"))
        if _hashes(baseline / "assets") != metadata["hashes"]:
            raise NativeError("source_changed", "The original home snapshot changed. The published home has been preserved.")
        if self.document["generation"] is None and _hashes(self.component_root / "assets") != metadata["hashes"]:
            raise NativeError("source_changed", "The installed home changed after this draft was saved. The current home has been preserved.")
        target = self.root / generation
        try:
            shutil.copytree(baseline / "assets", target, symlinks=True)
            target.chmod(0o700)
            site = copy.deepcopy(metadata["site"])
            viewer_references = {}
            for floor, original in zip(project["floors"], self.baseline_project["floors"]):
                floor_id = floor["id"]
                site["floors"][floor_id]["title"] = floor["name"]
                model_path = target / floor_id / "model-data.json"
                base = json.loads(model_path.read_text(encoding="utf-8"))
                additions = _additions(runtime, project, floor, original)
                model = _merge_model(base, floor, original, additions)
                if project["title"] != self.baseline_project["title"]:
                    model["project_title"] = project["title"]
                if model != base:
                    model_path.write_text(_json(model), encoding="utf-8")
                html_path = target / floor_id / "index.html"
                html = html_path.read_text(encoding="utf-8")
                _check_curtain_runtime(html, floor)
                block, embedded = _embedded(html)
                merged = _merge_model(embedded, floor, original, additions, runtime=True)
                if project["title"] != self.baseline_project["title"]:
                    merged["project_title"] = project["title"]
                viewer_references[floor_id] = referenced_entities(merged)
                if merged != embedded:
                    inert = _json(merged).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
                    updated = html[:block.start(2)] + inert + html[block.end(2):]
                    if _embedded(updated)[1] != merged:
                        raise NativeError("build_failed", "The edited model could not be safely embedded in its original viewer.")
                    html_path.write_text(updated, encoding="utf-8")
            (target / "site.json").write_text(_json(site), encoding="utf-8")
            models, references = load_models(target, site["floors"])
            references = MappingProxyType({floor: frozenset(entities | viewer_references[floor])
                                           for floor, entities in references.items()})
            return site, models, references
        except Exception:
            if target.exists():
                shutil.rmtree(target)
            raise

    async def publish(self, revision):
        self.check_revision(revision)
        if self.document["baseline"] is None:
            raise NativeError("invalid_project", "Save your draft before publishing it.")
        generation = uuid.uuid4().hex
        try:
            site, models, references = await self.hass.async_add_executor_job(self._build, self.document["project"], generation)
        except NativeError:
            raise
        except Exception as error:
            _LOGGER.exception("Generated-home publication failed; the previous home remains active")
            raise NativeError("build_failed", "The edited home could not be built. The previous published home is still active.") from error
        inventory_revision = max(revision, max(value["revision"] for value in self.document["inventory"].values()) + 1)
        inventory = {floor: {"revision": inventory_revision, "items": copy.deepcopy(model["inventory"])} for floor, model in models.items()}
        updated = {**self.document, "generation": generation, "published_revision": revision, "inventory": inventory}
        try:
            await self.store.async_save(updated)
        except Exception:
            await self.hass.async_add_executor_job(shutil.rmtree, self.root / generation)
            raise
        old_generation = self.document["generation"]
        self.document = updated
        try:
            await self.hass.async_add_executor_job(self._cleanup, {generation, old_generation})
        except OSError:
            _LOGGER.warning("Could not clean up an old generated-home publication")
        return self.root / generation, site, models, inventory, references
