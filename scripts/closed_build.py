#!/usr/bin/env python3
"""Closed HA build host. Public stdout is exclusively fixed status codes.

Private code executes only inside the isolated container. All transport keys
and capabilities are read from the protected environment, never CLI arguments.
"""
from __future__ import annotations

import argparse
import datetime
import io
import os
from pathlib import Path, PurePosixPath
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import traceback
import urllib.parse
import urllib.request
import uuid
import zipfile

from closed_envelope import canonical, decode_json, digest, open_envelope, seal, verify_envelope, b64, unb64, MAX_ENVELOPE

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "ha-homelab/home-studio"
REPOSITORY_ID = "1414876449"
OWNER_ID = "307715255"
WORKFLOW = ".github/workflows/release-pipeline.yml"
MAX_FILES = 12000
MAX_FILE = 64 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024
MAX_LOG = 4 * 1024 * 1024
REQUEST = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")
IMAGE = re.compile(r"[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}\Z")
REQUIRED_CHECKS = {"package", "site-contracts"}


class Rejected(Exception):
    """Error details stay in closed diagnostics."""


def require(condition):
    if not condition:
        raise Rejected()


def regular(path, maximum=MAX_FILE):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= maximum)
    return path.read_bytes()


def safe_name(name):
    require(isinstance(name, str) and bool(name) and "\\" not in name and "\0" not in name)
    path = PurePosixPath(name)
    require(not path.is_absolute() and all(part not in {".", "..", ""} for part in name.split("/")))
    require(path.parts[0] != ".git")
    return path


def extract_tar(data, destination):
    """No archive-controlled permissions, links, special files or extractall."""
    total, seen = 0, set()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive:
            name = member.name.rstrip("/") if member.isdir() else member.name
            relative = safe_name(name)
            require(name.casefold() not in seen and len(seen) < MAX_FILES)
            seen.add(name.casefold())
            require(member.isdir() or member.isfile())
            require(set(member.pax_headers) <= {"path"} and member.size <= MAX_FILE)
            total += member.size
            require(total <= MAX_TOTAL)
            path = destination / relative
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open("xb") as output, archive.extractfile(member) as source:
                    shutil.copyfileobj(source, output)
                path.chmod(0o644)


def extract_zip(data, destination):
    total, seen = 0, set()
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for member in archive.infolist():
            name = member.filename.rstrip("/") if member.is_dir() else member.filename
            relative = safe_name(name)
            require(name.casefold() not in seen and len(seen) < MAX_FILES)
            seen.add(name.casefold())
            mode = member.external_attr >> 16
            require(stat.S_IFMT(mode) in {0, stat.S_IFREG, stat.S_IFDIR})
            total += member.file_size
            require(member.file_size <= MAX_FILE and total <= MAX_TOTAL)
            path = destination / relative
            if member.is_dir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                with path.open("xb") as stream:
                    stream.write(archive.read(member))
                path.chmod(0o644)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Rejected()


def transport(url, *, data=None, suffix=None, create_only=False):
    """Capabilities never cross redirects or enter subprocess argv/logs."""
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == "https" and parsed.hostname and not parsed.username
            and not parsed.password and not parsed.fragment and parsed.port in {None, 443})
    if suffix is not None:
        require(re.fullmatch(r"[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+", suffix) is not None)
        require(parsed.path.endswith("/") and not parsed.query)
        url += suffix
    headers = {"Content-Type": "application/octet-stream"}
    if create_only:
        headers["If-None-Match"] = "*"
    request = urllib.request.Request(url, data=data, method="PUT" if data is not None else "GET",
                                     headers=headers)
    with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(
            request, timeout=60) as response:
        require(response.status in ({200, 201, 204} if data is not None else {200}))
        result = response.read(MAX_ENVELOPE + 1)
        require(len(result) <= MAX_ENVELOPE)
        return result


def gate_environment(environment):
    require(environment.get("GITHUB_REPOSITORY") == REPOSITORY)
    require(environment.get("GITHUB_REPOSITORY_ID") == REPOSITORY_ID
            and environment.get("GITHUB_REPOSITORY_OWNER_ID") == OWNER_ID)
    require(environment.get("GITHUB_REF") == "refs/heads/main")
    require(environment.get("GITHUB_EVENT_NAME") in {"push", "schedule", "workflow_dispatch"})
    require(environment.get("GITHUB_WORKFLOW_REF") == REPOSITORY + "/" + WORKFLOW + "@refs/heads/main")
    require(environment.get("RUNNER_ENVIRONMENT") == "github-hosted")
    require(environment.get("RUNNER_DEBUG", "0") != "1")
    for field in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"):
        require(re.fullmatch(r"[1-9][0-9]*", environment.get(field, "")) is not None)


def iso_time(value):
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))


def download_artifact(gh, name, destination, *, producer):
    """Bind immutable v4 bytes to exact run/attempt and completed producer."""
    run_id, attempt = os.environ["GITHUB_RUN_ID"], os.environ["GITHUB_RUN_ATTEMPT"]
    run = gh.api("actions/runs/" + run_id)
    require(str(run["run_attempt"]) == attempt and run["head_sha"] == os.environ["GITHUB_SHA"])
    require(run["path"] == WORKFLOW and run["head_branch"] == "main")
    jobs = gh.pages(f"actions/runs/{run_id}/attempts/{attempt}/jobs", "jobs")
    matching = [job for job in jobs if producer(job["name"])]
    require(len(matching) == 1 and matching[0]["conclusion"] == "success")
    job = matching[0]
    artifacts = gh.pages(f"actions/runs/{run_id}/artifacts", "artifacts")
    matching = [item for item in artifacts if item["name"] == name and not item["expired"]]
    require(len(matching) == 1)
    artifact = matching[0]
    require(artifact["workflow_run"]["id"] == int(run_id)
            and artifact["workflow_run"]["head_sha"] == run["head_sha"])
    require(iso_time(job["started_at"]) < iso_time(artifact["created_at"]) <= iso_time(job["completed_at"]))
    require(artifact["size_in_bytes"] <= MAX_TOTAL)
    archive = gh.binary(f"actions/artifacts/{artifact['id']}/zip")
    require(artifact["digest"] == "sha256:" + digest(archive))
    extract_zip(archive, destination)


def complete_staged_inventory(gh, assets, temporary, plan, source_policy):
    """Match the publisher's complete release-assets* inventory, fail on additions."""
    import release_fuzz
    required = {"release-assets-public-source"}
    if plan["channel"] == "rc" and release_fuzz.configuration(source_policy):
        required.add("release-assets-fuzz")
    artifacts = gh.pages(f"actions/runs/{os.environ['GITHUB_RUN_ID']}/artifacts", "artifacts")
    staged = [item["name"] for item in artifacts
              if item["name"].startswith("release-assets") and not item["expired"]]
    require(len(staged) == len(required) and set(staged) == required)
    require(source_policy.get("artifact_pattern", "release-assets*") == "release-assets*")
    if "release-assets-fuzz" in required:
        fuzz = temporary / "fuzz"
        download_artifact(gh, "release-assets-fuzz", fuzz,
                          producer=lambda name: name == release_fuzz.JOB)
        require({path.name for path in fuzz.iterdir()} == {"fuzz-report.json", "release-inputs-fuzz.json"})
        for path in fuzz.iterdir():
            regular(path)
            require(not (assets / path.name).exists())
            path.rename(assets / path.name)


def public_inputs(args, temporary):
    import release_control
    import version_plan
    import version_receipt
    gh = release_control.GitHub(REPOSITORY)
    public = temporary / "public"
    public.mkdir()
    if args.public_context_artifact:
        download_artifact(gh, args.public_context_artifact, public,
                          producer=lambda name: name in {"Resolve closed public release", "closed_existing_resolve", "closed_stable_resolve"})
        context = decode_json(regular(public / "context.json", 2_000_000))
        plan_path, assets = public / "version-plan.json", public / "payloads"
        require(context["mode"] == "published" and context["release_tag"] == args.release_tag)
    else:
        require(args.action == "build" and args.release_plan_artifact)
        jobs = gh.pages(f"actions/runs/{os.environ['GITHUB_RUN_ID']}/attempts/{os.environ['GITHUB_RUN_ATTEMPT']}/jobs", "jobs")
        gates = [job for job in jobs if job["name"] == "Release gate"]
        require(len(gates) == 1 and gates[0]["conclusion"] == "success")
        download_artifact(gh, args.release_plan_artifact, public / "plan",
                          producer=lambda name: name == "prepare")
        plan_files = list((public / "plan").rglob("*.json"))
        require(len(plan_files) == 1)
        plan_path, assets = plan_files[0], public / "payloads"
        download_artifact(gh, "release-assets-public-source", assets,
                          producer=lambda name: name == "build / package")
        context = {"schema": 1, "repository": REPOSITORY, "workflow": WORKFLOW,
                   "run_id": os.environ["GITHUB_RUN_ID"], "run_attempt": os.environ["GITHUB_RUN_ATTEMPT"],
                   "source_sha": os.environ["GITHUB_SHA"], "mode": "prospective"}
    plan = version_plan.validate_plan(decode_json(regular(plan_path, 2_000_000)))
    require(context["repository"] == REPOSITORY and context["workflow"] == WORKFLOW
            and context["source_sha"] == plan["source_sha"])
    source_policy = release_control.source_policy_snapshot(gh, plan["source_sha"])["data"]
    version_plan.validate_plan(plan, policy=source_policy, source_sha=context["source_sha"])
    if context["mode"] == "prospective":
        complete_staged_inventory(gh, assets, temporary, plan, source_policy)
    payloads = [{"name": path.name, "size": len(regular(path)), "sha256": digest(regular(path))}
                for path in sorted(assets.iterdir())]
    # Receipts are unsigned: the exact producer checks above establish origin.
    version_receipt.verify_receipts(assets, plan, payloads, source_policy)
    version_receipt.verify_declared_artifacts(assets, source_policy, plan)
    calculated = {item["name"]: {"sha256": item["sha256"], "size": item["size"]} for item in payloads}
    if context["mode"] == "published":
        require(context["payloads"] == calculated and context["plan_sha256"] == version_plan.plan_digest(plan))
    # Promoted stable bytes retain the RC plan, while the resolver binds the
    # actual selected stable publication separately from that immutable plan.
    context.update(plan_sha256=version_plan.plan_digest(plan), payloads=calculated,
                   release_tag=context.get("release_tag", plan["tag"]), version=plan["version"],
                   base_version=plan["base_version"], channel=plan["channel"],
                   repository_id=os.environ["GITHUB_REPOSITORY_ID"],
                   repository_owner_id=os.environ["GITHUB_REPOSITORY_OWNER_ID"],
                   dependencies=policy()["dependencies"])
    extract_zip(regular(assets / "home_floorplan.zip"), public / "component")
    source_archives = [path for path in assets.glob("home-studio-*.zip")]
    require(len(source_archives) == 1)
    extract_zip(regular(source_archives[0]), public / "source-archive")
    source = public / "source-archive/home-studio"
    require(source.is_dir())
    source.rename(public / "source")
    dependencies = args.prepared_root / "dependencies"
    require(dependencies.is_dir())
    shutil.copytree(dependencies, public / "dependencies")
    return context, public


def validate_input(source, context, request_id, image):
    manifest = decode_json(regular(source / "closed-build.json", 2_000_000))
    require(manifest.get("schema") == 1 and manifest.get("request_id") == request_id)
    require(manifest.get("entrypoint") == "scripts/closed-build-entry.py")
    synthetic = manifest.get("synthetic") is True
    require(manifest.get("acceptance_policy") == ("transport-canary-v1" if synthetic else "ha-home-python-v1"))
    require(manifest.get("build_mode") in {"package-only", "rebuild-preserve"})
    require(not synthetic or manifest["build_mode"] == "package-only")
    require(manifest.get("worker_image") == image)
    target = {key: context[key] for key in ("source_sha", "plan_sha256", "payloads")}
    if "target_policy" in manifest:
        allowed = manifest["target_policy"]
        require("target" not in manifest and isinstance(allowed, dict))
        require(set(allowed) == {"source_sha", "base_version", "channels", "repository_id", "repository_owner_id", "dependencies"})
        require(isinstance(allowed["channels"], list) and bool(allowed["channels"])
                and set(allowed["channels"]) <= {"beta", "rc", "nightly"})
        for field in ("source_sha", "base_version", "repository_id", "repository_owner_id", "dependencies"):
            require(allowed[field] == context[field])
        require(context["channel"] in allowed["channels"])
    else:
        require(manifest.get("target") == target)
    original = decode_json(regular(source / "public-core.lock.json", 4096))
    require(manifest.get("original_core_lock") == original)
    require(set(original) == {"repository", "commit"}
            and original["repository"] == "https://github.com/" + REPOSITORY + ".git"
            and re.fullmatch(r"[0-9a-f]{40}", original["commit"]) is not None)
    require((source / "scripts/closed-build-entry.py").is_file())
    inventory = manifest.get("files")
    actual = {path.relative_to(source).as_posix(): digest(regular(path))
              for path in source.rglob("*") if path.is_file() and path != source / "closed-build.json"}
    require(inventory == actual)
    return manifest


def container_command(image, name, source, public, output, context, *, output_volume=None):
    require(IMAGE.fullmatch(image) is not None)
    return ["docker", "run", "--name", name, "--pull", "never", "--network", "none",
            "--user", "65532:65532", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--read-only", "--pids-limit", "256", "--memory", "4g", "--cpus", "2",
            "--ulimit", "nofile=1024:1024", "--log-driver", "none",
            "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777",
            "--tmpfs", "/work:rw,nosuid,nodev,size=2g,mode=1777",
            "--mount", f"type=bind,src={source},dst=/input,readonly",
            "--mount", f"type=bind,src={public},dst=/public,readonly",
            "--mount", f"type=bind,src={context},dst=/context,readonly",
            "--mount", f"type=bind,src={ROOT / 'scripts/closed_worker.py'},dst=/tool/closed_worker.py,readonly",
            "--mount", (f"type=volume,src={output_volume},dst=/output" if output_volume
                         else f"type=bind,src={output},dst=/output"),
            "--env", "HOME=/tmp", "--env", "PYTHONDONTWRITEBYTECODE=1",
            "--env", "TMPDIR=/work",
            "--env", "PYTHONUNBUFFERED=1", "--workdir", "/work", "--entrypoint", "python3",
            image, "/tool/closed_worker.py"]


def capture(command, log, timeout, *, env=None):
    """Drain all child output privately, cap disk use, kill on limit/deadline."""
    environment = env if env is not None else {key: os.environ[key] for key in ("PATH", "HOME", "DOCKER_HOST") if key in os.environ}
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               stdin=subprocess.DEVNULL, env=environment, start_new_session=True)
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector, log.open("ab") as stream:
            total = stream.tell()
            require(total <= MAX_LOG)
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                require(time.monotonic() < deadline)
                for key, _ in selector.select(timeout=0.2):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    remaining = MAX_LOG - total
                    stream.write(chunk[:remaining])
                    total += len(chunk)
                    require(total <= MAX_LOG)
            require(process.wait(timeout=max(0.1, deadline - time.monotonic())) == 0)
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        process.stdout.close()


def run_worker(image, source, public, output, context, log, *, timeout=900):
    name = "closed-" + uuid.uuid4().hex
    volume, anchor = name + "-output", name + "-anchor"
    output.mkdir()
    command = container_command(image, name, source, public, output, context, output_volume=volume)
    try:
        capture(["docker", "volume", "create", "--driver", "local", "--opt", "type=tmpfs",
                 "--opt", "device=tmpfs", "--opt", "o=size=128m,uid=65532,gid=65532,mode=0700,nosuid,nodev,noexec",
                 volume], log, 30)
        # The anchor keeps the bounded tmpfs alive after the worker exits.
        capture(["docker", "run", "--detach", "--name", anchor, "--pull", "never",
                 "--network", "none", "--user", "65532:65532", "--cap-drop", "ALL",
                 "--security-opt", "no-new-privileges", "--read-only", "--pids-limit", "16",
                 "--memory", "64m", "--log-driver", "none", "--mount", f"type=volume,src={volume},dst=/output",
                 "--entrypoint", "python3", image, "-c", "import time;time.sleep(1500)"], log, 30)
        capture(command, log, timeout)
        inspect = ("import os,stat; p='/output'; "
                   "assert set(os.listdir(p))=={'home-package.tar.gz','acceptance.json'}; "
                   "s=[os.lstat(p+'/'+n) for n in os.listdir(p)]; "
                   "assert all(stat.S_ISREG(i.st_mode) and i.st_nlink==1 and i.st_size<=67108864 for i in s)")
        capture(["docker", "exec", anchor, "python3", "-c", inspect], log, 30)
        for filename in ("home-package.tar.gz", "acceptance.json"):
            capture(["docker", "cp", anchor + ":/output/" + filename, str(output / filename)], log, 60)
    finally:
        # Never let Docker errors expose captured worker output.
        for cleanup in (["docker", "rm", "--force", name, anchor], ["docker", "volume", "rm", volume]):
            try:
                subprocess.run(cleanup, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, timeout=30,
                               env={key: os.environ[key] for key in ("PATH", "HOME", "DOCKER_HOST") if key in os.environ}, check=False)
            except (OSError, subprocess.TimeoutExpired):
                # Best-effort cleanup must not replace the original bounded diagnostic.
                pass


def validate_output(output, public, build_mode, *, synthetic=False):
    require({path.name for path in output.iterdir()} == {"home-package.tar.gz", "acceptance.json"})
    evidence = decode_json(regular(output / "acceptance.json", 100_000))
    require(evidence.get("schema") == 1 and evidence.get("passed") is True)
    if synthetic:
        require(evidence.get("fixture") is True and evidence.get("checks") == ["transport"])
    else:
        require(not evidence.get("fixture") and set(evidence.get("checks", [])) >= REQUIRED_CHECKS)
    if build_mode == "rebuild-preserve":
        require("geometry" in evidence["checks"])
    payload = regular(output / "home-package.tar.gz")
    with tempfile.TemporaryDirectory(prefix="closed-check-") as directory:
        extracted = Path(directory)
        extract_tar(payload, extracted)
        component = extracted / "custom_components/home_floorplan"
        require(component.is_dir() and (component / "site.json").is_file())
        require(all(path.is_relative_to(component) for path in extracted.rglob("*") if path.is_file()))
        for path in (public / "component").rglob("*"):
            if path.is_file():
                require(regular(component / path.relative_to(public / "component")) == regular(path))
    return payload, evidence


def pack_candidate(payload, manifest, installer):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:gz", format=tarfile.USTAR_FORMAT) as archive:
        for name, data in (("candidate.json", canonical(manifest)), ("home-package.tar.gz", payload),
                           ("install-home-assistant.py", installer)):
            member = tarfile.TarInfo(name)
            member.size, member.mode = len(data), 0o644
            archive.addfile(member, io.BytesIO(data))
    return stream.getvalue()


def policy():
    value = decode_json(regular(ROOT / ".closed-build-policy.json", 100_000))
    require(value["schema"] == 1 and IMAGE.fullmatch(value["worker_image"]) is not None)
    return value


def make_readable(root):
    root.chmod(0o755)
    for path in root.rglob("*"):
        path.chmod(0o755 if path.is_dir() else 0o644)


def prepare(args, temporary):
    """Prepare public-only dependencies before the workflow exposes secrets."""
    configured = policy()
    require(not args.prepared_root.exists())
    args.prepared_root.mkdir(parents=True)
    capture(["docker", "pull", configured["worker_image"]], temporary / "prepare.log", 300)
    dependencies = args.prepared_root / "dependencies"
    dependencies.mkdir()
    for name, lock in configured["dependencies"].items():
        require(REQUEST.fullmatch(name) is not None and re.fullmatch(r"[0-9a-f]{40}", lock["commit"]) is not None)
        require(re.fullmatch(r"https://github.com/ha-homelab/[a-zA-Z0-9_.-]+\.git", lock["repository"]) is not None)
        checkout = temporary / name
        checkout.mkdir()
        prefix = ["git", "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", "-C", str(checkout)]
        for command in (["init", "--quiet"], ["remote", "add", "origin", lock["repository"]],
                        ["fetch", "--depth=1", "--no-tags", "origin", lock["commit"]],
                        ["checkout", "--detach", "--quiet", lock["commit"]]):
            capture(prefix + command, temporary / "prepare.log", 120)
        destination = dependencies / name
        shutil.copytree(checkout, destination, ignore=shutil.ignore_patterns(".git"), symlinks=True)
        files = {}
        for path in destination.rglob("*"):
            require(not path.is_symlink())
            if path.is_file():
                files[path.relative_to(destination).as_posix()] = digest(regular(path))
        (destination / "dependency.json").write_bytes(canonical({**lock, "files": files}))
    (args.prepared_root / "prepared.json").write_bytes(canonical(configured))
    make_readable(args.prepared_root)
    return "CLOSED_PUBLIC_TOOLS_READY"


def execute(args, temporary):
    gate_environment(os.environ)
    require(not args.closed_request or REQUEST.fullmatch(args.closed_request) is not None)
    configured = policy()
    image = configured["worker_image"]
    require(decode_json(regular(args.prepared_root / "prepared.json")) == configured)
    context, public = public_inputs(args, temporary)
    if args.action == "validate":
        # Accepted records are issued by the deployment client after actual publication.
        accepted = decode_json(open_envelope(transport(os.environ["CLOSED_ACCEPTANCE_READ_URL"]),
            os.environ["CLOSED_INPUT_DECRYPT_KEY"], os.environ["CLOSED_INPUT_VERIFY_KEY"], purpose="acceptance"))
        validate_acceptance(accepted, context, args.closed_request)
        validate_accepted_build(accepted)
        encrypted = transport(os.environ["CLOSED_OUTPUT_READ_URL"], suffix=accepted["candidate_object"])
        require(digest(encrypted) == accepted["candidate_sha256"])
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        public_signer = Ed25519PrivateKey.from_private_bytes(unb64(os.environ["CLOSED_OUTPUT_SIGN_KEY"], 32)).public_key()
        verify_envelope(encrypted, b64(public_signer.public_bytes_raw()), purpose="candidate")
        return "CLOSED_ACCEPTED_BYTES_VALIDATED"
    encrypted = transport(os.environ["CLOSED_INPUT_READ_URL"])
    plain = open_envelope(encrypted, os.environ["CLOSED_INPUT_DECRYPT_KEY"],
                          os.environ["CLOSED_INPUT_VERIFY_KEY"], purpose="input")
    source = temporary / "input"
    source.mkdir()
    extract_tar(plain, source)
    if not args.closed_request:
        args.closed_request = decode_json(regular(source / "closed-build.json", 2_000_000))["request_id"]
        require(REQUEST.fullmatch(args.closed_request) is not None)
    intent = validate_input(source, context, args.closed_request, image)
    timeout = intent.get("worker_timeout_seconds", 900)
    require(type(timeout) is int and 1 <= timeout <= 900)
    context_dir = temporary / "context"
    context_dir.mkdir()
    effective = {"schema": 1, "public": context, "original_core_lock": intent["original_core_lock"],
                 "effective_core_lock": {"repository": intent["original_core_lock"]["repository"],
                                         "commit": context["source_sha"]}}
    (context_dir / "build.json").write_bytes(canonical(effective))
    for directory in (source, public, context_dir):
        make_readable(directory)
    output = temporary / "output"
    run_worker(image, source, public, output, context_dir, temporary / "private.log", timeout=timeout)
    payload, evidence = validate_output(output, public, intent["build_mode"], synthetic=intent.get("synthetic") is True)
    installer = regular(public / "source/scripts/install-home-assistant.py")
    candidate = {"schema": 1, "state": "candidate", "request_id": args.closed_request,
                 "input_sha256": digest(encrypted), "source_bundle_sha256": digest(plain),
                 "intent_sha256": digest(canonical(intent)), "public": context,
                 "input_policy_sha256": digest(canonical(intent.get("target_policy", intent.get("target")))),
                 "original_core_lock": effective["original_core_lock"],
                 "effective_core_lock": effective["effective_core_lock"],
                 "worker_image": image, "acceptance_policy": intent["acceptance_policy"], "checks": evidence,
                 "synthetic": intent.get("synthetic") is True,
                 "build_mode": intent["build_mode"], "installer_sha256": digest(installer), "installer_size": len(installer),
                 "build_run_id": os.environ["GITHUB_RUN_ID"], "build_run_attempt": os.environ["GITHUB_RUN_ATTEMPT"],
                 "build_source_sha": os.environ["GITHUB_SHA"],
                 "private_source": intent.get("private_source"),
                 "payload_sha256": digest(payload), "payload_size": len(payload)}
    envelope = seal(pack_candidate(payload, candidate, installer), os.environ["CLOSED_OUTPUT_ENCRYPT_KEY"],
                    os.environ["CLOSED_OUTPUT_SIGN_KEY"], purpose="candidate")
    # Run/attempt object identity prevents an interrupted attempt overwriting another.
    object_name = args.closed_request + "/" + os.environ["GITHUB_RUN_ID"] + "-" + os.environ["GITHUB_RUN_ATTEMPT"] + ".candidate.json"
    transport(os.environ["CLOSED_OUTPUT_WRITE_URL"], data=envelope, suffix=object_name, create_only=True)
    return "CLOSED_CANDIDATE_STORED"


def validate_acceptance(accepted, context, request_id):
    require(accepted["schema"] == 1 and accepted["state"] == "accepted")
    require(REQUEST.fullmatch(accepted["request_id"]) is not None)
    require(not request_id or accepted["request_id"] == request_id)
    require(accepted["acceptance_policy"] == "ha-home-python-v1")
    for key in ("repository", "workflow", "source_sha", "plan_sha256", "payloads", "run_id", "run_attempt", "release_tag"):
        require(accepted["public"][key] == context[key])
    for key in ("candidate_sha256", "payload_sha256", "installer_sha256"):
        require(SHA.fullmatch(accepted[key]) is not None)
    require(re.fullmatch(r"[0-9a-f]{40}", accepted["build_source_sha"]) is not None)
    for key in ("build_run_id", "build_run_attempt"):
        require(re.fullmatch(r"[1-9][0-9]*", accepted[key]) is not None)
    for key in ("payload_size", "installer_size"):
        require(type(accepted[key]) is int and 0 < accepted[key] <= MAX_FILE)
    site = accepted["site_acceptance"]
    require(site["schema"] == 1 and site["state"] == "site-canary-passed")
    require(site["payload_sha256"] == accepted["payload_sha256"])
    require(site["checks"]["actual_ha"] is True and site["checks"]["browser"] is True)
    require(SHA.fullmatch(site["evidence_sha256"]) is not None
            and SHA.fullmatch(site["receipt_sha256"]) is not None)
    qualification = accepted["qualification"]
    require(qualification["status"] == "published" and qualification["conclusion"] == "success")
    require(qualification["public"] == accepted["public"])
    require(qualification["release_tag"] == context["release_tag"])
    for name, run_id, attempt in (("source_run", context["run_id"], context["run_attempt"]),
                                   ("closed_build_run", accepted["build_run_id"], accepted["build_run_attempt"])):
        run = qualification[name]
        require(run["conclusion"] == "success" and run["id"] == run_id)
        require(run["attempt"] == run["latest_attempt"] == attempt)
    require(accepted["candidate_object"] == accepted["request_id"] + "/" + accepted["build_run_id"] + "-" + accepted["build_run_attempt"] + ".candidate.json")


def validate_accepted_build(accepted):
    """Stable promotion requires the closed build to remain qualified today.

    The retained operator receipt authorizes later installation, but a new
    promotion must reject a build that has since been rerun or invalidated.
    Existing-release rebuilds have no Release gate in their own run.
    """
    import release_control
    gh = release_control.GitHub(REPOSITORY)
    run = gh.api("actions/runs/" + accepted["build_run_id"])
    require(str(run["id"]) == accepted["build_run_id"])
    require(str(run["repository"]["id"]) == REPOSITORY_ID
            and str(run["repository"]["owner"]["id"]) == OWNER_ID)
    release_control.validate_run(gh, run, {"default_branch": "main"},
        accepted["build_source_sha"], int(accepted["build_run_attempt"]), completed=True, gate=False)


def main(argv=None):
    class QuietParser(argparse.ArgumentParser):
        def error(self, message):
            raise Rejected()
    parser = QuietParser(description=__doc__)
    parser.add_argument("--action", choices=("prepare", "build", "rebuild", "validate"), required=True)
    parser.add_argument("--prepared-root", type=Path, required=True)
    parser.add_argument("--closed-request", default="")
    parser.add_argument("--release-plan-artifact", default="")
    parser.add_argument("--public-context-artifact", default="")
    parser.add_argument("--release-tag", default="")
    try:
        args = parser.parse_args(argv)
    except Rejected:
        print("CLOSED_REQUEST_REJECTED")
        return 1
    status, code = "CLOSED_BUILD_REJECTED", 1
    try:
        os.umask(0o077)
        with tempfile.TemporaryDirectory(prefix="closed-build-", ignore_cleanup_errors=True) as directory:
            temporary = Path(directory)
            try:
                status = prepare(args, temporary) if args.action == "prepare" else execute(args, temporary)
                code = 0
            except (Exception, KeyboardInterrupt, SystemExit):
                # Interrupts and explicit exits also stay behind the fixed public status boundary.
                # Exception details, including network/Docker failures, stay in the closed log.
                try:
                    with (temporary / "private.log").open("ab") as log:
                        remaining = max(0, MAX_LOG - log.tell())
                        log.write(traceback.format_exc().encode()[:remaining])
                except (Exception, KeyboardInterrupt, SystemExit):
                    # Formatting/writing diagnostics is inside the same private boundary.
                    # A second interruption must not expose the original exception chain.
                    pass
            finally:
                try:
                    log = temporary / "private.log"
                    if (log.exists() and REQUEST.fullmatch(args.closed_request)
                            and all(os.environ.get(key) for key in ("CLOSED_OUTPUT_ENCRYPT_KEY", "CLOSED_OUTPUT_SIGN_KEY", "CLOSED_OUTPUT_WRITE_URL"))):
                        encrypted = seal(regular(log, MAX_LOG), os.environ["CLOSED_OUTPUT_ENCRYPT_KEY"],
                                         os.environ["CLOSED_OUTPUT_SIGN_KEY"], purpose="diagnostic")
                        name = args.closed_request + "/" + os.environ["GITHUB_RUN_ID"] + "-" + os.environ["GITHUB_RUN_ATTEMPT"] + ".diagnostic.json"
                        transport(os.environ["CLOSED_OUTPUT_WRITE_URL"], data=encrypted, suffix=name)
                except (Exception, KeyboardInterrupt, SystemExit):
                    # An interrupted diagnostic upload must not emit a private traceback.
                    status, code = "CLOSED_DIAGNOSTIC_UPLOAD_FAILED", 1
    except (Exception, KeyboardInterrupt, SystemExit):
        # Temporary-directory entry/cleanup can also fail or be interrupted.
        # Never let that outer exception chain bypass fixed public statuses.
        status, code = "CLOSED_BUILD_REJECTED", 1
    print(status)
    return code


if __name__ == "__main__":
    sys.exit(main())
