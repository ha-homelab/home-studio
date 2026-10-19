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
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from planner.project import compile_project, load_project

spec = importlib.util.spec_from_file_location('installer', ROOT / 'scripts/install-home-assistant.py')
installer = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = installer
spec.loader.exec_module(installer)


class DistributionTests(unittest.TestCase):
    def test_compile_and_install_own_project(self):
        with tempfile.TemporaryDirectory(prefix='home studio-é-') as temporary:
            work = Path(temporary).resolve()
            project = work / 'project.json'
            document = json.loads((ROOT / 'planner/example-home.json').read_text(encoding='utf-8'))
            document['title'] = 'Maison été — 家'
            document['floors'][0]['name'] = 'Étage principal — 居間'
            project.write_text(json.dumps(document, ensure_ascii=False), encoding='utf-8')
            built = work / 'compiled floorplan'
            subprocess.run([sys.executable, str(ROOT / 'scripts/build-planner-project.py'),
                            '--project', str(project), '--output', str(built), '--ha-package'], check=True,
                           stdout=subprocess.DEVNULL)
            archive = built / 'home-floorplan.tar.gz'
            package = installer.read_package(archive)
            self.assertEqual(package.site['floors']['main']['title'], document['floors'][0]['name'])
            self.assertEqual(json.loads((built / 'project.json').read_text(encoding='utf-8')), document)
            self.assertIn(document['floors'][0]['name'], bytes(package.files['assets/main/index.html']).decode('utf-8'))
            self.assertIs(package.site['site_features'], False)
            self.assertIn('LICENSE', package.files)
            self.assertIn('THREE-LICENSE.txt', package.files)
            self.assertIn('static/card.js', package.files)
            self.assertEqual(bytes(package.files['static/card.js']),
                             (ROOT / 'custom_components/home_floorplan/static/card.js').read_bytes())
            self.assertIn(b'Permission is hereby granted', bytes(package.files['THREE-LICENSE.txt']))
            python_files = {name for name in package.files if name.endswith('.py')}
            self.assertEqual(python_files, {'__init__.py', 'site.py', 'validation.py', 'curtains.py',
                                            'native.py', 'permissions.py', 'config_flow.py'})
            # A generic archive must not silently activate optional household services.
            self.assertNotIn('private_site.py', package.files)
            self.assertNotIn('private_site_config.py', package.files)
            self.assertNotIn('access.py', package.files)
            self.assertNotIn('tv.py', package.files)
            config = work / 'Home Assistant config'; config.mkdir()
            yaml = config / 'configuration.yaml'; yaml.write_text('default_config:\n')
            storage = config / '.storage'; storage.mkdir()
            (storage / 'existing').write_text('keep')
            command = [sys.executable, str(ROOT / 'scripts/install-home-assistant.py'),
                       str(archive), '--config', str(config)]
            subprocess.run(command + ['--dry-run'], check=True, stdout=subprocess.DEVNULL)
            self.assertFalse((config / 'custom_components').exists())
            subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
            component = config / 'custom_components/home_floorplan'
            self.assertEqual(json.loads((component / 'site.json').read_text(encoding='utf-8')), package.site)
            self.assertEqual(yaml.read_text(), 'default_config:\n')
            self.assertEqual((storage / 'existing').read_text(), 'keep')
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
            subprocess.run(command + ['--replace'], check=True, stdout=subprocess.DEVNULL)
            self.assertEqual(len(list((config / '.home-studio-backups').iterdir())), 1)
            with tarfile.open(archive) as contents:
                for member in contents:
                    self.assertTrue(member.name.startswith('custom_components/home_floorplan/'))
                    self.assertNotIn('\\', member.name)

    def test_compile_utf8_assets_with_legacy_default_encoding(self):
        project = load_project(ROOT / 'planner/example-home.json')
        project['floors'][0]['name'] = 'Étage — 居間'
        original_open = Path.open

        def legacy_open(path, mode='r', buffering=-1, encoding=None, errors=None, newline=None):
            if 'b' not in mode and encoding in (None, 'locale'):
                encoding = 'cp1252'
            return original_open(path, mode, buffering, encoding, errors, newline)

        with tempfile.TemporaryDirectory(prefix='home studio-é-') as temporary:
            output = Path(temporary).resolve() / 'compiled floorplan'
            with patch.object(Path, 'open', legacy_open):
                furniture_spec = importlib.util.spec_from_file_location('portable_furniture', ROOT / 'planner/furniture.py')
                furniture = importlib.util.module_from_spec(furniture_spec)
                furniture_spec.loader.exec_module(furniture)
                compile_project(project, output, ha_package=True)
            self.assertEqual(furniture.CATALOG, json.loads((ROOT / 'planner/catalog.json').read_text(encoding='utf-8')))
            viewer = (output / 'main/index.html').read_text(encoding='utf-8')
            self.assertIn(project['floors'][0]['name'], viewer)
            self.assertIn('Русский', viewer)


if __name__ == '__main__':
    unittest.main()
