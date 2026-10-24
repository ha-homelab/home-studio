"""Authored normalized furniture geometry, matching furniture.js exactly."""
import json
import math
from pathlib import Path
import re

CATALOG = json.loads((Path(__file__).with_name('catalog.json')).read_text(encoding='utf-8'))
MODELS = {model['id']: model for model in CATALOG['models']}
STYLES = {style['id']: style for style in CATALOG['styles']}
PATTERNS = [{'id': name, 'label': name.capitalize()}
            for name in ('none', 'stripes', 'checks', 'diamonds', 'dots', 'herringbone', 'chevrons')]


def supports_curtain(model):
    return bool(model and model['id'] in ('curtain_pair_open', 'curtain_pair_closed'))


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


def primitive(part, cutout=False):
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
    profile = part.get('geometry_profile')
    allowed = {'box': ('edge', 'soft', 'cushion', 'tailored', 'joined', 'flat', 'canopy', 'vehicle_shell', 'molded_shell'), 'cylinder': ('turned', 'lathed', 'lathed_fine', 'rod', 'soft', 'canopy', 'sprig', 'organic'),
               'sphere': ('round', 'leaf', 'canopy', 'coachwork', 'greenhouse'), 'ring': ('rounded','rounded_fine'), 'cone': ('turned', 'canopy', 'grass')}
    if profile is not None and profile not in allowed[part['shape']]:
        raise ValueError('unsupported furniture geometry profile')
    if profile in ('vehicle_shell','molded_shell'):
        if ('geometry_rings' in part)==('geometry_shells' in part): raise ValueError('vehicle shell requires one ring representation')
        if part.get('geometry_shading','smooth') not in ('smooth','flat'): raise ValueError('invalid vehicle shading')
        shells=part.get('geometry_shells',[part.get('geometry_rings')])
        if not isinstance(shells,list) or not 1<=len(shells)<=32: raise ValueError('invalid vehicle shell count')
        for rings in shells:
            if not isinstance(rings,list) or not 2<=len(rings)<=12: raise ValueError('vehicle shell requires 2–12 rings')
            sides=len(rings[0]) if isinstance(rings[0],list) else 0
            if sides not in (4,6,8,24,32): raise ValueError('vehicle rings require 4, 6, 8, 24 or 32 corners')
            for ring in rings:
                if not isinstance(ring,list) or len(ring)!=sides: raise ValueError('inconsistent vehicle ring')
                for point in ring:
                    if not isinstance(point,list) or len(point)!=3 or not all(type(v) in (int,float) and math.isfinite(v) and -1.000000000001<=v<=1.000000000001 for v in point): raise ValueError('invalid vehicle corner')
        if sum(len(r)*len(r[0]) for r in shells)>512: raise ValueError('vehicle shell exceeds corner budget')
    if profile == 'canopy':
        if part.get('geometry_foliage','broadleaf') not in ('broadleaf','needles'): raise ValueError('invalid canopy foliage')
        if 'geometry_leaf_count' in part and (type(part['geometry_leaf_count']) is not int or not 16<=part['geometry_leaf_count']<=500): raise ValueError('canopy leaf count must be 16–500')
        if 'geometry_dimensions' in part and (not isinstance(part['geometry_dimensions'],list) or len(part['geometry_dimensions'])!=3 or not all(type(v) in (int,float) and math.isfinite(v) and v>0 for v in part['geometry_dimensions'])): raise ValueError('invalid canopy dimensions')
    if profile == 'organic':
        sections=part.get('geometry_sections')
        if not isinstance(sections,list) or not 3<=len(sections)<=16: raise ValueError('organic profile requires 3–16 sections')
        for index,section in enumerate(sections):
            if not isinstance(section,dict) or set(section)!={'center','radius'}: raise ValueError('invalid organic section')
            for key,count in (('center',3),('radius',2)):
                values=section[key]
                if not isinstance(values,list) or len(values)!=count or not all(type(v) in (int,float) and math.isfinite(v) and -1<=v<=1 for v in values): raise ValueError('invalid organic coordinates')
            if index in (0,len(sections)-1):
                if section['radius']!=[0,0]: raise ValueError('organic ends must be closed poles')
            elif min(section['radius'])<=0: raise ValueError('organic interior radii must be positive')
            if index and section['center'][1]<=sections[index-1]['center'][1]: raise ValueError('organic sections must ascend along Y')
    if profile is not None:
        return refined_primitive(part, cutout)
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
    if cutout and part.get('pattern_face'):
        start = 2 if part['pattern_face'] == 'top' else 8
        del faces[start:start+2]
    return triangle_mesh(part, vertices, faces)


def triangle_mesh(part, vertices, faces, vertex_normals=None):
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
        if vertex_normals is not None:
            transformed = []
            for px, py, pz in vertex_normals:
                y1, z1 = py * cx - pz * sx, py * sx + pz * cx
                x2, z2 = px * cy + z1 * sy, -px * sy + z1 * cy
                transformed.append([x2*cz-y1*sz, x2*sz+y1*cz, z2])
            vertex_normals = transformed
    expanded, normals, indices = [], [], []
    for face in faces:
        a, b, c = (vertices[i] for i in face)
        u, v = [b[i]-a[i] for i in range(3)], [c[i]-a[i] for i in range(3)]
        normal = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]]
        length = math.sqrt(sum(n*n for n in normal))
        if not math.isfinite(length) or length == 0:
            raise ValueError('furniture primitive has a degenerate triangle')
        for corner, point in zip(face, (a, b, c)):
            indices.append(len(expanded))
            expanded.append(point)
            normals.append(vertex_normals[corner] if vertex_normals is not None else [n / length for n in normal])
    return {'vertices': expanded, 'normals': normals, 'indices': indices}



def refined_primitive(part, cutout=False, fit=True):
    """Bounded physical profiles; legacy primitive envelopes remain unchanged.

    Chart boundaries duplicate vertices intentionally. Analytic rounded normals
    are authored here; the viewer never guesses smoothing across material seams.
    """
    shape, profile = part['shape'], part['geometry_profile']
    center, size = part['center'], part['size']
    if profile == 'joined':
        return primitive({k:v for k,v in part.items() if k!='geometry_profile'},cutout)
    vertices, normals, faces = [], [], []

    def unit(v):
        length = math.sqrt(sum(x*x for x in v))
        return [x/length for x in v]

    def point(v, n):
        vertices.append([center[i]+v[i]*size[i]/2 for i in range(3)])
        normals.append(unit([n[i]/size[i] for i in range(3)]))
        return len(vertices)-1

    def quad(a, b, c, d):
        faces.extend(([a,b,c], [a,c,d]))

    if profile == 'organic':
        # Authored anatomical sections make a continuous skin rather than
        # separate overlapping spheres. Ring normals are shared explicitly.
        sections=part['geometry_sections'];sides=12;rings=[]
        for index,section in enumerate(sections):
            c=section['center'];rx,rz=section['radius']
            if index in (0,len(sections)-1): rings.append([point(c,[0,-1 if index==0 else 1,0])]);continue
            ring=[]
            for j in range(sides):
                a=j*2*math.pi/sides
                ring.append(point([c[0]+rx*math.cos(a),c[1],c[2]+rz*math.sin(a)],[math.cos(a),0,math.sin(a)]))
            rings.append(ring)
        for low,high in zip(rings,rings[1:]):
            for j in range(sides):
                k=(j+1)%sides
                if len(low)==1:faces.append([low[0],high[j],high[k]])
                elif len(high)==1:faces.append([low[j],high[0],low[k]])
                else:quad(low[j],high[j],high[k],low[k])
    elif profile in ('vehicle_shell','molded_shell'):
        for rings in part.get('geometry_shells',[part.get('geometry_rings')]):
            sides=len(rings[0]);offset=len(vertices)
            for ring in rings:
                for q in ring: point(q,[0,1,0])
            for row in range(len(rings)-1):
                for j in range(sides):
                    k=(j+1)%sides;quad(offset+row*sides+j,offset+row*sides+k,offset+(row+1)*sides+k,offset+(row+1)*sides+j)
            last=offset+(len(rings)-1)*sides
            for j in range(1,sides-1):faces.extend(([offset,offset+j+1,offset+j],[last,last+j,last+j+1]))
    elif profile == 'greenhouse':
        # A sloped glazing enclosure has a roof, sills and planar windscreens.
        for q in ((-1,-1,-1),(1,-1,-1),(1,-1,1),(-1,-1,1),(-.7,1,-.58),(.7,1,-.58),(.7,1,.35),(-.7,1,.35)):
            point(q,[0,1,0])
        faces.extend(((0,1,2),(0,2,3),(4,6,5),(4,7,6),(0,5,1),(0,4,5),(1,6,2),(1,5,6),(2,7,3),(2,6,7),(3,4,0),(3,7,4)))
    elif profile == 'grass':
        # Curved triangular blades are closed solids, never facing the camera.
        for blade in range(9):
            angle=blade*2.399963229728653; height=.55+.45*((blade*5)%9)/8
            direction=[math.cos(angle),0,math.sin(angle)];across=[-math.sin(angle),0,math.cos(angle)]
            origin=[.28*direction[0],-1,.28*direction[2]];start=len(vertices)
            for level,width,lean in ((0,.10,0),(.65,.065,.25),(1,0,.52)):
                if level==1:
                    q=[origin[i]+lean*direction[i] for i in range(3)];q[1]=-1+2*height;point(q,direction);continue
                for side,depth in ((-1,0),(1,0),(0,.035)):
                    q=[origin[i]+lean*direction[i]+side*width*across[i]+depth*direction[i] for i in range(3)];q[1]=-1+2*height*level;point(q,direction)
            faces.extend(((start,start+2,start+1),(start+3,start+4,start+6),(start+4,start+5,start+6),(start+5,start+3,start+6)))
            for j in range(3):quad(start+j,start+(j+1)%3,start+3+(j+1)%3,start+3+j)
    elif profile in ('canopy','sprig'):
        # Separate, closed leaf blades create real gaps and silhouettes in orbit.
        # No image billboards, transparent cutouts or randomly moving topology.
        if profile == 'canopy':
            sides,spans=8,4
            point([0,.94,0],[0,1,0]);point([0,-.94,0],[0,-1,0])
            for row in range(1,spans):
                latitude=math.pi*row/spans;sy=math.cos(latitude)
                for column in range(sides):
                    angle=2*math.pi*column/sides;radius=.86*math.sin(latitude)
                    if shape=='cone':radius=(.16 if part.get('geometry_foliage')=='needles' else .86)*(1-sy)/2
                    q=[radius*math.cos(angle),.94*sy,radius*math.sin(angle)]
                    if shape=='box':q=[math.copysign(.88*abs(x/.94)**.35,x) for x in q]
                    point(q,[math.cos(angle),sy,math.sin(angle)])
            for column in range(sides):
                following=(column+1)%sides
                faces.extend(((0,2+following,2+column),(1,2+(spans-2)*sides+column,2+(spans-2)*sides+following)))
                for row in range(spans-2):
                    a,b=2+row*sides+column,2+row*sides+following;quad(a,b,b+sides,a+sides)
        count=12 if profile=='sprig' else part.get('geometry_leaf_count',128)
        needles=profile=='canopy' and part.get('geometry_foliage')=='needles'
        samples=count
        for leaf in range(count):
            sample=leaf
            height = -0.94 + 1.88*((sample*17)%samples)/(samples-1)
            yaw = sample*2.399963229728653
            radial=math.sqrt(max(0,1-height*height))
            if profile=='canopy':
                direction=[radial*math.cos(yaw),height,radial*math.sin(yaw)]
                if shape=='box':
                    dimensions=part.get('geometry_dimensions',[1,1,1])
                    weights=[dimensions[(i+1)%3]*dimensions[(i+2)%3] for i in range(3) for _ in range(2)]
                    sample=(leaf+.5)/count*sum(weights);face=0
                    while sample>weights[face] and face<5:sample-=weights[face];face+=1
                    axis=face//2;normal=[0.,0.,0.];normal[axis]=1 if face%2 else -1
                    direction=[0.,0.,0.];direction[axis]=normal[axis]
                    direction[(axis+1)%3]=1.94*((leaf*.618033988749895)%1)-.97
                    direction[(axis+2)%3]=1.94*((leaf*.414213562373095)%1)-.97
                elif shape=='cone':
                    direction=[(1-height)*.5*math.cos(yaw),height,(1-height)*.5*math.sin(yaw)]
                    normal=unit([math.cos(yaw),.5,math.sin(yaw)])
                else: normal=unit(direction)
                origin=[.91*x for x in direction]
                tangent=unit([normal[2],0,-normal[0]]) if abs(normal[1])<.99 else [1.,0.,0.]
                bitangent=[normal[1]*tangent[2]-normal[2]*tangent[1],normal[2]*tangent[0]-normal[0]*tangent[2],normal[0]*tangent[1]-normal[1]*tangent[0]]
                tilt=leaf*1.1
                along=[math.cos(tilt)*tangent[i]+math.sin(tilt)*bitangent[i] for i in range(3)]
                across=[-math.sin(tilt)*tangent[i]+math.cos(tilt)*bitangent[i] for i in range(3)]
                half_length,half_width,thickness=.13,.055,.001
                if needles:
                    # Each closed narrow spray grows from the inner crown,
                    # instead of placing sub-pixel needles on a solid cone.
                    # The small core is covered by overlapping radial branchlets.
                    dimensions=part.get('geometry_dimensions',[1,1,1])
                    branch_radius=(1-height)*.5
                    axis=unit([math.cos(yaw),-.16,math.sin(yaw)])
                    along=axis;across=[-math.sin(yaw),0,math.cos(yaw)]
                    normal=unit([axis[1]*across[2],axis[2]*across[0]-axis[0]*across[2],-axis[1]*across[0]])
                    physical_radius=branch_radius*min(dimensions[0],dimensions[2])*.5
                    half_length=max(.012,.47*physical_radius)
                    half_width=max(.003,.072*physical_radius)
                    thickness=max(.001,.028*physical_radius)
                    origin=[.51*branch_radius*math.cos(yaw),.91*height,.51*branch_radius*math.sin(yaw)]
            else:
                radius = .72*radial
                origin=[radius*math.cos(yaw),height,radius*math.sin(yaw)]
                along=unit([math.cos(yaw),.35*math.sin(leaf*1.7),math.sin(yaw)])
                across=[-math.sin(yaw),0,math.cos(yaw)]
                normal=[along[1]*across[2],along[2]*across[0]-along[0]*across[2],-along[1]*across[0]]
                half_length,half_width=.38,.17
            start=len(vertices)
            if profile=='canopy':
                dimensions=part.get('geometry_dimensions',[1,1,1])
                for u,v,w in ((-1,0,0),(1,0,0),(0,1,thickness),(0,-1,thickness)):
                    q=[origin[k]+2*(u*half_length*along[k]+v*half_width*across[k]+w*normal[k])/dimensions[k] for k in range(3)]
                    point(q,normal)
                faces.extend(([start,start+2,start+1],[start,start+1,start+3],[start,start+3,start+2],[start+1,start+2,start+3]))
                continue
            for i in range(6):
                a=2*math.pi*i/6
                q=[origin[k]+half_length*math.cos(a)*along[k]+half_width*math.sin(a)*across[k] for k in range(3)]
                point(q,normal)
            for side in (1,-1):
                tip=point([origin[k]+side*.035*normal[k] for k in range(3)],[side*x for x in normal])
                for i in range(6):
                    a,b=start+i,start+(i+1)%6
                    faces.append([tip,a,b] if side>0 else [tip,b,a])
            if profile=='canopy': continue
            branch_start=[0,-1,0]
            branch_end=[origin[i]-.30*along[i] for i in range(3)]
            direction=unit([branch_end[i]-branch_start[i] for i in range(3)])
            tangent=unit([direction[2],0,-direction[0]])
            bitangent=[direction[1]*tangent[2],direction[2]*tangent[0]-direction[0]*tangent[2],-direction[1]*tangent[0]]
            first=len(vertices)
            for j in range(3):
                angle=j*2*math.pi/3
                n=[math.cos(angle)*tangent[i]+math.sin(angle)*bitangent[i] for i in range(3)]
                point([branch_start[i]+.012*n[i] for i in range(3)],n)
            point(branch_end,direction)
            for j in range(3):faces.append([first+j,first+(j+1)%3,first+3])
            faces.append([first,first+2,first+1])
    elif shape == 'box' and profile not in ('soft','cushion','tailored'):
        radius=.08 if profile=='edge' else .025
        core=1-radius; corners={}
        for sx in (-1,1):
            for sy in (-1,1):
                for sz in (-1,1):
                    signs=(sx,sy,sz)
                    for axis in range(3):
                        q=[signs[i]*(1 if i==axis else core) for i in range(3)]
                        n=[signs[i] if i==axis else 0 for i in range(3)]
                        corners[(signs,axis)]=point(q,n)
        def polygon(ids):
            a,b,c=(vertices[i] for i in ids[:3])
            u,v=[b[i]-a[i] for i in range(3)],[c[i]-a[i] for i in range(3)]
            n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]
            if sum(n[i]*sum(vertices[j][i]-center[i] for j in ids) for i in range(3))<0:ids=list(reversed(ids))
            for j in range(1,len(ids)-1):faces.append([ids[0],ids[j],ids[j+1]])
        for axis in range(3):
            u,v=(axis+1)%3,(axis+2)%3
            for sign in (-1,1):
                if cutout and sign==1 and axis==(1 if part.get('pattern_face')=='top' else 2):continue
                ids=[]
                for su,sv in ((-1,-1),(1,-1),(1,1),(-1,1)):
                    signs=[0,0,0];signs[axis]=sign;signs[u]=su;signs[v]=sv
                    ids.append(corners[(tuple(signs),axis)])
                polygon(ids)
        for axis in range(3):
            u,v=(axis+1)%3,(axis+2)%3
            for su in (-1,1):
                for sv in (-1,1):
                    ids=[]
                    for sign,face in ((-1,u),(1,u),(1,v),(-1,v)):
                        signs=[0,0,0];signs[axis]=sign;signs[u]=su;signs[v]=sv
                        ids.append(corners[(tuple(signs),face)])
                    polygon(ids)
        for signs,_ in list(corners)[::3]:polygon([corners[(signs,axis)] for axis in range(3)])
    elif shape == 'box':
        # Rounded cuboids retain a planar central face, including pattern charts.
        radius = .45 if profile in ('cushion','tailored') else .34 if profile == 'soft' else .08 if profile == 'edge' else .025
        core = 1-radius
        coordinates = (-1,-core,0,core,1) if profile == 'cushion' else (-1,-core,core,1)
        stride=len(coordinates)
        for axis in range(3):
            u, v = (axis+1)%3, (axis+2)%3
            for sign in (-1, 1):
                start = len(vertices)
                for a in coordinates:
                    for b in coordinates:
                        raw = [0.,0.,0.]; raw[axis]=sign; raw[u]=a; raw[v]=b
                        inner = [max(-core,min(core,x)) for x in raw]
                        normal = unit([raw[i]-inner[i] for i in range(3)])
                        q = [inner[i]+radius*normal[i] for i in range(3)]
                        if profile == 'cushion':
                            dome=max(0,1-(a/core)**2)*max(0,1-(b/core)**2)
                            q[axis]-=sign*.16*(1-dome)*(1-max(abs(a),abs(b)))
                        point(q, normal)
                for i in range(stride-1):
                    for j in range(stride-1):
                        if cutout and i == j == 1 and sign == 1 and axis == (1 if part.get('pattern_face') == 'top' else 2):
                            continue
                        a,b,c,d = start+i*stride+j,start+(i+1)*stride+j,start+(i+1)*stride+j+1,start+i*stride+j+1
                        quad(a,b,c,d) if sign > 0 else quad(a,d,c,b)
    elif shape == 'cone':
        sides=16
        for i in range(sides):
            a,b=2*math.pi*i/sides,2*math.pi*((i+1)%sides)/sides
            n=lambda angle:[math.cos(angle),.5,math.sin(angle)]
            top=point([0,1,0],n((2*math.pi*i/sides+2*math.pi*(i+1)/sides)/2))
            first=point([math.cos(a),-1,math.sin(a)],n(a))
            following=point([math.cos(b),-1,math.sin(b)],n(b))
            faces.append([top,following,first])
            center_index=point([0,-1,0],[0,-1,0])
            first=point([math.cos(a),-1,math.sin(a)],[0,-1,0])
            following=point([math.cos(b),-1,math.sin(b)],[0,-1,0])
            faces.append([center_index,first,following])
    elif shape == 'sphere':
        sides, spans = 12, 6
        point([0,1,.72 if profile == 'leaf' else 0],[0,1,0]); point([0,-1,-.72 if profile == 'leaf' else 0],[0,-1,0])
        for j in range(1,spans):
            latitude = math.pi*j/spans
            sy, radial = math.cos(latitude), math.sin(latitude)
            if shape == 'cone':
                radial = (1-sy)/2
            for i in range(sides):
                angle = 2*math.pi*i/sides
                q = [radial*math.cos(angle), sy, radial*math.sin(angle)]
                if profile == 'coachwork':
                    q=[math.copysign(abs(value)**.55,value) for value in q]
                if profile == 'leaf':
                    # A thin curved blade, rather than an inflated ellipsoid.
                    # Depth comes from the blade's bend, so envelope fitting
                    # cannot inflate its thin cross-section back into a capsule.
                    q[0] *= .65+.35*math.sin(latitude)
                    q[2] = .72*sy + .22*(1-sy*sy) + .025*q[2]
                n = [q[0], .5*radial if shape == 'cone' else sy, q[2]]
                point(q,n)
        for i in range(sides):
            following=(i+1)%sides
            faces.extend(([0,2+following,2+i],[1,2+(spans-2)*sides+i,2+(spans-2)*sides+following]))
            for j in range(spans-2):
                a,b=2+j*sides+i,2+j*sides+following
                quad(a,b,b+sides,a+sides)
    elif shape == 'cylinder':
        sides = 32 if profile == 'lathed_fine' else 16 if profile == 'lathed' else 12
        # Machined/padded rims: capped solids with smooth sides and hard cap seams.
        rim = 0 if profile == 'rod' else .12 if profile == 'soft' else .035
        rings = [(-1,1),(1,1)] if profile == 'rod' else [(-1,1-rim),(-1+rim,1),(1-rim,1),(1,1-rim)]
        for row,(height,radius) in enumerate(rings):
            for i in range(sides):
                a=2*math.pi*i/sides
                ny = 0 if profile == 'rod' else -1 if row == 0 else 1 if row == 3 else 0
                point([radius*math.cos(a),height,radius*math.sin(a)], [math.cos(a),ny,math.sin(a)])
        for row in range(len(rings)-1):
            for i in range(sides):
                a=row*sides+i;b=row*sides+(i+1)%sides
                quad(a,a+sides,b+sides,b)
        for height,sign in ((-1,-1),(1,1)):
            c=point([0,height,0],[0,sign,0]); start=len(vertices)
            for i in range(sides):
                a=2*math.pi*i/sides
                point([(1-rim)*math.cos(a),height,(1-rim)*math.sin(a)],[0,sign,0])
            for i in range(sides):
                a,b=start+i,start+(i+1)%sides
                faces.append([c,b,a] if sign>0 else [c,a,b])
    else:
        sides, spans, ratio = (32 if profile=='rounded_fine' else 12), 4, part.get('inner_ratio',.72)
        major, minor = (1+ratio)/2, (1-ratio)/2
        for i in range(sides):
            a=2*math.pi*i/sides
            for j in range(spans):
                b=2*math.pi*j/spans
                radius=major+minor*math.cos(b)
                point([radius*math.cos(a),math.sin(b),radius*math.sin(a)],
                      [math.cos(b)*math.cos(a)/minor,math.sin(b),math.cos(b)*math.sin(a)/minor])
        for i in range(sides):
            for j in range(spans):
                a=i*spans+j;b=((i+1)%sides)*spans+j
                quad(a,a-j+(j+1)%spans,b-j+(j+1)%spans,b)
    if profile in ('cushion','organic'):
        # Area-weighted normals on the authored dome, sharing only coincident
        # surface vertices. Piping below retains its own normal seam.
        keys=[tuple(round(value,12) for value in point) for point in vertices]
        accum={key:[0.,0.,0.] for key in keys}
        for face in faces:
            a,b,c=(vertices[i] for i in face)
            u=[b[i]-a[i] for i in range(3)];v=[c[i]-a[i] for i in range(3)]
            normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]
            for index in face:
                for axis in range(3):accum[keys[index]][axis]+=normal[axis]
        normals=[unit(accum[key]) for key in keys]
    if profile in ('cushion','tailored'):
        # Sewn piping is real closed geometry attached to the upholstery part.
        # It follows the rounded perimeter at the thin-axis midline.
        thin=min(range(3),key=lambda i:part['size'][i]); u,v=(thin+1)%3,(thin+2)%3
        start=len(vertices); steps=32; cross_steps=4; core=.55; radius=.45
        for i in range(steps):
            corner=i//8; angle=(corner*math.pi/2)+(i%8)*math.pi/16
            sx=1 if corner in (0,3) else -1; sy=1 if corner in (0,1) else -1
            cu,cv=sx*core+radius*math.cos(angle),sy*core+radius*math.sin(angle)
            for j in range(cross_steps):
                around=j*2*math.pi/cross_steps
                q=[0.,0.,0.];n=[0.,0.,0.]
                q[u]=cu+.012*math.cos(around)*math.cos(angle); q[v]=cv+.012*math.cos(around)*math.sin(angle);q[thin]=.012*math.sin(around)
                n[u]=math.cos(around)*math.cos(angle);n[v]=math.cos(around)*math.sin(angle);n[thin]=math.sin(around)
                point(q,n)
        for i in range(steps):
            for j in range(cross_steps):
                a=start+i*cross_steps+j;b=start+((i+1)%steps)*cross_steps+j
                quad(a,b,start+((i+1)%steps)*cross_steps+(j+1)%cross_steps,start+i*cross_steps+(j+1)%cross_steps)
    mesh=triangle_mesh(part,vertices,faces,None if profile in ('canopy','sprig','greenhouse','grass','vehicle_shell','molded_shell','leaf') else normals)
    if fit:
        mesh=fit_profile_mesh(part,mesh)
        if profile in ('organic','leaf') or profile in ('vehicle_shell','molded_shell') and part.get('geometry_shading')!='flat': crease_normals(mesh)
        # Authored geometry precision is 1e-12 normalized units; remove libm
        # residue before exact tuple indexing, well below display resolution.
        for key in ('vertices','normals'):
            mesh[key]=[[round(value,12) for value in point] for point in mesh[key]]
    return mesh


def crease_normals(mesh):
    """Author a 60-degree smoothing boundary at sharp anatomical folds.

    Work in the final fitted coordinates. Nonuniform part scaling must not turn
    an averaged ankle/sole normal into an inward-facing shading normal.
    """
    keys=[tuple(round(v,12) for v in p) for p in mesh['vertices']]
    adjacent={key:set() for key in keys};faces=[];unit_faces=[]
    for start in range(0,len(keys),3):
        a,b,c=mesh['vertices'][start:start+3]
        u=[b[i]-a[i] for i in range(3)];v=[c[i]-a[i] for i in range(3)]
        n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]
        length=math.sqrt(sum(x*x for x in n));face=len(faces)
        faces.append(n);unit_faces.append([x/length for x in n])
        for key in keys[start:start+3]:adjacent[key].add(face)
    normals=[]
    for index,key in enumerate(keys):
        reference=unit_faces[index//3];n=[0.,0.,0.]
        for face in sorted(adjacent[key]):
            if sum(reference[i]*unit_faces[face][i] for i in range(3))>=.5-1e-10:
                for i in range(3):n[i]+=faces[face][i]
        length=math.sqrt(sum(x*x for x in n));normals.append([x/length for x in n])
    mesh['normals']=normals


def fit_profile_mesh(part, mesh, reference=None):
    # One affine envelope adjustment is shared by body and inset pattern charts.
    reference=mesh if reference is None else reference
    legacy=primitive({k:v for k,v in part.items() if k!='geometry_profile'})
    old_bounds=[(min(p[i] for p in legacy['vertices']),max(p[i] for p in legacy['vertices'])) for i in range(3)]
    new_bounds=[(min(p[i] for p in reference['vertices']),max(p[i] for p in reference['vertices'])) for i in range(3)]
    scales=[(b-a)/(d-c) for (a,b),(c,d) in zip(old_bounds,new_bounds)]
    mesh['vertices']=[[old_bounds[i][0]+(p[i]-new_bounds[i][0])*scales[i] for i in range(3)] for p in mesh['vertices']]
    changed=[]
    for normal in mesh['normals']:
        n=[normal[i]/scales[i] for i in range(3)]; length=math.sqrt(sum(v*v for v in n))
        changed.append([v/length for v in n])
    mesh['normals']=changed
    return mesh


def chart_uv(mesh, dimensions):
    """Unfold each dominant face in physical meters without cross-face blending."""
    scale=[dimensions[k] for k in ('width','height','depth')]
    uv=[]
    grain=mesh.get('surface_finish') in ('wood','rough_wood')
    extent=[(max(p[i] for p in mesh['vertices'])-min(p[i] for p in mesh['vertices']))*scale[i] for i in range(3)] if grain else None
    for start in range(0,len(mesh['vertices']),3):
        a,b,c=mesh['vertices'][start:start+3]
        u,v=[[p[i]*scale[i]-a[i]*scale[i] for i in range(3)] for p in (b,c)]
        normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]
        # A mathematically tied diagonal must choose the same chart on both
        # Python and JavaScript despite last-bit libm differences.
        magnitude=max(abs(value) for value in normal)
        dominant=next(i for i in range(3) if abs(normal[i]) >= magnitude*(1-1e-8))
        axes=((2,1),(0,2),(0,1))[dominant]
        if grain and extent[axes[1]]>extent[axes[0]]*(1+1e-8):axes=axes[::-1]
        uv.extend([[p[axes[0]]*scale[axes[0]],p[axes[1]]*scale[axes[1]]] for p in (a,b,c)])
    mesh['uv']=uv



def compact_mesh(mesh):
    """Reuse only exactly equal position/normal/UV tuples, retaining every seam."""
    seen={}; vertices=[]; normals=[]; uv=[]; indices=[]
    for old in mesh['indices']:
        key=tuple(mesh['vertices'][old]+mesh['normals'][old]+mesh['uv'][old])
        if key not in seen:
            seen[key]=len(vertices); vertices.append(mesh['vertices'][old]);normals.append(mesh['normals'][old]);uv.append(mesh['uv'][old])
        indices.append(seen[key])
    mesh.update(vertices=vertices,normals=normals,uv=uv,indices=indices)

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
    original_part=part
    if part.get('geometry_profile'):
        radius = 0 if part['geometry_profile']=='joined' else .45 if part['geometry_profile'] in ('cushion','tailored') else .34 if part['geometry_profile'] == 'soft' else .08 if part['geometry_profile'] == 'edge' else .025
        axis = 1 if part['pattern_face'] == 'top' else 2
        part = {**part, 'size': [value if i == axis else value*(1-radius) for i,value in enumerate(part['size'])]}
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
    meshes=[triangle_mesh(part, mesh['vertices'], mesh['faces']) for mesh in (background, accent)]
    if original_part.get('geometry_profile'):
        reference=refined_primitive(original_part,fit=False)
        meshes=[fit_profile_mesh(original_part,mesh,reference) for mesh in meshes]
    return meshes


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
    meshes, materials, curtain_patterns = [], {}, []
    pattern = item.get('pattern_id') if item.get('pattern_id') != 'none' else None
    patterned_mesh = {'name': 'pattern', 'vertices': [], 'normals': [], 'indices': [], 'kind': 'inventory'}
    for index, part in enumerate(model['parts']):
        color = (item['color'] if part['material'] == 'body' and item.get('color') else style['materials'].get(part['material'], part['material'])).lower()
        material = 'furniture_' + color[1:]
        materials[material] = linear_color(color)
        fabric = supports_curtain(model) and part['material'] in ('body', 'accent')
        tags = {'curtain_fabric': True, 'curtain_panel': 'left' if part['center'][0] < 0 else 'right'} if fabric else {}
        mesh = {'name': 'part_' + str(index), **primitive(part, bool(pattern and part.get('pattern_face'))), 'material': material, 'kind': 'inventory', **tags}
        if pattern and part.get('pattern_face'):
            background, accent = pattern_surface(part, pattern)
            append_mesh(mesh, background)
            if fabric:
                curtain_patterns.append({'name': 'pattern_' + str(index), **accent, 'kind': 'inventory', **tags})
            else:
                append_mesh(patterned_mesh, accent)
        mesh.update(surface_finish=part.get('surface_finish', 'painted'), material_family=part.get('surface_finish', 'painted'))
        meshes.append(mesh)
    if pattern:
        color = item.get('pattern_color', style['materials']['accent']).lower()
        patterned_mesh['material'] = 'furniture_' + color[1:]
        materials[patterned_mesh['material']] = linear_color(color)
        if patterned_mesh['vertices']:
            meshes.append(patterned_mesh)
        meshes.extend({**mesh, 'material': patterned_mesh['material']} for mesh in curtain_patterns)
    pattern_finish = next((p.get('surface_finish', 'painted') for p in model['parts'] if p.get('pattern_face')), 'painted')
    for mesh in meshes:
        if 'surface_finish' not in mesh:
            mesh.update(surface_finish=pattern_finish, material_family=pattern_finish)
        chart_uv(mesh, item.get('dimensions_m', model['dimensions_m']))
        if any(p.get('geometry_profile') for p in model['parts']): compact_mesh(mesh)
    return {'meshes': meshes, 'materials': materials}
