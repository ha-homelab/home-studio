# Try device controls without operating them

In the installed plan's host header, enable **Dry run: On**. For a display that
should start guarded every time, bookmark its plan URL with `?dry_run=1` (or
`&dry_run=1` after an existing query). The pinned URL disables the mode switch.

Switches, lighting, TV power, curtain commands, and native Home Assistant dialogs
are blocked at the host boundary. This includes dialogs through which a lock
could otherwise be operated. A press reports that **no command was sent**.
Readings stay real; navigation and saved layout editing still work.

![Trusted host separates guarded commands from real state updates](../images/dry-run-command-flow.svg)

A saved setting applies to this browser and origin. It does not restrict other
Home Assistant clients or automations, and it cannot cancel an action already
sent. Dry run is not a touch lock or a simulation. If your display uses a
separate permanently read-only application, there is no live-control switch.

Read [the full Dry run reference](../dry-run.md) for storage failures, the
command allowlist, dispatch races, and safe verification.

[Documentation home](Home.md) · [Troubleshooting](Troubleshooting.md)
