#!/usr/bin/env python3
"""Run one fixed, non-release Intel PW153 comparison without changing its tests."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import re
import signal
import subprocess
import sys
import time

BASELINE = '1d8c4dde1a6e02b2f992711fabbb370fd77488a7'
CANDIDATE = '7cc7031f860578d7e066fccd33543dce2bd43dbc'
CANDIDATE_CHANGED_FILES = (
    'CHANGELOG.md', 'docs/browser-compatibility.md',
    'scripts/test-interaction-render.cjs', 'scripts/test-render-capacity.cjs',
    'scripts/test-render-lifecycle.cjs', 'viewer.js',
)
BRANCH = 'diagnostic/intel-pw153-pixels625-pair'
WORKFLOW = '.github/workflows/intel-pw153-pixels625-pair.yml'
ORDER = (('baseline', 6), ('candidate', 6), ('candidate', 24), ('baseline', 24))
# The original driver builds before its browser watchdog starts. This host
# ceiling cannot extend either original limit; it only bounds a stuck process.
CHILD_TIMEOUT_SECONDS = 120 + 245 + 10
PROTECTED = (
    'scripts/test-browser-stability.cjs', 'scripts/test-planner-stability.cjs',
    'scripts/browser-stability-diagnostics.cjs', 'scripts/browser-startup-diagnostics.cjs',
    'scripts/browser-matrix.py', 'scripts/browser-matrix.json',
    'scripts/setup-browser-toolchain.py', 'scripts/install-browser-with-retry.py',
    'scripts/prepare-intel-macos-ci.py', 'scripts/build-planner-project.py',
    'scripts/test-native-browser-acceptance.py', 'scripts/test-waterfox-acceptance.py',
    'scripts/test-safari-acceptance.py', 'scripts/native-viewer-program-diagnostics.js',
    'package.json', 'package-lock.json',
)
PROFILE = {
    'BROWSER_STABILITY_ENGINES': 'firefox', 'BROWSER_STABILITY_HEADED': '1',
    'HOME_STUDIO_BROWSER_PROFILE': 'desktop', 'HOME_STUDIO_EXPECT_BROWSER_MAJOR': '153',
    'HOME_STUDIO_EXPECT_BROWSER_VERSION': '153.0', 'PLAYWRIGHT_VERSION': '1.62.1',
    'FIREFOX_WEBGL_BACKEND': 'default', 'FIREFOX_COMPOSITOR_BACKEND': 'software',
    'FIREFOX_GPU_PROCESS': 'disabled', 'PYTHONUTF8': '1',
}
MODES = ['editor-cutaway', 'editor-full', 'home']


def require(value, message):
    if not value:
        raise ValueError(message)


def now():
    return datetime.now(timezone.utc).isoformat()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + '\n', encoding='utf-8')


def git(source, *arguments):
    return subprocess.check_output(['git', '-C', str(source), *arguments], timeout=30)


def validate_selection():
    require(bool(re.fullmatch('[a-f0-9]{40}', CANDIDATE)) and CANDIDATE not in (BASELINE, '0' * 40),
            'Select one reviewed full candidate SHA before setup')
    require(isinstance(CANDIDATE_CHANGED_FILES, tuple) and CANDIDATE_CHANGED_FILES and
            len(set(CANDIDATE_CHANGED_FILES)) == len(CANDIDATE_CHANGED_FILES),
            'Freeze the complete candidate changed-file inventory')
    require(all(re.fullmatch(r'[A-Za-z0-9_.\-/]+', name) and not name.startswith('/') and
                '..' not in name.split('/') and name not in PROTECTED
                for name in CANDIDATE_CHANGED_FILES), 'Candidate changes a protected or invalid path')
    workflow = Path(__file__).resolve().parents[1] / WORKFLOW
    text = workflow.read_text(encoding='utf-8')
    require(text.count('ref: ' + BASELINE) == 1 and text.count('ref: ' + CANDIDATE) == 1,
            'Workflow source pins disagree with the runner')
    return {'baseline': BASELINE, 'candidate': CANDIDATE,
            'candidateChangedFiles': list(CANDIDATE_CHANGED_FILES)}


def source_snapshot(source, expected):
    require(git(source, 'rev-parse', 'HEAD').decode().strip() == expected, 'Unexpected source HEAD')
    require(not git(source, 'status', '--porcelain', '--untracked-files=no').strip(), 'Tracked source was modified')
    names = git(source, 'ls-files', '-z').decode().rstrip('\0').split('\0')
    return {'revision': expected, 'tree': git(source, 'rev-parse', 'HEAD^{tree}').decode().strip(),
            'files': {name: sha((source / name).read_bytes()) for name in names}}


def verify_sources(snapshots):
    before, after = (snapshots[name]['files'] for name in ('baseline', 'candidate'))
    changed = sorted(name for name in before.keys() | after.keys() if before.get(name) != after.get(name))
    require(changed == sorted(CANDIDATE_CHANGED_FILES), 'Candidate delta differs from the reviewed full inventory')
    for name in PROTECTED:
        require(name in before and before[name] == after.get(name), 'Protected source differs: ' + name)
    return changed


def require_host():
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and
            os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted' and
            os.environ.get('RUNNER_OS') == 'macOS' and sys.platform == 'darwin' and
            platform.machine() == 'x86_64', 'This diagnostic requires a GitHub-hosted Intel macOS runner')
    require(os.environ.get('GITHUB_EVENT_NAME') == 'push' and
            os.environ.get('GITHUB_REF') == 'refs/heads/' + BRANCH, 'Unexpected diagnostic event/ref')


def environment(source, output, toolchain):
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(('BROWSER_STABILITY_', 'HOME_STUDIO_', 'FIREFOX_', 'PLAYWRIGHT_', 'PLANNER_STABILITY_'))
           and key not in ('CFT_VERSION', 'GITHUB_SHA')}
    # The original helper prefers GITHUB_SHA. Remove the harness revision so it
    # reads the verified source checkout's actual Git HEAD for this case.
    env.update(PROFILE)
    env.update(HOME_STUDIO_SOURCE_ROOT=str(source), HOME_STUDIO_DIAGNOSTICS_DIR=str(output),
               HOME_STUDIO_PLAYWRIGHT_MODULE=str(toolchain / 'node_modules/playwright'),
               PLAYWRIGHT_BROWSERS_PATH=str(toolchain / 'browsers'), PYTHON=sys.executable)
    return env


def validate_report(report, revision, rooms, files):
    require(report.get('status') == 'passed' and report.get('reportOnly') is False and
            not report.get('diagnosticOnly') and not report.get('timedOut') and
            not report.get('timeoutScope'), 'Original case did not pass normally')
    require(report.get('sourceRevision') == revision and report.get('sourceHashScope') == 'instrumented-compiled-viewer'
            and bool(re.fullmatch('[a-f0-9]{64}', report.get('sourceHash', ''))), 'Missing original source provenance')
    require(report.get('sourceFiles') == {name: files[name] for name in
            ('viewer.js', 'home-view.js', 'room-lighting.js', 'planner/render-capacity.js', 'planner/interaction-render.js')},
            'Actual compiled runtime inputs differ from frozen source')
    require(report.get('browserVersion') == '153.0' and report.get('playwrightVersion') == '1.62.1', 'Wrong browser/toolchain')
    require(report.get('os', {}).get('platform') == 'darwin' and report['os'].get('arch') == 'x64', 'Wrong actual host')
    require(report.get('identity', {}).get('engine') == 'firefox' and
            report['identity'].get('browserVersion') == '153.0' and
            report.get('profile', {}).get('name') == 'desktop' and
            report['profile'].get('emulated') is False, 'Wrong browser/profile identity')
    require(report.get('launch', {}).get('headless') is False and
            report['launch'].get('firefoxUserPrefs') == {
                'webgl.force-enabled': True, 'webgl.sanitize-unmasked-renderer': False,
                'gfx.webrender.software': True, 'layers.gpu-process.enabled': False,
                'webgl.allow-in-parent': True}, 'Launch preferences differ from the original Intel lane')
    require(report.get('inputDiagnostics') == {'tapMode': 'playwright', 'traceInput': False, 'dragReleaseHoldMs': 0},
            'Non-original input/trace mode')
    require(report.get('fixture') == {'floors': 1, 'rooms': rooms, 'lights': rooms * 3}, 'Wrong fixture')
    require(report.get('deadlineScope') == {'version': 2, 'bootstrapMs': 30000, 'scenarioMs': 180000,
            'scenario': 'execute-through-final-identity-and-checks', 'hardProcessMs': 245000}, 'Original caps changed')
    for field, cap in (('bootstrapDurationMs', 30000), ('scenarioDurationMs', 180000)):
        value = report.get(field)
        require(type(value) in (int, float) and math.isfinite(value) and 0 <= value < cap, 'Invalid measured ' + field)
    start, end = report.get('scenarioStartedMs'), report.get('scenarioCompletedMs')
    require(all(type(v) in (int, float) and math.isfinite(v) and v >= 0 for v in (start, end)) and
            start >= report['bootstrapDurationMs'] - .003 and end >= start and
            abs(end - start - report['scenarioDurationMs']) <= .003, 'Missing final checked completion timing')
    require(report.get('viewerCompletion') == {'version': 1, 'cycles': 2, 'postRestoreModes': MODES}, 'Incomplete original sequence')
    require(report.get('loadBudgetMs') == 60000, 'Cold-load budget changed')
    samples = report.get('samples')
    require(isinstance(samples, list) and len(samples) == 2 and [s.get('cycle') for s in samples] == [0, 1], 'Two cycles required')
    for sample in samples:
        require(sample.get('completed') is True and sample.get('loadCompleted') is True and
                not sample.get('loadTimedOut') and sample.get('loadBudgetMs') == 60000, 'Incomplete cold creation/cycle')
        require(type(sample.get('loadMs')) in (int, float) and math.isfinite(sample['loadMs']) and
                0 <= sample['loadMs'] < 60000, 'Invalid cold-load timing')
        require(sample.get('gpu', {}).get('unmaskedRenderer') == 'Apple Software Renderer', 'Wrong actual sample renderer')
    require(report.get('gpu', {}).get('unmaskedRenderer') == 'Apple Software Renderer', 'Wrong actual renderer')
    views = samples[1].get('postRestoreViews')
    require(isinstance(views, list) and len(views) == 3 and [v.get('mode') for v in views] == MODES and
            all(v.get('completed') is True and isinstance(v.get('snapshot'), dict) for v in views), 'Incomplete restoration modes')
    for field in ('errors', 'crashes', 'consoleErrors', 'failedAssertions', 'diagnosticsErrors', 'cleanupErrors'):
        require(report.get(field) == [], 'Original report contains ' + field)
    return {'loadsMs': [s['loadMs'] for s in samples], 'homeDragsMs': [s.get('dragMs') for s in samples],
            'editorDragsMs': [s.get('editorDragMs') for s in samples],
            'scenarioMs': report['scenarioDurationMs']}


def restoration_timings(report):
    """Copy bounded existing timing fields after exit; add no browser work."""
    names = {'context-loss', 'lost-resize-and-checks', 'context-restore', 'restored-checks',
             'post-restore-editor-cutaway', 'post-restore-editor-full', 'post-restore-home'}
    def number(value):
        return value if type(value) in (int, float) and math.isfinite(value) else None
    phases = report.get('phases')
    samples = report.get('samples')
    return {
        'phases': [dict(name=phase['name'], cycle=number(phase.get('cycle')),
                        startedMs=number(phase.get('startedMs')),
                        completedMs=number(phase.get('completedMs')),
                        durationMs=number(phase.get('durationMs')))
                   for phase in (phases if isinstance(phases, list) else [])
                   if isinstance(phase, dict) and phase.get('name') in names][:7],
        'postRestoreViews': [dict(cycle=number(sample.get('cycle')), mode=view['mode'],
                                  completed=view.get('completed') is True,
                                  durationMs=number(view.get('durationMs')))
                             for sample in (samples if isinstance(samples, list) else [])[:2]
                             if isinstance(sample, dict) and isinstance(sample.get('postRestoreViews'), list)
                             for view in sample['postRestoreViews'][:3]
                             if isinstance(view, dict) and view.get('mode') in MODES],
    }


def collect_case(path, revision, rooms, exit_code, files):
    paths = sorted(path.rglob('firefox.json'))
    result = {'exitCode': exit_code, 'qualified': False, 'cleanupVerified': False}
    if len(paths) != 1:
        return {**result, 'error': 'Expected exactly one original Firefox report', 'reportCount': len(paths)}
    report_path = paths[0]
    result.update(report=str(report_path.relative_to(path)))
    try:
        result['reportBytes'] = report_path.stat().st_size
        require(result['reportBytes'] <= 16 * 1024 * 1024, 'Original report exceeds bound')
        raw = report_path.read_bytes()
        result['reportSha256'] = sha(raw)
        report = json.loads(raw)
        require(isinstance(report, dict), 'Original report must be an object')
        result['originalStatus'] = report.get('status')
        result['restoration'] = restoration_timings(report)
        summary_path = report_path.with_name('summary.json')
        require(summary_path.stat().st_size <= 1024 * 1024, 'Original summary exceeds bound')
        summary_raw = summary_path.read_bytes()
        result['summarySha256'] = sha(summary_raw)
        summary = json.loads(summary_raw)
        browser_close = report.get('cleanupDurationsMs', {}).get('browser')
        result['cleanupVerified'] = bool(
            isinstance(summary, dict) and summary.get('suite') == 'viewer' and
            summary.get('sourceRevision') == revision and summary.get('finishedAt') and
            summary.get('status') in ('passed', 'failed') and
            summary.get('browsers') == [{'engine': 'firefox', 'file': 'firefox.json', 'status': report.get('status')}] and
            report.get('finishedAt') and report.get('cleanupErrors') == [] and
            not report.get('hardDeadlineExceeded') and
            type(browser_close) in (int, float) and math.isfinite(browser_close) and browser_close >= 0)
        require(result['cleanupVerified'], 'Original browser cleanup completion is unproved')
        require(exit_code == 0, 'Original process exited unsuccessfully')
        result['timings'] = validate_report(report, revision, rooms, files)
        result['qualified'] = True
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        result['error'] = str(error)[:500]
    return result


def cleanup_group(pid):
    """Reap only descendants in the child-created process group, never unrelated host services."""
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        return False
    # An exited Node process normally leaves no group. Terminate only remaining
    # same-group children; a detached browser is not covered by this cleanup.
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        try:
            os.killpg(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(.05)
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    return True


def run(args):
    validate_selection(); require_host()
    args.output = args.output.resolve()
    args.preparation = args.preparation.resolve()
    require(not args.output.exists(), 'Fresh output directory required; prior failures cannot be overwritten')
    args.output.mkdir(parents=True)
    roots = {name: (args.source_root / name).resolve() for name in ('baseline', 'candidate')}
    revisions = {'baseline': BASELINE, 'candidate': CANDIDATE}
    initial = {name: source_snapshot(root, revisions[name]) for name, root in roots.items()}
    verify_sources(initial)
    toolchain = args.toolchain.resolve()
    receipt = json.loads((toolchain / 'toolchain.json').read_text())
    require(receipt.get('playwright') == '1.62.1' and
            Path(receipt.get('module', '')).resolve() == toolchain / 'node_modules/playwright', 'Unexpected toolchain')
    for package in ('playwright', 'playwright-core'):
        require(json.loads((toolchain / 'node_modules' / package / 'package.json').read_text())['version'] == '1.62.1',
                'Installed toolchain version changed')
    prep_file = args.preparation / 'preparation.json'; prep = json.loads(prep_file.read_text())
    require(prep.get('status') == 'prepared' and prep.get('verifiedDisabled') is True, 'Intel setup did not finish')
    spec = importlib.util.spec_from_file_location('reviewed_intel_setup', roots['baseline'] / 'scripts/prepare-intel-macos-ci.py')
    setup = importlib.util.module_from_spec(spec); spec.loader.exec_module(setup)
    manifest = {'diagnosticOnly': True, 'releaseEligible': False, 'startedAt': now(), 'baseline': BASELINE,
                'candidate': CANDIDATE, 'order': ORDER, 'sourceBefore': initial, 'cases': [],
                'toolchainSha256': sha((toolchain / 'toolchain.json').read_bytes()),
                'preparationSha256': sha(prep_file.read_bytes()),
                'limitation': 'Baseline6 is first; fixed order and shared CGL caches confound order-independent timing claims.'}
    manifest_path = args.output / 'manifest.json'; save(manifest_path, manifest)
    try:
        for number, (name, rooms) in enumerate(ORDER, 1):
            path = args.output / f'{number}-{name}-viewer-{rooms}'; path.mkdir()
            current = {key: source_snapshot(root, revisions[key]) for key, root in roots.items()}
            require(current == initial, 'Source changed between cases')
            state = setup.indexing_command(path / 'indexing-before.json')
            setup.verify_indexing_disabled(state, prep['beforeVolumes'])
            env = environment(roots[name], path, toolchain); env['BROWSER_STABILITY_ROOMS'] = str(rooms)
            record = {'arm': name, 'rooms': rooms, 'startedAt': now(), 'sourceBefore': current[name]}
            manifest['cases'].append(record); save(manifest_path, manifest)
            with (path / 'original.log').open('w') as log:
                child = subprocess.Popen(['node', 'scripts/test-browser-stability.cjs'], cwd=roots[name], env=env,
                                         stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                host_timeout = False
                try:
                    code = child.wait(timeout=CHILD_TIMEOUT_SECONDS)
                except subprocess.TimeoutExpired:
                    host_timeout = True
                    code = None
                finally:
                    record['terminatedRemainingOwnedProcesses'] = cleanup_group(child.pid)
                if host_timeout:
                    record['hostTimedOut'] = True
                    record['hostTimeoutSeconds'] = CHILD_TIMEOUT_SECONDS
                    try:
                        code = child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        record['hostReapError'] = 'Killed child did not exit within five seconds'
            record.update(finishedAt=now(), **collect_case(path, revisions[name], rooms, code, initial[name]['files']))
            if host_timeout:
                record.update(qualified=False, error='Original process exceeded the diagnostic host ceiling')
            record['sourceAfter'] = source_snapshot(roots[name], revisions[name])
            require(record['sourceAfter'] == initial[name], 'Source changed during original case')
            state = setup.indexing_command(path / 'indexing-after.json')
            setup.verify_indexing_disabled(state, prep['beforeVolumes'])
            save(manifest_path, manifest)
            if host_timeout or not record['cleanupVerified']:
                manifest['remainingCasesNotRun'] = [
                    {'arm': arm, 'rooms': count, 'reason': 'Prior browser cleanup is unproved'}
                    for arm, count in ORDER[number:]]
                manifest['aborted'] = True
                break
        manifest['sourceAfter'] = {name: source_snapshot(root, revisions[name]) for name, root in roots.items()}
        require(manifest['sourceAfter'] == initial, 'Final source identity changed')
        manifest['status'] = 'passed' if len(manifest['cases']) == len(ORDER) and all(c['qualified'] for c in manifest['cases']) else 'failed'
    except Exception as error:
        manifest.update(status='failed', error=str(error)[:1000])
    finally:
        manifest['finishedAt'] = now(); save(manifest_path, manifest)
    print(json.dumps({'diagnosticOnly': True, 'releaseEligible': False, 'status': manifest['status'],
                      'cases': [{k: c.get(k) for k in ('arm', 'rooms', 'originalStatus', 'qualified', 'timings', 'restoration')} for c in manifest['cases']]}))
    return 0 if manifest['status'] == 'passed' else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--validate-selection', action='store_true')
    parser.add_argument('--validate-sources', action='store_true')
    parser.add_argument('--source-root', type=Path)
    parser.add_argument('--toolchain', type=Path)
    parser.add_argument('--preparation', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.validate_selection:
        print(json.dumps(validate_selection())); return 0
    if args.validate_sources:
        validate_selection(); require(args.source_root, 'Source root required')
        snapshots = {name: source_snapshot(args.source_root / name, revision)
                     for name, revision in (('baseline', BASELINE), ('candidate', CANDIDATE))}
        print(json.dumps({'diagnosticOnly': True, 'changed': verify_sources(snapshots), 'sources': snapshots})); return 0
    require(all((args.source_root, args.toolchain, args.preparation, args.output)), 'All fixed-run paths required')
    return run(args)


if __name__ == '__main__':
    raise SystemExit(main())
