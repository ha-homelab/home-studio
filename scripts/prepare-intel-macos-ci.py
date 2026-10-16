#!/usr/bin/env python3
"""Normalize Spotlight only on explicitly verified ephemeral Intel Actions hosts."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def require_indexing_host():
    """Never change a local, self-hosted, non-macOS or non-Intel machine."""
    if not (os.environ.get('GITHUB_ACTIONS') == 'true' and
            os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted' and
            os.environ.get('RUNNER_OS') == 'macOS' and
            sys.platform == 'darwin' and platform.machine() == 'x86_64'):
        raise ValueError('Spotlight control requires a GitHub-hosted Intel macOS Actions runner')


def indexing_command(path, disable=False):
    """Run only the fixed status or indexing-off command and retain bounded evidence."""
    require_indexing_host()
    command = (['/usr/bin/sudo', '-n', '/usr/bin/mdutil', '-a', '-i', 'off']
               if disable else ['/usr/bin/mdutil', '-a', '-s'])
    record = {'preparationOnly': True, 'command': command, 'startedAt': utc_now(),
              'timeoutSeconds': 15, 'outputLimitCharacters': 4096}
    started = time.monotonic()
    def capture(value):
        if isinstance(value, bytes):
            value = value.decode('utf-8', errors='replace')
        value = value or ''
        return value[:4096], len(value) > 4096
    try:
        environment = os.environ.copy()
        environment['LC_ALL'] = 'C'
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, check=False, timeout=15, env=environment)
        record.update(exitCode=result.returncode,
                      status='completed' if result.returncode == 0 else 'failed')
        stdout, stderr = result.stdout, result.stderr
    except (OSError, subprocess.TimeoutExpired) as error:
        record.update(exitCode=None, status='failed', error=type(error).__name__)
        stdout, stderr = getattr(error, 'stdout', None), getattr(error, 'stderr', None)
    record['stdout'], record['stdoutTruncated'] = capture(stdout)
    record['stderr'], record['stderrTruncated'] = capture(stderr)
    record['elapsedSeconds'] = time.monotonic() - started
    write_json(path, record)
    if record['status'] != 'completed':
        raise RuntimeError('Spotlight command failed; see ' + path.name)
    return record


def indexing_volumes(record):
    """Interpret complete mdutil status, rejecting unknown or partial evidence."""
    if record['stdoutTruncated'] or record['stderrTruncated']:
        raise ValueError('Spotlight status output is truncated')
    volumes, current = {}, None
    for raw in record['stdout'].splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith('/') and line.endswith(':'):
            if current is not None or line[:-1] in volumes:
                raise ValueError('Spotlight status contains an incomplete or duplicate volume')
            current = line[:-1]
        elif current is not None and line in (
                'Indexing enabled.', 'Indexing disabled.', 'Indexing and searching disabled.'):
            volumes[current] = line
            current = None
        else:
            raise ValueError('Spotlight status contains an unrecognized result')
    if current is not None or not volumes:
        raise ValueError('Spotlight status has no complete volume inventory')
    return volumes


def verify_indexing_disabled(record, expected_volumes):
    volumes = indexing_volumes(record)
    if set(volumes) != set(expected_volumes) or any(
            value == 'Indexing enabled.' for value in volumes.values()):
        raise ValueError('Spotlight indexing-off state was not verified for every initial volume')


def prepare(output):
    output.mkdir(parents=True, exist_ok=True)
    receipt = {'schema': 1, 'preparationOnly': True, 'status': 'preparing',
               'startedAt': utc_now(), 'verifiedDisabled': False,
               'commands': ['before.json', 'disable.json', 'after.json']}
    path = output / 'preparation.json'
    write_json(path, receipt)
    try:
        require_indexing_host()
        receipt['hostGatesPassed'] = True
        before = indexing_volumes(indexing_command(output / 'before.json'))
        receipt['beforeVolumes'] = before
        indexing_command(output / 'disable.json', disable=True)
        after = indexing_command(output / 'after.json')
        verify_indexing_disabled(after, before)
        receipt.update(status='prepared', verifiedDisabled=True,
                       afterVolumes=indexing_volumes(after))
    except Exception as error:
        receipt.update(status='failed', error=f'{type(error).__name__}: {error}')
    finally:
        receipt['finishedAt'] = utc_now()
        write_json(path, receipt)
    return 0 if receipt['status'] == 'prepared' else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    return prepare(parser.parse_args(argv).output)


if __name__ == '__main__':
    sys.exit(main())
