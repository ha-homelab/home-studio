# Make the plan useful for your devices

A drawing becomes useful when the objects in it match the devices you use.
Choose an object in the planner, enter its **Home Assistant entity ID**, then
build and install the home. You can also bind an existing object in the installed
plan's **Edit layout** view. Wait for the saved confirmation before controlling it.

These controls require a build containing **device details and audio controls**.
They are not included in stable 0.8.0 or the first dashboard/artwork beta. Updating
the hosted drawing editor alone does not upgrade an installed home.

## What to bind

| What you want to see or do | Bind this entity | What happens on the plan |
| --- | --- | --- |
| Brightness, light color or white temperature | `light.example` | Click for the existing quick toggle; pause the mouse over the marker or select **Details** for HA's full light controls. |
| Switches and fan speed | `switch.example`, `fan.example` | Quick toggle remains available; **Details** opens the controls supplied by that integration. |
| Music, volume and track navigation | `media_player.speaker` on an appliance/furniture object | Hover, keyboard-focus or tap the marker for a compact audio remote. A separate button opens HA's full controls. |
| A television | `media_player.television` on a TV object | Hover for HA's native media dialog. Existing artwork and configured screenshot previews remain available. |
| Blinds, shutters and curtains | `cover.example` | Existing click controls and remembered-position support remain; hover opens the native HA dialog. |
| Room temperature or thermostat | `sensor.temperature`, `climate.example` | Show the reading, or current/target temperature and HVAC activity. Native thermostat settings open in HA. |
| Humidity, power, energy, air quality or battery | `sensor.example` | Show the reported value and unit on the device card. Negative measurements remain valid. |
| Door, window, leak, smoke or equipment problem | `binary_sensor.example` | Show a device-class-specific state such as Open/Closed, Wet/Dry or Detected/Clear. |
| Robot cleaner | `vacuum.example` | Show its reported status; open HA's native cleaning controls. |
| Lock, scene, script, button, helper or another domain | Its actual entity ID | Open native HA details. The plan never guesses a service or turns a generic `on` value into a toggle. |

The list is a guide, not a requirement to add every sensor. Bind the entity that
represents the user-facing device, rather than every diagnostic entity belonging
to it. Multiple integrations can expose the same equipment; matching names alone
do not prove that two entities are interchangeable.

The drawing editor stays offline. It stores the chosen IDs, but cannot know which
features your actual integrations expose until you open the installed plan in HA.

## Hover, touch and keyboard

An audio remote has volume, previous/next track, play, pause and stop when the
player advertises those capabilities. Unsupported actions are hidden. Volume is
sent when you finish changing the slider, rather than on every pointer movement.
Hovering or focusing the marker does not play, stop or change the volume.

For TVs and other devices, leaving the mouse over a marker for about two-thirds
of a second opens HA's native details dialog. Briefly crossing a marker does not.
The dialog is HA's own interface: its contents depend on your integration and
version of HA. This feature does not install a separate remote-control dashboard
or promise buttons the device does not support.

Keyboard and touch users can select the device card or its **Details** button.
Audio controls also have an explicit **Controls** button in the artwork preview.
Escape or a click outside dismisses the compact audio remote. Full HA dialogs use
HA's normal close behavior. Quick toggles remain deliberate clicks.

## Stereo pairs and groups

Draw both physical speakers, but bind only the controlling speaker or group if
you want one remote and one artwork preview. Leave the partner's entity field
empty. Use the entity that exposes the playback and volume you want to control;
this is sometimes the music integration's player rather than the underlying
hardware integration. The plan does not regroup speakers or change playback to
discover the right entity.

## What the status means

For generic readings, **Entity not found**, **Unavailable**, **Unknown**,
**Restored state**, and **Disconnected** are different conditions. None is presented as a healthy zero
reading. Motion and presence retain their existing specialized presentation;
ordinary binary sensors do not create walking trails.

Native details can help diagnose a present but unavailable entity. Direct audio
commands stay disabled while unavailable, restored, disconnected or already
waiting for a command. A successful service response means HA accepted the
request; the displayed state still comes from HA, not a simulated success.

## Performance and privacy

There is no new polling loop, history download or per-frame device request. New
viewers declare their display dependencies, and the host sends live state only
for those references, saved bindings and required curtain power switches.
A separate name/ID catalog supports binding search without forwarding unrelated
sensor values. Search displays at most 80 matches; type more of the name or ID to
narrow the list. Reload the saved plan after adding or renaming HA entities to
refresh this catalog.

Older compiled viewers retain their previous state protocol for compatibility.
Rebuild and reinstall to obtain the reduced state payload. Dependency filtering
reduces data and work; it is not an authorization boundary. HA authentication,
the administrator requirement, saved-binding checks and the host command guard
remain responsible for access control.

**Dry run** blocks native dialogs as well as commands, because native HA dialogs
can themselves control devices. A pending or failed placement save also blocks
commands. The audio gateway accepts only its six named actions and validates
capabilities and bounded volume against current HA state immediately before
dispatch. It does not accept arbitrary service names or service data.

## Troubleshooting

- **The audio remote has few buttons:** compare the selected entity's
  `supported_features` and native HA controls. Select a player that exposes the
  desired functions; unsupported buttons cannot be supplied by the drawing.
- **The TV opens an audio remote:** use a TV object for that binding. Speaker and
  appliance objects use the compact audio remote.
- **A measurement has the wrong unit:** the plan displays the entity's reported
  unit; fix the HA entity or bind the intended measurement.
- **Hover does nothing:** check saved status, HA connection and Dry run. Use
  **Details** to verify the binding without depending on hover.
- **A newly created entity is missing from suggestions:** reload the saved plan
  or enter its exact ID. Suggestions are bounded; the ID remains editable.

See [dashboard and artwork setup](dashboard-and-media.md),
[Dry run](dry-run.md), and HA's references for
[native card features](https://www.home-assistant.io/dashboards/features/) and
[media-player capabilities](https://developers.home-assistant.io/docs/core/entity/media-player/).
