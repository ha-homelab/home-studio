#!/usr/bin/env python3
"""Install a checksum-pinned Playwright toolchain outside the source checkout."""
import argparse
import importlib.util
import json
import os
import shutil
import subprocess
from pathlib import Path

spec = importlib.util.spec_from_file_location('browser_matrix', Path(__file__).with_name('browser-matrix.py'))
matrix = importlib.util.module_from_spec(spec)
spec.loader.exec_module(matrix)


def lockfile(version, toolchain):
    package = {'name': 'home-studio-isolated-browser-checks', 'private': True,
               'dependencies': {'playwright': version}}
    packages = {'': {key: value for key, value in package.items() if key != 'private'}}
    for name, metadata in toolchain['packages'].items():
        pinned = metadata.get('version', version)
        entry = {'version': pinned,
                 'resolved': f'https://registry.npmjs.org/{name}/-/{name}-{pinned}.tgz',
                 **metadata}
        if name == 'playwright':
            entry['dependencies'] = {'playwright-core': version}
        packages[f'node_modules/{name}'] = entry
    return package, {'name': package['name'], 'lockfileVersion': 3, 'requires': True, 'packages': packages}


def validate_installed(output, version, expected):
    for name in ('playwright', 'playwright-core'):
        installed = json.loads((output / 'node_modules' / name / 'package.json').read_text(encoding='utf-8'))
        if installed['version'] != version:
            raise ValueError(f'{name} version does not match the pinned toolchain')
    metadata = json.loads((output / 'node_modules/playwright-core/browsers.json').read_text(encoding='utf-8'))
    installed_browsers = {entry['name']: entry for entry in metadata['browsers']}
    for name, pin in expected['browsers'].items():
        installed = installed_browsers[name]
        if (installed['browserVersion'], installed['revision']) != (pin['version'], pin['revision']):
            raise ValueError(f'{name} metadata does not match the reviewed inventory')
    return metadata


def install(version, output, offline=False):
    manifest = matrix.load_manifest()
    toolchain = manifest['playwright'][version]
    if output.exists() and any(output.iterdir()):
        raise ValueError('Toolchain output must be empty; refusing to replace an installation')
    output.mkdir(parents=True, exist_ok=True)
    package, lock = lockfile(version, toolchain)
    for name, data in [('package.json', package), ('package-lock.json', lock)]:
        (output / name).write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')
    # Using npm's JavaScript entry point avoids cmd.exe quoting on Windows.
    npm = shutil.which('npm')
    if not npm:
        raise RuntimeError('npm must be on PATH')
    node = shutil.which('node')
    npm_cli = Path(npm).resolve().parent / 'node_modules/npm/bin/npm-cli.js'
    command = [node, str(npm_cli)] if npm_cli.is_file() else [npm]
    command += ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional']
    if offline:
        command.append('--offline')
    subprocess.run(command, cwd=output, check=True, timeout=240,
                   env={**os.environ, 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD': '1'})
    metadata = validate_installed(output, version, toolchain)
    receipt = {'schema': 1, 'playwright': version, 'module': str(output / 'node_modules/playwright'),
               'browsers': metadata['browsers']}
    (output / 'toolchain.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(receipt, indent=2))
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', required=True, choices=matrix.load_manifest()['playwright'])
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--github-env', type=Path)
    args = parser.parse_args()
    receipt = install(args.version, args.output.resolve(), args.offline)
    if args.github_env:
        with args.github_env.open('a', encoding='utf-8') as output:
            output.write(f'HOME_STUDIO_PLAYWRIGHT_MODULE={receipt["module"]}\n')
            output.write(f'PLAYWRIGHT_BROWSERS_PATH={args.output.resolve() / "browsers"}\n')
