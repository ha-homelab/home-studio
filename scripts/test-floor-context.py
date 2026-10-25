#!/usr/bin/env python3
"""Check architectural context isolation, alignment and compiler selection."""
import copy
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from geometry import create_geometry, floor_context
from planner.project import compile_project, make_floor

class FloorContextTests(unittest.TestCase):
    def test_box_edges_have_no_face_diagonals_or_device_data(self):
        geometry = create_geometry([(0, 0), (1, 1)], [(0, 0), (1, 1)])
        geometry.box_m('wall', 0, 0, 2, 3, 0, 2.7)
        source = copy.deepcopy(geometry.meshes)
        context = floor_context(geometry.meshes, -2.86)
        self.assertEqual(len(context['lines']), 12 * 6)
        self.assertEqual(len(context['surfaces']), 12 * 9)
        self.assertEqual(max(context['lines'][1::3]), -.16)
        self.assertEqual(min(context['lines'][1::3]), -2.86)
        geometry.box_m('private_device', 5, 5, 6, 6, 0, 1, kind='inventory')
        geometry.box_m('fixture', 7, 7, 8, 8, 0, 1, kind='fixtures')
        self.assertEqual(context, floor_context(geometry.meshes, -2.86))
        self.assertEqual(source[0], geometry.meshes[0])
        self.assertEqual(len(floor_context(source + source, -2.86)['lines']), 12 * 6)

    def test_explicit_vehicle_geometry_is_allowed_without_bindings(self):
        g = create_geometry([(0, 0), (1, 1)], [(0, 0), (1, 1)])
        g.box_m('parked_car', 0, 0, 2, 5, 0, 1.7, kind='vehicles')
        result = floor_context(g.meshes, -3)
        self.assertEqual(len(result['lines']), 72)
        self.assertEqual(set(result), {'elevation_m', 'surfaces', 'lines'})

    def test_rejects_above_floor_or_invalid_elevations(self):
        for elevation in (0, 2, float('nan'), float('inf')):
            with self.assertRaises(ValueError):
                floor_context([], elevation)

    def test_compiler_uses_nearest_lower_elevation_not_list_order(self):
        project = json.loads((ROOT / 'planner/example-home.json').read_text())
        base = project['floors'][0]
        project['floors'] = []
        for floor_id, elevation in [('top', 16), ('bottom', 10), ('middle', 13)]:
            floor = copy.deepcopy(base)
            floor.update(id=floor_id, name=floor_id, elevation_m=elevation)
            project['floors'].append(floor)
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'site'
            compile_project(project, output)
            top = json.loads((output / 'top/model-data.json').read_text())
            bottom = json.loads((output / 'bottom/model-data.json').read_text())
            self.assertEqual(top['lower_floor_context']['elevation_m'], -3)
            self.assertEqual(top['site_context']['ground_elevation_m'], -6)
            self.assertEqual(bottom['site_context']['ground_elevation_m'], 0)
            self.assertNotIn('lower_floor_context', bottom)
            self.assertTrue(all(y < 0 for y in top['lower_floor_context']['lines'][1::3]))
            self.assertTrue(all(min(p[1] for p in mesh['vertices']) >= -.2 for mesh in top['meshes']))
            self.assertEqual(set(top['lower_floor_context']), {'elevation_m', 'surfaces', 'lines'})

    def test_compiler_shares_actual_lowest_slab_across_all_floor_frames(self):
        for origin, count, bottom_depth, middle_depth in ((0, 3, .16, .16), (10, 3, .32, .25), (-3, 4, .16, 3.4)):
            with self.subTest(origin=origin, count=count), tempfile.TemporaryDirectory() as temp:
                floors = [{'id': 'floor' + str(i), 'name': 'Floor ' + str(i),
                           'elevation_m': origin + 3 * i, 'height_m': 2.7,
                           'rooms': [{'id': 'room', 'name': 'Room', 'material': 'floor',
                                      'polygon': [[0, 0], [4, 0], [4, 4], [0, 4]]}],
                           'walls': [], 'openings': [], 'items': []} for i in range(count)]
                project = {'schema_version': 1, 'title': 'Shared slab fixture',
                           'floors': [floors[-1], *floors[:-1]]}
                before = copy.deepcopy(project)
                generated = {}

                def with_slab_depth(*args):
                    data, svg = make_floor(*args)
                    depth = {'floor0': bottom_depth, 'floor1': middle_depth}.get(data['id'], .16)
                    # Exercise real compiler geometry with differing slab depths,
                    # including a higher floor whose slab reaches below the bottom.
                    for mesh in data['meshes']:
                        if mesh['kind'] == 'floors':
                            for vertex in mesh['vertices']:
                                if vertex[1] < 0:
                                    vertex[1] = -depth
                    generated[data['id']] = copy.deepcopy(data)
                    return data, svg

                output = Path(temp) / 'site'
                with patch('planner.project.make_floor', side_effect=with_slab_depth):
                    compile_project(project, output)
                self.assertEqual(project, before)
                absolute_slab = min(data['elevation_m'] + p[1] for data in generated.values()
                                    for mesh in data['meshes'] if mesh['kind'] == 'floors'
                                    for p in mesh['vertices'])
                models = []
                for floor in floors:
                    folder = output / floor['id']
                    model = json.loads((folder / 'model-data.json').read_text())
                    embedded = json.loads(re.search(r'<script id="modelData" type="application/json">(.*?)</script>',
                                                    (folder / 'index.html').read_text(), re.S).group(1))
                    self.assertEqual(model['site_context'], embedded['site_context'])
                    self.assertEqual(model['meshes'], generated[floor['id']]['meshes'])
                    self.assertEqual(model['site_context']['ground_elevation_m'], origin - floor['elevation_m'])
                    self.assertEqual(model['environment']['elevation'], origin - floor['elevation_m'])
                    self.assertAlmostEqual(model['site_context']['lowest_slab_elevation_m'] + floor['elevation_m'], absolute_slab)
                    models.append(model)
                # Use the actual browser-side pure math against compiler outputs;
                # no browser, tiles or copied map-plane formula are involved.
                script = """const fs=require('node:fs'),vm=require('node:vm');
const math=vm.runInNewContext(fs.readFileSync('map-layer.js','utf8')+';homeMapMath');
const models=JSON.parse(fs.readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify(models.map(m=>math.context(m).elevation+m.elevation_m)));"""
                result = subprocess.run(['node', '-e', script], cwd=ROOT, input=json.dumps(models),
                                        text=True, capture_output=True, check=True, timeout=15)
                for height in json.loads(result.stdout):
                    self.assertAlmostEqual(height, absolute_slab - .08, places=10)

if __name__ == '__main__':
    unittest.main()
