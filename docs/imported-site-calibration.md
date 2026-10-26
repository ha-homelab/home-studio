# Calibrate an imported home's site frame

Some imported homes keep each floor in its own local coordinate frame. Their
original models may contain reliable ground offsets while the editable draft
shows every floor at elevation zero. Adding one shared site in that state can
misalign the exterior between floors.

As an administrator, save your latest draft, then open **More options → Calibrate
imported site frame**. The preview lists each current and proposed floor offset.
The proposed offset is the negative of that floor's original ground offset, using
global site ground zero. **Cancel** leaves the draft unchanged. **Apply floor
offsets** saves the reviewed offsets; publishing is a separate action.

Calibration requires a saved imported source, a matching original snapshot and
consistent ground values in each model and its embedded viewer. It refuses
missing or conflicting data and existing nonzero authored site ground. If those
checks fail, correct the original source instead of guessing offsets.

Applying creates a new private baseline metadata snapshot with byte-identical
asset files. It preserves the old baseline and stores the prior draft document
in the new snapshot's `previous-document.json`. Current inventory, bindings and
published generation remain unchanged. Local meshes, room coordinates, object
positions, roof and yard data, and existing slab/extent behavior are retained.
The editable floor elevations change; exports containing all floors use these
corrected global offsets.

A preview expires after five minutes. Source changes, another saved revision,
or another administrator's preview cannot be applied with the old token. After
a connection failure, load the saved draft to check the outcome before retrying.
Keep Home Assistant's private storage and backups available for recovery; do not
edit the stored baseline files manually.

Validation uses synthetic two-floor homes, including save failure, stale source,
revision conflicts, reload, later publication and browser preview/apply behavior:

```sh
python3 scripts/test-site-calibration.py
node scripts/test-site-calibration.cjs
```
