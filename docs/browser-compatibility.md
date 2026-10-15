# Browser compatibility and rendering acceptance

The generated viewer uses the vendored Three.js r169 renderer and requires
WebGL 2 for 3D. A browser name or user-agent string is not a capability test:
graphics drivers, hardware acceleration, browser settings, and the size of the
loaded project also matter. The 2D plan and JSON export remain the recovery path
when 3D cannot start.

## Evidence and limits

The package workflow includes real Chromium browser checks for drawing,
furnishing, installation, localization, and the installed viewer. The isolated
browser stability fixture additionally exercises a generated, fictional six-room
home with eighteen linked lights. It uses a sandboxed iframe and a MessageChannel
to reproduce the panel boundary without connecting to Home Assistant.

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
stability certification. Waterfox was not installed or tested.

Passing a Playwright Firefox run is evidence for that bundled Firefox build,
operating system, and graphics backend. It does not certify Waterfox. Likewise,
Chromium with SwiftShader exercises software WebGL rather than physical GPU
performance. Safari, mobile browsers, and native Waterfox need their own target
browser acceptance runs before compatibility or performance is claimed.

No exact cause of a reported Waterfox browser crash has been established by the
code changes alone. A render timeout, shader error, context loss, browser-process
crash, and Home Assistant connection failure are distinct observations; retain
the actual failure and environment when reporting a regression.

## Bounded rendering work

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
Lavapipe, a software rasterizer, or Microsoft Basic Render, the cap is 250,000
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
fragment and skips unlit rooms. After applying that cached transmission to each
point light, it recalculates visibility; an exactly zero contribution skips
shadow lookup and direct surface-reflectance calculation. Nonzero contributions
retain the same lighting calculation. The limits do not bound the total light
count or generated room/window shader size; large projects still need testing
against the target GPU's limits.

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
```

Use `BROWSER_STABILITY_ENGINES=firefox` or
`BROWSER_STABILITY_ENGINES=chromium` to select one engine. Keep the engine build,
operating system, GPU/backend, viewport, device scale, source commit, and fixture
with the results. A WebGL-unavailable environment is not a passing 3D run.
`BROWSER_STABILITY_LIGHTS_PER_ROOM=2` selects the lighter twelve-light comparison
fixture; the default is three lights in each of six rooms.

For a target-browser acceptance run, use a fictional project or a private local
copy of the affected project. Check initial Home drawing, multiple active lights,
rapid drag/zoom, room focus, editor/Home switching, window resizing, idle frames,
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
See [the release workflow](release-workflow.md) and
[version plans](VERSIONING.md) for publication and promotion requirements.
