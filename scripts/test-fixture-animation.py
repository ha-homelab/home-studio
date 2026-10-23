#!/usr/bin/env python3
"""Fan/climate metadata survives browser assets, compilation and catalog validation."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from planner.furniture import CATALOG, build_furniture_asset
from planner.project import make_floor

spec = importlib.util.spec_from_file_location('fixture_catalog_generator', ROOT / 'scripts/generate-furniture-catalog.py')
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)


class FixtureAnimationTests(unittest.TestCase):
    def test_browser_compiler_metadata_and_placement_export(self):
        fixtures = json.loads(subprocess.check_output(['node', str(ROOT / 'scripts/test-fixture-animation.cjs'), '--fixtures']))
        for fixture in fixtures:
            model = fixture['model']
            with self.subTest(model=model['id']):
                project = json.loads((ROOT / 'planner/example-home.json').read_text())
                floor = project['floors'][0]
                item = dict(id='fixture', name=model['label'], type=model['type'], model_id=model['id'],
                            style_id=model['default_style'], room=floor['rooms'][0]['id'],
                            position_m=dict(x=2, y=model['elevation_m'], z=2), dimensions_m=model['dimensions_m'],
                            rotation_deg=37, entity_id='fan.fixture' if model['device_animation']['kind'] == 'fan' else 'climate.fixture', notes='')
                asset = build_furniture_asset(item)
                self.assertEqual(asset['device_animation'], fixture['asset']['device_animation'])
                self.assertEqual([m.get('fan_rotor', False) for m in asset['meshes']],
                                 [m.get('fan_rotor', False) for m in fixture['asset']['meshes']])
                floor['items'] = [item]
                data, _ = make_floor(project, floor, None)
                self.assertEqual(data['object_assets']['fixture']['device_animation'], asset['device_animation'])
                self.assertEqual(data['object_assets']['fixture']['meshes'], asset['meshes'])
                self.assertNotIn('device_animation', data['inventory'][0], 'Rendering metadata must not change portable item schema')

    def test_invalid_animation_metadata_is_rejected(self):
        model = next(m for m in CATALOG['models'] if m['id'] == 'standing_fan')
        patches = [None, {}, {'kind': 'script'}, {'airflow': None}, {'rotor': {'axis': 'w', 'pivot': [0, 0, 0]}},
                   {'rotor': {'axis': 'y', 'pivot': [0, float('nan'), 0]}},
                   {'airflow': {'origin': [0, 0, 0], 'direction': [0, 0, 0], 'width': 1, 'length': 1}},
                   {'airflow': {'origin': [0, 0, 0], 'direction': [0, 1, 0], 'width': 1, 'length': 100}}]
        for patch in patches:
            catalog = copy.deepcopy(CATALOG)
            catalog['models'] = [copy.deepcopy(model)]
            catalog['models'][0]['device_animation'] = patch if patch is None or patch == {} else {**model['device_animation'], **patch}
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                generator.validate_catalog(catalog)
        catalog = copy.deepcopy(CATALOG)
        catalog['models'][0]['parts'][0]['fan_rotor'] = True
        with self.assertRaises(ValueError):
            generator.validate_catalog(catalog)


if __name__ == '__main__':
    unittest.main()
