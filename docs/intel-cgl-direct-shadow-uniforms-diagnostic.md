# Disposable Intel direct shadow uniform diagnostic

Only a push to `diagnostic/intel-cgl-direct-shadow-uniforms` starts this workflow. It has
read-only GitHub permissions and pinned actions. It does not invoke the 77-lane
acceptance gate or publish a release. Its results are diagnostic evidence only.

This prepared comparison selects one exact runtime candidate. The selection
validator rejects placeholders, moving refs, the baseline itself, mismatched
workflow pins and any missing CPU proof command before source checkout or host
preparation. Preparation does not authorize a push or launch.

Two independent `macos-15-intel` jobs compare these sources in order:

- Direct shadow uniforms candidate, first: `227e2835d161b14b86446e20d35a0a5aa96df50e`.
- Baseline, second: `f364c49422d8a549944695ad889867e98f366145`.
- Candidate preflights: `node scripts/test-literal-lambert-point-body.cjs` and
  `node scripts/test-literal-lambert-directional.cjs`, plus
  `node scripts/test-scalar-shadow-point.cjs` and
  `node scripts/test-scalar-indirect-lambert.cjs`, and
  `node scripts/test-direct-shadow-uniforms.cjs`.

One job uses Firefox `153.5.0esr`; the other uses Waterfox `6.7.6`. Maximum
parallelism is two. Each pair runs sequentially on one hosted VM and shares one
official browser installation verified by the original installer, checksum
catalog and signature checks. Python 3.13, Node 22 and both locked npm dependency
installations are prepared before either suite starts. All five selected candidate
CPU proofs run before the browser is installed; failure stops preparation.

After both sources pass preflight, the runner records `mdutil -a -s`, invokes
`sudo -n /usr/bin/mdutil -a -i off` exactly once, and records another status.
Every volume from the initial inventory must report indexing disabled. Before
each arm, a further read-only status must confirm the same disabled inventory.
An enabled, missing, unknown, incomplete or truncated result stops the affected
suite and fails the job. The runner never repeats the mutation between arms or
repairs a changed setting mid-comparison. A prior browser failure remains in
the manifest if the next arm's status check fails.

Every Spotlight command requires `GITHUB_ACTIONS=true`,
`RUNNER_ENVIRONMENT=github-hosted`, `RUNNER_OS=macOS`, Python's
`sys.platform=darwin` and `machine=x86_64`. Local and self-hosted machines are
rejected. Commands use `LC_ALL=C`, a 15-second timeout and JSON receipts capped
at 4,096 characters each of stdout and stderr. Command errors fail the job.
There is no settling sleep, index erasure, cache deletion, service stop or
update/security configuration change. The setting changes only on the
disposable hosted VM.

This common normalization is not a proven cure for the Intel failures, and a
disabled status does not prove that existing indexing workers are idle. The
passive CPU records remain necessary context. Both sources receive the same
normalization. Fixed order and shared caches still limit causal conclusions.

The baseline already contains scalar unshadowed-point, directional, cached
shadow-point and indirect Lambert bodies. The candidate replaces the readonly
point and directional shadow struct copies with direct reads of the same uniform
fields at the same indices. All five CPU proofs run before browser installation.
The candidate runs first to expose its initial use before the baseline has warmed
this installation. It is not a guaranteed cold-driver run: setup, OS state and
persistent machine-image caches are not controlled. The later baseline can benefit
from the candidate's work. This fixed order is an intentional contrast to earlier
baseline-first pairs, not a randomized speed estimate. No performance claim is
made by preparing this harness.

The wrapper invokes each source's original `test-native-browser-acceptance.py`
once, with its standard product, expected-version, installation and output
arguments. Both original cycles of viewer 6/24 rooms, the original planner 256-item case,
all semantic and graphics checks, 30-second load limits, 15-second viewer and 10-second planner
interaction limits, and the original browser watchdog remain unchanged. A failed candidate does not prevent
the baseline from running once, and any failed arm keeps the job red. The
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

The toolchain prelude also records `machdep.cpu.brand_string`, `hw.ncpu` and
`hw.memsize` using an optional read-only `sysctl` call. Before each arm, bounded
read-only `sysctl` and `uptime` calls collect CPU model
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
control overhead. Spotlight command and verification failures never become
passing browser evidence.

The CPU percentages are the operating system's `ps` estimates, not interval
utilization measurements. These observations can associate active work with
browser processes or other applications, but cannot establish thermal
throttling or hypervisor contention. The fixed candidate-first order and shared
driver caches also limit interpretation; one pair is not a statistical speedup
estimate.

The wrapper never substitutes a moving ref or an unavailable source. Keep this
workflow unpushed until the preceding diagnostic has finished and its evidence
has been saved, local image review has passed, and launch is explicitly
authorized. A push starts these two jobs; preparing this workflow authorizes no
local setting change.

Offline contract check, with no browser or network:

```sh
python3 scripts/test-intel-cgl-direct-shadow-uniforms.py
```

The workflow supplies fixed choices. Its equivalent command on the Intel host
is:

```sh
python3 harness/scripts/run-intel-cgl-direct-shadow-uniforms.py \
  --source-root "$GITHUB_WORKSPACE" --candidate direct-shadow-uniforms \
  --product firefox \
  --installation "$RUNNER_TEMP/home-studio-intel-cgl-direct-shadow-uniforms-browser/install.json" \
  --output "$GITHUB_WORKSPACE/harness/diagnostics/intel-cgl-direct-shadow-uniforms"
```
