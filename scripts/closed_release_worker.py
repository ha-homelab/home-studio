"""Finite v2 worker exchange; deliberately not wired to production build actions.

The caller supplies independently trusted execution/context/routing anchors and
an already encrypted candidate. Bootstrap signatures bind assertions, not proof
of OCI capacity or capability scope: the private coordinator must establish both.
The POSIX attempt journal requires an owner-private, trusted local directory.
Every existing journal rejects re-entry, including a crash before the first PUT.
There is no automatic retry, renewal, release, or recovery upload.
"""
from __future__ import annotations

from functools import wraps
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import time
import urllib.parse
import zlib

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import closed_build as transport
import closed_envelope as crypto
import closed_release_transport as release_transport
import closed_upload_control_v2 as control

ROLES = ("input", "intent", "permit", "candidate", "result", "acceptance")
CAPABILITIES = ("input_read", "output_read", "output_write", "acceptance_read")
SUFFIXES = dict(zip(ROLES, ("input", "upload-intent", "upload-permit", "candidate",
                            "upload-result", "acceptance")))
BOOTSTRAP_MAX = 32768
INPUT_CHUNK_BYTES = 65536
INPUT_TAR_MAX = transport.MAX_TOTAL + transport.MAX_FILES * 1024 + 10240


class WorkerError(ValueError):
    """Fixed, redacted failure. The durable attempt must not be repeated."""


def _boundary(function):
    @wraps(function)
    def call(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except Exception:
            # Do not retain private input or capability details in the outward exception.
            pass
        try:
            raise WorkerError("ClosedReleaseWorkerRejected") from None
        except WorkerError as error:
            error.__context__ = None
            raise
    return call


def _require(condition):
    if not condition:
        raise WorkerError("ClosedReleaseWorkerRejected")


def _fields(value, keys):
    _require(type(value) is dict and value.keys() == set(keys))


def _integer(value, low=1, high=2**63 - 1):
    _require(type(value) is int and low <= value <= high)


def _sha(value):
    _require(type(value) is str and re.fullmatch(r"[0-9a-f]{64}", value))


def _id(value):
    _require(type(value) is str and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", value))


def _digest(value):
    return crypto.digest(crypto.canonical(value))


def _freeze(value):
    nodes = 0

    def visit(item, depth):
        nonlocal nodes
        nodes += 1
        _require(nodes <= 8192 and depth <= 12)
        if type(item) is dict:
            _require(len(item) <= 2048)
            result = {}
            for key, child in item.items():
                _require(type(key) is str and len(key) <= 256)
                result[key] = visit(child, depth + 1)
            return result
        if type(item) is list:
            _require(len(item) <= 2048)
            return [visit(child, depth + 1) for child in item]
        if type(item) is str:
            _require(len(item) <= 8192)
        else:
            _require(item is None or type(item) in (int, bool))
            if type(item) is int:
                _require(abs(item) <= 2**63 - 1)
        return item

    result = visit(value, 0)
    _require(len(crypto.canonical(result)) <= 262144)
    return result


def _key(value):
    _require(type(value) is str and len(value) == 44)
    return crypto.unb64(value, 32)


def _checkpoint(value, ledger):
    _fields(value, ("schema", "kind", "ledger_id", "scope_fingerprint", "generation",
                    "state_sha256", "operation_id", "operation_receipt_sha256"))
    _require(type(value["schema"]) is int and value["schema"] == 1
             and value["kind"] == "committed-ledger-checkpoint"
             and value["ledger_id"] == ledger["ledger_id"]
             and value["scope_fingerprint"] == ledger["scope_fingerprint"])
    _integer(value["generation"], high=4096)
    _id(value["operation_id"])
    for key in ("state_sha256", "operation_receipt_sha256"):
        _sha(value[key])


def _prefix(value):
    _require(type(value) is str and 0 < len(value) <= 8192
             and all(33 <= ord(char) <= 126 for char in value))
    parsed = urllib.parse.urlsplit(value)
    _require(parsed.scheme == "https" and parsed.hostname and parsed.port in (None, 443)
             and not parsed.username and not parsed.password and not parsed.query
             and not parsed.fragment and parsed.path.endswith("/"))


def _target(base, suffix):
    _require(re.fullmatch(r"[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+", suffix)
             and len(base) + len(suffix) <= 8192)
    return crypto.digest((base + suffix).encode("ascii"))


@_boundary
def object_names(request_id, execution):
    """Return the six deterministic prefix-relative object names."""
    _id(request_id)
    for name in ("run_id", "run_attempt"):
        value = execution[name]
        _require(type(value) is str and re.fullmatch(r"[1-9][0-9]{0,19}", value)
                 and int(value) <= 2**63 - 1)
    prefix = request_id + "/" + execution["run_id"] + "-" + execution["run_attempt"]
    return {role: prefix + "." + SUFFIXES[role] + ".json" for role in ROLES}


def _clock():
    wall, tick = time.time(), time.monotonic()
    _require(type(wall) in (int, float) and math.isfinite(wall) and wall >= 1
             and type(tick) in (int, float) and math.isfinite(tick))
    return wall, tick


def _bootstrap(value, limits, expected, capabilities):
    value, limits, expected, capabilities = map(_freeze, (value, limits, expected, capabilities))
    _fields(expected, ("request_id", "execution", "public_context", "ledger",
                       "capability_sha256", "input_target_sha256", "worker"))
    _fields(value, ("schema", "kind", "request_id", "nonce", "execution", "public", "ledger",
                    "objects", "reservation_checkpoint", "control_checkpoints", "capability_sha256",
                    "routing", "limits_sha256", "created_at", "expires_at", "growth_horizon_seconds",
                    "growth_evidence_ref", "worker"))
    _require(len(crypto.canonical(value)) <= BOOTSTRAP_MAX)
    _require(type(value["schema"]) is int and value["schema"] == 2
             and value["kind"] == "closed-release-bootstrap-v2")
    _id(value["request_id"])
    _require(value["request_id"] == expected["request_id"]
             and value["execution"] == expected["execution"]
             and value["ledger"] == expected["ledger"] and value["worker"] == expected["worker"])
    _fields(value["worker"], ("image", "policy_sha256"))
    _require(type(value["worker"]["image"]) is str and transport.IMAGE.fullmatch(value["worker"]["image"]))
    _sha(value["worker"]["policy_sha256"])
    context = expected["public_context"]
    _require(type(context) is dict)
    for field in ("repository", "repository_id", "repository_owner_id", "source_sha", "run_id", "run_attempt"):
        _require(context[field] == value["execution"][field])
    _require(context["mode"] == "prospective" and context["workflow"] == transport.WORKFLOW)
    _require(value["public"] == {"channel": context["channel"], "plan_sha256": context["plan_sha256"],
                                 "context_sha256": _digest(context)})
    ledger = value["ledger"]
    _fields(ledger, ("ledger_id", "batch_id", "scope_fingerprint", "bucket_fingerprint"))
    for key in ("ledger_id", "batch_id"):
        _id(ledger[key])
    for key in ("scope_fingerprint", "bucket_fingerprint"):
        _sha(ledger[key])
    _fields(capabilities, CAPABILITIES)
    _fields(value["capability_sha256"], CAPABILITIES)
    _fields(expected["capability_sha256"], CAPABILITIES)
    for name in CAPABILITIES:
        _prefix(capabilities[name])
        _require(value["capability_sha256"][name] == expected["capability_sha256"][name]
                 == crypto.digest(capabilities[name].encode("ascii")))
    _fields(value["objects"], ROLES)
    execution = value["execution"]
    names = object_names(value["request_id"], execution)
    bounds = {"input": crypto.MAX_ENVELOPE, "intent": 8192, "permit": 8192,
              "candidate": limits["candidate_max_bytes"], "result": 8192, "acceptance": 8 * 1024**2}
    ids, attempts, objects = set(), set(), set()
    for role in ROLES:
        claim = value["objects"][role]
        _fields(claim, ("claim_id", "object", "attempt_id", "maximum_bytes", "request_target_sha256"))
        _id(claim["claim_id"])
        _id(claim["attempt_id"])
        _integer(claim["maximum_bytes"], high=bounds[role])
        _require(claim["object"] == names[role])
        base = capabilities[{"input": "input_read", "acceptance": "acceptance_read"}.get(role, "output_write")]
        _require(claim["request_target_sha256"] == _target(base, claim["object"]))
        ids.add(claim["claim_id"])
        attempts.add(claim["attempt_id"])
        objects.add(claim["object"])
    _require(len(ids) == len(attempts) == len(objects) == 6)
    _fields(value["routing"], ("kind", "input_suffix"))
    _require(value["routing"] == {"kind": "closed-prefix-routing-v2",
                                   "input_suffix": value["objects"]["input"]["object"]}
             and expected["input_target_sha256"] == value["objects"]["input"]["request_target_sha256"])
    _checkpoint(value["reservation_checkpoint"], ledger)
    _fields(value["control_checkpoints"], ("intent", "result"))
    generations = []
    operations = {value["reservation_checkpoint"]["operation_id"]}
    for checkpoint in value["control_checkpoints"].values():
        _checkpoint(checkpoint, ledger)
        _require(checkpoint["generation"] > value["reservation_checkpoint"]["generation"])
        generations.append(checkpoint["generation"])
        operations.add(checkpoint["operation_id"])
    _require(len(set(generations)) == 2 and len(operations) == 3)
    for field in ("created_at", "expires_at"):
        _integer(value[field])
    _integer(value["growth_horizon_seconds"], 900, 3600)
    _require(900 <= value["expires_at"] - value["created_at"] <= value["growth_horizon_seconds"])
    _sha(value["growth_evidence_ref"])
    _require(value["limits_sha256"] == _digest(limits))
    # Reuse the frozen v2 rules for all execution/channel/nonce/limit fields.
    control.validate_intent({"schema": 2, "kind": "closed-upload-intent-v2", "request_id": value["request_id"],
        "nonce": value["nonce"], "created_at": value["created_at"], "execution": execution,
        "public": value["public"], "input_sha256": "0" * 64, "candidate": {
            "object": value["objects"]["candidate"]["object"], "ciphertext_sha256": "0" * 64,
            "bytes": 1, "attempt_id": value["objects"]["candidate"]["attempt_id"],
            "output_capability_sha256": value["capability_sha256"]["output_write"],
            "request_target_sha256": value["objects"]["candidate"]["request_target_sha256"]}}, limits)
    return value


@_boundary
def validate_bootstrap_bindings(bootstrap, expected, capabilities, limits):
    """Timeless bindings only, for delayed proof reconciliation; never admission."""
    return _bootstrap(bootstrap, limits, expected, capabilities)


@_boundary
def validate_bootstrap(bootstrap, *, expected, capabilities, limits, now):
    """Validate detached signed assertions against independent caller anchors."""
    value = validate_bootstrap_bindings(bootstrap, expected, capabilities, limits)
    _require(type(now) in (int, float) and math.isfinite(now)
             and value["created_at"] <= now < value["expires_at"])
    return value


class _GzipInput:
    """Bound every decompressor output, including tar extensions and padding."""

    def __init__(self, wire):
        self.wire, self.offset, self.pending, self.total = wire, 0, b"", 0
        self.decoder = zlib.decompressobj(31)

    def read(self, size):
        _require(type(size) is int and 0 < size <= INPUT_CHUNK_BYTES)
        chunks, count = [], 0
        while count < size and not self.decoder.eof:
            if self.pending:
                chunk = self.pending
            else:
                chunk = self.wire[self.offset:self.offset + INPUT_CHUNK_BYTES]
                self.offset += len(chunk)
            _require(bool(chunk))
            limit = min(size - count, INPUT_TAR_MAX - self.total + 1)
            _require(limit > 0)
            output = self.decoder.decompress(chunk, limit)
            self.pending = self.decoder.unconsumed_tail
            self.total += len(output)
            _require(self.total <= INPUT_TAR_MAX)
            _require(output or len(self.pending) < len(chunk) or self.decoder.eof)
            chunks.append(output)
            count += len(output)
        if self.decoder.eof:
            # One gzip member only; no hidden second archive or trailing bytes.
            _require(not self.decoder.unused_data and self.offset == len(self.wire))
        return b"".join(chunks)


def _exact(stream, size):
    data = stream.read(size)
    _require(len(data) == size)
    return data


def _octal(field):
    value = field.strip(b" \0")
    _require(not value or re.fullmatch(rb"[0-7]+", value))
    return int(value, 8) if value else 0


def _tar_text(field):
    value, separator, padding = field.partition(b"\0")
    _require(not separator or not padding.strip(b"\0"))
    text = value.decode("utf-8")
    _require(all(ord(char) >= 32 and ord(char) != 127 for char in text))
    return text


def _input_manifest(wire):
    """Read only regular USTAR members, rejecting extension headers up front."""
    stream = _GzipInput(wire)
    manifest, total, names = None, 0, set()
    while True:
        header = _exact(stream, 512)
        if header == bytes(512):
            _require(_exact(stream, 512) == bytes(512))
            while True:
                padding = stream.read(INPUT_CHUNK_BYTES)
                _require(not padding.strip(b"\0"))
                if not padding:
                    break
            _require(stream.total % 512 == 0)
            break
        # No tarfile parser is invoked: PAX/GNU payload lengths cannot trigger
        # a read/allocation before this fixed-header type check.
        _require(header[156:157] in (b"0", b"\0")
                 and header[257:265] == b"ustar\x0000"
                 and not header[157:257].strip(b"\0")
                 and not header[500:512].strip(b"\0"))
        _require(_octal(header[148:156]) == sum(header[:148]) + 8 * 32 + sum(header[156:]))
        for start, end in ((100, 108), (108, 116), (116, 124), (136, 148), (329, 337), (337, 345)):
            _octal(header[start:end])
        size = _octal(header[124:136])
        name, prefix = _tar_text(header[:100]), _tar_text(header[345:500])
        name = prefix + "/" + name if prefix else name
        transport.safe_name(name)
        _require(str(PurePosixPath(name)) == name and name.casefold() not in names
                 and len(names) < transport.MAX_FILES and size <= transport.MAX_FILE)
        names.add(name.casefold())
        total += size
        _require(total <= transport.MAX_TOTAL)
        retain = name == "closed-build.json"
        _require(not retain or size <= 2_000_000)
        parts, remaining = [], size
        while remaining:
            count = min(INPUT_CHUNK_BYTES, remaining)
            part = _exact(stream, count)
            if retain:
                parts.append(part)
            remaining -= count
        padding_size = (-size) % 512
        if padding_size:
            _require(not _exact(stream, padding_size).strip(b"\0"))
        if retain:
            manifest = crypto.decode_json(b"".join(parts))
    _require(type(manifest) is dict)
    return manifest


@_boundary
def authenticate_input(input_wire, *, input_keys, limits, expected, capabilities):
    """Authenticate the real input tar and return its detached, bound bootstrap.

    This has no filesystem or network I/O. It validates bootstrap authorization,
    not the full build source manifest (the existing builder still must do so).
    """
    _require(type(input_wire) is bytes and 0 < len(input_wire) <= crypto.MAX_ENVELOPE)
    input_keys = _freeze(input_keys)
    _fields(input_keys, ("recipient_key", "verify_key"))
    for value in input_keys.values():
        _key(value)
    plain = crypto.open_envelope(input_wire, input_keys["recipient_key"], input_keys["verify_key"], purpose="input")
    _require(type(plain) is bytes and len(plain) <= crypto.MAX_ENVELOPE)
    manifest = _input_manifest(plain)
    value = _bootstrap(manifest["upload_bootstrap"], limits, expected, capabilities)
    _require(manifest["request_id"] == value["request_id"]
             and len(input_wire) <= value["objects"]["input"]["maximum_bytes"])
    return value


def _journal(path):
    path = Path(path).absolute()
    parent = path.parent.lstat()
    _require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == os.getuid()
             and stat.S_IMODE(parent.st_mode) == 0o700 and path.name not in ("", ".", ".."))
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        _require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid()
                 and stat.S_IMODE(info.st_mode) == 0o600)
        return descriptor, path
    except BaseException:
        os.close(descriptor)
        raise


def _append(descriptor, path, value):
    data = crypto.canonical(value) + b"\n"
    _require(len(data) <= 65536)
    offset = 0
    while offset < len(data):
        written = os.write(descriptor, data[offset:])
        _require(written > 0)
        offset += written
    os.fsync(descriptor)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def _elapsed_clock():
    """One wall/monotonic baseline shared across build and every transport step."""
    wall, tick = _clock()
    last = [wall, tick]

    def now():
        observed, current = _clock()
        _require(observed >= last[0] and current >= last[1])
        last[:] = [observed, current]
        return max(observed, wall + current - tick)
    return now


@_boundary
def upload_release(input_wire, candidate, *, input_keys, output_keys, limits, expected,
                   capabilities, journal_path, timeout=60):
    """Internal transfer phase; caller must establish the candidate's provenance.

    Existing journals always reject. The injected candidate must be an immutable
    signed candidate envelope. Production callers still must build and validate
    its content with the existing contained builder before entering this path.
    """
    return _upload_release(input_wire, candidate, input_keys=input_keys, output_keys=output_keys,
        limits=limits, expected=expected, capabilities=capabilities, journal_path=journal_path,
        timeout=timeout, now=_elapsed_clock())


def _upload_release(input_wire, candidate, *, input_keys, output_keys, limits, expected,
                    capabilities, journal_path, timeout, now):

    _require(type(timeout) in (int, float) and math.isfinite(timeout) and 0 < timeout <= 60)
    limits, expected, capabilities, input_keys, output_keys = map(
        _freeze, (limits, expected, capabilities, input_keys, output_keys))
    value = authenticate_input(input_wire, input_keys=input_keys, limits=limits,
                               expected=expected, capabilities=capabilities)
    _fields(output_keys, ("recipient_key", "signing_key"))
    _key(output_keys["recipient_key"])
    signing = Ed25519PrivateKey.from_private_bytes(_key(output_keys["signing_key"]))
    _require(type(candidate) is bytes and 0 < len(candidate) <= value["objects"]["candidate"]["maximum_bytes"])
    crypto.verify_envelope(candidate, crypto.b64(signing.public_key().public_bytes_raw()), purpose="candidate")

    def fresh(deadline=None):
        observed = now()
        _require(value["created_at"] <= observed < value["expires_at"])
        if deadline is not None:
            _require(observed < deadline)
        return observed

    created = int(fresh())
    claim = value["objects"]["candidate"]
    intent = control.validate_intent({"schema": 2, "kind": "closed-upload-intent-v2",
        "request_id": value["request_id"], "nonce": value["nonce"], "created_at": created,
        "execution": value["execution"], "public": value["public"], "input_sha256": crypto.digest(input_wire),
        "candidate": {"object": claim["object"], "ciphertext_sha256": crypto.digest(candidate),
            "bytes": len(candidate), "attempt_id": claim["attempt_id"],
            "output_capability_sha256": value["capability_sha256"]["output_write"],
            "request_target_sha256": claim["request_target_sha256"]}}, limits)
    intent_wire = control.seal_control(intent, output_keys["recipient_key"], output_keys["signing_key"],
                                       purpose="upload-intent-v2")
    _require(len(intent_wire) <= value["objects"]["intent"]["maximum_bytes"])
    descriptor, path = _journal(journal_path)
    try:
        _append(descriptor, path, {"schema": 1, "kind": "closed-release-worker-attempt", "stage": "prepared",
            "bootstrap_sha256": _digest(value), "input_sha256": crypto.digest(input_wire),
            "candidate_sha256": crypto.digest(candidate), "intent_wire": crypto.b64(intent_wire)})

        def put(role, wire, deadline):
            entry = value["objects"][role]
            _require(type(wire) is bytes and 0 < len(wire) <= entry["maximum_bytes"])
            _append(descriptor, path, {"stage": role + "-attempted", "attempt_id": entry["attempt_id"],
                "ciphertext_sha256": crypto.digest(wire), "bytes": len(wire)})
            result = release_transport.put(capabilities["output_write"], data=wire,
                attempt_id=entry["attempt_id"], expected_sha256=crypto.digest(wire), expected_bytes=len(wire),
                suffix=entry["object"], maximum=8192,
                timeout=min(timeout, deadline - fresh(deadline)), not_after=deadline)
            fresh(deadline)
            _append(descriptor, path, {"stage": role + "-returned", "transport": result})
            return result

        put("intent", intent_wire, value["expires_at"])
        wait_until = min(value["expires_at"], now() + limits["wait_seconds"])
        permit_wire = None
        for _ in range(limits["wait_seconds"] + 1):
            remaining = wait_until - fresh(wait_until)
            try:
                permit_wire = release_transport.get(capabilities["output_read"],
                    suffix=value["objects"]["permit"]["object"], maximum=8192,
                    timeout=min(timeout, 5, remaining), not_after=math.ceil(wait_until))
                break
            except release_transport.ReleaseTransportNotFound:
                # A missing fixed permit is the only outcome allowed to poll again.
                pass
            time.sleep(min(1, wait_until - fresh(wait_until)))
        _require(permit_wire is not None)
        permit = control.open_control(permit_wire, input_keys["recipient_key"], input_keys["verify_key"],
                                      purpose="upload-permit-v2")
        control.validate_permit(permit, intent, intent_wire, limits, now=int(fresh(wait_until)))
        authority = value["ledger"]
        _require(permit["destination"]["scope_fingerprint"] == authority["scope_fingerprint"]
                 and permit["destination"]["bucket_fingerprint"] == authority["bucket_fingerprint"]
                 and permit["ledger"]["batch_id"] == authority["batch_id"]
                 and permit["ledger"]["candidate_claim_id"] == claim["claim_id"]
                 and permit["ledger"]["checkpoint"]["ledger_id"] == authority["ledger_id"]
                 and permit["ledger"]["checkpoint"]["generation"] > max(
                     point["generation"] for point in value["control_checkpoints"].values()))
        _append(descriptor, path, {"stage": "permit-validated", "permit_wire": crypto.b64(permit_wire)})
        deadline = min(value["expires_at"], permit["expires_at"])
        receipt = put("candidate", candidate, deadline)
        result = control.validate_result({"schema": 2, "kind": "closed-upload-result-v2",
            "intent_envelope_sha256": crypto.digest(intent_wire), "permit_envelope_sha256": crypto.digest(permit_wire),
            "permit_record_sha256": _digest(permit), "transport": receipt},
            intent, intent_wire, permit, permit_wire, limits)
        result_wire = control.seal_control(result, output_keys["recipient_key"], output_keys["signing_key"],
                                         purpose="upload-result-v2")
        _require(len(result_wire) <= value["objects"]["result"]["maximum_bytes"])
        _append(descriptor, path, {"stage": "result-prepared", "result_wire": crypto.b64(result_wire)})
        put("result", result_wire, deadline)
        _append(descriptor, path, {"stage": "complete", "authorizes_upload": False})
        return {"state": "result-stored", "intent_wire": intent_wire, "permit_wire": permit_wire,
                "result_wire": result_wire, "journal_path": str(path), "authorizes_upload": False}
    finally:
        os.close(descriptor)


@_boundary
def build_and_run_release(args, temporary, *, input_wire, input_keys, output_keys,
                          limits, expected, capabilities, journal_path, timeout=60):
    """Authenticate, build with the existing contained builder, then exchange.

    This explicit callable remains disconnected from production execute(). The
    real public artifact checks and contained builder are reused, with explicit
    keys for this exact input/output pair. No caller-supplied candidate enters.
    """
    now = _elapsed_clock()
    input_keys, output_keys, limits, expected, capabilities = map(
        _freeze, (input_keys, output_keys, limits, expected, capabilities))
    bootstrap = authenticate_input(input_wire, input_keys=input_keys, limits=limits,
                                    expected=expected, capabilities=capabilities)
    validate_bootstrap(bootstrap, expected=expected, capabilities=capabilities,
                       limits=limits, now=now())
    _require(args.action == "build" and args.closed_request in ("", bootstrap["request_id"]))
    transport.gate_environment(os.environ)
    execution = expected["execution"]
    for field, name in (("repository", "GITHUB_REPOSITORY"), ("repository_id", "GITHUB_REPOSITORY_ID"),
                        ("repository_owner_id", "GITHUB_REPOSITORY_OWNER_ID"), ("workflow_ref", "GITHUB_WORKFLOW_REF"),
                        ("run_id", "GITHUB_RUN_ID"), ("run_attempt", "GITHUB_RUN_ATTEMPT"),
                        ("source_sha", "GITHUB_SHA"), ("event", "GITHUB_EVENT_NAME")):
        _require(execution[field] == os.environ.get(name))
    configured = transport.policy()
    _require(bootstrap["worker"] == {"image": configured["worker_image"], "policy_sha256": _digest(configured)}
             and {name: configured["upload_admission"][name] for name in control.MAX_LIMITS} == limits
             and crypto.decode_json(transport.regular(args.prepared_root / "prepared.json")) == configured)
    context, public = transport.public_inputs(args, temporary)
    _require(context == expected["public_context"])
    args.closed_request = bootstrap["request_id"]
    candidate = transport.build_release_candidate(args, temporary, configured=configured, context=context,
        public=public, input_wire=input_wire, input_keys=input_keys, output_keys=output_keys)
    return _upload_release(input_wire, candidate, input_keys=input_keys, output_keys=output_keys,
        limits=limits, expected=expected, capabilities=capabilities, journal_path=journal_path,
        timeout=timeout, now=now)
