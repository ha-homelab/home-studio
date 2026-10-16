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
spec = importlib.util.spec_from_file_location('intel_comparison', HERE / 'run-intel-cgl-scalar-shadow.py')
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)
ARMS = (('baseline', comparison.BASELINE), ('candidate', comparison.CANDIDATES['scalar-shadow']))


class IntelComparisonTests(unittest.TestCase):
    def test_unselected_template_fails_before_any_source_or_host_action(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(comparison, 'CANDIDATES', {'scalar-shadow': 'UNSELECTED'}), \
             patch.object(comparison, 'source_snapshot') as snapshot, \
             patch.object(comparison, 'indexing_command') as indexing, \
             patch.object(comparison.subprocess, 'run') as run:
            root = Path(directory)
            self.assertEqual(comparison.run_comparison(root, root / 'none', root / 'out',
                'scalar-shadow', 'firefox'), 1)
            manifest = json.loads((root / 'out/comparison.json').read_text())
            self.assertIn('Select one exact non-baseline candidate SHA', manifest['error'])
            self.assertEqual(manifest['arms'], [])
            self.assertFalse(manifest['releaseEligible'])
            self.assertEqual(manifest['acceptanceStatus'], 'not-run')
            snapshot.assert_not_called()
            indexing.assert_not_called()
            run.assert_not_called()

    def test_selection_requires_exact_pin_proofs_and_matching_workflow(self):
        sha = 'a' * 40
        proofs = ('scripts/test-selected-point.cjs', 'scripts/test-selected-directional.cjs', 'scripts/test-selected-shadow.cjs')
        valid = f'revision: {sha}\nrevision: {sha}\n' + ''.join('node candidate/' + proof + '\n' for proof in proofs)
        with patch.object(comparison, 'CANDIDATES', {'scalar-shadow': sha}), \
             patch.object(comparison, 'CANDIDATE_CPU_CHECKS', proofs), \
             patch.object(Path, 'read_text', return_value=valid):
            comparison.validate_selection()
            for wrong in ['main', 'UNSELECTED', '0' * 40, comparison.BASELINE, 'A' * 40, 'g' * 40]:
                with self.subTest(revision=wrong), \
                     patch.object(comparison, 'CANDIDATES', {'scalar-shadow': wrong}), \
                     self.assertRaises(ValueError):
                    comparison.validate_selection()
            for wrong in ['UNSELECTED', (), (proofs[0],), (proofs[0], proofs[1]), (proofs[0], proofs[1], proofs[0]), (proofs[0], proofs[1], '../test.cjs'), (proofs[0], proofs[1], 'scripts/test-foo.cjs;echo')]:
                with self.subTest(proofs=wrong), patch.object(comparison, 'CANDIDATE_CPU_CHECKS', wrong), self.assertRaises(ValueError):
                    comparison.validate_selection()
            for wrong in [valid.replace('revision:', 'wrong:', 1), valid.replace(proofs[0], 'wrong'), valid.replace(proofs[1], 'wrong'), valid.replace(proofs[2], 'wrong'), valid + f'revision: {sha}\n', valid + 'node candidate/' + proofs[1] + '\n']:
                with patch.object(Path, 'read_text', return_value=wrong), self.assertRaises(ValueError):
                    comparison.validate_selection()
            with patch.object(comparison, 'CANDIDATES', {'scalar-shadow': sha, 'extra': sha}), self.assertRaises(ValueError):
                comparison.validate_selection()

    def test_optional_toolchain_cpu_identity_precedes_browser_installation(self):
        text = (HERE.parent / '.github/workflows/intel-cgl-scalar-shadow.yml').read_text()
        command = '/usr/sbin/sysctl machdep.cpu.brand_string hw.ncpu hw.memsize || true'
        self.assertEqual(text.count(command), 1)
        self.assertLess(text.index(command), text.index('name: Install one original checksum'))

    def test_selection_gate_precedes_all_checkouts_except_harness(self):
        text = (HERE.parent / '.github/workflows/intel-cgl-scalar-shadow.yml').read_text()
        gate = text.index('run: python3 harness/scripts/run-intel-cgl-scalar-shadow.py --validate-selection')
        self.assertLess(gate, text.index('name: Check out the exact common baseline'))
        self.assertLess(gate, text.index('name: Check out the exact independent candidate'))
        self.assertLess(gate, text.index('name: Install one original checksum'))
        self.assertNotIn('if:', text[text.rfind('      - name:', 0, gate):gate])

    def setUp(self):
        # Never include the caller's credentials in a failed mock-call diff.
        environment = patch.dict(comparison.os.environ, {
            'PATH': '/usr/bin:/bin', 'GITHUB_ACTIONS': 'true',
            'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'macOS'}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        host = patch.object(comparison.platform, 'platform', return_value='Darwin-test-x86_64')
        host.start()
        self.addCleanup(host.stop)
        system = patch.object(comparison.sys, 'platform', 'darwin')
        system.start()
        self.addCleanup(system.stop)
        machine = patch.object(comparison.platform, 'machine', return_value='x86_64')
        machine.start()
        self.addCleanup(machine.stop)

    def run_fixture(self, exit_codes, mutate=False, mismatched_driver=False,
                    candidate='scalar-shadow', product='firefox', mutate_install=False,
                    cpu_error=False, indexing_codes=None, indexing_statuses=None):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        install = root / 'install.json'
        install.write_text('{"testFixture":true}')
        output = root / 'diagnostics'
        observed = []
        self.indexing_calls, self.events = [], []

        def run(command, **kwargs):
            if command[0] in ('/usr/bin/mdutil', '/usr/bin/sudo'):
                self.indexing_calls.append(command)
                self.events.append(('control', len(self.indexing_calls)))
                index = len(self.indexing_calls) - 1
                code = (indexing_codes or [0, 0, 0, 0, 0])[index]
                if isinstance(code, Exception):
                    raise code
                stdout = ('/:\n\tIndexing enabled.\n/System/Volumes/Data:\n\tIndexing enabled.\n'
                          if index == 0 else '/:\n\tIndexing disabled.\n/System/Volumes/Data:\n\tIndexing disabled.\n')
                if index in (indexing_statuses or {}):
                    stdout = indexing_statuses[index]
                return subprocess.CompletedProcess(command, code, stdout=stdout, stderr='')
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
            self.events.append(('suite', arm))
            if mutate_install:
                install.write_text('{"changed":true}')
            result = exit_codes[len(observed) - 1]
            if isinstance(result, Exception):
                raise result
            return subprocess.CompletedProcess(command, result)

        calls = {}

        def snapshot(source, revision):
            calls[source.name] = calls.get(source.name, 0) + 1
            value = 'changed' if mutate and calls[source.name] > 1 else 'original'
            driver = 'different' if mismatched_driver and source.name == ARMS[1][0] else 'same-driver'
            return {'revision': revision, 'files': {'viewer.js': value,
                **{path: driver for path in comparison.DRIVER_FILES}}}

        with patch.object(comparison, 'validate_selection'), \
             patch.object(comparison.platform, 'system', return_value='Darwin'), \
             patch.object(comparison.platform, 'machine', return_value='x86_64'), \
             patch.object(comparison, 'source_snapshot', side_effect=snapshot), \
             patch.object(comparison, 'host_resources', return_value={'capturedAt': 'now', 'sysctl': {'hw.logicalcpu': '4'}}), \
             patch.object(comparison, 'cpu_processes', return_value={'status': 'ok', 'processes': []},
                          side_effect=OSError('private capture detail') if cpu_error else None), \
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
            cpu = [json.loads(line) for line in (output / name / 'cpu-processes.jsonl').read_text().splitlines()]
            self.assertEqual([sample['phase'] for sample in cpu], ['before', 'after'])
            arm = next(arm for arm in manifest['arms'] if arm['name'] == name)
            self.assertEqual(arm['cpuSampler']['attemptedRecords'], 2)
            self.assertLessEqual(arm['suiteElapsedSeconds'], arm['elapsedSeconds'])

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
        self.assertEqual(self.indexing_calls, [])

    def test_exact_two_source_order(self):
        self.assertEqual(comparison.CANDIDATE_CPU_CHECKS, ('scripts/test-literal-lambert-point-body.cjs', 'scripts/test-literal-lambert-directional.cjs', 'scripts/test-scalar-shadow-point.cjs'))
        self.assertEqual(ARMS, (
            ('baseline', 'be640ec12f0acd3abf094d5f5fa03ce2ad2781fe'),
            ('candidate', 'c6da122681807da85858a90a629de99997a72531'),
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
             patch.object(comparison, 'validate_selection'), \
             patch.object(comparison.platform, 'machine', return_value='arm64'), \
             patch.object(comparison.subprocess, 'run') as run:
            root = Path(directory)
            self.assertEqual(comparison.run_comparison(root, root / 'missing.json', root / 'output', 'scalar-shadow', 'firefox'), 1)
            run.assert_not_called()
            self.assertEqual(json.loads((root / 'output/comparison.json').read_text())['status'], 'infrastructure-error')

    def test_both_product_pairs_keep_fixed_revisions_versions_and_host_records(self):
        self.assertEqual(comparison.CANDIDATES, {
            'scalar-shadow': 'c6da122681807da85858a90a629de99997a72531',
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
        text = (HERE.parent / '.github/workflows/intel-cgl-scalar-shadow.yml').read_text()
        self.assertIn('branches: [diagnostic/intel-cgl-scalar-shadow]', text)
        self.assertIn("github.ref == 'refs/heads/diagnostic/intel-cgl-scalar-shadow'", text)
        self.assertIn('runs-on: macos-15-intel', text)
        self.assertIn('timeout-minutes: 30', text)
        self.assertIn('max-parallel: 2', text)
        self.assertIn('fail-fast: false', text)
        entries = re.findall(r'- product: (\S+)\n +version: (\S+)\n +candidate: (\S+)\n +revision: (\S+)', text)
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
        self.assertIn('name: diagnostic-intel-cgl-scalar-shadow-', text)
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
            self.assertNotIn('diagnostic/intel-cgl-scalar-shadow', workflow)
        for path in (HERE.parent / '.github/workflows').glob('intel-cgl-*.yml'):
            if path.name != 'intel-cgl-scalar-shadow.yml':
                self.assertNotIn('diagnostic/intel-cgl-scalar-shadow', path.read_text())
        self.assertFalse((HERE.parent / '.github/workflows/intel-cgl-boundaries.yml').exists())

    def test_candidate_cpu_contract_runs_before_browser_installation(self):
        text = (HERE.parent / '.github/workflows/intel-cgl-scalar-shadow.yml').read_text()
        commands = ['node candidate/' + proof for proof in comparison.CANDIDATE_CPU_CHECKS]
        prepare = text.split('      - name: Record tooling and prepare both fixtures before timing\n', 1)[1].split('      - name:', 1)[0]
        self.assertEqual([line.strip() for line in prepare.splitlines() if line.strip().startswith('node candidate/')], commands)
        # Only the explicitly optional read-only CPU identity may fail open.
        strict = prepare.replace('/usr/sbin/sysctl machdep.cpu.brand_string hw.ncpu hw.memsize || true', '')
        self.assertNotRegex(strict, r'(?m)^ +if:|continue-on-error|\|\|')
        for command in commands:
            self.assertEqual(text.count(command), 1)
            self.assertLess(text.index(command), text.index('      - name: Install one original checksum'))

    def test_indexing_host_gate_rejects_every_missing_or_wrong_indicator_before_subprocess(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(comparison.subprocess, 'run') as run:
            path = Path(directory) / 'status.json'
            for key, values in {
                    'GITHUB_ACTIONS': ['', 'false'],
                    'RUNNER_ENVIRONMENT': ['', 'self-hosted'],
                    'RUNNER_OS': ['', 'Linux', 'Windows']}.items():
                for value in values:
                    with self.subTest(key=key, value=value), patch.dict(comparison.os.environ, {key: value}):
                        with self.assertRaises(ValueError):
                            comparison.indexing_command(path, disable=True)
            for attr, value in [('platform', 'linux'), ('platform', 'win32')]:
                with patch.object(comparison.sys, attr, value), self.assertRaises(ValueError):
                    comparison.indexing_command(path, disable=True)
            with patch.object(comparison.platform, 'machine', return_value='arm64'), self.assertRaises(ValueError):
                comparison.indexing_command(path, disable=True)
            run.assert_not_called()
            self.assertFalse(path.exists())

    def test_one_normalization_precedes_both_sources_and_each_arm_rechecks_status(self):
        result, manifest, observed, output = self.run_fixture([0, 0])
        self.assertEqual(result, 0)
        self.assertEqual(self.events, [('control', 1), ('control', 2), ('control', 3),
            ('control', 4), ('suite', 'baseline'), ('control', 5), ('suite', 'candidate')])
        status = ['/usr/bin/mdutil', '-a', '-s']
        self.assertEqual(self.indexing_calls, [status,
            ['/usr/bin/sudo', '-n', '/usr/bin/mdutil', '-a', '-i', 'off'], status, status, status])
        self.assertEqual([arm['sourceRevision'] for arm in manifest['arms']], [revision for _, revision in ARMS])
        self.assertEqual(manifest['indexingControl']['scope'], 'both-arms')
        self.assertTrue(manifest['indexingControl']['verifiedDisabled'])
        for name in ('before', 'disable', 'after'):
            record = json.loads((output / ('indexing-' + name + '.json')).read_text())
            self.assertEqual(record['exitCode'], 0)
            self.assertEqual(record['timeoutSeconds'], 15)
        for arm in manifest['arms']:
            self.assertTrue(arm['indexingStatus']['verifiedDisabled'])
            record = json.loads((output / arm['name'] / arm['indexingStatus']['file']).read_text())
            self.assertEqual(record['command'], status)

    def test_each_indexing_command_failure_stops_before_affected_suite_and_fails_job(self):
        for index in range(5):
            with self.subTest(index=index):
                codes = [0] * 5
                codes[index] = 3
                result, manifest, observed, output = self.run_fixture([0, 0], indexing_codes=codes)
                self.assertEqual(result, 1)
                self.assertEqual(manifest['status'], 'infrastructure-error')
                self.assertEqual(manifest['indexingControl']['verifiedDisabled'], index >= 3)
                self.assertEqual([arm for arm, _ in observed], ['baseline'] if index == 4 else [])
                names = ('indexing-before.json', 'indexing-disable.json', 'indexing-after.json',
                         'baseline/indexing-before.json', 'candidate/indexing-before.json')
                self.assertEqual(json.loads((output / names[index]).read_text())['exitCode'], 3)
                if index >= 3:
                    self.assertEqual(manifest['arms'][index - 3]['status'], 'infrastructure-error')
                    self.assertFalse(manifest['arms'][index - 3]['indexingStatus']['verifiedDisabled'])
                self.assertLessEqual(sum(command[0].endswith('sudo') for command in self.indexing_calls), 1)

    def test_each_verification_rejects_enabled_unknown_partial_or_changed_volume_status(self):
        for index in (2, 3, 4):
            for text in ['', '/:\nIndexing enabled.\n', '/:\nunknown\n',
                         '/:\nIndexing disabled.\n', '/:\nIndexing disabled.\n/another:\nIndexing disabled.\n',
                         '/:\nIndexing disabled.\n/System/Volumes/Data:\nIndexing enabled.\n']:
                with self.subTest(index=index, status=text):
                    result, manifest, observed, _ = self.run_fixture([0, 0], indexing_statuses={index: text})
                    self.assertEqual(result, 1)
                    self.assertEqual([arm for arm, _ in observed], ['baseline'] if index == 4 else [])
                    self.assertEqual(manifest['indexingControl']['verifiedDisabled'], index >= 3)
                    self.assertEqual(manifest['status'], 'infrastructure-error')

    def test_failed_baseline_is_preserved_when_candidate_indexing_has_drifted(self):
        result, manifest, observed, _ = self.run_fixture([7], indexing_statuses={
            4: '/:\nIndexing enabled.\n/System/Volumes/Data:\nIndexing disabled.\n'})
        self.assertEqual(result, 1)
        self.assertEqual([arm for arm, _ in observed], ['baseline'])
        self.assertEqual(manifest['arms'][0]['status'], 'failed')
        self.assertEqual(manifest['arms'][0]['exitCode'], 7)
        self.assertEqual(manifest['arms'][1]['status'], 'infrastructure-error')
        self.assertEqual(sum(command[0].endswith('sudo') for command in self.indexing_calls), 1)

    def test_control_timeout_or_launch_error_never_starts_affected_suite(self):
        for index in (1, 4):
            for error in (OSError('private detail'), subprocess.TimeoutExpired('private command', 15)):
                with self.subTest(index=index, error=type(error).__name__):
                    codes = [0] * 5
                    codes[index] = error
                    result, manifest, observed, _ = self.run_fixture([0, 0], indexing_codes=codes)
                    self.assertEqual(result, 1)
                    self.assertEqual([arm for arm, _ in observed], ['baseline'] if index == 4 else [])
                    self.assertNotIn('private', json.dumps(manifest))

    def test_indexing_command_capture_is_capped_and_timeout_is_a_failure_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'status.json'
            with patch.object(comparison.subprocess, 'run', return_value=
                              subprocess.CompletedProcess([], 0, stdout='s' * 5000, stderr='e' * 5000)) as run:
                record = comparison.indexing_command(path)
            self.assertEqual(run.call_args.kwargs['timeout'], 15)
            self.assertEqual(run.call_args.kwargs['env']['LC_ALL'], 'C')
            self.assertEqual(len(record['stdout']), 4096)
            self.assertEqual(len(record['stderr']), 4096)
            self.assertTrue(record['stdoutTruncated'] and record['stderrTruncated'])
            with self.assertRaises(ValueError):
                comparison.indexing_volumes(record)
            for error in (OSError('private exception'), subprocess.TimeoutExpired(
                    'private command', 15, output=b'x' * 5000, stderr=b'e')):
                with patch.object(comparison.subprocess, 'run', side_effect=error), self.assertRaises(RuntimeError):
                    comparison.indexing_command(path, disable=True)
                record = json.loads(path.read_text())
                self.assertEqual(record['status'], 'failed')
                self.assertEqual(record['error'], type(error).__name__)
                self.assertNotIn('private', json.dumps(record))

    def test_cpu_capture_is_numeric_top_eight_and_basename_only(self):
        rows = [f'{index} 1 {index}.5 {index * 1024} /private/parent/App {index}'
                for index in range(1, 11)]
        rows += ['11 1 nan 1 /private/nan', '12 1 -1 1 bad', 'bad row']
        result = subprocess.CompletedProcess([], 0, stdout='\n'.join(rows))
        with patch.object(comparison.subprocess, 'run', return_value=result) as run:
            capture = comparison.cpu_processes()
        self.assertEqual(run.call_args.args[0],
                         ['/bin/ps', '-axo', 'pid=,ppid=,%cpu=,rss=,comm='])
        self.assertEqual(run.call_args.kwargs['timeout'], 2)
        self.assertEqual(run.call_args.kwargs['stderr'], subprocess.DEVNULL)
        self.assertEqual(run.call_args.kwargs['env']['LC_ALL'], 'C')
        self.assertEqual(capture['discardedRows'], 3)
        self.assertEqual([row['pid'] for row in capture['processes']], list(range(10, 2, -1)))
        self.assertEqual(capture['processes'][0],
                         {'pid': 10, 'ppid': 1, 'cpuPercent': 10.5, 'rssKiB': 10240, 'name': 'App 10'})
        self.assertNotIn('/private', json.dumps(capture))
        self.assertTrue(all(set(row) == {'pid', 'ppid', 'cpuPercent', 'rssKiB', 'name'}
                            for row in capture['processes']))

    def test_cpu_errors_do_not_replace_original_suite_failures(self):
        result, manifest, observed, output = self.run_fixture([1, 0], cpu_error=True)
        self.assertEqual(result, 1)
        self.assertEqual(len(observed), 2)
        self.assertEqual([arm['exitCode'] for arm in manifest['arms']], [1, 0])
        self.assertEqual([arm['status'] for arm in manifest['arms']], ['failed', 'passed'])
        self.assertNotIn('private capture detail', json.dumps(manifest))
        for arm in manifest['arms']:
            self.assertEqual(arm['cpuSampler']['attemptedRecords'], 2)
            records = (output / arm['name'] / 'cpu-processes.jsonl').read_text()
            self.assertNotIn('private capture detail', records)
            self.assertEqual([json.loads(line)['error'] for line in records.splitlines()], ['OSError'] * 2)

    def test_suite_launch_exception_still_stops_sampler_and_runs_candidate(self):
        result, manifest, observed, _ = self.run_fixture([OSError('cannot launch'), 0])
        self.assertEqual(result, 1)
        self.assertEqual(len(observed), 2)
        self.assertEqual([arm['status'] for arm in manifest['arms']], ['infrastructure-error', 'passed'])
        self.assertTrue(all(arm['cpuSampler']['attemptedRecords'] == 2 for arm in manifest['arms']))
        self.assertFalse(any(thread.name == 'diagnostic-cpu' for thread in comparison.threading.enumerate()))

    def test_cpu_capture_nonzero_exit_does_not_record_raw_output(self):
        with patch.object(comparison.subprocess, 'run', return_value=
                          subprocess.CompletedProcess([], 3, stdout='private output')):
            self.assertEqual(comparison.cpu_processes(),
                             {'status': 'error', 'error': 'ps-exit', 'exitCode': 3})

    def test_cpu_sampler_bounded_reserves_final_record_and_joins(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(comparison, 'cpu_processes', return_value={'status': 'ok', 'processes': []}), \
             patch.object(comparison.CPUSampler, 'interval', 0):
            sampler = comparison.CPUSampler(Path(directory) / 'cpu.jsonl')
            sampler.start()
            sampler.thread.join(timeout=5)
            self.assertFalse(sampler.thread.is_alive())
            receipt = sampler.finish()
            records = [json.loads(line) for line in sampler.path.read_text().splitlines()]
            self.assertEqual(len(records), 240)
            self.assertEqual([record['sample'] for record in records], list(range(1, 241)))
            self.assertEqual(records[0]['phase'], 'before')
            self.assertTrue(all(record['phase'] == 'during' for record in records[1:-1]))
            self.assertEqual(records[-1]['phase'], 'after')
            self.assertTrue(sampler.stop_event.is_set())
            self.assertEqual(receipt['attemptedRecords'], 240)
            self.assertEqual(receipt['errors'], [])

    def test_cpu_sampler_stops_promptly_without_waiting_full_interval(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(comparison, 'cpu_processes', return_value={'status': 'ok', 'processes': []}):
            sampler = comparison.CPUSampler(Path(directory) / 'cpu.jsonl')
            sampler.start()
            receipt = sampler.finish()
            self.assertFalse(sampler.thread.is_alive())
            self.assertTrue(sampler.stop_event.is_set())
            self.assertEqual(receipt['attemptedRecords'], 2)
            self.assertEqual(receipt['intervalSeconds'], 5)

    def test_cpu_sampler_capture_timeout_is_recorded_without_exception_payload(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(comparison, 'cpu_processes', side_effect=
                          subprocess.TimeoutExpired('private command', 2, output='private output')):
            sampler = comparison.CPUSampler(Path(directory) / 'cpu.jsonl')
            sampler.start()
            receipt = sampler.finish()
            records = [json.loads(line) for line in sampler.path.read_text().splitlines()]
            self.assertEqual([record['error'] for record in records], ['TimeoutExpired'] * 2)
            self.assertEqual(receipt['errors'], [{'operation': 'capture', 'type': 'TimeoutExpired'}] * 2)
            self.assertNotIn('private', json.dumps(records) + json.dumps(receipt))
            self.assertFalse(sampler.thread.is_alive())

    def test_cpu_sampler_start_and_write_failures_are_bounded_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(comparison, 'cpu_processes', return_value={'status': 'ok', 'processes': []}), \
             patch.object(comparison.threading.Thread, 'start', side_effect=RuntimeError('private')):
            sampler = comparison.CPUSampler(Path(directory) / 'missing' / 'cpu.jsonl')
            sampler.start()
            receipt = sampler.finish()
            self.assertIsNone(sampler.thread)
            self.assertEqual(receipt['errors'], [
                {'operation': 'write', 'type': 'FileNotFoundError'},
                {'operation': 'start', 'type': 'RuntimeError'},
                {'operation': 'write', 'type': 'FileNotFoundError'}])
            self.assertNotIn('private', json.dumps(receipt))


if __name__ == '__main__':
    unittest.main()
