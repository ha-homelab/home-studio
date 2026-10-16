# Development and validation

The [architecture reference](../architecture.md) describes the compiler, trusted
host, sandboxed viewer, backend, and optional private adapters. Keep public tests
fictional. Household models, endpoint configuration, credentials, native signing
keys, and generated private APKs belong outside this repository.

## Source map

- `planner/`: drawing editor, model, locale packs, and help.
- `viewer.js`, `home-view.js`, `viewer-i18n.js`, `viewer-locales/`: generated plan
  interaction and bundled translations.
- `custom_components/home_floorplan/static/panel.js`: authenticated host,
  MessagePort validation, preferences, and device-command guard.
- `custom_components/home_floorplan/`: backend validation and service handling.
- `scripts/build-planner-project.py` and `scripts/install-home-assistant.py`:
  deterministic local build and archive installation.
- `docs/`: detailed references, translated quick starts, source SVG diagrams,
  and this repository-local wiki.

## Check a guard or language change

Use fake Home Assistant services. A regression should exercise the production
message handler, count device-service calls, and verify real readings are not
replaced by simulated success. Cover native details, unknown message types,
stale viewer generations, storage failures, and the dispatch-time race.

```sh
node --test scripts/test-dry-run.cjs
node --test scripts/test-panel-language.cjs
python3 scripts/build-panel-locales.py --check
node scripts/test-i18n.mjs
node scripts/test-validation-i18n.mjs
node scripts/test-viewer-i18n.cjs
python3 scripts/test-public-package.py
python3 scripts/test-install-home-assistant.py
python3 scripts/validate-site.py
```

Browser suites require the development dependencies and Chromium described in
the [README](../../README.md#checks-and-publication). Follow
[the i18n guide](../i18n.md) for language-specific browser checks. Run the relevant
suite after implementation; a listed test is not evidence that a particular
release or physical tablet passed it.

## Keep documentation reviewable

Update the detailed reference and concise wiki together when behavior changes.
Every supported locale needs a useful localized README. Keep source diagrams as
SVG with a `viewBox`, accessible `title`/`desc`, and readable labels; validate
relative links when moving a page. Reference the real implemented boundary:
Dry run guards plan device requests but does not freeze layout editing or other
Home Assistant clients. Avoid fabricated benchmark graphs or claims of language
fluency based only on key parity.

Follow [release instructions](../../RELEASING.md) for publication. The source
wiki is maintained locally; uploading it to a separate GitHub Wiki is a distinct
publication step. Private tablet build/install evidence remains private.

[Documentation home](Home.md)
