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
                return
            return await handler(hass, connection, msg)
        return asynchronous
    def synchronous(hass, connection, msg):
        if not connection.user.is_admin:
            connection.send_error(msg["id"], "unauthorized", "Administrator required")
            return
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
        assets, site, models, inventory = await self.project.publish(1)
        self.assertTrue((assets / "main/index.html").is_file())
        self.assertEqual(sys.path, paths)
        self.assertEqual(self.project.document["published_revision"], 1)
        restarted = native.NativeProject(self.hass, self.project.root)
        loaded_assets, loaded_site, loaded_models = await restarted.load()
        self.assertEqual((loaded_assets, loaded_site, loaded_models), (assets, site, models))
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
        assets, site, models, inventory = await self.project.publish(1)
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
            assets, site, models, inventory = await self.project.publish(1)
            stale.append(copy.deepcopy(inventory["main"]))
        self.assertGreater(stale[-1]["revision"], self.project.document["revision"])

        state = {"native": self.project, "lock": asyncio.Lock(), "recovery": None,
                 "curtains": {"capture": lambda: None}}
        integration._apply_active(state, assets, site, models, inventory)
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
        _, _, _, replaced_inventory = await self.project.publish(3)
        self.assertNotIn("main", replaced_inventory)
        self.assertGreater(replaced_inventory["replacement"]["revision"], stale[-1]["revision"])

        restarted = native.NativeProject(self.hass, self.project.root)
        await restarted.load()
        recreated = sample()
        recreated["floors"][0]["items"][0]["name"] = "Newly recreated furniture"
        await restarted.save(3, recreated)
        assets, site, models, inventory = await restarted.publish(4)
        self.assertGreater(inventory["main"]["revision"], replaced_inventory["replacement"]["revision"])

        state = {"native": restarted, "lock": asyncio.Lock(), "recovery": None,
                 "curtains": {"capture": lambda: None}}
        integration._apply_active(state, assets, site, models, inventory)
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
        integration._apply_active(self.state, self.root, site, {"main": model}, {"main": {"revision": 0, "items": []}})
        self.hass.data[integration.DOMAIN] = self.state

    async def test_nonadmin_cannot_call_authoring_or_export_handlers(self):
        connection = Connection(admin=False)
        for handler in (integration.ws_project_get, integration.ws_project_save, integration.ws_project_publish,
                        integration.ws_entity_catalog, integration.ws_save, integration.ws_recover, integration.ws_export):
            result = handler(self.hass, connection, {"id": 1})
            if inspect.isawaitable(result):
                await result
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
                self.assertIn("static/studio.js", names)
                self.assertNotIn("site.json", names)
                self.assertNotIn("project.json", names)
                self.assertFalse(any(name.startswith("assets/") or "private_site" in name or "/.storage/" in name for name in names))
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
