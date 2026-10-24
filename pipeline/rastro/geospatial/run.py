"""Run the geospatial evidence engine on a canonical dataset.

    python -m rastro.geospatial.run ../data/synthetic/evaluation            # real layers, synthetic ranches
    python -m rastro.geospatial.run DIR --layers my_layers.json            # swap in other files
    python -m rastro.geospatial.run DIR --cutoff 2020-12-31 --force --publish

Inputs are fingerprinted (file hashes + configuration + engine version). If nothing changed the
run is skipped; changing any source file triggers a full recalculation.

Writes into DIR/derived/: geo_evidence.jsonl (one record per ranch), geo_evidence.geojson (map
export), geo_qa_log.jsonl (every CRS assumption, repair and rejection), geo_provenance.json/.md,
geo_evidence.meta.json (fingerprint). --publish copies the map export to web/public/data/layers/.
"""
import argparse
import hashlib
import json
import shutil
import sys
from dataclasses import asdict
from datetime import date
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.geometry import Point

from rastro.config import RAW, REPO
from rastro.geospatial import ENGINE_VERSION, METRIC_CRS
from rastro.geospatial.analysis import GeoConfig, assess
from rastro.geospatial.layers import Layer, LayerSpec, load_layer, prepare
from rastro.schemas.geo import GEO_SCHEMA_VERSION, GeoEvidence

STUDY_BBOX = (-52.5, -7.0, -51.5, -6.0)   # fetch_real.py DEFAULT_BBOX: the real layers are complete here
WEB_LAYERS = REPO / "web" / "public" / "data" / "layers"


def default_specs(dataset: Path) -> dict[str, list[LayerSpec]]:
    manifest = json.loads((dataset / "manifest.json").read_text(encoding="utf-8"))
    ranches = LayerSpec("ranch_boundaries", "ranches", dataset / "inputs" / "ranch_boundaries.geojson",
                        "rastro.synth ranch cells", "synthetic", id_fields=("ranch_id", "id"))
    if manifest["landscape"] == "real":
        prodes = dict(kind="deforestation", source="INPE PRODES (TerraBrasilis)", data_status="real", licence="CC BY-SA 4.0",
                      id_fields=("uuid", "fid", "id"), id_prefix="prodes_deforestation:", coverage_bbox=STUDY_BBOX)
        return {
            "ranches": [ranches],
            "deforestation": [LayerSpec("prodes_yearly", path=RAW / "yearly_deforestation.geojson", **prodes),
                              LayerSpec("prodes_accumulated_2007", path=RAW / "accumulated_2007.geojson", **prodes)],
            "indigenous": [LayerSpec("funai_indigenous", "indigenous", RAW / "indigenous.geojson", "FUNAI Indigenous lands (TerraBrasilis)",
                                     "real", "public", id_fields=("id",), id_prefix="indigenous_territory:", coverage_bbox=STUDY_BBOX)],
            "protected": [LayerSpec("conservation_units", "protected", RAW / "conservation.geojson", "Conservation units (TerraBrasilis)",
                                    "real", "public", id_fields=("id",), id_prefix="conservation_unit:", coverage_bbox=STUDY_BBOX)],
        }
    env = dataset / "environment"
    # The synthetic layers are generated for exactly this grid, so they are complete over its extent.
    grid = tuple(float(v) for v in gpd.read_file(ranches.path).total_bounds)
    syn = dict(source="rastro.synth synthetic layer (not real data)", data_status="synthetic", coverage_bbox=grid)
    return {
        "ranches": [ranches],
        "deforestation": [LayerSpec("synthetic_deforestation", "deforestation", env / "synthetic_deforestation.geojson",
                                    id_fields=("record_id",), **syn)],
        "indigenous": [LayerSpec("synthetic_indigenous", "indigenous", env / "synthetic_indigenous.geojson",
                                 id_fields=("record_id",), **syn)],
        "protected": [LayerSpec("synthetic_protected", "protected", env / "synthetic_protected.geojson",
                                id_fields=("record_id",), **syn)],
    }


def specs_from_file(path: Path, base: Path) -> dict[str, list[LayerSpec]]:
    """Layer config: {"deforestation": [{"name":..., "path":..., "source":..., "data_status":..., ...}], ...}."""
    cfg = json.loads(path.read_text(encoding="utf-8"))
    out = {}
    for kind, items in cfg.items():
        out[kind] = [LayerSpec(kind=kind, **{**i, "path": (base / i["path"]).resolve(),
                                             "id_fields": tuple(i.get("id_fields", ())),
                                             "coverage_bbox": tuple(i["coverage_bbox"]) if i.get("coverage_bbox") else None})
                     for i in items]
    return out


def merge(layers: list[Layer]) -> Layer | None:
    if not layers:
        return None
    if len(layers) == 1:
        return layers[0]
    gdf = gpd.GeoDataFrame(pd.concat([l.gdf for l in layers], ignore_index=True), crs=METRIC_CRS)
    if gdf["fid"].duplicated().any():
        raise ValueError(f"duplicate feature ids across {[l.spec.name for l in layers]}")
    first = layers[0]
    covs = [l.coverage for l in layers if l.coverage is not None]
    m = Layer(first.spec, gdf, "+".join(l.version for l in layers), first.source_crs,
              [e for l in layers for e in l.log], covs[0] if covs else None)
    m.parts = layers
    return m


def facilities_layer(dataset: Path) -> Layer | None:
    p = dataset / "inputs" / "destinations.jsonl"
    if not p.is_file():
        return None
    rows = [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l]
    g = gpd.GeoDataFrame(rows, geometry=[Point(r["lon"], r["lat"]) for r in rows], crs=4326)
    status = "real" if all(r["data_source"] == "real" for r in rows) else "synthetic"
    spec = LayerSpec("destinations", "facilities", p, "dataset destinations (Trase locations when real)", status,
                     id_fields=("destination_id",))
    return prepare(g, spec)


def fingerprint(specs: dict[str, list[LayerSpec]], dataset: Path, cfg: GeoConfig) -> tuple[str, list[dict]]:
    inputs = [{"kind": k, "name": s.name, "path": s.path.as_posix(), "sha256": s.fingerprint()} for k in sorted(specs) for s in specs[k]]
    for rel in ("environment/embargoes.jsonl", "inputs/destinations.jsonl"):
        p = dataset / rel
        inputs.append({"kind": "table", "name": rel, "path": p.as_posix(),
                       "sha256": hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else "missing"})
    blob = json.dumps({"inputs": [(i["name"], i["sha256"]) for i in inputs], "config": asdict(cfg), "engine": ENGINE_VERSION},
                      default=str, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest(), inputs


def run(dataset: Path, specs: dict[str, list[LayerSpec]] | None = None, cfg: GeoConfig = GeoConfig(),
        force: bool = False, publish: bool = False) -> dict:
    specs = specs or default_specs(dataset)
    out = dataset / "derived"
    out.mkdir(parents=True, exist_ok=True)
    fp, inputs = fingerprint(specs, dataset, cfg)
    meta_path = out / "geo_evidence.meta.json"
    if not force and meta_path.is_file() and json.loads(meta_path.read_text(encoding="utf-8")).get("fingerprint") == fp:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["recalculated"] = False
        if publish:
            _publish(out)
        return meta

    loaded = {k: merge([load_layer(s) for s in v if s.path.is_file()]) for k, v in specs.items()}
    if loaded.get("ranches") is None:
        raise SystemExit("no ranch layer")
    fac = facilities_layer(dataset)
    emb_path = dataset / "environment" / "embargoes.jsonl"
    embargoes = [json.loads(l) for l in emb_path.read_text(encoding="utf-8").splitlines() if l] if emb_path.is_file() else []

    records = assess(loaded["ranches"], loaded.get("deforestation"), loaded.get("indigenous"), loaded.get("protected"),
                     fac, embargoes, cfg)
    versions = {k: l.version for k, l in loaded.items() if l is not None}
    if fac is not None:
        versions["facilities"] = fac.version
    if emb_path.is_file():
        versions["embargoes"] = f"embargoes.jsonl@{hashlib.sha256(emb_path.read_bytes()).hexdigest()[:12]}"
    status = {k: l.spec.data_status for k, l in loaded.items() if l is not None}
    status["embargoes"] = "synthetic" if any(e.get("data_status") != "real" for e in embargoes) else ("real" if embargoes else "none")
    if fac is not None:
        status["facilities"] = fac.spec.data_status
    lines = []
    for r in records:
        r = {"schema_version": GEO_SCHEMA_VERSION, "cutoff_date": cfg.cutoff.isoformat(), "as_of": cfg.as_of.isoformat(),
             "dataset_versions": versions, "data_status": status, **r}
        GeoEvidence.model_validate(r)
        lines.append(json.dumps(r, sort_keys=True, ensure_ascii=False, separators=(",", ":")))
    (out / "geo_evidence.jsonl").write_bytes(("\n".join(lines) + "\n").encode("utf-8"))

    qa = [e for l in loaded.values() if l is not None for e in l.log] + (fac.log if fac else [])
    (out / "geo_qa_log.jsonl").write_bytes("".join(json.dumps(e, ensure_ascii=False, sort_keys=True) + "\n" for e in qa).encode("utf-8"))

    map_fc = map_export(loaded["ranches"], records, status)
    (out / "geo_evidence.geojson").write_bytes(json.dumps(map_fc, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

    prov = provenance(loaded, fac, embargoes, records, cfg, versions)
    (out / "geo_provenance.json").write_bytes(json.dumps(prov, indent=1, ensure_ascii=False, sort_keys=True).encode("utf-8"))
    (out / "geo_provenance.md").write_text(provenance_md(prov), encoding="utf-8")

    meta = {"engine_version": ENGINE_VERSION, "schema_version": GEO_SCHEMA_VERSION, "fingerprint": fp, "inputs": inputs,
            "config": {k: str(v) for k, v in asdict(cfg).items()}, "ranches": len(records), "qa_events": len(qa),
            "outputs": ["geo_evidence.jsonl", "geo_evidence.geojson", "geo_qa_log.jsonl", "geo_provenance.json", "geo_provenance.md"]}
    meta_path.write_bytes(json.dumps(meta, indent=1, sort_keys=True).encode("utf-8"))
    if publish:
        _publish(out)
    meta["recalculated"] = True
    return meta


def _publish(out: Path):
    WEB_LAYERS.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(out / "geo_evidence.geojson", WEB_LAYERS / "ranch_evidence.geojson")


def map_export(ranches: Layer, records: list[dict], status: dict) -> dict:
    """Flat per-ranch properties for MapLibre styling; geometry back in WGS84."""
    by = {r["ranch_id"]: r for r in records}
    g = ranches.gdf[ranches.gdf.geometry.notna() & ~ranches.gdf.geometry.is_empty].to_crs(4326)
    feats = []
    for fid, geom in sorted(zip(g["fid"], g.geometry), key=lambda x: x[0]):
        r = by[fid]
        d, ti, uc = r["deforestation"], r["indigenous_territory"], r["protected_area"]
        feats.append({"type": "Feature", "id": fid, "geometry": json.loads(gpd.GeoSeries([geom]).to_json())["features"][0]["geometry"],
                      "properties": {
                          "ranch_id": fid, "post_cutoff_ha": d["post_cutoff_ha"], "straddles_cutoff_ha": d["straddles_cutoff_ha"],
                          "pre_cutoff_ha": d["pre_cutoff_ha"], "nearest_post_cutoff_km": d["nearest_post_cutoff_km"],
                          "eudr_indicator": r["legal"]["eudr_cutoff_indicator"], "risk_class": r["scientific_risk"]["class"],
                          "ti_share": ti["overlap_share"] if ti else None, "pa_share": uc["overlap_share"] if uc else None,
                          "embargo": r["embargo"]["status"], "embargo_simulated": r["embargo"]["simulated"],
                          "geometry_status": r["geometry"]["status"], "ranch_data_status": status.get("ranches"),
                          "n_warnings": len(r["warnings"])}})
    return {"type": "FeatureCollection", "schema_version": GEO_SCHEMA_VERSION, "features": feats}


def provenance(loaded, fac, embargoes, records, cfg, versions) -> dict:
    layers = []
    for k, l in loaded.items():
        if l is None:
            continue
        for part in getattr(l, "parts", [l]):
            layers.append(part.provenance)
    if fac is not None:
        layers.append(fac.provenance)
    real = sorted({p["kind"] for p in layers if p["data_status"] == "real"})
    synthetic = sorted({p["kind"] for p in layers if p["data_status"] != "real"} | ({"embargoes"} if embargoes and any(e.get("data_status") != "real" for e in embargoes) else set()))
    fields = {
        "post_cutoff_deforestation_area_hectares": ["ranches", "deforestation"],
        "indigenous_territory.overlap_*": ["ranches", "indigenous"],
        "protected_area.overlap_*": ["ranches", "protected"],
        "embargo.*": ["embargoes"],
        "nearest_slaughterhouse_km": ["ranches", "facilities"],
        "legal.eudr_cutoff_indicator": ["ranches", "deforestation"],
        "scientific_risk": ["ranches", "deforestation", "indigenous", "protected"],
    }
    kind_status = {p["kind"]: p["data_status"] for p in layers}
    kind_status["embargoes"] = "synthetic" if "embargoes" in synthetic else "real"
    per_field = {f: {"inputs": ks, "uses_synthetic": any(kind_status.get(k, "missing") != "real" for k in ks),
                     "uses_real": any(kind_status.get(k) == "real" for k in ks)} for f, ks in fields.items()}
    counts = {
        "ranches": len(records),
        "eudr_indicator": _count(r["legal"]["eudr_cutoff_indicator"] for r in records),
        "scientific_risk": _count(r["scientific_risk"]["class"] for r in records),
        "embargo": _count(r["embargo"]["status"] for r in records),
        "geometry_status": _count(r["geometry"]["status"] for r in records),
    }
    return {"engine_version": ENGINE_VERSION, "schema_version": GEO_SCHEMA_VERSION, "cutoff": cfg.cutoff.isoformat(),
            "layers": layers, "real_inputs": real, "synthetic_inputs": synthetic, "fields": per_field,
            "dataset_versions": versions, "summary": counts,
            "disclaimer": "Ranch boundaries and embargoes are simulated. Results describe simulated ranch cells on "
                          + ("real environmental layers" if real else "synthetic environmental layers")
                          + " and establish no legal violation by any real ranch or person."}


def _count(xs):
    out = {}
    for x in xs:
        out[x] = out.get(x, 0) + 1
    return dict(sorted(out.items()))


def provenance_md(p: dict) -> str:
    rows = "\n".join(f"| {l['layer']} | {l['kind']} | **{l['data_status']}** | {l['source']} | {l['licence'] or ''} | `{l['version']}` | {l['features']} |"
                     for l in p["layers"])
    fields = "\n".join(f"| `{f}` | {', '.join(v['inputs'])} | {'yes' if v['uses_real'] else 'no'} | {'**yes**' if v['uses_synthetic'] else 'no'} |"
                       for f, v in p["fields"].items())
    s = p["summary"]
    return f"""# Geospatial evidence provenance

Engine {p['engine_version']}, schema `{p['schema_version']}`, cut-off {p['cutoff']}.

> {p['disclaimer']}

## Inputs

| Layer | Kind | Status | Source | Licence | Version | Features |
|---|---|---|---|---|---|---|
{rows}
| embargoes | embargoes | **{'synthetic' if 'embargoes' in p['synthetic_inputs'] else 'real'}** | dataset embargoes.jsonl | | `{p['dataset_versions'].get('embargoes', '')}` | |

## Which results use real and synthetic data

| Output field | Inputs | Real data | Synthetic data |
|---|---|---|---|
{fields}

## Summary

- Ranches assessed: {s['ranches']}
- EUDR cut-off indicator: {s['eudr_indicator']}
- Scientific risk: {s['scientific_risk']}
- Embargo status: {s['embargo']}
- Ranch geometry status: {s['geometry_status']}
"""


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dataset", type=Path)
    ap.add_argument("--layers", type=Path, help="JSON layer config replacing the defaults")
    ap.add_argument("--cutoff", type=date.fromisoformat, default=GeoConfig.cutoff)
    ap.add_argument("--as-of", type=date.fromisoformat, default=GeoConfig.as_of)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--publish", action="store_true", help="copy the map export to web/public/data/layers/")
    a = ap.parse_args(argv)
    specs = specs_from_file(a.layers, a.layers.parent) if a.layers else None
    meta = run(a.dataset, specs, GeoConfig(cutoff=a.cutoff, as_of=a.as_of), a.force, a.publish)
    print(json.dumps({k: meta[k] for k in ("recalculated", "fingerprint", "ranches", "qa_events")}, indent=1))
    prov = a.dataset / "derived" / "geo_provenance.json"
    if prov.is_file():
        print(json.dumps(json.loads(prov.read_text(encoding="utf-8"))["summary"], indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
