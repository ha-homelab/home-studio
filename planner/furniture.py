"""Original normalized furniture geometry, matching furniture.js exactly."""
import json
import math
from pathlib import Path
import re

CATALOG = json.loads((Path(__file__).with_name('catalog.json')).read_text())
MODELS = {model['id']: model for model in CATALOG['models']}
STYLES = {style['id']: style for style in CATALOG['styles']}


def validate_furniture_appearance(item):
    if 'model_id' not in item:
        if 'style_id' in item or 'color' in item:
            raise ValueError('choose a furniture model before setting a style or color')
        return None
    model_id = item['model_id']
    model = MODELS.get(model_id) if isinstance(model_id, str) else None
    if model is None:
        raise ValueError('unknown furniture model')
    if item['type'] != model['type']:
        raise ValueError('furniture model does not match this item type')
    if 'style_id' in item and (not isinstance(item['style_id'], str) or item['style_id'] not in STYLES):
        raise ValueError('unknown furniture style')
    if 'color' in item and (not isinstance(item['color'], str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', item['color'])):
        raise ValueError('furniture color must use #RRGGBB')
    return model


def linear_color(color):
    values = [int(color[offset:offset + 2], 16) / 255 for offset in (1, 3, 5)]
    return [value / 12.92 if value <= .04045 else ((value + .055) / 1.055) ** 2.4 for value in values] + [1]


def primitive(part):
    if not isinstance(part, dict) or part.get('shape') not in ('box', 'cylinder', 'sphere', 'ring', 'cone'):
        raise ValueError('unknown furniture primitive')
    for key in ('center', 'size') + (('rotation_deg',) if 'rotation_deg' in part else ()):
        if (not isinstance(part.get(key), list) or len(part[key]) != 3
                or not all(type(value) in (int, float) and math.isfinite(value) for value in part[key])):
            raise ValueError('furniture ' + key + ' must contain three finite numbers')
    if any(value <= 0 for value in part['size']):
        raise ValueError('furniture primitive sizes must be positive')
    if 'inner_ratio' in part and (part['shape'] != 'ring' or type(part['inner_ratio']) not in (int, float)
                                 or not math.isfinite(part['inner_ratio']) or not 0 < part['inner_ratio'] < 1):
        raise ValueError('ring inner_ratio must be between zero and one')
    x, y, z = part['center']
    w, h, d = part['size']
    if part['shape'] == 'box':
        vertices = [[px, y + sign * h / 2, pz] for sign in (-1, 1)
                    for px, pz in ((x-w/2, z-d/2), (x+w/2, z-d/2), (x+w/2, z+d/2), (x-w/2, z+d/2))]
        faces = [[0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,5,1],[0,4,5],[1,6,2],[1,5,6],[2,7,3],[2,6,7],[3,4,0],[3,7,4]]
    elif part['shape'] == 'cylinder':
        sides = 12
        vertices = [[x,y-h/2,z],[x,y+h/2,z]]
        for i in range(sides):
            angle = 2 * math.pi * i / sides
            px, pz = x + w / 2 * math.cos(angle), z + d / 2 * math.sin(angle)
            vertices.extend(([px,y-h/2,pz], [px,y+h/2,pz]))
        faces = []
        for i in range(sides):
            bottom, following = 2 + 2 * i, 2 + 2 * ((i + 1) % sides)
            faces.extend(([0,bottom,following], [1,following+1,bottom+1], [bottom,bottom+1,following+1], [bottom,following+1,following]))
    elif part['shape'] == 'cone':
        sides = 12
        vertices = [[x,y-h/2,z], [x,y+h/2,z]]
        for i in range(sides):
            angle = 2 * math.pi * i / sides
            vertices.append([x+w/2*math.cos(angle), y-h/2, z+d/2*math.sin(angle)])
        faces = []
        for i in range(sides):
            bottom, following = 2 + i, 2 + (i + 1) % sides
            faces.extend(([0,bottom,following], [1,following,bottom]))
    elif part['shape'] == 'sphere':
        sides, spans = 8, 4
        vertices = [[x,y+h/2,z], [x,y-h/2,z]]
        for j in range(1, spans):
            latitude = math.pi * j / spans
            for i in range(sides):
                angle = 2 * math.pi * i / sides
                vertices.append([x+w/2*math.sin(latitude)*math.cos(angle), y+h/2*math.cos(latitude), z+d/2*math.sin(latitude)*math.sin(angle)])
        faces = []
        for i in range(sides):
            following = (i + 1) % sides
            faces.extend(([0,2+following,2+i], [1,2+(spans-2)*sides+i,2+(spans-2)*sides+following]))
            for j in range(spans - 2):
                top, next_top = 2 + j * sides + i, 2 + j * sides + following
                faces.extend(([top,next_top,next_top+sides], [top,next_top+sides,top+sides]))
    else:
        sides, ratio = 12, part.get('inner_ratio', .72)
        vertices = []
        for i in range(sides):
            angle = 2 * math.pi * i / sides
            px, pz = w / 2 * math.cos(angle), d / 2 * math.sin(angle)
            vertices.extend(([x+px,y-h/2,z+pz], [x+px,y+h/2,z+pz],
                             [x+ratio*px,y-h/2,z+ratio*pz], [x+ratio*px,y+h/2,z+ratio*pz]))
        faces = []
        for i in range(sides):
            a, b = 4 * i, 4 * ((i + 1) % sides)
            faces.extend(([a,a+1,b+1], [a,b+1,b], [a+2,b+3,a+3], [a+2,b+2,b+3],
                          [a+1,a+3,b+3], [a+1,b+3,b+1], [a,b+2,a+2], [a,b,b+2]))
    if 'rotation_deg' in part:
        # Rotate offsets around the part center, first X, then Y, then Z.
        rx, ry, rz = (math.fmod(value, 360) * math.pi / 180 for value in part['rotation_deg'])
        cx, sx, cy, sy, cz, sz = math.cos(rx), math.sin(rx), math.cos(ry), math.sin(ry), math.cos(rz), math.sin(rz)
        rotated = []
        for point in vertices:
            px, py, pz = (point[axis] - part['center'][axis] for axis in range(3))
            y1, z1 = py * cx - pz * sx, py * sx + pz * cx
            x2, z2 = px * cy + z1 * sy, -px * sy + z1 * cy
            rotated.append([x+x2*cz-y1*sz, y+x2*sz+y1*cz, z+z2])
        vertices = rotated
    expanded, normals, indices = [], [], []
    for face in faces:
        a, b, c = (vertices[i] for i in face)
        u, v = [b[i]-a[i] for i in range(3)], [c[i]-a[i] for i in range(3)]
        normal = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]]
        length = math.sqrt(sum(n*n for n in normal))
        if not math.isfinite(length) or length == 0:
            raise ValueError('furniture primitive has a degenerate triangle')
        for point in (a, b, c):
            indices.append(len(expanded))
            expanded.append(point)
            normals.append([n / length for n in normal])
    return {'vertices': expanded, 'normals': normals, 'indices': indices}


def build_furniture_asset(item):
    model = validate_furniture_appearance(item)
    if model is None:
        return None
    style = STYLES[item.get('style_id', model['default_style'])]
    meshes, materials = [], {}
    for index, part in enumerate(model['parts']):
        color = (item['color'] if part['material'] == 'body' and item.get('color') else style['materials'].get(part['material'], part['material'])).lower()
        material = 'furniture_' + color[1:]
        materials[material] = linear_color(color)
        meshes.append({'name': 'part_' + str(index), **primitive(part), 'material': material, 'kind': 'inventory'})
    return {'meshes': meshes, 'materials': materials}
