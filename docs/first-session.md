# Your first home, without a blank-page problem

You do not need a 3D modeling background. Start with a room you recognize, make
one change, and save a copy before building the rest of your home.

## 1. Install Home Studio in Home Assistant

The recommended path is to install first, then draw, save, and publish inside
Home Assistant. Use Home Assistant 2026.10 or newer and a release containing
**home_floorplan.zip**.

1. Back up Home Assistant. If you already have a generated or customized
   `home_floorplan` installation, read [Existing generated homes](home-assistant-editor.md#existing-generated-homes)
   before replacing it; there is no automatic migration.
2. In HACS, add `https://github.com/ha-homelab/home-studio` as a custom repository
   with the **Integration** category, then download Home Studio.
3. Restart Home Assistant. Open **Settings → Devices & services → Add integration**
   and choose **Home Studio**.
4. Open **Home Studio** in the sidebar using an administrator account.

A new native installation needs no terminal, Python, API token, or YAML entry.
For manual ZIP installation and troubleshooting, see the
[native installation guide](home-assistant-editor.md).

## 2. Start with one measured room

Choose **New project**, then **Start with measurements**. Give the room a name
and enter its width and depth in meters: 3.5 means three and a half meters.
Use **Include walls** when you want a standing outline immediately. You can
undo the room and its outline together.

For a whole floor, arrange the rooms before building every wall. A room's floor
shape, its walls, and its furniture are separate objects: moving the floor shape
does not move the others. Exactly matching shared edges can reuse a wall;
partially overlapping edges still need manual adjustment.

Follow the [illustrated seven-step lesson](../planner/guide.html) for adjoining
rooms, doors, windows, furniture, and a saved project. The lesson intentionally
adds walls after arranging its two rooms.

## Look around without moving furniture

The translucent floor previews sit halfway down the left edge of the drawing.
Click a preview to switch floors. The highlighted card is the current floor;
previews use a common scale so you can compare their size and alignment. Use the
**Your floors** button to hide or restore the cards. With the cards focused,
use arrow keys or Home/End to choose a card, then Enter or Space to switch.

In **Preview 3D**:

- **Orbit** turns the camera around your home when you drag. Use the turn buttons
  for a 45-degree step in either direction.
- **Pan** moves the camera sideways. Right-drag or Shift-drag also pans without
  changing the selected mode. The objects themselves stay in place.
- Scroll to zoom. On a touch screen, use one finger for the selected mode and
  two fingers to pan and pinch to zoom.
- **Top view** looks down at the current framing. **Fit view** restores the
  initial angle and fits the visible floor or all visible floors.
- With the preview focused, arrows navigate, Shift+arrows pan, +/− zoom,
  T selects top view, O/P select Orbit/Pan, and Home fits the view.

**Plan 2D** remains a precise drawing surface: dragging an object can edit it.
Hold Space or Shift while dragging to move the 2D view instead. Switching floors
and moving the 3D camera do not add undo steps or change your saved geometry.

## 3. Save the draft and publish the family view

Choose **Save draft** in the Home Studio header. Wait for confirmation that your
editable drawing is saved in Home Assistant. Saving also applies the field you
are currently typing; correct any invalid field before continuing.

When the rooms and items look right, choose **Publish family view**, then open
**3D Home** in the sidebar. Publication validates and builds the saved drawing;
each floor needs at least one valid room. An unfinished draft can be saved
without replacing the currently published home. A failed publication keeps the
last successful home available.

To connect a device, associate its room with a Home Assistant area and select
its entity from the suggested devices. Areas help you find entities; they do
not measure rooms or place objects for you. Use **Dry run** in 3D Home to check
bindings before choosing to enable live device controls.

**Export JSON** keeps an additional portable backup of the last valid drawing.
Keep exported versions and Home Assistant backups before large changes. If an
unsaved drawing is recovered from the current tab, inspect it before choosing
**Resume recovered drawing** or **Use saved drawing**. Export a copy when you
need to retain both versions. Tab recovery is not a replacement for Save draft.

If another editor tab changes the saved project, save/publication revision
checks reject the stale change. Export the version you want to keep before
reloading. A disconnected editor cannot confirm a save in Home Assistant.

## Optional: try a fictional example

Use **Examples** in Home Studio to open the practice home, decor studio, pattern
studio, or garage. Keep your current drawing with **Save draft** and **Export
JSON** before replacing it. These examples have no real device bindings.

In the practice home, choose **Plan 2D**, select the table, change its color, and
return to **Preview 3D** to look around. An example needs no provider account or
AI token. The [illustrated seven-step lesson](../planner/guide.html) explains the
same drawing tools used inside Home Assistant.

## Optional fallback: the separate editor and portable toolkit

If Home Assistant setup is blocked, the
[hosted editor](https://ha-homelab.github.io/home-studio/planner/) lets you keep
drawing while you resolve it. For offline work, use a local copy from the
toolkit. The hosted editor has no HA connection; its draft belongs to that
browser and website address. **Export JSON** keeps your source. Later, use
**Open JSON** inside Home Studio in HA, inspect the drawing, then **Save draft**
and **Publish family view**. Opening either editor never transfers a project
automatically.

The standalone editor's **Draft recovery** controls can load its saved version,
restore one previous-project checkpoint, download damaged original data, or
explicitly replace the saved draft. If two tabs conflict, finish in one tab and
choose which version to keep. If browser storage is unavailable or full, keep
exporting JSON copies; do not treat an unconfirmed autosave as successful.

For an existing portable deployment, or when you deliberately need the local
compiler and installer:

1. Get the [latest stable release](https://github.com/ha-homelab/home-studio/releases/latest).
2. Under **Assets**, download **home-studio-VERSION.zip**, not GitHub's automatic
   **Source code (zip)**. Extract it; its top-level folder is **home-studio**.
3. Export your project JSON and follow the [portable installation reference](../install.html#export).
   This route uses Python 3.10 or newer and a local Home Assistant config path.
4. Back up Home Assistant and your project before replacing an existing install.
   Verify device bindings in **Dry run** before allowing real commands.

The website does not install into your home remotely. Do not publish your home
JSON, photos, credentials, or entity list to get help with installation.

## Rotate the installed Home view

In Home Assistant's **3D Home** panel or dashboard card, **Home view** has its
own camera controls above the map:

- **Rotate** is selected initially. Drag with the left mouse button or one
  finger to turn the home and change the viewing angle. Tilt stops before the
  view flips over.
- **Move** makes a plain drag move the view sideways, including on a touch
  screen. Shift-drag or right-drag also moves the view in either mode.
- Use **−** and **+** to zoom. The percentage button, labelled **Reset view**,
  restores the initial angle, zoom, and position.
- With the map focused, arrow keys rotate, Shift+arrows move, and Home resets
  the view.

The camera stops when you stop dragging; it does not keep spinning. Camera
navigation does not move saved furniture or send device commands. Click or tap
a device without dragging to use its normal controls.

If these buttons are missing, update the native integration through HACS, restart
Home Assistant, and publish the saved drawing again to regenerate its viewer.
For a portable installation, rebuild and reinstall with the updated toolkit.
Updating the hosted drawing editor does not update an installed Home view.

## If the 3D view cannot start

The installed viewer shows a recovery message with **Plan & placement** even
when graphics initialization fails. Use that path to open the 2D plan, edit placements, and export inventory JSON.
The 3D and Home buttons remain disabled until you reload. If the drawing editor's preview fails, its 2D drawing and JSON
export remain the way to preserve your work.

When reporting a problem, include the release version, operating system, browser
name and version, and whether it happened in the drawing editor, a local preview,
or the installed Home Assistant panel. A small fictional reproduction is much
more useful than a private home export. See [browser compatibility](browser-compatibility.md).
