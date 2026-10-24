"""Trace a shipment, GTA or lot back to its estimated origins.

    python -m rastro.lineage.trace ../data/synthetic/evaluation SHP-V-202308
    python -m rastro.lineage.trace DATASET GTA-PA-2024-004211 --policy pro_rata
    python -m rastro.lineage.trace DATASET SHP-D-000017 --json
    python -m rastro.lineage.trace DATASET --all          # every shipment -> derived/lineage_traces.jsonl
"""
import argparse
import json
import sys
from pathlib import Path

from rastro.lineage.service import LineageService

SHORT = {"post_cutoff_deforestation": "post-cutoff clearing", "embargo": "embargo", "protected_overlap": "protected/TI",
         "suspicious_births_or_inventory": "births/inventory", "environmental_evidence_missing": "no env evidence",
         "unknown_origin": "unknown origin"}


def render(t: dict, top: int = 20) -> str:
    L = []
    target = t["shipment_id"] or t["gta_ids"][0]
    L.append(f"Lineage trace {target} ({t['target_kind']}), policy {t['policy']}")
    L.append(f"  declared {t['declared_head']:,.0f} head, traced {t['traced_head']:,.1f}, coverage {t['coverage_pct']:.1f}%, "
             f"{len(t['gta_ids'])} permit(s), direct suppliers {', '.join(t['direct_suppliers'])}, max {t['max_hops']} hops")
    L.append("")
    L.append(f"  {'origin':<22}{'kind':<11}{'head':>10}{'share':>8}{'hops':>6}  categories")
    for s in t["sources"][:top]:
        cats = ", ".join(SHORT[c] for c in s["categories"]) or "-"
        L.append(f"  {s['origin_key'].split('#')[0]:<22}{s['origin_kind']:<11}{s['head_equiv']:>10,.1f}{s['share_pct']:>7.1f}%{s['min_hops']:>6}  {cats}")
    if len(t["sources"]) > top:
        rest = t["sources"][top:]
        L.append(f"  ... {len(rest)} more origins, {sum(s['share_pct'] for s in rest):.1f}% of head")
    e, a, p = t["exposure_pct"], t["attribution"], t["policy_sensitivity"]
    L.append("")
    L.append("  Exposure (share of declared head; a source can be in several categories)")
    for k in ("post_cutoff_deforestation", "embargo", "protected_overlap", "suspicious_births_or_inventory",
              "environmental_evidence_missing", "unknown_or_incomplete"):
        L.append(f"    {k.replace('_', ' '):<34}{e[k]:>7.1f}%")
    L.append(f"    {'any risk (each head counted once)':<34}{e['any_risk']:>7.1f}%")
    L.append("")
    L.append("  Attribution (kept separate; none is a legal conclusion)")
    L.append(f"    1. record-level inconsistency     {a['record_inconsistency_pct']:>7.1f}%")
    L.append(f"    2. environmental overlap          {a['environmental_overlap_pct']:>7.1f}%")
    L.append(f"    3. suspected laundering           {a['suspected_laundering_pct']:>7.1f}%  (risky origin behind a supplier a direct-only check clears)")
    L.append(f"    4. unknown provenance             {a['unknown_provenance_pct']:>7.1f}%")
    L.append(f"    5. human review required          {'YES' if a['review_required'] else 'no'}")
    L.append(f"  Policy sensitivity: any-risk {p['fifo_any_risk_pct']:.1f}% (FIFO) vs {p['pro_rata_any_risk_pct']:.1f}% (pro-rata), spread {p['spread_pct']:.1f} pts")
    L.append(f"  Path: {len(t['trace_path'])} upstream movements; intermediaries: {', '.join(t['intermediaries'][:12]) or '-'}"
             + (" ..." if len(t["intermediaries"]) > 12 else ""))
    warn = a["review_reasons"] + t["uncertainty_notes"] + [f"unresolved {u['head']} head on {u['gta_id']}: {u['reason']}" for u in t["unresolved"]]
    if warn:
        L.append("")
        L.append("  Warnings")
        L += [f"    ! {w}" for w in warn]
    return "\n".join(L)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dataset", type=Path)
    ap.add_argument("target", nargs="?", help="SHP-..., GTA-... or LOT-...")
    ap.add_argument("--policy", choices=("fifo", "pro_rata"), default="fifo")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--all", action="store_true")
    a = ap.parse_args(argv)
    svc = LineageService(a.dataset)
    if a.all:
        print(json.dumps(svc.trace_all(), indent=1, default=str))
        return 0
    if not a.target:
        ap.error("give a target or --all")
    if a.target.startswith("SHP-"):
        t = svc.trace_shipment(a.target, a.policy)
    elif a.target.startswith("LOT-"):
        t = svc.trace_lot(a.target, a.policy)
    else:
        t = svc.trace_gta(a.target, a.policy)
    print(json.dumps(t, indent=1, ensure_ascii=False) if a.json else render(t))
    return 0


if __name__ == "__main__":
    sys.exit(main())
