#!/usr/bin/env python3
"""Check browser/compiler geometry parity and the complete furniture export path."""
import copy
import base64
import importlib.util
import json
import math
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from planner.furniture import CATALOG, build_furniture_asset
from planner.project import ProjectError, compile_project, make_floor, validate_project

spec = importlib.util.spec_from_file_location('furniture_installer', ROOT / 'scripts/install-home-assistant.py')
installer = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = installer
spec.loader.exec_module(installer)


def fixture_project():
    project = json.loads((ROOT / 'planner/example-home.json').read_text())
    project['floors'] = project['floors'][:1]
    project['floors'][0]['items'] = []
    return project


def fixture_item(model, room):
    return {'id': 'sample_' + model['id'], 'name': model['label'], 'type': model['type'],
            'model_id': model['id'], 'style_id': 'warm_wood', 'color': '#A1B2C3', 'room': room,
            'position_m': {'x': 3, 'y': .1, 'z': 2}, 'dimensions_m': dict(model['dimensions_m']),
            'rotation_deg': 37, 'entity_id': '', 'notes': ''}


class FurnitureTests(unittest.TestCase):
    def test_catalog_generation_and_javascript_validation(self):
        subprocess.run([sys.executable, str(ROOT / 'scripts/generate-furniture-catalog.py'), '--check'], check=True)
        subprocess.run(['node', str(ROOT / 'scripts/test-furniture.mjs')], check=True)

    def test_javascript_python_geometry_parity(self):
        output = subprocess.check_output(['node', str(ROOT / 'scripts/test-furniture.mjs'), '--fixtures'])
        fixtures = json.loads(output)
        self.assertEqual(len(fixtures), len(CATALOG['models']))
        for fixture in fixtures:
            with self.subTest(model=fixture['item']['model_id']):
                actual = build_furniture_asset(fixture['item'])
                expected = fixture['asset']
                self.assertEqual(actual.keys(), expected.keys())
                self.assertEqual(actual['materials'].keys(), expected['materials'].keys())
                for key, rgba in actual['materials'].items():
                    for value, browser_value in zip(rgba, expected['materials'][key]):
                        self.assertAlmostEqual(value, browser_value, places=12)
                self.assertEqual(len(actual['meshes']), len(expected['meshes']))
                for mesh, browser_mesh in zip(actual['meshes'], expected['meshes']):
                    for key in ('name', 'indices', 'material', 'kind'):
                        self.assertEqual(mesh[key], browser_mesh[key])
                    for key in ('vertices', 'normals'):
                        self.assertEqual(len(mesh[key]), len(browser_mesh[key]))
                        for point, browser_point in zip(mesh[key], browser_mesh[key]):
                            for value, browser_value in zip(point, browser_point):
                                self.assertAlmostEqual(value, browser_value, places=12)

    def test_validation_legacy_and_invalid_appearance(self):
        legacy = json.loads((ROOT / 'planner/example-home.json').read_text())
        self.assertEqual(validate_project(legacy), legacy)
        self.assertIsNone(build_furniture_asset(legacy['floors'][0]['items'][0]))
        project = fixture_project()
        item = fixture_item(CATALOG['models'][0], project['floors'][0]['rooms'][0]['id'])
        project['floors'][0]['items'] = [item]
        self.assertEqual(validate_project(project), project)
        for patch in ({'model_id': 'unknown'}, {'model_id': None}, {'model_id': {}},
                      {'style_id': 'unknown'}, {'style_id': None}, {'style_id': []},
                      {'color': '#fff'}, {'color': '#12345678'}, {'color': 'red'}, {'color': 1},
                      {'color': None}, {'type': 'sensor'}):
            with self.subTest(patch=patch), self.assertRaises(ProjectError):
                invalid = copy.deepcopy(project)
                invalid['floors'][0]['items'][0].update(patch)
                validate_project(invalid)
        for key, value in (('style_id', 'contemporary'), ('color', '#aabbcc')):
            invalid = copy.deepcopy(legacy)
            invalid['floors'][0]['items'][0][key] = value
            with self.assertRaises(ProjectError):
                validate_project(invalid)

    def test_all_models_compile_to_matching_transforms_and_assets(self):
        project = fixture_project()
        floor = project['floors'][0]
        floor['items'] = [fixture_item(model, floor['rooms'][0]['id']) for model in CATALOG['models']]
        validate_project(project)
        original = copy.deepcopy(project)
        data, svg = make_floor(project, floor, None)
        self.assertEqual(project, original)
        self.assertEqual(len(data['object_assets']), len(floor['items']))
        self.assertIn('fill="#a1b2c3"', svg)
        for item in floor['items']:
            normalized = build_furniture_asset(item)
            self.assertEqual(data['object_assets'][item['id']]['model_id'], item['model_id'])
            self.assertEqual(data['object_assets'][item['id']]['meshes'], normalized['meshes'])
            meshes = [mesh for mesh in data['meshes'] if mesh.get('item_id') == item['id']]
            self.assertEqual(len(meshes), len(normalized['meshes']))
            angle = math.radians(item['rotation_deg'])
            for mesh, part in zip(meshes, normalized['meshes']):
                self.assertEqual(mesh['material'], part['material'])
                for point, local in zip(mesh['vertices'], part['vertices']):
                    x, y, z = local
                    d, p = item['dimensions_m'], item['position_m']
                    expected = [p['x'] + math.cos(angle)*x*d['width'] + math.sin(angle)*z*d['depth'],
                                p['y'] + y*d['height'],
                                p['z'] - math.sin(angle)*x*d['width'] + math.cos(angle)*z*d['depth']]
                    for value, want in zip(point, expected):
                        self.assertAlmostEqual(value, want, places=10)
                self.assertTrue(all(abs(math.sqrt(sum(v*v for v in n)) - 1) < 1e-10 for n in mesh['normals']))

    def test_every_export_preserves_geometry_colors_and_inventory(self):
        project = fixture_project()
        floor = project['floors'][0]
        # A nonuniformly scaled, rotated sofa and a cylinder-based table cover
        # both primitive implementations and independent material overrides.
        chosen = [next(model for model in CATALOG['models'] if model['id'] == name)
                  for name in ('sofa_2', 'round_dining_table')]
        floor['items'] = [fixture_item(model, floor['rooms'][0]['id']) for model in chosen]
        floor['items'][0]['entity_id'] = 'light.example'
        floor['items'][0]['dimensions_m'] = {'width': 2.13, 'height': .91, 'depth': 1.02}
        floor['items'][1]['color'] = '#e7513d'
        export_data, _ = make_floor(project, floor, None)
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'built'
            compile_project(project, output, ha_package=True)
            folder = output / floor['id']
            data = json.loads((folder / 'model-data.json').read_text())
            self.assertEqual(json.loads((output / 'project.json').read_text()), project)
            self.assertEqual(json.loads((folder / 'inventory.json').read_text())['items'], floor['items'])
            html = (folder / 'index.html').read_text()
            plan_payload = re.search(r'data:image/svg\+xml;base64,([^"\s]+)', html).group(1)
            self.assertNotIn('<g id="furniture">', base64.b64decode(plan_payload).decode())
            self.assertIn('<g id="furniture">', (folder / 'plan.svg').read_text())
            model_json = re.search(r'<script[^>]*id="modelData"[^>]*>(.*?)</script>', html, re.S).group(1)
            viewer = json.loads(model_json)
            self.assertEqual(viewer['inventory'], floor['items'])
            self.assertEqual(viewer['object_assets'], data['object_assets'])
            self.assertEqual(viewer, data)
            self.assertFalse(any(mesh['kind'] == 'inventory' for mesh in viewer['meshes']))
            glb = (folder / (floor['id'] + '.glb')).read_bytes()
            length = struct.unpack_from('<I', glb, 12)[0]
            document = json.loads(glb[20:20 + length])
            self.assertEqual(len(document['meshes']), len(export_data['meshes']))
            self.assertEqual(document['extras']['units'], 'metres')
            materials = {entry['name']: entry['pbrMetallicRoughness']['baseColorFactor'] for entry in document['materials']}
            for color in ('furniture_a1b2c3', 'furniture_e7513d'):
                self.assertEqual(materials[color], data['materials'][color])
                self.assertIn('newmtl ' + color, (folder / (floor['id'] + '.mtl')).read_text())
            obj = (folder / (floor['id'] + '.obj')).read_text()
            usda = (folder / (floor['id'] + '.usda')).read_text()
            dae = ET.parse(folder / (floor['id'] + '.dae'))
            ns = {'c': 'http://www.collada.org/2005/11/COLLADASchema'}
            dae_meshes = dae.findall('.//c:library_geometries/c:geometry', ns)
            self.assertEqual(len(dae_meshes), len(export_data['meshes']))
            obj_vertices = [float(value) for line in obj.splitlines() if line.startswith('v ') for value in line[2:].split()]
            z_up_vertices = [value for mesh in export_data['meshes'] for x, y, z in mesh['vertices'] for value in (x, -z, y)]
            self.assertEqual(len(obj_vertices), len(z_up_vertices))
            for value, want in zip(obj_vertices, z_up_vertices):
                self.assertAlmostEqual(value, want, places=6)
            usd_points = re.findall(r'point3f\[\] points = \[(.*?)\]', usda)
            self.assertEqual(len(usd_points), len(export_data['meshes']))
            for mesh, dae_mesh, usd_point_text in zip(export_data['meshes'], dae_meshes, usd_points):
                actual = [float(value) for value in dae_mesh.find('.//c:float_array', ns).text.split()]
                expected = [value for x, y, z in mesh['vertices'] for value in (x, -z, y)]
                self.assertEqual(len(actual), len(expected))
                for value, want in zip(actual, expected):
                    self.assertAlmostEqual(value, want, places=6)
                usd_vertices = [float(value) for value in re.findall(r'-?\d+\.\d+', usd_point_text)]
                expected = [value for point in mesh['vertices'] for value in point]
                self.assertEqual(len(usd_vertices), len(expected))
                for value, want in zip(usd_vertices, expected):
                    self.assertAlmostEqual(value, want, places=6)
            for color in ('furniture_a1b2c3', 'furniture_e7513d'):
                effect = dae.find(f'.//c:effect[@id="{color}-fx"]//c:color', ns)
                self.assertEqual([float(value) for value in effect.text.split()], data['materials'][color])
                self.assertIn('def Material "' + color + '"', usda)
            for mesh in export_data['meshes']:
                self.assertIn('o ' + mesh['name'] + '\n', obj)
                self.assertIn('def Mesh "' + mesh['name'] + '"', usda)
            # Inspect actual GLB position buffer bytes, not just node names.
            binary_offset = 20 + length + 8
            for mesh, exported in zip(export_data['meshes'], document['meshes']):
                accessor = document['accessors'][exported['primitives'][0]['attributes']['POSITION']]
                view = document['bufferViews'][accessor['bufferView']]
                values = struct.unpack_from('<' + 'f' * (accessor['count'] * 3), glb, binary_offset + view['byteOffset'])
                expected = [value for point in mesh['vertices'] for value in point]
                self.assertEqual(len(values), len(expected))
                for value, want in zip(values, expected):
                    self.assertAlmostEqual(value, want, places=5)
            with tarfile.open(output / 'home-floorplan.tar.gz') as package:
                name = 'custom_components/home_floorplan/assets/' + floor['id'] + '/model-data.json'
                self.assertEqual(json.load(package.extractfile(name)), data)

    def test_maximum_density_floor_builds_and_installs_with_safety_limits(self):
        project = fixture_project()
        floor = project['floors'][0]
        plant = next(model for model in CATALOG['models'] if model['id'] == 'plant')
        vertex_counts = {model['id']: sum(len(part['vertices']) for part in build_furniture_asset(
            {'model_id': model['id'], 'type': model['type']})['meshes']) for model in CATALOG['models']}
        self.assertEqual(vertex_counts['plant'], max(vertex_counts.values()))
        # Plants have the most vertices in the catalog. Distinct positions and
        # rotation reproduce the long float strings that exceeded 32 MiB.
        for index in range(256):
            item = fixture_item(plant, floor['rooms'][0]['id'])
            item.update(id=f'plant_{index}', style_id=plant['default_style'])
            del item['color']
            item['position_m'] = {'x': 1.234 + index / 1000, 'y': 0, 'z': 2.345 + index / 1000}
            floor['items'].append(item)
        validate_project(project)
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'built'
            compile_project(project, output, ha_package=True)
            folder = output / floor['id']
            for name in ('model-data.json', 'index.html'):
                self.assertLess((folder / name).stat().st_size, installer.MAX_FILE_BYTES)
            data = json.loads((folder / 'model-data.json').read_text())
            self.assertEqual(data['inventory'], floor['items'])
            self.assertEqual(len(data['object_assets']), 256)
            self.assertFalse(any(mesh['kind'] == 'inventory' for mesh in data['meshes']))
            html = (folder / 'index.html').read_text()
            viewer = json.loads(re.search(r'<script[^>]*id="modelData"[^>]*>(.*?)</script>', html, re.S).group(1))
            self.assertEqual(viewer, data)
            config = Path(temporary).resolve() / 'config'
            config.mkdir()
            result = installer.install(output / 'home-floorplan.tar.gz', config)
            self.assertLess(result.total_bytes, installer.MAX_TOTAL_BYTES)
            installed = json.loads((result.target / 'assets' / floor['id'] / 'model-data.json').read_text())
            self.assertEqual(installed, data)
            glb = (folder / (floor['id'] + '.glb')).read_bytes()
            length = struct.unpack_from('<I', glb, 12)[0]
            document = json.loads(glb[20:20 + length])
            furniture_nodes = [node for node in document['nodes'] if node['extras']['category'] == 'inventory']
            self.assertEqual(len(furniture_nodes), 256 * len(plant['parts']))

    def test_user_ids_cannot_collide_with_generated_mesh_names(self):
        project = fixture_project()
        floor = project['floors'][0]
        chair = next(model for model in CATALOG['models'] if model['id'] == 'dining_chair')
        catalog_item = fixture_item(chair, floor['rooms'][0]['id'])
        catalog_item['id'] = 'chair'
        legacy_item = {key: value for key, value in catalog_item.items() if key not in ('model_id', 'style_id', 'color')}
        legacy_item['id'] = 'chair_part_0'
        floor['items'] = [catalog_item, legacy_item]
        validate_project(project)
        data, _ = make_floor(project, floor, None)
        names = [mesh['name'] for mesh in data['meshes']]
        self.assertEqual(len(names), len(set(names)))
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'built'
            compile_project(project, output)
            usda = output / floor['id'] / (floor['id'] + '.usda')
            prim_names = re.findall(r'def Mesh "([^"]+)"', usda.read_text())
            self.assertEqual(len(prim_names), len(set(prim_names)))
            if usdcat := shutil.which('usdcat'):
                subprocess.run([usdcat, str(usda), '--out', str(Path(temporary) / 'checked.usda')], check=True)


if __name__ == '__main__':
    unittest.main()
