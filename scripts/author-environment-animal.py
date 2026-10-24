#!/usr/bin/env python3
"""Embed the public rabbit as losslessly packed GPU-ready geometry.

Run after author-furniture-profiles.py and generate-furniture-catalog.py.
The existing catalog engine owns anatomy; this adapter owns only transport,
neutral vertex colors, metre UVs and the scenery's unchanged actor envelope.
"""
import argparse
import base64
from collections import defaultdict, deque
import hashlib
import json
from pathlib import Path
import struct
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from planner.furniture import MODELS, build_furniture_asset

START = '// BEGIN GENERATED ENVIRONMENT RABBIT\n'
END = '// END GENERATED ENVIRONMENT RABBIT\n'


def pack(raw):
    """LZSS: flag byte then eight literals or 12-bit offset/4-bit length pairs."""
    history = defaultdict(deque)
    output = bytearray()
    position = 0
    while position < len(raw):
        flag_at = len(output)
        output.append(0)
        flags = 0
        for bit in range(8):
            if position >= len(raw):
                break
            candidates = history[raw[position:position + 3]]
            while candidates and position - candidates[0] > 4095:
                candidates.popleft()
            best_length, best_offset = 0, 0
            for previous in reversed(candidates):
                length = 3
                while length < 18 and position + length < len(raw) and raw[previous + length] == raw[position + length]:
                    length += 1
                if length > best_length:
                    best_length, best_offset = length, position - previous
                    if length == 18:
                        break
            if best_length >= 3:
                flags |= 1 << bit
                output.extend(struct.pack('<H', best_offset << 4 | best_length - 3))
                advance = best_length
            else:
                output.append(raw[position])
                advance = 1
            for here in range(position, position + advance):
                if here + 3 <= len(raw):
                    queue = history[raw[here:here + 3]]
                    queue.append(here)
                    if len(queue) > 256:
                        queue.popleft()
            position += advance
        output[flag_at] = flags
    return bytes(output)


def unpack(data, length):
    output = bytearray()
    cursor = 0
    while len(output) < length:
        flags = data[cursor]
        cursor += 1
        for bit in range(8):
            if len(output) >= length:
                break
            if flags & (1 << bit):
                token = struct.unpack_from('<H', data, cursor)[0]
                cursor += 2
                offset, count = token >> 4, (token & 15) + 3
                for _ in range(count):
                    output.append(output[-offset])
            else:
                output.append(data[cursor])
                cursor += 1
    assert len(output) == length and cursor == len(data)
    return bytes(output)


def generate():
    dimensions = {'width': .505, 'height': .58, 'depth': .22}
    asset = build_furniture_asset({'model_id': 'garden_rabbit',
                                  'type': MODELS['garden_rabbit']['type'],
                                  'dimensions_m': dimensions})
    arrays = {key: [] for key in ('vertices', 'normals', 'uv', 'colors', 'indices')}
    for mesh in asset['meshes']:
        offset = len(arrays['vertices'])
        for key in ('vertices', 'normals', 'uv'):
            arrays[key].extend(mesh[key])
        arrays['indices'].extend(index + offset for index in mesh['indices'])
        color = [1, 1, 1] if mesh['surface_finish'] == 'fur' else [.018, .022, .025]
        arrays['colors'].extend([color] * len(mesh['vertices']))
        for start in range(0, len(mesh['indices']), 3):
            ids = mesh['indices'][start:start + 3]
            a, b, c = [mesh['vertices'][i] for i in ids]
            u, v = [[p[k] - a[k] for k in range(3)] for p in (b, c)]
            normal = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]]
            if any(sum(normal[k]*mesh['normals'][i][k] for k in range(3)) < -1e-12 for i in ids):
                raise ValueError('Catalog rabbit has reversed corner normals')
    count = len(arrays['vertices'])
    if count >= 65536:
        raise ValueError('Scenery geometry exceeds the compact index envelope')
    values = [v for key in ('vertices', 'normals', 'uv', 'colors') for row in arrays[key] for v in row]
    raw = struct.pack('<' + 'f' * len(values), *values) + struct.pack('<' + 'H' * len(arrays['indices']), *arrays['indices'])
    compressed = pack(raw)
    if unpack(compressed, len(raw)) != raw:
        raise ValueError('Lossless scenery transport roundtrip failed')
    hashes = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
              for name in ('planner/anatomy.json', 'planner/catalog.json', 'planner/furniture.py')}
    record = {'vertices': count, 'indices': len(arrays['indices']), 'bytes': len(raw),
              'data': base64.b64encode(compressed).decode('ascii')}
    block = START + '// Source hashes: ' + json.dumps(hashes, sort_keys=True) + '\n'
    block += '// Exact Float32 positions/normals/UV/colors and Uint16 indices; LZSS transport only.\n'
    block += 'const ENVIRONMENT_RABBIT = ' + json.dumps(record, separators=(',', ':')) + ';\n' + END
    return block, {'vertices': count, 'triangles': len(arrays['indices']) // 3,
                   'raw_bytes': len(raw), 'packed_bytes': len(compressed),
                   'gpu_bytes_sha256': hashlib.sha256(raw).hexdigest(), 'source_sha256': hashes}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    path = ROOT / 'planner/environment.js'
    source = path.read_text()
    block, report = generate()
    start, end = source.index(START), source.index(END) + len(END)
    result = source[:start] + block + source[end:]
    if args.check:
        if result != source:
            raise SystemExit('Environment rabbit transport is stale; regenerate it')
    else:
        path.write_text(result)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
