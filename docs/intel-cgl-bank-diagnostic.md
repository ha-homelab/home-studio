# Disposable Intel bounded-light-bank diagnostic

Only a push to `diagnostic/intel-cgl-bank` starts this workflow. It has
read-only permissions and pinned actions. It does not invoke the 77-lane
acceptance gate or publish a release. Its results are diagnostic evidence only.

Two independent `macos-15-intel` jobs compare these exact sources in order:

- Baseline: `13b8ed9e1f0baf68eac329764a05277377113419`.
- Bounded PointLight bank: `3422c417faaf139f1f92f19604a80715128fa787`.

One job uses Firefox `153.5.0esr`; the other uses Waterfox `6.7.6`. Maximum
parallelism is two. Each pair runs sequentially on one hosted VM and shares one
official browser installation verified by the original installer, checksum
catalog and signature checks. Python 3.13, Node 22 and both locked npm dependency
installations are prepared before either suite starts.

The unchanged candidate gives eligible immutable geometry a local PointLight
bank of at most 32 records, while retaining the original shadow prefix. It
preserves all scene lights and selects the original full program for unsupported
geometry or inputs. Local ARM64 startup was neutral; no Intel improvement is
established. This is a separate, explicitly triggered contingency experiment.

The wrapper invokes each source's original `test-native-browser-acceptance.py`
once, with its standard product, expected-version, installation and output
arguments. Viewer 6/24 rooms and planner 256 items, both cycles, all semantic and
graphics checks, 30-second load limits, 15-second viewer and 10-second planner
interaction limits, and the original browser watchdog remain unchanged. A failed baseline does not prevent
the candidate from running once, and any failed arm keeps the job red. The
30-minute job envelope includes setup and both suites; it does not extend an
individual case deadline.

The profile is headed and unmasked, with default WebGL, software compositor,
disabled GPU process and the original passive startup diagnostics. Actual
renderer identities are retained in the original receipts. Unexpected inherited
fixture overrides abort setup without logging their values.

Every tracked source file is hashed before and after its suite. Native drivers,
installers/catalogs, fixture/diagnostic helpers and npm manifests must match
between arms. Source or installation-receipt mutation fails the comparison.
Separate diagnostic artifacts retain raw reports and process logs, source
hashes, installation/toolchain logs and the comparison manifest. That manifest
always states `diagnosticOnly: true`, `acceptanceStatus: not-run` and
`releaseEligible: false`.

Before each arm, bounded read-only `sysctl` and `uptime` calls collect CPU model
and counts, machine model, memory size, boot time and load averages. A separate
`cpu-processes.jsonl` saves the eight highest `ps` CPU consumers before the suite,
every five seconds while it runs, and after it exits. Fields are limited to PID,
parent PID, reported CPU percentage, RSS in KiB and executable basename. No
arguments, full executable paths, environment values or raw `ps` output are
saved. Each capture has a two-second timeout; at most 240 records are attempted
per arm, reserving the final record for the post-suite sample. The thread is
stopped and joined before source verification or the next arm. Capture errors
are retained as diagnostic records and never replace the original suite exit
status. `suiteElapsedSeconds` excludes sampler startup and shutdown overhead.

The CPU percentages are the operating system's `ps` estimates, not interval
utilization measurements. These observations can associate active work with
browser processes or other applications, but cannot establish thermal
throttling or hypervisor contention. The fixed baseline-first order and shared
driver caches also limit interpretation; one pair is not a statistical speedup
estimate.

Publish the exact candidate commit before pushing this disposable branch. The
wrapper never substitutes a moving ref or an unavailable source. Keep this
workflow unpushed and unlaunched while the fallback-boundary comparison runs.
It is a contingency only if that comparison fails to resolve Intel acceptance;
its terminal evidence must be saved before any decision to run this experiment.

Offline contract check, with no browser or network:

```sh
python3 scripts/test-intel-cgl-bank.py
```

The workflow supplies fixed choices. Its equivalent command on the Intel host
is:

```sh
python3 harness/scripts/run-intel-cgl-bank.py \
  --source-root "$GITHUB_WORKSPACE" --candidate bounded-bank \
  --product firefox \
  --installation "$RUNNER_TEMP/home-studio-intel-cgl-bank-browser/install.json" \
  --output "$GITHUB_WORKSPACE/harness/diagnostics/intel-cgl-bank"
```
