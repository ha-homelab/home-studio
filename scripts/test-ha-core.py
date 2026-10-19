#!/usr/bin/env python3
"""Check the packaged integration against real HA APIs, without starting devices.

Install requirements-ha-test.txt first. Only the HTTP transport is a recording
sink: storage, registries, users, permissions, decorators and panels are real HA.
No listening socket, discovery integration or physical service is started.
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

from homeassistant import auth
from homeassistant.auth.const import GROUP_ID_ADMIN, GROUP_ID_USER
from homeassistant.components import frontend
from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry, device_registry, entity_registry, floor_registry

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
        native = self.integration.NativeProject(self.hass, Path(self.temp.name) / '.storage/home_floorplan/studio')
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
