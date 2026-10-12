# Home studio

**[Open Home studio](https://ha-homelab.github.io/home-studio/)** ·
**[Illustrated drawing guide](https://ha-homelab.github.io/home-studio/planner/guide.html)**

Draw rooms, add walls, doors and windows, place furniture, and explore your
design in 3D. No account or installation is needed to draw. Use a desktop
browser and a mouse or trackpad for the editor. The guide also reads on a phone.

Your project stays in browser storage. **Export JSON** downloads a portable copy;
**Open JSON** restores it. The included examples and screenshots are fictional.
Read [privacy and storage](https://ha-homelab.github.io/home-studio/privacy.html)
before sharing your own project.

## What this release includes

- A 2D floorplan editor with dimensions, multiple floors, undo/redo and 3D preview.
- A seven-step screenshot tutorial and its editable practice file.
- Local JSON import/export. No analytics, backend or device connection.

This is the public drawing tool. It does not include a Home Assistant installer,
the private household configuration, original reference photos or their Git
history. JSON export is an editable project, not an HA installation archive.

## Run a downloaded copy

Python is optional for serving a downloaded copy; it is not needed on the website.

```sh
python3 -m http.server 8099 --bind 127.0.0.1
# Open http://127.0.0.1:8099/ in your browser.
```

Use the same address to return to the same local draft. To move a design from the
website to a downloaded copy, export it first and open the JSON file there.

## Publication checks

```sh
python3 scripts/validate-site.py
python3 scripts/validate-site.py --output _site
```

The publisher copies an explicit file allowlist, verifies links and resource
paths, rejects symlinks and common private-data patterns, and stages only those
files. The GitHub Pages workflow deploys that staged directory on GitHub-hosted
runners. No household services or self-hosted runners are involved.

These automated checks supplement manual review; they cannot prove an image or
every future source edit is free of personal information. Review screenshot
pixels and exported project contents before committing.

Bug reports should describe the browser and reproduction steps using the
fictional example. Never attach credentials or a real home design to a public
issue. Third-party notices: [Three.js](vendor/THREE-LICENSE.txt).
