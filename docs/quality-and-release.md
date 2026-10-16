# How Home Studio is tested and released

**Verified snapshot: 2026-10-16.**
[Home Studio v0.6.4 is released](https://github.com/ha-homelab/home-studio/releases/tag/v0.6.4).
The final PR, beta and RC checks passed, and stable promotion preserved the
accepted RC's package bytes.

## From a browser stall to a reproducible check

A Waterfox report described loading and dragging problems. Home Studio has two
different browser applications: the drawing tool, with its own 3D preview, and
the generated viewer used in Home Assistant. Testing one does not prove that
the other works.

The investigation reproduced a shader texture-limit failure in the generated
viewer and found expensive software rendering, redundant input-driven work,
and graphics recovery bugs. These are concrete findings, not proof that every
reported browser freeze had the same cause.

The fixes bound shadow and drawing-buffer costs, combine rapid input into
scheduled frames, reuse lighting calculations, and release obsolete GPU
associations so restoration can upload fresh resources. Mode changes also
repaint when a resize alone would do nothing. The planner keeps editing and
JSON export available while its 3D context is lost.

![Graphics recovery: pause drawing on context loss, release old GPU associations,
preserve the project, rebuild rendering, then verify Home and Editor interaction.](assets/quality/webgl-recovery.svg)

### Software fallbacks have visible tradeoffs

The identified Apple software path, including a narrowly measured slow path
behind Gecko's masked renderer name, uses a simpler diffuse profile. It keeps
the model, openings, linked lights and bounded shadows, but makes these choices:

- Architectural walls keep their translucent tint, outlines and shadow casting;
  they no longer receive lighting, shadows or animated sheen in Home or Editor.
- Supported Editor floors use flat colors. Home restores their original lit
  materials. The Editor backdrop plane is hidden; real floors and the grid remain.
- The viewer uses at most **62,500 drawing pixels at rest** and **31,250 during
  camera motion**. This can soften details; HTML controls keep their resolution.
  Motion updates are combined, so intermediate positions can be less frequent.

These changes are not a claim of identical pixels or a guaranteed frame rate.
Other rendering profiles retain their documented behavior. See
[browser compatibility](browser-compatibility.md) for exact selection rules,
limits and troubleshooting, and [architecture](architecture.md) for implementation.

## What the public CI matrix covers

![Coverage overview: 77 required acceptance lanes across Linux, Windows and
macOS, comprising three install lanes and 74 browser profiles with three cases each.](assets/quality/browser-coverage.svg)

A **lane** is one required test job in a particular environment. A **browser
profile** specifies the browser build, operating system, graphics settings and
desktop or emulated mobile view being tested. The matrix has **77 required
lanes: 3 package/install lanes and 74 browser profiles** across Linux, Windows
and macOS. Each browser profile runs three cases, for **222 browser cases**:

- A generated six-room viewer with 18 linked lights.
- A generated 24-room viewer with 72 linked lights.
- The planner with two floors, 16 rooms and 256 furniture items.

The cases exercise loading, dragging, zooming, light changes, real 3D rendering,
intentional context loss, recovery and cleanup. Viewer checks return through
Editor cutaway, full-height Editor and Home after recovery. Planner checks
preserve editing and the draft. CPU regressions and package checks separately
cover geometry, shaders, lifecycle transitions, installation and public ZIPs.
Fixtures are fictional and do not connect to a real Home Assistant installation.

Coverage includes three pinned Playwright snapshots; Chrome and Edge channels;
historical Chrome for Testing builds; official Firefox 158.0 and ESR 153.5.0;
Waterfox 6.7.5 and 6.7.6; and native Safari. Intel Mac and masked-renderer lanes
exercise additional software-rendering paths. The
[exact version and lane inventory](platform-acceptance.md) is authoritative.

These are representative versions, **not every historical browser**. Playwright
WebKit is distinct from native Safari. Phone and tablet profiles emulate
viewports and input, not physical devices. Hosted Windows runners do not reproduce
every Windows desktop, and software WebGL results do not certify physical GPUs
or a reporter's existing browser profile. Passing means the recorded checks
finished within their stated limits, not that every interaction was instantaneous.

## From reviewed source to a release

![Release path: reviewed PR checks, a fully checked beta, an explicitly requested
RC with fuzzing, and human-approved stable promotion of the same RC package bytes.](assets/quality/release-pipeline.svg)

For 0.6.4, the path is **reviewed PR → beta → RC → stable**. A main-branch push
starts beta preparation. An RC is explicitly requested and reruns the required
checks and builds, adding bounded mutation fuzzing of project validation and
geometry. Fuzzing complements browser tests; it does not simulate user interaction
or prove all possible inputs safe.

Failed, cancelled, missing or unexpectedly skipped required checks block the
relevant gate. A passing browser matrix alone cannot excuse a failed package or
release job. Publication also binds the source revision, run and attempt to a
manifest and package checksums.

Stable promotion requires an accepted RC and approval of the protected release
environment. It copies the verified RC payloads **byte for byte, without
rebuilding**. It does not install an update into a private home. The
[release runbook](release-workflow.md) explains the commands and recovery rules;
the [release strategy](../RELEASING.md) defines the policy.

## Recorded results, including failures

- [Final PR run 38927296219](https://github.com/ha-homelab/home-studio/actions/runs/38927296219):
  **83 of 83 jobs passed**, including all 77 acceptance lanes and 222 browser cases.
  The additional jobs validate and coordinate the overall gate.
- [Beta run 38930021878](https://github.com/ha-homelab/home-studio/actions/runs/38930021878):
  **88 jobs passed and 3 were expected channel-specific skips**. All 77 acceptance
  lanes and 222 cases passed. An independent check verified the retained reports,
  source identity and published assets for
  [`v0.6.4-beta.2`](https://github.com/ha-homelab/home-studio/releases/tag/v0.6.4-beta.2).
- [RC run 38932840800](https://github.com/ha-homelab/home-studio/actions/runs/38932840800):
  **89 jobs passed and 2 were expected channel-specific skips**. All 77 acceptance
  lanes and 222 cases passed; the published
  [`v0.6.4-rc.1`](https://github.com/ha-homelab/home-studio/releases/tag/v0.6.4-rc.1)
  passed independent source, evidence and asset checks. Its two fuzz targets
  passed with **1,940,372 executions**: 1,137,499 for project validation and
  802,873 for wall geometry.
  These are actual engine execution counts, not a count of distinct bugs checked
  or proof of coverage of every function.
- [Stable promotion run 38935467435](https://github.com/ha-homelab/home-studio/actions/runs/38935467435):
  **3 jobs passed and 6 were expected promotion-specific skips**.
  [`v0.6.4`](https://github.com/ha-homelab/home-studio/releases/tag/v0.6.4)
  was published on 2026-10-16 at 16:58:32 UTC. All seven published assets were
  checked byte for byte against the accepted RC. Stable intentionally retains
  the RC manifest and provenance: these identify the original build and tests
  of the unchanged payloads, rather than suggesting a new build took place.

![RC fuzzing results: project validation completed 1,137,499 executions and wall
geometry completed 802,873, totaling 1,940,372; both targets passed, while full
RC qualification remains separate.](assets/quality/fuzz-results.svg)

Earlier failures remain part of the record.
[Beta run 38920644097](https://github.com/ha-homelab/home-studio/actions/runs/38920644097)
passed the browser matrix but failed publication because release notes lacked
the required guidance headings. A repository regression now checks the actual
current notes with the release parser.
[PR run 38923930252](https://github.com/ha-homelab/home-studio/actions/runs/38923930252)
failed the Intel Firefox six-room viewer's context-restoration limit. Later
changes and successful runs do not turn either earlier result into a pass.

## Read the evidence yourself

Open a linked [GitHub Actions run](https://github.com/ha-homelab/home-studio/actions)
and inspect the particular browser job, not only the overall badge. Its retained
artifact includes reports and diagnostics identifying the browser, platform,
graphics backend, source revision, timings and failures. Some failed jobs also
save a separate diagnostic replay; that replay cannot replace the original result.
Artifacts have a retention period, and downloading them may require GitHub sign-in.

For a published candidate, compare the package with its checksum and
`release-manifest.json`. Before updating, export your project JSON and back up
Home Assistant; rebuild and reinstall generated viewers to receive their changes.
If a problem persists, include the browser version, graphics backend and
acceleration setting, the failing action and a fictional reproduction. Do not
publish household plans, entity identifiers, credentials or private screenshots.
