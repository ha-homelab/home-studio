# Troubleshoot a display

Keep Dry run on while investigating. Start with what the host header reports;
a button press alone cannot tell you whether a device is reachable.

## Home Studio is missing or its drawing will not load

Use Home Assistant 2026.10 or newer. Check that HACS installed the integration
from a release containing **home_floorplan.zip**, restart HA, then add
**Home Studio** under **Settings → Devices & services → Add integration**.
The Home Studio sidebar requires an administrator account; family accounts use
**3D Home** after publication.

If HA says **Unable to load custom panel**, inspect the module request in the
browser's Network tools first: 401/403 indicates refused access, 404 indicates
a missing route or file, and a 200 response still needs to contain JavaScript.
Follow the [custom-panel recovery steps](../home-assistant-editor.md#unable-to-load-custom-panel)
to check proxy responses, accidental IP bans, package completeness, and Console
errors without disabling authentication.

For a loading error, use **Retry connection**. Preserve unsaved work with
**Export JSON** before reloading or switching editors. If setup remains blocked,
the [separate editor](https://ha-homelab.github.io/home-studio/planner/) is an
optional way to keep drawing. It has a separate draft and no HA connection;
transfer source deliberately with Export JSON and Open JSON. See the
[native guide](../home-assistant-editor.md) for recovery and generated-home compatibility.

## The plan opens but readings are missing

Check the Home Assistant connection, the display's network, and the entity's
availability in Home Assistant. Unknown, disconnected, and unavailable are not
equivalent to off. The local preview has no live Home Assistant connection by
design. A separate legacy tablet can keep showing its local illustration while
withdrawing expired readings; its snapshot service and native client have their
own connection diagnostics.

## A device changes despite Dry run

Dry run blocks commands from this plan, while other dashboards, physical
switches, integrations, and automations continue operating. Check Home Assistant
history and context before assuming the plan sent the command. Enabling the
guard cannot recall a command already delivered. Verify the header still shows
Dry run and that you are using the intended browser profile and origin.

## Dry run resets or cannot be turned off

A preference is not shared across devices or origins. Clearing site data or using
a private browsing session can prevent restoration. Unreadable storage starts
the guard on. Bookmark
`?dry_run=1` to pin the guard independently of storage. A pinned URL disables the
switch. Remove that parameter before intentionally returning to live controls.
If saving the off preference fails, the active guard stays on and reports the
problem instead of silently enabling device commands.

## The lock or TV details window does not open

Native Home Assistant details can contain active controls, so Dry run blocks
opening them. This is expected. View the plan's real state or use an appropriately
authorized Home Assistant session separately when live control is intended.

## Labels are in the wrong language

Choose a language in the plan. Without an explicit selection, the installed
viewer follows the Home Assistant profile language. The hosted editor has its
own browser preference. Update the native integration and republish the saved
drawing for new viewer changes, then reload. For a portable installation,
rebuild and reinstall the generated package. User-authored room names, device
names, identifiers, and
technical error details are not automatically translated. See
[the language guide](Languages.md) for the documented scope.

## A saved placement cannot be loaded

Use **Export original inventory** before repairing anything. Work on a copy with
the current floor and room IDs shown by recovery. Importing the repaired copy is
a saved-layout change, even in Dry run. Keep the original exported project and a
Home Assistant backup. Do not replace unrelated private assets with public demo
files to suppress the error.

## Report a reproducible problem

Include the source/package revision, browser or Android/WebView version,
interface language, connection status, whether Dry run was pinned or saved, and
steps using a fictional project. Say whether the failure happened before or
after reload. Include sanitized diagnostics rather than access tokens, native
configuration, real floorplans, or complete private Home Assistant logs.

The [developer guide](Development.md) lists offline regression commands.
[Documentation home](Home.md)
