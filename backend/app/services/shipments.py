"""Shipment analysis: canonical shipments joined with lineage traces and decisions."""
from app.observability import APIError
from app.services import evidence, lineage, risk
from app.store import DatasetStore


def require(store: DatasetStore, sid: str) -> dict:
    s = store.get("shipments", sid)
    if s is None:
        raise APIError(404, "not_found", f"shipment {sid} not found")
    return s


def summary(store: DatasetStore, s: dict) -> dict:
    d = store.get("decisions", s["shipment_id"])
    return {"shipment_id": s["shipment_id"], "kind": s["kind"], "destination_id": s["destination_id"], "shipment_date": s["shipment_date"],
            "declared_head_count": s["declared_head_count"], "gta_count": len(s["gta_ids"]),
            "assessment_status": "assessed" if d else "not_assessed", "outcome": d["outcome"] if d else None,
            "coverage_pct": d["coverage_pct"] if d else None, "any_risk_pct": d["exposure_pct"]["any_risk"] if d else None}


def listing(store: DatasetStore, kind=None, outcome=None, destination=None) -> list[dict]:
    rows = [summary(store, s) for s in store.rows("shipments") or []]
    if kind:
        rows = [r for r in rows if r["kind"] == kind]
    if outcome:
        rows = [r for r in rows if r["outcome"] == outcome]
    if destination:
        rows = [r for r in rows if r["destination_id"] == destination]
    return rows


def detail(store: DatasetStore, sid: str) -> dict:
    s = require(store, sid)
    d = store.get("decisions", sid)
    return {"shipment": s, "assessment_status": "assessed" if d else "not_assessed", "decision": d,
            "lineage": lineage.shipment_trace(store, sid)}


def risk_view(store: DatasetStore, sid: str) -> dict:
    require(store, sid)
    d = store.get("decisions", sid)
    return {"shipment_id": sid, "assessment_status": "assessed" if d else "not_assessed", "decision": d,
            "findings_by_category": risk.findings_for_shipment(store, d, sid)}


def evidence_view(store: DatasetStore, sid: str) -> dict:
    require(store, sid)
    d = store.get("decisions", sid)
    ev_dir = store.dir / "derived" / "risk" / "evidence"
    items = []

    def item(kind, id_, h):
        present, ok = evidence.check(ev_dir / f"{h}.json", h) if h else (False, None)
        items.append({"kind": kind, "id": id_, "evidence_hash": h or "", "file": f"derived/risk/evidence/{h}.json",
                      "file_present": present, "hash_verified": ok})
    if d:
        item("decision", sid, d["evidence_hash"])
    for fs in risk.findings_for_shipment(store, d, sid).values():
        for f in fs:
            item("finding", f["finding_id"], f.get("evidence_hash"))
    t = store.get("lineage", sid)
    return {"shipment_id": sid, "items": items, "lineage_evidence_refs": t["evidence_refs"] if t else []}
