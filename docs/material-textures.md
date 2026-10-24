# Optional reviewed material textures

Generated models may carry reviewed PBR channels and generic physical surface
detail on existing metric meshes; these never replace furniture with images.
The source project, saved placements and entity bindings remain authoritative.
No image generation service or network fetch is used at runtime. Generic microdetail is
generated deterministically from bounded physical heightfields. The `fur`
family uses fine directional coat detail, `feather` uses directional barb
detail, and plush objects continue to use fabric.

## Producer schema

The optional model field `material_textures` maps an identifier matching
`[A-Za-z][A-Za-z0-9_-]{0,63}` to exactly these four properties:

```json
{"mime_type":"image/png","width":256,"height":256,"data_uri":"data:image/png;base64,..."}
```

Each selected `object_assets[item_id].meshes` entry may include:

```json
{"albedo_texture":"fabric","uv":[[0,0],[4,0],[0,4]],"uv_dimensions":["width","depth"]}
```

There must be one explicit UV pair per vertex. With `uv_dimensions`, multiply
each component by that current inventory dimension before use. For example,
a 0.25 m repeat over normalized local X/Z uses `(x-minX)/0.25` and
`(maxZ-z)/0.25`; multiplying by width/depth preserves physical repeat after an
editor resize. The two optional axis names must be distinct and chosen from
`width`, `height`, `depth`. Without them, UVs are fixed. Final UV coordinates
must be finite and within ±4096. Native UVs use the bottom-left image origin.

Scope is the mesh entry, not every material with the same name. A producer
wanting only a tabletop textured must split its original top triangles into a
separate entry and leave other triangles unchanged. The viewer does not infer
surfaces or author UVs. Normalized geometry, indices and normals are preserved.
Albedo applies to source-opaque inventory and static materials. Static
`model.meshes` entries use the same fields and explicit world-space UVs, without
`uv_dimensions` (or unit scale). The viewer preserves UVs when rounded/cutaway
walls add display vertices by projecting onto the nearest facing source
triangle. Original wall geometry remains authoritative for shadow passes.
The existing translucent architectural-wall presentation is retained; the
source color/texture must still be opaque. Standard/Lambert materials and the
software unlit wall fallback all retain their own lighting behavior. The mapped
material uses white base color because the image contains the full color;
unmapped surfaces retain their original palette.

## Validation and budgets

The producer prepares and visually reviews tiles offline, including periodic
joins, color space and any changes from source imagery. The compiler validates
at most 128 descriptors, 1 MiB per PNG and 8 MiB unique images combined. Inputs
are square powers of two from 128 to 1024 pixels,
8-bit, noninterlaced, metadata-free opaque RGB or indexed PNGs. Only IHDR,
PLTE, IDAT and IEND chunks are accepted; CRC, decompressed bounds and scanline
filters are checked. Alpha, animation, profiles and external URLs are rejected.
`validate_material_textures(model)` raises before generating a bad viewer.

The viewer repeats bounded descriptor, base64, header, dimension and UV checks,
then relies on its image decoder. It is not an arbitrary image-upload parser;
full PNG validation belongs to the trusted build/export boundary. Invalid
descriptors, failed decodes and missing/invalid UVs render the original colors.
Unready/failed maps do not split material batches. A successful map may add a
draw for a selected surface but never adds a triangle. Identical data URIs
share one decode and one texture per color-space role. A 256² RGBA8 map with
full mip levels needs 349,524 GPU bytes plus roughly 256 KiB of decoded CPU
pixels; driver and browser overhead are additional. The total semantic-role
texel budget is 12,582,912, including generic detail, and the existing 32 MiB
export-file guard remains in force. Displacement maps are not loaded. See the
physical-channel contract below for normal, roughness, metalness and AO maps.

## Rendering and lifecycle

The viewer awaits the bounded local decodes before creating static materials,
so lighting registration sees the final map from the beginning. The inventory
rebuild adds UVs and the map to each newly created material
before existing Home room-lighting registration. There are no material clones
or copied callbacks; the lighting owner's original material identities and
state remain intact. Home/Editor transitions retain their normal registration.
The conservative packed point-light optimization currently falls back for
textured Lambert materials, preserving full lighting and sampler limits. Other
meshes retain their existing optimization.

The owner keeps bounded CPU images across inventory rebuilds and context loss,
marks textures for upload after GPU release, and disposes owned maps/images on
final page teardown. BFCache suspension keeps the owner alive. The initial
inventory build awaits the bounded local decodes, so completion does not rebuild
active controls a second time. Existing demand-render guards prevent drawing
while suspended. Each unique image has a one-shot five-second decode deadline;
expiry continues startup with the original material batches. Success, failure
and disposal clear the deadline, and late callbacks cannot install a map.
There is no recurring timer, new animation loop or renderer.

## Exports and packaging

The current-drawing `export_floor` / `export_scene` path carries only validated
albedo, PBR channels and scaled UVs alongside existing geometry. GLB embeds PNG buffer views
and TEXCOORD_0, flips V for glTF's image origin, and sets baseColorTexture with
white base color unless albedo tint is explicitly enabled. OBJ ZIP adds explicit `vt` indices, `map_Kd` and bounded PNG
members. Both remain self-contained and export current placements/dimensions.
Historical `export_models` static USD/DAE/OBJ/GLB bundles retain their original
solid-color behavior; rebuild current-drawing exports for textured assets.

`render_viewer` expands `/*__MATERIAL_TEXTURES_JS__*/` from
`material-textures.js`. Independent viewer builders must make the same source
replacement and call the Python validator on trusted model data. The public
runtime package includes `material-textures.js`, `material_textures.py`,
`pbr-materials.js`, `pbr_materials.py`, `pbr-color-data.js`, and `environment-lighting.js`. Independent
builders also expand `/*__PBR_COLOR_DATA_JS__*/`, `/*__PBR_MATERIALS_JS__*/` and
`/*__ENVIRONMENT_LIGHTING_JS__*/` from the matching sources.
No household-specific image, identifier, binding or source path belongs in the
public repository. Optional reference/beauty images are not part of this schema.

## Verification

Run `python3 scripts/test-material-textures.py` for PNG bounds, negative cases,
surface selection, current dimensions, embedded exports and omitted data.
Run `node scripts/test-material-textures.cjs` for pinned Three ownership,
lighting callbacks and the actual compiled viewer. Set
`MATERIAL_TEXTURE_ENGINES=chromium,firefox,webkit` for all three installed engines.
The package workflow runs these alongside existing export/lifecycle tests and
the required platform-acceptance matrix. Local software rendering does not
replace physical Android/Mac or full release-matrix acceptance.

## Material finish response

The hardware Standard-material path selects conservative roughness/metalness
from explicit finish names: textiles and rubber are rough dielectrics, wood
is moderately rough, ceramics/glass are smoother, and named bare metals are
metallic. Paint/plastic take precedence over a metal word. Colors or the
presence of a texture do not imply fabric. Unknown finishes retain a neutral
rough dielectric response. Alpha, emissive values, shadow ownership and
Lambert/Basic fallbacks are unchanged. This improves material response without
claiming geometric photorealism. Albedo is not reused as a bump/normal map.

Run `node scripts/test-material-profiles.cjs` for finish selection and fallback
contracts, and `node scripts/test-static-material-textures.cjs` for actual
Standard/Lambert/Basic static maps, cutaway UVs and shadows in Chromium.


### Explicit part finishes

Palette IDs can be reused for unrelated surfaces. A static mesh or an
`object_assets` mesh may therefore include `surface_finish` independently of an
albedo map. This does not change its palette color, transparency, emissive state,
geometry, or controls. It overrides palette-name finish inference and prevents
inventory batching from merging different finishes. GLB uses the same response.

Allowed values are `fabric`, `leather`, `plastic`, `painted`, `wood`, `ceramic`,
`glass`, `rubber`, `stone`, `metal`, `brushed_metal`, `matte_metal`,
`polished_metal`, `mirror`, `matte_paint`, `rough_wood`, `polished_stone`, `paper`,
`foliage`, `soil`, `car_paint`, `solar_cell`, `light_diffuser`, `fur`, and `feather`. Omit the field
when the surface is unknown; null and unrecognized values are rejected. These
are conservative artistic starting values, not measured physical properties.
The complete explicit response table and legacy inference table are compared
between Python/GLB and JavaScript/HA by `scripts/test-material-profiles.cjs`.

## Physical surface channels and generic detail

The portable model also accepts `normal_texture`, `roughness_texture`,
`metalness_texture`, and `ao_texture` on an individual mesh. They reference the
same `material_textures` dictionary as `albedo_texture` and share its explicit
per-vertex UVs. Normal maps use tangent-space RGB (positive green in the native
UV direction). Roughness reads **green**, metalness **blue**, and occlusion
**red**, so one packed ORM image may serve all three. Albedo uses sRGB; all data
channels use linear values. The same image used in both roles gets independent
color-space texture views. `normal_scale` is 0–2, `ao_strength` is 0–1, and
`albedo_tint: true` multiplies the existing palette color by albedo. The default
is the previous white albedo multiplier. Plain or transparent surfaces do not
need a color image to receive normal or roughness detail.

Descriptors still contain exactly `mime_type`, `width`, `height`, and
`data_uri`. The accepted metadata-free opaque PNG sizes are now 128, 256, 512,
and 1024 square. Limits are **128 descriptors**, **1 MiB per image**, **8 MiB
unique encoded images**, and **12,582,912 decoded texels**, counting sRGB and
linear usage separately. Aliases do not multiply image memory. Generic detail
counts against these budgets as well. On the reduced renderer, decoded images
are uploaded at at most 256 square; normal hardware permits 1024. Anisotropy is
bounded by both hardware support and the selected quality tier (2 or 4).

`material_family` selects reviewed generic microdetail for the same family
names as `surface_finish`. These are small deterministic periodic heightfields,
not normal maps guessed from color photographs. They preserve palette colors
and do not change silhouettes. Smooth glass, mirrors and light diffusers have
no invented grain. Family maps use **metres**: `material_uv_scale` converts the
shared authored UVs to metres (default 1). For example, if legacy UVs repeat a
0.25 m tile, set `material_uv_scale: 0.25`. This factor affects generic detail
only; explicit texture references always retain their authored mapping and
override the corresponding generic channel. `uv_dimensions` continues to
convert normalized geometry into physical coordinates when it is present.

Fabric and wood also receive bounded tintable color variation. The two shared
128² luminance carriers in `pbr-color-data.js` come from generic text-only material
images, with no household reference image or private metadata. The source
hashes, prompts and routine downsampling are recorded in
`material-color-provenance.json`. Runtime and Python code derive the same
restrained grayscale variation and multiply the selected material color;
normals and roughness still come independently from the authored heightfields.
Wood and rough wood share one color image. A family requires at most three
128² images, and explicit albedo always takes precedence, retaining the prior
white multiplier unless its producer explicitly requests `albedo_tint`.

The browser and Python exporter generate identical family pixels. GLB includes
normal, metallic/roughness, and occlusion maps, including physical repeat via
`KHR_texture_transform`; the normal green channel and V-transform are adjusted
together for glTF's image convention. OBJ packages include `norm`, `map_Pr`,
`map_Pm`, and `map_Ka` plus explicit channel selectors. Those MTL extensions are
reader-dependent; GLB is the preferred complete material interchange format.
Existing 32 MiB export and 500,000 triangle limits remain in force.

PBR-capable catalog builds and explicitly selected private schema3 builds also
use this material path for their on-disk GLB/OBJ downloads. Historical builds
retain their prior exports. Their USDA includes `UsdPreviewSurface`, shared PNG
readers, per-channel physical UV transforms, linear scalar maps and correctly
scaled tangent normals. USD coordinates retain the native bottom-left image
origin. The optional Apple packaging step stores the binary layer and all
hash-verified PNG dependencies with 64-byte ZIP alignment.

COLLADA preserves vertex normals, UVs and mapped albedo; selected color tint is
baked in linear space into its diffuse image. Tangent normal maps use the
FCOLLADA extension. Roughness/metalness and other PBR references are retained in
`HOME_STUDIO_PBR` metadata because COLLADA 1.4.1 has no portable PBR shader.
Use GLB or USD when full material interchange is required. Float attributes in
these exports retain their exact float32 values; source model data is unchanged.
COLLADA may use independent per-semantic index pools and document-wide shared
float arrays; both are standard accessor features and retain every corner.

Saved-scene migration can call `export_physical_scene(floors, root, stem)` with
the grouped result of `export_floor`. Only supplied groups are emitted. GLB
keeps group pivots; USD and COLLADA bake scale, rotation, translation and floor
elevation, including inverse-transpose normal correction. The optional
`package_physical_usd(root, stem, usdcat=absolute_path)` explicitly invokes a
caller-supplied OpenUSD converter and creates aligned USDZ. Neither function
discovers or installs external tools. Both return generated paths and the
hash-bound texture manifest for the caller's receipt.

All authoring files remain in the local compiler output. The HA package carries
the runtime, linked model downloads and their complete texture dependencies;
it omits duplicate authoring USDA, SVG and seed-inventory files already embedded
in the runtime data. Installer size limits are unchanged.

Current-drawing OBJ writes positions and UVs to five decimal places (at most
5 micrometres of error per position component, and 0.000005 per UV component).
Normals use four decimal places, bounding angular error below 0.005 degrees.
These are export-only encodings: saved model data and GLB float32 values are
unchanged. Separate position, UV and normal index pools preserve seams, triangle
order, groups and material assignments; short relative indices and occasional
identical local attribute rows reduce file size. Repeated material-state
commands are omitted. GLB reuses identical encoded attribute streams across
primitives while retaining their separate nodes and material assignments.

Normal hardware also receives a shared 128-face prefiltered analytic HDR
reflection environment and contact shading from actual scene depth. The
reflection environment is generic studio illumination, not a captured room or
live reflection probe. Contact shading uses at most 250,000 depth/AO pixels,
a 0.2 m neighborhood, and at most 18% darkening. A depth-aware filter limits
halos; transparent surfaces and emissive displays are excluded as receivers.
These are demand-rendered passes, with no separate animation loop. Reduced
renderers retain ordinary lighting and shadow maps without these two effects.
GPU resources are released/rebuilt on context loss and disposed on page exit.
