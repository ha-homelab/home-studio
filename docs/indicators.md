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
or vital signs. It adds a presence card and room activity evidence. With room
labels enabled, a fixed 20-pixel badge appears beside the room caption.
It never creates footsteps or fills the floor with light. Missing or rebound
items report unavailable evidence; quiet motion alone cannot establish absence when direct presence is unavailable.
Indicator captions currently use English fallback labels in all language packs.

Both metadata fields participate in the viewer's bounded display-state
declaration. The host still intersects every requested entity with the
server-issued read scope; metadata cannot grant permissions. Keep installation
bindings in private model generation. Neither the native nor standalone drawing
editor currently provides a form for authoring these advanced fields. Ordinary
device bindings use the [native editor workflow](home-assistant-editor.md); the
metadata below is an optional private-builder extension.

Overlays follow the existing camera renders. Hidden pages, inactive Home views,
and hidden rooms suppress appliance animation. Reduced-motion preferences
disable flicker and the presence fade. Disposing Home removes its presence
layer. No timer polls devices or keeps the WebGL renderer busy.

Restoring this feature to a generated installation requires rebuilding its
viewers against the updated shared core and supplying the reviewed model
metadata. Adding missing physical items or detailed door geometry also requires
a deliberate model/export rebuild; an HTML-only preservation check should
continue to reject unreviewed geometry changes.
