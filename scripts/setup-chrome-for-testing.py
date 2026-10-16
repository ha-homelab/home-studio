#!/usr/bin/env python3
"""Extract a reviewed Chrome for Testing archive without changing system browsers."""
import argparse
import hashlib
import json
import platform
import stat
import subprocess
import sys
import tempfile
import time
from download_tls import open_download
import zipfile
from pathlib import Path, PurePosixPath

MANIFEST = Path(__file__).with_name('browser-matrix.json')


def platform_key():
    machine = platform.machine().lower()
    if sys.platform == 'darwin' and machine in ('arm64', 'aarch64'):
        return 'mac-arm64'
    if machine not in ('x86_64', 'amd64'):
        raise ValueError('This reviewed Chrome inventory requires x64 Linux/Windows or ARM64 macOS')
    return {'linux': 'linux64', 'win32': 'win64'}[sys.platform]


def validate_archive(archive):
    total = 0
    with zipfile.ZipFile(archive) as source:
        for item in source.infolist():
            path = PurePosixPath(item.filename)
            if path.is_absolute() or '..' in path.parts or '\\' in item.filename or ':' in item.filename:
                raise ValueError('Unsafe path in Chrome archive')
            total += item.file_size
            if total > 2 * 1024**3:
                raise ValueError('Chrome archive exceeds 2 GiB extracted limit')
            if stat.S_ISLNK(item.external_attr >> 16):
                target = PurePosixPath(source.read(item).decode('utf-8'))
                depth = len(path.parent.parts)
                if target.is_absolute():
                    raise ValueError('Absolute link in Chrome archive')
                for part in target.parts:
                    depth += -1 if part == '..' else 1
                    if depth < 0:
                        raise ValueError('Escaping link in Chrome archive')


def install(version, output):
    key = platform_key()
    manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    entry = manifest['chrome_for_testing']['versions'][version][key]
    if output.exists() and any(output.iterdir()):
        raise ValueError('Chrome output must be empty; refusing to replace an installation')
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='home-studio-chrome-') as directory:
        archive = Path(directory) / 'chrome.zip'
        digest = hashlib.sha256()
        size = 0
        deadline = time.monotonic() + 240
        with open_download(entry['url'], timeout=60) as source, archive.open('wb') as target:
            while chunk := source.read(1024 * 1024):
                if time.monotonic() > deadline:
                    raise TimeoutError('Chrome download exceeded four minutes')
                size += len(chunk)
                if size > 512 * 1024**2:
                    raise ValueError('Chrome download exceeds 512 MiB limit')
                digest.update(chunk)
                target.write(chunk)
        if digest.hexdigest() != entry['sha256']:
            raise ValueError('Chrome for Testing failed pinned SHA-256 verification')
        validate_archive(archive)
        if key == 'mac-arm64':
            subprocess.run(['ditto', '-xk', str(archive), str(output)], check=True, timeout=90)
        else:
            with zipfile.ZipFile(archive) as source:
                source.extractall(output)
                if key == 'linux64':
                    for item in source.infolist():
                        if not item.is_dir():
                            mode = (item.external_attr >> 16) & 0o777
                            (output / item.filename).chmod(mode or 0o644)
    relative = {'linux64': 'chrome-linux64/chrome', 'win64': 'chrome-win64/chrome.exe',
                'mac-arm64': 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'}[key]
    binary = output / relative
    if not binary.is_file():
        raise ValueError('Chrome archive does not contain the expected browser executable')
    receipt = {'schema': 1, 'product': 'Chrome for Testing', 'version': version,
               'platform': key, 'binary': str(binary), 'source': entry}
    (output / 'install.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(receipt, indent=2))
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', required=True)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--github-env', type=Path)
    args = parser.parse_args()
    receipt = install(args.version, args.output.resolve())
    if args.github_env:
        with args.github_env.open('a', encoding='utf-8') as output:
            output.write(f'PLAYWRIGHT_CHROMIUM_EXECUTABLE={receipt["binary"]}\n')
