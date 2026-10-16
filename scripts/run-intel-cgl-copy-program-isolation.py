#!/usr/bin/env python3
"""Run fixed source revisions' original native suites on one diagnostic host."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import threading
import time


BASELINE = '5563e3fdc147c81931389743836610ba611e7026'
DRIVER_REFERENCE = '258056dfd6426b90826f7ca75747ede77c636814'
CANDIDATES = {
    'copy-program-isolation': '258056dfd6426b90826f7ca75747ede77c636814',
}
CANDIDATE_CPU_CHECKS = ('scripts/test-literal-lambert-point-body.cjs',
                        'scripts/test-literal-lambert-directional.cjs',
                        'scripts/test-scalar-shadow-point.cjs',
                        'scripts/test-scalar-indirect-lambert.cjs',
                        'scripts/test-direct-shadow-uniforms.cjs',
                        'scripts/test-scalar-lambert-accumulators.cjs',
                        'scripts/test-interaction-render.cjs',
                        'scripts/test-render-lifecycle.cjs',
                        'scripts/test-native-viewer-programs.cjs')
CONTRACT_CPU_CHECKS = ('node baseline/scripts/test-native-viewer-programs.cjs',
                       'node baseline/scripts/test-interaction-render.cjs',
                       'python3 candidate/scripts/test-waterfox-tooling.py',
                       'python3 baseline/scripts/test-waterfox-tooling.py')
VERSIONS = {'firefox': '153.5.0esr', 'waterfox': '6.7.6'}
DRIVER_FILES = (
    'scripts/test-native-browser-acceptance.py', 'scripts/test-waterfox-acceptance.py',
    'scripts/native_browser.py', 'scripts/setup-native-browser.py',
    'scripts/firefox-versions.json', 'scripts/waterfox-versions.json',
    'scripts/test-browser-stability.cjs', 'scripts/test-planner-stability.cjs',
    'scripts/browser-stability-diagnostics.cjs', 'scripts/browser-startup-diagnostics.cjs',
    'package.json', 'package-lock.json',
    'scripts/native-viewer-program-diagnostics.js',
    'scripts/test-native-viewer-programs.cjs', 'scripts/test-waterfox-tooling.py',
)
PROFILE = {
    'NATIVE_STARTUP_DIAGNOSTICS': '1',
    'FIREFOX_RENDERER_VISIBILITY': 'unmasked',
    'FIREFOX_WEBGL_BACKEND': 'default',
    'FIREFOX_COMPOSITOR_BACKEND': 'software',
    'FIREFOX_GPU_PROCESS': 'disabled',
}


def validate_selection():
    """The prepared template cannot run with an unset or moving source."""
    if set(CANDIDATES) != {'copy-program-isolation'}:
        raise ValueError('Exactly one fixed candidate is required')
    revision = CANDIDATES['copy-program-isolation']
    if (not re.fullmatch(r'[0-9a-f]{40}', revision) or
            revision == BASELINE or revision == '0' * 40):
        raise ValueError('Select one exact non-baseline candidate SHA before running')
    if (not isinstance(CANDIDATE_CPU_CHECKS, tuple) or len(CANDIDATE_CPU_CHECKS) != 9 or
            len(set(CANDIDATE_CPU_CHECKS)) != 9 or
            any(not isinstance(proof, str) or not re.fullmatch(r'scripts/test-[a-z0-9-]+\.cjs', proof)
                for proof in CANDIDATE_CPU_CHECKS)):
        raise ValueError('Select nine distinct candidate CPU proofs before running')
    workflow = Path(__file__).resolve().parents[1] / '.github/workflows/intel-cgl-copy-program-isolation.yml'
    text = workflow.read_text(encoding='utf-8')
    if (text.count('revision: ' + revision) != 2 or
            any(text.count('node candidate/' + proof) != 1 for proof in CANDIDATE_CPU_CHECKS) or
            any(text.count(command) != 1 for command in CONTRACT_CPU_CHECKS)):
        raise ValueError('Workflow candidate pins or CPU proof disagree with the runner')


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


def require_indexing_host():
    """Never change a local, self-hosted, non-macOS or non-Intel machine."""
    if not (os.environ.get('GITHUB_ACTIONS') == 'true' and
            os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted' and
            os.environ.get('RUNNER_OS') == 'macOS' and
            sys.platform == 'darwin' and platform.machine() == 'x86_64'):
        raise ValueError('Spotlight control requires a GitHub-hosted Intel macOS Actions runner')


def indexing_command(path, disable=False):
    """Run only the fixed status or indexing-off command and retain bounded evidence."""
    require_indexing_host()
    command = (['/usr/bin/sudo', '-n', '/usr/bin/mdutil', '-a', '-i', 'off']
               if disable else ['/usr/bin/mdutil', '-a', '-s'])
    record = {'diagnosticOnly': True, 'command': command, 'startedAt': utc_now(),
              'timeoutSeconds': 15, 'outputLimitCharacters': 4096}
    started = time.monotonic()
    def capture(value):
        if isinstance(value, bytes):
            value = value.decode('utf-8', errors='replace')
        value = value or ''
        return value[:4096], len(value) > 4096
    try:
        environment = os.environ.copy()
        environment['LC_ALL'] = 'C'
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, check=False, timeout=15, env=environment)
        record.update(exitCode=result.returncode,
                      status='completed' if result.returncode == 0 else 'failed')
        stdout, stderr = result.stdout, result.stderr
    except (OSError, subprocess.TimeoutExpired) as error:
        record.update(exitCode=None, status='failed', error=type(error).__name__)
        stdout, stderr = getattr(error, 'stdout', None), getattr(error, 'stderr', None)
    record['stdout'], record['stdoutTruncated'] = capture(stdout)
    record['stderr'], record['stderrTruncated'] = capture(stderr)
    record['elapsedSeconds'] = time.monotonic() - started
    write_json(path, record)
    if record['status'] != 'completed':
        raise RuntimeError('Spotlight command failed; see ' + path.name)
    return record


def indexing_volumes(record):
    """Interpret complete mdutil status, rejecting unknown or partial evidence."""
    if record['stdoutTruncated'] or record['stderrTruncated']:
        raise ValueError('Spotlight status output is truncated')
    volumes, current = {}, None
    for raw in record['stdout'].splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith('/') and line.endswith(':'):
            if current is not None or line[:-1] in volumes:
                raise ValueError('Spotlight status contains an incomplete or duplicate volume')
            current = line[:-1]
        elif current is not None and line in (
                'Indexing enabled.', 'Indexing disabled.', 'Indexing and searching disabled.'):
            volumes[current] = line
            current = None
        else:
            raise ValueError('Spotlight status contains an unrecognized result')
    if current is not None or not volumes:
        raise ValueError('Spotlight status has no complete volume inventory')
    return volumes


def verify_indexing_disabled(record, expected_volumes):
    volumes = indexing_volumes(record)
    if set(volumes) != set(expected_volumes) or any(
            value == 'Indexing enabled.' for value in volumes.values()):
        raise ValueError('Spotlight indexing-off state was not verified for every initial volume')


def cpu_processes():
    """Return only numeric process fields and executable basenames, never argv."""
    environment = os.environ.copy()
    environment['LC_ALL'] = 'C'
    result = subprocess.run(
        ['/bin/ps', '-axo', 'pid=,ppid=,%cpu=,rss=,comm='],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
        check=False, timeout=2, env=environment)
    if result.returncode:
        return {'status': 'error', 'error': 'ps-exit', 'exitCode': result.returncode}
    processes, discarded = [], 0
    for line in result.stdout.splitlines():
        try:
            pid, ppid, cpu, rss, executable = line.strip().split(None, 4)
            pid, ppid, cpu, rss = int(pid), int(ppid), float(cpu), int(rss)
            if pid <= 0 or ppid < 0 or not math.isfinite(cpu) or cpu < 0 or rss < 0:
                raise ValueError('Invalid numeric process field')
            name = executable.rsplit('/', 1)[-1][:128]
            if not name or any(ord(character) < 32 for character in name):
                raise ValueError('Invalid executable name')
            processes.append({'pid': pid, 'ppid': ppid, 'cpuPercent': cpu,
                              'rssKiB': rss, 'name': name})
        except ValueError:
            discarded += 1
    processes.sort(key=lambda process: (-process['cpuPercent'], process['pid']))
    return {'status': 'ok', 'processes': processes[:8], 'discardedRows': discarded}


class CPUSampler:
    """Small passive diagnostic; failures never change the original suite result."""
    interval = 5
    maximum = 240

    def __init__(self, path):
        self.path = path
        self.stop_event = threading.Event()
        self.thread = None
        self.started = time.monotonic()
        self.records = 0
        self.errors = []

    def note_error(self, operation, error):
        if len(self.errors) < 8:
            # Exception messages can contain raw command output: retain type only.
            self.errors.append({'operation': operation, 'type': type(error).__name__})

    def sample(self, phase):
        if self.records >= self.maximum:
            return
        self.records += 1
        record = {'diagnosticOnly': True, 'sample': self.records, 'phase': phase,
                  'capturedAt': utc_now(), 'elapsedSeconds': time.monotonic() - self.started}
        try:
            record.update(cpu_processes())
        except Exception as error:
            self.note_error('capture', error)
            record.update(status='error', error=type(error).__name__)
        try:
            with self.path.open('a', encoding='utf-8') as output:
                output.write(json.dumps(record) + '\n')
        except Exception as error:
            self.note_error('write', error)

    def run(self):
        try:
            # Reserve one record for the final post-suite capture.
            while self.records < self.maximum - 1 and not self.stop_event.wait(self.interval):
                self.sample('during')
        except Exception as error:
            self.note_error('thread', error)

    def start(self):
        self.sample('before')
        try:
            thread = threading.Thread(target=self.run, name='diagnostic-cpu', daemon=True)
            thread.start()
            self.thread = thread
        except Exception as error:
            self.note_error('start', error)

    def finish(self):
        self.stop_event.set()
        if self.thread is not None:
            # Each in-flight ps has a two-second timeout; do not leave a sampler
            # running into the next arm or its preflight/source hashing.
            try:
                self.thread.join()
            except Exception as error:
                self.note_error('join', error)
        self.sample('after')
        return {'file': self.path.name, 'diagnosticOnly': True,
                'intervalSeconds': self.interval, 'maximumRecords': self.maximum,
                'attemptedRecords': self.records, 'errors': self.errors,
                'cpuSemantics': 'ps-reported %CPU; not interval CPU utilization'}


def command_for(source, installation, output, product):
    # No copied fixture, monkeypatch, case filter, retry or changed deadline.
    return [sys.executable, str(source / 'scripts/test-native-browser-acceptance.py'),
            '--product', product, '--expected-version', VERSIONS[product],
            '--installation', str(installation), '--output', str(output / 'raw')]


def run_comparison(source_root, installation, output, candidate, product):
    arms = (('candidate', CANDIDATES[candidate]), ('baseline', BASELINE))
    output.mkdir(parents=True, exist_ok=True)
    manifest = {
        'schema': 1, 'diagnosticOnly': True, 'releaseEligible': False, 'acceptanceStatus': 'not-run',
        'purpose': 'Candidate-first same-host Intel copy program isolation comparison with common Spotlight normalization; never release qualification',
        'candidate': candidate, 'product': product, 'expectedVersion': VERSIONS[product],
        'driverReferenceRevision': DRIVER_REFERENCE,
        'driverContract': '258056d strict copy-provenance contract, identical in both arms; prior 40333 failure is unchanged',
        'startedAt': utc_now(), 'status': 'preparing', 'arms': [],
        'order': [name for name, _ in arms],
        'cacheLimitation': 'Fixed candidate-first order; shared host and OS/driver caches are not cleared. This is not a randomized performance estimate.',
        'host': {'system': platform.system(), 'machine': platform.machine(),
                 'platform': platform.platform(), 'python': sys.version},
        'profile': PROFILE, 'harnessRevision': os.environ.get('GITHUB_SHA'),
        'runnerSha256': digest(Path(__file__)),
    }
    manifest_path = output / 'comparison.json'
    write_json(manifest_path, manifest)
    try:
        validate_selection()
        require_indexing_host()
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
        manifest['indexingControl'] = {'scope': 'both-arms', 'before': 'indexing-before.json',
                                       'disable': 'indexing-disable.json',
                                       'after': 'indexing-after.json', 'verifiedDisabled': False}
        write_json(manifest_path, manifest)
        # Normalize once, before either timed suite. The only per-arm Spotlight
        # operation is a read-only verification; never repair drift mid-pair.
        before_indexing = indexing_volumes(indexing_command(output / 'indexing-before.json'))
        indexing_command(output / 'indexing-disable.json', disable=True)
        verify_indexing_disabled(indexing_command(output / 'indexing-after.json'), before_indexing)
        manifest['indexingControl']['verifiedDisabled'] = True
        write_json(manifest_path, manifest)
        for arm in manifest['arms']:
            name, revision = arm['name'], arm['sourceRevision']
            source, arm_output = source_root / name, output / name
            arm['indexingStatus'] = {'file': 'indexing-before.json', 'verifiedDisabled': False}
            try:
                verify_indexing_disabled(indexing_command(arm_output / 'indexing-before.json'), before_indexing)
                arm['indexingStatus']['verifiedDisabled'] = True
            except Exception as error:
                arm.update(status='infrastructure-error', error=f'{type(error).__name__}: {error}')
                raise
            command = command_for(source, installation, arm_output, product)
            arm['hostResourcesBefore'] = host_resources()
            write_json(arm_output / 'host-before.json', arm['hostResourcesBefore'])
            arm.update(status='running', startedAt=utc_now(), command=command)
            write_json(manifest_path, manifest)
            sampler = CPUSampler(arm_output / 'cpu-processes.jsonl')
            sampler.start()
            started = time.monotonic()
            try:
                try:
                    environment = os.environ.copy()
                    environment.update(PROFILE, GITHUB_SHA=revision, PYTHONUTF8='1')
                    with (arm_output / 'process.log').open('wb') as log:
                        result = subprocess.run(command, cwd=source, env=environment,
                                                stdout=log, stderr=subprocess.STDOUT, check=False)
                finally:
                    # Preserve suite duration before waiting for sampler shutdown.
                    arm['suiteElapsedSeconds'] = time.monotonic() - started
                    arm['cpuSampler'] = sampler.finish()
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
    if sys.argv[1:] == ['--validate-selection']:
        validate_selection()
        return 0
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
