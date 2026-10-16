"""Run the bundled CPU regressions from a real ZIP, outside the source checkout."""

from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

import package_release as packaging


class SourceReplayTests(unittest.TestCase):
    def test_extracted_cpu_commands_and_reviewed_binary_seeds(self):
        node = shutil.which('node')
        self.assertIsNotNone(node, 'Source replay requires Node.js, as configured in package.yml')
        with tempfile.TemporaryDirectory(prefix='home-studio-replay-') as temporary:
            work = Path(temporary)
            archive = packaging.package(packaging.ROOT, work / 'dist', 'a' * 40)
            with zipfile.ZipFile(archive) as contents:
                contents.extractall(work / 'extracted')
            source = work / 'extracted/home-studio'
            self.assertFalse((source / '.git').exists())
            self.assertFalse((source / 'node_modules').exists())
            replay = sorted(path.relative_to(source).as_posix()
                            for path in (source / 'fuzz').glob('*.test.mjs'))
            self.assertEqual(replay, ['fuzz/project-validation.test.mjs', 'fuzz/wall-geometry.test.mjs'])
            commands = [replay, ['scripts/test-light-state.cjs'],
                        ['scripts/test-tv-screen.cjs'], ['scripts/test-media-preview.cjs'],
                        ['scripts/test-native-draw-diagnostic.cjs'], ['scripts/test-glass-wall-program.cjs'],
                        ['scripts/test-zero-point-block.cjs'], ['scripts/test-point-decay-two.cjs'], ['scripts/test-cached-shadow-transmission.cjs'], ['scripts/test-literal-lambert-directional.cjs'], ['scripts/test-fallback-shared-program.cjs'],
                        ['scripts/test-point-texture-current.cjs'], ['scripts/test-point-run-texture.cjs'], ['scripts/test-static-geometry-atlas.cjs'], ['scripts/test-point-signal-texture.cjs'], ['scripts/test-signal-texture-decay-two.cjs'], ['scripts/test-literal-lambert-point-body.cjs'], ['scripts/test-scalar-shadow-point.cjs'], ['scripts/test-scalar-indirect-lambert.cjs'], ['scripts/test-direct-shadow-uniforms.cjs']]
            for paths in commands:
                with self.subTest(command=['node', '--test', *paths]):
                    result = subprocess.run([node, '--test', *paths], cwd=source,
                                            capture_output=True, text=True, timeout=60)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            for script in ('scripts/test-native-draw-diagnostic.py', 'scripts/test-intel-macos-ci.py'):
                result = subprocess.run([sys.executable, script], cwd=source,
                                        capture_output=True, text=True, timeout=60)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            # Binary corpus support must never become an unchecked archive inlet.
            for name, expected in packaging.public_site.BINARY_REPLAY_SEEDS.items():
                path = source / name
                self.assertEqual(path.read_bytes(), expected)
                path.write_bytes(b'unreviewed replacement')
                with self.assertRaisesRegex(ValueError, 'Unexpected binary replay seed'):
                    packaging.public_site.validate(source)
                path.write_bytes(expected)


if __name__ == '__main__':
    unittest.main()
