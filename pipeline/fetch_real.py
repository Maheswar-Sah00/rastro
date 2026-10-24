"""Fetch the real public datasets Rastro is built on and cache them under data/raw.

Sources
- INPE PRODES (TerraBrasilis GeoServer WFS): yearly deforestation, deforestation accumulated
  up to 2007, Indigenous lands and conservation units in the Legal Amazon.
- IBGE PPM (SIDRA table 3939): cattle herd by municipality.
- Trase logistics map v6 (CC BY 4.0): slaughterhouses and other facilities in Brazil.

Usage: python fetch_real.py [--bbox W S E N]
"""
import argparse
import json
import sys
import time
from pathlib import Path

import requests

RAW = Path(__file__).parent / "data" / "raw"
WFS = "https://terrabrasilis.dpi.inpe.br/geoserver/prodes-legal-amz/ows"
UA = {"User-Agent": "Mozilla/5.0 (rastro research pipeline)"}

# São Félix do Xingu (PA): wide window used to choose the study AOI.
DEFAULT_BBOX = (-52.5, -7.0, -51.5, -6.0)
LAYERS = {
    "yearly_deforestation": "prodes-legal-amz:yearly_deforestation",
    "accumulated_2007": "prodes-legal-amz:accumulated_deforestation_2007",
    "indigenous": "prodes-legal-amz:indigenous_area_legal_amazon",
    "conservation": "prodes-legal-amz:conservation_units_legal_amazon",
    "municipalities": "prodes-legal-amz:municipalities_legal_amazon",
}
IBGE_MUNICIPALITIES = {"1507300": "São Félix do Xingu (PA)"}


def get(url, **kw):
    for attempt in range(4):
        try:
            r = requests.get(url, headers=UA, timeout=180, **kw)
            r.raise_for_status()
            return r
        except requests.RequestException as e:
            print(f"  retry {attempt + 1}: {e}", file=sys.stderr)
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"failed: {url}")


PAGED = {"yearly_deforestation", "accumulated_2007"}  # large layers; paging needs a sort key


def fetch_wfs(name, type_name, bbox, page=5000):
    out = RAW / f"{name}.geojson"
    if out.exists():
        print(f"cached {out.name}")
        return out
    features, start = [], 0
    while True:
        params = {
            "service": "WFS", "version": "1.0.0", "request": "GetFeature",
            "typeName": type_name, "outputFormat": "application/json",
            "bbox": ",".join(str(v) for v in bbox),
        }
        if name in PAGED:
            params.update({"maxFeatures": page, "startIndex": start, "sortBy": "fid"})
        batch = get(WFS, params=params).json()["features"]
        features += batch
        print(f"  {name}: {len(features)}")
        if name not in PAGED or len(batch) < page:
            break
        start += page
    out.write_text(json.dumps({"type": "FeatureCollection", "features": features}), encoding="utf-8")
    return out


def fetch_ibge():
    out = RAW / "ibge_herd.json"
    if out.exists():
        print(f"cached {out.name}")
        return out
    rows = {}
    for code, name in IBGE_MUNICIPALITIES.items():
        url = f"https://apisidra.ibge.gov.br/values/t/3939/n6/{code}/v/105/p/last%205/c79/2670"
        data = get(url).json()[1:]
        rows[code] = {"name": name, "herd": {d["D3N"]: int(d["V"]) for d in data if d["V"].isdigit()}}
    pa = get("https://apisidra.ibge.gov.br/values/t/3939/n3/15/v/105/p/last%201/c79/2670").json()[1:]
    rows["15"] = {"name": "Pará (state)", "herd": {d["D3N"]: int(d["V"]) for d in pa if d["V"].isdigit()}}
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    return out


def fetch_trase():
    out = RAW / "trase_beef_logistics_v6.geojson"
    if out.exists():
        print(f"cached {out.name}")
        return out
    url = "https://resources.trase.earth/data/facilities-data/2026-05-07-br_beef_logistics_map_v6.geo.json"
    out.write_bytes(get(url).content)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", nargs=4, type=float, default=DEFAULT_BBOX)
    args = ap.parse_args()
    RAW.mkdir(parents=True, exist_ok=True)
    for name, type_name in LAYERS.items():
        fetch_wfs(name, type_name, args.bbox)
    fetch_ibge()
    fetch_trase()
    print("done")


if __name__ == "__main__":
    main()
