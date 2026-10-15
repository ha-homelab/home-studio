"""Original normalized furniture geometry, matching furniture.js exactly."""
import json
import math
from pathlib import Path
import re

CATALOG = json.loads((Path(__file__).with_name('catalog.json')).read_text(encoding='utf-8'))
MODELS = {model['id']: model for model in CATALOG['models']}
STYLES = {style['id']: style for style in CATALOG['styles']}
PATTERNS = [{'id': name, 'label': name.capitalize()}
            for name in ('none', 'stripes', 'checks', 'diamonds', 'dots', 'herringbone', 'chevrons')]


def supports_furniture_pattern(model):
    return bool(model and any(part['shape'] == 'box' and part.get('pattern_face') in ('top', 'front')
                              for part in model['parts']))


def validate_furniture_appearance(item):
    if 'model_id' not in item:
        if any(key in item for key in ('style_id', 'color', 'pattern_id', 'pattern_color')):
            raise ValueError('choose a furniture model before setting a style, color or pattern')
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
    if 'pattern_id' in item and not any(pattern['id'] == item['pattern_id'] for pattern in PATTERNS):
        raise ValueError('unknown furniture pattern')
    patterned = 'pattern_id' in item and item['pattern_id'] != 'none'
    if 'pattern_color' in item and not patterned:
        raise ValueError('choose a furniture pattern before setting its color')
    if 'pattern_color' in item and (not isinstance(item['pattern_color'], str)
                                    or not re.fullmatch(r'#[0-9a-fA-F]{6}', item['pattern_color'])):
        raise ValueError('furniture pattern color must use #RRGGBB')
    if patterned and not supports_furniture_pattern(model):
        raise ValueError('this furniture model does not support patterns')
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
    if 'pattern_face' in part and (part['shape'] != 'box' or part['pattern_face'] not in ('top', 'front')):
        raise ValueError('furniture pattern_face must be top or front on a box')
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
    return triangle_mesh(part, vertices, faces)


def triangle_mesh(part, vertices, faces):
    x, y, z = part['center']
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


def clip_polygon(polygon, a, b, inside):
    """Split convex polygons into pieces sharing edges, never coplanar area."""
    def distance(point):
        return (b[0]-a[0])*(point[1]-a[1]) - (b[1]-a[1])*(point[0]-a[0])
    clipped = []
    for index, start in enumerate(polygon):
        end = polygon[(index+1) % len(polygon)]
        da, db = distance(start), distance(end)
        first, second = (da >= 0, db >= 0) if inside else (da <= 0, db <= 0)
        if first:
            clipped.append(start)
        if first != second:
            clipped.append([value + (end[axis]-value)*da/(da-db) for axis, value in enumerate(start)])
    return clipped


def pattern_surface(part, pattern):
    background, accent = {'vertices': [], 'faces': []}, {'vertices': [], 'faces': []}

    def rectangle(left, bottom, right, top):
        return [[left,bottom], [right,bottom], [right,top], [left,top]]

    columns = 6 if pattern == 'stripes' else 3 if pattern in ('diamonds', 'dots') else 4
    rows = 1 if pattern == 'stripes' else 2 if pattern == 'dots' else 3 if pattern == 'diamonds' else 4
    for row in range(rows):
        for column in range(columns):
            if pattern in ('stripes', 'checks'):
                motif = [] if (column + (row if pattern == 'checks' else 0)) % 2 else rectangle(0,0,1,1)
            elif pattern == 'diamonds':
                motif = [[.5,0], [1,.5], [.5,1], [0,.5]]
            elif pattern == 'dots':
                motif = [[.5+.38*math.cos(index*math.pi/4), .5+.38*math.sin(index*math.pi/4)] for index in range(8)]
            elif pattern == 'herringbone':
                # Interlocking 2:1 planks, split at tile boundaries without seams.
                phase = (column-row) % 4
                motif = rectangle(0 if phase == 1 else .09, 0 if phase == 2 else .09,
                                  1 if phase == 0 else .91, 1 if phase == 3 else .91)
            else:
                motif = [[-.3,0], [0,-.3], [1.3,1], [1,1.3]]
                if column % 2:
                    motif = [[1-u, v] for u, v in reversed(motif)]

            def emit(polygon, target):
                for index in range(1, len(polygon)-1):
                    points = [polygon[0], polygon[index], polygon[index+1]]
                    a, b, c = points
                    if (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]) <= 1e-12:
                        continue
                    offset = len(target['vertices'])
                    for u, v in points:
                        px = ((column+u)/columns-.5)*part['size'][0]+part['center'][0]
                        target['vertices'].append(
                            [px, part['center'][1]+part['size'][1]/2, (.5-(row+v)/rows)*part['size'][2]+part['center'][2]]
                            if part['pattern_face'] == 'top' else
                            [px, ((row+v)/rows-.5)*part['size'][1]+part['center'][1], part['center'][2]+part['size'][2]/2])
                    target['faces'].append([offset,offset+1,offset+2])

            remaining = rectangle(0,0,1,1)
            for index, a in enumerate(motif):
                b = motif[(index+1) % len(motif)]
                emit(clip_polygon(remaining, a, b, False), background)
                remaining = clip_polygon(remaining, a, b, True)
            emit(remaining, accent if motif else background)
    return [triangle_mesh(part, mesh['vertices'], mesh['faces']) for mesh in (background, accent)]


def append_mesh(target, source):
    offset = len(target['vertices'])
    target['vertices'].extend(source['vertices'])
    target['normals'].extend(source['normals'])
    target['indices'].extend(index+offset for index in source['indices'])


def build_furniture_asset(item):
    model = validate_furniture_appearance(item)
    if model is None:
        return None
    style = STYLES[item.get('style_id', model['default_style'])]
    meshes, materials = [], {}
    pattern = item.get('pattern_id') if item.get('pattern_id') != 'none' else None
    patterned_mesh = {'name': 'pattern', 'vertices': [], 'normals': [], 'indices': [], 'kind': 'inventory'}
    for index, part in enumerate(model['parts']):
        color = (item['color'] if part['material'] == 'body' and item.get('color') else style['materials'].get(part['material'], part['material'])).lower()
        material = 'furniture_' + color[1:]
        materials[material] = linear_color(color)
        mesh = {'name': 'part_' + str(index), **primitive(part), 'material': material, 'kind': 'inventory'}
        if pattern and part.get('pattern_face'):
            # Replace the original top (+Y) or front (+Z) two triangles.
            offset = 6 if part['pattern_face'] == 'top' else 24
            del mesh['vertices'][offset:offset+6]
            del mesh['normals'][offset:offset+6]
            mesh['indices'] = list(range(len(mesh['vertices'])))
            background, accent = pattern_surface(part, pattern)
            append_mesh(mesh, background)
            append_mesh(patterned_mesh, accent)
        meshes.append(mesh)
    if pattern:
        color = item.get('pattern_color', style['materials']['accent']).lower()
        patterned_mesh['material'] = 'furniture_' + color[1:]
        materials[patterned_mesh['material']] = linear_color(color)
        meshes.append(patterned_mesh)
    return {'meshes': meshes, 'materials': materials}
