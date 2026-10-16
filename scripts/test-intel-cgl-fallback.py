"""Offline contracts for the disposable same-host Intel diagnostic."""
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('intel_comparison', HERE / 'run-intel-cgl-fallback.py')
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)


class IntelComparisonTests(unittest.TestCase):
    def setUp(self):
        # Never include the caller's credentials in a failed mock-call diff.
        environment = patch.dict(comparison.os.environ, {'PATH': '/usr/bin:/bin'}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        host = patch.object(comparison.platform, 'platform', return_value='Darwin-test-x86_64')
        host.start()
        self.addCleanup(host.stop)

    def run_fixture(self, exit_codes, mutate=False, mismatched_driver=False):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        install = root / 'install.json'
        install.write_text('{"testFixture":true}')
        output = root / 'diagnostics'
        observed = []

        def run(command, **kwargs):
            arm = command[1].split('/')[-3]
            manifest = json.loads((output / 'comparison.json').read_text())
            self.assertEqual(next(value for value in manifest['arms'] if value['name'] == arm)['status'], 'running')
            self.assertFalse(kwargs['check'])
            self.assertEqual(kwargs['stderr'], subprocess.STDOUT)
            self.assertEqual(kwargs['env']['FIREFOX_GPU_PROCESS'], 'disabled')
            self.assertEqual(kwargs['env']['GITHUB_SHA'], dict(comparison.ARMS)[arm])
            self.assertNotIn('--headless', command)
            self.assertNotIn('--diagnostic-only', command)
            kwargs['stdout'].write(b'original process output\n')
            raw = Path(command[-1])
            raw.mkdir()
            (raw / 'summary.json').write_bytes(b'{"originalFixtureReceipt":true}\n')
            observed.append((arm, command))
            return subprocess.CompletedProcess(command, exit_codes[len(observed) - 1])

        calls = {}

        def snapshot(source, revision):
            calls[source.name] = calls.get(source.name, 0) + 1
            value = 'changed' if mutate and calls[source.name] > 1 else 'original'
            driver = 'different' if mismatched_driver and source.name == comparison.ARMS[1][0] else 'same-driver'
            return {'revision': revision, 'files': {'viewer.js': value,
                **{path: driver for path in comparison.DRIVER_FILES}}}

        with patch.object(comparison.platform, 'system', return_value='Darwin'), \
             patch.object(comparison.platform, 'machine', return_value='x86_64'), \
             patch.object(comparison, 'source_snapshot', side_effect=snapshot), \
             patch.object(comparison.subprocess, 'run', side_effect=run):
            result = comparison.run_comparison(root, install, output)
        return result, json.loads((output / 'comparison.json').read_text()), observed, output

    def test_failed_first_arm_is_retained_and_remaining_sources_run_once(self):
        exits = [1] + [0] * (len(comparison.ARMS) - 1)
        result, manifest, observed, output = self.run_fixture(exits)
        self.assertEqual(result, 1)
        self.assertEqual([arm for arm, _ in observed], [name for name, _ in comparison.ARMS])
        self.assertEqual([arm['exitCode'] for arm in manifest['arms']], exits)
        self.assertEqual([arm['status'] for arm in manifest['arms']], ['failed'] + ['passed'] * (len(exits) - 1))
        self.assertTrue(manifest['diagnosticOnly'])
        self.assertFalse(manifest['releaseEligible'])
        self.assertEqual(manifest['acceptanceStatus'], 'not-run')
        for name, _ in comparison.ARMS:
            self.assertEqual((output / name / 'raw/summary.json').read_bytes(), b'{"originalFixtureReceipt":true}\n')
            self.assertEqual((output / name / 'process.log').read_bytes(), b'original process output\n')
            self.assertEqual(json.loads((output / name / 'source-before.json').read_text()),
                             json.loads((output / name / 'source-after.json').read_text()))

    def test_all_passing_commands_are_still_only_diagnostic_evidence(self):
        result, manifest, _, _ = self.run_fixture([0] * len(comparison.ARMS))
        self.assertEqual(result, 0)
        self.assertEqual(manifest['status'], 'completed')
        self.assertEqual(manifest['acceptanceStatus'], 'not-run')
        self.assertTrue(all(arm['sourceUnchanged'] for arm in manifest['arms']))

    def test_source_change_fails_even_when_original_commands_exit_zero(self):
        result, manifest, observed, _ = self.run_fixture([0] * len(comparison.ARMS), mutate=True)
        self.assertEqual(result, 1)
        self.assertEqual(len(observed), len(comparison.ARMS))
        self.assertEqual([arm['status'] for arm in manifest['arms']], ['infrastructure-error'] * len(comparison.ARMS))

    def test_driver_difference_aborts_before_any_browser_command(self):
        result, manifest, observed, _ = self.run_fixture([], mismatched_driver=True)
        self.assertEqual(result, 1)
        self.assertEqual(observed, [])
        self.assertEqual(manifest['status'], 'infrastructure-error')
        self.assertIn('original acceptance driver differs', manifest['error'])

    def test_exact_two_source_order(self):
        self.assertEqual(comparison.ARMS, (
            ('baseline', '9b8d52b164eb1364ce8504063096a506c63100eb'),
            ('fallback-shared', 'f4a9ebba66b8f7ddce017535092f1885fbbfa8c0'),
        ))

    def test_original_command_has_only_the_standard_installation_arguments(self):
        command = comparison.command_for(Path('/source'), Path('/install.json'), Path('/output'))
        self.assertEqual(command[1:], ['/source/scripts/test-native-browser-acceptance.py',
            '--product', 'firefox', '--expected-version', '153.5.0esr',
            '--installation', '/install.json', '--output', '/output/raw'])

    def test_rejects_wrong_revision_and_dirty_tracked_source(self):
        for answers in ([b'wrong\n'], [b'exact\n', b' M viewer.js\n']):
            with patch.object(comparison.subprocess, 'check_output', side_effect=answers), self.assertRaises(ValueError):
                comparison.source_snapshot(Path('/source'), 'exact')
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / 'viewer.js').write_text('source')
            (source / 'driver.py').write_text('driver')
            answers = [b'exact\n', b'', b'viewer.js\0driver.py\0']
            with patch.object(comparison.subprocess, 'check_output', side_effect=answers):
                snapshot = comparison.source_snapshot(source, 'exact')
            self.assertEqual(snapshot, {'revision': 'exact', 'files': {
                name: comparison.digest(source / name) for name in ('viewer.js', 'driver.py')}})

    def test_rejects_non_intel_host_without_launching(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(comparison.platform, 'machine', return_value='arm64'), \
             patch.object(comparison.subprocess, 'run') as run:
            root = Path(directory)
            self.assertEqual(comparison.run_comparison(root, root / 'missing.json', root / 'output'), 1)
            run.assert_not_called()
            self.assertEqual(json.loads((root / 'output/comparison.json').read_text())['status'], 'infrastructure-error')

    def test_workflow_is_fixed_read_only_branch_diagnostic(self):
        text = (HERE.parent / '.github/workflows/intel-cgl-fallback.yml').read_text().split('\n  playwright:', 1)[0]
        self.assertIn('branches: [diagnostic/intel-cgl-fallback]', text)
        self.assertIn("github.ref == 'refs/heads/diagnostic/intel-cgl-fallback'", text)
        self.assertIn('runs-on: macos-15-intel', text)
        self.assertIn('timeout-minutes: 30', text)
        self.assertEqual(len(re.findall(r'^          ref: [0-9a-f]{40}$', text, re.MULTILINE)), 2)
        self.assertEqual(text.count('npm --prefix '), 2)
        self.assertNotIn('diagnose-native-draw', text)
        self.assertIn('permissions:\n  contents: read', text)
        self.assertIn('if: ${{ always() }}', text)
        self.assertIn('name: diagnostic-intel-cgl-fallback-', text)
        self.assertEqual(text.count('persist-credentials: false'), 1 + len(comparison.ARMS))
        for _, revision in comparison.ARMS:
            self.assertIn(f'ref: {revision}', text)
        self.assertNotRegex(text, r'workflow_dispatch|pull_request|secrets\.|continue-on-error|workflow_call')
        uses = re.findall(r'uses: ([^\s]+)', text)
        self.assertTrue(uses)
        self.assertTrue(all(re.fullmatch(r'actions/[a-z-]+@[0-9a-f]{40}', use) for use in uses))


if __name__ == '__main__':
    unittest.main()
