"""Evaluate the risk engine against the simulator's ground truth.

    python -m rastro.risk.evaluate ../data/synthetic/evaluation --role development
    python -m rastro.risk.evaluate ../data/synthetic/heldout-s101 --role heldout

This is the only risk module that reads truth/. Detectors and decisions never see it.

Honesty about tuning: every threshold in RiskConfig was fixed a priori (PRODES mapping unit,
HerdLedger biology bound) or carried over from the published demo, whose thresholds were chosen
while looking at the seed-7 world. That world is therefore reported as **development**. A world
generated with another seed and never used for any choice is the **held-out** test.

Ranch-level dirty sources are defined by the simulator from the same real PRODES / FUNAI layers
detector A reads, so A's ranch-level scores are circular by construction. Lot-level results (does
tainted cattle reach a buyer unflagged?) are the meaningful numbers.
"""
import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

from rastro.risk import RISK_ENGINE_VERSION

NON_HONEST = {"dirty_source", "launderer", "phantom_births", "over_capacity"}


def _jsonl(p: Path):
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l]


def binary(pred: set, truth: set, universe: set) -> dict:
    tp, fp = len(pred & truth), len(pred - truth)
    fn, tn = len(truth - pred), len(universe - pred - truth)
    p = tp / (tp + fp) if tp + fp else None
    r = tp / (tp + fn) if tp + fn else None
    f1 = 2 * p * r / (p + r) if p and r else (0.0 if p is not None and r is not None else None)
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "precision": _r(p), "recall": _r(r), "f1": _r(f1),
            "false_positive_rate": _r(fp / (fp + tn) if fp + tn else None), "predicted": len(pred), "actual": len(truth)}


def _r(x):
    return None if x is None else round(x, 4)


def evaluate(dataset: Path, role: str) -> dict:
    manifest = json.loads((dataset / "manifest.json").read_text(encoding="utf-8"))
    risk = dataset / "derived" / "risk"
    findings = _jsonl(risk / "findings.jsonl")
    ranch_risk = {r["ranch_id"]: r for r in _jsonl(risk / "ranch_risk.jsonl")}
    decisions = {d["shipment_id"]: d for d in _jsonl(risk / "decisions.jsonl")}
    labels = {l["ranch_id"]: l for l in _jsonl(dataset / "truth" / "ranch_labels.jsonl") if l["ranch_id"].startswith("R")}
    ship_truth = {s["shipment_id"]: s for s in _jsonl(dataset / "truth" / "shipment_truth.jsonl")}

    universe = set(labels)
    by_label = defaultdict(set)
    for rid, l in labels.items():
        by_label[l["label"]].add(rid)
    non_honest = set().union(*(by_label[k] for k in NON_HONEST))
    fired = defaultdict(set)
    for f in findings:
        if f["entity_type"] == "ranch":
            fired[(f["code"], f["severity"])].add(f["entity_id"])
            fired[(f["code"], "any")].add(f["entity_id"])

    def codes(*cs, sev="any"):
        return set().union(*(fired[(c, sev)] for c in cs))

    per_detector = {
        "A_environmental (high) vs dirty_source [circular by construction]":
            binary(codes("POST2020_DEFORESTATION", "PROTECTED_AREA", "EMBARGOED", sev="high"), by_label["dirty_source"], universe),
        "B_phantom_births vs phantom_births": binary(codes("PHANTOM_BIRTHS"), by_label["phantom_births"], universe),
        "B_insufficient_herd (high) vs phantom_births": binary(codes("INSUFFICIENT_HERD", sev="high"), by_label["phantom_births"], universe),
        "C_pass_through (any) vs launderer+phantom_births": binary(codes("PASS_THROUGH"), by_label["launderer"] | by_label["phantom_births"], universe),
        "C_pass_through (high) vs launderer+phantom_births": binary(codes("PASS_THROUGH", sev="high"), by_label["launderer"] | by_label["phantom_births"], universe),
        "D_over_capacity (any) vs over_capacity": binary(codes("OVER_CAPACITY"), by_label["over_capacity"], universe),
        "E_anomaly vs any non-honest": binary(codes("ANOMALY"), non_honest, universe),
    }
    overall = {
        "risk_class high vs non-honest": binary({r for r, x in ranch_risk.items() if x["risk_class"] == "high"}, non_honest, universe),
        "risk_class high or watch vs non-honest": binary({r for r, x in ranch_risk.items() if x["risk_class"] in ("high", "watch")}, non_honest, universe),
        "laundering network (launderer, phantom, over-capacity) found as high":
            binary({r for r, x in ranch_risk.items() if x["risk_class"] == "high"}, by_label["launderer"] | by_label["phantom_births"] | by_label["over_capacity"], universe),
    }
    honest_cases = defaultdict(lambda: Counter())
    for rid, l in labels.items():
        if l["label"] == "honest":
            for tag in l["case_tags"] or ["plain"]:
                honest_cases[tag][ranch_risk[rid]["risk_class"]] += 1

    # ---- lot level ---------------------------------------------------------------------------
    def tclass(s):
        return "clean" if s["tainted_pct"] < 1 else ("minor" if s["tainted_pct"] < 25 else "major")

    # Today's practice: the buyer screens its DIRECT suppliers' polygons (any post-2020 clearing above the
    # mapping unit, Indigenous land, strict protection) and the embargo list.
    blocking_env = {f["entity_id"] for f in findings if f["entity_type"] == "ranch" and f["detector"] == "A_environmental"
                    and f["code"] in ("POST2020_DEFORESTATION", "PROTECTED_AREA", "EMBARGOED") and f["severity"] in ("watch", "high")}
    baseline = {sid: ("FLAGGED" if set(d["direct_suppliers"]) & blocking_env else "PASS") for sid, d in decisions.items()}

    def lot_eval(outcomes: dict) -> dict:
        conf = {t: Counter() for t in ("clean", "minor", "major")}
        tainted_head = caught_any = caught_flag = 0.0
        clean_n = clean_flag = clean_review = 0
        for sid, o in outcomes.items():
            s = ship_truth[sid]
            c = tclass(s)
            conf[c][o] += 1
            tainted_head += s["tainted_head"]
            if o != "PASS":
                caught_any += s["tainted_head"]
            if o == "FLAGGED":
                caught_flag += s["tainted_head"]
            if c == "clean":
                clean_n += 1
                clean_flag += o == "FLAGGED"
                clean_review += o == "REVIEW"
        U = set(outcomes)
        major = {s for s in U if tclass(ship_truth[s]) == "major"}
        tainted = {s for s in U if tclass(ship_truth[s]) != "clean"}
        return {
            "confusion": {t: {o: conf[t][o] for o in ("PASS", "REVIEW", "FLAGGED")} for t in conf},
            "flagged_vs_major_taint": binary({s for s, o in outcomes.items() if o == "FLAGGED"}, major, U),
            "not_pass_vs_any_taint": binary({s for s, o in outcomes.items() if o != "PASS"}, tainted, U),
            "tainted_head_caught_pct_flag_or_review": round(100 * caught_any / tainted_head, 2) if tainted_head else None,
            "tainted_head_caught_pct_flagged_only": round(100 * caught_flag / tainted_head, 2) if tainted_head else None,
            "clean_lots_flagged_pct": round(100 * clean_flag / clean_n, 2) if clean_n else None,
            "clean_lots_reviewed_pct": round(100 * clean_review / clean_n, 2) if clean_n else None,
            "lots": len(U), "clean_lots": clean_n, "tainted_head": tainted_head,
        }

    rastro = lot_eval({sid: d["outcome"] for sid, d in decisions.items()})
    base = lot_eval(baseline)
    report = {
        "engine_version": RISK_ENGINE_VERSION, "role": role, "dataset": manifest["dataset_id"], "seed": manifest["seed"],
        "logical_digest": manifest["logical_digest"],
        "tuning_note": ("development world: thresholds were chosen while looking at it, and the decision rule was revised once after a "
                        "run on it (1: watch-level clearing no longer triggers review; 2: the FIFO/pro-rata uncertainty triggers review only when it straddles the blocking threshold). Not an independent test"
                        if role == "development" else "held-out world: generated with a different seed after the decision rule was frozen; never used to choose any threshold or rule"),
        "ranch_level": {"per_detector": per_detector, "overall": overall,
                        "honest_hard_cases_risk_class": {k: dict(v) for k, v in sorted(honest_cases.items())}},
        "lot_level": {"rastro_multi_hop": rastro, "baseline_direct_supplier_only": base},
        "ablation": {
            "tainted_head_caught_pct": {"direct_supplier_only": base["tainted_head_caught_pct_flagged_only"],
                                        "multi_hop_flagged": rastro["tainted_head_caught_pct_flagged_only"],
                                        "multi_hop_flagged_or_review": rastro["tainted_head_caught_pct_flag_or_review"]},
            "clean_lots_flagged_pct": {"direct_supplier_only": base["clean_lots_flagged_pct"], "multi_hop": rastro["clean_lots_flagged_pct"]},
        },
        "caveats": ["synthetic ground truth from the simulator; not a measurement on real ranches",
                    "ranch-level dirty sources are defined from the same real layers detector A reads (circular)",
                    "lot taint classes: clean < 1 %, minor 1-25 %, major >= 25 % of head born on dirty sources"],
    }
    out = dataset / "reports"
    out.mkdir(exist_ok=True)
    (out / "evaluation.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    (out / "evaluation.md").write_text(markdown(report), encoding="utf-8")
    return report


def markdown(r: dict) -> str:
    def row(name, m):
        f = lambda x: "-" if x is None else f"{x:.3f}"
        return f"| {name} | {m['tp']} | {m['fp']} | {m['fn']} | {m['tn']} | {f(m['precision'])} | {f(m['recall'])} | {f(m['f1'])} | {f(m['false_positive_rate'])} |"
    hdr = "| | TP | FP | FN | TN | precision | recall | F1 | FPR |\n|---|---|---|---|---|---|---|---|---|"
    L = [f"# Risk engine evaluation: {r['dataset']} (seed {r['seed']}, {r['role']})", "", f"> {r['tuning_note']}", "",
         "## Ranch level", "", hdr]
    L += [row(k, v) for k, v in {**r["ranch_level"]["per_detector"], **r["ranch_level"]["overall"]}.items()]
    L += ["", "Honest hard cases (risk class counts):", ""]
    L += [f"- {k}: {v}" for k, v in r["ranch_level"]["honest_hard_cases_risk_class"].items()]
    for name, m in r["lot_level"].items():
        L += ["", f"## Lots: {name.replace('_', ' ')}", "", "| truth \\ outcome | PASS | REVIEW | FLAGGED |", "|---|---|---|---|"]
        L += [f"| {t} | {c['PASS']} | {c['REVIEW']} | {c['FLAGGED']} |" for t, c in m["confusion"].items()]
        L += ["", hdr, row("FLAGGED vs major taint", m["flagged_vs_major_taint"]), row("not PASS vs any taint", m["not_pass_vs_any_taint"]), "",
              f"Tainted head caught: {m['tainted_head_caught_pct_flagged_only']}% flagged, {m['tainted_head_caught_pct_flag_or_review']}% flagged or review. "
              f"Clean lots flagged {m['clean_lots_flagged_pct']}%, reviewed {m['clean_lots_reviewed_pct']}%."]
    a = r["ablation"]
    L += ["", "## Ablation: direct-supplier-only vs multi-hop lineage", "", "| | direct supplier only | multi-hop (flagged) | multi-hop (flagged or review) |",
          "|---|---|---|---|",
          f"| tainted head caught % | {a['tainted_head_caught_pct']['direct_supplier_only']} | {a['tainted_head_caught_pct']['multi_hop_flagged']} | {a['tainted_head_caught_pct']['multi_hop_flagged_or_review']} |",
          f"| clean lots flagged % | {a['clean_lots_flagged_pct']['direct_supplier_only']} | {a['clean_lots_flagged_pct']['multi_hop']} | |",
          "", "Caveats:", ""] + [f"- {c}" for c in r["caveats"]]
    return "\n".join(L) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dataset", type=Path)
    ap.add_argument("--role", choices=("development", "heldout"), required=True)
    a = ap.parse_args(argv)
    r = evaluate(a.dataset, a.role)
    print(markdown(r))
    return 0


if __name__ == "__main__":
    sys.exit(main())
