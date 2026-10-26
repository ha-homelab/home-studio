# AI-assisted planner architecture

AI drafting has two transports sharing one panel, draft validator, provider
adapters and bounded inference client. Native Home Assistant uses authenticated,
administrator-only HTTP routes with user-bound in-memory sessions. The optional
standalone companion supplies its own loopback transport. Neither weakens the
hosted editor's `connect-src 'none'` policy or the native iframe's opaque sandbox.
Accepted native proposals go directly to Save draft and Publish to 3D Home.
The companion can export the same project JSON for deliberate import into HA.
Manual drawing and the published viewer do not depend on AI.

## Native request boundary

The native host advertises AI only for active native authoring. `studio.js` owns
the authenticated HA connection and a separate random AI session token. The iframe
receives no HA token or AI session token. A fixed-operation bridge accepts
providers/status/connect/disconnect/cancel/generate, validates source window,
opaque origin, per-editor channel, request IDs and message bounds, and forwards
requests through HA's authenticated HTTP client. Keys entered in the masked AI
form cross only this bridge's connect payload; they never enter a drawing snapshot.

`POST /api/home_floorplan/ai/session` starts a 30-minute session. Further calls use
`X-Home-Studio-Session` and the HA bearer authorization. Every call checks the active
native integration, administrator permission and owning user. The backend imposes
body limits, read deadlines, a global single-inference slot and bounded sessions.
It does not use WebSocket commands for provider credentials. Unload, shutdown,
expiry, disconnect and cancellation invalidate pending results. Provider endpoints
remain fixed; local URLs remain numeric loopback only.

The trusted host also calls `POST /api/home_floorplan/ai/close` when the editor is
disposed. This removes the session token and expiry timer and cancels its work.
Ordinary Disconnect keeps the session available for an explicit reconnect.

The native iframe cannot fetch worker source across its opaque origin. Its photo
preparation uses the same bounded decoder asynchronously; the companion uses that
decoder in a worker. Neither path grants the decoder credentials or network access.

## Modules and ownership

- `scripts/serve-ai-planner.py`: stdlib-only Python 3.10+ launcher.
- `custom_components/home_floorplan/ai.py`: authenticated native session lifecycle
  and AI HTTP routes; no persistent credential store.
- `ai_companion/session.py`: shared session metadata and key cleanup.
- `ai_companion/server.py`: exact loopback Host/Origin checks, per-page sessions,
  bounded HTTP concurrency, static allowlist, authenticated API and cleanup.
- `ai_companion/providers.py`: fixed cloud profiles, local endpoint policy, native
  Responses/Messages/Ollama and compatible Chat Completions serializers/parsers.
- `ai_companion/transport.py`: bounded single HTTP request, verified HTTPS for
  cloud endpoints, explicit DNS/socket handling, cancellation and redacted errors.
- `ai_companion/protocol.py`: bounded JSON, duplicate/nonfinite rejection, sanitized
  context envelope, image byte limits and header inspection without pixel decoding.
- `ai_companion/assets.json`: exact reviewed static files served by the companion.
  Python files, repository metadata, tests, keys and arbitrary paths are not served.
- `ai/bootstrap.js`: companion bootstrap; native bootstrap is gated by the HA capability.
- `ai/panel.js`: provider connection, request/review lifecycle and editor integration.
- `ai/photo-processing.js`: shared bounded image inspection, decode, resize and
  re-encoding; it receives no session credential or provider key.
- `ai/photo-worker.js`: companion worker wrapper, served with `connect-src 'none'`.
- `ai/draft.js` and `ai/json.js`: pure draft/context/schema/geometry validation.
- `planner/editor.js`: a small exported bridge for accepted snapshot, revision,
  selection, detached preview, explicit transactional apply and subscriptions.

The public website publishes the setup guide, not a key-entry form. The source
release includes the companion and its tests. AI modules are outside `planner/`
so the ordinary planner's static no-network check still applies to every editor
module. The ordinary hosted editor never activates the optional AI panel.

## Request and credential lifecycle

Loading `/planner/` from the companion injects a random page-session token and
`/ai/bootstrap.js`. The token is separate from the provider credential. API requests
include `X-Home-Studio-Session`. State-changing requests also require the exact
Origin. Host must match the bound numeric loopback address and port. Cross-site
Fetch Metadata, framing, unreviewed paths and unexpected body encodings are rejected.

`POST /api/ai/connect` validates a fixed provider or numeric loopback endpoint and
keeps its model/key/endpoint together in memory. It makes no inference call. Editing
connection settings invalidates the old connection in the UI. A connect replaces
the previous server connection and invalidates any pending result.

`GET /api/ai/providers` returns safe profile metadata. `GET /api/ai/status` returns
connection metadata and expiry, never the key. `POST /api/ai/generate` accepts:

```json
{
  "request_id": "request_unique",
  "mode": "furnish_room",
  "context": {},
  "instructions": "Keep the doorway clear.",
  "images": [],
  "schema": {"type": "object"}
}
```

The abbreviated context/schema above illustrate the envelope only; use
`createDraftContext` and `draftSchema` to produce the real contract. Room context
excludes project notes, entity bindings, unrelated rooms, source URLs and credentials.
It includes measured room geometry, relevant existing objects, openings and bounded
catalog vocabulary. User instructions and visible text in photos remain untrusted.
For `mode: "site"`, the context instead contains `site`, `site_notes` (explicit
own-home identification, requested surroundings and known dimension/orientation),
and `floor_footprints` (polygons and elevations only). It excludes room names,
furniture, bindings, project notes, georeferencing and the furniture catalog. The
same companion/native protocol and provider adapters handle this scope.

The provider adapter encodes catalog models as named columns and rows in the
outbound prompt. This preserves every model, label, dimension and appearance
capability while removing repeated field names (about 55% fewer catalog bytes,
measured against the earlier 206-model catalog). The browser context and complete
response schema remain unchanged. Tests reconstruct every descriptor to prevent a
lossy optimization.

`POST /api/ai/cancel` aborts pending work and invalidates late results.
`POST /api/ai/disconnect` also clears credentials. Sessions expire after at most
30 minutes; the process periodically cleans abandoned sessions. There are at most
8 page sessions, 12 concurrent HTTP handlers and one inference request. Requests
have a 90-second total deadline. Connection and TLS setup use a short timeout;
response headers and content may use the remaining total budget, allowing a
non-streaming vision model time to generate. DNS resolution is independently bounded and does
not carry keys or images. No retries, redirects or inherited HTTP proxy environment
are used. Only reviewed remote HTTPS endpoints or numeric local HTTP endpoints
are accepted. No arbitrary proxy, tool execution or server-side URL fetch exists.

The server suppresses request logs and raw upstream errors. Browser errors use safe
messages, not reflected provider bodies. Keys remain in memory; Python/JavaScript do
not guarantee physical erasure from RAM, swap or crash dumps. A process-local
attacker or malicious same-origin script is outside the web-origin trust boundary.

## Draft contract and geometry

`createDraftContext(project, options)` captures a frozen sanitized context and binds
it through a private WeakMap to an accepted-project baseline. Passing a forged or
serialized context back into `prepareDraft` is not an authorization shortcut.

`draftSchema(mode)` gives the model a strict object schema. The response includes
`draft_version`, matching `request_id`, `kind`, furniture `items`, `assumptions`, and
`needs_measurements`. New-room responses also include `room_name` and `openings`.
Candidate IDs are unique review keys, not project IDs. The application allocates its
own IDs. Optional appearance values are explicit nullable fields in strict schemas.

Site responses contain `features` instead of room items/openings. Each feature has
`candidate_key`, `name`, `kind`, `polygon`, `height_m`, `color` and `evidence`.
Kinds are `home`, `roof`, `building`, `street` and `landscape`. `prepareDraft`
validates every candidate, including deselected ones, through the shared site
validator and assigns selected features fresh IDs using `nextSiteId`. It appends
only to `project.site.features`, retaining existing ground elevation and features;
all other project content, including interior geometry and bindings, is preserved.
No selected features leaves the original project unchanged, without adding an
empty site. The same frozen-context baseline and final revision checks guard apply.

Site bounds are 64 features, 3–64 vertices per simple polygon, 1024 total vertices,
coordinates within ±1000 m and heights 0–100 m. Merged capacity includes existing
features. Streets and landscape require zero height. Roofs represent a flat
outline at their specified height. Unknown fields, including model-proposed IDs,
ground changes and geographic coordinates, are rejected. The prompt explicitly
requires approximate estimates, ownership clarification and missing measurements;
it cannot turn photos into surveyed geometry or infer exact geocoordinates.
The [site editor guide](site-editor.md) describes manual editing and map alignment.

Each furniture candidate identifies a catalog model/style and supplies metre-based
`position_m`, `dimensions_m`, rotation and evidence. X/Z is the floor plane; Y is
bottom elevation above the floor. New-room dimensions and origin come from the user,
never the model. Openings use an edge index and measured offsets, sill/head and width.

`prepareDraft(project, context, response, options)` validates and builds a clone. It:

1. Rejects unknown fields, duplicate JSON properties, unsafe keys, nonfinite numbers,
   excessive depth/bytes/counts and request/mode mismatches.
2. Resolves known catalog models/styles/patterns and validates appearance.
3. Preserves existing geometry, objects and entity bindings. The model cannot edit
   another room, delete an object, bind an entity or execute code.
4. Checks rotated footprints against room boundaries, including edge crossings in
   concave rooms, and validates floor/ceiling bounds.
5. Creates a measured rectangle when requested. Exact shared walls are reused and
   opening offsets are transformed for reversed wall direction. Partial overlaps
   and inconsistent floor heights are rejected.
6. Applies only selected candidates; reports assumptions, missing measurements and
   collision/access warnings; validates the whole project and UTF-8 serialized size.

Source JSON is bounded to 256 KiB and 64 furniture candidates. The existing project
limits remain authoritative: floors, rooms, wall/opening/item counts, vertices,
coordinate bounds and the 2,000,000-byte project ceiling. The AI layer supplements,
rather than replaces, the normal editor and Python compiler validators.

## Preview, apply and undo

The bridge exposes an accepted-project snapshot/revision and a separate preview
project used only for drawing. Preview is never autosaved, exported or compiled.
2D additions have a separate highlight; the existing 3D renderer can inspect them.
Main-plan edits, selection changes and connection changes invalidate pending drafts.
Apply rechecks the accepted revision and invokes one normal history transaction.
Undo restores the preceding accepted project. Cancellation and failure do not add
history entries. Provider text is rendered with `textContent`, not interpreted HTML.

When a generated draft fails validation, the panel displays the error and a fixed
correction hint. The hint is included only if the user chooses Generate again;
there is no automatic retry. Changing the plan, inputs, photos or session clears
it. Raw rejected output and private project fields are never added to the hint.

Image work is sequential and isolated in a disposable worker. The browser checks
10 MiB per source, 30 MiB total, six images and 24 megapixels before decoding. It
re-encodes a maximum 1600-pixel image and drops original metadata. The server checks
prepared bytes/dimensions again but never invokes an image codec in its credential
process. Unsupported HEIC/SVG input requires explicit user conversion.

## Acceptance and limitations

```sh
node scripts/test-ai-draft.mjs
node scripts/test-ai-site.mjs
python3 scripts/test-ai-companion.py
AI_PLANNER_ENGINES=chromium,firefox,webkit node scripts/test-ai-planner.cjs
AI_PLANNER_ENGINES=chromium,firefox,webkit node scripts/test-ai-integration.cjs
python3 scripts/validate-site.py
python3 scripts/test_source_replay.py
```

The environment-variable prefix in these examples uses a Unix shell; set it with
PowerShell `$env:AI_PLANNER_ENGINES` on Windows. Browser checks need the development Playwright dependency and a supported installed
browser. Unit/transport tests use no third-party Python dependencies or cloud keys.
Fixtures cover rejected geometry and malicious fields, privacy/context boundaries,
provider serialization/refusals, session isolation, redirects, cancellation/expiry,
image bounds, detached preview, apply/undo and ordinary export. Accepted fixture
projects are checked by the independent Python validator and compiler.

These are synthetic integration checks, not a live provider certification matrix.
The user must choose an available vision+structured-text model. Enterprise
Azure/Bedrock/Vertex adapters, direct-browser provider access, LAN endpoints,
WebGPU inference and photo reconstruction of arbitrary floor geometry are not
implemented. The current AI UI is English; instructions may be multilingual.

No continuous render loop is added for AI. Image decoding happens only for selected
photos; inference requests happen only on Generate. No provider or AI code is added
to the installed viewer. Accepted site shapes add bounded geometry to its map
layer. A large room catalog or site context can still cost provider tokens. Requests
use one room or the explicitly disclosed site scope, with bounded candidate counts
and an explicit review before applying.
