#!/usr/bin/env python3
"""Author deterministic per-part geometry and physical finish for the stock catalog.

This is deliberately a public-only semantic map, independent of private scenes or
photographs. Styles choose pigment; these rules choose the underlying substance.
Run this tool, then generate-furniture-catalog.py after editing the authoring rules.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Every category has an explicit default; exceptions below represent actual parts.
CATEGORY_FINISH = {
    'seating': 'fabric', 'tables': 'wood', 'beds': 'fabric', 'storage': 'painted',
    'kitchen': 'painted', 'bath': 'ceramic', 'decor': 'painted', 'lighting': 'light_diffuser',
    'technology': 'plastic', 'toys': 'painted', 'hobbies': 'painted', 'utility': 'plastic',
    'vehicles': 'car_paint', 'cycles': 'painted', 'sports': 'plastic', 'outdoors': 'painted',
    'textiles': 'fabric', 'mirrors': 'painted', 'architectural': 'painted',
    'plants': 'ceramic', 'window_coverings': 'fabric', 'pet_furniture': 'fabric',
}
WOOD_BODY = {'stool', 'rocking_chair', 'nursery_crib', 'coat_tree', 'clothes_valet',
             'rocking_horse', 'toy_chest', 'dollhouse', 'building_blocks', 'acoustic_guitar',
             'upright_piano', 'art_easel', 'hobby_workbench', 'garden_bench', 'wood_balustrade',
             'plant_stand', 'tabletop_photo_frame'}
FABRIC_BODY = {'blanket_ladder', 'shoe_storage_bench', 'laundry_hamper', 'folded_towels', 'bath_mat',
               'towel_rail', 'ironing_board', 'patio_lounge_chair', 'patio_umbrella', 'golf_bag',
               'teddy_bear', 'plush_bunny'}
FUR_BODY = {'standing_brown_bear', 'brown_bear_all_fours', 'polar_bear',
            'small_dog', 'sitting_cat', 'garden_rabbit', 'garden_fox'}
NATURAL_STORAGE = {'wardrobe','dresser','bookcase','tv_console','bedside_cabinet'}
TAILORED_SEATING = {'sofa_2','sofa_3','armchair','corner_sofa','chaise_lounge'}
FOLIAGE_BODY = {'clipped_hedge', 'round_canopy_tree', 'columnar_tree', 'lawn_patch', 'meadow_border'}
CANOPY_MODELS = {'plant', 'fir_tree', 'christmas_tree', 'weeping_fig', 'clipped_hedge', 'round_canopy_tree', 'columnar_tree'}
# Specific per-part overrides distinguish screens, lamp shades, book blocks,
# counter tops and functional hardware from similarly coloured soft furniture.
OVERRIDES = {
    'christmas_tree': {0:'wood',1:'wood',**{i:'metal' for i in range(7,10)},**{i:'glass' for i in range(10,21)}},
    'bookcase': {**{i: 'paper' for i in range(8,13)}},
    'television': {0:'plastic',1:'glass'},
    'kitchen_cabinet': {6:'polished_stone'}, 'kitchen_island': {1:'polished_stone'},
    'oven': {1:'glass',2:'brushed_metal',3:'glass'},
    'washing_machine': {0:'painted',1:'brushed_metal',2:'glass',3:'plastic',4:'plastic'},
    'kitchen_sink': {1:'brushed_metal',**{i:'polished_stone' for i in range(2,6)}},
    'bathroom_vanity': {0:'painted',1:'ceramic',**{i:'ceramic' for i in range(2,6)}},
    'toilet': {2:'plastic',3:'ceramic'},
    'fruit_bowl': {**{i:'plastic' for i in (3,5,7)},0:'ceramic',1:'ceramic',2:'ceramic'},
    'table_setting': {0:'fabric',2:'ceramic',4:'ceramic',14:'glass'},
    'mug_tree': {2:'wood',**{i:'ceramic' for i in (4,5,6,8,9,10,12,13,14)}},
    'office_printer': {5:'paper'}, 'printer_3d': {12:'plastic'},
    'wall_clock': {0:'wood',1:'paper'},
    'stacked_books': {**{i:'paper' for i in range(9)}},
    'bookends_books': {**{i:'paper' for i in range(4,12)}},
    'tabletop_photo_frame': {1:'paper',2:'paper',3:'paper',4:'paper'},
    'ceramic_vase': {0:'ceramic',1:'ceramic',2:'ceramic',3:'ceramic',4:'ceramic'},
    'bottle_vase': {0:'glass',1:'glass',2:'glass',3:'glass',4:'glass'},
    'floor_lamp': {2:'fabric',3:'light_diffuser'}, 'table_lamp': {2:'fabric'},
    'pendant': {2:'painted',3:'light_diffuser'},
    'towel_rail': {2:'metal',4:'metal'},
    'soap_dispenser_set': {0:'wood',1:'ceramic',2:'ceramic',6:'ceramic',7:'ceramic',8:'ceramic'},
    'raised_pet_bowls': {5:'brushed_metal',7:'brushed_metal',8:'brushed_metal',10:'brushed_metal'},
    'classic_balustrade': {**{i:'stone' for i in range(20)}},
    'clipped_hedge': {1:'soil'}, 'meadow_border': {0:'soil'},
}


def finish_for(model, index, part):
    name, category, role = model['id'], model['category'], part['material']
    if index in OVERRIDES.get(name, {}): return OVERRIDES[name][index]
    if role == 'wood': return 'rough_wood' if category == 'plants' and name != 'plant_stand' else 'wood'
    if role == 'metal': return 'brushed_metal'
    if category == 'mirrors' and (role=='glass' or part.get('surface_finish')=='mirror'): return 'mirror'
    if role == 'glass': return 'glass'
    if role == 'foliage': return 'foliage'
    if role == '#493a2b': return 'soil'
    if name in FUR_BODY and role != 'dark': return 'fur'
    if name == 'garden_bird' and role not in ('dark', 'accent'): return 'feather'
    if name in FOLIAGE_BODY: return 'foliage'
    if name == 'stepping_stone_path': return 'stone'
    if role == 'dark':
        if category in ('vehicles','cycles') and part['shape'] in ('ring','cylinder'): return 'rubber'
        if category == 'vehicles': return 'glass' if part['shape'] == 'sphere' else 'plastic'
        return 'plastic'
    if name == 'solar_panel': return 'solar_cell'
    if role.startswith('#'):
        if category == 'technology': return 'light_diffuser'
        if category == 'vehicles': return 'light_diffuser'
        if category == 'plants': return 'foliage'
        if name in FABRIC_BODY: return 'fabric'
        return CATEGORY_FINISH[category]
    if role == 'white':
        if category in ('beds','textiles') or name in FABRIC_BODY: return 'fabric'
        if category == 'vehicles': return 'light_diffuser'
        return 'ceramic' if category in ('kitchen','bath') else 'plastic'
    if name in WOOD_BODY: return 'wood'
    if name in FABRIC_BODY: return 'fabric'
    if name in ('raised_pet_bowls',): return 'brushed_metal'
    if name in ('solar_panel',): return 'solar_cell'
    if name in ('folding_room_screen',): return 'paper'
    if name in ('electric_kettle','stand_mixer','two_slice_toaster','refrigerator'): return 'painted'
    return CATEGORY_FINISH[category]


def geometry_for(model, part, finish):
    shape, name = part['shape'], model['id']
    index=model['parts'].index(part)
    cushion = (name in ('sofa_2','sofa_3','armchair') and index >= 8
               or name == 'corner_sofa' and index in (5,6)
               or name == 'chaise_lounge' and index in (5,6,9))
    if shape=='box' and (model['category']=='textiles' and any(word in name for word in ('rug','runner','tapestry','throw')) or name=='bathtub'): return 'joined'
    if cushion and shape == 'box':
        return 'tailored' if 'pattern_face' in part else 'cushion'
    if name=='meadow_border' and shape=='cone': return 'grass'
    if name=='lawn_patch': return 'joined'
    if finish == 'foliage' and name == 'plant': return 'sprig'
    if finish == 'foliage' and name in CANOPY_MODELS: return 'canopy'
    if shape == 'box':
        if finish in ('fabric','leather'): return 'soft'
        if finish in ('glass','mirror','solar_cell','paper'): return 'flat'
        return 'edge'
    if shape == 'sphere':
        if model['category'] == 'vehicles' and part['material']=='glass': return 'greenhouse'
        if model['category'] == 'vehicles' and part['material'] in ('body','dark'): return 'coachwork'
        if finish == 'foliage' and 'cactus' not in name: return 'leaf'
        return 'round'
    if shape == 'ring': return 'rounded_fine' if model['category']=='mirrors' else 'rounded'
    # Small rods keep twelve silhouette sides and smooth side normals;
    # sub-pixel cap bevels do not justify doubling their triangle budget.
    if shape == 'cylinder' and max(part['size'][0]*model['dimensions_m']['width'], part['size'][2]*model['dimensions_m']['depth']) <= .08: return 'rod'
    if shape == 'cylinder' and model['category'] in ('tables','mirrors') and max(part['size'][0]*model['dimensions_m']['width'],part['size'][2]*model['dimensions_m']['depth'])>.3: return 'lathed_fine'
    if shape == 'cylinder' and name!='plant' and max(part['size'][0]*model['dimensions_m']['width'],part['size'][2]*model['dimensions_m']['depth'])>.3: return 'lathed'
    if shape == 'cylinder' and finish in ('fabric','rubber'): return 'soft'
    return 'turned'


def author(catalog):
    anatomy=json.loads((ROOT/'planner/anatomy.json').read_text())
    expected=FUR_BODY|{'garden_bird'}
    if set(anatomy)!=expected: raise ValueError('anatomy source must contain the eight reviewed animal models')
    for model in catalog['models']:
        if model['category'] not in CATEGORY_FINISH: raise ValueError('unreviewed category: '+model['category'])
        if model['id']=='plant':
            model['default_style']='warm_wood'
            # One continuous branching crown attaches to the full-height trunk.
            # Separate floating foliage envelopes are not physical plant parts.
            model['parts']=[
                {'shape':'cylinder','center':[0,.15,0],'size':[.45,.3,.703125],'material':'body'},
                {'shape':'cylinder','center':[0,.55,0],'size':[.06,.8,.09375],'material':'wood'},
                {'shape':'cylinder','center':[0,.65,0],'size':[1,.7,1],'material':'foliage'},
            ]
        if model['id']=='checkerboard_rug':
            model['parts'][0]['center'][1]=.48
            model['parts'][0]['size'][1]=.96
            for panel in model['parts'][1:9]:
                panel['center'][1]=.98
                panel['size'][1]=.04
        if model['id']=='meadow_border':
            model['parts'][0]['material']='body'
            model['parts']=model['parts'][:9]
            for flower in model['parts'][6:9]:
                x,y,z=flower['center']
                model['parts'].append({'shape':'cylinder','center':[x,y/2,z],'size':[.007,y,.025],'material':'foliage'})
        if model['id'] in FOLIAGE_BODY: model['default_style']='forest_green'
        if model['id']=='meadow_border': model['default_style']='walnut_brass'
        if model['id'] in TAILORED_SEATING: model['default_style']='scandinavian'
        elif model['category']=='tables' or model['id'] in WOOD_BODY: model['default_style']='warm_wood'
        elif model['id'] in NATURAL_STORAGE: model['default_style']='walnut_brass'
        if model['id']=='corner_sofa':
            # The short side has no chaise: its front foot belongs under its
            # own frame, not at the far end of the adjacent long chaise.
            model['parts'][10]['center'][2]=.10
        for index, part in enumerate(model['parts']):
            finish=finish_for(model,index,part)
            part['surface_finish']=finish
            if finish=='mirror': part['material']='#e2e5e3'
            part['geometry_profile']=geometry_for(model,part,finish)
            if part['geometry_profile']=='canopy':
                part['geometry_dimensions']=[part['size'][i]*model['dimensions_m'][k] for i,k in enumerate(('width','height','depth'))]
                part['geometry_leaf_count']=448 if model['id'] in ('clipped_hedge','round_canopy_tree','columnar_tree') else 64 if model['id']=='weeping_fig' else 128
            else:
                part.pop('geometry_dimensions',None);part.pop('geometry_leaf_count',None)
        if model['id'] in anatomy:
            # Continuous authored sections and anchored features override the
            # category-level primitive rules; never restyle individual parts.
            model['parts']=anatomy[model['id']]
    return catalog


def serialize(catalog):
    lines=['{', '  \"version\": '+str(catalog['version'])+',']
    for key in ('categories','styles','models'):
        lines.append('  '+json.dumps(key)+': [')
        entries=catalog[key]
        for index,entry in enumerate(entries):
            suffix=',' if index<len(entries)-1 else ''
            if key!='models': lines.append('    '+json.dumps(entry,ensure_ascii=False)+suffix); continue
            lines.append('    {')
            for number,(field,value) in enumerate(entry.items()):
                ending=',' if number<len(entry)-1 else ''
                if field=='parts':
                    lines.append('      \"parts\": [')
                    lines.extend('        '+json.dumps(part,ensure_ascii=False)+(',' if i<len(value)-1 else '') for i,part in enumerate(value))
                    lines.append('      ]'+ending)
                else: lines.append('      '+json.dumps(field)+': '+json.dumps(value,ensure_ascii=False)+ending)
            lines.append('    }'+suffix)
        lines.append('  ]'+(',' if key!='models' else ''))
    return '\n'.join(lines+['}'])+'\n'


if __name__ == '__main__':
    path=ROOT/'planner/catalog.json'
    path.write_text(serialize(author(json.loads(path.read_text()))))
