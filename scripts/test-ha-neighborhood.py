#!/usr/bin/env python3
"""Offline authenticated vector-map contracts; no HA or network required."""

import asyncio
import base64
import json
from pathlib import Path
import runpy
import time
import unittest
from unittest.mock import patch

fixtures = runpy.run_path(str(Path(__file__).with_name("test-ha-map.py")))
maps = fixtures["maps"]
Hass, Connection, Response = (fixtures[key] for key in ("Hass", "Connection", "Response"))
config = fixtures["config"]
TEMPLATE = "https://tiles.openfreemap.org/planet/20261101_080013_pt/{z}/{x}/{y}.pbf"
MVT = b"\x1a\x03\x0a\x01x"


def metadata(**changes):
    return Response(json.dumps({"tilejson": "3.0.0", "tiles": [TEMPLATE],
                               "minzoom": 0, "maxzoom": 14, **changes}).encode(),
                    headers={"Content-Type": "application/json"})


def tile(**kwargs):
    return Response(body=MVT, headers={"Content-Type": "application/vnd.mapbox-vector-tile"}, **kwargs)


class VectorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.hass = Hass()
        self.hass.data[maps.DOMAIN] = {"initialized": True}
        await maps.async_setup_map(self.hass, self.hass.data[maps.DOMAIN])
        self.manager = self.hass.data[maps.DOMAIN]["map"]
        self.vector = self.manager.vector_tiles
        self.manager.document["config"] = config()

    async def request(self, resource="metadata", connection=None, **fields):
        connection = connection or Connection()
        await maps.ws_map_vector(self.hass, connection, {"id": 1, "resource": resource, **fields})
        return connection

    async def test_authentication_disabled_admin_preview_and_unload(self):
        self.assertEqual((await self.request(connection=Connection(authenticated=False))).errors[0][0], "unauthorized")
        self.manager.document["config"] = None
        self.assertEqual((await self.request()).errors[0][0], "map_disabled")
        self.assertFalse(self.hass.session.calls)
        self.hass.session.responses = [metadata()]
        self.assertTrue((await self.request(connection=Connection(admin=True))).results)
        self.hass.data[maps.DOMAIN]["panels_unloaded"] = True
        self.assertEqual((await self.request()).errors[0][0], "not_loaded")

    async def test_metadata_and_tile_contract_leaks_no_source_or_configuration(self):
        self.hass.session.responses = [metadata(attribution='<script>bad</script>', secret='never'), tile()]
        result = (await self.request()).results[0]
        self.assertEqual(set(result), {"minzoom", "maxzoom", "attribution", "attribution_url"})
        self.assertEqual((result["minzoom"], result["maxzoom"]), (0, 14))
        self.assertNotIn("script", str(result))
        self.assertNotIn("planet", str(result))
        data = (await self.request("tile", z=0, x=0, y=0)).results[0]
        self.assertEqual(data, {"data": base64.b64encode(MVT).decode()})
        self.assertEqual(self.hass.saved, {})
        for url, options in self.hass.session.calls:
            self.assertTrue(url.startswith("https://tiles.openfreemap.org/planet"))
            self.assertFalse(options["allow_redirects"])
            self.assertFalse(options["auto_decompress"])
            self.assertEqual(options["timeout"], {"total": 10})
            self.assertEqual(options["headers"]["Accept-Encoding"], "identity")

    async def test_invalid_requests_never_fetch(self):
        cases = [{"resource": "style"}, {"resource": "metadata", "x": 0},
                 {"resource": "tile"}, {"resource": "tile", "z": True, "x": 0, "y": 0},
                 {"resource": "tile", "z": 15, "x": 0, "y": 0},
                 {"resource": "tile", "z": 1, "x": -1, "y": 0},
                 {"resource": "tile", "z": 1, "x": 0, "y": 2}]
        for case in cases:
            with self.subTest(case=case):
                self.assertEqual((await self.request(**case)).errors[0][0], "invalid_tile")
        self.assertFalse(self.hass.session.calls)

    async def test_rejects_untrusted_templates_zoom_and_malformed_metadata(self):
        changes = [{"tiles": [TEMPLATE.replace("tiles.openfreemap.org", "evil.test")]},
                   {"tiles": [TEMPLATE + "?token=secret"]},
                   {"tiles": [TEMPLATE.replace("/planet/", "/planet/../")]},
                   {"tiles": [TEMPLATE.replace("https://", "http://")]},
                   {"tiles": [TEMPLATE.replace(".org/", ".org:443/")]},
                   {"tiles": [TEMPLATE, TEMPLATE]}, {"maxzoom": 20},
                   {"minzoom": True}, {"maxzoom": 0, "minzoom": 1}]
        for change in changes:
            with self.subTest(change=change):
                self.vector.failures.clear()
                self.hass.session.responses = [metadata(**change)]
                connection = await self.request()
                self.assertEqual(connection.errors, [("tile_unavailable", "The vector map is temporarily unavailable.")])
        self.vector.failures.clear()
        self.hass.session.responses = [Response(b"not JSON", headers={"Content-Type": "application/json"})]
        self.assertTrue((await self.request()).errors)

    async def test_redirect_content_encoding_type_and_sizes_fail_closed(self):
        failures = [Response(status=302), Response(headers={"Content-Type": "text/html"}),
                    Response(headers={"Content-Type": "application/json", "Content-Encoding": "gzip"}),
                    Response(content_length=maps.VECTOR_METADATA_BYTES + 1),
                    Response(b" " * (maps.VECTOR_METADATA_BYTES + 1), headers={"Content-Type": "application/json"})]
        for response in failures:
            self.vector.failures.clear()
            self.hass.session.responses = [response]
            self.assertEqual((await self.request()).errors[0][0], "tile_unavailable")
        self.vector.failures.clear()
        self.hass.session.responses = [metadata(), tile(content_length=maps.VECTOR_MAX_BYTES + 1)]
        self.assertTrue((await self.request("tile", z=0, x=0, y=0)).errors)
        self.vector.failures.clear()
        self.hass.session.responses = [Response(b"x" * (maps.VECTOR_MAX_BYTES + 1),
            headers={"Content-Type": "application/vnd.mapbox-vector-tile"})]
        self.assertTrue((await self.request("tile", z=0, x=0, y=0)).errors)

    async def test_cache_coalesces_metadata_and_tiles_with_disconnect(self):
        gate = asyncio.Event()
        response = metadata()
        response.gate = gate
        self.hass.session.responses = [response, tile()]
        first = asyncio.create_task(self.vector.get(0, 0, 0))
        second = asyncio.create_task(self.vector.get(0, 0, 0))
        for _ in range(5):
            await asyncio.sleep(0)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        gate.set()
        self.assertEqual(await second, MVT)
        self.assertEqual(await self.vector.get(0, 0, 0), MVT)
        self.assertEqual(len(self.hass.session.calls), 2)
        self.assertFalse(self.vector.pending)

    async def test_concurrency_limit(self):
        self.hass.session.responses = [metadata()]
        await self.vector.metadata()
        gate = asyncio.Event()
        self.hass.session.responses = [tile(gate=gate) for _ in range(8)]
        tasks = [asyncio.create_task(self.vector.get(3, x, 0)) for x in range(8)]
        for _ in range(12):
            await asyncio.sleep(0)
        self.assertEqual(self.hass.session.maximum, 4)
        gate.set()
        self.assertEqual(await asyncio.gather(*tasks), [MVT] * 8)
        self.assertLessEqual(self.hass.session.maximum, 4)

    async def test_failure_backoff_and_timeout_safe_error(self):
        with patch.object(self.hass.session, "get", side_effect=TimeoutError("secret upstream")):
            self.assertTrue((await self.request()).errors)
        self.hass.session.responses = [metadata()]
        self.assertTrue((await self.request()).errors)
        self.assertFalse(self.hass.session.calls)
        self.vector.failures["metadata"] = time.monotonic() - 1
        self.assertTrue((await self.request()).results)

    async def test_disabled_or_unloaded_while_fetching_suppresses_response(self):
        for unload in (False, True):
            self.hass.data[maps.DOMAIN]["panels_unloaded"] = False
            self.manager.document["config"] = config()
            self.vector.cache.clear()
            self.vector.cache_bytes = 0
            gate = asyncio.Event()
            response = metadata()
            response.gate = gate
            self.hass.session.responses = [response]
            task = asyncio.create_task(self.request())
            for _ in range(5):
                await asyncio.sleep(0)
            if unload:
                self.hass.data[maps.DOMAIN]["panels_unloaded"] = True
            else:
                self.manager.document["config"]["enabled"] = False
            gate.set()
            connection = await task
            self.assertFalse(connection.results)
            self.assertEqual(connection.errors[0][0], "not_loaded" if unload else "map_disabled")

    async def test_cache_memory_eviction_and_planet_rollover(self):
        for index in range(150):
            self.vector._store(index, {"body": b"x" * 200000, "expires": time.monotonic() + 1})
        self.assertLessEqual(self.vector.cache_bytes, 16 * 1024 * 1024)
        self.assertLessEqual(len(self.vector.cache), 128)
        self.vector.cache.clear()
        self.vector.cache_bytes = 0
        self.hass.session.responses = [metadata(), tile()]
        await self.vector.get(0, 0, 0)
        self.vector.cache["metadata"]["expires"] = 0
        newer = TEMPLATE.replace("20261101_080013", "20261114_123456")
        self.hass.session.responses = [metadata(tiles=[newer]), tile()]
        await self.vector.get(0, 0, 0)
        self.assertEqual(self.hass.session.calls[-1][0], newer.format(z=0, x=0, y=0))
        self.assertEqual(len(self.hass.session.calls), 4)

    async def test_metadata_expiration_and_no_store(self):
        response = metadata()
        response.headers["Cache-Control"] = "max-age=99999999"
        self.hass.session.responses = [response]
        await self.vector.metadata()
        self.assertGreater(self.vector.cache["metadata"]["expires"], time.monotonic())
        self.assertLessEqual(self.vector.cache["metadata"]["expires"], time.monotonic() + 3600)
        self.vector.cache["metadata"]["expires"] = 0
        response = metadata()
        response.headers["Cache-Control"] = "no-store"
        self.hass.session.responses = [response, metadata()]
        await self.vector.metadata()
        self.assertNotIn("metadata", self.vector.cache)
        await self.vector.metadata()
        self.assertEqual(len(self.hass.session.calls), 3)

    async def test_request_bounds_and_lower_source_zoom(self):
        self.vector.requests = maps.MAX_TILE_REQUESTS
        self.assertEqual((await self.request()).errors[0][0], "map_busy")
        self.vector.requests = 0
        self.vector.recent_requests.extend([time.monotonic()] * maps.MAX_REQUESTS_PER_MINUTE)
        self.assertEqual((await self.request()).errors[0][0], "map_busy")
        self.assertFalse(self.hass.session.calls)
        self.vector.recent_requests.clear()
        self.hass.session.responses = [metadata(minzoom=2)]
        self.assertEqual((await self.request("tile", z=1, x=0, y=0)).errors[0][0], "invalid_tile")
        self.assertEqual(len(self.hass.session.calls), 1)

    async def test_exact_maximum_tile_and_deep_json(self):
        self.hass.session.responses = [metadata(), Response(b"x" * maps.VECTOR_MAX_BYTES,
            headers={"Content-Type": "application/vnd.mapbox-vector-tile"})]
        self.assertEqual(len(await self.vector.get(0, 0, 0)), maps.VECTOR_MAX_BYTES)
        self.vector.cache.clear()
        self.vector.cache_bytes = 0
        self.hass.session.responses = [Response(b"[" * 2000 + b"]" * 2000,
            headers={"Content-Type": "application/json"})]
        self.assertEqual((await self.request()).errors[0][0], "tile_unavailable")

    async def test_http_error_and_client_error_are_sanitized_and_not_cached(self):
        self.hass.session.responses = [Response(status=503, headers={"Content-Type": "application/json"})]
        self.assertEqual((await self.request()).errors, [("tile_unavailable", "The vector map is temporarily unavailable.")])
        self.assertFalse(self.vector.cache)
        self.vector.failures.clear()
        from aiohttp import ClientError
        with patch.object(self.hass.session, "get", side_effect=ClientError("secret URL")):
            self.assertEqual((await self.request()).errors, [("tile_unavailable", "The vector map is temporarily unavailable.")])


if __name__ == "__main__":
    unittest.main()
