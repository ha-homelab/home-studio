"""Private map placement and a bounded, authenticated raster tile adapter.

The placement belongs to this integration, never the portable plan or zone.home.
The installed HA map_tiles HTTP view does not expose its cache and logs upstream
tile URLs. Keep that version-specific boundary here and use HA's HTTP session
with a fixed upstream, explicit limits and no location-bearing diagnostics.
"""

import asyncio
import base64
from collections import OrderedDict, deque
import copy
from email.utils import parsedate_to_datetime
import math
import struct
import time
import zlib

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.storage import Store

DOMAIN = "home_floorplan"
STORE_KEY = DOMAIN + ".map"
MAX_REVISION = 2**53 - 1
MAX_ZOOM = 19
MAX_TILE_BYTES = 512 * 1024
MAX_CACHE_BYTES = 16 * 1024 * 1024
MAX_CACHE_TILES = 128
MAX_TILE_REQUESTS = 32
MAX_FETCHES = 4
MAX_REQUESTS_PER_MINUTE = 240
TILE_TTL = 7 * 24 * 60 * 60
FAILURE_TTL = 30
ATTRIBUTION = "© OpenStreetMap contributors"
ATTRIBUTION_URL = "https://www.openstreetmap.org/copyright"
UPSTREAM = "https://tile.openstreetmap.org"
HEADERS = {"User-Agent": "HomeStudioMap/1.0 (+https://github.com/ha-homelab/home-studio)",
           "Accept": "image/png", "Accept-Encoding": "identity"}
CONFIG_FIELDS = {"enabled", "latitude", "longitude", "model_x", "model_z", "north_deg"}


class MapError(Exception):
    """A stable client error that never includes private input or upstream URLs."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _number(value, minimum, maximum):
    return type(value) in (int, float) and minimum <= value <= maximum and math.isfinite(value)


def validate_config(config):
    """Return detached placement; north_deg is north clockwise to model -Z."""
    if (not isinstance(config, dict) or set(config) != CONFIG_FIELDS
            or type(config.get("enabled")) is not bool
            or any(not _number(config.get(key), lower, upper) for key, lower, upper in (
                ("latitude", -85, 85), ("longitude", -180, 180),
                ("model_x", -10000, 10000), ("model_z", -10000, 10000),
                ("north_deg", 0, 360)))):
        raise MapError("invalid_map", "The map placement is invalid.")
    return dict(config)


def validate_revision(revision):
    if type(revision) is not int or not 0 <= revision <= MAX_REVISION:
        raise MapError("invalid_map", "The map revision is invalid.")
    return revision


def validate_tile(z, x, y):
    if (type(z) is not int or not 0 <= z <= MAX_ZOOM
            or type(x) is not int or type(y) is not int
            or not 0 <= x < 2**z or not 0 <= y < 2**z):
        raise MapError("invalid_tile", "The map tile coordinates are invalid.")
    return z, x, y


def _validate_png(body):
    """Reject non-PNG, oversized, truncated and decompression-bomb responses."""
    if not 57 <= len(body) <= MAX_TILE_BYTES or body[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("Invalid tile image")
    offset, chunks, compressed = 8, 0, bytearray()
    palette = False
    idat_finished = False
    ended = False
    while offset + 12 <= len(body):
        size = struct.unpack_from(">I", body, offset)[0]
        kind = body[offset + 4:offset + 8]
        end = offset + 12 + size
        if (end > len(body) or chunks >= 1024
                or any(not (65 <= char <= 90 or 97 <= char <= 122) for char in kind)
                or kind[0] <= 90 and kind not in (b"IHDR", b"PLTE", b"IDAT", b"IEND")):
            raise ValueError("Invalid tile image")
        data = body[offset + 8:offset + 8 + size]
        checksum = struct.unpack_from(">I", body, offset + 8 + size)[0]
        if zlib.crc32(kind + data) & 0xffffffff != checksum:
            raise ValueError("Invalid tile image")
        if chunks == 0:
            if kind != b"IHDR" or size != 13:
                raise ValueError("Invalid tile image")
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", data)
            depths = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
            if (width != 256 or height != 256 or depth not in depths.get(color, ())
                    or compression != 0 or filtering != 0 or interlace not in (0, 1)):
                raise ValueError("Invalid tile image")
        elif kind == b"IHDR":
            raise ValueError("Invalid tile image")
        if kind == b"PLTE":
            if palette or compressed or not size or size % 3 or size > 768:
                raise ValueError("Invalid tile image")
            palette = True
        if kind == b"IDAT":
            if idat_finished or color == 3 and not palette:
                raise ValueError("Invalid tile image")
            compressed.extend(data)
        elif compressed:
            idat_finished = True
        if kind == b"IEND":
            if size or end != len(body):
                raise ValueError("Invalid tile image")
            ended = True
            break
        offset, chunks = end, chunks + 1
    if not ended or not compressed:
        raise ValueError("Invalid tile image")
    decoder = zlib.decompressobj()
    # More than a 256x256 16-bit RGBA image, including Adam7 row overhead.
    raw = decoder.decompress(bytes(compressed), 530000)
    if not raw or not decoder.eof or decoder.unconsumed_tail or decoder.unused_data:
        raise ValueError("Invalid tile image")
    bits = depth * {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
    passes = ((0, 0, 1, 1),) if not interlace else (
        (0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4),
        (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2))
    offset = 0
    for start_x, start_y, step_x, step_y in passes:
        columns = max(0, (width - start_x + step_x - 1) // step_x)
        rows = max(0, (height - start_y + step_y - 1) // step_y)
        if not columns:
            continue
        stride = (columns * bits + 7) // 8 + 1
        for _ in range(rows):
            if offset + stride > len(raw) or raw[offset] > 4:
                raise ValueError("Invalid tile image")
            offset += stride
    if offset != len(raw):
        raise ValueError("Invalid tile image")


def _cache_policy(headers):
    """Honor upstream freshness and validators, falling back to seven days."""
    directives = [part.strip().lower() for part in headers.get("Cache-Control", "").split(",")]
    if "no-store" in directives:
        return 0, False
    ttl = None
    for part in directives:
        key, _, value = part.partition("=")
        value = value.strip('"')
        if key == "max-age" and value.isdigit() and len(value) <= 12:
            ttl = min(int(value), 365 * 24 * 60 * 60)
            break
    if ttl is None and headers.get("Expires"):
        try:
            ttl = max(0, parsedate_to_datetime(headers["Expires"]).timestamp() - time.time())
        except (TypeError, ValueError, OverflowError):
            # Malformed upstream expiry dates use the same fallback as missing dates.
            ttl = TILE_TTL
    if "no-cache" in directives:
        ttl = 0
    age = headers.get("Age", "0")
    age = int(age) if age.isdigit() and len(age) <= 12 else 0
    return max(0, (TILE_TTL if ttl is None else ttl) - age), True


class RasterTiles:
    """Coalesce requests, bound upstream concurrency, and cache viewed tiles."""

    def __init__(self, hass):
        self.hass = hass
        self.cache = OrderedDict()
        self.cache_bytes = 0
        self.failures = OrderedDict()
        self.pending = {}
        self.requests = 0
        self.recent_requests = deque()
        self.semaphore = asyncio.Semaphore(MAX_FETCHES)

    def _store(self, key, entry):
        previous = self.cache.pop(key, None)
        if previous:
            self.cache_bytes -= len(previous["body"])
        self.cache[key] = entry
        self.cache_bytes += len(entry["body"])
        while len(self.cache) > MAX_CACHE_TILES or self.cache_bytes > MAX_CACHE_BYTES:
            _, removed = self.cache.popitem(last=False)
            self.cache_bytes -= len(removed["body"])

    async def get(self, z, x, y):
        key = validate_tile(z, x, y)
        now = time.monotonic()
        while self.recent_requests and self.recent_requests[0] <= now - 60:
            self.recent_requests.popleft()
        if self.requests >= MAX_TILE_REQUESTS or len(self.recent_requests) >= MAX_REQUESTS_PER_MINUTE:
            raise MapError("map_busy", "The map is busy. Try again shortly.")
        self.recent_requests.append(now)
        self.requests += 1
        try:
            previous = self.cache.get(key)
            if previous:
                self.cache.move_to_end(key)
                if previous["expires"] > now:
                    return previous["body"]
            if self.failures.get(key, 0) > now:
                raise MapError("tile_unavailable", "The map tile is temporarily unavailable.")
            task = self.pending.get(key)
            if task is None:
                if len(self.pending) >= MAX_TILE_REQUESTS:
                    raise MapError("map_busy", "The map is busy. Try again shortly.")
                # Names and errors intentionally omit the location-bearing key.
                task = asyncio.create_task(self._fetch(key, previous), name="home_floorplan map tile")
                self.pending[key] = task
                task.add_done_callback(lambda done: self._finished(key, done))
            return await asyncio.shield(task)
        finally:
            self.requests -= 1

    def _finished(self, key, task):
        self.pending.pop(key, None)
        # Consume failures even if the sole requesting browser disconnected.
        if not task.cancelled():
            task.exception()

    async def _fetch(self, key, previous):
        # Lazy imports keep the independent storage API available during setup.
        from aiohttp import ClientError, ClientTimeout
        from homeassistant.helpers.aiohttp_client import async_get_clientsession

        headers = dict(HEADERS)
        if previous:
            for source, target in (("etag", "If-None-Match"), ("modified", "If-Modified-Since")):
                if previous.get(source):
                    headers[target] = previous[source]
        try:
            async with asyncio.timeout(25), self.semaphore:
                session = async_get_clientsession(self.hass)
                async with session.get(
                    UPSTREAM + "/%d/%d/%d.png" % key, headers=headers,
                    timeout=ClientTimeout(total=10), allow_redirects=False, auto_decompress=False,
                ) as response:
                    ttl, cacheable = _cache_policy(response.headers)
                    if response.status == 304 and previous:
                        entry = {**previous, "expires": time.monotonic() + ttl}
                    else:
                        if (response.status != 200
                                or response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "image/png"
                                or response.headers.get("Content-Encoding", "identity").lower() != "identity"
                                or response.content_length is not None and response.content_length > MAX_TILE_BYTES):
                            raise ValueError("Invalid tile response")
                        body = bytearray()
                        async for chunk in response.content.iter_chunked(32 * 1024):
                            body.extend(chunk)
                            if len(body) > MAX_TILE_BYTES:
                                raise ValueError("Invalid tile response")
                        body = bytes(body)
                        _validate_png(body)
                        entry = {"body": body, "expires": time.monotonic() + ttl,
                                 "etag": self._validator(response.headers.get("ETag")),
                                 "modified": self._validator(response.headers.get("Last-Modified"))}
                    if cacheable:
                        self._store(key, entry)
                    elif key in self.cache:
                        self.cache_bytes -= len(self.cache.pop(key)["body"])
                    self.failures.pop(key, None)
                    return entry["body"]
        except (ClientError, TimeoutError, ValueError, zlib.error):
            self.failures[key] = time.monotonic() + FAILURE_TTL
            self.failures.move_to_end(key)
            while len(self.failures) > MAX_CACHE_TILES:
                self.failures.popitem(last=False)
            raise MapError("tile_unavailable", "The map tile is temporarily unavailable.") from None

    @staticmethod
    def _validator(value):
        return value if isinstance(value, str) and len(value) <= 512 and "\r" not in value and "\n" not in value else None


class MapStore(Store):
    """Require completed durable storage, including on HA write failures."""

    async def async_save(self, data):
        if self.hass.is_stopping or self._read_only:
            raise MapError("save_failed", "Map placement storage is not writable.")
        await super().async_save(data)

    async def _async_write_data(self, data):
        # HA's normal Store logs and swallows its own write errors. Translate
        # before that handler so this feature cannot acknowledge a lost save.
        try:
            await super()._async_write_data(data)
        except (HomeAssistantError, OSError):
            raise MapError("save_failed", "The map placement could not be saved.") from None


class HomeMap:
    """Separate private placement storage with optimistic, atomic saves."""

    def __init__(self, hass):
        self.hass = hass
        self.store = MapStore(hass, 1, STORE_KEY, private=True, atomic_writes=True)
        self.document = {"revision": 0, "config": None}
        self.lock = asyncio.Lock()
        self.load_failed = False
        self.tiles = RasterTiles(hass)

    async def load(self):
        try:
            saved = await self.store.async_load()
            if saved is not None:
                if not isinstance(saved, dict) or set(saved) != {"revision", "config"}:
                    raise ValueError("Invalid map storage")
                self.document = {"revision": validate_revision(saved["revision"]),
                                 "config": validate_config(saved["config"])}
        except (HomeAssistantError, OSError, ValueError, MapError):
            # Preserve corrupt/inaccessible storage and keep the floorplan usable.
            self.load_failed = True

    def snapshot(self):
        if self.load_failed:
            raise MapError("map_unavailable", "The saved map placement could not be loaded.")
        reference = {}
        for key, bound in (("latitude", 90), ("longitude", 180)):
            value = getattr(self.hass.config, key, 0)
            reference[key] = value if _number(value, -bound, bound) else 0
        return {**copy.deepcopy(self.document), "configured": self.document["config"] is not None,
                "reference": reference}

    async def save(self, revision, config, connection):
        validate_revision(revision)
        config = validate_config(config)
        async with self.lock:
            _require_admin(connection)
            self.snapshot()
            if revision != self.document["revision"] or revision == MAX_REVISION:
                raise MapError("conflict", "The map placement changed. Reload it before saving.")
            updated = {"revision": revision + 1, "config": config}
            try:
                await self.store.async_save(updated)
            except OSError:
                raise MapError("save_failed", "The map placement could not be saved. The previous placement is unchanged.") from None
            self.document = updated
            return self.snapshot()


def _require_admin(connection):
    if not connection.user or not connection.user.is_admin:
        raise MapError("unauthorized", "An administrator is required to save the map placement.")


def _manager(hass, connection):
    if not connection.user:
        raise MapError("unauthorized", "Authentication is required.")
    state = hass.data.get(DOMAIN)
    if (not state or state.get("panels_unloaded") or not state.get("initialized")
            or "map" not in state):
        raise MapError("not_loaded", "Home Studio is not currently loaded.")
    return state["map"]


@websocket_api.websocket_command({vol.Required("type"): "home_floorplan/map_get"})
def ws_map_get(hass, connection, msg):
    try:
        connection.send_result(msg["id"], _manager(hass, connection).snapshot())
    except MapError as error:
        connection.send_error(msg["id"], error.code, str(error))


@websocket_api.websocket_command({vol.Required("type"): "home_floorplan/map_save",
                                 vol.Required("revision"): int, vol.Required("config"): dict})
@websocket_api.async_response
async def ws_map_save(hass, connection, msg):
    try:
        manager = _manager(hass, connection)
        _require_admin(connection)
        connection.send_result(msg["id"], await manager.save(msg["revision"], msg["config"], connection))
    except MapError as error:
        connection.send_error(msg["id"], error.code, str(error))


@websocket_api.websocket_command({vol.Required("type"): "home_floorplan/map_tile",
                                 vol.Required("z"): int, vol.Required("x"): int, vol.Required("y"): int})
@websocket_api.async_response
async def ws_map_tile(hass, connection, msg):
    try:
        manager = _manager(hass, connection)
        config = manager.snapshot()["config"]
        if (not config or not config["enabled"]) and not connection.user.is_admin:
            raise MapError("map_disabled", "The geographic map is disabled.")
        key = validate_tile(msg["z"], msg["x"], msg["y"])
        body = await manager.tiles.get(*key)
        manager = _manager(hass, connection)
        if (not manager.document["config"] or not manager.document["config"]["enabled"]) and not connection.user.is_admin:
            raise MapError("map_disabled", "The geographic map is disabled.")
        connection.send_result(msg["id"], {"z": key[0], "x": key[1], "y": key[2],
            "data_url": "data:image/png;base64," + base64.b64encode(body).decode("ascii"),
            "attribution": ATTRIBUTION, "attribution_url": ATTRIBUTION_URL})
    except MapError as error:
        connection.send_error(msg["id"], error.code, str(error))


async def async_setup_map(hass, state):
    if "map" not in state:
        manager = HomeMap(hass)
        await manager.load()
        state["map"] = manager
    if not state.get("map_registered"):
        for handler in (ws_map_get, ws_map_save, ws_map_tile):
            websocket_api.async_register_command(hass, handler)
        state["map_registered"] = True
