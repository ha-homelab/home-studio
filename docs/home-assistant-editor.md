# Install, draw, and publish inside Home Assistant

Start with the native Home Studio integration. This is the recommended path:
install it in Home Assistant, draw your rooms, link devices, save the draft, and
publish the family view in one place. No terminal or local compiler is needed
for a new native installation. The separate editor remains an optional fallback
when HA setup is blocked, or for offline work and existing portable deployments.

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

**Save draft** also applies the value you are currently typing. Unfinished
fields count as unsaved work. If a field is invalid, saving and publishing
stop, and Save draft focuses the field so you can correct it without losing
your entered text. The tab recovery copy contains accepted drawing changes;
correct unfinished fields before leaving the editor. **Export JSON** remains
available for a backup of the last valid drawing and tells you when invalid
field text is excluded.

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
The in-HA editor links to the [hosted browser editor](https://ha-homelab.github.io/home-studio/planner/);
a local copy is available in the portable toolkit.
The separate editor links back to the native installation instructions. It
does not know your private HA address, connect to HA, or receive your project
just because you follow that link.

To move a design deliberately, use **Export JSON**, then **Open JSON** in the
other editor. Check the imported drawing, save it, and publish when ready.
The external editor keeps its own browser draft; the native editor stores its
saved source in HA. Neither silently overwrites the other.

## Draft from photos without leaving Home Assistant

Choose **Plan from photos** in the native drawing editor. Select your provider,
exact vision-model ID, and session-only key (the field is masked). Connect, choose
an existing measured room or enter a new rectangular room's dimensions, and add
photos and instructions. **Generate draft** sends the selected input to that model.
Review the detached 2D/3D proposal, correct dimensions, confirm, and **Apply selected
additions**. Then **Save draft → Publish family view**; no JSON transfer is needed.

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

The portable workflow is retained: external editor → JSON → Python compiler →
local installer. Its [build and installation instructions](../install.html#export)
continue to apply. Generated packages and specialized private adapters are not
automatically converted into native projects.

Do not replace a customized component with the generic HACS package and expect
its private adapters or prebuilt assets to be preserved. Keep its existing
deployment route unless you intentionally migrate. For an ordinary portable
project, retain its source JSON and HA backup, then import the source into a
fresh native installation. Check bindings in Dry run before using live controls.
If Home Studio identifies the installation as a generated home, its sidebar
explains this workflow and keeps the family view and browser editor links
available. This compatibility state is not a connection error.

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
  that HA loaded that component successfully. Reinstall the complete matching
  release, then restart HA and reload the browser. Customized installations
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
- **The drawing tools do not finish loading:** after a short wait, use
  **Retry connection** to reopen the preserved drawing. Retry does not replace
  a recovered drawing with the saved HA version. **Export JSON** remains
  available when the host has a drawing, including after an editor load error.
- **The external editor opens a different draft:** this is expected. Export
  and open the JSON file when you want to transfer a design.

When requesting help, include the Home Studio version and whether you used the
native integration or portable toolkit. Use a fictional reproduction instead
of posting a real home's drawing, entity list, photos, or credentials.
