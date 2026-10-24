"""Physical on-disk exports, explicitly selected by new PBR-capable builders.

USD uses Cartesian texture coordinates and tangent normals (no glTF V flip).
COLLADA preserves albedo, vertex normals and UVs; PBR extensions are advisory.
"""
import functools
import hashlib
import io
import json
import math
import re
import struct
import subprocess
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
    if not math.isfinite(value):
        raise ValueError('Physical export number must be finite')
    packed = struct.pack('<f', value)
    value = struct.unpack('<f', packed)[0]
    if value == 0:
        return '0'
    for precision in range(6, 10):
        result = format(value, '.' + str(precision) + 'g')
        if struct.pack('<f', float(result)) == packed:
            return result
    raise ValueError('Physical export number must be finite')


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
    return _export_records(prepare(data), root, stem, data['title'])


def export_physical_scene(floors, root, stem):
    """Export only supplied scene groups; preserve GLB pivots and bake USD/DAE.

    Accepts the exact grouped representation returned by export_floor. Texture
    descriptors and physical repeats are already resolved by that boundary.
    """
    records = []
    for fi, floor in enumerate(floors):
        for gi, group in enumerate(floor['groups']):
            sx, sy, sz = group['scale'];tx, ty, tz = group['translation']
            if min(sx, sy, sz) <= 0:
                raise ValueError('Physical export requires positive object scale')
            c, s = math.cos(group['rotation']), math.sin(group['rotation'])
            for mi, mesh in enumerate(group['meshes']):
                vertices = [[tx+c*sx*x+s*sz*z, ty+sy*y+floor['elevation'], tz-s*sx*x+c*sz*z]
                            for x, y, z in mesh['vertices']]
                normals = []
                for x, y, z in mesh['normals']:
                    n = [c*x/sx+s*z/sz, y/sy, -s*x/sx+c*z/sz]
                    length = math.hypot(*n) or 1
                    normals.append([v/length for v in n])
                source = {'name': 'f' + str(fi) + '_g' + str(gi) + '_m' + str(mi) + '_' + identifier(group['name']),
                          'kind': 'scene', 'material': mesh.get('material_name', 'material')}
                if type(mesh.get('physical_part')) is int and mesh['physical_part'] >= 0:
                    source['dae_part'] = 'f' + str(fi) + '_part' + str(mesh['physical_part'])
                if 'surface_finish' in mesh:source['surface_finish'] = mesh['surface_finish']
                records.append((source, {**mesh, 'vertices': vertices, 'normals': normals}))
    return _export_records(records, root, stem, stem, scene=floors)


def _export_records(records, root, stem, title, scene=None):
    if __package__:
        from .exporters import export_scene, MAX_EXPORT_BYTES
    else:
        from exporters import export_scene, MAX_EXPORT_BYTES
    root = Path(root)
    if identifier(stem) != stem:
        raise ValueError('Physical export requires a safe model stem')
    grouped = scene is not None
    scene = scene if grouped else [{'name': title, 'elevation': 0, 'groups': [
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
    if not grouped:
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
    if not grouped:
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
                'source_meshes': len(records), 'source_materials': sorted({s['material'] for s, _ in records}),
                'limitations': 'COLLADA: diffuse texture, vertex normals and UV are portable; tangent normals and PBR scalar maps use documented extensions.'}
    (root / (stem + '.exports.json')).write_text(json.dumps(manifest, sort_keys=True, separators=(',', ':')) + '\n')
    return {'manifest': root / (stem + '.exports.json'),
            'paths': [root / (stem + '.' + ext) for ext in ('glb', 'obj', 'mtl', 'dae', 'usda', 'exports.json')]
                     + [root / name for name in sorted(images)]}


def package_physical_usd(root, stem, *, usdcat):
    """Explicit optional OpenUSD conversion; never discover/install a tool."""
    root, usdcat = Path(root), Path(usdcat)
    if identifier(stem) != stem or not usdcat.is_absolute() or not usdcat.is_file():
        raise ValueError('A safe model stem and explicit OpenUSD converter are required')
    manifest_path = root / (stem + '.exports.json')
    if manifest_path.is_symlink() or manifest_path.stat().st_size > 128 * 1024:
        raise ValueError('Invalid physical export manifest')
    manifest = json.loads(manifest_path.read_text())
    textures = manifest.get('textures')
    if manifest.get('schema') != 1 or not isinstance(textures, dict) or len(textures) > 256:
        raise ValueError('Invalid physical export closure')
    files, total = {}, 0
    for name, digest in sorted(textures.items()):
        if not isinstance(digest, str) or not re.fullmatch('[0-9a-f]{64}', digest) or name != stem + '.textures/' + digest + '.png':
            raise ValueError('Invalid physical texture path')
        path = root / name
        if path.is_symlink() or path.parent.is_symlink():raise ValueError('Symbolic export texture path')
        raw = path.read_bytes();total += len(raw)
        if len(raw) > 1024 * 1024 or total > 16 * 1024 * 1024 or hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError('Physical texture closure changed')
        files[name] = raw
    source, binary, archive_path = [root / (stem + '.' + ext) for ext in ('usda', 'usdc', 'usdz')]
    if any(path.is_symlink() for path in (source, binary, archive_path)):
        raise ValueError('Symbolic USD export path')
    subprocess.run([str(usdcat), str(source), '-o', str(binary)], check=True, capture_output=True, timeout=120)
    raw = binary.read_bytes()
    if not raw.startswith(b'PXR-USDC'):raise ValueError('OpenUSD did not produce a binary root layer')
    with zipfile.ZipFile(archive_path, 'w') as archive:
        for name, data in [(binary.name, raw), *files.items()]:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            padding = (-(archive.fp.tell() + 30 + len(name.encode()))) % 64
            if 0 < padding < 4:padding += 64
            if padding:info.extra = struct.pack('<HH', 0x1986, padding - 4) + b'\0' * (padding - 4)
            archive.writestr(info, data)
    return {'manifest': manifest_path, 'paths': [binary, archive_path]}


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
    shared_arrays = {}
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
        groups = {}
        for ordinal, ((source, mesh), mi) in enumerate(zip(records, selected)):
            name = source.get('dae_part', source['name'])
            if 'dae_part' not in source and any(key in mesh for key in CHANNELS):
                name = re.sub(r'_texture_(?:front|back|left|right|top|bottom)$', '', name)
            # Separate unmarked records even if a caller repeats display names.
            key = ('part', name) if name != source['name'] else ('mesh', ordinal)
            groups.setdefault(key, (name, []))[1].append((source, mesh, mi))
        for ordinal, (name, charts) in enumerate(groups.values()):
            id_ = 'g' + format(ordinal, 'x')
            line('<geometry id="' + id_ + '" name=' + quoteattr(name) + '><mesh>')
            pools = {key: {} for key in ('position', 'normal', 'uv0', 'uv1')}
            primitives = []
            for source, mesh, mi in charts:
                m = materials[mi]
                arrays = [('position', [(x, -z, y) for x, y, z in mesh['vertices']]),
                          ('normal', [(x, -z, y) for x, y, z in mesh['normals']])]
                if 'uv' in mesh:
                    for key, channel in [('uv0', 'texture'), ('uv1', 'normal_texture')]:
                        if key == 'uv0' or channel in m['channels']:
                            scale = m['repeats'].get(channel, 1)
                            arrays.append((key, [(u * scale, v * scale) for u, v in mesh['uv']]))
                sequences, inputs = [], []
                for key, rows in arrays:
                    pool, remap = pools[key], []
                    for row in rows:
                        value = tuple(number(v) for v in row)
                        remap.append(pool.setdefault(value, len(pool)))
                    sequence = tuple(remap[i] for i in mesh['indices'])
                    if sequence not in sequences: sequences.append(sequence)
                    inputs.append((key, sequences.index(sequence)))
                indices = ' '.join(str(sequence[i]) for i in range(len(mesh['indices'])) for sequence in sequences)
                primitives.append((source['name'], mi, inputs, len(mesh['indices']) // 3, indices))
            if len(charts) == 1:
                # An already indexed curved mesh may be smaller with one shared
                # corner index than independently pooled attribute indices.
                original = {key: [tuple(number(v) for v in row) for row in rows] for key, rows in arrays}
                original_indices = ' '.join(map(str, mesh['indices']))
                size = lambda values: sum(len(' '.join(v for row in rows for v in row)) for rows in values.values())
                if size(original) + len(original_indices) < size(pools) + len(primitives[0][4]):
                    pools = original
                    primitives = [(source['name'], mi, [(key, 0) for key in original], len(mesh['indices']) // 3, original_indices)]
            local_sources, source_ids = {}, {}
            for key, pool in pools.items():
                if not pool: continue
                axes = 'ST' if key.startswith('uv') else 'XYZ'
                text = ' '.join(v for row in pool for v in row)
                if (text, axes) in local_sources:
                    source_ids[key] = local_sources[(text, axes)]
                    continue
                source_ids[key] = local_sources[(text, axes)] = id_ + '_' + key
                line('<source id="' + id_ + '_' + key + '">')
                if text not in shared_arrays:
                    shared_arrays[text] = 'a' + str(len(shared_arrays))
                    line('<float_array id="' + shared_arrays[text] + '" count="' + str(len(pool) * len(axes)) + '">' + text + '</float_array>')
                line('<technique_common><accessor source="#' + shared_arrays[text] + '" count="' + str(len(pool)) + '" stride="' + str(len(axes)) + '">' + ''.join('<param name="' + axis + '" type="float"/>' for axis in axes) + '</accessor></technique_common></source>')
            line('<vertices id="' + id_ + '_vertices"><input semantic="POSITION" source="#' + id_ + '_position"/></vertices>')
            for chart, mi, inputs, count, indices in primitives:
                line('<triangles material="m' + str(mi) + '" count="' + str(count) + '">')
                for key, offset in inputs:
                    semantic = 'VERTEX' if key == 'position' else 'NORMAL' if key == 'normal' else 'TEXCOORD'
                    source_id = id_ + '_vertices' if key == 'position' else source_ids[key]
                    line('<input semantic="' + semantic + '" source="#' + source_id + '" offset="' + str(offset) + '"' + (' set="' + key[-1] + '"' if key.startswith('uv') else '') + '/>')
                line('<p>' + indices + '</p>')
                if chart != name:
                    line('<extra><technique profile="HOME_STUDIO_PBR"><source_chart>' + escape(chart) + '</source_chart></technique></extra>')
                line('</triangles>')
            line('</mesh></geometry>')
        line('</library_geometries><library_visual_scenes><visual_scene id="Scene">')
        for ordinal, (name, charts) in enumerate(groups.values()):
            id_ = format(ordinal, 'x')
            line('<node id="n' + id_ + '" name=' + quoteattr(name) + '><instance_geometry url="#g' + id_ + '"><bind_material><technique_common>')
            for mi in dict.fromkeys(mi for _, _, mi in charts):
                line('<instance_material symbol="m' + str(mi) + '" target="#' + materials[mi]['id'] + '"><bind_vertex_input semantic="UV0" input_semantic="TEXCOORD" input_set="0"/><bind_vertex_input semantic="UV1" input_semantic="TEXCOORD" input_set="1"/></instance_material>')
            line('</technique_common></bind_material></instance_geometry></node>')
        line('</visual_scene></library_visual_scenes><scene><instance_visual_scene url="#Scene"/></scene></COLLADA>')
