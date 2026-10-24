"""Stage 3: ledger rules + detection AI + evaluation + exports.

Only "agency-visible" data is used for detection: ranch registry (real geo checks), declared
births and GTAs. Ground truth from the simulator is used ONLY to evaluate.

1. Ledger filter: a Python mirror of HerdLedger.sol, replayed in date order. GTAs it refuses
   (embargoed origin, more head than the ranch holds) and impossible births are recorded.
2. Detection: real-geo hard flags, ledger flags, carrying capacity, FIFO holding times,
   flow-weighted origin tracing (mass-balance mixing over the GTA graph) and an
   IsolationForest over behavioural features for patterns the rules don't name.
3. Shipments: every sink-bound lot is traced back to origin ranches; verdicts for today's
   direct-supplier check vs Rastro; evaluated against the simulator's true origins.
4. Exports for the web app and the on-chain replay.
"""
import hashlib
import json
from collections import defaultdict, deque
from datetime import date, timedelta
from pathlib import Path

import geopandas as gpd
import numpy as np
from sklearn.ensemble import IsolationForest

HERE = Path(__file__).parent
DER, OUT = HERE / "data" / "derived", HERE / "out"
WEB = HERE.parent / "web" / "public" / "data"
START = date(2023, 1, 1)
CAPACITY = 1.5
MAX_CALVING_BPS = 8500
SALT = "rastro-demo-salt-v1|"
PURPOSE = {"breeding": 0, "rearing": 1, "fattening": 2, "slaughter": 3, "export": 4}


def h32(obj):
    raw = obj if isinstance(obj, bytes) else json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return "0x" + hashlib.sha256(raw).hexdigest()


def oid(entity_id):
    return h32((SALT + entity_id).encode())


def iso(day):
    return (START + timedelta(days=int(day))).isoformat()


def unix(day):
    return int((date(START.year, 1, 1) - date(1970, 1, 1)).days * 86400 + int(day) * 86400)


def main():
    OUT.mkdir(exist_ok=True)
    (WEB / "layers").mkdir(parents=True, exist_ok=True)
    (WEB / "evidence").mkdir(parents=True, exist_ok=True)
    stress = __import__("os").environ.get("RASTRO_STRESS") == "1"
    world = json.loads((DER / ("world_stress.json" if stress else "world.json")).read_text(encoding="utf-8"))
    dest = json.loads((DER / "destinations.json").read_text(encoding="utf-8"))
    sinks = {d["id"]: d for d in dest}
    R = {r["id"]: r for r in world["ranches"]}
    real_ids = [i for i in R if i.startswith("R")]
    for r in R.values():
        r["capacity"] = int(r["pasture_ha"] * CAPACITY) if r["id"].startswith("R") else 10**7
        r.setdefault("breeding_cows", 0)

    # ------------------------------------------------------------------ 1. ledger filter
    events = []
    for b in world["births"]:
        events.append((b["day"], 0, "births", b))
    for g in world["gtas"]:
        events.append((g["day"], 1, "movement", g))
    for r in R.values():
        if r.get("embargo_day") is not None:
            events.append((r["embargo_day"], -1, "embargo", {"ranch": r["id"]}))
    events.sort(key=lambda e: (e[0], e[1]))

    bal = {i: R[i]["initial_head"] for i in R}
    qarea = defaultdict(float)   # (ranch, quarter) -> head*days
    last = {i: 0 for i in R}

    def tick(i, day):
        d0 = last[i]
        while d0 < day:
            q_end = (d0 // 91 + 1) * 91
            d1 = min(day, q_end)
            qarea[(i, d0 // 91)] += bal[i] * (d1 - d0)
            d0 = d1
        last[i] = max(last[i], day)
    births_year = defaultdict(int)
    embargoed = set()
    accepted, rejected = [], []
    peak = defaultdict(int)
    for day, _, kind, ev in events:
        if kind == "embargo":
            embargoed.add(ev["ranch"])
            accepted.append(("embargo", day, ev))
        elif kind == "births":
            r = R[ev["ranch"]]
            cap = r["breeding_cows"] * MAX_CALVING_BPS // 10000
            if births_year[(r["id"], ev["year"])] + ev["head"] > cap:
                rejected.append(("births", day, ev, "BirthsExceedBiology"))
                continue
            births_year[(r["id"], ev["year"])] += ev["head"]
            tick(r["id"], day)
            bal[r["id"]] += ev["head"]
            accepted.append(("births", day, ev))
        else:
            f, t, n = ev["from"], ev["to"], ev["head"]
            if f in embargoed:
                rejected.append(("movement", day, ev, "OriginEmbargoed"))
                continue
            if bal[f] < n:
                rejected.append(("movement", day, ev, "InsufficientHerd"))
                continue
            tick(f, day)
            bal[f] -= n
            if t in bal:
                tick(t, day)
                bal[t] += n
            accepted.append(("movement", day, ev))
    for i in R:
        tick(i, 365 * 3)
    for (i, q), a in qarea.items():
        peak[i] = max(peak[i], int(a / 91))  # quarterly time-weighted average herd
    acc_gtas = [ev for k, _, ev in accepted if k == "movement"]
    rej_by = defaultdict(lambda: [0, 0])
    for k, _, ev, why in rejected:
        rej_by[why][0] += 1
        rej_by[why][1] += ev["head"]
    print("ledger refused:", dict(rej_by))

    # ------------------------------------------------------------------ 2a. hard flags (real geo + ledger)
    flags = defaultdict(list)
    def flag(i, code, severity, title, text, evidence=None):
        flags[i].append({"code": code, "severity": severity, "title": title, "text": text, "evidence": evidence or {}})

    decl_births = defaultdict(int)
    for b in world["births"]:
        decl_births[b["ranch"]] += b["head"]
    rej_out = defaultdict(lambda: defaultdict(int))
    rej_in = defaultdict(int)
    for k, _, ev, why in rejected:
        if k == "movement":
            rej_out[ev["from"]][why] += ev["head"]
            rej_in[ev["to"]] += ev["head"]
        else:
            rej_out[ev["ranch"]][why] += ev["head"]

    for i in real_ids:
        r = R[i]
        d20 = r["defor_post2020_ha"]
        if d20 >= 50:
            flag(i, "POST2020_DEFORESTATION", "high", f"{d20:,.0f} ha cleared after 2020",
                 f"INPE PRODES maps {d20:,.0f} ha of deforestation inside this ranch after the EUDR cut-off (31 Dec 2020). Cattle raised here cannot enter the EU and large clearings are rarely licensed.",
                 {"defor_post2020_ha": round(d20, 1), "source": "INPE PRODES yearly deforestation"})
        elif d20 >= 6.25:
            flag(i, "POST2020_DEFORESTATION", "watch", f"{d20:,.1f} ha cleared after 2020",
                 f"PRODES maps {d20:,.1f} ha of post-2020 deforestation. It may be licensed under Brazilian law, but it breaks the EUDR zero-deforestation rule for EU-bound beef.",
                 {"defor_post2020_ha": round(d20, 1), "source": "INPE PRODES yearly deforestation"})
        if r["ti_overlap_ha"] >= 1:
            flag(i, "PROTECTED_AREA", "high", f"{r['ti_overlap_ha']:,.0f} ha inside an Indigenous land",
                 f"The ranch boundary overlaps {r['ti_overlap_ha']:,.0f} ha of the {r.get('protected_name') or 'Indigenous'} Indigenous land, where cattle ranching is illegal.",
                 {"ti_overlap_ha": round(r["ti_overlap_ha"], 1)})
        if r.get("embargo_day") is not None:
            flag(i, "EMBARGOED", "high", "Under environmental embargo",
                 f"Embargoed on {iso(r['embargo_day'])} after illegal clearing was detected. Any GTA from this ranch is refused by the ledger.",
                 {"embargo_date": iso(r["embargo_day"])})
        bmax = r["breeding_cows"] * MAX_CALVING_BPS // 10000 * 3
        if decl_births[i] > bmax:
            flag(i, "PHANTOM_BIRTHS", "high", f"Declared {decl_births[i]:,} births; biology allows {bmax:,}",
                 f"With {r['breeding_cows']} breeding cows this ranch can produce at most {bmax:,} calves in three years, yet it declared {decl_births[i]:,}. Animals that appear on paper as births usually arrived without a GTA, from an embargoed or illegal area.",
                 {"births_declared": decl_births[i], "births_biological_max": bmax, "breeding_cows": r["breeding_cows"]})
        if sum(rej_out[i].values()) and "InsufficientHerd" in rej_out[i]:
            victim = rej_in[i] >= rej_out[i]["InsufficientHerd"]
            flag(i, "INSUFFICIENT_HERD", "watch" if victim else "high",
                 f"Tried to ship {rej_out[i]['InsufficientHerd']:,} head it did not hold",
                 ("Part of this ranch's supply arrived on GTAs the ledger refused, so its later sales were short. Treat as exposure, not fraud." if victim else
                  "The ledger refused GTAs because the ranch held fewer animals than it tried to ship. Conservation of cattle broken."),
                 {"head_refused": rej_out[i]["InsufficientHerd"]})
        if r["capacity"] > 0 and peak[i] > r["capacity"] * 1.25:
            pct = 100 * peak[i] / r["capacity"]
            flag(i, "OVER_CAPACITY", "high", f"Herd averaged {pct:,.0f}% of pasture capacity for a quarter",
                 f"A three-month average of {peak[i]:,} head on {r['pasture_ha']:,.0f} ha of pasture ({peak[i] / max(r['pasture_ha'], 1):.1f} head/ha). Amazon pasture rarely supports more than {CAPACITY} head/ha, so the extra animals are likely kept on uncleared or protected land.",
                 {"peak_head": peak[i], "capacity_head": r["capacity"], "pasture_ha": round(r["pasture_ha"], 1)})

    def hard(i, level="high"):
        return any(f["severity"] == level and f["code"] in ("POST2020_DEFORESTATION", "PROTECTED_AREA", "EMBARGOED", "PHANTOM_BIRTHS", "OVER_CAPACITY") for f in flags[i])
    def watch_geo(i):
        return any(f["severity"] == "watch" and f["code"] == "POST2020_DEFORESTATION" for f in flags[i])

    # ------------------------------------------------------------------ 2b. mixing (origin tracing) + FIFO holding times
    # Lot-level lineage: every inflow GTA (or birth) becomes a FIFO lot carrying its origin mix.
    # A sale pops lots first-in-first-out and inherits their mix, the standard mass-balance
    # assumption for cohorts (GTAs record date and age class of each lot).
    fifo = {i: deque([[float(R[i]["initial_head"]), -180, {i: [1.0, 0]}]]) for i in R}
    hold = defaultdict(list)
    inflow, outflow = defaultdict(int), defaultdict(int)
    suppliers = defaultdict(set)
    gta_comp = {}
    for k, day, ev in accepted:
        if k == "births":
            fifo[ev["ranch"]].append([float(ev["head"]), day, {ev["ranch"]: [1.0, 0]}])
            continue
        if k != "movement":
            continue
        f, t, n = ev["from"], ev["to"], ev["head"]
        moved = defaultdict(lambda: [0.0, 99])
        need = float(n)
        while need > 1e-9 and fifo[f]:
            lot = fifo[f][0]
            k_ = min(need, lot[0])
            hold[f].append((k_, day - lot[1]))
            for o, (sh, hp) in lot[2].items():
                moved[o][0] += k_ * sh
                moved[o][1] = min(moved[o][1], hp + 1)
            lot[0] -= k_
            need -= k_
            if lot[0] <= 1e-9:
                fifo[f].popleft()
        gta_comp[ev["gta"]] = {o: v for o, v in moved.items() if v[0] >= 1e-3}
        outflow[f] += n
        if t in fifo:
            tot = sum(v[0] for v in moved.values()) or 1.0
            fifo[t].append([float(n), day, {o: [v[0] / tot, v[1]] for o, v in moved.items() if v[0] / tot >= 1e-4}])
            inflow[t] += n
            suppliers[t].add(f)

    def median_hold(i):
        hs = hold.get(i)
        if not hs:
            return None
        hs = sorted(hs, key=lambda z: z[1])
        half, acc = sum(k for k, _ in hs) / 2, 0
        for k, d in hs:
            acc += k
            if acc >= half:
                return int(d)

    def classify(origin):
        if origin.startswith("X"):
            return "unknown"
        if hard(origin):
            return "flagged"
        if watch_geo(origin):
            return "watch"
        return "clean"

    # inflow taint per ranch (share of head received that traces to flagged origins)
    taint_in = defaultdict(lambda: defaultdict(float))
    for g in acc_gtas:
        if g["to"] in R:
            for o, (x, hp) in gta_comp[g["gta"]].items():
                taint_in[g["to"]][classify(o)] += x

    def share(i, cls):
        tot = sum(taint_in[i].values())
        return 100 * taint_in[i][cls] / tot if tot else 0.0

    # ------------------------------------------------------------------ 2c. behaviour + AI anomaly
    feats, fid = [], []
    for i in real_ids:
        r = R[i]
        mh = median_hold(i)
        cap = max(r["capacity"], 1)
        thr = outflow[i] / 3 / cap
        if mh is not None and mh < 45 and thr > 1.0 and inflow[i] > 0:
            if share(i, "flagged") >= 35:
                flag(i, "PASS_THROUGH", "high", f"Resells animals after a median {mh} days",
                     f"Buys and resells {outflow[i]:,} head in three years ({thr:.1f}x its yearly capacity) after a median {mh} days on the farm, too short for any weight gain, and {share(i, 'flagged'):.0f}% of what it buys traces back to flagged ranches. This is the triangulation pattern used to launder cattle.",
                     {"median_holding_days": mh, "turnover_x_capacity": round(thr, 2), "flagged_supply_pct": round(share(i, "flagged"), 1)})
            else:
                flag(i, "PASS_THROUGH", "watch", f"Fast resale (median {mh} days)",
                     f"Resells quickly ({mh} days median), as legitimate cattle traders also do. Its suppliers are mostly clean ({share(i, 'flagged'):.0f}% flagged), so this alone is not evidence of laundering.",
                     {"median_holding_days": mh, "turnover_x_capacity": round(thr, 2), "flagged_supply_pct": round(share(i, "flagged"), 1)})
        sf = share(i, "flagged")
        if sf >= 20 and not any(f["code"] == "PASS_THROUGH" and f["severity"] == "high" for f in flags[i]):
            flag(i, "TAINTED_SUPPLY", "watch", f"{sf:.0f}% of supply traces to flagged ranches",
                 f"Following every GTA upstream (mass-balance tracing), {sf:.0f}% of the animals this ranch received originate on ranches with post-2020 clearing, embargoes, Indigenous-land overlap or impossible births.",
                 {"flagged_supply_pct": round(sf, 1)})
        feats.append([np.log1p(thr), np.log1p(mh if mh is not None else 400), np.log1p(inflow[i] / cap), np.log1p(outflow[i] / cap),
                      decl_births[i] / max(r["breeding_cows"] * 0.85 * 3, 1), peak[i] / cap, sf, len(suppliers[i])])
        fid.append(i)
    X = np.array(feats)
    iso_f = IsolationForest(n_estimators=400, contamination=0.04, random_state=0).fit(X)
    score = -iso_f.score_samples(X)
    pred = iso_f.predict(X)
    anom = {i: float(s) for i, s in zip(fid, score)}
    for i, p in zip(fid, pred):
        if p == -1 and not any(f["severity"] == "high" for f in flags[i]):
            flag(i, "ANOMALY", "watch", "Unusual movement pattern",
                 "An IsolationForest trained on all ranches' movement behaviour (turnover, holding time, births vs herd, capacity use, supplier mix) ranks this ranch among the 4% most unusual. Worth a closer look; not evidence on its own.",
                 {"anomaly_score": round(anom[i], 3)})

    # risk class & score
    smin, smax = min(anom.values()), max(anom.values())
    risk = {}
    for i in real_ids:
        sev = [f["severity"] for f in flags[i]]
        cls = "high" if "high" in sev else ("watch" if "watch" in sev else "clean")
        base = {"high": 0.75, "watch": 0.4, "clean": 0.05}[cls]
        sc = min(0.99, base + 0.2 * (anom[i] - smin) / (smax - smin + 1e-9) + 0.04 * len(flags[i]))
        risk[i] = {"class": cls, "score": round(sc, 3),
                   "flags": sorted(flags[i], key=lambda f: f["severity"] != "high")}

    # ------------------------------------------------------------------ 3. shipments & evaluation
    direct_sq = {}
    for i in real_ids:  # today's check: meatpacker screens its DIRECT suppliers' polygons + embargo list
        r = R[i]
        direct_sq[i] = bool(r["defor_post2020_ha"] >= 6.25 or r["ti_overlap_ha"] >= 1 or r.get("embargo_day") is not None)
    tainted_truth = {i for i in R if R[i]["truth"] in ("dirty_source", "phantom_births", "launderer", "over_capacity")}
    eudr_truth = {i for i in R if i.startswith("R") and R[i]["defor_post2020_ha"] >= 6.25}

    def bad_head(lots_, market):
        return sum(l[0] for l in lots_ if l[2] in tainted_truth or (market == "EU" and l[2] in eudr_truth))

    def trace(gs):
        agg = defaultdict(lambda: [0.0, 99])
        for g in gs:
            for o, (x, hp) in gta_comp[g["gta"]].items():
                agg[o][0] += x
                agg[o][1] = min(agg[o][1], hp)
        tot = sum(v[0] for v in agg.values()) or 1
        pct = defaultdict(float)
        for o, (x, _) in agg.items():
            pct[classify(o)] += 100 * x / tot
        by_ranch = sorted(({"ranch": o, "head_equiv": round(x, 1), "risk_class": (risk[o]["class"] if o in risk else "unknown"),
                            "hops": int(hp)} for o, (x, hp) in agg.items() if x >= 0.5), key=lambda d: -d["head_equiv"])
        return pct, by_ranch

    FAIL_T, REVIEW_T = [float(x) for x in __import__("os").environ.get("RASTRO_T", "25,5").split(",")]

    def judge(pct, market, direct):
        direct_high = any(risk.get(d, {}).get("class") == "high" for d in direct)
        eudr = pct["watch"] if market == "EU" else 0
        if pct["flagged"] >= FAIL_T or direct_high or eudr >= FAIL_T:
            return "fail"
        if pct["flagged"] >= REVIEW_T or eudr >= REVIEW_T or pct["unknown"] >= 25:
            return "review"
        return "pass"

    rng = np.random.default_rng(11)
    lots = [g for g in acc_gtas if g["to"] in sinks]
    lot_eval = []
    for g in lots:
        market = "TR" if g["to"] == "P:BARCARENA" else (str(rng.choice(["EU", "CN", "BR"], p=[0.35, 0.3, 0.35])) if sinks[g["to"]]["inspection"] == "SIF" else "BR")
        pct, by_ranch = trace([g])
        true_t = bad_head(g["lots"], market)
        sq = "fail" if direct_sq.get(g["from"], False) else "pass"
        lot_eval.append({"g": g, "market": market, "pct": pct, "by_ranch": by_ranch, "true_t": true_t, "sq": sq,
                         "ra": judge(pct, market, {g["from"]})})
    tot_taint = sum(l["true_t"] for l in lot_eval)
    sq_caught = sum(l["true_t"] for l in lot_eval if l["sq"] == "fail")
    ra_caught = sum(l["true_t"] for l in lot_eval if l["ra"] != "pass")
    clean_lots = [l for l in lot_eval if l["true_t"] / l["g"]["head"] < 0.01 and R[l["g"]["from"]]["truth"] == "honest"]
    clean_failed = sum(1 for l in clean_lots if l["ra"] == "fail")
    clean_reviewed = sum(1 for l in clean_lots if l["ra"] == "review")
    sq_clean_failed = sum(1 for l in clean_lots if l["sq"] == "fail")

    def links_of(gs, cap=40):
        agg = defaultdict(float)
        for g in gs:
            for o, (x, _) in gta_comp[g["gta"]].items():
                agg[(o, g["from"])] += x
        top = sorted(agg.items(), key=lambda kv: -kv[1])
        out = [{"origin": o, "via": v, "head": round(x, 1), "class": classify(o)} for (o, v), x in top[:cap] if x >= 0.5]
        rest = defaultdict(float)
        for (o, v), x in top[cap:]:
            rest[(classify(o), v)] += x
        out += [{"origin": f"other:{c}", "via": v, "head": round(x, 1), "class": c} for (c, v), x in rest.items() if x >= 0.5]
        return out

    def ship(n, gs, market, sq, kind):
        pct, by_ranch = trace(gs)
        direct = sorted({g["from"] for g in gs})
        head = sum(g["head"] for g in gs)
        true_t = sum(bad_head(g["lots"], market) for g in gs)
        return {"id": f"SHP-{n:04d}", "kind": kind, "destination": gs[0]["to"], "market": market, "head": head,
                "date": iso(max(g["day"] for g in gs)), "gtas": [g["gta"] for g in gs],
                "trace": {"clean_pct": round(pct["clean"], 1), "watch_pct": round(pct["watch"], 1), "flagged_pct": round(pct["flagged"], 1),
                          "unknown_pct": round(pct["unknown"], 1), "max_hops": max((d["hops"] for d in by_ranch), default=0),
                          "by_ranch": by_ranch[:12], "n_origins": len(by_ranch), "links": links_of(gs)},
                "direct_suppliers": direct, "status_quo_verdict": sq, "rastro_verdict": judge(pct, market, set(direct)),
                "truth_tainted_pct": round(100 * true_t / head, 1)}

    shipments, n = [], 0
    # live-export voyages: each month's ship carries only lots that passed today's direct-supplier screening
    voy = defaultdict(list)
    for l in lot_eval:
        if l["g"]["to"] == "P:BARCARENA" and l["sq"] == "pass":
            voy[iso(l["g"]["day"])[:7]].append(l["g"])
    # destination mix of live cattle shipped from Pará, Jan-Jul 2025 (Sedap/Agência Pará); voyages are synthetic
    dest_mix = {"EG": 36.2, "IQ": 20.8, "LB": 14.0, "MA": 13.4, "TR": 6.4, "SA": 4.6, "JO": 2.9}
    vrng = np.random.default_rng(2025)
    for ym in sorted(voy):
        n += 1
        mk = str(vrng.choice(list(dest_mix), p=np.array(list(dest_mix.values())) / sum(dest_mix.values())))
        shipments.append(ship(n, voy[ym], mk, "pass", "voyage"))
    # slaughterhouse deliveries (one GTA each)
    for l in sorted((l for l in lot_eval if l["g"]["to"] != "P:BARCARENA"), key=lambda l: l["g"]["day"]):
        n += 1
        shipments.append(ship(n, [l["g"]], l["market"], l["sq"], "delivery"))
    # ranch-level evaluation (laundering network = launderer + phantom births + over-capacity fronts)
    def prf(pred, truth):
        tp = len(pred & truth)
        return {"precision": round(tp / len(pred), 3) if pred else 0.0, "recall": round(tp / len(truth), 3) if truth else 0.0, "tp": tp, "predicted": len(pred), "actual": len(truth)}
    bad_truth = {i for i in real_ids if R[i]["truth"] != "honest"}
    net_truth = {i for i in real_ids if R[i]["truth"] in ("launderer", "phantom_births", "over_capacity")}
    sells_direct = {g["from"] for g in acc_gtas if g["to"] in sinks}
    sq_pred = {i for i in real_ids if direct_sq[i] and i in sells_direct}
    ra_pred = {i for i in real_ids if risk[i]["class"] == "high"}
    ev = {
        "status_quo": {**prf(sq_pred, bad_truth), "network_recall": prf(sq_pred, net_truth)["recall"],
                       "dirty_sources_found": len(sq_pred & tainted_truth), "dirty_sources_total": len(tainted_truth),
                       "tainted_head_caught_pct": round(100 * sq_caught / max(tot_taint, 1), 1),
                       "clean_lots_failed_pct": round(100 * sq_clean_failed / max(len(clean_lots), 1), 1)},
        "rastro": {**prf(ra_pred, bad_truth), "network_recall": prf(ra_pred, net_truth)["recall"],
                   "dirty_sources_found": len(ra_pred & tainted_truth), "dirty_sources_total": len(tainted_truth),
                   "tainted_head_caught_pct": round(100 * ra_caught / max(tot_taint, 1), 1),
                   "clean_lots_failed_pct": round(100 * clean_failed / max(len(clean_lots), 1), 1),
                   "clean_lots_reviewed_pct": round(100 * clean_reviewed / max(len(clean_lots), 1), 1)},
        "lots": len(lot_eval), "tainted_head_at_sinks": int(tot_taint), "head_at_sinks": int(sum(l["g"]["head"] for l in lot_eval)),
    }
    print(json.dumps(ev, indent=1))
    fp = [i for i in ra_pred if R[i]["truth"] == "honest"]
    from collections import Counter
    print("FP high-ranch flag codes:", Counter(f["code"] for i in fp for f in risk[i]["flags"] if f["severity"] == "high"))
    print("FP roles:", Counter(R[i]["role"] for i in fp))
    cl = [l for l in clean_lots if l["ra"] == "fail"]
    import os
    if os.environ.get("RASTRO_DEBUG"):
        for l in [l for l in cl if l["pct"]["flagged"] >= 10][:4]:
            g = l["g"]
            print("LOT", g["gta"], g["from"], R[g["from"]]["role"], "->", g["to"], g["head"], "est", {k: round(v, 1) for k, v in l["pct"].items()})
            print("  truth origins:", [(o, h, R[o]["truth"]) for h, _, o in g["lots"]][:8])
            top = sorted(gta_comp[g["gta"]].items(), key=lambda kv: -kv[1][0])[:8]
            print("  est origins  :", [(o, round(v[0], 1), classify(o), R[o]["truth"]) for o, v in top])
    print("clean lots failed:", len(cl), "by direct-high:", sum(1 for l in cl if risk.get(l["g"]["from"], {}).get("class") == "high"),
          "by flagged>=10:", sum(1 for l in cl if l["pct"]["flagged"] >= 10), "by eudr:", sum(1 for l in cl if l["market"] == "EU" and l["pct"]["watch"] >= 10))

    if stress:
        (OUT / "stress_eval.json").write_text(json.dumps(ev, indent=1), encoding="utf-8")
        print("stress eval written")
        return

    # ------------------------------------------------------------------ 4. exports
    for old in (WEB / "evidence").glob("*.json"):
        old.unlink()
    land = gpd.read_file(DER / "landscape.gpkg", layer="ranches").to_crs(4326)
    land["geometry"] = land.geometry.simplify(0.0004, preserve_topology=True)
    feats_out = []
    for _, row in land.iterrows():
        i = row["id"]
        r = R[i]
        ev_bundle = {"ranch": i, "onchain_id": oid(i), "as_of": "2025-12-31", "risk_class": risk[i]["class"],
                     "score": risk[i]["score"], "flags": risk[i]["flags"], "method": "rastro-detect v1",
                     "inputs": {"prodes": "INPE PRODES 2008-2025", "gtas": len([1 for g in acc_gtas if i in (g["from"], g["to"])])}}
        raw = json.dumps(ev_bundle, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        eh = h32(raw)
        (WEB / "evidence" / f"{eh[2:]}.json").write_bytes(raw)
        bmax = r["breeding_cows"] * MAX_CALVING_BPS // 10000 * 3
        feats_out.append({"type": "Feature", "geometry": row.geometry.__geo_interface__, "properties": {
            "id": i, "onchain_id": oid(i), "role": r["role"], "area_ha": round(r["area_ha"], 1), "pasture_ha": round(r["pasture_ha"], 1),
            "capacity_head": r["capacity"], "head_now": int(bal[i]), "breeding_cows": int(r["breeding_cows"]),
            "defor_post2008_ha": round(r["defor_post2008_ha"], 1), "defor_post2020_ha": round(r["defor_post2020_ha"], 1),
            "defor_by_year": json.loads(r["defor_by_year"]) if isinstance(r["defor_by_year"], str) else r["defor_by_year"],
            "in_protected": bool(r["ti_overlap_ha"] >= 1), "protected_name": r.get("protected_name") if r["ti_overlap_ha"] >= 1 else None,
            "uc_name": "APA Triunfo do Xingu" if r["uc_overlap_ha"] >= 1 else None,
            "ti_overlap_ha": round(r["ti_overlap_ha"], 1), "uc_overlap_ha": round(r["uc_overlap_ha"], 1),
            "embargoed": r.get("embargo_day") is not None, "inflow_head": int(inflow[i]), "outflow_head": int(outflow[i]),
            "median_holding_days": median_hold(i), "births_declared": int(decl_births[i]), "births_biological_max": int(bmax),
            "capacity_peak_pct": round(100 * peak[i] / max(r["capacity"], 1), 1),
            "rejected_gtas": int(sum(1 for k, _, e, _w in rejected if k == "movement" and e["from"] == i)),
            "risk": {**risk[i], "evidence_hash": eh}, "upstream_taint_pct": round(share(i, "flagged"), 1),
            "status_quo_flagged": bool(direct_sq[i] and i in sells_direct), "sells_direct": i in sells_direct,
            "truth": r["truth"]}})
    (WEB / "ranches.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats_out}, ensure_ascii=False), encoding="utf-8")
    ev_hash = {f["properties"]["id"]: f["properties"]["risk"]["evidence_hash"] for f in feats_out}

    rej_set = {e["gta"]: why for k, _, e, why in rejected if k == "movement"}
    suspicious_ranch = {i for i in real_ids if risk[i]["class"] == "high"}
    movements = []
    for g in sorted(world["gtas"], key=lambda g: g["day"]):
        movements.append({"gta": g["gta"], "hash": h32({k: g[k] for k in ("gta", "from", "to", "head", "day", "purpose")}),
                          "from": g["from"], "to": g["to"], "head": g["head"], "date": iso(g["day"]),
                          "purpose": "export" if g["to"] == "P:BARCARENA" else g["purpose"],
                          "suspicious": g["from"] in suspicious_ranch, "rejected": rej_set.get(g["gta"])})
    (WEB / "movements.json").write_text(json.dumps(movements), encoding="utf-8")
    mhash = {m["gta"]: m["hash"] for m in movements}

    for s in shipments:
        bundle = {"shipment": s["id"], "destination": s["destination"], "head": s["head"], "gtas": [mhash[g] for g in s["gtas"]],
                  "trace": s["trace"], "verdict": s["rastro_verdict"], "method": "rastro-detect v1 mass-balance trace"}
        raw = json.dumps(bundle, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        eh = h32(raw)
        (WEB / "evidence" / f"{eh[2:]}.json").write_bytes(raw)
        s["certificate"] = {"lot_id": h32(("lot|" + s["id"]).encode()), "verdict": {"pass": "clean", "fail": "flagged", "review": "unknown"}[s["rastro_verdict"]], "evidence_hash": eh}
    (WEB / "shipments.json").write_text(json.dumps(shipments, ensure_ascii=False), encoding="utf-8")
    (WEB / "destinations.json").write_text(json.dumps(dest, ensure_ascii=False, indent=1), encoding="utf-8")

    # layers
    clearing = gpd.read_file(DER / "landscape.gpkg", layer="clearing").to_crs(4326)
    yearly = clearing[clearing.year >= 2008].copy()
    yearly["area_ha"] = (yearly.to_crs(31982).area / 1e4).round(1)
    yearly = yearly[yearly.area_ha >= 1]
    yearly["geometry"] = yearly.geometry.simplify(0.0002, preserve_topology=True)
    yearly[["year", "area_ha", "geometry"]].to_file(WEB / "layers" / "deforestation.geojson", driver="GeoJSON", COORDINATE_PRECISION=5)
    pre = clearing[clearing.year == 2007].copy()
    pre["geometry"] = pre.geometry.simplify(0.0008, preserve_topology=True)
    pre[["year", "geometry"]].to_file(WEB / "layers" / "cleared_before_2008.geojson", driver="GeoJSON", COORDINATE_PRECISION=4)
    prot = gpd.read_file(DER / "landscape.gpkg", layer="protected").to_crs(4326)
    prot["geometry"] = prot.geometry.simplify(0.0005, preserve_topology=True)
    prot[["name", "kind", "geometry"]].to_file(WEB / "layers" / "protected.geojson", driver="GeoJSON", COORDINATE_PRECISION=5)
    gpd.read_file(DER / "landscape.gpkg", layer="aoi").to_crs(4326).to_file(WEB / "layers" / "aoi.geojson", driver="GeoJSON")

    ibge = json.loads((HERE / "data" / "raw" / "ibge_herd.json").read_text(encoding="utf-8"))
    herd_start = sum(R[i]["initial_head"] for i in real_ids)
    tr_ships = [s for s in shipments if s["kind"] == "voyage"]
    passed_sq_tainted = sum(1 for l in lot_eval if l["sq"] == "pass" and l["true_t"] / l["g"]["head"] >= 0.01)
    metrics = {
        "counts": {"ranches": len(real_ids), "external_suppliers": len(R) - len(real_ids), "movements": len(world["gtas"]),
                   "head_moved": sum(g["head"] for g in world["gtas"]), "shipments": len(shipments),
                   "head_to_sinks": sum(s["head"] for s in shipments), "herd_start": herd_start},
        "eval": ev,
        "ledger": {"refused": {k: {"gtas_or_events": v[0], "head": v[1]} for k, v in rej_by.items()},
                   "smuggled_head_without_gta": sum(s["head"] for s in world["smuggled"])},
        "headline": {
            "tainted_head_pct_passing_status_quo": round(100 - ev["status_quo"]["tainted_head_caught_pct"], 1),
            "tainted_head_pct_caught_rastro": ev["rastro"]["tainted_head_caught_pct"],
            "laundering_ranches_found": len(ra_pred & net_truth), "laundering_ranches_total": len(net_truth),
            "shipments_with_tainted_cattle_passing_status_quo": passed_sq_tainted,
            "voyages": len(tr_ships), "voyages_flagged": sum(1 for s in tr_ships if s["rastro_verdict"] != "pass"),
            "voyages_failed": sum(1 for s in tr_ships if s["rastro_verdict"] == "fail"),
            "voyage_markets": {m: sum(1 for s in tr_ships if s["market"] == m) for m in sorted({s["market"] for s in tr_ships})},
        },
        "real_data": {"prodes_polygons_in_window": int(len(yearly)), "defor_post2020_ha": round(float(yearly[yearly.year >= 2021].area_ha.sum()), 0),
                      "defor_2008_2025_ha": round(float(yearly.area_ha.sum()), 0),
                      "ibge_herd_municipality": ibge["1507300"]["herd"].get("2025"), "ibge_year": 2025,
                      "ibge_herd_para": ibge["15"]["herd"].get("2025"),
                      "window_herd_share_of_municipality_pct": round(100 * herd_start / ibge["1507300"]["herd"]["2025"], 1)},
        "stress_test": json.loads((OUT / "stress_eval.json").read_text(encoding="utf-8")) if (OUT / "stress_eval.json").exists() else None,
        "thresholds": {"fail_flagged_pct": FAIL_T, "review_flagged_pct": REVIEW_T},
        "notes": "Synthetic ranch boundaries/herds/GTAs calibrated to public aggregates; evaluation is against the simulator's ground truth. stress_test = launderers hold cattle 60-120 days and chain two laundering hops.",
    }
    (WEB / "metrics.json").write_text(json.dumps(metrics, indent=1, ensure_ascii=False), encoding="utf-8")
    meta = {
        "project": "Rastro", "aoi": {"name": "São Félix do Xingu, Pará (study window)", "bbox": [-52.3, -7.0, -51.6, -6.3]},
        "generated_at": f"{date.today().isoformat()}T00:00:00Z", "years": [2023, 2024, 2025], "eudr_cutoff": "2020-12-31",
        "synthetic_notice": "Ranch boundaries, herds and GTAs are synthetic, calibrated to public aggregates. Deforestation, protected areas, slaughterhouse locations and municipal herd are real.",
        "sources": [
            {"name": "INPE PRODES yearly deforestation & accumulated to 2007 (TerraBrasilis)", "url": "https://terrabrasilis.dpi.inpe.br", "license": "CC BY-SA 4.0", "real": True},
            {"name": "Indigenous lands & conservation units (TerraBrasilis / FUNAI / MMA)", "url": "https://terrabrasilis.dpi.inpe.br", "license": "open", "real": True},
            {"name": "IBGE PPM cattle herd, table 3939", "url": "https://sidra.ibge.gov.br/tabela/3939", "license": "open", "real": True},
            {"name": "Trase Brazil beef logistics map v6 (slaughterhouse locations)", "url": "https://trase.earth/open-data/datasets/brazil-facilities", "license": "CC BY 4.0", "real": True},
            {"name": "Ranches, herds, GTAs, embargoes (simulated)", "url": "https://github.com/", "license": "MIT", "real": False}],
    }
    (WEB / "meta.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False), encoding="utf-8")

    # ------------------------------------------------------------------ chain seed
    def ent(i):
        r = R[i]
        return {"id": i, "onchain_id": oid(i), "capacity_head": int(min(r["capacity"], 2**32 - 1)), "initial_head": int(r["initial_head"]),
                "breeding_cows": int(r["breeding_cows"]), "geom_hash": h32(("geom|" + i).encode())}
    seed_events = []
    for k, day, e in accepted:
        if k == "births":
            seed_events.append({"type": "births", "ranch": oid(e["ranch"]), "head": e["head"], "year": e["year"]})
        elif k == "embargo":
            seed_events.append({"type": "embargo", "ranch": oid(e["ranch"]), "reason_hash": h32(("embargo|" + e["ranch"]).encode())})
        else:
            seed_events.append({"type": "movement", "gta": e["gta"], "hash": mhash[e["gta"]], "from": oid(e["from"]), "to": oid(e["to"]),
                                "head": e["head"], "purpose": PURPOSE["export" if e["to"] == "P:BARCARENA" else e["purpose"]], "date_unix": unix(day)})
    attest = [{"ranch": oid(i), "risk_class": {"clean": 0, "watch": 1, "high": 2}[risk[i]["class"]], "score_bps": int(risk[i]["score"] * 10000),
               "evidence_hash": ev_hash[i], "as_of": unix(365 * 3 - 1)} for i in real_ids if risk[i]["class"] != "clean"]
    def cert(s):
        return {"lot_id": s["certificate"]["lot_id"], "shipment": s["id"], "sink": oid(s["destination"]), "gta_hashes": [mhash[g] for g in s["gtas"]],
                "head": s["head"], "verdict": {"clean": 0, "flagged": 1, "unknown": 2}[s["certificate"]["verdict"]], "evidence_hash": s["certificate"]["evidence_hash"]}
    # demo shipments: a Türkiye-bound export lot that today's check passes but Rastro flags, and a clean EU-bound lot
    tr_demo = max((s for s in shipments if s["kind"] == "voyage" and s["market"] == "TR" and s["rastro_verdict"] == "fail"),
                  key=lambda s: s["trace"]["flagged_pct"], default=None) or max(
                  (s for s in shipments if s["kind"] == "voyage" and s["rastro_verdict"] == "fail"), key=lambda s: s["trace"]["flagged_pct"], default=None)
    eu_demo = max((s for s in shipments if s["market"] == "EU" and s["rastro_verdict"] == "pass"), key=lambda s: s["head"], default=None)
    demo_ships = [s for s in (tr_demo, eu_demo) if s]
    att = next((e for k, d, e, why in rejected if k == "movement" and why == "OriginEmbargoed"), None)
    ph = next((i for i in real_ids if R[i]["truth"] == "phantom_births"), None)
    demo = {"shipments": [s["id"] for s in demo_ships],
            "consume_clean": eu_demo["certificate"]["lot_id"] if eu_demo else None,
            "double_consume": eu_demo["certificate"]["lot_id"] if eu_demo else None,
            "consume_flagged": tr_demo["certificate"]["lot_id"] if tr_demo else None,
            "embargoed_attempt": {"gta": att["gta"], "hash": mhash[att["gta"]], "from": oid(att["from"]), "to": oid(att["to"]), "head": att["head"],
                                  "purpose": PURPOSE["export" if att["to"] == "P:BARCARENA" else att["purpose"]], "date_unix": unix(att["day"])} if att else None,
            "phantom_births_attempt": {"ranch": oid(ph), "head": 500, "year": 2025} if ph else None,
            "labels": {"tr": tr_demo["id"] if tr_demo else None, "eu": eu_demo["id"] if eu_demo else None,
                       "embargoed_ranch": att["from"] if att else None, "phantom_ranch": ph}}
    # subset for public testnet: entities touched by demo lots / attempts, balances set to cover them
    sub_g = [g for s in demo_ships for g in acc_gtas if g["gta"] in set(s["gtas"])]
    sub_ids = sorted({g["from"] for g in sub_g} | ({att["from"]} if att else set()) | ({ph} if ph else set())
                     | ({att["to"]} if att and att["to"] in R else set()))
    sub_r = []
    for i in sub_ids:
        e = ent(i)
        e["initial_head"] = int(sum(g["head"] for g in sub_g if g["from"] == i) + 10)
        sub_r.append(e)
    sub_sinks = sorted({g["to"] for g in sub_g} | ({att["to"]} if att and att["to"] in sinks else set()))
    sub_events = ([{"type": "embargo", "ranch": oid(att["from"]), "reason_hash": h32(("embargo|" + att["from"]).encode())}] if att else []) + [
        {"type": "movement", "gta": g["gta"], "hash": mhash[g["gta"]], "from": oid(g["from"]), "to": oid(g["to"]), "head": g["head"],
         "purpose": PURPOSE["export" if g["to"] == "P:BARCARENA" else g["purpose"]], "date_unix": unix(g["day"])} for g in sorted(sub_g, key=lambda g: g["day"])]
    seed = {
        "version": 1,
        "ranches": [ent(i) for i in R],
        "sinks": [{"id": s, "onchain_id": oid(s), "kind": 2 if s.startswith("P:") else 1} for s in sinks],
        "events": seed_events,
        "risk_attestations": attest,
        "certificates": [cert(s) for s in shipments],
        "demo": demo,
        "subset": {"ranches": sub_r, "sinks": [{"id": s, "onchain_id": oid(s), "kind": 2 if s.startswith("P:") else 1} for s in sub_sinks],
                   "events": sub_events, "risk_attestations": [a for a in attest if a["ranch"] in {oid(i) for i in sub_ids}],
                   "certificates": [cert(s) for s in demo_ships]},
        "id_map": {oid(i): i for i in list(R) + list(sinks)},
    }
    (OUT / "chain_seed.json").write_text(json.dumps(seed), encoding="utf-8")
    print("headline:", json.dumps(metrics["headline"]))
    print("demo:", json.dumps(demo["labels"]), "| subset ranches", len(sub_r), "events", len(sub_events))
    print("risk classes:", {c: sum(1 for i in real_ids if risk[i]["class"] == c) for c in ("high", "watch", "clean")})


if __name__ == "__main__":
    main()
