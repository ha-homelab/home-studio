#!/usr/bin/env python3
"""Check authored catalog geometry, materials, physical UVs and pattern surfaces."""
import collections
import copy
import math
import json
import subprocess
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import struct
import tempfile
import textwrap
import xml.etree.ElementTree as ET

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from planner.furniture import CATALOG, MODELS, primitive, build_furniture_asset


def area(mesh):
    total=0
    for i in range(0,len(mesh['indices']),3):
        a,b,c=(mesh['vertices'][j] for j in mesh['indices'][i:i+3])
        u=[b[k]-a[k] for k in range(3)];v=[c[k]-a[k] for k in range(3)]
        cross=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]
        total+=math.sqrt(sum(x*x for x in cross))/2
    return total


class AuthoredProfiles(unittest.TestCase):
    def test_every_stock_part_has_closed_oriented_refined_geometry(self):
        self.assertEqual(len(CATALOG['models']),211)
        for model in CATALOG['models']:
            for index,part in enumerate(model['parts']):
                with self.subTest(model=model['id'],part=index):
                    self.assertIn('surface_finish',part)
                    self.assertIn('geometry_profile',part)
                    mesh=primitive(part)
                    edges=collections.Counter();orientation=collections.Counter()
                    points=[tuple(round(v,9) for v in p) for p in mesh['vertices']]
                    volume=0
                    for i in range(0,len(points),3):
                        a,b,c=points[i:i+3]
                        for p,q in ((a,b),(b,c),(c,a)):
                            edge=tuple(sorted((p,q)))
                            self.assertNotEqual(p,q)
                            edges[edge]+=1;orientation[edge]+=1 if p<q else -1
                        volume+=(a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6
                    self.assertTrue(all(n==2 for n in edges.values()))
                    self.assertTrue(all(n==0 for n in orientation.values()))
                    self.assertGreater(volume,0)
                    legacy=primitive({k:v for k,v in part.items() if k!='geometry_profile'})
                    for axis in range(3):
                        for fn in (min,max):
                            self.assertAlmostEqual(fn(p[axis] for p in mesh['vertices']),fn(p[axis] for p in legacy['vertices']),places=10)

    def test_uv_metric_scale_and_user_palette_without_mutation(self):
        for model in CATALOG['models']:
            item={'type':model['type'],'model_id':model['id'],'color':'#a1b2c3','dimensions_m':model['dimensions_m'].copy()}
            before=copy.deepcopy(item); asset=build_furniture_asset(item)
            self.assertEqual(item,before)
            doubled=copy.deepcopy(item);doubled['dimensions_m']={k:2*v for k,v in item['dimensions_m'].items()}
            other=build_furniture_asset(doubled)
            self.assertIn('furniture_a1b2c3',asset['materials'])
            for part,mesh,twice in zip(model['parts'],asset['meshes'],other['meshes']):
                self.assertEqual(mesh['surface_finish'],part['surface_finish'])
                self.assertEqual(mesh['material_family'],part['surface_finish'])
                self.assertEqual(len(mesh['vertices']),len(mesh['uv']))
                self.assertEqual(mesh['vertices'],twice['vertices'])
                for pair,scaled in zip(mesh['uv'],twice['uv']):
                    self.assertTrue(all(math.isfinite(v) for v in pair))
                    for a,b in zip(pair,scaled):self.assertAlmostEqual(2*a,b,places=10)
                self.assertNotIn('albedo_texture',mesh)

    def test_patterns_replace_only_inset_central_surface(self):
        for model in CATALOG['models']:
            if not any(p.get('pattern_face') for p in model['parts']):continue
            item={'type':model['type'],'model_id':model['id']}
            plain=build_furniture_asset(item)
            for pattern in ('checks','herringbone'):
                textured=build_furniture_asset({**item,'pattern_id':pattern})
                self.assertAlmostEqual(sum(area(m) for m in plain['meshes']),sum(area(m) for m in textured['meshes']),places=8,msg=model['id'])
                for mesh in textured['meshes']:
                    self.assertEqual(len(mesh['uv']),len(mesh['vertices']))

    def test_organic_sections_are_closed_smooth_and_cross_language(self):
        sections=[{'center':[0,-1,0],'radius':[0,0]},
                  {'center':[0,-.8,0],'radius':[.6,.7]},
                  {'center':[.1,0,.1],'radius':[1,.8]},
                  {'center':[0,.8,0],'radius':[.4,.5]},
                  {'center':[0,1,0],'radius':[0,0]}]
        part={'shape':'cylinder','geometry_profile':'organic','center':[.03,.5,-.02],
              'size':[.6,.9,.4],'rotation_deg':[13,-22,34], 'geometry_sections':sections}
        mesh=primitive(part)
        script="import {primitive} from './planner/furniture.js';console.log(JSON.stringify(primitive("+json.dumps(part)+")));"
        other=json.loads(subprocess.check_output(['node','--input-type=module','-e',script],cwd=ROOT))
        self.assertEqual(mesh['indices'],other['indices'])
        for key in ('vertices','normals'):
            for a,b in zip(mesh[key],other[key]):
                for x,y in zip(a,b):self.assertAlmostEqual(x,y,places=11)
        edges=collections.Counter();volume=0
        for i in range(0,len(mesh['vertices']),3):
            a,b,c=(tuple(round(v,10) for v in p) for p in mesh['vertices'][i:i+3])
            for x,y in ((a,b),(b,c),(c,a)):edges[(x,y)]+=1
            volume+=(a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6
        self.assertGreater(volume,0)
        for (a,b),count in edges.items():self.assertEqual(count,edges[(b,a)])
        for normal in mesh['normals']:self.assertAlmostEqual(math.sqrt(sum(v*v for v in normal)),1,places=10)
        for bad in ([sections[0]]*3,sections[:2],sections+[sections[-1]],
                    [{**sections[0],'radius':[.2,.2]}]+sections[1:]):
            with self.assertRaises(ValueError):primitive({**part,'geometry_sections':bad})

    def test_vehicle_surfaces_and_browser_corner_parity(self):
        models=[m for m in CATALOG['models'] if m['category']=='vehicles']
        items=[{'model_id':m['id'],'type':m['type']} for m in models]
        source="import {buildFurnitureAsset} from './planner/furniture.js';console.log(JSON.stringify("+json.dumps(items)+".map(buildFurnitureAsset)));"
        browser=json.loads(subprocess.check_output(['node','--input-type=module','-e',source],cwd=ROOT))
        for model,item,other in zip(models,items,browser):
            with self.subTest(model=model['id']):
                self.assertLessEqual(len(model['parts']),32)
                self.assertFalse(any(p['geometry_profile']=='greenhouse' for p in model['parts']))
                glass=[p for p in model['parts'] if p['surface_finish']=='glass']
                self.assertEqual(len(glass),1)
                self.assertIn('geometry_shells',glass[0])
                actual=build_furniture_asset(item)
                self.assertEqual(actual['materials'].keys(),other['materials'].keys())
                for name,rgba in actual['materials'].items():
                    other_rgba=other['materials'][name]
                    self.assertEqual(len(rgba),4);self.assertEqual(len(other_rgba),4)
                    self.assertTrue(all(math.isfinite(v) for v in [*rgba,*other_rgba]))
                    self.assertEqual(rgba[3],other_rgba[3])
                    # sRGB power functions can differ in their last double bits by platform.
                    for a,b in zip(rgba[:3],other_rgba[:3]):self.assertAlmostEqual(a,b,places=12)
                for a,b in zip(actual['meshes'],other['meshes']):
                    self.assertEqual(len(a['indices']),len(b['indices']))
                    for key in ('vertices','normals','uv'):
                        tolerance=2e-12*(max(model['dimensions_m'].values()) if key=='uv' else 1)
                        for i,j in zip(a['indices'],b['indices']):
                            for x,y in zip(a[key][i],b[key][j]):self.assertLessEqual(abs(x-y),tolerance)

    def test_vehicle_ring_input_is_bounded_and_unambiguous(self):
        source=next(p for p in MODELS['tesla_model_3']['parts'] if p['geometry_profile']=='vehicle_shell')
        for bad in ({'geometry_rings':[]},{'geometry_rings':source['geometry_rings']*7},
                    {'geometry_shells':[source['geometry_rings']]},
                    {'geometry_rings':[[[math.nan,0,0]]*4]*2}):
            with self.subTest(bad=list(bad)):
                with self.assertRaises(ValueError):primitive({**source,**bad})

    def test_bath_openings_are_recessed_geometry_not_dark_discs(self):
        for model_id,z,limit in [('bathtub',0,.30),('toilet',.17,.45)]:
            asset=build_furniture_asset({'model_id':model_id,'type':'furniture'})
            hits=[]
            for mesh in asset['meshes']:
                for i in range(0,len(mesh['indices']),3):
                    a,b,c=[mesh['vertices'][j] for j in mesh['indices'][i:i+3]]
                    det=(b[2]-c[2])*(a[0]-c[0])+(c[0]-b[0])*(a[2]-c[2])
                    if abs(det)<1e-14:continue
                    u=((b[2]-c[2])*(-c[0])+(c[0]-b[0])*(z-c[2]))/det
                    v=((c[2]-a[2])*(-c[0])+(a[0]-c[0])*(z-c[2]))/det
                    w=1-u-v
                    if min(u,v,w)>=-1e-10:hits.append(u*a[1]+v*b[1]+w*c[1])
            self.assertTrue(hits,model_id)
            self.assertLess(max(hits),limit,model_id+' opening must reach a recessed cavity')
            self.assertTrue(any(p['geometry_profile']=='molded_shell' for p in MODELS[model_id]['parts']))

    def test_wood_grain_follows_tabletop_and_leg_axes(self):
        model=MODELS['dining_table'];asset=build_furniture_asset({'type':model['type'],'model_id':model['id']})
        scale=[model['dimensions_m'][k] for k in ('width','height','depth')]
        tested=0
        for mesh in asset['meshes']:
            if mesh['surface_finish']!='wood':continue
            extent=[(max(p[i] for p in mesh['vertices'])-min(p[i] for p in mesh['vertices']))*scale[i] for i in range(3)]
            axis=max(range(3),key=lambda i:extent[i])
            for p,n,uv in zip(mesh['vertices'],mesh['normals'],mesh['uv']):
                if abs(n[axis])<1e-8:
                    self.assertAlmostEqual(uv[0],p[axis]*scale[axis],places=10);tested+=1
        self.assertGreater(tested,20)

    def test_authoring_is_idempotent(self):
        spec=importlib.util.spec_from_file_location('authoring',ROOT/'scripts/author-furniture-profiles.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        once=module.author(copy.deepcopy(CATALOG));twice=module.author(copy.deepcopy(once))
        self.assertEqual(once,twice)
        self.assertEqual(once,CATALOG)

    def test_glass_alpha_does_not_alias_same_rgb_opaque_parts(self):
        original = MODELS['glass_railing']
        opaque = copy.deepcopy(original)
        for part in opaque['parts']:
            part.pop('opacity', None)
        for style in CATALOG['styles']:
            item = {'model_id':'glass_railing', 'type':original['type'],
                    'style_id':style['id'], 'color':style['materials']['glass']}
            with patch.dict(MODELS, {'glass_railing':opaque}):
                before = build_furniture_asset(item)
            after = build_furniture_asset(item)
            for index, (a, b) in enumerate(zip(before['meshes'], after['meshes'])):
                self.assertEqual({k:v for k,v in a.items() if k != 'material'},
                                 {k:v for k,v in b.items() if k != 'material'})
                first, second = before['materials'][a['material']], after['materials'][b['material']]
                self.assertEqual(first[:3], second[:3])
                self.assertEqual(second[3], .3 if index in (2,3) else 1)
                if index not in (2,3): self.assertEqual(a['material'], b['material'])
            self.assertNotEqual(after['meshes'][0]['material'], after['meshes'][2]['material'])
        for model_id in ('laptop','computer_monitor','microwave','round_frame_mirror','sofa_3'):
            asset = build_furniture_asset({'model_id':model_id,'type':MODELS[model_id]['type']})
            self.assertTrue(all(rgba[3] == 1 for rgba in asset['materials'].values()), model_id)

    def test_glass_browser_compiler_rgba_and_corner_parity(self):
        item = {'model_id':'glass_railing','type':MODELS['glass_railing']['type']}
        source = "import {buildFurnitureAsset} from './planner/furniture.js';console.log(JSON.stringify(buildFurnitureAsset(" + json.dumps(item) + ")));"
        other = json.loads(subprocess.check_output(['node','--input-type=module','-e',source],cwd=ROOT))
        actual = build_furniture_asset(item)
        self.assertEqual(actual['materials'].keys(), other['materials'].keys())
        for key, rgba in actual['materials'].items():
            self.assertEqual(rgba[3], other['materials'][key][3])
            for a,b in zip(rgba[:3], other['materials'][key][:3]): self.assertAlmostEqual(a,b,places=12)
        for a,b in zip(actual['meshes'],other['meshes']):
            self.assertEqual(a['indices'],b['indices']);self.assertEqual(a['material'],b['material'])
            for key in ('vertices','normals','uv'):
                for x,y in zip(a[key],b[key]):
                    for i,j in zip(x,y): self.assertAlmostEqual(i,j,places=11)

    def test_catalog_opacity_is_valid_and_browser_catalog_reproducible(self):
        spec=importlib.util.spec_from_file_location('catalog_validator',ROOT/'scripts/generate-furniture-catalog.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        cat=copy.deepcopy(CATALOG);cat['models']=[copy.deepcopy(MODELS['glass_railing'])]
        module.validate_catalog(cat)
        for value in (None,True,False,'0.3',math.nan,math.inf,-.1,1.1):
            cat['models'][0]['parts'][2]['opacity']=value
            with self.subTest(opacity=value), self.assertRaisesRegex(ValueError,'opacity'):
                module.validate_catalog(cat)
        expected='// Generated by scripts/generate-furniture-catalog.py; edit catalog.json.\nexport const CATALOG = '+json.dumps(CATALOG,ensure_ascii=False,separators=(',',':'))+';\n'
        self.assertEqual((ROOT/'planner/catalog.js').read_text(),expected)

    def test_glass_alpha_survives_svg_and_physical_export(self):
        import exporters
        asset=build_furniture_asset({'model_id':'glass_railing','type':MODELS['glass_railing']['type']})
        source=(ROOT/'planner/project.py').read_text()
        start=source.index('    for _, material, triangle in sorted(tops, key=lambda entry: entry[0]):')
        end=source.index('    svg.append("</g></svg>")',start)
        for index, alpha in ((0,1),(2,.3)):
            part=asset['meshes'][index]
            scope={'tops':[(0,part['material'],[[0,0,0],[1,0,0],[0,0,1]])],
                   'svg':[],'materials':asset['materials'],'pixel':lambda point:point}
            exec(textwrap.dedent(source[start:end]),scope)
            polygon=ET.fromstring(scope['svg'][0])
            self.assertRegex(polygon.attrib['fill'],r'^#[0-9a-f]{6}$')
            self.assertEqual(float(polygon.attrib.get('fill-opacity','1')),alpha)
        meshes=copy.deepcopy([asset['meshes'][0],asset['meshes'][2]])
        data={'title':'Synthetic glass alpha fixture','meshes':meshes,'materials':asset['materials']}
        with tempfile.TemporaryDirectory() as directory:
            output=Path(directory);exporters.export_models(data,output,'glass',physical=True)
            raw=(output/'glass.glb').read_bytes();length=struct.unpack_from('<I',raw,12)[0]
            document=json.loads(raw[20:20+length])
            self.assertEqual(sorted(m['alphaMode'] for m in document['materials']),['BLEND','OPAQUE'])
            self.assertEqual(sorted(m['pbrMetallicRoughness']['baseColorFactor'][3] for m in document['materials']),[.3,1])
            alpha=[float(line[2:]) for line in (output/'glass.mtl').read_text().splitlines() if line.startswith('d ')]
            self.assertEqual(sorted(alpha),[.3,1])

    def test_semantic_material_exceptions(self):
        cases={'christmas_tree':{0:'wood',7:'metal',10:'glass'},'television':{1:'glass'},'table_setting':{0:'fabric',1:'ceramic',13:'glass'},
               'solar_panel':{0:'brushed_metal',1:'solar_cell',2:'solar_cell'},'bookcase':{8:'paper'},'towel_rail':{2:'metal',5:'fabric'},
               'classic_balustrade':{5:'stone'},'raised_pet_bowls':{5:'brushed_metal'},
               'monstera_plant':{2:'soil',5:'foliage'},'bottle_vase':{1:'glass'}}
        for name,parts in cases.items():
            for index,finish in parts.items():self.assertEqual(MODELS[name]['parts'][index]['surface_finish'],finish,(name,index))


if __name__=='__main__':unittest.main()
