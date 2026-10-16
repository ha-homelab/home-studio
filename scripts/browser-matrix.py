#!/usr/bin/env python3
"""Expand the reviewed browser inventory into required GitHub Actions rows."""
import argparse
import json
import re
from pathlib import Path

MANIFEST = Path(__file__).with_suffix('.json')
ENGINES = {'chromium', 'firefox', 'webkit'}


def load_manifest(path=MANIFEST):
    manifest = json.loads(path.read_text(encoding='utf-8'))
    if manifest['schema'] != 1:
        raise ValueError('Unsupported browser matrix schema')
    current = manifest['current_playwright']
    if current not in manifest['playwright'] or len(manifest['playwright']) < 3:
        raise ValueError('The current and two historical Playwright snapshots are required')
    for version, toolchain in manifest['playwright'].items():
        if not re.fullmatch(r'\d+\.\d+\.\d+', version):
            raise ValueError('Playwright versions must be exact')
        if set(toolchain['browsers']) != ENGINES:
            raise ValueError('Every snapshot must cover all three browser engines')
        for package in toolchain['packages'].values():
            if not re.fullmatch(r'sha512-[A-Za-z0-9+/]{86}==', package['integrity']):
                raise ValueError('Every npm package requires SHA-512 integrity')
        for browser in toolchain['browsers'].values():
            if not browser['revision'].isdigit() or not re.fullmatch(r'\d+(\.\d+)+', browser['version']):
                raise ValueError('Browser version and revision must be pinned')
    return manifest


def expand(manifest):
    browser, native = [], []
    current = manifest['current_playwright']
    oldest_firefox = min(int(toolchain['browsers']['firefox']['version'].split('.')[0])
                         for toolchain in manifest['playwright'].values())

    def priority(row):
        if row['os'].startswith('macos-') and (
                row.get('product') == 'waterfox' or row.get('version', '').endswith('esr') or
                (row.get('engine') == 'firefox' and int(row['major']) == oldest_firefox)):
            return 0
        if row['os'].startswith('windows-') and row.get('engine') == 'webkit':
            return 1
        if row.get('profile', 'desktop') != 'desktop':
            return 2
        return 3

    for os in manifest['platforms']:
        for playwright, toolchain in manifest['playwright'].items():
            for engine, metadata in toolchain['browsers'].items():
                browser.append(dict(os=os, engine=engine, playwright=playwright,
                                    profile='desktop', channel='', cft='',
                                    major=metadata['version'].split('.')[0], browser_version=metadata['version'],
                                    id=f'{engine}-{metadata["version"]}-pw{playwright}-desktop'))
        for channel in manifest['channels']:
            browser.append(dict(os=os, engine='chromium', playwright=current,
                                profile='desktop', channel=channel, cft='', major='', browser_version='',
                                id=f'{channel}-desktop'))
        for engine in manifest['touch_engines']:
            metadata = manifest['playwright'][current]['browsers'][engine]
            for profile in manifest['touch_profiles']:
                browser.append(dict(os=os, engine=engine, playwright=current,
                                    profile=profile, channel='', cft='',
                                    major=metadata['version'].split('.')[0], browser_version=metadata['version'],
                                    id=f'{engine}-{metadata["version"]}-pw{current}-{profile}'))
        for version in manifest['chrome_for_testing']['versions']:
            browser.append(dict(os=os, engine='chromium', playwright=current,
                                profile='desktop', channel='', cft=version,
                                major=version.split('.')[0], browser_version=version, id=f'chrome-for-testing-{version}-desktop'))
        for product, versions in manifest['native'].items():
            for version in versions:
                native.append(dict(os=os, product=product, version=version,
                                   id=f'{product}-{version}'))
    for rows in (browser, native):
        identities = {(row['os'], row['id']) for row in rows}
        if len(identities) != len(rows) or not 1 <= len(rows) <= 256:
            raise ValueError('Matrix must have unique rows within the GitHub job limit')
        # Reach every native OS early instead of spending the first batch on Linux.
        targets = {}
        for row in rows:
            targets.setdefault(row['id'], []).append(row)
        rows[:] = [row for target in targets.values() for row in target]
        # Diagnose known legacy-Gecko, Windows WebKit, and touch risks early.
        # Stable sorting preserves OS rotation within every priority group.
        rows.sort(key=priority)
    return {'browser': {'include': browser}, 'native': {'include': native}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--github-output', type=Path)
    args = parser.parse_args()
    matrices = expand(load_manifest())
    if args.github_output:
        with args.github_output.open('a', encoding='utf-8') as output:
            for name, matrix in matrices.items():
                output.write(f'{name}={json.dumps(matrix, separators=(",", ":"))}\n')
    print(json.dumps(matrices, indent=2))
