# Drawings and materials

Open **Drawings & materials** in the editor to document a drawing, review its
derived sheets, and download a printable package. This is an authoring tool;
opening it does not publish a home, start a model request, or control devices.

## 1. Brief and measurements

Write a short design brief, choose a floor and an element, and record the source
of its dimensions: **Measured**, **Estimated**, **Imported**, or **Unknown**.
Add a note describing the source or what still needs checking.

**Record current dimensions** associates that source with the element's current
geometry. Selecting or changing a source alone does not verify the dimensions;
record the current dimensions explicitly after checking them. If the geometry
later changes, the record becomes **Out of date** until you check and explicitly
record it again. This never resizes the drawing. Photos and estimates are not a
survey, and importing dimensions does not establish their accuracy.

## 2. Finishes and ceiling fixtures

Choose a room and enter finish codes, specifications, and optional waste
allowances for its floor, walls, and ceiling. These describe design intent;
they do not identify a supplier or certify quantities for purchasing.
Leaving a waste field blank means no additional allowance (0%).

Select **Ceiling-mounted items** individually. An item's type or height never
adds it automatically. The ceiling sheet represents the existing floor height
and your selected fixtures; it does not design soffits, structural systems,
electrical circuits, or hidden services.

Edits remain local to the panel until **Save documentation**. Saving uses one
editor undo transaction. Closing with unsaved changes offers **Keep editing** or
an explicit discard action. Switching floors, rooms, or steps keeps those edits.
Use the normal editor's save controls afterward to persist the drawing in Home
Assistant, or export project JSON for a portable copy.

## 3. Preview and download

Save documentation, select paper size, scale, floor and room scope, and whether to include
furniture, then choose **Generate drawing package**. Generation uses the accepted
editor snapshot. Review the sheet selector, measurement rules, warnings, and
schedule preview before downloading:

- **Printable HTML** contains the package for opening and printing in a browser.
  Use the browser's **Print → Save as PDF** when you need a PDF copy.
- **Selected SVG** contains one vector sheet.
- **Selected CSV** contains the complete room, opening, item, or material schedule.
  The readable in-panel table shows the first 50 rows. An optional raw CSV preview
  is also available; neither preview limit truncates the download.

Quantities are derived from authored geometry under the package's stated
measurement rules. Unknown or stale measurements remain qualified. Check the
sheet scope, units, openings, finish assignments, and waste allowances before
using a quantity. A ceiling view or wall elevation is a schematic, not a checked
construction document.

### How quantities are calculated

- Floor area is the area of the room polygon. Flat ceiling area uses the same
  footprint; it does not account for slopes, recesses, or soffits.
- Gross interior wall finish area is the room perimeter multiplied by the floor's
  height. Net area subtracts the union of openings matched to that room boundary,
  so overlapping deductions are not counted twice.
- A shared wall contributes one room-facing finish surface to each adjoining
  room. These are surface areas, not the volume of wall construction.
- Unmatched room boundaries are flagged as assumed wall faces. Walls or openings
  that cannot be matched to room boundaries are reported for review rather than
  silently treated as verified finish quantities.
- Waste is shown separately from the geometric quantity, together with the total
  including the chosen allowance. No reveals, skirting, or hidden services are
  inferred.

### Printing at the reported scale

Choose the paper size reported by the package, use landscape orientation, turn
browser headers and footers off, and print at **100% / actual size**. Do not use a
print-dialog fit-to-page option. Verify the **1 m scale bar** on the PDF or paper
before relying on a printed dimension.

**Fit to sheet** chooses one of the discrete supported drawing scales (1:50,
1:100, or 1:200); every sheet states the scale actually chosen. It does not permit
silent print scaling. If a drawing cannot fit, select fewer rooms, larger paper,
or a supported smaller drawing scale, then generate again.

Briefs and measurement notes stay in the editable project and are omitted from
the generated package, along with Home Assistant entity identifiers. These
private fields are also excluded from the package's reproducibility fingerprint;
the editor revision handles freshness separately. Review room names, item names,
dimensions, and finish specifications before sharing.

If the drawing changes while the panel is open, saving and downloads are blocked.
**Reload drawing and discard documentation edits** loads the latest snapshot;
generate the package again explicitly. Previously downloaded files remain
snapshots and do not update themselves.

## Editable metadata and compatibility

Documentation is optional project metadata under `documentation`, with
`schema_version: 1`. It contains the brief, measurement records and their geometry
snapshots, room finish assignments, and explicit ceiling-fixture references.
Ordinary drawings without this field remain valid. Metadata shares the project's
normal save, JSON export, and undo behavior; it does not change geometry.

Use an editor and compiler that support this metadata when exchanging a documented
project. Older strict project validators may reject the additional field. Keep
the original project JSON rather than discarding its documentation to work around
a version mismatch. Removed elements have their references pruned during an editor
transaction; changing geometry never refreshes a measurement record automatically.

## Implementation boundary

The panel is loaded on demand by the editor and uses its current theme. Its
stylesheet, preview object URLs, and downloads are local authoring resources;
the published viewer does not import this panel. `createDrawingPanel({ bridge,
translate })` returns `open`, `close`, and `dispose`. The bridge supplies snapshot,
revision, subscription, optional selection context, and
`applyDocumentation(documentation, expectedRevision)` for the single guarded
metadata transaction. Generation uses `buildDrawingPackage` from the accepted
snapshot, and closing the panel releases its subscription and object URLs.

The focused checks are:

```sh
node scripts/test-documentation-model.mjs
node scripts/test-drawing-package.mjs
node scripts/test-drawing-browser.cjs
```

The browser check uses the repository's configured browser test toolchain.

Dimensions and areas follow the drawn room boundaries. They do not automatically
subtract wall thickness or add hidden construction allowances.
