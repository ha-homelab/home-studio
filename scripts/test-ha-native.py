#!/usr/bin/env python3
"""Exercise native storage, packaging and authenticated handlers without a HA server."""
from __future__ import annotations

import asyncio
import copy
import importlib.util
import inspect
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def module(name, **attributes):
    value = types.ModuleType(name)
    value.__dict__.update(attributes)
    sys.modules[name] = value
    if "." in name:
        parent, child = name.rsplit(".", 1)
        if parent in sys.modules:
            setattr(sys.modules[parent], child, value)
    return value


class MemoryStore:
    def __init__(self, hass, version, key, **options):
        self.hass, self.key = hass, key
        self.options = options
        self._read_only = False

    async def async_load(self):
        return copy.deepcopy(self.hass.saved.get(self.key))

    async def async_save(self, value):
        if self.hass.fail_save:
            raise OSError("disk full")
        self.hass.saved[self.key] = copy.deepcopy(value)

    def async_delay_save(self, callback, delay):
        pass


class Response:
    def __init__(self, path):
        self.path, self.headers = path, {}


class HTTPNotFound(Exception):
    pass


def require_admin(handler):
    if inspect.iscoroutinefunction(handler):
        async def asynchronous(hass, connection, msg):
            if not connection.user.is_admin:
                connection.send_error(msg["id"], "unauthorized", "Administrator required")
                return None
            return await handler(hass, connection, msg)
        return asynchronous
    def synchronous(hass, connection, msg):
        if not connection.user.is_admin:
            connection.send_error(msg["id"], "unauthorized", "Administrator required")
            return None
        return handler(hass, connection, msg)
    return synchronous


def identity(value):
    return value


module("voluptuous", Schema=lambda *a, **kw: identity, Required=lambda name, **kw: name,
       Optional=lambda name, **kw: name, In=lambda *a: identity, All=lambda *a: identity,
       Coerce=lambda *a: identity, Range=lambda **kw: identity, ALLOW_EXTRA=True)
module("aiohttp")
module("aiohttp.web", FileResponse=Response, HTTPNotFound=HTTPNotFound)
module("homeassistant")
module("homeassistant.core", callback=identity, Context=lambda **kwargs: kwargs)
module("homeassistant.exceptions", HomeAssistantError=type("HomeAssistantError", (Exception,), {}))
module("homeassistant.auth")
module("homeassistant.auth.permissions")
module("homeassistant.auth.permissions.const", POLICY_READ="read", POLICY_CONTROL="control")
module("homeassistant.components")
module("homeassistant.components.frontend", async_remove_panel=lambda *args, **kwargs: None)
module("homeassistant.components.panel_custom")
module("homeassistant.components.websocket_api", websocket_command=lambda *a: identity,
       require_admin=require_admin, async_response=identity, async_register_command=lambda *a: None)
module("homeassistant.components.http", HomeAssistantView=object, StaticPathConfig=lambda *a, **kw: (a, kw))
module("homeassistant.helpers")
module("homeassistant.helpers.storage", Store=MemoryStore)
module("homeassistant.helpers.config_validation", positive_int=int, entity_id=str)
for registry in ("area_registry", "device_registry", "entity_registry", "floor_registry"):
    module("homeassistant.helpers." + registry)
module("homeassistant.util")
module("homeassistant.util.dt")


def load_file(name, path, package=False):
    spec = importlib.util.spec_from_file_location(name, path, submodule_search_locations=[str(path.parent)] if package else None)
    loaded = importlib.util.module_from_spec(spec)
    sys.modules[name] = loaded
    spec.loader.exec_module(loaded)
    return loaded


integration = load_file("ha_native_test", ROOT / "custom_components/home_floorplan/__init__.py", True)
native = sys.modules["ha_native_test.native"]
packaging = load_file("ha_native_packaging", ROOT / "scripts/build-home-studio.py")
sys.path.insert(0, str(ROOT))
from planner import project as compiler


class Hass:
    def __init__(self, path):
        self.saved, self.data, self.fail_save = {}, {}, False
        self.is_stopping = False
        self.executor_calls = []
        self.config = types.SimpleNamespace(path=lambda *parts: str(path.joinpath(*parts)))
        self.states = types.SimpleNamespace(get=lambda entity_id: None, async_all=lambda: [])
        self.bus = types.SimpleNamespace(async_listen=lambda *args: lambda: None)
        self.http = types.SimpleNamespace(async_register_static_paths=self._async_noop, register_view=lambda value: None)
        self.services = types.SimpleNamespace(async_call=self._async_noop)

    async def _async_noop(self, *args, **kwargs):
        pass

    async def async_add_executor_job(self, function, *args):
        self.executor_calls.append(function)
        return await asyncio.to_thread(function, *args)


class Connection:
    def __init__(self, admin=True, read=(), control=()):
        self.user = types.SimpleNamespace(is_admin=admin, permissions=types.SimpleNamespace(
            check_entity=lambda entity_id, policy: admin or entity_id in (read if policy == "read" else control)))
        self.results, self.errors, self.events, self.subscriptions = [], [], [], {}

    def send_result(self, request_id, result=None):
        self.results.append(result)

    def send_error(self, request_id, code, message):
        self.errors.append((code, message))

    def send_event(self, request_id, event):
        self.events.append(event)


def sample():
    return json.loads((ROOT / "planner/example-home.json").read_text(encoding="utf-8"))


class StorageTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.hass = Hass(self.root)
        self.project = native.NativeProject(self.hass, self.root / ".storage/home_floorplan/studio")
        self.compiler_patch = patch.object(native, "compiler", return_value=compiler)
        self.compiler_patch.start()
        self.addCleanup(self.compiler_patch.stop)

    async def test_blank_install_and_private_store(self):
        self.assertIsNone(await self.project.load())
        self.assertIsNone(self.project.document["project"])
        self.assertEqual(self.project.store.options, {"private": True, "atomic_writes": True})
        with patch.object(integration.panel_custom, "async_register_panel", self.hass._async_noop, create=True):
            await integration.async_setup(self.hass, {})
        state = self.hass.data[integration.DOMAIN]
        connection = Connection()
        await integration.ws_viewer(self.hass, connection, {"id": 1})
        self.assertIsNone(connection.results[0]["html"])
        self.assertEqual(connection.results[0]["floors"], [])
        self.assertIsNotNone(state["native"])

    async def test_unwritable_store_does_not_acknowledge_a_draft(self):
        await self.project.save(0, sample())
        previous = copy.deepcopy(self.project.document)
        for stopping, read_only in ((True, False), (False, True)):
            self.hass.is_stopping = stopping
            self.project.store._read_only = read_only
            with self.assertRaises(native.NativeError) as error:
                await self.project.save(1, sample())
            self.assertEqual(error.exception.code, "save_failed")
            self.assertEqual(self.project.document, previous)
            self.assertEqual(self.hass.saved[self.project.store.key], previous)

    async def test_unload_keeps_routes_inert_and_reload_reuses_registration(self):
        panels = []
        async def register_panel(*args, **kwargs):
            panels.append(args[1])
        with patch.object(integration.panel_custom, "async_register_panel", register_panel, create=True):
            await integration.async_setup(self.hass, {})
            state = self.hass.data[integration.DOMAIN]
            self.assertTrue(state["initialized"])
            await integration.async_unload_entry(self.hass, None)
            connection = Connection()
            integration.ws_status(self.hass, connection, {"id": 1})
            self.assertEqual(connection.errors[0][0], "not_loaded")
            await integration.async_setup_entry(self.hass, None)
            integration.ws_status(self.hass, connection, {"id": 2})
            self.assertEqual(len(connection.results), 1)
            self.assertEqual(panels, ["home-floorplan", "home-floorplan"])
            self.assertTrue(state["static_registered"])
            self.assertTrue(state["ws_registered"])

    async def test_incomplete_registration_is_retried_and_not_marked_ready(self):
        with patch.object(integration.panel_custom, "async_register_panel", self.hass._async_noop, create=True):
            with patch.object(self.hass.http, "async_register_static_paths", side_effect=OSError("unavailable")):
                with self.assertRaises(OSError):
                    await integration.async_setup(self.hass, {})
            state = self.hass.data[integration.DOMAIN]
            self.assertFalse(state["initialized"])
            connection = Connection()
            integration.ws_status(self.hass, connection, {"id": 1})
            self.assertEqual(connection.errors[0][0], "not_loaded")
            await integration.async_setup(self.hass, {})
            self.assertTrue(state["initialized"])

    async def test_save_restart_publish_and_no_import_path_mutation(self):
        document = sample()
        paths = list(sys.path)
        await self.project.save(0, document)
        document["title"] = "Changed outside storage"
        self.assertNotEqual(self.project.document["project"]["title"], document["title"])
        assets, site, models, inventory, references = await self.project.publish(1)
        self.assertTrue((assets / "main/index.html").is_file())
        self.assertEqual(sys.path, paths)
        self.assertEqual(self.project.document["published_revision"], 1)
        restarted = native.NativeProject(self.hass, self.project.root)
        loaded_assets, loaded_site, loaded_models, loaded_references = await restarted.load()
        self.assertEqual((loaded_assets, loaded_site, loaded_models, loaded_references), (assets, site, models, references))
        self.assertEqual(restarted.document["inventory"], inventory)
        self.assertTrue(self.hass.executor_calls)

    async def test_conflicts_and_failed_save_preserve_source(self):
        await self.project.save(0, sample())
        previous = copy.deepcopy(self.project.document)
        for revision in (0, -1, True, "1"):
            with self.assertRaises(native.NativeError) as error:
                await self.project.save(revision, sample())
            self.assertEqual(error.exception.code, "conflict")
        self.hass.fail_save = True
        with self.assertRaises(OSError):
            await self.project.save(1, sample())
        self.assertEqual(self.project.document, previous)
        self.assertEqual(self.hass.saved[self.project.store.key], previous)

    async def test_blank_draft_is_saved_but_not_published(self):
        document = sample()
        document["floors"] = [document["floors"][0]]
        document["floors"][0].update(rooms=[], walls=[], openings=[], items=[])
        await self.project.save(0, document)
        self.assertEqual(self.project.document["project"], document)
        with self.assertRaises(native.NativeError) as error:
            await self.project.publish(1)
        self.assertEqual(error.exception.code, "invalid_project")
        self.assertIsNone(self.project.document["generation"])

    async def test_invalid_inputs_never_persist(self):
        candidates = [None, [], {**sample(), "path": "/private"}, {**sample(), "title": "x" * 2_000_001}]
        for document in candidates:
            with self.subTest(document_type=type(document).__name__), self.assertRaises(native.NativeError):
                await self.project.save(0, document)
        nested = []
        for index in range(30):
            nested = [nested]
        with self.assertRaises(native.NativeError):
            native.bounded_project(nested)
        with self.assertRaises(native.NativeError):
            native.bounded_project({"x": float("nan")})
        self.assertEqual(self.hass.saved, {})

    async def test_failed_publish_keeps_last_good_assets_and_active_record(self):
        await self.project.save(0, sample())
        assets, *_ = await self.project.publish(1)
        old_generation = self.project.document["generation"]
        changed = sample()
        changed["title"] = "Updated plan"
        await self.project.save(1, changed)
        with patch.object(native, "build_generation", side_effect=RuntimeError("renderer failed")), self.assertLogs(native._LOGGER, level="ERROR"):
            with self.assertRaises(native.NativeError) as error:
                await self.project.publish(2)
        self.assertEqual(error.exception.code, "build_failed")
        self.assertEqual(self.project.document["generation"], old_generation)
        self.assertTrue(assets.is_dir())
        self.hass.fail_save = True
        with self.assertRaises(OSError):
            await self.project.publish(2)
        self.assertEqual(self.project.document["generation"], old_generation)
        self.assertEqual(len(list(self.project.root.iterdir())), 1)

    async def test_viewer_save_synchronizes_source_and_conflicts_with_draft(self):
        await self.project.save(0, sample())
        assets, site, models, inventory, references = await self.project.publish(1)
        await self.project.save_inventory(inventory)
        self.assertEqual(self.project.document["revision"], 2)
        self.assertEqual(self.project.document["published_revision"], 2)
        for floor in self.project.document["project"]["floors"]:
            self.assertEqual(floor["items"], inventory[floor["id"]]["items"])
        await self.project.save(2, sample())
        with self.assertRaises(native.NativeError) as error:
            await self.project.save_inventory(inventory)
        self.assertEqual(error.exception.code, "conflict")

    async def test_recreated_floor_rejects_stale_viewers_after_republication_and_restart(self):
        original = sample()
        upstairs = copy.deepcopy(original["floors"][0])
        upstairs.update(id="upstairs", elevation_m=3)
        original["floors"].append(upstairs)
        await self.project.save(0, original)
        stale = []
        for _ in range(4):
            assets, site, models, inventory, references = await self.project.publish(1)
            stale.append(copy.deepcopy(inventory["main"]))
        self.assertGreater(stale[-1]["revision"], self.project.document["revision"])

        state = {"native": self.project, "lock": asyncio.Lock(), "recovery": None,
                 "curtains": {"capture": lambda: None}}
        integration._apply_active(state, assets, site, models, inventory, references)
        self.hass.data[integration.DOMAIN] = state
        placements = copy.deepcopy(inventory["main"]["items"])
        placements[0]["name"] = "Placement saved before removal"
        connection = Connection()
        await integration.ws_save(self.hass, connection, {
            "id": 1, "floor": "main", "revision": inventory["main"]["revision"], "items": placements})
        self.assertFalse(connection.errors)
        stale.append(copy.deepcopy(state["data"]["main"]))
        self.assertGreater(stale[-1]["revision"], state["data"]["upstairs"]["revision"])

        replacement = sample()
        replacement["floors"][0]["id"] = "replacement"
        await self.project.save(2, replacement)
        _, _, _, replaced_inventory, _ = await self.project.publish(3)
        self.assertNotIn("main", replaced_inventory)
        self.assertGreater(replaced_inventory["replacement"]["revision"], stale[-1]["revision"])

        restarted = native.NativeProject(self.hass, self.project.root)
        await restarted.load()
        recreated = sample()
        recreated["floors"][0]["items"][0]["name"] = "Newly recreated furniture"
        await restarted.save(3, recreated)
        assets, site, models, inventory, references = await restarted.publish(4)
        self.assertGreater(inventory["main"]["revision"], replaced_inventory["replacement"]["revision"])

        state = {"native": restarted, "lock": asyncio.Lock(), "recovery": None,
                 "curtains": {"capture": lambda: None}}
        integration._apply_active(state, assets, site, models, inventory, references)
        self.hass.data[integration.DOMAIN] = state
        expected = copy.deepcopy(restarted.document)
        for previous in stale:
            connection = Connection()
            await integration.ws_save(self.hass, connection, {
                "id": 1, "floor": "main", "revision": previous["revision"], "items": previous["items"]})
            self.assertEqual(connection.errors[0][0], "conflict")
            self.assertEqual(connection.results, [])
            self.assertEqual(restarted.document, expected)
            self.assertEqual(self.hass.saved[restarted.store.key], expected)

    async def test_opaque_generation_and_complete_storage_validation(self):
        for generation in ("../outside", "x" * 32, "/tmp", None):
            with self.assertRaises(native.NativeError):
                native.load_generation(self.root, generation)
        self.hass.saved[self.project.store.key] = {**self.project.document, "published_revision": 0}
        with self.assertRaises(native.NativeError):
            await self.project.load()

    async def test_generated_size_limit_does_not_activate_output(self):
        await self.project.save(0, sample())
        with patch.object(native, "MAX_GENERATED_BYTES", 1):
            with self.assertRaises(native.NativeError) as error:
                await self.project.publish(1)
        self.assertEqual(error.exception.code, "invalid_project")
        self.assertIsNone(self.project.document["generation"])
        self.assertEqual(list(self.project.root.iterdir()), [])


class PermissionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.hass = Hass(self.root)
        self.state = {"native": None, "lock": asyncio.Lock(), "recovery": None,
                      "curtains": {"memory": {"cover.blind": 10, "cover.hidden": 20}, "power": {}, "checks": {},
                                   "listeners": set(), "capture": lambda: None}}
        site = {"floors": {"main": {"stem": "main", "title": "Main"}}, "default_floor": "main", "site_features": False}
        (self.root / "main").mkdir()
        (self.root / "main/index.html").write_text('<head></head><p>Private plan</p>', encoding="utf-8")
        model = {"rooms": [{"id": "room"}], "inventory": [{"entity_id": "light.secret"}]}
        integration._apply_active(self.state, self.root, site, {"main": model}, {"main": {"revision": 0, "items": []}},
                                  integration.model_references({"main": model}))
        self.hass.data[integration.DOMAIN] = self.state

    async def test_nonadmin_cannot_call_authoring_or_export_handlers(self):
        connection = Connection(admin=False)
        for handler in (integration.ws_project_get, integration.ws_entity_catalog):
            handler(self.hass, connection, {"id": 1})
        for handler in (integration.ws_project_save, integration.ws_project_publish,
                        integration.ws_save, integration.ws_recover, integration.ws_export):
            await handler(self.hass, connection, {"id": 1})
        self.assertEqual(len(connection.errors), 7)
        self.assertTrue(all(code == "unauthorized" for code, message in connection.errors))
        self.assertEqual(connection.results, [])

    async def test_embedded_model_read_permission_checked_before_html_read(self):
        connection = Connection(admin=False)
        await integration.ws_viewer(self.hass, connection, {"id": 1, "floor": "main"})
        self.assertEqual(connection.errors[0][0], "unauthorized")
        self.assertEqual(self.hass.executor_calls, [])
        connection = Connection(admin=False, read={"light.secret"})
        await integration.ws_viewer(self.hass, connection, {"id": 2, "floor": "main"})
        self.assertFalse(connection.results[0]["can_edit"])
        self.assertEqual(connection.results[0]["readable_entities"], ["light.secret"])
        self.assertEqual(connection.results[0]["controllable_entities"], [])
        self.assertIn("Private plan", connection.results[0]["html"])

    async def test_vacuum_projection_bindings_require_both_entity_read_permissions(self):
        model = self.state["models"]["main"]
        model["vacuum_sources"] = [{"id": "fixture", "name": "Fixture vacuum",
                                    "entity_id": "vacuum.fixture", "position_entity_id": "sensor.fixture_position",
                                    "map_id": 0, "floor_id": "main", "transform": [1, 0, 0, 1, 0, 0],
                                    "bounds": [0, 0, 10, 10], "max_age_seconds": 120,
                                    "calibration": "approximate"}]
        self.state["model_entities"] = integration.model_references(self.state["models"])
        expected = {"light.secret", "vacuum.fixture", "sensor.fixture_position"}
        self.assertEqual(self.state["model_entities"]["main"], expected)
        for missing in ("vacuum.fixture", "sensor.fixture_position"):
            connection = Connection(admin=False, read=expected - {missing})
            await integration.ws_viewer(self.hass, connection, {"id": 1, "floor": "main"})
            self.assertEqual(connection.errors[0][0], "unauthorized")
            self.assertEqual(connection.results, [])
        self.assertEqual(self.hass.executor_calls, [], "denied bindings cannot read the floor HTML")
        connection = Connection(admin=False, read=expected)
        await integration.ws_viewer(self.hass, connection, {"id": 2, "floor": "main"})
        result = connection.results[-1]
        self.assertEqual(result["vacuum_sources"], [{"entity_id": "vacuum.fixture", "position_entity_id": "sensor.fixture_position"}])
        self.assertEqual(set(result["readable_entities"]), expected)
        self.assertEqual(result["controllable_entities"], [], "position reads grant no device control")

    async def test_vacuum_projection_authorization_is_bounded_and_copies_only_entity_pairs(self):
        binding = {"entity_id": "vacuum.fixture", "position_entity_id": "sensor.fixture_position"}
        source = {**binding, "name": "Fixture", "token": "not forwarded", "raw_map": {"private": True}}
        self.assertEqual(integration.vacuum_source_bindings({"vacuum_sources": [source, source]}), [binding])
        for invalid in (None, {}, "invalid", [source] * 65,
                        [{**source, "entity_id": "sensor.fixture"}],
                        [{**source, "position_entity_id": "vacuum.fixture"}],
                        [{**source, "position_entity_id": "sensor." + "a" * 138}],
                        [{**source, "entity_id": True}], [{**source, "position_entity_id": 42}]):
            with self.subTest(invalid=type(invalid).__name__):
                self.assertEqual(integration.vacuum_source_bindings({"vacuum_sources": invalid}), [])

    async def test_vacuum_bindings_remain_with_the_pinned_floor_generation(self):
        binding = {"entity_id": "vacuum.fixture", "position_entity_id": "sensor.fixture_position"}
        self.state["models"]["main"]["vacuum_sources"] = [binding]
        self.state["model_entities"] = integration.model_references(self.state["models"])
        connection = Connection(admin=False, read={"light.secret", *binding.values()})
        original = self.hass.async_add_executor_job

        async def replace_after_read(function, *args):
            result = await original(function, *args)
            if function is integration._read_open_file:
                models = {"main": {"rooms": [], "vacuum_sources": [
                    {"entity_id": "vacuum.other", "position_entity_id": "sensor.other_position"}]}}
                integration._apply_active(self.state, self.root, self.state["site"], models,
                                          {"main": {"revision": 1, "items": []}}, integration.model_references(models))
            return result

        with patch.object(self.hass, "async_add_executor_job", side_effect=replace_after_read):
            await integration.ws_viewer(self.hass, connection, {"id": 1, "floor": "main"})
        self.assertEqual(connection.errors, [])
        self.assertEqual(connection.results[-1]["vacuum_sources"], [binding])
        self.assertEqual(set(connection.results[-1]["readable_entities"]), {"light.secret", *binding.values()})

    async def test_complete_model_index_is_immutable_and_never_rescanned_by_requests(self):
        class GuardedModel(dict):
            readable = True

            def values(self):
                if not self.readable:
                    raise AssertionError("Request rescanned the immutable model")
                return super().values()

        model = GuardedModel({
            "rooms": [{"id": "room", "light": "light.room"}],
            "inventory": [{"entity_id": "light.secret", "linked": ["cover.blind"]}],
            "mesh": {"positions": [0, 1, 2], "materials": [{"metadata": ["camera.mesh"]}]},
            "assets": [{"nested": {"reference": "binary_sensor.asset"}}],
            "sensor.key_only": "ordinary label", "invalid": ["Light.wrong", "light.bad-id", None, True],
        })
        expected = {"light.room", "light.secret", "cover.blind", "camera.mesh", "binary_sensor.asset"}
        references = integration.model_references({"main": model})
        self.assertEqual(references["main"], expected)
        with self.assertRaises(TypeError):
            references["main"] = frozenset()
        with self.assertRaises(AttributeError):
            references["main"].add("light.later")
        integration._apply_active(self.state, self.root, self.state["site"], {"main": model},
                                  self.state["data"], references)
        model.readable = False
        for _ in range(3):
            connection = Connection(admin=False, read=expected, control={"cover.blind"})
            integration.ws_status(self.hass, connection, {"id": 1})
            self.assertEqual(connection.results[-1]["floors"], ["main"])
            await integration.ws_viewer(self.hass, connection, {"id": 2, "floor": "main"})
            self.assertEqual(set(connection.results[-1]["readable_entities"]), expected)
            self.assertEqual(connection.results[-1]["controllable_entities"], ["cover.blind"])
        denied = Connection(admin=False, read=expected - {"camera.mesh"})
        await integration.ws_viewer(self.hass, denied, {"id": 3, "floor": "main"})
        self.assertEqual(denied.errors[0][0], "unauthorized")

    async def test_live_inventory_guards_and_permissions_are_not_cached(self):
        readable, controllable = {"light.secret"}, {"light.secret"}
        connection = Connection(admin=False, read=readable, control=controllable)
        self.assertEqual(integration._capabilities(connection, integration.floor_entities(self.state, "main", {}))["controllable_entities"],
                         ["light.secret"])
        controllable.clear()
        self.assertEqual(integration._capabilities(connection, integration.floor_entities(self.state, "main", {}))["controllable_entities"], [])
        self.state["data"]["main"]["items"] = [{"entity_id": "cover.later", "related": "sensor.placement"}]
        self.assertEqual(integration._status(self.state, connection)["floors"], [])
        readable.update({"cover.later", "sensor.placement", "binary_sensor.guard"})
        profiles = {"cover.later": {"guard": "binary_sensor.guard"}}
        with patch.object(integration, "PROFILES", profiles):
            self.assertEqual(integration._status(self.state, connection)["floors"], ["main"])
            profiles["cover.later"]["guard"] = "binary_sensor.changed"
            self.assertEqual(integration._status(self.state, connection)["floors"], [])
            self.state["data"]["main"]["items"] = []
            self.assertEqual(integration._capabilities(connection, integration.floor_entities(self.state, "main", profiles))["readable_entities"],
                             ["light.secret"])
            self.assertEqual(integration._status(self.state, connection)["floors"], ["main"])
            readable.remove("light.secret")
            await integration.ws_viewer(self.hass, connection, {"id": 4, "floor": "main"})
            self.assertEqual(connection.errors[-1][0], "unauthorized")

    async def test_permission_revocation_during_asset_read_still_rejects_viewer(self):
        readable = {"light.secret"}
        connection = Connection(admin=False, read=readable)
        original = self.hass.async_add_executor_job

        async def revoke_before_read(function, *args):
            if function is integration._read_open_file:
                readable.clear()
            return await original(function, *args)

        with patch.object(self.hass, "async_add_executor_job", side_effect=revoke_before_read):
            await integration.ws_viewer(self.hass, connection, {"id": 5, "floor": "main"})
        self.assertFalse(connection.results)
        self.assertEqual(connection.errors[-1][0], "unauthorized")

    async def test_viewer_metadata_uses_permissions_after_each_asset_await(self):
        other = {"rooms": [], "inventory": [{"entity_id": "camera.other"}]}
        self.state["site"]["floors"]["other"] = {"stem": "other", "title": "Other"}
        self.state["site"]["default_floor"] = "other"
        self.state["models"]["other"] = other
        self.state["model_entities"] = integration.model_references(self.state["models"])
        self.state["data"]["other"] = {"revision": 0, "items": []}
        self.state["native"] = types.SimpleNamespace(document={"revision": 7, "published_revision": 5})
        original = self.hass.async_add_executor_job

        for phase in ("open", "read"):
            for grant in (False, True):
                with self.subTest(phase=phase, grant=grant):
                    readable = {"light.secret"}
                    controllable = set()
                    if not grant:
                        readable.update({"camera.other", "sun.sun"})
                        controllable.add("light.secret")
                    connection = Connection(admin=False, read=readable, control=controllable)
                    connection.user.is_admin = not grant

                    async def change_permissions(function, *args):
                        value = await original(function, *args)
                        if ((phase == "read" and function is integration._read_open_file)
                                or (phase == "open" and function.__name__ == "open")):
                            connection.user.is_admin = grant
                            if grant:
                                readable.update({"camera.other", "sun.sun"})
                                controllable.add("light.secret")
                            else:
                                readable.difference_update({"camera.other", "sun.sun"})
                                controllable.clear()
                        return value

                    with patch.object(self.hass, "async_add_executor_job", side_effect=change_permissions):
                        await integration.ws_viewer(self.hass, connection, {"id": 1, "floor": "main"})
                    self.assertFalse(connection.errors)
                    result = connection.results[-1]
                    self.assertEqual(result["can_edit"], grant)
                    self.assertEqual(result["floors"], ["main", "other"] if grant else ["main"])
                    self.assertEqual(result["default_floor"], "other" if grant else "main")
                    self.assertEqual(result["readable_entities"], ["light.secret", "sun.sun"] if grant else ["light.secret"])
                    self.assertEqual(result["controllable_entities"], ["light.secret"] if grant else [])
                    if grant:
                        self.assertEqual((result["revision"], result["published_revision"]), (0, 5))
                    else:
                        # Inventory revision stays public; native publication metadata is admin-only.
                        self.assertEqual(result["revision"], 0)
                        self.assertNotIn("published_revision", result)

    async def test_viewer_refreshes_permissions_without_mixing_publication_snapshots(self):
        self.state["native"] = types.SimpleNamespace(document={"revision": 7, "published_revision": 5})
        self.state["has_editor"] = True
        self.state["data"]["main"] = {
            "revision": 3, "items": [{"entity_id": "sensor.placement", "name": "Original placement"}],
        }
        old_inventory = self.state["data"]["main"]
        readable = {"light.secret", "sensor.placement", "binary_sensor.old_guard", "sun.sun"}
        controllable = {"light.secret"}
        connection = Connection(admin=False, read=readable, control=controllable)
        connection.user.is_admin = True
        original = self.hass.async_add_executor_job
        profiles = {"light.secret": {"guard": "binary_sensor.old_guard"}}

        async def publish_before_returning_read(function, *args):
            value = await original(function, *args)
            if function is integration._read_open_file:
                replacement = {"new": {"rooms": [], "inventory": [{"entity_id": "light.new"}]}}
                site = {"floors": {"new": {"stem": "new", "title": "New"}},
                        "default_floor": "new", "site_features": True}
                integration._apply_active(self.state, self.root / "replacement", site, replacement,
                                          {"new": {"revision": 11, "items": []}},
                                          integration.model_references(replacement))
                self.state["native"].document.update(revision=12, published_revision=11)
                self.state["has_editor"] = False
                old_inventory["items"].clear()
                profiles["light.secret"]["guard"] = "binary_sensor.new_guard"
                readable.remove("sun.sun")
                controllable.clear()
            return value

        with patch.object(integration, "PROFILES", profiles), \
             patch.object(self.hass, "async_add_executor_job", side_effect=publish_before_returning_read):
            await integration.ws_viewer(self.hass, connection, {"id": 1, "floor": "main"})
        self.assertFalse(connection.errors)
        result = connection.results[-1]
        self.assertIn("Private plan", result["html"])
        self.assertEqual((result["floor"], result["floors"], result["default_floor"]), ("main", ["main"], "main"))
        self.assertEqual((result["revision"], result["published_revision"]), (3, 5))
        self.assertEqual(result["items"], [{"entity_id": "sensor.placement", "name": "Original placement"}])
        self.assertEqual(result["readable_entities"], ["binary_sensor.old_guard", "light.secret", "sensor.placement"])
        self.assertEqual(result["controllable_entities"], [])
        self.assertTrue(result["has_editor"])
        self.assertFalse(result["site_features"])

    async def test_viewer_rechecks_inventory_and_guard_permissions_after_read(self):
        self.state["data"]["main"]["items"] = [{"entity_id": "sensor.placement"}]
        profiles = {"light.secret": {"guard": "binary_sensor.guard"}}
        original = self.hass.async_add_executor_job
        for revoked in ("sensor.placement", "binary_sensor.guard"):
            with self.subTest(revoked=revoked):
                readable = {"light.secret", "sensor.placement", "binary_sensor.guard"}
                connection = Connection(admin=False, read=readable)

                async def revoke_before_returning_read(function, *args):
                    value = await original(function, *args)
                    if function is integration._read_open_file:
                        readable.remove(revoked)
                    return value

                with patch.object(integration, "PROFILES", profiles), \
                     patch.object(self.hass, "async_add_executor_job", side_effect=revoke_before_returning_read):
                    await integration.ws_viewer(self.hass, connection, {"id": 1, "floor": "main"})
                self.assertFalse(connection.results)
                self.assertEqual(connection.errors[-1][0], "unauthorized")

    async def test_missing_or_partial_index_fails_closed(self):
        for references in (None, {}, {"other": frozenset()}):
            with self.subTest(references=references):
                if references is None:
                    self.state.pop("model_entities", None)
                else:
                    self.state["model_entities"] = references
                connection = Connection(admin=False)
                with self.assertRaises(KeyError):
                    await integration.ws_viewer(self.hass, connection, {"id": 1, "floor": "main"})
                self.assertFalse(connection.results)
                self.assertFalse(self.hass.executor_calls)
        previous = dict(self.state)
        with self.assertRaisesRegex(RuntimeError, "active floors"):
            integration._apply_active(self.state, self.root, self.state["site"], self.state["models"],
                                      self.state["data"], {})
        self.assertEqual(self.state, previous)

    async def test_inflight_viewer_rechecks_pinned_generation_after_replacement(self):
        previous = {key: self.state[key] for key in ("assets", "site", "models", "data", "model_entities")}
        new_models = {"main": {"rooms": [{"id": "other"}], "inventory": [{"entity_id": "light.new"}]}}
        new_references = integration.model_references(new_models)
        original = self.hass.async_add_executor_job
        for revoke in (False, True):
            with self.subTest(revoke=revoke):
                integration._apply_active(self.state, previous["assets"], previous["site"],
                                          previous["models"], previous["data"], previous["model_entities"])
                readable = {"light.secret"}
                connection = Connection(admin=False, read=readable)

                async def replace_before_read(function, *args):
                    if function is integration._read_open_file:
                        integration._apply_active(self.state, self.root / "replacement", previous["site"],
                                                  new_models, {"main": {"revision": 1, "items": []}}, new_references)
                        if revoke:
                            readable.clear()
                            readable.add("light.new")
                    return await original(function, *args)

                with patch.object(self.hass, "async_add_executor_job", side_effect=replace_before_read):
                    await integration.ws_viewer(self.hass, connection, {"id": 1, "floor": "main"})
                if revoke:
                    self.assertFalse(connection.results)
                    self.assertEqual(connection.errors[-1][0], "unauthorized")
                else:
                    self.assertFalse(connection.errors)
                    self.assertIn("Private plan", connection.results[-1]["html"])
                    self.assertEqual(connection.results[-1]["readable_entities"], ["light.secret"])

    async def test_unknown_floor_is_not_a_path(self):
        connection = Connection()
        await integration.ws_viewer(self.hass, connection, {"id": 1, "floor": "../../etc"})
        self.assertEqual(connection.errors[0][0], "not_found")
        self.assertFalse(self.hass.executor_calls)

    async def test_subscribed_observations_and_commands_respect_permissions(self):
        self.state["data"]["main"]["items"] = [{"entity_id": "cover.blind"}, {"entity_id": "cover.hidden"}]
        connection = Connection(admin=False, read={"cover.blind"})
        integration.ws_curtains(self.hass, connection, {"id": 1})
        self.assertEqual(connection.events[0]["memory"], {"cover.blind": 10})
        await integration.ws_curtain_command(self.hass, connection, {"id": 2, "entity_id": "cover.blind", "action": "open_cover"})
        self.assertEqual(connection.errors[0][0], "unauthorized")

    async def test_public_assets_are_exact_mapped_paths_with_cors(self):
        path = self.root / "main/index.html"
        view = native.StudioAssetsView({"planner/index.html": path})
        response = await view.get(None, "planner/index.html")
        self.assertEqual(response.path, path)
        self.assertEqual(response.headers["Access-Control-Allow-Origin"], "*")
        self.assertEqual(response.headers["Cache-Control"], "no-cache, no-transform")
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        for name in ("../../etc/passwd", "project.json", "assets/main/index.html", "%2e%2e/index.html"):
            with self.assertRaises(HTTPNotFound):
                await view.get(None, name)


class PackagingTests(unittest.TestCase):
    def test_bundle_compiler_runs_in_own_namespace_and_has_no_personal_assets(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "bundle"
            archive = packaging.build_integration(ROOT, output)
            component = output / "custom_components/home_floorplan"
            with zipfile.ZipFile(archive) as zipped:
                names = set(zipped.namelist())
                self.assertIn("config_flow.py", names)
                self.assertIn("runtime/planner/project.py", names)
                self.assertIn("runtime/viewer_locales.py", names)
                self.assertIn("static/studio.js", names)
                self.assertIn("static/studio/planner/index.html", names)
                self.assertIn("static/studio/ai/panel.js", names)
                self.assertNotIn("site.json", names)
                self.assertNotIn("project.json", names)
                self.assertFalse(any(name.startswith("assets/") or "private_site" in name or "/.storage/" in name for name in names))
                # Public demo media must ship on Pages, never in the installed
                # integration or the loopback companion's served asset set.
                website_only = {"index.html", "docs/media/native-ha-workflow.mp4",
                                "docs/media/native-ha-workflow-poster.jpg",
                                "docs/media/native-ha-workflow-preview.gif",
                                "docs/media/native-ha-workflow.en.vtt"}
                inventory = load_file("ha_native_public_inventory", ROOT / "scripts/validate-site.py")
                self.assertLessEqual(website_only, set(inventory.SITE_FILES))
                self.assertFalse({"static/studio/" + name for name in website_only} & names)
                self.assertFalse(any(name.startswith("static/studio/docs/media/") for name in names))
                served = set(json.loads(zipped.read("studio-files.json")))
                self.assertFalse(website_only & served)
                self.assertLessEqual({"planner/index.html", "ai/panel.js"}, served)
                companion = set(json.loads((ROOT / "ai_companion/assets.json").read_text()))
                self.assertFalse(website_only & companion)
                self.assertLessEqual({"planner/index.html", "ai/panel.js"}, companion)
            package = module("isolated_bundle")
            package.__path__ = [str(component)]
            bundled = __import__("isolated_bundle.runtime.planner.project", fromlist=["compile_project"])
            old_paths = list(sys.path)
            result = bundled.compile_project(sample(), Path(temporary) / "generated")
            self.assertEqual(result["floors"], [floor["id"] for floor in sample()["floors"]])
            self.assertEqual(sys.path, old_paths)
            self.assertTrue(native.studio_asset_files(component))
            with self.assertRaises(ValueError):
                packaging.build_integration(ROOT, output)

    def test_legacy_site_manifest_and_explicit_empty_install(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaises(ValueError):
                integration.load_site(root)
            self.assertEqual(integration.load_site(root, allow_empty=True)["floors"], {})
            fallback = {"site_id": None, "floors": {"main": {}}, "site_features": True}
            self.assertEqual(integration.load_site(root, fallback), fallback)


if __name__ == "__main__":
    unittest.main()
