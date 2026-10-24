"""Certificate workflow: assess -> canonical bundle -> SHA-256 -> EIP-712 signature -> HerdLedger.

    python -m rastro.certificates.issue issue    ../data/synthetic/evaluation SHP-D-000123
    python -m rastro.certificates.issue consume  ../data/synthetic/evaluation <lot_id> --shipment SHP-D-000123
    python -m rastro.certificates.issue resubmit ../data/synthetic/evaluation <lot_id>     # replay attempt
    python -m rastro.certificates.issue demo     ../data/synthetic/evaluation              # the four Task 09 cases

Signing and submission run in contracts/replay/certify.mjs, the trusted signer process: the oracle
key comes from its environment (ORACLE_PRIVATE_KEY; anvil's development key only on chain 31337).
Nothing here holds a key. Every chain field written to the registry is copied from a mined receipt
or a simulated revert; nothing is invented.

Store: <dataset>/certificates/
  bundles/<sha256>.json   canonical RFC 8785 bytes of each evidence bundle (file name = hash)
  signed/<lot_id>.json    the signed EIP-712 certificate, signature and domain
  registry.jsonl          append-only log: refusals, issuances, consumptions, replay attempts
"""
import argparse
import json
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from rastro.certificates.bundle import EligibilityError, build_bundle, commit, evidence_hash
from rastro.certificates.jcs import canonicalize
from rastro.config import REPO

CONTRACTS = REPO / "contracts"
SIGNER = CONTRACTS / "replay" / "certify.mjs"
WEB = REPO / "web" / "public" / "data"
VERDICT_CLEAN = 0


def _now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def store(dataset: Path) -> Path:
    d = dataset / "certificates"
    (d / "bundles").mkdir(parents=True, exist_ok=True)
    (d / "signed").mkdir(parents=True, exist_ok=True)
    return d


def log(dataset: Path, event: dict) -> dict:
    event = {"logged_at": _now(), **event}
    with (store(dataset) / "registry.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, sort_keys=True) + "\n")
    return event


def registry(dataset: Path) -> list[dict]:
    p = dataset / "certificates" / "registry.jsonl"
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l] if p.is_file() else []


def ledger_gta_hashes(dataset: Path) -> dict[str, str]:
    """GTA id -> hash recorded on the ledger by the replay, only where the published movement is the
    same permit (origin, destination, date, head) as the canonical one."""
    pub = WEB / "movements.json"
    if not pub.is_file():
        return {}
    canon = {g["gta_id"]: g for g in (json.loads(l) for l in (dataset / "inputs" / "gta_movements.jsonl").read_text(encoding="utf-8").splitlines() if l)}
    out = {}
    for m in json.loads(pub.read_text(encoding="utf-8")):
        g = canon.get(m["gta"])
        if g and (g["origin_id"], g["destination_id"], g["movement_date"], g["head_count"]) == (m["from"], m["to"], m["date"], m["head"]) and not m.get("rejected"):
            out[m["gta"]] = m["hash"]
    return out


def signer(*args: str, rpc: str | None = None) -> dict:
    cmd = ["node", str(SIGNER), *args] + (["--rpc", rpc] if rpc else [])
    p = subprocess.run(cmd, cwd=CONTRACTS, capture_output=True, text=True, timeout=300)
    line = (p.stdout.strip().splitlines() or ["{}"])[-1]
    try:
        out = json.loads(line)
    except json.JSONDecodeError:
        out = {"fatal": True, "error": (p.stderr or p.stdout).strip()[-500:]}
    if p.returncode and not out.get("fatal"):
        out["fatal"] = True
    return out


def _decision(dataset: Path, shipment_id: str):
    p = dataset / "derived" / "risk" / "decisions.jsonl"
    return next((json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l and json.loads(l)["shipment_id"] == shipment_id), None) if p.is_file() else None


def issue(dataset: Path, shipment_id: str, rpc: str | None = None, allow_duplicate_attempt: bool = False) -> dict:
    d = _decision(dataset, shipment_id)
    if d is None:
        return log(dataset, {"event": "refused", "shipment_id": shipment_id, "reason": "no canonical risk assessment for this shipment"})
    if d["outcome"] != "PASS":
        return log(dataset, {"event": "refused", "shipment_id": shipment_id, "decision": d["outcome"],
                             "reason": f"decision is {d['outcome']}: only PASS lots receive a clean certificate"
                                       + ("; REVIEW lots are held until an investigator resolves them" if d["outcome"] == "REVIEW" else ""),
                             "decision_evidence_hash": d["evidence_hash"]})
    hashes = ledger_gta_hashes(dataset)
    try:
        b = build_bundle(dataset, shipment_id, gta_hashes=hashes)
    except EligibilityError as e:
        return log(dataset, {"event": "refused", "shipment_id": shipment_id, "reason": str(e)})
    missing = [g for g in b["shipment"]["gta_ids"] if g not in hashes]
    if missing:
        return log(dataset, {"event": "refused", "shipment_id": shipment_id, "reason": f"permits not recorded on the ledger: {missing[:5]}"})
    raw = canonicalize(b)
    h = evidence_hash(b)
    (store(dataset) / "bundles" / f"{h[2:]}.json").write_bytes(raw)
    lot = b["shipment"]["lot_commitment"]
    prior = [e for e in registry(dataset) if e.get("event") == "issue" and e.get("lot_id") == lot and e.get("receipt_status") == 1]
    if prior and not allow_duplicate_attempt:
        return log(dataset, {"event": "refused", "shipment_id": shipment_id, "lot_id": lot,
                             "reason": f"duplicate issuance: lot already certified in tx {prior[0]['tx_hash']}"})
    req = {"lot_id": lot, "sink": commit(b["shipment"]["destination_id"]), "gta_hashes": b["shipment"]["gta_commitments"],
           "shipment": b["shipment"]["commitment"], "head": b["shipment"]["declared_head"], "verdict": VERDICT_CLEAN,
           "evidence_hash": h, "policy_version": b["policy_version"], "expires_in_days": 365}
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(req, f)
    res = signer("issue", "--request", f.name, rpc=rpc)
    Path(f.name).unlink(missing_ok=True)
    if res.get("fatal"):
        return log(dataset, {"event": "issue_failed", "shipment_id": shipment_id, "lot_id": lot, "evidence_hash": h, "error": res.get("error"),
                             "note": "no transaction was confirmed"})
    if res.get("submitted") and res.get("receipt_status") == 1:
        (store(dataset) / "signed" / f"{lot}.json").write_text(json.dumps(
            {"certificate": res["certificate"], "signature": res["signature"], "domain": res["domain"], "signer": res["signer"],
             "digest": res["digest"], "bundle_path": f"bundles/{h[2:]}.json"}, indent=1), encoding="utf-8")
    ok = bool(res.get("submitted") and res.get("receipt_status") == 1)
    return log(dataset, {"event": "issue" if ok else "issue_rejected", "shipment_id": shipment_id, "lot_id": lot, "evidence_hash": h,
                         "bundle_path": f"bundles/{h[2:]}.json",
                         "shipment_commitment": req["shipment"], "policy_version": req["policy_version"],
                         **{k: res.get(k) for k in ("chain_id", "contract", "network", "signer", "digest", "submitted", "reverted", "error",
                                                    "tx_hash", "block_number", "receipt_status", "status_after")},
                         "issued_at": (res.get("certificate") or {}).get("issuedAt"), "expires_at": (res.get("certificate") or {}).get("expiresAt")})


def consume(dataset: Path, lot: str, consuming_shipment: str, use: int = 0, rpc: str | None = None) -> dict:
    signed = store(dataset) / "signed" / f"{lot}.json"
    ref = commit(consuming_shipment)
    if signed.is_file() and use == 0:
        bound = json.loads(signed.read_text(encoding="utf-8"))["certificate"]["shipment"]
        if bound.lower() != ref.lower():
            return log(dataset, {"event": "consume_refused", "lot_id": lot, "consuming_shipment": consuming_shipment,
                                 "reason": f"shipment commitment mismatch: certificate is bound to {bound}, consumption names {ref}",
                                 "note": "refused by the trusted consumption service before any transaction"})
    res = signer("consume", "--lot", lot, "--shipment", ref, "--use", str(use), rpc=rpc)
    return log(dataset, {"event": "consume", "lot_id": lot, "consuming_shipment": consuming_shipment, "consuming_commitment": ref,
                         **{k: res.get(k) for k in ("chain_id", "contract", "submitted", "reverted", "error", "tx_hash", "block_number",
                                                    "receipt_status", "status_after", "fatal")}})


def resubmit(dataset: Path, lot: str, rpc: str | None = None) -> dict:
    signed = store(dataset) / "signed" / f"{lot}.json"
    if not signed.is_file():
        return log(dataset, {"event": "replay_attempt", "lot_id": lot, "error": "no signed certificate stored for this lot"})
    res = signer("resubmit", "--signed", str(signed), rpc=rpc)
    return log(dataset, {"event": "replay_attempt", "lot_id": lot,
                         **{k: res.get(k) for k in ("chain_id", "contract", "submitted", "reverted", "error", "tx_hash", "receipt_status", "status_after", "fatal")}})


def demo(dataset: Path, rpc: str | None = None) -> dict:
    """One eligible certificate, one blocked lot, one consumption, replay and double-use attempts."""
    decisions = [json.loads(l) for l in (dataset / "derived" / "risk" / "decisions.jsonl").read_text(encoding="utf-8").splitlines() if l]
    hashes = ledger_gta_hashes(dataset)
    out = {}
    blocked = next(d for d in decisions if d["outcome"] == "FLAGGED")
    out["blocked"] = issue(dataset, blocked["shipment_id"], rpc)
    review = next((d for d in decisions if d["outcome"] == "REVIEW"), None)
    if review:
        out["held_review"] = issue(dataset, review["shipment_id"], rpc)
    for d in decisions:
        if d["outcome"] != "PASS" or not d["shipment_id"].startswith("SHP-D-"):
            continue
        ship = json.loads(next(l for l in (dataset / "inputs" / "shipments.jsonl").read_text(encoding="utf-8").splitlines() if d["shipment_id"] in l))
        if not all(g in hashes for g in ship["gta_ids"]):
            continue
        r = issue(dataset, d["shipment_id"], rpc)
        if r.get("receipt_status") == 1:
            out["eligible"] = r
            break
        if r.get("error", {}).get("name") not in ("GtaAlreadyCertified", "CertificateAlreadyIssued"):
            out["eligible_failed"] = r
            break
    if "eligible" in out:
        lot, sid = out["eligible"]["lot_id"], out["eligible"]["shipment_id"]
        out["replay_same_signature"] = resubmit(dataset, lot, rpc)
        out["duplicate_issuance"] = issue(dataset, sid, rpc)
        out["mismatched_shipment"] = consume(dataset, lot, "SHP-D-999999", rpc=rpc)
        out["consume"] = consume(dataset, lot, sid, rpc=rpc)
        out["double_consume"] = consume(dataset, lot, sid, rpc=rpc)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=("issue", "consume", "resubmit", "demo"))
    ap.add_argument("dataset", type=Path)
    ap.add_argument("target", nargs="?", help="shipment id (issue) or lot id (consume, resubmit)")
    ap.add_argument("--shipment", help="consuming shipment id (consume)")
    ap.add_argument("--use", type=int, default=0)
    ap.add_argument("--rpc")
    a = ap.parse_args(argv)
    if a.command == "issue":
        r = issue(a.dataset, a.target, a.rpc)
    elif a.command == "consume":
        r = consume(a.dataset, a.target, a.shipment, a.use, a.rpc)
    elif a.command == "resubmit":
        r = resubmit(a.dataset, a.target, a.rpc)
    else:
        r = demo(a.dataset, a.rpc)
    print(json.dumps(r, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
