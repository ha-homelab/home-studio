# Rounded wall rendering and acceptance

The viewer gives rectangular wall spans a soft, inflated cross-section. This is
a display treatment: project dimensions, exported meshes, floor geometry, door
and window openings, and full-height shadow blockers keep their original data.
The blue base and cyan top contours remain on the original footprint. Home uses
a 2.1 m cutaway; the editor retains its 1.15 m cutaway and full-height view.

Each supported span draws 64 visible triangles instead of 12. The profile swells
across wall thickness by at most 75 mm per side, also limited to 32% of the
original thickness. Rounded shoulders occupy up to 40% of visible height at each
end, capped at 0.9 m. Longitudinal ends and top/bottom elevations remain exact.
Wall centerlines use opening endpoints when available, including narrow piers
beside a full-height passage. Nonrectangular or ambiguous legacy blocks retain
their original geometry.

The original 12-triangle box and rounded surface share one geometry buffer.
`onBeforeShadow` selects the original index range; `onAfterShadow` restores the
visible range. This retains exact shadow blockers without adding meshes or draw
calls. Verify these callbacks again when updating the vendored Three.js version.
At most three geometry variants are cached per wall for clipping-height changes;
eviction disposes the replaced buffer. The four batched contour objects remain.

For lit wall materials, optional iridescent drift updates one shared uniform
only during already requested frames. It schedules no frames or timers. Reduced
motion, mobile or coarse-pointer devices, hidden pages, data saving, limited
reported hardware, and repeated slow CPU render submissions keep the drift
stationary while retaining the view-dependent tint.

The [Apple software diffuse fallback](platform-acceptance.md) instead uses
constant-tint Basic wall fill in both Home and Editor. It has no received
lighting, daylight, shadows or view-dependent/animated sheen. Rounded geometry,
opacity, cutaway clipping, outlines and full-height shadow casting remain the
same; floors, furniture and scene lights retain their existing behavior.

## Automated checks

Run these checks from the repository root:

```sh
node scripts/test-rounded-walls.cjs
node scripts/test-wall-tops.cjs
node scripts/test-wall-sheen.cjs
node scripts/test-wall-motion.cjs
node scripts/test-unlit-architectural-walls.cjs
node scripts/test-viewer-startup.cjs
```

They cover closed profiles, rotations, exact cap boundaries, low walls, invalid
shape fallback, rays through real compiled openings, narrow passage piers,
unchanged shadow ranges, bounded caches, shader composition, motion guards,
scoped unlit wall material selection and startup behavior. Retain the source
model before rendering and compare afterward when extending geometry tests;
a display update must not mutate export data.

## Browser acceptance

Generate the same fictional model with the baseline and candidate viewer code.
Use a fixed viewport, device scale, camera, clipping height, and reduced-motion
setting. Compare the complete Home plan and a close view of a window and doorway.
Check full height, both cutaway heights, low walls, joins, and upper-floor context.
Contours must touch their caps; openings and structural frames must remain clear.
Check the normal motion policy separately so time changes do not affect screenshots.

Read `renderer.info.render` after a warmed render to measure the main pass. It
does not include earlier shadow draws because Three.js resets it after the shadow
pass. For shadow acceptance, instrument WebGL draw calls in a temporary offline
fixture, invalidate shadows, and compare the extra draws. Include a point light
so all cube faces exercise the wall callbacks. Every shadow wall draw must still
use 12 triangles, with no added shadow draw calls.

A 1440 × 1000, device-scale-1 Chromium/SwiftShader check of
`planner/example-home.json` measured 34 main-pass calls in both editor modes and
32 in Home, unchanged from baseline. Main-pass triangles changed from 514 to
1,138 at full height, 542 to 974 at the editor cutaway, and 540 to 972 in Home.
The directional shadow pass stayed at 26 calls and 312 triangles in each mode.
An additional point-light probe observed only 12-triangle wall shadow draws.
Repeated clipping cycles stabilized geometry and texture counts after warmup.
Idle render counts remained unchanged in every measured mode.

These are geometry and scheduling checks, not measured Android or native macOS
GPU frame rates, power use, or thermal behavior. Device emulation also does not
establish hardware performance. For a device performance claim, repeat on the
target browser and device with the same model, capture idle and drag traces, and
report viewport/device scale, hardware, frame times, and test duration. Keep
private model fixtures, captures, and raw measurements outside this public repo.
