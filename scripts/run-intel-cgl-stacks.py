#!/usr/bin/env python3
"""Diagnostic-only stack sampling around an unchanged native viewer-24 case."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import inspect
import json
import math
import os
from pathlib import Path
import platform
import subprocess
import sys
import threading
import time

SOURCE = '7b7a896225aaf27fef26a135d654dfaddffe2c08'
MAIN_FRAGMENT = 'fnv1a32:c2019e3f'
SAMPLE_SECONDS = 10
SAMPLE_INTERVAL_MS = 10
COMMAND_SECONDS = 60  # Includes symbolication after the ten-second capture.
REPORT_LIMIT = 8 * 1024 * 1024
LOG_LIMIT = 64 * 1024
PROFILE = {'NATIVE_STARTUP_DIAGNOSTICS': '1', 'FIREFOX_RENDERER_VISIBILITY': 'unmasked',
           'FIREFOX_WEBGL_BACKEND': 'default', 'FIREFOX_COMPOSITOR_BACKEND': 'software',
           'FIREFOX_GPU_PROCESS': 'disabled'}


def now():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, data):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require_host():
    if not (os.environ.get('GITHUB_ACTIONS') == 'true' and
            os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted' and
            os.environ.get('RUNNER_OS') == 'macOS' and sys.platform == 'darwin' and
            platform.machine() == 'x86_64'):
        raise ValueError('Only ephemeral GitHub-hosted Intel macOS is permitted')


def snapshot(source):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(source), *args], text=True).strip()
    if git('rev-parse', 'HEAD') != SOURCE or git('status', '--porcelain', '--untracked-files=no'):
        raise ValueError('Exact unchanged source revision required')
    commit = git('cat-file', 'commit', SOURCE)
    if '\ngpgsig ' not in commit:
        raise ValueError('Expected signed source commit object')
    return {'revision': SOURCE, 'signaturePresent': True,
            'files': {name: digest(source / name) for name in git('ls-files', '-z').split('\0') if name}}


def parse_processes(text):
    result = {}
    for line in text.splitlines():
        fields = line.split(None, 8)
        if len(fields) != 9:
            continue
        try:
            pid, parent, cpu = int(fields[0]), int(fields[1]), float(fields[2])
        except ValueError:
            continue
        if pid <= 0 or parent < 0 or not math.isfinite(cpu) or cpu < 0:
            continue
        result[pid] = {'pid': pid, 'parent': parent, 'cpuEstimate': cpu,
                       'started': ' '.join(fields[3:8]), 'executable': fields[8]}
    return result


def process_snapshot():
    require_host()
    reply = subprocess.run(['/bin/ps', '-ww', '-axo', 'pid=,ppid=,%cpu=,lstart=,comm='],
                           capture_output=True, text=True, check=True, timeout=3,
                           env={**os.environ, 'LC_ALL': 'C'})
    if len(reply.stdout) > 1024 * 1024:
        raise ValueError('Process inventory exceeded its bound')
    return parse_processes(reply.stdout)


def same_process(a, b):
    return b is not None and all(a[key] == b[key] for key in ('pid', 'parent', 'started', 'executable'))


def owned(processes, pid, parent):
    seen = set()
    while pid != parent:
        if pid in seen or pid not in processes:
            return False
        seen.add(pid)
        pid = processes[pid]['parent']
    return True


def public_identity(process):
    return {key: value for key, value in process.items() if key != 'executable'} | {
        'executableBasename': Path(process['executable']).name}


def tab_roles(processes, parent, binary):
    plugin = str(Path(binary).parent / 'plugin-container.app/Contents/MacOS/plugin-container')
    candidates = [pid for pid, p in processes.items()
                  if p['executable'] == plugin and owned(processes, pid, parent)]
    if not candidates or len(candidates) > 32:
        raise ValueError('Missing or excessive owned plugin-container inventory')
    # Read only known owned children. Discard arguments immediately; retain only
    # the exact tab-role token. Never save command lines, profiles or environment.
    reply = subprocess.run(['/bin/ps', '-ww', '-p', ','.join(map(str, sorted(candidates))), '-o', 'pid=,args='],
                           capture_output=True, text=True, check=True, timeout=3,
                           env={**os.environ, 'LC_ALL': 'C'})
    if len(reply.stdout) > 256 * 1024:
        raise ValueError('Owned role inventory exceeded its bound')
    tabs = []
    for line in reply.stdout.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2 or not parts[0].isdigit() or int(parts[0]) not in candidates:
            continue
        arguments = parts[1].split()
        if arguments and arguments[-1] == 'tab' and '-isForBrowser' in arguments:
            tabs.append(processes[int(parts[0])])
    return sorted(tabs, key=lambda p: (-p['cpuEstimate'], p['pid']))[:2]


def trigger(path):
    if not path.exists():
        return None
    if path.stat().st_size > 256 * 1024:
        raise ValueError('Startup checkpoint file exceeded its bound')
    programs = {}
    for line in path.read_text(encoding='utf-8').splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue  # The server may currently be completing its last line.
        if not isinstance(event, dict):
            raise ValueError('Malformed startup checkpoint object')
        if event.get('event') in ('link-before', 'draw-before'):
            program = event.get('program')
            if type(program) is not int or not 1 <= program <= 8:
                raise ValueError('Malformed startup program identity')
        if event.get('event') == 'link-before':
            shaders = event.get('shaders')
            if not isinstance(shaders, list) or len(shaders) > 2 or not all(isinstance(s, dict) for s in shaders):
                raise ValueError('Malformed startup shader metadata')
            programs[event['program']] = event
        linked = programs.get(event.get('program'), {})
        if event.get('event') == 'draw-before' and any(
                shader.get('type') == 'fragment' and shader.get('fingerprint') == MAIN_FRAGMENT
                and shader.get('length') == 49740 and shader.get('hashedLength') == 49740
                for shader in linked.get('shaders', [])):
            return {'draw': event, 'link': linked}
    return None


def stop_sampler(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)


class StackSampler:
    def __init__(self, browser, capabilities, binary, output):
        self.browser, self.binary, self.output = browser, binary, output
        self.stop = threading.Event()
        self.captures = []
        self.record = {'diagnosticOnly': True, 'acceptanceStatus': 'not-run', 'status': 'waiting',
                       'samplingSeconds': SAMPLE_SECONDS, 'intervalMs': SAMPLE_INTERVAL_MS,
                       'maximumProcesses': 3, 'maximumReportBytes': REPORT_LIMIT,
                       'triggerFingerprint': MAIN_FRAGMENT, 'captures': self.captures, 'issues': []}
        if capabilities.get('moz:processID') != browser.pid:
            raise ValueError('Original browser PID differs from WebDriver PID')
        processes = process_snapshot()
        identity = processes.get(browser.pid)
        if not identity or identity['parent'] != os.getpid() or identity['executable'] != binary:
            raise ValueError('Original launched Firefox ownership not established')
        self.identity = identity
        self.record['parent'] = public_identity(identity)
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.save()

    def save(self):
        write_json(self.output / 'stack-sampling.json', self.record)

    def start(self):
        self.thread.start()

    def run(self):
        active = []
        try:
            deadline = time.monotonic() + 90
            event = None
            while not self.stop.is_set() and self.browser.poll() is None and time.monotonic() < deadline:
                event = trigger(self.output / 'startup.jsonl')
                if event:
                    break
                self.stop.wait(1)  # Local bounded file check; no API/process polling.
            if not event:
                self.record['status'] = 'first-main-draw-not-observed'
                return
            self.record.update(trigger=event, triggerObservedAt=now(), triggerObservedMonotonic=time.monotonic())
            processes = process_snapshot()
            if not same_process(self.identity, processes.get(self.browser.pid)):
                raise ValueError('Original Firefox identity changed before sampling')
            children = tab_roles(processes, self.browser.pid, self.binary)
            if not children:
                raise ValueError('No verified owned tab-role process available')
            targets = [('parent', processes[self.browser.pid])] + [
                (f'content-{i+1}', p) for i, p in enumerate(children)]
            self.record['contentSelection'] = 'At most two tab-role descendants by ps %CPU estimate; no guarantee which hosts the opaque iframe'
            self.record['status'] = 'sampling'
            # Independent simultaneous captures avoid serially missing the cold
            # window. Sampling suspends threads: these times are not benchmarks.
            for role, identity in targets:
                if self.stop.is_set():
                    raise RuntimeError('Original case completed before all captures started')
                fresh = process_snapshot()
                if (not same_process(self.identity, fresh.get(self.browser.pid)) or
                        not same_process(identity, fresh.get(identity['pid'])) or
                        not owned(fresh, identity['pid'], self.browser.pid)):
                    raise ValueError('Sampling target identity/ownership changed')
                report = self.output / f'{role}-sample.txt'
                log = self.output / f'{role}-sample.log'
                command = ['/usr/bin/sample', str(identity['pid']), str(SAMPLE_SECONDS),
                           str(SAMPLE_INTERVAL_MS), '-file', str(report)]
                capture = {'role': role, 'identity': public_identity(identity), 'command': command,
                           'startedAt': now(), 'startedMonotonic': time.monotonic(), 'status': 'running'}
                self.captures.append(capture)
                stream = log.open('wb')
                try:
                    process = subprocess.Popen(command, stdout=stream, stderr=subprocess.STDOUT)
                except Exception:
                    capture['status'] = 'launch-failed'
                    stream.close()
                    raise
                active.append((process, stream, report, log, identity, capture))
            self.save()
            while any(p.poll() is None for p, *_ in active):
                for process, _, report, log, _, capture in active:
                    oversized = any(path.exists() and path.stat().st_size > limit
                                    for path, limit in [(report, REPORT_LIMIT), (log, LOG_LIMIT)])
                    expired = time.monotonic() - capture['startedMonotonic'] > COMMAND_SECONDS
                    if process.poll() is None and (self.stop.is_set() or oversized or expired):
                        capture['status'] = 'cancelled' if self.stop.is_set() else 'output-limit' if oversized else 'command-timeout'
                        stop_sampler(process)
                if self.stop.wait(.25):
                    continue
            self.record['status'] = 'captured'
        except Exception as error:
            self.record['status'] = 'failed'
            self.record['issues'].append(f'{type(error).__name__}: {str(error)[:400]}')
        finally:
            for process, stream, report, log, _, capture in active:
                try:
                    stop_sampler(process)
                except Exception as error:
                    capture['status'] = 'cleanup-failed'
                    self.record['issues'].append(f'{type(error).__name__}: {str(error)[:400]}')
                finally:
                    try:
                        stream.close()
                    except Exception as error:
                        capture['status'] = 'cleanup-failed'
                        self.record['issues'].append(f'{type(error).__name__}: {str(error)[:400]}')
                try:
                    capture.update(exitCode=process.returncode, finishedAt=now())
                    for path, limit in [(report, REPORT_LIMIT), (log, LOG_LIMIT)]:
                        if path.exists() and path.stat().st_size > limit:
                            with path.open('r+b') as file:
                                file.truncate(limit)
                            capture['status'] = 'output-limit'
                        if path.exists():
                            prefix = 'report' if path == report else 'log'
                            capture.update({prefix: path.name, prefix + 'Bytes': path.stat().st_size,
                                            prefix + 'SHA256': digest(path)})
                    if capture['status'] == 'running':
                        capture['status'] = 'saved' if process.returncode == 0 and capture.get('reportBytes', 0) else 'failed'
                except Exception as error:
                    capture['status'] = 'cleanup-failed'
                    self.record['issues'].append(f'{type(error).__name__}: {str(error)[:400]}')
            if self.record['status'] == 'captured':
                self.record['status'] = 'saved' if all(c['status'] == 'saved' for c in self.captures) else 'incomplete'
            self.record['finishedAt'] = now()
            self.save()

    def close(self):
        # Called only after original run_case completes its own browser cleanup,
        # saves its original duration/result and returns (or raises).
        self.stop.set()
        self.thread.join(timeout=30)  # Bounded ps + three bounded own-child stops.
        if self.thread.is_alive():
            self.record['issues'].append('Sampler cleanup did not finish within 30 seconds')
            self.record['status'] = 'incomplete'
            self.save()


def configure(module):
    """Add observer lifecycle hooks only; viewer and its assertions stay original."""
    source = inspect.getsource(module.run_case)
    edits = [
        ('    save()\n    server = browser', "    record.update(diagnosticOnly=True, acceptanceStatus='not-run')\n    save()\n    server = browser"),
        ("        (planner if name == 'planner-256' else viewer)(client, info['origin'], project, record, save)",
         "        try:\n            stack_monitor = STACK_SAMPLER(browser, capabilities, installation['binary'], output)\n            STACK_MONITORS.append(stack_monitor)\n            stack_monitor.start()\n        except Exception as error:\n            record['stackSamplingSetupError'] = str(error)[:400]\n" +
         "        (planner if name == 'planner-256' else viewer)(client, info['origin'], project, record, save)"),
    ]
    for before, after in edits:
        if source.count(before) != 1:
            raise ValueError('Original native observer boundary changed')
        source = source.replace(before, after)
    module.STACK_SAMPLER = StackSampler
    module.STACK_MONITORS = []
    exec(compile(source, '<diagnostic-stack-observer>', 'exec'), module.__dict__)
    return source


def run_original(module, installation, output):
    try:
        return module.run_case(installation, output, 'viewer-24', False)
    finally:
        # Observer cleanup cannot replace a primary result or exception.
        for monitor in module.STACK_MONITORS:
            try:
                monitor.close()
            except Exception as error:
                try:
                    monitor.record['status'] = 'cleanup-failed'
                    monitor.record['issues'].append(f'{type(error).__name__}: {str(error)[:400]}')
                    monitor.save()
                except Exception:
                    pass


def result_summary(original):
    summary = {key: original.get(key) for key in ('status', 'durationMs', 'deadlineExceeded')}
    if 'error' in original:
        error = str(original['error'])
        summary.update(error=error[:1200], errorLength=len(error))
    return summary


def require_fresh_output(output):
    if any((output / name).exists() for name in ('original-viewer-24', 'diagnostic.json', 'source-before.json')):
        raise ValueError('Diagnostic output already exists; preserve it and choose a fresh directory')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--installation', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output, source = args.output.resolve(), args.source.resolve()
    output.mkdir(parents=True, exist_ok=True)
    try:
        require_fresh_output(output)
    except ValueError as error:
        print(json.dumps({'status': 'refused', 'error': str(error)}))
        return 2
    receipt = {'diagnosticOnly': True, 'acceptanceStatus': 'not-run', 'releaseEligible': False,
               'status': 'preparing', 'sourceRevision': SOURCE, 'harnessRevision': os.environ.get('GITHUB_SHA'),
               'startedAt': now(), 'driverSHA256': digest(Path(__file__)), 'originalCase': 'viewer-24',
               'limitations': ['Sampling suspends threads and changes timing; no acceptance or performance credit.',
                              'Command start/end includes symbolication and is not exact capture interval.',
                              'Parent and at most two tab-role descendants sampled independently; ps CPU is an estimate.']}
    try:
        require_host()
        before = snapshot(source)
        write_json(output / 'source-before.json', before)
        preparation = json.loads((output / 'intel-preparation/preparation.json').read_text())
        if preparation.get('status') != 'prepared' or preparation.get('verifiedDisabled') is not True:
            raise ValueError('Original Intel environment preparation must have succeeded')
        os.environ.update(PROFILE, GITHUB_SHA=SOURCE, HOME_STUDIO_SOURCE_ROOT=str(source))
        sys.path.insert(0, str(source / 'scripts'))
        spec = importlib.util.spec_from_file_location('original_native', source / 'scripts/test-waterfox-acceptance.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        installation = json.loads(args.installation.read_text())
        module.validate_installation(installation, 'firefox', '153.5.0esr')
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(Path(installation['binary']).parents[2])],
                       check=True, timeout=60)
        receipt['originalViewerSHA256'] = hashlib.sha256(inspect.getsource(module.viewer).encode()).hexdigest()
        generated = configure(module)
        (output / 'observed-run-case.py').write_text(generated)
        # diagnostic_only=False retains every original final backend assertion.
        original = run_original(module, installation, output / 'original-viewer-24')
        receipt['originalResult'] = result_summary(original)
        after = snapshot(source)
        write_json(output / 'source-after.json', after)
        if before != after:
            raise ValueError('Source changed during the diagnostic')
        sampling_file = output / 'original-viewer-24/stack-sampling.json'
        sampling = json.loads(sampling_file.read_text()) if sampling_file.exists() else {}
        receipt['samplingStatus'] = sampling.get('status', 'absent')
        receipt['status'] = 'completed' if original['status'] == 'passed' and sampling.get('status') == 'saved' else 'failed'
    except Exception as error:
        receipt.update(status='failed', error=f'{type(error).__name__}: {str(error)[:1200]}')
    finally:
        receipt['finishedAt'] = now()
        write_json(output / 'diagnostic.json', receipt)
    print(json.dumps({key: receipt.get(key) for key in ('status', 'originalResult', 'samplingStatus')}))
    return 0 if receipt['status'] == 'completed' else 1


if __name__ == '__main__':
    sys.exit(main())
