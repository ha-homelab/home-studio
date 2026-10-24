#!/usr/bin/env python3
"""CPU interchange tests for explicit PBR bundle exports."""
import copy
import hashlib
import json
import math
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
from physical_exports import prepare, number, export_physical_scene, package_physical_usd


def dae_corners(tree):
    ns={'c':'http://www.collada.org/2005/11/COLLADASchema'}
    ids={node.get('id'):node for node in tree.iter() if node.get('id')}
    result=[]
    for geometry in tree.findall('.//c:geometry',ns):
        triangles=geometry.find('c:mesh/c:triangles',ns);inputs=triangles.findall('c:input',ns)
        raw=list(map(int,triangles.find('c:p',ns).text.split()));width=max(int(v.get('offset')) for v in inputs)+1
        channels={}
        for value in inputs:
            semantic=value.get('semantic');source=ids[value.get('source')[1:]]
            if semantic=='VERTEX':source=ids[source.find('c:input',ns).get('source')[1:]]
            accessor=source.find('c:technique_common/c:accessor',ns)
            data=list(map(float,ids[accessor.get('source')[1:]].text.split()));stride=int(accessor.get('stride'))
            offset=int(value.get('offset'))
            channels[(semantic,value.get('set'))]=[tuple(data[i*stride:(i+1)*stride]) for i in raw[offset::width]]
        result.append(channels)
    return result


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
            corners=dae_corners(tree)[0]
            self.assertEqual(corners[('VERTEX',None)],[(0,0,0),(1,0,0),(0,0,1)])
            self.assertEqual(corners[('NORMAL',None)],[(0,-1,0)]*3)
            self.assertEqual(corners[('TEXCOORD','0')],[(0,0),(1.5625,0),(0,1.5625)])
            self.assertEqual(corners[('TEXCOORD','1')],[(0,0),(1,0),(0,1)])
            for value in tree.findall('.//c:image/c:init_from',ns):self.assertTrue((root/value.text).is_file())
            if shutil.which('usdcat'):
                subprocess.run(['usdcat',str(root/'test_model.usda'),'-o',str(root/'test_model.usdc')],check=True,capture_output=True)
                result=subprocess.run(['usdchecker','--arkit',str(root/'test_model.usdc')],capture_output=True,text=True)
                self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertEqual(data,before)

    def test_grouped_scene_transforms_and_shared_array_corners(self):
        source=prepare(fixture())[0][1]
        source['normals']=[[2**-.5,2**-.5,0]]*3
        floors=[{'name':'Floor','elevation':4,'groups':[{'name':'Placed object','translation':[2,3,5],
                 'scale':[2,3,4],'rotation':math.pi/2,'meshes':[source,source]}]}]
        before=copy.deepcopy(floors)
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);result=export_physical_scene(floors,root,'scene')
            self.assertTrue(all(p.is_file() for p in result['paths']))
            tree=ET.parse(root/'scene.dae');corners=dae_corners(tree)
            self.assertEqual(corners[0],corners[1])
            for actual,wanted in zip(corners[0][('VERTEX',None)],[(2,-5,7),(2,-3,7),(2,-5,10)]):
                for a,b in zip(actual,wanted):self.assertAlmostEqual(a,b,places=6)
            normal=(0,3/math.sqrt(13),2/math.sqrt(13))
            for a,b in zip(corners[0][('NORMAL',None)][0],normal):self.assertAlmostEqual(a,b,places=6)
            ns={'c':'http://www.collada.org/2005/11/COLLADASchema'}
            self.assertLess(len(tree.findall('.//c:float_array',ns)),len(tree.findall('.//c:source',ns)))
            raw=(root/'scene.glb').read_bytes();length=struct.unpack_from('<I',raw,12)[0];glb=json.loads(raw[20:20+length])
            self.assertEqual(glb['nodes'][0]['translation'],[0,4,0]);self.assertEqual(glb['nodes'][1]['scale'],[2,3,4])
            if shutil.which('usdcat') and shutil.which('usdchecker'):
                generated=package_physical_usd(root,'scene',usdcat=Path(shutil.which('usdcat')))
                self.assertTrue(all(p.is_file() for p in generated['paths']))
                check=subprocess.run(['usdchecker','--arkit',str(root/'scene.usdz')],capture_output=True,text=True)
                self.assertEqual(check.returncode,0,check.stdout+check.stderr)
        self.assertEqual(floors,before)

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
