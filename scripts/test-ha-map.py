#!/usr/bin/env python3
"""Private map contracts with fake HA storage/auth and an offline HTTP transport."""

import asyncio
import base64
import copy
import importlib.util
from pathlib import Path
import struct
import sys
import time
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch
import zlib

ROOT = Path(__file__).resolve().parents[1]


def module(name, **values):
    result = ModuleType(name)
    result.__dict__.update(values)
    sys.modules[name] = result
    if "." in name:
        parent, child = name.rsplit(".", 1)
        setattr(sys.modules[parent], child, result)
    return result


class HomeAssistantError(Exception):
    pass


class MemoryStore:
    def __init__(self, hass, version, key, **options):
        self.hass, self.key, self.options = hass, key, options
        self._read_only = False

    async def async_load(self):
        return copy.deepcopy(self.hass.saved.get(self.key))

    async def async_save(self, value):
        try:
            await self._async_write_data(value)
        except HomeAssistantError:
            pass  # Reproduce HA Store's default silent write failure.

    async def _async_write_data(self, value):
        if self.hass.fail_save:
            raise self.hass.fail_save
        self.hass.saved[self.key] = copy.deepcopy(value)


def identity(value):
    return value


module("voluptuous", Required=lambda name: name)
module("homeassistant")
module("homeassistant.components")
module("homeassistant.components.websocket_api", websocket_command=lambda schema: identity,
       async_response=identity, async_register_command=lambda hass, handler: hass.registered.append(handler))
module("homeassistant.exceptions", HomeAssistantError=HomeAssistantError)
module("homeassistant.helpers")
module("homeassistant.helpers.storage", Store=MemoryStore)
module("homeassistant.helpers.aiohttp_client", async_get_clientsession=lambda hass: hass.session)
module("aiohttp", ClientError=type("ClientError", (Exception,), {}), ClientTimeout=lambda **kw: kw)
spec = importlib.util.spec_from_file_location("private_map_test", ROOT / "custom_components/home_floorplan/map.py")
maps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maps)


def config(**changes):
    return {"enabled": True, "latitude": 37.5, "longitude": -122.5,
            "model_x": 2, "model_z": -3, "north_deg": 25, **changes}


def png(width=256, pixels=None):
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xffffffff)
    pixels = pixels if pixels is not None else (b"\x00" + b"\x66\x77\x88\xff" * width) * 256
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, 256, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b""))


PNG = png()


class Response:
    def __init__(self, body=PNG, status=200, headers=None, gate=None, content_length=None):
        self.body, self.status, self.gate = body, status, gate
        self.headers = {"Content-Type": "image/png", **(headers or {})}
        self.content_length = content_length
        self.content = self
        self.session = None

    async def __aenter__(self):
        self.session.active += 1
        self.session.maximum = max(self.session.maximum, self.session.active)
        return self

    async def __aexit__(self, *args):
        self.session.active -= 1

    async def iter_chunked(self, size):
        if self.gate:
            await self.gate.wait()
        for index in range(0, len(self.body), size):
            yield self.body[index:index + size]


class Session:
    def __init__(self):
        self.responses, self.calls = [], []
        self.active, self.maximum = 0, 0

    def get(self, url, **options):
        self.calls.append((url, options))
        response = self.responses.pop(0) if self.responses else Response()
        response.session = self
        return response


class Hass:
    def __init__(self):
        self.saved, self.data, self.registered = {}, {}, []
        self.fail_save, self.is_stopping = None, False
        self.config = SimpleNamespace(latitude=37.5, longitude=-122.5)
        self.session = Session()


class Connection:
    def __init__(self, admin=False, authenticated=True):
        self.user = SimpleNamespace(is_admin=admin) if authenticated else None
        self.results, self.errors = [], []

    def send_result(self, request_id, result):
        self.results.append(result)

    def send_error(self, request_id, code, message):
        self.errors.append((code, message))


class MapTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.hass = Hass()
        self.hass.data[maps.DOMAIN] = {"initialized": True}
        await maps.async_setup_map(self.hass, self.hass.data[maps.DOMAIN])
        self.manager = self.hass.data[maps.DOMAIN]["map"]
        self.admin = Connection(admin=True)

    async def save(self, revision=0, value=None, connection=None):
        connection = connection or self.admin
        await maps.ws_map_save(self.hass, connection, {"id": 1, "revision": revision,
                                                      "config": value or config()})
        return connection

    async def tile(self, connection=None, **coords):
        connection = connection or self.admin
        await maps.ws_map_tile(self.hass, connection, {"id": 1, "z": 0, "x": 0, "y": 0, **coords})
        return connection

    async def test_registration_is_idempotent_and_reference_is_read_only(self):
        await maps.async_setup_map(self.hass, self.hass.data[maps.DOMAIN])
        self.assertEqual(len(self.hass.registered), 3)
        family = Connection()
        maps.ws_map_get(self.hass, family, {"id": 1})
        self.assertEqual(family.results, [{"revision": 0, "configured": False, "config": None,
                                         "reference": {"latitude": 37.5, "longitude": -122.5}}])
        self.assertEqual(self.hass.saved, {})
        self.assertTrue(self.manager.store.options["private"])
        self.assertTrue(self.manager.store.options["atomic_writes"])

    async def test_save_is_private_detached_persistent_and_optimistic(self):
        self.hass.saved["home_floorplan.studio"] = {"project": "unchanged"}
        original = config()
        await self.save(value=original)
        self.assertEqual(self.admin.results[-1]["revision"], 1)
        original["latitude"] = 0
        self.admin.results[-1]["config"]["latitude"] = 0
        self.assertEqual(self.manager.document["config"]["latitude"], 37.5)
        self.assertEqual(self.hass.saved["home_floorplan.studio"], {"project": "unchanged"})
        self.assertEqual(vars(self.hass.config), {"latitude": 37.5, "longitude": -122.5})
        reopened = maps.HomeMap(self.hass)
        await reopened.load()
        self.assertEqual(reopened.document, self.manager.document)
        await self.save()
        self.assertEqual(self.admin.errors[-1][0], "conflict")
        self.assertEqual(reopened.document, self.manager.document)

    async def test_simultaneous_saves_have_one_winner(self):
        connections = [Connection(admin=True), Connection(admin=True)]
        await asyncio.gather(*(self.save(connection=connection) for connection in connections))
        self.assertEqual(sum(len(c.results) for c in connections), 1)
        self.assertEqual([e[0] for c in connections for e in c.errors], ["conflict"])

    async def test_nonadmin_unauthenticated_and_unloaded_fail_closed(self):
        family = await self.save(connection=Connection())
        self.assertEqual(family.errors[-1][0], "unauthorized")
        self.assertEqual((await self.tile(Connection())).errors[-1][0], "map_disabled")
        anonymous = Connection(authenticated=False)
        maps.ws_map_get(self.hass, anonymous, {"id": 1})
        await self.tile(anonymous)
        self.assertEqual([error[0] for error in anonymous.errors], ["unauthorized", "unauthorized"])
        self.hass.data[maps.DOMAIN]["panels_unloaded"] = True
        await self.save()
        self.assertEqual(self.admin.errors[-1][0], "not_loaded")
        self.assertFalse(self.hass.session.calls)

    async def test_admin_can_preview_before_save_and_family_can_read_enabled_map(self):
        await self.tile()
        result = self.admin.results[-1]
        self.assertEqual(base64.b64decode(result["data_url"].split(",", 1)[1]), PNG)
        self.assertEqual(result["attribution"], "© OpenStreetMap contributors")
        self.assertEqual(result["attribution_url"], "https://www.openstreetmap.org/copyright")
        await self.save()
        family = await self.tile(Connection())
        self.assertEqual(len(family.results), 1)
        self.assertEqual(len(self.hass.session.calls), 1)

    async def test_admin_revocation_while_waiting_for_save_lock(self):
        await self.manager.lock.acquire()
        pending = asyncio.create_task(self.save())
        await asyncio.sleep(0)
        self.admin.user.is_admin = False
        self.manager.lock.release()
        self.assertIs(await pending, self.admin)
        self.assertEqual(self.admin.errors[-1][0], "unauthorized")
        self.assertEqual(self.hass.saved, {})

    async def test_storage_failures_never_acknowledge_or_mutate(self):
        await self.save()
        before = copy.deepcopy(self.manager.document)
        self.admin.results.clear()
        for failure in (OSError("disk full"), HomeAssistantError("write failed")):
            self.hass.fail_save = failure
            await self.save(1, config(latitude=0))
            self.assertEqual(self.admin.errors[-1][0], "save_failed")
            self.assertEqual(self.manager.document, before)
            self.assertEqual(self.hass.saved[maps.STORE_KEY], before)
        self.hass.fail_save = None
        for field in ("is_stopping", "_read_only"):
            target = self.hass if field == "is_stopping" else self.manager.store
            setattr(target, field, True)
            await self.save(1)
            self.assertEqual(self.admin.errors[-1][0], "save_failed")
            setattr(target, field, False)
        self.assertFalse(self.admin.results)

    async def test_corrupt_store_is_preserved_without_breaking_setup(self):
        self.hass.saved[maps.STORE_KEY] = {"revision": 7, "config": {"unknown": "private"}}
        broken = maps.HomeMap(self.hass)
        await broken.load()
        self.assertTrue(broken.load_failed)
        with self.assertRaisesRegex(maps.MapError, "could not be loaded"):
            await broken.save(0, config(), self.admin)
        self.assertEqual(self.hass.saved[maps.STORE_KEY]["revision"], 7)

    async def test_config_revision_and_tile_validation(self):
        for field in ("latitude", "longitude", "model_x", "model_z", "north_deg"):
            for value in (True, "0", None, float("nan"), float("inf"), -(10**500), 10**500):
                with self.subTest(field=field, value=str(value)[:30]), self.assertRaises(maps.MapError):
                    maps.validate_config(config(**{field: value}))
        for changes in ({"latitude": 85.1}, {"longitude": -180.1}, {"model_x": 10001},
                        {"model_z": -10001}, {"north_deg": -1}, {"north_deg": 361}, {"enabled": 1}, {"url": "https://bad"}):
            with self.subTest(changes=changes), self.assertRaises(maps.MapError):
                maps.validate_config(config(**changes))
        self.assertEqual(maps.validate_config(config(latitude=85, longitude=-180, north_deg=360))["north_deg"], 360)
        for value in (True, -1, 1.5, "1", maps.MAX_REVISION + 1):
            with self.assertRaises(maps.MapError):
                maps.validate_revision(value)
        for values in ((True, 0, 0), (-1, 0, 0), (20, 0, 0), (1, 2, 0), (1, 0, -1), (1, "0", 0), (1, 0, 0.0)):
            with self.assertRaises(maps.MapError):
                maps.validate_tile(*values)

    async def test_transport_is_fixed_identified_and_cached(self):
        await self.tile(z=2, x=1, y=3)
        await self.tile(z=2, x=1, y=3)
        self.assertEqual(len(self.hass.session.calls), 1)
        url, options = self.hass.session.calls[0]
        self.assertEqual(url, "https://tile.openstreetmap.org/2/1/3.png")
        self.assertFalse(options["allow_redirects"])
        self.assertFalse(options["auto_decompress"])
        self.assertIn("HomeStudioMap/", options["headers"]["User-Agent"])
        self.assertNotIn("Referer", options["headers"])
        self.assertGreater(self.manager.tiles.cache[(2, 1, 3)]["expires"], time.monotonic() + 6 * 86400)

    def test_malformed_expiry_uses_default_cache_ttl(self):
        self.assertEqual(maps._cache_policy({"Expires": "invalid", "Age": "30"}),
                         (maps.TILE_TTL - 30, True))

    async def test_expired_tiles_use_conditional_request_and_304(self):
        self.hass.session.responses = [Response(headers={"Cache-Control": "max-age=0", "ETag": '"tile1"',
                                                        "Last-Modified": "Wed, 21 Oct 2026 12:00:00 GMT"}),
                                       Response(body=b"", status=304, headers={"Cache-Control": "max-age=120"})]
        await self.tile()
        await self.tile()
        headers = self.hass.session.calls[-1][1]["headers"]
        self.assertEqual(headers["If-None-Match"], '"tile1"')
        self.assertIn("If-Modified-Since", headers)
        self.assertEqual(self.manager.tiles.cache[(0, 0, 0)]["body"], PNG)
        await self.tile()
        self.assertEqual(len(self.hass.session.calls), 2)

    async def test_no_store_and_cache_entry_byte_bounds(self):
        self.hass.session.responses = [Response(headers={"Cache-Control": "no-store"})]
        await self.tile()
        self.assertFalse(self.manager.tiles.cache)
        with patch.object(maps, "MAX_CACHE_TILES", 2), patch.object(maps, "MAX_CACHE_BYTES", len(PNG) * 2):
            for x in range(4):
                await self.tile(z=2, x=x)
            self.assertEqual(list(self.manager.tiles.cache), [(2, 2, 0), (2, 3, 0)])
            self.assertEqual(self.manager.tiles.cache_bytes, len(PNG) * 2)

    async def test_bad_responses_rejected_with_bounded_negative_cache(self):
        responses = [Response(status=302, headers={"Location": "http://127.0.0.1/private"}),
                     Response(status=500), Response(headers={"Content-Type": "text/html"}),
                     Response(headers={"Content-Encoding": "gzip"}), Response(body=b"not png"),
                     Response(body=PNG[:-1]), Response(body=png(width=2048)),
                     Response(body=png(pixels=b"a" * 2_000_000)),
                     Response(content_length=maps.MAX_TILE_BYTES + 1),
                     Response(body=PNG + b"a" * maps.MAX_TILE_BYTES)]
        self.hass.session.responses = responses.copy()
        for x in range(len(responses)):
            connection = await self.tile(Connection(admin=True), z=4, x=x)
            self.assertEqual(connection.errors[-1][0], "tile_unavailable")
            self.assertNotIn("127.0.0.1", connection.errors[-1][1])
        self.assertFalse(self.manager.tiles.cache)
        calls = len(self.hass.session.calls)
        await self.tile(z=4, x=0)
        self.assertEqual(len(self.hass.session.calls), calls)

    async def test_request_coalescing_and_parallel_fetch_bound(self):
        gate = asyncio.Event()
        self.hass.session.responses = [Response(gate=gate) for _ in range(6)]
        pending = [asyncio.create_task(self.manager.tiles.get(3, x, 0)) for x in range(6)]
        pending.append(asyncio.create_task(self.manager.tiles.get(3, 0, 0)))
        try:
            for _ in range(10):
                await asyncio.sleep(0)
            self.assertEqual(len(self.hass.session.calls), maps.MAX_FETCHES)
            self.assertEqual(self.hass.session.maximum, maps.MAX_FETCHES)
        finally:
            gate.set()
        self.assertEqual(await asyncio.gather(*pending), [PNG] * 7)
        self.assertEqual(len(self.hass.session.calls), 6)

    async def test_cancelled_clients_cannot_bypass_pending_or_rate_bound(self):
        gate = asyncio.Event()
        self.hass.session.responses = [Response(gate=gate) for _ in range(2)]
        with patch.object(maps, "MAX_TILE_REQUESTS", 2):
            clients = [asyncio.create_task(self.manager.tiles.get(2, x, 0)) for x in range(2)]
            for _ in range(5):
                await asyncio.sleep(0)
            for client in clients:
                client.cancel()
            await asyncio.gather(*clients, return_exceptions=True)
            self.assertEqual(self.manager.tiles.requests, 0)
            try:
                with self.assertRaisesRegex(maps.MapError, "busy"):
                    await self.manager.tiles.get(2, 2, 0)
            finally:
                gate.set()
                await asyncio.gather(*list(self.manager.tiles.pending.values()))
        with patch.object(maps, "MAX_REQUESTS_PER_MINUTE", 1):
            with self.assertRaisesRegex(maps.MapError, "busy"):
                await self.manager.tiles.get(0, 0, 0)

    async def test_disable_or_logout_during_fetch_prevents_delivery(self):
        await self.save()
        gate = asyncio.Event()
        self.hass.session.responses = [Response(gate=gate)]
        family = Connection()
        pending = asyncio.create_task(self.tile(family))
        for _ in range(5):
            await asyncio.sleep(0)
        self.manager.document["config"]["enabled"] = False
        gate.set()
        self.assertIs(await pending, family)
        self.assertEqual(family.errors[-1][0], "map_disabled")
        self.assertFalse(family.results)


if __name__ == "__main__":
    unittest.main()
