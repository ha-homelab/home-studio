#!/usr/bin/env python3
"""Keep catalog metadata intact through Home Assistant inventory validation."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "inventory_validation", ROOT / "custom_components/home_floorplan/validation.py")
validation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validation)


def item():
    return {"id": "chair_1", "name": "Reading chair", "type": "furniture", "room": "study",
            "position_m": {"x": 1, "y": 0, "z": 2},
            "dimensions_m": {"width": .8, "depth": .8, "height": .9},
            "rotation_deg": 45, "entity_id": "", "notes": "",
            "model_id": "armchair", "style_id": "natural", "color": "#4E9C99", "pattern_id": "checks", "pattern_color": "#FFEEDD"}


class AppearanceTests(unittest.TestCase):
    def test_runtime_save_retains_appearance_and_does_not_mutate_input(self):
        original = item()
        saved = validation.validate_inventory([original], {"study"})[0]
        self.assertEqual(saved, original)
        self.assertIsNot(saved, original)
        saved["position_m"]["x"] = 9
        self.assertEqual(original["position_m"]["x"], 1)

    def test_legacy_inventory_remains_valid(self):
        legacy = item()
        for key in ("model_id", "style_id", "color", "pattern_id", "pattern_color"):
            del legacy[key]
        self.assertEqual(validation.validate_inventory([legacy], {"study"}), [legacy])

    def test_inert_appearance_has_bounded_syntax(self):
        for change in ({"model_id": "../chair"}, {"model_id": "x" * 65},
                       {"style_id": []}, {"style_id": "white\n"}, {"color": None},
                       {"color": "#fff"}, {"pattern_id": "bad/path"},
                       {"pattern_id": "none"}, {"pattern_color": "red"}, {"color": "url(https://example.invalid)"},
                       {"external_model_url": "https://example.invalid/chair.glb"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                validation.validate_inventory([{**item(), **change}], {"study"})
        orphan = item()
        del orphan["model_id"]
        with self.assertRaises(ValueError):
            validation.validate_inventory([orphan], {"study"})


if __name__ == "__main__":
    unittest.main()
