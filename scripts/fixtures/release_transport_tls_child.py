"""Test-only loopback connector; retain the production HTTPS host and path."""
import http.client
import importlib.util
import json
import os
from pathlib import Path
import socket
import ssl
import sys
import time
import traceback
import urllib.request


source, data_fd, result_fd, port, ca_path, metrics_path, mode, *hosts = sys.argv[1:]
expected_host = hosts[0] if hosts else "storage.invalid"
assert len(hosts) <= 1
spec = importlib.util.spec_from_file_location("release_transport_fixture", source)
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)
metrics = {"pid": os.getpid(), "connections": 0, "reads": 0, "closes": 0, "phase": "start"}


def record():
    fd = os.open(metrics_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(metrics, stream)


class Response(http.client.HTTPResponse):
    def read(self, *args, **kwargs):
        metrics["reads"] += 1
        record()
        return super().read(*args, **kwargs)

    def close(self):
        metrics["closes"] += 1
        metrics["phase"] = "close"
        record()
        if mode == "close":
            time.sleep(60)
        if mode == "close-error":
            raise RuntimeError("FICTIONAL_RELEASE_TRANSPORT_PRIVATE_MARKER")
        return super().close()


class Connection(http.client.HTTPSConnection):
    response_class = Response

    def __init__(self, host, *args, **kwargs):
        super().__init__(host, *args, **kwargs)
        assert self.host == expected_host and self.port == 443
        self._context = ssl.create_default_context(cafile=ca_path)

        def dial(address, timeout=None, source_address=None):
            assert address == (expected_host, 443)
            metrics["connections"] += 1
            metrics["phase"] = "dns"
            record()
            if mode == "dns":
                def blocked(*args, **kwargs):
                    time.sleep(60)
                socket.getaddrinfo = blocked
            return socket.create_connection(("127.0.0.1", int(port)), timeout, source_address)

        self._create_connection = dial


def https_open(handler, request):
    return handler.do_open(Connection, request, context=handler._context)


urllib.request.HTTPSHandler.https_open = https_open
record()
if mode == "descendant":
    child = os.fork()
    if child == 0:
        while True:
            time.sleep(1)
    metrics["descendant_pid"] = child
    metrics["phase"] = "descendant"
    record()
    time.sleep(60)
if mode == "noise":
    print("FICTIONAL_RELEASE_TRANSPORT_PRIVATE_MARKER", flush=True)
    print("FICTIONAL_RELEASE_TRANSPORT_PRIVATE_MARKER", file=sys.stderr, flush=True)
try:
    transport._child_main(int(data_fd), int(result_fd))
except BaseException as error:
    metrics["error_type"] = type(error).__name__
    metrics["error_frames"] = [[Path(frame.filename).name, frame.name, frame.lineno]
                               for frame in traceback.extract_tb(error.__traceback__)]
    record()
    raise SystemExit(1)
