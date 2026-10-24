"""Integrity of the published bundle (web/public/data): what judges can re-check must hold."""
import hashlib
import json
from pathlib import Path

import pytest

DATA = Path(__file__).resolve().parents[2] / "web" / "public" / "data"
SALT = "rastro-demo-salt-v1|"  # detect.py SALT


def load(name):
    p = DATA / name
    if not p.is_file():
        pytest.skip(f"{name} not generated (run pipeline/run_all.py)")
    return json.loads(p.read_text(encoding="utf-8"))


def test_evidence_files_are_content_addressed():
    files = sorted((DATA / "evidence").glob("*.json"))
    if not files:
        pytest.skip("no evidence bundle")
    for f in files:
        assert hashlib.sha256(f.read_bytes()).hexdigest() == f.stem, f.name


def test_every_anchored_hash_has_its_evidence_file():
    ranches = load("ranches.geojson")["features"]
    shipments = load("shipments.json")
    hashes = [r["properties"]["risk"]["evidence_hash"] for r in ranches]
    hashes += [s["certificate"]["evidence_hash"] for s in shipments if s.get("certificate")]
    missing = [h for h in hashes if not (DATA / "evidence" / f"{h[2:]}.json").is_file()]
    assert not missing, f"{len(missing)} anchored hashes without evidence, e.g. {missing[:3]}"


def test_onchain_ids_are_salted_sha256_of_the_public_id():
    for r in load("ranches.geojson")["features"]:
        p = r["properties"]
        assert p["onchain_id"] == "0x" + hashlib.sha256((SALT + p["id"]).encode()).hexdigest()


def test_identifiers_are_unique():
    ranch_ids = [r["properties"]["id"] for r in load("ranches.geojson")["features"]]
    gtas = [m["gta"] for m in load("movements.json")]
    ships = [s["id"] for s in load("shipments.json")]
    for ids in (ranch_ids, gtas, ships):
        assert len(ids) == len(set(ids))


def test_metrics_counts_match_files():
    m = load("metrics.json")["counts"]
    assert m["ranches"] == len(load("ranches.geojson")["features"])
    assert m["movements"] == len(load("movements.json"))
    assert m["shipments"] == len(load("shipments.json"))


def test_onchain_replay_conserved_herd():
    o = load("onchain.json")
    t = o["totals"]
    assert o["conserved"] is True
    assert t["ranchHead"] == t["initialHead"] + t["births"] - t["deaths"] - t["headToSinks"]
