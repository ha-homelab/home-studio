# Changelog

## [0.6.3] - Development line

- Fix the browser drawing tool's separate rendering path: combine rapid 2D
  drag/wheel and 3D orbit/wheel input into one frame, clone the project once per
  drag, and preserve exact movement, cancellation, and undo behavior.
- Bound the planner's 2D canvas to 4,000,000 pixels, and its 3D preview to
  2,000,000 pixels with a cached 2048-pixel sun shadow map. Positively identified
  software renderers use a 250,000-pixel preview and a 512-pixel sun shadow.
  Avoid buffer reallocations and shadow redraws on orbit; suspend hidden/lost
  preview drawing, restore the current size, and release discarded resources.
- Add a separate two-floor, 256-item planner regression in Firefox 157 and
  Chromium/SwiftShader. Three edit/preview cycles retained the geometry and
  stable live resource counts, coalesced wheel input, and recovered from context
  loss with 2D editing, JSON export, and the local draft intact. The software
  renderer still took 2.1 to 2.8 seconds for tested 2D gestures.
- Verify a limited planner smoke check in official Waterfox 6.7.6 with a clean
  temporary profile and native Apple M1 WebGL 2: load 256 items, drag furniture,
  open both floors, and orbit without recorded rendering errors or context loss.
  This does not cover the full Waterfox lifecycle suite, generated viewer, or
  the user's existing browser configuration; the reported crash cause remains
  unverified.
- In the generated viewer, limit shadow-casting point lights to eight for
  native/unidentified renderers and two for positively identified software
  renderers. Reserve four fragment texture units for other maps, preventing the
  reproduced eighteen-light
  Firefox shader sampler overflow. All fixtures retain illumination and room
  confinement; fixtures beyond the shadow budget do not cast occlusion shadows.
- Cap combined point-shadow atlases at 8,388,608 pixels and the canvas drawing
  buffer at 2,000,000 pixels with device pixel ratio at most two. Positively
  identified software renderers use a 250,000-pixel canvas, point-shadow faces
  up to 128 pixels, and a 512-pixel directional shadow map while retaining sharp
  HTML labels and full material lighting. Native/unidentified renderers keep
  point-shadow faces up to 512 pixels and a 2048-pixel directional map. Resize
  dimensions and pixel ratio together to avoid an oversized intermediate ratio
  update.
- Reuse Home camera fitting geometry, retain light shader slots across on/off
  changes, and avoid rebuilding an unchanged initial host inventory. Cache room
  transmission per lit room and recalculate light visibility after attenuation
  so exactly zero contributions avoid shadow lookups and direct
  surface-reflectance work.
- Combine rapid pointer and wheel input into one pending frame without an idle
  loop. Pause hidden/context-lost draws, restore the current viewport size after
  context recovery, and release renderer resources when the page is discarded.
- Add isolated generated-viewer stability coverage with a fictional multi-room,
  multi-light home and document the evidence required for browser acceptance.
  Firefox 157 and Chromium/SwiftShader on macOS passed the final eighteen-light
  regression, including stable shader counts across light state changes,
  context restoration after resizing, and two iframe load cycles. Software
  startup still took 6.6 to 8.2 seconds in this fixture. The generated viewer
  was not tested in Waterfox.
- Include the rounded translucent walls introduced after the previous stable
  release: preserve opening dimensions and exact shadow blockers, cache bounded
  geometry variants, and advance the subtle tint only on requested frames.

### Upgrade

Rebuild generated viewers from the selected candidate to receive viewer changes.
The browser drawing tool is a separate application: use the updated hosted
planner after its GitHub Pages deployment, or serve the selected candidate's
source directory locally and open `/planner/`. Export project JSON before
switching between hosted and local origins, which keep separate browser drafts.
Back up project JSON and Home Assistant configuration, keep private files outside
the public source archive, and run the installer dry-run before replacing an
installed component. Existing project identifiers and device bindings remain
compatible. Beta and RC packages require target-browser acceptance before
production use; publication does not update an installed home automatically.

### Security

Browser regressions use fictional projects; the generated-viewer fixture uses
a disconnected message bridge. They issue no physical-device commands.
The public package retains its reviewed
file allowlist. This release does not claim a security vulnerability fix or
change the Home Assistant authentication boundary.

## [0.6.2] - Development line

- Recognize expected project validation failures during fuzzing while retaining
  unexpected exceptions as failures. Replay the invalid-title regression in CI.
- Extend offline RC campaigns to furniture catalog choices and rotated bounds,
  checked against an independent analytic geometry oracle. Replay committed
  positive and negative examples in ordinary CI without timed mutations.
- Update the shared RC runner to retain source-bound execution metrics and
  deterministic preflight evidence with the candidate.

- Add 45 original designs for rugs, tapestries, mirrors, chandeliers, bulbs,
  sconces, floor lamps, balustrades, plants, and life-size display bears:
  149 designs in 20 categories. Keep existing model identifiers compatible.
- Add a 24-triangle cone shared by the editor and compiler for tapered tree
  crowns and light fixtures, with geometry, normals, and export parity checks.
- Explain floor, wall, and ceiling placement in the illustrated guide and add
  an editable fictional decorated studio tested through the real installer.

- Expand the library to 104 designs and 16 categories, including electronics,
  plush toys, music and art equipment, cars, motorcycles, bicycles, sports gear,
  dishes, solar panels, and outdoor furniture. Add six finishes (ten total).
- Add matching browser/compiler spheres, hollow rings, and per-part rotations
  with validated bounds, normals, and export parity.
- Load library cards in sets of 24, bound thumbnail memory, and preserve
  keyboard navigation while loading more designs.
- Add an editable fictional garage/studio example and a full-library install
  regression. Keep existing project data and installer limits compatible.

- Add searchable furniture and accessory designs, coordinated finishes, custom
  body colors, and editable dimensions and rotation.
- Preserve furniture appearance from the browser drawing through 3D exports and
  the installed Home Assistant plan, including placement edits after a rebuild.
- Keep rugs below taller furniture in 2D, avoid duplicate runtime geometry, and
  validate a full 256-item floor through the real installer.
- Extend the illustrated drawing guide and add browser-to-install regression
  coverage using fictional projects only.

### Upgrade

Keep personal project files and Home Assistant configuration backed up and
separate from the public source archive. Existing project identifiers remain
compatible. Use the documented installer dry-run before replacing an installed
component, and test the selected candidate with your own project copy.

### Security

The expanded campaigns use synthetic projects with bounded offline execution.
They exercise project rejection and furniture geometry without accessing a live
Home Assistant instance. Household plans, credentials and private device bindings
remain outside the public package and corpus.

## [0.6.1] - Development line

- Add bounded, offline RC-only Jazzer.js campaigns for imported project validation and wall/polygon geometry.
- Publish deterministic public source ZIPs with embedded versions, checksums and source-bound evidence.
- Preserve existing GitHub Pages publishing and private project exclusions.

### Upgrade

Unpack the public source ZIP into a new directory and keep personal project
files separate. The editor/compiler interfaces and existing Pages deployment
remain unchanged. Back up your Home Assistant configuration and use the
documented installer dry-run before replacing an installed component.

### Security

Offline RC fuzzing validates synthetic project inputs and geometry, with
network isolation and bounded resource use. The source archive is built only
from the reviewed public allowlist. Real household plans, private device
bindings and credentials must stay outside the repository and public corpus.
