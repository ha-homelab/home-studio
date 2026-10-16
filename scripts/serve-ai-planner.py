#!/usr/bin/env python3
"""Start the optional loopback-only Home Studio AI companion."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ai_companion.server import main

if __name__ == "__main__":
    raise SystemExit(main())
