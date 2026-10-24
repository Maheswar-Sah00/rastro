"""Lot certificates, checked against their evidence and the ledger (live RPC, or the labelled recorded
replay).

Two evidence schemes coexist:
- published demo certificates (shipments.json, SHP-0008 style): the evidence file in
  web/public/data/evidence/<hash>.json; its SHA-256 over the stored bytes must equal the hash;
- canonical certificates (SHP-D-/SHP-V- shipments): the RFC 8785 evidence bundle built by
  rastro.certificates.bundle; it is rebuilt from the canonical outputs and re-hashed.
"""
import hashlib
import json
import re
import time
from datetime import datetime, timezone

from app.chain.adapter import ChainUnavailable, ContractRevert, LocalRecordAdapter
from app.chain.eip712 import InvalidSignature, digest, recover
from app.observability import APIError
from app.services import chain, evidence
from app.store import DatasetStore

CANONICAL = re.compile(r"^SHP-[DV]-\d+$")


def _issued(store: DatasetStore, cid: str):
    """A certificate issued by rastro.certificates.issue: signed payload + registry entries."""
    d = store.dir / "certificates"
    signed = d / "signed" / f"{cid}.json"
    reg = d / "registry.jsonl"
    events = [e for e in (json.loads(l) for l in reg.read_text(encoding="utf-8").splitlines() if l) if e.get("lot_id") == cid] if reg.is_file() else []
    return (json.loads(signed.read_text(encoding="utf-8")) if signed.is_file() else None), events


def _find(store: DatasetStore, cid: str):
    ships = store.web_json("shipments.json") or []
    s = next((x for x in ships if (x.get("certificate") or {}).get("lot_id") == cid), None)
    recs = [r for r in (store.web_json("onchain.json") or {}).get("records", []) if r.get("lot_id") == cid]
    if s is None and not recs:
        raise APIError(404, "not_found", f"certificate {cid} not found")
    return s, recs


def _status(store: DatasetStore, cid: str):
    a = chain.adapter(store)
    try:
        return a, a.certificate_status(cid), a.certificate_record(cid)
    except (ChainUnavailable, ContractRevert) as e:
        a = LocalRecordAdapter(store.web_json("onchain.json"), f"RPC failed during the request ({e}); serving recorded replay")
        return a, a.certificate_status(cid), a.certificate_record(cid)


def get(store: DatasetStore, cid: str) -> dict:
    signed, events = _issued(store, cid)
    if signed:
        a, st, rec = _status(store, cid)
        issue = next((e for e in events if e.get("event") == "issue" and e.get("receipt_status") == 1), {})
        return {"certificate_id": cid, "shipment_ref": issue.get("shipment_id"), "verdict": "clean", "evidence_hash": signed["certificate"]["evidenceHash"],
                "status": st["status"], "status_source": st["source"], "chain": chain.info(a), "onchain_record": rec.get("record"),
                "records": [{"kind": e.get("event"), "ref": e.get("shipment_id") or e.get("consuming_shipment"), "tx": e.get("tx_hash"),
                             "block": e.get("block_number"), "status": "success" if e.get("receipt_status") == 1 else ("reverted" if e.get("reverted") else e.get("event")),
                             "revert_reason": (e.get("error") or {}).get("name") if isinstance(e.get("error"), dict) else e.get("reason"),
                             "note": e.get("reason") or e.get("note")} for e in events]}
    s, recs = _find(store, cid)
    a, st, rec = _status(store, cid)
    cert = (s or {}).get("certificate") or {}
    ev = cert.get("evidence_hash") or next((r.get("evidence_hash") for r in recs if r.get("evidence_hash")), None)
    return {"certificate_id": cid, "shipment_ref": s["id"] if s else recs[0].get("ref"), "verdict": cert.get("verdict"),
            "evidence_hash": ev, "status": st["status"], "status_source": st["source"], "chain": chain.info(a),
            "onchain_record": rec.get("record"),
            "records": [{k: r.get(k) for k in ("kind", "ref", "tx", "block", "status", "revert_reason", "note")} for r in recs]}


def canonical_bundle(store: DatasetStore, shipment_id: str) -> dict:
    """Rebuild the canonical evidence bundle; `eligible` is False for anything but a PASS decision."""
    from rastro.certificates.bundle import EligibilityError, build_bundle, commit, evidence_hash
    eligible, reason = True, None
    try:
        b = build_bundle(store.dir, shipment_id, svc=store.lineage_service())
    except EligibilityError as e:
        eligible, reason = False, str(e)
        try:
            b = build_bundle(store.dir, shipment_id, svc=store.lineage_service(), require_pass=False)
        except EligibilityError as e2:
            raise APIError(409, "assessment_unavailable", str(e2)) from None
    return {"shipment_id": shipment_id, "eligible_for_clean_certificate": eligible, "ineligibility_reason": reason,
            "evidence_hash": evidence_hash(b), "shipment_commitment": commit(shipment_id),
            "lot_commitment": b["shipment"]["lot_commitment"], "policy_version": b["policy_version"], "bundle": b}


def _now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


_HEX32 = re.compile(r"^0x[0-9a-fA-F]{64}$")
_ADDR = re.compile(r"^0x[0-9a-fA-F]{40}$")


def _check_payload(cert: dict, dom: dict) -> None:
    """Supplied certificates are untrusted: every field is type-checked before it is hashed or used to
    locate a stored file (an evidenceHash is used as a file name)."""
    bad = [k for k in ("lotId", "sink", "shipment", "evidenceHash") if not _HEX32.match(str(cert.get(k, "")))]
    if not isinstance(cert.get("gtaHashes"), list) or not cert["gtaHashes"] or not all(_HEX32.match(str(x)) for x in cert["gtaHashes"]):
        bad.append("gtaHashes")
    for k in ("head", "verdict", "issuedAt", "expiresAt", "policyVersion", "nonce"):
        try:
            if int(cert.get(k)) < 0:
                bad.append(k)
        except (TypeError, ValueError):
            bad.append(k)
    if dom and (not _ADDR.match(str(dom.get("verifyingContract", ""))) or not str(dom.get("chainId", "")).isdigit()):
        bad.append("domain")
    if bad:
        raise APIError(422, "invalid_certificate", "malformed certificate fields", {"fields": sorted(set(bad))})


def verify_signed(store: DatasetStore, cid: str, payload: dict | None) -> dict | None:
    """Independent verification of an EIP-712 certificate: domain, signature, signer authority,
    evidence integrity, assessment currency and ledger state. Each check is reported on its own."""
    from rastro.certificates.bundle import evidence_hash
    from rastro.certificates.jcs import canonicalize

    stored, events = _issued(store, cid)
    src = payload if payload and payload.get("certificate") else stored
    if not src:
        return None
    cert, sig, dom = src["certificate"], src.get("signature"), src.get("domain") or {}
    _check_payload(cert, dom)
    if cert.get("lotId", "").lower() != cid:
        raise APIError(422, "certificate_mismatch", "the supplied certificate's lotId is not the requested certificate id")
    a = chain.adapter(store)
    ci = chain.info(a)
    checks = []

    def add(name, ok, detail):
        checks.append({"check": name, "ok": ok, "detail": detail})

    # 1. domain: the signature must be for this chain and this contract
    want_chain, want_addr = ci.get("chain_id"), (ci.get("address") or "").lower()
    add("chain_id", None if want_chain is None else int(dom.get("chainId", -1)) == int(want_chain),
        f"signed for chain {dom.get('chainId')}, configured ledger is chain {want_chain}")
    add("verifying_contract", None if not want_addr else (dom.get("verifyingContract") or "").lower() == want_addr,
        f"signed for {dom.get('verifyingContract')}, configured ledger is {ci.get('address')}")
    # 2. signature -> signer, and the signer's authority on the ledger
    signer = None
    try:
        signer = recover(digest(cert, int(dom.get("chainId", 0)), dom.get("verifyingContract", "0x" + "00" * 20)), sig or "")
        add("signature", True, f"EIP-712 signature recovers {signer}")
    except (InvalidSignature, ValueError, KeyError) as e:
        add("signature", False, f"signature does not verify: {e}")
    if signer:
        try:
            o = a.is_oracle(signer)
            add("signer_is_oracle", o["is_oracle"], f"isOracle({signer}) = {o['is_oracle']} ({o['source']})")
        except (ChainUnavailable, ContractRevert) as e:
            add("signer_is_oracle", None, f"could not query the ledger: {e}")
    # 3. evidence integrity from the exact canonical bytes
    h = cert.get("evidenceHash", "").lower()
    if payload and payload.get("bundle") is not None:
        raw = canonicalize(payload["bundle"])
        add("evidence_hash", "0x" + hashlib.sha256(raw).hexdigest() == h, "supplied bundle re-canonicalised (RFC 8785) and re-hashed")
        present = True
    else:
        f = store.dir / "certificates" / "bundles" / f"{h.removeprefix('0x')}.json"
        present = f.is_file()
        if present:
            raw = f.read_bytes()
            canonical = canonicalize(json.loads(raw)) == raw
            add("evidence_hash", "0x" + hashlib.sha256(raw).hexdigest() == h and canonical,
                "stored bundle bytes re-hashed" + ("" if canonical else "; the stored file is not in canonical form"))
        else:
            add("evidence_hash", None, "evidence bundle unavailable: integrity could not be independently checked")
    # 4. is the assessment behind it still the current canonical one?
    issue = next((e for e in events if e.get("event") == "issue" and e.get("receipt_status") == 1), {})
    sid = issue.get("shipment_id")
    if sid and store.get("shipments", sid):
        try:
            from rastro.certificates.issue import ledger_gta_hashes
            from rastro.certificates.bundle import build_bundle
            now_b = build_bundle(store.dir, sid, svc=store.lineage_service(), require_pass=False, gta_hashes=ledger_gta_hashes(store.dir))
            add("assessment_current", evidence_hash(now_b) == h,
                "rebuilt from the current canonical outputs" + ("" if evidence_hash(now_b) == h else ": the data or decision changed since issuance"))
        except Exception as e:  # noqa: BLE001 - reported, never hidden
            add("assessment_current", None, f"could not rebuild the bundle: {e}")
    # 5. ledger state
    try:
        st = a.certificate_status(cid)
        rec = (a.certificate_record(cid) or {}).get("record") or {}
    except (ChainUnavailable, ContractRevert) as e:
        st, rec = {"status": "unknown", "source": "unavailable"}, {}
        add("ledger_status", None, f"ledger unavailable: {e}")
    status = st["status"]
    if rec:
        add("ledger_evidence_hash", (rec.get("evidenceHash") or "").lower() == h, f"ledger stores {rec.get('evidenceHash')}")
        add("ledger_shipment", (rec.get("shipment") or "").lower() == cert.get("shipment", "").lower(), f"ledger binds shipment {rec.get('shipment')}")
        if signer:
            add("ledger_oracle", (rec.get("oracle") or "").lower() == signer.lower(), f"ledger records oracle {rec.get('oracle')}")
    elif st.get("source") == "recorded":
        add("ledger_record", None, "no live node: the stored struct cannot be read (recorded replay only)")
    exp = int(cert.get("expiresAt", 0))
    add("not_expired", exp > time.time(), f"expires at {datetime.fromtimestamp(exp, timezone.utc).isoformat()}")
    add("ledger_status", status == "valid", f"certificateStatus = {status} ({st.get('source')})")

    failed = [x for x in checks if x["ok"] is False]
    unknown = [x for x in checks if x["ok"] is None]
    if status == "none":
        outcome, reason = "not_on_ledger", "the ledger has no certificate with this id"
    elif any(x["check"] in ("chain_id", "verifying_contract", "signature", "signer_is_oracle", "evidence_hash", "ledger_evidence_hash",
                            "ledger_shipment", "ledger_oracle") for x in failed):
        outcome, reason = "invalid", "; ".join(f"{x['check']}: {x['detail']}" for x in failed)
    elif status in ("consumed", "revoked", "expired", "not_clean"):
        outcome, reason = status, f"the ledger reports the certificate as {status}"
    elif not exp > time.time():
        outcome, reason = "expired", "past its signed expiry"
    elif unknown:
        outcome, reason = "unverifiable", "; ".join(f"{x['check']}: {x['detail']}" for x in unknown)
    else:
        outcome, reason = "valid", "signature, signer, evidence and ledger state all check out; the certificate can be consumed once"
    ev_ok = next((x["ok"] for x in checks if x["check"] == "evidence_hash"), None)
    on_ok = next((x["ok"] for x in checks if x["check"] == "ledger_evidence_hash"), None)
    notes = [] if ci.get("verified_public") else [ci.get("label")]
    return {"certificate_id": cid, "evidence_file_present": present, "evidence_hash_matches": ev_ok, "onchain_hash_matches": on_ok,
            "status": status, "usable": outcome == "valid", "chain": ci, "notes": notes, "outcome": outcome, "reason": reason,
            "checks": checks, "signer": signer, "certificate": cert, "verified_at": _now()}


def verify(store: DatasetStore, cid: str, payload: dict | None = None) -> dict:
    full = verify_signed(store, cid, payload)
    if full is not None:
        return full
    c = get(store, cid)
    notes = []
    h = c["evidence_hash"]
    ref = c["shipment_ref"] or ""
    if CANONICAL.match(ref) and store.get("shipments", ref):
        bundle = canonical_bundle(store, ref)
        present, ok = True, bundle["evidence_hash"] == h
        notes.append("evidence re-hashed from the canonical RFC 8785 bundle (rastro.certificates.bundle)")
    else:
        present, ok = evidence.check(store.web / "evidence" / f"{(h or '').removeprefix('0x')}.json", h) if h else (False, None)
        if not present:
            notes.append("evidence file not published: the hash cannot be recomputed")
    recorded = {r.get("evidence_hash") for r in (store.web_json("onchain.json") or {}).get("records", [])
                if r.get("lot_id") == cid and r.get("kind") == "issueCertificate" and r.get("evidence_hash")}
    rec = c.get("onchain_record") or {}
    if rec.get("evidenceHash"):
        recorded.add(rec["evidenceHash"])
    on_ok = (h in recorded) if recorded else None
    if on_ok is None:
        notes.append("no on-chain issuance record with an evidence hash")
    if not c["chain"]["verified_public"]:
        notes.append(c["chain"]["label"])
    if c["status"] != "valid":
        notes.append(f"certificate status is {c['status']}: it cannot back a shipment or an EUDR statement")
    return {"certificate_id": cid, "evidence_file_present": present, "evidence_hash_matches": ok, "onchain_hash_matches": on_ok,
            "status": c["status"], "usable": c["status"] == "valid" and ok is True and on_ok is not False,
            "chain": c["chain"], "notes": notes}


def registry(store: DatasetStore) -> list[dict]:
    p = store.dir / "certificates" / "registry.jsonl"
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l] if p.is_file() else []


def report(store: DatasetStore, cid: str) -> dict:
    """Evidence export for an issued certificate: canonical bundle + signature + chain receipt + a fresh verification."""
    signed, events = _issued(store, cid)
    if not signed:
        raise APIError(404, "not_found", f"no issued canonical certificate {cid} (published demo certificates: use /verify)")
    v = verify_signed(store, cid, None)
    bpath = store.dir / "certificates" / signed["bundle_path"]
    bundle = json.loads(bpath.read_text(encoding="utf-8")) if bpath.is_file() else None
    issue = next((e for e in events if e.get("event") == "issue" and e.get("receipt_status") == 1), {})
    return {"report_schema": "rastro.certificate-report/1.0.0", "certificate_id": cid, "generated_at": _now(),
            "verification": v, "evidence_bundle": bundle,
            "evidence_bundle_note": "the bundle is reproduced exactly; re-serialise with RFC 8785 and SHA-256 to recompute the evidence hash"
            if bundle else "evidence bundle unavailable: integrity could not be independently checked",
            "signature": {"signer": signed.get("signer"), "signature": signed.get("signature"), "eip712_domain": signed.get("domain"),
                          "eip712_digest": signed.get("digest"), "certificate": signed.get("certificate")},
            "chain": {"chain_id": issue.get("chain_id"), "contract": issue.get("contract"), "network": issue.get("network"),
                      "issue_tx": issue.get("tx_hash"), "issue_block": issue.get("block_number"),
                      "label": v["chain"]["label"], "verified_public": v["chain"]["verified_public"]},
            "history": events}


def report_html(rep: dict) -> str:
    import html
    e = lambda x: html.escape("" if x is None else str(x))  # noqa: E731
    v, b, sig, ch = rep["verification"], rep["evidence_bundle"] or {}, rep["signature"], rep["chain"]
    ship, dec, lin = b.get("shipment", {}), b.get("decision", {}), b.get("lineage", {})
    checks = "".join(f"<tr><td>{e(c['check'])}</td><td class='{ {True: 'ok', False: 'bad', None: 'na'}[c['ok']] }'>"
                     f"{ {True: 'pass', False: 'FAIL', None: 'not checkable'}[c['ok']] }</td><td>{e(c['detail'])}</td></tr>" for c in v["checks"])
    sources = "".join(f"<tr><td>{e(s['origin_key'])}</td><td>{e(s['origin_kind'])}</td><td class='n'>{s['head_equiv']:.1f}</td>"
                      f"<td class='n'>{s['share_pct']:.1f}%</td><td>{e(', '.join(s['categories']) or '-')}</td></tr>" for s in lin.get("sources", [])[:40])
    findings = "".join(f"<tr><td>{e(f['code'])}</td><td>{e(f['severity'])}</td><td>{e(f['entity_id'])}</td><td>{e(f['explanation'])}</td></tr>"
                       for f in b.get("findings", []))
    hist = "".join(f"<tr><td>{e(h.get('logged_at'))}</td><td>{e(h.get('event'))}</td><td class='mono'>{e(h.get('tx_hash') or '-')}</td>"
                   f"<td>{e(h.get('block_number') or '-')}</td><td>{e((h.get('error') or {}).get('name') if isinstance(h.get('error'), dict) else h.get('reason') or '')}</td></tr>"
                   for h in rep["history"])
    lim = "".join(f"<li>{e(x)}</li>" for x in b.get("limitations", []) + lin.get("uncertainty_notes", []))
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rastro certificate report</title><style>
body{{font:14px/1.45 system-ui,sans-serif;color:#23231f;background:#faf8f3;margin:0;padding:24px;max-width:980px}}
h1{{font-size:20px;margin:0 0 4px}}h2{{font-size:15px;margin:22px 0 6px;color:#2f5d3a}}.muted{{color:#6b675d}}
.banner{{background:#fff4dc;border:1px solid #e0c27a;padding:8px 12px;border-radius:6px;margin:12px 0}}
table{{border-collapse:collapse;width:100%;background:#fff;font-size:13px}}td,th{{border:1px solid #e3ded2;padding:4px 6px;text-align:left;vertical-align:top}}
.n{{text-align:right}}.mono,code{{font-family:ui-monospace,monospace;font-size:12px;word-break:break-all}}.ok{{color:#2f5d3a}}.bad{{color:#a63a2b;font-weight:600}}.na{{color:#8a6a1e}}
.outcome{{font-size:16px;font-weight:600}}</style></head><body>
<h1>Rastro certificate report</h1>
<div class="muted">Certificate <span class="mono">{e(rep['certificate_id'])}</span> · generated {e(rep['generated_at'])}</div>
<div class="banner">Synthetic demonstration: ranches, herds and permits are simulated. {e(ch['label'])}. A clean certificate states the screening outcome under policy version {e(b.get('policy_version'))}; it is not a legal determination.</div>
<h2>Verification ({e(v['verified_at'])})</h2>
<p class="outcome">Outcome: {e(v['outcome'])}</p><p>{e(v['reason'])}</p>
<table><tr><th>Check</th><th>Result</th><th>Detail</th></tr>{checks}</table>
<h2>Shipment</h2><table>
<tr><td>Shipment</td><td class="mono">{e(ship.get('shipment_id'))} (commitment {e(ship.get('commitment'))})</td></tr>
<tr><td>Destination</td><td>{e(ship.get('destination_id'))}</td></tr><tr><td>Date</td><td>{e(ship.get('shipment_date'))}</td></tr>
<tr><td>Declared head</td><td>{e(ship.get('declared_head'))}</td></tr><tr><td>Permits</td><td class="mono">{e(', '.join(ship.get('gta_ids', [])))}</td></tr>
<tr><td>Decision</td><td>{e(dec.get('outcome'))} (assessed {e(dec.get('assessed_at'))})</td></tr>
<tr><td>Provenance</td><td>{e(b.get('provenance', {}).get('notice'))}</td></tr>
<tr><td>Dataset</td><td class="mono">{e(b.get('dataset', {}).get('dataset_id'))} @ {e(b.get('dataset', {}).get('logical_digest'))}</td></tr>
<tr><td>Detector</td><td>{e(b.get('detector_version'))}</td></tr></table>
<h2>Lineage ({e(lin.get('policy'))} estimate, coverage {e(lin.get('coverage_pct'))}%, up to {e(lin.get('max_hops'))} hops)</h2>
<table><tr><th>Origin</th><th>Kind</th><th>Head</th><th>Share</th><th>Categories</th></tr>{sources}</table>
<h2>Findings</h2><table><tr><th>Code</th><th>Severity</th><th>Entity</th><th>Explanation</th></tr>{findings or '<tr><td colspan=4>none</td></tr>'}</table>
<h2>Evidence commitment and signature</h2><table>
<tr><td>Evidence hash (SHA-256, RFC 8785 bytes)</td><td class="mono">{e(sig['certificate'].get('evidenceHash') if sig.get('certificate') else '')}</td></tr>
<tr><td>Signer (oracle)</td><td class="mono">{e(sig.get('signer'))}</td></tr><tr><td>EIP-712 digest</td><td class="mono">{e(sig.get('eip712_digest'))}</td></tr>
<tr><td>Signature</td><td class="mono">{e(sig.get('signature'))}</td></tr>
<tr><td>Chain / contract</td><td class="mono">{e(ch.get('chain_id'))} / {e(ch.get('contract'))}</td></tr>
<tr><td>Issue transaction</td><td class="mono">{e(ch.get('issue_tx') or 'none')} (block {e(ch.get('issue_block') or '-')})</td></tr></table>
<h2>History</h2><table><tr><th>Logged</th><th>Event</th><th>Tx</th><th>Block</th><th>Error / reason</th></tr>{hist}</table>
<h2>Limitations and uncertainty</h2><ul>{lim}</ul>
</body></html>"""
