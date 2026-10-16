#!/usr/bin/env python3
"""Offline contract tests. No browser, network or host preparation is performed."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('pair',ROOT/'scripts/run-intel-pw153-pixels625-pair.py')
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
FILES={name:'a'*64 for name in ('viewer.js','home-view.js','room-lighting.js','planner/render-capacity.js','planner/interaction-render.js')}
CANDIDATE='b'*40

def report(revision=CANDIDATE,rooms=6):
    samples=[dict(cycle=cycle,completed=True,loadCompleted=True,loadBudgetMs=60000,loadMs=1000,
                  gpu={'unmaskedRenderer':'Apple Software Renderer'},dragMs=100,editorDragMs=100)
             for cycle in (0,1)]
    samples[1]['postRestoreViews']=[dict(mode=mode,completed=True,snapshot={'renderCount':10}) for mode in p.MODES]
    return dict(status='passed',reportOnly=False,sourceRevision=revision,sourceHashScope='instrumented-compiled-viewer',
        sourceHash='c'*64,sourceFiles=FILES.copy(),browserVersion='153.0',playwrightVersion='1.62.1',
        os={'platform':'darwin','arch':'x64'},identity={'engine':'firefox','browserVersion':'153.0'},
        profile={'name':'desktop','emulated':False},launch={'headless':False,'firefoxUserPrefs':{
            'webgl.force-enabled':True,'webgl.sanitize-unmasked-renderer':False,'gfx.webrender.software':True,
            'layers.gpu-process.enabled':False,'webgl.allow-in-parent':True}},
        inputDiagnostics={'tapMode':'playwright','traceInput':False,'dragReleaseHoldMs':0},
        fixture={'floors':1,'rooms':rooms,'lights':rooms*3},deadlineScope={'version':2,'bootstrapMs':30000,
            'scenarioMs':180000,'scenario':'execute-through-final-identity-and-checks','hardProcessMs':245000},
        bootstrapDurationMs=200,scenarioStartedMs=200,scenarioCompletedMs=2200,scenarioDurationMs=2000,
        viewerCompletion={'version':1,'cycles':2,'postRestoreModes':p.MODES.copy()},loadBudgetMs=60000,
        gpu={'unmaskedRenderer':'Apple Software Renderer'},samples=samples,
        finishedAt='2026-10-16T00:00:00Z',cleanupDurationsMs={'context':1,'browser':2},
        errors=[],crashes=[],consoleErrors=[],failedAssertions=[],diagnosticsErrors=[],cleanupErrors=[])

def summary(value):
    return dict(suite='viewer',sourceRevision=value['sourceRevision'],finishedAt='2026-10-16T00:00:01Z',
                status=value['status'],browsers=[dict(engine='firefox',file='firefox.json',status=value['status'])])

class PairTests(unittest.TestCase):
    def test_unselected_fails_before_workflow_or_setup(self):
        with patch.object(p,'CANDIDATE','UNSELECTED'),patch.object(Path,'read_text') as read:
            with self.assertRaises(ValueError):p.validate_selection()
            read.assert_not_called()
    def test_selected_exact_pin_and_changed_inventory(self):
        text='ref: '+p.BASELINE+'\nref: '+CANDIDATE+'\n'
        with patch.object(p,'CANDIDATE',CANDIDATE),patch.object(p,'CANDIDATE_CHANGED_FILES',('viewer.js',)),patch.object(Path,'read_text',return_value=text):
            self.assertEqual(p.validate_selection()['candidate'],CANDIDATE)
            for changes in [(),('viewer.js','viewer.js'),('scripts/test-browser-stability.cjs',),('../escape',)]:
                with patch.object(p,'CANDIDATE_CHANGED_FILES',changes):
                    with self.assertRaises(ValueError):p.validate_selection()
            with patch.object(Path,'read_text',return_value=text+'ref: '+CANDIDATE):
                with self.assertRaises(ValueError):p.validate_selection()
    def test_frozen_or_placeholder_selection(self):
        if p.CANDIDATE=='UNSELECTED':
            with self.assertRaises(ValueError):p.validate_selection()
        else:self.assertEqual(p.validate_selection()['candidate'],p.CANDIDATE)
    def test_protected_sources_and_exact_delta(self):
        before={name:'a' for name in p.PROTECTED};before['viewer.js']='a'
        after={**before,'viewer.js':'b'}
        with patch.object(p,'CANDIDATE_CHANGED_FILES',('viewer.js',)):
            self.assertEqual(p.verify_sources({'baseline':{'files':before},'candidate':{'files':after}}),['viewer.js'])
            for bad in [{**after,'new.js':'b'},{**after,p.PROTECTED[0]:'b'},before]:
                with self.assertRaises(ValueError):p.verify_sources({'baseline':{'files':before},'candidate':{'files':bad}})
    def test_source_head_clean_and_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'file.js').write_bytes(b'source')
            values=[p.BASELINE.encode(),b'',b'file.js\0',b'd'*40]
            with patch.object(p,'git',side_effect=values):
                self.assertEqual(p.source_snapshot(root,p.BASELINE)['files'],{'file.js':p.sha(b'source')})
            for values in ([CANDIDATE.encode()],[p.BASELINE.encode(),b' M file.js']):
                with patch.object(p,'git',side_effect=values):
                    with self.assertRaises(ValueError):p.source_snapshot(root,p.BASELINE)
    def test_environment_removes_optional_modes(self):
        dirty={'BROWSER_STABILITY_REPORT_ONLY':'1','HOME_STUDIO_FIXTURE_ONLY':'1',
               'BROWSER_STABILITY_SCREENSHOT_DIR':'bad','BROWSER_STABILITY_TRACE_INPUT':'1',
               'FIREFOX_WEBGL_BACKEND':'angle','HOME_STUDIO_PLAYWRIGHT_MODULE':'bad','PATH':'keep',
               'GITHUB_SHA':'f'*40}
        with patch.dict(os.environ,dirty,clear=True):env=p.environment(Path('/source'),Path('/out'),Path('/tools'))
        for name in dirty:
            if name not in p.PROFILE and name not in ('PATH','HOME_STUDIO_PLAYWRIGHT_MODULE'):self.assertNotIn(name,env)
        self.assertEqual(env['PATH'],'keep');self.assertEqual(env['HOME_STUDIO_PLAYWRIGHT_MODULE'],'/tools/node_modules/playwright')
        self.assertEqual(env['FIREFOX_WEBGL_BACKEND'],'default')
    def test_host_ref_isolation(self):
        env={'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted','RUNNER_OS':'macOS',
             'GITHUB_EVENT_NAME':'push','GITHUB_REF':'refs/heads/'+p.BRANCH}
        with patch.dict(os.environ,env,clear=True),patch.object(p.sys,'platform','darwin'),patch.object(p.platform,'machine',return_value='x86_64'):
            p.require_host()
            for name,value in [('RUNNER_ENVIRONMENT','self-hosted'),('GITHUB_REF','refs/heads/main'),('GITHUB_EVENT_NAME','pull_request')]:
                with patch.dict(os.environ,{name:value}):
                    with self.assertRaises(ValueError):p.require_host()
    def test_original_helper_reads_checkout_not_harness_environment(self):
        with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ,{'GITHUB_SHA':'f'*40}):
            env=p.environment(ROOT,Path(temp),Path(temp)/'unused-tools')
            script="const r=process.argv[1];const h=require(r+'/scripts/browser-stability-diagnostics.cjs');console.log(h.createDiagnostics('viewer','BROWSER_STABILITY',r).summary.sourceRevision);"
            actual=subprocess.check_output(['node','-e',script,str(ROOT)],env=env,text=True,timeout=10).strip().splitlines()[-1]
            expected=subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True,timeout=10).strip()
            self.assertEqual(actual,expected)
            self.assertNotEqual(actual,'f'*40)
    def test_successful_original_receipt(self):
        self.assertEqual(p.validate_report(report(),CANDIDATE,6,FILES)['loadsMs'],[1000,1000])
    def test_primary_and_completion_negatives(self):
        mutations=[lambda r:r.update(status='failed'),lambda r:r.update(reportOnly=True),lambda r:r.update(diagnosticOnly=True),
            lambda r:r.update(timedOut=True),lambda r:r.update(sourceRevision='c'*40),lambda r:r['sourceFiles'].update({'viewer.js':'b'*64}),
            lambda r:r.update(browserVersion='157.0'),lambda r:r['os'].update(arch='arm64'),lambda r:r['profile'].update(emulated=True),
            lambda r:r['launch'].update(headless=True),lambda r:r['launch']['firefoxUserPrefs'].update({'webgl.disable-angle':False}),
            lambda r:r['inputDiagnostics'].update(traceInput=True),lambda r:r['fixture'].update(lights=1),
            lambda r:r['deadlineScope'].update(scenarioMs=240000),lambda r:r.update(bootstrapDurationMs=30000),
            lambda r:r.update(scenarioDurationMs=180000),lambda r:r.update(scenarioDurationMs=float('nan')),
            lambda r:r.update(scenarioCompletedMs=None),lambda r:r.update(viewerCompletion=None),lambda r:r['samples'].pop(),
            lambda r:r['samples'][0].update(loadMs=60000),lambda r:r['samples'][0].update(loadCompleted=False),
            lambda r:r['samples'][1]['postRestoreViews'].pop(),lambda r:r['samples'][1]['postRestoreViews'][0].update(completed=False),
            lambda r:r['samples'][1]['gpu'].update(unmaskedRenderer='Intel hardware'),lambda r:r['gpu'].update(unmaskedRenderer='Apple M1, or similar'),
            lambda r:r['cleanupErrors'].append('timeout')]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                value=report();mutate(value)
                with self.assertRaises((ValueError,TypeError)):p.validate_report(value,CANDIDATE,6,FILES)
    def test_collect_preserves_failure_bytes_and_nonzero_exit(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);path=root/'firefox.json';value=report();path.write_text(json.dumps(value));raw=path.read_bytes()
            (root/'summary.json').write_text(json.dumps(summary(value)))
            self.assertTrue(p.collect_case(root,CANDIDATE,6,0,FILES)['qualified'])
            self.assertFalse(p.collect_case(root,CANDIDATE,6,1,FILES)['qualified']);self.assertEqual(path.read_bytes(),raw)
            value['status']='failed';path.write_text(json.dumps(value));raw=path.read_bytes()
            (root/'summary.json').write_text(json.dumps(summary(value)))
            self.assertTrue(p.collect_case(root,CANDIDATE,6,1,FILES)['cleanupVerified'])
            self.assertFalse(p.collect_case(root,CANDIDATE,6,0,FILES)['qualified']);self.assertEqual(path.read_bytes(),raw)
            (root/'duplicate').mkdir();(root/'duplicate/firefox.json').write_text(json.dumps(report()))
            self.assertFalse(p.collect_case(root,CANDIDATE,6,0,FILES)['qualified'])
    def test_malformed_reports_fail_closed_and_preserve_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);path=root/'firefox.json'
            self.assertFalse(p.collect_case(root,CANDIDATE,6,0,FILES)['qualified'])
            for raw in (b'{incomplete',b'[]',b'null',json.dumps({**report(),'samples':[None,None]}).encode()):
                path.write_bytes(raw)
                result=p.collect_case(root,CANDIDATE,6,0,FILES)
                self.assertFalse(result['qualified']);self.assertEqual(result['reportSha256'],p.sha(raw))
                self.assertEqual(path.read_bytes(),raw)
    def test_restoration_summary_copies_completed_and_failed_original_timings(self):
        for status in ('passed','failed'):
            with self.subTest(status=status),tempfile.TemporaryDirectory() as temp:
                root=Path(temp);value=report();value['status']=status
                value['phases']=[dict(name='viewer-load',cycle=0,durationMs=1000),
                    dict(name='context-restore',cycle=1,startedMs=23000.25,
                         completedMs=25123.75 if status=='passed' else None,
                         durationMs=2123.5 if status=='passed' else None)]
                value['samples'][1]['postRestoreViews'][0]['durationMs']=3456
                path=root/'firefox.json';path.write_text(json.dumps(value));before=path.read_bytes()
                (root/'summary.json').write_text(json.dumps(summary(value)))
                result=p.collect_case(root,CANDIDATE,6,0 if status=='passed' else 1,FILES)
                self.assertEqual(result['qualified'],status=='passed')
                self.assertEqual(result['restoration']['phases'],[value['phases'][1]])
                self.assertEqual(result['restoration']['postRestoreViews'][0]['durationMs'],3456)
                self.assertEqual(path.read_bytes(),before)
        self.assertEqual(p.restoration_timings({'phases':[None], 'samples':[None]}),
                         {'phases':[], 'postRestoreViews':[]})

    def test_cleanup_requires_final_summary_and_actual_browser_close(self):
        mutations=[lambda r,s:s.pop('finishedAt'),lambda r,s:s.update(sourceRevision='d'*40),
                   lambda r,s:s.update(status='running'),lambda r,s:r['cleanupDurationsMs'].pop('browser'),
                   lambda r,s:r['cleanupErrors'].append('close failed'),lambda r,s:r.update(hardDeadlineExceeded=True)]
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            for mutate in mutations:
                value=report();end=summary(value);mutate(value,end)
                (root/'firefox.json').write_text(json.dumps(value));(root/'summary.json').write_text(json.dumps(end))
                result=p.collect_case(root,CANDIDATE,6,0,FILES)
                self.assertFalse(result['qualified']);self.assertFalse(result['cleanupVerified'])
    def test_cleanup_only_child_group(self):
        with patch.object(p.os,'killpg',side_effect=ProcessLookupError) as kill:
            self.assertFalse(p.cleanup_group(9876));kill.assert_called_once_with(9876,p.signal.SIGTERM)
        with patch.object(p.os,'killpg',side_effect=[None,ProcessLookupError]) as kill,patch.object(p.time,'monotonic',side_effect=[0,0]):
            self.assertTrue(p.cleanup_group(9876));self.assertEqual([x.args[0] for x in kill.call_args_list],[9876,9876])
    def test_fixed_order_continues_original_failures(self):
        for fail_at in (None,0,1,2,3,'timeout','corrupt'):
            with self.subTest(fail_at=fail_at),tempfile.TemporaryDirectory() as temp:
                root=Path(temp);sources=root/'sources';sources.mkdir();toolchain=root/'tools';prep=root/'prep';prep.mkdir()
                for name in ('baseline','candidate'):(sources/name/'scripts').mkdir(parents=True)
                (sources/'baseline/scripts/prepare-intel-macos-ci.py').write_text('def indexing_command(path):\n return {}\ndef verify_indexing_disabled(state,volumes):\n pass\n')
                for name in ('playwright','playwright-core'):
                    target=toolchain/'node_modules'/name;target.mkdir(parents=True);(target/'package.json').write_text('{"version":"1.62.1"}')
                (toolchain/'toolchain.json').write_text(json.dumps({'playwright':'1.62.1','module':str(toolchain/'node_modules/playwright')}))
                (prep/'preparation.json').write_text(json.dumps({'status':'prepared','verifiedDisabled':True,'beforeVolumes':{}}))
                order=[]
                def launch(command,**kw):
                    env=kw['env'];name=Path(kw['cwd']).name;rooms=int(env['BROWSER_STABILITY_ROOMS']);index=len(order);order.append((name,rooms))
                    self.assertEqual(command,['node','scripts/test-browser-stability.cjs']);self.assertTrue(kw['start_new_session'])
                    out=Path(env['HOME_STUDIO_DIAGNOSTICS_DIR']);(out/'actual').mkdir();value=report(p.BASELINE if name=='baseline' else CANDIDATE,rooms)
                    if index==fail_at:value['status']='failed'
                    (out/'actual/firefox.json').write_text('{incomplete' if fail_at=='corrupt' and index==0 else json.dumps(value))
                    (out/'actual/summary.json').write_text(json.dumps(summary(value)))
                    waits=[]
                    def wait(timeout):
                        waits.append(timeout)
                        if fail_at=='timeout' and index==0:
                            if len(waits)==1:
                                self.assertEqual(timeout,375)
                                raise subprocess.TimeoutExpired(command,timeout)
                            self.assertEqual(timeout,5)
                            return -15
                        self.assertEqual(timeout,375)
                        return 1 if index==fail_at else 0
                    return SimpleNamespace(pid=9876,wait=wait)
                def snapshot(source,revision):return {'revision':revision,'tree':'d'*40,'files':FILES}
                args=SimpleNamespace(source_root=sources,toolchain=toolchain,preparation=prep,output=root/'out')
                with patch.object(p,'validate_selection'),patch.object(p,'require_host'),patch.object(p,'verify_sources'),patch.object(p,'CANDIDATE',CANDIDATE),patch.object(p,'source_snapshot',side_effect=snapshot),patch.object(p.subprocess,'Popen',side_effect=launch),patch.object(p,'cleanup_group',return_value=False):
                    self.assertEqual(p.run(args),0 if fail_at is None else 1)
                self.assertEqual(tuple(order),p.ORDER[:1] if fail_at in ('timeout','corrupt') else p.ORDER)
                manifest=json.loads((root/'out/manifest.json').read_text());self.assertFalse(manifest['releaseEligible']);self.assertTrue(manifest['diagnosticOnly'])
                self.assertEqual(len(manifest['cases']),1 if fail_at in ('timeout','corrupt') else 4)
                if fail_at=='timeout':
                    self.assertTrue(manifest['cases'][0]['hostTimedOut'])
                    self.assertFalse(manifest['cases'][0]['qualified'])
                    self.assertEqual(manifest['cases'][0]['originalStatus'],'passed')
                    self.assertEqual(len(manifest['remainingCasesNotRun']),3)
                if fail_at=='corrupt':
                    self.assertFalse(manifest['cases'][0]['qualified'])
                    self.assertEqual(len(manifest['remainingCasesNotRun']),3)
                    self.assertEqual((root/'out/1-baseline-viewer-6/actual/firefox.json').read_text(),'{incomplete')
    def test_workflow_isolated_and_bounded(self):
        self.assertEqual(p.ORDER,(('baseline',6),('candidate',6),('candidate',24),('baseline',24)))
        text=(ROOT/p.WORKFLOW).read_text()
        for token in ('branches: [diagnostic/intel-pw153-pixels625-pair]',"github.ref == 'refs/heads/diagnostic/intel-pw153-pixels625-pair'",'runs-on: macos-15-intel','timeout-minutes: 40','timeout-minutes: 12','cancel-in-progress: false','contents: read','if: ${{ always() }}'):
            self.assertIn(token,text)
        self.assertIn('Run baseline6 candidate6 candidate24 baseline24 without retries',text)
        self.assertEqual(text.count('runs-on:'),1);self.assertEqual(text.count('scripts/run-intel-pw153-pixels625-pair.py --source-root'),1)
        self.assertNotIn('continue-on-error:',text);self.assertNotIn('workflow_call:',text);self.assertNotIn('workflow_dispatch:',text)
        self.assertNotIn('quality-gate.yml',text);self.assertNotIn('release-pipeline.yml',text)
        self.assertNotIn('BROWSER_STABILITY_REPORT_ONLY',text);self.assertIn('name: diagnostic-intel-pw153-pixels625-pair-',text)
        for line in text.splitlines():
            if 'uses:' in line:self.assertRegex(line,r'@[a-f0-9]{40}(?: |$)')

if __name__=='__main__':unittest.main()
