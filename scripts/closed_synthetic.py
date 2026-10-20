#!/usr/bin/env python3
"""Create an encrypted fictional input for real hosted transport acceptance.

Keys and the unique canary are read from local files, never from CLI values.
The output contains no actual home input. Nothing is uploaded or dispatched.
"""
import argparse
import io
from pathlib import Path
import sys
import tarfile

from closed_envelope import canonical, decode_json, digest, seal, b64

ENTRYPOINT = r'''import argparse,json,pathlib,sys,tarfile,time
p=argparse.ArgumentParser()
for name in ('public-source','public-component','dependency-root','output','context'): p.add_argument('--'+name)
a=p.parse_args()
fixture=json.loads(pathlib.Path('fixture.json').read_text())
print(fixture['canary'])
print(fixture['canary'],file=sys.stderr)
if fixture['mode']=='failure': raise RuntimeError(fixture['canary'])
if fixture['mode']=='timeout': time.sleep(120)
import io
with tarfile.open(a.output,'w:gz',format=tarfile.PAX_FORMAT) as archive:
 for path in sorted(pathlib.Path(a.public_component).rglob('*')):
  if path.is_file():
   data=path.read_bytes();member=tarfile.TarInfo('custom_components/home_floorplan/'+path.relative_to(a.public_component).as_posix())
   member.mode=0o644;member.size=len(data);archive.addfile(member,io.BytesIO(data))
 data=json.dumps({'schema_version':1,'site_id':'fictional','floors':{}}).encode()
 member=tarfile.TarInfo('custom_components/home_floorplan/site.json');member.size=len(data);archive.addfile(member,io.BytesIO(data))
pathlib.Path(a.output).with_name('acceptance.json').write_text(json.dumps({'schema':1,'passed':True,'checks':['transport'],'fixture':True,'geometry_rebuild':'skipped'}))
'''


def create(args):
    context = decode_json(args.context.read_bytes())
    policy = decode_json((Path(__file__).resolve().parents[1] / ".closed-build-policy.json").read_bytes())
    lock = {"repository": "https://github.com/ha-homelab/home-studio.git", "commit": context["source_sha"]}
    files = {"scripts/closed-build-entry.py": ENTRYPOINT.encode(),
             "public-core.lock.json": canonical(lock),
             "fixture.json": canonical({"canary": args.canary_file.read_text().strip(), "mode": args.mode})}
    manifest = {"schema": 1, "request_id": args.request_id, "entrypoint": "scripts/closed-build-entry.py",
                "acceptance_policy": "transport-canary-v1", "synthetic": True, "build_mode": "package-only",
                "worker_image": policy["worker_image"], "original_core_lock": lock,
                "worker_timeout_seconds": 2 if args.mode == "timeout" else 900,
                "target": {key: context[key] for key in ("source_sha", "plan_sha256", "payloads")},
                "files": {name: digest(data) for name, data in files.items()}}
    files["closed-build.json"] = canonical(manifest)
    packed = io.BytesIO()
    with tarfile.open(fileobj=packed, mode="w:gz", format=tarfile.USTAR_FORMAT) as archive:
        for name, data in files.items():
            item = tarfile.TarInfo(name)
            item.mode, item.size = 0o644, len(data)
            archive.addfile(item, io.BytesIO(data))
    envelope = seal(packed.getvalue(), args.encrypt_key_file.read_text().strip(),
                    args.sign_key_file.read_text().strip(), purpose="input")
    if args.mode == "invalid-signature":
        changed = decode_json(envelope)
        changed["signature"] = b64(bytes(64))
        envelope = canonical(changed)
    with args.output.open("xb") as stream:
        stream.write(envelope)
    args.output.chmod(0o600)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", type=Path, required=True)
    parser.add_argument("--request-id", required=True)
    parser.add_argument("--canary-file", type=Path, required=True)
    parser.add_argument("--encrypt-key-file", type=Path, required=True)
    parser.add_argument("--sign-key-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--mode", choices=("success", "failure", "timeout", "invalid-signature"), default="success")
    args = parser.parse_args()
    try:
        create(args)
    except Exception:
        print("SYNTHETIC_INPUT_FAILED")
        return 1
    print("SYNTHETIC_INPUT_CREATED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
