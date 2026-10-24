"""Ranch queries: registry rows joined with geospatial evidence and risk, without recomputing either."""
from app.observability import APIError
from app.store import DatasetStore


def env_status(store: DatasetStore, r: dict) -> str:
    if r["entity_type"] != "ranch":
        return "not_applicable"
    g = store.get("geo", r["ranch_id"])
    return "available" if g and g["deforestation"]["post_cutoff_ha"] is not None else "missing"


def summary(store: DatasetStore, r: dict) -> dict:
    g = store.get("geo", r["ranch_id"])
    rr = store.get("ranch_risk", r["ranch_id"])
    return {"ranch_id": r["ranch_id"], "display_name": r["display_name"], "entity_type": r["entity_type"], "role": r["role"],
            "total_area_hectares": r["total_area_hectares"], "pasture_area_hectares": r["pasture_area_hectares"],
            "estimated_cattle_capacity": r["estimated_cattle_capacity"], "data_source": r["data_source"],
            "environmental_evidence": env_status(store, r),
            "post_cutoff_deforestation_ha": g["post_cutoff_deforestation_area_hectares"] if g else None,
            "eudr_indicator": g["legal"]["eudr_cutoff_indicator"] if g else None,
            "risk_status": "assessed" if rr else "not_assessed", "risk_class": rr["risk_class"] if rr else None}


def require(store: DatasetStore, ranch_id: str) -> dict:
    r = store.get("ranches", ranch_id)
    if r is None:
        raise APIError(404, "not_found", f"ranch {ranch_id} not found")
    return r


def listing(store: DatasetStore, role=None, risk_class=None, entity_type=None, q=None) -> list[dict]:
    rows = [summary(store, r) for r in store.rows("ranches") or []]
    if q:
        ql = q.lower()
        rows = [r for r in rows if ql in r["ranch_id"].lower() or ql in (r.get("display_name") or "").lower()]
    if role:
        rows = [r for r in rows if r["role"] == role]
    if entity_type:
        rows = [r for r in rows if r["entity_type"] == entity_type]
    if risk_class:
        rows = [r for r in rows if r["risk_class"] == risk_class]
    return rows


def risk(store: DatasetStore, ranch_id: str) -> dict:
    require(store, ranch_id)
    rr = store.get("ranch_risk", ranch_id)
    findings = [f for f in store.by("findings", "entity_id").get(ranch_id, []) if f["entity_type"] == "ranch"]
    return {"ranch_id": ranch_id, "risk_status": "assessed" if rr else "not_assessed", "risk_class": rr["risk_class"] if rr else None,
            "anomaly_score": rr["anomaly_score"] if rr else None, "findings": findings}


def detail(store: DatasetStore, ranch_id: str) -> dict:
    r = require(store, ranch_id)
    return {"ranch": r, "environmental": {"status": env_status(store, r), "evidence": store.get("geo", ranch_id)},
            "risk": risk(store, ranch_id),
            "movements": {"out": len(store.by("gtas", "origin_id").get(ranch_id, [])),
                          "in": len(store.by("gtas", "destination_id").get(ranch_id, []))}}
