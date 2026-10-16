# Diagnostic Intel Firefox runtime pair

This temporary branch workflow is not acceptance or release evidence. It runs
only on a push to `diagnostic/intel-pw153-pixels625-pair`, on one GitHub-hosted
`macos-15-intel` machine. It neither calls nor changes the required 77-lane gate.
The baseline is `1d8c4dde1a6e02b2f992711fabbb370fd77488a7`.

The selected diagnostic candidate is
`7cc7031f860578d7e066fccd33543dce2bd43dbc`, a direct child of the baseline.
The only runtime difference is the existing Apple software profile's pixel
budgets in `viewer.js`: resting 125000→62500 and interaction 62500→31250.
The other five changed files are the changelog, compatibility documentation and
three focused CPU proofs. Hardware profiles, antialiasing, context settings and
all acceptance drivers remain unchanged. This reduces image resolution under
investigation; it is not a claim of exact pixels or production approval.
Selection fails before setup if either full source pin or the complete six-file
changed inventory is missing or inconsistent. Protected drivers, fixtures, installers and manifests
must be identical between the two sources. Both source trees are hashed before
and after the sequence and at every case boundary.

The browser is the failing Playwright Firefox **153.0** lane, using Playwright
**1.62.1**, not the separate native Firefox ESR browser. The original installer
checks the pinned npm integrity and browser metadata. Both sources use the same
installation and the original headed desktop/software-compositor preferences.
The original raw reports must identify Intel macOS and Apple Software Renderer.
No shader instrumentation, GL query, extra render, or screenshot is added.

The fixed order is baseline6, candidate6, candidate24, baseline24. Each runs the
original `node scripts/test-browser-stability.cjs` in a fresh process and keeps
both original cycles, all actions, and all assertions. The 30s bootstrap, 180s
scenario, 60s cold load, 15s drag, 10s Editor settle, 30s context restoration
and 245s hard browser-process limits remain unchanged. The 40-minute job envelope includes four existing
120s fixture-build ceilings and the bounded 12-minute installation step.
The orchestrator additionally bounds each complete Node process at 375s
(120s fixture build + 245s browser watchdog + 10s allowance), then terminates
only its process group. This host ceiling does not extend either original
deadline; an overrun remains a failed diagnostic even if a passed report exists.

After each original driver exits, the summary copies its existing context-loss,
restoration and three post-restore mode timing fields. Incomplete durations stay
null; no new instrumentation or acceptance inference is added.

Every case runs once. The orchestrator records nonzero exits and original failed
reports without rewriting them, then executes the remaining predeclared cases
only when the final original summary and browser-close receipt establish clean
teardown. An outer host timeout, missing/corrupt report, or unproved cleanup
aborts the pair and explicitly records the remaining cases as not run. Playwright
starts Firefox in a separate process group; this tool terminates only the owned
Node group and relies on ephemeral job teardown for an unproved detached browser.
It never searches for or kills unrelated browsers or shared CGL/compiler services. Any failed,
missing, or mismatched case makes the final diagnostic fail. Raw logs, source
hashes, indexing state and all reports are uploaded even on failure under a
unique `diagnostic-` artifact name. Installation may use the existing transient
transport retry; no browser/test retry is introduced.

Baseline6 runs first, followed by candidate6, candidate24 and baseline24.
Fresh browser profiles do not reset shared macOS CGL caches, so this fixed
sequence cannot establish an order-independent speedup.
A successful pair is useful candidate evidence, not a substitute for the full
quality gate or proof of stable performance across hosts. No automatic promotion,
PR mutation, release or follow-up run occurs.
