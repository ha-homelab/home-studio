"""glTF, USD, OBJ and COLLADA exports from the same metric triangle meshes."""
import json, struct
if __package__:
    from .material_textures import material_surface_profile
    from .pbr_materials import validate_pbr_fields, packed_metallic_roughness, gltf_normal_spec
else:
    from material_textures import material_surface_profile
    from pbr_materials import validate_pbr_fields, packed_metallic_roughness, gltf_normal_spec

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
           materials=[dict(name=k,pbrMetallicRoughness=dict(baseColorFactor=v,metallicFactor=material_surface_profile(k)["metalness"],roughnessFactor=material_surface_profile(k)["roughness"]),doubleSided=True,alphaMode='BLEND' if v[3]<1 else 'OPAQUE') for k,v in MATS.items()],
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
# Only geometry, colors, validated embedded material channels and display labels cross this
# boundary; never model extras or references to external image resources.
MAX_EXPORT_TRIANGLES = 500_000
MAX_EXPORT_BYTES = 32 * 1024 * 1024


def _compact_export_mesh(mesh):
    """Reuse exact corner attributes without changing normal or UV seams."""
    used = set(mesh['indices'])
    textured = any(key in mesh for key in ('texture','normal_texture','roughness_texture','metalness_texture','ao_texture'))
    vertices, normals, uv, remap, unique = [], [], [], {}, {}
    for index, vertex in enumerate(mesh['vertices']):
        if index not in used:
            continue
        key = (tuple(vertex), tuple(mesh['normals'][index]),
               tuple(mesh['uv'][index]) if textured else None)
        if key not in unique:
            unique[key] = len(vertices)
            vertices.append(vertex)
            normals.append(mesh['normals'][index])
            if textured:
                uv.append(mesh['uv'][index])
        remap[index] = unique[key]
    result = {**mesh, 'vertices': vertices, 'normals': normals,
              'indices': [remap[index] for index in mesh['indices']]}
    if textured:
        result['uv'] = uv
    return result


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
        from .material_textures import decode_material_texture, material_uv, MAX_MATERIAL_TEXTURES, MAX_MATERIAL_TEXTURE_BYTES, MAX_MATERIAL_TEXTURE_PIXELS, MATERIAL_SURFACE_FINISHES
    else:
        from material_textures import decode_material_texture, material_uv, MAX_MATERIAL_TEXTURES, MAX_MATERIAL_TEXTURE_BYTES, MAX_MATERIAL_TEXTURE_PIXELS, MATERIAL_SURFACE_FINISHES

    if format not in ('glb', 'obj'):
        raise ValueError('Choose GLB or OBJ for this export.')
    materials, colors, count, vertex_count, mesh_count = [], {}, 0, 0, 0
    image_ids, image_bytes, image_pixels, material_maps, material_profiles, material_flags = {}, [], [], [], [], []
    channels = ('texture', 'normal_texture', 'roughness_texture', 'metalness_texture', 'ao_texture')
    packed_cache, decoded_cache = {}, {}

    def decode_once(spec):
        if not isinstance(spec,dict) or set(spec)!={'data_uri','width','height','mime_type'}:
            raise ValueError('Invalid material texture descriptor')
        if not isinstance(spec['data_uri'],str) or type(spec['width']) is not int or type(spec['height']) is not int or not isinstance(spec['mime_type'],str):
            raise ValueError('Invalid material texture descriptor')
        key=(spec['data_uri'],spec['width'],spec['height'],spec['mime_type'])
        if key not in decoded_cache: decoded_cache[key]=decode_material_texture(spec)
        return decoded_cache[key]

    def material_key(mesh):
        profile = material_surface_profile(mesh.get('material_name'), mesh.get('surface_finish'))
        return tuple(mesh['color']) + tuple(mesh.get(key, {}).get('data_uri') for key in channels) + (profile['roughness'], profile['metalness'], mesh.get('normal_scale',1), mesh.get('ao_strength',1), mesh.get('albedo_tint',False), tuple(sorted(mesh.get('pbr_repeats',{}).items())))

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
                    raise ValueError('Export exceeds 500,000 triangles. Export one floor or reduce detailed furniture.')
                if (not vertices or len(normals) != len(vertices) or not indices or len(indices) % 3 or
                        not all(finite(vertex, 3) for vertex in vertices) or
                        not all(finite(normal, 3) for normal in normals) or
                        not all(type(index) is int and 0 <= index < len(vertices) for index in indices)):
                    raise ValueError('The installed model contains invalid export geometry.')
                color = tuple(mesh['color'])
                if not finite(color, 4) or not all(0 <= value <= 1 for value in color):
                    raise ValueError('The installed model contains an invalid material.')
                validate_pbr_fields(mesh, MATERIAL_SURFACE_FINISHES)
                repeats = mesh.get('pbr_repeats', {})
                if not isinstance(repeats, dict) or any(key not in channels or type(value) not in (int,float) or not math.isfinite(value) or not 0 < value <= 1000000 for key,value in repeats.items()):
                    raise ValueError('Invalid texture repeat')
                maps = {}
                if any(key in mesh for key in channels): material_uv(mesh)
                if 'texture' in mesh and color[3] != 1: raise ValueError('Albedo textures require an opaque material.')
                source_maps = {key:mesh[key] for key in channels if key in mesh}
                for spec in source_maps.values(): decode_once(spec)
                if format == 'glb':
                    rough,metal=mesh.get('roughness_texture'),mesh.get('metalness_texture')
                    if rough or metal:
                        if rough and metal and repeats.get('roughness_texture',1)!=repeats.get('metalness_texture',1):
                            raise ValueError('glTF metallic and roughness maps require the same physical repeat')
                        cache_key=(rough and rough['data_uri'],metal and metal['data_uri'])
                        if cache_key not in packed_cache: packed_cache[cache_key]=packed_metallic_roughness(rough,metal)
                        source_maps['metallic_roughness_texture']=packed_cache[cache_key]
                    source_maps.pop('roughness_texture',None);source_maps.pop('metalness_texture',None)
                    if 'normal_texture' in source_maps:
                        spec=source_maps['normal_texture'];source_maps['normal_texture']=gltf_normal_spec(spec['data_uri'],spec['width'])
                for channel,spec in source_maps.items():
                    raw = decode_once(spec); uri=spec['data_uri']
                    if uri not in image_ids:
                        image_ids[uri]=len(image_bytes);image_bytes.append(raw);image_pixels.append(spec['width']*spec['height'])
                        if len(image_bytes)>MAX_MATERIAL_TEXTURES or sum(map(len,image_bytes))>MAX_MATERIAL_TEXTURE_BYTES or sum(image_pixels)>MAX_MATERIAL_TEXTURE_PIXELS:
                            raise ValueError('Export exceeds the material texture budget.')
                    repeat=repeats.get(channel,repeats.get('roughness_texture',repeats.get('metalness_texture',1)) if channel=='metallic_roughness_texture' else 1)
                    maps[channel]=(image_ids[uri],repeat)
                key = material_key(mesh)
                if key not in colors:
                    colors[key] = len(materials)
                    materials.append(color)
                    material_maps.append(maps)
                    material_flags.append({'normal_scale':mesh.get('normal_scale',1),'ao_strength':mesh.get('ao_strength',1),'albedo_tint':mesh.get('albedo_tint',False)})
                    material_profiles.append(material_surface_profile(mesh.get("material_name"), mesh.get("surface_finish")))
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
                    mesh = _compact_export_mesh(mesh)
                    position = accessor(mesh['vertices'], 3)
                    normal = accessor(mesh['normals'], 3)
                    indices = accessor(mesh['indices'], 0)
                    attributes = {'POSITION': position, 'NORMAL': normal}
                    if any(key in mesh for key in channels):
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
        def texture_info(pair, **extra):
            index,repeat=pair
            return {'index':index, **extra, **({'extensions':{'KHR_texture_transform':{'scale':[repeat,repeat],'offset':[0,1-repeat]}}} if repeat!=1 else {})}

        gltf_materials=[]
        for index,color in enumerate(materials):
            maps,flags=material_maps[index],material_flags[index]
            entry={'name':'material_'+str(index),'doubleSided':True,'alphaMode':'BLEND' if color[3]<1 else 'OPAQUE',
                   'pbrMetallicRoughness':{'baseColorFactor':[1,1,1,1] if 'texture' in maps and not flags['albedo_tint'] else color,
                       'metallicFactor':material_profiles[index]['metalness'],'roughnessFactor':material_profiles[index]['roughness']}}
            if 'texture' in maps: entry['pbrMetallicRoughness']['baseColorTexture']=texture_info(maps['texture'])
            if 'metallic_roughness_texture' in maps: entry['pbrMetallicRoughness']['metallicRoughnessTexture']=texture_info(maps['metallic_roughness_texture'])
            if 'normal_texture' in maps: entry['normalTexture']=texture_info(maps['normal_texture'],scale=flags['normal_scale'])
            if 'ao_texture' in maps: entry['occlusionTexture']=texture_info(maps['ao_texture'],strength=flags['ao_strength'])
            gltf_materials.append(entry)
        document = {'asset': {'version': '2.0', 'generator': 'Home Studio geometry export'},
                    'scene': 0, 'scenes': [{'nodes': roots}], 'nodes': nodes, 'meshes': meshes,
                    'materials': gltf_materials,
                    'buffers': [{'byteLength': len(blob)}], 'bufferViews': views, 'accessors': accessors}
        if any(repeat!=1 for maps in material_maps for _,repeat in maps.values()): document['extensionsUsed']=['KHR_texture_transform']
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

    obj, mtl, ordinal = bytearray(), bytearray(), 0
    position_ids, normal_ids, uv_ids = {}, {}, {}
    def line(target, value):
        bounded_extend(target, (value + '\n').encode('utf-8'))
    def attribute(pool, kind, values):
        key = tuple(values)
        if key not in pool:
            pool[key] = len(pool) + 1
            line(obj, kind + ' ' + ' '.join(f'{value:.9g}' for value in key))
        return pool[key]
    def reference(index, pool):
        # OBJ permits indices relative to the latest attribute declaration.
        # Either spelling resolves to the same corner; choose the shorter one.
        absolute, relative = str(index), str(index - len(pool) - 1)
        return relative if len(relative) < len(absolute) else absolute
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
                mesh = _compact_export_mesh(mesh)
                line(obj, 'usemtl material_' + str(colors[material_key(mesh)]))
                positions, normals, uvs = [], [], []
                for x, y, z in mesh['vertices']:
                    x, y, z = x * sx, y * sy, z * sz
                    x, y, z = tx + cosine * x + sine * z, ty + y + floor['elevation'], tz - sine * x + cosine * z
                    if not all(math.isfinite(value) for value in (x, y, z)):
                        raise ValueError('The installed model contains invalid export coordinates.')
                    positions.append(attribute(position_ids, 'v', (x, -z, y)))
                for x, y, z in mesh['normals']:
                    x, y, z = x / sx, y / sy, z / sz
                    x, z = cosine * x + sine * z, -sine * x + cosine * z
                    length = math.hypot(x, y, z) or 1
                    normals.append(attribute(normal_ids, 'vn', (x/length, -z/length, y/length)))
                textured = any(key in mesh for key in ('texture','normal_texture','roughness_texture','metalness_texture','ao_texture'))
                if textured:
                    for u, v in mesh['uv']:
                        uvs.append(attribute(uv_ids, 'vt', (u, v)))
                for start in range(0, len(mesh['indices']), 3):
                    line(obj, 'f ' + ' '.join(f'{reference(positions[index], position_ids)}/'
                                             f'{reference(uvs[index], uv_ids) if textured else ""}/'
                                             f'{reference(normals[index], normal_ids)}'
                                             for index in mesh['indices'][start:start+3]))
    for index, color in enumerate(materials):
        maps,flags=material_maps[index],material_flags[index]
        rgb=[1,1,1] if 'texture' in maps and not flags['albedo_tint'] else color[:3]
        line(mtl,f'newmtl material_{index}\nKd {rgb[0]} {rgb[1]} {rgb[2]}\nd {color[3]}')
        line(mtl,f"Pr {material_profiles[index]['roughness']}\nPm {material_profiles[index]['metalness']}")
        for channel,keyword in (('texture','map_Kd'),('normal_texture','norm'),('roughness_texture','map_Pr'),('metalness_texture','map_Pm'),('ao_texture','map_Ka')):
            if channel in maps:
                image_index,repeat=maps[channel]
                options=(f'-s {repeat} {repeat} 1 ' if repeat!=1 else '') + ({'roughness_texture':'-imfchan g ','metalness_texture':'-imfchan b ','ao_texture':'-imfchan r '}.get(channel,''))
                line(mtl,f'{keyword} {options}textures/material_{image_index}.png')
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
