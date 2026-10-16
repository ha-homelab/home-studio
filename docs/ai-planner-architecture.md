# AI-assisted planner architecture proposal

Status: design only. No AI endpoint, photo upload, provider connection, or automatic
room generation is implemented by this document. See the [overview](ai-planning.md),
[provider setup](ai-provider-setup.md), and [local models](ai-local-models.md).

The intended result is an ordinary editable Home Studio project: room polygons,
walls, openings, and catalog items that the user can move and resize. A generated
render or mesh alone does not meet that requirement. Photos can suggest visible
objects and relationships; they do not establish accurate room dimensions or reveal
hidden walls. Ask for measured dimensions and identify assumptions before applying
geometry.

## Existing integration points

- [`planner/model.js`](../planner/model.js) defines schema version 1 and
  `validateProject()`. Rooms contain metric `[x, z]` polygons. Walls are independent
  segments; openings reference wall IDs. Items reference rooms and use
  `position_m`, `dimensions_m`, and Y-axis `rotation_deg`. Item Y is its bottom
  elevation relative to the floor, not its center.
- [`planner/editor.js`](../planner/editor.js) owns selection, the active floor,
  rendering, and the `home-studio.project.v1` browser draft. `transact()` clones the
  project, validates and checks serialized size, then adds one undo snapshot and
  saves. History retains up to 60 snapshots. JSON import uses `replaceProject()`
  and replaces the entire project; it is not a room-merge API.
- [`planner/catalog.json`](../planner/catalog.json) is the canonical catalog;
  generated `catalog.js` and [`furniture.js`](../planner/furniture.js) supply browser
  models and appearance validation. Existing IDs, dimensions, palettes, and
  supported patterns provide the vocabulary for AI suggestions. Do not generate
  executable recipes or download model-specified assets.
- [`planner/project.py`](../planner/project.py) independently validates projects
  before compilation. [`scripts/build-planner-project.py`](../scripts/build-planner-project.py)
  produces viewers, model exports, and optionally an HA package, retaining the
  editable `project.json` snapshot. The Python loader also rejects duplicate JSON
  properties; browser `JSON.parse()` alone does not.
- [`planner/index.html`](../planner/index.html) currently has `connect-src 'none'`.
  Ordinary drawing works without AI or network access. The installed HA viewer and
  authenticated host are separate systems, not AI connection points.

## Proposed execution boundary

Prefer an optional local companion that serves an AI-enabled editor and its API
from one loopback origin. Keep the existing static editor and its restrictive CSP.
The companion entry point can use `connect-src 'self'`; its server makes the
selected cloud or local inference request. A hosted HTTPS editor should not depend
on a cross-origin request to a loopback service working in every browser.

The user selects a provider, model, and connection profile before requesting a
draft. The companion maps that profile to a configured adapter. Credentials stay
in session memory and are separate from prompts, projects, exports, and logs.
Local inference uses the same draft contract. Direct browser-to-provider access
is an advanced alternative requiring provider CORS support, a deliberately scoped
CSP, a dedicated trusted origin, and acceptance that page JavaScript can access
the key. Repository paths on a shared GitHub Pages origin are not isolated from
each other. Detailed setup and
session security belong in the linked guides.

Neither the model nor a returned draft may choose a URL, model, adapter, tool,
filesystem path, shell command, or HA service. The companion is not a general HTTP
proxy. It must enforce loopback binding, Host/Origin validation, a session-bound
request check, and fixed connection-profile destinations. No HA token or entity
state is needed for photo planning.

Bind the credential session to the adapter, normalized scheme/host/port, and
allowed paths. A destination change requires a new credential session. Bypass
inherited proxies in local mode and check connection-time addresses on every
request/retry. Use only numeric loopback in the first local profile; LAN profiles
require separate explicit policy. Disallow redirects, framing, and unsafe opener
relationships; serve only reviewed assets from the companion origin.

## User flow and scope

1. Select an existing room, or explicitly start a new room draft. Collect the
   user's objective, measured dimensions, and a small set of room photos. Show
   which photos and room data will leave the device before the request.
2. Establish coordinates: floor X/Z, floor-relative Y, a user-chosen reference
   wall, and photo direction where known. Preserve measured geometry as a hard
   constraint. Missing measurements remain questions or labelled estimates;
   model confidence is not measurement accuracy.
3. Generate a detached draft. Display proposed additions over the current plan,
   list assumptions and measurements still needed, and allow normal numeric edits
   and removal of individual suggestions before acceptance.
4. Apply the reviewed selection in one transaction. Cancel discards the draft;
   Undo restores the previous project. Export remains the existing editable JSON
   workflow, followed by the existing compiler and installation process.

The first increment only adds furniture to a selected room whose geometry already
exists. It cannot resize walls, delete items, change another room, or assign entity
bindings. Existing furniture is context for avoiding collisions, not permission to
replace it. A later increment creates a measured room in a new project, including
walls and openings. Changing architecture inside an existing multiroom floor comes
later: walls have no room-owner field and may be shared, so such edits require an
explicit dependency-aware review of every affected room and opening.

## Draft contract

Add a versioned schema at a proposed `planner/ai/draft.schema.json`, independent
of project schema version 1. Reject unknown fields at every object level. Keep a
trusted request envelope in application memory with `request_id`, monotonically
increasing `base_revision`, target floor/room, permitted mode, measured constraints,
catalog version/hash, and the allowed candidate vocabulary. A model response never
grants itself scope by repeating or changing these values.

For the first increment, require exactly this response shape:

```json
{
  "draft_version": 1,
  "request_id": "request_17",
  "kind": "furnish_room",
  "items": [
    {
      "candidate_key": "candidate_1",
      "name": "Sofa",
      "model_id": "sofa_3",
      "style_id": "contemporary",
      "position_m": { "x": 1.5, "y": 0, "z": 2.2 },
      "dimensions_m": { "width": 2.35, "depth": 0.9, "height": 0.86 },
      "rotation_deg": 90,
      "evidence": "Visible sofa; dimensions use catalog defaults."
    }
  ],
  "assumptions": [],
  "needs_measurements": []
}
```

All fields shown are required; an empty item list is valid. Candidate keys must be
unique safe identifiers. Limit names to 100 characters, evidence to 300, and each
of the two final arrays to 16 strings of at most 300 characters. The trusted adapter
derives `type` from the catalog, assigns project IDs with `nextId()`, assigns the
selected room, and sets new `entity_id` and `notes` to empty strings. It does not
spread arbitrary model properties into a project object. Evidence and assumptions
remain in draft state, outside the saved project schema.

A subsequent `new_room` variant can add one room polygon/material, thickness per
polygon edge, and openings expressed as edge index plus metric offset, width,
sill, and head. The adapter creates wall IDs, resolves opening references, and
builds a complete candidate project. Its origin and orientation come from the
user-approved coordinate frame. Require explicit dimension review before applying
estimated geometry; initial delivery should require measured dimensions. Do not
silently present catalog sizes or perspective estimates as surveyed measurements.

Use provider structured-output facilities where available, then validate locally
regardless. Parse one complete JSON value with duplicate-property rejection; reject
truncated output, prose wrappers, and unsupported schema versions. Provider output
is data, never code or markup. Rendering explanations must use text nodes.

## Validation and bounded work

The existing project limits remain authoritative: 2,000,000 serialized UTF-8 bytes;
8 floors; per floor 64 rooms, 256 walls, 256 openings, and 256 items; 64 vertices
per room; 2,048 vertices per floor; and 2,048 total entries across collections.
X/Z coordinates and floor elevations range from −100 to 100 metres. Ceiling height
is 0.5–20 metres; item dimensions are 0.001–100 metres and their tops cannot exceed
the ceiling. Room polygons cannot self-intersect or overlap interiors. Wall and
opening geometry has additional length, intersection, and overlap checks.

Proposed AI-specific limits are deliberately smaller: six input images, 10 MiB
compressed and 24 megapixels decoded per image, 30 MiB compressed total, 64 item
candidates, and 256 KiB response JSON. Apply the lowest provider-specific limit as
well. Check decoded dimensions before allocating a full image; orient, resize,
and re-encode accepted images to remove metadata. Bound concurrent requests to one,
use cancellation and a finite timeout, and require an explicit retry after errors.
Perform decoding in a separate worker/process with bounded memory/time, no
provider credentials or inherited secrets, and denied network access. Do not
decode untrusted photos in the credential-holding process.

Existing validation does **not** establish that an item's footprint lies within
its assigned room or that furniture is collision-free. Add AI draft checks for
full rotated-footprint containment, including concave polygon edge crossings;
ceiling clearance; and door/window obstruction. Report furniture overlap for review
because legitimate arrangements include rugs under tables and lamps on desks.
Normalize proposed rotations and show any adjustment; reject invalid geometry
instead of silently clipping it. Run `validateProject()` and the byte check on the
complete merged project before enabling Apply, and again inside `transact()`.

## Isolation, revisions, and implementation sequence

Treat photo text, filenames, labels, existing notes, user descriptions, and model
output as untrusted content. Send only the selected room's required geometry and
sanitized item descriptors; omit entity IDs, unrelated floors, credentials, and
private notes. Separate fixed instructions from supplied content. A photograph
saying “ignore instructions” must have no authority: disabled tools, fixed
destinations, strict schemas, and local validation enforce this boundary even if
the model follows the photograph's text.

Store pending drafts outside `project`. Increment the editor revision for edits,
imports, Undo, and Redo. A late response cannot apply after a revision, target, or
connection change; discard it or regenerate against current state. Applying a
reviewed draft must also check that revision. No partial streaming response may
mutate the project or autosave. Keep photos out of browser project storage and
exports; release image buffers and object URLs when the draft closes.

Implement in reviewable increments:

1. **Contract and fixtures:** proposed `planner/ai/draft.js` parses, validates, and
   maps fake responses without network access. Add rejection fixtures for unknown
   models, duplicate keys, nonfinite numbers, bounds, foreign scope, and hostile
   text. Valid mapped projects must pass JavaScript and Python validators.
2. **Review UI:** proposed `planner/ai/review.js` integrates overlays and an explicit
   Apply button into the editor's transaction path. Browser tests prove Cancel is
   inert, other rooms and entity bindings are unchanged, Apply adds one undo step,
   stale responses fail, and export/import preserves accepted editable items.
3. **Optional transport:** proposed `scripts/serve-ai-planner.py` and provider
   adapters add the companion. Mocked tests cover destination restrictions,
   session isolation, cancellation, timeouts, malformed replies, and redacted errors.
   Ordinary planner tests must retain the offline CSP and zero AI requests.
4. **Measured room creation:** add the second draft variant and dimension review.
   Compile accepted fixtures with `build-planner-project.py`; inspect resulting
   openings, 2D/3D geometry, and reopened project JSON. Test hidden/ambiguous features
   as unresolved questions, not invented architectural facts.

Provider image support, structured-output compatibility, local model quality,
latency, and browser connectivity need separate opt-in evaluation. None has been
verified by a live inference request for this proposal.
