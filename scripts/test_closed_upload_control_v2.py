#!/usr/bin/env python3
"""Offline v2 record bindings, strict bounds and real signed-envelope tests."""
import contextlib
import copy
import hashlib
import io
import time
import traceback
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

import closed_envelope as crypto
import closed_upload_control_v2 as control


NOW = 1_800_000_000
MARKER = "FICTIONAL_PRIVATE_V2_CANARY_7ea28"
DATA = b"fictional encrypted candidate bytes"
PURPOSES = ("upload-intent-v2", "upload-permit-v2", "upload-result-v2")


def sha(value):
    return crypto.digest(crypto.canonical(value))


def keys():
    signer, recipient = Ed25519PrivateKey.generate(), X25519PrivateKey.generate()
    return (crypto.b64(signer.private_bytes_raw()), crypto.b64(signer.public_key().public_bytes_raw()),
            crypto.b64(recipient.private_bytes_raw()), crypto.b64(recipient.public_key().public_bytes_raw()))


def changed(value, path, replacement):
    value = copy.deepcopy(value)
    parent = value
    for key in path[:-1]:
        parent = parent[key]
    parent[path[-1]] = replacement
    return value


class UploadControlV2Tests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.out = self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.err = self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.stack.enter_context(patch("socket.create_connection", side_effect=AssertionError("Network forbidden")))
        self.addCleanup(self.assert_silent)
        self.sign, self.verify, self.decrypt, self.encrypt = keys()
        self.limits = {"candidate_max_bytes": 1024**2, "permit_ttl_seconds": 30,
                       "capacity_max_age_seconds": 30, "wait_seconds": 120}
        self.intent = {
            "schema": 2, "kind": "closed-upload-intent-v2", "request_id": "fixture", "nonce": "a" * 32,
            "created_at": NOW - 2,
            "execution": {
                "repository": "ha-homelab/home-studio", "repository_id": "1414876449",
                "repository_owner_id": "307715255",
                "workflow_ref": "ha-homelab/home-studio/.github/workflows/release-pipeline.yml@refs/heads/main",
                "run_id": "12", "run_attempt": "2", "source_sha": "b" * 40,
                "event": "workflow_dispatch", "operation": "release", "worker_job": "closed_build / package",
            },
            "public": {"channel": "rc", "plan_sha256": sha("plan"), "context_sha256": sha("context")},
            "input_sha256": sha("input"),
            "candidate": {"object": "fixture/12-2.candidate.json", "ciphertext_sha256": crypto.digest(DATA),
                          "bytes": len(DATA), "attempt_id": "attempt-fixture",
                          "output_capability_sha256": sha("capability"), "request_target_sha256": sha("target")},
        }
        self.intent_wire = self.raw_seal(self.intent, PURPOSES[0])
        scope, bucket = sha("scope"), sha("bucket")
        self.permit = {
            "schema": 2, "kind": "closed-upload-permit-v2",
            "intent_envelope_sha256": crypto.digest(self.intent_wire), "intent_record_sha256": sha(self.intent),
            "destination": {"scope_fingerprint": scope, "bucket_fingerprint": bucket,
                            "object_fingerprint": sha(["closed-object-v1", scope, bucket,
                                                       self.intent["candidate"]["object"]])},
            "ledger": {"batch_id": "batch-fixture", "candidate_claim_id": "claim-fixture",
                       "candidate_attempt_id": "attempt-fixture", "checkpoint": {
                           "schema": 1, "kind": "committed-ledger-checkpoint", "ledger_id": "ledger-fixture",
                           "scope_fingerprint": scope, "generation": 4, "state_sha256": sha("state"),
                           "operation_id": "begin-candidate", "operation_receipt_sha256": sha("receipt")}},
            "capacity": {"policy_sha256": sha(self.limits), "evidence_sha256": sha("evidence"),
                         "snapshot_sha256": sha("snapshot"), "assessment_sha256": sha("assessment"),
                         "observed_at": NOW - 1},
            "issued_at": NOW, "expires_at": NOW + 29,
        }
        self.permit_wire = self.raw_seal(self.permit, PURPOSES[1])
        self.result = {
            "schema": 2, "kind": "closed-upload-result-v2",
            "intent_envelope_sha256": crypto.digest(self.intent_wire),
            "permit_envelope_sha256": crypto.digest(self.permit_wire),
            "permit_record_sha256": sha(self.permit),
            "transport": {"schema": 1, "kind": "closed-put-result", "attempt_id": "attempt-fixture",
                          "request_target_sha256": sha("target"), "status": 201, "bytes": len(DATA),
                          "ciphertext_sha256": crypto.digest(DATA), "version_id": "Version_A-1",
                          "etag": '"Opaque-CaseSensitive"',
                          "md5": crypto.b64(hashlib.md5(DATA, usedforsecurity=False).digest()),
                          "authorizes_upload": False},
        }

    def assert_silent(self):
        self.assertEqual(self.out.getvalue(), "")
        self.assertEqual(self.err.getvalue(), "")

    def raw_seal(self, value, purpose):
        plain = value if type(value) is bytes else crypto.canonical(value)
        return crypto.seal(plain, self.encrypt, self.sign, purpose=purpose)

    def open(self, wire, purpose):
        return control.open_control(wire, self.decrypt, self.verify, purpose=purpose)

    def validate_permit(self, value=None, *, intent=None, wire=None, limits=None, now=NOW):
        return control.validate_permit(self.permit if value is None else value,
            self.intent if intent is None else intent, self.intent_wire if wire is None else wire,
            self.limits if limits is None else limits, now=now)

    def validate_result(self, value=None, *, intent=None, intent_wire=None, permit=None, permit_wire=None, limits=None):
        return control.validate_result(self.result if value is None else value,
            self.intent if intent is None else intent, self.intent_wire if intent_wire is None else intent_wire,
            self.permit if permit is None else permit, self.permit_wire if permit_wire is None else permit_wire,
            self.limits if limits is None else limits)

    def rebind_intent(self, intent):
        wire = self.raw_seal(intent, PURPOSES[0])
        permit = copy.deepcopy(self.permit)
        permit["intent_envelope_sha256"], permit["intent_record_sha256"] = crypto.digest(wire), sha(intent)
        return wire, permit

    def rejected(self, operation):
        try:
            operation()
        except control.ControlError as error:
            self.assertIs(type(error), control.ControlError)
            self.assertEqual(error.args, ("Closed upload control rejected",))
            self.assertIsNone(error.__cause__)
            self.assertIsNone(error.__context__)
            self.assertNotIn(MARKER, "".join(traceback.format_exception(error)))
        else:
            self.fail("Expected a sanitized control rejection")

    def test_valid_records_and_real_envelopes_roundtrip_without_authorizing(self):
        self.assertEqual(control.validate_intent(self.intent, self.limits), self.intent)
        self.assertEqual(self.validate_permit(), self.permit)
        self.assertEqual(self.validate_result(), self.result)
        for value, purpose in zip((self.intent, self.permit, self.result), PURPOSES):
            with self.subTest(purpose=purpose):
                wire = control.seal_control(value, self.encrypt, self.sign, purpose=purpose)
                self.assertLessEqual(len(wire), 8192)
                self.assertEqual(self.open(wire, purpose), value)
                self.assertNotIn(crypto.canonical(value), wire)
                self.assertEqual(crypto.open_envelope(wire, self.decrypt, self.verify, purpose=purpose),
                                 crypto.canonical(value))
        self.assertIs(self.validate_result()["transport"]["authorizes_upload"], False)

    def test_all_event_channel_pairs_and_nonrelease_operations(self):
        accepted = {("push", "beta"), ("schedule", "nightly"), ("workflow_dispatch", "beta"),
                    ("workflow_dispatch", "rc"), ("workflow_dispatch", "nightly")}
        for event in ("push", "schedule", "workflow_dispatch", "dispatch", "pull_request"):
            for channel in ("beta", "rc", "nightly", "stable"):
                value = changed(changed(self.intent, ("execution", "event"), event), ("public", "channel"), channel)
                with self.subTest(event=event, channel=channel):
                    if (event, channel) in accepted:
                        self.assertEqual(control.validate_intent(value, self.limits), value)
                    else:
                        self.rejected(lambda: control.validate_intent(value, self.limits))
        for operation in ("build", "rebuild", "closed-rebuild", "stable", "validate"):
            value = changed(self.intent, ("execution", "operation"), operation)
            self.rejected(lambda: control.validate_intent(value, self.limits))

    def test_repository_workflow_worker_and_object_identity_are_fixed(self):
        cases = (("repository", "other/project"), ("repository_id", "1414876450"),
                 ("repository_owner_id", "307715256"), ("repository_id", 1414876449),
                 ("workflow_ref", self.intent["execution"]["workflow_ref"].replace("main", "other")),
                 ("worker_job", "closed_rebuild / package"), ("run_id", 12),
                 ("run_id", "0"), ("run_attempt", "01"), ("run_attempt", "2" * 21),
                 ("source_sha", "b" * 39), ("source_sha", "B" * 40))
        for key, value in cases:
            with self.subTest(field=key, value=value):
                self.rejected(lambda: control.validate_intent(changed(self.intent, ("execution", key), value), self.limits))
        for object_name in ("fixture/12-1.candidate.json", "other/12-2.candidate.json", "../candidate", MARKER):
            self.rejected(lambda: control.validate_intent(changed(self.intent, ("candidate", "object"), object_name), self.limits))

    def rebuild_records(self):
        intent = copy.deepcopy(self.intent)
        intent["execution"].update(operation="closed-rebuild", worker_job="closed_rebuild / package")
        # The published source/run are deliberately distinct from current execution.
        intent["public"]["context_sha256"] = sha({"mode": "published", "release_tag": "v1.3.1",
            "source_sha": "a" * 40, "run_id": "7", "run_attempt": "1"})
        wire, permit = self.rebind_intent(intent)
        permit_wire = self.raw_seal(permit, PURPOSES[1])
        result = copy.deepcopy(self.result)
        result.update(intent_envelope_sha256=crypto.digest(wire),
                      permit_envelope_sha256=crypto.digest(permit_wire), permit_record_sha256=sha(permit))
        return intent, wire, permit, permit_wire, result

    def test_rebuild_variant_requires_exact_dispatch_job_and_original_plan_channel(self):
        intent, _, _, _, _ = self.rebuild_records()
        for event in ("push", "schedule", "workflow_dispatch", "pull_request", "dispatch"):
            for channel in ("beta", "rc", "nightly", "stable"):
                value = changed(changed(intent, ("execution", "event"), event), ("public", "channel"), channel)
                with self.subTest(event=event, channel=channel):
                    if event == "workflow_dispatch" and channel in {"beta", "rc", "nightly"}:
                        self.assertEqual(control.validate_intent(value, self.limits), value)
                    else:
                        self.rejected(lambda: control.validate_intent(value, self.limits))
        for operation, job in (("release", "closed_rebuild / package"),
                               ("closed-rebuild", "closed_build / package"),
                               ("rebuild", "closed_rebuild / package"),
                               ("closed-rebuild", "closed_existing_resolve")):
            value = copy.deepcopy(intent)
            value["execution"].update(operation=operation, worker_job=job)
            self.rejected(lambda: control.validate_intent(value, self.limits))

    def test_rebuild_roundtrips_and_cannot_substitute_for_release_or_published_context(self):
        intent, wire, permit, permit_wire, result = self.rebuild_records()
        self.assertEqual(self.validate_permit(permit, intent=intent, wire=wire), permit)
        self.assertEqual(self.validate_result(result, intent=intent, intent_wire=wire,
                         permit=permit, permit_wire=permit_wire), result)
        for value, purpose in zip((intent, permit, result), PURPOSES):
            sealed = control.seal_control(value, self.encrypt, self.sign, purpose=purpose)
            self.assertEqual(self.open(sealed, purpose), value)
        # Valid record shapes do not allow one operation's authority to cross over.
        self.rejected(lambda: self.validate_permit(intent=intent, wire=wire))
        self.rejected(lambda: self.validate_permit(permit))
        self.rejected(lambda: self.validate_result(result))
        self.rejected(lambda: self.validate_result(intent=intent, intent_wire=wire,
                                                   permit=permit, permit_wire=permit_wire))
        for field in ("plan_sha256", "context_sha256"):
            substituted = changed(intent, ("public", field), sha("other published context"))
            self.assertEqual(control.validate_intent(substituted, self.limits), substituted)
            self.rejected(lambda: self.validate_permit(permit, intent=substituted, wire=wire))

    def test_rebuild_preserves_current_execution_and_candidate_bindings(self):
        intent, wire, permit, _, _ = self.rebuild_records()
        for path, value in ((("execution", "repository_id"), "1414876450"),
                            (("execution", "repository_owner_id"), "307715256"),
                            (("execution", "workflow_ref"), MARKER),
                            (("execution", "run_id"), "7"),
                            (("execution", "run_attempt"), "1"),
                            (("candidate", "object"), "fixture/7-1.candidate.json"),
                            (("public", "context_sha256"), "")):
            with self.subTest(path=path):
                self.rejected(lambda: control.validate_intent(changed(intent, path, value), self.limits))
        for path, value in ((("execution", "source_sha"), "a" * 40),
                            (("candidate", "attempt_id"), "another-attempt"),
                            (("candidate", "output_capability_sha256"), sha("other capability")),
                            (("candidate", "request_target_sha256"), sha("other target")),
                            (("input_sha256",), sha("other input"))):
            with self.subTest(path=path):
                self.rejected(lambda: self.validate_permit(permit, intent=changed(intent, path, value), wire=wire))

    def test_rebuild_preserves_expiry_capacity_destination_and_ledger_checks(self):
        intent, wire, permit, permit_wire, result = self.rebuild_records()
        self.rejected(lambda: self.validate_permit(permit, intent=intent, wire=wire,
                                                  now=permit["expires_at"]))
        for path, value in ((("capacity", "policy_sha256"), sha("other policy")),
                            (("capacity", "observed_at"), NOW - 31),
                            (("destination", "bucket_fingerprint"), sha("other bucket")),
                            (("ledger", "candidate_attempt_id"), "other-attempt"),
                            (("ledger", "checkpoint", "generation"), 4097),
                            (("ledger", "checkpoint", "scope_fingerprint"), sha("other scope"))):
            with self.subTest(path=path):
                self.rejected(lambda: self.validate_permit(changed(permit, path, value), intent=intent, wire=wire))
        with patch.object(time, "time", side_effect=AssertionError("Implicit clock forbidden")):
            self.assertEqual(self.validate_result(result, intent=intent, intent_wire=wire,
                             permit=permit, permit_wire=permit_wire), result)
        self.assertIs(result["transport"]["authorizes_upload"], False)

    def test_permit_binds_record_fields_even_when_replacements_are_well_formed(self):
        cases = (("execution", "source_sha", "c" * 40), ("public", "plan_sha256", sha("different plan")),
                 ("public", "context_sha256", sha("different context")), ("public", "channel", "beta"),
                 ("candidate", "ciphertext_sha256", sha("other ciphertext")),
                 ("candidate", "output_capability_sha256", sha("other capability")),
                 ("candidate", "request_target_sha256", sha("other target")),
                 ("candidate", "bytes", len(DATA) + 1), ("candidate", "attempt_id", "other-attempt"))
        for parent, key, replacement in cases:
            value = changed(self.intent, (parent, key), replacement)
            with self.subTest(field=(parent, key)):
                self.assertEqual(control.validate_intent(value, self.limits), value)
                self.rejected(lambda: self.validate_permit(intent=value))
        for key, replacement in (("input_sha256", sha("other input")), ("nonce", "c" * 32),
                                  ("created_at", NOW - 3)):
            self.rejected(lambda: self.validate_permit(intent=changed(self.intent, (key,), replacement)))

    def test_exact_envelope_bytes_and_canonical_intent_hash_are_distinct_bindings(self):
        alternate = self.raw_seal(self.intent, PURPOSES[0])
        self.assertNotEqual(alternate, self.intent_wire)
        self.assertEqual(self.open(alternate, PURPOSES[0]), self.intent)
        self.rejected(lambda: self.validate_permit(wire=alternate))
        self.rejected(lambda: self.validate_permit(wire=self.intent_wire + b" "))
        for field in ("intent_envelope_sha256", "intent_record_sha256"):
            self.rejected(lambda: self.validate_permit(changed(self.permit, (field,), sha("different"))))
        self.rejected(lambda: self.validate_permit(changed(self.permit, ("intent_record_sha256",),
                                                          crypto.digest(self.intent_wire))))

    def test_permit_attempt_destination_and_checkpoint_consistency(self):
        cases = ((("ledger", "candidate_attempt_id"), "other-attempt"),
                 (("destination", "scope_fingerprint"), sha("other scope")),
                 (("destination", "bucket_fingerprint"), sha("other bucket")),
                 (("destination", "object_fingerprint"), sha("other object")),
                 (("ledger", "checkpoint", "scope_fingerprint"), sha("other scope")),
                 (("ledger", "checkpoint", "generation"), 0),
                 (("ledger", "checkpoint", "generation"), True),
                 (("ledger", "checkpoint", "schema"), True),
                 (("ledger", "checkpoint", "schema"), 2),
                 (("ledger", "checkpoint", "kind"), "other-checkpoint"),
                 (("ledger", "checkpoint", "state_sha256"), "invalid"),
                 (("ledger", "checkpoint", "operation_receipt_sha256"), "A" * 64),
                 (("ledger", "checkpoint", "operation_id"), "contains spaces"),
                 (("ledger", "candidate_claim_id"), ""))
        for path, value in cases:
            with self.subTest(path=path, value=value):
                self.rejected(lambda: self.validate_permit(changed(self.permit, path, value)))

    def test_well_formed_external_anchors_are_assertions_not_provenance(self):
        intent = changed(self.intent, ("execution", "source_sha"), "c" * 40)
        wire, permit = self.rebind_intent(intent)
        scope, bucket = sha("another scope"), sha("another bucket")
        permit["destination"] = {"scope_fingerprint": scope, "bucket_fingerprint": bucket,
            "object_fingerprint": sha(["closed-object-v1", scope, bucket, intent["candidate"]["object"]])}
        permit["ledger"]["checkpoint"].update(scope_fingerprint=scope, ledger_id="other-ledger",
            state_sha256=sha("different state"), operation_receipt_sha256=sha("different receipt"))
        permit["capacity"].update(evidence_sha256=sha("different evidence"),
                                  snapshot_sha256=sha("different snapshot"), assessment_sha256=sha("different assessment"))
        self.assertEqual(self.validate_permit(permit, intent=intent, wire=wire), permit)

    def test_supplied_four_field_policy_is_bound_in_permit_and_result(self):
        wrong = changed(self.permit, ("capacity", "policy_sha256"), sha("other policy"))
        self.rejected(lambda: self.validate_permit(wrong))
        self.rejected(lambda: self.validate_result(permit=wrong))
        for field in self.limits:
            limits = dict(self.limits, **{field: self.limits[field] - 1})
            with self.subTest(field=field):
                self.rejected(lambda: self.validate_permit(limits=limits))
                self.rejected(lambda: self.validate_result(limits=limits))
        limits = dict(self.limits, candidate_max_bytes=self.limits["candidate_max_bytes"] - 1)
        rebound = changed(self.permit, ("capacity", "policy_sha256"), sha(limits))
        self.assertEqual(self.validate_permit(rebound, limits=limits), rebound)
        self.rejected(lambda: self.validate_result(permit=rebound, limits=limits))
        rebound_wire = self.raw_seal(rebound, PURPOSES[1])
        rebound_result = changed(self.result, ("permit_envelope_sha256",), crypto.digest(rebound_wire))
        rebound_result["permit_record_sha256"] = sha(rebound)
        self.assertEqual(self.validate_result(rebound_result, permit=rebound,
            permit_wire=rebound_wire, limits=limits), rebound_result)
        self.rejected(lambda: self.validate_result(rebound_result, permit=rebound, permit_wire=rebound_wire))
        # Envelope helpers validate structure, not policy provenance or clock freshness.
        wire = control.seal_control(wrong, self.encrypt, self.sign, purpose=PURPOSES[1])
        self.assertEqual(self.open(wire, PURPOSES[1]), wrong)

    def test_freshness_has_no_future_tolerance_and_exact_boundaries(self):
        exact = copy.deepcopy(self.permit)
        exact["capacity"]["observed_at"] = NOW
        exact["expires_at"] = NOW + 30
        self.assertEqual(self.validate_permit(exact, now=NOW), exact)
        self.assertEqual(self.validate_permit(exact, now=NOW + 29), exact)
        self.rejected(lambda: self.validate_permit(exact, now=NOW - 1))
        self.rejected(lambda: self.validate_permit(exact, now=NOW + 30))
        self.rejected(lambda: self.validate_permit(changed(exact, ("expires_at",), NOW + 31)))
        self.rejected(lambda: self.validate_permit(changed(exact, ("issued_at",), NOW + 1)))
        self.rejected(lambda: self.validate_permit(changed(exact, ("capacity", "observed_at"), NOW + 1)))
        self.rejected(lambda: self.validate_permit(changed(exact, ("capacity", "observed_at"), NOW - 1)))
        for age, accept in ((120, True), (121, False), (-1, False)):
            intent = changed(self.intent, ("created_at",), NOW - age)
            wire, permit = self.rebind_intent(intent)
            with self.subTest(wait_age=age):
                if accept:
                    self.assertEqual(self.validate_permit(permit, intent=intent, wire=wire), permit)
                else:
                    self.rejected(lambda: self.validate_permit(permit, intent=intent, wire=wire))
        for now in (True, 0, float(NOW), float("nan"), float("inf")):
            self.rejected(lambda: self.validate_permit(now=now))

    def test_result_remains_valid_after_expiry_without_enabling_a_new_put(self):
        with patch.object(time, "time", side_effect=AssertionError("Implicit clock forbidden")):
            self.assertEqual(self.validate_result(), self.result)
            self.rejected(lambda: self.validate_permit(now=NOW + 1000))
            self.assertEqual(self.open(self.permit_wire, PURPOSES[1]), self.permit)
        for status in (200, 201, 204):
            self.assertEqual(self.validate_result(changed(self.result, ("transport", "status"), status))["transport"]["status"], status)
        missing = copy.deepcopy(self.result)
        missing["transport"].update(version_id=None, etag=None, md5=None)
        self.assertEqual(self.validate_result(missing), missing)
        opened = self.open(control.seal_control(missing, self.encrypt, self.sign, purpose=PURPOSES[2]), PURPOSES[2])
        self.assertIsNone(opened["transport"]["version_id"])
        self.assertIs(opened["transport"]["authorizes_upload"], False)

    def test_result_binds_both_wires_and_exact_transport_attempt_target_body(self):
        for field in ("intent_envelope_sha256", "permit_envelope_sha256", "permit_record_sha256"):
            self.rejected(lambda: self.validate_result(changed(self.result, (field,), sha("wrong wire"))))
        self.rejected(lambda: self.validate_result(intent_wire=self.raw_seal(self.intent, PURPOSES[0])))
        self.rejected(lambda: self.validate_result(permit_wire=self.raw_seal(self.permit, PURPOSES[1])))
        for field, value in (("attempt_id", "other-attempt"), ("request_target_sha256", sha("other target")),
                             ("ciphertext_sha256", sha("other bytes")), ("bytes", len(DATA) + 1),
                             ("status", 202), ("status", 412), ("status", True),
                             ("authorizes_upload", True), ("authorizes_upload", 0)):
            with self.subTest(field=field, value=value):
                self.rejected(lambda: self.validate_result(changed(self.result, ("transport", field), value)))

    def test_result_binds_the_canonical_permit_record_as_well_as_its_wire(self):
        altered = changed(self.permit, ("ledger", "checkpoint", "state_sha256"), sha("another valid state"))
        self.assertEqual(self.validate_permit(altered), altered)
        # A valid-looking external anchor still changes the signed permit record.
        self.rejected(lambda: self.validate_result(permit=altered))
        altered_wire = self.raw_seal(altered, PURPOSES[1])
        rebound = changed(self.result, ("permit_envelope_sha256",), crypto.digest(altered_wire))
        self.rejected(lambda: self.validate_result(rebound, permit=altered, permit_wire=altered_wire))
        rebound["permit_record_sha256"] = sha(altered)
        self.assertEqual(self.validate_result(rebound, permit=altered, permit_wire=altered_wire), rebound)
        missing = {key: value for key, value in self.result.items() if key != "permit_record_sha256"}
        for invalid in (missing, changed(self.result, ("permit_record_sha256",), "invalid"),
                        changed(self.result, ("permit_record_sha256",), True)):
            self.rejected(lambda: self.validate_result(invalid))
            self.rejected(lambda: control.seal_control(invalid, self.encrypt, self.sign, purpose=PURPOSES[2]))
            wire = self.raw_seal(invalid, PURPOSES[2])
            self.rejected(lambda: self.open(wire, PURPOSES[2]))

    def test_result_transport_metadata_is_strict_bounded_and_opaque(self):
        for field in ("version_id", "etag"):
            for value in ("", " padded", "padded ", " ", "x" * 1025, "line\nbreak", "\u00e9", True):
                with self.subTest(field=field, value=value):
                    self.rejected(lambda: self.validate_result(changed(self.result, ("transport", field), value)))
            accepted = changed(self.result, ("transport", field), '"Mixed_Case-Value"')
            self.assertEqual(self.validate_result(accepted)["transport"][field], '"Mixed_Case-Value"')
        for value in ("", "invalid", crypto.b64(b"short"), self.result["transport"]["md5"] + "\n"):
            self.rejected(lambda: self.validate_result(changed(self.result, ("transport", "md5"), value)))

    def test_purpose_separation_and_no_v1_fallback(self):
        records = (self.intent, self.permit, self.result)
        for index, value in enumerate(records):
            for other_index, purpose in enumerate(PURPOSES):
                if index == other_index:
                    continue
                with self.subTest(source=PURPOSES[index], target=purpose):
                    self.rejected(lambda: self.open(self.raw_seal(value, PURPOSES[index]), purpose))
                    self.rejected(lambda: self.open(self.raw_seal(value, purpose), purpose))
                    self.rejected(lambda: control.seal_control(value, self.encrypt, self.sign, purpose=purpose))
        for legacy in ("upload-intent", "upload-permit", "input", "candidate", "unknown"):
            self.rejected(lambda: control.seal_control(self.intent, self.encrypt, self.sign, purpose=legacy))
            self.rejected(lambda: self.open(self.intent_wire, legacy))
        v1 = {"schema": 1, "kind": "closed-upload-intent", "request_id": "fixture"}
        self.rejected(lambda: self.open(self.raw_seal(v1, PURPOSES[0]), PURPOSES[0]))
        legacy_wire = self.raw_seal(self.intent, "upload-intent")
        self.rejected(lambda: self.open(legacy_wire, PURPOSES[0]))

    def test_real_wrong_signer_recipient_and_ciphertext_tampering_reject(self):
        other_sign, other_verify, other_decrypt, other_encrypt = keys()
        self.rejected(lambda: control.open_control(self.intent_wire, self.decrypt, other_verify, purpose=PURPOSES[0]))
        self.rejected(lambda: control.open_control(self.intent_wire, other_decrypt, self.verify, purpose=PURPOSES[0]))
        wrong_signer = crypto.seal(crypto.canonical(self.intent), self.encrypt, other_sign, purpose=PURPOSES[0])
        self.rejected(lambda: self.open(wrong_signer, PURPOSES[0]))
        wrong_recipient = crypto.seal(crypto.canonical(self.intent), other_encrypt, self.sign, purpose=PURPOSES[0])
        self.rejected(lambda: self.open(wrong_recipient, PURPOSES[0]))
        parsed = crypto.decode_json(self.intent_wire)
        ciphertext = bytearray(crypto.unb64(parsed["ciphertext"]))
        ciphertext[0] ^= 1
        parsed["ciphertext"] = crypto.b64(bytes(ciphertext))
        self.rejected(lambda: self.open(crypto.canonical(parsed), PURPOSES[0]))

    def test_invalid_keys_are_rejected_before_envelope_crypto(self):
        alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
        noncanonical = self.encrypt[:-2] + alphabet[alphabet.index(self.encrypt[-2]) + 1] + "="
        invalid = (None, True, self.encrypt.encode(), "", "x" * 45, "_" * 44,
                   crypto.b64(b"x" * 31), crypto.b64(b"x" * 33), noncanonical)
        for key in invalid:
            with self.subTest(type=type(key).__name__, length=len(key) if hasattr(key, "__len__") else None), \
                 patch.object(crypto, "seal") as seal, patch.object(crypto, "open_envelope") as open_envelope:
                self.rejected(lambda: control.seal_control(self.intent, key, self.sign, purpose=PURPOSES[0]))
                self.rejected(lambda: control.seal_control(self.intent, self.encrypt, key, purpose=PURPOSES[0]))
                self.rejected(lambda: control.open_control(self.intent_wire, key, self.verify, purpose=PURPOSES[0]))
                self.rejected(lambda: control.open_control(self.intent_wire, self.decrypt, key, purpose=PURPOSES[0]))
                seal.assert_not_called()
                open_envelope.assert_not_called()

    def test_checkpoint_generation_matches_the_durable_ledger_bound(self):
        boundary = changed(self.permit, ("ledger", "checkpoint", "generation"), 4096)
        self.assertEqual(self.validate_permit(boundary), boundary)
        wire = control.seal_control(boundary, self.encrypt, self.sign, purpose=PURPOSES[1])
        self.assertEqual(self.open(wire, PURPOSES[1]), boundary)
        result = changed(self.result, ("permit_envelope_sha256",), crypto.digest(wire))
        result["permit_record_sha256"] = sha(boundary)
        self.assertEqual(self.validate_result(result, permit=boundary, permit_wire=wire), result)
        for generation in (4097, 0, True):
            with self.subTest(generation=generation):
                value = changed(self.permit, ("ledger", "checkpoint", "generation"), generation)
                self.rejected(lambda: self.validate_permit(value))
                self.rejected(lambda: control.seal_control(value, self.encrypt, self.sign, purpose=PURPOSES[1]))
                wire = self.raw_seal(value, PURPOSES[1])
                self.rejected(lambda: self.open(wire, PURPOSES[1]))

    def test_exact_plaintext_and_wire_bounds_use_real_encryption(self):
        self.assertEqual(control.PLAINTEXT_MAX, 5600)
        self.assertEqual(control.CONTROL_MAX, 8192)
        plain = crypto.canonical(self.intent)
        for length in (5600, 5601):
            wire = self.raw_seal(plain + b" " * (length - len(plain)), PURPOSES[0])
            self.assertLessEqual(len(wire), 8192)
            if length == 5600:
                self.assertEqual(self.open(wire, PURPOSES[0]), self.intent)
            else:
                self.rejected(lambda: self.open(wire, PURPOSES[0]))
        boundary = self.intent_wire + b" " * (8192 - len(self.intent_wire))
        self.assertEqual(len(boundary), 8192)
        self.assertEqual(self.open(boundary, PURPOSES[0]), self.intent)
        self.rejected(lambda: self.open(boundary + b" ", PURPOSES[0]))
        for value in (b"", bytearray(self.intent_wire), memoryview(self.intent_wire), MARKER, None):
            self.rejected(lambda: self.open(value, PURPOSES[0]))

    def test_duplicate_keys_nonfinite_and_excessive_nesting_reject_after_authentication(self):
        plain = crypto.canonical(self.intent)
        malformed = [plain.replace(b'"schema":2', b'"schema":2,"schema":2', 1),
                     plain.replace(b'"run_id":"12"', b'"run_id":"12","run_id":"12"', 1)]
        for token in (b"NaN", b"Infinity", b"-Infinity"):
            malformed.append(plain.replace(b'"bytes":' + str(len(DATA)).encode(), b'"bytes":' + token, 1))
        malformed.extend((b"[" * 1000 + b"0" + b"]" * 1000, b"{}", b"null", b"[]"))
        for raw in malformed:
            with self.subTest(prefix=raw[:24]):
                wire = self.raw_seal(raw, PURPOSES[0])
                self.rejected(lambda: self.open(wire, PURPOSES[0]))

    def test_strict_record_shapes_types_and_integer_boolean_separation(self):
        for value, purpose in zip((self.intent, self.permit, self.result), PURPOSES):
            candidates = [dict(value, extra=MARKER), changed(value, ("schema",), True),
                          changed(value, ("schema",), 1), {key: item for key, item in value.items() if key != "kind"}]
            for bad in candidates:
                self.rejected(lambda: control.seal_control(bad, self.encrypt, self.sign, purpose=purpose))
                self.rejected(lambda: self.open(self.raw_seal(bad, purpose), purpose))
        for path in (("execution",), ("public",), ("candidate",)):
            value = changed(self.intent, path, {**self.intent[path[0]], "unknown": MARKER})
            self.rejected(lambda: control.validate_intent(value, self.limits))
        for path in (("destination",), ("ledger",), ("capacity",), ("ledger", "checkpoint")):
            node = self.permit
            for key in path:
                node = node[key]
            self.rejected(lambda: self.validate_permit(changed(self.permit, path, {**node, "unknown": MARKER})))
        self.rejected(lambda: self.validate_result(changed(self.result, ("transport",),
                                                         {**self.result["transport"], "unknown": MARKER})))
        for path in (("created_at",), ("candidate", "bytes")):
            for value in (True, 0, -1, 1.5, float("nan"), float("inf"), 2**63):
                self.rejected(lambda: control.validate_intent(changed(self.intent, path, value), self.limits))
        self.rejected(lambda: control.validate_intent(changed(self.intent, ("candidate", "bytes"), 1024**2 + 1), self.limits))

    def test_limits_reject_unknown_missing_boolean_and_protocol_overflow(self):
        invalid = [dict(self.limits, unknown=True), {key: value for key, value in self.limits.items() if key != "wait_seconds"}]
        for key in self.limits:
            for value in (True, 0, -1, 1.5, control.MAX_LIMITS[key] + 1):
                invalid.append(dict(self.limits, **{key: value}))
        for limits in invalid:
            self.rejected(lambda: control.validate_intent(self.intent, limits))
            self.rejected(lambda: self.validate_permit(limits=limits))
            self.rejected(lambda: self.validate_result(limits=limits))

    def test_recursive_oversized_and_non_json_inputs_fail_safely(self):
        cyclic = {}
        cyclic["cycle"] = cyclic
        deep = {}
        for _ in range(20):
            deep = {"nested": deep}
        for value in (cyclic, deep, {"items": list(range(257))}, {"text": MARKER * 1000},
                      {"unknown": object()}, {1: "nonstring key"}, (), None):
            self.rejected(lambda: control.validate_intent(value, self.limits))
            self.rejected(lambda: control.seal_control(value, self.encrypt, self.sign, purpose=PURPOSES[0]))

    def test_returned_records_are_deeply_detached(self):
        for original, validator, path in ((self.intent, lambda item: control.validate_intent(item, self.limits), ("candidate", "attempt_id")),
                                           (self.permit, self.validate_permit, ("ledger", "checkpoint", "ledger_id")),
                                           (self.result, self.validate_result, ("transport", "version_id"))):
            source = copy.deepcopy(original)
            result = validator(source)
            node = source
            for key in path[:-1]:
                node = node[key]
            node[path[-1]] = MARKER
            self.assertEqual(result, original)
            self.assertIsNot(result, source)
        first = self.open(self.permit_wire, PURPOSES[1])
        first["ledger"]["checkpoint"]["ledger_id"] = MARKER
        self.assertEqual(self.open(self.permit_wire, PURPOSES[1]), self.permit)

    def test_all_public_errors_clear_active_caller_exception_context(self):
        operations = (
            lambda: control.validate_intent(dict(self.intent, unknown=MARKER), self.limits),
            lambda: self.validate_permit(changed(self.permit, ("intent_record_sha256",), sha("wrong"))),
            lambda: self.validate_result(changed(self.result, ("transport", "attempt_id"), "different")),
            lambda: control.seal_control(self.intent, MARKER, self.sign, purpose=PURPOSES[0]),
            lambda: control.open_control(self.intent_wire, self.decrypt, MARKER, purpose=PURPOSES[0]),
        )
        for operation in operations:
            try:
                raise ValueError(MARKER)
            except ValueError:
                self.rejected(operation)


if __name__ == "__main__":
    unittest.main()
