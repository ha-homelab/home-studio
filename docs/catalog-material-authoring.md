# Stock catalog geometry and physical surfaces

The offline catalog contains 206 orbitable models composed of 2,252 named parts.
These are authored approximations of furniture, appliances, plants, vehicles and
decorative objects. They are not scans or photographs of a particular product.
They remain ordinary meshes: no camera-facing photographic billboards are used.

## Authoring contract

`planner/catalog.json` is canonical. `scripts/author-furniture-profiles.py` assigns
explicit per-part `geometry_profile` and `surface_finish` from reviewed category
and part semantics. Run that script after changing its rules, then run
`scripts/generate-furniture-catalog.py` to update the browser copy. Both the
browser and Python compiler implement the same profile geometry.

Profiles add hard-surface bevels, upholstered cushion domes with closed piping,
continuous rug surfaces, smooth rotational rims, volumetric leaf crowns and
vehicle bodywork. Small rods retain twelve sides, intermediate rims sixteen,
and prominent tabletops and mirror frames thirty-two. Organic animal profiles
use closed, ascending cross-sections with shared authored normals for continuous
body and bent limb skins. Sharp anatomical folds have explicit 60-degree
smoothing boundaries computed after fitting, avoiding inward shading normals
on narrow ankle and sole transitions. `planner/anatomy.json` stores the eight reviewed animal
part definitions and is applied after the general category rules.

The unprofiled primitive path remains available for legacy input and fixtures.
Individual profile transformations preserve their specified rotated envelope.
The authoring pass intentionally revises some part layouts: connected plant
branches, grass flower stems, shallow rug inlays, a sofa foot placement and
animal anatomy. Model IDs, item types, dimensions, placement anchors, elevation,
entity bindings and curtain panel identities remain stable.

Authored positions and normals use 12 decimal places in normalized coordinates.
Exact position/normal/UV tuples are then indexed; different UV or normal seams
are never merged. The cross-language tests compare ordered triangle corner
attributes, allowing only the declared authoring precision (scaled to metres
for UVs). Topology tests independently check closed, oriented edges and positive
volume. The legacy primitive tests retain their original exact index contract.

## Surface semantics and colour

Explicitly selected styles and custom body colours remain the source of pigment.
New unstyled objects use model-appropriate defaults: neutral upholstery, natural
wood, green foliage or earth-toned soil. Mirror surfaces use a neutral reflective
base; their frames still follow the selected style and custom body colour.

A part's `surface_finish` selects scalar physical response and its matching
`material_family` selects shared neutral colour, normal and roughness detail.
Generic colour detail modulates the chosen pigment rather than substituting a
new object palette. Explicit physical texture channels remain authoritative;
see [material textures](material-textures.md). This avoids one raster variant
per object or style.

Glass, metal, paper, ceramic, solar cells, wood, upholstery and foliage are
classified separately, including mixed-material objects. Real mammals use the
`fur` response and birds use `feather`; plush toys retain fabric. Fur and feather
maps represent small surface relief, not strands, barbs or a scanned silhouette.

Each mesh contains explicit face-chart UVs in metres. For wood, U follows the
longest physical axis available in each face chart: along table tops and
vertically on legs. This is geometric authoring, never a guess from RGB. Resizing an item rebuilds
its appearance with the new dimensions, so the same material scale is retained.
Patterned furniture still replaces only its inset central surface, with no
coplanar duplicate face and no missing bevel area.

## Public scenery

The environment keeps its existing seeded layout, actor identities and fourteen instanced
batches. Trees, roads, paint, tyres, metal wheel hubs, glass, vehicle paint and decorative animals
receive distinct physical families through the optional
`decorateMaterial(material, family)` callback. Geometry has UV charts and each
instance has a `materialUVScale` attribute. Ground top-face scale is metric;
non-uniformly scaled curved/three-dimensional scenery uses an approximate chart
scale. This approximation must not be described as a measured material unwrap.

Trees have attached branches and individual closed leaves. Cars have a painted
cabin shell, inset glazing, wheel arches, door details and separate rubber/metal
wheel surfaces. Rabbits share the catalog's authored anatomy instead of separate
floating spheres. Their 1,632 triangles retain exact Float32 attributes through
lossless LZSS transport; `author-environment-animal.py` regenerates the embedded
data from the catalog. The rabbit chart already uses metres, and its paws reach
the ground at rest. The whole layer uses 65,292 placed triangles for the standard
scene. These are compact procedural models, not photogrammetric scans of a
particular vehicle, plant or animal.

## Checks

Run these from the repository root:

```sh
python3 scripts/generate-furniture-catalog.py --check
python3 scripts/author-environment-animal.py --check
python3 scripts/test-furniture-profiles.py
python3 scripts/test-furniture.py
python3 scripts/test-furniture-patterns.py
node scripts/test-furniture-patterns.mjs
node scripts/test-environment.mjs
node scripts/test-environment-surfaces.mjs
```

Closed-profile tests cover bounds, winding, positive volume, metric UV scaling,
custom colour preservation, anatomy section validation and browser/compiler
parity. Per-part complexity is bounded, with a larger explicit allowance for
closed leaf crowns; whole-scene installation limits remain the final gate.

The furniture integration suite compiles and installs the complete mixed catalog
and a dense 256-plant scene using the existing 32 MiB member, 96 MiB summed-file and 128 MiB
expanded-tar limits. Keep those limits and geometry/export checks when extending the
catalog. Native visual review should compare the same camera, scale, style and
hardware rendering path, then inspect representative materials close up; a
screenshot alone is not proof of geometry, texture scale or export preservation.
