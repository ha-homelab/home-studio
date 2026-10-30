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


def viewer_i18n_expression(data: dict) -> str:
    """Encode the complete catalog with shared keys and a small JS decoder.

    Null marks an absent translation; empty strings remain translations. The
    decoder uses own properties, including for literal keys such as __proto__.
    """
    if (not isinstance(data, dict) or set(data) != {"locales", "dictionaries"}
            or not isinstance(data["locales"], list) or not isinstance(data["dictionaries"], dict)
            or not data["dictionaries"] or "en" not in data["dictionaries"]):
        raise ValueError("Unsupported viewer translation data")
    dictionaries = data["dictionaries"]
    for code, dictionary in dictionaries.items():
        if (not isinstance(code, str) or not isinstance(dictionary, dict)
                or any(not isinstance(key, str) or not isinstance(value, str)
                       for key, value in dictionary.items())):
            raise ValueError("Viewer translations must contain string keys and values")
    keys = list(dict.fromkeys(key for dictionary in dictionaries.values() for key in dictionary))
    rows = [[code, [dictionary.get(key) for key in keys]] for code, dictionary in dictionaries.items()]
    payload = json.dumps([data["locales"], keys, rows], ensure_ascii=False,
                         separators=(",", ":"), allow_nan=False)
    payload = payload.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    return ("(([locales,keys,rows])=>({locales,dictionaries:Object.fromEntries(rows.map(([code,values])=>"
            "[code,Object.fromEntries(values.flatMap((value,i)=>value===null?[]:[[keys[i],value]]))]))}))("
            + payload + ")")
