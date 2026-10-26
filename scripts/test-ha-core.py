#!/usr/bin/env python3
"""Check the packaged integration against real HA APIs, without starting devices.

Install requirements-ha-test.txt first. Only the HTTP transport is a recording
sink: storage, registries, users, permissions, decorators and panels are real HA.
No listening socket, discovery integration or physical service is started.
"""
from __future__ import annotations

import asyncio
import base64
import copy
import errno
import importlib.util
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, DEFAULT, patch
import zlib

from homeassistant import auth
from homeassistant.auth.const import GROUP_ID_ADMIN, GROUP_ID_READ_ONLY, GROUP_ID_USER
from homeassistant.components import frontend
from homeassistant.components.lovelace import LovelaceData
from homeassistant.components.lovelace.dashboard import LovelaceStorage
from homeassistant.components.lovelace.resources import ResourceStorageCollection, ResourceYAMLCollection
from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry, device_registry, entity_registry, floor_registry
from homeassistant.util.file import WriteError

ROOT = Path(__file__).resolve().parents[1]


def load(name, path, package=False):
    spec = importlib.util.spec_from_file_location(name, path, submodule_search_locations=[str(path.parent)] if package else None)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class HTTPRecorder:
    def __init__(self):
        self.paths, self.views = [], []

    async def async_register_static_paths(self, paths):
        self.paths.extend(paths)

    def register_view(self, view):
        self.views.append(view)


class Connection:
    def __init__(self, user):
        self.user, self.subscriptions = user, {}
        self.result = asyncio.get_running_loop().create_future()

    def send_result(self, message_id, result=None):
        self.result.set_result(result)

    def send_error(self, message_id, code, message):
        self.result.set_exception(ValueError(f'{code}: {message}'))

    def async_handle_exception(self, msg, error):
        self.result.set_exception(error)

    def send_event(self, message_id, result):
        pass


class CoreCompatibility(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.package_temp = tempfile.TemporaryDirectory(prefix='studio-core-package-')
        component = Path(cls.package_temp.name) / 'home_floorplan'
        builder = load('core_bundle_builder', ROOT / 'scripts/build-home-studio.py')
        builder.bundle_component(ROOT, component)
        cls.integration = load('studio_core_package', component / '__init__.py', package=True)

    @classmethod
    def tearDownClass(cls):
        cls.package_temp.cleanup()

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='studio-core-config-')
        self.hass = HomeAssistant(self.temp.name)
        device_registry.async_setup(self.hass)
        await asyncio.gather(*(registry.async_load(self.hass) for registry in
                               (area_registry, device_registry, entity_registry, floor_registry)))
        self.hass.auth = await auth.auth_manager_from_config(self.hass, [], [])
        self.admin = await self.hass.auth.async_create_user('Test admin', group_ids=[GROUP_ID_ADMIN])
        self.family = await self.hass.auth.async_create_user('Test family', group_ids=[GROUP_ID_USER])
        self.hass.http = HTTPRecorder()
        self.resources = ResourceStorageCollection(self.hass, LovelaceStorage(self.hass, None))
        self.hass.data['lovelace'] = LovelaceData(resource_mode='storage', dashboards={},
                                               resources=self.resources, yaml_dashboards={})
        self.assertTrue(await self.integration.async_setup(self.hass, {}))

    async def asyncTearDown(self):
        await self.hass.async_stop(force=True)
        self.temp.cleanup()

    async def request(self, command, *, user=None, **data):
        connection = Connection(user or self.admin)
        handler, schema = self.hass.data['websocket_api'][f'home_floorplan/{command}']
        msg = {'id': 1, 'type': f'home_floorplan/{command}', **data}
        if schema:
            msg = schema(msg)
        handler(self.hass, connection, msg)
        return await asyncio.wait_for(connection.result, 30)

    async def test_registry_and_admin_boundary(self):
        floors, areas = floor_registry.async_get(self.hass), area_registry.async_get(self.hass)
        floor = floors.async_create('First', level=1)
        area = areas.async_create('Study')
        areas.async_update(area.id, floor_id=floor.floor_id)
        self.hass.states.async_set('light.study', 'off', {'friendly_name': 'Study lamp'})
        catalog = await self.request('entity_catalog')
        self.assertEqual(catalog['floors'][0]['id'], floor.floor_id)
        self.assertEqual(catalog['areas'][0]['floor_id'], floor.floor_id)
        self.assertIn('light.study', [item['entity_id'] for item in catalog['entities']])
        from homeassistant.exceptions import Unauthorized
        with self.assertRaises(Unauthorized):
            await self.request('project_get', user=self.family)
        status = await self.request('status', user=self.family)
        self.assertFalse(status['can_edit'])
        panels = self.hass.data[frontend.DATA_PANELS]
        self.assertTrue(panels['home-studio'].require_admin)
        self.assertFalse(panels['home-floorplan'].require_admin)
        project = await self.request('project_get')
        self.assertTrue(project['capabilities']['ai'])
        self.assertEqual(sum(view.name == 'api:home_floorplan:ai' for view in self.hass.http.views), 1)

    async def test_map_real_permissions_and_separate_private_storage(self):
        config = {'enabled': True, 'latitude': 37.1234567, 'longitude': -122.1234567,
                  'model_x': 1.005, 'model_z': -2.001, 'north_deg': 25.005}
        initial = await self.request('map_get', user=self.family)
        self.assertFalse(initial['configured'])
        self.assertIsNone(initial['config'])
        project = await self.request('project_get')
        reference = (self.hass.config.latitude, self.hass.config.longitude)
        with self.assertRaisesRegex(ValueError, 'unauthorized'):
            await self.request('map_save', user=self.family, revision=0, config=config)
        saved = await self.request('map_save', revision=0, config=config)
        self.assertEqual(saved['revision'], 1)
        self.assertEqual((await self.request('map_get', user=self.family))['config'], config)
        self.assertTrue((Path(self.temp.name) / '.storage/home_floorplan.map').is_file())
        manager = self.hass.data['home_floorplan']['map']
        reopened = type(manager)(self.hass)
        await reopened.load()
        self.assertEqual(reopened.document, manager.document)
        self.assertEqual(await self.request('project_get'), project)
        self.assertEqual((self.hass.config.latitude, self.hass.config.longitude), reference)
        with self.assertRaisesRegex(ValueError, 'conflict'):
            await self.request('map_save', revision=0, config=config)
        with self.assertRaisesRegex(ValueError, 'invalid_map'):
            await self.request('map_save', revision=True, config=config)

    async def test_site_calibration_real_permissions_lock_and_store(self):
        from homeassistant.exceptions import Unauthorized

        generated = sys.modules[self.integration.__package__ + '.generated']
        project = json.loads((ROOT / 'planner/example-home.json').read_text())
        floor = project['floors'][0]
        project['floors'] = [{**copy.deepcopy(floor), 'id': fid, 'name': fid.title(), 'elevation_m': 0}
                             for fid in ('upper', 'ground')]
        await self.request('project_save', revision=0, project=project)
        await self.request('project_publish', revision=1)
        state = self.hass.data['home_floorplan']
        component = Path(self.temp.name) / 'synthetic-import'
        shutil.copytree(state['assets'], component / 'assets')
        for fid in ('upper', 'ground'):
            folder = component / 'assets' / fid
            model = json.loads((folder / 'model-data.json').read_text())
            model['site_context'] = {'ground_elevation_m': -3 if fid == 'upper' else 0,
                                     'roof_outline': {'synthetic': True}, 'yard': {'synthetic': True}}
            (folder / 'model-data.json').write_text(json.dumps(model))
            html = (folder / 'index.html').read_text()
            match, embedded = generated._embedded(html)
            embedded['site_context'] = copy.deepcopy(model['site_context'])
            (folder / 'index.html').write_text(html[:match.start(2)] + generated._json(embedded) + html[match.end(2):])
        models, _ = generated.load_models(component / 'assets', state['site']['floors'])
        adapter = generated.GeneratedProject(self.hass, component, state['site'], models, state['data'])
        await adapter.load()
        state['native'] = adapter
        await self.request('project_save', revision=0, project=adapter.document['project'])
        await self.request('project_publish', revision=1)
        previous = copy.deepcopy(adapter.document)
        store_path = Path(adapter.store.path)
        previous_bytes = store_path.read_bytes()
        before_assets = state['assets']
        before_inventory = copy.deepcopy(state['data'])
        self.assertTrue((await self.request('project_get'))['capabilities']['site_frame_calibration'])

        readonly = await self.hass.auth.async_create_user('Read-only calibration user', group_ids=[GROUP_ID_READ_ONLY])
        for user in (self.family, readonly):
            for command, extra in (('site_frame_preview', {}), ('site_frame_apply', {'token': 'unused'})):
                with self.assertRaises(Unauthorized):
                    await self.request(command, user=user, revision=1, **extra)
        self.assertEqual(adapter.document, previous)

        async with state['lock']:
            stale = asyncio.create_task(self.request('site_frame_preview', revision=1))
            await asyncio.sleep(.01)
            state['native'] = None
        try:
            with self.assertRaisesRegex(ValueError, 'conflict'):
                self.assertIsNone(await stale)
        finally:
            state['native'] = adapter

        queued_admin = await self.hass.auth.async_create_user('Queued calibration admin', group_ids=[GROUP_ID_ADMIN])
        async with state['lock']:
            revoked = asyncio.create_task(self.request('site_frame_preview', user=queued_admin, revision=1))
            await asyncio.sleep(.01)
            await self.hass.auth.async_update_user(queued_admin, group_ids=[GROUP_ID_READ_ONLY])
        with self.assertRaisesRegex(ValueError, 'unauthorized'):
            self.assertIsNone(await revoked)

        async with state['lock']:
            pending = asyncio.create_task(self.request('site_frame_preview', revision=1))
            await asyncio.sleep(.01)
            self.assertFalse(pending.done(), 'preview must acquire the shared project lock')
        preview = await pending
        self.assertEqual([row['after_m'] for row in preview['floors']], [3, 0])
        self.assertEqual(store_path.read_bytes(), previous_bytes, 'preview does not write the Store')

        failure = WriteError(OSError(errno.ENOSPC, 'No space left on device'))
        baseline_dirs = set((adapter.root / 'baselines').iterdir())
        with patch.object(adapter.store, '_write_prepared_data', side_effect=failure):
            with self.assertRaisesRegex(ValueError, 'save_failed'):
                await self.request('site_frame_apply', revision=1, token=preview['token'])
        self.assertEqual(adapter.document, previous)
        self.assertEqual(store_path.read_bytes(), previous_bytes)
        self.assertEqual(set((adapter.root / 'baselines').iterdir()), baseline_dirs)

        preview = await self.request('site_frame_preview', revision=1)
        async with state['lock']:
            pending = asyncio.create_task(self.request('site_frame_apply', revision=1, token=preview['token']))
            await asyncio.sleep(.01)
            self.assertFalse(pending.done(), 'apply must acquire the shared project lock')
            self.assertEqual(adapter.document, previous)
        saved = await pending
        self.assertEqual(saved['revision'], 2)
        self.assertEqual([value['elevation_m'] for value in saved['project']['floors']], [3, 0])
        self.assertEqual(adapter.document['generation'], previous['generation'])
        self.assertEqual(state['assets'], before_assets)
        self.assertEqual(state['data'], before_inventory)
        old = adapter.root / 'baselines' / previous['baseline']
        new = adapter.root / 'baselines' / adapter.document['baseline']
        self.assertEqual(generated._hashes(old / 'assets'), generated._hashes(new / 'assets'))
        self.assertEqual(json.loads((new / 'previous-document.json').read_text()), previous)
        reopened = generated.GeneratedProject(self.hass, component, state['site'], models, state['data'])
        await reopened.load()
        self.assertEqual(reopened.document, adapter.document)
        with self.assertRaisesRegex(ValueError, 'stale_preview'):
            await self.request('site_frame_apply', revision=2, token=preview['token'])

    async def test_imported_runtime_upgrade_real_store_and_authority(self):
        from homeassistant.exceptions import Unauthorized

        generated = sys.modules[self.integration.__package__ + '.generated']
        project = json.loads((ROOT / 'planner/example-home.json').read_text())
        await self.request('project_save', revision=0, project=project)
        await self.request('project_publish', revision=1)
        state = self.hass.data['home_floorplan']
        component = Path(self.temp.name) / 'runtime-upgrade-import'
        shutil.copytree(state['assets'], component / 'assets')
        current = (ROOT / 'map-layer.js').read_text().rstrip()
        previous_runtime = (ROOT / 'scripts/fixtures/map-layer-v0.js').read_text().rstrip()
        (component / 'runtime').mkdir()
        (component / 'runtime/map-layer.js').write_text(current)
        for fid in state['site']['floors']:
            path = component / 'assets' / fid / 'index.html'
            html = path.read_text()
            self.assertEqual(html.count(current), 1)
            path.write_text(html.replace(current, previous_runtime))
        models, _ = generated.load_models(component / 'assets', state['site']['floors'])
        adapter = generated.GeneratedProject(self.hass, component, state['site'], models, state['data'])
        await adapter.load()
        state['native'] = adapter
        await self.request('project_save', revision=0, project=adapter.document['project'])
        await self.request('project_publish', revision=1)
        previous = copy.deepcopy(adapter.document)
        store_path = Path(adapter.store.path)
        previous_bytes = store_path.read_bytes()
        active_assets, active_data = state['assets'], copy.deepcopy(state['data'])
        active_hashes = generated._hashes(active_assets)
        old = adapter.root / 'baselines' / previous['baseline']
        old_hashes = generated._hashes(old / 'assets')
        baseline_dirs = set((adapter.root / 'baselines').iterdir())
        self.assertTrue((await self.request('project_get'))['capabilities']['imported_runtime_upgrade'])

        for command, extra in (('project_runtime_upgrade_preview', {}),
                               ('project_runtime_upgrade_apply', {'token': 'unused'})):
            with self.assertRaises(Unauthorized):
                await self.request(command, user=self.family, revision=1, **extra)
        async with state['lock']:
            stale = asyncio.create_task(self.request('project_runtime_upgrade_preview', revision=1))
            await asyncio.sleep(.01)
            state['native'] = None
        try:
            with self.assertRaisesRegex(ValueError, 'conflict'):
                self.assertIsNone(await stale)
        finally:
            state['native'] = adapter
        queued_admin = await self.hass.auth.async_create_user('Runtime upgrade admin', group_ids=[GROUP_ID_ADMIN])
        async with state['lock']:
            revoked = asyncio.create_task(self.request('project_runtime_upgrade_preview', user=queued_admin, revision=1))
            await asyncio.sleep(.01)
            await self.hass.auth.async_update_user(queued_admin, group_ids=[GROUP_ID_READ_ONLY])
        with self.assertRaisesRegex(ValueError, 'unauthorized'):
            self.assertIsNone(await revoked)

        preview = await self.request('project_runtime_upgrade_preview', revision=1)
        self.assertEqual(preview['changed_file_count'], len(state['site']['floors']))
        self.assertEqual(preview['source'], 'published_generation')
        self.assertEqual(preview['source_file_count'], len(active_hashes))
        self.assertEqual(store_path.read_bytes(), previous_bytes)
        failure = WriteError(OSError(errno.ENOSPC, 'No space left on device'))
        with patch.object(adapter.store, '_write_prepared_data', side_effect=failure):
            with self.assertRaisesRegex(ValueError, 'save_failed'):
                await self.request('project_runtime_upgrade_apply', revision=1, token=preview['token'])
        self.assertEqual(adapter.document, previous)
        self.assertEqual(store_path.read_bytes(), previous_bytes)
        self.assertEqual(set((adapter.root / 'baselines').iterdir()), baseline_dirs)

        preview = await self.request('project_runtime_upgrade_preview', revision=1)
        async with state['lock']:
            pending = asyncio.create_task(self.request('project_runtime_upgrade_apply', revision=1, token=preview['token']))
            await asyncio.sleep(.01)
            self.assertFalse(pending.done(), 'Runtime preparation must acquire the shared project lock')
        saved = await pending
        self.assertEqual(saved['revision'], 2)
        for key in ('project', 'inventory', 'generation', 'published_revision'):
            self.assertEqual(adapter.document[key], previous[key])
        self.assertEqual(state['assets'], active_assets)
        self.assertEqual(state['data'], active_data)
        self.assertEqual(generated._hashes(active_assets), active_hashes)
        new = adapter.root / 'baselines' / adapter.document['baseline']
        self.assertEqual(json.loads((new / 'previous-document.json').read_text()), previous)
        self.assertEqual(generated._hashes(old / 'assets'), old_hashes)
        receipt = json.loads((new / 'runtime-upgrade.json').read_text())
        self.assertEqual(receipt['source_generation'], previous['generation'])
        self.assertEqual(receipt['source_hashes'], active_hashes)
        before, after = active_hashes, generated._hashes(new / 'assets')
        self.assertEqual(before.keys(), after.keys())
        changed = {name for name in before if before[name] != after[name]}
        self.assertEqual(changed, set(preview['files']))
        for name in changed:
            html_before = (active_assets / name).read_text()
            html_after = (new / 'assets' / name).read_text()
            self.assertEqual(html_after.replace(current, previous_runtime), html_before)
        reopened = generated.GeneratedProject(self.hass, component, state['site'], models, state['data'])
        await reopened.load()
        self.assertEqual(reopened.document, adapter.document)
        with self.assertRaisesRegex(ValueError, 'stale_preview'):
            await self.request('project_runtime_upgrade_apply', revision=2, token=preview['token'])
        adapter._baseline_recovery_required = True
        for command, data in (
                ('project_get', {}),
                ('project_save', {'revision': 2, 'project': adapter.document['project']}),
                ('project_publish', {'revision': 2}),
                ('project_runtime_upgrade_preview', {'revision': 2})):
            with self.assertRaisesRegex(ValueError, 'baseline_recovery_required'):
                await self.request(command, **data)
        self.assertEqual(state['assets'], active_assets)
        self.assertEqual(generated._hashes(active_assets), active_hashes)

    async def test_map_real_write_error_does_not_acknowledge_or_mutate(self):
        config = {'enabled': True, 'latitude': 0, 'longitude': 0,
                  'model_x': 0, 'model_z': 0, 'north_deg': 0}
        await self.request('map_save', revision=0, config=config)
        manager = self.hass.data['home_floorplan']['map']
        previous = copy.deepcopy(manager.document)
        store_path = Path(manager.store.path)
        previous_bytes = store_path.read_bytes()
        failure = WriteError(OSError(errno.ENOSPC, 'No space left on device'))
        with patch.object(manager.store, '_write_prepared_data', side_effect=failure):
            with self.assertRaisesRegex(ValueError, 'save_failed'):
                await self.request('map_save', revision=1, config={**config, 'north_deg': 90})
        self.assertEqual(manager.document, previous)
        self.assertEqual(store_path.read_bytes(), previous_bytes)

    async def test_map_real_async_transport_boundary_and_cache(self):
        def png_chunk(kind, data):
            return (struct.pack('>I', len(data)) + kind + data
                    + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff))

        png = (b'\x89PNG\r\n\x1a\n'
               + png_chunk(b'IHDR', struct.pack('>IIBBBBB', 256, 256, 8, 6, 0, 0, 0))
               + png_chunk(b'IDAT', zlib.compress((b'\x00' + b'\x00\x00\x00\xff' * 256) * 256))
               + png_chunk(b'IEND', b''))

        class Response:
            status = 200
            headers = {'Content-Type': 'image/png', 'Cache-Control': 'max-age=600'}
            content_length = len(png)

            def __init__(self):
                self.content = self

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def iter_chunked(self, size):
                yield png

        session = SimpleNamespace(get=lambda *args, **kwargs: Response())
        with patch.object(session, 'get', wraps=session.get) as fetch, patch(
                'homeassistant.helpers.aiohttp_client.async_get_clientsession', return_value=session):
            with self.assertRaisesRegex(ValueError, 'map_disabled'):
                await self.request('map_tile', user=self.family, z=0, x=0, y=0)
            preview = await self.request('map_tile', z=0, x=0, y=0)
            self.assertEqual(base64.b64decode(preview['data_url'].split(',')[1]), png)
            await self.request('map_save', revision=0, config={
                'enabled': True, 'latitude': 0, 'longitude': 0,
                'model_x': 0, 'model_z': 0, 'north_deg': 0})
            await self.request('map_tile', user=self.family, z=0, x=0, y=0)
            fetch.assert_called_once()
            self.assertEqual(fetch.call_args.args, ('https://tile.openstreetmap.org/0/0/0.png',))
            self.assertFalse(fetch.call_args.kwargs['allow_redirects'])
            self.assertFalse(fetch.call_args.kwargs['auto_decompress'])
            self.assertEqual(fetch.call_args.kwargs['timeout'].total, 10)
            self.assertIn('HomeStudioMap/', fetch.call_args.kwargs['headers']['User-Agent'])

    async def test_save_publish_reopen_and_conflict(self):
        project = json.loads((ROOT / 'planner/guide-assets/practice-home.json').read_text())
        for floor in project['floors']:
            for item in floor['items']:
                item['entity_id'] = ''
        saved = await self.request('project_save', revision=0, project=project)
        self.assertEqual(saved['revision'], 1)
        published = await self.request('project_publish', revision=1)
        self.assertEqual(published['published_revision'], 1)
        view = await self.request('viewer', user=self.family)
        self.assertIn('__HOME_FLOORPLAN_EMBED__', view['html'])
        self.assertFalse(view['can_edit'])
        with self.assertRaisesRegex(ValueError, 'conflict'):
            await self.request('project_save', revision=0, project=project)
        native = self.integration.NativeProject(self.hass)
        active = await native.load()
        self.assertEqual(native.document['project'], project)
        self.assertEqual(native.document['published_revision'], 1)
        self.assertTrue(active[0].is_dir())
        self.assertTrue((Path(self.temp.name) / '.storage/home_floorplan.studio').is_file())
        blank = json.loads(json.dumps(project))
        blank['floors'][0]['rooms'] = []
        blank['floors'][0]['items'] = []
        await self.request('project_save', revision=1, project=blank)
        with self.assertRaisesRegex(ValueError, 'invalid_project'):
            await self.request('project_publish', revision=2)
        after = await self.request('viewer', user=self.family)
        self.assertEqual(after['html'], view['html'])

    async def test_viewer_refreshes_real_user_permissions_after_asset_read(self):
        project = json.loads((ROOT / 'planner/example-home.json').read_text())
        project['floors'][0]['items'][-1]['entity_id'] = 'light.permission_fixture'
        await self.request('project_save', revision=0, project=project)
        await self.request('project_publish', revision=1)
        user = await self.hass.auth.async_create_user('Permission fixture', group_ids=[GROUP_ID_ADMIN])
        self.assertFalse(user.is_owner)
        original = self.hass.async_add_executor_job

        for before, after, can_edit in ((GROUP_ID_ADMIN, GROUP_ID_READ_ONLY, False),
                                       (GROUP_ID_READ_ONLY, GROUP_ID_ADMIN, True)):
            with self.subTest(before=before, after=after):
                await self.hass.auth.async_update_user(user, group_ids=[before])
                # Populate HA's cached properties before changing the role.
                self.assertEqual(user.is_admin, before == GROUP_ID_ADMIN)
                self.assertEqual(user.permissions.check_entity('light.permission_fixture', 'control'),
                                 before == GROUP_ID_ADMIN)
                entered, resume = asyncio.Event(), asyncio.Event()

                async def pause_asset_read(function, *args):
                    value = await original(function, *args)
                    if function is self.integration._read_open_file:
                        entered.set()
                        await resume.wait()
                    return value

                with patch.object(self.hass, 'async_add_executor_job', side_effect=pause_asset_read):
                    pending = asyncio.create_task(self.request('viewer', user=user))
                    try:
                        await asyncio.wait_for(entered.wait(), 5)
                        await self.hass.auth.async_update_user(user, group_ids=[after])
                    finally:
                        resume.set()
                    result = await pending

                self.assertEqual(result['can_edit'], can_edit)
                self.assertIn('light.permission_fixture', result['readable_entities'])
                self.assertEqual('light.permission_fixture' in result['controllable_entities'], can_edit)
                self.assertEqual('published_revision' in result, can_edit)
                # A different connection retains its own authorization.
                admin_result = await self.request('viewer')
                self.assertTrue(admin_result['can_edit'])
                self.assertIn('light.permission_fixture', admin_result['controllable_entities'])

    async def test_disk_full_never_acknowledges_a_save_or_removes_the_active_generation(self):
        project = json.loads((ROOT / 'planner/example-home.json').read_text())
        await self.request('project_save', revision=0, project=project)
        await self.request('project_publish', revision=1)
        state = self.hass.data['home_floorplan']
        native = state['native']
        store_path = Path(native.store.path)
        previous = copy.deepcopy(native.document)
        previous_bytes = store_path.read_bytes()
        assets = state['assets']
        inventory = copy.deepcopy(state['data'])
        changed = copy.deepcopy(project)
        changed['title'] = 'A draft that must not be lost'
        failure = WriteError(OSError(errno.ENOSPC, 'No space left on device'))

        with patch.object(native.store, '_write_prepared_data', side_effect=failure):
            for _ in range(2):
                with self.assertRaisesRegex(ValueError, 'save_failed'):
                    await self.request('project_save', revision=1, project=changed)
            items = copy.deepcopy(inventory['main']['items'])
            items[0]['name'] = 'A placement that was not saved'
            with self.assertRaisesRegex(ValueError, 'save_failed'):
                await self.request('save', floor='main', revision=inventory['main']['revision'], items=items)
        self.assertEqual(native.document, previous)
        self.assertEqual(state['data'], inventory)
        self.assertEqual(store_path.read_bytes(), previous_bytes)

        await self.request('project_save', revision=1, project=changed)
        previous = copy.deepcopy(native.document)
        previous_bytes = store_path.read_bytes()
        with patch.object(native.store, '_write_prepared_data', side_effect=failure):
            for _ in range(2):
                with self.assertRaisesRegex(ValueError, 'save_failed'):
                    await self.request('project_publish', revision=2)
                self.assertEqual(native.document, previous)
                self.assertEqual(state['data'], inventory)
                self.assertEqual(state['assets'], assets)
                self.assertEqual(store_path.read_bytes(), previous_bytes)
                self.assertTrue((assets / 'main/index.html').is_file())
                self.assertEqual(set(native.root.iterdir()), {assets})
        reopened = self.integration.NativeProject(self.hass)
        active = await reopened.load()
        self.assertEqual(reopened.document, previous)
        self.assertEqual(active[0], assets)
        published = await self.request('project_publish', revision=2)
        self.assertEqual(published['published_revision'], 2)
        self.assertNotEqual(state['assets'], assets)
        self.assertTrue((assets / 'main/index.html').is_file())

    async def test_default_assets_do_not_collide_with_legacy_store_file(self):
        storage = Path(self.temp.name) / '.storage'
        storage.mkdir(exist_ok=True)
        legacy = storage / 'home_floorplan'
        legacy.write_text('{"legacy": "keep this inventory"}')
        original = legacy.read_bytes()
        native = self.integration.NativeProject(self.hass)
        self.assertEqual(self.hass.data['home_floorplan']['native'].root, native.root)
        project = json.loads((ROOT / 'planner/example-home.json').read_text())
        await native.save(0, project)
        assets, *_ = await native.publish(1)
        self.assertEqual(assets.parent, storage / 'home_floorplan_studio_assets')
        self.assertEqual(legacy.read_bytes(), original)
        reopened = self.integration.NativeProject(self.hass)
        self.assertEqual((await reopened.load())[0], assets)

    async def test_model_index_failure_preserves_publication_and_retry_replaces_generation(self):
        project = json.loads((ROOT / 'planner/example-home.json').read_text())
        project['floors'][0]['items'][-1]['entity_id'] = 'light.before'
        native_module = sys.modules[self.integration.__package__ + '.native']
        index_models = native_module.model_references
        loop_thread = threading.get_ident()
        indexed = []

        def checked_index(models):
            self.assertNotEqual(threading.get_ident(), loop_thread)
            result = index_models(models)
            indexed.append(result)
            return result

        await self.request('project_save', revision=0, project=project)
        with patch.object(native_module, 'model_references', side_effect=checked_index):
            await self.request('project_publish', revision=1)
        state = self.hass.data['home_floorplan']
        native = state['native']
        previous_state = {key: state[key] for key in ('assets', 'site', 'models', 'data', 'rooms', 'model_entities')}
        self.assertIs(state['model_entities'], indexed[0])
        self.assertIn('light.before', state['model_entities']['main'])
        project['floors'][0]['items'][-1]['entity_id'] = 'light.after'
        await self.request('project_save', revision=1, project=project)
        previous_document = copy.deepcopy(native.document)
        previous_bytes = Path(native.store.path).read_bytes()

        for failure in (RuntimeError('index failed'), {}):
            options = {'side_effect': failure} if isinstance(failure, Exception) else {'return_value': failure}
            with self.subTest(failure=failure), patch.object(native_module, 'model_references', **options), \
                 patch.object(native.store, 'async_save', wraps=native.store.async_save) as save, \
                 self.assertLogs(native_module.__name__, level='ERROR'):
                with self.assertRaisesRegex(ValueError, 'build_failed'):
                    await self.request('project_publish', revision=2)
                save.assert_not_awaited()
            self.assertEqual(native.document, previous_document)
            self.assertEqual(Path(native.store.path).read_bytes(), previous_bytes)
            self.assertEqual(set(native.root.iterdir()), {previous_state['assets']})
            for key, value in previous_state.items():
                self.assertIs(state[key], value)

        with patch.object(native_module, 'model_references', side_effect=checked_index):
            await self.request('project_publish', revision=2)
            reopened = self.integration.NativeProject(self.hass)
            loaded_assets, _, _, loaded_references = await reopened.load()
        self.assertEqual(len(indexed), 3)
        self.assertIs(state['model_entities'], indexed[1])
        self.assertIs(loaded_references, indexed[2])
        self.assertEqual(loaded_assets, state['assets'])
        self.assertEqual(loaded_references, state['model_entities'])
        self.assertIn('light.after', loaded_references['main'])
        self.assertNotIn('light.before', loaded_references['main'])
        self.assertIn('light.before', previous_state['model_entities']['main'])
        self.assertNotIn('light.after', previous_state['model_entities']['main'])

    async def test_legacy_model_index_loads_off_loop_and_refreshes_on_restart(self):
        integration = self.integration
        native_module = sys.modules[integration.__package__ + '.native']
        index_models = native_module.model_references
        loop_thread = threading.get_ident()
        indexed = []

        def checked_index(models):
            self.assertNotEqual(threading.get_ident(), loop_thread)
            result = index_models(models)
            indexed.append(result)
            return result

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model_path = root / 'assets/main/model-data.json'
            model_path.parent.mkdir(parents=True)
            model = {'rooms': [{'id': 'room'}], 'mesh': {'metadata': {'entity': 'sensor.before'}}}
            model_path.write_text(json.dumps(model))
            site = {'floors': {'main': {'stem': 'main', 'title': 'Main'}},
                    'default_floor': 'main', 'site_id': None, 'site_features': True}
            adapter = SimpleNamespace(async_prepare=AsyncMock(), async_setup=AsyncMock())
            first, restarted = HomeAssistant(str(root / 'first')), HomeAssistant(str(root / 'restarted'))
            first.http, restarted.http = HTTPRecorder(), HTTPRecorder()
            try:
                with patch.object(integration, 'ROOT', root), patch.object(integration, 'SITE', site), \
                     patch.object(integration, 'FLOORS', {'main': 'main'}), \
                     patch.object(integration, 'SITE_ADAPTER', adapter, create=True), \
                     patch.object(native_module, 'model_references', side_effect=checked_index):
                    self.assertTrue(await integration.async_setup(first, {}))
                    references = first.data['home_floorplan']['model_entities']
                    self.assertEqual(references['main'], {'sensor.before'})
                    self.assertTrue(await integration.async_unload_entry(first, None))
                    self.assertTrue(await integration.async_setup_entry(first, None))
                    self.assertIs(first.data['home_floorplan']['model_entities'], references)
                    self.assertEqual(len(indexed), 1)
                    model['mesh']['metadata']['entity'] = 'sensor.after'
                    model_path.write_text(json.dumps(model))
                    self.assertTrue(await integration.async_setup(restarted, {}))
                self.assertEqual(len(indexed), 2)
                self.assertEqual(restarted.data['home_floorplan']['model_entities']['main'], {'sensor.after'})
                self.assertEqual(references['main'], {'sensor.before'})
            finally:
                await first.async_stop(force=True)
                await restarted.async_stop(force=True)

    async def test_previous_native_assets_remain_readable_during_upgrade(self):
        old_root = Path(self.temp.name) / '.storage/home_floorplan/studio'
        old = self.integration.NativeProject(self.hass, old_root)
        project = json.loads((ROOT / 'planner/example-home.json').read_text())
        await old.save(0, project)
        previous_assets, *_ = await old.publish(1)
        native = self.integration.NativeProject(self.hass)
        self.assertEqual((await native.load())[0], previous_assets)
        assets, *_ = await native.publish(1)
        self.assertEqual(assets.parent.name, 'home_floorplan_studio_assets')
        self.assertTrue((previous_assets / 'main/index.html').is_file())
        reopened = self.integration.NativeProject(self.hass)
        self.assertEqual((await reopened.load())[0], assets)

    async def test_inflight_assets_survive_multiple_publications_without_blocking_them(self):
        project = json.loads((ROOT / 'planner/example-home.json').read_text())
        await self.request('project_save', revision=0, project=project)
        await self.request('project_publish', revision=1)
        assets = self.hass.data['home_floorplan']['assets']
        expected_viewer = await self.request('viewer')
        expected_export = (assets / 'main/main.glb').read_bytes()
        original = self.hass.async_add_executor_job
        started, release = asyncio.Event(), asyncio.Event()
        streams = []

        async def delayed_read(function, *args):
            if function is self.integration._read_open_file:
                streams.append(args[0])
                if len(streams) == 2:
                    started.set()
                await release.wait()
            return await original(function, *args)

        with patch.object(self.hass, 'async_add_executor_job', side_effect=delayed_read):
            viewer = asyncio.create_task(self.request('viewer'))
            export = asyncio.create_task(self.request('export', floor='main', format='glb'))
            try:
                await asyncio.wait_for(started.wait(), 5)
                await asyncio.wait_for(self.request('project_publish', revision=1), 5)
                await asyncio.wait_for(self.request('project_publish', revision=1), 5)
                self.assertFalse(assets.exists())
            finally:
                release.set()
            actual_viewer, actual_export = await asyncio.gather(viewer, export)
        self.assertEqual(actual_viewer, expected_viewer)
        self.assertEqual(base64.b64decode(actual_export['base64']), expected_export)
        self.assertTrue(all(stream.closed for stream in streams))

    async def test_setup_retries_required_stages_without_duplicating_completed_setup(self):
        integration = self.integration
        for stage in ('curtains', 'adapter'):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as directory:
                retry_hass = HomeAssistant(directory)
                retry_hass.http = HTTPRecorder()
                curtains = AsyncMock(wraps=integration.async_setup_curtains)
                adapter = SimpleNamespace(async_prepare=AsyncMock(), async_setup=AsyncMock(return_value=None))
                failed = curtains if stage == 'curtains' else adapter.async_setup
                failed.side_effect = [OSError('temporary setup failure'), DEFAULT]
                site = {**integration.SITE, 'site_features': stage == 'adapter'}
                config = {'home_floorplan': {'test_setting': 'retained'}}
                try:
                    with patch.object(integration, 'async_setup_curtains', curtains), \
                         patch.object(integration, 'SITE_ADAPTER', adapter, create=True), \
                         patch.object(integration, 'SITE', site):
                        with self.assertRaisesRegex(OSError, 'temporary setup failure'):
                            await integration.async_setup(retry_hass, config)
                        state = retry_hass.data['home_floorplan']
                        self.assertFalse(state['initialized'])
                        self.assertNotIn('websocket_api', retry_hass.data)
                        self.assertEqual(await asyncio.gather(
                            integration.async_setup_entry(retry_hass, None),
                            integration.async_setup_entry(retry_hass, None)), [True, True])
                        self.assertTrue(state['initialized'])
                        self.assertIn('curtains', state)
                        self.assertEqual(curtains.await_count, 2 if stage == 'curtains' else 1)
                        self.assertEqual(adapter.async_setup.await_count, 2 if stage == 'adapter' else 0)
                        if stage == 'adapter':
                            adapter.async_setup.assert_awaited_with(retry_hass, config)
                            self.assertEqual(adapter.async_prepare.await_count, 1)
                        self.assertEqual(len(retry_hass.http.paths), 1)
                        self.assertEqual(len(retry_hass.http.views), 2)
                        connection = Connection(self.admin)
                        integration.ws_curtains(retry_hass, connection, {'id': 1})
                        await asyncio.wait_for(connection.result, 1)
                        connection.subscriptions[1]()
                finally:
                    await retry_hass.async_stop(force=True)

    async def test_navigation_reload_keeps_storage_and_registration(self):
        state = self.hass.data['home_floorplan']
        count = len(self.hass.http.paths)
        resources = copy.deepcopy(self.resources.async_items())
        self.assertTrue(await self.integration.async_unload_entry(self.hass, None))
        self.assertNotIn('home-studio', self.hass.data[frontend.DATA_PANELS])
        self.assertEqual(self.resources.async_items(), resources)
        with self.assertRaisesRegex(ValueError, 'not_loaded'):
            await self.request('status')
        self.assertTrue(await self.integration.async_setup_entry(self.hass, None))
        self.assertIn('home-studio', self.hass.data[frontend.DATA_PANELS])
        self.assertIs(self.hass.data['home_floorplan'], state)
        self.assertEqual(len(self.hass.http.paths), count)
        self.assertEqual(self.resources.async_items(), resources)

    async def test_dashboard_resource_registration_is_idempotent_across_upgrade(self):
        items = self.resources.async_items()
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['url'], '/home-floorplan-static/card.js')
        self.assertEqual(items[0]['type'], 'module')
        self.assertFalse(self.hass.http.paths[0].cache_headers)
        await self.resources.async_create_item({'url': '/local/other.js?v=3', 'res_type': 'module'})
        expected = copy.deepcopy(self.resources.async_items())
        await self.resources.store.async_save({'items': expected})
        # A new collection after a restart has not been loaded yet. Version
        # upgrades must load it before checking for the existing registration.
        reloaded = ResourceStorageCollection(self.hass, LovelaceStorage(self.hass, None))
        self.hass.data['lovelace'].resources = reloaded
        with patch.object(self.integration, 'VERSION', 'future-version'):
            await asyncio.gather(*(self.integration.async_setup_entry(self.hass, None) for _ in range(3)))
        self.assertTrue(reloaded.loaded)
        self.assertEqual(reloaded.async_items(), expected)

    async def test_dashboard_resource_preserves_manual_url_type_and_yaml(self):
        for item in self.resources.async_items():
            await self.resources.async_delete_item(item['id'])
        manual = await self.resources.async_create_item(
            {'url': '/home-floorplan-static/card.js?v=old-release#manual', 'res_type': 'module'})
        await self.integration.async_setup_entry(self.hass, None)
        self.assertEqual(self.resources.async_items(), [manual])
        manual = await self.resources.async_update_item(manual['id'], {'res_type': 'js'})
        with self.assertLogs(self.integration.__name__, level='WARNING') as log:
            await self.integration.async_setup_entry(self.hass, None)
        self.assertIn('must use type module', '\n'.join(log.output))
        self.assertEqual(self.resources.async_items(), [manual])
        yaml_items = [{'url': '/local/owner.js', 'type': 'module'}]
        self.hass.data['lovelace'].resource_mode = 'yaml'
        self.hass.data['lovelace'].resources = ResourceYAMLCollection(copy.deepcopy(yaml_items))
        await self.integration.async_setup_entry(self.hass, None)
        self.assertEqual(self.hass.data['lovelace'].resources.async_items(), yaml_items)

    async def test_dashboard_resource_failure_does_not_disable_home_and_can_retry(self):
        for item in self.resources.async_items():
            await self.resources.async_delete_item(item['id'])
        with patch.object(self.resources, 'async_get_info', side_effect=OSError('temporary storage error')), \
             self.assertLogs(self.integration.__name__, level='WARNING'):
            self.assertTrue(await self.integration.async_setup_entry(self.hass, None))
        self.assertEqual(self.resources.async_items(), [])
        self.assertIn('has_published', await self.request('status'))
        self.assertTrue(await self.integration.async_setup_entry(self.hass, None))
        self.assertEqual(len(self.resources.async_items()), 1)


class PortablePackageCompatibility(unittest.IsolatedAsyncioTestCase):
    async def test_compiled_package_starts_and_registers_map_without_source_fallback(self):
        with tempfile.TemporaryDirectory(prefix='studio-portable-package-') as temporary:
            root = Path(temporary)
            built = root / 'compiled'
            # Exercise the separately maintained portable archive allowlist,
            # then import only files actually delivered in that archive.
            await asyncio.to_thread(subprocess.run, [
                sys.executable, '-B', str(ROOT / 'scripts/build-planner-project.py'),
                '--project', str(ROOT / 'planner/example-home.json'),
                '--output', str(built), '--ha-package',
            ], check=True, capture_output=True, timeout=60)
            installer = load('portable_package_installer', ROOT / 'scripts/install-home-assistant.py')
            package = installer.read_package(built / 'home-floorplan.tar.gz')
            component = root / 'component'
            for name, data in package.files.items():
                path = component / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            integration = load('portable_distribution', component / '__init__.py', package=True)
            config = root / 'config'
            config.mkdir()
            hass = HomeAssistant(str(config))
            try:
                device_registry.async_setup(hass)
                await asyncio.gather(*(registry.async_load(hass) for registry in
                                       (area_registry, device_registry, entity_registry, floor_registry)))
                hass.auth = await auth.auth_manager_from_config(hass, [], [])
                user = await hass.auth.async_create_user('Portable test admin', group_ids=[GROUP_ID_ADMIN])
                hass.http = HTTPRecorder()
                hass.data['lovelace'] = LovelaceData(resource_mode='storage', dashboards={}, yaml_dashboards={},
                    resources=ResourceStorageCollection(hass, LovelaceStorage(hass, None)))
                self.assertTrue(await integration.async_setup(hass, {}))
                state = hass.data['home_floorplan']
                self.assertTrue(state['initialized'])
                self.assertEqual(set(state['models']), set(package.site['floors']))
                self.assertEqual(Path(sys.modules['portable_distribution.map'].__file__), component / 'map.py')
                for command in ('map_get', 'map_save', 'map_tile', 'viewer'):
                    self.assertIn('home_floorplan/' + command, hass.data['websocket_api'])
                connection = Connection(user)
                handler, schema = hass.data['websocket_api']['home_floorplan/map_get']
                message = {'id': 1, 'type': 'home_floorplan/map_get'}
                handler(hass, connection, schema(message) if schema else message)
                snapshot = await asyncio.wait_for(connection.result, 5)
                self.assertEqual((snapshot['revision'], snapshot['configured'], snapshot['config']),
                                 (0, False, None))
                self.assertFalse((config / '.storage/home_floorplan.map').exists())
            finally:
                await hass.async_stop(force=True)


if __name__ == '__main__':
    unittest.main()
