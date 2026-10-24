"""Portable, deterministic physical microdetail; never derives height from color.

Family UVs are metres. Explicit texture channels retain authored UVs. These
small authored periodic heightfields add surface response, not object geometry.
"""
import base64
import functools
import math
import json
from pathlib import Path
import struct
import zlib

# period metres, relief metres, x/y frequency, roughness modulation.
DETAIL_PROFILES = {
    'feather': [.08, .00005, 2, 28, .16],
    'fur': [.04, .00008, 2, 20, .12],
    'fabric': [.025, .00009, 8, 8, .18], 'leather': [.04, .00016, 3, 4, .2],
    'wood': [.16, .00012, 2, 18, .14], 'rough_wood': [.16, .0003, 2, 18, .2],
    'stone': [.18, .00045, 4, 3, .2], 'polished_stone': [.18, .000025, 4, 3, .08],
    'painted': [.04, .000015, 7, 8, .06], 'matte_paint': [.04, .000025, 7, 8, .09],
    'plastic': [.04, .000008, 7, 8, .04], 'rubber': [.04, .000035, 7, 8, .08],
    'brushed_metal': [.08, .00002, 2, 24, .18], 'metal': [.08, .000008, 2, 24, .08],
    'matte_metal': [.08, .000012, 7, 8, .08], 'paper': [.04, .000015, 7, 8, .08],
    'soil': [.18, .0007, 4, 3, .15], 'foliage': [.08, .00003, 2, 12, .1],
}
TEXTURE_CHANNELS = ('albedo_texture', 'normal_texture', 'roughness_texture', 'metalness_texture', 'ao_texture')
PBR_FIELDS = ('material_family', 'normal_scale', 'ao_strength', 'albedo_tint', 'material_uv_scale')


@functools.lru_cache(maxsize=1)
def color_data():
    # One canonical public data module is shared by Python and browser builds.
    source = Path(__file__).with_name('pbr-color-data.js').read_text()
    return json.loads(source.split('export const PBR_COLOR_DATA = Object.freeze(', 1)[1].rsplit(');', 1)[0])


def color_profile(family):
    return color_data().get('wood' if family == 'rough_wood' else family)


def color_luminance(color):
    """Decode exact integer luminance samples, without color or detail loss."""
    packed = base64.b64decode(color['luma_rice'])
    bit = previous = 0
    def read():
        nonlocal bit
        value = (packed[bit >> 3] >> (bit & 7)) & 1
        bit += 1
        return value
    luma = []
    for _ in range(color['size'] ** 2):
        quotient = 0
        while read():
            quotient += 1
        value = quotient << color['rice_k']
        for shift in range(color['rice_k']):
            value |= read() << shift
        previous += -(value + 1) // 2 if value & 1 else value // 2
        luma.append(previous)
    return luma


def validate_pbr_fields(mesh, families):
    if 'material_family' in mesh and mesh['material_family'] not in families:
        raise ValueError('Invalid material family')
    for name, high in (('normal_scale', 2), ('ao_strength', 1)):
        if name in mesh and (type(mesh[name]) not in (int, float) or not math.isfinite(mesh[name]) or not 0 <= mesh[name] <= high):
            raise ValueError('Invalid ' + name)
    if 'material_uv_scale' in mesh and (type(mesh['material_uv_scale']) not in (int,float) or not math.isfinite(mesh['material_uv_scale']) or not 0 < mesh['material_uv_scale'] <= 4096):
        raise ValueError('Invalid material UV scale')
    if 'albedo_tint' in mesh and type(mesh['albedo_tint']) is not bool:
        raise ValueError('Invalid albedo tint')


def detail_pixels(family, size=128):
    profile = DETAIL_PROFILES.get(family)
    if profile is None:
        return None
    period, relief, fx, fy, variance = profile
    normal, roughness = bytearray(), bytearray()
    tau = math.tau
    byte = lambda x: max(0, min(255, math.floor(x + .5)))
    for row in range(size):
        # PNG rows run top to bottom; native texture coordinates run upward.
        y = 1 - (row + .5) / size
        for col in range(size):
            x = (col + .5) / size
            a, b, c, d = tau*fx*x, tau*fy*y, tau*(3*x+2*y), tau*(7*x-5*y)
            height = .6*math.sin(a)*math.sin(b) + .25*math.sin(c) + .15*math.sin(d)
            dx = relief/period*tau*(.6*fx*math.cos(a)*math.sin(b)+.75*math.cos(c)+1.05*math.cos(d))
            dy = relief/period*tau*(.6*fy*math.sin(a)*math.cos(b)+.5*math.cos(c)-.75*math.cos(d))
            length = math.sqrt(dx*dx+dy*dy+1)
            normal.extend(byte((v/length*.5+.5)*255) for v in (-dx,-dy,1))
            value = byte(255*(1-variance*(height*.5+.5)))
            roughness.extend((255, value, 255))
    result = (bytes(normal), bytes(roughness))
    color = color_profile(family)
    if color:
        luma = color_luminance(color)
        ordered = sorted(luma)
        low, high = ordered[len(ordered)//50], ordered[len(ordered)*49//50]
        neutral = []
        for value in luma:
            linear = max(1-color['contrast'], min(1, 1-color['contrast']+(value-low)/max(1,high-low)*color['contrast']))
            neutral.extend([byte(255*(1.055*linear**(1/2.4)-.055))]*3)
        result += (bytes(neutral),)
    return result


def png_spec(pixels, size=128):
    def chunk(kind, body):
        return struct.pack('>I', len(body))+kind+body+struct.pack('>I', zlib.crc32(kind+body))
    rows = b''.join(b'\0'+pixels[y*size*3:(y+1)*size*3] for y in range(size))
    raw = b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR', struct.pack('>IIBBBBB',size,size,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(rows,9))+chunk(b'IEND',b'')
    return {'mime_type':'image/png','width':size,'height':size,'data_uri':'data:image/png;base64,'+base64.b64encode(raw).decode()}


@functools.lru_cache(maxsize=32)
def family_textures(family):
    pixels = detail_pixels(family)
    if pixels is None:
        return {}
    return dict(zip(('normal_texture','roughness_texture','albedo_texture'), (png_spec(p) for p in pixels)))


def export_material_fields(mesh, definitions):
    """Return only portable shading data, retaining per-channel texture scale."""
    result = {key:mesh[key] for key in PBR_FIELDS if key in mesh}
    for key in TEXTURE_CHANNELS:
        if key in mesh:
            result['texture' if key == 'albedo_texture' else key] = definitions[mesh[key]]
    family = mesh.get('material_family')
    repeats = {}
    for key, spec in family_textures(family).items():
        target = 'texture' if key == 'albedo_texture' else key
        if target not in result:
            result[target] = spec
            period = color_profile(family)['period'] if key == 'albedo_texture' else DETAIL_PROFILES[family][0]
            repeats[target] = mesh.get('material_uv_scale',1) / period
            if key == 'albedo_texture': result['albedo_tint'] = True
    if repeats:
        result['pbr_repeats'] = repeats
    return result


def rgb_pixels(spec):
    """Decode the already validated opaque PNG subset, without external libraries."""
    if __package__:
        from .material_textures import decode_material_texture
    else:
        from material_textures import decode_material_texture
    raw = decode_material_texture(spec)
    position, compressed, palette = 8, bytearray(), None
    while position < len(raw):
        length, kind = struct.unpack_from('>I4s', raw, position)
        body = raw[position+8:position+8+length]
        if kind == b'IHDR': color = body[9]
        if kind == b'PLTE': palette = body
        if kind == b'IDAT': compressed.extend(body)
        position += length+12
    width, height = spec['width'], spec['height']
    channels = 3 if color == 2 else 1
    scan = zlib.decompress(compressed)
    previous, result, offset = bytearray(width*channels), bytearray(), 0
    def paeth(a,b,c):
        p=a+b-c; pa,pb,pc=abs(p-a),abs(p-b),abs(p-c)
        return a if pa <= pb and pa <= pc else b if pb <= pc else c
    for _ in range(height):
        mode=scan[offset];offset+=1;row=bytearray(scan[offset:offset+width*channels]);offset+=len(row)
        for i in range(len(row)):
            a=row[i-channels] if i>=channels else 0; b=previous[i]; c=previous[i-channels] if i>=channels else 0
            row[i]=(row[i]+(0,a,b,(a+b)//2,paeth(a,b,c))[mode])&255
        if channels==3: result.extend(row)
        else:
            for index in row:
                if 3*index+3>len(palette): raise ValueError('PNG palette index out of range')
                result.extend(palette[index*3:index*3+3])
        previous=row
    return bytes(result)


@functools.lru_cache(maxsize=128)
def gltf_normal_spec(uri, size):
    spec={'data_uri':uri,'width':size,'height':size,'mime_type':'image/png'}
    pixels=bytearray(rgb_pixels(spec))
    # Export flips V (native lower-left -> glTF upper-left), reversing bitangent.
    for i in range(1,len(pixels),3): pixels[i]=255-pixels[i]
    return png_spec(pixels,size)


def packed_metallic_roughness(roughness, metalness):
    if roughness and metalness and roughness['data_uri']==metalness['data_uri']:
        return roughness
    specs=[s for s in (roughness,metalness) if s]
    if not specs: return None
    size=max(s['width'] for s in specs)
    pixels=[rgb_pixels(s) if s else None for s in (roughness,metalness)]
    result=bytearray()
    for y in range(size):
        for x in range(size):
            values=[]
            for channel,spec,data in zip((1,2),(roughness,metalness),pixels):
                values.append(data[((y*spec['width']//size)*spec['width']+x*spec['width']//size)*3+channel] if spec else 255)
            result.extend((255,*values))
    return png_spec(result,size)
