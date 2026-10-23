#!/usr/bin/env python3
"""Optional real Blender import acceptance; requires the official bpy package.

Run with a Python environment matching bpy's supported Python version. Blender
is a test dependency only, never a Home Assistant installation dependency.
"""
import argparse
import copy
import json
from pathlib import Path
import sys
import tempfile
import zipfile

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from planner.project import export_floor, make_floor, render_model_export, validate_project


def bounds():
    points = [item.matrix_world @ Vector(point) for item in bpy.data.objects
              if item.type == 'MESH' for point in item.bound_box]
    return [[min(point[axis] for point in points) for axis in range(3)],
            [max(point[axis] for point in points) for axis in range(3)]]


def close(actual, expected, tolerance=1e-5):
    assert len(actual) == len(expected)
    assert all(abs(a - b) < tolerance for a, b in zip(actual, expected)), (actual, expected)


def verify(output):
    source = json.loads((ROOT / 'planner/guide-assets/practice-home.json').read_text())
    source['floors'][0]['items'][0]['rotation_deg'] = 37
    upper = copy.deepcopy(source['floors'][0])
    upper.update(id='upper', elevation_m=3.1)
    source['floors'].append(upper)
    source = validate_project(source)
    floors = [export_floor(make_floor(source, floor, None)[0], floor, elevated=True)
              for floor in source['floors']]
    for format, extension in [('glb', 'glb'), ('obj', 'zip')]:
        (output / ('two-floors.' + extension)).write_bytes(render_model_export(floors, format))

    bpy.ops.wm.read_factory_settings(use_empty=True)
    assert bpy.ops.import_scene.gltf(filepath=str(output / 'two-floors.glb')) == {'FINISHED'}
    bpy.context.view_layer.update()
    glb_bounds = bounds()
    floor = bpy.data.objects['Floor 2']
    close(floor.matrix_world.translation, (0, 0, 3.1))
    desk = bpy.data.objects['Writing desk 1']
    assert desk.type == 'EMPTY' and len(desk.children) == 8
    assert all(child.type == 'MESH' for child in desk.children)
    before = {child.name: child.matrix_world.translation.copy() for child in desk.children}
    desk.location.x += 1
    bpy.context.view_layer.update()
    for child in desk.children:
        close(child.matrix_world.translation - before[child.name], (1, 0, 0))
    desk.location.x -= 1
    bpy.context.view_layer.update()
    assert all(item.data.materials for item in bpy.data.objects if item.type == 'MESH')
    material_count = len(bpy.data.materials)
    mesh_count = len(bpy.data.meshes)
    bpy.ops.wm.save_as_mainfile(filepath=str(output / 'two-floors.blend'))

    with zipfile.ZipFile(output / 'two-floors.zip') as archive:
        assert set(archive.namelist()) == {'home.obj', 'materials.mtl'}
        archive.extractall(output)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    assert bpy.ops.wm.obj_import(filepath=str(output / 'home.obj'),
                                 forward_axis='Y', up_axis='Z') == {'FINISHED'}
    bpy.context.view_layer.update()
    obj_bounds = bounds()
    for actual, expected in zip(obj_bounds, glb_bounds):
        close(actual, expected)
    desks = [item for item in bpy.data.objects if 'Writing desk 1' in item.name]
    assert len(desks) == 2 and all(item.type == 'MESH' for item in desks)
    assert all(item.data.materials for item in bpy.data.objects if item.type == 'MESH')
    report = {'blender': bpy.app.version_string, 'status': 'passed',
              'glb_meshes': mesh_count, 'glb_materials': material_count,
              'floor_elevation_m': 3.1, 'grouped_desk_parts': 8,
              'glb_bounds_m': glb_bounds, 'obj_bounds_match_glb': True,
              'moving_parent_moves_all_parts': True}
    (output / 'blender-import.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, help='New directory for synthetic models and report')
    args = parser.parse_args()
    if args.output:
        args.output.mkdir(parents=True, exist_ok=False)
        verify(args.output.resolve())
    else:
        with tempfile.TemporaryDirectory(prefix='home-studio-blender-') as folder:
            verify(Path(folder))
