"""Repository-owned current-notes check; not part of the public source ZIP."""

import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "current_notes_release_control", ROOT / "scripts/release_control.py"
)
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class CurrentReleaseNotesTests(unittest.TestCase):
    def test_current_notes_render_for_stable_beta_and_rc(self):
        policy = json.loads((ROOT / ".release-policy.json").read_text(encoding="utf-8"))
        manifest = json.loads(
            (ROOT / "custom_components/home_floorplan/manifest.json").read_text(encoding="utf-8")
        )
        raw = (ROOT / "CHANGELOG.md").read_bytes()
        source = "a" * 40
        current_tag = "v" + manifest["version"]
        self.assertIsNotNone(release.TAG_RE.fullmatch(current_tag))
        base = release.VERSION_RE.match(manifest["version"]).group(0)
        response = {
            "type": "file", "path": "CHANGELOG.md", "encoding": "base64",
            "content": base64.b64encode(raw).decode("ascii"), "size": len(raw),
            "sha": hashlib.sha1(b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw,
                                usedforsecurity=False).hexdigest(),
        }
        case = self

        class OfflineGitHub:
            def __init__(self):
                self.calls = []

            def api(self, path, method="GET", body=None):
                case.assertEqual((path, method, body),
                                 (f"contents/CHANGELOG.md?ref={source}", "GET", None))
                case.assertFalse(self.calls, "Only one source-bound contents read is allowed")
                self.calls.append(path)
                return response

            def upload(self, *args, **kwargs):
                raise AssertionError("Release-note validation must not upload anything")

        tags = dict.fromkeys((current_tag, "v" + base, "v" + base + "-beta.1", "v" + base + "-rc.1"))
        for tag in tags:
            with self.subTest(tag=tag):
                github = OfflineGitHub()
                provenance = "Offline current-source validation; no release was published."
                with patch.object(release, "source_policy_snapshot",
                                  return_value={"data": policy}) as snapshot:
                    rendered = release.release_notes(github, tag, source, provenance)
                snapshot.assert_called_once_with(github, source)
                self.assertEqual(github.calls, [f"contents/CHANGELOG.md?ref={source}"])
                self.assertIn("### Upgrade", rendered)
                self.assertIn("### Security", rendered)
                self.assertIn("## Build provenance\n\n" + provenance, rendered)
