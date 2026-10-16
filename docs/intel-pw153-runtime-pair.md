# Diagnostic Intel Firefox runtime pair

This temporary branch workflow is not acceptance or release evidence. It runs
only on a push to `diagnostic/intel-pw153-runtime-pair`, on one GitHub-hosted
`macos-15-intel` machine. It neither calls nor changes the required 77-lane gate.
The baseline is `873c6d9724fba22aec7677c8cc87c95d29808e8a`.

The selected diagnostic candidate is
`8692a8eaf752852d6ea59200bb8cf09402861510`, a direct child of the baseline.
Its only changes are two ground-visibility assignments in `viewer.js` and
`home-view.js`: the existing Apple software profile hides the exterior Editor
ground plane while retaining the grid. Antialiasing, context settings, Home
materials and all other profiles are unchanged. This is an intentional visual
tradeoff under investigation, not a claim of exact pixels or production approval.
Selection fails before setup if either full source pin or the complete two-file
changed inventory is missing or inconsistent. Protected drivers, fixtures, installers and manifests
must be identical between the two sources. Both source trees are hashed before
and after the sequence and at every case boundary.

The browser is the failing Playwright Firefox **153.0** lane, using Playwright
**1.62.1**, not the separate native Firefox ESR browser. The original installer
checks the pinned npm integrity and browser metadata. Both sources use the same
installation and the original headed desktop/software-compositor preferences.
The original raw reports must identify Intel macOS and Apple Software Renderer.
No shader instrumentation, GL query, extra render, or screenshot is added.

The fixed order is candidate6, baseline6, candidate24, baseline24. Each runs the
original `node scripts/test-browser-stability.cjs` in a fresh process and keeps
both original cycles, all actions, and all assertions. The 30s bootstrap, 180s
scenario, 60s cold load, 15s drag, 10s Editor settle and 245s hard browser-process
limits remain unchanged. The 40-minute job envelope includes four existing
120s fixture-build ceilings and the bounded 12-minute installation step.
The orchestrator additionally bounds each complete Node process at 375s
(120s fixture build + 245s browser watchdog + 10s allowance), then terminates
only its process group. This host ceiling does not extend either original
deadline; an overrun remains a failed diagnostic even if a passed report exists.

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

Candidate6 runs first to observe its cold critical path. Fresh browser profiles
do not reset shared macOS CGL caches, so later baseline timing is order-confounded.
A successful pair is useful candidate evidence, not a substitute for the full
quality gate or proof of stable performance across hosts. No automatic promotion,
PR mutation, release or follow-up run occurs.
