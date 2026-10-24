"""Stage 1: build the study landscape from real layers.

Real: PRODES deforestation (yearly 2008-2025 + accumulated to 2007), Indigenous lands,
conservation units, Trase slaughterhouses. Synthetic: ranch boundaries (Voronoi cells over
the AOI, denser near the town). Every ranch gets its real pasture area, post-2008 and
post-2020 deforestation and protected-area overlap by intersecting with the real layers.

Writes data/derived/landscape.gpkg (layers: ranches, clearing, protected, aoi) and
data/derived/destinations.json.
"""
import json
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import MultiPoint, Point, box
from shapely.ops import voronoi_diagram

HERE = Path(__file__).parent
RAW, DER = HERE / "data" / "raw", HERE / "data" / "derived"
AOI_BBOX = (-52.3, -7.0, -51.6, -6.3)
TOWN = (-51.995, -6.643)  # São Félix do Xingu
UTM = "EPSG:31982"  # SIRGAS 2000 / UTM 22S
N_SEEDS = 420
PORT = {"id": "P:BARCARENA", "kind": "port", "name": "Port of Vila do Conde (Barcarena)",
        "company": "Public port — live-cattle export terminal", "inspection": "SIF",
        "lat": -1.546, "lon": -48.757, "municipality": "Barcarena", "real": True}
rng = np.random.default_rng(2026)


def clean_name(raw):
    """TerraBrasilis serves some names with broken accents; map the ones in our window by keyword."""
    up = str(raw).upper()
    if "TRIUNFO DO XINGU" in up:
        return "APA Triunfo do Xingu"
    if up.startswith("KAYAP"):
        return "Kayapó"
    if up.startswith("APYTEREWA"):
        return "Apyterewa"
    return str(raw).title()


def read(name):
    g = gpd.read_file(RAW / f"{name}.geojson")
    g = g.set_crs(4326) if g.crs is None else g.to_crs(4326)
    g["geometry"] = g.geometry.make_valid()
    return g[g.geometry.geom_type.isin(["Polygon", "MultiPolygon"]) | g.geometry.geom_type.eq("GeometryCollection")]


def seeds(aoi_utm):
    """Rejection-sample ranch seeds, denser near the town (smaller ranches near roads/town)."""
    minx, miny, maxx, maxy = aoi_utm.bounds
    town = gpd.GeoSeries([Point(TOWN)], crs=4326).to_crs(UTM).iloc[0]
    pts = []
    while len(pts) < N_SEEDS:
        x, y = rng.uniform(minx, maxx), rng.uniform(miny, maxy)
        d = Point(x, y).distance(town) / 1000
        if rng.random() < 0.35 + 0.65 * np.exp(-d / 35):
            pts.append(Point(x, y))
    return pts


def main():
    DER.mkdir(parents=True, exist_ok=True)
    aoi = gpd.GeoDataFrame({"name": ["study window"]}, geometry=[box(*AOI_BBOX)], crs=4326)
    aoi_utm = aoi.to_crs(UTM).geometry.iloc[0]

    yd = read("yearly_deforestation")[["year", "geometry"]]
    yd["year"] = yd["year"].astype(int)
    ac = read("accumulated_2007")[["geometry"]].assign(year=2007)
    clearing = pd.concat([ac, yd], ignore_index=True).to_crs(UTM)
    clearing["geometry"] = clearing.geometry.make_valid()
    clearing = gpd.clip(clearing, aoi_utm)
    clearing = clearing.explode(index_parts=False)
    clearing = clearing[clearing.geometry.geom_type == "Polygon"]
    clearing = clearing[~clearing.geometry.is_empty]
    clearing["geometry"] = clearing.geometry.buffer(0)

    ti = read("indigenous").rename(columns={"terrai_nom": "name"})[["name", "geometry"]].assign(kind="indigenous")
    uc = read("conservation").rename(columns={"nome": "name"})[["name", "geometry"]].assign(kind="conservation")

    protected = pd.concat([ti, uc], ignore_index=True).to_crs(UTM)
    protected["geometry"] = protected.geometry.make_valid()
    protected = gpd.clip(protected, aoi_utm)
    protected["name"] = protected["name"].map(clean_name)

    cells = voronoi_diagram(MultiPoint(seeds(aoi_utm)), envelope=aoi_utm)
    ranches = gpd.GeoDataFrame(geometry=[c.intersection(aoi_utm) for c in cells.geoms], crs=UTM)
    ranches = ranches[ranches.area > 0].reset_index(drop=True)
    ranches["area_ha"] = ranches.area / 1e4

    inter = gpd.overlay(ranches.reset_index(names="rid"), clearing, how="intersection", keep_geom_type=True)
    inter["ha"] = inter.area / 1e4
    by = inter.groupby(["rid", "year"]).ha.sum().unstack(fill_value=0)
    ranches["pasture_ha"] = by.sum(axis=1).reindex(ranches.index, fill_value=0)
    ranches["defor_post2008_ha"] = by[[c for c in by.columns if c >= 2008]].sum(axis=1).reindex(ranches.index, fill_value=0)
    # PRODES year Y covers Aug(Y-1)-Jul(Y): year >= 2021 approximates "after the EUDR cut-off (31 Dec 2020)".
    ranches["defor_post2020_ha"] = by[[c for c in by.columns if c >= 2021]].sum(axis=1).reindex(ranches.index, fill_value=0)
    ranches["defor_by_year"] = [
        {int(y): round(float(v), 1) for y, v in by.loc[i].items() if y >= 2008 and v > 0} if i in by.index else {}
        for i in ranches.index]

    pin = gpd.overlay(ranches.reset_index(names="rid"), protected, how="intersection", keep_geom_type=True)
    pin["ha"] = pin.area / 1e4
    ti_ha = pin[pin.kind == "indigenous"].groupby("rid").ha.sum()
    uc_ha = pin[pin.kind == "conservation"].groupby("rid").ha.sum()
    names = pin.sort_values("ha").groupby("rid").name.last()
    ranches["ti_overlap_ha"] = ti_ha.reindex(ranches.index, fill_value=0)
    ranches["uc_overlap_ha"] = uc_ha.reindex(ranches.index, fill_value=0)
    ranches["protected_name"] = names.reindex(ranches.index)

    # A ranch needs pasture: cells that are mostly forest are not ranches.
    ranches = ranches[ranches.pasture_ha / ranches.area_ha >= 0.15].reset_index(drop=True)
    ranches["id"] = [f"R{i + 1:04d}" for i in range(len(ranches))]
    c = ranches.geometry.centroid
    ranches["x"], ranches["y"] = c.x, c.y

    # Real beef slaughterhouses in Pará (Trase). Names are anonymised: flows in this demo are synthetic.
    tr = gpd.read_file(RAW / "trase_beef_logistics_v6.geojson")
    sh = tr[(tr.state == "Pará") & (tr.commodity == "Beef") & (tr.type_english == "Slaughterhouse")
            & (tr.inspection_level.isin(["SIF", "SIE"])) & (tr.status == "Active")].copy()
    sh = gpd.GeoDataFrame(sh, geometry=gpd.points_from_xy(sh.long, sh.lat), crs=4326).to_crs(UTM)
    town = gpd.GeoSeries([Point(TOWN)], crs=4326).to_crs(UTM).iloc[0]
    sh["dist_km"] = sh.distance(town) / 1000
    sh = sh.sort_values("dist_km").drop_duplicates("facility_id").head(6)
    dest = []
    for k, (_, r) in enumerate(sh.iterrows()):
        dest.append({"id": f"S:{r.inspection_level}_{k + 1:02d}", "kind": "slaughterhouse",
                     "name": f"Slaughterhouse {chr(65 + k)} ({r.inspection_level}, {r.municipality})",
                     "company": "anonymised (real location, synthetic flows)", "inspection": r.inspection_level,
                     "lat": float(r.lat), "lon": float(r.long), "municipality": r.municipality,
                     "dist_km": round(float(r.dist_km), 1), "real": True})
    dest.append(PORT)
    (DER / "destinations.json").write_text(json.dumps(dest, ensure_ascii=False, indent=1), encoding="utf-8")

    out = DER / "landscape.gpkg"
    if out.exists():
        out.unlink()
    r2 = ranches.copy()
    r2["defor_by_year"] = r2["defor_by_year"].apply(json.dumps)
    r2.to_file(out, layer="ranches", driver="GPKG")
    clearing.to_file(out, layer="clearing", driver="GPKG")
    protected.to_file(out, layer="protected", driver="GPKG")
    aoi.to_crs(UTM).to_file(out, layer="aoi", driver="GPKG")

    print(f"ranches: {len(ranches)}  area {ranches.area_ha.sum():,.0f} ha  pasture {ranches.pasture_ha.sum():,.0f} ha")
    for t in (1, 6.25, 25, 50, 100):
        print(f"  post-2020 clearing >= {t:>5} ha: {(ranches.defor_post2020_ha >= t).sum()}")
    print(f"  TI overlap >= 1 ha: {(ranches.ti_overlap_ha >= 1).sum()}  UC overlap >= 1 ha: {(ranches.uc_overlap_ha >= 1).sum()}")
    print("destinations:", [(d["id"], d["municipality"], d.get("dist_km")) for d in dest])


if __name__ == "__main__":
    main()
