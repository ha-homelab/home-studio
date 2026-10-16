# SPDX-License-Identifier: MIT
"""Synthetic real TLS handshakes and client wiring; no network or live keys."""

import datetime
import http.client
import socket
import sys
import threading
import time
import ssl
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
import os
import urllib.request
from urllib.request import HTTPSHandler

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ai_companion import transport
from ai_companion.protocol import CompanionError
from download_tls import client_context, open_download


def certificate(name, key, parent, parent_key, *, ca):
    now = datetime.datetime.now(datetime.UTC)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)])
    builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(parent.subject if parent else subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=7))
        .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(
                (parent_key or key).public_key()
            ),
            critical=False,
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=not ca,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=ca,
                crl_sign=ca,
                encipher_only=None,
                decipher_only=None,
            ),
            critical=True,
        )
    )
    if not ca:
        builder = builder.add_extension(
            x509.SubjectAlternativeName([x509.DNSName("synthetic.test")]),
            critical=False,
        )
    return builder.sign(parent_key or key, hashes.SHA256())


def handshake(client, server, *, hostname="synthetic.test"):
    cin, cout, sin, sout = (ssl.MemoryBIO() for _ in range(4))
    peers = [
        client.wrap_bio(cin, cout, server_hostname=hostname),
        server.wrap_bio(sin, sout, server_side=True),
    ]
    done = [False, False]
    for _ in range(100):
        for i, peer in enumerate(peers):
            if not done[i]:
                try:
                    peer.do_handshake()
                    done[i] = True
                except ssl.SSLWantReadError:
                    # MemoryBIO needs peer bytes; the transfer below resumes the handshake.
                    pass
        for source, target in [(cout, sin), (sout, cin)]:
            data = source.read()
            if data:
                target.write(data)
        if all(done):
            return peers[0].version()
    raise AssertionError("TLS handshake did not finish")


class StrictTlsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.strong = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.weak = rsa.generate_private_key(public_exponent=65537, key_size=2047)

    @unittest.skipUnless(sys.platform == "darwin", "requires native Security framework")
    def test_native_security_framework_uses_exact_rsa_key_bits(self):
        from _darwin_certificate import certificate_key_meets_minimum

        for key, expected in ((self.weak, False), (self.strong, True)):
            with self.subTest(bits=key.key_size):
                der = certificate("native-test", key, None, None, ca=True).public_bytes(
                    serialization.Encoding.DER
                )
                self.assertIs(certificate_key_meets_minimum(der), expected)
        with self.assertRaises(ValueError):
            certificate_key_meets_minimum(b"not a DER certificate")

    def contexts(self, directory, weak_part, version):
        keys = [
            self.weak if part == weak_part else self.strong
            for part in ("root", "intermediate", "leaf")
        ]
        root = certificate("root", keys[0], None, None, ca=True)
        intermediate = certificate("intermediate", keys[1], root, keys[0], ca=True)
        leaf = certificate("synthetic.test", keys[2], intermediate, keys[1], ca=False)
        rootfile, chainfile, keyfile = [
            Path(directory) / x for x in ("root.pem", "chain.pem", "key.pem")
        ]
        rootfile.write_bytes(root.public_bytes(serialization.Encoding.PEM))
        chainfile.write_bytes(
            leaf.public_bytes(serialization.Encoding.PEM)
            + intermediate.public_bytes(serialization.Encoding.PEM)
        )
        keyfile.touch(mode=0o600)
        keyfile.write_bytes(
            keys[2].private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        server = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server.set_ciphers("DEFAULT:@SECLEVEL=0")  # Synthetic weak test peer only.
        server.minimum_version = server.maximum_version = version
        server.load_cert_chain(chainfile, keyfile)
        return client_context(strict=True, cafile=rootfile), server

    def test_real_tls_accepts_strong_chain_and_rejects_every_weak_position(self):
        for version in (ssl.TLSVersion.TLSv1_2, ssl.TLSVersion.TLSv1_3):
            for weak_part in (None, "root", "intermediate", "leaf"):
                with (
                    self.subTest(version=version, weak_part=weak_part),
                    tempfile.TemporaryDirectory() as d,
                ):
                    client, server = self.contexts(d, weak_part, version)
                    if weak_part:
                        with self.assertRaisesRegex(
                            ssl.SSLError, "below the supported security minimum|key too weak"
                        ):
                            handshake(client, server)
                    else:
                        self.assertEqual(
                            handshake(client, server), version.name.replace("_", ".")
                        )

    def test_actual_ai_transport_uses_verified_policy_before_application_data(self):
        for version in (ssl.TLSVersion.TLSv1_2, ssl.TLSVersion.TLSv1_3):
            for weak_part in (None, "root", "intermediate", "leaf"):
                with self.subTest(version=version, weak_part=weak_part), tempfile.TemporaryDirectory() as d:
                    client, server = self.contexts(d, weak_part, version)
                    received = []
                    with socket.socket() as listener:
                        listener.bind(("127.0.0.1", 0))
                        listener.listen(1)
                        listener.settimeout(5)
                        port = listener.getsockname()[1]

                        def serve():
                            peer, _ = listener.accept()
                            peer.settimeout(5)
                            try:
                                with server.wrap_socket(peer, server_side=True) as stream:
                                    received.append(stream.recv(1))
                            except (ssl.SSLError, BrokenPipeError, ConnectionResetError):
                                received.append(b"")
                            finally:
                                peer.close()

                        worker = threading.Thread(target=serve)
                        worker.start()
                        connection = http.client.HTTPConnection("synthetic.test", port)
                        control = transport.RequestControl()
                        address = [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("127.0.0.1", port))]
                        try:
                            with patch.object(transport, "_resolve", return_value=address), patch.object(transport, "configured_context", return_value=client) as factory:
                                if weak_part:
                                    with self.assertRaises(CompanionError):
                                        transport._connect(connection, "synthetic.test", port, True, control, time.monotonic() + 5)
                                else:
                                    transport._connect(connection, "synthetic.test", port, True, control, time.monotonic() + 5)
                                    connection.sock.sendall(b"x")
                                factory.assert_called_once_with()
                        finally:
                            connection.close()
                            control.detach()
                            worker.join(6)
                        self.assertFalse(worker.is_alive())
                        self.assertEqual(received, [b"" if weak_part else b"x"])

    def test_verifies_hostname_and_trust(self):
        with tempfile.TemporaryDirectory() as d:
            client, server = self.contexts(d, None, ssl.TLSVersion.TLSv1_3)
            with self.assertRaises(ssl.SSLCertVerificationError):
                handshake(client, server, hostname="wrong.test")
            with self.assertRaises(ssl.SSLCertVerificationError):
                handshake(client_context(strict=True), server)

    def test_stronger_platform_policy_is_preserved(self):
        context = ssl.create_default_context()
        context.minimum_version = ssl.TLSVersion.TLSv1_3
        context.set_ciphers("ECDHE-RSA-AES256-GCM-SHA384:@SECLEVEL=4")
        with patch(
            "download_tls.ssl.create_default_context", return_value=context
        ):
            actual = client_context(strict=True)
        self.assertEqual(actual.security_level, 4)
        self.assertEqual(actual.minimum_version, ssl.TLSVersion.TLSv1_3)
        self.assertEqual(
            [x["name"] for x in actual.get_ciphers() if x["protocol"] != "TLSv1.3"],
            ["ECDHE-RSA-AES256-GCM-SHA384"],
        )

    def test_real_download_wrapper_requires_https_and_rejects_downgrades(self):
        with patch.dict(os.environ, {'HOME_STUDIO_STRICT_TLS': '1'}):
            with self.assertRaises(ValueError):
                open_download('http://synthetic.test/file')
            opener = Mock()
            with patch('urllib.request.build_opener', return_value=opener) as factory:
                open_download('https://synthetic.test/file')
            handlers = factory.call_args.args
            context = next(x._context for x in handlers if isinstance(x, HTTPSHandler))
            self.assertGreaterEqual(context.security_level, 2)
            redirect = next(x for x in handlers if isinstance(x, urllib.request.HTTPRedirectHandler))
            with self.assertRaises(ValueError):
                redirect.redirect_request(urllib.request.Request('https://synthetic.test'),
                                          None, 302, 'Found', {}, 'http://synthetic.test/file')
            opener.open.assert_called_once_with('https://synthetic.test/file', timeout=60)


if __name__ == '__main__':
    unittest.main()
