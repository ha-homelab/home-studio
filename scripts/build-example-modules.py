#!/usr/bin/env python3
"""Generate local browser modules from the canonical fictional example JSON."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = {
    'practice': 'practice-home',
    'decor': 'decor-studio',
    'patterns': 'pattern-studio',
    'garage': 'garage-and-studio',
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Fail on generated-file drift without writing')
    args = parser.parse_args()
    mismatches = []
    for name, asset in EXAMPLES.items():
        source = f'planner/guide-assets/{asset}.json'
        data = json.loads((ROOT / source).read_text(encoding='utf-8'))
        expected = (f'// Generated from {source}; checked for exact parity.\n'
                    f'export default {json.dumps(data, ensure_ascii=False, separators=(",", ":"))};\n')
        target = ROOT / f'planner/examples/{name}.js'
        if args.check:
            if not target.is_file() or target.read_text(encoding='utf-8') != expected:
                mismatches.append(target.relative_to(ROOT).as_posix())
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(expected, encoding='utf-8')
    if mismatches:
        parser.exit(1, 'Regenerate example modules: ' + ', '.join(mismatches) + '\n')
    print(f'{len(EXAMPLES)} example modules {"verified" if args.check else "generated"}.')


if __name__ == '__main__':
    main()
