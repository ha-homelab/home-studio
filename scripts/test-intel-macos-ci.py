"""Offline preparation contracts: every system command is mocked."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('intel_ci', Path(__file__).with_name('prepare-intel-macos-ci.py'))
intel = importlib.util.module_from_spec(spec)
spec.loader.exec_module(intel)
ENABLED = '/:\n\tIndexing enabled.\n/System/Volumes/Data:\n\tIndexing enabled.\n'
DISABLED = ENABLED.replace('enabled', 'disabled')
STATUS = ['/usr/bin/mdutil', '-a', '-s']
DISABLE = ['/usr/bin/sudo', '-n', '/usr/bin/mdutil', '-a', '-i', 'off']


class IntelPreparationTests(unittest.TestCase):
    def setUp(self):
        # Never expose caller environment values in mock failure output.
        for context in (patch.dict(intel.os.environ, {
                'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted',
                'RUNNER_OS': 'macOS'}, clear=True),
                patch.object(intel.sys, 'platform', 'darwin'),
                patch.object(intel.platform, 'machine', return_value='x86_64')):
            context.start()
            self.addCleanup(context.stop)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.output = Path(self.directory.name) / 'receipts'

    def run_preparation(self, results=None):
        results = results if results is not None else [ENABLED, DISABLED, DISABLED]
        def run(command, **kwargs):
            self.assertEqual(kwargs['timeout'], 15)
            self.assertEqual(kwargs['env']['LC_ALL'], 'C')
            self.assertFalse(kwargs['check'])
            value = results[run.calls]
            run.calls += 1
            if isinstance(value, Exception):
                raise value
            return value if isinstance(value, subprocess.CompletedProcess) else subprocess.CompletedProcess(
                command, 0, stdout=value, stderr='')
        run.calls = 0
        with patch.object(intel.subprocess, 'run', side_effect=run) as mocked:
            code = intel.main(['--output', str(self.output)])
        return code, json.loads((self.output / 'preparation.json').read_text()), mocked

    def test_prepares_once_with_exact_bounded_commands_and_receipts(self):
        code, receipt, mocked = self.run_preparation()
        self.assertEqual(code, 0)
        self.assertEqual([x.args[0] for x in mocked.call_args_list], [STATUS, DISABLE, STATUS])
        self.assertEqual(receipt['status'], 'prepared')
        self.assertTrue(receipt['hostGatesPassed'] and receipt['verifiedDisabled'])
        self.assertTrue(receipt['preparationOnly'])
        self.assertEqual(set(receipt['beforeVolumes']), set(receipt['afterVolumes']))
        for name, command in zip(receipt['commands'], (STATUS, DISABLE, STATUS)):
            record = json.loads((self.output / name).read_text())
            self.assertEqual(record['command'], command)
            self.assertEqual(record['timeoutSeconds'], 15)
            self.assertEqual(record['exitCode'], 0)

    def test_already_disabled_is_valid_but_still_verified(self):
        code, receipt, mocked = self.run_preparation([DISABLED] * 3)
        self.assertEqual(code, 0)
        self.assertTrue(receipt['verifiedDisabled'])
        self.assertEqual(mocked.call_count, 3)

    def test_every_host_indicator_is_required_before_any_system_command(self):
        for key, invalid in [('GITHUB_ACTIONS', 'false'), ('RUNNER_ENVIRONMENT', 'self-hosted'),
                             ('RUNNER_OS', 'Linux')]:
            for value in ('', invalid):
                with self.subTest(key=key, value=value), patch.dict(intel.os.environ, {key: value}):
                    code, receipt, mocked = self.run_preparation([])
                self.assertEqual(code, 1)
                self.assertEqual(receipt['status'], 'failed')
                self.assertFalse(receipt['verifiedDisabled'])
                mocked.assert_not_called()
        for context in (patch.object(intel.sys, 'platform', 'linux'),
                        patch.object(intel.platform, 'machine', return_value='arm64')):
            with context:
                code, receipt, mocked = self.run_preparation([])
            self.assertEqual(code, 1)
            mocked.assert_not_called()

    def test_command_itself_rechecks_host_gate(self):
        with patch.dict(intel.os.environ, {'GITHUB_ACTIONS': 'false'}), \
             patch.object(intel.subprocess, 'run') as mocked, self.assertRaises(ValueError):
            intel.indexing_command(self.output / 'never.json', disable=True)
        mocked.assert_not_called()

    def test_each_command_failure_stops_without_retry_and_preserves_receipt(self):
        for index in range(3):
            with self.subTest(index=index):
                results = [ENABLED, DISABLED, DISABLED]
                results[index] = subprocess.CompletedProcess([], 4, stdout='', stderr='failed')
                code, receipt, mocked = self.run_preparation(results)
                self.assertEqual(code, 1)
                self.assertEqual(mocked.call_count, index + 1)
                self.assertFalse(receipt['verifiedDisabled'])
                record = json.loads((self.output / receipt['commands'][index]).read_text())
                self.assertEqual(record['exitCode'], 4)

    def test_timeout_and_launch_error_fail_without_sensitive_exception_text(self):
        for error in (OSError('private exception'), subprocess.TimeoutExpired(
                'private command', 15, output=b'partial', stderr=b'error')):
            with self.subTest(error=type(error).__name__):
                code, receipt, mocked = self.run_preparation([ENABLED, error])
                self.assertEqual(code, 1)
                self.assertEqual(mocked.call_count, 2)
                record = json.loads((self.output / 'disable.json').read_text())
                self.assertEqual(record['error'], type(error).__name__)
                self.assertNotIn('private', json.dumps(receipt) + json.dumps(record))

    def test_malformed_initial_status_never_disables_indexing(self):
        invalid = ['', '/:\n', '/:\nUnknown status.\n',
                   DISABLED + '/:\nIndexing disabled.\n', 'unexpected\n' + ENABLED]
        for status in invalid:
            with self.subTest(status=status):
                code, receipt, mocked = self.run_preparation([status])
                self.assertEqual(code, 1)
                self.assertEqual(mocked.call_count, 1)
                self.assertFalse(receipt['verifiedDisabled'])

    def test_after_requires_exact_volume_set_and_all_disabled(self):
        invalid = [ENABLED, '/:\nIndexing disabled.\n',
                   DISABLED + '/new-volume:\nIndexing disabled.\n',
                   DISABLED.replace('/System/Volumes/Data', '/renamed'),
                   DISABLED.replace('Indexing disabled.', 'Unknown.', 1)]
        for status in invalid:
            with self.subTest(status=status):
                code, receipt, mocked = self.run_preparation([ENABLED, DISABLED, status])
                self.assertEqual(code, 1)
                self.assertEqual(mocked.call_count, 3)
                self.assertFalse(receipt['verifiedDisabled'])

    def test_indexing_and_searching_disabled_is_an_explicit_valid_status(self):
        code, receipt, _ = self.run_preparation([
            ENABLED, DISABLED, DISABLED.replace('Indexing disabled.', 'Indexing and searching disabled.')])
        self.assertEqual(code, 0)
        self.assertTrue(receipt['verifiedDisabled'])

    def test_truncated_status_or_stderr_cannot_pass_verification(self):
        for index in (0, 2):
            for stream in ('stdout', 'stderr'):
                with self.subTest(index=index, stream=stream):
                    values = {'stdout': DISABLED, 'stderr': ''}
                    values[stream] += 'x' * 5000
                    results = [ENABLED, DISABLED, DISABLED]
                    results[index] = subprocess.CompletedProcess([], 0, **values)
                    code, receipt, mocked = self.run_preparation(results)
                    self.assertEqual(code, 1)
                    self.assertFalse(receipt['verifiedDisabled'])
                    self.assertEqual(mocked.call_count, index + 1)
                    record = json.loads((self.output / receipt['commands'][index]).read_text())
                    self.assertEqual(len(record[stream]), 4096)
                    self.assertTrue(record[stream + 'Truncated'])


if __name__ == '__main__':
    unittest.main()
