#!/usr/bin/env python3
"""Check architectural context isolation, alignment and compiler selection."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from geometry import create_geometry, floor_context
from planner.project import compile_project

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

if __name__ == '__main__':
    unittest.main()
