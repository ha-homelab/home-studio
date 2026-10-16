"""Negative tests for portable, passive documentation assets."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('docs', Path(__file__).with_name('validate-docs.py'))
docs = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(docs)


class DocumentationTests(unittest.TestCase):
    def test_file_checks_reject_escape_symlink_and_case_mismatch(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'Guide.md').write_text('# Guide\n')
            self.assertEqual(docs.regular(root, 'Guide.md'), root / 'Guide.md')
            for name in ['guide.md', '../outside.md', 'missing.md']:
                with self.assertRaises(ValueError):
                    docs.regular(root, name)
            try:
                (root / 'shortcut.md').symlink_to(root / 'Guide.md')
            except (OSError, NotImplementedError):
                return  # Windows may not grant symlink creation to this account.
            with self.assertRaises(ValueError):
                docs.regular(root, 'shortcut.md')

    def test_diagram_requires_accessibility_and_cannot_execute_or_fetch_content(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'diagram.svg'
            wrapper = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">{}</svg>'
            description = '<title>Flow</title><desc>Commands stop at the guard.</desc>'
            path.write_text(wrapper.format(description + '<path d="M0 0L1 1"/>'))
            docs.validate_svg(path)
            for body in ['', '<script>alert(1)</script>', '<rect onclick="run()"/>',
                         '<image href="https://invalid.test/tracker.png"/>',
                         '<foreignObject/>', '<style>rect{fill:url(https://invalid.test/style)}</style>',
                         '<style>@import "https://invalid.test/style.css";</style>',
                         '<style>rect{fill:URL(https://invalid.test/style)}</style>',
                         r'<style>@\69mport "https://invalid.test/style.css";</style>']:
                path.write_text(wrapper.format(description + body) if body else wrapper.format(''))
                with self.assertRaises(ValueError):
                    docs.validate_svg(path)
            path.write_text('<!DOCTYPE svg [<!ENTITY remote SYSTEM "https://invalid.test">]>' + wrapper.format(description))
            with self.assertRaises(ValueError):
                docs.validate_svg(path)


if __name__ == '__main__':
    unittest.main()
