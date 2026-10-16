# Dry run for the home plan

Dry run lets you try the installed plan's device buttons while continuing to
see real Home Assistant readings. The plan does **not** send device commands or
pretend that the requested action happened. A lamp can still change on screen
when a person, automation, or another dashboard changes the real lamp.

## Enable it on a display

1. Open **3D Home** in Home Assistant.
2. In the host header above the plan, enable **Dry run: On**. These labels follow
   the selected interface language.
3. For a display that must always start guarded, add `?dry_run=1` to the plan's
   URL. If the URL already has a query, append `&dry_run=1`. Bookmark that URL.
4. Select a linked device. The feedback should say that no command was sent;
   its state continues to reflect Home Assistant.

The URL pins Dry run on and disables the switch. To return to live controls,
remove the `dry_run` parameter, reload, and turn Dry run off if the browser's
saved preference is still on. Do this only on a display intended for live control.

The preference is local to this browser and origin. A different browser,
profile, tablet, or Home Assistant origin has its own preference. A new browser
with readable, empty storage and no pinned URL starts with live controls. If
storage cannot be read or a stored value is invalid, the guard starts on. This is
not an account-wide policy or a substitute for Home Assistant permissions.

## What is blocked

The trusted host blocks these requests before dispatch:

- Light, switch, input-boolean, and fan toggles.
- TV power commands.
- Every curtain command, including position changes, stop, guard power,
  and position-check operations.
- Native Home Assistant details dialogs. They can contain lock, TV, or other
  device controls outside the plan, so opening them would bypass the guard.
- Unrecognized viewer message types, until they are explicitly classified.

The viewer gets a result marked `dry_run: true`, with `ok: false` and explicit
feedback. Pending buttons are released without waiting for a device change.
There is no optimistic state update, synthetic “on” state, or fake success.

Navigation, room selection, zoom, dragging, language selection, model exports,
and saved layout editing remain available. Saving a placement **does** change
that layout; Dry run only guards device operations. Use a copied project when
you want to experiment with layout edits without saving them.

![Device requests pass through the trusted host guard; live readings use a separate path](images/dry-run-command-flow.svg)

## Why the guard is in the host

The plan is an iframe with a restricted sandbox. It cannot be trusted to enforce
its own device policy. Its dedicated MessagePort goes to the authenticated host,
which checks the active viewer generation, saved entity bindings, and permitted
message types. Dry run adds a guard at this boundary and again immediately before
service dispatch. A click queued before enabling Dry run is therefore rechecked.
A command already delivered to Home Assistant cannot be recalled by this switch.

The guard protects commands issued **through this plan**. It does not stop other
Home Assistant dashboards, automations, integrations, or an administrator using
their own credentials. It is also not a full-screen kiosk lock or a screen-touch
lock. A deployment needing permanent read-only access should expose only a
read-only data interface, as the separate legacy tablet implementation does.

## Persistence and storage failures

The host stores the preference under `home-floorplan:dry-run`. Changes propagate
to other open plan tabs on the same origin; a pinned tab remains guarded.
Clearing or removing the preference guards existing tabs receiving that storage
event, but a later fresh page with empty readable storage has no saved guard.
An active guard
stays on if saving a request to turn it off fails. Enabling the guard still works
for the current page when storage is denied, and the header explains that the
URL parameter is needed to retain it after reload. Clearing site data can remove
a saved preference. The pinned URL does not depend on browser storage.

Language selection uses a separate key, `home-studio.language.v1`; changing
language does not change Dry run or send a device command. Do not put credentials,
entity names, or private project data in the URL.

## Connection status is independent

Dry run can remain on while Home Assistant is disconnected. Disconnected or
unknown readings must not be interpreted as “off.” Once the authenticated
connection returns, real readings resume; the guard remains unchanged. A blocked
button is not evidence that the radio, curtain motor, or TV is reachable.

![Dry run and connection health are independent; only connected live mode permits valid commands](images/plan-state-lifecycle.svg)

## Three meanings that must stay separate

- **Plan Dry run:** device commands from the installed plan are blocked;
  state display and layout editing continue.
- **Installer `--dry-run`:** an archive is validated without writing the
  Home Assistant config directory. It does not enable the plan's runtime guard.
- **Read-only legacy tablet:** its native bridge and snapshot endpoint have no
  actuator API. Its permanent Dry run indicator describes that stronger,
  structurally read-only delivery. It is maintained in the private deployment.

## Verify without operating a real device

Run the host regression with fake Home Assistant services:

```sh
node --test scripts/test-dry-run.cjs
node --test scripts/test-panel-language.cjs
```

The Dry run suite covers device families, native dialogs, unknown messages,
preference restoration, URL pinning, denied storage, dispatch races, and the
normal control path. Test any new action family here before adding it to the
host. A test should assert **zero service calls**, not merely a disabled button.
For a physical display, verify the indicator, language, reload persistence,
and navigation while the guard is visibly on. Never turn it off merely to test
a lock or curtain on an occupied home.

See [troubleshooting](wiki/Troubleshooting.md),
[language scope](i18n.md), and the [wiki index](wiki/Home.md).
