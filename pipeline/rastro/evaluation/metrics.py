"""Extended evaluation measures for one assessed dataset. Reads truth/ (evaluation only).

Units and denominators (each metric names its own):
- ranch level: ranches inside the study window (409); positives = truth label per category.
- shipment level: canonical shipments (deliveries + monthly voyages); truth class from
  truth/shipment_truth.tainted_pct (clean < 1 %, minor 1-25 %, major >= 25 %).
- lot level: every sink-bound permit (one GTA lot); outcome = its shipment's decision; truth from
  truth/movement_labels.true_origin_mix (share of head born on dirty sources).
- cattle weighted: head born on dirty sources that reached a sink, summed over lots.
"""
import json
from collections import Counter, defaultdict
from pathlib import Path
from statistics import mean, median

from rastro.risk.evaluate import binary

NETWORK = {"launderer", "phantom_births", "over_capacity"}
BASELINE_RULE = ("direct-supplier-only: a lot is blocked when the ranch that sold it to the slaughterhouse or port has, on the "
                 "real layers, post-2020 PRODES clearing >= 6.25 ha, overlap with a recognised Indigenous land or strict-protection "
                 "unit, or an active embargo. Upstream ranches are not examined. Inputs: geo evidence + embargo list of the direct supplier.")


def _jsonl(p: Path):
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l] if p.is_file() else []


def extended(dataset: Path) -> dict:
    risk = dataset / "derived" / "risk"
    findings = _jsonl(risk / "findings.jsonl")
    decisions = {d["shipment_id"]: d for d in _jsonl(risk / "decisions.jsonl")}
    ranch_risk = {r["ranch_id"]: r for r in _jsonl(risk / "ranch_risk.jsonl")}
    labels = {l["ranch_id"]: l for l in _jsonl(dataset / "truth" / "ranch_labels.jsonl")}
    mlabels = {m["gta_id"]: m for m in _jsonl(dataset / "truth" / "movement_labels.jsonl")}
    ship_truth = {s["shipment_id"]: s for s in _jsonl(dataset / "truth" / "shipment_truth.jsonl")}
    ships = {s["shipment_id"]: s for s in _jsonl(dataset / "inputs" / "shipments.jsonl")}
    gtas = {g["gta_id"]: g for g in _jsonl(dataset / "inputs" / "gta_movements.jsonl")}
    dirty = {r for r, l in labels.items() if l["label"] == "dirty_source"}

    baseline_block = {f["entity_id"] for f in findings if f["entity_type"] == "ranch" and f["detector"] == "A_environmental"
                      and f["code"] in ("POST2020_DEFORESTATION", "PROTECTED_AREA", "EMBARGOED") and f["severity"] in ("watch", "high")}
    blocking_ranch = {f["entity_id"] for f in findings if f["entity_type"] == "ranch" and f["blocking"]}

    # ---- lot level ------------------------------------------------------------------------------
    lots = []
    for sid, s in ships.items():
        for gid in s["gta_ids"]:
            mix = mlabels[gid]["true_origin_mix"]
            head = sum(mix.values()) or gtas[gid]["head_count"]
            tainted = sum(h for o, h in mix.items() if o in dirty)
            lots.append({"gta": gid, "shipment": sid, "head": head, "tainted": tainted, "share": 100 * tainted / head if head else 0.0,
                         "rastro": decisions[sid]["outcome"], "baseline": "FLAGGED" if gtas[gid]["origin_id"] in baseline_block else "PASS"})

    def lot_metrics(key):
        U = {l["gta"] for l in lots}
        major = {l["gta"] for l in lots if l["share"] >= 25}
        anyt = {l["gta"] for l in lots if l["share"] >= 1}
        clean = [l for l in lots if l["share"] < 1]
        th = sum(l["tainted"] for l in lots)
        return {
            "denominator": "sink-bound permits (lots)", "lots": len(lots),
            "flagged_vs_major": binary({l["gta"] for l in lots if l[key] == "FLAGGED"}, major, U),
            "not_pass_vs_any": binary({l["gta"] for l in lots if l[key] != "PASS"}, anyt, U),
            "cattle_weighted_caught_flagged_pct": round(100 * sum(l["tainted"] for l in lots if l[key] == "FLAGGED") / th, 2) if th else None,
            "cattle_weighted_caught_flag_or_review_pct": round(100 * sum(l["tainted"] for l in lots if l[key] != "PASS") / th, 2) if th else None,
            "cattle_weighted_denominator": f"{th:,.0f} head born on dirty sources reaching a sink",
            "clean_lots_flagged_pct": round(100 * sum(l[key] == "FLAGGED" for l in clean) / len(clean), 2) if clean else None,
            "clean_lots_reviewed_pct": round(100 * sum(l[key] == "REVIEW" for l in clean) / len(clean), 2) if clean else None,
            "clean_lots_denominator": f"{len(clean)} lots with < 1 % dirty-source head",
        }

    # ---- shipment-level operational measures ---------------------------------------------------
    outs = Counter(d["outcome"] for d in decisions.values())
    head_by = {sid: s["declared_head_count"] for sid, s in ships.items()}
    total_head = sum(head_by.values())
    ops = {
        "shipments": len(decisions), "outcomes": dict(outs),
        "review_rate_pct": round(100 * outs["REVIEW"] / len(decisions), 2),
        "flag_rate_pct": round(100 * outs["FLAGGED"] / len(decisions), 2),
        "lineage_coverage_pct": {"mean": round(mean(d["coverage_pct"] for d in decisions.values()), 2),
                                 "median": round(median(d["coverage_pct"] for d in decisions.values()), 2),
                                 "head_weighted": round(sum(d["coverage_pct"] * head_by[s] for s, d in decisions.items()) / total_head, 2)},
        "unknown_origin_head_weighted_pct": round(sum(d["exposure_pct"]["unknown_or_incomplete"] * head_by[s] for s, d in decisions.items()) / total_head, 2),
    }

    # ---- laundering network --------------------------------------------------------------------
    network = {r for r, l in labels.items() if l["label"] in NETWORK}
    lead_codes = {"PASS_THROUGH", "OVER_CAPACITY", "PHANTOM_BIRTHS", "INSUFFICIENT_HERD", "ANOMALY", "BIRTHS_BORDERLINE"}
    any_lead = {f["entity_id"] for f in findings if f["entity_type"] == "ranch" and f["code"] in lead_codes and f["severity"] != "info"}
    sells_direct = {g["origin_id"] for s in ships.values() for g in (gtas[x] for x in s["gta_ids"])}
    laundering = {
        "denominator": f"{len(network)} ranches labelled launderer, phantom_births or over_capacity",
        "found_as_high": len({r for r in network if ranch_risk.get(r, {}).get("risk_class") == "high"}),
        "found_with_any_behavioural_lead": len(network & any_lead),
        "found_by_baseline": len(network & baseline_block & sells_direct),
        "total": len(network),
        "by_label": {lab: {"total": sum(labels[r]["label"] == lab for r in network),
                           "high": sum(labels[r]["label"] == lab and ranch_risk.get(r, {}).get("risk_class") == "high" for r in network)}
                     for lab in sorted(NETWORK)},
    }

    # ---- voyages ---------------------------------------------------------------------------------
    voy = [sid for sid, s in ships.items() if s["kind"] == "voyage"]
    vbase = {sid: ("FLAGGED" if any(gtas[g]["origin_id"] in baseline_block for g in ships[sid]["gta_ids"]) else "PASS") for sid in voy}
    voyages = {
        "count": len(voy), "note": "synthetic monthly voyages from the Barcarena port; destination countries are not modelled in the canonical dataset",
        "rastro": dict(Counter(decisions[s]["outcome"] for s in voy)), "baseline": dict(Counter(vbase.values())),
        "truth_with_any_taint": sum(ship_truth[s]["tainted_pct"] >= 1 for s in voy),
        "truth_major_taint": sum(ship_truth[s]["tainted_pct"] >= 25 for s in voy),
        "all_flagged_by_rastro": all(decisions[s]["outcome"] == "FLAGGED" for s in voy) if voy else None,
        "all_flagged_or_review_by_rastro": all(decisions[s]["outcome"] != "PASS" for s in voy) if voy else None,
    }

    # ---- error analysis ----------------------------------------------------------------------------
    fn, fp = [], []
    for sid, d in decisions.items():
        t = ship_truth[sid]
        if t["tainted_pct"] >= 25 and d["outcome"] == "PASS":
            tainted_origins = [o for o in t["origins"] if o in dirty]
            unflagged = [o for o in tainted_origins if o not in blocking_ranch]
            cause = ("tainted origin has no blocking finding" if len(unflagged) == len(tainted_origins)
                     else "lineage attributed the tainted head below the threshold")
            fn.append({"shipment": sid, "truth_tainted_pct": t["tainted_pct"], "blocking_origin_fifo": d["exposure_pct"].get("blocking_origin_fifo"),
                       "blocking_origin_pro_rata": d["exposure_pct"].get("blocking_origin_pro_rata"), "coverage": d["coverage_pct"],
                       "direct_supplier_labels": sorted({labels[x]["label"] for x in d["direct_suppliers"] if x in labels}), "cause": cause})
        if t["tainted_pct"] < 1 and d["outcome"] == "FLAGGED":
            direct = any(x in blocking_ranch for x in d["direct_suppliers"])
            fp.append({"shipment": sid, "cause": "direct supplier has a blocking finding" if direct else "lineage attributed blocking origins to clean cattle",
                       "direct_supplier_labels": sorted({labels[x]["label"] for x in d["direct_suppliers"] if x in labels})})
    errors = {
        "false_negatives": {"definition": "shipments with >= 25 % dirty-source head that PASS", "count": len(fn),
                            "by_cause": dict(Counter(e["cause"] for e in fn)), "examples": sorted(fn, key=lambda e: -e["truth_tainted_pct"])[:10]},
        "false_positives": {"definition": "shipments with < 1 % dirty-source head that are FLAGGED", "count": len(fp),
                            "by_cause": dict(Counter(e["cause"] for e in fp)),
                            "by_direct_supplier_label": dict(Counter(l for e in fp for l in e["direct_supplier_labels"])), "examples": fp[:10]},
    }
    return {"lot_level": {"rastro": lot_metrics("rastro"), "baseline": lot_metrics("baseline")}, "operations": ops,
            "laundering_ranches": laundering, "voyages": voyages, "errors": errors, "baseline_rule": BASELINE_RULE}
