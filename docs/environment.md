# Garden surroundings

The planner and compiled Home view have a **Surroundings** dropdown. **Show garden surroundings** adds a small, geometric landscape around the complete site's bounding rectangle. **Sage garden**, **Summer meadow**, and **Blue dusk** change its palette. Scenery never changes the camera fit, room selection, exported architecture, inventory, or Home Assistant entities. Controls are view preferences for the current page; they are not saved into the project.

**Decorative motion** is off by default. It animates two small cars on fixed lanes beyond the site and three rabbits in the side lawn. Passing cars vary their speeds, arrival gaps, and muted body colors. Each car travels at 0.22–0.46 m/s, with a 2–9 second gap before its next pass. The routes are decorative and bounded; they do not represent occupancy, tracked vehicles, or device state. Ordinary placed catalog objects remain static. Motion runs at most once per 180 milliseconds (500 ms on reduced render profiles; 750 ms on diffuse software profiles) and pauses in Plan mode, on a hidden page, outside the viewport, during graphics-context loss, and when the system requests reduced motion. Time pauses too, so returning to a view does not catch up missed animation.

For an editable garden, use **Add garden area** in Floor settings. It uses the entered origin and dimensions to create an ordinary outdoor area and a resizable lawn object. Search the Item library for lawn, meadow, path, hedge, cypress, tree, dog, cat, rabbit, fox, or bird. These are ordinary saved items: move, rotate, resize, recolor, undo, export, and place indoors or outdoors. The floor's existing ceiling-height constraint still applies to tree height.

![Fictional Garden Studio in the planner, with an editable garden and optional surroundings](images/garden-surroundings.png)

This screenshot uses the synthetic Garden Studio project from the browser test.
The small garden beside the house contains saved catalog objects. The outer
planting strips and road are optional surroundings; enabling their motion does
not animate the placed dog, cat, or other catalog objects.

## Shared renderer API

`planner/environment.js` has no runtime imports or network dependencies. The compiler replaces the complete `/*__ENVIRONMENT_JS__*/` comment in `viewer.js` with this module's text after removing `export ` prefixes. Include the same replacement when a legacy builder consumes the shared viewer. The runtime bundle and static-site inventory include the module.

```js
const layer = createEnvironmentLayer(THREE, {
  scene,
  bounds: { minX: -2, maxX: 18, minZ: -3, maxZ: 16 },
  elevation: -3, // Ground Y relative to the active floor; not the active ceiling.
  visibilityElement: renderer.domElement,
  requestRender,
  frameInterval: 1000, // Optional slower pacing for a large scene.
  seed: 42, // Optional repeatable traffic; otherwise chosen once for this layer.
  roadSide: 'maxZ', // Optional entry side: 'minZ' (default) or 'maxZ'.
  settings: { enabled: true, motion: false, palette: 'sage' },
});
layer.setSettings({ motion: true });
layer.setActive(false); // Switching to an inactive view or losing the GL context.
layer.setBounds(nextSiteBounds, nextGroundY);
layer.dispose();
```

The caller supplies bounds covering **all existing rooms, walls, yard structures, equipment and planted items**, not only the building outline. Scenery begins at least 0.5 m outside those bounds. The default viewer derives a full geometry bound; explicit bounds are preferred for legacy sites. `setBounds` rebuilds only when the site or ground level changes. `setActive(true)` resumes only when the other visibility and motion conditions permit it. `dispose()` releases shared materials, geometries, instance buffers, timer and observers.

`roadSide` selects the negative or positive Z edge of those bounds. It moves the
road, path, adjoining lawn strip and both car lanes together; side planting and
rabbits remain in place. Traffic keeps the same X direction and timing; the +X
car stays on the +Z lane on either side. This is
fixed site configuration for the layer, so UI preference changes do not reset it.
Unspecified or unrecognized values use `minZ`. Changing site bounds keeps the
selected side and moves the approach outside the new edge.

For the compiled viewer, set optional model metadata:

```js
model.environment = {
  enabled: true,
  motion: false,
  palette: 'sage',
  frame_interval_ms: 1000, // Optional; clamped to 180–2000 ms.
  seed: 42, // Optional unsigned 32-bit traffic seed.
  road_side: 'maxZ', // Optional; choose the side containing the front entry.
  bounds: { minX: -2, maxX: 18, minZ: -3, maxZ: 16 },
  elevation: -3,
};
```

Without `enabled: true`, the layer allocates no geometry or materials and has no animation timer. Public compilation emits settings with both toggles off, bounds for all floors, and the lowest floor elevation relative to the current floor. This keeps the same landscape on the ground when switching upstairs. `window.floorplan.surroundings` and `window.planner.getPreviewMetadata().surroundings` expose diagnostic counts, paused/running status, and the traffic seed and current pass settings. A seed supplied to the layer, or through `settings.seed` in the compiled viewer, produces repeatable traffic. Palette or bounds rebuilds restart that sequence; pausing motion preserves its current position and arrival gaps.

The layer uses fourteen shared `InstancedMesh` batches and nine physical material
families. Trees have attached leaves and branches, cars have a continuous painted
shell and distinct glazing, rubber tyres and metal hubs, and rabbits use the
catalog's authored anatomy. The standard scene has 65,292 placed triangles.
Materials receive the host's existing lights and optional shared physical detail
through `decorateMaterial(material, family)`. Geometry casts and receives shadows
when the host render profile enables them. The layer creates no lights, shadow
maps, reflection probes or texture loaders of its own.

All five actors are allocated once on first enable. Palette changes replace and
dispose that resource set; animation reuses their instance transforms and color
buffers. Cars briefly hide between passes instead of creating more actors. Each
tick requests a motion frame through the existing renderer, preserving adaptive
gesture throttling. The enclosing scene still incurs its normal rendering cost
while motion is enabled, so static is the default.

## Verification

The **Validate complete package** workflow runs the environment tests once in
its package job, after the existing browser-tool installation. The surrounding
platform matrix continues to cover general rendering and navigation without
repeating this dedicated Chromium scenario in every lane.

- `node scripts/test-environment.mjs`: no allocation while off, bounded shared draw batches, full scenery envelopes outside both site edges, repeatable traffic across four seeds and repeated 30-minute simulations, varied speeds/gaps/rendered colors, unchanged actor and GPU buffer counts, preserved road side through settings and bounds rebuilds, visibility/reduced-motion/lifecycle pause, palette replacement and disposal.
- `node scripts/test-environment-browser.cjs`: real garden placement, indoor/outdoor catalog items, unchanged camera fit, static idle rendering, reduced-motion pause, compiler metadata and Home controls. Set `ENVIRONMENT_SCREENSHOT_DIR` to save fictional-example screenshots.
- `node scripts/test-environment-surfaces.mjs`: material families, draw/triangle bounds, metre UV scales, exact decoded rabbit GPU bytes and material disposal.
- `python3 scripts/author-environment-animal.py --check`: reproducible catalog-to-scenery geometry; rerun without `--check` after changing the authored rabbit.
- Existing furniture JS/Python, planner rendering budget and viewer lifecycle checks cover compatibility with catalog generation and on-demand rendering.
