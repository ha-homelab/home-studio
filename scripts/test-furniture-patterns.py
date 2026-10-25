#!/usr/bin/env python3
"""Verify procedural pattern parity, validation, and baked export geometry."""
import ast
import copy
import importlib.util
import json
from pathlib import Path
import re
import struct
import subprocess
import sys
import tarfile
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from planner.furniture import (CATALOG, MODELS, PATTERNS, build_furniture_asset,
                               primitive, supports_furniture_pattern, validate_furniture_appearance)
from planner.project import compile_project, make_floor, validate_project

SPEC = importlib.util.spec_from_file_location('pattern_catalog_generator', ROOT / 'scripts/generate-furniture-catalog.py')
catalog_generator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(catalog_generator)
INSTALLER_SPEC = importlib.util.spec_from_file_location('pattern_installer', ROOT / 'scripts/install-home-assistant.py')
installer = importlib.util.module_from_spec(INSTALLER_SPEC)
sys.modules[INSTALLER_SPEC.name] = installer
INSTALLER_SPEC.loader.exec_module(installer)
BOX = {'shape': 'box', 'center': [0, .5, 0], 'size': [1, 1, 1], 'material': 'body', 'pattern_face': 'top'}


class FurniturePatternTests(unittest.TestCase):
    def setUp(self):
        self.model = MODELS['rug']
        self.parts = self.model['parts']
        self.model['parts'] = [copy.deepcopy(BOX)]
        self.item = {'type': self.model['type'], 'model_id': self.model['id']}

    def tearDown(self):
        self.model['parts'] = self.parts

    def assert_mesh_equal(self, actual, expected):
        for key in ('name', 'material', 'kind', 'indices'):
            self.assertEqual(actual[key], expected[key])
        for key in ('vertices', 'normals'):
            self.assertEqual(len(actual[key]), len(expected[key]))
            for point, other in zip(actual[key], expected[key]):
                for value, wanted in zip(point, other):
                    self.assertAlmostEqual(value, wanted, places=12)

    def test_javascript_geometry_coverage_and_python_parity(self):
        subprocess.run(['node', str(ROOT / 'scripts/test-furniture-patterns.mjs')], check=True)
        output = subprocess.check_output(['node', str(ROOT / 'scripts/test-furniture-patterns.mjs'), '--fixtures'])
        data = json.loads(output)
        self.assertEqual(data['patterns'], PATTERNS)
        self.assertEqual(len(data['fixtures']), 48)
        for fixture in data['fixtures']:
            with self.subTest(pattern=fixture['item']['pattern_id'], part=fixture['part']):
                self.model['parts'] = [fixture['part']]
                original = copy.deepcopy(fixture['item'])
                asset = build_furniture_asset(fixture['item'])
                self.assertEqual(fixture['item'], original)
                expected = fixture['asset']
                self.assertEqual(set(asset['materials']), set(expected['materials']))
                for material, color in asset['materials'].items():
                    for value, wanted in zip(color, expected['materials'][material]):
                        self.assertAlmostEqual(value, wanted, places=12)
                self.assertEqual(len(asset['meshes']), len(expected['meshes']))
                for mesh, other in zip(asset['meshes'], expected['meshes']):
                    self.assert_mesh_equal(mesh, other)

    def test_no_pattern_compatibility_palettes_and_same_color(self):
        for model in CATALOG['models']:
            item = {'type': model['type'], 'model_id': model['id']}
            asset = build_furniture_asset(item)
            self.assertEqual(build_furniture_asset({**item, 'pattern_id': 'none'}), asset)
            for index, part in enumerate(model['parts']):
                unmarked = {key: value for key, value in part.items() if key != 'pattern_face'}
                for key in ('vertices', 'normals'):
                    mesh=asset['meshes'][index]
                    self.assertEqual([mesh[key][i] for i in mesh['indices']], primitive(unmarked)[key])
        for style in CATALOG['styles']:
            item = {**self.item, 'style_id': style['id'], 'pattern_id': 'dots', 'color': '#A1B2C3'}
            asset = build_furniture_asset(item)
            self.assertEqual(asset['meshes'][0]['material'], 'furniture_a1b2c3')
            self.assertEqual(asset['meshes'][1]['material'], 'furniture_' + style['materials']['accent'][1:].lower())
            custom = build_furniture_asset({**item, 'pattern_color': '#D4E5F6'})
            self.assertEqual(custom['meshes'][1]['material'], 'furniture_d4e5f6')
            same_color = build_furniture_asset({**item, 'pattern_color': '#a1b2c3'})
            self.assertEqual(set(same_color['materials']), {'furniture_a1b2c3'})
            self.assertEqual(same_color['meshes'][0]['material'], same_color['meshes'][1]['material'])
            self.assertEqual([mesh['vertices'] for mesh in same_color['meshes']], [mesh['vertices'] for mesh in custom['meshes']])

    def test_validation_and_catalog_metadata(self):
        self.assertFalse(supports_furniture_pattern(None))
        self.assertTrue(supports_furniture_pattern(self.model))
        invalid = [{'pattern_id': value} for value in ('missing', '', None, 1, True, [], {})]
        invalid += [{'pattern_color': '#123456'}, {'pattern_id': 'none', 'pattern_color': '#123456'}]
        invalid += [{'pattern_id': 'dots', 'pattern_color': value}
                    for value in ('#fff', '#12345678', 'red', '', None, 1, True, [], {})]
        for patch in invalid:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                validate_furniture_appearance({**self.item, **patch})
        for patch in ({'pattern_id': 'dots'}, {'pattern_id': 'none'}, {'pattern_color': '#123456'}):
            with self.subTest(legacy=patch), self.assertRaises(ValueError):
                validate_furniture_appearance({'type': 'furniture', **patch})
        self.model['parts'] = [{key: value for key, value in BOX.items() if key != 'pattern_face'}]
        self.assertFalse(supports_furniture_pattern(self.model))
        with self.assertRaises(ValueError):
            build_furniture_asset({**self.item, 'pattern_id': 'dots'})
        for patch in ({'pattern_face': 'left'}, {'pattern_face': None}, {'pattern_face': []},
                      {'pattern_face': 'top', 'shape': 'sphere'}, {'pattern_face': 'front', 'shape': 'cylinder'}):
            with self.subTest(part=patch), self.assertRaises(ValueError):
                primitive({**BOX, **patch})
        valid = copy.deepcopy(CATALOG)
        valid['models'] = [copy.deepcopy(self.model)]
        valid['models'][0]['parts'] = [copy.deepcopy(BOX)]
        catalog_generator.validate_catalog(valid)
        for patch in ({'pattern_face': 'bottom'}, {'pattern_face': None},
                      {'shape': 'sphere'}, {'shape': 'cylinder'}, {'shape': 'ring'}):
            invalid = copy.deepcopy(valid)
            invalid['models'][0]['parts'][0].update(patch)
            with self.subTest(catalog_part=patch), self.assertRaises(ValueError):
                catalog_generator.validate_catalog(invalid)
        invalid = copy.deepcopy(valid)
        invalid['models'][0]['parts'] = [copy.deepcopy(BOX) for _ in range(4)]
        with self.assertRaisesRegex(ValueError, 'at most 3 patterned faces'):
            catalog_generator.validate_catalog(invalid)
        del valid['styles'][0]['materials']['accent']
        with self.assertRaisesRegex(ValueError, 'accent'):
            catalog_generator.validate_catalog(valid)

    def test_all_patterns_are_baked_into_all_exports(self):
        project = json.loads((ROOT / 'planner/example-home.json').read_text())
        project['floors'] = project['floors'][:1]
        floor = project['floors'][0]
        floor['items'] = []
        for index, pattern in enumerate(PATTERNS[1:]):
            floor['items'].append({**self.item, 'id': 'pattern_' + pattern['id'], 'name': pattern['label'],
                                   'pattern_id': pattern['id'], 'pattern_color': '#D4E5F6', 'color': '#A1B2C3',
                                   'style_id': 'ocean_blue', 'room': floor['rooms'][0]['id'],
                                   'position_m': {'x': 1.2 + index*.1, 'y': .1, 'z': 1.4 + index*.1},
                                   'dimensions_m': {'width': 1.3, 'height': .04, 'depth': .8},
                                   'rotation_deg': 37, 'entity_id': '', 'notes': ''})
        validate_project(project)
        expected, svg = make_floor(project, floor, None)
        self.assertIn('fill="#d4e5f6"', svg)
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'built'
            compile_project(project, output, ha_package=True)
            folder = output / floor['id']
            data = json.loads((folder / 'model-data.json').read_text())
            self.assertEqual(json.loads((output / 'project.json').read_text()), project)
            self.assertEqual(json.loads((folder / 'inventory.json').read_text())['items'], floor['items'])
            for item in floor['items']:
                self.assertEqual(data['object_assets'][item['id']]['meshes'], build_furniture_asset(item)['meshes'])
            html = (folder / 'index.html').read_text()
            viewer = json.loads(re.search(r'<script[^>]*id="modelData"[^>]*>(.*?)</script>', html, re.S).group(1))
            self.assertEqual(viewer, data)
            glb = (folder / (floor['id'] + '.glb')).read_bytes()
            length = struct.unpack_from('<I', glb, 12)[0]
            document = json.loads(glb[20:20+length])
            self.assertEqual(len(document['meshes']), len(expected['meshes']))
            # Compare resolved triangle corners, not storage-pool lengths:
            # physical exports independently share positions, UVs and normals.
            obj = (folder / (floor['id'] + '.obj')).read_text()
            pools = {'v': [], 'vt': [], 'vn': []}
            objects = []
            material = None
            for line in obj.splitlines():
                fields = line.split()
                if not fields:
                    continue
                if fields[0] in pools:
                    pools[fields[0]].append(tuple(map(float, fields[1:])))
                elif fields[0] == 'o':
                    objects.append({'name': fields[1], 'corners': []})
                elif fields[0] == 'usemtl':
                    material = fields[1]
                elif fields[0] == 'f':
                    self.assertEqual(len(fields), 4)
                    for corner in fields[1:]:
                        resolved = []
                        for token, key in zip(corner.split('/'), ('v', 'vt', 'vn')):
                            if not token:
                                resolved.append(None)
                                continue
                            index = int(token)
                            self.assertNotEqual(index, 0)
                            index = index - 1 if index > 0 else len(pools[key]) + index
                            self.assertTrue(0 <= index < len(pools[key]))
                            resolved.append(pools[key][index])
                        self.assertEqual(len(resolved), 3)
                        objects[-1]['corners'].append((material, *resolved))
            self.assertEqual([entry['name'] for entry in objects], [m['name'] for m in expected['meshes']])

            def glb_accessor(index):
                accessor = document['accessors'][index]
                view = document['bufferViews'][accessor['bufferView']]
                width = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[accessor['type']]
                code = {5121: 'B', 5123: 'H', 5125: 'I', 5126: 'f'}[accessor['componentType']]
                size = struct.calcsize('<' + code * width)
                offset = 20 + length + 8 + view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
                return [struct.unpack_from('<' + code * width, glb, offset + i * view.get('byteStride', size))
                        for i in range(accessor['count'])]

            self.assertTrue(any(a.get('byteOffset',0)>0 for a in document['accessors']))
            self.assertIn(5121,{document['accessors'][m['primitives'][0]['indices']]['componentType']
                                for m in document['meshes']})
            self.assertTrue(any('TANGENT' in m['primitives'][0]['attributes'] for m in document['meshes']))
            usda = (folder / (floor['id'] + '.usda')).read_text()
            usd_meshes = re.findall(r'(?ms)^def Mesh [^\n]+\{\n(.*?)^\}', usda)
            def usd_array(body, key):
                match = re.search(r'(?m)^' + re.escape(key) + r'\s*=\s*(\[[^\n]*?\])', body)
                self.assertIsNotNone(match, key)
                return ast.literal_eval(match.group(1))
            dae = ET.parse(folder / (floor['id'] + '.dae'))
            ns = {'c': 'http://www.collada.org/2005/11/COLLADASchema'}
            dae_meshes = dae.findall('.//c:library_geometries/c:geometry', ns)
            dae_ids = {node.get('id'): node for node in dae.iter() if node.get('id')}
            self.assertEqual(len(usd_meshes), len(expected['meshes']))
            self.assertEqual(len(dae_meshes), len(expected['meshes']))
            def vectors(actual, wanted, tolerance):
                self.assertEqual(len(actual), len(wanted))
                for point, target in zip(actual, wanted):
                    self.assertEqual(len(point), len(target))
                    for value, other in zip(point, target):
                        self.assertAlmostEqual(value, other, delta=tolerance)

            exported_materials = {m['name']: m for m in document['materials']}
            for mesh, glb_mesh, obj_mesh, dae_mesh, usd in zip(expected['meshes'], document['meshes'], objects, dae_meshes, usd_meshes):
                wanted_positions = [mesh['vertices'][i] for i in mesh['indices']]
                wanted_normals = [mesh['normals'][i] for i in mesh['indices']]
                z_up = lambda values: [(x, -z, y) for x, y, z in values]
                wanted_uv = [mesh['uv'][i] for i in mesh['indices']] if 'uv' in mesh else None
                self.assertEqual(len(obj_mesh['corners']), len(mesh['indices']))
                vectors([c[1] for c in obj_mesh['corners']], z_up(wanted_positions), 5.000001e-6)
                vectors([c[3] for c in obj_mesh['corners']], z_up(wanted_normals), 5.000001e-5)
                if wanted_uv is not None:
                    vectors([c[2] for c in obj_mesh['corners']], wanted_uv, 5.000001e-6)
                else:
                    self.assertTrue(all(c[2] is None for c in obj_mesh['corners']))
                for name in {c[0] for c in obj_mesh['corners']}:
                    self.assertEqual(exported_materials[name]['extras']['source_materials'], [mesh['material']])

                self.assertEqual(glb_mesh['extras']['source_mesh'], mesh['name'])
                primitive = glb_mesh['primitives'][0]
                indices = [v[0] for v in glb_accessor(primitive['indices'])]
                attributes = primitive['attributes']
                for key, wanted in (('POSITION', wanted_positions), ('NORMAL', wanted_normals)):
                    rows = glb_accessor(attributes[key])
                    vectors([rows[i] for i in indices], wanted, 1e-6)
                if wanted_uv is not None:
                    rows = glb_accessor(attributes['TEXCOORD_0'])
                    vectors([rows[i] for i in indices], [(u, 1-v) for u, v in wanted_uv], 1e-6)
                else:
                    self.assertNotIn('TEXCOORD_0', attributes)
                material = document['materials'][primitive['material']]
                self.assertEqual(material['extras']['source_materials'], [mesh['material']])
                vectors([material['pbrMetallicRoughness']['baseColorFactor']], [expected['materials'][mesh['material']]], 1e-12)

                self.assertIn('custom string sourceMesh=' + json.dumps(mesh['name']), usd)
                indices = usd_array(usd, 'int[] faceVertexIndices')
                self.assertEqual(usd_array(usd, 'int[] faceVertexCounts'), [3] * (len(mesh['indices']) // 3))
                for key, wanted in (('point3f[] points', wanted_positions), ('normal3f[] normals', wanted_normals)):
                    rows = usd_array(usd, key)
                    vectors([rows[i] for i in indices], wanted, 1e-6)
                if wanted_uv is not None:
                    rows = usd_array(usd, 'texCoord2f[] primvars:st')
                    vectors([rows[i] for i in indices], wanted_uv, 1e-6)
                self.assertIn('/Materials/' + material['name'] + '>', usd)

                self.assertEqual(dae_mesh.get('name'), mesh['name'])
                triangles = dae_mesh.findall('c:mesh/c:triangles', ns)
                self.assertEqual(len(triangles), 1)
                triangles = triangles[0]
                self.assertEqual(int(triangles.get('count')), len(mesh['indices']) // 3)
                inputs = triangles.findall('c:input', ns)
                raw = list(map(int, triangles.find('c:p', ns).text.split()))
                stride = max(int(node.get('offset')) for node in inputs) + 1
                decoded = {}
                for node in inputs:
                    source = dae_ids[node.get('source')[1:]]
                    if node.get('semantic') == 'VERTEX':
                        source = dae_ids[source.find('c:input', ns).get('source')[1:]]
                    accessor = source.find('c:technique_common/c:accessor', ns)
                    values = list(map(float, dae_ids[accessor.get('source')[1:]].text.split()))
                    width = int(accessor.get('stride'))
                    indices = raw[int(node.get('offset'))::stride]
                    decoded[(node.get('semantic'), node.get('set'))] = [values[i*width:(i+1)*width] for i in indices]
                vectors(decoded[('VERTEX', None)], z_up(wanted_positions), 1e-6)
                vectors(decoded[('NORMAL', None)], z_up(wanted_normals), 1e-6)
                if wanted_uv is not None:
                    # This controlled BOX fixture uses painted surfaces: the
                    # normal detail repeats every 0.04 metres. COLLADA bakes
                    # this scale into UV1; its untextured diffuse UV0 stays raw.
                    self.assertEqual(mesh['material_family'], 'painted')
                    vectors(decoded[('TEXCOORD', '0')], wanted_uv, 1e-6)
                    vectors(decoded[('TEXCOORD', '1')], [(u/.04, v/.04) for u, v in wanted_uv], 2e-6)
                instance = dae.find('.//c:instance_geometry[@url="#' + dae_mesh.get('id') + '"]', ns)
                binding = instance.find('.//c:instance_material[@symbol="' + triangles.get('material') + '"]', ns)
                self.assertEqual(binding.get('target'), '#' + material['name'])

            mtl = (folder / (floor['id'] + '.mtl')).read_text()
            for source_material in ('furniture_a1b2c3', 'furniture_d4e5f6'):
                matches = [m for m in document['materials'] if m['extras']['source_materials'] == [source_material]]
                self.assertEqual(len(matches), 1)
                name = matches[0]['name']
                self.assertIn('newmtl ' + name + '\n', mtl)
                self.assertIn('def Material "' + name + '"', usda)
                self.assertIsNotNone(dae.find(f'.//c:effect[@id="{name}_fx"]//c:color', ns))
            with tarfile.open(output / 'home-floorplan.tar.gz') as archive:
                path = 'custom_components/home_floorplan/assets/' + floor['id'] + '/model-data.json'
                self.assertEqual(json.load(archive.extractfile(path)), data)

    def test_patterned_density_stays_within_existing_installer_limits(self):
        # Use actual catalog geometry, not this class's isolated surface fixture.
        self.model['parts'] = self.parts
        supported = [model for model in CATALOG['models'] if supports_furniture_pattern(model)]
        for models in ([self.model] * 256, supported):
            with self.subTest(items=len(models)), tempfile.TemporaryDirectory() as temporary:
                project = json.loads((ROOT / 'planner/example-home.json').read_text())
                project['floors'] = project['floors'][:1]
                floor = project['floors'][0]
                floor['items'] = []
                for index, model in enumerate(models):
                    floor['items'].append({'id': f'pattern_density_{index}', 'name': model['label'], 'type': model['type'],
                                           'model_id': model['id'], 'style_id': model['default_style'], 'pattern_id': 'herringbone',
                                           'room': floor['rooms'][0]['id'], 'dimensions_m': dict(model['dimensions_m']),
                                           'position_m': {'x': 1.234+index/1000, 'y': 0, 'z': 2.345+index/1000},
                                           'rotation_deg': 37, 'entity_id': '', 'notes': ''})
                validate_project(project)
                output = Path(temporary).resolve() / 'built'
                compile_project(project, output, ha_package=True)
                for name in ('index.html', 'model-data.json'):
                    self.assertLess((output / floor['id'] / name).stat().st_size, installer.MAX_FILE_BYTES)
                config = Path(temporary).resolve() / 'config'
                config.mkdir()
                result = installer.install(output / 'home-floorplan.tar.gz', config)
                self.assertLess(result.total_bytes, installer.MAX_TOTAL_BYTES)
                data = json.loads((result.target / 'assets' / floor['id'] / 'model-data.json').read_text())
                self.assertEqual(data['inventory'], floor['items'])
                self.assertTrue(all(asset['meshes'][-1]['name'].startswith('pattern') for asset in data['object_assets'].values()))


if __name__ == '__main__':
    unittest.main()
