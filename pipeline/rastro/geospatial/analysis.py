"""Spatial analysis: ranches against deforestation, protected areas, embargoes and facilities.

Two outputs are kept apart on purpose:
- `legal`: indicators tied to rules (EUDR cut-off, recognised Indigenous land, strict protection,
  embargo). They are screening indicators, never a legal determination.
- `scientific_risk`: an environmental risk class from areas and proximity.
Proximity is reported but never treated as a violation.
"""
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta

import geopandas as gpd
import shapely

from rastro.geospatial.layers import Layer

CLASSES = ("pre_cutoff", "straddles_cutoff", "post_cutoff", "unknown_date")


@dataclass(frozen=True)
class GeoConfig:
    cutoff: date = date(2020, 12, 31)        # EUDR deforestation cut-off
    as_of: date = date(2025, 12, 31)         # embargo status is evaluated on this date
    min_area_ha: float = 0.5                 # below this an intersection is treated as a boundary sliver
    watch_ha: float = 6.25                   # PRODES minimum mapping unit
    high_ha: float = 50.0
    proximity_km: float = 2.0
    straddling_is_risk: bool = True          # precaution: count PRODES years that straddle the cut-off as risk


# ---- dates ---------------------------------------------------------------------------------
def clearing_period(attrs: dict) -> tuple[date | None, date | None, date | None]:
    """(period start, period end, detection image date) for a deforestation feature.

    PRODES year Y maps clearing between 1 Aug Y-1 and 31 Jul Y; the accumulated mask (year <= 2007)
    only says "by 31 Jul 2007". A feature with an explicit `date` uses it as both ends.
    """
    if attrs.get("date"):
        d = date.fromisoformat(str(attrs["date"])[:10])
        return d, d, d
    year = attrs.get("year")
    try:
        year = int(year)
    except (TypeError, ValueError):
        return None, None, None
    if year <= 2007:
        return None, date(2007, 7, 31), None
    image = None
    if attrs.get("image_date"):
        try:
            image = date.fromisoformat(str(attrs["image_date"])[:10])
        except ValueError:
            image = None
    if image is None:
        try:
            jd = int(attrs.get("julian_day"))
        except (TypeError, ValueError):
            jd = 0
        image = date(year, 1, 1) + timedelta(days=jd - 1) if jd > 0 else None
    return date(year - 1, 8, 1), date(year, 7, 31), image


def cutoff_class(start: date | None, end: date | None, image: date | None, cutoff: date) -> str:
    if end is None:
        return "unknown_date"
    if end <= cutoff or (image is not None and image <= cutoff):
        return "pre_cutoff"          # cleared by the end of the period (or seen cleared on an image) before the cut-off
    if start is None:
        return "unknown_date"        # only an upper bound after the cut-off
    if start > cutoff:
        return "post_cutoff"
    return "straddles_cutoff"


def classify_deforestation(layer: Layer, cutoff: date) -> gpd.GeoDataFrame:
    g = layer.gdf.copy()
    rows = [clearing_period(r) for r in g.drop(columns="geometry").to_dict("records")]
    g["period_start"] = [r[0] for r in rows]
    g["period_end"] = [r[1] for r in rows]
    g["cutoff_class"] = [cutoff_class(*r, cutoff) for r in rows]
    g["undated"] = [r[0] is None for r in rows]
    return g


# ---- geometry helpers ----------------------------------------------------------------------
def usable(g: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Rows with a non-missing, non-empty geometry."""
    m = g.geometry.isna()
    m[~m] = g.geometry[~m].is_empty
    return g[~m]


def pair_intersections(ranches: gpd.GeoDataFrame, polys: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """All (ranch, feature) pairs that intersect, with the intersection geometry (metric CRS)."""
    r = usable(ranches)[["fid", "geometry"]]
    if r.empty or polys.empty:
        return gpd.GeoDataFrame({"ranch": [], "feature": [], "geometry": []}, geometry="geometry", crs=ranches.crs)
    j = gpd.sjoin(r, polys[["fid", "geometry"]].rename(columns={"fid": "feature"}), predicate="intersects")
    left = r.geometry.loc[j.index].values
    right = polys.set_index("fid").geometry.loc[j["feature"]].values
    inter = shapely.intersection(left, right)
    out = gpd.GeoDataFrame({"ranch": j["fid"].values, "feature": j["feature"].values}, geometry=inter, crs=ranches.crs)
    return out[~out.geometry.is_empty & (out.geometry.area > 0)]


def union_area_ha(geoms) -> float:
    return float(shapely.union_all(list(geoms)).area / 1e4) if len(geoms) else 0.0


def coverage_of(ranch_geom, layer: Layer | None) -> str:
    """full / partial / none / undeclared: whether the layer is known to be complete over the ranch.

    A layer's feature extent says where features were found, not where the source looked, so it
    is never used as coverage. Without a declared coverage the result is `undeclared`.
    """
    if layer is None or ranch_geom is None or ranch_geom.is_empty:
        return "none"
    cov = layer.coverage
    if cov is None:
        return "undeclared"
    if cov.contains(ranch_geom):
        return "full"
    return "partial" if cov.intersects(ranch_geom) else "none"


# ---- legal context of protected areas ------------------------------------------------------
RECOGNISED_TI_PHASES = ("regularizada", "homologada", "declarada")


def clean_name(raw) -> str:
    """TerraBrasilis serves some names with broken accents; map the ones in this window by keyword."""
    up = str(raw or "").upper()
    if "TRIUNFO DO XINGU" in up:
        return "APA Triunfo do Xingu"
    if up.startswith("KAYAP"):
        return "Kayapó"
    if up.startswith("APYTEREWA"):
        return "Apyterewa"
    return str(raw) if raw else "unnamed"


def indigenous_context(attrs: dict) -> tuple[str, str, bool]:
    phase = str(attrs.get("fase_ti") or attrs.get("phase") or "")
    recognised = any(p in phase.lower() for p in RECOGNISED_TI_PHASES)
    note = ("recognised Indigenous land: non-Indigenous cattle ranching is not permitted"
            if recognised else "Indigenous land in demarcation or of unknown phase: legal effect depends on the phase")
    return clean_name(attrs.get("terrai_nom") or attrs.get("name")), note, recognised


def protected_context(attrs: dict) -> tuple[str, str, str, bool]:
    group = str(attrs.get("grupo") or attrs.get("group") or "").upper()
    category = str(attrs.get("categoria") or attrs.get("category") or "")
    name = clean_name(attrs.get("nome") or attrs.get("name"))
    if group == "PI":
        return name, category, "strict-protection unit: cattle ranching is not permitted", True
    if group == "US" or "APA" in name.upper() or "ambiental" in category.lower():
        return name, category, "sustainable-use unit (e.g. APA): ranching can be lawful under its management rules; overlap is context, not a violation", False
    return name, category, "protected-area category unknown: check the applicable rules", False


# ---- embargoes -----------------------------------------------------------------------------
def embargo_status(records: list[dict], as_of: date) -> dict:
    """Active, historical and unverified embargoes are reported separately, never merged."""
    if not records:
        return {"status": "none", "embargo_ids": [], "sources": [], "simulated": False, "since": None}
    active, historical, unverified, future = [], [], [], []
    for e in records:
        start = date.fromisoformat(e["start_date"])
        end = date.fromisoformat(e["end_date"]) if e.get("end_date") else None
        if e.get("status") == "unverified":
            unverified.append(e)
        elif start > as_of:
            future.append(e)
        elif e.get("status") == "lifted" or (end is not None and end < as_of):
            historical.append(e)
        else:
            active.append(e)
    status = "active" if active else "unverified" if unverified else "historical" if historical else "none"
    chosen = active or unverified or historical
    return {"status": status, "embargo_ids": sorted(e["embargo_id"] for e in chosen),
            "sources": sorted({e["source"] for e in chosen}),
            "simulated": any(e.get("data_status") != "real" for e in chosen),
            "since": min((e["start_date"] for e in chosen), default=None)}


# ---- the per-ranch assessment ----------------------------------------------------------------
def assess(ranches: Layer, defor: Layer | None, indigenous: Layer | None, protected: Layer | None,
           facilities: Layer | None, embargoes: list[dict], cfg: GeoConfig) -> list[dict]:
    R = ranches.gdf
    area = {f: (g.area / 1e4 if g is not None and not g.is_empty else None) for f, g in zip(R["fid"], R.geometry)}
    geom_of = dict(zip(R["fid"], R.geometry))
    status_of = dict(zip(R["fid"], R["geometry_status"]))
    log_by = defaultdict(list)
    for e in ranches.log:
        log_by[e["feature"]].append(e["message"])

    # deforestation
    by_class = defaultdict(lambda: defaultdict(list))   # ranch -> class -> [intersection geoms]
    ids_by = defaultdict(lambda: defaultdict(set))
    undated_ha = defaultdict(list)
    near_km, near_n = {}, defaultdict(int)
    if defor is not None:
        D = classify_deforestation(defor, cfg.cutoff)
        klass = dict(zip(D["fid"], D["cutoff_class"]))
        undated = dict(zip(D["fid"], D["undated"]))
        for ranch, feat, geom in pair_intersections(R, D).itertuples(index=False):
            by_class[ranch][klass[feat]].append(geom)
            ids_by[ranch][klass[feat]].add(feat)
            if undated[feat] and klass[feat] == "pre_cutoff":
                undated_ha[ranch].append(geom)
        risky = ("post_cutoff", "straddles_cutoff") if cfg.straddling_is_risk else ("post_cutoff",)
        P = D[D["cutoff_class"].isin(risky)][["fid", "geometry"]]
        live = usable(R)[["fid", "geometry"]]
        if len(P) and len(live):
            nn = gpd.sjoin_nearest(live, P.rename(columns={"fid": "feature"}), distance_col="d")
            near_km = nn.groupby("fid")["d"].min().div(1000).round(3).to_dict()
            buf = live.assign(geometry=live.buffer(cfg.proximity_km * 1000))
            hits = gpd.sjoin(buf, P.rename(columns={"fid": "feature"}), predicate="intersects")
            touching = {(r, f) for r in by_class for c in risky for f in ids_by[r][c]}
            for r, f in zip(hits["fid"], hits["feature"]):
                if (r, f) not in touching:
                    near_n[r] += 1

    # protected areas
    ti_hits, uc_hits = defaultdict(list), defaultdict(list)
    for layer, sink in ((indigenous, ti_hits), (protected, uc_hits)):
        if layer is None:
            continue
        attrs = layer.gdf.set_index("fid").drop(columns="geometry").to_dict("index")
        for ranch, feat, geom in pair_intersections(R, layer.gdf).itertuples(index=False):
            sink[ranch].append((feat, attrs[feat], geom))

    # facilities
    fac_km = {}
    if facilities is not None and len(facilities.gdf):
        F = facilities.gdf
        if "destination_type" in F.columns:
            F = F[F["destination_type"] == "slaughterhouse"]
        live = usable(R)[["fid", "geometry"]]
        if len(F) and len(live):
            nn = gpd.sjoin_nearest(live, F[["fid", "geometry"]].rename(columns={"fid": "feature"}), distance_col="d")
            fac_km = nn.groupby("fid")["d"].min().div(1000).round(2).to_dict()

    emb_by = defaultdict(list)
    for e in embargoes:
        emb_by[e["ranch_id"]].append(e)

    out = []
    for fid in sorted(R["fid"]):
        geom, a = geom_of[fid], area[fid]
        warnings = list(log_by[fid])
        has_geom = a is not None and a > 0
        if not has_geom:
            warnings.append("no usable ranch geometry: spatial measures are null")
        if ranches.spec.data_status != "real":
            warnings.append("ranch boundary is synthetic: areas describe a simulated cell, not a real property")

        # deforestation block
        cov = coverage_of(geom, defor) if has_geom else "none"
        if defor is None:
            warnings.append("no deforestation layer supplied: deforestation measures are null")
        elif cov == "none" and has_geom:
            warnings.append("ranch lies outside the deforestation layer's coverage: measures are null")
        elif cov == "partial":
            warnings.append("deforestation layer covers the ranch only partly: areas are lower bounds")
        elif cov == "undeclared":
            warnings.append("deforestation layer declares no coverage: zero means no mapped clearing, not verified absence")
        measured = has_geom and defor is not None and cov != "none"
        ha = {c: (round(union_area_ha(by_class[fid][c]), 2) if measured else None) for c in CLASSES}
        if measured and ha["straddles_cutoff"]:
            warnings.append(f"{ha['straddles_cutoff']} ha cleared in a PRODES year that straddles the cut-off "
                            f"({cfg.cutoff.isoformat()}); annual data cannot place it before or after")
        if measured and ha["unknown_date"]:
            warnings.append(f"{ha['unknown_date']} ha of clearing has no usable date")
        defo = {
            "coverage": cov,
            "post_cutoff_ha": ha["post_cutoff"], "straddles_cutoff_ha": ha["straddles_cutoff"],
            "pre_cutoff_ha": ha["pre_cutoff"], "unknown_date_ha": ha["unknown_date"],
            "pre_cutoff_undated_ha": round(union_area_ha(undated_ha[fid]), 2) if measured else None,
            "intersecting_polygon_ids": {c: sorted(ids_by[fid][c]) for c in CLASSES} if measured else None,
            "nearest_post_cutoff_km": near_km.get(fid) if measured else None,
            "post_cutoff_nearby_not_intersecting": near_n.get(fid, 0) if measured else None,
            "proximity_km": cfg.proximity_km,
        }

        # protected areas
        def overlap(layer, hits, context):
            if layer is None or not has_geom:
                return None
            areas, total = [], []
            for feat, attrs, g in sorted(hits[fid], key=lambda h: h[0]):
                ov = g.area / 1e4
                if ov < 0.01:
                    continue
                areas.append({"feature_id": feat, **context(attrs), "overlap_ha": round(ov, 2), "overlap_share": round(ov / a, 4)})
                total.append(g)
            t = union_area_ha(total)
            return {"overlap_ha": round(t, 2), "overlap_share": round(t / a, 4), "areas": areas}

        def ti_ctx(attrs):
            name, note, recognised = indigenous_context(attrs)
            return {"name": name, "phase": attrs.get("fase_ti") or attrs.get("phase"), "legal_context": note, "recognised": recognised}

        def uc_ctx(attrs):
            name, category, note, strict = protected_context(attrs)
            return {"name": name, "category": category or None, "legal_context": note, "strict_protection": strict}

        ti = overlap(indigenous, ti_hits, ti_ctx)
        uc = overlap(protected, uc_hits, uc_ctx)
        if indigenous is None:
            warnings.append("no Indigenous-land layer supplied: overlap is null")
        if protected is None:
            warnings.append("no protected-area layer supplied: overlap is null")

        emb = embargo_status(emb_by.get(fid, []), cfg.as_of)
        if emb["simulated"]:
            warnings.append("embargo is simulated for the demonstration, not an Ibama record")

        # legal indicators (screening only) vs scientific risk
        bad_geom = status_of[fid] in ("missing", "empty", "rejected")
        if not measured or bad_geom:
            eudr = "undetermined"
        elif (ha["post_cutoff"] or 0) >= cfg.min_area_ha:
            eudr = "post_cutoff_clearing_detected"
        elif (ha["straddles_cutoff"] or 0) >= cfg.min_area_ha or (ha["unknown_date"] or 0) >= cfg.min_area_ha or cov == "partial":
            eudr = "undetermined"
        else:
            eudr = "no_post_cutoff_clearing_detected"
        ti_recognised = bool(ti and any(x["recognised"] and x["overlap_ha"] >= 1 for x in ti["areas"]))
        strict = bool(uc and any(x["strict_protection"] and x["overlap_ha"] >= 1 for x in uc["areas"]))
        legal = {"eudr_cutoff_indicator": eudr, "recognised_indigenous_land_overlap": ti_recognised if ti is not None else None,
                 "strict_protection_overlap": strict if uc is not None else None,
                 "embargo_status": emb["status"], "embargo_simulated": emb["simulated"],
                 "note": "screening indicators from public layers; not a legal determination"}

        reasons, risky_ha = [], None
        if measured:
            risky_ha = (ha["post_cutoff"] or 0) + ((ha["straddles_cutoff"] or 0) if cfg.straddling_is_risk else 0)
        if risky_ha is None:
            cls = "unknown"
            reasons.append("deforestation could not be measured")
        elif risky_ha >= cfg.high_ha or ti_recognised:
            cls = "high"
        elif risky_ha >= cfg.watch_ha or strict or (defo["nearest_post_cutoff_km"] is not None and defo["nearest_post_cutoff_km"] <= cfg.proximity_km and risky_ha == 0):
            cls = "watch"
        else:
            cls = "low"
        if risky_ha:
            reasons.append(f"{risky_ha:.2f} ha cleared after (or straddling) the cut-off inside the ranch")
        if ti_recognised:
            reasons.append("overlaps a recognised Indigenous land")
        if strict:
            reasons.append("overlaps a strict-protection unit")
        if risky_ha == 0 and defo["nearest_post_cutoff_km"] is not None and defo["nearest_post_cutoff_km"] <= cfg.proximity_km:
            reasons.append(f"post-cut-off clearing {defo['nearest_post_cutoff_km']} km away (proximity only, not a violation)")

        out.append({
            "ranch_id": fid,
            "geometry": {"status": status_of[fid], "area_ha": round(a, 2) if a is not None else None,
                         "source_crs": ranches.source_crs, "data_status": ranches.spec.data_status},
            "post_cutoff_deforestation_area_hectares": ha["post_cutoff"],
            "intersecting_deforestation_polygon_ids": sorted(set().union(*ids_by[fid].values())) if measured else None,
            "deforestation": defo,
            "indigenous_territory": ti,
            "protected_area": uc,
            "embargo": emb,
            "nearest_slaughterhouse_km": fac_km.get(fid) if has_geom and facilities is not None else None,
            "legal": legal,
            "scientific_risk": {"class": cls, "reasons": reasons},
            "warnings": warnings,
        })
    return out
