#!/usr/bin/env python3
"""Independent channel, units, export and resource-budget regressions."""
import base64
import copy
import hashlib
import importlib.util
import io
import json
import math
import random
from pathlib import Path
import struct
import sys
import unittest
from unittest.mock import patch
import zipfile
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from pbr_materials import DETAIL_PROFILES, detail_pixels, png_spec, rgb_pixels, export_material_fields, color_profile, color_luminance
from material_textures import validate_material_textures
from exporters import export_scene, _obj_number
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
    def test_compact_color_carrier_preserves_original_source_pixels(self):
        # Frozen hashes were measured before replacing the RGB carrier. They
        # guard exact detail and contrast, not merely Python/JS agreement.
        expected = {
            'wood': ('3f3e744abb4ae7e3201bee60003edd2423400ccdadf6df9b121c70e30f2c3d65', 'eb7f667099e4ea6073c676746d8c9cdbc5cb4ceb2423f7a9b1167cb92f375857'),
            'fabric': ('23d4a8a031676651bd74908b7acc8603acd00dc219fe6bb90501e6ef9bbe604a', '2339e80eeefac6d2fb2359f433b732cdae1e2461bc1ba286372d1736c58c3321'),
        }
        for family, (luma_hash, albedo_hash) in expected.items():
            profile = color_profile(family)
            luma = bytes(color_luminance(profile))
            self.assertEqual(len(luma), 128 * 128)
            self.assertEqual(hashlib.sha256(luma).hexdigest(), luma_hash)
            self.assertEqual(hashlib.sha256(detail_pixels(family)[2]).hexdigest(), albedo_hash)
        self.assertEqual(detail_pixels('wood')[2], detail_pixels('rough_wood')[2])

    def test_obj_numeric_precision_has_explicit_metric_and_angular_bounds(self):
        rng=random.Random(207)
        for value in [0.,-0.,.000004999,-.000004999,12.999995,-12.999995]+[rng.uniform(-4096,4096) for _ in range(2000)]:
            for kind in ('v','vt'):
                encoded=_obj_number(value,kind)
                self.assertNotIn(encoded,('', '-0'))
                self.assertLessEqual(abs(float(encoded)-value),.000005000001)
        for _ in range(2000):
            vector=[rng.uniform(-1,1) for _ in range(3)]
            length=math.hypot(*vector);normal=[v/length for v in vector]
            actual=[float(_obj_number(v,'vn')) for v in normal]
            cross=[normal[1]*actual[2]-normal[2]*actual[1],normal[2]*actual[0]-normal[0]*actual[2],normal[0]*actual[1]-normal[1]*actual[0]]
            angle=math.degrees(math.atan2(math.hypot(*cross),sum(a*b for a,b in zip(normal,actual))))
            self.assertLess(angle,.005)
        mesh,_,_=fixture()
        floors=[{'name':'Floor','elevation':0,'groups':[{'name':'Part','translation':[0,0,0],'scale':[1,1,1],'rotation':0,'meshes':[mesh]}]}]
        unchanged=copy.deepcopy(floors)
        with patch('exporters._obj_number',side_effect=AssertionError('OBJ encoding must not affect GLB')):
            export_scene(floors,'glb')
        self.assertEqual(floors,unchanged)

    def test_exports_reuse_exact_encoded_streams_without_merging_materials(self):
        a,normal,_=fixture();a['normal_texture']=normal
        b=copy.deepcopy(a);b['color']=[.7,.6,.5,1]
        b['vertices'][1][0]+=1e-12
        b['normals'][0][2]+=1e-12
        group={'name':'Synthetic','translation':[0,0,0],'scale':[1,1,1],'rotation':0,'meshes':[a,b]}
        floors=[{'name':'Floor','elevation':0,'groups':[group]}]
        doc,_=document(export_scene(floors,'glb'))
        first,second=[m['primitives'][0] for m in doc['meshes']]
        self.assertEqual(first['attributes'],second['attributes'])
        self.assertEqual(first['indices'],second['indices'])
        self.assertNotEqual(first['material'],second['material'])
        with zipfile.ZipFile(io.BytesIO(export_scene(floors,'obj'))) as archive:
            lines=archive.read('home.obj').decode().splitlines()
        self.assertEqual(len([line for line in lines if line.startswith('v ')]),3)
        self.assertEqual(len([line for line in lines if line.startswith('vn ')]),1)
        self.assertEqual(len([line for line in lines if line.startswith('vt ')]),3)
        faces=[line for line in lines if line.startswith('f ')]
        self.assertEqual(faces[0],faces[1])
        self.assertEqual(len([line for line in lines if line.startswith('usemtl ')]),2)

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
        self.assertTrue(fields['albedo_tint']);self.assertIn('texture',fields);self.assertEqual(fields['pbr_repeats']['normal_texture'],40)
        scaled=export_material_fields(mesh|{'material_uv_scale':.25},{})
        self.assertEqual(scaled['pbr_repeats']['normal_texture'],10)
        mesh['normal_texture']='authored';fields=export_material_fields(mesh,{'authored':normal})
        self.assertEqual(fields['normal_texture'],normal);self.assertNotIn('normal_texture',fields['pbr_repeats'])
        explicit=export_material_fields({'material_family':'fabric','albedo_texture':'authored'},{'authored':normal})
        self.assertEqual(explicit['texture'],normal)
        self.assertNotIn('albedo_tint',explicit)
        self.assertNotIn('texture',explicit['pbr_repeats'])
        self.assertEqual(export_material_fields({'material_family':'mirror'},{}),{'material_family':'mirror'})
        for family in DETAIL_PROFILES:
            pixels,*_=detail_pixels(family)
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
        mesh['color'][3]=.35
        doc,_=document(export_scene([{'name':'Floor','elevation':0,'groups':[group]}],'glb'))
        self.assertEqual(doc['materials'][0]['alphaMode'],'BLEND')
        self.assertEqual(doc['materials'][0]['pbrMetallicRoughness']['baseColorFactor'],[.3,.4,.5,.35])


def accessor_values(doc, binary, index):
    accessor = doc['accessors'][index]
    view = doc['bufferViews'][accessor['bufferView']]
    width = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[accessor['type']]
    code = {5121: 'B', 5123: 'H', 5125: 'I', 5126: 'f'}[accessor['componentType']]
    size = width * struct.calcsize(code)
    offset = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
    return [struct.unpack_from('<' + code * width, binary,
                               offset + i * view.get('byteStride', size))
            for i in range(accessor['count'])]


class TangentExportTests(unittest.TestCase):
    def mesh(self):
        mesh, normal, _ = fixture()
        mesh['normal_texture'] = normal
        return mesh

    def scene(self, *meshes):
        return [{'name': 'Floor', 'elevation': 2., 'groups': [
            {'name': 'Part', 'translation': [1., 2., 3.], 'scale': [2., 3., 4.],
             'rotation': .3, 'meshes': list(meshes)}]}]

    def frames(self, doc, binary):
        for mesh in doc['meshes']:
            primitive = mesh['primitives'][0]
            if 'normalTexture' not in doc['materials'][primitive['material']]:
                self.assertNotIn('TANGENT', primitive['attributes'])
                continue
            attributes = primitive['attributes']
            positions = accessor_values(doc, binary, attributes['POSITION'])
            normals = accessor_values(doc, binary, attributes['NORMAL'])
            tangents = accessor_values(doc, binary, attributes['TANGENT'])
            accessor = doc['accessors'][attributes['TANGENT']]
            self.assertEqual((accessor['type'], accessor['componentType']), ('VEC4', 5126))
            self.assertEqual(len(tangents), len(positions))
            self.assertEqual(len(normals), len(positions))
            for normal, tangent in zip(normals, tangents):
                self.assertTrue(all(math.isfinite(x) for x in tangent))
                self.assertAlmostEqual(math.hypot(*tangent[:3]), 1., places=6)
                self.assertLessEqual(abs(sum(n*t for n,t in zip(normal,tangent))), 1e-5)
                self.assertIn(tangent[3], (-1., 1.))
            indices = [i[0] for i in accessor_values(doc, binary, primitive['indices'])]
            for i in range(0, len(indices), 3):
                self.assertEqual(len({tangents[j][3] for j in indices[i:i+3]}), 1)

    def test_exported_flipped_and_rotated_uv_directions(self):
        a = self.mesh(); b = self.mesh(); b['uv'] = [[0,0], [0,1], [1,0]]
        source = self.scene(a,b); saved = copy.deepcopy(source)
        doc, binary = document(export_scene(source, 'glb')); self.frames(doc,binary)
        self.assertEqual(source, saved)
        for mesh, expected in zip(doc['meshes'], [(1.,0.,0.,-1.), (0.,1.,0.,1.)]):
            actual = accessor_values(doc,binary,mesh['primitives'][0]['attributes']['TANGENT'])
            self.assertEqual(actual, [expected]*3)
        self.assertEqual(doc['nodes'][1]['scale'], [2.,3.,4.])
        self.assertEqual(doc['nodes'][1]['translation'], [1.,2.,3.])
        # Positive nonuniform scale transforms N inversely and T directly.
        n=[.3,0,math.sqrt(.91)]; a['normals']=[n]*3
        d,raw=document(export_scene(self.scene(a),'glb')); self.frames(d,raw)
        attrs=d['meshes'][0]['primitives'][0]['attributes']
        normal=accessor_values(d,raw,attrs['NORMAL'])[0]
        tangent=accessor_values(d,raw,attrs['TANGENT'])[0]
        self.assertLessEqual(abs(sum((x/s)*(y*s) for x,y,s in zip(normal,tangent,[2,3,4]))),1e-5)

    def test_mirrored_uv_splits_only_opposite_handed_corners(self):
        m=self.mesh();m['vertices'] += [[0,-1,0]];m['normals'] += [[0,0,1]]
        m['uv'] += [[0,1]];m['indices']=[0,1,2,1,0,3];saved=copy.deepcopy(m)
        d,raw=document(export_scene(self.scene(m),'glb'));self.frames(d,raw)
        p=d['meshes'][0]['primitives'][0];a=p['attributes']
        self.assertEqual(d['accessors'][a['POSITION']]['count'],6)
        indices=[v[0] for v in accessor_values(d,raw,p['indices'])]
        actual=[(accessor_values(d,raw,a['POSITION'])[i], accessor_values(d,raw,a['NORMAL'])[i],
                 accessor_values(d,raw,a['TEXCOORD_0'])[i]) for i in indices]
        expected=[(tuple(m['vertices'][i]),tuple(m['normals'][i]),(m['uv'][i][0],1-m['uv'][i][1])) for i in m['indices']]
        self.assertEqual(actual,expected);self.assertEqual(m,saved)

    def test_degenerate_uv_area_and_crossing_normals_remain_finite(self):
        meshes=[]
        for field,value in [('uv',[[0,0]]*3),('uv',[[0,0],[1,0],[2,0]]),
                            ('vertices',[[0,0,0],[1,0,0],[2,0,0]]),
                            ('normals',[[0,0,1],[0,.6,.8],[0,.6,-.8]])]:
            m=self.mesh();m[field]=value;meshes.append(m)
        source=self.scene(*meshes);before=copy.deepcopy(source)
        one=export_scene(source,'glb');self.assertEqual(one,export_scene(source,'glb'))
        self.frames(*document(one));self.assertEqual(before,source)

    def test_parallel_and_threshold_sweep_stays_orthogonal(self):
        for z in (0.,1e-15,1e-12,1.4e-12,1.5e-12,2e-12,3e-12,1e-11,1e-9,1e-6):
            with self.subTest(z=z):
                m=self.mesh();m['vertices']=[[0,0,0],[1,1,0],[-1,1,0]]
                length=math.sqrt(2+z*z);m['normals']=[[1/length,1/length,z/length]]*3
                self.frames(*document(export_scene(self.scene(m),'glb')))

    def test_computed_tangent_precision_bound(self):
        rng=random.Random(817)
        for _ in range(150):
            # Plane normal has positive Z; the analytic dP/du is +X. Keep away
            # from the separate undefined near-parallel branch exercised below.
            n=[rng.uniform(-.6,.6),rng.uniform(-.6,.6),1.]
            length=math.hypot(*n);n=[x/length for x in n]
            m=self.mesh();m['normals']=[n]*3
            d,raw=document(export_scene(self.scene(m),'glb'))
            self.frames(d,raw)
            tangent=accessor_values(d,raw,d['meshes'][0]['primitives'][0]['attributes']['TANGENT'])[0]
            expected=[1-n[0]*n[0],-n[0]*n[1],-n[0]*n[2]]
            cross=[tangent[1]*expected[2]-tangent[2]*expected[1],
                   tangent[2]*expected[0]-tangent[0]*expected[2],
                   tangent[0]*expected[1]-tangent[1]*expected[0]]
            angle=math.atan2(math.hypot(*cross),sum(x*y for x,y in zip(tangent,expected)))
            self.assertLessEqual(angle,1e-5)

    def test_invalid_normals_and_nonfinite_source_reject(self):
        m=self.mesh();m['normals'][0]=[0,0,0]
        with self.assertRaisesRegex(ValueError,'nonzero'):export_scene(self.scene(m),'glb')
        for field in ('vertices','normals','uv'):
            m=self.mesh();m[field][0][0]=float('nan')
            with self.subTest(field=field), self.assertRaises(ValueError):export_scene(self.scene(m),'glb')

    def test_unused_vertices_are_compacted_before_tangent_generation(self):
        m=self.mesh();m['vertices'].append([9,9,9]);m['normals'].append([0,0,0]);m['uv'].append([9,9])
        d,raw=document(export_scene(self.scene(m),'glb'));self.frames(d,raw)
        self.assertEqual(d['accessors'][d['meshes'][0]['primitives'][0]['attributes']['POSITION']]['count'],3)

    def test_no_normal_map_skips_tangent_path(self):
        m,_,_=fixture()
        with patch('exporters._with_gltf_tangents',side_effect=AssertionError('no normal map')):
            d,_=document(export_scene(self.scene(m),'glb'))
            self.assertNotIn('TANGENT',d['meshes'][0]['primitives'][0]['attributes'])
            export_scene(self.scene(self.mesh()),'obj')

    def test_grouped_views_counts_alignment_and_exact_attributes(self):
        a=self.mesh();b=self.mesh();b['vertices'] += [[0,-1,0]];b['normals'] += [[0,0,1]]
        b['uv'] += [[0,-1]];b['indices']=[0,1,2,1,0,3]
        d,raw=document(export_scene(self.scene(a,b),'glb'));self.frames(d,raw)
        for source,mesh in zip((a,b),d['meshes']):
            p=mesh['primitives'][0]
            for semantic,field,width in [('POSITION','vertices',3),('NORMAL','normals',3),('TEXCOORD_0','uv',2)]:
                vals=source[field]
                if width==2:vals=[[u,1-v] for u,v in vals]
                encoded=[struct.unpack('<'+'f'*width,struct.pack('<'+'f'*width,*v)) for v in vals]
                self.assertEqual(accessor_values(d,raw,p['attributes'][semantic]),encoded)
        self.assertEqual(len([v for v in d['bufferViews'] if v.get('target')==34962]),3)
        for a in d['accessors']:
            v=d['bufferViews'][a['bufferView']];width={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']]
            size={5121:1,5123:2,5125:4,5126:4}[a['componentType']]*width
            self.assertEqual(v.get('byteOffset',0)%4,0);self.assertEqual(a.get('byteOffset',0)%4,0)
            self.assertLessEqual(a.get('byteOffset',0)+(a['count']-1)*v.get('byteStride',size)+size,v['byteLength'])
            if a['type']!='SCALAR':self.assertEqual(v['byteStride'],width*4)
            else:self.assertNotIn('byteStride',v)

    def test_position_bounds_match_encoded_float32_and_late_reuse(self):
        a=self.mesh();a['normals']=[[0,0,1],[0,1,0],[1,0,0]]
        b=self.mesh();b['vertices']=copy.deepcopy(a['normals'])
        c=self.mesh();c['vertices'][1][0]=1.123456789012345
        d,raw=document(export_scene(self.scene(a,b,c),'glb'))
        attrs=[m['primitives'][0]['attributes'] for m in d['meshes']]
        self.assertEqual(attrs[0]['NORMAL'],attrs[1]['POSITION'])
        for attr in attrs:
            acc=d['accessors'][attr['POSITION']];values=accessor_values(d,raw,attr['POSITION'])
            for name,operation in [('min',min),('max',max)]:
                for axis in range(3):self.assertEqual(struct.pack('<f',acc[name][axis]),struct.pack('<f',operation(v[axis] for v in values)))
        normal_only=d['accessors'][attrs[2]['NORMAL']]
        self.assertNotIn('min',normal_only);self.assertNotIn('max',normal_only)

    def test_index_width_boundaries_exclude_primitive_restart(self):
        for count,component in ((255,5121),(256,5123),(65535,5123),(65536,5125)):
            with self.subTest(count=count):
                m,_,_=fixture();m['vertices']=[[i,i%2,0] for i in range(count)]
                m['normals']=[[0,0,1]]*count;m.pop('uv');m['indices']=list(range(count))
                m['indices'] += [0]*(-count%3)
                d,raw=document(export_scene(self.scene(self.mesh(),m),'glb'))
                index=d['meshes'][1]['primitives'][0]['indices']
                self.assertEqual(d['accessors'][index]['componentType'],component)
                self.assertEqual([x[0] for x in accessor_values(d,raw,index)],m['indices'])

    def test_grouped_binary_and_final_json_limits_still_reject(self):
        source=self.scene(self.mesh())
        with patch('exporters.MAX_EXPORT_BYTES',64),self.assertRaisesRegex(ValueError,'32 MB'):
            export_scene(source,'glb')
        valid=export_scene(source,'glb');doc,_=document(valid)
        binary_bytes=doc['buffers'][0]['byteLength']
        with patch('exporters.MAX_EXPORT_BYTES',binary_bytes+32),self.assertRaisesRegex(ValueError,'32 MB'):
            export_scene(source,'glb')


if __name__=='__main__':
    if '--hashes' in sys.argv:print(json.dumps({k:[hashlib.sha256(v).hexdigest() for v in detail_pixels(k)] for k in DETAIL_PROFILES}))
    else:unittest.main()
