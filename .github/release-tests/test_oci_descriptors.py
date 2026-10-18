"""OCI reader owns raw descriptors even when archive setup fails."""
import errno
import importlib.util
import os
import tempfile
import unittest
from contextlib import ExitStack, suppress
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location(
    "oci_descriptor_reader", Path(__file__).resolve().parents[2] / "scripts/merge_oci_archives.py"
)
oci = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(oci)


class DescriptorOwnershipTests(unittest.TestCase):
    def test_fdopen_failure_closes_raw_descriptor(self):
        descriptors = []

        def fail(descriptor, *_args, **_kwargs):
            descriptors.append(descriptor)
            raise OSError("cannot wrap descriptor")

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.tar"
            source.write_bytes(b"not a tar archive")
            try:
                with self.assertRaisesRegex(OSError, "cannot wrap descriptor"):
                    with ExitStack() as stack, mock.patch.object(oci.os, "fdopen", side_effect=fail):
                        oci.Archive(source, "linux/amd64", "1.0.0", "a" * 40, stack)
                self.assertEqual(len(descriptors), 1)
                with self.assertRaises(OSError) as raised:
                    os.fstat(descriptors[0])
                self.assertEqual(raised.exception.errno, errno.EBADF)
            finally:
                for descriptor in descriptors:
                    with suppress(OSError):
                        os.close(descriptor)

    def test_invalid_tar_closes_wrapper_and_descriptor(self):
        wrappers = []
        real_fdopen = os.fdopen

        def observe(descriptor, *args, **kwargs):
            stream = real_fdopen(descriptor, *args, **kwargs)
            wrappers.append((descriptor, stream))
            return stream

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.tar"
            source.write_bytes(b"not a tar archive")
            with self.assertRaises(oci.tarfile.ReadError):
                with ExitStack() as stack, mock.patch.object(oci.os, "fdopen", side_effect=observe):
                    oci.Archive(source, "linux/amd64", "1.0.0", "a" * 40, stack)
            self.assertEqual(len(wrappers), 1)
            descriptor, stream = wrappers[0]
            self.assertTrue(stream.closed)
            with self.assertRaises(OSError) as raised:
                os.fstat(descriptor)
            self.assertEqual(raised.exception.errno, errno.EBADF)
