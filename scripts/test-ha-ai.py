#!/usr/bin/env python3
"""Exercise packaged native AI with real HA users/APIs and a local recording transport."""
from __future__ import annotations

import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import make_mocked_request
from homeassistant import auth
from homeassistant.auth.const import GROUP_ID_ADMIN, GROUP_ID_USER
from homeassistant.core import HomeAssistant
from homeassistant.helpers.http import request_handler_factory
from homeassistant.helpers import area_registry, device_registry, entity_registry, floor_registry
from multidict import CIMultiDict

ROOT = Path(__file__).resolve().parents[1]


def load(name, path, package=False):
    spec = importlib.util.spec_from_file_location(name, path, submodule_search_locations=[str(path.parent)] if package else None)
    result = importlib.util.module_from_spec(spec)
    sys.modules[name] = result
    spec.loader.exec_module(result)
    return result


class Body:
    def __init__(self, data, gate=None, started=None):
        self.data, self.gate, self.started = data, gate, started

    async def iter_chunked(self, size):
        if self.started:
            self.started.set()
        if self.gate:
            await self.gate.wait()
        for index in range(0, len(self.data), size):
            yield self.data[index:index + size]


class Request(dict):
    def __init__(self, user, body=b'{}', token=None, *, authenticated=True, headers=None, gate=None, started=None):
        super().__init__(hass_user=user, ha_authenticated=authenticated)
        self.headers = CIMultiDict(headers or {})
        if token:
            self.headers['X-Home-Studio-Session'] = token
        self.content_length = len(body)
        self.content_type = 'application/json'
        self.content = Body(body, gate, started)
        self.query_string = ''
        self.host = 'localhost:8123'


def payload(request_id='draft_1'):
    return {'request_id': request_id, 'mode': 'new_room', 'context': {}, 'instructions': 'A small room',
            'images': [], 'schema': {'type': 'object'}}


class NativeAITests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.package_temp = tempfile.TemporaryDirectory(prefix='studio-ai-package-')
        cls.component = Path(cls.package_temp.name) / 'home_floorplan'
        builder = load('ai_bundle_builder', ROOT / 'scripts/build-home-studio.py')
        builder.bundle_component(ROOT, cls.component)
        cls.integration = load('studio_ai_package', cls.component / '__init__.py', True)
        cls.ai = __import__('studio_ai_package.ai', fromlist=['NativeAI'])

    @classmethod
    def tearDownClass(cls):
        cls.package_temp.cleanup()

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='studio-ai-config-')
        self.hass = HomeAssistant(self.temp.name)
        device_registry.async_setup(self.hass)
        await asyncio.gather(*(registry.async_load(self.hass) for registry in
                               (area_registry, device_registry, entity_registry, floor_registry)))
        self.hass.auth = await auth.auth_manager_from_config(self.hass, [], [])
        self.admin = await self.hass.auth.async_create_user('Admin one', group_ids=[GROUP_ID_ADMIN])
        self.admin2 = await self.hass.auth.async_create_user('Admin two', group_ids=[GROUP_ID_ADMIN])
        self.family = await self.hass.auth.async_create_user('Family', group_ids=[GROUP_ID_USER])
        self.hass.data['home_floorplan'] = {'initialized': True, 'native': object(), 'has_editor': True, 'config': {}}
        self.calls = []
        def transport(*args):
            self.calls.append(args)
            args[-1].check()
            return {'draft': {'request_id': args[-2]['request_id']}, 'usage': {}}
        self.manager = self.ai.NativeAI(self.hass, transport=transport)
        self.view = self.ai.NativeAIView(self.manager)
        self.hass.data['home_floorplan']['ai'] = self.manager

    async def asyncTearDown(self):
        self.manager.clear()
        await self.hass.async_stop(force=True)
        self.temp.cleanup()

    async def call(self, action, body=None, *, token=None, user=None, method='post', request=None):
        request = request or Request(user or self.admin, json.dumps({} if body is None else body).encode(), token)
        if method == 'get':
            request.content_length = 0
        response = await getattr(self.view, method)(request, action)
        self.assertEqual(response.headers['Cache-Control'], 'no-store, max-age=0')
        return response.status, json.loads(response.body)

    async def connect(self, user=None):
        status, created = await self.call('session', user=user)
        self.assertEqual(status, 200)
        token = created['session']
        status, result = await self.call('connect', {'provider': 'openai', 'model': 'test-model', 'api_key': 'test-secret-never-log'}, token=token, user=user)
        self.assertEqual(status, 200)
        self.assertTrue(result['connected'])
        return token

    async def test_real_ha_auth_wrapper_and_admin_boundary(self):
        self.assertTrue(self.view.requires_auth)
        self.assertFalse(self.view.cors_allowed)
        request = make_mocked_request('POST', '/api/home_floorplan/ai/session')
        request['ha_authenticated'] = False
        wrapped = request_handler_factory(self.hass, self.view, self.view.post)
        with self.assertRaises(web.HTTPUnauthorized):
            await wrapped(request)
        for user, authenticated, expected in ((None, False, 401), (self.admin, False, 401), (self.family, True, 403)):
            status, result = await self.call('session', request=Request(user, authenticated=authenticated))
            self.assertEqual(status, expected)
            self.assertEqual(result['error']['code'], 'unauthorized')
        self.assertEqual(self.manager.sessions, {})

    async def test_user_binding_separate_tabs_and_no_key_in_responses(self):
        token = await self.connect()
        token2 = await self.connect()
        self.assertNotEqual(token, token2)
        self.assertGreaterEqual(len(token), 40)
        for action, method in (('status', 'get'), ('providers', 'get'), ('disconnect', 'post'), ('generate', 'post')):
            status, result = await self.call(action, payload() if action == 'generate' else {}, token=token, user=self.admin2, method=method)
            self.assertEqual(status, 403)
            self.assertEqual(result['error']['code'], 'session_expired')
        status, result = await self.call('providers', token=token, method='get')
        self.assertEqual(status, 200)
        self.assertIn('openai', [p['id'] for p in result['providers']])
        status, result = await self.call('status', token=token, method='get')
        self.assertNotIn('test-secret', json.dumps(result))
        self.assertNotIn('api_key', result)
        self.assertNotIn('test-secret', repr(self.manager.sessions[token]))
        await self.call('disconnect', token=token)
        self.assertEqual(self.manager.sessions[token].api_key, '')
        self.assertTrue(self.manager.sessions[token2].profile)

    async def test_native_install_and_loaded_lifecycle_required(self):
        state = self.hass.data['home_floorplan']
        for key, value in (('initialized', False), ('native', None), ('has_editor', False), ('panels_unloaded', True)):
            original = dict(state)
            state[key] = value
            status, result = await self.call('session')
            self.assertEqual(status, 409, key)
            self.assertEqual(result['error']['code'], 'not_loaded')
            state.clear()
            state.update(original)
        token = await self.connect()
        with patch.object(self.integration.frontend, 'async_remove_panel'):
            await self.integration.async_unload_entry(self.hass, None)
        self.assertEqual(self.manager.sessions, {})
        self.assertEqual((await self.call('status', token=token, method='get'))[0], 409)

    async def test_session_limit_and_monotonic_expiry(self):
        for _ in range(self.ai.MAX_SESSIONS):
            self.assertEqual((await self.call('session'))[0], 200)
        self.assertEqual((await self.call('session'))[1]['error']['code'], 'session_limit')
        self.manager.clear()
        self.manager.session_ttl = .03
        token = await self.connect()
        session = self.manager.sessions[token]
        # Expiry works even if wall time changes; no incoming API request is needed.
        with patch.object(self.ai.time, 'time', return_value=0):
            await asyncio.sleep(.06)
        self.assertEqual(session.api_key, '')
        self.assertEqual(self.manager.sessions, {})
        self.assertEqual((await self.call('status', token=token, method='get'))[0], 403)

    async def test_bounds_origin_and_safe_unexpected_errors(self):
        token = await self.connect()
        for headers in ({'Origin': 'null'}, {'Origin': 'https://other.example'}, {'Sec-Fetch-Site': 'cross-site'}, {'Content-Encoding': 'gzip'}, {'Transfer-Encoding': 'chunked'}):
            self.assertNotEqual((await self.call('connect', request=Request(self.admin, token=token, headers=headers)))[0], 200)
        request = Request(self.admin, token=token)
        request.content_length = self.ai.MAX_REQUEST_BYTES + 1
        self.assertEqual((await self.call('generate', request=request))[0], 413)
        request = Request(self.admin, token=token)
        request.query_string = 'api_key=private'
        self.assertEqual((await self.call('status', method='get', request=request))[0], 400)
        self.manager.http_requests = self.ai.MAX_HTTP_REQUESTS
        self.assertEqual((await self.call('session'))[0], 503)
        self.manager.http_requests = 0
        def bad_transport(*args):
            raise RuntimeError('private-key-or-prompt')
        self.manager.transport = bad_transport
        status, result = await self.call('generate', payload(), token=token)
        self.assertEqual(status, 500)
        self.assertNotIn('private-key', json.dumps(result))
        self.assertIsNone(self.manager.inference)
        self.assertEqual(self.manager.http_requests, 0)

    async def test_disconnect_cancel_and_reconnect_during_body_upload(self):
        token = await self.connect()
        for action in ('disconnect', 'cancel', 'connect'):
            gate, started = asyncio.Event(), asyncio.Event()
            request = Request(self.admin, json.dumps(payload()).encode(), token, gate=gate, started=started)
            pending = asyncio.create_task(self.call('generate', request=request))
            await started.wait()
            body = {'provider': 'openai', 'model': 'new-model', 'api_key': 'another-test-key'} if action == 'connect' else {}
            await self.call(action, body, token=token)
            gate.set()
            status, result = await pending
            self.assertEqual(status, 409)
            self.assertEqual(result['error']['code'], 'session_changed')
            self.assertEqual(self.calls, [])
        # Scoped cancellation also blocks a body that has not arrived yet.
        gate, started = asyncio.Event(), asyncio.Event()
        pending = asyncio.create_task(self.call('generate', request=Request(self.admin, json.dumps(payload('scoped')).encode(), token, gate=gate, started=started)))
        await started.wait()
        await self.call('cancel', {'request_id': 'scoped'}, token=token)
        gate.set()
        self.assertEqual((await pending)[1]['error']['code'], 'cancelled')
        self.assertEqual(self.calls, [])

    async def test_delayed_connect_cannot_restore_a_disconnected_key(self):
        token = await self.connect()
        gate, started = asyncio.Event(), asyncio.Event()
        body = {'provider': 'openai', 'model': 'old-model', 'api_key': 'stale-secret'}
        pending = asyncio.create_task(self.call('connect', request=Request(self.admin, json.dumps(body).encode(), token, gate=gate, started=started)))
        await started.wait()
        await self.call('disconnect', token=token)
        gate.set()
        self.assertEqual((await pending)[1]['error']['code'], 'session_changed')
        self.assertEqual(self.manager.sessions[token].api_key, '')

    async def blocking_transport(self):
        entered, release = threading.Event(), threading.Event()
        controls = []
        def transport(*args):
            self.calls.append(args)
            controls.append(args[-1])
            entered.set()
            release.wait(3)
            # Deliberately return a late response to verify host-side rejection.
            return {'draft': {'stale': True}}
        self.manager.transport = transport
        self.addCleanup(release.set)
        return entered, release, controls

    async def test_global_single_flight_and_cancel_discards_late_result(self):
        entered, release, controls = await self.blocking_transport()
        first, second = await self.connect(), await self.connect(self.admin2)
        pending = asyncio.create_task(self.call('generate', payload(), token=first))
        self.assertTrue(await asyncio.to_thread(entered.wait, 1))
        self.assertEqual((await self.call('generate', payload(), token=second, user=self.admin2))[1]['error']['code'], 'busy')
        await self.call('cancel', {'request_id': 'draft_1'}, token=first)
        self.assertTrue(controls[0].event.is_set())
        self.assertEqual((await self.call('generate', payload('next'), token=second, user=self.admin2))[1]['error']['code'], 'busy')
        release.set()
        self.assertEqual((await pending)[1]['error']['code'], 'cancelled')
        self.assertIsNone(self.manager.inference)
        self.assertEqual(len(self.calls), 1)

    async def test_http_task_cancellation_keeps_slot_until_worker_exits(self):
        entered, release, controls = await self.blocking_transport()
        token = await self.connect()
        pending = asyncio.create_task(self.call('generate', payload(), token=token))
        self.assertTrue(await asyncio.to_thread(entered.wait, 1))
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.assertTrue(controls[0].event.is_set())
        self.assertIsNotNone(self.manager.inference)
        self.assertEqual((await self.call('generate', payload('next'), token=token))[1]['error']['code'], 'busy')
        future = self.manager.inference
        release.set()
        await future
        await asyncio.sleep(0)
        self.assertIsNone(self.manager.inference)
        self.assertEqual(self.manager.http_requests, 0)

    async def test_expiry_and_shutdown_cancel_live_work(self):
        for shutdown in (False, True):
            entered, release, controls = await self.blocking_transport()
            token = await self.connect()
            session = self.manager.sessions[token]
            pending = asyncio.create_task(self.call('generate', payload(), token=token))
            self.assertTrue(await asyncio.to_thread(entered.wait, 1))
            if shutdown:
                self.manager._stop(None)
            else:
                self.manager._expire(token)
            self.assertTrue(controls[0].event.is_set())
            self.assertEqual(session.api_key, '')
            release.set()
            self.assertEqual((await pending)[1]['error']['code'], 'cancelled')
            self.assertEqual(self.manager.sessions, {})

    async def test_host_close_releases_session_slots_and_cancels_work(self):
        for _ in range(self.ai.MAX_SESSIONS + 2):
            token = await self.connect()
            session = self.manager.sessions[token]
            self.assertEqual((await self.call('close', token=token)), (200, {'connected': False}))
            self.assertEqual(session.api_key, '')
            self.assertTrue(session.expiry_handle.cancelled())
            self.assertEqual(self.manager.sessions, {})
        entered, release, controls = await self.blocking_transport()
        token = await self.connect()
        pending = asyncio.create_task(self.call('generate', payload(), token=token))
        self.assertTrue(await asyncio.to_thread(entered.wait, 1))
        self.assertEqual((await self.call('close', token=token))[0], 200)
        self.assertTrue(controls[0].event.is_set())
        self.assertEqual(self.manager.sessions, {})
        release.set()
        self.assertEqual((await pending)[1]['error']['code'], 'cancelled')

    async def test_upload_timeout_expiry_and_changed_permissions_prevent_inference(self):
        token = await self.connect()
        with patch.object(self.ai, 'BODY_TIMEOUT', .01):
            request = Request(self.admin, json.dumps(payload()).encode(), token, gate=asyncio.Event())
            self.assertEqual((await self.call('generate', request=request))[1]['error']['code'], 'request_timeout')
        for change in ('expire', 'disable'):
            gate, started = asyncio.Event(), asyncio.Event()
            request = Request(self.admin, json.dumps(payload()).encode(), token, gate=gate, started=started)
            pending = asyncio.create_task(self.call('generate', request=request))
            await started.wait()
            if change == 'expire':
                self.manager._expire(token)
            else:
                self.admin.is_active = False
            gate.set()
            self.assertEqual((await pending)[0], 403)
            self.assertEqual(self.calls, [])
            self.admin.is_active = True
            token = await self.connect()

    async def test_packaged_shared_sources_and_tls_namespace(self):
        self.assertEqual((self.component / 'runtime/ai_companion/transport.py').read_bytes(), (ROOT / 'ai_companion/transport.py').read_bytes())
        self.assertEqual((self.component / 'runtime/ai_companion/providers.py').read_bytes(), (ROOT / 'ai_companion/providers.py').read_bytes())
        self.assertEqual((self.component / 'runtime/ai_companion/protocol.py').read_bytes(), (ROOT / 'ai_companion/protocol.py').read_bytes())
        self.assertEqual((self.component / 'runtime/scripts/download_tls.py').read_bytes(), (ROOT / 'scripts/download_tls.py').read_bytes())
        self.assertFalse((self.component / 'runtime/ai_companion/server.py').exists())
        self.assertTrue((self.component / 'static/studio/ai/photo-processing.js').is_file())
        self.assertTrue((self.component / 'THIRD_PARTY_NOTICES.md').is_file())
        transport = __import__('studio_ai_package.runtime.ai_companion.transport', fromlist=['configured_context'])
        self.assertEqual(transport.configured_context.__module__, 'studio_ai_package.runtime.scripts.download_tls')
        paths = list(sys.path)
        with patch.dict('os.environ', {'HOME_STUDIO_STRICT_TLS': '0'}):
            context = transport.configured_context()
        self.assertTrue(context.check_hostname)
        self.assertEqual(paths, sys.path)
        token = await self.connect()
        status, result = await self.call('generate', payload(), token=token)
        self.assertEqual(status, 200)
        self.assertEqual(result['draft']['request_id'], 'draft_1')
        self.assertEqual(len(self.calls), 1)


if __name__ == '__main__':
    unittest.main()
