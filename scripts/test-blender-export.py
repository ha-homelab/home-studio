#!/usr/bin/env python3
"""Offline export acceptance: real compiler/handlers, synthetic homes, no Blender/HA."""
import asyncio
import base64
import copy
import importlib.util
import io
import json
import math
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile
import zlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location('blender_generated_support', ROOT / 'scripts/test-ha-generated.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
support, integration, native, compiler, generated = fixture.support, fixture.integration, fixture.native, fixture.compiler, fixture.generated
from exporters import export_scene


def glb(result):
    raw = base64.b64decode(result['base64'])
    length = struct.unpack_from('<I', raw, 12)[0]
    return json.loads(raw[20:20 + length]), raw, 28 + length


def positions(document, raw, binary, node):
    primitive = document['meshes'][node['mesh']]['primitives'][0]
    accessor = document['accessors'][primitive['attributes']['POSITION']]
    view = document['bufferViews'][accessor['bufferView']]
    values = struct.unpack_from('<' + 'f' * (accessor['count'] * 3), raw, binary + view['byteOffset'])
    points = [values[index:index + 3] for index in range(0, len(values), 3)]
    indices = document['accessors'][primitive['indices']]
    index_view = document['bufferViews'][indices['bufferView']]
    order = struct.unpack_from('<' + 'I' * indices['count'], raw, binary + index_view['byteOffset'])
    return [points[index] for index in order]


class ExportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.hass = support.Hass(self.root)
        for module in (native, generated):
            mocked = patch.object(module, 'compiler', return_value=compiler)
            mocked.start()
            self.addCleanup(mocked.stop)
        self.project = native.NativeProject(self.hass, self.root / 'native')
        self.source = json.loads((ROOT / 'planner/guide-assets/practice-home.json').read_text())
        self.state = {'native': self.project, 'lock': asyncio.Lock(), 'recovery': None,
                      'curtains': {'capture': lambda: None}}
        self.hass.data[integration.DOMAIN] = self.state

    async def request(self, source=None, floor='ground', format='glb', revision=None, connection=None):
        connection = connection or support.Connection()
        await integration.ws_export_model(self.hass, connection, {
            'id': 1, 'type': 'home_floorplan/export_model',
            'revision': self.project.document['revision'] if revision is None else revision,
            'project': source or self.source, 'floor': floor, 'format': format})
        return connection

    async def test_unsaved_snapshot_grouping_and_world_geometry(self):
        source = copy.deepcopy(self.source)
        item = source['floors'][0]['items'][0]
        item.update(name='Desk for Blender', rotation_deg=37, entity_id='light.private_export', notes='SECRET_NOTE')
        item['position_m'] = {'x': 6.5, 'y': .2, 'z': 2}
        item['dimensions_m'] = {'width': 1.7, 'height': .8, 'depth': .6}
        before = copy.deepcopy(self.project.document)
        response = await self.request(source)
        self.assertFalse(response.errors)
        document, raw, binary = glb(response.results[0])
        self.assertEqual(self.project.document, before)
        self.assertEqual(self.hass.saved, {})
        self.assertFalse((self.root / 'native').exists())
        desk = next(node for node in document['nodes'] if node['name'] == 'Writing desk 1')
        self.assertEqual(desk['translation'], [6.5, .2, 2])
        self.assertEqual(desk['scale'], [1.7, .8, .6])
        self.assertEqual(len(desk['children']), 8)
        expected, _ = compiler.make_floor(source, source['floors'][0], None)
        expected_parts = [mesh for mesh in expected['meshes'] if mesh.get('item_id') == item['id']]
        angle = math.radians(item['rotation_deg'])
        for child, expected_part in zip(desk['children'], expected_parts):
            points = positions(document, raw, binary, document['nodes'][child])
            wanted = [expected_part['vertices'][index] for index in expected_part['indices']]
            self.assertEqual(len(points), len(wanted))
            for (x, y, z), want in zip(points, wanted):
                x, y, z = x*1.7, y*.8, z*.6
                actual = [6.5+math.cos(angle)*x+math.sin(angle)*z, .2+y, 2-math.sin(angle)*x+math.cos(angle)*z]
                for a, b in zip(actual, want):
                    self.assertAlmostEqual(a, b, places=6)
        self.assertNotIn(b'light.private_export', raw)
        self.assertNotIn(b'SECRET_NOTE', raw)
        self.assertNotIn(b'Desk for Blender', raw)
        self.assertNotIn(b'entity_id', raw)
        self.assertNotIn(b'site_id', raw)

    async def test_runtime_save_exports_current_snapshot_without_republish(self):
        await self.project.save(0, self.source)
        published = await self.project.publish(1)
        integration._apply_active(self.state, *published)
        original = (published[0] / 'ground/ground.glb').read_bytes()
        inventory = copy.deepcopy(published[3]['ground'])
        inventory['items'][0]['position_m']['x'] += 1
        saved = support.Connection()
        await integration.ws_save(self.hass, saved, {'id': 1, 'floor': 'ground', **inventory})
        self.assertFalse(saved.errors)
        response = await self.request(self.project.document['project'])
        self.assertFalse(response.errors)
        document, raw, _ = glb(response.results[0])
        desk = next(node for node in document['nodes'] if node['name'] == 'Writing desk 1')
        self.assertEqual(desk['translation'][0], 6.5)
        self.assertNotEqual(raw, original)
        self.assertEqual((published[0] / 'ground/ground.glb').read_bytes(), original)
        self.assertEqual(self.project.document['generation'], published[0].name)
        legacy = support.Connection()
        await integration.ws_export(self.hass, legacy, {'id': 2, 'floor': 'ground', 'format': 'glb'})
        self.assertEqual(legacy.errors[0][0], 'stale_export')
        self.assertFalse(legacy.results)
        refreshed = await self.project.publish(self.project.document['revision'])
        integration._apply_active(self.state, *refreshed)
        legacy = support.Connection()
        await integration.ws_export(self.hass, legacy, {'id': 3, 'floor': 'ground', 'format': 'glb'})
        self.assertFalse(legacy.errors)
        self.assertNotEqual(base64.b64decode(legacy.results[0]['base64']), original)

    async def test_all_floors_and_obj_material_bundle(self):
        source = copy.deepcopy(self.source)
        upper = copy.deepcopy(source['floors'][0])
        upper.update(id='upper', name='Upstairs', elevation_m=3.1)
        source['floors'].append(upper)
        response = await self.request(source, floor=None)
        document, _, _ = glb(response.results[0])
        roots = [document['nodes'][index] for index in document['scenes'][0]['nodes']]
        self.assertEqual([node['translation'][1] for node in roots], [0, 3.1])
        response = await self.request(source, floor='upper')
        document, _, _ = glb(response.results[0])
        self.assertEqual(document['nodes'][0]['translation'], [0, 0, 0])
        response = await self.request(source, floor=None, format='obj')
        self.assertFalse(response.errors)
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(response.results[0]['base64']))) as archive:
            obj = archive.read('home.obj').decode()
            mtl = archive.read('materials.mtl').decode()
            maps = {line.split()[-1] for line in mtl.splitlines()
                    if line.startswith(('map_', 'norm '))}
            self.assertTrue(maps, 'Authored furniture retains its physical material maps')
            self.assertEqual(set(archive.namelist()), {'home.obj', 'materials.mtl'} | maps)
            for name in maps:
                self.assertTrue(name.startswith('textures/material_'))
                self.assertTrue(archive.read(name).startswith(b'\x89PNG\r\n\x1a\n'))
        self.assertIn('mtllib materials.mtl', obj)
        self.assertIn('newmtl material_', mtl)
        self.assertIn('d 0.3', mtl)
        # A desk is one OBJ object even though it has eight differently colored parts.
        self.assertEqual(sum('Writing desk 1' in line for line in obj.splitlines() if line.startswith('o ')), 2)
        self.assertIn('vn ', obj)
        vertices = [tuple(map(float, line.split()[1:])) for line in obj.splitlines() if line.startswith('v ')]
        self.assertGreater(max(point[2] for point in vertices), 5.7)

    async def test_permissions_revision_validation_and_no_mutation(self):
        for arguments, error in [({'connection': support.Connection(admin=False)}, 'unauthorized'),
                                 ({'revision': 10}, 'conflict'), ({'floor': '../private'}, 'invalid_floor'),
                                 ({'format': 'blend'}, 'invalid_export')]:
            response = await self.request(**arguments)
            self.assertEqual(response.errors[0][0], error)
            self.assertFalse(response.results)
        source = copy.deepcopy(self.source)
        source['floors'][0]['items'][0]['position_m']['x'] = float('nan')
        response = await self.request(source)
        self.assertTrue(response.errors)
        self.assertFalse(response.results)
        self.assertEqual(self.hass.saved, {})
        self.assertFalse(self.state['export_busy'])

    async def test_busy_cancellation_and_late_permission_check(self):
        entered, finish = asyncio.Event(), asyncio.Event()
        async def worker(function, *args):
            entered.set()
            await finish.wait()
            return {'filename': 'home-studio-ground.glb', 'base64': ''}
        with patch.object(self.hass, 'async_add_executor_job', side_effect=worker):
            pending = asyncio.create_task(self.request())
            await entered.wait()
            response = await self.request()
            self.assertEqual(response.errors[0][0], 'busy')
            pending.cancel()
            await asyncio.sleep(0)
            self.assertTrue(self.state['export_busy'])
            pending.cancel()
            await asyncio.sleep(0)
            self.assertTrue(self.state['export_busy'])
            finish.set()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(pending, timeout=5)
            self.assertFalse(self.state['export_busy'])
        entered.clear(); finish.clear()
        user = support.Connection()
        with patch.object(self.hass, 'async_add_executor_job', side_effect=worker):
            pending = asyncio.create_task(self.request(connection=user))
            await entered.wait()
            user.user.is_admin = False
            finish.set()
            await asyncio.wait_for(pending, timeout=5)
        self.assertEqual(user.errors[0][0], 'unauthorized')
        self.assertFalse(user.results)

    async def test_generated_custom_geometry_and_added_objects(self):
        component = self.root / 'component'
        site, models, inventory = fixture.fixture(component)
        self.project = generated.GeneratedProject(self.hass, component, site, models, inventory)
        await self.project.load()
        self.state['native'] = self.project
        source = copy.deepcopy(self.project.document['project'])
        floor = source['floors'][0]
        floor['items'][0]['position_m']['x'] = 2.2
        added = copy.deepcopy(self.source['floors'][0]['items'][0])
        added.update(id='new_desk', room=floor['rooms'][0]['id'])
        floor['items'].append(added)
        before = fixture.tree_hashes(component)
        for saved in (False, True):
            if saved:
                await self.project.save(0, source)
                await self.project.publish(1)
            document_before = copy.deepcopy(self.project.document)
            response = await self.request(source, floor=floor['id'])
            self.assertFalse(response.errors, response.errors)
            document, raw, binary = glb(response.results[0])
            custom = next(node for node in document['nodes'] if node['name'] == 'Lamp 1')
            self.assertEqual(custom['translation'][0], 2.2)
            local = positions(document, raw, binary, document['nodes'][custom['children'][0]])
            self.assertEqual(local, [(0, 0, 0), (1, 0, 0), (0, 1, 0)])
            self.assertEqual(len(custom['children']), 1)
            self.assertEqual(sum(node['name'] == 'Writing desk 2' for node in document['nodes']), 1)
            # Exactly two original custom architectural triangles survive. No generic room slab.
            architectural = [node for node in document['nodes'] if node['name'].startswith('Architecture ') and 'children' in node]
            self.assertEqual(len(architectural), 2)
            self.assertTrue(any(material['pbrMetallicRoughness']['baseColorFactor'] == [.1, .6, .5, 1] for material in document['materials']))
            self.assertNotIn(b'light.synthetic_lamp', raw)
            self.assertNotIn(b'A synthetic custom asset', raw)
            self.assertEqual(self.project.document, document_before)
            self.assertEqual(fixture.tree_hashes(component), before)
        source['floors'][0]['rooms'][0]['polygon'][0][0] = -1
        response = await self.request(source, floor=floor['id'])
        self.assertEqual(response.errors[0][0], 'protected_architecture')

    async def test_failed_worker_releases_slot_and_rechecks_unloaded_state(self):
        with patch.object(self.project, 'export_model', side_effect=OSError('synthetic read failure')):
            response = await self.request()
        self.assertEqual(response.errors[0][0], 'export_failed')
        self.assertFalse(self.state['export_busy'])
        response = await self.request()
        self.assertFalse(response.errors)
        async def unloaded_worker(function, *args):
            self.state['panels_unloaded'] = True
            return {'filename': 'home-studio-ground.glb', 'base64': ''}
        with patch.object(self.hass, 'async_add_executor_job', side_effect=unloaded_worker):
            response = await self.request()
        self.assertEqual(response.errors[0][0], 'unauthorized')
        self.assertFalse(response.results)

    async def test_generated_source_change_rejects_export(self):
        component = self.root / 'component'
        site, models, inventory = fixture.fixture(component)
        self.project = generated.GeneratedProject(self.hass, component, site, models, inventory)
        await self.project.load()
        self.state['native'] = self.project
        source = self.project.document['project']
        (component / 'assets/upper/model-data.json').write_text('{}')
        response = await self.request(source, floor='upper')
        self.assertEqual(response.errors[0][0], 'source_changed')
        self.assertFalse(response.results)
        self.assertFalse(self.state['export_busy'])

    async def test_generated_export_bounds_hashed_bundle_separately_from_parsed_models(self):
        component = self.root / 'component'
        site, models, inventory = fixture.fixture(component)
        assets = component / 'assets'
        parsed = {floor: sum((assets / floor / name).stat().st_size for name in ('model-data.json', 'index.html'))
                  for floor in models}
        parsed_all = sum(parsed.values())
        # Legacy GLB/OBJ/etc files are hashed but never parsed into this export.
        unused = assets / 'upper/old-download.glb'
        unused.write_bytes(b'x' * (parsed_all * 2))
        total = sum(path.stat().st_size for path in assets.rglob('*') if path.is_file())
        self.project = generated.GeneratedProject(self.hass, component, site, models, inventory)
        await self.project.load()
        self.state['native'] = self.project
        source = self.project.document['project']
        document_before, storage_before = copy.deepcopy(self.project.document), copy.deepcopy(self.hass.saved)
        baseline = await self.request(source, floor=None)
        self.assertFalse(baseline.errors)
        with patch.object(generated, 'MAX_EXPORT_SOURCE_BYTES', total), \
                patch.object(generated, 'MAX_GENERATED_BYTES', parsed_all):
            at_boundary = await self.request(source, floor=None)
            self.assertFalse(at_boundary.errors)
            self.assertEqual(at_boundary.results, baseline.results)
        # Each preflight rejects before hashing or parsing any source content.
        for whole_limit, parse_limit, scope in ((total - 1, parsed_all, None),
                                                (total, parsed_all - 1, None),
                                                (total, parsed['upper'] - 1, 'upper')):
            with self.subTest(whole_limit=whole_limit, parse_limit=parse_limit, scope=scope):
                with patch.object(generated, 'MAX_EXPORT_SOURCE_BYTES', whole_limit), \
                        patch.object(generated, 'MAX_GENERATED_BYTES', parse_limit), \
                        patch.object(generated, '_hashes', side_effect=AssertionError('Preflight must reject before hashing')):
                    rejected = await self.request(source, floor=scope)
                self.assertEqual(rejected.errors[0][0], 'invalid_export')
                self.assertFalse(rejected.results)
                self.assertFalse(self.state['export_busy'])
        with patch.object(generated, 'MAX_EXPORT_SOURCE_BYTES', total), \
                patch.object(generated, 'MAX_GENERATED_BYTES', parsed['upper']):
            selected = await self.request(source, floor='upper')
            self.assertFalse(selected.errors, 'Other floors do not count against selected model parsing')
        # Even unused legacy downloads remain protected by the original hashes.
        unused.write_bytes(b'y' * unused.stat().st_size)
        changed = await self.request(source, floor='upper')
        self.assertEqual(changed.errors[0][0], 'source_changed')
        self.assertFalse(changed.results)
        self.assertEqual(self.project.document, document_before)
        self.assertEqual(self.hass.saved, storage_before)

    def test_legacy_custom_mesh_is_moved_without_replacing_geometry(self):
        source = copy.deepcopy(self.source)
        item = source['floors'][0]['items'][0]
        model, _ = compiler.make_floor(source, source['floors'][0], None)
        model['object_assets'] = {}
        original = copy.deepcopy(item)
        item['position_m']['x'] += 2
        item['rotation_deg'] = 90
        floor = compiler.export_floor(model, source['floors'][0], [original])
        exported = floor['groups'][-1]
        self.assertEqual(len(exported['meshes']), 8)
        self.assertEqual(exported['translation'][0], 7.5)
        self.assertAlmostEqual(exported['rotation'], math.pi / 2)
        local = exported['meshes'][0]['vertices'][0]
        asset = compiler.build_furniture_asset(original)['meshes'][0]['vertices'][0]
        for actual, expected in zip(local, asset):
            self.assertAlmostEqual(actual, expected)

    def test_returning_catalog_item_to_basic_shape_discards_old_detail(self):
        # Both normalized assets and raw-only legacy models must follow the
        # current basic shape instead of retaining obsolete catalog geometry.
        for raw_only in (False, True):
            with self.subTest(raw_only=raw_only):
                source = copy.deepcopy(self.source)
                item = source['floors'][0]['items'][0]
                original = copy.deepcopy(item)
                model, _ = compiler.make_floor(source, source['floors'][0], None)
                if raw_only:
                    model['object_assets'] = {}
                for key in ('model_id', 'style_id'):
                    item.pop(key, None)
                floor = compiler.export_floor(model, source['floors'][0], [original])
                self.assertEqual(len(floor['groups'][-1]['meshes']), 1)
                self.assertEqual(len(floor['groups'][-1]['meshes'][0]['indices']), 36)

    def test_export_limits(self):
        floor = compiler.export_floor(compiler.make_floor(self.source, self.source['floors'][0], None)[0], self.source['floors'][0])
        with patch('exporters.MAX_EXPORT_TRIANGLES', 1):
            with self.assertRaisesRegex(ValueError, 'triangles'):
                export_scene([floor], 'glb')
        for format in ('glb', 'obj'):
            with patch('exporters.MAX_EXPORT_BYTES', 10):
                with self.assertRaisesRegex(ValueError, '32 MB'):
                    export_scene([floor], format)
        floor['groups'][0]['meshes'][0]['vertices'][0][0] = float('inf')
        with self.assertRaisesRegex(ValueError, 'invalid export geometry'):
            export_scene([floor], 'glb')


class CompactExportTests(unittest.TestCase):
    def scene(self):
        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
        png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 256, 256, 8, 2, 0, 0, 0))
               + chunk(b'IDAT', zlib.compress((b'\0' + b'\x80\x80\x80' * 256) * 256)) + chunk(b'IEND', b''))
        triangle = [[-.25, 0, -.5], [.5, 0, -.5], [-.25, 0, .5]]
        mesh = {'vertices': triangle * 3 + [[99, 99, 99]], 'normals': [[0, 1, 0]] * 10,
                'indices': list(range(9)), 'color': [.2, .3, .4, 1], 'material_name': 'cloth',
                'surface_finish': 'fabric', 'uv': [[0, 0], [1, 0], [0, 1]] * 3 + [[99, 99]],
                'texture': {'mime_type': 'image/png', 'width': 256, 'height': 256,
                            'data_uri': 'data:image/png;base64,' + base64.b64encode(png).decode()}}
        # Coincident positions must keep distinct normal and UV seams.
        mesh['normals'][6] = [0, 0, 1]
        mesh['uv'][7] = [2, 0]
        plain = {key: copy.deepcopy(value) for key, value in mesh.items() if key not in ('uv', 'texture')}
        plain.update(color=[.8, .1, .2, 1], material_name='paint', surface_finish='painted')
        groups = [{'name': 'Fixture', 'translation': [-3, .25, -2], 'rotation': math.pi / 2,
                   'scale': [2, .5, 3], 'meshes': [mesh, plain]},
                  {'name': 'Other', 'translation': [1, -1, 2], 'rotation': -math.pi / 2,
                   'scale': [.5, 2, 1], 'meshes': [copy.deepcopy(mesh)]}]
        return [{'name': 'Floor', 'elevation': -2, 'groups': groups}]

    def test_glb_reuses_only_exact_attributes_and_preserves_each_corner(self):
        scene = self.scene(); before = copy.deepcopy(scene)
        raw = export_scene(scene, 'glb')
        size = struct.unpack_from('<I', raw, 12)[0]
        doc = json.loads(raw[20:20 + size]); binary = 28 + size
        def accessor(index):
            acc = doc['accessors'][index]; width = {'VEC3': 3, 'VEC2': 2, 'SCALAR': 1}[acc['type']]
            view = doc['bufferViews'][acc['bufferView']]
            values = struct.unpack_from('<' + ('I' if acc['componentType'] == 5125 else 'f') * (acc['count'] * width), raw, binary + view['byteOffset'])
            return [values[i:i + width] for i in range(0, len(values), width)]
        f32 = lambda values: struct.unpack('<' + 'f' * len(values), struct.pack('<' + 'f' * len(values), *values))
        root = doc['nodes'][doc['scenes'][0]['nodes'][0]]
        self.assertEqual(root['translation'], [0, -2, 0])
        materials = []
        for group, node_index in zip(scene[0]['groups'], root['children']):
            node = doc['nodes'][node_index]
            self.assertEqual(node['translation'], group['translation'])
            self.assertEqual(node['scale'], group['scale'])
            self.assertEqual(node['rotation'], [0, math.sin(group['rotation'] / 2), 0, math.cos(group['rotation'] / 2)])
            for source, child in zip(group['meshes'], node['children']):
                primitive = doc['meshes'][doc['nodes'][child]['mesh']]['primitives'][0]
                arrays = {key: accessor(index) for key, index in primitive['attributes'].items()}
                order = [value[0] for value in accessor(primitive['indices'])]
                expected = [(f32(source['vertices'][i]), f32(source['normals'][i]),
                             f32([source['uv'][i][0], 1 - source['uv'][i][1]]) if 'texture' in source else None)
                            for i in source['indices']]
                actual = [(arrays['POSITION'][i], arrays['NORMAL'][i], arrays.get('TEXCOORD_0', [None] * len(arrays['POSITION']))[i]) for i in order]
                self.assertEqual(actual, expected)
                self.assertLess(len(arrays['POSITION']), len(source['vertices']))
                self.assertEqual(len(arrays['POSITION']), 5 if 'texture' in source else 4)
                materials.append(primitive['material'])
        self.assertEqual(materials, [0, 1, 0])
        self.assertEqual(doc['materials'][1]['pbrMetallicRoughness']['baseColorFactor'], [.8, .1, .2, 1])
        self.assertEqual(scene, before)

    def test_obj_independent_indices_preserve_transformed_corners_and_materials(self):
        scene = self.scene()
        scene[0]['groups'][0]['meshes'] *= 12
        # Separate objects grow the position index beyond two digits, so the
        # compact relative form and shared normal/UV arrays are both exercised.
        for index in range(80):
            group = copy.deepcopy(scene[0]['groups'][1])
            group.update(name=f'Repeat {index}', translation=[-20 - index, -1, 2])
            scene[0]['groups'].append(group)
        before = copy.deepcopy(scene)
        with zipfile.ZipFile(io.BytesIO(export_scene(scene, 'obj'))) as archive:
            obj = archive.read('home.obj').decode()
            self.assertIn('map_Kd textures/material_0.png', archive.read('materials.mtl').decode())
        arrays = {'v': [], 'vn': [], 'vt': []}; actual = []; group = material = None
        for line in obj.splitlines():
            kind, *parts = line.split()
            if kind in arrays:
                arrays[kind].append(tuple(map(float, parts)))
            elif kind == 'o': group = ' '.join(parts)
            elif kind == 'usemtl': material = parts[0]
            elif kind == 'f':
                for corner in parts:
                    position, uv, normal = corner.split('/')
                    def resolve(kind, index):
                        if not index: return None
                        value = int(index)
                        return arrays[kind][value - 1 if value > 0 else value]
                    actual.append((group, material, resolve('v', position), resolve('vn', normal), resolve('vt', uv)))
        expected = []
        rounded = lambda values, places=5: tuple(float(f'{value:.{places}f}') for value in values)
        for ordinal, group in enumerate(scene[0]['groups'], 1):
            c, s = math.cos(group['rotation']), math.sin(group['rotation'])
            sx, sy, sz = group['scale']; tx, ty, tz = group['translation']
            for mesh in group['meshes']:
                for index in mesh['indices']:
                    x, y, z = [v * scale for v, scale in zip(mesh['vertices'][index], group['scale'])]
                    position = rounded((tx + c*x + s*z, -(tz - s*x + c*z), ty + y + scene[0]['elevation']))
                    x, y, z = [v / scale for v, scale in zip(mesh['normals'][index], group['scale'])]
                    x, z = c*x + s*z, -s*x + c*z
                    length = math.hypot(x, y, z) or 1
                    normal = rounded((x / length, -z / length, y / length), 4)
                    expected.append((f'{ordinal}_Floor {group["name"]}', 'material_0' if 'texture' in mesh else 'material_1',
                                     position, normal, rounded(mesh['uv'][index]) if 'texture' in mesh else None))
        self.assertEqual(actual, expected)
        self.assertTrue(any(part.startswith('-') for line in obj.splitlines() if line.startswith('f ')
                            for part in line.split()[1:]))
        self.assertLess(len(arrays['vn']), 10)
        self.assertEqual(scene, before)

    def test_half_million_triangle_boundary_keeps_byte_and_native_limits(self):
        mesh = {'vertices': [[0, 0, 0], [1, 0, 0], [0, 0, 1]], 'normals': [[0, 1, 0]] * 3,
                'indices': [0, 1, 2] * 500_000, 'color': [.4, .4, .4, 1]}
        scene = [{'name': 'Floor', 'elevation': 0, 'groups': [{'name': 'Object', 'translation': [0, 0, 0],
                  'rotation': 0, 'scale': [1, 1, 1], 'meshes': [mesh]}]}]
        self.assertLess(len(export_scene(scene, 'glb')), 32 * 1024 * 1024)
        self.assertEqual(native.MAX_NATIVE_TRIANGLES, 200_000)
        mesh['indices'].extend([0, 1, 2])
        with self.assertRaisesRegex(ValueError, '500,000 triangles'):
            export_scene(scene, 'glb')


if __name__ == '__main__':
    unittest.main()
