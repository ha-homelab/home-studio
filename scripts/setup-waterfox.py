#!/usr/bin/env python3
"""Extract a checksum-pinned official Waterfox into an isolated directory."""
from native_browser import main


if __name__ == '__main__':
    main(default_product='waterfox')
