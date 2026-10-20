"""Load viewer translations without duplicating the runtime's English fallback."""

import json
from pathlib import Path


def load_viewer_i18n(root: Path) -> dict:
    """Keep source catalogs complete while compacting the embedded payload."""
    directory = root / "viewer-locales"
    locales = json.loads((directory / "index.json").read_text(encoding="utf-8"))
    dictionaries = {
        entry["code"]: json.loads(
            (directory / (entry["code"] + ".json")).read_text(encoding="utf-8")
        )
        for entry in locales
    }
    english = dictionaries["en"]
    for code, dictionary in dictionaries.items():
        if code != "en":
            dictionaries[code] = {
                key: value
                for key, value in dictionary.items()
                if not isinstance(value, str) or key not in english or value != english[key]
            }
    return {"locales": locales, "dictionaries": dictionaries}
