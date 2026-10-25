#!/usr/bin/env python3
"""Check browser/compiler geometry parity and the complete furniture export path."""
import copy
import base64
import hashlib
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
from planner.furniture import CATALOG, build_furniture_asset, primitive
from planner.project import ProjectError, compile_project, make_floor, validate_project

spec = importlib.util.spec_from_file_location('furniture_installer', ROOT / 'scripts/install-home-assistant.py')
installer = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = installer
spec.loader.exec_module(installer)
catalog_spec = importlib.util.spec_from_file_location('catalog_generator', ROOT / 'scripts/generate-furniture-catalog.py')
catalog_generator = importlib.util.module_from_spec(catalog_spec)
catalog_spec.loader.exec_module(catalog_generator)


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
    def assert_mesh_equal(self, actual, expected):
        self.assertEqual(actual['indices'], expected['indices'])
        for key in ('vertices', 'normals'):
            self.assertEqual(len(actual[key]), len(expected[key]))
            for point, browser_point in zip(actual[key], expected[key]):
                for value, browser_value in zip(point, browser_point):
                    self.assertAlmostEqual(value, browser_value, places=12)

    def test_standalone_primitives_and_rotation_match_javascript(self):
        output = subprocess.check_output(['node', str(ROOT / 'scripts/test-furniture.mjs'), '--primitive-fixtures'])
        for fixture in json.loads(output):
            with self.subTest(part=fixture['part']):
                self.assert_mesh_equal(primitive(fixture['part']), fixture['mesh'])
        ring = {'shape': 'ring', 'center': [0, .5, 0], 'size': [1, 1, 1]}
        self.assertEqual(primitive(ring), primitive({**ring, 'inner_ratio': .72}))
        for patch in ({'shape': 'unknown'}, {'center': None}, {'center': [0, 0]},
                      {'center': [0, math.inf, 0]}, {'center': [0, math.nan, 0]}, {'center': [0, True, 0]},
                      {'size': [0, 1, 1]}, {'size': [-1, 1, 1]}, {'size': [1, 1, '1']},
                      {'rotation_deg': [0, 0]}, {'rotation_deg': None}, {'rotation_deg': [0, math.nan, 0]},
                      {'shape': 'box', 'inner_ratio': .5},
                      *({'inner_ratio': value} for value in (0, 1, -.1, 1.1, None, True, math.nan, math.inf, '.5'))):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                primitive({**ring, **patch})
        with self.assertRaises(ValueError):
            primitive(None)

    def test_catalog_metadata_and_actual_rotated_bounds_validation(self):
        valid = copy.deepcopy(CATALOG)
        valid['models'] = valid['models'][:1]
        model = valid['models'][0]
        # The rotated sphere fits its exact mesh bounds although a rotated
        # bounding box would extend beyond the allowed normalized cube.
        model['parts'] = [{'shape': 'sphere', 'center': [0, .5, 0], 'size': [1, 1, 1],
                           'rotation_deg': [0, 0, 45], 'material': 'body'}]
        catalog_generator.validate_catalog(valid)
        for patch in ({'shape': 'box'}, {'center': [0, .6, 0]}, {'size': [1, math.inf, 1]},
                      {'size': [1, -1, 1]}, {'rotation_deg': [0, '45', 0]}, {'material': 'missing'},
                      {'shape': 'ring', 'inner_ratio': 1}):
            invalid = copy.deepcopy(valid)
            invalid['models'][0]['parts'][0].update(patch)
            with self.subTest(part=patch), self.assertRaises(ValueError):
                catalog_generator.validate_catalog(invalid)
        for patch in ({'id': 'Bad id'}, {'label': ''}, {'category': 'missing'}, {'type': 'unknown'},
                      {'default_style': 'missing'}, {'dimensions_m': {'width': 1, 'height': 1}},
                      {'dimensions_m': {'width': True, 'height': 1, 'depth': 1}},
                      {'elevation_m': math.nan}, {'tags': 'not-an-array'}, {'parts': []},
                      {'parts': model['parts'] * 33}):
            invalid = copy.deepcopy(valid)
            invalid['models'][0].update(patch)
            with self.subTest(model=patch), self.assertRaises(ValueError):
                catalog_generator.validate_catalog(invalid)
        for key in ('categories', 'styles', 'models'):
            invalid = copy.deepcopy(valid)
            invalid[key].append(copy.deepcopy(invalid[key][0]))
            with self.subTest(duplicate=key), self.assertRaises(ValueError):
                catalog_generator.validate_catalog(invalid)
        for invalid in (None, {}, {**valid, 'version': True}, {**valid, 'categories': {}}):
            with self.subTest(root=invalid), self.assertRaises(ValueError):
                catalog_generator.validate_catalog(invalid)
        invalid = copy.deepcopy(valid)
        invalid['styles'][0]['materials']['body'] = '#fff'
        with self.assertRaises(ValueError):
            catalog_generator.validate_catalog(invalid)

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
                    for key in ('name', 'material', 'kind', 'surface_finish', 'material_family'):
                        self.assertEqual(mesh[key], browser_mesh[key])
                    # Exact-tuple indexing may share a mathematically identical
                    # corner differently across libm implementations. Compare
                    # the complete ordered triangle stream, including UV seams.
                    self.assertEqual(len(mesh['indices']), len(browser_mesh['indices']))
                    for key in ('vertices', 'normals', 'uv'):
                        dimensions = next(model['dimensions_m'] for model in CATALOG['models'] if model['id'] == fixture['item']['model_id'])
                        precision = 2e-12 * (max(dimensions.values()) if key == 'uv' else 1)
                        for i, j in zip(mesh['indices'], browser_mesh['indices']):
                            for value, browser_value in zip(mesh[key][i], browser_mesh[key][j]):
                                self.assertLessEqual(abs(value-browser_value), precision, 'Authored corner attributes match within their declared precision')

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
                self.assertEqual(len(mesh['indices']), len(part['indices']))
                for world_index, local_index in zip(mesh['indices'], part['indices']):
                    point, local = mesh['vertices'][world_index], part['vertices'][local_index]
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
        # Include new compact shapes when catalog models use them, along with
        # legacy boxes and cylinders and independent material overrides.
        chosen = [next(model for model in CATALOG['models'] if model['id'] == name)
                  for name in ('sofa_2', 'round_dining_table')]
        for shape in ('sphere', 'ring', 'cone'):
            model = next((model for model in CATALOG['models']
                          if any(part['shape'] == shape for part in model['parts'])), None)
            if model and model not in chosen:
                chosen.append(model)
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
            materials = {source: entry['pbrMetallicRoughness']['baseColorFactor'] for entry in document['materials'] for source in entry['extras']['source_materials']}
            for color in ('furniture_a1b2c3', 'furniture_e7513d'):
                self.assertEqual(materials[color], data['materials'][color])
                self.assertIn('newmtl ' + color, (folder / (floor['id'] + '.mtl')).read_text())
            obj = (folder / (floor['id'] + '.obj')).read_text()
            usda = (folder / (floor['id'] + '.usda')).read_text()
            dae = ET.parse(folder / (floor['id'] + '.dae'))
            ns = {'c': 'http://www.collada.org/2005/11/COLLADASchema'}
            dae_meshes = dae.findall('.//c:library_geometries/c:geometry', ns)
            dae_ids = {node.get('id'): node for node in dae.iter() if node.get('id')}
            self.assertEqual(len(dae_meshes), len(export_data['meshes']))
            # OBJ pools are independently deduplicated and may use relative
            # indices. Compare ordered triangle corners rather than row counts.
            positions, normals, obj_groups = [], [], {}
            for line in obj.splitlines():
                fields = line.split()
                if not fields: continue
                if fields[0] == 'v': positions.append(tuple(map(float, fields[1:])))
                elif fields[0] == 'vn': normals.append(tuple(map(float, fields[1:])))
                elif fields[0] == 'o': group = []; obj_groups[line[2:]] = group
                elif fields[0] == 'f':
                    for corner in fields[1:]:
                        pi, _, ni = corner.split('/')
                        index = lambda value, pool: int(value) - 1 if int(value) > 0 else len(pool) + int(value)
                        group.append((positions[index(pi, positions)], normals[index(ni, normals)]))
            usd_points = re.findall(r'point3f\[\] points\s*=\s*\[(.*?)\]', usda)
            self.assertEqual(len(usd_points), len(export_data['meshes']))
            f32 = lambda value: struct.unpack('<f', struct.pack('<f', value))[0]
            for mesh, dae_mesh, usd_point_text in zip(export_data['meshes'], dae_meshes, usd_points):
                self.assertEqual(len(obj_groups[mesh['name']]), len(mesh['indices']))
                for (position, normal), index in zip(obj_groups[mesh['name']], mesh['indices']):
                    x,y,z=mesh['vertices'][index]
                    for value,want in zip(position,(x,-z,y)): self.assertLessEqual(abs(value-want),.000005000001)
                    x,y,z=mesh['normals'][index]; normal_length=math.sqrt(x*x+y*y+z*z)
                    for value,want in zip(normal,(x/normal_length,-z/normal_length,y/normal_length)): self.assertLessEqual(abs(value-want),.000050000001)
                triangles = dae_mesh.find('c:mesh/c:triangles', ns)
                inputs = triangles.findall('c:input', ns)
                corner_width = max(int(value.get('offset')) for value in inputs) + 1
                position_input = next(value for value in inputs if value.get('semantic') == 'VERTEX')
                vertices = dae_ids[position_input.get('source')[1:]]
                source = dae_ids[vertices.find('c:input', ns).get('source')[1:]]
                accessor = source.find('c:technique_common/c:accessor', ns)
                values = list(map(float, dae_ids[accessor.get('source')[1:]].text.split()))
                indices = list(map(int, triangles.find('c:p', ns).text.split()))[int(position_input.get('offset'))::corner_width]
                actual = [value for index in indices for value in values[index*3:index*3+3]]
                expected = [f32(value) for index in mesh['indices'] for x, y, z in [mesh['vertices'][index]] for value in (x, -z, y)]
                self.assertEqual([f32(value) for value in actual], expected)
                usd_vertices = [float(value) for value in re.findall(r'-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?', usd_point_text)]
                expected = [f32(value) for point in mesh['vertices'] for value in point]
                self.assertEqual([f32(value) for value in usd_vertices], expected)
            for color in ('furniture_a1b2c3', 'furniture_e7513d'):
                effects = [effect for effect in dae.findall('.//c:effect',ns) if effect.find('.//c:source_material',ns).text == color]
                self.assertTrue(effects)
                for effect in effects:
                    actual=[f32(float(value)) for value in effect.find('.//c:base_color',ns).text.split()]
                    self.assertEqual(actual,list(map(f32,data['materials'][color])))
                self.assertIn('sourceMaterial="' + color + '"', usda)
            for mesh in export_data['meshes']:
                self.assertIn('o ' + mesh['name'] + '\n', obj)
                self.assertIn('sourceMesh="' + mesh['name'] + '"', usda)
            # Decode ordered GLB corners including the index stream. Compaction
            # must retain float32 positions and normals exactly.
            binary_offset = 20 + length + 8
            def accessor(index):
                entry=document['accessors'][index]; view=document['bufferViews'][entry['bufferView']]
                width={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[entry['type']]
                code={5121:'B',5123:'H',5125:'I',5126:'f'}[entry['componentType']]
                offset=binary_offset+view.get('byteOffset',0)+entry.get('byteOffset',0)
                stride=view.get('byteStride',width*struct.calcsize(code))
                return tuple(value for i in range(entry['count'])
                             for value in struct.unpack_from('<'+code*width,glb,offset+i*stride))
            self.assertTrue(any(a.get('byteOffset',0)>0 for a in document['accessors']))
            self.assertIn(5121,{document['accessors'][m['primitives'][0]['indices']]['componentType']
                                for m in document['meshes']})
            self.assertTrue(any('TANGENT' in m['primitives'][0]['attributes'] for m in document['meshes']))
            for mesh, exported in zip(export_data['meshes'], document['meshes']):
                primitive=exported['primitives'][0]; indices=accessor(primitive['indices'])
                self.assertEqual(len(indices),len(mesh['indices']))
                for semantic,key in [('POSITION','vertices'),('NORMAL','normals')]:
                    values=accessor(primitive['attributes'][semantic])
                    for actual_index,expected_index in zip(indices,mesh['indices']):
                        self.assertEqual(values[actual_index*3:actual_index*3+3],tuple(map(f32,mesh[key][expected_index])))
            with tarfile.open(output / 'home-floorplan.tar.gz') as package:
                name = 'custom_components/home_floorplan/assets/' + floor['id'] + '/model-data.json'
                self.assertEqual(json.load(package.extractfile(name)), data)
                prefix = name.rsplit('/', 1)[0] + '/'
                members = set(package.getnames())
                for local_only in ('plan.svg', 'inventory.json', 'inventory-template.json', floor['id'] + '.usda'):
                    self.assertTrue((folder / local_only).is_file())
                    self.assertNotIn(prefix + local_only, members, 'HA excludes only unlinked authoring duplicates')
                manifest_name = floor['id'] + '.exports.json'
                texture_manifest = json.load(package.extractfile(prefix + manifest_name))
                for texture_name, digest in texture_manifest['textures'].items():
                    self.assertIn(prefix + texture_name, members)
                    self.assertEqual(hashlib.sha256(package.extractfile(prefix + texture_name).read()).hexdigest(), digest)
                for extension in ('glb', 'obj', 'mtl', 'dae'):
                    self.assertIn(prefix + floor['id'] + '.' + extension, members)

    def test_maximum_density_floor_builds_and_installs_with_safety_limits(self):
        plant = next(model for model in CATALOG['models'] if model['id'] == 'plant')
        self.assert_models_build_and_install([plant] * 256)

    def test_mixed_catalog_builds_and_installs_with_safety_limits(self):
        self.assert_models_build_and_install(CATALOG['models'])

    def assert_models_build_and_install(self, models):
        project = fixture_project()
        floor = project['floors'][0]
        # Distinct positions reproduce the long float strings in dense exports.
        for index, model in enumerate(models):
            item = fixture_item(model, floor['rooms'][0]['id'])
            item.update(id=f'catalog_{index}', style_id=model['default_style'])
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
            self.assertEqual(len(data['object_assets']), len(models))
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
            self.assertEqual(len(furniture_nodes), sum(len(model['parts']) for model in models))

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
