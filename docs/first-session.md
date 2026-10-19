# Your first home, without a blank-page problem

You do not need a 3D modeling background. Start with a room you recognize, make
one change, and save a copy before building the rest of your home.

## 1. Try a finished example

Open [the practice home](https://ha-homelab.github.io/home-studio/planner/?example=practice).
The example opens in **Preview 3D**. Choose **Plan 2D**, select the table, change
its color, then return to **Preview 3D** to look around.
The persistent **Examples** button also offers a decor studio, a pattern studio,
and a garage. These are fictional local examples with no real device bindings.

An example never needs a provider account, an AI token, or a Home Assistant
connection. Opening one when a drawing already exists asks before replacing it.
Use **Export JSON** to keep a portable copy of anything you want to retain.

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

## 3. Keep your work

**Export JSON** saves your editable source. Keep that file somewhere you back up.
An autosaved browser draft is useful between visits, but it is not cloud storage
and does not travel between devices, browsers, or website addresses.

When **Draft recovery** appears:

- **Load saved draft** loads the version already stored by the browser. Export
  your current work first if you want to keep both versions.
- **Restore previous project** offers one retained earlier project checkpoint. This is not unlimited version history.
- **Download original data** preserves damaged stored data for investigation.
  An unreadable draft must not be treated as a successfully saved blank project.
- **Replace saved draft with this version** is an explicit decision to keep the
  version on screen. Do not use it until you have checked which copy you want.

If two tabs edit the same draft, autosave pauses rather than silently choosing a
winner. Finish in one tab and deliberately resolve the saved version. If storage
is unavailable or full, keep working with exported JSON copies; do not rely on
an autosave success message that has not appeared.

## 4. Bring it into Home Assistant

Drawing and previewing run in the browser. Building the installable integration
still requires Python 3.10 or newer and the local toolkit:

1. Get the [latest stable release](https://github.com/ha-homelab/home-studio/releases/latest).
2. Under **Assets**, download **home-studio-VERSION.zip**, not GitHub's automatic
   **Source code (zip)**. Extract it; its top-level folder is **home-studio**.
3. Export your project JSON and follow the [installation guide](../install.html).
   It covers the build command and the different Home Assistant installation types.
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

If these buttons are missing, rebuild and reinstall the project with the updated
toolkit, then refresh Home Assistant. Updating the hosted drawing editor does
not update an already installed Home view.

## If the 3D view cannot start

The installed viewer shows a recovery message with **Plan & placement** even
when graphics initialization fails. Use that path to open the 2D plan, edit placements, and export inventory JSON.
The 3D and Home buttons remain disabled until you reload. If the drawing editor's preview fails, its 2D drawing and JSON
export remain the way to preserve your work.

When reporting a problem, include the release version, operating system, browser
name and version, and whether it happened in the drawing editor, a local preview,
or the installed Home Assistant panel. A small fictional reproduction is much
more useful than a private home export. See [browser compatibility](browser-compatibility.md).
