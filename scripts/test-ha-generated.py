#!/usr/bin/env python3
"""Check native editing of a detailed generated home using synthetic data only."""
from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import struct
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("generated_test_support", ROOT / "scripts/test-ha-native.py")
support = importlib.util.module_from_spec(spec)
spec.loader.exec_module(support)
integration, native, compiler = support.integration, support.native, support.compiler
generated = sys.modules.get("ha_native_test.generated") or support.load_file(
    "ha_native_test.generated", ROOT / "custom_components/home_floorplan/generated.py")
MODEL_BLOCK = re.compile(r'(<script id="modelData" type="application/json">)(.*?)(</script>)', re.S)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def mesh(name, kind="walls", **extra):
    return {"name": name, "kind": kind, "vertices": [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
            "normals": [[0, 0, 1]] * 3, "indices": [0, 1, 2], "material": "custom_teal", **extra}


def fixture(component):
    """Include features which an ordinary planner recompile would discard."""
    site = {"schema_version": 1, "site_id": None, "default_floor": "upper",
            "floors": {floor: {"stem": floor + "_model", "title": floor.title()} for floor in ("upper", "ground")},
            "site_features": True}
    models = {}
    for floor in site["floors"]:
        item = {"id": "custom_lamp", "name": "Synthetic lamp", "type": "lamp", "room": "room_a",
                "position_m": {"x": 1, "y": 0, "z": 1}, "dimensions_m": {"width": .3, "depth": .3, "height": 1.2},
                "rotation_deg": 17, "entity_id": "light.synthetic_lamp", "notes": "A synthetic custom asset"}
        model = {"schema_version": 1, "id": floor + "_model", "floor": floor, "title": floor.title(),
                 "units": "metres", "up_axis": "Y", "ceiling_height_m": 2.7,
                 "origin": "Synthetic local coordinates", "elevation_m": 2.8 if floor == "upper" else 0,
                 "calibration": {"reference_size": [100, 100], "source_size": [100, 100],
                                 "x_anchors": [[0, 0], [50, 2], [100, 5]], "z_anchors": [[0, 0], [100, 4]]},
                 "rooms": [{"id": "room_a", "name": "Synthetic room", "polygon": [[0, 0], [100, 0], [100, 100], [0, 100]], "label": [50, 50]}],
                 "materials": {"custom_teal": [.1, .6, .5, 1]},
                 "meshes": [mesh("custom_wall"), mesh("custom_stair", "stairs", estimated=True),
                            mesh("placed_custom_lamp", "inventory", item_id=item["id"], entity_id=item["entity_id"])],
                 "openings": [{"id": "special_window", "type": "window", "rect": [10, 0, 40, 2],
                               "width_m": 1.2, "sill_m": .8, "head_m": 2.1, "glazing": "custom"}],
                 "inventory": [item], "object_assets": {item["id"]: {"profile": "synthetic_custom", "meshes": [mesh("shade", "inventory")]}},
                 "room_activity": {"room_a": "sensor.synthetic_activity"},
                 "motion_paths": {item["id"]: [[1, 0, 1], [2, 0, 1]]},
                 "motion_sources": {item["entity_id"]: ["binary_sensor.synthetic_motion"]},
                 "motion_zones": {item["id"]: {"polygon": [[0, 0], [1, 0], [0, 1]]}},
                 "cover_windows": {item["id"]: {"entity_id": "cover.synthetic_blind", "paired": True}},
                 "control_anchors": {item["id"]: [1, 1, 1]}, "control_groups": {item["id"]: ["light.synthetic_lamp"]},
                 "room_views": {"room_a": {"azimuth_rad": .4}}, "room_display_names": {"room_a": "Synthetic display name"},
                 "room_display_ids": {"room_a": "A"}, "tv_entities": {item["id"]: "media_player.synthetic_tv"},
                 "camera_entities": {item["id"]: "camera.synthetic_camera"}, "exterior_rooms": [],
                 "site_context": {"synthetic_context": {"preserve": True},
                                  "lowest_slab_elevation_m": -.35 - (2.8 if floor == "upper" else 0)},
                 "lower_floor_context": {"elevation_m": -2.8, "surfaces": [], "lines": []},
                 "telemetry": [{"entity_id": "sensor.synthetic_energy"}],
                 "assumed_activity": {"sensor": "sensor.synthetic_zone", "geometry_sha256": "synthetic_fingerprint"},
                 "next_floor": {"id": "ground" if floor == "upper" else "upper"},
                 "custom_extension": {"text": "Keep </script> and \u2028 as inert data", "nested": [1, {"keep": True}]}}
        models[floor] = model
        target = component / "assets" / floor
        target.mkdir(parents=True)
        (target / "model-data.json").write_text(encoded(model), encoding="utf-8")
        runtime = {**model, "meshes": [part for part in model["meshes"] if part["kind"] != "inventory"]}
        runtime["environment"] = {"enabled": True, "palette": "synthetic", "entity_id": "sensor.synthetic_environment", "bounds": {"minX": -2, "maxX": 7, "minZ": -2, "maxZ": 6}}
        (target / "index.html").write_text(
            '<!doctype html><html><head><title>Synthetic generated viewer</title></head><body>'
            '<div id="original-plan">Original raster plan and custom controls</div>'
            '<script id="modelData" type="application/json">' + encoded(runtime) + '</script>'
            '<script>window.syntheticTrustedViewer=true;</script></body></html>', encoding="utf-8")
        (target / (floor + "_model.glb")).write_bytes(b"synthetic immutable export snapshot")
    inventory = {floor: {"revision": 7, "items": copy.deepcopy(model["inventory"])} for floor, model in models.items()}
    return site, models, inventory


def tree_hashes(root):
    return {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in root.rglob("*") if path.is_file()}


def embedded_model(path):
    matches = list(MODEL_BLOCK.finditer(path.read_text(encoding="utf-8")))
    if len(matches) != 1:
        raise AssertionError("A generated viewer must contain exactly one inert model block")
    return json.loads(matches[0].group(2))


class GeneratedProjectTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.component = self.root / "component"
        self.site, self.models, self.inventory = fixture(self.component)
        self.baseline = tree_hashes(self.component)
        self.hass = support.Hass(self.root)
        for module in (native, generated):
            if hasattr(module, "compiler"):
                compiler_patch = patch.object(module, "compiler", return_value=compiler)
                compiler_patch.start()
                self.addCleanup(compiler_patch.stop)
        self.project = generated.GeneratedProject(self.hass, self.component, self.site, self.models, self.inventory)
        await self.project.load()

    def assert_baseline_unchanged(self):
        self.assertEqual(tree_hashes(self.component), self.baseline)

    def assert_lowest_slab_preserved(self, assets, identifier):
        expected = -.35 - self.models[identifier]["elevation_m"]
        stored = json.loads((assets / identifier / "model-data.json").read_text(encoding="utf-8"))
        embedded = embedded_model(assets / identifier / "index.html")
        for model in (stored, embedded):
            self.assertEqual(model["site_context"]["lowest_slab_elevation_m"], expected)

    async def publish_seed(self):
        await self.project.save(0, copy.deepcopy(self.project.document["project"]))
        return await self.project.publish(1)

    async def test_site_publication_preserves_installed_geometry_and_private_extensions(self):
        runtime = (ROOT / "map-layer.js").read_text(encoding="utf-8")
        for floor in self.models:
            page = self.component / "assets" / floor / "index.html"
            page.write_text(page.read_text(encoding="utf-8").replace(
                "</body>", "<script>" + runtime + "</script></body>"), encoding="utf-8")
        self.baseline = tree_hashes(self.component)
        adapter = generated.GeneratedProject(self.hass, self.component, self.site, self.models, self.inventory)
        await adapter.load()
        source = copy.deepcopy(adapter.document["project"])
        original_floors = copy.deepcopy(source["floors"])
        source["site"] = {"ground_elevation_m": -1, "features": [
            {"id": "home_1", "name": "Fictional home", "kind": "home", "height_m": 6,
             "color": "#46a0aa", "polygon": [[0, 0], [5, 0], [5, 4], [0, 4]]},
            {"id": "neighbor_1", "name": "Fictional neighbor", "kind": "building", "height_m": 5,
             "color": "#aa9cb4", "polygon": [[8, 0], [12, 0], [12, 4], [8, 4]]},
        ]}
        await adapter.save(0, source)
        assets, _, models, _, _ = await adapter.publish(1)
        baseline_assets = adapter.root / "baselines" / adapter.document["baseline"] / "assets"
        for floor in original_floors:
            identifier = floor["id"]
            model = models[identifier]
            self.assertEqual(model["meshes"], self.models[identifier]["meshes"])
            self.assertEqual(model["custom_extension"], self.models[identifier]["custom_extension"])
            self.assertEqual(model["site_context"]["synthetic_context"], {"preserve": True})
            self.assertEqual(model["site_context"]["features"], source["site"]["features"])
            self.assertEqual(model["site_context"]["ground_elevation_m"], -1 - floor["elevation_m"])
            self.assertNotEqual(model["site_context"]["lowest_slab_elevation_m"], model["site_context"]["ground_elevation_m"])
            self.assert_lowest_slab_preserved(assets, identifier)
            self.assert_lowest_slab_preserved(baseline_assets, identifier)
            before = (self.component / "assets" / identifier / "index.html").read_text(encoding="utf-8")
            after = (assets / identifier / "index.html").read_text(encoding="utf-8")
            self.assertEqual(MODEL_BLOCK.sub(r"\1MODEL\3", before), MODEL_BLOCK.sub(r"\1MODEL\3", after))
            self.assertEqual(embedded_model(assets / identifier / "index.html")["site_context"], model["site_context"])
        restarted = generated.GeneratedProject(self.hass, self.component, self.site, self.models, self.inventory)
        await restarted.load()
        self.assertEqual(restarted.document["project"]["site"], source["site"])
        self.assertEqual(set(restarted.document["project"]["site"]), {"ground_elevation_m", "features"})
        self.assertEqual(restarted.document["project"]["floors"], original_floors)
        self.assert_baseline_unchanged()

    async def test_old_viewer_rejects_site_publish_and_keeps_previous_home(self):
        await self.publish_seed()
        previous = self.project.document["generation"]
        source = copy.deepcopy(self.project.document["project"])
        source["site"] = {"ground_elevation_m": 0, "features": [
            {"id": "roof", "name": "Roof", "kind": "roof", "height_m": 6,
             "color": "#46a0aa", "polygon": [[0, 0], [5, 0], [5, 4], [0, 4]]},
        ]}
        await self.project.save(1, source)
        with self.assertRaises(native.NativeError) as error:
            await self.project.publish(2)
        self.assertEqual(error.exception.code, "unsupported_site_runtime")
        self.assertEqual(self.project.document["generation"], previous)
        self.assertTrue((self.project.root / previous / "upper/index.html").is_file())
        self.assert_baseline_unchanged()

    async def test_omitting_site_does_not_resurrect_baseline_features(self):
        features = [{"id": "roof", "name": "Roof", "kind": "roof", "height_m": 6,
                     "color": "#46a0aa", "polygon": [[0, 0], [5, 0], [5, 4], [0, 4]]}]
        for identifier, model in self.models.items():
            context = model["site_context"]
            context.update(features=features, ground_elevation_m=-model["elevation_m"])
            folder = self.component / "assets" / identifier
            (folder / "model-data.json").write_text(encoded(model), encoding="utf-8")
            page = folder / "index.html"
            embedded = embedded_model(page)
            embedded["site_context"] = copy.deepcopy(context)
            page.write_text(MODEL_BLOCK.sub(lambda match: match[1] + encoded(embedded) + match[3],
                                           page.read_text(encoding="utf-8")), encoding="utf-8")
        self.baseline = tree_hashes(self.component)
        adapter = generated.GeneratedProject(self.hass, self.component, self.site, self.models, self.inventory)
        await adapter.load()
        source = copy.deepcopy(adapter.document["project"])
        self.assertEqual(set(source["site"]), {"ground_elevation_m", "features"})
        self.assertEqual(source.pop("site")["features"], features)
        await adapter.save(0, source)
        assets, _, models, _, _ = await adapter.publish(1)
        baseline_assets = adapter.root / "baselines" / adapter.document["baseline"] / "assets"
        for identifier, model in models.items():
            self.assertNotIn("features", model["site_context"])
            self.assertEqual(model["site_context"]["synthetic_context"], {"preserve": True})
            self.assert_lowest_slab_preserved(assets, identifier)
            self.assert_lowest_slab_preserved(baseline_assets, identifier)
            self.assertEqual(model["meshes"], self.models[identifier]["meshes"])
            self.assertEqual(embedded_model(assets / identifier / "index.html")["site_context"], model["site_context"])
        restarted = generated.GeneratedProject(self.hass, self.component, self.site, self.models, self.inventory)
        await restarted.load()
        self.assertNotIn("site", restarted.document["project"])
        self.assert_baseline_unchanged()

    def test_installed_site_is_seeded_in_global_coordinates(self):
        features = [{"id": "roof", "name": "Roof", "kind": "roof", "height_m": 6,
                     "color": "#46a0aa", "polygon": [[0, 0], [5, 0], [5, 4], [0, 4]]}]
        for model in self.models.values():
            model["site_context"].update(ground_elevation_m=.1 - model["elevation_m"], features=features)
        project = generated.seed_project(self.site, self.models, self.inventory)
        self.assertAlmostEqual(project["site"]["ground_elevation_m"], .1)
        self.assertEqual(project["site"]["features"], features)
        self.assertEqual(set(project["site"]), {"ground_elevation_m", "features"})
        self.assertIsNot(project["site"]["features"], features)
        self.models["ground"]["site_context"]["ground_elevation_m"] = 2
        with self.assertRaises(native.NativeError) as error:
            generated.seed_project(self.site, self.models, self.inventory)
        self.assertEqual(error.exception.code, "unsupported_source")

    def test_installed_site_requires_a_valid_ground_elevation(self):
        for value in (None, True, "0", float("nan")):
            with self.subTest(value=value):
                self.models["upper"]["site_context"].update(features=[], ground_elevation_m=value)
                with self.assertRaises(native.NativeError) as error:
                    generated.seed_project(self.site, self.models, self.inventory)
                self.assertEqual(error.exception.code, "unsupported_source")

    def test_inert_site_capability_text_does_not_enable_an_old_viewer(self):
        source = {"site": {"features": [{}]}}
        for markup in ('<p>homeMapMath.features(options.features) home-site-features</p>',
                       '<script type="application/json">"homeMapMath.features(options.features) home-site-features"</script>'):
            with self.subTest(markup=markup), self.assertRaises(native.NativeError):
                generated._check_site_runtime(markup, source)

    async def test_seed_preserves_ids_calibration_and_current_stored_inventory(self):
        current = copy.deepcopy(self.inventory)
        current["upper"]["items"][0]["name"] = "Later saved placement"
        current["upper"]["items"][0]["position_m"]["x"] = 1.7
        project = generated.GeneratedProject(self.hass, self.component, self.site, self.models, current)
        await project.load()
        self.assertEqual(project.document["revision"], 0)
        self.assertIsNone(project.document["published_revision"])
        self.assertEqual(project.source["kind"], "generated")
        self.assertEqual(set(project.source["protected_floors"]), set(self.site["floors"]))
        for floor in project.document["project"]["floors"]:
            self.assertEqual(floor["items"], current[floor["id"]]["items"])
            self.assertEqual(floor["rooms"][0]["id"], "room_a")
            self.assertEqual(floor["rooms"][0]["polygon"], [[0, 0], [5, 0], [5, 4], [0, 4]])
            self.assertEqual(project.source["protected_rooms"][floor["id"]], ["room_a"])
        self.assertIn("sensor.synthetic_environment", project.references["upper"])
        self.assertEqual(project.store.options, {"private": True, "atomic_writes": True})
        self.assertEqual(project.store.key, "home_floorplan.generated_studio")
        self.assertEqual(project.root, self.root / ".storage/home_floorplan_generated_assets")
        self.assertIsNone(project.legacy_root, "Generated homes never load a native project's legacy assets")
        self.assert_baseline_unchanged()

    async def test_noop_publication_preserves_complete_model_and_trusted_viewer(self):
        assets, site, models, inventory, references = await self.publish_seed()
        self.assertEqual(site, self.site)
        self.assertEqual(models, self.models)
        self.assertEqual(references, integration.model_references({floor: {"raw": model, "runtime": embedded_model(self.component / "assets" / floor / "index.html")} for floor, model in self.models.items()}))
        for floor in self.models:
            self.assertEqual(inventory[floor]["items"], self.inventory[floor]["items"])
            self.assertGreater(inventory[floor]["revision"], self.inventory[floor]["revision"])
            before = self.component / "assets" / floor / "index.html"
            after = assets / floor / "index.html"
            self.assertEqual(MODEL_BLOCK.sub(r"\1MODEL\3", before.read_text()), MODEL_BLOCK.sub(r"\1MODEL\3", after.read_text()))
            self.assertEqual((assets / floor / "model-data.json").read_bytes(), (self.component / "assets" / floor / "model-data.json").read_bytes())
            runtime = embedded_model(after)
            self.assertEqual(runtime, embedded_model(before), "HTML-only environment settings must survive too")
            self.assertEqual((assets / floor / (floor + "_model.glb")).read_bytes(), b"synthetic immutable export snapshot")
        self.assert_baseline_unchanged()

    async def test_item_edit_survives_publication_and_restart_without_geometry_loss(self):
        draft = copy.deepcopy(self.project.document["project"])
        upper = next(floor for floor in draft["floors"] if floor["id"] == "upper")
        upper["items"][0]["position_m"]["x"] = 2.2
        upper["items"][0]["name"] = "Edited synthetic lamp"
        await self.project.save(0, draft)
        self.assertIsNone(self.project.document["published_revision"])
        self.assert_baseline_unchanged()
        assets, site, models, inventory, references = await self.project.publish(1)
        expected = copy.deepcopy(self.models)
        expected["upper"]["inventory"] = upper["items"]
        self.assertEqual(models, expected)
        self.assertEqual(embedded_model(assets / "upper/index.html")["inventory"], self.models["upper"]["inventory"], "Embedded originals anchor custom motion and curtain geometry; HA supplies the saved placements")
        self.assertFalse(any(part["kind"] == "inventory" for part in embedded_model(assets / "upper/index.html")["meshes"]), "Old transformed inventory must not render under the edited object")
        restarted = generated.GeneratedProject(self.hass, self.component, self.site, self.models, self.inventory)
        loaded = await restarted.load()
        self.assertEqual(loaded, (assets, site, models, references))
        self.assertEqual(restarted.document["project"], draft)
        self.assertEqual(restarted.document["inventory"], inventory)
        self.assertEqual(restarted.document["published_revision"], 1)
        self.assert_baseline_unchanged()

    async def test_new_item_is_added_without_rewriting_existing_runtime_origins(self):
        draft = copy.deepcopy(self.project.document["project"])
        item = copy.deepcopy(draft["floors"][0]["items"][0])
        item.update(id="new_lamp", name="Added lamp", entity_id="light.added_lamp")
        item["position_m"]["x"] = 3
        draft["floors"][0]["items"].append(item)
        draft["floors"][0]["items"][0]["position_m"]["x"] = 2.2
        await self.project.save(0, draft)
        assets, _, models, inventory, _ = await self.project.publish(1)
        self.assertEqual(models["upper"]["inventory"], draft["floors"][0]["items"])
        self.assertEqual(inventory["upper"]["items"], draft["floors"][0]["items"])
        runtime = embedded_model(assets / "upper/index.html")
        self.assertEqual(runtime["inventory"], self.models["upper"]["inventory"] + [item])
        self.assertEqual(runtime["motion_paths"], self.models["upper"]["motion_paths"])
        self.assertEqual(runtime["cover_windows"], self.models["upper"]["cover_windows"])
        self.assertEqual(runtime["object_assets"]["custom_lamp"], self.models["upper"]["object_assets"]["custom_lamp"])
        self.assert_baseline_unchanged()

    async def test_overlay_geometry_is_additive_and_can_be_removed(self):
        original = copy.deepcopy(self.project.document["project"])
        draft = copy.deepcopy(original)
        floor = next(value for value in draft["floors"] if value["id"] == "upper")
        floor["rooms"].append({"id": "added_room", "name": "Added room", "polygon": [[8, 0], [11, 0], [11, 3], [8, 3]], "material": "floor"})
        floor["walls"].append({"id": "added_wall", "start": [8, 0], "end": [11, 0], "thickness_m": .15})
        await self.project.save(0, draft)
        _, site, models, _, _ = await self.project.publish(1)
        self.assertEqual(site, self.site)
        self.assertEqual(models["ground"], self.models["ground"])
        self.assertEqual(models["upper"]["rooms"][:1], self.models["upper"]["rooms"])
        self.assertTrue(any(room["id"] == "added_room" for room in models["upper"]["rooms"]))
        self.assertGreater(len(models["upper"]["meshes"]), len(self.models["upper"]["meshes"]))
        for part in self.models["upper"]["meshes"]:
            self.assertIn(part, models["upper"]["meshes"])
        for key in ("object_assets", "room_activity", "cover_windows", "custom_extension", "calibration"):
            self.assertEqual(models["upper"][key], self.models["upper"][key])
        await self.project.save(1, original)
        _, _, restored, _, _ = await self.project.publish(2)
        self.assertEqual(restored, self.models)
        self.assert_baseline_unchanged()

    async def test_unsafe_or_ambiguous_model_blocks_cannot_publish(self):
        path = self.component / "assets/upper/index.html"
        original = path.read_text()
        block = MODEL_BLOCK.search(original).group()
        candidates = [original.replace(block, block + block),
                      original.replace('id="modelData" type="application/json"', 'id="modelData" type="text/javascript"'),
                      original.replace(block, '<script id="modelData" type="application/json">invalid JSON</script>')]
        for index, invalid in enumerate(candidates):
            with self.subTest(case=index):
                path.write_text(invalid)
                adapter = generated.GeneratedProject(self.hass, self.component, self.site, self.models, self.inventory)
                with self.assertRaises(native.NativeError):
                    await adapter.load()
                    await adapter.save(0, copy.deepcopy(adapter.document["project"]))
                    await adapter.publish(1)
                self.assertIsNone(adapter.document["published_revision"])
                self.hass.saved.clear()
        path.write_text(original)
        self.assert_baseline_unchanged()

    async def test_protected_architecture_and_invalid_items_never_replace_a_draft(self):
        original = copy.deepcopy(self.project.document)
        mutations = [lambda value: value["floors"].pop(),
                     lambda value: value["floors"][0]["rooms"].clear(),
                     lambda value: value["floors"][0]["rooms"][0]["polygon"][0].__setitem__(0, .2),
                     lambda value: value["floors"][0].__setitem__("height_m", 3.5),
                     lambda value: value["floors"][0]["items"][0]["position_m"].__setitem__("x", float("nan"))]
        for index, mutate in enumerate(mutations):
            with self.subTest(case=index):
                draft = copy.deepcopy(original["project"])
                mutate(draft)
                with self.assertRaises(native.NativeError):
                    await self.project.save(0, draft)
                self.assertEqual(self.project.document, original)
                self.assert_baseline_unchanged()

    async def test_failed_publication_keeps_previous_generation_and_saved_draft(self):
        assets, _, _, _, _ = await self.publish_seed()
        active_before = tree_hashes(assets)
        draft = copy.deepcopy(self.project.document["project"])
        draft["floors"][0]["items"][0]["position_m"]["z"] = 1.5
        await self.project.save(1, draft)
        before = copy.deepcopy(self.project.document)
        stored = copy.deepcopy(self.hass.saved)
        self.hass.fail_save = True
        with self.assertRaises((native.NativeError, OSError)):
            await self.project.publish(2)
        self.hass.fail_save = False
        self.assertEqual(self.project.document, before)
        self.assertEqual(self.hass.saved, stored)
        self.assertEqual(tree_hashes(assets), active_before)
        restarted = generated.GeneratedProject(self.hass, self.component, self.site, self.models, self.inventory)
        loaded = await restarted.load()
        self.assertEqual(loaded[0], assets)
        self.assertEqual(restarted.document["project"], draft)
        self.assertEqual(restarted.document["published_revision"], 1)
        self.assert_baseline_unchanged()

    def integration_state(self):
        state = {"native": self.project, "lock": asyncio.Lock(), "recovery": None,
                 "has_editor": True, "initialized": True, "curtains": {"capture": lambda: None},
                 "store": support.MemoryStore(self.hass, 1, integration.STORE_KEY)}
        integration._apply_active(state, self.component / "assets", self.site, self.models, self.inventory,
                                  self.project.references)
        self.hass.data[integration.DOMAIN] = state
        self.hass.saved[integration.STORE_KEY] = copy.deepcopy(self.inventory)
        return state

    async def test_placement_storage_transitions_only_after_successful_save_and_publish(self):
        state = self.integration_state()
        connection = support.Connection()
        items = copy.deepcopy(self.inventory["upper"]["items"])
        items[0]["position_m"]["x"] = 1.5
        await integration.ws_save(self.hass, connection, {"id": 1, "floor": "upper", "revision": 7, "items": items})
        self.assertEqual(connection.errors, [])
        self.assertEqual(state["data"]["upper"], {"revision": 8, "items": items})
        self.assertEqual(self.project.document["revision"], 1)
        self.assertEqual(self.project.document["project"]["floors"][0]["items"], items)
        self.assertNotIn(self.project.store.key, self.hass.saved, "Legacy placement writes must not create a competing generated Store")
        before_document, before_data = copy.deepcopy(self.project.document), copy.deepcopy(state["data"])
        self.hass.fail_save = True
        failed_items = copy.deepcopy(items)
        failed_items[0]["position_m"]["x"] = 2
        with self.assertRaises(OSError):
            await integration.ws_save(self.hass, connection, {"id": 2, "floor": "upper", "revision": 8, "items": failed_items})
        self.hass.fail_save = False
        self.assertEqual(self.project.document, before_document)
        self.assertEqual(state["data"], before_data)

        draft = copy.deepcopy(self.project.document["project"])
        draft["floors"][0]["items"][0]["name"] = "Saved Studio draft"
        await integration.ws_project_save(self.hass, connection, {"id": 3, "revision": 1, "project": draft})
        await integration.ws_save(self.hass, connection, {"id": 4, "floor": "upper", "revision": 8, "items": failed_items})
        self.assertEqual(connection.errors[-1][0], "conflict")
        self.assertEqual(state["data"], before_data)
        self.assertEqual(self.project.document["project"], draft)
        self.assertEqual(self.hass.saved[integration.STORE_KEY], before_data)

        await integration.ws_project_publish(self.hass, connection, {"id": 5, "revision": 2})
        self.assertEqual(self.project.document["published_revision"], 2)
        self.assertNotEqual(state["assets"], self.component / "assets")
        active_assets = state["assets"]
        edited_items = copy.deepcopy(state["data"]["upper"]["items"])
        edited_items[0]["position_m"]["x"] = 2.4
        await integration.ws_save(self.hass, connection, {"id": 6, "floor": "upper", "revision": state["data"]["upper"]["revision"], "items": edited_items})
        self.assertEqual(self.project.document["revision"], 3)
        self.assertEqual(self.project.document["published_revision"], 3)
        self.assertEqual(self.project.document["project"]["floors"][0]["items"], edited_items)
        self.assertEqual(self.hass.saved[integration.STORE_KEY], before_data, "Published generated homes own subsequent writes")
        restarted = generated.GeneratedProject(self.hass, self.component, self.site, self.models, before_data)
        active = await restarted.load()
        self.assertEqual(active[0], active_assets)
        self.assertEqual(restarted.document["inventory"]["upper"]["items"], edited_items)
        self.assertEqual(restarted.document["project"], self.project.document["project"])
        self.assert_baseline_unchanged()

    async def test_setup_requires_complete_studio_then_restores_active_generated_publication(self):
        self.hass.saved[integration.STORE_KEY] = copy.deepcopy(self.inventory)
        site_adapter = support.types.SimpleNamespace(async_prepare=AsyncMock())
        finish = AsyncMock(return_value=True)
        with patch.object(integration, "ROOT", self.component), patch.object(integration, "SITE", self.site), \
                patch.object(integration, "FLOORS", {key: value["stem"] for key, value in self.site["floors"].items()}), \
                patch.object(integration, "SITE_ADAPTER", site_adapter, create=True), \
                patch.object(integration, "_finish_setup", finish):
            await integration.async_setup(self.hass, {})
            self.assertIsNone(self.hass.data[integration.DOMAIN]["native"], "Thin viewer packages must remain viewer-only")
            self.assertEqual(self.hass.data[integration.DOMAIN]["models"], self.models)
            self.hass.data.clear()
            bundled = self.component / "static/studio/planner/index.html"
            bundled.parent.mkdir(parents=True)
            bundled.write_text("Synthetic bundled editor")
            (self.component / "studio-files.json").write_text('["planner/index.html"]')
            await integration.async_setup(self.hass, {})
            self.assertIsNone(self.hass.data[integration.DOMAIN]["native"], "Editor assets without their compiler cannot author")
            self.hass.data.clear()
            runtime = self.component / "runtime/planner/project.py"
            runtime.parent.mkdir(parents=True)
            runtime.write_text("# Synthetic availability marker; compiler is injected by this test")
            await integration.async_setup(self.hass, {})
            state = self.hass.data[integration.DOMAIN]
            self.assertIsInstance(state["native"], generated.GeneratedProject)
            initial = integration._project_result(state, support.Connection())
            self.assertTrue(initial["capabilities"]["authoring"])
            self.assertFalse(initial["capabilities"]["architecture_editing"])
            self.assertTrue(initial["has_published"])
            self.assertIn("sensor.synthetic_environment", state["model_entities"]["upper"])
            self.assertIsNone(initial["published_revision"])
            self.assertIsNotNone(initial["project"])
            self.assertFalse(initial["has_saved_draft"], "A projected generated source is not yet a saved private draft")
            draft = copy.deepcopy(state["native"].document["project"])
            draft["floors"][0]["items"][0]["position_m"]["x"] = 2.5
            self.hass.fail_save = True
            with self.assertRaises(OSError):
                await state["native"].save(0, draft)
            self.assertFalse(integration._project_result(state, support.Connection())["has_saved_draft"])
            self.hass.fail_save = False
            await state["native"].save(0, draft)
            self.assertTrue(integration._project_result(state, support.Connection())["has_saved_draft"])
            assets, site, models, inventory, references = await state["native"].publish(1)
            self.hass.data.clear()
            await integration.async_setup(self.hass, {})
            restored = self.hass.data[integration.DOMAIN]
            self.assertEqual(restored["assets"], assets)
            self.assertEqual(restored["site"], site)
            self.assertEqual(restored["models"], models)
            self.assertEqual(restored["data"], inventory)
            self.assertEqual(restored["model_entities"], references)
            self.assertIn("sensor.synthetic_environment", restored["model_entities"]["upper"])
            self.assertEqual(restored["native"].document["project"], draft)
            self.assertTrue(integration._project_result(restored, support.Connection())["has_saved_draft"])

    async def start_installed_home(self):
        """Exercise real startup/storage resolution with a complete synthetic bundle."""
        bundled = self.component / "static/studio/planner/index.html"
        bundled.parent.mkdir(parents=True, exist_ok=True)
        bundled.write_text("Synthetic bundled editor")
        (self.component / "studio-files.json").write_text('["planner/index.html"]')
        runtime = self.component / "runtime/planner/project.py"
        runtime.parent.mkdir(parents=True, exist_ok=True)
        runtime.write_text("# Synthetic availability marker; compiler is injected by this test")
        self.hass.data.clear()
        with patch.object(integration, "ROOT", self.component), patch.object(integration, "SITE", self.site), \
                patch.object(integration, "FLOORS", {key: value["stem"] for key, value in self.site["floors"].items()}), \
                patch.object(integration, "SITE_ADAPTER", support.types.SimpleNamespace(async_prepare=AsyncMock()), create=True), \
                patch.object(integration, "_finish_setup", AsyncMock(return_value=True)):
            await integration.async_setup(self.hass, {})
        state = self.hass.data[integration.DOMAIN]
        state["initialized"] = True
        state["curtains"] = {"capture": lambda: None}
        return state

    async def export_current(self, state, floor=None):
        connection = support.Connection()
        project = state["native"]
        await integration.ws_export_model(self.hass, connection, {
            "id": 1, "revision": project.document["revision"], "project": project.document["project"],
            "floor": floor, "format": "glb"})
        self.assertEqual(connection.errors, [])
        raw = base64.b64decode(connection.results[-1]["base64"])
        length = struct.unpack_from("<I", raw, 12)[0]
        return json.loads(raw[20:20 + length])

    async def test_missing_legacy_store_or_floor_seeds_independent_compiled_inventory(self):
        defaults = {floor: {"revision": 0, "items": copy.deepcopy(model["inventory"])}
                    for floor, model in self.models.items()}
        for saved in (None, {}, {"ground": self.inventory["ground"]}):
            with self.subTest(saved=saved):
                self.hass.saved.clear()
                if saved is not None:
                    self.hass.saved[integration.STORE_KEY] = copy.deepcopy(saved)
                stored = copy.deepcopy(self.hass.saved)
                state = await self.start_installed_home()
                expected = {**defaults, **(saved or {})}
                self.assertEqual(state["data"], expected)
                self.assertEqual(state["native"].document["inventory"], expected)
                for floor in state["native"].document["project"]["floors"]:
                    self.assertEqual(floor["items"], expected[floor["id"]]["items"])
                self.assertEqual(self.hass.saved, stored, "Defaulting must not write storage")
                connection = support.Connection()
                await integration.ws_export(self.hass, connection, {"id": 1, "floor": "upper", "format": "glb"})
                self.assertEqual(connection.errors, [], "Fresh inventory matches the original model download")
                exported = await self.export_current(state)
                furniture = [node for node in exported["nodes"] if node["name"].startswith("Lamp ") and "children" in node]
                self.assertEqual(len(furniture), 2, "Both commissioned objects must reach Blender")
                self.assertTrue(all(node["translation"] == [1, 0, 1] for node in furniture))
                state["data"]["upper"]["items"][0]["position_m"]["x"] = 99
                self.assertEqual(state["models"]["upper"]["inventory"][0]["position_m"]["x"], 1)
                self.assertEqual(state["native"].document["inventory"]["upper"]["items"][0]["position_m"]["x"], 1)

    async def test_explicit_legacy_lists_remain_authoritative_including_revision_zero_empty(self):
        edited = copy.deepcopy(self.inventory["upper"]["items"][0])
        edited.update(name="Saved placement", room="room_a")
        edited["position_m"]["x"] = 2
        added = copy.deepcopy(edited)
        added.update(id="added_lamp", name="Added placement")
        for entry in ({"revision": 0, "items": []}, {"revision": 8, "items": []},
                      {"revision": 9, "items": [edited, added]}, {"revision": 10, "items": [added]}):
            with self.subTest(entry=entry):
                self.hass.saved[integration.STORE_KEY] = {"upper": copy.deepcopy(entry)}
                stored = copy.deepcopy(self.hass.saved)
                state = await self.start_installed_home()
                self.assertEqual(state["data"]["upper"], entry)
                self.assertEqual(state["native"].document["project"]["floors"][0]["items"], entry["items"])
                exported = await self.export_current(state, "upper")
                self.assertEqual(len([node for node in exported["nodes"] if node["name"].startswith("Lamp ") and "children" in node]), len(entry["items"]))
                self.assertEqual(self.hass.saved, stored)
        self.hass.saved[integration.STORE_KEY] = {"upper": {"revision": 0, "items": [added, added]}}
        with self.assertRaisesRegex(ValueError, "unique"):
            await self.start_installed_home()

    async def test_seeded_object_deletion_survives_legacy_save_publish_and_restarts(self):
        state = await self.start_installed_home()
        connection = support.Connection()
        await integration.ws_save(self.hass, connection, {"id": 1, "floor": "upper", "revision": 0, "items": []})
        self.assertEqual(connection.errors, [])
        state = await self.start_installed_home()
        self.assertEqual(state["data"]["upper"], {"revision": 1, "items": []})
        self.assertEqual(state["native"].document["project"]["floors"][0]["items"], [])
        await integration.ws_project_save(self.hass, connection, {
            "id": 2, "revision": 0, "project": state["native"].document["project"]})
        await integration.ws_project_publish(self.hass, connection, {"id": 3, "revision": 1})
        self.assertEqual(connection.errors, [])
        published = copy.deepcopy(state["native"].document)
        for _ in range(2):
            state = await self.start_installed_home()
            self.assertEqual(state["native"].document, published)
            self.assertEqual(state["data"]["upper"]["items"], [])
            exported = await self.export_current(state, "upper")
            self.assertFalse(any(node["name"].startswith("Lamp ") for node in exported["nodes"]), "Removed raw/custom geometry must not reappear")

    async def test_pending_drafts_retain_historical_missing_floor_defaults_without_writes(self):
        for old_defaults in (True, False):
            with self.subTest(old_defaults=old_defaults):
                self.hass.saved.clear()
                inventory = {floor: {"revision": 0, "items": [] if old_defaults else copy.deepcopy(model["inventory"])}
                             for floor, model in self.models.items()}
                project = generated.GeneratedProject(self.hass, self.component, self.site, self.models, inventory)
                await project.load()
                draft = copy.deepcopy(project.document["project"])
                draft["title"] = "Retain this pending draft"
                await project.save(0, draft)
                stored, document = copy.deepcopy(self.hass.saved), copy.deepcopy(project.document)
                for _ in range(2):
                    state = await self.start_installed_home()
                    self.assertNotIn("source_error", state)
                    self.assertEqual(state["native"].document, document)
                    self.assertEqual(state["native"].installed_inventory, inventory)
                    self.assertEqual(state["data"], inventory)
                    self.assertEqual(self.hass.saved, stored)

    async def test_pending_draft_fallback_is_limited_to_absent_historical_empty_floor(self):
        inventory = {"upper": {"revision": 0, "items": []}, "ground": copy.deepcopy(self.inventory["ground"])}
        self.hass.saved[integration.STORE_KEY] = {"ground": copy.deepcopy(self.inventory["ground"])}
        project = generated.GeneratedProject(self.hass, self.component, self.site, self.models, inventory)
        await project.load()
        await project.save(0, copy.deepcopy(project.document["project"]))
        stored = copy.deepcopy(self.hass.saved)
        state = await self.start_installed_home()
        self.assertEqual(state["data"], inventory)
        self.assertEqual(self.hass.saved, stored)
        # A present legacy floor never receives the compatibility exception.
        self.hass.saved[integration.STORE_KEY]["upper"] = copy.deepcopy(self.inventory["upper"])
        with self.assertLogs(integration._LOGGER, level="ERROR"):
            state = await self.start_installed_home()
        self.assertIn("source_error", state)
        self.assertIsNone(state["native"])
        self.assertEqual(state["data"]["upper"], self.inventory["upper"])
        # Nor may an explicit empty legacy list be replaced by a stored full draft.
        self.hass.saved = copy.deepcopy(stored)
        self.hass.saved[integration.STORE_KEY]["upper"] = {"revision": 0, "items": []}
        self.hass.saved[project.store.key]["inventory"]["upper"] = copy.deepcopy(self.inventory["upper"])
        with self.assertLogs(integration._LOGGER, level="ERROR"):
            state = await self.start_installed_home()
        self.assertIn("source_error", state)
        self.assertEqual(state["data"]["upper"], {"revision": 0, "items": []})
        for incompatible in ({"revision": 1, "items": []}, {"revision": False, "items": []}, self.inventory["upper"]):
            self.hass.saved = copy.deepcopy(stored)
            self.hass.saved[project.store.key]["inventory"]["upper"] = copy.deepcopy(incompatible)
            with self.assertLogs(integration._LOGGER, level="ERROR"):
                state = await self.start_installed_home()
            self.assertIn("source_error", state)
            self.assertEqual(state["data"]["upper"]["items"], self.models["upper"]["inventory"])
        self.hass.saved = copy.deepcopy(stored)
        path = self.component / "assets/upper/index.html"
        path.write_text(path.read_text() + "<!-- changed installed source -->")
        with self.assertLogs(integration._LOGGER, level="ERROR"):
            state = await self.start_installed_home()
        self.assertIn("source_error", state, "Historical defaults cannot bypass source hash verification")

    async def test_native_draft_flag_changes_only_after_a_successful_save(self):
        project = native.NativeProject(self.hass)
        state = {"native": project, "has_editor": True}
        integration._apply_active(state, None, {"floors": {}, "default_floor": None}, {}, {}, {})
        before = integration._project_result(state, support.Connection())
        self.assertIsNone(before["project"])
        self.assertFalse(before["has_saved_draft"])
        draft = copy.deepcopy(self.project.document["project"])
        self.hass.fail_save = True
        with self.assertRaises(OSError):
            await project.save(0, draft)
        self.assertFalse(integration._project_result(state, support.Connection())["has_saved_draft"])
        self.hass.fail_save = False
        await project.save(0, draft)
        saved = integration._project_result(state, support.Connection())
        self.assertTrue(saved["has_saved_draft"])
        self.assertEqual(saved["project"], draft)
        self.assertIsNone(saved["published_revision"])

    async def test_stale_geometry_downloads_are_not_presented_as_edited_exports(self):
        state = self.integration_state()
        connection = support.Connection()
        await integration.ws_viewer(self.hass, connection, {"id": 0, "floor": "upper"})
        self.assertNotIn("display:none!important", connection.results[-1]["html"])
        await integration.ws_export(self.hass, connection, {"id": 1, "floor": "upper", "format": "glb"})
        self.assertEqual(connection.results[-1]["filename"], "upper_model.glb")
        await integration.ws_project_save(self.hass, connection, {"id": 2, "revision": 0, "project": self.project.document["project"]})
        await integration.ws_project_publish(self.hass, connection, {"id": 3, "revision": 1})
        result_count = len(connection.results)
        for format in integration.FORMATS:
            await integration.ws_export(self.hass, connection, {"id": 4, "floor": "upper", "format": format})
            self.assertEqual(connection.errors[-1][0], "not_available")
        self.assertEqual(len(connection.results), result_count)
        integration.ws_project_get(self.hass, connection, {"id": 5})
        self.assertEqual(connection.results[-1]["project"], self.project.document["project"])
        self.assertEqual(state["data"], self.project.document["inventory"])
        for admin in (True, False):
            with self.subTest(admin=admin):
                reader = support.Connection(admin=admin, read=self.project.references["upper"])
                await integration.ws_viewer(self.hass, reader, {"id": 6, "floor": "upper"})
                self.assertEqual(reader.results[-1]["can_edit"], admin)
                html = reader.results[-1]["html"]
                selectors = ",".join(f"a[href$='.{format}']" for format in integration.FORMATS)
                self.assertIn(f"<style>{selectors}{{display:none!important}}</style>", html)
                self.assertNotIn("a.download,a[download]", html)
                if not admin:
                    await integration.ws_export(self.hass, reader, {"id": 7, "floor": "upper", "format": "glb"})
                    self.assertEqual(reader.errors[-1][0], "unauthorized")

    async def test_changed_private_baseline_cannot_replace_active_publication(self):
        assets, _, _, _, _ = await self.publish_seed()
        before_document, before_assets = copy.deepcopy(self.project.document), tree_hashes(assets)
        snapshot = self.project.root / "baselines" / self.project.document["baseline"] / "assets/upper/index.html"
        snapshot.write_text(snapshot.read_text() + "<!-- changed source -->")
        with self.assertRaises(native.NativeError) as caught:
            await self.project.publish(1)
        self.assertEqual(caught.exception.code, "source_changed")
        self.assertEqual(self.project.document, before_document)
        self.assertEqual(tree_hashes(assets), before_assets)
        self.assert_baseline_unchanged()

    async def test_control_anchor_detaches_only_for_independent_control_movement(self):
        model = self.models["upper"]
        fitting = copy.deepcopy(model["inventory"][0])
        fitting.update(id="ceiling_fitting", name="Ceiling fitting", type="chandelier", entity_id="light.synthetic_fitting")
        fitting["position_m"]["y"] = 2
        fitting["dimensions_m"]["height"] = .4
        other = copy.deepcopy(model["inventory"][0])
        other.update(id="other_control", name="Other control", type="switch", entity_id="switch.synthetic_other")
        model["inventory"].extend([fitting, other])
        model["control_anchors"] = {"custom_lamp": "ceiling_fitting", "other_control": "ceiling_fitting"}
        self.inventory["upper"]["items"] = copy.deepcopy(model["inventory"])
        (self.component / "assets/upper/model-data.json").write_text(encoded(model), encoding="utf-8")
        html_path = self.component / "assets/upper/index.html"
        runtime = embedded_model(html_path)
        runtime.update(inventory=model["inventory"], control_anchors=model["control_anchors"])
        html_path.write_text(MODEL_BLOCK.sub(lambda match: match[1] + encoded(runtime) + match[3], html_path.read_text()), encoding="utf-8")
        self.baseline = tree_hashes(self.component)
        self.project = generated.GeneratedProject(self.hass, self.component, self.site, self.models, self.inventory)
        await self.project.load()
        original = copy.deepcopy(self.project.document["project"])
        for revision, moved in enumerate(((), ("custom_lamp",), ("custom_lamp", "ceiling_fitting"))):
            with self.subTest(moved=moved):
                draft = copy.deepcopy(original)
                for item in draft["floors"][0]["items"]:
                    if item["id"] in moved:
                        item["position_m"]["x"] += 1
                await self.project.save(revision, draft)
                assets, _, published, _, _ = await self.project.publish(revision + 1)
                expected = {"other_control": "ceiling_fitting"} if len(moved) == 1 else model["control_anchors"]
                self.assertEqual(published["upper"]["control_anchors"], expected)
                self.assertEqual(embedded_model(assets / "upper/index.html")["control_anchors"], expected)
                self.assertEqual(published["upper"]["meshes"], model["meshes"])
                self.assert_baseline_unchanged()

    async def test_removed_or_rebound_origin_entities_remain_in_viewer_permission_index(self):
        # This entity appears only in the commissioned inventory record: no
        # mesh, control map or active placement can accidentally preserve it.
        origin_entity = "light.original_inventory_only"
        self.models["upper"]["inventory"][0]["entity_id"] = origin_entity
        self.inventory["upper"]["items"][0]["entity_id"] = origin_entity
        model_path = self.component / "assets/upper/model-data.json"
        model_path.write_text(encoded(self.models["upper"]), encoding="utf-8")
        html_path = self.component / "assets/upper/index.html"
        runtime = embedded_model(html_path)
        runtime["inventory"][0]["entity_id"] = origin_entity
        html_path.write_text(MODEL_BLOCK.sub(lambda match: match[1] + encoded(runtime) + match[3], html_path.read_text()), encoding="utf-8")
        self.baseline = tree_hashes(self.component)
        self.project = generated.GeneratedProject(self.hass, self.component, self.site, self.models, self.inventory)
        await self.project.load()
        self.assertIn("sensor.synthetic_environment", self.project.references["upper"])
        state = self.integration_state()
        draft = copy.deepcopy(self.project.document["project"])
        draft["floors"][0]["items"][0]["entity_id"] = "light.rebound_inventory"
        for revision, removed in ((0, False), (1, True)):
            with self.subTest(removed=removed):
                if removed:
                    draft["floors"][0]["items"] = []
                await self.project.save(revision, draft)
                assets, site, models, inventory, references = await self.project.publish(revision + 1)
                self.assertNotIn(origin_entity, integration.model_references(models)["upper"])
                self.assertIn(origin_entity, references["upper"])
                self.assertIn("sensor.synthetic_environment", references["upper"])
                integration._apply_active(state, assets, site, models, inventory, references)
                for hidden in (origin_entity, "sensor.synthetic_environment"):
                    restricted = support.Connection(admin=False, read=set(references["upper"]) - {hidden})
                    await integration.ws_viewer(self.hass, restricted, {"id": 1, "floor": "upper"})
                    self.assertEqual(restricted.errors[0][0], "unauthorized")
                    self.assertEqual(restricted.results, [])
                readable = support.Connection(admin=False, read=references["upper"])
                await integration.ws_viewer(self.hass, readable, {"id": 2, "floor": "upper"})
                self.assertEqual(readable.errors, [])
                self.assertFalse(readable.results[0]["can_edit"])
                restarted = generated.GeneratedProject(self.hass, self.component, self.site, self.models, self.inventory)
                restored = await restarted.load()
                self.assertEqual(restored[3], references)
                self.assert_baseline_unchanged()

    async def test_generated_authoring_keeps_admin_and_full_model_read_permissions(self):
        state = {"native": self.project, "lock": asyncio.Lock(), "recovery": None,
                 "has_editor": True, "initialized": True, "curtains": {"capture": lambda: None}}
        integration._apply_active(state, self.component / "assets", self.site, self.models, self.inventory,
                                  self.project.references)
        self.hass.data[integration.DOMAIN] = state
        before = copy.deepcopy(self.project.document)
        nonadmin = support.Connection(admin=False)
        integration.ws_project_get(self.hass, nonadmin, {"id": 1})
        await integration.ws_project_save(self.hass, nonadmin, {"id": 2, "revision": 0, "project": before["project"]})
        await integration.ws_project_publish(self.hass, nonadmin, {"id": 3, "revision": 0})
        self.assertEqual([code for code, _ in nonadmin.errors], ["unauthorized"] * 3)
        readable = set(self.project.references["upper"])
        readable.remove("camera.synthetic_camera")
        restricted = support.Connection(admin=False, read=readable)
        await integration.ws_viewer(self.hass, restricted, {"id": 4, "floor": "upper"})
        self.assertEqual(restricted.errors[0][0], "unauthorized")
        self.assertEqual(self.project.document, before)
        self.assert_baseline_unchanged()


if __name__ == "__main__":
    unittest.main()
