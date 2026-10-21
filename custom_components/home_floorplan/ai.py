"""Admin-only native AI sessions; secrets and draft input never enter HA storage."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import secrets
import time
from urllib.parse import urlsplit

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.const import EVENT_HOMEASSISTANT_STOP
from homeassistant.core import callback

from .runtime.ai_companion.protocol import (
    CompanionError, MAX_REQUEST_BYTES, dumps, parse_json, reject,
    validate_generate, validate_request_id,
)
from .runtime.ai_companion.providers import PROFILES, UNSUPPORTED, validate_connection
from .runtime.ai_companion.session import Session
from .runtime.ai_companion.transport import RequestControl, generate

DOMAIN = "home_floorplan"
SESSION_TTL = 30 * 60
MAX_SESSIONS = 8
MAX_HTTP_REQUESTS = 12
MAX_CANCELLED_REQUESTS = 256
BODY_TIMEOUT = 15
SMALL_BODY_BYTES = 16 * 1024
SESSION_HEADER = "X-Home-Studio-Session"


@dataclass(repr=False)
class NativeSession(Session):
    user_id: str = ""
    deadline: float = 0
    expiry_handle: object = None


class NativeAI:
    """Loop-owned admission with exactly one shared transport worker at a time."""

    def __init__(self, hass, *, transport=generate, session_ttl=SESSION_TTL):
        self.hass = hass
        self.transport = transport
        self.session_ttl = session_ttl
        self.sessions = {}
        self.http_requests = 0
        self.inference = None
        self.closed = False
        self._stop_listener = hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, self._stop)

    @callback
    def _stop(self, _event):
        self.closed = True
        self.clear()

    def clear(self):
        """Drop keys and cancel work on unload, shutdown, or explicit cleanup."""
        for session in self.sessions.values():
            session.expiry_handle.cancel()
            session.clear()
        self.sessions.clear()

    def _expire(self, token):
        session = self.sessions.pop(token, None)
        if session is not None:
            session.expiry_handle.cancel()
            session.clear()

    def authorize(self, request):
        user = request.get("hass_user")
        if user is None or not request.get("ha_authenticated", False):
            raise CompanionError("unauthorized", "Home Assistant authentication is required.", 401)
        if not user.is_admin or not user.is_active:
            raise CompanionError("unauthorized", "Only a Home Assistant administrator can use AI planning.", 403)
        state = self.hass.data.get(DOMAIN)
        if (self.closed or self.hass.is_stopping or not state or not state.get("initialized")
                or state.get("panels_unloaded") or not state.get("native") or not state.get("has_editor")):
            raise CompanionError("not_loaded", "Native Home Studio is not currently loaded.", 409)
        return user.id

    def new_session(self, user_id):
        for token, session in tuple(self.sessions.items()):
            if session.deadline <= time.monotonic():
                self._expire(token)
        if len(self.sessions) >= MAX_SESSIONS:
            raise CompanionError("session_limit", "Too many open AI sessions. Wait for an existing session to expire.", 503)
        token = secrets.token_urlsafe(32)
        session = NativeSession(expires_at=time.time() + self.session_ttl,
                                deadline=time.monotonic() + self.session_ttl, user_id=user_id)
        session.expiry_handle = asyncio.get_running_loop().call_later(self.session_ttl, self._expire, token)
        self.sessions[token] = session
        return {"session": token, "expires_at": int(session.expires_at)}

    def get_session(self, token, user_id):
        if not isinstance(token, str) or not 1 <= len(token) <= 128:
            raise CompanionError("session_required", "An AI session token is required.", 403)
        session = self.sessions.get(token)
        # A token belonging to another user receives the same answer as an unknown token.
        if session is None or session.user_id != user_id:
            raise CompanionError("session_expired", "This AI session is unavailable. Reload Home Studio and reconnect.", 403)
        if session.deadline <= time.monotonic():
            self._expire(token)
            raise CompanionError("session_expired", "This AI session expired. Reload Home Studio and reconnect.", 403)
        return session

    def _check_epoch(self, session, epoch):
        if session.generation != epoch:
            raise CompanionError("session_changed", "The AI session changed while this request was pending. Try again explicitly.", 409)

    def connect(self, session, body, epoch):
        profile, model, key, endpoint = validate_connection(body)
        self._check_epoch(session, epoch)
        session.clear()
        session.profile, session.model = profile, model
        session.api_key, session.endpoint = key, endpoint
        return session.public()

    def cancel(self, session, body, *, disconnect=False):
        if not isinstance(body, dict) or set(body) - {"request_id"}:
            reject("Unexpected cancellation fields.")
        request_id = validate_request_id(body["request_id"]) if "request_id" in body else None
        if disconnect:
            session.clear()
            return {"connected": False}
        if request_id is None:
            session.generation += 1
            if session.pending:
                session.pending.cancel()
        else:
            if request_id not in session.cancelled_request_ids and len(session.cancelled_request_ids) >= MAX_CANCELLED_REQUESTS:
                session.clear()
                raise CompanionError("cancellation_limit", "Cancellation limit reached; reconnect explicitly.", 409)
            session.cancelled_request_ids.add(request_id)
            if request_id == session.pending_request_id and session.pending:
                session.pending.cancel()
        return {"cancelled": True}

    async def run(self, session, body, epoch):
        request = validate_generate(body)
        self._check_epoch(session, epoch)
        if request["request_id"] in session.cancelled_request_ids:
            raise CompanionError("cancelled", "Generation was cancelled before admission; no data was sent.", 409)
        if not session.profile:
            raise CompanionError("not_connected", "Connect a provider before generating a draft.", 409)
        if self.inference is not None:
            raise CompanionError("busy", "A generation is already running. Wait or cancel it before retrying.", 409)
        control = RequestControl()
        session.pending, session.pending_request_id = control, request["request_id"]
        # No credentials are copied into HA events, background task names, or logs.
        future = self.hass.async_add_executor_job(self.transport, session.profile, session.model,
                                                  session.api_key, session.endpoint, request, control)
        self.inference = future

        def completed(done):
            if self.inference is done:
                self.inference = None
            if session.pending is control:
                session.pending, session.pending_request_id = None, ""
            # Consume late failures after a client disconnect without logging them.
            if not done.cancelled():
                done.exception()

        future.add_done_callback(completed)
        try:
            result = await asyncio.shield(future)
            control.check()
            self._check_epoch(session, epoch)
            if session.deadline <= time.monotonic():
                session.clear()
                raise CompanionError("cancelled", "The AI session expired; its late draft was discarded.", 409)
            return result
        except asyncio.CancelledError:
            # Shield preserves the global slot until the actual worker exits.
            control.cancel()
            raise
        finally:
            if future.done():
                completed(future)


class NativeAIView(HomeAssistantView):
    url = "/api/home_floorplan/ai/{action}"
    name = "api:home_floorplan:ai"
    requires_auth = True
    cors_allowed = False

    def __init__(self, manager):
        self.manager = manager

    async def get(self, request, action):
        return await self._dispatch(request, action, mutation=False)

    async def post(self, request, action):
        return await self._dispatch(request, action, mutation=True)

    @staticmethod
    def _response(value, status=200):
        # Avoid HA's JSON error logger, which can include unserializable values.
        return web.Response(body=dumps(value), status=status, content_type="application/json", headers={
            "Cache-Control": "no-store, max-age=0", "Pragma": "no-cache",
            "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
        })

    @staticmethod
    def _boundary(request):
        if request.query_string:
            reject("AI API query parameters are not accepted.")
        if request.headers.get("Sec-Fetch-Site") not in (None, "same-origin", "none"):
            raise CompanionError("origin_rejected", "Use AI planning from the Home Studio panel.", 403)
        origins = request.headers.getall("Origin", [])
        if origins:
            if len(origins) != 1:
                reject("Unexpected Origin headers.")
            origin = urlsplit(origins[0])
            if (origin.scheme not in ("http", "https") or origin.netloc != request.host
                    or origin.path or origin.query or origin.fragment or origin.username or origin.password):
                raise CompanionError("origin_rejected", "Use AI planning from the Home Studio panel.", 403)
        if request.headers.get("Content-Encoding", "identity") != "identity" or request.headers.getall("Transfer-Encoding", []):
            reject("Encoded or chunked AI requests are not accepted.")

    @staticmethod
    async def _body(request, maximum):
        if request.content_length is None or request.content_length > maximum:
            raise CompanionError("request_size", "AI request exceeds the allowed size or has no explicit length.", 413)
        if request.content_type != "application/json":
            raise CompanionError("content_type", "Use application/json.", 415)
        data = bytearray()
        try:
            async with asyncio.timeout(BODY_TIMEOUT):
                async for chunk in request.content.iter_chunked(65536):
                    if len(data) + len(chunk) > maximum:
                        raise CompanionError("request_size", "AI request exceeds the allowed size.", 413)
                    data.extend(chunk)
        except TimeoutError:
            raise CompanionError("request_timeout", "AI request body timed out.", 408) from None
        if len(data) != request.content_length:
            reject("Incomplete AI request body.")
        return parse_json(bytes(data), maximum)

    async def _dispatch(self, request, action, *, mutation):
        manager = self.manager
        admitted = False
        try:
            user_id = manager.authorize(request)
            self._boundary(request)
            allowed = {"session", "connect", "disconnect", "close", "cancel", "generate"} if mutation else {"providers", "status"}
            if action not in allowed:
                raise CompanionError("not_found", "Unknown AI API route.", 404)
            if manager.http_requests >= MAX_HTTP_REQUESTS:
                raise CompanionError("busy", "Too many AI requests are pending. Try again shortly.", 503)
            manager.http_requests += 1
            admitted = True
            session, token, epoch = None, None, None
            if action != "session":
                tokens = request.headers.getall(SESSION_HEADER, [])
                if len(tokens) != 1:
                    raise CompanionError("session_required", "An AI session token is required.", 403)
                token = tokens[0]
                session = manager.get_session(token, user_id)
                epoch = session.generation
            if mutation:
                body = await self._body(request, MAX_REQUEST_BYTES if action == "generate" else SMALL_BODY_BYTES)
                # Permissions, unload, expiry, and connection changes can occur during upload.
                if manager.authorize(request) != user_id:
                    raise CompanionError("unauthorized", "Home Assistant authentication changed.", 403)
                if session is not None:
                    manager.get_session(token, user_id)
                if action == "session":
                    if body != {}:
                        reject("Session creation requires an empty JSON object.")
                    result = manager.new_session(user_id)
                elif action == "close":
                    if body != {}:
                        reject("Session closure requires an empty JSON object.")
                    manager._expire(token)
                    result = {"connected": False}
                elif action == "connect":
                    result = manager.connect(session, body, epoch)
                elif action in ("cancel", "disconnect"):
                    result = manager.cancel(session, body, disconnect=action == "disconnect")
                else:
                    result = await manager.run(session, body, epoch)
                    manager.authorize(request)
                    manager.get_session(token, user_id)
            else:
                if request.content_length not in (None, 0):
                    reject("GET request bodies are not accepted.")
                result = ({"providers": [profile.public() for profile in PROFILES.values()], "unsupported": UNSUPPORTED}
                          if action == "providers" else session.public())
            return self._response(result)
        except CompanionError as error:
            return self._response(error.public(), error.status)
        except Exception:
            # Do not expose or log request bodies, credentials, or upstream exceptions.
            return self._response({"error": {"code": "internal_error", "message": "AI planning could not complete this request."}}, 500)
        finally:
            if admitted:
                manager.http_requests -= 1
