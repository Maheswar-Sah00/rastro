"""Where the simulated ranches sit.

`real`: the 409 Voronoi cells from landscape.py, measured on the real PRODES and protected-area
layers (needs data/derived/landscape.gpkg and geopandas).
`synthetic`: a grid of square ranches with synthetic clearing and overlap, for small fixtures
and tests. Nothing in it is real, and every record says so.
"""
import json
import math
from dataclasses import dataclass, field

import numpy as np

from rastro.config import DERIVED

# Grid origin for synthetic squares: inside the study window, so maps still render sensibly.
GRID_ORIGIN = (-52.30, -6.30)
CELL_M = 3000.0


@dataclass
class Landscape:
    kind: str                       # "real" | "synthetic"
    rows: list[dict]                # id, area_ha, pasture_ha, defor_post2020_ha, ti_overlap_ha, x, y (+ extra)
    destinations: list[dict]
    geometries: dict[str, dict] = field(default_factory=dict)  # ranch id -> GeoJSON geometry (WGS84)


def load_real() -> Landscape:
    import geopandas as gpd  # only the real landscape needs the geo stack

    g = gpd.read_file(DERIVED / "landscape.gpkg", layer="ranches")
    rows = g.drop(columns="geometry").to_dict("records")
    wgs = g.to_crs(4326)
    geoms = {rid: json.loads(gpd.GeoSeries([geom], crs=4326).to_json())["features"][0]["geometry"]
             for rid, geom in zip(wgs["id"], wgs.geometry)}
    dest = json.loads((DERIVED / "destinations.json").read_text(encoding="utf-8"))
    return Landscape("real", rows, dest, geoms)


def _square(x0, y0, side_m):
    return rect(x0, y0, side_m, side_m)


def rect(x0, y0, w_m, h_m):
    """Axis-aligned rectangle given in grid metres, as a WGS84 GeoJSON polygon."""
    lon0, lat0 = GRID_ORIGIN
    k_lon = 111_320 * math.cos(math.radians(lat0))
    pts = [(x0, y0), (x0 + w_m, y0), (x0 + w_m, y0 + h_m), (x0, y0 + h_m), (x0, y0)]
    return {"type": "Polygon", "coordinates": [[[round(lon0 + x / k_lon, 6), round(lat0 - y / 110_574, 6)] for x, y in pts]]}


def make_synthetic(n_ranches: int, seed: int) -> Landscape:
    rng = np.random.default_rng([seed, 101])
    cols = max(1, math.ceil(math.sqrt(n_ranches)))
    rows, geoms = [], {}
    for i in range(n_ranches):
        cx, cy = (i % cols) * CELL_M, (i // cols) * CELL_M
        side = CELL_M * float(rng.uniform(0.55, 0.95))
        area = side * side / 1e4
        pasture = area * float(rng.uniform(0.45, 0.9))
        u = rng.random()
        if u < 0.15:      # clearly cleared after the cut-off
            post2020 = float(rng.uniform(55, 160))
        elif u < 0.27:    # borderline: small recent clearing
            post2020 = float(rng.uniform(4, 45))
        else:
            post2020 = 0.0
        ti = float(rng.uniform(5, 80)) if rng.random() < 0.08 else 0.0
        rid = f"R{i + 1:04d}"
        rows.append({"id": rid, "area_ha": round(area, 1), "pasture_ha": round(pasture, 1),
                     "defor_post2008_ha": round(post2020 + pasture * 0.3, 1), "defor_post2020_ha": round(post2020, 1),
                     "ti_overlap_ha": round(ti, 1), "uc_overlap_ha": 0.0, "protected_name": "Synthetic TI" if ti else None,
                     "x": cx + side / 2, "y": cy + side / 2, "x0": cx, "y0": cy, "side_m": side})
        geoms[rid] = _square(cx, cy, side)
    dest = [
        {"id": "S:SIF_01", "kind": "slaughterhouse", "name": "Synthetic slaughterhouse 1", "company": "synthetic",
         "inspection": "SIF", "lat": -6.64, "lon": -51.98, "municipality": "synthetic", "dist_km": 4.0, "real": False},
        {"id": "S:SIE_01", "kind": "slaughterhouse", "name": "Synthetic slaughterhouse 2", "company": "synthetic",
         "inspection": "SIE", "lat": -6.70, "lon": -52.05, "municipality": "synthetic", "dist_km": 15.0, "real": False},
        {"id": "P:BARCARENA", "kind": "port", "name": "Synthetic export port", "company": "synthetic",
         "inspection": "SIF", "lat": -1.546, "lon": -48.757, "municipality": "synthetic", "real": False},
    ]
    return Landscape("synthetic", rows, dest, geoms)
