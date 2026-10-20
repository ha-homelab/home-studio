#!/usr/bin/env python3
"""Versioned encrypted/signed transport shared by the closed builder and client.

Keys are base64-encoded raw 32-byte Ed25519 or X25519 keys. This module performs
no network I/O and never prints data. Only pinned, independently trusted keys
are accepted; envelope metadata cannot select a trust root.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

SCHEMA = "home-studio-closed-envelope-v1"
MAX_ENVELOPE = 256 * 1024 * 1024
PURPOSES = {"input", "candidate", "diagnostic", "acceptance"}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
                      allow_nan=False).encode("ascii")


def decode_json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate field")
            result[key] = value
        return result
    def invalid(_):
        raise ValueError("invalid number")
    return json.loads(data, object_pairs_hook=unique, parse_constant=invalid)


def b64(data):
    return base64.b64encode(data).decode("ascii")


def unb64(value, length=None):
    if not isinstance(value, str):
        raise ValueError("invalid encoding")
    data = base64.b64decode(value, validate=True)
    if b64(data) != value or (length is not None and len(data) != length):
        raise ValueError("invalid encoding")
    return data


def digest(data):
    return hashlib.sha256(data).hexdigest()


def _derive(private, public, header):
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                info=SCHEMA.encode() + b"\0" + canonical(header)).derive(private.exchange(public))


def seal(data, recipient_key, signing_key, *, purpose):
    if purpose not in PURPOSES or len(data) > MAX_ENVELOPE // 2:
        raise ValueError("invalid envelope payload")
    recipient = X25519PublicKey.from_public_bytes(unb64(recipient_key, 32))
    signer = Ed25519PrivateKey.from_private_bytes(unb64(signing_key, 32))
    ephemeral = X25519PrivateKey.generate()
    header = {"schema": SCHEMA, "purpose": purpose,
              "recipient": digest(recipient.public_bytes_raw()),
              "signer": digest(signer.public_key().public_bytes_raw()),
              "ephemeral": b64(ephemeral.public_key().public_bytes_raw()),
              "nonce": b64(os.urandom(12))}
    ciphertext = AESGCM(_derive(ephemeral, recipient, header)).encrypt(
        unb64(header["nonce"], 12), data, canonical(header))
    signed = {**header, "ciphertext": b64(ciphertext)}
    return canonical({**signed, "signature": b64(signer.sign(canonical(signed)))})


def verify_envelope(data, verify_key, *, purpose):
    """Authenticate ciphertext without access to its recipient's private key."""
    if len(data) > MAX_ENVELOPE or purpose not in PURPOSES:
        raise ValueError("invalid envelope")
    envelope = decode_json(data)
    fields = {"schema", "purpose", "recipient", "signer", "ephemeral", "nonce",
              "ciphertext", "signature"}
    if not isinstance(envelope, dict) or set(envelope) != fields:
        raise ValueError("invalid envelope")
    signer = Ed25519PublicKey.from_public_bytes(unb64(verify_key, 32))
    if (envelope["schema"] != SCHEMA or envelope["purpose"] != purpose
            or envelope["signer"] != digest(signer.public_bytes_raw())):
        raise ValueError("untrusted envelope")
    signed = {key: value for key, value in envelope.items() if key != "signature"}
    signer.verify(unb64(envelope["signature"], 64), canonical(signed))
    return signed


def open_envelope(data, recipient_key, verify_key, *, purpose):
    signed = verify_envelope(data, verify_key, purpose=purpose)
    recipient = X25519PrivateKey.from_private_bytes(unb64(recipient_key, 32))
    if signed["recipient"] != digest(recipient.public_key().public_bytes_raw()):
        raise ValueError("untrusted recipient")
    header = {key: value for key, value in signed.items() if key != "ciphertext"}
    ephemeral = X25519PublicKey.from_public_bytes(unb64(header["ephemeral"], 32))
    return AESGCM(_derive(recipient, ephemeral, header)).decrypt(
        unb64(header["nonce"], 12), unb64(signed["ciphertext"]), canonical(header))
