#!/usr/bin/env python3
"""Offline contracts only: never capture processes or launch a browser/sample."""
import ast
from contextlib import ExitStack
import importlib.util
import inspect
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

M = load('stack_diagnostic', ROOT / 'scripts/run-intel-cgl-stacks.py')
HOST = {'GITHUB_ACTIONS': 'true', 'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'macOS'}
BINARY = '/browser/Firefox.app/Contents/MacOS/firefox'
PLUGIN = '/browser/Firefox.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container'

def proc(pid, parent, executable, cpu=10):
    return {'pid': pid, 'parent': parent, 'executable': executable,
            'cpuEstimate': cpu, 'started': 'Fri Oct 16 08:00:00 2026'}

def processes():
    return {100: proc(100, os.getpid(), BINARY), 101: proc(101, 100, PLUGIN, 15),
            102: proc(102, 100, PLUGIN, 30), 103: proc(103, 100, PLUGIN, 20),
            199: proc(199, 1, PLUGIN, 99)}

class FakeProcess:
    def __init__(self, returncode=0):
        self.returncode = returncode
        self.terminated = self.killed = False
    def poll(self): return self.returncode
    def terminate(self): self.terminated = True; self.returncode = -15
    def kill(self): self.killed = True; self.returncode = -9
    def wait(self, timeout=None): return self.returncode

class Contracts(unittest.TestCase):
    def host(self):
        stack = ExitStack()
        stack.enter_context(patch.dict(os.environ, HOST, clear=True))
        stack.enter_context(patch.object(M.sys, 'platform', 'darwin'))
        stack.enter_context(patch.object(M.platform, 'machine', return_value='x86_64'))
        return stack

    def test_five_environment_gates(self):
        with self.host():
            M.require_host()
            for key in HOST:
                with self.subTest(key=key), patch.dict(os.environ, {key: 'wrong'}):
                    with self.assertRaises(ValueError): M.require_host()
            with patch.object(M.sys, 'platform', 'linux'):
                with self.assertRaises(ValueError): M.require_host()
            with patch.object(M.platform, 'machine', return_value='arm64'):
                with self.assertRaises(ValueError): M.require_host()

    def test_exact_revision_clean_signed_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / 'a').write_text('known')
            replies = [M.SOURCE, '', 'tree x\ngpgsig signature\n', 'a\0']
            with patch.object(M.subprocess, 'check_output', side_effect=replies):
                result = M.snapshot(root)
            self.assertEqual(result['revision'], M.SOURCE)
            self.assertEqual(result['files'], {'a': M.digest(root / 'a')})
            for replies in [['wrong'], [M.SOURCE, ' M a'], [M.SOURCE, '', 'tree x\n']]:
                with patch.object(M.subprocess, 'check_output', side_effect=replies):
                    with self.assertRaises(ValueError): M.snapshot(root)

    def test_process_parser_retains_start_and_full_executable(self):
        parsed = M.parse_processes(' 100 22 7.8 Fri Oct 16 08:00:00 2026 /browser/Firefox Nightly.app/firefox\n'
                                   'bad\n101 22 nan Fri Oct 16 08:00:00 2026 /bad\n')
        self.assertEqual(set(parsed), {100})
        self.assertEqual(parsed[100]['started'], 'Fri Oct 16 08:00:00 2026')
        self.assertEqual(parsed[100]['executable'], '/browser/Firefox Nightly.app/firefox')
        self.assertNotIn('executable', M.public_identity(parsed[100]))
        self.assertEqual(M.public_identity(parsed[100])['executableBasename'], 'firefox')

    def test_process_inventory_is_bounded_and_not_arguments(self):
        with self.host(), patch.object(M.subprocess, 'run', return_value=SimpleNamespace(stdout='')) as run:
            self.assertEqual(M.process_snapshot(), {})
            command = run.call_args.args[0]
            self.assertEqual(command, ['/bin/ps', '-ww', '-axo', 'pid=,ppid=,%cpu=,lstart=,comm='])
            self.assertEqual(run.call_args.kwargs['timeout'], 3)
            run.return_value.stdout = 'x' * (1024 * 1024 + 1)
            with self.assertRaises(ValueError): M.process_snapshot()

    def test_owned_ancestry_cycle_and_reused_pid(self):
        p = processes()
        self.assertTrue(M.owned(p, 102, 100)); self.assertFalse(M.owned(p, 199, 100))
        p[102]['parent'] = 103; p[103]['parent'] = 102
        self.assertFalse(M.owned(p, 102, 100))
        original = proc(1, 2, BINARY)
        for key in ['parent', 'started', 'executable']:
            changed = {**original, key: 'changed'}
            self.assertFalse(M.same_process(original, changed))
        self.assertFalse(M.same_process(original, None))

    def test_content_selection_owned_tab_only_max_two(self):
        output = '101 /browser/plugin-container -isForBrowser PRIVATE_PROFILE 2 tab\n102 /browser/plugin-container -isForBrowser SECRET 4 tab\n103 /browser/plugin-container -isForBrowser SECRET 5 tab\n199 /other -isForBrowser SECRET 5 tab\n'
        with patch.object(M.subprocess, 'run', return_value=SimpleNamespace(stdout=output)) as run:
            result = M.tab_roles(processes(), 100, BINARY)
        self.assertEqual([p['pid'] for p in result], [102, 103])
        self.assertEqual(run.call_args.args[0][3], '101,102,103')
        self.assertNotIn('SECRET', json.dumps(result))
        self.assertNotIn('PRIVATE_PROFILE', json.dumps(result))

    def test_non_tab_and_excessive_roles_rejected(self):
        with patch.object(M.subprocess, 'run', return_value=SimpleNamespace(stdout='101 plugin -isForBrowser 4 gpu\n102 plugin 5 tab\n')):
            self.assertEqual(M.tab_roles(processes(), 100, BINARY), [])
        with self.assertRaises(ValueError): M.tab_roles({}, 100, BINARY)
        p = {100: proc(100, os.getpid(), BINARY)}
        p.update({i: proc(i, 100, PLUGIN) for i in range(101, 134)})
        with patch.object(M.subprocess, 'run') as run:
            with self.assertRaises(ValueError): M.tab_roles(p, 100, BINARY)
            run.assert_not_called()

    def test_trigger_joins_prior_link_to_first_main_draw_not_ordinal(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'startup.jsonl'
            shader = {'type': 'fragment', 'fingerprint': M.MAIN_FRAGMENT, 'length': 49740, 'hashedLength': 49740}
            linked = {'event': 'link-before', 'program': 4, 'shaders': [shader]}
            draw = {'event': 'draw-before', 'program': 4}
            path.write_text(json.dumps(linked) + '\n' + json.dumps({**draw, 'program': 5}) + '\n{"partial":')
            self.assertIsNone(M.trigger(path))
            path.write_text(json.dumps(linked) + '\n' + json.dumps(draw) + '\n{"partial":')
            self.assertEqual(M.trigger(path), {'draw': draw, 'link': linked})
            for wrong in [{**shader, 'type': 'vertex'}, {**shader, 'length': 1}, {**shader, 'fingerprint': 'other'}]:
                path.write_text(json.dumps({**linked, 'shaders': [wrong]}) + '\n' + json.dumps(draw))
                self.assertIsNone(M.trigger(path))
            # A fresh different link for the same ordinal invalidates old metadata.
            path.write_text('\n'.join(map(json.dumps, [linked, {**linked, 'shaders': []}, draw])))
            self.assertIsNone(M.trigger(path))
            path.write_text('x' * (256 * 1024 + 1))
            with self.assertRaises(ValueError): M.trigger(path)

    def test_malformed_checkpoint_cannot_select_a_process(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'startup.jsonl'
            for value in [[], None, {'event': 'draw-before', 'program': True},
                          {'event': 'draw-before', 'program': 9},
                          {'event': 'link-before', 'program': 2, 'shaders': [None]}]:
                with self.subTest(value=value):
                    path.write_text(json.dumps(value))
                    with self.assertRaises(ValueError): M.trigger(path)

    def sampler(self, path):
        browser = FakeProcess(None); browser.pid = 100
        with patch.object(M, 'process_snapshot', return_value=processes()):
            return M.StackSampler(browser, {'moz:processID': 100}, BINARY, path)

    def test_parent_identity_requires_webdriver_and_launched_child(self):
        browser = FakeProcess(None); browser.pid = 100
        with tempfile.TemporaryDirectory() as tmp, patch.object(M, 'process_snapshot', return_value=processes()):
            with self.assertRaises(ValueError): M.StackSampler(browser, {'moz:processID': 101}, BINARY, Path(tmp))
            with self.assertRaises(ValueError): M.StackSampler(browser, {'moz:processID': 100}, '/wrong', Path(tmp))

    def execute_sampler(self, sampler, factory, snapshot=None):
        event = {'draw': {'event': 'draw-before', 'program': 4},
                 'link': {'event': 'link-before', 'program': 4, 'shaders': [{'type': 'fragment', 'fingerprint': M.MAIN_FRAGMENT}]}}
        with patch.object(M, 'trigger', return_value=event), \
             patch.object(M, 'process_snapshot', side_effect=snapshot, return_value=processes()), \
             patch.object(M, 'tab_roles', return_value=[processes()[102], processes()[103]]), \
             patch.object(M.subprocess, 'Popen', side_effect=factory):
            sampler.run()

    def test_three_independent_sample_commands_and_receipts(self):
        commands = []
        def factory(command, **kwargs):
            commands.append(command)
            Path(command[-1]).write_text('public diagnostic stack')
            return FakeProcess(0)
        with tempfile.TemporaryDirectory() as tmp:
            sampler = self.sampler(Path(tmp)); self.execute_sampler(sampler, factory)
            self.assertEqual(sampler.record['status'], 'saved')
            self.assertEqual([c[1] for c in commands], ['100', '102', '103'])
            self.assertTrue(all(c[:1] == ['/usr/bin/sample'] and c[2:5] == ['10', '10', '-file'] for c in commands))
            self.assertTrue(all(c['reportSHA256'] and c['logSHA256'] for c in sampler.captures))
            self.assertTrue(sampler.record['diagnosticOnly'])
            self.assertEqual(sampler.record['acceptanceStatus'], 'not-run')

    def test_permissions_failure_preserved_without_sudo_or_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            sampler = self.sampler(Path(tmp))
            self.execute_sampler(sampler, lambda *a, **k: FakeProcess(1))
            self.assertEqual(sampler.record['status'], 'incomplete')
            self.assertTrue(all(c['status'] == 'failed' for c in sampler.captures))
            self.assertEqual(len(sampler.captures), 3)

    def test_reused_parent_cannot_be_sampled(self):
        changed = processes(); changed[100]['started'] = 'later'
        with tempfile.TemporaryDirectory() as tmp:
            sampler = self.sampler(Path(tmp)); factory = Mock()
            self.execute_sampler(sampler, factory, [changed])
            factory.assert_not_called()
            self.assertEqual(sampler.record['status'], 'failed')

    def test_reused_content_cannot_be_sampled(self):
        changed = processes(); changed[102]['started'] = 'later'
        def factory(command, **kwargs):
            Path(command[-1]).write_text('stack'); return FakeProcess(0)
        with tempfile.TemporaryDirectory() as tmp:
            sampler = self.sampler(Path(tmp))
            self.execute_sampler(sampler, factory, [processes(), processes(), changed])
            self.assertEqual(len(sampler.captures), 1)
            self.assertEqual(sampler.record['status'], 'failed')
            self.assertEqual(sampler.captures[0]['status'], 'saved')

    def test_oversized_outputs_truncated_and_not_success(self):
        def factory(command, **kwargs):
            Path(command[-1]).write_bytes(b'x' * 65)
            kwargs['stdout'].write(b'y' * 17); kwargs['stdout'].flush()
            return FakeProcess(0)
        with tempfile.TemporaryDirectory() as tmp, patch.object(M, 'REPORT_LIMIT', 64), patch.object(M, 'LOG_LIMIT', 16):
            sampler = self.sampler(Path(tmp)); self.execute_sampler(sampler, factory)
            self.assertEqual(sampler.record['status'], 'incomplete')
            self.assertTrue(all(c['reportBytes'] == 64 and c['logBytes'] == 16 and c['status'] == 'output-limit' for c in sampler.captures))

    def test_running_oversize_samples_are_stopped_and_bounded(self):
        children = []
        def factory(command, **kwargs):
            child = FakeProcess(None); children.append(child)
            Path(command[-1]).write_bytes(b'x' * 65)
            return child
        with tempfile.TemporaryDirectory() as tmp, patch.object(M, 'REPORT_LIMIT', 64):
            sampler = self.sampler(Path(tmp))
            with patch.object(sampler.stop, 'wait', return_value=False):
                self.execute_sampler(sampler, factory)
            self.assertTrue(all(c.terminated for c in children))
            self.assertEqual(len(children), 3)
            self.assertTrue(all(c['status'] == 'output-limit' and c['reportBytes'] == 64 for c in sampler.captures))
            self.assertEqual(sampler.record['status'], 'incomplete')

    def test_partial_launch_failure_finalizes_earlier_children(self):
        child = FakeProcess(None)
        def factory(command, **kwargs):
            if command[1] == '102': raise OSError('sample unavailable')
            Path(command[-1]).write_text('partial stack'); return child
        with tempfile.TemporaryDirectory() as tmp:
            sampler = self.sampler(Path(tmp)); self.execute_sampler(sampler, factory)
            self.assertTrue(child.terminated)
            self.assertEqual(sampler.record['status'], 'failed')
            self.assertEqual(sampler.captures[0]['exitCode'], -15)

    def test_no_checkpoint_does_not_launch(self):
        with tempfile.TemporaryDirectory() as tmp:
            sampler = self.sampler(Path(tmp)); sampler.stop.set()
            with patch.object(M.subprocess, 'Popen') as popen:
                sampler.run(); popen.assert_not_called()
            self.assertEqual(sampler.record['status'], 'first-main-draw-not-observed')

    def test_running_samples_timeout_without_retry(self):
        children = []
        def factory(command, **kwargs):
            child = FakeProcess(None); children.append(child)
            Path(command[-1]).write_text('partial'); return child
        with tempfile.TemporaryDirectory() as tmp:
            sampler = self.sampler(Path(tmp))
            with patch.object(M.time, 'monotonic', side_effect=iter(range(0, 10000, 61))), \
                 patch.object(sampler.stop, 'wait', return_value=False):
                self.execute_sampler(sampler, factory)
            self.assertTrue(all(c.terminated for c in children))
            self.assertEqual(len(children), 3)
            self.assertTrue(all(c['status'] == 'command-timeout' for c in sampler.captures))
            self.assertEqual(sampler.record['status'], 'incomplete')

    def test_running_samples_cancelled_after_original_finishes(self):
        children = []
        with tempfile.TemporaryDirectory() as tmp:
            sampler = self.sampler(Path(tmp))
            def factory(command, **kwargs):
                child = FakeProcess(None); children.append(child)
                if len(children) == 3: sampler.stop.set()
                Path(command[-1]).write_text('partial'); return child
            self.execute_sampler(sampler, factory)
            self.assertTrue(all(c.terminated for c in children))
            self.assertTrue(all(c['status'] == 'cancelled' for c in sampler.captures))
            self.assertEqual(sampler.record['status'], 'incomplete')

    def test_terminate_then_bounded_kill(self):
        child = Mock(); child.poll.return_value = None
        child.wait.side_effect = [subprocess.TimeoutExpired('sample', 2), -9]
        M.stop_sampler(child)
        child.terminate.assert_called_once(); child.kill.assert_called_once()
        self.assertEqual([c.kwargs['timeout'] for c in child.wait.call_args_list], [2, 2])

    def test_close_is_after_original_result_and_cannot_replace_it(self):
        primary = {'status': 'failed', 'error': 'original error', 'durationMs': 30001}
        monitor = Mock(); monitor.close.side_effect = RuntimeError('observer cleanup')
        monitor.record = {'issues': []}; monitor.save.side_effect = OSError('storage failed')
        module = SimpleNamespace(run_case=Mock(return_value=primary), STACK_MONITORS=[monitor])
        self.assertIs(M.run_original(module, {}, Path('/unused')), primary)
        module.run_case.assert_called_once_with({}, Path('/unused'), 'viewer-24', False)
        self.assertEqual(monitor.record['status'], 'cleanup-failed')

    def test_primary_exception_identity_preserved_on_close_failure(self):
        error = RuntimeError('original'); monitor = Mock(); monitor.close.side_effect = RuntimeError('observer')
        monitor.record = {'issues': []}
        module = SimpleNamespace(run_case=Mock(side_effect=error), STACK_MONITORS=[monitor])
        with self.assertRaises(RuntimeError) as caught: M.run_original(module, {}, Path('/unused'))
        self.assertIs(caught.exception, error)

    def test_console_summary_bounds_original_error_without_mutation(self):
        original = {'status': 'failed', 'error': 'x' * 100000, 'durationMs': 30001}
        summary = M.result_summary(original)
        self.assertEqual(summary['errorLength'], 100000)
        self.assertEqual(len(summary['error']), 1200)
        self.assertEqual(len(original['error']), 100000)

    def test_cleanup_failure_still_closes_bounds_and_continues(self):
        streams = []
        def factory(command, **kwargs):
            streams.append(kwargs['stdout'])
            Path(command[-1]).write_bytes(b'x' * 65)
            return FakeProcess(0)
        with tempfile.TemporaryDirectory() as tmp, patch.object(M, 'REPORT_LIMIT', 64), \
             patch.object(M, 'stop_sampler', side_effect=[RuntimeError('stop failed'), None, None]):
            sampler = self.sampler(Path(tmp)); self.execute_sampler(sampler, factory)
            self.assertTrue(all(stream.closed for stream in streams))
            self.assertTrue(all(c['reportBytes'] == 64 for c in sampler.captures))
            self.assertEqual(len(sampler.captures), 3)
            self.assertNotEqual(sampler.record['status'], 'saved')

    def test_stream_close_error_does_not_skip_later_captures(self):
        opened = []
        original_open = Path.open
        def opening(path, *args, **kwargs):
            stream = original_open(path, *args, **kwargs)
            if args and args[0] == 'wb' and path.name.endswith('.log'):
                opened.append(stream)
                if len(opened) == 1:
                    def close():
                        stream.close()
                        raise OSError('close failed')
                    return SimpleNamespace(close=close)
            return stream
        def factory(command, **kwargs):
            Path(command[-1]).write_text('stack')
            return FakeProcess(0)
        with tempfile.TemporaryDirectory() as tmp:
            sampler = self.sampler(Path(tmp))
            with patch.object(Path, 'open', opening):
                self.execute_sampler(sampler, factory)
            self.assertTrue(all(stream.closed for stream in opened))
            self.assertEqual(len(sampler.captures), 3)
            self.assertEqual(sampler.captures[0]['status'], 'cleanup-failed')
            self.assertEqual([c['status'] for c in sampler.captures[1:]], ['saved', 'saved'])
            self.assertEqual(sampler.record['status'], 'incomplete')

    def test_exact_native_derivation_and_viewer_unchanged(self):
        import sys
        with patch.object(sys, 'path', [str(ROOT / 'scripts'), *sys.path]):
            module = load('native_stack_contract', ROOT / 'scripts/test-waterfox-acceptance.py')
        original = inspect.getsource(module.run_case)
        viewer = module.viewer
        generated = M.configure(module)
        annotation = "    record.update(diagnosticOnly=True, acceptanceStatus='not-run')\n"
        observer = "        try:\n            stack_monitor = STACK_SAMPLER(browser, capabilities, installation['binary'], output)\n            STACK_MONITORS.append(stack_monitor)\n            stack_monitor.start()\n        except Exception as error:\n            record['stackSamplingSetupError'] = str(error)[:400]\n"
        self.assertEqual(generated.replace(annotation + '    save()\n    server =', '    save()\n    server =').replace(observer, ''), original)
        self.assertIs(module.viewer, viewer)
        self.assertIn('threading.Timer(180, deadline_exceeded)', generated)
        self.assertIn("{'script': 30000, 'pageLoad': 30000, 'implicit': 0}", generated)
        self.assertIn('assert_masked_capacity(record)', generated)
        self.assertIn('assert_requested_backend(record)', generated)
        self.assertNotIn('stack_monitor.close()', generated)
        ast.parse(generated)
        # The current source contains its literal callback transport repair.
        self.assertIn('range(2)', inspect.getsource(viewer))

    def test_changed_derivation_boundary_fails_closed(self):
        module = SimpleNamespace(run_case=lambda: None)
        with patch.object(M.inspect, 'getsource', return_value='def run_case():\n    pass\n'):
            with self.assertRaises(ValueError): M.configure(module)

    def test_existing_output_rejected_without_overwriting_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            (output / 'intel-preparation').mkdir()
            M.require_fresh_output(output)
            for name in ('original-viewer-24', 'diagnostic.json', 'source-before.json'):
                path = output / name; path.write_text('original evidence')
                with self.assertRaises(ValueError): M.require_fresh_output(output)
                self.assertEqual(path.read_text(), 'original evidence')
                path.unlink()

    def test_workflow_one_case_one_host_no_release_or_dispatch(self):
        workflow = (ROOT / '.github/workflows/intel-cgl-stacks.yml').read_text()
        self.assertEqual(workflow.count('runs-on:'), 1)
        self.assertIn('runs-on: macos-15-intel', workflow)
        self.assertIn('branches: [diagnostic/intel-cgl-stacks]', workflow)
        self.assertIn('ref: ' + M.SOURCE, workflow)
        self.assertIn('cancel-in-progress: false', workflow)
        self.assertEqual(workflow.count('persist-credentials: false'), 2)
        self.assertNotIn('workflow_dispatch', workflow)
        self.assertNotIn('!cancelled()', workflow)
        self.assertNotIn('continue-on-error', workflow)
        self.assertNotIn('secrets.', workflow)
        self.assertNotIn('sudo', (ROOT / 'scripts/run-intel-cgl-stacks.py').read_text())
        self.assertLess(workflow.index('Prepare the same ephemeral'), workflow.index('Install original'))
        self.assertIn('if: ${{ always() }}', workflow)
        self.assertIn('retention-days: 14', workflow)
        main = inspect.getsource(M.main)
        self.assertNotIn('planner-256', main); self.assertNotIn('viewer-6', main)
        self.assertIn("'releaseEligible': False", main)

if __name__ == '__main__':
    unittest.main()
