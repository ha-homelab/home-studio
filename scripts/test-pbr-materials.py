#!/usr/bin/env python3
"""Independent channel, units, export and resource-budget regressions."""
import base64
import copy
import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import struct
import sys
import unittest
from unittest.mock import patch
import zipfile
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from pbr_materials import DETAIL_PROFILES, detail_pixels, png_spec, rgb_pixels, export_material_fields
from material_textures import validate_material_textures, decode_material_texture
from exporters import export_scene
spec=importlib.util.spec_from_file_location('legacy',ROOT/'scripts/test-material-textures.py');legacy=importlib.util.module_from_spec(spec);spec.loader.exec_module(legacy)


def fixture():
    mesh={'material':'surface','surface_finish':'metal','color':[.3,.4,.5,1], 'vertices':[[0,0,0],[1,0,0],[0,1,0]],'normals':[[0,0,1]]*3,'indices':[0,1,2],'uv':[[0,0],[1,0],[0,1]]}
    normal=png_spec(bytes([140,80,245])*128*128)
    orm=png_spec(bytes([160,190,240])*128*128)
    return mesh,normal,orm


def document(raw):
    length=struct.unpack_from('<I',raw,12)[0]
    return json.loads(raw[20:20+length]),raw[28+length:]


class PBRTests(unittest.TestCase):
    def test_compiler_retains_indexed_smooth_geometry_and_physical_uvs(self):
        from planner.project import make_floor
        project=json.loads((ROOT/'planner/example-home.json').read_text())
        floor=project['floors'][0]
        item=copy.deepcopy(floor['items'][0])
        item.update(model_id='synthetic', position_m={'x':2,'y':.5,'z':3},
                    dimensions_m={'width':2,'height':3,'depth':4}, rotation_deg=37)
        floor['items']=[item]
        n=math.sqrt(.5)
        part={'name':'smooth','material':'surface','kind':'inventory',
              'vertices':[[-.5,0,-.5],[-.5,0,.5],[.5,0,-.5],[.5,0,.5]],
              'normals':[[n,n,0],[0,n,n],[-n,n,0],[0,n,-n]],
              'indices':[0,1,2,2,1,3], 'uv':[[0,0],[0,1],[1,0],[1,1]],
              'uv_dimensions':['width','depth'],'surface_finish':'fabric',
              'material_family':'fabric','material_uv_scale':.25,'normal_scale':.6}
        asset={'meshes':[part],'materials':{'surface':[.3,.4,.5,1]}}
        original=copy.deepcopy(asset)
        with patch('planner.project.build_furniture_asset',return_value=asset):
            model,_=make_floor(project,floor,None)
        placed=next(m for m in model['meshes'] if m.get('item_id')==item['id'])
        self.assertEqual(asset,original)
        self.assertEqual(placed['indices'],part['indices'])
        self.assertEqual(len(placed['vertices']),4)
        self.assertEqual(placed['uv'],[[0,0],[0,4],[2,0],[2,4]])
        self.assertNotIn('uv_dimensions',placed)
        for field in ('surface_finish','material_family','material_uv_scale','normal_scale'):
            self.assertEqual(placed[field],part[field])
        c,s=math.cos(math.radians(37)),math.sin(math.radians(37))
        for source,normal in zip(part['normals'],placed['normals']):
            x,y,z=source[0]/2,source[1]/3,source[2]/4
            expected=[c*x+s*z,y,-s*x+c*z]
            length=math.sqrt(sum(v*v for v in expected))
            for actual,want in zip(normal,expected):self.assertAlmostEqual(actual,want/length,places=12)
        self.assertEqual(model['object_assets'][item['id']]['meshes'],original['meshes'])

    def test_all_channels_and_color_roles(self):
        mesh,normal,orm=fixture();mesh.update(normal_texture='n',roughness_texture='orm',metalness_texture='orm',ao_texture='orm',normal_scale=.4,ao_strength=.7)
        model={'materials':{'surface':[1,1,1,1]},'meshes':[mesh],'material_textures':{'n':normal,'orm':orm}}
        self.assertEqual(len(validate_material_textures(model)),2)
        with patch('material_textures.MAX_MATERIAL_TEXTURE_PIXELS',128*128*2): validate_material_textures(model)
        mesh['albedo_texture']='orm'
        with patch('material_textures.MAX_MATERIAL_TEXTURE_PIXELS',128*128*2):
            with self.assertRaises(ValueError): validate_material_textures(model)
        for key,value in [('normal_scale',3),('ao_strength',float('nan')),('albedo_tint',1),('normal_texture','absent')]:
            bad=copy.deepcopy(model);bad['meshes'][0][key]=value
            with self.assertRaises(ValueError): validate_material_textures(bad)

    def test_bounded_resolution_aliases_and_alpha(self):
        for size in [128,256,512,1024]:
            image=png_spec(bytes([120,130,140])*size*size,size)
            self.assertEqual(len(rgb_pixels(image)),size*size*3)
        mesh,normal,_=fixture();mesh['normal_texture']='n'
        model={'materials':{'surface':[1,1,1,.4]},'meshes':[mesh],'material_textures':{f'n{i}':normal for i in range(127)}|{'n':normal}}
        with patch('material_textures.MAX_MATERIAL_TEXTURE_PIXELS',128*128): validate_material_textures(model)
        model['material_textures']['overflow']=normal
        with self.assertRaises(ValueError): validate_material_textures(model)
        del model['material_textures']['overflow'];mesh['albedo_texture']='n'
        with self.assertRaises(ValueError): validate_material_textures(model)

    def test_family_uses_physical_units_and_never_overwrites_color(self):
        mesh,normal,_=fixture();mesh['material_family']='fabric'
        fields=export_material_fields(mesh,{})
        self.assertNotIn('texture',fields);self.assertEqual(fields['pbr_repeats']['normal_texture'],40)
        scaled=export_material_fields(mesh|{'material_uv_scale':.25},{})
        self.assertEqual(scaled['pbr_repeats']['normal_texture'],10)
        mesh['normal_texture']='authored';fields=export_material_fields(mesh,{'authored':normal})
        self.assertEqual(fields['normal_texture'],normal);self.assertNotIn('normal_texture',fields['pbr_repeats'])
        self.assertEqual(export_material_fields({'material_family':'mirror'},{}),{'material_family':'mirror'})
        for family in DETAIL_PROFILES:
            pixels,_=detail_pixels(family)
            for i in range(0,len(pixels),801):
                j=i-i%3;v=[(x/255)*2-1 for x in pixels[j:j+3]]
                self.assertAlmostEqual(sum(x*x for x in v),1,delta=.015)

    def test_glb_channels_normal_handedness_and_obj_portability(self):
        mesh,normal,orm=fixture();mesh.update(normal_texture=normal,roughness_texture=orm,metalness_texture=orm,ao_texture=orm,normal_scale=.4,ao_strength=.7)
        group={'name':'Synthetic','translation':[0,0,0],'scale':[1,2,3],'rotation':0,'meshes':[mesh]}
        floors=[{'name':'Floor','elevation':0,'groups':[group]}]
        doc,blob=document(export_scene(floors,'glb'));mat=doc['materials'][0]
        self.assertEqual(mat['normalTexture']['scale'],.4);self.assertEqual(mat['occlusionTexture']['strength'],.7)
        self.assertEqual(mat['pbrMetallicRoughness']['baseColorFactor'],[.3,.4,.5,1])
        self.assertEqual(len(doc['images']),2,'ORM image is shared by occlusion and metallic roughness')
        index=doc['textures'][mat['normalTexture']['index']]['source'];view=doc['bufferViews'][doc['images'][index]['bufferView']]
        data=blob[view['byteOffset']:view['byteOffset']+view['byteLength']]
        image={'mime_type':'image/png','width':128,'height':128,'data_uri':'data:image/png;base64,'+base64.b64encode(data).decode()}
        self.assertEqual(rgb_pixels(image)[:3],bytes([140,175,245]),'V-flip also reverses tangent bitangent')
        with zipfile.ZipFile(io.BytesIO(export_scene(floors,'obj'))) as archive:
            mtl=archive.read('materials.mtl').decode();self.assertIn('norm textures/',mtl);self.assertIn('map_Pr ',mtl);self.assertIn('map_Pm ',mtl);self.assertIn('map_Ka ',mtl)

    def test_compaction_retains_normal_only_uv_seams_and_material_groups(self):
        mesh,normal,orm=fixture();mesh.update(normal_texture=normal)
        mesh2=copy.deepcopy(mesh);mesh2['normal_scale']=.3
        group={'name':'Synthetic','translation':[0,0,0],'scale':[1,1,1],'rotation':0,'meshes':[mesh,mesh2]}
        doc,_=document(export_scene([{'name':'Floor','elevation':0,'groups':[group]}],'glb'))
        self.assertEqual(len(doc['materials']),2)
        for primitive in (m['primitives'][0] for m in doc['meshes']):self.assertIn('TEXCOORD_0',primitive['attributes'])

    def test_family_export_transform(self):
        mesh,_,_=fixture();mesh.update(export_material_fields({'material_family':'fabric'},{}))
        group={'name':'Synthetic','translation':[0,0,0],'scale':[1,1,1],'rotation':0,'meshes':[mesh]}
        doc,_=document(export_scene([{'name':'Floor','elevation':0,'groups':[group]}],'glb'))
        self.assertEqual(doc['extensionsUsed'],['KHR_texture_transform'])
        self.assertEqual(doc['materials'][0]['normalTexture']['extensions']['KHR_texture_transform']['scale'],[40,40])
        self.assertEqual(doc['materials'][0]['normalTexture']['extensions']['KHR_texture_transform']['offset'],[0,-39])

if __name__=='__main__':
    if '--hashes' in sys.argv:print(json.dumps({k:[hashlib.sha256(v).hexdigest() for v in detail_pixels(k)] for k in DETAIL_PROFILES}))
    else:unittest.main()
