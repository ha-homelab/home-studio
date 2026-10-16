# Start drawing and install

Choose [your language](../translations/README.md), then open the
[browser editor](https://ha-homelab.github.io/home-studio/planner/). Draw rooms,
add objects, and use **Export JSON** to keep an editable source file. The hosted
editor does not connect to Home Assistant; its draft is local to that browser.

For a local preview or installation, download the complete source ZIP and run
Python 3.10 or newer from the extracted directory:

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
python3 -m http.server 8099 --bind 127.0.0.1 --directory dist/my-home
```

Open `http://127.0.0.1:8099/` locally. The preview has no live device connection.
The output also contains `home-floorplan.tar.gz`. Follow the
[installation guide](https://ha-homelab.github.io/home-studio/install.html) for
your Home Assistant deployment; the installer needs a writable local config
path, not a Home Assistant URL.

## Update without losing the source

Keep the exported project JSON, a Home Assistant backup, and the previous source
revision. Rebuild from the same project ID to preserve its storage association.
Validate the new archive with installer `--dry-run`; for an existing installation
include `--replace`. Stop Core before the actual replacement and retain the exact
backup path printed by the installer. It never changes `configuration.yaml` or
`.storage`. A component backup is not a full Home Assistant backup.

To roll back, stop Core and restore the prior component directory from that
recorded backup using the deployment's file-management tools, then start Core
and inspect the plan. Do not restore a different home's assets or delete saved
placements to work around a compatibility error. Use the recovery export when
the panel reports that saved placements need repair.

Enable [runtime Dry run](Dry-run.md) on a display before trying its device
buttons. The installer's `--dry-run` does not change this runtime preference.

[Documentation home](Home.md) · [Troubleshooting](Troubleshooting.md)
