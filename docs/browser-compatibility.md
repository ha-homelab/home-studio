# Browser compatibility and rendering acceptance

Home Studio has two separate browser rendering paths. The hosted drawing tool
at `/planner/` runs `planner/editor.js`, with a 2D canvas and its own 3D preview.
The compiler creates a separate viewer from `viewer.js` and the Home view
modules, for local preview or installation in Home Assistant. Testing or fixing
one path does not establish that the other works.

Both 3D paths use the vendored Three.js r169 renderer and require WebGL 2.
A browser name or user-agent string is not a capability test:
graphics drivers, hardware acceleration, browser settings, and the size of the
loaded project also matter. The planner's 2D drawing and JSON export remain the
recovery path when its 3D preview cannot start.

## Evidence and limits

The public repository's [cross-platform acceptance](platform-acceptance.md)
runs both browser paths on Linux, Windows, and macOS for every PR and release
validation. Its artifacts record each tested environment; the dated local
measurements below remain separate evidence, not results for every CI host.

The package workflow includes real Chromium browser checks for drawing,
furnishing, installation, localization, and the installed viewer. The isolated
browser stability fixture additionally exercises a generated, fictional six-room
home with eighteen linked lights. It uses a sandboxed iframe and a MessageChannel
to reproduce the panel boundary without connecting to Home Assistant.

### Browser planner

On 2026-10-15, the separate planner regression completed three edit/preview
cycles on macOS arm64 with two fictional floors, sixteen rooms, and 256 catalog
items, at a 1440 by 1000 viewport and device scale 2. The first preview opened
the active floor's 128 items, then enabled all floors; later previews retained
all 256 items.

- Playwright Firefox 157.0, WebGL 2 with reported renderer `Apple M1, or similar`:
  drawing a room and wall took 138 and 143 ms. Item moves took 126 to 135 ms,
  preview opening 147 to 156 ms, and orbit gestures 122 to 129 ms. Enabling all
  floors took 175 ms. The preview buffer was 1505 by 1328 pixels, with a 2048 by
  2048 sun shadow map.
- Playwright Chromium 156.0.8078.4, WebGL 2 through ANGLE/SwiftShader: drawing a
  room and wall took 2,083 and 2,305 ms. Item moves took 2,247 to 2,774 ms,
  preview opening 455 to 495 ms, and orbit gestures 780 to 803 ms. Enabling all
  floors took 600 ms. The preview buffer was 532 by 469 pixels, with a 512 by
  512 sun shadow map.

These are end-to-end test-operation times, including input dispatch and frame
waits. The software-rendered 2D gestures still took 2.1 to 2.8 seconds; passing
the regression does not make that interaction smooth. Both engines retained
all items, used one WebGL context, and kept live resource counts at 2,077
geometries, one texture, and four programs after each all-floor rebuild.
Rebuilds can compile replacement programs; the cumulative link count is not
the live program count. Forty-event wheel bursts produced one draw and no
synchronous draws in both 2D and 3D. Orbiting did not resize the drawing buffer,
and the idle or closed preview stopped drawing.

Both runs reported no browser crash, uncaught page error, shader-link error, or
external request. Intentional context loss left 2D editing and JSON export
usable; resizing and restoring recovered the preview, and reloading preserved
the local draft. Deterministic handler tests separately cover hidden-page and
back/forward-cache suspension, discard cleanup, shadow invalidation, drag
cancellation, undo/redo, and rejected moves. These results do not identify the
cause of the reported Waterfox crash.

### Waterfox planner smoke check

A separate smoke check on 2026-10-15 used the official Waterfox 6.7.6 macOS
application, reporting Gecko 153.5.0 and build `20261013130543`, with a temporary
clean profile. It ran headless through direct Marionette and W3C pointer
actions, without Playwright patches, on WebGL 2 with reported renderer
`Apple M1, or similar` and device scale 1.

The same 256-item planner fixture loaded from its local draft in 52 ms. A real
pointer drag moved a furniture item's X coordinate from 1 to 1.5 metres in
287 ms; opening the two-floor preview took 367 ms, and pointer orbit took
303 ms. All 256 items remained in the preview, with no recorded rendering
errors or context losses. The buffer was 870 by 730 pixels, with a 2048 by 2048
sun shadow map. The gestures used twelve pointer steps of 16 ms each, so these
times are not directly comparable to the Playwright runs at device scale 2.

This earlier measurement was a single planner smoke check. It did not exercise Waterfox's full
context-loss/lifecycle suite, the generated Home Assistant viewer, or the
user's existing profile and configuration. It does not reproduce or establish
the cause of the reported crash, or certify long-running Waterfox stability.

### Generated viewer

On 2026-10-15, the baseline viewer exceeded Firefox's fragment-sampler limit with
this eighteen-light fixture: the program required nineteen samplers on a WebGL 2
context reporting a limit of sixteen. This reproduced a shader-link failure,
not a browser-process crash. The baseline also drew synchronously forty times
for a burst of forty wheel events.

The final repair completed two iframe load cycles of the same eighteen-light
fixture in a serial run on macOS 26.7.1 arm64, at a 1280 by 800 viewport and
device scale 1:

- Playwright Firefox 157.0, WebGL 2, reported renderer `Apple M1, or similar`,
  sixteen fragment texture units: load times were 1,208 and 312 ms, Home drag
  checks 127 and 129 ms, and editor orbit checks 111 and 111 ms. The Home canvas
  measured 920 by 674 drawing pixels with pixel ratio 1. Eight point-shadow maps
  used 256-pixel faces, and the directional shadow map was 2048 by 2048.
- Playwright Chromium 156.0.8078.4, WebGL 2 through ANGLE/SwiftShader, thirty-two
  fragment texture units: load times were 8,170 and 6,592 ms, Home drag checks
  429 and 363 ms, and editor orbit checks 1,241 and 1,073 ms. The detected
  software profile used 584 by 427 drawing pixels (249,368 total), with pixel
  ratio approximately 0.635, two point-shadow maps with 128-pixel faces, and a
  512 by 512 directional shadow map.

Both runs retained all eighteen active lights, observed no page errors,
shader-link errors, browser crashes, or unexpected context losses, and drew once
per forty-event wheel burst with zero synchronous draws. The linked-program
count remained at 23 through all-off, partial-on, and all-on state changes. The
intentional context-loss test paused drawing, changed the viewport while lost,
and resumed with the new size after restoration. Screenshots were captured only
after the latency checks. Software startup still took 6.6 to 8.2 seconds in this
fixture; this is not a claim of instant loading on CPU renderers. Timings include
first-use work and are not steady-state frame-time percentiles or a long-running
stability certification. These particular measurements did not include the
generated viewer in Waterfox. The later native version suite covers both
generated viewers and planner recovery; see [cross-platform acceptance](platform-acceptance.md).

Passing a Playwright Firefox run is evidence for that bundled Firefox build,
operating system, and graphics backend. It does not certify Waterfox. Likewise,
Chromium with SwiftShader exercises software WebGL rather than physical GPU
performance. Safari and mobile browsers still need their own target-browser
acceptance runs. Read the native Waterfox job's own version, platform, graphics
backend, and outcome when assessing the expanded coverage. Neither these
earlier measurements nor a hosted CI result certifies every user's environment.

No exact cause of a reported Waterfox browser crash has been established by the
code changes alone. A render timeout, shader error, context loss, browser-process
crash, and Home Assistant connection failure are distinct observations; retain
the actual failure and environment when reporting a regression.

## Browser planner rendering bounds

The drawing tool combines rapid 2D drag/wheel input and 3D orbit/wheel input
into one pending animation frame, without an idle rendering loop. Moving a
shape or item clones the project once per gesture and derives each position
from its original coordinates; cancelling and undoing preserve the original
project.

The 2D drawing buffer is capped at 4,000,000 pixels and device pixel ratio 2.
It releases the old bitmap before applying a new orientation, avoiding an
oversized intermediate buffer. The separate 3D preview uses at most 2,000,000
pixels and device pixel ratio 2, with a 2048 by 2048 sun shadow map. Positively
identified software renderers use at most 250,000 drawing pixels and a 512 by
512 sun shadow map. Native and unidentified renderers retain the normal
profile. HTML controls retain their normal resolution.

Orbiting reuses the existing drawing buffer and sun shadow map. Geometry
changes and context restoration invalidate the shadow; they do not start a
continuous rendering loop. The planner has its own directional lighting and
does not use the generated viewer's room-light or point-shadow budget.

Hidden pages suspend drawing. A lost WebGL context pauses the 3D preview while
2D editing and JSON export remain available. When the browser restores the
context, the preview redraws at the current viewport size. Discarding a page
disconnects the resize observer, disposes preview geometry, materials, shadows,
and the renderer, and releases the context. A retained back/forward-cache page
suspends and resumes instead of disposing its scene.

These limits reduce drawing and shadow work; they do not make every valid
project equally cheap to render. Showing all floors still builds all their
geometry, and catalog items can contain multiple meshes. The existing project
validation limits remain unchanged.

## Generated viewer rendering bounds

Native and unidentified renderers allow at most eight point lights to cast
occlusion shadows; positively identified software renderers allow at most two.
The renderer reserves four fragment texture units for the directional shadow
and material maps, reducing the point-shadow count further when
`maxTextures - 4` is below the selected limit. The first eligible fixtures in
inventory order receive these shadow slots when controls
are rebuilt; toggling lights and moving the camera do not reassign them. All
fixtures retain illumination and room confinement, but fixtures beyond the
shadow budget do not cast occlusion shadows.

Point shadows use a 4-by-2 atlas per shadow-casting fixture. Face resolution is a
power of two, at most 512 pixels for native/unidentified renderers or 128 pixels
for software renderers, and constrained by the maximum texture size.
The combined point-shadow atlas budget is 8,388,608 pixels; additional
shadow-casting lights reduce the selected face resolution.

The main canvas drawing buffer is capped at 2,000,000 pixels and device pixel
ratio 2, scaling below the native display resolution when necessary. When the
reported renderer positively identifies SwiftShader, llvmpipe, softpipe,
Lavapipe, a software rasterizer, Microsoft Basic Render, or the exact
`Apple Software Renderer` name, the cap is 250,000
pixels, with the smaller point-shadow limits above and a 512 by 512 directional
shadow map. Native and unknown renderers retain the 2,000,000-pixel cap and
2048 by 2048 directional shadow map. HTML labels and controls retain their normal
resolution. Both profiles retain full physically based material lighting and
room confinement for every light; the software profile reduces canvas detail
and shadow coverage/resolution. Size and pixel ratio are applied in one renderer
call, avoiding a separate ratio update against
the old dimensions. These are pixel budgets, not a measurement of total GPU
memory: color/depth storage, driver overhead, directional shadows, and geometry
also consume resources.

Existing shadow caching still redraws maps when casters or relevant state
change. Fixtures keep their shader slots when switched off, using zero intensity
instead of changing the compiled light count. An initial host inventory identical
to the viewer's current inventory does not rebuild the scene.

The room-light shader evaluates room transmission at most once per lit room per
fragment and skips unlit rooms. An exactly zero cached transmission skips that
light's distance, attenuation, shadow, and direct surface-reflectance work.
Nonzero contributions retain the same lighting calculation.

The 24-room, 72-light acceptance fixture exposed excessive software shader
compilation from expanding a full lighting block for every fixture. Only the
bounded shadow-casting prefix is now expanded into literal shader indices, as
required for its shadow samplers. Consecutive unshadowed lights from the same room share a runtime range. A
fragment outside that room skips the whole range; otherwise one shared loop
evaluates every light in its original order, with the same room confinement
and material response. Range ends use one preallocated integer array, and state
updates do not change the shader layout.
No light is dropped or merged. Total light count and generated room/window shader
size remain unbounded by the rendering profile, so larger projects still need
testing against the target GPU's limits.

Each room also has its own signed-distance function with its original polygon
edges. Transmission, daylight, and exterior-light calls select that function
directly. This prevents software shader compilers from expanding a full
room-selection branch chain at every call, while preserving the same boundary,
distance, and doorway-spill calculations.
For point-light transmission, an axis-aligned room bound expanded by 0.56 m
rejects distant fragments before evaluating the polygon: the existing spill
already reaches zero at 0.55 m. In-range and concave boundaries still use the
exact polygon. Edge calculations retain squared distance until one final square
root per room. Daylight and exterior boundaries keep their original tests.

Home reuses the room camera fit until the selected room or viewport orientation
changes. Pan, zoom, and resize continue to update the camera. Rounded-wall tint
only advances during requested draws; it starts no animation loop. The existing
reduced-motion, hidden-page, and limited-device guards keep that tint stationary.

Rapid pointer and wheel input is combined into one pending animation-frame
request. There is no idle rendering loop. Hidden pages and lost contexts pause
draw submission and cancel pending draws. Restoration invalidates shadow maps,
applies the current viewport size, and requests a fresh draw. On page discard,
the viewer disconnects its resize observer, disposes the renderer, and releases
the WebGL context. A page retained in the browser's back/forward cache suspends
rendering and resumes when shown.

## Reproducible browser acceptance

From a checkout with development dependencies installed:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install chromium firefox
node scripts/test-home-render-budget.cjs
node scripts/test-render-lifecycle.cjs
node scripts/test-browser-stability.cjs
node scripts/test-planner-render-budget.cjs
node scripts/test-planner-stability.cjs
```

Use `BROWSER_STABILITY_ENGINES=firefox` or
`BROWSER_STABILITY_ENGINES=chromium` to select one engine. Keep the engine build,
operating system, GPU/backend, viewport, device scale, source commit, and fixture
with the results. A WebGL-unavailable environment is not a passing 3D run.
`BROWSER_STABILITY_LIGHTS_PER_ROOM=2` selects the lighter twelve-light comparison
fixture; the default is three lights in each of six rooms.

The separate planner stress test accepts `PLANNER_STABILITY_ENGINES=firefox`
or `PLANNER_STABILITY_ENGINES=chromium`. It uses two fictional floors, sixteen
rooms, and 256 catalog items at device scale 2. The deterministic planner render
test also exercises hidden-page suspension, discard, drag cancellation, undo,
redo, and invalid-move rollback without a GPU.

For a target-browser acceptance run, use a fictional project or a private local
copy of the affected project. In the planner, draw rooms and walls, move and undo
items, orbit and zoom the preview, switch between individual and all floors,
resize, and export/reopen JSON. Separately, check initial Home drawing, multiple
active lights, rapid drag/zoom, room focus, editor/Home switching, window resizing, idle frames,
context loss/restoration, and closing/reopening the viewer. Confirm that controls
and labels remain aligned, that frame counts settle while idle, and that no
shader-link errors or unexpected context losses occur. Use a disconnected mock
bridge when exercising controls; no physical-device command is needed.

Compare baseline and candidate under the same conditions. Report measured
startup/interaction durations separately from pass/fail behavior, and avoid
generalizing a short synthetic run to an all-day stability or hardware power
claim. Keep household plans, credentials, device bindings, and raw private
captures out of public reports.

## Candidate releases

The stable `v0.6.2` base is already occupied. The next repair candidates use the
reviewed `0.6.3` source base in
`custom_components/home_floorplan/manifest.json`; the release workflow allocates
immutable `v0.6.3-beta.N` and `v0.6.3-rc.N` tags. A successful RC also requires the
configured offline fuzz campaigns and source-bound release evidence.

Candidates are prereleases. Publishing one does not establish Waterfox or
physical-device acceptance and does not deploy a Home Assistant installation.
The hosted drawing tool follows a separate GitHub Pages workflow: a push to
`main` stages the allowlisted website, including `planner/editor.js`, and
deploys it. Publishing a beta or RC is not a gate on that website deployment.
Downloaded source packages contain the same planner files; serve their root
directory locally and open `/planner/` to test the packaged drawing tool.
See [the release workflow](release-workflow.md) and
[version plans](VERSIONING.md) for publication and promotion requirements.
