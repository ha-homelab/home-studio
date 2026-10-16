#!/usr/bin/env python3
"""Test reviewed coverage and reject toolchain drift or unsafe browser archives."""
import importlib.util
import copy
import hashlib
import io
import json
import os
import stat
import subprocess
import tempfile
import textwrap
import unittest
import zipfile
from pathlib import Path
from unittest import mock
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def load_script(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


matrix = load_script('browser-matrix')
setup = load_script('setup-browser-toolchain')
chrome = load_script('setup-chrome-for-testing')


class BrowserMatrixTests(unittest.TestCase):
    def setUp(self):
        self.manifest = matrix.load_manifest()
        self.rows = matrix.expand(self.manifest)

    def test_touch_diagnostics_keep_primary_failures_and_select_only_failed_viewers(self):
        workflow = (ROOT / '.github/workflows/platform-acceptance.yml').read_text()
        section = workflow.split('      - name: Compare native tap transports after a Chromium touch viewer failure\n')[1].split('      - name: ')[0]
        gate = "!cancelled() && matrix.engine == 'chromium' && matrix.profile != 'desktop' && (steps.viewer_6_acceptance.outcome == 'failure' || steps.viewer_24_acceptance.outcome == 'failure')"
        self.assertIn('if: ${{ ' + gate + ' }}', section)
        self.assertNotIn('continue-on-error', workflow)
        self.assertIn("BROWSER_STABILITY_TRACE_INPUT: '1'", section)
        self.assertIn("DEBUG: ${{ matrix.engine == 'chromium' && 'pw:browser' || '' }}", workflow)
        for rooms in (6, 24):
            primary = workflow.split(f'      - name: Test generated viewer with {rooms} rooms')[1].split('      - name: ')[0]
            self.assertIn(f'id: viewer_{rooms}_acceptance', primary)
            self.assertNotIn('BROWSER_STABILITY_TOUCH_TAP', primary)
            self.assertNotIn('BROWSER_STABILITY_TRACE_INPUT', primary)
        script = textwrap.dedent(section.split('        run: |\n')[1])
        for runner_os in ('Linux', 'Windows'):
            for failed in ((), (6,), (24,), (6, 24)):
                with self.subTest(runner_os=runner_os, failed=failed), tempfile.TemporaryDirectory() as directory:
                    folder = Path(directory)
                    node = folder / 'node'
                    node.write_text('#!/usr/bin/env python3\nimport json,os,sys\n'
                        'with open(os.environ["CALLS"],"a") as out:\n'
                        ' out.write(json.dumps({"rooms":int(os.environ["BROWSER_STABILITY_ROOMS"]),'
                        '"mode":os.environ["BROWSER_STABILITY_TOUCH_TAP"],"args":sys.argv[1:],'
                        '"trace":os.environ["BROWSER_STABILITY_TRACE_INPUT"]})+"\\n")\n'
                        'sys.exit(1 if os.environ["BROWSER_STABILITY_TOUCH_TAP"]=="playwright" else 0)\n')
                    node.chmod(0o755)
                    xvfb = folder / 'xvfb-run'
                    xvfb.write_text('#!/bin/sh\nshift\nexec "$@"\n')
                    xvfb.chmod(0o755)
                    calls = folder / 'calls.jsonl'
                    environment = {**os.environ, 'PATH':str(folder)+os.pathsep+os.environ['PATH'],
                        'CALLS':str(calls), 'RUNNER_OS':runner_os, 'BROWSER_STABILITY_TRACE_INPUT':'1',
                        'VIEWER_6_OUTCOME':'failure' if 6 in failed else 'success',
                        'VIEWER_24_OUTCOME':'failure' if 24 in failed else 'success'}
                    result = subprocess.run(['bash','-c',script],cwd=folder,env=environment,capture_output=True,text=True)
                    self.assertEqual(result.returncode, 1 if failed else 0, result.stderr)
                    actual = [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []
                    expected = [{'rooms':rooms,'mode':mode,'args':['scripts/test-browser-stability.cjs'],'trace':'1'}
                                for rooms in failed for mode in ('playwright','gesture50')]
                    self.assertEqual(actual, expected)

    def test_current_toolchain_matches_repository_lock(self):
        version = self.manifest['current_playwright']
        package = json.loads((ROOT / 'package.json').read_text())
        lock = json.loads((ROOT / 'package-lock.json').read_text())
        self.assertEqual(version, package['devDependencies']['playwright'])
        for name in ('playwright', 'playwright-core'):
            self.assertEqual(self.manifest['playwright'][version]['packages'][name]['integrity'],
                             lock['packages'][f'node_modules/{name}']['integrity'])

    def test_full_desktop_and_touch_coverage_is_required(self):
        rows = self.rows['browser']['include']
        self.assertEqual(len(rows), 58)
        self.assertEqual(len(self.rows['native']['include']), 15)
        for matrix_rows in self.rows.values():
            identities = {(row['os'], row['id']) for row in matrix_rows['include']}
            self.assertEqual(len(identities), len(matrix_rows['include']))
        for platform_os in ('ubuntu-24.04', 'windows-2022', 'macos-15'):
            platform_rows = [row for row in rows if row['os'] == platform_os]
            self.assertEqual(len(platform_rows), 19)
            snapshots = {(row['playwright'], row['engine']) for row in platform_rows
                         if row['profile'] == 'desktop' and not row['channel'] and not row['cft']}
            self.assertEqual(snapshots, {(version, engine) for version in ('1.62.1', '1.63.0', '1.64.0')
                                        for engine in ('chromium', 'firefox', 'webkit')})
            self.assertEqual({row['channel'] for row in platform_rows if row['channel']},
                             {'chrome', 'chrome-beta', 'msedge', 'msedge-beta'})
            self.assertEqual({(row['engine'], row['profile']) for row in platform_rows if row['profile'] != 'desktop'},
                             {('chromium', 'phone'), ('chromium', 'tablet'), ('webkit', 'phone'), ('webkit', 'tablet')})
            self.assertEqual({row['cft'] for row in platform_rows if row['cft']},
                             {'153.0.8010.52', '154.0.8037.92'})
            native = {(row['product'], row['version']) for row in self.rows['native']['include'] if row['os'] == platform_os}
            self.assertEqual(native, {('firefox', '158.0'), ('firefox', '153.5.0esr'),
                                      ('waterfox', '6.7.5'), ('waterfox', '6.7.6')})

    def test_two_preceding_chrome_majors_have_pinned_official_archives(self):
        chrome_inventory = self.manifest['chrome_for_testing']
        stable = int(chrome_inventory['stable_at_review'].split('.')[0])
        self.assertEqual({int(version.split('.')[0]) for version in chrome_inventory['versions']}, {stable - 1, stable - 2})
        for version, downloads in chrome_inventory['versions'].items():
            self.assertEqual(set(downloads), {'linux64', 'win64', 'mac-arm64'})
            for platform, entry in downloads.items():
                url = urlsplit(entry['url'])
                self.assertEqual((url.scheme, url.netloc), ('https', 'storage.googleapis.com'))
                self.assertEqual(url.path, f'/chrome-for-testing-public/{version}/{platform}/chrome-{platform}.zip')
                self.assertRegex(entry['sha256'], r'^[a-f0-9]{64}$')

    def test_known_risks_run_first_without_changing_remaining_os_rotation(self):
        platforms = list(self.manifest['platforms'])
        priority = {
            'browser': [('macos-15', 'firefox-153.0-pw1.62.1-desktop')]
                + [('windows-2022', target) for target in (
                    'webkit-27.2-pw1.64.0-desktop', 'webkit-26.6-pw1.63.0-desktop',
                    'webkit-26.5-pw1.62.1-desktop', 'webkit-27.2-pw1.64.0-phone',
                    'webkit-27.2-pw1.64.0-tablet')]
                + [(os, f'chromium-156.0.8078.4-pw1.64.0-{profile}')
                   for profile in ('phone', 'tablet') for os in platforms]
                + [(os, f'webkit-27.2-pw1.64.0-{profile}')
                   for profile in ('phone', 'tablet') for os in ('ubuntu-24.04', 'macos-15')],
            'native': [('macos-15', target) for target in (
                'firefox-153.5.0esr', 'waterfox-6.7.5', 'waterfox-6.7.6', 'firefox-153.5.0esr-masked-renderer')],
        }
        for name, matrix_rows in self.rows.items():
            identities = [(row['os'], row['id']) for row in matrix_rows['include']
                          if row['os'] in platforms]
            self.assertEqual(identities[:len(priority[name])], priority[name])
            remaining = identities[len(priority[name]):]
            targets = list(dict.fromkeys(target for _, target in remaining))
            expected = [(os, target) for target in targets for os in platforms
                        if (os, target) not in priority[name]]
            self.assertEqual(remaining, expected)
        self.assertEqual(self.rows, matrix.expand(self.manifest))

    def test_intel_comparisons_add_only_three_exact_clones(self):
        original = copy.deepcopy(self.manifest)
        original.pop('additional_targets')
        baseline = matrix.expand(original)
        expected = {'browser': {'firefox-153.0-pw1.62.1-desktop'},
                    'native': {'firefox-153.5.0esr', 'waterfox-6.7.6'}}
        for name, matrix_rows in self.rows.items():
            rows = matrix_rows['include']
            additional = [row for row in rows if row['os'] == 'macos-15-intel']
            self.assertEqual({row['id'] for row in additional}, expected[name])
            self.assertEqual([row for row in rows if row['os'] != 'macos-15-intel'],
                             baseline[name]['include'])
            for row in additional:
                self.assertIn({**row, 'os': 'macos-15'}, baseline[name]['include'])
            self.assertTrue(all(row['os'].startswith('macos-') for row in rows[:2]))
        self.assertEqual(sum(len(rows['include']) for rows in self.rows.values()) + 4, 77)

    def test_masked_variant_adds_exactly_one_mandatory_row_without_changing_originals(self):
        original = copy.deepcopy(self.manifest)
        original.pop('native_variants')
        baseline = matrix.expand(original)
        self.assertEqual(self.rows['browser'], baseline['browser'])
        variants = [row for row in self.rows['native']['include'] if 'renderer_visibility' in row]
        self.assertEqual(len(variants), 1)
        variant = variants[0]
        self.assertEqual(variant, {'os':'macos-15', 'product':'firefox', 'version':'153.5.0esr',
                                  'id':'firefox-153.5.0esr-masked-renderer', 'renderer_visibility':'masked'})
        self.assertEqual([row for row in self.rows['native']['include'] if 'renderer_visibility' not in row],
                         baseline['native']['include'])
        for change in ({'os':'unknown'}, {'source_id':'unknown'}, {'renderer_visibility':'unmasked'}, {'extra':True}):
            manifest = copy.deepcopy(self.manifest)
            manifest['native_variants'][0].update(change)
            with self.assertRaises(ValueError):
                matrix.expand(manifest)
        duplicate = copy.deepcopy(self.manifest)
        duplicate['native_variants'] *= 2
        with self.assertRaisesRegex(ValueError, 'unique rows'):
            matrix.expand(duplicate)

    def test_additional_targets_reject_unknown_sources_targets_and_duplicates(self):
        changes = [
            ('source_platform', 'unknown', 'known source'),
            ('browser', ['firefox-999-desktop'], 'Unknown or ambiguous'),
            ('native', ['waterfox-0.0'], 'Unknown or ambiguous'),
            ('browser', ['firefox-153.0-pw1.62.1-desktop'] * 2, 'unique rows'),
            ('native', ['waterfox-6.7.6'] * 2, 'unique rows'),
            ('architecture', 'unknown', 'metadata is invalid'),
        ]
        for key, value, error in changes:
            with self.subTest(key=key, value=value):
                manifest = copy.deepcopy(self.manifest)
                manifest['additional_targets']['macos-15-intel'][key] = value
                with self.assertRaisesRegex(ValueError, error):
                    matrix.expand(manifest)
        manifest = copy.deepcopy(self.manifest)
        manifest['additional_targets']['macos-15'] = manifest['additional_targets'].pop('macos-15-intel')
        with self.assertRaisesRegex(ValueError, 'distinct platform'):
            matrix.expand(manifest)

    def test_npm_locks_use_only_exact_integrity_pinned_dependencies(self):
        for version, toolchain in self.manifest['playwright'].items():
            package, lock = setup.lockfile(version, toolchain)
            self.assertEqual(package['dependencies'], {'playwright': version})
            self.assertEqual(lock['packages']['node_modules/playwright']['dependencies'], {'playwright-core': version})
            for name, entry in lock['packages'].items():
                if not name:
                    continue
                self.assertTrue(entry['resolved'].startswith('https://registry.npmjs.org/'))
                self.assertRegex(entry['integrity'], r'^sha512-')
                self.assertNotIn('scripts', entry)

    def test_installed_browser_metadata_drift_fails(self):
        version = self.manifest['current_playwright']
        toolchain = self.manifest['playwright'][version]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            for name in ('playwright', 'playwright-core'):
                destination = output / 'node_modules' / name
                destination.mkdir(parents=True)
                (destination / 'package.json').write_text(json.dumps({'version': version}))
            browsers = [{'name': name, 'browserVersion': metadata['version'], 'revision': metadata['revision']}
                        for name, metadata in toolchain['browsers'].items()]
            destination = output / 'node_modules/playwright-core/browsers.json'
            destination.write_text(json.dumps({'browsers': browsers}))
            setup.validate_installed(output, version, toolchain)
            browsers[0]['browserVersion'] = '999.0'
            destination.write_text(json.dumps({'browsers': browsers}))
            with self.assertRaisesRegex(ValueError, 'metadata does not match'):
                setup.validate_installed(output, version, toolchain)

    def test_chrome_archive_rejects_traversal_and_escaping_links(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'browser.zip'
            for name in ('../outside', '/absolute', 'C:/absolute', 'dir\\outside'):
                with self.subTest(name=name):
                    with zipfile.ZipFile(archive, 'w') as output:
                        output.writestr(name, 'bad')
                    with self.assertRaises(ValueError):
                        chrome.validate_archive(archive)
            link = zipfile.ZipInfo('browser/link')
            link.external_attr = (stat.S_IFLNK | 0o777) << 16
            with zipfile.ZipFile(archive, 'w') as output:
                output.writestr(link, '../../outside')
            with self.assertRaisesRegex(ValueError, 'Escaping link'):
                chrome.validate_archive(archive)

    def test_chrome_installer_checks_hash_before_extracting_and_preserves_executable(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, 'w') as archive:
            binary = zipfile.ZipInfo('chrome-linux64/chrome')
            binary.external_attr = (stat.S_IFREG | 0o755) << 16
            archive.writestr(binary, 'synthetic executable')
        payload = data.getvalue()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / 'manifest.json'
            entry = {'url': 'https://example.invalid/chrome.zip', 'sha256': '0' * 64}
            contents = {'chrome_for_testing': {'versions': {'123.0': {'linux64': entry}}}}
            manifest.write_text(json.dumps(contents))
            with mock.patch.object(chrome, 'MANIFEST', manifest), \
                    mock.patch.object(chrome, 'platform_key', return_value='linux64'), \
                    mock.patch.object(chrome, 'open_download', side_effect=lambda *a, **kw: io.BytesIO(payload)):
                with self.assertRaisesRegex(ValueError, 'SHA-256'):
                    chrome.install('123.0', root / 'rejected')
                self.assertFalse((root / 'rejected/chrome-linux64').exists())
                entry['sha256'] = hashlib.sha256(payload).hexdigest()
                manifest.write_text(json.dumps(contents))
                with mock.patch('builtins.print'):
                    receipt = chrome.install('123.0', root / 'accepted')
                executable = Path(receipt['binary'])
                self.assertEqual(executable.read_text(), 'synthetic executable')
                if chrome.sys.platform != 'win32':
                    self.assertEqual(executable.stat().st_mode & 0o777, 0o755)
                with self.assertRaisesRegex(ValueError, 'must be empty'):
                    chrome.install('123.0', root / 'accepted')


if __name__ == '__main__':
    unittest.main()
