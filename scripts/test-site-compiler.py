#!/usr/bin/env python3
"""Portable site validation, floor-local compilation, and legacy roundtrips."""
import copy
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from planner.project import ProjectError, compile_project, load_project, make_floor, validate_project
from planner.site_model import validate_site


def fixture():
    floors = [dict(id=name, name=name.title(), elevation_m=elevation, height_m=2.7,
                   rooms=[dict(id="living", name="Living", material="floor", polygon=[[0, 0], [4, 0], [4, 3], [0, 3]])],
                   walls=[], openings=[], items=[]) for name, elevation in (("upper", 16), ("lower", 10))]
    features = [dict(id=kind + "_1", name=kind.title(), kind=kind, polygon=[[0, 0], [5, 0], [5, 4], [0, 4]],
                     height_m=0 if kind in ("street", "landscape") else 8, color="#8899AA")
                for kind in ("home", "roof", "building", "street", "landscape")]
    return dict(schema_version=1, id="site_compiler_test", title="Site compiler test", floors=floors,
                site=dict(ground_elevation_m=9, features=features))


class SiteCompilerTests(unittest.TestCase):
    def test_validation_is_detached_and_floor_datum_does_not_change_features(self):
        project = fixture()
        original = copy.deepcopy(project)
        validated = validate_project(project)
        self.assertEqual(validated, project)
        validated["site"]["features"][0]["polygon"][0][0] = -1
        self.assertEqual(project, original)
        for floor in project["floors"]:
            data, _ = make_floor(project, floor, None)
            context = data["site_context"]
            self.assertEqual(context["ground_elevation_m"], 9 - floor["elevation_m"])
            self.assertEqual(context["features"], project["site"]["features"])
            self.assertEqual(context["ground_elevation_m"] + context["features"][1]["height_m"], 17 - floor["elevation_m"])
            context["features"][0]["name"] = "Changed preview"
            self.assertEqual(project, original)

    def test_compiled_roundtrip_and_embedded_runtime_match_for_each_floor(self):
        project = fixture()
        source = copy.deepcopy(project)
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "authored"
            compile_project(project, output)
            self.assertEqual(load_project(output / "project.json"), project)
            self.assertEqual(json.loads((output / "project.json").read_text()), source)
            for floor in project["floors"]:
                folder = output / floor["id"]
                data = json.loads((folder / "model-data.json").read_text())
                embedded = json.loads(re.search(r'<script id="modelData" type="application/json">(.*?)</script>', (folder / "index.html").read_text(), re.S).group(1))
                self.assertEqual(embedded["site_context"], data["site_context"])
                self.assertEqual(data["site_context"]["features"], source["site"]["features"])
                self.assertEqual(data["site_context"]["ground_elevation_m"], 9 - floor["elevation_m"])
                self.assertEqual(data["environment"]["elevation"], 9 - floor["elevation_m"])
                self.assertNotIn("roof_outline", data["site_context"])
                self.assertNotIn("latitude", data["site_context"])
                self.assertNotIn("longitude", data["site_context"])
                self.assertLess(data["dimensions_m"]["width"], 5, "Site does not change home control framing")
            self.assertEqual(project, source)

    def test_legacy_roundtrip_keeps_old_ground_and_does_not_invent_site(self):
        project = fixture()
        del project["site"]
        self.assertNotIn("site_context", make_floor(project, project["floors"][0], None)[0])
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "legacy"
            compile_project(project, output)
            self.assertEqual(load_project(output / "project.json"), project)
            for floor in project["floors"]:
                data = json.loads((output / floor["id"] / "model-data.json").read_text())
                self.assertEqual(data["site_context"], dict(ground_elevation_m=10 - floor["elevation_m"]))
            self.assertNotIn("site", json.loads((output / "project.json").read_text()))

    def test_empty_site_and_extreme_valid_datums(self):
        project = fixture()
        for ground, elevation in ((-100, 100), (100, -100)):
            project["site"] = dict(ground_elevation_m=ground, features=[])
            project["floors"][0]["elevation_m"] = elevation
            validate_project(project)
            self.assertEqual(make_floor(project, project["floors"][0], None)[0]["site_context"],
                             dict(ground_elevation_m=ground - elevation, features=[]))

    def test_malformed_geometry_and_private_geography_are_rejected_before_writing(self):
        project = fixture()
        bad_sites = [None, dict(ground_elevation_m=0, features=[], latitude=1),
                     dict(ground_elevation_m=True, features=[]), dict(ground_elevation_m=10 ** 1000, features=[])]
        for change in (dict(kind="road"), dict(height_m=101), dict(color="red"), dict(longitude=1),
                       dict(polygon=[[0, 0], [4, 4], [0, 4], [4, 0], [5, 2]]),
                       dict(polygon=[[0, 0], [4, 0], [2, 0], [2, 4], [0, 4]])):
            site = copy.deepcopy(project["site"])
            site["features"][0].update(change)
            bad_sites.append(site)
        with tempfile.TemporaryDirectory() as temporary:
            for index, site in enumerate(bad_sites):
                with self.subTest(site=site):
                    with self.assertRaises(ValueError):
                        validate_site(site)
                    project["site"] = site
                    output = Path(temporary) / str(index)
                    with self.assertRaises(ProjectError):
                        compile_project(project, output)
                    self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
