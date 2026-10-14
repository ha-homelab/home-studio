#!/usr/bin/env python3
"""Generate the offline browser catalog from its canonical JSON source."""
import argparse
import json
import math
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
IDENTIFIER = re.compile(r'[a-z][a-z0-9_]{0,63}')
COLOR = re.compile(r'#[0-9a-fA-F]{6}')
ITEM_TYPES = {'furniture', 'lamp', 'chandelier', 'tv', 'appliance', 'switch', 'outlet', 'sensor'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def finite_number(value, low, high):
    return type(value) in (int, float) and math.isfinite(value) and low <= value <= high


def text(value, maximum=100):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= maximum


def validate_catalog(catalog):
    require(isinstance(catalog, dict), 'catalog must be an object')
    require(type(catalog.get('version')) is int and catalog['version'] == 1, 'unsupported catalog version')
    collections = {}
    for key in ('categories', 'styles', 'models'):
        entries = catalog.get(key)
        require(isinstance(entries, list) and bool(entries), key + ' must be a nonempty array')
        indexed = {}
        for entry in entries:
            require(isinstance(entry, dict), key + ' entries must be objects')
            identifier = entry.get('id')
            require(isinstance(identifier, str) and IDENTIFIER.fullmatch(identifier)
                    and identifier not in ('constructor', 'prototype'), key + ' entry has an invalid id')
            require(identifier not in indexed, key + ' contains duplicate id ' + identifier)
            require(text(entry.get('label')), identifier + ': label must contain 1–100 characters')
            indexed[identifier] = entry
        collections[key] = indexed
    categories, styles = collections['categories'], collections['styles']
    for style in styles.values():
        materials = style.get('materials')
        require(isinstance(materials, dict) and bool(materials), style['id'] + ': missing material palette')
        for name, color in materials.items():
            require(isinstance(name, str) and IDENTIFIER.fullmatch(name), style['id'] + ': invalid material name')
            require(isinstance(color, str) and COLOR.fullmatch(color), style['id'] + ': invalid material color')
    # Reuse the compiler geometry so rotated bounds reflect the rendered mesh.
    from planner.furniture import primitive
    for model in catalog['models']:
        identifier = model['id']
        require(isinstance(model.get('category'), str) and model['category'] in categories, identifier + ': unknown category')
        require(isinstance(model.get('default_style'), str) and model['default_style'] in styles, identifier + ': unknown default style')
        require(isinstance(model.get('type'), str) and model['type'] in ITEM_TYPES, identifier + ': unknown item type')
        dimensions = model.get('dimensions_m')
        require(isinstance(dimensions, dict) and set(dimensions) == {'width', 'height', 'depth'}, identifier + ': invalid dimensions')
        require(all(finite_number(value, .001, 100) for value in dimensions.values()), identifier + ': invalid dimension size')
        require(finite_number(model.get('elevation_m'), 0, 20), identifier + ': invalid elevation')
        if 'tags' in model:
            require(isinstance(model['tags'], list) and all(text(tag) for tag in model['tags']), identifier + ': invalid tags')
        require(isinstance(model.get('parts'), list) and 1 <= len(model['parts']) <= 32, identifier + ': requires 1–32 parts')
        for index, part in enumerate(model['parts']):
            prefix = f'{identifier} part {index}'
            try:
                mesh = primitive(part)
            except (ValueError, OverflowError) as error:
                raise ValueError(prefix + ': ' + str(error)) from error
            for vertex in mesh['vertices']:
                for axis, value in enumerate(vertex):
                    low, high = (0, 1) if axis == 1 else (-.5, .5)
                    require(finite_number(value, low - 1e-8, high + 1e-8), prefix + ': geometry exceeds normalized bounds')
            material = part.get('material')
            require(isinstance(material, str), prefix + ': invalid material')
            for style in styles.values():
                color = style['materials'].get(material, material)
                require(isinstance(color, str) and COLOR.fullmatch(color), prefix + ': unknown material ' + material)
                if 'pattern_face' in part:
                    require('accent' in style['materials'], style['id'] + ': patterned furniture requires an accent color')
        require(sum('pattern_face' in part for part in model['parts']) <= 3,
                identifier + ': at most 3 patterned faces are allowed')


def generated_catalog():
    catalog = json.loads((ROOT / 'planner/catalog.json').read_text())
    validate_catalog(catalog)
    return '// Generated by scripts/generate-furniture-catalog.py; edit catalog.json.\nexport const CATALOG = ' + json.dumps(catalog, ensure_ascii=False, separators=(',', ':')) + ';\n'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    destination = ROOT / 'planner/catalog.js'
    content = generated_catalog()
    if args.check:
        if not destination.exists() or destination.read_text() != content:
            raise SystemExit('Browser furniture catalog is stale; run scripts/generate-furniture-catalog.py')
        print('Furniture catalog is valid and browser copy is current.')
    else:
        destination.write_text(content)
