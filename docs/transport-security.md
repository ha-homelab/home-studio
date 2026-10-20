# Transport security profiles

The optional standalone floor-plan editor/compiler can process local fictional
or private project files without contacting Home Assistant. The recommended
[native workflow](home-assistant-editor.md) uses your authenticated HA session;
the strict transport profile below is for developer tools and the AI companion.
Browser/HA account security remains owned by the browser and Home Assistant. Do not publish private project exports.

The owned native Firefox/Waterfox and Chrome-for-Testing download helpers, and
the optional AI companion's cloud transport, support `HOME_STUDIO_STRICT_TLS=1`.
This profile requires CPython 3.11+ and OpenSSL 3. It preserves ordinary hostname
and certificate verification, requires TLS1.2+, and checks every certificate in
the verified chain (including its trust anchor) before application data is sent.
RSA keys must be at least 2048 bits, EC keys 224 bits, and DSA parameters
2048/224 bits; Ed25519 and Ed448 are accepted. Unknown key types or inaccessible
verified chains fail closed. OpenSSL security level at least2 supplies the
algorithm floor; the extra exact-key check rejects RSA2047 keys that OpenSSL
can otherwise round into that level. Stronger host policy is preserved.

For the strict runtime profile, install `requirements-strict-tls.txt` in an
isolated environment. Its platform marker excludes the cryptography package on
Intel macOS; that platform uses the native Security framework to inspect RSA/EC
metadata without replacing OpenSSL trust verification. Linux and Apple silicon
macOS use cryptography. Source and license attribution appear in
[third-party notices](../THIRD_PARTY_NOTICES.md).

The synthetic fixture suite separately requires `requirements-tls-test.txt` and
is qualified on Linux and Apple silicon macOS. The native Security-framework
RSA2047 rejection/RSA2048 acceptance is also exercised directly on Apple silicon.
No Intel macOS execution is claimed by those results; Intel qualification remains
pending. The runtime dependency marker avoids requiring an unavailable current
Intel wheel.

```sh
python3 -m pip install -r requirements-strict-tls.txt
HOME_STUDIO_STRICT_TLS=1 python3 scripts/setup-chrome-for-testing.py \
  --version REVIEWED_VERSION --output /private/browser-test
HOME_STUDIO_STRICT_TLS=1 python3 scripts/serve-ai-planner.py
```

Browser download redirects must remain HTTPS and retain the same verified
handler; complete archives still require their pinned SHA-256/SHA-512 before
extraction. AI cloud destinations remain fixed by the selected provider profile,
redirects are refused, and cancellation, bounded responses and session cleanup
are retained. The separate local-model option uses a numeric loopback address
and carries no cloud provider key; it does not become a remote HTTP endpoint.

Synthetic tests exercise exact RSA2048 acceptance and RSA2047 rejection in the
root, intermediate and leaf for TLS1.2/1.3, plus trust and hostname failures.
They also run the actual AI connection function against a synthetic TLS server,
proving rejected chains receive no application bytes. On 2026-10-16, one-byte
transport probes succeeded for the pinned Chrome153.0.8010.52, Firefox158.0 and
Waterfox6.7.5 Linux archives. Strict TLS handshakes also succeeded for the fixed
OpenAI, Anthropic and xAI hostnames without sending any HTTP request, API key,
user data or inference call. These checks establish transport interoperability;
they do not test paid inference or certify every provider/model.

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

The default transport mode retains ordinary platform TLS compatibility. Use the strict profile when the documented full-chain minimum is required. No failed certificate check falls back to plaintext or disables verification.
