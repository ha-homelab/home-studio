# Dry run for the home plan

Use **Dry run: On** in the host header to try device buttons without operating
anything. The preference is local to this browser and origin and survives reloads;
other browsers and tablets keep their own setting. Open the plan with
`?dry_run=1` to pin the mode on for that URL. Remove that parameter before changing
back to live controls. A storage failure leaves an active guard on; the header
reports when the preference could not be saved.

The host blocks switch/light/fan toggles, TV power, every curtain command
(including guard power and position checks), and native Home Assistant details.
Those details are blocked because they contain controls for locks and other
devices outside the plan's sandbox. Unknown future command types are blocked too.
The viewer receives an explicit “no command sent” result, which clears pending
controls without waiting for a device change. Displayed states remain real HA
readings; there are no simulated success responses or optimistic state updates.

Room navigation, zoom, dragging, state updates, exports and editing saved layout
placements still work. The guard applies to commands issued by this plan, not
to other HA dashboards or automations. Enabling it does not cancel a command
already delivered to HA. The dispatch path rechecks it before starting a service
call, including when the mode changes after the click.


Validation: `node --test scripts/test-dry-run.cjs` uses the production host with
fake HA services and checks every command family, blocked native dialogs, saved
preferences, URL pinning, storage denial, dispatch races and normal-mode behavior.
