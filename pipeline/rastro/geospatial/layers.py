"""One interface for every spatial input, real or synthetic.

A layer is described by a LayerSpec (path, kind, id field, provenance). `load_layer` reads
GeoJSON or GeoPackage, validates the CRS, repairs or rejects bad geometries (logging why),
and returns the features in the metric CRS together with their provenance. Swapping a synthetic
file for a real one is a change of LayerSpec, not of the analysis code.
"""
import hashlib
from dataclasses import dataclass, field
from pathlib import Path

import geopandas as gpd
import pandas as pd
from pyproj import CRS
from shapely.geometry import box
from shapely.validation import explain_validity, make_valid

from rastro.geospatial import METRIC_CRS

KINDS = {"ranches", "deforestation", "indigenous", "protected", "facilities"}
POLYGONAL = {"Polygon", "MultiPolygon"}


@dataclass(frozen=True)
class LayerSpec:
    name: str
    kind: str                         # one of KINDS
    path: Path
    source: str
    data_status: str                  # "real" | "synthetic"
    licence: str | None = None
    layer: str | None = None          # GeoPackage layer
    id_fields: tuple[str, ...] = ()   # first present field becomes the feature id; fallback: row index
    id_prefix: str = ""
    assume_crs: str | None = None     # used, with a warning, only when the file declares no CRS
    coverage_bbox: tuple[float, float, float, float] | None = None  # lon/lat extent the layer is complete for

    def fingerprint(self) -> str:
        return hashlib.sha256(self.path.read_bytes()).hexdigest() if self.path.is_file() else "missing"


@dataclass
class Layer:
    spec: LayerSpec
    gdf: gpd.GeoDataFrame             # metric CRS; columns: fid, geometry, source attributes
    version: str
    source_crs: str | None
    log: list[dict] = field(default_factory=list)
    coverage: object = None           # shapely geometry in the metric CRS, or None = unknown

    @property
    def provenance(self) -> dict:
        return {"layer": self.spec.name, "kind": self.spec.kind, "source": self.spec.source,
                "data_status": self.spec.data_status, "licence": self.spec.licence, "version": self.version,
                "path": self.spec.path.as_posix(), "source_crs": self.source_crs, "features": len(self.gdf)}


class LayerError(ValueError):
    pass


def load_layer(spec: LayerSpec) -> Layer:
    if spec.kind not in KINDS:
        raise LayerError(f"{spec.name}: unknown layer kind {spec.kind!r}")
    if not spec.path.is_file():
        raise LayerError(f"{spec.name}: file not found: {spec.path}")
    if spec.path.suffix.lower() not in (".geojson", ".json", ".gpkg"):
        raise LayerError(f"{spec.name}: unsupported format {spec.path.suffix} (GeoJSON or GeoPackage)")
    gdf = gpd.read_file(spec.path, layer=spec.layer) if spec.layer else gpd.read_file(spec.path)
    return prepare(gdf, spec)


def prepare(gdf: gpd.GeoDataFrame, spec: LayerSpec) -> Layer:
    """Validate and normalise an in-memory layer (used by load_layer and by tests)."""
    log = []
    version = f"{spec.path.name}@{spec.fingerprint()[:12]}"

    # ---- CRS ------------------------------------------------------------------------------
    if gdf.crs is None:
        if not spec.assume_crs:
            raise LayerError(f"{spec.name}: no CRS declared and no assume_crs given; refusing to guess")
        gdf = gdf.set_crs(spec.assume_crs)
        log.append(_log(spec, None, "crs_assumed", f"file declares no CRS; assumed {spec.assume_crs}"))
    source_crs = gdf.crs.to_string()
    crs = CRS.from_user_input(gdf.crs)
    if crs.is_geographic and len(gdf):
        b = gdf.total_bounds
        if b[0] < -180 or b[2] > 180 or b[1] < -90 or b[3] > 90:
            raise LayerError(f"{spec.name}: coordinates outside lon/lat range for geographic CRS {source_crs}")

    # ---- ids ------------------------------------------------------------------------------
    col = next((c for c in spec.id_fields if c in gdf.columns and gdf[c].notna().all()), None)
    ids = gdf[col].astype(str) if col else gdf.index.astype(str)
    gdf = gdf.assign(fid=[f"{spec.id_prefix}{i}" for i in ids])
    if gdf["fid"].duplicated().any():
        dup = gdf.loc[gdf["fid"].duplicated(), "fid"].iloc[0]
        raise LayerError(f"{spec.name}: duplicate feature id {dup}")

    # ---- geometry quality -----------------------------------------------------------------
    status, keep = [], []
    for fid, geom in zip(gdf["fid"], gdf.geometry):
        if geom is None:
            status.append("missing")
            keep.append(spec.kind == "ranches")  # a ranch without geometry is reported, not dropped
            log.append(_log(spec, fid, "missing_geometry", "no geometry"))
            continue
        if geom.is_empty:
            status.append("empty")
            keep.append(spec.kind == "ranches")
            log.append(_log(spec, fid, "empty_geometry", "geometry is empty"))
            continue
        if spec.kind == "facilities":
            ok = geom.geom_type == "Point"
        else:
            ok = geom.geom_type in POLYGONAL or geom.geom_type == "GeometryCollection"
        if not ok:
            status.append("rejected")
            keep.append(spec.kind == "ranches")
            log.append(_log(spec, fid, "wrong_geometry_type", f"{geom.geom_type} not allowed in a {spec.kind} layer"))
            continue
        if not geom.is_valid:
            why = explain_validity(geom)
            status.append("repaired")
            keep.append(True)
            log.append(_log(spec, fid, "repaired", f"invalid geometry ({why}); repaired with make_valid"))
        else:
            status.append("valid")
            keep.append(True)
    gdf = gdf.assign(geometry_status=status)[pd.Series(keep, index=gdf.index, dtype=bool)].copy()
    fixed = []
    for geom, st in zip(gdf.geometry, gdf["geometry_status"]):
        if st in ("missing", "empty", "rejected"):
            geom = None  # kept for reporting only (ranches); never measured
        elif st == "repaired":
            geom = _polygonal(make_valid(geom))
        elif geom is not None and geom.geom_type == "GeometryCollection":
            geom = _polygonal(geom)
        fixed.append(geom)
    gdf = gdf.set_geometry(gpd.GeoSeries(fixed, index=gdf.index, crs=gdf.crs))
    bad = [(f, s) for f, s, g in zip(gdf["fid"], gdf["geometry_status"], gdf.geometry) if s == "repaired" and (g is None or g.is_empty)]
    for f, _ in bad:
        log.append(_log(spec, f, "repair_failed", "make_valid left no polygonal part; geometry treated as empty"))
    gdf.loc[gdf["fid"].isin([f for f, _ in bad]), "geometry_status"] = "empty"
    if spec.kind != "ranches":  # an environmental feature without usable geometry cannot be measured: drop it (logged above)
        gdf = gdf[gdf["geometry_status"].isin(["valid", "repaired"])].copy()

    gdf = gdf.to_crs(METRIC_CRS)
    coverage = gpd.GeoSeries([box(*spec.coverage_bbox)], crs=4326).to_crs(METRIC_CRS).iloc[0] if spec.coverage_bbox else None
    return Layer(spec, gdf, version, source_crs, log, coverage)


def _polygonal(geom):
    if geom is None or geom.is_empty:
        return geom
    if geom.geom_type in POLYGONAL:
        return geom
    if geom.geom_type == "GeometryCollection":
        from shapely.ops import unary_union
        parts = [g for g in geom.geoms if g.geom_type in POLYGONAL]
        return unary_union(parts) if parts else None
    return None


def _log(spec, fid, code, message):
    return {"layer": spec.name, "feature": fid, "code": code, "message": message}
