#!/usr/bin/env python3
"""Synthetic compiler processes only: no native compilation or GUI queries."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

HELPER = Path(__file__).with_name('compile-macos-gui-health.py')
spec = importlib.util.spec_from_file_location('gui_compile', HELPER)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def process_gone(pid):
    end = time.monotonic() + 2
    while time.monotonic() < end:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(.02)
    return False


def fake_compiler(pidfile):
    # The descendant inherits the compiler's group, as clang subprocesses do.
    return [sys.executable, '-c', '''import json,os,subprocess,sys,time
child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])
with open(sys.argv[1],'w') as out: json.dump([os.getpid(),child.pid],out)
time.sleep(60)
''', str(pidfile)]


class CompileSetupTests(unittest.TestCase):
    def check_signal_window(self, window, expected_code):
        with tempfile.TemporaryDirectory() as temporary:
            pidfile = Path(temporary) / 'pids'
            code = '''import importlib.util,json,os,signal,sys,time
spec=importlib.util.spec_from_file_location('gui_compile',sys.argv[1]); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
if sys.argv[4]=='spawn':
    original=mod.subprocess.Popen
    def spawn(*args,**kwargs):
        child=original(*args,**kwargs)
        end=time.monotonic()+2
        while time.monotonic()<end:
            try:
                with open(sys.argv[3]) as inp: json.load(inp)
                break
            except (FileNotFoundError,json.JSONDecodeError): time.sleep(.01)
        os.kill(os.getpid(),signal.SIGTERM)
        return child
    mod.subprocess.Popen=spawn
else:
    original=mod.os.killpg
    def killpg(pid,sig):
        os.kill(os.getpid(),signal.SIGTERM)
        original(pid,sig)
        os.kill(os.getpid(),signal.SIGTERM)
        os.kill(os.getpid(),signal.SIGINT)
    mod.os.killpg=killpg
try: mod.run_compiler(json.loads(sys.argv[2]),timeout=.4,cleanup_timeout=1)
except mod.CompileInterrupted: sys.exit(19)
except RuntimeError as error:
    if str(error)=='compiler setup deadline exceeded': sys.exit(23)
    raise
'''
            launcher = subprocess.Popen([sys.executable, '-c', code, str(HELPER),
                                         json.dumps(fake_compiler(pidfile)), str(pidfile), window],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                        start_new_session=True)
            try:
                self.assertEqual(launcher.wait(timeout=5), expected_code)
                for pid in json.loads(pidfile.read_text()):
                    self.assertTrue(process_gone(pid), f'owned compiler process remains: {pid}')
            finally:
                if launcher.poll() is None:
                    launcher.kill(); launcher.wait(timeout=2)
                if pidfile.exists():
                    for pid in json.loads(pidfile.read_text()):
                        try:
                            os.kill(pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass

    @unittest.skipIf(os.name != 'posix', 'owned POSIX process groups required')
    def test_spawn_window_signal_is_deferred_until_child_is_owned(self):
        self.check_signal_window('spawn', 19)

    @unittest.skipIf(os.name != 'posix', 'owned POSIX process groups required')
    def test_repeated_signals_do_not_interrupt_cleanup_or_hide_original_timeout(self):
        self.check_signal_window('cleanup', 23)

    def test_success_publishes_once_without_running_and_keeps_source_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'probe'
            commands = []

            def compile_only(command):
                commands.append(command)
                Path(command[-1]).write_bytes(b'not a real executable')
                Path(command[-1]).chmod(0o700)

            with mock.patch.object(module, 'run_compiler', side_effect=compile_only):
                receipt = module.compile_probe(output)
                with self.assertRaisesRegex(RuntimeError, 'new file'):
                    module.compile_probe(output)
            self.assertEqual(len(commands), 1)
            self.assertEqual(commands[0][:5], ['/usr/bin/xcrun', '--sdk', 'macosx', 'clang', '-fobjc-arc'])
            self.assertEqual(commands[0][-3], str(module.SOURCE))
            self.assertEqual(receipt['status'], 'compiled-not-run')
            self.assertEqual(receipt['sourceSha256'], module.SOURCE_SHA256)
            self.assertEqual(output.read_bytes(), b'not a real executable')
            self.assertEqual(list(Path(temporary).iterdir()), [output])

    def test_failed_compiler_leaves_no_published_or_temporary_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            with mock.patch.object(module, 'run_compiler', side_effect=RuntimeError('synthetic failure')):
                with self.assertRaisesRegex(RuntimeError, 'synthetic failure'):
                    module.compile_probe(Path(temporary) / 'probe')
            self.assertEqual(list(Path(temporary).iterdir()), [])
        with self.assertRaisesRegex(RuntimeError, 'exited 7'):
            module.run_compiler([sys.executable, '-c', 'raise SystemExit(7)'], timeout=2)

    @unittest.skipIf(os.name != 'posix', 'owned POSIX process groups required')
    def test_timeout_kills_compiler_and_descendant_and_restores_handlers(self):
        previous = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
        with tempfile.TemporaryDirectory() as temporary:
            pidfile = Path(temporary) / 'pids'
            started = time.monotonic()
            with self.assertRaisesRegex(RuntimeError, 'deadline exceeded'):
                module.run_compiler(fake_compiler(pidfile), timeout=.4, cleanup_timeout=1)
            self.assertLess(time.monotonic() - started, 2)
            for pid in json.loads(pidfile.read_text()):
                self.assertTrue(process_gone(pid), f'owned compiler process remains: {pid}')
        self.assertEqual(previous, {sig: signal.getsignal(sig) for sig in previous})

    @unittest.skipIf(os.name != 'posix', 'owned POSIX process groups required')
    def test_outer_termination_cleans_compiler_group(self):
        with tempfile.TemporaryDirectory() as temporary:
            pidfile = Path(temporary) / 'pids'
            code = '''import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('gui_compile',sys.argv[1]); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
try: mod.run_compiler(json.loads(sys.argv[2]),timeout=30,cleanup_timeout=1)
except mod.CompileInterrupted: sys.exit(19)
'''
            launcher = subprocess.Popen([sys.executable, '-c', code, str(HELPER), json.dumps(fake_compiler(pidfile))],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            try:
                end = time.monotonic() + 3
                while not pidfile.exists() and time.monotonic() < end:
                    time.sleep(.02)
                self.assertTrue(pidfile.exists(), 'synthetic compiler did not start')
                launcher.terminate()
                self.assertEqual(launcher.wait(timeout=3), 19)
                for pid in json.loads(pidfile.read_text()):
                    self.assertTrue(process_gone(pid), f'owned compiler process remains: {pid}')
            finally:
                if launcher.poll() is None:
                    launcher.kill(); launcher.wait(timeout=2)
                if pidfile.exists():
                    for pid in json.loads(pidfile.read_text()):
                        try:
                            os.kill(pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass


if __name__ == '__main__':
    unittest.main()
