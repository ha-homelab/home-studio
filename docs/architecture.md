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

### Read-only lower-storey context

`geometry.floor_context()` bakes architectural surfaces, explicit `vehicles` meshes and true triangle-boundary edges into the optional `lower_floor_context` model metadata. It omits inventory, fixtures, device bindings, labels and source images. Coplanar face diagonals and duplicate edges are removed. The geometry is translated into the active floor's metric frame at compile time. `planner/project.py` selects the nearest strictly lower `elevation_m`, using a shared X/Z origin; the source meshes and standalone model exports are unchanged.

`buildLowerFloorContext()` creates one unlit surface batch and one line batch directly under the Three.js scene, outside the interactive root, inventory and lighting groups. Both are transparent, write no depth, cast no shadows and respect opaque active-floor depth. No extra pass, timer, light, texture, network request or frame loop is introduced. Home view enables the context only in Whole floor view when its toggle is on; room focus and the editor hide it. It never participates in camera bounds or device picking. Existing floors without context render exactly as before.

Validation: `python3 scripts/test-floor-context.py` checks geometry filtering, edge deduplication, elevation and compiler order independence. `node --test scripts/test-floor-context.cjs` checks the two inert render batches. Browser checks compare active-floor marker positions before and after toggling the layer and confirm idle rendering stops.


### Passive telemetry and power labels

Optional `model.telemetry` holds up to four read-only cards. Each descriptor has
`id`, `name`, `room`, `position_m`, optional `lower_floor`, and up to twelve `metrics`.
A metric supplies `label`, `entity_id` and `format` (`number`, `percent`, `pressure`,
`power` or `status`), with optional `decimals` (0–2) or status `labels`.
For power or energy totals, `entity_ids` replaces `entity_id`: all distinct sources
(up to eight) must be valid. Power normalizes W/kW to W and energy Wh/kWh to kWh.
Missing, restored, invalid-unit or negative unsigned inputs make the total unknown;
there is no partial total or double-counting of duplicate IDs. Do not combine a
site total with its constituent meters. `signed: true` permits signed power;
`flow: [positiveLabel, negativeLabel]` replaces the metric caption with the matching direction and displays an
in/out arrow with absolute magnitude; exact zero keeps its neutral label and `0 W`. Sum grid phases before choosing direction.
Optional `icon: solar|battery|grid` supplies static CSS symbols; a battery percentage
fills its icon from 0 to 100, and unknown readings clear and dim it. The host's
existing updates drive these DOM changes; no animation loop or polling is added.
Optional `wide: true` places a metric across both columns. `details` on an icon
metric supplies up to eight ordinary metric descriptors in a compact hover/focus
hint. The icon is a keyboard-focusable button (tap to focus on touch screens);
its accessible label includes the same readings. Hints use text content, reuse
state updates, clear on disconnect, and do not make requests or add timers.
Optional `requires` lists up to eight simple metric descriptors that must also
be usable, guarding derived sensors that default to zero when their inputs fail.
A site's voltage-derived SoC should bind its existing calibrated sensor, not
silently invent a voltage-to-charge curve in the shared renderer. Concrete
entity IDs remain in the site model, never in shared code. Generic planner exports
omit these optional bindings unless a site build explicitly supplies them.

`updateTelemetryPreviews()` consumes the existing normalized HA state messages.
It creates stable DOM nodes, updates their text, and never requests a measurement
or sends a command. Values are labelled as last reported, not real-time vehicle
measurements: many cars report tire pressure only when awake or driving. Missing,
unavailable, restored or disconnected readings display an em dash. Pressure is
converted from the declared psi/kPa/bar/Pa unit to PSI; unknown units are rejected.
Power accepts W/kW, and percentages require a valid 0–100 value with `%` units.

Cards use the media free-space allocator after TVs and cameras, but never create
leaders. No room or control is covered to make room for them. Lower-floor cards
follow the context toggle and disappear during upper-floor room focus. All cards
hide in the editor. Small screens may have no spare space; in that case cards are
hidden instead of shrinking the plan. No additional timer, polling, texture,
render loop or dependency is introduced.

Optional `model.power_labels` binds a sensor to an existing `object_id` with an
accessible `name`. Alternatively, supply a stable `id` and `room_ids` for a circuit
that supplies one or several rooms. Circuit watts are appended to the existing
room caption, with no separate badge, explanatory caption or additional node.
The first room receives the reading on the whole-floor view; focusing a member
room moves the reading into that room's existing caption. Each shared source
appears once. Several sources in one room remain separate readings, never an
invented total. Existing room buttons keep their focus behavior.

Up to twelve configured sources show W/kW readings. Zero, missing, restored and
disconnected values disappear while room names remain. Signed measurements
require explicit `signed: true` and keep their sign. Object readings continue to
follow saved objects, avoiding device/room controls and never intercepting clicks.
Do not add circuit totals to downstream smart-plug readings or duplicate the
same meter's total and phase channels. No extra polling or animation is needed.

`node --test scripts/test-media-preview.cjs` covers unit conversion, unknown data,
stable cards, visibility, absence of telemetry leaders, and zero/offline labels.


### Light indicator brightness

`resolveLightAppearance()` preserves HA RGB and normalized brightness separately
for scene lighting. For map buttons, `indicatorRGB` blends that RGB with the
inactive button surface in proportion to brightness. The bulb foreground is
chosen against the resulting fill, not against the undimmed lamp color. Button
fill, border and halo therefore distinguish dimmed lights from full output;
hover keeps the same brightness-aware fill. The controls list uses the same
indicator. Switch-only lamps without brightness retain full on/off behavior.
This is a UI intensity cue, not a claim about measured illuminance. It adds no
polling, render loop or GPU effect. Run `node --test scripts/test-light-state.cjs`
for brightness, color, missing-state and icon-contrast regressions.

### Read-only appliance status

Optional `model.appliance_status` entries bind an inventory object ID to its
`entity_id`, `room`, and `kind` (`smoke` or `cooktop`). Both the binding and room
must match before a reading can affect that object. Clicking an appliance opens
Home Assistant details; it never switches the appliance.

The smoke detector uses a cloud-and-wisps icon; the flame icon is reserved for
the cooktop. Smoke entries also name a `battery_entity_id`. A current binary `off` reading
shows green OK, `on` shows red SMOKE ALARM, and a valid 0–100 percent battery is
shown beside it. Missing, disconnected, or restored readings are neutral, never
an inferred all-clear. An entity name containing “motion” does not make a smoke
detector a motion source.

Cooktop entries provide up to eight `burners`, each `[x, y, z, radius]` in the
inventory asset's normalized local coordinates. A current binary `on` reading
shows a symbolic gas ring on those positions. This indicates aggregate cooktop
activity, not which individual burner is lit. An optional `oven_entity_id` uses
an independent `running` / `ready` / `paused` state; only `running` illuminates the
oven window. Temperature and job names do not imply active heating. The standard
oven window occupies local X ±0.38, Y 0.19–0.67, Z 0.501; +Z is the asset front.

The rings and window are small CSS/SVG overlays projected through the existing
orthographic camera. Rotation, scale, and placement use the object's world
transform. The window is hidden when its front faces away. No polling, animation
loop, extra WebGL pass, or shadow invalidation is added. CSS handles the subtle
flicker, reduced-motion settings disable it, and hidden pages or rooms stop the
overlays. Host state projection remains read-only and credentials stay outside
the viewer. `scripts/test-appliance-state.cjs` covers unavailable evidence,
remapping, battery edge cases, and independent cooktop/oven transitions.

### Held room presence

Optional `model.presence_sources` maps an inventory object ID to its reviewed
`entity_id` and `room`. For example, a stationary-presence sensor can cover a
whole room without providing a person's coordinates. Site metadata supplies
this mapping; the generic planner does not guess coverage from a device name.

`presence-view.js` accepts only connected, non-restored binary `on` or `off`
readings whose current inventory binding and room still match. An `on` reading
holds a small, fixed-size person badge beneath the existing room caption; it does not expire
because its state has not changed recently. A valid `off` fades the badge
over 15 seconds. Another `on` restores full intensity immediately. Missing,
unavailable, restored, disconnected, removed, or remapped sources withdraw the
overlay immediately. With multiple reviewed sources, any active source holds
the room; fading requires all of them to report `off`.

The 20-pixel SVG badge follows the existing room-label anchor and camera
projection. It leaves the room floor, furniture, and lighting untouched, and
does not block pointer events. A subtle outline and person glyph indicate
occupancy, not a person's measured location. CSS handles the release fade, with
no new polling, JavaScript timer, WebGL pass, shadow update, texture, or dependency.
Reduced motion disables the fade; unchanged projections avoid SVG writes.

Direct presence merges into the room caption and Activity inspector separately
from server-aggregated motion and signal estimates. Existing motion keeps its
label priority; a direct presence report can promote a signal-only room to
presence, while a quiet source cannot erase other evidence. The source marker
opens HA details and never calls a device service. It creates no footsteps,
person count, location, heart-rate value, or simulated heartbeat.

Run `node --test scripts/test-presence-view.cjs` for binding, disconnection,
held-state, aggregation, projection, and display-state checks. Validate a site's
coverage with its owner before adding its private mapping.
