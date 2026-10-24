"""Canonical evidence bundle (`rastro.evidence-bundle/1.0.0`) and its SHA-256 commitment.

The bundle is built only from canonical outputs (decision, lineage trace, findings, geo evidence
versions, dataset manifest), serialised with RFC 8785 (rastro.certificates.jcs) and hashed over
those exact bytes. The 32-byte hash is what goes on-chain; the bundle is stored off-chain under
its hash so anyone can re-hash it.

Identifiers committed on-chain use the same salted scheme as the published ranch ids:
`sha256("rastro-demo-salt-v1|" + id)`. The salt keeps guessable ids (GTA numbers, ranch codes) from
being confirmed by brute force; the trade-off is that third parties need the salt (held by the
registrar) to link a commitment back to an id, while the evidence hash itself stays publicly
reproducible from the published bundle.
"""
import hashlib
import json
from pathlib import Path

from rastro.certificates.jcs import canonicalize
from rastro.lineage.service import LineageService
from rastro.risk import RISK_ENGINE_VERSION

BUNDLE_SCHEMA = "rastro.evidence-bundle/1.0.0"
POLICY_VERSION = 1
SALT = "rastro-demo-salt-v1|"


def commit(identifier: str) -> str:
    return "0x" + hashlib.sha256((SALT + identifier).encode("utf-8")).hexdigest()


def evidence_hash(bundle: dict) -> str:
    return "0x" + hashlib.sha256(canonicalize(bundle)).hexdigest()


def _jsonl(p: Path):
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l] if p.is_file() else []


class EligibilityError(ValueError):
    """The lot may not receive a clean certificate (FLAGGED, REVIEW, missing assessment)."""


def build_bundle(dataset: Path, shipment_id: str, svc: LineageService | None = None, require_pass: bool = True,
                 gta_hashes: dict[str, str] | None = None) -> dict:
    """gta_hashes: GTA id -> the 32-byte hash the ledger recorded for it; without it the salted
    `commit(gta id)` is used (a world that was never replayed on a chain)."""
    manifest = json.loads((dataset / "manifest.json").read_text(encoding="utf-8"))
    risk = dataset / "derived" / "risk"
    decision = next((d for d in _jsonl(risk / "decisions.jsonl") if d["shipment_id"] == shipment_id), None)
    if decision is None:
        raise EligibilityError(f"{shipment_id}: no risk assessment found")
    if require_pass and decision["outcome"] != "PASS":
        raise EligibilityError(f"{shipment_id}: decision is {decision['outcome']}; only PASS lots can be certified clean")
    svc = svc or LineageService(dataset)
    trace = svc.trace_shipment(shipment_id)
    ids = set(decision["blocking_finding_ids"]) | set(decision["review_finding_ids"])
    findings = [f for f in _jsonl(risk / "findings.jsonl")
                if f["finding_id"] in ids or f["entity_id"] in set(trace["direct_suppliers"]) | {shipment_id}]
    geo = {g["ranch_id"]: g for g in _jsonl(dataset / "derived" / "geo_evidence.jsonl")}
    versions = sorted({f"{k}={v}" for r in trace["direct_suppliers"] if r in geo for k, v in geo[r]["dataset_versions"].items()})
    ship = svc.ship[shipment_id]
    gta_commitments = [(gta_hashes or {}).get(g) or commit(g) for g in ship["gta_ids"]]
    return {
        "schema": BUNDLE_SCHEMA,
        "policy_version": POLICY_VERSION,
        "shipment": {"shipment_id": shipment_id, "commitment": commit(shipment_id), "destination_id": ship["destination_id"],
                     "gta_commitment_scheme": "ledger GTA hash" if gta_hashes else "sha256(salt|gta id)",
                     "destination_commitment": commit(ship["destination_id"]), "shipment_date": ship["shipment_date"],
                     "declared_head": ship["declared_head_count"], "gta_ids": ship["gta_ids"], "gta_commitments": gta_commitments,
                     "lot_commitment": "0x" + hashlib.sha256(canonicalize(sorted(gta_commitments))).hexdigest()},
        "decision": {"outcome": decision["outcome"], "risk_categories": decision["risk_categories"], "reasons": decision["reasons"],
                     "decision_evidence_hash": decision["evidence_hash"], "thresholds": decision["thresholds"],
                     "assessed_at": decision["decided_at"]},
        "lineage": {"policy": trace["policy"], "coverage_pct": trace["coverage_pct"], "max_hops": trace["max_hops"],
                    "direct_suppliers": trace["direct_suppliers"], "intermediaries": trace["intermediaries"],
                    "exposure_pct": trace["exposure_pct"], "policy_sensitivity": trace["policy_sensitivity"],
                    "sources": [{k: s[k] for k in ("origin_key", "origin_kind", "head_equiv", "share_pct", "min_hops", "categories")}
                                for s in trace["sources"]],
                    "uncertainty_notes": trace["uncertainty_notes"]},
        "findings": [{k: f[k] for k in ("finding_id", "entity_id", "detector", "detector_version", "code", "severity", "confidence",
                                         "blocking", "evidence_hash", "explanation")} for f in sorted(findings, key=lambda f: f["finding_id"])],
        "evidence_record_ids": sorted(set(trace["evidence_refs"]) | {f"finding:{f['finding_id']}" for f in findings}),
        "dataset": {"dataset_id": manifest["dataset_id"], "dataset_version": manifest["dataset_version"], "seed": manifest["seed"],
                    "logical_digest": manifest["logical_digest"], "environmental_versions": versions},
        "detector_version": f"rastro-risk {RISK_ENGINE_VERSION}",
        "provenance": {"ranches_herds_permits": "synthetic", "environmental_layers": manifest["landscape"] == "real" and "real" or "synthetic",
                       "notice": manifest["notice"]},
        "limitations": ["lineage contributions are FIFO estimates, not animal identity",
                        "ranch boundaries, herds, permits and embargoes are synthetic",
                        "a clean certificate states the screening outcome under the policy version; it is not a legal determination"],
    }
