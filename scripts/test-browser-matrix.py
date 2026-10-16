#!/usr/bin/env python3
"""Test reviewed coverage and reject toolchain drift or unsafe browser archives."""
import importlib.util
import hashlib
import io
import json
import stat
import tempfile
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
        self.assertEqual(len(rows), 57)
        self.assertEqual(len(self.rows['native']['include']), 12)
        for matrix_rows in self.rows.values():
            identities = {(row['os'], row['id']) for row in matrix_rows['include']}
            self.assertEqual(len(identities), len(matrix_rows['include']))
        for os in ('ubuntu-24.04', 'windows-2022', 'macos-15'):
            platform_rows = [row for row in rows if row['os'] == os]
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
            native = {(row['product'], row['version']) for row in self.rows['native']['include'] if row['os'] == os}
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
                'firefox-153.5.0esr', 'waterfox-6.7.5', 'waterfox-6.7.6')],
        }
        for name, matrix_rows in self.rows.items():
            identities = [(row['os'], row['id']) for row in matrix_rows['include']]
            self.assertEqual(identities[:len(priority[name])], priority[name])
            remaining = identities[len(priority[name]):]
            targets = list(dict.fromkeys(target for _, target in remaining))
            expected = [(os, target) for target in targets for os in platforms
                        if (os, target) not in priority[name]]
            self.assertEqual(remaining, expected)
        self.assertEqual(self.rows, matrix.expand(self.manifest))

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
                    mock.patch.object(chrome.urllib.request, 'urlopen', side_effect=lambda *a, **kw: io.BytesIO(payload)):
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
