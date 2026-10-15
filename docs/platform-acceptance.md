# Cross-platform acceptance

The **public `ha-homelab/home-studio` repository** validates its source package
and both browser experiences on Linux, Windows, and macOS. These tests use
fictional homes and a loopback-only simulated Home Assistant panel. They never
need a household's plan, Home Assistant token, live server, or device commands.

## What blocks a PR or release

`quality-gate.yml` calls `package.yml`, which calls
`platform-acceptance.yml`. The release pipeline calls the same quality gate
with full validation enabled. A failed platform job fails the parent workflow;
there is no report-only or allowed-failure platform. The generated release
workflows stay managed by the shared release toolkit.

Eleven native jobs run: the existing nine platform jobs plus two exact-version
Waterfox jobs. At most three package jobs, three Playwright jobs, and two
Waterfox jobs run in parallel:

- **Package and install:** Ubuntu 24.04 x64, Windows Server 2022 x64, and
  macOS 15 ARM64, with Python 3.13 and UTF-8 mode.
- **Browsers:** Chromium and Firefox on each of those three operating systems,
  with Node.js 22 and browser builds pinned by the Playwright lockfile.
- **Waterfox versions:** 6.7.5 and 6.7.6 on Windows Server 2022 x64. Both
  versions are required, including 6.7.6 from the reported issue. A green
  Playwright Firefox job cannot substitute for either Waterfox result.

These are standard GitHub-hosted runners. A Linux container pretending to be
Windows or macOS is not used. Job names identify the OS and browser, and
`fail-fast: false` lets other matrix jobs finish after a failure.

The existing Linux package job still runs localization, model, rendering-budget,
fuzz-regression, and component checks. Platform jobs add coverage rather than
replacing these focused checks.

## What the tests do

The installer suite validates archives, rejects unsafe paths and links, checks
replacement and rollback, and preserves unrelated Home Assistant files. The
distribution test compiles an invented home, installs that exact generated
archive in a temporary config directory, and checks its contents. Release tests
check the public allowlist and repeatable ZIP bytes on each host. LF checkout
rules and canonical ZIP metadata avoid platform-dependent source packaging;
same-host repeatability is not a claim of byte equality between different
compression-library versions.

Each Playwright browser job exercises:

1. A generated **6-room, 18-light** viewer inside an isolated panel iframe.
2. A larger **24-room, 72-light** viewer, using the same assertions.
3. The drawing tool with **2 floors, 16 rooms, and 256 furniture items**.

The viewer checks real loading, drag/orbit, rapid zoom input, light-state
changes without repeated shader compilation, and intentional WebGL context
loss/restoration. Closing the iframe must release its browsing context and
leave the containing page responsive.

The planner checks drawing and moving objects, opening and orbiting the 3D
preview, repeated rebuilds without resource growth, recovery after context
loss, continued 2D editing/export, and preservation of the draft after reload.
Missing WebGL, a browser crash, shader errors, or an assertion/timeout fails
acceptance. A successful fallback to 2D does not count as a successful 3D run.

The Waterfox jobs use the official Windows binaries for each pinned version,
verified against the hashes in `scripts/waterfox-versions.json`. The setup
script extracts the installer into the runner's temporary directory; it does
not replace a system browser. A separate runner drives Waterfox through its
Marionette interface with an isolated profile. These results identify the
actual Waterfox version, independently of the Playwright Firefox results.
The separate suite loads both the 6-room/18-light and 24-room/72-light viewers
twice, drags their Home view, changes light states, restores a deliberately
lost WebGL context, and closes the panel. Its 256-item planner check moves
furniture, orbits the two-floor preview, restores its graphics context, and
checks that reopening preserves the edited draft. These are the Waterfox
checks; the additional Playwright assertions above remain separate coverage.

## Read the evidence

Open the **Quality gate** or **Release pipeline** run in GitHub Actions. Each
Playwright browser job uploads `acceptance-<OS>-<engine>` for 14 days, even
after a failure. The artifact separates the small viewer, large viewer,
and planner runs.
JSON records include the source revision, actual browser version, platform,
graphics information, observations, and failures. Failed runs attempt a
screenshot; a crashed or unresponsive browser may not produce one. The job log
remains the source for dependency-install failures and runner-level timeouts.

Waterfox jobs upload `acceptance-windows-2022-waterfox-<version>` for the same
retention period. Read each version's report separately: success on one
version does not satisfy the other version's gate.

Check the first failed assertion and reported renderer before comparing
timings. Chromium deliberately uses SwiftShader to cover software rendering.
Linux runs headed browsers under Xvfb with software GL. Playwright Firefox uses
`webgl.force-enabled=true` so the GPU-less Windows VM can attempt its real
software WebGL backend. The diagnostics record this preference and the actual
renderer; all shader, context, and rendering assertions still apply. This is
coverage of that configured VM backend, not certification of Firefox's default
graphics settings. Waterfox's isolated profile also permits software WebGL and
forces WebGL enablement, with those preferences saved in each report. These
tests are bounded regression checks, not frame-rate, battery-life, or
long-duration benchmarks.

## Reproduce one browser locally

Install Python 3.13 and Node.js 22, then in a checkout:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install chromium firefox
python3 scripts/test-install-home-assistant.py
python3 scripts/test-public-package.py
node scripts/test-browser-stability.cjs
node scripts/test-planner-stability.cjs
```

On Linux, use `npx playwright install --with-deps chromium firefox` to install
system dependencies. For the same headed mode as CI, set the relevant
`*_HEADED=1` variable and prefix the Node command with `xvfb-run -a`.

Use these environment variables for a focused run (set them with your shell's
normal environment-variable syntax):

- `BROWSER_STABILITY_ENGINES=firefox` and `PLANNER_STABILITY_ENGINES=firefox`
  select Firefox; `chromium` selects Chromium.
- `BROWSER_STABILITY_ROOMS=24` selects the larger generated viewer.
- `HOME_STUDIO_DIAGNOSTICS_DIR=acceptance-artifacts/local` saves diagnostics.
- `PYTHON` can point to the exact Python executable used by the compiler.
- `PYTHONUTF8=1` matches CI's explicit UTF-8 mode.

The default generated viewer has six rooms and three lights per room. Only
use synthetic projects when publishing screenshots or diagnostic files.

## What a green matrix does not prove

Playwright Firefox is not Waterfox; its pinned browser build and the two
separately pinned Waterfox versions are distinct acceptance targets. Windows
Server 2022 is not the reporter's Windows 11 machine, and a hosted VM cannot
reproduce every GPU, driver, extension, or hardware-acceleration setting.
macOS ARM64 coverage does not establish Intel Mac or Safari compatibility.
Mobile browsers and real Home
Assistant authentication/device integrations need their own acceptance.

For a reported browser freeze, collect the exact browser/OS version, graphics
backend, whether it happens in the drawing tool or installed viewer, and a
sanitized reproduction. See [browser compatibility](browser-compatibility.md)
for existing measurements and the safe bug-report checklist.
