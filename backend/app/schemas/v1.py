"""Versioned data contracts, v1 (docs/SPEC.md §6, docs/data-dictionary.md).

These models describe the files the pipeline and the contracts replay publish to
web/public/data. They are the single Python definition of that contract: the API validates
against them and the tests validate every published file (real and mock) against them.

Rules for v1:
- Fields listed here are required (or explicitly Optional). Producers may add fields
  (`extra="allow"`); consumers must ignore fields they do not know.
- Renaming or removing a field, or narrowing an enum, needs a v2 module, not an edit here.
"""
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

SCHEMA_VERSION = "1"

# ---- shared identifiers -------------------------------------------------------------------
RanchId = Annotated[str, Field(pattern=r"^R\d{4}$")]
ExternalId = Annotated[str, Field(pattern=r"^X\d{2,}$")]  # supplier outside the study window
SinkId = Annotated[str, Field(pattern=r"^(S:[A-Z]{3}_[A-Z0-9_]+|P:[A-Z]+)$")]
EntityId = Annotated[str, Field(pattern=r"^(R\d{4}|X\d{2,}|S:[A-Z]{3}_[A-Z0-9_]+|P:[A-Z]+)$")]
GtaId = Annotated[str, Field(pattern=r"^GTA-[A-Z]{2}-(\d{4}-\d{6}|ATTEMPT-\d{4})$")]
ShipmentId = Annotated[str, Field(pattern=r"^SHP-\d{4}$")]
Hash32 = Annotated[str, Field(pattern=r"^0x[0-9a-f]{64}$")]
Address = Annotated[str, Field(pattern=r"^0x[0-9a-fA-F]{40}$")]
IsoDate = Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}$")]
Pct = Annotated[float, Field(ge=0, le=100)]

RiskClass = Literal["clean", "watch", "high"]
TraceClass = Literal["clean", "watch", "high", "unknown"]
LinkClass = Literal["clean", "watch", "flagged", "unknown"]
# "medium" is the mock generator's spelling of "watch"; accepted in v1, not produced by the pipeline.
Severity = Literal["watch", "medium", "high"]
FlagCode = Literal[
    "POST2020_DEFORESTATION", "PROTECTED_AREA", "EMBARGOED", "INSUFFICIENT_HERD", "PHANTOM_BIRTHS",
    "OVER_CAPACITY", "PASS_THROUGH", "TAINTED_SUPPLY", "ANOMALY",
]
Purpose = Literal["breeding", "rearing", "fattening", "slaughter", "export"]
LedgerError = Literal["OriginEmbargoed", "InsufficientHerd"]


class Model(BaseModel):
    model_config = ConfigDict(extra="allow")


# ---- 6.1 meta.json ------------------------------------------------------------------------
class Source(Model):
    name: str
    url: str
    license: str
    real: bool


class Aoi(Model):
    name: str
    bbox: Annotated[list[float], Field(min_length=4, max_length=4)]


class Meta(Model):
    project: Literal["Rastro"]
    aoi: Aoi
    generated_at: str
    years: list[int]
    eudr_cutoff: IsoDate
    synthetic_notice: str
    sources: list[Source]


# ---- 6.2 ranches.geojson ------------------------------------------------------------------
class Flag(Model):
    code: FlagCode
    severity: Severity
    title: str
    text: str
    evidence: dict[str, Any] = {}


class Risk(Model):
    class_: RiskClass = Field(alias="class")
    score: Annotated[float, Field(ge=0, le=1)]
    flags: list[Flag]
    evidence_hash: Hash32 | None = None


class RanchProps(Model):
    id: RanchId
    onchain_id: Hash32
    role: Literal["breeder", "rearer", "fattener", "intermediary"]
    area_ha: float
    pasture_ha: float
    capacity_head: int
    head_now: int
    breeding_cows: int
    defor_post2008_ha: float
    defor_post2020_ha: float
    in_protected: bool
    protected_name: str | None
    embargoed: bool
    inflow_head: int
    outflow_head: int
    median_holding_days: int | None
    risk: Risk
    upstream_taint_pct: Pct
    status_quo_flagged: bool
    # Simulator ground truth; evaluation only, never an input to detection.
    truth: Literal["honest", "dirty_source", "launderer", "phantom_births", "over_capacity"] | None = None


class PolygonGeometry(Model):
    type: Literal["Polygon", "MultiPolygon"]
    coordinates: list[Any]


class RanchFeature(Model):
    type: Literal["Feature"]
    geometry: PolygonGeometry
    properties: RanchProps


class RanchCollection(Model):
    type: Literal["FeatureCollection"]
    features: list[RanchFeature]


# ---- 6.3 movements.json -------------------------------------------------------------------
class Movement(Model):
    gta: GtaId
    hash: Hash32
    from_: EntityId = Field(alias="from")
    to: EntityId
    head: Annotated[int, Field(gt=0)]
    date: IsoDate
    purpose: Purpose
    suspicious: bool
    rejected: LedgerError | None = None


# ---- 6.4 destinations.json ----------------------------------------------------------------
class Destination(Model):
    id: SinkId
    kind: Literal["slaughterhouse", "port"]
    name: str
    lat: float
    lon: float
    real: bool


# ---- 6.5 shipments.json -------------------------------------------------------------------
class TraceOrigin(Model):
    ranch: str  # RanchId, ExternalId or "other:<class>" for the folded tail
    head_equiv: float
    risk_class: TraceClass
    hops: int


class Trace(Model):
    clean_pct: Pct
    flagged_pct: Pct
    unknown_pct: Pct
    max_hops: int
    by_ranch: list[TraceOrigin]


class Certificate(Model):
    lot_id: Hash32
    verdict: Literal["clean", "flagged", "unknown"]
    evidence_hash: Hash32


class Shipment(Model):
    id: ShipmentId
    destination: SinkId
    market: Annotated[str, Field(pattern=r"^[A-Z]{2}$")]
    head: Annotated[int, Field(gt=0)]
    date: IsoDate
    gtas: list[GtaId]
    trace: Trace
    status_quo_verdict: Literal["pass", "fail"]
    rastro_verdict: Literal["pass", "review", "fail"]
    certificate: Certificate | None = None


# ---- 6.6 metrics.json ---------------------------------------------------------------------
class EvalSide(Model):
    precision: float
    recall: float
    tainted_head_caught_pct: Pct


class Evaluation(Model):
    status_quo: EvalSide
    rastro: EvalSide


class Metrics(Model):
    counts: dict[str, int]
    eval: Evaluation
    headline: dict[str, Any]
    real_data: dict[str, Any]


# ---- 6.8 onchain.json ---------------------------------------------------------------------
class OnchainRecord(Model):
    kind: str
    ref: str | None
    tx: str | None
    status: Literal["success", "reverted"]
    revert_reason: str | None = None


class Onchain(Model):
    network: str
    chainId: int
    address: Address
    records: list[OnchainRecord]
    abi_path: str


# ---- API envelopes ------------------------------------------------------------------------
DatasetSource = Literal["real", "mock"]


class Health(Model):
    status: Literal["ok", "degraded"]
    version: str
    api_version: str
    schema_version: str
    data_dir_found: bool
    datasets: dict[str, DatasetSource | None]


class Envelope(Model):
    """Every /api/v1 data response: which schema, and whether the payload is real or mock."""

    schema_: str = Field(alias="schema")
    source: DatasetSource
    data: Any


# Logical dataset -> model used to validate it (list models validate each item).
DATASET_MODELS: dict[str, tuple[type[BaseModel], bool]] = {
    "meta": (Meta, False),
    "metrics": (Metrics, False),
    "ranches": (RanchCollection, False),
    "movements": (Movement, True),
    "shipments": (Shipment, True),
    "destinations": (Destination, True),
    "onchain": (Onchain, False),
}
