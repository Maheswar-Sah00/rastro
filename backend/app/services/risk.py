"""Risk assessments: read the risk engine's outputs; recompute through the pipeline when asked or stale."""
from collections import defaultdict

from app.observability import APIError
from app.store import DatasetStore


def findings_for_shipment(store: DatasetStore, decision: dict | None, shipment_id: str) -> dict[str, list[dict]]:
    """Lot findings plus the supplier findings the decision cites, grouped by risk category."""
    fs = list(store.by("findings", "entity_id").get(shipment_id, []))
    if decision:
        have = {f["finding_id"] for f in fs}
        idx = store.by("findings", "finding_id")
        for fid in sorted(set(decision["blocking_finding_ids"]) | set(decision["review_finding_ids"])):
            if fid not in have and fid in idx:
                fs.append(idx[fid][0])
    out = defaultdict(list)
    for f in fs:
        out[f["category"]].append(f)
    return dict(out)


def recompute(store: DatasetStore) -> None:
    """Run the pipeline risk engine (lineage + detectors + decisions) on the dataset."""
    from rastro.risk.run import run
    if not store.exists("geo"):
        raise APIError(409, "assessment_unavailable", "geospatial evidence is missing; run `python -m rastro.geospatial.run` first",
                       {"missing": "derived/geo_evidence.jsonl"})
    with store.assess_lock:
        try:
            run(store.dir, svc=store.lineage_service())
        except SystemExit as e:
            raise APIError(409, "assessment_unavailable", str(e)) from None
        except APIError:
            raise
        except Exception as e:
            raise APIError(500, "assessment_failed", f"{e.__class__.__name__}: {e}") from None


def assess(store: DatasetStore, shipment_id: str, force: bool) -> dict:
    from rastro.risk import RISK_ENGINE_VERSION
    source = "precomputed"
    if force or not store.risk_is_current():
        recompute(store)
        source = "recomputed"
    d = store.get("decisions", shipment_id)
    if d is None:
        raise APIError(500, "assessment_failed", f"risk engine produced no decision for {shipment_id}")
    trace = store.get("lineage", shipment_id) or store.lineage_service().trace_shipment(shipment_id)
    by_cat = findings_for_shipment(store, d, shipment_id)
    return {"shipment_id": shipment_id, "source": source, "outcome": d["outcome"], "risk_categories": d["risk_categories"],
            "reasons": d["reasons"], "findings_by_category": by_cat, "evidence_refs": trace["evidence_refs"],
            "decision_evidence_hash": d["evidence_hash"], "coverage_pct": d["coverage_pct"], "exposure_pct": d["exposure_pct"],
            "policy_sensitivity": trace["policy_sensitivity"], "uncertainty_notes": trace["uncertainty_notes"],
            "detector_versions": sorted({f["detector_version"] for fs in by_cat.values() for f in fs}),
            "engine_version": RISK_ENGINE_VERSION}
