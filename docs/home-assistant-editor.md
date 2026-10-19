# Draw inside Home Assistant or in the separate editor

Home Studio offers two ways to edit the same project format. Choose Home
Assistant when you want your draft, room mapping, and published dashboard in
one place. Choose the separate browser editor when you want to draw offline,
try a fictional example, or keep using the local compiler and installer.

The native workflow requires Home Assistant 2026.10 or newer and a release with **home_floorplan.zip**. A release
that only contains **home-studio-VERSION.zip** provides the portable toolkit.
Check the release assets rather than assuming a hosted editor update changes
an installed Home Assistant integration.

![The native editor with a fictional room and lamp, plus Save draft and Publish family view actions.](images/native-editor.png)

This screenshot uses the actual editor and trusted host with a simulated HA
connection and fictional devices. No personal home or credentials are shown.

## Install the native integration

1. Back up Home Assistant. If you already use a generated or customized
   `home_floorplan` component, read **Existing generated homes** below first.
2. In HACS, add `https://github.com/ha-homelab/home-studio` as a custom repository
   with the **Integration** category. Download a release with the native
   integration asset. Inclusion in the default HACS catalog is not required.
3. Restart Home Assistant once after installing the integration code.
4. Open **Settings → Devices & services → Add integration** and choose
   **Home Studio**. You do not need an API token or a YAML entry for a new native
   installation.
5. Open **Home Studio** in the sidebar using an administrator account.

For manual installation, extract the contents of **home_floorplan.zip** into
`config/custom_components/home_floorplan`, then follow steps 3–5. Do not put
the source-toolkit ZIP there. Keep only one installed copy of the domain.

## Your first working room

1. Start a new project or use **Open JSON** for an existing Home Studio drawing.
2. Create one measured room and its walls. Add a window and a lamp from the item
   library. The [illustrated drawing guide](../planner/guide.html) applies to
   either editor.
3. Associate the room with its Home Assistant area. Choose the lamp's real
   entity from the suggested devices. Areas help find devices; they do not
   discover physical positions or dimensions. Place each item yourself.
4. **Save draft** preserves the editable project in HA. A draft may contain an
   empty floor while you are still drawing.
5. **Publish family view** validates and builds the saved project into the live **3D Home**
   view. A floor needs at least one valid room before publication. An error
   leaves the previously published home available.
6. Open **3D Home** and use **Dry run** to check your layout and bindings without
   sending device commands. Turn Dry run off only when you want live controls.

Publishing a drawing does not turn on lights, move covers, or operate locks.
Saving a draft and publishing a dashboard are separate actions. Changing a
draft does not change the currently published geometry.

## Work in the external editor when you prefer

The in-HA editor links to the [separate browser editor](https://ha-homelab.github.io/home-studio/planner/).
The separate editor links back to the native installation instructions. It
does not know your private HA address, connect to HA, or receive your project
just because you follow that link.

To move a design deliberately, use **Export JSON**, then **Open JSON** in the
other editor. Check the imported drawing, save it, and publish when ready.
The external editor keeps its own browser draft; the native editor stores its
saved source in HA. Neither silently overwrites the other.

Optional AI photo drafting remains available through the
[local AI companion](ai-planning.md). The native integration does not proxy
provider credentials or automatically send room photos to a provider.

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

## Updates, backups, and concurrent editing

- The native project and its published assets live in HA's private data,
  outside the installed integration code. Update the integration through HACS
  and restart when HA requests it; keep HA backups and exported JSON copies.
- Save and publish use revisions. If another tab changes the same project,
  export the version you want to retain before reloading. A conflict does not
  silently choose one user's drawing over another.
- If publication fails, correct the reported field and publish again. The
  last successful dashboard stays available.
- If the connection drops, do not treat an unsent draft as saved. Keep an
  exported JSON copy before closing the editor.

## Existing generated homes

The portable workflow is retained: external editor → JSON → Python compiler →
local installer. Its [build and installation instructions](../install.html#export)
continue to apply. Generated packages and specialized private adapters are not
automatically converted into native projects.

Do not replace a customized component with the generic HACS package and expect
its private adapters or prebuilt assets to be preserved. Keep its existing
deployment route unless you intentionally migrate. For an ordinary portable
project, retain its source JSON and HA backup, then import the source into a
fresh native installation. Check bindings in Dry run before using live controls.

## Troubleshooting

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
- **The external editor opens a different draft:** this is expected. Export
  and open the JSON file when you want to transfer a design.

When requesting help, include the Home Studio version and whether you used the
native integration or portable toolkit. Use a fictional reproduction instead
of posting a real home's drawing, entity list, photos, or credentials.
