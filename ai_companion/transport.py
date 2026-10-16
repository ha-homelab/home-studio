"""One-shot HTTP transport: no proxy inheritance, redirects, retries or tools."""
import http.client
import ipaddress
import socket
import ssl
import threading
import time
from urllib.parse import urlsplit

from .protocol import CompanionError, MAX_UPSTREAM_BYTES, dumps, parse_json
from .providers import normalize_endpoint, request_headers, request_payload, extract_draft

REQUEST_TIMEOUT = 90


class RequestControl:
    """Cancellation owns a socket, never an API key or a request body."""
    def __init__(self):
        self.event = threading.Event()
        self.lock = threading.Lock()
        self.connection = None
        self.socket = None
        self.timed_out = False

    def attach(self, connection):
        with self.lock:
            self.connection = connection
            self.socket = connection.sock
            cancelled = self.event.is_set()
        if cancelled:
            self.cancel()
            self.check()

    def cancel(self, timed_out=False):
        with self.lock:
            self.timed_out = self.timed_out or timed_out
            self.event.set()
            sock, connection = self.socket, self.connection
        if sock:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        if connection:
            connection.close()

    def check(self):
        if self.event.is_set():
            if self.timed_out:
                raise CompanionError("provider_timeout", "Provider request timed out. Retry explicitly if needed.", 504)
            raise CompanionError("cancelled", "Generation was cancelled; its result was discarded.", 409)

    def detach(self):
        with self.lock:
            self.connection = self.socket = None


def _resolve(host, port, control, deadline, local=False):
    """Bound waiting for the OS resolver without inheriting proxy configuration.

    The resolver worker carries no credentials or images. Only one unresolved DNS
    worker may exist at once; slow OS DNS cannot create unbounded resolver threads.
    """
    if not _DNS_SLOT.acquire(blocking=False):
        raise CompanionError("dns_busy", "A previous DNS lookup is still finishing. Retry shortly.", 503)
    result, done = [], threading.Event()

    def resolve():
        try:
            result.append(socket.getaddrinfo(host, port, type=socket.SOCK_STREAM, flags=socket.AI_NUMERICHOST if local else 0))
        except OSError:
            pass
        finally:
            _DNS_SLOT.release()
            done.set()

    threading.Thread(target=resolve, name="ai-dns", daemon=True).start()
    while not done.wait(0.1):
        control.check()
        if time.monotonic() >= deadline:
            control.cancel(timed_out=True)
            control.check()
    control.check()
    if not result or not result[0]:
        raise CompanionError("provider_connection", "Could not resolve the selected provider endpoint.", 502)
    return result[0]


_DNS_SLOT = threading.BoundedSemaphore(1)


def _connect(connection, hostname, port, tls, control, deadline, local=False):
    addresses = _resolve(hostname, port, control, deadline, local)
    for family, kind, protocol, _, address in addresses[:4]:
        control.check()
        if local and not ipaddress.ip_address(address[0]).is_loopback:
            raise CompanionError("endpoint_rejected", "Local resolution was not loopback.", 400)
        sock = socket.socket(family, kind, protocol)
        connection.sock = sock
        control.attach(connection)
        try:
            sock.settimeout(max(0.1, min(10, deadline - time.monotonic())))
            sock.connect(address)
            if local and not ipaddress.ip_address(sock.getpeername()[0]).is_loopback:
                raise CompanionError("endpoint_rejected", "Connected peer was not loopback.", 400)
            if tls:
                # The original fixed hostname remains the TLS identity and Host header.
                connection.sock = ssl.create_default_context().wrap_socket(sock, server_hostname=hostname)
                control.attach(connection)
            connection.sock.settimeout(max(0.1, min(30, deadline - time.monotonic())))
            return
        except (OSError, ssl.SSLError):
            connection.close()
            control.check()
    raise CompanionError("provider_connection", "Could not connect securely to the selected endpoint. Check its address, port, and runtime.", 502)


def generate(profile, model, api_key, endpoint, request, control):
    # Validate again immediately before connecting; credentials never follow a redirect.
    endpoint = normalize_endpoint(profile, endpoint)
    url = urlsplit(endpoint)
    payload = dumps(request_payload(profile, model, request))
    headers = request_headers(profile, api_key)
    deadline = time.monotonic() + REQUEST_TIMEOUT
    connection = http.client.HTTPConnection(url.hostname, url.port or 443, timeout=10)
    timer = threading.Timer(REQUEST_TIMEOUT, lambda: control.cancel(timed_out=True))
    timer.daemon = True
    timer.start()
    response = None
    try:
        control.check()
        _connect(connection, url.hostname, url.port or 443, url.scheme == "https", control, deadline, profile.local)
        control.check()
        connection.auto_open = 0  # Cancellation must never reconnect (or downgrade TLS).
        connection.request("POST", url.path, body=payload, headers=headers)
        response = connection.getresponse()
        control.check()
        if response.status != 200:
            # Do not read or expose raw error bodies: some services reflect prompts/keys.
            status = response.status
            if 300 <= status < 400:
                message = "Provider redirect refused. Credentials were not forwarded."
            elif status in (401, 403):
                message = "Provider rejected authentication or model access. Check this session's key and permissions."
            elif status == 429:
                message = "Provider rate or usage limit reached. Check your account and retry later."
            elif status in (400, 404, 422):
                message = "Provider rejected the selected model, images, or schema. Check model capabilities and endpoint configuration."
            else:
                message = "Provider returned an error. Check the selected service and retry explicitly."
            raise CompanionError("provider_http", message, 502, status)
        if response.getheader("Content-Encoding", "identity").lower() not in ("identity", ""):
            raise CompanionError("provider_encoding", "Compressed provider responses are not accepted.", 502)
        length = response.getheader("Content-Length")
        if length is not None:
            try:
                if not 0 <= int(length) <= MAX_UPSTREAM_BYTES:
                    raise ValueError()
            except ValueError:
                raise CompanionError("provider_size", "Provider response exceeds the allowed size.", 502) from None
        chunks, size = [], 0
        while True:
            control.check()
            chunk = response.read(min(65536, MAX_UPSTREAM_BYTES + 1 - size))
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_UPSTREAM_BYTES:
                raise CompanionError("provider_size", "Provider response exceeds the allowed size.", 502)
            chunks.append(chunk)
        control.check()
        try:
            value = parse_json(b"".join(chunks), MAX_UPSTREAM_BYTES)
        except CompanionError:
            raise CompanionError("invalid_provider_output", "Provider returned invalid response JSON.", 502) from None
        return extract_draft(profile, value)
    except (OSError, http.client.HTTPException) as exc:
        if isinstance(exc, TimeoutError):
            control.cancel(timed_out=True)
        control.check()
        raise CompanionError("provider_connection", "Provider connection failed or timed out. Check the selected service and retry explicitly.", 502) from None
    finally:
        timer.cancel()
        if response:
            response.close()
        connection.close()
        control.detach()
        # Release references. Python does not guarantee physical memory erasure.
        headers.clear()
        payload = b""
