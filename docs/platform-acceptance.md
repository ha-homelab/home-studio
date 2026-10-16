# Cross-platform acceptance

The public `ha-homelab/home-studio` repository validates its source package,
generated viewer, and drawing tool on native Linux, Windows, and macOS runners.
All fixtures describe fictional homes and use a loopback-only simulated Home
Assistant panel. No household plan, Home Assistant token, live server, or device
command is needed.

## Required coverage

`quality-gate.yml` calls `package.yml`, which calls the reusable
`platform-acceptance.yml`. Release validation calls the same quality gate with
full validation enabled. Every row below is required: there is no optional
extended tier, report-only browser, or allowed failure. A download failure,
missing WebGL, browser crash, timeout, or failed assertion fails the gate.
`fail-fast: false` lets the remaining rows finish and preserve their evidence.

The separate package-validation job has a 30-minute overall envelope. Its
browser-tool installation step has a 12-minute limit covering `npm ci` and
Playwright's browser and operating-system dependencies (`--with-deps`). This
allows for slow operating-system package mirrors without consuming the entire
job before application checks finish. All later checks remain mandatory. The
browser matrix, per-case bootstrap and scenario watchdogs, and load, interaction
and recovery limits are unchanged. This prospective setup allowance does not
reclassify the earlier package job cancelled at its 15-minute limit as passed.

The reviewed inventory is `scripts/browser-matrix.json`, checked on
2026-10-15. Its expansion produces **77 acceptance executions**, plus one
inventory-validation job:

- **3 package/install rows:** Ubuntu 24.04 x64, Windows Server 2022 x64, and
  macOS 15 ARM64, with Python 3.13 and UTF-8 mode.
- **27 desktop engine rows:** all three operating systems, all three engines,
  and each of three pinned Playwright snapshots listed below.
- **12 branded desktop rows:** Google Chrome stable/beta and Microsoft Edge
  stable/beta on every operating system. These channels track the vendor's
  available release at installation time; their actual version is recorded.
- **6 historical Chrome for Testing rows:** **153.0.8010.52** and
  **154.0.8037.92** on every operating system. These were the two preceding
  Chrome majors when Google's catalog reported stable **155.0.8059.84**.
- **12 touch-emulation rows:** current pinned Chromium and WebKit, each with
  phone and tablet profiles, on every operating system.
- **6 native Firefox rows:** official Firefox stable **158.0** and ESR
  **153.5.0esr**, on every operating system, independently of Playwright Firefox.
- **6 native Waterfox rows:** official **6.7.5** and **6.7.6**, on every
  operating system, including the version from the original freeze report.
- **1 native Safari row:** the Safari installed on the macOS 15 runner, driven
  through Apple's `safaridriver`. Its runtime version is recorded separately
  from the WebKit engine rows.
- **3 Intel Mac comparison rows:** Playwright Firefox **153.0**, native Firefox
  ESR **153.5.0esr**, and native Waterfox **6.7.6** on `macos-15-intel`. These add
  x64 evidence alongside the same required ARM64 targets; all original 73
  executions remain required.
- **1 masked-renderer row:** native Firefox ESR **153.5.0esr** on macOS 15 with
  Gecko's normal renderer sanitization enabled. It repeats all three required
  suites and retains the original 76 executions. This verifies measured-capacity
  selection behind the opaque renderer label, not merely the unmasked test path.
  The lane derives expected budgets from the raw label and independently checked
  timing/readback evidence, then checks actual drawing-buffer dimensions,
  material types, shadow filtering, shadow counts and map sizes. Selected profile
  flags alone cannot satisfy these checks.

The Intel rows reuse the exact browser pins, fixtures, graphics preferences,
and assertions of their ARM64 counterparts. They compare older Gecko's CGL
behavior across hosted architectures; they are not an assumed fix or a claim
about physical Intel GPUs. GitHub documents `macos-15-intel` as a standard
[Intel runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
The manifest lists these three targets explicitly rather than expanding every
browser onto another platform.

Before browser tooling is installed, these three Intel rows run
`scripts/prepare-intel-macos-ci.py`. The helper requires all five host indicators:
GitHub Actions, a GitHub-hosted runner, macOS runner OS, Python on Darwin, and
x86_64 architecture. It records Spotlight status, disables indexing once, and
verifies that exactly the original volumes report disabled indexing. Commands
have 15-second limits and bounded output; any unsupported host, command failure,
unknown status or changed volume inventory fails preparation and prevents the
browser suites from running. The existing artifact retains `runner-environment/`
receipts even on failure. This changes only the disposable CI host: it does not
delete indexes, stop services, change updates, or wait for a quiet machine.
Disabled indexing does not guarantee idle workers or passing acceptance. This
normalizes observed background work without a desktop performance claim; all
77 required lanes, 74 browser artifacts, 222 primary cases, and their original
browser pins, scene quality and deadlines remain unchanged.

Playwright **1.64.0** pins Chromium **156.0.8078.4**, Firefox **157.0**, and
WebKit **27.2**. Playwright **1.63.0** pins Chromium **153.0.8010.12**, Firefox
**155.0**, and WebKit **26.6**. Playwright **1.62.1** pins Chromium
**151.0.7922.34**, Firefox **153.0**, and WebKit **26.5**.

At most ten Playwright rows, three native Firefox/Waterfox rows, three package
rows, and one Safari row run concurrently. These are GitHub-hosted OS runners,
not Linux containers with a different user agent. The existing focused Linux
package suite continues to run localization, model, render-budget, component,
and fuzz-regression checks. The ten-row browser limit shortens the full gate
while keeping each row's fixture and timing limits unchanged.
Older macOS Gecko, Windows WebKit, and touch rows run first so known risks
produce evidence early; scheduling priority does not change required coverage.

The Playwright versions above are three snapshots, **not three consecutive
browser majors**. Their versions and revisions come from each release's
[`browsers.json`](https://github.com/microsoft/playwright/blob/v1.64.0/packages/playwright-core/browsers.json),
with historical metadata for
[1.63.0](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/browsers.json)
and [1.62.1](https://github.com/microsoft/playwright/blob/v1.62.1/packages/playwright-core/browsers.json).
Historical Chrome pins come from Google's
[Chrome for Testing catalog](https://googlechromelabs.github.io/chrome-for-testing/latest-versions-per-milestone-with-downloads.json).
Updating a snapshot requires reviewing the manifest and its coverage tests,
not merely changing a job label.

## What the tests exercise

The installer suite rejects unsafe archives, checks replacement and rollback,
and preserves unrelated Home Assistant files. The package suite compiles a
fictional home, installs the generated archive into a temporary config
folder, and checks its contents. Release tests check the public allowlist and
repeatable ZIP bytes on each host. Same-host repeatability is not a claim of
identical compressed bytes across different compression-library versions.
The source ZIP also includes the CPU regression entry points used by its bundled
package workflow and their fixed fictional fuzz corpus. A separate check runs
those replay, light-state, TV and media tests from an extracted ZIP without a Git
checkout or installed Node dependencies. These checks require Node.js 22; full
release publication and mutation-campaign infrastructure remains in the repository.

Every Playwright row exercises the generated **6-room/18-light** viewer, the
larger **24-room/72-light** viewer, and the drawing tool with **2 floors,
16 rooms, and 256 furniture items**. Checks include real rendering,
interaction, light-state changes without repeated shader compilation,
intentional WebGL context loss/restoration, resource cleanup, preview
rebuilds, continued editing/export, and draft preservation. A working 2D
fallback does not count as a successful 3D test.

The planner reuses one WebGL context during normal editing and preview cycles.
After deliberate context loss and restoration, it replaces the canvas, retires
the detached old context, and rebuilds the preview with a fresh renderer.
The lost canvas is reduced to zero dimensions before restoration. Acceptance
requires its restored native buffer to be at most one pixel per dimension,
while the replacement uses the current full preview size. This avoids retaining
two full-size drawing buffers during recovery.
The recovery checks require exactly **one active context**, **two contexts
created in total**, and **two raw loss events**: the deliberate loss while the
original canvas is attached, and one retirement loss matched to an explicit
request after that canvas is detached. The old context must remain lost and
the replacement must remain attached and usable through subsequent orbiting.
Any additional or unmatched loss still fails; retirement does not excuse an
unexpected loss. Scene contents, resource limits, draft recovery, and continued
editing remain required after replacement.

The planner shares immutable catalog geometry within each rebuild. On the
identified Apple Software Renderer it also batches disjoint furniture parts, while
overlapping furniture and architecture retain their ordinary drawing order.
Geometry, appearance, instance bounds, cleanup and dense-scene fallback have
separate regression checks. Batching reduces draw calls but adds instanced shader
variants; it does not guarantee faster first-use compilation. Other software
renderers and native GPUs keep the ordinary mesh path unless the narrowly gated
capacity probe below demonstrates slow raster work.

The positively identified Apple Software Renderer uses Lambert materials for
lit surfaces and unfiltered shadows. Its diffuse fallback uses an unlit Basic
material for architectural wall fill. Acceptance keeps the same scene,
linked-light counts, shadow-map limits, state changes and interaction deadlines
in this mode. It is a deliberate matte rendering profile, not a claim of pixel
identity with PBR.
CPU tests cover the actual material factories and their shader families,
including transparency, clipping, wall tint and room-light composition.

The unlit wall fill keeps the original teal tint (`0xb2d8d2`), opacity
(`0.16`), transparent draw order, double-sided geometry, depth behavior,
cutaway clipping, outlines and full-height shadow casting. Walls no longer
receive point or directional lighting, daylight, shadows or animated/view
sheen; the constant-tint appearance also persists in the Editor. Home floors,
frames and furniture retain their existing materials, and all scene lights and
shadow maps remain present. Hardware and other software
profiles are unchanged. This is an intentional visual tradeoff, not a claim of
pixel parity. Qualify each revision with the complete required hosted matrix;
local comparisons do not establish cross-browser performance. Original browser
scenarios, assertions and deadlines remain required before any acceptance
decision.

The same diffuse profile uses constant-tint Basic materials for supported opaque
static floors and the authoring background in the Editor only. These surfaces
keep their geometry, colors, clipping, depth behavior and shadow casting, but do
not receive lighting or shadows in the Editor. Furniture and outlines keep their
existing materials. Returning to Home restores the exact original floor material
objects, including their lighting callbacks and uniforms. Unsupported materials
(textures, transparency or custom callbacks) keep their original path. One lazy
Basic material per eligible mesh is retained across mode switches; context loss
releases GPU associations for active and dormant materials, and final page cleanup
releases both. This is an explicit Editor quality tradeoff requiring visual and
performance evaluation; it does not change resolution, lights or acceptance limits.

Gecko can mask both hardware and software renderers as exactly `Apple M1, or similar`.
Only that exact label with a Gecko user agent runs a capacity probe, once per
new rendering context (including the planner's replacement context). It uses the
existing WebGL2 context, a private 32 × 32 RGBA8 framebuffer, and a fixed
512-iteration fragment shader: two warm draws and three timed draws, each with a
one-pixel readback. Valid, nonzero and nonsaturated RGB readbacks that vary
across the seeds, and a **minimum of at least 15 ms** across all three measured
draws, select the same reduced pixel/shadow budgets, diffuse material profile
and planner batching. This measures raster capacity; it does not identify the
underlying GPU as software. Other renderer labels are not probed.

Calibration with that exact workload measured 24–26 ms per draw and roughly
200 ms total on Apple Software Renderer, versus about 1 ms per draw and 48 ms
total on a native Apple M5 GPU. These measurements are examples, not time limits
or a guarantee on other hosts. The workload is fixed at five tiny draws with no
animation loop; a synchronous driver call cannot have a JavaScript wall-clock
timeout. Shader, framebuffer or readback failure keeps the normal rendering
profile. The probe deletes every private resource, restores all GL state it
changes, and leaves Three's state cache untouched. Diagnostics retain the
bounded timing/status and five RGBA readbacks separately from the reported GPU label.
The planner receipt retains its existing `sourceHash` with explicit
`instrumented-planner-editor` scope, plus `sourceFiles` SHA-256 hashes for the
original editor and shared capacity helper. These name the critical source
inputs; the recorded Git revision identifies the full checkout.

The diffuse profile also packs immutable room polygons, bounds and window segments into
uniform arrays, replacing repeated literal GLSL helpers with shared loops. Room
order, doorway spill, daylight and window transmission retain the same math;
other renderer profiles retain their original shader source. Packing is enabled
only when the reported fragment-uniform limit covers a conservative allowance:
131 vectors (including the private wall-sheen, glass-facing and zero-point switches) plus seven per light
slot, four per room, one per polygon edge, two per window, and one per room with
windows (at least one reserved slot). The guard budgets 845 of the Apple software renderer's reported
1,024 vectors for the 24-room, 72-light fixture. Lower limits and larger plans fall back to
the original literal geometry without reducing scene contents. CPU regression
tests cover polygon boundaries, concave rooms, window ordering and this fallback.

When every visible point light belongs to a known room and has exactly zero
intensity with valid finite inputs, the packed shader skips its point-light
block through one shared runtime uniform. Empty visible-light sets also skip
that block. Unknown rooms, nonzero or malformed inputs retain the original
calculation. Lights, their ordering, shadows and program families remain intact;
ambient, sun and daylight calculations remain outside the guard. Both full
Home frames and signal-only frames refresh the uniform immediately before
drawing, including after a live update or controller replacement.

One local native ARM64 Apple Software Renderer pair reduced the 24-room
two-cycle case from 56.37 to 49.84 seconds and improved both initial loads.
The six-room total was unchanged, and some drag measurements regressed.
Probe timings varied and some work shifted into the connected frame; these
ordered pairs do not establish a general speedup or resolve hosted Intel
acceptance. Separate off/on, daylight, shaded-window and cutaway comparisons
retained identical canvas pixels. All existing acceptance limits still apply.

Packed daylight traversal visits only rooms that own windows, in the original
room order. Window order, transmission and distance calculations remain the
same; a plan without windows omits the daylight loop. The additional index
array is included in the uniform allowance above, including its one-slot empty
fallback. The normal material path keeps its original shader source; the
low-uniform fallback retains the original literal room-lighting functions.

Exactly axis-aligned rectangular rooms use a box signed-distance calculation
instead of walking four polygon edges. Classification uses the same quantized
coordinates as the shader and rejects repeated corners, crossed edges and
collapsed bounds. Mixed plans retain the polygon calculation for every other
room. The regression compares boundary, doorway and daylight contributions;
separate image comparisons check the rendered result, not just CPU arithmetic.

Static opaque floors on the diffuse profile share the clipped shader variant
already used by window frames. Each floor receives a valid plane beyond all its
vertices, independent of the user's cutaway plane; it cannot remove that floor
or clip its shadow pass. Unsupported, transparent and other-profile surfaces
keep their existing clipping behavior. This avoids compiling an extra program
without changing floor geometry, sidedness, illumination or drawing resolution.
Regression checks include transformed Float32 clipping arithmetic and separate
image comparisons from above, below, near the floor and with cutaway enabled.

Eligible static Lambert walls, floors and frames also share a program with a
private per-material wall-tint switch. The unlit wall fill described above
bypasses this hook for Basic walls. Opaque floors and frames use explicit
`NoBlending`, which preserves their already-disabled GPU blending while avoiding
a separate opaque shader define. Walls retain their transparency and depth
state. Textured, alpha-tested, differently sided, dynamic and mixed-role
materials keep separate programs. A later attachment restores any owned blend
setting and keeps cached uniform references current. Regression checks cover
reattachment, material ownership and low-uniform fallback; visual diagnostics
also check the actual GPU switch, blending, culling and depth state across draws.
Fewer programs can reduce first-use work, but do not guarantee a speedup on every
driver; the complete timed acceptance matrix remains required.

Eligible static, smooth, unmapped window glass on the diffuse profile shares
that program through a private facing uniform. Two adjacent meshes retain the
original ordered back and front alpha passes, using the same geometry, live
cutaway plane, transforms and depth state. Each pass has its own material so
Three uploads the correct facing value. GL culling is disabled for this
`DoubleSide` program; an early fragment discard preserves the original visible
faces. The back pass also reverses the vertex normal before shadow normal bias,
while the ordinary wall/floor/frame mode retains its original normal handling.
No light, shadow, drawing resolution or glass detail is removed. Unsupported
glass and other rendering profiles retain the original path.

Factory-owned, opaque fallback boxes can use the same packed Lambert program
with facing mode `+1` and the wall tint disabled. A nonbinding plane keeps the
clipping program compatible without applying the cutaway to these objects.
The original material, geometry, object order and live emissive updates remain
in place. Main-pass GPU culling becomes an equivalent face discard; CPU picking
retains `FrontSide`, and an explicit `BackSide` shadow side retains the original
BasicShadowMap behavior. Unsupported, shared or externally changed materials
fall back to their original settings. This adds no uniform slots or GPU objects.
The source proof covers compiled prefixes and cache keys, mirrored picking,
Float32 clipping, and controller replacement; it does not establish a speedup.

The extra facing uniform is included in the allowance above. The explicit
passes remain valid with literal room lighting when packing does not fit.
Context loss releases the owned material programs before the renderer replaces
its caches; final disposal restores the original mesh material and removes the
added pass. Geometry is shared rather than cloned, and public mesh counts
continue to report physical meshes. CPU tests compare actual pinned Three
prefixes, expanded shaders and cache keys, including mirrored normal/bias
arithmetic. Separate visual captures check 15 views, including cutaway, near
glass and mirrored transforms, and read back the actual per-draw facing state.

One local native ARM64 CGL comparison reduced the 24-room case from 56.213 s
to 52.192 s, with initial draws falling from 12.334/12.418 s to 10.838/10.714 s.
Its ordinary drags were about 1% slower; the six-room comparison also had slower
second-cycle drag and recovery despite faster startup. Both sizes retained
identical final scene pixels and passed the unchanged strict checks. These are
sequential runs with shared compiler caches on one physical host, not a speed
guarantee or evidence that hosted Intel acceptance passes.

Viewer receipts retain the existing native drag phase timings for Home and the
editor, followed by the existing two-animation-frame completion wait. These
measurements add no input actions or rendered frames; the same total duration
continues to determine whether the interaction passes.

The software viewer paints the first moved-pointer frame immediately. Apple
diffuse rendering measures the elapsed time of each successful motion draw with
two monotonic clock reads, then bounds the next motion delay to 64–250 ms.
That deadline is fixed when scheduled; later input does not postpone it. The
measurement belongs to the current gesture and is discarded with its pointer
record on release, cancellation, hiding or context loss. Other software keeps
the existing 64 ms delay. No extra GL calls or GPU resources are added, and the
62,500-pixel motion and 125,000-pixel Apple diffuse resting budgets are unchanged.
This bounded pacing may leave time for queued input between expensive software
draws. It measures synchronous submission and driver blocking, not asynchronous
GPU completion, and does not create an exception to any acceptance deadline.
Lifecycle regressions
check that held drags still repaint, later input cannot postpone the deadline,
and release, live-state updates, resize, suspension and context loss leave no
stale delayed work. Browser acceptance still requires real motion rendering
and a final full-resolution frame; reducing the number of draws cannot replace
either assertion. CPU checks exercise both diffuse and physically based software
paths, including continuous input across several deadlines. Physically based
software frames remain full-resolution direct draws without a copy pass.

A local Apple Silicon comparison using Playwright 1.62.1 / Firefox 153 and the
Apple Software Renderer passed both original viewer cycles at six and 24 rooms.
Home motion copies fell from two to one in all four compared gestures. Six-room
Home drags changed from 1,094/1,048 ms to 581/571 ms. At 24 rooms, one Home drag
became slower (553 to 697 ms), while the other improved (1,255 to 726 ms); Editor
copy counts did not improve. The 24-room scenario was slower overall amid large
load-time variation. Recorded camera, drawing-buffer, material, geometry,
resource, light and shadow state matched in all three restored views. These
ordered local runs, including a reused baseline with intervening diagnostics,
support fewer redundant Home draws, not a general speedup or hosted Intel proof.

The diffuse interaction helper prepares its framebuffer-copy texture and
program on the first actual motion frame. Initial, resized and restored full
frames draw the scene directly without allocating or compiling unused copy
resources. The motion viewport, copy shader, filtering, frame statistics,
release frame and disposal behavior are unchanged. A later motion frame sizes
the texture from the current drawing buffer before copying.
This defers one copy-texture initialization and one copy-program compile
request; the helper's CPU-side camera, geometry and material still exist and
retain their original cleanup.

This moves copy preparation into the first gesture; it does not remove that
work or establish a speedup. The original first-drag, load and recovery limits
remain mandatory. CPU checks cover cold full frames, first-motion preparation,
resize, reconstruction, errors and cleanup; real driver timing and pixels still
require browser validation.

The packed daylight path omits loops for absent exterior rooms or windows and
rejects rooms outside the existing conservative spatial bound before calculating
polygon distance. The bound contains the full daylight and exterior transition;
window accumulation order and every nonzero contribution remain unchanged.

Immutable building materials also receive a conservative world-space bound.
The packed path skips whole light runs whose room cannot contribute anywhere
inside that bound, retaining the original order and shadow-light prefix.
Movable furniture, deformed or unsupported geometry, and materials shared with
movable objects retain every run. Bounds include the complete vertex buffer,
the room's full light-transmission halo, and floating-point arithmetic slack.
Each selected run is uploaded as one integer vector containing its original
start, exclusive end and room number. This avoids three dynamically indexed
scalar arrays in the unshadowed loop. Shadowed slots retain the original
constant-index room lookup. Starts and ends remain CPU scratch storage for
filtering; inactive records are never read. The conservative uniform allowance
above is unchanged, regardless of a driver's inactive-array elimination.

The emitted run-control code is executed against an independent per-light
oracle in CPU tests, including filtered gaps, split shadow prefixes, unknown
rooms, empty updates and re-enabled lights. A local native ARM64 software-GL
comparison retained identical pixels in both strict six-/24-room cases and
eight lighting/editor views. The 24-room connected loads changed from
10.115/10.060 to 8.152/8.264 seconds; drag results were mixed. These ordered
same-host measurements share OS/compiler caches and do not establish a general
speedup or replace the required hosted Intel/browser matrix.

The prepared software-renderer candidate uses three optional Float32 RGBA
textures for point records, ordered run records and immutable room geometry.
Integer texel fetches retain the original arithmetic and literal shadow prefix,
with high precision, nearest filtering, no mipmaps and no color conversion.
The active texture program declares only the shadow prefix of the stock
PointLight array; unsupported inputs keep the full uniform program. Actual
Three view-space point records populate the texture during uniform upload,
including first render and signal-only redraws.

Selection occurs before compiling a material. Only eligible Lambert materials
with owned or ordinary callbacks and finite, known-room point lights on the
current camera layers use this path. Capacity, dimensions, sampler and uniform
limits, exact integer conversion and conservative Float32 overflow checks
retain the original program when unsupported. The packed eligibility and
existing quality budgets are not reduced. Context loss retains CPU data for
reupload; teardown and controller replacement release all three textures.

Each static material keeps a fixed run-table row; dynamic materials use the
original global row. The scalar run count and ordered loop are unchanged.
Runs are staged after static filtering, within a 16 MiB allocation ceiling.
The immutable geometry atlas retains signed rectangle sentinels and window
indices with fixed offsets. Lit-room flags and window transmission values
append to the point texture, adding no fourth sampler or per-frame texture
allocation. Nonfinite transmission deactivates texture selection immediately,
including environment-only changes.

The independent [decay-two specialization](point-decay-two.md) remains eligible
only when every visible point has the exact validated decay value. Texture and
decay selection form four separately keyed states, so losing either proof
retains the other when valid. CPU tests cover exact records, original shader
inverses, cached variants, update order, fallback transitions and disposal.
Local image comparisons do not establish hosted Intel timing or qualify this
prepared composition for release; all required browser checks still apply.

Phone and tablet profiles use **390 × 844** and **820 × 1180** CSS pixels,
respectively, at device scale factor 2, with touch enabled. They retain the
actual desktop operating-system identity. Chromium exercises native touch
drags; the WebKit touch profile exercises native taps, with mouse-driven
scene drags where the public automation protocol lacks native touch-drag
support. Diagnostics disclose this limitation. These rows test responsive
layout and available touch-input paths; they are not Android or iOS devices.

The native Firefox, Waterfox, and Safari runners separately load both viewer
sizes and the 256-item planner, exercise interaction and rendering recovery,
and check draft preservation. They use the actual installed browser protocol
and record the browser's reported identity. These suites are separate evidence
from Playwright's patched browser builds and do not claim assertion-for-assertion
identity with the Playwright runner.
Initial viewer readiness requires both a connected bridge and a successful
renderer call containing every expected active fixture. A connection label or
updated CPU-side light state alone cannot finish the startup measurement.
Failed renderer calls do not advance the recorded frame state.

Both drivers include two animation frames after pointer release in their drag
timings. A fast input acknowledgement alone is not rendering responsiveness;
the native 15-second viewer and 10-second planner limits include this draw wait.

## Reproducibility and evidence

Each Playwright snapshot installs in a separate temporary directory using an
exact generated npm lock, SHA-512 package integrity, disabled install scripts,
and no optional packages. Setup verifies the installed package versions and
`browsers.json` revisions against the inventory before installing browsers.

Browser installation retries only recognized transient transport failures,
such as an interrupted HTTP/2 download, at most three times. It retains every
attempt's output and exit code under `browser-install/` in the job artifact.
Certificate, checksum, signature and package errors remain fatal, as does an
exhausted download retry. The selected channel and pinned toolchain never change
between attempts. Browser acceptance itself is not retried by this helper;
a previously installed runner browser cannot turn a failed installation green.
The source checkout's lockfile is not rewritten. Pinned browser rows also
check the actual browser version and major at launch.

Historical Chrome archives have exact official URLs and reviewed SHA-256
hashes. Native Firefox and Waterfox use exact official release URLs and
SHA-512 hashes from `scripts/firefox-versions.json` and
`scripts/waterfox-versions.json`. Their extracted applications and test profiles
live in temporary directories, and the native runners verify the requested
product and release. macOS application signatures are checked where supported;
preferences belong in disposable profiles, never inside signed bundles.

Chrome and Edge stable/beta channels and the runner-installed Safari are
intentionally **rolling coverage**, not byte-pinned releases. Playwright's
[documented channel installer](https://playwright.dev/docs/browsers#installing-google-chrome--microsoft-edge)
can replace the corresponding system browser, so these installs run only on
disposable CI hosts. The Safari job enables remote automation only on its
disposable runner. Local focused runs should use an existing browser or an
isolated pinned download.

Every browser job uploads a distinct `acceptance-<OS>-<target>` artifact for
14 days, including failed test runs. Playwright artifacts separate the small
viewer, large viewer, and planner; they also retain the installed toolchain
metadata and any historical Chrome receipt. Native artifacts identify the
product, pinned release where applicable, and browser session. JSON evidence
records the source revision, actual browser version, platform, graphics
information, observations, and failures. Failed runs attempt screenshots;
a crashed or unresponsive browser may not produce one. Job logs remain the
evidence for dependency failures and runner-level timeouts.

Playwright uses two consecutive budgets. One aggregate **30-second bootstrap**
budget covers loading the automation module, launch, context creation, init
scripts, page creation, initial browser identity, listeners and optional input
tracing. It is not renewed as setup stages complete. Immediately before the
scenario callback, the watchdog switches once to a **180-second viewer** or
**180-second planner** budget. That scenario budget includes all
scenario cycles, interactions and recovery, final browser identity and final checks;
phase changes never renew it. Drag, step and cleanup limits, assertions, browser
profiles and scene quality remain unchanged; the cold viewer load budget is
specified separately below. No retry or
platform-specific allowance is added.

These are prospective acceptance-contract changes. The original shared helper
charged bootstrap against the scenario budget; separating it added at most
**30 seconds** to permitted wall time. The viewer scenario subsequently increased
from **120 to 180 seconds**, uniformly across every Playwright engine, desktop,
phone and tablet profile, and both fixture sizes. The earlier 120-second budget
predated the three additional post-restoration mode checks and the 60-second
cold-load allowance. The scenario includes two fresh viewer loads, four drags,
two Editor settling checks, live-state transitions, forced context recovery and
the restored Editor cutaway, full-height Editor and Home checks. The aggregate
is a bounded completion guard for that full sequence; the individual 60-second
loads, 15-second drags and 10-second settling checks remain responsiveness gates.
The aggregate need not permit every individual operation to consume its maximum.

R29's Intel Firefox 153 viewer-6 case exceeded the old aggregate while the
completed individual loads, drags and settling checks stayed within their limits.
Its retained timeout was in the restored Editor cutaway check; later progress
during failure capture did not complete acceptance. That run remains failed.
The new aggregate allows a slower combined scenario and is not a runtime speed
improvement. Its numerical value matches the native viewer watchdog, but the
scopes differ: native's 180 seconds also includes browser setup. The hard process
timer is now **245 seconds for either Playwright suite**, measured from the same case
start and including the existing 35-second failure/cleanup allowance. Requested
input tracing retains its additional 11-second cleanup allowance. An unresolved
launch or late resource cleanup leaves that hard timer armed. Late setup
results are closed rather than entering the application. Monotonic checks reject
late successful callbacks even when the event loop delayed a timer callback.

Playwright receipts identify this contract with `deadlineScope.version: 2` and
record `bootstrapMs`, `scenarioMs` and `hardProcessMs`. Measured
`bootstrapDurationMs`, `scenarioStartedMs`, `scenarioDurationMs` and
`scenarioCompletedMs` use the case's monotonic clock, as do Node-side `phases`
with start, completion and duration times. `scenarioCompletedMs` is populated
only after the scenario, final identity and final checks complete within the
budget; subsequent cleanup can still fail the case. A bootstrap failure leaves
the scenario fields null. Timed-out durations can exceed their budgets because
of delayed callback delivery; they never imply success. Viewer phases
distinguish loading, input, state updates, restoration and iframe detachment.
These markers add no browser evaluations or rendering work. On deadline expiry,
`timeoutScope` distinguishes bootstrap from scenario and `timeoutPhase` preserves
the active phase before diagnostic capture begins. The asynchronous scenario
callback can still finish work while failure evidence is captured, so later
sample fields or completed phase entries do not prove that work finished before
the deadline; consult the retained timeout and status. Native Gecko and Safari
acceptance timing is unchanged by this Playwright contract.

Strict viewer receipts also require `completed: true` on exactly two ordered
cycle samples, after each iframe detaches and the dashboard responds. Each of
the three ordered `postRestoreViews` has its own completion marker, set only
after the existing frame, mode, lighting and GL-error assertions pass. The final
application check records `viewerCompletion: {version: 1, cycles: 2,
postRestoreModes: ["editor-cutaway", "editor-full", "home"]}` only when those
receipts and the individual timing limits are complete. This marker adds no
browser work and does not replace `status: "passed"`, timely
`scenarioCompletedMs`, final browser identity or successful cleanup. Report-only
observations do not receive this strict completion marker.

The cold viewer load has one aggregate **60-second** budget per cycle, uniformly
across Playwright profiles and native Firefox, Waterfox and Safari. It starts
before fixture fetch and iframe creation and covers frame selection through the
first fully connected frame with every expected light rendered. Each wait uses
the remaining budget; completing a blocked call at or after the deadline still
fails. This is a prospective change from 30 seconds for cold viewer loads only,
not a runtime speed improvement or a reclassification of previous failed runs.
Planner loads retain 30 seconds. Interaction, settling, editor,
recovery and teardown limits are unchanged.

The cold budget cannot extend the existing outer deadline: Playwright retains
its 30-second bootstrap and 180-second viewer scenario, and native viewers retain
their 180-second browser watchdog. Each of the two cycles gets a fresh cold
budget limited by that same remaining outer clock. Native script and transport
timeouts temporarily follow the remaining cold budget and return to their
ordinary 30-second setting afterward. Native timeout setup is included in the
cold measurement; its reset and the diagnostic snapshot after readiness are not.
The separate fenced first-frame diagnostic retains its own 180-second limit and
cannot award acceptance credit.

Safari's initial WebDriver `POST /session` has a separate 60-second setup
allowance in each case, capped by the remaining, unchanged 180-second browser
watchdog. The single request is not retried. HTTP headers and body share that
deadline, and late completion cannot enter the application scenario. Subsequent
commands retain their ordinary 30-second transport timeout; the viewer's
separate cold-load scope remains as described above. The report records
`phase: session-startup` while that request is pending and retains
`sessionStartup` with `budgetMs`, `effectiveBudgetMs`, `durationMs`, `completed`
and `timedOut`. Session configuration and application work have distinct phase
labels. Cleanup uses a returned session ID when available; otherwise stopping
SafariDriver handles an unknown-ID startup failure. This prospective allowance
does not reclassify earlier session timeouts as passes or change any application
assertion, interaction or recovery limit.
Socket operations use the remaining allowance; a blocked library call can
return after its boundary, but still fails admission. This is not a guarantee
of preemption at exactly 60 seconds; the unchanged outer watchdog also remains
in force.

Every viewer report and cycle sample records `loadBudgetMs: 60000`. Samples also
record monotonic `loadMs` and `loadCompleted`; a pending or failed cold load is
saved with `loadCompleted: false`, and detected expiry sets `loadTimedOut: true`.
Successful durations use the checked completion timestamp and must be strictly
less than 60 seconds. These fields describe cold readiness, not gesture latency,
and do not override the final case status or outer timeout evidence.

The Playwright, native Gecko and Safari jobs preserve their completed evidence
with a pinned upload action. If that transport attempt fails, one fallback
uploads the same saved directory, artifact name and settings. A warning retains
the first failure in the job log. The fallback uses `overwrite: true` because
the first request may have created an artifact without returning its response.
Its failure still fails the job; successful transport never changes an earlier
browser or test failure. No test case, application interaction or browser
session is retried; their deadlines are unchanged.
The three package/install jobs currently publish no acceptance artifacts.

Artifact names are unique across the 74 browser jobs. A replacement can change
the artifact ID and ZIP digest, so collectors must bind the final completed
job's current API artifact and digest rather than an early provisional upload.
The upload backend does not preserve a replaced artifact from a historical
attempt with the same name; independently retained ZIPs remain separate
evidence. This bounded transport retry gives no retrospective acceptance
credit to runs whose evidence is missing.

Legacy native Gecko rows on macOS enable `NATIVE_STARTUP_DIAGNOSTICS=1`.
A separate loopback fixture process saves at most 56 startup checkpoints,
including the reported renderer, selected rendering profile, first two shader
compilations and first eight program links/status queries, even if the browser's
main thread later stalls. Bounded before/after records also capture the first
draw submitted with each of those eight programs. Submission duration can
include deferred driver compilation and does not measure GPU execution time.
Program indices distinguish an initial shadow shader
from later lighting programs. Shader metadata includes type, source length and
a nonsecurity FNV-1a fingerprint of at most the first 65,536 UTF-16 code units;
the hashed length is explicit, and shader source text is never retained or sent. Only these served
diagnostic fixtures permit requests to their exact loopback origin; the shipped
viewer and ordinary test fixtures retain their original connection policy.
The mode is recorded in each receipt and defaults to off for local runs.

If the primary planner check fails on Windows WebKit, the job runs four
diagnostic comparisons: all recovery actions after layout settles, then no
actions, editing only, and resizing only with immediate restoration. These
use `PLANNER_STABILITY_RECOVERY_ACTIONS` and `PLANNER_STABILITY_RESTORE_LAYOUT`
to isolate the extra context loss observed on this port. Evidence is saved
under `diagnostics/planner-{settled,none,edit,resize}` in the same artifact.
Each comparison enables `PLANNER_STABILITY_TRACE_RECOVERY=1` for detailed
renderer/layout tracing and `DEBUG=pw:browser` for browser-process output,
retained in `browser-process.log` with pipeline failures preserved. The primary
acceptance check uses the default without detailed recovery tracing.
Every comparison runs, and any diagnostic failure also fails that step. The
primary check still requires all actions with immediate restoration and its
failure still fails the job even if every diagnostic passes.

Chromium phone/tablet taps use one native `Input.dispatchTouchEvent` start/end
sequence on the same CDP session as touch drags. The driver waits for the start
response before dispatching the end. The viewer still requires exactly four
trusted touch starts and ends per ordinary cycle, and all activation, recovery
and latency assertions remain unchanged. Desktop and non-Chromium inputs retain
their existing transports. Native touch drags keep the finger stationary for
100 ms after the final move and before release. This time remains inside the
reported release latency and the unchanged drag budget; it sends no extra input.
`inputDiagnostics.dragReleaseHoldMs` records 100 for native touch and 0 otherwise.

The stationary end distinguishes an intentional orbit/placement drag from a
flick. A failing Chromium 156 trace showed the editor drag starting a browser
fling, followed by the next button tap being suppressed when it cancelled that
fling, even though the canvas touch action was `none`. Chromium's
[velocity tracker](https://github.com/chromium/chromium/blob/156.0.8078.4/ui/events/velocity_tracker/velocity_tracker.cc#L298-L311)
clears release velocity after 80 ms without movement. The hold acts before
release, without delaying or retrying the subsequent activation.

The serialized tap transport was introduced after an intermittent missing native
click in Playwright's concurrent start/end path and a passing serialized comparison
on the same hosted row. Subsequent traces identified the preceding drag's fling
as a separate source of tap suppression; serialization alone did not prevent it.
Target checks retain visibility, enabled state, Playwright's stable scrolling and
geometric hit testing. Iframe locator bounds provide main-frame CSS coordinates;
the hit test runs in the target document. No synthetic click, `trial:true` input,
extra attempt or relaxed timeout is used.

If a Chromium phone/tablet viewer check fails, the job repeats only that viewer
size in two fixed diagnostic modes: the original Playwright tap, then
`Input.synthesizeTapGesture` with a 50 ms press. Each runs the original two full
cycles, assertions, timing limits and recovery check. They set
`BROWSER_STABILITY_TOUCH_TAP=playwright|gesture50` and
`BROWSER_STABILITY_TRACE_INPUT=1`. Receipts, browser-process logs and Chromium
input/latency/benchmark traces are saved under
`diagnostics/viewer-{6,24}-touch-{playwright,gesture50}`. Trace capture is off in
primary acceptance and may affect diagnostic timings. Missing or incomplete
requested traces fail the diagnostic. The original failed viewer step still
fails the job even if both comparisons pass; successful viewer sizes are not
repeated. These comparisons add no optional row or release-gate waiver.

All primary Chromium rows enable `DEBUG=pw:browser` in the CI job log to retain
process launch, exit and shutdown evidence for intermittent cleanup failures.
This does not enable primary input tracing or change the 15-second browser
cleanup limit. Existing receipt identity and per-suite artifact paths remain
unchanged.

Check the first failed assertion and actual renderer before comparing timings.
Chromium rows explicitly request `CHROMIUM_ANGLE_BACKEND=swiftshader` on
Linux and Windows, and `CHROMIUM_ANGLE_BACKEND=metal` on macOS. The actual
renderer must confirm the requested backend. Hosted macOS Metal exercises the
runner's virtual graphics device; it does not certify a physical Mac GPU.
Linux runs headed browsers under Xvfb with software GL. Firefox profiles force WebGL enablement
and normally disclose the actual renderer rather than a sanitized GPU name.
The explicit masked-ESR row retains Gecko's normal renderer sanitization and
validates the measured-capacity decision instead. Playwright
Firefox 155/157 and native Firefox 158 rows on macOS select
`FIREFOX_WEBGL_BACKEND=angle` and require the reported renderer to confirm Metal
ANGLE. Playwright Firefox 153, native ESR 153, and Waterfox retain their default
WebGL backend and select `FIREFOX_COMPOSITOR_BACKEND=software` on macOS because
those releases precede the Metal ANGLE path. These older macOS rows also set
`FIREFOX_GPU_PROCESS=disabled`, which requests
`layers.gpu-process.enabled=false` and `webgl.allow-in-parent=true` in each
temporary browser profile. The latter permits WebGL in the parent process when
the headed ESR 153 graphics path no longer has a GPU process. These
settings change the compositor and process configuration, not the WebGL
rendering budget; WebGL stays enabled, the real graphics renderer is recorded,
and all rendering/recovery assertions remain required.
The configured ANGLE path avoids the hosted VM's slow native CGL fallback; it
does not certify Firefox's default graphics configuration. Historical rows
still have to meet the same acceptance assertions on their available backend.
Waterfox profiles also permit software WebGL. These are bounded
regression checks, not frame-rate, battery-life, or long-duration benchmarks.

## Reproduce a focused row

With Python 3.13 and Node.js 22 installed, inspect the required inventory or
check its contracts without downloading browsers:

```sh
python3 scripts/test-browser-matrix.py
python3 scripts/browser-matrix.py
```

For a pinned snapshot, choose an empty directory outside the checkout. The
setup command prints the absolute module path for the environment variable:

```sh
python3 scripts/setup-browser-toolchain.py --version 1.63.0 --output /tmp/home-studio-pw-1.63.0
export HOME_STUDIO_PLAYWRIGHT_MODULE=/tmp/home-studio-pw-1.63.0/node_modules/playwright
export PLAYWRIGHT_BROWSERS_PATH=/tmp/home-studio-pw-1.63.0/browsers
node "$HOME_STUDIO_PLAYWRIGHT_MODULE/cli.js" install chromium
export BROWSER_STABILITY_ENGINES=chromium
export PLANNER_STABILITY_ENGINES=chromium
export HOME_STUDIO_EXPECT_BROWSER_MAJOR=153
export HOME_STUDIO_DIAGNOSTICS_DIR=acceptance-artifacts/local
node scripts/test-browser-stability.cjs
BROWSER_STABILITY_ROOMS=24 node scripts/test-browser-stability.cjs
node scripts/test-planner-stability.cjs
```

Use your shell's normal environment syntax on Windows. On Linux, installing
system libraries may require `install --with-deps`; headed CI parity also
requires `BROWSER_STABILITY_HEADED=1`, `PLANNER_STABILITY_HEADED=1`, and
`xvfb-run -a`. `PYTHON` selects the compiler interpreter, and `PYTHONUTF8=1`
matches CI. Change both engine variables together; `webkit` and `firefox` are
also supported. For macOS Chromium CI parity, set
`CHROMIUM_ANGLE_BACKEND=metal`; the default `swiftshader` remains available for
software-renderer comparisons. Select `HOME_STUDIO_BROWSER_PROFILE=phone` or `tablet` for
emulation, or leave the default `desktop` profile. For an already-installed
branded browser, `HOME_STUDIO_BROWSER_CHANNEL=chrome`, `chrome-beta`, `msedge`,
or `msedge-beta` selects its channel; omit the pinned-major expectation for a
rolling channel.

For isolated historical Chrome, run `setup-chrome-for-testing.py --version
154.0.8037.92 --output <empty-directory>`, then set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` to the printed binary and the expected major to
154. Keep the browser channel unset.

The native Firefox/Waterfox runners use the normal fixture dependencies:

```sh
npm ci --ignore-scripts --no-audit --no-fund
python3 scripts/setup-native-browser.py --product firefox --version 153.5.0esr --output /tmp/home-studio-firefox-esr
python3 scripts/test-native-browser-acceptance.py --product firefox --expected-version 153.5.0esr --installation /tmp/home-studio-firefox-esr/install.json --output acceptance-artifacts/firefox-esr
```

For Waterfox, change the product to `waterfox` and the version to `6.7.5` or
`6.7.6`; the older `setup-waterfox.py` and `test-waterfox-acceptance.py` commands
remain available. Windows extraction requires 7-Zip. On macOS, the Firefox 158 CI
configuration additionally sets `FIREFOX_WEBGL_BACKEND=angle`. The macOS ESR
and Waterfox rows use `FIREFOX_COMPOSITOR_BACKEND=software` and
`FIREFOX_GPU_PROCESS=disabled` with the default WebGL backend. These settings
apply only to disposable test profiles. Keep application
bundles unmodified so their signatures remain valid.

After a macOS legacy native viewer fails, CI may capture one original startup
frame with `scripts/diagnose-native-draw.py`. It selects the failed six-room
case first, otherwise the failed 24-room case, only when the primary receipt
records Apple Software Renderer or a masked renderer with a measured slow
raster probe. It uses the same verified installation, source and preferences.
The primary failure remains required and unchanged; this is not an acceptance
retry and does not add or replace any of the 77 required lanes.

The separate `diagnostics/first-frame/` directory contains `diagnostic.json`,
`draws.jsonl`, and the browser's durable log and report. The diagnostic uses
`gl.finish` immediately before and after each draw, retaining program/shader fingerprints, material and
mesh category, framebuffer/viewport, shadow-light attribution and the original
point-shadow atlas face index. Shader fingerprints include `hashedLength` and
cover at most 65,536 code units; a matching truncated fingerprint does not prove
full-source equality. `preDrawDrainMs` measures commands queued since the
preceding fence, such as state changes or uploads; submission and completion
are recorded separately. Completion can still include driver specialization
triggered by the draw. The `pre-draw-drain-and-post-draw-fence-v1` timing mode
changes scheduling and is not directly comparable to older post-draw-only
traces, ordinary acceptance performance or pure shader compilation time.
Each draw also records the last observed scalar uploads for the point-light
guard, daylight, exterior surface, wall switches and face mode. This observes
existing `getUniformLocation`, `uniform1i` and `uniform1f` calls without adding
GL queries or uploads. `null` means unknown, never an inferred zero or false;
these are submitted values, not GPU readbacks. Relinking/deleting a program
invalidates its cached values, and capture completion removes owned observers.
Only the first naturally requested frame is fenced; no warm-up frame or input
sequence is added. At most 600 draws and 2,000 event records are captured, with
a 180-second overall worker deadline including setup and launch. A bounded
five-second termination grace precedes forced process-group cleanup. Partial
logs remain available when startup, a draw or teardown fails. Neither successful
capture nor incomplete capture changes the failed primary receipt.

## Boundaries of a green result

A successful matrix covers the inventory above, not every past browser or
hardware combination. Windows Server 2022 is not the reporter's Windows 11
machine. Intel Mac coverage is limited to the three explicit comparison rows. Hosted
VM renderers do not reproduce all GPUs, drivers, extensions, browser policies,
or hardware-acceleration settings.

Playwright WebKit is a patched engine build, not Safari. The separate Safari
row adds actual desktop Safari coverage for the runner's installed version;
it does not cover all older Safari/macOS pairs, iOS Safari, or embedded iOS
WebViews. Touch emulation does not run mobile operating systems, actual mobile
GPUs, keyboards, browser chrome, or Home Assistant companion WebViews. Firefox
ESR is one explicitly pinned supported ESR release, not all historical ESRs.
The versioned engine snapshots and two historical Chrome majors are regression
targets, not recommendations to run obsolete browsers.

Real Android/iOS devices, additional OS/architecture pairs, and real Home
Assistant authentication/device integrations need their own acceptance
infrastructure. No successful desktop or emulation row substitutes for those
missing results. For a freeze report, collect the exact browser/OS versions,
graphics backend, affected viewer or drawing-tool path, and a sanitized
reproduction. See [browser compatibility](browser-compatibility.md) for prior
measurements and the safe bug-report checklist.

### Scoped shadow transmission

The packed room shader evaluates each shadowed light's pure room-transmission
helper once, then reuses the scalar for admission and visible-light color.
An explicit per-light scope survives Three's literal prefix unrolling. All
helper operations, light and shadow order, nonzero/NaN admission behavior,
unshadowed runs, and literal/editor paths remain unchanged; no uniforms,
textures, passes or quality limits are added. CPU traces verify that only the
second pure call disappears. Native ARM64 software-rendered comparisons
retained identical RGBA pixels across eight Home/editor views, and the original
six-room and 24-room suites passed. A driver may already eliminate the duplicate
computation, so this does not establish a speedup on other hosts. The complete
required browser matrix remains the release gate.

The prepared composition retains the existing point, run, geometry and signal
texture transport and the independently selected decay-two helper. Caching
changes only the packed shadow prefix: its transmission helper reads the same
immutable per-draw uniforms or texels before and after point attenuation. It
adds no texture, upload, cache-selection rule or resource lifecycle. The prior
four-state texture/decay proof is unchanged; an additional whole-fragment
inverse checks ready, unproved, invalid, restored, editor and independent
fallback states. Neither standalone measurements nor a source expansion proves
that this combination improves hosted Intel timing or compiles on every driver.

### Scoped scalar Lambert lighting

The packed Home Lambert path expresses selected pinned Three r169 lighting
operations with local vectors and scalars. `literalLambertPointBody` covers
unshadowed point lights, `literalLambertShadowPoint` covers the literal point
shadow prefix, and `literalLambertIndirect` substitutes the indirect helper's
single accumulation at its original call site. These three options require
active, eligible point-texture transport. `literalLambertDirectional` has an
independent packed Lambert guard and does not require texture transport.

Each option defaults off in `createRoomLighting`; Home enables the options for
its existing rendering profile. Independent helper, macro and complete-block
checks keep an unsupported rewrite on its prior path. PBR materials, the
literal room shader and editor remain on their prior paths. A rejected texture
proof disables the three texture-bound rewrites without disabling an otherwise
valid directional rewrite. Each selected rewrite has its own cache-key suffix.

The implementation preserves light and run order, cached room transmission,
literal shadow sampler indices, visibility gates, attenuation, shadow
multiplication and accumulation order. Ambient, hemisphere and daylight are
accumulated before the unchanged indirect multiplication and addition. No
lights, geometry, resources, uniform slots, resolution or acceptance limits
are removed or added by these rewrites. The existing controller owns material
callbacks, validates dynamic eligibility before drawing, and handles texture
uploads, editor transitions and context recovery.

Pinned full-fragment inverses, binary32 traces and fallback/cache tests run in
the package workflow and extracted-source replay. They establish the intended
source transformation, not GPU floating-point equivalence or a general speedup.
A driver may already inline these calls; exact rendered comparisons and the
complete required browser matrix remain necessary. See the
[Lambert implementation notes](literal-lambert-directional.md) for boundaries
and the callback contract.

The `directShadowUniforms` option avoids copying the complete fragment
`PointLightShadow` and `DirectionalLightShadow` structs into temporary locals.
It reads each used field from the same uniform index at the original shadow
call. Samplers, conditions, argument order, shadow math, vertex normal bias and
all other lighting operations remain unchanged. This is a separate opt-in
rewrite for the active, owned point-texture Lambert path; the scalar-body
options remain independent.

Exact point/directional source guards and complete token counts reject unknown
source. PBR, editor, inactive texture and custom-callback variants retain their
original copies. The option defaults off and Home enables it for its existing
rendering profile. It adds no resources or uniform slots. A driver may already
eliminate these copies; source inverses alone do not establish a speedup.

The optional `scalarLambertAccumulators` option replaces only the main-scope
Lambert diffuse material field and two reflected-light accumulators with three
`vec3` locals. The existing scalar point, shadow, directional and indirect
operations keep their original order, arithmetic and positive-zero initial
values. Exact pinned source and aggregate-use checks fail closed. The option
defaults off; Home opts in only through its existing owned packed texture path.
Actual compiled spot or area lights, environment/light maps, ambient-occlusion
maps, transmission, clearcoat, sheen, iridescence and indirect-specular features
retain the original aggregate locals. PBR, editor, inactive transport and
custom callbacks also retain their original paths. No resources, uniforms, budgets or browser requirements change. A
compiler may already flatten these aggregates, so the CPU source and binary32
proofs establish no GPU equivalence or performance gain.


### Native shader initialization and light-state isolation

The native viewer keeps the startup and post-gesture shader inventories separately.
The previous state-stability assertion seeded its reference before the first gesture,
so it conflated first use of the interaction-copy program with a later Home Assistant
light-state update. The revised contract permits at most one new program during the
first diffuse-renderer gesture: its full vertex and fragment sources must exactly match
the pinned copy shader, it must be a new program rather than a relink, and an actual
copy-pass draw must use it. No other program receives this exception. Eager preparation
with no new program remains valid. A bounded observer records link identities and tiny
recognized copy sources without extra GL queries or draws; incomplete evidence fails.
Every subsequent off, partial and on update is checked against the immediately preceding
snapshot and must add no link or relink, including a relink of identical source. The
original light, graphics, load, gesture, recovery and teardown assertions remain in force.
This is an explicit test-contract revision, not a passing reinterpretation of the saved
lazy-copy failure. Existing failure evidence remains valid under its original contract;
new source and browser evidence are required before adoption. Context restoration starts
a new program epoch; the existing recovery gesture receives the same exact-copy check
while all prior link history remains recorded. First-gesture initialization still falls inside the original 15-second budget, and no timing limit changes.

### Viewer-owned resources across context recovery

The viewer releases GPU associations for every scene geometry while the WebGL
context is lost, including hidden objects, shared meshes and all cached rounded
wall variants. Geometry objects, attributes, index arrays and draw ranges stay
intact. The restored renderer uploads them when used. This removes the old
Three r169 geometry manager's disposal listeners before a later Editor cutaway
rebuild can dispose the same geometry through the restored manager. The private
interaction-copy renderer keeps its existing separate loss-time cleanup.

The CPU regression executes the pinned Three attributes, geometry and binding
managers with generation-tagged GL handles. It reproduces stale buffer and
vertex-array deletion without loss cleanup, then checks two loss/restore cycles,
hidden and shared objects, dormant wall variants, and unchanged CPU data with
the cleanup enabled.

The same loss callback releases existing scene-light shadow targets and loaded
TV screen maps, deduplicating shared references. It retains the render targets,
textures and CPU images; normal shadow invalidation and TV texture update flags
cause the restored renderer to upload them again. It does not recursively
inspect arbitrary material textures; existing material cleanup remains
unchanged. A separate pinned texture/properties-manager regression reproduces stale texture, framebuffer
and renderbuffer deletion without cleanup and checks two clean restorations
with it. These checks cover the viewer's named owners, not arbitrary resources
in third-party scenes.

Native and Playwright viewer cases now visit Editor cutaway, Editor full height
and Home after the existing context-restoration check. These real UI transitions
exercise outline disposal and rebuilding with the restored renderer, while
retaining the original scenario deadlines, case count and error checks. The
previous failure remains a failure; this regression adds coverage for its cause.
