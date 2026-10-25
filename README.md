# Home Studio

**Draw, furnish, and publish an interactive 3D home directly in Home Assistant.**

**[Get started in Home Assistant](https://ha-homelab.github.io/home-studio/install.html#native-studio)** ·
**[Illustrated drawing guide](https://ha-homelab.github.io/home-studio/planner/guide.html)** ·
**[Latest stable release](https://github.com/ha-homelab/home-studio/releases/latest)**

## Get started — install in Home Assistant

Use **Home Assistant 2026.10 or newer** and an administrator account. The
recommended route keeps your drawing, devices, saved drafts, and published
**3D Home** dashboard together in HA.

**Home Studio** in the sidebar is the administrator's drawing editor.
**3D Home** is the published view for your household's everyday device controls.
Start with one room; you can add devices after you have saved and published it.

1. **Back up Home Assistant.** Already using a generated or customized
   `home_floorplan` component? Read [migration guidance](docs/home-assistant-editor.md#existing-generated-homes)
   before replacing it.
2. **Install with HACS.** Open HACS → menu → **Custom repositories**, add
   `https://github.com/ha-homelab/home-studio`, and select **Integration**.
   Find **Home Studio** and download the latest stable version.
3. **Restart Home Assistant**, then open **Settings → Devices & services →
   Add integration** and choose **Home Studio**.
4. **Open Home Studio in the HA sidebar.** Choose **Add your first room** and
   enter its dimensions; this shortcut includes walls. Check it in **Preview 3D**.
   Follow the [first-room steps](docs/home-assistant-editor.md#your-first-working-room)
   for a simple example.
5. **Save draft**, wait for confirmation, then **Publish to 3D Home**. Open
   **3D Home** to see the published room. Return to Home Studio to add furniture,
   more rooms, and devices. Save and publish again when ready; drawing changes
   do not require another install or HA restart.

Without HACS, download **home_floorplan.zip** from the
[stable release](https://github.com/ha-homelab/home-studio/releases/latest),
extract its contents into `config/custom_components/home_floorplan`, and continue
from step 3. This is the integration ZIP, not the separate toolkit or GitHub's
Source code ZIP. A new native installation needs **no Python setup, terminal
build, YAML entry, or pasted access token**.

[Full setup, updates, and troubleshooting](docs/home-assistant-editor.md) ·
[Check device bindings with Dry run](docs/dry-run.md)

## Watch the Home Assistant workflow

[![Watch Home Studio: room photo, AI draft, manual editing, entity linking, and publishing inside Home Assistant](docs/media/native-ha-workflow-preview.gif)](https://ha-homelab.github.io/home-studio/#native-ha-demo)

**[Watch the full video with English captions](https://ha-homelab.github.io/home-studio/#native-ha-demo).**
Start with a room photo and measurements, review a real AI proposal, then refine
it by hand: resize the room, drag items in 2D and 3D, use grid snapping or hold
**Alt** for precise placement, and adjust height. Link Home Assistant entities,
**Save draft**, and **Publish to 3D Home** without leaving HA.

AI is an optional starting point. Check its dimensions and placements before
publishing; you can also draw everything yourself. Your saved draft stays
separate from the view your household uses.

The walkthrough was recorded on [v0.10.1-beta.6](https://github.com/ha-homelab/home-studio/releases/tag/v0.10.1-beta.6). This native workflow is included in the 1.0 release line. Install the [latest stable release](https://github.com/ha-homelab/home-studio/releases/latest) through HACS; pre-release versions are optional.

## Make it your home

Draw measured rooms, add doors and windows, furnish them from **206 designs**,
and preview in 3D. The editor supports **24 languages**. A desktop browser with
a mouse or trackpad works best for drawing; the published plan is your everyday
view for lights, media, covers, and other linked devices.

Use **2D + 3D** on a wide workspace to keep the drawing and preview side by
side. Moving a room carries its walls, openings, and furniture; an explicit
connected-room option handles shared geometry. In Home Assistant you can also
start from selected **HA areas** with dimensions you enter, then select the
devices you want to place. TV and audio controls follow the device type, with
an explicit choice when HA does not identify it.

[Bind sliding curtains to windows](docs/curtain-authoring.md) to show their
reported opening position, or add the published home to a dashboard using the
[visual card editor](docs/dashboard-and-media.md). The integration registers its
card resource automatically on storage-mode dashboards.

Saved drafts and the published view are separate. An unfinished drawing or a
failed publication leaves the last successful view available. Use
**More options → Export drawing (JSON)** for an additional editable backup.
The [separate editor](#optional-help-while-setting-up-home-assistant)
is available further below if you need to keep drawing while resolving HA setup.

The installed viewer gives walls a soft, rounded profile with a transparent
teal finish, cyan upper edges and blue lower edges. Door and window openings
stay clear. Subtle color drift reuses existing desktop frames; mobile devices
and an idle plan stay still. See [wall rendering and resource limits](docs/rounded-walls.md).

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/15584/badge)](https://www.bestpractices.dev/projects/15584)

[![Fuzzing: RC only](https://img.shields.io/badge/Fuzzing-RC%20only-blue)](docs/fuzzing.md)

[How we test and release Home Studio](docs/quality-and-release.md) ·
[Saving and recovery](docs/first-session.md)

## Place your home on the map

The 1.2 beta line adds optional geographic context in the native Home Assistant
view. An administrator can align the house with the map using **Align map**.
Then zoom out to see the surrounding area, or zoom back in to use the 3D home.
The map uses the same renderer; detailed device controls return at house scale.

Alignment is stored separately in Home Assistant and is not added to exported
drawings. Map tiles come from OpenStreetMap, which receives the area being
viewed. See [map setup, privacy, and navigation](docs/map-navigation.md).

Use **Site & roof** in the editor to draw your building footprint and roof edge,
neighboring buildings, streets, and garden outlines on the same metric grid as
your rooms. The site becomes a lightweight outside view when you zoom out on
the HA map. You can also ask your connected AI to propose site shapes from
photos, identify your own home in the instructions, and review the result before
adding it. Existing rooms and device bindings stay intact.
[Follow the site drawing guide](docs/site-editor.md).

## Take your drawing into Blender

The 1.1 beta line adds **Export for Blender** directly to the Home Assistant
editor. Download the current floor or all floors as one GLB, or an OBJ + materials
ZIP. Current edits are included without saving or publishing. GLB keeps each
furniture item under a named parent so you can move the complete item in Blender.

Use the 25 cm or 5 cm grid, Alt-drag for free positioning, and the dedicated
item rotation buttons to refine the drawing first. A dropped HA connection
leaves editing and a local JSON backup available.

[Follow the illustrated Blender export guide](docs/blender-export.md).
Exports contain geometry and material colors, not device controls or credentials.
They still reveal the home's layout. Keep your drawing JSON: Blender edits do
not currently round-trip into the Home Studio editor.

## Choose your language

The drawing editor supports **24 languages**, including translated tools,
object names, palettes, patterns, dialogs, and accessibility labels. Choose a
language in the header; Arabic, Hebrew, and Persian support right-to-left text.
Your project names and entity IDs remain unchanged. Only the selected editor
language pack loads; no online translation service is used.

Read a [localized README quick start](docs/translations/README.md) for native HA
setup, or see [translation scope and how to contribute](docs/i18n.md). The drawing
and installation pages lead with the native workflow in English; their lower
sections include localized quick guides for the optional portable toolkit.
The installed viewer also translates everyday navigation, placement controls,
and device states into all 24 languages. It follows your Home Assistant language
until you choose another language in the plan. The detailed reference, command-line
diagnostics, and advanced device diagnostics remain in English.

## Try device buttons without operating anything

Enable **Dry run** in the installed plan's host header. It blocks switches,
TV power, curtain operations, and native Home Assistant dialogs that can expose
lock or other device controls. Readings remain real; there is no simulated
success. Bookmark the plan with `?dry_run=1` to pin this browser's view in Dry run.
Navigation and saved placement editing continue to work.

Read [the Dry run guide](docs/dry-run.md) for the exact boundary, storage behavior,
and verification. The installer's `--dry-run` is a separate archive-validation
option. For operating notes and troubleshooting, start at the
[repository documentation wiki](docs/wiki/Home.md).

See the [illustrated process and results](docs/process-and-results.md) for the
command boundary, browser persistence, translation coverage and evidence behind
the change. Its workflow diagrams distinguish local verification from release
acceptance.

![From the Dry run command guard to tests, packaged documentation, signed review and release acceptance](docs/images/dry-run-delivery-process.svg)

## Furnish your rooms

Open **Item library** to browse **206 designs in 22 categories**: furniture and
lighting, cushions and throws, curtains and blinds, rugs and tapestries, mirrors,
plants and life-size display bears, tabletop and bathroom accessories, pet furniture,
servers and electronics, toys, musical instruments and workshop tools,
vehicles, bicycles, sports gear, garden equipment, and more. Search for a
server rack, teddy bear, Tesla, café racer, moped, skis, or satellite dish, choose its thumbnail,
then click inside a room. You can also select a room and choose **Place item at
room center** for keyboard placement.

Select an item to change its **Design**, choose one of 18 coordinated **Color palette** themes,
or set a **Custom body color**. Fabric and decorative panels on supported designs
also offer **Surface pattern**: stripes, checks, diamonds, dots, herringbone, or
chevrons. Choose a separate **Pattern color**, or keep the palette’s accent. The
small item preview shows your choices immediately. **None** restores the original
surface; changing palette resets custom colors but keeps the pattern. Change its width, depth, height, elevation, and
rotation to match your measurements. A new design keeps your dimensions;
**Use design’s original size** restores the starting size. **Basic shapes &
devices** remains available for blocks, switches, outlets, and sensors.

![The item library with searchable furniture thumbnails](planner/guide-assets/08-library.jpg)

The same furniture geometry and colors appear in the 2D drawing, 3D preview,
downloaded models, and installed HA plan. Export your project JSON as the editable
source. Older projects retain their basic shapes until you choose a design.
The library is bundled locally: no asset account, remote model downloads, or
additional runtime dependencies are required. The library opens with 24 designs;
**Show more** reveals the next set. Search and category filters cover every design.

Try the [color and pattern studio](planner/guide-assets/pattern-studio.json) to
compare all six patterns in a furnished room. Export your current drawing first,
open the example with **Open JSON**, select a rug or cushion, and try another
palette or pattern. Patterns apply to designated flat fabric/decorative panels,
not every curved surface. Curtains are static furnishings; this does not create
Home Assistant curtain controls.

![A fictional room with patterned rugs, cushions, curtains and coordinated palettes](planner/guide-assets/11-pattern-studio.jpg)

Try the [fictional garage and creative studio](planner/guide-assets/garage-and-studio.json):
download the JSON, choose **Open JSON** in the editor, then **Preview 3D**. It
combines a car, motorcycle, bicycle, skis, server rack, teddy bear, music and art
supplies, and a patio. Export your current drawing first if you want to keep it.

![A fictional garage, creative studio, and patio with objects from the expanded library](planner/guide-assets/09-garage-studio.jpg)

Try the [decorated studio](planner/guide-assets/decor-studio.json) for floor and
wall textiles, a starburst chandelier, a wall sconce, a mirror, plants, a
balustrade, and a life-size bear. Wall designs already stand upright. Set their
bottom height with **y**, rotate them to face into the room, and inspect them in
3D. For ceiling lights, **y + Height** should reach your ceiling. The
[illustrated guide](https://ha-homelab.github.io/home-studio/planner/guide.html#table)
walks through these placements. Mirrors use stylized glass without a reflection
render pass; decorations do not introduce continuous animation.

![Fictional decorated studio with rugs, wall hangings, lights, plants, and a bear](planner/guide-assets/10-decor-studio.jpg)

These are original, simplified designs. Product-inspired names describe an
approximate silhouette, not a manufacturer-supplied model or exact dimensions.
Object libraries provide geometry; adding a server or car does not automatically
connect its telemetry to Home Assistant.

Edit furniture designs, palettes, and patterns in **Home Studio**, then **Save
draft** and **Publish to 3D Home**. The separate **3D Home** placement editor
can move, resize, rename, and bind existing objects; its inventory import does
not replace furniture models. Only the optional portable workflow requires
rebuilding and reinstalling after source geometry or appearance changes.

## Add a garden

Use **Add garden area** in Floor settings to make an editable outdoor area and
lawn. The Item library includes lawn patches, meadow borders, stepping stones,
hedges, trees, dogs, cats, rabbits, foxes, and birds. Place them inside or outside,
then move, resize, rotate, or recolor them like other furnishings. Saved catalog
objects, including pets and cars, remain static.

The **Surroundings** menu in Preview 3D and the installed Home view adds an
optional landscape around the site, with three palettes. **Decorative motion**
animates two scenery cars with varied speeds, arrival gaps, and colors, plus
three rabbits on bounded routes outside the site.
It is off by default, pauses when hidden or offscreen and for reduced-motion
preferences, and represents no Home Assistant device or occupancy state.
These surroundings settings last for the current page; the editable garden and
placed objects are saved in your project. See the [garden guide](docs/environment.md).

![Fictional Garden Studio showing editable planting, pets, and optional geometric surroundings](docs/images/garden-surroundings.png)

## Optional help while setting up Home Assistant

If installation is not working yet, start with the
[HA troubleshooting guide](docs/home-assistant-editor.md#troubleshooting).
You can keep drawing in the [separate hosted editor](https://ha-homelab.github.io/home-studio/planner/)
or try a [fictional practice home](https://ha-homelab.github.io/home-studio/planner/?example=practice)
while you resolve setup. It requires no account, stores a draft in that browser,
and does not connect to or control HA.

Choose **Export JSON** to keep your drawing. Once Home Studio is installed in
HA, choose **Open JSON**, check your devices, **Save draft**, and **Publish to 3D Home**.
Opening either editor does not transfer a project automatically.

### Optional portable toolkit: draw, build, and preview

Use this route only if you want a local compiler and file-based deployment, or
already maintain a generated home. These Python commands are not part of the
recommended HA setup above. The toolkit requires Python 3.10 or newer, with no
extra Python packages.

1. Follow the [drawing guide](https://ha-homelab.github.io/home-studio/planner/guide.html)
   and choose **Export JSON** in the editor. Keep that file as your source.
2. Open the [latest stable release](https://github.com/ha-homelab/home-studio/releases/latest),
   choose `home-studio-VERSION.zip` under **Assets** (not GitHub's **Source code**
   ZIP), extract it, and open a terminal in the extracted `home-studio` folder.
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

### Optional portable toolkit: install the compiled package

Home Studio provides a Lovelace dashboard card, media-player artwork, sensor
and thermostat readings, native HA controls on hover, and a compact audio remote.
See [dashboard and artwork setup](docs/dashboard-and-media.md) and
[device controls](docs/device-controls.md). Updating the hosted planner alone
does not update an existing Home Assistant installation.

Generated installations can also configure [appliance and presence indicators](docs/indicators.md):
smoke and battery status, symbolic cooktop and oven activity, and a small
room-presence badge. These optional displays require model metadata; the
portable planner does not yet provide a form for configuring them.

For in-HA drawing and publishing, follow the [native editor guide](docs/home-assistant-editor.md).
The commands below remain available for the separate editor and portable toolkit.

In the installed **Home view**, choose **Rotate** to turn the map or **Move** to
pan it with a mouse or touch drag. Shift-drag and right-drag also pan; the
percentage button resets the view. See the
[Home camera controls](docs/first-session.md#rotate-the-installed-home-view)
for keyboard shortcuts and upgrade guidance.

Use the [complete installation guide](https://ha-homelab.github.io/home-studio/install.html)
for portable-package setup, Home Assistant OS file transfer, and updates.

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

## Draft from room photos with your own AI

Inside **Home Assistant → Home Studio**, choose **Draft from photos (AI)** when
available to open **Plan from photos**. Connect your own provider with its exact
vision-model ID and a session-only API key. Add room
photos, instructions and measured dimensions; generate, review in 2D/3D, and apply
selected additions as one undoable edit. Then **Save draft → Publish to 3D Home**.
No separate editor, terminal or JSON transfer is needed for this native workflow.
AI is optional; manual drawing and published device controls work without a key.

The key field is masked and cleared after connection. The native integration holds
credentials in a user-bound session in HA process memory for at most 30 minutes.
End session clears the key and cancels pending generation. Credentials and source
photos are not saved in project JSON, browser storage or HA configuration. Generate
sends your selected photos, instructions and room context to the chosen provider,
with the key for authentication. Use HTTPS for remote HA access.

For a separate desktop workflow, the optional Python 3.10+ companion remains:

```sh
python3 scripts/serve-ai-planner.py
```

On Windows use `py -3 scripts/serve-ai-planner.py`. Export its accepted JSON and open
it in HA when ready. Credentials stay in temporary companion memory and out of project/browser storage.
Cloud generation sends the chosen data and authentication key to your provider;
local generation requires a loopback model runtime. There is no Home Studio AI relay.
The hosted website does not collect keys, and the installed HA viewer has no AI dependency.
Adapters are mock-tested; exact live model compatibility still needs a user smoke test.

[Quick start](https://ha-homelab.github.io/home-studio/ai-setup.html) ·
[Workflow and privacy](docs/ai-planning.md) · [Provider setup](docs/ai-provider-setup.md) ·
[Local models](docs/ai-local-models.md) · [Architecture](docs/ai-planner-architecture.md)

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
python3 scripts/generate-furniture-catalog.py --check
python3 scripts/test-furniture.py
node scripts/test-i18n.mjs
python3 scripts/validate-site.py
python3 scripts/validate-site.py --output _site
```

For browser regression checks, install Node.js 22 or newer, run
`npm ci --ignore-scripts`, then `npx playwright install chromium firefox` and
`npm run test:planner`. On a Linux CI host, use
`npx playwright install --with-deps chromium firefox`. Run
`node scripts/test-browser-stability.cjs` for multi-light interaction and WebGL
recovery checks in both engines. Run `node scripts/test-planner-stability.cjs`
for two-floor drawing, furniture dragging, preview orbit, and graphics recovery
in the browser editor. See [browser compatibility](docs/browser-compatibility.md)
for rendering budgets, measured coverage, and a safe bug-report checklist.
The public CI gate also requires [cross-platform acceptance](docs/platform-acceptance.md):
package installation on Linux, Windows, and macOS; pinned Chromium, Firefox,
and WebKit generations; Chrome and Edge channels; native Firefox and Waterfox;
and native Safari on macOS. Phone and tablet viewport checks supplement desktop
coverage. The linked matrix distinguishes emulation from physical-device testing
and records the exact versions actually launched.
These are development tools only;
users do not need Node.js or Playwright to draw, compile, or install a plan.
The browser test exports a real drawing and installs that exact file's package
into a temporary config directory without contacting a live HA instance.

![The release path: pull request checks, beta qualification, RC with fuzzing, and promotion of the same verified files to stable](docs/assets/quality/release-pipeline.svg)

The [illustrated quality guide](docs/quality-and-release.md) explains what each
stage proves, how to inspect its public evidence, and which environments still
need testing on real hardware.

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

### Lower-floor context

In **Whole floor** view, the nearest lower storey appears as muted architectural outlines beneath the active floor. Use **Lower floor outline** to hide it. Selecting a room hides the context automatically; returning to Whole floor restores your choice. Only the active floor has labels and device controls, and its zoom and framing stay unchanged.

For a planner project, draw all floors against the same X/Z origin and set their `elevation_m` values to their finished-floor heights. For example, use `0` for the ground floor and `2.9` for an upper floor 2.9 metres above it. The compiler selects the nearest lower elevation regardless of list order. A single-floor project needs no changes. Model downloads remain separate floor models.

Site builds can also add muted, read-only vehicle or energy cards in unused space.
These reuse Home Assistant state updates and show the last reported measurements.
Power labels beside objects appear only above zero. They do not add controls,
poll devices or cover the active floor; see [passive telemetry](docs/architecture.md#passive-telemetry-and-power-labels)
for the optional site-model bindings.

## Release validation

Public release candidates run bounded, offline mutation tests against project
validation and geometry. See the [fuzzing guide](docs/fuzzing.md) for targets,
budgets, synthetic data rules and reproduction, and [release instructions](RELEASING.md)
for versioned source ZIPs. Beta builds and ordinary pull requests do not run
mutation campaigns.

An optional [closed package worker](docs/closed-build.md) can compose approved
site inputs inside the public release orchestration while keeping its archives
and diagnostics in closed storage. It verifies exact public release bytes and
requires separate installation acceptance.


## Contributing and security

See [contribution and test requirements](CONTRIBUTING.md), [private security reporting](SECURITY.md), [governance](GOVERNANCE.md) and the [roadmap](ROADMAP.md).

## Screenshot artwork

Regenerate the perspective cover with `bash scripts/render-docs-hero.sh`
(ImageMagick 7). It preserves the original screenshot and only adds a geometric
projection and shadow. The linked flat image remains the readable reference.
