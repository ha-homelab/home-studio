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


BASELINE = '13b8ed9e1f0baf68eac329764a05277377113419'
CANDIDATES = {
    'point-count-guard': 'fef79d899c24371c41f94d22938851c07569d55a',
    'lambert-locals': '9590f9944359785edf5634df8cfa9a20cee35aac',
}
VERSIONS = {'firefox': '153.5.0esr', 'waterfox': '6.7.6'}
DRIVER_FILES = (
    'scripts/test-native-browser-acceptance.py', 'scripts/test-waterfox-acceptance.py',
    'scripts/native_browser.py', 'scripts/setup-native-browser.py',
    'scripts/firefox-versions.json', 'scripts/waterfox-versions.json',
    'scripts/test-browser-stability.cjs', 'scripts/test-planner-stability.cjs',
    'scripts/browser-stability-diagnostics.cjs', 'scripts/browser-startup-diagnostics.cjs',
    'package.json', 'package-lock.json',
)
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


def host_resources():
    """Read only compact host metadata; no process inventory or benchmark."""
    keys = ('machdep.cpu.brand_string', 'hw.model', 'hw.logicalcpu',
            'hw.physicalcpu', 'hw.memsize', 'kern.boottime')
    record = {'capturedAt': utc_now()}
    commands = (
        ('sysctl', ['/usr/sbin/sysctl', *keys]),
        ('uptime', ['/usr/bin/uptime']),
    )
    for name, command in commands:
        try:
            result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, check=False, timeout=5)
            record[name + 'ExitCode'] = result.returncode
            if name == 'sysctl':
                # Store only requested fields, never arbitrary command output.
                record[name] = {key: value.strip()[:256]
                                for line in result.stdout.splitlines()
                                for key, separator, value in [line.partition(':')]
                                if separator and key in keys}
            else:
                record[name] = result.stdout.strip()[:256]
        except (OSError, subprocess.TimeoutExpired) as error:
            record[name + 'Error'] = type(error).__name__
    return record


def command_for(source, installation, output, product):
    # No copied fixture, monkeypatch, case filter, retry or changed deadline.
    return [sys.executable, str(source / 'scripts/test-native-browser-acceptance.py'),
            '--product', product, '--expected-version', VERSIONS[product],
            '--installation', str(installation), '--output', str(output / 'raw')]


def run_comparison(source_root, installation, output, candidate, product):
    arms = (('baseline', BASELINE), ('candidate', CANDIDATES[candidate]))
    output.mkdir(parents=True, exist_ok=True)
    manifest = {
        'schema': 1, 'diagnosticOnly': True, 'releaseEligible': False, 'acceptanceStatus': 'not-run',
        'purpose': 'Same-host Intel native shader architecture comparison; never release qualification',
        'candidate': candidate, 'product': product, 'expectedVersion': VERSIONS[product],
        'startedAt': utc_now(), 'status': 'preparing', 'arms': [],
        'order': [name for name, _ in arms],
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
        overrides = sorted(key for key in os.environ if key.startswith(
            ('HOME_STUDIO_', 'BROWSER_STABILITY_', 'PLANNER_STABILITY_')))
        if overrides:
            raise ValueError('Unexpected fixture override names: ' + ', '.join(overrides))
        manifest['installationSha256'] = digest(installation)
        manifest['installation'] = json.loads(installation.read_text(encoding='utf-8'))
        # Preflight every source before running any arm. Include all tracked
        # files so both runtime and fixture/driver dependencies are attributable.
        for name, revision in arms:
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
            command = command_for(source, installation, arm_output, product)
            arm['hostResourcesBefore'] = host_resources()
            write_json(arm_output / 'host-before.json', arm['hostResourcesBefore'])
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
    parser.add_argument('--candidate', required=True, choices=CANDIDATES)
    parser.add_argument('--product', required=True, choices=VERSIONS)
    args = parser.parse_args()
    return run_comparison(args.source_root.resolve(), args.installation.resolve(), args.output.resolve(),
                          args.candidate, args.product)


if __name__ == '__main__':
    sys.exit(main())
