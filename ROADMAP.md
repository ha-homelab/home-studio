# Roadmap

This roadmap covers October 2026 through October 2027. It states planned work,
not completed capability or a delivery guarantee; priority can change through
public issue and pull-request discussion.

- October–December 2026: Expand malicious archive/import regression cases and review browser resource limits across the supported platform matrix. Keep physical acceptance separate from software rendering results.
- January–June 2027: improve contributor setup, dependency-update qualification,
  documentation examples and measured test coverage of error paths.
- July–October 2027: review compatibility and maintenance costs; recruit a backup
  maintainer and exercise repository/CI/release access recovery before claiming
  one-week continuity or a higher OpenSSF tier.

Throughout the year, triage security reports and dependency advisories, preserve
privacy boundaries, and keep source releases reproducible from published inputs.
Byte-for-byte repeatable build output is a goal, not a verified property.

Non-goals are processing private household data in public CI, claiming physical
safety or device commissioning from synthetic tests, and silently introducing
live control or a general-purpose sandbox. The documented restricted scope is
preserved unless a separate reviewed design explicitly changes it.

## Usability work after the first-session release

- A room-aware editing model: moving a room should deliberately offer to move
  its associated walls, openings, and furnishings. Shared-wall ownership and
  partial overlaps need a geometry design before this can be reliable.
- A guided local build-and-install handoff: reuse the existing compiler and
  reviewed archive installer, while keeping destination selection, backups,
  restart requirements, and credential boundaries explicit.
- Safer automatic integration upgrades: separate generated private home assets
  from the integration's code before offering an updater that replaces that code.
  The present release uses the documented toolkit and installer, not HACS.
- More user-shaped acceptance: exercise first-room completion, recovery from a
  failed render, and editing continuity with realistic input sequences. Keep
  fictional reproducible examples and do not collect private project telemetry.

These are design directions, not features shipped by the current release.
