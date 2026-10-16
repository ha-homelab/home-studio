# Disposable Intel copy program isolation diagnostic

Only a push to `diagnostic/intel-cgl-copy-program-isolation` starts this workflow. It has
read-only GitHub permissions and pinned actions. It does not invoke the 77-lane
acceptance gate or publish a release. Its results are diagnostic evidence only.

This prepared comparison selects one exact runtime candidate. The selection
validator rejects placeholders, moving refs, the baseline itself, mismatched
workflow pins and any missing CPU proof command before source checkout or host
preparation. Preparation does not authorize a push or launch.

Two independent `macos-15-intel` jobs compare these sources in order:

- Copy deferral candidate, first: `258056dfd6426b90826f7ca75747ede77c636814`.
- Baseline, second: `5563e3fdc147c81931389743836610ba611e7026`.
- Candidate preflights: `node scripts/test-literal-lambert-point-body.cjs` and
  `node scripts/test-literal-lambert-directional.cjs`, plus
  `node scripts/test-scalar-shadow-point.cjs` and
  `node scripts/test-scalar-indirect-lambert.cjs`, and
  `node scripts/test-direct-shadow-uniforms.cjs`, and
  `node scripts/test-scalar-lambert-accumulators.cjs`, and
  `node scripts/test-interaction-render.cjs` and
  `node scripts/test-render-lifecycle.cjs` and `node scripts/test-native-viewer-programs.cjs`.
- Both-arm contract checks are listed below.

One job uses Firefox `153.5.0esr`; the other uses Waterfox `6.7.6`. Maximum
parallelism is two. Each pair runs sequentially on one hosted VM and shares one
official browser installation verified by the original installer, checksum
catalog and signature checks. Python 3.13, Node 22 and both locked npm dependency
installations are prepared before either suite starts. All selected candidate and contract
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

Both sources retain the explicit strict native contract introduced at
`258056dfd6426b90826f7ca75747ede77c636814`. The eager baseline reverses only
commit `40333d36c2a3d3ed110ebc4dc6513239b56b1aa2`: the interaction renderer,
its CPU test and 16 documentation lines. The native driver, passive observer,
its CPU tests and source inventory remain identical. The candidate defers the
unused interaction-copy program and texture until actual motion; the baseline
prepares them during the initial full draw. All other runtime files are equal.

The protected driver reference for this experiment is **258056d**, not the
older 7b or 7491 driver. The original 40333 run failed the old state-program
assertion and remains failed. This experiment does not reclassify it. The new
contract permits at most one newly linked, exact-source copy program during
real first motion on the positively identified software profile. It checks
link identity, current context epoch, genuine copy draws and no outside-copy
use. The following state changes must introduce no new links or altered
program identities. Missing or inconsistent observer evidence fails closed.
All original load, drag, state, 3D, restoration and shutdown limits remain.

Nine candidate JavaScript proofs run before browser installation: the six
inherited scalar-lighting proofs, interaction-render, render-lifecycle and
native-viewer-programs. The baseline interaction and native-program proofs
also run, together with test-waterfox-tooling.py on **both** sources. These
checks exercise the revised contract and eager/lazy implementations; they do
not provide browser acceptance credit. No primer or BRDF-cache option is used.

The candidate runs first to expose its initial use before the baseline has warmed
this installation. It is not a guaranteed cold-driver run: setup, OS state and
persistent machine-image caches are not controlled. The later baseline can benefit
from the candidate's work. This fixed order is an intentional contrast to earlier
baseline-first pairs, not a randomized speed estimate. No performance claim is
made by preparing this harness.

The wrapper invokes each source's identical 258056d-contract `test-native-browser-acceptance.py`
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

Every tracked source file is hashed before and after its suite. Fifteen protected
files (the 12 existing drivers/dependencies plus the new
observer, its JavaScript test and Python tooling contract tests) must match
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
python3 scripts/test-intel-cgl-copy-program-isolation.py
```

The workflow supplies fixed choices. Its equivalent command on the Intel host
is:

```sh
python3 harness/scripts/run-intel-cgl-copy-program-isolation.py \
  --source-root "$GITHUB_WORKSPACE" --candidate copy-program-isolation \
  --product firefox \
  --installation "$RUNNER_TEMP/home-studio-intel-cgl-copy-program-isolation-browser/install.json" \
  --output "$GITHUB_WORKSPACE/harness/diagnostics/intel-cgl-copy-program-isolation"
```
