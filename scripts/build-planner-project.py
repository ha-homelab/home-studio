#!/usr/bin/env python3
"""Compile a new home's JSON project into isolated 3D viewers and HA assets."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from planner.project import DEFAULT_OUTPUT, ProjectError, compile_project, load_project


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, required=True, help="Schema version 1 metric project JSON")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Empty or compiler-owned directory (default: dist/planner-project)")
    parser.add_argument("--ha-package", action="store_true", help="Also create an installable Home Assistant integration archive")
    args = parser.parse_args()
    try:
        result = compile_project(load_project(args.project), args.output, args.ha_package, args.project)
    except (ProjectError, OSError) as error:
        parser.exit(2, "Project build failed: " + str(error) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
