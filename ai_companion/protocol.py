"""Bounded JSON and preprocessed-image validation. Never decodes image pixels."""
import base64
import binascii
import json
import math
import re
import struct

MAX_DRAFT_BYTES = 256 * 1024
MAX_UPSTREAM_BYTES = 2 * 1024 * 1024
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_IMAGES_BYTES = 12 * 1024 * 1024
MAX_REQUEST_BYTES = 17 * 1024 * 1024
MAX_CONTEXT_BYTES = 384 * 1024
MAX_SCHEMA_BYTES = 64 * 1024
MAX_IMAGES = 6


class CompanionError(Exception):
    """Only messages explicitly constructed here are exposed to the browser."""
    def __init__(self, code, message, status=400, upstream_status=None):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status
        self.upstream_status = upstream_status

    def public(self):
        result = {"code": self.code, "message": self.message}
        if self.upstream_status is not None:
            result["upstream_status"] = self.upstream_status
        return {"error": result}


def reject(message="Invalid request."):
    raise CompanionError("invalid_request", message)


def dumps(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8")


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            reject("Duplicate JSON properties are not allowed.")
        result[key] = value
    return result


def _constant(_):
    reject("Nonfinite JSON numbers are not allowed.")


def bounded_tree(value, *, max_depth=24, max_nodes=24000, forbid_private=False):
    pending, count = [(value, 0)], 0
    while pending:
        node, depth = pending.pop()
        count += 1
        if depth > max_depth or count > max_nodes:
            reject("JSON structure exceeds the allowed complexity.")
        if isinstance(node, dict):
            for key, child in node.items():
                if not isinstance(key, str) or len(key) > 256:
                    reject("Invalid JSON property name.")
                if forbid_private and key.lower() in {"api_key", "authorization", "entity_id", "entity_ids", "notes", "token", "password"}:
                    reject("Context contains a private field; send only sanitized planning data.")
                pending.append((child, depth + 1))
        elif isinstance(node, list):
            pending.extend((child, depth + 1) for child in node)
        elif isinstance(node, float) and not math.isfinite(node):
            reject("Nonfinite JSON numbers are not allowed.")
        elif isinstance(node, str):
            # Reject lone surrogates, including those escaped in otherwise valid JSON.
            try:
                node.encode("utf-8")
            except UnicodeError:
                reject("Invalid Unicode in JSON.")
        elif node is not None and not isinstance(node, (str, int, float, bool)):
            reject("Invalid JSON value.")


def parse_json(data, maximum=MAX_REQUEST_BYTES):
    if isinstance(data, str):
        try:
            data = data.encode("utf-8")
        except UnicodeError:
            reject("Invalid Unicode in JSON.")
    if not isinstance(data, bytes) or len(data) > maximum:
        reject("JSON payload exceeds the byte limit.")
    try:
        value = json.loads(data.decode("utf-8"), object_pairs_hook=_pairs, parse_constant=_constant)
    except (UnicodeError, ValueError, RecursionError):
        reject("Expected one complete JSON value without wrappers.")
    bounded_tree(value)
    return value


def image_dimensions(data, mime):
    """Read bounded file headers only; no codecs, decompression, or native libraries."""
    if mime == "image/png":
        if len(data) < 33 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[8:16] != b"\x00\x00\x00\rIHDR":
            reject("Invalid preprocessed PNG header.")
        return struct.unpack(">II", data[16:24])
    if mime == "image/jpeg":
        if not data.startswith(b"\xff\xd8"):
            reject("Invalid preprocessed JPEG header.")
        pos = 2
        # Scan at most 64 KiB: browser re-encoding puts dimensions near the front.
        while pos + 4 <= min(len(data), 65536):
            if data[pos] != 255:
                break
            while pos < len(data) and data[pos] == 255:
                pos += 1
            if pos >= len(data):
                break
            marker, pos = data[pos], pos + 1
            if marker in (0xD9, 0xDA):
                break
            if marker in (0x01, *range(0xD0, 0xD9)):
                continue
            if pos + 2 > len(data):
                break
            size = int.from_bytes(data[pos:pos + 2], "big")
            if size < 2 or pos + size > len(data):
                break
            if marker in (0xC0, 0xC1, 0xC2):
                if size < 8:
                    break
                height, width = struct.unpack(">HH", data[pos + 3:pos + 7])
                return width, height
            pos += size
        reject("JPEG dimensions must be present in a bounded preprocessed header.")
    if mime == "image/webp":
        if len(data) < 30 or data[:4] != b"RIFF" or data[8:12] != b"WEBP":
            reject("Invalid preprocessed WebP header.")
        kind = data[12:16]
        if kind == b"VP8X":
            if data[20] & 0x02:
                reject("Animated images are not accepted.")
            return 1 + int.from_bytes(data[24:27], "little"), 1 + int.from_bytes(data[27:30], "little")
        if kind == b"VP8 " and data[23:26] == b"\x9d\x01\x2a":
            width, height = struct.unpack("<HH", data[26:30])
            return width & 0x3FFF, height & 0x3FFF
        if kind == b"VP8L" and data[20] == 0x2F:
            bits = int.from_bytes(data[21:25], "little")
            return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
        reject("Unsupported preprocessed WebP header.")
    reject("Only preprocessed PNG, JPEG, and WebP images are accepted.")


def validate_request_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
        reject("Invalid request identifier.")
    return value


def validate_generate(value):
    required = {"request_id", "mode", "context", "instructions", "images", "schema"}
    if not isinstance(value, dict) or set(value) != required:
        reject("Generation requires request_id, mode, context, instructions, images, and schema only.")
    validate_request_id(value["request_id"])
    if value["mode"] not in ("furnish_room", "new_room", "site"):
        reject("Unsupported planning mode.")
    if not isinstance(value["instructions"], str) or len(value["instructions"]) > 12000:
        reject("Instructions exceed the text limit.")
    context = value["context"]
    context_fields = {"draft_version", "request_id", "mode", "floor_id", "room_id", "ceiling_height_m", "room", "walls", "openings", "existing_items", "measurements", "origin", "catalog"}
    if value["mode"] == "site":
        context_fields = {"draft_version", "request_id", "mode", "site", "site_notes", "floor_footprints"}
    if not isinstance(context, dict) or set(context) - context_fields or len(dumps(context)) > MAX_CONTEXT_BYTES:
        reject("Invalid or oversized sanitized planning context.")
    bounded_tree(context, forbid_private=True)
    if context.get("request_id", value["request_id"]) != value["request_id"] or context.get("mode", value["mode"]) != value["mode"]:
        reject("Request context does not match its envelope.")
    schema = value["schema"]
    if not isinstance(schema, dict) or schema.get("type") != "object" or len(dumps(schema)) > MAX_SCHEMA_BYTES:
        reject("Expected a bounded object JSON schema.")
    # Neither this server nor the provider should resolve external schema resources.
    pending = [schema]
    while pending:
        node = pending.pop()
        if isinstance(node, dict):
            if "$ref" in node and (not isinstance(node["$ref"], str) or not node["$ref"].startswith("#/")):
                reject("External schema references are not accepted.")
            pending.extend(node.values())
        elif isinstance(node, list):
            pending.extend(node)
    images = value["images"]
    if not isinstance(images, list) or len(images) > MAX_IMAGES:
        reject("At most six preprocessed images are accepted.")
    total = 0
    for item in images:
        if not isinstance(item, dict) or set(item) != {"mime_type", "data"} or not isinstance(item["data"], str):
            reject("Invalid preprocessed image envelope.")
        if len(item["data"]) > (MAX_IMAGE_BYTES + 2) // 3 * 4:
            reject("A preprocessed image exceeds 4 MiB.")
        try:
            decoded = base64.b64decode(item["data"], validate=True)
        except (ValueError, binascii.Error):
            reject("Invalid image base64.")
        total += len(decoded)
        if len(decoded) > MAX_IMAGE_BYTES or total > MAX_IMAGES_BYTES:
            reject("Preprocessed images exceed the 12 MiB total limit.")
        width, height = image_dimensions(decoded, item["mime_type"])
        if not (0 < width <= 4096 and 0 < height <= 4096 and width * height <= 16000000):
            reject("Preprocessed image dimensions exceed 4096 pixels or 16 megapixels.")
    return value
