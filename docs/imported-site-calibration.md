# Calibrate an imported home's site frame

Some imported homes keep each floor in its own local coordinate frame. Their
original models may contain reliable ground offsets while the editable draft
shows every floor at elevation zero. Adding one shared site in that state can
misalign the exterior between floors.

If publication also reports that the saved viewer lacks neighborhood-outline
support, prepare the viewer update before adding new site shapes or calibrating
floor offsets. Calibration itself changes reference metadata; it does not update
the renderer.

## Preserve the current published viewer

As an administrator, open **More options → Update imported viewer** from a saved
imported home whose draft matches its current publication. The preview identifies
the **current published generation** as its source. Applying copies that complete
asset tree into a new private baseline, preserving refreshed custom models,
downloadable exports and textures that may differ from an older baseline. The
new copy also retains files exactly as present or absent in the current source;
it does not overlay them onto the older asset tree.

The preview shows the total number of published files to copy and the number of
copied viewer files receiving the known map-renderer update. That renderer count
is relative to the current published files, **not** a claim about the total
differences from the older baseline. Only the recognized renderer block inside
each copied viewer is replaced; original model data and the embedded reference
inventory are retained. The source project metadata comes from the current
verified draft, without rebuilding home geometry.

This automatic path accepts a narrow, verified state: matching saved/published
revisions and inventory; supported viewer code; unchanged original room shapes;
no authored wall/opening overlays; and matching embedded inventory and model
coverage. It refuses unpublished edits, unsupported architecture or refreshed
items not represented by the current published assets.

If it refuses, **do not publish merely to make the update eligible**. Export the
drawing JSON, keep an offline private backup of the current home, and reconcile
the saved draft with its matching original source before retrying. Publishing
from an older baseline could restore older custom models or exports. The refusal
does not discard the drawing or change the active home.

**Prepare viewer update** creates the private baseline and recovery record; it
does not activate a new published generation. The previous baseline and current
published assets remain untouched. The recovery record retains the previous
saved document, source-generation identity and file hashes. Keep the private
storage backup as well; drawing JSON alone does not contain commissioned meshes,
textures or other asset files. After reviewing the prepared source and any floor
calibration, **Publish to 3D Home** is the separate activation step.

The open editor retains any newer local edits after preparation. If its custom
model labels need refreshing, first save or export those edits, then use **Load
saved draft**. Preparation does not force an editor reload.

## Review the floor offsets

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
python3 scripts/test-runtime-upgrade.py
node scripts/test-viewer-runtime-upgrade.cjs
```
