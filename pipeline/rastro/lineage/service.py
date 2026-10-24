"""Lineage service over a canonical dataset: replay, origin risk categories, typed traces.

Reads only detector-visible partitions (inputs/, environment/, derived/), never truth/.
"""
import json
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from rastro.lineage import LINEAGE_VERSION
from rastro.lineage.engine import LineageEngine, Movement
from rastro.schemas.lineage import LINEAGE_SCHEMA_VERSION, LineageTrace

ENV_CATS = ("post_cutoff_deforestation", "embargo", "protected_overlap")


@dataclass(frozen=True)
class LineageConfig:
    deforestation_ha: float = 6.25        # PRODES minimum mapping unit; post-cut-off (+ straddling) clearing above it
    count_straddling: bool = True         # PRODES 2021 straddles the cut-off: counted as exposure, noted as uncertain
    # Attribution bands of the published decision rule (< review, review..fail, >= fail). When FIFO and
    # pro-rata put a lot in different bands, the allocation assumption decides the outcome -> review.
    band_review_pct: float = 5.0
    band_fail_pct: float = 25.0
    review_unknown_pct: float = 25.0
    review_coverage_pct: float = 75.0
    review_missing_evidence_pct: float = 5.0
    path_limit: int = 400                 # trace path rows kept per trace (largest attributed first)


def _jsonl(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l] if path.is_file() else []


class LineageService:
    def __init__(self, dataset: Path, cfg: LineageConfig = LineageConfig()):
        self.dataset, self.cfg = dataset, cfg
        t = {n: _jsonl(dataset / p / f"{n}.jsonl") for p, names in {
            "inputs": ("ranches", "destinations", "birth_declarations", "death_declarations", "gta_movements", "shipments"),
            "derived": ("ledger_refusals", "herd_inventory"),
            "environment": ("prodes_deforestation", "embargoes")}.items() for n in names}
        self.t = t
        self.geo = {r["ranch_id"]: r for r in _jsonl(dataset / "derived" / "geo_evidence.jsonl")}
        self.gta = {g["gta_id"]: g for g in t["gta_movements"]}
        self.lot_to_gta = {g["lot_id"]: g["gta_id"] for g in t["gta_movements"]}
        self.ship = {s["shipment_id"]: s for s in t["shipments"]}
        self.refused = {r["event_ref"]: r["reason"] for r in t["ledger_refusals"]}
        self.cats, self.cat_refs = self._origin_categories()
        self.engines = {p: self._replay(p) for p in ("fifo", "pro_rata")}

    # ---- replay ---------------------------------------------------------------------------------
    def _replay(self, policy):
        ranches = {r["ranch_id"]: {"kind": r["entity_type"], "opening_head": r["opening_head"],
                                   "registered_on": date.fromisoformat(r["registered_on"])} for r in self.t["ranches"]}
        sinks = {d["destination_id"] for d in self.t["destinations"]}
        moves = [Movement(g["gta_id"], g["origin_id"], g["destination_id"], date.fromisoformat(g["movement_date"]), g["head_count"],
                          g["lot_id"], date.fromisoformat(g["issue_date"]))
                 for g in self.t["gta_movements"]]
        births = [{"ref": b["birth_event_id"], "ranch": b["ranch_id"], "date": date.fromisoformat(b["date"]), "head": b["declared_head"]}
                  for b in self.t["birth_declarations"]]
        deaths = [{"ref": d["death_event_id"], "ranch": d["ranch_id"], "date": date.fromisoformat(d["date"]), "head": d["declared_head"]}
                  for d in self.t["death_declarations"]]
        skip = dict(self.refused)
        for g in self.t["gta_movements"]:  # permits requested while embargoed never move cattle
            if g["permit_status"] != "issued":
                skip.setdefault(g["gta_id"], "attempted_while_embargoed")
        return LineageEngine(ranches, sinks, policy).run(moves, births, deaths, skip)

    # ---- origin risk categories (detector-visible evidence only) ------------------------------
    def _origin_categories(self):
        cats, refs = defaultdict(set), defaultdict(set)
        for rid, g in self.geo.items():
            d = g["deforestation"]
            ha = None if d["post_cutoff_ha"] is None else d["post_cutoff_ha"] + ((d["straddles_cutoff_ha"] or 0) if self.cfg.count_straddling else 0)
            if ha is None:
                cats[rid].add("environmental_evidence_missing")
            elif ha >= self.cfg.deforestation_ha:
                cats[rid].add("post_cutoff_deforestation")
                refs[rid].add(f"geo_evidence:{rid}#deforestation")
            if g["embargo"]["status"] == "active":
                cats[rid].add("embargo")
                refs[rid].update(f"embargo:{e}" for e in g["embargo"]["embargo_ids"])
            if g["legal"]["recognised_indigenous_land_overlap"] or g["legal"]["strict_protection_overlap"]:
                cats[rid].add("protected_overlap")
                refs[rid].add(f"geo_evidence:{rid}#protected")
        for r in self.t["ranches"]:
            if r["entity_type"] == "ranch" and r["ranch_id"] not in self.geo:
                cats[r["ranch_id"]].add("environmental_evidence_missing")
        for b in self.t["birth_declarations"]:
            if b["validation_status"] == "exceeds_biology":
                cats[b["ranch_id"]].add("suspicious_births_or_inventory")
                refs[b["ranch_id"]].add(f"birth_declaration:{b['birth_event_id']}")
        for r in self.t["ledger_refusals"]:
            if r["reason"] in ("BirthsExceedBiology", "InsufficientHerd"):
                cats[r["ranch_id"]].add("suspicious_births_or_inventory")
                refs[r["ranch_id"]].add(f"ledger_refusal:{r['event_ref']}")
        return cats, refs

    def categories(self, origin_key: str) -> list[str]:
        rid, kind = origin_key.split("#", 1)
        if rid in ("UNRESOLVED", "MISSING") or kind == "external":
            return ["unknown_origin"]
        return sorted(self.cats.get(rid, set()))

    # ---- tracing --------------------------------------------------------------------------------
    def trace_shipment(self, shipment_id: str, policy: str = "fifo") -> dict:
        s = self.ship.get(shipment_id)
        if s is None:
            raise KeyError(f"unknown shipment {shipment_id}")
        return self._trace("shipment", shipment_id, s["gta_ids"], policy)

    def trace_gta(self, gta_id: str, policy: str = "fifo") -> dict:
        if gta_id not in self.gta:
            raise KeyError(f"unknown GTA {gta_id}")
        return self._trace("gta", None, [gta_id], policy)

    def trace_lot(self, lot_id: str, policy: str = "fifo") -> dict:
        if lot_id not in self.lot_to_gta:
            raise KeyError(f"unknown lot {lot_id}")
        return self._trace("lot", None, [self.lot_to_gta[lot_id]], policy)

    def _trace(self, kind, shipment_id, gta_ids, policy):
        eng = self.engines[policy]
        cfg = self.cfg
        declared = float(sum(self.gta[g]["head_count"] for g in gta_ids))
        applied = [self.gta[g]["lot_id"] for g in gta_ids if self.gta[g]["lot_id"] in eng.moved]
        unresolved = [{"gta_id": g, "head": self.gta[g]["head_count"], "reason": self.refused.get(g) or "attempted_while_embargoed"}
                      for g in gta_ids if self.gta[g]["lot_id"] not in eng.moved]
        comp = eng.composition(applied)
        for u in unresolved:  # refused permits: their head has no traceable origin and is a record-level inconsistency
            comp[f"UNRESOLVED#{u['gta_id']}"] = [float(u["head"]), 1]

        def pct(x):
            return round(100 * x / declared, 3) if declared else 0.0

        sources, by_cat, any_risk, env_any = [], defaultdict(float), 0.0, 0.0
        for key, (h, hops) in sorted(comp.items(), key=lambda kv: (-kv[1][0], kv[0])):
            rid, okind = key.split("#", 1)
            cats = self.categories(key)
            for c in cats:
                by_cat[c] += h
            if set(cats) & {*ENV_CATS, "suspicious_births_or_inventory", "unknown_origin"}:
                any_risk += h
            if set(cats) & set(ENV_CATS):
                env_any += h
            sources.append({"origin_key": key, "ranch_id": None if rid in ("UNRESOLVED", "MISSING") else rid,
                            "origin_kind": okind if okind in ("birth", "opening", "external") else rid.lower(),
                            "head_equiv": round(h, 3), "share_pct": pct(h), "min_hops": int(hops), "categories": cats})

        # suspected laundering: risky origin carried by a direct supplier that a direct-only check would clear
        laund = 0.0
        for lid in applied:
            lot = eng.moved[lid]
            if set(self.cats.get(lot.origin, set())) & set(ENV_CATS):
                continue
            laund += sum(h for k, (h, hops) in lot.comp.items() if hops >= 2 and set(self.categories(k)) & set(ENV_CATS))
        unknown = by_cat["unknown_origin"]
        record = sum(h for k, (h, _) in comp.items() if "suspicious_births_or_inventory" in self.categories(k) or k.startswith("UNRESOLVED#"))

        path = eng.path(applied) if applied else []
        path.sort(key=lambda r: -r["attributed_head"])
        truncated = len(path) > cfg.path_limit
        path = sorted(path[: cfg.path_limit], key=lambda r: (r["date"], r["gta_id"]))
        direct = sorted({self.gta[g]["origin_id"] for g in gta_ids})
        intermediaries = sorted({r["from"] for r in path} - set(direct))  # every upstream sender except the direct suppliers

        other = self.engines["pro_rata" if policy == "fifo" else "fifo"]
        alt = self._any_risk(other, gta_ids, declared, unresolved)
        mine = pct(any_risk)
        fifo_v, pr_v = (mine, alt) if policy == "fifo" else (alt, mine)
        spread = round(abs(fifo_v - pr_v), 3)

        coverage = pct(sum(h for k, (h, _) in comp.items() if k.split("#", 1)[1] in ("birth", "opening")))
        reasons = []
        band = lambda x: 0 if x < cfg.band_review_pct else (1 if x < cfg.band_fail_pct else 2)
        if band(fifo_v) != band(pr_v):
            reasons.append(f"FIFO ({fifo_v:.1f}%) and pro-rata ({pr_v:.1f}%) attributions fall in different risk bands: "
                           "the outcome depends on how mixed herds are allocated")
        if pct(unknown) >= cfg.review_unknown_pct:
            reasons.append(f"{pct(unknown):.1f}% of head has unknown or incomplete origin")
        if coverage < cfg.review_coverage_pct:
            reasons.append(f"lineage coverage {coverage:.1f}% is below {cfg.review_coverage_pct:.0f}%")
        if pct(by_cat["environmental_evidence_missing"]) >= cfg.review_missing_evidence_pct:
            reasons.append(f"{pct(by_cat['environmental_evidence_missing']):.1f}% of head comes from ranches without environmental evidence")
        if unresolved:
            reasons.append(f"{len(unresolved)} permit(s) in this lot were refused by the ledger rules")

        notes = [f"Allocation policy {policy}: an estimate under a cohort assumption, not the identity of individual animals."]
        if by_cat["post_cutoff_deforestation"] and cfg.count_straddling:
            notes.append("Post-cut-off exposure counts PRODES 2021 clearing (Aug 2020-Jul 2021), which straddles the 31 Dec 2020 cut-off.")
        if any(s["origin_kind"] == "opening" for s in sources):
            share = sum(s["share_pct"] for s in sources if s["origin_kind"] == "opening")
            notes.append(f"{share:.1f}% is opening stock: attributed to the ranch holding it at the start of the records; earlier origin unknown.")
        if truncated:
            notes.append(f"Trace path truncated to the {cfg.path_limit} movements carrying the most attributed head.")
        if self.geo and any(g["data_status"].get("ranches") != "real" for g in list(self.geo.values())[:1]):
            notes.append("Ranch boundaries are synthetic; environmental categories describe simulated ranch cells.")
        refs = sorted({r for s in sources if s["ranch_id"] for r in self.cat_refs.get(s["ranch_id"], ())})
        refs += [f"ledger_refusal:{u['gta_id']}" for u in unresolved]

        trace = {
            "schema_version": LINEAGE_SCHEMA_VERSION, "target_kind": kind, "shipment_id": shipment_id,
            "lot_ids": [self.gta[g]["lot_id"] for g in gta_ids], "gta_ids": list(gta_ids),
            "declared_head": declared, "traced_head": round(sum(h for k, (h, _) in comp.items() if not k.startswith(("UNRESOLVED#", "MISSING#"))), 3),
            "policy": policy, "coverage_pct": coverage, "sources": sources, "intermediaries": intermediaries,
            "direct_suppliers": direct, "max_hops": max((s["min_hops"] for s in sources), default=0),
            "exposure_pct": {"post_cutoff_deforestation": pct(by_cat["post_cutoff_deforestation"]), "embargo": pct(by_cat["embargo"]),
                             "protected_overlap": pct(by_cat["protected_overlap"]),
                             "suspicious_births_or_inventory": pct(by_cat["suspicious_births_or_inventory"]),
                             "environmental_evidence_missing": pct(by_cat["environmental_evidence_missing"]),
                             "unknown_or_incomplete": pct(unknown), "any_risk": mine},
            "attribution": {"record_inconsistency_pct": pct(record), "environmental_overlap_pct": pct(env_any),
                            "suspected_laundering_pct": pct(laund), "unknown_provenance_pct": pct(unknown),
                            "review_required": bool(reasons), "review_reasons": reasons},
            "policy_sensitivity": {"fifo_any_risk_pct": fifo_v, "pro_rata_any_risk_pct": pr_v, "spread_pct": spread},
            "trace_path": path, "unresolved": unresolved, "evidence_refs": refs[:200], "uncertainty_notes": notes,
        }
        LineageTrace.model_validate(trace)
        return trace

    def _any_risk(self, eng, gta_ids, declared, unresolved):
        applied = [self.gta[g]["lot_id"] for g in gta_ids if self.gta[g]["lot_id"] in eng.moved]
        comp = eng.composition(applied)
        risky = sum(h for k, (h, _) in comp.items()
                    if set(self.categories(k)) & {*ENV_CATS, "suspicious_births_or_inventory", "unknown_origin"})
        risky += sum(u["head"] for u in unresolved)
        return round(100 * risky / declared, 3) if declared else 0.0

    # ---- batch ------------------------------------------------------------------------------------
    def trace_all(self, out: Path | None = None) -> dict:
        out = out or self.dataset / "derived"
        traces = [self.trace_shipment(s) for s in sorted(self.ship)]
        (out / "lineage_traces.jsonl").write_bytes(
            "".join(json.dumps(t, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n" for t in traces).encode("utf-8"))
        issues = defaultdict(lambda: {"count": 0, "head": 0.0})
        for i in self.engines["fifo"].issues:
            issues[i.code]["count"] += 1
            issues[i.code]["head"] = round(issues[i.code]["head"] + i.head, 3)
        summary = {"lineage_version": LINEAGE_VERSION, "schema_version": LINEAGE_SCHEMA_VERSION, "policy": "fifo",
                   "alternative_policy": "pro_rata", "config": self.cfg.__dict__, "shipments": len(traces),
                   "conservation": {p: e.conservation() for p, e in self.engines.items()}, "issues": dict(sorted(issues.items())),
                   "review_required": sum(t["attribution"]["review_required"] for t in traces),
                   "environmental_evidence": "derived/geo_evidence.jsonl" if self.geo else "missing"}
        (out / "lineage_summary.json").write_bytes(json.dumps(summary, indent=1, sort_keys=True, default=str).encode("utf-8"))
        return summary
