#!/usr/bin/env python3
"""Closed transport, confinement, exact composition and non-disclosure tests."""
import contextlib
import copy
from types import SimpleNamespace
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

import closed_build as build
import closed_envelope as envelope
import closed_synthetic

MARKER = "FICTIONAL_CLOSED_CANARY_NEVER_PUBLIC_93f8"


def keys():
    signer, recipient = Ed25519PrivateKey.generate(), X25519PrivateKey.generate()
    return (envelope.b64(signer.private_bytes_raw()), envelope.b64(signer.public_key().public_bytes_raw()),
            envelope.b64(recipient.private_bytes_raw()), envelope.b64(recipient.public_key().public_bytes_raw()))


def archive(files, member_type=None):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz", format=tarfile.USTAR_FORMAT) as packed:
        for name, data in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            if member_type:
                member.type, member.linkname = member_type, "/tmp/escape"
            packed.addfile(member, io.BytesIO(data))
    return buffer.getvalue()


class EnvelopeTests(unittest.TestCase):
    def setUp(self):
        self.sign, self.verify, self.decrypt, self.encrypt = keys()

    def test_authenticated_roundtrip(self):
        wire = envelope.seal(MARKER.encode(), self.encrypt, self.sign, purpose="input")
        self.assertNotIn(MARKER.encode(), wire)
        self.assertEqual(envelope.open_envelope(wire, self.decrypt, self.verify, purpose="input"), MARKER.encode())

    def test_signature_tampering_wrong_keys_and_purpose(self):
        wire = envelope.seal(b"data", self.encrypt, self.sign, purpose="input")
        other = keys()
        for decrypt, verify, purpose in ((other[2], self.verify, "input"),
                                         (self.decrypt, other[1], "input"),
                                         (self.decrypt, self.verify, "candidate")):
            with self.assertRaises(Exception):
                envelope.open_envelope(wire, decrypt, verify, purpose=purpose)
        changed = json.loads(wire)
        changed["ciphertext"] = envelope.b64(b"corrupted")
        with self.assertRaises(Exception):
            envelope.open_envelope(envelope.canonical(changed), self.decrypt, self.verify, purpose="input")

    def test_nonce_and_ephemeral_are_fresh(self):
        a, b = [json.loads(envelope.seal(b"same", self.encrypt, self.sign, purpose="input")) for _ in range(2)]
        self.assertNotEqual(a["ephemeral"], b["ephemeral"])
        self.assertNotEqual(a["nonce"], b["nonce"])

    def test_duplicate_json_fields_rejected(self):
        with self.assertRaises(ValueError):
            envelope.decode_json(b'{"schema":1,"schema":2}')

    def test_hosted_fixture_generator_keeps_file_canary_encrypted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, value in (("encrypt", self.encrypt), ("sign", self.sign), ("canary", MARKER)):
                (root / name).write_text(value)
            (root / "context").write_bytes(envelope.canonical({"source_sha": "a" * 40, "plan_sha256": "b" * 64, "payloads": {}}))
            args = SimpleNamespace(context=root / "context", request_id="fixture", canary_file=root / "canary",
                                   encrypt_key_file=root / "encrypt", sign_key_file=root / "sign", output=root / "envelope", mode="timeout")
            closed_synthetic.create(args)
            wire = args.output.read_bytes()
            self.assertNotIn(MARKER.encode(), wire)
            plain = envelope.open_envelope(wire, self.decrypt, self.verify, purpose="input")
            with tarfile.open(fileobj=io.BytesIO(plain), mode="r:gz") as packed:
                manifest = json.load(packed.extractfile("closed-build.json"))
                self.assertEqual(manifest["worker_timeout_seconds"], 2)
                self.assertEqual(manifest["build_mode"], "package-only")


class BoundaryTests(unittest.TestCase):
    def test_public_artifact_binds_digest_source_producer_and_attempt(self):
        content = io.BytesIO()
        with zipfile.ZipFile(content, "w") as zipped:
            zipped.writestr("public.txt", "public bytes")
        data = content.getvalue()
        run = {"run_attempt": 2, "head_sha": "a" * 40, "path": build.WORKFLOW, "head_branch": "main"}
        job = {"name": "prepare", "conclusion": "success", "started_at": "2026-01-01T01:00:00Z", "completed_at": "2026-01-01T01:00:30Z"}
        artifact = {"id": 3, "name": "plan", "expired": False, "workflow_run": {"id": 10, "head_sha": "a" * 40},
                    "created_at": "2026-01-01T01:00:10Z", "size_in_bytes": len(data), "digest": "sha256:" + envelope.digest(data)}
        class GitHub:
            def api(self, path): return self.run
            def pages(self, path, field): return [self.job] if field == "jobs" else [self.artifact]
            def binary(self, path): return data
        for changed in (None, "attempt", "source", "producer", "digest", "expired", "old-time", "run-id"):
            gh = GitHub()
            gh.run, gh.job, gh.artifact = copy.deepcopy((run, job, artifact))
            if changed == "attempt": gh.run["run_attempt"] = 1
            if changed == "source": gh.artifact["workflow_run"]["head_sha"] = "b" * 40
            if changed == "producer": gh.job["name"] = "untrusted"
            if changed == "digest": gh.artifact["digest"] = "sha256:" + "f" * 64
            if changed == "expired": gh.artifact["expired"] = True
            if changed == "old-time": gh.artifact["created_at"] = gh.job["started_at"]
            if changed == "run-id": gh.artifact["workflow_run"]["id"] = 9
            with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"GITHUB_RUN_ID": "10", "GITHUB_RUN_ATTEMPT": "2", "GITHUB_SHA": "a" * 40}):
                if changed:
                    with self.assertRaises(build.Rejected):
                        build.download_artifact(gh, "plan", Path(directory), producer=lambda name: name == "prepare")
                else:
                    build.download_artifact(gh, "plan", Path(directory), producer=lambda name: name == "prepare")
                    self.assertEqual((Path(directory) / "public.txt").read_text(), "public bytes")

    def test_encrypted_host_roundtrip_and_private_failure(self):
        operator_sign, operator_verify, ci_decrypt, ci_encrypt = keys()
        worker_sign, worker_verify, deploy_decrypt, deploy_encrypt = keys()
        context = {"repository": build.REPOSITORY, "workflow": build.WORKFLOW,
                   "source_sha": "b" * 40, "plan_sha256": "c" * 64, "payloads": {},
                   "run_id": "10", "run_attempt": "1", "mode": "prospective",
                   "release_tag": "v1.2.3-rc.1"}
        lock = {"repository": "https://github.com/ha-homelab/home-studio.git", "commit": "a" * 40}
        files = {"scripts/closed-build-entry.py": MARKER.encode(), "public-core.lock.json": envelope.canonical(lock)}
        manifest = {"schema": 1, "request_id": "fictional", "entrypoint": "scripts/closed-build-entry.py",
                    "acceptance_policy": "ha-home-python-v1", "build_mode": "rebuild-preserve",
                    "worker_image": build.policy()["worker_image"], "original_core_lock": lock,
                    "target": {key: context[key] for key in ("source_sha", "plan_sha256", "payloads")},
                    "files": {name: envelope.digest(data) for name, data in files.items()}}
        files["closed-build.json"] = envelope.canonical(manifest)
        sealed_input = envelope.seal(archive(files), ci_encrypt, operator_sign, purpose="input")
        environment = {"GITHUB_REPOSITORY": build.REPOSITORY, "GITHUB_REPOSITORY_ID": build.REPOSITORY_ID,
                       "GITHUB_REPOSITORY_OWNER_ID": build.OWNER_ID, "GITHUB_REF": "refs/heads/main",
                       "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_WORKFLOW_REF": build.REPOSITORY + "/" + build.WORKFLOW + "@refs/heads/main",
                       "RUNNER_ENVIRONMENT": "github-hosted", "GITHUB_RUN_ID": "10", "GITHUB_RUN_ATTEMPT": "1",
                       "GITHUB_SHA": "b" * 40,
                       "CLOSED_INPUT_READ_URL": "https://storage.invalid/input", "CLOSED_OUTPUT_WRITE_URL": "https://storage.invalid/output/",
                       "CLOSED_INPUT_DECRYPT_KEY": ci_decrypt, "CLOSED_INPUT_VERIFY_KEY": operator_verify,
                       "CLOSED_OUTPUT_ENCRYPT_KEY": deploy_encrypt, "CLOSED_OUTPUT_SIGN_KEY": worker_sign}
        def public_inputs(args, temporary):
            public = temporary / "public"
            (public / "component").mkdir(parents=True)
            (public / "component/core.py").write_bytes(b"public immutable")
            (public / "source/scripts").mkdir(parents=True)
            (public / "source/scripts/install-home-assistant.py").write_bytes(b"trusted public installer")
            return context, public
        def worker(image, source, public, output, context_dir, log, *, timeout):
            output.mkdir()
            (output / "home-package.tar.gz").write_bytes(archive({"custom_components/home_floorplan/core.py": b"public immutable",
                                                                 "custom_components/home_floorplan/site.json": b"{}"}))
            (output / "acceptance.json").write_bytes(envelope.canonical({"schema": 1, "passed": True, "checks": ["package", "site-contracts", "geometry"]}))
            log.write_text(MARKER)
        for fail, request in ((False, "fictional"), (True, "fictional"), (False, "")):
            stored = {}
            def transport(url, *, data=None, suffix=None, create_only=False):
                if data is None:
                    return sealed_input
                self.assertNotIn(MARKER.encode(), data)
                stored[suffix] = data
                return b""
            with tempfile.TemporaryDirectory() as directory:
                prepared = Path(directory)
                (prepared / "prepared.json").write_bytes(envelope.canonical(build.policy()))
                action = RuntimeError(MARKER) if fail else worker
                with patch.dict(os.environ, environment), patch.object(build, "public_inputs", side_effect=public_inputs), patch.object(build, "transport", side_effect=transport), patch.object(build, "run_worker", side_effect=action), contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
                    result = build.main(["--action", "build", "--closed-request", request, "--prepared-root", str(prepared)])
            self.assertNotIn(MARKER, out.getvalue() + err.getvalue())
            self.assertEqual(result, int(fail))
            candidates = [wire for name, wire in stored.items() if name.endswith(".candidate.json")]
            self.assertEqual(len(candidates), 0 if fail else 1)
            diagnostic = next(wire for name, wire in stored.items() if name.endswith(".diagnostic.json"))
            self.assertIn(MARKER.encode(), envelope.open_envelope(diagnostic, deploy_decrypt, worker_verify, purpose="diagnostic"))
            if not fail:
                candidate_tar = envelope.open_envelope(candidates[0], deploy_decrypt, worker_verify, purpose="candidate")
                with tarfile.open(fileobj=io.BytesIO(candidate_tar), mode="r:gz") as content:
                    self.assertEqual(content.extractfile("install-home-assistant.py").read(), b"trusted public installer")
                    candidate = json.load(content.extractfile("candidate.json"))
                    self.assertEqual(candidate["state"], "candidate")
                    self.assertEqual(candidate["public"], context)

    def test_delegation_pins_source_version_repo_channels_and_dependencies(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "scripts").mkdir()
            (root / "scripts/closed-build-entry.py").write_text("pass\n")
            lock = {"repository": "https://github.com/ha-homelab/home-studio.git", "commit": "a" * 40}
            (root / "public-core.lock.json").write_bytes(envelope.canonical(lock))
            context = {"source_sha": "b" * 40, "plan_sha256": "c" * 64, "payloads": {},
                       "base_version": "1.2.3", "channel": "rc", "repository_id": "1",
                       "repository_owner_id": "2", "dependencies": {"example": {"commit": "d" * 40}}}
            delegated = {key: context[key] for key in ("source_sha", "base_version", "repository_id", "repository_owner_id", "dependencies")}
            delegated["channels"] = ["beta", "rc"]
            manifest = {"schema": 1, "request_id": "test", "entrypoint": "scripts/closed-build-entry.py",
                        "acceptance_policy": "ha-home-python-v1", "build_mode": "rebuild-preserve", "worker_image": "image",
                        "target_policy": delegated, "original_core_lock": lock,
                        "files": {path.relative_to(root).as_posix(): envelope.digest(path.read_bytes()) for path in root.rglob("*") if path.is_file()}}
            (root / "closed-build.json").write_bytes(envelope.canonical(manifest))
            build.validate_input(root, context, "test", "image")
            with self.assertRaises(build.Rejected):
                build.validate_input(root, context, "different-request", "image")
            for field, value in (("source_sha", "e" * 40), ("base_version", "9.0.0"),
                                 ("channel", "stable"), ("repository_id", "3"), ("dependencies", {})):
                with self.assertRaises(build.Rejected):
                    build.validate_input(root, {**context, field: value}, "test", "image")

    def test_acceptance_keeps_source_and_closed_runs_distinct(self):
        public = {"repository": build.REPOSITORY, "workflow": build.WORKFLOW, "source_sha": "a" * 40,
                  "plan_sha256": "b" * 64, "payloads": {}, "run_id": "10", "run_attempt": "1", "release_tag": "v1.0.0-rc.1"}
        accepted = {"schema": 1, "state": "accepted", "request_id": "test", "acceptance_policy": "ha-home-python-v1",
                    "public": public, "candidate_sha256": "c" * 64, "payload_sha256": "d" * 64,
                    "installer_sha256": "e" * 64, "payload_size": 12, "installer_size": 10,
                    "build_run_id": "20", "build_run_attempt": "2", "candidate_object": "test/20-2.candidate.json",
                    "site_acceptance": {"schema": 1, "state": "site-canary-passed", "payload_sha256": "d" * 64,
                                        "checks": {"actual_ha": True, "browser": True}, "evidence_sha256": "e" * 64, "receipt_sha256": "f" * 64},
                    "qualification": {"status": "published", "conclusion": "success", "release_tag": public["release_tag"], "public": public,
                                      "source_run": {"id": "10", "attempt": "1", "latest_attempt": "1", "conclusion": "success"},
                                      "closed_build_run": {"id": "20", "attempt": "2", "latest_attempt": "2", "conclusion": "success"}}}
        build.validate_acceptance(accepted, public, "test")
        accepted["site_acceptance"]["checks"]["browser"] = False
        with self.assertRaises(build.Rejected):
            build.validate_acceptance(accepted, public, "test")
        accepted["site_acceptance"]["checks"]["browser"] = True
        accepted["qualification"]["source_run"]["latest_attempt"] = "2"
        with self.assertRaises(build.Rejected):
            build.validate_acceptance(accepted, public, "test")

    def test_tar_traversal_links_duplicate_and_size_rejected(self):
        for name, kind in (("../escape", None), ("/escape", None),
                           ("link", tarfile.SYMTYPE), ("hard", tarfile.LNKTYPE)):
            with tempfile.TemporaryDirectory() as temporary, self.assertRaises(build.Rejected):
                build.extract_tar(archive({name: b"data"}, kind), Path(temporary))
        with tempfile.TemporaryDirectory() as temporary, patch.object(build, "MAX_FILE", 2):
            with self.assertRaises(build.Rejected):
                build.extract_tar(archive({"large": b"123"}), Path(temporary))

    def test_zip_symlink_rejected(self):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as zipped:
            member = zipfile.ZipInfo("link")
            member.external_attr = 0o120777 << 16
            zipped.writestr(member, "/etc/passwd")
        with tempfile.TemporaryDirectory() as temporary, self.assertRaises(build.Rejected):
            build.extract_zip(stream.getvalue(), Path(temporary))

    def test_container_has_no_credentials_network_socket_or_privilege(self):
        image = "example.invalid/tool@sha256:" + "a" * 64
        command = build.container_command(image, "closed-test", Path("/input"), Path("/public"), Path("/output"), Path("/context"))
        for expected in ("none", "65532:65532", "ALL", "no-new-privileges", "--read-only", "--pull", "never", "--log-driver"):
            self.assertIn(expected, command)
        self.assertNotIn("/var/run/docker.sock", " ".join(command))
        self.assertNotIn("--privileged", command)
        self.assertNotIn("GH_TOKEN", " ".join(command))
        self.assertNotIn("CLOSED_", " ".join(command))

    def test_exact_environment_gate(self):
        trusted = {"GITHUB_REPOSITORY": build.REPOSITORY, "GITHUB_REF": "refs/heads/main",
                   "GITHUB_REPOSITORY_ID": build.REPOSITORY_ID, "GITHUB_REPOSITORY_OWNER_ID": build.OWNER_ID,
                   "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_WORKFLOW_REF": build.REPOSITORY + "/" + build.WORKFLOW + "@refs/heads/main",
                   "RUNNER_ENVIRONMENT": "github-hosted", "GITHUB_RUN_ID": "1", "GITHUB_RUN_ATTEMPT": "1"}
        build.gate_environment(trusted)
        for name, value in (("GITHUB_REF", "refs/pull/1/merge"), ("GITHUB_EVENT_NAME", "pull_request_target"),
                            ("GITHUB_REPOSITORY", "someone/fork"), ("RUNNER_ENVIRONMENT", "self-hosted"),
                            ("GITHUB_WORKFLOW_REF", "other.yml"), ("RUNNER_DEBUG", "1")):
            with self.assertRaises(build.Rejected):
                build.gate_environment({**trusted, name: value})

    def test_capture_keeps_failure_private_and_caps_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            log = Path(temporary) / "log"
            with self.assertRaises(build.Rejected):
                build.capture([sys.executable, "-c", "print(" + repr(MARKER) + ");raise SystemExit(1)"], log, 5)
            self.assertIn(MARKER, log.read_text())
            with patch.object(build, "MAX_LOG", 10), self.assertRaises(build.Rejected):
                build.capture([sys.executable, "-c", "print('x'*10000)"], log, 5)
            with self.assertRaises(build.Rejected):
                build.capture([sys.executable, "-c", "import time;time.sleep(3)"], log, 0.1)

    def test_cli_error_canary_is_never_printed(self):
        with patch.object(build, "execute", side_effect=RuntimeError(MARKER)), contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            result = build.main(["--action", "build", "--prepared-root", "/unused"])
        self.assertEqual(result, 1)
        self.assertEqual(out.getvalue(), "CLOSED_BUILD_REJECTED\n")
        self.assertEqual(err.getvalue(), "")
        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            result = build.main(["--action", MARKER, "--prepared-root", "/unused"])
        self.assertEqual(result, 1)
        self.assertEqual(out.getvalue(), "CLOSED_REQUEST_REJECTED\n")
        self.assertEqual(err.getvalue(), "")

    def test_transport_rejects_insecure_or_redirected_capabilities(self):
        for url in ("http://example.com/a", "https://name:secret@example.com/a", "https://example.com:80/a", "https://example.com/a#secret"):
            with self.assertRaises(build.Rejected):
                build.transport(url)
        with self.assertRaises(build.Rejected):
            build.NoRedirect().redirect_request(None, None, 302, None, None, "https://other.invalid")

    def test_output_cannot_replace_public_component(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            public, output = root / "public", root / "output"
            (public / "component").mkdir(parents=True)
            (public / "component/core.py").write_bytes(b"public immutable")
            output.mkdir()
            (output / "acceptance.json").write_bytes(envelope.canonical({"schema": 1, "passed": True, "checks": ["package", "site-contracts", "geometry"]}))
            files = {"custom_components/home_floorplan/core.py": b"public immutable",
                     "custom_components/home_floorplan/site.json": b"{}"}
            (output / "home-package.tar.gz").write_bytes(archive(files))
            build.validate_output(output, public, "rebuild-preserve")
            files["custom_components/home_floorplan/core.py"] = b"tampered"
            (output / "home-package.tar.gz").write_bytes(archive(files))
            with self.assertRaises(build.Rejected):
                build.validate_output(output, public, "rebuild-preserve")

    def test_candidate_contains_trusted_installer(self):
        packed = build.pack_candidate(b"package", {"schema": 1}, b"public installer")
        with tarfile.open(fileobj=io.BytesIO(packed), mode="r:gz") as contents:
            self.assertEqual(contents.getnames(), ["candidate.json", "home-package.tar.gz", "install-home-assistant.py"])
            self.assertEqual(contents.extractfile("install-home-assistant.py").read(), b"public installer")

    @unittest.skipUnless(os.environ.get("CLOSED_DOCKER_TEST") == "1", "explicit local Docker test")
    def test_real_container_success_failure_and_network_boundary(self):
        # All data in this test is fictional; no local source bundle or secret is loaded.
        script = '''import argparse,json,os,pathlib,socket,tarfile,io
p=argparse.ArgumentParser()
for key in ('public-source','public-component','output','context','dependency-root'): p.add_argument('--'+key)
a=p.parse_args()
assert os.geteuid()==65532
assert 'CLOSED_TEST_HOST_SECRET' not in os.environ
assert not pathlib.Path('/var/run/docker.sock').exists()
assert not pathlib.Path('/host').exists()
sock=socket.socket(); sock.settimeout(1)
try: sock.connect(('1.1.1.1',443))
except OSError: pass
else: raise AssertionError('external network available')
try: pathlib.Path('/public/component/core.py').write_text('changed')
except OSError: pass
else: raise AssertionError('public mount writable')
print('FICTIONAL_CLOSED_CANARY_NEVER_PUBLIC_93f8')
if pathlib.Path('fail').exists(): raise RuntimeError('FICTIONAL_CLOSED_CANARY_NEVER_PUBLIC_93f8')
if pathlib.Path('slow').exists():
 import time
 time.sleep(10)
with tarfile.open(a.output,'w:gz',format=tarfile.USTAR_FORMAT) as t:
 for name,data in [('core.py',b'public immutable'),('site.json',b'{}')]:
  i=tarfile.TarInfo('custom_components/home_floorplan/'+name);i.size=len(data);t.addfile(i,io.BytesIO(data))
pathlib.Path(a.output).with_name('acceptance.json').write_text(json.dumps({'schema':1,'passed':True,'checks':['package','site-contracts','geometry']}))
'''
        with tempfile.TemporaryDirectory(prefix="closed-docker-") as temporary:
            root = Path(temporary)
            source, public, context = [root / name for name in ("input", "public", "context")]
            (source / "scripts").mkdir(parents=True)
            (public / "component").mkdir(parents=True)
            context.mkdir()
            (source / "scripts/closed-build-entry.py").write_text(script)
            (public / "component/core.py").write_bytes(b"public immutable")
            (context / "build.json").write_text("{}")
            for directory in (source, public, context):
                build.make_readable(directory)
            log = root / "private.log"
            with patch.dict(os.environ, {"CLOSED_TEST_HOST_SECRET": MARKER}):
                build.run_worker(build.policy()["worker_image"], source, public, root / "output", context, log)
            build.validate_output(root / "output", public, "rebuild-preserve")
            self.assertIn(MARKER, log.read_text())
            (source / "fail").touch()
            with self.assertRaises(build.Rejected):
                build.run_worker(build.policy()["worker_image"], source, public, root / "failed-output", context, root / "failed.log")
            self.assertFalse((root / "failed-output/home-package.tar.gz").exists())
            (source / "fail").unlink()
            (source / "slow").touch()
            with self.assertRaises(build.Rejected):
                build.run_worker(build.policy()["worker_image"], source, public, root / "timeout-output", context, root / "timeout.log", timeout=1)
            self.assertFalse((root / "timeout-output/home-package.tar.gz").exists())


if __name__ == "__main__":
    unittest.main()
