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

    def test_requested_macos_backend_requires_real_metal_renderer(self):
        with patch.dict(acceptance.os.environ, {'FIREFOX_WEBGL_BACKEND': 'angle'}):
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

    def test_viewer_state_waits_for_the_new_frame(self):
        client = Mock()
        client.execute.return_value = 41
        acceptance.update_viewer_state(client, {'light.fixture': {'state': 'off'}}, 0)
        client.wait.assert_called_once_with('window.__nativeRenderedLights===0 && window.floorplan.renderCount>41')
        self.assertEqual(client.method_calls[0], unittest.mock.call.execute('return window.floorplan.renderCount;'))
        self.assertEqual(client.method_calls[-1][0], 'wait')

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
active=9;fail=true;
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
        stats = {'contexts': 1, 'gpu': {'version': 'WebGL 2.0'}, 'linkedPrograms': 2, 'shaderErrors': [], 'errors': [], 'nativeGraphics': {'contexts': 1, 'samples': [{'label':'test'}], 'errors': []}}
        acceptance.assert_recovered_interaction(4, 5, [0, 1], [1, 2], stats)
        for after_count, after_camera, after_stats in [(4, [1, 2], stats), (5, [0, 1], stats), (5, [1, 2], {**stats, 'errors': ['recovered input failed']})]:
            with self.subTest(after_count=after_count, after_camera=after_camera), self.assertRaises(AssertionError):
                acceptance.assert_recovered_interaction(4, after_count, [0, 1], after_camera, after_stats)

    def test_graphics_failure_cannot_be_skipped(self):
        stats = {'contexts': 1, 'gpu': {'version': 'WebGL 2.0'}, 'linkedPrograms': 1, 'shaderErrors': [], 'errors': [], 'nativeGraphics': {'contexts': 1, 'samples': [{'label':'test'}], 'errors': []}}
        acceptance.assert_graphics(stats)
        for changed in ({'contexts': 0}, {'linkedPrograms': 0}, {'gpu': {'version': 'WebGL 1.0'}}, {'shaderErrors': ['failed']}, {'errors': ['uncaught']}):
            with self.subTest(changed=changed), self.assertRaises(AssertionError):
                acceptance.assert_graphics({**stats, **changed})


if __name__ == '__main__':
    unittest.main()
