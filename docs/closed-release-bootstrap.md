# Closed release bootstrap contract

`scripts/closed_release_worker.py` provides an explicit, finite v2 worker path.
It is **not enabled in release orchestration**. Normal `action=build` remains
blocked before private input access and independently at the legacy candidate
upload boundary. Existing rebuild and accepted-byte validation behavior is
unchanged. Passing its local tests does not authorize a deployment, remove an
environment protection, or establish live storage capacity.

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
or `nightly`. Stable promotion and existing-release rebuilds are outside this v2
exchange. Execution and full public-context fields must match independently
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
from that signature alone. Production integration should use the higher-level
path.

`authenticate_input(...)` authenticates the actual encrypted input tar and its
bootstrap. `validate_bootstrap(..., now=...)` validates bindings and current
validity without authenticating an envelope. The pure
`validate_bootstrap_bindings(bootstrap, expected, capabilities, limits)` omits
freshness solely for delayed proof reconciliation; it grants no write authority.

The transfer performs one intent PUT, bounded polling of the fixed permit object
(only HTTP 404 permits another read), one candidate PUT, and one result PUT.
Input, permit, and acceptance publication belong to the authority. There are no
diagnostic PUTs, upload retries, automatic renewals, or finalizer uploads.

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
