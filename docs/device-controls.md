# Make the plan useful for your devices

A drawing becomes useful when the objects in it match the devices you use.
In **Home Studio** inside Home Assistant, associate the room with its HA area
and choose an object's entity from the suggested devices. Choose **Save draft**,
then **Publish to 3D Home**. You can also bind an existing object in the
published plan's **Edit layout** view. Wait for the saved confirmation before
controlling it, and check new bindings in **Dry run**.

These controls require an installed build containing **device details and audio controls**.
Updating the hosted drawing editor alone does not upgrade an installed home.
Start with the [native editor](home-assistant-editor.md). If you use the optional
separate editor, enter entity IDs explicitly and import its JSON into HA to save
and publish. Existing portable deployments can rebuild and reinstall instead.

## What to bind

| What you want to see or do | Bind this entity | What happens on the plan |
| --- | --- | --- |
| Brightness, light color or white temperature | `light.example` | Click for the existing quick toggle; press and hold the marker or select **Details** for HA's full light controls. |
| Switches and fan speed | `switch.example`, `fan.example` | Quick toggle remains available; **Details** opens the controls supplied by that integration. |
| Music, volume and track navigation | `media_player.speaker` on an appliance/furniture object | Hover, keyboard-focus or tap the marker for a compact audio remote. A separate button opens HA's full controls. |
| A television | `media_player.television` on a TV object | Press and hold for HA's native media dialog. Existing artwork and configured screenshot previews remain available. |
| Blinds, shutters and curtains | `cover.example` | Existing click controls and remembered-position support remain; press and hold opens the native HA dialog. |
| Room temperature or thermostat | `sensor.temperature`, `climate.example` | Show the reading, or current/target temperature and HVAC activity. Native thermostat settings open in HA. |
| Humidity, power, energy, air quality or battery | `sensor.example` | Show the reported value and unit on the device card. Negative measurements remain valid. |
| Door, window, leak, smoke or equipment problem | `binary_sensor.example` | Show a device-class-specific state such as Open/Closed, Wet/Dry or Detected/Clear. |
| Robot cleaner | `vacuum.example` | Show its reported status; open HA's native cleaning controls. |
| Lock, scene, script, button, helper or another domain | Its actual entity ID | Open native HA details. The plan never guesses a service or turns a generic `on` value into a toggle. |

The list is a guide, not a requirement to add every sensor. Bind the entity that
represents the user-facing device, rather than every diagnostic entity belonging
to it. Multiple integrations can expose the same equipment; matching names alone
do not prove that two entities are interchangeable.

## Start with areas and choose several devices

In the native editor, **Start rooms from HA areas** is available on the empty
plan and in Floor settings. Select the areas you want, then enter each room's
measured width and depth. Home Assistant supplies names and links, not geometry:
the result is a set of separate rectangular starter rooms with optional wall
outlines. Arrange and refine them to match the home. Existing linked areas are
skipped across every floor; when a drawing floor is linked to an HA floor, only
that floor's areas and areas without a floor are offered. Protected existing
room shapes remain unchanged.

Select a linked room and choose **Choose multiple devices…**. Nothing is selected
automatically. Search by name or entity ID, check the desired rows, and choose
**Add selected devices**. Search preserves earlier selections; the selection
count includes rows outside the current search. Up to 80 matches appear at a
time. Suggested devices omit hidden, configuration and diagnostic entities,
and favor useful room readings and detections. **Include other entities** lets
you deliberately select a helper or another omitted entity. The individual
**Add linked item** action also remains available.

Entities already bound anywhere in the home are skipped. Distinct entities for
one physical device still appear separately: choose the one whose controls you
want. Markers start at separate positions inside the room; their small size and
positions are placeholders. Drag and resize them to match your devices. A batch
that exceeds the room/item limits or cannot fit separate markers leaves the
draft unchanged; select fewer devices or make space before retrying.

Media players with HA's `tv` device class start as TV objects. A `speaker` class
or missing class starts as an appliance with audio controls. Names are not used
to guess a TV. Select **Speaker / audio** or **TV / display** in the chooser to
override this; the individual flow has **New media player controls**. You can
also change the resulting marker's **Item type** later. Existing bindings are
not automatically reclassified. Save the draft and publish to use controls in
3D Home.

The drawing editor stays offline. It stores the chosen IDs, but cannot know which
features your actual integrations expose until you open the installed plan in HA.

## Hover, touch and keyboard

An audio remote has volume, previous/next track, play, pause and stop when the
player advertises those capabilities. Unsupported actions are hidden. Volume is
sent when you finish changing the slider, rather than on every pointer movement.
Hovering or focusing the marker does not play, stop or change the volume.

Media callouts without an available picture collapse to a small round TV or
speaker button. This includes powered-off devices, missing artwork and unavailable
players. Hover, keyboard-focus or tap this button to open its controls and current
status. Power remains a separate, deliberate action; opening the controls never
turns a device on. A TV offers power and access to Home Assistant's full remote;
an audio player also offers the playback and volume actions it supports.

An available TV frame or album cover restores the picture card. The round button
stays in place while its controls are open, so opening the remote does not resize
or move the plan. Escape, clicking outside, or leaving the button and remote
dismisses it. On touch screens, tap the button and use the close button or tap
outside.

Hovering a device never opens HA's native entity dialog. To open it from a
non-audio marker or device card, press and hold the primary mouse button or your
finger for about two-thirds of a second. Moving away, dragging, releasing early
or switching views cancels the hold. A completed hold opens the dialog once;
releasing afterward does not also toggle the light or move the curtain.
A short click keeps the device's quick action, where available. Devices without
a quick action, such as a TV or lock, require a hold or the **Details** button.
The dialog is HA's own interface: its contents depend on your integration and
version of HA. This feature does not install a separate remote-control dashboard
or promise buttons the device does not support.

Keyboard and touch users can select the explicit **Details** button.
Audio controls also have an explicit **Controls** button in the artwork preview.
Escape or a click outside dismisses the compact audio remote. Full HA dialogs use
HA's normal close behavior. Quick toggles remain deliberate clicks.

A canvas gesture belongs to the pointer that started it. A second finger cannot
turn a drag into a device tap, and a gesture involving multiple contacts never
activates a device. Switching views, losing pointer capture, hiding the page or
losing the graphics context cancels the gesture. Start a fresh tap afterward.

Native dialogs require the Home Assistant frontend. A separately hosted wrapper
must handle the `hass-more-info` event itself; authentication alone does not
load HA's full controls into that page.

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
sensor values. The native editor also receives bounded device-class, category
and hidden hints to classify suggestions; no playback metadata is included.
Batch device search displays at most 80 matches; type more of the name or ID to
narrow the list. Reload the saved plan after adding or renaming HA entities to
refresh this catalog.

Older compiled viewers retain their previous state protocol for compatibility.
Update the native integration and republish the saved drawing to obtain the
reduced state payload. For portable installations, rebuild and reinstall.
Dependency filtering reduces data and work; it is not an authorization boundary. HA authentication,
server-issued read/control scopes, saved-binding checks and the host command
guard enforce device access. Source and layout editing remain administrator
actions; family accounts use the published view.

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
