#!/usr/bin/env python3
"""Closed transport, confinement, exact composition and non-disclosure tests."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

import closed_build as build
import closed_envelope as envelope
import release_control
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


@unittest.skipUnless(os.name == "posix", "the production worker requires POSIX resource limits")
class WorkerLimitTests(unittest.TestCase):
    def run_entrypoint(self, root, body):
        """Run the real entrypoint and kernel limit in a disposable child process.

        Only container paths are mapped to temporary host directories. The
        resource call, private child process and file writes are not mocked.
        The hard limit must never be lowered in the test runner itself.
        """
        import resource
        before = resource.getrlimit(resource.RLIMIT_FSIZE)
        (root / "input/scripts").mkdir(parents=True)
        (root / "output").mkdir()
        program = '''import argparse,errno,io,json,os,pathlib,resource,tarfile
p=argparse.ArgumentParser()
for key in ('public-source','public-component','output','context','dependency-root'):
 p.add_argument('--'+key)
a=p.parse_args()
print(json.dumps({'limits':resource.getrlimit(resource.RLIMIT_FSIZE)}),flush=True)
''' + body + '''
pathlib.Path(a.output).with_name('acceptance.json').write_text(json.dumps(
 {'schema':1,'passed':True,'checks':['package','site-contracts','geometry']}))
'''
        (root / "input/scripts/closed-build-entry.py").write_text(program)
        harness = '''import os,pathlib,shutil,subprocess,sys
root=pathlib.Path(sys.argv[1])
sys.path.insert(0,sys.argv[2])
import closed_worker as worker
paths={'/input':str(root/'input'),'/work/source':str(root/'source'),
       '/output/home-package.tar.gz':str(root/'output/home-package.tar.gz'),
       '/output/acceptance.json':str(root/'output/acceptance.json')}
def mapped(path):
 return paths.get(os.fspath(path),path)
copytree,chdir,run=shutil.copytree,os.chdir,subprocess.run
worker.shutil.copytree=lambda source,destination,*args,**kwargs: copytree(mapped(source),mapped(destination),*args,**kwargs)
worker.os.chdir=lambda path: chdir(mapped(path))
worker.Path=lambda path: pathlib.Path(mapped(path))
worker.subprocess.run=lambda args,**kwargs: run([mapped(arg) for arg in args],**kwargs)
raise SystemExit(worker.main())
'''
        result = subprocess.run([sys.executable, "-B", "-c", harness, str(root), str(build.ROOT / "scripts")],
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(resource.getrlimit(resource.RLIMIT_FSIZE), before)
        return result

    @staticmethod
    def package_body(member_size, copies, compression):
        return f'''block=bytes({member_size})
with tarfile.open(a.output,'w:gz',format=tarfile.USTAR_FORMAT,compresslevel={compression}) as archive:
 for name,data in [('core.py',b'public immutable'),('site.json',b'{{}}')]+[(str(i)+'.bin',block) for i in range({copies})]:
  member=tarfile.TarInfo('custom_components/home_floorplan/'+name)
  member.size=len(data)
  archive.addfile(member,io.BytesIO(data))
'''

    def test_real_entrypoint_creates_package_over_scene_member_limit(self):
        with tempfile.TemporaryDirectory(prefix="closed-worker-limit-") as directory:
            root = Path(directory)
            result = self.run_entrypoint(root, self.package_body(32 * 1024 * 1024, 2, 0))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["limits"], [build.MAX_PACKAGE, build.MAX_PACKAGE])
            output, public = root / "output", root / "public"
            (public / "component").mkdir(parents=True)
            (public / "component/core.py").write_bytes(b"public immutable")
            size = (output / "home-package.tar.gz").stat().st_size
            self.assertGreater(size, build.MAX_FILE)
            self.assertLess(size, build.MAX_PACKAGE)
            payload, _ = build.validate_output(output, public, "rebuild-preserve")
            self.assertEqual(len(payload), size)

    def test_real_entrypoint_kernel_rejects_file_over_package_limit(self):
        # Probe scratch space so output-volume capacity cannot mask RLIMIT_FSIZE.
        body = '''with open('oversized.bin','wb',buffering=0) as stream:
 stream.seek(128*1024*1024)
 try:
  stream.write(b'x')
 except OSError as error:
  print(json.dumps({'errno':error.errno,'size':os.fstat(stream.fileno()).st_size}),flush=True)
  raise SystemExit(9 if error.errno==errno.EFBIG else 10)
raise AssertionError('kernel permitted a file larger than the package limit')
'''
        with tempfile.TemporaryDirectory(prefix="closed-worker-oversize-") as directory:
            root = Path(directory)
            result = self.run_entrypoint(root, body)
            self.assertEqual(result.returncode, 1, result.stderr)
            records = [json.loads(line) for line in result.stdout.splitlines()]
            self.assertEqual(records[0]["limits"], [build.MAX_PACKAGE, build.MAX_PACKAGE])
            import errno
            self.assertEqual(records[1]["errno"], errno.EFBIG)
            self.assertLessEqual(records[1]["size"], build.MAX_PACKAGE)
            self.assertFalse((root / "output/acceptance.json").exists())

    def test_larger_worker_limit_does_not_allow_oversized_scene_member(self):
        with tempfile.TemporaryDirectory(prefix="closed-worker-member-") as directory:
            root = Path(directory)
            result = self.run_entrypoint(root, self.package_body(build.MAX_FILE + 1, 1, 1))
            self.assertEqual(result.returncode, 0, result.stderr)
            public = root / "public"
            (public / "component").mkdir(parents=True)
            (public / "component/core.py").write_bytes(b"public immutable")
            self.assertLess((root / "output/home-package.tar.gz").stat().st_size, build.MAX_FILE)
            with self.assertRaises(build.Rejected):
                build.validate_output(root / "output", public, "rebuild-preserve")


class BoundaryTests(unittest.TestCase):
    def test_prospective_rc_matches_published_complete_inventory(self):
        import version_plan
        import version_receipt
        policy = json.loads((build.ROOT / ".release-policy.json").read_text())
        source_sha = "a" * 40
        plan = version_plan.create_plan("1.2.3", "rc", 1, source_sha, policy)
        environment = {"GITHUB_RUN_ID": "10", "GITHUB_RUN_ATTEMPT": "1", "GITHUB_SHA": source_sha,
                       "GITHUB_REPOSITORY_ID": build.REPOSITORY_ID, "GITHUB_REPOSITORY_OWNER_ID": build.OWNER_ID}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "custom_components/home_floorplan").mkdir(parents=True)
            metadata = root / "custom_components/home_floorplan/manifest.json"
            metadata.write_text('{"version":"1.2.3"}')
            evidence = version_plan.sync_versions(root, policy, plan)
            (root / "version-plan.json").write_bytes(envelope.canonical(plan))
            (root / "inputs.json").write_bytes(envelope.canonical({
                "plan_sha256": version_plan.plan_digest(plan), "source_sha": source_sha,
                "files": evidence, "effective_inputs_sha256": version_plan.effective_inputs_digest(evidence)}))
            source, fuzz, published = [root / name for name in ("source", "fuzz", "published")]
            for folder in (source, fuzz, published / "payloads", root / "prepared/dependencies",
                           root / "prospective", root / "resolved", root / "invalid-0", root / "invalid-1",
                           root / "collision"):
                folder.mkdir(parents=True)
            for name, member in (("home_floorplan.zip", "manifest.json"),
                                 ("home-studio-1.2.3-rc.1.zip", "home-studio/custom_components/home_floorplan/manifest.json")):
                with zipfile.ZipFile(source / name, "w") as zipped:
                    zipped.writestr(member, metadata.read_bytes())
            (source / "home-studio.version.json").write_bytes(metadata.read_bytes())
            (fuzz / "fuzz-report.json").write_text('{"synthetic":true}')
            for folder, target in ((source, "public-source"), (fuzz, "fuzz")):
                version_receipt.create_receipt(root / "version-plan.json", root / "inputs.json", folder,
                                               folder / f"release-inputs-{target}.json")
                for path in folder.iterdir():
                    shutil.copyfile(path, published / "payloads" / path.name)
            expected = {path.name: {"sha256": envelope.digest(path.read_bytes()), "size": path.stat().st_size}
                        for path in (published / "payloads").iterdir()}
            context = {"schema": 1, "repository": build.REPOSITORY, "workflow": build.WORKFLOW,
                       "run_id": "10", "run_attempt": "1", "source_sha": source_sha,
                       "mode": "published", "release_tag": plan["tag"], "payloads": expected,
                       "plan_sha256": version_plan.plan_digest(plan)}
            (published / "context.json").write_bytes(envelope.canonical(context))
            shutil.copyfile(root / "version-plan.json", published / "version-plan.json")
            class GitHub:
                artifact_names = ["release-assets-public-source", "release-assets-fuzz"]
                def pages(self, path, field):
                    if field == "jobs":
                        return [{"name": "Release gate", "conclusion": "success"}]
                    return [{"name": name, "expired": False} for name in self.artifact_names]
            gh = GitHub()
            def download(unused, name, destination, *, producer):
                folders = {"plan": root, "release-assets-public-source": source,
                           "release-assets-fuzz": fuzz, "resolved": published}
                producers = {"plan": "prepare", "release-assets-public-source": "build / package",
                             "release-assets-fuzz": "fuzz / RC fuzzing", "resolved": "closed_existing_resolve"}
                self.assertTrue(producer(producers[name]))
                self.assertFalse(producer("untrusted producer"))
                if name == "plan":
                    destination.mkdir(parents=True)
                    shutil.copyfile(root / "version-plan.json", destination / "version-plan.json")
                else:
                    shutil.copytree(folders[name], destination, dirs_exist_ok=True)
            args = SimpleNamespace(action="build", public_context_artifact="", release_plan_artifact="plan",
                                   release_tag=plan["tag"], prepared_root=root / "prepared")
            with patch.dict(os.environ, environment), patch.object(release_control, "GitHub", return_value=gh), \
                    patch.object(release_control, "source_policy_snapshot", return_value={"data": policy}), \
                    patch.object(build, "download_artifact", side_effect=download):
                prospective, _ = build.public_inputs(args, root / "prospective")
                args.action = "rebuild"
                args.public_context_artifact = "resolved"
                resolved, _ = build.public_inputs(args, root / "resolved")
                self.assertEqual(prospective["payloads"], expected)
                self.assertEqual(prospective["payloads"], resolved["payloads"])
                args.action = "build"
                args.public_context_artifact = ""
                (source / "fuzz-report.json").write_text("collision")
                with self.assertRaises(build.Rejected):
                    build.public_inputs(args, root / "collision")
                (source / "fuzz-report.json").unlink()
                for number, names in enumerate((["release-assets-public-source"], gh.artifact_names + ["release-assets-other"])):
                    gh.artifact_names = names
                    with self.assertRaises(build.Rejected):
                        build.public_inputs(args, root / f"invalid-{number}")

    def test_published_stable_preserves_selected_tag_and_promotion_context(self):
        def zipped(files):
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, "w") as result:
                for name, data in files.items():
                    result.writestr(name, data)
            return stream.getvalue()
        payloads = {"home_floorplan.zip": zipped({"core.py": b"public"}),
                    "home-studio-1.2.3.zip": zipped({"home-studio/scripts/install-home-assistant.py": b"public"})}
        plan = {"source_sha": "a" * 40, "tag": "v1.2.3-rc.1", "version": "1.2.3-rc.1",
                "base_version": "1.2.3", "channel": "rc"}
        context = {"mode": "published", "repository": build.REPOSITORY, "workflow": build.WORKFLOW,
                   "source_sha": plan["source_sha"], "release_tag": "v1.2.3", "plan_sha256": "b" * 64,
                   "promotion": {"release_tag": "v1.2.3", "rc_tag": plan["tag"]},
                   "payloads": {name: {"sha256": envelope.digest(data), "size": len(data)}
                                for name, data in payloads.items()}}
        def download(gh, name, destination, *, producer):
            (destination / "payloads").mkdir()
            (destination / "context.json").write_bytes(envelope.canonical(context))
            (destination / "version-plan.json").write_bytes(envelope.canonical(plan))
            for name, data in payloads.items():
                (destination / "payloads" / name).write_bytes(data)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prepared = root / "prepared"
            (prepared / "dependencies").mkdir(parents=True)
            args = SimpleNamespace(action="rebuild", public_context_artifact="public-context", release_tag="v1.2.3",
                                   prepared_root=prepared)
            with patch.object(build, "download_artifact", side_effect=download), \
                 patch("version_plan.validate_plan", return_value=plan), \
                 patch("version_plan.plan_digest", return_value="b" * 64), \
                 patch("release_control.source_policy_snapshot", return_value={"data": {"schema": 1}}) as policy, \
                 patch("version_receipt.verify_receipts") as receipts, \
                 patch("version_receipt.verify_declared_artifacts") as metadata, \
                 patch.dict(os.environ, {"GITHUB_REPOSITORY_ID": build.REPOSITORY_ID,
                                         "GITHUB_REPOSITORY_OWNER_ID": build.OWNER_ID}):
                result, public = build.public_inputs(args, root)
            self.assertEqual(policy.call_args.args[1], plan["source_sha"])
            self.assertEqual(receipts.call_args.args[3], {"schema": 1})
            self.assertEqual(metadata.call_args.args[1], {"schema": 1})
            self.assertEqual(result["release_tag"], "v1.2.3")
            self.assertEqual(result["promotion"], context["promotion"])
            self.assertEqual(result["channel"], "rc")
            self.assertEqual((public / "component/core.py").read_bytes(), b"public")

    def test_published_context_selects_action_resolver_with_skipped_peer(self):
        def zipped(files):
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, "w") as result:
                for name, data in files.items():
                    result.writestr(name, data)
            return stream.getvalue()
        payloads = {"home_floorplan.zip": zipped({"core.py": b"public"}),
                    "home-studio-1.2.3.zip": zipped({"home-studio/scripts/install-home-assistant.py": b"public"})}
        plan = {"source_sha": "a" * 40, "tag": "v1.2.3-rc.1", "version": "1.2.3-rc.1",
                "base_version": "1.2.3", "channel": "rc"}
        context = {"mode": "published", "repository": build.REPOSITORY, "workflow": build.WORKFLOW,
                   "source_sha": plan["source_sha"], "release_tag": plan["tag"], "plan_sha256": "b" * 64,
                   "payloads": {name: {"sha256": envelope.digest(data), "size": len(data)}
                                for name, data in payloads.items()}}
        data = zipped({"context.json": envelope.canonical(context), "version-plan.json": envelope.canonical(plan),
                       **{"payloads/" + name: contents for name, contents in payloads.items()}})
        run = {"run_attempt": 2, "head_sha": "c" * 40, "path": build.WORKFLOW, "head_branch": "main"}
        # GitHub includes both resolver names in a closed-rebuild job inventory,
        # including the skipped peer's completed status and zero-length window.
        successful = {"name": "closed_existing_resolve", "status": "completed", "conclusion": "success",
                      "started_at": "2026-10-20T01:51:40Z", "completed_at": "2026-10-20T01:52:50Z"}
        skipped = {"name": "closed_stable_resolve", "status": "completed", "conclusion": "skipped",
                   "started_at": "2026-10-20T01:51:38Z", "completed_at": "2026-10-20T01:51:38Z"}
        artifact = {"id": 3, "name": "public-context", "expired": False,
                    "workflow_run": {"id": 10, "head_sha": run["head_sha"]},
                    "created_at": "2026-10-20T01:52:40Z", "size_in_bytes": len(data),
                    "digest": "sha256:" + envelope.digest(data)}
        class GitHub:
            def api(self, path): return run
            def pages(self, path, field): return self.jobs if field == "jobs" else [artifact]
            def binary(self, path): return data
        environment = {"GITHUB_RUN_ID": "10", "GITHUB_RUN_ATTEMPT": "2", "GITHUB_SHA": run["head_sha"],
                       "GITHUB_REPOSITORY_ID": build.REPOSITORY_ID, "GITHUB_REPOSITORY_OWNER_ID": build.OWNER_ID}
        for action in ("rebuild", "validate"):
            selected, peer = copy.deepcopy((successful, skipped))
            if action == "validate":
                selected["name"], peer["name"] = peer["name"], selected["name"]
            cases = {"valid": [selected, peer],
                     "wrong-only": [{**selected, "name": peer["name"]}],
                     "skipped-selected": [{**selected, "conclusion": "skipped"}, {**peer, "conclusion": "success"}],
                     "failed-selected": [{**selected, "conclusion": "failure"}, {**peer, "conclusion": "success"}],
                     "duplicate-selected": [selected, copy.deepcopy(selected), peer],
                     "duplicate-skipped-selected": [selected, {**selected, "conclusion": "skipped"}, peer],
                     "renamed-selected": [{**selected, "name": "Resolve closed public release"}, peer],
                     "wrong-action": [selected, peer]}
            for case, jobs in cases.items():
                with self.subTest(action=action, case=case), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    (root / "prepared/dependencies").mkdir(parents=True)
                    args = SimpleNamespace(action="build" if case == "wrong-action" else action,
                                           public_context_artifact="public-context", release_tag=plan["tag"],
                                           prepared_root=root / "prepared")
                    gh = GitHub()
                    gh.jobs = jobs
                    with patch.object(release_control, "GitHub", return_value=gh), \
                         patch("version_plan.validate_plan", return_value=plan), \
                         patch("version_plan.plan_digest", return_value="b" * 64), \
                         patch("release_control.source_policy_snapshot", return_value={"data": {}}), \
                         patch("version_receipt.verify_receipts"), patch("version_receipt.verify_declared_artifacts"), \
                         patch.dict(os.environ, environment):
                        if case != "valid":
                            with self.assertRaises(build.Rejected):
                                build.public_inputs(args, root)
                        else:
                            result, public = build.public_inputs(args, root)
                            self.assertEqual(result["payloads"], context["payloads"])
                            self.assertEqual((public / "component/core.py").read_bytes(), b"public")

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
        cases = [(failure, "fictional") for failure in
                 (None, "worker", "input-signature", "input-archive", "input-intent",
                  "package-tamper", "acceptance-failure", "candidate-upload", "diagnostic-upload")]
        for failure, request in [*cases, (None, "")]:
            stored = {}
            selected_input = sealed_input
            if failure == "input-signature":
                selected_input = envelope.seal(archive(files), ci_encrypt, keys()[0], purpose="input")
            if failure == "input-archive":
                selected_input = envelope.seal(MARKER.encode(), ci_encrypt, operator_sign, purpose="input")
            if failure == "input-intent":
                changed_manifest = copy.deepcopy(manifest)
                changed_manifest["target"]["source_sha"] = "f" * 40
                selected_input = envelope.seal(archive({**files, "closed-build.json": envelope.canonical(changed_manifest)}),
                                               ci_encrypt, operator_sign, purpose="input")
            def transport(url, *, data=None, suffix=None, create_only=False):
                if data is None:
                    return selected_input
                self.assertNotIn(MARKER.encode(), data)
                if failure == "candidate-upload" and suffix.endswith(".candidate.json"):
                    raise RuntimeError(MARKER)
                if failure == "diagnostic-upload" and suffix.endswith(".diagnostic.json"):
                    raise RuntimeError(MARKER)
                stored[suffix] = data
                return b""
            def selected_worker(*args, **kwargs):
                if failure == "worker":
                    raise RuntimeError(MARKER)
                worker(*args, **kwargs)
                output = args[3]
                if failure == "package-tamper":
                    (output / "home-package.tar.gz").write_bytes(archive({
                        "custom_components/home_floorplan/core.py": MARKER.encode(),
                        "custom_components/home_floorplan/site.json": b"{}"}))
                if failure == "acceptance-failure":
                    (output / "acceptance.json").write_bytes(envelope.canonical({"schema": 1, "passed": False, "checks": [MARKER]}))
            with tempfile.TemporaryDirectory() as directory:
                prepared = Path(directory)
                (prepared / "prepared.json").write_bytes(envelope.canonical(build.policy()))
                with patch.dict(os.environ, environment), patch.object(build, "public_inputs", side_effect=public_inputs), patch.object(build, "transport", side_effect=transport), patch.object(build, "run_worker", side_effect=selected_worker), contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
                    result = build.main(["--action", "build", "--closed-request", request, "--prepared-root", str(prepared)])
            self.assertNotIn(MARKER, out.getvalue() + err.getvalue(), failure)
            self.assertEqual(result, int(failure is not None), failure)
            expected_status = ("CLOSED_CANDIDATE_STORED" if failure is None else
                               "CLOSED_DIAGNOSTIC_UPLOAD_FAILED" if failure == "diagnostic-upload" else
                               "CLOSED_BUILD_REJECTED")
            self.assertEqual(out.getvalue(), expected_status + "\n", failure)
            self.assertEqual(err.getvalue(), "", failure)
            candidates = [wire for name, wire in stored.items() if name.endswith(".candidate.json")]
            self.assertEqual(len(candidates), int(failure in {None, "diagnostic-upload"}), failure)
            if failure != "diagnostic-upload":
                diagnostic = next(wire for name, wire in stored.items() if name.endswith(".diagnostic.json"))
                plain_diagnostic = envelope.open_envelope(diagnostic, deploy_decrypt, worker_verify, purpose="diagnostic")
                if failure not in {"input-signature", "input-archive", "input-intent"}:
                    self.assertIn(MARKER.encode(), plain_diagnostic, failure)
            if candidates:
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
                    "build_run_id": "20", "build_run_attempt": "2", "build_source_sha": "f" * 40,
                    "candidate_object": "test/20-2.candidate.json",
                    "site_acceptance": {"schema": 1, "state": "site-canary-passed", "payload_sha256": "d" * 64,
                                        "checks": {"actual_ha": True, "browser": True}, "evidence_sha256": "e" * 64, "receipt_sha256": "f" * 64},
                    "qualification": {"status": "published", "conclusion": "success", "release_tag": public["release_tag"], "public": public,
                                      "source_run": {"id": "10", "attempt": "1", "latest_attempt": "1", "conclusion": "success"},
                                      "closed_build_run": {"id": "20", "attempt": "2", "latest_attempt": "2", "conclusion": "success"}}}
        build.validate_acceptance(accepted, public, "test")
        for size in (build.MAX_FILE + 1, build.MAX_PACKAGE):
            with self.subTest(payload_size=size):
                build.validate_acceptance({**accepted, "payload_size": size}, public, "test")
        build.validate_acceptance({**accepted, "installer_size": build.MAX_FILE}, public, "test")
        for field, size in (("payload_size", build.MAX_PACKAGE + 1),
                            ("installer_size", build.MAX_FILE + 1),
                            ("payload_size", True), ("payload_size", 0),
                            ("installer_size", False), ("installer_size", -1)):
            with self.subTest(field=field, size=size), self.assertRaises(build.Rejected):
                build.validate_acceptance({**accepted, field: size}, public, "test")
        accepted["site_acceptance"]["checks"]["browser"] = False
        with self.assertRaises(build.Rejected):
            build.validate_acceptance(accepted, public, "test")
        accepted["site_acceptance"]["checks"]["browser"] = True
        accepted["qualification"]["source_run"]["latest_attempt"] = "2"
        with self.assertRaises(build.Rejected):
            build.validate_acceptance(accepted, public, "test")

    def test_stable_rechecks_latest_closed_build_attempt(self):
        accepted = {"build_run_id": "20", "build_run_attempt": "2", "build_source_sha": "f" * 40}
        repository = {"full_name": build.REPOSITORY, "id": int(build.REPOSITORY_ID),
                      "owner": {"id": int(build.OWNER_ID)}}
        run = {"id": 20, "run_attempt": 2, "repository": repository, "head_repository": repository,
               "head_sha": "f" * 40, "path": build.WORKFLOW, "head_branch": "main",
               "event": "workflow_dispatch", "status": "completed", "conclusion": "success"}
        with patch.object(release_control.GitHub, "api", return_value=run):
            build.validate_accepted_build(accepted)
        for field, value in (("run_attempt", 3), ("head_sha", "e" * 40), ("conclusion", "failure"),
                             ("status", "in_progress"), ("event", "pull_request"), ("path", "other.yml")):
            with patch.object(release_control.GitHub, "api", return_value={**run, field: value}):
                with self.assertRaises((build.Rejected, release_control.ReleaseError)):
                    build.validate_accepted_build(accepted)

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

    def test_capture_caps_aggregate_log_across_commands(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(build, "MAX_LOG", 16):
            log = Path(temporary) / "log"
            build.capture([sys.executable, "-c", "print('12345678')"], log, 5)
            with self.assertRaises(build.Rejected):
                build.capture([sys.executable, "-c", "print('abcdefgh')"], log, 5)
            self.assertEqual(log.stat().st_size, 16)

    def test_closed_workflow_has_no_public_output_or_cache_step(self):
        workflow = (build.ROOT / ".github/workflows/closed-build.yml").read_text()
        for forbidden in ("upload-artifact", "upload-pages-artifact", "actions/cache", "upload-sarif",
                          "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY", "secrets: inherit"):
            self.assertNotIn(forbidden, workflow)
        self.assertIn("runs-on: ubuntu-24.04", workflow)
        self.assertIn("environment: closed-build", workflow)
        self.assertIn("persist-credentials: false", workflow)

    def test_closed_workflow_requires_exact_named_secrets_at_call_boundary(self):
        workflow = (build.ROOT / ".github/workflows/closed-build.yml").read_text()
        names = (
            "CLOSED_INPUT_READ_URL", "CLOSED_OUTPUT_WRITE_URL", "CLOSED_OUTPUT_READ_URL",
            "CLOSED_ACCEPTANCE_READ_URL", "CLOSED_INPUT_DECRYPT_KEY", "CLOSED_INPUT_VERIFY_KEY",
            "CLOSED_OUTPUT_ENCRYPT_KEY", "CLOSED_OUTPUT_SIGN_KEY",
        )
        call = workflow.split("  workflow_call:\n", 1)[1].split("\npermissions:", 1)[0]
        self.assertIn("    secrets:\n", call, "Environment secrets still require caller forwarding and declarations")
        declarations = call.split("    secrets:\n", 1)[1]
        self.assertCountEqual(re.findall(r"^      ([A-Z][A-Z0-9_]*):$", declarations, re.MULTILINE), names)
        for name in names:
            self.assertRegex(declarations, rf"(?m)^      {name}:\n        required: true$")
        public_steps, process = workflow.split("      - name: Process closed package\n", 1)
        self.assertNotIn("${{ secrets.", public_steps, "Public preparation cannot receive closed credentials")
        self.assertEqual({line.strip() for line in process.splitlines() if "${{ secrets." in line},
                         {f"{name}: ${{{{ secrets.{name} }}}}" for name in names})
        self.assertNotIn("secrets: inherit", workflow)

    def test_cli_error_canary_is_never_printed(self):
        for exception in (RuntimeError, KeyboardInterrupt, SystemExit):
            with self.subTest(exception=exception), patch.object(build, "execute", side_effect=exception(MARKER)), contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
                result = build.main(["--action", "build", "--prepared-root", "/unused"])
            self.assertEqual(result, 1)
            self.assertEqual(out.getvalue(), "CLOSED_BUILD_REJECTED\n")
            self.assertEqual(err.getvalue(), "")
        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            result = build.main(["--action", MARKER, "--prepared-root", "/unused"])
        self.assertEqual(result, 1)
        self.assertEqual(out.getvalue(), "CLOSED_REQUEST_REJECTED\n")
        self.assertEqual(err.getvalue(), "")

    def test_nested_diagnostic_failures_cannot_expose_original_exception_chain(self):
        class InterruptedLog:
            def __init__(self, exception):
                self.exception = exception

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def tell(self):
                return 0

            def write(self, _):
                raise self.exception(MARKER)

        for stage in ("format", "write"):
            for exception in (RuntimeError, KeyboardInterrupt, SystemExit):
                failure = (patch.object(build.traceback, "format_exc", side_effect=exception(MARKER))
                           if stage == "format" else patch.object(Path, "open", return_value=InterruptedLog(exception)))
                with self.subTest(stage=stage, exception=exception), failure, \
                     patch.dict(os.environ, {}, clear=True), \
                     patch.object(build, "execute", side_effect=RuntimeError(MARKER)), \
                     contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
                    result = build.main(["--action", "build", "--prepared-root", "/unused"])
                self.assertEqual(result, 1)
                self.assertEqual(out.getvalue(), "CLOSED_BUILD_REJECTED\n")
                self.assertEqual(err.getvalue(), "")

    def test_temporary_directory_entry_and_cleanup_failures_are_private(self):
        class InterruptedDirectory:
            def __init__(self, stage, exception):
                self.stage, self.exception = stage, exception

            def __enter__(self):
                if self.stage == "entry":
                    raise self.exception(MARKER)
                return "/unused"

            def __exit__(self, *_):
                raise self.exception(MARKER)

        for stage in ("entry", "cleanup"):
            for exception in (OSError, KeyboardInterrupt, SystemExit):
                with self.subTest(stage=stage, exception=exception), patch.dict(os.environ, {}, clear=True), \
                     patch.object(build.tempfile, "TemporaryDirectory", return_value=InterruptedDirectory(stage, exception)), \
                     patch.object(build, "execute", return_value="CLOSED_CANDIDATE_STORED") as execute, \
                     patch.object(Path, "exists", return_value=False), \
                     contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
                    result = build.main(["--action", "build", "--prepared-root", "/unused"])
                self.assertEqual(result, 1)
                self.assertEqual(out.getvalue(), "CLOSED_BUILD_REJECTED\n")
                self.assertEqual(err.getvalue(), "")
                self.assertEqual(execute.call_count, int(stage == "cleanup"))

    def test_diagnostic_upload_interruptions_remain_fixed_status(self):
        environment = {name: "fictional" for name in (
            "CLOSED_OUTPUT_ENCRYPT_KEY", "CLOSED_OUTPUT_SIGN_KEY", "CLOSED_OUTPUT_WRITE_URL")}
        environment.update(GITHUB_RUN_ID="1", GITHUB_RUN_ATTEMPT="1")
        for exception in (RuntimeError, KeyboardInterrupt, SystemExit):
            with self.subTest(exception=exception), patch.dict(os.environ, environment, clear=True), \
                 patch.object(build, "execute", side_effect=RuntimeError(MARKER)), \
                 patch.object(build, "seal", return_value=b"fictional encrypted diagnostic"), \
                 patch.object(build, "transport", side_effect=exception(MARKER)), \
                 contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
                result = build.main(["--action", "build", "--prepared-root", "/unused", "--closed-request", "fixture"])
            self.assertEqual(result, 1)
            self.assertEqual(out.getvalue(), "CLOSED_DIAGNOSTIC_UPLOAD_FAILED\n")
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

    def test_compressed_package_can_exceed_one_scene_file(self):
        # Stored gzip makes the container larger than 64 MiB while each member
        # stays below the unchanged scene-file limit. No random data is needed.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            public, output = root / "public", root / "output"
            (public / "component").mkdir(parents=True)
            (public / "component/core.py").write_bytes(b"public immutable")
            output.mkdir()
            evidence = {"schema": 1, "passed": True, "checks": ["package", "site-contracts", "geometry"]}
            (output / "acceptance.json").write_bytes(envelope.canonical(evidence))
            payload = output / "home-package.tar.gz"
            block = bytes(32 * 1024 * 1024)
            with tarfile.open(payload, "w:gz", format=tarfile.USTAR_FORMAT, compresslevel=0) as packed:
                for name, data in (("core.py", b"public immutable"), ("site.json", b"{}"),
                                   ("first.bin", block), ("second.bin", block)):
                    member = tarfile.TarInfo("custom_components/home_floorplan/" + name)
                    member.size = len(data)
                    packed.addfile(member, io.BytesIO(data))
            self.assertGreater(payload.stat().st_size, 64 * 1024 * 1024)
            result, actual = build.validate_output(output, public, "rebuild-preserve")
            self.assertEqual(envelope.digest(result), envelope.digest(payload.read_bytes()))
            self.assertEqual(actual, evidence)
            # Oversized transport is rejected before it is read/decompressed.
            with payload.open("wb") as stream:
                stream.truncate(128 * 1024 * 1024 + 1)
            with self.assertRaises(build.Rejected):
                build.validate_output(output, public, "rebuild-preserve")

    def test_candidate_contains_trusted_installer(self):
        packed = build.pack_candidate(b"package", {"schema": 1}, b"public installer")
        with tarfile.open(fileobj=io.BytesIO(packed), mode="r:gz") as contents:
            self.assertEqual(contents.getnames(), ["candidate.json", "home-package.tar.gz", "install-home-assistant.py"])
            self.assertEqual(contents.extractfile("install-home-assistant.py").read(), b"public installer")
        with patch.object(build, "MAX_PACKAGE", 6), self.assertRaises(build.Rejected):
            build.pack_candidate(b"package", {"schema": 1}, b"public installer")
        with patch.object(build, "MAX_ENVELOPE", 2 * (len(packed) - 1)), self.assertRaises(build.Rejected):
            build.pack_candidate(b"package", {"schema": 1}, b"public installer")

    def test_worker_output_inspector_uses_per_file_bounds(self):
        commands = []
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch.object(build, "capture", side_effect=lambda command, *_: commands.append(command)), \
                 patch.object(build.subprocess, "run"):
                build.run_worker("example.invalid/tool@sha256:" + "a" * 64,
                                 root / "input", root / "public", root / "output",
                                 root / "context", root / "private.log")
        program, = [command[-1] for command in commands if command[:2] == ["docker", "exec"]]

        def inspect(files):
            with patch.object(os, "listdir", return_value=list(files)), \
                 patch.object(os, "lstat", side_effect=lambda name: files[Path(name).name]):
                exec(program, {})

        def file(size, mode=stat.S_IFREG | 0o644, links=1):
            return SimpleNamespace(st_size=size, st_mode=mode, st_nlink=links)

        self.assertEqual(build.MAX_FILE, 64 * 1024 * 1024)
        self.assertEqual(build.MAX_PACKAGE, 128 * 1024 * 1024)
        self.assertEqual(build.MAX_TOTAL, 512 * 1024 * 1024)
        valid = {"home-package.tar.gz": file(build.MAX_PACKAGE), "acceptance.json": file(100_000)}
        inspect(valid)
        for changed in (
            {**valid, "home-package.tar.gz": file(build.MAX_PACKAGE + 1)},
            {**valid, "acceptance.json": file(100_001)},
            {**valid, "extra": file(1)},
            {"home-package.tar.gz": valid["home-package.tar.gz"]},
            {**valid, "home-package.tar.gz": file(1, stat.S_IFLNK | 0o777)},
            {**valid, "acceptance.json": file(1, links=2)},
        ):
            with self.subTest(files=changed), self.assertRaises(AssertionError):
                inspect(changed)

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
