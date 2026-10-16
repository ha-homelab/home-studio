#!/usr/bin/env python3
"""Profile one original startup frame after a failed native legacy-CGL viewer.

This never retries acceptance. Its fenced draws alter scheduling, so its separate
receipt is diagnostic-only even when capture completes. A fresh process group
bounds fixture setup, browser launch and capture together to 180 seconds.
"""
import argparse
import hashlib
import importlib.util
import inspect
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
PREFIX = 'HOME_NATIVE_DRAW '


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def eligible(record):
    if record.get('diagnosticOnly') or record.get('status') != 'failed' or record.get('os', {}).get('platform') != 'darwin':
        return False
    checkpoints = record.get('startupCheckpoints', [])
    profiles = [event.get('profile', {}) for event in checkpoints if event.get('event') == 'profile']
    gpus = [event.get('gpu', {}) for event in checkpoints if event.get('event') == 'gpu']
    for sample in record.get('samples', []):
        initial = sample.get('initial', {})
        gpus.append(initial.get('gpu', initial.get('stats', {}).get('gpu', {})))
        scene = initial.get('scene', {})
        profiles.append({'rasterProbe': scene.get('rasterProbe', {})})
    software = any('apple software renderer' in (gpu.get('unmaskedRenderer') or gpu.get('renderer', '')).lower() for gpu in gpus)
    masked = record.get('rendererVisibility') == 'masked' and any(
        profile.get('rasterProbe', {}).get('status') == 'measured' and
        isinstance(profile.get('rasterProbe', {}).get('bestMs'), (int, float)) and
        profile['rasterProbe']['bestMs'] >= 15 for profile in profiles)
    return software or masked


def select_failure(primary):
    for suite in ('viewer-6', 'viewer-24'):
        path = primary / suite / 'report.json'
        if path.is_file():
            record = read(path)
            if record.get('suite') == suite and eligible(record):
                return path, record
    return None


def events_from_log(path):
    """Recover completed records even when a browser is killed mid-draw."""
    events = []
    if not path.exists():
        return events
    for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
        if PREFIX not in line:
            continue
        payload = line[line.index(PREFIX):]
        if line.startswith('console.info: '):
            try:
                payload = json.loads(line[len('console.info: '):])
            except ValueError:
                continue
        try:
            value = json.loads(payload[len(PREFIX):])
        except ValueError:
            continue
        if isinstance(value, dict) and len(events) < 2000:
            events.append(value)
    return events


def configure_worker(module, primary):
    # Replay the failed case's exact backend settings, changing only its fresh
    # Marionette port and enabling durable stdout diagnostics.
    prefs = primary['preferences']
    module.browser_preferences = lambda port: {**prefs, 'marionette.port': port, 'devtools.console.stdout.content': True}
    source = inspect.getsource(module.viewer)
    # Extract only the unchanged bootstrap call, not the acceptance-only 60s
    # scope. This fenced observer retains its explicit 180s diagnostic limit.
    begin = "                load.run(lambda: client.execute("
    boundary = "                load.wait('window.fixtureLoaded')"
    if source.count(begin) != 1 or source.count(boundary) != 1 or source.count('for cycle in range(2):') != 1:
        raise RuntimeError('Native viewer bootstrap changed; review the diagnostic adapter')
    bootstrap = source[source.index(begin):source.index(boundary)].rstrip()
    if not bootstrap.endswith('))'):
        raise RuntimeError('Native viewer bootstrap wrapper changed')
    bootstrap = bootstrap.replace('load.run(lambda: ', '', 1)[:-1]
    bootstrap = bootstrap[8:] + '\n'
    source = source[:source.index('    for cycle in range(2):')] + '    for cycle in range(2):\n' + bootstrap
    source = source.replace("    record['loadBudgetMs'] = VIEWER_LOAD_BUDGET_MS\n", '', 1)
    source = source.replace('def viewer(', 'def diagnostic_viewer(', 1)
    source = source.replace('for cycle in range(2):', 'for cycle in range(1):', 1)
    source = source.replace("    client.call('WebDriver:Navigate'", "    require(record.get('sourceFiles') == DIAGNOSTIC_PRIMARY_FILES, 'Diagnostic runtime source differs from primary')\n    client.connection.settimeout(185)\n    client.call('WebDriver:SetTimeouts', {'pageLoad': 180000, 'script': 180000})\n    client.call('WebDriver:Navigate'", 1)
    source += '''        client.wait('window.fixtureLoaded', timeout=180)
        client.call('WebDriver:SwitchToFrame', {'id': 0})
        client.wait('window.__nativeDrawDiagnostic?.done', timeout=180)
        capture = client.execute('return window.__nativeDrawDiagnostic;')
        record['drawDiagnostic'] = capture
        save()
        require(not capture.get('truncated') and not capture.get('error'), 'One complete legacy-CGL frame is required')
        require(0 < capture.get('draws', 0) <= 600, 'Diagnostic draw count must be bounded')
        graphics = client.execute('return {...window.__browserStability,nativeGraphics:window.__sampleNativeGraphics("draw-diagnostic")};')
        assert_graphics(graphics)
        record['diagnosticGraphics'] = graphics
        client.call('WebDriver:SwitchToFrame', {'id': None})
        save()
'''
    # The compiled fixture hash includes its fresh loopback port. Compare every
    # runtime file instead; retain both compiled hashes as independent evidence.
    if not primary.get('sourceFiles'):
        raise RuntimeError('The primary must retain runtime source hashes')
    module.DIAGNOSTIC_PRIMARY_FILES = primary['sourceFiles']
    exec(compile(source, '<native-draw-diagnostic-bootstrap>', 'exec'), module.__dict__)
    module.viewer = module.diagnostic_viewer
    module.NATIVE_VIEWER_FRAME_DIAGNOSTICS += '\n' + (HERE / 'native-draw-diagnostic.js').read_text(encoding='utf-8')
    module.NATIVE_VIEWER_FRAME_DIAGNOSTICS += '\nattachNativeDrawDiagnostic(renderer,()=>({connected:haConnected,renderCount,profile:renderProfile}));'
    return source


def worker(args):
    spec = importlib.util.spec_from_file_location('native_draw_acceptance', HERE / 'test-waterfox-acceptance.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    primary = read(args.failure)
    if not eligible(primary) or primary.get('diagnosticOnly'):
        raise RuntimeError('A failed primary legacy-CGL viewer is required')
    installation = read(args.installation)
    module.validate_installation(installation, args.product, args.expected_version)
    if primary['installation'] != installation:
        raise RuntimeError('Diagnostic installation must exactly match the failed primary receipt')
    if not primary.get('sourceRevision') or primary['sourceRevision'] != os.environ.get('GITHUB_SHA'):
        raise RuntimeError('Diagnostic source revision must match the failed primary receipt')
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(Path(installation['binary']).parents[2])], check=True, timeout=60)
    generated = configure_worker(module, primary)
    (args.output / 'bootstrap.py').write_text(generated, encoding='utf-8')
    os.environ['NATIVE_STARTUP_DIAGNOSTICS'] = '1'
    result = module.run_case(installation, args.output / primary['suite'], primary['suite'], primary.get('headless', False), diagnostic_only=True)
    return 0 if result['status'] == 'diagnostic-completed' else 1


def supervise(command, output):
    """Kill only this diagnostic's own process group on the overall deadline."""
    with (output / 'worker.log').open('w', encoding='utf-8') as log:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        def terminate(sig):
            try:
                os.killpg(process.pid, sig)
            except ProcessLookupError:
                pass
        try:
            return process.wait(timeout=180), False
        except subprocess.TimeoutExpired:
            terminate(signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                terminate(signal.SIGKILL)
                process.wait(timeout=5)
            return process.returncode, True
        finally:
            # A crashed worker can leave its fixture/browser children alive.
            # The dedicated process group contains only this diagnostic.
            terminate(signal.SIGKILL)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--product', required=True, choices=('firefox', 'waterfox'))
    parser.add_argument('--expected-version', required=True)
    parser.add_argument('--installation', required=True, type=Path)
    parser.add_argument('--primary-output', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--failure', type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.failure:
        return worker(args)
    relative = args.output.resolve().relative_to(args.primary_output.resolve())
    if not relative.parts or relative.parts[0] != 'diagnostics':
        raise ValueError('Diagnostic output must be beneath primary-output/diagnostics')
    selected = select_failure(args.primary_output) if sys.platform == 'darwin' else None
    args.output.mkdir(parents=True, exist_ok=False)
    receipt = {'diagnosticOnly': True, 'acceptanceStatus': 'not-run', 'status': 'skipped',
               'scope': 'One original startup frame; gl.finish changes scheduling. No acceptance retry.',
               'limitSeconds': 180, 'limitDraws': 600}
    target = args.output / 'diagnostic.json'
    if selected:
        path, primary = selected
        receipt.update(status='running', primarySuite=primary['suite'], primarySHA256=digest(path),
                       sourceRevision=primary.get('sourceRevision'),
                       driverSHA256=digest(Path(__file__)), injectionSHA256=digest(HERE / 'native-draw-diagnostic.js'))
        target.write_text(json.dumps(receipt, indent=2)+'\n', encoding='utf-8')
        began = time.monotonic()
        code, expired = supervise([sys.executable, str(Path(__file__).resolve()), *sys.argv[1:], '--failure', str(path.resolve())], args.output)
        events = events_from_log(args.output / primary['suite'] / 'browser.log')
        (args.output / 'draws.jsonl').write_text(''.join(json.dumps(event)+'\n' for event in events), encoding='utf-8')
        receipt.update(status='diagnostic-completed' if code == 0 and not expired else 'diagnostic-incomplete',
                       workerExitCode=code, deadlineExceeded=expired, capturedEvents=len(events),
                       durationMs=round((time.monotonic()-began)*1000),
                       primaryUnchanged=digest(path) == receipt['primarySHA256'])
        if not receipt['primaryUnchanged']:
            raise RuntimeError('Primary receipt changed during diagnostic')
    target.write_text(json.dumps(receipt, indent=2)+'\n', encoding='utf-8')
    print(json.dumps(receipt))
    return 0 if receipt['status'] in ('skipped', 'diagnostic-completed') else 1


if __name__ == '__main__':
    sys.exit(main())
