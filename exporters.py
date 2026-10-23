"""glTF, USD, OBJ and COLLADA exports from the same metric triangle meshes."""
import json, struct

def export_models(data, ROOT, stem):
    meshes=data['meshes'];MATS=data['materials'];H=data['ceiling_height_m']
    def export_glb():
        blob=bytearray();views=[];accessors=[];gm=[];nodes=[]
        def accessor(vals,fmt,typ,target):
            while len(blob)%4:blob.append(0)
            offset=len(blob);flat=[v for row in vals for v in row] if isinstance(vals[0],list) else vals
            bb=struct.pack('<'+fmt*len(flat),*flat);blob.extend(bb)
            views.append(dict(buffer=0,byteOffset=offset,byteLength=len(bb),target=target))
            a=dict(bufferView=len(views)-1,componentType=5126 if fmt=='f' else 5125,count=len(vals),type=typ)
            if typ=='VEC3':a.update(min=[min(v[i] for v in vals) for i in range(3)],max=[max(v[i] for v in vals) for i in range(3)])
            accessors.append(a);return len(accessors)-1
        for m in meshes:
            p=accessor(m['vertices'],'f','VEC3',34962);n=accessor(m['normals'],'f','VEC3',34962);idx=accessor(m['indices'],'I','SCALAR',34963)
            gm.append(dict(name=m['name'],primitives=[dict(attributes=dict(POSITION=p,NORMAL=n),indices=idx,material=list(MATS).index(m['material']))]))
            nodes.append(dict(name=m['name'],mesh=len(gm)-1,extras=dict(category=m['kind'],estimated=m.get('estimated',False))))
        gl=dict(asset=dict(version='2.0',generator=data['title']+' dimension-constrained reconstruction'),scene=0,
           scenes=[dict(name=stem+'_ceiling_2_7m',nodes=list(range(len(nodes))))],nodes=nodes,meshes=gm,
           materials=[dict(name=k,pbrMetallicRoughness=dict(baseColorFactor=v,metallicFactor=.05,roughnessFactor=.72),doubleSided=True,alphaMode='BLEND' if v[3]<1 else 'OPAQUE') for k,v in MATS.items()],
           buffers=[dict(byteLength=len(blob))],bufferViews=views,accessors=accessors,
           extras=dict(units='metres',ceiling_height=H,status='provisional reconstruction; see README.md'))
        jj=json.dumps(gl,separators=(',',':')).encode();jj+=b' '*((-len(jj))%4);blob+=b'\0'*((-len(blob))%4)
        (ROOT/(stem+'.glb')).write_bytes(struct.pack('<III',0x46546c67,2,28+len(jj)+len(blob))+struct.pack('<II',len(jj),0x4e4f534a)+jj+struct.pack('<II',len(blob),0x004e4942)+blob)
    export_glb()

    # USDA is Y-up and metrically identical to the GLB; package_usdz.py creates the archive.
    lines=['#usda 1.0','(defaultPrim = "HomeModel"',' metersPerUnit = 1',' upAxis = "Y")','def Xform "HomeModel" {',' def Scope "Materials" {']
    for name,col in MATS.items():
        lines += [f'  def Material "{name}" {{',f'   token outputs:surface.connect = </HomeModel/Materials/{name}/Shader.outputs:surface>',
           '   def Shader "Shader" {','    uniform token info:id = "UsdPreviewSurface"',f'    color3f inputs:diffuseColor = ({col[0]}, {col[1]}, {col[2]})',f'    float inputs:opacity = {col[3]}','    float inputs:roughness = 0.72','    token outputs:surface','   }','  }']
    lines+=[' }']
    for m in meshes:
        pts=', '.join('('+', '.join(f'{x:.7f}' for x in p)+')' for p in m['vertices'])
        ns=', '.join('('+', '.join(f'{x:.6f}' for x in p)+')' for p in m['normals'])
        lines += [f' def Mesh "{m["name"]}" (prepend apiSchemas = ["MaterialBindingAPI"]) {{',f'  point3f[] points = [{pts}]',f'  int[] faceVertexCounts = [{", ".join(["3"]*(len(m["indices"])//3))}]',f'  int[] faceVertexIndices = [{", ".join(map(str,m["indices"]))}]',f'  normal3f[] normals = [{ns}] (interpolation = "vertex")','  uniform token subdivisionScheme = "none"','  uniform bool doubleSided = true',f'  rel material:binding = </HomeModel/Materials/{m["material"]}>',' }']
    lines+=['}'];(ROOT/(stem+'.usda')).write_text('\n'.join(lines).replace('HomeModel',stem.title()), encoding='utf-8')

    # OBJ/DAE use Z-up for architectural import; the plan-down coordinate becomes -Y.
    obj=['# '+data['title']+', METRES, Z up; imported reference meshes, not BIM families','mtllib '+stem+'.mtl'];off=1
    for m in meshes:
        obj.extend([f'o {m["name"]}',f'usemtl {m["material"]}'])
        obj.extend(f'v {x:.7f} {-z:.7f} {y:.7f}' for x,y,z in m['vertices'])
        obj.extend('f '+' '.join(str(off+i) for i in m['indices'][j:j+3]) for j in range(0,len(m['indices']),3));off+=len(m['vertices'])
    (ROOT/(stem+'.obj')).write_text('\n'.join(obj), encoding='utf-8')
    (ROOT/(stem+'.mtl')).write_text('\n'.join(f'newmtl {k}\nKd {v[0]} {v[1]} {v[2]}\nd {v[3]}\n' for k,v in MATS.items()), encoding='utf-8')
    dae=['<?xml version="1.0" encoding="utf-8"?>','<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1"><asset><contributor><authoring_tool>Home floorplan builder</authoring_tool></contributor><created>2026-09-19T00:00:00Z</created><modified>2026-09-19T00:00:00Z</modified><unit name="meter" meter="1"/><up_axis>Z_UP</up_axis></asset><library_effects>']
    for k,v in MATS.items():dae.append(f'<effect id="{k}-fx"><profile_COMMON><technique sid="common"><lambert><diffuse><color>{" ".join(map(str,v))}</color></diffuse></lambert></technique></profile_COMMON></effect>')
    dae+=['</library_effects><library_materials>']
    for k in MATS:dae.append(f'<material id="{k}-mat" name="{k}"><instance_effect url="#{k}-fx"/></material>')
    dae+=['</library_materials><library_geometries>']
    for i,m in enumerate(meshes):
        vals=' '.join(f'{v:.7f}' for x,y,z in m['vertices'] for v in (x,-z,y));n=len(m['vertices'])
        dae.append(f'<geometry id="g{i}" name="{m["name"]}"><mesh><source id="g{i}-pos"><float_array id="g{i}-arr" count="{n*3}">{vals}</float_array><technique_common><accessor source="#g{i}-arr" count="{n}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source><vertices id="g{i}-v"><input semantic="POSITION" source="#g{i}-pos"/></vertices><triangles material="mat" count="{len(m["indices"])//3}"><input semantic="VERTEX" source="#g{i}-v" offset="0"/><p>{" ".join(map(str,m["indices"]))}</p></triangles></mesh></geometry>')
    dae+=['</library_geometries><library_visual_scenes><visual_scene id="Scene" name="Home floorplan">']
    for i,m in enumerate(meshes):dae.append(f'<node id="n{i}" name="{m["name"]}"><instance_geometry url="#g{i}"><bind_material><technique_common><instance_material symbol="mat" target="#{m["material"]}-mat"/></technique_common></bind_material></instance_geometry></node>')
    dae+=['</visual_scene></library_visual_scenes><scene><instance_visual_scene url="#Scene"/></scene></COLLADA>'];(ROOT/(stem+'.dae')).write_text('\n'.join(dae), encoding='utf-8')


# Interactive exports are independent of the historical on-disk export bundle.
# Only geometry, colors, validated embedded albedo and display labels cross this
# boundary; never model extras or references to external image resources.
MAX_EXPORT_TRIANGLES = 200_000
MAX_EXPORT_BYTES = 32 * 1024 * 1024


def export_scene(floors, format):
    """Serialize an allowlisted scene of floor/item groups, without writing files.

    Each group contains local meshes plus translation, Y rotation (radians) and
    positive scale. GLB preserves those pivots; OBJ bakes them into one object per
    group and travels with its material library and optional PNGs in a ZIP.
    """
    import io
    import math
    import re
    import zipfile
    if __package__:
        from .material_textures import decode_material_texture, material_uv
    else:
        from material_textures import decode_material_texture, material_uv

    if format not in ('glb', 'obj'):
        raise ValueError('Choose GLB or OBJ for this export.')
    materials, colors, count, vertex_count, mesh_count = [], {}, 0, 0, 0
    image_ids, image_bytes, material_maps = {}, [], []

    def material_key(mesh):
        return tuple(mesh['color']) + (mesh.get('texture', {}).get('data_uri'),)

    def label(value):
        # Entity references sometimes occur in commissioned mesh/display names.
        value = re.sub(r'\b[a-z_]+\.[a-z0-9_]+\b', 'object', str(value))
        return ''.join(char for char in value if char.isprintable())[:120] or 'Object'

    def finite(values, length):
        return (isinstance(values, (list, tuple)) and len(values) == length and
                all(type(value) in (int, float) and math.isfinite(value) for value in values))

    for floor in floors:
        if not math.isfinite(floor['elevation']):
            raise ValueError('Invalid floor elevation.')
        for group in floor['groups']:
            if (not finite(group['translation'], 3) or not finite(group['scale'], 3) or
                    min(group['scale']) <= 0 or not math.isfinite(group['rotation'])):
                raise ValueError('Invalid object transform.')
            for mesh in group['meshes']:
                vertices, normals, indices = mesh['vertices'], mesh['normals'], mesh['indices']
                count += len(indices) // 3
                vertex_count += len(vertices)
                mesh_count += 1
                if count > MAX_EXPORT_TRIANGLES or vertex_count > MAX_EXPORT_TRIANGLES * 3 or mesh_count > 20_000:
                    raise ValueError('Export exceeds 200,000 triangles. Export one floor or reduce detailed furniture.')
                if (not vertices or len(normals) != len(vertices) or not indices or len(indices) % 3 or
                        not all(finite(vertex, 3) for vertex in vertices) or
                        not all(finite(normal, 3) for normal in normals) or
                        not all(type(index) is int and 0 <= index < len(vertices) for index in indices)):
                    raise ValueError('The installed model contains invalid export geometry.')
                color = tuple(mesh['color'])
                if not finite(color, 4) or not all(0 <= value <= 1 for value in color):
                    raise ValueError('The installed model contains an invalid material.')
                image_index = None
                if 'texture' in mesh:
                    if color[3] != 1:
                        raise ValueError('Albedo textures require an opaque material.')
                    material_uv(mesh)
                    if not isinstance(mesh['texture'], dict):
                        raise ValueError('Invalid material texture.')
                    uri = mesh['texture'].get('data_uri')
                    if not isinstance(uri, str):
                        raise ValueError('Invalid material texture URI.')
                    if set(mesh['texture']) != {'data_uri', 'width', 'height', 'mime_type'} or mesh['texture']['width'] != 256 or mesh['texture']['height'] != 256 or mesh['texture']['mime_type'] != 'image/png':
                        raise ValueError('Invalid material texture descriptor.')
                    if uri not in image_ids:
                        image_bytes.append(decode_material_texture(mesh['texture']))
                        image_ids[uri] = len(image_bytes) - 1
                        if len(image_bytes) > 8 or sum(map(len, image_bytes)) > 524288:
                            raise ValueError('Export exceeds the material texture budget.')
                    image_index = image_ids[uri]
                key = material_key(mesh)
                if key not in colors:
                    colors[key] = len(materials)
                    materials.append(color)
                    material_maps.append(image_index)
    if not count:
        raise ValueError('Add a room or object before exporting.')

    def bounded_extend(target, data):
        if len(target) + len(data) > MAX_EXPORT_BYTES:
            raise ValueError('Export exceeds 32 MB. Export one floor or reduce detailed furniture.')
        target.extend(data)

    if format == 'glb':
        blob, views, accessors, meshes, nodes, roots = bytearray(), [], [], [], [], []

        def accessor(values, vector):
            while len(blob) % 4:
                blob.append(0)
            offset = len(blob)
            if vector:
                for value in values:
                    bounded_extend(blob, struct.pack('<' + str(vector) + 'f', *value))
            else:
                for value in values:
                    bounded_extend(blob, struct.pack('<I', value))
            views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(blob) - offset,
                          'target': 34962 if vector else 34963})
            entry = {'bufferView': len(views) - 1, 'componentType': 5126 if vector else 5125,
                     'count': len(values), 'type': 'VEC' + str(vector) if vector else 'SCALAR'}
            if vector == 3:
                entry.update(min=[min(row[axis] for row in values) for axis in range(3)],
                             max=[max(row[axis] for row in values) for axis in range(3)])
            accessors.append(entry)
            return len(accessors) - 1

        for floor_number, floor in enumerate(floors, 1):
            roots.append(len(nodes))
            floor_node = {'name': 'Floor ' + str(floor_number), 'translation': [0, floor['elevation'], 0], 'children': []}
            nodes.append(floor_node)
            for group in floor['groups']:
                floor_node['children'].append(len(nodes))
                angle = group['rotation'] / 2
                node = {'name': label(group['name']), 'translation': group['translation'],
                        'rotation': [0, math.sin(angle), 0, math.cos(angle)], 'scale': group['scale'], 'children': []}
                nodes.append(node)
                for part, mesh in enumerate(group['meshes']):
                    position = accessor(mesh['vertices'], 3)
                    normal = accessor(mesh['normals'], 3)
                    indices = accessor(mesh['indices'], 0)
                    attributes = {'POSITION': position, 'NORMAL': normal}
                    if 'texture' in mesh:
                        # glTF's image origin is top-left; native Three maps and
                        # OBJ use bottom-left UVs. Keep the same visual surface.
                        attributes['TEXCOORD_0'] = accessor([[u, 1-v] for u, v in mesh['uv']], 2)
                    node['children'].append(len(nodes))
                    nodes.append({'name': label(group['name']) + ' / part ' + str(part + 1), 'mesh': len(meshes)})
                    meshes.append({'primitives': [{'attributes': attributes,
                                                   'indices': indices, 'material': colors[material_key(mesh)]}]})
        images = []
        for raw in image_bytes:
            blob.extend(b'\0' * (-len(blob) % 4))
            views.append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(raw)})
            bounded_extend(blob, raw)
            images.append({'bufferView': len(views)-1, 'mimeType': 'image/png'})
        document = {'asset': {'version': '2.0', 'generator': 'Home Studio geometry export'},
                    'scene': 0, 'scenes': [{'nodes': roots}], 'nodes': nodes, 'meshes': meshes,
                    'materials': [{'name': 'material_' + str(index), 'doubleSided': True,
                                   'alphaMode': 'BLEND' if color[3] < 1 else 'OPAQUE',
                                   'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1] if material_maps[index] is not None else color,
                                                           'metallicFactor': .05, 'roughnessFactor': .72,
                                                           **({'baseColorTexture': {'index': material_maps[index]}} if material_maps[index] is not None else {})}}
                                  for index, color in enumerate(materials)],
                    'buffers': [{'byteLength': len(blob)}], 'bufferViews': views, 'accessors': accessors}
        if images:
            document.update(images=images, samplers=[{'wrapS': 10497, 'wrapT': 10497, 'minFilter': 9987, 'magFilter': 9729}],
                            textures=[{'source': index, 'sampler': 0} for index in range(len(images))])
        payload = json.dumps(document, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode()
        payload += b' ' * (-len(payload) % 4)
        blob.extend(b'\0' * (-len(blob) % 4))
        total = 28 + len(payload) + len(blob)
        if total > MAX_EXPORT_BYTES:
            raise ValueError('Export exceeds 32 MB. Export one floor or reduce detailed furniture.')
        return (struct.pack('<III', 0x46546C67, 2, total) + struct.pack('<II', len(payload), 0x4E4F534A) +
                payload + struct.pack('<II', len(blob), 0x004E4942) + blob)

    obj, mtl, offset, ordinal, uv_offset = bytearray(), bytearray(), 1, 0, 1
    def line(target, value):
        bounded_extend(target, (value + '\n').encode('utf-8'))
    line(obj, '# Home Studio; metres; Z up')
    line(obj, 'mtllib materials.mtl')
    for floor in floors:
        for group in floor['groups']:
            ordinal += 1
            # Leading ordinal makes duplicate user labels unambiguous to importers.
            name = re.sub(r'[^\w -]', '_', label(floor['name']) + ' ' + label(group['name']))
            line(obj, f'o {ordinal}_{name}')
            cosine, sine = math.cos(group['rotation']), math.sin(group['rotation'])
            sx, sy, sz = group['scale']
            tx, ty, tz = group['translation']
            for mesh in group['meshes']:
                line(obj, 'usemtl material_' + str(colors[material_key(mesh)]))
                for x, y, z in mesh['vertices']:
                    x, y, z = x * sx, y * sy, z * sz
                    x, y, z = tx + cosine * x + sine * z, ty + y + floor['elevation'], tz - sine * x + cosine * z
                    if not all(math.isfinite(value) for value in (x, y, z)):
                        raise ValueError('The installed model contains invalid export coordinates.')
                    line(obj, f'v {x:.9g} {-z:.9g} {y:.9g}')
                for x, y, z in mesh['normals']:
                    x, y, z = x / sx, y / sy, z / sz
                    x, z = cosine * x + sine * z, -sine * x + cosine * z
                    length = math.hypot(x, y, z) or 1
                    line(obj, f'vn {x/length:.9g} {-z/length:.9g} {y/length:.9g}')
                textured = 'texture' in mesh
                if textured:
                    for u, v in mesh['uv']:
                        line(obj, f'vt {u:.9g} {v:.9g}')
                for start in range(0, len(mesh['indices']), 3):
                    line(obj, 'f ' + ' '.join(f'{offset + index}/{uv_offset + index if textured else ""}/{offset + index}' for index in mesh['indices'][start:start+3]))
                if textured:
                    uv_offset += len(mesh['vertices'])
                offset += len(mesh['vertices'])
    for index, color in enumerate(materials):
        image_index = material_maps[index]
        rgb = [1, 1, 1] if image_index is not None else color[:3]
        line(mtl, f'newmtl material_{index}\nKd {rgb[0]} {rgb[1]} {rgb[2]}\nd {color[3]}')
        if image_index is not None:
            line(mtl, f'map_Kd textures/material_{image_index}.png')
    if len(obj) + len(mtl) + sum(map(len, image_bytes)) > MAX_EXPORT_BYTES:
        raise ValueError('Export exceeds 32 MB. Export one floor or reduce detailed furniture.')
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('home.obj', obj)
        archive.writestr('materials.mtl', mtl)
        for index, raw in enumerate(image_bytes):
            archive.writestr(f'textures/material_{index}.png', raw)
    payload = output.getvalue()
    if len(payload) > MAX_EXPORT_BYTES:
        raise ValueError('Export exceeds 32 MB. Export one floor or reduce detailed furniture.')
    return payload
