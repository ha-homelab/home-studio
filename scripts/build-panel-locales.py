#!/usr/bin/env python3
"""Embed the host's compact messages; --check detects stale generated translations."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PANEL = ROOT / 'custom_components/home_floorplan/static/panel.js'
BEGIN = '// BEGIN GENERATED PANEL MESSAGES (scripts/build-panel-locales.py)'
END = '// END GENERATED PANEL MESSAGES'
KEYS = json.loads('''
[
  "Dry run: On",
  "Dry run: Off",
  "Dry run is required by this link.",
  "Try device buttons without sending commands.",
  "Dry run remains on: the preference could not be saved.",
  "Dry run is on because browser storage is unavailable.",
  "Dry run \u00b7 device commands are blocked; states stay live.",
  "Dry run \u00b7 no command sent. Showing live device states.",
  "Dry run is on for this session. Keep ?dry_run=1 in the link to retain it after reload.",
  "Live controls enabled.",
  "Wait for placements to save successfully before controlling devices.",
  "This device is not linked to the saved plan.",
  "This device is unavailable or Home Assistant is disconnected.",
  "A command for this device is already in progress.",
  "Command sent \u00b7 device state updates live",
  "Command failed: {error}",
  "The command could not be sent.",
  "{name}: state change was not confirmed. Check the device before trying again.",
  "Command confirmation timed out. Check device state before retrying.",
  "Open sidebar",
  "Reload saved plan",
  "Connecting to Home Assistant\u2026",
  "Connected \u00b7 placements are saved in Home Assistant"
]
''')


def generate():
    locales = json.loads((ROOT / 'viewer-locales/index.json').read_text(encoding='utf-8'))
    messages = {}
    for locale in locales:
        dictionary = json.loads((ROOT / 'viewer-locales' / (locale['code'] + '.json')).read_text(encoding='utf-8'))
        messages[locale['code']] = {key: dictionary[key] for key in KEYS}
    # These are external JS bytes, never innerHTML or an inline script.
    return BEGIN + '\nconst panelMessages = ' + json.dumps(messages, ensure_ascii=False, separators=(',', ':')) + ';\n' + END


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    options = parser.parse_args()
    source = PANEL.read_text(encoding='utf-8')
    before, body = source.split(BEGIN, 1)
    _, after = body.split(END, 1)
    updated = before + generate() + after
    if options.check:
        if source != updated:
            raise SystemExit('Host translations are stale: run python3 scripts/build-panel-locales.py')
        print('Host translations match all 24 viewer locale packs.')
    else:
        PANEL.write_text(updated, encoding='utf-8', newline='\n')


if __name__ == '__main__':
    main()
