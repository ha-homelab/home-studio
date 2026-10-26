#!/usr/bin/env python3
"""Synthetic imported-home calibration, transaction and authority regressions."""
import asyncio
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("calibration_support", ROOT / "scripts/test-ha-generated.py")
support = importlib.util.module_from_spec(spec)
spec.loader.exec_module(support)
generated, native = support.generated, support.native
calibration = sys.modules["ha_native_test.site_calibration"]
frame = sys.modules["ha_native_test.site_frame"]


class CalibrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.component = self.root / "component"
        self.site, self.models, self.inventory = support.fixture(self.component)
        for fid, model in self.models.items():
            model["elevation_m"] = 0
            model["site_context"].update(ground_elevation_m=-3 if fid == "upper" else 0,
                                          roof_outline={"polygons_m": [[[0, 0], [5, 0], [5, 4]]], "elevation_m": 3},
                                          yard={"preserve": "synthetic yard"})
            folder = self.component / "assets" / fid
            (folder / "model-data.json").write_text(support.encoded(model))
            html = (folder / "index.html").read_text()
            embedded = support.embedded_model(folder / "index.html")
            embedded["elevation_m"] = 0
            embedded["site_context"] = copy.deepcopy(model["site_context"])
            html = support.MODEL_BLOCK.sub(lambda match: match[1] + support.encoded(embedded) + match[3], html)
            html = html.replace('</body>', '<script>' + (ROOT / 'map-layer.js').read_text() + '</script></body>')
            (folder / "index.html").write_text(html)
        self.hass = support.support.Hass(self.root)
        for module in (native, generated):
            handle = patch.object(module, "compiler", return_value=support.compiler)
            handle.start()
            self.addCleanup(handle.stop)
        self.project = generated.GeneratedProject(self.hass, self.component, self.site, self.models, self.inventory)
        await self.project.load()
        await self.project.save(0, copy.deepcopy(self.project.document["project"]))
        await self.project.publish(1)
        self.service = calibration.SiteCalibration()

    async def preview(self):
        return await self.service.preview(self.project, self.project.document["revision"], "admin")

    async def test_preview_apply_reload_and_publish_preserve_local_assets(self):
        previous = copy.deepcopy(self.project.document)
        before = support.tree_hashes(self.project.root)
        preview = await self.preview()
        self.assertEqual([row['after_m'] for row in preview['floors']], [3, 0])
        self.assertEqual(before, support.tree_hashes(self.project.root), 'preview is read-only')
        await self.service.apply(self.project, 1, "admin", preview["token"])
        after = self.project.document
        self.assertEqual(after['revision'], 2)
        for key in ('generation', 'published_revision', 'inventory'):
            self.assertEqual(after[key], previous[key])
        old = self.project.root / 'baselines' / previous['baseline']
        new = self.project.root / 'baselines' / after['baseline']
        self.assertEqual(support.tree_hashes(old / 'assets'), support.tree_hashes(new / 'assets'))
        self.assertEqual(json.loads((new / 'previous-document.json').read_text()), previous)
        unchanged = copy.deepcopy(after['project'])
        for now, original in zip(unchanged['floors'], previous['project']['floors']):
            now['elevation_m'] = original['elevation_m']
        self.assertEqual(unchanged, previous['project'])
        restarted = generated.GeneratedProject(self.hass, self.component, self.site, self.models, self.inventory)
        await restarted.load()
        self.assertEqual(restarted.document, after)
        proposed = copy.deepcopy(after['project'])
        proposed['site'] = {'ground_elevation_m': 0, 'features': []}
        generated._check_source_site_frame(proposed, new / 'assets')
        await restarted.save(2, proposed)
        assets, published_site, models, _, _ = await restarted.publish(3)
        for fid in models:
            expected_elevation = 3 if fid == 'upper' else 0
            self.assertEqual(models[fid]['elevation_m'], expected_elevation)
            self.assertEqual(support.embedded_model(assets / fid / 'index.html')['elevation_m'], expected_elevation)
            for key in ('meshes', 'object_assets', 'control_anchors', 'motion_paths', 'cover_windows'):
                self.assertEqual(models[fid][key], self.models[fid][key])
            for key in ('ground_elevation_m', 'lowest_slab_elevation_m', 'roof_outline', 'yard'):
                self.assertEqual(models[fid]['site_context'][key], self.models[fid]['site_context'][key])
                self.assertEqual(support.embedded_model(assets / fid / 'index.html')['site_context'][key], self.models[fid]['site_context'][key])
        fresh = generated.seed_project(published_site, models, restarted.document['inventory'])
        self.assertEqual([floor['elevation_m'] for floor in fresh['floors']], [3, 0])
        self.assertEqual(fresh['site'], proposed['site'])
        generated._check_source_site_frame(fresh, assets)
        for path, digest in before.items():
            self.assertEqual(support.tree_hashes(self.project.root)[path], digest)

    async def test_failed_store_keeps_document_baseline_and_removes_owned_copy(self):
        preview = await self.preview()
        previous = copy.deepcopy(self.project.document)
        before = support.tree_hashes(self.project.root)
        self.hass.fail_save = True
        with self.assertRaises(OSError):
            await self.service.apply(self.project, 1, 'admin', preview['token'])
        self.assertEqual(self.project.document, previous)
        self.assertEqual(support.tree_hashes(self.project.root), before)

    async def test_cancelled_request_finishes_store_before_releasing_baseline(self):
        preview = await self.preview()
        started, resume = asyncio.Event(), asyncio.Event()
        save = self.project.store.async_save

        async def paused_save(document):
            started.set()
            await resume.wait()
            await save(document)

        with patch.object(self.project.store, 'async_save', side_effect=paused_save):
            pending = asyncio.create_task(self.service.apply(self.project, 1, 'admin', preview['token']))
            await started.wait()
            pending.cancel()
            await asyncio.sleep(0)
            self.assertFalse(pending.done())
            resume.set()
            with self.assertRaises(asyncio.CancelledError):
                await pending
        self.assertEqual(self.project.document['revision'], 2)
        self.assertTrue((self.project.root / 'baselines' / self.project.document['baseline']).is_dir())
        reopened = generated.GeneratedProject(self.hass, self.component, self.site, self.models, self.inventory)
        await reopened.load()
        self.assertEqual(reopened.document, self.project.document)

    async def test_existing_zero_ground_site_features_are_preserved(self):
        project = copy.deepcopy(self.project.document['project'])
        project['site'] = {'ground_elevation_m': 0, 'features': [
            {'id': 'synthetic_roof', 'name': 'Synthetic roof', 'kind': 'roof',
             'polygon': [[0, 0], [5, 0], [5, 4]], 'height_m': 6, 'color': '#567890'}]}
        await self.project.save(1, project)
        inventory = copy.deepcopy(self.project.document['inventory'])
        preview = await self.preview()
        await self.service.apply(self.project, 2, 'admin', preview['token'])
        self.assertEqual(self.project.document['project']['site'], project['site'])
        self.assertEqual(self.project.document['inventory'], inventory)

    async def test_stale_revision_owner_expiry_and_source_mutation_reject(self):
        preview = await self.preview()
        with self.assertRaisesRegex(native.NativeError, 'another session'):
            await self.service.apply(self.project, 1, 'another-admin', preview['token'])
        preview = await self.preview()
        self.service.previews[preview['token']]['expires'] = 0
        with self.assertRaises(native.NativeError):
            await self.service.apply(self.project, 1, 'admin', preview['token'])
        preview = await self.preview()
        await self.project.save(1, copy.deepcopy(self.project.document['project']))
        with self.assertRaises(native.NativeError):
            await self.service.apply(self.project, 1, 'admin', preview['token'])
        preview = await self.preview()
        baseline = self.project.root / 'baselines' / self.project.document['baseline']
        path = baseline / 'assets/upper/upper_model.glb'
        path.write_bytes(b'changed synthetic source')
        with self.assertRaisesRegex(native.NativeError, 'snapshot changed'):
            await self.service.apply(self.project, 2, 'admin', preview['token'])

    async def test_draft_race_after_copy_rejects_without_overwriting(self):
        preview = await self.preview()
        original = calibration._copy_baseline
        def racing_copy(adapter, snapshot):
            result = original(adapter, snapshot)
            adapter.document = {**adapter.document, 'revision': 2}
            return result
        with patch.object(calibration, '_copy_baseline', racing_copy):
            with self.assertRaisesRegex(native.NativeError, 'changed during'):
                await self.service.apply(self.project, 1, 'admin', preview['token'])
        self.assertEqual(self.project.document['revision'], 2)
        self.assertEqual(len(list((self.project.root / 'baselines').iterdir())), 1)

    async def test_publication_guard_and_proposal_reject_uncertain_sources(self):
        project = copy.deepcopy(self.project.document['project'])
        project['site'] = {'ground_elevation_m': 0, 'features': []}
        with self.assertRaisesRegex(native.NativeError, 'disagree'):
            generated._check_source_site_frame(project, self.component / 'assets')
        corrected, _, _ = frame.propose_site_frame(project, project, self.models, self.models)
        corrected['site']['ground_elevation_m'] = -1
        generated._check_source_site_frame(corrected, self.component / 'assets')  # authored ground may intentionally differ
        for value in (None, True, float('nan'), 101):
            models = copy.deepcopy(self.models)
            models['upper']['site_context']['ground_elevation_m'] = value
            with self.assertRaises(ValueError):
                frame.propose_site_frame(project, project, models, models)
        mismatch = copy.deepcopy(self.models)
        mismatch['upper']['site_context']['ground_elevation_m'] = -4
        with self.assertRaisesRegex(ValueError, 'viewer disagree'):
            frame.propose_site_frame(project, project, self.models, mismatch)
        project['site']['ground_elevation_m'] = 1
        with self.assertRaisesRegex(ValueError, 'nonzero'):
            frame.propose_site_frame(project, project, self.models, self.models)

    async def test_context_merge_preserves_absent_slab_fallback_and_private_fields(self):
        project = copy.deepcopy(self.project.document['project'])
        project['site'] = {'ground_elevation_m': 0, 'features': []}
        project, _, _ = frame.propose_site_frame(project, project, self.models, self.models)
        for floor in project['floors']:
            model = copy.deepcopy(self.models[floor['id']])
            model['site_context'].pop('lowest_slab_elevation_m')
            expected = copy.deepcopy(model['site_context'])
            expected['features'] = []
            merged = generated._merge_site_context(model, project, floor)
            self.assertEqual(merged['site_context'], expected)
            self.assertNotIn('lowest_slab_elevation_m', merged['site_context'])

    async def test_handlers_require_admin_and_preview_before_apply(self):
        import asyncio
        integration = support.integration
        self.hass.data[integration.DOMAIN] = {'native': self.project, 'lock': asyncio.Lock()}
        viewer = support.support.Connection(admin=False)
        await integration.ws_site_frame_preview(self.hass, viewer, {'id': 1, 'revision': 1})
        self.assertEqual(viewer.errors[0][0], 'unauthorized')
        admin = support.support.Connection()
        admin.user.id = 'admin'
        await integration.ws_site_frame_apply(self.hass, admin, {'id': 2, 'revision': 1, 'token': 'no-preview'})
        self.assertEqual(admin.errors[0][0], 'stale_preview')


if __name__ == '__main__':
    unittest.main()
