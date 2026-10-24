"""Detectors A-E and lot-level findings. Every explanation is built from the measured values."""
import hashlib
from collections import defaultdict

from rastro.risk import RISK_ENGINE_VERSION
from rastro.risk.config import RiskConfig
from rastro.schemas.risk import RISK_SCHEMA_VERSION

VERSIONS = {"A_environmental": "A/1.0.0", "B_inventory": "B/1.0.0", "C_pass_through": "C/1.0.0",
            "D_over_capacity": "D/1.0.0", "E_isolation_forest": "E/iforest-1.0.0", "lineage": "L/1.0.0"}
SYNTHETIC_RANCH = "ranch boundary, herd and permits are synthetic: the finding describes a simulated ranch"


class Findings:
    def __init__(self, observed_at: str, dataset_id: str):
        self.items: list[dict] = []
        self.observed_at, self.dataset_id = observed_at, dataset_id

    def add(self, *, detector, code, entity_type, entity_id, category, severity, confidence, blocking, features, observed,
            thresholds, evidence_ids, explanation, limitations, refs=()):
        key = f"{detector}|{code}|{entity_type}|{entity_id}"
        fid = "F-" + hashlib.sha256(key.encode()).hexdigest()[:16]
        self.items.append({
            "schema_version": RISK_SCHEMA_VERSION, "finding_id": fid, "entity_type": entity_type, "entity_id": entity_id,
            "dataset_refs": [self.dataset_id, *refs], "detector": detector, "detector_version": f"{VERSIONS[detector]} (engine {RISK_ENGINE_VERSION})",
            "code": code, "category": category, "severity": severity, "confidence": round(confidence, 2), "blocking": blocking,
            "features": _clean(features), "observed": _clean(observed),
            "thresholds": [{"name": n, "value": v, "comparison": c} for n, v, c in thresholds],
            "evidence_ids": list(evidence_ids)[:50], "explanation": explanation, "limitations": list(limitations),
            "observed_at": self.observed_at,
        })

    def by_entity(self):
        out = defaultdict(list)
        for f in self.items:
            out[f["entity_id"]].append(f)
        return out


def _clean(d):
    return {k: (round(v, 3) if isinstance(v, float) else v) for k, v in d.items()}


# ---- A: environmental exposure (ranch level) -----------------------------------------------------
def detector_a(F: Findings, svc, cfg: RiskConfig):
    periods = {p["record_id"]: p for p in svc.t["prodes_deforestation"]}
    for r in svc.t["ranches"]:
        rid = r["ranch_id"]
        if r["entity_type"] != "ranch":
            continue
        g = svc.geo.get(rid)
        lim = [SYNTHETIC_RANCH, "screening indicator from public layers, not a legal determination"]
        if g is None or g["deforestation"]["post_cutoff_ha"] is None:
            F.add(detector="A_environmental", code="ENV_EVIDENCE_MISSING", entity_type="ranch", entity_id=rid, category="data_gap",
                  severity="watch", confidence=1.0, blocking=False, features={}, observed={"geo_evidence": "missing" if g is None else "unmeasured"},
                  thresholds=[], evidence_ids=[f"geo_evidence:{rid}"] if g else [],
                  explanation=f"No measurable environmental evidence for {rid}; missing data is not treated as clean.",
                  limitations=lim + (g["warnings"] if g else []))
            continue
        d = g["deforestation"]
        post, strad = d["post_cutoff_ha"], d["straddles_cutoff_ha"] or 0.0
        ha = post + strad
        if ha >= cfg.deforestation_watch_ha:
            ids = d["intersecting_polygon_ids"]["post_cutoff"] + d["intersecting_polygon_ids"]["straddles_cutoff"]
            ends = sorted(periods[i]["observation_period_end"] for i in ids if i in periods and periods[i]["observation_period_end"])
            high = ha >= cfg.deforestation_high_ha
            conf = 0.9 - (0.25 if strad > post else 0) - (0.1 if d["coverage"] != "full" else 0)
            l2 = lim + ([f"{strad:.1f} ha is PRODES 2021 clearing, which straddles the 31 Dec 2020 cut-off"] if strad else [])
            F.add(detector="A_environmental", code="POST2020_DEFORESTATION", entity_type="ranch", entity_id=rid, category="environmental",
                  severity="high" if high else "watch", confidence=conf, blocking=high,
                  features={"coverage": d["coverage"], "polygons": len(ids)},
                  observed={"post_cutoff_ha": post, "straddles_cutoff_ha": strad, "latest_period_end": ends[-1] if ends else None},
                  thresholds=[("deforestation_watch_ha", cfg.deforestation_watch_ha, ">="), ("deforestation_high_ha", cfg.deforestation_high_ha, ">=")],
                  evidence_ids=[f"geo_evidence:{rid}", *ids], refs=[f"prodes:{g['dataset_versions'].get('deforestation', '')}"],
                  explanation=(f"{ha:.1f} ha of PRODES-mapped clearing after the cut-off intersects {rid} "
                               f"({post:.1f} ha post-cut-off, {strad:.1f} ha in a straddling year), "
                               f"{'at or above' if high else 'below'} the {cfg.deforestation_high_ha:.0f} ha high threshold; latest mapping period ends {ends[-1] if ends else 'n/a'}."),
                  limitations=l2)
        e = g["embargo"]
        if e["status"] in ("active", "unverified", "historical"):
            active = e["status"] == "active"
            F.add(detector="A_environmental", code="EMBARGOED", entity_type="ranch", entity_id=rid, category="environmental",
                  severity="high" if active else ("watch" if e["status"] == "unverified" else "info"), confidence=0.95 if active else 0.5,
                  blocking=active, features={"simulated": e["simulated"]}, observed={"status": e["status"], "since": e["since"]},
                  thresholds=[("embargo_status", "active", "==")], evidence_ids=[f"embargo:{x}" for x in e["embargo_ids"]],
                  explanation=f"{rid} has a {e['status']} embargo since {e['since']} ({', '.join(e['sources'])}).",
                  limitations=lim + (["the embargo is simulated for the demonstration, not an Ibama record"] if e["simulated"] else []))
        for key, area in (("indigenous_territory", g["indigenous_territory"]), ("protected_area", g["protected_area"])):
            for a in (area or {}).get("areas", []):
                blocking_area = a.get("recognised") or a.get("strict_protection")
                if not blocking_area or a["overlap_ha"] < cfg.protected_min_ha:
                    continue
                F.add(detector="A_environmental", code="PROTECTED_AREA", entity_type="ranch", entity_id=rid, category="environmental",
                      severity="high", confidence=0.85, blocking=True, features={"layer": key},
                      observed={"area": a["name"], "overlap_ha": a["overlap_ha"], "overlap_share": a["overlap_share"]},
                      thresholds=[("protected_min_ha", cfg.protected_min_ha, ">=")], evidence_ids=[f"geo_evidence:{rid}", a["feature_id"]],
                      explanation=f"{a['overlap_ha']:.1f} ha ({100 * a['overlap_share']:.1f}%) of {rid} lies in {a['name']}: {a['legal_context']}.",
                      limitations=lim)


# ---- B: inventory and births ---------------------------------------------------------------------
def detector_b(F: Findings, svc, cfg: RiskConfig):
    refused_out, refused_in = defaultdict(lambda: defaultdict(float)), defaultdict(float)
    refs = defaultdict(list)
    for r in svc.t["ledger_refusals"]:
        refused_out[r["ranch_id"]][r["reason"]] += r["head"]
        refs[r["ranch_id"]].append(f"ledger_refusal:{r['event_ref']}")
        g = svc.gta.get(r["event_ref"])
        if g and g["destination_type"] == "ranch":
            refused_in[g["destination_id"]] += r["head"]
    for rid, by in refused_out.items():
        short = by.get("InsufficientHerd", 0)
        if short:
            victim = refused_in[rid] >= short
            F.add(detector="B_inventory", code="INSUFFICIENT_HERD", entity_type="ranch", entity_id=rid, category="record_inconsistency",
                  severity="watch" if victim else "high", confidence=0.6 if victim else 0.95, blocking=not victim,
                  features={"refused_inbound_head": refused_in[rid]}, observed={"head_shipped_without_inventory": short},
                  thresholds=[("declared_balance", 0, ">= head on permit")], evidence_ids=refs[rid],
                  explanation=(f"Permits from {rid} for {short:.0f} head exceeded its declared inventory and were refused. "
                               + (f"It had itself received {refused_in[rid]:.0f} head on refused permits, so this is treated as exposure, not as its own fraud."
                                  if victim else "Conservation of cattle is broken at this ranch.")),
                  limitations=["inventory is reconstructed from declarations; undeclared deaths or births can also cause gaps"])
    for row in svc.t.get("herd_inventory", []):
        if row["closing_head"] < 0:
            F.add(detector="B_inventory", code="NEGATIVE_INVENTORY", entity_type="ranch", entity_id=row["ranch_id"], category="record_inconsistency",
                  severity="high", confidence=1.0, blocking=True, features={}, observed={"period": row["period_start"], "closing_head": row["closing_head"]},
                  thresholds=[("closing_head", 0, ">=")], evidence_ids=[f"herd_inventory:{row['ranch_id']}:{row['period_start']}"],
                  explanation=f"{row['ranch_id']} closes {row['period_start'][:7]} with {row['closing_head']} head.", limitations=[])
    by_ranch = defaultdict(list)
    for b in svc.t["birth_declarations"]:
        by_ranch[b["ranch_id"]].append(b)
    cows_of = {r["ranch_id"]: r["breeding_cows_declared"] for r in svc.t["ranches"]}
    for rid, bs in by_ranch.items():
        over = [b for b in bs if b["validation_status"] == "exceeds_biology"]
        border = [b for b in bs if b["validation_status"] == "borderline"]
        refused = refused_out[rid].get("BirthsExceedBiology", 0)
        cows = cows_of.get(rid, 0)
        lim = [f"breeding cows are self-declared ({cows}); the bound uses {cfg.max_calving_rate} calves/cow/year with a +/-{100 * cfg.breeding_cow_uncertainty:.0f}% count band",
               "the ledger cannot establish whether a declared birth physically occurred"]
        if over or refused:
            years = sorted({b["year"] for b in over})
            worst = max(over, key=lambda b: b["cumulative_year_head"]) if over else None
            F.add(detector="B_inventory", code="PHANTOM_BIRTHS", entity_type="ranch", entity_id=rid, category="record_inconsistency",
                  severity="high", confidence=0.85, blocking=True, features={"breeding_cows": cows, "years": years},
                  observed={"declarations_above_bound": len(over), "head_refused": refused,
                            "max_year_births": worst["cumulative_year_head"] if worst else None,
                            "upper_plausible_births": worst["maximum_plausible_births_high"] if worst else None},
                  thresholds=[("maximum_plausible_births_high", worst["maximum_plausible_births_high"] if worst else 0, "<=")],
                  evidence_ids=[f"birth_declaration:{b['birth_event_id']}" for b in over] + [x for x in refs[rid] if "B-" in x],
                  explanation=(f"{rid} declared {worst['cumulative_year_head'] if worst else 0:,} births in {worst['year'] if worst else '-'} with {cows} declared breeding cows; "
                               f"even the upper estimate allows {worst['maximum_plausible_births_high'] if worst else 0:,}. {refused:.0f} head of births were refused by the ledger."),
                  limitations=lim)
        elif border:
            F.add(detector="B_inventory", code="BIRTHS_BORDERLINE", entity_type="ranch", entity_id=rid, category="record_inconsistency",
                  severity="watch", confidence=0.4, blocking=False, features={"breeding_cows": cows},
                  observed={"borderline_declarations": len(border)}, thresholds=[("maximum_plausible_births", border[0]["maximum_plausible_births"], "<=")],
                  evidence_ids=[f"birth_declaration:{b['birth_event_id']}" for b in border],
                  explanation=f"{rid} declared births above the point estimate but inside the uncertainty band of its breeding-cow count.",
                  limitations=lim)
    groups = defaultdict(list)
    for g in svc.t["gta_movements"]:
        groups[(g["origin_id"], g["destination_id"], g["movement_date"], g["head_count"])].append(g["gta_id"])
    for (o, dst, day, head), ids in groups.items():
        if len(ids) > 1 and o.startswith("R"):
            F.add(detector="B_inventory", code="DUPLICATE_MOVEMENT", entity_type="ranch", entity_id=o, category="record_inconsistency",
                  severity="watch", confidence=0.5, blocking=False, features={}, observed={"permits": len(ids), "date": day, "head": head, "to": dst},
                  thresholds=[("identical permits per day", 1, "<=")], evidence_ids=[f"gta:{i}" for i in ids],
                  explanation=f"{len(ids)} permits from {o} to {dst} on {day} carry exactly {head} head each: possible duplicate permit.",
                  limitations=["identical permits can be legitimate split loads"])
    for i in svc.engines["fifo"].issues:
        if i.code in ("impossible_chronology", "movement_before_registration") and i.ranch:
            F.add(detector="B_inventory", code="CHRONOLOGY", entity_type="ranch", entity_id=i.ranch, category="record_inconsistency",
                  severity="watch", confidence=0.9, blocking=False, features={}, observed={"gta": i.ref, "detail": i.detail},
                  thresholds=[], evidence_ids=[f"gta:{i.ref}"], explanation=f"{i.ref}: {i.detail}.", limitations=[])


# ---- C: pass-through intermediaries --------------------------------------------------------------
def detector_c(F: Findings, feats, cfg: RiskConfig):
    for rid, f in feats.items():
        mh, share, turn = f["median_hold_days_bought"], f["resold_share"], f["turnover_x_capacity"]
        if mh is None or share is None or f["bought_head"] < cfg.pass_through_min_bought:
            continue
        if not (mh < cfg.pass_through_hold_days and share >= cfg.pass_through_resold_share and (turn is None or turn >= cfg.pass_through_turnover)):
            continue
        risky = f["upstream_risky_pct"]
        high = risky >= cfg.pass_through_high_upstream_pct
        F.add(detector="C_pass_through", code="PASS_THROUGH", entity_type="ranch", entity_id=rid, category="behavioural",
              severity="high" if high else "watch", confidence=0.75 if high else 0.35, blocking=False,
              features={k: f[k] for k in ("bought_head", "sold_head", "n_suppliers", "n_buyers", "top_buyer_share")},
              observed={"median_hold_days_bought": mh, "resold_share": share, "turnover_x_capacity": turn, "upstream_risky_pct": risky},
              thresholds=[("pass_through_hold_days", cfg.pass_through_hold_days, "<"), ("pass_through_resold_share", cfg.pass_through_resold_share, ">="),
                          ("pass_through_turnover", cfg.pass_through_turnover, ">="), ("pass_through_high_upstream_pct", cfg.pass_through_high_upstream_pct, ">=")],
              evidence_ids=[f"lineage:{rid}"],
              explanation=(f"{rid} resold {100 * share:.0f}% of the {f['bought_head']:,.0f} head it bought after a median {mh} days "
                           f"({turn:.1f}x yearly capacity) from {f['n_suppliers']} suppliers to {f['n_buyers']} buyers. "
                           + (f"{risky:.0f}% of its supply traces to risky origins, the triangulation pattern used to launder cattle."
                              if high else f"Only {risky:.0f}% of its supply traces to risky origins; legitimate traders also resell fast, so this is a lead, not evidence.")),
              limitations=["holding time comes from a FIFO estimate of which bought lot was resold", SYNTHETIC_RANCH])


# ---- D: over-capacity ---------------------------------------------------------------------------
def detector_d(F: Findings, feats, cfg: RiskConfig):
    for rid, f in feats.items():
        if f["pasture_ha"] is None or f["peak_quarter_herd"] is None:
            continue  # reported by A as missing evidence; never treated as within capacity
        central = f["pasture_ha"] * cfg.stocking_central
        high_cap = f["pasture_ha"] * cfg.stocking_high
        peak = f["peak_quarter_herd"]
        if central <= 0 or peak <= central * cfg.over_capacity_watch:
            continue
        high = peak > high_cap * cfg.over_capacity_high
        F.add(detector="D_over_capacity", code="OVER_CAPACITY", entity_type="ranch", entity_id=rid, category="behavioural",
              severity="high" if high else "watch", confidence=0.7 if high else 0.4, blocking=False,
              features={"pasture_ha": f["pasture_ha"]}, observed={"peak_quarter_herd": peak, "head_per_ha": peak / f["pasture_ha"]},
              thresholds=[("capacity at central stocking x watch", central * cfg.over_capacity_watch, ">"),
                          ("capacity at optimistic stocking x high", high_cap * cfg.over_capacity_high, ">")],
              evidence_ids=[f"herd_inventory:{rid}", f"geo_evidence:{rid}"],
              explanation=(f"{rid} averaged {peak:,.0f} head over its peak quarter on {f['pasture_ha']:,.0f} ha of pasture "
                           f"({peak / f['pasture_ha']:.1f} head/ha), above {'even the optimistic' if high else 'the central'} "
                           f"stocking of {cfg.stocking_high if high else cfg.stocking_central} head/ha. An investigation lead: the extra animals may be on uncleared or neighbouring land."),
              limitations=["pasture is cleared area mapped by PRODES inside a synthetic boundary", "herd is the declared inventory"])


# ---- E: IsolationForest ----------------------------------------------------------------------------
def detector_e(F: Findings, scores, cfg: RiskConfig):
    others = F.by_entity()
    for rid, s in scores.items():
        if not s["outlier"]:
            continue
        ctx = sorted({f["code"] for f in others.get(rid, [])})
        reasons = "; ".join(f"{r['label']} {r['value']:g} vs median {r['population_median']:g}" for r in s["reasons"])
        F.add(detector="E_isolation_forest", code="ANOMALY", entity_type="ranch", entity_id=rid, category="behavioural",
              severity="watch", confidence=0.3, blocking=False,
              features={r["feature"]: r["value"] for r in s["reasons"]}, observed={"anomaly_score": s["score"], "reason_codes": [r["feature"] for r in s["reasons"]],
                                                                                 "rule_context": ctx},
              thresholds=[("contamination", cfg.iforest_contamination, "top share")], evidence_ids=[f"model:iforest-v1:{rid}"],
              explanation=(f"Among the {cfg.iforest_contamination:.0%} most unusual ranches by movement behaviour: {reasons}. "
                           + (f"Rule detectors also report {', '.join(ctx)}." if ctx else "No rule detector fires for this ranch.")
                           + " The anomaly score ranks unusualness; it is not a probability of fraud."),
              limitations=["unsupervised: unusual is not the same as illegal", "fitted on this dataset's ranches only"])


# ---- lot level, from lineage ------------------------------------------------------------------------
def blocking_share(trace: dict, blocking_ranches: set[str]) -> tuple[float, list[dict]]:
    """Share of the lot whose origin ranch has a blocking finding (each head counted once)."""
    srcs = [x for x in trace["sources"] if x["ranch_id"] in blocking_ranches]
    return sum(x["share_pct"] for x in srcs), srcs


def lot_findings(F: Findings, trace: dict, cfg: RiskConfig, blocking_ranches: set[str]):
    sid, e, a = trace["shipment_id"], trace["exposure_pct"], trace["attribution"]
    blocked, srcs = blocking_share(trace, blocking_ranches)
    unresolved = sum(x["share_pct"] for x in trace["sources"] if x["origin_kind"] == "unresolved")
    exposed = a["environmental_overlap_pct"]   # any post-cut-off clearing, embargo or protected overlap (EUDR-relevant)
    worst = blocked + unresolved
    if worst >= cfg.review_exposure_pct:
        high = blocked + unresolved >= cfg.flag_exposure_pct
        top = sorted(srcs, key=lambda x: -x["share_pct"])[:5] or [x for x in trace["sources"] if set(x["categories"]) & {"post_cutoff_deforestation", "embargo", "protected_overlap"}][:5]
        F.add(detector="lineage", code="TAINTED_SUPPLY", entity_type="shipment", entity_id=sid,
              category="environmental" if blocked >= unresolved else "record_inconsistency",
              severity="high" if high else "watch", confidence=0.8 if not a["review_required"] else 0.5, blocking=high,
              features={"declared_head": trace["declared_head"], "max_hops": trace["max_hops"], "policy": trace["policy"]},
              observed={"blocking_origin_pct": round(blocked, 3), "refused_or_unresolved_pct": round(unresolved, 3),
                        "environmental_overlap_pct": exposed, "suspected_laundering_pct": a["suspected_laundering_pct"],
                        "post_cutoff_pct": e["post_cutoff_deforestation"], "embargo_pct": e["embargo"], "protected_pct": e["protected_overlap"],
                        "pro_rata_any_risk_pct": trace["policy_sensitivity"]["pro_rata_any_risk_pct"]},
              thresholds=[("review_exposure_pct", cfg.review_exposure_pct, ">="), ("flag_exposure_pct (blocking origins + refused)", cfg.flag_exposure_pct, ">=")],
              evidence_ids=trace["evidence_refs"][:30],
              explanation=(f"{blocked:.1f}% of the {trace['declared_head']:,.0f} head in {sid} trace to origins with a blocking finding"
                           + (" (" + ", ".join("%s %.1f%%" % (x["origin_key"].split("#")[0], x["share_pct"]) for x in top) + ")" if top else "")
                           + f" and {unresolved:.1f}% to refused or unresolved permits; {exposed:.1f}% trace to any post-cut-off clearing, embargo or protected-area overlap, "
                           f"up to {trace['max_hops']} hops back. {a['suspected_laundering_pct']:.1f}% arrived through a direct supplier that a direct-only check would clear."),
              limitations=trace["uncertainty_notes"])
    if e["unknown_or_incomplete"] >= cfg.review_unknown_pct:
        F.add(detector="lineage", code="UNKNOWN_ORIGIN", entity_type="shipment", entity_id=sid, category="unknown_provenance",
              severity="watch", confidence=0.9, blocking=False, features={}, observed={"unknown_pct": e["unknown_or_incomplete"], "coverage_pct": trace["coverage_pct"]},
              thresholds=[("review_unknown_pct", cfg.review_unknown_pct, ">=")], evidence_ids=[f"lineage:{sid}"],
              explanation=f"{e['unknown_or_incomplete']:.1f}% of {sid} has unknown or incomplete origin (suppliers outside the study window or unresolved permits).",
              limitations=trace["uncertainty_notes"])
