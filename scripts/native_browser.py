#!/usr/bin/env python3
"""Install checksum-pinned official Gecko browsers without touching user profiles."""
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
import urllib.error
import urllib.parse
import urllib.request
from download_tls import open_download
from pathlib import Path

PRODUCTS = {'waterfox': 'Waterfox', 'firefox': 'Firefox'}


def manifest_for(product):
    if product not in PRODUCTS:
        raise ValueError(f'Unsupported native browser: {product}')
    return json.loads(Path(__file__).with_name(f'{product}-versions.json').read_text(encoding='utf-8'))


def platform_key():
    if sys.platform == 'darwin':
        return 'macos'
    if platform.machine().lower() not in ('amd64', 'x86_64'):
        raise RuntimeError('Pinned Windows/Linux downloads require x86-64')
    return {'win32': 'windows-x64', 'linux': 'linux-x64'}[sys.platform]


def download(entry, destination):
    """Retry only interrupted transfers, within one deadline and checksum pin."""
    deadline = time.monotonic() + 240
    for attempt in range(1, 4):
        complete = False
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('Browser download exceeded four minutes')
            digest = hashlib.sha512()
            with open_download(entry['url'], timeout=min(60, remaining)) as source, destination.open('wb') as target:
                total = 0
                while chunk := source.read(1024 * 1024):
                    if time.monotonic() > deadline:
                        raise TimeoutError('Browser download exceeded four minutes')
                    total += len(chunk)
                    if total > 1024 * 1024 * 1024:
                        raise RuntimeError('Download exceeded the 1 GiB safety limit')
                    digest.update(chunk)
                    target.write(chunk)
            if time.monotonic() > deadline:
                raise TimeoutError('Browser download exceeded four minutes')
            if digest.hexdigest() != entry['sha512']:
                raise RuntimeError('Official browser download failed pinned SHA-512 verification')
            complete = True
            return
        except (ConnectionResetError, urllib.error.URLError) as error:
            # urllib wraps a reset during connection setup, while a reset while
            # reading the response propagates directly. TLS, HTTP and checksum
            # failures are not transient transport evidence and never retry.
            reason = error.reason if isinstance(error, urllib.error.URLError) else error
            if not isinstance(reason, ConnectionResetError) or attempt == 3:
                raise
            print(f'Native browser download connection reset; retrying transfer ({attempt + 1}/3).', file=sys.stderr)
            time.sleep(min(attempt, max(0, deadline - time.monotonic())))
        finally:
            if not complete:
                destination.unlink(missing_ok=True)


def read_ini(path):
    parser = configparser.ConfigParser(interpolation=None)
    parser.optionxform = str
    parser.read(path, encoding='utf-8')
    return {section: dict(parser[section]) for section in parser.sections()}


def install(version, output, product='waterfox'):
    manifest = manifest_for(product)
    brand = PRODUCTS[product]
    key = platform_key()
    entry = manifest['versions'][version][key]
    if output.exists() and any(output.iterdir()):
        raise RuntimeError('Installation output must be empty; refusing to replace an existing installation')
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f'{product}-download-') as directory:
        scratch = Path(directory)
        archive = scratch / Path(urllib.parse.unquote(urllib.parse.urlparse(entry['url']).path)).name
        download(entry, archive)
        if key == 'windows-x64':
            seven_zip = shutil.which('7z') or str(Path('C:/Program Files/7-Zip/7z.exe'))
            subprocess.run([seven_zip, 'x', '-y', f'-o{output}', str(archive)], check=True, timeout=180)
            binary, resources = output / f'core/{product}.exe', output / 'core'
        elif key == 'macos':
            mount = scratch / 'mount'
            mount.mkdir()
            subprocess.run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', str(mount), str(archive)], check=True, timeout=90)
            try:
                shutil.copytree(mount / f'{brand}.app', output / f'{brand}.app', symlinks=True)
            finally:
                subprocess.run(['hdiutil', 'detach', str(mount)], check=True, timeout=30)
            subprocess.run(['codesign', '--verify', '--deep', '--strict', str(output / f'{brand}.app')], check=True, timeout=60)
            binary = output / f'{brand}.app/Contents/MacOS/{product}'
            resources = output / f'{brand}.app/Contents/Resources'
        else:
            with tarfile.open(archive) as package:
                package.extractall(output, filter='data')
            binary, resources = output / product / product, output / product
    if not binary.is_file():
        raise RuntimeError(f'Official package did not contain expected binary: {binary}')
    metadata = {name: read_ini(resources / name) for name in ('application.ini', 'platform.ini')}
    # Waterfox's branded release differs from its Gecko application version.
    # Retain both and bind the installation to the verified release archive.
    # Never write policies into the installation: on macOS those are sealed resources.
    # Runtime preferences belong exclusively to the temporary test profile.
    if key == 'macos':
        with (output / f'{brand}.app/Contents/Info.plist').open('rb') as source:
            bundle = plistlib.load(source)
        metadata['bundle'] = {key: bundle[key] for key in ('CFBundleShortVersionString', 'CFBundleVersion')}
    receipt = {'schema': 1, 'product': brand, 'release': version, 'platform': key,
               'binary': str(binary.resolve()), 'source': entry, 'metadata': metadata}
    validate_metadata(receipt)
    (output / 'install.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(receipt, indent=2))
    return receipt


def validate_metadata(installation):
    """The branded product and real app version come from the verified archive."""
    product = installation['product'].lower()
    if installation['product'] != PRODUCTS.get(product):
        raise ValueError('Installation has an unsupported product identity')
    app = installation['metadata']['application.ini']['App']
    if app.get('Name') != PRODUCTS[product]:
        raise ValueError('Package product name does not match the requested browser')
    if product == 'firefox':
        # ESR is a distribution channel suffix; application.ini and Marionette
        # report its numeric version (for example, 153.5.0).
        version = installation['release'].removesuffix('esr')
        if app.get('Version') != version:
            raise ValueError('Firefox application version does not match the pinned release')
        build_id = app.get('BuildID', '')
        if len(build_id) != 14 or not build_id.isdigit():
            raise ValueError('Firefox package must contain its actual build ID')


def validate_installation(installation, product, expected_version=None):
    """Reject mislabeled receipts and changed installed metadata before launch."""
    if installation['product'] != PRODUCTS[product]:
        raise ValueError('Installation product does not match the requested browser')
    if expected_version is not None and installation['release'] != expected_version:
        raise ValueError('Installation release does not match the requested version')
    manifest = manifest_for(product)
    if installation['source'] != manifest['versions'][installation['release']][installation['platform']]:
        raise ValueError('Installation receipt must match a pinned release')
    if installation['platform'] != platform_key():
        raise ValueError('Installation platform does not match this host')
    binary = Path(installation['binary'])
    if not binary.is_file():
        raise ValueError('Installed browser binary does not exist')
    resources = binary.parent.parent / 'Resources' if installation['platform'] == 'macos' else binary.parent
    for name in ('application.ini', 'platform.ini'):
        if read_ini(resources / name) != installation['metadata'][name]:
            raise ValueError(f'Installed {name} differs from the verified package receipt')
    validate_metadata(installation)


def main(default_product=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--product', choices=PRODUCTS, default=default_product, required=default_product is None)
    parser.add_argument('--version', required=True)
    parser.add_argument('--output', required=True, type=Path)
    options = parser.parse_args()
    if options.version not in manifest_for(options.product)['versions']:
        parser.error(f'Unpinned {options.product} version: {options.version}')
    install(options.version, options.output.resolve(), options.product)


if __name__ == '__main__':
    main()
