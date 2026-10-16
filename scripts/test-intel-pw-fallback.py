"""Offline contracts for the unchanged-case Playwright Intel comparison."""
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('intel_pw_comparison', HERE / 'run-intel-pw-fallback.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class Tests(unittest.TestCase):
    def setUp(self):
        for context in (patch.dict(runner.os.environ, {'PATH':'/usr/bin:/bin'}, clear=True),
                        patch.object(runner.platform,'system',return_value='Darwin'),
                        patch.object(runner.platform,'machine',return_value='x86_64'),
                        patch.object(runner.platform,'platform',return_value='Darwin-test-x86_64')):
            context.start();self.addCleanup(context.stop)

    def fixture(self, exits, mutation=False, drivers_differ=False):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        root=Path(temp.name);output=root/'output';observed=[];calls={}
        def snapshot(source,revision):
            calls[source.name]=calls.get(source.name,0)+1
            driver='different' if drivers_differ and source.name=='fallback-shared' else 'same'
            return {'revision':revision,'files':{**dict.fromkeys(runner.DRIVER_FILES,driver),
                'viewer.js':'changed' if mutation and calls[source.name]>1 else 'same'}}
        def execute(command,**kwargs):
            env=kwargs['env'];dest=Path(env['HOME_STUDIO_DIAGNOSTICS_DIR'])
            arm=kwargs['cwd'].name;case=dest.name
            self.assertEqual(command,['node',str(kwargs['cwd']/'scripts'/('test-planner-stability.cjs' if case=='planner-256' else 'test-browser-stability.cjs'))])
            self.assertFalse(kwargs['check']);self.assertEqual(kwargs['stderr'],subprocess.STDOUT)
            self.assertEqual(env['GITHUB_SHA'],dict(runner.ARMS)[arm])
            self.assertEqual({k:env[k] for k in runner.PROFILE},runner.PROFILE)
            self.assertFalse(any(k in env for k in runner.FORBIDDEN_OVERRIDES))
            if case=='planner-256':self.assertNotIn('BROWSER_STABILITY_ROOMS',env)
            else:self.assertEqual(env['BROWSER_STABILITY_ROOMS'],case.split('-')[1])
            current=json.loads((output/'comparison.json').read_text())
            self.assertEqual(current['arms'][len(observed)//3]['cases'][-1]['status'],'running')
            (dest/'original.json').write_bytes(b'{"unchangedFixtureReceipt":true}\n')
            kwargs['stdout'].write(b'original process log\n')
            observed.append((arm,case))
            return subprocess.CompletedProcess(command,exits[len(observed)-1])
        with patch.object(runner.common,'source_snapshot',side_effect=snapshot), \
             patch.object(runner,'toolchain_snapshot',return_value={'fixed':'toolchain'}), \
             patch.object(runner.subprocess,'run',side_effect=execute):
            result=runner.run_comparison(root,root/'toolchain',output)
        return result,json.loads((output/'comparison.json').read_text()),observed,output

    def test_failures_stay_red_and_every_original_case_runs_once(self):
        code,manifest,seen,output=self.fixture([1,0,1,0,1,0])
        self.assertEqual(code,1)
        self.assertEqual(seen,[(arm,case) for arm,_ in runner.ARMS for case,_,_ in runner.CASES])
        self.assertEqual([c['exitCode'] for a in manifest['arms'] for c in a['cases']],[1,0,1,0,1,0])
        self.assertTrue(manifest['diagnosticOnly']);self.assertFalse(manifest['releaseEligible'])
        self.assertEqual(manifest['acceptanceStatus'],'not-run')
        for arm,case in seen:
            self.assertEqual((output/arm/'raw'/case/'original.json').read_bytes(),b'{"unchangedFixtureReceipt":true}\n')

    def test_all_success_is_only_diagnostic(self):
        code,manifest,_,_=self.fixture([0]*6)
        self.assertEqual(code,0);self.assertEqual(manifest['status'],'completed')
        self.assertTrue(all(a['sourceUnchanged'] and a['toolchainUnchanged'] for a in manifest['arms']))
        self.assertFalse(manifest['releaseEligible'])

    def test_source_mutation_fails_after_passing_commands(self):
        code,manifest,seen,_=self.fixture([0]*6,mutation=True)
        self.assertEqual(code,1);self.assertEqual(len(seen),6)
        self.assertTrue(all(a['status']=='infrastructure-error' for a in manifest['arms']))

    def test_different_driver_aborts_before_any_case(self):
        code,manifest,seen,_=self.fixture([],drivers_differ=True)
        self.assertEqual(code,1);self.assertEqual(seen,[])
        self.assertIn('drivers differ',manifest['error'])

    def test_override_cannot_weaken_original_suite(self):
        overrides = [(name, 'test-value-must-not-be-logged') for name in runner.FORBIDDEN_OVERRIDES]
        overrides += [(name, 'test-value-must-not-be-logged') for name in runner.PROFILE]
        for name, value in overrides:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp, \
                 patch.dict(runner.os.environ,{name:value}), \
                 patch.object(runner,'toolchain_snapshot') as toolchain:
                root=Path(temp)
                self.assertEqual(runner.run_comparison(root,root/'toolchain',root/'out'),1)
                toolchain.assert_not_called()
                self.assertNotIn(value, json.loads((root/'out/comparison.json').read_text())['error'])

    def test_matching_matrix_profile_is_accepted(self):
        with patch.dict(runner.os.environ, runner.PROFILE):
            code,manifest,seen,_=self.fixture([0]*6)
        self.assertEqual(code,0);self.assertEqual(len(seen),6)
        self.assertEqual(manifest['profile'],runner.PROFILE)

    def test_isolated_toolchain_build_and_executable_are_verified(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);module=root/'node_modules/playwright';core=root/'node_modules/playwright-core'
            module.mkdir(parents=True);core.mkdir();binary=root/'browsers/firefox-1538/firefox';binary.parent.mkdir(parents=True);binary.write_bytes(b'firefox')
            values={'toolchain.json':{'playwright':'1.62.1','module':str(module)},'package.json':{},'package-lock.json':{},
                'node_modules/playwright/package.json':{'version':'1.62.1'},'node_modules/playwright-core/package.json':{'version':'1.62.1'},
                'node_modules/playwright-core/browsers.json':{'browsers':[{'name':'firefox','browserVersion':'153.0','revision':'1538'}]}}
            for name,value in values.items():(root/name).write_text(json.dumps(value))
            with patch.dict(runner.os.environ,{'HOME_STUDIO_PLAYWRIGHT_MODULE':str(module),'PLAYWRIGHT_BROWSERS_PATH':str(root/'browsers')}), \
                 patch.object(runner.subprocess,'check_output',return_value=str(binary)):
                result=runner.toolchain_snapshot(root)
                self.assertEqual(result['executableSha256'],runner.common.digest(binary))
                self.assertEqual(len(result['fileSha256']),6)
                (core/'package.json').write_text('{"version":"1.64.0"}')
                with self.assertRaisesRegex(ValueError,'package version'):runner.toolchain_snapshot(root)
            with self.assertRaisesRegex(ValueError,'explicit isolated'):runner.toolchain_snapshot(root)

    def test_workflow_keeps_native_job_and_separate_original_pw_job(self):
        text=(HERE.parent/'.github/workflows/intel-cgl-fallback.yml').read_text()
        native,pw=text.split('\n  playwright:',1)
        self.assertIn('diagnose-restore.py',native);self.assertNotIn('diagnose-restore.py',pw)
        self.assertIn("github.ref == 'refs/heads/diagnostic/intel-cgl-fallback'",pw)
        self.assertIn('runs-on: macos-15-intel',pw);self.assertIn('if: ${{ always() }}',pw)
        self.assertIn('name: diagnostic-intel-pw-fallback-',pw)
        for _,revision in runner.ARMS:self.assertIn('ref: '+revision,pw)
        self.assertEqual(pw.count('persist-credentials: false'),3)
        self.assertIn('setup-browser-toolchain.py --version 1.62.1',pw)
        self.assertIn('--github-env "$GITHUB_ENV"',pw)
        self.assertIn('install-browser-with-retry.py',pw)
        self.assertNotRegex(pw,r'continue-on-error|--report-only|--headless|workflow_call|secrets\.')
        for use in re.findall(r'uses: (\S+)',pw):self.assertRegex(use,r'^actions/[a-z-]+@[0-9a-f]{40}$')


if __name__=='__main__':unittest.main()
