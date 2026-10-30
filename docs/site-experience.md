# Website experience and operating guide

Home Studio's public overview and help pages use a small progressive enhancement
layer. GitHub Pages still serves ordinary HTML, local styles, local modules and
reviewed images. A JavaScript framework or application server is not required.

The overview shows the actual editor with a fictional room. The floating Draw,
Connect and Publish cards explain the product workflow; they are not readings
from a connected home. The recorded walkthrough remains a user-controlled video.

## Presentation and accessibility

`site.css` styles the overview and documentation. The editor and installed viewer
do not load it. The floating navigation, perspective stage and scroll reveals
are enhancements to readable HTML with ordinary links.

`site-experience.js` observes visible sections, applies a bounded pointer tilt and
manages the shared page lifecycle. Respect `prefers-reduced-motion` throughout:
content must stay visible, and decorative movement must stop. Touch devices must
not require hover, precision pointing or a 3D effect to reach any information.
Animations should do no continuous work for a hidden document or offscreen scene.

Keep the skip links, meaningful headings, visible focus, descriptive image text
and explicit fictional-example captions when changing the layout. Header height
must be reflected in scroll offsets, including on narrow screens.

## Client-side page navigation

Only the six overview/help pages participate: `index.html`, `install.html`,
`ai-setup.html`, `privacy.html`, `planner/guide.html` and
`planner/publishing.html`. Normal links remain the source of navigation. Editor
routes, downloads, external links and new-tab clicks retain browser behavior.

The controller fetches same-origin documents, checks their expected structure,
updates the page content, title and description, and reinitializes page-specific
behavior. It does not execute scripts found in fetched HTML. Required modules and
styles come from fixed local allowlists. A failed transition returns to ordinary
navigation rather than leaving an unusable partial page. Back/forward history,
fragment links and keyboard focus are part of the navigation contract.

The localized quick route has a mount/dispose lifecycle in `planner/help.js`.
Dispose it before replacing a page, then mount the new topic. This prevents an
old page's locale subscription from updating a detached element. Keep the full
English reference usable without the localized enhancement.

## Public GitHub metadata

Only the overview contains the repository activity block. When it enters view,
the browser requests `https://api.github.com/repos/ha-homelab/home-studio` without
a token. It displays public stars, forks and repository update information. It
never reads a Home Assistant project or sends a room, device catalog or credential.

A tab-local snapshot is fresh for 20 minutes. A manual Refresh requests a new
snapshot. Older data can remain visible, explicitly labeled with its check time,
when the API is unavailable. The cache contains only these public numbers and
timestamps, under `home-studio.public-repository.v1`.
Show the check time and distinguish cached data, loading and unavailable states.
Network failures and API limits must not appear as invented zero counts. The
site remains usable when GitHub's API is unreachable or browser storage is denied.
See the [privacy notice](../privacy.html).

The six pages share a Content Security Policy allowing local scripts, styles,
images and video. Their connection policy permits the same origin for page
transitions and `https://api.github.com` for this one metadata endpoint. The
editor keeps its separate network restrictions. Do not add analytics or expand
these source lists for an unrelated feature.

## Packaging and publication

`scripts/validate-site.py` contains the explicit public asset allowlist. Its
`EDITOR_FILES` subset also supplies help pages to the local companion and the
installed integration. Keep `ai_companion/assets.json` synchronized when adding a
shared help asset. The overview and promotional video files remain excluded from
the installed editor package. A local installation can serve help pages without
contacting GitHub's API because it does not contain the overview metadata block.

For browser checks, use Node.js 22 or newer, run `npm ci --ignore-scripts`,
then install the test browsers with `npx playwright install chromium firefox webkit`
(or add `--with-deps` on Linux). These are development prerequisites only.

Validate before pushing:

```sh
python3 scripts/validate-site.py
python3 scripts/validate-docs.py
node --test scripts/test-site-experience.mjs
node scripts/test-site-experience.cjs
node scripts/test-help-i18n.cjs
python3 scripts/test-ha-native.py
python3 scripts/test-public-package.py
```

The package CI runs the site journey checks alongside the existing integration,
localization and platform checks. Publishing uses the existing GitHub Pages
workflow and its reviewed allowlist. Coordinate changes to shared help assets
with any release already pinned to a particular source commit before merging.

## Troubleshooting

- **The page is readable but does not animate:** check the operating system's
  reduced-motion setting. If JavaScript is blocked, plain HTML is the intended
  fallback. Check that `site-experience.js` returns JavaScript rather than a 404
  HTML response and that the deployed HTML and assets come from the same commit.
- **A link reloads the whole page:** editor/external/download links deliberately
  use normal navigation. A failed fetch also falls back to it. Inspect the target
  document's HTTP status and local module/style paths before changing the router.
- **Translations retain the previous topic:** check mount/dispose cleanup and
  language propagation after moving between installation, drawing and publishing.
  Run the help journey test; do not hide the original English reference to fix it.
- **Repository activity is unavailable or old:** the public API may be offline or
  rate limited. The check time identifies cached data; use Refresh later. Do not
  embed a GitHub token in the page to increase the limit.
- **A heading lands behind the navigation:** inspect the measured header-height
  variable and scroll margins at the affected viewport and text zoom. Test both
  an in-page anchor and a fragment opened directly in a new tab.
- **An installed help page loses a script:** check both the public allowlist and
  the companion list, then rebuild the package. Do not solve a packaging omission
  by loading executable code from a CDN.
