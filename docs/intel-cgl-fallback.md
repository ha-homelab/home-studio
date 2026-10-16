# Disposable Intel CGL fallback comparison

Only a push to `diagnostic/intel-cgl-fallback` starts this workflow. It runs one
`macos-15-intel` job with read-only repository permissions and pinned actions.
It does not invoke the 77-lane qualification gate, publish releases, or change
the default branch. Do not open a pull request for this temporary harness.

The two fixed source revisions run in this order:

1. Packed-run baseline `9b8d52b164eb1364ce8504063096a506c63100eb`.
2. Fallback shared-program candidate `f4a9ebba66b8f7ddce017535092f1885fbbfa8c0`.

The candidate includes a test-only correction after its runtime commit
`b9221051c2cb3a8ab0a9fa36d9f18eebac16fa34`; runtime bytes are unchanged by that
correction. Both source revisions retain compact light-run records and the
zero-point guard. The disposable harness commit descends from the candidate,
so one branch push makes both exact source revisions available without
rewriting or separately pushing either source.

All tooling and fixture dependencies are installed before either arm. Both
use one official checksum- and signature-verified Firefox 153.5.0esr installation
with the existing legacy profile: default WebGL backend, software compositor,
disabled GPU process, and unmasked renderer. Each arm invokes its own original
native acceptance script for viewer-6, viewer-24, and planner, with every
original assertion, interaction, and per-case deadline unchanged. The two
acceptance driver files must have equal SHA-256 hashes across sources; a
mismatch fails setup before any browser starts. A failed arm is retained and
the second arm still runs once. Any failure makes the job fail; there are no
retries, substituted results, or extra fenced frame diagnostics in these primary arms.

The separate `diagnostic-intel-cgl-fallback-*` artifact retains original raw
receipts and startup logs, process logs, installation provenance, all tracked
source hashes before and after each arm, exact commands, and exit statuses.
The running manifest and direct-to-file logs preserve partial evidence if the
job stops. `diagnosticOnly: true`, `releaseEligible: false`, and
`acceptanceStatus: not-run` label the envelope; the original source receipts
are not rewritten. Artifacts upload even on failure. The 30-minute outer cap
allows installation plus six original cases and does not extend their limits.

The order is fixed baseline first; OS and driver caches are shared and are not
cleared. Same-host measurements reduce hardware variance but retain cache,
thermal, and order effects. Compare complete case outcomes and matching shader
fingerprints. A LINK_STATUS wait can drain preceding GPU work and is not proof
of pure compiler time. Program-count reduction alone is not a speed result.

## Separate restore observation after an actual failure

Only after the comparison step fails, a second step checks the candidate's
same-job viewer-24 receipt. A single passive replay is eligible only for a
failed Darwin record at the exact candidate SHA with both cycles reached,
second-cycle light states `72, 0, 36, 72` completed, no recovery snapshot, and
the original restore API call present in the failure traceback. Other failures
and successful cases do not launch a replay. The original comparison step
remains failed even if this observation completes.

The replay verifies the clean candidate checkout, all five recorded runtime
hashes, and the exact same installation, then invokes the original two-cycle
viewer case with only passive restore-call, event, and first restored-frame
observation. It adds no render, GPU fence, GL readback, or longer timeout. A
separate 180-second process-group supervisor includes its setup; the unchanged
browser watchdog and 30-second load/script and 15-second interaction limits
remain. Partial console/host logs survive a stall. Up to 600 draw calls are
observed, with bounded event output; reaching a cap is incomplete evidence.

Replay output is isolated in `candidate-restore-replay`, outside the candidate's
`raw` directory. Every original raw file is hashed before and after; source
runtime hashes and the installation receipt are checked again afterward.
This evidence has `diagnosticOnly: true`, `releaseEligible: false`, and
`acceptanceStatus: not-run`. It never rewrites primary receipts or changes their
exit codes. Its presence does not authorize a production change or release.
