"""/api/v1 over the canonical dataset: ranches, movements, lineage, risk, shipments, certificates, chain."""
from functools import lru_cache
from typing import Literal

from fastapi import APIRouter, Body, Depends, Path, Query
from fastapi.responses import JSONResponse, PlainTextResponse, Response

from app.config import get_settings
from app.observability import APIError
from app.schemas import api as S
from app.services import (certificates, chain, evaluation, health, investigation, lineage, movements, ranches, reviews, risk,
                          shipments)
from app.store import DatasetStore

RANCH = r"^(R\d{4}|X\d{2,})$"
GTA = r"^GTA-[A-Z]{2}-(\d{4}-\d{6}|ATTEMPT-\d{4})$"
LOT = r"^LOT-GTA-[A-Z]{2}-(\d{4}-\d{6}|ATTEMPT-\d{4})$"
SHIPMENT = r"^SHP-[DV]-\d{1,8}$"
CERT = r"^0x[0-9a-fA-F]{64}$"
FINDING = r"^F-[0-9a-f]{16}$"
NODE = r"^(R\d{4}|X\d{2,}|UNRESOLVED#GTA-[A-Z0-9-]+|S:[A-Z]{3}_[A-Z0-9_]+|P:[A-Z]+)$"

router = APIRouter(prefix="/api/v1")


@lru_cache
def _store(dataset_dir, web_dir) -> DatasetStore:
    return DatasetStore(dataset_dir, web_dir)


def get_store() -> DatasetStore:
    s = get_settings()
    return _store(s.dataset_dir, s.data_dir)


def page(rows: list, limit: int, offset: int, store: DatasetStore) -> dict:
    return {"meta": store.provenance(), "page": {"limit": limit, "offset": offset, "total": len(rows)}, "data": rows[offset:offset + limit]}


def item(data, store: DatasetStore) -> dict:
    return {"meta": store.provenance(), "data": data}


Limit = Query(50, ge=1, le=500)
Offset = Query(0, ge=0)


# ---- system --------------------------------------------------------------------------------------
@router.get("/ready", response_model=S.Ready, tags=["system"], responses={503: {"description": "not ready"}})
def ready(store: DatasetStore = Depends(get_store)):
    from fastapi.responses import JSONResponse
    r = health.ready(store)
    return r if r["ready"] else JSONResponse(status_code=503, content=r)


@router.get("/summary", response_model=S.Item[dict], tags=["system"])
def summary(store: DatasetStore = Depends(get_store)):
    return item(health.summary(store), store)


# ---- ranches -------------------------------------------------------------------------------------
@router.get("/ranches", response_model=S.Items[S.RanchSummary], tags=["ranches"])
def list_ranches(role: Literal["breeder", "rearer", "fattener", "intermediary", "external"] | None = None,
                 risk_class: Literal["high", "watch", "clean", "insufficient_data"] | None = None,
                 entity_type: Literal["ranch", "external_supplier"] | None = None,
                 q: str | None = Query(None, min_length=1, max_length=40, pattern=r"^[A-Za-z0-9 _-]+$"),
                 limit: int = Limit, offset: int = Offset, store: DatasetStore = Depends(get_store)):
    return page(ranches.listing(store, role, risk_class, entity_type, q), limit, offset, store)


@router.get("/ranches/{ranch_id}", response_model=S.Item[S.RanchDetail], tags=["ranches"])
def get_ranch(ranch_id: str = Path(pattern=RANCH), store: DatasetStore = Depends(get_store)):
    return item(ranches.detail(store, ranch_id), store)


@router.get("/ranches/{ranch_id}/movements", response_model=S.Items[S.MovementView], tags=["ranches"])
def ranch_movements(ranch_id: str = Path(pattern=RANCH), direction: Literal["in", "out", "all"] = "all",
                    limit: int = Limit, offset: int = Offset, store: DatasetStore = Depends(get_store)):
    ranches.require(store, ranch_id)
    return page(movements.of_ranch(store, ranch_id, direction), limit, offset, store)


@router.get("/ranches/{ranch_id}/risk", response_model=S.Item[S.RanchRiskView], tags=["ranches", "risk"])
def ranch_risk(ranch_id: str = Path(pattern=RANCH), store: DatasetStore = Depends(get_store)):
    return item(ranches.risk(store, ranch_id), store)


@router.get("/ranches/{ranch_id}/balance", response_model=S.Item[dict], tags=["chain"])
def ranch_balance(ranch_id: str = Path(pattern=RANCH), store: DatasetStore = Depends(get_store)):
    ranches.require(store, ranch_id)
    return item(chain.balance(store, ranch_id), store)


# ---- GTAs and lots -------------------------------------------------------------------------------
@router.get("/gtas", response_model=S.Items[S.GtaDetail], tags=["movements"])
def list_gtas(ranch: str | None = Query(None, pattern=RANCH), date_from: str | None = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
              date_to: str | None = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
              status: Literal["accepted", "refused", "not_moved"] | None = None,
              purpose: Literal["breeding", "rearing", "fattening", "slaughter", "export"] | None = None,
              limit: int = Limit, offset: int = Offset, store: DatasetStore = Depends(get_store)):
    """Movement permits of the canonical dataset with their ledger status, filterable and paginated."""
    return page(movements.listing(store, ranch, date_from, date_to, status, purpose), limit, offset, store)


@router.get("/gtas/{gta_id}", response_model=S.Item[S.GtaDetail], tags=["movements"])
def get_gta(gta_id: str = Path(pattern=GTA), include_lineage: bool = False, store: DatasetStore = Depends(get_store)):
    g = movements.require(store, gta_id)
    out = movements.view(store, g)
    if include_lineage:
        out["lineage"] = lineage.trace_gta(store, gta_id)
    return item(out, store)


@router.get("/lots/{lot_id}/lineage", response_model=S.Item[S.LineageTrace], tags=["lineage"])
def lot_lineage(lot_id: str = Path(pattern=LOT), policy: Literal["fifo", "pro_rata"] = "fifo", store: DatasetStore = Depends(get_store)):
    return item(lineage.trace_lot(store, lot_id, policy), store)


# ---- shipments -----------------------------------------------------------------------------------
@router.get("/shipments", response_model=S.Items[S.ShipmentSummary], tags=["shipments"])
def list_shipments(kind: Literal["delivery", "voyage"] | None = None, outcome: Literal["PASS", "REVIEW", "FLAGGED"] | None = None,
                   destination: str | None = Query(None, pattern=r"^(S:[A-Z]{3}_[A-Z0-9_]+|P:[A-Z]+)$"),
                   limit: int = Limit, offset: int = Offset, store: DatasetStore = Depends(get_store)):
    return page(shipments.listing(store, kind, outcome, destination), limit, offset, store)


@router.get("/shipments/{shipment_id}", response_model=S.Item[S.ShipmentDetail], tags=["shipments"])
def get_shipment(shipment_id: str = Path(pattern=SHIPMENT), store: DatasetStore = Depends(get_store)):
    return item(shipments.detail(store, shipment_id), store)


@router.get("/shipments/{shipment_id}/risk", response_model=S.Item[S.ShipmentRiskDetail], tags=["shipments", "risk"])
def shipment_risk(shipment_id: str = Path(pattern=SHIPMENT), store: DatasetStore = Depends(get_store)):
    v = shipments.risk_view(store, shipment_id)
    status = reviews.current(store)
    v["breakdown"] = investigation.breakdown(store, shipment_id)
    v["clearing_steps"] = investigation.clearing_steps(store, shipment_id, v["decision"], status)
    ids = {f["finding_id"] for fs in v["findings_by_category"].values() for f in fs}
    v["review_status"] = {i: status.get(i, "unreviewed") for i in sorted(ids)}
    return item(v, store)


@router.get("/shipments/{shipment_id}/lineage/graph", response_model=S.Item[S.LineageGraph], tags=["shipments", "lineage"])
def shipment_graph(shipment_id: str = Path(pattern=SHIPMENT), max_nodes: int | None = Query(None, ge=5, le=500),
                   expand: str | None = Query(None, pattern=NODE), store: DatasetStore = Depends(get_store)):
    return item(investigation.graph(store, shipment_id, max_nodes, expand), store)


@router.get("/shipments/{shipment_id}/lineage/report", tags=["shipments", "lineage"],
            responses={200: {"model": S.LineageReport, "content": {"text/markdown": {}, "text/csv": {}}}})
def shipment_report(shipment_id: str = Path(pattern=SHIPMENT), format: Literal["json", "md", "csv"] = "json",
                    store: DatasetStore = Depends(get_store)):
    shipments.require(store, shipment_id)
    rep = investigation.report(store, shipment_id)
    if format == "md":
        return PlainTextResponse(investigation.report_md(rep), media_type="text/markdown")
    if format == "csv":
        return PlainTextResponse(investigation.report_csv(rep), media_type="text/csv",
                                 headers={"Content-Disposition": f'attachment; filename="{shipment_id}-lineage.csv"'})
    return JSONResponse(S.LineageReport.model_validate(rep).model_dump(mode="json", by_alias=True))


@router.get("/shipments/{shipment_id}/evidence/download", tags=["shipments", "evidence"],
            responses={200: {"content": {"application/zip": {}}}})
def shipment_bundle(shipment_id: str = Path(pattern=SHIPMENT), store: DatasetStore = Depends(get_store)):
    shipments.require(store, shipment_id)
    data = investigation.bundle_zip(store, shipment_id, reviews.history(store))
    return Response(data, media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{shipment_id}-evidence.zip"'})


# ---- findings and investigator reviews ---------------------------------------------------------------
@router.get("/findings/{finding_id}", response_model=S.Item[S.FindingView], tags=["findings"])
def get_finding(finding_id: str = Path(pattern=FINDING), store: DatasetStore = Depends(get_store)):
    return item(reviews.view(store, finding_id), store)


@router.post("/findings/{finding_id}/reviews", response_model=S.Item[S.FindingView], status_code=201, tags=["findings"])
def add_review(body: S.ReviewRequest, finding_id: str = Path(pattern=FINDING), store: DatasetStore = Depends(get_store)):
    if body.status in ("confirmed", "dismissed") and len((body.reason or "").strip()) < 10:
        raise APIError(422, "invalid_request", "a reason of at least 10 characters is required to confirm or dismiss a finding")
    reviews.add(store, finding_id, body.status, body.reason, body.reviewer)
    return item(reviews.view(store, finding_id), store)


@router.get("/shipments/{shipment_id}/evidence", response_model=S.Item[S.ShipmentEvidence], tags=["shipments", "evidence"])
def shipment_evidence(shipment_id: str = Path(pattern=SHIPMENT), store: DatasetStore = Depends(get_store)):
    return item(shipments.evidence_view(store, shipment_id), store)


@router.post("/shipments/{shipment_id}/assess", response_model=S.Item[S.Assessment], tags=["shipments", "risk"])
def assess(shipment_id: str = Path(pattern=SHIPMENT), body: S.AssessRequest = Body(default_factory=S.AssessRequest),
           store: DatasetStore = Depends(get_store)):
    shipments.require(store, shipment_id)
    return item(risk.assess(store, shipment_id, body.recompute), store)


# ---- certificates and chain ------------------------------------------------------------------------
@router.get("/certificates", response_model=S.Items[S.CertificateEvent], tags=["certificates"])
def list_certificates(event: str | None = Query(None, pattern=r"^[a-z_]{3,20}$"), limit: int = Query(100, ge=1, le=500),
                      offset: int = Query(0, ge=0), store: DatasetStore = Depends(get_store)):
    """The issuance registry: issued, refused, rejected and replayed certificates, newest first."""
    rows = certificates.registry(store)
    if event:
        rows = [r for r in rows if r.get("event") == event]
    return page(rows[::-1], limit, offset, store)


@router.get("/certificates/{certificate_id}/report", tags=["certificates"])
def certificate_report(certificate_id: str = Path(pattern=CERT), format: Literal["json", "html"] = "html",
                       store: DatasetStore = Depends(get_store)):
    """Downloadable evidence: the exact canonical bundle with verification and chain metadata (JSON), or a printable HTML report."""
    rep = certificates.report(store, certificate_id.lower())
    name = f"rastro-certificate-{certificate_id[2:14]}"
    if format == "json":
        return JSONResponse(rep, headers={"Content-Disposition": f'attachment; filename="{name}.json"'})
    return Response(certificates.report_html(rep), media_type="text/html; charset=utf-8",
                    headers={"Content-Disposition": f'inline; filename="{name}.html"'})


@router.get("/certificates/{certificate_id}", response_model=S.Item[S.CertificateView], tags=["certificates"])
def get_certificate(certificate_id: str = Path(pattern=CERT), store: DatasetStore = Depends(get_store)):
    return item(certificates.get(store, certificate_id.lower()), store)


@router.post("/certificates/{certificate_id}/verify", response_model=S.Item[S.VerifyResult], tags=["certificates"])
def verify_certificate(body: S.VerifyRequest | None = None, certificate_id: str = Path(pattern=CERT),
                       store: DatasetStore = Depends(get_store)):
    return item(certificates.verify(store, certificate_id.lower(), body.model_dump(exclude_none=True) if body else None), store)


@router.post("/certificates/{certificate_id}/consume-request", response_model=S.Item[S.PreparedTx], tags=["certificates", "chain"])
def consume_request(body: S.ConsumeRequest, certificate_id: str = Path(pattern=CERT), store: DatasetStore = Depends(get_store)):
    """Unsigned consumeCertificate calldata for the buyer's wallet. The API never signs or submits."""
    if bool(body.shipment_id) == bool(body.ref_hash):
        raise APIError(422, "invalid_request", "give exactly one of shipment_id or ref_hash")
    certificates.get(store, certificate_id.lower())
    ref = body.ref_hash or chain.onchain_id(body.shipment_id)
    return item(chain.prepare(store, certificate_id.lower(), body.use, ref), store)


@router.get("/shipments/{shipment_id}/certificate/bundle", response_model=S.Item[S.CertificateBundle], tags=["certificates"])
def certificate_bundle(shipment_id: str = Path(pattern=SHIPMENT), store: DatasetStore = Depends(get_store)):
    """Canonical RFC 8785 evidence bundle and its SHA-256, as the oracle would sign it. Only PASS lots are eligible."""
    shipments.require(store, shipment_id)
    return item(certificates.canonical_bundle(store, shipment_id), store)


@router.get("/chain/status", response_model=S.Item[dict], tags=["chain"])
def chain_status(store: DatasetStore = Depends(get_store)):
    return item(chain.status(store), store)


# ---- evaluation -----------------------------------------------------------------------------------
@router.get("/evaluation/summary", response_model=S.Item[S.EvaluationSummary], tags=["evaluation"])
def evaluation_summary(store: DatasetStore = Depends(get_store)):
    return item(evaluation.summary(store), store)
