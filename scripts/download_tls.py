# SPDX-License-Identifier: MIT
"""Verified TLS contexts for optional strict browser downloads."""

import ssl


def client_context(*, strict=False, cafile=None):
    """Verify TLS and optionally enforce exact full-chain public-key minimums."""
    context = ssl.create_default_context(cafile=cafile)
    context.minimum_version = max(context.minimum_version, ssl.TLSVersion.TLSv1_2)
    if strict:
        if ssl.OPENSSL_VERSION_INFO < (3, 0, 0):
            raise RuntimeError("Strict TLS requires OpenSSL 3 or newer")
        if __package__:
            from .tls_key_policy import enforce_peer_key_policy
        else:
            from tls_key_policy import enforce_peer_key_policy
        context = enforce_peer_key_policy(context)
    return context


def configured_context():
    """Use the same opt-in policy for owned downloads and cloud AI transport."""
    import os

    mode = os.environ.get("HOME_STUDIO_STRICT_TLS", "0")
    if mode not in {"0", "1"}:
        raise ValueError("HOME_STUDIO_STRICT_TLS must be 0 or 1")
    return client_context(strict=mode == "1")


def open_download(url, *, timeout=60):
    """Optionally enforce the documented strict profile on downloads/redirects."""
    import os
    import urllib.parse
    import urllib.request

    mode = os.environ.get('HOME_STUDIO_STRICT_TLS', '0')
    if mode not in {'0', '1'}:
        raise ValueError('HOME_STUDIO_STRICT_TLS must be 0 or 1')
    if mode == '0':
        return urllib.request.urlopen(url, timeout=timeout)
    if urllib.parse.urlsplit(url).scheme != 'https':
        raise ValueError('Strict browser downloads require HTTPS')

    class SecureRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, msg, headers, newurl):
            if urllib.parse.urlsplit(newurl).scheme != 'https':
                raise ValueError('Strict browser downloads reject non-HTTPS redirects')
            return super().redirect_request(request, fp, code, msg, headers, newurl)

    opener = urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=client_context(strict=True)), SecureRedirect())
    return opener.open(url, timeout=timeout)
