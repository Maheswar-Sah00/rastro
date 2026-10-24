"""Multi-hop lot lineage: engine on hand-built graphs, service on the tiny fixture."""
import random
import shutil
from datetime import date
from pathlib import Path

import pytest

from rastro.geospatial.run import run as run_geo
from rastro.lineage.engine import LineageEngine, Movement
from rastro.lineage.service import LineageService
from rastro.lineage.trace import main as trace_cli
from rastro.schemas.lineage import LineageTrace

FIXTURE = Path(__file__).parent / "fixtures" / "tiny"
D = date(2024, 1, 1)


def d(n):
    return date.fromordinal(D.toordinal() + n)


def engine(opening: dict, policy="fifo", sinks=("S:SIF_01", "P:BARCARENA"), external=()):
    ranches = {r: {"kind": "external_supplier" if r in external else "ranch", "opening_head": h, "registered_on": D} for r, h in opening.items()}
    return LineageEngine(ranches, set(sinks), policy)


def mv(gid, a, b, day, head, **kw):
    return Movement(gid, a, b, d(day), head, **kw)


def comp(e, lot):
    return {k: round(v[0], 6) for k, v in e.moved[lot].comp.items()}


def assert_conserved(e):
    c = e.conservation()
    assert c["balanced"], c


# ---- topologies ----------------------------------------------------------------------------
def test_direct_ranch_to_slaughterhouse():
    e = engine({"R0001": 100}).run([mv("G1", "R0001", "S:SIF_01", 1, 40)])
    assert comp(e, "LOT-G1") == {"R0001#opening": 40}
    assert e.moved["LOT-G1"].comp["R0001#opening"][1] == 1  # one hop
    assert_conserved(e)


def test_two_and_three_hop_transfers():
    e = engine({"R0001": 100, "R0002": 0, "R0003": 0}).run([
        mv("G1", "R0001", "R0002", 1, 60), mv("G2", "R0002", "R0003", 5, 60), mv("G3", "R0003", "S:SIF_01", 9, 50)])
    assert comp(e, "LOT-G2") == {"R0001#opening": 60}
    assert comp(e, "LOT-G3") == {"R0001#opening": 50}
    assert e.moved["LOT-G3"].comp["R0001#opening"][1] == 3
    path = e.path(["LOT-G3"])
    assert [p["gta_id"] for p in path] == ["G1", "G2", "G3"]
    assert [p["attributed_head"] for p in path] == pytest.approx([50, 50, 50])
    assert_conserved(e)


def test_source_feeding_several_shipments_is_never_double_allocated():
    e = engine({"R0001": 100, "R0002": 0}).run([
        mv("G1", "R0001", "R0002", 1, 80), mv("G2", "R0002", "S:SIF_01", 3, 30), mv("G3", "R0002", "P:BARCARENA", 4, 50)])
    a, b = comp(e, "LOT-G2"), comp(e, "LOT-G3")
    assert a["R0001#opening"] + b["R0001#opening"] == pytest.approx(80)
    assert sum(h for _, h in e.moved["LOT-G2"].sources) + sum(h for _, h in e.moved["LOT-G3"].sources) == pytest.approx(80)
    assert_conserved(e)


def test_merging_sources_keep_composition_and_fifo_order():
    e = engine({"R0001": 50, "R0002": 50, "R0003": 0}).run([
        mv("G1", "R0001", "R0003", 1, 30), mv("G2", "R0002", "R0003", 2, 20), mv("G3", "R0003", "S:SIF_01", 5, 40)])
    assert comp(e, "LOT-G3") == {"R0001#opening": 30, "R0002#opening": 10}  # oldest lot first
    p = engine({"R0001": 50, "R0002": 50, "R0003": 0}, policy="pro_rata").run([
        mv("G1", "R0001", "R0003", 1, 30), mv("G2", "R0002", "R0003", 2, 20), mv("G3", "R0003", "S:SIF_01", 5, 40)])
    assert comp(p, "LOT-G3") == {"R0001#opening": 24, "R0002#opening": 16}  # mixed herd: 60 / 40
    assert_conserved(e)
    assert_conserved(p)


def test_partial_allocation_splits_a_lot():
    e = engine({"R0001": 100, "R0002": 0}).run([
        mv("G1", "R0001", "R0002", 1, 70), mv("G2", "R0002", "S:SIF_01", 2, 25), mv("G3", "R0002", "S:SIF_01", 3, 25)])
    assert e.moved["LOT-G2"].sources == [("LOT-G1", 25)] and e.moved["LOT-G3"].sources == [("LOT-G1", 25)]
    assert sum(l.head for l in e.inv["R0002"]) == pytest.approx(20)
    assert_conserved(e)


def test_births_become_their_own_origin():
    e = engine({"R0001": 10}).run([mv("G1", "R0001", "S:SIF_01", 20, 15)],
                                  births=[{"ref": "B-R0001-00001", "ranch": "R0001", "date": d(5), "head": 8}])
    assert comp(e, "LOT-G1") == {"R0001#opening": 10, "R0001#birth": 5}
    assert_conserved(e)


# ---- defects -----------------------------------------------------------------------------------
def test_inventory_shortage_becomes_unresolved_not_invented():
    e = engine({"R0001": 30}).run([mv("G1", "R0001", "S:SIF_01", 1, 50)])
    assert comp(e, "LOT-G1") == {"R0001#opening": 30, "UNRESOLVED#G1": 20}
    assert [(i.code, i.head) for i in e.issues] == [("inventory_shortage", 20)]
    assert_conserved(e)


def test_shortage_propagates_downstream_as_unknown():
    e = engine({"R0001": 10, "R0002": 0}).run([mv("G1", "R0001", "R0002", 1, 30), mv("G2", "R0002", "S:SIF_01", 2, 30)])
    assert comp(e, "LOT-G2") == {"R0001#opening": 10, "UNRESOLVED#G1": 20}
    assert_conserved(e)


def test_missing_upstream_record():
    e = engine({"R0002": 0}).run([mv("G1", "R0404", "R0002", 1, 40), mv("G2", "R0002", "S:SIF_01", 3, 40)])
    assert comp(e, "LOT-G2") == {"MISSING#R0404": 40}
    assert e.issues[0].code == "missing_upstream_record"
    assert_conserved(e)


def test_unknown_destination_is_reported_and_conserved():
    e = engine({"R0001": 10}).run([mv("G1", "R0001", "S:XXX_99", 1, 5)])
    assert e.issues[0].code == "unknown_destination"
    assert_conserved(e)


def test_out_of_order_input_gives_the_same_result():
    moves = [mv("G1", "R0001", "R0002", 1, 60), mv("G2", "R0002", "R0003", 5, 60), mv("G3", "R0003", "S:SIF_01", 9, 50),
             mv("G4", "R0002", "S:SIF_01", 5, 0 + 1)]
    a = engine({"R0001": 100, "R0002": 5, "R0003": 0}).run(moves)
    shuffled = moves[:]
    random.Random(3).shuffle(shuffled)
    b = engine({"R0001": 100, "R0002": 5, "R0003": 0}).run(shuffled)
    for lot in a.moved:
        assert comp(a, lot) == comp(b, lot)
    assert_conserved(b)


def test_same_day_ties_are_deterministic():
    moves = [mv("G2", "R0002", "S:SIF_01", 1, 10), mv("G1", "R0001", "R0002", 1, 10)]
    e = engine({"R0001": 10, "R0002": 0}).run(moves)
    assert comp(e, "LOT-G2") == {"R0001#opening": 10}  # G1 sorts first on the same day
    assert not e.issues


def test_impossible_chronology_and_duplicates_and_self_loops():
    e = engine({"R0001": 100}).run([
        mv("G1", "R0001", "S:SIF_01", 3, 10, issue_date=d(9)),
        mv("G1", "R0001", "S:SIF_01", 4, 10),
        mv("G2", "R0001", "R0001", 5, 10),
        mv("G3", "R0001", "S:SIF_01", -10, 10)])
    codes = sorted(i.code for i in e.issues)
    assert codes == ["duplicate_movement", "impossible_chronology", "movement_before_registration", "self_loop"]
    assert_conserved(e)


def test_cycles_terminate_and_conserve():
    e = engine({"R0001": 50, "R0002": 50}).run([
        mv("G1", "R0001", "R0002", 1, 50), mv("G2", "R0002", "R0001", 2, 70), mv("G3", "R0001", "R0002", 3, 70),
        mv("G4", "R0002", "S:SIF_01", 4, 100)])
    assert sum(comp(e, "LOT-G4").values()) == pytest.approx(100)
    assert {r["gta_id"] for r in e.path(["LOT-G4"])} == {"G1", "G2", "G3", "G4"}
    assert_conserved(e)


def test_unknown_origin_from_external_supplier():
    e = engine({"X01": 40, "R0001": 0}, external=("X01",)).run([mv("G1", "X01", "R0001", 1, 40), mv("G2", "R0001", "S:SIF_01", 2, 40)])
    assert comp(e, "LOT-G2") == {"X01#external": 40}


def test_ledger_refused_permits_are_not_applied():
    e = engine({"R0001": 10}).run([mv("G1", "R0001", "S:SIF_01", 1, 10)], skip={"G1": "OriginEmbargoed"})
    assert "LOT-G1" not in e.moved and e.issues[0].code == "ledger_refused"
    assert e.conservation()["on_hand"] == 10


@pytest.mark.parametrize("policy", ["fifo", "pro_rata"])
def test_conservation_on_a_random_graph(policy):
    rnd = random.Random(42)
    ranches = {f"R{i:04d}": rnd.randint(0, 200) for i in range(1, 30)}
    moves = [mv(f"G{n:04d}", rnd.choice(list(ranches)), rnd.choice(list(ranches) + ["S:SIF_01"] * 5), rnd.randint(0, 300), rnd.randint(1, 80))
             for n in range(600)]
    births = [{"ref": f"B{n}", "ranch": rnd.choice(list(ranches)), "date": d(rnd.randint(0, 300)), "head": rnd.randint(1, 20)} for n in range(80)]
    deaths = [{"ref": f"D{n}", "ranch": rnd.choice(list(ranches)), "date": d(rnd.randint(0, 300)), "head": rnd.randint(1, 5)} for n in range(40)]
    e = engine(ranches, policy).run(moves, births, deaths)
    assert_conserved(e)
    for lot in e.moved.values():  # every outgoing lot is fully attributed, to known or explicitly unresolved origins
        assert sum(v[0] for v in lot.comp.values()) == pytest.approx(lot.head)


# ---- service on the tiny fixture -----------------------------------------------------------------
@pytest.fixture(scope="module")
def svc(tmp_path_factory):
    dst = tmp_path_factory.mktemp("lin") / "tiny"
    shutil.copytree(FIXTURE, dst, ignore=shutil.ignore_patterns("truth", "geo_*", "lineage_*"))  # no ground truth available
    run_geo(dst)
    return LineageService(dst)


def test_service_conserves_and_reads_no_truth(svc):
    assert not (svc.dataset / "truth").exists()
    for e in svc.engines.values():
        assert e.conservation()["balanced"]


def test_every_shipment_traces_to_a_valid_record(svc):
    for sid in svc.ship:
        t = svc.trace_shipment(sid)
        LineageTrace.model_validate(t)
        # head_equiv is rounded to 0.001 per source
        assert sum(s["head_equiv"] for s in t["sources"]) == pytest.approx(t["declared_head"], abs=5e-4 * len(t["sources"]) + 1e-6)
        assert t["exposure_pct"]["any_risk"] <= 100.0001
        cats = t["exposure_pct"]
        assert cats["any_risk"] + 1e-6 >= max(cats["post_cutoff_deforestation"], cats["embargo"], cats["protected_overlap"])


def test_overall_share_does_not_double_count(svc):
    multi = None
    for sid in svc.ship:
        t = svc.trace_shipment(sid)
        if any(len(set(s["categories"]) - {"environmental_evidence_missing"}) >= 2 for s in t["sources"]):
            multi = t
            break
    assert multi, "fixture should contain an origin in two risk categories"
    e = multi["exposure_pct"]
    assert e["any_risk"] < e["post_cutoff_deforestation"] + e["embargo"] + e["protected_overlap"] + e["suspicious_births_or_inventory"] + e["unknown_or_incomplete"] + 1e-9


def test_trace_is_deterministic(svc):
    sid = sorted(svc.ship)[0]
    assert svc.trace_shipment(sid) == LineageService(svc.dataset).trace_shipment(sid)


def test_gta_and_lot_targets(svc):
    g = next(iter(svc.gta.values()))
    assert svc.trace_gta(g["gta_id"])["gta_ids"] == [g["gta_id"]]
    assert svc.trace_lot(g["lot_id"])["lot_ids"] == [g["lot_id"]]


def test_cli_prints_contribution_table_and_warnings(svc, capsys):
    sid = max(svc.ship, key=lambda s: len(svc.ship[s]["gta_ids"]))
    trace_cli([str(svc.dataset), sid])
    out = capsys.readouterr().out
    assert "origin" in out and "share" in out and "categories" in out
    assert "Attribution" in out and "Warnings" in out and "cohort assumption" in out
