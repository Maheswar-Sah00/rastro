"""Readiness and dataset summary."""
from app.store import DatasetStore

REQUIRED = ("manifest", "ranches", "gtas", "shipments")
DERIVED = ("geo", "lineage", "decisions", "findings", "ranch_risk")


def ready(store: DatasetStore) -> dict:
    checks = {n: store.exists(n) for n in REQUIRED + DERIVED}
    checks["risk_current"] = store.risk_is_current()
    checks["published_bundle"] = (store.web / "meta.json").is_file()
    m = store.json("manifest") or {}
    build = {"dataset_id": m.get("dataset_id"), "dataset_version": m.get("dataset_version"), "seed": m.get("seed"),
             "logical_digest": m.get("logical_digest"), "generated_at": m.get("generated_at"), "versions": _versions()}
    return {"ready": all(checks[n] for n in REQUIRED) and checks["geo"], "checks": checks,
            "missing": [k for k, v in checks.items() if not v], "build": build}


def _versions() -> dict:
    from app import pipeline_bridge  # noqa: F401  (puts the pipeline package on sys.path)
    from app.config import APP_VERSION
    from rastro import __version__ as pipeline
    from rastro.geospatial import ENGINE_VERSION as geo
    from rastro.lineage import LINEAGE_VERSION as lineage
    from rastro.risk import RISK_ENGINE_VERSION as risk
    from rastro.schemas.canonical import SCHEMA_VERSION as canonical
    return {"api": APP_VERSION, "pipeline": pipeline, "canonical_schema": canonical, "geospatial": geo, "lineage": lineage, "risk": risk}


def summary(store: DatasetStore) -> dict:
    m = store.json("manifest") or {}
    rs, ls = store.json("risk_summary"), store.json("lineage_summary")
    return {"counts": {k: v["rows"] for k, v in m.get("tables", {}).items() if v["partition"] != "truth"},
            "deliberate_anomalies": m.get("deliberate_anomalies"), "notice": m.get("notice"),
            "risk": {k: rs.get(k) for k in ("decisions", "ranch_risk", "findings_by_code", "engine_version")} if rs else None,
            "lineage": {k: ls.get(k) for k in ("conservation", "issues", "review_required", "shipments")} if ls else None,
            "geospatial": (store.json("geo_provenance") or {}).get("summary"),
            "evaluation": "available" if store.exists("evaluation") else "unavailable"}
