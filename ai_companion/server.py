"""Loopback-only companion with isolated, expiring page sessions."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import mimetypes
from pathlib import Path, PurePosixPath
import secrets
import re
import socket
import threading
import time
import webbrowser

from .protocol import CompanionError, MAX_REQUEST_BYTES, dumps, parse_json, reject, validate_generate, validate_request_id
from .providers import PROFILES, UNSUPPORTED, validate_connection
from .transport import RequestControl, generate
from .session import Session

SESSION_TTL = 30 * 60
MAX_SESSIONS = 8
MAX_CANCELLED_REQUESTS = 256
CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
WORKER_CSP = "default-src 'none'; script-src 'self'; connect-src 'none'; img-src blob:"


class CompanionServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 8

    def __init__(self, address, root, *, assets=None, transport=generate, session_ttl=SESSION_TTL):
        host, port = address
        try:
            ip = ipaddress.ip_address(host)
            if not ip.is_loopback or "%" in host:
                raise ValueError()
        except ValueError:
            raise ValueError("Companion host must be a numeric loopback address.") from None
        self.address_family = socket.AF_INET6 if ip.version == 6 else socket.AF_INET
        self.root = Path(root).resolve()
        if assets is None:
            assets = parse_json((self.root / "ai_companion/assets.json").read_bytes(), 1024 * 1024)
        if not isinstance(assets, list) or not all(isinstance(p, str) for p in assets):
            raise ValueError("Companion asset allowlist must be an array of relative paths.")
        self.assets = frozenset(assets)
        for name in self.assets:
            path = PurePosixPath(name)
            if path.is_absolute() or any(p in (".", "..") for p in name.split("/")) or "\\" in name:
                raise ValueError("Unsafe companion asset allowlist entry.")
            full = self.root / name
            if full.resolve() != full or not full.is_file():
                raise ValueError("Companion allowlist contains a missing file or symlink: " + name)
        if "planner/index.html" not in self.assets:
            raise ValueError("The reviewed planner entry point is missing from the allowlist.")
        self.sessions = {}
        self.sessions_lock = threading.Lock()
        self.session_ttl = session_ttl
        self.transport = transport
        self.inference_slot = threading.BoundedSemaphore(1)
        self.http_slots = threading.BoundedSemaphore(12)
        super().__init__((str(ip), port), CompanionHandler)
        host_for_url = f"[{ip}]" if ip.version == 6 else str(ip)
        self.authority = f"{host_for_url}:{self.server_address[1]}"
        self.origin = "http://" + self.authority

    def process_request(self, request, client_address):
        if not self.http_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.http_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.http_slots.release()

    def handle_error(self, request, client_address):
        # No tracebacks containing request payloads, keys, or headers.
        pass

    def service_actions(self):
        self.expire_sessions()

    def expire_sessions(self):
        now = time.time()
        with self.sessions_lock:
            expired = [token for token, session in self.sessions.items() if session.expires_at <= now]
            for token in expired:
                self.sessions.pop(token).clear()

    def new_session(self):
        self.expire_sessions()
        with self.sessions_lock:
            if len(self.sessions) >= MAX_SESSIONS:
                raise CompanionError("session_limit", "Too many open planner sessions. Close the companion and restart it, or wait for session expiry.", 503)
            token = secrets.token_urlsafe(32)
            self.sessions[token] = Session(time.time() + self.session_ttl)
            return token

    def get_session(self, token):
        self.expire_sessions()
        if not token or len(token) > 128:
            raise CompanionError("session_required", "Open the planner from this companion to start a session.", 403)
        with self.sessions_lock:
            # Tokens are unguessable dictionary keys, separate from provider credentials.
            session = self.sessions.get(token)
        if session is None:
            raise CompanionError("session_expired", "This planner session has expired. Reload the planner and reconnect.", 403)
        return session

    def server_close(self):
        with self.sessions_lock:
            for session in self.sessions.values():
                session.clear()
            self.sessions.clear()
        super().server_close()


class CompanionHandler(BaseHTTPRequestHandler):
    server_version = "HomeStudioCompanion"
    sys_version = ""
    protocol_version = "HTTP/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def handle(self):
        # A socket inactivity timeout alone cannot stop slow header drips.
        self._header_timer = threading.Timer(15, self._abort_connection)
        self._header_timer.daemon = True
        self._header_timer.start()
        try:
            super().handle()
        finally:
            self._header_timer.cancel()

    def parse_request(self):
        try:
            return super().parse_request()
        finally:
            self._header_timer.cancel()

    def _abort_connection(self):
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def log_message(self, *_):
        pass

    def send_error(self, code, message=None, explain=None):
        # BaseHTTPRequestHandler's default error page reflects raw request paths.
        self._json(code, {"error": {"code": "http_error", "message": "Request was rejected."}})

    def _reply(self, code, data, content_type="application/json; charset=utf-8", *, csp=CSP, headers=None):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Content-Security-Policy", csp)
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header("Connection", "close")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)
        self.close_connection = True

    def _json(self, code, value):
        self._reply(code, dumps(value))

    def _check_boundary(self, mutation=False):
        if self.headers.get_all("Host", []) != [self.server.authority]:
            raise CompanionError("host_rejected", "Unexpected Host header.", 403)
        origins = self.headers.get_all("Origin", [])
        if (mutation and origins != [self.server.origin]) or (origins and origins != [self.server.origin]):
            raise CompanionError("origin_rejected", "Only this companion's origin may access the request.", 403)
        fetch_site = self.headers.get("Sec-Fetch-Site")
        if fetch_site not in (None, "same-origin", "none"):
            raise CompanionError("origin_rejected", "Cross-origin requests are not accepted.", 403)
        if self.headers.get("Sec-Fetch-Dest") in ("iframe", "frame", "object", "embed"):
            raise CompanionError("origin_rejected", "Embedded planner requests are not accepted.", 403)
        if len(str(self.headers)) > 16384:
            reject("Request headers exceed the limit.")
        if "?" in self.path:
            path, query = self.path.split("?", 1)
            if path.startswith("/api/") or not re.fullmatch(r"lang=[A-Za-z]{2}(?:-[A-Za-z]{2,8})?", query):
                reject("Only a language query is accepted on static pages.")
            self.path = path
        if not self.path.startswith("/") or self.path.startswith("//") or any(c in self.path for c in ("%", "?", "#", "\\")) or any(p in (".", "..") for p in self.path.split("/")):
            reject("Unexpected request path.")
        if self.headers.get_all("Transfer-Encoding") or self.headers.get("Content-Encoding", "identity") != "identity":
            reject("Encoded or chunked request bodies are not accepted.")

    def _session(self):
        tokens = self.headers.get_all("X-Home-Studio-Session", [])
        if len(tokens) != 1:
            raise CompanionError("session_required", "A planner session token is required.", 403)
        return self.server.get_session(tokens[0])

    def _body(self):
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1 or not lengths[0].isdigit():
            reject("An explicit Content-Length is required.")
        length = int(lengths[0])
        if length > MAX_REQUEST_BYTES:
            raise CompanionError("request_size", "Request exceeds the allowed size.", 413)
        types = self.headers.get_all("Content-Type", [])
        if len(types) != 1 or types[0].lower().replace(" ", "") not in ("application/json", "application/json;charset=utf-8"):
            raise CompanionError("content_type", "Use application/json.", 415)
        def stop_reading():
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        timer = threading.Timer(15, stop_reading)
        timer.daemon = True
        timer.start()
        try:
            data = self.rfile.read(length)
        finally:
            timer.cancel()
        if len(data) != length:
            reject("Incomplete request body.")
        return parse_json(data)

    def do_GET(self):
        self._dispatch(False)

    def do_POST(self):
        self._dispatch(True)

    def _dispatch(self, mutation):
        try:
            self._check_boundary(mutation)
            if mutation:
                session = self._session()
                with session.lock:
                    connection_epoch = session.generation
                body = self._body()
                self._post(session, body, connection_epoch)
            else:
                self._get()
        except CompanionError as exc:
            self._json(exc.status, exc.public())
        except (BrokenPipeError, ConnectionResetError, TimeoutError, socket.timeout):
            pass
        except Exception:
            # Never reflect an arbitrary exception or data from the upstream provider.
            self._json(500, {"error": {"code": "internal_error", "message": "The companion could not complete this request."}})

    def _get(self):
        if self.headers.get("Content-Length") not in (None, "0"):
            reject("GET request bodies are not accepted.")
        if self.path.startswith("/api/"):
            session = self._session()
            if self.path == "/api/ai/providers":
                self._json(200, {"providers": [p.public() for p in PROFILES.values()], "unsupported": UNSUPPORTED})
            elif self.path == "/api/ai/status":
                self._json(200, session.public())
            else:
                self._json(404, {"error": {"code": "not_found", "message": "Unknown API route."}})
            return
        if self.path in ("/", "/planner"):
            self._reply(302, b"", headers={"Location": "/planner/"})
            return
        name = "planner/index.html" if self.path == "/planner/" else self.path.lstrip("/")
        if name not in self.server.assets:
            raise CompanionError("not_found", "This asset is not in the reviewed companion allowlist.", 404)
        path = self.server.root / name
        if path.resolve() != path or not path.is_file() or path.stat().st_size > 24 * 1024 * 1024:
            raise CompanionError("not_found", "Reviewed asset is unavailable.", 404)
        data = path.read_bytes()
        if name == "planner/index.html":
            token = self.server.new_session()
            html = data.decode("utf-8")
            if "connect-src 'none'" not in html or "</head>" not in html or "</body>" not in html:
                raise CompanionError("invalid_entry", "The planner entry point does not match the companion's safety checks.", 500)
            html = html.replace("connect-src 'none'", "connect-src 'self'; worker-src 'self'", 1)
            html = html.replace("</head>", f'<meta name="home-studio-ai-session" content="{token}">\n</head>', 1)
            html = html.replace("</body>", '<script type="module" src="/ai/bootstrap.js"></script>\n</body>', 1)
            data = html.encode("utf-8")
        mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
        self._reply(200, data, mime, csp=WORKER_CSP if name == "ai/photo-worker.js" else CSP)

    def _post(self, session, body, connection_epoch):
        if self.path == "/api/ai/connect":
            profile, model, key, endpoint = validate_connection(body)
            if endpoint.startswith(self.server.origin + "/"):
                reject("The companion itself is not a model endpoint.")
            with session.lock:
                if session.generation != connection_epoch or session.expires_at <= time.time():
                    raise CompanionError("session_changed", "Connection settings changed while this request was pending. Reconnect explicitly.", 409)
                session.clear()
                session.profile, session.model = profile, model
                session.api_key, session.endpoint = key, endpoint
            self._json(200, session.public())
        elif self.path in ("/api/ai/cancel", "/api/ai/disconnect"):
            if not isinstance(body, dict) or set(body) - {"request_id"}:
                reject("Unexpected cancellation fields.")
            request_id = validate_request_id(body["request_id"]) if "request_id" in body else None
            with session.lock:
                if self.path.endswith("disconnect"):
                    session.clear()
                elif request_id is None:
                    # An unscoped cancellation also invalidates bodies still arriving.
                    session.generation += 1
                    if session.pending:
                        session.pending.cancel()
                else:
                    # A matching body may not have finished reading yet. Remember the
                    # cancellation until the connection changes; never evict a live ID.
                    if request_id not in session.cancelled_request_ids and len(session.cancelled_request_ids) >= MAX_CANCELLED_REQUESTS:
                        session.clear()
                        raise CompanionError("cancellation_limit", "Cancellation limit reached; the session was disconnected. Reconnect explicitly.", 409)
                    session.cancelled_request_ids.add(request_id)
                    if request_id == session.pending_request_id and session.pending:
                        session.pending.cancel()
            self._json(200, {"cancelled": True} if self.path.endswith("cancel") else {"connected": False})
        elif self.path == "/api/ai/generate":
            request = validate_generate(body)
            if not self.server.inference_slot.acquire(blocking=False):
                raise CompanionError("busy", "A generation is already running. Wait or cancel it before retrying.", 409)
            control = RequestControl()
            try:
                with session.lock:
                    # Bind admission to the session that accepted the request headers,
                    # not whichever provider happens to be selected after body upload.
                    if session.expires_at <= time.time():
                        session.clear()
                        raise CompanionError("session_expired", "This planner session has expired. Reload the planner and reconnect.", 403)
                    if session.generation != connection_epoch:
                        raise CompanionError("session_changed", "The session changed while this request was arriving. Generate a fresh draft explicitly.", 409)
                    if request["request_id"] in session.cancelled_request_ids:
                        raise CompanionError("cancelled", "Generation was cancelled before admission; its data was not sent to a provider.", 409)
                    if not session.profile:
                        raise CompanionError("not_connected", "Connect a provider before generating a draft.", 409)
                    session.pending = control
                    session.pending_request_id = request["request_id"]
                    epoch = session.generation
                    profile, model, key, endpoint = session.profile, session.model, session.api_key, session.endpoint
                result = self.server.transport(profile, model, key, endpoint, request, control)
                with session.lock:
                    control.check()
                    if session.expires_at <= time.time() or epoch != session.generation:
                        raise CompanionError("cancelled", "The session changed; this late draft was discarded.", 409)
                    self._json(200, result)
            finally:
                with session.lock:
                    if session.pending is control:
                        session.pending = None
                        session.pending_request_id = ""
                self.server.inference_slot.release()
        else:
            raise CompanionError("not_found", "Unknown API route.", 404)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run the optional Home Studio AI planner on loopback. Keys remain in session memory.")
    parser.add_argument("--host", default="127.0.0.1", help="Numeric loopback address only (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8099, help="Local port (default: 8099)")
    parser.add_argument("--no-browser", action="store_true", help="Do not open the planner automatically")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    try:
        server = CompanionServer((args.host, args.port), Path(__file__).resolve().parents[1])
    except (OSError, ValueError, CompanionError):
        parser.error("Cannot start the companion. Check numeric loopback, port availability, and the reviewed assets; try --port 8100 if needed.")
    print(f"Home Studio AI planner: {server.origin}/planner/", flush=True)
    print("Keys stay in page-session memory for at most 30 minutes. Ctrl+C stops the companion and clears sessions.", flush=True)
    if not args.no_browser:
        webbrowser.open(server.origin + "/planner/")
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0
