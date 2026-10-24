"""Red-team knobs: each changes the world as intended and the world still validates."""
from datetime import date
from statistics import median

from rastro.evaluation.scenarios import BY_ID, SCENARIOS
from rastro.synth.generate import PRESETS, generate
from rastro.validation import validate

TINY = PRESETS["tiny"]


def world(tmp_path, **kw):
    return generate(TINY.with_(**kw), tmp_path / "w", "tiny")


def labels(t, *names):
    return {l["ranch_id"] for l in t["ranch_labels"] if l["label"] in names}


def holds(t, ranches):
    """Days between a transfer lot arriving at a ranch and leaving it again (truth lineage)."""
    lot = {l["lot_id"]: l for l in t["lots"]}
    out = []
    for a in t["lot_allocations"]:
        src = lot.get(a["from_lot_id"])
        if a["channel"] == "gta" and src and src["kind"] == "transfer" and src["location_id"] in ranches:
            out.append((date.fromisoformat(a["date"]) - date.fromisoformat(src["created_date"])).days)
    return out


def test_launderer_hold_is_configurable(tmp_path):
    # The hold is a target before a lot becomes due; sales still take the oldest eligible lot,
    # so the effect is tested on the median, not on every lot.
    _, t0, _ = world(tmp_path / "a")
    _, t, m = world(tmp_path / "b", launderer_hold=(55, 66))
    assert median(holds(t, labels(t, "launderer"))) > median(holds(t0, labels(t0, "launderer"))) + 20
    assert validate(t, m).ok


def test_split_lots(tmp_path):
    _, t, m = world(tmp_path, launderer_split=(5, 26))
    laund = labels(t, "launderer", "phantom_births")
    heads = [g["head_count"] for g in t["gta_movements"] if g["origin_id"] in laund]
    assert heads and max(heads) <= 25
    assert validate(t, m).ok


def test_cover_buying_mixes_clean_cattle_into_launderers(tmp_path):
    _, t0, _ = world(tmp_path / "a")
    _, t1, m = world(tmp_path / "b", cover_buying=0.5)
    clean = labels(t1, "honest")
    laund = labels(t1, "launderer", "phantom_births")

    def clean_into(t):
        return sum(g["head_count"] for g in t["gta_movements"] if g["origin_id"] in clean and g["destination_id"] in laund)
    assert clean_into(t1) > clean_into(t0)
    assert validate(t1, m).ok


def test_concealed_phantom_keeps_births_inside_the_bound(tmp_path):
    _, t, m = world(tmp_path, conceal_phantom=True, phantom_declared_cows=60)  # small enough that some head needs cold permits
    phantom = labels(t, "phantom_births")
    assert all(r["breeding_cows_declared"] == 60 for r in t["ranches"] if r["ranch_id"] in phantom)
    assert not [r for r in t["ledger_refusals"] if r["reason"] == "BirthsExceedBiology" and r["ranch_id"] in phantom]
    cold = [x for x in t["movement_labels"] if "cold_permit" in x["scenario_tags"]]
    assert cold and all(next(g for g in t["gta_movements"] if g["gta_id"] == c["gta_id"])["origin_type"] == "external_supplier" for c in cold)
    assert validate(t, m).ok


def test_missing_records(tmp_path):
    _, t0, _ = world(tmp_path / "a")
    _, t, m = world(tmp_path / "b", drop_gta_share=0.1)
    assert t["missing_records"]
    assert len(t["gta_movements"]) == len(t0["gta_movements"]) - len(t["missing_records"])
    assert {a["scenario"] for a in t["anomalies"]} <= set(m["config"]["scenarios"]) | {"records_missing"}
    assert validate(t, m).ok


def test_rapid_legitimate_traders(tmp_path):
    def traders(t):
        return {l["ranch_id"] for l in t["ranch_labels"] if "honest_fast_trader" in l["case_tags"]}
    _, t0, _ = world(tmp_path / "a")
    _, t, m = world(tmp_path / "b", trader_hold=(1, 10))
    assert median(holds(t, traders(t))) < median(holds(t0, traders(t0)))
    assert validate(t, m).ok


def test_registry_has_no_expected_answers():
    for s in SCENARIOS:
        assert set(vars(s)) == {"id", "title", "tests", "overrides"}
    assert BY_ID["S00-clean"].config().scenarios == frozenset()
    assert BY_ID["S05-redteam"].config().two_hop is True
    assert all(s.config().seed == 101 for s in SCENARIOS)
