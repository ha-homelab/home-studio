# Disposable Intel CGL comparison

The `diagnostic/intel-cgl-compare` branch alone triggers the diagnostic workflow.
It runs one `macos-15-intel` job with read-only repository permissions. It does
not call the release workflow or the 77-lane qualification gate, publish a
release, or change the default branch. Do not open a pull request for this
temporary harness.

The source checkouts are fixed full commit IDs: R13 `b6896d8` first, R14
`8be2624` second, and the zero-point guard `b3ef014` third. All tooling is
installed before any arm. The sources use the same official pinned Firefox
153.5.0esr installation and the same existing
legacy Gecko profile. Each invokes its own original native acceptance script,
including both viewer sizes, the planner, and every original assertion,
interaction and deadline. A failed arm does not prevent the remaining arms;
any failure still makes the comparison command and workflow fail. There are
no retries or substitute successful results.

The separate `diagnostic-intel-cgl-compare-*` artifact contains unchanged raw
acceptance receipts, process logs, the installation receipt, complete tracked
source hashes before and after each arm, exact commands and exit codes. The
wrapper and full native acceptance driver must have identical SHA-256 hashes
in every source; a mismatch aborts preflight before any browser runs. The
outer manifest explicitly marks the whole run diagnostic-only and not release
qualification. A running manifest and direct-to-file process logs survive an
interruption; the upload step runs even after a failed command. The workflow's
45-minute outer cap allows installation and three complete source arms; it
does not extend any original per-case deadline.

Sharing one host reduces hardware variance but does not eliminate order,
thermal or cache effects. The order is fixed; OS and driver caches are not
cleared. Compare complete case results and like-for-like shader fingerprints,
not raw program ordinals or LINK_STATUS waits presented as pure compile time.
