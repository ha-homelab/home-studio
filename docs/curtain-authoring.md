# Curtains in Home Studio

Place **Open curtain pair with tiebacks** or **Full closed curtain pair** from
the item library. These designs can remain decorative, or follow a Home
Assistant cover in the published home.

In the item's details:

1. Enter its `cover.*` entity under **Home Assistant**, or leave the entity
   empty while arranging the room.
2. Under **Curtain movement**, choose **Window opening**. This explicitly binds
   the curtain to that window and aligns its position, width, height, and
   rotation. No nearby window is selected automatically.
3. Choose **Two panels — open from center**, **Gather to the left**, or
   **Gather to the right**. Left and right are viewed from in front of the
   curtain. Check its placement and dimensions after alignment.
4. Save and publish. The family view uses Home Assistant's reported position:
   0% is closed and 100% is open. Fabric and its pattern move; the rail remains
   fixed. A last known position is labeled as such when the device is
   unavailable. Without a reported or remembered position, the design stays
   at its current appearance; the viewer does not invent a measurement.

The editing preview shows the catalog design, rather than a simulated device
position. Changing **Window opening** back to **Decorative only — no window
binding** removes the visual relationship. Change or remove a curtain's
binding before deleting its window, or before assigning a non-cover entity.
Changing to a different type of furniture removes the curtain binding. One
Undo restores both the binding and the alignment made when selecting a window.

The two supported designs use sliding fabric. Roller blinds and other catalog
objects remain decorative; they are not stretched into sliding curtains.
The state-driven fabric is a visualization, not a physical position sensor or
proof of calibration. Existing cover controls retain their normal permissions.

## Saved format and compatibility

An optional source item field records the explicit relationship:

```json
"curtain": { "opening_id": "living_window", "mode": "pair" }
```

`opening_id` must identify a window on the same floor. `mode` accepts `pair`,
`left`, or `right`. The item must use one of the two curtain designs and its
entity must be empty or a `cover.*` ID. Both editor and compiler validate these
rules. Projects without the optional field retain their existing behavior.

Compiled `cover_windows` records address the window by ID. Normalized furniture
meshes carry `curtain_fabric` and `curtain_panel` tags, including patterned
surfaces. Rendering keeps those batches separate from the rail even when their
colors match. Existing custom curtain metadata keeps its original rendering
path. Runtime placement messages keep their existing inventory schema; native
placement saves preserve the source project's window binding. Protected
imports retain the installed window binding in the published model.

An older generated home's saved viewer may not support these new catalog
bindings. Publication then reports `unsupported_curtain_runtime` and keeps the
current published home intact. Choose **Decorative only** to publish the other
edits, or update the generated viewer through that home's original build/update
process. Updating the integration alone does not replace a customized viewer
or its saved baseline. Existing commissioned curtain bindings continue using
their original rendering behavior.

Checks use fictional projects and never send device commands:

```sh
node scripts/test-curtain-authoring.mjs
python3 scripts/test-curtain-authoring.py
node scripts/test-curtain-browser.cjs
```
