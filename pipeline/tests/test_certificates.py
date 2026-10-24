"""RFC 8785 canonicalisation and the evidence bundle commitment."""
import hashlib
import json
import shutil
from pathlib import Path

import pytest

from rastro.certificates.bundle import EligibilityError, build_bundle, commit, evidence_hash
from rastro.certificates.jcs import canonicalize

FIXTURE = Path(__file__).parent / "fixtures" / "tiny"


# ---- RFC 8785 vectors ----------------------------------------------------------------------------
@pytest.mark.parametrize("value,expect", [
    (333333333.33333329, "333333333.3333333"),
    (1e30, "1e+30"),
    (4.50, "4.5"),
    (2e-3, "0.002"),
    (0.000000000000000000000000001, "1e-27"),
    (1e-7, "1e-7"),
    (0.000001, "0.000001"),
    (1e21, "1e+21"),
    (1e20, "100000000000000000000"),
    (-0.0, "0"),
    (5.0, "5"),
    (-1.5, "-1.5"),
])
def test_numbers(value, expect):
    assert canonicalize(value).decode() == expect


def test_key_order_is_utf16_and_strings_escape_minimally():
    obj = {"€": "Euro Sign", "\r": "Carriage Return", "דּ": "Hebrew Letter Dalet With Dagesh", "1": "One",
           "\U0001F600": "Emoji: Grinning Face", "\u0080": "Control", "ö": "Latin Small Letter O With Diaeresis"}
    keys = list(json.loads(canonicalize(obj).decode()))
    assert keys == ["\r", "1", "\u0080", "ö", "€", "\U0001F600", "דּ"]  # RFC 8785 section 3.2.3 example
    assert canonicalize({"a": "é\n\"\u0001"}) == '{"a":"é\\n\\"\\u0001"}'.encode("utf-8")


RFC_INPUT = Path(__file__).parent / "fixtures" / "rfc8785_input.json"
RFC_OUTPUT = Path(__file__).parent / "fixtures" / "rfc8785_output.json"


def test_rfc_example_bytes():
    """RFC 8785 section 3.2.2: the input and expected output are stored byte for byte."""
    assert canonicalize(json.loads(RFC_INPUT.read_text(encoding="utf-8"))) == RFC_OUTPUT.read_bytes()


def test_rejects_non_json_values():
    for bad in (float("nan"), float("inf"), {1: "x"}, object(), 2**60):
        with pytest.raises((ValueError, TypeError)):
            canonicalize(bad)


def test_equal_content_gives_equal_hash_regardless_of_key_order():
    a = {"b": 1, "a": [1.0, "x"], "c": {"z": None, "y": True}}
    b = json.loads(json.dumps({"c": {"y": True, "z": None}, "a": [1, "x"], "b": 1.0}))
    assert evidence_hash(a) == evidence_hash(b)
    assert evidence_hash(a) != evidence_hash({**a, "b": 2})


# ---- bundle on the fixture -----------------------------------------------------------------------
@pytest.fixture(scope="module")
def ds(tmp_path_factory):
    from rastro.geospatial.run import run as run_geo
    from rastro.risk.run import run as run_risk
    d = tmp_path_factory.mktemp("cert") / "tiny"
    shutil.copytree(FIXTURE, d, ignore=shutil.ignore_patterns("geo_*", "lineage_*", "risk", "reports", "truth"))
    run_geo(d)
    run_risk(d)
    return d


def decisions(ds):
    return [json.loads(l) for l in (ds / "derived" / "risk" / "decisions.jsonl").read_text(encoding="utf-8").splitlines()]


def test_pass_lot_gets_a_deterministic_bundle(ds):
    sid = next(d["shipment_id"] for d in decisions(ds) if d["outcome"] == "PASS")
    a, b = build_bundle(ds, sid), build_bundle(ds, sid)
    assert canonicalize(a) == canonicalize(b) and evidence_hash(a) == evidence_hash(b)
    assert a["decision"]["outcome"] == "PASS" and a["shipment"]["commitment"] == commit(sid)
    assert evidence_hash(a) == "0x" + hashlib.sha256(canonicalize(a)).hexdigest()


def test_tampering_changes_the_hash(ds):
    sid = next(d["shipment_id"] for d in decisions(ds) if d["outcome"] == "PASS")
    b = build_bundle(ds, sid)
    t = json.loads(json.dumps(b))
    t["lineage"]["coverage_pct"] = 99.0 if b["lineage"]["coverage_pct"] != 99.0 else 98.0
    assert evidence_hash(t) != evidence_hash(b)


@pytest.mark.parametrize("outcome", ["FLAGGED", "REVIEW"])
def test_flagged_and_review_lots_are_refused(ds, outcome):
    sid = next((d["shipment_id"] for d in decisions(ds) if d["outcome"] == outcome), None)
    if sid is None:
        pytest.skip(f"no {outcome} lot in the fixture")
    with pytest.raises(EligibilityError, match=outcome):
        build_bundle(ds, sid)


def test_unknown_shipment_is_refused(ds):
    with pytest.raises(EligibilityError):
        build_bundle(ds, "SHP-D-999999")
