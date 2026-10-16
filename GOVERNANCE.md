# Governance

`4alvit` is the primary maintainer of this Home Studio editor, local compiler and Home Assistant integration. The maintainer is responsible
for review and merge decisions, source releases, dependency updates, private
security reports and conduct enforcement. Contributors propose changes through
public issues and pull requests and provide synthetic tests and documentation.
Automation runs checks and offers review findings; it does not replace maintainer
accountability or demonstrate independent human continuity.

Technical decisions are discussed in the relevant issue or pull request. The
maintainer resolves disagreements by reference to the documented scope, evidence,
security and maintenance cost; a contributor may request reconsideration with new
evidence in the same public discussion. Private security/conduct details use the
channels in SECURITY.md and CODE_OF_CONDUCT.md.

Only changes with reviewed evidence and passing required checks are merged, using
the repository's normal GitHub process. No direct production deployment or live
household testing is implied by a merge. Recognitions such as the OpenSSF badge
are linked from README within 48 hours of receipt and kept accurate.

## Continuity limitation

There is no designated backup maintainer and no tested mechanism to restore
repository, CI and release access within one week if the primary maintainer is
unavailable. Bots, this document and account recovery possibilities are not a
substitute. Both access continuity and bus-factor requirements remain unmet.
