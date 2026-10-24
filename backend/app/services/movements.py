"""GTA and movement queries, with ledger status from the derived refusals (no replay here)."""
from app.observability import APIError
from app.store import DatasetStore


def view(store: DatasetStore, g: dict) -> dict:
    refused = {r["event_ref"]: r["reason"] for r in store.rows("refusals") or []}
    ship = store.by("shipments", "gta_ids").get(g["gta_id"], [])
    if g["permit_status"] != "issued":
        status, reason = "not_moved", g["permit_status"]
    elif g["gta_id"] in refused:
        status, reason = "refused", refused[g["gta_id"]]
    else:
        status, reason = "accepted", None
    return {"movement": g, "ledger_status": status, "refusal_reason": reason, "shipment_id": ship[0]["shipment_id"] if ship else None}


def require(store: DatasetStore, gta_id: str) -> dict:
    g = store.get("gtas", gta_id)
    if g is None:
        raise APIError(404, "not_found", f"GTA {gta_id} not found")
    return g


def listing(store: DatasetStore, ranch=None, date_from=None, date_to=None, status=None, purpose=None) -> list[dict]:
    rows = store.rows("gtas") or []
    if ranch:
        rows = [g for g in rows if ranch in (g["origin_id"], g["destination_id"])]
    if date_from:
        rows = [g for g in rows if g["movement_date"] >= date_from]
    if date_to:
        rows = [g for g in rows if g["movement_date"] <= date_to]
    if purpose:
        rows = [g for g in rows if g["purpose"] == purpose]
    out = [view(store, g) for g in sorted(rows, key=lambda g: (g["movement_date"], g["gta_id"]))]
    return [v for v in out if v["ledger_status"] == status] if status else out


def of_ranch(store: DatasetStore, ranch_id: str, direction: str) -> list[dict]:
    out = store.by("gtas", "origin_id").get(ranch_id, []) if direction in ("out", "all") else []
    inn = store.by("gtas", "destination_id").get(ranch_id, []) if direction in ("in", "all") else []
    return [view(store, g) for g in sorted(out + inn, key=lambda g: (g["movement_date"], g["gta_id"]))]
