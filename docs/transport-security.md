# Transport security profiles

The floor-plan editor/compiler can process local fictional or private project
files without contacting Home Assistant. Browser/HA account security remains
owned by the browser and Home Assistant. Do not publish private project exports.

The owned native Firefox/Waterfox and Chrome-for-Testing download helpers support
`HOME_STUDIO_STRICT_TLS=1`. With Python linked to OpenSSL 3 or newer, this profile
requires HTTPS (including redirects), verifies the certificate chain and hostname,
requires TLS 1.2 or newer and OpenSSL security level at least 3. A stronger host
policy is preserved. Security level 3 requires 128-bit strength (including RSA/DH
at least 3072 bits) and rejects static RSA exchange. A vendor endpoint that cannot
meet this profile fails closed; do not disable certificate checks to proceed.

```sh
HOME_STUDIO_STRICT_TLS=1 python3 scripts/setup-chrome-for-testing.py \
  --version REVIEWED_VERSION --output /private/browser-test
```

The download still checks the exact pinned SHA-256/SHA-512 inventory and size/time
bounds before extraction. The default mode retains platform TLS compatibility.
Synthetic tests perform real TLS1.2/TLS1.3 handshakes, accepting strong chains and
rejecting a 2047-bit root, intermediate or leaf key, untrusted roots and wrong
hostnames. Wrapper tests reject plaintext origins and redirect downgrades.

The release helpers separately invoke GitHub CLI. Use the verified GitHub CLI
2.102.0 / Go1.27.1 profile with `GH_HOST=github.com GODEBUG=fips140=on` for owned
release-helper commands. This preserves TLS1.2/1.3, certificate/hostname validation
and a full-chain minimum of RSA2048 or supported modern elliptic keys. The shared
[reviewed runtime evidence](https://github.com/victron-venus/integration-tests/blob/232df66ba8ec59019ee5444090212f256a88b7e6/docs/release-tls-profile.md)
contains the exact qualification; this project does not claim another local Go
weak-chain experiment. Other CLI/runtime versions and custom endpoints require
separate qualification. Standard package managers, browser engines and Git/SSH
remain separately maintained prerequisite tools.

No project-owned user-password verifier database or custom cryptographic primitive
is implemented. Outbound Home Assistant credentials and browser-local project
storage must remain private. These profiles do not establish that every external
runtime or legacy protocol is free of weaknesses.

Transport probes on 2026-10-16 accepted the pinned Chrome 153.0.8010.52 and Waterfox 6.7.5 Linux download endpoints under the strict profile. Firefox 158.0's endpoint presented a key below this stricter 128-bit policy and was rejected. This is a compatibility limit, not permission to disable verification. These probes read one byte and establish transport interoperability only; normal installation still verifies the complete archive digest.
