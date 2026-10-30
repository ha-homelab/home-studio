"""Preserve viewer translations while reducing the actual compiled runtime."""
import copy
import gzip
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import runpy
import shutil
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from planner import project
from viewer_locales import load_viewer_i18n, viewer_i18n_expression


def legacy_expression(data):
    """The previous compiler output is the comparison, including script escaping."""
    return (json.dumps(data, ensure_ascii=False, separators=(",", ":"))
            .replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"))


class ViewerLocaleTests(unittest.TestCase):
    def roundtrip(self, original, baseline=None):
        expression = viewer_i18n_expression(original)
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is required to execute the emitted decoder")
        script = r"""
const assert = require('node:assert/strict'), vm = require('node:vm');
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const decoded = vm.runInNewContext(input.expression, {}, {timeout: 1000});
const actual = JSON.parse(JSON.stringify(decoded));
assert.deepEqual(actual, input.original);
for (const [code, dictionary] of Object.entries(input.original.dictionaries)) {
  assert.deepEqual(Object.keys(decoded.dictionaries[code]).sort(), Object.keys(dictionary).sort());
  for (const key of Object.keys(dictionary)) assert(Object.hasOwn(decoded.dictionaries[code], key));
}
const create = vm.runInNewContext(input.runtime + '\ncreateViewerI18n', {}, {timeout: 1000});
const before = create(input.baseline, {}), after = create(actual, {});
const keys = new Set(Object.values(input.baseline.dictionaries).flatMap(Object.keys));
keys.add('Missing translation {example}');
const params = Object.fromEntries(Array.from([...keys].join(' ').matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g),
  match => [match[1], '<literal> {unchanged}']));
let translations = 0;
for (const {code} of input.original.locales) {
  assert.equal(before.setLocale(code, {source: 'host'}), true);
  assert.equal(after.setLocale(code, {source: 'host'}), true);
  for (const key of keys) {
    assert.equal(after.t(key), before.t(key));
    assert.equal(after.t(key, params), before.t(key, params));
    translations++;
  }
}
console.log(JSON.stringify({locales: actual.locales.length, translations}));
"""
        result = subprocess.run([node, "-e", script], input=json.dumps({
            "expression": expression, "original": original, "baseline": baseline or original,
            "runtime": (ROOT / "viewer-i18n.js").read_text()}),
            text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return expression, json.loads(result.stdout)

    def test_absent_empty_unicode_and_literal_keys_survive_script_embedding(self):
        data = {"locales": [{"code": "en", "name": "English"}, {"code": "xx", "dir": "rtl"}],
                "dictionaries": {"en": {"fallback": "English", "empty": "", "__proto__": "literal",
                                         "constructor": "text", "token": "__HOME_JS__",
                                         "script": "</script><script>throw Error('literal')</script>",
                                         "unicode": "日本語\u2028\u2029", "Hello {name}": "Hello {name}"},
                                 "xx": {"empty": "", "extra": "Local", "unicode": "العربية"}}}
        before = copy.deepcopy(data)
        expression, result = self.roundtrip(data)
        self.assertEqual(data, before, "Encoding must not mutate its input")
        self.assertEqual(expression, viewer_i18n_expression(data), "Encoding is deterministic")
        self.assertNotIn("<", expression)
        self.assertNotIn("\u2028", expression)
        self.assertNotIn("\u2029", expression)
        self.assertIn("\\u003c/script>", expression)
        self.assertEqual(result["locales"], 2)

    def test_empty_dictionaries_remain_empty(self):
        self.roundtrip({"locales": [{"code": "en"}], "dictionaries": {"en": {}}})

    def test_invalid_catalogs_are_rejected_instead_of_dropping_values(self):
        invalid = [None, [], {}, {"locales": {}, "dictionaries": {"en": {}}},
                   {"locales": [], "dictionaries": {}}, {"locales": [], "dictionaries": {"fr": {}}},
                   {"locales": [], "dictionaries": {"en": []}},
                   {"locales": [], "dictionaries": {"en": {}, 1: {}}},
                   {"locales": [], "dictionaries": {"en": {1: "text"}}},
                   {"locales": [], "dictionaries": {"en": {}}, "extra": "cannot disappear"},
                   {"locales": [{"code": "en", "value": float("nan")}], "dictionaries": {"en": {}}}]
        invalid.extend({"locales": [], "dictionaries": {"en": {"key": value}}}
                       for value in [None, False, 3, [], {}])
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                viewer_i18n_expression(value)

    def test_all_24_catalogs_keep_every_translation_and_english_fallback(self):
        compact = load_viewer_i18n(ROOT)
        full = {"locales": compact["locales"], "dictionaries": {
            row["code"]: json.loads((ROOT / "viewer-locales" / (row["code"] + ".json")).read_text())
            for row in compact["locales"]}}
        _, result = self.roundtrip(compact, full)
        self.assertEqual(result["locales"], 24)
        self.assertGreater(result["translations"], 3000)

    def test_generated_panel_keeps_all_552_source_strings(self):
        generator = runpy.run_path(str(ROOT / "scripts/build-panel-locales.py"))
        locales = json.loads((ROOT / "viewer-locales/index.json").read_text())
        expected = {}
        for locale in locales:
            dictionary = json.loads((ROOT / "viewer-locales" / (locale["code"] + ".json")).read_text())
            expected[locale["code"]] = {key: dictionary[key] for key in generator["KEYS"]}
        generated = generator["generate"]()
        panel = generator["PANEL"].read_text()
        self.assertEqual(panel.split(generator["BEGIN"], 1)[1].split(generator["END"], 1)[0],
                         generated.split(generator["BEGIN"], 1)[1].split(generator["END"], 1)[0],
                         "The checked-in panel must use the current generated messages")
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is required to execute the generated panel messages")
        script = r"""
const assert = require('node:assert/strict'), vm = require('node:vm');
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const messages = vm.runInNewContext(input.generated + '\npanelMessages', {}, {timeout: 1000});
assert.deepEqual(JSON.parse(JSON.stringify(messages)), input.expected);
assert.equal(Object.keys(messages).length, 24);
assert.equal(Object.values(messages).reduce((sum, dictionary) => sum + Object.keys(dictionary).length, 0), 552);
"""
        result = subprocess.run([node, "-e", script], input=json.dumps({
            "generated": generated, "expected": expected}),
            text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_actual_render_changes_only_catalog_encoding_and_reduces_runtime(self):
        fixture = project.validate_project(json.loads((ROOT / "planner/example-home.json").read_text()))
        data, svg = project.make_floor(fixture, fixture["floors"][0], None)
        original = copy.deepcopy(data)
        actual = project.render_viewer(data, svg)
        with patch.object(project, "viewer_i18n_expression", legacy_expression):
            previous = project.render_viewer(data, svg)
        self.assertEqual(data, original, "Rendering must not change model data")
        catalog = load_viewer_i18n(ROOT)
        encoded, legacy = viewer_i18n_expression(catalog), legacy_expression(catalog)
        self.assertEqual(actual.count(encoded), 1)
        self.assertEqual(previous.count(legacy), 1)
        self.assertEqual(actual.replace(encoded, legacy), previous,
                         "Geometry, model JSON, other runtime modules and HTML stay byte-identical")
        def executable(html):
            class Scripts(HTMLParser):
                def __init__(self):
                    super().__init__(convert_charrefs=False)
                    self.bodies = []
                    self.active = False

                def handle_starttag(self, tag, attrs):
                    if tag == "script":
                        self.active = (dict(attrs).get("type") or "").lower() != "application/json"
                        if self.active:
                            self.bodies.append("")

                def handle_data(self, data):
                    if self.active:
                        self.bodies[-1] += data

                def handle_endtag(self, tag):
                    if tag == "script":
                        self.active = False

            parser = Scripts()
            parser.feed(html)
            parser.close()
            source = "\n".join(parser.bodies)
            return re.sub(r"(?<=import \* as THREE from 'data:text/javascript;base64,)[^']+", "", source).encode()
        self.assertEqual(executable('<SCRIPT TYPE="APPLICATION/JSON">{}</SCRIPT >'
                                    '<ScRiPt>const value = 1;</sCrIpT >'), b'const value = 1;')
        self.assertEqual(executable('<script>const value = 1;</script\t\n bar>'), b'const value = 1;')
        old, new = executable(previous), executable(actual)
        raw_saved = len(old) - len(new)
        gzip_saved = len(gzip.compress(old, mtime=0)) - len(gzip.compress(new, mtime=0))
        self.assertGreater(raw_saved, 75000, "The compiled viewer must not regress to repeated dictionary keys")
        self.assertGreater(gzip_saved, 7500, "The decoder must retain the compressed runtime saving")
        print(json.dumps({"viewer_bytes_saved": {"raw": raw_saved, "gzip": gzip_saved}}))


if __name__ == "__main__":
    unittest.main()
