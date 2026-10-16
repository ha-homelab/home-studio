# SPDX-License-Identifier: MIT
"""Verified TLS contexts for optional strict browser downloads."""

import ssl


def client_context(*, strict=False, cafile=None):
    """Keep platform trust and optionally require 128-bit transport security.

    OpenSSL security level 3 rejects RSA/DH keys below 3072 bits (including
    marginal keys rounded by level 2), short EC keys and static RSA exchange.
    Preserve a stronger system policy and its existing cipher selection.
    """
    context = ssl.create_default_context(cafile=cafile)
    context.minimum_version = max(context.minimum_version, ssl.TLSVersion.TLSv1_2)
    if strict:
        if ssl.OPENSSL_VERSION_INFO < (3, 0, 0):
            raise RuntimeError("Strict TLS requires OpenSSL 3 or newer")
        if context.security_level < 3:
            suites = ":".join(
                cipher["name"]
                for cipher in context.get_ciphers()
                if cipher["protocol"] != "TLSv1.3"
            )
            context.set_ciphers(f"{suites}:@SECLEVEL=3")
    return context


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
