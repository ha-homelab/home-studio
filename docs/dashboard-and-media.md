# Put your home on a dashboard, with media artwork

Available in the 0.9.0 beta series after the initial floor-navigation beta.
Use the release notes to select a beta that includes **dashboard cards and
media artwork**. Stable 0.8.0 and the first 0.9.0 beta do not include these features.

## Upgrade the installed home first

Keep your exported project JSON and project ID, make a Home Assistant backup,
and rebuild with the new beta toolkit. Follow the
[update instructions](https://ha-homelab.github.io/home-studio/install.html#updates)
and, for Home Assistant OS, the
[Samba transfer steps](https://ha-homelab.github.io/home-studio/install.html#haos).
Stop Core before replacing the component; check the configuration and start Core
afterward. Refresh the browser once the replacement is complete.

Updating the hosted drawing editor does not change a previously generated home.
The ordinary **3D Home** sidebar panel remains available after this upgrade.

## Add a dashboard card

1. Sign into Home Assistant as an administrator. The card has the same
   administrator requirement as the full sidebar panel.
2. Open **Settings → Dashboards → Resources**. Enable Advanced mode in your
   profile if Resources is not visible. Add a **JavaScript module** resource:

   ```text
   /home-floorplan-static/card.js
   ```

3. Edit a dashboard and add the **Home Studio** custom card, or use a manual card:

   ```yaml
   type: custom:home-floorplan-card
   height: 600
   sidebar_collapsed: true
   dry_run: true
   ```

4. Verify the home and its bindings. `dry_run: true` keeps real device commands
   blocked for this card. Remove it or set it to `false` when you intend to use
   live controls. The existing remembered dry-run preference can still keep
   commands blocked; the card's status tells you which mode is active.

The optional `floor` field selects the initial floor by its **ID**, for example
`floor: main`. Use the ID from your project JSON, not the display name. Omit it
to open the project's default floor. You can still switch floors inside the card.
`height` is a number of pixels from 240 to 1600; the default is 600.
`sidebar_collapsed` defaults to `true` to leave more room for the map.

In YAML-managed dashboards, declare the same resource under the existing
`lovelace.resources` list with `type: module`. Do not add a second top-level
`lovelace` key. Resource registration is manual; installing the component does
not rewrite your dashboards.

Each visible card owns a viewer. Prefer one card per view on slower devices.
Removing a card releases its viewer resources. The card reuses the existing
authenticated connection and opaque iframe boundary; it does not need an access
token in YAML, a public home URL, or a second copy of your project.

## Show cover artwork

In **Edit layout → Plan & placement**, link a suitable item to the real
`media_player` entity and wait for **Saved in Home Assistant**. Start media that
has cover artwork available in that entity's normal Home Assistant controls.
Return to **Home view**. The media callout displays available cover artwork and
track information when there is free space beside the plan.

This is the album cover or other artwork supplied by the media integration.
It is not a screenshot of the TV, a video stream, or an automatic camera feed.
An existing private TV-capture adapter keeps priority for its configured screens.

The trusted host requests artwork from Home Assistant's own media-player proxy
using the current HA session. Only bounded JPEG pixels and display metadata
reach the viewer. Raw artwork URLs, media access tokens, and credentials are not
sent into the iframe. The media integration may itself contact its provider to
retrieve artwork, just as it does for the native Home Assistant media controls.

Up to 16 saved media-item placements are considered on each floor, with at most
two concurrent image requests. Images are reduced to at most 512 pixels per
edge; unsupported formats, oversized images, and animations are rejected.
Updates follow media changes rather than a background polling loop. Temporary
failures can keep the last good image for the same media identity. A different
track, an unavailable or off player, a removed binding, or disconnection clears
stale artwork. Images remain in memory and are not added to your project JSON.

## Troubleshooting

- **Custom element does not exist:** rebuild and reinstall with a beta containing
  this feature, check that `/home-floorplan-static/card.js` loads, and register it
  as a JavaScript module. Then refresh the dashboard.
- **Access is restricted:** the generic viewer is administrator-only. Adding a
  card does not bypass the backend permission check.
- **Wrong initial floor:** use the exact floor ID from your own project JSON.
- **No artwork:** check the media player's native HA controls and its saved
  binding. Unsupported, oversized, or malformed images are rejected. Off and
  unavailable players do not retain artwork. A busy or small layout may have no
  free space for a callout; enlarge the card or hide its sidebar. A failed initial
  artwork request is not retried continuously. Return to the tab after hiding it,
  reload the saved plan, or change media to start a fresh request.
- **Controls do nothing:** inspect the dry-run status and the entity's current
  availability. A card configured with `dry_run: true` cannot turn live controls
  on from inside that card.
- **Existing installation looks unchanged:** a new source download or hosted
  planner update is not an installed-viewer update. Rebuild and replace the
  generated package, then restart Core.

Report the Home Studio version, browser, whether this is the sidebar panel or
dashboard card, and a small fictional reproduction. Do not attach your private
home layout, HA token, or media-proxy URL containing a token.
