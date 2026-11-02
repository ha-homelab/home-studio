"""One supervised request for the explicit closed-release path.

The parent deadline includes validation, hashing, local preparation and child
startup. A killed child cannot guarantee remote cancellation: every failed PUT
remains ambiguous and must never be retried automatically. Process creation and
local OS/filesystem calls cannot be preempted here; deadline checkpoints reject
late results, with a separate bounded kill/reap grace. No production activation.

Capabilities cross bounded stdin, encrypted payloads cross an anonymous private
FD, and only a bounded result is read after child exit and response close. The
child reuses the existing request engine, with no proxy, redirect or retry.
Trusted child/helper code does not spawn subprocesses. Failure terminates its
owned process group, including any descendants that retained that group; this
is not a sandbox for malicious code that deliberately escapes its session.
"""
from __future__ import annotations

import base64
from functools import wraps
import hashlib
import json
import math
import os
from pathlib import Path
import re
import resource
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse

MAX_DATA_BYTES = 256 * 1024**2
MAX_CONTROL_BYTES = 8192
MAX_INPUT_BYTES = 16384
MAX_RESULT_BYTES = 16384
CHUNK_BYTES = 65536
REAP_SECONDS = 2
_META_FIELDS = {"method", "url", "suffix", "maximum", "timeout", "not_after",
                "attempt_id", "expected_sha256", "expected_bytes"}
_PUT_FIELDS = {"schema", "kind", "attempt_id", "request_target_sha256", "status", "bytes",
               "ciphertext_sha256", "version_id", "etag", "md5", "authorizes_upload"}
_NOT_FOUND = object()


class ReleaseTransportError(ValueError):
    def __init__(self):
        super().__init__("ClosedReleaseTransportRejected")


class ReleaseTransportNotFound(ReleaseTransportError):
    def __init__(self):
        ValueError.__init__(self, "ClosedReleaseTransportNotFound")


def _require(condition):
    if not condition:
        raise ReleaseTransportError()


def _boundary(function):
    @wraps(function)
    def call(*args, **kwargs):
        missing = False
        try:
            return function(*args, **kwargs)
        except ReleaseTransportNotFound:
            missing = True
        except Exception:
            # Discard transport details before raising the fixed error outside this handler.
            pass
        try:
            raise (ReleaseTransportNotFound() if missing else ReleaseTransportError()) from None
        except ReleaseTransportError as error:
            error.__context__ = None
            raise
    return call


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("ascii")


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _decode(wire):
    def pairs(items):
        result = {}
        for key, value in items:
            _require(key not in result)
            result[key] = value
        return result

    def invalid(_):
        raise ReleaseTransportError()

    return json.loads(wire, object_pairs_hook=pairs, parse_constant=invalid)


def _integer(value, minimum, maximum):
    _require(type(value) is int and minimum <= value <= maximum)


def _metadata(value):
    _require(type(value) is dict and value.keys() == _META_FIELDS)
    _require(value["method"] in ("GET", "PUT"))
    url, suffix = value["url"], value["suffix"]
    _require(type(url) is str and 0 < len(url) <= 8192
             and all(33 <= ord(char) <= 126 for char in url))
    _require(type(suffix) is str and re.fullmatch(r"[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+", suffix)
             and suffix.split("/")[1] not in {".", ".."} and len(url) + len(suffix) <= 8192)
    parsed = urllib.parse.urlsplit(url)
    _require(parsed.scheme == "https" and parsed.hostname and not parsed.username
             and not parsed.password and not parsed.fragment and not parsed.query
             and parsed.port in (None, 443) and parsed.path.endswith("/"))
    _integer(value["maximum"], 1, MAX_CONTROL_BYTES)
    _require(type(value["timeout"]) in (int, float) and math.isfinite(value["timeout"])
             and 0 < value["timeout"] <= 60)
    _integer(value["not_after"], 1, 10**12)
    if value["method"] == "PUT":
        _require(type(value["attempt_id"]) is str
                 and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}", value["attempt_id"]))
        _require(type(value["expected_sha256"]) is str
                 and re.fullmatch(r"[0-9a-f]{64}", value["expected_sha256"]))
        _integer(value["expected_bytes"], 1, MAX_DATA_BYTES)
    else:
        _require(all(value[key] is None for key in ("attempt_id", "expected_sha256", "expected_bytes")))
    return value


def _remaining(timeout, not_after):
    # Capture before validating or hashing caller inputs; wall rollback must not
    # extend the initial monotonic budget.
    started, wall = time.monotonic(), time.time()
    _require(type(timeout) in (int, float) and math.isfinite(timeout) and 0 < timeout <= 60)
    _integer(not_after, 1, 10**12)
    _require(math.isfinite(started) and math.isfinite(wall) and wall < not_after)
    deadline, last = started + min(timeout, not_after - wall), started

    def remaining():
        nonlocal last
        tick, wall_now = time.monotonic(), time.time()
        _require(math.isfinite(tick) and tick >= last and math.isfinite(wall_now))
        last = tick
        value = min(deadline - tick, not_after - wall_now)
        _require(value > 0)
        return value
    return remaining


def _file(fd):
    info = os.fstat(fd)
    _require(stat.S_ISREG(info.st_mode) and info.st_nlink == 0 and info.st_uid == os.getuid()
             and stat.S_IMODE(info.st_mode) == 0o600)
    return info


def _write(fd, data):
    view = memoryview(data)
    while view:
        size = os.write(fd, view[:CHUNK_BYTES])
        _require(size > 0)
        view = view[size:]


def _child_command(data_fd, result_fd):
    return [sys.executable, "-I", str(Path(__file__).resolve()), "--child", str(data_fd), str(result_fd)]


def _run_child(payload, data_fd, result_fd, remaining):
    remaining()
    process = subprocess.Popen(_child_command(data_fd, result_fd), stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True,
        pass_fds=(data_fd, result_fd), start_new_session=True, env={"LANG": "C", "LC_ALL": "C"})
    try:
        process.communicate(input=payload, timeout=remaining())
        _require(process.returncode == 0)
        remaining()
    except BaseException:
        try:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                # The owned group may have exited between the failed wait and kill.
                pass
        finally:
            try:
                process.communicate(timeout=REAP_SECONDS)
            except subprocess.TimeoutExpired:
                pass  # A wedged OS must not cause an unbounded cleanup wait.
        raise


def _opaque(value):
    _require(value is None or (type(value) is str and 0 < len(value) <= 1024
             and value == value.strip() and all(32 <= ord(char) <= 126 for char in value)))


def _result(wire, metadata, data):
    result = _decode(wire)
    _require(type(result) is dict and result.keys() == {"schema", "kind", "request_sha256", "outcome", "value"}
             and type(result["schema"]) is int and result["schema"] == 1
             and result["kind"] == "closed-release-transport-result"
             and result["request_sha256"] == _sha(_canonical(metadata)))
    value = result["value"]
    if metadata["method"] == "GET":
        if result["outcome"] == "not-found":
            _require(value is None)
            return _NOT_FOUND
        _require(result["outcome"] == "get" and type(value) is str
                 and len(value) <= 4 * ((metadata["maximum"] + 2) // 3))
        decoded = base64.b64decode(value, validate=True)
        _require(len(decoded) <= metadata["maximum"] and base64.b64encode(decoded).decode("ascii") == value)
        return decoded
    _require(result["outcome"] == "put" and type(value) is dict and value.keys() == _PUT_FIELDS)
    _require(type(value["schema"]) is int and value["schema"] == 1 and value["kind"] == "closed-put-result"
             and value["attempt_id"] == metadata["attempt_id"]
             and value["request_target_sha256"] == _sha((metadata["url"] + metadata["suffix"]).encode("ascii"))
             and type(value["status"]) is int and value["status"] in (200, 201, 204)
             and type(value["bytes"]) is int and value["bytes"] == metadata["expected_bytes"]
             and value["ciphertext_sha256"] == metadata["expected_sha256"]
             and value["authorizes_upload"] is False)
    for name in ("version_id", "etag"):
        _opaque(value[name])
    _require(value["md5"] is None or value["md5"] == base64.b64encode(
        hashlib.md5(data, usedforsecurity=False).digest()).decode("ascii"))
    _require(len(_canonical(value)) <= MAX_CONTROL_BYTES)
    return value


def _exchange(metadata, data, remaining):
    _metadata(metadata)
    if metadata["method"] == "PUT":
        _require(type(data) is bytes and len(data) == metadata["expected_bytes"]
                 and _sha(data) == metadata["expected_sha256"])
    remaining()
    with tempfile.TemporaryFile() as payload_file, tempfile.TemporaryFile() as result_file:
        data_fd, result_fd = payload_file.fileno(), result_file.fileno()
        _file(data_fd)
        _file(result_fd)
        if data is not None:
            for offset in range(0, len(data), CHUNK_BYTES):
                remaining()
                _write(data_fd, data[offset:offset + CHUNK_BYTES])
        os.lseek(data_fd, 0, os.SEEK_SET)
        metadata = {**metadata, "timeout": min(metadata["timeout"], remaining())}
        payload = _canonical(metadata)
        _require(len(payload) <= MAX_INPUT_BYTES)
        _run_child(payload, data_fd, result_fd, remaining)
        remaining()
        _require(_file(data_fd).st_size == (0 if data is None else len(data)))
        size = _file(result_fd).st_size
        _require(0 < size <= MAX_RESULT_BYTES)
        os.lseek(result_fd, 0, os.SEEK_SET)
        result = _result(os.read(result_fd, MAX_RESULT_BYTES + 1), metadata, data)
        remaining()
    remaining()
    if result is _NOT_FOUND:
        raise ReleaseTransportNotFound()
    return result


@_boundary
def put(url, *, data, attempt_id, expected_sha256, expected_bytes, suffix,
        maximum=8192, timeout, not_after):
    """Observe one already-authorized, durably marked PUT; no retries or permit."""
    remaining = _remaining(timeout, not_after)
    return _exchange({"method": "PUT", "url": url, "suffix": suffix, "maximum": maximum,
        "timeout": timeout, "not_after": not_after, "attempt_id": attempt_id,
        "expected_sha256": expected_sha256, "expected_bytes": expected_bytes}, data, remaining)


@_boundary
def get(url, *, suffix, maximum=8192, timeout, not_after):
    """Read one bounded control; only a body-free 404 is separately identified."""
    remaining = _remaining(timeout, not_after)
    return _exchange({"method": "GET", "url": url, "suffix": suffix, "maximum": maximum,
        "timeout": timeout, "not_after": not_after, "attempt_id": None,
        "expected_sha256": None, "expected_bytes": None}, None, remaining)


def _child_main(data_fd, result_fd):
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_RESULT_BYTES, MAX_RESULT_BYTES))
    first, second = _file(data_fd), _file(result_fd)
    _require((first.st_dev, first.st_ino) != (second.st_dev, second.st_ino) and second.st_size == 0)
    wire = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    _require(0 < len(wire) <= MAX_INPUT_BYTES)
    metadata = _metadata(_decode(wire))
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import closed_build as build

    arguments = {key: metadata[key] for key in ("suffix", "maximum", "timeout", "not_after")}
    if metadata["method"] == "PUT":
        _require(first.st_size == metadata["expected_bytes"])
        with os.fdopen(os.dup(data_fd), "rb") as stream:
            data = stream.read(metadata["expected_bytes"] + 1)
        value = build.transport_put_result(metadata["url"], data=data,
            **{key: metadata[key] for key in ("attempt_id", "expected_sha256", "expected_bytes")}, **arguments)
        outcome = "put"
    else:
        _require(first.st_size == 0)
        try:
            value = base64.b64encode(build._transport_exchange(metadata["url"], **arguments)).decode("ascii")
            outcome = "get"
        except urllib.error.HTTPError as error:
            missing = error.code == 404
            error.close()
            _require(missing)
            outcome, value = "not-found", None
    os.close(data_fd)
    result = _canonical({"schema": 1, "kind": "closed-release-transport-result",
        "request_sha256": _sha(wire), "outcome": outcome, "value": value})
    _require(len(result) <= MAX_RESULT_BYTES)
    _write(result_fd, result)
    os.close(result_fd)


if __name__ == "__main__":
    try:
        _require(len(sys.argv) == 4 and sys.argv[1] == "--child")
        _child_main(int(sys.argv[2]), int(sys.argv[3]))
    except BaseException:
        # This child-only boundary must turn every exceptional exit, including
        # SystemExit(0), into failure. Parent cancellation is re-raised after
        # owned-process cleanup; this child never resumes or retries a request.
        sys.exit(1)
