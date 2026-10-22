#!/usr/bin/env python3
"""Use the canonical archive only on verified ephemeral Ubuntu Actions hosts."""
import argparse
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile


AZURE_ARCHIVE = re.compile(r'(?<!\S)https?://azure\.archive\.ubuntu\.com/ubuntu(?=/?(?:\s|$))')
CANONICAL_ARCHIVE = 'https://archive.ubuntu.com/ubuntu'


def require_host():
    """A local or self-hosted machine must never have its apt configuration changed."""
    if not (os.environ.get('GITHUB_ACTIONS') == 'true' and
            os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted' and
            os.environ.get('RUNNER_OS') == 'Linux' and sys.platform == 'linux' and
            platform.freedesktop_os_release().get('ID') == 'ubuntu'):
        raise ValueError('Archive preparation requires a GitHub-hosted Ubuntu Actions runner')


def rewrite_archive(text):
    """Keep signatures, suites, components, other repositories and comments intact."""
    result = []
    for line in text.splitlines(keepends=True):
        active, marker, comment = line.partition('#')
        result.append(AZURE_ARCHIVE.sub(CANONICAL_ARCHIVE, active) + marker + comment)
    return ''.join(result)


def source_paths(root):
    # Ubuntu uses either one-line or deb822 sources. Hosted images can instead
    # reference mirror+file:/etc/apt/apt-mirrors.txt; keep that indirection intact.
    candidates = [root / 'sources.list', *sorted((root / 'sources.list.d').glob('*.list')),
                  *sorted((root / 'sources.list.d').glob('*.sources')),
                  *sorted(root.glob('apt-mirrors*.txt'))]
    for path in candidates:
        if path.is_symlink() or path.parent.is_symlink():
            raise ValueError('Refusing a symlinked apt source')
    return [path for path in candidates if path.is_file()]


def replace_source(path, text):
    require_host()
    # Copy into the existing root-owned file, retaining its mode/ownership.
    # No shell, apt command, trust override or persistent sudo configuration.
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8') as temporary:
        temporary.write(text)
        temporary.flush()
        subprocess.run(['/usr/bin/sudo', '-n', '/usr/bin/cp', '--', temporary.name, str(path)],
                       check=True, timeout=15, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def prepare(root=Path('/etc/apt'), *, replace=replace_source):
    require_host()
    changes = []
    for path in source_paths(root):
        before = path.read_text(encoding='utf-8')
        after = rewrite_archive(before)
        if after != before:
            changes.append((path, after))
    for path, text in changes:
        replace(path, text)
        if path.read_text(encoding='utf-8') != text:
            raise RuntimeError('The selected archive was not written correctly')
    return {'schema': 1, 'status': 'prepared' if changes else 'unchanged',
            'from': 'azure.archive.ubuntu.com', 'to': 'https://archive.ubuntu.com',
            'files': [str(path) for path, _ in changes]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path('acceptance-artifacts/ubuntu-apt.json'))
    args = parser.parse_args(argv)
    try:
        result = prepare()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        # Avoid leaking source contents or subprocess diagnostics into CI output.
        result = {'schema': 1, 'status': 'failed', 'error': type(error).__name__}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result))
    return 1 if result['status'] == 'failed' else 0


if __name__ == '__main__':
    sys.exit(main())
