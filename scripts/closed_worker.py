#!/usr/bin/env python3
"""Fixed container entrypoint; no transport, signing or host access."""
import os
from pathlib import Path
import resource
import shutil
import subprocess
import sys


def main():
    resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024))
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
