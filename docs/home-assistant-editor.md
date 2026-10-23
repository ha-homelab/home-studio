# Install, draw, and publish inside Home Assistant

Install Home Studio in Home Assistant, then start with one room. You can save
and publish that room before adding furniture or connecting any devices.

Use these two Home Assistant sidebar entries:

- **Home Studio** is where an administrator draws rooms, adds furniture, links
  devices, and saves and publishes changes.
- **3D Home** is the published view your household uses to see the home and
  control linked devices. Administrators can choose **Edit home** in its header
  to return directly to Home Studio.

The steps below are for a new native installation, where the drawing is saved
inside Home Assistant. No terminal or local compiler is needed. If you already
use a generated or customized home, read [Existing generated homes](#existing-generated-homes)
before changing its installation. The separate editor remains an optional
fallback for offline work or while resolving HA setup.

The native workflow requires Home Assistant 2026.10 or newer and a release with **home_floorplan.zip**. A release
that only contains **home-studio-VERSION.zip** provides the portable toolkit.
Check the release assets rather than assuming a hosted editor update changes
an installed Home Assistant integration.

![The native editor with a fictional room, plus save and publish controls.](images/native-editor.png)

This screenshot uses the actual editor and trusted host with a simulated HA
connection and fictional devices. No personal home or credentials are shown.

## Draw and inspect together

On a wide workspace, choose **2D + 3D** to keep the drawing at the left and its
preview at the right. Draw or move objects in 2D, then release the pointer to
refresh the preview. Orbit and zoom over the 3D pane, or choose **Edit items**
to move an item and adjust its height there. Both panes use the same undo
history. **Fit view** fits both; the bottom zoom buttons control the 2D pane.

A narrower window returns to the full-width drawing. The feature adds no
second 3D renderer. Existing generated homes keep their protected drawing and
**Published home** preview instead of exposing an incomplete reconstruction.

## Install the native integration

1. Back up Home Assistant. If you already use a generated or customized
   `home_floorplan` component, read **Existing generated homes** below first.
2. In HACS, add `https://github.com/ha-homelab/home-studio` as a custom repository
   with the **Integration** category. Download Home Studio from a release containing
   **home_floorplan.zip**. Inclusion in the default HACS catalog is not required.
3. Restart Home Assistant once after installing the integration code.
4. Open **Settings → Devices & services → Add integration** and choose
   **Home Studio**. A new native installation needs no terminal, Python, API token,
   or YAML entry.
5. Open **Home Studio** in the sidebar using an administrator account.

For manual installation, extract the contents of **home_floorplan.zip** into
`config/custom_components/home_floorplan`, then follow steps 3–5. Do not put
the source-toolkit ZIP there. Keep only one installed copy of the domain.

## Your first working room

For your first drawing, use a desktop browser with a mouse or trackpad. Start
with an empty floor. If a saved drawing opens, continue working on it instead;
use **More options → Export drawing (JSON)** to keep a copy before replacing it.
The short guide in Home Studio follows three steps: **Draw a room**,
**Add devices (optional)**, and **Save and publish**. Expand **Getting started ·
one room is enough** if it is closed. Once you have a room, the first shortcut
becomes **Add another room**.

1. Choose **Add your first room**. Enter **Room name**, **Width (m)**, and
   **Depth (m)**. For practice, try a room four meters wide and three meters
   deep. For your own room, use your measurements. Leave **Include walls**
   checked and choose **Create room**.
2. Choose **Preview 3D** to check the floor and walls. Doors, windows,
   furniture, and devices can wait until this first room works.
3. Choose **Save draft** and wait for confirmation that the drawing was saved
   in Home Assistant. You can leave and continue this saved drawing later.
4. Choose **Publish to 3D Home** and wait for confirmation. This updates
   **3D Home** from the saved drawing. Each floor needs at least one valid room;
   a failed publication leaves the previous published home available.
5. Choose **Open 3D Home**, or open **3D Home** in the HA sidebar, to see your room.
   Choose **Edit home** in the viewer header to add more detail, then save and publish again
   when ready.

**Save draft** keeps your work for editing. **Publish to 3D Home** makes the
saved drawing visible in 3D Home. An unfinished draft can be saved without
changing what your household sees. Neither action operates devices.

For pictures of the drawing tools and a two-room example, follow the
[illustrated drawing guide](../planner/guide.html).

## Add your first device

1. In **Home Studio**, choose **Add devices**, select the room, and choose its
   **Home Assistant area**. This helps find devices already set up in HA; it
   does not measure the room or find their positions.
2. Under **Add device to this room**, choose a light and select **Add linked
   item**. Drag the new item to its place in the room. The list uses HA
   entities: the lights, switches, sensors, and other controls or readings
   already in Home Assistant.
3. **Save draft**, then **Publish to 3D Home**. In **3D Home**, enable
   **Dry run** before trying the lamp's controls. You can check its link without
   sending commands. Turn Dry run off when you want to operate the real light.

Use **Item library** to add furniture that is only part of the drawing; you
can leave **Entity ID (optional)** empty. A lamp model does not create a new
device in Home Assistant.

## Move items and refine measurements

In **Plan 2D**, choose **Select / move** and drag an item to change its position.
In **Preview 3D**, choose **Edit items**, then drag an item across the floor.
Choose **Orbit** or **Pan** to move the view. Shift-drag also pans while editing.

For an existing generated home, the **Published home** tab shows the installed
view rather than the editable 3D preview. Move its items in **Plan 2D** and use
the position and height fields; its original room geometry stays protected.

**Snap 0.25 m** aligns item positions to the quarter-meter grid. Hold **Alt** while
dragging, drawing, or placing an item to bypass the grid temporarily; release it
to use snapping again. Uncheck Snap for continuous placement. Numeric fields
accept measurements independently of the grid. Select an item and enter
**x (m)** and **z (m)** when you know its exact position.

To raise or lower an item, select it in 3D editing and drag its **↕ Y** handle.
Use **Raise 5 cm**, **Lower 5 cm**, or **y (m)** in Item details for small or exact
changes. The handle also accepts Up/Down arrow keys in 5 cm steps, or 1 cm with
Alt. Height is measured from the selected floor, and the whole item must fit
between that floor and its ceiling.

Select a room to edit **Width (m)** and **Depth (m)**, or drag one of its four
corner handles in 2D. Numeric dimensions scale the room from its minimum x/z
corner; dragging keeps the opposite corner fixed. The walls and their openings
follow the room. Neighbors sharing a complete rectangular side adjust their
shared corners together, keeping the rooms joined; a change that would collapse
a neighbor or overlap another room is rejected. Doors and windows keep their
measured widths while their centers adjust along the wall. Item centers follow
the room proportionally, while their size, rotation, and height stay unchanged.
Check furniture clearances after shrinking a room. Partial shared sides and
irregular junctions that cannot stay joined require separate polygon and wall
endpoint edits. Original room shapes imported from generated homes remain
protected; their inspector does not offer resizing.

Dragging inside a room moves its walls, openings, and assigned items together.
If it touches another room or has external wall attachments, enable **Move
connected rooms together** in Room details before dragging. The inspector
lists the rooms that will move; their attached walls and items follow too.
The option resets when selecting another object. A rejected move leaves the
original plan intact, including when the final pointer position is invalid
after earlier valid movement.

Press **Escape** before releasing a drag to cancel it. Losing window focus also
cancels an unfinished drag. **Undo** restores a completed move or resize in one
step, including its rooms, walls, openings, and items. After checking the result, choose
**Save draft**, then **Publish to 3D Home** when the household should see it.

## Match your Home Assistant theme

Home Studio follows the active Home Assistant theme, including light and dark
mode. The toolbars, property fields, dialogs, drawing background, grid, and
selection outlines use the same palette as HA. Text and selection contrast are
adjusted for readability.

Change your theme in your Home Assistant profile as usual. The editor updates
without reloading the drawing or discarding an unfinished field edit. This only
changes the editing interface: your furniture colors, room materials, saved
project, and published home's appearance stay as you designed them. The separate
browser editor keeps its own default appearance.

## Saving while you work

**Save draft** also applies the value you are currently typing. Unfinished
fields count as unsaved work. If a field is invalid, saving and publishing
stop, and Save draft focuses the field so you can correct it without losing
your entered text. The tab recovery copy contains accepted drawing changes;
correct unfinished fields before leaving the editor.
**More options → Export drawing (JSON)** downloads a backup of the last valid
drawing and tells you when invalid field text is excluded. **Load saved draft**
is also under More options; export your work first if you need to keep the
current edits before loading the saved copy.

## Everyday controls without editing access

Use the **3D Home** panel or the [dashboard card](dashboard-and-media.md) for
everyday operation. The editor, project publication, and saved layout changes
remain administrator actions. A dashboard can lock editing even for an
administrator account.

Home Assistant permissions still apply. A user who cannot read an entity used
by a floor cannot load that floor's embedded model; the integration does not
send a partially redacted model containing hidden entity identifiers. For
readable entities, the host also checks control permissions before exposing
commands. Removing the edit buttons alone is not the authorization boundary.
The host indexes model entity references when loading or publishing a generation,
outside Home Assistant's event loop. Each request still checks current placements,
curtain guards, and user permissions. A failed index build leaves the previous
published generation active.

## Updates, backups, and concurrent editing

- The native project and its published assets live in HA's private data,
  outside the installed integration code. Update the integration through HACS
  and restart when HA requests it; keep HA backups and exported JSON copies.
- Save and publish use revisions. If another tab changes the same project,
  export the version you want to retain before reloading. A conflict does not
  silently choose one user's drawing over another.
- Integration updates replace code. Publish the saved drawing again when you
  need newly compiled viewer changes; updating the hosted website does not
  update your installed home.
- If publication fails, correct the reported field and publish again. The
  last successful dashboard stays available.
- If the connection drops, do not treat an unsent draft as saved. Keep an
  exported JSON copy before closing the editor.

## Optional fallback: the separate editor

If setup is blocked, or you want to work offline, use the separate editor.
The [hosted browser editor](https://ha-homelab.github.io/home-studio/planner/)
and a local copy in the portable toolkit are separate alternatives. Home Studio
does not send you there: drawing and publication happen inside Home Assistant.
The separate editor links back to the native installation instructions. It
does not know your private HA address, connect to HA, or receive your project
just because you follow that link.

To move a design deliberately, use **More options → Export drawing (JSON)**
in Home Studio, or **Export JSON** in the separate editor. Then use **Open JSON**
in the other editor. Check the imported drawing, save it, and publish when ready.
The external editor keeps its own browser draft; the native editor stores its
saved source in HA. Neither silently overwrites the other.

## Draft from photos without leaving Home Assistant

If the AI option is available, choose **Draft from photos (AI)** in Home Studio
to open **Plan from photos**. Select your provider,
exact vision-model ID, and session-only key (the field is masked). Connect, choose
an existing measured room or enter a new rectangular room's dimensions, and add
photos and instructions. **Generate draft** sends the selected input to that model.
Review the detached 2D/3D proposal, correct dimensions, confirm, and **Apply selected
additions**. Then **Save draft → Publish to 3D Home**; no JSON transfer is needed.

After applying the proposal, its additions use the same native editing tools.
Move items in 2D or **Preview 3D → Edit items**, adjust their height, and refine
room dimensions before saving and publishing. The AI draft is a starting point;
check positions and dimensions against your measurements.

Only administrators can create AI sessions. The provider key stays in HA process
memory for at most 30 minutes, is cleared on **End session**, and is not persisted
in your drawing, browser storage or HA configuration. The key is sent to your chosen
provider to authenticate; photos and sanitized room context are sent on Generate.
Use HTTPS when connecting to HA remotely. An API key does not grant an AI model any
Home Assistant service access. Failed or cancelled generations leave the plan intact.

The [full AI guide](ai-planning.md) explains limits, privacy and providers. The
optional desktop companion remains available for separate editing. For native
local-model profiles, `127.0.0.1` means the HA host/container, not your laptop;
LAN model URLs are not accepted by these profiles.

## Existing generated homes

With the complete editor/runtime installed, **Home Studio opens the home that
is already installed**. You do not need to redraw it or visit another website.
Its rooms and current saved object placements become an editable draft. The
original detailed architecture, custom objects and runtime integrations stay
with the installed home.

1. Open **Home Studio** as an administrator, or choose **Edit home** in 3D Home.
2. Select a room or object on the drawing. Rename rooms, link their HA areas,
   move or resize objects, change device bindings, or add furniture and devices.
   You can add new rooms, walls and openings alongside the original architecture.
3. Choose **Save draft**, then **Publish to 3D Home** when ready. Saving alone
   does not change the household's live view.
4. Choose **Open 3D Home** to use the updated plan. **Edit home** brings you back.
   Save any unfinished edits before switching views.

Original room boundaries and floor geometry are protected because compiled
meshes do not retain the source wall/door construction history. Selecting them
explains this in the inspector; it does not pretend that a room outline can
safely rewrite its detailed walls or sensing zones. Newly drawn architecture
is editable normally. Keep the original source/build route for structural
changes to the imported building.

For these homes, **Published home** shows the actual installed 3D model with
controls locked for preview. **Back to editing** returns to the same drawing.
This preview shows the last publication, not unpublished draft changes. The
editor keeps only one 3D renderer active at a time.

Back up the complete HA configuration, including the generated-home baseline,
drafts and publication assets. An exported drawing JSON contains the editable
projection, not the original custom model; it is not a complete backup of an
imported home. Never replace a customized integration with a generic ZIP and
expect its private adapters or baked assets to survive. Use its existing
composition/update process to install the shared editor/runtime while retaining
those files. Older thin portable packages need that complete runtime before
in-HA editing is available.

## Troubleshooting

### Unable to load custom panel

If Home Assistant reports **Unable to load custom panel**, open the browser's
developer tools, select **Network**, and reload the panel. Inspect the failed
`/home-floorplan-static/studio.js` or `panel.js` request, including its HTTP
status, redirects, response body, and `Content-Type`. Preserve any unsaved drawing
in a working tab before reloading it.

- **401 or 403:** access was refused before the module could run. Check your HA
  login and any reverse-proxy login or access policy. If other HA routes also
  fail, investigate access first. A working local connection and failing remote
  connection can help isolate the affected route; they do not prove an IP ban.
  Check HA logs and `ip_bans.yaml` in the configuration directory for the actual
  client address, including IPv6. For a confirmed accidental ban, back up that
  file, remove only the matching client entry, and restart HA. Correct the client
  or stale credentials causing failed logins before retrying repeatedly. Keep
  authentication, IP banning, and unrelated bans enabled. See
  [Home Assistant's IP-ban guidance](https://www.home-assistant.io/integrations/http/#ip-filtering-and-banning).
- **404:** check that the requested file exists in the installed component and
  that HA loaded that component successfully. A reverse proxy may have cached a
  temporary 404 while HA was starting. Compare the local response with the
  external response and inspect `Age` and cache-status headers before reinstalling.
  Bypass shared caching for `/home-floorplan-static/`, `/home-floorplan-studio/`
  and `/api/home_floorplan/`, then purge the affected module URLs. This changes
  caching only; retain the same authentication and access policies. If the file
  is actually missing, reinstall the complete matching release, then restart HA
  and reload the browser. Customized installations
  must use their existing package/deployment route. Do not copy individual
  scripts from a different release or replace private assets with a generic ZIP.
- **200 with HTML, or an unexpected MIME type:** a login page, proxy fallback,
  or cached error may have replaced the JavaScript response. Fix that route or
  cache rule so the module URL returns JavaScript with a JavaScript content type.
- **200 with JavaScript:** inspect the first relevant **Console** error and any
  failed imported modules. Record the browser version, installed release, and
  sanitized error; a syntax or module-loading error needs different diagnosis
  from an access refusal.

After fixing the cause, reload the panel and confirm its module loads. Do not
publish access tokens, cookies, client addresses, or full private logs in a report.

### Other setup and editing problems

- **No Home Studio integration in the picker:** check that you installed the
  native ZIP into the correct domain directory and restarted HA. The toolkit
  ZIP is a separate download.
- **No editor for a family account:** project editing requires an administrator.
  Open the 3D Home panel or a dashboard card for normal controls.
- **No device suggestions:** check the room's HA area and whether its devices
  are enabled. An area mapping is optional; an entity can be selected directly.
- **Save succeeds but Publish fails:** saving allows an unfinished drawing;
  publication requires complete, valid geometry. Follow the field named by
  the error. The previous publication is retained.
- **Publish to 3D Home is unavailable:** save your latest changes and check
  that every floor has a room. The message below the guide explains the next
  step. **Open 3D Home** becomes available after your first successful publication.
- **The drawing tools do not finish loading:** after a short wait, use
  **Retry connection** to reopen the preserved drawing. Retry does not replace
  a recovered drawing with the saved HA version.
  A stalled initial document navigation is retried automatically inside HA;
  no external editor or weaker browser security settings are needed. If it
  still fails, inspect the `/home-floorplan-studio/planner/index.html` request
  in Network. A pending request with no response differs from a 401/403/404
  or a script error; report that distinction with the browser version.
  **More options → Export drawing (JSON)** remains available when the host has
  a drawing, including after an editor load error.
- **`editor-assets` appears only through a reverse proxy:** HTML rewriting can
  change the reviewed script or stylesheet list. Bundled editor responses send
  `Cache-Control: no-cache, no-transform`; preserve that header on
  `/home-floorplan-studio/` so proxies leave the resources intact.
  [Cloudflare documents that `no-transform` prevents JavaScript Detection injection](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/#if-your-origin-sends-a-no-transform-header).
  The error alone does not identify which proxy feature changed the response.
  The editor keeps its existing CSP and exact asset allowlist.
- **The external editor opens a different draft:** this is expected. Export
  and open the JSON file when you want to transfer a design.

When requesting help, include the Home Studio version and whether you used the
native integration or portable toolkit. Use a fictional reproduction instead
of posting a real home's drawing, entity list, photos, or credentials.
