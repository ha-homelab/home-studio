# Disposable Intel first-state sequence comparison

This diagnostic has one Firefox ESR 153.5.0 job on `macos-15-intel`.
It runs the original native three-case acceptance suite, first at
`7b7a896225aaf27fef26a135d654dfaddffe2c08`, then at
`c21669ccead7774a588f114c630db54082617fee`. All original two-cycle viewer
actions, load/drag limits, backend checks, screenshots, recovery and teardown
assertions remain in the original source drivers. A failed arm remains failed
and makes the workflow red. These results never count toward the release gate.

The candidate already contains a fixed 100 ms embedded-state rendezvous. This
harness does not modify that duration, host state delivery, readiness, rendering
or shaders. The current local ARM comparison was slower; the hosted comparison
tests whether the actual Intel environment behaves differently, without assuming
that skipping the offline frame eliminates eventual shader compilation.

Both arms use the same test-only Node preload. Three exact fixture-source anchors
add a passive wrapper that records CPU state immediately before the first
natural scene render of each iframe: connection state, render count, Home mode,
owned/visible/active point-light counts and the page clock. It skips copy scenes.
There are no added GL calls, shader queries, priming draws, timers or awaits.
The original render result and exception pass through unchanged.

One unawaited POST per iframe goes to the existing loopback fixture process,
which persists a bounded `first-natural-render.jsonl`. The endpoint accepts only
the fixed schema, at most two distinct page time origins, and binds each stamp
to the served source hash. This small observer/HTTP overhead is present in both
arms. Request arrival order is not a precise wall-clock synchronization signal.

`first-render-adaptation.json` records original and adapted fixture hashes plus
both helper hashes. The expected adapted fixture hash is computed with the same
pure adapter on each pinned source before either suite starts, then compared to
the actual preload receipt. The comparison verifies original driver/dependency equality,
source and installation identity before/after each arm, and records the common
indexing-off state and bounded CPU observations. No source checkout is patched.

The original primary files and exit codes are never rewritten. Separate
`first-render-observations.json` records missing evidence or a candidate first
draw that is offline/not fully lit. Such a case makes this diagnostic incomplete
and red even if its original suite passes; it must not be described as proof that
the intended sequence change occurred. A passing viewer requires two stamps.
Earlier primary failures may leave fewer stamps, which remain preserved.
If the baseline also starts fully live, the run did not establish an offline to
live sequence contrast, regardless of whether both original suites passed.

The fixed baseline-first order shares OS/driver caches. Interpret differences as
one controlled observation, not a randomized speed estimate. The workflow only
responds to `diagnostic/intel-cgl-states-first`, uses read-only permissions and
pinned actions, and does not trigger the full release matrix or publish assets.

Offline checks:

```sh
python3 scripts/test-intel-cgl-states-first.py
node scripts/test-first-natural-render.cjs
```
