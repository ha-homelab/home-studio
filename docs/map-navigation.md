# Geographic map navigation

The Home controls view can zoom from the 3D floor into an OpenStreetMap background. The map shares the existing scene and renderer. An administrator must align and enable the home before other signed-in viewers can use its geographic context.

## Align a home

1. Open **Home controls** in the native Home Assistant panel as an administrator and select **Align map**. Opening alignment immediately requests map tiles around the saved alignment, or HA's configured location if no alignment is saved. **Cancel** discards settings changes but cannot undo those requests.
2. Choose a known point in the model. Enter its **Model point X (m)** and **Model point Z (m)**, using the model's calibrated metre coordinates.
3. Enter the geographic latitude and longitude of that same point. **Use HA location** copies Home Assistant's configured location as a starting point. It does not change Home Assistant's location or `zone.home`.
4. Set **North angle (°)** and drag the map beneath the footprint to check alignment. North angle is clockwise from geographic north to the model's −Z direction: at 0°, model +X is east and model −Z is north; at 90°, model −Z points east.
5. Leave **Enable map** selected and choose **Save alignment**. **Cancel** restores the saved alignment and previous view. Clearing **Enable map** and saving disables normal map viewing while retaining the alignment.

The alignment belongs to the integration and is shared across floors. Floors need a consistent model coordinate system and metre scale. Changing a plan's origin, scale, or orientation may require realignment. Latitude is limited to −85°…85°, longitude to −180°…180°, model X/Z to ±10,000 metres, and north angle to 0°…360°.

An administrator can preview tiles while aligning a home whose map is disabled or has not yet been configured. A locked dashboard card cannot change alignment. If another administrator saves first, the revision check rejects an outdated save; reload map settings and reapply the change.

## Navigate

- Use the mouse wheel, pinch gesture, or **− / +** buttons to zoom. Wheel and pinch zoom keep the pointed-to map location in view.
- **Map** opens geographic context; **Home**, the percentage/reset button, or the **Home** key restores the model view.
- At model scale, drag to rotate. **Move**, Shift-drag, or right-drag pans. At map scale, dragging pans automatically.
- Focus the rendered view to use arrow keys. Shift+arrows pan at model scale; arrow keys pan at map scale.
- The camera gradually approaches an overhead view as the map becomes prominent. At distant scales, a footprint and home marker replace detailed scene interaction. Room and device overlays are hidden at those scales; return home or zoom in to use them.

Changing floors retains the map's current center and visible vertical span even when the floor footprints differ, along with zoom, rotation, and tilt. The center is a point in the model's metre coordinate system, not a latitude/longitude pair. The host retains these local camera parameters only in memory; it clears them when the panel detaches or the account changes. Reloading the browser starts a new view. Navigation does not save geographic coordinates to browser storage or alter the home alignment.

Normal device controls, including short presses and the existing 650 ms native-details gesture, retain their established behavior. Map navigation and alignment are non-device operations and remain available in dry run; device-command restrictions still apply.

## Authentication and location privacy

The opaque viewer iframe uses its dedicated `MessagePort` to ask the native HA host for map settings, save an alignment, or retrieve a tile. The host allows only those operations, calls Home Assistant with the signed-in session, and returns validated fields. No HA access token, arbitrary request URL, or raw transport error is sent to the iframe. The iframe does not gain general network or WebSocket access.

The authenticated APIs are:

- `home_floorplan/map_get`: returns the saved revision, optional alignment, and HA location reference.
- `home_floorplan/map_save`: checks administrator permission, validates the alignment, and saves only against the current revision.
- `home_floorplan/map_tile`: accepts only bounded numeric `z/x/y` coordinates and returns a validated PNG. Regular authenticated viewers require an enabled saved alignment; administrators may also preview tiles for setup.

The location and orientation are stored privately in Home Assistant under the integration's `home_floorplan.map` storage key. They are separate from the portable plan/project data and exported model files. Signed-in users who can use the integration's map API can read this geographic alignment and the HA location reference. Treat HA backups containing that storage, screenshots, and recordings of the map as location-bearing material.

Tiles are requested by Home Assistant from the fixed OpenStreetMap tile service. The provider receives HA's outbound IP address and requested tile coordinates; those coordinates identify the viewed geographic area. The request does not include the HA token, home model, device states, or configured point as a separate payload. Proxying tiles through HA keeps the browser's authentication boundary intact; it does not hide the viewed area from the tile provider.

The host permits at most four tile calls and one settings call at a time, with 64 queued requests. A floor change drops queued work and ignores stale responses, while already dispatched calls retain their slots until HA settles them. The backend separately bounds upstream requests and cache size, respects tile freshness information, and fetches only tiles needed for the current view. There is no bulk or offline-area downloader.

The map displays **© OpenStreetMap contributors**. The native HA panel also shows a working [OpenStreetMap copyright link](https://www.openstreetmap.org/copyright) while the map is enabled or being previewed, without relaxing the iframe sandbox. Keep this credit visible in map screenshots or other redistribution. Tile use is subject to the provider's [tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

## Scope and recovery

This is raster map context for one aligned home. It does not provide address search, directions, traffic, satellite imagery, terrain elevation, 3D buildings, or a globe. The local alignment uses a Mercator map with scale set at the home latitude; it is intended for home and surrounding-area context, not survey measurements or accurate continent-scale model placement. Map availability and street/building detail depend on the upstream provider.

An unavailable tile or map service leaves the home controls usable. **Retry map** retries failed map loading; **Home** returns to model scale. A successful alignment save is confirmed only by HA. A save error does not overwrite the previously saved alignment. Corrupt or unreadable map storage is preserved and reported as unavailable rather than silently replaced.

Standalone/portable viewers do not contain the private alignment or an authenticated tile transport. This feature requires the native Home Assistant host. Tests use fictional fixtures, a fake HA connection, and synthetic tiles; no real home coordinates are needed.

Existing saved views retain the runtime they were published with. After updating the integration, republish a native project to add the map controls. For an externally generated home, rebuild and install its baseline with the updated tools while preserving its saved placements and bindings; republishing alone preserves that baseline's existing runtime. Updating the integration's files does not by itself migrate previously generated viewer HTML.

## Bridge regression check

Run `node --test scripts/test-ha-map-bridge.cjs` from the repository root after installing the development dependencies and Playwright Chromium. It exercises the actual host code with fake HA/MessagePorts, including authentication and edit restrictions, request/result validation, bounded queues, stale-session handling, local camera persistence, attribution, and dry-run separation. Its browser case loads the real panel on a loopback server and exchanges messages with an opaque iframe, including unconfigured and disabled maps, saves and revision conflicts, missing backend commands, account changes, and a working attribution link. External browser requests are blocked by the test harness.

Map navigation messages may include `target_x`, `target_z`, and `span_m` together to retain the exact model-space center and view extent across floors. The target axes are bounded to ±2,000,000 metres and the vertical span must be between 0.01 and 40,000,000 metres. Partial or invalid triples are rejected; older messages without this optional triple retain their relative-pan behavior.

## Ground and roof context in compiled models

Model geometry stays in its existing floor-local metre coordinates. Optional `site_context.ground_elevation_m` specifies physical site ground in that frame; the native compiler uses the ground entered in [Site & roof](site-editor.md), or the lowest floor elevation when no site has been authored. The compiler also supplies `site_context.lowest_slab_elevation_m`, the lowest slab vertex across all floors expressed in the active floor's frame. This derived slab height is independent of the authored ground and roof heights. The map sits 0.08 m below the lowest of these values, the active floor slabs and the lower-floor context, so its absolute height stays consistent when switching floors. The optional slab height accepts finite values within ±1,000 m; invalid values are ignored. Older models retain their existing ground and visible-slab fallback. Lower architecture therefore remains above the map without moving the upper floor, changing calibration or saving a new geographic alignment.

Optional `site_context.roof_outline` contains `polygons_m` and `elevation_m`. Each polygon is an open list of metric `[x,z]` vertices; the renderer closes it at the supplied floor-local roof height. Coordinates are bounded to ±10,000 m, heights to ±1,000 m, and the outline to 16 simple polygons with 3–256 vertices each and at most 512 vertices total. Invalid outlines are ignored as a whole. This is a light contour during the map transition and overview, not a roof surface or interactive object. It disappears at normal Home scale.

Without an explicit roof outline, bounded non-overlapping rooms forming one connected polygon can supply an exterior footprint with shared edges removed. Disconnected, ambiguous or oversized geometry uses the home marker without guessing a roof. These local model fields neither contain geographic coordinates nor change the private map configuration. Photo-derived outlines should be supplied privately and identified as estimates unless surveyed.
