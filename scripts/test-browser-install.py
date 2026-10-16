#!/usr/bin/env python3
"""Keep download retry policy separate from immutable acceptance outcomes."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('browser_install', ROOT / 'scripts/install-browser-with-retry.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class BrowserInstallTests(unittest.TestCase):
    def execute(self, results):
        pending = iter(results)
        def execute(command, *, stdout, **kwargs):
            code, log = next(pending)
            stdout.write(log)
            stdout.flush()
            return subprocess.CompletedProcess(command, code)
        run = mock.Mock(side_effect=execute)
        sleep = mock.Mock()
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            output = Path(directory)
            code = installer.install(['node', 'cli.js'], output, run=run, sleep=sleep)
            receipt = json.loads((output / 'result.json').read_text())
            logs = [path.read_text() for path in sorted(output.glob('attempt-*.log'))]
        return code, receipt, logs, run, sleep

    def test_success_never_retries(self):
        code, receipt, logs, run, sleep = self.execute([(0, 'installed')])
        self.assertEqual((code, receipt['status'], logs, run.call_count), (0, 'passed', ['installed'], 1))
        sleep.assert_not_called()

    def test_http2_interruption_retries_installation_and_retains_failed_log(self):
        error = 'ca-certificates is already the newest version.\nDownloaded 71.4M\ncurl: (92) HTTP/2 stream was not closed cleanly: INTERNAL_ERROR\n'
        code, receipt, logs, run, sleep = self.execute([(1, error), (0, 'installed')])
        self.assertEqual((code, receipt['status'], logs), (0, 'passed', [error, 'installed']))
        self.assertEqual([item['exitCode'] for item in receipt['attempts']], [1, 0])
        self.assertEqual(run.call_count, 2)
        sleep.assert_called_once_with(5)

    def test_exhausted_download_stays_failed(self):
        code, receipt, logs, run, sleep = self.execute([(1, 'curl: (56) Connection reset')] * 3)
        self.assertEqual((code, receipt['status'], len(logs), run.call_count), (1, 'failed', 3, 3))
        self.assertEqual(sleep.call_args_list, [mock.call(5), mock.call(15)])
        self.assertFalse(receipt['attempts'][-1]['retry'])

    def test_permanent_errors_signals_and_test_failures_never_retry(self):
        for code, log in [(1, 'package dependency conflict'), (1, 'load budget exceeded'),
                          (-15, 'curl: (92) interrupted'), (1, 'curl: (60) invalid certificate'),
                          (1, 'ECONNRESET followed by checksum mismatch'),
                          (1, 'curl: (56) OpenSSL SSL_read: error: SSL routines::tlsv1 alert internal error'),
                          (1, 'ECONNRESET\ncurl: (35) handshake failed'),
                          (1, 'ECONNRESET ERR_TLS_CERT_ALTNAME_INVALID'),
                          (1, 'curl: (56) invalid signature'), (1, 'curl: (7) Permission denied')]:
            with self.subTest(log=log):
                result, receipt, _, run, sleep = self.execute([(code, log)])
                self.assertNotEqual(result, 0)
                self.assertEqual((receipt['status'], run.call_count), ('failed', 1))
                sleep.assert_not_called()

    def test_interrupted_installation_keeps_partial_output_and_unknown_exit(self):
        def interrupted(command, *, stdout, **kwargs):
            stdout.write('download reached 52%\n')
            stdout.flush()
            raise KeyboardInterrupt()
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            output = Path(directory)
            with self.assertRaises(KeyboardInterrupt):
                installer.install(['node', 'cli.js'], output, run=interrupted)
            self.assertEqual((output / 'attempt-1.log').read_text(), 'download reached 52%\n')
            receipt = json.loads((output / 'result.json').read_text())
            self.assertEqual(receipt['status'], 'running')
            self.assertIsNone(receipt['attempts'][0]['exitCode'])

    def test_only_known_installation_commands_are_constructed(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(installer.shutil, 'which', return_value='/node'):
            cli = Path(directory) / 'cli.js'
            cli.touch()
            env = {'HOME_STUDIO_PLAYWRIGHT_MODULE': directory, 'BROWSER_STABILITY_ENGINES': 'webkit'}
            self.assertEqual(installer.installer_command(env), ['/node', str(cli), 'install', '--with-deps', 'webkit'])
            self.assertEqual(installer.installer_command({**env, 'CFT_VERSION': '154.0.8037.92'}), ['/node', str(cli), 'install-deps', 'chromium'])
            for channel in ('chrome', 'chrome-beta', 'msedge', 'msedge-beta'):
                self.assertEqual(installer.installer_command({**env, 'HOME_STUDIO_BROWSER_CHANNEL': channel}), ['/node', str(cli), 'install', '--with-deps', '--force', channel])
            for invalid in ({'BROWSER_STABILITY_ENGINES': 'test'}, {'HOME_STUDIO_BROWSER_CHANNEL': 'test'}):
                with self.assertRaises(ValueError):
                    installer.installer_command({**env, **invalid})


if __name__ == '__main__':
    unittest.main()
