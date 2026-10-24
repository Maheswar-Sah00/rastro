"""Canonical data model, v1 (docs/data-dictionary.md).

One row model per table. Tables are written as JSON Lines, sorted by primary key, and live in
four partitions with different rules:

- `inputs/`       what a state agency or buyer would hold; detectors may read it.
- `environment/`  environmental evidence layers, one dataset per source; detectors may read it.
- `derived/`      computed from inputs (inventory, ledger refusals); reproducible.
- `truth/`        simulator ground truth and physical lot lineage; evaluation only, never a
                  detector input.

Models forbid unknown fields: the canonical model is ours, so drift is a bug.
"""
from datetime import date
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

SCHEMA_VERSION = "1.0.0"

RanchId = Annotated[str, Field(pattern=r"^R\d{4}$")]
ExternalId = Annotated[str, Field(pattern=r"^X\d{2,}$")]
EntityId = Annotated[str, Field(pattern=r"^(R\d{4}|X\d{2,})$")]
DestinationId = Annotated[str, Field(pattern=r"^(S:[A-Z]{3}_[A-Z0-9_]+|P:[A-Z]+)$")]
NodeId = Annotated[str, Field(pattern=r"^(R\d{4}|X\d{2,}|S:[A-Z]{3}_[A-Z0-9_]+|P:[A-Z]+)$")]
GtaId = Annotated[str, Field(pattern=r"^GTA-[A-Z]{2}-(\d{4}-\d{6}|ATTEMPT-\d{4})$")]
LotId = Annotated[str, Field(pattern=r"^LOT-")]
ShipmentId = Annotated[str, Field(pattern=r"^SHP-[DV]-[0-9]+$")]
Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
NonNeg = Annotated[int, Field(ge=0)]
Pos = Annotated[int, Field(gt=0)]
DataStatus = Literal["real", "synthetic", "derived"]
Purpose = Literal["breeding", "rearing", "fattening", "slaughter", "export"]


class Row(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


# ---- inputs -------------------------------------------------------------------------------
class DataQuality(Row):
    geometry: Literal["synthetic_voronoi_on_real_layers", "synthetic_grid", "none"]
    attributes: Literal["measured_on_real_layers", "synthetic", "unknown"]
    notes: str | None = None


class Ranch(Row):
    ranch_id: EntityId
    entity_type: Literal["ranch", "external_supplier"]
    display_name: str
    municipality: str
    municipality_ibge: str | None
    geometry_ref: str | None            # "<file>#<ranch_id>" inside the dataset, None outside the window
    total_area_hectares: Annotated[float, Field(ge=0)] | None
    pasture_area_hectares: Annotated[float, Field(ge=0)] | None
    estimated_cattle_capacity: NonNeg | None
    breeding_cows_declared: NonNeg
    opening_head: NonNeg                # declared herd at registration
    role: Literal["breeder", "rearer", "fattener", "intermediary", "external"]
    owner_group_id: str                 # synthetic ownership groups only
    registered_on: date
    data_source: Literal["synthetic"]
    data_quality: DataQuality

    @model_validator(mode="after")
    def _pasture_within_area(self):
        if self.total_area_hectares is not None and self.pasture_area_hectares is not None:
            if self.pasture_area_hectares > self.total_area_hectares + 0.5:
                raise ValueError("pasture_area_hectares exceeds total_area_hectares")
        return self


class Destination(Row):
    destination_id: DestinationId
    destination_type: Literal["slaughterhouse", "export_port"]
    name: str
    inspection: str | None
    lat: Annotated[float, Field(ge=-90, le=90)]
    lon: Annotated[float, Field(ge=-180, le=180)]
    data_source: DataStatus
    licence: str | None


class BreedingCowEstimate(Row):
    point: NonNeg
    low: NonNeg
    high: NonNeg

    @model_validator(mode="after")
    def _ordered(self):
        if not self.low <= self.point <= self.high:
            raise ValueError("breeding-cow estimate must satisfy low <= point <= high")
        return self


class BirthDeclaration(Row):
    birth_event_id: Annotated[str, Field(pattern=r"^B-(R\d{4}|X\d{2,})-\d{5}$")]
    ranch_id: EntityId
    date: date
    year: int
    declared_head: Pos
    breeding_cow_estimate: BreedingCowEstimate
    max_calving_rate: Annotated[float, Field(gt=0, le=1)]
    maximum_plausible_births: NonNeg        # per year, point estimate x max calving rate (ledger bound)
    maximum_plausible_births_high: NonNeg   # per year, upper estimate x max calving rate
    cumulative_year_head: Pos               # this ranch's declared births this year, including this one
    validation_status: Literal["within_biology", "borderline", "exceeds_biology"]
    source: Literal["synthetic_declaration"]


class DeathDeclaration(Row):
    death_event_id: Annotated[str, Field(pattern=r"^D-R\d{4}-\d{5}$")]
    ranch_id: RanchId
    date: date
    declared_head: Pos
    source: Literal["synthetic_declaration"]


class GtaMovement(Row):
    gta_id: GtaId
    lot_id: LotId                         # declared lot = the consignment on this permit
    origin_id: EntityId
    origin_type: Literal["ranch", "external_supplier"]
    destination_id: NodeId
    destination_type: Literal["ranch", "slaughterhouse", "export_port"]
    issue_date: date
    movement_date: date
    head_count: Pos
    purpose: Purpose
    source_lot_ids: list[LotId] | None    # GTAs carry no lot ids; None, never []
    permit_status: Literal["issued", "attempted_while_embargoed"]
    provenance: str

    @model_validator(mode="after")
    def _dates(self):
        if self.issue_date > self.movement_date:
            raise ValueError("issue_date after movement_date")
        if self.origin_id == self.destination_id:
            raise ValueError("origin equals destination")
        if (self.origin_type == "external_supplier") != self.origin_id.startswith("X"):
            raise ValueError("origin_type does not match origin_id")
        return self


class LotShare(Row):
    lot_id: LotId
    head: Pos


class Shipment(Row):
    shipment_id: ShipmentId
    kind: Literal["delivery", "voyage"]
    destination_id: DestinationId
    shipment_date: date
    gta_ids: Annotated[list[GtaId], Field(min_length=1)]
    lot_allocations: Annotated[list[LotShare], Field(min_length=1)]
    declared_head_count: Pos
    lineage_coverage: Annotated[float, Field(ge=0, le=1)] | None   # set by the lineage engine
    certification_status: Literal["not_assessed", "certified_clean", "flagged", "unknown"]

    @model_validator(mode="after")
    def _head_adds_up(self):
        if sum(a.head for a in self.lot_allocations) != self.declared_head_count:
            raise ValueError("lot allocations do not add up to declared_head_count")
        return self


# ---- environment --------------------------------------------------------------------------
class EnvironmentalRecord(Row):
    record_id: str
    dataset: Literal["prodes_deforestation", "indigenous_territory", "conservation_unit"]
    dataset_version: str
    source: str
    source_record_id: str
    observation_period_start: date | None   # None = unknown (e.g. PRODES accumulated mask)
    observation_period_end: date | None
    relevant_date: date | None              # None = date not known
    geometry_ref: str
    geometry_sha256: Sha256
    attributes: dict[str, Any]
    data_status: DataStatus
    licence: str | None
    ingested_at: str


class Embargo(Row):
    embargo_id: Annotated[str, Field(pattern=r"^EMB-\d{4}$")]
    ranch_id: RanchId
    start_date: date
    end_date: date | None
    status: Literal["active", "lifted", "unverified"]
    reason: str
    source: str
    data_status: Literal["synthetic", "real"]
    ingested_at: str


# ---- derived ------------------------------------------------------------------------------
class HerdInventory(Row):
    ranch_id: RanchId
    period_start: date
    observation_date: date
    opening_head: NonNeg
    births: NonNeg
    arrivals: NonNeg
    departures: NonNeg          # to other ranches
    deaths: NonNeg
    other_removals: NonNeg      # documented removals to slaughterhouses and the export port
    closing_head: NonNeg
    refused_events: NonNeg      # declarations the ledger rules refused in this period
    inventory_confidence: Literal["high", "medium", "low"]

    @model_validator(mode="after")
    def _conservation(self):
        expect = self.opening_head + self.births + self.arrivals - self.departures - self.deaths - self.other_removals
        if self.closing_head != expect:
            raise ValueError(f"conservation broken: closing {self.closing_head} != {expect}")
        if self.period_start > self.observation_date:
            raise ValueError("period_start after observation_date")
        return self


class LedgerRefusal(Row):
    event_ref: str
    event_type: Literal["birth", "movement", "death"]
    ranch_id: EntityId
    date: date
    head: Pos
    reason: Literal["BirthsExceedBiology", "InsufficientHerd", "OriginEmbargoed"]
    declared_balance: int


# ---- truth --------------------------------------------------------------------------------
class RanchLabel(Row):
    ranch_id: EntityId
    label: Literal["honest", "dirty_source", "launderer", "phantom_births", "over_capacity", "unknown"]
    scenario: str | None
    reasons: list[str]
    case_tags: list[str]
    embargoed_from: date | None


class MovementLabel(Row):
    gta_id: GtaId
    scenario_tags: list[str]
    true_origin_mix: dict[str, int]       # birth-origin ranch -> head


class SmuggledTransfer(Row):
    transfer_id: Annotated[str, Field(pattern=r"^SMG-\d{5}$")]
    from_id: RanchId
    to_id: RanchId
    head: Pos
    date: date
    scenario: Literal["phantom_births"]
    laundered_as_birth_event_id: str | None
    laundered_as_gta_id: str | None = None


class MissingRecord(Row):
    gta_id: GtaId
    origin_id: EntityId
    destination_id: NodeId
    movement_date: date
    head_count: Pos
    scenario: Literal["records_missing"]


class Lot(Row):
    lot_id: LotId
    kind: Literal["initial", "birth", "cull", "transfer", "smuggled", "external"]
    location_id: NodeId
    created_date: date
    head: Pos
    birth_origin_id: EntityId
    parent_lot_id: LotId | None
    via_gta_id: GtaId | None
    remaining_head: NonNeg


class LotAllocation(Row):
    allocation_id: Annotated[str, Field(pattern=r"^AL-\d{6}$")]
    channel: Literal["gta", "smuggled", "death"]
    gta_id: GtaId | None
    from_lot_id: LotId
    to_lot_id: LotId | None              # None for deaths
    head: Pos
    date: date


class ShipmentTruth(Row):
    shipment_id: ShipmentId
    head: Pos
    tainted_head: NonNeg
    tainted_pct: Annotated[float, Field(ge=0, le=100)]
    origins: dict[str, int]


class Anomaly(Row):
    anomaly_id: Annotated[str, Field(pattern=r"^ANM-\d{5}$")]
    kind: Literal["BirthsExceedBiology", "InsufficientHerd", "OriginEmbargoed"]
    event_ref: str
    ranch_id: EntityId
    head: Pos
    scenario: str


# ---- detector output (written by the risk engine; defined here so every stage shares it) ---
class RiskFinding(Row):
    finding_id: str
    entity_type: Literal["ranch", "gta", "shipment", "lot"]
    entity_id: str
    risk_category: Literal[
        "POST2020_DEFORESTATION", "PROTECTED_AREA", "EMBARGOED", "INSUFFICIENT_HERD", "PHANTOM_BIRTHS",
        "OVER_CAPACITY", "PASS_THROUGH", "TAINTED_SUPPLY", "ANOMALY",
    ]
    severity: Literal["info", "watch", "high"]
    confidence: Annotated[float, Field(ge=0, le=1)]
    evidence_refs: list[str]
    detector_version: str
    observed_at: str
    review_status: Literal["pending", "confirmed", "dismissed"]


# Table registry: name -> (partition, model, primary key)
TABLES: dict[str, tuple[str, type[Row], str | None]] = {
    "ranches": ("inputs", Ranch, "ranch_id"),
    "destinations": ("inputs", Destination, "destination_id"),
    "birth_declarations": ("inputs", BirthDeclaration, "birth_event_id"),
    "death_declarations": ("inputs", DeathDeclaration, "death_event_id"),
    "gta_movements": ("inputs", GtaMovement, "gta_id"),
    "shipments": ("inputs", Shipment, "shipment_id"),
    "prodes_deforestation": ("environment", EnvironmentalRecord, "record_id"),
    "indigenous_territories": ("environment", EnvironmentalRecord, "record_id"),
    "conservation_units": ("environment", EnvironmentalRecord, "record_id"),
    "embargoes": ("environment", Embargo, "embargo_id"),
    "herd_inventory": ("derived", HerdInventory, None),
    "ledger_refusals": ("derived", LedgerRefusal, None),
    "ranch_labels": ("truth", RanchLabel, "ranch_id"),
    "movement_labels": ("truth", MovementLabel, "gta_id"),
    "smuggled_transfers": ("truth", SmuggledTransfer, "transfer_id"),
    "lots": ("truth", Lot, "lot_id"),
    "lot_allocations": ("truth", LotAllocation, "allocation_id"),
    "shipment_truth": ("truth", ShipmentTruth, "shipment_id"),
    "anomalies": ("truth", Anomaly, "anomaly_id"),
    "missing_records": ("truth", MissingRecord, "gta_id"),
}
