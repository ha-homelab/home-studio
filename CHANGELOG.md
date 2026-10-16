# Changelog

## [0.6.4] - Development line

- Bound the existing Apple diffuse viewer to 62,500 resting and 31,250 motion
  pixels, including its measured masked-Apple selection. This
  trades canvas detail for less raster work; HTML controls retain their normal
  resolution. Antialiasing, one-context lifecycle, geometry, lights, shadows,
  other profiles and acceptance limits are unchanged. This is a software-renderer
  fallback; it does not reduce the hardware-rendered viewer's resolution.

- Hide the separate authoring backdrop plane in the existing Apple diffuse
  Editor profile, including measured masked-Apple selection. Keep the grid,
  real floors, furniture and outlines. Home and other profiles retain their
  existing visibility; antialiasing, context lifecycle, drawing-buffer budgets
  and acceptance limits are unchanged. This intentionally removes the flat
  background surface; it is not a pixel-parity claim.

- Retry a failed acceptance-artifact upload once with the same completed files.
  The fallback replaces an ambiguous same-name upload, logs a warning and still
  fails if transport fails again. Browser cases, outcomes and deadlines do not
  change; earlier runs with missing artifacts remain unqualified.

- Give the complete Playwright viewer scenario a uniform 180-second aggregate
  budget, including both fresh loads and the three post-restoration modes.
  Keep the 30-second bootstrap, 60-second cold loads, 15-second drags and
  10-second Editor settling limits, with no retries. Require explicit completion
  of both detached viewers and every restored view before final identity and
  cleanup can pass; the total hard process envelope is 245 seconds. This is a
  prospective change from 120 seconds, not a runtime improvement. R29 and all
  earlier failures retain their original results.

- Allow up to 60 seconds for Safari's initial WebDriver session request,
  within the existing 180-second browser watchdog. Record startup timing and
  reject late completion without retrying. Subsequent command timeouts and
  application checks are unchanged; earlier startup failures remain failures.

- Bound browser-tool installation to 12 minutes inside a 30-minute package
  validation job, allowing slow operating-system package mirrors while retaining
  required dependencies and every check. Browser bootstrap, scenario, load,
  interaction and recovery deadlines remain unchanged; previously cancelled
  package runs receive no pass credit.

- Pace expensive Apple software motion draws using a bounded 64–250 ms
  per-gesture delay. Input continues to update the camera, and pointer release
  requests the ordinary full-quality frame. Other graphics profiles and all
  acceptance deadlines remain unchanged.

- Keep the desktop viewer Editor stage within the available grid height.
  Its minimum height no longer follows the drawing buffer's intrinsic aspect
  ratio, preventing canvas size changes from expanding the page. The mobile
  stage minimum, error
  messages, drawing-buffer budgets and acceptance deadlines are unchanged.

- Cap the Apple diffuse viewer at 125,000 drawing-buffer pixels
  instead of 250,000, including its measured masked-Apple selection. Home and
  Editor canvas detail becomes softer; HTML controls retain their resolution.
  Geometry, lights, shadows, the 62,500-pixel motion target, other renderers,
  planner and acceptance deadlines are unchanged. Local paired checks retain
  readable controls and room boundaries; hosted acceptance remains required.

- Give each cold viewer creation one aggregate 60-second readiness budget,
  including fetch, frame selection and the first fully connected lit frame.
  Apply it uniformly across browsers and both creation cycles, bounded by the
  then-existing 120-second Playwright or 180-second native scenario watchdog
  (the Playwright aggregate is subsequently aligned above).
  Record monotonic load timing and reject late completion. This prospective
  compatibility allowance can accept slower software-rendered startup; it is
  not a speed improvement. Planner, interaction and recovery limits are unchanged.

- Repaint Home and Editor mode changes even when a queued resize finds the
  previous dimensions already cached. Reuse the pending frame scheduler and
  skip the extra request if a resize or intervening draw has already painted
  the new mode, including rapid cutaway/full-height/Home transitions after
  context recovery. Rendering quality and browser acceptance limits are unchanged.

- Release viewer geometry GPU associations while a WebGL context is lost,
  including hidden objects and inactive rounded-wall variants. Preserve CPU
  geometry for upload after restoration. Release owned shadow targets and TV
  texture associations at the same point, preserving their images and object
  identities for reupload. This prevents later cutaway, shadow and TV updates
  from invoking obsolete GPU disposal callbacks. Browser cases also check
  Editor cutaway/full-height and Home transitions after context restoration,
  within their unchanged scenario deadlines.

- Use constant-tint floors and authoring background in the existing Apple
  diffuse Editor profile. Supported opaque floors keep geometry, clipping and
  shadow casting, but receive no Editor lighting or shadows. Home restores the
  exact original lit material objects; furniture, outlines, other profiles and
  acceptance limits are unchanged. Retain one lazy Basic material per eligible
  mesh and release both active and dormant GPU associations on context loss.
  This is a visual tradeoff requiring evaluation, not a pixel-parity claim.

- Use an unlit architectural wall fill in the existing Apple software
  diffuse fallback, including its measured masked-Apple selection. Walls retain
  their teal tint, opacity, cutaway geometry, outlines and shadow casting, but
  no longer receive lighting, shadows, daylight or animated/view sheen. This
  deliberate visual tradeoff also applies in the Editor. Lights and other
  rendering profiles are unchanged. Qualify each revision with the
  complete required hosted matrix; local comparisons do not establish
  cross-browser performance or pixel parity.

- Separate Playwright browser bootstrap into one aggregate 30-second budget,
  then start the then-existing 120-second viewer or 180-second planner scenario
  budget immediately before application work. Keep all per-step checks, cleanup
  limits and assertions, including final identity, and reject late setup or
  callback completion. Record both scopes and their measured durations. This
  prospective contract adds at most 30 seconds to allowed wall time; it is not
  a runtime speedup and does not reclassify previous failures. Native Gecko and
  Safari timing is unchanged.

- Express eligible packed Lambert lighting with local vectors and scalars,
  preserving the pinned point, directional, shadow and indirect-light operation
  order. Independent source and material guards retain the existing paths when
  a rewrite is unsupported. These changes add no resources or quality reductions;
  browser qualification still uses the documented limits and complete matrix.

- Require native Linux, Windows and macOS package/install acceptance and an
  expanded browser matrix for pull requests and releases. Keep browser families,
  pinned historical builds, release channels and emulated touch profiles
  explicit in the retained evidence rather than treating them as interchangeable.
- Add native Firefox Stable/ESR and Safari acceptance alongside Waterfox, using
  official browser binaries and supported browser automation protocols. Browser
  identity, source revision, rendering errors and cleanup remain release gates.
- Fix WebKit preview recovery by releasing geometry and shadow resources while
  the graphics context is lost, then retiring that context and rebuilding on a
  fresh canvas. Preserve edits, camera orientation, zoom, keyboard focus and JSON
  export without retaining old input handlers or GPU resources. Refresh the
  actual canvas layout before allocating the replacement drawing buffer,
  including when a resize notification is still pending. Release the lost
  canvas's backing size so its retired context does not allocate another
  full-size buffer during restoration.
- Reuse immutable furniture-part geometry within each preview rebuild. Keep
  every mesh, material, transform and shadow while disposing shared geometry
  exactly once; do not carry GPU resources across rebuilds or context recovery.
- Batch disjoint furniture parts on the identified Apple Software Renderer to
  reduce draw calls. Keep overlapping objects in their original rendering order
  and bound the overlap search. Other paths retain normal meshes unless the
  narrowly scoped masked-Apple capacity check selects the same reduced profile;
  additional instanced shaders can add first-use compilation work.
- Use simpler diffuse materials and unfiltered shadows on the legacy Apple
  software rasterizer, retaining every linked light, room boundary, transparent
  surface and control. Native GPU materials remain unchanged unless a measured
  slow raster path selects this profile behind Gecko's opaque Apple label. The
  one-time check uses five tiny draws on the existing context, validates pixel
  readback, and restores every changed graphics state.
- Set direct touch manipulation on viewer controls while retaining page pinch
  zoom. Keep native touch interaction checks separate from mouse acceptance.
- Coalesce live entity updates into scheduled frames and reuse unchanged host
  inventory. Readiness checks now wait for a completed frame with the expected
  light state rather than accepting an updated state that has not been drawn.
  Avoid a second identical frame when a resize already repaints a restored or
  resumed viewer; keep pending live updates and back-forward cache recovery.
- Bound pointer-motion rendering on the legacy diffuse profile to 62,500
  pixels, copying the result into the unchanged canvas. Pointer release,
  cancellation and context recovery restore a full-resolution scene frame.
  Keep lights, geometry, shadows and sharp HTML controls; include the copy pass
  in real draw counts and dispose its resources with the graphics context.
  Draw the first moved-pointer frame immediately, then combine subsequent
  software camera motion within a fixed 64 ms window. Physically based software
  rendering uses the same scheduling with its original full-resolution direct
  draws. Release, cancellation, resizing and live updates bypass the delay;
  hidden or lost contexts cancel it. Hardware frame scheduling is unchanged.
- Reduce room-lighting shader compilation and fragment work while preserving
  light order, every illuminated fixture and nonzero light through doorways.
  The diffuse profile uses packed room geometry with a conservative uniform
  budget and computes transmission per light run instead of indexing a local
  fragment array; larger plans or lower limits retain the original shader path.
  Skip absent daylight topology and polygon-distance work outside its full
  spatial reach, retaining the same window and exterior lighting.
  Fixed building geometry skips light runs with a provably zero contribution;
  movable and unsupported geometry retain all runs in their original order.
  Exact axis-aligned rectangles use a box-distance calculation after coordinate
  quantization; other room shapes keep their polygon calculation.
  Static opaque floors share the diffuse frame shader through a nonintersecting
  clipping plane, reducing shader variants while retaining floor and shadow
  geometry, cutaway behavior and drawing resolution.
  Visit only window-owning rooms for packed daylight, retaining room/window
  order and accounting for the new index array in the uniform budget. Share
  eligible static wall, floor and frame programs through a private wall-tint
  switch while preserving their actual blending, culling and depth state.
- Share that diffuse program with eligible static window glass while retaining
  both ordered alpha passes. Private facing uniforms and early fragment discard
  replace hardware face culling, preserving visible faces, vertex normals and
  shadow normal bias, including mirrored transforms. Keep the original geometry,
  cutaway plane and depth state; release owned material programs at context loss
  and include the extra uniform in the conservative capacity guard. Other
  rendering profiles and unsupported glass retain their original path. Local
  startup improved, but interaction results varied; full browser acceptance
  remains required.
- Skip the packed point-light calculation when all visible, known-room lights
  have exactly zero intensity and valid finite inputs. Keep every light,
  shadow and shader family, and refresh the shared guard at each Home draw
  boundary. Ambient, sun and daylight remain unchanged; unknown rooms or
  malformed inputs retain the original calculation.
- Upload each packed light run as one integer vector, preserving light order,
  room boundaries, shadow indices and the conservative uniform budget. Avoid
  separate dynamic start/end/room lookups without changing rendered contents.
- Share the packed diffuse program with factory-created fallback boxes. Keep
  their original geometry, live color, shadows and front-face picking; only
  owned, eligible materials participate, and unsupported or externally changed
  materials retain their original path. This removes another cold shader family
  in both the Home view and editor without changing drawing resolution.
- Reuse the pure room-transmission result within each packed shadowed light.
  Preserve attenuation, shadow and light order, and all unshadowed calculations;
  the change adds no texture, uniform or rendering pass.
- Use three bounded Float32 data textures for eligible packed software-renderer
  inputs, with an independently guarded constant-two point attenuation helper.
  Preserve ordered lighting and shadows, exact input validation, and the original
  uniform and editor fallback paths. No hosted Intel speedup is claimed.
- Reuse planner outlines and selection controls, and avoid redrawing unchanged
  snapped positions. Preserve exact furniture overlap, appearance, undo and drag
  cancellation. Bound software-renderer resolution without reducing sharp HTML
  controls or treating a 2D fallback as a successful 3D test.
- Retry only interrupted browser downloads, with three bounded attempts and
  retained logs. Certificate, signature, installation and acceptance failures
  remain failures; test execution is never automatically retried.
- Fix portable package metadata, Unicode paths and Windows installer path checks.
  Preserve backups, rollback and files belonging to other Home Assistant features.

### Upgrade

Export project JSON before changing planner origins and keep a Home Assistant
configuration backup. Rebuild and reinstall an existing generated viewer with
this version to receive its rendering changes; publishing a release does not
update a private home automatically. Project identifiers and entity bindings
remain compatible.
Follow the [installation and update guide](https://ha-homelab.github.io/home-studio/install.html),
including the installer dry-run before replacing an installed component.

### Coverage

See [platform acceptance](docs/platform-acceptance.md) for the exact mandatory
matrix and [browser compatibility](docs/browser-compatibility.md) for limits.
Hosted graphics backends and emulated mobile viewports do not certify every GPU,
extension, device, Safari version, Android WebView or physical mobile browser.

### Security

All automated fixtures use fictional homes and send no live device commands.
Keep household plans, credentials and device bindings out of public bug reports
and source archives. This release does not change Home Assistant's authentication
boundary or claim to fix a security vulnerability.

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
