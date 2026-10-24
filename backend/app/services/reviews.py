"""Investigator annotations: an append-only log next to (never inside) the machine findings.

A review records who looked at a finding, what they concluded and why, the request id, and the
finding's evidence hash at that moment. It never edits the finding, its evidence hash, a decision
or anything on-chain. Dismissing a blocking finding leaves a FLAGGED decision FLAGGED.
"""
import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from app.config import get_settings
from app.observability import APIError, request_id
from app.store import DatasetStore

_lock = threading.Lock()


def log_path(store: DatasetStore) -> Path:
    base = get_settings().state_dir or (store.dir / "derived" / "reviews")
    return base / "annotations.jsonl"


def history(store: DatasetStore, finding_id: str | None = None) -> list[dict]:
    p = log_path(store)
    if not p.is_file():
        return []
    rows = [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]
    return [r for r in rows if finding_id is None or r["finding_id"] == finding_id]


def current(store: DatasetStore) -> dict[str, str]:
    out = {}
    for r in history(store):
        out[r["finding_id"]] = r["status"]
    return out


def finding(store: DatasetStore, finding_id: str) -> dict:
    hit = store.by("findings", "finding_id").get(finding_id)
    if not hit:
        raise APIError(404, "not_found", f"finding {finding_id} not found")
    return hit[0]


def impact(store: DatasetStore, f: dict, status: str) -> list[dict]:
    """Decisions that cite this finding, and what the review means for them (always: unchanged)."""
    out = []
    for d in store.rows("decisions") or []:
        blocking = f["finding_id"] in d["blocking_finding_ids"]
        if not blocking and f["finding_id"] not in d["review_finding_ids"]:
            continue
        note = "decision unchanged: reviews annotate findings and never alter the machine decision"
        if blocking and status == "dismissed":
            note = "investigator disputes; blocking rule still applies"
        out.append({"shipment_id": d["shipment_id"], "outcome": d["outcome"], "role": "blocking" if blocking else "review", "note": note})
    return out


def add(store: DatasetStore, finding_id: str, status: str, reason: str | None, reviewer: str) -> dict:
    f = finding(store, finding_id)
    entry = {"review_id": "RV-" + uuid.uuid4().hex[:12], "finding_id": finding_id, "status": status, "reason": reason, "reviewer": reviewer,
             "at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "request_id": request_id.get(),
             "finding_evidence_hash": f["evidence_hash"], "finding_code": f["code"], "finding_blocking": f["blocking"]}
    p = log_path(store)
    with _lock:
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")
    return entry


def view(store: DatasetStore, finding_id: str) -> dict:
    f = finding(store, finding_id)
    h = history(store, finding_id)
    status = h[-1]["status"] if h else "unreviewed"
    return {"finding": f, "review_status": status, "reviews": h, "decision_impact": impact(store, f, status)}
