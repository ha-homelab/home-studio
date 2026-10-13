# Release-candidate fuzzing

The public repository runs [Jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js)
through the shared `venus-os-ci-toolkit` workflow. `.github/fuzz.json` defines
the real production entry points, locked dependency setup and time budgets;
`.release-policy.json` pins the reusable workflow to a full commit.

Mutation campaigns run only for an explicit RC dispatch on the public default
branch. Pushes, pull requests, beta and nightly releases retain ordinary checks
without fuzzing minutes. Private forks cannot use this public RC gate. This is
repository-managed fuzzing, not enrollment in Google's hosted OSS-Fuzz service.

## Targets and boundaries

* `project-validation` supplies bounded JSON to the editor's actual
  `validateProject`. Deliberate validation errors are allowed; unexpected error
  types fail. Accepted projects must remain unchanged, survive JSON round trips,
  have unique identifiers and finite bounds, and produce positive wall pieces.
  The target also checks complete-project requirements and rejection of added
  fields and reserved prototype identifiers.
* `wall-geometry` generates fictional metric rooms, rotated walls and windows.
  It validates them through production validation, checks clamped wall projection,
  wall area minus opening area, polygon winding and point containment. Expected
  areas and projection distances are computed independently of the functions
  under test; comparisons allow floating-point rounding.

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

Use Node 24 in a source checkout; contributor infrastructure is not part of the
end-user application ZIP.

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
