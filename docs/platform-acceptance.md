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

The positively identified Apple Software Renderer uses Lambert materials and
unfiltered shadows. Acceptance keeps the same scene, linked-light counts,
shadow-map limits, state changes and interaction deadlines in this mode. It is
a deliberate matte rendering profile, not a claim of pixel identity with PBR.
CPU tests cover the actual material factories and both shader families, including
transparency, clipping, wall tint and room-light composition.

Gecko can mask both hardware and software renderers as exactly `Apple M1, or similar`.
Only that exact label with a Gecko user agent runs a capacity probe, once per
new rendering context (including the planner's replacement context). It uses the
existing WebGL2 context, a private 32 × 32 RGBA8 framebuffer, and a fixed
512-iteration fragment shader: two warm draws and three timed draws, each with a
one-pixel readback. Valid, nonzero and nonsaturated RGB readbacks that vary across the seeds, and a **minimum of at least 15 ms**
across all three measured draws selects the same reduced pixel/shadow budgets,
Lambert lighting and planner batching. This measures raster capacity; it does
not identify the underlying GPU as software. Other renderer labels are not probed.

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
129 vectors (including one for the private wall-sheen switch) plus seven per light
slot, four per room, one per polygon edge, two per window, and one per room with
windows (at least one reserved slot). The guard budgets 843 of the Apple software renderer's reported
1,024 vectors for the 24-room, 72-light fixture. Lower limits and larger plans fall back to
the original literal geometry without reducing scene contents. CPU regression
tests cover polygon boundaries, concave rooms, window ordering and this fallback.

Packed daylight traversal visits only rooms that own windows, in the original
room order. Window order, transmission and distance calculations remain the
same; a plan without windows omits the daylight loop. The additional index
array is included in the uniform allowance above, including its one-slot empty
fallback. The normal material path and low-uniform fallback keep their original
shader source.

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
private per-material wall-tint switch. Opaque floors and frames use explicit
`NoBlending`, which preserves their already-disabled GPU blending while avoiding
a separate opaque shader define. Walls retain their transparency and depth
state. Textured, alpha-tested, differently sided, dynamic and mixed-role
materials keep separate programs. A later attachment restores any owned blend
setting and keeps cached uniform references current. Regression checks cover
reattachment, material ownership and low-uniform fallback; visual diagnostics
also check the actual GPU switch, blending, culling and depth state across draws.
Fewer programs can reduce first-use work, but do not guarantee a speedup on every
driver; the complete timed acceptance matrix remains required.

Viewer receipts retain the existing native drag phase timings for Home and the
editor, followed by the existing two-animation-frame completion wait. These
measurements add no input actions or rendered frames; the same total duration
continues to determine whether the interaction passes.

The diffuse viewer coalesces subsequent camera-motion frames within a fixed
64 ms deadline after its first successful motion frame. Lifecycle regressions
check that held drags still repaint, later input cannot postpone the deadline,
and release, live-state updates, resize, suspension and context loss leave no
stale delayed work. Browser acceptance still requires real motion rendering
and a final full-resolution frame; reducing the number of draws cannot replace
either assertion.

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
The additional uniform allowance above accounts for the selected run starts.

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

Playwright receipts also retain Node-side `phases` with start, completion, and
duration times in milliseconds from the case's monotonic clock. Viewer phases
distinguish loading, input, state updates, restoration, and iframe detachment.
These markers add no browser evaluations or rendering work. If the whole-case
deadline expires, `timeoutPhase` preserves the active phase before diagnostic
capture begins. The asynchronous test callback can still finish work while
failure evidence is captured, so later sample fields or completed phase entries
do not prove that work finished before the deadline; consult `timeoutPhase`.

Legacy native Gecko rows on macOS enable `NATIVE_STARTUP_DIAGNOSTICS=1`.
A separate loopback fixture process saves at most forty startup checkpoints,
including the reported renderer, selected rendering profile, first two shader
compilations and first eight program links/status queries, even if the browser's
main thread later stalls. Program indices distinguish an initial shadow shader
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
and disclose the actual renderer rather than a sanitized GPU name. Playwright
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
