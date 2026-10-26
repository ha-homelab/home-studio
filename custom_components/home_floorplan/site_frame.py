"""Explicit calibration proposals for imported floor coordinate frames."""
import copy
import math

TOLERANCE = 1e-6


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def propose_site_frame(project, baseline_project, models, embedded):
    """Normalize to global ground zero only from matching authoritative data."""
    ids = [floor["id"] for floor in baseline_project["floors"]]
    if ([floor["id"] for floor in project["floors"]] != ids or
            set(models) != set(ids) or set(embedded) != set(ids)):
        raise ValueError("The saved floors do not match the original home. Restore its matching source before calibration.")
    for value in (project, baseline_project):
        if "site" in value and value["site"]["ground_elevation_m"] != 0:
            raise ValueError("This drawing already has a nonzero authored site ground. Resolve that datum in the original source before calibration.")
    updated, original = copy.deepcopy(project), copy.deepcopy(baseline_project)
    offsets = []
    for floor, base in zip(updated["floors"], original["floors"]):
        fid = floor["id"]
        grounds = []
        for model in (models[fid], embedded[fid]):
            context = model.get("site_context", {})
            ground = context.get("ground_elevation_m") if isinstance(context, dict) else None
            if not finite(ground) or abs(ground) > 100:
                raise ValueError("Every original floor needs a finite, bounded site ground datum before calibration.")
            grounds.append(ground)
        if not math.isclose(*grounds, abs_tol=TOLERANCE, rel_tol=0):
            raise ValueError("The original model and its viewer disagree on site ground. Rebuild the matching source before calibration.")
        elevation = -grounds[0] or 0
        offsets.append({"id": fid, "name": floor["name"], "before_m": floor["elevation_m"],
                        "after_m": elevation, "baseline_ground_m": grounds[0]})
        floor["elevation_m"] = base["elevation_m"] = elevation
    if all(math.isclose(row["before_m"], row["after_m"], abs_tol=TOLERANCE, rel_tol=0) for row in offsets):
        raise ValueError("The imported floor offsets already match global site ground zero. No calibration is needed.")
    return updated, original, offsets
