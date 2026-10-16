#!/usr/bin/env python3
"""Run one fixed Intel acceptance source, then its existing failure diagnostic."""
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


REVISION = 'd934c6a515131163c48c5bf84f7629ab4a2fdc40'
PROFILE = {
    'NATIVE_STARTUP_DIAGNOSTICS': '1',
    'FIREFOX_RENDERER_VISIBILITY': 'unmasked',
    'FIREFOX_WEBGL_BACKEND': 'default',
    'FIREFOX_COMPOSITOR_BACKEND': 'software',
    'FIREFOX_GPU_PROCESS': 'disabled',
}
DRIVER_FILES = ('scripts/test-native-browser-acceptance.py', 'scripts/test-waterfox-acceptance.py',
                'scripts/diagnose-native-draw.py', 'scripts/native-draw-diagnostic.js')


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def snapshot(source):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(source), *args]).decode().strip()
    if git('rev-parse', 'HEAD') != REVISION:
        raise ValueError('Source must be the exact reviewed diagnostic revision')
    if git('status', '--porcelain', '--untracked-files=no'):
        raise ValueError('Tracked source is modified')
    return {name: digest(source / name) for name in git('ls-files', '-z').split('\0') if name}


def json_receipts(directory):
    return {str(path.relative_to(directory)): digest(path) for path in directory.rglob('*.json')}


def run(source, installation, output):
    output.mkdir(parents=True, exist_ok=True)
    record = {'diagnosticOnly': True, 'acceptanceStatus': 'not-run',
              'purpose': 'Non-release Intel submitted-uniform and pre-draw drain evidence',
              'sourceRevision': REVISION, 'harnessRevision': os.environ.get('GITHUB_SHA'),
              'runnerSha256': digest(Path(__file__)), 'profile': PROFILE,
              'host': {'system': platform.system(), 'machine': platform.machine(),
                       'platform': platform.platform(), 'python': sys.version},
              'startedAt': now(), 'status': 'preparing', 'steps': []}
    manifest = output / 'manifest.json'
    save(manifest, record)
    try:
        if platform.system() != 'Darwin' or platform.machine() != 'x86_64':
            raise ValueError('This diagnostic requires native macos-15-intel')
        before = snapshot(source)
        save(output / 'source-before.json', before)
        record['driverSha256'] = {name: before[name] for name in DRIVER_FILES}
        record['installationSha256'] = digest(installation)
        record['installation'] = json.loads(installation.read_text(encoding='utf-8'))
        environment = os.environ.copy()
        environment.update(PROFILE, GITHUB_SHA=REVISION, PYTHONUTF8='1')
        common = ['--product', 'firefox', '--expected-version', '153.5.0esr',
                  '--installation', str(installation)]

        def invoke(name, script, arguments):
            command = [sys.executable, str(source / 'scripts' / script), *common, *arguments]
            step = {'name': name, 'command': command, 'startedAt': now(), 'status': 'running'}
            record['steps'].append(step)
            record['status'] = 'running'
            save(manifest, record)
            started = time.monotonic()
            with (output / (name + '.log')).open('wb') as log:
                result = subprocess.run(command, cwd=source, env=environment,
                                        stdout=log, stderr=subprocess.STDOUT, check=False)
            step.update(exitCode=result.returncode, finishedAt=now(),
                        elapsedSeconds=time.monotonic() - started,
                        status='passed' if result.returncode == 0 else 'failed')
            save(manifest, record)
            return result.returncode

        primary = output / 'primary'
        primary_exit = invoke('primary', 'test-native-browser-acceptance.py', ['--output', str(primary)])
        original_receipts = json_receipts(primary)
        save(output / 'primary-receipt-hashes.json', original_receipts)
        diagnostic_exit = None
        record.update(primaryExitCode=primary_exit, diagnosticExitCode=None)
        save(manifest, record)
        if primary_exit != 0:
            diagnostic_exit = invoke('draw-diagnostic', 'diagnose-native-draw.py', [
                '--primary-output', str(primary), '--output', str(output / 'diagnostics/first-frame')])
        record.update(primaryExitCode=primary_exit, diagnosticExitCode=diagnostic_exit)
        after = snapshot(source)
        save(output / 'source-after.json', after)
        if before != after or digest(installation) != record['installationSha256']:
            raise ValueError('Source or installation receipt changed')
        if original_receipts != json_receipts(primary):
            raise ValueError('Failure diagnostic changed the original primary receipts')
        record.update(sourceUnchanged=True, primaryReceiptsUnchanged=True,
                      status='completed' if primary_exit == 0 and diagnostic_exit in (None, 0) else 'failed')
    except Exception as error:
        record.update(status='infrastructure-error', error=f'{type(error).__name__}: {error}')
    finally:
        record['finishedAt'] = now()
        save(manifest, record)
    return 0 if record['status'] == 'completed' else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--installation', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    arguments = parser.parse_args()
    sys.exit(run(arguments.source.resolve(), arguments.installation.resolve(), arguments.output.resolve()))
