# Contributing

Use public GitHub issues for reproducible non-sensitive bugs and proposals, and
focused pull requests for changes. English is the shared discussion language;
translated user documentation is maintained according to [i18n](docs/i18n.md).
Read [security](SECURITY.md), [governance](GOVERNANCE.md), the
[Code of Conduct](CODE_OF_CONDUCT.md) and [roadmap](ROADMAP.md).

Original contributions use the repository MIT license. Preserve third-party
license notices and do not copy external models, assets or data without rights.
Never commit a real home's plan, device inventory, images, credentials or
operational archives. Use minimal fictional fixtures.

All major functionality changes must include automated tests, relevant negative
cases and documentation of compatibility impact. Python uses clear standard
library code and existing formatting; browser modules follow local JavaScript
conventions. Do not disable assertions, weaken validation limits or silently
skip failed tests to obtain a green run.

## Development and review

Use Python 3.10+ and the Node/browser versions pinned by CI. Run:

```sh
python3 -m pip install ruff==0.14.0
python3 -m ruff check --select F scripts
python3 scripts/validate-site.py
python3 scripts/test-install-home-assistant.py
python3 scripts/test-public-package.py
python3 scripts/test_package_release.py
node --test fuzz/*.test.mjs
```

Run affected focused tests under `scripts/` too. Browser changes require the
complete declared platform matrix; local smoke results do not replace it.
`package.json` and the lock file specify browser-test dependencies. CI also
runs CodeQL for first-party Python and JavaScript. Investigate diagnostics and
resolve substantive review findings before normal merge. The maintainer owns
review and release acceptance; automation is supporting evidence.

[RELEASING.md](RELEASING.md) defines exact-candidate acceptance and promotion.
A merge or successful software test does not authorize deployment, provide
physical-device acceptance or demonstrate household safety.

For transport changes, install `requirements-tls-test.txt` in an isolated development environment and run `python3 scripts/test-download-tls.py`. These tests use generated certificate chains without external network calls.
