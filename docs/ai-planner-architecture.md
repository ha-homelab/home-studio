# AI-assisted planner architecture

The optional companion adds an inference boundary to the authoring tool. It does
not add AI code to the installed Home Assistant viewer or weaken the hosted
editor's `connect-src 'none'` policy. Both AI modes produce the existing project
schema and use the existing compiler/installer.

## Modules and ownership

- `scripts/serve-ai-planner.py`: stdlib-only Python 3.10+ launcher.
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
- `ai/bootstrap.js`: injected only by the companion; loads the optional UI and CSS.
- `ai/panel.js`: provider connection, request/review lifecycle and editor integration.
- `ai/photo-worker.js`: bounded image inspection, decode, resize and re-encoding,
  served with `connect-src 'none'`. It has no session credential or provider key.
- `ai/draft.js` and `ai/json.js`: pure draft/context/schema/geometry validation.
- `planner/editor.js`: a small exported bridge for accepted snapshot, revision,
  selection, detached preview, explicit transactional apply and subscriptions.

The public website publishes the setup guide, not a key-entry form. The source
release includes the companion and its tests. AI modules are outside `planner/`
so the ordinary planner's static no-network check still applies to every editor
module. The editor never imports the optional bootstrap on its own.

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

`POST /api/ai/cancel` aborts pending work and invalidates late results.
`POST /api/ai/disconnect` also clears credentials. Sessions expire after at most
30 minutes; the process periodically cleans abandoned sessions. There are at most
8 page sessions, 12 concurrent HTTP handlers and one inference request. Requests
have a 90-second total deadline. DNS resolution is independently bounded and does
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

Image work is sequential and isolated in a disposable worker. The browser checks
10 MiB per source, 30 MiB total, six images and 24 megapixels before decoding. It
re-encodes a maximum 1600-pixel image and drops original metadata. The server checks
prepared bytes/dimensions again but never invokes an image codec in its credential
process. Unsupported HEIC/SVG input requires explicit user conversion.

## Acceptance and limitations

```sh
node scripts/test-ai-draft.mjs
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

No continuous render loop is added for AI. Worker decoding happens only for selected
photos; requests happen only on Generate. The installed viewer and its resource
budget are unchanged. A very large catalog context can still cost provider tokens;
one room per request bounds the private spatial context and makes review practical.
