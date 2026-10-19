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
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, DEFAULT, patch

from homeassistant import auth
from homeassistant.auth.const import GROUP_ID_ADMIN, GROUP_ID_USER
from homeassistant.components import frontend
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
                        self.assertEqual(len(retry_hass.http.views), 1)
                        connection = Connection(self.admin)
                        integration.ws_curtains(retry_hass, connection, {'id': 1})
                        await asyncio.wait_for(connection.result, 1)
                        connection.subscriptions[1]()
                finally:
                    await retry_hass.async_stop(force=True)

    async def test_navigation_reload_keeps_storage_and_registration(self):
        state = self.hass.data['home_floorplan']
        count = len(self.hass.http.paths)
        self.assertTrue(await self.integration.async_unload_entry(self.hass, None))
        self.assertNotIn('home-studio', self.hass.data[frontend.DATA_PANELS])
        self.assertTrue(await self.integration.async_setup_entry(self.hass, None))
        self.assertIn('home-studio', self.hass.data[frontend.DATA_PANELS])
        self.assertIs(self.hass.data['home_floorplan'], state)
        self.assertEqual(len(self.hass.http.paths), count)


if __name__ == '__main__':
    unittest.main()
