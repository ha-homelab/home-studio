# Shared code and private homes

Home studio has a public drawing and installation pipeline. A private household
project can use the same code while keeping its measurements, photos, device
bindings, deployment details, and specialized adapters outside the public repo.

## From drawing to installed panel

1. **Browser editor:** `planner/index.html`, `editor.js`, and `model.js` edit a
   versioned metric project. The draft stays in browser storage. Exporting JSON
   makes a portable source file; the browser does not contact Home Assistant.
2. **Local compiler:** `scripts/build-planner-project.py` calls
   `planner/project.py`. It validates the source, generates floor geometry and
   self-contained viewers, and writes model exports. `--ha-package` also creates
   `home-floorplan.tar.gz` from reviewed integration files and the new assets.
   Python 3.10+ and the standard library are enough for this build.
3. **Local installer:** `scripts/install-home-assistant.py` validates the archive
   and stages its files before replacing a component directory. Its only target
   is `custom_components/home_floorplan` inside the explicitly supplied config
   directory. An update needs `--replace`; previous files are retained outside
   `custom_components` in `.home-studio-backups`. It does not edit YAML, contact
   an HA endpoint, copy a token, or start or stop a running service.
4. **Home Assistant integration:** the installed backend loads the project's
   `site.json` and floor assets. The generic `static/panel.js` uses Home
   Assistant's authenticated connection to display **3D Home** to administrators.
   Private floor assets are delivered through authenticated backend commands.

The [installation guide](https://ha-homelab.github.io/home-studio/install.html)
covers the commands, manual YAML entry, restart, and Home Assistant OS file
transfer. Installation is a local file operation, not a hosted wizard or HACS
installation flow.

## Public core

The public integration includes `__init__.py`, `site.py`, `validation.py`,
`curtains.py`, `manifest.json`, and `static/panel.js`. The compiler supplies the
site manifest, floor assets, and empty generic adapter configuration. Normal
packages declare `site_features: false` and a stable project `site_id`.

The core handles administrator access, floor selection, validated placement
saves, model downloads, and supported entity controls. It uses the current HA
session; there is no separate account, automatic SSO setup, or browser token
entry. Linking a TV or sensor places that entity in the plan, but does not add a
household's specialized TV capture, camera routing, or RF sensing behavior.

The floor viewer runs in a restricted iframe. The host and viewer communicate
through a dedicated message channel. The host checks saved entity bindings and
allowed actions before a user-initiated device command. The public static panel
script does not need a floorplan, photos, or credentials embedded in it.

## Optional private extensions

A private deployment can supply `private_site_config.py` with its site metadata
and `private_site.py` with its setup and adapter behavior, plus its own required
modules and configuration. Those files are not distributed by the generic
compiler. A private package must carry matching `site.json` metadata and all its
dependencies; changing a boolean does not create the missing implementation.

The backend recognizes private site features only through that separately
supplied private configuration. The installer additionally requires the explicit
`--allow-site-features` flag for a package declaring `site_features: true`. Archive
path, size, file-type, manifest, and backup checks still apply. A private legacy
deployment can retain `site_id: null` and its existing storage key.

Treat the public repository as the shared dependency: select a reviewed revision,
use its compiler and installer, and assemble local extras in the private project.
Submit generic fixes upstream without copying private inputs or Git history.
Keep a private record of the public revision used for each deployment so an
update can be reproduced. The public package does not automatically fetch or
update private adapters.

## Storage and rebuilds

The browser draft and HA placements are separate stores. Exported project JSON
is the editable geometry source; generated output folders are replaceable build
artifacts. Keep source files outside those output folders.

In Home Assistant, generic placements use a site-specific key under `.storage`.
Keep the project ID stable to retain that association; give a different home a
different ID. Each floor's revision protects saved placements against stale
writes. Saved layouts that no longer match rebuilt rooms require explicit
recovery instead of silently activating incompatible bindings.

The installer never rewrites `.storage`. Its retained component backup contains
the prior integration code and generated assets, not a complete snapshot of HA
or all saved placements. Back up Home Assistant before an update, stop Core
before replacing an existing component, and retain the printed backup path.
Directory replacement uses staged files and atomic renames with rollback on
ordinary failures. It is not a power-loss transaction; avoid concurrent edits to
the installation directory.

## Repository versus hosted website

The public GitHub repository and its complete ZIP contain the compiler,
integration, installer, tests, and website. GitHub Pages receives a smaller,
explicit allowlist containing only the editor, tutorial, and installation pages.
Python code is run locally after download; it is not executed by the website.

Publication checks verify that the selected files exist, reject symlinks and
common private-data patterns, and validate local links and browser imports.
Review source, examples, and image pixels as well. Never add real household
exports, backups, credentials, or photos merely to make a public build pass.

The shared code is [MIT licensed](../LICENSE). Preserve the bundled
[Three.js notices](../vendor/THREE-LICENSE.txt) when redistributing it.
