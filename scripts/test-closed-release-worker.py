#!/usr/bin/env python3
"""Offline signed-bootstrap, bounded exchange and existing-builder regressions."""
import contextlib
import copy
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import traceback
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

import closed_build as build
import closed_envelope as crypto
import closed_release_worker as worker
import closed_upload_control_v2 as control

NOW = 1_800_000_000
CANARY = "PRIVATE_RELEASE_TEST_CANARY_aae413"


def digest(value):
    return crypto.digest(crypto.canonical(value))


def keys():
    signing, recipient = Ed25519PrivateKey.generate(), X25519PrivateKey.generate()
    return (crypto.b64(signing.private_bytes_raw()), crypto.b64(signing.public_key().public_bytes_raw()),
            crypto.b64(recipient.private_bytes_raw()), crypto.b64(recipient.public_key().public_bytes_raw()))


def archive(files):
    packed = io.BytesIO()
    with tarfile.open(fileobj=packed, mode="w:gz", format=tarfile.USTAR_FORMAT) as stream:
        for name, data in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            stream.addfile(member, io.BytesIO(data))
    return packed.getvalue()


class Fixture:
    """Fictional keys, real envelopes, and deterministic in-memory object store."""

    def __init__(self, root):
        self.root = Path(root)
        self.now = float(NOW)
        self.operator_sign, self.operator_verify, self.ci_decrypt, self.ci_encrypt = keys()
        self.worker_sign, self.worker_verify, self.operator_decrypt, self.operator_encrypt = keys()
        self.input_keys = {"recipient_key": self.ci_decrypt, "verify_key": self.operator_verify}
        self.output_keys = {"recipient_key": self.operator_encrypt, "signing_key": self.worker_sign}
        self.limits = {name: build.policy()["upload_admission"][name] for name in control.MAX_LIMITS}
        self.execution = {"repository": build.REPOSITORY, "repository_id": build.REPOSITORY_ID,
            "repository_owner_id": build.OWNER_ID, "workflow_ref": build.REPOSITORY + "/" + build.WORKFLOW + "@refs/heads/main",
            "run_id": "73", "run_attempt": "2", "source_sha": "a" * 40,
            "event": "workflow_dispatch", "operation": "release", "worker_job": "closed_build / package"}
        self.context = {"schema": 1, "repository": build.REPOSITORY, "workflow": build.WORKFLOW,
            "run_id": "73", "run_attempt": "2", "source_sha": "a" * 40, "mode": "prospective",
            "channel": "rc", "plan_sha256": digest("plan"), "payloads": {},
            "dependencies": build.policy()["dependencies"], "repository_id": build.REPOSITORY_ID,
            "repository_owner_id": build.OWNER_ID, "base_version": "1.2.3"}
        self.ledger = {"ledger_id": "fictional-ledger", "batch_id": "fictional-batch",
                       "scope_fingerprint": digest("scope"), "bucket_fingerprint": digest("bucket")}
        self.capabilities = {name: "https://storage.invalid/" + name + "/" for name in worker.CAPABILITIES}
        caps = {name: crypto.digest(value.encode()) for name, value in self.capabilities.items()}
        names = worker.object_names("fixture", self.execution)
        bounds = {"input": 1000000, "candidate": self.limits["candidate_max_bytes"], "acceptance": 1000000,
                  "intent": 8192, "permit": 8192, "result": 8192}
        self.bootstrap = {"schema": 2, "kind": "closed-release-bootstrap-v2", "request_id": "fixture",
            "nonce": "c" * 32, "execution": self.execution.copy(),
            "public": {"channel": "rc", "plan_sha256": self.context["plan_sha256"], "context_sha256": digest(self.context)},
            "ledger": self.ledger.copy(), "objects": {}, "capability_sha256": caps,
            "routing": {"kind": "closed-prefix-routing-v2", "input_suffix": names["input"]},
            "limits_sha256": digest(self.limits), "created_at": NOW - 1, "expires_at": NOW + 1000,
            "growth_horizon_seconds": 1200, "growth_evidence_ref": digest("growth"),
            "worker": {"image": build.policy()["worker_image"], "policy_sha256": digest(build.policy())},
            "reservation_checkpoint": self.checkpoint(2, "reserve"),
            "control_checkpoints": {"intent": self.checkpoint(3, "begin-intent"), "result": self.checkpoint(4, "begin-result")}}
        for role in worker.ROLES:
            base = self.capabilities[{"input": "input_read", "acceptance": "acceptance_read"}.get(role, "output_write")]
            self.bootstrap["objects"][role] = {"claim_id": "claim-" + role, "object": names[role],
                "attempt_id": "attempt-" + role, "maximum_bytes": bounds[role],
                "request_target_sha256": crypto.digest((base + names[role]).encode())}
        self.expected = {"request_id": "fixture", "execution": self.execution.copy(), "public_context": copy.deepcopy(self.context),
            "ledger": self.ledger.copy(), "capability_sha256": caps.copy(),
            "input_target_sha256": self.bootstrap["objects"]["input"]["request_target_sha256"],
            "worker": self.bootstrap["worker"].copy()}
        lock = {"repository": "https://github.com/ha-homelab/home-studio.git", "commit": "b" * 40}
        self.files = {"scripts/closed-build-entry.py": CANARY.encode(), "public-core.lock.json": crypto.canonical(lock)}
        self.manifest = {"schema": 1, "request_id": "fixture", "entrypoint": "scripts/closed-build-entry.py",
            "acceptance_policy": "ha-home-python-v1", "build_mode": "rebuild-preserve",
            "worker_image": build.policy()["worker_image"], "original_core_lock": lock,
            "target": {key: self.context[key] for key in ("source_sha", "plan_sha256", "payloads")},
            "files": {name: crypto.digest(data) for name, data in self.files.items()}}
        self.reseal()
        self.candidate = crypto.seal(CANARY.encode(), self.operator_encrypt, self.worker_sign, purpose="candidate")
        self.stored, self.calls, self.gets = {}, [], 0
        self.journal = self.root / "attempt.jsonl"

    def checkpoint(self, generation, operation):
        return {"schema": 1, "kind": "committed-ledger-checkpoint", "ledger_id": self.ledger["ledger_id"],
            "scope_fingerprint": self.ledger["scope_fingerprint"], "generation": generation,
            "state_sha256": digest(["state", generation]), "operation_id": operation,
            "operation_receipt_sha256": digest(["receipt", generation])}

    def reseal(self):
        self.manifest["upload_bootstrap"] = copy.deepcopy(self.bootstrap)
        self.input_wire = crypto.seal(archive({**self.files, "closed-build.json": crypto.canonical(self.manifest)}),
                                      self.ci_encrypt, self.operator_sign, purpose="input")

    def permit(self):
        wire = self.stored[self.bootstrap["objects"]["intent"]["object"]]
        intent = control.open_control(wire, self.operator_decrypt, self.worker_verify, purpose="upload-intent-v2")
        claim = self.bootstrap["objects"]["candidate"]
        permit = {"schema": 2, "kind": "closed-upload-permit-v2", "intent_envelope_sha256": crypto.digest(wire),
            "intent_record_sha256": digest(intent), "destination": {
                "scope_fingerprint": self.ledger["scope_fingerprint"], "bucket_fingerprint": self.ledger["bucket_fingerprint"],
                "object_fingerprint": digest(["closed-object-v1", self.ledger["scope_fingerprint"],
                                               self.ledger["bucket_fingerprint"], claim["object"]])},
            "ledger": {"batch_id": self.ledger["batch_id"], "candidate_claim_id": claim["claim_id"],
                       "candidate_attempt_id": claim["attempt_id"], "checkpoint": self.checkpoint(8, "begin-candidate")},
            "capacity": {"policy_sha256": digest(self.limits), "evidence_sha256": digest("evidence"),
                "snapshot_sha256": digest("snapshot"), "assessment_sha256": digest("assessment"), "observed_at": int(self.now)},
            "issued_at": int(self.now), "expires_at": int(self.now) + 29}
        return permit

    def put(self, url, *, data, attempt_id, expected_sha256, expected_bytes, suffix, maximum, timeout, not_after):
        assert url == self.capabilities["output_write"]
        assert len(data) == expected_bytes and crypto.digest(data) == expected_sha256
        assert self.now < not_after and maximum == 8192 and timeout <= 60
        assert suffix not in self.stored
        assert self.journal.exists()
        stages = [json.loads(line)["stage"] for line in self.journal.read_text().splitlines()]
        role = next(name for name, value in self.bootstrap["objects"].items() if value["object"] == suffix)
        assert stages[-1] == role + "-attempted"
        self.calls.append(role)
        self.stored[suffix] = data
        return {"schema": 1, "kind": "closed-put-result", "attempt_id": attempt_id,
            "request_target_sha256": crypto.digest((url + suffix).encode()), "status": 201,
            "bytes": len(data), "ciphertext_sha256": crypto.digest(data), "version_id": "version-" + role,
            "etag": '"opaque"', "md5": crypto.b64(hashlib.md5(data, usedforsecurity=False).digest()), "authorizes_upload": False}

    def get(self, url, **kwargs):
        assert url == self.capabilities["output_read"]
        assert kwargs["suffix"] == self.bootstrap["objects"]["permit"]["object"]
        self.gets += 1
        return control.seal_control(self.permit(), self.ci_encrypt, self.operator_sign, purpose="upload-permit-v2")

    def kwargs(self):
        return dict(input_keys=self.input_keys, output_keys=self.output_keys, limits=self.limits, expected=self.expected,
                    capabilities=self.capabilities, journal_path=self.journal)

    def run(self):
        return worker.upload_release(self.input_wire, self.candidate, **self.kwargs())

    @contextlib.contextmanager
    def runtime(self):
        with patch.object(worker.time, "time", side_effect=lambda: self.now), \
             patch.object(worker.time, "monotonic", side_effect=lambda: self.now - NOW), \
             patch.object(worker.time, "sleep", side_effect=lambda seconds: setattr(self, "now", self.now + seconds)), \
             patch.object(worker.release_transport, "put", side_effect=self.put), \
             patch.object(worker.release_transport, "get", side_effect=self.get):
            yield


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.root.chmod(0o700)
        self.f = Fixture(self.root)
        self.output = self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.errors = self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.stack.enter_context(patch("socket.create_connection", side_effect=AssertionError("No network")))
        self.stack.enter_context(self.f.runtime())
        self.addCleanup(lambda: self.assertEqual(self.output.getvalue() + self.errors.getvalue(), ""))

    def rejected(self, operation):
        with self.assertRaises(worker.WorkerError) as found:
            operation()
        self.assertEqual(found.exception.args, ("ClosedReleaseWorkerRejected",))
        self.assertIsNone(found.exception.__cause__)
        self.assertIsNone(found.exception.__context__)
        self.assertNotIn(CANARY, "".join(traceback.format_exception(found.exception)))

    def test_real_crypto_roundtrip_three_puts_and_exact_v2_bindings(self):
        result = self.f.run()
        self.assertEqual(self.f.calls, ["intent", "candidate", "result"])
        self.assertEqual(self.f.gets, 1)
        self.assertFalse(result["authorizes_upload"])
        intent = control.open_control(result["intent_wire"], self.f.operator_decrypt, self.f.worker_verify, purpose="upload-intent-v2")
        permit = control.open_control(result["permit_wire"], self.f.ci_decrypt, self.f.operator_verify, purpose="upload-permit-v2")
        record = control.open_control(result["result_wire"], self.f.operator_decrypt, self.f.worker_verify, purpose="upload-result-v2")
        control.validate_result(record, intent, result["intent_wire"], permit, result["permit_wire"], self.f.limits)
        self.assertEqual(intent["input_sha256"], crypto.digest(self.f.input_wire))
        self.assertEqual(self.f.journal.stat().st_mode & 0o777, 0o600)
        self.assertNotIn(CANARY, self.f.journal.read_text())
        for value in self.f.capabilities.values():
            self.assertNotIn(value, self.f.journal.read_text())

    def test_success_reentry_rejects_without_another_get_or_put(self):
        self.f.run()
        self.rejected(self.f.run)
        self.assertEqual(self.f.calls, ["intent", "candidate", "result"])
        self.assertEqual(self.f.gets, 1)

    def test_every_put_failure_is_ambiguous_and_never_retried(self):
        for failure in ("intent", "candidate", "result"):
            with self.subTest(failure=failure):
                self.f.journal = self.root / (failure + ".jsonl")
                self.f.stored.clear()
                self.f.calls.clear()
                self.f.gets = 0
                def fail(url, **kwargs):
                    role = kwargs["attempt_id"].removeprefix("attempt-")
                    self.f.put(url, **kwargs)
                    if role == failure:
                        raise RuntimeError(CANARY)
                with patch.object(worker.release_transport, "put", side_effect=fail):
                    self.rejected(self.f.run)
                before = list(self.f.calls), self.f.gets
                self.rejected(self.f.run)
                self.assertEqual((self.f.calls, self.f.gets), before)

    def test_prepared_marker_before_network_survives_sync_failure(self):
        with patch.object(worker.os, "fsync", side_effect=OSError(CANARY)):
            self.rejected(self.f.run)
        self.assertTrue(self.f.journal.exists())
        self.assertEqual(self.f.calls, [])
        self.rejected(self.f.run)

    def test_checkpoint_scope_and_generation_substitutions_preflight(self):
        base = copy.deepcopy(self.f.bootstrap)
        for modify in (
            lambda b: b["control_checkpoints"]["result"].update(generation=3),
            lambda b: b["control_checkpoints"]["intent"].update(ledger_id="different"),
            lambda b: b["reservation_checkpoint"].update(scope_fingerprint="0" * 64),
            lambda b: b["reservation_checkpoint"].update(generation=4097),
        ):
            self.f.bootstrap = copy.deepcopy(base)
            modify(self.f.bootstrap)
            self.f.reseal()
            self.rejected(self.f.run)
        self.assertFalse(self.f.journal.exists())
        self.assertEqual(self.f.calls, [])

    def test_independent_execution_context_and_route_substitutions_preflight(self):
        base = copy.deepcopy(self.f.expected)
        for modify in (
            lambda x: x["execution"].update(run_attempt="3"),
            lambda x: x["execution"].update(source_sha="d" * 40),
            lambda x: x["public_context"]["payloads"].update(extra={"sha256": "a" * 64, "size": 1}),
            lambda x: x["public_context"]["dependencies"].update(extra="changed"),
            lambda x: x.update(input_target_sha256="0" * 64),
            lambda x: x["capability_sha256"].update(output_write="0" * 64),
            lambda x: x["worker"].update(policy_sha256="0" * 64),
        ):
            self.f.expected = copy.deepcopy(base)
            modify(self.f.expected)
            self.rejected(self.f.run)
        self.assertFalse(self.f.journal.exists())

    def test_all_event_channel_pairs_and_rebuild_reject(self):
        valid = {("push", "beta"), ("schedule", "nightly"), ("workflow_dispatch", "beta"),
                 ("workflow_dispatch", "rc"), ("workflow_dispatch", "nightly")}
        for event in ("push", "schedule", "workflow_dispatch", "pull_request"):
            for channel in ("beta", "rc", "nightly", "stable"):
                b, e = copy.deepcopy(self.f.bootstrap), copy.deepcopy(self.f.expected)
                b["execution"]["event"] = e["execution"]["event"] = event
                e["public_context"]["channel"] = channel
                b["public"].update(channel=channel, context_sha256=digest(e["public_context"]))
                operation = lambda: worker.validate_bootstrap(b, expected=e, capabilities=self.f.capabilities,
                                                               limits=self.f.limits, now=NOW)
                if (event, channel) in valid:
                    self.assertEqual(operation(), b)
                else:
                    self.rejected(operation)
        self.f.bootstrap["execution"]["operation"] = self.f.expected["execution"]["operation"] = "closed-rebuild"
        self.f.reseal()
        self.rejected(self.f.run)

    def test_signed_input_wrong_key_wrong_purpose_and_archive_reject(self):
        original = self.f.input_wire
        wires = [crypto.seal(b"bad archive", self.f.ci_encrypt, self.f.operator_sign, purpose="input"),
                 crypto.seal(b"archive", self.f.ci_encrypt, self.f.worker_sign, purpose="input"),
                 crypto.seal(b"archive", self.f.ci_encrypt, self.f.operator_sign, purpose="candidate")]
        for wire in wires:
            self.f.input_wire = wire
            self.rejected(self.f.run)
        self.f.input_wire = original
        self.assertFalse(self.f.journal.exists())

    def test_pax_and_gnu_extensions_reject_before_any_extension_payload_read(self):
        original_read = worker._GzipInput.read
        for kind in (b"x", b"g", b"L", b"K", b"S"):
            with self.subTest(kind=kind):
                header = tarfile.TarInfo("extension")
                header.type, header.size = kind, 1_000_000_000
                raw = header.tobuf(format=tarfile.USTAR_FORMAT)
                self.f.input_wire = crypto.seal(gzip.compress(raw), self.f.ci_encrypt,
                                                self.f.operator_sign, purpose="input")
                requested = []
                def tracked(stream, size):
                    requested.append(size)
                    return original_read(stream, size)
                with patch.object(worker._GzipInput, "read", new=tracked):
                    self.rejected(self.f.run)
                self.assertEqual(requested, [512])
        self.assertFalse(self.f.journal.exists())

    def test_gzip_expansion_is_bounded_before_tar_extensions_or_padding(self):
        # A small injected cap exercises the production streaming bound.
        bomb = gzip.compress(bytes(8192))
        self.assertLess(len(bomb), 100)
        self.f.input_wire = crypto.seal(bomb, self.f.ci_encrypt, self.f.operator_sign, purpose="input")
        with patch.object(worker, "INPUT_TAR_MAX", 2048):
            self.rejected(self.f.run)
        self.assertFalse(self.f.journal.exists())

    def test_gzip_truncation_concatenation_trailing_bytes_and_non_gzip_reject(self):
        raw = archive({**self.f.files, "closed-build.json": crypto.canonical(self.f.manifest)})
        for malformed in (raw[:-1], raw + gzip.compress(b"hidden"), raw + b"hidden", gzip.decompress(raw)):
            self.f.input_wire = crypto.seal(malformed, self.f.ci_encrypt, self.f.operator_sign, purpose="input")
            self.rejected(self.f.run)
        self.assertFalse(self.f.journal.exists())

    def test_ustar_checksum_negative_size_duplicate_and_missing_end_blocks_reject(self):
        valid = gzip.decompress(archive({"closed-build.json": crypto.canonical(self.f.manifest)}))
        damaged = bytearray(valid)
        damaged[0] ^= 1
        negative = bytearray(valid[:512])
        negative[124:136] = b"-0000000001\0"
        negative[148:156] = b"        "
        negative[148:156] = ("%06o\0 " % sum(negative)).encode()
        one_length = 512 + ((len(crypto.canonical(self.f.manifest)) + 511) // 512) * 512
        duplicate = valid[:one_length] * 2 + bytes(1024)
        for malformed in (bytes(damaged), bytes(negative), duplicate, valid[:one_length]):
            self.f.input_wire = crypto.seal(gzip.compress(malformed), self.f.ci_encrypt,
                                           self.f.operator_sign, purpose="input")
            self.rejected(self.f.run)
        self.assertFalse(self.f.journal.exists())

    def test_ustar_prefix_names_and_streaming_multiple_chunks_are_supported(self):
        name = "long/" + "a" * 90 + "/" + "b" * 80
        self.f.files[name] = b"payload" * 20000
        self.f.manifest["files"][name] = crypto.digest(self.f.files[name])
        self.f.reseal()
        result = self.f.run()
        self.assertEqual(result["state"], "result-stored")

    def test_put_timeout_is_remaining_admission_after_attempt_journal_sync(self):
        append = worker._append
        timeouts = {}
        def delayed(descriptor, path, value):
            append(descriptor, path, value)
            if value["stage"] == "candidate-attempted":
                self.f.now += 28.5
        def measured(url, **kwargs):
            timeouts[kwargs["attempt_id"]] = kwargs["timeout"]
            return self.f.put(url, **kwargs)
        with patch.object(worker, "_append", side_effect=delayed), \
             patch.object(worker.release_transport, "put", side_effect=measured):
            self.f.run()
        self.assertEqual(timeouts["attempt-intent"], 60)
        self.assertGreater(timeouts["attempt-candidate"], 0)
        self.assertLessEqual(timeouts["attempt-candidate"], 0.5)
        self.assertLessEqual(timeouts["attempt-result"], 0.5)

    def test_candidate_must_be_immutable_valid_signed_candidate(self):
        for candidate in (bytearray(self.f.candidate), b"bad", crypto.seal(b"x", self.f.operator_encrypt,
                self.f.operator_sign, purpose="candidate"), crypto.seal(b"x", self.f.operator_encrypt,
                self.f.worker_sign, purpose="input")):
            self.f.candidate = candidate
            self.rejected(self.f.run)
        self.assertFalse(self.f.journal.exists())

    def test_unknown_fields_bool_bounds_and_no_prefix_contract_reject(self):
        base = copy.deepcopy(self.f.bootstrap)
        for modify in (lambda x: x.update(extra=True), lambda x: x.update(schema=True),
                       lambda x: x["objects"]["intent"].update(maximum_bytes=True),
                       lambda x: x["routing"].update(kind="object-only"),
                       lambda x: x.update(growth_horizon_seconds=899),
                       lambda x: x.update(growth_horizon_seconds=3601)):
            self.f.bootstrap = copy.deepcopy(base)
            modify(self.f.bootstrap)
            self.f.reseal()
            self.rejected(self.f.run)
        self.assertFalse(self.f.journal.exists())

    def test_oversize_encrypted_intent_rejected_before_journal_or_put(self):
        self.f.bootstrap["objects"]["intent"]["maximum_bytes"] = 1
        self.f.reseal()
        self.rejected(self.f.run)
        self.assertFalse(self.f.journal.exists())
        self.assertEqual(self.f.calls, [])

    def test_oversize_encrypted_result_never_put(self):
        self.f.bootstrap["objects"]["result"]["maximum_bytes"] = 1
        self.f.reseal()
        self.rejected(self.f.run)
        self.assertEqual(self.f.calls, ["intent", "candidate"])

    def test_bootstrap_future_and_expired_rejected_before_marker(self):
        for now in (NOW - 2, NOW + 1000):
            self.f.now = now
            self.rejected(self.f.run)
        self.assertFalse(self.f.journal.exists())

    def test_timeless_bootstrap_binding_is_detached_but_never_renews_a_grant(self):
        value = worker.validate_bootstrap_bindings(self.f.bootstrap, self.f.expected, self.f.capabilities, self.f.limits)
        value["objects"]["intent"]["maximum_bytes"] = 1
        self.assertEqual(self.f.bootstrap["objects"]["intent"]["maximum_bytes"], 8192)
        self.f.now = NOW + 1001
        self.assertEqual(worker.validate_bootstrap_bindings(self.f.bootstrap, self.f.expected,
                                                           self.f.capabilities, self.f.limits), self.f.bootstrap)
        self.rejected(self.f.run)
        self.assertEqual(self.f.calls, [])

    def test_result_sealing_crossing_expiry_does_not_put_result(self):
        seal = control.seal_control
        def delayed(value, *args, **kwargs):
            wire = seal(value, *args, **kwargs)
            if kwargs["purpose"] == "upload-result-v2":
                self.f.now += 30
            return wire
        with patch.object(control, "seal_control", side_effect=delayed):
            self.rejected(self.f.run)
        self.assertEqual(self.f.calls, ["intent", "candidate"])

    def test_monotonic_elapsed_can_expire_grant_with_frozen_wall_clock(self):
        ticks = iter((0, 1002))
        with patch.object(worker.time, "monotonic", side_effect=lambda: next(ticks)):
            self.rejected(self.f.run)
        self.assertFalse(self.f.journal.exists())

    def test_inconsistent_execution_and_public_context_reject_even_when_signed(self):
        self.f.expected["public_context"]["source_sha"] = "f" * 40
        self.f.bootstrap["public"]["context_sha256"] = digest(self.f.expected["public_context"])
        self.f.reseal()
        self.rejected(self.f.run)
        self.assertFalse(self.f.journal.exists())

    def test_only_404_waits_and_wait_is_bounded(self):
        def unavailable(url, **kwargs):
            self.f.gets += 1
            raise worker.release_transport.ReleaseTransportNotFound()
        with patch.object(worker.release_transport, "get", side_effect=unavailable):
            self.rejected(self.f.run)
        self.assertLessEqual(self.f.gets, self.f.limits["wait_seconds"] + 1)
        self.assertEqual(self.f.calls, ["intent"])
        self.f.journal = self.root / "forbidden.jsonl"
        self.f.calls.clear()
        self.f.stored.clear()
        with patch.object(worker.release_transport, "get", side_effect=worker.release_transport.ReleaseTransportError()):
            self.rejected(self.f.run)
        self.assertEqual(self.f.calls, ["intent"])

    def test_permit_candidate_claim_mismatch_stops_before_candidate(self):
        def wrong(url, **kwargs):
            permit = self.f.permit()
            permit["ledger"]["candidate_claim_id"] = "another-claim"
            return control.seal_control(permit, self.f.ci_encrypt, self.f.operator_sign, purpose="upload-permit-v2")
        with patch.object(worker.release_transport, "get", side_effect=wrong):
            self.rejected(self.f.run)
        self.assertEqual(self.f.calls, ["intent"])

    def test_candidate_success_crossing_expiry_never_sends_result(self):
        def delayed(url, **kwargs):
            receipt = self.f.put(url, **kwargs)
            if kwargs["attempt_id"] == "attempt-candidate":
                self.f.now += 30
            return receipt
        with patch.object(worker.release_transport, "put", side_effect=delayed):
            self.rejected(self.f.run)
        self.assertEqual(self.f.calls, ["intent", "candidate"])
        self.rejected(self.f.run)

    def test_missing_candidate_version_is_preserved_as_null(self):
        def missing(url, **kwargs):
            result = self.f.put(url, **kwargs)
            result["version_id"] = None
            return result
        with patch.object(worker.release_transport, "put", side_effect=missing):
            result = self.f.run()
        record = control.open_control(result["result_wire"], self.f.operator_decrypt,
                                      self.f.worker_verify, purpose="upload-result-v2")
        self.assertIsNone(record["transport"]["version_id"])

    def test_exception_context_never_discloses_caller_or_transport(self):
        try:
            raise ValueError(CANARY)
        except ValueError:
            self.f.input_wire = b"invalid"
            self.rejected(self.f.run)

    def test_journal_symlink_hardlink_and_public_directory_no_put(self):
        target = self.root / "existing"
        target.write_bytes(b"keep")
        target.chmod(0o600)
        self.f.journal.symlink_to(target)
        self.rejected(self.f.run)
        self.f.journal.unlink()
        os.link(target, self.f.journal)
        self.rejected(self.f.run)
        self.f.journal.unlink()
        self.root.chmod(0o755)
        self.rejected(self.f.run)
        self.assertEqual(target.read_bytes(), b"keep")
        self.assertEqual(self.f.calls, [])
        self.root.chmod(0o700)

    def test_production_build_still_holds_before_any_private_read(self):
        with patch.object(build, "transport") as transport_call, patch.object(build, "public_inputs") as public:
            with self.assertRaises(build.UploadAdmissionUnavailable):
                build.execute(SimpleNamespace(action="build"), self.root)
        transport_call.assert_not_called()
        public.assert_not_called()

    def test_higher_path_authenticates_before_public_io_and_rejects_context_changes(self):
        args = SimpleNamespace(action="build", closed_request="fixture", prepared_root=self.root)
        with patch.object(build, "public_inputs") as public:
            self.rejected(lambda: worker.build_and_run_release(args, self.root, input_wire=b"bad", **self.f.kwargs()))
        public.assert_not_called()
        (self.root / "prepared.json").write_bytes(crypto.canonical(build.policy()))
        env = {"GITHUB_REPOSITORY": build.REPOSITORY, "GITHUB_REPOSITORY_ID": build.REPOSITORY_ID,
            "GITHUB_REPOSITORY_OWNER_ID": build.OWNER_ID, "GITHUB_REF": "refs/heads/main",
            "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_WORKFLOW_REF": self.f.execution["workflow_ref"],
            "RUNNER_ENVIRONMENT": "github-hosted", "GITHUB_RUN_ID": "73", "GITHUB_RUN_ATTEMPT": "2", "GITHUB_SHA": "a" * 40}
        different = {**self.f.context, "payloads": {"other": {"sha256": "0" * 64, "size": 1}}}
        with patch.dict(os.environ, env), patch.object(build, "public_inputs", return_value=(different, self.root)), \
             patch.object(build, "build_release_candidate") as candidate:
            self.rejected(lambda: worker.build_and_run_release(args, self.root, input_wire=self.f.input_wire, **self.f.kwargs()))
        candidate.assert_not_called()
        self.assertEqual(self.f.calls, [])

    def test_higher_path_counts_build_elapsed_with_frozen_wall_clock(self):
        args = SimpleNamespace(action="build", closed_request="fixture", prepared_root=self.root)
        (self.root / "prepared.json").write_bytes(crypto.canonical(build.policy()))
        env = {"GITHUB_REPOSITORY": build.REPOSITORY, "GITHUB_REPOSITORY_ID": build.REPOSITORY_ID,
            "GITHUB_REPOSITORY_OWNER_ID": build.OWNER_ID, "GITHUB_REF": "refs/heads/main",
            "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_WORKFLOW_REF": self.f.execution["workflow_ref"],
            "RUNNER_ENVIRONMENT": "github-hosted", "GITHUB_RUN_ID": "73", "GITHUB_RUN_ATTEMPT": "2", "GITHUB_SHA": "a" * 40}
        ticks = [0]
        def delayed_build(*args, **kwargs):
            ticks[0] = 2000
            return self.f.candidate
        with patch.dict(os.environ, env), patch.object(worker.time, "monotonic", side_effect=lambda: ticks[0]), \
             patch.object(build, "public_inputs", return_value=(self.f.context, self.root)), \
             patch.object(build, "build_release_candidate", side_effect=delayed_build):
            self.rejected(lambda: worker.build_and_run_release(args, self.root, input_wire=self.f.input_wire, **self.f.kwargs()))
        self.assertEqual(self.f.calls, [])
        self.assertFalse(self.f.journal.exists())

    def test_higher_path_reuses_real_input_output_validation_and_seals_bound_candidate(self):
        prepared = self.root / "prepared"
        prepared.mkdir()
        (prepared / "prepared.json").write_bytes(crypto.canonical(build.policy()))
        args = SimpleNamespace(action="build", closed_request="", prepared_root=prepared)
        env = {"GITHUB_REPOSITORY": build.REPOSITORY, "GITHUB_REPOSITORY_ID": build.REPOSITORY_ID,
            "GITHUB_REPOSITORY_OWNER_ID": build.OWNER_ID, "GITHUB_REF": "refs/heads/main",
            "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_WORKFLOW_REF": self.f.execution["workflow_ref"],
            "RUNNER_ENVIRONMENT": "github-hosted", "GITHUB_RUN_ID": "73", "GITHUB_RUN_ATTEMPT": "2", "GITHUB_SHA": "a" * 40}
        def public_inputs(args, temporary):
            public = temporary / "public"
            (public / "component").mkdir(parents=True)
            (public / "component/core.py").write_bytes(b"public immutable")
            (public / "source/scripts").mkdir(parents=True)
            (public / "source/scripts/install-home-assistant.py").write_bytes(b"trusted public installer")
            return copy.deepcopy(self.f.context), public
        def container(image, source, public, output, context, log, *, timeout):
            self.assertEqual(image, self.f.bootstrap["worker"]["image"])
            self.assertEqual(crypto.decode_json((context / "build.json").read_bytes())["public"], self.f.context)
            output.mkdir()
            (output / "home-package.tar.gz").write_bytes(archive({"custom_components/home_floorplan/core.py": b"public immutable",
                                                                 "custom_components/home_floorplan/site.json": b"{}"}))
            (output / "acceptance.json").write_bytes(crypto.canonical({"schema": 1, "passed": True,
                                                                      "checks": ["package", "site-contracts", "geometry"]}))
        with patch.dict(os.environ, env), patch.object(build, "public_inputs", side_effect=public_inputs), \
             patch.object(build, "run_worker", side_effect=container):
            result = worker.build_and_run_release(args, self.root, input_wire=self.f.input_wire, **self.f.kwargs())
        sealed = self.f.stored[self.f.bootstrap["objects"]["candidate"]["object"]]
        plain = crypto.open_envelope(sealed, self.f.operator_decrypt, self.f.worker_verify, purpose="candidate")
        with tarfile.open(fileobj=io.BytesIO(plain), mode="r:gz") as packed:
            manifest = json.load(packed.extractfile("candidate.json"))
        self.assertEqual(manifest["input_sha256"], crypto.digest(self.f.input_wire))
        self.assertEqual(manifest["public"], self.f.context)
        self.assertEqual(manifest["build_run_attempt"], "2")
        self.assertFalse(result["authorizes_upload"])


if __name__ == "__main__":
    unittest.main()
