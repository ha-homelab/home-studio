# Disposable Intel shader architecture diagnostic

Only a push to `diagnostic/intel-cgl-architecture` starts this workflow. It has
read-only repository permissions, pinned actions and no release or PR operation.
The existing 77-lane acceptance gate is unchanged and is not invoked by this
branch push. None of these results grants acceptance or release eligibility.

Each of four independent `macos-15-intel` jobs runs the common baseline
`13b8ed9e1f0baf68eac329764a05277377113419`, then one candidate, sequentially on
the same hosted VM:

- Point-count guard: `fef79d899c24371c41f94d22938851c07569d55a`.
- Local Lambert arithmetic: `9590f9944359785edf5634df8cfa9a20cee35aac`.

Each candidate has a Firefox `153.5.0esr` pair and a Waterfox `6.7.6` pair.
At most two jobs run concurrently. Each pair installs one official binary using
the baseline's original installer, checksum catalog and signature validation,
then uses that same installation for both sources. Python 3.13, Node 22 and both
locked npm dependency installations are prepared before any suite begins.

The wrapper invokes each source's original `test-native-browser-acceptance.py`
once, with only product, expected version, installation and output arguments.
All three original cases (viewer 6/24 rooms and planner 256 items), two-cycle
actions, deadlines, 30-second connected-load limit, 15-second interaction limit,
graphics checks and teardown checks remain inside the unchanged original suite.
The profile is headed, unmasked, default WebGL, software compositor and disabled
GPU process, with original passive startup diagnostics enabled. The actual
renderer in each receipt, rather than the requested profile alone, determines
which backend was exercised. Unexpected inherited fixture overrides abort setup.

Before either suite, every tracked file is hashed and exact clean revisions are
required. The native drivers, installer/catalogs, browser fixture scripts,
diagnostic helpers and npm manifests must be byte-identical across both arms.
Each source is hashed again after its suite, including after an ordinary failed
case. An altered source or installation receipt fails the comparison. Original
raw receipts and process output remain untouched; any failed arm keeps the job
red while the next arm still runs once. There is no retry, failure replay, fenced
draw probe or modified pass criterion. The 30-minute job envelope includes setup
and both suites; it does not extend their original individual limits.

`comparison.json`, `source-before.json`, `source-after.json`, `host-before.json`,
`process.log`, the original `raw/` receipts and installation/toolchain logs are
retained in a separate diagnostic artifact for each product/candidate pair.
The manifest labels all output `diagnosticOnly: true`, `releaseEligible: false`.
Immediately before each arm, bounded read-only `sysctl` and `uptime` commands
record CPU model and logical/physical counts, machine model, physical memory,
boot time and uptime/load averages. Missing fields/errors remain explicit; these
are not CPU utilization, memory-pressure or hypervisor-contention measurements.
No environment dump or process inventory is captured.

The fixed baseline-first order and shared OS/driver caches are disclosed in each
manifest. Pairs on different VMs are not controlled cross-VM comparisons. A
passing candidate beside a failing baseline does not make the job green, and a
single pair does not establish statistical speedup. Publish the exact source
commits to the repository before pushing this disposable branch; the harness
does not replace unavailable commits or select moving refs.

Local offline contract check (no browser or network):

```sh
python3 scripts/test-intel-cgl-architecture.py
```

The workflow passes fixed choices to the wrapper; the equivalent manual form on
an Intel macOS runner with the two exact checkouts in `baseline/` and `candidate/`
is:

```sh
python3 harness/scripts/run-intel-cgl-architecture.py \
  --source-root "$GITHUB_WORKSPACE" --candidate point-count-guard --product firefox \
  --installation "$RUNNER_TEMP/home-studio-intel-cgl-browser/install.json" \
  --output "$GITHUB_WORKSPACE/harness/diagnostics/intel-cgl-architecture"
```
