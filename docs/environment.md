# Garden surroundings

The planner and compiled Home view have a **Surroundings** dropdown. **Show garden surroundings** adds a small, geometric landscape around the complete site's bounding rectangle. **Sage garden**, **Summer meadow**, and **Blue dusk** change its palette. Scenery never changes the camera fit, room selection, exported architecture, inventory, or Home Assistant entities. Controls are view preferences for the current page; they are not saved into the project.

**Decorative motion** is off by default. It animates two small cars on a dedicated lane beyond the site and three rabbits in the side lawn. The routes are decorative, deterministic, and bounded; they do not represent occupancy, tracked vehicles, or device state. Ordinary placed catalog objects remain static. Motion runs at most once per 180 milliseconds (500 ms on reduced render profiles; 750 ms on diffuse software profiles) and pauses in Plan mode, on a hidden page, outside the viewport, during graphics-context loss, and when the system requests reduced motion. Time pauses too, so returning to a view does not catch up missed animation.

For an editable garden, use **Add garden area** in Floor settings. It uses the entered origin and dimensions to create an ordinary outdoor area and a resizable lawn object. Search the Item library for lawn, meadow, path, hedge, cypress, tree, dog, cat, rabbit, fox, or bird. These are ordinary saved items: move, rotate, resize, recolor, undo, export, and place indoors or outdoors. The floor's existing ceiling-height constraint still applies to tree height.

## Shared renderer API

`planner/environment.js` has no runtime imports or network dependencies. The compiler replaces `__ENVIRONMENT_JS__` in `viewer.js` with this module's text after removing `export ` prefixes. Include the same replacement when a legacy builder consumes the shared viewer. The runtime bundle and static-site inventory include the module.

```js
const layer = createEnvironmentLayer(THREE, {
  scene,
  bounds: { minX: -2, maxX: 18, minZ: -3, maxZ: 16 },
  elevation: -3, // Ground Y relative to the active floor; not the active ceiling.
  visibilityElement: renderer.domElement,
  requestRender,
  frameInterval: 1000, // Optional slower pacing for a large scene.
  settings: { enabled: true, motion: false, palette: 'sage' },
});
layer.setSettings({ motion: true });
layer.setActive(false); // Switching to an inactive view or losing the GL context.
layer.setBounds(nextSiteBounds, nextGroundY);
layer.dispose();
```

The caller supplies bounds covering **all existing rooms, walls, yard structures, equipment and planted items**, not only the building outline. Scenery begins at least 0.5 m outside those bounds. The default viewer derives a full geometry bound; explicit bounds are preferred for legacy sites. `setBounds` rebuilds only when the site or ground level changes. `setActive(true)` resumes only when the other visibility and motion conditions permit it. `dispose()` releases shared materials, geometries, instance buffers, timer and observers.

For the compiled viewer, set optional model metadata:

```js
model.environment = {
  enabled: true,
  motion: false,
  palette: 'sage',
  frame_interval_ms: 1000, // Optional; clamped to 180–2000 ms.
  bounds: { minX: -2, maxX: 18, minZ: -3, maxZ: 16 },
  elevation: -3,
};
```

Without `enabled: true`, the layer allocates no geometry or materials and has no animation timer. Public compilation emits settings with both toggles off, bounds for all floors, and the lowest floor elevation relative to the current floor. This keeps the same landscape on the ground when switching upstairs. `window.floorplan.surroundings` and `window.planner.getPreviewMetadata().surroundings` expose diagnostic counts and paused/running status.

The layer uses shared `InstancedMesh` batches, flat unlit materials, no textures, no dynamic lighting and no shadow rendering. All five actors are allocated once on first enable. Palette changes replace and dispose that small resource set; animation updates only instance transforms and requests a motion frame through the existing renderer, preserving adaptive gesture throttling. The enclosing scene still incurs its normal rendering cost while motion is enabled, so static is the default.

## Verification

- `node scripts/test-environment.mjs`: no allocation while off, bounded shared draw batches, full scenery envelopes outside the site during 108 seconds of simulated motion, visibility/reduced-motion/lifecycle pause, palette replacement and disposal.
- `node scripts/test-environment-browser.cjs`: real garden placement, indoor/outdoor catalog items, unchanged camera fit, static idle rendering, reduced-motion pause, compiler metadata and Home controls. Set `ENVIRONMENT_SCREENSHOT_DIR` to save fictional-example screenshots.
- Existing furniture JS/Python, planner rendering budget and viewer lifecycle checks cover compatibility with catalog generation and on-demand rendering.
