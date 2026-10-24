"""Explainable risk engine: detectors, decision layer, evidence, reproducibility, evaluation."""
import json
import re
import shutil
from pathlib import Path

import pytest

from rastro.geospatial.run import run as run_geo
from rastro.risk.anomaly import FEATURES, fit_score
from rastro.risk.config import RiskConfig
from rastro.risk.decision import decide
from rastro.risk.detectors import Findings, detector_c, detector_d
from rastro.risk.evaluate import binary, evaluate
from rastro.risk.run import run as run_risk
from rastro.schemas.risk import Decision, Finding

FIXTURE = Path(__file__).parent / "fixtures" / "tiny"
CFG = RiskConfig()


@pytest.fixture(scope="module")
def ds(tmp_path_factory):
    d = tmp_path_factory.mktemp("risk") / "tiny"
    shutil.copytree(FIXTURE, d, ignore=shutil.ignore_patterns("geo_*", "lineage_*", "risk", "reports"))
    run_geo(d)
    run_risk(d)
    return d


def rows(p):
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l]


# ---- end to end on the fixture ------------------------------------------------------------------
def test_outputs_validate_and_carry_full_evidence(ds):
    findings = rows(ds / "derived" / "risk" / "findings.jsonl")
    assert findings
    for f in findings:
        Finding.model_validate(f)
        assert f["explanation"] and f["detector_version"] and f["observed_at"] and f["dataset_refs"]
        ev = ds / "derived" / "risk" / "evidence" / f"{f['evidence_hash']}.json"
        assert ev.is_file()
    for d in rows(ds / "derived" / "risk" / "decisions.jsonl"):
        Decision.model_validate(d)
        assert d["reasons"], "every decision explains itself"


def test_explanations_are_built_from_measured_values(ds):
    for f in rows(ds / "derived" / "risk" / "findings.jsonl"):
        numbers = [v for v in f["observed"].values() if isinstance(v, (int, float)) and not isinstance(v, bool) and v]
        if f["code"] in ("POST2020_DEFORESTATION", "PASS_THROUGH", "OVER_CAPACITY", "TAINTED_SUPPLY"):
            assert numbers and re.search(r"\d", f["explanation"])


def test_engine_is_reproducible(ds, tmp_path):
    d2 = tmp_path / "again"
    shutil.copytree(ds, d2, ignore=shutil.ignore_patterns("risk"))
    run_risk(d2)
    for name in ("findings.jsonl", "decisions.jsonl", "ranch_risk.jsonl"):
        assert (ds / "derived" / "risk" / name).read_bytes() == (d2 / "derived" / "risk" / name).read_bytes(), name


def test_engine_never_needs_ground_truth(ds, tmp_path):
    d2 = tmp_path / "notruth"
    shutil.copytree(ds, d2, ignore=shutil.ignore_patterns("risk", "truth"))
    run_risk(d2)
    assert (ds / "derived" / "risk" / "decisions.jsonl").read_bytes() == (d2 / "derived" / "risk" / "decisions.jsonl").read_bytes()


def test_three_outcomes_occur_and_review_is_kept(ds):
    outcomes = {d["outcome"] for d in rows(ds / "derived" / "risk" / "decisions.jsonl")}
    assert outcomes <= {"PASS", "REVIEW", "FLAGGED"} and "FLAGGED" in outcomes


def test_missing_environmental_evidence_is_not_clean(ds, tmp_path):
    d2 = tmp_path / "noenv"
    shutil.copytree(ds, d2, ignore=shutil.ignore_patterns("risk"))
    lines = (d2 / "derived" / "geo_evidence.jsonl").read_text(encoding="utf-8").splitlines()
    (d2 / "derived" / "geo_evidence.jsonl").write_text("\n".join(lines[1:]) + "\n", encoding="utf-8")  # drop the first ranch
    run_risk(d2)
    first = json.loads(lines[0])["ranch_id"]
    rr = {r["ranch_id"]: r for r in rows(d2 / "derived" / "risk" / "ranch_risk.jsonl")}[first]
    assert "ENV_EVIDENCE_MISSING" in rr["codes"] and rr["risk_class"] != "clean"


def test_no_language_model_is_used():
    src = "".join(p.read_text(encoding="utf-8") for p in (Path(__file__).parents[1] / "rastro" / "risk").glob("*.py"))
    assert not re.search(r"openai|anthropic|llm|langchain", src, re.I)


# ---- decision layer ----------------------------------------------------------------------------------
def trace(**over):
    t = {"shipment_id": "SHP-D-000001", "direct_suppliers": ["R0001"], "coverage_pct": 100.0,
         "exposure_pct": {"post_cutoff_deforestation": 0.0, "embargo": 0.0, "protected_overlap": 0.0, "suspicious_births_or_inventory": 0.0,
                          "environmental_evidence_missing": 0.0, "unknown_or_incomplete": 0.0, "any_risk": 0.0},
         "attribution": {"record_inconsistency_pct": 0.0, "environmental_overlap_pct": 0.0, "suspected_laundering_pct": 0.0,
                         "unknown_provenance_pct": 0.0, "review_required": False, "review_reasons": []}}
    t.update(over)
    return t


def finding(code, severity, blocking, entity="R0001"):
    return {"finding_id": f"F-{code}", "code": code, "severity": severity, "blocking": blocking, "explanation": f"{code} measured", "entity_id": entity}


def test_clean_lot_with_evidence_passes():
    d = decide(trace(), [], {}, CFG, "t", {"fifo": 0.0, "pro_rata": 0.0})
    assert d["outcome"] == "PASS" and any(r.startswith("[pass]") for r in d["reasons"])


def test_blocking_supplier_flags():
    d = decide(trace(), [], {"R0001": [finding("EMBARGOED", "high", True)]}, CFG, "t", {"fifo": 0.0, "pro_rata": 0.0})
    assert d["outcome"] == "FLAGGED" and d["blocking_finding_ids"] == ["F-EMBARGOED"]


def test_watch_finding_reviews_but_watch_clearing_alone_does_not():
    assert decide(trace(), [], {"R0001": [finding("PASS_THROUGH", "watch", False)]}, CFG, "t", {"fifo": 0, "pro_rata": 0})["outcome"] == "REVIEW"
    d = decide(trace(), [], {"R0001": [finding("POST2020_DEFORESTATION", "watch", False)]}, CFG, "t", {"fifo": 0, "pro_rata": 0})
    assert d["outcome"] == "PASS" and "POST2020_DEFORESTATION" in d["risk_categories"]  # reported, not hidden


def test_lineage_review_is_never_silently_passed():
    t = trace(attribution={**trace()["attribution"], "review_required": True, "review_reasons": ["40.0% of head has unknown or incomplete origin"]})
    assert decide(t, [], {}, CFG, "t", {"fifo": 0, "pro_rata": 0})["outcome"] == "REVIEW"


def test_insufficient_coverage_is_not_a_pass():
    assert decide(trace(coverage_pct=60.0), [], {}, CFG, "t", {"fifo": 0, "pro_rata": 0})["outcome"] == "REVIEW"


def test_allocation_uncertainty_across_the_blocking_threshold_reviews():
    assert decide(trace(), [], {}, CFG, "t", {"fifo": 10.0, "pro_rata": 30.0})["outcome"] == "REVIEW"
    assert decide(trace(), [], {}, CFG, "t", {"fifo": 1.0, "pro_rata": 12.0})["outcome"] == "PASS"


def test_blocking_lot_finding_flags():
    lot = [{**finding("TAINTED_SUPPLY", "high", True, "SHP-D-000001")}]
    assert decide(trace(), lot, {}, CFG, "t", {"fifo": 40, "pro_rata": 45})["outcome"] == "FLAGGED"


def test_decision_hash_is_deterministic():
    a = decide(trace(), [], {}, CFG, "t", {"fifo": 0, "pro_rata": 0})
    b = decide(trace(), [], {}, CFG, "t", {"fifo": 0, "pro_rata": 0})
    assert a["evidence_hash"] == b["evidence_hash"]


# ---- detectors C, D, E on hand-built features --------------------------------------------------------
def feats(**over):
    f = {"bought_head": 1000.0, "sold_head": 1000.0, "resold_bought_head": 950.0, "resold_share": 0.95, "median_hold_days_bought": 12,
         "n_suppliers": 6, "n_buyers": 4, "top_buyer_share": 0.4, "turnover_x_capacity": 3.0, "births_declared": 0, "breeding_cows": 0,
         "births_ratio": 0.0, "peak_quarter_herd": 100.0, "pasture_ha": 200.0, "capacity_central": 300.0, "capacity_use": 0.33,
         "upstream_risky_pct": 5.0, "years": 3.0}
    f.update(over)
    return f


def test_short_holding_alone_is_only_a_lead():
    F = Findings("t", "ds")
    detector_c(F, {"R0001": feats()}, CFG)
    (f,) = F.items
    assert f["severity"] == "watch" and not f["blocking"] and "not evidence" in f["explanation"]


def test_pass_through_with_risky_supply_is_high_but_not_blocking():
    F = Findings("t", "ds")
    detector_c(F, {"R0001": feats(upstream_risky_pct=60.0)}, CFG)
    assert F.items[0]["severity"] == "high" and F.items[0]["blocking"] is False


def test_slow_trader_is_not_pass_through():
    F = Findings("t", "ds")
    detector_c(F, {"R0001": feats(median_hold_days_bought=240)}, CFG)
    assert not F.items


def test_over_capacity_bands_and_missing_pasture():
    F = Findings("t", "ds")
    detector_d(F, {"R0001": feats(peak_quarter_herd=400.0), "R0002": feats(peak_quarter_herd=500.0),
                   "R0003": feats(pasture_ha=None, capacity_central=None, peak_quarter_herd=900.0)}, CFG)
    by = {f["entity_id"]: f for f in F.items}
    assert by["R0001"]["severity"] == "watch"  # 2.0 head/ha: above 1.25 x 1.5, below 1.1 x 2.0
    assert by["R0002"]["severity"] == "high"   # 2.5 head/ha
    assert "R0003" not in by                   # unknown pasture is not judged


def test_isolation_forest_is_seeded_and_explained():
    import random
    rnd = random.Random(1)
    pop = {f"R{i:04d}": feats(median_hold_days_bought=rnd.randint(150, 400), turnover_x_capacity=rnd.uniform(0.2, 1.0),
                              resold_share=rnd.uniform(0, 0.5), sold_head=rnd.uniform(100, 400)) for i in range(1, 80)}
    pop["R0999"] = feats()
    a, b = fit_score(pop, CFG), fit_score(pop, CFG)
    assert a == b
    assert a["R0999"]["outlier"] and len(a["R0999"]["reasons"]) == CFG.reason_top_k
    assert not {"ranch_id", "truth", "label"} & set(FEATURES)


# ---- evaluation ---------------------------------------------------------------------------------------
def test_binary_metrics():
    m = binary({1, 2, 3}, {2, 3, 4}, set(range(10)))
    assert (m["tp"], m["fp"], m["fn"], m["tn"]) == (2, 1, 1, 6)
    assert m["precision"] == pytest.approx(2 / 3, abs=1e-4) and m["recall"] == pytest.approx(2 / 3, abs=1e-4)
    assert m["false_positive_rate"] == pytest.approx(1 / 7, abs=1e-4)


def test_evaluation_report_has_ablation_and_confusion(ds):
    r = evaluate(ds, "development")
    assert {"rastro_multi_hop", "baseline_direct_supplier_only"} == set(r["lot_level"])
    conf = r["lot_level"]["rastro_multi_hop"]["confusion"]
    assert sum(sum(v.values()) for v in conf.values()) == r["lot_level"]["rastro_multi_hop"]["lots"]
    assert "direct_supplier_only" in r["ablation"]["tainted_head_caught_pct"]
    assert (ds / "reports" / "evaluation.md").is_file()
