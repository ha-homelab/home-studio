# Disposable Intel fallback-boundary diagnostic

Only a push to `diagnostic/intel-cgl-boundaries` starts this workflow. It has
read-only permissions and pinned actions. It does not invoke the 77-lane
acceptance gate or publish a release. Its results are diagnostic evidence only.

Two independent `macos-15-intel` jobs compare these exact sources in order:

- Baseline: `13b8ed9e1f0baf68eac329764a05277377113419`.
- Restored fallback boundaries: `800acbda7b8692b8c18d73e4be7b00211c552ff3`.

One job uses Firefox `153.5.0esr`; the other uses Waterfox `6.7.6`. Maximum
parallelism is two. Each pair runs sequentially on one hosted VM and shares one
official browser installation verified by the original installer, checksum
catalog and signature checks. Python 3.13, Node 22 and both locked npm dependency
installations are prepared before either suite starts.

The candidate restores the fallback-box program boundaries while retaining the
software pointer-motion change. This isolates the program-sharing change from
the other R16-to-R17 changes. The previously prepared architecture comparison is
unchanged; this is a separate, explicitly triggered experiment.

The wrapper invokes each source's original `test-native-browser-acceptance.py`
once, with its standard product, expected-version, installation and output
arguments. Viewer 6/24 rooms and planner 256 items, both cycles, all semantic and
graphics checks, 30-second load limits, 15-second interaction limits and the
original browser watchdog remain unchanged. A failed baseline does not prevent
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
and counts, machine model, memory size, boot time and load averages. No process
inventory, environment dump or credentials are recorded. These fields do not
measure CPU utilization, thermal throttling or hypervisor contention. The fixed
baseline-first order and shared driver caches also limit interpretation; one
pair is not a statistical speedup estimate.

Publish the exact candidate commit before pushing this disposable branch. The
wrapper never substitutes a moving ref or an unavailable source. The prepared
workflow must be held until the separate architecture run has completed and
its evidence has been saved.

Offline contract check, with no browser or network:

```sh
python3 scripts/test-intel-cgl-boundaries.py
```

The workflow supplies fixed choices. Its equivalent command on the Intel host
is:

```sh
python3 harness/scripts/run-intel-cgl-boundaries.py \
  --source-root "$GITHUB_WORKSPACE" --candidate fallback-boundaries \
  --product firefox \
  --installation "$RUNNER_TEMP/home-studio-intel-cgl-browser/install.json" \
  --output "$GITHUB_WORKSPACE/harness/diagnostics/intel-cgl-boundaries"
```
