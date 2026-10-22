"""Offline archive preparation contracts; no privileged or network commands."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('ubuntu_apt', Path(__file__).with_name('prepare-ubuntu-apt.py'))
apt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(apt)
AZURE = 'http://azure.archive.ubuntu.com/ubuntu'
CANONICAL = 'https://archive.ubuntu.com/ubuntu'


class UbuntuArchiveTests(unittest.TestCase):
    def setUp(self):
        for context in (patch.dict(apt.os.environ, {'GITHUB_ACTIONS': 'true',
                'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_OS': 'Linux'}, clear=True),
                patch.object(apt.sys, 'platform', 'linux'),
                patch.object(apt.platform, 'freedesktop_os_release', return_value={'ID': 'ubuntu'})):
            context.start()
            self.addCleanup(context.stop)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        (self.root / 'sources.list.d').mkdir()

    def prepare(self):
        return apt.prepare(self.root, replace=lambda path, text: path.write_text(text, encoding='utf-8'))

    def test_deb822_and_list_keep_security_and_trust_settings_exact(self):
        fixtures = {
            'sources.list': f'deb [signed-by=/key.gpg] {AZURE}/ noble main restricted\n'
                            'deb https://security.ubuntu.com/ubuntu noble-security main\n',
            'sources.list.d/ubuntu.sources': f'Types: deb\nURIs: {AZURE}\n'
                    'Suites: resolute resolute-updates\nComponents: main universe\n'
                    'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n',
            'sources.list.d/vendor.list': 'deb https://packages.microsoft.com/repos/code stable main\n',
        }
        for name, text in fixtures.items():
            (self.root / name).write_text(text)
        result = self.prepare()
        self.assertEqual(result['status'], 'prepared')
        self.assertEqual(len(result['files']), 2)
        for name, text in fixtures.items():
            self.assertEqual((self.root / name).read_text(), text.replace(AZURE, CANONICAL))
        self.assertEqual(self.prepare()['status'], 'unchanged')

    def test_mirror_file_is_rewritten_without_replacing_indirection_or_fallbacks(self):
        source = 'Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble\nComponents: main\n'
        (self.root / 'sources.list.d/ubuntu.sources').write_text(source)
        mirrors = f'{AZURE}/\nhttps://archive.ubuntu.com/ubuntu/\nhttps://security.ubuntu.com/ubuntu/\n'
        (self.root / 'apt-mirrors.txt').write_text(mirrors)
        self.prepare()
        self.assertEqual((self.root / 'sources.list.d/ubuntu.sources').read_text(), source)
        self.assertEqual((self.root / 'apt-mirrors.txt').read_text(), mirrors.replace(AZURE, CANONICAL))

    def test_only_exact_active_archive_urls_change(self):
        text = (f'# {AZURE}\nhttps://azure.archive.ubuntu.com/ubuntu\n'
                f'deb {AZURE} noble main # {AZURE}\n'
                'http://azure.archive.ubuntu.com.example/ubuntu\n'
                'http://azure.archive.ubuntu.com/ubuntu-other\n'
                'http://azure.archive.ubuntu.com/ubuntu?unexpected=1\n'
                'http://user@azure.archive.ubuntu.com/ubuntu\n')
        expected = text.replace('https://azure.archive.ubuntu.com/ubuntu\n', CANONICAL + '\n')
        expected = expected.replace(f'deb {AZURE} noble', f'deb {CANONICAL} noble')
        self.assertEqual(apt.rewrite_archive(text), expected)

    def test_all_host_indicators_required_before_read_or_write(self):
        for key, invalid in [('GITHUB_ACTIONS', 'false'), ('RUNNER_ENVIRONMENT', 'self-hosted'),
                             ('RUNNER_OS', 'macOS')]:
            for value in ('', invalid):
                with self.subTest(key=key, value=value), patch.dict(apt.os.environ, {key: value}), \
                        patch.object(apt, 'source_paths') as sources, self.assertRaises(ValueError):
                    apt.prepare(self.root)
                sources.assert_not_called()
        for context in (patch.object(apt.sys, 'platform', 'darwin'),
                        patch.object(apt.platform, 'freedesktop_os_release', return_value={'ID': 'debian'})):
            with context, patch.object(apt, 'source_paths') as sources, self.assertRaises(ValueError):
                apt.prepare(self.root)
            sources.assert_not_called()

    def test_symlink_is_rejected_before_any_write(self):
        (self.root / 'sources.list').write_text(f'deb {AZURE} noble main\n')
        (self.root / 'sources.list.d/unsafe.list').symlink_to(self.root / 'sources.list')
        with self.assertRaises(ValueError), patch.object(apt, 'replace_source') as replace:
            apt.prepare(self.root, replace=replace)
        replace.assert_not_called()

    def test_copy_command_is_fixed_and_bounded(self):
        target = self.root / 'sources.list'
        with patch.object(apt.subprocess, 'run') as run:
            apt.replace_source(target, CANONICAL)
        args, kwargs = run.call_args
        self.assertEqual(args[0][:4], ['/usr/bin/sudo', '-n', '/usr/bin/cp', '--'])
        self.assertEqual(args[0][-1], str(target))
        self.assertTrue(kwargs['check'])
        self.assertEqual(kwargs['timeout'], 15)
        self.assertEqual(kwargs['stdout'], subprocess.DEVNULL)

    def test_writer_rechecks_host_gate(self):
        with patch.dict(apt.os.environ, {'RUNNER_ENVIRONMENT': 'self-hosted'}), \
                patch.object(apt.subprocess, 'run') as run, self.assertRaises(ValueError):
            apt.replace_source(self.root / 'sources.list', CANONICAL)
        run.assert_not_called()

    def test_failed_write_is_not_reported_prepared(self):
        (self.root / 'sources.list').write_text(f'deb {AZURE} noble main\n')
        with self.assertRaises(RuntimeError):
            apt.prepare(self.root, replace=lambda path, text: None)


if __name__ == '__main__':
    unittest.main()
