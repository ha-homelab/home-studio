# Closed release bootstrap contract

`scripts/closed_release_worker.py` provides the finite v2 exchange used by the
configured `action=build` route. Without the protected ledger anchor described
below, normal builds and stable validation still refuse before private input
access. Existing-release rebuilds can explicitly select the v2 route described
below or retain their separate v1 permit route, and
the legacy upload entry point still rejects normal builds. Local test success
does not configure the environment, establish live storage capacity, authorize
a deployment, or satisfy actual home acceptance.

The protected workflow executes `closed_release_worker.py`. Its CLI delegates
to the existing bounded `closed_build.main` with an explicit release executor;
the transport module does not import the worker. Calling `closed_build.py`
directly for a normal build or stable validation remains fail-closed, even with
an anchor. Explicit Python callers pass `release_executor=worker.execute_release`
to `closed_build.execute`. Public preparation retains its implementation and
checks. A selected v2 rebuild also requires this explicit executor and anchor.

The existing [closed-build contract](closed-build.md) still governs containment,
public artifact provenance, encrypted envelopes, and final site acceptance.
The bootstrap adds accounting for the first control write and the final result.

## Six objects, reserved before writes

One request reserves bounded ciphertext bytes for all six roles before publishing
its input: **input, intent, permit, candidate, result, and acceptance**. The
authority retains a checkpoint for that atomic reservation and separate original
checkpoints for the intent and result attempts. Those two control attempts begin
with unknown ciphertext hashes: the worker cannot compute their envelopes until
it has built the candidate and received the candidate PUT result. Their full
reserved bounds remain charged until exact content and version evidence can
confirm them. Expiry, failure, or cancellation does not release a reservation.

The input's authenticated `closed-build.json` contains `upload_bootstrap`, with:

- Exact request/nonce, execution identity, event/channel, plan hash, and hash of
  the full enriched public context.
- Worker image and complete worker-policy hash; the four v2 admission limits
  also have their own canonical digest.
- Ledger/batch/scope/bucket identity, the reservation checkpoint, and the two
  original control-attempt checkpoints.
- Six distinct claim IDs, object names, attempt IDs, ciphertext bounds, and
  request-target hashes.
- Prefix-capability hashes, explicit input routing, creation/expiry times, and
  the growth-evidence reference and covered horizon.

The bootstrap does not contain its own encrypted input hash. After sealing the
input, the authority records its exact ciphertext hash and size before its PUT.
The worker's intent then binds that actual input hash, which the authority must
compare with its retained input claim.

Each control envelope is at most 8 KiB, with a smaller signed bound enforced if
provided. Input and candidate bounds must fit their existing envelope/package
limits; acceptance is bounded separately. The worker checks the actual immutable
bytes immediately before each PUT. A transport response-size limit is not an
upload-size bound.

## Explicit routing and timing

All names are prefix-relative and deterministic:
`<request>/<run>-<attempt>.<role>.json`, where the role suffix is `input`,
`upload-intent`, `upload-permit`, `candidate`, `upload-result`, or `acceptance`.
`object_names(request_id, execution)` returns this mapping.

The input routing kind is `closed-prefix-routing-v2`. The caller must provide
independently reviewed, appropriately scoped prefix capabilities for input read,
output read/write, and acceptance read, plus their expected hashes and the exact
input target hash. An existing object-only capability cannot be reinterpreted as
a prefix capability. There is no mutable discovery pointer. Provisioning and
verifying those scopes are separate operational work; a URL hash proves neither
the granted scope nor access rights.

Push binds to `beta`, schedule to `nightly`, and workflow dispatch to `beta`, `rc`,
or `nightly`. Stable promotion reads the original RC acceptance without a new v2 exchange.
Existing-release rebuilds use their explicitly selected exchange. Execution and full public-context fields must match independently
trusted caller expectations, not merely the bootstrap's own assertions.

The bootstrap covers a bounded interval of at least 900 and at most 3600 seconds,
starting at the authority's original capacity observation. Independently
substantiated growth coverage must include that entire interval, including
accumulated queues and other writers. A 30-second-old inventory cannot establish
that longer coverage by itself. The worker keeps one monotonic elapsed-time
baseline across authentication, public input validation, the build, and upload.

After authenticating the intent, the authority must reassess current capacity
and all outstanding claims before beginning the exact candidate attempt and
issuing its permit. Candidate and result PUTs must both finish before the fresh
permit expires and before bootstrap expiry. Candidate-permit TTL and capacity
age remain at most 30 seconds. The longer bootstrap does not extend them.

## Callable interfaces and failure behavior

`build_and_run_release(args, temporary, *, input_wire, input_keys, output_keys,
limits, expected, capabilities, journal_path, timeout=60)` authenticates the input
before public-input I/O, checks the actual public context and prepared worker
policy, and uses the existing contained builder, output validation, and candidate
signing path. It takes no caller-supplied candidate.

`upload_release(input_wire, candidate, *, input_keys, output_keys, limits,
expected, capabilities, journal_path, timeout=60)` is the lower-level transfer
phase. Its caller must already have established the candidate's provenance. It
checks the candidate signature/purpose, but cannot infer its decrypted manifest
from that signature alone. The configured production route shares the contained
builder with the higher-level path before entering this transfer phase.

`authenticate_input(...)` authenticates the actual encrypted input tar and its
bootstrap. This path accepts regular USTAR members in exactly one gzip stream;
it rejects PAX/GNU extensions and other member types before reading their
payloads. Streaming decompression bounds the full tar, including headers and
padding, independently of the member-size checks.
`validate_bootstrap(..., now=...)` validates bindings and current
validity without authenticating an envelope. The pure
`validate_bootstrap_bindings(bootstrap, expected, capabilities, limits)` omits
freshness solely for delayed proof reconciliation; it grants no write authority.

The transfer performs one intent PUT, bounded polling of the fixed permit object
(only HTTP 404 permits another read), one candidate PUT, and one result PUT.
Input, permit, and acceptance publication belong to the authority. There are no
diagnostic PUTs, upload retries, automatic renewals, or finalizer uploads.
Each PUT timeout is additionally capped by the admission time remaining after
its attempt journal is synced; the deadline is checked again after the call.
The release transport supervises each request in a separate process, with a
deadline that includes validation, hashing, preparation, and child startup.
Timeout terminates the owned process group and reaps the direct child, using a
separately bounded cleanup grace. It cannot guarantee cancellation of a remote write. Uninterruptible
local OS/filesystem calls can delay return, but late results are rejected.

An append-only owner-private journal is synced before every PUT. Its directory
must be a trusted POSIX directory with mode 0700; the journal is created
exclusively with mode 0600. Any existing journal rejects re-entry, including a
crash before the first request. Keep the journal and encrypted control wires
private for reconciliation; never send them to Actions artifacts or logs.

A successful candidate PUT followed by result expiry or failure stays ambiguous
and charged. A missing version ID stays null. Neither a transport receipt nor
the returned `authorizes_upload: false` record establishes exact-version
inclusion, site acceptance, or installation permission. The existing separately
verified site checks and release qualification remain necessary before final
acceptance.

Run `python3 scripts/test-closed-release-worker.py` with the locked transport
dependencies for the local contract tests. These exercise real envelope
cryptography and the existing builder's validation path with synthetic inputs;
transport and container execution are substituted. Live capability scope,
growth coverage, Docker integration, and complete trigger-by-trigger deployment
qualification remain operational prerequisites. This module installs no service,
changes no credentials, and dispatches no workflow.


## Configured production route and stable lookup

### Rebuilding against an existing publication

A private change can be qualified against an existing public release with
`operation=closed-rebuild` and `existing_release=<exact tag>`. This operation
does not allocate a version or promote a release. Keep `version` and `rc_tag`
empty. The published release and its original source qualification must still
pass the existing resolver's complete checks.

Set `CLOSED_REBUILD_PROTOCOL=v2` in the protected `closed-build` environment to
select the ledger-backed exchange. The existing `CLOSED_RELEASE_LEDGER_ANCHOR`,
prefix capability checks and all six reserved roles remain required. An unset
value or `v1` retains the separate legacy contract; any other value rejects the
rebuild. Once v2 is selected, a missing executor, missing anchor or failed
exchange never falls back to v1. This selector does not change normal-release
or stable-validation routing.

There are two independent identities:

- The published context retains the original public source, run, attempt,
  payload hashes and version plan. A promoted stable tag can retain its original
  RC plan and channel.
- The new rebuild execution uses its current source, run and attempt. It must
  be an authenticated workflow dispatch with the exact successful
  `closed_existing_resolve` job and active `closed_rebuild / package` job. A
  current new-version Release gate is not substituted for the publication's
  original qualification.

The request ID is `rebuild_request_id(repository_id, current_run_id,
current_run_attempt, original_plan_channel)`. It uses the `rebuild-` namespace
and a distinct canonical hash domain. All six object suffixes use the current
rebuild run and attempt. Rebuilding the same publication again therefore cannot
reuse a previous exchange's objects or grants. Leave `closed_request` empty at
dispatch to derive the ID from the new authenticated run; an explicit ID must
match it exactly. The private operator uses the same public helper after
authenticating that new run, then prepares its revision-bound input under the
unchanged admission and expiry rules.

Published context and current execution are checked separately before the
input GET, before the contained build, and through the existing write
checkpoints. The normal-release prospective-context equality checks remain in
place. Package-only inputs are supported by the existing builder; that mode
still requires package, site-contract and runtime-size checks, followed by
actual package acceptance. No prior private status is transferred to a new
revision. Capacity, growth, task budget, outstanding claims and canary evidence
remain the operator's independent responsibilities.

### Normal release anchor

The existing `closed-build` protected environment must supply
`CLOSED_RELEASE_LEDGER_ANCHOR` through its environment variables, alongside the
existing eight secrets. This change does not set that variable or grant access.
The variable is at most 16 KiB of JSON with this exact schema (placeholders are
not usable configuration):

```json
{
  "schema": 1,
  "kind": "closed-release-ledger-anchor",
  "ledger": {
    "ledger_id": "REVIEWED_OPAQUE_ID",
    "batch_id": "REVIEWED_OPAQUE_ID",
    "scope_fingerprint": "SHA256",
    "bucket_fingerprint": "SHA256"
  },
  "capability_sha256": {
    "input_read": "SHA256",
    "output_read": "SHA256",
    "output_write": "SHA256",
    "acceptance_read": "SHA256"
  }
}
```

The four hashes must match the exact corresponding secret prefix URLs. Missing,
malformed or mismatched configuration refuses before private I/O. This anchor
must come from an independently reviewed ledger and capability configuration;
neither its presence nor a signed bootstrap establishes actual IAM scope,
capacity, future growth, an inventory watermark, or authorization to install.
Those remain the private operator's independently verified prerequisites.

The worker verifies the current repository and owner numeric IDs, public
repository, main ref, source checkout, trusted event and workflow, latest run
attempt, successful Release gate for a new build, and the one currently executing closed job
using GitHub API results. It also uses the existing complete public plan,
artifact, receipt and source-policy checks. Dispatch channel is checked against
the actual event payload. It then derives a request ID using
`release_request_id(repository_id, run_id, run_attempt, channel)`: `release-`
followed by SHA-256 of canonical JSON
`["closed-release-request-v2", repository_id, run_id, run_attempt, channel]`.
All three numeric identifiers are decimal strings. The private operator must use
this same public function with independently authenticated run data before it
prepares the six-role bootstrap. A supplied `closed_request` must equal this ID;
an empty input selects this ID, never a mutable default object.

Only the derived input suffix is read. The signed bootstrap must equal the
independent public execution/context, protected ledger and capability hashes,
worker image and policy. The original grant and fresh GitHub identity are checked
after this GET immediately before the contained build, again before entering
the existing intent/permit/candidate/result exchange, and before each PUT.
Identity-read time also consumes the remaining original permit time. Build and GET time consume
the same original grant; expiry does not cause a new read, reseal, retry or write.
The existing input transport has a 256 MiB body cap and a 60-second **socket**
timeout, not a whole-download timer. The unchanged 25-minute Actions job bounds
the complete operation. The control transport remains 8 KiB with 16 KiB IPC;
large input bytes are never sent through its control IPC.

For stable promotion, the existing resolver first verifies the selected exact RC
release, retained successful/latest source attempt and complete immutable public
assets. The current stable run intentionally skips its build/Release gate; the
worker instead requires its exact successful `closed_stable_resolve` job and
verified resolver artifact. The worker derives the locator from that **original RC** run, attempt
and `rc` channel, not the current stable promotion run. It reads only that
acceptance suffix (8 MiB cap), verifies its signature, source, request, candidate
object, site acceptance and publication proof, then checks the exact candidate
hash and signature. The original successful build/latest attempt and current
promotion identity are checked again after transfer. A missing historical
acceptance or a non-deterministic legacy request has no fallback scan or mutable
pointer; it remains unavailable for this route.

These are executable configured caller paths, not evidence of a live grant or
home acceptance. No environment value, credential, retention rule or household
state is changed by this source update.
