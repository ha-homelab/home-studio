#!/usr/bin/env python3
"""Retry transient browser-download failures, never browser acceptance tests."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time


TRANSIENT = re.compile(r'curl: \((?:6|7|18|28|52|55|56|92)\)|\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b')
PERMANENT = re.compile(
    r'curl: \((?:35|51|58|60|77|83|90)\)|permission denied|'
    r'\b(?:TLS|SSL)(?:_\w+)?\b[^\n]*(?:error|fail|alert)|\bERR_(?:TLS|SSL)_|'
    r'(?:checksum|signature|certificate).{0,100}(?:mismatch|invalid|failed|expired|not verified)|'
    r'(?:invalid|bad|failed to verify).{0,40}(?:checksum|signature|certificate)|'
    r'CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN', re.IGNORECASE)


def installer_command(environment):
    """Only construct the selected pinned toolchain's installation command."""
    node = shutil.which('node')
    if not node:
        raise ValueError('Node.js must be on PATH')
    cli = Path(environment['HOME_STUDIO_PLAYWRIGHT_MODULE']) / 'cli.js'
    if not cli.is_file():
        raise ValueError('The verified Playwright toolchain must be installed first')
    channel = environment.get('HOME_STUDIO_BROWSER_CHANNEL', '')
    if channel:
        if channel not in {'chrome', 'chrome-beta', 'msedge', 'msedge-beta'}:
            raise ValueError('Unknown browser release channel')
        arguments = ['install', '--with-deps', '--force', channel]
    elif environment.get('CFT_VERSION'):
        arguments = ['install-deps', 'chromium']
    else:
        engine = environment['BROWSER_STABILITY_ENGINES']
        if engine not in {'chromium', 'firefox', 'webkit'}:
            raise ValueError('Expected exactly one browser engine')
        arguments = ['install', '--with-deps', engine]
    return [node, str(cli), *arguments]


def install(command, output, *, run=subprocess.run, sleep=time.sleep):
    """Keep every attempt; a permanent error or three failed attempts is fatal."""
    output.mkdir(parents=True, exist_ok=True)
    attempts = []
    def receipt(status):
        (output / 'result.json').write_text(json.dumps({
            'schema': 1, 'command': command, 'attempts': attempts, 'status': status
        }, indent=2) + '\n', encoding='utf-8')
    for number in range(1, 4):
        attempt = {'attempt': number, 'exitCode': None, 'retry': False}
        attempts.append(attempt)
        receipt('running')
        log_path = output / f'attempt-{number}.log'
        print(f'Browser installation attempt {number}/3; output: {log_path}', flush=True)
        # The child writes directly to disk, retaining partial output even if
        # the job is cancelled before the installer exits.
        with log_path.open('w', encoding='utf-8') as stream:
            result = run(command, stdout=stream, stderr=subprocess.STDOUT, check=False)
        log = log_path.read_text(encoding='utf-8', errors='replace')
        print(log, end='', flush=True)
        retry = (result.returncode > 0 and number < 3 and bool(TRANSIENT.search(log))
                 and not PERMANENT.search(log))
        attempt.update(exitCode=result.returncode, retry=bool(retry))
        receipt('passed' if result.returncode == 0 else 'retrying' if retry else 'failed')
        if not retry:
            return result.returncode if result.returncode >= 0 else 1
        delay = 5 if number == 1 else 15
        print(f'Transient browser download failure; retrying installation in {delay}s.', flush=True)
        sleep(delay)
    raise AssertionError('The final installation attempt must return')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path('acceptance-artifacts/browser-install'))
    args = parser.parse_args()
    sys.exit(install(installer_command(os.environ), args.output))
