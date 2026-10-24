"""Response and request models for /api/v1 (canonical dataset). Nested records reuse the pipeline's
own versioned schemas (rastro.schemas.*) so the API and the pipeline cannot drift apart."""
from typing import Any, Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app import pipeline_bridge  # noqa: F401
from rastro.schemas.canonical import GtaMovement, Ranch, Shipment
from rastro.schemas.geo import GeoEvidence
from rastro.schemas.lineage import LineageTrace
from rastro.schemas.risk import Decision, Finding

T = TypeVar("T")
Status = Literal["real", "synthetic", "derived", "unavailable"]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Provenance(Model):
    dataset_id: str | None
    dataset_version: str | None
    logical_digest: str | None
    generated_at: str | None
    schema_version: str | None
    data_status: dict[str, Status]
    freshness: dict[str, float | None]


class Page(Model):
    limit: int
    offset: int
    total: int


class Item(BaseModel, Generic[T]):
    meta: Provenance
    data: T


class Items(BaseModel, Generic[T]):
    meta: Provenance
    page: Page
    data: list[T]


# ---- ranches --------------------------------------------------------------------------------
class RanchSummary(Model):
    ranch_id: str
    display_name: str
    entity_type: str
    role: str
    total_area_hectares: float | None
    pasture_area_hectares: float | None
    estimated_cattle_capacity: int | None
    data_source: str
    environmental_evidence: Literal["available", "missing", "not_applicable"]
    post_cutoff_deforestation_ha: float | None = Field(description="null = not measured, never 'no clearing'")
    eudr_indicator: str | None
    risk_status: Literal["assessed", "not_assessed"]
    risk_class: str | None


class RanchRiskView(Model):
    ranch_id: str
    risk_status: Literal["assessed", "not_assessed"]
    risk_class: str | None
    anomaly_score: float | None
    anomaly_note: str = "IsolationForest score ranks unusualness among peers; it is not a probability of fraud"
    findings: list[Finding]


class EnvironmentalView(Model):
    status: Literal["available", "missing", "not_applicable"]
    evidence: GeoEvidence | None


class RanchDetail(Model):
    ranch: Ranch
    environmental: EnvironmentalView
    risk: RanchRiskView
    movements: dict[str, int]


# ---- movements ----------------------------------------------------------------------------------
class MovementView(Model):
    movement: GtaMovement
    ledger_status: Literal["accepted", "refused", "not_moved"]
    refusal_reason: str | None
    shipment_id: str | None


class GtaDetail(MovementView):
    lineage: LineageTrace | None = None


# ---- shipments ----------------------------------------------------------------------------------
class ShipmentSummary(Model):
    shipment_id: str
    kind: str
    destination_id: str
    shipment_date: str
    declared_head_count: int
    gta_count: int
    assessment_status: Literal["assessed", "not_assessed"]
    outcome: Literal["PASS", "REVIEW", "FLAGGED"] | None
    coverage_pct: float | None
    any_risk_pct: float | None


class ShipmentDetail(Model):
    shipment: Shipment
    assessment_status: Literal["assessed", "not_assessed"]
    decision: Decision | None
    lineage: LineageTrace | None


class ShipmentRisk(Model):
    shipment_id: str
    assessment_status: Literal["assessed", "not_assessed"]
    decision: Decision | None
    findings_by_category: dict[str, list[Finding]]


class EvidenceItem(Model):
    kind: Literal["decision", "finding"]
    id: str
    evidence_hash: str
    file: str
    file_present: bool
    hash_verified: bool | None


class ShipmentEvidence(Model):
    shipment_id: str
    items: list[EvidenceItem]
    lineage_evidence_refs: list[str]
    note: str = "hash_verified = SHA-256 of the stored canonical file equals the recorded evidence_hash"


class AssessRequest(Model):
    """Only controls *how* the canonical assessment is obtained. A client cannot submit a verdict:
    unknown fields such as `outcome` or `verdict` are rejected with 422."""
    recompute: bool = False


class Assessment(Model):
    shipment_id: str
    source: Literal["precomputed", "recomputed"]
    outcome: Literal["PASS", "REVIEW", "FLAGGED"]
    risk_categories: list[str]
    reasons: list[str]
    findings_by_category: dict[str, list[Finding]]
    evidence_refs: list[str]
    decision_evidence_hash: str
    coverage_pct: float
    exposure_pct: dict[str, float]
    policy_sensitivity: dict[str, float]
    uncertainty_notes: list[str]
    detector_versions: list[str]
    engine_version: str | None


# ---- certificates / chain -----------------------------------------------------------------------
class ChainInfoView(Model):
    mode: Literal["rpc", "local_records"]
    network: str | None
    chain_id: int | None
    address: str | None
    label: str
    verified_public: bool
    available: bool
    detail: str | None


class CertificateView(Model):
    certificate_id: str
    shipment_ref: str | None
    verdict: str | None
    evidence_hash: str | None
    status: Literal["none", "valid", "consumed", "revoked", "not_clean", "expired"] | str
    status_source: str
    chain: ChainInfoView
    onchain_record: dict[str, Any] | None = Field(description="CertificateRecord decoded from the ABI (live RPC only)")
    records: list[dict[str, Any]]


class CertificateBundle(Model):
    shipment_id: str
    eligible_for_clean_certificate: bool
    ineligibility_reason: str | None
    evidence_hash: str
    shipment_commitment: str
    lot_commitment: str
    policy_version: int
    bundle: dict[str, Any]


class CertificateEvent(Model):
    """One line of the issuance registry (rastro.certificates.issue). Chain fields are copied from
    mined receipts or simulated reverts; they are null when nothing was sent."""
    model_config = ConfigDict(extra="allow")
    event: Literal["issue", "issue_rejected", "issue_failed", "refused", "consume", "consume_refused", "replay_attempt"] | str
    logged_at: str
    shipment_id: str | None = None
    lot_id: str | None = None
    decision: str | None = None
    reason: str | None = None
    evidence_hash: str | None = None
    tx_hash: str | None = None
    block_number: int | None = None
    receipt_status: int | None = None
    status_after: str | None = None
    error: Any = None


class VerifyCheck(Model):
    check: str
    ok: bool | None = Field(description="true passed, false failed, null could not be checked")
    detail: str


class VerifyResult(Model):
    certificate_id: str
    evidence_file_present: bool
    evidence_hash_matches: bool | None
    onchain_hash_matches: bool | None
    status: str
    usable: bool
    chain: ChainInfoView
    notes: list[str]
    outcome: Literal["valid", "consumed", "revoked", "expired", "not_clean", "invalid", "unverifiable", "not_on_ledger"] | None = None
    reason: str | None = None
    checks: list[VerifyCheck] = []
    signer: str | None = None
    certificate: dict[str, Any] | None = None
    verified_at: str | None = None


class VerifyRequest(Model):
    """Optional: verify an independently supplied signed certificate (and its evidence bundle) instead
    of the copy this service stored. Nothing here can set the outcome."""
    model_config = {"extra": "forbid"}
    certificate: dict[str, Any] | None = None
    signature: str | None = Field(None, pattern=r"^0x[0-9a-fA-F]{130}$")
    domain: dict[str, Any] | None = None
    bundle: dict[str, Any] | None = None


class PreparedTx(Model):
    to: str | None
    data: str
    value: str
    signed: bool
    note: str


class ConsumeRequest(Model):
    """Give either the consuming shipment id (committed as sha256(salt | id), the replay's convention)
    or an explicit 32-byte commitment."""
    use: int = Field(ge=0, le=2, description="0 export shipment, 1 EUDR DDS, 2 retail claim")
    shipment_id: str | None = Field(None, pattern=r"^SHP-([DV]-)?\d{1,8}$")
    ref_hash: str | None = Field(None, pattern=r"^0x[0-9a-fA-F]{64}$")


# ---- misc ---------------------------------------------------------------------------------------
class EvaluationSummary(Model):
    status: Literal["available", "unavailable"]
    report: dict[str, Any] | None
    redteam: dict[str, Any] | None = Field(None, description="headline of the scenario run (reports/evaluation/summary.json)")
    note: str = "aggregated metrics against synthetic ground truth; ground-truth rows are never served"


class Ready(Model):
    ready: bool
    checks: dict[str, bool]
    missing: list[str]
    build: dict[str, Any] | None = Field(None, description="dataset id, seed, digest and engine versions in use")


# ---- investigation workspace ------------------------------------------------------------------------
class GraphNode(Model):
    id: str
    kind: Literal["ranch", "sink", "unknown_origin", "folded"]
    ranch_id: str | None
    roles: list[str]
    origin_kinds: list[str]
    head_fifo: float = Field(description="estimated head this node contributes as an origin (FIFO); 0 for pure intermediaries")
    head_pro_rata: float = Field(description="the same under the fully-mixed-herd alternative")
    share_pct: float
    categories: list[str]
    finding_ids: list[str]
    data_status: str


class GraphEdge(Model):
    gta_id: str | None
    kind: Literal["gta", "unattributed_inflow", "folded"]
    from_: str = Field(alias="from")
    to: str
    date: str | None
    permit_head: float
    attributed_head: float = Field(description="head on this permit attributable to the shipment")
    gta_count: int | None = None


class LineageGraph(Model):
    shipment_id: str
    declared_head: float
    destination: str
    policy: str
    view: dict[str, Any]
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    totals: dict[str, float]
    uncertainty: dict[str, Any]


class CategoryShare(Model):
    head: float
    pct: float
    sources: list[str]
    via_intermediaries: list[dict[str, Any]] | None = None
    note: str | None = None


class Breakdown(Model):
    shipment_id: str
    declared_head: float
    categories: dict[str, CategoryShare]
    unique_affected_head: float
    unique_affected_pct: float
    sum_of_category_pct: float
    note: str


class ClearingStep(Model):
    action: str
    why: str
    finding_id: str | None = None


class ShipmentRiskDetail(ShipmentRisk):
    breakdown: Breakdown
    clearing_steps: list[ClearingStep]
    review_status: dict[str, str]


class ReviewRequest(Model):
    status: Literal["under_review", "confirmed", "dismissed"]
    reason: str | None = Field(None, max_length=2000)
    reviewer: str = Field(min_length=2, max_length=80, pattern=r"^[A-Za-z0-9 ._@-]+$")

    @model_validator(mode="after")
    def _reason_for_resolution(self):
        if self.status in ("confirmed", "dismissed") and len((self.reason or "").strip()) < 10:
            raise ValueError("confirming or dismissing a finding needs a reason of at least 10 characters")
        return self


class ReviewEntry(Model):
    review_id: str
    finding_id: str
    status: str
    reason: str | None
    reviewer: str
    at: str
    request_id: str
    finding_evidence_hash: str | None
    finding_code: str
    finding_blocking: bool


class FindingView(Model):
    finding: Finding
    review_status: str
    reviews: list[ReviewEntry]
    decision_impact: list[dict[str, Any]]


class LineageReport(Model):
    shipment_id: str
    declared_head: float
    coverage_pct: float
    max_hops: int
    outcome: str | None
    exposure_pct: dict[str, float]
    attribution: dict[str, Any]
    breakdown: Breakdown
    sources: list[dict[str, Any]]
    path: list[dict[str, Any]]
    uncertainty_notes: list[str]
    provenance: Provenance
