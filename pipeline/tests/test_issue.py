"""Certificate issuance workflow, with the trusted signer replaced by a recorder (no chain needed)."""
import json
import shutil
from pathlib import Path

import pytest

from rastro.certificates import issue as I
from rastro.certificates.bundle import commit
from rastro.certificates.jcs import canonicalize

FIXTURE = Path(__file__).parent / "fixtures" / "tiny"


@pytest.fixture(scope="module")
def assessed(tmp_path_factory):
    from rastro.geospatial.run import run as run_geo
    from rastro.risk.run import run as run_risk
    d = tmp_path_factory.mktemp("issue") / "tiny"
    shutil.copytree(FIXTURE, d, ignore=shutil.ignore_patterns("geo_*", "lineage_*", "risk", "reports", "certificates"))
    run_geo(d)
    run_risk(d)
    return d


@pytest.fixture
def ds(assessed, tmp_path, monkeypatch):
    d = tmp_path / "ds"
    shutil.copytree(assessed, d)
    ships = [json.loads(l) for l in (d / "inputs" / "shipments.jsonl").read_text(encoding="utf-8").splitlines()]
    monkeypatch.setattr(I, "ledger_gta_hashes", lambda dataset: {g: commit(g) for s in ships for g in s["gta_ids"]})
    calls = []

    def fake_signer(*args, rpc=None):
        calls.append(args)
        if args[0] == "issue":
            req = json.loads(Path(args[2]).read_text(encoding="utf-8"))
            return {"chain_id": 31337, "contract": "0x" + "ab" * 20, "network": "anvil (local chain)", "submitted": True, "reverted": False,
                    "tx_hash": "0x" + "cd" * 32, "block_number": 7, "receipt_status": 1, "status_after": "valid", "signer": "0x" + "ef" * 20,
                    "digest": "0x" + "01" * 32, "signature": "0x" + "02" * 65, "domain": {"chainId": 31337},
                    "certificate": {"lotId": req["lot_id"], "shipment": req["shipment"], "evidenceHash": req["evidence_hash"], "issuedAt": 1, "expiresAt": 2}}
        if args[0] == "consume":
            return {"submitted": True, "reverted": False, "tx_hash": "0x" + "ee" * 32, "block_number": 8, "receipt_status": 1, "status_after": "consumed"}
        return {"submitted": False, "reverted": True, "error": {"name": "CertificateAlreadyIssued", "args": {}}}

    monkeypatch.setattr(I, "signer", fake_signer)
    return d, calls


def decision(d, outcome):
    rows = [json.loads(l) for l in (d / "derived" / "risk" / "decisions.jsonl").read_text(encoding="utf-8").splitlines()]
    return next((r for r in rows if r["outcome"] == outcome), None)


@pytest.mark.parametrize("outcome", ["FLAGGED", "REVIEW"])
def test_flagged_and_review_are_refused_before_signing(ds, outcome):
    d, calls = ds
    dec = decision(d, outcome)
    if dec is None:
        pytest.skip(f"no {outcome} lot in the fixture")
    r = I.issue(d, dec["shipment_id"])
    assert r["event"] == "refused" and outcome in r["reason"] and not calls


def test_unknown_shipment_is_refused(ds):
    d, calls = ds
    assert I.issue(d, "SHP-D-999999")["event"] == "refused" and not calls


def test_eligible_lot_is_signed_and_its_bundle_stored(ds):
    d, calls = ds
    dec = decision(d, "PASS")
    r = I.issue(d, dec["shipment_id"])
    assert r["event"] == "issue" and r["tx_hash"] == "0x" + "cd" * 32 and r["receipt_status"] == 1
    stored = (d / "certificates" / r["bundle_path"]).read_bytes()
    assert "0x" + __import__("hashlib").sha256(stored).hexdigest() == r["evidence_hash"]
    assert canonicalize(json.loads(stored)) == stored
    req_lot = json.loads((d / "certificates" / "signed" / f"{r['lot_id']}.json").read_text())["certificate"]["lotId"]
    assert req_lot == r["lot_id"] and len(calls) == 1


def test_duplicate_issuance_is_refused_locally(ds):
    d, calls = ds
    dec = decision(d, "PASS")
    I.issue(d, dec["shipment_id"])
    r = I.issue(d, dec["shipment_id"])
    assert r["event"] == "refused" and "duplicate issuance" in r["reason"] and len(calls) == 1


def test_mismatched_consuming_shipment_is_refused(ds):
    d, calls = ds
    r = I.issue(d, decision(d, "PASS")["shipment_id"])
    c = I.consume(d, r["lot_id"], "SHP-D-999999")
    assert c["event"] == "consume_refused" and "mismatch" in c["reason"] and len(calls) == 1
    ok = I.consume(d, r["lot_id"], r["shipment_id"])
    assert ok["event"] == "consume" and ok["receipt_status"] == 1


def test_replay_attempt_reports_the_contract_revert(ds):
    d, _ = ds
    r = I.issue(d, decision(d, "PASS")["shipment_id"])
    rep = I.resubmit(d, r["lot_id"])
    assert rep["event"] == "replay_attempt" and rep["reverted"] and rep["error"]["name"] == "CertificateAlreadyIssued"


def test_signer_failure_is_never_reported_as_success(ds, monkeypatch):
    d, _ = ds
    monkeypatch.setattr(I, "signer", lambda *a, rpc=None: {"fatal": True, "error": "connect ECONNREFUSED 127.0.0.1:8545"})
    r = I.issue(d, decision(d, "PASS")["shipment_id"])
    assert r["event"] == "issue_failed" and "tx_hash" not in r and "no transaction" in r["note"]
    assert not list((d / "certificates" / "signed").glob("*.json"))


def test_unreachable_chain_through_the_real_signer(assessed, tmp_path, monkeypatch):
    """The real Node signer pointed at a closed port: a failure, no fabricated receipt."""
    if shutil.which("node") is None or not I.SIGNER.is_file():
        pytest.skip("node or the signer script is not available")
    d = tmp_path / "ds"
    shutil.copytree(assessed, d)
    ships = [json.loads(l) for l in (d / "inputs" / "shipments.jsonl").read_text(encoding="utf-8").splitlines()]
    monkeypatch.setattr(I, "ledger_gta_hashes", lambda dataset: {g: commit(g) for s in ships for g in s["gta_ids"]})
    r = I.issue(d, decision(d, "PASS")["shipment_id"], rpc="http://127.0.0.1:9")
    assert r["event"] == "issue_failed" and r.get("tx_hash") is None


def test_conflicting_published_permit_is_not_used_as_the_ledger_hash(assessed, tmp_path, monkeypatch):
    """A published movement whose origin, destination, date or head disagrees with the canonical permit
    is conflicting source data: its ledger hash must not be attached to the certificate."""
    g = json.loads((assessed / "inputs" / "gta_movements.jsonl").read_text(encoding="utf-8").splitlines()[0])
    pub = tmp_path / "pub"
    pub.mkdir()
    same = {"gta": g["gta_id"], "hash": "0x" + "aa" * 32, "from": g["origin_id"], "to": g["destination_id"],
            "date": g["movement_date"], "head": g["head_count"], "rejected": None}
    (pub / "movements.json").write_text(json.dumps([same]), encoding="utf-8")
    monkeypatch.setattr(I, "WEB", pub)
    assert I.ledger_gta_hashes(assessed) == {g["gta_id"]: "0x" + "aa" * 32}
    (pub / "movements.json").write_text(json.dumps([{**same, "head": g["head_count"] + 1}]), encoding="utf-8")
    assert I.ledger_gta_hashes(assessed) == {}
