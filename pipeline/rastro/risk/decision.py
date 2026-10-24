"""Decision layer: PASS / REVIEW / FLAGGED per shipment.

FLAGGED  a blocking rule fired: >= flag_exposure_pct of the lot traces to risky origins or refused
         records, or a direct supplier has a blocking finding (post-cut-off clearing >= 50 ha,
         active embargo, recognised Indigenous land or strict protection, impossible births,
         shipping without inventory).
REVIEW   anything uncertain or suspicious that is not blocking: exposure >= review_exposure_pct,
         unknown origin >= review_unknown_pct, the lineage attribution needs review, coverage below
         min_coverage_pct, or a direct supplier has a watch-level finding. REVIEW is never
         converted into PASS downstream.
PASS     none of the above, with enough lineage coverage to support it.

Risk categories are reported next to the outcome, not folded into it.
"""
import hashlib
import json

from rastro.risk.config import RiskConfig
from rastro.schemas.risk import RISK_SCHEMA_VERSION


# Watch-level post-cut-off clearing (6.25-50 ha) is EUDR-relevant and reported as a category, but it
# can be licensed under Brazilian law, so on its own it neither blocks nor sends a lot to review.
NON_REVIEW_CODES = {("POST2020_DEFORESTATION", "watch")}
BAND_REASON = "fall in different risk bands"


def decide(trace: dict, lot_findings: list[dict], supplier_findings: dict[str, list[dict]], cfg: RiskConfig, decided_at: str,
           blocking_pct: dict[str, float] | None = None) -> dict:
    """blocking_pct: share of the lot from origins with a blocking finding, per allocation policy."""
    sid = trace["shipment_id"]
    a, e = trace["attribution"], trace["exposure_pct"]
    reasons, blocking, review = [], [], []
    for f in lot_findings:
        (blocking if f["blocking"] else review).append(f["finding_id"])
        reasons.append(f"[{'blocking' if f['blocking'] else 'review'}] {f['explanation']}")
    for sup in trace["direct_suppliers"]:
        for f in supplier_findings.get(sup, []):
            if f["severity"] == "info" or (f["code"], f["severity"]) in NON_REVIEW_CODES:
                continue
            if f["blocking"]:
                blocking.append(f["finding_id"])
                reasons.append(f"[blocking] direct supplier {sup}: {f['code']}: {f['explanation']}")
            else:
                review.append(f["finding_id"])
                reasons.append(f"[review] direct supplier {sup}: {f['code']} ({f['severity']}): {f['explanation']}")
    # The lineage service judges its own uncertainty on the any-risk share; the decision uses the
    # blocking share, so the policy-band check is redone on that share here.
    lineage_review = [r for r in a["review_reasons"] if BAND_REASON not in r]
    reasons += [f"[review] lineage: {r}" for r in lineage_review]
    band_conflict = False
    if blocking_pct:
        # FIFO and pro-rata bracket the attribution. It is uncertain in a way that matters when the
        # bracket straddles the blocking threshold: one assumption would FLAG the lot, the other not.
        lo, hi = min(blocking_pct.values()), max(blocking_pct.values())
        if lo < cfg.flag_exposure_pct <= hi:
            band_conflict = True
            reasons.append("[review] lineage: blocking-origin share is " + ", ".join(f"{v:.1f}% under {k}" for k, v in sorted(blocking_pct.items()))
                           + f": the {cfg.flag_exposure_pct:.0f}% blocking threshold lies between the two allocation assumptions")
    if trace["coverage_pct"] < cfg.min_coverage_pct:
        reasons.append(f"[review] lineage coverage {trace['coverage_pct']:.1f}% < {cfg.min_coverage_pct:.0f}%: not enough evidence to pass")

    if blocking:
        outcome = "FLAGGED"
    elif review or lineage_review or band_conflict or trace["coverage_pct"] < cfg.min_coverage_pct:
        outcome = "REVIEW"
    else:
        outcome = "PASS"
        bp = (blocking_pct or {}).get("fifo", 0.0)
        reasons.append(f"[pass] {bp:.1f}% of head from origins with a blocking finding (< {cfg.review_exposure_pct:.0f}%), "
                       f"coverage {trace['coverage_pct']:.1f}%, no blocking or review finding on the lot or its direct suppliers; "
                       f"EUDR-relevant exposure {a['environmental_overlap_pct']:.1f}%")
    cats = sorted({k for k in ("post_cutoff_deforestation", "embargo", "protected_overlap", "suspicious_births_or_inventory",
                               "unknown_or_incomplete", "environmental_evidence_missing") if e[k] > 0}
                  | {f["code"] for sup in trace["direct_suppliers"] for f in supplier_findings.get(sup, []) if f["severity"] != "info"})
    d = {"schema_version": RISK_SCHEMA_VERSION, "shipment_id": sid, "outcome": outcome, "risk_categories": cats, "reasons": reasons,
         "blocking_finding_ids": sorted(set(blocking)), "review_finding_ids": sorted(set(review)),
         "exposure_pct": {k: v for k, v in e.items()} | {"suspected_laundering": a["suspected_laundering_pct"],
                                                        "record_inconsistency": a["record_inconsistency_pct"],
                                                        "eudr_exposure": a["environmental_overlap_pct"],
                                                        **{f"blocking_origin_{k}": round(v, 3) for k, v in (blocking_pct or {}).items()}},
         "coverage_pct": trace["coverage_pct"], "direct_suppliers": trace["direct_suppliers"],
         "thresholds": {"flag_exposure_pct": cfg.flag_exposure_pct, "review_exposure_pct": cfg.review_exposure_pct,
                        "review_unknown_pct": cfg.review_unknown_pct, "min_coverage_pct": cfg.min_coverage_pct},
         "decided_at": decided_at}
    d["evidence_hash"] = hashlib.sha256(json.dumps(d, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    return d
