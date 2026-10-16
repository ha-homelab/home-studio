import importlib.util
import inspect
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
REPOSITORY=HERE.parents[1]
ROOT=Path(os.environ.get('HOME_STUDIO_REVIEW_SOURCE',str(REPOSITORY)))
spec=importlib.util.spec_from_file_location('restore_adapter',HERE/'diagnose-restore.py')
adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)


class Tests(unittest.TestCase):
    def module(self):
        sys.path.insert(0,str(ROOT/'scripts'))
        return adapter.load_module(ROOT/'scripts/test-waterfox-acceptance.py','native_restore_test')

    def test_exact_adapter_scope(self):
        module=self.module();original=inspect.getsource(module.viewer)
        with tempfile.TemporaryDirectory() as temp:
            before,after=adapter.configure(module,{'sourceFiles':{'a':'b'},'preferences':{}},Path(temp))
        self.assertEqual(before,original)
        undo=after.replace('def restore_diagnostic_viewer(','def viewer(',1)
        undo=undo.replace('window.restoreTestContext=()=>window.__nativeRestoreTrace.invoke(()=>e.restoreContext());','window.restoreTestContext=()=>e.restoreContext();',1)
        undo=undo.replace('            trace_restore_call(client,record,save)',"            client.execute('window.restoreTestContext();return true;')",1)
        undo=undo.replace("    require(record.get('sourceFiles') == RESTORE_PRIMARY_FILES, 'Restore diagnostic source differs from failed primary')\n",'',1)
        undo=undo.removesuffix('    assert_masked_capacity(record)\n    assert_requested_backend(record)\n')
        self.assertEqual(undo,original,'Every original action, wait, assertion and loop remains byte-identical')
        self.assertIn('for cycle in range(2):',after)
        self.assertIn("require(sample['loadMs'] < 30000",after)
        self.assertNotIn('settimeout(',after)

    def test_host_trace_retains_one_call_return_and_original_exception(self):
        class Client:
            def __init__(self,error=None):self.calls=[];self.error=error
            def execute(self,script):
                self.calls.append(script)
                if self.error:raise self.error
                return object_marker
        object_marker=object();module=self.module()
        with tempfile.TemporaryDirectory() as temp:
            adapter.configure(module,{'sourceFiles':{},'preferences':{}},Path(temp))
            record={};client=Client()
            self.assertIs(module.trace_restore_call(client,record,lambda:None),object_marker)
            self.assertEqual(client.calls,[adapter.RESTORE_SCRIPT])
            error=TimeoutError('original native receive timeout');client=Client(error)
            with self.assertRaises(TimeoutError) as caught:module.trace_restore_call(client,record,lambda:None)
            self.assertIs(caught.exception,error)
            self.assertEqual(client.calls,[adapter.RESTORE_SCRIPT])
            events=[json.loads(line) for line in (Path(temp)/'host-events.jsonl').read_text().splitlines()]
            self.assertEqual([e['event'] for e in events],['execute-restore-before','execute-restore-return','execute-restore-before','execute-restore-error'])

    def test_only_actual_restore_failure_is_eligible(self):
        value={'status':'failed','suite':'viewer-24','os':{'platform':'darwin'},'traceback':adapter.RESTORE_SCRIPT,
               'sourceRevision':adapter.EXPECTED_SOURCE,'sourceFiles':dict.fromkeys(adapter.SOURCE_FILES,'hash'),
               'samples':[{'cycle':0},{'cycle':1,'states':[{'active':n} for n in (72,0,36,72)]}]}
        self.assertTrue(adapter.eligible(value))
        for changes in [{'diagnosticOnly':True},{'status':'passed'},{'traceback':'initial load timeout'},{'sourceFiles':{}},{'os':{'platform':'linux'}},{'sourceRevision':'old-source'},{'samples':[]},
                        {'samples':[{},{'cycle':1,'states':[{'active':n} for n in (72,0,36,72)],'recovery':{}}]},
                        {'samples':[{},{'cycle':1,'states':[{'active':n} for n in (72,0,36)]}]}]:
            self.assertFalse(adapter.eligible({**value,**changes}))

    def test_same_job_runtime_bytes_and_clean_pinned_source(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            for name in adapter.SOURCE_FILES:
                path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(name)
            record={'sourceFiles':{name:adapter.digest(root/name) for name in adapter.SOURCE_FILES}}
            with patch.object(adapter.subprocess,'check_output',side_effect=[adapter.EXPECTED_SOURCE+'\n','']):
                self.assertEqual(adapter.validate_source(root,record),record['sourceFiles'])
            for outputs in (['wrong\n'],[adapter.EXPECTED_SOURCE+'\n',' M viewer.js']):
                with patch.object(adapter.subprocess,'check_output',side_effect=outputs):
                    with self.assertRaises(ValueError):adapter.validate_source(root,record)
            (root/'viewer.js').write_text('modified')
            with patch.object(adapter.subprocess,'check_output',side_effect=[adapter.EXPECTED_SOURCE+'\n','']):
                with self.assertRaises(ValueError):adapter.validate_source(root,record)

    def test_primary_tree_detects_sibling_changes_and_additions(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'viewer-24').mkdir();(root/'viewer-6').mkdir()
            (root/'viewer-24/report.json').write_text('failed');(root/'viewer-6/report.json').write_text('passed')
            before=adapter.tree_hashes(root)
            (root/'viewer-6/report.json').write_text('modified')
            self.assertNotEqual(adapter.tree_hashes(root),before)
            (root/'viewer-6/report.json').write_text('passed');(root/'added.log').write_text('extra')
            self.assertNotEqual(adapter.tree_hashes(root),before)

    def test_stdout_recovery_preserves_last_incomplete_operation(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'browser.log'
            path.write_text('noise\nconsole.info: '+json.dumps('HOME_NATIVE_RESTORE '+json.dumps({'event':'restore-call-before'}))+'\nHOME_NATIVE_RESTORE_DRAW '+json.dumps({'event':'draw-before','draw':1})+'\nHOME_NATIVE_RESTORE_DRAW {partial')
            self.assertEqual([e['event'] for e in adapter.recover_events(path)],['restore-call-before','draw-before'])

    def test_success_requires_actual_complete_restored_frame(self):
        events=[{'event':'restore-call-before'},{'event':'context-restored-capture'},
                {'event':'frame-after','done':True,'draws':271}]
        self.assertTrue(adapter.capture_complete(events))
        self.assertFalse(adapter.capture_complete(events[:-1]))
        self.assertFalse(adapter.capture_complete(events+[events[-1]]))
        for change in ({'truncated':True},{'error':'profile rejected'},{'draws':0},{'draws':601}):
            self.assertFalse(adapter.capture_complete([*events[:-1],{**events[-1],**change}]))

    def test_main_skips_unrelated_failure_and_protects_primary_output_boundary(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);source=root/'source';(source/'scripts').mkdir(parents=True)
            (source/'scripts/test-waterfox-acceptance.py').write_text('original driver')
            raw=root/'raw';(raw/'viewer-24').mkdir(parents=True)
            primary=raw/'viewer-24/report.json'
            primary.write_text(json.dumps({'status':'failed','suite':'viewer-24',
                'sourceRevision':adapter.EXPECTED_SOURCE,'traceback':'unrelated initial load timeout'}))
            (raw/'summary.json').write_text('original summary')
            install=root/'install.json';install.write_text('{}')
            output=root/'separate-replay';before=adapter.tree_hashes(raw)
            arguments=['diagnose-restore.py','--source',str(source),'--primary-report',str(primary),
                '--primary-root',str(raw),'--installation',str(install),'--product','firefox',
                '--expected-version','153.5.0esr','--output',str(output),'--run']
            with patch.object(adapter.sys,'argv',arguments), \
                 patch.object(adapter.subprocess,'check_output',return_value=adapter.EXPECTED_SOURCE), \
                 patch.object(adapter,'supervise') as launch, patch('builtins.print'):
                self.assertEqual(adapter.main(),0)
            launch.assert_not_called()
            result=json.loads((output/'diagnostic.json').read_text())
            self.assertEqual(result['status'],'skipped')
            self.assertTrue(result['diagnosticOnly'])
            self.assertFalse(result['releaseEligible'])
            self.assertTrue(result['primaryUnchanged'] and result['primaryTreeUnchanged'])
            self.assertEqual(adapter.tree_hashes(raw),before)
            arguments[arguments.index('--output')+1]=str(raw/'bad-replay')
            with patch.object(adapter.sys,'argv',arguments), patch.object(adapter,'supervise') as launch:
                with self.assertRaisesRegex(ValueError,'separate from the entire primary'):
                    adapter.main()
            launch.assert_not_called()
            self.assertFalse((raw/'bad-replay').exists())

    def test_disposable_workflow_preserves_failed_primary(self):
        workflow=(REPOSITORY/'.github/workflows/intel-cgl-fallback.yml').read_text().split('\n  playwright:',1)[0]
        self.assertIn('runs-on: macos-15-intel',workflow)
        self.assertIn('ref: f4a9ebba66b8f7ddce017535092f1885fbbfa8c0',workflow)
        self.assertIn("if: ${{ failure() && steps.compare.outcome == 'failure' }}",workflow)
        self.assertNotIn('continue-on-error:',workflow)
        self.assertNotIn('git push',workflow)
        self.assertEqual(workflow.count('python3 harness/scripts/run-intel-cgl-fallback.py'),1)
        self.assertIn('id: compare',workflow)
        self.assertIn('--product firefox --expected-version 153.5.0esr',workflow)
        self.assertIn('--primary-root "$primary"',workflow)
        self.assertIn('candidate-restore-replay',workflow)
        self.assertEqual(workflow.count('diagnose-restore.py'),1)
        for reference in re.findall(r'uses:\s+(\S+)',workflow):
            self.assertRegex(reference,r'^[\w/-]+@[0-9a-f]{40}$')


if __name__=='__main__':unittest.main()
