# From room photos to an editable plan

**Status: proposal and setup research, not a released AI feature.** The current
editor draws and imports plans; it does not accept AI keys or generate rooms from
photos. The provider instructions below prepare external tools and accounts, not
a working connection to Home Studio. Research checked on **16 October 2026**;
model availability and provider policies can change.

An AI assistant can suggest room geometry, openings, furniture, colors, and
placement. Its result should become ordinary editable Home Studio objects, not
a flattened picture. A person supplies measurements and reviews the draft before
it changes the plan. Photos alone cannot establish an accurate scale, hidden
walls, or the connection between rooms. Vision models also have documented
[spatial-reasoning limitations](https://developers.openai.com/api/docs/guides/images-vision).

- Start with [cloud provider setup](ai-provider-setup.md) for hosted inference.
- Use [local model setup](ai-local-models.md) for inference on your own computer.
- Read the [implementation contract](ai-planner-architecture.md) for schemas,
  integration points, limits, and acceptance tests.

## The experience to build

1. **Choose where AI runs.** Select a cloud provider or a local model. Cloud mode
   asks for an API key for this session. Local mode shows the server address and
   loaded model; it should not ask for a cloud key unnecessarily. No Home Studio
   account or central key-registration service is needed.
2. **Describe one room.** Add a few photos from different corners, identify the
   entrance and a reference wall, and enter measured width, depth, and height.
   Annotate irregular walls and opening widths where known. The user can write
   instructions in their own language; dimensions and coordinates use explicit
   units. Existing measured geometry remains fixed unless changes are requested.
3. **Review what will be sent.** Show the destination, model, photo thumbnails,
   selected room context, and request limits. Remove or crop people, paperwork,
   screens, and other details the user does not want to share. Remove image
   metadata and reduce image size locally. Sending starts only on an explicit
   action, not on file selection or connection testing.
4. **Generate a draft.** The assistant chooses existing catalog designs and
   returns structured suggestions. The interface separates measurements from
   estimates and asks about missing facts. It never downloads arbitrary furniture
   models, runs generated code, or operates Home Assistant devices.
5. **Review in 2D and 3D.** Highlight additions, show dimensions, allow corrections,
   and accept or discard individual suggestions. Applying the reviewed selection
   creates one undo step. A timeout, refusal, cancellation, or invalid reply leaves
   the original drawing unchanged.
6. **Export and install as usual.** Save editable JSON, compile the plan, and use
   the existing [Home Assistant installation guide](../install.html). AI setup
   is not required to display or control the resulting plan.

For example: “This kitchen is 4.2 × 3.1 m with a 2.5 m ceiling. The door is on
the short wall shown in photo 1. Keep the measured walls. Add the table and
cabinets from photos 2–4; ask me before guessing window dimensions.” The draft
might place a table using a catalog size, but must identify that size as estimated.
Changing it to a measured size should be an ordinary editor operation.

## Where the key and photos go

![Proposed flow: browser to a local companion, then either a local model or an explicitly selected cloud provider; validated suggestions return for review before becoming an editable plan.](assets/ai/planning-data-flow.svg)

The recommended first implementation is an **optional local companion**: a small
program on the user's computer that serves the AI-enabled editor and talks to
the chosen model. The normal GitHub Pages editor keeps its current offline
network policy. This avoids making browser access to every provider or local
server a prerequisite. Cross-origin access requires cooperation from the server;
adding an API key does not solve [CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS).

In cloud mode, the key travels from the browser to that local companion and then
to the selected provider in its authentication header. The selected images,
instructions, and limited room context travel there for inference. A routing
service such as OpenRouter adds its own processing boundary and an upstream
provider. The proposed system has **no Home Studio-operated relay, key database,
or photo collection**. That does not mean data never leaves the computer.

In local mode, the companion contacts a model server on the same computer.
Downloaded models can run without cloud inference. Disable cloud features and
fallbacks, verify the actual runtime configuration, and test without outbound
network access before claiming local-only operation. A LAN model server keeps
inference on the user's network, but photos still leave the browser's computer;
label that destination distinctly. Downloading software or models initially is
also separate from inference privacy.

Direct browser-to-provider access is a possible later opt-in for endpoints that
explicitly support it. It avoids the companion but exposes the key to the page's
JavaScript and extensions and cannot promise universal API compatibility.
Require a dedicated trusted origin first: separate repository paths on the same
GitHub Pages host do not isolate credentials from other same-origin applications.
Browser-hosted inference through WebGPU is another possible later adapter; it
adds model downloads, memory pressure, and competition with the 3D renderer.
Neither is required for the initial implementation.

## Proposed privacy wording

These are acceptance requirements for future UI copy, **not claims about an
implemented AI connection**. Substitute the actual destinations and controls.

**Cloud session**

> Your API key is kept in memory by this browser session and your local companion.
> It is sent to the selected provider to authenticate requests. The photos,
> instructions, and room details you approve are sent there for processing.
> Home Studio does not receive or store them on its servers. The provider's data
> policy and API charges apply. End the session to forget the key locally.

For a gateway, also identify that gateway and its upstream routing policy before
Send. “Your token never leaves your device” must not appear in cloud mode.
Provider-side deletion or retention cannot be guaranteed by clearing local state;
for example, OpenAI's request storage settings are distinct from its
[abuse-monitoring and other retention controls](https://developers.openai.com/api/docs/guides/your-data).

**Same-computer local session**

> Requests go to the local model at the address shown below. Home Studio does not
> send these photos or instructions to a cloud provider in this mode. Keep cloud
> features and fallbacks disabled in your model server. Model downloads and the
> server's own logging are controlled separately.

## Session and security requirements

“Personal session” means an isolated, temporary connection, not a key saved in
the project. Keep the key out of `localStorage`, `sessionStorage`, IndexedDB,
cookies, URLs, clipboard automation, logs, and exports. Browser storage accessible
to page scripts is not a secret vault; see
[OWASP's storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html).
Non-sensitive choices such as the provider name may be remembered separately.

The browser and companion must support explicit **End session**, a finite idle
expiry, a server-side absolute lifetime, and per-tab isolation. Drop credentials
and image references when a session ends, expires, or is replaced. A reload starts
a disconnected UI; abandoned server sessions still expire even if a tab-close
notification never arrives. A cancelled request must not rehydrate an expired
session or apply a late result. Memory-only storage reduces persistence; it cannot
promise forensic erasure from operating-system swap or crash dumps.

Bind the companion to loopback by default. Enforce trusted Host/Origin values,
session authentication and anti-CSRF checks, and fixed configured destinations.
Reject redirects that could carry credentials elsewhere. Authenticate the
companion separately from the AI provider; never use a provider key as the local
session identifier. Do not make a generic URL-fetch proxy or let model output
select destinations. Each user-configured endpoint requires explicit review;
HTTPS certificate checks stay enabled for remote services.

Bind each credential to its adapter, normalized scheme/host/port, and allowed API
paths. Changing the provider or destination ends that credential session; never
reuse a key against a newly entered endpoint. Local mode must bypass inherited
HTTP proxies and enforce loopback addresses at connection time, including retries.
A LAN profile needs its own reviewed address policy and privacy label. Verify
actual resolved destinations rather than trusting an entered hostname alone;
[OWASP describes the related destination-validation risks](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).

The companion must serve only its reviewed application assets, forbid framing,
and isolate opener relationships. A different URL path is not an origin boundary;
[MDN explains opener isolation and its limits](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy#severing_the_opener_relationship).
Decode images in a separate bounded worker/process with no credentials or network
access. Do not give a photo decoder the companion's provider keys or environment.

No analytics or automatic crash upload may include prompts, images, replies,
keys, or raw upstream errors. Diagnostics contain only allowlisted metadata
such as adapter name, timing, HTTP status, and safe error codes. An explicit
diagnostic export needs its own redacted preview. Project autosave may store the
**accepted geometry** as it does today, but never raw photos, key material, or the
AI conversation. Ordinary exported plans remain private household data.

## Delivery sequence and definition of done

The first useful slice should furnish a measured room safely; the complete
photo-to-plan feature also requires room creation and multiroom review.

1. **Draft contract and review:** use fictional images and mocked replies to
   implement bounded JSON parsing, catalog mapping, preview, per-item acceptance,
   and one-step undo. Prove original geometry and entity bindings are preserved.
2. **One local and one cloud adapter:** start with Ollama and OpenAI through the
   companion. Verify image support and structured results against exact tested
   model/runtime versions. Add session expiry, request cancellation, limits, and
   redacted diagnostics before using real homes.
3. **Create measured rooms:** generate walls, windows, doors, and furniture from
   photos plus explicit measurements. Review coordinate frames, shared walls,
   and adjacency before joining rooms. Never infer a whole house from unrelated
   room photos without asking how the rooms connect.
4. **Expand providers:** add native Anthropic/Gemini adapters and tested
   OpenAI-compatible adapters. Capability detection must include a small synthetic
   vision/JSON test with consent; listing a model is not proof it can see images.
5. **Release acceptance:** on supported macOS, Windows, and Linux browser lanes,
   test invalid keys, CORS failures where relevant, timeouts, refusals, malformed
   and oversized replies, stale drafts, malicious image text, and two independent
   sessions. Verify storage and network traces using synthetic markers. Compile,
   install into a temporary HA config, reopen JSON, and inspect the generated
   viewer. Keep live paid-provider smoke tests opt-in and out of ordinary CI.

Budget image decoding and upload size, run at most one inference request at a
time, cap output size and repair attempts, and do not load AI dependencies into
the installed viewer. Record idle/render performance before and after integration.
The existing manual drawing experience must remain usable when AI is unavailable.

This proposal has been checked against the current editor and official provider
documentation. It is **not** evidence of successful inference, model accuracy,
measured latency, or production security. Those claims require the acceptance
work above, with exact models and environments recorded.
