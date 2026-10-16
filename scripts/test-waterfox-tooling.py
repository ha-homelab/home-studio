#!/usr/bin/env python3
"""Offline tests for pinned downloads and stock Gecko transport validation."""
import contextlib
import hashlib
import importlib.util
import io
import json
import plistlib
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


setup = load('native_browser')
acceptance = load('test-waterfox-acceptance')


def replacement_stats():
    return {'contexts':2, 'contextLosses':2, 'retiredContextLosses':1,
            'restoredBuffers':[{'contextId':1, 'lost':False, 'canvas':[0,0], 'drawingBuffer':[1,1]}],
            'gpu':{'version':'WebGL 2.0'}, 'linkedPrograms':4, 'shaderErrors':[], 'errors':[],
            'contextLossRequests':[
                {'id':1, 'contextId':1, 'attached':True, 'retirement':False, 'matched':True},
                {'id':2, 'contextId':1, 'attached':False, 'retirement':True, 'matched':True}],
            'contextEvents':[
                {'type':'webglcontextlost', 'contextId':1, 'lossRequest':1, 'retired':False},
                {'type':'webglcontextlost', 'contextId':1, 'lossRequest':2, 'retired':True}],
            'contextStates':[
                {'id':1, 'attached':False, 'lost':True, 'restores':1},
                {'id':2, 'attached':True, 'lost':False, 'restores':0}],
            'nativeGraphics':{'contexts':2, 'errors':[], 'samples':[{'label':'recovery', 'states':[
                {'id':1, 'attached':False, 'lost':True}, {'id':2, 'attached':True, 'lost':False}]}],
                'lossRequests':[{'contextId':1, 'attached':True}, {'contextId':1, 'attached':False}]}}


class Socket:
    def __init__(self, *messages):
        self.chunks = []
        self.sent = []
        for message in messages:
            data = json.dumps(message).encode('utf-8')
            frame = str(len(data)).encode() + b':' + data
            self.chunks.extend(bytes([byte]) for byte in frame)

    def settimeout(self, _value):
        pass

    def recv(self, _size):
        return self.chunks.pop(0) if self.chunks else b''

    def sendall(self, data):
        self.sent.append(data)


class ToolingTests(unittest.TestCase):
    def test_drag_budget_includes_queued_animation_frames(self):
        client = acceptance.Marionette.__new__(acceptance.Marionette)
        for draw_seconds in (2.8, 15):
            now, calls = [0.0], []
            def call(name, body):
                calls.append((name, body))
                now[0] += .2 if name == 'WebDriver:PerformActions' else draw_seconds
            client.call = call
            with patch.object(acceptance.time, 'monotonic', lambda: now[0]):
                if draw_seconds == 15:
                    with self.assertRaisesRegex(AssertionError, 'drag exceeded 15 seconds'):
                        client.drag([1, 2], [11, 12])
                else:
                    self.assertEqual(client.drag([1, 2], [11, 12]), 3000)
            self.assertEqual([entry[0] for entry in calls], ['WebDriver:PerformActions', 'WebDriver:ExecuteAsyncScript'])
            self.assertEqual(calls[1][1]['script'].count('requestAnimationFrame'), 2)
            self.assertEqual(calls[1][1]['args'], [])

    def firefox_installation(self, version='153.5.0esr'):
        return {
            'product': 'Firefox', 'release': version, 'platform': 'linux-x64',
            'source': setup.manifest_for('firefox')['versions'][version]['linux-x64'],
            'metadata': {'application.ini': {'App': {'Name': 'Firefox', 'Version': version.removesuffix('esr'), 'BuildID': '20261012115900'}}, 'platform.ini': {'Build': {'BuildID': '20261012115900'}}},
        }

    def test_official_firefox_pins_cover_stable_esr_and_three_platforms(self):
        manifest = setup.manifest_for('firefox')
        self.assertEqual(set(manifest['versions']), {manifest['latest_stable'], manifest['supported_esr']})
        for version, platforms in manifest['versions'].items():
            self.assertEqual(set(platforms), {'windows-x64', 'linux-x64', 'macos'})
            for entry in platforms.values():
                self.assertTrue(entry['url'].startswith(f'https://archive.mozilla.org/pub/firefox/releases/{version}/'))
                self.assertRegex(entry['sha512'], r'^[0-9a-f]{128}$')

    def test_native_identity_checks_product_version_and_build(self):
        installation = self.firefox_installation()
        capabilities = {'browserName': 'firefox', 'browserVersion': '153.5.0', 'moz:buildID': '20261012115900'}
        acceptance.assert_browser_identity(installation, capabilities)
        for changed in ({'browserName': 'waterfox'}, {'browserVersion': '158.0'}, {'moz:buildID': '20261001115900'}):
            with self.subTest(changed=changed), self.assertRaises(AssertionError):
                acceptance.assert_browser_identity(installation, {**capabilities, **changed})

    def test_firefox_metadata_cannot_be_relabelled_from_another_package(self):
        for changed in ({'Name': 'Waterfox'}, {'Version': '158.0'}, {'BuildID': ''}):
            installation = self.firefox_installation()
            installation['metadata']['application.ini']['App'].update(changed)
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                setup.validate_metadata(installation)
        for version in ('158.0', '153.5.0esr'):
            setup.validate_metadata(self.firefox_installation(version))

    def test_receipt_cannot_select_wrong_product_release_or_archive(self):
        installation = self.firefox_installation()
        for product, version, changed in [('waterfox', '153.5.0esr', {}), ('firefox', '158.0', {}), ('firefox', '153.5.0esr', {'source': {'url': 'https://example.invalid'}})]:
            with self.subTest(product=product, version=version, changed=changed), self.assertRaises(ValueError):
                setup.validate_installation({**installation, **changed}, product, version)

    def test_installed_metadata_is_rechecked_before_launch(self):
        installation = self.firefox_installation()
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / 'firefox'
            binary.write_bytes(b'fixture')
            installation['binary'] = str(binary)
            for name, sections in installation['metadata'].items():
                (binary.parent / name).write_text(''.join(f'[{section}]\n' + ''.join(f'{key}={value}\n' for key, value in items.items()) for section, items in sections.items()), encoding='utf-8')
            with patch.object(setup, 'platform_key', return_value='linux-x64'):
                setup.validate_installation(installation, 'firefox', '153.5.0esr')
                (binary.parent / 'application.ini').write_text('[App]\nName=Waterfox\n', encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'differs from the verified package'):
                    setup.validate_installation(installation, 'firefox', '153.5.0esr')

    def test_software_compositor_is_explicit_and_preserves_webgl_preferences(self):
        with patch.dict(acceptance.os.environ, {'FIREFOX_WEBGL_BACKEND': 'angle', 'FIREFOX_COMPOSITOR_BACKEND': 'default'}, clear=True):
            baseline = acceptance.browser_preferences(2828)
        self.assertNotIn('gfx.webrender.software', baseline)
        with patch.dict(acceptance.os.environ, {'FIREFOX_WEBGL_BACKEND': 'angle', 'FIREFOX_COMPOSITOR_BACKEND': 'software'}, clear=True):
            requested = acceptance.browser_preferences(2828)
        self.assertEqual(requested, {**baseline, 'gfx.webrender.software': True})
        self.assertTrue(requested['webgl.force-enabled'])
        self.assertFalse(requested['webgl.disable-angle'])
        self.assertFalse(requested['webgl.sanitize-unmasked-renderer'])
        with patch.dict(acceptance.os.environ, {'FIREFOX_COMPOSITOR_BACKEND': 'typo'}), self.assertRaisesRegex(AssertionError, 'must be default or software'):
            acceptance.browser_preferences(2828)

    def test_gpu_process_opt_in_permits_parent_webgl_and_preserves_backend(self):
        with patch.dict(acceptance.os.environ, {'FIREFOX_WEBGL_BACKEND': 'angle', 'FIREFOX_COMPOSITOR_BACKEND': 'software'}):
            acceptance.os.environ.pop('FIREFOX_GPU_PROCESS', None)
            baseline = acceptance.browser_preferences(2828)
            self.assertNotIn('layers.gpu-process.enabled', baseline)
            self.assertNotIn('webgl.allow-in-parent', baseline)
            acceptance.os.environ['FIREFOX_GPU_PROCESS'] = 'default'
            self.assertEqual(acceptance.browser_preferences(2828), baseline)
            acceptance.os.environ['FIREFOX_GPU_PROCESS'] = 'disabled'
            requested = acceptance.browser_preferences(2828)
            self.assertEqual(requested, {**baseline, 'layers.gpu-process.enabled': False, 'webgl.allow-in-parent': True})
            self.assertTrue(requested['gfx.webrender.software'])
            self.assertTrue(requested['webgl.force-enabled'])
            self.assertFalse(requested['webgl.forbid-software'])
            self.assertFalse(requested['webgl.disable-angle'])
            acceptance.os.environ['FIREFOX_GPU_PROCESS'] = 'default'
            self.assertEqual(acceptance.browser_preferences(2828), baseline)
            for invalid in ('', 'typo', 'false'):
                with self.subTest(value=invalid), self.assertRaisesRegex(AssertionError, 'must be default or disabled'):
                    acceptance.os.environ['FIREFOX_GPU_PROCESS'] = invalid
                    acceptance.browser_preferences(2828)

    def test_renderer_visibility_preserves_backend_and_context_preferences(self):
        for backend in ('default', 'angle'):
            with self.subTest(backend=backend), patch.dict(acceptance.os.environ, {
                'FIREFOX_WEBGL_BACKEND': backend,
                'FIREFOX_COMPOSITOR_BACKEND': 'software',
                'FIREFOX_GPU_PROCESS': 'disabled',
            }, clear=True):
                baseline = acceptance.browser_preferences(2828)
                self.assertFalse(baseline['webgl.sanitize-unmasked-renderer'])
                acceptance.os.environ['FIREFOX_RENDERER_VISIBILITY'] = 'unmasked'
                self.assertEqual(acceptance.browser_preferences(2828), baseline)
                acceptance.os.environ['FIREFOX_RENDERER_VISIBILITY'] = 'masked'
                self.assertEqual(acceptance.browser_preferences(2828), {
                    **baseline, 'webgl.sanitize-unmasked-renderer': True,
                })
                for invalid in ('', 'default', 'true', 'typo'):
                    acceptance.os.environ['FIREFOX_RENDERER_VISIBILITY'] = invalid
                    with self.subTest(visibility=invalid), self.assertRaisesRegex(AssertionError, 'must be unmasked or masked'):
                        acceptance.browser_preferences(2828)

    def test_requested_macos_backend_requires_real_metal_renderer(self):
        with patch.dict(acceptance.os.environ, {'FIREFOX_WEBGL_BACKEND': 'angle'}, clear=True):
            prefs = acceptance.browser_preferences(2828)
        self.assertFalse(prefs['webgl.disable-angle'])
        self.assertFalse(prefs['webgl.sanitize-unmasked-renderer'])
        record = {'os': {'platform': 'darwin'}, 'preferences': prefs, 'samples': [{'initial': {'gpu': {'unmaskedRenderer': 'ANGLE Metal Renderer: Apple M1'}}}]}
        acceptance.assert_requested_backend(record)
        record['samples'][0]['initial']['gpu']['unmaskedRenderer'] = 'Apple Software Renderer'
        with self.assertRaises(AssertionError):
            acceptance.assert_requested_backend(record)
        with patch.dict(acceptance.os.environ, {'FIREFOX_WEBGL_BACKEND': 'pretend'}), self.assertRaises(AssertionError):
            acceptance.browser_preferences(2828)

    def test_fragmented_protocol_and_unicode(self):
        sock = Socket({'marionetteProtocol': 3}, [1, 1, None, {'value': 'Room \u00e9'}])
        client = acceptance.Marionette(sock)
        self.assertEqual(client.execute('return "Room \u00e9";'), 'Room \u00e9')
        self.assertIn(b'WebDriver:ExecuteScript', sock.sent[0])

    def test_disconnect_fails_instead_of_spinning(self):
        with self.assertRaises(ConnectionError):
            acceptance.Marionette(Socket())

    def test_unexpected_response_rejected(self):
        client = acceptance.Marionette(Socket({'marionetteProtocol': 3}, [1, 9, None, {}]))
        with self.assertRaisesRegex(AssertionError, 'response ID'):
            client.call('WebDriver:NewSession')

    def test_remote_error_is_failure(self):
        client = acceptance.Marionette(Socket({'marionetteProtocol': 3}, [1, 1, {'error': 'timeout'}, None]))
        with self.assertRaisesRegex(RuntimeError, 'timeout'):
            client.call('WebDriver:NewSession')

    def test_checksum_is_enforced(self):
        content = b'official package fixture'
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'Waterfox package.exe'
            entry = {'url': 'https://example.invalid/fixture', 'sha512': hashlib.sha512(content).hexdigest()}
            with patch.object(setup.urllib.request, 'urlopen', return_value=io.BytesIO(content)):
                setup.download(entry, target)
            self.assertEqual(target.read_bytes(), content)
            with patch.object(setup.urllib.request, 'urlopen', return_value=io.BytesIO(b'tampered')):
                with self.assertRaisesRegex(RuntimeError, 'SHA-512'):
                    setup.download(entry, target)
            self.assertFalse(target.exists())

    def test_existing_installation_is_never_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            (target / 'sentinel').write_text('keep', encoding='utf-8')
            with self.assertRaisesRegex(RuntimeError, 'must be empty'):
                setup.install('6.7.6', target)
            self.assertEqual((target / 'sentinel').read_text(encoding='utf-8'), 'keep')

    def test_mac_bundle_is_copied_without_modification(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'installation'
            expected = {}
            calls = []
            def command(args, **_kwargs):
                calls.append(args)
                if args[:2] == ['hdiutil', 'attach']:
                    mount = Path(args[args.index('-mountpoint') + 1])
                    bundle = mount / 'Waterfox.app'
                    resources = bundle / 'Contents/Resources'
                    resources.mkdir(parents=True)
                    (bundle / 'Contents/MacOS').mkdir()
                    (bundle / 'Contents/MacOS/waterfox').write_bytes(b'official signed binary')
                    (resources / 'application.ini').write_text('[App]\nName=Waterfox\nVersion=153.5.0\n', encoding='utf-8')
                    (resources / 'platform.ini').write_text('[Build]\nMilestone=153.5.0\n', encoding='utf-8')
                    (bundle / 'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleShortVersionString': '6.7.6', 'CFBundleVersion': '6.7.6'}))
                    for path in bundle.rglob('*'):
                        if path.is_file():
                            expected[str(path.relative_to(bundle))] = path.read_bytes()
            with patch.object(setup, 'platform_key', return_value='macos'), patch.object(setup, 'download'), patch.object(setup.subprocess, 'run', side_effect=command), contextlib.redirect_stdout(io.StringIO()):
                setup.install('6.7.6', output)
            actual = {str(path.relative_to(output / 'Waterfox.app')): path.read_bytes() for path in (output / 'Waterfox.app').rglob('*') if path.is_file()}
            self.assertEqual(actual, expected, 'No file may be added or changed in the signed bundle')
            self.assertTrue(any(args[:4] == ['codesign', '--verify', '--deep', '--strict'] for args in calls))

    def test_native_firefox_linux_and_windows_archive_layouts(self):
        for platform in ('linux-x64', 'windows-x64'):
            with self.subTest(platform=platform), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / 'installation'
                app = '[App]\nName=Firefox\nVersion=158.0\nBuildID=20261012115900\n'
                def create_core(target):
                    target.mkdir(parents=True)
                    (target / ('firefox.exe' if platform == 'windows-x64' else 'firefox')).write_bytes(b'fixture binary')
                    (target / 'application.ini').write_text(app, encoding='utf-8')
                    (target / 'platform.ini').write_text('[Build]\nBuildID=20261012115900\n', encoding='utf-8')
                def download(_entry, archive):
                    if platform == 'linux-x64':
                        source = Path(directory) / 'source/firefox'
                        create_core(source)
                        with tarfile.open(archive, 'w:xz') as package:
                            package.add(source, arcname='firefox')
                def command(args, **_kwargs):
                    self.assertEqual(args[1:3], ['x', '-y'], 'Windows installers are extracted, never installed system-wide')
                    create_core(output / 'core')
                with patch.object(setup, 'platform_key', return_value=platform), patch.object(setup, 'download', side_effect=download), patch.object(setup.subprocess, 'run', side_effect=command), contextlib.redirect_stdout(io.StringIO()):
                    receipt = setup.install('158.0', output, 'firefox')
                    setup.validate_installation(receipt, 'firefox', '158.0')
                self.assertEqual(receipt['product'], 'Firefox')
                self.assertEqual(receipt['metadata']['application.ini']['App']['Version'], '158.0')

    def test_browser_quits_before_profile_cleanup(self):
        events = []
        client = Mock()
        def command(name):
            events.append(name)
            return {'cause': 'shutdown', 'forced': False, 'in_app': True}
        client.call.side_effect = command
        client.connection.close.side_effect = lambda: events.append('socket closed')
        process = Mock()
        def wait(timeout):
            self.assertEqual(timeout, 15)
            events.append('process exited')
            return 0
        process.wait.side_effect = wait
        record = {}
        acceptance.shutdown_browser(client, process, record)
        self.assertEqual(events, ['Marionette:Quit', 'socket closed', 'process exited'])
        self.assertEqual(record['shutdown']['cause'], 'shutdown')
        self.assertIn('shutdownMs', record)

    def test_shutdown_timeout_remains_a_failure(self):
        client = Mock()
        client.call.return_value = {'cause': 'shutdown', 'forced': False}
        process = Mock()
        process.wait.side_effect = acceptance.subprocess.TimeoutExpired('waterfox', 15)
        record = {}
        with self.assertRaises(acceptance.subprocess.TimeoutExpired):
            acceptance.shutdown_browser(client, process, record)
        self.assertIn('shutdownMs', record)

    def test_forced_or_abnormal_shutdown_remains_a_failure(self):
        for details, returncode in [({'cause': 'restart', 'forced': False}, 0), ({'cause': 'shutdown', 'forced': True}, 0), ({'cause': 'shutdown', 'forced': False}, 1)]:
            with self.subTest(details=details, returncode=returncode):
                client, process = Mock(), Mock()
                client.call.return_value = details
                process.wait.return_value = returncode
                with self.assertRaises(AssertionError):
                    acceptance.shutdown_browser(client, process, {})

    def test_failure_receipt_survives_cleanup_error(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            with patch.object(acceptance.subprocess, 'Popen', side_effect=RuntimeError('fixture launch failed')), patch.object(acceptance, 'stop', side_effect=RuntimeError('cleanup failed')), contextlib.redirect_stdout(io.StringIO()):
                result = acceptance.run_case({}, output, 'viewer-6', True)
            saved = json.loads((output / 'report.json').read_text(encoding='utf-8'))
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(saved['error'], 'fixture launch failed')
            self.assertIn('cleanup failed', saved['cleanupErrors'])

    def test_initial_viewer_wait_requires_rendered_connected_lights(self):
        class WaitCaptured(Exception):
            pass
        client = Mock()
        client.wait.side_effect = [None, WaitCaptured()]
        items = [{'entity_id': 'light.fixture_a', 'name': 'A'},
                 {'entity_id': 'light.fixture_b', 'name': 'B'}]
        with self.assertRaises(WaitCaptured):
            acceptance.viewer(client, 'http://127.0.0.1', {'floors': [{'items': items}]}, {'samples': []}, Mock())
        condition = client.wait.call_args_list[1].args[0]
        self.assertIn("dataset.connected==='true'", condition)
        self.assertIn('window.floorplan?.renderCount>0', condition)
        self.assertIn('window.__nativeRenderedLights===2', condition)

    def test_viewer_state_waits_for_the_new_frame(self):
        client = Mock()
        client.execute.return_value = 41
        acceptance.update_viewer_state(client, {'light.fixture': {'state': 'off'}}, 0)
        client.wait.assert_called_once_with('window.__nativeRenderedLights===0 && window.floorplan.renderCount>41')
        self.assertEqual(client.method_calls[0], unittest.mock.call.execute('return window.floorplan.renderCount;'))
        self.assertEqual(client.method_calls[-1][0], 'wait')

    def test_viewer_srcdoc_preserves_literal_diagnostic_source(self):
        class BootstrapCaptured(Exception):
            pass
        client = Mock()
        client.wait.side_effect = BootstrapCaptured()
        with self.assertRaises(BootstrapCaptured):
            acceptance.viewer(client, 'http://127.0.0.1', {'floors': [{'items': []}]}, {'samples': []}, Mock())
        # Exercise the actual bootstrap and both complete diagnostic helpers.
        # No browser, network or generated JavaScript is executed beyond the
        # bootstrap's mocked iframe transport; emitted scripts are syntax parsed.
        script, items, states, diagnostics, frame = client.execute.call_args.args
        javascript = r"""
const assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const tokens = ["$'", '$`', '$&', '$$'];
const head = input.diagnostics + '\nwindow.__headTokens=' + JSON.stringify(tokens) + ';\n';
const frame = input.frame + '\nwindow.__frameTokens=' + JSON.stringify(tokens) + ';\n';
const html = '<!doctype html><html><head></head><body><script>const renderer=null;\n</script></body>\n</html>';
let complete;
const captured = new Promise(resolve => { complete = resolve; });
const context = {window:{}, crypto:{randomUUID:()=> 'fixture-token'},
  fetch:async url=>{assert.equal(url,'/viewer');return {text:async()=>html};},
  document:{createElement:tag=>{assert.equal(tag,'iframe');return {style:{}};},
    body:{append:iframe=>complete(iframe.srcdoc)}},
  arguments:[input.items,input.states,head,frame]};
vm.runInNewContext('(function(){' + input.script + '}).apply(null,arguments)',context,{timeout:2000});
captured.then(srcdoc=>{
  assert(srcdoc.includes(head),'Head diagnostic source must be inserted byte-for-byte');
  assert(srcdoc.includes(frame),'Frame diagnostic source must be inserted byte-for-byte');
  const scripts=[...srcdoc.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length,2,'Only the intended head and original viewer scripts exist');
  for(const [index,match] of scripts.entries())new vm.Script(match[1],{filename:'emitted-srcdoc-'+index});
  assert(srcdoc.endsWith('</script></body>\n</html>'),'The original trailing document remains intact');
  process.stdout.write('literal-srcdoc-pass\n');
}).catch(error=>{console.error(error.stack);process.exitCode=1;});
"""
        result = subprocess.run(['node', '-e', javascript], input=json.dumps({
            'script': script, 'items': items, 'states': states,
            'diagnostics': diagnostics, 'frame': frame}),
            text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'literal-srcdoc-pass\n')

    def test_pointer_release_requires_a_full_scene_frame(self):
        scene = {'drawingBuffer': [632, 394],
                 'renderPasses': {'last': 'scene', 'sceneViewport': [0, 0, 632, 394]}}
        acceptance.assert_full_viewer_frame(scene)
        scene['renderPasses']['last'] = 'copy'
        with self.assertRaisesRegex(AssertionError, 'full scene draw'):
            acceptance.assert_full_viewer_frame(scene)
        scene['renderPasses'] = {'last': 'scene', 'sceneViewport': [0, 0, 316, 197]}
        with self.assertRaisesRegex(AssertionError, 'original drawing-buffer'):
            acceptance.assert_full_viewer_frame(scene)

    def test_real_gesture_requires_bounded_copy_and_full_release(self):
        before = {'scene': {'renderPasses': {'copy': 0}}}
        after = {'gpu': {'unmaskedRenderer': 'Apple Software Renderer'}, 'scene': {
            'drawingBuffer': [632, 394], 'renderPasses': {'copy': 1, 'motionDrawCalls': 91, 'motionSceneDrawCalls': 90, 'last': 'scene',
            'sceneViewport': [0, 0, 632, 394], 'motionSceneViewport': [0, 0, 316, 197],
            'copyViewport': [0, 0, 632, 394], 'motionBuffer': [632, 394]}}}
        acceptance.assert_viewer_interaction(before, after)
        for patch_value in ({'copy': 0}, {'motionDrawCalls': 90}, {'motionSceneViewport': [0, 0, 632, 394]},
                            {'copyViewport': [0, 0, 631, 394]}):
            changed = json.loads(json.dumps(after))
            changed['scene']['renderPasses'].update(patch_value)
            with self.assertRaises(AssertionError):
                acceptance.assert_viewer_interaction(before, changed)
        after['gpu']['unmaskedRenderer'] = 'Apple M5 Pro'
        with self.assertRaisesRegex(AssertionError, 'direct rendering'):
            acceptance.assert_viewer_interaction(before, after)
        after['scene']['renderPasses']['copy'] = 0
        acceptance.assert_viewer_interaction(before, after)

    def test_frame_marker_updates_only_after_real_render(self):
        javascript = r"""
const assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
let active = 18, fail = false;
const env = {renderer:{render(){if(fail)throw Error('draw failed');return 42;}},
  __browserScene:()=>({activePointLights:active})};
env.window=env;
vm.runInNewContext(fs.readFileSync(0,'utf8'),env);
assert.equal(env.renderer.render(),42);
active=0;
assert.equal(env.__nativeRenderedLights,18,'A CPU state update must not count as a frame');
env.renderer.render();
assert.equal(env.__nativeRenderedLights,0);
active=9;
env.renderer.render({name:'interaction-copy'});
assert.equal(env.__nativeRenderedLights,0,'A copy pass cannot certify new state');
fail=true;
assert.throws(()=>env.renderer.render());
assert.equal(env.__nativeRenderedLights,0,'A failed draw must not count as the new state');
"""
        result = subprocess.run(['node', '-e', javascript], input=acceptance.NATIVE_VIEWER_FRAME_DIAGNOSTICS,
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_native_graphics_requires_real_error_evidence(self):
        for evidence in (None, {}, {'contexts':1, 'samples':[{}]}, {'contexts':1, 'samples':[], 'errors':[]},
                         {'contexts':1, 'samples':[{}], 'errors':[{'code':1282, 'label':'pagehide'}]}):
            with self.subTest(evidence=evidence), self.assertRaises(AssertionError):
                acceptance.assert_native_graphics(evidence)

    def test_teardown_requires_a_real_pagehide_sample(self):
        with self.assertRaises(AssertionError):
            acceptance.assert_native_graphics({'contexts':1, 'samples':[{'label':'snapshot'}], 'errors':[]}, teardown=True)

    def test_teardown_preserves_late_application_errors(self):
        javascript = r"""
const vm = require('node:vm'), fs = require('node:fs');
const source = fs.readFileSync(0, 'utf8'), receipts = [];
for (const name of ['__plannerStats', '__browserStability']) {
  const stats = {errors:[], shaderErrors:[], contextLosses:1}, events = [];
  let lost = false, receipt;
  const gl = {NO_ERROR:0, isContextLost:()=>lost, getError:()=>0, getExtension:()=>null};
  class Canvas { getContext() {return gl;} }
  const env = {HTMLCanvasElement:Canvas, document:{readyState:'complete'}, [name]:stats,
    addEventListener:(name,fn)=>{if(name==='pagehide')events.push(fn);},
    sessionStorage:{setItem(key,value){receipt=JSON.parse(value);}}};
  env.window=env;
  env.parent=name==='__browserStability'?{postMessage(value){receipt=JSON.parse(JSON.stringify(value.evidence));}}:env;
  // These failures occur in app cleanup, after its final successful snapshot.
  events.push(()=>{stats.errors.push('disposePreview failed');stats.shaderErrors.push('late shader failure');stats.contextLosses++;lost=true;});
  vm.runInNewContext(source, env);
  new Canvas().getContext('webgl2');
  const before = env.__sampleNativeGraphics('last-snapshot');
  for(const handler of events)handler();
  receipts.push({before, receipt});
}
process.stdout.write(JSON.stringify(receipts));
"""
        result = subprocess.run(['node', '-e', javascript], input=acceptance.NATIVE_GL_DIAGNOSTICS,
                                text=True, capture_output=True, timeout=10, check=True)
        for case in json.loads(result.stdout):
            acceptance.assert_native_graphics(case['before'])
            evidence = case['receipt']
            self.assertEqual(evidence['application']['errors'], ['disposePreview failed'])
            self.assertEqual(evidence['application']['shaderErrors'], ['late shader failure'])
            with self.assertRaisesRegex(AssertionError, 'disposePreview failed'):
                acceptance.assert_native_graphics(evidence, teardown=True)
            evidence['application']['errors'] = []
            with self.assertRaisesRegex(AssertionError, 'late shader failure'):
                acceptance.assert_native_graphics(evidence, teardown=True)
            evidence['application']['shaderErrors'] = []
            self.assertEqual(evidence['application']['contextLosses'], 2)
            acceptance.assert_native_graphics(evidence, teardown=True)

    def test_teardown_requires_application_error_evidence(self):
        evidence = {'contexts':1, 'samples':[{'label':'pagehide'}], 'errors':[]}
        for application in (None, {}, {'errors':[]}, {'shaderErrors':[]}):
            with self.subTest(application=application), self.assertRaises(AssertionError):
                acceptance.assert_native_graphics({**evidence, 'application':application}, teardown=True)

    def test_gl_errors_survive_context_loss_and_navigation(self):
        # Execute the exact injected JS against GL flags that behave like a
        # driver: loseContext clears pending flags before pagehide can read them.
        javascript = r"""
const assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const source = fs.readFileSync(0, 'utf8');
for (const child of [false, true]) {
  let lost = false, reads = 0, flags = [], stored, posted;
  const extension = {loseContext() {lost = true; flags = [];}};
  const gl = {NO_ERROR:0, isContextLost:()=>lost, getError:()=>{reads++;return flags.shift()||0;}, getExtension:()=>extension};
  const events = [];
  class Canvas { getContext() {return gl;} }
  const env = {HTMLCanvasElement:Canvas, document:{readyState:'complete'},
    addEventListener: (name, fn) => {if(name==='pagehide')events.push(fn);},
    sessionStorage:{setItem(key,value){stored=JSON.parse(value);}}};
  env.window=env;env.parent=child?{postMessage(value){posted=value.evidence;}}:env;
  vm.runInNewContext(source, env);
  new Canvas().getContext('webgl2');
  assert.equal(reads,0,'Installing diagnostics must not poll GL on draws');
  flags.push(1282);assert.equal(gl.getError(),1282,'Application getError semantics remain intact');
  flags.push(1281);gl.getExtension('WEBGL_lose_context').loseContext();
  assert.equal(flags.length,0);
  lost=false;env.__sampleNativeGraphics('restored');
  flags.push(1282);gl.getExtension('WEBGL_lose_context').loseContext();
  for(const handler of events)handler();
  const evidence=child?posted:stored;
  assert.equal(evidence.contexts,1);
  assert.deepEqual(Array.from(evidence.errors,value=>value.code),[1282,1281,1282]);
  assert.equal(evidence.samples.at(-1).label,'pagehide');
}
"""
        result = subprocess.run(['node', '-e', javascript], input=acceptance.NATIVE_GL_DIAGNOSTICS,
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_recovered_pointer_input_must_render_and_move(self):
        stats = {'contexts': 1, 'contextLosses': 1, 'gpu': {'version': 'WebGL 2.0'}, 'linkedPrograms': 2, 'shaderErrors': [], 'errors': [], 'nativeGraphics': {'contexts': 1, 'samples': [{'label':'test'}], 'errors': []}}
        acceptance.assert_recovered_interaction(4, 5, [0, 1], [1, 2], stats)
        for after_count, after_camera, after_stats in [(4, [1, 2], stats), (5, [0, 1], stats), (5, [1, 2], {**stats, 'errors': ['recovered input failed']})]:
            with self.subTest(after_count=after_count, after_camera=after_camera), self.assertRaises(AssertionError):
                acceptance.assert_recovered_interaction(4, after_count, [0, 1], after_camera, after_stats)

    def test_recovery_rejects_extra_context_loss_even_if_frames_resume(self):
        stats = {'contexts':1, 'contextLosses':2, 'gpu':{'version':'WebGL 2.0'}, 'linkedPrograms':3,
                 'shaderErrors':[], 'errors':[], 'nativeGraphics':{'contexts':1, 'samples':[{'label':'restored'}], 'errors':[]}}
        with self.assertRaisesRegex(AssertionError, 'context loss'):
            acceptance.assert_recovered_interaction(4, 5, [0, 1], [1, 2], stats)

    def test_graphics_failure_cannot_be_skipped(self):
        stats = {'contexts': 1, 'gpu': {'version': 'WebGL 2.0'}, 'linkedPrograms': 1, 'shaderErrors': [], 'errors': [], 'nativeGraphics': {'contexts': 1, 'samples': [{'label':'test'}], 'errors': []}}
        acceptance.assert_graphics(stats)
        for changed in ({'contexts': 0}, {'linkedPrograms': 0}, {'gpu': {'version': 'WebGL 1.0'}}, {'shaderErrors': ['failed']}, {'errors': ['uncaught']}):
            with self.subTest(changed=changed), self.assertRaises(AssertionError):
                acceptance.assert_graphics({**stats, **changed})

    def test_replacement_requires_matched_retirement_and_one_live_context(self):
        acceptance.assert_recovered_interaction(4, 5, [0, 1], [1, 2], replacement_stats(), replacement=True)
        # The viewer keeps its original one-context contract.
        with self.assertRaises(AssertionError):
            acceptance.assert_recovered_graphics(replacement_stats())
        invalid = [
            (['contexts'], 3), (['contextLosses'], 3), (['retiredContextLosses'], 2),
            (['restoredBuffers'], []), (['restoredBuffers', 0, 'contextId'], 2),
            (['restoredBuffers', 0, 'lost'], True), (['restoredBuffers', 0, 'canvas'], [800,600]),
            (['restoredBuffers', 0, 'drawingBuffer'], [800,600]),
            (['contextLossRequests', 1, 'matched'], False),
            (['contextLossRequests', 1, 'retirement'], False),
            (['contextLossRequests', 1, 'contextId'], 2),
            (['contextEvents', 1, 'lossRequest'], None),
            (['contextEvents', 1, 'retired'], False),
            (['contextStates', 0, 'lost'], False), (['contextStates', 0, 'attached'], True),
            (['contextStates', 1, 'lost'], True), (['contextStates', 1, 'restores'], 1),
            (['nativeGraphics', 'contexts'], 1),
            (['nativeGraphics', 'samples', 0, 'states', 0, 'lost'], False),
            (['nativeGraphics', 'samples', 0, 'states', 1, 'lost'], True),
            (['nativeGraphics', 'lossRequests'], [{'contextId':1, 'attached':True}]),
            (['nativeGraphics', 'errors'], [{'code':1282, 'label':'before-context-loss'}]),
            (['errors'], ['replacement failed']), (['shaderErrors'], [None]),
        ]
        for path, value in invalid:
            stats = replacement_stats()
            target = stats
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            with self.subTest(path=path), self.assertRaises(AssertionError):
                acceptance.assert_recovered_interaction(4, 5, [0, 1], [1, 2], stats, replacement=True)

    def test_replacement_teardown_requires_retired_context_and_explicit_final_cleanup(self):
        stats = replacement_stats()
        evidence = stats.pop('nativeGraphics')
        evidence['application'] = stats
        evidence['samples'][-1]['label'] = 'pagehide'
        evidence['samples'][-1]['states'][1]['lost'] = True
        stats['contextStates'][1]['lost'] = True
        evidence['lossRequests'].append({'contextId':2, 'attached':True})
        stats['contextLossRequests'].append({'id':3, 'contextId':2, 'attached':True, 'retirement':False, 'matched':False})
        # pagehide may save before the asynchronous final loss event arrives.
        acceptance.assert_native_graphics(evidence, teardown=True, replacement=True)
        stats['contextLossRequests'][-1]['matched'] = True
        stats['contextEvents'].append({'type':'webglcontextlost', 'contextId':2, 'lossRequest':3, 'retired':False})
        stats['contextLosses'] = 3
        acceptance.assert_native_graphics(evidence, teardown=True, replacement=True)
        for path, value in [(['lossRequests'], []),
                            (['samples', 0, 'states', 0, 'lost'], False),
                            (['application', 'contextEvents', 2, 'lossRequest'], None),
                            (['application', 'contextLossRequests', 2, 'contextId'], 1),
                            (['application', 'errors'], ['late disposal failure'])]:
            changed = json.loads(json.dumps(evidence))
            target = changed
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            with self.subTest(path=path), self.assertRaises(AssertionError):
                acceptance.assert_native_graphics(changed, teardown=True, replacement=True)

    def test_native_monitor_independently_tracks_replaced_context_and_loss_requests(self):
        javascript = r"""
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
class Canvas {
  constructor(){this.isConnected=true;this.lost=false;const canvas=this;
    const extension={loseContext(){canvas.lost=true;}};
    this.gl={NO_ERROR:0,getError:()=>0,isContextLost:()=>canvas.lost,getExtension:()=>extension};}
  getContext(){return this.gl;}
}
const env={HTMLCanvasElement:Canvas,document:{readyState:'complete'},addEventListener(){}};
env.window=env;env.parent=env;vm.runInNewContext(fs.readFileSync(0,'utf8'),env);
const old=new Canvas(),first=old.getContext('webgl2');
first.getExtension('WEBGL_lose_context').loseContext();old.lost=false;old.isConnected=false;
first.getExtension('webgl_lose_context').loseContext();
const active=new Canvas();active.getContext('webgl2');active.getContext('webgl2');
const value=env.__sampleNativeGraphics('recovery');
assert.equal(value.contexts,2,'Repeated getContext does not invent a third context');
assert.deepEqual(JSON.parse(JSON.stringify(value.lossRequests)),[{contextId:1,attached:true},{contextId:1,attached:false}]);
assert.deepEqual(JSON.parse(JSON.stringify(value.samples.at(-1).states)),[{id:1,attached:false,lost:true},{id:2,attached:true,lost:false}]);
"""
        result = subprocess.run(['node', '-e', javascript], input=acceptance.NATIVE_GL_DIAGNOSTICS,
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)


class MaskedCapacityTests(unittest.TestCase):
    def record(self, reduced=True, planner=False):
        times = [16, 17, 18] if reduced else [1, 2, 3]
        size = 512 if reduced else 2048
        scene = {'rasterProbe':{'status':'measured','samplesMs':times,'bestMs':min(times),'totalMs':100,
                               'pixels':[[88+i,88+i,88+i,255] for i in range(5)]},
                 'drawingBuffer':[500,500] if reduced else [1400,1000],
                 'materialTypes':['MeshLambertMaterial' if reduced else 'MeshStandardMaterial','MeshBasicMaterial'],
                 'shadowType':0 if reduced else 2, 'pointLights':18,
                 'shadowMaps':[['DirectionalLight',size,size]] + [['PointLight',128 if reduced else 256,128 if reduced else 256]] * (2 if reduced else 8),
                 'shadowMap':[size,size]}
        gpu = {'renderer':'Apple M1, or similar'} if planner else {'renderer':'WebKit WebGL', 'unmaskedRenderer':'Apple M1, or similar','textureUnits':16,'maxTextureSize':4096}
        snapshot = {'scene':scene, **({'stats':{'gpu':gpu}} if planner else {'gpu':gpu})}
        return {'preferences':{'webgl.sanitize-unmasked-renderer':True}, 'userAgent':'Mozilla/5.0 Gecko/20100101 Firefox/153.0',
                'suite':'planner-256' if planner else 'viewer-6', 'samples':[{'initial':snapshot}]}

    def test_measured_fast_and_slow_capacity_require_real_scene_properties(self):
        for reduced in (False, True):
            for planner in (False, True):
                record = self.record(reduced, planner)
                acceptance.assert_masked_capacity(record)
                scene = record['samples'][0]['initial']['scene']
                scene['materialTypes'] = ['MeshStandardMaterial' if reduced else 'MeshLambertMaterial']
                with self.assertRaisesRegex(AssertionError, 'Actual materials'):
                    acceptance.assert_masked_capacity(record)

    def test_masked_evidence_rejects_missing_blank_constant_and_inconsistent_measurements(self):
        mutations = [
            lambda p: p.update(status='unavailable'), lambda p: p.update(bestMs=1),
            lambda p: p.update(samplesMs=[16,17]), lambda p: p.update(samplesMs=[16,float('nan'),18]),
            lambda p: p.update(totalMs=1), lambda p: p.update(totalMs=float('inf')),
            lambda p: p.update(pixels=[[0,0,0,255]] * 5), lambda p: p.update(pixels=[[255,255,255,255]] * 5),
            lambda p: p.update(pixels=[[88,88,88,255]] * 5), lambda p: p.update(pixels=[[88,88,88,0]] * 5),
            lambda p: p.update(identity='software'), lambda p: p.pop('pixels'),
        ]
        for mutate in mutations:
            record = self.record()
            mutate(record['samples'][0]['initial']['scene']['rasterProbe'])
            with self.assertRaises(AssertionError):
                acceptance.assert_masked_capacity(record)

    def test_capacity_cannot_be_faked_with_profile_flags_or_wrong_raw_identity(self):
        for field, value in [('drawingBuffer',[1000,1000]), ('shadowType',2),
                             ('shadowMaps',[['DirectionalLight',2048,2048]]), ('rasterProbe',None)]:
            record = self.record()
            scene = record['samples'][0]['initial']['scene']
            scene.update(reduced=True, diffuseLighting=True)
            scene[field] = value
            with self.assertRaises(AssertionError):
                acceptance.assert_masked_capacity(record)
        record = self.record()
        record['samples'][0]['initial']['gpu']['unmaskedRenderer'] = 'Apple Software Renderer'
        with self.assertRaisesRegex(AssertionError, 'opaque Apple'):
            acceptance.assert_masked_capacity(record)
        record = self.record()
        record['userAgent'] = 'AppleWebKit/537.36 like Gecko'
        with self.assertRaisesRegex(AssertionError, 'actual Gecko'):
            acceptance.assert_masked_capacity(record)

    def test_planner_and_viewer_renderer_schemas_remain_exact(self):
        for planner in (False, True):
            for unmasked in (None, '', 'Apple M1, or similar'):
                record = self.record(planner=planner)
                snapshot = record['samples'][0]['initial']
                gpu = snapshot.get('stats', snapshot)['gpu']
                gpu.update(renderer='Apple M1, or similar', unmaskedRenderer=unmasked)
                acceptance.assert_masked_capacity(record)
            for renderer, unmasked in [('Other GPU', None), ('Apple M1, or similar', 'Other GPU'), ('Apple Software Renderer', '')]:
                gpu.update(renderer=renderer, unmaskedRenderer=unmasked)
                with self.assertRaisesRegex(AssertionError, 'opaque Apple'):
                    acceptance.assert_masked_capacity(record)

    def test_point_shadow_faces_obey_texture_and_aggregate_atlas_budgets(self):
        for count, limit, ceiling, expected in [
            (0,4096,512,512), (2,4096,128,128), (2,4096,512,512), (8,4096,512,256),
            (8,1024,512,256), (8,512,512,128), (2,256,128,64), (0,64,512,16),
            (8,1000,512,128), (8,16384,512,256)]:
            with self.subTest(count=count, limit=limit, ceiling=ceiling):
                self.assertEqual(acceptance.expected_point_shadow_face(count,limit,ceiling),expected)
        for count in (0,2,8):
            record = self.record(reduced=False)
            scene = record['samples'][0]['initial']['scene']
            scene['pointLights'] = count
            face = 256 if count == 8 else 512
            scene['shadowMaps'] = [['DirectionalLight',2048,2048]] + [['PointLight',face,face]] * count
            acceptance.assert_masked_capacity(record)
            if count:
                scene['shadowMaps'][-1] = ['PointLight',face//2,face//2]
                with self.assertRaisesRegex(AssertionError, 'Actual point shadows'):
                    acceptance.assert_masked_capacity(record)
        record = self.record(reduced=False)
        del record['samples'][0]['initial']['gpu']['maxTextureSize']
        with self.assertRaisesRegex(AssertionError, 'actual texture size limit'):
            acceptance.assert_masked_capacity(record)

    def test_unmasked_rows_keep_their_existing_acceptance_path(self):
        acceptance.assert_masked_capacity({'preferences':{'webgl.sanitize-unmasked-renderer':False}})


if __name__ == '__main__':
    unittest.main()
