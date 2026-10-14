# Changelog

## Unreleased

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
