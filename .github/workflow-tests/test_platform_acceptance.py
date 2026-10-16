"""Keep complete native browser coverage mandatory in PR and release validation."""

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlsplit

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / '.github/workflows'
PLATFORMS = {'ubuntu-24.04', 'windows-2022', 'macos-15'}
PREPARED_OR_OTHER_OS = "${{ !cancelled() && (matrix.os != 'macos-15-intel' || steps.prepare_intel.outcome == 'success') }}"


def workflow(name):
    return yaml.load((WORKFLOWS / name).read_text(encoding='utf-8'), Loader=yaml.BaseLoader)


def inventory():
    spec = importlib.util.spec_from_file_location('browser_matrix', ROOT / 'scripts/browser-matrix.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.expand(module.load_manifest())


class PlatformAcceptanceTests(unittest.TestCase):
    def test_signal_texture_decay_two_cpu_proof_is_unconditional(self):
        steps = workflow('package.yml')['jobs']['package']['steps']
        command = 'node scripts/test-signal-texture-decay-two.cjs'
        self.assertEqual(sum(step.get('run', '').count(command) for step in steps), 1)
        step = next(step for step in steps if command in step.get('run', ''))
        self.assertIn(command, [line.strip() for line in step['run'].splitlines()])
        self.assertNotIn('if', step)
        self.assertNotIn('continue-on-error', step)
        spec = importlib.util.spec_from_file_location('site_inventory', ROOT / 'scripts/validate-site.py')
        site = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(site)
        self.assertIn('scripts/test-signal-texture-decay-two.cjs', site.REPO_FILES)
        replay = (ROOT / 'scripts/test_source_replay.py').read_text(encoding='utf-8')
        self.assertIn("['scripts/test-signal-texture-decay-two.cjs']", replay)

    def test_point_signal_texture_cpu_proof_is_unconditional(self):
        steps = workflow('package.yml')['jobs']['package']['steps']
        command = 'node scripts/test-point-signal-texture.cjs'
        self.assertEqual(sum(step.get('run', '').count(command) for step in steps), 1)
        step = next(step for step in steps if command in step.get('run', ''))
        self.assertIn(command, [line.strip() for line in step['run'].splitlines()])
        self.assertNotIn('if', step)
        self.assertNotIn('continue-on-error', step)
        spec = importlib.util.spec_from_file_location('site_inventory', ROOT / 'scripts/validate-site.py')
        site = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(site)
        self.assertIn('scripts/test-point-signal-texture.cjs', site.REPO_FILES)
        replay = (ROOT / 'scripts/test_source_replay.py').read_text(encoding='utf-8')
        self.assertIn("['scripts/test-point-signal-texture.cjs']", replay)

    def test_viewer_startup_cpu_proof_is_unconditional(self):
        steps = workflow('package.yml')['jobs']['package']['steps']
        command = 'node scripts/test-viewer-startup.cjs'
        self.assertEqual(sum(step.get('run', '').count(command) for step in steps), 1)
        step = next(step for step in steps if command in step.get('run', ''))
        self.assertIn(command, [line.strip() for line in step['run'].splitlines()])
        self.assertNotIn('if', step)
        self.assertNotIn('continue-on-error', step)
        spec = importlib.util.spec_from_file_location('site_inventory', ROOT / 'scripts/validate-site.py')
        site = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(site)
        self.assertIn('scripts/test-viewer-startup.cjs', site.REPO_FILES)
        replay = (ROOT / 'scripts/test_source_replay.py').read_text(encoding='utf-8')
        self.assertIn("['scripts/test-viewer-startup.cjs']", replay)

    def test_point_decay_two_cpu_proof_is_unconditional(self):
        steps = workflow('package.yml')['jobs']['package']['steps']
        command = 'node scripts/test-point-decay-two.cjs'
        self.assertEqual(sum(step.get('run', '').count(command) for step in steps), 1)
        step = next(step for step in steps if command in step.get('run', ''))
        self.assertIn(command, [line.strip() for line in step['run'].splitlines()])
        self.assertNotIn('if', step)
        self.assertNotIn('continue-on-error', step)
        spec = importlib.util.spec_from_file_location('site_inventory', ROOT / 'scripts/validate-site.py')
        site = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(site)
        self.assertIn('scripts/test-point-decay-two.cjs', site.REPO_FILES)
        replay = (ROOT / 'scripts/test_source_replay.py').read_text(encoding='utf-8')
        self.assertIn("['scripts/test-point-decay-two.cjs']", replay)

    def test_intel_preparation_is_required_only_for_the_three_existing_rows(self):
        jobs = workflow('platform-acceptance.yml')['jobs']
        rows = inventory()
        selected = [(job, row['id']) for job, key in [('browser', 'browser'), ('native-browser', 'native')]
                    for row in rows[key]['include'] if row['os'] == 'macos-15-intel']
        self.assertEqual(set(selected), {('browser', 'firefox-153.0-pw1.62.1-desktop'),
                                       ('native-browser', 'firefox-153.5.0esr'),
                                       ('native-browser', 'waterfox-6.7.6')})
        browser_rows = sum(len(value['include']) for value in rows.values()) + 1
        self.assertEqual(browser_rows, 74)
        self.assertEqual(browser_rows + len(jobs['install']['strategy']['matrix']['os']), 77)
        self.assertEqual(browser_rows * 3, 222)
        for job_name, job in jobs.items():
            preparations = [step for step in job['steps'] if step.get('id') == 'prepare_intel']
            if job_name not in ('browser', 'native-browser'):
                self.assertEqual(preparations, [])
                continue
            self.assertEqual(len(preparations), 1)
            step = preparations[0]
            self.assertEqual(step['if'], "${{ matrix.os == 'macos-15-intel' }}")
            self.assertNotIn('continue-on-error', step)
            path = ('acceptance-artifacts/runner-environment' if job_name == 'browser'
                    else '"$NATIVE_BROWSER_DIAGNOSTICS_DIR/runner-environment"')
            self.assertEqual(step['run'], 'python3 scripts/prepare-intel-macos-ci.py --output ' + path)
            steps = job['steps']
            python_index = next(i for i, value in enumerate(steps) if 'actions/setup-python@' in value.get('uses', ''))
            node_index = next(i for i, value in enumerate(steps) if 'actions/setup-node@' in value.get('uses', ''))
            self.assertLess(python_index, steps.index(step))
            self.assertLess(steps.index(step), node_index)
            upload = next(value for value in steps if 'actions/upload-artifact@' in value.get('uses', ''))
            self.assertEqual(upload['if'], '${{ always() }}')
            self.assertEqual(upload['with']['if-no-files-found'], 'error')
        browser = {step.get('id'): step for step in jobs['browser']['steps']}
        self.assertNotIn('if', browser['viewer_6_acceptance'])
        for name in ('viewer_24_acceptance', 'planner_acceptance'):
            self.assertEqual(browser[name]['if'], PREPARED_OR_OTHER_OS)
        native = next(step for step in jobs['native-browser']['steps'] if step.get('id') == 'native_acceptance')
        self.assertNotIn('if', native)  # GitHub's default success() blocks it after failed preparation.

    def test_intel_preparation_mocks_replay_unconditionally_from_public_source(self):
        command = 'python3 scripts/test-intel-macos-ci.py'
        matches = [step for step in workflow('package.yml')['jobs']['package']['steps']
                   if command in step.get('run', '')]
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]['run'], command)
        self.assertNotIn('if', matches[0])
        self.assertNotIn('continue-on-error', matches[0])
        spec = importlib.util.spec_from_file_location('site_inventory', ROOT / 'scripts/validate-site.py')
        site = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(site)
        for name in ('prepare-intel-macos-ci.py', 'test-intel-macos-ci.py'):
            self.assertIn('scripts/' + name, site.REPO_FILES)
        self.assertIn("'scripts/test-intel-macos-ci.py'", (ROOT / 'scripts/test_source_replay.py').read_text())

    def test_cached_shadow_transmission_cpu_proof_is_unconditional(self):
        steps = workflow('package.yml')['jobs']['package']['steps']
        command = 'node scripts/test-cached-shadow-transmission.cjs'
        self.assertEqual(sum(step.get('run', '').count(command) for step in steps), 1)
        step = next(step for step in steps if command in step.get('run', ''))
        self.assertIn(command, [line.strip() for line in step['run'].splitlines()])
        self.assertNotIn('if', step)
        self.assertNotIn('continue-on-error', step)
        spec = importlib.util.spec_from_file_location('site_inventory', ROOT / 'scripts/validate-site.py')
        site = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(site)
        self.assertIn('scripts/test-cached-shadow-transmission.cjs', site.REPO_FILES)
        replay = (ROOT / 'scripts/test_source_replay.py').read_text(encoding='utf-8')
        self.assertIn("['scripts/test-cached-shadow-transmission.cjs']", replay)

    def test_zero_point_block_cpu_proof_is_unconditional(self):
        steps = workflow('package.yml')['jobs']['package']['steps']
        command = 'node scripts/test-zero-point-block.cjs'
        self.assertEqual(sum(step.get('run', '').count(command) for step in steps), 1)
        step = next(step for step in steps if command in step.get('run', ''))
        self.assertIn(command, [line.strip() for line in step['run'].splitlines()])
        self.assertNotIn('if', step)
        self.assertNotIn('continue-on-error', step)
        spec = importlib.util.spec_from_file_location('site_inventory', ROOT / 'scripts/validate-site.py')
        site = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(site)
        self.assertIn('scripts/test-zero-point-block.cjs', site.REPO_FILES)
        replay = (ROOT / 'scripts/test_source_replay.py').read_text(encoding='utf-8')
        self.assertIn("['scripts/test-zero-point-block.cjs']", replay)

    def test_glass_facing_cpu_proof_is_unconditional(self):
        steps = workflow('package.yml')['jobs']['package']['steps']
        command = 'node scripts/test-glass-wall-program.cjs'
        self.assertEqual(sum(step.get('run', '').count(command) for step in steps), 1)
        step = next(step for step in steps if command in step.get('run', ''))
        self.assertIn(command, [line.strip() for line in step['run'].splitlines()])
        self.assertNotIn('if', step)
        self.assertNotIn('continue-on-error', step)
        spec = importlib.util.spec_from_file_location('site_inventory', ROOT / 'scripts/validate-site.py')
        site = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(site)
        self.assertIn('scripts/test-glass-wall-program.cjs', site.REPO_FILES)
        replay = (ROOT / 'scripts/test_source_replay.py').read_text(encoding='utf-8')
        self.assertIn("['scripts/test-glass-wall-program.cjs']", replay)

    def test_fallback_shared_program_cpu_proof_is_unconditional(self):
        steps = workflow('package.yml')['jobs']['package']['steps']
        command = 'node scripts/test-fallback-shared-program.cjs'
        self.assertEqual(sum(step.get('run', '').count(command) for step in steps), 1)
        step = next(step for step in steps if command in step.get('run', ''))
        self.assertIn(command, [line.strip() for line in step['run'].splitlines()])
        self.assertNotIn('if', step)
        self.assertNotIn('continue-on-error', step)
        spec = importlib.util.spec_from_file_location('site_inventory', ROOT / 'scripts/validate-site.py')
        site = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(site)
        self.assertIn('scripts/test-fallback-shared-program.cjs', site.REPO_FILES)
        replay = (ROOT / 'scripts/test_source_replay.py').read_text(encoding='utf-8')
        self.assertIn("['scripts/test-fallback-shared-program.cjs']", replay)

    def test_platforms_are_required_by_existing_pr_and_release_gates(self):
        quality = workflow('quality-gate.yml')
        self.assertIn('pull_request', quality['on'])
        self.assertIn('merge_group', quality['on'])
        self.assertEqual(quality['jobs']['check-0']['uses'], './.github/workflows/package.yml')
        self.assertIn('check-0', quality['jobs']['gate']['needs'])
        caller = workflow('package.yml')['jobs']['platforms']
        self.assertEqual(caller['uses'], './.github/workflows/platform-acceptance.yml')
        self.assertNotIn('if', caller)
        self.assertNotIn('continue-on-error', caller)
        release = workflow('release-pipeline.yml')['jobs']
        self.assertEqual(release['checks']['uses'], './.github/workflows/quality-gate.yml')
        self.assertEqual(release['checks']['with']['force-full'], 'true')
        self.assertIn('checks', release['gate']['needs'])

    def test_every_lane_is_required_and_parallelism_is_bounded(self):
        acceptance = workflow('platform-acceptance.yml')
        self.assertEqual(set(acceptance['on']), {'workflow_call'})
        self.assertEqual(acceptance['permissions'], {'contents': 'read'})
        self.assertEqual(set(acceptance['jobs']), {'matrix', 'install', 'browser', 'native-browser', 'safari'})
        for name, job in acceptance['jobs'].items():
            with self.subTest(job=name):
                self.assertNotIn('if', job)
                self.assertNotIn('continue-on-error', job)
                self.assertLessEqual(int(job['timeout-minutes']), 25)
                for step in job['steps']:
                    self.assertNotIn('continue-on-error', step)
                if 'strategy' in job:
                    self.assertEqual(job['strategy']['fail-fast'], 'false')
                    self.assertEqual(int(job['strategy']['max-parallel']),
                                     {'install': 3, 'browser': 10, 'native-browser': 3}[name])
        jobs = acceptance['jobs']
        self.assertEqual(set(jobs['install']['strategy']['matrix']['os']), PLATFORMS)
        manifest = json.loads((ROOT / 'scripts/browser-matrix.json').read_text())
        self.assertEqual(set(manifest['platforms']), PLATFORMS)
        self.assertEqual(manifest['safari'], [jobs['safari']['runs-on']])
        for job, output in [('browser', 'browser'), ('native-browser', 'native')]:
            self.assertEqual(jobs[job]['needs'], 'matrix')
            self.assertEqual(jobs[job]['strategy']['matrix'], '${{ fromJSON(needs.matrix.outputs.' + output + ') }}')
            self.assertEqual(jobs[job]['runs-on'], '${{ matrix.os }}')
            self.assertEqual({row['os'] for row in inventory()[output]['include']}, PLATFORMS | {'macos-15-intel'})
        source = (WORKFLOWS / 'platform-acceptance.yml').read_text(encoding='utf-8')
        self.assertNotIn('REPORT_ONLY', source)
        self.assertNotIn('|| true', source)
        self.assertIn('scripts/test-browser-matrix.py', source)
        self.assertIn('scripts/browser-matrix.py --github-output "$GITHUB_OUTPUT"', source)

    def test_actual_installer_viewer_and_planner_are_exercised(self):
        jobs = workflow('platform-acceptance.yml')['jobs']
        install = '\n'.join(step.get('run', '') for step in jobs['install']['steps'])
        for script in ('test-install-home-assistant.py', 'test-public-package.py', 'test_package_release.py'):
            self.assertIn(script, install)
        steps = jobs['browser']['steps']
        viewer_commands = [step for step in steps if 'node scripts/test-browser-stability.cjs' in step.get('run', '')]
        self.assertEqual([step.get('id') for step in viewer_commands],
                         ['viewer_6_acceptance', 'viewer_24_acceptance', 'viewer_touch_diagnostics'])
        viewer = [step for step in viewer_commands if step['id'] in {'viewer_6_acceptance', 'viewer_24_acceptance'}]
        self.assertNotIn('if', viewer[0])
        self.assertEqual(viewer[1]['if'], PREPARED_OR_OTHER_OS)
        planner = [step for step in steps if step.get('id') == 'planner_acceptance']
        self.assertEqual(len(viewer), 2)
        self.assertEqual(len(planner), 1)
        self.assertEqual(viewer[1]['env']['BROWSER_STABILITY_ROOMS'], '24')
        for step in viewer + planner:
            self.assertIn('HOME_STUDIO_DIAGNOSTICS_DIR', step['env'])
            self.assertIn('if [ "$RUNNER_OS" = Linux ]', step['run'])
        env = jobs['browser']['env']
        for name, field in [('HOME_STUDIO_BROWSER_CHANNEL', 'channel'), ('HOME_STUDIO_BROWSER_PROFILE', 'profile'),
                            ('HOME_STUDIO_EXPECT_BROWSER_MAJOR', 'major'),
                            ('HOME_STUDIO_EXPECT_BROWSER_VERSION', 'browser_version')]:
            self.assertEqual(env[name], '${{ matrix.' + field + ' }}')
        runs = '\n'.join(step.get('run', '') for step in steps)
        self.assertIn('scripts/setup-browser-toolchain.py', runs)
        self.assertIn('scripts/setup-chrome-for-testing.py', runs)
        self.assertIn('python3 scripts/install-browser-with-retry.py', runs)
        inventory_checks = '\n'.join(step.get('run', '') for step in jobs['matrix']['steps'])
        self.assertIn('python3 scripts/test-browser-install.py', inventory_checks)

    def test_native_draw_diagnostic_is_separate_and_only_follows_a_legacy_failure(self):
        steps = workflow('platform-acceptance.yml')['jobs']['native-browser']['steps']
        primary = next(step for step in steps if step.get('id') == 'native_acceptance')
        diagnostic = next(step for step in steps if step.get('id') == 'native_draw_diagnostic')
        self.assertNotIn('if', primary)
        self.assertEqual(diagnostic['if'], "${{ !cancelled() && steps.native_acceptance.outcome == 'failure' && startsWith(matrix.os, 'macos-') && (matrix.product == 'waterfox' || (matrix.product == 'firefox' && matrix.version == '153.5.0esr')) }}")
        self.assertLess(steps.index(primary), steps.index(diagnostic))
        self.assertEqual(diagnostic['env']['NATIVE_BROWSER_INSTALL_DIR'], primary['env']['NATIVE_BROWSER_INSTALL_DIR'])
        self.assertIn('scripts/diagnose-native-draw.py', diagnostic['run'])
        self.assertNotIn('test-native-browser-acceptance.py', diagnostic['run'])
        self.assertIn('--primary-output "$NATIVE_BROWSER_DIAGNOSTICS_DIR"', diagnostic['run'])
        self.assertIn('--output "$NATIVE_BROWSER_DIAGNOSTICS_DIR/diagnostics/first-frame"', diagnostic['run'])
        self.assertNotIn('continue-on-error', primary)
        self.assertNotIn('continue-on-error', diagnostic)
        package = '\n'.join(step.get('run','') for step in workflow('package.yml')['jobs']['package']['steps'])
        self.assertIn('python3 scripts/test-native-draw-diagnostic.py', package)
        self.assertIn('node --test scripts/test-native-draw-diagnostic.cjs', package)

    def test_touch_comparisons_only_rerun_failed_sizes_and_never_hide_a_failure(self):
        steps = workflow('platform-acceptance.yml')['jobs']['browser']['steps']
        diagnostic = next(step for step in steps if step.get('id') == 'viewer_touch_diagnostics')
        self.assertEqual(diagnostic['if'], "${{ !cancelled() && matrix.engine == 'chromium' && matrix.profile != 'desktop' && (steps.viewer_6_acceptance.outcome == 'failure' || steps.viewer_24_acceptance.outcome == 'failure') }}")
        self.assertEqual(diagnostic['env'], {
            'VIEWER_6_OUTCOME': '${{ steps.viewer_6_acceptance.outcome }}',
            'VIEWER_24_OUTCOME': '${{ steps.viewer_24_acceptance.outcome }}',
            'BROWSER_STABILITY_TRACE_INPUT': '1',
        })
        self.assertNotIn('continue-on-error', diagnostic)
        fake_node = '''node() {
          printf '%s|%s|%s\\n' "$1" "$BROWSER_STABILITY_ROOMS" "$BROWSER_STABILITY_TOUCH_TAP" >> "$CALL_LOG"
          [ "$BROWSER_STABILITY_TOUCH_TAP" != "$FAILED_MODE" ]
        }
        xvfb-run() { shift; "$@"; }
        '''
        for runner in ('Linux', 'Windows'):
            for failed_sizes in ([], [6], [24], [6, 24]):
                for failed_mode in ('none', 'playwright'):
                    with self.subTest(runner=runner, sizes=failed_sizes, failed_mode=failed_mode), tempfile.TemporaryDirectory() as directory:
                        log = Path(directory) / 'calls.txt'
                        result = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', fake_node + diagnostic['run']],
                            env={**os.environ, 'CALL_LOG':str(log), 'RUNNER_OS':runner, 'FAILED_MODE':failed_mode,
                                 'VIEWER_6_OUTCOME':'failure' if 6 in failed_sizes else 'success',
                                 'VIEWER_24_OUTCOME':'failure' if 24 in failed_sizes else 'success'},
                            cwd=directory, capture_output=True, text=True)
                        expected = [f'scripts/test-browser-stability.cjs|{size}|{mode}'
                                    for size in failed_sizes for mode in ('playwright', 'gesture50')]
                        self.assertEqual(log.read_text().splitlines() if log.exists() else [], expected)
                        self.assertEqual(result.returncode, 1 if failed_sizes and failed_mode != 'none' else 0, result.stderr)

    def test_windows_webkit_recovery_comparisons_are_failure_only_diagnostics(self):
        steps = workflow('platform-acceptance.yml')['jobs']['browser']['steps']
        primary = next(step for step in steps if step.get('id') == 'planner_acceptance')
        diagnostic = [step for step in steps if step.get('id') == 'planner_recovery_diagnostics']
        self.assertEqual(len(diagnostic), 1)
        diagnostic = diagnostic[0]
        self.assertEqual(primary['if'], PREPARED_OR_OTHER_OS)
        self.assertNotIn('PLANNER_STABILITY_RESTORE_LAYOUT', primary['env'])
        self.assertNotIn('PLANNER_STABILITY_RECOVERY_ACTIONS', primary['env'])
        self.assertNotIn('DEBUG', primary['env'])
        self.assertNotIn('PLANNER_STABILITY_TRACE_RECOVERY', primary['env'])
        self.assertNotIn('PLANNER_STABILITY_TRACE_RECOVERY', workflow('platform-acceptance.yml')['jobs']['browser']['env'])
        self.assertEqual(diagnostic['env'], {'DEBUG': 'pw:browser', 'PLANNER_STABILITY_TRACE_RECOVERY': '1'})
        self.assertIn('node scripts/test-planner-stability.cjs', primary['run'])
        self.assertEqual(diagnostic['if'], "${{ !cancelled() && steps.planner_acceptance.outcome == 'failure' && matrix.engine == 'webkit' && matrix.os == 'windows-2022' }}")
        self.assertLess(steps.index(primary), steps.index(diagnostic))
        for step in (primary, diagnostic):
            self.assertNotIn('continue-on-error', step)
        fake_node = '''node() {
          printf '%s|%s|%s|%s\\n' "$1" "$PLANNER_STABILITY_RECOVERY_ACTIONS" "$PLANNER_STABILITY_RESTORE_LAYOUT" "$HOME_STUDIO_DIAGNOSTICS_DIR" >> "$CALL_LOG"
          printf 'browser stdout\\n'
          printf 'browser stderr\\n' >&2
          [ "$PLANNER_STABILITY_RECOVERY_ACTIONS" != "$FAILED_ACTION" ]
        }
        '''
        expected = [
            f'scripts/test-planner-stability.cjs|{actions}|{layout}|acceptance-artifacts/diagnostics/planner-{name}'
            for name, actions, layout in [('settled', 'all', 'settled'), ('none', 'none', 'immediate'),
                                         ('edit', 'edit', 'immediate'), ('resize', 'resize', 'immediate')]
        ]
        for failed_action in ('all', 'edit', 'no-failure'):
            with self.subTest(failed_action=failed_action), tempfile.TemporaryDirectory() as directory:
                log = Path(directory) / 'calls.txt'
                result = subprocess.run(['bash', '-e', '-o', 'pipefail', '-c', fake_node + diagnostic['run']],
                                        env={**os.environ, 'CALL_LOG': str(log), 'FAILED_ACTION': failed_action},
                                        cwd=directory, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0 if failed_action == 'no-failure' else 1, result.stderr)
                self.assertEqual(log.read_text().splitlines(), expected)
                for comparison in ('settled', 'none', 'edit', 'resize'):
                    process_log = Path(directory) / f'acceptance-artifacts/diagnostics/planner-{comparison}/browser-process.log'
                    self.assertEqual(process_log.read_text(), 'browser stdout\nbrowser stderr\n')

    def test_native_browsers_use_exact_verified_downloads_and_versions(self):
        job = workflow('platform-acceptance.yml')['jobs']['native-browser']
        runs = '\n'.join(step.get('run', '') for step in job['steps'])
        self.assertIn('scripts/test-waterfox-tooling.py', runs)
        self.assertIn('scripts/setup-native-browser.py --product "$NATIVE_BROWSER_PRODUCT" --version "$NATIVE_BROWSER_VERSION"', runs)
        self.assertIn('scripts/test-native-browser-acceptance.py --product "$NATIVE_BROWSER_PRODUCT" --expected-version "$NATIVE_BROWSER_VERSION"', runs)
        self.assertIn('xvfb-run -a', runs)
        self.assertNotIn('--headless', runs)
        for row in inventory()['native']['include']:
            manifest = json.loads((ROOT / f'scripts/{row["product"]}-versions.json').read_text())
            key = {'ubuntu-24.04': 'linux-x64', 'windows-2022': 'windows-x64',
                   'macos-15': 'macos', 'macos-15-intel': 'macos'}[row['os']]
            download = manifest['versions'][row['version']][key]
            url = urlsplit(download['url'])
            self.assertEqual(url.scheme, 'https')
            self.assertIn(url.netloc, {'cdn.waterfox.com', 'archive.mozilla.org'})
            self.assertIn(row['version'], url.path)
            self.assertRegex(download['sha512'], r'^[0-9a-f]{128}$')

    def test_safari_uses_the_actual_macos_browser(self):
        job = workflow('platform-acceptance.yml')['jobs']['safari']
        self.assertEqual(job['runs-on'], 'macos-15')
        runs = '\n'.join(step.get('run', '') for step in job['steps'])
        self.assertIn('sudo /usr/bin/safaridriver --enable', runs)
        self.assertIn('scripts/test-safari-tooling.py', runs)
        self.assertIn('scripts/test-safari-acceptance.py --output acceptance-artifacts/safari', runs)

    def test_macos_gecko_backends_are_scoped_to_the_supported_versions(self):
        jobs = workflow('platform-acceptance.yml')['jobs']
        browser = jobs['browser']['env']
        native = jobs['native-browser']['env']
        self.assertEqual(native['FIREFOX_RENDERER_VISIBILITY'], "${{ matrix.renderer_visibility || 'unmasked' }}")
        self.assertEqual(browser['FIREFOX_WEBGL_BACKEND'],
                         "${{ matrix.os == 'macos-15' && matrix.engine == 'firefox' && (matrix.playwright == '1.63.0' || matrix.playwright == '1.64.0') && 'angle' || 'default' }}")
        self.assertEqual(browser['FIREFOX_COMPOSITOR_BACKEND'],
                         "${{ startsWith(matrix.os, 'macos-') && matrix.engine == 'firefox' && matrix.playwright == '1.62.1' && 'software' || 'default' }}")
        self.assertEqual(browser['FIREFOX_GPU_PROCESS'],
                         "${{ startsWith(matrix.os, 'macos-') && matrix.engine == 'firefox' && matrix.playwright == '1.62.1' && 'disabled' || 'default' }}")
        self.assertEqual(native['FIREFOX_WEBGL_BACKEND'],
                         "${{ matrix.os == 'macos-15' && matrix.product == 'firefox' && matrix.version == '158.0' && 'angle' || 'default' }}")
        self.assertEqual(native['FIREFOX_COMPOSITOR_BACKEND'],
                         "${{ startsWith(matrix.os, 'macos-') && (matrix.product == 'waterfox' || (matrix.product == 'firefox' && matrix.version == '153.5.0esr')) && 'software' || 'default' }}")
        self.assertEqual(native['FIREFOX_GPU_PROCESS'],
                         "${{ startsWith(matrix.os, 'macos-') && (matrix.product == 'waterfox' || (matrix.product == 'firefox' && matrix.version == '153.5.0esr')) && 'disabled' || 'default' }}")

    def test_chromium_backend_uses_hosted_metal_only_on_macos(self):
        browser = workflow('platform-acceptance.yml')['jobs']['browser']['env']
        self.assertEqual(browser['CHROMIUM_ANGLE_BACKEND'],
                         "${{ matrix.os == 'macos-15' && matrix.engine == 'chromium' && 'metal' || 'swiftshader' }}")

    def test_every_browser_lane_preserves_failure_evidence(self):
        jobs = workflow('platform-acceptance.yml')['jobs']
        for name in ('browser', 'native-browser', 'safari'):
            with self.subTest(job=name):
                upload = next(step for step in jobs[name]['steps'] if step.get('uses', '').startswith('actions/upload-artifact@'))
                self.assertEqual(upload['if'], '${{ always() }}')
                self.assertEqual(upload['with']['if-no-files-found'], 'error')
                self.assertEqual(upload['with']['retention-days'], '14')
                if name != 'safari':
                    self.assertIn('${{ matrix.os }}', upload['with']['name'])
                    self.assertIn('${{ matrix.id }}', upload['with']['name'])


if __name__ == '__main__':
    unittest.main()
