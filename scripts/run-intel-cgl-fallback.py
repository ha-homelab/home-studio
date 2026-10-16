#!/usr/bin/env python3
"""Run fixed source revisions' original native suites on one diagnostic host."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time


ARMS = (
    ('baseline', '9b8d52b164eb1364ce8504063096a506c63100eb'),
    ('fallback-shared', 'f4a9ebba66b8f7ddce017535092f1885fbbfa8c0'),
)
DRIVER_FILES = ('scripts/test-native-browser-acceptance.py', 'scripts/test-waterfox-acceptance.py')
PROFILE = {
    'NATIVE_STARTUP_DIAGNOSTICS': '1',
    'FIREFOX_RENDERER_VISIBILITY': 'unmasked',
    'FIREFOX_WEBGL_BACKEND': 'default',
    'FIREFOX_COMPOSITOR_BACKEND': 'software',
    'FIREFOX_GPU_PROCESS': 'disabled',
}


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def source_snapshot(source, expected):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(source), *args]).decode().strip()
    actual = git('rev-parse', 'HEAD')
    if actual != expected:
        raise ValueError(f'{source.name}: expected {expected}, got {actual}')
    if git('status', '--porcelain', '--untracked-files=no'):
        raise ValueError(f'{source.name}: tracked source is modified')
    paths = git('ls-files', '-z').split('\0')
    return {'revision': actual, 'files': {name: digest(source / name) for name in paths if name}}


def command_for(source, installation, output):
    # No copied fixture, monkeypatch, case filter, retry or changed deadline.
    return [sys.executable, str(source / 'scripts/test-native-browser-acceptance.py'),
            '--product', 'firefox', '--expected-version', '153.5.0esr',
            '--installation', str(installation), '--output', str(output / 'raw')]


def run_comparison(source_root, installation, output):
    output.mkdir(parents=True, exist_ok=True)
    manifest = {
        'schema': 1, 'diagnosticOnly': True, 'releaseEligible': False, 'acceptanceStatus': 'not-run',
        'purpose': 'Same-host packed-run baseline versus fallback shared-program comparison; never release qualification',
        'startedAt': utc_now(), 'status': 'preparing', 'arms': [],
        'order': [name for name, _ in ARMS],
        'cacheLimitation': 'Fixed baseline-first order; shared host and OS/driver caches are not cleared. This is not a randomized performance estimate.',
        'host': {'system': platform.system(), 'machine': platform.machine(),
                 'platform': platform.platform(), 'python': sys.version},
        'profile': PROFILE, 'harnessRevision': os.environ.get('GITHUB_SHA'),
        'runnerSha256': digest(Path(__file__)),
    }
    manifest_path = output / 'comparison.json'
    write_json(manifest_path, manifest)
    try:
        if platform.system() != 'Darwin' or platform.machine() != 'x86_64':
            raise ValueError('This diagnostic requires the native macos-15-intel runner')
        manifest['installationSha256'] = digest(installation)
        manifest['installation'] = json.loads(installation.read_text(encoding='utf-8'))
        # Preflight every source before running any arm. Include all tracked
        # files so both runtime and fixture/driver dependencies are attributable.
        for name, revision in ARMS:
            arm_output = output / name
            arm_output.mkdir()
            snapshot = source_snapshot(source_root / name, revision)
            write_json(arm_output / 'source-before.json', snapshot)
            driver_hashes = {path: snapshot['files'][path] for path in DRIVER_FILES}
            manifest['arms'].append({'name': name, 'sourceRevision': revision,
                                     'driverSha256': driver_hashes, 'status': 'pending', 'exitCode': None})
            if 'driverSha256' not in manifest:
                manifest['driverSha256'] = driver_hashes
            elif driver_hashes != manifest['driverSha256']:
                raise ValueError(f'{name}: original acceptance driver differs between source arms')
        manifest['status'] = 'running'
        write_json(manifest_path, manifest)
        for arm in manifest['arms']:
            name, revision = arm['name'], arm['sourceRevision']
            source, arm_output = source_root / name, output / name
            command = command_for(source, installation, arm_output)
            arm.update(status='running', startedAt=utc_now(), command=command)
            write_json(manifest_path, manifest)
            started = time.monotonic()
            try:
                environment = os.environ.copy()
                environment.update(PROFILE, GITHUB_SHA=revision, PYTHONUTF8='1')
                with (arm_output / 'process.log').open('wb') as log:
                    result = subprocess.run(command, cwd=source, env=environment,
                                            stdout=log, stderr=subprocess.STDOUT, check=False)
                arm['exitCode'] = result.returncode
                arm['status'] = 'passed' if result.returncode == 0 else 'failed'
                after = source_snapshot(source, revision)
                write_json(arm_output / 'source-after.json', after)
                before = json.loads((arm_output / 'source-before.json').read_text())
                if before != after or digest(installation) != manifest['installationSha256']:
                    raise ValueError('Source or installation receipt changed during the comparison')
                arm['sourceUnchanged'] = True
            except Exception as error:
                arm.update(status='infrastructure-error', error=f'{type(error).__name__}: {error}')
            finally:
                arm.update(finishedAt=utc_now(), elapsedSeconds=time.monotonic() - started)
                write_json(manifest_path, manifest)
        manifest['status'] = 'completed' if all(arm['status'] == 'passed' for arm in manifest['arms']) else 'failed'
    except Exception as error:
        manifest.update(status='infrastructure-error', error=f'{type(error).__name__}: {error}')
    finally:
        manifest['finishedAt'] = utc_now()
        write_json(manifest_path, manifest)
    return 0 if manifest['status'] == 'completed' else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', required=True, type=Path)
    parser.add_argument('--installation', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    return run_comparison(args.source_root.resolve(), args.installation.resolve(), args.output.resolve())


if __name__ == '__main__':
    sys.exit(main())
