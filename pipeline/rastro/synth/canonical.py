"""Turn a simulated World into canonical v1 tables (rastro/schemas/canonical.py)."""
import hashlib
import json
from collections import defaultdict
from datetime import date, timedelta

import numpy as np

from rastro import __version__
from rastro.config import MAX_CALVING_RATE, MUNICIPALITY, RAW
from rastro.ledger import birth_cap, replay
from rastro.synth.world import World

BREEDING_COW_UNCERTAINTY = 0.15   # +/- share around the declared count (census error, culls, heifers)
PROVENANCE = f"synthetic: rastro.synth {__version__}"


def sha256_json(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def build(world: World) -> dict[str, list[dict]]:
    cfg, R = world.config, world.ranches
    iso = world.iso
    start = cfg.start
    rng_meta = np.random.default_rng([cfg.seed, 2])   # display names, owner groups, issue dates
    tables: dict[str, list[dict]] = {}
    ids = [i for i in R if i.startswith("R")]
    ext = [i for i in R if i.startswith("X")]

    # ---- ranches --------------------------------------------------------------------------
    geom_kind = "synthetic_voronoi_on_real_layers" if world.landscape.kind == "real" else "synthetic_grid"
    attr_kind = "measured_on_real_layers" if world.landscape.kind == "real" else "synthetic"
    groups, g = {}, 0
    for i in ids:
        if i in groups:
            continue
        g += 1
        groups[i] = f"OG-{g:04d}"
        if rng_meta.random() < 0.12:  # a few owners hold two or three neighbouring ranches
            for j in rng_meta.choice(ids, int(rng_meta.integers(1, 3)), replace=False):
                groups.setdefault(str(j), f"OG-{g:04d}")
    ranches = []
    for i in ids + ext:
        r = R[i]
        inside = i.startswith("R")
        ranches.append({
            "ranch_id": i, "entity_type": "ranch" if inside else "external_supplier",
            "display_name": f"{'Ranch' if inside else 'External supplier'} {hashlib.sha256(f'{cfg.seed}|{i}'.encode()).hexdigest()[:6].upper()}",
            "municipality": f"{MUNICIPALITY['name']} ({MUNICIPALITY['state']})" if inside else "outside study window",
            "municipality_ibge": MUNICIPALITY["ibge_code"] if inside else None,
            "geometry_ref": f"inputs/ranch_boundaries.geojson#{i}" if inside else None,
            "total_area_hectares": round(float(r.area_ha), 2) if inside else None,
            "pasture_area_hectares": round(float(r.pasture_ha), 2) if inside else None,
            "estimated_cattle_capacity": int(r.pasture_ha * cfg.capacity) if inside else None,
            "breeding_cows_declared": int(world.declared_cows.get(i, getattr(r, "breeding_cows", 0))),
            "opening_head": int(r.initial_head),
            "role": str(r.role),
            "owner_group_id": groups.get(i, f"OG-X{i[1:]}"),
            "registered_on": start.isoformat(),
            "data_source": "synthetic",
            "data_quality": {"geometry": geom_kind if inside else "none", "attributes": attr_kind if inside else "unknown",
                             "notes": None if inside else "supplier outside the study window; status unknown"},
        })
    tables["ranches"] = ranches
    tables["destinations"] = [{
        "destination_id": d["id"], "destination_type": "export_port" if d["kind"] == "port" else "slaughterhouse",
        "name": d["name"], "inspection": d.get("inspection"), "lat": d["lat"], "lon": d["lon"],
        "data_source": "real" if d.get("real") else "synthetic",
        "licence": "CC BY 4.0 (Trase)" if d.get("real") and d["kind"] != "port" else None,
    } for d in world.landscape.destinations]

    # ---- births & deaths ------------------------------------------------------------------
    seq, births, birth_labels, cum = defaultdict(int), [], {}, defaultdict(int)
    for b in world.births:
        i = b["ranch"]
        seq[i] += 1
        bid = f"B-{i}-{seq[i]:05d}"
        cows = int(world.declared_cows.get(i, R[i].breeding_cows))
        lo, hi = int(cows * (1 - BREEDING_COW_UNCERTAINTY)), int(round(cows * (1 + BREEDING_COW_UNCERTAINTY)))
        cum[(i, b["year"])] += b["head"]
        total = cum[(i, b["year"])]
        status = ("within_biology" if total <= birth_cap(cows)
                  else "borderline" if total <= int(hi * MAX_CALVING_RATE) else "exceeds_biology")
        births.append({"birth_event_id": bid, "ranch_id": i, "date": iso(b["day"]), "year": b["year"],
                       "declared_head": b["head"], "breeding_cow_estimate": {"point": cows, "low": lo, "high": hi},
                       "max_calving_rate": MAX_CALVING_RATE, "maximum_plausible_births": birth_cap(cows),
                       "maximum_plausible_births_high": int(hi * MAX_CALVING_RATE), "cumulative_year_head": total,
                       "validation_status": status, "source": "synthetic_declaration"})
        birth_labels[id(b)] = bid
    tables["birth_declarations"] = births
    dseq, deaths = defaultdict(int), []
    for d in world.deaths:
        dseq[d["ranch"]] += 1
        deaths.append({"death_event_id": f"D-{d['ranch']}-{dseq[d['ranch']]:05d}", "ranch_id": d["ranch"],
                       "date": iso(d["day"]), "declared_head": d["head"], "source": "synthetic_declaration"})
    tables["death_declarations"] = deaths

    # ---- GTAs -----------------------------------------------------------------------------
    dest_type = {d["destination_id"]: d["destination_type"] for d in tables["destinations"]}
    gtas = []
    for x in world.gtas:
        lead = int(rng_meta.integers(0, 4))  # permits are issued 0-3 days before the animals move
        gtas.append({
            "gta_id": x["gta"], "lot_id": f"LOT-{x['gta']}", "origin_id": x["from"],
            "origin_type": "external_supplier" if x["from"].startswith("X") else "ranch",
            "destination_id": x["to"], "destination_type": dest_type.get(x["to"], "ranch"),
            "issue_date": iso(x["day"] - lead), "movement_date": iso(x["day"]), "head_count": x["head"],
            "purpose": x["purpose"], "source_lot_ids": None,
            "permit_status": "attempted_while_embargoed" if x.get("attempt_embargoed") else "issued",
            "provenance": f"{PROVENANCE} seed={cfg.seed}",
        })
    # Red team: some ranch-to-ranch permits never reach the agency's records. They stay in truth.
    missing = []
    if cfg.drop_gta_share > 0:
        rng_drop = np.random.default_rng([cfg.seed, 7])
        pool = [g for g in gtas if g["destination_type"] == "ranch" and g["permit_status"] == "issued"]
        k = int(round(cfg.drop_gta_share * len(pool)))
        drop = {pool[int(j)]["gta_id"] for j in rng_drop.choice(len(pool), k, replace=False)} if k else set()
        missing = [{"gta_id": g["gta_id"], "origin_id": g["origin_id"], "destination_id": g["destination_id"],
                    "movement_date": g["movement_date"], "head_count": g["head_count"], "scenario": "records_missing"}
                   for g in gtas if g["gta_id"] in drop]
        gtas = [g for g in gtas if g["gta_id"] not in drop]
    tables["gta_movements"] = gtas
    tables["missing_records"] = missing

    # ---- shipments: deliveries per slaughter GTA, voyages per month at the port -----------
    shipments, voyages = [], defaultdict(list)
    for x in gtas:
        if x["permit_status"] != "issued" or x["destination_type"] == "ranch":
            continue
        if x["destination_type"] == "export_port":
            voyages[(x["destination_id"], x["movement_date"][:7])].append(x)
        else:
            shipments.append(_shipment(f"SHP-D-{len(shipments) + 1:06d}", "delivery", [x]))
    for (port, ym), xs in sorted(voyages.items()):
        shipments.append(_shipment(f"SHP-V-{ym.replace('-', '')}", "voyage", xs))
    tables["shipments"] = shipments

    # ---- environment ----------------------------------------------------------------------
    emb = []
    for i in ids:
        if R[i].embargo_day is not None:
            emb.append({"embargo_id": f"EMB-{len(emb) + 1:04d}", "ranch_id": i, "start_date": iso(R[i].embargo_day),
                        "end_date": None, "status": "active",
                        "reason": "simulated: large post-2020 clearing on the real PRODES layer",
                        "source": "simulated embargo (not an Ibama record)", "data_status": "synthetic",
                        "ingested_at": cfg.generated_at})
    tables["embargoes"] = emb
    tables.update(environment_layers(world))

    # ---- derived: ledger replay -----------------------------------------------------------
    inventory, refusals = replay(ranches, births, deaths, gtas, emb, start)
    tables["herd_inventory"] = inventory
    tables["ledger_refusals"] = refusals

    # ---- truth ----------------------------------------------------------------------------
    tables.update(truth_tables(world, tables, birth_labels))
    return tables


def _shipment(sid, kind, xs):
    return {"shipment_id": sid, "kind": kind, "destination_id": xs[0]["destination_id"],
            "shipment_date": max(x["movement_date"] for x in xs), "gta_ids": [x["gta_id"] for x in xs],
            "lot_allocations": [{"lot_id": x["lot_id"], "head": x["head_count"]} for x in xs],
            "declared_head_count": sum(x["head_count"] for x in xs), "lineage_coverage": None,
            "certification_status": "not_assessed"}


def environment_layers(world: World) -> dict[str, list[dict]]:
    cfg = world.config
    out = {"prodes_deforestation": [], "indigenous_territories": [], "conservation_units": []}
    if world.landscape.kind == "real":
        specs = [("yearly_deforestation", "prodes_deforestation", "prodes_deforestation", "INPE PRODES yearly deforestation (TerraBrasilis)", "CC BY-SA 4.0"),
                 ("accumulated_2007", "prodes_deforestation", "prodes_deforestation", "INPE PRODES accumulated deforestation to 2007 (TerraBrasilis)", "CC BY-SA 4.0"),
                 ("indigenous", "indigenous_territories", "indigenous_territory", "FUNAI Indigenous lands (TerraBrasilis)", "public data, FUNAI"),
                 ("conservation", "conservation_units", "conservation_unit", "Conservation units (TerraBrasilis / ICMBio, state)", "public data")]
        for fname, table, dataset, source, licence in specs:
            path = RAW / f"{fname}.geojson"
            if not path.is_file():
                continue
            file_sha = hashlib.sha256(path.read_bytes()).hexdigest()
            fc = json.loads(path.read_text(encoding="utf-8"))
            for n, f in enumerate(fc["features"]):
                p = f["properties"]
                src_id = str(p.get("uuid") or p.get("fid") or p.get("id") or n)
                out[table].append(_env_record(dataset, f"{fname}@{file_sha[:12]}", source, src_id, p, f["geometry"],
                                              f"pipeline/data/raw/{fname}.geojson#{src_id}", "real", licence, cfg.generated_at))
    else:
        for fname, fc in synthetic_layer_features(world).items():
            table, dataset = {"synthetic_deforestation": ("prodes_deforestation", "prodes_deforestation"),
                              "synthetic_indigenous": ("indigenous_territories", "indigenous_territory"),
                              "synthetic_protected": ("conservation_units", "conservation_unit")}[fname]
            for f in fc["features"]:
                p = f["properties"]
                out[table].append(_env_record(dataset, "synthetic-v1", "rastro.synth synthetic layer (not real data)",
                                              p["record_id"].split(":", 1)[1], p, f["geometry"],
                                              f"environment/{fname}.geojson#{p['record_id']}", "synthetic", None, cfg.generated_at))
    return out


def synthetic_layer_features(world: World) -> dict[str, dict]:
    """Synthetic environmental layers for a synthetic landscape (fixtures). Nothing here is real.

    Each ranch with post-2020 clearing gets a rectangle of that area dated 2021-2025, every ranch a
    pre-cut-off clearing (2008-2019), a few undated clearings, Indigenous strips where the cell
    overlaps a synthetic territory, and one sustainable-use area over the first grid row.
    """
    from rastro.synth.landscape import CELL_M, rect

    rng = np.random.default_rng([world.config.seed, 5])
    defo, ti = [], []
    for row in world.landscape.rows:
        x0, y0, side = row["x0"], row["y0"], row["side_m"]

        def strip(ha, y_from):
            h = min(side * 0.95, ha * 1e4 / side)
            return rect(x0, y0 + y_from, side, h), y_from + h

        y = 0.0
        if row["defor_post2020_ha"] > 0:
            g, y = strip(row["defor_post2020_ha"], y)
            defo.append((f"SYN-{row['id']}-post", {"year": int(rng.integers(2022, 2026)), "julian_day": int(rng.integers(180, 260))}, g))
        pre = row["pasture_ha"] * 0.3
        if pre > 1 and y + pre * 1e4 / side < side:
            g, y = strip(pre, y)
            defo.append((f"SYN-{row['id']}-pre", {"year": int(rng.integers(2008, 2020)), "julian_day": int(rng.integers(180, 260))}, g))
        if rng.random() < 0.1 and y + 2e4 / side < side:
            g, y = strip(2.0, y)
            defo.append((f"SYN-{row['id']}-undated", {"year": None}, g))
        if row["ti_overlap_ha"] > 0:
            h = min(side * 0.5, row["ti_overlap_ha"] * 1e4 / side)
            ti.append((f"SYN-TI-{row['id']}", {"name": "Synthetic TI", "fase_ti": "Regularizada (synthetic)"},
                       rect(x0, y0 + side - h, side, h + CELL_M * 0.02)))
    cols = max(1, int(np.ceil(np.sqrt(len(world.landscape.rows)))))
    apa = [("SYN-APA-1", {"name": "Synthetic APA", "categoria": "Área de Proteção Ambiental", "grupo": "US"},
            rect(0, 0, cols * CELL_M, CELL_M * 0.5))]

    def fc(items, dataset):
        return {"type": "FeatureCollection", "crs_note": "WGS84 (RFC 7946)", "features": [
            {"type": "Feature", "properties": {"record_id": f"{dataset}:{rid}", "data_status": "synthetic", **props}, "geometry": g}
            for rid, props, g in items]}

    return {"synthetic_deforestation": fc(defo, "prodes_deforestation"),
            "synthetic_indigenous": fc(ti, "indigenous_territory"),
            "synthetic_protected": fc(apa, "conservation_unit")}


def _env_record(dataset, version, source, src_id, props, geom, ref, status, licence, ingested_at):
    year = props.get("year")
    start = end = rel = None
    if dataset == "prodes_deforestation" and year is not None:
        year = int(year)
        if year <= 2007:   # accumulated mask: cleared at some unknown date up to the 2007 PRODES year
            end = date(2007, 7, 31)
        else:              # PRODES year Y covers 1 Aug Y-1 to 31 Jul Y
            start, end = date(year - 1, 8, 1), date(year, 7, 31)
            jd = int(props.get("julian_day") or 0)
            rel = date(year, 1, 1) + timedelta(days=jd - 1) if jd > 0 else None
    attrs = {k: v for k, v in props.items() if k in ("year", "area_km", "area_ha", "class_name", "main_class", "satellite",
                                                     "terrai_nom", "terrai_cod", "fase_ti", "nome", "categoria",
                                                     "grupo", "esfera", "ano_cria", "name", "overlap_ha", "julian_day")}
    return {"record_id": f"{dataset}:{src_id}", "dataset": dataset, "dataset_version": version, "source": source,
            "source_record_id": src_id,
            "observation_period_start": start.isoformat() if start else None,
            "observation_period_end": end.isoformat() if end else None,
            "relevant_date": rel.isoformat() if rel else None, "geometry_ref": ref,
            "geometry_sha256": sha256_json(geom), "attributes": attrs, "data_status": status, "licence": licence,
            "ingested_at": ingested_at}


def truth_tables(world: World, t: dict, birth_labels: dict) -> dict[str, list[dict]]:
    cfg, R, iso = world.config, world.ranches, world.iso
    phantom_ids = [i for i in R if R[i].truth == "phantom_births"]
    emb = {e["ranch_id"]: e["start_date"] for e in t["embargoes"]}

    # Ranch labels and the borderline cases an evaluator should look at.
    throughput = defaultdict(int)
    for g in t["gta_movements"]:
        throughput[g["origin_id"]] += g["head_count"]
    honest_vol = sorted((i for i in R if i.startswith("R") and R[i].truth == "honest"), key=lambda i: -throughput[i])
    high_volume = set(honest_vol[: max(1, len(honest_vol) // 20)])
    scen = {"launderer": "laundering", "phantom_births": "phantom_births", "over_capacity": "over_capacity"}
    labels = []
    for i in sorted(R):
        r = R[i]
        reasons = []
        if i.startswith("R"):
            if r.defor_post2020_ha >= 50:
                reasons.append(f"post-2020 clearing {r.defor_post2020_ha:.1f} ha >= 50 ha")
            if r.ti_overlap_ha >= 1:
                reasons.append(f"Indigenous-land overlap {r.ti_overlap_ha:.1f} ha")
        tags = []
        if r.truth == "honest" and r.role == "intermediary":
            tags.append("honest_fast_trader")
        if i in high_volume:
            tags.append("high_volume_honest")
        if i.startswith("R") and 0 < r.defor_post2020_ha < 50:
            tags.append("small_post2020_clearing")
        if i in emb:
            tags.append("embargoed")
        labels.append({"ranch_id": i, "label": r.truth, "scenario": scen.get(r.truth), "reasons": reasons,
                       "case_tags": tags, "embargoed_from": emb.get(i)})

    # Physical lineage.
    remaining = {}
    for i, r in R.items():
        for l in r.lots:
            remaining[l[4]] = remaining.get(l[4], 0) + int(l[0])
    lots = []
    for lid in sorted(world.lots):
        l = world.lots[lid]
        if l["head"] <= 0:
            continue
        lots.append({"lot_id": lid, "kind": l["kind"], "location_id": l["ranch_id"], "created_date": iso(l["created_day"]),
                     "head": l["head"], "birth_origin_id": l["birth_origin_id"], "parent_lot_id": l["parent_lot_id"],
                     "via_gta_id": l["via_gta"], "remaining_head": remaining.get(lid, 0)})
    allocs = []
    for a in world.allocations:
        if a["head"] <= 0:  # the simulator's FIFO can emit empty fragments; they carry no animals
            continue
        allocs.append({"channel": "gta" if a["gta_id"] else "smuggled", "gta_id": a["gta_id"],
                       "from_lot_id": a["from_lot_id"], "to_lot_id": a["to_lot_id"], "head": a["head"], "date": iso(a["day"])})
    for d in world.deaths:
        for head, lid in d["lots"]:
            allocs.append({"channel": "death", "gta_id": None, "from_lot_id": lid, "to_lot_id": None, "head": head, "date": iso(d["day"])})
    allocs.sort(key=lambda a: (a["date"], a["from_lot_id"], a["to_lot_id"] or ""))
    for n, a in enumerate(allocs):
        a["allocation_id"] = f"AL-{n + 1:06d}"

    # Movement labels: true origin mix per GTA, and the scenario each GTA belongs to.
    mix = defaultdict(lambda: defaultdict(int))
    for a in world.allocations:
        if a["gta_id"]:
            mix[a["gta_id"]][world.lots[a["to_lot_id"]]["birth_origin_id"]] += a["head"]
    launderers = {i for i in R if R[i].truth in ("launderer", "phantom_births")}
    cold = {g["gta"] for g in world.gtas if g.get("cold_permit")}
    movement_labels = []
    for g in t["gta_movements"]:
        tags = []
        if g["permit_status"] == "attempted_while_embargoed":
            tags.append("embargo_attempts")
        if g["origin_id"] in launderers or g["destination_id"] in launderers:
            tags.append("laundering_hop")
        if any(R[o].dirty for o in mix[g["gta_id"]] if o in R):
            tags.append("carries_dirty_origin")
        if g["gta_id"] in cold:
            tags.append("cold_permit")
        movement_labels.append({"gta_id": g["gta_id"], "scenario_tags": tags, "true_origin_mix": dict(sorted(mix[g["gta_id"]].items()))})

    # Smuggled transfers (no GTA), laundered as phantom birth declarations and, when the red team
    # conceals them, partly as permits in the name of an outside supplier ("cold" permits).
    phantom_births = [birth_labels[id(b)] for b in world.births if b.get("phantom")]
    queue = iter(phantom_births)
    smuggled = []
    for n, s in enumerate(world.smuggled):
        has_birth = s.get("as_birth", s["head"]) > 0
        smuggled.append({"transfer_id": f"SMG-{n + 1:05d}", "from_id": s["from"], "to_id": s["to"], "head": s["head"],
                         "date": iso(s["day"]), "scenario": "phantom_births",
                         "laundered_as_birth_event_id": next(queue) if has_birth else None,
                         "laundered_as_gta_id": s.get("cold_gta")})

    # Shipment truth: share of head born on dirty sources.
    shipment_truth = []
    for s in t["shipments"]:
        origins = defaultdict(int)
        for gid in s["gta_ids"]:
            for o, h in mix[gid].items():
                origins[o] += h
        head = sum(origins.values())
        tainted = sum(h for o, h in origins.items() if o in R and R[o].dirty)
        shipment_truth.append({"shipment_id": s["shipment_id"], "head": head or s["declared_head_count"], "tainted_head": tainted,
                               "tainted_pct": round(100 * tainted / head, 2) if head else 0.0, "origins": dict(sorted(origins.items()))})

    # Every ledger refusal must be explained by a deliberate scenario; unexplained ones stay
    # unattributed and fail validation.
    explained_births = set(phantom_births)
    attempts = {g["gta_id"] for g in t["gta_movements"] if g["permit_status"] == "attempted_while_embargoed"}
    # Ranches whose declared balance differs from their physical herd, and the scenario that made it so.
    tainted_balances = {i: "phantom_births" for i in phantom_ids}
    for m in t.get("missing_records", []):
        tainted_balances.setdefault(m["destination_id"], "records_missing")  # received head the records never show
    by_gta = {x["gta_id"]: x for x in t["gta_movements"]}
    for rf in sorted(t["ledger_refusals"], key=lambda r: r["date"]):
        if rf["reason"] == "InsufficientHerd" and rf["ranch_id"] in tainted_balances:
            g = by_gta.get(rf["event_ref"])
            if g and g["destination_type"] == "ranch":  # its buyer now holds undeclared head too
                tainted_balances.setdefault(g["destination_id"], tainted_balances[rf["ranch_id"]])
    anomalies = []
    for rf in t["ledger_refusals"]:
        if rf["reason"] == "BirthsExceedBiology":
            scenario = "phantom_births" if rf["event_ref"] in explained_births else "UNEXPLAINED"
        elif rf["reason"] == "OriginEmbargoed":
            scenario = "embargo_attempts" if rf["event_ref"] in attempts else "UNEXPLAINED"
        else:
            scenario = tainted_balances.get(rf["ranch_id"], "UNEXPLAINED")
        anomalies.append({"anomaly_id": f"ANM-{len(anomalies) + 1:05d}", "kind": rf["reason"], "event_ref": rf["event_ref"],
                          "ranch_id": rf["ranch_id"], "head": rf["head"], "scenario": scenario})

    return {"ranch_labels": labels, "movement_labels": movement_labels, "smuggled_transfers": smuggled,
            "missing_records": t.get("missing_records", []),
            "lots": lots, "lot_allocations": allocs, "shipment_truth": shipment_truth, "anomalies": anomalies}


def boundaries(world: World) -> dict:
    feats = [{"type": "Feature", "id": rid, "properties": {"ranch_id": rid, "data_status": "synthetic"}, "geometry": _round(g)}
             for rid, g in sorted(world.landscape.geometries.items())]
    return {"type": "FeatureCollection", "features": feats}


def _round(geom):
    def r(c):
        return [round(c[0], 6), round(c[1], 6)] if isinstance(c[0], (int, float)) else [r(x) for x in c]
    return {"type": geom["type"], "coordinates": r(geom["coordinates"])}
