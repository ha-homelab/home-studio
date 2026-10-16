# Disposable Intel submitted-uniform diagnostic

Only pushes to `diagnostic/intel-cgl-uniforms` trigger this read-only,
single-runner `macos-15-intel` workflow. It checks out exact source `d934c6a`,
installs official pinned Firefox 153.5.0esr, and invokes that source's original
native acceptance entry point with its existing default/software/disabled
Gecko profile. All three cases, actions, assertions and deadlines remain
unchanged. The 20-minute job envelope also covers installation and evidence
collection; it does not extend the original case deadlines.

Only a failed original acceptance command invokes the original
`diagnose-native-draw.py`. That helper chooses an eligible failed native viewer
and captures one original first frame with the reviewed submitted-uniform and
pre-draw drain instrumentation. Its existing 600-draw/180-second bounds apply.
This instrumentation is not installed in the primary acceptance run.

Primary failure keeps the workflow red even when the diagnostic succeeds.
No retry, substitute successful receipt, PR, release publication or change to
the 77-lane gate is involved. The separate artifact is explicitly diagnostic
and non-release evidence. It retains original receipts, per-command exit codes
and logs, exact source/driver hashes before and after execution, and the shared
installation receipt. Hash checks reject any diagnostic modification of the
original primary JSON receipts. Running manifests and incremental helper logs
remain available if a process fails. No environment dump is recorded.
