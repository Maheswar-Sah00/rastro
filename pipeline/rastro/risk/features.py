"""Per-ranch movement-behaviour features, from detector-visible data only.

Holding time is measured on *bought* cattle: for every head a ranch sells, the FIFO allocation
records which purchased lot it came from and when that lot arrived. Opening stock and births are
excluded because their arrival date says nothing about resale speed.
"""
from collections import defaultdict
from statistics import mean

from rastro.lineage.service import ENV_CATS, LineageService
from rastro.risk.config import RiskConfig


def weighted_median(pairs):
    pairs = sorted(pairs, key=lambda p: p[1])
    total = sum(w for w, _ in pairs)
    if total <= 0:
        return None
    acc = 0.0
    for w, v in pairs:
        acc += w
        if acc >= total / 2:
            return v
    return pairs[-1][1]


def ranch_features(svc: LineageService, cfg: RiskConfig) -> dict[str, dict]:
    eng = svc.engines["fifo"]
    ranches = {r["ranch_id"]: r for r in svc.t["ranches"] if r["entity_type"] == "ranch"}
    months = len({r["period_start"] for r in svc.t.get("herd_inventory", [])}) or 36
    years = months / 12

    bought, sold, resold = defaultdict(float), defaultdict(float), defaultdict(float)
    holds = defaultdict(list)
    suppliers, buyers = defaultdict(set), defaultdict(set)
    buyer_head = defaultdict(lambda: defaultdict(float))
    upstream_risky = defaultdict(float)
    for lot in eng.moved.values():
        o, t = lot.origin, lot.destination
        sold[o] += lot.head
        buyers[o].add(t)
        buyer_head[o][t] += lot.head
        for src, k in lot.sources:
            if src in eng.moved:  # a purchased lot being resold
                resold[o] += k
                holds[o].append((k, (lot.date - eng.moved[src].date).days))
        if t in ranches:
            bought[t] += lot.head
            suppliers[t].add(o)
            upstream_risky[t] += sum(h for key, (h, _) in lot.comp.items() if set(svc.categories(key)) & set(ENV_CATS))

    births = defaultdict(int)
    for b in svc.t["birth_declarations"]:
        births[b["ranch_id"]] += b["declared_head"]

    inv = defaultdict(list)
    for row in svc.t.get("herd_inventory", []):
        inv[row["ranch_id"]].append(row)

    out = {}
    for rid, r in ranches.items():
        pasture = r.get("pasture_area_hectares")
        cap = pasture * cfg.stocking_central if pasture else None
        rows = sorted(inv.get(rid, []), key=lambda x: x["period_start"])
        quarters = [mean((m["opening_head"] + m["closing_head"]) / 2 for m in rows[i:i + 3]) for i in range(0, len(rows), 3)]
        peak = max(quarters) if quarters else None
        cows = r["breeding_cows_declared"]
        bmax = cows * cfg.max_calving_rate * years
        out[rid] = {
            "bought_head": bought[rid], "sold_head": sold[rid], "resold_bought_head": resold[rid],
            "resold_share": resold[rid] / bought[rid] if bought[rid] else None,
            "median_hold_days_bought": weighted_median(holds[rid]),
            "n_suppliers": len(suppliers[rid]), "n_buyers": len(buyers[rid]),
            "top_buyer_share": max(buyer_head[rid].values()) / sold[rid] if sold[rid] else None,
            "turnover_x_capacity": sold[rid] / years / cap if cap else None,
            "births_declared": births[rid], "breeding_cows": cows,
            "births_ratio": births[rid] / bmax if bmax else (0.0 if births[rid] == 0 else None),
            "peak_quarter_herd": peak, "pasture_ha": pasture, "capacity_central": cap,
            "capacity_use": peak / cap if cap and peak is not None else None,
            "upstream_risky_pct": 100 * upstream_risky[rid] / bought[rid] if bought[rid] else 0.0,
            "years": years,
        }
    return out
