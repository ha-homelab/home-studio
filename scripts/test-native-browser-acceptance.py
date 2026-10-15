#!/usr/bin/env python3
"""Run all synthetic viewer and planner checks in a pinned native browser."""
import importlib.util
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('native_acceptance', Path(__file__).with_name('test-waterfox-acceptance.py'))
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)


if __name__ == '__main__':
    sys.exit(acceptance.main(default_product=None))
