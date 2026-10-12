#!/usr/bin/env python3
"""Exercise the downloadable package without a private checkout or HA server."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('installer', ROOT / 'scripts/install-home-assistant.py')
installer = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = installer
spec.loader.exec_module(installer)


class DistributionTests(unittest.TestCase):
    def test_compile_and_install_own_project(self):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary).resolve()
            project = work / 'project.json'
            document = json.loads((ROOT / 'planner/example-home.json').read_text())
            document['title'] = 'A different home'
            project.write_text(json.dumps(document))
            built = work / 'built'
            subprocess.run([sys.executable, str(ROOT / 'scripts/build-planner-project.py'),
                            '--project', str(project), '--output', str(built), '--ha-package'], check=True,
                           stdout=subprocess.DEVNULL)
            archive = built / 'home-floorplan.tar.gz'
            package = installer.read_package(archive)
            self.assertIs(package.site['site_features'], False)
            self.assertIn('LICENSE', package.files)
            self.assertIn('THREE-LICENSE.txt', package.files)
            self.assertIn(b'Permission is hereby granted', bytes(package.files['THREE-LICENSE.txt']))
            python_files = {name for name in package.files if name.endswith('.py')}
            self.assertEqual(python_files, {'__init__.py', 'site.py', 'validation.py', 'curtains.py'})
            # A generic archive must not silently activate optional household services.
            self.assertNotIn('private_site.py', package.files)
            self.assertNotIn('private_site_config.py', package.files)
            self.assertNotIn('access.py', package.files)
            self.assertNotIn('tv.py', package.files)
            config = work / 'config'; config.mkdir()
            yaml = config / 'configuration.yaml'; yaml.write_text('default_config:\n')
            storage = config / '.storage'; storage.mkdir()
            (storage / 'existing').write_text('keep')
            command = [sys.executable, str(ROOT / 'scripts/install-home-assistant.py'),
                       str(archive), '--config', str(config)]
            subprocess.run(command + ['--dry-run'], check=True, stdout=subprocess.DEVNULL)
            self.assertFalse((config / 'custom_components').exists())
            subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
            component = config / 'custom_components/home_floorplan'
            self.assertEqual(json.loads((component / 'site.json').read_text()), package.site)
            self.assertEqual(yaml.read_text(), 'default_config:\n')
            self.assertEqual((storage / 'existing').read_text(), 'keep')
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
            subprocess.run(command + ['--replace'], check=True, stdout=subprocess.DEVNULL)
            self.assertEqual(len(list((config / '.home-studio-backups').iterdir())), 1)
            with tarfile.open(archive) as contents:
                for member in contents:
                    self.assertTrue(member.name.startswith('custom_components/home_floorplan/'))


if __name__ == '__main__':
    unittest.main()
