"""Physical on-disk exports, explicitly selected by new PBR-capable builders.

USD uses Cartesian texture coordinates and tangent normals (no glTF V flip).
COLLADA preserves albedo, vertex normals and UVs; PBR extensions are advisory.
"""
import base64
import functools
import hashlib
import io
import json
import re
import struct
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

if __package__:
    from .material_textures import material_surface_profile, material_uv, decode_material_texture
    from .pbr_materials import export_material_fields, rgb_pixels, png_spec
else:
    from material_textures import material_surface_profile, material_uv, decode_material_texture
    from pbr_materials import export_material_fields, rgb_pixels, png_spec

CHANNELS = ('texture', 'normal_texture', 'roughness_texture', 'metalness_texture', 'ao_texture')


def identifier(value):
    result = re.sub(r'[^A-Za-z0-9_]', '_', str(value))
    return result if result and not result[0].isdigit() else '_' + result


@functools.lru_cache(maxsize=262144)
def number(value):
    # All three formats store 32-bit attributes. Nine significant decimal digits
    # round-trip that representation, without the size of Python double repr.
    packed = struct.pack('<f', value)
    value = struct.unpack('<f', packed)[0]
    if value == 0:
        return '0'
    for precision in range(6, 10):
        result = format(value, '.' + str(precision) + 'g')
        if struct.pack('<f', float(result)) == packed:
            return result


def vector(values):
    return '(' + ','.join(number(v) for v in values) + ')'


def prepare(data):
    records = []
    definitions = data.get('material_textures', {})
    for source in data['meshes']:
        mesh = {key: source[key] for key in ('vertices', 'normals', 'indices')}
        mesh.update(color=data['materials'][source['material']], material_name=source['material'])
        if 'surface_finish' in source:
            mesh['surface_finish'] = source['surface_finish']
        mesh.update(export_material_fields(source, definitions))
        if any(key in mesh for key in CHANNELS):
            mesh['uv'] = material_uv(source)
        records.append((source, mesh))
    return records


def export_physical_models(data, root, stem):
    if __package__:
        from .exporters import export_scene, MAX_EXPORT_BYTES
    else:
        from exporters import export_scene, MAX_EXPORT_BYTES
    root = Path(root)
    if identifier(stem) != stem:
        raise ValueError('Physical export requires a safe model stem')
    records = prepare(data)
    scene = [{'name': data['title'], 'elevation': 0, 'groups': [
        {'name': source['name'], 'translation': [0, 0, 0], 'scale': [1, 1, 1],
         'rotation': 0, 'meshes': [mesh]} for source, mesh in records]}]
    # These shared serializers enforce all existing geometry/image/byte limits.
    glb = export_scene(scene, 'glb')
    archive = export_scene(scene, 'obj')
    length = struct.unpack_from('<I', glb, 12)[0]
    document = json.loads(glb[20:20 + length])
    identities = [set() for _ in document['materials']]
    for (source, _), gltf_mesh in zip(records, document['meshes']):
        identities[gltf_mesh['primitives'][0]['material']].add(source['material'])
        gltf_mesh.update(name=source['name'], extras={'source_mesh': source['name'], 'source_material': source['material']})
    # Input meshes are already world-space. Retain the historical one-node-per-
    # mesh identity rather than exporting redundant identity-transform groups.
    document['nodes'] = [{'name': source['name'], 'mesh': i,
                          'extras': {'category': source['kind'], 'estimated': source.get('estimated', False),
                                     'source_material': source['material']}}
                         for i, (source, _) in enumerate(records)]
    document['scenes'][0]['nodes'] = list(range(len(records)))
    material_names = []
    for index, (material, names) in enumerate(zip(document['materials'], identities)):
        name = identifier(sorted(names)[0]) + '__' + str(index)
        material_names.append(name)
        material.update(name=name, extras={'source_materials': sorted(names)})
    encoded = json.dumps(document, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
    encoded += b' ' * (-len(encoded) % 4)
    binary_chunk = glb[20 + length:]
    glb = struct.pack('<III', 0x46546c67, 2, 20 + len(encoded) + len(binary_chunk)) + struct.pack('<II', len(encoded), 0x4e4f534a) + encoded + binary_chunk
    if len(glb) > MAX_EXPORT_BYTES:
        raise ValueError('Physical GLB exceeds 32 MiB')
    (root / (stem + '.glb')).write_bytes(glb)
    images = {}

    def image(raw):
        digest = hashlib.sha256(raw).hexdigest()
        name = stem + '.textures/' + digest + '.png'
        images[name] = raw
        return name

    with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
        obj = zipped.read('home.obj').decode().replace('mtllib materials.mtl', 'mtllib ' + stem + '.mtl')
        mtl = zipped.read('materials.mtl').decode()
        for name in zipped.namelist():
            if name.startswith('textures/'):
                mtl = mtl.replace(name, image(zipped.read(name)))
    def rename(match):
        return match[1] + material_names[int(match[2])]
    obj = re.sub(r'(?m)^(usemtl )material_(\d+)$', rename, obj)
    object_names = iter(identifier(source['name']) for source, _ in records)
    obj = re.sub(r'(?m)^o .*$', lambda _: 'o ' + next(object_names), obj)
    mtl = re.sub(r'(?m)^(newmtl )material_(\d+)$', rename, mtl)
    (root / (stem + '.obj')).write_text(obj, encoding='utf-8')
    (root / (stem + '.mtl')).write_text(mtl, encoding='utf-8')

    materials, material_indices, selected = [], {}, []
    for source, mesh in records:
        profile = material_surface_profile(source['material'], source.get('surface_finish'))
        channels = {key: image(decode_material_texture(mesh[key])) for key in CHANNELS if key in mesh}
        record = {'source': source['material'], 'color': mesh['color'], 'profile': profile,
                  'channels': channels, 'repeats': mesh.get('pbr_repeats', {}),
                  'normal_scale': mesh.get('normal_scale', 1), 'ao_strength': mesh.get('ao_strength', 1),
                  'tint': mesh.get('albedo_tint', False)}
        key = json.dumps(record, sort_keys=True, separators=(',', ':'))
        if key not in material_indices:
            material_indices[key] = len(materials)
            record['id'] = identifier(source['material']) + '__' + str(len(materials))
            # COLLADA's diffuse slot cannot multiply a texture by a color.
            # Bake only that tint in linear space; USD/GLB retain scalar tint.
            if 'texture' in channels and record['tint']:
                pixels = rgb_pixels(mesh['texture'])
                tinted = bytearray()
                for i, value in enumerate(pixels):
                    v = value / 255
                    linear = v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4
                    linear *= mesh['color'][i % 3]
                    v = 12.92 * linear if linear <= .0031308 else 1.055 * linear ** (1 / 2.4) - .055
                    tinted.append(max(0, min(255, int(v * 255 + .5))))
                record['dae_albedo'] = image(decode_material_texture(png_spec(tinted, mesh['texture']['width'])))
            else:
                record['dae_albedo'] = channels.get('texture')
            materials.append(record)
        selected.append(material_indices[key])
    write_usda(root / (stem + '.usda'), stem, records, materials, selected)
    write_dae(root / (stem + '.dae'), stem, records, materials, selected)
    if len(images) > 256 or sum(map(len, images.values())) > 16 * 1024 * 1024:
        raise ValueError('Physical export images exceed their derived-file budget')
    for name, raw in images.items():
        path = root / name
        path.parent.mkdir(exist_ok=True)
        if path.is_symlink() or path.parent.is_symlink():
            raise ValueError('Export texture paths must not be symbolic links')
        path.write_bytes(raw)
    manifest = {'schema': 1, 'textures': {name: hashlib.sha256(raw).hexdigest() for name, raw in sorted(images.items())},
                'source_meshes': len(records), 'source_materials': sorted(data['materials']),
                'limitations': 'COLLADA: diffuse texture, vertex normals and UV are portable; tangent normals and PBR scalar maps use documented extensions.'}
    (root / (stem + '.exports.json')).write_text(json.dumps(manifest, sort_keys=True, separators=(',', ':')) + '\n')


def write_usda(path, stem, records, materials, selected):
    root = identifier(stem.title())
    with path.open('w', encoding='utf-8') as file:
        def line(value): file.write(value + '\n')
        line('#usda 1.0\n(defaultPrim="' + root + '"\nmetersPerUnit=1\nupAxis="Y")\ndef Xform "' + root + '" {\ndef Scope "Materials" {')
        for material in materials:
            name, profile, maps = material['id'], material['profile'], material['channels']
            prefix = '/' + root + '/Materials/' + name
            color = material['color']
            line('def Material "' + name + '" {')
            line('custom string sourceMaterial=' + json.dumps(material['source']))
            line('token outputs:surface.connect=<' + prefix + '/Surface.outputs:surface>')
            line('def Shader "Surface" {\nuniform token info:id="UsdPreviewSurface"\nint inputs:useSpecularWorkflow=0')
            for channel, property, type_, output, fallback in (
                ('texture', 'diffuseColor', 'color3f', 'rgb', vector(color[:3])),
                ('normal_texture', 'normal', 'normal3f', 'rgb', '(0,0,1)'),
                ('roughness_texture', 'roughness', 'float', 'g', number(profile['roughness'])),
                ('metalness_texture', 'metallic', 'float', 'b', number(profile['metalness'])),
                ('ao_texture', 'occlusion', 'float', 'r', '1')):
                line(type_ + ' inputs:' + property + ('.connect=<' + prefix + '/' + channel + '.outputs:' + output + '>' if channel in maps else '=' + fallback))
            line('float inputs:opacity=' + number(color[3]) + '\ntoken outputs:surface\n}')
            if maps:
                line('def Shader "UV" {\nuniform token info:id="UsdPrimvarReader_float2"\nstring inputs:varname="st"\nfloat2 outputs:result\n}')
            for channel, image in maps.items():
                repeat = material['repeats'].get(channel, 1)
                uv = prefix + '/UV.outputs:result'
                if repeat != 1:
                    line('def Shader "' + channel + '_UV" {\nuniform token info:id="UsdTransform2d"\nfloat2 inputs:in.connect=<' + uv + '>\nfloat2 inputs:scale=' + vector([repeat, repeat]) + '\nfloat2 outputs:result\n}')
                    uv = prefix + '/' + channel + '_UV.outputs:result'
                scale, bias = [1, 1, 1, 1], [0, 0, 0, 0]
                if channel == 'texture' and material['tint']: scale[:3] = color[:3]
                elif channel == 'normal_texture':
                    strength = material['normal_scale'];scale = [2 * strength, 2 * strength, 2, 1];bias = [-strength, -strength, -1, 0]
                elif channel == 'roughness_texture': scale[1] = profile['roughness']
                elif channel == 'metalness_texture': scale[2] = profile['metalness']
                elif channel == 'ao_texture': scale[0] = material['ao_strength'];bias[0] = 1 - material['ao_strength']
                line('def Shader "' + channel + '" {\nuniform token info:id="UsdUVTexture"\nasset inputs:file=@' + image + '@\nfloat2 inputs:st.connect=<' + uv + '>')
                line('token inputs:sourceColorSpace="' + ('sRGB' if channel == 'texture' else 'raw') + '"\ntoken inputs:wrapS="repeat"\ntoken inputs:wrapT="repeat"')
                line('float4 inputs:scale=' + vector(scale) + '\nfloat4 inputs:bias=' + vector(bias) + '\nfloat3 outputs:rgb\nfloat outputs:r\nfloat outputs:g\nfloat outputs:b\n}')
            line('}')
        line('}')
        for ordinal, ((source, mesh), material_index) in enumerate(zip(records, selected)):
            name = identifier(source['name']) + '__' + str(ordinal)
            line('def Mesh "' + name + '" (prepend apiSchemas=["MaterialBindingAPI"]) {\ncustom string sourceMesh=' + json.dumps(source['name']))
            line('point3f[] points=[' + ','.join(map(vector, mesh['vertices'])) + ']')
            line('int[] faceVertexCounts=[' + ','.join(['3'] * (len(mesh['indices']) // 3)) + ']')
            line('int[] faceVertexIndices=[' + ','.join(map(str, mesh['indices'])) + ']')
            line('normal3f[] normals=[' + ','.join(map(vector, mesh['normals'])) + '] (interpolation="vertex")')
            if 'uv' in mesh:
                line('texCoord2f[] primvars:st=[' + ','.join(map(vector, mesh['uv'])) + '] (interpolation="vertex")')
            line('uniform token subdivisionScheme="none"\nuniform bool doubleSided=true\nrel material:binding=</' + root + '/Materials/' + materials[material_index]['id'] + '>\n}')
        line('}')


def write_dae(path, stem, records, materials, selected):
    with path.open('w', encoding='utf-8') as file:
        def line(value): file.write(value + '\n')
        line('<?xml version="1.0" encoding="utf-8"?>\n<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1"><asset><contributor><authoring_tool>Home Studio physical export</authoring_tool></contributor><created>2026-10-24T00:00:00Z</created><modified>2026-10-24T00:00:00Z</modified><unit name="meter" meter="1"/><up_axis>Z_UP</up_axis></asset>')
        images = sorted({m['dae_albedo'] for m in materials if m['dae_albedo']} | {m['channels']['normal_texture'] for m in materials if 'normal_texture' in m['channels']})
        image_ids = {name: 'image_' + str(i) for i, name in enumerate(images)}
        line('<library_images>')
        for name, id_ in image_ids.items(): line('<image id="' + id_ + '"><init_from>' + escape(name) + '</init_from></image>')
        line('</library_images><library_effects>')
        for m in materials:
            line('<effect id="' + m['id'] + '_fx"><profile_COMMON>')
            for channel, image in [('albedo', m['dae_albedo']), ('normal', m['channels'].get('normal_texture'))]:
                if image:
                    line('<newparam sid="' + channel + '_surface"><surface type="2D"><init_from>' + image_ids[image] + '</init_from></surface></newparam><newparam sid="' + channel + '_sampler"><sampler2D><source>' + channel + '_surface</source><wrap_s>WRAP</wrap_s><wrap_t>WRAP</wrap_t></sampler2D></newparam>')
            diffuse = '<texture texture="albedo_sampler" texcoord="UV0"/>' if m['dae_albedo'] else '<color>' + ' '.join(map(number, m['color'])) + '</color>'
            line('<technique sid="common"><lambert><diffuse>' + diffuse + '</diffuse><transparent opaque="A_ONE"><color>1 1 1 ' + number(m['color'][3]) + '</color></transparent></lambert></technique>')
            if 'normal_texture' in m['channels']:
                line('<extra><technique profile="FCOLLADA"><bump bumptype="NORMALMAP"><texture texture="normal_sampler" texcoord="UV1"/></bump></technique></extra>')
            line('</profile_COMMON><extra><technique profile="HOME_STUDIO_PBR"><source_material>' + escape(m['source']) + '</source_material><base_color>' + ' '.join(map(number, m['color'])) + '</base_color><roughness>' + number(m['profile']['roughness']) + '</roughness><metalness>' + number(m['profile']['metalness']) + '</metalness>')
            for channel, image in m['channels'].items(): line('<' + channel + ' repeat="' + number(m['repeats'].get(channel, 1)) + '">' + escape(image) + '</' + channel + '>')
            line('</technique></extra></effect>')
        line('</library_effects><library_materials>')
        for m in materials: line('<material id="' + m['id'] + '" name=' + quoteattr(m['source']) + '><instance_effect url="#' + m['id'] + '_fx"/></material>')
        line('</library_materials><library_geometries>')
        for ordinal, ((source, mesh), mi) in enumerate(zip(records, selected)):
            id_ = 'geometry_' + str(ordinal);m = materials[mi]
            line('<geometry id="' + id_ + '" name=' + quoteattr(source['name']) + '><mesh>')
            arrays = [('position', [(x, -z, y) for x, y, z in mesh['vertices']], 'XYZ'), ('normal', [(x, -z, y) for x, y, z in mesh['normals']], 'XYZ')]
            if 'uv' in mesh:
                for key, channel in [('uv0', 'texture'), ('uv1', 'normal_texture')]:
                    if key == 'uv0' or channel in m['channels']:
                        scale = m['repeats'].get(channel, 1)
                        arrays.append((key, [[u * scale, v * scale] for u, v in mesh['uv']], 'ST'))
            for name, values, axes in arrays:
                line('<source id="' + id_ + '_' + name + '"><float_array id="' + id_ + '_' + name + '_array" count="' + str(len(values) * len(axes)) + '">' + ' '.join(number(v) for row in values for v in row) + '</float_array><technique_common><accessor source="#' + id_ + '_' + name + '_array" count="' + str(len(values)) + '" stride="' + str(len(axes)) + '">' + ''.join('<param name="' + axis + '" type="float"/>' for axis in axes) + '</accessor></technique_common></source>')
            line('<vertices id="' + id_ + '_vertices"><input semantic="POSITION" source="#' + id_ + '_position"/></vertices><triangles material="material" count="' + str(len(mesh['indices']) // 3) + '">')
            for name, _, _ in arrays:
                semantic = 'VERTEX' if name == 'position' else 'NORMAL' if name == 'normal' else 'TEXCOORD'
                suffix = 'vertices' if name == 'position' else name
                line('<input semantic="' + semantic + '" source="#' + id_ + '_' + suffix + '" offset="0"' + (' set="' + name[-1] + '"' if name.startswith('uv') else '') + '/>')
            # All attribute arrays share this source's vertex index. COLLADA
            # permits equal offsets, avoiding repeated copies of every index.
            line('<p>' + ' '.join(map(str, mesh['indices'])) + '</p></triangles></mesh></geometry>')
        line('</library_geometries><library_visual_scenes><visual_scene id="Scene">')
        for i, ((source, mesh), mi) in enumerate(zip(records, selected)):
            line('<node id="node_' + str(i) + '" name=' + quoteattr(source['name']) + '><instance_geometry url="#geometry_' + str(i) + '"><bind_material><technique_common><instance_material symbol="material" target="#' + materials[mi]['id'] + '"><bind_vertex_input semantic="UV0" input_semantic="TEXCOORD" input_set="0"/><bind_vertex_input semantic="UV1" input_semantic="TEXCOORD" input_set="1"/></instance_material></technique_common></bind_material></instance_geometry></node>')
        line('</visual_scene></library_visual_scenes><scene><instance_visual_scene url="#Scene"/></scene></COLLADA>')
