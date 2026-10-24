"""Run the risk engine on a canonical dataset (needs derived/geo_evidence.jsonl; runs lineage itself).

    python -m rastro.risk.run ../data/synthetic/evaluation

Writes DIR/derived/risk/: findings.jsonl, ranch_risk.jsonl, decisions.jsonl, evidence/<sha256>.json
(one canonical file per finding and per decision), model/ (IsolationForest + feature schema),
risk_summary.json. No external service or language model is involved.
"""
import argparse
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

from rastro.lineage.service import LineageService
from rastro.risk import RISK_ENGINE_VERSION
from rastro.risk.anomaly import fit_score
from rastro.risk.config import RiskConfig
from rastro.risk.decision import decide
from rastro.risk.detectors import Findings, blocking_share, detector_a, detector_b, detector_c, detector_d, detector_e, lot_findings
from rastro.risk.features import ranch_features
from rastro.schemas.risk import RISK_SCHEMA_VERSION, Decision, Finding, RanchRisk


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def run(dataset: Path, cfg: RiskConfig = RiskConfig(), svc: LineageService | None = None) -> dict:
    manifest = json.loads((dataset / "manifest.json").read_text(encoding="utf-8"))
    if not (dataset / "derived" / "geo_evidence.jsonl").is_file():
        raise SystemExit("run `python -m rastro.geospatial.run` on this dataset first")
    svc = svc or LineageService(dataset)
    observed_at = manifest["generated_at"]
    out = dataset / "derived" / "risk"
    (out / "evidence").mkdir(parents=True, exist_ok=True)
    for old in (out / "evidence").glob("*.json"):
        old.unlink()

    F = Findings(observed_at, f"{manifest['dataset_id']}@{manifest['logical_digest'][:12]}")
    detector_a(F, svc, cfg)
    detector_b(F, svc, cfg)
    feats = ranch_features(svc, cfg)
    detector_c(F, feats, cfg)
    detector_d(F, feats, cfg)
    scores = fit_score(feats, cfg, out / "model", F.dataset_id)
    detector_e(F, scores, cfg)
    ranch_findings = F.by_entity()

    traces = {sid: svc.trace_shipment(sid) for sid in sorted(svc.ship)}
    n_ranch = len(F.items)
    blocking_ranches = {f["entity_id"] for f in F.items if f["blocking"]}
    for t in traces.values():
        lot_findings(F, t, cfg, blocking_ranches)
    lot_by = F.by_entity()
    def unresolved(tr):
        return sum(x["share_pct"] for x in tr["sources"] if x["origin_kind"] == "unresolved")

    decisions = []
    for sid, t in traces.items():
        alt = svc.trace_shipment(sid, "pro_rata")
        shares = {"fifo": blocking_share(t, blocking_ranches)[0] + unresolved(t),
                  "pro_rata": blocking_share(alt, blocking_ranches)[0] + unresolved(alt)}
        decisions.append(decide(t, lot_by.get(sid, []), ranch_findings, cfg, observed_at, shares))

    for f in F.items:
        f["evidence_hash"] = None
        raw = canonical(f)
        f["evidence_hash"] = hashlib.sha256(raw).hexdigest()
        (out / "evidence" / f"{f['evidence_hash']}.json").write_bytes(raw)
        Finding.model_validate(f)
    for d in decisions:
        Decision.model_validate(d)
        (out / "evidence" / f"{d['evidence_hash']}.json").write_bytes(canonical({k: v for k, v in d.items() if k != "evidence_hash"}))

    ranch_risk = []
    for r in svc.t["ranches"]:
        if r["entity_type"] != "ranch":
            continue
        fs = ranch_findings.get(r["ranch_id"], [])
        sev = {f["severity"] for f in fs}
        cls = "high" if "high" in sev else "watch" if "watch" in sev else "clean"
        if cls == "clean" and any(f["code"] == "ENV_EVIDENCE_MISSING" for f in fs):
            cls = "insufficient_data"
        rr = {"schema_version": RISK_SCHEMA_VERSION, "ranch_id": r["ranch_id"], "risk_class": cls, "finding_ids": [f["finding_id"] for f in fs],
              "codes": sorted({f["code"] for f in fs}), "anomaly_score": scores.get(r["ranch_id"], {}).get("score")}
        RanchRisk.model_validate(rr)
        ranch_risk.append(rr)

    def write(name, rows):
        (out / name).write_bytes(b"".join(canonical(r) + b"\n" for r in rows))
    write("findings.jsonl", sorted(F.items, key=lambda f: (f["entity_id"], f["code"])))
    write("ranch_risk.jsonl", ranch_risk)
    write("decisions.jsonl", decisions)
    summary = {"engine_version": RISK_ENGINE_VERSION, "schema_version": RISK_SCHEMA_VERSION, "dataset": F.dataset_id, "config": cfg.as_dict(),
               "findings": len(F.items), "ranch_findings": n_ranch, "lot_findings": len(F.items) - n_ranch,
               "findings_by_code": dict(sorted(Counter(f["code"] + ":" + f["severity"] for f in F.items).items())),
               "ranch_risk": dict(Counter(r["risk_class"] for r in ranch_risk)),
               "decisions": dict(Counter(d["outcome"] for d in decisions)),
               "note": "Decisions are produced from rules and measured values; no language model is used."}
    (out / "risk_summary.json").write_bytes(json.dumps(summary, indent=1, sort_keys=True).encode("utf-8"))
    return summary


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dataset", type=Path)
    a = ap.parse_args(argv)
    print(json.dumps(run(a.dataset), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
