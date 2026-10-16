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
spec = importlib.util.spec_from_file_location('intel_comparison', HERE / 'run-intel-cgl-boundaries.py')
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)
ARMS = (('baseline', comparison.BASELINE), ('candidate', comparison.CANDIDATES['fallback-boundaries']))


class IntelComparisonTests(unittest.TestCase):
    def setUp(self):
        # Never include the caller's credentials in a failed mock-call diff.
        environment = patch.dict(comparison.os.environ, {'PATH': '/usr/bin:/bin'}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        host = patch.object(comparison.platform, 'platform', return_value='Darwin-test-x86_64')
        host.start()
        self.addCleanup(host.stop)

    def run_fixture(self, exit_codes, mutate=False, mismatched_driver=False,
                    candidate='fallback-boundaries', product='firefox', mutate_install=False):
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
            self.assertEqual(kwargs['env']['GITHUB_SHA'], comparison.BASELINE if arm == 'baseline' else comparison.CANDIDATES[candidate])
            self.assertNotIn('--headless', command)
            self.assertNotIn('--diagnostic-only', command)
            kwargs['stdout'].write(b'original process output\n')
            raw = Path(command[-1])
            raw.mkdir()
            (raw / 'summary.json').write_bytes(b'{"originalFixtureReceipt":true}\n')
            observed.append((arm, command))
            if mutate_install:
                install.write_text('{"changed":true}')
            return subprocess.CompletedProcess(command, exit_codes[len(observed) - 1])

        calls = {}

        def snapshot(source, revision):
            calls[source.name] = calls.get(source.name, 0) + 1
            value = 'changed' if mutate and calls[source.name] > 1 else 'original'
            driver = 'different' if mismatched_driver and source.name == ARMS[1][0] else 'same-driver'
            return {'revision': revision, 'files': {'viewer.js': value,
                **{path: driver for path in comparison.DRIVER_FILES}}}

        with patch.object(comparison.platform, 'system', return_value='Darwin'), \
             patch.object(comparison.platform, 'machine', return_value='x86_64'), \
             patch.object(comparison, 'source_snapshot', side_effect=snapshot), \
             patch.object(comparison, 'host_resources', return_value={'capturedAt': 'now', 'sysctl': {'hw.logicalcpu': '4'}}), \
             patch.object(comparison.subprocess, 'run', side_effect=run):
            result = comparison.run_comparison(root, install, output, candidate, product)
        return result, json.loads((output / 'comparison.json').read_text()), observed, output

    def test_failed_first_arm_is_retained_and_remaining_sources_run_once(self):
        exits = [1] + [0] * (len(ARMS) - 1)
        result, manifest, observed, output = self.run_fixture(exits)
        self.assertEqual(result, 1)
        self.assertEqual([arm for arm, _ in observed], [name for name, _ in ARMS])
        self.assertEqual([arm['exitCode'] for arm in manifest['arms']], exits)
        self.assertEqual([arm['status'] for arm in manifest['arms']], ['failed'] + ['passed'] * (len(exits) - 1))
        self.assertTrue(manifest['diagnosticOnly'])
        self.assertFalse(manifest['releaseEligible'])
        self.assertEqual(manifest['acceptanceStatus'], 'not-run')
        for name, _ in ARMS:
            self.assertEqual((output / name / 'raw/summary.json').read_bytes(), b'{"originalFixtureReceipt":true}\n')
            self.assertEqual((output / name / 'process.log').read_bytes(), b'original process output\n')
            self.assertEqual(json.loads((output / name / 'source-before.json').read_text()),
                             json.loads((output / name / 'source-after.json').read_text()))

    def test_all_passing_commands_are_still_only_diagnostic_evidence(self):
        result, manifest, _, _ = self.run_fixture([0] * len(ARMS))
        self.assertEqual(result, 0)
        self.assertEqual(manifest['status'], 'completed')
        self.assertEqual(manifest['acceptanceStatus'], 'not-run')
        self.assertTrue(all(arm['sourceUnchanged'] for arm in manifest['arms']))

    def test_source_change_fails_even_when_original_commands_exit_zero(self):
        result, manifest, observed, _ = self.run_fixture([0] * len(ARMS), mutate=True)
        self.assertEqual(result, 1)
        self.assertEqual(len(observed), len(ARMS))
        self.assertEqual([arm['status'] for arm in manifest['arms']], ['infrastructure-error'] * len(ARMS))

    def test_driver_difference_aborts_before_any_browser_command(self):
        result, manifest, observed, _ = self.run_fixture([], mismatched_driver=True)
        self.assertEqual(result, 1)
        self.assertEqual(observed, [])
        self.assertEqual(manifest['status'], 'infrastructure-error')
        self.assertIn('original acceptance driver differs', manifest['error'])

    def test_exact_two_source_order(self):
        self.assertEqual(ARMS, (
            ('baseline', '13b8ed9e1f0baf68eac329764a05277377113419'),
            ('candidate', '800acbda7b8692b8c18d73e4be7b00211c552ff3'),
        ))

    def test_original_command_has_only_the_standard_installation_arguments(self):
        command = comparison.command_for(Path('/source'), Path('/install.json'), Path('/output'), 'firefox')
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
            self.assertEqual(comparison.run_comparison(root, root / 'missing.json', root / 'output', 'fallback-boundaries', 'firefox'), 1)
            run.assert_not_called()
            self.assertEqual(json.loads((root / 'output/comparison.json').read_text())['status'], 'infrastructure-error')

    def test_both_product_pairs_keep_fixed_revisions_versions_and_host_records(self):
        self.assertEqual(comparison.CANDIDATES, {
            'fallback-boundaries': '800acbda7b8692b8c18d73e4be7b00211c552ff3',
        })
        self.assertEqual(comparison.VERSIONS, {'firefox': '153.5.0esr', 'waterfox': '6.7.6'})
        for candidate, revision in comparison.CANDIDATES.items():
            for product, version in comparison.VERSIONS.items():
                with self.subTest(candidate=candidate, product=product):
                    result, manifest, observed, output = self.run_fixture([0, 0], candidate=candidate, product=product)
                    self.assertEqual(result, 0)
                    self.assertEqual([arm['sourceRevision'] for arm in manifest['arms']], [comparison.BASELINE, revision])
                    self.assertEqual(manifest['product'], product)
                    for name, command in observed:
                        self.assertEqual(command[command.index('--product') + 1], product)
                        self.assertEqual(command[command.index('--expected-version') + 1], version)
                        host = json.loads((output / name / 'host-before.json').read_text())
                        self.assertEqual(host['sysctl']['hw.logicalcpu'], '4')
                        self.assertEqual(host, next(arm for arm in manifest['arms'] if arm['name'] == name)['hostResourcesBefore'])

    def test_installation_mutation_fails_even_when_commands_pass(self):
        result, manifest, observed, _ = self.run_fixture([0, 0], mutate_install=True)
        self.assertEqual(result, 1)
        self.assertEqual(len(observed), 2)
        self.assertTrue(all(arm['status'] == 'infrastructure-error' for arm in manifest['arms']))

    def test_fixture_override_aborts_without_logging_its_value(self):
        with patch.dict(comparison.os.environ, {'HOME_STUDIO_SOURCE_ROOT': '/sensitive-value'}):
            result, manifest, observed, _ = self.run_fixture([])
        self.assertEqual(result, 1)
        self.assertEqual(observed, [])
        self.assertIn('HOME_STUDIO_SOURCE_ROOT', manifest['error'])
        self.assertNotIn('/sensitive-value', json.dumps(manifest))

    def test_host_metadata_is_bounded_allowlisted_and_not_a_process_dump(self):
        observed = []
        def run(command, **kwargs):
            observed.append(command)
            self.assertEqual(kwargs['timeout'], 5)
            self.assertFalse(kwargs['check'])
            self.assertEqual(kwargs['stdout'], subprocess.PIPE)
            text = ('machdep.cpu.brand_string: Test CPU\nhw.model: TestMac\nhw.logicalcpu: 4\n'
                    'hw.physicalcpu: 2\nhw.memsize: 15032385536\nkern.boottime: { sec = 123 }\n'
                    'unrequested.key: must-not-be-recorded\n') if command[0].endswith('sysctl') else 'up 10 mins, load averages: 0.5 0.4 0.3\n'
            return subprocess.CompletedProcess(command, 0, stdout=text, stderr='not-recorded')
        with patch.object(comparison.subprocess, 'run', side_effect=run):
            data = comparison.host_resources()
        self.assertEqual(observed, [
            ['/usr/sbin/sysctl', 'machdep.cpu.brand_string', 'hw.model', 'hw.logicalcpu',
             'hw.physicalcpu', 'hw.memsize', 'kern.boottime'], ['/usr/bin/uptime']])
        self.assertEqual(data['sysctl']['hw.memsize'], '15032385536')
        self.assertEqual(len(data['sysctl']), 6)
        self.assertNotIn('must-not-be-recorded', json.dumps(data))
        self.assertNotIn('not-recorded', json.dumps(data))
        with patch.object(comparison.subprocess, 'run', side_effect=subprocess.TimeoutExpired('sysctl', 5)):
            data = comparison.host_resources()
        self.assertEqual(data['sysctlError'], 'TimeoutExpired')
        self.assertEqual(data['uptimeError'], 'TimeoutExpired')

    def test_workflow_is_fixed_read_only_two_pair_diagnostic(self):
        text = (HERE.parent / '.github/workflows/intel-cgl-boundaries.yml').read_text()
        self.assertIn('branches: [diagnostic/intel-cgl-boundaries]', text)
        self.assertIn("github.ref == 'refs/heads/diagnostic/intel-cgl-boundaries'", text)
        self.assertIn('runs-on: macos-15-intel', text)
        self.assertIn('timeout-minutes: 30', text)
        self.assertIn('max-parallel: 2', text)
        self.assertIn('fail-fast: false', text)
        entries = re.findall(r'- product: (\S+)\n +version: (\S+)\n +candidate: (\S+)\n +revision: ([0-9a-f]{40})', text)
        self.assertEqual(set(entries), {(product, version, candidate, revision)
            for product, version in comparison.VERSIONS.items()
            for candidate, revision in comparison.CANDIDATES.items()})
        self.assertEqual(len(entries), 2)
        self.assertIn('ref: ' + comparison.BASELINE, text)
        self.assertIn('ref: ${{ matrix.revision }}', text)
        self.assertEqual(text.count('npm --prefix '), 2)
        self.assertIn('python3 baseline/scripts/setup-native-browser.py', text)
        self.assertIn('permissions:\n  contents: read', text)
        self.assertIn('if: ${{ always() }}', text)
        self.assertIn('name: diagnostic-intel-cgl-boundaries-', text)
        self.assertEqual(text.count('persist-credentials: false'), 3)
        self.assertNotRegex(text, r'workflow_dispatch|pull_request|secrets\.|continue-on-error|workflow_call|diagnose-restore|diagnose-native-draw')
        uses = re.findall(r'uses: ([^\s]+)', text)
        self.assertTrue(uses)
        self.assertTrue(all(re.fullmatch(r'actions/[a-z-]+@[0-9a-f]{40}', use) for use in uses))
        # The new branch has no general acceptance or publication push trigger.
        quality = (HERE.parent / '.github/workflows/quality-gate.yml').read_text()
        self.assertNotRegex(quality, re.compile(r'^  push:', re.MULTILINE))
        for name in ('release-pipeline.yml', 'pages.yml'):
            workflow = (HERE.parent / '.github/workflows' / name).read_text()
            self.assertNotIn('diagnostic/intel-cgl-boundaries', workflow)


if __name__ == '__main__':
    unittest.main()
