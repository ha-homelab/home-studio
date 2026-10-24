#!/usr/bin/env python3
"""CPU interchange tests for explicit PBR bundle exports."""
import base64
import copy
import hashlib
import json
import random
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from exporters import export_models
from pbr_materials import png_spec
from physical_exports import prepare, number


def fixture():
    mesh={'name':'cloth_panel','kind':'fixture','material':'cloth','surface_finish':'fabric',
          'vertices':[[0,0,0],[1,0,0],[0,1,0]],'normals':[[0,0,1]]*3,'indices':[0,1,2],
          'uv':[[0,0],[1,0],[0,1]],'material_family':'fabric','material_uv_scale':.25,
          'normal_texture':'normal','roughness_texture':'orm','metalness_texture':'orm',
          'ao_texture':'orm','normal_scale':.5,'ao_strength':.6}
    return {'id':'test_model','title':'Test model','ceiling_height_m':2.7,'materials':{'cloth':[.3,.4,.5,1]},
            'meshes':[mesh], 'material_textures':{'normal':png_spec(bytes([140,100,245])*128*128),
                                                'orm':png_spec(bytes([160,180,220])*128*128)}}


class PhysicalExports(unittest.TestCase):
    def test_decimal_encoding_round_trips_float32_exactly(self):
        rng=random.Random(912)
        for value in [0.,-0.,1.,-1.,1.234,.0000001]+[rng.uniform(-4096,4096) for _ in range(5000)]:
            expected=struct.pack('<f',value)
            actual=struct.pack('<f',float(number(value)))
            self.assertEqual(actual, expected if value else struct.pack('<f',0))

    def test_physical_bundle_preserves_maps_coordinates_and_source_identity(self):
        data=fixture();before=copy.deepcopy(data)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);export_models(data,root,'test_model',physical=True)
            raw=(root/'test_model.glb').read_bytes();length=struct.unpack_from('<I',raw,12)[0];glb=json.loads(raw[20:20+length])
            self.assertEqual(glb['meshes'][0]['extras']['source_mesh'],'cloth_panel')
            self.assertEqual(glb['materials'][0]['extras']['source_materials'],['cloth'])
            self.assertIn('TEXCOORD_0',glb['meshes'][0]['primitives'][0]['attributes'])
            mat=glb['materials'][0]
            self.assertIn('baseColorTexture',mat['pbrMetallicRoughness']);self.assertIn('metallicRoughnessTexture',mat['pbrMetallicRoughness'])
            self.assertEqual(mat['normalTexture']['scale'],.5);self.assertEqual(mat['occlusionTexture']['strength'],.6)
            manifest=json.loads((root/'test_model.exports.json').read_text())
            for name,digest in manifest['textures'].items():
                self.assertEqual(hashlib.sha256((root/name).read_bytes()).hexdigest(),digest)
            obj=(root/'test_model.obj').read_text();mtl=(root/'test_model.mtl').read_text()
            self.assertIn('mtllib test_model.mtl',obj);self.assertIn('usemtl cloth__0',obj);self.assertIn('vt ',obj);self.assertIn('vn ',obj)
            for field in ('map_Kd','norm','map_Pr','map_Pm','map_Ka'):self.assertIn(field+' ',mtl)
            usd=(root/'test_model.usda').read_text()
            for token in ('UsdPreviewSurface','UsdUVTexture','primvars:st','inputs:normal.connect','inputs:metallic.connect','inputs:roughness.connect','inputs:occlusion.connect'):
                self.assertIn(token,usd)
            self.assertIn('float4 inputs:scale=(1,1,2,1)',usd)
            self.assertIn('float4 inputs:bias=(-0.5,-0.5,-1,0)',usd)
            self.assertIn('token inputs:sourceColorSpace="raw"',usd)
            tree=ET.parse(root/'test_model.dae');ns={'c':'http://www.collada.org/2005/11/COLLADASchema'}
            self.assertTrue(tree.findall('.//c:input[@semantic="NORMAL"]',ns))
            self.assertTrue(tree.findall('.//c:input[@semantic="TEXCOORD"]',ns))
            self.assertTrue(tree.findall('.//c:diffuse/c:texture',ns))
            geometry=tree.find('.//c:geometry/c:mesh',ns)
            triangles=geometry.find('c:triangles',ns)
            indices=[int(v) for v in triangles.find('c:p',ns).text.split()]
            self.assertEqual(indices,data['meshes'][0]['indices'])
            self.assertTrue(all(value.get('offset')=='0' for value in triangles.findall('c:input',ns)))
            arrays={node.get('id'):[float(v) for v in node.find('c:float_array',ns).text.split()] for node in geometry.findall('c:source',ns)}
            self.assertEqual(arrays['geometry_0_position'],[0,0,0,1,0,0,0,0,1])
            self.assertEqual(arrays['geometry_0_normal'],[0,-1,0]*3)
            self.assertEqual(arrays['geometry_0_uv0'],[0,0,1.5625,0,0,1.5625])
            self.assertEqual(arrays['geometry_0_uv1'],[0,0,1,0,0,1])
            for value in tree.findall('.//c:image/c:init_from',ns):self.assertTrue((root/value.text).is_file())
            if shutil.which('usdcat'):
                subprocess.run(['usdcat',str(root/'test_model.usda'),'-o',str(root/'test_model.usdc')],check=True,capture_output=True)
                result=subprocess.run(['usdchecker','--arkit',str(root/'test_model.usdc')],capture_output=True,text=True)
                self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertEqual(data,before)

    def test_deterministic_export_and_explicit_legacy_opt_in(self):
        data=fixture()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);export_models(data,root,'test_model')
            legacy={p.name:p.read_bytes() for p in root.iterdir()}
            self.assertNotIn('primvars:st',legacy['test_model.usda'].decode())
            export_models(data,root,'test_model',physical=False)
            self.assertEqual(legacy,{p.name:p.read_bytes() for p in root.iterdir()})
            export_models(data,root,'test_model',physical=True)
            physical={p.relative_to(root).as_posix():p.read_bytes() for p in root.rglob('*') if p.is_file()}
            export_models(data,root,'test_model',physical=True)
            self.assertEqual(physical,{p.relative_to(root).as_posix():p.read_bytes() for p in root.rglob('*') if p.is_file()})


if __name__=='__main__':unittest.main()
