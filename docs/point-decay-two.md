# Point attenuation with a constant decay

This isolated experiment changes only the packed diffuse renderer's point-light
attenuation helper. The viewer creates its PointLights with decay 2. Before a
Home draw, `createRoomLighting.update` checks every visible registered point,
including zero-intensity and shadowed lights. Only an exact own data value of
`decay === 2`, finite representable light fields, and an in-capacity collection
allow the specialized Lambert program. Unknown room membership does not justify
skipping the check. Other decay values, unsupported materials, external render
callbacks, and uninitialized controllers retain the original program.

The helper is copied from pinned Three.js 169, retaining `pow(lightDistance, 2.0)`
and the original clamp, reciprocal, cutoff test and cutoff multiplication order.
It does not replace the power with multiplication. Only `getPointLightInfo`
changes its helper call; the generic attenuation and spot-light helper remain
unchanged. Point ordering, shadow prefix, room transmission, geometry, full
resolution, daylight, sheen and all existing deadlines remain unchanged. The
literal renderer and editor use their existing shaders.

As with the existing room-to-light slot mapping, `update(points)` requires the
complete current point-light collection. The shipped viewer has one PointLight
constructor in `home-view.js`; it stores each constructed light on its point
record when adding it to `overlayGroup`, and removes the previous group on a
rebuild. No other runtime path adds point lights. Arbitrary external additions
to the Three scene are outside this contract: an unlisted light is not detected
by this specialization and callers must include it or leave the option off.
Callback checks cover each attached material and its ancestors; they do not
prove that an unrelated object's callback cannot mutate a shared light between
update and draw. Such cross-object light mutations are also outside the owned
viewer contract.

The proof is refreshed by the existing full and signal-only Home draw paths.
A change in eligibility invalidates the material before rendering. Cached full
and specialized programs share the same existing uniforms; there are no extra
GPU allocations, uploads, timers or render requests. Known viewer-owned wall
sheen and shadow draw-range hooks are allowed by function identity; arbitrary
lookalikes are not. Reattachment starts unproved, and detached materials are
removed from the selection map. Context restoration uses normal Three material
recompilation and the next ordinary Home update.

The hypothesis is that an explicit constant exponent reduces Apple's legacy
CGL lowering work. Captured submitted GLSL contains the generic power, but CPU
sampling does not identify `pow` as the bottleneck and no compiler intermediate
representation has been inspected. This is not a measured improvement. Constant
and dynamic power expressions can be lowered differently and rounded differently
by a GPU driver, even with the same mathematical exponent. CPU tests cannot
establish pixel equivalence; native rendered comparisons and the unchanged
strict acceptance suite are required before adoption.

`node scripts/test-point-decay-two.cjs` checks the copied helper and untouched
spot code, operation traces for 104 scalar cases, rejection and recovery,
initial/editor/literal/PBR paths, known and external callbacks, cached uniform
identity, capacity changes, and 16 expansions through the pinned Three program
builder. The full expanded shaders differ only by the point helper definition
and call. The test is unconditional in the package workflow and is replayed
from the public source ZIP. These are CPU/source checks, not GL compilation or
performance evidence.
