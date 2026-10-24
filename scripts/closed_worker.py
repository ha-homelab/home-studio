#!/usr/bin/env python3
"""Fixed container entrypoint; no transport, signing or host access."""
import os
from pathlib import Path
import resource
import shutil
import subprocess
import sys


# Match closed_build.MAX_PACKAGE: this per-file kernel bound also covers the
# compressed output archive. The host separately enforces 64 MiB scene members.
MAX_PACKAGE = 128 * 1024 * 1024


def main():
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_PACKAGE, MAX_PACKAGE))
    shutil.copytree("/input", "/work/source")
    os.chdir("/work/source")
    result = subprocess.run(
        [sys.executable, "scripts/closed-build-entry.py", "--public-source", "/public/source",
         "--public-component", "/public/component", "--output", "/output/home-package.tar.gz",
         "--context", "/context/build.json", "--dependency-root", "/public/dependencies"], check=False,
        env={"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "HOME": "/tmp",
             "TMPDIR": "/work", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1"})
    if result.returncode:
        return 1
    return 0 if Path("/output/acceptance.json").is_file() else 1


if __name__ == "__main__":
    sys.exit(main())
