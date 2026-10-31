# Release-candidate fuzzing

See the [illustrated RC fuzzing process and verified rollout results](https://github.com/victron-venus/venus-os-ci-toolkit/blob/main/docs/rc-fuzzing-results.md)
for the shared release flow, evidence requirements and a dated cross-project
snapshot. The [Home Studio v0.6.4 evidence snapshot](quality-and-release.md#recorded-results-including-failures)
connects one release's fuzz results to its browser checks and stable promotion.
The project-specific scope and reproduction guidance below still apply.

> **Local packaging:** `python3 scripts/release.py package` is unsupported in this repository because no shell packaging adapter is installed. Use the [project commands below](#local-release-packaging); the generic example in `release-workflow.md` does not apply here.

The public repository runs [Jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js)
through the shared `venus-os-ci-toolkit` workflow. `.github/fuzz.json` defines
the real production entry points, locked dependency setup and time budgets;
`.release-policy.json` pins the reusable workflow to a full commit.

Mutation campaigns run only for an explicit RC dispatch on the public default
branch. Pushes, pull requests, beta and nightly releases retain ordinary checks
without mutation-campaign minutes. A deterministic regression check replays the
synthetic validation and geometry corpora, checks deliberate error classes, and
verifies that named positive/negative furniture seeds reach their intended branch in ordinary CI;
it needs no Jazzer installation. Private forks cannot use this public RC gate. This is
repository-managed fuzzing, not enrollment in Google's hosted OSS-Fuzz service.

## Targets and boundaries

* `project-validation` supplies bounded JSON to the editor's actual
  `validateProject`. Deliberate validation errors are allowed; unexpected error
  types fail. Accepted projects must remain unchanged, survive JSON round trips,
  have unique identifiers and finite bounds, and produce positive wall pieces.
  The target also checks complete-project requirements and rejection of added
  fields and reserved prototype identifiers.
* `wall-geometry` generates fictional metric rooms, rotated walls, windows and
  catalog furniture with styles, colors and supported patterns.
  It validates them through production validation, checks clamped wall projection,
  wall area minus opening area, polygon winding and point containment. Expected
  areas and projection distances are computed independently of the functions
  under test; comparisons allow floating-point rounding. Both targets check
  rotated furniture bounds against an independent support-radius formula.
  Geometry also checks isolated item bounds (so room bounds cannot hide errors)
  and translation invariance. Fixed tests cover quarter/diagonal rotations,
  byte extrema, and invalid model/style/type/pattern/color combinations.

Each target gets 60 seconds of mutation, a 10-second per-input timeout and a
2 GiB RSS limit. JSON is capped at 64 KiB; geometry input at 4 KiB. The production
validator retains its own object and coordinate limits. Dependency installation
can access the network; target execution runs inside a Linux network namespace
without it. A successful process with zero libFuzzer executions fails the gate.

The seed corpus contains only the project's fictional examples and synthetic
boundary cases. Never add a real home's plan, device identifiers, screenshots,
credentials, network addresses or recordings. The campaigns do not connect to
Home Assistant, deploy Pages, install components or operate devices. Browser
usability, installation acceptance and physical-device behavior require their
separate checks.

## Local use and reproducing findings

Run the cheap regression checks with `node --test fuzz/*.test.mjs`.
It accepts ordinary `Error` and the production `ValidationError` exactly; unexpected
subclasses, including `TypeError` and `RangeError`, remain findings.

The deterministic replay tests and their fixed fictional corpus are included in
versioned source ZIPs and need no dependency installation. Full mutation campaigns
below require Node 24 in a source checkout; the Jazzer dependency manifests and
release infrastructure are not part of the end-user application ZIP.

```sh
npm ci --prefix fuzz --ignore-scripts --no-audit --no-fund
node fuzz/node_modules/@jazzer.js/core/dist/cli.js \
  fuzz/project-validation.mjs --sync -- -max_total_time=60 \
  -timeout=10 -rss_limit_mb=2048 fuzz/corpus/project-validation
node fuzz/node_modules/@jazzer.js/core/dist/cli.js \
  fuzz/wall-geometry.mjs --sync -- -max_total_time=60 \
  -timeout=10 -rss_limit_mb=2048 fuzz/corpus/wall-geometry
```

Download `fuzz-diagnostics-<attempt>` from a failed RC run. It preserves target
and setup logs, the report, corpus and generated crash/timeout inputs. Reproduce
one input with the same target and runtime:

```sh
node fuzz/node_modules/@jazzer.js/core/dist/cli.js \
  fuzz/wall-geometry.mjs --sync -- -runs=1 /path/to/saved-input
```

Keep a minimal synthetic seed and an ordinary regression test with a fix, then
request a new RC from reviewed source. Local success does not substitute for
the isolated campaign from the RC's own run and attempt.

## Evidence and distribution

Qualified RC evidence includes `fuzz-report.json` and `release-inputs-fuzz.json`.
The publisher checks repository, source SHA, run, attempt, manifest hash and exact
successful target inventory. Validation receipts remain separate from build
receipts, and an older release cannot retroactively satisfy this policy.

The release adapter packages the explicit public website/compiler inventory as
`home-studio-<version>.zip`, with a `.sha256` checksum and version/source metadata.
The archive extracts under `home-studio/`; personal `project.json`, generated
homes and private checkouts are never inputs. The component manifest inside the
ZIP carries the frozen version. GitHub Pages publishing keeps its existing
workflow and reviewed website allowlist. See [release policy](../RELEASING.md)
for beta, RC and stable promotion requirements.

## Local release packaging

Use Python 3.12+ from the repository root:

```sh
python3 scripts/test_package_release.py
python3 scripts/package_release.py
```

This writes the public Home Studio ZIP, checksum and version metadata to a new `release-dist/` directory. The website/compiler allowlist excludes personal project files. It does not publish GitHub Pages. Use a clean disposable checkout and a new output directory.

To reproduce an already allocated beta or RC, first check out the exact source
commit from its published `release-manifest.json`, restore that manifest's
`version_plan` object as `.release-plan.json`, and apply its version overlay:

```sh
python3 scripts/version_plan.py sync --root . --plan .release-plan.json
```

Then run the project commands above. Keep the source, plan and channel together;
do not invent a release sequence or edit version fields by hand. Local packaging
does not create a qualified release: the hosted pipeline still verifies the full
build inventory, provenance and, for an RC, its own isolated fuzz report.

## Public release artifacts and retries

Fresh public package uploads and RC fuzz evidence use
`-run-<run_id>-attempt-<run_attempt>` artifact names. The candidate and final
collectors select that same run and attempt.

Before publication starts, use **Re-run all jobs** only if the allocator and
release policy permit reuse of that run's reservation. Recreate every required
input in the same attempt; failed-only or individual retries can leave inputs
missing, and older artifacts must not fill those gaps.

For a fresh candidate or final build, once publication has started
(`begin_publication`), or its external publication result is partial or uncertain,
inspect the existing release, tags and assets before retrying. A consumed build
number requires a new workflow run and reservation authorized by the release
policy; an existing immutable tag may also require a new base version. Never
reset the release ledger, overwrite assets or retag to force a retry. Historical
byte promotion of an accepted RC keeps its reserved number and follows the
existing promotion policy.

Mutation remains limited to an explicit RC dispatch on the public default
branch. Its report describes one source revision and run; it does not establish
complete platform coverage or device acceptance. See the shared
[evidence contract](rc-fuzzing.md).

The fresh closed-build importer consumes the same public package and fuzz
artifact names, so its selectors must migrate with the public workflows.
Published-release validation and rebuild use their existing verified context
artifacts and exact artifact IDs. Their environment gates, lineage checks and
historical receipt rules remain separate from fresh collection.

### Package receipt identity

Fresh publication verifies each staged package receipt against the independently
supplied repository, source commit, workflow run and attempt. Receipts created
before this migration, or offline without an Actions identity, cannot qualify a
fresh publication. Run all required producers in one complete workflow attempt
after migration; an earlier attempt cannot fill missing inputs.

Historical promotion and retained-evidence validation keep their existing checks.
Receipt coverage validates the staged files; the expected packages and platforms
still require a separate completeness check. Existing release approval and device
acceptance policies continue to apply.

See the shared [receipt migration guide](https://github.com/victron-venus/venus-os-ci-toolkit/blob/main/docs/release-workflow.md#migrate-package-receipt-identity-without-replacing-the-release-engine).
