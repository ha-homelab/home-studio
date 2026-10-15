#!/usr/bin/env python3
"""Extract a checksum-pinned official Waterfox into an isolated directory."""
import argparse
import configparser
import hashlib
import json
import platform
import plistlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

MANIFEST = Path(__file__).with_name('waterfox-versions.json')


def platform_key():
    if sys.platform == 'darwin':
        return 'macos'
    if platform.machine().lower() not in ('amd64', 'x86_64'):
        raise RuntimeError('Pinned Windows/Linux downloads require x86-64')
    return {'win32': 'windows-x64', 'linux': 'linux-x64'}[sys.platform]


def download(entry, destination):
    digest = hashlib.sha512()
    deadline = time.monotonic() + 240
    with urllib.request.urlopen(entry['url'], timeout=60) as source, destination.open('wb') as target:
        total = 0
        while chunk := source.read(1024 * 1024):
            if time.monotonic() > deadline:
                raise TimeoutError('Waterfox download exceeded four minutes')
            total += len(chunk)
            if total > 1024 * 1024 * 1024:
                raise RuntimeError('Download exceeded the 1 GiB safety limit')
            digest.update(chunk)
            target.write(chunk)
    if digest.hexdigest() != entry['sha512']:
        destination.unlink()
        raise RuntimeError('Official Waterfox download failed pinned SHA-512 verification')


def read_ini(path):
    parser = configparser.ConfigParser(interpolation=None)
    parser.optionxform = str
    parser.read(path, encoding='utf-8')
    return {section: dict(parser[section]) for section in parser.sections()}


def install(version, output):
    manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    key = platform_key()
    entry = manifest['versions'][version][key]
    if output.exists() and any(output.iterdir()):
        raise RuntimeError('Installation output must be empty; refusing to replace an existing installation')
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='waterfox-download-') as directory:
        scratch = Path(directory)
        archive = scratch / Path(urllib.parse.unquote(urllib.parse.urlparse(entry['url']).path)).name
        download(entry, archive)
        if key == 'windows-x64':
            seven_zip = shutil.which('7z') or str(Path('C:/Program Files/7-Zip/7z.exe'))
            subprocess.run([seven_zip, 'x', '-y', f'-o{output}', str(archive)], check=True, timeout=180)
            binary, resources = output / 'core/waterfox.exe', output / 'core'
        elif key == 'macos':
            mount = scratch / 'mount'
            mount.mkdir()
            subprocess.run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', str(mount), str(archive)], check=True, timeout=90)
            try:
                shutil.copytree(mount / 'Waterfox.app', output / 'Waterfox.app', symlinks=True)
            finally:
                subprocess.run(['hdiutil', 'detach', str(mount)], check=True, timeout=30)
            subprocess.run(['codesign', '--verify', '--deep', '--strict', str(output / 'Waterfox.app')], check=True, timeout=60)
            binary = output / 'Waterfox.app/Contents/MacOS/waterfox'
            resources = output / 'Waterfox.app/Contents/Resources'
        else:
            with tarfile.open(archive) as package:
                package.extractall(output, filter='data')
            binary, resources = output / 'waterfox/waterfox', output / 'waterfox'
    if not binary.is_file():
        raise RuntimeError(f'Official package did not contain expected binary: {binary}')
    metadata = {name: read_ini(resources / name) for name in ('application.ini', 'platform.ini')}
    # The branded version is separate from the Gecko version in application.ini.
    # Retain both and bind the installation to the verified release archive.
    # Never write policies into the installation: on macOS those are sealed resources.
    # Runtime preferences belong exclusively to the temporary test profile.
    if key == 'macos':
        with (output / 'Waterfox.app/Contents/Info.plist').open('rb') as source:
            bundle = plistlib.load(source)
        metadata['bundle'] = {key: bundle[key] for key in ('CFBundleShortVersionString', 'CFBundleVersion')}
    receipt = {'schema': 1, 'product': 'Waterfox', 'release': version, 'platform': key,
               'binary': str(binary.resolve()), 'source': entry, 'metadata': metadata}
    (output / 'install.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', required=True, choices=json.loads(MANIFEST.read_text(encoding='utf-8'))['versions'])
    parser.add_argument('--output', required=True, type=Path)
    options = parser.parse_args()
    install(options.version, options.output.resolve())
