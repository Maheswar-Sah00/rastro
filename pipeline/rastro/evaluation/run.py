"""Run the scenario registry end to end and write the evaluation artifacts.

    python -m rastro.evaluation.run                         # every scenario on the held-out seed 101
    python -m rastro.evaluation.run --scenarios S01-reference,S05-redteam --seed 202
    python -m rastro.evaluation.run --no-development        # skip the seed-7 development reference

Per scenario: generate (real landscape) -> validate -> geospatial evidence -> risk engine ->
evaluation against truth. Worlds go to data/synthetic/redteam/<scenario>-s<seed>/ (gitignored);
artifacts go to reports/evaluation/: summary.json, metrics.csv, confusion.csv, errors.json, README.md.
"""
import argparse
import csv
import json
import platform
import sys
import time
from pathlib import Path

import sklearn

from rastro import __version__ as PIPELINE_VERSION
from rastro.config import REPO, SYNTHETIC
from rastro.evaluation.metrics import BASELINE_RULE, extended
from rastro.evaluation.scenarios import BY_ID, HELD_OUT_SEED, SCENARIOS
from rastro.geospatial import ENGINE_VERSION as GEO_VERSION
from rastro.geospatial.run import run as run_geo
from rastro.lineage import LINEAGE_VERSION
from rastro.risk import RISK_ENGINE_VERSION
from rastro.risk.anomaly import FEATURE_SCHEMA_VERSION, MODEL_VERSION
from rastro.risk.evaluate import evaluate
from rastro.risk.run import run as run_risk
from rastro.synth.generate import generate
from rastro.validation import validate

REPORTS = REPO / "reports" / "evaluation"
DEV = SYNTHETIC / "evaluation"


def run_scenario(sid: str, seed: int) -> dict:
    sc = BY_ID[sid]
    out = SYNTHETIC / "redteam" / f"{sid}-s{seed}"
    t = {}
    t0 = time.perf_counter()
    _, tables, manifest = generate(sc.config(seed), out, f"redteam-{sid}")
    t["generate_s"] = time.perf_counter() - t0
    t0 = time.perf_counter()
    rep = validate(tables, manifest)
    t["validate_s"] = time.perf_counter() - t0
    if not rep.ok:
        return {"scenario": sid, "error": "dataset failed validation", "validation": rep.summary()}
    return _assess(out, sid, sc.title, sc.tests, "heldout", seed, manifest, t)


def _assess(dataset, sid, title, tests, role, seed, manifest, t):
    t0 = time.perf_counter()
    run_geo(dataset)
    t["geospatial_s"] = time.perf_counter() - t0
    t0 = time.perf_counter()
    risk = run_risk(dataset)
    t["lineage_and_risk_s"] = time.perf_counter() - t0
    t0 = time.perf_counter()
    base = evaluate(dataset, role)
    ext = extended(dataset)
    t["evaluate_s"] = time.perf_counter() - t0
    counts = {k: v["rows"] for k, v in manifest["tables"].items() if k in ("ranches", "gta_movements", "shipments", "missing_records")}
    return {"scenario": sid, "title": title, "tests": tests, "role": role, "seed": seed, "dataset": str(dataset.relative_to(REPO)),
            "logical_digest": manifest["logical_digest"], "counts": counts, "deliberate_anomalies": manifest["deliberate_anomalies"],
            "config_overrides": {k: v for k, v in manifest["config"].items()}, "timing_s": {k: round(v, 2) for k, v in t.items()},
            "decisions": risk["decisions"], "ranch_level": base["ranch_level"], "shipment_level": base["lot_level"],
            "ablation": base["ablation"], **ext}


def development_reference() -> dict:
    manifest = json.loads((DEV / "manifest.json").read_text(encoding="utf-8"))
    return _assess(DEV, "DEV-reference", "Development world (seed 7)",
                   "the world the published demo and thresholds were built on; NOT an independent test", "development", manifest["seed"], manifest, {})


def headline(r: dict) -> dict:
    lr, lb = r["lot_level"]["rastro"], r["lot_level"]["baseline"]
    return {
        "scenario": r["scenario"], "role": r["role"], "seed": r["seed"],
        "rastro_cattle_caught_flagged_pct": lr["cattle_weighted_caught_flagged_pct"],
        "rastro_cattle_caught_flag_or_review_pct": lr["cattle_weighted_caught_flag_or_review_pct"],
        "baseline_cattle_caught_pct": lb["cattle_weighted_caught_flagged_pct"],
        "rastro_clean_lots_flagged_pct": lr["clean_lots_flagged_pct"], "rastro_clean_lots_reviewed_pct": lr["clean_lots_reviewed_pct"],
        "baseline_clean_lots_flagged_pct": lb["clean_lots_flagged_pct"],
        "laundering_found_high": f"{r['laundering_ranches']['found_as_high']}/{r['laundering_ranches']['total']}",
        "laundering_found_baseline": f"{r['laundering_ranches']['found_by_baseline']}/{r['laundering_ranches']['total']}",
        "shipment_review_rate_pct": r["operations"]["review_rate_pct"],
        "shipment_flagged_precision": r["shipment_level"]["rastro_multi_hop"]["flagged_vs_major_taint"]["precision"],
        "shipment_flagged_recall": r["shipment_level"]["rastro_multi_hop"]["flagged_vs_major_taint"]["recall"],
        "coverage_head_weighted_pct": r["operations"]["lineage_coverage_pct"]["head_weighted"],
        "unknown_origin_head_weighted_pct": r["operations"]["unknown_origin_head_weighted_pct"],
        "processing_s": round(sum(r["timing_s"].values()), 1),
    }


BRIEF = {"tainted_caught": (33.0, 90.4), "clean_wrongly_blocked": (26.8, 7.0), "laundering_found": ("3/14", "14/14"), "redteam": (45.2, 83.0)}


def write_artifacts(results: list[dict], seed: int, argv: list[str]):
    REPORTS.mkdir(parents=True, exist_ok=True)
    ok = [r for r in results if "error" not in r]
    heads = [headline(r) for r in ok]
    published = json.loads((REPO / "web" / "public" / "data" / "metrics.json").read_text(encoding="utf-8"))
    summary = {
        "run_command": "cd pipeline && python -m rastro.evaluation.run " + " ".join(argv),
        "held_out_seed": seed, "development_seed": 7,
        "versions": {"pipeline": PIPELINE_VERSION, "risk_engine": RISK_ENGINE_VERSION, "lineage": LINEAGE_VERSION, "geospatial": GEO_VERSION,
                     "iforest_model": MODEL_VERSION, "iforest_features": FEATURE_SCHEMA_VERSION, "sklearn": sklearn.__version__,
                     "python": platform.python_version()},
        "baseline_rule": BASELINE_RULE,
        "headline": heads, "scenarios": results,
        "brief_comparison": brief_comparison(ok, published),
        "leakage_controls": [
            "detectors and decisions read only inputs/, environment/, derived/; truth/ is read only by rastro.risk.evaluate and rastro.evaluation.metrics",
            "a test re-runs the risk engine with truth/ deleted and requires byte-identical decisions",
            "IsolationForest is unsupervised (no labels) and fitted per world; no supervised model is trained, so no train/validation split applies",
            "thresholds and the decision rule were fixed on the seed-7 development world; scenarios run on seed "
            f"{seed}, which was never used for any choice",
            "scenario ids appear only in the evaluation metadata, never in detector-visible tables",
        ],
        "circularity": [
            "dirty sources are defined by the simulator from the same real PRODES/FUNAI layers detector A reads: ranch-level A scores are circular",
            "the simulator's behaviours (FIFO cohorts, holding times) resemble the detector's assumptions; real herds are messier",
            "lot-level and cattle-weighted results still depend on the simulator's rules and should be read as a consistency test, not a field accuracy",
        ],
    }
    (REPORTS / "summary.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
    with (REPORTS / "metrics.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["scenario", "role", "seed", "level", "system", "metric", "value", "denominator"])
        for r in ok:
            for system in ("rastro", "baseline"):
                m = r["lot_level"][system]
                for k in ("cattle_weighted_caught_flagged_pct", "cattle_weighted_caught_flag_or_review_pct", "clean_lots_flagged_pct", "clean_lots_reviewed_pct"):
                    den = m["cattle_weighted_denominator"] if k.startswith("cattle") else m["clean_lots_denominator"]
                    w.writerow([r["scenario"], r["role"], r["seed"], "lot/cattle", system, k, m[k], den])
                for k in ("flagged_vs_major", "not_pass_vs_any"):
                    for mm in ("precision", "recall", "f1", "false_positive_rate"):
                        w.writerow([r["scenario"], r["role"], r["seed"], "lot", system, f"{k}.{mm}", m[k][mm], m["denominator"]])
            for system, key in (("rastro", "rastro_multi_hop"), ("baseline", "baseline_direct_supplier_only")):
                m = r["shipment_level"][key]
                for k in ("flagged_vs_major_taint", "not_pass_vs_any_taint"):
                    for mm in ("precision", "recall", "f1", "false_positive_rate"):
                        w.writerow([r["scenario"], r["role"], r["seed"], "shipment", system, f"{k}.{mm}", m[k][mm], f"{m['lots']} shipments"])
            for name, m in {**r["ranch_level"]["per_detector"], **r["ranch_level"]["overall"]}.items():
                for mm in ("precision", "recall", "f1", "false_positive_rate"):
                    w.writerow([r["scenario"], r["role"], r["seed"], "ranch", name, mm, m[mm], "409 ranches"])
            o = r["operations"]
            for k, v in (("review_rate_pct", o["review_rate_pct"]), ("flag_rate_pct", o["flag_rate_pct"]),
                         ("coverage_head_weighted_pct", o["lineage_coverage_pct"]["head_weighted"]),
                         ("unknown_origin_head_weighted_pct", o["unknown_origin_head_weighted_pct"]),
                         ("processing_s", sum(r["timing_s"].values()))):
                w.writerow([r["scenario"], r["role"], r["seed"], "operations", "rastro", k, round(v, 2), f"{o['shipments']} shipments"])
    with (REPORTS / "confusion.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["scenario", "level", "system", "truth", "PASS", "REVIEW", "FLAGGED"])
        for r in ok:
            for system, key in (("rastro", "rastro_multi_hop"), ("baseline", "baseline_direct_supplier_only")):
                for truth, c in r["shipment_level"][key]["confusion"].items():
                    w.writerow([r["scenario"], "shipment", system, truth, c["PASS"], c["REVIEW"], c["FLAGGED"]])
    (REPORTS / "errors.json").write_text(json.dumps({r["scenario"]: r["errors"] for r in ok}, indent=1), encoding="utf-8")
    (REPORTS / "README.md").write_text(readme(summary), encoding="utf-8")
    return summary


def brief_comparison(results, published):
    dev = next((r for r in results if r["role"] == "development"), None)
    ref = next((r for r in results if r["scenario"] == "S01-reference"), None)
    red = next((r for r in results if r["scenario"] == "S05-redteam"), None)
    pub = {"tainted_caught": (published["eval"]["status_quo"]["tainted_head_caught_pct"], published["eval"]["rastro"]["tainted_head_caught_pct"]),
           "clean_wrongly_blocked": (published["eval"]["status_quo"]["clean_lots_failed_pct"], published["eval"]["rastro"]["clean_lots_failed_pct"]),
           "redteam": (published["stress_test"]["status_quo"]["tainted_head_caught_pct"], published["stress_test"]["rastro"]["tainted_head_caught_pct"])}

    def row(r):
        if not r:
            return None
        lr, lb, lw = r["lot_level"]["rastro"], r["lot_level"]["baseline"], r["laundering_ranches"]
        return {"tainted_caught": (lb["cattle_weighted_caught_flagged_pct"], lr["cattle_weighted_caught_flag_or_review_pct"], lr["cattle_weighted_caught_flagged_pct"]),
                "clean_wrongly_blocked": (lb["clean_lots_flagged_pct"], lr["clean_lots_flagged_pct"]),
                "laundering_found": (f"{lw['found_by_baseline']}/{lw['total']}", f"{lw['found_as_high']}/{lw['total']}")}
    return {
        "brief_figures": BRIEF,
        "published_demo_metrics_json": pub,
        "this_run_development_seed7": row(dev),
        "this_run_heldout_reference": row(ref),
        "this_run_heldout_redteam": {"tainted_caught": (red["lot_level"]["baseline"]["cattle_weighted_caught_flagged_pct"],
                                                        red["lot_level"]["rastro"]["cattle_weighted_caught_flag_or_review_pct"],
                                                        red["lot_level"]["rastro"]["cattle_weighted_caught_flagged_pct"])} if red else None,
        "notes": [
            "tuples are (baseline, rastro flag-or-review, rastro flagged-only) for catch rates and (baseline, rastro) otherwise",
            "the brief's figures come from pipeline/detect.py (the published demo): its 'caught' counts fail + review, its lots are single "
            "sink-bound permits, and EU-market lots also count small post-2020 clearing; this engine has no market assignment",
            "the brief's 3/14 baseline count counts ranches the direct-supplier screen flags among those that sell direct; here the same rule is applied",
        ],
    }


def readme(s: dict) -> str:
    L = ["# Rastro evaluation and red-team results", "",
         "Synthetic evaluation. Every ranch, herd, permit and label is simulated on real environmental layers; nothing here measures real ranches or companies.", "",
         f"Reproduce: `{s['run_command']}`", "",
         f"Versions: {', '.join(f'{k} {v}' for k, v in s['versions'].items())}", "",
         "## Headline (lot level, cattle weighted)", "",
         "| scenario | role | seed | Rastro caught (flagged) | Rastro caught (flag or review) | baseline caught | Rastro clean flagged | Rastro clean reviewed | baseline clean flagged | laundering found (Rastro / baseline) | review rate | coverage | unknown | time s |",
         "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for h in s["headline"]:
        L.append(f"| {h['scenario']} | {h['role']} | {h['seed']} | {h['rastro_cattle_caught_flagged_pct']}% | {h['rastro_cattle_caught_flag_or_review_pct']}% | "
                 f"{h['baseline_cattle_caught_pct']}% | {h['rastro_clean_lots_flagged_pct']}% | {h['rastro_clean_lots_reviewed_pct']}% | "
                 f"{h['baseline_clean_lots_flagged_pct']}% | {h['laundering_found_high']} / {h['laundering_found_baseline']} | {h['shipment_review_rate_pct']}% | "
                 f"{h['coverage_head_weighted_pct']}% | {h['unknown_origin_head_weighted_pct']}% | {h['processing_s']} |")
    L += ["", "Denominators: cattle-weighted = head born on dirty sources that reached a sink; clean lots = sink-bound permits with < 1 % "
          "dirty-source head; laundering = ranches labelled launderer, phantom_births or over_capacity; review rate = share of shipments.", "",
          "## Baseline", "", s["baseline_rule"], "", "## Comparison with the project brief", "", "```json",
          json.dumps(s["brief_comparison"], indent=1), "```", "", "## Leakage controls", ""] + [f"- {x}" for x in s["leakage_controls"]]
    L += ["", "## Circularity and limits", ""] + [f"- {x}" for x in s["circularity"]]
    L += ["", "Scenario details, confusion matrices and error analysis: `summary.json`, `confusion.csv`, `errors.json`, `metrics.csv`."]
    return "\n".join(L) + "\n"


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scenarios", help="comma-separated ids (default: all)")
    ap.add_argument("--seed", type=int, default=HELD_OUT_SEED)
    ap.add_argument("--no-development", action="store_true")
    a = ap.parse_args(argv)
    ids = a.scenarios.split(",") if a.scenarios else [s.id for s in SCENARIOS]
    results = []
    if not a.no_development and (DEV / "manifest.json").is_file():
        results.append(development_reference())
        print(json.dumps(headline(results[-1])), flush=True)
    for sid in ids:
        r = run_scenario(sid, a.seed)
        results.append(r)
        print(json.dumps(headline(r) if "error" not in r else r), flush=True)
    s = write_artifacts(results, a.seed, argv)
    print(f"artifacts: {REPORTS}")
    return 0 if all("error" not in r for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
