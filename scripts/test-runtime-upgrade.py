"""Synthetic renderer upgrades and baseline transaction regressions."""
import asyncio
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('runtime_test_support', ROOT/'scripts/test-ha-generated.py')
support = importlib.util.module_from_spec(spec)
spec.loader.exec_module(support)
generated, native = support.generated, support.native
upgrade = sys.modules.get('ha_native_test.runtime_upgrade') or support.support.load_file('ha_native_test.runtime_upgrade', ROOT/'custom_components/home_floorplan/runtime_upgrade.py')
transaction = sys.modules['ha_native_test.baseline_transaction']
LEGACY = (ROOT/'scripts/fixtures/map-layer-v0.js').read_bytes()
TARGET = (ROOT/'map-layer.js').read_bytes().rstrip()


class UpgradeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.component = self.root/'component'
        self.site, self.models, self.inventory = support.fixture(self.component)
        # Live Store placements and an added item differ from immutable source.
        self.inventory['upper']['revision'] = 19
        self.inventory['upper']['items'][0]['position_m']['x'] = 1.7
        added = copy.deepcopy(self.inventory['upper']['items'][0])
        added.update(id='later_lamp', name='Later saved lamp', entity_id='light.later_lamp')
        self.inventory['upper']['items'].append(added)
        for fid in self.models:
            path = self.component/'assets'/fid/'index.html'
            path.write_bytes(path.read_bytes().replace(b'</body>', b'<script>'+LEGACY+b'</script></body>'))
        (self.component/'runtime').mkdir()
        self.target = self.component/'runtime/map-layer.js'
        self.target.write_bytes(TARGET)
        self.hass = support.support.Hass(self.root)
        self.hass.async_add_executor_job = lambda fn,*args: asyncio.get_running_loop().run_in_executor(None,fn,*args)
        for module in (native,generated):
            handle = patch.object(module,'compiler',return_value=support.compiler)
            handle.start()
            self.addCleanup(handle.stop)
        self.project = generated.GeneratedProject(self.hass,self.component,self.site,self.models,self.inventory)
        await self.project.load()
        await self.project.save(0,copy.deepcopy(self.project.document['project']))
        await self.project.publish(1)
        self.project.store.path = self.root/'store.json'
        self.project.store.path.write_text(json.dumps({'data':self.project.document}))
        save = self.project.store.async_save
        async def disk_save(document):
            await save(document)
            self.project.store.path.write_text(json.dumps({'data':document}))
        self.project.store.async_save = disk_save
        self.service = upgrade.ImportedRuntimeUpgrade()

    async def preview(self):
        return await self.service.preview(self.project,self.project.document['revision'],'admin')

    async def apply(self,preview,**kwargs):
        return await self.service.apply(self.project,preview['revision'],'admin',preview['token'],**kwargs)

    def state(self):
        return copy.deepcopy(self.project.document),copy.deepcopy(self.hass.saved),support.tree_hashes(self.project.root)

    async def assert_recovery_blocks_mutation(self):
        before = self.state()
        for operation in (lambda: self.project.save(self.project.document['revision'], self.project.document['project']),
                          lambda: self.project.publish(self.project.document['revision']),
                          lambda: self.project.save_inventory(self.project.document['inventory']),
                          self.preview):
            with self.assertRaises(native.NativeError) as error:
                await operation()
            self.assertEqual(error.exception.code, 'baseline_recovery_required')
        self.assertEqual(self.state(), before)

    async def test_preview_apply_reload_publish(self):
        self.assertEqual((len(LEGACY),upgrade._sha(LEGACY)),(upgrade.LEGACY_SIZE,upgrade.LEGACY_SHA256))
        before = self.state()
        preview = await self.preview()
        self.assertEqual(self.state(),before)
        self.assertEqual(preview['changed_file_count'],2)
        self.assertEqual(preview['files'],['upper/index.html','ground/index.html'])
        self.assertEqual(preview['current_runtime']['version'],0)
        self.assertEqual(preview['target_runtime'],{'version':1,'sha256':upgrade._sha(TARGET)})
        await self.apply(preview)
        updated = self.project.document
        self.assertEqual(updated['revision'],2)
        for key in ('generation','published_revision','inventory','project'):
            self.assertEqual(updated[key],before[0][key])
        old = self.project.root/'baselines'/before[0]['baseline']
        new = self.project.root/'baselines'/updated['baseline']
        old_hashes,new_hashes = support.tree_hashes(old/'assets'),support.tree_hashes(new/'assets')
        self.assertEqual({k for k in old_hashes if old_hashes[k]!=new_hashes[k]},set(preview['files']))
        self.assertEqual(json.loads((new/'previous-document.json').read_text()),before[0])
        self.assertEqual(self.project._source_hashes,new_hashes)
        self.assertEqual(json.loads((new/'runtime-upgrade.json').read_text())['target_runtime'],preview['target_runtime'])
        for name in preview['files']:
            prior,current = (old/'assets'/name).read_bytes(),(new/'assets'/name).read_bytes()
            self.assertEqual(current.replace(TARGET,LEGACY,1),prior)
        for name,digest in before[2].items():
            self.assertEqual(support.tree_hashes(self.project.root)[name],digest)
        reopened = generated.GeneratedProject(self.hass,self.component,self.site,self.models,self.inventory)
        active = await reopened.load()
        self.assertEqual(reopened.document,updated)
        self.assertEqual(active[0],self.project.root/before[0]['generation'])
        self.assertNotIn(TARGET,(active[0]/'upper/index.html').read_bytes())
        project = copy.deepcopy(updated['project'])
        project['site'] = {'ground_elevation_m':0,'features':[{'id':'neighbor','name':'Synthetic','kind':'building','polygon':[[8,0],[12,0],[12,4],[8,4]],'height_m':4,'color':'#589aa8','render_style':'outline'}]}
        await reopened.save(2,project)
        assets,_,models,_,_ = await reopened.publish(3)
        self.assertIn(TARGET,(assets/'upper/index.html').read_bytes())
        for fid in models:
            self.assertEqual(models[fid]['meshes'],self.models[fid]['meshes'])
            self.assertEqual(models[fid]['inventory'],before[0]['inventory'][fid]['items'])

    async def test_failed_store_old_disk_rolls_back(self):
        preview,before = await self.preview(),self.state()
        self.hass.fail_save = True
        with self.assertRaises(native.NativeError) as error:
            await self.apply(preview)
        self.assertEqual(error.exception.code,'baseline_save_failed')
        self.assertFalse(self.project._baseline_recovery_required)
        self.assertEqual(self.state(),before)

    async def test_failed_fsync_committed_disk_reconciles(self):
        preview = await self.preview()
        save = self.project.store.async_save
        async def failed(document):
            await save(document)
            raise OSError('synthetic fsync failure after rename')
        with patch.object(self.project.store,'async_save',side_effect=failed):
            with self.assertRaises(native.NativeError) as error:
                await self.apply(preview)
        self.assertEqual(error.exception.code,'baseline_commit_saved')
        self.assertFalse(self.project._baseline_recovery_required)
        reopened = generated.GeneratedProject(self.hass,self.component,self.site,self.models,self.inventory)
        await reopened.load()
        self.assertEqual(reopened.document,self.project.document)
        self.assertEqual(reopened.document['revision'],2)
        self.assertEqual(reopened._source_hashes,self.project._source_hashes)

    async def test_unknown_disk_retains_baselines(self):
        preview = await self.preview()
        previous = copy.deepcopy(self.project.document)
        async def failed(document):
            self.project.store.path.write_text('unreadable')
            raise OSError('uncertain')
        with patch.object(self.project.store,'async_save',side_effect=failed):
            with self.assertRaises(native.NativeError) as error:
                await self.apply(preview)
        self.assertEqual(error.exception.code,'baseline_commit_uncertain')
        await self.assert_recovery_blocks_mutation()
        self.assertEqual(self.project.document,previous)
        self.assertEqual(len(list((self.project.root/'baselines').iterdir())),2)

    async def test_stale_owner_revision_expiry_adapter(self):
        for kind in ('owner','revision','expiry','adapter'):
            with self.subTest(kind=kind):
                preview,before = await self.preview(),self.state()
                if kind=='expiry': self.service.previews[preview['token']]['expires']=0
                if kind=='adapter': self.service.previews[preview['token']]['native']=object()
                with self.assertRaises(native.NativeError) as error:
                    await self.service.apply(self.project,2 if kind=='revision' else 1,'other' if kind=='owner' else 'admin',preview['token'])
                self.assertEqual(error.exception.code,'stale_preview')
                self.assertEqual(self.state(),before)

    async def test_changed_source_and_target(self):
        for kind in ('source','target'):
            with self.subTest(kind=kind):
                preview = await self.preview()
                path = self.target if kind=='target' else self.project.root/'baselines'/self.project.document['baseline']/'assets/upper/upper_model.glb'
                original = path.read_bytes()
                path.write_bytes(original+b'\n// changed')
                before = self.state()
                with self.assertRaises(native.NativeError): await self.apply(preview)
                self.assertEqual(self.state(),before)
                path.write_bytes(original)

    async def test_unknown_duplicate_inert_and_mixed_sources(self):
        model = b'<script id="modelData" type="application/json">{"meshes":[]}</script>'
        for block in (b'<script>'+LEGACY.replace(b'6378137',b'6378138',1)+b'</script>',
                      b'<script>'+LEGACY+LEGACY+b'</script>',b'<script type="application/json">'+LEGACY+b'</script>'):
            with self.assertRaises(native.NativeError) as error: upgrade._replace(model+block,TARGET)
            self.assertEqual(error.exception.code,'unsupported_runtime')
        original = upgrade._replace
        calls = 0
        def mixed(*args):
            nonlocal calls
            calls+=1
            version,value = original(*args)
            return (1 if calls==1 else version),value
        with patch.object(upgrade,'_replace',side_effect=mixed):
            with self.assertRaises(native.NativeError): await self.preview()

    async def test_already_current(self):
        await self.apply(await self.preview())
        before = self.state()
        with self.assertRaises(native.NativeError) as error: await self.preview()
        self.assertEqual(error.exception.code,'runtime_current')
        self.assertEqual(self.state(),before)

    async def test_invalid_linked_missing_target(self):
        for value in (b'arbitrary JS',TARGET.replace(b'VERSION = 1',b'VERSION = 2')):
            self.target.write_bytes(value)
            with self.assertRaises(native.NativeError): await self.preview()
        self.target.unlink()
        with self.assertRaises(native.NativeError): await self.preview()
        self.target.symlink_to(ROOT/'map-layer.js')
        with self.assertRaises(native.NativeError): await self.preview()

    async def test_requires_saved_and_published_import(self):
        for key,code in (('baseline','save_required'),('generation','publish_required')):
            old = self.project.document[key]
            self.project.document[key]=None
            with self.assertRaises(native.NativeError) as error: await self.preview()
            self.assertEqual(error.exception.code,code)
            self.project.document[key]=old

    async def test_cancelled_copy_settles_and_cleans(self):
        preview,before = await self.preview(),self.state()
        started,release = threading.Event(),threading.Event()
        self.addCleanup(release.set)
        original = upgrade._copy_baseline
        def held(*args):
            result = original(*args)
            started.set()
            if not release.wait(10): raise AssertionError('Copy was not released')
            return result
        with patch.object(upgrade,'_copy_baseline',side_effect=held):
            pending = asyncio.create_task(self.apply(preview))
            await asyncio.to_thread(started.wait,10)
            self.assertTrue(started.is_set())
            pending.cancel()
            await asyncio.sleep(0)
            self.assertFalse(pending.done())
            release.set()
            with self.assertRaises(asyncio.CancelledError): await pending
        self.assertEqual(self.state(),before)

    async def test_cancelled_caller_finishes_store(self):
        preview = await self.preview()
        started,release = asyncio.Event(),asyncio.Event()
        save = self.project.store.async_save
        async def held(document):
            started.set()
            await release.wait()
            await save(document)
        with patch.object(self.project.store,'async_save',side_effect=held):
            pending = asyncio.create_task(self.apply(preview))
            await started.wait()
            pending.cancel()
            await asyncio.sleep(0)
            self.assertFalse(pending.done())
            release.set()
            with self.assertRaises(asyncio.CancelledError): await pending
        reopened = generated.GeneratedProject(self.hass,self.component,self.site,self.models,self.inventory)
        await reopened.load()
        self.assertEqual(reopened.document,self.project.document)
        self.assertEqual(reopened.document['revision'],2)

    async def test_cancelled_store_task_retains_baseline(self):
        preview = await self.preview()
        save = self.project.store.async_save
        async def canceled(document):
            await save(document)
            asyncio.current_task().cancel()
            await asyncio.sleep(0)
        with patch.object(self.project.store,'async_save',side_effect=canceled):
            with self.assertRaises(asyncio.CancelledError): await self.apply(preview)
        await self.assert_recovery_blocks_mutation()
        reopened = generated.GeneratedProject(self.hass,self.component,self.site,self.models,self.inventory)
        await reopened.load()
        self.assertEqual(reopened.document['revision'],2)
        self.assertTrue((reopened.root/'baselines'/reopened.document['baseline']).is_dir())

    async def test_cancellation_during_error_reconciliation_retains_baseline(self):
        preview = await self.preview()
        save = self.project.store.async_save
        started,release = threading.Event(),threading.Event()
        self.addCleanup(release.set)
        read = transaction._stored_document
        async def failed(document):
            await save(document)
            raise OSError('after rename')
        def held_read(*args):
            started.set()
            release.wait(10)
            return read(*args)
        with patch.object(self.project.store,'async_save',side_effect=failed), patch.object(transaction,'_stored_document',side_effect=held_read):
            pending = asyncio.create_task(self.apply(preview))
            await asyncio.to_thread(started.wait,10)
            self.assertTrue(started.is_set())
            pending.cancel()
            with self.assertRaises(asyncio.CancelledError): await pending
            release.set()
        await self.assert_recovery_blocks_mutation()
        reopened = generated.GeneratedProject(self.hass,self.component,self.site,self.models,self.inventory)
        await reopened.load()
        self.assertEqual(reopened.document['revision'],2)

    async def test_precommit_identity_and_after_copy_races(self):
        preview,before = await self.preview(),self.state()
        calls = 0
        def validate():
            nonlocal calls
            calls+=1
            if calls==3: raise native.NativeError('unavailable','Session changed')
        with self.assertRaises(native.NativeError): await self.apply(preview,validate_current=validate)
        self.assertEqual(self.state(),before)
        original = upgrade._copy_baseline
        for kind in ('draft','target'):
            with self.subTest(kind=kind):
                preview = await self.preview()
                document,saved = copy.deepcopy(self.project.document),copy.deepcopy(self.hass.saved)
                count = len(list((self.project.root/'baselines').iterdir()))
                def raced(*args):
                    result = original(*args)
                    if kind=='draft': self.project.document={**document,'revision':2}
                    else: self.target.write_bytes(TARGET+b'\n// changed')
                    return result
                with patch.object(upgrade,'_copy_baseline',side_effect=raced):
                    with self.assertRaises(native.NativeError): await self.apply(preview)
                self.assertEqual(self.hass.saved,saved)
                self.assertEqual(len(list((self.project.root/'baselines').iterdir())),count)
                self.project.document=document
                self.target.write_bytes(TARGET)


if __name__ == '__main__':
    unittest.main()
