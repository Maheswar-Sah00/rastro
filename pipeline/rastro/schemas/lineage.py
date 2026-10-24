"""Lineage trace, one per traced shipment, GTA or lot (rastro.lineage). Versioned separately."""
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

LINEAGE_SCHEMA_VERSION = "lineage-trace/1.0.0"
Pct = Annotated[float, Field(ge=0, le=100.0001)]
Head = Annotated[float, Field(ge=0)]
Category = Literal["post_cutoff_deforestation", "embargo", "protected_overlap", "suspicious_births_or_inventory",
                   "environmental_evidence_missing", "unknown_origin"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Source(Strict):
    origin_key: str                  # <ranch>#birth | <ranch>#opening | <id>#external | UNRESOLVED#<gta> | MISSING#<id>
    ranch_id: str | None
    origin_kind: Literal["birth", "opening", "external", "unresolved", "missing"]
    head_equiv: Head
    share_pct: Pct
    min_hops: int
    categories: list[Category]


class PathStep(Strict):
    gta_id: str
    lot_id: str
    date: str
    from_: str = Field(alias="from")
    to: str
    permit_head: Head
    attributed_head: Head


class Exposure(Strict):
    post_cutoff_deforestation: Pct
    embargo: Pct
    protected_overlap: Pct
    suspicious_births_or_inventory: Pct
    environmental_evidence_missing: Pct
    unknown_or_incomplete: Pct
    any_risk: Pct                    # union over source ranches: cattle counted once however many categories apply


class Attribution(Strict):
    record_inconsistency_pct: Pct    # 1. confirmed record-level inconsistency (ledger refusals, shortages, impossible births)
    environmental_overlap_pct: Pct   # 2. origins with post-cut-off clearing, embargo or protected-area overlap
    suspected_laundering_pct: Pct    # 3. risky origin reached the buyer through a supplier a direct-only check would clear
    unknown_provenance_pct: Pct      # 4. external, unresolved or missing origin
    review_required: bool            # 5. human review needed for the attribution itself
    review_reasons: list[str]


class Sensitivity(Strict):
    fifo_any_risk_pct: Pct
    pro_rata_any_risk_pct: Pct
    spread_pct: Pct


class LineageTrace(Strict):
    schema_version: Literal["lineage-trace/1.0.0"]
    target_kind: Literal["shipment", "gta", "lot"]
    shipment_id: str | None
    lot_ids: list[str]
    gta_ids: list[str]
    declared_head: Head
    traced_head: Head
    policy: Literal["fifo", "pro_rata"]
    coverage_pct: Pct
    sources: list[Source]
    intermediaries: list[str]
    direct_suppliers: list[str]
    max_hops: int
    exposure_pct: Exposure
    attribution: Attribution
    policy_sensitivity: Sensitivity
    trace_path: list[PathStep]
    unresolved: list[dict]
    evidence_refs: list[str]
    uncertainty_notes: list[str]
