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


def workflow(name):
    return yaml.load((WORKFLOWS / name).read_text(encoding='utf-8'), Loader=yaml.BaseLoader)


def inventory():
    spec = importlib.util.spec_from_file_location('browser_matrix', ROOT / 'scripts/browser-matrix.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.expand(module.load_manifest())


class PlatformAcceptanceTests(unittest.TestCase):
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
            self.assertEqual({row['os'] for row in inventory()[output]['include']}, PLATFORMS)
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
        viewer = [step for step in steps if 'node scripts/test-browser-stability.cjs' in step.get('run', '')]
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
        self.assertIn('"$HOME_STUDIO_PLAYWRIGHT_MODULE/cli.js"', runs)

    def test_windows_webkit_recovery_comparisons_are_failure_only_diagnostics(self):
        steps = workflow('platform-acceptance.yml')['jobs']['browser']['steps']
        primary = next(step for step in steps if step.get('id') == 'planner_acceptance')
        diagnostic = [step for step in steps if step.get('id') == 'planner_recovery_diagnostics']
        self.assertEqual(len(diagnostic), 1)
        diagnostic = diagnostic[0]
        self.assertEqual(primary['if'], '${{ !cancelled() }}')
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
            key = {'ubuntu-24.04': 'linux-x64', 'windows-2022': 'windows-x64', 'macos-15': 'macos'}[row['os']]
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
        self.assertEqual(browser['FIREFOX_WEBGL_BACKEND'],
                         "${{ matrix.os == 'macos-15' && matrix.engine == 'firefox' && (matrix.playwright == '1.63.0' || matrix.playwright == '1.64.0') && 'angle' || 'default' }}")
        self.assertEqual(browser['FIREFOX_COMPOSITOR_BACKEND'],
                         "${{ matrix.os == 'macos-15' && matrix.engine == 'firefox' && matrix.playwright == '1.62.1' && 'software' || 'default' }}")
        self.assertEqual(browser['FIREFOX_GPU_PROCESS'],
                         "${{ matrix.os == 'macos-15' && matrix.engine == 'firefox' && matrix.playwright == '1.62.1' && 'disabled' || 'default' }}")
        self.assertEqual(native['FIREFOX_WEBGL_BACKEND'],
                         "${{ matrix.os == 'macos-15' && matrix.product == 'firefox' && matrix.version == '158.0' && 'angle' || 'default' }}")
        self.assertEqual(native['FIREFOX_COMPOSITOR_BACKEND'],
                         "${{ matrix.os == 'macos-15' && (matrix.product == 'waterfox' || (matrix.product == 'firefox' && matrix.version == '153.5.0esr')) && 'software' || 'default' }}")
        self.assertEqual(native['FIREFOX_GPU_PROCESS'],
                         "${{ matrix.os == 'macos-15' && (matrix.product == 'waterfox' || (matrix.product == 'firefox' && matrix.version == '153.5.0esr')) && 'disabled' || 'default' }}")

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
