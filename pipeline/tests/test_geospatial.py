"""Geospatial evidence engine on known geometries (metric CRS EPSG:31982, so areas are exact)."""
import json
import shutil
from datetime import date
from pathlib import Path

import geopandas as gpd
import pytest
from shapely.geometry import Point, Polygon, box

from rastro.geospatial.analysis import GeoConfig, assess, clearing_period, cutoff_class, embargo_status
from rastro.geospatial.layers import LayerError, LayerSpec, prepare
from rastro.geospatial.run import run
from rastro.schemas.geo import GeoEvidence

UTM = "EPSG:31982"
X0, Y0 = 600_000, 9_250_000  # inside UTM 22S, near São Félix do Xingu
FIXTURE = Path(__file__).parent / "fixtures" / "tiny"


def sq(x, y, w, h=None):
    return box(X0 + x, Y0 + y, X0 + x + w, Y0 + y + (h or w))


def spec(kind, **kw):
    return LayerSpec(name=f"test_{kind}", kind=kind, path=Path(f"memory_{kind}.geojson"), source="unit test",
                     data_status=kw.pop("data_status", "real"), id_fields=("fid_src",), **kw)


def layer(kind, rows, crs=UTM, **kw):
    g = gpd.GeoDataFrame([{k: v for k, v in r.items() if k != "geometry"} for r in rows],
                         geometry=[r["geometry"] for r in rows], crs=crs)
    return prepare(g, spec(kind, **kw))


RANCH = sq(0, 0, 1000)  # 1 km x 1 km = 100 ha


def ranches(*geoms, ids=None):
    return layer("ranches", [{"fid_src": (ids or [f"R{i + 1:04d}" for i in range(len(geoms))])[i], "geometry": g}
                             for i, g in enumerate(geoms)], data_status="synthetic")


def defor(*items):
    """items: (year, geometry) pairs; ids D0, D1, ..."""
    return layer("deforestation", [{"fid_src": f"D{i}", "year": y, "geometry": g} for i, (y, g) in enumerate(items)])


def one(records, rid="R0001"):
    r = next(x for x in records if x["ranch_id"] == rid)
    return r


# ---- intersection and area -----------------------------------------------------------------
def test_intersection_area_is_exact():
    rec = one(assess(ranches(RANCH), defor((2023, sq(500, 0, 1000))), None, None, None, [], GeoConfig()))
    assert rec["geometry"]["area_ha"] == pytest.approx(100.0)
    assert rec["post_cutoff_deforestation_area_hectares"] == pytest.approx(50.0)
    assert rec["intersecting_deforestation_polygon_ids"] == ["D0"]
    assert rec["legal"]["eudr_cutoff_indicator"] == "post_cutoff_clearing_detected"
    assert rec["scientific_risk"]["class"] == "high"


def test_overlapping_polygons_are_not_double_counted():
    rec = one(assess(ranches(RANCH), defor((2023, sq(0, 0, 600)), (2024, sq(300, 0, 600))), None, None, None, [], GeoConfig()))
    assert rec["deforestation"]["post_cutoff_ha"] == pytest.approx(0.9 * 60, rel=1e-6)  # union 900 m x 600 m


def test_crs_transformation_preserves_area():
    g = gpd.GeoSeries([RANCH, sq(500, 0, 1000)], crs=UTM).to_crs(4326)
    r = layer("ranches", [{"fid_src": "R0001", "geometry": g.iloc[0]}], crs=4326, data_status="synthetic")
    d = layer("deforestation", [{"fid_src": "D0", "year": 2023, "geometry": g.iloc[1]}], crs=4326)
    rec = one(assess(r, d, None, None, None, [], GeoConfig()))
    assert rec["geometry"]["area_ha"] == pytest.approx(100.0, rel=1e-4)
    assert rec["post_cutoff_deforestation_area_hectares"] == pytest.approx(50.0, rel=1e-4)
    assert rec["geometry"]["source_crs"] == "EPSG:4326"


def test_missing_crs_is_refused_unless_assumed():
    g = gpd.GeoDataFrame([{"fid_src": "R0001"}], geometry=[RANCH])
    with pytest.raises(LayerError, match="no CRS"):
        prepare(g, spec("ranches"))
    lay = prepare(g, spec("ranches", assume_crs=UTM))
    assert lay.log[0]["code"] == "crs_assumed"


def test_geographic_coordinates_out_of_range_are_refused():
    g = gpd.GeoDataFrame([{"fid_src": "R0001"}], geometry=[box(500, 0, 510, 10)], crs=4326)
    with pytest.raises(LayerError, match="outside lon/lat"):
        prepare(g, spec("ranches"))


# ---- missing, empty and invalid geometry ----------------------------------------------------
def test_invalid_geometry_is_repaired_and_logged():
    bowtie = Polygon([(X0, Y0), (X0 + 1000, Y0 + 1000), (X0 + 1000, Y0), (X0, Y0 + 1000), (X0, Y0)])
    r = ranches(bowtie)
    assert r.gdf["geometry_status"].iloc[0] == "repaired"
    assert r.log[0]["code"] == "repaired" and "Self-intersection" in r.log[0]["message"]
    rec = one(assess(r, defor((2023, RANCH)), None, None, None, [], GeoConfig()))
    assert rec["geometry"]["area_ha"] == pytest.approx(50.0)  # two triangles
    assert rec["warnings"]


@pytest.mark.parametrize("geom,status", [(None, "missing"), (Polygon(), "empty"), (Point(X0, Y0), "rejected")])
def test_unusable_ranch_geometry_gives_nulls_not_zeros(geom, status):
    r = ranches(geom)
    rec = one(assess(r, defor((2023, RANCH)), None, None, None, [], GeoConfig()))
    assert rec["geometry"]["status"] == status
    assert rec["geometry"]["area_ha"] is None
    assert rec["post_cutoff_deforestation_area_hectares"] is None
    assert rec["deforestation"]["pre_cutoff_ha"] is None
    assert rec["legal"]["eudr_cutoff_indicator"] == "undetermined"
    assert rec["scientific_risk"]["class"] == "unknown"


def test_undeclared_coverage_is_reported():
    rec = one(assess(ranches(RANCH), defor((2023, sq(0, 0, 100))), None, None, None, [], GeoConfig()))
    assert rec["deforestation"]["coverage"] == "undeclared"
    assert any("declares no coverage" in w for w in rec["warnings"])


def test_missing_layer_gives_nulls_not_zeros():
    rec = one(assess(ranches(RANCH), None, None, None, None, [], GeoConfig()))
    assert rec["post_cutoff_deforestation_area_hectares"] is None
    assert rec["indigenous_territory"] is None and rec["protected_area"] is None
    assert any("no deforestation layer" in w for w in rec["warnings"])


def bbox_of(geom):
    return tuple(gpd.GeoSeries([geom], crs=UTM).to_crs(4326).total_bounds)


def test_ranch_outside_layer_coverage_is_null():
    far = sq(500_000, 0, 1000)
    d = layer("deforestation", [{"fid_src": "D0", "year": 2023, "geometry": sq(0, 0, 500)}], coverage_bbox=bbox_of(sq(-100, -100, 5000)))
    recs = assess(ranches(RANCH, far), d, None, None, None, [], GeoConfig())
    assert one(recs, "R0001")["deforestation"]["coverage"] == "full"
    assert one(recs, "R0002")["deforestation"]["coverage"] == "none"
    assert one(recs, "R0002")["post_cutoff_deforestation_area_hectares"] is None


def test_partial_coverage_is_flagged():
    d = layer("deforestation", [{"fid_src": "D0", "year": 2023, "geometry": sq(0, 0, 200)}],
              coverage_bbox=bbox_of(sq(-100, -100, 600)))
    rec = one(assess(ranches(RANCH), d, None, None, None, [], GeoConfig()))
    assert rec["deforestation"]["coverage"] == "partial"
    assert rec["legal"]["eudr_cutoff_indicator"] == "post_cutoff_clearing_detected"
    assert any("lower bounds" in w for w in rec["warnings"])


# ---- cut-off handling ----------------------------------------------------------------------
@pytest.mark.parametrize("attrs,expect", [
    ({"year": 2020}, "pre_cutoff"),            # Aug 2019 - Jul 2020
    ({"year": 2021}, "straddles_cutoff"),      # Aug 2020 - Jul 2021
    ({"year": 2022}, "post_cutoff"),
    ({"year": 2005}, "pre_cutoff"),            # accumulated mask
    ({"year": None}, "unknown_date"),
    ({"date": "2021-03-01"}, "post_cutoff"),
    ({"date": "2020-12-31"}, "pre_cutoff"),
    ({"year": 2021, "image_date": "2020-11-20"}, "pre_cutoff"),  # seen cleared before the cut-off
])
def test_cutoff_classes(attrs, expect):
    assert cutoff_class(*clearing_period(attrs), date(2020, 12, 31)) == expect


def test_cutoff_is_configurable():
    later = date(2021, 12, 31)
    assert cutoff_class(*clearing_period({"year": 2021}), later) == "pre_cutoff"
    assert cutoff_class(*clearing_period({"year": 2022}), later) == "straddles_cutoff"


def test_four_deforestation_classes_are_reported_separately():
    d = defor((2015, sq(0, 0, 1000, 100)), (2021, sq(0, 100, 1000, 100)), (2023, sq(0, 200, 1000, 100)),
              (None, sq(0, 300, 1000, 100)), (2005, sq(0, 400, 1000, 100)))
    rec = one(assess(ranches(RANCH), d, None, None, None, [], GeoConfig()))
    defo = rec["deforestation"]
    assert defo["pre_cutoff_ha"] == pytest.approx(20)        # 2015 + accumulated
    assert defo["pre_cutoff_undated_ha"] == pytest.approx(10)
    assert defo["straddles_cutoff_ha"] == pytest.approx(10)
    assert defo["post_cutoff_ha"] == pytest.approx(10)
    assert defo["unknown_date_ha"] == pytest.approx(10)
    assert defo["intersecting_polygon_ids"]["straddles_cutoff"] == ["D1"]
    assert rec["legal"]["eudr_cutoff_indicator"] == "post_cutoff_clearing_detected"


def test_straddling_only_is_undetermined_legally_but_risky_scientifically():
    rec = one(assess(ranches(RANCH), defor((2021, sq(0, 0, 1000, 100))), None, None, None, [], GeoConfig()))
    assert rec["legal"]["eudr_cutoff_indicator"] == "undetermined"
    assert rec["scientific_risk"]["class"] == "watch"  # 10 ha >= 6.25
    strict = one(assess(ranches(RANCH), defor((2021, sq(0, 0, 1000, 100))), None, None, None, [], GeoConfig(straddling_is_risk=False)))
    assert strict["scientific_risk"]["class"] == "low"


def test_sliver_below_tolerance_does_not_trip_the_indicator():
    rec = one(assess(ranches(RANCH), defor((2023, sq(999, 0, 10, 1000))), None, None, None, [], GeoConfig()))
    assert rec["post_cutoff_deforestation_area_hectares"] == pytest.approx(0.1)
    assert rec["legal"]["eudr_cutoff_indicator"] == "no_post_cutoff_clearing_detected"


# ---- proximity -----------------------------------------------------------------------------
def test_proximity_is_not_a_violation():
    rec = one(assess(ranches(RANCH), defor((2023, sq(2000, 0, 500))), None, None, None, [], GeoConfig()))
    d = rec["deforestation"]
    assert d["post_cutoff_ha"] == 0 and rec["intersecting_deforestation_polygon_ids"] == []
    assert d["nearest_post_cutoff_km"] == pytest.approx(1.0)
    assert d["post_cutoff_nearby_not_intersecting"] == 1
    assert rec["legal"]["eudr_cutoff_indicator"] == "no_post_cutoff_clearing_detected"
    assert rec["scientific_risk"]["class"] == "watch"
    assert any("proximity only" in r for r in rec["scientific_risk"]["reasons"])


# ---- protected areas -----------------------------------------------------------------------
def test_indigenous_and_protected_shares_with_legal_context():
    ti = layer("indigenous", [{"fid_src": "T1", "terrai_nom": "Kayapó", "fase_ti": "Regularizada", "geometry": sq(0, 0, 1000, 250)}])
    apa = layer("protected", [{"fid_src": "U1", "nome": "AREA DE PROTECAO AMBIENTAL TRIUNFO DO XINGU", "grupo": "US",
                               "categoria": "Área de Proteção Ambiental", "geometry": sq(-5000, -5000, 20000)}])
    rec = one(assess(ranches(RANCH), defor(), ti, apa, None, [], GeoConfig()))
    assert rec["indigenous_territory"]["overlap_ha"] == pytest.approx(25)
    assert rec["indigenous_territory"]["overlap_share"] == pytest.approx(0.25)
    assert rec["indigenous_territory"]["areas"][0]["recognised"] is True
    assert rec["protected_area"]["overlap_share"] == pytest.approx(1.0)
    assert rec["protected_area"]["areas"][0]["name"] == "APA Triunfo do Xingu"
    assert "not a violation" in rec["protected_area"]["areas"][0]["legal_context"]
    assert rec["legal"]["recognised_indigenous_land_overlap"] is True
    assert rec["legal"]["strict_protection_overlap"] is False


def test_apa_overlap_alone_is_not_high_risk():
    apa = layer("protected", [{"fid_src": "U1", "nome": "APA X", "grupo": "US", "geometry": sq(-5000, -5000, 20000)}])
    rec = one(assess(ranches(RANCH), defor((2015, sq(0, 0, 1000))), None, apa, None, [], GeoConfig()))
    assert rec["scientific_risk"]["class"] == "low"


def test_strict_protection_is_flagged():
    pi = layer("protected", [{"fid_src": "U2", "nome": "Parque X", "grupo": "PI", "geometry": sq(0, 0, 100)}])
    rec = one(assess(ranches(RANCH), defor(), None, pi, None, [], GeoConfig()))
    assert rec["legal"]["strict_protection_overlap"] is True
    assert rec["scientific_risk"]["class"] == "watch"


# ---- embargoes -----------------------------------------------------------------------------
def test_embargo_states_are_distinct():
    as_of = date(2025, 12, 31)
    base = {"ranch_id": "R0001", "source": "simulated", "data_status": "synthetic"}
    active = embargo_status([{**base, "embargo_id": "EMB-0001", "start_date": "2023-04-01", "end_date": None, "status": "active"}], as_of)
    hist = embargo_status([{**base, "embargo_id": "EMB-0002", "start_date": "2022-01-01", "end_date": "2023-01-01", "status": "active"}], as_of)
    unver = embargo_status([{**base, "embargo_id": "EMB-0003", "start_date": "2023-01-01", "end_date": None, "status": "unverified"}], as_of)
    future = embargo_status([{**base, "embargo_id": "EMB-0004", "start_date": "2026-06-01", "end_date": None, "status": "active"}], as_of)
    assert [active["status"], hist["status"], unver["status"], future["status"]] == ["active", "historical", "unverified", "none"]
    assert active["simulated"] is True
    real = embargo_status([{**base, "data_status": "real", "embargo_id": "EMB-0005", "start_date": "2023-01-01", "end_date": None, "status": "active"}], as_of)
    assert real["simulated"] is False


def test_simulated_embargo_is_labelled_in_the_record():
    emb = [{"embargo_id": "EMB-0001", "ranch_id": "R0001", "start_date": "2023-04-01", "end_date": None, "status": "active",
            "source": "simulated embargo (not an Ibama record)", "data_status": "synthetic"}]
    rec = one(assess(ranches(RANCH), defor(), None, None, None, emb, GeoConfig()))
    assert rec["embargo"]["status"] == "active" and rec["legal"]["embargo_simulated"] is True
    assert any("simulated" in w for w in rec["warnings"])


def test_nearest_slaughterhouse_distance():
    fac = layer("facilities", [{"fid_src": "S:SIF_01", "geometry": Point(X0 + 3000, Y0 + 500)}])
    rec = one(assess(ranches(RANCH), defor(), None, None, fac, [], GeoConfig()))
    assert rec["nearest_slaughterhouse_km"] == pytest.approx(2.0)


# ---- end-to-end on the synthetic fixture: schema, provenance, recalculation -----------------
@pytest.fixture
def dataset(tmp_path):
    d = tmp_path / "tiny"
    shutil.copytree(FIXTURE, d, ignore=shutil.ignore_patterns("geo_*"))
    return d


def test_pipeline_outputs_validate_and_report_provenance(dataset):
    meta = run(dataset)
    assert meta["recalculated"] and meta["ranches"] == 48
    lines = (dataset / "derived" / "geo_evidence.jsonl").read_text(encoding="utf-8").splitlines()
    for l in lines:
        GeoEvidence.model_validate_json(l)
    prov = json.loads((dataset / "derived" / "geo_provenance.json").read_text(encoding="utf-8"))
    assert prov["real_inputs"] == [] and "deforestation" in prov["synthetic_inputs"]
    assert prov["fields"]["post_cutoff_deforestation_area_hectares"]["uses_synthetic"] is True
    fc = json.loads((dataset / "derived" / "geo_evidence.geojson").read_text(encoding="utf-8"))
    assert len(fc["features"]) == 48 and {"eudr_indicator", "risk_class", "post_cutoff_ha"} <= fc["features"][0]["properties"].keys()


def test_changing_a_source_triggers_recalculation(dataset):
    first = run(dataset)
    again = run(dataset)
    assert first["recalculated"] and not again["recalculated"]
    assert again["fingerprint"] == first["fingerprint"]
    before = (dataset / "derived" / "geo_evidence.jsonl").read_bytes()

    src = dataset / "environment" / "synthetic_deforestation.geojson"
    fc = json.loads(src.read_text(encoding="utf-8"))
    target = fc["features"][0]
    target["properties"]["year"] = 2010  # re-date one clearing to before the cut-off
    src.write_text(json.dumps(fc), encoding="utf-8")

    third = run(dataset)
    assert third["recalculated"] and third["fingerprint"] != first["fingerprint"]
    assert (dataset / "derived" / "geo_evidence.jsonl").read_bytes() != before


def test_changing_the_cutoff_triggers_recalculation(dataset):
    a = run(dataset)
    b = run(dataset, cfg=GeoConfig(cutoff=date(2021, 12, 31)))
    assert b["recalculated"] and a["fingerprint"] != b["fingerprint"]


# ---- real layers: agrees with the landscape stage the published demo was built on ----------
EVAL = Path(__file__).resolve().parents[2] / "data" / "synthetic" / "evaluation"


@pytest.mark.skipif(not (EVAL / "manifest.json").is_file() or not (EVAL / "inputs" / "ranch_boundaries.geojson").is_file(),
                    reason="generate the evaluation dataset first")
def test_real_layers_match_landscape_stage(tmp_path):
    from rastro.config import DERIVED, RAW
    if not (RAW / "yearly_deforestation.geojson").is_file() or not (DERIVED / "landscape.gpkg").is_file():
        pytest.skip("real layers not fetched")
    d = tmp_path / "eval"
    shutil.copytree(EVAL, d, ignore=shutil.ignore_patterns("geo_*", "truth"))
    run(d)
    ev = {json.loads(l)["ranch_id"]: json.loads(l) for l in (d / "derived" / "geo_evidence.jsonl").read_text(encoding="utf-8").splitlines()}
    g = gpd.read_file(DERIVED / "landscape.gpkg", layer="ranches")
    post = [(ev[i]["deforestation"]["post_cutoff_ha"] + ev[i]["deforestation"]["straddles_cutoff_ha"], old)
            for i, old in zip(g["id"], g["defor_post2020_ha"])]
    assert sum(n for n, _ in post) == pytest.approx(sum(o for _, o in post), rel=0.002)
    assert max(abs(n - o) for n, o in post) < 5  # ha; the stages repair invalid PRODES polygons differently
    ti = [(ev[i]["indigenous_territory"]["overlap_ha"], old) for i, old in zip(g["id"], g["ti_overlap_ha"])]
    assert max(abs(n - o) for n, o in ti) < 0.1
    assert all(r["geometry"]["data_status"] == "synthetic" for r in ev.values())
    assert all(r["data_status"]["deforestation"] == "real" for r in ev.values())
