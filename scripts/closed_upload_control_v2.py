"""Bounded, inactive v2 release-upload records and envelope wrappers.

No transport, clock reads, permit issuance, retries or admission decisions occur
here. Record validation does not authenticate callers, establish capacity or
prove a durable ledger claim. Callers must authenticate envelopes separately and
validate their execution, policy, evidence and checkpoint anchors independently.
The envelope wrappers validate record structure only, using protocol maxima.

Permit validation takes an explicit current time. Result validation instead
checks timeless intent/permit bindings so delayed reconciliation remains valid;
a result with no version ID remains unresolved. Neither path grants permission.
"""
from __future__ import annotations

import base64
from functools import wraps
import re

import closed_envelope as envelope

PLAINTEXT_MAX = 5600
CONTROL_MAX = 8192
MAX_DEPTH = 8
MAX_NODES = 256
MAX_INTEGER = 2**63 - 1
MAX_LEDGER_GENERATION = 4096
CANDIDATE_MAX = 178_957_417
MAX_LIMITS = {"candidate_max_bytes": CANDIDATE_MAX, "permit_ttl_seconds": 30,
              "capacity_max_age_seconds": 30, "wait_seconds": 120}
_LIMIT_MAXIMA = tuple(MAX_LIMITS.items())
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}\Z")
_DECIMAL = re.compile(r"[1-9][0-9]{0,19}\Z")
_PURPOSES = {"upload-intent-v2", "upload-permit-v2", "upload-result-v2"}
_REPOSITORY = "ha-homelab/home-studio"
_WORKFLOW = _REPOSITORY + "/.github/workflows/release-pipeline.yml@refs/heads/main"
_CHANNELS = {"push": {"beta"}, "schedule": {"nightly"},
             "workflow_dispatch": {"beta", "rc", "nightly"}}


class ControlError(ValueError):
    """A fixed rejection with no caller or cryptographic error details."""


def _boundary(function):
    @wraps(function)
    def call(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except Exception:
            pass
        # Also remove an exception active in the caller's own except block.
        try:
            raise ControlError("Closed upload control rejected") from None
        except ControlError as error:
            error.__context__ = None
            raise
    return call


def _require(condition):
    if not condition:
        raise ControlError("Closed upload control rejected")


def _fields(value, names):
    _require(type(value) is dict and value.keys() == set(names))


def _integer(value, maximum=MAX_INTEGER):
    _require(type(value) is int and 1 <= value <= maximum)
    return value


def _identifier(value):
    _require(type(value) is str and _ID.fullmatch(value))


def _hex(value, length=64):
    _require(type(value) is str and re.fullmatch(r"[0-9a-f]{" + str(length) + r"}", value))


def _decimal(value):
    _require(type(value) is str and _DECIMAL.fullmatch(value) and int(value) <= MAX_INTEGER)


def _record(value):
    """Bound exact JSON types and detach containers without serializing them."""
    nodes, text_size = 0, 0

    def visit(item, depth):
        nonlocal nodes, text_size
        nodes += 1
        _require(nodes <= MAX_NODES and depth <= MAX_DEPTH)
        if type(item) is dict:
            _require(len(item) <= 32)
            result = {}
            for key, child in item.items():
                _require(type(key) is str and len(key) <= 128)
                text_size += len(key)
                result[key] = visit(child, depth + 1)
        elif type(item) is list:
            _require(len(item) <= MAX_NODES)
            result = [visit(child, depth + 1) for child in item]
        elif type(item) is str:
            _require(len(item) <= 1024)
            text_size += len(item)
            result = item
        elif type(item) is int:
            _require(abs(item) <= MAX_INTEGER)
            result = item
        else:
            _require(item is None or type(item) is bool)
            result = item
        _require(text_size <= PLAINTEXT_MAX)
        return result

    return visit(value, 0)


def _sized(value):
    # Field/type validation precedes this first serialization of the record.
    _require(len(envelope.canonical(value)) <= PLAINTEXT_MAX)
    return value


def _wire(value):
    _require(type(value) is bytes and 0 < len(value) <= CONTROL_MAX)
    return value


def _key(value):
    _require(type(value) is str and len(value) == 44)
    envelope.unb64(value, 32)
    return value


def _limits(value):
    value = _record(value)
    _fields(value, MAX_LIMITS)
    for field, maximum in _LIMIT_MAXIMA:
        _integer(value[field], maximum)
    return _sized(value)


def _kind(value, schema, kind):
    _require(type(value["schema"]) is int and value["schema"] == schema and value["kind"] == kind)


def _intent(value, limits):
    value = _record(value)
    _fields(value, {"schema", "kind", "request_id", "nonce", "created_at", "execution", "public",
                    "input_sha256", "candidate"})
    _kind(value, 2, "closed-upload-intent-v2")
    _identifier(value["request_id"])
    _hex(value["nonce"], 32)
    _integer(value["created_at"])
    _hex(value["input_sha256"])
    execution = value["execution"]
    _fields(execution, {"repository", "repository_id", "repository_owner_id", "workflow_ref", "run_id",
                        "run_attempt", "source_sha", "event", "operation", "worker_job"})
    _require(execution["repository"] == _REPOSITORY and execution["repository_id"] == "1414876449"
             and execution["repository_owner_id"] == "307715255" and execution["workflow_ref"] == _WORKFLOW
             and execution["operation"] == "release" and execution["worker_job"] == "closed_build / package")
    _decimal(execution["run_id"])
    _decimal(execution["run_attempt"])
    _hex(execution["source_sha"], 40)
    public = value["public"]
    _fields(public, {"channel", "plan_sha256", "context_sha256"})
    _require(type(execution["event"]) is str and execution["event"] in _CHANNELS
             and type(public["channel"]) is str and public["channel"] in _CHANNELS[execution["event"]])
    _hex(public["plan_sha256"])
    _hex(public["context_sha256"])
    candidate = value["candidate"]
    _fields(candidate, {"object", "ciphertext_sha256", "bytes", "attempt_id",
                        "output_capability_sha256", "request_target_sha256"})
    _require(candidate["object"] == value["request_id"] + "/" + execution["run_id"] + "-"
             + execution["run_attempt"] + ".candidate.json")
    for field in ("ciphertext_sha256", "output_capability_sha256", "request_target_sha256"):
        _hex(candidate[field])
    _identifier(candidate["attempt_id"])
    _integer(candidate["bytes"], limits["candidate_max_bytes"])
    return _sized(value)


def _permit(value, limits):
    value = _record(value)
    _fields(value, {"schema", "kind", "intent_envelope_sha256", "intent_record_sha256", "destination",
                    "ledger", "capacity", "issued_at", "expires_at"})
    _kind(value, 2, "closed-upload-permit-v2")
    _hex(value["intent_envelope_sha256"])
    _hex(value["intent_record_sha256"])
    _fields(value["destination"], {"scope_fingerprint", "bucket_fingerprint", "object_fingerprint"})
    for fingerprint in value["destination"].values():
        _hex(fingerprint)
    ledger = value["ledger"]
    _fields(ledger, {"batch_id", "candidate_claim_id", "candidate_attempt_id", "checkpoint"})
    for field in ("batch_id", "candidate_claim_id", "candidate_attempt_id"):
        _identifier(ledger[field])
    checkpoint = ledger["checkpoint"]
    _fields(checkpoint, {"schema", "kind", "ledger_id", "scope_fingerprint", "generation", "state_sha256",
                        "operation_id", "operation_receipt_sha256"})
    _kind(checkpoint, 1, "committed-ledger-checkpoint")
    _identifier(checkpoint["ledger_id"])
    _identifier(checkpoint["operation_id"])
    _integer(checkpoint["generation"], MAX_LEDGER_GENERATION)
    for field in ("scope_fingerprint", "state_sha256", "operation_receipt_sha256"):
        _hex(checkpoint[field])
    capacity = value["capacity"]
    _fields(capacity, {"policy_sha256", "evidence_sha256", "snapshot_sha256", "assessment_sha256", "observed_at"})
    for field in ("policy_sha256", "evidence_sha256", "snapshot_sha256", "assessment_sha256"):
        _hex(capacity[field])
    observed, issued, expires = (_integer(item) for item in
                                (capacity["observed_at"], value["issued_at"], value["expires_at"]))
    _require(observed <= issued < expires and expires - issued <= limits["permit_ttl_seconds"]
             and expires <= observed + limits["capacity_max_age_seconds"])
    return _sized(value)


def _bound_permit(value, intent, intent_wire, limits):
    intent, value = _intent(intent, limits), _permit(value, limits)
    _require(value["intent_envelope_sha256"] == envelope.digest(_wire(intent_wire))
             and value["intent_record_sha256"] == envelope.digest(envelope.canonical(intent))
             and value["capacity"]["policy_sha256"] == envelope.digest(envelope.canonical(limits)))
    destination, ledger = value["destination"], value["ledger"]
    _require(ledger["candidate_attempt_id"] == intent["candidate"]["attempt_id"]
             and ledger["checkpoint"]["scope_fingerprint"] == destination["scope_fingerprint"])
    object_id = envelope.digest(envelope.canonical(["closed-object-v1", destination["scope_fingerprint"],
                                destination["bucket_fingerprint"], intent["candidate"]["object"]]))
    _require(destination["object_fingerprint"] == object_id
             and 0 <= value["issued_at"] - intent["created_at"] <= limits["wait_seconds"])
    return value, intent


def _opaque(value):
    if value is not None:
        _require(type(value) is str and 1 <= len(value) <= 1024 and value == value.strip()
                 and all(32 <= ord(char) <= 126 for char in value))


def _result(value):
    value = _record(value)
    _fields(value, {"schema", "kind", "intent_envelope_sha256", "permit_envelope_sha256",
                    "permit_record_sha256", "transport"})
    _kind(value, 2, "closed-upload-result-v2")
    _hex(value["intent_envelope_sha256"])
    _hex(value["permit_envelope_sha256"])
    _hex(value["permit_record_sha256"])
    result = value["transport"]
    _fields(result, {"schema", "kind", "attempt_id", "request_target_sha256", "status", "bytes",
                     "ciphertext_sha256", "version_id", "etag", "md5", "authorizes_upload"})
    _kind(result, 1, "closed-put-result")
    _identifier(result["attempt_id"])
    _hex(result["request_target_sha256"])
    _hex(result["ciphertext_sha256"])
    _require(type(result["status"]) is int and result["status"] in {200, 201, 204}
             and result["authorizes_upload"] is False)
    _integer(result["bytes"], CANDIDATE_MAX)
    _opaque(result["version_id"])
    _opaque(result["etag"])
    if result["md5"] is not None:
        _require(type(result["md5"]) is str)
        decoded = base64.b64decode(result["md5"], validate=True)
        _require(len(decoded) == 16 and base64.b64encode(decoded).decode("ascii") == result["md5"])
    return _sized(value)


def _structure(value, purpose):
    _require(type(purpose) is str and purpose in _PURPOSES)
    if purpose == "upload-intent-v2":
        return _intent(value, dict(_LIMIT_MAXIMA))
    if purpose == "upload-permit-v2":
        return _permit(value, dict(_LIMIT_MAXIMA))
    return _result(value)


@_boundary
def validate_intent(value, limits):
    """Validate release intent structure and caller limits; return a detached record."""
    return _intent(value, _limits(limits))


@_boundary
def validate_permit(value, intent, intent_wire, limits, *, now):
    """Validate supplied bindings and current freshness, without authenticating authority."""
    limits = _limits(limits)
    value, _ = _bound_permit(value, intent, intent_wire, limits)
    _integer(now)
    _require(value["issued_at"] <= now < value["expires_at"]
             and now - value["capacity"]["observed_at"] < limits["capacity_max_age_seconds"])
    return value


@_boundary
def validate_result(value, intent, intent_wire, permit, permit_wire, limits):
    """Validate timeless bindings; missing version metadata remains unresolved."""
    permit, intent = _bound_permit(permit, intent, intent_wire, _limits(limits))
    value = _result(value)
    _require(value["intent_envelope_sha256"] == envelope.digest(_wire(intent_wire))
             and value["permit_envelope_sha256"] == envelope.digest(_wire(permit_wire))
             and value["permit_record_sha256"] == envelope.digest(envelope.canonical(permit)))
    result, candidate = value["transport"], intent["candidate"]
    _require(all(result[field] == candidate[field] for field in
                 ("attempt_id", "request_target_sha256", "ciphertext_sha256", "bytes")))
    return value


@_boundary
def seal_control(value, recipient_key, signing_key, *, purpose):
    """Seal structurally valid records only; no binding or admission decision."""
    value = _structure(value, purpose)
    return _wire(envelope.seal(envelope.canonical(value), _key(recipient_key), _key(signing_key), purpose=purpose))


@_boundary
def open_control(wire, recipient_key, verify_key, *, purpose):
    """Authenticate/decrypt then validate structure only, not anchors or freshness."""
    _require(type(purpose) is str and purpose in _PURPOSES)
    plaintext = envelope.open_envelope(_wire(wire), _key(recipient_key), _key(verify_key), purpose=purpose)
    _require(type(plaintext) is bytes and 0 < len(plaintext) <= PLAINTEXT_MAX)
    return _structure(envelope.decode_json(plaintext), purpose)
