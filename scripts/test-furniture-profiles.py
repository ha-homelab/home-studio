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
        self.assertEqual(len(CATALOG['models']),206)
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
                self.assertEqual(actual['materials'],other['materials'])
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

    def test_semantic_material_exceptions(self):
        cases={'christmas_tree':{0:'wood',7:'metal',10:'glass'},'television':{1:'glass'},'table_setting':{0:'fabric',1:'ceramic',13:'glass'},
               'solar_panel':{0:'brushed_metal',1:'solar_cell',2:'solar_cell'},'bookcase':{8:'paper'},'towel_rail':{2:'metal',5:'fabric'},
               'classic_balustrade':{5:'stone'},'raised_pet_bowls':{5:'brushed_metal'},
               'monstera_plant':{2:'soil',5:'foliage'},'bottle_vase':{1:'glass'}}
        for name,parts in cases.items():
            for index,finish in parts.items():self.assertEqual(MODELS[name]['parts'][index]['surface_finish'],finish,(name,index))


if __name__=='__main__':unittest.main()
