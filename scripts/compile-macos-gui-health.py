#!/usr/bin/env python3
"""Compile the fixed read-only probe before a browser session; never run it."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import time

SOURCE = Path(__file__).resolve().with_name('macos-gui-health.m')
SOURCE_SHA256 = 'f1d92a077c884e41275ee3baebca5e70df1144cb69d4b482c2e1e80a90cef5f7'


class CompileInterrupted(RuntimeError):
    pass


def run_compiler(command, timeout=30, cleanup_timeout=2):
    """Main-thread setup only. Stop the owned compiler group on every exit."""
    deadline = time.monotonic() + timeout
    child = None
    cancelled = None
    previous = {}

    def interrupted(signum, _frame):
        nonlocal cancelled
        # Never raise during Popen or cleanup: the owned child must first be
        # recorded, and repeated cancellation must not interrupt its collection.
        cancelled = cancelled or signum

    try:
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous[signum] = signal.signal(signum, interrupted)
        if cancelled:
            raise CompileInterrupted(f'compiler setup interrupted by signal {cancelled}')
        child = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True)
        while True:
            if cancelled:
                raise CompileInterrupted(f'compiler setup interrupted by signal {cancelled}')
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError('compiler setup deadline exceeded')
            try:
                result = child.wait(timeout=min(.05, remaining))
                break
            except subprocess.TimeoutExpired:
                pass
        if result:
            raise RuntimeError(f'compiler exited {result}')
    finally:
        try:
            # The driver can exit before its descendants. Its new process group
            # is owned by this call, so clean it even after a successful wait.
            if child is not None:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    child.wait(timeout=cleanup_timeout)
                except subprocess.TimeoutExpired:
                    raise RuntimeError('compiler cleanup deadline exceeded') from None
        finally:
            for signum, handler in previous.items():
                signal.signal(signum, handler)
    if cancelled:
        raise CompileInterrupted(f'compiler setup interrupted by signal {cancelled}')


def compile_probe(output):
    output = Path(output).absolute()
    if output.exists() or output.is_symlink():
        raise RuntimeError('output must be a new file')
    if hashlib.sha256(SOURCE.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise RuntimeError('fixed probe source identity changed')
    with tempfile.TemporaryDirectory(prefix='.macos-gui-health-build-', dir=output.parent) as temporary:
        executable = Path(temporary) / 'probe'
        run_compiler(['/usr/bin/xcrun', '--sdk', 'macosx', 'clang', '-fobjc-arc', '-O2',
                      '-Wall', '-Wextra', '-Werror', '-framework', 'Foundation',
                      '-framework', 'AppKit', '-framework', 'CoreGraphics', str(SOURCE),
                      '-o', str(executable)])
        info = executable.lstat()
        if not stat.S_ISREG(info.st_mode) or not info.st_mode & 0o111 or not 0 < info.st_size <= 16 * 1024 * 1024:
            raise RuntimeError('compiler output is not a bounded regular executable')
        if hashlib.sha256(SOURCE.read_bytes()).hexdigest() != SOURCE_SHA256:
            raise RuntimeError('fixed probe source changed during compilation')
        digest = hashlib.sha256(executable.read_bytes()).hexdigest()
        os.link(executable, output)  # Exclusive publication; never replace a file.
    return {'status': 'compiled-not-run', 'sourceSha256': SOURCE_SHA256,
            'executableSha256': digest, 'bytes': info.st_size,
            'compilerTimeoutSeconds': 30, 'cleanupTimeoutSeconds': 2}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, help='new executable path in an existing setup directory')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        raise RuntimeError('macOS required')
    print(json.dumps(compile_probe(args.output), sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'compile-unavailable', 'errorType': type(error).__name__}))
        sys.exit(1)
