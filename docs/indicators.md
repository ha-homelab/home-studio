# Optional appliance and presence indicators

Compiled viewers can opt into read-only indicators through model metadata.
The ordinary entity cards and Home Assistant details remain available.
Indicators never send device commands and never add a WebGL animation loop.

`appliance_status` maps a saved item ID to its expected `entity_id`, `room`,
and `kind` (`cooktop` or `smoke`). A cooktop may also declare
`oven_entity_id` and up to eight `burners`: `[x, y, z, radius]` in the item's
normalized local coordinates. X/Z must be within -0.5 to 0.5, Y within 0 to 1,
and radius greater than zero and at most 0.5. A smoke indicator may declare
`battery_entity_id`.

Cooktop `on` displays symbolic blue rings; it does not claim individual burner
measurements. Oven `running` displays a front-facing window glow. `ready` and
`paused` do not imply heating. Smoke `on` displays an alarm, while `off`
displays green OK with a valid battery percentage, including zero. Missing,
unavailable, restored, disconnected, or mismatched bindings never imply an
all-clear or active heating. These indicators reflect HA's reported state;
they do not independently verify the physical appliance or alarm.

`presence_sources` maps an item ID to its expected `entity_id` and `room`.
A valid held `on` means presence, not motion, a person's position, a count,
or vital signs. It adds a presence card and a blue overlay of the saved room
outline, independently of room labels and physical lighting. The overlay clears
as soon as all configured presence sources report `off`; missing or rebound
sources remain unknown. One current `on` keeps the room highlighted even when
another source is off or unavailable. Neither `off` nor unknown establishes
that the room is vacant. Presence alone never creates footsteps.
Indicator captions currently use English fallback labels in all language packs.

Configured room activity sensors may supply an additive `channels` attribute,
keyed by source item ID. Each entry contains independent `presence` and `motion`
values (`on`, `off`, or `unknown`) and `coverage` (`validated` or `unverified`).
Boolean `presence_configured` and `motion_configured` flags distinguish an
unsupported channel from a configured but unavailable input. Missing flags
default to true for compatibility. Unsupported channels do not count as an
unknown presence source; having no presence sources still does not mean clear.
The host forwards only these normalized fields as `activity.channels`; existing
summary and evidence values remain compatible. Room details show both channels
and unverified coverage. HA and the source bridge own availability and freshness;
the viewer does not expire a held state from `last_changed` or renew source age
from a new HA update timestamp. Module diagnostics do not gate these channels.

A motion source must first report `off`, then `on`, to start a brief footstep
burst. Each source has its own edge state; held presence cannot mask later
movement. Initial or reconnect `on` snapshots do not create a new event. Each
burst ends within 2.2 seconds, even while motion remains on. Saved camera paths
are retained; other sources use a short decorative path clipped to the room.
These symbols are not measured human positions or trajectories.

Both metadata fields participate in the viewer's bounded display-state
declaration. The host still intersects every requested entity with the
server-issued read scope; metadata cannot grant permissions. Keep installation
bindings in private model generation. Neither the native nor standalone drawing
editor currently provides a form for authoring these advanced fields. Ordinary
device bindings use the [native editor workflow](home-assistant-editor.md); the
metadata below is an optional private-builder extension.

Overlays follow the existing camera renders. Hidden pages, inactive Home views,
and hidden rooms suppress appliance animation. Reduced-motion preferences
disable flicker and footstep animation. Presence has no delayed fade after off
or unknown. Hiding Home or losing its WebGL context clears movement timers and
hides the presence layer; disposal removes the layer. Restoring the canvas
shows current presence without replaying old movement. No timer polls devices
or keeps the WebGL renderer busy.

Restoring this feature to a generated installation requires rebuilding its
viewers against the updated shared core and supplying the reviewed model
metadata. Adding missing physical items or detailed door geometry also requires
a deliberate model/export rebuild; an HTML-only preservation check should
continue to reject unreviewed geometry changes.

## Vacuum locations

See [Vacuum position overlays](vacuum-position.md) for advanced map registration,
source timestamps, permission checks, and reported versus last-known positions.
