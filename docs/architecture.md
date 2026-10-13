# Shared code and private homes

Home studio has a public drawing and installation pipeline. A private household
project can use the same code while keeping its measurements, photos, device
bindings, deployment details, and specialized adapters outside the public repo.

## From drawing to installed panel

1. **Browser editor:** `planner/index.html`, `editor.js`, and `model.js` edit a
   versioned metric project. The draft stays in browser storage. Exporting JSON
   makes a portable source file; the browser does not contact Home Assistant.
2. **Local compiler:** `scripts/build-planner-project.py` calls
   `planner/project.py`. It validates the source, generates floor geometry and
   self-contained viewers, and writes model exports. `--ha-package` also creates
   `home-floorplan.tar.gz` from reviewed integration files and the new assets.
   Python 3.10+ and the standard library are enough for this build.
3. **Local installer:** `scripts/install-home-assistant.py` validates the archive
   and stages its files before replacing a component directory. Its only target
   is `custom_components/home_floorplan` inside the explicitly supplied config
   directory. An update needs `--replace`; previous files are retained outside
   `custom_components` in `.home-studio-backups`. It does not edit YAML, contact
   an HA endpoint, copy a token, or start or stop a running service.
4. **Home Assistant integration:** the installed backend loads the project's
   `site.json` and floor assets. The generic `static/panel.js` uses Home
   Assistant's authenticated connection to display **3D Home** to administrators.
   Private floor assets are delivered through authenticated backend commands.

The [installation guide](https://ha-homelab.github.io/home-studio/install.html)
covers the commands, manual YAML entry, restart, and Home Assistant OS file
transfer. Installation is a local file operation, not a hosted wizard or HACS
installation flow.

## Public core

The public integration includes `__init__.py`, `site.py`, `validation.py`,
`curtains.py`, `manifest.json`, and `static/panel.js`. The compiler supplies the
site manifest, floor assets, and empty generic adapter configuration. Normal
packages declare `site_features: false` and a stable project `site_id`.

The core handles administrator access, floor selection, validated placement
saves, model downloads, and supported entity controls. It uses the current HA
session; there is no separate account, automatic SSO setup, or browser token
entry. Linking a TV or sensor places that entity in the plan, but does not add a
household's specialized TV capture, camera routing, or RF sensing behavior.

The floor viewer runs in a restricted iframe. The host and viewer communicate
through a dedicated message channel. The host checks saved entity bindings and
allowed actions before a user-initiated device command. The public static panel
script does not need a floorplan, photos, or credentials embedded in it.

## Optional private extensions

A private deployment can supply `private_site_config.py` with its site metadata
and `private_site.py` with its setup and adapter behavior, plus its own required
modules and configuration. Those files are not distributed by the generic
compiler. A private package must carry matching `site.json` metadata and all its
dependencies; changing a boolean does not create the missing implementation.

The backend recognizes private site features only through that separately
supplied private configuration. The installer additionally requires the explicit
`--allow-site-features` flag for a package declaring `site_features: true`. Archive
path, size, file-type, manifest, and backup checks still apply. A private legacy
deployment can retain `site_id: null` and its existing storage key.

Treat the public repository as the shared dependency: select a reviewed revision,
use its compiler and installer, and assemble local extras in the private project.
Submit generic fixes upstream without copying private inputs or Git history.
Keep a private record of the public revision used for each deployment so an
update can be reproduced. The public package does not automatically fetch or
update private adapters.

## Storage and rebuilds

The browser draft and HA placements are separate stores. Exported project JSON
is the editable geometry source; generated output folders are replaceable build
artifacts. Keep source files outside those output folders.

In Home Assistant, generic placements use a site-specific key under `.storage`.
Keep the project ID stable to retain that association; give a different home a
different ID. Each floor's revision protects saved placements against stale
writes. Saved layouts that no longer match rebuilt rooms require explicit
recovery instead of silently activating incompatible bindings.

The installer never rewrites `.storage`. Its retained component backup contains
the prior integration code and generated assets, not a complete snapshot of HA
or all saved placements. Back up Home Assistant before an update, stop Core
before replacing an existing component, and retain the printed backup path.
Directory replacement uses staged files and atomic renames with rollback on
ordinary failures. It is not a power-loss transaction; avoid concurrent edits to
the installation directory.

## Repository versus hosted website

The public GitHub repository and its complete ZIP contain the compiler,
integration, installer, tests, and website. GitHub Pages receives a smaller,
explicit allowlist containing only the editor, tutorial, and installation pages.
Python code is run locally after download; it is not executed by the website.

Publication checks verify that the selected files exist, reject symlinks and
common private-data patterns, and validate local links and browser imports.
Review source, examples, and image pixels as well. Never add real household
exports, backups, credentials, or photos merely to make a public build pass.

The shared code is [MIT licensed](../LICENSE). Preserve the bundled
[Three.js notices](../vendor/THREE-LICENSE.txt) when redistributing it.

Optional module diagnostics carry their original `module_expires_at_ms`, `module_snapshot_at_ms` and `module_fresh_count` alongside bounded text. The host forwards these values only for explicitly configured sensors. The viewer rejects missing or invalid metadata, expires text at the original deadline (at most two seconds after its source snapshot), and prevents repeated states or a backward wall clock from renewing it. Room activity is independent of this display-only data.

## Translucent walls and boundary outlines

Walls use a 16% opaque, single-pass, double-sided fill with depth writing disabled.
Their original opaque shadow geometry and room-light masks remain intact: visual
transparency does not let lights leak between rooms. The geometry exports are
unchanged.

`wallBoundarySegments` derives blue base contours and brighter cyan top contours
from wall geometry at the visible cutaway height, or at full height in the editor.
Hidden lintels produce neither contour. Horizontal face diagonals are excluded,
and coincident segments are deduplicated. Each color uses a batched line and a
narrow translucent band: four draw objects in total, replacing the earlier
per-wall edge objects. The group draws after wall fills with depth testing still
enabled, so opaque furniture hides the lines naturally. It needs no bloom, new
light, dependency, network request or animation.

Rebuilds happen only when the clipping height changes, disposing old GPU resources.
Run `node scripts/test-wall-tops.cjs` to check top and base boundaries for rotated
walls, raised bases, both cutaway heights, low walls and doorway gaps.

Home view cuts walls at 2.1 m, at the standard window-head elevation, so both
window jambs and the upper frame remain visible. Blue-grey structural frames
with a low emissive contribution stay legible in unlit rooms. The editor retains
its separate 1.15 m cutaway toggle; exported dimensions remain unchanged.

### Passive iridescent wall fill

`applyWallSheen` in `room-lighting.js` adds a teal-to-blue tint with a subtle
violet edge to the existing wall material. The palette depends on viewing angle
and a broad spatial band, computed per vertex and interpolated across each face.
Fragments only blend that color into diffuse and emissive terms. Perspective
views use the eye-to-vertex direction; orthographic views use a constant viewing
direction, so panning does not make the tint swim across a flat wall.

This is view-dependent iridescence, not time animation: a stationary plan stays
stationary, including with reduced-motion preferences. It adds no frame loop,
timer, texture, geometry, light, render pass or network request. There is a small
amount of extra shader arithmetic during already-requested frames. Wall opacity,
blue base contours, cyan top contours, clipping and shadow occlusion are retained.
The patch runs both on initial material compilation and when room lighting is
attached; wall and non-wall shader cache keys remain distinct in Home and editor
modes. `node scripts/test-wall-sheen.cjs` checks that composition against the
vendored Three.js shader. Browser checks should also compare idle render counts,
draw calls and texture/geometry counts with the same scene before and after.

## TV frame refresh failures

The optional TV adapter may send a JPEG after each one-minute capture attempt.
The host distinguishes an explicit `null` image (clear the playback session)
from an absent image after a transport failure (retain the current picture).
The viewer keeps the last successfully decoded texture while a replacement
decodes, and also if that decode fails. It only disposes that texture after a
successful replacement or an explicit lifecycle clear. No independent expiry
blanks the television after a missed refresh. Off/restored state, changed source,
disconnected HA, hidden document, changed bindings and rebuilt meshes retain
their existing invalidation behavior. Hover previews reuse the same texture.

Adapters should return the original capture timestamp with a retained image,
not stamp a failed refresh as new footage. Frames remain memory-only and are
never included in saved inventory or exports. The renderer tests exercise
replacement disposal, failure retention, late decode races and per-TV isolation:
`node --test scripts/test-tv-screen.cjs`.

## Linked TV and camera previews

`media-preview.js` places small TV/camera cards only in unused screen space and
links them to projected device positions with bright blue dashed SVG segments.
Connections use horizontal/vertical runs and square 90-degree turns. The SVG
ignores pointer input. No rail, stage resize, camera offset or zoom adjustment is
introduced when media appears. If a card cannot fit, it stays hidden; the device
and its ordinary controls/TV hover preview remain accessible.

Placement conservatively excludes projected bounds of visible architecture and
furniture, plus device/room buttons and previously placed cards. World bounds are
cached per object and placement is recomputed only when the view, card dimensions,
source positions or rebuilt inventory change. The 24-pixel candidate grid favors
short connections. Conservative bounds may omit a card even when a small visible
gap exists; they never deliberately cover a room to display media.

TV cards reuse the last decoded frame from `tv-screen.js`, including its existing
failure-retention rules. An explicitly off TV shows a compact power control.
Unavailable, disconnected and missing states are not presented as off. The card
title opens the full Home Assistant entity controls. Power sends an explicit
`tv_power` request with `turn_on` or `turn_off`: the host accepts only saved
`media_player` entities in available power states, serializes commands, and
returns the existing command result. Confirmed HA state drives the display; a
successful service call does not itself prove that the TV changed state.

The public package supplies cards, controls and leaders. Actual images still
require a site's optional TV or notification-frame adapter. No adapter, private
entity identifier, screenshot, camera stream or credential is bundled here.
Camera previews retain the existing five-second frame lease and event dismissal;
expiry/dismissal removes the leader and releases its screen space. Cards do not request
additional captures, poll, animate the dash pattern, create textures or start a
render loop. They add bounded DOM/SVG work only on existing updates.

`node --test scripts/test-media-preview.cjs` checks frame reuse, power states,
room filtering, source anchors, dismissal, and the host command boundary.
