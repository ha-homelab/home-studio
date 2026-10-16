# Security policy

The latest stable release and current development source receive security fixes.
Report vulnerabilities through [GitHub private reporting](https://github.com/ha-homelab/home-studio/security/advisories/new)
or **alvit.work@gmail.com**. Include the affected source/version, impact and a
minimal fictional reproduction. Do not send household plans, account tokens,
real entity inventories, camera frames or unredacted backups.

The maintainer aims to acknowledge within 14 days, assess impact privately,
reproduce and test a correction, and agree on disclosure timing. Confirmed
critical issues are addressed immediately; other medium-or-higher issues should
be fixed within 60 days. Release notes include available CVE/GHSA identifiers,
upgrade guidance and reporter credit unless anonymity is requested. Retry the
other private channel if needed. There is no independent security team or backup
maintainer; see [governance](GOVERNANCE.md).

## Trust and privacy boundaries

The hosted editor stores its draft in browser localStorage and exports JSON.
It does not connect to Home Assistant. Anyone with access to that browser
profile can see its draft; export a backup before clearing browser data.
Project JSON is untrusted input: schema, size, number, identifier and geometry
limits are checked by the editor and compiler. Validation is not authentication
of a plan's accuracy or a certification of physical safety.

The local installer treats archives as untrusted. It checks compressed/expanded
sizes, entry types/counts, traversal, links, sparse metadata, duplicate/colliding
paths, required files and trailing data before writing a staged package. It
rejects destination symlinks and supports backup/rollback. Run it as the owner
of a private destination directory and prevent concurrent untrusted writers;
these checks are not an operating-system sandbox. Never run it on a live HA
configuration merely to test an unknown archive.

The installed viewer and integration run within Home Assistant's access-control
boundary and can expose configured device state. HA supplies authentication and
its network endpoint; restrict account permissions, keep HA current, and use
trusted HTTPS for remote access. Household exports, generated packages and
backups remain private. The repository contains fictional examples and public
source only. Third-party JavaScript retains its bundled license.

See [architecture](docs/architecture.md), [RC fuzzing](docs/fuzzing.md) and
[release acceptance](RELEASING.md) for software-test and deployment boundaries.
