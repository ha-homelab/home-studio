"""Bounded upload admission protocol. No network I/O or credential discovery."""
from __future__ import annotations

import math
import re
import time
from closed_envelope import MAX_ENVELOPE, canonical, decode_json, digest

CONTROL_MAX = 8192
POLICY_FIELDS = {"candidate_max_bytes", "post_candidate_reserve_bytes", "permit_ttl_seconds",
                 "capacity_max_age_seconds", "wait_seconds"}
INTENT_FIELDS = {"schema", "kind", "request_id", "run_id", "run_attempt", "build_source_sha",
                 "input_sha256", "candidate_object", "candidate_sha256", "candidate_bytes",
                 "output_capability_sha256", "nonce", "created_at", "operation", "worker_job"}
PERMIT_FIELDS = {"schema", "kind", "intent", "intent_sha256", "capacity_snapshot_sha256",
                 "capacity_observed_at", "safe_available_bytes", "required_bytes", "issued_at", "expires_at"}
SHA = re.compile(r"[0-9a-f]{64}\Z")
WORKER_JOBS = {"release": "closed_build / package", "closed-rebuild": "closed_rebuild / package"}


def require(value):
    if not value:
        raise ValueError("Closed upload admission rejected")


def integer(value, minimum=1, maximum=None):
    require(type(value) is int and value >= minimum and (maximum is None or value <= maximum))
    return value


def policy(value):
    require(isinstance(value, dict) and set(value) == POLICY_FIELDS)
    integer(value["candidate_max_bytes"], maximum=MAX_ENVELOPE)
    integer(value["post_candidate_reserve_bytes"], minimum=8 * 1024**2)
    integer(value["permit_ttl_seconds"], maximum=30)
    integer(value["capacity_max_age_seconds"], maximum=30)
    integer(value["wait_seconds"], maximum=120)
    return value


def control(data):
    require(isinstance(data, bytes) and 0 < len(data) <= CONTROL_MAX)
    return decode_json(data)


def required_capacity(limits):
    policy(limits)
    # The intent is already stored; the permit still needs its own small PUT.
    return limits["candidate_max_bytes"] + limits["post_candidate_reserve_bytes"] + CONTROL_MAX


def worker_job(operation):
    require(isinstance(operation, str) and operation in WORKER_JOBS)
    return WORKER_JOBS[operation]


def validate_intent(value, limits):
    policy(limits)
    require(isinstance(value, dict) and set(value) == INTENT_FIELDS)
    require(type(value["schema"]) is int and value["schema"] == 1 and value["kind"] == "closed-upload-intent")
    require(value["worker_job"] == worker_job(value["operation"]))
    require(isinstance(value["request_id"], str) and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}", value["request_id"]))
    for key in ("run_id", "run_attempt"):
        require(isinstance(value[key], str) and re.fullmatch(r"[1-9][0-9]*", value[key]))
    require(isinstance(value["build_source_sha"], str) and re.fullmatch(r"[0-9a-f]{40}", value["build_source_sha"]))
    for key in ("input_sha256", "candidate_sha256", "output_capability_sha256"):
        require(isinstance(value[key], str) and SHA.fullmatch(value[key]))
    require(value["candidate_object"] == value["request_id"] + "/" + value["run_id"] + "-" + value["run_attempt"] + ".candidate.json")
    require(isinstance(value["nonce"], str) and re.fullmatch(r"[0-9a-f]{32}", value["nonce"]))
    integer(value["candidate_bytes"], maximum=limits["candidate_max_bytes"])
    integer(value["created_at"])
    require(len(canonical(value)) <= CONTROL_MAX)
    return value


def object_suffix(intent, kind):
    require(kind in {"upload-intent", "upload-permit"})
    return intent["request_id"] + "/" + intent["run_id"] + "-" + intent["run_attempt"] + "." + kind + ".json"


def validate_permit(value, intent, intent_wire, limits, *, now=None):
    validate_intent(intent, limits)
    now = int(time.time()) if now is None else integer(now)
    require(isinstance(value, dict) and set(value) == PERMIT_FIELDS)
    require(type(value["schema"]) is int and value["schema"] == 1 and value["kind"] == "closed-upload-permit")
    validate_intent(value["intent"], limits)
    require(canonical(value["intent"]) == canonical(intent) and value["intent_sha256"] == digest(intent_wire))
    require(isinstance(value["capacity_snapshot_sha256"], str) and SHA.fullmatch(value["capacity_snapshot_sha256"]))
    issued, expires, observed = (integer(value[key]) for key in ("issued_at", "expires_at", "capacity_observed_at"))
    require(issued <= now + 5 and 0 < expires - issued <= limits["permit_ttl_seconds"] and now < expires)
    require(0 <= issued - observed <= limits["capacity_max_age_seconds"] and observed <= now + 5)
    require(now - observed < limits["capacity_max_age_seconds"])
    require(expires <= observed + limits["capacity_max_age_seconds"])
    require(0 <= issued - intent["created_at"] <= limits["wait_seconds"])
    required = required_capacity(limits)
    require(integer(value["required_bytes"]) == required and integer(value["safe_available_bytes"], minimum=0) >= required)
    return value


def make_permit(intent, intent_wire, capacity, limits, *, now=None):
    """Called only by the operator after independently authenticating run and scope."""
    validate_intent(intent, limits)
    now = int(time.time()) if now is None else integer(now)
    require(isinstance(capacity, dict) and all(capacity.get(key) is True for key in (
        "ok", "all_buckets_complete", "all_versions_complete", "multipart_accounted")))
    require(capacity.get("mutations") is False)
    observed = capacity["started_at_epoch"]
    require(type(observed) in (int, float) and math.isfinite(observed) and observed >= 1)
    require(0 <= now - int(observed) <= limits["capacity_max_age_seconds"])
    available = min(integer(capacity["limits_available_bytes"], minimum=0),
                    integer(capacity["regional_limit_bytes"]) - integer(capacity["version_inclusive_bytes"], minimum=0))
    require(capacity["safe_available_bytes"] == available)
    permit = {"schema": 1, "kind": "closed-upload-permit", "intent": intent,
              "intent_sha256": digest(intent_wire), "capacity_snapshot_sha256": digest(canonical(capacity)),
              "capacity_observed_at": int(observed), "safe_available_bytes": available,
              "required_bytes": required_capacity(limits),
              "issued_at": now, "expires_at": min(now + limits["permit_ttl_seconds"],
                                                   int(observed) + limits["capacity_max_age_seconds"])}
    return validate_permit(permit, intent, intent_wire, limits, now=now)
