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
2026-10-15. Its expansion produces **73 acceptance executions**, plus one
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

Every Playwright row exercises the generated **6-room/18-light** viewer, the
larger **24-room/72-light** viewer, and the drawing tool with **2 floors,
16 rooms, and 256 furniture items**. Checks include real rendering,
interaction, light-state changes without repeated shader compilation,
intentional WebGL context loss/restoration, resource cleanup, preview
rebuilds, continued editing/export, and draft preservation. A working 2D
fallback does not count as a successful 3D test.

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

## Reproducibility and evidence

Each Playwright snapshot installs in a separate temporary directory using an
exact generated npm lock, SHA-512 package integrity, disabled install scripts,
and no optional packages. Setup verifies the installed package versions and
`browsers.json` revisions against the inventory before installing browsers.
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

If the primary planner check fails on Windows WebKit, the job runs four
diagnostic comparisons: all recovery actions after layout settles, then no
actions, editing only, and resizing only with immediate restoration. These
use `PLANNER_STABILITY_RECOVERY_ACTIONS` and `PLANNER_STABILITY_RESTORE_LAYOUT`
to isolate the extra context loss observed on this port. Evidence is saved
under `diagnostics/planner-{settled,none,edit,resize}` in the same artifact.
Every comparison runs, and any diagnostic failure also fails that step. The
primary check still requires all actions with immediate restoration and its
failure still fails the job even if every diagnostic passes.

Check the first failed assertion and actual renderer before comparing timings.
Chromium uses SwiftShader to exercise software rendering. Linux runs headed
browsers under Xvfb with software GL. Firefox profiles force WebGL enablement
and disclose the actual renderer rather than a sanitized GPU name. Playwright
Firefox 155/157 and native Firefox 158 rows on macOS select
`FIREFOX_WEBGL_BACKEND=angle` and require the reported renderer to confirm Metal
ANGLE. Playwright Firefox 153, native ESR 153, and Waterfox retain their default
WebGL backend and select `FIREFOX_COMPOSITOR_BACKEND=software` on macOS because
those releases precede the Metal ANGLE path. This changes the browser compositor,
not the WebGL rendering budget; the real graphics renderer is still recorded
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
also supported. Select `HOME_STUDIO_BROWSER_PROFILE=phone` or `tablet` for
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
and Waterfox rows use `FIREFOX_COMPOSITOR_BACKEND=software` with the default
WebGL backend. These settings apply only to disposable test profiles. Keep application
bundles unmodified so their signatures remain valid.

## Boundaries of a green result

A successful matrix covers the inventory above, not every past browser or
hardware combination. Windows Server 2022 is not the reporter's Windows 11
machine. ARM64 macOS coverage does not establish Intel Mac behavior. Hosted
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
