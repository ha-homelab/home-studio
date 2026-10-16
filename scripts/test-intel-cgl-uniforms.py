"""Offline isolation and failure-preservation contracts; no browser starts."""
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('uniform_diagnostic', HERE / 'run-intel-cgl-uniforms.py')
diagnostic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostic)


class IntelUniformTests(unittest.TestCase):
    def setUp(self):
        # A failed subprocess mock must never print the caller's credentials.
        environment = patch.dict(diagnostic.os.environ, {'PATH': '/usr/bin:/bin'}, clear=True)
        environment.start(); self.addCleanup(environment.stop)
        host = patch.object(diagnostic.platform, 'platform', return_value='Darwin-test-x86_64')
        host.start(); self.addCleanup(host.stop)

    def execute(self, primary_exit=1, diagnostic_exit=0, mutate_receipt=False, mutate_source=False):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name); output = root / 'output'
        installation = root / 'install.json'; installation.write_text('{"testFixture":true}')
        commands = []

        def run(command, **kwargs):
            commands.append(command)
            record = json.loads((output / 'manifest.json').read_text())
            self.assertEqual(record['steps'][-1]['status'], 'running')
            self.assertFalse(kwargs['check'])
            self.assertEqual(kwargs['stderr'], subprocess.STDOUT)
            self.assertEqual(kwargs['env']['GITHUB_SHA'], diagnostic.REVISION)
            self.assertEqual(kwargs['env']['FIREFOX_COMPOSITOR_BACKEND'], 'software')
            self.assertEqual(kwargs['env']['FIREFOX_GPU_PROCESS'], 'disabled')
            self.assertNotIn('--headless', command)
            kwargs['stdout'].write(b'original command output\n')
            if len(commands) == 1:
                primary = output / 'primary'; primary.mkdir()
                (primary / 'summary.json').write_bytes(b'{"originalTestReceipt":true}\n')
                return subprocess.CompletedProcess(command, primary_exit)
            self.assertEqual(record['primaryExitCode'], primary_exit)
            if mutate_receipt:
                (output / 'primary/summary.json').write_text('{"modified":true}')
            return subprocess.CompletedProcess(command, diagnostic_exit)

        before = {path: 'original-hash' for path in diagnostic.DRIVER_FILES}
        after = dict(before)
        if mutate_source:
            after[diagnostic.DRIVER_FILES[0]] = 'changed-hash'
        with patch.object(diagnostic.platform, 'system', return_value='Darwin'), \
             patch.object(diagnostic.platform, 'machine', return_value='x86_64'), \
             patch.object(diagnostic, 'snapshot', side_effect=[before, after]), \
             patch.object(diagnostic.subprocess, 'run', side_effect=run):
            result = diagnostic.run(root / 'source', installation, output)
        return result, json.loads((output / 'manifest.json').read_text()), commands, output

    def test_failed_primary_remains_failed_after_successful_original_diagnostic(self):
        result, record, commands, output = self.execute()
        self.assertEqual(result, 1)
        self.assertEqual(record['status'], 'failed')
        self.assertEqual((record['primaryExitCode'], record['diagnosticExitCode']), (1, 0))
        self.assertTrue(record['diagnosticOnly'])
        self.assertEqual(record['acceptanceStatus'], 'not-run')
        self.assertTrue(record['primaryReceiptsUnchanged'])
        self.assertTrue(record['sourceUnchanged'])
        self.assertEqual((output / 'primary/summary.json').read_bytes(), b'{"originalTestReceipt":true}\n')
        self.assertEqual(len(commands), 2)
        self.assertEqual(Path(commands[0][1]).name, 'test-native-browser-acceptance.py')
        self.assertEqual(Path(commands[1][1]).name, 'diagnose-native-draw.py')
        common = ['--product', 'firefox', '--expected-version', '153.5.0esr',
                  '--installation', str(output.parent / 'install.json')]
        self.assertEqual(commands[0][2:], common + ['--output', str(output / 'primary')])
        self.assertEqual(commands[1][2:], common + ['--primary-output', str(output / 'primary'),
                          '--output', str(output / 'diagnostics/first-frame')])

    def test_successful_primary_never_runs_failure_diagnostic(self):
        result, record, commands, _ = self.execute(primary_exit=0)
        self.assertEqual(result, 0)
        self.assertEqual(record['status'], 'completed')
        self.assertEqual(len(commands), 1)
        self.assertIsNone(record['diagnosticExitCode'])
        self.assertEqual(record['acceptanceStatus'], 'not-run')

    def test_diagnostic_failure_is_preserved_without_retry(self):
        result, record, commands, _ = self.execute(diagnostic_exit=2)
        self.assertEqual(result, 1)
        self.assertEqual(record['diagnosticExitCode'], 2)
        self.assertEqual(len(commands), 2)

    def test_modified_primary_receipt_is_rejected(self):
        result, record, _, _ = self.execute(mutate_receipt=True)
        self.assertEqual(result, 1)
        self.assertEqual(record['status'], 'infrastructure-error')
        self.assertIn('changed the original primary receipts', record['error'])

    def test_modified_source_is_rejected(self):
        result, record, _, _ = self.execute(mutate_source=True)
        self.assertEqual(result, 1)
        self.assertEqual(record['status'], 'infrastructure-error')
        self.assertIn('Source or installation receipt changed', record['error'])

    def test_snapshot_rejects_wrong_revision_or_dirty_source(self):
        for replies in ([b'wrong'], [diagnostic.REVISION.encode(), b' M viewer.js']):
            with patch.object(diagnostic.subprocess, 'check_output', side_effect=replies), self.assertRaises(ValueError):
                diagnostic.snapshot(Path('/source'))

    def test_non_intel_host_cannot_launch(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(diagnostic.platform, 'machine', return_value='arm64'), \
             patch.object(diagnostic.subprocess, 'run') as run:
            root = Path(directory)
            self.assertEqual(diagnostic.run(root, root / 'missing.json', root / 'output'), 1)
            run.assert_not_called()

    def test_workflow_has_one_fixed_read_only_diagnostic_trigger(self):
        text = (HERE.parent / '.github/workflows/intel-cgl-uniforms.yml').read_text()
        self.assertIn('branches: [diagnostic/intel-cgl-uniforms]', text)
        self.assertIn("github.ref == 'refs/heads/diagnostic/intel-cgl-uniforms'", text)
        self.assertIn('permissions:\n  contents: read', text)
        self.assertIn('runs-on: macos-15-intel', text)
        self.assertIn('timeout-minutes: 20', text)
        self.assertIn('if: ${{ always() }}', text)
        self.assertIn(f'ref: {diagnostic.REVISION}', text)
        self.assertEqual(text.count('persist-credentials: false'), 2)
        self.assertNotRegex(text, r'workflow_dispatch|workflow_call|pull_request|continue-on-error|secrets\.')
        uses = re.findall(r'uses: ([^\s]+)', text)
        self.assertTrue(uses)
        self.assertTrue(all(re.fullmatch(r'actions/[a-z-]+@[0-9a-f]{40}', use) for use in uses))


if __name__ == '__main__':
    unittest.main()
