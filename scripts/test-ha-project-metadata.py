"""Portable authoring metadata and incomplete draft validation contracts."""
import copy
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from planner.project import ProjectError, make_floor, validate_project


class AuthoringProjectTests(unittest.TestCase):
    def setUp(self):
        self.project = json.loads((ROOT / "planner/guide-assets/practice-home.json").read_text())

    def test_area_metadata_survives_validation_and_compilation(self):
        floor = self.project["floors"][0]
        floor["ha_floor_id"] = "upstairs"
        floor["rooms"][0]["ha_area_id"] = "01JEXAMPLEKITCHEN"
        validated = validate_project(self.project)
        self.assertEqual(validated, self.project)
        validated["floors"][0]["name"] = "Detached copy"
        self.assertNotEqual(validated, self.project)
        data, _ = make_floor(self.project, floor, None)
        self.assertEqual(data["rooms"][0]["ha_area_id"], "01JEXAMPLEKITCHEN")

    def test_blank_floor_can_be_saved_but_not_published(self):
        floor = self.project["floors"][0]
        for key in ("rooms", "walls", "openings", "items"):
            floor[key] = []
        self.assertEqual(validate_project(self.project, complete=False), self.project)
        with self.assertRaises(ProjectError):
            validate_project(self.project)

    def test_draft_validation_does_not_relax_geometry_or_references(self):
        floor = self.project["floors"][0]
        floor["walls"][0]["thickness_m"] = -1
        with self.assertRaises(ProjectError):
            validate_project(self.project, complete=False)

    def test_opaque_registry_ids_are_bounded_text(self):
        for value in (None, 123, "", "x" * 129, "bad\nidentifier"):
            with self.subTest(value=value):
                project = copy.deepcopy(self.project)
                project["floors"][0]["ha_floor_id"] = value
                with self.assertRaises(ProjectError):
                    validate_project(project)
                project = copy.deepcopy(self.project)
                project["floors"][0]["rooms"][0]["ha_area_id"] = value
                with self.assertRaises(ProjectError):
                    validate_project(project)


if __name__ == "__main__":
    unittest.main()
