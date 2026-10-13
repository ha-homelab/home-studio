# Home studio

**[Start drawing](https://ha-homelab.github.io/home-studio/planner/)** ·
**[Illustrated drawing guide](https://ha-homelab.github.io/home-studio/planner/guide.html)** ·
**[Install in Home Assistant](https://ha-homelab.github.io/home-studio/install.html)** ·
**[Download the complete ZIP](https://github.com/ha-homelab/home-studio/archive/refs/heads/main.zip)**

Draw rooms, add walls, doors and windows, place furniture, and explore your
design in 3D. The browser editor needs no account or installation. Use a desktop
browser and a mouse or trackpad; the illustrated guide also reads on a phone.

The complete download includes the editor, a local project compiler, a Home
Assistant integration, and its local installer. The compiler and installer need
**Python 3.10 or newer**, with no extra Python packages. Home Assistant supplies
the integration's runtime dependencies.

The hosted editor stores a draft in your browser and does not connect to Home
Assistant. **Export JSON** saves your editable project; **Open JSON** restores it.
The local compiler turns that project into a separate viewer, 3D exports, and an
installable Home Assistant package. Examples and guide screenshots are fictional.

## Draw, build, and preview

1. Follow the [drawing guide](https://ha-homelab.github.io/home-studio/planner/guide.html)
   and choose **Export JSON** in the editor. Keep that file as your source.
2. [Download the complete ZIP](https://github.com/ha-homelab/home-studio/archive/refs/heads/main.zip),
   extract it, and open a terminal in the extracted `home-studio-main` folder.
3. Check `python3 --version`. Use Python 3.10 or newer. On Windows, `py -3` may be
   your Python command; substitute it for `python3` in these examples.
4. Run the build below. Replace `/path/to/project.json` with your exported file's
   actual path. Put quotes around paths containing spaces.

```sh
python3 scripts/build-planner-project.py --project /path/to/project.json --output dist/my-home --ha-package
python3 -m http.server 8099 --bind 127.0.0.1 --directory dist/my-home
```

Open [the local preview](http://127.0.0.1:8099/) and choose a floor. Keep the
terminal running while viewing; press Ctrl+C to stop the server. The build also
creates `dist/my-home/home-floorplan.tar.gz`. Your preview has no live device
connection. The output folder must be empty or belong to an earlier compiler
build; keep editable source files outside it.

To draw in a downloaded copy, run the server without `--directory dist/my-home`
and open [the local editor](http://127.0.0.1:8099/planner/). Export and reopen JSON
to move between the hosted and local editors; they have separate browser drafts.

## Install in Home Assistant

Use the [complete installation guide](https://ha-homelab.github.io/home-studio/install.html)
for first-time setup, Home Assistant OS file transfer, and updates.

For a **local, writable Home Assistant config directory**, replace the config
path below with the directory containing your `configuration.yaml`:

```sh
python3 scripts/install-home-assistant.py dist/my-home/home-floorplan.tar.gz --config /path/to/ha/config --dry-run
python3 scripts/install-home-assistant.py dist/my-home/home-floorplan.tar.gz --config /path/to/ha/config
```

The dry run validates without changing files. The installer requires an existing
directory, refuses symlink destinations, and installs only
`custom_components/home_floorplan`. It does not use a Home Assistant URL or token.
For Home Assistant OS, build and validate on your computer, then follow the
guide's **Samba copy** route; a browser connection to HA is not a local config path.

An existing component requires **`--replace`** on both commands. Stop Home
Assistant Core before the real replacement, using a host or console connection
that can start it again. The installer retains the previous component in
`config/.home-studio-backups/` and prints the exact backup path. It preserves
`configuration.yaml` and `.storage`; a component backup is not a full HA backup.

After installation, merge this top-level entry into `configuration.yaml` once:

```yaml
home_floorplan: {}
```

Keep an existing entry instead of adding a duplicate. Run Home Assistant's
configuration check, then start or restart Core. Sign in as an administrator and
open **3D Home**. Use **Edit layout → Plan & placement** to link items to actual HA
entity IDs, and wait for **Saved in Home Assistant**. Device actions need an
explicit click; unknown or unavailable entities cannot be controlled.

The generic package uses HA's own authentication. It does not install HACS,
configure SSO, trace photos, or activate household-specific TV, camera, or RF
sensing adapters.

## Shared code, private homes

The public compiler, viewer, integration core, and installer can also be used by
a private project. Keep plans, photos, entity bindings, credentials, and any
`private_site` / `private_site_config` extensions in that private project.
Generic packages require `site.json` with `site_features: false`; enabling private
adapters requires a separately prepared private package and the installer's
explicit `--allow-site-features` flag. This flag does not supply those adapters.
See [the architecture guide](docs/architecture.md) for the boundary and storage
behavior.

Read [privacy and storage](https://ha-homelab.github.io/home-studio/privacy.html)
before sharing a project. A generated viewer or archive contains your floorplan
and bindings. Keep your real home's source and generated files private.

## Checks and publication

```sh
python3 scripts/test-public-package.py
python3 scripts/test-install-home-assistant.py
python3 scripts/validate-site.py
python3 scripts/validate-site.py --output _site
```

The public repository contains the full package. GitHub Pages publishes only an
explicit website allowlist, so the website stays a static editor and guide.
Validation checks links, browser imports, symlinks, and common private-data
patterns. These checks supplement review; they do not prove all future text or
image pixels are free of personal information.

Report bugs with browser details and a fictional example. Do not attach tokens,
credentials, or a real home design to a public issue.

Home studio is available under the [MIT license](LICENSE). The bundled Three.js
license and notices are in [vendor/THREE-LICENSE.txt](vendor/THREE-LICENSE.txt).

TV preview cards provide power controls and link to their screen positions with
cyan dashed leaders. Optional notification clips link to their camera positions.
Images require the site-specific adapters; the public installer does not capture
TVs or cameras by itself. See [linked media previews](docs/architecture.md#linked-tv-and-camera-previews).
