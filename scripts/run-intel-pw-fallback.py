#!/usr/bin/env python3
"""Compare two fixed sources with the original pinned Playwright Firefox suites."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('intel_native_comparison', HERE / 'run-intel-cgl-fallback.py')
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)
ARMS = common.ARMS
CASES = (('viewer-6', 'test-browser-stability.cjs', '6'),
         ('viewer-24', 'test-browser-stability.cjs', '24'),
         ('planner-256', 'test-planner-stability.cjs', None))
DRIVER_FILES = ('scripts/test-browser-stability.cjs', 'scripts/test-planner-stability.cjs',
                'scripts/browser-stability-diagnostics.cjs', 'scripts/browser-startup-diagnostics.cjs')
PROFILE = {
    'BROWSER_STABILITY_ENGINES': 'firefox', 'PLANNER_STABILITY_ENGINES': 'firefox',
    'BROWSER_STABILITY_HEADED': '1', 'PLANNER_STABILITY_HEADED': '1',
    'HOME_STUDIO_BROWSER_CHANNEL': '', 'HOME_STUDIO_BROWSER_PROFILE': 'desktop',
    'HOME_STUDIO_EXPECT_BROWSER_MAJOR': '153', 'HOME_STUDIO_EXPECT_BROWSER_VERSION': '153.0',
    'FIREFOX_WEBGL_BACKEND': 'default', 'FIREFOX_COMPOSITOR_BACKEND': 'software',
    'FIREFOX_GPU_PROCESS': 'disabled', 'PLAYWRIGHT_VERSION': '1.62.1', 'CFT_VERSION': '',
}
FORBIDDEN_OVERRIDES = ('HOME_STUDIO_SOURCE_ROOT', 'PLANNER_STABILITY_SOURCE_ROOT',
    'HOME_STUDIO_FIXTURE_ONLY', 'BROWSER_STABILITY_REPORT_ONLY', 'PLANNER_STABILITY_REPORT_ONLY',
    'BROWSER_STABILITY_CYCLES', 'PLANNER_STABILITY_CYCLES', 'BROWSER_STABILITY_LIGHTS_PER_ROOM',
    'PLANNER_STABILITY_RECOVERY_ACTIONS', 'PLANNER_STABILITY_RESTORE_LAYOUT',
    'BROWSER_STABILITY_TOUCH_TAP', 'BROWSER_STABILITY_TRACE_INPUT', 'PLANNER_STABILITY_TRACE_RECOVERY',
    'PLAYWRIGHT_CHROMIUM_EXECUTABLE', 'PLAYWRIGHT_FIREFOX_EXECUTABLE', 'PLAYWRIGHT_WEBKIT_EXECUTABLE',
    'BROWSER_STABILITY_SCREENSHOT_DIR', 'PLANNER_STABILITY_SCREENSHOT_DIR',
    'BROWSER_STABILITY_DIAGNOSTICS_DIR', 'PLANNER_STABILITY_DIAGNOSTICS_DIR')


def toolchain_snapshot(root):
    """Read the installed package and executable identity without launching Firefox."""
    module = root / 'node_modules/playwright'
    if os.environ.get('HOME_STUDIO_PLAYWRIGHT_MODULE') != str(module):
        raise ValueError('The Playwright module must be the explicit isolated installation')
    if os.environ.get('PLAYWRIGHT_BROWSERS_PATH') != str(root / 'browsers'):
        raise ValueError('The browser cache must be the explicit isolated installation')
    receipt = json.loads((root / 'toolchain.json').read_text())
    if receipt.get('playwright') != '1.62.1' or receipt.get('module') != str(module):
        raise ValueError('Unexpected Playwright installation receipt')
    metadata = json.loads((root / 'node_modules/playwright-core/browsers.json').read_text())
    firefox = next(value for value in metadata['browsers'] if value['name'] == 'firefox')
    if (firefox['browserVersion'], firefox['revision']) != ('153.0', '1538'):
        raise ValueError('Unexpected Firefox build metadata')
    for name in ('playwright', 'playwright-core'):
        if json.loads((root / 'node_modules' / name / 'package.json').read_text())['version'] != '1.62.1':
            raise ValueError('Installed package version differs from the lock')
    executable = Path(subprocess.check_output(['node', '-e',
        'process.stdout.write(require(process.argv[1]).firefox.executablePath())', str(module)], text=True)).resolve()
    if not executable.is_relative_to((root / 'browsers').resolve()) or not executable.is_file():
        raise ValueError('Firefox executable is outside the isolated browser cache')
    paths = ('toolchain.json', 'package.json', 'package-lock.json',
             'node_modules/playwright/package.json', 'node_modules/playwright-core/package.json',
             'node_modules/playwright-core/browsers.json')
    return {'receipt': receipt, 'firefox': firefox, 'executable': str(executable),
            'executableSha256': common.digest(executable),
            'fileSha256': {name: common.digest(root / name) for name in paths}}


def case_command(source, script):
    return ['node', str(source / 'scripts' / script)]


def run_comparison(source_root, toolchain, output):
    output.mkdir(parents=True, exist_ok=True)
    manifest = {'schema': 1, 'diagnosticOnly': True, 'releaseEligible': False,
        'acceptanceStatus': 'not-run', 'purpose': 'Same-host original Playwright Firefox comparison; not release qualification',
        'startedAt': common.utc_now(), 'status': 'preparing', 'arms': [], 'profile': PROFILE,
        'harnessRevision': os.environ.get('GITHUB_SHA'), 'runnerSha256': common.digest(Path(__file__)),
        'commonRunnerSha256': common.digest(HERE / 'run-intel-cgl-fallback.py'),
        'host': {'system': platform.system(), 'machine': platform.machine(), 'platform': platform.platform()},
        'order': [name for name, _ in ARMS],
        'cacheLimitation': 'Fixed baseline-first order on one host; shared OS/driver caches are not cleared. Separate from the native comparison host.'}
    path = output / 'comparison.json'
    common.write_json(path, manifest)
    try:
        if platform.system() != 'Darwin' or platform.machine() != 'x86_64':
            raise ValueError('The comparison requires native macos-15-intel')
        if any(name in os.environ for name in FORBIDDEN_OVERRIDES):
            raise ValueError('An unapproved fixture, report-only, source or recovery override is present')
        if any(name in os.environ and os.environ[name] != value for name, value in PROFILE.items()):
            raise ValueError('An inherited browser profile differs from the fixed matrix configuration')
        manifest['toolchain'] = toolchain_snapshot(toolchain)
        for name, revision in ARMS:
            destination = output / name
            destination.mkdir()
            snapshot = common.source_snapshot(source_root / name, revision)
            common.write_json(destination / 'source-before.json', snapshot)
            drivers = {name: snapshot['files'][name] for name in DRIVER_FILES}
            if 'driverSha256' in manifest and drivers != manifest['driverSha256']:
                raise ValueError('Original Playwright acceptance drivers differ between source arms')
            manifest['driverSha256'] = drivers
            manifest['arms'].append({'name': name, 'sourceRevision': revision, 'status': 'pending', 'cases': []})
        manifest['status'] = 'running'
        common.write_json(path, manifest)
        for arm in manifest['arms']:
            source = source_root / arm['name']
            destination = output / arm['name']
            arm.update(status='running', startedAt=common.utc_now())
            started = time.monotonic()
            try:
                for name, script, rooms in CASES:
                    case_output = destination / 'raw' / name
                    case_output.mkdir(parents=True)
                    command = case_command(source, script)
                    case = {'suite': name, 'status': 'running', 'command': command,
                            'startedAt': common.utc_now(), 'exitCode': None}
                    arm['cases'].append(case)
                    common.write_json(path, manifest)
                    environment = os.environ.copy()
                    environment.update(PROFILE, GITHUB_SHA=arm['sourceRevision'], PYTHON=sys.executable,
                        PYTHONUTF8='1', HOME_STUDIO_DIAGNOSTICS_DIR=str(case_output))
                    environment.pop('BROWSER_STABILITY_ROOMS', None)
                    if rooms is not None:
                        environment['BROWSER_STABILITY_ROOMS'] = rooms
                    case_started = time.monotonic()
                    with (case_output / 'process.log').open('wb') as log:
                        result = subprocess.run(command, cwd=source, env=environment,
                                                stdout=log, stderr=subprocess.STDOUT, check=False)
                    case.update(status='passed' if result.returncode == 0 else 'failed',
                        exitCode=result.returncode, finishedAt=common.utc_now(),
                        elapsedSeconds=time.monotonic() - case_started)
                    common.write_json(path, manifest)
                after = common.source_snapshot(source, arm['sourceRevision'])
                common.write_json(destination / 'source-after.json', after)
                if after != json.loads((destination / 'source-before.json').read_text()):
                    raise ValueError('Source changed during original Playwright cases')
                if toolchain_snapshot(toolchain) != manifest['toolchain']:
                    raise ValueError('Installed Playwright or Firefox identity changed')
                arm.update(sourceUnchanged=True, toolchainUnchanged=True,
                    status='passed' if all(case['exitCode'] == 0 for case in arm['cases']) else 'failed')
            except Exception as error:
                arm.update(status='infrastructure-error', error=f'{type(error).__name__}: {error}')
            finally:
                arm.update(finishedAt=common.utc_now(), elapsedSeconds=time.monotonic() - started)
                common.write_json(path, manifest)
        manifest['status'] = 'completed' if all(arm['status'] == 'passed' for arm in manifest['arms']) else 'failed'
    except Exception as error:
        manifest.update(status='infrastructure-error', error=f'{type(error).__name__}: {error}')
    finally:
        manifest['finishedAt'] = common.utc_now()
        common.write_json(path, manifest)
    return 0 if manifest['status'] == 'completed' else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--toolchain', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    return run_comparison(args.source_root.resolve(), args.toolchain.resolve(), args.output.resolve())


if __name__ == '__main__':
    sys.exit(main())
