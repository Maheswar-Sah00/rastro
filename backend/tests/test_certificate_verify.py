"""EIP-712 recovery and independent certificate verification, with a deterministic fake ledger."""
import hashlib
import json
import secrets
import time
from dataclasses import dataclass

import pytest

from app.chain import eip712
from app.chain.adapter import ChainInfo, ChainUnavailable
from app.chain.keccak import keccak256
from app.services import certificates
from rastro.certificates.jcs import canonicalize

ADDR = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
ORACLE_KEY = 0x8B3A350CF5C34C9194CA85829A2DF0EC3153BE0318B5E2D3348E872092EDFFBA  # anvil dev key #5 (public test key)
ORACLE = "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc"

# Vector produced by ethers v6 Wallet.signTypedData (see contracts/replay/certify.mjs CERT_TYPES).
VEC_CERT = {"lotId": "0x" + "11" * 32, "sink": "0x" + "22" * 32, "gtaHashes": ["0x" + "33" * 32, "0x" + "44" * 32], "shipment": "0x" + "55" * 32,
            "head": 120, "verdict": 0, "evidenceHash": "0x" + "66" * 32, "issuedAt": 1700000000, "expiresAt": 1731536000, "policyVersion": 1,
            "nonce": 123456789}
VEC_SIG = ("0x96a4967b41d1059171f0cd222a45cfa358ffa1f3444d0b61e066fd7e0ae3a191"
           "1597b1fb9bf1e447da1f5f32829ab8bc967a6fb10d23c2197ddafabd5dc24c1b1b")


def test_matches_ethers_vector():
    assert eip712.domain_separator(31337, ADDR).hex() == "7c89a99182293af2f11e5d961c12cbd5018d4e74874488ec266981e93f080177"
    d = eip712.digest(VEC_CERT, 31337, ADDR)
    assert d.hex() == "4c9e85d9bb8b8401d6075901e6dd657e169174a0e50c024e8636089587fe28d1"
    assert eip712.recover(d, VEC_SIG) == ORACLE


def test_malleable_and_malformed_signatures_are_rejected():
    d = eip712.digest(VEC_CERT, 31337, ADDR)
    r, s, v = int(VEC_SIG[2:66], 16), int(VEC_SIG[66:130], 16), int(VEC_SIG[130:], 16)
    high = "0x" + r.to_bytes(32, "big").hex() + (eip712.N - s).to_bytes(32, "big").hex() + format(55 - v, "02x")
    for bad in (high, VEC_SIG[:-2] + "05", VEC_SIG[:100], "0x" + "00" * 65):
        with pytest.raises(eip712.InvalidSignature):
            eip712.recover(d, bad)


def test_other_domain_recovers_someone_else():
    assert eip712.recover(eip712.digest(VEC_CERT, 84532, ADDR), VEC_SIG) != ORACLE


# ---- signing helper (tests only) --------------------------------------------------------------
def sign(cert, chain_id=31337, contract=ADDR, key=ORACLE_KEY):
    z = int.from_bytes(eip712.digest(cert, chain_id, contract), "big")
    while True:
        k = secrets.randbelow(eip712.N - 1) + 1
        R = eip712._mul(k, eip712.G)
        r = R[0] % eip712.N
        s = pow(k, -1, eip712.N) * (z + r * key) % eip712.N
        if r and s:
            break
    v = 27 + (R[1] & 1)
    if s > eip712.N // 2:
        s, v = eip712.N - s, 55 - v
    return "0x" + r.to_bytes(32, "big").hex() + s.to_bytes(32, "big").hex() + format(v, "02x")


def test_helper_signs_like_the_oracle():
    assert eip712.recover(eip712.digest(VEC_CERT, 31337, ADDR), sign(VEC_CERT)) == ORACLE


# ---- verification against a fake ledger ----------------------------------------------------------
@dataclass
class FakeLedger:
    status: str = "valid"
    oracle: str = ORACLE
    record_hash: str | None = None
    record_shipment: str | None = None
    down: bool = False

    def __post_init__(self):
        self.info = ChainInfo("rpc", "anvil", 31337, ADDR, "live eth_call on anvil (chain 31337): local node, not a public testnet", False, True)

    def _chk(self):
        if self.down:
            raise ChainUnavailable("connection refused")

    def certificate_status(self, lot):
        self._chk()
        return {"status": self.status, "source": "eth_call"}

    def certificate_record(self, lot):
        self._chk()
        return {"record": {"evidenceHash": self.record_hash, "shipment": self.record_shipment, "oracle": self.oracle}}

    def is_oracle(self, address):
        self._chk()
        return {"is_oracle": address.lower() == self.oracle.lower(), "source": "eth_call"}


class Store:
    def __init__(self, d):
        self.dir = d

    def get(self, table, key):
        return None  # no canonical shipment: the assessment-currency check is skipped


@pytest.fixture
def issued(tmp_path, monkeypatch):
    bundle = {"schema": "rastro.evidence-bundle/1.0.0", "shipment": {"shipment_id": "SHP-D-000001"}, "decision": {"outcome": "PASS"}, "n": 4.5}
    raw = canonicalize(bundle)
    h = "0x" + hashlib.sha256(raw).hexdigest()
    lot = "0x" + keccak256(b"lot").hex()
    cert = {**VEC_CERT, "lotId": lot, "evidenceHash": h, "issuedAt": int(time.time()), "expiresAt": int(time.time()) + 86400}
    d = tmp_path / "certificates"
    (d / "bundles").mkdir(parents=True)
    (d / "signed").mkdir()
    (d / "bundles" / f"{h[2:]}.json").write_bytes(raw)
    domain = {"name": "Rastro HerdLedger", "version": "1", "chainId": 31337, "verifyingContract": ADDR}
    (d / "signed" / f"{lot}.json").write_text(json.dumps({"certificate": cert, "signature": sign(cert), "domain": domain,
                                                          "bundle_path": f"bundles/{h[2:]}.json"}))
    ledger = FakeLedger(record_hash=h, record_shipment=cert["shipment"])
    monkeypatch.setattr(certificates.chain, "adapter", lambda store: ledger)
    return Store(tmp_path), lot, cert, ledger, d / "bundles" / f"{h[2:]}.json", domain


def run(store, lot, payload=None):
    return certificates.verify_signed(store, lot, payload)


def test_valid_certificate(issued):
    store, lot, *_ = issued
    r = run(store, lot)
    assert r["outcome"] == "valid" and r["usable"] and r["signer"] == ORACLE
    assert all(c["ok"] for c in r["checks"])


@pytest.mark.parametrize("status", ["consumed", "revoked", "expired", "not_clean"])
def test_ledger_state_is_reported(issued, status):
    store, lot, _, ledger, *_ = issued
    ledger.status = status
    r = run(store, lot)
    assert r["outcome"] == status and not r["usable"]


def test_not_on_ledger(issued):
    store, lot, _, ledger, *_ = issued
    ledger.status = "none"
    assert run(store, lot)["outcome"] == "not_on_ledger"


def test_tampered_evidence_is_invalid(issued):
    store, lot, _, _, bundle_file, _ = issued
    bundle_file.write_bytes(bundle_file.read_bytes().replace(b"4.5", b"4.6"))
    r = run(store, lot)
    assert r["outcome"] == "invalid" and "evidence_hash" in r["reason"]


def test_missing_evidence_is_unverifiable_not_valid(issued):
    store, lot, _, _, bundle_file, _ = issued
    bundle_file.unlink()
    r = run(store, lot)
    assert r["outcome"] == "unverifiable" and not r["usable"] and "could not be independently checked" in r["reason"]


def test_unauthorised_signer_is_invalid(issued):
    store, lot, cert, ledger, _, domain = issued
    other = sign(cert, key=0x59C6995E998F97A5A0044966F0945389DC9E86DAE88C7A8412F4603B6B78690D)  # anvil #1, not an oracle
    r = run(store, lot, {"certificate": cert, "signature": other, "domain": domain})
    assert r["outcome"] == "invalid" and "signer_is_oracle" in r["reason"]


@pytest.mark.parametrize("field,value", [("chainId", 84532), ("verifyingContract", "0x" + "ab" * 20)])
def test_wrong_domain_is_invalid(issued, field, value):
    store, lot, cert, _, _, domain = issued
    bad = {**domain, field: value}
    r = run(store, lot, {"certificate": cert, "signature": sign(cert, bad["chainId"], bad["verifyingContract"]), "domain": bad})
    assert r["outcome"] == "invalid"


def test_altered_certificate_terms_break_the_signature(issued):
    store, lot, cert, _, _, domain = issued
    stored = json.loads((store.dir / "certificates" / "signed" / f"{lot}.json").read_text())
    r = run(store, lot, {"certificate": {**cert, "head": cert["head"] + 1}, "signature": stored["signature"], "domain": domain})
    assert r["outcome"] == "invalid"


def test_mismatched_ledger_record_is_invalid(issued):
    store, lot, _, ledger, *_ = issued
    ledger.record_shipment = "0x" + "99" * 32
    assert "ledger_shipment" in run(store, lot)["reason"]


def test_expired_signature_window(issued, monkeypatch):
    store, lot, cert, _, _, domain = issued
    old = {**cert, "expiresAt": int(time.time()) - 10}
    r = run(store, lot, {"certificate": old, "signature": sign(old), "domain": domain})
    assert r["outcome"] in ("expired", "invalid") and not r["usable"]


def test_supplied_bundle_is_rehashed(issued):
    store, lot, cert, _, _, domain = issued
    stored = json.loads((store.dir / "certificates" / "signed" / f"{lot}.json").read_text())
    good = {"schema": "rastro.evidence-bundle/1.0.0", "shipment": {"shipment_id": "SHP-D-000001"}, "decision": {"outcome": "PASS"}, "n": 4.5}
    assert run(store, lot, {**stored, "bundle": good})["outcome"] == "valid"
    assert run(store, lot, {**stored, "bundle": {**good, "n": 5}})["outcome"] == "invalid"


def test_unavailable_chain_never_reports_valid(issued):
    store, lot, _, ledger, *_ = issued
    ledger.down = True
    r = run(store, lot)
    assert r["outcome"] != "valid" and not r["usable"]
