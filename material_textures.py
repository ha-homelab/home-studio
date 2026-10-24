"""Bounded, metadata-free opaque PNG material channels and explicit per-vertex UVs.

No image generation, network, color conversion, or source-image preparation is
performed here. A producer must review and prepare the color swatch offline.
"""
import base64
import binascii
import math
import re
import struct
import zlib

if __package__:
    from .pbr_materials import TEXTURE_CHANNELS, validate_pbr_fields, family_textures
else:
    from pbr_materials import TEXTURE_CHANNELS, validate_pbr_fields, family_textures


# Per-model limits also bound semantic-role decoded CPU/GPU storage.
MAX_MATERIAL_TEXTURES = 128
MAX_MATERIAL_TEXTURE_PIXELS = 12 * 1024 * 1024
MATERIAL_TEXTURE_SIZES = (128, 256, 512, 1024)
MAX_MATERIAL_TEXTURE_BYTES = 8 * 1024 * 1024
MAX_MATERIAL_PNG_BYTES = 1024 * 1024
MAX_MATERIAL_BASE64_CHARS = 4 * ((MAX_MATERIAL_PNG_BYTES + 2) // 3)


# Artistic starting values, not measured material properties.
MATERIAL_SURFACE_PROFILES = {'feather': [.75, 0], 'fur': [.96, 0], 'fabric': [0.92, 0], 'leather': [0.5, 0], 'plastic': [0.48, 0], 'painted': [0.48, 0], 'wood': [0.58, 0], 'ceramic': [0.24, 0], 'glass': [0.12, 0], 'rubber': [0.95, 0], 'stone': [0.88, 0], 'metal': [0.3, 0.75], 'brushed_metal': [0.4, 0.75], 'matte_metal': [0.5, 0.75], 'polished_metal': [0.3, 0.9], 'mirror': [0.06, 0.9], 'matte_paint': [0.85, 0], 'rough_wood': [0.85, 0], 'polished_stone': [0.35, 0], 'paper': [0.85, 0], 'foliage': [0.75, 0], 'soil': [1, 0], 'car_paint': [0.25, 0.15], 'solar_cell': [0.25, 0.25], 'light_diffuser': [0.4, 0]}
MATERIAL_SURFACE_FINISHES = tuple(MATERIAL_SURFACE_PROFILES)


def validate_surface_finish(value):
    if not isinstance(value, str) or value not in MATERIAL_SURFACE_FINISHES:
        raise ValueError("Invalid material surface finish")
    return value


# Ordered finish rules are mirrored in createSceneMaterial. The parity test
# compares the complete serialized table, not only representative outcomes.
MATERIAL_FINISH_RULES = [['(?:^|[_ -])(mirror)(?:$|[_ -])', 0.06, 0.9], ['glass|glazing', 0.12, 0], ['ceramic|porcelain|glaze|enamel', 0.24, 0], ['rubber|foam', 0.95, 0], ['leather', 0.5, 0], ['fabric|upholstery|curtain|linen|cloth|textile|carpet|rug|velvet|felt|canvas|safety_mesh', 0.92, 0], ['paint|powder.?coat|plastic|vinyl|acrylic', 0.48, 0], ['^(?=.*(?:steel|alumin|chrome|brass|copper|bronze|metal|iron))(?=.*(?:matte|satin))(?=.*(?:chrome|polished))', 0.5, 0.9], ['^(?=.*(?:steel|alumin|chrome|brass|copper|bronze|metal|iron))(?=.*(?:matte|satin))', 0.5, 0.75], ['^(?=.*(?:steel|alumin|chrome|brass|copper|bronze|metal|iron))(?=.*(?:brushed))(?=.*(?:chrome|polished))', 0.4, 0.9], ['^(?=.*(?:steel|alumin|chrome|brass|copper|bronze|metal|iron))(?=.*(?:brushed))', 0.4, 0.75], ['^(?=.*(?:steel|alumin|chrome|brass|copper|bronze|metal|iron))(?=.*(?:chrome|polished))', 0.3, 0.9], ['^(?=.*(?:steel|alumin|chrome|brass|copper|bronze|metal|iron))', 0.3, 0.75], ['wood|walnut|oak|maple|pine|espresso|veneer|bamboo', 0.58, 0], ['stone|concrete|plaster|brick|soil|earth', 0.88, 0]]


def material_surface_profile(name=None, surface_finish=None):
    """Conservative PBR response from a finish name, never from RGB or object type."""
    if surface_finish is not None:
        roughness, metalness = MATERIAL_SURFACE_PROFILES[validate_surface_finish(surface_finish)]
        return {'roughness': roughness, 'metalness': metalness}
    name = str(name or '').lower()
    for pattern, roughness, metalness in MATERIAL_FINISH_RULES:
        if re.search(pattern, name):
            return {'roughness': roughness, 'metalness': metalness}
    return {'roughness': .7, 'metalness': 0}


def decode_material_texture(spec):
    if (not isinstance(spec, dict) or set(spec) != {'mime_type', 'width', 'height', 'data_uri'}
            or spec['mime_type'] != 'image/png' or type(spec['width']) is not int
            or spec['width'] not in MATERIAL_TEXTURE_SIZES or spec['height'] != spec['width']):
        raise ValueError('Material textures must be square 128–1024 pixel PNG swatches')
    uri = spec['data_uri']
    prefix = 'data:image/png;base64,'
    if not isinstance(uri, str) or not uri.startswith(prefix) or len(uri) > len(prefix) + MAX_MATERIAL_BASE64_CHARS:
        raise ValueError('Material textures require bounded embedded PNG data')
    try:
        raw = base64.b64decode(uri[len(prefix):], validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError('Invalid material texture encoding') from error
    if len(raw) > MAX_MATERIAL_PNG_BYTES or base64.b64encode(raw).decode() != uri[len(prefix):] or raw[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('Invalid material PNG')
    position, kinds, compressed, palette, channels = 8, [], bytearray(), False, 0
    while position < len(raw):
        if position + 12 > len(raw) or len(kinds) > 100:
            raise ValueError('Invalid material PNG chunks')
        length, kind = struct.unpack_from('>I4s', raw, position)
        end = position + 12 + length
        if end > len(raw) or kind not in (b'IHDR', b'PLTE', b'IDAT', b'IEND'):
            raise ValueError('Only metadata-free opaque PNG swatches are supported')
        payload = raw[position+8:end-4]
        if zlib.crc32(kind + payload) != struct.unpack_from('>I', raw, end-4)[0]:
            raise ValueError('Invalid material PNG checksum')
        if not kinds and kind != b'IHDR':
            raise ValueError('Missing material PNG header')
        if kind == b'IHDR':
            if kinds or length != 13:
                raise ValueError('Invalid material PNG header')
            width, height, bits, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', payload)
            if (width, height, bits, compression, filtering, interlace) != (spec['width'], spec['height'], 8, 0, 0, 0) or color not in (2, 3):
                raise ValueError('Material PNG must be opaque RGB or indexed 8-bit color')
            channels = 3 if color == 2 else 1
        elif kind == b'PLTE':
            if palette or b'IDAT' in kinds or not 0 < length <= 768 or length % 3:
                raise ValueError('Invalid material palette')
            palette = True
        elif kind == b'IDAT':
            if b'IDAT' in kinds and kinds[-1] != b'IDAT':
                raise ValueError('Invalid material image stream')
            compressed.extend(payload)
        elif length or end != len(raw):
            raise ValueError('Invalid material PNG end')
        kinds.append(kind)
        position = end
    if not kinds or kinds[-1] != b'IEND' or not compressed or channels == 1 and not palette:
        raise ValueError('Incomplete material PNG')
    expected = (width * channels + 1) * height
    try:
        decoder = zlib.decompressobj()
        pixels = decoder.decompress(compressed, expected + 1)
    except zlib.error as error:
        raise ValueError('Invalid material PNG pixels') from error
    if len(pixels) != expected or not decoder.eof or decoder.unused_data or any(pixels[row * (width * channels + 1)] > 4 for row in range(height)):
        raise ValueError('Invalid material PNG pixel dimensions')
    return raw


def material_uv(mesh, dimensions=None):
    uv, axes = mesh.get('uv'), mesh.get('uv_dimensions')
    if not isinstance(uv, list) or len(uv) != len(mesh['vertices']):
        raise ValueError('Material UVs must match every mesh vertex')
    scale = [1, 1]
    if axes is not None:
        if not isinstance(axes, list) or len(axes) != 2 or any(not isinstance(axis, str) or axis not in ('width', 'height', 'depth') for axis in axes) or axes[0] == axes[1]:
            raise ValueError('Invalid material UV dimension axes')
        scale = [(dimensions or {}).get(axis, 1) for axis in axes]
    if any(type(value) not in (int, float) or not math.isfinite(value) or value <= 0 for value in scale):
        raise ValueError('Invalid material UV dimensions')
    result = []
    for pair in uv:
        if not isinstance(pair, list) or len(pair) != 2 or any(type(value) not in (int, float) or not math.isfinite(value) for value in pair):
            raise ValueError('Invalid material UV coordinates')
        row = [value * factor for value, factor in zip(pair, scale)]
        if any(not math.isfinite(value) or abs(value) > 4096 for value in row):
            raise ValueError('Material UV coordinates exceed the repeat limit')
        result.append(row)
    return result


def validate_material_textures(model):
    definitions = model.get('material_textures', {})
    if not isinstance(definitions, dict) or len(definitions) > MAX_MATERIAL_TEXTURES:
        raise ValueError('At most 128 material textures are supported')
    result, decoded, semantic, family_pixels = {}, {}, set(), {}
    for key, spec in definitions.items():
        if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,63}', key):
            raise ValueError('Invalid material texture identifier')
        raw = decode_material_texture(spec)
        result[key] = raw
        decoded[spec['data_uri']] = (raw, spec['width'] * spec['height'])
    declared_uris = set(decoded)
    meshes = list(model.get('meshes', []))
    meshes.extend(mesh for asset in model.get('object_assets', {}).values() for mesh in asset['meshes'])
    for mesh in meshes:
        if 'surface_finish' in mesh:
            validate_surface_finish(mesh['surface_finish'])
        validate_pbr_fields(mesh, MATERIAL_SURFACE_FINISHES)
        channels = [key for key in TEXTURE_CHANNELS if key in mesh]
        if channels or 'material_family' in mesh:
            material_uv(mesh)
        for key in channels:
            if not isinstance(mesh[key], str) or mesh[key] not in result:
                raise ValueError('Material texture requires a known surface map')
            if key == 'albedo_texture' and model['materials'][mesh['material']][3] != 1:
                raise ValueError('Albedo texture requires an opaque surface')
            semantic.add((definitions[mesh[key]]['data_uri'], key == 'albedo_texture'))
        family=mesh.get('material_family');generic=family_textures(family)
        if generic: family_pixels[family]=sum(spec['width']*spec['height'] for spec in generic.values())
        for key, spec in generic.items():
            if key not in mesh:
                uri = spec['data_uri']
                if uri not in decoded:
                    decoded[uri] = (decode_material_texture(spec), spec['width'] * spec['height'])

    # Unused definitions still consume CPU decoding/storage once, not once per alias.
    semantic.update((uri, False) for uri in declared_uris if not any(key[0] == uri for key in semantic))
    if sum(len(raw) for raw, _ in decoded.values()) > MAX_MATERIAL_TEXTURE_BYTES:
        raise ValueError('Material textures exceed the 8 MiB total budget')
    if sum(decoded[uri][1] for uri, _ in semantic) + sum(family_pixels.values()) > MAX_MATERIAL_TEXTURE_PIXELS:
        raise ValueError('Material textures exceed the 12 Mi texel decoded budget')
    return result
