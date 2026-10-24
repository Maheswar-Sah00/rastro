"""Canonical data model, synthetic generator and validation."""
import copy
import json
from pathlib import Path

import pytest

from rastro.config import DERIVED
from rastro.synth.generate import PRESETS, generate
from rastro.validation import load, validate

FIXTURE = Path(__file__).parent / "fixtures" / "tiny"


@pytest.fixture(scope="module")
def tiny():
    manifest, tables = load(FIXTURE)
    return manifest, tables


def errors_after(tiny, mutate):
    manifest, tables = tiny
    t = copy.deepcopy(tables)
    mutate(t)
    return validate(t, manifest).errors


# ---- fixture and reproducibility ----------------------------------------------------------
def test_committed_fixture_is_valid(tiny):
    rep = validate(tiny[1], tiny[0])
    assert rep.ok, rep.errors


def test_generator_is_deterministic(tmp_path):
    _, _, m1 = generate(PRESETS["tiny"], tmp_path / "a", "tiny")
    _, _, m2 = generate(PRESETS["tiny"], tmp_path / "b", "tiny")
    assert m1["logical_digest"] == m2["logical_digest"]
    for name, entry in m1["tables"].items():
        assert (tmp_path / "a" / entry["path"]).read_bytes() == (tmp_path / "b" / entry["path"]).read_bytes(), name


def test_regenerating_matches_committed_fixture(tmp_path):
    _, _, m = generate(PRESETS["tiny"], tmp_path / "t", "tiny")
    assert m["logical_digest"] == json.loads((FIXTURE / "manifest.json").read_text(encoding="utf-8"))["logical_digest"]


def test_seed_changes_output(tmp_path):
    _, _, m1 = generate(PRESETS["tiny"], tmp_path / "a", "tiny")
    _, _, m2 = generate(PRESETS["tiny"].with_(seed=22), tmp_path / "b", "tiny")
    assert m1["logical_digest"] != m2["logical_digest"]


def test_size_is_configuration_not_code(tmp_path):
    _, t, _ = generate(PRESETS["tiny"].with_(n_ranches=30, months=12), tmp_path / "s", "tiny")
    assert sum(r["entity_type"] == "ranch" for r in t["ranches"]) == 30
    assert {r["observation_date"][:4] for r in t["herd_inventory"]} == {"2023"}


def test_baseline_has_no_impossible_records(tmp_path):
    _, t, m = generate(PRESETS["tiny-baseline"], tmp_path / "b", "tiny-baseline")
    assert t["ledger_refusals"] == [] and t["anomalies"] == [] and t["smuggled_transfers"] == []
    assert validate(t, m).ok
    assert {r["label"] for r in t["ranch_labels"]} <= {"honest", "dirty_source", "unknown"}


def test_deliberate_anomalies_are_all_attributed(tiny):
    manifest, t = tiny
    assert manifest["deliberate_anomalies"], "the tiny fixture should exercise the red-team scenarios"
    assert {a["kind"] for a in t["anomalies"]} == {"BirthsExceedBiology", "InsufficientHerd", "OriginEmbargoed"}
    assert all(a["scenario"] in manifest["config"]["scenarios"] for a in t["anomalies"])


def test_truth_is_kept_out_of_detector_inputs(tiny):
    manifest, t = tiny
    for name, entry in manifest["tables"].items():
        if entry["partition"] == "truth":
            assert not entry["detector_visible"]
    banned = {"truth", "label", "dirty", "scenario", "scenario_tags"}
    for name in ("ranches", "gta_movements", "birth_declarations", "shipments"):
        for row in t[name]:
            assert not banned & row.keys(), name


# ---- conservation -------------------------------------------------------------------------
def test_inventory_obeys_conservation(tiny):
    for r in tiny[1]["herd_inventory"]:
        assert r["closing_head"] == r["opening_head"] + r["births"] + r["arrivals"] - r["departures"] - r["deaths"] - r["other_removals"]
        assert r["closing_head"] >= 0


def test_broken_closing_balance_is_rejected(tiny):
    def bump(t):
        t["herd_inventory"][5]["closing_head"] += 1
    errs = errors_after(tiny, bump)
    assert "schema" in errs and "conservation" in errs


def test_negative_inventory_is_rejected(tiny):
    def negative(t):
        row = t["herd_inventory"][0]
        row["departures"] += row["closing_head"] + 1
        row["closing_head"] = -1
    errs = errors_after(tiny, negative)
    assert any("negative inventory" in e for e in errs["conservation"])


def test_movement_cannot_create_cattle(tiny):
    """Inflating a permit beyond what the origin holds is refused and unexplained."""
    def inflate(t):
        g = next(g for g in t["gta_movements"] if g["permit_status"] == "issued" and g["destination_type"] == "ranch"
                 and g["origin_type"] == "ranch")
        g["head_count"] += 100_000
    errs = errors_after(tiny, inflate)
    assert "ledger_replay" in errs and "lot_conservation" in errs


def test_unplanted_refusal_fails_validation(tiny):
    manifest, tables = tiny
    m = copy.deepcopy(manifest)
    m["config"]["scenarios"] = []
    assert "anomalies" in validate(tables, m).errors


# ---- identifiers, dates, foreign keys -----------------------------------------------------
def test_duplicate_identifier_is_rejected(tiny):
    errs = errors_after(tiny, lambda t: t["gta_movements"].append(dict(t["gta_movements"][0])))
    assert any("duplicate gta_id" in e for e in errs["unique_ids"])


def test_duplicate_ranch_is_rejected(tiny):
    errs = errors_after(tiny, lambda t: t["ranches"].append(dict(t["ranches"][3])))
    assert any("duplicate ranch_id" in e for e in errs["unique_ids"])


@pytest.mark.parametrize("bad", ["2023-02-30", "2023-13-01", "yesterday", "2019-05-01"])
def test_invalid_dates_are_rejected(tiny, bad):
    def set_date(t):
        t["gta_movements"][0]["movement_date"] = bad
    assert "dates" in errors_after(tiny, set_date)


def test_issue_after_movement_is_rejected(tiny):
    def swap(t):
        g = t["gta_movements"][0]
        g["issue_date"] = "2030-01-01"
    assert "schema" in errors_after(tiny, swap)


@pytest.mark.parametrize("table,field,value", [
    ("gta_movements", "origin_id", "R9999"),
    ("gta_movements", "destination_id", "S:SIF_99"),
    ("birth_declarations", "ranch_id", "R9998"),
    ("embargoes", "ranch_id", "R9997"),
])
def test_invalid_foreign_keys_are_rejected(tiny, table, field, value):
    def set_fk(t):
        t[table][0][field] = value
    assert "foreign_keys" in errors_after(tiny, set_fk)


def test_shipment_cannot_reuse_a_gta(tiny):
    def reuse(t):
        a, b = t["shipments"][0], t["shipments"][1]
        b["gta_ids"] = b["gta_ids"] + [a["gta_ids"][0]]
    assert "unique_ids" in errors_after(tiny, reuse)


# ---- full-size fixture (needs the real landscape: pipeline/data/derived/landscape.gpkg) ----
needs_landscape = pytest.mark.skipif(not (DERIVED / "landscape.gpkg").is_file(), reason="run landscape.py first")


@needs_landscape
def test_evaluation_preset_sizes_and_published_world(tmp_path):
    from rastro.synth.landscape import load_real
    from rastro.synth.world import legacy_world_json, simulate

    w = simulate(PRESETS["evaluation"], load_real())
    assert sum(1 for i in w.ranches if i.startswith("R")) == 409
    assert len(w.gtas) == 10_844
    world = DERIVED / "world.json"
    if world.is_file():  # same bytes detect.py was run on
        assert json.dumps(legacy_world_json(w), default=str).encode() == world.read_bytes()
