# Scoped scalar Lambert lighting

The packed Home renderer can express selected Three r169 lighting operations
with local vectors and scalars instead of passing aggregate light/material
structures through helper calls. This changes the shader representation, not
the lighting model. The compiler may already perform the same lowering, so the
implementation makes no general startup, interaction or Intel speed claim.

## Selection and preserved operations

`literalLambertPointBody` replaces the unshadowed point-information and direct
Lambert bodies only when the existing point-texture proof is active. It reads
the same two RGBA records in the same order and retains normalization, length,
attenuation, both visibility checks, room transmission, dot product, saturation,
BRDF and accumulation order. The original run scheduler is unchanged.

`literalLambertShadowPoint` uses the same eligible transport and keeps the
literal point-shadow prefix. Each light retains its scoped cached transmission,
admission and visibility checks, sampler index and shadow expression. The
point-information and direct Lambert calculations use local values in that
existing scope. There is no extra shadow pass or new early-out.

`literalLambertDirectional` applies independently to packed Lambert. It copies
color and direction, sets visibility to true, and evaluates the original shadow
expression, including multiplication by one when reception is disabled. It
retains the dot product, saturation, BRDF and addition order. Direction is not
renormalized, and a zero color does not introduce a shortcut.

`literalLambertIndirect` requires eligible point-texture transport. After the
unchanged ambient, hemisphere and daylight accumulation, it substitutes the
pinned helper's single `indirectDiffuse` multiplication/addition at the original
call site. It does not remove the surrounding material or reflected-light
structures, rewrite indirect specular, or move any irradiance calculation.

All four options default off in `createRoomLighting`; Home opts in for its
existing packed profile. Each rewrite checks its pinned helper, macro and
complete replacement span and has an independent cache suffix. Unsupported
source retains that rewrite's prior path. Texture-bound rewrites follow the
existing finite-input, capacity, camera and material proof; directional
selection remains independent. PBR, literal room-shader and editor variants
retain their prior paths. The independent dynamic/constant-two point attenuation
selection is described in [the attenuation notes](point-decay-two.md).

## Callback and cache contract

`createRoomLighting.attach` owns `onBeforeCompile` and `customProgramCacheKey`
on the attached materials; it is not an arbitrary callback-composition API.
The texture and decay selectors retain the final installed callback identities.
Their existing update checks reject unsupported external callbacks or material
changes, and a change of active selection sets `needsUpdate` before drawing.
The same state predicates select emitted code and cache suffixes. Scene state
updates alone do not create a new program when eligibility is unchanged.

Callers supply the complete registered point collection and current camera to
`update` before drawing. Home does this on full and signal-only draws. External
changes between that update and rendering, or mutation of the pinned shader
chunks after controller creation, are outside the owned viewer contract.
Uniform bindings still precede the editor early return, so cached program reuse
uses the existing latest uniform map. These rewrites add no uniforms, textures,
getters, callbacks, render requests or disposal paths. Existing loss/rebuild
handling remains responsible for the three data textures.

## Validation scope

The point, directional, shadow-point and indirect CPU tests independently
reverse their full emitted fragments and compare pinned operation traces.
They cover zero, signed zero and nonfinite arithmetic, source mutations,
independent selection, editor/fallback transitions and cache identity. The
proofs run unconditionally in package checks and extracted-source replay.
They do not execute an actual shader compiler. Rendered pixel comparisons and
the unchanged full browser qualification matrix are separate requirements;
no CPU proof, local result or partial hosted result substitutes for them.
