"""Lineage tracing via the pipeline's LineageService (cached per input fingerprint)."""
from app.observability import APIError
from app.store import DatasetStore


def _svc(store: DatasetStore):
    if not store.exists("ranches"):
        raise APIError(503, "dataset_unavailable", "canonical dataset not found")
    return store.lineage_service()


def trace_lot(store: DatasetStore, lot_id: str, policy: str) -> dict:
    gta_id = lot_id.removeprefix("LOT-")
    if store.get("gtas", gta_id) is None:
        raise APIError(404, "not_found", f"lot {lot_id} not found")
    return _svc(store).trace_lot(lot_id, policy)


def trace_gta(store: DatasetStore, gta_id: str, policy: str = "fifo") -> dict:
    return _svc(store).trace_gta(gta_id, policy)


def shipment_trace(store: DatasetStore, shipment_id: str) -> dict:
    """Precomputed FIFO trace when present (rewritten whenever the pipeline reruns), else computed now."""
    t = store.get("lineage", shipment_id)
    return t if t is not None else _svc(store).trace_shipment(shipment_id)
