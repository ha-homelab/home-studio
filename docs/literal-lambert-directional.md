# Experimental scalar directional Lambert body

The `literalLambertDirectional` option replaces only directional direct-light
calls in the packed Home Lambert shader. Home opts in on this experimental
branch. The default option, editor, literal room shader and PBR material paths
retain their existing shader source.

The hypothesis is that removing directional `IncidentLight` argument copies
and the direct Lambert `inout` call can reduce first-use lowering or interpreter
cost on legacy Apple software OpenGL. The directional light executes even when
all point lights are off. This is not a measured improvement or release claim.

The replacement copies color, then direction, then sets visibility to true. It
retains the original directional shadow expression, including multiplication by
one when shadow reception is disabled. It always evaluates the original dot,
saturation, irradiance, BRDF and addition in their original order. Zero color
adds no new early-out. Direction is not renormalized. Each unrolled light has a
separate local scope. Point, spot, indirect, daylight, material and vertex code
are unchanged; indirect Lambert structs still exist.

Exact pinned Three r169 helper, macro and directional-block guards fall back to
the original shader when their source differs. Selection adds one stable cache
key suffix and no uniforms, textures or GPU resources. On/off light state does
not change selection. Home/editor reattachment and context restoration use the
existing material and resource lifecycle.

`node scripts/test-literal-lambert-directional.cjs` checks real pinned program
expansion, whole-shader inverse equality outside the directional block, changed
source fallbacks and binary32 operation traces including zero, negative and
nonfinite inputs. It is also included in package checks and extracted-source
replay. These CPU checks do not establish real-driver floating-point pixel
parity or performance; original browser acceptance limits remain unchanged.
