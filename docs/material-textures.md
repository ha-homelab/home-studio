# Optional reviewed material textures

Generated models may carry small, reviewed opaque albedo tiles. This adds color
detail to existing metric meshes; it never replaces furniture with images.
The source project, saved placements and entity bindings remain authoritative.
No image generation service, network fetch or runtime image processing is used.

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
Albedo applies only to opaque Standard/Lambert inventory materials. The mapped
material uses white base color because the image contains the full color;
unmapped surfaces retain their original palette.

## Validation and budgets

The producer prepares and visually reviews tiles offline, including periodic
joins, color space and any changes from source imagery. The compiler validates
at most eight images, 96 KiB per PNG and 512 KiB combined. Inputs must be 256²,
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
share one decode and one texture. One 256² RGBA8 map with full mip levels needs
349,524 GPU bytes plus roughly 256 KiB of decoded CPU pixels; driver and browser
overhead are additional. No normal, roughness or displacement maps are loaded.

## Rendering and lifecycle

The inventory rebuild adds UVs and the map to each newly created material
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
while suspended.
There is no new timer, animation loop or renderer.

## Exports and packaging

The current-drawing `export_floor` / `export_scene` path carries only validated
albedo and scaled UVs alongside existing geometry. GLB embeds PNG buffer views
and TEXCOORD_0, flips V for glTF's image origin, and sets baseColorTexture with
white base color. OBJ ZIP adds explicit `vt` indices, `map_Kd` and bounded PNG
members. Both remain self-contained and export current placements/dimensions.
Historical `export_models` static USD/DAE/OBJ/GLB bundles retain their original
solid-color behavior; rebuild current-drawing exports for textured assets.

`render_viewer` expands `/*__MATERIAL_TEXTURES_JS__*/` from
`material-textures.js`. Independent viewer builders must make the same source
replacement and call the Python validator on trusted model data. The public
runtime package includes both `material-textures.js` and `material_textures.py`.
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
