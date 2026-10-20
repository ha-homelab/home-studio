# Install Home Studio and draw in Home Assistant

Choose [your language](../translations/README.md). The recommended path keeps
installation, drawing, device selection, and publication inside Home Assistant.
Use **Home Assistant 2026.10 or newer** and a release with **home_floorplan.zip**.

1. Back up Home Assistant. Existing generated or customized homes need the
   [migration precautions](../home-assistant-editor.md#existing-generated-homes)
   before replacing their integration; they are not automatically converted.
2. In HACS, add `https://github.com/ha-homelab/home-studio` as a custom repository
   in the **Integration** category and download Home Studio.
3. Restart Home Assistant, open **Settings → Devices & services → Add integration**,
   and choose **Home Studio**.
4. Open **Home Studio** in the sidebar as an administrator. Draw a measured room,
   add walls and items, and choose your Home Assistant area and device bindings.
5. Choose **Save draft**, then **Publish family view**. Open **3D Home** and enable
   [runtime Dry run](Dry-run.md) before trying device buttons.

New native installations need no terminal, Python, API token, or YAML entry.
The [native installation guide](../home-assistant-editor.md) also covers manual
ZIP installation and errors. Follow [your first session](../first-session.md)
or the [illustrated drawing lesson](../../planner/guide.html) for room drawing.

## Updates and backups

Keep Home Assistant backups and portable copies made with **Export JSON**.
Update the native integration through HACS and restart HA. The drawing and
published assets are stored outside the integration code. Publish the saved
drawing again to regenerate it with new viewer changes. A failed publication
leaves the previous family view available.

Saving a draft does not publish unfinished geometry. If another tab changes the
project, export the version you want before reloading; revision checks prevent
a stale editor from silently overwriting the saved drawing.

## Optional fallback: separate editor and portable installation

If HA setup has problems, the
[hosted editor](https://ha-homelab.github.io/home-studio/planner/) lets you draw
while troubleshooting. A local toolkit copy supports offline drawing. Neither
connects to HA. Export the JSON, then deliberately open it in Home Studio in HA,
save, and publish when setup is ready; there is no automatic transfer.

The following commands are only for the portable compiler route. Download and
extract **home-studio-VERSION.zip** from the release assets, then use Python
3.10 or newer from its directory:

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
python3 -m http.server 8099 --bind 127.0.0.1 --directory dist/my-home
```

Open `http://127.0.0.1:8099/` locally. This preview has no live device connection.
The output includes `home-floorplan.tar.gz`. Follow the
[portable installation reference](../../install.html#export) for your deployment;
its installer needs a writable local config path, not a Home Assistant URL.

### Update an existing portable home

Keep the exported project JSON, a Home Assistant backup, and the previous source
revision. Rebuild with the same project ID to retain its storage association.
Validate the new archive with installer `--dry-run`; for an existing installation
include `--replace`. Stop Core before the actual replacement and retain the exact
backup path printed by the installer. It never changes `configuration.yaml` or
`.storage`. A component backup is not a full Home Assistant backup.

To roll back a portable update, stop Core and restore the prior component
directory from that recorded backup with your deployment's file tools, then
start Core and inspect the plan. Do not restore another home's assets or delete
saved placements to work around an error. Use the recovery export when the
panel reports that saved placements need repair. Installer `--dry-run` does not
change the display's runtime Dry run preference.

[Documentation home](Home.md) · [Troubleshooting](Troubleshooting.md)
