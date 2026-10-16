"""Offline contracts for the failure-only native draw profiler."""
import importlib.util
import inspect
import io
import json
from pathlib import Path
import signal
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch
from contextlib import redirect_stdout

HERE = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


diagnostic = load('draw_diagnostic', 'diagnose-native-draw.py')


def primary(suite='viewer-6'):
    return {'suite': suite, 'status': 'failed', 'os': {'platform': 'darwin'},
            'sourceFiles': {'viewer.js':'synthetic-source-hash'}, 'preferences': {'marionette.port': 123},
            'startupCheckpoints': [{'event': 'gpu', 'gpu': {'renderer': 'Apple Software Renderer'}}]}


class DrawDiagnosticTests(unittest.TestCase):
    def test_requires_failed_primary_mac_legacy_renderer_and_prefers_six(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for size in (6, 24):
                target = root / f'viewer-{size}/report.json'
                target.parent.mkdir()
                target.write_text(json.dumps(primary(f'viewer-{size}')))
            self.assertEqual(diagnostic.select_failure(root)[1]['suite'], 'viewer-6')
            six = root / 'viewer-6/report.json'
            value = primary();value['status'] = 'passed';six.write_text(json.dumps(value))
            self.assertEqual(diagnostic.select_failure(root)[1]['suite'], 'viewer-24')
            for field, replacement in [('status','running'), ('os',{'platform':'linux'}),
                                       ('startupCheckpoints',[]), ('diagnosticOnly',True)]:
                value = primary();value[field] = replacement
                self.assertFalse(diagnostic.eligible(value))
            (root / 'viewer-24/report.json').unlink()
            self.assertIsNone(diagnostic.select_failure(root))

    def test_masked_label_requires_independent_slow_probe(self):
        value = primary();value['rendererVisibility'] = 'masked'
        value['startupCheckpoints'] = [{'event':'gpu','gpu':{'renderer':'Apple M1, or similar'}},
            {'event':'profile','profile':{'diffuseLighting':True}}]
        self.assertFalse(diagnostic.eligible(value))
        probe = {'status':'measured','bestMs':25}
        value['startupCheckpoints'][1]['profile']['rasterProbe'] = probe
        self.assertTrue(diagnostic.eligible(value))
        probe['bestMs'] = 14;self.assertFalse(diagnostic.eligible(value))
        probe['bestMs'] = 25;probe['status'] = 'unavailable';self.assertFalse(diagnostic.eligible(value))

    def test_recovers_durable_escaped_events_without_partial_tail(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'browser.log'
            log.write_text('noise\nconsole.info: '+json.dumps('HOME_NATIVE_DRAW '+json.dumps({'event':'draw-before','draw':1}))+
                           '\nHOME_NATIVE_DRAW {"event":"draw-after","draw":1}\nconsole.info: "HOME_NATIVE_DRAW {broken')
            self.assertEqual([e['event'] for e in diagnostic.events_from_log(log)], ['draw-before','draw-after'])
            self.assertEqual(diagnostic.events_from_log(log.with_name('missing')), [])

    def test_preserves_unknown_uniforms_and_separate_pre_draw_drain(self):
        event = {'event':'draw-after', 'draw':1, 'preDrawDrainMs':12, 'submissionMs':1,
                 'completionMs':40, 'submittedUniforms':{'homePointLightingRequired':False,
                                                       'homeDaylight':0, 'homeWallSurface':None}}
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'browser.log'
            log.write_text('HOME_NATIVE_DRAW ' + json.dumps(event) + '\n')
            self.assertEqual(diagnostic.events_from_log(log), [event])

    def test_bootstrap_is_original_once_with_no_acceptance_input_or_extra_frame(self):
        module = load('native_for_draw_test', 'test-waterfox-acceptance.py')
        original = inspect.getsource(module.viewer)
        generated = diagnostic.configure_worker(module, primary())
        self.assertIn('for cycle in range(1):', generated)
        self.assertNotIn('for cycle in range(2):', generated)
        self.assertNotIn('canvas_drag', generated)
        self.assertNotIn('renderModel', generated)
        self.assertNotIn('requestAnimationFrame', generated)
        for original_line in [line for line in original.splitlines() if 'iframe.' in line or 'channel.port1.onmessage' in line]:
            self.assertIn(original_line, generated)
        self.assertIn("record.get('sourceFiles') == DIAGNOSTIC_PRIMARY_FILES", generated)
        diagnostic_timeouts = "client.call('WebDriver:SetTimeouts', {'pageLoad': 180000, 'script': 180000})"
        self.assertIn(diagnostic_timeouts, generated)
        self.assertLess(generated.index(diagnostic_timeouts), generated.index("client.call('WebDriver:Navigate'"))
        self.assertIn("window.__nativeDrawDiagnostic?.done", generated)
        self.assertEqual(module.browser_preferences(456), {'marionette.port':456,'devtools.console.stdout.content':True})
        self.assertIn('attachNativeDrawDiagnostic(renderer', module.NATIVE_VIEWER_FRAME_DIAGNOSTICS)
        run_source = inspect.getsource(module.run_case)
        self.assertIn("client.call('WebDriver:SetTimeouts', {'script': 30000, 'pageLoad': 30000, 'implicit': 0})", run_source)
        self.assertNotIn("'pageLoad': 180000", run_source)
        self.assertIn('if not diagnostic_only:\n            assert_masked_capacity(record)', run_source)
        self.assertIn("'diagnostic-completed' if diagnostic_only else 'passed'", run_source)
        self.assertIn('diagnosticOnly=True, acceptanceStatus=\'not-run\'', run_source)

    def test_supervisor_deadline_terminates_only_its_own_process_group(self):
        with tempfile.TemporaryDirectory() as directory:
            process = Mock(pid=12345, returncode=-9)
            process.wait.side_effect = [subprocess.TimeoutExpired('worker',180),
                                       subprocess.TimeoutExpired('worker',5), -9]
            with patch.object(diagnostic.subprocess, 'Popen', return_value=process) as launch, patch.object(diagnostic.os, 'killpg') as kill:
                self.assertEqual(diagnostic.supervise(['python','worker'],Path(directory)), (-9,True))
            self.assertTrue(launch.call_args.kwargs['start_new_session'])
            self.assertEqual([call.kwargs['timeout'] for call in process.wait.call_args_list], [180,5,5])
            self.assertEqual(kill.call_args_list[0].args,(12345,signal.SIGTERM))
            self.assertTrue(all(call.args[0] == 12345 for call in kill.call_args_list))
            self.assertEqual(kill.call_args_list[-1].args,(12345,signal.SIGKILL))

    def test_worker_exit_cleans_up_orphaned_children_and_exit_races(self):
        with tempfile.TemporaryDirectory() as directory:
            process = Mock(pid=222, returncode=0);process.wait.return_value=0
            with patch.object(diagnostic.subprocess,'Popen',return_value=process), patch.object(diagnostic.os,'killpg',side_effect=ProcessLookupError) as kill:
                self.assertEqual(diagnostic.supervise(['worker'],Path(directory)),(0,False))
            kill.assert_called_once_with(222,signal.SIGKILL)

    def test_completed_and_incomplete_diagnostics_never_rewrite_failed_primary(self):
        for code, expired in [(0,False), (-9,True)]:
            with self.subTest(code=code), tempfile.TemporaryDirectory() as directory:
                root=Path(directory);target=root/'viewer-6/report.json';target.parent.mkdir()
                target.write_text(json.dumps(primary()));before=target.read_bytes()
                output=root/'diagnostics/first-frame'
                argv=['diagnose-native-draw.py','--product','firefox','--expected-version','153.5.0esr',
                      '--installation',str(root/'install.json'),'--primary-output',str(root),'--output',str(output)]
                def worker(command, destination):
                    self.assertEqual(command[-2:],['--failure',str(target.resolve())])
                    running=json.loads((destination/'diagnostic.json').read_text())
                    self.assertEqual(running['status'],'running');self.assertTrue(running['diagnosticOnly'])
                    log=destination/'viewer-6/browser.log';log.parent.mkdir()
                    log.write_text('HOME_NATIVE_DRAW {"event":"draw-before","draw":1}\n')
                    return code,expired
                with patch.object(diagnostic.sys,'argv',argv), patch.object(diagnostic.sys,'platform','darwin'), \
                     patch.object(diagnostic,'supervise',side_effect=worker), redirect_stdout(io.StringIO()):
                    self.assertEqual(diagnostic.main(),0 if code==0 else 1)
                self.assertEqual(target.read_bytes(),before)
                receipt=json.loads((output/'diagnostic.json').read_text())
                self.assertTrue(receipt['primaryUnchanged']);self.assertEqual(receipt['acceptanceStatus'],'not-run')
                self.assertEqual(receipt['capturedEvents'],1)
                self.assertEqual(receipt['status'],'diagnostic-completed' if code==0 else 'diagnostic-incomplete')

    def test_output_cannot_replace_a_primary_case(self):
        with tempfile.TemporaryDirectory() as directory:
            argv=['diagnose-native-draw.py','--product','firefox','--expected-version','153.5.0esr',
                  '--installation','unused','--primary-output',directory,'--output',str(Path(directory)/'viewer-6')]
            with patch.object(diagnostic.sys,'argv',argv), self.assertRaisesRegex(ValueError,'beneath'):
                diagnostic.main()


if __name__ == '__main__':
    unittest.main()
