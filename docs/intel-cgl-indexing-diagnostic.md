# Disposable Intel Spotlight-control diagnostic

Only a push to `diagnostic/intel-cgl-indexing` starts this workflow. It has
read-only GitHub permissions and pinned actions. It does not invoke the 77-lane
acceptance gate or publish a release. Its results are diagnostic evidence only.

Two independent `macos-15-intel` jobs compare the same source in order:

- Baseline: `13b8ed9e1f0baf68eac329764a05277377113419`.
- Indexing disabled: `13b8ed9e1f0baf68eac329764a05277377113419`.

One job uses Firefox `153.5.0esr`; the other uses Waterfox `6.7.6`. Maximum
parallelism is two. Each pair runs sequentially on one hosted VM and shares one
official browser installation verified by the original installer, checksum
catalog and signature checks. Python 3.13, Node 22 and both locked npm dependency
installations are prepared before either suite starts.

After source preflight, `mdutil -a -s` records the initial Spotlight state. After
the complete baseline suite and sampler shutdown, the only host mutation is
`sudo -n /usr/bin/mdutil -a -i off`. Another `mdutil -a -s` must report indexing
disabled for every volume in the initial inventory before the second suite can
start. Unknown, incomplete or truncated status is a failure, as is any nonzero
exit, timeout or launch error. Each command has a 15-second timeout and a JSON
receipt with at most 4,096 characters each of stdout and stderr. Commands run
with `LC_ALL=C`; their output is separate from the browser evidence.

The runner checks `GITHUB_ACTIONS=true`, `RUNNER_ENVIRONMENT=github-hosted`,
`RUNNER_OS=macOS`, Python's `sys.platform=darwin` and `machine=x86_64` before
running any Spotlight command. Local and self-hosted machines are rejected.
This setting is changed only on the disposable hosted VM. There is no fixed
settling sleep, index erasure, cache deletion, service stop, or update/security
configuration change. Existing indexing work may still be observable in the
passive CPU samples; a disabled status is not proof that every worker is idle.

The wrapper invokes each source's original `test-native-browser-acceptance.py`
once, with its standard product, expected-version, installation and output
arguments. Viewer 6/24 rooms and planner 256 items, both cycles, all semantic and
graphics checks, 30-second load limits, 15-second viewer and 10-second planner
interaction limits, and the original browser watchdog remain unchanged. A
failed baseline suite does not prevent the indexing-off arm from running once
after successful control verification; any failed arm keeps the job red. The
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
status. `suiteElapsedSeconds` excludes sampler startup/shutdown and Spotlight
control overhead. Spotlight command or verification failures fail the job and
prevent the indexing-off suite; they never become passing browser evidence.

The CPU percentages are the operating system's `ps` estimates, not interval
utilization measurements. These observations can associate active work with
browser processes or other applications, but cannot establish thermal
throttling or hypervisor contention. The fixed baseline-first order and shared
driver caches also limit interpretation; one pair is not a statistical speedup
estimate.

The wrapper never substitutes a moving ref or an unavailable source. Keep this
workflow unpushed and unlaunched until the preceding comparison is terminal and
its evidence has been saved. This preparation authorizes no local setting change.

Offline contract check, with no browser or network:

```sh
python3 scripts/test-intel-cgl-indexing.py
```

The workflow supplies fixed choices. Its equivalent command on the Intel host
is:

```sh
python3 harness/scripts/run-intel-cgl-indexing.py \
  --source-root "$GITHUB_WORKSPACE" --candidate indexing-disabled \
  --product firefox \
  --installation "$RUNNER_TEMP/home-studio-intel-cgl-indexing-browser/install.json" \
  --output "$GITHUB_WORKSPACE/harness/diagnostics/intel-cgl-indexing"
```
