#!/usr/bin/env python3
"""Synthetic opaque albedo validation, live-dimension UVs and portable exports."""
import base64
import copy
import io
import json
from pathlib import Path
import struct
import sys
import unittest
from unittest.mock import patch
import zipfile
import zlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from geometry import create_geometry
from material_textures import decode_material_texture, material_uv, validate_material_textures, material_surface_profile, MAX_MATERIAL_PNG_BYTES, MAX_MATERIAL_BASE64_CHARS
from planner.project import export_floor, make_floor, render_viewer
from exporters import export_scene


def swatch(seed=0, level=-1):
    def chunk(kind, value):
        return struct.pack('>I', len(value)) + kind + value + struct.pack('>I', zlib.crc32(kind + value))
    pixels = b''.join(b'\0' + b''.join(bytes((60 + (x // 16) % 2 * 100, 70 + y // 2, 100 + seed)) for x in range(256)) for y in range(256))
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 256, 256, 8, 2, 0, 0, 0))
    data += chunk(b'IDAT', zlib.compress(pixels, level)) + chunk(b'IEND', b'')
    return {'mime_type': 'image/png', 'width': 256, 'height': 256,
            'data_uri': 'data:image/png;base64,' + base64.b64encode(data).decode()}


def fixture(static=False):
    project = json.loads((ROOT / 'planner/example-home.json').read_text())
    floor = project['floors'][0]
    floor['items'] = [{'id': name, 'name': name.title(), 'type': 'furniture', 'room': 'living',
                       'position_m': {'x': x, 'y': 0, 'z': 2}, 'dimensions_m': {'width': 1.6, 'height': .3, 'depth': 1.2},
                       'rotation_deg': 0, 'entity_id': '', 'notes': ''} for name, x in [('textured', 1.2), ('plain', 3)]]
    floor['items'].append({'id': 'lamp', 'name': 'Fictional lamp', 'type': 'chandelier', 'room': 'living',
                           'position_m': {'x': 2, 'y': 2.3, 'z': 2}, 'dimensions_m': {'width': .2, 'height': .2, 'depth': .2},
                           'rotation_deg': 0, 'entity_id': 'light.fixture', 'notes': ''})
    model, svg = make_floor(project, floor, None)
    geometry = create_geometry([(0, 0), (1, 1)], [(0, 0), (1, 1)])
    geometry.box_m('body', -.5, -.5, .5, .5, 0, 1, 'wood', 'inventory')
    box = geometry.meshes[0]
    selected = [i for i, normal in enumerate(box['normals']) if normal == [0, 1, 0]]
    parts = []
    for name, indices in [('body', [i for i in range(36) if i not in selected]), ('top', selected)]:
        part = dict(box, name=name, surface_finish='fabric' if name == 'top' else 'plastic', vertices=[box['vertices'][i] for i in indices],
                    normals=[box['normals'][i] for i in indices], indices=list(range(len(indices))))
        if name == 'top':
            part.update(albedo_texture='fabric', uv=[[(x + .5) / .25, (.5 - z) / .25] for x, _, z in part['vertices']],
                        uv_dimensions=['width', 'depth'])
        parts.append(part)
    model['object_assets']['textured'] = {'meshes': parts}
    model['object_assets']['plain'] = {'meshes': [box]}
    model['material_textures'] = {'fabric': swatch()}
    if static:
        for mesh in model['meshes']:
            if mesh['kind'] in ('floors', 'walls') and model['materials'][mesh['material']][3] == 1:
                mesh.update(surface_finish='ceramic', albedo_texture='fabric', uv=[[x / .25, (y if mesh['kind'] == 'walls' else z) / .25] for x, y, z in mesh['vertices']])
    return model, svg, floor


class MaterialTextureTests(unittest.TestCase):
    def test_bounded_opaque_png_and_bad_inputs(self):
        spec = swatch()
        self.assertLess(len(decode_material_texture(spec)), MAX_MATERIAL_PNG_BYTES)
        for change in [{'data_uri': 'https://example.invalid/image.png'}, {'width': 1024},
                       {'data_uri': 'data:image/png;base64,' + 'A' * (MAX_MATERIAL_BASE64_CHARS + 4)}, {'extra': 1}]:
            with self.assertRaises(ValueError): decode_material_texture(spec | change)
        data = bytearray(base64.b64decode(spec['data_uri'].split(',')[1])); data[33] ^= 1
        with self.assertRaises(ValueError): decode_material_texture(spec | {'data_uri': 'data:image/png;base64,' + base64.b64encode(data).decode()})

    def test_collection_and_export_budgets(self):
        specs = {f'tile_{i}': swatch(i) for i in range(64)}
        model = {'material_textures': specs, 'materials': {}, 'meshes': []}
        self.assertEqual(len(validate_material_textures(model)), 64)
        with self.assertRaises(ValueError):
            validate_material_textures(model | {'material_textures': specs | {'too_many': swatch(64)}})
        with patch('material_textures.MAX_MATERIAL_TEXTURE_BYTES', 1):
            with self.assertRaises(ValueError): validate_material_textures(model)
        base = {'vertices': [[0,0,0],[1,0,0],[0,0,1]], 'normals': [[0,1,0]]*3,
                'indices': [0,1,2], 'color': [1,1,1,1], 'uv': [[0,0],[1,0],[0,1]]}
        group = {'name': 'Synthetic swatches', 'translation': [0,0,0], 'scale': [1,1,1], 'rotation': 0,
                 'meshes': [base | {'texture': spec} for spec in specs.values()]}
        floors = [{'name': 'Fictional floor', 'elevation': 0, 'groups': [group]}]
        raw = export_scene(floors, 'glb'); length = struct.unpack_from('<I', raw, 12)[0]
        self.assertEqual(len(json.loads(raw[20:20+length])['images']), 64)
        with zipfile.ZipFile(io.BytesIO(export_scene(floors, 'obj'))) as archive:
            self.assertEqual(len([name for name in archive.namelist() if name.endswith('.png')]), 64)
        with patch('material_textures.MAX_MATERIAL_TEXTURE_BYTES', 1):
            with self.assertRaises(ValueError): export_scene(floors, 'glb')
        group['meshes'].append(base | {'texture': swatch(64)})
        with self.assertRaises(ValueError): export_scene(floors, 'glb')

    def test_full_rgb_payload_and_real_aggregate_limit(self):
        large = swatch(level=0)
        self.assertGreater(len(decode_material_texture(large)), 96 * 1024)
        self.assertLess(len(decode_material_texture(large)), 256 * 1024)
        definitions = {f'tile_{i}': large for i in range(42)}
        self.assertEqual(len(validate_material_textures({'material_textures': definitions})), 42)
        definitions['overflow'] = large
        with self.assertRaises(ValueError): validate_material_textures({'material_textures': definitions})

    def test_static_uv_validation_and_export(self):
        model, _, floor = fixture(static=True)
        static = next(mesh for mesh in model['meshes'] if 'albedo_texture' in mesh)
        self.assertTrue(validate_material_textures(model))
        scene = export_floor(model, floor)
        architecture = [mesh for group in scene['groups'] if group['name'].startswith('Architecture') for mesh in group['meshes'] if 'texture' in mesh]
        self.assertTrue(architecture)
        self.assertEqual(architecture[0]['uv'], static['uv'])
        for mutation in [{'uv': []}, {'albedo_texture': 'missing'}]:
            old = dict(static);static.update(mutation)
            with self.assertRaises(ValueError): validate_material_textures(model)
            static.clear();static.update(old)

    def test_glb_preserves_finish_profiles_with_identical_rgb(self):
        model, _, floor = fixture()
        scene = export_floor(model, floor)
        self.assertTrue(all('material_name' in mesh for group in scene['groups'] for mesh in group['meshes']))
        base = {'vertices': [[0,0,0],[1,0,0],[0,0,1]], 'normals': [[0,1,0]]*3,
                'indices': [0,1,2], 'color': [.4,.4,.4,1]}
        names = ['brushed_steel', 'upholstery_taupe', 'glass', 'painted_steel']
        group = {'name': 'Synthetic equal-color finishes', 'translation': [0,0,0], 'scale': [1,1,1], 'rotation': 0,
                 'meshes': [base | {'material_name': name} for name in names]}
        raw = export_scene([{'name': 'Test', 'elevation': 0, 'groups': [group]}], 'glb')
        length = struct.unpack_from('<I', raw, 12)[0]
        document = json.loads(raw[20:20+length])
        self.assertEqual(len(document['materials']), len(names), 'identical colors must not merge different finish responses')
        for material, name in zip(document['materials'], names):
            profile = material_surface_profile(name)
            actual = material['pbrMetallicRoughness']
            self.assertEqual(actual['roughnessFactor'], profile['roughness'])
            self.assertEqual(actual['metallicFactor'], profile['metalness'])

    def test_explicit_surface_finish_validation_and_export(self):
        model, _, floor = fixture(static=True)
        static = model['meshes'][0]
        static['surface_finish'] = 'ceramic'
        parts = model['object_assets']['textured']['meshes']
        parts[0]['surface_finish'] = 'plastic'
        parts[1]['surface_finish'] = 'fabric'
        self.assertTrue(validate_material_textures(model))
        scene = export_floor(model, floor)
        finishes = {m.get('surface_finish') for g in scene['groups'] for m in g['meshes']}
        self.assertTrue({'ceramic', 'plastic', 'fabric'} <= finishes)
        # One overloaded palette ID with identical color and geometry still needs
        # distinct materials when its housing and fabric have explicit semantics.
        base = {'vertices': [[0,0,0],[1,0,0],[0,0,1]], 'normals': [[0,1,0]]*3,
                'indices': [0,1,2], 'color': [.4,.4,.4,1], 'material_name': 'upholstery_black'}
        group = {'name': 'Synthetic shared palette', 'translation': [0,0,0], 'scale': [1,1,1], 'rotation': 0,
                 'meshes': [base | {'surface_finish': f} for f in ['fabric', 'plastic']]}
        raw = export_scene([{'name': 'Test', 'elevation': 0, 'groups': [group]}], 'glb')
        length = struct.unpack_from('<I', raw, 12)[0]
        materials = json.loads(raw[20:20+length])['materials']
        self.assertEqual([m['pbrMetallicRoughness']['roughnessFactor'] for m in materials], [.92, .48])
        for invalid in [None, '', 'FABRIC', 'unknown', {}, 'x'*65]:
            for mesh in [static, parts[0]]:
                old = mesh['surface_finish'];mesh['surface_finish'] = invalid
                with self.assertRaises(ValueError): validate_material_textures(model)
                mesh['surface_finish'] = old

    def test_explicit_uv_selection_and_current_dimensions(self):
        model, _, floor = fixture()
        self.assertEqual(len(validate_material_textures(model)), 1)
        source = copy.deepcopy(model)
        floor = copy.deepcopy(floor)
        floor['items'][0]['dimensions_m']['width'] = 2
        exported = export_floor(model, floor)
        top = next(mesh for group in exported['groups'] for mesh in group['meshes'] if 'texture' in mesh)
        self.assertEqual(max(row[0] for row in top['uv']), 8)
        self.assertEqual(max(row[1] for row in top['uv']), 4.8)
        self.assertEqual(model, source)
        bad = copy.deepcopy(top); bad['uv'][0][0] = float('nan')
        with self.assertRaises(ValueError): material_uv(bad)
        bad = copy.deepcopy(model); bad['object_assets']['textured']['meshes'][1]['uv'].pop()
        with self.assertRaises(ValueError): validate_material_textures(bad)

    def test_glb_and_obj_keep_geometry_and_embed_only_selected_texture(self):
        model, _, floor = fixture()
        scene = export_floor(model, floor)
        raw = export_scene([scene], 'glb')
        length = struct.unpack_from('<I', raw, 12)[0]
        document = json.loads(raw[20:20+length])
        self.assertEqual(len(document['images']), 1)
        mapped = [mesh['primitives'][0] for mesh in document['meshes'] if 'TEXCOORD_0' in mesh['primitives'][0]['attributes']]
        self.assertEqual(len(mapped), 1)
        material = document['materials'][mapped[0]['material']]['pbrMetallicRoughness']
        self.assertEqual(material['baseColorFactor'], [1, 1, 1, 1])
        uv = document['accessors'][mapped[0]['attributes']['TEXCOORD_0']]
        view = document['bufferViews'][uv['bufferView']]
        values = struct.unpack_from('<' + 'f' * uv['count'] * 2, raw, 28 + length + view['byteOffset'])
        self.assertAlmostEqual(max(values[::2]), 6.4, places=5)
        self.assertAlmostEqual(min(values[1::2]), -3.8, places=5)
        with zipfile.ZipFile(io.BytesIO(export_scene([scene], 'obj'))) as archive:
            self.assertEqual(set(archive.namelist()), {'home.obj', 'materials.mtl', 'textures/material_0.png'})
            self.assertEqual(archive.read('textures/material_0.png'), decode_material_texture(swatch()))
            self.assertEqual(archive.read('home.obj').count(b'\nvt '), 6)
            self.assertEqual(archive.read('materials.mtl').count(b'map_Kd'), 1)

    def test_omitted_payload_and_bad_binding(self):
        model, svg, _ = fixture()
        rendered = render_viewer(model, svg)
        self.assertIn('function createMaterialTextures', rendered)
        self.assertNotIn('/*__MATERIAL_TEXTURES_JS__*/', rendered)
        bad = copy.deepcopy(model); bad['material_textures'] = {}
        with self.assertRaises(ValueError): render_viewer(bad, svg)
        for asset in bad['object_assets'].values():
            for mesh in asset['meshes']:
                for key in ['uv', 'uv_dimensions', 'albedo_texture']: mesh.pop(key, None)
        self.assertEqual(validate_material_textures(bad), {})


if __name__ == '__main__':
    if len(sys.argv) == 2 and sys.argv[1] == '--spec':
        print(json.dumps(swatch()))
    elif len(sys.argv) == 2 and sys.argv[1] == '--spec-large':
        print(json.dumps(swatch(level=0)))
    elif len(sys.argv) == 3 and sys.argv[1] in ('--fixture', '--fixture-static'):
        model, svg, _ = fixture(static=sys.argv[1] == '--fixture-static')
        Path(sys.argv[2]).write_text(render_viewer(model, svg), encoding='utf-8')
    else:
        unittest.main()
